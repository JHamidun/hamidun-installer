# _deelev.ps1 — ЕДИНЫЙ укреплённый примитив ДЕ-ЭЛЕВАЦИИ (Windows).
# Дот-сорсится компонент-скриптами (vscode.ps1, extension.ps1), которые исполняются
# ELEVATED (установщик requireAdministrator). Прямой вызов user-writable editor-CLI
# (code.cmd / cursor.cmd / Code.exe / Cursor.exe) под АДМИНОМ выполнил бы то, что
# medium-integrity малварь ТОГО ЖЕ юзера могла заранее подложить на его место
# (integrity-escalation). Поэтому редакторный CLI исполняется ТОЛЬКО через этот
# примитив — де-элевированно (medium integrity), fail-closed.
#
# Укрепление (Codex regate P0-D):
#  1) Отдельные СИСТЕМНЫЕ PATH и PSModulePath (только System32 + WindowsPowerShell\v1.0
#     \Modules) на время работы — CurrentUser-модули НЕ подгружаются в elevated-процесс
#     (иначе атакующий подкладывает свой модуль и он грузится high-integrity).
#  2) Планировщик — ТОЛЬКО через абсолютный %SystemRoot%\System32\schtasks.exe. Никакого
#     PS-модуля ScheduledTasks -> module-hijack исключён ЦЕЛИКОМ. Задача описывается XML
#     (принципал + действие), без хрупких schtasks-кавычек в /TR.
#  3) Обёртка САМА проверяет свою integrity (whoami /groups -> Mandatory Label SID) и
#     исполняет целевой бинарь ТОЛЬКО при MEDIUM (S-1-16-8192). Не medium (UAC off /
#     Builtin Administrator / high) -> бинарь НЕ запускается (/RL LIMITED не безусловен).
#     Родитель ПОВТОРНО сверяет integrity-маркер и не доверяет результату, если не medium.
#  4) Любой сбой (нет системного бинаря, задача не создалась/не выполнилась, integrity не
#     medium) -> возврат $null. Вызывающий обязан трактовать $null как FAIL-CLOSED и НЕ
#     запускать бинарь под админом.

function Invoke-HmDeElevated {
    param([Parameter(Mandatory = $true)][string]$Exe, [string[]]$Arguments = @())

    # --- Абсолютные системные бинари (fail-closed, если чего-то нет) ---
    $sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $s32      = Join-Path $sysRoot 'System32'
    $psV1   = Join-Path $s32 'WindowsPowerShell\v1.0'
    $psExe    = Join-Path $psV1 'powershell.exe'
    $schtasks = Join-Path $s32 'schtasks.exe'
    $whoami   = Join-Path $s32 'whoami.exe'
    foreach ($bin in @($psExe, $schtasks, $whoami)) {
        if (-not (Test-Path -LiteralPath $bin)) { return $null }
    }

    # --- Чистые PATH / PSModulePath (анти module-hijack) на время работы примитива ---
    $savedPath = $env:Path
    $savedPsm  = $env:PSModulePath
    $env:Path         = ($s32 + ';' + $sysRoot + ';' + $psV1)
    $env:PSModulePath = (Join-Path $psV1 'Modules')

    $tag      = 'HmDeElev_' + [guid]::NewGuid().ToString('N')
    $tmp      = [System.IO.Path]::GetTempPath()
    $wrapper  = Join-Path $tmp ($tag + '.ps1')
    $xmlFile  = Join-Path $tmp ($tag + '.xml')
    $outFile  = Join-Path $tmp ($tag + '.out')
    $codeFile = Join-Path $tmp ($tag + '.code')
    $intFile  = Join-Path $tmp ($tag + '.int')

    $argLit = ''
    if ($Arguments.Count -gt 0) {
        $argLit = ' ' + (($Arguments | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ' ')
    }
    $exeLit  = $Exe      -replace "'", "''"
    $outLit  = $outFile  -replace "'", "''"
    $codeLit = $codeFile -replace "'", "''"
    $intLit  = $intFile  -replace "'", "''"
    $whoLit  = $whoami   -replace "'", "''"
    $s32Lit  = $s32      -replace "'", "''"
    $srLit   = $sysRoot  -replace "'", "''"

    # Тело обёртки. Порядок записи на диск: сперва integrity-маркер, затем (только при
    # medium) вывод команды, code-файл — ПОСЛЕДНИМ (родитель поллит по code-файлу, поэтому
    # к моменту его появления integrity-маркер и вывод уже на диске).
    $body = @"
`$ErrorActionPreference = 'Continue'
`$env:PSModulePath = Join-Path '$s32Lit' 'WindowsPowerShell\v1.0\Modules'
`$env:Path = '$s32Lit' + ';' + '$srLit' + ';' + (Join-Path '$s32Lit' 'WindowsPowerShell\v1.0')
`$lvl = 'unknown'
try {
  `$g = & '$whoLit' /groups 2>`$null | Out-String
  if (`$g -match 'S-1-16-8192') { `$lvl = 'medium' }
  elseif (`$g -match 'S-1-16-12288') { `$lvl = 'high' }
  elseif (`$g -match 'S-1-16-16384') { `$lvl = 'system' }
  elseif (`$g -match 'S-1-16-4096') { `$lvl = 'low' }
} catch { `$lvl = 'unknown' }
Set-Content -LiteralPath '$intLit' -Value `$lvl -Encoding ASCII
`$c = 1
if (`$lvl -eq 'medium') {
  try {
    `$o = & '$exeLit'$argLit 2>&1 | Out-String
    `$c = `$LASTEXITCODE; if (`$null -eq `$c) { `$c = 0 }
    Set-Content -LiteralPath '$outLit' -Value `$o -Encoding UTF8
  } catch {
    Set-Content -LiteralPath '$outLit' -Value `$_.Exception.Message -Encoding UTF8
  }
} else {
  Set-Content -LiteralPath '$outLit' -Value ('SKIP integrity=' + `$lvl + ' (not medium) -> refused to run elevated') -Encoding UTF8
}
Set-Content -LiteralPath '$codeLit' -Value ([string]`$c) -Encoding ASCII
"@

    $result = $null
    try {
        Set-Content -LiteralPath $wrapper -Value $body -Encoding UTF8

        # XML задачи: принципал = ТЕКУЩИЙ интерактивный пользователь, InteractiveToken,
        # LeastPrivilege (= /RL LIMITED = medium). Команда/аргументы — отдельными XML-узлами
        # (никаких вложенных кавычек в одну строку -> нет schtasks-quoting-ада).
        $userId     = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $userXml    = [System.Security.SecurityElement]::Escape($userId)
        $psExeXml   = [System.Security.SecurityElement]::Escape($psExe)
        $wrapArg    = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $wrapper + '"'
        $wrapArgXml = [System.Security.SecurityElement]::Escape($wrapArg)
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

        # Создать задачу через АБСОЛЮТНЫЙ schtasks.exe. Провал -> throw -> fail-closed.
        & $schtasks '/Create' '/TN' $tag '/XML' $xmlFile '/F' 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'schtasks /Create failed' }
        & $schtasks '/Run' '/TN' $tag 2>&1 | Out-Null
        $runOk = ($LASTEXITCODE -eq 0)

        if ($runOk) {
            $deadline = (Get-Date).AddSeconds(180)
            while (-not (Test-Path -LiteralPath $codeFile) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 400 }
        }
        & $schtasks '/Delete' '/TN' $tag '/F' 2>&1 | Out-Null

        if ($runOk -and (Test-Path -LiteralPath $codeFile)) {
            $lvl = ''
            try { $lvl = (Get-Content -LiteralPath $intFile -Raw -ErrorAction SilentlyContinue).Trim() } catch { $lvl = '' }
            if ($lvl -eq 'medium') {
                $code = 1; $out = ''
                try { $code = [int]((Get-Content -LiteralPath $codeFile -Raw).Trim()) } catch { $code = 1 }
                try { $out = Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue } catch { $out = '' }
                $result = [pscustomobject]@{ Code = $code; Output = $out }
            }
            # $lvl != 'medium' -> обёртка отработала НЕ на medium integrity -> НЕ доверяем
            # ($result остаётся $null: вызывающий трактует как fail-closed).
        }
    } catch {
        $result = $null
    } finally {
        $env:Path         = $savedPath
        $env:PSModulePath = $savedPsm
        Remove-Item -LiteralPath $wrapper, $xmlFile, $outFile, $codeFile, $intFile -Force -ErrorAction SilentlyContinue
    }
    return $result
}
