# Verify — финальная диагностика установки (Windows)
# Печатает строки вида "CHECK ok <ярлык>" / "CHECK fail <ярлык>" — их ловит рендерер
# и рисует чеклист на финальном экране. Диагностика НЕ проваливает установку: всегда exit 0.
$ErrorActionPreference = 'Continue'
function Update-Path {
    # SECURITY (#4): PATH для elevated-скрипта — ТОЛЬКО HKLM (Machine) + наши
    # админ-owned фиксированные каталоги. НИКОГДА не читаем HKCU (User) PATH: на чистой
    # машине medium-integrity процесс того же юзера может дописать туда каталог с
    # подложенным git/node/python/winget и исполнить его под нашим elevated-токеном.
    # claude (npm-prefix / ~/.local\bin) находим ниже по абсолютному пути (Find-ClaudeBinary).
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

# Список выбранных компонентов (id через запятую, из HM_SELECTED). Снятые компоненты
# помечаем как "skip", а не "fail", чтобы на экране «Готово» не было ложных крестиков.
# Переменная не задана => старый вызов установщика: проверяем всё, как раньше.
$SelectedIds = @()
if ($env:HM_SELECTED) {
    $SelectedIds = $env:HM_SELECTED.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}
function Test-Selected([string]$id) {
    if (-not $env:HM_SELECTED) { return $true }
    return ($SelectedIds -contains $id)
}

# Поиск бинаря claude — тот же, что в claude.ps1 (не доверяем только PATH). Определён ДО блока
# починок: им пользуются и он, и проверка ниже.
function Find-ClaudeBinary {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # Глобальный npm-prefix: там лежит claude.cmd после `npm install -g`.
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        try {
            $prefix = (npm config get prefix 2>$null | Select-Object -First 1)
            if ($prefix) { $prefix = $prefix.Trim() }
            if ($prefix -and (Test-Path $prefix)) {
                foreach ($name in @('claude.cmd', 'claude.exe', 'claude')) {
                    $p = Join-Path $prefix $name
                    if (Test-Path $p) { return $p }
                }
            }
        } catch { }
    }

    # Нативный установщик кладёт бинарь в ~/.local/bin.
    $localBin = Join-Path $env:USERPROFILE '.local\bin'
    foreach ($name in @('claude.exe', 'claude.cmd', 'claude')) {
        $p = Join-Path $localBin $name
        if (Test-Path $p) { return $p }
    }

    return $null
}

# --- every-run repairs (B) ---
# === ПОЧИНКИ ПРОФИЛЯ ПОЛЬЗОВАТЕЛЯ — на КАЖДОМ прогоне, независимо от галочек ====================
# Повторный запуск снимает галочки со всего, что установщик нашёл на диске, — и скрипты
# компонентов (config.ps1, claude.ps1, nomad.ps1, pydeps.ps1) для таких людей не запускаются
# ВОВСЕ. А именно им нужны починки, которые живут в этих скриптах: чистка settings.json
# (плагины без токена, правила, на которые Claude Code ругается при каждом старте), каталог
# пака CATALOG.md и сводка для финального экрана, политика PowerShell и PATH для claude, PATH
# для ~/.local\bin (команда nmd) и для Python. Без этого блока исправления получали бы только
# те, кто сам поставил галочки заново. Шаг verify скрытый, включён по умолчанию и идёт
# последним — он есть в каждом прогоне.
# Что здесь можно: только чтение/запись HKCU и файлов в профиле пользователя (settings.json
# с копией рядом, checks.json, ~/.codex/AGENTS.md, PATH пользователя, политика области
# CurrentUser). Блок самодостаточен: границы — строки «every-run repairs (B)» и «end». Ни claude,
# ни python, ни nmd отсюда НЕ запускаются: под администратором это был бы запуск user-writable
# бинаря. Проба claude из PowerShell остаётся в claude.ps1 (через де-элевацию).
# Компонент, выбранный в ЭТОМ прогоне, свою починку уже сделал сам — здесь не дублируем (кроме
# карты конфига для Codex: она идемпотентна, см. п. 5).
$DRY = [bool]$env:HM_DRY_RUN
$psVerdictLive = $null      # вердикт «claude из PowerShell», посчитанный ЗДЕСЬ (claude не выбран)
if ($DRY) {
    Write-Host "  [dry-run] WOULD: починить в профиле известные дефекты настроек Claude Code, PATH (nmd, python, claude), политику PowerShell и положить AGENTS.md пака для Codex — без галочек, на каждом запуске"
} else {
    $repairLibs = $false
    try {
        . (Join-Path $PSScriptRoot '_userpath.ps1')
        . (Join-Path $PSScriptRoot '_cfgmigrate.ps1')
        . (Join-Path $PSScriptRoot '_claudeenv.ps1')
        $repairLibs = $true
    } catch { Write-Host "Починки профиля пропущены: не загрузились вспомогательные скрипты ($($_.Exception.Message))." }
    if ($repairLibs) {
        $userHome = $env:USERPROFILE
        # 1. Настройки Claude Code и опись пака. Нужны, только если config НЕ ставился в этом
        #    прогоне (иначе их уже сделал config.ps1). CATALOG.md кладём лишь когда пак под
        #    рукой (в лёгком издании его нет) и в ~/.claude каталога ещё нет: раскладка не
        #    делалась, и каталог другой версии пака описывал бы не то, что там лежит.
        $configSelected = Test-Selected 'config'
        if (-not $configSelected) {
            try {
                $sj = Join-Path $userHome '.claude\settings.json'
                if (Test-Path -LiteralPath $sj -PathType Leaf) {
                    Invoke-HmSettingsMigration -Path $sj -Fresh $false -MarkerPath (Join-Path $userHome '.hamidun-setup\config-migrations.json')
                    $packDir = ''
                    if ($env:HM_BUNDLED_CONFIG -and (Test-Path -LiteralPath (Join-Path $env:HM_BUNDLED_CONFIG 'CATALOG.md') -PathType Leaf)) { $packDir = $env:HM_BUNDLED_CONFIG }
                    Write-HmConfigSummary -Clone $packDir -ClaudeHome (Join-Path $userHome '.claude') -SetupDir (Join-Path $userHome '.hamidun-setup') -OnlyIfMissing
                }
            } catch { Write-Host "Настройки Claude Code: починка не удалась ($($_.Exception.Message)) — на установку это не влияет." }
        }
        # 2. Команда nmd: Nomad кладёт шимы в ~/.local\bin, а в PATH пользователя этого каталога
        #    часто нет («Имя "nmd" не распознано» в новом окне терминала).
        try {
            $localBinDir = Join-Path $userHome '.local\bin'
            if (Test-Path -LiteralPath (Join-Path $localBinDir 'nmd.exe') -PathType Leaf) { [void](Add-HmUserPath $localBinDir) }
        } catch { Write-Host "PATH для nmd: не удалось ($($_.Exception.Message)) — на установку это не влияет." }
        # 3. Уже стоящий claude (галочка с него снята, claude.ps1 не запускался): та же починка, что
        #    делает claude.ps1 после установки, — PATH и политика выполнения PowerShell. Claude,
        #    про который известно, что он сломан, не трогаем. Без пробы: проба идёт только через
        #    де-элевацию, а её здесь не подключаем — вердикт 'unverified' или 'blocked'.
        $claudeSelected = Test-Selected 'claude'
        if (-not $claudeSelected) {
            try {
                $claudeBinFound = Find-ClaudeBinary
                $lastVerdict = $null
                try {
                    $cf0 = Join-Path $userHome '.hamidun-setup\checks.json'
                    if (Test-Path -LiteralPath $cf0 -PathType Leaf) {
                        $j0 = Get-Content -Raw -LiteralPath $cf0 | ConvertFrom-Json
                        if ($j0.claude) { $lastVerdict = [string]$j0.claude.verdict }
                    }
                } catch { }
                if ($claudeBinFound -and $lastVerdict -ne 'broken') {
                    Write-Host "claude уже стоит ($claudeBinFound) — проверяю для него PATH и политику PowerShell."
                    $psVerdictLive = Repair-HmClaudeUserEnv -Bin $claudeBinFound
                    Write-HmCheck 'claude-ps' $psVerdictLive
                }
            } catch { Write-Host "claude: починка PATH и политики не удалась ($($_.Exception.Message)) — на установку это не влияет." }
        }
        # 4. Команда python: если новый терминал находит заглушку Магазина, а настоящий Python
        #    стоит в привычном каталоге, он ставится в начало PATH пользователя.
        try { $knownPy = Find-HmKnownPython; if ($knownPy) { [void](Repair-HmPythonPath $knownPy) } }
        catch { Write-Host "PATH для python: не удалось ($($_.Exception.Message)) — на установку это не влияет." }
        # 5. Codex: AGENTS.md пака → ~/.codex/AGENTS.md. Нужен, когда пак под рукой: он вшит в полное
        #    издание, а в лёгком на руках его нет — тогда файл появится при установке конфига. Зовётся и
        #    при выбранном config: расширение Codex могло встать ПОЗЖЕ config.ps1 (порядок шагов не задан),
        #    а повтор безвреден — свой блок узнаётся, файл не меняется. Существующий файл человека не
        #    перезаписывается (дописывается отмеченный блок); исключений функция не бросает.
        if ($env:HM_BUNDLED_CONFIG) {
            [void](Install-HmCodexAgents -Source (Join-Path $env:HM_BUNDLED_CONFIG 'AGENTS.md') -UserHome $userHome)
        }
    }
}
# --- end ---

Write-Host "Финальная проверка установки..."

# --- Git ---
if (-not (Test-Selected 'git')) {
    Write-Host "CHECK skip Git"
} else {
    $gitOk = $false
    if (Get-Command git -ErrorAction SilentlyContinue) {
        try {
            $v = ("$(git --version 2>$null)").Trim()
            if ($v) { Write-Host "  git: $v"; $gitOk = $true }
        } catch { }
    }
    if ($gitOk) { Write-Host "CHECK ok Git" } else { Write-Host "CHECK fail Git" }
}

# --- Node ---
if (-not (Test-Selected 'node')) {
    Write-Host "CHECK skip Node"
} else {
    $nodeOk = $false
    if (Get-Command node -ErrorAction SilentlyContinue) {
        try {
            $v = ("$(node -v 2>$null)").Trim()
            if ($v) { Write-Host "  node: $v"; $nodeOk = $true }
        } catch { }
    }
    if ($nodeOk) { Write-Host "CHECK ok Node" } else { Write-Host "CHECK fail Node" }
}

# --- Claude CLI (бинарь ищет Find-ClaudeBinary, определён выше — не доверяем только PATH) ---
if (-not (Test-Selected 'claude')) {
    Write-Host "CHECK skip Claude CLI"
    # claude не ставился в этом прогоне, но блок починок выше мог проверить уже стоящий: берём
    # вердикт оттуда, а не из файла, где может лежать запись давнего прогона.
    $psVerdict = [string]$psVerdictLive
} else {
    # ОДИН факт — ОДИН стандарт доказательства. claude.ps1 проверяет claude ЗАПУСКОМ
    # (--version де-элевированно) и пишет вердикт в ~/.hamidun-setup/checks.json.
    # Здесь мы ПЕРЕНОСИМ его, а не выводим заново по наличию файла: наличие обёртки
    # ничего не доказывает (её оставляет и провалившаяся офлайн-установка), и «✓» по
    # файлу давало зелёную галочку при неработающем claude. Git/Node рядом тоже
    # проверяются запуском — исключения для claude быть не должно.
    $verdict = $null
    try {
        $cf = Join-Path $env:USERPROFILE '.hamidun-setup\checks.json'
        if (Test-Path -LiteralPath $cf) {
            $j = Get-Content -Raw -LiteralPath $cf | ConvertFrom-Json
            if ($j.claude) { $verdict = [string]$j.claude.verdict }
        }
    } catch { }
    $claudeBin = Find-ClaudeBinary
    if ($claudeBin) { Write-Host "  claude: $claudeBin" }
    if ($verdict -eq 'works') {
        Write-Host "CHECK ok Claude CLI"
    } elseif ($verdict -eq 'unverified') {
        # Установлен, но запуск подтвердить не удалось (де-элевация недоступна и т.п.).
        # НЕ ok (не врём про работу) и НЕ fail (не пугаем при вероятно рабочем) — skip
        # с пояснением; строку рендерер распознаёт тем же префиксом.
        Write-Host "CHECK skip Claude CLI (установлен, запуск не проверен)"
    } else {
        # broken ИЛИ вердикта нет вовсе (claude.ps1 не дошёл до записи) — не подтверждено.
        Write-Host "CHECK fail Claude CLI"
    }
    # Второй факт — запуск ИЗ PowerShell (терминал VS Code по умолчанию): там вместо
    # claude.cmd берётся claude.ps1, и его может не пустить политика выполнения скриптов.
    # Проверка выше этого не видит — она идёт через cmd. Отдельная строка появляется только
    # при доказанной беде: «работает» и «не проверено» лишним пунктом экран не засоряют.
    $psVerdict = ''
    try { if ($j -and $j.'claude-ps') { $psVerdict = [string]$j.'claude-ps'.verdict } } catch { }
}
if ($psVerdict -eq 'blocked') {
    Write-Host "  в PowerShell claude не запустится: политика выполнения скриптов не пускает claude.ps1 — набирай claude.cmd"
    Write-Host "CHECK fail Запуск claude в PowerShell"
} elseif ($psVerdict -eq 'broken') {
    Write-Host "  в PowerShell claude не ответил на --version (в cmd отвечает) — набирай claude.cmd"
    Write-Host "CHECK fail Запуск claude в PowerShell"
}

# --- Конфиг (~/.claude развёрнут?) ---
if (-not (Test-Selected 'config')) {
    Write-Host "CHECK skip Конфиг"
} else {
    # Признак «конфиг на месте» должен быть НЕ СЛАБЕЕ, чем факт успешной установки.
    # Раньше здесь стояло «settings.json ИЛИ skills» — дизъюнкция, которая зеленела на
    # ПОЛОВИНЕ разложенного дерева: config.ps1 копирует каталоги по одному, и установка,
    # оборвавшаяся после skills, давала «CHECK ok Конфиг». Человек видел галочку в
    # финальном чек-листе там, где конфига фактически не было.
    #
    # Теперь два независимых свидетеля:
    #   • квитанция установщика (~/.hamidun-setup/installed.json, пишет recordInstall
    #     ТОЛЬКО при успехе) — она и есть авторитетный ответ «доехало ли»;
    #   • содержимое: settings.json И skills — оба, а не любое из.
    # Расхождение между ними — само по себе диагноз, и его надо назвать вслух, а не
    # сглаживать в галочку.
    $claudeHome = Join-Path $env:USERPROFILE '.claude'
    $hasSettings = Test-Path (Join-Path $claudeHome 'settings.json')
    $hasSkills   = Test-Path (Join-Path $claudeHome 'skills')
    $receipt = Join-Path $env:USERPROFILE '.hamidun-setup\installed.json'
    $recorded = $false
    if (Test-Path $receipt) {
        try {
            $m = Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json
            $recorded = $null -ne $m.components.config
        } catch { $recorded = $false }
    }
    if ($hasSettings -and $hasSkills -and $recorded) {
        Write-Host "CHECK ok Конфиг"
    } elseif ($hasSettings -or $hasSkills) {
        $miss = @()
        if (-not $hasSettings) { $miss += 'settings.json' }
        if (-not $hasSkills)   { $miss += 'skills' }
        if (-not $recorded)    { $miss += 'запись об успешной установке' }
        Write-Host ("  конфиг разложен НЕ полностью, отсутствует: " + ($miss -join ', '))
        Write-Host "CHECK fail Конфиг"
    } else {
        Write-Host "CHECK fail Конфиг"
    }
}

# --- Python-пакеты (pydeps доехал?) ---
# Раньше этого блока не было вовсе, и весь класс молчаливых провалов pydeps —
# не поставившийся Playwright, недокачанные колёса, отвалившийся pip — не всплывал
# НИГДЕ: ни в чек-листе, ни в логе. Человек видел зелёный экран и узнавал о поломке
# позже, когда падал первый скилл, работающий с браузером.
#
# Проверяем ровно то, от чего зависят навыки, а не факт запуска pip: импортируется ли
# playwright и лежит ли распакованный Chromium в кэше. Диагностика, не блокировка.
if (-not (Test-Selected 'pydeps')) {
    Write-Host "CHECK skip Python-пакеты"
} else {
    $pyExe = $null
    foreach ($c in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'))) {
        if (Test-Path $c) { $pyExe = $c; break }
    }
    if (-not $pyExe) {
        $cmd = Get-Command python -ErrorAction SilentlyContinue
        # Заглушка Microsoft Store (WindowsApps) не является Python: она открывает магазин.
        if ($cmd -and $cmd.Source -and ($cmd.Source -notlike '*\WindowsApps\*')) { $pyExe = $cmd.Source }
    }
    if (-not $pyExe) {
        Write-Host "  Python не найден — библиотеки ставить было некуда"
        Write-Host "CHECK fail Python-пакеты"
    } else {
        & $pyExe -c "import playwright" 2>$null
        $impOk = ($LASTEXITCODE -eq 0)
        $cache = Join-Path $env:LOCALAPPDATA 'ms-playwright'
        $browserOk = $false
        if (Test-Path $cache) {
            $browserOk = [bool](Get-ChildItem -LiteralPath $cache -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'chromium*' } | Select-Object -First 1)
        }
        if ($impOk -and $browserOk) {
            Write-Host "CHECK ok Python-пакеты"
        } else {
            if (-not $impOk)     { Write-Host "  библиотека playwright не импортируется — часть навыков не заработает" }
            if (-not $browserOk) { Write-Host "  браузер Playwright не распакован ($cache) — скриншоты, экспорт и деки не заработают" }
            Write-Host "CHECK fail Python-пакеты"
        }
    }
}

# --- Расширение Claude Code — проверяем КАТАЛОГИ расширений НАПРЯМУЮ. НЕ запускаем
#     editor CLI: этот verify исполняется ELEVATED, а запуск user-writable
#     code.cmd/cursor.cmd под админом был бы privilege-escalation (P0-B). Имя папки
#     расширения = "<extId>-<версия>" -> матчим по ПРЕФИКСУ id (регистронезависимо). ---
if (-not (Test-Selected 'extension')) {
    Write-Host "CHECK skip Расширение"
} else {
    $extId = if ($env:HM_CLAUDE_EXT_ID) { $env:HM_CLAUDE_EXT_ID } else { 'anthropic.claude-code' }
    $extDirs = @(
        (Join-Path $env:USERPROFILE '.vscode\extensions'),
        (Join-Path $env:USERPROFILE '.vscode-oss\extensions'),
        (Join-Path $env:USERPROFILE '.cursor\extensions')
    )
    # Точный префикс "<extId>-" + ЦИФРА версии (ordinal-регистронезависимо, ТОЛЬКО каталоги):
    # иначе `anthropic.claude-code-helper-1.0` даёт ложный PASS (он тоже начинается с
    # `anthropic.claude-code-`). Суффикс платформы `-win32-x64` (после `-<ver>`) проходит.
    $rx = '^' + [regex]::Escape($extId) + '-\d'
    $extOk = $false
    foreach ($d in $extDirs) {
        if ($extOk) { break }
        if (-not (Test-Path -LiteralPath $d)) { continue }
        try {
            $hit = Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match $rx } | Select-Object -First 1
            if ($hit) { Write-Host "  расширение найдено в: $d"; $extOk = $true }
        } catch { }
    }
    if ($extOk) { Write-Host "CHECK ok Расширение" } else { Write-Host "CHECK fail Расширение" }
}

# Диагностика — не провал: всегда зелёный выход.
exit 0
