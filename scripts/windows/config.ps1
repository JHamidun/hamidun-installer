# Hamidun config (.claude) — Windows
$ErrorActionPreference = 'Continue'
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
Update-Path
$DRY = [bool]$env:HM_DRY_RUN

$bundled = $env:HM_BUNDLED_CONFIG
if ($bundled -and (Test-Path (Join-Path $bundled 'install.ps1'))) {
    Write-Host "Использую встроенный конфиг (офлайн): $bundled"
    $clone = $bundled
} else {
    # Онлайн-фолбэк: тянем с GitHub (если конфиг не вшит в установщик).
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "Встроенный конфиг не найден и Git недоступен — выберите компонент Git или пересоберите установщик."; exit 1 }
    $url    = if ($env:HM_CONFIG_REPO_URL) { $env:HM_CONFIG_REPO_URL } else { 'https://github.com/JHamidun/claude-code-config-pack' }
    $branch = if ($env:HM_CONFIG_REPO_BRANCH) { $env:HM_CONFIG_REPO_BRANCH } else { 'main' }
    $clone  = Join-Path $env:USERPROFILE '.hamidun-setup\config-repo'
    if (Test-Path (Join-Path $clone '.git')) {
        Write-Host "Обновляю конфиг с GitHub..."
        git -C $clone fetch --depth 1 origin $branch 2>&1 | Out-Null
        git -C $clone reset --hard "origin/$branch" 2>&1 | Out-Null
    } else {
        Write-Host "Скачиваю конфиг с GitHub ($url)..."
        New-Item -ItemType Directory -Force (Split-Path $clone) | Out-Null
        git clone --depth 1 -b $branch $url $clone
    }
}

$installer = Join-Path $clone 'install.ps1'
if (-not (Test-Path $installer)) { Write-Host "В репозитории нет install.ps1."; exit 1 }

Write-Host "Разворачиваю .claude в домашнюю папку (с бэкапом, без Python-зависимостей)..."
if ($DRY) { Write-Host "  [dry-run] WOULD: $installer -BackupExisting -SkipDeps (+ фильтр паков по HM_KEEP_SKILLS)"; Write-Host "[dry-run] Конфиг: источник '$clone', без изменений."; exit 0 }

# --- защитный снапшот пользовательских данных ПЕРЕД разворачиванием ---
# При повторной установке install.ps1 перезаписывает наши свежие базовые файлы
# поверх пользовательских — теряются API-ключи и накопленная память.
# Снимаем снапшот ДО, вернём ПОСЛЕ. При первой установке снапшота нет — нечего восстанавливать.
$claudeHome  = Join-Path $env:USERPROFILE '.claude'
$preserveDir = Join-Path $env:TEMP 'hamidun-preserve'
$credName    = '.credentials.master.env'
$srcCred     = Join-Path $claudeHome $credName
$srcMem      = Join-Path $claudeHome 'memory'
$snapCred    = Join-Path $preserveDir $credName
$snapMem     = Join-Path $preserveDir 'memory'
$snapshotTaken = $false
if ((Test-Path $srcCred) -or (Test-Path $srcMem)) {
    Write-Host "Сохраняю твои ключи и память перед обновлением..."
    if (Test-Path $preserveDir) { Remove-Item -Recurse -Force $preserveDir -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force $preserveDir | Out-Null
    if (Test-Path $srcCred) { Copy-Item -Force $srcCred $snapCred -ErrorAction SilentlyContinue }
    if (Test-Path $srcMem)  { Copy-Item -Recurse -Force $srcMem $snapMem -ErrorAction SilentlyContinue }
    $snapshotTaken = $true
}

try { & $installer -BackupExisting -SkipDeps } catch { Write-Host "install.ps1 предупреждение: $($_.Exception.Message)" }

# --- фильтрация скиллов по выбранным наборам (пакам) ---
# Прунятся ТОЛЬКО скиллы, входящие в какой-то пак, но чей пак не выбран.
# core и скиллы вне всех паков остаются всегда.
if ($env:HM_KEEP_SKILLS -and $env:HM_ALL_PACK_SKILLS) {
    $keep = @{}; $env:HM_KEEP_SKILLS.Split(',') | ForEach-Object { if ($_) { $keep[$_] = $true } }
    $packAll = @{}; $env:HM_ALL_PACK_SKILLS.Split(',') | ForEach-Object { if ($_) { $packAll[$_] = $true } }
    $skillsDir = Join-Path $env:USERPROFILE '.claude\skills'
    if (Test-Path $skillsDir) {
        $removed = 0
        Get-ChildItem -Directory $skillsDir | ForEach-Object {
            if ($packAll.ContainsKey($_.Name) -and -not $keep.ContainsKey($_.Name)) {
                Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
                $removed++
            }
        }
        Write-Host "Скиллы отфильтрованы по выбранным наборам (убрано: $removed)."
    }
}

# --- восстановление пользовательских данных из снапшота ---
# Возвращаем ключи и память ПОВЕРХ свежих базовых файлов (merge: пользовательские
# файлы перезаписывают базовые, новые базовые файлы не удаляем).
if ($snapshotTaken) {
    New-Item -ItemType Directory -Force $claudeHome | Out-Null
    if (Test-Path $snapCred) { Copy-Item -Force $snapCred $srcCred -ErrorAction SilentlyContinue }
    if (Test-Path $snapMem) {
        New-Item -ItemType Directory -Force $srcMem | Out-Null
        Copy-Item -Recurse -Force (Join-Path $snapMem '*') $srcMem -ErrorAction SilentlyContinue
    }
    Remove-Item -Recurse -Force $preserveDir -ErrorAction SilentlyContinue
    Write-Host "Вернул твои ключи и память."
}

# Честная проверка: конфиг реально развернулся?
$dst = Join-Path $env:USERPROFILE '.claude'
if ((Test-Path (Join-Path $dst 'skills')) -or (Test-Path (Join-Path $dst 'settings.json'))) {
    Write-Host "OK: конфиг развёрнут. Не забудь заполнить ~/.claude/.credentials.master.env"
    exit 0
}
Write-Host "Конфиг не развернулся (~/.claude пуст) — смотри лог выше."
exit 1
