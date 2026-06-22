# Git — Windows
$ErrorActionPreference = 'Stop'
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }

$DRY = [bool]$env:HM_DRY_RUN
Write-Host "Проверяю Git..."
if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host "Git уже установлен: $(git --version)"; if (-not $DRY) { exit 0 } }

$local = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\git-setup.exe' } else { '' }
if ($local -and (Test-Path $local)) {
    Write-Host "Ставлю Git из встроенного установщика (офлайн)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: $local /VERYSILENT /NORESTART /SP- /SUPPRESSMSGBOXES" }
    else { Start-Process -FilePath $local -ArgumentList '/VERYSILENT','/NORESTART','/SP-','/SUPPRESSMSGBOXES' -Wait }
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Устанавливаю Git через winget..."
    winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
} else {
    Write-Host "winget не найден — качаю Git for Windows напрямую..."
    $rel = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ 'User-Agent' = 'hamidun-setup' }
    $asset = $rel.assets | Where-Object { $_.name -match '64-bit\.exe$' } | Select-Object -First 1
    $exe = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest $asset.browser_download_url -OutFile $exe
    Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/NORESTART','/SP-','/SUPPRESSMSGBOXES' -Wait
}

if ($DRY) { Write-Host "[dry-run] Git: офлайн-ветка выбрана, без изменений."; exit 0 }
Update-Path
if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host "OK: $(git --version)"; exit 0 }
Write-Host "Git не обнаружен после установки."; exit 1
