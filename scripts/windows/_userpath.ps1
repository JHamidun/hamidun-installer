# _userpath.ps1 — PATH пользователя (HKCU\Environment): дописать каталог так, чтобы его
# увидели НОВЫЕ окна терминала, и не испортить то, что там уже лежит.
# Дот-сорсится компонентными скриптами (claude.ps1, nomad.ps1, node.ps1, pydeps.ps1, verify.ps1,
# config.ps1, handy.ps1) и соседними библиотеками (_cfgmigrate.ps1, _claudeenv.ps1). Библиотека:
# кода верхнего уровня и своего exit нет.
#
# Заодно здесь живут общие помощники «писать под администратором в профиль пользователя и не пойти
# за ссылкой»: Test-HmIsReparse, Get-HmLinkOnChain, Write-HmFileSafe (и ConvertTo-HmBomLineBytes к ним).
# Они в одном месте, потому что копии расходятся молча: прежняя запись checks.json отставала от
# Write-HmFileSafe на целый класс подмен (см. _claudeenv.ps1).
#
# ЗАЧЕМ ОДИН ПОМОЩНИК. Обещание «команда появится в PATH» жило в трёх местах по-разному:
# claude.ps1 дописывал ~/.local\bin, только если каталог УЖЕ существует (а его создают
# позже — шаг Nomad или нативный установщик claude), nomad.ps1 печатал «nmd появится в
# PATH» и PATH не трогал вовсе, и никто не рассылал WM_SETTINGCHANGE. У живых людей это
# выглядело так: «Имя "nmd" не распознано» в новом окне спустя дни после установки.
#
# Как пишем (тот же приём, что Add-HmMachinePath в node.ps1 и блок PATH в uv.ps1):
#   • читаем СЫРОЕ значение (DoNotExpandEnvironmentNames) и пишем ExpandString: записи
#     вида %USERPROFILE%\bin остаются переменными, тип REG_EXPAND_SZ сохраняется.
#     [Environment]::Get/SetEnvironmentVariable развернул бы их в литералы и записал REG_SZ;
#   • дубль ищем по РАЗВЁРНУТОЙ копии без учёта регистра и хвостового «\»;
#   • после записи рассылаем WM_SETTINGCHANGE: прямая запись в реестр никого не уведомляет,
#     и уже открытый Проводник запускал бы новые окна терминала со старым PATH;
#   • PATH ТЕКУЩЕГО процесса НЕ трогаем: скрипты идут под администратором, и каталог из
#     профиля пользователя в их PATH — ровно та дыра, которую закрывает Update-Path (#4).

# Файл или каталог — ссылка (symlink/junction)? Писать под администратором «сквозь» ссылку
# нельзя: процесс обычного пользователя подменил бы каталог профиля ссылкой на системный.
# Нет такого пути — не ссылка ($false): создавать его будем сами, и проверка повторится
# непосредственно перед записью.
function Test-HmIsReparse([string]$Path) {
    try { return [bool]((Get-Item -LiteralPath $Path -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) }
    catch { return $false }
}

# Первое звено пути от $Root вниз, которое является ссылкой (junction/symlink), либо $null, если на
# цепочке ссылок нет. Сам $Root не проверяется: это опора, которой доверяем (профиль пользователя —
# в нём лежит загруженный куст реестра, и подменить его процессу обычного пользователя нечем).
# Зачем вся цепочка, а не только конечная папка: ссылку может подложить любой процесс обычного
# пользователя на ЛЮБОМ звене между профилем и целью (mklink /J не требует прав), а robocopy,
# Copy-Item и Set-Content идут сквозь ссылку, стоящую в корне пути. Флаг robocopy /XJ пропускает
# ссылки только ВНУТРИ копируемого дерева — корневой аргумент он открывает как есть.
# Несуществующее звено — не ссылка: создавать его будем сами, а проверка повторится перед записью.
# Путь лежит не под $Root — проверить нечего, возвращается сам путь (безопаснее отказать, чем поверить).
# Атрибуты звена не прочитались (нет прав, слишком длинный путь) — исключение: вызывающий отказывает.
function Get-HmLinkOnChain {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        if ([string]::Equals($full, $base, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        return $full
    }
    $cur = $base
    foreach ($part in $full.Substring($base.Length + 1).Split('\')) {
        $cur = $cur + '\' + $part
        $attr = $null
        try { $attr = [IO.File]::GetAttributes($cur) }
        catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return $null }
        if ($attr -band [IO.FileAttributes]::ReparsePoint) { return $cur }
    }
    return $null
}

# Записать файл так, чтобы не писать «сквозь» ссылку и не оставить половину: новый временный
# файл рядом (CreateNew — падает на любом занятом имени, в том числе на ссылке), затем перенос
# поверх целевого (подменённый symlink на целевом имени заменяется, а не пишется насквозь).
# Каталог и целевой файл проверяются на ссылку и ПЕРЕД созданием временного файла, и ПЕРЕД
# переносом: между проверкой и записью процесс обычного пользователя мог подменить каталог
# ссылкой на системный. Бросает исключение с причиной — вызывающий печатает её человеку.
# -ClearReadOnly — только для НАШИХ файлов (checks.json): File.Replace отказывает на целевом файле с атрибутом
# «только чтение» (антивирус, синхронизация), а прежний Move-Item -Force его перебивал — без переключателя вердикт
# на таком файле не записывался бы никогда. Файлы человека (settings.json, CLAUDE.md) переключатель не получают:
# «только чтение» там — его выбор.
function Write-HmFileSafe {
    # AllowEmptyCollection: пустой файл (0 байт) — законное содержимое (например, пустой файл стартового проекта);
    # без атрибута PowerShell отказывает привязать пустой массив к обязательному параметру.
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes,
          [switch]$ClearReadOnly)
    $dir = Split-Path -Parent $Path
    if ((Test-HmIsReparse $dir) -or (Test-HmIsReparse $Path)) { throw "каталог или файл — ссылка (symlink/junction): $Path" }
    $tmp = $Path + '.hamidun-tmp-' + [guid]::NewGuid().ToString('N')
    $fs = $null
    $created = $false
    try {
        $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $created = $true
        $fs.Write($Bytes, 0, $Bytes.Length)
        $fs.Dispose(); $fs = $null
        # File.Replace сохраняет права и владельца заменяемого файла; Move-Item не годится: его
        # -Destination понимает маски, а в имени профиля бывают «[» и «]». Третий аргумент — имя копии,
        # её не нужно: настоящий null для строки в PowerShell — [NullString]::Value (голый $null
        # превращается в пустую строку, и Replace падает с «путь не в допустимой форме»).
        # Только что прочитанный или записанный файл на мгновенье могут держать антивирус, индексатор
        # поиска или редактор — тогда Replace падает с «Unable to remove the file to be replaced». Это
        # проходит само, поэтому до восьми попыток с растущей паузой (всего около 4 секунд), а не сразу
        # отказ. Ссылку проверяем перед КАЖДОЙ попыткой: пауза — это окно для подмены каталога.
        $placed = $false
        for ($try = 1; -not $placed; $try++) {
            if ((Test-HmIsReparse $dir) -or (Test-HmIsReparse $Path)) { throw "каталог или файл стал ссылкой (symlink/junction) во время записи: $Path" }
            if ($ClearReadOnly) {
                # После проверки ссылки: SetAttributes на ссылке правит саму ссылку, а не цель. Сбой снятия — не повод
                # отказывать заранее: Replace сам скажет, что не вышло.
                try {
                    $attr = [IO.File]::GetAttributes($Path)
                    if ($attr -band [IO.FileAttributes]::ReadOnly) { [IO.File]::SetAttributes($Path, ($attr -bxor [IO.FileAttributes]::ReadOnly)) }
                } catch { }
            }
            try {
                if (Test-Path -LiteralPath $Path -PathType Leaf) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) }
                else { [IO.File]::Move($tmp, $Path) }
                $placed = $true
            } catch [System.IO.IOException] {
                if ($try -ge 8) { throw }
                Start-Sleep -Milliseconds (150 * $try)
            }
        }
        $created = $false
    } finally {
        if ($fs) { $fs.Dispose() }
        if ($created) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

# Байты, которые в Windows PowerShell 5.1 писал `Set-Content -Encoding UTF8`: UTF-8 с BOM и
# переводом строки в конце. Нужны тем, кто перешёл на Write-HmFileSafe и обязан оставить файл
# побайтно прежним (checks.json читает и PowerShell, и main.js).
function ConvertTo-HmBomLineBytes([string]$Text) {
    return ,[byte[]](@(0xEF, 0xBB, 0xBF) + [System.Text.Encoding]::UTF8.GetBytes($Text + "`r`n"))
}

# Чистая функция, без реестра: новое СЫРОЕ значение PATH с каталогом $Dir или $null, если
# менять нечего. Без -Prepend каталог дописывается в конец, если его там нет. С -Prepend
# (как галочка «Add python.exe to PATH» установщика Python) он должен стоять ПЕРВЫМ: если он
# уже где-то в списке, но не первый — переносится в начало. Иначе Python, записанный в PATH
# после заглушки Магазина (WindowsApps), так и оставался бы за ней, и `python` вёл бы в Магазин.
# Остальные записи сохраняются как есть, включая %VAR% — переставляются только целые куски
# между «;». Если в значении есть кавычки (возможна запись с «;» внутри), порядок не трогаем.
function Get-HmPathWithDir {
    param([string]$Raw, [Parameter(Mandatory = $true)][string]$Dir, [switch]$Prepend)
    $d = $Dir.Trim()
    $want = $d.TrimEnd('\')
    if (-not $want) { return $null }
    $cur = [string]$Raw
    $present = $false
    foreach ($e in ([Environment]::ExpandEnvironmentVariables($cur) -split ';')) {
        if ($e -and ($e.Trim().Trim('"').TrimEnd('\') -ieq $want)) { $present = $true; break }
    }
    if (-not $present) {
        if (-not $cur.Trim().Trim(';')) { return $d }
        if ($Prepend) { return $d + ';' + $cur.TrimStart(';') }
        return $cur.TrimEnd(';') + ';' + $d
    }
    # Каталог уже в PATH. Без -Prepend этого достаточно.
    if (-not $Prepend) { return $null }
    $raws = @($cur -split ';')
    # Кавычка с «;» внутри (запись вида "C:\a;b") развалилась бы при делении по «;» —
    # тогда порядок не трогаем. Нечётное число кавычек в куске = кавычка осталась открытой.
    foreach ($r in $raws) {
        if ((($r.ToCharArray() | Where-Object { $_ -eq [char]'"' }) | Measure-Object).Count % 2 -ne 0) { return $null }
    }
    $hits = New-Object System.Collections.Generic.List[int]
    $firstNonEmpty = -1
    for ($i = 0; $i -lt $raws.Count; $i++) {
        if ($firstNonEmpty -lt 0 -and $raws[$i].Trim()) { $firstNonEmpty = $i }
        $x = [Environment]::ExpandEnvironmentVariables($raws[$i])
        if ($x -and ($x.Trim().Trim('"').TrimEnd('\') -ieq $want)) { $hits.Add($i) }
    }
    # Нашёлся только через переменную, которая сама раскрывается в список с «;»: переставить
    # такую запись, не развалив её, нельзя.
    if ($hits.Count -eq 0) { return $null }
    if ($hits[0] -eq $firstNonEmpty) {
        # Уже первый. Лишние повторы дальше по списку не мешают — не трогаем.
        return $null
    }
    $rest = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $raws.Count; $i++) {
        if ($hits.Contains($i) -or -not $raws[$i].Trim()) { continue }
        $rest.Add($raws[$i])
    }
    $head = $raws[$hits[0]].Trim()
    if ($rest.Count -eq 0) { return $head }
    return $head + ';' + ($rest -join ';')
}

# WM_SETTINGCHANGE «Environment» всем окнам верхнего уровня. $false — не удалось (новые
# процессы всё равно прочитают реестр сами, просто Проводник узнает позже).
#
# БЕЗ Add-Type. Раньше здесь компилировался C# (P/Invoke SendMessageTimeout), а Add-Type зовёт
# csc.exe: тот кладёт исходник, .cmdline и dll в %TEMP% и затем ГРУЗИТ сборку оттуда. Процесс обычного
# пользователя с наблюдателем за каталогом (ReadDirectoryChangesW) успевает переписать исходник за
# те сотни миллисекунд, пока стартует csc, — и его код выполняется у нас под администратором.
# Поэтому в скриптах под администратором код не компилируется вовсе (сторож — тест «u3-A»).
# Вызов SendMessageTimeoutW описан в ПАМЯТИ (Reflection.Emit): ни csc, ни файлов, ни записи в реестр. Флаги прежние:
# SMTO_ABORTIFHUNG и 5 секунд на окно — окно, которое «не отвечает», пропускается сразу. Запасной путь —
# Environment.SetEnvironmentVariable для области User: .NET сам шлёт WM_SETTINGCHANGE «Environment» (удаляем
# переменную, которой нет, реестр остаётся как был), но с флагом 0 и секундой на КАЖДОЕ неотвечающее окно —
# на машине с зависшими окнами это секунды ожидания на каждую запись PATH, поэтому только запасной.
# Описание API здесь, а не в Get-HmNativeApi (_deelev.ps1): библиотеку подключают и скрипты, где _deelev.ps1 нет.
function Get-HmBroadcastApi {
    if ($script:HmBroadcastApi) { return $script:HmBroadcastApi }
    $asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName('HmEnvBroadcast')), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $mod = $asm.DefineDynamicModule('HmEnvBroadcast')
    $tb  = $mod.DefineType('HmEnvBroadcast.Native', [System.Reflection.TypeAttributes]'Public, Class, Abstract, Sealed')
    $pt  = [Type[]]@([IntPtr], [UInt32], [UIntPtr], [string], [UInt32], [UInt32], [UIntPtr].MakeByRefType())
    $mb  = $tb.DefineMethod('SendMessageTimeoutW', [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [IntPtr], $pt)
    [void]$mb.DefineParameter(7, [System.Reflection.ParameterAttributes]::Out, $null)
    $dia = [System.Runtime.InteropServices.DllImportAttribute]
    $mb.SetCustomAttribute((New-Object System.Reflection.Emit.CustomAttributeBuilder(
        $dia.GetConstructor([Type[]]@([string])), [object[]]@('user32.dll'),
        [System.Reflection.FieldInfo[]]@($dia.GetField('SetLastError'), $dia.GetField('CharSet'), $dia.GetField('ExactSpelling')),
        [object[]]@($true, [System.Runtime.InteropServices.CharSet]::Unicode, $true))))
    $script:HmBroadcastApi = $tb.CreateType()
    return $script:HmBroadcastApi
}

function Send-HmEnvBroadcast {
    try {
        $api = Get-HmBroadcastApi
        $res = [UIntPtr]::Zero
        # HWND_BROADCAST = 0xFFFF, WM_SETTINGCHANGE = 0x1A, SMTO_ABORTIFHUNG = 0x2, 5000 мс; результат, как и раньше, не читаем
        [void]$api::SendMessageTimeoutW([IntPtr]0xFFFF, [UInt32]0x1A, [UIntPtr]::Zero, 'Environment', [UInt32]2, [UInt32]5000, [ref]$res)
        return $true
    } catch {
        try { [Environment]::SetEnvironmentVariable('HM_PATH_TOUCH', $null, 'User'); return $true } catch { return $false }
    }
}

# Дописать каталог в PATH пользователя. $true — запись сделана (и разослано уведомление);
# $false — менять нечего, каталога нет на диске (без -AllowMissing) или запись не удалась
# (причина напечатана). -AllowMissing: каталога ещё нет, но он точно появится —
# ~/.local\bin создают позже uv или нативный установщик claude; несуществующий каталог в
# PATH Windows просто пропускает. -Prepend: каталог должен быть ПЕРВЫМ (см. Get-HmPathWithDir).
# -RegistrySubKey — только для тестов: песочный ключ вместо настоящего HKCU\Environment.
function Add-HmUserPath {
    param([Parameter(Mandatory = $true)][string]$Dir, [switch]$AllowMissing, [switch]$Prepend,
          [string]$RegistrySubKey = 'Environment')
    if (-not $Dir.Trim()) { return $false }
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $Dir)) { return $false }
    $wrote = $false
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RegistrySubKey, $true)
        if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RegistrySubKey) }
        try {
            $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $new = Get-HmPathWithDir -Raw $raw -Dir $Dir -Prepend:$Prepend
            if ($null -ne $new) {
                $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
                $wrote = $true
            }
        } finally { $key.Close() }
    } catch {
        Write-Host "  Не удалось дописать $Dir в PATH пользователя ($($_.Exception.Message))."
        Write-Host "  Добавь вручную: Параметры → Система → О системе → Дополнительные параметры системы → Переменные среды."
        return $false
    }
    if ($wrote) {
        $when = if (Send-HmEnvBroadcast) { 'новые окна терминала увидят его сразу' } else { 'новые окна увидят его после перезахода в Windows' }
        Write-Host "  В PATH пользователя добавлено: $Dir ($when)"
    }
    return $wrote
}

# PATH, который увидит НОВЫЙ терминал человека: машинный + пользовательский, развёрнутые.
# Только для ПОИСКА («что найдёт человек, набрав команду»), не для запуска отсюда.
function Get-HmFreshShellPath {
    $m = ''; $u = ''
    try { $m = [string][Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment').GetValue('Path', '') } catch { }
    try { $u = [string][Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '') } catch { }
    return ($m.TrimEnd(';') + ';' + $u).Trim(';')
}

# Первый файл команды $Name по тексту PATH — в том порядке, в каком ищет cmd/CreateProcess:
# каталоги по очереди, внутри каталога — расширения PATHEXT по очереди. Путь собирается
# .NET-ом ВНУТРИ try: Join-Path на записи с несуществующим диском (в PATH полно «Z:\...» от
# отключённых сетевых дисков и снятых флешек) в Windows PowerShell 5.1 пишет в журнал
# красную ошибку DriveNotFound на каждую такую запись, а запись с запрещёнными в пути
# символами просто бросает исключение.
function Find-HmOnPath {
    param([Parameter(Mandatory = $true)][string]$Name, [string]$PathText,
          [string[]]$Extensions = @('.com', '.exe', '.bat', '.cmd'))
    foreach ($entry in ([string]$PathText -split ';')) {
        $dir = $entry.Trim().Trim('"')
        if (-not $dir) { continue }
        foreach ($ext in $Extensions) {
            try {
                $p = [IO.Path]::Combine($dir, $Name + $ext)
                if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
            } catch { }
        }
    }
    return $null
}

# --- python в новом терминале (A09) ------------------------------------------------------
# Скрипты зовут Python по абсолютному пути, а человек набирает `python` — и если каталога
# Python нет в PATH (Python стоял раньше без галочки «Add python.exe to PATH»), Windows
# отдаёт заглушку Магазина из WindowsApps: «Python was not found; run without arguments to
# install from the Microsoft Store…». На заглушку падают и навыки пака, и фоновые хуки.

# Что делать с командой python в НОВОМ терминале. $Hit — первый python по PATH человека
# (Find-HmOnPath), $StorePython — стоит ли Python из Магазина (тогда псевдоним в
# WindowsApps настоящий). 'fix' — команда ведёт в заглушку Магазина или никуда.
function Get-HmPythonPathPlan {
    param([string]$Hit, [bool]$StorePython)
    if (-not $Hit) { return 'fix' }
    if ($Hit -notmatch '\\Microsoft\\WindowsApps\\') { return 'ok' }
    if ($StorePython) { return 'ok' }
    return 'fix'
}

# Настоящий python.exe в привычных каталогах установки (InstallAllUsers=0 → LOCALAPPDATA,
# для всех пользователей → Program Files) — тот же список, что у доводки рантайма в
# config.ps1. Только ищем файл, ничего не запускаем.
function Find-HmKnownPython {
    $cands = @()
    if ($env:LOCALAPPDATA) {
        foreach ($v in '313', '312', '311') { $cands += [IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'Python', "Python$v", 'python.exe') }
    }
    if ($env:ProgramFiles) {
        foreach ($v in '313', '312') { $cands += [IO.Path]::Combine($env:ProgramFiles, "Python$v", 'python.exe') }
    }
    foreach ($p in $cands) {
        try { if (Test-Path -LiteralPath $p -PathType Leaf) { return $p } } catch { }
    }
    return $null
}

# Делаем ровно то, что сделала бы та галочка: каталог Python и его Scripts — В НАЧАЛО PATH
# пользователя. Только если `python` в новом терминале сейчас находит заглушку или ничего;
# настоящий python (свой, conda, из Магазина) не трогаем, псевдонимы приложений в
# Параметрах — никогда. $true — PATH менялся.
function Repair-HmPythonPath {
    param([string]$PyExe)
    if (-not $PyExe -or (Split-Path $PyExe -Leaf) -ine 'python.exe') { return $false }
    if (-not (Test-Path -LiteralPath $PyExe -PathType Leaf)) { return $false }
    $pyDir = Split-Path $PyExe
    $storePy = $false
    try {
        $storePy = [bool](Get-ChildItem -LiteralPath ([IO.Path]::Combine($env:LOCALAPPDATA, 'Microsoft', 'WindowsApps')) -Directory `
            -Filter 'PythonSoftwareFoundation.Python.*' -ErrorAction SilentlyContinue | Select-Object -First 1)
    } catch { }
    $hit = Find-HmOnPath -Name 'python' -PathText (Get-HmFreshShellPath)
    if ((Get-HmPythonPathPlan -Hit $hit -StorePython $storePy) -ne 'fix') { return $false }
    $what = if ($hit) { "заглушку Магазина ($hit)" } else { 'ничего' }
    Write-Host "Команда python в новом терминале нашла бы $what, а не установленный Python ($PyExe) — ставлю его в начало PATH пользователя."
    $changed = $false
    if (Add-HmUserPath $pyDir -Prepend) { $changed = $true }
    if (Add-HmUserPath ([IO.Path]::Combine($pyDir, 'Scripts')) -Prepend -AllowMissing) { $changed = $true }
    $after = Find-HmOnPath -Name 'python' -PathText (Get-HmFreshShellPath)
    if ((Get-HmPythonPathPlan -Hit $after -StorePython $storePy) -eq 'fix') {
        Write-Host "  ВНИМАНИЕ: python всё ещё ведёт в Магазин. Выключи заглушку сам: Параметры → Приложения → Дополнительные параметры приложений →"
        Write-Host "  Псевдонимы выполнения приложений → «Установщик приложения» для python.exe и python3.exe. До тех пор запускай Python командой py."
    }
    Write-Host "  А команда python3 на этой машине ведёт в Магазин (у python.org-сборки нет python3.exe) — набирай python."
    return $changed
}

# --- «Рабочий стол» и «меню Пуск» — из ПРОФИЛЯ, а не из реестра ---------------------------------
# Ярлыки и файлы на столе установщик создаёт из-под администратора. Адрес этих папок оболочка
# берёт из HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders, а эту ветку
# без UAC правит любая программа пользователя. Перенаправь она «Desktop» или «Programs» в
# каталог, куда пользователь писать не может, а администратор может (автозагрузка всех
# пользователей в ProgramData, профиль другой учётной записи), — и файл, созданный
# администратором, лёг бы туда: плацдарм вне прав того, кто подменил запись. Поэтому ответ
# оболочки принимается ТОЛЬКО если папка:
#   1. лежит строго ВНУТРИ профиля. Профиль берётся из списка профилей Windows
#      (GetFolderPath('UserProfile'), HKLM), а НЕ из $env:USERPROFILE: переменную окружения тоже
#      переписывают без UAC (и через неё же «ползёт» сам ответ оболочки, если в реестре стоит
#      %USERPROFILE%\Desktop);
#   2. существует и это каталог;
#   3. на пути от профиля до неё нет ссылок (junction, symlink). Облачные папки OneDrive («Перенос
#      известных папок», корень «OneDrive - Компания») тоже помечены как точка повторной обработки,
#      но это НЕ ссылки — они остаются на месте, — поэтому такие точки пропускаем по ТЕГУ
#      (IO_REPARSE_TAG_CLOUD*), а не по атрибуту: атрибут стоит и у junction.
# Не прошла — отказ и строка в журнале, файл не создаётся (не критично, как и раньше, когда его
# создать не получалось). Папка вне профиля (сетевая, другой диск) — тоже отказ.
#
# Почему не Get-Item.LinkType, как в vscode-settings.ps1: владелец junction может запретить чтение
# на САМОЙ ссылке (icacls /deny), и LinkType у неё пустеет, а атрибут и тег остаются видны —
# проверено на PS 5.1. Поэтому смотрим атрибут (File.GetAttributes) и тег из записи каталога.

# Ответ оболочки и корень профиля — отдельными функциями: проверку можно прогнать на подставных
# значениях, не трогая реестр (тесты переопределяют их после подключения файла).
function Get-HmShellAnswer([string]$Kind) {
    try { return [Environment]::GetFolderPath($Kind) } catch { return '' }
}
function Get-HmProfileRoot {
    try { return [Environment]::GetFolderPath('UserProfile') } catch { return '' }
}

# Системные вызовы для чтения тега и закрепления папки — БЕЗ компиляции. Add-Type зовёт csc.exe,
# который пишет сборку в %TEMP% и затем ГРУЗИТ её: программа того же пользователя успела бы подменить
# DLL между записью и загрузкой — код под админом. Сборка рождается в памяти (Reflection.Emit, Run):
# ни файла, ни компилятора. Создаётся при первой надобности: тег читается только у точки повторной
# обработки, а закрепление папки (Open-HmDirHandle) зовётся перед записью ярлыка.
function Get-HmFsNative {
    if ($script:HmFsNative) { return $script:HmFsNative }
    $an  = New-Object System.Reflection.AssemblyName('HmFsReparse')
    $asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly($an, [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $mod = $asm.DefineDynamicModule('HmFsReparse')
    $tb  = $mod.DefineType('HmFsReparse.Native', [System.Reflection.TypeAttributes]'Public, Class, Abstract, Sealed')
    $dia = [System.Runtime.InteropServices.DllImportAttribute]
    $ctor   = $dia.GetConstructor([Type[]]@([string]))
    $fields = [System.Reflection.FieldInfo[]]@($dia.GetField('SetLastError'), $dia.GetField('CharSet'), $dia.GetField('ExactSpelling'))
    $values = [object[]]@($true, [System.Runtime.InteropServices.CharSet]::Unicode, $true)
    $sigs = @(
        @('kernel32.dll', 'FindFirstFileW', [IntPtr], [Type[]]@([string], [IntPtr])),
        @('kernel32.dll', 'FindClose',      [bool],   [Type[]]@([IntPtr])),
        # Закрепление проверенной папки (Open-HmDirHandle): открыть каталог, прочитать настоящий путь, закрыть.
        @('kernel32.dll', 'CreateFileW',    [IntPtr], [Type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])),
        @('kernel32.dll', 'CloseHandle',    [bool],   [Type[]]@([IntPtr])),
        @('kernel32.dll', 'GetFinalPathNameByHandleW', [uint32], [Type[]]@([IntPtr], [IntPtr], [uint32], [uint32]))
    )
    foreach ($s in $sigs) {
        $pt = [Type[]]$s[3]
        $mb = $tb.DefineMethod($s[1], [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl', $s[2], $pt)
        $mb.SetCustomAttribute((New-Object System.Reflection.Emit.CustomAttributeBuilder($ctor, [object[]]@($s[0]), $fields, $values)))
    }
    $script:HmFsNative = $tb.CreateType()
    return $script:HmFsNative
}

# Тег точки повторной обработки пути: [long] >= 0, либо -1, если тега нет (не точка повторной
# обработки, путь не найден) или прочитать не вышло. Берётся из записи каталога (dwReserved0
# структуры WIN32_FIND_DATAW), которую FindFirstFileW отдаёт из СПИСКА РОДИТЕЛЯ: прав на саму
# ссылку не нужно, так что спрятать её запретом чтения нельзя. Буфер — сырые 592 байта
# структуры: атрибуты со смещения 0, тег со смещения 36.
function Get-HmReparseTag([string]$Path) {
    $buf = [IntPtr]::Zero
    try {
        $N = Get-HmFsNative
        $q = $Path
        if ($q.Length -ge 240 -and $q -match '^[A-Za-z]:\\') { $q = '\\?\' + $q }
        $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(592)
        $h = $N::FindFirstFileW($q, $buf)
        if ($h -eq [IntPtr](-1)) { return [long]-1 }
        $raw = New-Object byte[] 40
        try { [System.Runtime.InteropServices.Marshal]::Copy($buf, $raw, 0, 40) }
        finally { [void]$N::FindClose($h) }
        # 0x400 = FILE_ATTRIBUTE_REPARSE_POINT; без него dwReserved0 — мусор, а не тег.
        if (([BitConverter]::ToUInt32($raw, 0) -band 0x400) -eq 0) { return [long]-1 }
        return [long][BitConverter]::ToUInt32($raw, 36)
    } catch { return [long]-1 }
    finally { if ($buf -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf) } }
}

# Облачные заглушки OneDrive и его родни: IO_REPARSE_TAG_CLOUD = 0x9000001A плюс число 0..15 в
# битах 12–15 (на живой машине встретились 0x9000601A и 0x9000701A). Каталог остаётся на месте,
# из облака подгружается лишь его содержимое, — это не ссылка. Чистая функция.
function Test-HmCloudReparseTag([long]$Tag) {
    return [bool]($Tag -ge 0 -and (($Tag -band 0xFFFF0FFFL) -eq 0x9000001AL))
}

# Чистая проверка: годится ли $Candidate (ответ оболочки) как папка для записи под администратором
# при профиле $ProfileDir. Возвращает @{ Ok; Dir; Reason }: Dir — нормализованный путь без слэша
# на конце; Reason — по-русски, что именно не так. Файловую систему только ЧИТАЕТ. $Kind = 'Programs'
# (меню «Пуск») сужает выбор до обычного места профиля; для стола и без вида папки — любая папка профиля.
function Test-HmShellFolder {
    param([string]$ProfileDir, [string]$Candidate, [string]$Kind = '')
    if ([string]::IsNullOrWhiteSpace($ProfileDir)) { return @{ Ok = $false; Dir = ''; Reason = 'профиль пользователя не определён' } }
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return @{ Ok = $false; Dir = ''; Reason = 'оболочка не назвала папку' } }
    # Только локальные пути «диск:\…»: UNC, \\?\, относительные пути и «C:папка» сюда не годятся.
    $local = '^[A-Za-z]:[\\/]'
    if ($ProfileDir -notmatch $local -or $Candidate -notmatch $local) { return @{ Ok = $false; Dir = ''; Reason = 'путь не локальный (ждём диск:\папка)' } }
    # Джокеры, знаки, запрещённые в именах, управляющие знаки (в том числе C1 и разделители строк: в журнал
    # идёт одна строка) и «:» дальше буквы диска (потоки данных).
    $bad = '[<>"|?*\x00-\x1F\x7F-\x9F\u2028\u2029]'
    if ($ProfileDir -match $bad -or $Candidate -match $bad -or $ProfileDir.IndexOf(':', 2) -ge 0 -or $Candidate.IndexOf(':', 2) -ge 0) {
        return @{ Ok = $false; Dir = ''; Reason = 'в пути недопустимые знаки' }
    }
    try {
        $prof = [IO.Path]::GetFullPath($ProfileDir).TrimEnd('\')
        $cand = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    } catch { return @{ Ok = $false; Dir = ''; Reason = 'путь не разобрался' } }
    # Профиль — не корень диска: иначе «внутри профиля» значило бы «где угодно на диске».
    if ($prof -notmatch '^[A-Za-z]:\\[^\\]') { return @{ Ok = $false; Dir = ''; Reason = 'профиль пользователя — корень диска' } }
    # Строго внутри: хвостовой «\» в сравнении не даёт принять профиль-«двойника» (user2 при user).
    if (-not $cand.StartsWith($prof + '\', [StringComparison]::OrdinalIgnoreCase)) {
        return @{ Ok = $false; Dir = ''; Reason = "папка вне профиля пользователя ($cand вне $prof)" }
    }
    # Меню «Пуск» (Kind = Programs) в профиле лежит ровно в одном месте, и «Перенос известных папок»
    # OneDrive его не трогает. Любая другая папка внутри профиля — не настройка человека, а выбор того,
    # кто переписал реестр (пустой каталог, который он сам создал), так что выбирать здесь нечего.
    # Стол так не сузить: OneDrive и локализованные имена кладут его в разные места профиля.
    if ($Kind -eq 'Programs') {
        $std = $prof + '\AppData\Roaming\Microsoft\Windows\Start Menu\Programs'
        if (-not [string]::Equals($cand, $std, [StringComparison]::OrdinalIgnoreCase)) {
            return @{ Ok = $false; Dir = ''; Reason = "меню «Пуск» лежит не на обычном месте профиля ($cand вместо $std)" }
        }
    }
    # Сам профиль: существует и каталог. Ссылкой он быть может — профиль на другом диске через
    # junction задаёт администратор, а не пользователь.
    try {
        if (-not ([int][IO.File]::GetAttributes($prof) -band [int][IO.FileAttributes]::Directory)) {
            return @{ Ok = $false; Dir = ''; Reason = 'профиль пользователя — не папка' }
        }
    } catch { return @{ Ok = $false; Dir = ''; Reason = 'профиль пользователя недоступен для проверки' } }
    # Каждое звено от профиля вниз: существует, каталог, не ссылка. Ошибка чтения — отказ.
    $cur = $prof
    foreach ($seg in $cand.Substring($prof.Length + 1).Split('\')) {
        if (-not $seg) { continue }
        # Точки и пробелы на конце имени Windows отбрасывает ПРИ ПРОВЕРКЕ, но не в середине пути при
        # записи: «Desktop » и «Desktop» для проверки одна папка, а для записи две, и вторая может быть
        # junction, созданной через \\?\ (там пробел на конце имени допустим). Законная папка так не называется.
        # Не только они: File.GetAttributes и GetFullPath в .NET Framework срезают на конце пути ещё табы,
        # U+0085 и неразрывный пробел U+00A0 (проверено на PS 5.1 перебором всех знаков), а запись с таким
        # знаком в СЕРЕДИНЕ пути идёт к папке с этим именем — junction, для которой не нужен даже \\?\.
        # Табы и U+0085 отсекает фильтр знаков выше; здесь — точка и любой пробельный знак (в первую очередь U+00A0).
        $segEnd = $seg[$seg.Length - 1]
        if ($segEnd -eq [char]'.' -or [char]::IsWhiteSpace($segEnd)) { return @{ Ok = $false; Dir = ''; Reason = "имя папки кончается точкой или пробелом: $seg" } }
        $cur = $cur + '\' + $seg
        $attr = $null
        try { $attr = [IO.File]::GetAttributes($cur) }
        catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return @{ Ok = $false; Dir = ''; Reason = "папки нет на диске: $cur" } }
        catch { return @{ Ok = $false; Dir = ''; Reason = "путь недоступен для проверки: $cur" } }
        if (-not ([int]$attr -band [int][IO.FileAttributes]::Directory)) { return @{ Ok = $false; Dir = ''; Reason = "на месте папки лежит файл: $cur" } }
        if ([int]$attr -band [int][IO.FileAttributes]::ReparsePoint) {
            # Точка повторной обработки: облачная заглушка (OneDrive) — не ссылка, всё прочее
            # (junction, symlink, неизвестный и нечитаемый тег) — отказ.
            if (-not (Test-HmCloudReparseTag (Get-HmReparseTag $cur))) {
                return @{ Ok = $false; Dir = ''; Reason = "в пути есть ссылка (junction/symlink): $cur" }
            }
        }
    }
    return @{ Ok = $true; Dir = $cand; Reason = '' }
}

# Проверенная папка стола или меню «Пуск» — либо $null и ОДНА строка с причиной (в журнал шага;
# с -Log — в блок вызывающего, если тот собирает журнал сам). -ProfileDir и -Candidate — для
# проверки на подставных значениях; в работе берутся из системы.
function Get-HmSafeShellFolder {
    param([Parameter(Mandatory = $true)][ValidateSet('Desktop', 'Programs')][string]$Kind,
          [Alias('Profile')][string]$ProfileDir, [string]$Candidate, [scriptblock]$Log)
    if (-not $PSBoundParameters.ContainsKey('ProfileDir')) { $ProfileDir = Get-HmProfileRoot }
    if (-not $PSBoundParameters.ContainsKey('Candidate')) { $Candidate = Get-HmShellAnswer $Kind }
    $v = Test-HmShellFolder -ProfileDir $ProfileDir -Candidate $Candidate -Kind $Kind
    if ($v.Ok) { return [string]$v.Dir }
    $title = if ($Kind -eq 'Desktop') { 'Рабочий стол' } else { 'меню Пуск' }
    # Ответ оболочки — чужой текст из реестра: в журнал он идёт одной строкой, без переводов строк и
    # управляющих знаков (иначе значение с переводом строки подделало бы соседние строки журнала).
    $shown = ([string]$Candidate -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?')
    if ($shown.Length -gt 300) { $shown = $shown.Substring(0, 300) }
    $why = ([string]$v.Reason -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?')
    $line = "  Папка «$title» ($shown) не прошла проверку: $why — под администратором в неё не пишу, файл пропускаю."
    if ($Log) { & $Log $line } else { Write-Host $line }
    return $null
}

# --- ярлык (.lnk) в проверенную папку из-под администратора ------------------------------------
# Save() у WScript.Shell идёт ПО ПУТИ и пишет сквозь symlink и жёсткую ссылку (проверено на PS 5.1:
# текстовый файл-цель после Save() начинается с заголовка ShellLink). Имя ярлыка известно заранее,
# значит программа пользователя может заранее положить на него ссылку на чужой файл, и ярлык,
# сохранённый администратором, затёр бы этот файл. Поэтому ярлык сохраняется ПОД СЛУЧАЙНЫМ ИМЕНЕМ
# во временной папке и переносится одним Move: Move не перезаписывает занятое имя, а непосредственно
# перед каждой попыткой повторяется проверка папки (Test-HmShellFolder), и ту же папку держат
# открытый дескриптор и файл-страж внутри неё (Open-HmPinnedShellFolder, ниже): между проверкой и
# переносом её нельзя подменить. Тот же приём (временный файл + Move + перепроверка), что в New-HmMascotShortcut
# (_mascot.ps1; его тесты правят текст той функции, поэтому она осталась как есть).
# Занятое имя: без -Replace — отказ; с -Replace снимается только ИМЯ обычного файла
# ([IO.File]::Delete не трогает цель жёсткой ссылки), а папка или ссылка на этом месте — отказ.
# Свой Move — отдельной функцией, чтобы временную блокировку (антивирус держит свежий файл) и
# подмену имени или папки между проверкой и переносом можно было воспроизвести подменой этой функции.
# Сам перенос идёт в два шага ЧЕРЕЗ ИМЯ В ТОЙ ЖЕ папке: временный файл лежит в %TEMP%, а папка ярлыка
# может быть на другом томе (профиль или OneDrive на другом диске), и тогда File.Move переносит
# копированием, а оно проходит сквозь висячий symlink, успевший встать на имя ярлыка (нужен Developer
# Mode), и создаёт его цель под администратором — проверено. Поэтому сперва файл уходит под
# неугадываемым именем рядом с будущим ярлыком (там чужой ссылки быть не может), потом переименовывается
# внутри одного тома: переименование ссылку на занятом имени не разворачивает — отказ. Первый шаг —
# именно Move, а не Copy: CopyFile идёт по symlink-ИСТОЧНИКУ и читает его цель (проверено), а Move на
# одном томе переименовывает саму ссылку, между томами отказывает без права на ссылки. Занятое имя —
# наш отказ сразу; сбой на втором шаге (антивирус держит свежий файл) — три попытки внутри, потому что
# временного файла после первого шага уже нет. Копия при отказе убирается.
function Move-HmShortcutFile([string]$From, [string]$To) {
    $stage = [IO.Path]::Combine([IO.Path]::GetDirectoryName($To), '.hm-stage-' + [guid]::NewGuid().ToString('N'))
    [IO.File]::Move($From, $stage)
    $fail = $null
    for ($k = 1; $k -le 3; $k++) {
        try { [IO.File]::Move($stage, $To); return } catch { $fail = $_.Exception }
        $taken = $true
        try { [void][IO.File]::GetAttributes($To) } catch { $taken = $false }
        if ($taken) { break }
        if ($k -lt 3) { Start-Sleep -Milliseconds (100 * $k) }
    }
    try { [IO.File]::Delete($stage) } catch { }
    $why = [string]$fail.Message
    if ($fail.InnerException) { $why = [string]$fail.InnerException.Message }
    throw (New-Object System.InvalidOperationException("ярлык не лёг на место: $why"))
}

# --- закрепление проверенной папки на время записи ярлыка ---------------------------------------
# Проверка папки (Test-HmShellFolder) и перенос ярлыка (Move) — два разных момента, а между ними у
# программы того же пользователя есть миллисекунды. Проверенную за них папку подменяют двумя
# способами, и закрепление держит оба:
#
#  1. ПЕРЕИМЕНОВАТЬ папку (или любую из верхних) и поставить на её имя junction в каталог, куда
#     сама программа писать не может, — перенос ушёл бы по ссылке. Держит ДЕСКРИПТОР папки:
#       - открыт БЕЗ FILE_SHARE_DELETE: пока он жив, эту папку нельзя ни переименовать, ни удалить,
#         ни заменить, а любую верхнюю папку (до корня диска) нельзя переименовать, пока внутри неё
#         что-то открыто — проверено на PS 5.1: сама папка, родитель, профиль, корень дерева;
#       - право доступа — FILE_LIST_DIRECTORY (чтение каталога), а НЕ только атрибуты: открытие «за
#         атрибутами» (FILE_READ_ATTRIBUTES|SYNCHRONIZE) в проверках общего доступа не участвует и
#         ничего не держит — такая папка переименовывается свободно (измерено, и поэтому права
#         именно такие);
#       - общий доступ — чтение и запись: чужие дескрипторы на столе (проводник, антивирус, OneDrive)
#         нам не мешают, а мы им — только запретом удалить или переименовать эту папку на миллисекунды;
#       - между проверкой и открытием щель остаётся, поэтому сразу после открытия НАСТОЯЩИЙ путь
#         дескриптора (GetFinalPathNameByHandle) сверяется с проверенным: если папку успели подменить
#         на ссылку, дескриптор встал на чужой каталог, и путь не совпадёт — отказ. «Настоящий» путь
#         профиля берётся так же, по дескриптору: профиль сам может быть ссылкой (перенесён на другой диск).
#
#  2. ПРЕВРАТИТЬ ПУСТУЮ папку в junction «на месте» (FSCTL_SET_REPARSE_POINT), без переименования.
#     Открытие «за атрибутами» общий доступ обходит, и дескриптор папки этого не держит — проверено:
#     вызов проходит при любом общем доступе. Довод «у настоящего стола содержимое есть» тут не
#     работает: папку выбрал тот, кто переписал реестр, и это может быть пустой каталог, который он
#     сам создал внутри профиля, — проверку он проходит. NTFS отказывает (ERROR_DIR_NOT_EMPTY, 145)
#     только НЕПУСТОМУ каталогу, поэтому внутри закреплённой папки держится ФАЙЛ-СТРАЖ
#     (Open-HmPinSentinel): пока он открыт, папка не пуста и в ссылку «на месте» не превращается.
#
# Чего это НЕ закрывает: цель ярлыка пользовательская по замыслу; закрепить папку, на которой чужая
# программа держит дескриптор с правом удаления, нельзя — после трёх попыток отказ, ничего не записано
# (отказ, а не запись без закрепления). Перенос идёт ПО ПУТИ, а не относительно дескриптора, но путь
# к папке под парой «дескриптор + страж» не меняется: переименование, удаление и превращение в ссылку
# закрыты, у верхних папок тоже. Пока страж не создан, папку ещё можно превратить в ссылку — тогда он
# лёг бы в чужой каталог (скрытый, пустой, исчезает при закрытии): сверка его пути ловит это раньше Move.

# Открыть каталог. $Hold = $true — закрепление (чтение каталога, общий доступ без удаления); иначе —
# лишь прочитать атрибуты и путь (общий доступ полный: чужим дескрипторам не мешаем и сами
# не упираемся). Не открылся — IOException с кодом системы. Код читается ТОЛЬКО сразу после вызова:
# PowerShell между вызовами сам ходит в систему и портит последнюю ошибку.
function Open-HmDirHandle([string]$Path, [bool]$Hold) {
    $N = Get-HmFsNative
    $q = $Path
    if ($q.Length -ge 240 -and $q -match '^[A-Za-z]:\\') { $q = '\\?\' + $q }
    # 0x00100080 = SYNCHRONIZE | FILE_READ_ATTRIBUTES; 0x00100081 добавляет FILE_LIST_DIRECTORY.
    # Общий доступ: 7 = READ | WRITE | DELETE; 3 = READ | WRITE (без DELETE — это и есть закрепление).
    $access = [uint32]0x00100080
    $share = [uint32]7
    $what = 'открыть'
    if ($Hold) { $access = [uint32]0x00100081; $share = [uint32]3; $what = 'закрепить' }
    # 3 = OPEN_EXISTING; 0x02000000 = FILE_FLAG_BACKUP_SEMANTICS (без неё каталог не открывается).
    $h = $N::CreateFileW($q, $access, $share, [IntPtr]::Zero, [uint32]3, [uint32]0x02000000, [IntPtr]::Zero)
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($h -eq [IntPtr](-1) -or $h -eq [IntPtr]::Zero) {
        throw (New-Object System.IO.IOException("не удалось $what папку (код $code): $Path"))
    }
    return $h
}

# Закрыть дескриптор; нулевой (закрепления не было), недействительный и $null пропускает. Принимает и
# пару «папка + страж» из Open-HmPinnedShellFolder: первым закрывается страж (файл исчезает, пока папка
# ещё закреплена), потом папка. Ошибок не бросает: зовётся из finally, и сбой закрытия не должен
# затирать настоящую причину. Параметр без типа: типизированный [IntPtr] на $null в PS 5.1 бросает
# ошибку привязки — прямо из finally.
function Close-HmDirHandle($Handle) {
    if ($null -eq $Handle) { return }
    try {
        if ($null -ne $Handle.PSObject.Properties['Sentinel']) {
            Close-HmDirHandle $Handle.Sentinel
            Close-HmDirHandle $Handle.Dir
            return
        }
        $p = [IntPtr]$Handle
        if ($p -eq [IntPtr]::Zero -or $p -eq [IntPtr](-1)) { return }
        $N = Get-HmFsNative
        [void]$N::CloseHandle($p)
    } catch { }
}

# Настоящий путь, на который указывает дескриптор (все ссылки раскрыты), без префикса «\\?\»; ''
# — не прочитали или путь сетевой (нам годятся только локальные «диск:\…»).
function Get-HmHandlePath([IntPtr]$Handle) {
    $N = Get-HmFsNative
    $cap = 1024
    for ($k = 0; $k -lt 2; $k++) {
        $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(2 * ($cap + 1))
        try {
            # 0 = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS. Возврат — длина без нуля; не влезло — нужный размер.
            $n = [int]$N::GetFinalPathNameByHandleW($Handle, $buf, [uint32]$cap, [uint32]0)
            if ($n -eq 0) { return '' }
            if ($n -le $cap) {
                $s = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($buf, $n)
                if ($s.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { return '' }
                if ($s.StartsWith('\\?\')) { $s = $s.Substring(4) }
                return $s
            }
            $cap = $n
        } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
    }
    return ''
}

# Файл-страж в закреплённой папке — против превращения ПУСТОЙ папки в junction «на месте» (п. 2
# выше). Имя уникальное и неугадываемое; общий доступ 0: открыть файл на чтение, запись или удаление
# не может никто (открытие «только за атрибутами» общий доступ обходит, но удалить или переименовать
# через него нельзя — для этого нужно право DELETE): страж живёт, пока мы его не закроем.
# DELETE_ON_CLOSE: после закрытия (и после падения процесса) от него ничего не остаётся. Скрытый и
# временный: проводник его не показывает, кэш не сбрасывает его на диск. CREATE_NEW: занятое имя —
# отказ, а не запись сквозь чужую ссылку.
# Файл создаётся ПО ПУТИ, и пока его нет, папку ещё могли превратить в ссылку — тогда он лёг бы в
# ЧУЖОЙ каталог. Поэтому сразу после создания НАСТОЯЩИЙ путь файла по дескриптору сверяется с
# «настоящий путь папки + имя»: не совпал — файл закрывается (исчезает) и отказ. Возвращает
# дескриптор; закрывает вызывающий (Close-HmDirHandle). Не создался — IOException с кодом системы.
function Open-HmPinSentinel([string]$DirPath) {
    $N = Get-HmFsNative
    $name = '.hm-pin-' + [guid]::NewGuid().ToString('N')
    $want = ([string]$DirPath).TrimEnd('\') + '\' + $name
    $q = $want
    if ($q.Length -ge 240 -and $q -match '^[A-Za-z]:\\') { $q = '\\?\' + $q }
    # 0x00110080 = DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES (DELETE нужен для удаления при закрытии);
    # общий доступ 0; 1 = CREATE_NEW; 0x04000102 = FILE_FLAG_DELETE_ON_CLOSE | FILE_ATTRIBUTE_TEMPORARY | FILE_ATTRIBUTE_HIDDEN.
    $s = $N::CreateFileW($q, [uint32]0x00110080, [uint32]0, [IntPtr]::Zero, [uint32]1, [uint32]0x04000102, [IntPtr]::Zero)
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($s -eq [IntPtr](-1) -or $s -eq [IntPtr]::Zero) {
        throw (New-Object System.IO.IOException("не удалось закрепить папку: служебный файл в ней не создался (код $code): $DirPath"))
    }
    $same = $false
    try {
        $now = Get-HmHandlePath $s
        if ($now -and [string]::Equals($now, $want, [StringComparison]::OrdinalIgnoreCase)) { $same = $true }
        if (-not $same) {
            # Пути идут из системы, но всё равно одной строкой и без управляющих знаков (в журнал).
            $a = ([string]$now -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?')
            $b = ([string]$want -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?')
            if ($a.Length -gt 300) { $a = $a.Substring(0, 300) }
            if ($b.Length -gt 300) { $b = $b.Substring(0, 300) }
            throw (New-Object System.InvalidOperationException("путь служебного файла не совпал с проверенным (лёг в «$a», ждали «$b») — папку подменили на лету, ярлык не создаю"))
        }
    } finally {
        if (-not $same) { Close-HmDirHandle $s }
    }
    return $s
}

# Закрепить папку $Dir (путь, уже прошедший Test-HmShellFolder при профиле $ProfileDir): открыть,
# сверить настоящий путь дескриптора, положить внутрь файл-страж (Open-HmPinSentinel) и вернуть
# пару @{ Dir; Sentinel } — её закрывает вызывающий (Close-HmDirHandle, в finally). Не открылась
# (занята) — IOException, повторять можно; путь не совпал — InvalidOperationException: папку
# подменили, повторять нечего. Отказ всё открытое закрывает сам.
function Open-HmPinnedShellFolder {
    param([string]$ProfileDir, [string]$Dir)
    $prof = ''
    try { if ($ProfileDir -match '^[A-Za-z]:[\\/]') { $prof = [IO.Path]::GetFullPath($ProfileDir).TrimEnd('\') } } catch { }
    if (-not $prof -or -not ([string]$Dir).StartsWith($prof + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-Object System.InvalidOperationException('папка лежит не внутри профиля: закреплять нечего'))
    }
    $rel = ([string]$Dir).Substring($prof.Length + 1)
    $h = Open-HmDirHandle $Dir $true
    $s = [IntPtr]::Zero
    $ok = $false
    try {
        $got = Get-HmHandlePath $h
        # Профиль — отдельным коротким открытием «за атрибутами»: его настоящий путь нужен, только чтобы
        # отличить ссылку внутри профиля от профиля, лежащего за ссылкой.
        $profNow = ''
        $hp = Open-HmDirHandle $prof $false
        try { $profNow = Get-HmHandlePath $hp } finally { Close-HmDirHandle $hp }
        $want = ''
        if ($profNow) { $want = $profNow.TrimEnd('\') + '\' + $rel }
        if (-not ($got -and $want -and [string]::Equals($got.TrimEnd('\'), $want, [StringComparison]::OrdinalIgnoreCase))) {
            # Пути идут из системы, но всё равно одной строкой и без управляющих знаков (в журнал).
            $a = ([string]$got -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?')
            $b = ([string]$want -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?')
            if ($a.Length -gt 300) { $a = $a.Substring(0, 300) }
            if ($b.Length -gt 300) { $b = $b.Substring(0, 300) }
            throw (New-Object System.InvalidOperationException("папка оказалась не там, где её проверяли: путь не совпал (ведёт в «$a», ждали «$b») — папку подменили на лету, ярлык не создаю"))
        }
        # Страж — после сверки пути и в ТОЙ папке, на которую встал дескриптор: он делает её непустой.
        $s = Open-HmPinSentinel $got
        $ok = $true
    } finally {
        if (-not $ok) { Close-HmDirHandle $s; Close-HmDirHandle $h }
    }
    return [pscustomobject]@{ Dir = $h; Sentinel = $s }
}

# $Fill — блок с одним параметром (COM-ярлык): ставит TargetPath и прочее. Возвращает путь ярлыка
# или бросает исключение с причиной по-русски (InvalidOperationException — наша причина).
function New-HmShortcutFile {
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][string]$Name,
          [Parameter(Mandatory = $true)][scriptblock]$Fill, [string]$ProfileDir, [switch]$Replace)
    # Имя — просто имя файла: разделитель пути увёл бы ярлык из проверенной папки.
    if ($Name -match '[\\/:*?"<>|]') { throw (New-Object System.InvalidOperationException("в имени ярлыка недопустимые знаки: $Name")) }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('hm-lnk-' + [guid]::NewGuid().ToString('N') + '.lnk')
    try {
        $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($tmp)
        & $Fill $sc
        $sc.Save()
        # Три попытки: Defender или индексатор Search держат свежий файл, и один сбой Move означал бы,
        # что ярлыка нет. Повторяем только «файл занят»; наши отказы (InvalidOperation) выходят сразу.
        $err = $null
        for ($i = 1; $i -le 3; $i++) {
            $pin = [IntPtr]::Zero
            try {
                $vf = Test-HmShellFolder -ProfileDir $ProfileDir -Candidate $Dir
                if (-not $vf.Ok) { throw (New-Object System.InvalidOperationException("папка стала недопустимой: $($vf.Reason)")) }
                # Пишем ровно в ту папку, что проверена и закреплена: путь берём из проверки (нормализованный),
                # а не из строки вызывающего. «Desktop » с пробелом на конце проверка читает как «Desktop», а
                # запись — как другую папку (junction с таким именем создаётся через \\?\): дескриптор держал бы
                # не ту, куда ляжет файл.
                $lnk = Join-Path ([string]$vf.Dir) $Name
                # Папку берём под дескриптор сразу после проверки и держим до конца попытки вместе с
                # файлом-стражем внутри неё: и снятие старого имени, и Move идут в ней, а подменить её
                # нельзя ни переименованием (дескриптор), ни превращением в junction «на месте» (страж:
                # пустая папка превращается, непустая нет). Подменили ещё до открытия — путь дескриптора
                # (или стража) не совпадёт: отказ.
                $pin = Open-HmPinnedShellFolder -ProfileDir $ProfileDir -Dir ([string]$vf.Dir)
                $prev = $null
                try { $prev = [IO.File]::GetAttributes($lnk) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { }
                if ($null -ne $prev) {
                    if (-not $Replace) { throw (New-Object System.InvalidOperationException("имя ярлыка уже занято: $lnk")) }
                    # Облачная заглушка файла (стол в OneDrive, «освободить место») — тоже точка повторной
                    # обработки, но это обычный файл, и его имя снимается как любое другое.
                    $linkish = $false
                    if ([int]$prev -band [int][IO.FileAttributes]::ReparsePoint) { $linkish = -not (Test-HmCloudReparseTag (Get-HmReparseTag $lnk)) }
                    if (([int]$prev -band [int][IO.FileAttributes]::Directory) -or $linkish) {
                        throw (New-Object System.InvalidOperationException("на месте ярлыка лежит папка или ссылка: $lnk"))
                    }
                    [IO.File]::Delete($lnk)
                }
                Move-HmShortcutFile $tmp $lnk   # имя успели занять снова — исключение: сквозь чужое не пишем
                # Итог — по файловой системе, а не по отсутствию исключения.
                if (-not (Test-Path -LiteralPath $lnk -PathType Leaf)) { throw (New-Object System.InvalidOperationException("ярлык не появился: $lnk")) }
                return $lnk
            } catch [IO.IOException], [UnauthorizedAccessException] {
                $err = $_.Exception
                # Папку отпускаем до паузы: незачем держать её закреплённой, пока ждём.
                Close-HmDirHandle $pin
                $pin = [IntPtr]::Zero
                if ($i -lt 3) { Start-Sleep -Milliseconds (200 * $i) }
            } finally {
                Close-HmDirHandle $pin
            }
        }
        throw (New-Object System.InvalidOperationException('ярлык не лёг на место за 3 попытки: ' + $err.Message))
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}
