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
#     Тот же принцип уже применён в claude-desktop.ps1/chatgpt-desktop.ps1 (там ещё и точное O=);
#     здесь пин издателя ОПЦИОНАЛЕН (-ExpectedOrg/-ExpectedSubjectMatch), т.к. точные RDN
#     сторонних издателей (Git for Windows/Node/Cursor) не подтверждены на реальных артефактах,
#     а слепой пин ломал бы легитимную установку. Обязательная (непереборчивая) половина —
#     цепочка к МАШИННОМУ корню — закрывает описанный privesc сама по себе.
function Test-HmTrustedSigner {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ExpectedOrg = '',
        [string]$ExpectedSubjectMatch = ''
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
    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck  # отзыв уже проверен WinVerifyTrust при Status=Valid
    $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
    [void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))  # EKU Code Signing
    $built = $false
    try { $built = $chain.Build($cert) } catch { return "не удалось построить цепочку: $($_.Exception.Message)" }
    if (-not $built) {
        $st = ($chain.ChainStatus | ForEach-Object { $_.Status }) -join ','
        return "цепочка сертификатов не выстроилась ($st)"
    }
    $elems = $chain.ChainElements
    if (-not $elems -or $elems.Count -lt 1) { return 'пустая цепочка сертификатов' }
    $root = $elems[$elems.Count - 1].Certificate
    if (-not $root -or -not $root.Thumbprint) { return 'не удалось определить корень цепочки' }
    $inMachine = $false
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store([System.Security.Cryptography.X509Certificates.StoreName]::Root, [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        foreach ($c in $store.Certificates) { if ($c.Thumbprint -eq $root.Thumbprint) { $inMachine = $true; break } }
    } catch { return "не удалось открыть машинный стор корней: $($_.Exception.Message)" }
    finally { try { $store.Close() } catch { } }
    if (-not $inMachine) { return "корень цепочки НЕ в LocalMachine\Root (возможно отравление CurrentUser\Root): $($root.Subject)" }
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
        if ($org -ne $ExpectedOrg) { return "Organization подписи ('$org') != ожидаемого ('$ExpectedOrg')" }
    }
    # (e) Опциональный (более мягкий) пин по Subject — для издателей, у кого RDN не подтверждён.
    if ($ExpectedSubjectMatch -and ("$($cert.Subject)" -notmatch $ExpectedSubjectMatch)) {
        return "Subject подписи не совпал с ожидаемым издателем ($($cert.Subject))"
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

function Invoke-HmDeElevated {
    param([Parameter(Mandatory = $true)][string]$Exe, [string[]]$Arguments = @())

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

    # --- Литералы (single-quoted, '->'' экранирование) для ВБИВАНИЯ в тело обёртки ---
    $s32Lit = ($s32   -replace "'", "''")
    $srLit  = ($sysRoot -replace "'", "''")
    $whoLit = ($whoami -replace "'", "''")
    $exeLit = ($Exe    -replace "'", "''")
    $argLit = ''
    if ($Arguments.Count -gt 0) {
        $argLit = ' ' + (($Arguments | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ' ')
    }

    # Тело обёртки. СТРОГО ПЕРВЫМИ — присваивания чистых env ЛИТЕРАЛАМИ (ни одного cmdlet до
    # них). Затем integrity-self-check через АБСОЛЮТНЫЙ System32\whoami. Бинарь — ТОЛЬКО при
    # medium; иначе exit 210. Exit-код обёртки станет «Last Result» задачи (доверенный сигнал).
    $body =
        "`$env:PSModulePath='$s32Lit\WindowsPowerShell\v1.0\Modules'`n" +
        "`$env:Path='$s32Lit;$srLit;$s32Lit\WindowsPowerShell\v1.0'`n" +
        "if(@(& '$whoLit' /groups 2>`$null) -match 'S-1-16-8192'){`n" +
        "& '$exeLit'$argLit`n" +
        "`$c=`$LASTEXITCODE; if(`$null -eq `$c){`$c=0}; exit `$c`n" +
        "} else { exit 210 }`n"
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($body))
    $wrapArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $b64

    $result  = $null
    $dir     = $null
    $xmlFile = $null
    try {
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
        Set-Content -LiteralPath $xmlFile -Value $taskXml -Encoding Unicode

        # Создать задачу через АБСОЛЮТНЫЙ schtasks.exe по XML. Провал -> fail-closed.
        & $schtasks '/Create' '/TN' $tag '/XML' $xmlFile '/F' 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { return $null }
        # XML больше не нужен (определение задачи — в БД планировщика). Удаляем сразу.
        Remove-Item -LiteralPath $xmlFile -Force -ErrorAction SilentlyContinue; $xmlFile = $null

        & $schtasks '/Run' '/TN' $tag 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { return $null }

        # Ждём завершения по ЛОКАЛЬ-НЕЗАВИСИМОМУ «Last Result» (поле #6 CSV /HRESULT):
        # 267009=выполняется, 267011=ещё не запускалась, иначе=exit-код обёртки.
        $lastResult = $null
        # Дедлайн согласован с <ExecutionTimeLimit>PT10M</ExecutionTimeLimit> задачи (+30 с запаса):
        # при 180 с долгая (но нормальная) установка vsix на слабой машине с активным Defender
        # объявлялась провалом, вызывающий стартовал ВТОРУЮ конкурентную задачу поверх первой.
        # Реального зависания это не удлиняет: планировщик сам прибьёт задачу на 10-й минуте
        # (AllowHardTerminate=true), Last Result станет ненулевым и цикл выйдет раньше дедлайна.
        $deadline = (Get-Date).AddSeconds(630)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 400
            $csv = & $schtasks '/Query' '/TN' $tag '/HRESULT' '/FO' 'CSV' '/NH' '/V' 2>$null | Out-String
            $line = ($csv -split "`r?`n" | Where-Object { $_ -match '"' } | Select-Object -First 1)
            if (-not $line) { continue }
            $m = [regex]::Matches($line, '"([^"]*)"')   # base64 без кавычек -> поля разбираются надёжно
            if ($m.Count -gt 6) {
                $lr = $m[6].Groups[1].Value
                if ($lr -ne '267009' -and $lr -ne '267011') { $lastResult = $lr; break }
            }
        }

        if ($null -eq $lastResult) { $gate = 'unknown'; $code = -1 }
        elseif ($lastResult -eq '210') { $gate = 'refused'; $code = -1 }   # обёртка увидела НЕ medium
        else { $gate = 'medium'; $code = 0; [void][int]::TryParse($lastResult, [ref]$code) }
        $result = [pscustomobject]@{ Gate = $gate; Code = $code }
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

# --- АВТО-УБОРКА при КАЖДОЙ загрузке примитива (дот-сорс из vscode.ps1/extension.ps1). ---
# Сироты появляются, когда установщик убили посреди установки — finally выше не исполнился.
# Подметаем их здесь, на СЛЕДУЮЩЕМ запуске: живые задачи параллельных экземпляров защищены
# состоянием/возрастом внутри Test-HmTaskIsOrphan. Best-effort: любой сбой не мешает
# установке. ВАЖНО: вызов стоит ПОСЛЕДНИМ в файле — все функции уже объявлены (в этом
# файле уже был баг «функция вызвана до объявления», порядок здесь не случаен).
try {
    $hmOrphanTags = @(Remove-HmOrphanTasks)
    if ($hmOrphanTags.Count -gt 0) {
        Write-Host ("Планировщик: убраны осиротевшие задачи прерванных установок (" +
            $hmOrphanTags.Count + "): " + ($hmOrphanTags -join ', '))
    }
} catch { }
