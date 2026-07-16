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
#      версии десктопа меняются, зашитый sha устарел бы). НАДЁЖНАЯ проверка
#      (Test-HmSignerTrusted, см. ниже):
#      (a) Get-AuthenticodeSignature Status=Valid — хеш файла не подменён (файл целостен);
#      (b) цепочка leaf-серта строится, и её КОРЕНЬ обязан лежать в МАШИННОМ доверенном
#          сторе (LocalMachine\Root). CurrentUser\Root НЕ доверяем: medium-integrity малварь
#          ТОГО ЖЕ юзера может отравить его своим самоподписанным корнем БЕЗ прав админа
#          (в machine-стор без админа не записать) → закрываем spoofing через user-cert-store;
#      (c) поле Organization (O=) leaf-серта ТОЧНО равно 'Anthropic, PBC' (парсим RDN, а НЕ
#          подстрока по всему Subject: 'CN=Evil,OU=Anthropic' НЕ пройдёт);
#      (d) EKU включает Code Signing. Публичный CA не выпишет злоумышленнику серт с
#          O='Anthropic, PBC' → обход закрыт даже без секретного thumbprint'а (опц. пин ниже).
#      Любой невыполненный вентиль → fail-closed (exit 120 skip, НЕ запускаем).
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
# Значения, подтверждённые сетью (2026-07): Windows-бинари Anthropic подписаны с Subject
#   Organization O='Anthropic, PBC'; официальный redirect claude.ai/api/desktop/win32/... →
#   downloads.claude.ai/.../ClaudeSetup-*.exe.
# TODO-verify (опц. усиление, НЕ обязательно): $LEAF_THUMBPRINT — SHA1-отпечаток leaf-серта
#   Anthropic. По умолчанию ПУСТО (пин выключен): основной контроль — цепочка-к-машинному-
#   корню + точное O= + Code Signing EKU, он fail-closed и без thumbprint'а. Владелец МОЖЕТ
#   снять отпечаток с реального ClaudeSetup.exe:
#     (Get-AuthenticodeSignature .\ClaudeSetup.exe).SignerCertificate.Thumbprint
#   и вписать сюда для доп. пиннинга. Пустое значение НЕ ослабляет fail-closed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_deelev.ps1')  # New-HmSecureStagingDir (атомарный Admins-only каталог)

$DRY = [bool]$env:HM_DRY_RUN

# --- Официальные endpoint'ы Anthropic (HTTPS, редиректят на downloads.claude.ai) ---
$URL_X64   = 'https://claude.ai/api/desktop/win32/x64/setup/latest/redirect'
$URL_ARM64 = 'https://claude.ai/api/desktop/win32/arm64/setup/latest/redirect'
# ТОЧНОЕ поле Organization (O=) в Subject Authenticode-подписи Anthropic (гейт целостности; network-confirmed).
$PUBLISHER_O = 'Anthropic, PBC'
# Опциональный пин SHA1-отпечатка leaf-серта (по умолчанию выкл; см. TODO-verify выше).
$LEAF_THUMBPRINT = ''

# --- НАДЁЖНАЯ проверка Authenticode: цепочка-к-машинному-корню + точное O= + Code Signing EKU ---
# Возвращает '' если бинарь ДОВЕРЕН, иначе строку-причину отказа (у вызывающего → fail-closed).
# Ключевая идея: НЕ полагаемся на подстроку по Subject и НЕ доверяем CurrentUser-корням —
# требуем проверяемую криптоцепочку до корня в МАШИННОМ сторе + точное поле Organization.
function Test-HmSignerTrusted {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedOrg,
        [string]$PinnedThumbprint = ''
    )
    # (a) Authenticode: подпись присутствует И хеш файла не подменён (иначе Status != Valid).
    $sig = Get-AuthenticodeSignature -LiteralPath $Path
    if (-not $sig) { return 'подпись не читается' }
    if ($sig.Status -ne 'Valid') { return "Authenticode Status=$($sig.Status) (хеш подменён или цепочка недоверенна)" }
    $cert = $sig.SignerCertificate
    if (-not $cert) { return 'нет сертификата подписанта' }
    # (b) Строим цепочку и ТРЕБУЕМ корень в LocalMachine\Root (машинный стор). CurrentUser\Root
    #     НЕ доверяем: medium-малварь ТОГО ЖЕ юзера отравляет его без прав администратора.
    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck  # отзыв уже проверен WinVerifyTrust при Status=Valid
    $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
    [void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))  # требуем EKU Code Signing
    $built = $false
    try { $built = $chain.Build($cert) } catch { return "не удалось построить цепочку: $($_.Exception.Message)" }
    if (-not $built) {
        $st = ($chain.ChainStatus | ForEach-Object { $_.Status }) -join ','
        return "цепочка сертификатов не выстроилась ($st)"
    }
    $elems = $chain.ChainElements
    if (-not $elems -or $elems.Count -lt 1) { return 'пустая цепочка сертификатов' }
    $root = $elems[$elems.Count - 1].Certificate
    if (-not $root -or -not $root.Thumbprint) { return 'не удалось определить корень цепочки' }
    $inMachine = $false
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store([System.Security.Cryptography.X509Certificates.StoreName]::Root, [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        foreach ($c in $store.Certificates) { if ($c.Thumbprint -eq $root.Thumbprint) { $inMachine = $true; break } }
    } catch { return "не удалось открыть машинный стор корней: $($_.Exception.Message)" }
    finally { try { $store.Close() } catch { } }
    if (-not $inMachine) { return "корень цепочки НЕ в LocalMachine\Root (возможно отравление CurrentUser\Root): $($root.Subject)" }
    # (c) Organization (O=) leaf-серта ТОЧНО равно ожидаемому (парсим RDN, не подстрока Subject).
    $org = ''
    try {
        foreach ($ln in ($cert.SubjectName.Format($true) -split '\r?\n')) {
            if ($ln -match '^\s*O=') { $org = ($ln -replace '^\s*O=', '').Trim(); break }
        }
    } catch { }
    if ($org -ne $ExpectedOrg) { return "Organization подписи ('$org') != ожидаемого ('$ExpectedOrg')" }
    # (d) EKU включает Code Signing (1.3.6.1.5.5.7.3.3).
    $hasCodeSigning = $false
    foreach ($ext in $cert.Extensions) {
        if ($ext -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
            foreach ($oid in $ext.EnhancedKeyUsages) { if ($oid.Value -eq '1.3.6.1.5.5.7.3.3') { $hasCodeSigning = $true; break } }
        }
    }
    if (-not $hasCodeSigning) { return 'у сертификата нет EKU Code Signing' }
    # (e) Опциональный пин отпечатка leaf-серта (усиление; по умолчанию выключено).
    if ($PinnedThumbprint -and $PinnedThumbprint.Trim()) {
        $want = ($PinnedThumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
        if ($cert.Thumbprint.ToUpperInvariant() -ne $want) { return 'отпечаток leaf-серта не совпал с пиннингом' }
    }
    return ''
}

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
    Write-Host "  [dry-run] WOULD: New-HmSecureStagingDir (Admins-only %ProgramData%\HmDeElev-*), скачать $url в него по HTTPS, Test-HmSignerTrusted → Status Valid + цепочка к LocalMachine\Root + O='$PUBLISHER_O' + Code Signing EKU (ДО запуска, fail-closed), запустить проверенный установщик ИЗ защищённого кэша, дождаться claude.exe, почистить кэш."
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

    # --- 3. НАДЁЖНЫЙ ГЕЙТ ПОДПИСИ ДО ЗАПУСКА (fail-closed) ---
    #     Проверяем ТОТ ЖЕ $installer, который сейчас запустим (без ре-резолва пути).
    $why = Test-HmSignerTrusted -Path $installer -ExpectedOrg $PUBLISHER_O -PinnedThumbprint $LEAF_THUMBPRINT
    if ($why) {
        Write-Host "БЕЗОПАСНОСТЬ: установщик не прошёл надёжную проверку подписи ($why) — НЕ запускаю. Пропускаю Claude Desktop (fail-closed)."
        exit 120
    }
    Write-Host "Подпись подтверждена: цепочка к машинному корню + O='$PUBLISHER_O' + Code Signing EKU. Запускаю проверенный установщик из защищённого кэша..."

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
