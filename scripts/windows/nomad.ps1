# Nomad Agent — Windows (Python CLI via uv)
# Continue (не Stop): нативные команды (git/uv/python) пишут в stderr → под Stop = NativeCommandError и падение.
$ErrorActionPreference = 'Continue'
function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User') + ';' +
                (Join-Path $env:USERPROFILE '.local\bin')
}
Update-Path
$DRY = [bool]$env:HM_DRY_RUN

# 1. Источник Nomad: офлайн vendor → git repoUrl из config.json → graceful skip
$src = $env:HM_NOMAD_SRC
if (-not ($src -and (Test-Path (Join-Path $src 'pyproject.toml')))) {
    $repo = ''
    $cfg = Join-Path $PSScriptRoot '..\..\config.json'
    if (Test-Path $cfg) {
        try { $repo = (Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json).nomad.repoUrl } catch {}
    }
    if ($repo) {
        $src = Join-Path $env:LOCALAPPDATA 'nomad-src'
        Write-Host "Клонирую Nomad из $repo ..."
        if (-not $DRY) {
            if (Test-Path (Join-Path $src '.git')) { git -C $src pull --ff-only }
            else { git clone --depth 1 $repo $src }
        }
    }
}
if (-not ($src -and (Test-Path (Join-Path $src 'pyproject.toml')))) {
    Write-Host "Источник Nomad не задан. Укажите nomad.repoUrl в config.json или вшейте vendor/nomad-src. Пропускаю."
    exit 0
}

# 2. uv — менеджер Python
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "Устанавливаю uv..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: irm https://astral.sh/uv/install.ps1 | iex" }
    else {
        try { Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression }
        catch { Write-Host "uv не установился: $($_.Exception.Message)"; exit 1 }
    }
    Update-Path
}

# 3. Python 3.12 (pyproject требует <3.14) + установка nomad (команды nomad/hermes)
if ($DRY) {
    Write-Host "  [dry-run] WOULD: uv python install 3.12; uv tool install --python 3.12 --force `"$src`""
} else {
    uv python install 3.12
    Write-Host "Устанавливаю Nomad (команды nomad/hermes)..."
    uv tool install --python 3.12 --force "$src"
    Update-Path
}

# 4. Брендинг → HERMES_HOME (по умолчанию %LOCALAPPDATA%\hermes)
$hh = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
if (-not $DRY) {
    New-Item -ItemType Directory -Force -Path $hh, (Join-Path $hh 'skins') | Out-Null
    Copy-Item (Join-Path $src 'branding\SOUL.md')          (Join-Path $hh 'SOUL.md') -Force
    Copy-Item (Join-Path $src 'branding\skins\nomad.yaml') (Join-Path $hh 'skins\nomad.yaml') -Force
    $cfgY = Join-Path $hh 'config.yaml'
    if (-not (Test-Path $cfgY)) { Copy-Item (Join-Path $src 'branding\config.yaml.template') $cfgY -Force }
}

Update-Path
if (Get-Command nomad -ErrorAction SilentlyContinue) {
    Write-Host "OK: nomad установлен ($((nomad --version 2>&1 | Select-Object -First 1)))"
} else {
    Write-Host "Nomad установлен — команда появится в PATH после перезапуска терминала."
}
exit 0
