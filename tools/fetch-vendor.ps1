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

Write-Host "[vendor] VS Code (рекомендуемый редактор, User Setup — офлайн-установка без админа)..."
# User Setup ставится в профиль пользователя (без прав администратора) — лучший вариант для новичка.
# URL — редирект на актуальный установщик; IWR следует за ним (-MaximumRedirection).
Dl "https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-user" (Join-Path $apps 'vscode-setup.exe')

Write-Host "[vendor] Python (под версию сборочной машины — чтобы wheels совпали)..."
$pyver = (& python -c "import platform;print(platform.python_version())" 2>$null)
if (-not $pyver) { $pyver = '3.12.10' }
$pyver = "$pyver".Trim()
$pyInstaller = Join-Path $apps 'python-setup.exe'
if (Test-Path $pyInstaller) { Remove-Item $pyInstaller -Force -ErrorAction SilentlyContinue }
Write-Host "  версия: $pyver"
Dl "https://www.python.org/ftp/python/$pyver/python-$pyver-amd64.exe" $pyInstaller

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

Write-Host "[vendor] Codex VSIX (openai.chatgpt из Open VSX, офлайн — Codex прямо в VS Code)..."
$cxvsix = Join-Path $apps 'chatgpt.vsix'
if (Test-Path $cxvsix) {
  Write-Host "  skip chatgpt.vsix"
} else {
  # Open VSX: расширение платформо-специфичное (внутри bundled codex-бинарь). /latest БЕЗ
  # платформы отдаёт ЧУЖУЮ платформу (напр. alpine-arm64/linux-x64) → офлайн-install на Windows
  # упадёт по несовпадению платформы. Резолвим win32-x64; нет такой цели → generic /latest
  # (хуже для офлайна, но online-фолбэк в vscode.ps1 спасёт). Всё non-fatal: Codex опционален.
  try {
    $cxUrl = $null
    try {
      $cxMeta = Invoke-RestMethod 'https://open-vsx.org/api/openai/chatgpt/win32-x64/latest' -Headers $UA -MaximumRedirection 6
      $cxUrl = $cxMeta.files.download
    } catch { }
    if (-not $cxUrl) {
      $cxMeta = Invoke-RestMethod 'https://open-vsx.org/api/openai/chatgpt/latest' -Headers $UA -MaximumRedirection 6
      $cxUrl = $cxMeta.files.download
      if ($cxUrl) { Write-Host "  win32-x64-цель не найдена — беру generic (офлайн может не встать, online-фолбэк)" }
    }
    if ($cxUrl) { Dl $cxUrl $cxvsix }
    else { Write-Host "  ! Open VSX не отдал ссылку на .vsix — Codex поставится онлайн при установке" }
  } catch { Write-Host "  ! Open VSX недоступен ($($_.Exception.Message)) — Codex поставится онлайн при установке" }
}

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

Write-Host "[vendor] uv (Astral, Windows x64) — вшитый офлайн-компонент..."
# Официальный источник — GitHub releases astral-sh/uv (latest/download — стабильный
# URL без API). Распаковываем uv.exe + uvx.exe в apps\uv\ — checksums.json (ниже,
# -Recurse) захеширует их автоматически; uv.ps1 проверит fail-closed (Confirm-HmArtifact).
# Валиден ли уже разложенный vendor-uv: ОБА бинаря (uv.exe + uvx.exe) на месте и непустые.
function Test-HmUvVendorValid([string]$dir) {
  $e = Get-Item (Join-Path $dir 'uv.exe')  -ErrorAction SilentlyContinue
  $x = Get-Item (Join-Path $dir 'uvx.exe') -ErrorAction SilentlyContinue
  return ($e -and $e.Length -gt 0 -and $x -and $x.Length -gt 0)
}
$uvDir = Join-Path $apps 'uv'
$uvExe = Join-Path $uvDir 'uv.exe'
# P1 (Codex): skip доверяем ТОЛЬКО валидному существующему каталогу (те же проверки,
# что при свежей закачке: оба exe непустые). Полу-извлечённый uv.exe без uvx.exe (или
# пустой) от прерванного fetch → НЕ skip: удаляем каталог и качаем заново (иначе он
# прошёл бы size-only FATAL-гейт → сломанный uv).
$uvNeedFetch = $true
if (Test-Path $uvExe) {
  if (Test-HmUvVendorValid $uvDir) {
    Write-Host "  skip uv\uv.exe (uv.exe + uvx.exe на месте)"
    $uvNeedFetch = $false
  } else {
    Write-Host "  ! существующий vendor\apps\uv битый/неполный (нет uvx.exe или пустой) — перекачиваю"
    Remove-Item -Recurse -Force $uvDir -ErrorAction SilentlyContinue
  }
}
if ($uvNeedFetch) {
  # P1-B: качаем zip во ВРЕМЕННЫЙ .part и раскладываем uv.exe/uvx.exe в apps\uv ТОЛЬКО
  # после того, как zip открылся И содержит ОБА бинаря — распаковываем в _stage и делаем
  # atomic-move в apps\uv. Иначе сбой докачки оставил бы частичный/битый zip или
  # полу-распакованный каталог, который прошёл бы FATAL-гейт по размеру → сломанный exe.
  $uvZip   = Join-Path $apps '_uv.zip.part'
  $uvStage = Join-Path $apps '_uv-stage'
  Remove-Item $uvZip -Force -ErrorAction SilentlyContinue
  if (Test-Path $uvStage) { Remove-Item -Recurse -Force $uvStage -ErrorAction SilentlyContinue }
  $uvOk = $false
  try {
    Write-Host "  GET  uv-x86_64-pc-windows-msvc.zip"
    Invoke-WebRequest "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" -OutFile $uvZip -MaximumRedirection 6 -UseBasicParsing
  } catch { Write-Host "  ! uv не скачался: $($_.Exception.Message)"; Remove-Item $uvZip -Force -ErrorAction SilentlyContinue }
  if (Test-Path $uvZip) {
    try {
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      New-Item -ItemType Directory -Force $uvStage | Out-Null
      $za = [IO.Compression.ZipFile]::OpenRead($uvZip)   # битый zip → бросит здесь
      try {
        foreach ($n in @('uv.exe', 'uvx.exe')) {
          $entry = $za.Entries | Where-Object { $_.Name -eq $n } | Select-Object -First 1
          if ($entry) { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $uvStage $n), $true) }
        }
      } finally { $za.Dispose() }
      # Требуем ОБА бинаря непустыми (та же проверка, что для skip) — иначе не публикуем.
      if (Test-HmUvVendorValid $uvStage) { $uvOk = $true }
      else { Write-Host "  ! в архиве uv нет uv.exe/uvx.exe (или пустые) — не публикую" }
    } catch { Write-Host "  ! uv не распаковался - $($_.Exception.Message)" }
    Remove-Item $uvZip -Force -ErrorAction SilentlyContinue
  }
  if ($uvOk) {
    # atomic-ish: убираем возможный старый каталог и переносим проверенный _stage на место.
    if (Test-Path $uvDir) { Remove-Item -Recurse -Force $uvDir -ErrorAction SilentlyContinue }
    Move-Item -Force $uvStage $uvDir
    Write-Host "  ok uv\uv.exe (+uvx.exe)"
  } else {
    if (Test-Path $uvStage) { Remove-Item -Recurse -Force $uvStage -ErrorAction SilentlyContinue }
    Write-Host "  ! uv не вшит — компонент uv не попадёт в сборку (FATAL-гейт ниже)"
  }
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

Write-Host "[vendor] Скрепка Claude (маскот, локальная Windows-сборка)..."
$mascotSrc = 'C:\Users\hamid\claude-mascot\src-tauri\target\release\claude-mascot.exe'
$mascotDir = Join-Path $apps 'claude-mascot'
if (Test-Path $mascotSrc) {
  New-Item -ItemType Directory -Force $mascotDir | Out-Null
  Copy-Item -Force $mascotSrc (Join-Path $mascotDir 'claude-mascot.exe')
  Write-Host "  ok claude-mascot.exe (из локальной сборки)"
} elseif (Test-Path (Join-Path $mascotDir 'claude-mascot.exe')) {
  Write-Host "  skip claude-mascot.exe (уже в vendor)"
} else {
  Write-Host "  ! исходник скрепки не найден ($mascotSrc) — компонент «Скрепка» не попадёт в сборку."
}

# --- Экспорт-фильтр nomad-src (гигиена раздаваемого exe; порт 1:1 из fetch-vendor-mac.sh) ---
# В exe уезжает ВСЁ дерево vendor\nomad-src каждому покупателю. Репо агента НЕ трогаем —
# фильтруем ТОЛЬКО экспортированную копию после git archive: внутренние dev-артефакты
# (.superpowers/, docs/plans|superpowers/, deploy/, *report*-отчёты) вырезаем,
# деанон/секрет-паттерны гейтуем. FATAL — только если паттерн остаётся в коде, НУЖНОМ
# для установки (py/toml пакетных директорий + pyproject.toml + README/LICENSE);
# остальное чистим сами с логом — билд не падает по мелочи.
$NOMAD_LEAK_RE = '95\.179\.242\.167|transform-ai\.online|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{36}|sk-[A-Za-z0-9_-]{40}|xoxb-[0-9]{8}'

function Test-NomadSrcCritical {
  # $Rel = путь ОТНОСИТЕЛЬНО корня nomad-src, разделители '/'. Код, нужный `uv tool install`:
  # pyproject.toml + README/LICENSE/MANIFEST.in (pyproject ссылается: readme=/license-files= —
  # удаление молча сломало бы install у покупателя) + *.py пакетных дир (pyproject
  # [tool.setuptools.packages.find] include: agent, tools, nomad_cli, gateway, tui_gateway,
  # cron, acp_adapter, plugins, providers; любая вложенность) + top-level *.py/*.toml.
  param([string]$Rel)
  if ($Rel -eq 'pyproject.toml') { return $true }
  if ($Rel -in @('README.md', 'LICENSE', 'MANIFEST.in')) { return $true }
  if ($Rel -match '^(agent|tools|nomad_cli|gateway|tui_gateway|cron|acp_adapter|plugins|providers)/.*\.py$') { return $true }
  if ($Rel -match '/') { return $false }
  if ($Rel -match '\.(py|toml)$') { return $true }
  return $false
}

function Invoke-NomadSrcSanitize {
  # Возвращает $true = фильтр пройден; $false = FATAL (несводимые паттерны / битая структура).
  param([string]$Src)
  Write-Host "  [nomad-src] экспорт-фильтр: внутренние артефакты НЕ едут пользователям..."
  # 1) Внутренние директории целиком (отчёты процессов, планы/спеки, deploy-доки с IP).
  foreach ($rel in @('.superpowers', 'docs\plans', 'docs\superpowers', 'deploy')) {
    $p = Join-Path $Src $rel
    if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "    - удалил $($rel -replace '\\','/')/" }
  }
  # 2) Внутренние *report*-отчёты: top-level (PHASE1_*_REPORT.md), docs\, scripts\.
  #    Продуктовые файлы, матчащие глоб (agent/lsp/reporter.py, шаблоны skills/bug-report.md
  #    и т.п.), НЕ трогаем — они часть агента.
  $reportFiles = @(Get-ChildItem $Src -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*report*' })
  foreach ($d in @('docs', 'scripts')) {
    $dp = Join-Path $Src $d
    if (Test-Path $dp) {
      $reportFiles += @(Get-ChildItem $dp -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*report*' })
    }
  }
  foreach ($f in $reportFiles) {
    $rel = $f.FullName.Substring($Src.Length + 1) -replace '\\', '/'
    Remove-Item -Force $f.FullName
    Write-Host "    - удалил $rel"
  }
  # 3) Файлы с деанон/секрет-паттернами: НЕ нужные установке — удаляем (с логом);
  #    install-critical — скрабим IP/домен (текстовая замена безопасна и в комментарии,
  #    и в строковом литерале). Токен-паттерн в критическом коде скрабить нельзя
  #    (меняет семантику) → останется до гейта ниже → FATAL.
  $removed = 0
  $matched = @(Get-ChildItem $Src -File -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { Select-String -Path $_.FullName -Pattern $NOMAD_LEAK_RE -Quiet -ErrorAction SilentlyContinue })
  foreach ($f in $matched) {
    $rel = $f.FullName.Substring($Src.Length + 1) -replace '\\', '/'
    if (Test-NomadSrcCritical $rel) {
      $txt = [IO.File]::ReadAllText($f.FullName)
      $txt = $txt -replace '95\.179\.242\.167', 'REDACTED-IP' -replace 'transform-ai\.online', 'redacted.example'
      [IO.File]::WriteAllText($f.FullName, $txt)
      Write-Host "    ~ скраб IP/домена в $rel (install-critical, файл сохранён)"
    } else {
      Remove-Item -Force $f.FullName; $removed++
      Write-Host "    - удалил $rel (деанон/секрет-паттерн)"
    }
  }
  # 4) Жёсткий гейт: после чистки паттернов быть НЕ должно НИГДЕ. Сюда доходит только
  #    несводимое (токен в install-critical коде / непокрытый скраб) → FATAL со списком.
  $left = @(Get-ChildItem $Src -File -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { Select-String -Path $_.FullName -Pattern $NOMAD_LEAK_RE -Quiet -ErrorAction SilentlyContinue })
  if ($left.Count -gt 0) {
    Write-Host "[vendor] FATAL: в vendor\nomad-src остались деанон/секрет-паттерны (IP/домен/токены) в файлах:"
    foreach ($f in $left) { Write-Host ("  - " + ($f.FullName.Substring($Src.Length + 1) -replace '\\', '/')) }
    Write-Host "[vendor] Вычисти их в репо агента (или расширь экспорт-фильтр) и перезапусти сборку."
    return $false
  }
  # Санити: структура пакета для `uv tool install` не сломана.
  if (-not (Test-Path (Join-Path $Src 'pyproject.toml'))) {
    Write-Host "[vendor] FATAL: экспорт-фильтр повредил nomad-src (нет pyproject.toml)"; return $false
  }
  # Файлы, на которые ссылается pyproject (readme=/license-files=), обязаны пережить фильтр —
  # иначе `uv tool install` падает у покупателя на install-time без сигнала в сборке.
  $pyprojTxt = Get-Content -Raw (Join-Path $Src 'pyproject.toml') -ErrorAction SilentlyContinue
  foreach ($rel in @('README.md', 'LICENSE')) {
    if ($pyprojTxt -and ($pyprojTxt -match [regex]::Escape($rel)) -and -not (Test-Path (Join-Path $Src $rel))) {
      Write-Host "[vendor] FATAL: экспорт-фильтр удалил $rel, на который ссылается pyproject.toml"; return $false
    }
  }
  Write-Host "  [nomad-src] фильтр ок (файлов с паттернами удалено: $removed)"
  return $true
}
# --- /Экспорт-фильтр nomad-src ---

Write-Host "[vendor] Исходник Nomad → vendor\nomad-src (git archive merged-кода, БЕЗ .git; vendor-only установка)..."
# Компонент Nomad объявлен? Друзьям не нужен доступ к репозиторию: код едет офлайн внутри
# установщика. nomad-src приватный, в git НЕ коммитится (.gitignore vendor/). Нет
# исходника → компонент Nomad у пользователя выполнит graceful skip (exit 120) — сборку НЕ валим.
$componentsRawN = Get-Content -Raw (Join-Path $root 'components.json') -ErrorAction SilentlyContinue
if ($componentsRawN -and $componentsRawN -match '"nomad"') {
  $agentRepo = if ($env:HM_NOMAD_AGENT_REPO) { $env:HM_NOMAD_AGENT_REPO } else { 'C:\Vibecode\hamidun-agent' }
  $nomadRef  = if ($env:HM_NOMAD_REF)        { $env:HM_NOMAD_REF }        else { 'main' }
  $srcOut    = Join-Path $root 'vendor\nomad-src'
  if (-not (Test-Path (Join-Path $agentRepo '.git'))) {
    Write-Host "  ! репозиторий Nomad не найден ($agentRepo) — задай HM_NOMAD_AGENT_REPO. nomad-src НЕ вшит (компонент Nomad → graceful skip)."
  } else {
    $resolved = (& git -C $agentRepo rev-parse --short $nomadRef 2>$null)
    Write-Host "  ref $nomadRef → коммит $resolved"
    $tmpTar = Join-Path $env:TEMP 'nomad-src.tar'
    if (Test-Path $tmpTar) { Remove-Item $tmpTar -Force -ErrorAction SilentlyContinue }
    # git archive пишет корректный tar (пайп в PowerShell портит бинарь → используем --output).
    & git -C $agentRepo archive --format=tar --output "$tmpTar" $nomadRef
    if ((Test-Path $tmpTar) -and ((Get-Item $tmpTar).Length -gt 0)) {
      if (Test-Path $srcOut) { Remove-Item -Recurse -Force $srcOut -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Force $srcOut | Out-Null
      # Нативный Windows tar.exe (bsdtar) — понимает C:\ пути. НЕ msys /usr/bin/tar.
      & "$env:SystemRoot\System32\tar.exe" -x -f "$tmpTar" -C "$srcOut"
      Remove-Item $tmpTar -Force -ErrorAction SilentlyContinue
      if (Test-Path (Join-Path $srcOut 'pyproject.toml')) {
        # Экспорт-фильтр + гейт: несводимые деанон/секрет-паттерны в раздаваемом exe → FATAL.
        if (-not (Invoke-NomadSrcSanitize $srcOut)) { exit 1 }
        $mbn = [math]::Round(((Get-ChildItem $srcOut -Recurse -File | Measure-Object Length -Sum).Sum)/1MB, 0)
        Write-Host "  ok vendor\nomad-src ($mbn МБ, pyproject.toml на месте; фильтр пройден)"
      } else {
        Write-Host "  ! в vendor\nomad-src нет pyproject.toml — архив пустой/битый (компонент Nomad → graceful skip)."
      }
    } else {
      Write-Host "  ! git archive не создал tar — nomad-src НЕ вшит (компонент Nomad → graceful skip)."
    }
  }
} else {
  Write-Host "  (компонент nomad не объявлен в components.json — пропускаю nomad-src)"
}

Write-Host "[vendor] checksums.json — SHA-256 файлов vendor/apps + архива курса (целостность/доверие)..."
try {
  # Чистый .NET (Get-FileHash недоступен в powershell electron-builder-сборки —
  # модуль Utility не подхватывается; ConvertTo-Json тоже избегаем).
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $entries = New-Object System.Collections.ArrayList
  # -Recurse: артефакты в подпапках (apps\claude-mascot\claude-mascot.exe) тоже в манифест —
  # Confirm-HmArtifact ищет запись по ИМЕНИ файла, путь не важен.
  $toHash = @(Get-ChildItem $apps -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 })
  # Вшитый архив курса — тоже в манифест: course.ps1 проверяет его fail-closed
  # (Confirm-HmArtifact), как остальные вшитые артефакты. Имя vibecoding-course.zip
  # уникально — коллизий по базовому имени (ключ манифеста) нет.
  $courseZipChk = Get-Item (Join-Path $root 'vendor\course\vibecoding-course.zip') -ErrorAction SilentlyContinue
  if ($courseZipChk -and $courseZipChk.Length -gt 0) { $toHash += $courseZipChk }
  $toHash | Sort-Object Name | ForEach-Object {
    $fs = [IO.File]::OpenRead($_.FullName)
    try { $hb = $sha.ComputeHash($fs) } finally { $fs.Dispose() }
    $hex = ([BitConverter]::ToString($hb) -replace '-', '').ToLower()
    [void]$entries.Add('    "' + $_.Name + '": { "sha256": "' + $hex + '", "bytes": ' + $_.Length + ' }')
  }
  $ts = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $json = "{`r`n  ""generatedAt"": ""$ts"",`r`n  ""algorithm"": ""sha256"",`r`n  ""files"": {`r`n" + ($entries -join ",`r`n") + "`r`n  }`r`n}`r`n"
  $chkPath = Join-Path $root 'vendor\checksums.json'
  [IO.File]::WriteAllText($chkPath, $json)
  Write-Host ("  файлов захешировано: {0}" -f $entries.Count)
} catch { Write-Host "  ! checksums.json не сгенерирован - $($_.Exception.Message)" }

Write-Host "[vendor] Проверка полноты vendor..."
$missing = @()
foreach ($name in @('git-setup.exe','node-lts.msi','python-setup.exe','vscode-setup.exe','cursor-setup.exe','claude-code.vsix')) {
  $f = Get-Item (Join-Path $apps $name) -ErrorAction SilentlyContinue
  if (-not $f -or $f.Length -eq 0) { $missing += "apps/$name" }
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

# Курс-симулятор (объединён в базовую сборку, раздаётся всем бесплатно): архив ОБЯЗАН
# быть в vendor\course — без него компонент «Курс интенсива» падает у КАЖДОГО. Валим
# сборку сразу. Архив лёгкий (~275 КБ) и трекается в git (см. !vendor/course/ в .gitignore).
$componentsRawC = Get-Content -Raw (Join-Path $root 'components.json') -ErrorAction SilentlyContinue
if ($componentsRawC -and $componentsRawC -match '"course"') {
  $courseZip = Join-Path $root 'vendor\course\vibecoding-course.zip'
  $cz = Get-Item $courseZip -ErrorAction SilentlyContinue
  if (-not $cz -or $cz.Length -eq 0) {
    Write-Host "[vendor] FATAL: нет vendor\course\vibecoding-course.zip — курс-симулятор не попадёт в сборку. Проверь, что архив закоммичен (!vendor/course/)."
    exit 1
  }
  Write-Host "[vendor] OK: курс-симулятор на месте (vendor\course\vibecoding-course.zip)."
}

# uv: вшитый ОФЛАЙН-компонент БЕЗ онлайн-фолбэка (uv.ps1 ставит только из vendor).
# Если компонент «uv» объявлен в components.json — ОБА бинаря (uv.exe И uvx.exe) обязаны
# лежать непустыми (P1 Codex: не только uv.exe — полу-извлечённый каталог протащил бы
# сломанный компонент). Валим сборку сразу с понятным сообщением, а не пользователя.
$componentsRawU = Get-Content -Raw (Join-Path $root 'components.json') -ErrorAction SilentlyContinue
if ($componentsRawU -and $componentsRawU -match '"uv"') {
  if (-not (Test-HmUvVendorValid (Join-Path $apps 'uv'))) {
    Write-Host "[vendor] FATAL: vendor\apps\uv неполон — нужны ОБА непустых uv.exe и uvx.exe. Удали каталог и перезапусти fetch-vendor, либо убери компонент uv из components.json."
    exit 1
  }
  Write-Host "[vendor] OK: uv на месте и валиден (vendor\apps\uv\uv.exe + uvx.exe)."
}

# Скрепка: exe попадает в vendor только с машины с локальной сборкой маскота. Если компонент
# «mascot» объявлен в components.json, а exe нет — чистая сборка спакует СЛОМАННЫЙ компонент.
# Валим сборку сразу с понятным сообщением, а не молча.
$componentsRawM = Get-Content -Raw (Join-Path $root 'components.json') -ErrorAction SilentlyContinue
if ($componentsRawM -and $componentsRawM -match '"mascot"') {
  $mascotExe = Get-Item (Join-Path $apps 'claude-mascot\claude-mascot.exe') -ErrorAction SilentlyContinue
  if (-not $mascotExe -or $mascotExe.Length -eq 0) {
    Write-Host "[vendor] FATAL: Скрепка: нет vendor\apps\claude-mascot\claude-mascot.exe — запусти fetch-vendor на машине со сборкой маскота, или убери компонент mascot из components.json."
    exit 1
  }
  Write-Host "[vendor] OK: скрепка на месте (vendor\apps\claude-mascot\claude-mascot.exe)."
}

$total = (Get-ChildItem -Recurse -File (Join-Path $root 'vendor') | Measure-Object Length -Sum).Sum
Write-Host ("[vendor] ГОТОВО — vendor\ весит {0:N0} МБ" -f ($total/1MB))
