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
# P0-1: аддитивная доустановка ПОВЕРХ существующего ~/.claude (HM_ADDITIVE=1):
# добавляем только НЕДОСТАЮЩЕЕ, НЕ затирая пользовательские кастомизации.
# HM_ADDITIVE ставит АВТОРИТЕТНО main.js (живой детекцией ФС, fail-safe → additive);
# при HM_ADDITIVE base install.ps1 (перезапись свежей базой) НЕ запускается.
$ADDITIVE = ($env:HM_ADDITIVE -eq '1')
$claudeHome = Join-Path $env:USERPROFILE '.claude'
$preExisting = @{}     # скиллы, БЫВШИЕ до нашей раскладки (для консервативного прунинга)
$pruneDisabled = $false # P0-3: сбой перечисления/копирования → прунинг ПОЛНОСТЬЮ выключен

# --- источник конфига (P1-8: dry-run ветвится ДО clone/fetch/reset) ---
$bundled = $env:HM_BUNDLED_CONFIG
$haveBundled = [bool]($bundled -and (Test-Path (Join-Path $bundled 'install.ps1')))

if ($DRY) {
    if ($haveBundled) { Write-Host "  [dry-run] Источник: встроенный конфиг (офлайн) $bundled" }
    else { Write-Host "  [dry-run] WOULD: git clone/fetch конфига с GitHub (в dry-run НЕ выполняется)" }
    if ($ADDITIVE) { Write-Host "  [dry-run] WOULD (аддитивно): полный таймштамп-бэкап ~/.claude ПЕРВОЙ операцией, merge-copy ТОЛЬКО недостающих файлов (robocopy /XC /XN /XO), существующее НЕ трогать, settings.json НЕ перезаписывать, БЕЗ snapshot/restore hamidun-preserve (+ прунинг паков fail-closed)" }
    else { Write-Host "  [dry-run] WOULD: полный таймштамп-бэкап ~/.claude, install.ps1 -BackupExisting -SkipDeps (+ фильтр паков по HM_KEEP_SKILLS)" }
    Write-Host "[dry-run] Конфиг: без изменений."; exit 0
}

if ($haveBundled) {
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

Write-Host "Разворачиваю .claude в домашнюю папку..."

# === P0-2: ПОЛНЫЙ таймштамп-бэкап ~/.claude — ПЕРВАЯ операция, трогающая ~/.claude ===
# КОПИЯ (не move), в ОБОИХ режимах. Неполный бэкап → fail-closed: ничего не меняем.
if (Test-Path $claudeHome) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupDir = "$claudeHome.backup.$stamp"
    Write-Host "Резервная копия ~/.claude → $backupDir ..."
    $backupOk = $true
    try {
        # M7: robocopy вместо Copy-Item -Recurse — PS 5.1 не longPathAware, Copy-Item
        # падает на путях >260 символов (projects/ этим славится); robocopy устойчив.
        # /R:1 /W:1 — не зависать на залоченном файле (дефолт robocopy — 1M ретраев по 30с).
        robocopy $claudeHome $backupDir /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { $backupOk = $false }
        $global:LASTEXITCODE = 0
        if (-not (Test-Path $backupDir)) { $backupOk = $false }
        # грубая сверка: в бэкапе не меньше элементов, чем в оригинале (диск полон → меньше)
        $srcN = (Get-ChildItem $claudeHome -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
        $dstN = (Get-ChildItem $backupDir  -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
        if ($dstN -lt $srcN) { $backupOk = $false }
    } catch { $backupOk = $false }
    if (-not $backupOk) {
        Write-Host "ВНИМАНИЕ: не удалось сделать полный бэкап ~/.claude (возможно, кончилось место на диске)."
        Write-Host "  Установка конфига ОТМЕНЕНА — ничего не менял. Освободи место и повтори."
        exit 1
    }
}

# Существовал ли рабочий конфиг ДО обновления — чтобы не выдать ложный зелёный на СТАРОМ ~/.claude.
$hadOldConfig = (Test-Path (Join-Path $claudeHome 'skills')) -or (Test-Path (Join-Path $claudeHome 'settings.json'))
$installFailed = $false
$global:LASTEXITCODE = 0

# --- защита пользовательских данных при ЧИСТОЙ переустановке (НЕ additive) ---
# install.ps1 кладёт свежую базу поверх ~/.claude. Сохраняем пользовательские данные
# (ключи, память, историю сессий projects, локальные настройки) ДО и возвращаем merge-ом ПОСЛЕ.
# P0-2: снапшот живёт в ~/.hamidun-setup/preserve (user-owned, НЕ предсказуемый общий TEMP).
# В АДДИТИВНОМ режиме snapshot/restore НЕ используются вовсе (живое дерево не трогаем).
$preserveDir   = Join-Path $env:USERPROFILE '.hamidun-setup\preserve'
# H4: ЕДИНЫЙ канонический список user-data — совпадает с additive-исключениями (/XF ниже).
# chats.db* — история чатов (FTS5, ~30МБ), tg_session.session* — Telegram-авторизация:
# base install.ps1 делает Move-Item ВСЕГО ~/.claude, без снапшота они исчезали навсегда.
$preserveFiles = @('.credentials.master.env', '.credentials.json', 'settings.local.json', 'MEMORY.md',
                   'chats.db', 'chats.db-wal', 'chats.db-shm', 'chats.db-journal',
                   'tg_session.session', 'tg_session.session-journal')
$preserveDirs  = @('memory', 'projects', 'todos', 'shell-snapshots')

# H2/H3: снапшот с ПРОВЕРКОЙ полноты. Возвращает $true только если КАЖДЫЙ существующий
# в ~/.claude preserve-элемент реально лёг в снапшот (файлы — существование + размер;
# каталоги — robocopy-код < 8 и элементов не меньше). Тихий Copy-Item -SilentlyContinue
# убран: неполный снапшот перед wipe = невосстановимая потеря ключей/памяти.
function Snapshot-UserData($dst) {
    try { New-Item -ItemType Directory -Force $dst -ErrorAction Stop | Out-Null } catch { return $false }
    $ok = $true
    foreach ($f in $preserveFiles) {
        $s = Join-Path $claudeHome $f
        if (Test-Path -LiteralPath $s) {
            $t = Join-Path $dst $f
            try { Copy-Item -LiteralPath $s -Destination $t -Force -ErrorAction Stop } catch { $ok = $false; continue }
            if (-not (Test-Path -LiteralPath $t)) { $ok = $false; continue }
            try {
                $srcLen = (Get-Item -LiteralPath $s -Force -ErrorAction Stop).Length
                $dstLen = (Get-Item -LiteralPath $t -Force -ErrorAction Stop).Length
                if ($dstLen -ne $srcLen) { $ok = $false }
            } catch { $ok = $false }
        }
    }
    foreach ($d in $preserveDirs) {
        $s = Join-Path $claudeHome $d
        if (Test-Path -LiteralPath $s) {
            $t = Join-Path $dst $d
            if (Test-Path -LiteralPath $t) { Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue }
            # M7: robocopy — projects/ регулярно содержит пути >260 символов (PS 5.1 не осилит).
            robocopy $s $t /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { $ok = $false }
            $global:LASTEXITCODE = 0
            $srcN = (Get-ChildItem -LiteralPath $s -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
            $dstN = 0
            if (Test-Path -LiteralPath $t) { $dstN = (Get-ChildItem -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count }
            elseif ($srcN -gt 0) { $ok = $false }
            if ($dstN -lt $srcN) { $ok = $false }
        }
    }
    return $ok
}
# Возвращает $true, только если ВСЁ из снапшота реально восстановилось. Тихий провал
# (диск полон, залоченный файл) больше не маскируется под успех — снапшот не удаляем.
# M8: файлы сверяются С СОДЕРЖИМЫМ снапшота (hash), а не Test-Path цели: install.ps1
# ГАРАНТИРОВАННО кладёт ШАБЛОН поверх .credentials.master.env, и «файл существует»
# ничего не доказывает — ложный успех на шаблоне вместо живых ключей.
function Restore-UserData($src) {
    New-Item -ItemType Directory -Force $claudeHome | Out-Null
    $ok = $true
    foreach ($f in $preserveFiles) {
        $s = Join-Path $src $f
        if (Test-Path -LiteralPath $s) {
            $t = Join-Path $claudeHome $f
            try { Copy-Item -LiteralPath $s -Destination $t -Force -ErrorAction Stop } catch { $ok = $false; continue }
            try {
                $hs = (Get-FileHash -LiteralPath $s -Algorithm SHA256 -ErrorAction Stop).Hash
                $ht = (Get-FileHash -LiteralPath $t -Algorithm SHA256 -ErrorAction Stop).Hash
                if ($hs -ne $ht) { $ok = $false }
            } catch { $ok = $false }
        }
    }
    foreach ($d in $preserveDirs) {
        $s = Join-Path $src $d
        if (Test-Path -LiteralPath $s) {
            $t = Join-Path $claudeHome $d
            # M7: robocopy (создаёт цель сам) — длинные пути projects/ переживают restore.
            robocopy $s $t /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { $ok = $false }
            $global:LASTEXITCODE = 0
            # грубая сверка: в цели не меньше элементов, чем в снапшоте
            $srcN = (Get-ChildItem -LiteralPath $s -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
            $dstN = 0
            if (Test-Path -LiteralPath $t) { $dstN = (Get-ChildItem -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count }
            elseif ($srcN -gt 0) { $ok = $false }
            if ($dstN -lt $srcN) { $ok = $false }
        }
    }
    return $ok
}
# P0-2: восстановление СТАРОГО снапшота — ТОЛЬКО недостающих файлов (никогда не льём
# старые значения KEY=OLD поверх живых KEY=NEW). Нужен для rescue после краша прошлого
# прогона МЕЖДУ wipe и restore (тогда файлов в живом дереве нет — и они вернутся).
function Restore-UserDataMissingOnly($src) {
    New-Item -ItemType Directory -Force $claudeHome | Out-Null
    foreach ($f in $preserveFiles) {
        $s = Join-Path $src $f; $t = Join-Path $claudeHome $f
        if ((Test-Path $s) -and -not (Test-Path $t)) { Copy-Item -Force $s $t -ErrorAction SilentlyContinue }
    }
    foreach ($d in $preserveDirs) {
        $s = Join-Path $src $d
        if (Test-Path $s) {
            $t = Join-Path $claudeHome $d
            New-Item -ItemType Directory -Force $t | Out-Null
            # robocopy /XC /XN /XO: копировать ЛИШЬ отсутствующие в цели файлы
            robocopy $s $t /E /XC /XN /XO | Out-Null
            $global:LASTEXITCODE = 0
        }
    }
}

if ($ADDITIVE) {
    # === АДДИТИВНАЯ доустановка ПОВЕРХ существующего ~/.claude — НЕ затираем ===
    # P0-2: НИКАКОГО hamidun-preserve здесь — ни restore старого снапшота (он льёт
    # старые значения поверх живых), ни нового снапшота. Полный бэкап уже сделан выше.
    $srcClaude   = Join-Path $clone '.claude'
    $srcClaudeMd = Join-Path $clone 'CLAUDE.md'
    if (-not (Test-Path $srcClaude)) {
        $installFailed = $true; Write-Host "Источник конфига (.claude) не найден: $srcClaude"
    } else {
        New-Item -ItemType Directory -Force $claudeHome | Out-Null

        # P0-3: какие скиллы БЫЛИ до раскладки — ПОЛНОЕ УСПЕШНОЕ перечисление обязательно.
        # Любой сбой перечисления → прунинг ПОЛНОСТЬЮ выключен (никогда не удаляем).
        $skillsDirNow = Join-Path $claudeHome 'skills'
        try {
            if (Test-Path -LiteralPath $skillsDirNow) {
                $item = Get-Item -LiteralPath $skillsDirNow -Force -ErrorAction Stop
                if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    throw "skills — reparse point (junction/symlink), перечисление небезопасно"
                }
                # ВСЕ immediate-детей (включая файлы и symlink/junction — не только
                # -Directory): пред-существующий symlink-скилл иначе считался бы
                # «нашим» и удалялся при снятом паке.
                Get-ChildItem -Force -LiteralPath $skillsDirNow -ErrorAction Stop | ForEach-Object { $preExisting[$_.Name] = $true }
            }
        } catch {
            $pruneDisabled = $true
            Write-Host "  Перечисление существующих скиллов не удалось ($($_.Exception.Message)) — прунинг паков отключён (ничего не удаляем)."
        }

        # Merge-copy ТОЛЬКО недостающих файлов. robocopy /XC /XN /XO = исключить
        # Changed/Newer/Older, т.е. копировать лишь ОТСУТСТВУЮЩИЕ в цели файлы;
        # существующие любой версии (кастомизации юзера, settings.json) НЕ трогаем.
        # /XF/XD дополнительно защищают ключи, память, историю сессий.
        # H4: канонический список user-data — тот же состав, что $preserveFiles clean-режима.
        $excludeNames = @('.credentials.master.env', '.credentials.json', 'MEMORY.md',
                          'chats.db', 'chats.db-journal', 'chats.db-wal', 'chats.db-shm',
                          'tg_session.session', 'tg_session.session-journal', 'settings.local.json')
        $excludeDirs  = @((Join-Path $claudeHome 'memory'), (Join-Path $claudeHome 'projects'),
                          (Join-Path $claudeHome 'todos'), (Join-Path $claudeHome 'shell-snapshots'))
        Write-Host "Добавляю только НЕДОСТАЮЩИЕ файлы конфига (существующее сохраняю)..."
        robocopy $srcClaude $claudeHome /E /XC /XN /XO /XF $excludeNames /XD $excludeDirs | Out-Null
        if ($LASTEXITCODE -ge 8) {
            $installFailed = $true; $pruneDisabled = $true
            Write-Host "robocopy аддитивной раскладки вернул код $LASTEXITCODE — часть файлов не скопирована; прунинг паков отключён."
        }
        $global:LASTEXITCODE = 0

        # settings.json НИКОГДА не перезаписываем: robocopy /XC пропустил существующий;
        # если его не было — добавлен. Semver-мерж JSON намеренно НЕ делаем (риск сломать
        # пользовательский конфиг) — консервативно: не трогаем существующее.

        # CLAUDE.md в корне профиля — только если отсутствует (не затираем правки юзера).
        # P1: сбой копирования (ACL/ENOSPC) → честный провал + прунинг off, а не
        # молчаливо отсутствующий файл (раньше SilentlyContinue глотал ошибку).
        $profileClaudeMd = Join-Path $env:USERPROFILE 'CLAUDE.md'
        if ((Test-Path $srcClaudeMd) -and -not (Test-Path $profileClaudeMd)) {
            try { Copy-Item -Force $srcClaudeMd $profileClaudeMd -ErrorAction Stop }
            catch { $installFailed = $true; $pruneDisabled = $true; Write-Host "ВНИМАНИЕ: не удалось скопировать ~/CLAUDE.md ($($_.Exception.Message))." }
        }
        # credentials-шаблон — только если ключей ещё нет.
        $srcEnvTpl = Join-Path $clone '.credentials.template.env'
        $dstEnv    = Join-Path $claudeHome '.credentials.master.env'
        if ((Test-Path $srcEnvTpl) -and -not (Test-Path $dstEnv)) {
            try { Copy-Item -Force $srcEnvTpl $dstEnv -ErrorAction Stop }
            catch { $installFailed = $true; $pruneDisabled = $true; Write-Host "ВНИМАНИЕ: не удалось скопировать шаблон credentials ($($_.Exception.Message))." }
        }
        if (-not $installFailed) { Write-Host "Аддитивная доустановка: добавлено недостающее, существующее сохранено." }
    }
} else {
    # === Чистая установка: свежая база поверх (кастомизаций не было / подтверждённый repair) ===
    # Легаси-снапшот в %TEMP%\hamidun-preserve НЕ восстанавливаем автоматически (P0-2:
    # предсказуемый общий путь; старые значения не льём) — только сообщаем, где он лежит.
    $legacyPreserve = Join-Path $env:TEMP 'hamidun-preserve'
    if ((Test-Path $legacyPreserve) -and (Get-ChildItem $legacyPreserve -Force -ErrorAction SilentlyContinue)) {
        Write-Host "ВНИМАНИЕ: найден снапшот старого установщика: $legacyPreserve — он НЕ восстанавливается автоматически."
        Write-Host "  Если после прошлой установки пропали ключи/память — скопируй нужные файлы оттуда вручную."
    }
    # Снапшот ПРЕРВАННОГО прошлого прогона: возвращаем ТОЛЬКО отсутствующие файлы
    # (краш между wipe и restore — файлы пропали → вернутся; живые файлы НЕ трогаем),
    # затем откладываем его в rescue-папку (не удаляем: там может быть единственная копия).
    if ((Test-Path $preserveDir) -and (Get-ChildItem $preserveDir -Force -ErrorAction SilentlyContinue)) {
        Write-Host "Обнаружен снапшот прерванной установки — возвращаю только НЕДОСТАЮЩИЕ файлы..."
        Restore-UserDataMissingOnly $preserveDir
        $rescue = Join-Path $env:USERPROFILE ('.hamidun-setup\preserve-rescue-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        try { Move-Item -Force $preserveDir $rescue -ErrorAction Stop; Write-Host "  Старый снапшот отложен: $rescue" }
        catch { Write-Host "  Не удалось отложить старый снапшот ($($_.Exception.Message)) — оставляю на месте." }
    }
    Write-Host "Сохраняю твои ключи, память и историю сессий перед обновлением..."
    # H2/H3: снапшот сверяется на ПОЛНОТУ; неполный → abort ДО install.ps1 (он делает
    # Move-Item всего ~/.claude — wipe живого дерева; restore из снапшота — единственный
    # механизм возврата). Живое ~/.claude на этот момент НЕ изменено.
    $snapOk = Snapshot-UserData $preserveDir
    if (-not $snapOk) {
        Write-Host "ВНИМАНИЕ: не удалось сохранить твои данные (ключи/память/историю сессий) — снапшот неполный."
        Write-Host "  Установка конфига ОТМЕНЕНА — НИЧЕГО не менял, повтори позже (освободи место, закрой Claude)."
        Write-Host "  Частичный снапшот (если создался) лежит здесь: $preserveDir"
        exit 1
    }

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
# P0-3 fail-closed: сбой перечисления/копирования ($pruneDisabled) или провал раскладки
# ($installFailed) → прунинг НЕ выполняется вовсе (лучше лишний скилл, чем удалённый чужой).
if ($env:HM_KEEP_SKILLS -and $env:HM_ALL_PACK_SKILLS) {
    # M5: fail-closed в ОБОИХ режимах (раньше guard действовал только в additive):
    # провал раскладки/перечисления в clean тоже отменяет прунинг — при $installFailed
    # в ~/.claude может лежать СТАРОЕ дерево юзера, удалять из него нечего и нельзя.
    if ($pruneDisabled -or $installFailed) {
        Write-Host "Прунинг паков пропущен (fail-closed): раскладка/перечисление не подтверждены. Удалено: 0."
    } else {
        $keep = @{}; $env:HM_KEEP_SKILLS.Split(',') | ForEach-Object { if ($_) { $keep[$_] = $true } }
        $packAll = @{}; $env:HM_ALL_PACK_SKILLS.Split(',') | ForEach-Object { if ($_) { $packAll[$_] = $true } }
        $skillsDir = Join-Path $env:USERPROFILE '.claude\skills'
        # M6: reparse-проверка skills-каталога действует и в CLEAN-режиме — junction/symlink
        # на месте ~/.claude/skills уводит Remove-Item в ЧУЖУЮ цель.
        $skillsReparse = $false
        try {
            if (Test-Path -LiteralPath $skillsDir) {
                $it = Get-Item -LiteralPath $skillsDir -Force -ErrorAction Stop
                if ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $skillsReparse = $true }
            }
        } catch { $skillsReparse = $true }
        if ($skillsReparse) {
            Write-Host "Прунинг паков пропущен (fail-closed): ~/.claude/skills — reparse point (junction/symlink). Удалено: 0."
        } elseif (Test-Path $skillsDir) {
            $removed = 0
            Get-ChildItem -Directory $skillsDir | ForEach-Object {
                # Симлинк/junction-скилл НИКОГДА не удаляем: Remove-Item -Recurse на
                # reparse-point в PS 5.1 может уйти в ЧУЖУЮ цель, и ссылка по
                # определению не «доложена нами» (мы копируем реальные каталоги).
                if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return }
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
}

# --- вернуть пользовательские данные поверх свежей базы (merge) — ТОЛЬКО clean-режим ---
# P0-2: в additive живое дерево не трогали — восстанавливать нечего и НЕЛЬЗЯ.
# Снапшот удаляем ТОЛЬКО при успешном restore — иначе в нём может лежать единственная
# копия ключей/памяти, и молчаливая потеря (диск полон) была бы невосстановимой.
$restoreFailed = $false
if (-not $ADDITIVE) {
    $restoreOk = Restore-UserData $preserveDir
    if ($restoreOk) {
        Remove-Item -Recurse -Force $preserveDir -ErrorAction SilentlyContinue
        Write-Host "Вернул твои ключи, память и историю сессий."
    } else {
        $restoreFailed = $true
        Write-Host "ВНИМАНИЕ: не удалось полностью вернуть твои данные (возможно, кончилось место на диске)."
        Write-Host "  Резервная копия НЕ удалена и лежит здесь: $preserveDir"
        Write-Host "  Освободи место и запусти установку ещё раз, либо скопируй файлы оттуда в ~/.claude вручную."
    }
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
    # Раскладка упала. Наличие ~/.claude ещё НЕ значит успех — это может быть
    # СТАРЫЙ конфиг от прошлой установки. Не выдаём ложный зелёный.
    if ($hadOldConfig -and $dstPresent) {
        Write-Host "ВНИМАНИЕ: обновление конфига НЕ применилось — раскладка завершилась с ошибкой (см. выше)."
        Write-Host "  В ~/.claude остался ПРЕДЫДУЩИЙ конфиг; твои ключи, память и история сессий сохранены."
        Write-Host "  Запусти установку повторно после устранения причины ошибки."
    } else {
        Write-Host "Конфиг не развернулся — раскладка завершилась с ошибкой (см. выше)."
    }
    exit 1
}

# H1: неуспешный restore НЕ маскируется под зелёный успех — честный ненулевой выход,
# снапшот с данными юзера сохранён (путь напечатан выше).
if ($restoreFailed) {
    Write-Host "Конфиг развёрнут, но восстановление твоих данных НЕ завершено — см. предупреждение выше."
    exit 1
}

if ($dstPresent) {
    Write-Host "OK: конфиг развёрнут. Не забудь заполнить ~/.claude/.credentials.master.env"
    exit 0
}
Write-Host "Конфиг не развернулся (~/.claude пуст) — смотри лог выше."
exit 1
