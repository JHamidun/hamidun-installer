# AmneziaWG (авто-конфиг) — Windows
$ErrorActionPreference = 'Stop'

$endpoint = $env:HM_VPN_ENROLL_URL
if (-not $endpoint) {
    Write-Host "VPN-сервер ещё не настроен (enrollEndpoint пуст в config.json) — пропускаю."
    Write-Host "Когда купишь сервер: впиши адрес в config.json и пересобери установщик."
    exit 0
}

# --- self-elevation: установка службы AmneziaWG требует прав администратора ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Запрашиваю права администратора (UAC) для установки VPN..."
    $p = Start-Process powershell -Verb RunAs -PassThru -Wait -ArgumentList @(
        '-ExecutionPolicy','Bypass','-NoProfile','-File', $PSCommandPath
    )
    exit $p.ExitCode
}

# --- 1. получить персональный конфиг с сервера (enrollment) ---
Write-Host "Запрашиваю персональный VPN-конфиг..."
$body = @{ inviteCode = $env:HM_INVITE_CODE; client = $env:COMPUTERNAME; format = 'amneziawg' } | ConvertTo-Json
$resp = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body `
    -Uri ($endpoint.TrimEnd('/') + $env:HM_VPN_ENROLL_PATH)
# Ожидаемый ответ сервера: { "config": "<текст .conf AmneziaWG>", "name": "hamidun" }
$conf = $resp.config
$name = if ($resp.name) { $resp.name } else { 'hamidun' }
if (-not $conf) { Write-Host "Сервер не вернул конфиг."; exit 1 }

# --- 2. установить клиент AmneziaWG ---
if (-not (Test-Path (Join-Path $env:ProgramFiles 'AmneziaWG'))) {
    $inst = $null
    if ($env:HM_VENDOR) { $inst = Get-ChildItem (Join-Path $env:HM_VENDOR 'apps') -Filter 'amneziawg-setup.*' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
    if ($inst) {
        Write-Host "Ставлю AmneziaWG из встроенного установщика (офлайн)..."
    } else {
        Write-Host "Скачиваю клиент AmneziaWG..."
        $rel = Invoke-RestMethod "https://api.github.com/repos/amnezia-vpn/amneziawg-windows-client/releases/latest" -Headers @{ 'User-Agent' = 'hamidun-setup' }
        $asset = $rel.assets | Where-Object { $_.name -match '\.(exe|msi)$' } | Select-Object -First 1
        $inst = Join-Path $env:TEMP $asset.name
        Invoke-WebRequest $asset.browser_download_url -OutFile $inst
    }
    if ($inst -match '\.msi$') { Start-Process msiexec.exe -ArgumentList '/i', "`"$inst`"", '/qn' -Wait }
    else { Start-Process $inst -ArgumentList '/S' -Wait }
}

# --- 3. положить .conf в watched-папку (служба сама подхватит) ---
$dir = Join-Path $env:ProgramFiles 'AmneziaWG\Data\Configurations'
New-Item -ItemType Directory -Force $dir | Out-Null
$confPath = Join-Path $dir "$name.conf"
Set-Content -Path $confPath -Value $conf -Encoding ascii
Write-Host "OK: конфиг помещён в $confPath — AmneziaWG подключится автоматически."
exit 0
