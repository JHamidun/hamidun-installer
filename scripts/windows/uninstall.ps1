# Hamidun uninstaller — Windows. Удаляет ТОЛЬКО артефакты установщика по ЯВНОМУ id
# ($env:HM_UNINSTALL). ЖЕЛЕЗНО: НИКОГДА не трогает пользовательские данные —
# ~/.claude/.credentials*, memory, projects, todos, shell-snapshots, settings.json и
# пользовательские скиллы защищены жёстким guard'ом (Test-HmProtected / Remove-HmArtifact).
# Запись версии в манифесте чистит main.js (тестируемый JS-модуль) — не этот скрипт.
$ErrorActionPreference = 'Continue'
$DRY = [bool]$env:HM_DRY_RUN

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

# $true → удалять НЕЛЬЗЯ (пользовательские данные / системные корни).
function Test-HmProtected([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $true }
    try { $full = ([IO.Path]::GetFullPath($path)).TrimEnd('\') } catch { return $true }
    if ($full.Length -le 3) { return $true }  # корень диска (напр. C:\)
    $userHome = ([IO.Path]::GetFullPath($env:USERPROFILE)).TrimEnd('\')
    if ($full -ieq $userHome) { return $true }                                              # сам домашний каталог
    if ($userHome.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true } # предок дома (C:\Users)
    foreach ($p in $ProtectedSubtrees) {
        if ([string]::IsNullOrWhiteSpace($p)) { continue }
        $pf = ([IO.Path]::GetFullPath($p)).TrimEnd('\')
        if ($full -ieq $pf) { return $true }                                            # сам защищённый путь
        if ($full.StartsWith($pf + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true } # внутри защищённого
        if ($pf.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }  # предок защищённого
    }
    return $false
}

function Remove-HmArtifact([string]$path, [string]$label) {
    if ([string]::IsNullOrWhiteSpace($path)) { return }
    if (Test-HmProtected $path) {
        Write-Host "  ЗАЩИТА: отказываюсь удалять «$path» (пользовательские данные) — пропускаю."
        return
    }
    if (-not (Test-Path -LiteralPath $path)) { Write-Host "  ${label}: нечего удалять ($path)"; return }
    if ($DRY) { Write-Host "  [dry-run] WOULD remove: $path"; return }
    try { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop; Write-Host "  Удалено ($label): $path" }
    catch { Write-Host "  Не удалось удалить ${path}: $($_.Exception.Message)" }
}

$id = "$($env:HM_UNINSTALL)".Trim()
if (-not $id) { Write-Host "HM_UNINSTALL не задан — нечего удалять."; exit 1 }
Write-Host "Деинсталляция компонента: $id"

switch ($id) {
    'course' {
        $target = if ($env:HM_COURSE_TARGET) { [Environment]::ExpandEnvironmentVariables($env:HM_COURSE_TARGET) } else { Join-Path $env:USERPROFILE 'HamidunCourse' }
        Remove-HmArtifact (Join-Path $target 'vibecoding-course') 'курс'
        $shortcutName = if ($env:HM_COURSE_SHORTCUT) { $env:HM_COURSE_SHORTCUT } else { 'Курс вайбкодинг (Claude Code)' }
        Remove-HmArtifact (Join-Path ([Environment]::GetFolderPath('Desktop')) ($shortcutName + '.lnk')) 'ярлык курса'
        Write-Host "Примечание: наставник курса в ~/.claude и твои данные НЕ тронуты."
    }
    'nomad' {
        Remove-HmArtifact (Join-Path $env:LOCALAPPDATA 'nomad-src') 'исходники Nomad'
        Remove-HmArtifact (Join-Path $env:USERPROFILE '.local\bin\nomad.exe') 'бинарь nomad'
        Remove-HmArtifact (Join-Path $env:USERPROFILE '.local\bin\nomad') 'launcher nomad'
        Write-Host "Примечание: uv и Python НЕ удаляю (могут быть нужны другим инструментам)."
    }
    'uv' {
        Remove-HmArtifact (Join-Path $env:LOCALAPPDATA 'Programs\uv') 'uv'
    }
    'mascot' {
        Remove-HmArtifact (Join-Path $env:LOCALAPPDATA 'Programs\ClaudeMascot') 'скрепка (приложение)'
        Remove-HmArtifact (Join-Path $env:USERPROFILE '.claude-mascot') 'скрепка (маркер)'
        Write-Host "Примечание: хуки в ~/.claude/settings.json НЕ трогаю (там могут быть твои правки)."
    }
    'bridge' {
        Remove-HmArtifact (Join-Path $env:LOCALAPPDATA 'HamidunBridge') 'AI-мост'
        if ($DRY) { Write-Host "  [dry-run] WOULD remove: HKCU Run\HamidunBridge" }
        else {
            try { Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HamidunBridge' -ErrorAction SilentlyContinue; Write-Host "  Автозапуск моста убран (реестр Run)." } catch { }
        }
    }
    default {
        Write-Host "Автоматическое удаление «$id» не поддерживается (системный инструмент или общая база конфига)."
        Write-Host "Твои данные сохранены. При необходимости удали вручную."
    }
}
exit 0
