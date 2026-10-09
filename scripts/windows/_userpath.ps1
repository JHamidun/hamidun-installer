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
