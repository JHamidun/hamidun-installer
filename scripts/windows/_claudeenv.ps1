# _claudeenv.ps1 — ПОЛЬЗОВАТЕЛЬСКИЕ починки для установленного claude: политика выполнения
# PowerShell, PATH, вердикты в ~/.hamidun-setup/checks.json.
# Дот-сорсится из claude.ps1 (сразу после установки) и из verify.ps1 (на КАЖДОМ прогоне,
# даже если у компонента claude снята галочка — см. там). Библиотека: кода верхнего уровня
# и своего exit нет. Всё здесь — только чтение/запись HKCU и файлов в профиле пользователя;
# сам claude (user-writable бинарь) под администратором не запускается: проба из PowerShell
# идёт только через Invoke-HmDeElevatedSafe (его даёт _deelev.ps1, подключает вызывающий).
. (Join-Path $PSScriptRoot '_userpath.ps1')   # Add-HmUserPath, Test-HmIsReparse

# Вердикт запуском пишем в ~/.hamidun-setup/checks.json — финальный чек-лист
# (verify.ps1) обязан ПЕРЕНЕСТИ его, а не выводить заново по наличию файла.
# Один факт «claude работает» — один стандарт доказательства.
# Каталог ~/.hamidun-setup — ссылка (junction): писать «сквозь» неё под администратором нельзя
# (процесс обычного пользователя подменил бы каталог ссылкой на системный) — тихо пропускаем,
# диагностика не должна ломать установку.
function Write-HmCheck($name, $verdict) {
    try {
        $dir = Join-Path $env:USERPROFILE '.hamidun-setup'
        if (Test-HmIsReparse $dir) { return }
        New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue | Out-Null
        $file = Join-Path $dir 'checks.json'
        # $null, а не @{}: пустая хеш-таблица в условии «истинна», и её служебные свойства (Count,
        # Keys, Values…) попадали в checks.json отдельными записями при самой первой записи файла.
        $data = $null
        if (Test-Path -LiteralPath $file) {
            try { $data = (Get-Content -Raw -LiteralPath $file | ConvertFrom-Json) } catch { $data = New-Object psobject }
        }
        $entry = @{ verdict = $verdict; at = [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds }
        # atomic: temp + move (как маркеры/квитанции)
        $obj = @{}
        if ($data) { foreach ($p in $data.PSObject.Properties) { $obj[$p.Name] = $p.Value } }
        $obj[$name] = $entry
        $tmp = "$file.tmp"
        if ((Test-HmIsReparse $dir) -or (Test-HmIsReparse $tmp) -or (Test-HmIsReparse $file)) { return }
        ($obj | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $file -Force
    } catch { }   # диагностика не должна ломать установку
}

# PowerShell и политика выполнения (ExecutionPolicy). npm кладёт рядом с claude.cmd ещё и
# claude.ps1, а PowerShell — терминал VS Code по умолчанию — из двух одноимённых берёт .ps1.
# На клиентской Windows политика по умолчанию Restricted, и человек видит «Невозможно
# загрузить файл claude.ps1 … выполнение сценариев отключено в этой системе»: claude
# установлен, в cmd работает, а в терминале VS Code — нет. Лечим так, как советует сама
# Microsoft: RemoteSigned в области CurrentUser (свои локальные скрипты можно, скачанные из
# интернета — только подписанные). LocalMachine не трогаем никогда.
# Решение — чистая функция, отдельно от чтения и записи, чтобы проверить его на любой
# комбинации областей. Область Process НЕ учитываем: её задал запуск ЭТОГО скрипта
# (-ExecutionPolicy Bypass), новый терминал человека её не унаследует.
#   none — новый терминал и так запускает локальные скрипты;
#   set  — выставить CurrentUser = RemoteSigned;
#   gpo  — политику задаёт групповая политика: не трогаем, только говорим, что делать;
#   keep — стоит AllSigned (подпись требуют намеренно): ослаблять не нам.
function Get-HmExecPolicyPlan {
    param([string]$MachinePolicy, [string]$UserPolicy, [string]$CurrentUser,
          [string]$LocalMachine, [bool]$IsServer)
    $norm = { param($v) $t = ([string]$v).Trim(); if (-not $t -or $t -eq 'Default') { 'Undefined' } else { $t } }
    $mp = & $norm $MachinePolicy; $up = & $norm $UserPolicy
    $cu = & $norm $CurrentUser;   $lm = & $norm $LocalMachine
    $blocks = @('Restricted', 'AllSigned')
    $gpoScope = ''; $gpoVal = ''
    if ($mp -ne 'Undefined') { $gpoScope = 'MachinePolicy'; $gpoVal = $mp }
    elseif ($up -ne 'Undefined') { $gpoScope = 'UserPolicy'; $gpoVal = $up }
    if ($gpoScope) {
        $act = if ($blocks -contains $gpoVal) { 'gpo' } else { 'none' }
        return [pscustomobject]@{ Action = $act; Effective = $gpoVal; Scope = $gpoScope }
    }
    if ($cu -ne 'Undefined') { $eff = $cu; $scope = 'CurrentUser' }
    elseif ($lm -ne 'Undefined') { $eff = $lm; $scope = 'LocalMachine' }
    else { $scope = 'Default'; $eff = if ($IsServer) { 'RemoteSigned' } else { 'Restricted' } }
    $act = 'none'
    if ($eff -eq 'Restricted') { $act = 'set' } elseif ($eff -eq 'AllSigned') { $act = 'keep' }
    return [pscustomobject]@{ Action = $act; Effective = $eff; Scope = $scope }
}

# Чтение областей + запись по плану. Возвращает 'ok' (локальные скрипты разрешены — были
# или стали), 'blocked' (групповая политика, AllSigned или запись не удалась — человеку
# сказано, что делать) или 'unknown' (политику прочитать не удалось — ничего не меняли).
function Set-HmUserExecPolicy {
    $scopes = @{}
    try { Get-ExecutionPolicy -List -ErrorAction Stop | ForEach-Object { $scopes[[string]$_.Scope] = [string]$_.ExecutionPolicy } }
    catch { Write-Host "  Политику выполнения PowerShell прочитать не удалось ($($_.Exception.Message)) — не меняю."; return 'unknown' }
    $isServer = $false
    try { $isServer = ([int](Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).ProductType -ne 1) } catch { }
    $plan = Get-HmExecPolicyPlan -MachinePolicy $scopes['MachinePolicy'] -UserPolicy $scopes['UserPolicy'] `
        -CurrentUser $scopes['CurrentUser'] -LocalMachine $scopes['LocalMachine'] -IsServer $isServer
    $howTo = "  Пока так: набирай в терминале claude.cmd вместо claude или переключи терминал VS Code на «Command Prompt»."
    if ($plan.Action -eq 'none') { return 'ok' }
    if ($plan.Action -eq 'gpo') {
        Write-Host "PowerShell: политику выполнения задаёт групповая политика ($($plan.Scope) = $($plan.Effective)) — установщик её не меняет, а claude.ps1 она не пустит."
        Write-Host $howTo
        return 'blocked'
    }
    if ($plan.Action -eq 'keep') {
        Write-Host "PowerShell: стоит политика AllSigned ($($plan.Scope)) — её выставили намеренно, ослаблять не буду; claude.ps1 без подписи она не пустит."
        Write-Host $howTo
        return 'blocked'
    }
    # Set-ExecutionPolicy сначала ЗАПИСЫВАЕТ значение, а потом ругается: этот процесс
    # запущен с -ExecutionPolicy Bypass, и область Process «перекрывает» новую настройку.
    # Ругань — про НАШ процесс, не про терминал человека, поэтому истину читаем обратно.
    try { Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force -ErrorAction Stop } catch { }
    $now = ''
    try { $now = [string](Get-ExecutionPolicy -Scope CurrentUser) } catch { }
    if ($now -eq 'RemoteSigned') {
        Write-Host "PowerShell: разрешил запуск своих локальных скриптов для этой учётки (CurrentUser = RemoteSigned) — иначе claude не запускался бы в терминале VS Code."
        Write-Host "  Вернуть как было: Set-ExecutionPolicy -Scope CurrentUser Undefined"
        return 'ok'
    }
    Write-Host "ВНИМАНИЕ: не удалось разрешить PowerShell запуск локальных скриптов (политика осталась $($plan.Effective))."
    Write-Host $howTo
    return 'blocked'
}

# Проба тем же путём, каким claude запустит человек: PowerShell, команда claude из каталога
# установки, политика выполнения — ЕГО (своей проба не задаёт, ради неё всё и затевается).
# Cmd-проба (Test-HmClaudeRuns в claude.ps1) идёт через claude.cmd, и политика её не касается —
# поэтому чек-лист зеленел и там, где в терминале VS Code набранный claude падал. Тело — текст
# для powershell -EncodedCommand. Коды: 0 — claude ответил на --version; 197 — PowerShell
# отказался загрузить claude.ps1 (UnauthorizedAccess, то есть политика); 198 — другой отказ
# запуска; иначе — код возврата самого claude.
function Get-HmPsProbeScript([string]$Dir) {
    $body = @'
  $env:Path = '__DIR__;' + $env:Path
  try {
      $null = & claude --version 2>$null
      $c = $LASTEXITCODE
      if ($null -eq $c) { exit 198 }
      exit $c
  } catch {
      if ([string]$_.FullyQualifiedErrorId -match 'UnauthorizedAccess') { exit 197 }
      exit 198
  }
'@
    return $body.Replace('__DIR__', ($Dir -replace "'", "''"))
}

# 'n/a' — рядом нет claude.ps1 (PowerShell возьмёт .cmd/.exe, политика ни при чём);
# 'works' | 'blocked' | 'broken' — по коду пробы; 'unverified' — де-элевация не отчиталась
# или вернула служебный статус планировщика (то же правило, что в Test-HmClaudeRuns).
function Test-HmClaudeViaPowerShell($bin) {
    if (-not $bin) { return 'n/a' }
    $dir = Split-Path $bin
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'claude.ps1'))) { return 'n/a' }
    $sr = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $psExe = Join-Path $sr 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe)) { return 'unverified' }
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes((Get-HmPsProbeScript $dir)))
    $r = Invoke-HmDeElevatedSafe $psExe @('-NoProfile', '-NonInteractive', '-EncodedCommand', $b64) -Label 'claude-ps-probe' -TimeoutSec 120
    if ($null -eq $r -or $r.Gate -ne 'medium') { return 'unverified' }
    if ($r.Code -eq 0) { return 'works' }
    if ($r.Code -eq 197) { return 'blocked' }
    if ($r.Code -lt 0 -or $r.Code -gt 255) { return 'unverified' }
    return 'broken'
}

# ПОЛЬЗОВАТЕЛЬСКИЕ починки уже установленного claude — одни и те же для claude.ps1 (сразу
# после установки) и verify.ps1 (на каждом прогоне, когда у claude снята галочка):
#   • PATH пользователя: каталог бинаря (обычно %APPDATA%\npm) и ~/.local\bin — ДАЖЕ если его
#     ещё нет: при офлайн-установке через npm его создают позже (шаг Nomad, uv, нативный
#     установщик claude), и раньше он так и не попадал в PATH — «nmd не распознано»;
#   • политика выполнения PowerShell — только если рядом с бинарём лежит claude.ps1
#     (Set-HmUserExecPolicy).
# Возвращает вердикт для checks.json → 'claude-ps' (вызывающий пишет его сам):
#   'n/a' — claude.ps1 рядом нет, политика ни при чём;
#   'blocked' — политику менять нельзя или не вышло: в PowerShell claude не запустится;
#   'works' | 'broken' | 'unverified' — результат пробы из PowerShell. Проба делается ТОЛЬКО
#   с -Probe (вызывающий уже доказал, что claude отвечает, и подключил _deelev.ps1);
#   без неё при разрешённой политике — 'unverified': доказательства нет, красной строки тоже.
function Repair-HmClaudeUserEnv {
    param([Parameter(Mandatory = $true)][string]$Bin, [switch]$Probe)
    [void](Add-HmUserPath (Split-Path $Bin))
    [void](Add-HmUserPath (Join-Path $env:USERPROFILE '.local\bin') -AllowMissing)
    if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $Bin) 'claude.ps1'))) { return 'n/a' }
    $policy = Set-HmUserExecPolicy
    if ($policy -eq 'blocked') { return 'blocked' }
    if ($Probe) { return (Test-HmClaudeViaPowerShell $Bin) }
    return 'unverified'
}
