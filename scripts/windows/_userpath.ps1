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
