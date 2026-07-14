# Hamidun config (.claude) — Windows
$ErrorActionPreference = 'Continue'
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
    if ($env:HM_VENDOR) { $parts += (Join-Path $env:HM_VENDOR 'apps') }
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}
Update-Path
$DRY = [bool]$env:HM_DRY_RUN
# Аддитивная доустановка ПОВЕРХ существующего ~/.claude (HM_ADDITIVE=1): добавляем
# только НЕДОСТАЮЩЕЕ, НЕ затирая пользовательские кастомизации. Ставит renderer,
# когда конфиг уже детектирован установленным (и это не forced repair).
$ADDITIVE = ($env:HM_ADDITIVE -eq '1')
$preExisting = @{}   # скиллы, БЫВШИЕ до нашей раскладки (для консервативного прунинга)

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
if ($DRY) {
    if ($ADDITIVE) { Write-Host "  [dry-run] WOULD (аддитивно): бэкап ~/.claude, merge-copy ТОЛЬКО недостающих файлов из '$clone\.claude' (robocopy /XC /XN /XO), существующее НЕ трогать, settings.json НЕ перезаписывать (+ прунинг паков не трогает ранее бывшие скиллы)" }
    else { Write-Host "  [dry-run] WOULD: $installer -BackupExisting -SkipDeps (+ фильтр паков по HM_KEEP_SKILLS)" }
    Write-Host "[dry-run] Конфиг: источник '$clone', без изменений."; exit 0
}

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
# Возвращает $true, только если ВСЁ из снапшота реально восстановилось. Тихий провал
# (диск полон, залоченный файл) больше не маскируется под успех — снапшот не удаляем.
function Restore-UserData($src) {
    New-Item -ItemType Directory -Force $claudeHome | Out-Null
    $ok = $true
    foreach ($f in $preserveFiles) {
        $s = Join-Path $src $f
        if (Test-Path $s) {
            Copy-Item -Force $s (Join-Path $claudeHome $f) -ErrorAction SilentlyContinue
            if (-not (Test-Path (Join-Path $claudeHome $f))) { $ok = $false }
        }
    }
    foreach ($d in $preserveDirs) {
        $s = Join-Path $src $d
        if (Test-Path $s) {
            $t = Join-Path $claudeHome $d
            New-Item -ItemType Directory -Force $t | Out-Null
            Copy-Item -Recurse -Force (Join-Path $s '*') $t -ErrorAction SilentlyContinue
            # грубая сверка: в цели не меньше элементов, чем в снапшоте
            $srcN = (Get-ChildItem $s -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
            $dstN = (Get-ChildItem $t -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
            if ($dstN -lt $srcN) { $ok = $false }
        }
    }
    return $ok
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
$global:LASTEXITCODE = 0

if ($ADDITIVE) {
    # === АДДИТИВНАЯ доустановка ПОВЕРХ существующего ~/.claude — НЕ затираем ===
    $srcClaude   = Join-Path $clone '.claude'
    $srcClaudeMd = Join-Path $clone 'CLAUDE.md'
    if (-not (Test-Path $srcClaude)) {
        $installFailed = $true; Write-Host "Источник конфига (.claude) не найден: $srcClaude"
    } else {
        # 1) Полный таймштамп-бэкап ~/.claude ДО любых изменений (fail-closed при нехватке места).
        if (Test-Path $claudeHome) {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $backupDir = "$claudeHome.backup.$stamp"
            Write-Host "Аддитивный режим: резервная копия ~/.claude → $backupDir ..."
            $backupOk = $true
            try {
                Copy-Item -Recurse -Force $claudeHome $backupDir -ErrorAction Stop
                # грубая сверка: в бэкапе не меньше элементов, чем в оригинале (диск полон → меньше)
                $srcN = (Get-ChildItem $claudeHome -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
                $dstN = (Get-ChildItem $backupDir  -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
                if ($dstN -lt $srcN) { $backupOk = $false }
            } catch { $backupOk = $false }
            if (-not $backupOk) {
                Write-Host "ВНИМАНИЕ: не удалось сделать полный бэкап ~/.claude (возможно, кончилось место на диске)."
                Write-Host "  Аддитивная доустановка ОТМЕНЕНА — ничего не менял. Освободи место и повтори."
                exit 1
            }
        }
        New-Item -ItemType Directory -Force $claudeHome | Out-Null

        # 2) Какие скиллы БЫЛИ до раскладки — чтобы прунинг не тронул чужие (не наши).
        $skillsDirNow = Join-Path $claudeHome 'skills'
        if (Test-Path $skillsDirNow) {
            Get-ChildItem -Directory $skillsDirNow -ErrorAction SilentlyContinue | ForEach-Object { $preExisting[$_.Name] = $true }
        }

        # 3) Merge-copy ТОЛЬКО недостающих файлов. robocopy /XC /XN /XO = исключить
        #    Changed/Newer/Older, т.е. копировать лишь ОТСУТСТВУЮЩИЕ в цели файлы;
        #    существующие любой версии (кастомизации юзера, settings.json) НЕ трогаем.
        #    /XF/XD дополнительно защищают ключи, память, историю сессий.
        $excludeNames = @('.credentials.master.env', '.credentials.json', 'MEMORY.md',
                          'chats.db', 'chats.db-journal', 'chats.db-wal', 'chats.db-shm',
                          'tg_session.session', 'settings.local.json')
        $excludeDirs  = @((Join-Path $claudeHome 'memory'), (Join-Path $claudeHome 'projects'),
                          (Join-Path $claudeHome 'todos'), (Join-Path $claudeHome 'shell-snapshots'))
        Write-Host "Добавляю только НЕДОСТАЮЩИЕ файлы конфига (существующее сохраняю)..."
        robocopy $srcClaude $claudeHome /E /XC /XN /XO /XF $excludeNames /XD $excludeDirs | Out-Null
        if ($LASTEXITCODE -ge 8) { $installFailed = $true; Write-Host "robocopy аддитивной раскладки вернул код $LASTEXITCODE — часть файлов не скопирована." }
        $global:LASTEXITCODE = 0

        # settings.json НИКОГДА не перезаписываем: robocopy /XC пропустил существующий;
        # если его не было — добавлен. Semver-мерж JSON намеренно НЕ делаем (риск сломать
        # пользовательский конфиг) — консервативно: не трогаем существующее.

        # CLAUDE.md в корне профиля — только если отсутствует (не затираем правки юзера).
        $profileClaudeMd = Join-Path $env:USERPROFILE 'CLAUDE.md'
        if ((Test-Path $srcClaudeMd) -and -not (Test-Path $profileClaudeMd)) {
            Copy-Item -Force $srcClaudeMd $profileClaudeMd -ErrorAction SilentlyContinue
        }
        # credentials-шаблон — только если ключей ещё нет.
        $srcEnvTpl = Join-Path $clone '.credentials.template.env'
        $dstEnv    = Join-Path $claudeHome '.credentials.master.env'
        if ((Test-Path $srcEnvTpl) -and -not (Test-Path $dstEnv)) {
            Copy-Item -Force $srcEnvTpl $dstEnv -ErrorAction SilentlyContinue
        }
        Write-Host "Аддитивная доустановка: добавлено недостающее, существующее сохранено."
    }
} else {
    # === Чистая установка: свежая база поверх (существующего конфига не было) ===
    # Ловим ОБА класса сбоя: терминирующие исключения (catch) И код возврата install.ps1.
    # install.ps1 заканчивается на robocopy, чей $LASTEXITCODE >= 8 означает реальный провал
    # копирования (0-7 — успех с разными состояниями); exit 1 внутри скрипта — отсутствие
    # исходника. Без этой проверки провалившийся robocopy (диск полон) давал ложный зелёный.
    try {
        & $installer -BackupExisting -SkipDeps
        if ($LASTEXITCODE -ge 8 -or $LASTEXITCODE -eq 1) {
            $installFailed = $true; Write-Host "install.ps1 завершился с кодом $LASTEXITCODE — раскладка конфига не удалась."
        }
    } catch { $installFailed = $true; Write-Host "install.ps1 предупреждение: $($_.Exception.Message)" }
}

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
            # В АДДИТИВНОМ режиме НЕ удаляем скиллы, которые были у юзера ДО нашей
            # раскладки (не наши — не трогаем). Удаляем только то, что доложили сами
            # этим прогоном и чей пак снят. В сомнении — не удаляем (консервативно).
            $weAdded = (-not $ADDITIVE) -or (-not $preExisting.ContainsKey($_.Name))
            if ($packAll.ContainsKey($_.Name) -and -not $keep.ContainsKey($_.Name) -and $weAdded) {
                Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
                $removed++
            }
        }
        Write-Host "Скиллы отфильтрованы по выбранным наборам (убрано: $removed)."
    }
}

# --- вернуть пользовательские данные поверх свежей базы (merge) ---
# Снапшот удаляем ТОЛЬКО при успешном restore — иначе в нём может лежать единственная
# копия ключей/памяти, и молчаливая потеря (диск полон) была бы невосстановимой.
$restoreOk = Restore-UserData $preserveDir
if ($restoreOk) {
    Remove-Item -Recurse -Force $preserveDir -ErrorAction SilentlyContinue
    Write-Host "Вернул твои ключи, память и историю сессий."
} else {
    Write-Host "ВНИМАНИЕ: не удалось полностью вернуть твои данные (возможно, кончилось место на диске)."
    Write-Host "  Резервная копия НЕ удалена и лежит здесь: $preserveDir"
    Write-Host "  Освободи место и запусти установку ещё раз, либо скопируй файлы оттуда в ~/.claude вручную."
}

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
