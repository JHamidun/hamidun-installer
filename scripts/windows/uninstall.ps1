# Hamidun uninstaller — Windows.
#
# P0-4 (ownership receipt): удаляет ТОЛЬКО точные абсолютные пути из квитанции
# установки (~/.hamidun-setup/receipts/<id>.json), которые main.js передаёт через
# HM_UNINSTALL_* (newline-joined). НИКАКИХ масок/glob. Нет квитанции → ОТКАЗ
# (мы это не ставили).
#
# P0-5 (path-guard): цель канонизируется РЕАЛЬНЫМ путём ФС — junction/symlink
# разрешаются по ХЭНДЛУ (GetFinalPathNameByHandle), не только GetFullPath;
# двойные слэши схлопывает GetFullPath ДО сравнения; если ЛЮБОЙ предок цели или
# сама цель — reparse point (symlink/junction) → отказ. Защищённый набор
# (~/.claude целиком, credentials, memory, projects, todos…) сверяется и с
# лексическим, и с РАЗРЕШЁННЫМ реальным путём.
#
# P1-7: сбои агрегируются — частичное удаление даёт ненулевой код. Точный
# инвентарь: значения реестра Run (ClaudeMascot/HamidunBridge), PATH-запись uv,
# uv-tool Nomad. Запись манифеста чистит main.js ПОСЛЕ пост-детекции.
$ErrorActionPreference = 'Continue'
$DRY = [bool]$env:HM_DRY_RUN

# P/Invoke: разрешение РЕАЛЬНОГО пути по хэндлу (junction/symlink → финальный путь).
Add-Type -Namespace HmNative -Name PathApi -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr sa, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern uint GetFinalPathNameByHandleW(IntPtr hFile, System.Text.StringBuilder lpszFilePath, uint cchFilePath, uint dwFlags);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(IntPtr hObject);
'@ -ErrorAction SilentlyContinue

# РЕАЛЬНЫЙ путь ФС существующего пути (по хэндлу; FILE_FLAG_BACKUP_SEMANTICS=0x02000000
# позволяет открывать каталоги). $null при сбое → вызывающий отказывает (fail-closed).
function Get-HmRealPath([string]$p) {
    try {
        $h = [HmNative.PathApi]::CreateFileW($p, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
        if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) { return $null }
        try {
            $sb = New-Object System.Text.StringBuilder 4096
            $n = [HmNative.PathApi]::GetFinalPathNameByHandleW($h, $sb, 4096, 0)
            if ($n -eq 0 -or $n -gt 4096) { return $null }
            $s = $sb.ToString()
            if ($s.StartsWith('\\?\UNC\')) { $s = '\\' + $s.Substring(8) }
            elseif ($s.StartsWith('\\?\')) { $s = $s.Substring(4) }
            return $s
        } finally { [void][HmNative.PathApi]::CloseHandle($h) }
    } catch { return $null }
}

# $true → сам путь ЛИБО любой СУЩЕСТВУЮЩИЙ предок — reparse point (junction/symlink).
# Не смогли проверить → $true (fail-closed).
function Test-HmReparseChain([string]$full) {
    try {
        $cur = $full
        while ($cur -and $cur.Length -gt 3) {
            try {
                $it = Get-Item -LiteralPath $cur -Force -ErrorAction Stop
                if ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $true }
            } catch { } # отсутствующий сегмент — идём выше (проверяем существующих предков)
            $parent = [System.IO.Path]::GetDirectoryName($cur)
            if (-not $parent -or $parent -eq $cur) { break }
            $cur = $parent
        }
        return $false
    } catch { return $true }
}

$claudeHome = Join-Path $env:USERPROFILE '.claude'
# Защищённые ПОДДЕРЕВЬЯ: их самих, всё ВНУТРИ них и их ПРЕДКОВ удалять нельзя.
$ProtectedSubtrees = @(
    $claudeHome,
    (Join-Path $claudeHome 'skills'),
    (Join-Path $claudeHome 'memory'),
    (Join-Path $claudeHome 'projects'),
    (Join-Path $claudeHome 'todos'),
    (Join-Path $claudeHome 'shell-snapshots'),
    (Join-Path $claudeHome '.credentials.master.env'),
    (Join-Path $claudeHome '.credentials.json'),
    (Join-Path $claudeHome 'settings.json')
)

# Один путь против защищённого набора (и лексические формы, и resolved-формы).
function Test-HmInProtected([string]$full) {
    $userHome = ([IO.Path]::GetFullPath($env:USERPROFILE)).TrimEnd('\')
    if ($full -ieq $userHome) { return $true }                                              # сам домашний каталог
    if ($userHome.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true } # предок дома (C:\Users)
    foreach ($p in $ProtectedSubtrees) {
        if ([string]::IsNullOrWhiteSpace($p)) { continue }
        $forms = New-Object System.Collections.Generic.List[string]
        $forms.Add(([IO.Path]::GetFullPath($p)).TrimEnd('\'))
        # resolved-форма защищённого корня (если существует) — junction-случаи
        $pr = if (Test-Path -LiteralPath $p) { Get-HmRealPath ([IO.Path]::GetFullPath($p)) } else { $null }
        if ($pr) { $forms.Add($pr.TrimEnd('\')) }
        foreach ($pf in $forms) {
            if ($full -ieq $pf) { return $true }                                            # сам защищённый путь
            if ($full.StartsWith($pf + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true } # внутри защищённого
            if ($pf.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }  # предок защищённого
        }
    }
    return $false
}

# $true → удалять НЕЛЬЗЯ (пользовательские данные / системные корни / подозрительный путь).
function Test-HmProtected([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $true }
    if (-not [IO.Path]::IsPathRooted($path)) { return $true }         # не абсолютный → отказ
    # GetFullPath схлопывает повторные разделители ($HOME\\..\\ и //) ДО сравнения.
    try { $full = ([IO.Path]::GetFullPath($path)).TrimEnd('\') } catch { return $true }
    if ($full.Length -le 3) { return $true }  # корень диска (напр. C:\)
    # P0-5: reparse (symlink/junction) в самой цели или ЛЮБОМ предке → отказ.
    if (Test-Path -LiteralPath $full) {
        if (Test-HmReparseChain $full) { return $true }
    }
    # Лексическая сверка.
    if (Test-HmInProtected $full) { return $true }
    # Канонизация РЕАЛЬНЫМ путём (по хэндлу) — сверяем и resolved-форму.
    if (Test-Path -LiteralPath $full) {
        $real = Get-HmRealPath $full
        if (-not $real) { return $true }                              # не смогли канонизировать → отказ
        $real = $real.TrimEnd('\')
        if (Test-HmInProtected $real) { return $true }
    }
    return $false
}

$script:Failed = 0

# Возврат: $true = удалено/нечего удалять; $false = отказ guard-а или сбой удаления.
function Remove-HmArtifact([string]$path, [string]$label) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $true }
    if (-not (Test-Path -LiteralPath $path)) { Write-Host "  ${label}: нечего удалять ($path)"; return $true }
    if (Test-HmProtected $path) {
        Write-Host "  ЗАЩИТА: отказываюсь удалять «$path» (пользовательские данные / подозрительный путь) — пропускаю."
        return $false
    }
    if ($DRY) { Write-Host "  [dry-run] WOULD remove: $path"; return $true }
    try { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop; Write-Host "  Удалено ($label): $path"; return $true }
    catch { Write-Host "  Не удалось удалить ${path}: $($_.Exception.Message)"; return $false }
}

$id = "$($env:HM_UNINSTALL)".Trim()
if (-not $id) { Write-Host "HM_UNINSTALL не задан — нечего удалять."; exit 1 }
Write-Host "Деинсталляция компонента: $id"

# === P0-4: без квитанции НЕ удаляем (defense-in-depth: main уже проверил receipt) ===
if (-not "$($env:HM_UNINSTALL_PATHS)".Trim() -and -not "$($env:HM_UNINSTALL_REG)".Trim() -and
    -not "$($env:HM_UNINSTALL_PATHENTRIES)".Trim()) {
    Write-Host "ОТКАЗ: нет квитанции установки (receipt) для «$id» — этот установщик его не ставил"
    Write-Host "  (или квитанция утеряна). Ничего не удаляю (fail-closed). Удали вручную, если уверен."
    exit 3
}

function Split-HmLines([string]$s) {
    if (-not $s) { return @() }
    return @([regex]::Split($s, '\r?\n') | Where-Object { $_ -and $_.Trim() })
}

# --- 1) Точные пути ФС из квитанции ---
foreach ($p in (Split-HmLines $env:HM_UNINSTALL_PATHS)) {
    if (-not (Remove-HmArtifact $p.Trim() "артефакт ($id)")) { $script:Failed = 1 }
}

# --- 2) Значения реестра из квитанции ('HKCU|Key\Path|ValueName') — ТОЛЬКО HKCU ---
foreach ($r in (Split-HmLines $env:HM_UNINSTALL_REG)) {
    $parts = $r.Trim() -split '\|'
    if ($parts.Count -ne 3 -or $parts[0].ToUpper() -ne 'HKCU' -or -not $parts[1] -or -not $parts[2]) {
        Write-Host "  ЗАЩИТА: некорректная/не-HKCU запись реестра в квитанции «$r» — пропускаю (fail-closed)."
        $script:Failed = 1; continue
    }
    $regPath = 'HKCU:\' + $parts[1]
    $valName = $parts[2]
    if ($DRY) { Write-Host "  [dry-run] WOULD remove registry: $regPath -> $valName"; continue }
    try {
        if (Get-ItemProperty -Path $regPath -Name $valName -ErrorAction SilentlyContinue) {
            Remove-ItemProperty -Path $regPath -Name $valName -ErrorAction Stop
            Write-Host "  Удалено (реестр): $regPath -> $valName"
        } else {
            Write-Host "  Реестр: нечего удалять ($regPath -> $valName)"
        }
    } catch { Write-Host "  Не удалось удалить значение реестра ${valName}: $($_.Exception.Message)"; $script:Failed = 1 }
}

# --- 3) PATH-записи из квитанции: убрать ТОЧНО совпадающий каталог из User PATH ---
foreach ($pe in (Split-HmLines $env:HM_UNINSTALL_PATHENTRIES)) {
    $dir = $pe.Trim().TrimEnd('\')
    if (-not $dir) { continue }
    if ($DRY) { Write-Host "  [dry-run] WOULD: убрать «$dir» из пользовательского PATH"; continue }
    try {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($null -eq $userPath) { $userPath = '' }
        $kept = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $dir) })
        if (($userPath -split ';' | Where-Object { $_ }).Count -ne $kept.Count) {
            [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
            Write-Host "  Убрал «$dir» из пользовательского PATH."
        } else {
            Write-Host "  PATH: записи «$dir» нет — нечего убирать."
        }
    } catch { Write-Host "  Не удалось обновить PATH: $($_.Exception.Message)"; $script:Failed = 1 }
}

# --- 4) Компонент-специфичный инвентарь: Nomad = uv tool uninstall (среда uv) ---
if ($id -eq 'nomad') {
    $uvExe = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (-not (Test-Path -LiteralPath $uvExe)) { $uvExe = Join-Path $env:LOCALAPPDATA 'Programs\uv\uv.exe' }
    if (Test-Path -LiteralPath $uvExe) {
        if ($DRY) { Write-Host "  [dry-run] WOULD: $uvExe tool uninstall nomad" }
        else {
            try { & $uvExe tool uninstall nomad 2>&1 | Out-Null; Write-Host "  uv tool uninstall nomad — выполнено." } catch { }
        }
    }
    Write-Host "Примечание: uv и Python НЕ удаляю (могут быть нужны другим инструментам)."
}
switch ($id) {
    'course' { Write-Host "Примечание: наставник курса в ~/.claude и твои данные НЕ тронуты." }
    'mascot' { Write-Host "Примечание: хуки в ~/.claude/settings.json НЕ трогаю (там могут быть твои правки)." }
}

if ($script:Failed -ne 0) {
    Write-Host "Деинсталляция «$id» завершена ЧАСТИЧНО — часть артефактов не удалена (см. выше)."
    exit 1
}
exit 0
