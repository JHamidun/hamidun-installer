# Claude Code CLI — Windows (native installer)
$ErrorActionPreference = 'Continue'
# Прогресс-бар Invoke-RestMethod в PS5.1 сильно замедляет скачивание — глушим.
$ProgressPreference = 'SilentlyContinue'
# irm|iex ниже тянет ОФИЦИАЛЬНЫЙ установщик claude.ai по HTTPS (доверие = TLS + подлинность домена).
# Своего SHA-256 для него нет (плавающая версия). Форсим TLS 1.2, чтобы PS5.1 не откатился на TLS1.0.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
# Invoke-HmDeElevated: проверочный ЗАПУСК claude (user-writable бинарь) — только де-элевированно.
. (Join-Path $PSScriptRoot '_deelev.ps1')
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

# Честная проверка: ищем реальный бинарь, а не доверяем коду установщика.
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

# Прописать каталог в ПОЛЬЗОВАТЕЛЬСКИЙ PATH, чтобы `claude` работал в новом
# терминале (npm-global-prefix / ~/.local\bin часто не в PATH пользователя).
function Add-ToUserPath($dir) {
    if (-not $dir -or -not (Test-Path $dir)) { return }
    # Читаем СЫРОЕ значение (DoNotExpand) и пишем как ExpandString — сохраняем тип
    # REG_EXPAND_SZ и записи пользователя с %USERPROFILE%/%VAR%. [Environment]::Get/Set
    # разворачивали %VAR% в литералы и меняли тип на REG_SZ — тихая порча User PATH.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
    try {
        $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        # сверяем по РАЗВЁРНУТОЙ копии, чтобы не задвоить уже присутствующий каталог
        $expanded = [Environment]::ExpandEnvironmentVariables($raw)
        if (($expanded.Split(';') | Where-Object { $_ -ne '' }) -notcontains $dir) {
            $new = ($raw.TrimEnd(';') + ';' + $dir).TrimStart(';')
            $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
            Write-Host "Добавил $dir в PATH пользователя."
        }
    } finally { $key.Close() }
    # PATH текущего процесса — чтобы дальнейшие шаги увидели каталог сразу.
    if ($env:Path.Split(';') -notcontains $dir) { $env:Path = $env:Path.TrimEnd(';') + ';' + $dir }
}

# Проверка ЗАПУСКОМ (урок macOS, зеркало scripts/macos/claude.sh — на маке это уже
# случилось у живого человека): НУЛЕВОЙ КОД npm НИЧЕГО НЕ ДОКАЗЫВАЕТ. Настоящий бинарь
# Claude ставится ПЛАТФОРМЕННЫМ optional-пакетом (@anthropic-ai/claude-code-win32-*).
# Если его в кеше нет, npm считает optional-зависимость необязательной, ОТЧИТЫВАЕТСЯ
# УСПЕХОМ и оставляет обёртку, чей запуск печатает «claude native binary not installed»
# и падает. Человек увидел бы зелёную галочку и нерабочий claude — худший исход из всех.
# Поэтому проверяем не код установки, а РАБОТУ: команда обязана ответить на --version.
# P0-инвариант (тот же, что у editor-CLI в vscode.ps1): claude лежит в user-writable
# каталоге, а этот скрипт исполняется ELEVATED — запускаем ТОЛЬКО де-элевированно
# (Invoke-HmDeElevated), НЕ под админом. Возвращает:
#   'works'      — ответил, код 0: бинарь рабочий;
#   'broken'     — запуск ДОКАЗАННО состоялся (Gate=medium) и вернул НЕ 0: нерабочая обёртка;
#   'unverified' — де-элевация недоступна/не отчиталась ИЛИ «Last Result» — служебный
#                  статус планировщика: проверить нельзя, и это НЕ доказательство поломки
#                  (fail-open к прежней проверке «бинарь на диске»).
function Test-HmClaudeRuns($bin) {
    if (-not $bin) { return 'broken' }
    $r = Invoke-HmDeElevated $bin @('--version')
    if ($null -eq $r -or $r.Gate -ne 'medium') { return 'unverified' }
    if ($r.Code -eq 0) { return 'works' }
    # «Last Result» задачи планировщика бывает СЛУЖЕБНЫМ СТАТУСОМ ЗАДАЧИ (SCHED_S_*,
    # 0x41300..0x41308 и 0x41325), а не кодом возврата claude: 267008=готова,
    # 267009=выполняется, 267010=отключена, 267011=ещё не запускалась, 267012=запусков
    # больше нет, 267013=не запланирована, 267014=ЗАВЕРШЕНА/отменена, 267015=нет валидных
    # триггеров, 267016=event-триггер без времени, 267045=в очереди. Опрос в _deelev.ps1
    # пережидает только 267009/267011 — остальные долетают сюда как Code при Gate='medium'.
    # Статус ЗАДАЧИ ничего не доказывает про БИНАРЬ: прочитать его как «claude сломан»
    # значило снести РАБОЧИЙ CLI на ровном месте. Сентинелы => 'unverified', НЕ 'broken';
    # удаление допустимо ТОЛЬКО при доказанном отказе запуска (настоящий exit-код != 0).
    if (@(267008, 267009, 267010, 267011, 267012, 267013, 267014, 267015, 267016, 267045) -contains $r.Code) { return 'unverified' }
    # Перечисления мало: планировщик отдаёт и ДРУГИЕ служебные значения — SCHED_E_*
    # (0x8004130x «задачу не удалось запустить»), обычные HRESULT-ы вроде 0x80070005
    # (отказано в доступе), а также коды аварийного завершения самого хоста задачи.
    # Код возврата ПРОГРАММЫ — маленькое число (claude --version даёт 0 или 1).
    # Всё, что вне 0..255, программа вернуть в принципе не может — это статус
    # инфраструктуры, и он ничего не доказывает про бинарь.
    # Цена ошибки несимметрична: принять статус за «сломан» = снести РАБОЧИЙ CLI
    # с правами администратора. Поэтому в сомнении — всегда 'unverified'.
    if ($r.Code -lt 0 -or $r.Code -gt 255) { return 'unverified' }
    return 'broken'
}

# Аллоулист НАШИХ мест установки — взят из scripts/macos/claude.sh: там сносятся СТРОГО
# свои пути (~/.local/bin/claude и ~/.local/lib/node_modules/@anthropic-ai/claude-code),
# «чужой claude (brew и т.п.) НЕ трогаем — удаляем только то, что кладём сами».
# Windows-эквиваленты НАШИХ путей:
#   • %USERPROFILE%\.local\bin — сюда кладёт нативный установщик claude.ai (см. Find-ClaudeBinary);
#   • %APPDATA%\npm — ДЕФОЛТНЫЙ глобальный npm-prefix, куда пишет НАШ `npm install -g`.
# Всё остальное (свой npm prefix, volta, scoop и т.п.) — ЧУЖАЯ установка: скрипт работает
# С ПРАВАМИ АДМИНИСТРАТОРА, и Remove-Item по произвольному найденному пути снёс бы чужой
# рабочий claude. Такие пути НЕ трогаем никогда.
function Test-HmOurClaudeDir($dir) {
    if (-not $dir) { return $false }
    $ours = @()
    if ($env:USERPROFILE) { $ours += (Join-Path $env:USERPROFILE '.local\bin') }
    if ($env:APPDATA)     { $ours += (Join-Path $env:APPDATA 'npm') }
    # РЕАЛЬНЫЙ npm-префикс, а не только дефолтный. Мы ставим claude командой
    # `npm install -g`, и она кладёт его туда, куда указывает КОНФИГ npm — при nvm,
    # volta или своём prefix это НЕ %APPDATA%\npm. Без этой строки обёртка, которую
    # поставили МЫ САМИ, считалась чужой: убрать её было нельзя, а с недавних пор
    # такой случай ещё и честно роняет установку. Find-ClaudeBinary префикс уже
    # спрашивает — спрашиваем и здесь, чтобы аллоулист совпадал с местом установки.
    try {
        $p = (npm config get prefix 2>$null | Select-Object -First 1)
        if ($p) {
            $p = ([string]$p).Trim()
            if ($p -and $p -ne 'undefined' -and (Test-Path -LiteralPath $p)) { $ours += $p }
        }
    } catch { }
    $norm = ''
    try { $norm = [System.IO.Path]::GetFullPath($dir).TrimEnd('\') } catch { return $false }
    foreach ($o in $ours) {
        try { if ($norm -eq ([System.IO.Path]::GetFullPath($o).TrimEnd('\'))) { return $true } } catch { }
    }
    return $false
}

# Убираем нерабочую обёртку (зеркало rm -f / rm -rf в claude.sh): иначе она перехватит
# PATH/Find-ClaudeBinary и «claude» будет падать даже после успешной онлайн-установки
# в другой каталог. Удаление — СТРОГО по аллоулисту наших мест (Test-HmOurClaudeDir);
# путь вне его не трогаем: честное сообщение и $false — вызывающий уходит дорогой
# «не смогли подтвердить», а не сносит чужие файлы под админом.
# Возвращает $true, если уборка состоялась; $false — чужой каталог, ничего не тронуто.
function Remove-HmBrokenClaude($bin) {
    if (-not $bin) { return $false }
    $dir = Split-Path $bin
    if (-not (Test-HmOurClaudeDir $dir)) {
        Write-Host "claude лежит в '$dir' — это НЕ каталог нашей установки (свой npm-prefix/volta?). Чужие файлы не трогаю."
        return $false
    }
    foreach ($n in @('claude', 'claude.cmd', 'claude.ps1', 'claude.exe')) {
        Remove-Item -LiteralPath (Join-Path $dir $n) -Force -ErrorAction SilentlyContinue
    }
    # npm-шимы живут в prefix, сам пакет — в prefix\node_modules (у ~/.local\bin его нет).
    $pkg = Join-Path $dir 'node_modules\@anthropic-ai\claude-code'
    if (Test-Path -LiteralPath $pkg) { Remove-Item -LiteralPath $pkg -Recurse -Force -ErrorAction SilentlyContinue }
    return $true
}

Update-Path
$DRY = [bool]$env:HM_DRY_RUN
$cache = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'npm-cache' } else { '' }
$offlineOk = $false      # офлайн-путь дал claude, который НЕ доказан сломанным
$probedBin = ''          # кэш проверки, чтобы не гонять де-элевированный запуск дважды
$probedResult = ''

# СНИМОК ДО УСТАНОВКИ. Наш `npm install -g` пишет в тот же глобальный prefix, где у
# человека может УЖЕ стоять СВОЯ рабочая установка claude. Если она работает —
# офлайн-установку не запускаем вовсе: незачем перетирать рабочее ради известного
# офлайн-отказа (нет платформенного бинаря в кеше → npm=0 → вердикт broken →
# Remove-HmBrokenClaude снёс бы ЧУЖОЙ рабочий claude, а онлайн-путь из РФ упёрся бы
# в 403 — и у человека не осталось бы ничего). Инвариант: удаляем только то, что
# положили МЫ (отсутствовало ИЛИ было сломано ДО прогона), не работавшее до нас.
$preExisting = 'none'
if (-not $DRY) {
    $preBin = Find-ClaudeBinary
    if ($preBin) { $preExisting = Test-HmClaudeRuns $preBin }   # works | broken | unverified
}
if ($preExisting -eq 'works') {
    Write-Host "Claude Code CLI уже установлен и отвечает на --version ($preBin) — не трогаю."
    $offlineOk = $true
    $probedBin = $preBin; $probedResult = 'works'
}

if (-not $offlineOk -and $cache -and (Test-Path $cache) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Ставлю Claude Code CLI из встроенного npm-кеша (офлайн)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: npm install -g @anthropic-ai/claude-code --offline --cache $cache; затем проверка ЗАПУСКОМ claude --version (де-элевированно)"; exit 0 }
    npm install -g '@anthropic-ai/claude-code' --offline --cache $cache --no-audit --no-fund
    $npmExit = $LASTEXITCODE
    if ($npmExit -eq 0) {
        Update-Path
        $bin = Find-ClaudeBinary
        $probe = Test-HmClaudeRuns $bin
        $probedBin = $bin; $probedResult = $probe
        if ($probe -eq 'broken') {
            Write-Host "Офлайн-установка отчиталась успехом, но claude не запускается (в кеше нет платформенного бинаря) — пробую онлайн-путь."
            # Удаляем ТОЛЬКО если до нас в этом каталоге не было рабочего claude:
            # снимок $preExisting='works' сюда не дойдёт (офлайн-ветку мы бы не
            # запускали), но каталог мог сменить путь — страхуемся ещё раз здесь.
            if ($preExisting -ne 'works' -and (Remove-HmBrokenClaude $bin)) {
                # нерабочая обёртка снесена — финальный Find/пробу начнём с чистого листа
                $probedBin = ''; $probedResult = ''
            }
            # отказ уборки (чужой каталог) или работавший до нас claude: кэш пробы
            # сохраняем — финал увидит 'broken' и уйдёт путём «не смогли подтвердить»
        } else {
            $offlineOk = $true
        }
    } else {
        Write-Host "Офлайн-установка npm вернула код ${npmExit}. Пробую онлайн-установщик..."
    }
}

if (-not $offlineOk) {
    if ($DRY) { Write-Host "  [dry-run] WOULD: irm https://claude.ai/install.ps1 | iex (или npm install -g @anthropic-ai/claude-code)"; exit 0 }
    Write-Host "Устанавливаю Claude Code CLI (нативный установщик, онлайн)..."
    try {
        Invoke-RestMethod "https://claude.ai/install.ps1" -TimeoutSec 120 | Invoke-Expression
    } catch {
        Write-Host "Нативный установщик не сработал ($($_.Exception.Message))."
        # claude.ai гео-блокируется из РФ (403), а registry.npmjs.org доступен —
        # запасной шаг: обычный npm install из онлайн-реестра (зеркально macos/claude.sh).
        if (Get-Command npm -ErrorAction SilentlyContinue) {
            Write-Host "Пробую npm install из онлайн-реестра npmjs..."
            npm install -g '@anthropic-ai/claude-code' --no-audit --no-fund
        } else {
            Write-Host "npm недоступен — установите компонент Node.js."; exit 1
        }
    }
}

Update-Path

$claudeBin = Find-ClaudeBinary
if (-not $claudeBin) {
    Write-Host "ОШИБКА: Claude Code CLI не установился."
    exit 1
}
# Финальный вердикт — тоже ЗАПУСКОМ (результат переиспользуем, если бинарь тот же):
# если и онлайн-путь оставил нерабочую обёртку — честный красный статус БЕЗ «OK»-квитанции,
# а не зелёная галочка при неработающем claude.
$probe = if ($claudeBin -eq $probedBin -and $probedResult) { $probedResult } else { Test-HmClaudeRuns $claudeBin }

# Вердикт запуском пишем в ~/.hamidun-setup/checks.json — финальный чек-лист
# (verify.ps1) обязан ПЕРЕНЕСТИ его, а не выводить заново по наличию файла.
# Один факт «claude работает» — один стандарт доказательства.
function Write-HmCheck($name, $verdict) {
    try {
        $dir = Join-Path $env:USERPROFILE '.hamidun-setup'
        New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue | Out-Null
        $file = Join-Path $dir 'checks.json'
        $data = @{}
        if (Test-Path -LiteralPath $file) {
            try { $data = (Get-Content -Raw -LiteralPath $file | ConvertFrom-Json) } catch { $data = New-Object psobject }
        }
        $entry = @{ verdict = $verdict; at = [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds }
        # atomic: temp + move (как маркеры/квитанции)
        $obj = @{}
        if ($data) { foreach ($p in $data.PSObject.Properties) { $obj[$p.Name] = $p.Value } }
        $obj[$name] = $entry
        $tmp = "$file.tmp"
        ($obj | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $file -Force
    } catch { }   # диагностика не должна ломать установку
}
# Красный вердикт «сломан» имеем право выносить только за НАШ артефакт: сломанный claude
# ВНЕ наших каталогов (свой npm prefix/volta) не трогаем и не хороним им установку —
# честно уходим путём «не смогли подтвердить» (тот же аллоулист, что у уборки).
# Сломанный claude ВНЕ наших каталогов (свой npm prefix, volta, scoop) не трогаем —
# чужие файлы удалять нельзя. Но и УСПЕХОМ это не является: раньше такой случай
# понижался до «не смогли проверить» и дальше печатал «OK: установлен» с кодом 0 —
# то есть зелёная галочка при заведомо НЕ работающем claude. Человек уходил
# уверенным, что всё хорошо, и упирался в это позже.
# Не удаляем, но и не врём: честный отказ с объяснением, что делать.
$brokenForeign = $false
if ($probe -eq 'broken' -and -not (Test-HmOurClaudeDir (Split-Path $claudeBin))) {
    $brokenForeign = $true
}
if ($brokenForeign) {
    Write-Host "ОШИБКА: claude найден ($claudeBin), но НЕ отвечает на --version."
    Write-Host "Он установлен НЕ нашим установщиком (свой npm prefix, volta, scoop и т.п.),"
    Write-Host "поэтому трогать его мы не станем — это твои файлы."
    Write-Host "Что сделать: удали свою установку (например 'npm uninstall -g @anthropic-ai/claude-code')"
    Write-Host "и запусти установку компонента заново — тогда мы поставим рабочий claude сами."
    Write-HmCheck 'claude' 'broken'
    exit 1
}
if ($probe -eq 'broken') {
    Write-Host "ОШИБКА: claude найден ($claudeBin), но НЕ запускается (обёртка без платформенного бинаря) — установка не засчитана. Повтори установку компонента при доступной сети."
    Write-HmCheck 'claude' 'broken'
    exit 1
}
Add-ToUserPath (Split-Path $claudeBin)
Add-ToUserPath (Join-Path $env:USERPROFILE '.local\bin')
if ($probe -eq 'works') {
    Write-HmCheck 'claude' 'works'
    Write-Host "OK: Claude Code CLI установлен и отвечает на --version ($claudeBin). Открой НОВЫЙ терминал, чтобы работала команда claude."
} else {
    Write-HmCheck 'claude' 'unverified'
    Write-Host "OK: Claude Code CLI установлен ($claudeBin; проверить запуском де-элевированно не удалось). Открой НОВЫЙ терминал, чтобы работала команда claude."
}
exit 0
