# Claude Code CLI — Windows (native installer)
$ErrorActionPreference = 'Continue'
# irm|iex ниже тянет ОФИЦИАЛЬНЫЙ установщик claude.ai по HTTPS (доверие = TLS + подлинность домена).
# Своего SHA-256 для него нет (плавающая версия). Форсим TLS 1.2, чтобы PS5.1 не откатился на TLS1.0.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
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
    if ($DRY) { Write-Host "  [dry-run] WOULD: irm https://claude.ai/install.ps1 | iex (или npm install -g @anthropic-ai/claude-code)"; exit 0 }
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

$claudeBin = Find-ClaudeBinary
if ($claudeBin) {
    Add-ToUserPath (Split-Path $claudeBin)
    Add-ToUserPath (Join-Path $env:USERPROFILE '.local\bin')
    Write-Host "OK: Claude Code CLI установлен ($claudeBin). Открой НОВЫЙ терминал, чтобы работала команда claude."
    exit 0
}

Write-Host "ОШИБКА: Claude Code CLI не установился."
exit 1
