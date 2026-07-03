# Verify — финальная диагностика установки (Windows)
# Печатает строки вида "CHECK ok <ярлык>" / "CHECK fail <ярлык>" — их ловит рендерер
# и рисует чеклист на финальном экране. Диагностика НЕ проваливает установку: всегда exit 0.
$ErrorActionPreference = 'Continue'
function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User') + ';' +
                (Join-Path $env:USERPROFILE '.local\bin')
}
Update-Path

Write-Host "Финальная проверка установки..."

# --- Git ---
$gitOk = $false
if (Get-Command git -ErrorAction SilentlyContinue) {
    try {
        $v = ("$(git --version 2>$null)").Trim()
        if ($v) { Write-Host "  git: $v"; $gitOk = $true }
    } catch { }
}
if ($gitOk) { Write-Host "CHECK ok Git" } else { Write-Host "CHECK fail Git" }

# --- Node ---
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
    try {
        $v = ("$(node -v 2>$null)").Trim()
        if ($v) { Write-Host "  node: $v"; $nodeOk = $true }
    } catch { }
}
if ($nodeOk) { Write-Host "CHECK ok Node" } else { Write-Host "CHECK fail Node" }

# --- Claude CLI (тот же поиск бинаря, что в claude.ps1 — не доверяем только PATH) ---
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
$claudeBin = Find-ClaudeBinary
if ($claudeBin) {
    Write-Host "  claude: $claudeBin"
    Write-Host "CHECK ok Claude CLI"
} else {
    Write-Host "CHECK fail Claude CLI"
}

# --- Конфиг (~/.claude развёрнут?) ---
$claudeHome = Join-Path $env:USERPROFILE '.claude'
if ((Test-Path (Join-Path $claudeHome 'settings.json')) -or (Test-Path (Join-Path $claudeHome 'skills'))) {
    Write-Host "CHECK ok Конфиг"
} else {
    Write-Host "CHECK fail Конфиг"
}

# --- Расширение Claude Code (через НАСТОЯЩИЕ CLI Cursor / VS Code, не code-шим) ---
$extId = if ($env:HM_CLAUDE_EXT_ID) { $env:HM_CLAUDE_EXT_ID } else { 'anthropic.claude-code' }
$extOk = $false
$clis = @()
$cc = Join-Path $env:LOCALAPPDATA 'Programs\cursor\resources\app\bin\cursor.cmd'
if (Test-Path $cc) { $clis += $cc }
foreach ($p in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd", "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd")) {
    if (Test-Path $p) { $clis += $p; break }
}
foreach ($cli in $clis) {
    if ($extOk) { break }
    try {
        $list = & $cli --list-extensions 2>$null
        if (("$list") -match [regex]::Escape($extId)) { Write-Host "  расширение найдено через: $cli"; $extOk = $true }
    } catch { }
}
if ($extOk) { Write-Host "CHECK ok Расширение" } else { Write-Host "CHECK fail Расширение" }

# Диагностика — не провал: всегда зелёный выход.
exit 0
