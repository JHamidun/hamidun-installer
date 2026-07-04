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

# --- защита пользовательских данных при ПОВТОРНОЙ установке ---
# install.ps1 кладёт свежую базу поверх ~/.claude. Сохраняем пользовательские данные
# (ключи, память, историю сессий projects, локальные настройки) ДО и возвращаем merge-ом ПОСЛЕ.
# Общий конфиг (skills/agents/commands/rules/settings.json) НЕ сохраняем — он обновляется.
$claudeHome    = Join-Path $env:USERPROFILE '.claude'
$preserveDir   = Join-Path $env:TEMP 'hamidun-preserve'
$preserveFiles = @('.credentials.master.env', '.credentials.json', 'settings.local.json')
$preserveDirs  = @('memory', 'projects', 'todos', 'shell-snapshots')

function Snapshot-UserData($dst) {
    New-Item -ItemType Directory -Force $dst | Out-Null
    foreach ($f in $preserveFiles) { $s = Join-Path $claudeHome $f; if (Test-Path $s) { Copy-Item -Force $s (Join-Path $dst $f) -ErrorAction SilentlyContinue } }
    foreach ($d in $preserveDirs)  { $s = Join-Path $claudeHome $d; if (Test-Path $s) { $t = Join-Path $dst $d; if (Test-Path $t) { Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue }; Copy-Item -Recurse -Force $s $t -ErrorAction SilentlyContinue } }
}
function Restore-UserData($src) {
    New-Item -ItemType Directory -Force $claudeHome | Out-Null
    foreach ($f in $preserveFiles) { $s = Join-Path $src $f; if (Test-Path $s) { Copy-Item -Force $s (Join-Path $claudeHome $f) -ErrorAction SilentlyContinue } }
    foreach ($d in $preserveDirs)  { $s = Join-Path $src $d; if (Test-Path $s) { $t = Join-Path $claudeHome $d; New-Item -ItemType Directory -Force $t | Out-Null; Copy-Item -Recurse -Force (Join-Path $s '*') $t -ErrorAction SilentlyContinue } }
}

# сперва вернуть данные ПРЕРВАННОГО прошлого прогона — краш между снапшотом и restore
# мог оставить в снапшоте ЕДИНСТВЕННУЮ копию реальных ключей; не потеряем их.
if ((Test-Path $preserveDir) -and (Get-ChildItem $preserveDir -Force -ErrorAction SilentlyContinue)) {
    Write-Host "Обнаружен снапшот прерванной установки — восстанавливаю..."
    Restore-UserData $preserveDir
}
Write-Host "Сохраняю твои ключи, память и историю сессий перед обновлением..."
Snapshot-UserData $preserveDir

# Существовал ли рабочий конфиг ДО обновления — чтобы не выдать ложный зелёный на СТАРОМ ~/.claude.
$hadOldConfig = (Test-Path (Join-Path $claudeHome 'skills')) -or (Test-Path (Join-Path $claudeHome 'settings.json'))
$installFailed = $false
try { & $installer -BackupExisting -SkipDeps } catch { $installFailed = $true; Write-Host "install.ps1 предупреждение: $($_.Exception.Message)" }

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

# --- вернуть пользовательские данные поверх свежей базы (merge) ---
Restore-UserData $preserveDir
Remove-Item -Recurse -Force $preserveDir -ErrorAction SilentlyContinue
Write-Host "Вернул твои ключи, память и историю сессий."

# --- стартовый проект из вшитых ассетов (идемпотентно: существующий НЕ перезаписываем) ---
$starterSrc = ''
if ($env:HM_ASSETS) { $cand = Join-Path $env:HM_ASSETS 'starter-project'; if (Test-Path $cand) { $starterSrc = $cand } }
if ($starterSrc) {
    $starterDst = Join-Path $env:USERPROFILE 'HamidunStart'
    if (Test-Path $starterDst) {
        Write-Host "Стартовый проект уже есть: $starterDst — не перезаписываю."
    } else {
        Write-Host "Копирую стартовый проект в $starterDst..."
        try { Copy-Item -Recurse -Force $starterSrc $starterDst -ErrorAction Stop; Write-Host "Стартовый проект создан: $starterDst" }
        catch { Write-Host "Стартовый проект не скопировался: $($_.Exception.Message)" }
    }
}

# Честная проверка: конфиг реально развернулся?
$dst = Join-Path $env:USERPROFILE '.claude'
$dstPresent = (Test-Path (Join-Path $dst 'skills')) -or (Test-Path (Join-Path $dst 'settings.json'))

if ($installFailed) {
    # install.ps1 упал с исключением. Наличие ~/.claude ещё НЕ значит успех — это может быть
    # СТАРЫЙ конфиг от прошлой установки. Не выдаём ложный зелёный.
    if ($hadOldConfig -and $dstPresent) {
        Write-Host "ВНИМАНИЕ: обновление конфига НЕ применилось — install.ps1 завершился с ошибкой (см. выше)."
        Write-Host "  В ~/.claude остался ПРЕДЫДУЩИЙ конфиг; твои ключи, память и история сессий сохранены."
        Write-Host "  Запусти установку повторно после устранения причины ошибки."
    } else {
        Write-Host "Конфиг не развернулся — install.ps1 завершился с ошибкой (см. выше)."
    }
    exit 1
}

if ($dstPresent) {
    Write-Host "OK: конфиг развёрнут. Не забудь заполнить ~/.claude/.credentials.master.env"
    exit 0
}
Write-Host "Конфиг не развернулся (~/.claude пуст) — смотри лог выше."
exit 1
