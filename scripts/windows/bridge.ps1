# AI-мост (Hamidun Bridge) — Windows: ставим агент + автозапуск (трей)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_deelev.ps1')  # Invoke-HmDeElevated (укреплённая де-элевация, fail-closed)
. (Join-Path $PSScriptRoot '_linksafe.ps1')  # Write-HmUserFile: агент и config.json пишутся без хода по ссылке (junction на %LOCALAPPDATA%\HamidunBridge, symlink на файл)
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
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}
Update-Path
$DRY = [bool]$env:HM_DRY_RUN

$dst = Join-Path $env:LOCALAPPDATA 'HamidunBridge'
$agentSrc = if ($env:HM_AGENT_DIR) { Join-Path $env:HM_AGENT_DIR 'bridge_agent.py' } else { '' }
if (-not ($agentSrc -and (Test-Path $agentSrc))) { Write-Host "Агент моста не найден в сборке ($agentSrc)."; exit 1 }

if ($DRY) {
    Write-Host "  [dry-run] WOULD: агент -> $dst, pip pystray pillow, Run-автозапуск, OpenSSH, ssh -D"
    Write-Host "[dry-run] AI-мост: ветка выбрана, без изменений."; exit 0
}

# 1. OpenSSH Client (нужен для ssh -D; в Win10 1809+ обычно есть)
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host "Ставлю OpenSSH Client..."
    try { Get-WindowsCapability -Online -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'OpenSSH.Client*' -and $_.State -ne 'Installed' } | ForEach-Object { Add-WindowsCapability -Online -Name $_.Name | Out-Null } } catch {}
    Update-Path
}
# ssh критичен для туннеля — если Features-on-Demand недоступен (корпоративный WSUS,
# офлайн), молча объявить мост «установленным» нельзя.
$sshOk = [bool](Get-Command ssh -ErrorAction SilentlyContinue)
if (-not $sshOk) {
    Write-Host "ВНИМАНИЕ: OpenSSH Client не установился — мост не сможет построить туннель."
    Write-Host "  Установи вручную: Параметры → Приложения → Дополнительные компоненты → Клиент OpenSSH."
}

# 2. реальный Python (не Store-заглушка) — ТОТ ЖЕ поиск, что у доводки рантайма в
#    config.ps1: python/python3 мимо WindowsApps, затем известные каталоги установки.
#    Раньше здесь были только `python` и Python313/312, и мост писал «Python не найден»
#    там, где соседние шаги Python находили (Python311, Program Files, python3).
$py = ''
foreach ($name in 'python', 'python3') {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and $c.Source -notmatch 'WindowsApps') { $py = $c.Source; break }
}
if (-not $py) {
    foreach ($p in @("$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
                     "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
                     "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
                     "$env:ProgramFiles\Python313\python.exe",
                     "$env:ProgramFiles\Python312\python.exe")) {
        if (Test-Path -LiteralPath $p) { $py = $p; break }
    }
}
if (-not $py) { Write-Host "Python не найден — выберите компонент «Python-пакеты»."; exit 1 }
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'

# 3. агент + зависимости (офлайн из wheels если есть)
# Каталог моста лежит в профиле, а запись идёт под администратором: junction на %LOCALAPPDATA%\HamidunBridge (или выше по
# пути) уводил New-Item и Copy-Item в чужую папку, а file-symlink на bridge_agent.py — запись в её цель. Каталог создаётся
# и проверяется по цепочке от профиля, файл ложится переносом по имени (Write-HmUserFile). Агент — наш файл: «только чтение»
# с него снимается, как снимал прежний Copy-Item -Force.
try { Write-HmUserFile -Path (Join-Path $dst 'bridge_agent.py') -Bytes ([System.IO.File]::ReadAllBytes($agentSrc)) -ClearReadOnly }
catch {
    Write-Host "ОШИБКА: агент моста не записан в $dst ($($_.Exception.Message)) — мост НЕ установлен. Если на пути к папке моста стоит ссылка (junction/symlink), удали её (rmdir снимает только ссылку) и повтори установку."
    exit 1
}
$wheels = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'pywheels' } else { '' }
# SECURITY (#6): $py/$pyw лежат в user-профиле — они USER-WRITABLE. Запуск '& $py' в ЭТОМ
# скрипте (установщик requireAdministrator -> high integrity) исполнил бы user-writable python
# под АДМИНОМ: medium-малварь ТОГО ЖЕ юзера подменяет python -> RCE под админом. Плюс
# 'pip install --user' под админ-токеном ставит в ЧУЖОЙ (админский) профиль, а не юзера.
# Поэтому pip install И import-check гоним ДЕ-ЭЛЕВИРОВАННО (Invoke-HmDeElevatedSafe: задача
# планировщика, а если доказано, что она ничего не запустила, — токен оболочки Explorer; оба на
# medium). FAIL-CLOSED: не отработал ни один путь (Gate!='medium') -> трей-пакеты ПРОПУСКАЕМ и
# предупреждаем; НЕ откатываемся на '& $py' под high integrity.
# '--user' ОБЯЗАТЕЛЕН: pydeps ставит Python для пользователя (InstallAllUsers=0, site-packages
# пишется от него), но Python ищется и по МАШИННОМУ PATH (Get-Command выше) — а у Python «для
# всех» в Program Files site-packages на medium не пишется, и pip без --user падал бы отказом в
# доступе. --user кладёт пакеты в %APPDATA%\Python\Python3XY\site-packages — годится для обоих.
$pipArgs = if ($wheels -and (Test-Path $wheels)) {
    @('-m', 'pip', 'install', '--user', '--no-index', '--find-links', $wheels, 'pystray', 'pillow')
} else {
    @('-m', 'pip', 'install', '--user', 'pystray', 'pillow')
}
# pystray и PIL на ДИСКЕ: пользовательский site-packages (pip --user) или site-packages самого
# Python (если пакеты уже стояли). Только чтение — это аттестация, а не вывод pip.
function Test-HmBridgeTrayPackages($pyExe) {
    $roots = @()
    if ($env:APPDATA) {
        $roots += @(Get-ChildItem -LiteralPath (Join-Path $env:APPDATA 'Python') -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'site-packages' })
    }
    $roots += (Join-Path (Split-Path $pyExe) 'Lib\site-packages')
    foreach ($r in $roots) {
        if ((Test-Path -LiteralPath (Join-Path $r 'pystray')) -and (Test-Path -LiteralPath (Join-Path $r 'PIL'))) { return $true }
    }
    return $false
}
$trayOk    = $false
$pipExit   = -1
$deElevOk  = $false
$deElevWhy = ''
$pipRes = Invoke-HmDeElevatedSafe $py $pipArgs -Label 'bridge-pip'
if ($null -ne $pipRes -and $pipRes.Gate -eq 'medium') {
    $deElevOk = $true
    $pipExit  = $pipRes.Code
    # import-check ТОЖЕ де-элевированно (запуск user-writable python под админом = тот же вектор).
    $impRes = Invoke-HmDeElevatedSafe $py @('-c', 'import pystray, PIL') -Label 'bridge-import'
    # Итог — по ДИСКУ (пакеты на месте). Код импорта — второе мнение: может забраковать
    # (пакеты битые), но подтвердить без файлов на диске не может.
    $trayOk = (Test-HmBridgeTrayPackages $py) -and ($impRes.Gate -ne 'medium' -or $impRes.Code -eq 0)
} elseif ($null -ne $pipRes) {
    $deElevWhy = [string]$pipRes.ShellReason
}
if (-not $deElevOk) {
    Write-Host "ВНИМАНИЕ: безопасная (де-элевированная) установка недоступна$(if ($deElevWhy) { " ($deElevWhy)" }) — пропускаю пакеты трея (pystray/pillow), НЕ ставлю их под правами администратора."
    Write-Host "Мост будет работать в фоне; значок в трее появится после ручной установки от своего пользователя: py -m pip install --user pystray pillow"
} elseif (-not $trayOk) {
    Write-Host "ВНИМАНИЕ: pystray/pillow не установились (pip exit=$pipExit) — значок в трее будет недоступен."
    Write-Host "Мост сможет работать в фоне, но переключать его из трея не получится, пока не поставите пакеты."
}

# 4. конфиг агента (если ещё нет)
$cfgPath = Join-Path $dst 'config.json'
$cfgOk = $true   # «Сервер настроен» объявляем ТОЛЬКО если запись конфига реально удалась
if (-not (Test-Path $cfgPath)) {
    $domains = if ($env:HM_BRIDGE_PACDOMAINS) { $env:HM_BRIDGE_PACDOMAINS.Split(',') } else { @('claude.ai', 'anthropic.com', 'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com', 'claudeusercontent.com', 'sora.com', 'higgsfield.ai') }
    $cfgJson = ([ordered]@{
        enrollEndpoint = "$($env:HM_BRIDGE_ENDPOINT)"; bridgeToken = "$($env:HM_BRIDGE_TOKEN)"
        ssh = [ordered]@{ host = ''; port = 22; user = ''; keyPath = ''; password = '' }
        socksPort = 1080; httpPort = 1081; pacPort = 1082; pacDomains = $domains; enabled = $false
    } | ConvertTo-Json -Depth 5)
    # Windows PowerShell 5.1 «Set-Content -Encoding utf8» пишет UTF-8 С BOM, а
    # bridge_agent.py json.load на BOM падал → конфиг молча терялся. Пишем БЕЗ BOM
    # через .NET UTF8Encoding с флагом «не эмитить BOM» ($false). Запись — переносом по имени
    # (Write-HmUserFile), а не WriteAllText по имени: symlink на config.json вёл бы запись в её цель.
    try { Write-HmUserFile -Path $cfgPath -Bytes ((New-Object System.Text.UTF8Encoding -ArgumentList $false).GetBytes($cfgJson)) }
    catch {
        $cfgOk = $false
        Write-Host "Не удалось записать config.json моста: $($_.Exception.Message)"
    }
} elseif ($env:HM_BRIDGE_ENDPOINT -and (Test-HmIsReparse $cfgPath)) {
    # Ссылка на самом config.json: читать её незачем — в токен и адрес сервера легло бы содержимое чужой цели.
    $cfgOk = $false
    Write-Host "Не удалось обновить адрес сервера в существующем config.json: сам файл — ссылка (symlink), а установщик работает с правами администратора и сквозь ссылки не пишет."
} elseif ($env:HM_BRIDGE_ENDPOINT) {
    # config.json уже есть, но издатель пересобрал установщик с адресом сервера —
    # доставляем новый endpoint/token в существующий конфиг, сохраняя ssh/enabled ученика.
    # Иначе «Сервер настроен» печаталось бы, а агент по-прежнему простаивал бы с пустым endpoint.
    try {
        $cfg = Get-Content -Raw $cfgPath | ConvertFrom-Json
        $cfg.enrollEndpoint = "$($env:HM_BRIDGE_ENDPOINT)"
        # Пустой HM_BRIDGE_TOKEN НЕ затирает сохранённый bridgeToken ученика: env установщика
        # на Windows строится с нуля и токен туда часто не попадает вовсе, а config.json —
        # PRESERVE-файл (src/uninstall-targets.js), его значения ценны. Пишем ТОЛЬКО непустое.
        if ($env:HM_BRIDGE_TOKEN) {
            if ($null -ne $cfg.PSObject.Properties['bridgeToken']) { $cfg.bridgeToken = "$($env:HM_BRIDGE_TOKEN)" }
            else { $cfg | Add-Member -NotePropertyName bridgeToken -NotePropertyValue "$($env:HM_BRIDGE_TOKEN)" -Force }
        }
        Write-HmUserFile -Path $cfgPath -Bytes ((New-Object System.Text.UTF8Encoding -ArgumentList $false).GetBytes(($cfg | ConvertTo-Json -Depth 5)))
    } catch {
        # Битый JSON / сбой записи: адрес сервера НЕ доставлен — «Сервер настроен» внизу
        # печатать нельзя (раньше catch только логировал, а успех объявлялся всё равно).
        $cfgOk = $false
        Write-Host "Не удалось обновить адрес сервера в существующем config.json: $($_.Exception.Message)"
    }
}

# 5. гейт работоспособности + автозапуск (Run) + запуск сейчас (трей)
$run = if (Test-Path $pyw) { $pyw } else { $py }
$agentPath = Join-Path $dst 'bridge_agent.py'
# Гейт работоспособности автозапуска — свойство ПОДСИСТЕМЫ (парити с bridge.sh): агент
# прогоняется режимом --selftest (без побочных эффектов: не берёт порт-замок, не поднимает
# серверы, не трогает системный прокси) ДО записи HKCU\Run. Раньше Run прописывался ВСЛЕПУЮ —
# заведомо нерабочий агент молча запускался бы при каждом входе в Windows.
# SECURITY (#6): $py user-writable — selftest гоним ДЕ-ЭЛЕВИРОВАННО (Invoke-HmDeElevatedSafe),
# как pip/import выше. FAIL-CLOSED: ни один путь не отработал (Gate != 'medium') →
# работоспособность НЕ доказана → автозапуск НЕ прописываем. Существующий Run-ключ, если
# он был, НЕ трогаем — как bridge.sh не трогает прежний LaunchAgent при провале пробы.
# Здесь код выхода и ЕСТЬ проверяемый факт: самопроверка — функциональная проба агента,
# следа на диске у неё нет; ошибка в ней стоит лишь автозапуска, а не прав.
$agentOk = $false
$trayStarted = $false   # трей запущен ЭТИМ прогоном (токен оболочки принят, процесс не упал за 3 с) — от него итоговая строка
$stRes = Invoke-HmDeElevatedSafe $py @($agentPath, '--selftest') -Label 'bridge-selftest'
if ($null -ne $stRes -and $stRes.Gate -eq 'medium' -and $stRes.Code -eq 0) { $agentOk = $true }
if ($agentOk) {
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HamidunBridge' -Value ("`"$run`" `"$agentPath`"") -PropertyType String -Force | Out-Null
    # SECURITY (#6): запуск трея сейчас — НЕ Start-Process под ELEVATED (это стартовало бы
    # user-writable pythonw/python под АДМИНОМ; medium-малварь юзера подменит бинарь -> RCE) и НЕ
    # explorer.exe <лаунчер>: без живой оболочки (её может прибить малварь того же юзера) наш
    # elevated explorer исполнил бы файл САМ, под админом, по обработчику из HKCU\Software\Classes.
    # Запускаем ТОКЕНОМ ОБОЛОЧКИ (Invoke-HmAsShellUser: ровно medium и тот же пользователь,
    # проверяется ДО запуска) и БЕЗ файла-лаунчера: писать .cmd в пользовательскую папку из-под
    # админа незачем, а агент берёт свой каталог из LOCALAPPDATA и от рабочей папки не зависит
    # (из HKCU\Run он стартует точно так же). Трей — long-running процесс, поэтому -NoWait, а не
    # Invoke-HmDeElevated (он блокирует и удаляет одноразовую задачу -> убил бы трей); процесс
    # ждём лишь 3 с, чтобы поймать мгновенное падение. Нет оболочки / она не обычного уровня /
    # отключена служба «Вторичный вход» — НЕ запускаем ничего (ни explorer, ни под админом):
    # трей поднимется при следующем входе в Windows через HKCU\Run. Исход шага от этого не меняется.
    $trayRes = $null
    $trayWhy = ''
    try { $trayRes = Invoke-HmAsShellUser -Exe $run -Arguments @($agentPath) -NoWait -Label 'bridge-tray' }
    catch { $trayWhy = $_.Exception.Message }
    if ($null -ne $trayRes -and $trayRes.Gate -eq 'medium') {
        if ($trayRes.Code -ne 0) {
            Write-Host "  ВНИМАНИЕ: мост запустился и сразу закрылся (код $($trayRes.Code)) — он стартует при следующем входе в Windows (автозапуск)."
        } else { $trayStarted = $true }
    } else {
        if ($null -ne $trayRes) { $trayWhy = [string]$trayRes.Reason }
        if (-not $trayWhy) { $trayWhy = 'причина не определена' }
        Write-Host "  ВНИМАНИЕ: мост сейчас запустить не удалось: $trayWhy. Под правами администратора я его не запускаю — он стартует при следующем входе в Windows (автозапуск)."
    }
} elseif ($null -eq $stRes -or $stRes.Gate -ne 'medium') {
    # Не «агент сломан», а «проверить нечем»: разные беды, разные советы человеку.
    $stWhy = if ($null -ne $stRes -and $stRes.ShellReason) { " ($($stRes.ShellReason))" } else { '' }
    Write-Host "  ВНИМАНИЕ: самопроверку агента от имени пользователя запустить не удалось$stWhy — автозапуск НЕ прописываю."
    Write-Host "  Запусти мост вручную от своего пользователя: pythonw `"$agentPath`""
} else {
    Write-Host "  ВНИМАНИЕ: агент моста не прошёл самопроверку на этой системе (код $($stRes.Code)) — автозапуск НЕ прописываю."
    Write-Host "  (иначе Windows молча запускала бы нерабочий агент при каждом входе)"
}

# P0-4: квитанция владения — ТОЧНЫЕ пути/реестр созданных артефактов (main соберёт в receipt).
# Реестровую строку эмитим ТОЛЬКО если Run-ключ реально писали (гейт агента пройден).
Write-Host "HM-RECEIPT path $dst"
if ($agentOk) { Write-Host "HM-RECEIPT reg HKCU|Software\Microsoft\Windows\CurrentVersion\Run|HamidunBridge" }

# Значок обещаем «сейчас» только если трей реально запущен: при отказе токена оболочки (UAC выключен,
# нет Проводника…) он появится при следующем входе в Windows — так и пишем, а не «значок в трее».
$trayMsg = if (-not $trayOk) { 'фоновый режим без значка (pystray/pillow не встали)' }
           elseif ($trayStarted) { 'значок в трее' }
           else { 'значок в трее появится после следующего входа в Windows' }
if (-not $agentOk) {
    # Автозапуска нет — «мост установлен» был бы неправдой. Распакован — честно (парити bridge.sh).
    Write-Host "OK: AI-мост распакован, автозапуск не ставился (агент не прошёл самопроверку)"
} elseif ($env:HM_BRIDGE_ENDPOINT -and $cfgOk) {
    Write-Host "OK: AI-мост установлен ($trayMsg). Сервер настроен — включай в трее."
} elseif ($env:HM_BRIDGE_ENDPOINT) {
    Write-Host "OK: AI-мост установлен ($trayMsg). ВНИМАНИЕ: адрес сервера в конфиг записать не удалось — настройка сервера НЕ подтверждена."
} else {
    Write-Host "OK: AI-мост установлен ($trayMsg). Сервер ещё не настроен — мост включится, когда получишь доступ в боте."
}
exit 0
