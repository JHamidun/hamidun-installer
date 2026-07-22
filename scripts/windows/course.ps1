# Курс-симулятор «Вайбкодинг с Claude Code» — Windows
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
function Update-Path {
    # SECURITY (#4): PATH для elevated-скрипта — ТОЛЬКО HKLM (Machine) + наши
    # админ-owned фиксированные каталоги. НИКОГДА не читаем HKCU (User) PATH: на чистой
    # машине medium-integrity процесс того же юзера может дописать туда каталог с
    # подложенным git/node/python/winget и исполнить его под нашим elevated-токеном.
    # Инструменты в user-профиле (python/cursor/claude/uv) находим по абсолютным путям.
    $sr  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $s32 = Join-Path $sr 'System32'
    $parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine'),
               $s32, $sr,
               (Join-Path $s32 'WindowsPowerShell\v1.0'),
               (Join-Path $s32 'OpenSSH'))
    if ($env:ProgramFiles) {
        $parts += (Join-Path $env:ProgramFiles 'Git\cmd')
        $parts += (Join-Path $env:ProgramFiles 'Git\bin')
        $parts += (Join-Path $env:ProgramFiles 'nodejs')
    }
    if (${env:ProgramFiles(x86)}) { $parts += (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd') }
    if ($env:HM_VENDOR) { $parts += (Join-Path $env:HM_VENDOR 'apps') }
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}
Update-Path
$DRY = [bool]$env:HM_DRY_RUN

# --- источник: вшитый архив курса ---
# Курс — вшитый офлайн-компонент. Нет архива (lite-сборка ИЛИ оторванный vendor) →
# осознанный graceful skip (exit 120), как nomad/uv/mascot: «нечего устанавливать —
# пропускаю», а НЕ падение «код 1» (курс не должен ронять установку). В dry-run — 0.
$zip = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'course\vibecoding-course.zip' } else { '' }
if (-not $zip -or -not (Test-Path $zip)) {
    Write-Host "Курс-симулятор не вошёл в эту сборку (нет vendor\course\vibecoding-course.zip) — пропускаю. Всё остальное работает без него."
    if ($DRY) { exit 0 }
    exit 120
}

# --- целевая папка (zip содержит верхнюю папку vibecoding-course\) ---
$target = if ($env:HM_COURSE_TARGET) { [Environment]::ExpandEnvironmentVariables($env:HM_COURSE_TARGET) } else { Join-Path $env:USERPROFILE 'HamidunCourse' }
$courseDir = Join-Path $target 'vibecoding-course'

if ($DRY) {
    Write-Host "  [dry-run] WOULD: распаковать $zip -> $target (курс окажется в $courseDir)"
    if ($env:HM_COURSE_GLOBAL -eq '1') { Write-Host "  [dry-run] WOULD: глобально поставить навыки наставника в ~/.claude" }
    if ($env:HM_COURSE_BEACON_URL) { Write-Host "  [dry-run] WOULD: включить маяк завершения -> $($env:HM_COURSE_BEACON_URL)" }
    Write-Host "  [dry-run] WOULD: создать ярлык на рабочем столе"
    exit 0
}

# Целостность вшитого архива курса — fail-closed по SHA-256 против vendor/checksums.json,
# как у остальных вшитых артефактов (uv/mascot). Несовпадение / нет записи в манифесте /
# нет манифеста → Confirm-HmArtifact сам делает exit 1 (распаковка НЕ выполняется).
# В dry-run сюда не доходим (ветка выше) — дисковых проверок в превью нет (паттерн P1-8).
Confirm-HmArtifact $zip

Write-Host "Распаковываю курс-симулятор в $target ..."
New-Item -ItemType Directory -Force $target | Out-Null
# Повторная установка: сносим контентные папки курса — Expand-Archive -Force не удаляет
# файлы, исчезнувшие из новой версии, и наставник продолжал бы видеть старые уроки.
# Прогресс ученика не трогаем: sandbox/ и .course/state.json / identity.json в архив не входят.
if (Test-Path (Join-Path $courseDir 'CLAUDE.md')) {
    Write-Host "Курс уже установлен — обновляю файлы курса (прогресс и sandbox сохраняются)."
    # Сносим ТОЛЬКО папки из архива. Внутри .claude трогаем лишь skills/commands —
    # settings.local.json (накопленные учеником permission-разрешения Claude Code)
    # и прочие runtime-файлы должны пережить обновление. state.json/identity.json/sandbox
    # в архив не входят и остаются нетронутыми.
    foreach ($sub in @('tracks', '.claude\skills', '.claude\commands', '.course\knowledge')) {
        $p = Join-Path $courseDir $sub
        if (Test-Path $p) {
            Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
            # Залоченный файл: Remove-Item молча оставляет его; Expand-Archive поверх
            # намешал бы старое с новым. Останавливаемся с внятным сообщением.
            if (Test-Path $p) {
                Write-Host "Не удалось обновить файлы курса ($sub): папка занята. Закрой программы, использующие папку курса, и запусти установку ещё раз."
                exit 1
            }
        }
    }
}
try {
    Expand-Archive -Path $zip -DestinationPath $target -Force -ErrorAction Stop
} catch {
    Write-Host "Не удалось распаковать курс: $($_.Exception.Message)"
    exit 1
}
if (-not (Test-Path (Join-Path $courseDir 'CLAUDE.md'))) {
    Write-Host "Курс распаковался неожиданно (нет CLAUDE.md в $courseDir)."
    exit 1
}
Write-Host "Курс распакован: $courseDir"
# P0-4: квитанция владения — ТОЧНЫЙ путь созданного артефакта (main соберёт в receipt).
Write-Host "HM-RECEIPT path $courseDir"

# --- маяк завершения (опционально, если задан URL) ---
if ($env:HM_COURSE_BEACON_URL) {
    $cfgYaml = Join-Path $courseDir '.course\config.yaml'
    if (Test-Path $cfgYaml) {
        try {
            $u = $env:HM_COURSE_BEACON_URL
            $block = "completion_beacon:`n  enabled: true`n  url: `"$u`""
            # PS 5.1: Get-Content -Raw без -Encoding читает UTF-8-без-BOM как ANSI и
            # превращает кириллицу (названия ролей) в мохибейк — читаем явно как UTF-8.
            $raw = [System.IO.File]::ReadAllText($cfgYaml, (New-Object System.Text.UTF8Encoding($false)))
            if ($raw -match '(?ms)^completion_beacon:.*?(?=^\S|\Z)') {
                $raw = [regex]::Replace($raw, '(?ms)^completion_beacon:.*?(?=^\S|\Z)', ($block + "`n`n"))
            } else {
                $raw = $raw.TrimEnd() + "`n`n" + $block + "`n"
            }
            [System.IO.File]::WriteAllText($cfgYaml, $raw, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "Маяк завершения включён."
        } catch { Write-Host "Маяк включить не удалось (не критично): $($_.Exception.Message)" }
    }
}

# --- глобальная установка наставника в ~/.claude (опционально) ---
if ($env:HM_COURSE_GLOBAL -eq '1') {
    $claudeHome = Join-Path $env:USERPROFILE '.claude'
    $skillsSrc  = Join-Path $courseDir '.claude\skills'
    $skillsDst  = Join-Path $claudeHome 'skills'
    if (Test-Path $skillsSrc) {
        New-Item -ItemType Directory -Force $skillsDst | Out-Null
        # foreach (НЕ ForEach-Object): единый скоуп, флаг $skFail виден после цикла.
        # Без него финальное «установлены» печаталось даже когда навык не встал (папка занята).
        $skFail = $false
        foreach ($d in (Get-ChildItem -Directory $skillsSrc)) {
            $t = Join-Path $skillsDst $d.Name
            if (Test-Path $t) { Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue }
            if (Test-Path $t) {
                # Папка занята (антивирус/редактор): копирование поверх создало бы вложенный
                # дубль course-driver/course-driver, а грузился бы старый навык.
                Write-Host "Не удалось обновить навык $($d.Name): папка занята. Закрой программы, использующие ~/.claude/skills, и запусти установку ещё раз."
                $skFail = $true
            } else {
                Copy-Item -Recurse -Force $d.FullName $t
            }
        }
        # Успех печатаем ТОЛЬКО если ни один навык не провалился (как skfail в course.sh).
        if (-not $skFail) { Write-Host "Навыки курса установлены глобально в ~/.claude/skills." }
    }
    # защищённый блок в ~/.claude/CLAUDE.md (идемпотентно, с бэкапом)
    $claudeMd = Join-Path $claudeHome 'CLAUDE.md'
    $begin = '# >>> vibecoding-course >>>'
    $end   = '# <<< vibecoding-course <<<'
    $note  = "$begin`nРежим наставника по вайбкодингу доступен глобально. Курс: $courseDir`nВести ученика — по скиллам course-driver / course-check / course-role и файлу $courseDir\CLAUDE.md.`n$end"
    $cur = ''
    if (Test-Path $claudeMd) {
        # Строгий UTF-8 (throwOnInvalidBytes): при BOM-less ANSI/cp1251-файле нестрогий
        # декодер молча превратил бы кириллицу в U+FFFD и записал мусор обратно. Ловим
        # это и читаем в системной кодировке — файл не портим. (BOM у UTF-8/UTF-16
        # StreamReader détectит сам поверх переданной кодировки.)
        try {
            $cur = [System.IO.File]::ReadAllText($claudeMd, (New-Object System.Text.UTF8Encoding($false, $true)))
        } catch {
            $cur = [System.IO.File]::ReadAllText($claudeMd, [System.Text.Encoding]::Default)
        }
        # Бэкап делаем ОДИН раз: повторный запуск не должен перетирать оригинал
        # версией, в которую блок курса уже вписан.
        if (-not (Test-Path "$claudeMd.bak-course")) { Copy-Item $claudeMd "$claudeMd.bak-course" -ErrorAction SilentlyContinue }
    }
    if ($null -eq $cur) { $cur = '' }
    if ($cur -match [regex]::Escape($begin)) {
        $cur = [regex]::Replace($cur, '(?ms)' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end), $note)
    } else {
        $cur = ($cur.TrimEnd() + "`n`n" + $note + "`n")
    }
    New-Item -ItemType Directory -Force $claudeHome | Out-Null
    # Без BOM: этот файл читают Claude Code и git-инструменты, BOM им ни к чему.
    [System.IO.File]::WriteAllText($claudeMd, $cur, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Наставник подключён глобально (блок в ~/.claude/CLAUDE.md)."
}

# --- ярлык запуска на рабочем столе ---
$shortcutName = if ($env:HM_COURSE_SHORTCUT) { $env:HM_COURSE_SHORTCUT } else { 'Курс вайбкодинг (Claude Code)' }
try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnkPath = Join-Path $desktop ($shortcutName + '.lnk')
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnkPath)
    $sc.TargetPath = "$env:SystemRoot\System32\cmd.exe"
    $sc.Arguments = '/k cd /d "' + $courseDir + '" && (claude || echo Claude Code не найден — запусти установщик ещё раз и включи компонент Claude Code.)'
    $sc.WorkingDirectory = $courseDir
    $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
    $sc.Description = 'Открыть курс-симулятор вайбкодинга в Claude Code'
    $sc.Save()
    Write-Host "Ярлык создан: $lnkPath"
    Write-Host "HM-RECEIPT path $lnkPath"
} catch { Write-Host "Ярлык не создался (не критично): $($_.Exception.Message)" }

# Честное предупреждение: без claude ярлык откроет голую консоль с «команда не найдена».
$claudeSeen = [bool](Get-Command claude -ErrorAction SilentlyContinue)
if (-not $claudeSeen) {
    foreach ($n in @('claude.exe', 'claude.cmd', 'claude')) {
        if (Test-Path (Join-Path (Join-Path $env:USERPROFILE '.local\bin') $n)) { $claudeSeen = $true; break }
    }
}
if (-not $claudeSeen) {
    Write-Host "ВНИМАНИЕ: команда claude не найдена — ярлык курса заработает после установки Claude Code (перезапусти установщик с включённым компонентом Claude Code)."
}

Write-Host "OK: курс-симулятор установлен. Открой ярлык «$shortcutName» (или папку $courseDir) и напиши агенту «поехали»."
exit 0
