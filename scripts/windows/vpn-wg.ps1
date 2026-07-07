# AmneziaWG (авто-конфиг) — Windows
param([string]$HmEnvFile)   # элевированный (RunAs) прогон получает сюда путь к env-файлу с HM_*
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)

# RunAs стартует НОВЫЙ процесс с чистым окружением — переменные HM_* теряются. Элевированный
# прогон восстанавливает их из переданного файла (формат KEY=VALUE, без исполнения кода).
if ($HmEnvFile -and (Test-Path $HmEnvFile)) {
    foreach ($line in (Get-Content -LiteralPath $HmEnvFile -Encoding UTF8)) {
        $eq = $line.IndexOf('=')
        if ($eq -gt 0) { Set-Item -Path ("Env:" + $line.Substring(0, $eq)) -Value $line.Substring($eq + 1) }
    }
}

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
    # Прокидываем HM_* в элевированный процесс через временный файл — иначе они теряются при RunAs,
    # и элевированный прогон молча пропустит VPN (enrollEndpoint окажется пуст) с выходом 0.
    $envFile = Join-Path ([System.IO.Path]::GetTempPath()) ("hamidun-vpn-env-" + [guid]::NewGuid().ToString('N') + ".txt")
    try {
        $envLines = Get-ChildItem Env: | Where-Object { $_.Name -like 'HM_*' } | ForEach-Object { $_.Name + '=' + $_.Value }
        Set-Content -LiteralPath $envFile -Value $envLines -Encoding UTF8
        # ОДНОЙ строкой с ручными кавычками: -ArgumentList @(...) в PS 5.1 склеивает
        # элементы пробелом БЕЗ квотирования, и путь с пробелом ('Hamidun Setup',
        # профиль 'Иван Иванов') обрубает -File. Пути Windows не содержат '"' — инъекции нет.
        $p = Start-Process powershell -Verb RunAs -PassThru -Wait -ArgumentList (
            '-ExecutionPolicy Bypass -NoProfile -File "{0}" -HmEnvFile "{1}"' -f $PSCommandPath, $envFile
        )
        exit $p.ExitCode
    } finally {
        Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
    }
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

# --- 2. установить клиент AmneziaWG (гейтим по РЕАЛЬНОМУ бинарю, а не по папке —
# ниже мы сами создаём ProgramFiles\AmneziaWG\Data\Configurations, и проверка по
# папке навсегда пропускала бы установку после первого же провала) ---
$agwRoot = Join-Path $env:ProgramFiles 'AmneziaWG'
function Test-AwgInstalled { $null -ne (Get-ChildItem $agwRoot -Filter '*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1) }
if (-not (Test-AwgInstalled)) {
    $inst = $null
    $instBundled = $false
    if ($env:HM_VENDOR) { $inst = Get-ChildItem (Join-Path $env:HM_VENDOR 'apps') -Filter 'amneziawg-setup.*' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
    if ($inst) {
        Write-Host "Ставлю AmneziaWG из встроенного установщика (офлайн)..."
        $instBundled = $true
    } else {
        Write-Host "Скачиваю клиент AmneziaWG..."
        $rel = Invoke-RestMethod "https://api.github.com/repos/amnezia-vpn/amneziawg-windows-client/releases/latest" -Headers @{ 'User-Agent' = 'hamidun-setup' }
        # Не берём arm64-ассет на x64-машину (и наоборот).
        $asset = $rel.assets | Where-Object { $_.name -match '\.(exe|msi)$' -and $_.name -notmatch 'arm64' } | Select-Object -First 1
        if (-not $asset) { Write-Host "Не нашёл подходящий установщик AmneziaWG."; exit 1 }
        $inst = Join-Path $env:TEMP $asset.name
        Invoke-WebRequest $asset.browser_download_url -OutFile $inst
    }
    if ($instBundled) { Confirm-HmArtifact $inst }  # вшитый артефакт — сверяем SHA-256 (fail-closed)
    if ($inst -match '\.msi$') { $ip = Start-Process msiexec.exe -ArgumentList '/i', "`"$inst`"", '/qn' -Wait -PassThru }
    else { $ip = Start-Process $inst -ArgumentList '/S' -Wait -PassThru }
    # Код msiexec/установщика: 0 = ок, 3010 = ок, нужна перезагрузка. Иначе — честный провал,
    # а не тихий зелёный с конфигом в папку несуществующего клиента.
    if ($ip.ExitCode -notin 0, 3010) { Write-Host "Установка клиента AmneziaWG не удалась (код $($ip.ExitCode)). Повтори при стабильной сети или поставь клиент вручную с amnezia.org и импортируй конфиг."; exit 1 }
    if (-not (Test-AwgInstalled)) { Write-Host "Клиент AmneziaWG не появился после установки — конфиг не записываю."; exit 1 }
}

# --- 3. положить .conf в watched-папку (служба сама подхватит) ---
$dir = Join-Path $env:ProgramFiles 'AmneziaWG\Data\Configurations'
New-Item -ItemType Directory -Force $dir | Out-Null
$confPath = Join-Path $dir "$name.conf"
Set-Content -Path $confPath -Value $conf -Encoding ascii
Write-Host "OK: конфиг помещён в $confPath — AmneziaWG подключится автоматически."
exit 0
