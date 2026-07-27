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
#   'broken'     — запуск состоялся (Gate=medium), код НЕ 0: на диске нерабочая обёртка;
#   'unverified' — де-элевация недоступна/не отчиталась: проверить нельзя, и это НЕ
#                  доказательство поломки (fail-open к прежней проверке «бинарь на диске»).
function Test-HmClaudeRuns($bin) {
    if (-not $bin) { return 'broken' }
    $r = Invoke-HmDeElevated $bin @('--version')
    if ($null -eq $r -or $r.Gate -ne 'medium') { return 'unverified' }
    if ($r.Code -eq 0) { return 'works' }
    return 'broken'
}

# Убираем нерабочую обёртку (зеркало rm -f / rm -rf в claude.sh): иначе она перехватит
# PATH/Find-ClaudeBinary и «claude» будет падать даже после успешной онлайн-установки
# в другой каталог.
function Remove-HmBrokenClaude($bin) {
    if (-not $bin) { return }
    $dir = Split-Path $bin
    foreach ($n in @('claude', 'claude.cmd', 'claude.ps1', 'claude.exe')) {
        Remove-Item -LiteralPath (Join-Path $dir $n) -Force -ErrorAction SilentlyContinue
    }
    # npm-шимы живут в prefix, сам пакет — в prefix\node_modules (у ~/.local\bin его нет).
    $pkg = Join-Path $dir 'node_modules\@anthropic-ai\claude-code'
    if (Test-Path -LiteralPath $pkg) { Remove-Item -LiteralPath $pkg -Recurse -Force -ErrorAction SilentlyContinue }
}

Update-Path
$DRY = [bool]$env:HM_DRY_RUN
$cache = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'npm-cache' } else { '' }
$offlineOk = $false      # офлайн-путь дал claude, который НЕ доказан сломанным
$probedBin = ''          # кэш проверки, чтобы не гонять де-элевированный запуск дважды
$probedResult = ''
if ($cache -and (Test-Path $cache) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
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
            Write-Host "Офлайн-установка отчиталась успехом, но claude не запускается (в кеше нет платформенного бинаря) — убираю нерабочую обёртку и пробую онлайн-путь."
            Remove-HmBrokenClaude $bin
            $probedBin = ''; $probedResult = ''
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
if ($probe -eq 'broken') {
    Write-Host "ОШИБКА: claude найден ($claudeBin), но НЕ запускается (обёртка без платформенного бинаря) — установка не засчитана. Повтори установку компонента при доступной сети."
    exit 1
}
Add-ToUserPath (Split-Path $claudeBin)
Add-ToUserPath (Join-Path $env:USERPROFILE '.local\bin')
if ($probe -eq 'works') {
    Write-Host "OK: Claude Code CLI установлен и отвечает на --version ($claudeBin). Открой НОВЫЙ терминал, чтобы работала команда claude."
} else {
    Write-Host "OK: Claude Code CLI установлен ($claudeBin; проверить запуском де-элевированно не удалось). Открой НОВЫЙ терминал, чтобы работала команда claude."
}
exit 0
