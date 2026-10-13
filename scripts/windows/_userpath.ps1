# _userpath.ps1 — PATH пользователя (HKCU\Environment): дописать каталог так, чтобы его
# увидели НОВЫЕ окна терминала, и не испортить то, что там уже лежит.
# Дот-сорсится компонентными скриптами (claude.ps1, nomad.ps1, pydeps.ps1, verify.ps1) и
# соседними библиотеками (_cfgmigrate.ps1, _claudeenv.ps1). Библиотека: кода верхнего
# уровня и своего exit нет.
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
function Send-HmEnvBroadcast {
    try {
        if (-not ('Hm.EnvBroadcast' -as [type])) {
            Add-Type -Namespace Hm -Name EnvBroadcast -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam,
    string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@ -ErrorAction Stop
        }
        $res = [UIntPtr]::Zero
        # HWND_BROADCAST=0xffff, WM_SETTINGCHANGE=0x1A, SMTO_ABORTIFHUNG=0x0002
        [void][Hm.EnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero,
            'Environment', 0x0002, 5000, [ref]$res)
        return $true
    } catch { return $false }
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
# на конце; Reason — по-русски, что именно не так. Файловую систему только ЧИТАЕТ.
function Test-HmShellFolder {
    param([string]$ProfileDir, [string]$Candidate)
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
    $v = Test-HmShellFolder -ProfileDir $ProfileDir -Candidate $Candidate
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
# перед каждой попыткой повторяется проверка папки (Test-HmShellFolder), и ту же папку держит
# открытый дескриптор (Open-HmPinnedShellFolder, ниже): между проверкой и переносом её нельзя
# подменить. Тот же приём (временный файл + Move + перепроверка), что в New-HmMascotShortcut
# (_mascot.ps1; его тесты правят текст той функции, поэтому она осталась как есть).
# Занятое имя: без -Replace — отказ; с -Replace снимается только ИМЯ обычного файла
# ([IO.File]::Delete не трогает цель жёсткой ссылки), а папка или ссылка на этом месте — отказ.
# Свой Move — отдельной функцией, чтобы временную блокировку (антивирус держит свежий файл) и
# подмену имени или папки между проверкой и переносом можно было воспроизвести подменой этой функции.
function Move-HmShortcutFile([string]$From, [string]$To) {
    [IO.File]::Move($From, $To)
}

# --- закрепление проверенной папки на время записи ярлыка ---------------------------------------
# Проверка папки (Test-HmShellFolder) и перенос ярлыка (Move) — два разных момента, а между ними у
# программы того же пользователя есть миллисекунды: переименовать проверенную папку (или любую из
# верхних) и поставить на её имя junction — перенос ушёл бы по ссылке в каталог, куда сама программа
# писать не может. Поэтому после проверки папку ОТКРЫВАЮТ и держат открытой до конца записи:
#   - дескриптор открыт БЕЗ FILE_SHARE_DELETE: пока он жив, эту папку нельзя ни переименовать, ни
#     удалить, ни заменить, а любую верхнюю папку (до корня диска) нельзя переименовать, пока
#     внутри неё что-то открыто — проверено на PS 5.1: сама папка, родитель, профиль, корень дерева;
#   - право доступа — FILE_LIST_DIRECTORY (чтение каталога), а НЕ только атрибуты: открытие «за
#     атрибутами» (FILE_READ_ATTRIBUTES|SYNCHRONIZE) в проверках общего доступа не участвует и ничего
#     не держит — такая папка переименовывается свободно (измерено, и поэтому права именно такие);
#   - общий доступ — чтение и запись: чужие дескрипторы на столе (проводник, антивирус, OneDrive)
#     нам не мешают, а мы им — только запретом удалить или переименовать эту папку на миллисекунды;
#   - между проверкой и открытием щель остаётся, поэтому сразу после открытия НАСТОЯЩИЙ путь
#     дескриптора (GetFinalPathNameByHandle) сверяется с проверенным: если папку успели подменить на
#     ссылку, дескриптор встал на чужой каталог, и путь не совпадёт — отказ. «Настоящий» путь профиля
#     берётся так же, по дескриптору: профиль сам может быть ссылкой (перенесён на другой диск).
# Чего это НЕ закрывает: пустую папку можно превратить в junction «на месте» (FSCTL_SET_REPARSE_POINT),
# без переименования, а открытие «за атрибутами» общий доступ обходит — проверено, что такой вызов
# проходит и при закреплении; с хотя бы одним файлом внутри папка в ссылку не превращается, а у стола
# и меню «Пуск» содержимое есть (desktop.ini, папки программ). Сам перенос идёт ПО ПУТИ, а не
# относительно дескриптора, и цель ярлыка пользовательская по замыслу.

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

# Закрыть дескриптор; нулевой (закрепления не было), недействительный и $null пропускает. Ошибок не
# бросает: зовётся из finally, и сбой закрытия не должен затирать настоящую причину. Параметр без
# типа: типизированный [IntPtr] на $null в PS 5.1 бросает ошибку привязки — прямо из finally.
function Close-HmDirHandle($Handle) {
    if ($null -eq $Handle) { return }
    try {
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

# Закрепить папку $Dir (путь, уже прошедший Test-HmShellFolder при профиле $ProfileDir): открыть,
# сверить настоящий путь дескриптора и вернуть дескриптор — его закрывает вызывающий
# (Close-HmDirHandle, в finally). Не открылась (занята) — IOException, повторять можно; путь не
# совпал — InvalidOperationException: папку подменили, повторять нечего. Отказ дескриптор закрывает сам.
function Open-HmPinnedShellFolder {
    param([string]$ProfileDir, [string]$Dir)
    $prof = ''
    try { if ($ProfileDir -match '^[A-Za-z]:[\\/]') { $prof = [IO.Path]::GetFullPath($ProfileDir).TrimEnd('\') } } catch { }
    if (-not $prof -or -not ([string]$Dir).StartsWith($prof + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-Object System.InvalidOperationException('папка лежит не внутри профиля: закреплять нечего'))
    }
    $rel = ([string]$Dir).Substring($prof.Length + 1)
    $h = Open-HmDirHandle $Dir $true
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
        if ($got -and $want -and [string]::Equals($got.TrimEnd('\'), $want, [StringComparison]::OrdinalIgnoreCase)) { $ok = $true }
        if (-not $ok) {
            # Пути идут из системы, но всё равно одной строкой и без управляющих знаков (в журнал).
            $a = ([string]$got -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?')
            $b = ([string]$want -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?')
            if ($a.Length -gt 300) { $a = $a.Substring(0, 300) }
            if ($b.Length -gt 300) { $b = $b.Substring(0, 300) }
            throw (New-Object System.InvalidOperationException("путь по дескриптору не совпал с проверенным (дескриптор на «$a», ждали «$b») — папку подменили, ярлык не пишу"))
        }
    } finally {
        if (-not $ok) { Close-HmDirHandle $h }
    }
    return $h
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
                # Папку берём под дескриптор сразу после проверки и держим до конца попытки: и снятие
                # старого имени, и Move идут в ней, а подменить её (переименовать, поставить на её имя
                # junction) нельзя. Подменили ещё до открытия — путь дескриптора не совпадёт: отказ.
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
