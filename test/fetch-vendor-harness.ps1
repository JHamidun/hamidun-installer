# fetch-vendor-harness.ps1 — прогон ФУНКЦИЙ из tools/fetch-vendor.ps1 без запуска самого фетчера.
#
# ЗАЧЕМ ОТДЕЛЬНО. Фетчер качает гигабайты и ходит в сеть, поэтому целиком его в тесте не
# гоняют: раньше о нём судили по тексту («в скрипте есть такая-то строка»), а текст не
# отличает работающий выбор версии от нерабочего. Здесь функции достаются из скрипта по AST
# и исполняются настоящим PowerShell 5.1 — на заготовленных ответах Marketplace и на
# подставных подписях. Сеть и Get-AuthenticodeSignature подменяются одноимёнными функциями
# (функция в PowerShell приоритетнее командлета), самой логики подмена не касается.
#
# Вывод — строки «МЕТКА значение» в ASCII (разбирает test/run-tests.js). Код выхода
# сценария значим: Assert-HmVendorFile при провале делает exit 1, и тест это проверяет.
param(
    [Parameter(Mandatory = $true)][string]$Script,
    [Parameter(Mandatory = $true)][string]$Case,
    [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# --- достаём функции из fetch-vendor.ps1 по AST и определяем их в ЭТОЙ области видимости ---
$script:HmAst = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)
function Get-FvFunctionText([string[]]$Names) {
    # Текст функций одним блоком. Определять их надо точкой на ВЕРХНЕМ уровне сценария
    # (. ([scriptblock]::Create(...))): точка внутри функции определила бы их в её локальной
    # области и они пропали бы на выходе.
    $parts = @()
    foreach ($n in $Names) {
        $found = $script:HmAst.FindAll({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true) | Select-Object -First 1
        if (-not $found) { Write-Output "MISSING-FN $n"; exit 9 }
        $parts += $found.Extent.Text
    }
    return ($parts -join "`n`n")
}

# То же, но отсутствующая функция молча пропускается: так один и тот же тест прогоняется и против
# новой редакции скрипта, и против прежней (где новых функций ещё нет).
function Get-FvFunctionTextOptional([string[]]$Names) {
    $parts = @()
    foreach ($n in $Names) {
        $found = $script:HmAst.FindAll({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true) | Select-Object -First 1
        if ($found) { $parts += $found.Extent.Text }
    }
    return ($parts -join "`n`n")
}

# Значение верхнеуровневого присваивания `$Name = <литерал>` из скрипта (так достаём константы, не запуская его).
function Get-FvAssigned([string]$Name) {
    $a = $script:HmAst.FindAll({ param($x) $x -is [System.Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -eq ('$' + $Name) }, $true) | Select-Object -First 1
    if (-not $a) { Write-Output "MISSING-VAR $Name"; exit 9 }
    return (& ([scriptblock]::Create($a.Right.Extent.Text)))
}

function Out-Ver($v) { if ($null -eq $v -or "$v" -eq '') { 'NULL' } else { "$v" } }

# Таблица пинов — настоящая, из tools\vendor-signers.json рядом с проверяемым скриптом.
function Get-FvPins {
    $p = Join-Path (Split-Path -Parent $Script) 'vendor-signers.json'
    return ([IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) | ConvertFrom-Json)
}

# ---- подставной PKI в памяти (в хранилища Windows НИЧЕГО не пишется) ----------------------------
# Нужен, чтобы проверка «корень цепочки подписанта лежит в LocalMachine\Root» исполнялась по-настоящему,
# а не по тексту. Тестовые корни не лежат ни в одном хранилище, поэтому «машинный» корень подставляется
# швом Get-HmMachineRootThumbprints, а «пользовательский движок доверяет любому корню» (корень в HKCU,
# куда пишет любой процесс пользователя без UAC) имитируется флагом AllowUnknownCertificateAuthority в
# шве New-HmX509Chain. Оба шва существуют в самом скрипте именно ради этого.
$script:PkiSerial = 7000
function New-FvKey { return [System.Security.Cryptography.RSA]::Create(2048) }

# Сертификат с заданным общим именем: самоподписанный (-Issuer не задан) либо выпущенный Issuer'ом.
# Подпись идёт через X509SignatureGenerator: перегрузка с самим сертификатом-издателем отказывается
# выпускать сертификат, срок которого не вложен в срок издателя, а «лист годен сегодня под просроченным
# промежуточным» именно такой.
function New-FvCert {
    param(
        [Parameter(Mandatory = $true)][string]$Cn,
        [Parameter(Mandatory = $true)][System.Security.Cryptography.RSA]$Key,
        [Parameter(Mandatory = $true)][DateTimeOffset]$NotBefore,
        [Parameter(Mandatory = $true)][DateTimeOffset]$NotAfter,
        $Issuer = $null,
        [switch]$Ca,
        [string[]]$Eku = @()
    )
    $dn = New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName(('CN="' + $Cn.Replace('"', '""') + '", O=Fake Org, C=US'))
    $req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest($dn, $Key, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $ku = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]
    if ($Ca) {
        $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($true, $false, 0, $true)))
        $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension(($ku::KeyCertSign -bor $ku::CrlSign), $true)))
    } else {
        $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($false, $false, 0, $true)))
        $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension($ku::DigitalSignature, $true)))
    }
    if ($Eku.Count -gt 0) {
        $col = New-Object System.Security.Cryptography.OidCollection
        foreach ($o in $Eku) { [void]$col.Add((New-Object System.Security.Cryptography.Oid($o))) }
        $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($col, $false)))
    }
    $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension($req.PublicKey, $false)))
    if ($null -eq $Issuer) { return $req.CreateSelfSigned($NotBefore, $NotAfter) }
    $script:PkiSerial++
    $serial = [byte[]]([BitConverter]::GetBytes([int]$script:PkiSerial) + [byte[]](9, 8, 7, 6))
    $issuerKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Issuer)
    $gen = [System.Security.Cryptography.X509Certificates.X509SignatureGenerator]::CreateForRSA($issuerKey, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $pub = $req.Create($Issuer.SubjectName, $gen, $NotBefore, $NotAfter, $serial)
    return [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($pub, $Key)
}

# Корни и промежуточные тестового PKI: «машинный» (R, I, IE) и «посторонний» (X, XI), которого нет в машинном наборе.
function Initialize-FvPki {
    if ($script:Pki) { return }
    $now = [DateTimeOffset]::UtcNow
    $p = @{}
    $p.R  = New-FvCert -Cn 'Hm Test Machine Root' -Key (New-FvKey) -NotBefore $now.AddDays(-900) -NotAfter $now.AddDays(900) -Ca
    $p.I  = New-FvCert -Cn 'Hm Test Machine CA' -Key (New-FvKey) -NotBefore $now.AddDays(-800) -NotAfter $now.AddDays(800) -Ca -Issuer $p.R
    # промежуточный с ИСТЁКШИМ сроком (как «Microsoft ID Verified CS EOC CA 01» у python.org); под ним лист годен сегодня
    $p.IE = New-FvCert -Cn 'Hm Test Machine CA Expired' -Key (New-FvKey) -NotBefore $now.AddDays(-400) -NotAfter $now.AddDays(-30) -Ca -Issuer $p.R
    $p.X  = New-FvCert -Cn 'Hm Test Rogue Root' -Key (New-FvKey) -NotBefore $now.AddDays(-900) -NotAfter $now.AddDays(900) -Ca
    $p.XI = New-FvCert -Cn 'Hm Test Rogue CA' -Key (New-FvKey) -NotBefore $now.AddDays(-800) -NotAfter $now.AddDays(800) -Ca -Issuer $p.X
    $p.LeafKey = New-FvKey
    $p.All = @($p.R, $p.I, $p.IE, $p.X, $p.XI)
    $script:Pki = $p
}

# Подписант и метка времени для строки таблицы подписей. Kind задаёт, КАК устроена цепочка:
#   machine  — лист под машинным корнем, годен сегодня, метки нет          selfsigned — сам себе корень
#   rogue    — лист под чужим корнем (движок «доверяет» ему, машина — нет)
#   exp-*    — лист ИСТЁК (как 72-часовой лист Microsoft ID Verified); -ts-<кто> — чья метка времени
#   inter-exp-* — лист годен сегодня, но промежуточный СЕРТИФИКАТ-издатель истёк
#   noeku / wrongeku — у листа нет EKU Code Signing / только EKU метки времени
function Get-FvSigMaterial([string]$Cn, [string]$Kind) {
    Initialize-FvPki
    $p = $script:Pki
    $now = [DateTimeOffset]::UtcNow
    $cs = '1.3.6.1.5.5.7.3.3'
    $tsEku = '1.3.6.1.5.5.7.3.8'
    $nb = $now.AddDays(-2); $na = $now.AddDays(2)
    $enb = $now.AddDays(-20); $ena = $now.AddDays(-10)
    $cert = $null
    $ts = $null
    switch ($Kind) {
        'machine' { $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.I -Eku @($cs) }
        'selfsigned' { $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Eku @($cs) }
        'rogue' { $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.XI -Eku @($cs) }
        'noeku' { $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.I }
        'wrongeku' { $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.I -Eku @($tsEku) }
        'exp-nots' { $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $enb -NotAfter $ena -Issuer $p.I -Eku @($cs) }
        'exp-ts-machine' {
            $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $enb -NotAfter $ena -Issuer $p.I -Eku @($cs)
            $ts = New-FvCert -Cn 'Hm Test TSA' -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.I -Eku @($tsEku)
        }
        # как у python.org: метка времени настоящая, но СЕРТИФИКАТ самой метки уже истёк (его срок оценён по времени подписи)
        'exp-ts-expired-machine' {
            $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $enb -NotAfter $ena -Issuer $p.I -Eku @($cs)
            $ts = New-FvCert -Cn 'Hm Test TSA Old' -Key $p.LeafKey -NotBefore $now.AddDays(-60) -NotAfter $now.AddDays(-5) -Issuer $p.I -Eku @($tsEku)
        }
        'exp-ts-rogue' {
            $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $enb -NotAfter $ena -Issuer $p.I -Eku @($cs)
            $ts = New-FvCert -Cn 'Hm Test Rogue TSA' -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.XI -Eku @($tsEku)
        }
        'exp-ts-noeku' {
            $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $enb -NotAfter $ena -Issuer $p.I -Eku @($cs)
            $ts = New-FvCert -Cn 'Hm Test TSA' -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.I
        }
        'exp-ts-wrongeku' {
            $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $enb -NotAfter $ena -Issuer $p.I -Eku @($cs)
            $ts = New-FvCert -Cn 'Hm Test TSA' -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.I -Eku @($cs)
        }
        'inter-exp-nots' { $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.IE -Eku @($cs) }
        'inter-exp-ts-machine' {
            $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.IE -Eku @($cs)
            $ts = New-FvCert -Cn 'Hm Test TSA' -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.I -Eku @($tsEku)
        }
        'inter-exp-ts-rogue' {
            $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.IE -Eku @($cs)
            $ts = New-FvCert -Cn 'Hm Test Rogue TSA' -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.XI -Eku @($tsEku)
        }
        # всё годно сегодня: метка времени подписи не нужна, чужая метка ничего не меняет
        'valid-ts-rogue' {
            $cert = New-FvCert -Cn $Cn -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.I -Eku @($cs)
            $ts = New-FvCert -Cn 'Hm Test Rogue TSA' -Key $p.LeafKey -NotBefore $nb -NotAfter $na -Issuer $p.XI -Eku @($tsEku)
        }
        default { throw "неизвестный kind подписи: $Kind" }
    }
    return @{ Cert = $cert; Ts = $ts }
}

# Подставная Get-AuthenticodeSignature: ответ берётся из $script:SigTable[<имя файла>] =
# { status; cn; nocert; throwRead; kind (по умолчанию machine); sigType (по умолчанию Authenticode) }.
function Get-AuthenticodeSignature {
    [CmdletBinding()]
    param([string]$LiteralPath)
    $name = [IO.Path]::GetFileName($LiteralPath)
    $row = $script:SigTable[$name]
    if ($null -eq $row) { $row = @{ status = 'NotSigned'; cn = $null } }
    if ($row.throwRead) { throw 'boom' }
    $cert = $null
    $ts = $null
    if ($null -ne $row.cn -and -not $row.nocert) {
        $kind = 'machine'
        if ($row.kind) { $kind = [string]$row.kind }
        $m = Get-FvSigMaterial -Cn ([string]$row.cn) -Kind $kind
        $cert = $m.Cert
        $ts = $m.Ts
    }
    $stype = 'Authenticode'
    if ($row.sigType) { $stype = [string]$row.sigType }
    return [pscustomobject]@{ Status = [string]$row.status; SignerCertificate = $cert; TimeStamperCertificate = $ts; SignatureType = $stype }
}
$script:SigTable = @{}

# Швы проверки подписи: «машинные корни» и построитель цепочки (см. комментарий к PKI выше). Настоящими
# они остаются только в случае realsig, где этот блок снимается.
function Get-HmMachineRootThumbprints {
    Initialize-FvPki
    return @([string]$script:Pki.R.Thumbprint)
}
function New-HmX509Chain {
    Initialize-FvPki
    $c = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    foreach ($x in $script:Pki.All) { [void]$c.ChainPolicy.ExtraStore.Add($x) }
    $c.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
    return $c
}

# Функции проверки подписи из скрипта: обязательные (есть и в старой редакции) + новые, которых в старой
# редакции нет (тест, прогнанный против неё, должен падать на ПОВЕДЕНИИ, а не на «нет функции»).
function Get-FvSignerFunctionText {
    $req = Get-FvFunctionText @('New-HmSignerVerdict', 'Test-HmVendorSigner')
    $opt = Get-FvFunctionTextOptional @('Test-HmCertHasEku', 'Get-HmChainAnchor', 'Test-HmSignerAnchored')
    return ($req + "`n`n" + $opt)
}

# Подставная zip-упаковка .vsix: extension.vsixmanifest в том виде, в каком его кладёт Marketplace.
function New-FakeVsix {
    param([string]$Path, [string]$Id = 'vscode-language-pack-ru', [string]$Publisher = 'MS-CEINTL',
          [string]$Engine = '^1.131.0', [switch]$Gzip, [switch]$NoManifest, [switch]$Corrupt, [switch]$NoEngine)
    if ($Corrupt) { [IO.File]::WriteAllBytes($Path, [byte[]](1..64)); return }
    $eng = ''
    if (-not $NoEngine) { $eng = '<Property Id="Microsoft.VisualStudio.Code.Engine" Value="' + $Engine + '" />' }
    $mf = '<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata>' +
          '<Identity Language="en-US" Id="' + $Id + '" Version="1.0.0" Publisher="' + $Publisher + '" />' +
          '<Properties>' + $eng + '<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" /></Properties></Metadata></PackageManifest>'
    $raw = if ($Gzip) { $Path + '.raw' } else { $Path }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $raw) { Remove-Item -LiteralPath $raw -Force }
    $za = [IO.Compression.ZipFile]::Open($raw, [IO.Compression.ZipArchiveMode]::Create)
    try {
        if (-not $NoManifest) {
            $e = $za.CreateEntry('extension.vsixmanifest')
            $w = New-Object IO.StreamWriter($e.Open(), (New-Object Text.UTF8Encoding($false)))
            try { $w.Write($mf) } finally { $w.Dispose() }
        }
        $e2 = $za.CreateEntry('extension/package.json')
        $w2 = New-Object IO.StreamWriter($e2.Open(), (New-Object Text.UTF8Encoding($false)))
        try { $w2.Write('{}') } finally { $w2.Dispose() }
    } finally { $za.Dispose() }
    if ($Gzip) {
        $in = [IO.File]::OpenRead($raw); $out = [IO.File]::Create($Path)
        $gz = New-Object IO.Compression.GZipStream($out, [IO.Compression.CompressionMode]::Compress)
        try { $in.CopyTo($gz) } finally { $gz.Dispose(); $out.Dispose(); $in.Dispose() }
        Remove-Item -LiteralPath $raw -Force
    }
}

switch ($Case) {

    # ---- A. выбор версии русского языкового пакета ------------------------------------------
    'select' {
        . ([scriptblock]::Create((Get-FvFunctionText @('ConvertFrom-HmVsEngine', 'Test-HmVsEngineFits', 'Get-HmLanguagePackVersions', 'Select-HmLanguagePackVersion'))))
        $spec = [IO.File]::ReadAllText((Join-Path $Work 'cases.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        foreach ($c in @($spec.cases)) {
            $patch = 0
            if ($null -ne $c.editorPatch) { $patch = [int]$c.editorPatch }
            $resp = $c.response
            $got = Select-HmLanguagePackVersion -Response $resp -EditorMinor ([int]$c.editorMinor) -EditorPatch $patch
            Write-Output ("SELECT {0} {1}" -f $c.name, (Out-Ver $got))
            # Негативный контроль: ПРЕЖНЯЯ логика (версия пакета обязана начинаться с 1.<минор>.).
            $old = $null
            try { $old = (@($resp.results[0].extensions[0].versions) | Where-Object { [string]$_.version -match ('^1\.' + [int]$c.editorMinor + '\.') } | Select-Object -First 1).version } catch { }
            Write-Output ("OLD {0} {1}" -f $c.name, (Out-Ver $old))
        }
    }

    'engine' {
        . ([scriptblock]::Create((Get-FvFunctionText @('ConvertFrom-HmVsEngine', 'Test-HmVsEngineFits'))))
        $spec = [IO.File]::ReadAllText((Join-Path $Work 'cases.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        foreach ($c in @($spec.cases)) {
            $ed = [long[]]@($c.editor)
            $r = Test-HmVsEngineFits -Engine ([string]$c.engine) -Editor $ed
            Write-Output ("ENGINE {0} {1}" -f $c.name, $r)
        }
    }

    # ---- A. гейт честности скачанного .vsix --------------------------------------------------
    'confirm' {
        . ([scriptblock]::Create((Get-FvFunctionText @('ConvertFrom-HmVsEngine', 'Test-HmVsEngineFits', 'Confirm-HmLanguagePackVsix'))))
        $spec = [IO.File]::ReadAllText((Join-Path $Work 'cases.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        $i = 0
        foreach ($c in @($spec.cases)) {
            $i++
            $f = Join-Path $Work ("pack{0}.vsix" -f $i)
            if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
            $p = @{ Path = $f }
            foreach ($k in @('id', 'publisher', 'engine')) { if ($null -ne $c.$k) { $p[(Get-Culture).TextInfo.ToTitleCase($k)] = [string]$c.$k } }
            if ($c.gzip) { $p['Gzip'] = $true }
            if ($c.noManifest) { $p['NoManifest'] = $true }
            if ($c.corrupt) { $p['Corrupt'] = $true }
            if ($c.noEngine) { $p['NoEngine'] = $true }
            New-FakeVsix @p
            $patch = 0
            if ($null -ne $c.editorPatch) { $patch = [int]$c.editorPatch }
            $r = Confirm-HmLanguagePackVsix -Path $f -EditorMinor ([int]$c.editorMinor) -EditorPatch $patch 6>&1 | Out-String
            $kept = Test-Path -LiteralPath $f
            $zip = $false
            if ($kept) {
                $fs = [IO.File]::OpenRead($f); $b0 = $fs.ReadByte(); $b1 = $fs.ReadByte(); $fs.Close()
                $zip = ($b0 -eq 0x50 -and $b1 -eq 0x4b)
            }
            Write-Output ("CONFIRM {0} kept={1} zip={2}" -f $c.name, $kept, $zip)
        }
    }

    # ---- A. весь блок целиком с подставной сетью ---------------------------------------------
    'e2e' {
        . ([scriptblock]::Create((Get-FvFunctionText @('ConvertFrom-HmVsEngine', 'Test-HmVsEngineFits', 'Get-HmLanguagePackVersions', 'Select-HmLanguagePackVersion',
                             'Confirm-HmLanguagePackVsix', 'Invoke-HmLanguagePackFetch'))))
        $spec = [IO.File]::ReadAllText((Join-Path $Work 'cases.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        $UA = @{ 'User-Agent' = 'hamidun-setup' }
        $caseNo = 0
        foreach ($c in @($spec.cases)) {
            $caseNo++
            $apps = Join-Path $Work ("apps{0}" -f $caseNo)
            New-Item -ItemType Directory -Force $apps | Out-Null
            $script:Dl_Calls = New-Object System.Collections.ArrayList
            $script:Q_Calls = 0
            $script:CurCase = $c
            $script:Apps = $apps
            # подставной запрос к Marketplace
            function Get-HmMarketplaceQuery([string]$ExtensionId, [int]$Flags) {
                $script:Q_Calls++
                if (($script:CurCase.response -is [string]) -and ($script:CurCase.response -eq 'throw')) { throw 'network down' }
                return $script:CurCase.response
            }
            # подставная загрузка: версию берём из URL, содержимое — из описания случая
            function Dl($url, $out) {
                if (Test-Path -LiteralPath $out) { Write-Host "  skip $([IO.Path]::GetFileName($out))"; return }
                $v = ''
                if ($url -match '/vscode-language-pack-ru/([^/]+)/vspackage') { $v = $Matches[1] }
                [void]$script:Dl_Calls.Add($v)
                $d = $null
                if ($script:CurCase.downloads) { $d = $script:CurCase.downloads.PSObject.Properties[$v] }
                if (-not $d) { Write-Host "  ! не скачалось (stub)"; return }
                $dv = $d.Value
                $p = @{ Path = $out }
                if ($null -ne $dv.id) { $p['Id'] = [string]$dv.id }
                if ($null -ne $dv.publisher) { $p['Publisher'] = [string]$dv.publisher }
                if ($null -ne $dv.engine) { $p['Engine'] = [string]$dv.engine }
                if ($dv.gzip) { $p['Gzip'] = $true }
                New-FakeVsix @p
            }
            if ($c.existing) {
                $p = @{ Path = (Join-Path $apps 'vscode-language-pack-ru.vsix') }
                if ($null -ne $c.existing.id) { $p['Id'] = [string]$c.existing.id }
                if ($null -ne $c.existing.publisher) { $p['Publisher'] = [string]$c.existing.publisher }
                if ($null -ne $c.existing.engine) { $p['Engine'] = [string]$c.existing.engine }
                New-FakeVsix @p
            }
            $ev = ''
            if ($null -ne $c.editor) { $ev = [string]$c.editor }
            $log = (& { Invoke-HmLanguagePackFetch -Apps $apps -EditorVersion $ev } 6>&1 | Out-String) -replace '\s+', ' '
            $has = Test-Path -LiteralPath (Join-Path $apps 'vscode-language-pack-ru.vsix')
            Write-Output ("E2E {0} FILE={1} DL={2} Q={3}" -f $c.name, $has, (@($script:Dl_Calls) -join ','), $script:Q_Calls)
            Write-Output ("LOG {0} {1}" -f $c.name, $log.Trim())
        }
    }

    # ---- B. пин издателя: вердикт по одному файлу -------------------------------------------
    'signer' {
        . ([scriptblock]::Create((Get-FvSignerFunctionText)))
        $pins = Get-FvPins
        $spec = [IO.File]::ReadAllText((Join-Path $Work 'cases.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        foreach ($c in @($spec.cases)) {
            $script:SigTable = @{}
            $script:SigTable[[string]$c.file] = @{ status = $c.status; cn = $c.cn; nocert = [bool]$c.nocert; throwRead = [bool]$c.throwRead; kind = $c.kind; sigType = $c.sigType }
            $v = Test-HmVendorSigner -Path (Join-Path $Work $c.file) -Pins $pins
            Write-Output ("SIGNER {0} {1} {2} {3} {4}" -f $c.name, $v.Ok, $v.Kind, $v.Delete, $v.Reason)
        }
    }

    # ---- B. настоящая Dl: загрузка -> проверка -> удаление и exit 1 при провале ---------------
    'dl' {
        . ([scriptblock]::Create((Get-FvSignerFunctionText) + "`n`n" + (Get-FvFunctionText @('Assert-HmVendorFile', 'Dl'))))
        $HmSigners = Get-FvPins
        $sc = [IO.File]::ReadAllText((Join-Path $Work 'scenario.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        $out = Join-Path $Work $sc.file
        $script:SigTable = @{}
        $script:SigTable[[string]$sc.file] = @{ status = $sc.status; cn = $sc.cn }
        function Invoke-WebRequest {
            [CmdletBinding()]
            param([Parameter(Position = 0)][string]$Uri, [string]$OutFile, [int]$MaximumRedirection, [switch]$UseBasicParsing)
            if ($script:Sc.failDownload) { throw 'сеть недоступна (stub)' }
            [IO.File]::WriteAllBytes($OutFile, [byte[]](1..200))
        }
        $script:Sc = $sc
        if ($sc.preexisting) { [IO.File]::WriteAllBytes($out, [byte[]](1..50)) }
        Dl 'https://example.invalid/installer' $out
        Write-Output ("DL_RETURNED exists={0}" -f (Test-Path -LiteralPath $out))
    }

    # ---- B. повторная проверка того же файла: кэша «уже проверен» нет --------------------------
    'reverify' {
        . ([scriptblock]::Create((Get-FvSignerFunctionText) + "`n`n" + (Get-FvFunctionText @('Assert-HmVendorFile'))))
        $HmSigners = Get-FvPins
        $f = Join-Path $Work 'git-setup.exe'
        [IO.File]::WriteAllBytes($f, [byte[]](1..40))
        $script:SigTable = @{ 'git-setup.exe' = @{ status = 'Valid'; cn = 'Johannes Schindelin' } }
        Assert-HmVendorFile -Path $f
        Write-Output 'FIRST_OK'
        # Файл «подменили» между двумя проверками, оставив размер и время записи прежними:
        # подпись теперь чужая, и вторая проверка обязана это увидеть (а не поверить прошлому разу).
        $script:SigTable['git-setup.exe'] = @{ status = 'Valid'; cn = 'Evil Corp' }
        Assert-HmVendorFile -Path $f
        Write-Output 'SECOND_RETURNED'
    }

    # ---- B. итоговый обход vendor\apps ---------------------------------------------------------
    'sweep' {
        . ([scriptblock]::Create((Get-FvSignerFunctionText) + "`n`n" + (Get-FvFunctionText @('Assert-HmVendorFile', 'Assert-HmVendorApps'))))
        $HmSigners = Get-FvPins
        $sc = [IO.File]::ReadAllText((Join-Path $Work 'scenario.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        $apps = Join-Path $Work 'apps'
        $script:SigTable = @{}
        foreach ($f in @($sc.files)) {
            $p = Join-Path $apps $f.rel
            New-Item -ItemType Directory -Force (Split-Path -Parent $p) | Out-Null
            if ($f.empty) { [IO.File]::WriteAllBytes($p, [byte[]]@()) } else { [IO.File]::WriteAllBytes($p, [byte[]](1..40)) }
            $script:SigTable[[IO.Path]::GetFileName($f.rel)] = @{ status = $f.status; cn = $f.cn }
        }
        Assert-HmVendorApps -Apps $apps
        Write-Output 'SWEEP_DONE'
    }

    # ---- B. настоящие подписи настоящих файлов против таблицы пинов -------------------------
    'realsig' {
        # Здесь НИЧЕГО не подменяется: настоящие подписи, настоящее хранилище LocalMachine\Root, настоящий построитель цепочек.
        # Подставные Get-AuthenticodeSignature и швы снимаются, настоящие швы (если они есть в скрипте) достаются из него.
        Remove-Item Function:\Get-AuthenticodeSignature, Function:\Get-HmMachineRootThumbprints, Function:\New-HmX509Chain -ErrorAction SilentlyContinue
        . ([scriptblock]::Create((Get-FvSignerFunctionText) + "`n`n" + (Get-FvFunctionTextOptional @('Get-HmMachineRootThumbprints', 'New-HmX509Chain'))))
        $pins = Get-FvPins
        foreach ($f in @(Get-ChildItem -LiteralPath $Work -File -Recurse -Force)) {
            $v = Test-HmVendorSigner -Path $f.FullName -Pins $pins
            Write-Output ("REAL {0} {1} {2} {3}" -f ($f.Name -replace ' ', '_'), $v.Ok, $v.Kind, $v.Reason)
        }
    }

    # ---- C. настоящая Get-HmPyWheels против локального индекса (сети нет) --------------------
    'pipwheels' {
        . ([scriptblock]::Create((Get-FvFunctionText @('Get-HmPyWheels'))))
        $sc = [IO.File]::ReadAllText((Join-Path $Work 'scenario.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        # pip смотрит только в локальный индекс; на случай ошибки сети нет вовсе (прокси в никуда).
        $env:PIP_INDEX_URL = [string]$sc.index
        $env:PIP_CONFIG_FILE = 'NUL'
        $env:PIP_NO_CACHE_DIR = '1'
        $env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
        $env:PIP_NO_INPUT = '1'
        # Окружение теста, а не боевой команды: изолированная сборка тянула бы setuptools из индекса, а в
        # локальном индексе его нет. pip читает PIP_NO_BUILD_ISOLATION=0 как «изоляция выключена» и берёт
        # setuptools из Python машины (тест пропускается, если его там нет). Проверяемое — отказ pip по
        # sha256 ДО сборки, запрет sdist и приоритет прямой ссылки — от изоляции не зависит.
        $env:PIP_NO_BUILD_ISOLATION = '0'
        $env:HTTP_PROXY = 'http://127.0.0.1:9'; $env:HTTPS_PROXY = 'http://127.0.0.1:9'; $env:ALL_PROXY = 'http://127.0.0.1:9'
        New-Item -ItemType Directory -Force ([string]$sc.wheels) | Out-Null
        $res = Get-HmPyWheels -Py ([string]$sc.python) -Req ([string]$sc.req) -Wheels ([string]$sc.wheels) -Pyaes $sc.pin
        Write-Output ("PIPWHEELS ok=" + [string]$res)
    }

    # ---- D. загрузчик личных паттернов экспорт-фильтра ----------------------------------------
    'leak' {
        . ([scriptblock]::Create((Get-FvFunctionText @('Get-HmLeakPatterns'))))
        $generic = Get-FvAssigned 'HM_LEAK_GENERIC_RE'
        $spec = [IO.File]::ReadAllText((Join-Path $Work 'scenarios.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        foreach ($s in @($spec.scenarios)) {
            $lf = ''
            if ($null -ne $s.file) {
                $lf = Join-Path $Work ($s.name + '.json')
                [IO.File]::WriteAllText($lf, [string]$s.file, (New-Object Text.UTF8Encoding($false)))
            }
            $envText = ''
            if ($null -ne $s.env) { $envText = [string]$s.env }
            $res = $null
            try { $res = Get-HmLeakPatterns -LocalFile $lf -EnvJson $envText -GenericRe $generic }
            catch { Write-Output ("THROWS {0} {1}" -f $s.name, ($_.Exception.Message -replace '\s+', ' ')); continue }
            Write-Output ("LEAK {0} private={1} count={2} scrubs={3} source={4}" -f $s.name, $res.Private, $res.Count, @($res.Scrubs).Count, $res.Source)
            # Скан в фетчере — Select-String (без учёта регистра, КАЖДЫЙ паттерн компилируется отдельно). Прежняя
            # редакция отдавала один склеенный regex (свойство Regex): параметры (?-i) и номера групп одного паттерна
            # перетекали в соседние — проба ниже это и показывает.
            $pats = @($res.Regex)
            if ($res.PSObject.Properties['Patterns']) { $pats = @($res.Patterns) }
            foreach ($pr in $spec.probes.PSObject.Properties) {
                $hit = $false
                foreach ($pt in $pats) { if ([regex]::IsMatch([string]$pr.Value, [string]$pt, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) { $hit = $true; break } }
                Write-Output ("PROBE {0} {1} {2}" -f $s.name, $pr.Name, $hit)
            }
        }
    }

    # ---- D. релизная ли сборка и что делать, если личного списка паттернов нет -----------------
    'leakpolicy' {
        . ([scriptblock]::Create((Get-FvFunctionText @('Test-HmReleaseBuild', 'Get-HmLeakListVerdict'))))
        $spec = [IO.File]::ReadAllText((Join-Path $Work 'cases.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        foreach ($c in @($spec.cases)) {
            $rel = Test-HmReleaseBuild -Ci ([string]$c.ci) -GithubActions ([string]$c.gha) -Release ([string]$c.release)
            $v = Get-HmLeakListVerdict -Private ([bool]$c.private) -Release ([bool]$rel) -Allow ([string]$c.allow)
            Write-Output ("POLICY {0} release={1} verdict={2}" -f $c.name, $rel, $v)
        }
    }

    # ---- D. экспорт-фильтр nomad-src целиком на временном дереве ----------------------------------
    # Окружение (CI, HM_RELEASE, HM_LEAK_PATTERNS…) задаётся сценарием: процесс harness — дочерний, чужое не затрагивается.
    'sanitize' {
        # $PSScriptRoot в функциях, собранных из строки, пуст, а в скрипте он указывает на tools\ — туда, где лежит НАСТОЯЩИЙ
        # личный список владельца. Тест его читать не должен: корень подменяется пустым рабочим каталогом сценария.
        $script:FvToolsDir = $Work
        $fnText = (Get-FvFunctionText @('Test-NomadSrcCritical', 'Get-HmLeakPatterns', 'Invoke-NomadSrcSanitize')) + "`n`n" + (Get-FvFunctionTextOptional @('Test-HmReleaseBuild', 'Get-HmLeakListVerdict'))
        . ([scriptblock]::Create($fnText.Replace('$PSScriptRoot', '$script:FvToolsDir')))
        $HM_LEAK_GENERIC_RE = Get-FvAssigned 'HM_LEAK_GENERIC_RE'
        $sc = [IO.File]::ReadAllText((Join-Path $Work 'scenario.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        foreach ($n in @('CI', 'GITHUB_ACTIONS', 'HM_RELEASE', 'HM_ALLOW_NO_PRIVATE_LEAK_LIST', 'HM_LEAK_PATTERNS', 'HM_LEAK_PATTERNS_FILE')) {
            [Environment]::SetEnvironmentVariable($n, $null, 'Process')
        }
        foreach ($p in $sc.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable([string]$p.Name, [string]$p.Value, 'Process') }
        if ($sc.privateFile) {
            $pf = Join-Path $Work ([string]$sc.privateFile.name)
            [IO.File]::WriteAllText($pf, [string]$sc.privateFile.text, (New-Object Text.UTF8Encoding($false)))
            [Environment]::SetEnvironmentVariable('HM_LEAK_PATTERNS_FILE', $pf, 'Process')
        }
        $src = Join-Path $Work 'src'
        New-Item -ItemType Directory -Force $src | Out-Null
        foreach ($f in @($sc.files)) {
            $p = Join-Path $src (([string]$f.rel) -replace '/', '\')
            New-Item -ItemType Directory -Force (Split-Path -Parent $p) | Out-Null
            [IO.File]::WriteAllText($p, [string]$f.text, (New-Object Text.UTF8Encoding($false)))
        }
        $script:SanRes = $null
        $log = (& { $script:SanRes = Invoke-NomadSrcSanitize $src } 6>&1 | Out-String) -replace '\s+', ' '
        Write-Output ("SANITIZE returned={0}" -f $script:SanRes)
        foreach ($f in @(Get-ChildItem -LiteralPath $src -File -Recurse -Force)) {
            Write-Output ("LEFT " + ($f.FullName.Substring($src.Length + 1) -replace '\\', '/'))
        }
        Write-Output ("LOG " + $log.Trim())
    }

    default { Write-Output "UNKNOWN-CASE $Case"; exit 8 }
}
exit 0
