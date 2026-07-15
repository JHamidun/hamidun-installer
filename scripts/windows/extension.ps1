# Claude Code extension (ТОЛЬКО Cursor) — Windows
# ВНИМАНИЕ: оба VS Code-расширения (anthropic.claude-code + openai.chatgpt) ставит
# vscode.ps1 (де-элевированно). Здесь — ТОЛЬКО Cursor (опциональный редактор), чтобы не
# было ДУБЛЯ установки в VS Code (P0-A: убран второй elevated-путь к user-writable code.cmd).
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
. (Join-Path $PSScriptRoot '_deelev.ps1')  # Invoke-HmDeElevated (укреплённая де-элевация, fail-closed)
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

$extId = if ($env:HM_CLAUDE_EXT_ID) { $env:HM_CLAUDE_EXT_ID } else { 'anthropic.claude-code' }
$DRY = [bool]$env:HM_DRY_RUN
$installed = $false

# Вшитый vsix (полный офлайн) — кладёт build-задача в HM_VENDOR/apps/claude-code.vsix.
# vsix исполняется как код внутри Cursor/VS Code -> сверяем целостность ДО установки (fail-closed).
$vsix = ''
if ($env:HM_VENDOR) { $cand = Join-Path $env:HM_VENDOR 'apps\claude-code.vsix'; if (Test-Path $cand) { $vsix = $cand } }
if ($vsix -and -not $DRY) { Confirm-HmArtifact $vsix }

# Cursor должен быть ЗАКРЫТ, иначе --install-extension падает с 'aborted' (баг с теста).
# НО не убиваем силой Cursor, открытый ПОЛЬЗОВАТЕЛЕМ — это потеря несохранённой работы.
# Наш собственный авто-запуск (если такой будет) помечается HM_CURSOR_AUTOSTARTED — его гасить безопасно.
# В штатном флоу cursor.ps1 уже закрыл свой авто-запуск, поэтому любой живой Cursor здесь = пользовательский.
$userCursorSpared = $false
if (-not $DRY) {
    $cursorProc = Get-Process Cursor -ErrorAction SilentlyContinue
    if ($cursorProc) {
        $ourAutoStart = ($env:HM_CURSOR_AUTOSTARTED -and $env:HM_CURSOR_AUTOSTARTED -ne '0')
        if ($ourAutoStart) {
            # Мы сами запустили Cursor ради установки — закрыть безопасно.
            $cursorProc | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 600
        } else {
            Write-Host "ВНИМАНИЕ: Cursor сейчас запущен. Закрой Cursor и сохрани работу — установка расширения может прерваться при открытом Cursor."
            Write-Host "  Жду до 20 секунд, пока ты закроешь Cursor (принудительно НЕ закрываю)..."
            for ($w = 0; $w -lt 20 -and (Get-Process Cursor -ErrorAction SilentlyContinue); $w++) { Start-Sleep -Seconds 1 }
            if (Get-Process Cursor -ErrorAction SilentlyContinue) {
                $userCursorSpared = $true
                Write-Host "  Cursor всё ещё открыт — пробую установить расширение без принудительного закрытия."
            }
        }
    }
}

$script:DeElevFailed = $false

# P0-A (privesc): этот скрипт исполняется ELEVATED (установщик requireAdministrator).
# Прямой запуск user-writable cursor.cmd/Cursor.exe под АДМИНОМ выполнил бы то, что
# medium-integrity малварь ТОГО ЖЕ юзера могла заранее подложить на его место. Поэтому
# ЛЮБОЙ вызов Cursor CLI (install + list-extensions) идёт ЧЕРЕЗ единый де-элевированный
# примитив (Invoke-HmDeElevated, _deelev.ps1). $null -> fail-closed: под админом НЕ запускаем.

function Test-ExtPresent($cli) {
    # --list-extensions может лагать сразу после установки — ретраим (де-элевированно).
    for ($k = 0; $k -lt 3; $k++) {
        $lst = Invoke-HmDeElevated $cli @('--list-extensions')
        if ($null -eq $lst) { $script:DeElevFailed = $true; return $false }
        if (("$($lst.Output)") -match [regex]::Escape($extId)) { return $true }
        Start-Sleep -Milliseconds 1500
    }
    return $false
}

function Install-Into($cli, $label) {
    if (-not $cli) { return $false }
    Write-Host "Ставлю расширение в $label (от имени пользователя, без прав администратора)..."
    if ($DRY) {
        if ($vsix) { Write-Host "  [dry-run] WOULD (de-elevated): $cli --install-extension $vsix --force" }
        else { Write-Host "  [dry-run] WOULD (de-elevated): $cli --install-extension $extId --force" }
        return $true
    }
    $target = if ($vsix) { $vsix } else { $extId }
    if ($vsix) { Write-Host "  из вшитого vsix (офлайн): $vsix" }
    $r = Invoke-HmDeElevated $cli @('--install-extension', $target, '--force')
    if ($null -eq $r) {
        Write-Host "  ${label}: не удалось безопасно (де-элевированно) установить — пропускаю (fail-closed, НЕ запускаю под админом)."
        $script:DeElevFailed = $true
        return $false
    }
    if ($r.Output) { Write-Host ($r.Output.TrimEnd()) }
    if (Test-ExtPresent $cli) { Write-Host "  ${label}: расширение на месте."; return $true }
    if ($vsix) {
        Write-Host "  ${label}: vsix не подтвердился — пробую Marketplace ($extId)..."
        $r2 = Invoke-HmDeElevated $cli @('--install-extension', $extId, '--force')
        if ($null -eq $r2) { $script:DeElevFailed = $true; return $false }
        if ($r2.Output) { Write-Host ($r2.Output.TrimEnd()) }
        if (Test-ExtPresent $cli) { Write-Host "  ${label}: расширение на месте (Marketplace)."; return $true }
    }
    Write-Host "  ${label}: расширение не подтвердилось."; return $false
}

# Cursor CLI — перебор кандидатов (на свежей установке путь варьируется).
$cursorCli = $null
$cursorCands = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\cursor\resources\app\bin\cursor.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\cursor\bin\cursor.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\cursor\cursor.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe')
)
foreach ($p in $cursorCands) { if (Test-Path $p) { $cursorCli = $p; break } }
if (-not $cursorCli) { $g = Get-Command cursor -ErrorAction SilentlyContinue; if ($g) { $cursorCli = $g.Source } }
if (Install-Into $cursorCli 'Cursor') { $installed = $true } elseif (-not $cursorCli) { Write-Host "Cursor не установлен — пропускаю (панель Claude Code в VS Code ставит компонент vscode)." }

# ПРИМЕЧАНИЕ: установку в VS Code здесь УБРАЛИ (P0-A) — оба VS Code-расширения ставит
# vscode.ps1 (де-элевированно). Дубль под elevated к user-writable code.cmd исключён.

# --- вшитый шрифт JetBrains Mono (пер-юзерно, БЕЗ админа) ---
$fontSrc = ''
if ($env:HM_VENDOR) { $f = Join-Path $env:HM_VENDOR 'apps\JetBrainsMono-Regular.ttf'; if (Test-Path $f) { $fontSrc = $f } }
if ($fontSrc) {
    if ($DRY) { Write-Host "  [dry-run] WOULD: установить шрифт JetBrains Mono (пер-юзерно) из $fontSrc" }
    elseif (-not (Test-HmArtifact $fontSrc)) {
        # Шрифт не критичен — при несовпадении SHA-256 просто НЕ ставим его (парсинг ttf — потенц. вектор).
        Write-Host "Шрифт JetBrains Mono не прошёл проверку целостности — пропускаю (не критично)."
    }
    else {
        try {
            $fontDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
            New-Item -ItemType Directory -Force $fontDir | Out-Null
            $fontDst = Join-Path $fontDir 'JetBrainsMono-Regular.ttf'
            Copy-Item -Force $fontSrc $fontDst
            $regKey = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts'
            if (-not (Test-Path $regKey)) { New-Item -Path $regKey -Force | Out-Null }
            New-ItemProperty -Path $regKey -Name 'JetBrains Mono Regular (TrueType)' -Value $fontDst -PropertyType String -Force | Out-Null
            Write-Host "Шрифт JetBrains Mono установлен (пер-юзерно)."
        } catch { Write-Host "Шрифт не установился: $($_.Exception.Message)" }
    }
}

# --- сид settings.json Cursor (ТОЛЬКО если файла нет; существующий НЕ трогаем) ---
$cursorSettings = Join-Path $env:APPDATA 'Cursor\User\settings.json'
if (Test-Path $cursorSettings) {
    Write-Host "settings.json Cursor уже существует — не трогаю."
} else {
    if ($DRY) { Write-Host "  [dry-run] WOULD: создать $cursorSettings (autoSave + JetBrains Mono)" }
    else {
        try {
            New-Item -ItemType Directory -Force (Split-Path $cursorSettings) | Out-Null
            $seed = @'
{
  "files.autoSave": "afterDelay",
  "editor.fontFamily": "JetBrains Mono",
  "terminal.integrated.fontFamily": "JetBrains Mono"
}
'@
            Set-Content -Path $cursorSettings -Value $seed -Encoding UTF8
            Write-Host "Создал стартовый settings.json Cursor (autoSave + JetBrains Mono)."
        } catch { Write-Host "settings.json Cursor не создался: $($_.Exception.Message)" }
    }
}

# Крайняя мера: расширение не встало, а пользовательский Cursor так и остался открытым
# (частая причина 'aborted'). Честно предупреждаем и закрываем — иначе установка не завершится.
if (-not $installed -and -not $DRY -and $userCursorSpared -and (Get-Process Cursor -ErrorAction SilentlyContinue)) {
    Write-Host "Расширение не установилось при открытом Cursor. Крайняя мера: закрываю Cursor и пробую ещё раз (сохранённая работа не пострадает; несохранённая — увы)."
    Get-Process Cursor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
    if (Install-Into $cursorCli 'Cursor') { $installed = $true }
}

if ($installed) { Write-Host "OK: панель Claude Code установлена в Cursor."; exit 0 }
# Cursor нет вообще — делать нечего (панель Claude в VS Code ставит компонент vscode). Не провал.
if (-not $cursorCli) {
    Write-Host "Cursor не установлен — пропускаю. Панель Claude Code уже в VS Code (компонент vscode)."
    exit 0
}
# Cursor есть, но расширение не встало.
if ($script:DeElevFailed) {
    Write-Host "Не удалось безопасно (де-элевированно) поставить расширение в Cursor. Открой Cursor -> панель расширений -> найди '$extId' -> Install."
} else {
    Write-Host "Расширение в Cursor не установилось автоматически. В Cursor: панель расширений -> найди '$extId' -> Install. Claude Code также работает в терминале командой 'claude'."
}
exit 1
