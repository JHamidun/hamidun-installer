# uv — быстрый менеджер Python (Astral). ВШИТЫЙ компонент (100% офлайн, BUNDLED-ONLY):
# бинарь едет внутри установщика (vendor/apps/uv — кладёт tools/fetch-vendor.ps1 из
# GitHub releases astral-sh/uv) и проверяется fail-closed по SHA-256 против
# vendor/checksums.json (Confirm-HmArtifact). Сеть при установке НЕ нужна.
#
# БЕЗОПАСНОСТЬ (P1-A): легаси-фолбэк на HM_REMOTE_CACHE УБРАН полностью — он позволял
# запустить НЕпроверенный uv из унаследованного окружения. Единственный источник uv =
# $HM_VENDOR/apps/uv с fail-closed SHA. Нет vendor → graceful skip (exit 120), НЕ фолбэк.
#
# БЕЗОПАСНОСТЬ (FIX-D/FIX-G): проверку версии делаем ЗАПУСКОМ ИЗ ЗАЩИЩЁННОГО
# ИСТОЧНИКА (vendor после SHA-проверки), затем копируем в %LOCALAPPDATA%\Programs\uv
# для PATH пользователя, но копию под elevated-токеном НЕ запускаем (это была бы
# TOCTOU-гонка: medium-integrity процесс юзера мог бы подменить exe между copy и run).
# Успех — ТОЛЬКО при exit-коде 0 И валидном формате вывода `uv --version`. Honor HM_DRY_RUN.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
. (Join-Path $PSScriptRoot '_linksafe.ps1')  # Find-HmLinkOnPath / Write-HmUserFile: копия uv ложится без хода по ссылке
$DRY = [bool]$env:HM_DRY_RUN

# P1-8: dry-run ветвится ДО проверки vendor — никаких обращений к диску.
if ($DRY) {
    Write-Host "  [dry-run] WOULD: проверить SHA-256 вшитого uv (vendor\apps\uv), проверить запуском ИЗ ЗАЩИЩЁННОГО источника, скопировать в %LOCALAPPDATA%\Programs\uv, добавить в PATH (копию НЕ запускать)"
    exit 0
}

# 0) Источник бинарей — ТОЛЬКО вшитый vendor (bundled-only). Reparse-point
#    (симлинк/junction) в роли источника отвергаем. Нет vendor → graceful skip.
$vendorUv = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\uv\uv.exe' } else { '' }
if (-not ($vendorUv -and (Test-Path -LiteralPath $vendorUv -PathType Leaf))) {
    Write-Host "uv не вошёл в эту сборку (нет vendor\apps\uv\uv.exe) — пропускаю. Всё остальное работает без него."
    exit 120
}
$vit = Get-Item -LiteralPath $vendorUv -Force
if ($vit.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    Write-Host "ОШИБКА: вшитый uv.exe — reparse-point (отклонено)."
    exit 1
}
Write-Host "Ставлю uv из встроенного пакета (офлайн, без обращений к сети)..."
# Целостность вшитых бинарей — fail-closed (при несовпадении SHA-256 exit 1 сам)
Confirm-HmArtifact $vendorUv
$srcUv = $vendorUv
$srcUvxPath = ''
$vendorUvx = Join-Path $env:HM_VENDOR 'apps\uv\uvx.exe'
if (Test-Path -LiteralPath $vendorUvx -PathType Leaf) {
    $vxi = Get-Item -LiteralPath $vendorUvx -Force
    if (-not ($vxi.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        Confirm-HmArtifact $vendorUvx
        $srcUvxPath = $vendorUvx
    }
}

$dest = Join-Path $env:LOCALAPPDATA 'Programs\uv'

# 1) ПРОВЕРКА ЗАПУСКОМ ИЗ ЗАЩИЩЁННОГО ИСТОЧНИКА (vendor после SHA-проверки),
#    НЕ из user-writable места. Требуем exit 0 И вывод формата 'uv <версия>'
#    (не просто подстроку 'uv').
$ver = ''
try { $ver = (& $srcUv --version 2>&1 | Select-Object -First 1) }
catch {
    Write-Host "ОШИБКА: uv.exe из источника не запустился — $($_.Exception.Message)"
    exit 1
}
if ($LASTEXITCODE -ne 0 -or ("$ver" -notmatch '^uv\s+\d')) {
    Write-Host "ОШИБКА: uv --version дал некорректный результат (код=$LASTEXITCODE, вывод=$ver)."
    exit 1
}

# 2) Копируем ПРОВЕРЕННЫЙ бинарь в пользовательский каталог (для PATH). Копию
#    под elevated-токеном НЕ запускаем.
# #7 (best-effort): $dest под user-controlled %LOCALAPPDATA% — junction/symlink там
#    может увести New-Item/Copy-Item в чужой каталог. Родитель (Programs) — reparse
#    → отказ (не пишем в перенаправленный путь). leaf (uv) — reparse → убираем ССЫЛКУ
#    (.Delete(), НЕ Remove-Item -Recurse, чтобы не стереть содержимое цели) и создаём
#    каталог заново. Цель всё равно не исполняется elevated — это доп. защита.
function Test-HmReparse([string]$p) {
    try { $it = Get-Item -LiteralPath $p -Force -ErrorAction Stop; return [bool]($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) }
    catch { return $false }
}
$destParent = Split-Path -Parent $dest
# Проверка родителя — по ВСЕЙ цепочке от профиля (Find-HmLinkOnPath), а не только по самому Programs: junction на %LOCALAPPDATA%
# или на AppData уводил New-Item и Copy-Item в чужую папку так же. Облачные папки OneDrive ссылкой не считаются.
$destParentLink = $null
try { $destParentLink = Find-HmLinkOnPath -Path $destParent -Anchor (Get-HmTrustAnchor -Path $destParent) }
catch { $destParentLink = "$destParent (проверка не удалась: $($_.Exception.Message))" }
if ($destParentLink) {
    Write-Host "ОШИБКА: на пути к $destParent ссылка (junction/symlink) или путь не удалось проверить: $destParentLink; отказ копировать uv в перенаправленный путь."
    exit 1
}
if ((Test-Path -LiteralPath $dest) -and (Test-HmReparse $dest)) {
    try { (Get-Item -LiteralPath $dest -Force).Delete() } catch { }
    if (Test-Path -LiteralPath $dest) { Write-Host "ОШИБКА: $dest — reparse-point, не удалось убрать (best-effort)."; exit 1 }
}
$target = Join-Path $dest 'uv.exe'
try {
    # Копия — переносом по имени (Write-HmUserFile): Copy-Item -Force открывает САМО имя на запись и идёт по file-symlink,
    # подложенной на uv.exe/uvx.exe; каталог при этом закрепляется и сверяется по цепочке (подмена Programs\uv между
    # проверкой выше и записью). Бинарь — наш: «только чтение» снимается, как снимал Copy-Item -Force.
    Write-HmUserFile -Path $target -Bytes ([System.IO.File]::ReadAllBytes($srcUv)) -ClearReadOnly
    if ($srcUvxPath) { Write-HmUserFile -Path (Join-Path $dest 'uvx.exe') -Bytes ([System.IO.File]::ReadAllBytes($srcUvxPath)) -ClearReadOnly }
} catch {
    Write-Host "ОШИБКА: не удалось скопировать uv в $dest — $($_.Exception.Message)"
    exit 1
}
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    Write-Host "ОШИБКА: uv.exe не оказался в $dest после копирования."
    exit 1
}

# 3) Добавляем $dest в ПОЛЬЗОВАТЕЛЬСКИЙ PATH (без админа), если его там ещё нет.
#    ЧЕРЕЗ РЕЕСТР, а не [Environment]::SetEnvironmentVariable: на .NET Framework (скрипты идут
#    Windows PowerShell 5.1) Get отдаёт УЖЕ развёрнутое значение, а Set пишет RegistryValueKind
#    ::String → HKCU\Environment\Path молча превращается REG_EXPAND_SZ → REG_SZ, а записи вида
#    %USERPROFILE%\.local\bin / %JAVA_HOME%\bin остаются РАЗВЁРНУТЫМИ литералами (а не
#    определённые в elevated-окружении — мёртвым текстом «%VAR%», который Windows уже никогда
#    не развернёт). Тот же дефект уже починен в claude.ps1 (Add-ToUserPath) и учтён деинсталлятором.
$pathEntryOurs = $false
try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
    try {
        # Сырое значение (DoNotExpand) — сохраняем %VAR% пользователя как есть.
        $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $expanded = [Environment]::ExpandEnvironmentVariables($raw)
        $already = @($expanded -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $dest.TrimEnd('\')) }).Count -gt 0
        if (-not $already) {
            $newPath = if ($raw.TrimEnd(';')) { $raw.TrimEnd(';') + ';' + $dest } else { $dest }
            $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
            Write-Host "Добавил $dest в PATH — uv появится в новых терминалах."
        } else {
            Write-Host "$dest уже в PATH."
        }
        $pathEntryOurs = $true   # запись указывает на НАШ каталог установки — владеем ею
    } finally { try { $key.Close() } catch { } }
} catch { Write-Host "  [warn] не удалось прописать PATH: $($_.Exception.Message)" }

# P0-4: квитанция владения — ТОЧНЫЕ пути/PATH-запись (main соберёт в receipt).
Write-Host "HM-RECEIPT path $dest"
if ($pathEntryOurs) { Write-Host "HM-RECEIPT pathentry $dest" }

Write-Host "OK: uv установлен ($ver) — целостность подтверждена (SHA-256), скопирован в $dest."
exit 0
