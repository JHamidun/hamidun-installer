# Nomad Agent — Windows (Python CLI via uv)
# Continue (не Stop): нативные команды (git/uv/python) пишут в stderr → под Stop = NativeCommandError и падение.
$ErrorActionPreference = 'Continue'
# irm|iex ниже тянет ОФИЦИАЛЬНЫЙ установщик uv (astral.sh) по HTTPS (доверие = TLS). Форсим TLS 1.2.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
function Update-Path {
    # SECURITY (#4): PATH для elevated-скрипта — ТОЛЬКО HKLM (Machine) + наши
    # админ-owned фиксированные каталоги. НИКОГДА не читаем HKCU (User) PATH: на чистой
    # машине medium-integrity процесс того же юзера может дописать туда каталог с
    # подложенным git/node/python/winget и исполнить его под нашим elevated-токеном.
    # uv/nomad ставятся в user-профиль (~/.local\bin) — резолвим их по АБСОЛЮТНОМУ пути
    # (Resolve-UvExe / abs-fallback ниже), а НЕ через user-writable каталог в PATH.
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

# uv/nomad живут в user-профиле (~/.local\bin) и НЕ в elevated-PATH (см. Update-Path #4).
# Резолвим uv по абсолютному пути: Get-Command (если вдруг в Machine-PATH) → ~/.local\bin.
function Resolve-UvExe {
    $c = Get-Command uv -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { return $c.Source }
    foreach ($p in @((Join-Path $env:USERPROFILE '.local\bin\uv.exe'),
                     (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\uv.exe'))) {
        if (Test-Path $p) { return $p }
    }
    return $null
}
Update-Path
$DRY = [bool]$env:HM_DRY_RUN

# 1. Источник Nomad: офлайн vendor → git repoUrl из config.json → graceful skip
$src = $env:HM_NOMAD_SRC
$repoConfigured = $false   # был ли реально задан repoUrl (тогда clone обязан был сработать)
$weClonedSrc = $false      # P0-4: клонировали ли МЫ исходники в LOCALAPPDATA\nomad-src
if (-not ($src -and (Test-Path (Join-Path $src 'pyproject.toml')))) {
    $repo = ''
    $cfg = Join-Path $PSScriptRoot '..\..\config.json'
    if (Test-Path $cfg) {
        try { $repo = (Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json).nomad.repoUrl } catch {}
    }
    if ($repo) {
        $repoConfigured = $true
        $src = Join-Path $env:LOCALAPPDATA 'nomad-src'
        $weClonedSrc = $true
        Write-Host "Клонирую Nomad из $repo ..."
        if ($DRY) {
            Write-Host "  [dry-run] WOULD: git clone --depth 1 $repo $src (or pull if exists)"
        } else {
            if (Test-Path (Join-Path $src '.git')) { git -C $src pull --ff-only }
            else { git clone --depth 1 $repo $src }
            # P0-3: НАШ маркер владения клоном. Деинсталлятор удаляет nomad-src ТОЛЬКО
            # при его наличии (pyproject.toml есть у миллионов чужих проектов — не гейт).
            if (Test-Path (Join-Path $src 'pyproject.toml')) {
                Set-Content -Path (Join-Path $src '.hamidun-nomad') -Value 'installed-by: hamidun-setup' -Encoding ASCII
            }
        }
    }
}
# repoUrl был задан, но источник так и не появился (clone/pull упал или нет pyproject.toml) —
# это НАСТОЯЩИЙ провал, а не осознанный skip: честный выход 1.
if (-not $DRY -and $repoConfigured -and -not ($src -and (Test-Path (Join-Path $src 'pyproject.toml')))) {
    Write-Host "ОШИБКА: источник Nomad не склонировался (git clone/pull упал или pyproject.toml не появился) — смотри лог выше."
    exit 1
}
if (-not $DRY -and -not ($src -and (Test-Path (Join-Path $src 'pyproject.toml')))) {
    Write-Host "Источник Nomad не задан. Укажите nomad.repoUrl в config.json или вшейте vendor/nomad-src. Пропускаю."
    exit 0
}
if ($DRY -and (-not $src)) {
    Write-Host "  [dry-run] Источник Nomad не задан — продолжаем dry-run preview секций 2/3/4."
}

# 2. uv — менеджер Python (в user-профиле; резолвим по abs-пути, не через PATH)
$uv = Resolve-UvExe
if (-not $uv) {
    Write-Host "Устанавливаю uv..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: irm https://astral.sh/uv/install.ps1 | iex" }
    else {
        try { Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression }
        catch { Write-Host "uv не установился: $($_.Exception.Message)"; exit 1 }
    }
    Update-Path
    $uv = Resolve-UvExe
}

# 3. Python 3.12 (pyproject требует <3.14) + установка nomad (команды nomad/hermes)
if ($DRY) {
    Write-Host "  [dry-run] WOULD: uv python install 3.12; uv tool install --python 3.12 --force `"$src`""
} else {
    if (-not $uv) { Write-Host "uv не найден после установки — прерываю."; exit 1 }
    # P1-5: коды нативных команд НЕ проглатываем ($ErrorActionPreference=Continue их
    # не ловит) — любой сбой = честный exit 1 ДО брендинга и квитанции. Иначе старый
    # nomad.exe в ~/.local/bin проходил финальную проверку и писался новый receipt.
    & $uv python install 3.12
    if ($LASTEXITCODE -ne 0) { Write-Host "ОШИБКА: uv python install 3.12 завершился с кодом $LASTEXITCODE — прерываю (брендинг/квитанцию не пишу)."; exit 1 }
    Write-Host "Устанавливаю Nomad (команды nomad/hermes)..."
    & $uv tool install --python 3.12 --force "$src"
    if ($LASTEXITCODE -ne 0) { Write-Host "ОШИБКА: uv tool install завершился с кодом $LASTEXITCODE — прерываю (брендинг/квитанцию не пишу)."; exit 1 }
    Update-Path
}

# 4. Брендинг → HERMES_HOME (по умолчанию %LOCALAPPDATA%\hermes)
$hh = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
if (-not $DRY) {
    New-Item -ItemType Directory -Force -Path $hh, (Join-Path $hh 'skins') | Out-Null
    $soulSrc = Join-Path $src 'branding\SOUL.md'
    if (Test-Path $soulSrc) { Copy-Item $soulSrc (Join-Path $hh 'SOUL.md') -Force }
    else { Write-Host "  [warn] branding\SOUL.md не найден — пропускаю" }
    $nomadYamlSrc = Join-Path $src 'branding\skins\nomad.yaml'
    if (Test-Path $nomadYamlSrc) { Copy-Item $nomadYamlSrc (Join-Path $hh 'skins\nomad.yaml') -Force }
    else { Write-Host "  [warn] branding\skins\nomad.yaml не найден — пропускаю" }
    $cfgY = Join-Path $hh 'config.yaml'
    if (-not (Test-Path $cfgY)) {
        $cfgTmpl = Join-Path $src 'branding\config.yaml.template'
        if (Test-Path $cfgTmpl) { Copy-Item $cfgTmpl $cfgY -Force }
        else { Write-Host "  [warn] branding\config.yaml.template не найден — пропускаю" }
    }
}

if ($DRY) { Write-Host "[dry-run] Nomad preview завершён."; exit 0 }
Update-Path

# P0-4: квитанция владения — ТОЧНЫЕ пути созданных артефактов (main соберёт в receipt).
# ВАЖНО: HERMES_HOME\config.yaml НЕ записываем в квитанцию — после установки это
# пользовательский конфиг (ключи/настройки), деинсталлятор его трогать не должен.
function Write-NomadReceipt {
    if ($weClonedSrc -and (Test-Path $src)) { Write-Host "HM-RECEIPT path $src" }
    foreach ($shim in @('nomad.exe', 'nomad', 'hermes.exe', 'hermes')) {
        $p = Join-Path $env:USERPROFILE ".local\bin\$shim"
        if (Test-Path -LiteralPath $p) { Write-Host "HM-RECEIPT path $p" }
    }
    # P1-4: uv-тул называется по pyproject [project].name = hermes-agent (не «nomad»).
    foreach ($toolDir in @((Join-Path $env:APPDATA 'uv\tools\hermes-agent'),
                           (Join-Path $env:USERPROFILE '.local\share\uv\tools\hermes-agent'))) {
        if (Test-Path -LiteralPath $toolDir) { Write-Host "HM-RECEIPT path $toolDir" }
    }
    $soul = Join-Path $hh 'SOUL.md'
    if (Test-Path -LiteralPath $soul) { Write-Host "HM-RECEIPT path $soul" }
    $skin = Join-Path $hh 'skins\nomad.yaml'
    if (Test-Path -LiteralPath $skin) { Write-Host "HM-RECEIPT path $skin" }
}

if (Get-Command nomad -ErrorAction SilentlyContinue) {
    Write-NomadReceipt
    Write-Host "OK: nomad установлен ($((nomad --version 2>&1 | Select-Object -First 1)))"; exit 0
}
if (Test-Path (Join-Path $env:USERPROFILE '.local\bin\nomad.exe')) {
    Write-NomadReceipt
    Write-Host "OK: nomad в ~/.local/bin — появится в PATH после перезапуска терминала."; exit 0
}
Write-Host "ОШИБКА: Nomad не установился — смотри лог выше."
exit 1
