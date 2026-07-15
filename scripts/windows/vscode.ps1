# VS Code (рекомендуемый редактор) + расширения Claude Code и Codex — Windows
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
function Update-Path {
    # SECURITY (#4): PATH для elevated-скрипта — ТОЛЬКО HKLM (Machine) + наши
    # админ-owned фиксированные каталоги. НИКОГДА не читаем HKCU (User) PATH.
    $sr  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $s32 = Join-Path $sr 'System32'
    $parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine'),
               $s32, $sr,
               (Join-Path $s32 'WindowsPowerShell\v1.0'),
               (Join-Path $s32 'OpenSSH'))
    if ($env:ProgramFiles) {
        $parts += (Join-Path $env:ProgramFiles 'Git\cmd')
        $parts += (Join-Path $env:ProgramFiles 'nodejs')
        $parts += (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin')
    }
    if ($env:LOCALAPPDATA) { $parts += (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin') }
    if ($env:HM_VENDOR) { $parts += (Join-Path $env:HM_VENDOR 'apps') }
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}
Update-Path

$DRY = [bool]$env:HM_DRY_RUN

# CLI VS Code — НАСТОЯЩИЙ code.cmd (не курсоровский шим, отдающий VS Code 1.67.1).
function Find-CodeCli {
    foreach ($p in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
                     "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}
function Test-VsCodePresent {
    if (Find-CodeCli) { return $true }
    foreach ($e in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
                     "$env:ProgramFiles\Microsoft VS Code\Code.exe")) {
        if (Test-Path $e) { return $true }
    }
    return $false
}

$setup = ''
if ($env:HM_VENDOR) { $cand = Join-Path $env:HM_VENDOR 'apps\vscode-setup.exe'; if (Test-Path $cand) { $setup = $cand } }
$present = Test-VsCodePresent

Write-Host "Проверяю VS Code..."
if ($present) {
    Write-Host "VS Code уже установлен — доставлю только расширения."
} elseif (-not $setup) {
    # Офлайн-инсталлятор не вшит И VS Code не установлен — как скрепка (mascot): грациозный
    # пропуск (exit 120). Всё остальное работает; VS Code можно поставить позже.
    Write-Host "VS Code не вошёл в эту сборку и не установлен — пропускаю. Остальное работает без него (поставь VS Code позже с code.visualstudio.com)."
    exit 120
} elseif ($DRY) {
    Write-Host "  [dry-run] WOULD: SHA-256 vscode-setup.exe, тихая установка /VERYSILENT /NORESTART /MERGETASKS=!runcode,addtopath, PATH, затем расширения anthropic.claude-code + openai.chatgpt"
} else {
    # Вшитый установщик исполняется -> fail-closed SHA-256 ДО запуска.
    Confirm-HmArtifact $setup
    Write-Host "Ставлю VS Code из встроенного установщика (офлайн, User Setup, без прав администратора)..."
    # User Setup (Inno) с !runcode НЕ запускает VS Code сам -> -Wait безопасен (в отличие от Cursor).
    Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode,addtopath' -Wait
    Update-Path
    $codeExe = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
    for ($i = 0; $i -lt 60 -and -not (Test-Path $codeExe); $i++) { Start-Sleep -Seconds 1 }
    if (Test-Path $codeExe) {
        Write-Host "VS Code установлен."
        # Квитанция владения (каталог установки) — для будущего деинсталлятора.
        Write-Host "HM-RECEIPT path $(Split-Path $codeExe)"
    } else {
        Write-Host "ВНИМАНИЕ: VS Code не подтвердил установку (Code.exe не найден) — расширения всё равно попробую доставить."
    }
}

# --- Расширения: ставим в VS Code ОБА — панель Claude (anthropic.claude-code) и Codex (openai.chatgpt) ---
$codeCli = Find-CodeCli
if (-not $codeCli) { $g = Get-Command code -ErrorAction SilentlyContinue; if ($g) { $codeCli = $g.Source } }

function Test-ExtPresent($cli, $extId) {
    # --list-extensions лагает сразу после установки — ретраим.
    for ($k = 0; $k -lt 3; $k++) {
        try { $list = & $cli --list-extensions 2>$null; if (("$list") -match [regex]::Escape($extId)) { return $true } } catch { }
        Start-Sleep -Milliseconds 1500
    }
    return $false
}

# Вшитый .vsix (офлайн). vsix исполняется как код внутри VS Code -> целостность ДО установки (fail-closed).
function Get-Vsix($name) {
    if ($env:HM_VENDOR) {
        $p = Join-Path $env:HM_VENDOR ('apps\' + $name)
        if (Test-Path $p) { if (-not $DRY) { Confirm-HmArtifact $p }; return $p }
    }
    return ''
}

function Install-Ext($cli, $extId, $vsix) {
    if (-not $cli) { return $false }
    Write-Host "Ставлю расширение $extId в VS Code..."
    if ($DRY) {
        if ($vsix) { Write-Host "  [dry-run] WOULD: $cli --install-extension $vsix --force" }
        else { Write-Host "  [dry-run] WOULD: $cli --install-extension $extId --force" }
        return $true
    }
    # Приоритет — вшитый .vsix (офлайн); фолбэк — Marketplace по id.
    if ($vsix) {
        Write-Host "  из вшитого vsix (офлайн): $vsix"
        & $cli --install-extension $vsix --force 2>&1 | Out-Host
        if (Test-ExtPresent $cli $extId) { Write-Host "  ${extId}: на месте (офлайн vsix)."; return $true }
        Write-Host "  ${extId}: vsix не подтвердился — пробую Marketplace..."
    }
    & $cli --install-extension $extId --force 2>&1 | Out-Host
    if (Test-ExtPresent $cli $extId) { Write-Host "  ${extId}: на месте."; return $true }
    Write-Host "  ${extId}: не подтвердилось."; return $false
}

if (-not $codeCli -and -not $DRY) {
    Write-Host "CLI VS Code (code.cmd) не найден — расширения не поставить автоматически. Открой VS Code, панель Extensions -> найди 'Claude Code' и 'ChatGPT - Codex' -> Install."
    exit 1
}

$claudeVsix = Get-Vsix 'claude-code.vsix'
$codexVsix  = Get-Vsix 'chatgpt.vsix'
$okClaude = Install-Ext $codeCli 'anthropic.claude-code' $claudeVsix
$okCodex  = Install-Ext $codeCli 'openai.chatgpt' $codexVsix

if ($okClaude) { Write-Host "OK: панель Claude Code в VS Code установлена." }
if ($okCodex)  { Write-Host "OK: Codex (openai.chatgpt) в VS Code установлен." }
if ($okClaude) { exit 0 }
Write-Host "Claude Code расширение не подтвердилось. Открой VS Code -> Extensions -> 'Claude Code' -> Install. Claude Code также работает в терминале командой 'claude'."
exit 1
