# Node.js LTS — Windows
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }

$DRY = [bool]$env:HM_DRY_RUN
Write-Host "Проверяю Node.js..."
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Host "Node.js уже установлен: $(node --version)"; if (-not $DRY) { exit 0 } }

$local = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\node-lts.msi' } else { '' }
if ($local -and (Test-Path $local)) {
    Write-Host "Ставлю Node.js из встроенного MSI (офлайн)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: msiexec /i $local /qn /norestart" }
    else { Confirm-HmArtifact $local; Start-Process msiexec.exe -ArgumentList '/i', "`"$local`"", '/qn', '/norestart' -Wait }
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Устанавливаю Node.js LTS через winget..."
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
} else {
    Write-Host "winget не найден — качаю MSI Node.js LTS..."
    $idx = Invoke-RestMethod "https://nodejs.org/dist/index.json"
    $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
    $url = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi"
    $msi = Join-Path $env:TEMP "node-lts.msi"
    Invoke-WebRequest $url -OutFile $msi
    Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait
}

if ($DRY) { Write-Host "[dry-run] Node.js: офлайн-ветка выбрана, без изменений."; exit 0 }
Update-Path
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Host "OK: node $(node --version), npm $(npm --version)"; exit 0 }
Write-Host "Node.js не обнаружен после установки."; exit 1
