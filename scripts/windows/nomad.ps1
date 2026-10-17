# Nomad Agent — Windows (Python CLI via uv)
# Continue (не Stop): нативные команды (git/uv/python) пишут в stderr → под Stop = NativeCommandError и падение.
$ErrorActionPreference = 'Continue'
# irm|iex (ПОСЛЕДНИЙ онлайн-фолбэк в секции 2) тянет ОФИЦИАЛЬНЫЙ установщик uv (astral.sh)
# по HTTPS (доверие = TLS). Форсим TLS 1.2. Основной путь — офлайн: уже установленный uv
# или вшитый vendor-uv через uv.ps1 (SHA-256 fail-closed).
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
# #2: интегрити-гейт nomad-src (Confirm-HmArtifact + Get-HmTreeSha256 из _verify.ps1).
. (Join-Path $PSScriptRoot '_verify.ps1')
. (Join-Path $PSScriptRoot '_userpath.ps1')   # Add-HmUserPath: ~/.local\bin в PATH пользователя
. (Join-Path $PSScriptRoot '_linksafe.ps1')   # New-HmUserDir / Write-HmUserFile: брендинг и config.yaml пишутся без хода по ссылке

function Update-Path {
    # SECURITY (#4): PATH для elevated-скрипта — ТОЛЬКО HKLM (Machine) + наши
    # админ-owned фиксированные каталоги. НИКОГДА не читаем HKCU (User) PATH: на чистой
    # машине medium-integrity процесс того же юзера может дописать туда каталог с
    # подложенным git/node/python/winget и исполнить его под нашим elevated-токеном.
    # uv/nomad ставятся в user-профиль (~/.local\bin) — резолвим их по АБСОЛЮТНОМУ пути
    # (Resolve-UvExe / abs-fallback ниже), а НЕ через user-writable каталог в PATH.
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

# uv/nomad живут в user-профиле (~/.local\bin) и НЕ в elevated-PATH (см. Update-Path #4).
# Резолвим uv по абсолютному пути. ПЕРВЫМ — офлайн-каталог нашего компонента uv
# (%LOCALAPPDATA%\Programs\uv — туда его кладёт uv.ps1), затем Get-Command (если вдруг
# в Machine-PATH) → ~/.local\bin → WinGet Links.
function Resolve-UvExe {
    $ours = Join-Path $env:LOCALAPPDATA 'Programs\uv\uv.exe'
    if (Test-Path -LiteralPath $ours -PathType Leaf) { return $ours }
    $c = Get-Command uv -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { return $c.Source }
    foreach ($p in @((Join-Path $env:USERPROFILE '.local\bin\uv.exe'),
                     (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\uv.exe'))) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# Быстрая проба сети для секции 1b: TCP-коннект на 443 с коротким таймаутом (3 с),
# без скачиваний. github.com — оттуда `uv python install` тянет CPython
# (python-build-standalone), pypi.org — оттуда `uv tool install` резолвит зависимости.
# Достаточно ЛЮБОГО ответившего хоста (цель — отсечь полностью офлайн-машину).
# ТРИ попытки с растущим таймаутом, а не одна на 3 секунды. Единственная короткая проба
# решала судьбу компонента целиком: не ответила — exit 120, «поставь позже», и человек
# к этому шагу больше не возвращается. А не ответить она может на живой сети — холодный
# DNS на ноутбуке после сна, ещё переподключающийся Wi-Fi, VPN в момент подъёма. Цена
# ошибки несимметрична: лишние секунды ожидания против навсегда не поставленного агента.
# Реальный офлайн отвечает быстрым отказом DNS, а не таймаутом, поэтому длинные ожидания
# тратятся именно на «сеть висит» — тот случай, ради которого повтор и нужен.
function Test-NomadNetwork {
    foreach ($timeoutMs in @(3000, 5000, 8000)) {
        foreach ($nomadHost in @('github.com', 'pypi.org')) {
            try {
                $tcp = New-Object Net.Sockets.TcpClient
                $iar = $tcp.BeginConnect($nomadHost, 443, $null, $null)
                $ok  = $iar.AsyncWaitHandle.WaitOne($timeoutMs, $false)
                if ($ok -and $tcp.Connected) { $tcp.Close(); return $true }
                $tcp.Close()
            } catch {}
        }
        if ($timeoutMs -ne 8000) { Start-Sleep -Seconds 1 }
    }
    return $false
}

# Копия исходников Nomad для сборки: в ЗАЩИЩЁННОЙ папке (создаётся атомарно, доступ только у
# Администраторов и SYSTEM — тот же примитив New-HmSecureStagingDir, что у git/node/pydeps) и сверенная
# с манифестом УЖЕ ПОСЛЕ копирования.
# Почему так. uv не просто ставит пакет: несколько минут он резолвит и качает зависимости, а потом
# ИСПОЛНЯЕТ сборочный код проекта (pyproject.toml, setup.py, модули) — под администратором. Раньше копия
# лежала в %TEMP% (права пользователя): процесс обычного пользователя подменял в ней файл за эти минуты, и
# его код выполнялся у нас с правами администратора. Проверка суммы исходного дерева этого не закрывала:
# проверялся оригинал, а исполнялась копия. Теперь копия недоступна обычному процессу, и проверяется
# именно она — исполняется ровно то, что проверено.
# Возвращает { Stage; Path } или $null (причина напечатана, защищённая папка уже убрана). Папку Stage
# после сборки убирает вызывающий: Remove-HmSecureStagingDir. Нужен подключённый _deelev.ps1.
function New-HmNomadBuildCopy {
    param([Parameter(Mandatory = $true)][string]$Src, [Parameter(Mandatory = $true)][string]$TreeWant)
    $sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $icacls   = Join-Path (Join-Path $sysRoot 'System32') 'icacls.exe'
    $progData = Join-Path ([System.IO.Path]::GetPathRoot($sysRoot)) 'ProgramData'
    $stage = $null
    if ((Test-Path -LiteralPath $icacls) -and (Test-Path -LiteralPath $progData)) {
        $stage = New-HmSecureStagingDir -ProgramData $progData -Icacls $icacls -Elevated $true
    }
    if (-not ($stage -and (Test-Path -LiteralPath $stage))) {
        Write-Host "Nomad: не удалось создать защищённую папку для сборки в ProgramData — из общей временной папки собирать не буду: подменить в ней файлы мог бы любой процесс обычного пользователя. Установка Nomad остановлена."
        Write-Host "  Что делать: нажми «Повторить»; если не помогло — пришли журнал установки в бота поддержки."
        return $null
    }
    $dst = Join-Path $stage 'nomad-src'
    Write-Host "  Копирую исходники в защищённую папку и сверяю копию с манифестом (на медленном диске это до минуты)..."
    try {
        # Каталог копируем целиком в ЕЩЁ НЕ СУЩЕСТВУЮЩИЙ путь, без подстановок: Copy-Item -LiteralPath "...\*"
        # в Windows PowerShell 5.1 (боевой интерпретатор) НЕ раскрывает звёздочку и молча копирует НОЛЬ файлов.
        Copy-Item -LiteralPath $Src -Destination $dst -Recurse -Force -ErrorAction Stop
        # Молчаливый no-op копирования уже стоил компоненту установки — проверяем факт.
        if (-not (Test-Path -LiteralPath (Join-Path $dst 'pyproject.toml'))) {
            throw 'копия исходников пуста (нет pyproject.toml)'
        }
        $got = Get-HmTreeSha256 $dst
        if (-not $TreeWant -or $got -ne $TreeWant) {
            Write-Host "БЕЗОПАСНОСТЬ: НЕ СОВПАЛ SHA-256 КОПИИ nomad-src в защищённой папке — исходники менялись во время копирования. Установка Nomad остановлена."
            Write-Host "  ожидалось: $TreeWant"
            Write-Host "  получено:  $got"
            Remove-HmSecureStagingDir -Path $stage
            return $null
        }
    } catch {
        Write-Host "Nomad: не удалось подготовить копию исходников в защищённой папке ($($_.Exception.Message)) — установка остановлена."
        Remove-HmSecureStagingDir -Path $stage
        return $null
    }
    Write-Host "  Копия для сборки лежит в защищённой папке и сверена с манифестом."
    return [pscustomobject]@{ Stage = $stage; Path = $dst }
}

Update-Path
$DRY = [bool]$env:HM_DRY_RUN

# GUARD (Codex P0): не перезаписываем ЧУЖОЙ uv-tool/шимы. Если uv-tool nomad-agent ИЛИ
# команды nmd/nomad-agent/nomad-acp (entrypoints агента) уже существуют — НЕ ставим поверх
# (без принудительной перезаписи): осознанный skip (exit 120). Клонирования нет вовсе.
#
# Признак «чужое стоит» — ИСПОЛНЯЕМЫЙ ФАЙЛ, а не каталог тула. `uv tool install`
# создаёт каталог venv первым, а entrypoint'ы кладёт последними (проверено запуском
# вшитого uv): каталог без Scripts\nmd.exe — это не чужая установка, а огрызок нашей
# собственной, оборванной закрытым окном. Раньше такой огрызок давал exit 120 на
# КАЖДОМ повторном запуске, и человек не мог поставить агента вообще ничем.
if (-not $DRY) {
    $existingNomad = @(
        (Join-Path $env:APPDATA 'uv\tools\nomad-agent\Scripts\nmd.exe'),
        (Join-Path $env:APPDATA 'uv\tools\nomad-agent\Scripts\nomad-agent.exe'),
        (Join-Path $env:APPDATA 'uv\tools\nomad-agent\Scripts\nomad-acp.exe'),
        (Join-Path $env:USERPROFILE '.local\share\uv\tools\nomad-agent\Scripts\nmd.exe'),
        (Join-Path $env:USERPROFILE '.local\share\uv\tools\nomad-agent\bin\nmd'),
        (Join-Path $env:USERPROFILE '.local\bin\nmd.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\nmd'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad-agent.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad-agent'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad-acp.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\nomad-acp')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    if ($existingNomad) {
        Write-Host "uv-tool nomad-agent или команды nmd/nomad-agent/nomad-acp уже установлены — не перезаписываю чужое (без принудительной перезаписи). Пропускаю."
        # Установлен — значит, до записи PATH внизу скрипта дело уже не дойдёт, а у людей с давно
        # поставленным Nomad ~/.local\bin в PATH пользователя как раз и нет («nmd не распознано»).
        # Чиним тут же, до выхода: запись идёт только в HKCU, шим не запускается.
        $shimDir = Join-Path $env:USERPROFILE '.local\bin'
        if (Test-Path -LiteralPath (Join-Path $shimDir 'nmd.exe') -PathType Leaf) { [void](Add-HmUserPath $shimDir) }
        exit 120
    }
}

# 1. Источник Nomad — VENDOR-ONLY: ТОЛЬКО вшитый bundled vendor (HM_NOMAD_SRC с
#    pyproject.toml; путь задаёт main из vendorRoot, не renderer). Клонирования НЕТ:
#    ветка клонирования удалена целиком, и с ней ушла TOCTOU-P0 (Фаза 2, Codex round-7) —
#    подмена чужого pyproject.toml между Test-Path и клоном → исполнение чужого
#    build-backend под админом. Нет vendor → graceful skip 120 (НЕ клонируем, НЕ падаем).
$src = $env:HM_NOMAD_SRC
$srcTrusted = $false       # можно ли ставить из $src: доверенный вшитый vendor
if ($src -and (Test-Path (Join-Path $src 'pyproject.toml'))) {
    # Доверенный bundled vendor — единственный источник, из которого можно ставить.
    $srcTrusted = $true
}
# Vendor не вшит → осознанный skip: distinct-код 120 (main НЕ пишет маркер установки).
# В dry-run skip НЕ делаем — превьюим секции 2/3/4 ниже.
if (-not $DRY -and -not $srcTrusted) {
    Write-Host "Источник Nomad (vendor/nomad-src) не вшит — устанавливать нечего (клонирование не выполняется). Вшей vendor/nomad-src (см. tools/fetch-vendor.ps1). Пропускаю."
    exit 120
}
if ($DRY -and (-not $srcTrusted)) {
    Write-Host "  [dry-run] Источник Nomad (vendor) не вшит — продолжаю dry-run preview секций 2/3/4."
}

# 1b. Честная проверка сети (vendor-honesty): вшит только ИСХОДНИК Nomad —
#     `uv python install` тянет CPython с GitHub, а `uv tool install` резолвит
#     зависимости из PyPI (плюс возможный онлайн-фолбэк uv в секции 2). Полностью
#     офлайн-машина падала бы криптичной ошибкой uv → вместо этого осознанный skip 120
#     (НЕ красный крест): Nomad можно поставить позже при подключении.
#     В dry-run сеть не пробуем — превьюим секции дальше.
if (-not $DRY) {
    if (-not (Test-NomadNetwork)) {
        Write-Host "Nomad требует интернет (Python + библиотеки, ~300 МБ) — сеть недоступна. Поставь позже при подключении к интернету. Пропускаю."
        exit 120
    }
    Write-Host "Nomad докачивает Python и библиотеки из интернета (~300 МБ) — это займёт время..."
}

# 2. uv — менеджер Python (в user-профиле; резолвим по abs-пути, не через PATH).
#    Порядок источников (GAP-фикс ревью: nomad идёт РАНЬШЕ компонента uv в порядке
#    установки, поэтому надеяться на «uv уже поставлен» нельзя):
#      (a) uv уже установлен (Programs\uv / Machine-PATH / ~/.local/bin / WinGet) → используем;
#      (b) uv нет, но в сборку вшит vendor-uv (vendor\apps\uv) → ставим ЧЕРЕЗ uv.ps1 —
#          та же SHA-256 fail-closed логика, что у компонента uv (переиспользуем скрипт,
#          НЕ дублируем небезопасно);
#      (c) ничего из этого нет → онлайн astral.sh — ПОСЛЕДНИЙ фолбэк, честно пишем в лог.
$uv = Resolve-UvExe
$uvPlannedOffline = $false   # dry-run: uv будет поставлен из vendor — онлайн-фолбэк не превьюим
if (-not $uv) {
    $uvScript = Join-Path $PSScriptRoot 'uv.ps1'
    # В lite-издании nomad — remote-компонент, и HM_VENDOR указывает на его staging, где apps\uv
    # НЕТ (uv остаётся bundled-only и лежит во ВШИТОМ vendor рядом с checksums.json). Раньше из-за
    # этого ветка (b) молча пропускалась и основным путём становился онлайн-скрипт astral.sh под
    # админом. Ищем вшитый uv ещё и в bundled-корне: HM_VENDOR_BUNDLED (если main его пробросил)
    # либо <resources>\vendor рядом со скриптами (<resources>\scripts\windows -> ..\..\vendor).
    $uvRoots = New-Object System.Collections.Generic.List[string]
    if ($env:HM_VENDOR)         { $uvRoots.Add($env:HM_VENDOR) }
    if ($env:HM_VENDOR_BUNDLED) { $uvRoots.Add($env:HM_VENDOR_BUNDLED) }
    try { $uvRoots.Add((Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'vendor')) } catch { }
    $uvRoot = ''
    foreach ($root in $uvRoots) {
        if ($root -and (Test-Path -LiteralPath (Join-Path $root 'apps\uv\uv.exe') -PathType Leaf)) { $uvRoot = $root; break }
    }
    if ($uvRoot -and (Test-Path -LiteralPath $uvScript -PathType Leaf)) {
        Write-Host "uv не найден — ставлю вшитый офлайн-uv (vendor\apps\uv, SHA-256 fail-closed, через uv.ps1)..."
        if ($DRY) {
            Write-Host "  [dry-run] WOULD: установить uv из vendor через uv.ps1 (офлайн, без сети)"
            $uvPlannedOffline = $true
        } else {
            # uv.ps1 (и Confirm-HmArtifact внутри) резолвит и бинарь, и checksums.json через
            # HM_VENDOR — на время вызова указываем на корень, где вшитый uv реально лежит, и
            # ОБЯЗАТЕЛЬНО восстанавливаем: секция 3 верифицирует nomad-src по staging-HM_VENDOR.
            # exit N внутри дочернего .ps1 возвращает управление сюда с $LASTEXITCODE=N.
            $savedVendor = $env:HM_VENDOR
            try { $env:HM_VENDOR = $uvRoot; & $uvScript } finally { $env:HM_VENDOR = $savedVendor }
            $uvRc = $LASTEXITCODE
            if ($uvRc -ne 0) {
                # РАЗЛИЧАЕМ ДВА ВИДА ОТКАЗА — они значат противоположное.
                #
                # 120 = «вшитого uv в этой сборке нет» (uv.ps1 делает graceful skip).
                # Это не поломка, а состав издания: онлайн-фолбэк тут законен и
                # ровно для этого случая и задуман.
                #
                # Любой другой ненулевой код = ПРОВЕРКА ЦЕЛОСТНОСТИ НЕ ПРОШЛА:
                # Confirm-HmArtifact внутри uv.ps1 выходит единицей, когда SHA-256
                # вшитого бинаря не сошёлся, то есть файл повреждён или подменён.
                # Уходить после этого в интернет — значит обесценить саму проверку:
                # мы обнаружили, что артефакту нельзя верить, и вместо остановки
                # молча взяли другой источник. Человек при этом видит слово «warn»
                # и установку, которая продолжается как ни в чём не бывало.
                #
                # Тот же приём, что с зеркалами докачки: «не ответил» и «ответил
                # отказом» — разные вещи, и повторять попытку осмысленно только
                # в первом случае.
                if ($uvRc -eq 120) {
                    Write-Host "  [warn] вшитого uv в этой сборке нет (код 120) — попробую онлайн-фолбэк."
                } else {
                    Write-Host "ОСТАНОВЛЕНО: проверка вшитого uv не прошла (код $uvRc)."
                    Write-Host "Это значит, что файл vendor\apps\uv повреждён или подменён — и качать замену из сети вместо разбирательства нельзя."
                    Write-Host "Что делать: переустанови из свежескачанного дистрибутива. Если повторится — напиши нам, это не нормальная ситуация."
                    exit 1
                }
            }
            Update-Path
            $uv = Resolve-UvExe
        }
    }
}
if (-not $uv -and -not $uvPlannedOffline) {
    Write-Host "uv не найден, офлайн-источник (vendor\apps\uv) недоступен — ставлю uv ОНЛАЙН с astral.sh (нужен интернет; это последний фолбэк)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: irm https://astral.sh/uv/install.ps1 | iex (онлайн-фолбэк)" }
    else {
        # -TimeoutSec ОБЯЗАТЕЛЕН: по умолчанию у Invoke-RestMethod он 0, то есть
        # бесконечность. На плохом канале или при DPI-перехвате вызов висит молча, а
        # watchdog установщика намеренно НЕ убивает процессы — шаг стоял бы вечно.
        # Это был единственный сетевой вызов в scripts/windows/ без таймаута; у всех
        # соседей он есть.
        try { Invoke-RestMethod https://astral.sh/uv/install.ps1 -TimeoutSec 120 | Invoke-Expression }
        catch { Write-Host "uv не установился: $($_.Exception.Message)"; exit 1 }
    }
    Update-Path
    $uv = Resolve-UvExe
}

# 3. Python 3.12 (pyproject требует <3.14) + установка nomad (команды nmd/nomad-agent/nomad-acp).
# БЕЗ принудительной перезаписи: uv-тул/шимы этого имени уже отсеяны guard-ом выше, а
# принудительная замена могла бы затронуть и не-uv бинарь того же имени — недопустимо.
if ($DRY) {
    Write-Host "  [dry-run] WOULD: uv python install 3.12; скопировать исходники в защищённую папку (ProgramData, только администраторы), сверить КОПИЮ с манифестом и поставить из неё: uv tool install --python 3.12 <копия> (без принудительной перезаписи)"
} else {
    if (-not $uv) { Write-Host "uv не найден после установки — прерываю."; exit 1 }
    # P1-5: коды нативных команд НЕ проглатываем ($ErrorActionPreference=Continue их
    # не ловит) — любой сбой = честный exit 1 ДО брендинга и квитанции. Иначе старый
    # nomad.exe в ~/.local/bin проходил финальную проверку и писался новый receipt.
    & $uv python install 3.12
    if ($LASTEXITCODE -ne 0) { Write-Host "ОШИБКА: uv python install 3.12 завершился с кодом $LASTEXITCODE — прерываю (брендинг/квитанцию не пишу)."; exit 1 }
    Write-Host "Устанавливаю Nomad (команды nmd/nomad-agent/nomad-acp)..."
    # #2: fail-closed integrity-гейт nomad-src ПЕРЕД установкой (medium-малварь того же
    # юзера могла подменить pyproject.toml/любой .py в user-writable vendor до `uv tool
    # install` → build-hook под АДМИНОМ). Зеркало mac nomad.sh. Нет манифеста/несовпал → exit 1.
    $treeShaFile = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'nomad-src.sha256' } else { '' }
    if (-not $treeShaFile -or -not (Test-Path $treeShaFile)) {
        Write-Host "БЕЗОПАСНОСТЬ: нет манифеста целостности nomad-src (vendor\nomad-src.sha256) — отказываюсь ставить Nomad из непроверенного дерева. Установка остановлена."
        exit 1
    }
    Confirm-HmArtifact $treeShaFile
    Confirm-HmArtifact (Join-Path $src 'pyproject.toml')
    $treeWant = ((Get-Content -Raw $treeShaFile) -replace '\s', '').ToLower()
    $treeGot = Get-HmTreeSha256 $src
    if (-not $treeWant -or $treeGot -ne $treeWant) {
        Write-Host "БЕЗОПАСНОСТЬ: НЕ СОВПАЛ SHA-256 дерева nomad-src — vendor подменён/повреждён. Установка Nomad остановлена."
        Write-Host "  ожидалось: $treeWant"
        Write-Host "  получено:  $treeGot"
        exit 1
    }
    Write-Host "  Целостность подтверждена (SHA-256 дерева): vendor\nomad-src"
    # Собираем из КОПИИ, а не из vendor напрямую. uv/setuptools кладут артефакты сборки
    # (build\, *.egg-info\) РЯДОМ С ИСХОДНИКОМ: после первой же установки дерево
    # vendor\nomad-src меняется, и при ПОВТОРНОМ запуске установщика гейт целостности
    # честно говорит «vendor подменён» — компонент больше не ставится никогда.
    # Проверено запуском: 4929 файлов в дереве превращались в 7374, SHA переставал
    # совпадать. На macOS это уже было сделано (nomad.sh, BUILD_SRC) — переносим сюда.
    # Копия лежит в ЗАЩИЩЁННОЙ папке (не в %TEMP%) и сверяется с манифестом после копирования —
    # подробности и причина в New-HmNomadBuildCopy. Не вышло — fail-closed, запасного пути
    # «из vendor напрямую» нет: он вернул бы исполнение непроверенного дерева.
    # _deelev.ps1 при подключении подметает осиротевшие задачи планировщика, поэтому подключаем его
    # только здесь, перед сборкой: ранние выходы выше (уже стоит, нет vendor, нет сети) обходятся без этого.
    . (Join-Path $PSScriptRoot '_deelev.ps1')   # New-HmSecureStagingDir, Remove-HmSecureStagingDir
    $build = New-HmNomadBuildCopy -Src $src -TreeWant $treeWant
    if (-not $build) { exit 1 }
    try {
        & $uv tool install --python 3.12 "$($build.Path)"
        $toolRc = $LASTEXITCODE
    } finally {
        Remove-HmSecureStagingDir -Path $build.Stage
    }
    if ($toolRc -ne 0) { Write-Host "ОШИБКА: uv tool install завершился с кодом $toolRc — прерываю (брендинг/квитанцию не пишу)."; exit 1 }
    Update-Path
    # v1: ownership-маркеры в venv БОЛЬШЕ НЕ пишем (маркерная логика удалена вместе с
    # авто-удалением Nomad — см. src/uninstall-targets.js). Запись маркера-владения в
    # пользовательские candidate-venv была install-side P0 (портила чужой uv-tool).
}

# 4. Брендинг → HERMES_HOME (по умолчанию %LOCALAPPDATA%\hermes). Брендинг-файл копируем
# ТОЛЬКО если целевого НЕТ — существующий пользовательский файл НЕ перезаписываем.
$hh = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$wroteSoul = $false; $wroteSkin = $false
# Каталог агента лежит в профиле, и записи в него идут под администратором: junction на HERMES_HOME (или на %LOCALAPPDATA%)
# уводил Copy-Item и WriteAllText в чужую папку, а file-symlink на SOUL.md/config.yaml — запись в её цель. Поэтому
# каталог создаётся и проверяется по цепочке от профиля (New-HmUserDir: ссылка — отказ), а файлы пишутся переносом по имени
# (Write-HmUserFile). Каталог небезопасен — брендинг и облачный блок пропускаются со строкой в журнал, сам Nomad уже стоит.
$hhSafe = $false
if (-not $DRY) {
    try {
        [void](New-HmUserDir -Path $hh)
        [void](New-HmUserDir -Path (Join-Path $hh 'skins'))
        $hhSafe = $true
    } catch { Write-Host "Nomad: брендинг и настройки НЕ записаны: каталог агента ($hh) не прошёл проверку на ссылки ($($_.Exception.Message)). Сам Nomad установлен." }
}
if (-not $DRY -and $hhSafe) {
    $soulDst = Join-Path $hh 'SOUL.md'
    if (-not (Test-Path -LiteralPath $soulDst)) {
        $soulSrc = Join-Path $src 'branding\SOUL.md'
        if (Test-Path $soulSrc) {
            try { Write-HmUserFile -Path $soulDst -Bytes ([System.IO.File]::ReadAllBytes($soulSrc)); $wroteSoul = $true }
            catch { Write-Host "  [warn] SOUL.md не записан: $($_.Exception.Message)" }
        }
        else { Write-Host "  [warn] branding\SOUL.md не найден — пропускаю" }
    } else { Write-Host "  SOUL.md уже существует — не перезаписываю." }
    $skinDst = Join-Path $hh 'skins\nomad.yaml'
    if (-not (Test-Path -LiteralPath $skinDst)) {
        $nomadYamlSrc = Join-Path $src 'branding\skins\nomad.yaml'
        if (Test-Path $nomadYamlSrc) {
            try { Write-HmUserFile -Path $skinDst -Bytes ([System.IO.File]::ReadAllBytes($nomadYamlSrc)); $wroteSkin = $true }
            catch { Write-Host "  [warn] skins\nomad.yaml не записан: $($_.Exception.Message)" }
        }
        else { Write-Host "  [warn] branding\skins\nomad.yaml не найден — пропускаю" }
    } else { Write-Host "  skins\nomad.yaml уже существует — не перезаписываю." }
    $cfgY = Join-Path $hh 'config.yaml'
    if (-not (Test-Path $cfgY)) {
        $cfgTmpl = Join-Path $src 'branding\config.yaml.template'
        if (Test-Path $cfgTmpl) {
            try { Write-HmUserFile -Path $cfgY -Bytes ([System.IO.File]::ReadAllBytes($cfgTmpl)) }
            catch { Write-Host "  [warn] config.yaml не записан: $($_.Exception.Message)" }
        }
        else { Write-Host "  [warn] branding\config.yaml.template не найден — пропускаю" }
    }
}

# 5. Nomad Cloud (cp.nomadnet.ai) — доступ к ИИ-моделям через облако владельца (без VPN).
#    OpenAI-совместимый custom-провайдер: config.yaml model.provider=custom + base_url +
#    api_key + default. Ключ — ТОЛЬКО кабинетный ключ ДРУГА (HM_NOMAD_CLOUD_KEY), ключ
#    владельца нигде не зашит. Идемпотентно (управляемый блок между маркерами). Ключ не
#    задан → облачный блок НЕ пишем (graceful): любую нейросеть можно подключить позже
#    своим API-ключом через `nmd model`.
$cfgY = Join-Path $hh 'config.yaml'
$cloudKey   = if ($env:HM_NOMAD_CLOUD_KEY)     { ($env:HM_NOMAD_CLOUD_KEY).Trim() }     else { '' }
$cloudUrl   = if ($env:HM_NOMAD_CLOUD_BASEURL) { ($env:HM_NOMAD_CLOUD_BASEURL).Trim() } else { 'https://cp.nomadnet.ai/v1' }
$cloudModel = if ($env:HM_NOMAD_CLOUD_MODEL)   { ($env:HM_NOMAD_CLOUD_MODEL).Trim() }   else { 'claude-opus-4-6' }
if (-not $cloudKey) {
    Write-Host "Ключ Nomad Cloud не задан — облачный блок НЕ пишу (graceful). Подключишь позже: nmd model → custom endpoint $cloudUrl или свой ключ любой нейросети."
} else {
    # Значения уходят в YAML в двойных кавычках — вычищаем кавычки/переводы строк.
    $keySan   = ($cloudKey   -replace '["\r\n]', '')
    $urlSan   = ($cloudUrl   -replace '["\r\n]', '')
    $modelSan = ($cloudModel -replace '["\r\n]', '')
    if ($DRY) {
        Write-Host "  [dry-run] WOULD: в $cfgY вписать model.provider=custom base_url=$urlSan default=$modelSan api_key=<скрыт>"
    } elseif (-not $hhSafe) {
        Write-Host "Nomad Cloud: ключ в config.yaml НЕ записан — каталог агента ($hh) не прошёл проверку на ссылки (см. выше). Подключишь позже: nmd model."
    } elseif (Test-HmIsReparse $cfgY) {
        # Читать ссылку незачем: содержимое её цели (в том числе закрытого файла, который администратор прочитать может) легло
        # бы в обычный config.yaml пользователя вместе с ключом.
        Write-Host "Nomad Cloud: ключ в config.yaml НЕ записан — сам config.yaml это ссылка (symlink), а установщик работает с правами администратора и сквозь ссылки не пишет. Удали ссылку и повтори установку Nomad (или подключи облако позже: nmd model)."
    } else {
        $text = ''
        if (Test-Path $cfgY) { $text = [IO.File]::ReadAllText($cfgY, [Text.Encoding]::UTF8) }
        # (1) снять ранее вписанный управляемый блок — идемпотентность
        $text = [regex]::Replace($text, '(?sm)^# >>> nomad-cloud.*?# <<< nomad-cloud <<<\r?\n?', '')
        # (2) снять существующий top-level блок model: (шаблонный provider:auto или прежний custom)
        $text = [regex]::Replace($text, '(?m)^model:[ \t]*\r?\n(?:(?:[ \t].*\r?\n)|(?:[ \t]*\r?\n))*', '')
        # (3) вписать управляемый блок в НАЧАЛО файла
        $nl = "`r`n"
        $block = '# >>> nomad-cloud (managed by installer -- do not edit inside markers) >>>' + $nl +
                 'model:' + $nl +
                 '  provider: "custom"' + $nl +
                 '  base_url: "' + $urlSan + '"' + $nl +
                 '  api_key: "' + $keySan + '"' + $nl +
                 '  default: "' + $modelSan + '"' + $nl +
                 '# <<< nomad-cloud <<<' + $nl
        $text = $block + $text
        # config.yaml — данные: пишем БЕЗ BOM (BOM ломает YAML-парсер). Запись — переносом по имени, не открытием имени на запись.
        try {
            Write-HmUserFile -Path $cfgY -Bytes ((New-Object Text.UTF8Encoding $false).GetBytes($text))
            Write-Host "OK: Nomad подключён к облаку $urlSan (модель $modelSan). Ключ записан в config.yaml."
        } catch { Write-Host "Nomad Cloud: ключ в config.yaml НЕ записан: $($_.Exception.Message)" }
    }
}

if ($DRY) { Write-Host "[dry-run] Nomad preview завершён."; exit 0 }
Update-Path

# Шимы nmd/nomad-agent/nomad-acp лежат в ~/.local\bin, а его в PATH пользователя часто нет
# (uv лишь предупреждает «is not on your PATH»). Финал раньше обещал «nmd появится в PATH»
# и PATH не трогал — в новом окне человек получал «Имя "nmd" не распознано». Пишем в реестр
# (HKCU) с рассылкой WM_SETTINGCHANGE; PATH ЭТОГО процесса не трогаем — Get-Command nmd
# ниже не должен находить user-writable шим под администратором.
$localBin = Join-Path $env:USERPROFILE '.local\bin'
if (Test-Path -LiteralPath (Join-Path $localBin 'nmd.exe')) { [void](Add-HmUserPath $localBin) }

# P0-4: квитанция владения — ТОЧНЫЕ пути СОЗДАННЫХ артефактов (main соберёт в receipt).
# ВАЖНО: HERMES_HOME\config.yaml НЕ записываем в квитанцию — после установки это
# пользовательский конфиг (ключи/настройки), деинсталлятор его трогать не должен.
# Брендинг попадает в квитанцию ТОЛЬКО если МЫ его создали (чужой файл не присваиваем).
function Write-NomadReceipt {
    # Vendor-only: клона в LOCALAPPDATA\nomad-src больше нет — источник это вшитый vendor
    # (read-only ресурс приложения), его в квитанцию НЕ пишем.
    foreach ($shim in @('nmd.exe', 'nmd', 'nomad-agent.exe', 'nomad-agent', 'nomad-acp.exe', 'nomad-acp')) {
        $p = Join-Path $env:USERPROFILE ".local\bin\$shim"
        if (Test-Path -LiteralPath $p) { Write-Host "HM-RECEIPT path $p" }
    }
    # P1-4: uv-тул называется по pyproject [project].name = nomad-agent.
    foreach ($toolDir in @((Join-Path $env:APPDATA 'uv\tools\nomad-agent'),
                           (Join-Path $env:USERPROFILE '.local\share\uv\tools\nomad-agent'))) {
        if (Test-Path -LiteralPath $toolDir) { Write-Host "HM-RECEIPT path $toolDir" }
    }
    if ($wroteSoul) {
        $soul = Join-Path $hh 'SOUL.md'
        if (Test-Path -LiteralPath $soul) { Write-Host "HM-RECEIPT path $soul" }
    }
    if ($wroteSkin) {
        $skin = Join-Path $hh 'skins\nomad.yaml'
        if (Test-Path -LiteralPath $skin) { Write-Host "HM-RECEIPT path $skin" }
    }
}

if (Get-Command nmd -ErrorAction SilentlyContinue) {
    Write-NomadReceipt
    Write-Host "OK: Nomad установлен ($((nmd --version 2>&1 | Select-Object -First 1)))"; exit 0
}
if (Test-Path (Join-Path $env:USERPROFILE '.local\bin\nmd.exe')) {
    Write-NomadReceipt
    Write-Host "OK: Nomad в ~/.local/bin — открой НОВОЕ окно терминала, и команда nmd заработает."; exit 0
}
Write-Host "ОШИБКА: Nomad не установился — смотри лог выше."
exit 1
