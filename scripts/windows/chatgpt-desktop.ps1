# ChatGPT Desktop (нативное приложение OpenAI) — Windows. ОПЦИОНАЛЬНЫЙ компонент.
#
# ВАЖНО: у ChatGPT для Windows НЕТ отдельного установщика .exe, размещённого OpenAI —
# приложение распространяется ТОЛЬКО как MSIX-пакет из Microsoft Store (Store ID
# 9NT1R1C2HH7J, подписан Microsoft/OpenAI). Поэтому «скачать exe в secure-cache и
# проверить Authenticode» здесь неприменимо; официальный автоматический способ —
# winget из источника msstore. Целостность и подпись MSIX обеспечивает AppX/MS Store.
#
# Модель угроз (тот же класс, что и остальные elevated-скрипты): установщик работает
# ELEVATED и ЗАПУСКАЕТ бинарь-инструмент (winget). Прямой запуск winget по короткому
# имени / через user-alias под админом исполнил бы то, что medium-integrity малварь
# ТОГО ЖЕ юзера могла подложить на его место (integrity-escalation). Поэтому:
#
#   1. Резолвим НАСТОЯЩИЙ winget.exe СТРОГО из admin-owned пакета
#      Program Files\WindowsApps\Microsoft.DesktopAppInstaller_<ver>_<arch>__8wekyb3d8bbwe\ —
#      имя пакета якорится ПОЛНОСТЬЮ (не подстрока) с пином PublisherId 8wekyb3d8bbwe;
#      winget.exe обязан лежать НЕПОСРЕДСТВЕННО в этом package-каталоге, без reparse-point'ов;
#      среди версий берём НАИБОЛЬШУЮ по [version] (не лексикографически). Fallback на
#      Get-Command УБРАН (user-writable alias — вектор подмены под elevated).
#   2. НАДЁЖНЫЙ ГЕЙТ ПОДПИСИ winget.exe ДО ЗАПУСКА (fail-closed, Test-HmSignerTrusted):
#      Status Valid + цепочка leaf-серта до корня в LocalMachine\Root (НЕ доверяем
#      CurrentUser\Root) + ТОЧНОЕ поле Organization O='Microsoft Corporation' + Code Signing
#      EKU. Не прошло → НЕ запускаем (exit 120 skip). Верифицируем ИМЕННО тот бинарь,
#      который исполняем; он затем тянет MSIX, подписанный и доставленный Store'ом.
#   3. Ставим: winget install --id 9NT1R1C2HH7J --exact --source msstore --silent (elevated,
#      MSIX MS-signed). --exact исключает подмену id по совпадению/моникеру. Идемпотентность:
#      приложение уже стоит (Get-AppxPackage) → exit 0. Нет winget / нет сети / установка не
#      удалась → exit 120 (graceful skip).
#
#   Авто-удаление НЕ поддерживаем (чужое приложение): компонент только СТАВИТ.
#
# Значения, подтверждённые сетью (2026-07): прямого OpenAI-hosted .exe для Windows нет —
#   только MSIX из Microsoft Store; Store product ID 9NT1R1C2HH7J; App Installer =
#   Microsoft.DesktopAppInstaller_..._8wekyb3d8bbwe (PublisherId 8wekyb3d8bbwe — публичный
#   хеш издателя Microsoft для first-party пакетов); winget.exe подписан O='Microsoft
#   Corporation'. Если OpenAI когда-то выложит standalone-инсталлятор — можно добавить
#   download→Test-HmSignerTrusted-ветку как в claude-desktop.ps1.
$ErrorActionPreference = 'Stop'

$DRY = [bool]$env:HM_DRY_RUN

$STORE_ID     = '9NT1R1C2HH7J'
# ТОЧНОЕ поле Organization (O=) в Authenticode-подписи winget.exe (App Installer, MS first-party).
$PUBLISHER_O  = 'Microsoft Corporation'
# PublisherId (публичный хеш издателя Microsoft) — пин в имени пакета App Installer.
$MS_PUBLISHER_ID = '8wekyb3d8bbwe'

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

# --- Идемпотентность: приложение ChatGPT уже установлено? ---
function Test-ChatGptDesktopInstalled {
    try {
        $p = Get-AppxPackage -ErrorAction SilentlyContinue |
             Where-Object { ($_.Name -match 'ChatGPT') -or ($_.Name -match 'OpenAI' -and $_.Name -match 'GPT') } |
             Select-Object -First 1
        if ($p) { return $true }
    } catch { }
    return $false
}

if (Test-ChatGptDesktopInstalled) {
    Write-Host "ChatGPT Desktop уже установлен — пропускаю."
    exit 0
}

# --- Резолвим НАСТОЯЩИЙ winget.exe СТРОГО из admin-owned пакета App Installer ---
# Пин: имя каталога = Microsoft.DesktopAppInstaller_<ver>_<arch>__8wekyb3d8bbwe (ПОЛНЫЙ якорь,
# не подстрока; PublisherId зашит). winget.exe обязан лежать НЕПОСРЕДСТВЕННО в этом каталоге,
# каталог и файл — не reparse-point. Среди версий берём НАИБОЛЬШУЮ по [version]. Fallback на
# Get-Command УБРАН (user-writable alias — вектор подмены под elevated).
function Resolve-Winget {
    $pf = $env:ProgramFiles
    if (-not $pf) { return $null }
    $base = Join-Path $pf 'WindowsApps'
    if (-not (Test-Path -LiteralPath $base)) { return $null }
    $rx = '^Microsoft\.DesktopAppInstaller_(?<ver>[0-9][0-9.]*)_(x64|arm64|x86|neutral)__' + [regex]::Escape($MS_PUBLISHER_ID) + '$'
    $cands = @()
    Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $dir = $_
        if ($dir.Name -match $rx) {
            $ver = $Matches['ver']
            if ($dir.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return }  # анти junction на чужой путь
            $exe = Join-Path $dir.FullName 'winget.exe'
            if (Test-Path -LiteralPath $exe -PathType Leaf) {
                $fi = Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue
                if ($fi -and -not ($fi.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
                    [string]::Equals($fi.DirectoryName, $dir.FullName, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $v = $null; try { $v = [version]$ver } catch { $v = [version]'0.0' }
                    $cands += [pscustomobject]@{ Ver = $v; Path = $fi.FullName }
                }
            }
        }
    }
    if ($cands.Count -eq 0) { return $null }
    return ($cands | Sort-Object Ver -Descending | Select-Object -First 1).Path
}

if ($DRY) {
    Write-Host "  [dry-run] WOULD: резолвить winget.exe СТРОГО из Microsoft.DesktopAppInstaller_..._$MS_PUBLISHER_ID (PublisherId-пин, без Get-Command fallback), Test-HmSignerTrusted → Status Valid + цепочка к LocalMachine\Root + O='$PUBLISHER_O' + Code Signing EKU (ДО запуска, fail-closed), затем winget install --id $STORE_ID --exact --source msstore --silent --accept-package-agreements --accept-source-agreements."
    exit 0
}

$winget = Resolve-Winget
if (-not $winget -or -not (Test-Path -LiteralPath $winget -PathType Leaf)) {
    Write-Host "winget (App Installer из Microsoft Store) не найден — не могу поставить ChatGPT автоматически. Открой Microsoft Store, найди «ChatGPT» и нажми «Установить». Пропускаю (skip)."
    exit 120
}

# --- НАДЁЖНЫЙ ГЕЙТ ПОДПИСИ winget.exe ДО ЗАПУСКА (fail-closed) ---
$why = Test-HmSignerTrusted -Path $winget -ExpectedOrg $PUBLISHER_O
if ($why) {
    Write-Host "БЕЗОПАСНОСТЬ: winget.exe не прошёл надёжную проверку подписи ($why) — НЕ запускаю. Пропускаю ChatGPT (fail-closed)."
    exit 120
}
Write-Host "winget.exe проверен: цепочка к машинному корню + O='$PUBLISHER_O' + Code Signing EKU. Ставлю ChatGPT из Microsoft Store..."

# --- Установка из Microsoft Store (MSIX MS-signed) ---
try {
    & $winget install --id $STORE_ID --exact --source msstore --accept-package-agreements --accept-source-agreements --silent 2>&1 |
        ForEach-Object { Write-Host $_ }
    $code = $LASTEXITCODE
} catch {
    Write-Host "Не удалось запустить winget ($($_.Exception.Message)) — пропускаю ChatGPT. Поставь вручную из Microsoft Store."
    exit 120
}

# Аттестация: приложение реально появилось (не полагаемся только на exit-код winget).
$installed = $false
for ($i = 0; $i -lt 30; $i++) {
    if (Test-ChatGptDesktopInstalled) { $installed = $true; break }
    Start-Sleep -Seconds 1
}
if ($installed) {
    Write-Host "OK: ChatGPT Desktop установлен из Microsoft Store."
    exit 0
}

Write-Host "winget завершился с кодом $code, но приложение ChatGPT не подтвердилось. Возможно, нужна авторизация в Microsoft Store — открой Store, найди «ChatGPT» и нажми «Установить». Пропускаю (skip)."
exit 120
