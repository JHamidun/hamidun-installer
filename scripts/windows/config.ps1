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
    # #7: НЕ доверяем ранее существующему репо — атакующий (medium, тот же юзер) мог пред-
    # создать $clone\.git с core.fsmonitor/hooksPath = payload → code-exec под нашим git.
    # Всегда СВЕЖИЙ clone + hardening-флаги (командные -c перебивают repo-local config).
    # credential.helper ПУСТОЙ + запрет интерактива — иначе Git Credential Manager
    # (он на Windows стоит по умолчанию) поднимает ГРАФИЧЕСКОЕ окно «введите логин»
    # при любом отказе доступа: прокси, перехват трафика, лимит GitHub. Установщик
    # ждал бы ответа ВЕЧНО — то же зависание, что было с вопросом unzip, только
    # окно может всплыть за окном установщика и остаться незамеченным.
    # Репозиторий конфига ПУБЛИЧНЫЙ: любой запрос кредов = сломанная ситуация,
    # и правильный исход — быстро упасть с понятной ошибкой, а не висеть.
    $gitHard = @('-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-c','core.symlinks=false',
                 '-c','credential.helper=','-c','credential.interactive=false')
    if (Test-Path $clone) { Remove-Item -Recurse -Force $clone -ErrorAction SilentlyContinue }
    Write-Host "Скачиваю конфиг с GitHub ($url)..."
    New-Item -ItemType Directory -Force (Split-Path $clone) | Out-Null
    git @gitHard clone --depth 1 -b $branch $url $clone
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
        # /XJ — НЕ рекурсировать по junction/symlink-каталогам внутри ~/.claude: иначе бэкап
        # уходит по reparse-точке (напр. junction на сам профиль или на сетевую папку) и растёт
        # бесконечно — шаг «Резервная копия» зависает/забивает диск. Симметрично merge (167/170).
        robocopy $claudeHome $backupDir /E /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS /NP /XF '.credentials.master.env' '.credentials.json' 'tg_session.session*' | Out-Null
        if ($LASTEXITCODE -ge 8) { $backupOk = $false }
        $global:LASTEXITCODE = 0
        if (-not (Test-Path $backupDir)) { $backupOk = $false }
    } catch { $backupOk = $false }
    if (-not $backupOk) {
        Write-Host "ВНИМАНИЕ: полный бэкап ~/.claude снять не удалось (возможно, часть файлов занята — открыт Cursor/Claude)."
        Write-Host "  Это НЕ критично: оригинал ~/.claude НЕ переносится и НЕ стирается — твои данные на месте. Продолжаю."
    }
    # РЕТЕНЦИЯ: держим 3 ПОСЛЕДНИЕ копии. Без неё каждый прогон (repair/повтор/ручной
    # перезапуск) оставлял ПОЛНУЮ копию ~/.claude навсегда — гигабайты, о которых юзер не
    # знает и которые никто не чистит. Имена $claudeHome.backup.<YYYYMMDD-HHmmss> →
    # лексикографическая сортировка = хронологическая. Зеркало config.sh (mac).
    try {
        Get-ChildItem -Path (Split-Path $claudeHome -Parent) -Directory -Filter ((Split-Path $claudeHome -Leaf) + '.backup.*') -ErrorAction Stop |
            Sort-Object Name -Descending | Select-Object -Skip 3 |
            ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
    } catch { Write-Host "  (старые копии ~/.claude.backup.* не удалось перечислить — оставляю как есть)" }
}

# Существовал ли рабочий конфиг ДО обновления — для честного финального рапорта.
$hadOldConfig = (Test-Path (Join-Path $claudeHome 'skills')) -or (Test-Path (Join-Path $claudeHome 'settings.json'))
New-Item -ItemType Directory -Force $claudeHome | Out-Null

# Какие скиллы БЫЛИ до раскладки — ПОЛНОЕ УСПЕШНОЕ перечисление обязательно.
# Любой сбой перечисления → прунинг ПОЛНОСТЬЮ выключен (никогда не удаляем чужое).
$skillsDirNow = Join-Path $claudeHome 'skills'
# КОРЕНЬ skills — reparse point? Тогда merge НЕЛЬЗЯ пускать в skills целиком:
# robocopy пойдёт ПО junction и в repair перезапишет ВНЕШНЮЮ цель (data-loss). Исключаем skills.
# ДОЧЕРНИЙ skill-reparse (симлинк одной папки скилла на репо/облако) — НЕ повод пропускать ВЕСЬ
# каталог: одна ссылка обнуляла раскладку всех ~330 скиллов. Исключаем ТОЧЕЧНО по имени.
$skillsReparse = $false   # reparse-point именно КОРЕНЬ ~/.claude/skills
$reparseSkills = @()      # дочерние скиллы-ссылки — исключаются поимённо
try {
    if (Test-Path -LiteralPath $skillsDirNow) {
        $item = Get-Item -LiteralPath $skillsDirNow -Force -ErrorAction Stop
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            $skillsReparse = $true
            throw "skills — reparse point (junction/symlink), перечисление небезопасно"
        }
        # ВСЕ immediate-дети (включая файлы и symlink/junction — не только -Directory):
        # пред-существующий symlink-скилл иначе считался бы «нашим» и удалялся при снятом паке.
        Get-ChildItem -Force -LiteralPath $skillsDirNow -ErrorAction Stop | ForEach-Object {
            $preExisting[$_.Name] = $true
            if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $reparseSkills += $_.Name }
        }
    }
} catch {
    $pruneDisabled = $true
    Write-Host "  Перечисление существующих скиллов не удалось ($($_.Exception.Message)) — прунинг паков отключён (ничего не удаляем)."
}

# Список скиллов, разложенных НАМИ в предыдущий прогон. Без него снятие пака работает ровно
# один раз (на чистой машине): на повторном прогоне наши вчерашние скиллы уже «пред-существуют»
# и прунинг молча ничего не удаляет. Файла нет / нечитаем → консервативное поведение как раньше.
$ourListPath = Join-Path $claudeHome '.hamidun-skills.txt'
$ourPrev = @{}
if (Test-Path -LiteralPath $ourListPath) {
    try { Get-Content -LiteralPath $ourListPath -ErrorAction Stop | ForEach-Object { if ($_) { $ourPrev[$_.Trim()] = $true } } }
    catch { $ourPrev = @{} }
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
# Правило «не писать СКВОЗЬ reparse-point» действует НЕ только для skills: пакет везёт agents,
# commands, rules, hooks, tools, config, templates… Любой из них юзер мог слинковать на свой
# git-репо (mklink /J) — robocopy в repair ушёл бы по ссылке и затёр его файлы во ВНЕШНЕЙ цели.
# Поэтому исключаем ВСЕ immediate-дети ~/.claude, помеченные ReparsePoint. Сбой проверки →
# fail-closed: не пускаем merge ни в один наш подкаталог и честно проваливаем компонент.
$reparseKids = @(); $reparseFiles = @(); $kidScanOk = $true
try {
    Get-ChildItem -Force -LiteralPath $claudeHome -ErrorAction Stop | ForEach-Object {
        if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            if ($_.PSIsContainer) { $reparseKids += $_.Name } else { $reparseFiles += $_.Name }
        }
    }
} catch { $kidScanOk = $false }
if (-not $kidScanOk) {
    $reparseKids = @(Get-ChildItem -Force -Directory -LiteralPath $srcClaude -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    Write-Host "  Проверка reparse-точек в ~/.claude не удалась — подкаталоги пропущены (внешние цели не тронуты)."
    $installFailed = $true; $pruneDisabled = $true
}
foreach ($n in $reparseKids) { Write-Host "  ~/.claude/$n — reparse point (symlink/junction): пропускаю в раскладке (внешняя цель не тронута)." }
# Файл-ссылка (напр. settings.json → репо юзера) — тем же правилом, через /XF.
if ($reparseFiles.Count) { $excludeNames = @($excludeNames) + $reparseFiles }
$mergeXD = @($excludeDirs) + $reparseKids
$skillsSkipped = $false
if ($skillsReparse) {
    $mergeXD = @($excludeDirs) + @('skills') + $reparseKids
    $skillsSkipped = $true
    Write-Host "  ~/.claude/skills — reparse point (symlink/junction): пропускаю skills в раскладке (внешняя цель не тронута; наши скиллы туда не докладываю)."
} elseif ($reparseSkills.Count) {
    # Слинкованы отдельные ДОЧЕРНИЕ скиллы — исключаем только их, остальные раскладываем.
    foreach ($n in $reparseSkills) { $mergeXD += (Join-Path (Join-Path $srcClaude 'skills') $n) }
    Write-Host "  Скиллы-ссылки пропущены поимённо (внешние цели не тронуты): $($reparseSkills -join ', ')"
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

# Фиксируем, какие скиллы разложили МЫ — чтобы на СЛЕДУЮЩЕМ прогоне снятие пака реально удаляло
# их, а не считало «пред-существующими» (иначе прунинг — молчаливый no-op после первой установки).
# КРИТИЧНО (data-loss): в список идёт ТОЛЬКО реально доложенное нами =
# (скиллы источника МИНУС $preExisting) ∪ прошлый список $ourPrev.
# Писать ВЕСЬ список источника нельзя: пред-существующий каталог ЮЗЕРА, чьё имя совпало
# с нашим паком (git-workflow, security-audit, database-design…), на следующем прогоне
# считался бы «нашим» ($ourPrev.ContainsKey) и сносился Remove-Item -Recurse при снятом
# паке — вместе с файлами пользователя, которые первый прогон корректно сберёг.
# Объединение с $ourPrev обязательно: без него на 2-м прогоне разность пуста (наши
# вчерашние скиллы уже «пред-существуют») и снятие пака переставало бы работать с 3-го.
# $pruneDisabled (перечисление $preExisting не удалось) → список НЕ обновляем: разность
# от неполного $preExisting пометила бы скиллы юзера как наши. Старый файл остаётся.
# Не записалось → прунинг просто останется консервативным (fail-safe, ничего чужого не удалим).
if (-not $installFailed -and -not $skillsReparse -and -not $pruneDisabled) {
    try {
        $srcSkills = Join-Path $srcClaude 'skills'
        if (Test-Path -LiteralPath $srcSkills) {
            $ourNow = @{}
            Get-ChildItem -Directory -LiteralPath $srcSkills -ErrorAction Stop | ForEach-Object {
                if (-not $preExisting.ContainsKey($_.Name)) { $ourNow[$_.Name] = $true }
            }
            foreach ($n in @($ourPrev.Keys)) { $ourNow[$n] = $true }
            Set-Content -LiteralPath $ourListPath -Value @($ourNow.Keys | Sort-Object) -Encoding UTF8 -ErrorAction Stop
        }
    } catch { }
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
                # было до нас) → всё тут доложено нами → прунится по снятому паку. Наше —
                # доложенное ЭТИМ прогоном ЛИБО записанное в .hamidun-skills.txt прошлым
                # (иначе снятие пака работало бы ровно один раз, на чистой машине).
                $weAdded = (-not $preExisting.ContainsKey($_.Name)) -or $ourPrev.ContainsKey($_.Name)
                if ($packAll.ContainsKey($_.Name) -and -not $keep.ContainsKey($_.Name) -and $weAdded) {
                    Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
                    $removed++
                }
            }
            if ($removed -gt 0) { Write-Host "Скиллы отфильтрованы по выбранным наборам (убрано: $removed)." }
            else { Write-Host "Скиллы отфильтрованы по выбранным наборам (убрано: 0) — под снятые наборы нашего ничего не нашлось, пред-существующее не трогаю." }
        }
    }
}

# --- стартовый проект из вшитых ассетов (идемпотентно: существующий НЕ перезаписываем) ---
$starterSrc = ''
if ($env:HM_ASSETS) { $cand = Join-Path $env:HM_ASSETS 'starter-project'; if (Test-Path $cand) { $starterSrc = $cand } }
if ($starterSrc) {
    $starterDst = Join-Path $env:USERPROFILE 'HamidunStart'
    # ДОКЛАДЫВАЕМ НЕДОСТАЮЩЕЕ, а не пропускаем папку целиком.
    # Раньше здесь было «папка есть → не перезаписываю», и человек оставался БЕЗ файлов:
    # ~/HamidunStart появляется не только отсюда — её создаёт пустой кнопка «Открыть
    # VS Code» (main.js: mkdirSync перед запуском редактора, чтобы он открыл воркспейс,
    # а не безымянное окно), её могла оставить прошлая установка, её мог создать сам
    # человек. Дальше памятка говорит «открой PROMPTS.md» — а его там нет, и ученик
    # пишет «извини, я не нахожу файл».
    # Правило: существующие файлы НЕ трогаем (в них могла быть работа человека),
    # отсутствующие — кладём. Перезапись остаётся невозможной, пропажа — тоже.
    if (-not (Test-Path $starterDst)) {
        try { New-Item -ItemType Directory -Force -Path $starterDst -ErrorAction Stop | Out-Null }
        catch { Write-Host "Стартовый проект: не удалось создать $starterDst — $($_.Exception.Message)" }
    }
    if (Test-Path $starterDst) {
        $added = 0; $kept = 0; $failed = 0
        try {
            Get-ChildItem -LiteralPath $starterSrc -Force -Recurse -File -ErrorAction Stop | ForEach-Object {
                $rel = $_.FullName.Substring($starterSrc.Length).TrimStart('\', '/')
                $dstFile = Join-Path $starterDst $rel
                if (Test-Path -LiteralPath $dstFile) { $kept++; return }
                $dstDir = Split-Path $dstFile -Parent
                try {
                    if ($dstDir -and -not (Test-Path -LiteralPath $dstDir)) {
                        New-Item -ItemType Directory -Force -Path $dstDir -ErrorAction Stop | Out-Null
                    }
                    Copy-Item -LiteralPath $_.FullName -Destination $dstFile -ErrorAction Stop
                    $added++
                } catch { $failed++ }
            }
        } catch { Write-Host "Стартовый проект: не удалось перечислить файлы — $($_.Exception.Message)" }

        if ($added -gt 0 -and $kept -eq 0) { Write-Host "Стартовый проект создан: $starterDst (файлов: $added)" }
        elseif ($added -gt 0)              { Write-Host "Стартовый проект дополнен: $starterDst (добавлено: $added, твоё не тронуто: $kept)" }
        elseif ($kept -gt 0)               { Write-Host "Стартовый проект уже полный: $starterDst — ничего не менял." }
        if ($failed -gt 0) { Write-Host "  ВНИМАНИЕ: не удалось скопировать файлов: $failed" }

        # Памятка прямым текстом велит открыть PROMPTS.md — проверяем именно его.
        if (-not (Test-Path -LiteralPath (Join-Path $starterDst 'PROMPTS.md'))) {
            Write-Host "  ВНИМАНИЕ: PROMPTS.md в $starterDst не появился."
            Write-Host "  Возьми его вручную: $starterSrc"
        }
    }
} else {
    # Раньше отсутствие ассетов проходило совершенно молча: блок просто не выполнялся,
    # и никто — ни человек, ни лог — не узнавал, что стартового проекта не будет.
    Write-Host "Стартовый проект НЕ создан: не найдены вшитые ассеты (HM_ASSETS не задан или в нём нет starter-project)."
    Write-Host "  Памятка ссылается на PROMPTS.md из этой папки — без неё первый шаг не выполнить."
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
    # --- РАНТАЙМ: то, что живёт НЕ в файлах -----------------------------------------------
    # Разложить файлы — ещё не «конфиг работает». Три вещи существуют только как состояние
    # машины, и копирование их не создаёт:
    #   • бинарь браузера Playwright (пакет python ставит pydeps, БРАУЗЕР — нет);
    #     на него завязаны 42 скилла: карточки, экспорт PNG/PDF/PPTX, деки, скриншот-тесты;
    #   • регистрация маркетплейсов плагинов (объявлено 29 плагинов, но свежая машина
    #     не знает, откуда их брать — claude plugin list пуст);
    #   • node_modules для скилла dev-browser (иначе его server.sh делает npm install в бою).
    # Именно это ученики и «донастраивали сами». Лечение (scripts/setup_runtime.py) уже
    # ехало в паке и вызывалось из install.sh/install.ps1 — но ТЕМ маршрутом ставят с
    # GitHub, а через установщик раскладку делает ЭТОТ скрипт, и здесь вызова не было.
    # Идемпотентно: повторный прогон занимает секунды и ничего не меняет.
    $runtimeScript = Join-Path $dst 'scripts\setup_runtime.py'
    if (Test-Path -LiteralPath $runtimeScript) {
        # Ищем python ПО АБСОЛЮТНЫМ ПУТЯМ, а не только через Get-Command. Наш PATH здесь
        # урезан по соображениям безопасности (только HKLM + админ-каталоги), а python
        # ставится в профиль пользователя — Get-Command его не видит, и весь рантайм
        # молча пропускался: ни браузера Playwright, ни маркетплейсов плагинов.
        # Заодно пропускаем Store-заглушку из WindowsApps: она пишет в stderr и роняет шаг.
        $pyPath = $null
        foreach ($name in 'python', 'python3') {
            $c = Get-Command $name -ErrorAction SilentlyContinue
            if ($c -and $c.Source -notmatch 'WindowsApps') { $pyPath = $c.Source; break }
        }
        if (-not $pyPath) {
            foreach ($p in @("$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
                             "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
                             "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
                             "$env:ProgramFiles\Python313\python.exe",
                             "$env:ProgramFiles\Python312\python.exe")) {
                if (Test-Path -LiteralPath $p) { $pyPath = $p; break }
            }
        }
        # claude ставится через npm в профиль пользователя и по той же причине не виден.
        # setup_runtime ищет его через PATH, поэтому кладём каталог в PATH ПРОЦЕССА —
        # без этого регистрация маркетплейсов пропускается с бодрым «плагины подтянутся
        # при первом запуске», хотя сами они не подтягиваются.
        foreach ($cand in @("$env:APPDATA\npm", "$env:USERPROFILE\.local\bin")) {
            if ((Test-Path -LiteralPath $cand) -and ($env:Path.Split(';') -notcontains $cand)) {
                $env:Path = $env:Path.TrimEnd(';') + ';' + $cand
            }
        }
        if ($pyPath) {
            $pyRt = [pscustomobject]@{ Path = $pyPath }
            Write-Host ""
            Write-Host "Довожу рантайм: браузер Playwright, маркетплейсы плагинов, node_modules..."
            try {
                & $pyRt.Path $runtimeScript
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "  Рантайм доехал НЕ полностью — часть скиллов упадёт при первом запуске."
                    Write-Host "  Что именно: python `"$runtimeScript`" --check"
                    Write-Host "  Доделать:   python `"$runtimeScript`""
                }
            } catch {
                Write-Host "  Рантайм довести не удалось: $($_.Exception.Message)"
                Write-Host "  Доделать вручную: python `"$runtimeScript`""
            }
            $global:LASTEXITCODE = 0
        } else {
            Write-Host "Python не найден — рантайм не доведён (браузер Playwright и плагины)."
            Write-Host "  После установки Python запусти: python `"$runtimeScript`""
        }
    }

    # #19: маркер ЗАВЕРШЁННОСТИ — детекция config в main.js считает «установлено» по
    # нему, а не по наличию одной папки skills. Иначе оборванная установка (частичный
    # ~/.claude/skills) выглядела завершённой, авто-снимала галку, и повторный запуск
    # НЕ доразворачивал конфиг. Пишем в самом конце, после успешной раскладки.
    try { Set-Content -Path (Join-Path $dst '.hamidun-config-complete') -Value 'ok' -NoNewline -ErrorAction Stop } catch {}
    if ($skillsSkipped) {
        # Честный статус: exit 0 (повтор ничего не изменит — исключение детерминировано),
        # но НЕ делаем вид, что скиллы разложены.
        Write-Host "ВНИМАНИЕ: конфиг развёрнут, НО скиллы НЕ разложены — ~/.claude/skills это ссылка (внешняя цель не тронута)."
        Write-Host "  Скопируй их вручную: $srcClaude\skills  ->  <цель ссылки>"
    }
    Write-Host "OK: конфиг развёрнут. Не забудь заполнить ~/.claude/.credentials.master.env"
    exit 0
}
Write-Host "Конфиг не развернулся (~/.claude пуст) — смотри лог выше."
exit 1
