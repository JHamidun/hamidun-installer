# Git — Windows
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

$DRY = [bool]$env:HM_DRY_RUN

# Дружелюбные git-дефолты (идемпотентно; ошибки конфигурации НЕ валят установку).
function Set-HmGitDefaults {
    $ErrorActionPreference = 'Continue'
    try {
        # Каждый дефолт ставим ТОЛЬКО если пользователь его ещё не задал — не затираем уже настроенное.
        $lp = ''
        try { $lp = ("$(git config --global core.longpaths 2>$null)").Trim() } catch { }
        if (-not $lp) { git config --global core.longpaths true 2>$null }
        $db = ''
        try { $db = ("$(git config --global init.defaultBranch 2>$null)").Trim() } catch { }
        if (-not $db) { git config --global init.defaultBranch main 2>$null }
        $ac = ''
        try { $ac = ("$(git config --global core.autocrlf 2>$null)").Trim() } catch { }
        if (-not $ac) { git config --global core.autocrlf true 2>$null }
        $un = ''
        try { $un = ("$(git config --global user.name 2>$null)").Trim() } catch { }
        if (-not $un) {
            $name = if ($env:USERNAME) { $env:USERNAME } else { 'user' }
            git config --global user.name "$name" 2>$null
            git config --global user.email "$name@example.com" 2>$null
            Write-Host "Git: user.name/user.email заданы по умолчанию — поменяй потом: git config --global user.email твоя@почта"
        }
        Write-Host "Git-дефолты применены (longpaths, main, autocrlf)."
    } catch { Write-Host "Git-дефолты: предупреждение: $($_.Exception.Message)" }
}

Write-Host "Проверяю Git..."
# В DRY выходим и когда git уже есть — иначе холостой прогон проваливался бы в
# install-ветку и winget переустанавливал бы Git.
if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host "Git уже установлен: $(git --version)"; if ($DRY) { Write-Host "[dry-run] Git уже установлен — без изменений."; exit 0 } else { Set-HmGitDefaults; exit 0 } }

$local = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\git-setup.exe' } else { '' }
if ($local -and (Test-Path $local)) {
    Write-Host "Ставлю Git из встроенного установщика (офлайн)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: $local /VERYSILENT /NORESTART /SP- /SUPPRESSMSGBOXES" }
    else { Confirm-HmArtifact $local; Start-Process -FilePath $local -ArgumentList '/VERYSILENT','/NORESTART','/SP-','/SUPPRESSMSGBOXES' -Wait }
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    if ($DRY) { Write-Host "  [dry-run] WOULD: winget install -e --id Git.Git --silent" }
    else { Write-Host "Устанавливаю Git через winget..."; winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements }
} else {
    if ($DRY) { Write-Host "  [dry-run] WOULD: скачать Git for Windows с github.com в secure-cache, проверить подпись и запустить /VERYSILENT" }
    else {
        Write-Host "winget не найден — качаю Git for Windows напрямую..."
        # СЕТЬ: дефолтный TimeoutSec=0 (бесконечно) недопустим, а прогресс-бар в PS5.1 в разы замедляет скачивание.
        # SECURITY (#4): качаем НЕ в user-writable %TEMP% (medium-малварь того же юзера подменила бы exe
        # между скачиванием и Start-Process → RCE под админом), а в ADMIN-OWNED secure-cache
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
            Write-Host "  Не удалось создать защищённый кэш для скачивания — прерываю онлайн-фолбэк Git."
            exit 1
        }
        $exe = $null
        try {
            $rel = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ 'User-Agent' = 'hamidun-setup' } -UseBasicParsing -TimeoutSec 60
            $asset = $rel.assets | Where-Object { $_.name -match '64-bit\.exe$' } | Select-Object -First 1
            $exe = Join-Path $cache $asset.name
            Invoke-WebRequest $asset.browser_download_url -OutFile $exe -UseBasicParsing -TimeoutSec 600
        } catch {
            try { Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue } catch { }
            Write-Host "Сеть недоступна или медленная — повтори установку компонента. ($($_.Exception.Message))"
            exit 1
        }
        # Гейт подписи ДО запуска (fail-closed): elevated-запуск неподтверждённого exe недопустим даже из secure-cache.
        $sig = if ($exe -and (Test-Path -LiteralPath $exe)) { Get-AuthenticodeSignature -LiteralPath $exe } else { $null }
        if ($sig -and $sig.Status -eq 'Valid') {
            Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/NORESTART','/SP-','/SUPPRESSMSGBOXES' -WorkingDirectory $cache -Wait
        } else {
            $st = if ($sig) { $sig.Status } else { 'нет подписи' }
            Write-Host "  БЕЗОПАСНОСТЬ: подпись установщика Git не подтвердилась ($st) — НЕ запускаю (fail-closed)."
        }
        # Чистим Admins-only кэш (установщик уже отработал; больше не нужен). Best-effort.
        try { Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
}

if ($DRY) { Write-Host "[dry-run] Git: офлайн-ветка выбрана, без изменений."; exit 0 }
Update-Path
if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host "OK: $(git --version)"; Set-HmGitDefaults; exit 0 }
Write-Host "Git не обнаружен после установки."; exit 1
