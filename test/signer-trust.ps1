# Прогон Test-HmTrustedSigner (scripts/windows/_deelev.ps1) в Windows PowerShell 5.1.
#
# ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Раньше гейт подписи проверялся только чтением исходника (grep по тексту), и
# S-11 прошёл мимо: функция отказывала КАЖДОМУ настоящему установщику с просроченным листом, а тесты
# были зелёными. Здесь исполняется НАСТОЯЩИЙ текст функции, а не его описание.
#
# Грузим только нужные функции через AST, а не дот-сорсим _deelev.ps1 целиком: хвост файла при
# загрузке подметает НАСТОЯЩИЙ планировщик Windows (Remove-HmOrphanTasks), тесту это не нужно.
#
# Режимы:
#   hermetic  — цепочка сертификатов СОБСТВЕННОГО тестового удостоверяющего центра, созданная в памяти
#               (ни в один стор Windows ничего не пишется). Get-AuthenticodeSignature подменяется
#               функцией с тем же именем (функция в PowerShell важнее командлета), список машинных
#               корней — функцией Get-HmMachineRootThumbprints. Листья под ПРОСРОЧЕННЫМ промежуточным УЦ или
#               корнем (и ещё не вступивший в силу лист) собираются через X509SignatureGenerator: штатный
#               CertificateRequest.Create(issuer) не выпустит лист за сроком издателя, а злоумышленник с
#               утёкшим ключом просроченного УЦ выпустит.
#   real      — НАСТОЯЩИЕ файлы: вшитые установщики из -VendorDir (если есть) и системные exe Windows,
#               у которых подпись Valid, а сертификат подписанта уже просрочен. Только чтение.
#
# -Mutant — отрицательный контроль: перед загрузкой в текст функции вносится ровно та поломка, ради
# которой написан тест (вернуть старые флаги цепочки, выкинуть привязку к машинному корню и т.д.).
# Если замена не нашла что менять, прогон падает: мутант, который ничего не изменил, ничего не доказывает.
#
# Вывод — строки CASE<TAB>id<TAB>PASS|FAIL<TAB>деталь; их разбирает test/run-tests.js.
param(
    [Parameter(Mandatory = $true)][string]$DeelevPath,
    [string]$Mode = 'hermetic',
    [string]$Mutant = '',
    [string]$VendorDir = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$X = 'System.Security.Cryptography.X509Certificates'
$FLAGS = "$X.X509VerificationFlags"

# ---- мутанты: имя -> функция, что искать, на что заменить ------------------------------------------
$MUTANTS = @{
    'old-flags'      = @{ Fn = 'Get-HmSignerChainRoot'; Find = '[System.Security.Cryptography.X509Certificates.X509VerificationFlags]::IgnoreNotTimeValid -bor $ExtraFlags'; Repl = '[System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag -bor $ExtraFlags' }
    'no-anchor'      = @{ Fn = 'Test-HmTrustedSigner'; Find = 'if ($machineRoots -notcontains [string]$root.Thumbprint) {'; Repl = 'if ($false) {' }
    'any-status'     = @{ Fn = 'Test-HmTrustedSigner'; Find = "if (`$sig.Status -ne 'Valid') {"; Repl = 'if ($false) {' }
    'no-eku'         = @{ Fn = 'Test-HmTrustedSigner'; Find = 'if (-not $hasCodeSigning) {'; Repl = 'if ($false) {' }
    'no-subject-pin' = @{ Fn = 'Test-HmTrustedSigner'; Find = 'if ($ExpectedSubjectMatch -and ('; Repl = 'if ($false -and (' }
    'no-org-pin'     = @{ Fn = 'Test-HmTrustedSigner'; Find = 'if ($org -ne $ExpectedOrg) {'; Repl = 'if ($false) {' }
    'no-tsa-anchor'  = @{ Fn = 'Test-HmTrustedSigner'; Find = 'if ($machineRoots -notcontains [string]$tsAnchor.Root.Thumbprint) {'; Repl = 'if ($false) {' }
    'no-tsa-required' = @{ Fn = 'Test-HmTrustedSigner'; Find = 'if ($anchor.OutOfWindow -ne $false) {'; Repl = 'if ($false) {' }
    # Срок звеньев цепочки: проверка метки времени (b2) обязана срабатывать от ЛЮБОГО звена вне срока, а не
    # только от листа (находка ревью: лист годный, промежуточный УЦ просрочен, TSA — отравленный корень HKCU).
    'leaf-only-window'        = @{ Fn = 'Get-HmSignerChainRoot'; Find = 'foreach ($el in @($elems)) {'; Repl = 'foreach ($el in @($elems[0])) {' }
    'no-root-in-window'       = @{ Fn = 'Get-HmSignerChainRoot'; Find = 'foreach ($el in @($elems)) {'; Repl = 'foreach ($el in @($elems | Select-Object -First ($elems.Count - 1))) {' }
    'no-notbefore-clause'     = @{ Fn = 'Get-HmSignerChainRoot'; Find = ' -or $c.NotBefore.ToUniversalTime() -gt $nowUtc'; Repl = '' }
    'no-notafter-clause'      = @{ Fn = 'Get-HmSignerChainRoot'; Find = ' -or $c.NotAfter.ToUniversalTime() -lt $nowUtc'; Repl = '' }
    'window-fail-open'        = @{ Fn = 'Test-HmTrustedSigner'; Find = 'if ($anchor.OutOfWindow -ne $false) {'; Repl = 'if ($anchor.OutOfWindow) {' }
    # Пин отпечатка листа (claude-desktop.ps1 держит его выключенным, но включить обязан уметь).
    'no-thumbprint-pin'       = @{ Fn = 'Test-HmTrustedSigner'; Find = 'if ($ExpectedThumbprint -and $ExpectedThumbprint.Trim()) {'; Repl = 'if ($false) {' }
    # Пин O= со значением в кавычках: без снятия обрамления настоящий подписант не проходит, а наивный Trim('"')
    # путает значение с настоящими кавычками со значением без них.
    'no-org-unquote'          = @{ Fn = 'Test-HmTrustedSigner'; Find = '$org = $org.Substring(1, $org.Length - 2).Replace(''""'', ''"'')'; Repl = '$org = $org' }
    'org-trim-quotes'         = @{ Fn = 'Test-HmTrustedSigner'; Find = '$org = $org.Substring(1, $org.Length - 2).Replace(''""'', ''"'')'; Repl = '$org = $org.Trim(''"'')' }
}

# ---- загрузка функций из файла (AST) ---------------------------------------------------------------
$tokens = $null; $perr = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($DeelevPath, [ref]$tokens, [ref]$perr)
if ($perr -and $perr.Count) { throw ('синтаксическая ошибка в ' + $DeelevPath) }
$want = @('Test-HmTrustedSigner', 'Get-HmSignerChainRoot', 'Get-HmMachineRootThumbprints')
$loaded = @{}
foreach ($fnAst in @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ($want -contains $n.Name) }, $true))) {
    $text = $fnAst.Extent.Text
    if ($Mutant) {
        $m = $MUTANTS[$Mutant]
        if (-not $m) { throw ('неизвестный мутант: ' + $Mutant) }
        if ($m.Fn -eq $fnAst.Name) {
            $changed = $text.Replace($m.Find, $m.Repl)
            if ($changed -eq $text) { throw ('МУТАНТ НЕ ПРИМЕНИЛСЯ (' + $Mutant + '): в ' + $fnAst.Name + ' нет текста «' + $m.Find + '»') }
            $text = $changed
        }
    }
    . ([scriptblock]::Create($text))
    $loaded[$fnAst.Name] = $true
}
if (-not $loaded['Test-HmTrustedSigner']) { throw 'Test-HmTrustedSigner не найдена в файле' }
if ($Mutant) {
    $m = $MUTANTS[$Mutant]
    if (-not $loaded[$m.Fn]) { throw ('мутант ' + $Mutant + ' целится в ' + $m.Fn + ', а её нет в файле') }
}

function Write-Case {
    param([string]$Id, [bool]$Pass, [string]$Detail = '')
    $tag = 'FAIL'
    if ($Pass) { $tag = 'PASS' }
    # Пустая строка при провале = функция вернула '' (то есть ДОВЕРИЛА там, где ждали отказ): так и пишем.
    if ((-not $Pass) -and (-not $Detail)) { $Detail = 'функция вернула пустую причину отказа, то есть доверила файлу' }
    Write-Output ("CASE`t{0}`t{1}`t{2}" -f $Id, $tag, ($Detail -replace "[\r\n\t]+", ' '))
}
function Run-Case {
    param([string]$Id, [scriptblock]$Body)
    try { & $Body } catch { Write-Case $Id $false ('исключение: ' + $_.Exception.Message) }
}
function Test-IsEmptyString { param($v) return (($v -is [string]) -and ($v.Length -eq 0)) }
function Test-IsReason { param($v, [string]$Pattern) return (($v -is [string]) -and ($v.Length -gt 0) -and ($v -match $Pattern)) }

# =====================================================================================================
if ($Mode -eq 'hermetic') {
    $haveCr = $true
    try { [void][type]'System.Security.Cryptography.X509Certificates.CertificateRequest' } catch { $haveCr = $false }
    if (-not $haveCr) { Write-Output "SKIP`tCertificateRequest недоступен (нужен .NET Framework 4.7.2+)"; exit 0 }

    function New-Key { return [System.Security.Cryptography.RSA]::Create(2048) }
    function New-Req {
        param([string]$Subject, $Key)
        return New-Object "$X.CertificateRequest" -ArgumentList $Subject, $Key, ([System.Security.Cryptography.HashAlgorithmName]::SHA256), ([System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    }
    $now = [DateTimeOffset]::UtcNow
    function New-TestRoot {
        param([string]$Name, $Key = $null, [int]$NotBeforeDays = -60, [int]$NotAfterDays = 300)
        if (-not $Key) { $Key = New-Key }
        $req = New-Req ('CN=' + $Name + ', O=HM Test') $Key
        $req.CertificateExtensions.Add((New-Object "$X.X509BasicConstraintsExtension" -ArgumentList $true, $false, 0, $true))
        $req.CertificateExtensions.Add((New-Object "$X.X509KeyUsageExtension" -ArgumentList ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign), $true))
        return $req.CreateSelfSigned($now.AddDays($NotBeforeDays), $now.AddDays($NotAfterDays))
    }
    # Промежуточный УЦ под корнем $Issuer (у корня есть закрытый ключ). Срок задаётся днями от «сейчас».
    function New-TestCa {
        param($Issuer, $Key, [string]$Name, [int]$NotBeforeDays, [int]$NotAfterDays)
        $req = New-Req ('CN=' + $Name + ', O=HM Test') $Key
        $req.CertificateExtensions.Add((New-Object "$X.X509BasicConstraintsExtension" -ArgumentList $true, $false, 0, $true))
        $req.CertificateExtensions.Add((New-Object "$X.X509KeyUsageExtension" -ArgumentList ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign), $true))
        $serial = [byte[]](1..8 | ForEach-Object { Get-Random -Minimum 1 -Maximum 255 })
        return $req.Create($Issuer, $now.AddDays($NotBeforeDays), $now.AddDays($NotAfterDays), $serial)
    }
    # -IssuerKey: лист подписывается по КЛЮЧУ издателя через X509SignatureGenerator, и срок листа не обязан
    # лежать внутри срока издателя (штатный Create(issuer) за его пределами отказывает). $Root в этом случае
    # нужен только ради имени издателя — закрытого ключа у него может не быть.
    function New-TestLeaf {
        param($Root, [string]$Subject, [int]$NotAfterDays, [string]$Eku = '1.3.6.1.5.5.7.3.3', [int]$NotBeforeDays = -30, $IssuerKey = $null)
        $req = New-Req $Subject $script:LeafKey
        $req.CertificateExtensions.Add((New-Object "$X.X509BasicConstraintsExtension" -ArgumentList $false, $false, 0, $true))
        $req.CertificateExtensions.Add((New-Object "$X.X509KeyUsageExtension" -ArgumentList ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature), $true))
        if ($Eku) {
            $oids = New-Object System.Security.Cryptography.OidCollection
            [void]$oids.Add((New-Object System.Security.Cryptography.Oid($Eku)))
            $req.CertificateExtensions.Add((New-Object "$X.X509EnhancedKeyUsageExtension" -ArgumentList $oids, $true))
        }
        $serial = [byte[]](1..8 | ForEach-Object { Get-Random -Minimum 1 -Maximum 255 })
        if ($IssuerKey) {
            $gen = [System.Security.Cryptography.X509Certificates.X509SignatureGenerator]::CreateForRSA($IssuerKey, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
            return $req.Create($Root.SubjectName, $gen, $now.AddDays($NotBeforeDays), $now.AddDays($NotAfterDays), $serial)
        }
        return $req.Create($Root, $now.AddDays($NotBeforeDays), $now.AddDays($NotAfterDays), $serial)
    }

    $script:LeafKey = New-Key   # один ключ на все тестовые листья: генерация RSA — самое долгое место прогона
    $rootA = New-TestRoot 'HM Test Root A'
    $rootB = New-TestRoot 'HM Test Root B'
    $SUBJ = 'CN=Test Publisher Ltd, O=Test Publisher Ltd'
    $leafExpired = New-TestLeaf $rootA $SUBJ -10
    $leafValid = New-TestLeaf $rootA $SUBJ 20
    $leafWrongEku = New-TestLeaf $rootA $SUBJ -10 '1.3.6.1.5.5.7.3.2'
    $leafNoEku = New-TestLeaf $rootA $SUBJ -10 ''
    $leafForeign = New-TestLeaf $rootB $SUBJ -10
    $TSA_EKU = '1.3.6.1.5.5.7.3.8'
    $tsaGood = New-TestLeaf $rootA 'CN=Test Time Stamping Authority' 20 $TSA_EKU
    $tsaExpired = New-TestLeaf $rootA 'CN=Test Time Stamping Authority (expired)' -5 $TSA_EKU
    $tsaForeign = New-TestLeaf $rootB 'CN=Rogue Time Stamping Authority' 20 $TSA_EKU
    $tsaWrongEku = New-TestLeaf $rootA 'CN=Not A Time Stamping Authority' 20 '1.3.6.1.5.5.7.3.3'
    # Звено вне срока при ГОДНОМ листе (и лист, ещё не вступивший в силу): S-11, находка ревью.
    $caExpiredKey = New-Key
    $caExpired = New-TestCa -Issuer $rootA -Key $caExpiredKey -Name 'HM Test Intermediate Expired' -NotBeforeDays -50 -NotAfterDays -5
    $leafUnderExpiredCa = New-TestLeaf $caExpired $SUBJ 20 -IssuerKey $caExpiredKey
    $caValidKey = New-Key
    $caValid = New-TestCa -Issuer $rootA -Key $caValidKey -Name 'HM Test Intermediate Valid' -NotBeforeDays -50 -NotAfterDays 200
    $leafUnderValidCa = New-TestLeaf $caValid $SUBJ 20 -IssuerKey $caValidKey
    $rootExpiredKey = New-Key
    $rootExpired = New-TestRoot 'HM Test Root Expired' -Key $rootExpiredKey -NotBeforeDays -400 -NotAfterDays -10
    $leafUnderExpiredRoot = New-TestLeaf $rootExpired $SUBJ 20 -IssuerKey $rootExpiredKey
    $leafNotYetValid = New-TestLeaf $rootA $SUBJ 30 -NotBeforeDays 5
    # O= со значением, которое .NET берёт в кавычки (запятая): реальный подписант Anthropic выглядит именно так.
    # Во втором листе кавычки — часть самого значения (в DN они удвоены): с обрамлением их путать нельзя.
    $leafOrgComma = New-TestLeaf $rootA 'CN=Test Publisher Ltd, O="Test Publisher, Ltd"' 20
    $leafOrgQuotes = New-TestLeaf $rootA 'CN=Test Publisher Ltd, O="""Test Publisher, Ltd"""' 20

    # ---- подмены: подпись, машинные корни, построение цепочки ----------------------------------------
    $script:Canned = @{}
    $script:SigThrows = $false
    function Get-AuthenticodeSignature {
        param([string]$LiteralPath)
        if ($script:SigThrows) { throw 'имитация: подпись не читается' }
        return $script:Canned[$LiteralPath]
    }
    $script:MachineRoots = @($rootA.Thumbprint)
    $script:MachineThrows = $false
    function Get-HmMachineRootThumbprints {
        if ($script:MachineThrows) { throw 'имитация: стор корней недоступен' }
        return $script:MachineRoots
    }
    # Цепочку строит НАСТОЯЩАЯ функция (мутант её не обходит): тест лишь сообщает движку, что корень A —
    # «известный» (ExtraStore + AllowUnknownCertificateAuthority), потому что в настоящий стор мы не пишем.
    $script:ChainCalls = 0
    $script:ExtraCerts = @($rootA, $rootB, $caExpired, $caValid, $rootExpired)
    $script:StripWindow = $false   # true: «помощник не сообщил про срок звеньев» (проверка отказа в сторону строгости)
    $origChain = $null
    if ($loaded['Get-HmSignerChainRoot']) { $origChain = (Get-Command Get-HmSignerChainRoot -CommandType Function).ScriptBlock }
    function Get-HmSignerChainRoot {
        param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert, [string]$Eku = '1.3.6.1.5.5.7.3.3')
        $script:ChainCalls++
        if (-not $origChain) { throw 'в проверяемом файле нет Get-HmSignerChainRoot' }
        $r = (& $origChain -Cert $Cert -Eku $Eku -ExtraCerts $script:ExtraCerts -ExtraFlags ([System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority))
        if ($script:StripWindow -and $r) { return [pscustomobject]@{ Root = $r.Root; Why = $r.Why } }
        return $r
    }

    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('hm-signer-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $file = Join-Path $dir 'installer.exe'
    [System.IO.File]::WriteAllBytes($file, [byte[]](77, 90, 0, 0))
    function Set-Sig { param([string]$Status, $Cert, $Tsa = $tsaGood) $script:Canned[$file] = [pscustomobject]@{ Status = $Status; SignerCertificate = $Cert; TimeStamperCertificate = $Tsa } }
    # Пины передаются ТОЛЬКО когда заданы: тот же стенд исполняется и против функции без параметра
    # -ExpectedThumbprint (воспроизведение дефекта на старом коде), и случаи про срок не падают на привязке
    # параметров, скрывая настоящую причину красного.
    function Invoke-Signer {
        param([string]$Org = '', [string]$Subj = '', [string]$Thumb = '')
        $a = @{ Path = $file; ExpectedOrg = $Org; ExpectedSubjectMatch = $Subj }
        if ($Thumb) { $a['ExpectedThumbprint'] = $Thumb }
        return (Test-HmTrustedSigner @a)
    }

    try {
        # --- ядро S-11: подпись Valid (по метке времени), лист просрочен -> доверяем ---------------------
        Run-Case 'expired-leaf-valid-status-trusted' {
            Set-Sig 'Valid' $leafExpired; $script:ChainCalls = 0
            $w = Invoke-Signer
            Write-Case 'expired-leaf-valid-status-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        Run-Case 'unexpired-leaf-valid-status-trusted' {
            Set-Sig 'Valid' $leafValid
            $w = Invoke-Signer
            Write-Case 'unexpired-leaf-valid-status-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        # --- любой статус, кроме Valid, отвергается ДО построения цепочки --------------------------------
        foreach ($st in @('NotSigned', 'HashMismatch', 'UnknownError', 'NotTrusted', 'NotTimeValid', 'Incompatible', 'NotSupportedFileFormat')) {
            Run-Case ('status-' + $st + '-rejected') {
                Set-Sig $st $leafExpired; $script:ChainCalls = 0
                $w = Invoke-Signer
                $good = (Test-IsReason $w 'Status=') -and ($script:ChainCalls -eq 0)
                Write-Case ('status-' + $st + '-rejected') $good ([string]$w + ' | chainCalls=' + $script:ChainCalls)
            }
        }
        # --- привязка к МАШИННОМУ корню ЛИСТА: Valid, но корень цепочки не в LocalMachine\Root --------------
        # Лист годный (непросроченный), чтобы проверка метки времени (b2) не заслоняла проверку корня листа:
        # у просроченного листа отказал бы и TSA, и мутант «снята привязка листа» остался бы незамеченным.
        Run-Case 'root-not-in-machine-store-rejected' {
            Set-Sig 'Valid' $leafValid
            $save = $script:MachineRoots; $script:MachineRoots = @('0000000000000000000000000000000000000000')
            try { $w = Invoke-Signer } finally { $script:MachineRoots = $save }
            Write-Case 'root-not-in-machine-store-rejected' (Test-IsReason $w 'корень цепочки НЕ в LocalMachine') ([string]$w)
        }
        Run-Case 'empty-machine-store-rejected' {
            Set-Sig 'Valid' $leafValid
            $save = $script:MachineRoots; $script:MachineRoots = @()
            try { $w = Invoke-Signer } finally { $script:MachineRoots = $save }
            Write-Case 'empty-machine-store-rejected' (Test-IsReason $w 'корень цепочки НЕ в LocalMachine') ([string]$w)
        }
        Run-Case 'machine-store-unreadable-rejected' {
            Set-Sig 'Valid' $leafExpired
            $script:MachineThrows = $true
            try { $w = Invoke-Signer } finally { $script:MachineThrows = $false }
            Write-Case 'machine-store-unreadable-rejected' (Test-IsReason $w 'стор') ([string]$w)
        }
        Run-Case 'foreign-root-rejected' {
            Set-Sig 'Valid' $leafForeign
            $w = Invoke-Signer
            Write-Case 'foreign-root-rejected' (Test-IsReason $w '.') ([string]$w)
        }
        # --- EKU Code Signing ----------------------------------------------------------------------------
        Run-Case 'wrong-eku-rejected' {
            Set-Sig 'Valid' $leafWrongEku
            $w = Invoke-Signer
            Write-Case 'wrong-eku-rejected' (Test-IsReason $w '.') ([string]$w)
        }
        Run-Case 'no-eku-extension-rejected' {
            Set-Sig 'Valid' $leafNoEku
            $w = Invoke-Signer
            Write-Case 'no-eku-extension-rejected' (Test-IsReason $w 'EKU') ([string]$w)
        }
        # --- пины издателя --------------------------------------------------------------------------------
        Run-Case 'subject-pin-wrong-rejected' {
            Set-Sig 'Valid' $leafExpired
            $w = Invoke-Signer -Subj 'Some Other Publisher'
            Write-Case 'subject-pin-wrong-rejected' (Test-IsReason $w 'Subject') ([string]$w)
        }
        Run-Case 'subject-pin-right-trusted' {
            Set-Sig 'Valid' $leafExpired
            $w = Invoke-Signer -Subj 'Test Publisher Ltd'
            Write-Case 'subject-pin-right-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        Run-Case 'org-pin-wrong-rejected' {
            Set-Sig 'Valid' $leafExpired
            $w = Invoke-Signer -Org 'Some Other Publisher'
            Write-Case 'org-pin-wrong-rejected' (Test-IsReason $w 'Organization') ([string]$w)
        }
        Run-Case 'org-pin-right-trusted' {
            Set-Sig 'Valid' $leafExpired
            $w = Invoke-Signer -Org 'Test Publisher Ltd'
            Write-Case 'org-pin-right-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        # --- O= со значением в кавычках: пин сравнивает значение, а не обрамление ---------------------------------
        # Раньше «Anthropic, PBC» не совпадало с O="Anthropic, PBC" никогда, и пин молча отказывал настоящему подписанту.
        Run-Case 'org-pin-quoted-comma-right-trusted' {
            Set-Sig 'Valid' $leafOrgComma
            $w = Invoke-Signer -Org 'Test Publisher, Ltd'
            Write-Case 'org-pin-quoted-comma-right-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        Run-Case 'org-pin-quoted-comma-prefix-rejected' {
            Set-Sig 'Valid' $leafOrgComma
            $w = Invoke-Signer -Org 'Test Publisher'
            Write-Case 'org-pin-quoted-comma-prefix-rejected' (Test-IsReason $w 'Organization') ([string]$w)
        }
        Run-Case 'org-pin-literal-quotes-not-confused-with-framing' {
            Set-Sig 'Valid' $leafOrgQuotes
            $w1 = Invoke-Signer -Org 'Test Publisher, Ltd'
            $w2 = Invoke-Signer -Org '"Test Publisher, Ltd"'
            Write-Case 'org-pin-literal-quotes-not-confused-with-framing' ((Test-IsReason $w1 'Organization') -and (Test-IsEmptyString $w2)) ('без кавычек=[' + $w1 + '] с кавычками=[' + $w2 + ']')
        }
        # --- пин отпечатка листа (claude-desktop.ps1: $LEAF_THUMBPRINT) -------------------------------------------
        Run-Case 'thumbprint-pin-right-trusted' {
            Set-Sig 'Valid' $leafExpired
            $w = Invoke-Signer -Thumb $leafExpired.Thumbprint
            Write-Case 'thumbprint-pin-right-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        Run-Case 'thumbprint-pin-formatted-trusted' {
            # Регистр, пробелы и двоеточия (так отпечаток показывает диалог свойств) значения не имеют.
            Set-Sig 'Valid' $leafExpired
            $fmt = (($leafExpired.Thumbprint.ToLowerInvariant() -replace '(..)', '$1 ')).Trim()
            $w = Invoke-Signer -Thumb $fmt
            Write-Case 'thumbprint-pin-formatted-trusted' (Test-IsEmptyString $w) ([string]$w + ' | пин=[' + $fmt + ']')
        }
        Run-Case 'thumbprint-pin-wrong-rejected' {
            Set-Sig 'Valid' $leafExpired
            $w = Invoke-Signer -Thumb $leafValid.Thumbprint
            Write-Case 'thumbprint-pin-wrong-rejected' (Test-IsReason $w 'отпечаток') ([string]$w)
        }
        Run-Case 'thumbprint-pin-without-hex-digits-rejected' {
            Set-Sig 'Valid' $leafExpired
            $w = Invoke-Signer -Thumb 'zzzz-not-a-thumbprint'
            Write-Case 'thumbprint-pin-without-hex-digits-rejected' (Test-IsReason $w 'отпечаток') ([string]$w)
        }
        # --- метка времени: просроченный лист верим ТОЛЬКО метке от TSA, которому доверяет машина ----------------
        Run-Case 'expired-leaf-expired-tsa-certificate-trusted' {
            Set-Sig 'Valid' $leafExpired $tsaExpired
            $w = Invoke-Signer
            Write-Case 'expired-leaf-expired-tsa-certificate-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        Run-Case 'expired-leaf-without-timestamp-rejected' {
            Set-Sig 'Valid' $leafExpired $null
            $w = Invoke-Signer
            Write-Case 'expired-leaf-without-timestamp-rejected' (Test-IsReason $w 'метки времени нет') ([string]$w)
        }
        Run-Case 'expired-leaf-timestamp-root-not-in-machine-store-rejected' {
            # Подпись «датирована» TSA из корня, которого нет в LocalMachine\Root (отравленный CurrentUser\Root): отказ.
            Set-Sig 'Valid' $leafExpired $tsaForeign
            $w = Invoke-Signer
            Write-Case 'expired-leaf-timestamp-root-not-in-machine-store-rejected' (Test-IsReason $w 'корень метки времени НЕ в LocalMachine') ([string]$w)
        }
        Run-Case 'expired-leaf-timestamp-wrong-eku-rejected' {
            Set-Sig 'Valid' $leafExpired $tsaWrongEku
            $w = Invoke-Signer
            Write-Case 'expired-leaf-timestamp-wrong-eku-rejected' (Test-IsReason $w 'метка времени') ([string]$w)
        }
        Run-Case 'unexpired-leaf-needs-no-timestamp-trusted' {
            Set-Sig 'Valid' $leafValid $null
            $w = Invoke-Signer
            Write-Case 'unexpired-leaf-needs-no-timestamp-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        # --- срок ЛЮБОГО звена цепочки, а не только листа (находка ревью по S-11) -------------------------------
        # Лист годен сегодня, но промежуточный УЦ (или корень) уже просрочен. IgnoreNotTimeValid не оценивает срок
        # ни у одного звена, а метка времени требовалась только по датам ЛИСТА: утёкший ключ просроченного УЦ плюс
        # отравленный корень TSA в HKCU проходили гейт. Теперь вне срока любое звено -> метка от машинного TSA.
        Run-Case 'valid-leaf-expired-intermediate-rogue-tsa-rejected' {
            Set-Sig 'Valid' $leafUnderExpiredCa $tsaForeign
            $w = Invoke-Signer
            Write-Case 'valid-leaf-expired-intermediate-rogue-tsa-rejected' (Test-IsReason $w 'корень метки времени НЕ в LocalMachine') ([string]$w)
        }
        Run-Case 'valid-leaf-expired-intermediate-without-timestamp-rejected' {
            Set-Sig 'Valid' $leafUnderExpiredCa $null
            $w = Invoke-Signer
            Write-Case 'valid-leaf-expired-intermediate-without-timestamp-rejected' (Test-IsReason $w 'метки времени нет') ([string]$w)
        }
        Run-Case 'valid-leaf-expired-intermediate-machine-tsa-trusted' {
            Set-Sig 'Valid' $leafUnderExpiredCa $tsaGood
            $w = Invoke-Signer
            Write-Case 'valid-leaf-expired-intermediate-machine-tsa-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        Run-Case 'valid-leaf-expired-root-rogue-tsa-rejected' {
            Set-Sig 'Valid' $leafUnderExpiredRoot $tsaForeign
            $save = $script:MachineRoots; $script:MachineRoots = @($rootA.Thumbprint, $rootExpired.Thumbprint)
            try { $w = Invoke-Signer } finally { $script:MachineRoots = $save }
            Write-Case 'valid-leaf-expired-root-rogue-tsa-rejected' (Test-IsReason $w 'корень метки времени НЕ в LocalMachine') ([string]$w)
        }
        Run-Case 'valid-leaf-expired-root-machine-tsa-trusted' {
            Set-Sig 'Valid' $leafUnderExpiredRoot $tsaGood
            $save = $script:MachineRoots; $script:MachineRoots = @($rootA.Thumbprint, $rootExpired.Thumbprint)
            try { $w = Invoke-Signer } finally { $script:MachineRoots = $save }
            Write-Case 'valid-leaf-expired-root-machine-tsa-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        Run-Case 'valid-chain-with-valid-intermediate-needs-no-timestamp-trusted' {
            # Контроль от перестраховки: целая цепочка из трёх звеньев метку времени не требует (поведение прежнее).
            Set-Sig 'Valid' $leafUnderValidCa $null
            $w = Invoke-Signer
            Write-Case 'valid-chain-with-valid-intermediate-needs-no-timestamp-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        # --- лист, ещё не вступивший в силу (часы пользователя отстают или лист датирован задним числом) ----------
        Run-Case 'not-yet-valid-leaf-rogue-tsa-rejected' {
            Set-Sig 'Valid' $leafNotYetValid $tsaForeign
            $w = Invoke-Signer
            Write-Case 'not-yet-valid-leaf-rogue-tsa-rejected' (Test-IsReason $w 'корень метки времени НЕ в LocalMachine') ([string]$w)
        }
        Run-Case 'not-yet-valid-leaf-without-timestamp-rejected' {
            Set-Sig 'Valid' $leafNotYetValid $null
            $w = Invoke-Signer
            Write-Case 'not-yet-valid-leaf-without-timestamp-rejected' (Test-IsReason $w 'метки времени нет') ([string]$w)
        }
        Run-Case 'not-yet-valid-leaf-machine-tsa-trusted' {
            Set-Sig 'Valid' $leafNotYetValid $tsaGood
            $w = Invoke-Signer
            Write-Case 'not-yet-valid-leaf-machine-tsa-trusted' (Test-IsEmptyString $w) ([string]$w)
        }
        # --- помощник цепочки не сообщил про срок звеньев: считаем «вне срока», а не «в сроке» ----------------------
        Run-Case 'window-unknown-fails-closed' {
            Set-Sig 'Valid' $leafValid $tsaForeign
            $script:StripWindow = $true
            try { $w = Invoke-Signer } finally { $script:StripWindow = $false }
            Write-Case 'window-unknown-fails-closed' (Test-IsReason $w 'корень метки времени НЕ в LocalMachine') ([string]$w)
        }
        # --- краевые случаи -------------------------------------------------------------------------------
        Run-Case 'no-signer-certificate-rejected' {
            Set-Sig 'Valid' $null
            $w = Invoke-Signer
            Write-Case 'no-signer-certificate-rejected' (Test-IsReason $w '.') ([string]$w)
        }
        Run-Case 'signature-unreadable-rejected' {
            $script:SigThrows = $true
            try { $w = Invoke-Signer } finally { $script:SigThrows = $false }
            Write-Case 'signature-unreadable-rejected' (Test-IsReason $w '.') ([string]$w)
        }
        Run-Case 'missing-file-rejected' {
            $w = Test-HmTrustedSigner -Path (Join-Path $dir 'нет-такого-файла.exe')
            Write-Case 'missing-file-rejected' (Test-IsReason $w '.') ([string]$w)
        }
        # --- сама цепочка (настоящий движок X509Chain), без подмены Get-AuthenticodeSignature ------------
        if ($origChain) {
            Run-Case 'chain-helper-expired-leaf-builds-to-root' {
                $r = & $origChain -Cert $leafExpired -ExtraCerts @($rootA) -ExtraFlags ([System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority)
                $good = ($r.Why -eq '') -and ($r.Root -and $r.Root.Thumbprint -eq $rootA.Thumbprint)
                Write-Case 'chain-helper-expired-leaf-builds-to-root' $good ([string]$r.Why)
            }
            Run-Case 'chain-helper-window-flags-every-element' {
                # Сам помощник: OutOfWindow = «вне срока хотя бы одно звено» (лист, промежуточный УЦ, корень).
                $all = @($rootA, $rootB, $caExpired, $caValid, $rootExpired)
                $aflag = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
                $expect = [ordered]@{
                    'leaf-valid'                = @($leafValid, $false)
                    'valid-chain-with-valid-ca' = @($leafUnderValidCa, $false)
                    'leaf-expired'              = @($leafExpired, $true)
                    'leaf-not-yet-valid'        = @($leafNotYetValid, $true)
                    'expired-intermediate'      = @($leafUnderExpiredCa, $true)
                    'expired-root'              = @($leafUnderExpiredRoot, $true)
                }
                $bad = New-Object System.Collections.Generic.List[string]
                foreach ($k in $expect.Keys) {
                    $r = & $origChain -Cert $expect[$k][0] -ExtraCerts $all -ExtraFlags $aflag
                    if ($r.Why -ne '' -or $r.OutOfWindow -ne $expect[$k][1]) { $bad.Add($k + ' (Why=' + $r.Why + '; OutOfWindow=' + $r.OutOfWindow + ')') }
                }
                Write-Case 'chain-helper-window-flags-every-element' ($bad.Count -eq 0) ($bad -join '; ')
            }
            Run-Case 'chain-helper-production-flags-trust-nothing-extra' {
                # Боевой вызов (без -ExtraCerts/-ExtraFlags): тестовый корень движку не известен -> цепочка не строится.
                $r = & $origChain -Cert $leafExpired
                Write-Case 'chain-helper-production-flags-trust-nothing-extra' (($r.Why -is [string]) -and ($r.Why.Length -gt 0) -and (-not $r.Root)) ([string]$r.Why)
            }
        }
    } finally {
        try { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
    exit 0
}

# =====================================================================================================
if ($Mode -eq 'real') {
    # Настоящие файлы, настоящий Get-AuthenticodeSignature, настоящий X509Chain. Ничего не запускаем и не пишем.
    # Сначала вшитые установщики (если каталог дан): именно на них дело и сломалось, а python-setup.exe
    # нужен ещё и для проверки пина, который реально передаёт pydeps.ps1. Потом системные exe Windows —
    # они есть на любой машине, и образец с просроченным листом находится среди них почти всегда.
    $cands = New-Object System.Collections.Generic.List[string]
    if ($VendorDir -and (Test-Path -LiteralPath $VendorDir)) {
        foreach ($rel in @('python-setup.exe', 'uv\uvx.exe', 'handy-setup.exe', 'uv\uv.exe', 'node-lts.msi', 'git-setup.exe')) {
            $p = Join-Path $VendorDir $rel
            if (Test-Path -LiteralPath $p) { $cands.Add($p) }
        }
    }
    $sysRoot = $env:SystemRoot
    if (-not $sysRoot) { $sysRoot = 'C:\Windows' }
    foreach ($n in @('attrib.exe', 'choice.exe', 'clip.exe', 'comp.exe', 'at.exe', 'cliconfg.exe', 'where.exe', 'find.exe', 'hostname.exe', 'whoami.exe')) {
        $p = Join-Path (Join-Path $sysRoot 'System32') $n
        if (Test-Path -LiteralPath $p) { $cands.Add($p) }
    }
    $expiredSamples = 0
    $nowLocal = Get-Date
    foreach ($p in $cands) {
        $sig = Get-AuthenticodeSignature -LiteralPath $p
        if ($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate) { continue }
        if (-not ($sig.SignerCertificate.NotAfter -lt $nowLocal)) { continue }
        if ($expiredSamples -ge 5) { break }
        $expiredSamples++
        $name = [System.IO.Path]::GetFileName($p)
        $w = Test-HmTrustedSigner -Path $p
        Write-Case ('real-expired-leaf-' + $name + '-trusted') (Test-IsEmptyString $w) ([string]$w)
        $w2 = Test-HmTrustedSigner -Path $p -ExpectedSubjectMatch 'Definitely Not The Publisher XYZ'
        Write-Case ('real-expired-leaf-' + $name + '-wrong-pin-rejected') (Test-IsReason $w2 'Subject') ([string]$w2)
        if ($name -eq 'python-setup.exe') {
            # Пин, который РЕАЛЬНО передаёт pydeps.ps1 (онлайн-фолбэк Python): обязан совпасть с настоящим подписантом.
            $w3 = Test-HmTrustedSigner -Path $p -ExpectedSubjectMatch 'Python Software Foundation'
            Write-Case 'real-python-setup-pydeps-pin-matches-signer' (Test-IsEmptyString $w3) ([string]$w3)
        }
        # Отпечаток листа: свой — принимается, чужой — нет (пин, который claude-desktop.ps1 держит выключенным).
        $wt1 = Test-HmTrustedSigner -Path $p -ExpectedThumbprint $sig.SignerCertificate.Thumbprint
        Write-Case ('real-expired-leaf-' + $name + '-thumbprint-pin-trusted') (Test-IsEmptyString $wt1) ([string]$wt1)
        $wt2 = Test-HmTrustedSigner -Path $p -ExpectedThumbprint ('0' * 40)
        Write-Case ('real-expired-leaf-' + $name + '-wrong-thumbprint-pin-rejected') (Test-IsReason $wt2 'отпечаток') ([string]$wt2)
        if ($sig.SignerCertificate.Subject -match '(^|, )O=Microsoft Corporation(,|$)') {
            # Пин, который РЕАЛЬНО передаёт chatgpt-desktop.ps1 для winget.exe (тот же издатель, O=Microsoft Corporation):
            # у системного exe с просроченным листом он обязан совпасть, а чужое имя — нет.
            $wm1 = Test-HmTrustedSigner -Path $p -ExpectedOrg 'Microsoft Corporation'
            Write-Case ('real-expired-leaf-' + $name + '-chatgpt-desktop-org-pin-trusted') (Test-IsEmptyString $wm1) ([string]$wm1)
            $wm2 = Test-HmTrustedSigner -Path $p -ExpectedOrg 'Microsoft Corporation Evil'
            Write-Case ('real-expired-leaf-' + $name + '-chatgpt-desktop-org-pin-wrong-rejected') (Test-IsReason $wm2 'Organization') ([string]$wm2)
        }
    }
    # Список машинных корней = ровно LocalMachine\Root, а не слияние с CurrentUser\Root (туда пишет любой
    # процесс пользователя без UAC). Корни, которые есть ТОЛЬКО в CurrentUser, в списке быть не должны.
    # Только чтение обоих сторов. Если лишних корней в CurrentUser нет, вторая половина пуста — тогда
    # держит статическая проверка текста функции в test/run-tests.js.
    if ($loaded['Get-HmMachineRootThumbprints']) {
        $mine = @(Get-HmMachineRootThumbprints | ForEach-Object { [string]$_ }) | Sort-Object -Unique
        $lm = @(Get-ChildItem -LiteralPath 'Cert:\LocalMachine\Root' | ForEach-Object { [string]$_.Thumbprint }) | Sort-Object -Unique
        $cu = @(Get-ChildItem -LiteralPath 'Cert:\CurrentUser\Root' | ForEach-Object { [string]$_.Thumbprint }) | Sort-Object -Unique
        $onlyUser = @($cu | Where-Object { $lm -notcontains $_ })
        $leak = @($mine | Where-Object { $onlyUser -contains $_ })
        $same = (($mine -join ',') -eq ($lm -join ','))
        Write-Case 'real-machine-roots-equal-localmachine-root' ($same -and $leak.Count -eq 0) ('machine=' + $lm.Count + ' list=' + $mine.Count + ' onlyInCurrentUser=' + $onlyUser.Count + ' leaked=' + $leak.Count)
    }
    Write-Output ("SAMPLES`t{0}" -f $expiredSamples)
    exit 0
}
throw ('неизвестный режим: ' + $Mode)
