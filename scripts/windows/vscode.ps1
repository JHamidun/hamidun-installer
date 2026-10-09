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

# Пауза перед ОДНИМ автоповтором расширения. Отказы здесь бывали плавающими: у людей
# повторный прогон через минуты проходил там, где первый не прошёл. Переопределение — для
# тестов и поддержки (установщик строит окружение скрипта из allowlist и её не передаёт).
$script:ExtRetryDelaySec = 60
if ("$env:HM_EXT_RETRY_DELAY_SEC" -match '^\d{1,3}$') { $script:ExtRetryDelaySec = [Math]::Min(300, [int]$env:HM_EXT_RETRY_DELAY_SEC) }

# Доверенный сигнал установки VS Code: ключ Uninstall его инсталлятора (Inno _is1).
# User Setup -> HKCU, System Setup -> HKLM(+WOW). Возвращает bin\code.cmd из
# InstallLocation ('' если ключа нет) — НЕ доверяем «просто нашли code.cmd на диске».
# Объявлена ДО первого вызова: по ней же решается, есть ли редактор (Get-VsCodeExePath).
function Get-VsCodeCli {
    $roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
               'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
               'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
    # Только для тестов: песочнице нужен СВОЙ раздел вместо настоящего реестра машины (иначе
    # результат зависит от того, стоит ли VS Code у того, кто гоняет тесты). Установщик строит
    # окружение скрипта из allowlist и эту переменную не передаёт.
    if ($env:HM_VSCODE_UNINSTALL_ROOTS) { $roots = @($env:HM_VSCODE_UNINSTALL_ROOTS -split ';' | Where-Object { $_ }) }
    foreach ($root in $roots) {
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

# CLI VS Code — НАСТОЯЩИЙ code.cmd (не курсоровский шим, отдающий VS Code 1.67.1).
function Find-CodeCli {
    foreach ($p in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
                     "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# «Редактор на диске» = Code.exe. Кандидаты: рядом с CLI из реестра (<каталог>\bin\code.cmd ->
# <каталог>\Code.exe: так находится установка в НЕстандартную папку) и два стандартных места.
# Одиночный code.cmd редактором не считается: он остаётся после неполного удаления и есть у
# шима Cursor, а решение «красный шаг (редактора нет) или жёлтый (нет только панели)» на нём
# ошибалось — человеку говорили «VS Code установлен», когда его не было.
function Get-VsCodeExePath {
    $cands = @()
    $reg = Get-VsCodeCli
    if ($reg) { $cands += (Join-Path (Split-Path -Parent (Split-Path -Parent $reg)) 'Code.exe') }
    $cands += "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
    $cands += "$env:ProgramFiles\Microsoft VS Code\Code.exe"
    foreach ($e in $cands) { if ($e -and (Test-Path -LiteralPath $e)) { return $e } }
    return ''
}
function Test-VsCodePresent { return [bool](Get-VsCodeExePath) }

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
    # -PassThru обязателен: без него код возврата Inno не прочитать, и провал САМОГО
    # установщика (отменён политикой, не хватило места, повреждён) остаётся невидимым.
    # Дальше скрипт не находил code.cmd и завершался текстом «CLI VS Code не найден —
    # расширения не поставить», а словарь причин относил это к классу «расширение не
    # встало». Человеку сообщали не про то: у него не установился редактор целиком.
    $setupProc = Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode,addtopath' -Wait -PassThru
    $setupRc = if ($setupProc) { $setupProc.ExitCode } else { $null }
    if ($null -ne $setupRc -and $setupRc -ne 0) {
        # Inno: 2 = отменено пользователем, 5 = отменено на этапе подготовки,
        # 1 = ошибка запуска setup. Точную расшифровку не выдумываем — печатаем код.
        Write-Host "ВНИМАНИЕ: установщик VS Code завершился с кодом $setupRc — установка редактора НЕ прошла."
    }
    Update-Path
    # Ждём до минуты, пока Code.exe появится: в стандартной папке или там, куда указывает ключ Uninstall.
    for ($i = 0; $i -lt 60 -and -not (Test-VsCodePresent); $i++) { Start-Sleep -Seconds 1 }
    $codeExe = Get-VsCodeExePath
    if ($codeExe) {
        Write-Host "VS Code установлен."
        # Квитанция владения (каталог установки) — для будущего деинсталлятора.
        Write-Host "HM-RECEIPT path $(Split-Path $codeExe)"
    } else {
        # Отдельный маркер для финального сообщения ниже: НЕ встал сам редактор.
        # Без него оба исхода («редактора нет» и «редактор есть, CLI нет») сливались
        # в одну строку про расширения.
        $script:HmEditorMissing = $true
        Write-Host "ВНИМАНИЕ: VS Code не подтвердил установку (Code.exe не найден$(if ($null -ne $setupRc) { ", код установщика $setupRc" }))."
    }
}

# Редактора нет (установщик отработал, а Code.exe не появился; либо его нет вовсе) — красный шаг
# СРАЗУ, до расширений: ставить их некуда. Строка без слов про «расширения» намеренно: разбор
# провала (src/failure-explain.js) по ним сказал бы человеку «редактор встал, а панель — нет», то
# есть ровно наоборот, и «Повторить» перестало бы казаться ему выходом. Это единственный красный
# выход шага: «нет панели» и «нет Codex» — жёлтый (код 121, ниже).
if (-not $DRY -and ($script:HmEditorMissing -or -not (Test-VsCodePresent))) {
    Write-Host "VS Code не установился — нажми «Повторить»; не поможет — поставь его с code.visualstudio.com и запусти установщик ещё раз."
    Remove-HmVsixTemps
    exit 1
}

# --- Расширения: ставим в VS Code ОБА — панель Claude (anthropic.claude-code) и Codex (openai.chatgpt) ---
#
# P0 (privesc): этот скрипт исполняется ELEVATED (установщик requireAdministrator).
# Прямой запуск user-writable code.cmd/Code.exe под АДМИНОМ выполнил бы то, что
# medium-integrity малварь ТОГО ЖЕ юзера могла заранее подложить на его место
# (integrity-escalation). Поэтому УСТАНОВКА расширений в VS Code через бинарь code.cmd
# идёт ДЕ-ЭЛЕВИРОВАННО — через одноразовую scheduled task от текущего интерактивного
# пользователя с /RL LIMITED (medium integrity), а если доказано, что задача ничего не
# запустила (у людей так отказывал планировщик целиком — «Last Result» 0x80070005), — тем же
# действием с проверенным medium-токеном оболочки Explorer (Invoke-HmDeElevatedSafe,
# _deelev.ps1). Если недоступно и то и другое — FAIL-CLOSED: бинарь под админом НЕ запускаем.
# Остаточный риск: тогда авто-установка расширений не произойдёт (UX-деградация, НЕ
# эскалация) — шаг заканчивается кодом 121 и строкой «ЧАСТИЧНО:» с ручным способом.

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
$script:DeElevReason = ''
# Итог по каждому расширению (id -> Ok/Medium/Refused/Pending/DeElevFailed/Reason): строка
# «ЧАСТИЧНО:» называет причину ИМЕННО того расширения, которого нет, а не общую на оба.
$script:ExtOutcome = @{}

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

# ОДНА попытка: vsix (если вшит), затем Marketplace. Каждый запуск — ДЕ-ЭЛЕВИРОВАННО
# (Invoke-HmDeElevatedSafe: задача планировщика, а если доказано, что она ничего не
# запустила, — то же действие с токеном оболочки Explorer). Итог — ТОЛЬКО по каталогу
# расширений (Confirm-ExtInstalled), не по выводу и не по коду бинаря.
# Возвращает { Ok; Results (итоги всех запусков — по ним решается повтор); DeElevFailed; Reason }.
function Invoke-HmExtAttempt($cli, $extId, $vsix, $dirs) {
    $results = @()
    $target = if ($vsix) { $vsix } else { $extId }
    if ($vsix) { Write-Host "  из вшитого vsix (офлайн): $vsix" }
    else { Write-Host "  вшитого vsix нет — ставлю из Marketplace (нужен интернет)" }
    $r = Invoke-HmDeElevatedSafe $cli @('--install-extension', $target, '--force') -Label "vscode-$extId"
    $results += $r
    # Ни задача, ни запасной путь программу НЕ запустили (а не «запустили и она не справилась»):
    # под админом бинарь при этом НЕ исполняется — fail-closed, человеку называем причину.
    $failedDeElev = ($null -eq $r) -or ($r.Gate -ne 'medium' -and $r.Finished)
    $reason = if ($null -ne $r -and $r.ShellReason) { [string]$r.ShellReason } else { '' }
    if (Confirm-ExtInstalled $extId $dirs) {
        Write-Host "  ${extId}: на месте."
        return [pscustomobject]@{ Ok = $true; Results = $results; DeElevFailed = $false; Reason = '' }
    }
    # Ретрай через Marketplace — ТОЛЬКО когда первый запуск ДОКАЗАННО отработал (Gate='medium').
    # При 'unknown' установка, возможно, ещё идёт: второй запуск пошёл бы поверх неё в тот же
    # ~/.vscode/extensions (конкурентная запись).
    if ($vsix -and $null -ne $r -and $r.Gate -eq 'medium') {
        Write-Host "  ${extId}: vsix не подтвердился — пробую Marketplace..."
        $r2 = Invoke-HmDeElevatedSafe $cli @('--install-extension', $extId, '--force') -Label "vscode-$extId"
        $results += $r2
        if (Confirm-ExtInstalled $extId $dirs) {
            Write-Host "  ${extId}: на месте (Marketplace)."
            return [pscustomobject]@{ Ok = $true; Results = $results; DeElevFailed = $false; Reason = '' }
        }
    }
    return [pscustomobject]@{ Ok = $false; Results = $results; DeElevFailed = $failedDeElev; Reason = $reason }
}

# Установка расширения: попытка, при неудаче — ОДИН автоповтор через ~минуту. $true, если
# extId подтверждён на диске. Итог попытки (для сообщения человеку) — в $script:ExtOutcome[extId].
function Install-ExtSafe($cli, $extId, $vsix) {
    $o = [pscustomobject]@{ Ok = $false; Medium = $false; Refused = $false; Pending = $false; DeElevFailed = $false; Reason = '' }
    $script:ExtOutcome[$extId] = $o
    if (-not $cli) { return $false }
    Write-Host "Ставлю расширение $extId в VS Code (от имени пользователя, без прав администратора)..."
    if ($DRY) {
        if ($vsix) { Write-Host "  [dry-run] WOULD (de-elevated): $cli --install-extension $vsix --force" }
        else { Write-Host "  [dry-run] WOULD (de-elevated): $cli --install-extension $extId --force" }
        $o.Ok = $true
        return $true
    }
    $dirs = Get-VsCodeExtDirs
    if (Test-HmExtInstalled -ExtId $extId -Dirs $dirs) { Write-Host "  ${extId}: уже на месте."; $o.Ok = $true; return $true }
    $a = Invoke-HmExtAttempt $cli $extId $vsix $dirs
    if ($a.Ok) { $o.Ok = $true; return $true }
    # Повтор — только если доказано, что НИЧЕГО из первой попытки уже не идёт, и не после отказа
    # по политике (Test-HmDeElevRetryAllowed): две установки в один ~/.vscode/extensions портят
    # каталог, а «не обычный уровень прав» (UAC выключен, чужая учётная запись) через минуту
    # останется тем же отказом — повтор лишь удлинил бы шаг на минуту.
    if (Test-HmDeElevRefused -Attempts $a.Results) {
        Write-Host "  ${extId}: запуск от имени пользователя отклонён (нет обычного уровня прав) — повтор ничего бы не изменил, не повторяю."
    } elseif (Test-HmDeElevRetryAllowed -Attempts $a.Results) {
        Write-Host "  ${extId}: не встало с первой попытки, повторю один раз через $($script:ExtRetryDelaySec) с (бывает, что со второго раза проходит)."
        Start-Sleep -Seconds $script:ExtRetryDelaySec
        if (Test-HmExtInstalled -ExtId $extId -Dirs $dirs) { Write-Host "  ${extId}: появилось с задержкой — на месте."; $o.Ok = $true; return $true }
        $a = Invoke-HmExtAttempt $cli $extId $vsix $dirs
        if ($a.Ok) { Write-Host "  ${extId}: встало со второй попытки."; $o.Ok = $true; return $true }
    }
    $o.Refused = [bool](Test-HmDeElevRefused -Attempts $a.Results)
    $o.Medium  = @(@($a.Results) | Where-Object { $null -ne $_ -and $_.Gate -eq 'medium' }).Count -gt 0
    if ($a.DeElevFailed) {
        $o.DeElevFailed = $true
        $o.Reason = [string]$a.Reason
        $script:DeElevFailed = $true
        if ($a.Reason) { $script:DeElevReason = $a.Reason }
    }
    $last = @($a.Results)[-1]
    if ($null -ne $last -and -not $last.Finished) {
        $o.Pending = $true
        Write-Host "  ${extId}: установка пока не отчиталась (возможно, ещё идёт в фоне) — второй запуск НЕ делаю, проверь панель Extensions позже."
    } else {
        Write-Host "  ${extId}: не подтвердилось."
    }
    return $false
}

# Короткая человеческая причина, почему расширения нет, — для строки «ЧАСТИЧНО:». Подробности
# (Gate, Last Result, текст отказа) уже в журнале строкой «[де-элевация] …»; сюда они не лезут.
# «Нужен интернет» — только если запуск РЕАЛЬНО дошёл до VS Code (Gate 'medium'): когда он не
# запускался вовсе, интернет ни при чём, и совет «проверь сеть» отправлял бы человека не туда.
function Get-HmExtWhy($o) {
    if ($null -eq $o) { return '' }
    if ($o.Refused) { return 'нет обычного уровня прав (UAC выключен или вход под встроенным администратором)' }
    if ($o.DeElevFailed) { return 'не удалось запустить установку от имени пользователя' }
    if ($o.Pending) { return 'установка ещё шла, когда шаг завершился' }
    if ($o.Medium) { return 'VS Code не принял расширение (закрой его окно и повтори; из Marketplace нужен интернет)' }
    return ''
}

# Строка частичного успеха — РОВНО одна на шаг, до 240 знаков (интерфейс режет по 240/300):
# «ЧАСТИЧНО: <чего нет и что сделать руками> Причина: <почему>». При нехватке места сокращается
# ПРИЧИНА (по границе слова, без многоточия), а не действие: человеку нужно именно действие.
function Format-HmPartialLine {
    param([string]$Lead, [string]$Reason = '')
    $max = 240
    $line = 'ЧАСТИЧНО: ' + $Lead
    $r = ([string]$Reason).Trim().TrimEnd('.')
    if ($r) {
        $room = $max - $line.Length - ' Причина: .'.Length
        if ($room -ge 12) {
            if ($r.Length -gt $room) {
                $r = $r.Substring(0, $room)
                $sp = $r.LastIndexOf(' ')
                if ($sp -gt 12) { $r = $r.Substring(0, $sp) }
                $r = $r.TrimEnd(' ', ',', ';', ':', '(', '—', '-')
            }
            $line += ' Причина: ' + $r + '.'
        }
    }
    return $line
}

# Русский интерфейс VS Code: языковой пакет MS-CEINTL.vscode-language-pack-ru. НЕОБЯЗАТЕЛЕН:
# любой исход — строка в журнал, код выхода шага он не меняет никогда. Ставится тем же
# де-элевированным путём (Invoke-HmDeElevatedSafe + проверка каталогом), один раз, без
# минутного автоповтора: необязательная часть его не стоит. Вызывается ВНУТРИ try, до
# любого exit — значит раньше finally, где vscode-settings.ps1 пишет "locale":"ru" в
# argv.json только при пакете, уже стоящем на диске: русский включается в том же прогоне.
# Строки без многоточия в конце и без слов провала: если шаг всё же упадёт по другой
# причине, разбор провала (src/failure-explain.js) не должен принять их за этап или ошибку.
function Install-HmRuLanguagePack($cli, $vsix) {
    $id = 'ms-ceintl.vscode-language-pack-ru'
    if (-not $cli) { return }
    $target = if ($vsix) { $vsix } else { $id }
    if ($DRY) { Write-Host "  [dry-run] WOULD (de-elevated): $cli --install-extension $target --force (русский языковой пакет, необязательно)"; return }
    $dirs = Get-VsCodeExtDirs
    if (Test-HmExtInstalled -ExtId $id -Dirs $dirs) { Write-Host "Русский языковой пакет VS Code уже на месте."; return }
    Write-Host ("Русский языковой пакет VS Code (необязательный): ставлю от имени пользователя, " +
        $(if ($vsix) { 'из вшитого vsix.' } else { 'из Marketplace — нужен интернет.' }))
    $r = Invoke-HmDeElevatedSafe $cli @('--install-extension', $target, '--force') -Label "vscode-$id"
    $ok = Confirm-ExtInstalled $id $dirs
    if (-not $ok -and $vsix -and $null -ne $r -and $r.Gate -eq 'medium') {
        Write-Host "  русский пакет из vsix не встал — пробую Marketplace."
        $null = Invoke-HmDeElevatedSafe $cli @('--install-extension', $id, '--force') -Label "vscode-$id"
        $ok = Confirm-ExtInstalled $id $dirs
    }
    if ($ok) { Write-Host "  русский языковой пакет на месте: интерфейс VS Code станет русским после перезапуска редактора." }
    else { Write-Host "  русского языкового пакета нет — VS Code останется на английском, работе это не мешает. Поставить позже: Extensions -> «Russian Language Pack» -> Install." }
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
        # Редактор есть (проверено выше), а его консольной команды нет — шаг выполнен наполовину:
        # VS Code работает, панели доставляются руками (121, см. контракт ниже).
        Write-Host (Format-HmPartialLine 'нет панели Claude Code — не найдена консольная команда code. VS Code → Extensions (Ctrl+Shift+X) → «Claude Code» → Install.')
        exit 121
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

    # Необязательный русский интерфейс — ДО итоговых exit (и потому до finally с настройками).
    $ruVsix = Get-Vsix 'vscode-language-pack-ru.vsix'
    Install-HmRuLanguagePack $codeCli $ruVsix

    # P1: полный успех (exit 0) — ТОЛЬКО когда встали ОБА расширения.
    if ($okClaude -and $okCodex) { exit 0 }

    # КОНТРАКТ 121 = «частичный успех: компонент работает, необязательной части нет» (его
    # понимает src/main.js -> res.partial, интерфейс рисует жёлтым). Скрипт печатает РОВНО ОДНУ
    # строку, начинающуюся с «ЧАСТИЧНО:», — чего нет, что сделать руками и (в конце) почему; до
    # 240 знаков, потому что интерфейс показывает только её. Красный (exit 1) — лишь когда нет
    # самого редактора (проверено выше, до расширений): тогда и ставить некуда.
    # Редактор стоит, а панели нет — 121: VS Code работает, панель ставится в два клика, и
    # красный «VS Code не встал» отправлял людей переустанавливать то, что уже стоит. Codex
    # необязателен во всех изданиях: его отсутствие — всегда 121.
    $oc = $script:ExtOutcome['anthropic.claude-code']
    $ox = $script:ExtOutcome['openai.chatgpt']
    if ($script:DeElevFailed -and $script:DeElevReason) {
        Write-Host "  Подробности: безопасно запустить установку не удалось — $($script:DeElevReason)"
    }
    if (-not $okClaude) {
        Write-Host "Claude Code работает и в терминале командой claude; панель в VS Code можно поставить позже."
        $reason = Get-HmExtWhy $oc
        if (-not $okCodex) { $reason = $(if ($reason) { "$reason; " } else { '' }) + 'Codex тоже не встал (он необязателен)' }
        Write-Host (Format-HmPartialLine 'нет панели Claude Code — Extensions → «Claude Code» → Install (или code --install-extension anthropic.claude-code).' $reason)
    } else {
        # Панель Claude на месте; нет только необязательного Codex. Если вшитого vsix нет — путь
        # только через Marketplace, и «нужен интернет» говорим лишь когда запуск дошёл до VS Code.
        Write-Host (Format-HmPartialLine 'нет Codex (необязательный) — VS Code → Extensions → «Codex» → Install.' (Get-HmExtWhy $ox))
    }
    exit 121
} finally {
    Remove-HmVsixTemps
}
