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

Write-Host "[vendor] Claude Code VSIX (расширение для VSCode/Cursor, офлайн)..."
$vsix = Join-Path $apps 'claude-code.vsix'
if (Test-Path $vsix) {
  Write-Host "  skip claude-code.vsix"
} else {
  # Расширение платформо-специфичное (8 платформ): latest/vspackage БЕЗ targetPlatform отдаёт чужую
  # платформу (linux-x64). Резолвим последнюю версию под win32-x64 и качаем versioned URL.
  $vsixVer = $null
  try {
    $q = '{"filters":[{"criteria":[{"filterType":7,"value":"anthropic.claude-code"}]}],"flags":1}'
    $resp = Invoke-RestMethod 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.2-preview.1' -Method Post -Body $q -ContentType 'application/json' -Headers $UA
    $vsixVer = ($resp.results[0].extensions[0].versions | Where-Object { $_.targetPlatform -eq 'win32-x64' } | Select-Object -First 1).version
  } catch { }
  if ($vsixVer) {
    Dl "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/anthropic/vsextensions/claude-code/$vsixVer/vspackage?targetPlatform=win32-x64" $vsix
  } else {
    Write-Host "  ! Marketplace недоступен — VSIX пропущен (расширение поставится онлайн при установке)"
  }
}
if (Test-Path $vsix) {
  # Marketplace часто отдаёт vspackage с Content-Encoding: gzip, а IWR в PS 5.1 сам не распаковывает.
  try {
    $fs = [IO.File]::OpenRead($vsix); $b0 = $fs.ReadByte(); $b1 = $fs.ReadByte(); $fs.Close()
    if ($b0 -eq 0x1f -and $b1 -eq 0x8b) {
      Write-Host "  ответ Marketplace в gzip — распаковываю в .vsix"
      $gzTmp = "$vsix.gz.tmp"
      Move-Item $vsix $gzTmp -Force
      $in  = [IO.File]::OpenRead($gzTmp)
      $gz  = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
      $out = [IO.File]::Create($vsix)
      $gz.CopyTo($out)
      $out.Close(); $gz.Close(); $in.Close()
      Remove-Item $gzTmp -Force
    }
  } catch { Write-Host "  ! постобработка vsix не удалась - $($_.Exception.Message)" }
} else { Write-Host "  ! VSIX недоступен — расширение поставится онлайн при установке" }

Write-Host "[vendor] JetBrains Mono Regular (шрифт, лицензия OFL)..."
$font = Join-Path $apps 'JetBrainsMono-Regular.ttf'
if (Test-Path $font) {
  Write-Host "  skip JetBrainsMono-Regular.ttf"
} else {
  # Официальный релиз JetBrains/JetBrainsMono — zip с fonts/ttf/*.ttf внутри.
  try {
    $rel = Invoke-RestMethod "https://api.github.com/repos/JetBrains/JetBrainsMono/releases/latest" -Headers $UA
    $a = $rel.assets | Where-Object { $_.name -match '^JetBrainsMono-.*\.zip$' } | Select-Object -First 1
    if ($a) {
      $jbZip = Join-Path $apps '_jbmono.zip'
      Write-Host "  GET  $($a.browser_download_url)"
      Invoke-WebRequest $a.browser_download_url -OutFile $jbZip -MaximumRedirection 6 -UseBasicParsing
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $za = [IO.Compression.ZipFile]::OpenRead($jbZip)
      try {
        $entry = $za.Entries | Where-Object { $_.FullName -match 'ttf[/\\]JetBrainsMono-Regular\.ttf$' } | Select-Object -First 1
        if ($entry) { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $font, $true) }
      } finally { $za.Dispose() }
      Remove-Item $jbZip -Force -ErrorAction SilentlyContinue
    }
  } catch { Write-Host "  ! релиз JetBrains Mono не скачался - $($_.Exception.Message)" }
  if (-not (Test-Path $font)) {
    # Фолбэк: raw-файл из репозитория (тот же OFL ttf).
    Dl "https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Regular.ttf" $font
  }
  if (Test-Path $font) { Write-Host "  ok JetBrainsMono-Regular.ttf" }
  else { Write-Host "  ! шрифт не скачался — extension поставится без шрифта (не критично)" }
}

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

Write-Host "[vendor] checksums.json — SHA-256 всех файлов vendor/apps (целостность/доверие)..."
try {
  $sums = [ordered]@{}
  Get-ChildItem $apps -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 } | Sort-Object Name | ForEach-Object {
    $h = Get-FileHash $_.FullName -Algorithm SHA256
    $sums[$_.Name] = [ordered]@{ sha256 = $h.Hash.ToLower(); bytes = $_.Length }
  }
  $chk = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    algorithm   = 'sha256'
    files       = $sums
  }
  $chkPath = Join-Path $root 'vendor\checksums.json'
  [IO.File]::WriteAllText($chkPath, (ConvertTo-Json $chk -Depth 5))
  Write-Host ("  файлов захешировано: {0}" -f $sums.Count)
} catch { Write-Host "  ! checksums.json не сгенерирован - $($_.Exception.Message)" }

Write-Host "[vendor] Проверка полноты vendor..."
$missing = @()
foreach ($name in @('git-setup.exe','node-lts.msi','python-setup.exe','cursor-setup.exe','claude-code.vsix')) {
  $f = Get-Item (Join-Path $apps $name) -ErrorAction SilentlyContinue
  if (-not $f -or $f.Length -eq 0) { $missing += "apps/$name" }
}
foreach ($pat in @('amneziawg-setup.*','amneziavpn-setup.*')) {
  $hit = Get-ChildItem $apps -File -Filter $pat -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 } | Select-Object -First 1
  if (-not $hit) { $missing += "apps/$pat" }
}
foreach ($d in @('npm-cache','pywheels','config-pack')) {
  $dir = Join-Path $root ('vendor\' + $d)
  $cnt = 0
  if (Test-Path $dir) {
    $cnt = (Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 } | Measure-Object).Count
  }
  if ($cnt -eq 0) { $missing += ($d + '/ (нет файлов)') }
}
if ($missing.Count -gt 0) {
  Write-Host ''
  Write-Host "[vendor] WARNING: неполный vendor — отсутствуют/пустые артефакты:"
  foreach ($m in $missing) { Write-Host "  - $m" }
  Write-Host "[vendor] Установка на этих компонентах уйдёт в онлайн-фолбэк или упадёт."
} else {
  Write-Host "[vendor] OK: все ключевые артефакты на месте."
}

$total = (Get-ChildItem -Recurse -File (Join-Path $root 'vendor') | Measure-Object Length -Sum).Sum
Write-Host ("[vendor] ГОТОВО — vendor\ весит {0:N0} МБ" -f ($total/1MB))
