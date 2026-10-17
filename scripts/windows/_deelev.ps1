# _deelev.ps1 — ЕДИНЫЙ укреплённый примитив ДЕ-ЭЛЕВАЦИИ (Windows).
# Дот-сорсится компонент-скриптами (vscode.ps1, extension.ps1), которые исполняются
# ELEVATED (установщик requireAdministrator). Прямой вызов user-writable editor-CLI
# (code.cmd / cursor.cmd / Code.exe / Cursor.exe) под АДМИНОМ выполнил бы то, что
# medium-integrity малварь ТОГО ЖЕ юзера могла заранее подложить на его место
# (integrity-escalation). Поэтому редакторный CLI исполняется ТОЛЬКО через этот
# примитив — де-элевированно (medium integrity), fail-closed.
#
# Укрепление (Codex regate P0 — 3-й круг, «гонки/hijack невозможны ПО КОНСТРУКЦИИ»):
#  1) НИКАКИХ control-файлов в общем user-writable %TEMP%. Раньше wrapper-ps1/xml/out/
#     .code/.int лежали в %TEMP%: medium-малварь ТОГО ЖЕ юзера создаёт файл ЗАРАНЕЕ
#     (сохраняя свой DACL), наш elevated Set-Content лишь перезаписывает СОДЕРЖИМОЕ, DACL
#     атакующего остаётся -> он меняет RunLevel LeastPrivilege->HighestAvailable и <Command>
#     на свой бинарь ДО /Create. ТЕПЕРЬ:
#       - Тело обёртки едет ЦЕЛИКОМ в -EncodedCommand (base64 UTF-16LE), собранном ELEVATED-
#         родителем с ВБИТЫМИ ЛИТЕРАЛАМИ (пути, integrity-SID, exe, аргументы). Base64 — в
#         аргументах schtasks/XML, не в отдельном файле -> подменять нечего.
#       - ЕДИНСТВЕННЫЙ транзиентный файл — task.xml — лежит в PRIVATE high-integrity каталоге
#         %ProgramData%\HmDeElev-<rnd>, рождённом с DACL «SYSTEM+Administrators: FullControl,
#         прочие: нет доступа» (New-HmSecureStagingDir). Users туда писать не могут ->
#         pre-creation/tamper невозможны. Медиум-ребёнок XML вообще не читает (команда после
#         /Create хранится в БД планировщика, SYSTEM-owned). XML удаляется сразу после /Create.
#  2) ПЕРВЫЕ инструкции обёртки — простые присваивания ЛИТЕРАЛОВ (чистые PSModulePath/PATH),
#     БЕЗ единого cmdlet/Join-Path/$env:SystemRoot ДО очистки env (иначе Windows PowerShell
#     автолоадит команды из CurrentUser-модулей high ДО gate). Integrity-self-check — через
#     АБСОЛЮТНЫЙ литерал System32\whoami.exe (не user-writable -> доверен).
#  3) Обёртка исполняет целевой бинарь ТОЛЬКО при MEDIUM (S-1-16-8192); иначе exit 210
#     (fail-closed — ловит и «RL LIMITED проигнорирован для Builtin Administrator / UAC off»:
#     если задача пошла high, self-check видит high и бинарь НЕ запускает).
#  4) Аттестация — НЕ через user-writable файл. Планировщик пишет exit-код обёртки в «Last
#     Result» задачи (БД планировщика, SYSTEM-owned, НЕ user-writable). Родитель читает его
#     локаль-независимо (schtasks /Query /HRESULT /FO CSV /NH /V, поле #6): 267009=выполняется,
#     267011=ещё не запускалась, иначе=exit-код обёртки. Успех установки родитель/вызывающий
#     подтверждает ПРЯМОЙ проверкой каталога расширений (Test-HmExtInstalled), не выводом бинаря.
#  5) Любой сбой (нет системного бинаря, staging-каталог не заперт при elevated, задача не
#     создалась/не выполнилась) -> $null. Вызывающий обязан трактовать $null как FAIL-CLOSED
#     и НЕ запускать бинарь под админом.
#
# ИНВАРИАНТ: elevated-процесс НИКОГДА не исполняет user-writable editor-бинарь at high
# integrity; НИ ОДНОГО user-writable control/attestation-файла в решении о доверии.
#
# ЗАПАСНОЙ ПУТЬ (Invoke-HmDeElevatedSafe, внизу файла). Одноразовая задача — общая точка
# отказа сразу для пяти шагов: панели VS Code, pip и самопроверка моста, разрешение
# микрофона Handy, проверка claude. В присланном журнале все они отказали разом за 7 секунд
# с «Last Result» 0x80070005: действие задачи (powershell) не стартовало вовсе — так режут
# запуск из планировщика антивирусы. Когда ДОКАЗАНО, что задача ничего не запустила, то же
# действие выполняется с ТОКЕНОМ ОБОЛОЧКИ Explorer (medium, тот же пользователь — проверяется
# по самому токену до запуска). Почему не «explorer.exe <лаунчер>», как делали скрепка, трей
# моста и «Войти в Claude» до 09.10.2026: если оболочки в этот момент нет (её может прибить
# малварь того же юзера), наш elevated explorer.exe обрабатывает запуск САМ, под админом, и
# выбирает обработчик по HKCU\Software\Classes (lnkfile/cmdfile/exefile — пишется без UAC)
# раньше любого гейта внутри лаунчера. Токен оболочки проверяется ДО запуска, ассоциаций
# файлов не касается. Теперь и эти три запуска идут через Invoke-HmAsShellUser (-NoWait;
# «Войти в Claude» — с -CmdScript и -WorkingDirectory, то есть вообще без файла-лаунчера).

# --- Integrity текущего (родительского) процесса через АБСОЛЮТНЫЙ whoami (не user-writable). ---
function Get-HmSelfIntegrity {
    param([Parameter(Mandatory = $true)][string]$WhoamiExe)
    try {
        $t = (& $WhoamiExe /groups 2>$null | Out-String)
        if ($t -match 'S-1-16-8192')  { return 'medium' }
        if ($t -match 'S-1-16-12288') { return 'high' }
        if ($t -match 'S-1-16-16384') { return 'system' }
        if ($t -match 'S-1-16-4096')  { return 'low' }
    } catch { }
    return 'unknown'   # неизвестно -> трактуем как «возможно elevated» (fail-safe у вызывающего)
}

# --- Расширение установлено: каталог "<extId>-<версия>" в одном из Dirs. Точный префикс
#     "<extId>-" + ЦИФРА версии (иначе `anthropic.claude-code-helper-1.0` даёт ложный PASS,
#     ведь он тоже начинается с `anthropic.claude-code-`), ordinal-регистронезависимо,
#     ТОЛЬКО каталоги. Суффикс платформы `-win32-x64` (после `-<ver>`) продолжает проходить. ---
function Test-HmExtInstalled {
    param([Parameter(Mandatory = $true)][string]$ExtId,
          [Parameter(Mandatory = $true)][string[]]$Dirs)
    $rx = '^' + [regex]::Escape($ExtId) + '-\d'
    foreach ($d in $Dirs) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        try {
            $hit = Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match $rx } | Select-Object -First 1
            if ($hit) { return $true }
        } catch { }
    }
    return $false
}

# --- Чтение/запись DACL БЕЗ модуля Microsoft.PowerShell.Security. ---
#
# ПОЧЕМУ НЕ Get-Acl/Set-Acl напрямую: примитив вызывается из установщика с УРЕЗАННЫМ
# окружением (чистые PATH/PSModulePath — это сознательная защита от module-hijack, env
# пишется medium-малварью того же юзера). В таком окружении автозагрузка
# Microsoft.PowerShell.Security падает — «The 'Get-Acl' command was found in the module
# ..., but the module could not be loaded», — и весь примитив уходил в $null. Снаружи
# (обычная консоль) всё работало, поэтому сбой было не видно ни в одном ручном прогоне:
# lite-издание не качало НИЧЕГО, а пользователь читал «Нужны права администратора».
#
# .NET-путь модулей не требует вообще: в PS 5.1 (.NET Framework) есть методы
# DirectoryInfo.GetAccessControl/SetAccessControl, в PS 7 (.NET Core) — extension-класс
# FileSystemAclExtensions. Cmdlet остаётся последним шансом.
function Get-HmDirAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $di = New-Object System.IO.DirectoryInfo($Path)
    try { return $di.GetAccessControl() } catch { }
    try { return [System.IO.FileSystemAclExtensions]::GetAccessControl($di) } catch { }
    return (Get-Acl -LiteralPath $Path)
}
function Set-HmDirAcl {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][System.Security.AccessControl.DirectorySecurity]$Acl)
    $di = New-Object System.IO.DirectoryInfo($Path)
    try { $di.SetAccessControl($Acl); return } catch { }
    try { [System.IO.FileSystemAclExtensions]::SetAccessControl($di, $Acl); return } catch { }
    Set-Acl -LiteralPath $Path -AclObject $Acl -ErrorAction Stop
}

# --- УБОРКА staging-ПАРЫ — ЕДИНСТВЕННЫЙ законный способ сноса staging-каталога.
#     New-HmSecureStagingDir отдаёт наружу РАБОЧИЙ подкаталог `w` ВНУТРИ запертого
#     HmDeElev-<hex>. Снос по возвращённому пути убирал только `w`, а внешний
#     Admins-only каталог оставался в %ProgramData% НАВСЕГДА (пользователь стереть
#     его не может — на этой машине их скопились сотни). Поэтому: имя `w` ->
#     поднимаемся к родителю (образец — stagingRootOf в src/main.js). Fail-closed:
#     код исполняется под админом, удалять можно ТОЛЬКО каталог, чьё имя строго
#     HmDeElev-<32 hex> (тот же шаблон, что у pruneStaleSecureDirs в main.js);
#     любое другое имя после подъёма — НЕ трогаем вовсе: ошибка в вычислении пути
#     не должна стоить пользователю чужого каталога. ---
function Remove-HmSecureStagingDir {
    param([string]$Path)
    try {
        if (-not $Path) { return }
        $root = ([string]$Path).TrimEnd('\', '/')
        if ([System.IO.Path]::GetFileName($root) -eq 'w') {
            $root = [System.IO.Path]::GetDirectoryName($root)
        }
        if (-not $root) { return }
        if ([System.IO.Path]::GetFileName($root) -notmatch '^HmDeElev-[0-9a-f]{32}$') { return }
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    } catch { }
}

# --- PRIVATE high-integrity staging-каталог под ProgramData. Рождается атомарно с DACL
#     {SYSTEM,Administrators: FullControl}, protection on (без наследования Users). Elevated
#     дополнительно ставит владельца = Administrators (иначе owner=self сохраняет неявный
#     WRITE_DAC). Возвращает путь или $null (fail-closed). ---
function New-HmSecureStagingDir {
    param([Parameter(Mandatory = $true)][string]$ProgramData,
          [Parameter(Mandatory = $true)][string]$Icacls,
          [Parameter(Mandatory = $true)][bool]$Elevated)
    try {
        if (-not (Test-Path -LiteralPath $ProgramData)) {
            [Console]::Error.WriteLine('HMSECFAIL: нет каталога ProgramData: ' + $ProgramData)
            return $null
        }
        $dir = Join-Path $ProgramData ('HmDeElev-' + [guid]::NewGuid().ToString('N'))
        if (Test-Path -LiteralPath $dir) {
            # CREATE_NEW: имя занято (практически невозможно, но fail-closed).
            [Console]::Error.WriteLine('HMSECFAIL: случайное имя каталога уже занято — возможна подмена')
            return $null
        }

        $admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
        $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
        $allow  = @('S-1-5-18', 'S-1-5-32-544')
        $sd = New-Object System.Security.AccessControl.DirectorySecurity
        $sd.SetAccessRuleProtection($true, $false)   # снять наследование, НЕ копировать унаследованные
        $sd.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $admins, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        $sd.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $system, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        if (-not $Elevated) {
            # Родитель уже MEDIUM (нет privesc): его отфильтрованный токен НЕ может писать по
            # Admins-ACE (Admins deny-only в medium-токене) -> даём владельцу-юзеру доступ, иначе
            # сам примитив не запишет task.xml. При ELEVATED этого ACE НЕТ (тогда medium-атакующий
            # ТОГО ЖЕ юзера не должен иметь записи -> tamper невозможен).
            $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
            $allow += $me.Value
            $sd.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $me, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        }
        # Владелец -> Administrators АТОМАРНО в SD (elevated). БЕЗ этого CreateDirectory ставит
        # owner = создатель (user по Object-Creator-политике), а ВЛАДЕЛЕЦ имеет implicit WRITE_DAC:
        # medium-атакующий ТОГО ЖЕ юзера открыл бы WRITE_DAC по владению, временно добавил себе ACE,
        # создал/удержал task.xml, восстановил DACL под проверки и подменил XML до /Create -> HIGH exec.
        # Ставить владельца ПОСЛЕ (icacls) = окно уязвимости. Здесь — в момент создания.
        if ($Elevated) { $sd.SetOwner($admins) }
        # Рождаем каталог СРАЗУ с этим SD (DACL + владелец применяются атомарно при создании).
        # ГЛАВНЫЙ путь. Но он работает НЕ ВСЕГДА:
        #   • Windows по умолчанию делает владельцем создателя («Object creator»), а поставить
        #     владельцем Administrators без включённого SeRestorePrivilege нельзя → CreateDirectory
        #     возвращает ERROR_INVALID_OWNER и .NET бросает;
        #   • в .NET Core/PowerShell 7 перегрузки CreateDirectory(path, SD) вообще нет.
        # Раньше любой из этих случаев давал $null → докачка НЕ РАБОТАЛА ВООБЩЕ (в lite это
        # значит «ни один компонент не скачался»). Поэтому есть фолбэк: создать каталог,
        # применить тот же защищённый DACL и назначить владельца через icacls. Окно между
        # созданием и назначением закрывает ФИНАЛЬНАЯ проверка ниже (владелец + отсутствие
        # посторонних ACE + protection on + не reparse) на каталоге со СЛУЧАЙНЫМ именем —
        # подделать его атакующему нужно успеть в считанные миллисекунды И не оставить следа
        # в DACL, что проверка отвергнет.
        $usedFallback = $false
        try {
            [void][System.IO.Directory]::CreateDirectory($dir, $sd)
        } catch {
            $usedFallback = $true
        }
        if ((-not (Test-Path -LiteralPath $dir)) -or $usedFallback) {
            Remove-HmSecureStagingDir -Path $dir
            $usedFallback = $true
            [void][System.IO.Directory]::CreateDirectory($dir)
            if (-not (Test-Path -LiteralPath $dir)) {
                [Console]::Error.WriteLine('HMSECFAIL: не удалось создать каталог даже фолбэком: ' + $dir)
                return $null
            }
            # ВАЖНО: у $sd задан владелец Administrators, а Set-Acl попытается применить и
            # его — и упадёт по привилегиям, обнулив весь фолбэк. Поэтому применяем DACL
            # ОТДЕЛЬНЫМ дескриптором БЕЗ владельца, а владельца ставим ниже через icacls.
            $sdDacl = New-Object System.Security.AccessControl.DirectorySecurity
            $sdDacl.SetAccessRuleProtection($true, $false)
            $sdDacl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $admins, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
            $sdDacl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $system, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
            if (-not $Elevated) {
                $meF = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
                $sdDacl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $meF, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
            }
            Set-HmDirAcl -Path $dir -Acl $sdDacl
        }
        # Молчаливый $null здесь стоил бы человеку бесполезного «примитив не вернул путь»
        # вместо настоящей причины — ровно ради причин и заводился HMSECFAIL.
        if (-not (Test-Path -LiteralPath $dir)) {
            [Console]::Error.WriteLine('HMSECFAIL: каталог исчез после назначения прав: ' + $dir)
            return $null
        }
        # Владелец мог остаться создателем (политика «Object creator») — доводим до
        # Administrators. Если не удалось, финальная проверка владельца ниже отвергнет каталог.
        if ($Elevated) {
            $ownerNow = (Get-HmDirAcl -Path $dir).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            if ($ownerNow -ne 'S-1-5-32-544') {
                & $Icacls $dir '/setowner' '*S-1-5-32-544' '/T' '/C' *> $null
                $usedFallback = $true
            }
        }
        if ($usedFallback) { [Console]::Error.WriteLine('HMSECNOTE: владелец/ACL назначены фолбэком (icacls) — атомарный путь недоступен на этой системе') }

        # Отвергаем reparse-point (junction-подмена).
        $attr = (Get-Item -LiteralPath $dir -Force).Attributes
        if ($attr -band [System.IO.FileAttributes]::ReparsePoint) {
            [Console]::Error.WriteLine('HMSECFAIL: каталог оказался ссылкой (junction-подмена)')
            Remove-HmSecureStagingDir -Path $dir; return $null
        }

        # Каталог ОБЯЗАН быть ПУСТЫМ.
        # В фолбэке между CreateDirectory (наследует ACL от ProgramData, где Users имеют
        # право создавать файлы) и применением защищённого DACL есть окно. Проверки
        # владельца и ACE ниже смотрят на САМ каталог и о содержимом не знают: малварь
        # того же юзера может в это окно создать файл и УДЕРЖАТЬ на него хэндл записи —
        # смена владельца уже выданный хэндл не отзывает. Непустой каталог здесь означает
        # ровно это, и единственный корректный ответ — отказ (fail-closed).
        $stray = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
        if ($stray.Count -gt 0) {
            [Console]::Error.WriteLine('HMSECFAIL: в свежесозданном каталоге уже есть объекты (' +
                (($stray | Select-Object -First 3 | ForEach-Object { $_.Name }) -join ', ') +
                ') — возможна подмена в момент создания')
            Remove-HmSecureStagingDir -Path $dir; return $null
        }

        # Владелец УЖЕ задан атомарно в SD выше (не post-icacls — иначе окно с owner=user + WRITE_DAC).
        # Проверка владельца ниже — fail-closed, если атомарное применение владельца не сработало
        # (owner != Administrators -> каталог мог иметь окно -> отбрасываем).
        $acl = Get-HmDirAcl -Path $dir
        if ($Elevated) {
            $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            if ($owner -ne 'S-1-5-32-544') {
                [Console]::Error.WriteLine('HMSECFAIL: владелец каталога = ' + $owner + ', ожидался S-1-5-32-544 (Administrators)')
                Remove-HmSecureStagingDir -Path $dir; return $null
            }
        }
        foreach ($ace in $acl.Access) {
            $sid = $null
            try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
            catch { $sid = [string]$ace.IdentityReference }
            if ($allow -notcontains $sid) {
                [Console]::Error.WriteLine('HMSECFAIL: посторонний ACE в каталоге: ' + ($sid -replace '^S-1-5-21-[\d-]+$', '<sid>'))
                # Посторонний ACE. Elevated -> недопустимо (fail-closed). Medium -> нет privesc
                # (родитель уже medium), но такой ACE не должен появляться при protection on.
                if ($Elevated) {
                    Remove-HmSecureStagingDir -Path $dir; return $null
                }
            }
        }

        # РАБОЧИЙ каталог создаём ВНУТРИ уже запертого — и отдаём наружу именно его.
        #
        # Зачем второй уровень. В фолбэке между «создать каталог» и «применить DACL» есть
        # окно: каталог рождается с унаследованным от ProgramData доступом (Users могут
        # создавать объекты, владелец — сам пользователь). Проверки выше ловят подмену
        # DACL и владельца, но НЕ ловят удержанный дескриптор: Windows проверяет права в
        # момент ОТКРЫТИЯ, поэтому malware того же юзера может открыть каталог в окне с
        # полным доступом, ничего не менять — и продолжать писать туда после того, как мы
        # всё заперли. Следа в DACL при этом не остаётся.
        #
        # Внутренний каталог рождается, когда родитель УЖЕ заперт: Users не имеют на него
        # прав, значит открыть или перечислить внутренний каталог не могут, а удержанный
        # дескриптор РОДИТЕЛЯ доступа к ребёнку не даёт (права проверяются на самом
        # объекте, а удалить/переименовать ребёнка без DELETE на нём нельзя).
        $work = Join-Path $dir 'w'
        try {
            [void][System.IO.Directory]::CreateDirectory($work)
        } catch {
            [Console]::Error.WriteLine('HMSECFAIL: не удалось создать рабочий подкаталог: ' + $_.Exception.Message)
            Remove-HmSecureStagingDir -Path $dir; return $null
        }
        if (-not (Test-Path -LiteralPath $work)) {
            [Console]::Error.WriteLine('HMSECFAIL: рабочий подкаталог не создался')
            Remove-HmSecureStagingDir -Path $dir; return $null
        }
        $wattr = (Get-Item -LiteralPath $work -Force).Attributes
        if ($wattr -band [System.IO.FileAttributes]::ReparsePoint) {
            [Console]::Error.WriteLine('HMSECFAIL: рабочий подкаталог оказался ссылкой (junction-подмена)')
            Remove-HmSecureStagingDir -Path $dir; return $null
        }
        # Ребёнок ACE наследует, но наследование и владельца доводим явно — наружу уходит
        # ИМЕННО этот путь, и он обязан удовлетворять тем же инвариантам, что проверяет
        # вызывающий (владелец = Administrators, protection on, посторонних ACE нет).
        try {
            $wAcl = Get-HmDirAcl -Path $work
            $wAcl.SetAccessRuleProtection($true, $true)   # снять наследование, СОХРАНИВ уже полученные ACE
            Set-HmDirAcl -Path $work -Acl $wAcl
        } catch {
            [Console]::Error.WriteLine('HMSECFAIL: не удалось запереть рабочий подкаталог: ' + $_.Exception.Message)
            Remove-HmSecureStagingDir -Path $dir; return $null
        }
        if ($Elevated) {
            $wOwner = (Get-HmDirAcl -Path $work).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            if ($wOwner -ne 'S-1-5-32-544') {
                & $Icacls $work '/setowner' '*S-1-5-32-544' '/T' '/C' *> $null
                $wOwner = (Get-HmDirAcl -Path $work).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            }
            if ($wOwner -ne 'S-1-5-32-544') {
                [Console]::Error.WriteLine('HMSECFAIL: владелец рабочего подкаталога = ' +
                    ($wOwner -replace '^S-1-5-21-[\d-]+$', '<sid>') + ', ожидался S-1-5-32-544')
                Remove-HmSecureStagingDir -Path $dir; return $null
            }
        }
        $wAclFinal = Get-HmDirAcl -Path $work
        if (-not $wAclFinal.AreAccessRulesProtected) {
            [Console]::Error.WriteLine('HMSECFAIL: наследование на рабочем подкаталоге не снято')
            Remove-HmSecureStagingDir -Path $dir; return $null
        }
        foreach ($ace in $wAclFinal.Access) {
            $sid = $null
            try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
            catch { $sid = [string]$ace.IdentityReference }
            if ($allow -notcontains $sid) {
                [Console]::Error.WriteLine('HMSECFAIL: посторонний ACE в рабочем подкаталоге: ' +
                    ($sid -replace '^S-1-5-21-[\d-]+$', '<sid>'))
                if ($Elevated) {
                    Remove-HmSecureStagingDir -Path $dir; return $null
                }
            }
        }
        return $work
    } catch {
        # Молчаливый $null раньше делал причину невидимой (в lite это «ни один компонент не
        # скачался» без объяснения). Причину пишем в stderr — вызывающий (main.js) подхватывает
        # её в текст ошибки шага и в журнал установки.
        [Console]::Error.WriteLine('HMSECFAIL: ' + $_.Exception.Message)
        return $null
    }
}

# --- Корни доверия МАШИНЫ: отпечатки сертификатов из LocalMachine\Root. ---
# Отдельной функцией, чтобы тест подставил свой набор: настоящий стор ему трогать нельзя.
function Get-HmMachineRootThumbprints {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store([System.Security.Cryptography.X509Certificates.StoreName]::Root, [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
    $out = New-Object System.Collections.Generic.List[string]
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        foreach ($c in $store.Certificates) { [void]$out.Add([string]$c.Thumbprint) }
    } finally { try { $store.Close() } catch { } }
    return $out.ToArray()
}

# --- Цепочка сертификата подписанта БЕЗ оценки сроков годности. Возвращает объект {Root; Why; OutOfWindow}:
#     Root — корень цепочки (X509Certificate2), Why — причина отказа (пусто = цепочка выстроилась),
#     OutOfWindow — истина, если срок ХОТЯ БЫ ОДНОГО звена (лист, промежуточный УЦ, корень) на «сейчас» вышел
#     или ещё не наступил.
#     Срок годности не проверяем «на сегодня» СОЗНАТЕЛЬНО (S-11): это решает Status='Valid' из
#     Get-AuthenticodeSignature, а он считает срок по МЕТКЕ ВРЕМЕНИ подписи (см. шапку Test-HmTrustedSigner).
#     Всё остальное — подпись звеньев, EKU Code Signing, basic constraints — движок проверяет как раньше.
#     IgnoreNotTimeValid снимает оценку срока у ВСЕХ звеньев сразу, а не только у листа, поэтому «есть ли
#     звено вне срока» считаем сами (OutOfWindow): для такой цепочки вызывающий обязан потребовать метку
#     времени от TSA, которому доверяет машина. Годный лист под просроченным промежуточным УЦ (утёкший ключ
#     УЦ) иначе выглядел бы «в сроке» и обходил бы эту проверку.
#     -Eku — какое назначение обязана допускать вся цепочка: по умолчанию Code Signing (лист подписи), для
#     метки времени — Time Stamping (1.3.6.1.5.5.7.3.8).
#     -ExtraCerts и -ExtraFlags нужны только тесту (подложить тестовую цепочку и объяснить движку, что её
#     тестовый корень — «известный»); боевой вызов их не задаёт, и там движок доверяет только тому, чему
#     доверяет сама Windows.
function Get-HmSignerChainRoot {
    param(
        [Parameter(Mandatory = $true)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert,
        [string]$Eku = '1.3.6.1.5.5.7.3.3',
        [System.Security.Cryptography.X509Certificates.X509Certificate2[]]$ExtraCerts = @(),
        [System.Security.Cryptography.X509Certificates.X509VerificationFlags]$ExtraFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
    )
    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck  # отзыв уже проверен WinVerifyTrust при Status=Valid
    $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::IgnoreNotTimeValid -bor $ExtraFlags
    [void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object System.Security.Cryptography.Oid($Eku)))  # по умолчанию EKU Code Signing
    foreach ($x in @($ExtraCerts)) { if ($x) { [void]$chain.ChainPolicy.ExtraStore.Add($x) } }
    $built = $false
    try { $built = $chain.Build($Cert) } catch { return [pscustomobject]@{ Root = $null; Why = "не удалось построить цепочку: $($_.Exception.Message)" } }
    if (-not $built) {
        $st = ($chain.ChainStatus | ForEach-Object { $_.Status }) -join ','
        return [pscustomobject]@{ Root = $null; Why = "цепочка сертификатов не выстроилась ($st)" }
    }
    $elems = $chain.ChainElements
    if (-not $elems -or $elems.Count -lt 1) { return [pscustomobject]@{ Root = $null; Why = 'пустая цепочка сертификатов'; OutOfWindow = $true } }
    $root = $elems[$elems.Count - 1].Certificate
    if (-not $root -or -not $root.Thumbprint) { return [pscustomobject]@{ Root = $null; Why = 'не удалось определить корень цепочки'; OutOfWindow = $true } }
    # Срок КАЖДОГО звена по часам «сейчас» (UTC): движку велено срок не оценивать, поэтому считаем сами.
    $nowUtc = [DateTime]::UtcNow
    $outOfWindow = $false
    foreach ($el in @($elems)) {
        $c = $el.Certificate
        if (-not $c -or $c.NotAfter.ToUniversalTime() -lt $nowUtc -or $c.NotBefore.ToUniversalTime() -gt $nowUtc) { $outOfWindow = $true }
    }
    return [pscustomobject]@{ Root = $root; Why = ''; OutOfWindow = $outOfWindow }
}

# --- НАДЁЖНЫЙ гейт Authenticode для ОНЛАЙН-скачанных установщиков (git/node/cursor/python).
#     Возвращает '' если бинарь ДОВЕРЕН, иначе строку-причину отказа (вызывающий → fail-closed).
#
#     ПОЧЕМУ мало `(Get-AuthenticodeSignature $f).Status -eq 'Valid'`: WinVerifyTrust строит
#     цепочку ПОЛЬЗОВАТЕЛЬСКИМ chain-engine, который объединяет машинный стор с
#     HKCU\Software\Microsoft\SystemCertificates\Root. Этот ключ пишется medium-integrity
#     процессом ТОГО ЖЕ юзера БЕЗ UAC (certutil -user -addstore Root rogue.cer), а наш
#     elevated split-token процесс грузит ТУ ЖЕ HKCU-ветку. Плюс Invoke-WebRequest в PS 5.1
#     уважает HKCU-прокси WinINET (тоже без UAC). Итог: same-user малварь могла подсунуть
#     свой установщик с Status='Valid' и получить исполнение под АДМИНОМ.
#     Поэтому ТРЕБУЕМ: корень цепочки лежит в LocalMachine\Root + EKU Code Signing.
#     Ту же функцию зовут claude-desktop.ps1 (точное O='Anthropic, PBC' + необязательный отпечаток листа) и
#     chatgpt-desktop.ps1 (O='Microsoft Corporation' для winget.exe): раньше у каждого из них была СВОЯ копия
#     этой логики, копии разошлись с общей, и именно они держали два дефекта (срок «на сегодня» и пин
#     'Anthropic, PBC', не совпадавший никогда из-за кавычек). Решение одно на все скрипты.
#     Для git/node/cursor пин издателя ОПЦИОНАЛЕН (-ExpectedOrg/-ExpectedSubjectMatch/-ExpectedThumbprint),
#     т.к. точные RDN сторонних издателей (Git for Windows/Node/Cursor) не подтверждены на реальных
#     артефактах, а слепой пин ломал бы легитимную установку. Обязательная (непереборчивая) половина —
#     цепочка к МАШИННОМУ корню — закрывает описанный privesc сама по себе.
#
#     СРОК ГОДНОСТИ ЛИСТА здесь НЕ оценивается «на сегодня» (S-11, 09.10.2026). Издатели подписывают
#     короткоживущими сертификатами (Microsoft Artifact Signing — 72 часа) и ставят метку времени;
#     у Git for Windows, Node, Cursor, Handy и uv лист ко дню проверки уже истёк, у python.org — ещё
#     в 2025. Status='Valid' срок УЖЕ учёл — по метке времени подписи. А цепочка, построенная без
#     флагов на «сегодня», видела просроченный лист и отказывала КАЖДОМУ настоящему установщику
#     (NotTimeValid): онлайн-фолбэки git/node/cursor/python были вечно красными. Теперь доверие
#     держат три вещи, не зависящие от часов: Status='Valid' (по метке времени), корень цепочки в
#     LocalMachine\Root, EKU Code Signing — и пин издателя там, где вызывающий его задал. Просроченный
#     лист без метки времени отсекается раньше, на Status (он тогда не 'Valid'). А цепочке со звеном вне
#     срока (просрочен лист, промежуточный УЦ или корень) метка времени нужна не просто годная для Status,
#     а от TSA, чей корень тоже лежит в LocalMachine\Root (шаг b2): иначе малварь подписала бы украденным
#     просроченным ключом любого издателя и «датировала» подпись своим корнем TSA из HKCU — тем самым
#     ходом, ради которого весь этот гейт и написан. Смотреть при этом надо на ВСЕ звенья, не на лист:
#     годный лист, выпущенный просроченным промежуточным УЦ, — тот же ход с утёкшим ключом УЦ.
function Test-HmTrustedSigner {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ExpectedOrg = '',
        [string]$ExpectedSubjectMatch = '',
        [string]$ExpectedThumbprint = ''
    )
    if (-not (Test-Path -LiteralPath $Path)) { return 'файл не найден' }
    # (a) Authenticode: подпись есть И хеш файла не подменён.
    $sig = $null
    try { $sig = Get-AuthenticodeSignature -LiteralPath $Path } catch { return "подпись не читается: $($_.Exception.Message)" }
    if (-not $sig) { return 'подпись не читается' }
    if ($sig.Status -ne 'Valid') { return "Authenticode Status=$($sig.Status)" }
    $cert = $sig.SignerCertificate
    if (-not $cert) { return 'нет сертификата подписанта' }
    # (b) Цепочка ОБЯЗАНА выстраиваться до корня в LocalMachine\Root (CurrentUser\Root НЕ доверяем).
    #     Сроки годности звеньев не оцениваются (см. шапку): их уже оценил Status='Valid' по метке времени.
    $anchor = Get-HmSignerChainRoot -Cert $cert
    if (-not $anchor) { return 'не удалось построить цепочку' }
    if ($anchor.Why) { return [string]$anchor.Why }
    $root = $anchor.Root
    $machineRoots = $null
    try { $machineRoots = @(Get-HmMachineRootThumbprints) } catch { return "не удалось открыть машинный стор корней: $($_.Exception.Message)" }
    if ($machineRoots -notcontains [string]$root.Thumbprint) { return "корень цепочки НЕ в LocalMachine\Root (возможно отравление CurrentUser\Root): $($root.Subject)" }
    # (b2) Звено цепочки вне срока (лист, промежуточный УЦ или корень: просрочено либо ещё не вступило в
    #      силу) принимаем ТОЛЬКО по метке времени — а метке можно верить, лишь если её издатель (TSA)
    #      доверен МАШИНЕ, а не пользователю. Status='Valid' проверил метку тем же пользовательским
    #      chain-engine: medium-малварь кладёт СВОЙ корень TSA в HKCU\...\Root и «датирует» подпись
    #      украденным просроченным ключом прошлым числом — ключом издателя ИЛИ утёкшим ключом уже
    #      просроченного промежуточного УЦ (тогда сам лист свежий, и по его датам проверка не сработала бы).
    #      Поэтому цепочка метки времени тоже обязана заканчиваться в LocalMachine\Root (с EKU Time Stamping).
    #      Сам сертификат TSA вправе быть просроченным — как и лист, он оценён по времени подписи.
    #      Цепочке, где все звенья в сроке, этой проверки не нужно: у неё поведение прежнее.
    #      Срок всех звеньев считает помощник (OutOfWindow). «Не $false» — значит и «ответа нет»: без ответа
    #      считаем «вне срока», то есть ошибаемся в сторону строгости, а не пропуска.
    if ($anchor.OutOfWindow -ne $false) {
        $tsCert = $sig.TimeStamperCertificate
        if (-not $tsCert) { return 'сертификат подписанта или звено его цепочки вне срока годности, а метки времени нет' }
        $tsAnchor = Get-HmSignerChainRoot -Cert $tsCert -Eku '1.3.6.1.5.5.7.3.8'
        if (-not $tsAnchor) { return 'не удалось построить цепочку метки времени' }
        if ($tsAnchor.Why) { return ('метка времени: ' + [string]$tsAnchor.Why) }
        if ($machineRoots -notcontains [string]$tsAnchor.Root.Thumbprint) { return "корень метки времени НЕ в LocalMachine\Root (возможно отравление CurrentUser\Root): $($tsAnchor.Root.Subject)" }
    }
    # (c) EKU Code Signing у leaf-серта.
    $hasCodeSigning = $false
    foreach ($ext in $cert.Extensions) {
        if ($ext -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
            foreach ($oid in $ext.EnhancedKeyUsages) { if ($oid.Value -eq '1.3.6.1.5.5.7.3.3') { $hasCodeSigning = $true; break } }
        }
    }
    if (-not $hasCodeSigning) { return 'у сертификата нет EKU Code Signing' }
    # (d) Опциональный пин Organization (O=) из RDN — точное сравнение, не подстрока Subject.
    if ($ExpectedOrg) {
        $org = ''
        try {
            foreach ($ln in ($cert.SubjectName.Format($true) -split '\r?\n')) {
                if ($ln -match '^\s*O=') { $org = ($ln -replace '^\s*O=', '').Trim(); break }
            }
        } catch { }
        # .NET берёт значение в кавычки, если в нём запятая, «+», «;», «=» или пробелы по краям
        # (O="Anthropic, PBC"), а кавычку внутри самого значения удваивает. Без снятия этого обрамления пин
        # «Anthropic, PBC» не совпал бы НИКОГДА (так и было в claude-desktop.ps1). Снимаем ровно одно обрамление и
        # раздваиваем кавычки обратно, а не Trim('"'): значение, в котором кавычки есть на самом деле, не должно
        # сойти за значение без них.
        if ($org.Length -ge 2 -and $org.StartsWith('"') -and $org.EndsWith('"')) { $org = $org.Substring(1, $org.Length - 2).Replace('""', '"') }
        # Порядковое сравнение без учёта регистра, а не -ne: оператор сравнивает с учётом культуры, и мягкий перенос (U+00AD) в
        # имени издателя «не слышен» (проверено на PowerShell 5.1) — O="Microsoft Corporation\u00AD" проходило бы как пин.
        if (-not [string]::Equals($org, $ExpectedOrg, [StringComparison]::OrdinalIgnoreCase)) { return "Organization подписи ('$org') != ожидаемого ('$ExpectedOrg')" }
    }
    # (e) Опциональный (более мягкий) пин по Subject — для издателей, у кого RDN не подтверждён.
    if ($ExpectedSubjectMatch -and ("$($cert.Subject)" -notmatch $ExpectedSubjectMatch)) {
        return "Subject подписи не совпал с ожидаемым издателем ($($cert.Subject))"
    }
    # (f) Опциональный пин отпечатка листа (SHA-1; регистр, пробелы, двоеточия не важны). Пусто — пин выключен;
    #     без единой hex-цифры — отказ, а не «выключен». ОСТОРОЖНО: лист меняется при каждом перевыпуске (у
    #     Artifact Signing — раз в 72 часа), пин протухнет и молча сделает установку пропуском; стабильный — O= (d).
    if ($ExpectedThumbprint -and $ExpectedThumbprint.Trim()) {
        $wantThumb = ($ExpectedThumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
        if (([string]$cert.Thumbprint).ToUpperInvariant() -ne $wantThumb) { return 'отпечаток сертификата подписанта не совпал с пином' }
    }
    return ''
}

# --- УБОРКА ОСИРОТЕВШИХ одноразовых задач планировщика (HmDeElev_*/HmLaunch_*). ---
#
# Задача удаляется в finally Invoke-HmDeElevated (и в cleanup() main.js для HmLaunch_*),
# но если установщик ЗАКРЫЛИ/УБИЛИ посреди установки, finally не исполняется — задачи
# оставались в планировщике пользователя НАВСЕГДА и копились с каждым прерванным
# запуском. In-process гарантии при kill невозможны в принципе, поэтому надёжность
# достигается ПОДМЕТАНИЕМ: при каждой загрузке примитива (дот-сорс внизу файла) сносим
# сирот ПРОШЛЫХ прерванных запусков — своих (HmDeElev_*) и главного процесса (HmLaunch_*).
#
# НЕЛЬЗЯ удалить задачу, которую прямо сейчас гоняет ПАРАЛЛЕЛЬНЫЙ экземпляр установщика:
# его родитель опрашивает «Last Result», и снос задачи провалил бы ему установку. Поэтому
# решение «сирота или нет» — консервативное, по СОСТОЯНИЮ и ВОЗРАСТУ:
#   • State Running/Queued → живая, не трогаем;
#   • возраст < MaxAgeMinutes (60) → возможно, живая у параллельного экземпляра
#     (сама задача живёт ≤10 мин по ExecutionTimeLimit, родитель ждёт ≤630 с — час
#     покрывает всё с многократным запасом), не трогаем;
#   • возраст неизвестен (нет ни даты регистрации, ни файла задачи, ни факта запуска)
#     → fail-safe, НЕ удаляем (лучше лишняя задача, чем сорванная чужая установка).
# Возраст берём локаль-независимо: RegistrationInfo.Date (наш XML теперь пишет её сам) →
# CreationTime файла задачи в System32\Tasks (покрывает HmLaunch_* из main.js и задачи
# старых версий без Date) → LastRunTime (для «никогда не запускалась» планировщик отдаёт
# сентинел 1899/1999 года — отсекается порогом Year > 2000).
#
# БЕЗ модуля ScheduledTasks (в урезанном PSModulePath его автозагрузка падает — тот же
# класс сбоя, что у Get-Acl выше) — только COM Schedule.Service, он модулей не требует.

# Чистое решение «задача — сирота?» — вынесено отдельно, тестируется БЕЗ планировщика.
function Test-HmTaskIsOrphan {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [int]$State = 0,            # TASK_STATE_*: 2=Queued, 3=Ready, 4=Running
        [string]$RegDate = '',      # RegistrationInfo.Date (ISO-строка) или ''
        [object]$FileBorn = $null,  # CreationTime файла задачи (datetime) или $null
        [object]$LastRun = $null,   # LastRunTime (datetime; сентинел <2000 = не запускалась)
        [string]$ExcludeTag = '',
        [int]$MaxAgeMinutes = 60,
        [object]$Now = $null
    )
    if ($null -eq $Now) { $Now = Get-Date }
    # Только НАШИ одноразовые теги (hex-хвост) — никакой чужой задачи не касаемся.
    if ($Name -notmatch '^Hm(DeElev|Launch)_[0-9a-fA-F]{8,64}$') { return $false }
    if ($ExcludeTag -and ($Name -eq $ExcludeTag)) { return $false }
    if ($State -eq 4 -or $State -eq 2) { return $false }   # Running/Queued = живая
    $born = $null
    if ($RegDate) { try { $born = [datetime]$RegDate } catch { $born = $null } }   # [datetime]-каст = invariant culture
    if ((-not $born) -and ($FileBorn -is [datetime]) -and $FileBorn.Year -gt 2000) { $born = $FileBorn }
    if ((-not $born) -and ($LastRun -is [datetime]) -and $LastRun.Year -gt 2000) { $born = $LastRun }
    if (-not $born) { return $false }   # возраст неизвестен → fail-safe, не удаляем
    return (($Now - $born).TotalMinutes -ge $MaxAgeMinutes)
}

# Подметание корневой папки планировщика. Возвращает имена удалённых задач (может пусто).
# Любой сбой (COM недоступен, нет прав на чужую задачу) — молча пропускаем: уборка
# best-effort и НИКОГДА не роняет установку.
function Remove-HmOrphanTasks {
    param([string]$ExcludeTag = '', [int]$MaxAgeMinutes = 60)
    $removed = @()
    try {
        $sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
        $tasksDir = Join-Path (Join-Path $sysRoot 'System32') 'Tasks'
        $svc = New-Object -ComObject 'Schedule.Service'
        $svc.Connect()
        $root = $svc.GetFolder('\')
        $now = Get-Date
        # GetTasks(1) = TASK_ENUM_HIDDEN: наши задачи создаются <Hidden>true</Hidden>.
        foreach ($t in @($root.GetTasks(1))) {
            $name = ''; $state = 0; $regDate = ''; $fileBorn = $null; $lastRun = $null
            try { $name = [string]$t.Name } catch { continue }
            if ($name -notmatch '^Hm(DeElev|Launch)_') { continue }   # чужие не читаем вовсе
            try { $state = [int]$t.State } catch { $state = 0 }
            try { $regDate = [string]$t.Definition.RegistrationInfo.Date } catch { $regDate = '' }
            try {
                $f = Join-Path $tasksDir $name
                if (Test-Path -LiteralPath $f) { $fileBorn = (Get-Item -LiteralPath $f -Force).CreationTime }
            } catch { $fileBorn = $null }
            try { $lastRun = $t.LastRunTime } catch { $lastRun = $null }
            if (Test-HmTaskIsOrphan -Name $name -State $state -RegDate $regDate -FileBorn $fileBorn `
                    -LastRun $lastRun -ExcludeTag $ExcludeTag -MaxAgeMinutes $MaxAgeMinutes -Now $now) {
                try { $root.DeleteTask($name, 0); $removed += $name } catch { }
            }
        }
    } catch { }
    # БЕЗ `, $removed`: вызывающий собирает через @(...), а «массив в массиве» давал бы
    # Count=1 и «System.Object[]» вместо имён. Пустой массив → пустой конвейер → @() = 0.
    return $removed
}

# --- «Last Result» задачи → вердикт. ЧИСТАЯ функция (без планировщика), тестируется напрямую. ---
#
# Раньше ЛЮБОЕ итоговое значение считалось кодом выхода обёртки (Gate='medium'). Для двух
# классов значений это неправда, и именно на них падали люди:
#   • HRESULT-ошибки самого планировщика: 0x8007xxxx (Win32-ошибка запуска — 0x80070005
#     «отказано в доступе», 0x800704DD «пользователь не вошёл», …) и SCHED_E_* 0x800413xx.
#     Это не код программы: ДЕЙСТВИЕ задачи (powershell) вообще не стартовало. Шаги печатали
#     такое число как свой результат — «pip exit=-2147024891», «reg.exe вернул -2147024891».
#   • SCHED_S_* 0x413xx — статусы ЗАДАЧИ: 267014 = прервана по лимиту (что-то из запущенного
#     могло остаться жить), остальные ничего не доказывают.
# Gate: 'medium' — обёртка отработала на medium, Code = код программы;
#       'refused' — обёртка увидела НЕ medium и бинарь НЕ запускала (exit 210);
#       'not-started' — действие задачи не стартовало, бинарь НЕ запускался;
#       'terminated' — прервана по лимиту времени; 'unknown' — итога нет / служебный статус.
# Значения ≥ 0x80000000 сравниваются как long (суффикс L): в PowerShell 5.1 литерал
# 0x80070000 без суффикса — это ОТРИЦАТЕЛЬНЫЙ Int32, и сравнение молча не совпадало бы.
function Get-HmTaskVerdict {
    param([AllowNull()][AllowEmptyString()][string]$LastResult)
    $n = 0L
    if ([string]::IsNullOrWhiteSpace($LastResult) -or -not [long]::TryParse($LastResult.Trim(), [ref]$n) -or
        $n -lt -2147483648L -or $n -gt 4294967295L) {
        return [pscustomobject]@{ Gate = 'unknown'; Code = -1; Hex = ''; Kind = 'no-result' }
    }
    $u = [uint32]($n -band 0xFFFFFFFFL)
    $signed = [BitConverter]::ToInt32([BitConverter]::GetBytes($u), 0)
    $hex = '0x{0:X8}' -f $u
    if ($u -eq 210) { return [pscustomobject]@{ Gate = 'refused'; Code = -1; Hex = $hex; Kind = 'refused' } }
    if ($u -eq 0x41306) { return [pscustomobject]@{ Gate = 'terminated'; Code = $signed; Hex = $hex; Kind = 'sched-terminated' } }
    if ($u -ge 0x41300 -and $u -le 0x413FF) { return [pscustomobject]@{ Gate = 'unknown'; Code = $signed; Hex = $hex; Kind = 'sched-status' } }
    if ((($u -band 0xFFFF0000L) -eq 0x80070000L) -or (($u -band 0xFFFFFF00L) -eq 0x80041300L)) {
        return [pscustomobject]@{ Gate = 'not-started'; Code = $signed; Hex = $hex; Kind = 'launch-failed' }
    }
    return [pscustomobject]@{ Gate = 'medium'; Code = $signed; Hex = $hex; Kind = 'exit' }
}

# --- Куда дочерний процесс пишет СВОЙ вывод (диагностика, НЕ аттестация). ---
# ~/.hamidun-setup/deelev/<метка>.log — рядом с install.log: поддержка просит одну папку.
# Пишет ТОЛЬКО де-элевированный ребёнок (medium) — elevated-процесс в этот user-writable
# каталог не пишет и НЕ ЧИТАЕТ его (подмену пути ссылкой нечем использовать). Итог шага
# решает проверка по диску/реестру у вызывающего, а не этот файл.
function Get-HmDeElevLogPath {
    param([string]$Label)
    $safe = ([string]$Label) -replace '[^A-Za-z0-9._-]', '-'
    if (-not $safe) { $safe = 'deelev' }
    if ($safe.Length -gt 80) { $safe = $safe.Substring(0, 80) }
    $prof = ''
    try { $prof = [Environment]::GetFolderPath('UserProfile') } catch { $prof = '' }
    if (-not $prof) { return '' }
    return [System.IO.Path]::Combine($prof, '.hamidun-setup', 'deelev', $safe + '.log')
}

# Тело одинарно-кавыченного литерала PowerShell (БЕЗ внешних кавычек). Разбор считает
# ограничителями не только ASCII ' , но и четыре типографские кавычки U+2018 U+2019 U+201A
# U+201B, а удвоение любой пары даёт один литеральный знак. Удвоения одного лишь ASCII хватало
# для «O'Brien», но не для «O’Brien»: незакрытый литерал ломал разбор обёртки целиком, и задача
# отчитывалась ошибкой программы, которая на деле не запускалась. Удваиваем каждую из пяти.
# Парная функция на стороне Node — deelev-route.psQuoteBody (одна и та же таблица знаков).
function ConvertTo-HmPsLiteral {
    param([AllowEmptyString()][AllowNull()][string]$Value)
    if ($null -eq $Value) { return '' }
    return [regex]::Replace($Value, "['‘’‚‛]", '$0$0')
}

# Тело обёртки, которую планировщик исполняет от имени пользователя, — ЧИСТАЯ функция (строка).
# Вынесена из Invoke-HmDeElevated, чтобы тест мог разобрать её настоящим парсером PowerShell на путях
# с «O’Brien» и сверить, что литералы означают ровно те значения, что были.
# Литералы — single-quoted, удвоение всех пяти знаков-ограничителей (ConvertTo-HmPsLiteral).
function New-HmDeElevWrapperBody {
    param([string]$S32, [string]$SysRoot, [string]$Whoami, [string]$Exe, [string[]]$Arguments = @(), [string]$Label = '', [string]$LogPath = '')
    $s32Lit = ConvertTo-HmPsLiteral $S32
    $srLit  = ConvertTo-HmPsLiteral $SysRoot
    $whoLit = ConvertTo-HmPsLiteral $Whoami
    $exeLit = ConvertTo-HmPsLiteral $Exe
    $argLit = ''
    $argList = @($Arguments | Where-Object { $null -ne $_ })      # $null вместо списка — «аргументов нет»
    if ($argList.Count -gt 0) {
        $argLit = ' ' + (($argList | ForEach-Object { "'" + (ConvertTo-HmPsLiteral $_) + "'" }) -join ' ')
    }
    $logLit = ConvertTo-HmPsLiteral $LogPath

    # Тело обёртки. СТРОГО ПЕРВЫМИ — присваивания чистых env ЛИТЕРАЛАМИ (ни одного cmdlet до
    # них). Затем integrity-self-check через АБСОЛЮТНЫЙ System32\whoami: НЕ medium -> exit 210
    # ДО всего остального. Exit-код обёртки станет «Last Result» задачи (доверенный сигнал).
    # Дальше — уже на medium: вывод программы уходит в диагностический журнал ребёнка
    # (раньше он терялся целиком, и причину отказа code.cmd было не восстановить ничем).
    # Сбой записи журнала программу не останавливает: журнал — диагностика, а не условие.
    $body =
        "`$env:PSModulePath='$s32Lit\WindowsPowerShell\v1.0\Modules'`n" +
        "`$env:Path='$s32Lit;$srLit;$s32Lit\WindowsPowerShell\v1.0'`n" +
        "if(-not (@(& '$whoLit' /groups 2>`$null) -match 'S-1-16-8192')){ exit 210 }`n" +
        "`$l='$logLit'`n" +
        "if(`$l){ try{ `$d=[IO.Path]::GetDirectoryName(`$l); if(-not [IO.Directory]::Exists(`$d)){ [void][IO.Directory]::CreateDirectory(`$d) }; if([IO.File]::Exists(`$l) -and (New-Object IO.FileInfo(`$l)).Length -gt 524288){ [IO.File]::Delete(`$l) }; [IO.File]::AppendAllText(`$l, ('=== '+(Get-Date -Format s)+' route=task label=$Label ===' + [Environment]::NewLine)) }catch{ `$l='' } }`n" +
        "`$o=@(& '$exeLit'$argLit 2>&1 | ForEach-Object { [string]`$_ })`n" +
        "`$c=`$LASTEXITCODE; if(`$null -eq `$c){`$c=0}`n" +
        "if(`$l){ try{ [IO.File]::AppendAllText(`$l, ((`$o + ('=== exit '+`$c+' ===')) -join [Environment]::NewLine) + [Environment]::NewLine) }catch{} }`n" +
        "exit `$c`n"
    return $body
}

function Invoke-HmDeElevated {
    param([Parameter(Mandatory = $true)][string]$Exe, [string[]]$Arguments = @(), [string]$Label = '')

    # Этап, на котором примитив сейчас. Вызывающему (Invoke-HmDeElevatedSafe) он отвечает на
    # вопрос «могла ли задача что-то запустить»: $null до /Run — не могла, после — могла.
    $script:HmDeElevStage = 'prereq'

    # --- Абсолютные системные бинари (fail-closed, если чего-то нет) ---
    $sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $s32      = Join-Path $sysRoot 'System32'
    $psV1     = Join-Path $s32 'WindowsPowerShell\v1.0'
    $psExe    = Join-Path $psV1 'powershell.exe'
    $schtasks = Join-Path $s32 'schtasks.exe'
    $whoami   = Join-Path $s32 'whoami.exe'
    $icacls   = Join-Path $s32 'icacls.exe'
    foreach ($bin in @($psExe, $schtasks, $whoami, $icacls)) {
        if (-not (Test-Path -LiteralPath $bin)) { return $null }
    }

    # --- Чистые PATH / PSModulePath (анти module-hijack) для ПАРЕНТА на время работы примитива ---
    $savedPath = $env:Path
    $savedPsm  = $env:PSModulePath
    $env:PSModulePath = (Join-Path $psV1 'Modules')
    $env:Path         = ($s32 + ';' + $sysRoot + ';' + $psV1)

    $tag = 'HmDeElev_' + [guid]::NewGuid().ToString('N')

    # ProgramData на СИСТЕМНОМ диске (не %ProgramData% env вслепую): корень из $sysRoot.
    $pdRoot   = [System.IO.Path]::GetPathRoot($sysRoot)
    $progData = Join-Path $pdRoot 'ProgramData'

    # Integrity ПАРЕНТА: только при high/system staging-каталог ОБЯЗАН быть заперт (privesc-
    # риск существует лишь когда родитель elevated). Unknown -> трактуем как elevated (fail-safe).
    $selfLvl  = Get-HmSelfIntegrity -WhoamiExe $whoami
    $elevated = ($selfLvl -ne 'medium' -and $selfLvl -ne 'low')

    if (-not $Label) { $Label = [System.IO.Path]::GetFileNameWithoutExtension($Exe) }
    # Метка вшивается в тело обёртки как литерал — только безопасные символы (кавычка в ней
    # сломала бы разбор обёртки, и задача «упала» бы с кодом, не имеющим отношения к программе).
    $Label  = ([string]$Label) -replace '[^A-Za-z0-9._-]', '-'
    $body = New-HmDeElevWrapperBody -S32 $s32 -SysRoot $sysRoot -Whoami $whoami -Exe $Exe -Arguments $Arguments `
        -Label $Label -LogPath (Get-HmDeElevLogPath -Label $Label)
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($body))
    $wrapArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $b64

    $result  = $null
    $dir     = $null
    $xmlFile = $null
    try {
        $script:HmDeElevStage = 'staging'
        $dir = New-HmSecureStagingDir -ProgramData $progData -Icacls $icacls -Elevated $elevated
        if (-not $dir) { return $null }   # elevated и каталог не заперт -> fail-closed
        $xmlFile = Join-Path $dir 'task.xml'

        # XML: принципал = текущий интерактивный пользователь, InteractiveToken, LeastPrivilege
        # (= /RL LIMITED = medium). Тело обёртки — ЦЕЛИКОМ в <Arguments> (нет лимита 261 как у /TR).
        $userId     = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $userXml    = [System.Security.SecurityElement]::Escape($userId)
        $psExeXml   = [System.Security.SecurityElement]::Escape($psExe)
        $wrapArgXml = [System.Security.SecurityElement]::Escape($wrapArgs)
        # <Date> (ISO, ToString('s') — invariant): по ней Remove-HmOrphanTasks на СЛЕДУЮЩИХ
        # запусках отличает свежую задачу (возможно, живую у параллельного экземпляра) от
        # осиротевшей после убитого установщика. В схеме RegistrationInfo Date идёт ПЕРВОЙ.
        $regDateXml = [System.Security.SecurityElement]::Escape((Get-Date).ToString('s'))
        $taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Date>$regDateXml</Date><Description>Hamidun de-elevated one-shot</Description></RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>$userXml</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$psExeXml</Command>
      <Arguments>$wrapArgXml</Arguments>
    </Exec>
  </Actions>
</Task>
"@
        $script:HmDeElevStage = 'create'
        Set-Content -LiteralPath $xmlFile -Value $taskXml -Encoding Unicode

        # Создать задачу через АБСОЛЮТНЫЙ schtasks.exe по XML. Провал -> fail-closed.
        & $schtasks '/Create' '/TN' $tag '/XML' $xmlFile '/F' 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { return $null }
        # XML больше не нужен (определение задачи — в БД планировщика). Удаляем сразу.
        Remove-Item -LiteralPath $xmlFile -Force -ErrorAction SilentlyContinue; $xmlFile = $null

        $script:HmDeElevStage = 'run'
        & $schtasks '/Run' '/TN' $tag 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { return $null }
        # С этого места задача МОГЛА стартовать: любой сбой ниже (исключение, нет итога) —
        # не повод запускать то же действие вторым путём поверх возможно живого первого.
        $script:HmDeElevStage = 'running'

        # Ждём завершения по ЛОКАЛЬ-НЕЗАВИСИМОМУ «Last Result» (поле #6 CSV /HRESULT):
        # 267009=выполняется, 267011=ещё не запускалась, иначе=exit-код обёртки.
        $lastResult = $null
        # Дедлайн согласован с <ExecutionTimeLimit>PT10M</ExecutionTimeLimit> задачи (+30 с запаса):
        # при 180 с долгая (но нормальная) установка vsix на слабой машине с активным Defender
        # объявлялась провалом, вызывающий стартовал ВТОРУЮ конкурентную задачу поверх первой.
        # Реального зависания это не удлиняет: планировщик сам прибьёт задачу на 10-й минуте
        # (AllowHardTerminate=true), Last Result станет ненулевым и цикл выйдет раньше дедлайна.
        $deadline = (Get-Date).AddSeconds(630)
        # Пока ждём — раз в минуту печатаем, что живы. Без этого шаг «vscode» молчит
        # до 10 минут на КАЖДОМ расширении, и сторож молчания в main.js начинает
        # пугать пользователя: «шаг не выдаёт вывод 30/40/50 мин, возможно установщик
        # завис». У человека это выглядит как намертво вставшая установка, хотя идёт
        # обычная распаковка vsix под антивирусом. Живой отсчёт снимает и панику,
        # и ложные срабатывания сторожа.
        $waitStart = Get-Date
        $nextTick = $waitStart.AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 400
            if ((Get-Date) -ge $nextTick) {
                $el = [int]((Get-Date) - $waitStart).TotalMinutes
                Write-Host "  …устанавливается, прошло $el мин (лимит 10 мин, это нормально на медленной машине)"
                $nextTick = (Get-Date).AddSeconds(60)
            }
            $csv = & $schtasks '/Query' '/TN' $tag '/HRESULT' '/FO' 'CSV' '/NH' '/V' 2>$null | Out-String
            $line = ($csv -split "`r?`n" | Where-Object { $_ -match '"' } | Select-Object -First 1)
            if (-not $line) { continue }
            $m = [regex]::Matches($line, '"([^"]*)"')   # base64 без кавычек -> поля разбираются надёжно
            if ($m.Count -gt 6) {
                $lr = $m[6].Groups[1].Value
                if ($lr -ne '267009' -and $lr -ne '267011') { $lastResult = $lr; break }
            }
        }

        # Классификация — в чистой Get-HmTaskVerdict (тестируется без планировщика):
        # 210 -> refused (обёртка увидела НЕ medium), HRESULT планировщика -> not-started,
        # 267014 -> terminated, нет итога/служебный статус -> unknown, иначе medium + код.
        $v = Get-HmTaskVerdict -LastResult $lastResult
        $script:HmDeElevStage = 'done'
        $result = [pscustomobject]@{ Gate = $v.Gate; Code = $v.Code; Hex = $v.Hex; Kind = $v.Kind
                                     LastResult = [string]$lastResult }
    } catch {
        $result = $null
    } finally {
        & $schtasks '/Delete' '/TN' $tag '/F' 2>&1 | Out-Null
        if ($xmlFile) { Remove-Item -LiteralPath $xmlFile -Force -ErrorAction SilentlyContinue }
        # $dir = рабочий `w` ВНУТРИ запертого HmDeElev-<hex>: голый Remove-Item убирал бы
        # только `w`, внешний каталог копился в %ProgramData% — помощник поднимается к родителю.
        if ($dir)     { Remove-HmSecureStagingDir -Path $dir }
        $env:Path         = $savedPath
        $env:PSModulePath = $savedPsm
    }
    return $result
}

# =====================================================================================
# ЗАПАСНОЙ ПУТЬ: то же действие с токеном оболочки Explorer (см. шапку файла)
# =====================================================================================

# Можно ли пускать запасной путь — ЧИСТАЯ функция. Только когда ДОКАЗАНО, что задача ничего
# не запустила: иначе второй запуск пошёл бы поверх живого первого (две установки в один
# ~/.vscode/extensions портят каталог). $null до /Run (prereq/staging/create/run) — задача
# не стартовала; 'not-started' — планировщик не смог запустить действие; 'refused' —
# обёртка увидела НЕ medium и программу не запускала. 'medium' (отработало), 'unknown',
# 'terminated' и сбой после /Run (может ещё идти) — нет.
function Test-HmShellFallbackAllowed {
    param([AllowNull()][object]$TaskResult, [string]$Stage = '')
    if ($null -eq $TaskResult) { return (@('prereq', 'staging', 'create', 'run') -contains $Stage) }
    return (@('not-started', 'refused') -contains [string]$TaskResult.Gate)
}

# Автоповтор — ЧИСТАЯ функция: только если НИ ОДИН запуск попытки не может ещё идти
# (Finished у каждого). Ничего не запускали — повторять безопасно.
function Test-HmDeElevRetryAllowed {
    param([object[]]$Attempts = @())
    foreach ($a in @($Attempts)) {
        if ($null -eq $a) { continue }
        if (-not [bool]$a.Finished) { return $false }
    }
    return $true
}

# Был ли в какой-то из попыток отказ по политике — ЧИСТАЯ функция по итогам Merge-HmDeElevResult.
# Gate 'refused' = запуск не получил обычного уровня прав (UAC выключен, встроенный
# администратор, оболочка другой учётной записи): через минуту будет тот же отказ, и автоповтор
# лишь удлиняет шаг. Недоступность ('unavailable') и неподтверждённый запуск ('medium', но
# расширения нет) отказом по политике НЕ считаются — там повтор иногда помогает.
function Test-HmDeElevRefused {
    param([object[]]$Attempts = @())
    foreach ($a in @($Attempts)) {
        if ($null -eq $a) { continue }
        if ([string]$a.Gate -eq 'refused' -or [string]$a.ShellGate -eq 'refused') { return $true }
    }
    return $false
}

# Аргумент командной строки Windows в кавычках (правила CommandLineToArgvW/MSVCRT): хвостовые
# «\» перед закрывающей кавычкой удваиваются, иначе они её экранируют. Кавычки ВНУТРИ значения
# сюда не доходят — их отвергают New-HmWinCommandLine/New-HmShellCmdLine.
function ConvertTo-HmWinArg {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { $Value = '' }
    $m = [regex]::Match($Value, '\\+$')
    if ($m.Success) { $Value = $Value + $m.Value }
    return '"' + $Value + '"'
}

# Прямой запуск exe (без cmd). '' — если значение нельзя передать однозначно (кавычка,
# перевод строки, NUL): лучше отказ, чем программа получит другой аргумент.
function New-HmWinCommandLine {
    param([string]$Exe, [string[]]$Arguments = @())
    $all = @($Exe) + @($Arguments)
    foreach ($a in $all) { if ([string]$a -match "[`"`r`n`0]") { return '' } }
    return (($all | ForEach-Object { ConvertTo-HmWinArg $_ }) -join ' ')
}

# ПРЕДЕЛ длины lpCommandLine у CreateProcessWithTokenW — 1024 знака (документация Microsoft:
# «The maximum length of this string is 1024 characters»). Прежняя строка с каталогом журнала,
# ротацией, заголовком и ДВУМЯ копиями программы («если журнал есть — с записью, иначе без»)
# для pip с офлайн-колёсами выходила за 1100, для Handy — за 1040 даже при имени пользователя
# из одной буквы, и запасной путь отказывал именно там, где был нужен. Теперь программа в строке
# ОДНА, а всё про журнал живёт в отдельной короткой строке New-HmShellLogPrepLine.
$script:HmMaxTokenCmdLine = 1024

# Командная строка cmd.exe для запуска, где вывод программы дописывается в её журнал (пишет сам
# ребёнок, на medium): ОДНА копия программы и одно перенаправление. LogPath пуст — без записи
# (так запускают .cmd/.bat: CreateProcess сам их не исполняет, нужен cmd /c). /d — без AutoRun из
# реестра, /e:on — расширения, /v:off — «!» в путях остаётся буквой. «%» отвергается: в cmd /c он
# раскрывает переменные даже внутри кавычек, и путь «…%PATH%…» стал бы другим путём.
function New-HmShellCmdLine {
    param([string]$CmdExe, [string]$Exe, [string[]]$Arguments = @(), [string]$LogPath = '')
    $all = @($CmdExe, $Exe, $LogPath) + @($Arguments)
    foreach ($a in $all) { if ([string]$a -match "[`"%`r`n`0]") { return '' } }
    $target = ((@($Exe) + @($Arguments)) | ForEach-Object { ConvertTo-HmWinArg $_ }) -join ' '
    if ($LogPath) { $target += ' >>"' + $LogPath + '" 2>&1' }
    return (ConvertTo-HmWinArg $CmdExe) + ' /d /e:on /v:off /s /c "' + $target + '"'
}

# Командная строка cmd.exe для ГОТОВОГО текста команды (несколько команд через «&») — так
# открывают окно терминала БЕЗ файла-лаунчера: писать файл в пользовательскую папку из-под
# админа незачем, а значит, нечего подменять и некуда вести ссылке. В отличие от
# New-HmShellCmdLine («%» там отвергается: это ДАННЫЕ — путь, и «%PATH%» в нём стал бы другим
# путём), здесь текст НАШ и фиксированный, а «%USERPROFILE%» нужен именно как переменная,
# которую раскроет cmd у ребёнка — уже под токеном пользователя, а не под нашим. Поэтому «%» и
# кавычки внутри текста остаются как написаны, а чужих данных в текст не подставляют: путь
# профиля сюда не попадает, рабочая папка едет отдельным параметром CreateProcessWithTokenW.
# Ключ /s снимает ровно внешнюю пару кавычек. Перевод строки и NUL отвергаются: cmd читает
# командную строку до первого из них, остальное молча пропало бы.
function New-HmShellScriptLine {
    param([string]$CmdExe, [string]$Script)
    if (-not $CmdExe -or -not $Script) { return '' }
    if ([string]$CmdExe -match "[`"`r`n`0]") { return '' }
    if ([string]$Script -match "[`r`n`0]") { return '' }
    return (ConvertTo-HmWinArg $CmdExe) + ' /d /e:on /v:off /s /c "' + $Script + '"'
}

# Короткая подготовка журнала ПЕРЕД запуском (отдельным дождавшимся процессом): каталог,
# ротация (файл больше 512 КБ удаляется), заголовок. Код выхода 0 — журнал открывается на запись;
# иначе перенаправление в основной строке сорвало бы запуск самой программы (cmd не исполняет
# команду, если не может открыть файл вывода), и тогда программу запускают напрямую, без журнала.
function New-HmShellLogPrepLine {
    param([string]$CmdExe, [string]$LogPath, [string]$Label = '')
    if (-not $LogPath) { return '' }
    foreach ($a in @($CmdExe, $LogPath)) { if ([string]$a -match "[`"%`r`n`0]") { return '' } }
    $dir = [System.IO.Path]::GetDirectoryName($LogPath)
    if (-not $dir) { return '' }
    $safeLabel = ([string]$Label) -replace '[^A-Za-z0-9._-]', '-'
    $inner = '(if not exist "' + $dir + '\" mkdir "' + $dir + '") >nul 2>&1' +
        ' & (if exist "' + $LogPath + '" for %I in ("' + $LogPath + '") do @if %~zI GTR 524288 del /f /q "' + $LogPath + '") >nul 2>&1' +
        ' & (echo === %DATE% %TIME% route=shell-token label=' + $safeLabel + ' ===) >>"' + $LogPath + '" 2>nul && exit 0 || exit 1'
    return (ConvertTo-HmWinArg $CmdExe) + ' /d /e:on /v:off /s /c "' + $inner + '"'
}

# Как запускать дожидаемое действие запасным путём — ЧИСТАЯ функция (ничего не запускает).
#   Mode 'logged' — Prep (подготовка журнала) + Main (программа с записью вывода), обе ≤ 1024;
#   Mode 'direct' — только Main: программа напрямую, вывод НЕ записывается; Note — почему;
#   Mode ''       — запускать нельзя (Error): значение не выразить аргументом, строка длиннее предела.
# DirectApp/DirectLine — прямая форма (запасная, если журнал окажется недоступен). .cmd/.bat
# CreateProcess сам не исполняет — для них «прямая» форма это cmd /c без записи вывода.
# NoLog — журнал не предполагался (запуск окна редактора): Note пуст.
# CmdScript — вместо Exe/Arguments готовый текст команды для cmd.exe (окно терминала без
# файла-лаунчера, New-HmShellScriptLine): всегда прямая форма, журнала у такого запуска нет.
function Get-HmShellLaunchPlan {
    param([string]$CmdExe, [string]$Exe, [string[]]$Arguments = @(), [string]$LogPath = '', [string]$Label = '', [switch]$NoLog,
          [string]$CmdScript = '')
    $max = 1024
    if ($script:HmMaxTokenCmdLine) { $max = [int]$script:HmMaxTokenCmdLine }
    $plan = [pscustomobject]@{ Mode = ''; App = ''; Main = ''; Prep = ''; DirectApp = ''; DirectLine = ''; Note = ''; Error = '' }
    $isBatch = ([string]$Exe -match '\.(cmd|bat)$')
    if ($CmdScript) {
        $plan.DirectApp  = $CmdExe
        $plan.DirectLine = New-HmShellScriptLine -CmdExe $CmdExe -Script $CmdScript
    } elseif ($isBatch) {
        $plan.DirectApp  = $CmdExe
        $plan.DirectLine = New-HmShellCmdLine -CmdExe $CmdExe -Exe $Exe -Arguments $Arguments
    } else {
        $plan.DirectApp  = $Exe
        $plan.DirectLine = New-HmWinCommandLine -Exe $Exe -Arguments $Arguments
    }
    if (-not $plan.DirectLine) {
        $plan.Error = if ($CmdScript) { 'текст команды пуст либо содержит перевод строки или нулевой знак' } else {
            'путь или аргумент содержит символ, который нельзя безопасно передать (кавычка' +
            $(if ($isBatch) { ', «%»' } else { '' }) + ' или перевод строки)' }
        return $plan
    }
    if ($plan.DirectLine.Length -gt $max) {
        $plan.Error = 'командная строка запуска (' + $plan.DirectLine.Length + ' знаков) длиннее предела ' + $max + ' у CreateProcessWithTokenW'
        return $plan
    }
    $plan.Mode = 'direct'; $plan.App = $plan.DirectApp; $plan.Main = $plan.DirectLine
    if ($NoLog -or $CmdScript) { return $plan }
    if (-not $LogPath) { $plan.Note = 'каталог журнала не определён'; return $plan }
    $main = New-HmShellCmdLine -CmdExe $CmdExe -Exe $Exe -Arguments $Arguments -LogPath $LogPath
    $prep = New-HmShellLogPrepLine -CmdExe $CmdExe -LogPath $LogPath -Label $Label
    if (-not $main -or -not $prep) { $plan.Note = 'в пути журнала или программы есть «%» либо кавычка'; return $plan }
    if ($main.Length -gt $max) { $plan.Note = 'строка запуска с записью вывода (' + $main.Length + ' знаков) длиннее предела ' + $max; return $plan }
    if ($prep.Length -gt $max) { $plan.Note = 'строка подготовки журнала (' + $prep.Length + ' знаков) длиннее предела ' + $max; return $plan }
    $plan.Mode = 'logged'; $plan.App = $CmdExe; $plan.Main = $main; $plan.Prep = $prep
    return $plan
}

# Системные вызовы для запасного пути — БЕЗ компиляции. Add-Type зовёт csc.exe, который
# пишет сборку в %TEMP% и затем ГРУЗИТ её: medium-малварь того же юзера успела бы подменить
# DLL между записью и загрузкой — код под админом. Сборка рождается в памяти
# (Reflection.Emit, AssemblyBuilderAccess.Run): ни файла, ни компилятора, ни модулей.
function Get-HmNativeApi {
    if ($script:HmNativeApi) { return $script:HmNativeApi }
    $an  = New-Object System.Reflection.AssemblyName('HmShellToken')
    $asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly($an, [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $mod = $asm.DefineDynamicModule('HmShellToken')
    $tb  = $mod.DefineType('HmShellToken.Native', [System.Reflection.TypeAttributes]'Public, Class, Abstract, Sealed')
    $dia = [System.Runtime.InteropServices.DllImportAttribute]
    $ctor   = $dia.GetConstructor([Type[]]@([string]))
    $fields = [System.Reflection.FieldInfo[]]@($dia.GetField('SetLastError'), $dia.GetField('CharSet'), $dia.GetField('ExactSpelling'))
    $values = [object[]]@($true, [System.Runtime.InteropServices.CharSet]::Unicode, $true)
    $u32r = [UInt32].MakeByRefType()
    $ipr  = [IntPtr].MakeByRefType()
    $sigs = @(
        @('user32.dll',   'GetShellWindow',           [IntPtr], [Type[]]@()),
        @('user32.dll',   'GetWindowThreadProcessId', [UInt32], [Type[]]@([IntPtr], $u32r)),
        @('kernel32.dll', 'OpenProcess',              [IntPtr], [Type[]]@([UInt32], [bool], [UInt32])),
        @('advapi32.dll', 'OpenProcessToken',         [bool],   [Type[]]@([IntPtr], [UInt32], $ipr)),
        @('advapi32.dll', 'GetTokenInformation',      [bool],   [Type[]]@([IntPtr], [Int32], [IntPtr], [UInt32], $u32r)),
        @('advapi32.dll', 'DuplicateTokenEx',         [bool],   [Type[]]@([IntPtr], [UInt32], [IntPtr], [Int32], [Int32], $ipr)),
        @('advapi32.dll', 'CreateProcessWithTokenW',  [bool],   [Type[]]@([IntPtr], [UInt32], [string], [System.Text.StringBuilder], [UInt32], [IntPtr], [string], [IntPtr], [IntPtr])),
        @('kernel32.dll', 'WaitForSingleObject',      [UInt32], [Type[]]@([IntPtr], [UInt32])),
        @('kernel32.dll', 'GetExitCodeProcess',       [bool],   [Type[]]@([IntPtr], $u32r)),
        @('kernel32.dll', 'CloseHandle',              [bool],   [Type[]]@([IntPtr]))
    )
    foreach ($s in $sigs) {
        $pt = [Type[]]$s[3]
        $mb = $tb.DefineMethod($s[1], [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl', $s[2], $pt)
        for ($i = 0; $i -lt $pt.Length; $i++) {
            if ($pt[$i].IsByRef) { [void]$mb.DefineParameter($i + 1, [System.Reflection.ParameterAttributes]::Out, $null) }
        }
        $mb.SetCustomAttribute((New-Object System.Reflection.Emit.CustomAttributeBuilder($ctor, [object[]]@($s[0]), $fields, $values)))
    }
    $script:HmNativeApi = $tb.CreateType()
    return $script:HmNativeApi
}

function Get-HmLastWin32Text {
    param([int]$Code)
    try { return ('код ' + $Code + ': ' + (New-Object System.ComponentModel.Win32Exception($Code)).Message) }
    catch { return ('код ' + $Code) }
}

# SID из токена: класс 1 = TokenUser, 25 = TokenIntegrityLevel. '' — не удалось прочитать.
function Get-HmTokenSid {
    param([IntPtr]$Token, [int]$Class)
    $N = Get-HmNativeApi
    $need = [uint32]0
    [void]$N::GetTokenInformation($Token, $Class, [IntPtr]::Zero, [uint32]0, [ref]$need)
    if ($need -eq 0) { return '' }
    $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([int]$need)
    try {
        if (-not $N::GetTokenInformation($Token, $Class, $buf, $need, [ref]$need)) { return '' }
        $psid = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($buf)
        return (New-Object System.Security.Principal.SecurityIdentifier($psid)).Value
    } catch { return '' }
    finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
}

# Токен процесса оболочки Explorer (окно GetShellWindow): TOKEN_QUERY|TOKEN_DUPLICATE, плюс
# его пользователь и уровень целостности. Вызывающий ОБЯЗАН закрыть Handle (если не Zero).
function Open-HmShellToken {
    $o = [pscustomobject]@{ Handle = [IntPtr]::Zero; ProcessId = 0; UserSid = ''; IntegritySid = ''; Reason = '' }
    $N = Get-HmNativeApi
    $hwnd = $N::GetShellWindow()
    if ($hwnd -eq [IntPtr]::Zero) { $o.Reason = 'оболочка Windows (Проводник) сейчас не запущена'; return $o }
    $sp = [uint32]0
    [void]$N::GetWindowThreadProcessId($hwnd, [ref]$sp)
    if ($sp -eq 0) { $o.Reason = 'не удалось определить процесс оболочки Windows'; return $o }
    $o.ProcessId = [int]$sp
    $hProc = $N::OpenProcess([uint32]0x1000, $false, $sp)   # PROCESS_QUERY_LIMITED_INFORMATION
    if ($hProc -eq [IntPtr]::Zero) {
        $e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $o.Reason = 'нет доступа к процессу оболочки (' + (Get-HmLastWin32Text $e) + ')'
        return $o
    }
    try {
        $hTok = [IntPtr]::Zero
        if (-not $N::OpenProcessToken($hProc, [uint32]0x000A, [ref]$hTok)) {   # TOKEN_QUERY | TOKEN_DUPLICATE
            $e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            $o.Reason = 'нет доступа к токену оболочки (' + (Get-HmLastWin32Text $e) + ')'
            return $o
        }
        $o.Handle = $hTok
        $o.UserSid = Get-HmTokenSid -Token $hTok -Class 1
        $o.IntegritySid = Get-HmTokenSid -Token $hTok -Class 25
        if (-not $o.UserSid -or -not $o.IntegritySid) { $o.Reason = 'не удалось прочитать токен оболочки' }
        return $o
    } finally { [void]$N::CloseHandle($hProc) }
}

# Только чтение (диагностика, тесты): ничего не запускает, прав администратора не требует.
function Get-HmShellTokenInfo {
    $o = $null
    try { $o = Open-HmShellToken }
    catch { return [pscustomobject]@{ ProcessId = 0; UserSid = ''; IntegritySid = ''; Reason = $_.Exception.Message } }
    if ($o.Handle -ne [IntPtr]::Zero) { $N = Get-HmNativeApi; [void]$N::CloseHandle($o.Handle) }
    return [pscustomobject]@{ ProcessId = $o.ProcessId; UserSid = $o.UserSid; IntegritySid = $o.IntegritySid; Reason = $o.Reason }
}

# Политика для токена оболочки — ЧИСТАЯ функция: '' = можно запускать, иначе причина отказа.
# Тот же инвариант, что у гейта обёртки задачи: user-writable бинарь — ТОЛЬКО на medium.
# Другой владелец оболочки = установщик запущен от имени другой учётной записи: программы
# лежат в ЕГО профиле, а за компьютером другой человек — ставить «от него» нельзя.
function Test-HmShellTokenAcceptable {
    param([string]$UserSid, [string]$IntegritySid, [string]$ExpectedUserSid)
    if ($IntegritySid -ne 'S-1-16-8192') {
        if ($IntegritySid -eq 'S-1-16-12288' -or $IntegritySid -eq 'S-1-16-16384') {
            return ('оболочка Windows работает с правами администратора (' + $IntegritySid + '), обычного уровня нет: ' +
                'похоже, выключен контроль учётных записей (UAC) или это встроенная учётная запись «Администратор»')
        }
        return ('уровень оболочки Windows — ' + $(if ($IntegritySid) { $IntegritySid } else { 'не определён' }) +
            ', а нужен обычный (S-1-16-8192)')
    }
    if (-not $ExpectedUserSid -or $UserSid -ne $ExpectedUserSid) {
        # Совет «запусти установщик из своей учётной записи» обычному пользователю не выполнить:
        # установщик просит права администратора и после ввода чужого пароля работает от ТОЙ
        # учётки. Поэтому — формулировка из main.js (предупреждение о «другой учётке»): сделать
        # свою учётную запись администратором и запустить установщик заново.
        return 'установщик запущен от другой учётной записи, чем та, под которой вы вошли в Windows: сделайте свою учётную запись ' +
            'администратором (Параметры → Учётные записи → Семья и другие пользователи) и запустите установщик заново'
    }
    return ''
}

# Один запуск процесса с готовым ПЕРВИЧНЫМ токеном (CreateProcessWithTokenW). STARTUPINFOW и
# PROCESS_INFORMATION — вручную, без объявления структур: смещения x64/x86. Возвращает
# { Started; Error; Handle; ProcessId }; дескриптор процесса закрывает ВЫЗЫВАЮЩИЙ.
# Hidden — без окна (CREATE_NO_WINDOW + SW_HIDE): для дожидаемых действий; окно редактора — видимое.
function Start-HmTokenProcess {
    param([IntPtr]$Token, [string]$App, [string]$Line, [string]$Cwd, [bool]$Hidden)
    $r = [pscustomobject]@{ Started = $false; Error = ''; Handle = [IntPtr]::Zero; ProcessId = 0 }
    $Marshal = [System.Runtime.InteropServices.Marshal]
    $N = Get-HmNativeApi
    $si = [IntPtr]::Zero; $pi = [IntPtr]::Zero; $desk = [IntPtr]::Zero
    try {
        $P = [IntPtr]::Size
        if ($P -eq 8) { $siSize = 104; $offFlags = 60; $offShow = 64 } else { $siSize = 68; $offFlags = 44; $offShow = 48 }
        $si = $Marshal::AllocHGlobal($siSize)
        for ($i = 0; $i -lt $siSize; $i++) { $Marshal::WriteByte($si, $i, [byte]0) }
        $Marshal::WriteInt32($si, 0, $siSize)
        $desk = $Marshal::StringToHGlobalUni('winsta0\default')
        $Marshal::WriteIntPtr($si, 2 * $P, $desk)                 # lpDesktop
        $flags = 0x00000400                                       # CREATE_UNICODE_ENVIRONMENT
        if ($Hidden) {
            $Marshal::WriteInt32($si, $offFlags, 1)               # STARTF_USESHOWWINDOW
            $Marshal::WriteInt16($si, $offShow, [int16]0)         # SW_HIDE
            $flags = $flags -bor 0x08000000                       # CREATE_NO_WINDOW
        }
        $piSize = 2 * $P + 8
        $pi = $Marshal::AllocHGlobal($piSize)
        for ($i = 0; $i -lt $piSize; $i++) { $Marshal::WriteByte($pi, $i, [byte]0) }
        $sb = New-Object System.Text.StringBuilder -ArgumentList $Line, ([Math]::Max(1024, $Line.Length + 16))
        # LOGON_WITH_PROFILE (1): ветка HKCU пользователя гарантированно загружена.
        $ok = $N::CreateProcessWithTokenW($Token, [uint32]1, $App, $sb, [uint32]$flags, [IntPtr]::Zero, $Cwd, $si, $pi)
        if (-not $ok) {
            $e = $Marshal::GetLastWin32Error()
            $r.Error = 'запуск с токеном оболочки не удался (' + (Get-HmLastWin32Text $e) + ')'
            return $r
        }
        $r.Handle    = $Marshal::ReadIntPtr($pi, 0)
        $hThread     = $Marshal::ReadIntPtr($pi, $P)
        $r.ProcessId = $Marshal::ReadInt32($pi, 2 * $P)
        if ($hThread -ne [IntPtr]::Zero) { [void]$N::CloseHandle($hThread) }
        $r.Started = $true
        return $r
    } finally {
        if ($si -ne [IntPtr]::Zero) { $Marshal::FreeHGlobal($si) }
        if ($pi -ne [IntPtr]::Zero) { $Marshal::FreeHGlobal($pi) }
        if ($desk -ne [IntPtr]::Zero) { $Marshal::FreeHGlobal($desk) }
    }
}

# Профиль пользователя — от системы (SHGetFolderPath), а не из переменной среды USERPROFILE:
# её значение берётся из HKCU\Volatile Environment, куда пишет любая программа пользователя.
# Отдельной функцией — чтобы тест мог подставить песочницу.
function Get-HmUserProfileDir {
    $p = ''
    try { $p = [Environment]::GetFolderPath('UserProfile') } catch { $p = '' }
    return [string]$p
}

# Проверка рабочей папки запускаемого процесса ДО передачи системе. Возвращает
# { Path; Reason }: Reason пуст — папку можно, Path — её полный нормализованный путь.
# Правила: путь полный (диск, не UNC и не относительный) и без знаков, которых в путях не бывает;
# лежит ВНУТРИ профиля пользователя (или это сам профиль); каждая папка ниже корня профиля —
# настоящий каталог, не junction/symlink (reparse point) и существует. Корень профиля берётся
# как есть: профиль, перенесённый ссылкой на другой диск, — законная настройка. Папка пустого
# значения не требует — тогда запуск идёт из профиля, как раньше.
function Resolve-HmShellWorkingDirectory {
    param([string]$Path, [string]$ProfileDir)
    $r = [pscustomobject]@{ Path = ''; Reason = '' }
    if (-not $Path) { return $r }
    if (-not $ProfileDir) { $r.Reason = 'профиль пользователя не определён'; return $r }
    if ($Path.IndexOfAny([System.IO.Path]::GetInvalidPathChars()) -ge 0 -or $Path.IndexOfAny([char[]]'*?') -ge 0) {
        $r.Reason = 'в пути есть знак, которого в путях не бывает'; return $r
    }
    if ($Path -notmatch '^[A-Za-z]:[\\/]') { $r.Reason = 'нужен полный путь на диске (не относительный и не сетевой)'; return $r }
    $full = ''; $root = ''
    try {
        $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
        $root = [System.IO.Path]::GetFullPath($ProfileDir).TrimEnd('\')
    } catch { $r.Reason = 'путь не разобрать: ' + $_.Exception.Message; return $r }
    if (-not $root) { $r.Reason = 'профиль пользователя не определён'; return $r }
    $cur = $root
    if (-not $full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
        if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
            $r.Reason = 'папка лежит вне профиля пользователя'; return $r
        }
        foreach ($part in $full.Substring($root.Length + 1).Split('\')) {
            if (-not $part) { continue }
            $cur = $cur + '\' + $part
            $attr = $null
            try { $attr = [System.IO.File]::GetAttributes($cur) } catch { $r.Reason = 'папка не найдена: ' + $cur; return $r }
            if (($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                $r.Reason = 'на пути есть ссылка (junction или symlink): ' + $cur; return $r
            }
            if (($attr -band [System.IO.FileAttributes]::Directory) -eq 0) { $r.Reason = 'это не папка: ' + $cur; return $r }
        }
    } elseif (-not [System.IO.Directory]::Exists($root)) { $r.Reason = 'папка не найдена: ' + $root; return $r }
    $r.Path = $full
    return $r
}

# Запуск с токеном оболочки Explorer (CreateProcessWithTokenW). Возвращает
# { Route='shell-token'; Gate; Code; Reason; ProcessId; Logged; LogNote }:
#   Gate 'medium'      — процесс запущен с ПРОВЕРЕННЫМ medium-токеном; Code — его код выхода
#                        (для -NoWait: 0, если за 3 с не упал);
#   Gate 'refused'     — токен оболочки не medium или чужой учётной записи: НЕ запускаем;
#   Gate 'unavailable' — запустить не удалось (нет оболочки, нет службы «Вторичный вход»,
#                        нет прав, строка длиннее предела, рабочая папка не прошла проверку) —
#                        ничего не запущено;
#   Gate 'unknown'     — процесс запущен, но не завершился за TimeoutSec (может ещё идти).
#   Logged             — вывод программы дописан в её журнал (Get-HmShellLaunchPlan: 'logged');
#                        иначе LogNote объясняет, почему вывода нет (журнал недоступен, строка
#                        с журналом длиннее 1024 знаков).
# Что запускать — ЛИБО Exe (+ Arguments), ЛИБО CmdScript: готовый текст команды для cmd.exe
# (окно терминала без файла-лаунчера, New-HmShellScriptLine). WorkingDirectory — рабочая папка
# процесса (по умолчанию профиль); проверяется Resolve-HmShellWorkingDirectory.
# Требует SeImpersonatePrivilege (есть у elevated-администратора) и службу seclogon.
function Invoke-HmAsShellUser {
    param([string]$Exe = '', [string[]]$Arguments = @(), [string]$Label = '',
          [switch]$NoWait, [int]$TimeoutSec = 600, [string]$CmdScript = '', [string]$WorkingDirectory = '')
    $res = [pscustomobject]@{ Route = 'shell-token'; Gate = 'unavailable'; Code = -1; Reason = ''; ProcessId = 0; Logged = $false; LogNote = '' }
    $sysRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $cmdExe  = [System.IO.Path]::Combine($sysRoot, 'System32', 'cmd.exe')
    if ($CmdScript -and $Exe) { $res.Reason = 'передан и файл, и текст команды — какой из них запускать, неясно'; return $res }
    if (-not $CmdScript -and -not $Exe) { $res.Reason = 'не указано, что запускать'; return $res }
    if (-not $Label) { $Label = if ($CmdScript) { 'script' } else { [System.IO.Path]::GetFileNameWithoutExtension($Exe) } }
    $Label = ([string]$Label) -replace '[^A-Za-z0-9._-]', '-'
    $logPath = if ($NoWait -or $CmdScript) { '' } else { Get-HmDeElevLogPath -Label $Label }
    $plan = Get-HmShellLaunchPlan -CmdExe $cmdExe -Exe $Exe -Arguments $Arguments -CmdScript $CmdScript -LogPath $logPath -Label $Label -NoLog:($NoWait -or [bool]$CmdScript)
    if ($plan.Error) { $res.Reason = $plan.Error; return $res }
    if (-not (Test-Path -LiteralPath $plan.App)) { $res.Reason = 'не найден ' + $plan.App; return $res }
    $profDir = Get-HmUserProfileDir
    $cwd = $profDir
    if (-not $cwd -or -not (Test-Path -LiteralPath $cwd)) { $cwd = $sysRoot }

    $Marshal = [System.Runtime.InteropServices.Marshal]
    $N = $null
    try { $N = Get-HmNativeApi } catch { $res.Reason = 'не удалось подготовить системные вызовы: ' + $_.Exception.Message; return $res }
    $sh = $null; $hDup = [IntPtr]::Zero; $hProcess = [IntPtr]::Zero
    try {
        $sh = Open-HmShellToken
        if ($sh.Handle -eq [IntPtr]::Zero) { $res.Reason = $sh.Reason; return $res }
        $me = ''
        try { $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { $me = '' }
        $why = Test-HmShellTokenAcceptable -UserSid $sh.UserSid -IntegritySid $sh.IntegritySid -ExpectedUserSid $me
        if ($why) { $res.Gate = 'refused'; $res.Reason = $why; return $res }
        # Первичный токен: TOKEN_QUERY|ASSIGN_PRIMARY|DUPLICATE|ADJUST_DEFAULT|ADJUST_SESSIONID;
        # SecurityImpersonation (2), TokenPrimary (1).
        if (-not $N::DuplicateTokenEx($sh.Handle, [uint32]0x018B, [IntPtr]::Zero, 2, 1, [ref]$hDup)) {
            $e = $Marshal::GetLastWin32Error()
            $res.Reason = 'не удалось подготовить токен оболочки (' + (Get-HmLastWin32Text $e) + ')'
            return $res
        }
        # Уровень проверяем на ТОМ токене, с которым запускаем, а не только на исходном.
        $dupIl = Get-HmTokenSid -Token $hDup -Class 25
        if ($dupIl -ne 'S-1-16-8192') { $res.Gate = 'refused'; $res.Reason = 'копия токена оболочки не на обычном уровне (' + $dupIl + ')'; return $res }

        # Рабочая папка проверяется ПОСЛЕ токена и непосредственно ПЕРЕД запуском: окно между
        # «проверили» и «используем» — один системный вызов. Не прошла — ничего не запущено.
        if ($WorkingDirectory) {
            $wd = Resolve-HmShellWorkingDirectory -Path $WorkingDirectory -ProfileDir $profDir
            if ($wd.Reason) { $res.Reason = 'рабочая папка не прошла проверку: ' + $wd.Reason; return $res }
            $cwd = $wd.Path
        }

        # Журнал: короткий дождавшийся шаг (каталог, ротация, заголовок). Не открылся на запись —
        # программа запускается напрямую, без журнала: запись вывода — диагностика, не условие.
        if ($plan.Mode -eq 'logged') {
            $prep = Start-HmTokenProcess -Token $hDup -App $plan.App -Line $plan.Prep -Cwd $cwd -Hidden $true
            if (-not $prep.Started) { $res.Reason = $prep.Error; return $res }
            $prepCode = [uint32]1
            try {
                if ($N::WaitForSingleObject($prep.Handle, [uint32]20000) -eq 0) { [void]$N::GetExitCodeProcess($prep.Handle, [ref]$prepCode) }
            } finally { [void]$N::CloseHandle($prep.Handle) }
            if ($prepCode -ne 0) {
                $plan.Mode = 'direct'; $plan.App = $plan.DirectApp; $plan.Main = $plan.DirectLine
                $plan.Note = 'журнал недоступен (каталог не создался или файл занят)'
            }
        }
        $res.Logged  = ($plan.Mode -eq 'logged')
        $res.LogNote = [string]$plan.Note

        $main = Start-HmTokenProcess -Token $hDup -App $plan.App -Line $plan.Main -Cwd $cwd -Hidden (-not $NoWait)
        if (-not $main.Started) { $res.Reason = $main.Error; return $res }
        $hProcess = $main.Handle
        $res.ProcessId = $main.ProcessId
        $exit = [uint32]0
        if ($NoWait) {
            # Окно приложения живёт дальше: ждём пару секунд — поймать лишь мгновенный отказ.
            if ($N::WaitForSingleObject($hProcess, [uint32]3000) -eq 0) {
                [void]$N::GetExitCodeProcess($hProcess, [ref]$exit)
                $res.Code = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$exit), 0)
            } else { $res.Code = 0 }
            $res.Gate = 'medium'
            return $res
        }
        $start = Get-Date; $deadline = $start.AddSeconds($TimeoutSec); $next = $start.AddSeconds(60); $done = $false
        while ((Get-Date) -lt $deadline) {
            $w = $N::WaitForSingleObject($hProcess, [uint32]1000)
            if ($w -eq 0) { $done = $true; break }
            if ($w -ne 0x102) { break }                           # не WAIT_TIMEOUT = WAIT_FAILED
            if ((Get-Date) -ge $next) {
                Write-Host "  …выполняется (запасной путь), прошло $([int]((Get-Date) - $start).TotalMinutes) мин (лимит $([int]($TimeoutSec / 60)) мин)"
                $next = (Get-Date).AddSeconds(60)
            }
        }
        if (-not $done) {
            $res.Gate = 'unknown'
            $res.Reason = 'процесс не завершился за ' + $TimeoutSec + ' с — второй запуск поверх не делаю'
            return $res
        }
        [void]$N::GetExitCodeProcess($hProcess, [ref]$exit)
        $res.Code = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$exit), 0)
        $res.Gate = 'medium'
        return $res
    } catch {
        # Процесс уже создан — значит он, возможно, ещё идёт: это 'unknown', а не «не запускали».
        if ($res.ProcessId -gt 0) { $res.Gate = 'unknown' }
        $res.Reason = 'сбой запасного пути: ' + $_.Exception.Message
        return $res
    } finally {
        if ($hProcess -ne [IntPtr]::Zero) { [void]$N::CloseHandle($hProcess) }
        if ($hDup -ne [IntPtr]::Zero) { [void]$N::CloseHandle($hDup) }
        if ($sh -and $sh.Handle -ne [IntPtr]::Zero) { [void]$N::CloseHandle($sh.Handle) }
    }
}

# Итог двух путей — ЧИСТАЯ функция. Gate 'medium' = действие ОТРАБОТАЛО на medium (Code — код
# программы) задачей или запасным путём. Finished = доказано, что ничего из запущенного уже
# не идёт: только тогда вызывающему можно повторять (Test-HmDeElevRetryAllowed).
function Merge-HmDeElevResult {
    param([AllowNull()][object]$Task, [string]$Stage = '', [AllowNull()][object]$Shell, [string]$LogPath = '')
    $r = [pscustomobject]@{ Gate = 'unavailable'; Code = -1; Route = 'none'; Finished = $true
                            TaskGate = ''; TaskHex = ''; TaskCode = -1; TaskStage = $Stage
                            ShellGate = ''; ShellReason = ''; ShellLogged = $false; ShellLogNote = ''; LogPath = $LogPath }
    if ($null -ne $Task) { $r.TaskGate = [string]$Task.Gate; $r.TaskHex = [string]$Task.Hex; $r.TaskCode = $Task.Code }
    if ($null -ne $Task -and $Task.Gate -eq 'medium') { $r.Gate = 'medium'; $r.Code = $Task.Code; $r.Route = 'task'; return $r }
    if (($null -ne $Task -and @('unknown', 'terminated') -contains [string]$Task.Gate) -or
        ($null -eq $Task -and -not (@('prereq', 'staging', 'create', 'run') -contains $Stage))) {
        $r.Gate = if ($null -ne $Task) { [string]$Task.Gate } else { 'unknown' }
        $r.Route = 'task'; $r.Finished = $false
        return $r
    }
    if ($null -ne $Shell) {
        $r.ShellGate = [string]$Shell.Gate; $r.ShellReason = [string]$Shell.Reason
        $r.ShellLogged = [bool]$Shell.Logged; $r.ShellLogNote = [string]$Shell.LogNote
        if ($Shell.Gate -eq 'medium') { $r.Gate = 'medium'; $r.Code = $Shell.Code; $r.Route = 'shell-token'; return $r }
        if ($Shell.Gate -eq 'unknown') { $r.Gate = 'unknown'; $r.Route = 'shell-token'; $r.Finished = $false; return $r }
        $r.Gate = if ($null -ne $Task -and $Task.Gate -eq 'refused') { 'refused' } else { [string]$Shell.Gate }
        return $r
    }
    if ($null -ne $Task) { $r.Gate = [string]$Task.Gate }
    return $r
}

# Одна строка в журнал установки на каждое де-элевированное действие — ЧИСТАЯ функция.
# Gate, «Last Result» в hex, какой путь сработал и где вывод программы. Это диагностика:
# итог шага решает проверка по диску/реестру у вызывающего.
function Format-HmDeElevSummary {
    param([string]$Label, [object]$Result)
    $stageText = @{ prereq = 'нет системных программ'; staging = 'не создан защищённый каталог'
                    create = 'задача не создалась'; run = 'задача не запустилась'; running = 'сбой после запуска' }
    $s = '[де-элевация] ' + $Label + ': задача планировщика — '
    if ($Result.TaskGate) {
        $s += 'Gate=' + $Result.TaskGate
        if ($Result.TaskHex) { $s += ', Last Result=' + $Result.TaskHex }
        switch ($Result.TaskGate) {
            'medium'      { $s += ', код ' + $Result.TaskCode }
            'not-started' { $s += ' (действие задачи не запустилось)' }
            'refused'     { $s += ' (обёртка увидела не обычный уровень — программу не запускала)' }
            'terminated'  { $s += ' (прервана по лимиту времени)' }
            'unknown'     { $s += ' (итога нет — возможно, ещё идёт)' }
        }
    } else {
        $st = [string]$Result.TaskStage
        $s += 'не отработала (' + $(if ($stageText.ContainsKey($st)) { $stageText[$st] } else { 'этап ' + $st }) + ')'
    }
    if ($Result.ShellGate) {
        $s += '; запасной путь (токен оболочки Explorer) — Gate=' + $Result.ShellGate
        if ($Result.ShellGate -eq 'medium') { $s += ', код ' + $Result.Code }
        if ($Result.ShellReason) { $s += ': ' + $Result.ShellReason }
    } elseif (-not $Result.Finished) {
        $s += '; запасной путь не запускаю: первый запуск, возможно, ещё идёт'
    }
    # Где вывод программы. Запасной путь мог запустить её БЕЗ записи (журнал недоступен или строка
    # с журналом длиннее предела CreateProcessWithTokenW): тогда файла нет, и называть его нельзя.
    if (@('medium', 'unknown') -contains [string]$Result.ShellGate -and -not $Result.ShellLogged) {
        $s += '; вывод программы не записан' + $(if ($Result.ShellLogNote) { ': ' + $Result.ShellLogNote } else { '' })
    } elseif ($Result.LogPath) {
        $s += '; вывод программы: ' + $Result.LogPath
    }
    return $s
}

# Де-элевированный запуск С ЗАПАСНЫМ ПУТЁМ: сначала задача планировщика; если доказано, что
# она ничего не запустила (Test-HmShellFallbackAllowed) — то же действие с токеном оболочки.
# Печатает строку диагностики и возвращает Merge-HmDeElevResult. Никогда не $null.
function Invoke-HmDeElevatedSafe {
    param([Parameter(Mandatory = $true)][string]$Exe, [string[]]$Arguments = @(), [string]$Label = '', [int]$TimeoutSec = 600)
    if (-not $Label) { $Label = [System.IO.Path]::GetFileNameWithoutExtension($Exe) }
    $Label = ([string]$Label) -replace '[^A-Za-z0-9._-]', '-'
    $script:HmDeElevStage = 'prereq'
    $task = $null
    try { $task = Invoke-HmDeElevated -Exe $Exe -Arguments $Arguments -Label $Label } catch { $task = $null }
    $stage = [string]$script:HmDeElevStage
    $shell = $null
    if (Test-HmShellFallbackAllowed -TaskResult $task -Stage $stage) {
        $shell = Invoke-HmAsShellUser -Exe $Exe -Arguments $Arguments -Label $Label -TimeoutSec $TimeoutSec
    }
    $res = Merge-HmDeElevResult -Task $task -Stage $stage -Shell $shell -LogPath (Get-HmDeElevLogPath -Label $Label)
    Write-Host ('  ' + (Format-HmDeElevSummary -Label $Label -Result $res))
    return $res
}

# --- АВТО-УБОРКА при КАЖДОЙ загрузке примитива (дот-сорс из vscode.ps1/extension.ps1). ---
# Сироты появляются, когда установщик убили посреди установки — finally выше не исполнился.
# Подметаем их здесь, на СЛЕДУЮЩЕМ запуске: живые задачи параллельных экземпляров защищены
# состоянием/возрастом внутри Test-HmTaskIsOrphan. Best-effort: любой сбой не мешает
# установке. ВАЖНО: вызов стоит ПОСЛЕДНИМ в файле — все функции уже объявлены (в этом
# файле уже был баг «функция вызвана до объявления», порядок здесь не случаен).
# Вызывающий, которому уборка ни к чему (mascot.ps1 берёт из файла один запуск токеном оболочки и с
# задачами не работает), ставит $script:HmSkipOrphanSweep = $true ДО подключения файла: COM планировщика
# тогда не открывается вовсе. Флага нет — уборка идёт, как и шла.
if (-not $script:HmSkipOrphanSweep) {
    try {
        $hmOrphanTags = @(Remove-HmOrphanTasks)
        if ($hmOrphanTags.Count -gt 0) {
            Write-Host ("Планировщик: убраны осиротевшие задачи прерванных установок (" +
                $hmOrphanTags.Count + "): " + ($hmOrphanTags -join ', '))
        }
    } catch { }
}
