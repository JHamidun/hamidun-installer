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

# GUARD (Codex P0): не перезаписываем ЧУЖОЙ uv-tool/шимы. Если uv-tool nomad-agent ИЛИ
# команды nmd/nomad-agent/nomad-acp (entrypoints агента) уже существуют — НЕ ставим поверх
# (без принудительной перезаписи): осознанный skip (exit 120). Клонирования нет вовсе.
if (-not $DRY) {
    $existingNomad = @(
        (Join-Path $env:APPDATA 'uv\tools\nomad-agent'),
        (Join-Path $env:USERPROFILE '.local\share\uv\tools\nomad-agent'),
        (Join-Path $env:USERPROFILE '.local\bin\nmd.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\nmd'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad-agent.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad-agent'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad-acp.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad-acp')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    if ($existingNomad) {
        Write-Host "uv-tool nomad-agent или команды nmd/nomad-agent/nomad-acp уже установлены — не перезаписываю чужое (без принудительной перезаписи). Пропускаю."
        exit 120
    }
}

# 1. Источник Nomad — VENDOR-ONLY: ТОЛЬКО вшитый bundled vendor (HM_NOMAD_SRC с
#    pyproject.toml; путь задаёт main из vendorRoot, не renderer). Клонирования НЕТ:
#    ветка клонирования удалена целиком, и с ней ушла TOCTOU-P0 (Фаза 2, Codex round-7) —
#    подмена чужого pyproject.toml между Test-Path и клоном → исполнение чужого
#    build-backend под админом. Нет vendor → graceful skip 120 (НЕ клонируем, НЕ падаем).
$src = $env:HM_NOMAD_SRC
$srcTrusted = $false       # можно ли ставить из $src: доверенный вшитый vendor
if ($src -and (Test-Path (Join-Path $src 'pyproject.toml'))) {
    # Доверенный bundled vendor — единственный источник, из которого можно ставить.
    $srcTrusted = $true
}
# Vendor не вшит → осознанный skip: distinct-код 120 (main НЕ пишет маркер установки).
# В dry-run skip НЕ делаем — превьюим секции 2/3/4 ниже.
if (-not $DRY -and -not $srcTrusted) {
    Write-Host "Источник Nomad (vendor/nomad-src) не вшит — устанавливать нечего (клонирование не выполняется). Вшей vendor/nomad-src (см. tools/fetch-vendor.ps1). Пропускаю."
    exit 120
}
if ($DRY -and (-not $srcTrusted)) {
    Write-Host "  [dry-run] Источник Nomad (vendor) не вшит — продолжаю dry-run preview секций 2/3/4."
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

# 3. Python 3.12 (pyproject требует <3.14) + установка nomad (команды nmd/nomad-agent/nomad-acp).
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
    Write-Host "Устанавливаю Nomad (команды nmd/nomad-agent/nomad-acp)..."
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

# 5. Nomad Cloud (cp.nomadnet.ai) — доступ к ИИ-моделям через облако владельца (без VPN).
#    OpenAI-совместимый custom-провайдер: config.yaml model.provider=custom + base_url +
#    api_key + default. Ключ — ТОЛЬКО кабинетный ключ ДРУГА (HM_NOMAD_CLOUD_KEY), ключ
#    владельца нигде не зашит. Идемпотентно (управляемый блок между маркерами). Ключ не
#    задан → облачный блок НЕ пишем (graceful): любую нейросеть можно подключить позже
#    своим API-ключом через `nmd model`.
$cfgY = Join-Path $hh 'config.yaml'
$cloudKey   = if ($env:HM_NOMAD_CLOUD_KEY)     { ($env:HM_NOMAD_CLOUD_KEY).Trim() }     else { '' }
$cloudUrl   = if ($env:HM_NOMAD_CLOUD_BASEURL) { ($env:HM_NOMAD_CLOUD_BASEURL).Trim() } else { 'https://cp.nomadnet.ai/v1' }
$cloudModel = if ($env:HM_NOMAD_CLOUD_MODEL)   { ($env:HM_NOMAD_CLOUD_MODEL).Trim() }   else { 'claude-opus-4-6' }
if (-not $cloudKey) {
    Write-Host "Ключ Nomad Cloud не задан — облачный блок НЕ пишу (graceful). Подключишь позже: nmd model → custom endpoint $cloudUrl или свой ключ любой нейросети."
} else {
    # Значения уходят в YAML в двойных кавычках — вычищаем кавычки/переводы строк.
    $keySan   = ($cloudKey   -replace '["\r\n]', '')
    $urlSan   = ($cloudUrl   -replace '["\r\n]', '')
    $modelSan = ($cloudModel -replace '["\r\n]', '')
    if ($DRY) {
        Write-Host "  [dry-run] WOULD: в $cfgY вписать model.provider=custom base_url=$urlSan default=$modelSan api_key=<скрыт>"
    } else {
        $text = ''
        if (Test-Path $cfgY) { $text = [IO.File]::ReadAllText($cfgY, [Text.Encoding]::UTF8) }
        # (1) снять ранее вписанный управляемый блок — идемпотентность
        $text = [regex]::Replace($text, '(?sm)^# >>> nomad-cloud.*?# <<< nomad-cloud <<<\r?\n?', '')
        # (2) снять существующий top-level блок model: (шаблонный provider:auto или прежний custom)
        $text = [regex]::Replace($text, '(?m)^model:[ \t]*\r?\n(?:(?:[ \t].*\r?\n)|(?:[ \t]*\r?\n))*', '')
        # (3) вписать управляемый блок в НАЧАЛО файла
        $nl = "`r`n"
        $block = '# >>> nomad-cloud (managed by installer -- do not edit inside markers) >>>' + $nl +
                 'model:' + $nl +
                 '  provider: "custom"' + $nl +
                 '  base_url: "' + $urlSan + '"' + $nl +
                 '  api_key: "' + $keySan + '"' + $nl +
                 '  default: "' + $modelSan + '"' + $nl +
                 '# <<< nomad-cloud <<<' + $nl
        $text = $block + $text
        # config.yaml — данные: пишем БЕЗ BOM (BOM ломает YAML-парсер).
        [IO.File]::WriteAllText($cfgY, $text, (New-Object Text.UTF8Encoding $false))
        Write-Host "OK: Nomad подключён к облаку $urlSan (модель $modelSan). Ключ записан в config.yaml."
    }
}

if ($DRY) { Write-Host "[dry-run] Nomad preview завершён."; exit 0 }
Update-Path

# P0-4: квитанция владения — ТОЧНЫЕ пути СОЗДАННЫХ артефактов (main соберёт в receipt).
# ВАЖНО: HERMES_HOME\config.yaml НЕ записываем в квитанцию — после установки это
# пользовательский конфиг (ключи/настройки), деинсталлятор его трогать не должен.
# Брендинг попадает в квитанцию ТОЛЬКО если МЫ его создали (чужой файл не присваиваем).
function Write-NomadReceipt {
    # Vendor-only: клона в LOCALAPPDATA\nomad-src больше нет — источник это вшитый vendor
    # (read-only ресурс приложения), его в квитанцию НЕ пишем.
    foreach ($shim in @('nmd.exe', 'nmd', 'nomad-agent.exe', 'nomad-agent', 'nomad-acp.exe', 'nomad-acp')) {
        $p = Join-Path $env:USERPROFILE ".local\bin\$shim"
        if (Test-Path -LiteralPath $p) { Write-Host "HM-RECEIPT path $p" }
    }
    # P1-4: uv-тул называется по pyproject [project].name = nomad-agent.
    foreach ($toolDir in @((Join-Path $env:APPDATA 'uv\tools\nomad-agent'),
                           (Join-Path $env:USERPROFILE '.local\share\uv\tools\nomad-agent'))) {
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

if (Get-Command nmd -ErrorAction SilentlyContinue) {
    Write-NomadReceipt
    Write-Host "OK: Nomad установлен ($((nmd --version 2>&1 | Select-Object -First 1)))"; exit 0
}
if (Test-Path (Join-Path $env:USERPROFILE '.local\bin\nmd.exe')) {
    Write-NomadReceipt
    Write-Host "OK: Nomad в ~/.local/bin — команда nmd появится в PATH после перезапуска терминала."; exit 0
}
Write-Host "ОШИБКА: Nomad не установился — смотри лог выше."
exit 1
