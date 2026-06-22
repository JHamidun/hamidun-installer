# Автотест установки на ЧИСТОЙ Windows-машине (без GUI-кликов).
# Запускать на чистом ПК/VM от администратора:
#   powershell -ExecutionPolicy Bypass -File clean-machine-test.ps1
# Скрипт прогоняет те же компоненты, что и .exe, затем проверяет, что всё реально встало.
# Можно запускать как из распакованной сборки (resources\), так и из репозитория установщика.
#   -DryRun  — холостой прогон: показывает, что бы поставил, ничего не устанавливает.
param([switch]$DryRun)
$ErrorActionPreference = 'Continue'
if ($DryRun) { $env:HM_DRY_RUN = '1'; Write-Host "*** DRY-RUN: ничего не устанавливается, только показываю ***`n" }

# --- найти корень (где лежат scripts\windows и vendor/config-pack) ---
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = $null
foreach ($c in @($here, (Split-Path $here -Parent), (Join-Path $here '..'))) {
    if (Test-Path (Join-Path $c 'scripts\windows')) { $root = (Resolve-Path $c).Path; break }
}
if (-not $root) { Write-Host "Не нашёл scripts\windows — запусти из корня установщика."; exit 1 }
$scripts = Join-Path $root 'scripts\windows'

# vendor: рядом (репо) или в resources (распакованная сборка)
$vendor = $null
foreach ($c in @((Join-Path $root 'vendor'), (Join-Path $root 'resources\vendor'))) {
    if (Test-Path $c) { $vendor = $c; break }
}
$env:HM_VENDOR = $vendor
$env:HM_BUNDLED_CONFIG = if ($vendor) { Join-Path $vendor 'config-pack' } else { '' }
$env:HM_CLAUDE_EXT_ID = 'anthropic.claude-code'

# паки: для теста берём всё (core + все паки)
$packs = Get-Content (Join-Path $root 'packs.json') -Raw | ConvertFrom-Json
$all = @($packs.core) + @($packs.packs.skills | ForEach-Object { $_ })
$env:HM_KEEP_SKILLS = ($all -join ',')
$env:HM_ALL_PACK_SKILLS = (@($packs.packs.skills | ForEach-Object { $_ }) -join ',')

$log = Join-Path $here 'clean-machine-test.log'
"=== Hamidun Setup — автотест $(Get-Date) ===" | Out-File $log
Write-Host "vendor: $vendor"
Write-Host "лог: $log`n"

function Run($id) {
    Write-Host "--- $id ---"
    "=== $id ===" | Out-File $log -Append
    & powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $scripts "$id.ps1") *>&1 | Tee-Object -FilePath $log -Append | Out-Host
}

foreach ($id in @('git', 'node', 'cursor', 'claude', 'extension', 'config', 'pydeps')) { Run $id }

# --- ПРОВЕРКИ результата ---
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
Update-Path
$userHome = $env:USERPROFILE
$checks = [ordered]@{
    'Git установлен'           = [bool](Get-Command git -ErrorAction SilentlyContinue)
    'Node.js установлен'       = [bool](Get-Command node -ErrorAction SilentlyContinue)
    'npm доступен'             = [bool](Get-Command npm -ErrorAction SilentlyContinue)
    'Cursor установлен'        = (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe')) -or [bool](Get-Command cursor -ErrorAction SilentlyContinue)
    'Claude CLI установлен'    = [bool](Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $userHome '.local\bin\claude.exe'))
    'Python установлен'        = [bool](Get-Command python -ErrorAction SilentlyContinue)
    '~/.claude развёрнут'      = (Test-Path (Join-Path $userHome '.claude\settings.json')) -or (Test-Path (Join-Path $userHome '.claude\skills'))
    'CLAUDE.md на месте'       = Test-Path (Join-Path $userHome 'CLAUDE.md')
    'credentials шаблон'       = Test-Path (Join-Path $userHome '.claude\.credentials.master.env')
}
$skillCount = (Get-ChildItem (Join-Path $userHome '.claude\skills') -Directory -ErrorAction SilentlyContinue).Count

"`n=== РЕЗУЛЬТАТ ===" | Tee-Object -FilePath $log -Append | Out-Host
$fail = 0
foreach ($k in $checks.Keys) {
    $ok = $checks[$k]
    if (-not $ok) { $fail++ }
    ("  {0}  {1}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $k) | Tee-Object -FilePath $log -Append | Out-Host
}
"  скиллов в ~/.claude/skills: $skillCount" | Tee-Object -FilePath $log -Append | Out-Host

# проверка, что Python-пакеты реально импортируются (офлайн-wheels сработали)
$pyImport = & python -c "import requests, anthropic, openai, telethon, playwright, lxml, PIL; print('OK')" 2>&1
("  Python-импорты (requests/anthropic/openai/telethon/playwright/lxml/PIL): {0}" -f $pyImport) | Tee-Object -FilePath $log -Append | Out-Host

"`nИТОГ: $(if ($fail -eq 0) { 'ВСЁ ПРОШЛО' } else { "$fail проверок упало" })" | Tee-Object -FilePath $log -Append | Out-Host
Write-Host "`nПолный лог: $log  — пришли его Жемалу/мне."
exit $fail
