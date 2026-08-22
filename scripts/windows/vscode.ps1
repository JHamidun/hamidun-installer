# VS Code (рекомендуемый редактор) + расширения Claude Code и Codex — Windows
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
. (Join-Path $PSScriptRoot '_deelev.ps1')  # Invoke-HmDeElevated (укреплённая де-элевация, fail-closed)
function Update-Path {
    # SECURITY (#4): PATH для elevated-скрипта — ТОЛЬКО HKLM (Machine) + наши
    # админ-owned фиксированные каталоги. НИКОГДА не читаем HKCU (User) PATH.
    $sr  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $s32 = Join-Path $sr 'System32'
    $parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine'),
               $s32, $sr,
               (Join-Path $s32 'WindowsPowerShell\v1.0'),
               (Join-Path $s32 'OpenSSH'))
    if ($env:ProgramFiles) {
        $parts += (Join-Path $env:ProgramFiles 'Git\cmd')
        $parts += (Join-Path $env:ProgramFiles 'nodejs')
        $parts += (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin')
    }
    if ($env:LOCALAPPDATA) { $parts += (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin') }
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}
Update-Path

# Временные копии vsix и их уборка объявлены ДО первого exit: в PowerShell функция
# должна существовать к моменту вызова, иначе ранний выход упадёт «команда не найдена».
$script:VsixTemps = @()
# Копии vsix (до 80 МБ каждая) не должны оставаться в %TEMP%.
function Remove-HmVsixTemps {
    foreach ($f in $script:VsixTemps) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
    $script:VsixTemps = @()
}

$DRY = [bool]$env:HM_DRY_RUN

# CLI VS Code — НАСТОЯЩИЙ code.cmd (не курсоровский шим, отдающий VS Code 1.67.1).
function Find-CodeCli {
    foreach ($p in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
                     "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}
function Test-VsCodePresent {
    if (Find-CodeCli) { return $true }
    foreach ($e in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
                     "$env:ProgramFiles\Microsoft VS Code\Code.exe")) {
        if (Test-Path $e) { return $true }
    }
    return $false
}

$setup = ''
if ($env:HM_VENDOR) { $cand = Join-Path $env:HM_VENDOR 'apps\vscode-setup.exe'; if (Test-Path $cand) { $setup = $cand } }
$present = Test-VsCodePresent

Write-Host "Проверяю VS Code..."
if ($present) {
    Write-Host "VS Code уже установлен — доставлю только расширения."
} elseif (-not $setup) {
    # Офлайн-инсталлятор не вшит И VS Code не установлен — как скрепка (mascot): грациозный
    # пропуск (exit 120). Всё остальное работает; VS Code можно поставить позже.
    Write-Host "VS Code не вошёл в эту сборку и не установлен — пропускаю. Остальное работает без него (поставь VS Code позже с code.visualstudio.com)."
    Remove-HmVsixTemps
    exit 120
} elseif ($DRY) {
    Write-Host "  [dry-run] WOULD: SHA-256 vscode-setup.exe, тихая установка /VERYSILENT /NORESTART /MERGETASKS=!runcode,addtopath, PATH, затем расширения anthropic.claude-code + openai.chatgpt"
} else {
    # Вшитый установщик исполняется -> fail-closed SHA-256 ДО запуска.
    Confirm-HmArtifact $setup
    # Формулировка важнее, чем кажется. Раньше строка заканчивалась словами «без прав
    # администратора» — это описание РЕЖИМА (User Setup ставится в профиль и прав
    # администратора не требует). Но стоит она прямо перед возможным сбоем, и ученик
    # прочитал её как ПРИЧИНУ: «не установилось, потому что не запустил от админа».
    # Дальше он отказался жать «Повторить неустановленное», решив, что это бесполезно,
    # — и остался без редактора. Строка, которую можно принять за диагноз, обязана
    # либо быть диагнозом, либо не выглядеть им.
    Write-Host "Ставлю VS Code из встроенного установщика (офлайн, издание User Setup — ставится в твой профиль)..."
    # User Setup (Inno) с !runcode НЕ запускает VS Code сам -> -Wait безопасен (в отличие от Cursor).
    Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode,addtopath' -Wait
    Update-Path
    $codeExe = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
    for ($i = 0; $i -lt 60 -and -not (Test-Path $codeExe); $i++) { Start-Sleep -Seconds 1 }
    if (Test-Path $codeExe) {
        Write-Host "VS Code установлен."
        # Квитанция владения (каталог установки) — для будущего деинсталлятора.
        Write-Host "HM-RECEIPT path $(Split-Path $codeExe)"
    } else {
        Write-Host "ВНИМАНИЕ: VS Code не подтвердил установку (Code.exe не найден) — расширения всё равно попробую доставить."
    }
}

# --- Расширения: ставим в VS Code ОБА — панель Claude (anthropic.claude-code) и Codex (openai.chatgpt) ---
#
# P0 (privesc): этот скрипт исполняется ELEVATED (установщик requireAdministrator).
# Прямой запуск user-writable code.cmd/Code.exe под АДМИНОМ выполнил бы то, что
# medium-integrity малварь ТОГО ЖЕ юзера могла заранее подложить на его место
# (integrity-escalation). Поэтому УСТАНОВКА расширений в VS Code через бинарь code.cmd
# идёт ДЕ-ЭЛЕВИРОВАННО — через одноразовую scheduled task от текущего интерактивного
# пользователя с /RL LIMITED (medium integrity). Если де-элевация недоступна — FAIL-CLOSED:
# бинарь под админом НЕ запускаем.
# Остаточный риск: если Task Scheduler недоступен, авто-установка расширений не произойдёт
# (UX-деградация, НЕ эскалация); пользователь ставит их из панели Extensions вручную.

# Доверенный сигнал установки VS Code: ключ Uninstall его инсталлятора (Inno _is1).
# User Setup -> HKCU, System Setup -> HKLM(+WOW). Возвращает bin\code.cmd из
# InstallLocation ('' если ключа нет) — НЕ доверяем «просто нашли code.cmd на диске».
function Get-VsCodeCli {
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (-not (Test-Path $root)) { continue }
        foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
            $p = $null
            try { $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue } catch { }
            if ($p -and ($p.DisplayName -match 'Visual Studio Code') -and $p.InstallLocation) {
                $cli = Join-Path $p.InstallLocation 'bin\code.cmd'
                if (Test-Path $cli) { return $cli }
            }
        }
    }
    return ''
}

# Де-элевация вынесена в ЕДИНЫЙ укреплённый примитив scripts/windows/_deelev.ps1
# (Invoke-HmDeElevated): чистый PSModulePath+PATH, абсолютный schtasks.exe (нет
# module-hijack), integrity-check обёртки (fail-closed при не-medium). Дот-сорсится выше.

# Вшитый .vsix (офлайн). vsix исполняется как код внутри VS Code -> целостность ДО установки (fail-closed).

function Get-Vsix($name) {
    if (-not $env:HM_VENDOR) { return '' }
    $p = Join-Path $env:HM_VENDOR ('apps\' + $name)
    if (-not (Test-Path $p)) { return '' }
    if ($DRY) { return $p }
    Confirm-HmArtifact $p
    # Расширения ставятся ДЕ-ЭЛЕВИРОВАННО (CLI редактора работает от пользователя), а в
    # лёгком издании vsix лежит в СКАЧАННОМ паке, распакованном в admins-only каталог
    # (%ProgramData%\HmDeElev-*, DACL {SYSTEM, Administrators} без ACE пользователя).
    # Medium-процесс такой файл ПРОЧИТАТЬ НЕ МОЖЕТ — офлайн-установка панели срывалась бы
    # и молча уходила в Marketplace, а без интернета не ставилась бы вовсе.
    # Кладём ПРОВЕРЕННУЮ копию туда, где у пользователя есть доступ. Эскалации нет: vsix
    # и так исполняется редактором при MEDIUM, а целостность подтверждена выше под админом.
    try {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('hm-vsix-' + [guid]::NewGuid().ToString('N') + '.vsix')
        Copy-Item -LiteralPath $p -Destination $tmp -Force -ErrorAction Stop
        $null = [System.IO.File]::OpenRead($tmp).Close()   # копия ДЕЙСТВИТЕЛЬНО читается
        $script:VsixTemps += $tmp
        return $tmp
    } catch {
        Write-Host "  Не удалось подготовить читаемую копию $name ($($_.Exception.Message)) — останется путь Marketplace."
        return ''
    }
}


$script:DeElevFailed = $false

# Каталоги расширений VS Code (User + OSS). Проверка установки — ПРЯМО по каталогам
# (Test-HmExtInstalled), а НЕ через вывод editor CLI: elevated-процесс user-writable
# бинарь VS Code под админом НЕ запускает даже для чтения списка.
function Get-VsCodeExtDirs {
    @((Join-Path $env:USERPROFILE '.vscode\extensions'),
      (Join-Path $env:USERPROFILE '.vscode-oss\extensions'))
}

# FS-аттестация с коротким ретраем (каталог расширения появляется чуть позже install).
function Confirm-ExtInstalled($extId, $dirs) {
    for ($k = 0; $k -lt 6; $k++) {
        if (Test-HmExtInstalled -ExtId $extId -Dirs $dirs) { return $true }
        Start-Sleep -Milliseconds 1000
    }
    return $false
}

# Установка расширения ДЕ-ЭЛЕВИРОВАННО (Invoke-HmDeElevated), затем аттестация через ПРЯМУЮ
# проверку каталога расширений (НЕ через вывод бинаря). $true, если extId подтверждён на диске.
function Install-ExtSafe($cli, $extId, $vsix) {
    if (-not $cli) { return $false }
    Write-Host "Ставлю расширение $extId в VS Code (от имени пользователя, без прав администратора)..."
    if ($DRY) {
        if ($vsix) { Write-Host "  [dry-run] WOULD (de-elevated): $cli --install-extension $vsix --force" }
        else { Write-Host "  [dry-run] WOULD (de-elevated): $cli --install-extension $extId --force" }
        return $true
    }
    $dirs = Get-VsCodeExtDirs
    if (Test-HmExtInstalled -ExtId $extId -Dirs $dirs) { Write-Host "  ${extId}: уже на месте."; return $true }
    $target = if ($vsix) { $vsix } else { $extId }
    if ($vsix) { Write-Host "  из вшитого vsix (офлайн): $vsix" }
    $r = Invoke-HmDeElevated $cli @('--install-extension', $target, '--force')
    if ($null -eq $r) {
        Write-Host "  Не удалось безопасно (де-элевированно) выполнить установку — пропускаю (fail-closed, НЕ запускаю под админом)."
        $script:DeElevFailed = $true
        return $false
    }
    if (Confirm-ExtInstalled $extId $dirs) { Write-Host "  ${extId}: на месте."; return $true }
    # Ретрай через Marketplace — ТОЛЬКО когда первая задача ДОКАЗАННО завершилась (Gate='medium').
    # При Gate='unknown' (родитель не дождался Last Result) установка, возможно, ещё идёт:
    # вторая задача пошла бы поверх неё в тот же ~/.vscode/extensions (конкурентная запись).
    if ($vsix -and $r.Gate -eq 'medium') {
        Write-Host "  ${extId}: vsix не подтвердился — пробую Marketplace..."
        $r2 = Invoke-HmDeElevated $cli @('--install-extension', $extId, '--force')
        if ($null -eq $r2) { $script:DeElevFailed = $true; return $false }
        if (Confirm-ExtInstalled $extId $dirs) { Write-Host "  ${extId}: на месте (Marketplace)."; return $true }
    }
    if ($r.Gate -eq 'unknown') {
        Write-Host "  ${extId}: установка пока не отчиталась (возможно, ещё идёт в фоне) — второй запуск НЕ делаю, проверь панель Extensions позже."
    } else {
        Write-Host "  ${extId}: не подтвердилось."
    }
    return $false
}

# CLI: доверенный (реестр Uninstall) в приоритете; иначе — найденный на диске (но
# исполняем его ВСЁ РАВНО только де-элевированно, что снимает эскалацию).
$codeCli = Get-VsCodeCli
if (-not $codeCli) { $codeCli = Find-CodeCli }

# Весь блок расширений — в try/finally: копии vsix (их создаёт Get-Vsix, до 80 МБ каждая)
# убираются на ЛЮБОМ выходе — exit 0/1 И необработанное исключение. Раньше уборка стояла
# «руками перед каждым exit», и самый частый выход — оба расширения встали -> exit 0 —
# оказался пропущен: КАЖДЫЙ успешный прогон (включая повторный, когда ничего не ставится)
# оставлял ~82 МБ мусора в %TEMP%. В PowerShell exit внутри try исполняет finally,
# поэтому уборка гарантирована на всех путях разом, а не перечислением.
try {
    if (-not $codeCli -and -not $DRY) {
        Write-Host "CLI VS Code (code.cmd) не найден — расширения не поставить автоматически. Открой VS Code, панель Extensions -> найди 'Claude Code' и 'ChatGPT - Codex' -> Install."
        exit 1
    }

    # Запущенный VS Code — самый частый повод для долгой установки расширений: code.cmd
    # отдаёт команду РАБОТАЮЩЕМУ экземпляру через IPC, а тот отвечает не сразу (или не
    # отвечает вовсе, если занят). Ждать приходится до лимита задачи — по 10 минут на
    # расширение, и со стороны это выглядит зависшей установкой. Убивать чужой редактор
    # с несохранёнными файлами нельзя, поэтому честно предупреждаем: закрыть VS Code
    # сейчас — самый быстрый способ.
    if (-not $DRY) {
        $running = @(Get-Process -Name 'Code' -ErrorAction SilentlyContinue)
        if ($running.Count -gt 0) {
            Write-Host "ВНИМАНИЕ: VS Code сейчас ОТКРЫТ. Расширения будут ставиться дольше обычного (до 10 минут каждое)."
            Write-Host "  Хочешь быстрее — закрой окно VS Code и не трогай установщик: он продолжит сам."
        }
    }

    $claudeVsix = Get-Vsix 'claude-code.vsix'
    $codexVsix  = Get-Vsix 'chatgpt.vsix'
    $okClaude = Install-ExtSafe $codeCli 'anthropic.claude-code' $claudeVsix
    $okCodex  = Install-ExtSafe $codeCli 'openai.chatgpt' $codexVsix

    if ($okClaude) { Write-Host "OK: панель Claude Code в VS Code установлена." }
    if ($okCodex)  { Write-Host "OK: Codex (openai.chatgpt) в VS Code установлен." }

    # P1: успех (exit 0) ТОЛЬКО когда встали ОБА расширения. Иначе называем отсутствующее.
    if ($okClaude -and $okCodex) { exit 0 }
    # ИСКЛЮЧЕНИЕ: Codex-vsix (chatgpt.vsix) намеренно НЕ вшит в эту сборку (лимит makensis 2 ГБ —
    # package.json build.win.extraResources исключает apps/chatgpt.vsix). Тогда единственный путь —
    # Marketplace, а он требует интернета: на офлайн-машине компонент проваливался ВСЕГДА, хотя
    # VS Code и ОБЯЗАТЕЛЬНАЯ панель Claude вставали нормально. Codex здесь ОПЦИОНАЛЕН: предупреждаем
    # и завершаемся успехом. Если vsix в сборке ЕСТЬ и просто не встал — строгое поведение сохраняется.
    if ($okClaude -and -not $okCodex -and -not $codexVsix) {
        Write-Host "Codex (openai.chatgpt) не вошёл в эту сборку и ставится только из Marketplace (нужен интернет) — пропускаю."
        Write-Host "  VS Code и панель Claude Code установлены. Codex поставишь позже: VS Code -> Extensions -> 'ChatGPT - Codex' -> Install."
        exit 0
    }
    $missing = @()
    if (-not $okClaude) { $missing += 'Claude Code (anthropic.claude-code)' }
    if (-not $okCodex)  { $missing += 'Codex (openai.chatgpt)' }
    if ($script:DeElevFailed) {
        Write-Host "Не удалось безопасно доставить расширения (де-элевация недоступна): $($missing -join ', '). Открой VS Code -> Extensions -> найди их по имени -> Install."
    } else {
        Write-Host "Не установились расширения: $($missing -join ', '). Открой VS Code -> Extensions -> найди их по имени -> Install. Claude Code также работает в терминале командой 'claude'."
    }
    exit 1
} finally {
    Remove-HmVsixTemps
}
