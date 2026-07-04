# _verify.ps1 — целостность вшитых артефактов (SHA-256 против vendor/checksums.json).
# Дот-сорсится компонент-скриптами. Fail-closed: при любом несовпадении/отсутствии
# манифеста установка ОСТАНАВЛИВАЕТСЯ (exit 1) — вшитый инсталлятор НЕ запускается.
#
# Почему свой SHA-256 на .NET, а не Get-FileHash: модуль Utility в некоторых
# окружениях (electron-builder / урезанный PATH) не подхватывается — тот же приём,
# что и в tools/fetch-vendor.ps1 при генерации манифеста.

function Get-HmFileSha256 {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fs = [IO.File]::OpenRead($Path)
        try { $hb = $sha.ComputeHash($fs) } finally { $fs.Dispose() }
    } finally { $sha.Dispose() }
    return ([BitConverter]::ToString($hb) -replace '-', '').ToLower()
}

# Достаёт { sha256, bytes } для имени файла из checksums.json (regex, без ConvertFrom-Json).
function Get-HmChecksumEntry {
    param([string]$ChkPath, [string]$Name)
    if (-not (Test-Path $ChkPath)) { return $null }
    $raw = [IO.File]::ReadAllText($ChkPath)
    $esc = [regex]::Escape($Name)
    $m = [regex]::Match($raw,
        '"' + $esc + '"\s*:\s*\{[^}]*?"sha256"\s*:\s*"([0-9a-fA-F]{64})"(?:[^}]*?"bytes"\s*:\s*(\d+))?')
    if (-not $m.Success) { return $null }
    return [pscustomobject]@{
        sha256 = $m.Groups[1].Value.ToLower()
        bytes  = if ($m.Groups[2].Success) { [int64]$m.Groups[2].Value } else { $null }
    }
}

# Главный вентиль. Проверяет $Path против vendor/checksums.json ($env:HM_VENDOR).
# Успех -> печатает подтверждение и возвращает управление. Провал -> exit 1 (fail-closed).
# Вызывать ТОЛЬКО для ВШИТЫХ артефактов (vendor/apps/*), НЕ для онлайн-загрузок
# (у них другая версия -> хэш законно не совпадёт).
function Confirm-HmArtifact {
    param([string]$Path)

    $name = [IO.Path]::GetFileName($Path)

    if (-not (Test-Path $Path)) {
        Write-Host "БЕЗОПАСНОСТЬ: файл для проверки не найден ($Path) — установка остановлена."
        exit 1
    }
    if (-not $env:HM_VENDOR) {
        Write-Host "БЕЗОПАСНОСТЬ: не задан HM_VENDOR — невозможно проверить целостность '$name'. Установка остановлена."
        exit 1
    }
    $chk = Join-Path $env:HM_VENDOR 'checksums.json'
    if (-not (Test-Path $chk)) {
        Write-Host "БЕЗОПАСНОСТЬ: манифест целостности не найден ($chk). Отказываюсь запускать вшитый '$name'. Установка остановлена."
        exit 1
    }

    $entry = Get-HmChecksumEntry -ChkPath $chk -Name $name
    if (-not $entry) {
        Write-Host "БЕЗОПАСНОСТЬ: в checksums.json нет записи для '$name' — возможна подмена. Установка остановлена."
        exit 1
    }

    $actual = Get-HmFileSha256 -Path $Path
    if ($actual -ne $entry.sha256) {
        Write-Host "БЕЗОПАСНОСТЬ: НЕ СОВПАЛ SHA-256 для '$name' — файл подменён/повреждён. Установка остановлена."
        Write-Host "  ожидалось: $($entry.sha256)"
        Write-Host "  получено:  $actual"
        exit 1
    }
    if ($null -ne $entry.bytes) {
        $len = (Get-Item $Path).Length
        if ($len -ne $entry.bytes) {
            Write-Host "БЕЗОПАСНОСТЬ: не совпал размер '$name' (ожидалось $($entry.bytes), получено $len). Установка остановлена."
            exit 1
        }
    }
    Write-Host "  Целостность подтверждена (SHA-256): $name"
}

# Нефатальный вариант — для НЕ исполняемых best-effort артефактов (например, шрифт):
# при несовпадении возвращает $false (вызывающий сам решает пропустить), не рушит установку.
function Test-HmArtifact {
    param([string]$Path)
    try {
        if (-not (Test-Path $Path)) { return $false }
        if (-not $env:HM_VENDOR) { return $false }
        $chk = Join-Path $env:HM_VENDOR 'checksums.json'
        $entry = Get-HmChecksumEntry -ChkPath $chk -Name ([IO.Path]::GetFileName($Path))
        if (-not $entry) { return $false }
        return ((Get-HmFileSha256 -Path $Path) -eq $entry.sha256)
    } catch { return $false }
}
