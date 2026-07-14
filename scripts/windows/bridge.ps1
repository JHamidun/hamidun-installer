# AI-мост (Hamidun Bridge) — Windows: ставим агент + автозапуск (трей)
$ErrorActionPreference = 'Continue'
function Update-Path {
    # SECURITY (#4): PATH для elevated-скрипта — ТОЛЬКО HKLM (Machine) + наши
    # админ-owned фиксированные каталоги. НИКОГДА не читаем HKCU (User) PATH: на чистой
    # машине medium-integrity процесс того же юзера может дописать туда каталог с
    # подложенным git/node/python/winget и исполнить его под нашим elevated-токеном.
    # Инструменты в user-профиле (python/cursor/claude/uv) находим по абсолютным путям.
    $sr  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $s32 = Join-Path $sr 'System32'
    $parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine'),
               $s32, $sr,
               (Join-Path $s32 'WindowsPowerShell\v1.0'),
               (Join-Path $s32 'OpenSSH'))
    if ($env:ProgramFiles) {
        $parts += (Join-Path $env:ProgramFiles 'Git\cmd')
        $parts += (Join-Path $env:ProgramFiles 'Git\bin')
        $parts += (Join-Path $env:ProgramFiles 'nodejs')
    }
    if (${env:ProgramFiles(x86)}) { $parts += (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd') }
    if ($env:HM_VENDOR) { $parts += (Join-Path $env:HM_VENDOR 'apps') }
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}
Update-Path
$DRY = [bool]$env:HM_DRY_RUN

$dst = Join-Path $env:LOCALAPPDATA 'HamidunBridge'
$agentSrc = if ($env:HM_AGENT_DIR) { Join-Path $env:HM_AGENT_DIR 'bridge_agent.py' } else { '' }
if (-not ($agentSrc -and (Test-Path $agentSrc))) { Write-Host "Агент моста не найден в сборке ($agentSrc)."; exit 1 }

if ($DRY) {
    Write-Host "  [dry-run] WOULD: агент -> $dst, pip pystray pillow, Run-автозапуск, OpenSSH, ssh -D"
    Write-Host "[dry-run] AI-мост: ветка выбрана, без изменений."; exit 0
}

# 1. OpenSSH Client (нужен для ssh -D; в Win10 1809+ обычно есть)
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host "Ставлю OpenSSH Client..."
    try { Get-WindowsCapability -Online -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'OpenSSH.Client*' -and $_.State -ne 'Installed' } | ForEach-Object { Add-WindowsCapability -Online -Name $_.Name | Out-Null } } catch {}
    Update-Path
}
# ssh критичен для туннеля — если Features-on-Demand недоступен (корпоративный WSUS,
# офлайн), молча объявить мост «установленным» нельзя.
$sshOk = [bool](Get-Command ssh -ErrorAction SilentlyContinue)
if (-not $sshOk) {
    Write-Host "ВНИМАНИЕ: OpenSSH Client не установился — мост не сможет построить туннель."
    Write-Host "  Установи вручную: Параметры → Приложения → Дополнительные компоненты → Клиент OpenSSH."
}

# 2. реальный Python (не Store-заглушка)
$py = ''
$c = Get-Command python -ErrorAction SilentlyContinue
if ($c -and $c.Source -notmatch 'WindowsApps') { $py = $c.Source }
if (-not $py) { foreach ($p in @("$env:LOCALAPPDATA\Programs\Python\Python313\python.exe", "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe")) { if (Test-Path $p) { $py = $p; break } } }
if (-not $py) { Write-Host "Python не найден — выберите компонент «Python-пакеты»."; exit 1 }
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'

# 3. агент + зависимости (офлайн из wheels если есть)
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Force $agentSrc (Join-Path $dst 'bridge_agent.py')
$wheels = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'pywheels' } else { '' }
# stderr от pip — это не фатал (нативная тулза), поэтому Out-Null для потока,
# но статус берём из $LASTEXITCODE + честной проверки импорта модулей.
if ($wheels -and (Test-Path $wheels)) { & $py -m pip install --user --no-index --find-links $wheels pystray pillow 2>&1 | Out-Null }
else { & $py -m pip install --user pystray pillow 2>&1 | Out-Null }
$pipExit = $LASTEXITCODE
& $py -c "import pystray, PIL" 2>&1 | Out-Null
$trayOk = ($LASTEXITCODE -eq 0)
if (-not $trayOk) {
    Write-Host "ВНИМАНИЕ: pystray/pillow не установились (pip exit=$pipExit) — значок в трее будет недоступен."
    Write-Host "Мост сможет работать в фоне, но переключать его из трея не получится, пока не поставите пакеты."
}

# 4. конфиг агента (если ещё нет)
$cfgPath = Join-Path $dst 'config.json'
if (-not (Test-Path $cfgPath)) {
    $domains = if ($env:HM_BRIDGE_PACDOMAINS) { $env:HM_BRIDGE_PACDOMAINS.Split(',') } else { @('claude.ai', 'anthropic.com', 'openai.com', 'chatgpt.com', 'oaistatic.com', 'higgsfield.ai') }
    $cfgJson = ([ordered]@{
        enrollEndpoint = "$($env:HM_BRIDGE_ENDPOINT)"; bridgeToken = "$($env:HM_BRIDGE_TOKEN)"
        ssh = [ordered]@{ host = ''; port = 22; user = ''; keyPath = ''; password = '' }
        socksPort = 1080; httpPort = 1081; pacPort = 1082; pacDomains = $domains; enabled = $false
    } | ConvertTo-Json -Depth 5)
    # Windows PowerShell 5.1 «Set-Content -Encoding utf8» пишет UTF-8 С BOM, а
    # bridge_agent.py json.load на BOM падал → конфиг молча терялся. Пишем БЕЗ BOM
    # через .NET UTF8Encoding с флагом «не эмитить BOM» ($false).
    [System.IO.File]::WriteAllText($cfgPath, $cfgJson, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
} elseif ($env:HM_BRIDGE_ENDPOINT) {
    # config.json уже есть, но издатель пересобрал установщик с адресом сервера —
    # доставляем новый endpoint/token в существующий конфиг, сохраняя ssh/enabled ученика.
    # Иначе «Сервер настроен» печаталось бы, а агент по-прежнему простаивал бы с пустым endpoint.
    try {
        $cfg = Get-Content -Raw $cfgPath | ConvertFrom-Json
        $cfg.enrollEndpoint = "$($env:HM_BRIDGE_ENDPOINT)"
        if ($null -ne $cfg.PSObject.Properties['bridgeToken']) { $cfg.bridgeToken = "$($env:HM_BRIDGE_TOKEN)" }
        else { $cfg | Add-Member -NotePropertyName bridgeToken -NotePropertyValue "$($env:HM_BRIDGE_TOKEN)" -Force }
        [System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding -ArgumentList $false))
    } catch { Write-Host "Не удалось обновить адрес сервера в существующем config.json: $($_.Exception.Message)" }
}

# 5. автозапуск (Run) + запуск сейчас (трей)
$run = if (Test-Path $pyw) { $pyw } else { $py }
$agentPath = Join-Path $dst 'bridge_agent.py'
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HamidunBridge' -Value ("`"$run`" `"$agentPath`"") -PropertyType String -Force | Out-Null
Start-Process -FilePath $run -ArgumentList "`"$agentPath`"" -WindowStyle Hidden

# P0-4: квитанция владения — ТОЧНЫЕ пути/реестр созданных артефактов (main соберёт в receipt).
Write-Host "HM-RECEIPT path $dst"
Write-Host "HM-RECEIPT reg HKCU|Software\Microsoft\Windows\CurrentVersion\Run|HamidunBridge"

$trayMsg = if ($trayOk) { 'значок в трее' } else { 'фоновый режим без значка (pystray/pillow не встали)' }
if ($env:HM_BRIDGE_ENDPOINT) { Write-Host "OK: AI-мост установлен ($trayMsg). Сервер настроен — включай в трее." }
else { Write-Host "OK: AI-мост установлен ($trayMsg). Сервер ещё не настроен — мост включится, когда получишь доступ в боте." }
exit 0
