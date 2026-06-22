# Claude Code CLI — Windows (native installer)
$ErrorActionPreference = 'Continue'
function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User') + ';' +
                (Join-Path $env:USERPROFILE '.local\bin')
}

Update-Path
$DRY = [bool]$env:HM_DRY_RUN
$cache = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'npm-cache' } else { '' }
if ($cache -and (Test-Path $cache) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Ставлю Claude Code CLI из встроенного npm-кеша (офлайн)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: npm install -g @anthropic-ai/claude-code --offline --cache $cache"; exit 0 }
    npm install -g '@anthropic-ai/claude-code' --offline --cache $cache --no-audit --no-fund
} else {
    Write-Host "Устанавливаю Claude Code CLI (нативный установщик, онлайн)..."
    try {
        Invoke-RestMethod "https://claude.ai/install.ps1" | Invoke-Expression
    } catch {
        Write-Host "Нативный установщик не сработал ($($_.Exception.Message)). Пробую npm..."
        if (Get-Command npm -ErrorAction SilentlyContinue) {
            npm install -g '@anthropic-ai/claude-code'
        } else {
            Write-Host "npm недоступен — установите компонент Node.js."; exit 1
        }
    }
}

Update-Path
if (Get-Command claude -ErrorAction SilentlyContinue) { Write-Host "OK: $(claude --version)"; exit 0 }
Write-Host "claude установлен, но не в текущем PATH — появится после перезапуска терминала."
exit 0
