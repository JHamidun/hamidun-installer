# ChatGPT Desktop (нативное приложение OpenAI) — Windows. ОПЦИОНАЛЬНЫЙ компонент.
#
# ВАЖНО: у ChatGPT для Windows НЕТ отдельного установщика .exe, размещённого OpenAI —
# приложение распространяется ТОЛЬКО как MSIX-пакет из Microsoft Store (Store ID
# 9NT1R1C2HH7J, подписан Microsoft/OpenAI). Поэтому «скачать exe в secure-cache и
# проверить Authenticode» здесь неприменимо; официальный автоматический способ —
# winget из источника msstore. Целостность и подпись MSIX обеспечивает AppX/MS Store.
#
# Модель угроз (тот же класс, что и остальные elevated-скрипты): установщик работает
# ELEVATED и ЗАПУСКАЕТ бинарь-инструмент (winget). Прямой запуск winget по короткому
# имени / через user-alias под админом исполнил бы то, что medium-integrity малварь
# ТОГО ЖЕ юзера могла подложить на его место (integrity-escalation). Поэтому:
#
#   1. Резолвим НАСТОЯЩИЙ winget.exe СТРОГО из admin-owned пакета
#      Program Files\WindowsApps\Microsoft.DesktopAppInstaller_<ver>_<arch>__8wekyb3d8bbwe\ —
#      имя пакета якорится ПОЛНОСТЬЮ (не подстрока) с пином PublisherId 8wekyb3d8bbwe;
#      winget.exe обязан лежать НЕПОСРЕДСТВЕННО в этом package-каталоге, без reparse-point'ов;
#      среди версий берём НАИБОЛЬШУЮ по [version] (не лексикографически). Fallback на
#      Get-Command УБРАН (user-writable alias — вектор подмены под elevated).
#   2. НАДЁЖНЫЙ ГЕЙТ ПОДПИСИ winget.exe ДО ЗАПУСКА (fail-closed, Test-HmTrustedSigner из _deelev.ps1):
#      Status Valid + цепочка leaf-серта до корня в LocalMachine\Root (НЕ доверяем
#      CurrentUser\Root) + ТОЧНОЕ поле Organization O='Microsoft Corporation' + Code Signing
#      EKU. Не прошло → НЕ запускаем (exit 120 skip). Верифицируем ИМЕННО тот бинарь,
#      который исполняем; он затем тянет MSIX, подписанный и доставленный Store'ом.
#   3. Ставим: winget install --id 9NT1R1C2HH7J --exact --source msstore --silent (elevated,
#      MSIX MS-signed). --exact исключает подмену id по совпадению/моникеру. Идемпотентность:
#      приложение уже стоит (Get-AppxPackage) → exit 0. Нет winget / нет сети / установка не
#      удалась → exit 120 (graceful skip).
#
#   Авто-удаление НЕ поддерживаем (чужое приложение): компонент только СТАВИТ.
#
# Значения, подтверждённые сетью (2026-07): прямого OpenAI-hosted .exe для Windows нет —
#   только MSIX из Microsoft Store; Store product ID 9NT1R1C2HH7J; App Installer =
#   Microsoft.DesktopAppInstaller_..._8wekyb3d8bbwe (PublisherId 8wekyb3d8bbwe — публичный
#   хеш издателя Microsoft для first-party пакетов); winget.exe подписан O='Microsoft
#   Corporation'. Если OpenAI когда-то выложит standalone-инсталлятор — можно добавить
#   download→Test-HmTrustedSigner-ветку как в claude-desktop.ps1.
$ErrorActionPreference = 'Stop'

$DRY = [bool]$env:HM_DRY_RUN

$STORE_ID     = '9NT1R1C2HH7J'
# ТОЧНОЕ поле Organization (O=) в Authenticode-подписи winget.exe (App Installer, MS first-party).
$PUBLISHER_O  = 'Microsoft Corporation'
# PublisherId (публичный хеш издателя Microsoft) — пин в имени пакета App Installer.
$MS_PUBLISHER_ID = '8wekyb3d8bbwe'

# --- Проверка Authenticode winget.exe — ЕДИНАЯ функция примитива: Test-HmTrustedSigner (_deelev.ps1) ---
# Раньше тут жила своя копия (цепочка «на сегодня» без флагов): у App Installer, который давно не обновляли,
# лист подписи уже истёк, хотя метка времени у подписи есть и Status='Valid', — и цепочка отказывала с
# NotTimeValid, ChatGPT Desktop пропускался. Теперь срок звеньев решает метка времени от TSA, чей корень лежит в
# LocalMachine\Root. Контракт прежний: '' — бинарь ДОВЕРЕН, иначе строка-причина (у вызывающего → fail-closed).
# Проверяется: Status=Valid + цепочка к корню в LocalMachine\Root (CurrentUser\Root не доверяем) + EKU Code
# Signing + точное O= (-ExpectedOrg).
. (Join-Path $PSScriptRoot '_deelev.ps1')  # Test-HmTrustedSigner (единая проверка подписи)

# --- Идемпотентность: приложение ChatGPT уже установлено? ---
function Test-ChatGptDesktopInstalled {
    try {
        $p = Get-AppxPackage -ErrorAction SilentlyContinue |
             Where-Object { ($_.Name -match 'ChatGPT') -or ($_.Name -match 'OpenAI' -and $_.Name -match 'GPT') } |
             Select-Object -First 1
        if ($p) { return $true }
    } catch { }
    return $false
}

if (Test-ChatGptDesktopInstalled) {
    Write-Host "ChatGPT Desktop уже установлен — пропускаю."
    exit 0
}

# --- Резолвим НАСТОЯЩИЙ winget.exe СТРОГО из admin-owned пакета App Installer ---
# Пин: имя каталога = Microsoft.DesktopAppInstaller_<ver>_<arch>__8wekyb3d8bbwe (ПОЛНЫЙ якорь,
# не подстрока; PublisherId зашит). winget.exe обязан лежать НЕПОСРЕДСТВЕННО в этом каталоге,
# каталог и файл — не reparse-point. Среди версий берём НАИБОЛЬШУЮ по [version]. Fallback на
# Get-Command УБРАН (user-writable alias — вектор подмены под elevated).
function Resolve-Winget {
    $pf = $env:ProgramFiles
    if (-not $pf) { return $null }
    $base = Join-Path $pf 'WindowsApps'
    if (-not (Test-Path -LiteralPath $base)) { return $null }
    $rx = '^Microsoft\.DesktopAppInstaller_(?<ver>[0-9][0-9.]*)_(x64|arm64|x86|neutral)__' + [regex]::Escape($MS_PUBLISHER_ID) + '$'
    $cands = @()
    Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $dir = $_
        if ($dir.Name -match $rx) {
            $ver = $Matches['ver']
            if ($dir.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return }  # анти junction на чужой путь
            $exe = Join-Path $dir.FullName 'winget.exe'
            if (Test-Path -LiteralPath $exe -PathType Leaf) {
                $fi = Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue
                if ($fi -and -not ($fi.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
                    [string]::Equals($fi.DirectoryName, $dir.FullName, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $v = $null; try { $v = [version]$ver } catch { $v = [version]'0.0' }
                    $cands += [pscustomobject]@{ Ver = $v; Path = $fi.FullName }
                }
            }
        }
    }
    if ($cands.Count -eq 0) { return $null }
    return ($cands | Sort-Object Ver -Descending | Select-Object -First 1).Path
}

if ($DRY) {
    Write-Host "  [dry-run] WOULD: резолвить winget.exe СТРОГО из Microsoft.DesktopAppInstaller_..._$MS_PUBLISHER_ID (PublisherId-пин, без Get-Command fallback), Test-HmTrustedSigner → Status Valid + цепочка к LocalMachine\Root + O='$PUBLISHER_O' + Code Signing EKU (ДО запуска, fail-closed), затем winget install --id $STORE_ID --exact --source msstore --silent --accept-package-agreements --accept-source-agreements."
    exit 0
}

$winget = Resolve-Winget
if (-not $winget -or -not (Test-Path -LiteralPath $winget -PathType Leaf)) {
    Write-Host "winget (App Installer из Microsoft Store) не найден — не могу поставить ChatGPT автоматически. Открой Microsoft Store, найди «ChatGPT» и нажми «Установить». Пропускаю (skip)."
    exit 120
}

# --- НАДЁЖНЫЙ ГЕЙТ ПОДПИСИ winget.exe ДО ЗАПУСКА (fail-closed) ---
$why = Test-HmTrustedSigner -Path $winget -ExpectedOrg $PUBLISHER_O
if ($why) {
    Write-Host "БЕЗОПАСНОСТЬ: winget.exe не прошёл надёжную проверку подписи ($why) — НЕ запускаю. Пропускаю ChatGPT (fail-closed)."
    exit 120
}
Write-Host "winget.exe проверен: цепочка к машинному корню + O='$PUBLISHER_O' + Code Signing EKU. Ставлю ChatGPT из Microsoft Store..."

# --- Установка из Microsoft Store (MSIX MS-signed) — С ПОТОЛКОМ ВРЕМЕНИ ---
# Раньше winget звался без лимита. Живой случай: шаг «ChatGPT Desktop» молчал 72 минуты
# (магазин ждал входа в аккаунт или висел на загрузке), и кроме как закрыть всё окно
# установщика, сделать было нечего. Теперь потолок $WINGET_TIMEOUT_SEC: по нему дерево
# процесса winget гасится taskkill /T, а шаг честно пропускается (exit 120). 20 минут —
# с запасом на ~300 МБ по медленному каналу, но втрое меньше того, что ждали люди.
# Вывод читаем построчно (ReadLineAsync) — журнал живёт, а не молчит до самого конца;
# его же потом разбираем, чтобы назвать причину («нет в Store вашего региона»).
$WINGET_TIMEOUT_SEC = 1200
$wingetOut = New-Object System.Collections.Generic.List[string]
$code = $null
$timedOut = $false
try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $winget
    $psi.Arguments = "install --id $STORE_ID --exact --source msstore --accept-package-agreements --accept-source-agreements --silent"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $proc = [System.Diagnostics.Process]::Start($psi)
    $errTask = $proc.StandardError.ReadToEndAsync()   # дренируем stderr, чтобы winget не встал на полном буфере
    $lineTask = $proc.StandardOutput.ReadLineAsync()
    $deadline = (Get-Date).AddSeconds($WINGET_TIMEOUT_SEC)
    while ($true) {
        if ($lineTask.IsCompleted) {
            $line = $lineTask.Result
            if ($null -eq $line) { break }                  # конец вывода — winget завершается
            if ($line.Trim()) { Write-Host $line; $wingetOut.Add($line) }
            $lineTask = $proc.StandardOutput.ReadLineAsync()
            continue
        }
        if ((Get-Date) -gt $deadline) { $timedOut = $true; break }
        Start-Sleep -Milliseconds 200
    }
    if ($timedOut) {
        # Дерево целиком: winget держит дочерние процессы. taskkill — по абсолютному пути.
        $tk = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        try { & $tk /PID $proc.Id /T /F 2>&1 | Out-Null } catch { try { $proc.Kill() } catch { } }
    } else {
        $null = $proc.WaitForExit(30000)
        try { $code = $proc.ExitCode } catch { $code = $null }
        try { if ($errTask.Wait(5000)) { $errTask.Result -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { Write-Host $_; $wingetOut.Add($_) } } } catch { }
    }
} catch {
    Write-Host "Не удалось запустить winget ($($_.Exception.Message)) — пропускаю ChatGPT. Поставь вручную из Microsoft Store."
    exit 120
}
if ($timedOut) {
    # Приложение могло успеть встать, пока мы ждали, — тогда это успех, а не пропуск.
    if (Test-ChatGptDesktopInstalled) {
        Write-Host "OK: ChatGPT Desktop установлен из Microsoft Store."
        exit 0
    }
    Write-Host "Microsoft Store не ответил за $([math]::Round($WINGET_TIMEOUT_SEC / 60)) минут — ожидание остановлено, ChatGPT Desktop пропускаю. Он необязателен, всё остальное работает. Возможно, магазин ждёт входа в аккаунт или загрузка ещё идёт: проверь позже в Microsoft Store → «Библиотека»."
    exit 120
}

# Аттестация: приложение реально появилось (не полагаемся только на exit-код winget).
$installed = $false
for ($i = 0; $i -lt 30; $i++) {
    if (Test-ChatGptDesktopInstalled) { $installed = $true; break }
    Start-Sleep -Seconds 1
}
if ($installed) {
    Write-Host "OK: ChatGPT Desktop установлен из Microsoft Store."
    exit 0
}

# Причина — по факту, а не «нужна авторизация» на всё подряд. Живой журнал: winget
# написал «No package found matching input criteria» — магазин не отдаёт приложение для
# региона системы, а человеку советовали войти в Store, что не помогло бы ничем.
# 0x8A150014 (-1978335212) — тот же «пакет не найден», когда текст пришёл на другом языке.
$wingetText = ($wingetOut -join "`n")
if ($code -eq -1978335212 -or $wingetText -match 'No package found matching input criteria|Не найден пакет|Не найдено пакетов') {
    Write-Host "ChatGPT Desktop недоступен в Microsoft Store вашего региона (магазин не нашёл приложение для страны, указанной в Windows) — это не поломка и не обрыв сети. Приложение необязательно, всё остальное работает. Пропускаю (skip)."
    exit 120
}
Write-Host "winget завершился с кодом $code, но приложение ChatGPT не подтвердилось. Открой Microsoft Store, найди «ChatGPT» и нажми «Установить» — там будет видно, что мешает (вход в аккаунт, регион, свободное место). Пропускаю (skip)."
exit 120
