# uv — быстрый менеджер Python (Astral). REMOTE-компонент: бинарь НЕ вшит,
# а докачан установщиком из CDN и распакован в $env:HM_REMOTE_CACHE (см. main.js
# fetch-remote / remote-fetch.js). Здесь только: скопировать в %LOCALAPPDATA%\Programs\uv,
# добавить в PATH, проверить запуск. Honor HM_DRY_RUN. Честный статус (exit 0/1).
$ErrorActionPreference = 'Continue'
$DRY = [bool]$env:HM_DRY_RUN

$cache = $env:HM_REMOTE_CACHE
if (-not $cache -or -not (Test-Path $cache)) {
    Write-Host "ОШИБКА: HM_REMOTE_CACHE не задан или не существует — докачка uv не выполнена."
    exit 1
}

# Архив Astral кладёт uv.exe/uvx.exe в корень; ищем рекурсивно на всякий случай.
$uvExe = Get-ChildItem -Path $cache -Filter 'uv.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $uvExe) {
    Write-Host "ОШИБКА: uv.exe не найден в распакованном кэше ($cache)."
    exit 1
}
$uvxExe = Get-ChildItem -Path $cache -Filter 'uvx.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1

$dest = Join-Path $env:LOCALAPPDATA 'Programs\uv'
if ($DRY) {
    Write-Host "  [dry-run] WOULD: скопировать $($uvExe.FullName) -> $dest\uv.exe и добавить $dest в PATH (пользовательский)"
    exit 0
}

New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Force $uvExe.FullName (Join-Path $dest 'uv.exe')
if ($uvxExe) { Copy-Item -Force $uvxExe.FullName (Join-Path $dest 'uvx.exe') }

# Добавляем $dest в ПОЛЬЗОВАТЕЛЬСКИЙ PATH (без админа), если его там ещё нет.
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
$env:Path = $dest + ';' + $env:Path

$ver = (& (Join-Path $dest 'uv.exe') --version 2>&1 | Select-Object -First 1)
if ($ver -match 'uv') { Write-Host "OK: uv установлен ($ver)"; exit 0 }
Write-Host "ОШИБКА: uv.exe скопирован, но не запустился корректно ($ver)."
exit 1
