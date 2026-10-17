# _mascot.ps1 — общие функции скрепки (Windows). Подключается ТОЧКОЙ из mascot.ps1
# (установка) и touchup-mascot.ps1 (подправка при каждом запуске установщика).
# Библиотека: при подключении ничего не запускает и не пишет, своего кода возврата нет.
#
# ЗАЧЕМ ОТДЕЛЬНО. Правило «чья это запись автозапуска» обязано жить в одном месте:
# два экземпляра разойдутся молча — один начнёт снимать чужое, другой перестанет
# снимать своё. А сам mascot.ps1 при повторном запуске установщика не выполняется
# вовсе: уже установленный компонент в окне выбора снят по умолчанию. Поэтому уборка
# автозапуска прошлых версий вынесена так, чтобы её мог позвать скрипт, который идёт
# каждый раз (touchup-mascot.ps1).

# --- автозапуск прошлых версий ----------------------------------------------------
# Решение владельца 06.10.2026 (строка A26 разбора диалогов поддержки): скрепка больше
# не стартует с Windows. Прошлые версии установщика прописывали
# HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ClaudeMascot всегда.

# Наша ли запись: значение — путь РОВНО к нашему exe. Кавычки и пробелы по краям не в
# счёт, регистр тоже (пути в Windows регистронезависимы). Аргументы, другой каталог,
# другое имя — не наше. Чистая функция.
function Test-HmMascotRunValueOurs([string]$Value, [string]$ExePath) {
    if ([string]::IsNullOrWhiteSpace($Value) -or [string]::IsNullOrWhiteSpace($ExePath)) { return $false }
    $v = $Value.Trim().Trim('"').Trim()
    return [string]::Equals($v, $ExePath.Trim(), [StringComparison]::OrdinalIgnoreCase)
}

# Снять запись ClaudeMascot из ключа Run, если она наша. Исход: absent | removed |
# foreign | failed. Итог проверяем по реестру, а не по отсутствию ошибки. С -Quiet
# ничего не пишет: вызывающий сам решает, что сказать человеку (touchup говорит одну
# строку и только когда что-то изменилось).
function Remove-HmMascotOldAutorun([string]$RunKey, [string]$ExePath, [switch]$Quiet) {
    $old = (Get-ItemProperty -Path $RunKey -Name 'ClaudeMascot' -ErrorAction SilentlyContinue).ClaudeMascot
    if ($null -eq $old) { return 'absent' }
    if (-not (Test-HmMascotRunValueOurs $old $ExePath)) {
        if (-not $Quiet) { Write-Host "  В автозапуске есть запись ClaudeMascot, но она ведёт не на нашу скрепку ($old) — не трогаю." }
        return 'foreign'
    }
    Remove-ItemProperty -Path $RunKey -Name 'ClaudeMascot' -ErrorAction SilentlyContinue
    if ($null -ne (Get-ItemProperty -Path $RunKey -Name 'ClaudeMascot' -ErrorAction SilentlyContinue).ClaudeMascot) {
        if (-not $Quiet) { Write-Host "  ВНИМАНИЕ: старый автозапуск скрепки снять не удалось — выключи его вручную: Диспетчер задач → вкладка «Автозагрузка»." }
        return 'failed'
    }
    if (-not $Quiet) { Write-Host "  Автозапуск скрепки от прошлой установки снят: при входе в Windows она больше не стартует." }
    return 'removed'
}

# --- ярлык в меню «Пуск» ----------------------------------------------------------
# Установщик пишет его из-под администратора в каталог, который может менять любая
# программа этого пользователя. Отсюда четыре правила:
#   1. Папку берём из ПРОФИЛЯ, а не из реестра. Оболочка узнаёт «Programs» из
#      HKCU\...\User Shell Folders — ключа, куда пишет любая программа пользователя;
#      пока на него смотрели без сверки, ярлык мог уехать в любой каталог, куда
#      администратор может писать. Если ответ оболочки не совпал с путём от профиля —
#      ярлыка нет, причина в журнале.
#   2. Ни каталог, ни один его предок не junction/symlink.
#   3. Ярлык сохраняется НЕ в этой папке, а под случайным именем во временной, и
#      переносится одним Move. Save() поверх подложенной жёсткой ссылки пишет сквозь
#      неё в чужой файл (проверено на PS 5.1), а Move не перезаписывает занятое имя.
#   4. Проверки повторяются непосредственно перед каждым Move: окно между «проверили»
#      и «записали» сжато до одного системного вызова.

# Каталог ярлыков этого пользователя: путь от профиля, подтверждённый ответом оболочки.
# Параметры — для проверки на подставных значениях; в работе берутся из системы.
function Get-HmMascotProgramsDir(
    [string]$ProfileDir = [Environment]::GetFolderPath('UserProfile'),
    [string]$ShellDir = [Environment]::GetFolderPath('Programs')) {
    if ([string]::IsNullOrWhiteSpace($ProfileDir) -or -not [IO.Path]::IsPathRooted($ProfileDir)) { throw 'не найден профиль пользователя' }
    if ([string]::IsNullOrWhiteSpace($ShellDir) -or -not [IO.Path]::IsPathRooted($ShellDir)) { throw 'оболочка не назвала папку меню «Пуск»' }
    $want = [IO.Path]::GetFullPath((Join-Path $ProfileDir 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs')).TrimEnd('\')
    $have = [IO.Path]::GetFullPath($ShellDir).TrimEnd('\')
    if (-not [string]::Equals($have, $want, [StringComparison]::OrdinalIgnoreCase)) {
        throw "папка меню «Пуск» перенаправлена ($have вместо $want) — ярлык не создаю"
    }
    return $want
}

# Каталог и все его существующие предки — без junction/symlink. Несуществующее звено
# не ошибка: дальше всё равно упадёт запись, а не уйдёт в чужое место.
function Assert-HmMascotDirChain([string]$Dir) {
    for ($cur = $Dir; $cur; $cur = [IO.Path]::GetDirectoryName($cur)) {
        $attr = $null
        try { $attr = [IO.File]::GetAttributes($cur) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { }
        if ($null -ne $attr -and ([int]$attr -band [int][IO.FileAttributes]::ReparsePoint)) { throw "в пути к меню «Пуск» есть junction/symlink: $cur" }
    }
}

# Отдельной функцией, чтобы временную блокировку (антивирус держит свежий файл) можно
# было воспроизвести в проверке подменой этой функции.
function Move-HmMascotFile([string]$From, [string]$To) {
    [IO.File]::Move($From, $To)
}

# $Recheck — блок вызывающего, который повторяет его собственную проверку (например,
# «оболочка всё ещё называет ту же папку»); он выполняется перед каждым Move.
function New-HmMascotShortcut([string]$Dir, [string]$Target, [scriptblock]$Recheck) {
    if (-not $Dir -or -not [IO.Path]::IsPathRooted($Dir)) { throw 'не найдена папка меню «Пуск»' }
    Assert-HmMascotDirChain $Dir
    $lnk = Join-Path $Dir 'Claude Mascot.lnk'
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('hm-mascot-' + [guid]::NewGuid().ToString('N') + '.lnk')
    try {
        $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($tmp)
        $sc.TargetPath = $Target
        $sc.WorkingDirectory = Split-Path -Parent $Target
        $sc.IconLocation = "$Target,0"
        $sc.Description = 'Скрепка Claude — помощник поверх окон'
        $sc.Save()
        # Три попытки: Defender или индексатор Search держат свежий файл, и один сбой
        # Move означал бы, что единственного входа в скрепку нет. Ошибки не про
        # ввод-вывод (junction, папка на месте ярлыка) повторять нельзя — они выходят сразу.
        $moved = $false
        $err = $null
        for ($i = 1; $i -le 3 -and -not $moved; $i++) {
            try {
                if ($Recheck) { & $Recheck }
                Assert-HmMascotDirChain $Dir
                $prev = $null
                try { $prev = [IO.File]::GetAttributes($lnk) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { }
                if ($null -ne $prev) {
                    if ([int]$prev -band [int]([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) { throw "на месте ярлыка лежит папка или ссылка: $lnk" }
                    [IO.File]::Delete($lnk)   # снимаем только ИМЯ: у жёсткой ссылки её цель остаётся цела
                }
                Move-HmMascotFile $tmp $lnk   # имя успели занять снова — исключение: сквозь чужое не пишем
                $moved = $true
            } catch [IO.IOException], [UnauthorizedAccessException] {
                $err = $_.Exception
                if ($i -lt 3) { Start-Sleep -Milliseconds (200 * $i) }
            }
        }
        if (-not $moved) { throw ("ярлык не удалось положить на место за 3 попытки: " + $err.Message) }
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
    if (-not (Test-Path -LiteralPath $lnk -PathType Leaf)) { throw "ярлык не появился: $lnk" }
    return $lnk
}
