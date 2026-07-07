# Git — Windows
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }

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
    if ($DRY) { Write-Host "  [dry-run] WOULD: скачать Git for Windows с github.com и запустить /VERYSILENT" }
    else {
        Write-Host "winget не найден — качаю Git for Windows напрямую..."
        $rel = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ 'User-Agent' = 'hamidun-setup' }
        $asset = $rel.assets | Where-Object { $_.name -match '64-bit\.exe$' } | Select-Object -First 1
        $exe = Join-Path $env:TEMP $asset.name
        Invoke-WebRequest $asset.browser_download_url -OutFile $exe
        Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/NORESTART','/SP-','/SUPPRESSMSGBOXES' -Wait
    }
}

if ($DRY) { Write-Host "[dry-run] Git: офлайн-ветка выбрана, без изменений."; exit 0 }
Update-Path
if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host "OK: $(git --version)"; Set-HmGitDefaults; exit 0 }
Write-Host "Git не обнаружен после установки."; exit 1
