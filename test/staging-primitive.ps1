# staging-primitive.ps1 — прямой тест New-HmSecureStagingDir (Windows).
#
# ЗАЧЕМ ОТДЕЛЬНО ОТ GUI-E2E: сбой примитива в lite-редакции выглядит как «ни один компонент
# не скачался», и полный GUI-прогон тратит на диагностику десятки минут. Здесь проверяется
# ТОЛЬКО примитив, за секунды, и обязательно в ТОМ ЖЕ integrity, в котором работает
# установщик (elevated). Локально (medium) проверяется medium-ветка.
#
# Exit: 0 = PASS, 1 = FAIL. Всё, что примитив пишет в stderr (HMSECFAIL/HMSECNOTE),
# печатается — именно этой диагностики не хватало, когда каталог молча не создавался.

$ErrorActionPreference = 'Stop'
# Русская диагностика примитива не должна превращаться в мусор в логах CI/Git Bash.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $root 'scripts\windows\_deelev.ps1')

$sysRoot = $env:SystemRoot
if (-not $sysRoot) { $sysRoot = 'C:\Windows' }
$whoami = Join-Path $sysRoot 'System32\whoami.exe'
$icacls = Join-Path $sysRoot 'System32\icacls.exe'
$pd     = $env:ProgramData
if (-not $pd) { $pd = 'C:\ProgramData' }

$integrity = Get-HmSelfIntegrity -WhoamiExe $whoami
$elevated  = ($integrity -eq 'high' -or $integrity -eq 'system')
Write-Host ("integrity = {0} -> Elevated={1}" -f $integrity, $elevated)

$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
    if ($ok) { Write-Host ("  [OK]   {0}" -f $name) }
    else {
        Write-Host ("  [FAIL] {0}: {1}" -f $name, $detail)
        $script:fails += $name
    }
}

# stderr примитива ловим отдельным потоком — иначе он тонет и причина сбоя невидима.
$errFile = Join-Path $env:TEMP ("hm-stagetest-" + [guid]::NewGuid().ToString('N') + ".err")
$dir = $null
try {
    $dir = New-HmSecureStagingDir -ProgramData $pd -Icacls $icacls -Elevated $elevated 2>$errFile
} catch {
    Write-Host ("  [FAIL] примитив бросил исключение: " + $_.Exception.Message)
    $fails += 'exception'
}
if (Test-Path -LiteralPath $errFile) {
    $errTxt = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)
    if ($errTxt -and $errTxt.Trim()) { Write-Host "--- stderr примитива ---"; Write-Host $errTxt.Trim() }
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
}

Check 'каталог создан (не $null)' ([bool]$dir) 'примитив вернул $null — докачка в lite не заработает'

if ($dir) {
    Write-Host ("dir = {0}" -f $dir)
    Check 'каталог существует' (Test-Path -LiteralPath $dir) $dir

    $acl = Get-Acl -LiteralPath $dir
    Check 'наследование снято (protection on)' ($acl.AreAccessRulesProtected) 'AreAccessRulesProtected=false — Users могли унаследовать доступ'

    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($elevated) {
        Check 'владелец = Administrators' ($owner -eq 'S-1-5-32-544') ("owner=" + $owner)
    } else {
        Write-Host ("  [--]   владелец (medium, не проверяется) = {0}" -f $owner)
    }

    $allow = @('S-1-5-18', 'S-1-5-32-544')
    if (-not $elevated) { $allow += [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    $foreign = @()
    foreach ($ace in $acl.Access) {
        $sid = $null
        try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
        catch { $sid = [string]$ace.IdentityReference }
        if ($allow -notcontains $sid) { $foreign += $sid }
    }
    Check 'посторонних ACE нет' ($foreign.Count -eq 0) ($foreign -join ', ')

    $attr = (Get-Item -LiteralPath $dir -Force).Attributes
    Check 'не reparse-point' (-not ($attr -band [System.IO.FileAttributes]::ReparsePoint)) ([string]$attr)

    # Каталог обязан быть ЗАПИСЫВАЕМЫМ текущим процессом — иначе загрузка компонента упадёт
    # уже после «успешного» создания (именно это делает сбой неотличимым от сетевого).
    $probe = Join-Path $dir 'probe.bin'
    $wrote = $false
    try { [System.IO.File]::WriteAllBytes($probe, [byte[]](1, 2, 3)); $wrote = (Test-Path -LiteralPath $probe) } catch { }
    Check 'запись в каталог работает' $wrote 'процесс не может писать в собственный staging'

    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    Check 'каталог удаляется' (-not (Test-Path -LiteralPath $dir)) 'остался мусор в ProgramData'
}

if ($fails.Count -gt 0) {
    Write-Host ""
    Write-Host ("STAGING PRIMITIVE: FAIL ({0}): {1}" -f $fails.Count, ($fails -join '; '))
    exit 1
}
Write-Host ""
Write-Host "STAGING PRIMITIVE: PASS"
exit 0
