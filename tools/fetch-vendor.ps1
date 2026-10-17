# Build-time: download ALL third-party software into vendor/ for fully OFFLINE install (Windows).
# Idempotent: existing files are skipped. Run via: npm run fetch:vendor
# -VerifyOnly: ничего не качать, не создавать и не удалять — только проверить подписи издателей у того, что
# уже лежит в vendor\apps (так его зовёт tools\regen-checksums.js перед записью манифеста). Код выхода:
# 0 — всё подтверждено пином, 1 — нет.
# Continue (not Stop): нативные команды (npm/pip) пишут notice в stderr — под Stop это рушит скрипт.
param([switch]$VerifyOnly, [switch]$Release)
$ErrorActionPreference = 'Continue'
# -Release: релизная сборка (npm run dist / dist:win зовут `fetch:vendor -- -Release`). То же, что HM_RELEASE=1 в окружении:
# без личного списка паттернов экспорт-фильтра nomad-src сборка останавливается (как в CI), а не предупреждает и едет дальше.
if ($Release) { $env:HM_RELEASE = '1' }
$root  = Split-Path -Parent $PSScriptRoot
$apps  = Join-Path $root 'vendor\apps'
if (-not $VerifyOnly) { New-Item -ItemType Directory -Force $apps | Out-Null }
$UA = @{ 'User-Agent' = 'hamidun-setup' }

# --- Пин издателя скачанных файлов (находка S-1; таблица — tools/vendor-signers.json) ---------
# Установщики качаются по «latest»/API-ссылкам БЕЗ закреплённой версии, а checksums.json ниже
# снимается с того, что легло на диск, — то есть файл, подменённый по дороге (CDN, DNS, TLS),
# стал бы эталоном для всех гейтов Lite/Offline и уехал бы покупателям. Сумма, снятая с
# непроверенного файла, ничего не доказывает; доказывает подпись ИЗДАТЕЛЯ, и сверяем её здесь —
# в единственном месте, где файл ещё не попал в манифест. Онлайн-фолбэки установки (git.ps1,
# node.ps1, cursor.ps1, pydeps.ps1) подпись проверяют давно; офлайн-копия — нет.
#
# Принимается подпись, у которой выполнено ВСЁ вместе:
#  1) Status = Valid: Windows проверяет подпись с меткой времени на момент подписания;
#  2) подпись встроенная (SignatureType = Authenticode), а не каталожная, и у листа есть назначение
#     Code Signing;
#  3) общее имя подписанта сверяется ТОЧНО (с регистром), а не подстрокой: «Microsoft Corporation
#     Ltd» подстроку «Microsoft Corporation» содержит;
#  4) корень цепочки подписанта лежит в LocalMachine\Root. Status = Valid считает ПОЛЬЗОВАТЕЛЬСКИЙ
#     движок цепочек, а он доверяет и корням из HKCU, куда процесс среднего уровня целостности пишет
#     без UAC (certutil -user -addstore Root ...): сертификат с нужным именем, выпущенный таким
#     корнем (или самоподписанный и положенный туда же), получал бы Valid, и подмена по сети ложилась
#     бы в манифест. Тот же принцип, что у Test-HmTrustedSigner на установке (_deelev.ps1); функция
#     здесь своя — _deelev.ps1 при загрузке трогает планировщик задач.
# Цепочку при этом строим БЕЗ оценки сроков (IgnoreNotTimeValid и родственные флаги): у части издателей
# лист (Microsoft ID Verified) живёт 72 часа и к моменту сборки давно просрочен, а подпись при этом
# настоящая. Отсюда правило для сроков: если вне срока годности ХОТЬ ОДНО звено цепочки (лист, промежуточный
# или корень), подпись держится только на метке времени, и принимается лишь та, чья собственная цепочка
# тоже заканчивается в LocalMachine\Root (назначение Time Stamping). Иначе медиум-процесс клал бы свой
# корень метки времени в HKCU и «датировал» подпись украденным просроченным ключом задним числом. Сроки
# самой метки времени не оцениваются: у настоящего python-setup.exe сертификат метки уже просрочен, и
# отвергнуть его по нынешним часам нельзя — метке времени метки времени не бывает.
# Не совпало что-либо — файл удаляется и сборка падает (exit 1); «предупредить и продолжить» здесь нет,
# иначе подмена тихо становится эталоном.
$HmSigners = $null
try { $HmSigners = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'vendor-signers.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { }
if (-not $HmSigners -or -not $HmSigners.signed -or -not $HmSigners.unsigned -or -not $HmSigners.pythonSdists.pyaes.sha256) {
  Write-Host "[vendor] FATAL: tools\vendor-signers.json не читается или без разделов signed/unsigned/pythonSdists — без таблицы пинов качать установщики и пакеты нельзя."
  exit 1
}
# Проверять подпись нечем — стоп ДО первой загрузки, а не «удалить 200 МБ установщика, потому что
# модуль безопасности не подгрузился» (Test-HmVendorSigner считает сбой чтения подписи подозрительным).
if (-not (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue)) {
  Write-Host "[vendor] FATAL: Get-AuthenticodeSignature недоступна (модуль Microsoft.PowerShell.Security не загружен) — подпись установщиков проверить нечем, а качать без проверки нельзя."
  exit 1
}

function New-HmSignerVerdict($Ok, $Kind, $Delete, $Reason) {
  return [pscustomobject]@{ Ok = [bool]$Ok; Kind = [string]$Kind; Delete = [bool]$Delete; Reason = [string]$Reason }
}

# Отпечатки корней МАШИНЫ: LocalMachine\Root, только чтение. Отдельной функцией — шов для тестов (настоящее
# хранилище им подменять нельзя). CurrentUser\Root здесь не смотрим вовсе: его пишет любой процесс пользователя.
function Get-HmMachineRootThumbprints {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store([System.Security.Cryptography.X509Certificates.StoreName]::Root, [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
  $out = New-Object System.Collections.Generic.List[string]
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    foreach ($c in $store.Certificates) { [void]$out.Add([string]$c.Thumbprint) }
  } finally { try { $store.Close() } catch { } }
  return $out.ToArray()
}

# Построитель цепочек — второй шов для тестов: тестовые корни не лежат ни в одном хранилище Windows, и тесту
# нужна цепочка с дополнительными сертификатами и разрешением «неизвестный корень». В бою — обычная чистая цепочка.
function New-HmX509Chain {
  return (New-Object System.Security.Cryptography.X509Certificates.X509Chain)
}

# Есть ли у сертификата ЯВНОЕ назначение (EKU) с этим OID. Лист вовсе без расширения движок цепочек
# считает «пригодным для любого назначения», а кодовую подпись и метку времени вправе ставить только
# сертификат, где назначение названо.
function Test-HmCertHasEku {
  param($Cert, [string]$Oid)
  foreach ($ext in $Cert.Extensions) {
    if ($ext -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
      foreach ($o in $ext.EnhancedKeyUsages) { if ($o.Value -eq $Oid) { return $true } }
    }
  }
  return $false
}

# Цепочка сертификата БЕЗ оценки сроков годности: { Built; Why; Root; OutOfWindow }.
#   Built       — цепочка выстроилась до доверенного корня (Why — причина, если нет);
#   Root        — верхний сертификат цепочки (X509Certificate2);
#   OutOfWindow — имена звеньев, у которых СЕГОДНЯ срок вышел или ещё не начался. Срок оценивается у
#                 КАЖДОГО звена, а не только у листа: лист, годный сегодня под просроченным
#                 промежуточным, проходил бы «листовую» проверку, а подпись держится на метке времени.
# Назначение (Eku) обязана допускать вся цепочка: Code Signing для подписи, Time Stamping для метки.
# Отзыв не проверяется (сеть не нужна; решение о подписи — Status = Valid). Доверие к самому корню строит
# движок Windows, поэтому «корень в LocalMachine\Root» проверяется отдельно, по отпечатку (см. ниже).
function Get-HmChainAnchor {
  param([Parameter(Mandatory = $true)]$Cert, [Parameter(Mandatory = $true)][string]$Eku)
  $F = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]
  $chain = New-HmX509Chain
  $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
  $chain.ChainPolicy.VerificationFlags = $chain.ChainPolicy.VerificationFlags -bor $F::IgnoreNotTimeValid -bor $F::IgnoreCtlNotTimeValid -bor $F::IgnoreNotTimeNested
  [void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object System.Security.Cryptography.Oid($Eku)))
  $built = $false
  try { $built = $chain.Build($Cert) }
  catch { return [pscustomobject]@{ Built = $false; Why = ("не удалось построить цепочку: " + $_.Exception.Message); Root = $null; OutOfWindow = @() } }
  $st = (@($chain.ChainStatus | ForEach-Object { [string]$_.Status }) -join ',')
  if (-not $built) { return [pscustomobject]@{ Built = $false; Why = ("цепочка не выстроилась (" + $st + "; без сети цепочку может не достроить)"); Root = $null; OutOfWindow = @() } }
  $els = @($chain.ChainElements)
  if ($els.Count -lt 1) { return [pscustomobject]@{ Built = $false; Why = 'цепочка пуста'; Root = $null; OutOfWindow = @() } }
  $now = [DateTime]::UtcNow
  $out = New-Object System.Collections.ArrayList
  foreach ($e in $els) {
    $c = $e.Certificate
    if (($c.NotAfter.ToUniversalTime() -lt $now) -or ($c.NotBefore.ToUniversalTime() -gt $now)) {
      [void]$out.Add([string]$c.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false))
    }
  }
  $root = $els[$els.Count - 1].Certificate
  if (-not $root -or -not $root.Thumbprint) { return [pscustomobject]@{ Built = $false; Why = 'корень цепочки не определён'; Root = $null; OutOfWindow = @() } }
  return [pscustomobject]@{ Built = $true; Why = ''; Root = $root; OutOfWindow = $out.ToArray() }
}

# Якорь подписи: '' — подписи можно верить, иначе причина отказа. Подпись $Sig — объект
# Get-AuthenticodeSignature (SignerCertificate, TimeStamperCertificate).
function Test-HmSignerAnchored {
  param([Parameter(Mandatory = $true)]$Sig)
  $machine = $null
  try { $machine = @(Get-HmMachineRootThumbprints) }
  catch { return ("хранилище корней машины (LocalMachine\Root) не открылось: " + $_.Exception.Message) }
  $a = Get-HmChainAnchor -Cert $Sig.SignerCertificate -Eku '1.3.6.1.5.5.7.3.3'
  if (-not $a.Built) { return ("цепочка сертификата подписанта: " + $a.Why) }
  $rootName = [string]$a.Root.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($machine -notcontains [string]$a.Root.Thumbprint) {
    return ("корень цепочки подписанта «" + $rootName + "» не лежит в LocalMachine\Root (Status=Valid мог выдать корень из пользовательского хранилища HKCU: туда пишет любой процесс пользователя без UAC)")
  }
  if (@($a.OutOfWindow).Count -gt 0) {
    $names = (@($a.OutOfWindow) -join '; ')
    $ts = $Sig.TimeStamperCertificate
    if (-not $ts) { return ("у подписи нет метки времени, а звенья цепочки вне срока годности (" + $names + ") — срок подтвердить нечем") }
    $t = Get-HmChainAnchor -Cert $ts -Eku '1.3.6.1.5.5.7.3.8'
    if (-not $t.Built) { return ("звенья цепочки вне срока годности (" + $names + "), а цепочка метки времени: " + $t.Why) }
    $tsRoot = [string]$t.Root.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($machine -notcontains [string]$t.Root.Thumbprint) {
      return ("звенья цепочки вне срока годности (" + $names + "), а корень метки времени «" + $tsRoot + "» не лежит в LocalMachine\Root — чужой метке времени срок подписи не доверяем")
    }
    if (-not (Test-HmCertHasEku $ts '1.3.6.1.5.5.7.3.8')) {
      return ("звенья цепочки вне срока годности (" + $names + "), а у сертификата метки времени нет назначения Time Stamping (EKU 1.3.6.1.5.5.7.3.8)")
    }
  }
  return ''
}

# Вердикт по одному файлу: { Ok; Kind = signed|unsigned|unknown; Delete; Reason }.
#   signed   — Status = Valid, встроенная подпись, CN подписанта ровно из пина, назначение Code Signing у листа
#              и корень цепочки в LocalMachine\Root (иначе Ok = $false, файл подлежит удалению);
#   unsigned — подписи нет по построению (причина названа в таблице) — Ok;
#   unknown  — имени нет ни в одном разделе: Ok = $false, но файл НЕ удаляется (он не подделан, он не внесён).
function Test-HmVendorSigner {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Pins)
  $name = [IO.Path]::GetFileName($Path)
  $rule = $null
  if ($Pins -and $Pins.signed) { $p = $Pins.signed.PSObject.Properties[$name]; if ($p) { $rule = $p.Value } }
  if ($null -eq $rule) {
    if ($Pins -and $Pins.unsigned) {
      $u = $Pins.unsigned.PSObject.Properties[$name]
      if ($u) { return New-HmSignerVerdict $true 'unsigned' $false ([string]$u.Value) }
    }
    return New-HmSignerVerdict $false 'unknown' $false 'нет записи в tools\vendor-signers.json: нужен пин подписанта либо явное «unsigned: <причина>»'
  }
  $sig = $null
  try { $sig = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop }
  catch { return New-HmSignerVerdict $false 'signed' $true ("подпись не читается: " + $_.Exception.Message) }
  if (-not $sig) { return New-HmSignerVerdict $false 'signed' $true 'подпись не читается' }
  if ([string]$sig.Status -ne 'Valid') {
    return New-HmSignerVerdict $false 'signed' $true ("Authenticode Status=" + [string]$sig.Status + " (нужен Valid: файл не подписан, изменён после подписи или подпись не доверена)")
  }
  # Подпись обязана быть ВСТРОЕННОЙ: каталожная (SignatureType = Catalog) даёт Status = Valid любому файлу из
  # каталога ОС — а у такого «подписанта» совсем другое имя и другой смысл.
  if ([string]$sig.SignatureType -ne 'Authenticode') {
    return New-HmSignerVerdict $false 'signed' $true ("тип подписи «" + [string]$sig.SignatureType + "» вместо встроенной Authenticode (каталожная подпись установщика издателя не подтверждает)")
  }
  $cert = $sig.SignerCertificate
  if (-not $cert) { return New-HmSignerVerdict $false 'signed' $true 'подпись Valid, но сертификат подписанта не отдан' }
  $cn = ''
  try { $cn = [string]$cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }
  catch { return New-HmSignerVerdict $false 'signed' $true ("имя подписанта не читается: " + $_.Exception.Message) }
  $allowed = @($rule.cn)
  # Сравнение ПОРЯДКОВОЕ (Ordinal). -ceq / -ccontains / -cnotcontains в Windows PowerShell 5.1 сравнивают с учётом культуры, а там
  # мягкий перенос (U+00AD) «не слышен»: «Microsoft Corporation» + U+00AD считалось бы равным пину (проверено на 5.1.26100). УЦ
  # выпускает сертификат с таким именем, поэтому равенство должно быть побайтовым, а не языковым.
  $cnMatch = $false
  foreach ($pin in $allowed) { if ([string]::Equals([string]$pin, $cn, [StringComparison]::Ordinal)) { $cnMatch = $true; break } }
  if (-not $cnMatch) {
    return New-HmSignerVerdict $false 'signed' $true ("подписант «" + $cn + "» не из пина (ожидалось: " + ($allowed -join ' | ') + ")")
  }
  if (-not (Test-HmCertHasEku $cert '1.3.6.1.5.5.7.3.3')) {
    return New-HmSignerVerdict $false 'signed' $true 'у сертификата подписанта нет назначения Code Signing (EKU 1.3.6.1.5.5.7.3.3)'
  }
  # Якорь: корень цепочки — в LocalMachine\Root; звенья вне срока — только с машинно-заякоренной меткой времени.
  $why = Test-HmSignerAnchored -Sig $sig
  if ($why) { return New-HmSignerVerdict $false 'signed' $true $why }
  return New-HmSignerVerdict $true 'signed' $false ''
}

# Проверить файл и при провале УДАЛИТЬ его (если это подделка/нечитаемая подпись) и завершить сборку
# кодом 1. $CleanupDir — каталог-заготовка, который тоже надо убрать (uv распаковывается в _uv-stage).
# Кэша «этот файл уже проверяли» нет НАМЕРЕННО: между загрузкой и снятием сумм проходят минуты
# (npm, pip, Chromium), а ключ кэша — размер и время записи — подделать проще, чем подпись.
# Итоговый обход (Assert-HmVendorApps) поэтому проверяет каждый файл заново, прямо перед манифестом.
function Assert-HmVendorFile {
  param([Parameter(Mandatory = $true)][string]$Path, [string]$CleanupDir = '')
  $name = [IO.Path]::GetFileName($Path)
  $v = Test-HmVendorSigner -Path $Path -Pins $HmSigners
  if ($v.Ok) {
    if ($v.Kind -eq 'unsigned') { Write-Host ("  unsigned: {0} — {1}" -f $name, $v.Reason) }
    return
  }
  if ($v.Delete) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
  if ($CleanupDir -and (Test-Path -LiteralPath $CleanupDir)) { Remove-Item -LiteralPath $CleanupDir -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host ''
  Write-Host ("[vendor] FATAL: {0}: {1}" -f $name, $v.Reason)
  if ($v.Delete) {
    Write-Host '         Файл УДАЛЁН и в checksums.json не попадёт. Либо его подменили по дороге (CDN, DNS, TLS, чужой корень в'
    Write-Host '         пользовательском хранилище), либо издатель сменил подписанта или цепочку: во втором случае проверь вручную,'
    Write-Host '         что это он, и только потом правь tools\vendor-signers.json. Цепочку, не достроенную без сети, повтори с сетью.'
  } else {
    Write-Host '         Файл не тронут, но сборка остановлена: допиши его в tools\vendor-signers.json (signed или unsigned с причиной).'
  }
  exit 1
}

# Итоговый обход vendor\apps перед снятием сумм: проверяет всё, что туда попало не через Dl
# (скрепка из локальной сборки, шрифт из zip, распакованный uv) и всё, что осталось от прошлых
# прогонов. Недокачанные *.part раньше молча попадали в checksums.json — теперь удаляются.
# Рабочие остатки самого фетчера после оборванного прогона (*.part, *.tmp от снятия gzip, zip
# шрифта, заготовка uv) тоже убираются: иначе правило «неизвестное имя — стоп» упиралось бы в
# мусор, а совет «допиши в таблицу» в сообщении был бы ложным.
function Assert-HmVendorApps {
  param([Parameter(Mandatory = $true)][string]$Apps)
  $uvStageLeft = Join-Path $Apps '_uv-stage'
  if (Test-Path -LiteralPath $uvStageLeft) {
    Remove-Item -LiteralPath $uvStageLeft -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  заготовка _uv-stage от оборванного прогона удалена"
  }
  foreach ($f in @(Get-ChildItem -LiteralPath $Apps -File -Recurse -Force -ErrorAction SilentlyContinue)) {
    if ($f.Name -like '*.part' -or $f.Name -like '*.tmp' -or $f.Name -eq '_jbmono.zip') {
      Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
      Write-Host "  остаток оборванного прогона $($f.Name) удалён"
      continue
    }
    if ($f.Length -eq 0) { continue }
    Assert-HmVendorFile -Path $f.FullName
  }
}

# Режим «только проверить» (-VerifyOnly): для tools\regen-checksums.js — второго писателя манифеста.
# Тот же вердикт (Test-HmVendorSigner), но без загрузок, без создания каталогов и БЕЗ удаления: файл,
# не прошедший проверку, остаётся на диске, а скрипт говорит «нет» кодом 1. Набор файлов — как у манифеста
# (vendor\apps рекурсивно, непустые). Остатки оборванного прогона (*.part, *.tmp) в таблице не значатся,
# поэтому тоже дают «нет»: убрать их умеет только полный прогон фетчера.
if ($VerifyOnly) {
  # Вывод читает другой процесс (node): кириллица в кодировке консоли PS 5.1 дошла бы до него кракозябрами.
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
  if (-not (Test-Path -LiteralPath $apps)) {
    Write-Host "[vendor] FATAL: нет каталога $apps — проверять нечего."
    exit 1
  }
  $vSeen = 0
  $vBad = 0
  foreach ($f in @(Get-ChildItem -LiteralPath $apps -File -Recurse -Force -ErrorAction SilentlyContinue)) {
    if ($f.Length -eq 0) { continue }
    $vSeen++
    $v = Test-HmVendorSigner -Path $f.FullName -Pins $HmSigners
    if ($v.Ok) { Write-Host ("  ok {0} ({1})" -f $f.Name, $v.Kind); continue }
    $vBad++
    Write-Host ("[vendor] ОТКАЗ: {0}: {1}" -f $f.Name, $v.Reason)
  }
  if ($vBad -gt 0) {
    Write-Host ("[vendor] Подписи НЕ подтверждены: файлов {0}, не прошло {1}. Ничего не удалено; полный прогон fetch-vendor.ps1 перекачает и проверит." -f $vSeen, $vBad)
    exit 1
  }
  Write-Host ("[vendor] OK: подписи издателей подтверждены пином (файлов: {0})." -f $vSeen)
  exit 0
}

function Dl($url, $out) {
  if (Test-Path $out) {
    Write-Host "  skip $([IO.Path]::GetFileName($out))"
    # «skip» не освобождает от проверки: файл мог лечь прошлым прогоном (до пина) или быть подменён на диске.
    Assert-HmVendorFile -Path $out
    return
  }
  # Качаем во ВРЕМЕННЫЙ файл и переносим на место только при успехе.
  #
  # Прежняя редакция писала прямо в $out. Invoke-WebRequest в PS 5.1 пишет тело потоково,
  # поэтому обрыв связи посреди загрузки оставлял усечённый файл на диске; catch его не
  # убирал, а следующий прогон пропускал по `Test-Path $out` как готовый. Дальше обрубок
  # проходил весь конвейер незамеченным: regen-checksums снимал SHA-256 С НЕГО ЖЕ и клал
  # в манифест как эталон, гейт целостности сверял диск с этим манифестом и сходился,
  # release-check был зелёный — а покупатель получал битый установщик.
  #
  # Сумма, снятая с непроверенного файла, не проверяет ничего: она фиксирует то, что
  # лежит, а не подтверждает, что лежит правильное. Единственное место, где это можно
  # разорвать, — здесь: на диск под настоящим именем попадает только докачанное до конца.
  $tmp = "$out.part"
  if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
  try {
    Write-Host "  GET  $url"
    Invoke-WebRequest $url -OutFile $tmp -MaximumRedirection 6 -UseBasicParsing
    if (-not (Test-Path $tmp)) { throw 'файл не создан' }
    if ((Get-Item -LiteralPath $tmp).Length -eq 0) { throw 'скачано 0 байт' }
    Move-Item -LiteralPath $tmp -Destination $out -Force
  }
  catch {
    Write-Host "  ! не скачалось ($([IO.Path]::GetFileName($out))): $($_.Exception.Message)"
    if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
  }
  # Подпись издателя — СРАЗУ после загрузки, вне try: exit 1 при провале должен сработать, а не
  # раствориться в catch. Не докачалось (файла нет) — проверять нечего, это отдельный сигнал выше.
  if (Test-Path $out) { Assert-HmVendorFile -Path $out }
}

Write-Host "[vendor] Git for Windows..."
$rel = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers $UA
$a = $rel.assets | Where-Object { $_.name -match '64-bit\.exe$' } | Select-Object -First 1
Dl $a.browser_download_url (Join-Path $apps 'git-setup.exe')

Write-Host "[vendor] Node.js LTS..."
# Мажор закреплён: «первая LTS из index.json» 28.10.2026 молча стала бы v26, и сборка
# сменила бы мажор Node без единой правки в репозитории. Бамп — HM_NODE_MAJOR или здесь.
$nodeMajor = if ($env:HM_NODE_MAJOR) { $env:HM_NODE_MAJOR } else { '24' }
$idx = Invoke-RestMethod "https://nodejs.org/dist/index.json"
$lts = $idx | Where-Object { $_.lts -and $_.version -like "v$nodeMajor.*" } | Select-Object -First 1
if (-not $lts) { throw "нет LTS-выпуска Node v$nodeMajor в index.json" }
Write-Host "  версия: $($lts.version)"
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

Write-Host "[vendor] Handy (голосовой ввод, MIT) — NSIS per-user, ставится без админа..."
# Берём ИМЕННО NSIS (-setup.exe), а не MSI: MSI у Tauri собирается perMachine
# (Program Files) и требует администратора, NSIS — currentUser в %LOCALAPPDATA%.
# Ассет арх-специфичный; нам нужен x64 (установщик — x64-приложение).
try {
  $hrel = Invoke-RestMethod "https://api.github.com/repos/cjpais/Handy/releases/latest" -Headers $UA
  $ha = $hrel.assets | Where-Object { $_.name -match '_x64-setup\.exe$' } | Select-Object -First 1
  if ($ha) {
    Write-Host "  версия: $($hrel.tag_name) — $($ha.name)"
    Dl $ha.browser_download_url (Join-Path $apps 'handy-setup.exe')
  } else {
    Write-Host "  ! в релизе Handy нет x64-setup.exe — компонент будет пропущен при установке"
  }
} catch {
  Write-Host "  ! GitHub API недоступен для Handy: $($_.Exception.Message)"
}

Write-Host "[vendor] Python (под версию сборочной машины — чтобы wheels совпали)..."
# HM_PY_VERSION задаёт раздаваемый патч явно (колёса cp3XX совпадают у всех патчей одного
# минора, поэтому минор обязан совпасть с Python сборочной машины). Без неё пользователи
# получали ровно ту версию, что случайно стояла на машине сборки.
$pyver = if ($env:HM_PY_VERSION) { $env:HM_PY_VERSION } else { (& python -c "import platform;print(platform.python_version())" 2>$null) }
if (-not $pyver) { $pyver = '3.12.10' }
$localMinor = (& python -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null)
if ($env:HM_PY_VERSION -and $localMinor -and -not "$pyver".StartsWith("$localMinor.")) {
  throw "HM_PY_VERSION=$pyver не совпадает по минору с Python сборки ($localMinor): колёса pywheels не подойдут"
}
$pyver = "$pyver".Trim()
$pyInstaller = Join-Path $apps 'python-setup.exe'
if (Test-Path $pyInstaller) { Remove-Item $pyInstaller -Force -ErrorAction SilentlyContinue }
Write-Host "  версия: $pyver"
Dl "https://www.python.org/ftp/python/$pyver/python-$pyver-amd64.exe" $pyInstaller

Write-Host "[vendor] Claude Code CLI -> npm cache (для офлайн -g установки)..."
$cache = Join-Path $root 'vendor\npm-cache'
$tmp   = Join-Path $root 'vendor\_claudetmp'
New-Item -ItemType Directory -Force $tmp | Out-Null
# Код возврата npm проверяем: вывод здесь заглушён Out-Null, и провал (обрыв сети,
# недоступный реестр) не оставлял вообще НИКАКОГО следа — а гейт полноты ниже считал
# npm-cache заполненным, если в нём лежал хоть один файл от прошлых прогонов. Тогда
# офлайн-установка Claude Code падала уже у покупателя.
# --ignore-scripts: цель шага — наполнить КЕШ архивами, а не запустить пакет. Скрипты установки
# (postinstall у claude-code и у любой зависимости) исполнялись бы на машине, где живёт сессия
# подписи Certum и боевые ключи S3, — а версия при этом «плавающая» (latest на момент сборки).
# Проверено офлайн на копии vendor/npm-cache (09.10.2026): содержимое _cacache — набор архивов и
# их integrity — с флагом и без него побайтно одинаково; единственное отличие — postinstall
# claude-code кладёт нативный бинарь поверх заглушки bin/claude.exe в УЖЕ удаляемой папке $tmp,
# и никто этот файл не читает.
& npm install '@anthropic-ai/claude-code' --prefix $tmp --cache $cache --no-audit --no-fund --ignore-scripts 2>&1 | Out-Null
$npmCacheOk = ($LASTEXITCODE -eq 0)
if (-not $npmCacheOk) { Write-Host "  ! npm install завершился с кодом $LASTEXITCODE — npm-кеш НЕПОЛНЫЙ (гейт полноты ниже это назовёт)" }
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

# ЧИСТКА КЕША — ОБЯЗАТЕЛЬНЫЙ ШАГ, А НЕ ГИГИЕНА.
# `npm install --cache` ДОБАВЛЯЕТ версии в кеш и НИКОГДА не удаляет старые. Каждый
# релиз Claude Code оставляет предыдущий архив (~80 МиБ) навсегда. К 11.08.2026 так
# накопилось 13 версий = 1005 МиБ вместо 84 МиБ, и прогноз portable-exe ушёл на 112%
# от потолка 32-битного makensis — офлайн-сборка Windows перестала собираться (падение
# на mmap посреди упаковки, без внятной ошибки). Без этого шага то же вернётся через
# 5-6 релизов. Прунер оставляет ровно ту версию, которую резолвит `npm install
# --offline` (dist-tags.latest закешированного packument'а) + её платформенные пакеты
# по optionalDependencies, и отказывается чистить, если кеш уже противоречив.
Write-Host "[vendor] Чистка npm-кеша от устаревших версий..."
& node (Join-Path $PSScriptRoot 'prune-npm-cache.js') --cache $cache
if ($LASTEXITCODE -ne 0) {
  Write-Host "  ! чистка кеша ОТКАЗАЛА (кеш не тронут) — разбери причину выше; размер vendor проверит npm run preflight"
}

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
  # (платформо-гейт ниже проверит манифест; чужая/generic НЕ вшивается). Всё non-fatal: Codex опционален.
  try {
    $cxUrl = $null
    try {
      $cxMeta = Invoke-RestMethod 'https://open-vsx.org/api/openai/chatgpt/win32-x64/latest' -Headers $UA -MaximumRedirection 6
      $cxUrl = $cxMeta.files.download
    } catch { }
    if (-not $cxUrl) {
      $cxMeta = Invoke-RestMethod 'https://open-vsx.org/api/openai/chatgpt/latest' -Headers $UA -MaximumRedirection 6
      $cxUrl = $cxMeta.files.download
      if ($cxUrl) { Write-Host "  win32-x64-цель не найдена — беру generic (платформо-гейт ниже решит, вшивать ли)" }
    }
    if ($cxUrl) { Dl $cxUrl $cxvsix }
    else { Write-Host "  ! Open VSX не отдал ссылку на .vsix — Codex поставится онлайн при установке" }
  } catch { Write-Host "  ! Open VSX недоступен ($($_.Exception.Message)) — Codex поставится онлайн при установке" }
}
if (Test-Path $cxvsix) {
  # Платформо-гейт (build-honesty): generic /latest часто отдаёт чужую платформу
  # (linux/alpine) — офлайн 'code --install-extension' падает по platform mismatch и
  # роняет ВЕСЬ компонент VS Code. Читаем extension.vsixmanifest (vsix = zip) и вшиваем
  # ТОЛЬКО при TargetPlatform="win32-x64"; чужая/generic (атрибута нет) или битый zip →
  # удаляем файл (в checksums.json ниже он тогда не попадёт) — Codex поставится онлайн.
  $cxOk = $false
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $za = [IO.Compression.ZipFile]::OpenRead($cxvsix)
    try {
      $entry = $za.Entries | Where-Object { $_.FullName -eq 'extension.vsixmanifest' } | Select-Object -First 1
      if ($entry) {
        $sr = New-Object IO.StreamReader($entry.Open())
        try { $cxManifest = $sr.ReadToEnd() } finally { $sr.Dispose() }
        if ($cxManifest -match 'TargetPlatform\s*=\s*["'']win32-x64["'']') { $cxOk = $true }
      }
    } finally { $za.Dispose() }
  } catch { }
  if ($cxOk) {
    Write-Host "  ok chatgpt.vsix (TargetPlatform=win32-x64)"
  } else {
    Remove-Item $cxvsix -Force -ErrorAction SilentlyContinue
    Write-Host "  ! chatgpt.vsix не под win32-x64 (generic/чужая платформа или битый zip) — НЕ вшиваю, Codex поставится онлайн при установке"
  }
}

Write-Host "[vendor] Русский языковой пакет VS Code (MS-CEINTL.vscode-language-pack-ru, офлайн)..."
# Интерфейс VS Code на английском — повторяющаяся беда новичков. Пакет ставит vscode.ps1
# (необязательно), а vscode-settings.ps1 включает "locale":"ru", только когда пакет на диске.
#
# ПОЧЕМУ ВЫБОР ИДЁТ ПО engines.vscode, А НЕ ПО «ВЕРСИЯ ПАКЕТА НАЧИНАЕТСЯ С 1.<минор редактора>.».
# Прежняя редакция брала из Marketplace только пакет вида 1.<минор вшитого VS Code>.*.
# Но VS Code выше качается как «последний stable», а пакеты отстают от него: 09.10.2026
# вшитый редактор был 1.140, новейший пакет на Marketplace — 1.131 (от 04.09). Совпадения не
# было, фетчер печатал «не вшиваю», vendor объявлялся неполным (offlineEdition=false), а
# release-check и publish-vendor.py отказывались собирать архив vscode — релиз вставал из-за
# файла, который нужен только ради русских подписей в меню.
#
# engines.vscode пакета — НИЖНЯЯ граница (`^1.131.0` = редактор не старше 1.131.0): VS Code
# ставит любой пакет, чей движок не новее самого редактора. Поэтому нужен НОВЕЙШИЙ пакет, у
# которого движок <= вшитому редактору, а не пакет «ровно под наш минор».
#
# Версии и их engines.vscode Marketplace отдаёт, если попросить свойства версий (флаг 0x10)
# вместе со списком версий (0x1); 0x20 — только прошедшие проверку. Если свойств в ответе нет
# вовсе (API перестал их отдавать) — запасной путь: качаем кандидатов от новых к старым и
# читаем extension.vsixmanifest; гейт честности ниже остаётся последним словом в обоих путях.

# engines.vscode -> { Caret; Version = @(мажор, минор, патч) } либо $null. Принимаются только
# `^X.Y.Z` и `>=X.Y.Z`: это нижние границы. `~1.131.0`, голое `1.131.0`, `*` и мусор нижней
# границей не являются — по ним нельзя утверждать, что редактор новее, поэтому $null.
function ConvertFrom-HmVsEngine {
    param([string]$Engine)
    if ($Engine -match '^\s*(\^|>=)\s*(\d{1,9})\.(\d{1,9})\.(\d{1,15})(-[0-9A-Za-z.+-]*)?\s*$') {
        return [pscustomobject]@{ Caret = ($Matches[1] -eq '^'); Version = [long[]]@([long]$Matches[2], [long]$Matches[3], [long]$Matches[4]) }
    }
    return $null
}

# Подходит ли редактор @(мажор, минор, патч) под engines.vscode пакета. Сравнение полной
# тройки: `^1.140.1` не встанет на редактор 1.140.0, а `^1.131.0` встанет на любой 1.14x.
# Каретка держит мажор (`^2.0.0` на редакторе 1.x не встанет), `>=` его не держит.
function Test-HmVsEngineFits {
    param([string]$Engine, [long[]]$Editor)
    $req = ConvertFrom-HmVsEngine $Engine
    if ($null -eq $req) { return $false }
    if ($req.Caret -and ($req.Version[0] -ne $Editor[0])) { return $false }
    for ($i = 0; $i -lt 3; $i++) {
        if ($req.Version[$i] -lt $Editor[$i]) { return $true }
        if ($req.Version[$i] -gt $Editor[$i]) { return $false }
    }
    return $true
}

# Ответ extensionquery -> список версий пакета: Version, Key (тройка чисел), Engine, PreRelease.
# Версия вида 1.131.2026090407: хвост — дата со временем, поэтому сравнивать надо ЧИСЛОМ
# (как строку `1.131.999` оказалась бы «больше»). Кривые версии пропускаются. Порядок в
# ответе не обещан, и на него ничего не опирается.
function Get-HmLanguagePackVersions {
    param($Response)
    $list = New-Object System.Collections.ArrayList
    $vers = @()
    try { $vers = @($Response.results[0].extensions[0].versions) } catch { }
    foreach ($v in $vers) {
        if ($null -eq $v) { continue }
        $ver = [string]$v.version
        if ($ver -notmatch '^(\d{1,9})\.(\d{1,9})\.(\d{1,15})$') { continue }
        $key = [long[]]@([long]$Matches[1], [long]$Matches[2], [long]$Matches[3])
        $engine = $null
        $pre = $false
        foreach ($p in @($v.properties)) {
            if ($null -eq $p) { continue }
            if ([string]$p.key -eq 'Microsoft.VisualStudio.Code.Engine') { $engine = [string]$p.value }
            elseif ([string]$p.key -eq 'Microsoft.VisualStudio.Code.PreRelease' -and [string]$p.value -eq 'true') { $pre = $true }
        }
        [void]$list.Add([pscustomobject]@{ Version = $ver; Key = $key; Engine = $engine; PreRelease = $pre })
    }
    return $list.ToArray()
}

# ШОВ ДЛЯ ТЕСТОВ: ответ Marketplace (разобранный) + минор (и патч) вшитого редактора ->
# версия пакета либо $null. Берётся наибольшая версия, чей движок не новее редактора;
# пре-релизы не берутся; версия без читаемого engines.vscode не выбирается (судить не по чему).
function Select-HmLanguagePackVersion {
    param($Response, [int]$EditorMinor, [int]$EditorPatch = 0)
    $editor = [long[]]@(1, $EditorMinor, $EditorPatch)
    $best = $null
    foreach ($c in @(Get-HmLanguagePackVersions $Response)) {
        if ($c.PreRelease) { continue }
        if (-not (Test-HmVsEngineFits $c.Engine $editor)) { continue }
        $newer = ($null -eq $best)
        if (-not $newer) {
            for ($i = 0; $i -lt 3; $i++) {
                if ($c.Key[$i] -ne $best.Key[$i]) { $newer = ($c.Key[$i] -gt $best.Key[$i]); break }
            }
        }
        if ($newer) { $best = $c }
    }
    if ($null -eq $best) { return $null }
    return $best.Version
}

# Запрос к публичному каталогу расширений (только чтение). Отдельной функцией — как шов для тестов.
function Get-HmMarketplaceQuery {
    param([string]$ExtensionId, [int]$Flags)
    $q = '{"filters":[{"criteria":[{"filterType":7,"value":"' + $ExtensionId + '"}]}],"flags":' + $Flags + '}'
    return Invoke-RestMethod 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.2-preview.1' -Method Post -Body $q -ContentType 'application/json' -Headers $UA -TimeoutSec 120
}

# Постобработка скачанного .vsix: снять gzip и пустить через гейт честности. Файл, не прошедший
# гейт, УДАЛЯЕТСЯ (в checksums.json он тогда не попадёт). $EditorMinor = -1 — редактор неизвестен:
# движок не сравниваем (id и издатель проверяются всегда). Возвращает $true, если файл оставлен.
function Confirm-HmLanguagePackVsix {
    param([string]$Path, [int]$EditorMinor, [int]$EditorPatch = 0)
    # Как у claude-code.vsix: Marketplace часто отдаёт vspackage в gzip, IWR в PS 5.1 его не снимает.
    try {
        $fs = [IO.File]::OpenRead($Path); $b0 = $fs.ReadByte(); $b1 = $fs.ReadByte(); $fs.Close()
        if ($b0 -eq 0x1f -and $b1 -eq 0x8b) {
            Write-Host "  ответ Marketplace в gzip — распаковываю в .vsix"
            $gzTmp = "$Path.gz.tmp"
            Move-Item $Path $gzTmp -Force
            $in  = [IO.File]::OpenRead($gzTmp)
            $gz  = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
            $out = [IO.File]::Create($Path)
            $gz.CopyTo($out)
            $out.Close(); $gz.Close(); $in.Close()
            Remove-Item $gzTmp -Force
        }
    } catch { Write-Host "  ! постобработка языкового пакета не удалась - $($_.Exception.Message)" }
    # Гейт честности (как у chatgpt.vsix): вшиваем ТОЛЬКО zip с манифестом именно этого пакета
    # и движком не новее вшитого редактора. Иначе файл удаляется и в checksums.json не попадает.
    # Тот же гейт — единственный судья на запасном пути, когда Marketplace не отдал engines.vscode.
    $lpOk = $false
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $za = [IO.Compression.ZipFile]::OpenRead($Path)
        try {
            $entry = $za.Entries | Where-Object { $_.FullName -eq 'extension.vsixmanifest' } | Select-Object -First 1
            if ($entry) {
                $sr = New-Object IO.StreamReader($entry.Open())
                try { $lpManifest = $sr.ReadToEnd() } finally { $sr.Dispose() }
                # Идентичность — из тега <Identity>, а не из любого `Id="..."` манифеста.
                $ident = ''
                if ($lpManifest -match '<Identity\b[^>]*>') { $ident = $Matches[0] }
                $idOk = ($ident -match '\bId\s*=\s*"vscode-language-pack-ru"') -and ($ident -match '\bPublisher\s*=\s*"MS-CEINTL"')
                # Движок обязан читаться: нет движка — нечем доказать совместимость (раньше молча пропускали).
                $engOk = $false
                if ($lpManifest -match 'Microsoft\.VisualStudio\.Code\.Engine"\s+Value\s*=\s*"([^"]*)"') {
                    $engOk = ($EditorMinor -lt 0) -or (Test-HmVsEngineFits $Matches[1] ([long[]]@(1, $EditorMinor, $EditorPatch)))
                }
                $lpOk = $idOk -and $engOk
            }
        } finally { $za.Dispose() }
    } catch { }
    if ($lpOk) {
        $forEditor = 'редактор не определён, движок не сравнивался'
        if ($EditorMinor -ge 0) { $forEditor = "под VS Code 1.$EditorMinor" }
        Write-Host "  ok vscode-language-pack-ru.vsix (MS-CEINTL, $forEditor)"
        return $true
    }
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
    Write-Host "  ! vscode-language-pack-ru.vsix не тот пакет, битый zip или движок новее вшитого VS Code — НЕ вшиваю, поставится онлайн при установке"
    return $false
}

# Весь блок: версия редактора -> запрос -> выбор -> загрузка -> гейт. $EditorVersion можно
# задать явно (тесты и ручной прогон); по умолчанию берётся из вшитого vscode-setup.exe.
function Invoke-HmLanguagePackFetch {
    param([string]$Apps, [string]$EditorVersion = '')
    $lpvsix = Join-Path $Apps 'vscode-language-pack-ru.vsix'
    $vsMinor = $null
    $vsPatch = 0
    if ($EditorVersion -eq '') {
        try { $EditorVersion = [string](Get-Item -LiteralPath (Join-Path $Apps 'vscode-setup.exe') -ErrorAction Stop).VersionInfo.ProductVersion } catch { }
    }
    if ($EditorVersion -match '^1\.(\d+)(?:\.(\d+))?') {
        $vsMinor = [int]$Matches[1]
        if ($Matches[2]) { $vsPatch = [int]$Matches[2] }
    }
    $base = 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/MS-CEINTL/vsextensions/vscode-language-pack-ru/'
    if (Test-Path -LiteralPath $lpvsix) {
        Write-Host "  skip vscode-language-pack-ru.vsix"
        $eMin = -1
        if ($null -ne $vsMinor) { $eMin = $vsMinor }
        [void](Confirm-HmLanguagePackVsix -Path $lpvsix -EditorMinor $eMin -EditorPatch $vsPatch)
        return
    }
    if ($null -eq $vsMinor) {
        Write-Host "  ! версия вшитого VS Code не определена — языковой пакет не вшиваю (подобрать совместимый не по чему)"
        return
    }
    $resp = $null
    try { $resp = Get-HmMarketplaceQuery 'MS-CEINTL.vscode-language-pack-ru' 49 }
    catch { Write-Host "  ! Marketplace не ответил ($($_.Exception.Message))" }
    $lpVer = Select-HmLanguagePackVersion -Response $resp -EditorMinor $vsMinor -EditorPatch $vsPatch
    if ($lpVer) {
        Write-Host "  выбран пакет $lpVer (его движок не новее VS Code 1.$vsMinor.$vsPatch)"
        Dl ($base + $lpVer + '/vspackage') $lpvsix
        if (Test-Path -LiteralPath $lpvsix) { [void](Confirm-HmLanguagePackVsix -Path $lpvsix -EditorMinor $vsMinor -EditorPatch $vsPatch) }
        else { Write-Host "  ! пакет $lpVer не скачался — не вшиваю (поставится онлайн при установке)" }
        return
    }
    # Запасной путь — ТОЛЬКО когда свойств версий в ответе нет вовсе (если они есть и ни одна не
    # подошла, подходящего пакета не существует, и качать нечего).
    $all = @(Get-HmLanguagePackVersions $resp)
    $withEngine = @($all | Where-Object { $null -ne $_.Engine })
    if ($all.Count -gt 0 -and $withEngine.Count -eq 0) {
        Write-Host "  Marketplace не отдал engines.vscode версий — качаю кандидатов от новых к старым и читаю манифест"
        # Минор версии пакета совпадает с минором его движка или больше на единицу (так у всех
        # 437 версий на 09.10.2026), поэтому заведомо более новые кандидаты не качаем.
        $cands = @($all | Where-Object { -not $_.PreRelease -and $_.Key[1] -le ($vsMinor + 1) } |
                   Sort-Object { $_.Key[0] }, { $_.Key[1] }, { $_.Key[2] } -Descending)
        $tried = 0
        foreach ($c in $cands) {
            if ($tried -ge 6) { break }
            $tried++
            Dl ($base + $c.Version + '/vspackage') $lpvsix
            if (-not (Test-Path -LiteralPath $lpvsix)) { continue }
            if (Confirm-HmLanguagePackVsix -Path $lpvsix -EditorMinor $vsMinor -EditorPatch $vsPatch) { return }
        }
    }
    Write-Host "  ! Marketplace не отдал пакет, совместимый с VS Code 1.$vsMinor.$vsPatch (движок не новее редактора) — не вшиваю (поставится онлайн при установке)"
}

Invoke-HmLanguagePackFetch -Apps $apps

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
      # Подпись издателя — ДО публикации stage: подменённый архив не должен доехать даже до apps\uv.
      # Провал = exit 1 (stage убирается), так что дальше сюда управление не вернётся.
      if ($uvOk) {
        foreach ($n in @('uv.exe', 'uvx.exe')) { Assert-HmVendorFile -Path (Join-Path $uvStage $n) -CleanupDir $uvStage }
      }
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

# ТОЛЬКО КОЛЁСА (находка S-6). `pip download` обычного sdist ИСПОЛНЯЕТ его setup.py (иначе
# не узнать зависимости), а эта машина держит сессию подписи Certum и боевые ключи S3: пакет,
# подменённый в индексе, получил бы и то и другое. Поэтому везде --only-binary=:all: — пакет без
# колеса теперь роняет шаг громко, а не собирается молча у владельца ключей.
#
# Единственное исключение — pyaes (зависимость telethon, на PyPI только sdist), и оно не
# «разрешить sdist», а закрепление: отдельным вызовом с --require-hashes (pip сверяет sha256
# ДО распаковки и сборки метаданных — подменённый архив не исполнится вовсе), а в общем вызове
# pyaes идёт прямой ссылкой file:///...#sha256=..., так что индекс про него не спрашивают
# (иначе при равной версии ничья между локальным файлом и индексом решалась бы порядком
# поиска, а не нашим пином). Пин лежит в tools\vendor-signers.json (pythonSdists).
#
# Что этим закрыто и что НЕТ (формулировка «на машине подписи не исполняется чужой код» была бы
# завышена). Закрыто: setup.py подменённого pyaes и любого пакета без колеса (pip отказывает по
# sha256 / по --only-binary до сборки), скрипты установки npm-пакета. Остаётся: pip собирает метаданные
# sdist pyaes в изолированном окружении и ставит туда сборочный бэкенд (setuptools) из PyPI БЕЗ хеша —
# исполняется его код; поэтому `--no-binary` стоит только на pyaes (с `:all:` бэкенд собирался бы ещё и
# из sdist). Плюс playwright и его драйвер ставятся из PyPI колёсами без хеша, версия claude-code плавает
# (скрипты не исполняются, архивы берутся из реестра npm). Доверие остаётся к PyPI/npm и TLS до них.
#
# Код возврата pip проверяем ПОСЛЕ КАЖДОЙ команды. Скачиваний три: базовые
# pip/setuptools/wheel, pyaes и весь requirements.txt. Раньше не смотрели ни на одно, а гейт
# полноты ниже считал каталог заполненным по признаку «есть хоть один файл» — то есть
# трёх базовых колёс от ПЕРВОЙ команды хватало, чтобы провал ВТОРОЙ (обрыв сети, пакет
# без колеса под эту платформу) прошёл незамеченным. Сборка уезжала с неполным набором
# зависимостей, а установка у покупателя падала уже на его машине, где чинить нечем.
# $LASTEXITCODE переживает конвейер с Select-Object (проверено запуском) — в отличие от
# bash-пайпа, который отдал бы код последней команды в цепочке.
function Get-HmPyWheels {
  param([string]$Py, [string]$Req, [string]$Wheels, $Pyaes)
  # stderr нативной команды под Stop рушит скрипт (см. шапку файла): режим держим сами, а не по вызывающему.
  $ErrorActionPreference = 'Continue'
  $ok = $true
  & $Py -m pip download pip setuptools wheel --only-binary=:all: -d $Wheels 2>&1 | Select-Object -Last 1 | Out-Host
  if ($LASTEXITCODE -ne 0) { $ok = $false; Write-Host "  ! pip download (pip/setuptools/wheel) завершился с кодом $LASTEXITCODE" }
  $pyaesFile = Join-Path $Wheels ('pyaes-' + $Pyaes.version + '.tar.gz')
  $pin = Join-Path ([IO.Path]::GetTempPath()) ('hm-pyaes-pin-' + [guid]::NewGuid().ToString('N') + '.txt')
  $pyaesOk = $false
  try {
    [IO.File]::WriteAllText($pin, ('pyaes==' + $Pyaes.version + ' --hash=sha256:' + $Pyaes.sha256 + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    & $Py -m pip download --no-deps --no-binary pyaes --require-hashes -r $pin -d $Wheels 2>&1 | Select-Object -Last 3 | Out-Host
    $pyaesRc = $LASTEXITCODE
    $pyaesOk = ($pyaesRc -eq 0)
    if (-not $pyaesOk) { Write-Host "  ! pip download (pyaes с пином sha256) завершился с кодом $pyaesRc — архив не принят, остальные пакеты не качаю" }
  } finally { Remove-Item -LiteralPath $pin -Force -ErrorAction SilentlyContinue }
  if (-not $pyaesOk) { return $false }
  $pyaesU = New-Object System.Uri $pyaesFile
  if ($pyaesU.LocalPath -ne $pyaesFile) {
    Write-Host "  ! путь к pyaes не выражается ссылкой file:/// без искажений ($pyaesFile) — перенеси репозиторий в каталог без символов # и %"
    return $false
  }
  $pyaesUri = $pyaesU.AbsoluteUri + '#sha256=' + $Pyaes.sha256
  & $Py -m pip download -r $Req pystray pillow ('pyaes @ ' + $pyaesUri) --only-binary=:all: -d $Wheels 2>&1 | Select-Object -Last 3 | Out-Host
  if ($LASTEXITCODE -ne 0) { $ok = $false; Write-Host "  ! pip download (requirements.txt + pystray/pillow) завершился с кодом $LASTEXITCODE" }
  # Результат — по файлу, а не по тексту pip: в pywheels лежит ровно тот pyaes, что закреплён.
  $got = ''
  if (Test-Path -LiteralPath $pyaesFile) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::OpenRead($pyaesFile)
    try { $got = ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLower() } finally { $fs.Dispose(); $sha.Dispose() }
  }
  if ($got -ne $Pyaes.sha256) {
    $ok = $false
    Remove-Item -LiteralPath $pyaesFile -Force -ErrorAction SilentlyContinue
    Write-Host "  ! pyaes в pywheels не совпал с пином sha256 (или не скачан) — архив удалён, набор НЕПОЛНЫЙ"
  }
  return $ok
}

$wheelsOk = $true
if ($py -and (Test-Path $req)) {
  $wheelsOk = Get-HmPyWheels -Py $py -Req $req -Wheels $wheels -Pyaes $HmSigners.pythonSdists.pyaes
  Write-Host "  wheels/sdists: $((Get-ChildItem $wheels -File).Count) шт."
} else { $wheelsOk = $false; Write-Host "  (python/requirements не найдены, пропускаю wheels)" }

Write-Host "[vendor] Playwright Chromium (best-effort)..."
$pw = Join-Path $root 'vendor\playwright-browsers'
New-Item -ItemType Directory -Force $pw | Out-Null
if ($py) {
  try {
    & $py -m pip install --quiet --only-binary=:all: playwright 2>&1 | Out-Null
    $env:PLAYWRIGHT_BROWSERS_PATH = $pw
    & $py -m playwright install chromium 2>&1 | Select-Object -Last 2
    # Drop chromium_headless_shell (~254 MB) to stay under the NSIS 2 GiB limit.
    #
    # ВНИМАНИЕ, прежняя формулировка «redundant with the full chromium (which also
    # runs headless)» НЕВЕРНА: начиная с Playwright 1.49 `chromium.launch()` в
    # headless-режиме запускает именно chrome-headless-shell.exe, а не chrome.exe.
    # Без этой папки ВЕСЬ headless-рендер пака (cards-creator, export-png/pdf/pptx,
    # kp-deck-factory, manus-slides, screenshot-test, a11y-audit) падает с
    # «Executable doesn't exist at ...chromium_headless_shell-XXXX».
    # Плюс ревизия прибита к версии колеса (playwright 1.62 -> chromium-1234), а
    # здесь могла остаться старая. Поэтому scripts/*/pydeps.* ПОСЛЕ офлайн-копии
    # всегда делает `playwright install chromium`: совпало — мгновенный no-op,
    # не совпало — докачивает недостающее. Если вернёшь shell в вендор, офлайн-
    # установка станет полностью автономной и докачка станет no-op.
    #
    # Windows `portable` target embeds the whole payload as ONE .7z,
    # and 32-bit makensis can't mmap a >2 GiB archive — keeping the shell pushes
    # the exe over that hard limit (build aborts with "failed creating mmap").
    # Removing it keeps the offline installer under 2 GiB. Nothing offline uses
    # browser-headless (the repo's «headless» is the tray-less bridge agent).
    Get-ChildItem -Path $pw -Directory -Filter 'chromium_headless_shell-*' -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-Item -Recurse -Force $_.FullName; Write-Host "  срезан $($_.Name) (254M, дубль под 2 GiB-лимит NSIS)" }
  } catch { Write-Host "  (playwright browsers пропущены: $($_.Exception.Message))" }
}

Write-Host "[vendor] Скрепка Claude (маскот, локальная Windows-сборка)..."
# Путь к локальной сборке скрепки. РЕПОЗИТОРИЙ ПУБЛИЧНЫЙ, поэтому имени пользователя
# здесь быть не должно: раньше стояло 'C:\Users\<имя>\claude-mascot\...' — это и
# деанонимизация владельца, и неработающая сборка у любого другого человека.
# $env:USERPROFILE раскрывается у каждого в своё, а HM_MASCOT_SRC позволяет держать
# исходник где угодно, не трогая скрипт.
$mascotSrc = if ($env:HM_MASCOT_SRC) { $env:HM_MASCOT_SRC }
             else { Join-Path $env:USERPROFILE 'claude-mascot\src-tauri\target\release\claude-mascot.exe' }
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
# Юридическое имя из сертификата Apple и Team ID добавлены после того, как ученик
# увидел это имя у себя. Один поимённо удаляемый файл (см. 1b) проблему не закрывает:
# то же имя приезжает в любой новый документ про подпись или в лог сборки.
# Паттерны деанона/секретов для экспорт-фильтра. РЕПОЗИТОРИЙ ПУБЛИЧНЫЙ (находка S-3), поэтому здесь
# лежат только ОБЩИЕ паттерны — ключи и токены. Личные (имя владельца, его адреса и домены)
# раньше стояли прямо в этой строке, то есть сам фильтр публиковал то, что должен был не пропустить.
# Теперь они читаются из НЕОТСЛЕЖИВАЕМОГО файла tools\leak-patterns.local.json (он в .gitignore)
# либо из переменной окружения HM_LEAK_PATTERNS (тот же JSON целиком — под секрет CI). Формат:
#   { "patterns": [ { "re": "<regex, годный и для .NET, и для POSIX ERE>", "scrub": "<чем заменить>" }, ... ] }
# scrub необязателен: он разрешает в install-critical файле ЗАМЕНИТЬ совпадение этой строкой (так
# поступают с адресами и доменами); без него совпадение в таком файле — FATAL.
# Нет личного списка:
#   - локально — фильтр работает по общим паттернам и громко об этом говорит (личный файл лежит на машине
#     владельца; свежий рабочий каталог его не получает — это предупреждение, а не отказ);
#   - в РЕЛИЗНОЙ сборке (CI=true / GITHUB_ACTIONS=true / HM_RELEASE=1) — стоп: фильтр, «предупредивший» и
#     пропустивший имя владельца в раздаваемый exe, хуже отсутствующего фильтра. Осознанный обход — переменная
#     HM_ALLOW_NO_PRIVATE_LEAK_LIST=1 (баннер в журнале). Как CI получает список — см. спеку «Обслуживание vendor».
# Список есть, но битый или пустой — стоп: тихо потерять защиту хуже, чем остановиться.
# Team ID Apple остаётся в общей части: он виден в любом подписанном бинаре и уже стоит в
# отслеживаемых файлах (пин скрепки), прятать его здесь нечего.
$HM_LEAK_GENERIC_RE = '3VN93XA9DY|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{36}|sk-[A-Za-z0-9_-]{40}|xoxb-[0-9]{8}'

# Общие + личные паттерны -> { Patterns = @(общий, личные…); Scrubs = @({Re; With}); Private; Count; Source }.
# Паттерны отдаются МАССИВОМ, а не склеиваются в один regex через `|`: Select-String компилирует каждый
# элемент отдельно, поэтому встроенные параметры ((?-i), (?s)) и номера групп одного паттерна не
# перетекают в соседей (склеенное `(?-i)Aaa|SECRET` делало второй регистрозависимым, а `(zq)|(ab)\1`
# ссылалось на чужую группу — личный паттерн молча переставал ловить).
# Битый JSON, пустой список, пустой или не компилируемый паттерн, паттерн, совпадающий с пустой строкой
# (он выбил бы из экспорта ВСЕ файлы), перевод строки/табуляция в значении (ломает bash-версию) — исключение.
# Пустой список — тоже ошибка: пустое значение HM_LEAK_PATTERNS иначе заслоняло бы настоящий файл и
# гасило предупреждение «личный список не найден», не добавляя ни одного паттерна.
# Значения паттернов в текст ошибки не попадают: журнал сборки не должен их повторять.
function Get-HmLeakPatterns {
  param([string]$LocalFile = '', [string]$EnvJson = '', [Parameter(Mandatory = $true)][string]$GenericRe)
  $json = $null
  $source = ''
  if ($EnvJson -and $EnvJson.Trim()) { $json = $EnvJson; $source = 'переменная HM_LEAK_PATTERNS' }
  elseif ($LocalFile -and (Test-Path -LiteralPath $LocalFile)) {
    $json = [IO.File]::ReadAllText($LocalFile, [System.Text.Encoding]::UTF8)
    $source = [IO.Path]::GetFileName($LocalFile)
  }
  $patterns = New-Object System.Collections.ArrayList
  [void]$patterns.Add($GenericRe)
  $scrubs = New-Object System.Collections.ArrayList
  $count = 0
  if ($null -ne $json) {
    $obj = $null
    try { $obj = $json | ConvertFrom-Json } catch { throw 'JSON не разбирается' }
    if ($null -eq $obj -or $null -eq $obj.patterns) { throw 'в JSON нет массива patterns' }
    foreach ($p in @($obj.patterns)) {
      $count++
      $re = [string]$p.re
      if (-not $re.Trim()) { throw ("паттерн №$count пуст") }
      if ($re -match '[\r\n\t]') { throw ("в паттерне №$count перевод строки или табуляция") }
      $rx = $null
      try { $rx = New-Object System.Text.RegularExpressions.Regex($re) } catch { throw ("паттерн №$count не компилируется") }
      if ($rx.IsMatch('')) { throw ("паттерн №$count совпадает с пустой строкой") }
      [void]$patterns.Add($re)
      $with = ''
      if ($null -ne $p.scrub) { $with = [string]$p.scrub }
      if ($with -match '[\r\n\t]') { throw ("в scrub паттерна №$count перевод строки или табуляция") }
      if ($with -ne '') { [void]$scrubs.Add([pscustomobject]@{ Re = $re; With = $with }) }
    }
    if ($count -eq 0) { throw 'в списке нет ни одного паттерна' }
  }
  return [pscustomobject]@{ Patterns = $patterns.ToArray(); Scrubs = $scrubs.ToArray(); Private = ($null -ne $json); Count = $count; Source = $source }
}

# Релизная ли сборка: CI / GITHUB_ACTIONS = true|1|yes либо явный HM_RELEASE = 1|true|yes (без учёта регистра).
# Значения приходят параметрами, а не читаются здесь, — чтобы решение проверялось таблицей.
function Test-HmReleaseBuild {
  param([string]$Ci = '', [string]$GithubActions = '', [string]$Release = '')
  foreach ($v in @($Ci, $GithubActions, $Release)) {
    if ($v -and ($v.Trim() -match '^(?i:true|1|yes)$')) { return $true }
  }
  return $false
}

# Что делать с отсутствующим личным списком: 'ok' (список есть) | 'warn' (локальная сборка: предупредить) |
# 'fatal' (релизная сборка без списка) | 'allowed' (релизная, но явно разрешено HM_ALLOW_NO_PRIVATE_LEAK_LIST).
# Флаг «разрешить» действует ТОЛЬКО в релизной сборке: локально он ничего не меняет — там и так предупреждение.
function Get-HmLeakListVerdict {
  param([bool]$Private, [bool]$Release, [string]$Allow = '')
  if ($Private) { return 'ok' }
  if (-not $Release) { return 'warn' }
  if ($Allow -and ($Allow.Trim() -match '^(?i:true|1|yes)$')) { return 'allowed' }
  return 'fatal'
}

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
  # Относительные пути ниже режутся по длине $Src. Windows PowerShell 5.1 раскрывает короткие имена 8.3 в FullName потомков
  # (C:\Users\RUNNER~1 -> C:\Users\runneradmin), а переданную строку оставляет как есть: корень берём тем же способом.
  try { $Src = (Get-Item -LiteralPath $Src -ErrorAction Stop).FullName.TrimEnd('\') } catch { }
  Write-Host "  [nomad-src] экспорт-фильтр: внутренние артефакты НЕ едут пользователям..."
  # Паттерны: общие (в репозитории) + личные (неотслеживаемый файл / HM_LEAK_PATTERNS) — см. Get-HmLeakPatterns.
  # HM_LEAK_PATTERNS_FILE — явный путь к списку (другой рабочий каталог, общий файл на несколько сборок);
  # заданный, но несуществующий путь — стоп: тихо работать без списка по явной просьбе было бы враньём.
  $leakFile = $env:HM_LEAK_PATTERNS_FILE
  if ($leakFile -and -not (Test-Path -LiteralPath $leakFile)) {
    Write-Host "[vendor] FATAL: HM_LEAK_PATTERNS_FILE указывает на несуществующий файл — личный список паттернов не прочитать."
    return $false
  }
  if (-not $leakFile) { $leakFile = Join-Path $PSScriptRoot 'leak-patterns.local.json' }
  $leak = $null
  try { $leak = Get-HmLeakPatterns -LocalFile $leakFile -EnvJson $env:HM_LEAK_PATTERNS -GenericRe $HM_LEAK_GENERIC_RE }
  catch {
    Write-Host "[vendor] FATAL: список личных паттернов (tools\leak-patterns.local.json / HM_LEAK_PATTERNS) не годится: $($_.Exception.Message)"
    Write-Host "         Починить список или убрать его; молча работать без него фильтр не станет."
    return $false
  }
  # Нет личного списка: в релизной сборке (CI / GITHUB_ACTIONS / HM_RELEASE) это стоп, локально — предупреждение
  # (разбор — в шапке блока паттернов). Флаг HM_ALLOW_NO_PRIVATE_LEAK_LIST=1 разрешает релиз без списка осознанно.
  $release = Test-HmReleaseBuild -Ci $env:CI -GithubActions $env:GITHUB_ACTIONS -Release $env:HM_RELEASE
  $verdict = Get-HmLeakListVerdict -Private ([bool]$leak.Private) -Release ([bool]$release) -Allow $env:HM_ALLOW_NO_PRIVATE_LEAK_LIST
  if ($verdict -eq 'ok') {
    Write-Host "  [nomad-src] личных паттернов: $($leak.Count) (источник: $($leak.Source))"
  } elseif ($verdict -eq 'fatal') {
    Write-Host "[vendor] FATAL: релизная сборка (CI / GITHUB_ACTIONS / HM_RELEASE) без личного списка паттернов экспорт-фильтра nomad-src."
    Write-Host "         Без него имя владельца, его адреса и домены не ищутся, и сборка раздала бы их покупателям, оставшись зелёной."
    Write-Host "         Дай список: файл tools\leak-patterns.local.json (скопируй с машины владельца), путь в HM_LEAK_PATTERNS_FILE"
    Write-Host "         или JSON целиком в HM_LEAK_PATTERNS (в CI — секрет; лучше записать его файлом во временный каталог раннера)."
    Write-Host "         Осознанно без списка — HM_ALLOW_NO_PRIVATE_LEAK_LIST=1 (в журнале будет баннер)."
    return $false
  } elseif ($verdict -eq 'allowed') {
    Write-Host "  [nomad-src] !!! ВНИМАНИЕ: РЕЛИЗНАЯ СБОРКА БЕЗ ЛИЧНОГО СПИСКА ПАТТЕРНОВ (разрешено HM_ALLOW_NO_PRIVATE_LEAK_LIST) !!!"
    Write-Host "              Проверяются только общие ключи и токены; имя владельца, его адреса и домены в раздаваемый exe НЕ проверены."
  } else {
    Write-Host "  [nomad-src] ВНИМАНИЕ: личный список паттернов не найден (tools\leak-patterns.local.json или HM_LEAK_PATTERNS) —"
    Write-Host "              проверяются только общие ключи и токены. Имя владельца, его адреса и домены НЕ ловятся: релиз собирай на машине с локальным файлом."
  }
  $NOMAD_LEAK_PATTERNS = $leak.Patterns
  # 1) Внутренние директории целиком (отчёты процессов, планы/спеки, deploy-доки с IP).
  # docs целиком: каталог не нужен ни сборке, ни рантайму — его нет ни в MANIFEST.in, ни
  # в [tool.setuptools] (packages.find / package-data / data-files), и ни один .py дерева
  # его не читает (проверено обходом). Зато он вёз покупателю внутреннюю кухню: релизный
  # процесс подписи Windows, аудит сессий, планы фаз, RCA-разборы. Перечислять такие
  # файлы по одному бессмысленно — за 422 коммита список отстанет снова.
  foreach ($rel in @('.superpowers', '.plans', '.github', '.claude',
                     'docs',
                     'deploy', 'scripts\tests')) {
    $p = Join-Path $Src $rel
    if (Test-Path -LiteralPath $p) { Remove-Item -Recurse -Force -LiteralPath $p; Write-Host "    - удалил $($rel -replace '\\','/')/" }
  }
  # 1a) СТОРОЖ вместо одного лишь списка. Поимённый список отстаёт молча: он
  #     писался под структуру репозитория Nomad на тот день, а за 422 коммита
  #     там завелись .plans/, .github/, docs/nomad-upgrade-reports/ — и все они
  #     уехали покупателям, потому что в списке их не было. Ошибка не в том, что
  #     кто-то забыл дописать строку, а в том, что забывчивость ничем не ловилась.
  #
  #     Признак внутреннего каталога устойчивее имени: точка в начале (кроме
  #     тех, что нужны пакету) и слова reports/plans/specs в пути docs. Найденное
  #     по признаку удаляем и ПЕЧАТАЕМ — чтобы новый каталог был виден в логе
  #     сборки, а не растворился в тишине.
  $dotKeep = @('.python-version')
  Get-ChildItem -LiteralPath $Src -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith('.') -and ($dotKeep -notcontains $_.Name) } |
    ForEach-Object {
      Remove-Item -Recurse -Force -LiteralPath $_.FullName -ErrorAction SilentlyContinue
      Write-Host "    - удалил по признаку (точка в начале): $($_.Name)/"
    }
  #     Тот же сторож — по ФАЙЛАМ верхнего уровня. Прежняя редакция смотрела только
  #     каталоги (-Directory), и внутренние документы, лежащие файлами, проходили мимо:
  #     PHASE2_SAAS_PLAN.md содержал слово из списка признаков и всё равно уезжал.
  #     Проверка, которая ловит половину случаев, зелёная ровно так же, как настоящая.
  Get-ChildItem -LiteralPath $Src -Force -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '(?i)(_plan|plan_|_spec|spec_|internal|audit|backlog|^phase[0-9])' } |
    ForEach-Object {
      Remove-Item -Force -LiteralPath $_.FullName -ErrorAction SilentlyContinue
      Write-Host "    - удалил по признаку (внутренний документ): $($_.Name)"
    }
  # 1b) Поимённые внутренние документы, которые под глобы ниже не подпадают.
  #     MAC_SIGNING.md — руководство по подписи релиза: несёт юридическое имя владельца
  #     из сертификата Developer ID и Apple Team ID. Покупателю оно не нужно вовсе, а
  #     ехало каждому внутри exe. Именно это имя ученик и увидел у себя на машине.
  foreach ($rel in @('apps\desktop\MAC_SIGNING.md')) {
    $p = Join-Path $Src $rel
    if (Test-Path -LiteralPath $p) { Remove-Item -Force -LiteralPath $p; Write-Host "    - удалил $($rel -replace '\\','/')" }
  }
  # 2) Внутренние *report*-отчёты: top-level (PHASE1_*_REPORT.md), docs\, scripts\.
  #    Продуктовые файлы, матчащие глоб (agent/lsp/reporter.py, шаблоны skills/bug-report.md
  #    и т.п.), НЕ трогаем — они часть агента.
  $reportFiles = @(Get-ChildItem -LiteralPath $Src -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*report*' })
  foreach ($d in @('docs', 'scripts')) {
    $dp = Join-Path $Src $d
    if (Test-Path $dp) {
      $reportFiles += @(Get-ChildItem -LiteralPath $dp -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*report*' })
    }
  }
  foreach ($f in $reportFiles) {
    $rel = $f.FullName.Substring($Src.Length + 1) -replace '\\', '/'
    Remove-Item -Force -LiteralPath $f.FullName
    Write-Host "    - удалил $rel"
  }
  # 3) Файлы с деанон/секрет-паттернами: НЕ нужные установке — удаляем (с логом);
  #    install-critical — скрабим IP/домен (текстовая замена безопасна и в комментарии,
  #    и в строковом литерале). Токен-паттерн в критическом коде скрабить нельзя
  #    (меняет семантику) → останется до гейта ниже → FATAL.
  $removed = 0
  $matched = @(Get-ChildItem -LiteralPath $Src -File -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { Select-String -LiteralPath $_.FullName -Pattern $NOMAD_LEAK_PATTERNS -Quiet -ErrorAction SilentlyContinue })
  foreach ($f in $matched) {
    $rel = $f.FullName.Substring($Src.Length + 1) -replace '\\', '/'
    if (Test-NomadSrcCritical $rel) {
      $txt = [IO.File]::ReadAllText($f.FullName)
      foreach ($s in $leak.Scrubs) { $txt = [regex]::Replace($txt, $s.Re, $s.With.Replace('$', '$$'), [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) }
      [IO.File]::WriteAllText($f.FullName, $txt)
      Write-Host "    ~ скраб IP/домена в $rel (install-critical, файл сохранён)"
    } else {
      Remove-Item -Force -LiteralPath $f.FullName; $removed++
      Write-Host "    - удалил $rel (деанон/секрет-паттерн)"
    }
  }
  # 4) Жёсткий гейт: после чистки паттернов быть НЕ должно НИГДЕ. Сюда доходит только
  #    несводимое (токен в install-critical коде / непокрытый скраб) → FATAL со списком.
  $left = @(Get-ChildItem -LiteralPath $Src -File -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { Select-String -LiteralPath $_.FullName -Pattern $NOMAD_LEAK_PATTERNS -Quiet -ErrorAction SilentlyContinue })
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

# Детерминированный SHA-256 ДЕРЕВА каталога (nomad-src: pyproject.toml/любой .py мог быть
# подменён medium-малварью того же юзера до `uv tool install` под АДМИНОМ). Рецепт:
# относительные пути (сорт ORDINAL, locale-независимо) + per-file SHA-256 → хеш конкатенации.
# ОБЯЗАН совпадать между tools/fetch-vendor.ps1 (пишет манифест) и scripts/windows/_verify.ps1
# (верифицирует). Self-contained (не зависит от Get-HmFileSha256).
function Get-HmTreeSha256 {
    param([string]$Root)
    # Resolve-Path оставляет короткое написание 8.3 как есть, а FullName потомков Windows PowerShell 5.1 раскрывает: срез по длине корня
    # съезжал бы, и хеш дерева зависел от написания пути. Корень берём тем же способом, каким получены потомки.
    $root = (Get-Item -LiteralPath (Resolve-Path -LiteralPath $Root).Path).FullName
    $lines = New-Object System.Collections.Generic.List[string]
    $sha1 = [System.Security.Cryptography.SHA256]::Create()
    try {
        Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
            $rel = $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
            $fs = [IO.File]::OpenRead($_.FullName)
            try { $fh = $sha1.ComputeHash($fs) } finally { $fs.Dispose() }
            $lines.Add($rel + ':' + (([BitConverter]::ToString($fh) -replace '-', '').ToLower()))
        }
    } finally { $sha1.Dispose() }
    $arr = $lines.ToArray()
    [System.Array]::Sort($arr, [System.StringComparer]::Ordinal)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($arr -join "`n") + "`n")
    $sha2 = [System.Security.Cryptography.SHA256]::Create()
    try { $hb = $sha2.ComputeHash($bytes) } finally { $sha2.Dispose() }
    return ([BitConverter]::ToString($hb) -replace '-', '').ToLower()
}

Write-Host "[vendor] Исходник Nomad → vendor\nomad-src (git archive merged-кода, БЕЗ .git; vendor-only установка)..."
# Компонент Nomad объявлен? Друзьям не нужен доступ к репозиторию: код едет офлайн внутри
# установщика. nomad-src приватный, в git НЕ коммитится (.gitignore vendor/). Нет
# исходника → компонент Nomad у пользователя выполнит graceful skip (exit 120) — сборку НЕ валим.
$componentsRawN = Get-Content -Raw (Join-Path $root 'components.json') -ErrorAction SilentlyContinue
if ($componentsRawN -and $componentsRawN -match '"nomad"') {
  # Репозиторий переехал 30.09.2026 (C:\Vibecode\hamidun-agent -> D:\Nomad\hamidun-agent).
  # Старый путь оставлен вторым: без него на старой раскладке фетчер молча оставлял
  # прошлый vendor\nomad-src, и гейты проходили, сверяя старый манифест сам с собой.
  $agentRepo = if ($env:HM_NOMAD_AGENT_REPO) { $env:HM_NOMAD_AGENT_REPO }
               else { @('D:\Nomad\hamidun-agent', 'C:\Vibecode\hamidun-agent') | Where-Object { Test-Path (Join-Path $_ '.git') } | Select-Object -First 1 }
  if (-not $agentRepo) { $agentRepo = 'D:\Nomad\hamidun-agent' }
  # ПИН релизной версии агента: дефолт = стабильный тег, НЕ движущийся main (зеркало
  # fetch-vendor-mac.sh). Бамп = сменить тег здесь и в fetch-vendor-mac.sh, либо env HM_NOMAD_REF.
  # 05.09.2026: пин поднят с тега v2026.7.22 (0.17.0, 22 июля) на КОММИТ 0.18.1.
  #
  # Почему коммит, а не тег: у нашей линии свежих релизных тегов НЕТ. Теги
  # v2026.8.* в этом репозитории принадлежат АПСТРИМУ (NousResearch/hermes-agent,
  # там своя нумерация — на v2026.8.31 версия 0.21.0) и нашему main не предки.
  # Последний тег нашей линии — тот самый v2026.7.22, и с него набежало 422
  # коммита без единой релизной отметки. Пин на движущийся main взять нельзя:
  # сборка обязана быть воспроизводимой, а main правится ежедневно.
  $nomadRef  = if ($env:HM_NOMAD_REF)        { $env:HM_NOMAD_REF }        else { '5a73e548233d2f830e3f0d619509012394a02280' }
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
      #
      # Код возврата ПРОВЕРЯЕМ. Единственным признаком успеха было наличие
      # pyproject.toml (он лежит в корне и распаковывается одним из первых), поэтому
      # ошибка после первых файлов — кончилось место, битый архив, недоступный файл —
      # давала НЕПОЛНОЕ дерево, которое проходило дальше как готовое: хеш дерева
      # снимался с того, что распаковалось, и манифест целостности заверял огрызок.
      # Тот же класс, что обрубок скачивания: проверка сверяет артефакт сам с собой.
      & "$env:SystemRoot\System32\tar.exe" -x -f "$tmpTar" -C "$srcOut"
      $tarRc = $LASTEXITCODE
      Remove-Item $tmpTar -Force -ErrorAction SilentlyContinue
      if ($tarRc -ne 0) {
        Write-Host "[vendor] FATAL: распаковка nomad-src завершилась с кодом $tarRc — дерево неполное."
        Write-Host "         Собирать из него нельзя: манифест целостности заверил бы огрызок, а установка"
        Write-Host "         у покупателя упала бы на недостающем файле. Освободи место / повтори fetch:vendor."
        exit 1
      }
      # `uv tool install` не требует тестов, сайт-доков и опциональных скиллов —
      # снимаем их, чтобы вшитый .7z оставался под лимитом mmap 32-битного
      # makensis (~2GB, target=portable). Иначе крупный агент рушит NSIS-сборку.
      foreach ($drop in @('tests', 'website', 'optional-skills')) {
        $dp = Join-Path $srcOut $drop
        if (Test-Path $dp) { Remove-Item -Recurse -Force $dp -ErrorAction SilentlyContinue }
      }
      if (Test-Path (Join-Path $srcOut 'pyproject.toml')) {
        # Экспорт-фильтр + гейт: несводимые деанон/секрет-паттерны в раздаваемом exe → FATAL.
        if (-not (Invoke-NomadSrcSanitize $srcOut)) { exit 1 }
        # #2: детерминированный SHA-256 дерева nomad-src → манифест vendor\nomad-src.sha256
        # (nomad.ps1 сверяет его fail-closed перед `uv tool install`, зеркало mac-гейта).
        [IO.File]::WriteAllText((Join-Path $root 'vendor\nomad-src.sha256'), (Get-HmTreeSha256 $srcOut))
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

# Подпись издателя у ВСЕГО, что лежит в vendor\apps, — ДО снятия сумм: после этой строки манифест
# заверит ровно проверенные файлы. Сюда же попадает то, что мимо Dl (скрепка из локальной сборки,
# шрифт из zip, распакованный uv) и то, что осталось от прошлых прогонов; неизвестное имя — стоп.
Write-Host "[vendor] Проверка подписей издателей (tools\vendor-signers.json)..."
Assert-HmVendorApps -Apps $apps

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
  # #2: nomad-src integrity — закрепляем в checksums.json манифест дерева + главный файл
  # пакета (nomad.ps1 верифицирует их перед установкой из непроверенного дерева).
  $nomadShaChk = Get-Item (Join-Path $root 'vendor\nomad-src.sha256') -ErrorAction SilentlyContinue
  if ($nomadShaChk) { $toHash += $nomadShaChk }
  $nomadPyproj = Get-Item (Join-Path $root 'vendor\nomad-src\pyproject.toml') -ErrorAction SilentlyContinue
  if ($nomadPyproj) { $toHash += $nomadPyproj }
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
foreach ($name in @('git-setup.exe','node-lts.msi','python-setup.exe','vscode-setup.exe','cursor-setup.exe','claude-code.vsix','vscode-language-pack-ru.vsix')) {
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
# «Есть хоть один файл» — не полнота. Каталог с тремя базовыми колёсами из ста
# тринадцати проходил этот счётчик так же, как полный: гейт умел отличать только
# «каталога нет вовсе». Провал самого скачивания — сигнал точный, его и добавляем.
if (-not $wheelsOk) { $missing += 'pywheels/ (скачивание колёс завершилось с ошибкой — набор НЕПОЛНЫЙ)' }
if (-not $npmCacheOk) { $missing += 'npm-cache/ (npm install завершился с ошибкой — кеш НЕПОЛНЫЙ)' }
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

# Маркер издания: offlineEdition=true пишем ТОЛЬКО если completeness-проверка выше прошла
# без пропусков ($missing пуст). Неполный vendor → честно offlineEdition=false (сбрасываем
# и возможный true от прошлого прогона): renderer работает в online/lite-режиме, а не даёт
# ложную офлайн-гарантию по недостающим артефактам. Сборку НЕ валим (WARNING, не exit 1).
# main.js по true жёстко блокирует запуск офлайн-издания без vendor (translocation/оторванный
# sibling); онлайн/lite-издание при отсутствии vendor лишь мягко предупреждает.
# Текстовая вставка (не ConvertTo-Json) — сохраняет формат/комментарии.
$offlineVal = if ($missing.Count -gt 0) { 'false' } else { 'true' }
if ($missing.Count -gt 0) {
  Write-Host "[vendor] WARNING: vendor неполон — offlineEdition=false (издание НЕ заявляется офлайн-полным). Недостающее: $($missing -join ', ')"
}
$cfgPath = Join-Path $root 'config.json'
try {
  $enc = New-Object System.Text.UTF8Encoding($false)   # UTF-8 без BOM
  $raw = [IO.File]::ReadAllText($cfgPath, $enc)
  if ($raw -match '"offlineEdition"') {
    $raw = [regex]::Replace($raw, '"offlineEdition"\s*:\s*(true|false)', ('"offlineEdition": ' + $offlineVal))
  } else {
    # Вставляем ключ сразу после ПЕРВОЙ '{' (верх объекта), count=1.
    $raw = [regex]::new('\{').Replace($raw, "{`n  `"offlineEdition`": $offlineVal,", 1)
  }
  [IO.File]::WriteAllText($cfgPath, $raw, $enc)
  if ($offlineVal -eq 'true') { Write-Host "[vendor] config.json: offlineEdition=true (издание заявлено офлайн-полным)." }
  else { Write-Host "[vendor] config.json: offlineEdition=false (vendor неполон — online/lite-режим)." }
} catch { Write-Host "  ! offlineEdition в config.json не записан - $($_.Exception.Message)" }

$total = (Get-ChildItem -Recurse -File (Join-Path $root 'vendor') | Measure-Object Length -Sum).Sum
Write-Host ("[vendor] ГОТОВО — vendor\ весит {0:N0} МБ" -f ($total/1MB))
