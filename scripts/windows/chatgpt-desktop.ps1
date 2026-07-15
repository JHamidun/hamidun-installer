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
#   1. Резолвим НАСТОЯЩИЙ winget.exe из admin-owned каталога Program Files\WindowsApps\
#      Microsoft.DesktopAppInstaller_* (не из user-writable alias'а).
#   2. ГЕЙТ ПОДПИСИ ДО ЗАПУСКА (fail-closed): Get-AuthenticodeSignature winget.exe →
#      Status Valid И subject содержит 'Microsoft Corporation'. Не Valid / не Microsoft
#      → НЕ запускаем (exit 120 skip). Это наш аналог «проверь подпись перед запуском»:
#      мы верифицируем ИМЕННО тот бинарь, который исполняем; он затем тянет MSIX,
#      подписанный и доставленный Store'ом.
#   3. Ставим: winget install --id 9NT1R1C2HH7J --source msstore --silent (elevated,
#      MSIX MS-signed). Идемпотентность: приложение уже стоит (Get-AppxPackage) → exit 0.
#      Нет winget / нет сети / установка не удалась → exit 120 (graceful skip).
#
#   Авто-удаление НЕ поддерживаем (чужое приложение): компонент только СТАВИТ.
#
# TODO-verify (сеть): прямого OpenAI-hosted .exe для Windows не существует (проверено);
#   Store ID 9NT1R1C2HH7J и путь установки подтверждены публично. Если OpenAI когда-то
#   выложит standalone-инсталлятор — можно добавить download→Authenticode-ветку как в
#   claude-desktop.ps1.
$ErrorActionPreference = 'Stop'

$DRY = [bool]$env:HM_DRY_RUN

$STORE_ID  = '9NT1R1C2HH7J'
$PUBLISHER = 'Microsoft Corporation'   # издатель winget.exe (App Installer)

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

# --- Резолвим НАСТОЯЩИЙ winget.exe (admin-owned WindowsApps), fallback — Get-Command ---
function Resolve-Winget {
    $pf = $env:ProgramFiles
    if ($pf) {
        $base = Join-Path $pf 'WindowsApps'
        if (Test-Path -LiteralPath $base) {
            $hit = Get-ChildItem -Path $base -Filter 'winget.exe' -Recurse -File -ErrorAction SilentlyContinue |
                   Where-Object { $_.FullName -match 'Microsoft\.DesktopAppInstaller_' -and -not ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) } |
                   Sort-Object FullName -Descending | Select-Object -First 1
            if ($hit) { return $hit.FullName }
        }
    }
    $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    return $null
}

if ($DRY) {
    Write-Host "  [dry-run] WOULD: резолвить winget.exe (Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*), Get-AuthenticodeSignature → Status Valid + subject '$PUBLISHER' (ДО запуска, fail-closed), затем winget install --id $STORE_ID --source msstore --silent --accept-package-agreements --accept-source-agreements."
    exit 0
}

$winget = Resolve-Winget
if (-not $winget -or -not (Test-Path -LiteralPath $winget -PathType Leaf)) {
    Write-Host "winget (App Installer из Microsoft Store) не найден — не могу поставить ChatGPT автоматически. Открой Microsoft Store, найди «ChatGPT» и нажми «Установить». Пропускаю (skip)."
    exit 120
}

# --- ГЕЙТ ПОДПИСИ winget.exe ДО ЗАПУСКА (fail-closed) ---
$sig = Get-AuthenticodeSignature -LiteralPath $winget
if (-not $sig -or $sig.Status -ne 'Valid') {
    Write-Host "БЕЗОПАСНОСТЬ: подпись winget.exe не Valid (статус: $($sig.Status)) — НЕ запускаю. Пропускаю ChatGPT (fail-closed)."
    exit 120
}
$subject = ''
if ($sig.SignerCertificate) { $subject = [string]$sig.SignerCertificate.Subject }
if ($subject -notmatch $PUBLISHER) {
    Write-Host "БЕЗОПАСНОСТЬ: winget.exe подписан не Microsoft (subject='$subject') — НЕ запускаю. Пропускаю ChatGPT (fail-closed)."
    exit 120
}
Write-Host "winget.exe проверен (Status=Valid, Microsoft). Ставлю ChatGPT из Microsoft Store..."

# --- Установка из Microsoft Store (MSIX MS-signed) ---
try {
    & $winget install --id $STORE_ID --source msstore --accept-package-agreements --accept-source-agreements --silent 2>&1 |
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
