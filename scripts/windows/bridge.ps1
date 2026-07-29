# AI-мост (Hamidun Bridge) — Windows: ставим агент + автозапуск (трей)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_deelev.ps1')  # Invoke-HmDeElevated (укреплённая де-элевация, fail-closed)
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

# 2. реальный Python (не Store-заглушка)
$py = ''
$c = Get-Command python -ErrorAction SilentlyContinue
if ($c -and $c.Source -notmatch 'WindowsApps') { $py = $c.Source }
if (-not $py) { foreach ($p in @("$env:LOCALAPPDATA\Programs\Python\Python313\python.exe", "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe")) { if (Test-Path $p) { $py = $p; break } } }
if (-not $py) { Write-Host "Python не найден — выберите компонент «Python-пакеты»."; exit 1 }
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'

# 3. агент + зависимости (офлайн из wheels если есть)
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Force $agentSrc (Join-Path $dst 'bridge_agent.py')
$wheels = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'pywheels' } else { '' }
# SECURITY (#6): $py/$pyw лежат в user-профиле — они USER-WRITABLE. Запуск '& $py' в ЭТОМ
# скрипте (установщик requireAdministrator -> high integrity) исполнил бы user-writable python
# под АДМИНОМ: medium-малварь ТОГО ЖЕ юзера подменяет python -> RCE под админом. Плюс
# 'pip install --user' под админ-токеном ставит в ЧУЖОЙ (админский) профиль, а не юзера.
# Поэтому pip install И import-check гоним ДЕ-ЭЛЕВИРОВАННО (Invoke-HmDeElevated, medium integrity,
# schtasks). FAIL-CLOSED: примитив недоступен ($null) или отработал НЕ на medium (Gate!='medium')
# -> трей-пакеты ПРОПУСКАЕМ и предупреждаем; НЕ откатываемся на '& $py' под high integrity.
$pipArgs = if ($wheels -and (Test-Path $wheels)) {
    @('-m', 'pip', 'install', '--user', '--no-index', '--find-links', $wheels, 'pystray', 'pillow')
} else {
    @('-m', 'pip', 'install', '--user', 'pystray', 'pillow')
}
$trayOk   = $false
$pipExit  = -1
$deElevOk = $false
$pipRes = Invoke-HmDeElevated $py $pipArgs
if ($null -ne $pipRes -and $pipRes.Gate -eq 'medium') {
    $deElevOk = $true
    $pipExit  = $pipRes.Code
    # import-check ТОЖЕ де-элевированно (запуск user-writable python под админом = тот же вектор).
    $impRes = Invoke-HmDeElevated $py @('-c', 'import pystray, PIL')
    $trayOk = ($null -ne $impRes -and $impRes.Gate -eq 'medium' -and $impRes.Code -eq 0)
}
if (-not $deElevOk) {
    Write-Host "ВНИМАНИЕ: безопасная (де-элевированная) установка недоступна — пропускаю пакеты трея (pystray/pillow), НЕ ставлю их под правами администратора."
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
    # через .NET UTF8Encoding с флагом «не эмитить BOM» ($false).
    [System.IO.File]::WriteAllText($cfgPath, $cfgJson, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
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
        [System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding -ArgumentList $false))
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
# SECURITY (#6): $py user-writable — selftest гоним ДЕ-ЭЛЕВИРОВАННО (Invoke-HmDeElevated),
# как pip/import выше. FAIL-CLOSED: примитив недоступен ($null) или Gate != 'medium' →
# работоспособность НЕ доказана → автозапуск НЕ прописываем. Существующий Run-ключ, если
# он был, НЕ трогаем — как bridge.sh не трогает прежний LaunchAgent при провале пробы.
$agentOk = $false
$stRes = Invoke-HmDeElevated $py @($agentPath, '--selftest')
if ($null -ne $stRes -and $stRes.Gate -eq 'medium' -and $stRes.Code -eq 0) { $agentOk = $true }
if ($agentOk) {
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HamidunBridge' -Value ("`"$run`" `"$agentPath`"") -PropertyType String -Force | Out-Null
    # SECURITY (#6): запуск трея сейчас — НЕ Start-Process под ELEVATED (это стартовало бы
    # user-writable pythonw/python под АДМИНОМ; medium-малварь юзера подменит бинарь -> RCE).
    # Запускаем ДЕ-ЭЛЕВИРОВАННО через explorer.exe (паттерн mascot.ps1): explorer стартует .cmd-
    # лаунчер токеном ОБОЛОЧКИ (medium integrity), не под админом. Трей — long-running процесс,
    # поэтому НЕ Invoke-HmDeElevated (он блокирует и удаляет одноразовую задачу -> убил бы трей).
    # Лаунчер задаёт фиксированный cwd; UTF-8 + `chcp 65001` — на случай не-ASCII пути профиля.
    # Если запуск сейчас не удастся — трей поднимется при следующем входе в Windows через HKCU\Run.
    $launchCmd = Join-Path $dst 'launch-bridge.cmd'
    $cmdBody = "@echo off`r`nchcp 65001 >nul`r`ncd /d `"$dst`"`r`nstart `"`" `"$run`" `"$agentPath`"`r`n"
    try {
        [System.IO.File]::WriteAllText($launchCmd, $cmdBody, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
        Start-Process -FilePath "$env:WINDIR\explorer.exe" -ArgumentList "`"$launchCmd`"" -ErrorAction Stop
    } catch {
        Write-Host "  Не удалось запустить мост сейчас ($($_.Exception.Message)) — он стартует при следующем входе в Windows (автозапуск)."
    }
} else {
    Write-Host "  ВНИМАНИЕ: агент моста не прошёл самопроверку на этой системе — автозапуск НЕ прописываю."
    Write-Host "  (иначе Windows молча запускала бы нерабочий агент при каждом входе)"
}

# P0-4: квитанция владения — ТОЧНЫЕ пути/реестр созданных артефактов (main соберёт в receipt).
# Реестровую строку эмитим ТОЛЬКО если Run-ключ реально писали (гейт агента пройден).
Write-Host "HM-RECEIPT path $dst"
if ($agentOk) { Write-Host "HM-RECEIPT reg HKCU|Software\Microsoft\Windows\CurrentVersion\Run|HamidunBridge" }

$trayMsg = if ($trayOk) { 'значок в трее' } else { 'фоновый режим без значка (pystray/pillow не встали)' }
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
