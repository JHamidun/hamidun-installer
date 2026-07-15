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

# GUARD (Codex P0): не перезаписываем ЧУЖОЙ uv-tool/шимы. Если uv-tool hermes-agent ИЛИ
# команды nomad/hermes уже существуют — НЕ ставим поверх (без принудительной перезаписи):
# осознанный skip (exit 120). Клон/сборку тоже не запускаем.
if (-not $DRY) {
    $existingNomad = @(
        (Join-Path $env:APPDATA 'uv\tools\hermes-agent'),
        (Join-Path $env:USERPROFILE '.local\share\uv\tools\hermes-agent'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad'),
        (Join-Path $env:USERPROFILE '.local\bin\hermes.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\hermes')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    if ($existingNomad) {
        Write-Host "uv-tool hermes-agent или команды nomad/hermes уже установлены — не перезаписываю чужое (без принудительной перезаписи). Пропускаю."
        exit 120
    }
}

# 1. Источник Nomad — ТОЛЬКО доверенный: (а) вшитый bundled vendor (HM_NOMAD_SRC с
#    pyproject.toml; путь задаёт main, не renderer), ЛИБО (б) СВЕЖИЙ git clone в РАНЕЕ
#    ОТСУТСТВОВАВШИЙ %LOCALAPPDATA%\nomad-src. Любой уже существующий nomad-src (в т.ч. с
#    pyproject.toml — чужой) НЕ доверяем: не клонируем, НЕ ставим из него и НЕ исполняем
#    его build-backend. Иначе → graceful skip.
$src = $env:HM_NOMAD_SRC
$repoConfigured = $false   # был ли реально задан repoUrl
$weClonedSrc = $false      # клонировали ли МЫ исходники в LOCALAPPDATA\nomad-src этим запуском
$cloneAttempted = $false   # реально ли запускали git clone (отличаем «clone упал» от «пропущен»)
$srcTrusted = $false       # можно ли ставить из $src: доверенный vendor ИЛИ наш свежий clone
if ($src -and (Test-Path (Join-Path $src 'pyproject.toml'))) {
    # (а) Доверенный bundled vendor — единственный «существующий каталог», из которого можно ставить.
    $srcTrusted = $true
} else {
    $repo = ''
    $cfg = Join-Path $PSScriptRoot '..\..\config.json'
    if (Test-Path $cfg) {
        try { $repo = (Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json).nomad.repoUrl } catch {}
    }
    if ($repo) {
        $repoConfigured = $true
        $src = Join-Path $env:LOCALAPPDATA 'nomad-src'
        if ($DRY) {
            Write-Host "  [dry-run] WOULD: git clone --depth 1 $repo $src (только в отсутствующий путь; существующий/чужой не трогаем и не ставим)"
        } else {
            # ЖЁСТКО: клонируем ТОЛЬКО в ОТСУТСТВУЮЩИЙ путь. ЛЮБОЙ существующий $src
            # (файл/каталог/симлинк — в т.ч. чужой с pyproject.toml) → НЕ трогаем и НЕ
            # ставим из него: не исполняем чужой build-backend.
            if (Test-Path -LiteralPath $src) {
                Write-Host "Каталог $src уже существует — чужому источнику не доверяю: не клонирую и не устанавливаю из него. Пропускаю."
            } else {
                Write-Host "Клонирую Nomad из $repo ..."
                $cloneAttempted = $true
                git clone --depth 1 $repo $src
                if (Test-Path (Join-Path $src 'pyproject.toml')) { $srcTrusted = $true; $weClonedSrc = $true }
            }
        }
    }
}
# repoUrl задан и МЫ пытались клонировать, но источник так и не появился (git clone упал
# / нет pyproject.toml) — НАСТОЯЩИЙ провал: честный выход 1. Намеренный пропуск клона
# (чужой каталог) сюда НЕ попадает ($cloneAttempted=$false) → уходит в graceful skip.
if (-not $DRY -and $cloneAttempted -and -not $srcTrusted) {
    Write-Host "ОШИБКА: источник Nomad не склонировался (git clone упал или pyproject.toml не появился) — смотри лог выше."
    exit 1
}
# Ставим ТОЛЬКО из доверенного источника. Недоверенный/отсутствующий (чужой существующий
# каталог, либо clone не выполнен) → осознанный skip: distinct-код 120 (main НЕ пишет
# маркер установки). В dry-run skip НЕ делаем — превьюим секции 2/3/4 ниже.
if (-not $DRY -and -not $srcTrusted) {
    Write-Host "Источник Nomad не задан/недоступен/недоверенный. Укажите nomad.repoUrl в config.json или вшейте vendor/nomad-src. Пропускаю."
    exit 120
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

# 3. Python 3.12 (pyproject требует <3.14) + установка nomad (команды nomad/hermes).
# БЕЗ принудительной перезаписи: uv-тул/шимы этого имени уже отсеяны guard-ом выше, а
# принудительная замена могла бы затронуть и не-uv бинарь того же имени — недопустимо.
if ($DRY) {
    Write-Host "  [dry-run] WOULD: uv python install 3.12; uv tool install --python 3.12 `"$src`" (без принудительной перезаписи)"
} else {
    if (-not $uv) { Write-Host "uv не найден после установки — прерываю."; exit 1 }
    # P1-5: коды нативных команд НЕ проглатываем ($ErrorActionPreference=Continue их
    # не ловит) — любой сбой = честный exit 1 ДО брендинга и квитанции. Иначе старый
    # nomad.exe в ~/.local/bin проходил финальную проверку и писался новый receipt.
    & $uv python install 3.12
    if ($LASTEXITCODE -ne 0) { Write-Host "ОШИБКА: uv python install 3.12 завершился с кодом $LASTEXITCODE — прерываю (брендинг/квитанцию не пишу)."; exit 1 }
    Write-Host "Устанавливаю Nomad (команды nomad/hermes)..."
    & $uv tool install --python 3.12 "$src"
    if ($LASTEXITCODE -ne 0) { Write-Host "ОШИБКА: uv tool install завершился с кодом $LASTEXITCODE — прерываю (брендинг/квитанцию не пишу)."; exit 1 }
    Update-Path
    # v1: ownership-маркеры в venv БОЛЬШЕ НЕ пишем (маркерная логика удалена вместе с
    # авто-удалением Nomad — см. src/uninstall-targets.js). Запись маркера-владения в
    # пользовательские candidate-venv была install-side P0 (портила чужой uv-tool).
}

# 4. Брендинг → HERMES_HOME (по умолчанию %LOCALAPPDATA%\hermes). Брендинг-файл копируем
# ТОЛЬКО если целевого НЕТ — существующий пользовательский файл НЕ перезаписываем.
$hh = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$wroteSoul = $false; $wroteSkin = $false
if (-not $DRY) {
    New-Item -ItemType Directory -Force -Path $hh, (Join-Path $hh 'skins') | Out-Null
    $soulDst = Join-Path $hh 'SOUL.md'
    if (-not (Test-Path -LiteralPath $soulDst)) {
        $soulSrc = Join-Path $src 'branding\SOUL.md'
        if (Test-Path $soulSrc) { Copy-Item $soulSrc $soulDst; $wroteSoul = $true }
        else { Write-Host "  [warn] branding\SOUL.md не найден — пропускаю" }
    } else { Write-Host "  SOUL.md уже существует — не перезаписываю." }
    $skinDst = Join-Path $hh 'skins\nomad.yaml'
    if (-not (Test-Path -LiteralPath $skinDst)) {
        $nomadYamlSrc = Join-Path $src 'branding\skins\nomad.yaml'
        if (Test-Path $nomadYamlSrc) { Copy-Item $nomadYamlSrc $skinDst; $wroteSkin = $true }
        else { Write-Host "  [warn] branding\skins\nomad.yaml не найден — пропускаю" }
    } else { Write-Host "  skins\nomad.yaml уже существует — не перезаписываю." }
    $cfgY = Join-Path $hh 'config.yaml'
    if (-not (Test-Path $cfgY)) {
        $cfgTmpl = Join-Path $src 'branding\config.yaml.template'
        if (Test-Path $cfgTmpl) { Copy-Item $cfgTmpl $cfgY }
        else { Write-Host "  [warn] branding\config.yaml.template не найден — пропускаю" }
    }
}

if ($DRY) { Write-Host "[dry-run] Nomad preview завершён."; exit 0 }
Update-Path

# P0-4: квитанция владения — ТОЧНЫЕ пути СОЗДАННЫХ артефактов (main соберёт в receipt).
# ВАЖНО: HERMES_HOME\config.yaml НЕ записываем в квитанцию — после установки это
# пользовательский конфиг (ключи/настройки), деинсталлятор его трогать не должен.
# Брендинг попадает в квитанцию ТОЛЬКО если МЫ его создали (чужой файл не присваиваем).
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
    if ($wroteSoul) {
        $soul = Join-Path $hh 'SOUL.md'
        if (Test-Path -LiteralPath $soul) { Write-Host "HM-RECEIPT path $soul" }
    }
    if ($wroteSkin) {
        $skin = Join-Path $hh 'skins\nomad.yaml'
        if (Test-Path -LiteralPath $skin) { Write-Host "HM-RECEIPT path $skin" }
    }
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
