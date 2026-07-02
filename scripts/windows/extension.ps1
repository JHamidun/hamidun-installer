# Claude Code extension (Cursor + VS Code) — Windows
$ErrorActionPreference = 'Continue'
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
Update-Path

$extId = if ($env:HM_CLAUDE_EXT_ID) { $env:HM_CLAUDE_EXT_ID } else { 'anthropic.claude-code' }
$DRY = [bool]$env:HM_DRY_RUN
$installed = $false

# Вшитый vsix (полный офлайн) — кладёт build-задача в HM_VENDOR/apps/claude-code.vsix.
$vsix = ''
if ($env:HM_VENDOR) { $cand = Join-Path $env:HM_VENDOR 'apps\claude-code.vsix'; if (Test-Path $cand) { $vsix = $cand } }

# Cursor должен быть ЗАКРЫТ, иначе --install-extension падает с 'aborted' (баг с теста).
if (-not $DRY) { Get-Process Cursor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600 }

function Test-ExtPresent($cli) {
    try { $list = & $cli --list-extensions 2>$null; return (("$list") -match [regex]::Escape($extId)) } catch { return $false }
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

# Cursor CLI (только настоящий cursor.cmd)
$cursorCli = $null
$cc = Join-Path $env:LOCALAPPDATA 'Programs\cursor\resources\app\bin\cursor.cmd'
if (Test-Path $cc) { $cursorCli = $cc } else { $g = Get-Command cursor -ErrorAction SilentlyContinue; if ($g) { $cursorCli = $g.Source } }
if (Install-Into $cursorCli 'Cursor') { $installed = $true } elseif (-not $cursorCli) { Write-Host "Cursor CLI не найден — пропускаю Cursor." }

# Настоящий VS Code (НЕ курсоровский code-шим, который отдаёт VS Code 1.67.1)
$codeCli = $null
foreach ($p in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd", "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd")) { if (Test-Path $p) { $codeCli = $p; break } }
if ($codeCli) { if (Install-Into $codeCli 'VS Code') { $installed = $true } }

if ($installed) { Write-Host "OK: расширение установлено."; exit 0 }
Write-Host "Расширение не установилось автоматически. В Cursor: панель расширений -> найди '$extId' -> Install. Claude Code также работает в терминале командой 'claude'."
exit 1
