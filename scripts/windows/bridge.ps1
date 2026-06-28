# AI-мост (Hamidun Bridge) — Windows: ставим агент + автозапуск (трей)
$ErrorActionPreference = 'Continue'
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
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
if ($wheels -and (Test-Path $wheels)) { & $py -m pip install --user --no-index --find-links $wheels pystray pillow 2>&1 | Out-Null }
else { & $py -m pip install --user pystray pillow 2>&1 | Out-Null }

# 4. конфиг агента (если ещё нет)
$cfgPath = Join-Path $dst 'config.json'
if (-not (Test-Path $cfgPath)) {
    $domains = if ($env:HM_BRIDGE_PACDOMAINS) { $env:HM_BRIDGE_PACDOMAINS.Split(',') } else { @('claude.ai', 'anthropic.com', 'openai.com', 'chatgpt.com', 'oaistatic.com', 'higgsfield.ai') }
    ([ordered]@{
        enrollEndpoint = "$($env:HM_BRIDGE_ENDPOINT)"; bridgeToken = "$($env:HM_BRIDGE_TOKEN)"
        ssh = [ordered]@{ host = ''; port = 22; user = ''; keyPath = ''; password = '' }
        socksPort = 1080; httpPort = 1081; pacPort = 1082; pacDomains = $domains; enabled = $false
    } | ConvertTo-Json -Depth 5) | Set-Content -Path $cfgPath -Encoding utf8
}

# 5. автозапуск (Run) + запуск сейчас (трей)
$run = if (Test-Path $pyw) { $pyw } else { $py }
$agentPath = Join-Path $dst 'bridge_agent.py'
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HamidunBridge' -Value ("`"$run`" `"$agentPath`"") -PropertyType String -Force | Out-Null
Start-Process -FilePath $run -ArgumentList "`"$agentPath`"" -WindowStyle Hidden

if ($env:HM_BRIDGE_ENDPOINT) { Write-Host "OK: AI-мост установлен (значок в трее). Сервер настроен — включай в трее." }
else { Write-Host "OK: AI-мост установлен (значок в трее). Сервер ещё не настроен — мост включится, когда получишь доступ в боте." }
exit 0
