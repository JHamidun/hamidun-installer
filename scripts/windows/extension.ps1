# Claude Code extension (Cursor + VS Code) — Windows
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
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

function Test-ExtPresent($cli) {
    # --list-extensions может лагать сразу после установки — ретраим.
    for ($k = 0; $k -lt 3; $k++) {
        try { $list = & $cli --list-extensions 2>$null; if (("$list") -match [regex]::Escape($extId)) { return $true } } catch { }
        Start-Sleep -Milliseconds 1500
    }
    return $false
}

function Install-Into($cli, $label) {
    if (-not $cli) { return $false }
    Write-Host "Ставлю расширение в $label..."
    if ($DRY) {
        if ($vsix) { Write-Host "  [dry-run] WOULD: $cli --install-extension $vsix --force" }
        else { Write-Host "  [dry-run] WOULD: $cli --install-extension $extId --force" }
        return $true
    }
    if ($vsix) {
        Write-Host "  из вшитого vsix (офлайн): $vsix"
        & $cli --install-extension $vsix --force 2>&1 | Out-Host
        if (Test-ExtPresent $cli) { Write-Host "  ${label}: расширение на месте."; return $true }
        Write-Host "  ${label}: vsix не подтвердился — пробую Marketplace ($extId)..."
    }
    & $cli --install-extension $extId --force 2>&1 | Out-Host
    if (Test-ExtPresent $cli) { Write-Host "  ${label}: расширение на месте."; return $true }
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
if (Install-Into $cursorCli 'Cursor') { $installed = $true } elseif (-not $cursorCli) { Write-Host "Cursor CLI не найден — пропускаю Cursor." }

# Настоящий VS Code (НЕ курсоровский code-шим, который отдаёт VS Code 1.67.1)
$codeCli = $null
foreach ($p in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd", "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd")) { if (Test-Path $p) { $codeCli = $p; break } }
if ($codeCli) { if (Install-Into $codeCli 'VS Code') { $installed = $true } }

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
    if ($codeCli -and -not $installed) { if (Install-Into $codeCli 'VS Code') { $installed = $true } }
}

if ($installed) { Write-Host "OK: расширение установлено."; exit 0 }
Write-Host "Расширение не установилось автоматически. В Cursor: панель расширений -> найди '$extId' -> Install. Claude Code также работает в терминале командой 'claude'."
exit 1
