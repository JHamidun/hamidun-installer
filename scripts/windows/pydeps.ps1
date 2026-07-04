# Python packages for config tools — Windows
# Continue (не Stop): нативные команды (python/pip) пишут в stderr → под Stop = NativeCommandError и падение.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
Update-Path
$DRY = [bool]$env:HM_DRY_RUN

function Get-Py {
    # Пропускаем Store-заглушку WindowsApps\python.exe (на чистой Win11 она пишет в stderr и роняла шаг).
    foreach ($name in 'python', 'python3') {
        $c = Get-Command $name -ErrorAction SilentlyContinue
        if ($c -and $c.Source -notmatch 'WindowsApps') {
            $v = & $c.Source --version 2>&1
            if ("$v" -match 'Python \d') { return $c.Source }
        }
    }
    # Реальный python по известным путям установки (InstallAllUsers=0 → LOCALAPPDATA).
    foreach ($p in @("$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
                     "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
                     "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe")) {
        if (Test-Path $p) { return $p }
    }
    $c = Get-Command py -ErrorAction SilentlyContinue
    if ($c -and $c.Source -notmatch 'WindowsApps') { return $c.Source }
    return $null
}

$py = Get-Py
if (-not $py) {
    $pyInst = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\python-setup.exe' } else { '' }
    if ($pyInst -and (Test-Path $pyInst)) {
        Write-Host "Ставлю Python из встроенного установщика (офлайн)..."
        if ($DRY) { Write-Host "  [dry-run] WOULD: $pyInst /quiet InstallAllUsers=0 PrependPath=1 Include_test=0" }
        else { Confirm-HmArtifact $pyInst; Start-Process -FilePath $pyInst -ArgumentList '/quiet','InstallAllUsers=0','PrependPath=1','Include_test=0' -Wait; Update-Path; $py = Get-Py }
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "Устанавливаю Python 3.12 через winget..."
        winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
        Update-Path; $py = Get-Py
    }
}
if (-not $py) { Write-Host "Python не найден и не установился — пропускаю зависимости."; exit 1 }

if ($env:HM_BUNDLED_CONFIG -and (Test-Path (Join-Path $env:HM_BUNDLED_CONFIG 'requirements.txt'))) {
    $req = Join-Path $env:HM_BUNDLED_CONFIG 'requirements.txt'
} else {
    $req = Join-Path $env:USERPROFILE '.hamidun-setup\config-repo\requirements.txt'
}
if (-not (Test-Path $req)) { Write-Host "requirements.txt не найден ($req) — сначала установите конфиг."; exit 1 }

Write-Host "Использую Python: $py"
$wheels = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'pywheels' } else { '' }
if ($DRY) {
    if ($wheels -and (Test-Path $wheels)) { Write-Host "  [dry-run] WOULD: pip install --user --no-index --find-links $wheels -r $req" }
    else { Write-Host "  [dry-run] WOULD: pip install --user -r $req (онлайн)" }
    $pwbD = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'playwright-browsers' } else { '' }
    if ($pwbD -and (Test-Path $pwbD)) { Write-Host "  [dry-run] WOULD: копировать Playwright-браузеры в %LOCALAPPDATA%\ms-playwright" }
    Write-Host "[dry-run] Python-зависимости: ветка выбрана, без изменений."; exit 0
}
if ($wheels -and (Test-Path $wheels)) {
    Write-Host "Ставлю библиотеки из встроенных wheels (офлайн)..."
    & $py -m pip install --user --no-index --find-links $wheels -r $req
} else {
    & $py -m pip install --user --upgrade pip 2>&1 | Out-Null
    Write-Host "Ставлю библиотеки из PyPI (онлайн)..."
    & $py -m pip install --user -r $req
}
if ($LASTEXITCODE -ne 0) { Write-Host "Часть библиотек не установилась — смотри лог."; exit 1 }

$pwb = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'playwright-browsers' } else { '' }
if ($pwb -and (Test-Path $pwb)) {
    Write-Host "Ставлю встроенные браузеры Playwright (офлайн)..."
    $dst = Join-Path $env:LOCALAPPDATA 'ms-playwright'
    New-Item -ItemType Directory -Force $dst | Out-Null
    Copy-Item -Recurse -Force (Join-Path $pwb '*') $dst -ErrorAction SilentlyContinue
} else {
    Write-Host "Ставлю браузер для Playwright (best-effort)..."
    & $py -m playwright install chromium 2>&1 | Out-Null
}

Write-Host "OK: Python-зависимости установлены."
exit 0
