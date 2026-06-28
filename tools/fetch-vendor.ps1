# Build-time: download ALL third-party software into vendor/ for fully OFFLINE install (Windows).
# Idempotent: existing files are skipped. Run via: npm run fetch:vendor
# Continue (not Stop): нативные команды (npm/pip) пишут notice в stderr — под Stop это рушит скрипт.
$ErrorActionPreference = 'Continue'
$root  = Split-Path -Parent $PSScriptRoot
$apps  = Join-Path $root 'vendor\apps'
New-Item -ItemType Directory -Force $apps | Out-Null
$UA = @{ 'User-Agent' = 'hamidun-setup' }

function Dl($url, $out) {
  if (Test-Path $out) { Write-Host "  skip $([IO.Path]::GetFileName($out))"; return }
  try { Write-Host "  GET  $url"; Invoke-WebRequest $url -OutFile $out -MaximumRedirection 6 -UseBasicParsing }
  catch { Write-Host "  ! не скачалось ($([IO.Path]::GetFileName($out))): $($_.Exception.Message)" }
}

Write-Host "[vendor] Git for Windows..."
$rel = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers $UA
$a = $rel.assets | Where-Object { $_.name -match '64-bit\.exe$' } | Select-Object -First 1
Dl $a.browser_download_url (Join-Path $apps 'git-setup.exe')

Write-Host "[vendor] Node.js LTS..."
$idx = Invoke-RestMethod "https://nodejs.org/dist/index.json"
$lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
Dl "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi" (Join-Path $apps 'node-lts.msi')

Write-Host "[vendor] Cursor..."
$curUrl = $null
foreach ($base in @('https://www.cursor.com', 'https://cursor.com')) {
  try {
    $cur = Invoke-RestMethod "$base/api/download?platform=win32-x64-user&releaseTrack=stable" -Headers $UA -MaximumRedirection 10
    if ($cur.downloadUrl) { $curUrl = $cur.downloadUrl; break }
  } catch { }
}
if ($curUrl) { Dl $curUrl (Join-Path $apps 'cursor-setup.exe') }
else { Write-Host "  ! Cursor API недоступен — онлайн-фолбэк при установке" }

Write-Host "[vendor] Python (под версию сборочной машины — чтобы wheels совпали)..."
$pyver = (& python -c "import platform;print(platform.python_version())" 2>$null)
if (-not $pyver) { $pyver = '3.12.10' }
$pyver = "$pyver".Trim()
$pyInstaller = Join-Path $apps 'python-setup.exe'
if (Test-Path $pyInstaller) { Remove-Item $pyInstaller -Force -ErrorAction SilentlyContinue }
Write-Host "  версия: $pyver"
Dl "https://www.python.org/ftp/python/$pyver/python-$pyver-amd64.exe" $pyInstaller

Write-Host "[vendor] AmneziaWG client..."
try {
  $rel = Invoke-RestMethod "https://api.github.com/repos/amnezia-vpn/amneziawg-windows-client/releases/latest" -Headers $UA
  $a = $rel.assets | Where-Object { $_.name -match '\.(exe|msi)$' } | Select-Object -First 1
  if ($a) { Dl $a.browser_download_url (Join-Path $apps ('amneziawg-setup' + [IO.Path]::GetExtension($a.name))) }
} catch { Write-Host "  (AmneziaWG релиз не найден, пропускаю)" }

Write-Host "[vendor] AmneziaVPN (full)..."
try {
  $rel = Invoke-RestMethod "https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest" -Headers $UA
  $a = $rel.assets | Where-Object { $_.name -match 'windows' -and $_.name -match '\.exe$' } | Select-Object -First 1
  if (-not $a) { $a = $rel.assets | Where-Object { $_.name -match '\.exe$' } | Select-Object -First 1 }
  if ($a) { Dl $a.browser_download_url (Join-Path $apps 'amneziavpn-setup.exe') }
} catch { Write-Host "  (AmneziaVPN релиз не найден, пропускаю)" }

Write-Host "[vendor] Claude Code CLI -> npm cache (для офлайн -g установки)..."
$cache = Join-Path $root 'vendor\npm-cache'
$tmp   = Join-Path $root 'vendor\_claudetmp'
New-Item -ItemType Directory -Force $tmp | Out-Null
& npm install '@anthropic-ai/claude-code' --prefix $tmp --cache $cache --no-audit --no-fund 2>&1 | Out-Null
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host "[vendor] Python wheels (под локальный Python = bundled Python, без кросс-флагов)..."
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
$req = Join-Path $root 'vendor\config-pack\requirements.txt'
$wheels = Join-Path $root 'vendor\pywheels'
if (Test-Path $wheels) { Remove-Item -Recurse -Force $wheels -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force $wheels | Out-Null
if ($py -and (Test-Path $req)) {
  & $py -m pip download pip setuptools wheel -d $wheels 2>&1 | Select-Object -Last 1
  & $py -m pip download -r $req pystray pillow -d $wheels 2>&1 | Select-Object -Last 3
  Write-Host "  wheels/sdists: $((Get-ChildItem $wheels -File).Count) шт."
} else { Write-Host "  (python/requirements не найдены, пропускаю wheels)" }

Write-Host "[vendor] Playwright Chromium (best-effort)..."
$pw = Join-Path $root 'vendor\playwright-browsers'
New-Item -ItemType Directory -Force $pw | Out-Null
if ($py) {
  try {
    & $py -m pip install --quiet playwright 2>&1 | Out-Null
    $env:PLAYWRIGHT_BROWSERS_PATH = $pw
    & $py -m playwright install chromium 2>&1 | Select-Object -Last 2
  } catch { Write-Host "  (playwright browsers пропущены: $($_.Exception.Message))" }
}

$total = (Get-ChildItem -Recurse -File (Join-Path $root 'vendor') | Measure-Object Length -Sum).Sum
Write-Host ("[vendor] ГОТОВО — vendor\ весит {0:N0} МБ" -f ($total/1MB))
