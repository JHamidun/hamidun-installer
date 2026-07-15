# _deelev.ps1 — ЕДИНЫЙ укреплённый примитив ДЕ-ЭЛЕВАЦИИ (Windows).
# Дот-сорсится компонент-скриптами (vscode.ps1, extension.ps1), которые исполняются
# ELEVATED (установщик requireAdministrator). Прямой вызов user-writable editor-CLI
# (code.cmd / cursor.cmd / Code.exe / Cursor.exe) под АДМИНОМ выполнил бы то, что
# medium-integrity малварь ТОГО ЖЕ юзера могла заранее подложить на его место
# (integrity-escalation). Поэтому редакторный CLI исполняется ТОЛЬКО через этот
# примитив — де-элевированно (medium integrity), fail-closed.
#
# Укрепление (Codex regate P0 — 3-й круг, «гонки/hijack невозможны ПО КОНСТРУКЦИИ»):
#  1) НИКАКИХ control-файлов в общем user-writable %TEMP%. Раньше wrapper-ps1/xml/out/
#     .code/.int лежали в %TEMP%: medium-малварь ТОГО ЖЕ юзера создаёт файл ЗАРАНЕЕ
#     (сохраняя свой DACL), наш elevated Set-Content лишь перезаписывает СОДЕРЖИМОЕ, DACL
#     атакующего остаётся -> он меняет RunLevel LeastPrivilege->HighestAvailable и <Command>
#     на свой бинарь ДО /Create. ТЕПЕРЬ:
#       - Тело обёртки едет ЦЕЛИКОМ в -EncodedCommand (base64 UTF-16LE), собранном ELEVATED-
#         родителем с ВБИТЫМИ ЛИТЕРАЛАМИ (пути, integrity-SID, exe, аргументы). Base64 — в
#         аргументах schtasks/XML, не в отдельном файле -> подменять нечего.
#       - ЕДИНСТВЕННЫЙ транзиентный файл — task.xml — лежит в PRIVATE high-integrity каталоге
#         %ProgramData%\HmDeElev-<rnd>, рождённом с DACL «SYSTEM+Administrators: FullControl,
#         прочие: нет доступа» (New-HmSecureStagingDir). Users туда писать не могут ->
#         pre-creation/tamper невозможны. Медиум-ребёнок XML вообще не читает (команда после
#         /Create хранится в БД планировщика, SYSTEM-owned). XML удаляется сразу после /Create.
#  2) ПЕРВЫЕ инструкции обёртки — простые присваивания ЛИТЕРАЛОВ (чистые PSModulePath/PATH),
#     БЕЗ единого cmdlet/Join-Path/$env:SystemRoot ДО очистки env (иначе Windows PowerShell
#     автолоадит команды из CurrentUser-модулей high ДО gate). Integrity-self-check — через
#     АБСОЛЮТНЫЙ литерал System32\whoami.exe (не user-writable -> доверен).
#  3) Обёртка исполняет целевой бинарь ТОЛЬКО при MEDIUM (S-1-16-8192); иначе exit 210
#     (fail-closed — ловит и «RL LIMITED проигнорирован для Builtin Administrator / UAC off»:
#     если задача пошла high, self-check видит high и бинарь НЕ запускает).
#  4) Аттестация — НЕ через user-writable файл. Планировщик пишет exit-код обёртки в «Last
#     Result» задачи (БД планировщика, SYSTEM-owned, НЕ user-writable). Родитель читает его
#     локаль-независимо (schtasks /Query /HRESULT /FO CSV /NH /V, поле #6): 267009=выполняется,
#     267011=ещё не запускалась, иначе=exit-код обёртки. Успех установки родитель/вызывающий
#     подтверждает ПРЯМОЙ проверкой каталога расширений (Test-HmExtInstalled), не выводом бинаря.
#  5) Любой сбой (нет системного бинаря, staging-каталог не заперт при elevated, задача не
#     создалась/не выполнилась) -> $null. Вызывающий обязан трактовать $null как FAIL-CLOSED
#     и НЕ запускать бинарь под админом.
#
# ИНВАРИАНТ: elevated-процесс НИКОГДА не исполняет user-writable editor-бинарь at high
# integrity; НИ ОДНОГО user-writable control/attestation-файла в решении о доверии.

# --- Integrity текущего (родительского) процесса через АБСОЛЮТНЫЙ whoami (не user-writable). ---
function Get-HmSelfIntegrity {
    param([Parameter(Mandatory = $true)][string]$WhoamiExe)
    try {
        $t = (& $WhoamiExe /groups 2>$null | Out-String)
        if ($t -match 'S-1-16-8192')  { return 'medium' }
        if ($t -match 'S-1-16-12288') { return 'high' }
        if ($t -match 'S-1-16-16384') { return 'system' }
        if ($t -match 'S-1-16-4096')  { return 'low' }
    } catch { }
    return 'unknown'   # неизвестно -> трактуем как «возможно elevated» (fail-safe у вызывающего)
}

# --- Расширение установлено: каталог "<extId>-<версия>" в одном из Dirs. Точный префикс
#     "<extId>-" + ЦИФРА версии (иначе `anthropic.claude-code-helper-1.0` даёт ложный PASS,
#     ведь он тоже начинается с `anthropic.claude-code-`), ordinal-регистронезависимо,
#     ТОЛЬКО каталоги. Суффикс платформы `-win32-x64` (после `-<ver>`) продолжает проходить. ---
function Test-HmExtInstalled {
    param([Parameter(Mandatory = $true)][string]$ExtId,
          [Parameter(Mandatory = $true)][string[]]$Dirs)
    $rx = '^' + [regex]::Escape($ExtId) + '-\d'
    foreach ($d in $Dirs) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        try {
            $hit = Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match $rx } | Select-Object -First 1
            if ($hit) { return $true }
        } catch { }
    }
    return $false
}

# --- PRIVATE high-integrity staging-каталог под ProgramData. Рождается атомарно с DACL
#     {SYSTEM,Administrators: FullControl}, protection on (без наследования Users). Elevated
#     дополнительно ставит владельца = Administrators (иначе owner=self сохраняет неявный
#     WRITE_DAC). Возвращает путь или $null (fail-closed). ---
function New-HmSecureStagingDir {
    param([Parameter(Mandatory = $true)][string]$ProgramData,
          [Parameter(Mandatory = $true)][string]$Icacls,
          [Parameter(Mandatory = $true)][bool]$Elevated)
    try {
        if (-not (Test-Path -LiteralPath $ProgramData)) { return $null }
        $dir = Join-Path $ProgramData ('HmDeElev-' + [guid]::NewGuid().ToString('N'))
        if (Test-Path -LiteralPath $dir) { return $null }   # CREATE_NEW: занят (невозможно, но fail-closed)

        $admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
        $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
        $allow  = @('S-1-5-18', 'S-1-5-32-544')
        $sd = New-Object System.Security.AccessControl.DirectorySecurity
        $sd.SetAccessRuleProtection($true, $false)   # снять наследование, НЕ копировать унаследованные
        $sd.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $admins, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        $sd.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $system, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        if (-not $Elevated) {
            # Родитель уже MEDIUM (нет privesc): его отфильтрованный токен НЕ может писать по
            # Admins-ACE (Admins deny-only в medium-токене) -> даём владельцу-юзеру доступ, иначе
            # сам примитив не запишет task.xml. При ELEVATED этого ACE НЕТ (тогда medium-атакующий
            # ТОГО ЖЕ юзера не должен иметь записи -> tamper невозможен).
            $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
            $allow += $me.Value
            $sd.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $me, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        }
        # Владелец -> Administrators АТОМАРНО в SD (elevated). БЕЗ этого CreateDirectory ставит
        # owner = создатель (user по Object-Creator-политике), а ВЛАДЕЛЕЦ имеет implicit WRITE_DAC:
        # medium-атакующий ТОГО ЖЕ юзера открыл бы WRITE_DAC по владению, временно добавил себе ACE,
        # создал/удержал task.xml, восстановил DACL под проверки и подменил XML до /Create -> HIGH exec.
        # Ставить владельца ПОСЛЕ (icacls) = окно уязвимости. Здесь — в момент создания.
        if ($Elevated) { $sd.SetOwner($admins) }
        # Рождаем каталог СРАЗУ с этим SD (DACL + владелец применяются атомарно при создании).
        [void][System.IO.Directory]::CreateDirectory($dir, $sd)
        if (-not (Test-Path -LiteralPath $dir)) { return $null }

        # Отвергаем reparse-point (junction-подмена).
        $attr = (Get-Item -LiteralPath $dir -Force).Attributes
        if ($attr -band [System.IO.FileAttributes]::ReparsePoint) {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue; return $null
        }

        # Владелец УЖЕ задан атомарно в SD выше (не post-icacls — иначе окно с owner=user + WRITE_DAC).
        # Проверка владельца ниже — fail-closed, если атомарное применение владельца не сработало
        # (owner != Administrators -> каталог мог иметь окно -> отбрасываем).
        $acl = Get-Acl -LiteralPath $dir
        if ($Elevated) {
            $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            if ($owner -ne 'S-1-5-32-544') {
                Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue; return $null
            }
        }
        foreach ($ace in $acl.Access) {
            $sid = $null
            try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
            catch { $sid = [string]$ace.IdentityReference }
            if ($allow -notcontains $sid) {
                # Посторонний ACE. Elevated -> недопустимо (fail-closed). Medium -> нет privesc
                # (родитель уже medium), но такой ACE не должен появляться при protection on.
                if ($Elevated) {
                    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue; return $null
                }
            }
        }
        return $dir
    } catch { return $null }
}

function Invoke-HmDeElevated {
    param([Parameter(Mandatory = $true)][string]$Exe, [string[]]$Arguments = @())

    # --- Абсолютные системные бинари (fail-closed, если чего-то нет) ---
    $sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $s32      = Join-Path $sysRoot 'System32'
    $psV1     = Join-Path $s32 'WindowsPowerShell\v1.0'
    $psExe    = Join-Path $psV1 'powershell.exe'
    $schtasks = Join-Path $s32 'schtasks.exe'
    $whoami   = Join-Path $s32 'whoami.exe'
    $icacls   = Join-Path $s32 'icacls.exe'
    foreach ($bin in @($psExe, $schtasks, $whoami, $icacls)) {
        if (-not (Test-Path -LiteralPath $bin)) { return $null }
    }

    # --- Чистые PATH / PSModulePath (анти module-hijack) для ПАРЕНТА на время работы примитива ---
    $savedPath = $env:Path
    $savedPsm  = $env:PSModulePath
    $env:PSModulePath = (Join-Path $psV1 'Modules')
    $env:Path         = ($s32 + ';' + $sysRoot + ';' + $psV1)

    $tag = 'HmDeElev_' + [guid]::NewGuid().ToString('N')

    # ProgramData на СИСТЕМНОМ диске (не %ProgramData% env вслепую): корень из $sysRoot.
    $pdRoot   = [System.IO.Path]::GetPathRoot($sysRoot)
    $progData = Join-Path $pdRoot 'ProgramData'

    # Integrity ПАРЕНТА: только при high/system staging-каталог ОБЯЗАН быть заперт (privesc-
    # риск существует лишь когда родитель elevated). Unknown -> трактуем как elevated (fail-safe).
    $selfLvl  = Get-HmSelfIntegrity -WhoamiExe $whoami
    $elevated = ($selfLvl -ne 'medium' -and $selfLvl -ne 'low')

    # --- Литералы (single-quoted, '->'' экранирование) для ВБИВАНИЯ в тело обёртки ---
    $s32Lit = ($s32   -replace "'", "''")
    $srLit  = ($sysRoot -replace "'", "''")
    $whoLit = ($whoami -replace "'", "''")
    $exeLit = ($Exe    -replace "'", "''")
    $argLit = ''
    if ($Arguments.Count -gt 0) {
        $argLit = ' ' + (($Arguments | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ' ')
    }

    # Тело обёртки. СТРОГО ПЕРВЫМИ — присваивания чистых env ЛИТЕРАЛАМИ (ни одного cmdlet до
    # них). Затем integrity-self-check через АБСОЛЮТНЫЙ System32\whoami. Бинарь — ТОЛЬКО при
    # medium; иначе exit 210. Exit-код обёртки станет «Last Result» задачи (доверенный сигнал).
    $body =
        "`$env:PSModulePath='$s32Lit\WindowsPowerShell\v1.0\Modules'`n" +
        "`$env:Path='$s32Lit;$srLit;$s32Lit\WindowsPowerShell\v1.0'`n" +
        "if(@(& '$whoLit' /groups 2>`$null) -match 'S-1-16-8192'){`n" +
        "& '$exeLit'$argLit`n" +
        "`$c=`$LASTEXITCODE; if(`$null -eq `$c){`$c=0}; exit `$c`n" +
        "} else { exit 210 }`n"
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($body))
    $wrapArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $b64

    $result  = $null
    $dir     = $null
    $xmlFile = $null
    try {
        $dir = New-HmSecureStagingDir -ProgramData $progData -Icacls $icacls -Elevated $elevated
        if (-not $dir) { return $null }   # elevated и каталог не заперт -> fail-closed
        $xmlFile = Join-Path $dir 'task.xml'

        # XML: принципал = текущий интерактивный пользователь, InteractiveToken, LeastPrivilege
        # (= /RL LIMITED = medium). Тело обёртки — ЦЕЛИКОМ в <Arguments> (нет лимита 261 как у /TR).
        $userId     = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $userXml    = [System.Security.SecurityElement]::Escape($userId)
        $psExeXml   = [System.Security.SecurityElement]::Escape($psExe)
        $wrapArgXml = [System.Security.SecurityElement]::Escape($wrapArgs)
        $taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Hamidun de-elevated one-shot</Description></RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>$userXml</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$psExeXml</Command>
      <Arguments>$wrapArgXml</Arguments>
    </Exec>
  </Actions>
</Task>
"@
        Set-Content -LiteralPath $xmlFile -Value $taskXml -Encoding Unicode

        # Создать задачу через АБСОЛЮТНЫЙ schtasks.exe по XML. Провал -> fail-closed.
        & $schtasks '/Create' '/TN' $tag '/XML' $xmlFile '/F' 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { return $null }
        # XML больше не нужен (определение задачи — в БД планировщика). Удаляем сразу.
        Remove-Item -LiteralPath $xmlFile -Force -ErrorAction SilentlyContinue; $xmlFile = $null

        & $schtasks '/Run' '/TN' $tag 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { return $null }

        # Ждём завершения по ЛОКАЛЬ-НЕЗАВИСИМОМУ «Last Result» (поле #6 CSV /HRESULT):
        # 267009=выполняется, 267011=ещё не запускалась, иначе=exit-код обёртки.
        $lastResult = $null
        $deadline = (Get-Date).AddSeconds(180)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 400
            $csv = & $schtasks '/Query' '/TN' $tag '/HRESULT' '/FO' 'CSV' '/NH' '/V' 2>$null | Out-String
            $line = ($csv -split "`r?`n" | Where-Object { $_ -match '"' } | Select-Object -First 1)
            if (-not $line) { continue }
            $m = [regex]::Matches($line, '"([^"]*)"')   # base64 без кавычек -> поля разбираются надёжно
            if ($m.Count -gt 6) {
                $lr = $m[6].Groups[1].Value
                if ($lr -ne '267009' -and $lr -ne '267011') { $lastResult = $lr; break }
            }
        }

        if ($null -eq $lastResult) { $gate = 'unknown'; $code = -1 }
        elseif ($lastResult -eq '210') { $gate = 'refused'; $code = -1 }   # обёртка увидела НЕ medium
        else { $gate = 'medium'; $code = 0; [void][int]::TryParse($lastResult, [ref]$code) }
        $result = [pscustomobject]@{ Gate = $gate; Code = $code }
    } catch {
        $result = $null
    } finally {
        & $schtasks '/Delete' '/TN' $tag '/F' 2>&1 | Out-Null
        if ($xmlFile) { Remove-Item -LiteralPath $xmlFile -Force -ErrorAction SilentlyContinue }
        if ($dir)     { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
        $env:Path         = $savedPath
        $env:PSModulePath = $savedPsm
    }
    return $result
}
