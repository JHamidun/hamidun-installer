# Claude Desktop (нативное приложение Anthropic) — Windows. ОПЦИОНАЛЬНЫЙ компонент.
#
# Модель угроз (тот же класс, что и remote-fetch/uv): установщик работает ELEVATED
# (requireAdministrator) и ЗАПУСКАЕТ скачанный из сети установщик. Скачивание+запуск
# ЧУЖОГО бинаря под админом = privesc-поверхность. Инвариант — НЕ запускать
# НЕпроверенный бинарь и НЕ дать medium-integrity малвари ТОГО ЖЕ юзера подменить
# файл между «скачал» и «запустил» (TOCTOU). Поэтому:
#
#   1. СКАЧИВАЕМ официальный установщик Anthropic по HTTPS в ADMIN-OWNED SECURE-CACHE —
#      свежий random-leaf каталог под %ProgramData%, рождённый АТОМАРНО с owner=
#      Administrators + DACL {SYSTEM, Administrators: FullControl}, protection on, БЕЗ
#      user-SID (тот же укреплённый примитив New-HmSecureStagingDir из _deelev.ps1, что
#      запирает de-elevation staging и кэш докачки в main.js). Users писать туда НЕ
#      могут ПО КОНСТРУКЦИИ → medium-малварь не может ни пред-создать файл, ни держать
#      write-handle, ни подменить его до/после проверки подписи (ZIP/EXE-TOCTOU закрыт).
#      Это НЕ user-writable %TEMP%.
#
#   2. ГЛАВНЫЙ ГЕЙТ ЦЕЛОСТНОСТИ — Authenticode-подпись ДО запуска (вместо SHA-пиннинга:
#      версии десктопа меняются, зашитый sha устарел бы). Get-AuthenticodeSignature →
#      Status обязан быть Valid (криптоцепочка к доверенному корню + файл не подменён)
#      И signer-subject обязан содержать издателя Anthropic. Не Valid / не тот
#      издатель → fail-closed (exit 120 skip, НЕ запускаем).
#
#   3. ЗАПУСК из ЗАЩИЩЁННОГО КЭША (RUN-FROM-PROTECTED, как uv.ps1). Каталог Admins-only
#      → medium-малварь не подменила бинарь; подпись Anthropic проверена → бинарь
#      ДОВЕРЕН. Запуск идёт elevated: де-элевированный запуск ИЗ Admins-only каталога
#      непрактичен (medium-токен не имеет доступа на чтение к Admins-only DACL), а
#      ослаблять укреплённый примитив (добавлять user-ACE) означало бы вернуть тот
#      самый user-writable staging, от которого мы защищались. CWD = защищённый кэш
#      (анти DLL-planting из рабочего каталога). Установщик Claude Desktop — per-user
#      Squirrel: при обычном админе %LOCALAPPDATA% указывает на его профиль. Остаточный
#      риск (доверенный установщик может распаковать бутстрап в user %TEMP% и запустить
#      оттуда) — тот же осознанно принятый вектор, что описан в THREAT-MODEL.md.
#
#   4. Идемпотентность: приложение уже стоит (детект пути) → ничего не делаем, exit 0.
#      Нет сети / скачивание не удалось / подпись не прошла → exit 120 (graceful skip,
#      НЕ красная ошибка). Секьюр-кэш чистим в finally.
#
#   Авто-удаление НЕ поддерживаем (чужое приложение): компонент только СТАВИТ; кнопка
#   «Удалить» для него в UI не показывается (не в REMOVABLE).
#
# TODO-verify (сеть): официальный redirect-URL подтверждён (claude.ai/api/desktop →
#   downloads.claude.ai/.../ClaudeSetup-*.exe); точный CN Authenticode-издателя пиним
#   подстрокой «Anthropic» — при желании ужесточить до полного CN после проверки на
#   реальном бинаре.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_deelev.ps1')  # New-HmSecureStagingDir (атомарный Admins-only каталог)

$DRY = [bool]$env:HM_DRY_RUN

# --- Официальные endpoint'ы Anthropic (HTTPS, редиректят на downloads.claude.ai) ---
$URL_X64   = 'https://claude.ai/api/desktop/win32/x64/setup/latest/redirect'
$URL_ARM64 = 'https://claude.ai/api/desktop/win32/arm64/setup/latest/redirect'
# Издатель, которого ОБЯЗАНА содержать Authenticode-подпись (иначе fail-closed).
$PUBLISHER = 'Anthropic'

# --- Идемпотентность: уже установлен? (Win32 Squirrel ИЛИ MSIX/Store) ---
function Test-ClaudeDesktopInstalled {
    $la = $env:LOCALAPPDATA
    if ($la) {
        $cands = @(
            (Join-Path $la 'AnthropicClaude\claude.exe'),
            (Join-Path $la 'Microsoft\WindowsApps\claude.exe')
        )
        foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { return $true } }
        $appDir = Join-Path $la 'AnthropicClaude'
        if (Test-Path -LiteralPath $appDir) {
            $hit = Get-ChildItem -Path $appDir -Filter 'claude.exe' -Recurse -File -ErrorAction SilentlyContinue |
                   Select-Object -First 1
            if ($hit) { return $true }
        }
    }
    # MSIX/Store-вариант Claude Desktop.
    try {
        if (Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'Claude' -and $_.Publisher -match 'Anthropic' } | Select-Object -First 1) { return $true }
    } catch { }
    return $false
}

if (Test-ClaudeDesktopInstalled) {
    Write-Host "Claude Desktop уже установлен — пропускаю (ничего не скачиваю)."
    exit 0
}

# Выбираем сборку под архитектуру.
$arch = "$env:PROCESSOR_ARCHITECTURE"
$url = if ($arch -match 'ARM64') { $URL_ARM64 } else { $URL_X64 }

if ($DRY) {
    Write-Host "  [dry-run] WOULD: New-HmSecureStagingDir (Admins-only %ProgramData%\HmDeElev-*), скачать $url в него по HTTPS, Get-AuthenticodeSignature → Status Valid + subject содержит '$PUBLISHER' (ДО запуска, fail-closed), запустить проверенный установщик ИЗ защищённого кэша, дождаться claude.exe, почистить кэш."
    exit 0
}

# --- 1. ADMIN-OWNED SECURE-CACHE (тот же атомарный примитив, что и de-elevation) ---
$sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
$s32      = Join-Path $sysRoot 'System32'
$icacls   = Join-Path $s32 'icacls.exe'
$pdRoot   = [System.IO.Path]::GetPathRoot($sysRoot)
$progData = Join-Path $pdRoot 'ProgramData'
if (-not (Test-Path -LiteralPath $icacls) -or -not (Test-Path -LiteralPath $progData)) {
    Write-Host "Не найдены системные пути (icacls/ProgramData) — пропускаю Claude Desktop (поставь вручную с claude.com/download)."
    exit 120
}

$cache = New-HmSecureStagingDir -ProgramData $progData -Icacls $icacls -Elevated $true
if (-not $cache -or -not (Test-Path -LiteralPath $cache)) {
    Write-Host "Не удалось создать защищённый кэш (owner=Administrators + DACL {SYSTEM,Administrators}) — нужны права администратора. Пропускаю Claude Desktop (fail-closed)."
    exit 120
}

$installer = Join-Path $cache 'ClaudeSetup.exe'
$rc = 120
try {
    # --- 2. СКАЧИВАНИЕ по HTTPS в Admins-only кэш ---
    Write-Host "Скачиваю официальный установщик Claude Desktop (Anthropic) в защищённый кэш..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
    if ($url -notmatch '^https://') { Write-Host "URL не HTTPS — отказ (fail-closed)."; exit 120 }
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 600
    } catch {
        Write-Host "Не удалось скачать установщик Claude Desktop (нет сети?) — пропускаю. Всё остальное работает; поставь позже с claude.com/download. ($($_.Exception.Message))"
        exit 120
    }
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        Write-Host "Установщик не появился после скачивания — пропускаю Claude Desktop."
        exit 120
    }
    # Санити размера: слишком мал = страница ошибки; аномально велик = отвергаем.
    $len = (Get-Item -LiteralPath $installer).Length
    if ($len -lt 20MB -or $len -gt 900MB) {
        Write-Host "Скачанный файл имеет неожиданный размер ($([math]::Round($len/1MB)) МБ) — пропускаю Claude Desktop (fail-closed)."
        exit 120
    }

    # --- 3. ГЕЙТ ПОДПИСИ ДО ЗАПУСКА (fail-closed) ---
    $sig = Get-AuthenticodeSignature -LiteralPath $installer
    if (-not $sig -or $sig.Status -ne 'Valid') {
        Write-Host "БЕЗОПАСНОСТЬ: Authenticode-подпись установщика не Valid (статус: $($sig.Status)) — НЕ запускаю. Пропускаю Claude Desktop (fail-closed)."
        exit 120
    }
    $subject = ''
    if ($sig.SignerCertificate) { $subject = [string]$sig.SignerCertificate.Subject }
    if ($subject -notmatch $PUBLISHER) {
        Write-Host "БЕЗОПАСНОСТЬ: установщик подписан НЕ ожидаемым издателем (subject='$subject', ожидался '$PUBLISHER') — НЕ запускаю. Пропускаю Claude Desktop (fail-closed)."
        exit 120
    }
    Write-Host "Подпись подтверждена: Status=Valid, издатель содержит '$PUBLISHER'. Запускаю проверенный установщик из защищённого кэша..."

    # --- 4. ЗАПУСК проверенного установщика ИЗ ЗАЩИЩЁННОГО КЭША (CWD = кэш, анти DLL-planting) ---
    try {
        Start-Process -FilePath $installer -WorkingDirectory $cache -Wait -ErrorAction Stop
    } catch {
        Write-Host "Установщик Claude Desktop не запустился ($($_.Exception.Message)) — пропускаю."
        exit 120
    }

    # Ждём появления приложения (Squirrel докручивает установку асинхронно).
    $installed = $false
    for ($i = 0; $i -lt 90; $i++) {
        if (Test-ClaudeDesktopInstalled) { $installed = $true; break }
        Start-Sleep -Seconds 1
    }
    if ($installed) {
        Write-Host "OK: Claude Desktop установлен."
        # Квитанция владения (для справки; авто-удаление чужого приложения НЕ делаем).
        $appDir = Join-Path $env:LOCALAPPDATA 'AnthropicClaude'
        if (Test-Path -LiteralPath $appDir) { Write-Host "HM-RECEIPT path $appDir" }
        $rc = 0
    } else {
        Write-Host "Установщик Claude Desktop отработал, но приложение не подтвердилось за 90 с — возможно, оно ещё докручивает установку. Проверь меню «Пуск»; при необходимости поставь заново с claude.com/download."
        $rc = 120
    }
} finally {
    # Чистим Admins-only кэш (установщик уже отработал; больше не нужен). Best-effort.
    if ($cache) { try { Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue } catch { } }
}
exit $rc
