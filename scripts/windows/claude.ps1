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
$npmExit = $null
if ($cache -and (Test-Path $cache) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Ставлю Claude Code CLI из встроенного npm-кеша (офлайн)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: npm install -g @anthropic-ai/claude-code --offline --cache $cache"; exit 0 }
    npm install -g '@anthropic-ai/claude-code' --offline --cache $cache --no-audit --no-fund
    $npmExit = $LASTEXITCODE
    if ($npmExit -ne 0) {
        Write-Host "Офлайн-установка npm вернула код ${npmExit}. Пробую онлайн-установщик..."
        try {
            Invoke-RestMethod "https://claude.ai/install.ps1" | Invoke-Expression
        } catch {
            Write-Host "Онлайн-установщик тоже не сработал ($($_.Exception.Message))."
        }
    }
} else {
    Write-Host "Устанавливаю Claude Code CLI (нативный установщик, онлайн)..."
    try {
        Invoke-RestMethod "https://claude.ai/install.ps1" | Invoke-Expression
    } catch {
        Write-Host "Нативный установщик не сработал ($($_.Exception.Message)). Пробую npm..."
        if (Get-Command npm -ErrorAction SilentlyContinue) {
            npm install -g '@anthropic-ai/claude-code'
            $npmExit = $LASTEXITCODE
        } else {
            Write-Host "npm недоступен — установите компонент Node.js."; exit 1
        }
    }
}

Update-Path

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

$claudeBin = Find-ClaudeBinary
if ($claudeBin) {
    Write-Host "OK: Claude Code CLI установлен ($claudeBin)."
    exit 0
}

Write-Host "ОШИБКА: Claude Code CLI не установился."
exit 1
