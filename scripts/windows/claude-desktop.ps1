# Claude Desktop (нативное приложение Anthropic) — Windows. ОПЦИОНАЛЬНЫЙ компонент.
#
# Модель угроз (тот же класс, что и remote-fetch/uv): установщик работает ELEVATED
# (requireAdministrator) и ЗАПУСКАЕТ скачанный из сети установщик. Скачивание+запуск
# ЧУЖОГО бинаря под админом = privesc-поверхность. Инвариант — НЕ запускать
# НЕпроверенный бинарь и НЕ дать medium-integrity малвари ТОГО ЖЕ юзера подменить
# файл между «скачал» и «запустил» (TOCTOU). Поэтому:
#
#   1. СКАЧИВАЕМ официальный установщик Anthropic по HTTPS в ADMIN-OWNED SECURE-CACHE —
#      свежий random-leaf каталог под %ProgramData%, рождённый АТОМАРНО с owner=
#      Administrators + DACL {SYSTEM, Administrators: FullControl}, protection on, БЕЗ
#      user-SID (тот же укреплённый примитив New-HmSecureStagingDir из _deelev.ps1, что
#      запирает de-elevation staging и кэш докачки в main.js). Users писать туда НЕ
#      могут ПО КОНСТРУКЦИИ → medium-малварь не может ни пред-создать файл, ни держать
#      write-handle, ни подменить его до/после проверки подписи (ZIP/EXE-TOCTOU закрыт).
#      Это НЕ user-writable %TEMP%.
#
#   2. ГЛАВНЫЙ ГЕЙТ ЦЕЛОСТНОСТИ — Authenticode-подпись ДО запуска (вместо SHA-пиннинга:
#      версии десктопа меняются, зашитый sha устарел бы). НАДЁЖНАЯ проверка — общая функция
#      примитива Test-HmTrustedSigner (_deelev.ps1; у этого скрипта своей копии больше нет):
#      (a) Get-AuthenticodeSignature Status=Valid — хеш файла не подменён (файл целостен);
#      (b) цепочка leaf-серта строится, и её КОРЕНЬ обязан лежать в МАШИННОМ доверенном
#          сторе (LocalMachine\Root). CurrentUser\Root НЕ доверяем: medium-integrity малварь
#          ТОГО ЖЕ юзера может отравить его своим самоподписанным корнем БЕЗ прав админа
#          (в machine-стор без админа не записать) → закрываем spoofing через user-cert-store;
#          звено цепочки вне срока принимается только по метке времени от TSA, чей корень тоже
#          в LocalMachine\Root (короткоживущий лист уже истёк, а подпись цела);
#      (c) поле Organization (O=) leaf-серта ТОЧНО равно 'Anthropic, PBC' (парсим RDN, а НЕ
#          подстрока по всему Subject: 'CN=Evil,OU=Anthropic' НЕ пройдёт);
#      (d) EKU включает Code Signing. Публичный CA не выпишет злоумышленнику серт с
#          O='Anthropic, PBC' → обход закрыт даже без секретного thumbprint'а (опц. пин ниже).
#      Любой невыполненный вентиль → fail-closed (exit 120 skip, НЕ запускаем).
#
#   3. ЗАПУСК из ЗАЩИЩЁННОГО КЭША (RUN-FROM-PROTECTED, как uv.ps1). Каталог Admins-only
#      → medium-малварь не подменила бинарь; подпись Anthropic проверена → бинарь
#      ДОВЕРЕН. Запуск идёт elevated: де-элевированный запуск ИЗ Admins-only каталога
#      непрактичен (medium-токен не имеет доступа на чтение к Admins-only DACL), а
#      ослаблять укреплённый примитив (добавлять user-ACE) означало бы вернуть тот
#      самый user-writable staging, от которого мы защищались. CWD = защищённый кэш
#      (анти DLL-planting из рабочего каталога). Установщик Claude Desktop — per-user
#      Squirrel: при обычном админе %LOCALAPPDATA% указывает на его профиль. Остаточный
#      риск (доверенный установщик может распаковать бутстрап в user %TEMP% и запустить
#      оттуда) — тот же осознанно принятый вектор, что описан в THREAT-MODEL.md.
#
#   4. Идемпотентность: приложение уже стоит (детект пути) → ничего не делаем, exit 0.
#      Нет сети / скачивание не удалось / подпись не прошла → exit 120 (graceful skip,
#      НЕ красная ошибка). Секьюр-кэш чистим в finally.
#
#   Авто-удаление НЕ поддерживаем (чужое приложение): компонент только СТАВИТ; кнопка
#   «Удалить» для него в UI не показывается (не в REMOVABLE).
#
# Значения, подтверждённые сетью (2026-07): Windows-бинари Anthropic подписаны с Subject
#   Organization O='Anthropic, PBC'; официальный redirect claude.ai/api/desktop/win32/... →
#   downloads.claude.ai/.../ClaudeSetup-*.exe.
# TODO-verify (опц. усиление, НЕ обязательно): $LEAF_THUMBPRINT — SHA1-отпечаток leaf-серта
#   Anthropic. По умолчанию ПУСТО (пин выключен): основной контроль — цепочка-к-машинному-
#   корню + точное O= + Code Signing EKU, он fail-closed и без thumbprint'а. ВНИМАНИЕ: отпечаток
#   ЛИСТА перевыпуск сертификата не переживает — вписанная константа протухнет, и установка молча
#   станет пропуском (exit 120); вписывать, только если готов менять её вместе с релизом издателя.
#   Снять: (Get-AuthenticodeSignature .\ClaudeSetup.exe).SignerCertificate.Thumbprint. Пусто — безопасно.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_deelev.ps1')  # New-HmSecureStagingDir (атомарный Admins-only каталог)

$DRY = [bool]$env:HM_DRY_RUN

# --- Официальные endpoint'ы Anthropic (HTTPS, редиректят на downloads.claude.ai) ---
$URL_X64   = 'https://claude.ai/api/desktop/win32/x64/setup/latest/redirect'
$URL_ARM64 = 'https://claude.ai/api/desktop/win32/arm64/setup/latest/redirect'
# ТОЧНОЕ поле Organization (O=) в Subject Authenticode-подписи Anthropic (гейт целостности; network-confirmed).
$PUBLISHER_O = 'Anthropic, PBC'
# Опциональный пин SHA1-отпечатка leaf-серта (по умолчанию выкл; см. TODO-verify выше).
$LEAF_THUMBPRINT = ''

# --- Проверка Authenticode — ЕДИНАЯ функция примитива: Test-HmTrustedSigner (_deelev.ps1) ---
# Раньше тут жила своя копия (цепочка «на сегодня» без флагов + O= по тексту RDN) и расходилась с общей:
#   • срок: подписанту с уже истёкшим коротким листом (метка времени у подписи есть, Status='Valid') цепочка
#     «на сегодня» отказывала с NotTimeValid — теперь срок звеньев решает метка времени от машинного TSA;
#   • пин O='Anthropic, PBC' не совпадал НИКОГДА: .NET берёт значение с запятой в кавычки, и сравнивалось
#     '"Anthropic, PBC"' — установка Claude Desktop всегда уходила в exit 120.
# Контракт прежний: '' — бинарь ДОВЕРЕН, иначе строка-причина (у вызывающего → fail-closed). Проверяется
# Status=Valid + цепочка к корню в LocalMachine\Root (CurrentUser\Root не доверяем) + EKU Code Signing + точное
# O= (-ExpectedOrg) + необязательный отпечаток листа (-ExpectedThumbprint).

# --- Идемпотентность: уже установлен? (Win32 Squirrel ИЛИ MSIX/Store) ---
function Test-ClaudeDesktopInstalled {
    $la = $env:LOCALAPPDATA
    if ($la) {
        $cands = @(
            (Join-Path $la 'AnthropicClaude\claude.exe'),
            (Join-Path $la 'Microsoft\WindowsApps\claude.exe')
        )
        foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { return $true } }
        $appDir = Join-Path $la 'AnthropicClaude'
        if (Test-Path -LiteralPath $appDir) {
            $hit = Get-ChildItem -Path $appDir -Filter 'claude.exe' -Recurse -File -ErrorAction SilentlyContinue |
                   Select-Object -First 1
            if ($hit) { return $true }
        }
    }
    # MSIX/Store-вариант Claude Desktop.
    try {
        if (Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'Claude' -and $_.Publisher -match 'Anthropic' } | Select-Object -First 1) { return $true }
    } catch { }
    return $false
}

# --- Вердикт «установлено?» — по ФАКТИЧЕСКОМУ результату, не по гонке с установщиком. ---
# Пойманный дефект: снятый -Wait (убран нарочно — он ждёт всё ДЕРЕВО потомков, а приложение
# живёт в трее => вечное зависание) превратил ожидание в гонку: фиксированный опрос 90 с
# выносил «не подтвердилось», пока установщик ЕЩЁ РАБОТАЛ. Правила этой функции:
#   • пока процесс установщика ЖИВ — ждём (маркер может появиться в любой момент);
#   • после его выхода Squirrel докручивает асинхронно — даём грейс $GraceSec;
#   • бесконечного ожидания НЕТ: жёсткий потолок $CapSec. Смотрим ТОЛЬКО на сам процесс
#     ($Proc.HasExited), а не на дерево потомков — трей приложения нас не держит.
# Возвращает $true, если установка подтверждена маркером (Test-ClaudeDesktopInstalled).
function Wait-HmClaudeDesktopVerdict {
    param($Proc, [int]$CapSec = 300, [int]$GraceSec = 90)
    $deadline  = (Get-Date).AddSeconds($CapSec)
    $graceLeft = $GraceSec
    while ((Get-Date) -lt $deadline) {
        if (Test-ClaudeDesktopInstalled) { return $true }
        $exited = $true
        try { if ($Proc) { $exited = $Proc.HasExited } } catch { }
        if ($exited) {
            if ($graceLeft -le 0) { return $false }
            $graceLeft--
        }
        Start-Sleep -Seconds 1
    }
    # Потолок исчерпан (установщик так и не вышел) — последний взгляд на маркер.
    return (Test-ClaudeDesktopInstalled)
}

if (Test-ClaudeDesktopInstalled) {
    Write-Host "Claude Desktop уже установлен — пропускаю (ничего не скачиваю)."
    exit 0
}

# Выбираем сборку под архитектуру.
$arch = "$env:PROCESSOR_ARCHITECTURE"
$url = if ($arch -match 'ARM64') { $URL_ARM64 } else { $URL_X64 }

if ($DRY) {
    Write-Host "  [dry-run] WOULD: New-HmSecureStagingDir (Admins-only %ProgramData%\HmDeElev-*), скачать $url в него по HTTPS, Test-HmTrustedSigner → Status Valid + цепочка к LocalMachine\Root + O='$PUBLISHER_O' + Code Signing EKU (ДО запуска, fail-closed), запустить проверенный установщик ИЗ защищённого кэша, дождаться claude.exe, почистить кэш."
    exit 0
}

# --- 1. ADMIN-OWNED SECURE-CACHE (тот же атомарный примитив, что и de-elevation) ---
$sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
$s32      = Join-Path $sysRoot 'System32'
$icacls   = Join-Path $s32 'icacls.exe'
$pdRoot   = [System.IO.Path]::GetPathRoot($sysRoot)
$progData = Join-Path $pdRoot 'ProgramData'
if (-not (Test-Path -LiteralPath $icacls) -or -not (Test-Path -LiteralPath $progData)) {
    Write-Host "Не найдены системные пути (icacls/ProgramData) — пропускаю Claude Desktop (поставь вручную с claude.com/download)."
    exit 120
}

$cache = New-HmSecureStagingDir -ProgramData $progData -Icacls $icacls -Elevated $true
if (-not $cache -or -not (Test-Path -LiteralPath $cache)) {
    Write-Host "Не удалось создать защищённый кэш (owner=Administrators + DACL {SYSTEM,Administrators}) — нужны права администратора. Пропускаю Claude Desktop (fail-closed)."
    exit 120
}

$installer = Join-Path $cache 'ClaudeSetup.exe'
$rc = 120
try {
    # --- 2. СКАЧИВАНИЕ по HTTPS в Admins-only кэш ---
    Write-Host "Скачиваю официальный установщик Claude Desktop (Anthropic) в защищённый кэш..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
    if ($url -notmatch '^https://') { Write-Host "URL не HTTPS — отказ (fail-closed)."; exit 120 }
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 600
    } catch {
        # Причину называем по факту, а не «нет сети?» на всё подряд. Живой журнал:
        # «(403) Запрещено» с сайта Anthropic — интернет работал, а сервер отказал по
        # адресу (страна/сеть). Совет в этом случае обратный: не чинить Wi-Fi, а
        # включить VPN на весь компьютер. Последняя строка — она же причина на финише.
        $httpCode = 0
        try { if ($_.Exception.Response) { $httpCode = [int]$_.Exception.Response.StatusCode } } catch { }
        if ($httpCode -eq 403 -or $httpCode -eq 451) {
            Write-Host "Сервер Anthropic отказал в скачивании (HTTP $httpCode): загрузка с твоего адреса закрыта — это не обрыв сети. Claude Desktop необязателен, всё остальное работает; поставить его можно позже с claude.com/download при VPN на весь компьютер. Пропускаю."
        } elseif ($httpCode -gt 0) {
            Write-Host "Сервер ответил ошибкой HTTP $httpCode — установщик Claude Desktop не скачался. Пропускаю; всё остальное работает, поставь его позже с claude.com/download."
        } else {
            Write-Host "Не удалось скачать установщик Claude Desktop: нет соединения с сервером ($($_.Exception.Message)). Пропускаю — всё остальное работает; поставь позже с claude.com/download."
        }
        exit 120
    }
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        Write-Host "Установщик не появился после скачивания — пропускаю Claude Desktop."
        exit 120
    }
    # Санити размера: слишком мал = страница ошибки; аномально велик = отвергаем.
    $len = (Get-Item -LiteralPath $installer).Length
    if ($len -lt 20MB -or $len -gt 900MB) {
        Write-Host "Скачанный файл имеет неожиданный размер ($([math]::Round($len/1MB)) МБ) — пропускаю Claude Desktop (fail-closed)."
        exit 120
    }

    # --- 3. НАДЁЖНЫЙ ГЕЙТ ПОДПИСИ ДО ЗАПУСКА (fail-closed) ---
    #     Проверяем ТОТ ЖЕ $installer, который сейчас запустим (без ре-резолва пути).
    $why = Test-HmTrustedSigner -Path $installer -ExpectedOrg $PUBLISHER_O -ExpectedThumbprint $LEAF_THUMBPRINT
    if ($why) {
        Write-Host "БЕЗОПАСНОСТЬ: установщик не прошёл надёжную проверку подписи ($why) — НЕ запускаю. Пропускаю Claude Desktop (fail-closed)."
        exit 120
    }
    Write-Host "Подпись подтверждена: цепочка к машинному корню + O='$PUBLISHER_O' + Code Signing EKU. Запускаю проверенный установщик из защищённого кэша..."

    # --- 4. ЗАПУСК проверенного установщика ИЗ ЗАЩИЩЁННОГО КЭША (CWD = кэш, анти DLL-planting) ---
    # БЕЗ -Wait. Ключевое: -Wait ждёт не процесс, а ВСЁ ДЕРЕВО потомков. Установщик
    # Claude Desktop — Squirrel: он докручивает установку асинхронно И САМ ЗАПУСКАЕТ
    # приложение, а Claude на Windows при закрытии окна уходит в трей и продолжает жить.
    # То есть шаг ждал бы до тех пор, пока человек не выгрузит программу из трея —
    # практически вечно, с бесконечным спиннером и без единого объяснения.
    # Ровно этот баг уже был пойман и починен для Cursor (cursor.ps1) — здесь тот же
    # рецепт: -PassThru нужен только чтобы прибрать Admins-only кэш после реального
    # выхода установщика, а факт установки подтверждает опрос Test-ClaudeDesktopInstalled.
    $cdProc = $null
    try {
        $cdProc = Start-Process -FilePath $installer -WorkingDirectory $cache -PassThru -ErrorAction Stop
    } catch {
        Write-Host "Установщик Claude Desktop не запустился ($($_.Exception.Message)) — пропускаю."
        exit 120
    }

    # Вердикт — по ФАКТУ (Wait-HmClaudeDesktopVerdict): ждём, пока установщик работает
    # (потолок 300 с, НЕ бесконечно), после его выхода даём Squirrel 90 с докрутить
    # асинхронную часть. Раньше здесь был фиксированный опрос 90 с, оторванный от процесса:
    # медленный (но живой) установщик получал «не подтвердилось» ДО своего завершения.
    $installed = Wait-HmClaudeDesktopVerdict -Proc $cdProc -CapSec 300 -GraceSec 90
    if ($installed) {
        Write-Host "OK: Claude Desktop установлен."
        # Квитанция владения (для справки; авто-удаление чужого приложения НЕ делаем).
        $appDir = Join-Path $env:LOCALAPPDATA 'AnthropicClaude'
        if (Test-Path -LiteralPath $appDir) { Write-Host "HM-RECEIPT path $appDir" }
        $rc = 0
    } else {
        $stillRunning = $false
        try { $stillRunning = ($cdProc -and -not $cdProc.HasExited) } catch { }
        if ($stillRunning) {
            Write-Host "Установщик Claude Desktop не завершился за 300 с и приложение не подтвердилось — успех НЕ рапортую. Дождись окончания установщика и проверь меню «Пуск»; при необходимости поставь заново с claude.com/download."
        } else {
            Write-Host "Установщик Claude Desktop завершился, но приложение не подтвердилось за 90 с после его выхода. Проверь меню «Пуск»; при необходимости поставь заново с claude.com/download."
        }
        $rc = 120
    }
} finally {
    # Кэш чистим ПОСЛЕ реального выхода установщика: пока его образ залочен, Remove-Item
    # тихо не срабатывает и каталог в ProgramData остаётся навсегда (owner=Administrators,
    # человеку он недоступен). Ждём ОГРАНИЧЕННО — вечное ожидание мы как раз и убираем.
    if ($cdProc) {
        try { $cdProc | Wait-Process -Timeout 120 -ErrorAction SilentlyContinue } catch { }
    }
    if ($cache) { Remove-HmSecureStagingDir -Path $cache }
}
exit $rc
