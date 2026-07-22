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

# === РЕДИЗАЙН: config НИКОГДА не стирает и не переносит ~/.claude ===
# Пользовательские данные ОСТАЮТСЯ НА МЕСТЕ. Мы лишь раскладываем НАШУ базу ПОВЕРХ
# существующего ~/.claude копированием (merge), НИКОГДА не перенося и не стирая всё
# дерево. Два режима merge:
#   add-missing (HM_ADDITIVE=1)  — robocopy /XC /XN /XO: докладываем ТОЛЬКО отсутствующие
#                                  файлы; существующие пользовательские НЕ трогаем.
#   repair      (HM_ADDITIVE≠1)  — robocopy без /XC: перезаписываем НАШИ базовые файлы
#                                  свежими; пользовательское (preserve-list) исключено.
# В ОБОИХ режимах preserve-list (/XF имена+globs, /XD каталоги) защищает ключи, память,
# историю сессий, локальные настройки и ~/CLAUDE.md — они не перезаписываются даже в repair.
# Механизм snapshot/restore/rescue/fingerprint УДАЛЁН — без wipe он не нужен (именно он
# в инциденте затирал реальный ~/.claude). Полная копия-бэкап делается ПЕРВОЙ операцией
# как сейф-нет; её неполнота НЕ фатальна (оригинал на месте).
#
# Режим решает MAIN (install-mode.js/main.js) живой детекцией ФС и, для repair, явным
# подтверждением (HM_REPAIR + HM_REPAIR_CONFIRMED), и сообщает сюда через HM_ADDITIVE.
$ADDITIVE = ($env:HM_ADDITIVE -eq '1')
$claudeHome = Join-Path $env:USERPROFILE '.claude'
$preExisting = @{}      # скиллы, БЫВШИЕ до нашей раскладки (для консервативного прунинга)
$pruneDisabled = $false # сбой перечисления/копирования → прунинг ПОЛНОСТЬЮ выключен
$installFailed = $false

# preserve-list — ПОЛЬЗОВАТЕЛЬСКОЕ, НИКОГДА не перезаписываем (ни в add-missing, ни в repair).
# Glob-aware: chats.db* — история чатов (FTS5 + -wal/-shm/-journal, ~30МБ),
# tg_session.session* — Telegram-авторизация (+ -wal/-shm/-journal). settings.local.json —
# локальные настройки юзера. settings.json (НАШ базовый) в список НЕ входит: add-missing в
# обычном режиме, overwrite в repair. ~/CLAUDE.md обрабатывается отдельно (только-если-нет).
$excludeNames = @('.credentials.master.env', '.credentials.json', 'settings.local.json', 'MEMORY.md',
                  'chats.db*', 'tg_session.session*')
$excludeDirs  = @('memory', 'projects', 'todos', 'shell-snapshots')

# --- источник конфига (dry-run ветвится ДО clone/fetch/reset) ---
$bundled = $env:HM_BUNDLED_CONFIG
$haveBundled = [bool]($bundled -and (Test-Path (Join-Path $bundled 'install.ps1')))

if ($DRY) {
    if ($haveBundled) { Write-Host "  [dry-run] Источник: встроенный конфиг (офлайн) $bundled" }
    else { Write-Host "  [dry-run] WOULD: git clone/fetch конфига с GitHub (в dry-run НЕ выполняется)" }
    Write-Host "  [dry-run] WOULD: копия-бэкап ~/.claude → ~/.claude.backup.<stamp> (сейф-нет, КОПИЯ, НЕ move; неполнота не фатальна)"
    if ($ADDITIVE) { Write-Host "  [dry-run] WOULD (add-missing): merge-copy ТОЛЬКО недостающих файлов (robocopy /XC /XN /XO), существующее НЕ трогать; ~/.claude НЕ переносится и не стирается; preserve-list (/XF+/XD) исключён" }
    else { Write-Host "  [dry-run] WOULD (repair): перезаписать НАШИ базовые файлы свежими (robocopy без /XC), пользовательское (ключи/память/история/settings.local/CLAUDE.md) исключено; БЕЗ move/wipe" }
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

# Раскладываем из клонированного/вшитого source САМИ (merge-копией), НЕ через install.ps1
# (его backup-режим переносил всё ~/.claude в сторону — именно этот wipe удалён).
$srcClaude   = Join-Path $clone '.claude'
$srcClaudeMd = Join-Path $clone 'CLAUDE.md'
if (-not (Test-Path $srcClaude)) { Write-Host "Источник конфига (.claude) не найден: $srcClaude"; exit 1 }

Write-Host "Разворачиваю .claude в домашнюю папку..."

# === Полная копия-бэкап ~/.claude — сейф-нет, ПЕРВАЯ операция (КОПИЯ, не move) ===
# ВАЖНО: неполный бэкап НЕ фатален — оригинал ~/.claude НЕ переносится и не стирается,
# данные на месте. Залоченный файл (открыт Cursor/Claude) → robocopy /R:1 пропустит его;
# предупреждаем и ПРОДОЛЖАЕМ. Это принципиально иначе, чем раньше, где бэкап был
# единственной копией перед wipe и его неполнота означала потерю данных.
if (Test-Path $claudeHome) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupDir = "$claudeHome.backup.$stamp"
    Write-Host "Резервная копия ~/.claude → $backupDir ..."
    $backupOk = $true
    try {
        # M7: robocopy (не Copy-Item -Recurse) — PS 5.1 не longPathAware; /R:1 /W:1 — не
        # зависать на залоченном файле (дефолт robocopy — 1M ретраев по 30с).
        robocopy $claudeHome $backupDir /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { $backupOk = $false }
        $global:LASTEXITCODE = 0
        if (-not (Test-Path $backupDir)) { $backupOk = $false }
    } catch { $backupOk = $false }
    if (-not $backupOk) {
        Write-Host "ВНИМАНИЕ: полный бэкап ~/.claude снять не удалось (возможно, часть файлов занята — открыт Cursor/Claude)."
        Write-Host "  Это НЕ критично: оригинал ~/.claude НЕ переносится и НЕ стирается — твои данные на месте. Продолжаю."
    }
}

# Существовал ли рабочий конфиг ДО обновления — для честного финального рапорта.
$hadOldConfig = (Test-Path (Join-Path $claudeHome 'skills')) -or (Test-Path (Join-Path $claudeHome 'settings.json'))
New-Item -ItemType Directory -Force $claudeHome | Out-Null

# Какие скиллы БЫЛИ до раскладки — ПОЛНОЕ УСПЕШНОЕ перечисление обязательно.
# Любой сбой перечисления → прунинг ПОЛНОСТЬЮ выключен (никогда не удаляем чужое).
$skillsDirNow = Join-Path $claudeHome 'skills'
# корень skills ИЛИ дочерний skill — reparse point? Тогда merge НЕЛЬЗЯ пускать в skills:
# robocopy пойдёт ПО junction и в repair перезапишет ВНЕШНЮЮ цель (data-loss). Исключаем skills.
$skillsReparse = $false
try {
    if (Test-Path -LiteralPath $skillsDirNow) {
        $item = Get-Item -LiteralPath $skillsDirNow -Force -ErrorAction Stop
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            $skillsReparse = $true
            throw "skills — reparse point (junction/symlink), перечисление небезопасно"
        }
        # ВСЕ immediate-дети (включая файлы и symlink/junction — не только -Directory):
        # пред-существующий symlink-скилл иначе считался бы «нашим» и удалялся при снятом паке.
        # Дочерний reparse → тоже помечаем skillsReparse (merge не должен писать сквозь него).
        Get-ChildItem -Force -LiteralPath $skillsDirNow -ErrorAction Stop | ForEach-Object {
            $preExisting[$_.Name] = $true
            if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $skillsReparse = $true }
        }
    }
} catch {
    $pruneDisabled = $true
    Write-Host "  Перечисление существующих скиллов не удалось ($($_.Exception.Message)) — прунинг паков отключён (ничего не удаляем)."
}

# === Merge-copy НАШЕЙ базы ПОВЕРХ ~/.claude (БЕЗ переноса/стирания) ===
# add-missing: /XC /XN /XO — исключить Changed/Newer/Older, т.е. копировать лишь
#   ОТСУТСТВУЮЩИЕ в цели файлы; существующие любой версии (кастомизации, settings.json) не трогаем.
# repair:      без /XC/XN/XO — перезаписать НАШИ базовые файлы свежими (add missing тоже).
# /XF (preserve-имена+globs) и /XD (preserve-каталоги) в ОБОИХ режимах исключают
#   пользовательское — ключи/память/история/settings.local/tg_session НЕ перезаписываются.
# Если ~/.claude/skills (корень или дочерний skill) — reparse point, ИСКЛЮЧАЕМ skills из merge:
# иначе robocopy пойдёт ПО junction и в repair перезапишет внешнюю цель. /XJ — не рекурсировать
# в junction-точки нигде в дереве (defense-in-depth; наш source junction-ов не содержит).
$mergeXD = $excludeDirs
if ($skillsReparse) {
    $mergeXD = @($excludeDirs) + @('skills')
    Write-Host "  ~/.claude/skills — reparse point (symlink/junction): пропускаю skills в раскладке (внешняя цель не тронута; наши скиллы туда не докладываю)."
}
if ($ADDITIVE) {
    Write-Host "Добавляю только НЕДОСТАЮЩИЕ файлы конфига (существующее сохраняю)..."
    robocopy $srcClaude $claudeHome /E /XC /XN /XO /XJ /XF $excludeNames /XD $mergeXD | Out-Null
} else {
    Write-Host "Переустановка начисто: перезаписываю НАШИ базовые файлы свежими (пользовательское — ключи/память/история/CLAUDE.md — не трогаю)..."
    robocopy $srcClaude $claudeHome /E /XJ /XF $excludeNames /XD $mergeXD | Out-Null
}
if ($LASTEXITCODE -ge 8) {
    $installFailed = $true; $pruneDisabled = $true
    Write-Host "robocopy раскладки конфига вернул код $LASTEXITCODE — часть файлов не скопирована; прунинг паков отключён."
}
$global:LASTEXITCODE = 0

# settings.json — НАШ базовый: в add-missing robocopy /XC пропускает существующий (добавит,
# если не было); в repair — перезаписывает свежим. settings.local.json (пользовательский) —
# в preserve-list, цел ВСЕГДА. Semver-мерж JSON намеренно НЕ делаем (риск сломать конфиг).

# CLAUDE.md в корне профиля — ПОЛЬЗОВАТЕЛЬСКИЙ: добавляем ТОЛЬКО если отсутствует (в ОБОИХ
# режимах — не затираем правки юзера даже в repair). Сбой копирования → честный провал.
$profileClaudeMd = Join-Path $env:USERPROFILE 'CLAUDE.md'
if ((Test-Path $srcClaudeMd) -and -not (Test-Path $profileClaudeMd)) {
    try { Copy-Item -Force $srcClaudeMd $profileClaudeMd -ErrorAction Stop }
    catch { $installFailed = $true; $pruneDisabled = $true; Write-Host "ВНИМАНИЕ: не удалось скопировать ~/CLAUDE.md ($($_.Exception.Message))." }
}
# credentials-шаблон — только если ключей ещё нет (в ОБОИХ режимах: preserve-list).
$srcEnvTpl = Join-Path $clone '.credentials.template.env'
$dstEnv    = Join-Path $claudeHome '.credentials.master.env'
if ((Test-Path $srcEnvTpl) -and -not (Test-Path $dstEnv)) {
    try { Copy-Item -Force $srcEnvTpl $dstEnv -ErrorAction Stop }
    catch { $installFailed = $true; $pruneDisabled = $true; Write-Host "ВНИМАНИЕ: не удалось скопировать шаблон credentials ($($_.Exception.Message))." }
}
if (-not $installFailed) {
    if ($ADDITIVE) { Write-Host "Готово: добавлено недостающее, существующее сохранено." }
    else { Write-Host "Готово: наши базовые файлы обновлены, пользовательские данные (ключи/память/история) на месте." }
}

# --- фильтрация скиллов по выбранным наборам (пакам) ---
# Прунятся ТОЛЬКО скиллы, входящие в какой-то пак, но чей пак не выбран.
# core и скиллы вне всех паков остаются всегда.
# fail-closed: сбой перечисления/копирования ($pruneDisabled) или провал раскладки
# ($installFailed) → прунинг НЕ выполняется вовсе (лучше лишний скилл, чем удалённый чужой).
if ($env:HM_KEEP_SKILLS -and $env:HM_ALL_PACK_SKILLS) {
    if ($pruneDisabled -or $installFailed) {
        Write-Host "Прунинг паков пропущен (fail-closed): раскладка/перечисление не подтверждены. Удалено: 0."
    } else {
        $keep = @{}; $env:HM_KEEP_SKILLS.Split(',') | ForEach-Object { if ($_) { $keep[$_] = $true } }
        $packAll = @{}; $env:HM_ALL_PACK_SKILLS.Split(',') | ForEach-Object { if ($_) { $packAll[$_] = $true } }
        $skillsDir = Join-Path $env:USERPROFILE '.claude\skills'
        # reparse-проверка skills-каталога: junction/symlink на месте ~/.claude/skills
        # уводит Remove-Item в ЧУЖУЮ цель.
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
                # В ОБОИХ режимах НЕ удаляем скиллы, которые были у юзера ДО нашей раскладки
                # (не наши — не трогаем, даже в repair). $preExisting захвачен до merge в любом
                # режиме; сбой захвата → $pruneDisabled → сюда не доходим. Пустой хеш (skills не
                # было до нас) → всё тут доложено нами → прунится по снятому паку. Удаляем только
                # доложенное этим прогоном и чей пак снят.
                $weAdded = -not $preExisting.ContainsKey($_.Name)
                if ($packAll.ContainsKey($_.Name) -and -not $keep.ContainsKey($_.Name) -and $weAdded) {
                    Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
                    $removed++
                }
            }
            Write-Host "Скиллы отфильтрованы по выбранным наборам (убрано: $removed)."
        }
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
    # Раскладка упала. Пользовательские данные НЕ тронуты (мы их не переносим/не стираем).
    if ($hadOldConfig -and $dstPresent) {
        Write-Host "ВНИМАНИЕ: обновление конфига применилось НЕ полностью — часть файлов не скопирована (см. выше)."
        Write-Host "  Твои ключи, память и история сессий НЕ тронуты (остались на месте)."
        Write-Host "  Запусти установку повторно после устранения причины ошибки."
    } else {
        Write-Host "Конфиг не развернулся — раскладка завершилась с ошибкой (см. выше)."
    }
    exit 1
}

if ($dstPresent) {
    # #19: маркер ЗАВЕРШЁННОСТИ — детекция config в main.js считает «установлено» по
    # нему, а не по наличию одной папки skills. Иначе оборванная установка (частичный
    # ~/.claude/skills) выглядела завершённой, авто-снимала галку, и повторный запуск
    # НЕ доразворачивал конфиг. Пишем в самом конце, после успешной раскладки.
    try { Set-Content -Path (Join-Path $dst '.hamidun-config-complete') -Value 'ok' -NoNewline -ErrorAction Stop } catch {}
    Write-Host "OK: конфиг развёрнут. Не забудь заполнить ~/.claude/.credentials.master.env"
    exit 0
}
Write-Host "Конфиг не развернулся (~/.claude пуст) — смотри лог выше."
exit 1
