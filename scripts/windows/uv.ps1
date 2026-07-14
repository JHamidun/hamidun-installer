# uv — быстрый менеджер Python (Astral). REMOTE-компонент: бинарь НЕ вшит, а
# докачан установщиком из CDN, проверен по SHA-256 и разложен в admin-owned
# $env:HM_REMOTE_CACHE (%ProgramData%\HamidunSetup\… — DACL SYSTEM+Admins,
# см. main.js / remote-fetch.js). Оттуда его БЕЗОПАСНО запускать даже elevated.
#
# БЕЗОПАСНОСТЬ (FIX-D/FIX-G): проверку версии делаем ЗАПУСКОМ ИЗ ЗАЩИЩЁННОГО
# КЭША (не из будущей user-writable копии), затем копируем в %LOCALAPPDATA%\Programs\uv
# для PATH пользователя, но копию под elevated-токеном НЕ запускаем (это была бы
# TOCTOU-гонка: medium-integrity процесс юзера мог бы подменить exe между copy и run).
# Успех — ТОЛЬКО при exit-коде 0 И валидном формате вывода `uv --version`. Honor HM_DRY_RUN.
$ErrorActionPreference = 'Stop'
$DRY = [bool]$env:HM_DRY_RUN

$cache = $env:HM_REMOTE_CACHE
if (-not $cache -or -not (Test-Path -LiteralPath $cache)) {
    Write-Host "ОШИБКА: HM_REMOTE_CACHE не задан или не существует — докачка uv не выполнена."
    exit 1
}

# Ищем uv.exe в защищённом кэше. Отвергаем reparse-point (симлинк/junction).
$src = Get-ChildItem -Path $cache -Filter 'uv.exe' -Recurse -File -ErrorAction SilentlyContinue |
       Where-Object { -not ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) } |
       Select-Object -First 1
if (-not $src) {
    Write-Host "ОШИБКА: uv.exe не найден в защищённом кэше ($cache)."
    exit 1
}
$srcUv = $src.FullName
if (-not (Test-Path -LiteralPath $srcUv -PathType Leaf)) {
    Write-Host "ОШИБКА: источник uv.exe — не файл (Leaf)."
    exit 1
}
$srcUvx = Get-ChildItem -Path $cache -Filter 'uvx.exe' -Recurse -File -ErrorAction SilentlyContinue |
          Where-Object { -not ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) } |
          Select-Object -First 1

$dest = Join-Path $env:LOCALAPPDATA 'Programs\uv'
if ($DRY) {
    Write-Host "  [dry-run] WOULD: проверить $srcUv запуском ИЗ ЗАЩИЩЁННОГО кэша, скопировать в $dest, добавить в PATH (копию НЕ запускать)"
    exit 0
}

# 1) ПРОВЕРКА ЗАПУСКОМ ИЗ ЗАЩИЩЁННОГО ИСТОЧНИКА (admin-owned кэш), НЕ из user-writable
#    места. Требуем exit 0 И вывод формата 'uv <версия>' (не просто подстроку 'uv').
$ver = ''
try { $ver = (& $srcUv --version 2>&1 | Select-Object -First 1) }
catch {
    Write-Host "ОШИБКА: uv.exe из кэша не запустился — $($_.Exception.Message)"
    exit 1
}
if ($LASTEXITCODE -ne 0 -or ("$ver" -notmatch '^uv\s+\d')) {
    Write-Host "ОШИБКА: uv --version дал некорректный результат (код=$LASTEXITCODE, вывод=$ver)."
    exit 1
}

# 2) Копируем ПРОВЕРЕННЫЙ бинарь в пользовательский каталог (для PATH). Копию
#    под elevated-токеном НЕ запускаем.
$target = Join-Path $dest 'uv.exe'
try {
    New-Item -ItemType Directory -Force $dest -ErrorAction Stop | Out-Null
    Copy-Item -Force -LiteralPath $srcUv $target -ErrorAction Stop
    if ($srcUvx) { Copy-Item -Force -LiteralPath $srcUvx.FullName (Join-Path $dest 'uvx.exe') -ErrorAction Stop }
} catch {
    Write-Host "ОШИБКА: не удалось скопировать uv в $dest — $($_.Exception.Message)"
    exit 1
}
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    Write-Host "ОШИБКА: uv.exe не оказался в $dest после копирования."
    exit 1
}

# 3) Добавляем $dest в ПОЛЬЗОВАТЕЛЬСКИЙ PATH (без админа), если его там ещё нет.
try {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $userPath) { $userPath = '' }
    $already = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $dest.TrimEnd('\')) }).Count -gt 0
    if (-not $already) {
        $newPath = if ($userPath.TrimEnd(';')) { $userPath.TrimEnd(';') + ';' + $dest } else { $dest }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "Добавил $dest в PATH — uv появится в новых терминалах."
    } else {
        Write-Host "$dest уже в PATH."
    }
} catch { Write-Host "  [warn] не удалось прописать PATH: $($_.Exception.Message)" }

Write-Host "OK: uv установлен ($ver) — проверен из защищённого кэша, скопирован в $dest."
exit 0
