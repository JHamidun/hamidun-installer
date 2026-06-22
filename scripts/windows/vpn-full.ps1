# AmneziaVPN (полное приложение, продвинутый режим) — Windows
$ErrorActionPreference = 'Stop'

$endpoint = $env:HM_VPN_ENROLL_URL
if (-not $endpoint) {
    Write-Host "VPN-сервер ещё не настроен (enrollEndpoint пуст) — пропускаю установку AmneziaVPN."
    exit 0
}

# --- установить полный клиент AmneziaVPN ---
if (-not (Get-Command AmneziaVPN -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $env:ProgramFiles 'AmneziaVPN'))) {
    $inst = $null
    if ($env:HM_VENDOR) { $cand = Join-Path $env:HM_VENDOR 'apps\amneziavpn-setup.exe'; if (Test-Path $cand) { $inst = $cand } }
    if ($inst) {
        Write-Host "Ставлю AmneziaVPN из встроенного установщика (офлайн)..."
        Start-Process $inst -ArgumentList '/S' -Wait
    } else {
        Write-Host "Скачиваю AmneziaVPN..."
        $rel = Invoke-RestMethod "https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest" -Headers @{ 'User-Agent' = 'hamidun-setup' }
        $asset = $rel.assets | Where-Object { $_.name -match 'windows.*\.exe$|\.exe$' } | Select-Object -First 1
        if ($asset) {
            $dl = Join-Path $env:TEMP $asset.name
            Invoke-WebRequest $asset.browser_download_url -OutFile $dl
            Start-Process $dl -ArgumentList '/S' -Wait
        } else {
            Write-Host "Не нашёл установщик в релизах — скачайте вручную с amnezia.org."
        }
    }
}

# --- получить vpn://-код и показать пользователю (импорт в полном клиенте — ручной) ---
Write-Host "Запрашиваю код подключения (vpn://)..."
try {
    $body = @{ inviteCode = $env:HM_INVITE_CODE; client = $env:COMPUTERNAME; format = 'amnezia' } | ConvertTo-Json
    $resp = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body `
        -Uri ($endpoint.TrimEnd('/') + $env:HM_VPN_ENROLL_PATH)
    $code = $resp.vpnCode
    if ($code) {
        $out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'amnezia-vpn-код.txt'
        Set-Content -Path $out -Value $code -Encoding utf8
        Write-Host "Код сохранён на Рабочий стол: $out"
        Write-Host "Открой AmneziaVPN → '+' → 'Вставить из буфера' и вставь этот код."
    }
} catch {
    Write-Host "Не удалось получить код: $($_.Exception.Message)"
}
exit 0
