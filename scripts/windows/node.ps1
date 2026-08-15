# Node.js LTS — Windows
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
. (Join-Path $PSScriptRoot '_deelev.ps1')  # New-HmSecureStagingDir (Admins-only secure-cache для онлайн-фолбэка)
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
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}

# Update-Path меняет PATH ТОЛЬКО внутри этого процесса. Этого хватает, чтобы мы сами
# нашли node, — и ровно поэтому шаг рапортовал «OK: node v22», когда в системном PATH
# записи не было вовсе: у человека в новом терминале node не находился, npx не работал,
# а вместе с ним молча не поднимался НИ ОДИН MCP-сервер (их почти все запускает npx).
# Штатный MSI обычно прописывает PATH сам, но не всегда: при установке поверх, при
# «только для меня» или при переполненном PATH запись не появляется. Мы идём под
# админом, поэтому проверяем реальный HKLM и дописываем недостающее сами.
function Add-HmMachinePath([string]$Dir) {
    if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { return $false }
    $cur = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $has = @($cur -split ';') | Where-Object { $_ -and $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }
    if ($has) { return $false }
    $new = if ($cur -and $cur.TrimEnd(';')) { $cur.TrimEnd(';') + ';' + $Dir } else { $Dir }
    # Системный PATH ограничен: за 2047 символов запись молча теряется, а вместе с ней
    # может уехать и чужой софт. Лучше честно сказать, чем испортить окружение.
    if ($new.Length -ge 2047) {
        Write-Host "  ВНИМАНИЕ: системный PATH переполнен ($($new.Length) символов) — не дописываю $Dir."
        Write-Host "  Добавь его вручную: Параметры -> Система -> О системе -> Дополнительные параметры системы -> Переменные среды."
        return $false
    }
    try {
        [Environment]::SetEnvironmentVariable('Path', $new, 'Machine')
        Write-Host "  В системный PATH добавлено: $Dir (новые окна терминала увидят сразу)"
        return $true
    } catch {
        Write-Host "  Не удалось дописать $Dir в системный PATH ($($_.Exception.Message))."
        return $false
    }
}

$DRY = [bool]$env:HM_DRY_RUN
Write-Host "Проверяю Node.js..."
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Node.js уже установлен: $(node --version)"
    if ($DRY) { Write-Host "[dry-run] Node.js уже установлен — без изменений."; exit 0 }
    # Даже когда Node на месте, системная запись PATH может отсутствовать: мы видим node
    # через свой процессный PATH, а пользователь в новом терминале — нет. Чиним молча.
    if ($env:ProgramFiles) { [void](Add-HmMachinePath (Join-Path $env:ProgramFiles 'nodejs')) }
    exit 0
}

$local = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\node-lts.msi' } else { '' }
if ($local -and (Test-Path $local)) {
    Write-Host "Ставлю Node.js из встроенного MSI (офлайн)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: msiexec /i $local /qn /norestart" }
    else { Confirm-HmArtifact $local; Start-Process msiexec.exe -ArgumentList '/i', "`"$local`"", '/qn', '/norestart' -Wait }
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    if ($DRY) { Write-Host "  [dry-run] WOULD: winget install -e --id OpenJS.NodeJS.LTS --silent" }
    else { Write-Host "Устанавливаю Node.js LTS через winget..."; winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements }
} else {
    if ($DRY) { Write-Host "  [dry-run] WOULD: скачать MSI Node.js LTS с nodejs.org в secure-cache, проверить подпись и msiexec /i /qn" }
    else {
        Write-Host "winget не найден — качаю MSI Node.js LTS..."
        # СЕТЬ: дефолтный TimeoutSec=0 (бесконечно) недопустим, а прогресс-бар в PS5.1 в разы замедляет скачивание.
        # SECURITY (#4): качаем НЕ в user-writable %TEMP% (medium-малварь того же юзера подменила бы msi
        # между скачиванием и msiexec → RCE под админом), а в ADMIN-OWNED secure-cache
        # (New-HmSecureStagingDir -Elevated $true). Перед elevated-запуском — гейт Authenticode (fail-closed).
        $ProgressPreference = 'SilentlyContinue'
        $sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
        $icacls   = Join-Path (Join-Path $sysRoot 'System32') 'icacls.exe'
        $progData = Join-Path ([System.IO.Path]::GetPathRoot($sysRoot)) 'ProgramData'
        $cache = $null
        if ((Test-Path -LiteralPath $icacls) -and (Test-Path -LiteralPath $progData)) {
            $cache = New-HmSecureStagingDir -ProgramData $progData -Icacls $icacls -Elevated $true
        }
        if (-not ($cache -and (Test-Path -LiteralPath $cache))) {
            Write-Host "  Не удалось создать защищённый кэш для скачивания — прерываю онлайн-фолбэк Node.js."
            exit 1
        }
        $msi = $null
        try {
            $idx = Invoke-RestMethod "https://nodejs.org/dist/index.json" -UseBasicParsing -TimeoutSec 60
            $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
            $url = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi"
            $msi = Join-Path $cache "node-lts.msi"
            Invoke-WebRequest $url -OutFile $msi -UseBasicParsing -TimeoutSec 600
        } catch {
            Remove-HmSecureStagingDir -Path $cache
            Write-Host "Сеть недоступна или медленная — повтори установку компонента. ($($_.Exception.Message))"
            exit 1
        }
        # Гейт подписи ДО запуска (fail-closed): elevated-запуск неподтверждённого msi недопустим
        # даже из secure-cache. Одного Status='Valid' МАЛО: цепочка строится пользовательским
        # chain-engine, который принял бы корень, подложенный medium-малварью того же юзера в
        # HKCU\...\SystemCertificates\Root БЕЗ UAC. Test-HmTrustedSigner требует корень в
        # LocalMachine\Root + EKU Code Signing (тот же принцип, что в claude-desktop.ps1).
        $why = if ($msi) { Test-HmTrustedSigner -Path $msi } else { 'MSI не найден' }
        if (-not $why) {
            Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait
        } else {
            Write-Host "  БЕЗОПАСНОСТЬ: подпись MSI Node.js не подтвердилась ($why) — НЕ запускаю (fail-closed)."
        }
        # Чистим Admins-only кэш (установщик уже отработал; больше не нужен). Best-effort.
        Remove-HmSecureStagingDir -Path $cache
    }
}

if ($DRY) { Write-Host "[dry-run] Node.js: офлайн-ветка выбрана, без изменений."; exit 0 }
Update-Path
if (Get-Command node -ErrorAction SilentlyContinue) {
    # Сначала системный PATH, потом рапорт: раньше здесь был «OK: node v22» при пустой
    # записи в HKLM — успех по процессному PATH, которого пользователь никогда не увидит.
    if ($env:ProgramFiles) { [void](Add-HmMachinePath (Join-Path $env:ProgramFiles 'nodejs')) }
    $inMachine = @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') |
        Where-Object { $_ -and $_.TrimEnd('\') -ilike '*\nodejs' }
    if (-not $inMachine) {
        Write-Host "ВНИМАНИЕ: node.exe есть, но каталог не попал в системный PATH — в новом терминале команда node может не найтись."
        Write-Host "  Из-за этого не запустятся npx и MCP-серверы. Добавь каталог Node в PATH вручную и перезапусти терминал."
    }
    Write-Host "OK: node $(node --version), npm $(npm --version)"
    exit 0
}
Write-Host "Node.js не обнаружен после установки."; exit 1
