# Node.js LTS — Windows
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
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

$DRY = [bool]$env:HM_DRY_RUN
Write-Host "Проверяю Node.js..."
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Host "Node.js уже установлен: $(node --version)"; if ($DRY) { Write-Host "[dry-run] Node.js уже установлен — без изменений."; exit 0 } else { exit 0 } }

$local = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\node-lts.msi' } else { '' }
if ($local -and (Test-Path $local)) {
    Write-Host "Ставлю Node.js из встроенного MSI (офлайн)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: msiexec /i $local /qn /norestart" }
    else { Confirm-HmArtifact $local; Start-Process msiexec.exe -ArgumentList '/i', "`"$local`"", '/qn', '/norestart' -Wait }
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    if ($DRY) { Write-Host "  [dry-run] WOULD: winget install -e --id OpenJS.NodeJS.LTS --silent" }
    else { Write-Host "Устанавливаю Node.js LTS через winget..."; winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements }
} else {
    if ($DRY) { Write-Host "  [dry-run] WOULD: скачать MSI Node.js LTS с nodejs.org и msiexec /i /qn" }
    else {
        Write-Host "winget не найден — качаю MSI Node.js LTS..."
        $idx = Invoke-RestMethod "https://nodejs.org/dist/index.json"
        $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
        $url = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi"
        $msi = Join-Path $env:TEMP "node-lts.msi"
        Invoke-WebRequest $url -OutFile $msi
        Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait
    }
}

if ($DRY) { Write-Host "[dry-run] Node.js: офлайн-ветка выбрана, без изменений."; exit 0 }
Update-Path
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Host "OK: node $(node --version), npm $(npm --version)"; exit 0 }
Write-Host "Node.js не обнаружен после установки."; exit 1
