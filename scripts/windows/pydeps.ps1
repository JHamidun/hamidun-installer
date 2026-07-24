# Python packages for config tools — Windows
# Continue (не Stop): нативные команды (python/pip) пишут в stderr → под Stop = NativeCommandError и падение.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
. (Join-Path $PSScriptRoot '_deelev.ps1')  # New-HmSecureStagingDir (Admins-only кэш для онлайн-фолбэка Python)
function Update-Path {
    # SECURITY (#4): PATH для elevated-скрипта — ТОЛЬКО HKLM (Machine) + наши
    # админ-owned фиксированные каталоги. НИКОГДА не читаем HKCU (User) PATH: на чистой
    # машине medium-integrity процесс того же юзера может дописать туда каталог с
    # подложенным git/node/python/winget и исполнить его под нашим elevated-токеном.
    # Инструменты в user-профиле (python/cursor/claude/uv) находим по абсолютным путям.
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
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}
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
        if ($DRY) { Write-Host "  [dry-run] WOULD: winget install -e --id Python.Python.3.12 --silent" }
        else { Write-Host "Устанавливаю Python 3.12 через winget..."; winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements; Update-Path; $py = Get-Py }
    }
    # Онлайн-фолбэк python.org (как в git.ps1). winget-ветка выше недостижима по построению:
    # Update-Path (SECURITY #4) собирает PATH только из Machine + фиксированных каталогов, а
    # winget живёт в user-writable %LOCALAPPDATA%\Microsoft\WindowsApps — Get-Command его не видит.
    # Качаем НЕ в user-writable %TEMP%, а в ADMIN-OWNED SECURE-CACHE (New-HmSecureStagingDir,
    # тот же примитив, что claude-desktop.ps1): мы elevated, файл в %TEMP% процесс того же юзера
    # мог бы подменить между скачиванием и запуском. Версия пришита к ABI вшитых колёс
    # (pywheels = cp312 / win_amd64; tools/fetch-vendor.ps1 -> 3.12.10).
    if (-not $py) {
        $pyVer = '3.12.10'
        $pyUrl = "https://www.python.org/ftp/python/$pyVer/python-$pyVer-amd64.exe"
        if ($DRY) {
            if (-not ($pyInst -and (Test-Path $pyInst))) { Write-Host "  [dry-run] WOULD: скачать $pyUrl в secure-cache, проверить подпись PSF и запустить /quiet InstallAllUsers=0 PrependPath=1" }
        } else {
            Write-Host "Python не установился из встроенных компонентов — качаю $pyVer с python.org напрямую..."
            $sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
            $icacls   = Join-Path (Join-Path $sysRoot 'System32') 'icacls.exe'
            $progData = Join-Path ([System.IO.Path]::GetPathRoot($sysRoot)) 'ProgramData'
            $cache = $null
            if ((Test-Path -LiteralPath $icacls) -and (Test-Path -LiteralPath $progData)) {
                $cache = New-HmSecureStagingDir -ProgramData $progData -Icacls $icacls -Elevated $true
            }
            if ($cache -and (Test-Path -LiteralPath $cache)) {
                $pyDl = Join-Path $cache "python-$pyVer-amd64.exe"
                try {
                    $ProgressPreference = 'SilentlyContinue'
                    Invoke-WebRequest -Uri $pyUrl -OutFile $pyDl -UseBasicParsing -TimeoutSec 600
                } catch { Write-Host "  Не удалось скачать Python с python.org (нет сети?): $($_.Exception.Message)" }
                if (Test-Path -LiteralPath $pyDl) {
                    # Гейт подписи ДО запуска (fail-closed) — зеркало пина PSF Team ID в macos/pydeps.sh:
                    # elevated-запуск неподтверждённого exe недопустим даже из secure-cache.
                    # Одного Status='Valid' МАЛО: цепочку строит ПОЛЬЗОВАТЕЛЬСКИЙ chain-engine, и
                    # корень из HKCU\...\SystemCertificates\Root (пишется medium-малварью того же
                    # юзера БЕЗ UAC) тоже дал бы 'Valid'. Требуем корень в LocalMachine\Root + EKU
                    # Code Signing (Test-HmTrustedSigner), СОХРАНЯЯ прежний пин издателя PSF.
                    $why = Test-HmTrustedSigner -Path $pyDl -ExpectedSubjectMatch 'Python Software Foundation'
                    if (-not $why) {
                        Start-Process -FilePath $pyDl -ArgumentList '/quiet','InstallAllUsers=0','PrependPath=1' -WorkingDirectory $cache -Wait
                        Update-Path; $py = Get-Py
                    } else {
                        Write-Host "  БЕЗОПАСНОСТЬ: подпись установщика python.org не подтвердилась ($why) — НЕ запускаю (fail-closed)."
                    }
                }
                # Чистим Admins-only кэш (установщик уже отработал; больше не нужен). Best-effort.
                try { Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue } catch { }
            } else {
                Write-Host "  Не удалось создать защищённый кэш для скачивания — пропускаю онлайн-фолбэк Python."
            }
        }
    }
}
if ($DRY -and -not $py) { Write-Host "[dry-run] Python: install-ветка выбрана, без изменений."; exit 0 }
if (-not $py) { Write-Host "Python не найден и не установился — пропускаю зависимости."; exit 1 }

# Список пакетов ищем в НЕСКОЛЬКИХ местах. В лёгком (lite) издании pydeps — remote-компонент,
# и HM_BUNDLED_CONFIG указывает на staging САМОГО pydeps, где config-pack нет (он приезжает в
# staging компонента config) — из-за этого шаг падал ВСЕГДА. Порядок кандидатов: сначала
# admin-owned источники (staging/вшитый vendor), и только потом легаси user-writable клон конфига.
$reqCands = New-Object System.Collections.Generic.List[string]
if ($env:HM_BUNDLED_CONFIG) { $reqCands.Add((Join-Path $env:HM_BUNDLED_CONFIG 'requirements.txt')) }
if ($env:HM_VENDOR)         { $reqCands.Add((Join-Path $env:HM_VENDOR 'config-pack\requirements.txt')) }
if ($env:HM_VENDOR_BUNDLED) { $reqCands.Add((Join-Path $env:HM_VENDOR_BUNDLED 'config-pack\requirements.txt')) }
# Вшитый vendor рядом со скриптами (<resources>\scripts\windows -> <resources>\vendor):
# в упакованном приложении это Program Files (admin-owned), в lite там лежит vendor-lite.
try {
    $bundledVendorGuess = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'vendor'
    $reqCands.Add((Join-Path $bundledVendorGuess 'config-pack\requirements.txt'))
} catch { }
# Легаси: клон конфига с GitHub (user-writable — поэтому ПОСЛЕДНИЙ, не основной источник).
$reqCands.Add((Join-Path $env:USERPROFILE '.hamidun-setup\config-repo\requirements.txt'))
$req = ''
foreach ($cand in $reqCands) {
    if ($cand -and (Test-Path -LiteralPath $cand -PathType Leaf)) { $req = $cand; break }
}
if (-not $req) {
    # Списка пакетов нет НЕ по вине пользователя (он не входит в эту сборку/редакцию) — это наша
    # ошибка упаковки. Красный крест здесь вводит в заблуждение: Python уже установлен и работает.
    # Честный graceful skip (120): main не пишет маркер установки, пользователь видит «пропущено».
    Write-Host "Список Python-пакетов (requirements.txt) не входит в эту сборку — пропускаю установку библиотек."
    Write-Host "  Проверенные пути: $($reqCands -join '; ')"
    Write-Host "  Python установлен и работает; библиотеки можно доставить позже, повторив этот компонент в обновлённой сборке."
    exit 120
}

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
    if ($LASTEXITCODE -ne 0) {
        # Провал офлайн-ветки (часть колёс могла не вшиться под эту версию/архитектуру) —
        # НЕ жёсткий exit 1, а честный онлайн-фолбэк, как в macos/pydeps.sh: --find-links
        # оставляем, чтобы вшитые колёса всё равно использовались, сеть докачивает только дыры.
        Write-Host "  ВНИМАНИЕ: офлайн-установка из встроенных wheels не удалась — докачиваю недостающее из PyPI (онлайн)..."
        & $py -m pip install --user --upgrade pip 2>&1 | Out-Null
        & $py -m pip install --user --find-links $wheels -r $req
    }
} else {
    & $py -m pip install --user --upgrade pip 2>&1 | Out-Null
    Write-Host "Ставлю библиотеки из PyPI (онлайн)..."
    & $py -m pip install --user -r $req
}
if ($LASTEXITCODE -ne 0) { Write-Host "Часть библиотек не установилась — смотри лог."; exit 1 }

$pwb = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'playwright-browsers' } else { '' }
$pwWarn = $false
if ($pwb -and (Test-Path $pwb)) {
    Write-Host "Ставлю встроенные браузеры Playwright (офлайн)..."
    $dst = Join-Path $env:LOCALAPPDATA 'ms-playwright'
    New-Item -ItemType Directory -Force $dst | Out-Null
    Copy-Item -Recurse -Force (Join-Path $pwb '*') $dst -ErrorAction SilentlyContinue
} else {
    # Онлайн-докачка браузеров (~150 МБ, самый хрупкий по сети шаг). Раньше вывод глотался
    # Out-Null, а код возврата не проверялся — сбой давал ложный OK, и браузерные скиллы
    # потом падали без следа (зеркало macos/pydeps.sh). Стримим прогресс и честно предупреждаем.
    Write-Host "Ставлю браузер для Playwright (best-effort)..."
    & $py -m playwright install chromium
    if ($LASTEXITCODE -ne 0) {
        $pwWarn = $true
        Write-Host "  ВНИМАНИЕ: браузеры Playwright не скачались (проверь сеть и повтори установку этого компонента). Остальные Python-зависимости на месте."
    }
}

if ($pwWarn) { Write-Host "Python-зависимости установлены, но браузеры Playwright — нет (повтори установку этого компонента)." }
else { Write-Host "OK: Python-зависимости установлены." }
exit 0
