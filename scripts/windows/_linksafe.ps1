# _linksafe.ps1 — снос и раскладка в ПОЛЬЗОВАТЕЛЬСКИЕ папки из-под администратора так, чтобы не пойти за ссылкой
# (junction/symlink) и не проиграть гонку «проверили — сделали».
# Дот-сорсится компонентными скриптами (course.ps1, config.ps1, nomad.ps1, bridge.ps1, extension.ps1, uv.ps1).
# Библиотека: кода верхнего уровня и своего exit нет. Лежит рядом с _userpath.ps1 и подключает его сама: помощники
# оттуда (Write-HmFileSafe, Get-HmReparseTag, Open-HmDirHandle, Get-HmHandlePath) — её основа.
#
# ЗАЧЕМ. Скрипты идут под администратором, а папки, в которых они убирают и раскладывают файлы (курс, ~/.claude,
# клон пака, %LOCALAPPDATA%\HamidunBridge…), лежат в профиле, где любой процесс того же пользователя вправе создать
# junction (mklink /J, права не нужны). Две беды, обе проверены запуском на Windows PowerShell 5.1:
#   • junction на РОДИТЕЛЬСКОМ звене пути (скажем, vibecoding-course\.claude → чужая папка): Remove-Item -Recurse
#     по пути <курс>\.claude\skills удалил <чужая папка>\skills, а Expand-Archive -Force потом разложил файлы курса
#     в ту же чужую папку. Ссылку-ЭЛЕМЕНТ Remove-Item не обходит, а ссылку в середине пути проходит как обычный каталог;
#   • «проверили, что ссылок нет, — и пошли»: между проверкой и действием процесс обычного пользователя за 20–30 мс
#     переименовывает проверенную папку и ставит на её имя ссылку (воспроизведено на robocopy, см. Lock-HmDir в config.ps1).
#
# Что здесь, от простого к сложному:
#   Find-HmLinkOnPath     — первое звено-ссылка на пути от доверенной опоры вниз (облачные папки OneDrive — не ссылки);
#   Get-HmTrustAnchor     — опора пути: профиль из токена, если путь внутри него, иначе корень тома;
#   New-HmPinAt           — «закрепка»: пустой файл внутри каталога, открытый без разделения (CreateNew + DeleteOnClose).
#                           Пока он открыт, каталог и все его родители нельзя ни переименовать, ни заменить ссылкой, а
#                           пустой каталог нельзя превратить в junction «на месте» (он не пуст). Сразу после создания
#                           настоящий путь каталога по дескриптору сверяется с ожидаемым: ссылка где угодно на пути
#                           даст другой путь, и закрепка отказывает (файл при этом исчезает сам, закрытием);
#   Open-HmPinnedDir      — каталог внутри опоры: недостающие звенья создаются по одному под закрепкой родителя, итог закреплён;
#   Remove-HmTreeNoFollow — снос дерева, который не идёт по ссылкам НИКОГДА: родитель и каждый каталог закрепляются перед
#                           обходом, ссылка (junction, symlink) снимается как ссылка, содержимое её цели не читается и не трогается;
#   Expand-HmZipSafe      — распаковка архива в проверенные и закреплённые папки; каждый файл ложится через Write-HmFileSafe
#                           (временный файл рядом + перенос по имени), а не открытием самого имени на запись.
#
# Чего это НЕ закрывает (честно). Сравнение идёт по ПУТЯМ, а у .NET Framework нет открытия «относительно дескриптора»
# (openat). Закрепка держит КАТАЛОГ, но не мешает процессу пользователя создать новую запись внутри него; поэтому
# каждая операция над самой записью — снятие, перенос — ссылку не пройдёт (Delete снимает именно ссылку, Move не
# перезаписывает чужое), а перечисление и запись идут только в закреплённом каталоге. Пустой каталог, у которого
# закрепка ещё не создана, можно превратить в ссылку «на месте» в миг между сверкой и созданием закрепки — закрепка
# тогда ляжет по ссылке, сверка пути это увидит и откажет, но пустой файл успеет на мгновенье появиться в чужой папке
# (он исчезает при закрытии). Сетевые диски (UNC) не поддерживаются: настоящий путь по дескриптору для них не
# читается, и закрепка отказывает.
#
# Сборка System.IO.Compression (ZipArchive) берётся из GAC по имени оператором `using assembly`: ни компиляции, ни файла
# в %TEMP%, ни пути к dll. Он стоит первым оператором файла — иначе PowerShell его не принимает.
using assembly System.IO.Compression
. (Join-Path $PSScriptRoot '_userpath.ps1')   # Write-HmFileSafe, Get-HmReparseTag, Test-HmCloudReparseTag, Open-HmDirHandle, Get-HmHandlePath, Close-HmDirHandle, Get-HmProfileRoot

# Звено пути — ссылка? Точка повторной обработки, кроме облачных заглушек OneDrive (они остаются на месте: это папка
# «Переноса известных папок», а не перенаправление). Тег не прочитался — считаем ссылкой (отказывать безопаснее).
function Test-HmPathIsLink {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][System.IO.FileAttributes]$Attr)
    if (-not ([int]$Attr -band [int][System.IO.FileAttributes]::ReparsePoint)) { return $false }
    return (-not (Test-HmCloudReparseTag (Get-HmReparseTag $Path)))
}

# Путь без хвостового «\», кроме корня диска («D:\» остаётся: «D:» без слэша — это ТЕКУЩАЯ папка диска D).
function ConvertTo-HmFullDirPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\') }
    return $full
}

# Доверенная опора для пути: профиль пользователя из токена (Get-HmProfileRoot), если путь лежит строго внутри него,
# иначе корень тома пути. Профиль и корень тома процесс обычного пользователя заменить не может; всё ниже — его.
function Get-HmTrustAnchor {
    param([Parameter(Mandatory = $true)][string]$Path)
    $full = ConvertTo-HmFullDirPath $Path
    $prof = ''
    try { $prof = [string](Get-HmProfileRoot) } catch { $prof = '' }
    if ($prof -match '^[A-Za-z]:[\\/]') {
        $p = ConvertTo-HmFullDirPath $prof
        if ($p -match '^[A-Za-z]:\\[^\\]' -and $full.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $p }
    }
    return [System.IO.Path]::GetPathRoot($full)
}

# Первое звено пути от $Anchor вниз, которое является ссылкой, либо $null, если ссылок на цепочке нет. Сама опора не
# проверяется. Несуществующее звено — не ссылка (создавать будем сами, а проверка повторится перед записью). Путь не
# внутри опоры — возвращается сам путь (безопаснее отказать, чем поверить). Звено с именем, оканчивающимся точкой или
# пробельным знаком, тоже возвращается: Windows отбрасывает их при проверке, но не в середине пути при записи, и
# «Desktop » оказывается для проверки одной папкой, а для записи другой (junction с таким именем создаётся без прав).
# Атрибуты звена не прочитались — исключение: вызывающий отказывает.
function Find-HmLinkOnPath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Anchor)
    $full = ConvertTo-HmFullDirPath $Path
    $base = ConvertTo-HmFullDirPath $Anchor
    $baseT = $base.TrimEnd('\')
    if ([string]::Equals($full.TrimEnd('\'), $baseT, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    if (-not $full.StartsWith($baseT + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $full }
    $cur = $baseT
    foreach ($part in $full.Substring($baseT.Length + 1).Split('\')) {
        if (-not $part) { continue }
        $cur = $cur + '\' + $part
        $last = $part[$part.Length - 1]
        if ($last -eq [char]'.' -or [char]::IsWhiteSpace($last)) { return $cur }
        $attr = $null
        try { $attr = [System.IO.File]::GetAttributes($cur) }
        catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return $null }
        if (Test-HmPathIsLink -Path $cur -Attr $attr) { return $cur }
    }
    return $null
}

# Настоящий путь каталога по дескриптору (все ссылки раскрыты); '' — не открылся или путь сетевой.
function Get-HmRealDirPath {
    param([Parameter(Mandatory = $true)][string]$Dir)
    $h = [IntPtr]::Zero
    try {
        $h = Open-HmDirHandle $Dir $false
        return [string](Get-HmHandlePath $h)
    } catch { return '' }
    finally { Close-HmDirHandle $h }
}

# Каким должен быть НАСТОЯЩИЙ путь каталога $Dir, лежащего внутри опоры $Anchor: настоящий путь самой опоры (профиль
# сам может быть ссылкой на другой диск — это решение администратора, ему верим) + остаток пути как написан.
function Get-HmExpectedRealPath {
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][string]$Anchor)
    $full = ConvertTo-HmFullDirPath $Dir
    $base = ConvertTo-HmFullDirPath $Anchor
    $baseT = $base.TrimEnd('\')
    $isBase = [string]::Equals($full.TrimEnd('\'), $baseT, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $isBase -and -not $full.StartsWith($baseT + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw (New-Object System.InvalidOperationException("папка лежит не внутри доверенной опоры: $full (опора $base)"))
    }
    $realBase = Get-HmRealDirPath -Dir $base
    if (-not $realBase) { throw (New-Object System.InvalidOperationException("не удалось прочитать настоящий путь опоры (сетевой диск или нет доступа): $base")) }
    $realBase = $realBase.TrimEnd('\')
    if ($isBase) { return $realBase }
    return $realBase + '\' + $full.Substring($baseT.Length + 1)
}

# Закрепка каталога. Возвращает { Stream; Dir; Real; Name }: Stream закрывает (Dispose) вызывающий — файл-закрепка
# исчезает сам. Каталога нет, не открылся или закрепку не создать — IOException (повторять можно); настоящий путь не
# совпал с ожидаемым (на пути ссылка, папку подменили) — InvalidOperationException (повторять нечего).
#   1. каталог открывается БЕЗ права на удаление и переименование, и его настоящий путь сверяется с ожидаемым — до
#      любой записи: если там ссылка, не пишем ничего;
#   2. внутри создаётся пустой файл со случайным именем (CreateNew, без разделения, DeleteOnClose);
#   3. настоящий путь ЭТОГО файла сверяется с «ожидаемый путь каталога + имя»: если пустой каталог успели превратить в
#      ссылку на месте между шагами 1 и 2, файл ляжет в чужую папку, сверка это покажет, а закрытие файла его уберёт.
function New-HmPinAt {
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][string]$ExpectedReal)
    $full = ConvertTo-HmFullDirPath $Dir
    $want = $ExpectedReal.TrimEnd('\')
    $hold = [IntPtr]::Zero
    $fs = $null
    try {
        $hold = Open-HmDirHandle $full $true
        $got = [string](Get-HmHandlePath $hold)
        if (-not [string]::Equals($got.TrimEnd('\'), $want, [System.StringComparison]::OrdinalIgnoreCase)) {
            $a = ($got -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?'); if ($a.Length -gt 300) { $a = $a.Substring(0, 300) }
            throw (New-Object System.InvalidOperationException("папка не там, где проверяли: на её месте «$a», ждали «$want» — на пути ссылка или папку подменили: $full"))
        }
        $name = '.hm-pin-' + [guid]::NewGuid().ToString('N')
        $pinPath = $full.TrimEnd('\') + '\' + $name
        $fs = New-Object System.IO.FileStream($pinPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 1, [System.IO.FileOptions]::DeleteOnClose)
        $gotPin = [string](Get-HmHandlePath ($fs.SafeFileHandle.DangerousGetHandle()))
        if (-not [string]::Equals($gotPin, $want + '\' + $name, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw (New-Object System.InvalidOperationException("закрепка легла не в ту папку: папку подменили в момент закрепления: $full"))
        }
        $res = [pscustomobject]@{ Stream = $fs; Dir = $full; Real = $want; Name = $name }
        $fs = $null
        return $res
    } finally {
        if ($fs) { $fs.Dispose() }
        Close-HmDirHandle $hold
    }
}

# То же, но ожидаемый путь считается от опоры: настоящий путь опоры + остаток пути.
function New-HmDirPin {
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][string]$Anchor)
    return (New-HmPinAt -Dir $Dir -ExpectedReal (Get-HmExpectedRealPath -Dir $Dir -Anchor $Anchor))
}

# Каталог внутри опоры: существующие звенья проверяются (ссылка — InvalidOperationException, файл на месте папки —
# IOException), недостающие создаются ПО ОДНОМУ, и перед созданием родитель закрепляется (в подменённой папке ничего не
# создаём), а созданный каталог закрепляется сразу. Итог — закрепка самого $Dir; закрывает вызывающий.
function Open-HmPinnedDir {
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][string]$Anchor)
    $full = ConvertTo-HmFullDirPath $Dir
    $base = ConvertTo-HmFullDirPath $Anchor
    $baseT = $base.TrimEnd('\')
    if ([string]::Equals($full.TrimEnd('\'), $baseT, [System.StringComparison]::OrdinalIgnoreCase)) { return (New-HmDirPin -Dir $full -Anchor $base) }
    if (-not $full.StartsWith($baseT + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw (New-Object System.InvalidOperationException("папка лежит не внутри доверенной опоры: $full (опора $base)"))
    }
    $expect = [string](Get-HmRealDirPath -Dir $base)
    if (-not $expect) { throw (New-Object System.InvalidOperationException("не удалось прочитать настоящий путь опоры (сетевой диск или нет доступа): $base")) }
    $expect = $expect.TrimEnd('\')
    $cur = $base
    $held = $null
    try {
        foreach ($seg in $full.Substring($baseT.Length + 1).Split('\')) {
            if (-not $seg) { continue }
            $next = [System.IO.Path]::Combine($cur, $seg)
            $last = $seg[$seg.Length - 1]
            if ($last -eq [char]'.' -or [char]::IsWhiteSpace($last)) {
                throw (New-Object System.InvalidOperationException("имя папки кончается точкой или пробелом: $next"))
            }
            $attr = $null
            $exists = $true
            try { $attr = [System.IO.File]::GetAttributes($next) }
            catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { $exists = $false }
            if ($exists) {
                if (-not ([int]$attr -band [int][System.IO.FileAttributes]::Directory)) {
                    throw (New-Object System.IO.IOException("на месте папки лежит файл: $next"))
                }
                if (Test-HmPathIsLink -Path $next -Attr $attr) {
                    $ex = New-Object System.InvalidOperationException("в пути есть ссылка (junction/symlink): $next")
                    $ex.Data['HmLink'] = $next   # путь самой ссылки: вызывающий называет его человеку и подсказывает rmdir
                    throw $ex
                }
            } else {
                if (-not $held -or -not [string]::Equals($held.Dir, $cur, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $parentPin = New-HmPinAt -Dir $cur -ExpectedReal $expect
                    if ($held) { $held.Stream.Dispose() }
                    $held = $parentPin
                }
                [void][System.IO.Directory]::CreateDirectory($next)
                $childPin = New-HmPinAt -Dir $next -ExpectedReal ($expect + '\' + $seg)
                $held.Stream.Dispose()
                $held = $childPin
            }
            $cur = $next
            $expect = $expect + '\' + $seg
        }
        if (-not $held -or -not [string]::Equals($held.Dir, $full, [System.StringComparison]::OrdinalIgnoreCase)) {
            $leaf = New-HmPinAt -Dir $full -ExpectedReal $expect
            if ($held) { $held.Stream.Dispose() }
            $held = $leaf
        }
        $res = $held
        $held = $null
        return $res
    } finally { if ($held) { $held.Stream.Dispose() } }
}

# --- снос дерева ------------------------------------------------------------------------------------------------

# Один шаг сноса записи: файл (или ссылка на файл), пустой каталог или ссылка на каталог. Повтор на «занято»
# (антивирус и индексатор на мгновенье держат свежий файл) и снятие атрибута «только чтение» с самой записи — Remove-Item
# -Force делал то же. Ссылка ли это, решает ВЫЗЫВАЮЩИЙ: Delete снимает ссылку, а не цель, только если вызвать его на ней.
function Remove-HmEntryOnce {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][bool]$IsDir)
    $cleared = $false
    for ($try = 1; $try -le 5; $try++) {
        try {
            if ($IsDir) { [System.IO.Directory]::Delete($Path, $false) } else { [System.IO.File]::Delete($Path) }
            return
        }
        catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return }
        catch [System.IO.PathTooLongException] { throw }
        catch [System.UnauthorizedAccessException], [System.IO.IOException] {
            # «Только чтение» на файле даёт отказ в доступе, на каталоге — IOException с тем же текстом: снимаем атрибут у
            # самой записи (SetAttributes на ссылке правит ссылку, не цель) и повторяем один раз, не засчитывая попытку.
            if (-not $cleared) {
                $ro = $false
                try {
                    $a = [System.IO.File]::GetAttributes($Path)
                    if ([int]$a -band [int][System.IO.FileAttributes]::ReadOnly) {
                        [System.IO.File]::SetAttributes($Path, [System.IO.FileAttributes]([int]$a -bxor [int][System.IO.FileAttributes]::ReadOnly))
                        $ro = $true
                    }
                } catch { }
                if ($ro) { $cleared = $true; $try--; continue }
            }
            # Отказ по правам повторять незачем; «занято» (антивирус, индексатор) проходит само.
            $real = $_.Exception
            if ($real -is [System.Management.Automation.MethodInvocationException] -and $real.InnerException) { $real = $real.InnerException }
            if ($real -is [System.UnauthorizedAccessException] -or $try -ge 5) { throw }
            Start-Sleep -Milliseconds (100 * $try)
        }
    }
}

function Add-HmRemoveFailure {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.ArrayList]$Failures, [string]$Path, $ErrorRecord)
    $msg = ''
    try { $msg = ([string]$ErrorRecord.Exception.Message -replace '\s+', ' ').Trim() } catch { }
    [void]$Failures.Add($Path + ' — ' + $msg)
}

# Запись $Path внутри закреплённого каталога, настоящий путь которого $ParentReal (корень сноса: файл, ссылка или
# каталог). Внутри дерева записи разбирает Remove-HmDirTree по списку из каталога, без второго обращения к диску.
function Remove-HmTreeEntry {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$ParentReal,
          [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.ArrayList]$Failures)
    $attr = $null
    try { $attr = [System.IO.File]::GetAttributes($Path) }
    catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return }
    catch { Add-HmRemoveFailure $Failures $Path $_; return }
    Remove-HmListedEntry -Path $Path -Attr $attr -ParentReal $ParentReal -Failures $Failures
}

# Запись с известными атрибутами: ссылка снимается как ссылка, файл — удалением, обычный каталог — обходом с закрепкой.
function Remove-HmListedEntry {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][System.IO.FileAttributes]$Attr,
          [Parameter(Mandatory = $true)][string]$ParentReal,
          [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.ArrayList]$Failures)
    $isDir = [bool]([int]$Attr -band [int][System.IO.FileAttributes]::Directory)
    if (Test-HmPathIsLink -Path $Path -Attr $Attr) {
        # Ссылка: снимаем саму ссылку, цель не читаем и не трогаем.
        try { Remove-HmEntryOnce -Path $Path -IsDir $isDir } catch { Add-HmRemoveFailure $Failures $Path $_ }
        return
    }
    if (-not $isDir) {
        try { Remove-HmEntryOnce -Path $Path -IsDir $false } catch { Add-HmRemoveFailure $Failures $Path $_ }
        return
    }
    Remove-HmDirTree -Dir $Path -ExpectedReal ($ParentReal.TrimEnd('\') + '\' + [System.IO.Path]::GetFileName($Path)) -Failures $Failures
}

# Обычный каталог (не ссылка): закрепить, убрать содержимое, отпустить, убрать сам. InvalidOperationException (на пути
# ссылка, папку подменили) НЕ глотается: это признак подмены, и остальное дерево после неё не трогаем.
function Remove-HmDirTree {
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][string]$ExpectedReal,
          [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.ArrayList]$Failures)
    $pin = $null
    for ($try = 1; $try -le 3 -and -not $pin; $try++) {
        try { $pin = New-HmPinAt -Dir $Dir -ExpectedReal $ExpectedReal }
        catch [System.InvalidOperationException] { throw }
        catch [System.IO.IOException] {
            if (-not [System.IO.Directory]::Exists($Dir)) { return }       # убрали без нас
            if ($try -ge 3) { Add-HmRemoveFailure $Failures $Dir $_; return }
            Start-Sleep -Milliseconds (150 * $try)
        }
    }
    $before = $Failures.Count
    try {
        $infos = @()
        # Список с атрибутами берётся из каталога за один заход: по записи отдельного обращения к диску не нужно.
        try { $infos = (New-Object System.IO.DirectoryInfo($Dir)).GetFileSystemInfos() }
        catch { Add-HmRemoveFailure $Failures $Dir $_ }
        foreach ($fi in $infos) {
            if ([string]::Equals($fi.Name, $pin.Name, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            $attr = $fi.Attributes
            if (([int]$attr -band 0x410) -eq 0) {
                # Обычный файл (ни каталог 0x10, ни точка повторной обработки 0x400): быстрый путь без вызовов функций.
                try { [System.IO.File]::Delete($fi.FullName) }
                catch { try { Remove-HmEntryOnce -Path $fi.FullName -IsDir $false } catch { Add-HmRemoveFailure $Failures $fi.FullName $_ } }
                continue
            }
            Remove-HmListedEntry -Path $fi.FullName -Attr $attr -ParentReal $pin.Real -Failures $Failures
        }
    } finally { $pin.Stream.Dispose() }
    # Сам каталог — когда закрепки уже нет; если внутри что-то осталось, он не пуст, и это уже названо выше.
    if ($Failures.Count -eq $before) {
        try { Remove-HmEntryOnce -Path $Dir -IsDir $true } catch { Add-HmRemoveFailure $Failures $Dir $_ }
    }
}

# Снести $Path (файл, ссылку или дерево) и НЕ идти по ссылкам. $Anchor — доверенная опора пути (Get-HmTrustAnchor):
# родитель $Path закрепляется и сверяется с ней, поэтому ссылка на любом звене пути не даёт снести чужое. Нет $Path —
# тихо ничего. Подмена или ссылка на пути — InvalidOperationException (ничего не тронуто за подменой); часть не
# убралась (занято) — IOException со счётом и первой причиной; остальное при этом убрано.
function Remove-HmTreeNoFollow {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Anchor)
    $full = ConvertTo-HmFullDirPath $Path
    $parent = [System.IO.Path]::GetDirectoryName($full)
    if (-not $parent) { throw (New-Object System.InvalidOperationException("корень диска не сносим: $full")) }
    # Есть ли что сносить: нет объекта — тихо ничего (атрибуты здесь не нужны, их читает Remove-HmTreeEntry уже под закрепкой родителя).
    try { [void][System.IO.File]::GetAttributes($full) }
    catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return }
    $ppin = New-HmDirPin -Dir $parent -Anchor $Anchor
    try {
        $failures = New-Object System.Collections.ArrayList
        Remove-HmTreeEntry -Path $full -ParentReal $ppin.Real -Failures $failures
        if ($failures.Count) {
            throw (New-Object System.IO.IOException("не удалось убрать объектов: $($failures.Count) (первый: " + $failures[0] + ")"))
        }
    } finally { $ppin.Stream.Dispose() }
}

# --- распаковка архива ------------------------------------------------------------------------------------------

# Имя из архива -> список звеньев относительно корня распаковки ($Prefix срезается). Недопустимое имя — исключение:
# «..», двоеточие (потоки данных), знаки, запрещённые в именах, имя с точкой или пробелом на конце.
function Split-HmZipEntryName {
    param([Parameter(Mandatory = $true)][string]$Name, [string]$Prefix = '')
    $n = $Name.Replace('/', '\')
    $pfx = $Prefix.Replace('/', '\')
    if ($pfx) {
        if (-not $n.StartsWith($pfx, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
        $n = $n.Substring($pfx.Length)
    }
    $isDir = $n.EndsWith('\')
    $segs = @($n.Split('\') | Where-Object { $_ -ne '' -and $_ -ne '.' })
    if ($segs.Count -eq 0) { return $null }
    foreach ($s in $segs) {
        $last = $s[$s.Length - 1]
        if ($s -eq '..' -or $s -match '[<>:"|?*\x00-\x1F]' -or $last -eq [char]'.' -or [char]::IsWhiteSpace($last)) {
            throw (New-Object System.IO.InvalidDataException("недопустимое имя в архиве: $Name"))
        }
    }
    if ($n -match '^[A-Za-z]:' -or $n.StartsWith('\')) { throw (New-Object System.IO.InvalidDataException("недопустимое имя в архиве (абсолютный путь): $Name")) }
    return [pscustomobject]@{ Segments = $segs; IsDir = $isDir }
}

# Первые звенья каталогов под $Prefix в архиве (для курса — имена навыков). Только каталоги: файл прямо под префиксом не в счёт.
function Get-HmZipTopNames {
    param([Parameter(Mandatory = $true)][string]$Zip, [Parameter(Mandatory = $true)][string]$Prefix)
    $fs = $null; $za = $null
    $names = New-Object System.Collections.ArrayList
    try {
        $fs = New-Object System.IO.FileStream($Zip, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Read, $false)
        foreach ($e in $za.Entries) {
            $parts = Split-HmZipEntryName -Name $e.FullName -Prefix $Prefix
            if ($null -eq $parts) { continue }
            if ($parts.Segments.Count -lt 2 -and -not $parts.IsDir) { continue }
            if ($names -notcontains $parts.Segments[0]) { [void]$names.Add($parts.Segments[0]) }
        }
    } finally { if ($za) { $za.Dispose() }; if ($fs) { $fs.Dispose() } }
    return ,@($names.ToArray())
}

# Разложить архив в $Dest (внутри опоры $Anchor). Каждая папка — через Open-HmPinnedDir (проверена, закреплена, создана
# под закрепкой родителя), каждый файл — через Write-HmFileSafe с -ClearReadOnly (это НАШИ файлы курса). Свой разбор
# вместо Expand-Archive: тот пишет файлы открытием самого имени на запись и идёт и по junction, и по file-symlink, и по
# подложенной за секунды распаковки папке. -Prefix: брать только записи под префиксом и срезать его; -Only: только эти
# первые звенья после префикса. Два прохода: первый ничего не пишет — разбирает имена (недопустимое имя — InvalidDataException)
# и проверяет уже существующие папки назначения (ссылка — InvalidOperationException), чтобы отказ пришёл ДО первой записи, а не
# оставил курс наполовину обновлённым; второй пишет, заново сверяя каждую папку по дескриптору. Возвращает число записанных
# файлов. Метки времени из архива не переносятся (файл получает время записи). Ошибки: InvalidOperationException
# (ссылка/подмена), InvalidDataException (имя в архиве), IOException (не вышло записать).
function Expand-HmZipSafe {
    param([Parameter(Mandatory = $true)][string]$Zip, [Parameter(Mandatory = $true)][string]$Dest,
          [Parameter(Mandatory = $true)][string]$Anchor, [string]$Prefix = '', [string[]]$Only)
    $destFull = ConvertTo-HmFullDirPath $Dest
    $pins = New-Object System.Collections.Hashtable ([System.StringComparer]::OrdinalIgnoreCase)
    $fs = $null; $za = $null
    $written = 0
    try {
        $fs = New-Object System.IO.FileStream($Zip, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Read, $false)
        # --- проход 1: имена и существующие папки, без записи ---
        $plan = New-Object System.Collections.ArrayList
        $checked = New-Object System.Collections.Hashtable ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($e in $za.Entries) {
            $parts = Split-HmZipEntryName -Name $e.FullName -Prefix $Prefix
            if ($null -eq $parts) { continue }
            $segs = $parts.Segments
            if ($Only -and ($Only -notcontains $segs[0])) { continue }
            $dirSegs = @()
            if ($parts.IsDir) { $dirSegs = $segs } elseif ($segs.Count -gt 1) { $dirSegs = $segs[0..($segs.Count - 2)] }
            $cur = $destFull
            foreach ($s in $dirSegs) {
                $cur = [System.IO.Path]::Combine($cur, $s)
                if ($checked.ContainsKey($cur)) { continue }
                $checked[$cur] = $true
                $attr = $null
                try { $attr = [System.IO.File]::GetAttributes($cur) }
                catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { continue }
                if (-not ([int]$attr -band [int][System.IO.FileAttributes]::Directory)) { throw (New-Object System.IO.IOException("на месте папки лежит файл: $cur")) }
                if (Test-HmPathIsLink -Path $cur -Attr $attr) {
                    $ex = New-Object System.InvalidOperationException("в пути есть ссылка (junction/symlink): $cur")
                    $ex.Data['HmLink'] = $cur   # путь самой ссылки: вызывающий называет его человеку и подсказывает rmdir
                    throw $ex
                }
            }
            [void]$plan.Add([pscustomobject]@{ Entry = $e; Segs = $segs; IsDir = $parts.IsDir; DirSegs = $dirSegs })
        }
        # --- проход 2: запись ---
        $pins[$destFull] = Open-HmPinnedDir -Dir $destFull -Anchor $Anchor
        foreach ($item in $plan) {
            $e = $item.Entry; $segs = $item.Segs
            $cur = $destFull
            foreach ($s in $item.DirSegs) {
                $next = [System.IO.Path]::Combine($cur, $s)
                if (-not $pins.ContainsKey($next)) { $pins[$next] = Open-HmPinnedDir -Dir $next -Anchor $destFull }
                $cur = $next
            }
            if ($item.IsDir) { continue }
            $bytes = $null
            $st = $e.Open()
            try {
                $ms = New-Object System.IO.MemoryStream
                $st.CopyTo($ms)
                $bytes = $ms.ToArray()
            } finally { $st.Dispose() }
            Write-HmFileSafe -Path ([System.IO.Path]::Combine($cur, $segs[$segs.Count - 1])) -Bytes $bytes -ClearReadOnly
            $written++
        }
    } finally {
        if ($za) { $za.Dispose() }
        if ($fs) { $fs.Dispose() }
        foreach ($k in @($pins.Keys)) { try { $pins[$k].Stream.Dispose() } catch { } }
    }
    return $written
}

# --- одиночные записи под администратором ------------------------------------------------------------------------

# Каталог $Path внутри опоры (по умолчанию — Get-HmTrustAnchor): проверить цепочку, создать недостающие звенья, ничего не
# оставляя закреплённым. Для скриптов, которым каталог нужен, даже когда файла в него не кладут (брендинг Nomad, папка моста).
function New-HmUserDir {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Anchor)
    $full = ConvertTo-HmFullDirPath $Path
    if (-not $Anchor) { $Anchor = Get-HmTrustAnchor -Path $full }
    $pin = Open-HmPinnedDir -Dir $full -Anchor $Anchor
    $pin.Stream.Dispose()
    return $full
}

# Записать файл в пользовательскую папку из-под администратора, не идя за ссылкой: каталог проверяется по всей цепочке от
# опоры (ссылка — InvalidOperationException, ничего не записано), недостающие звенья создаются под закрепкой, на время
# записи каталог закреплён, а сам файл ложится через Write-HmFileSafe (временный файл со случайным именем рядом и перенос
# по имени). Ссылка (symlink) уже стоит на имени файла — исключение, ничего не записано: Write-HmFileSafe отказывает на ссылке
# в листе; подложенная в окно между его последней проверкой и переносом — заменяется переносом, а не пишется насквозь.
# -ClearReadOnly — только для НАШИХ файлов.
function Write-HmUserFile {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes,
          [string]$Anchor, [switch]$ClearReadOnly)
    $full = [System.IO.Path]::GetFullPath($Path)
    $dir = [System.IO.Path]::GetDirectoryName($full)
    if (-not $Anchor) { $Anchor = Get-HmTrustAnchor -Path $dir }
    $pin = Open-HmPinnedDir -Dir $dir -Anchor $Anchor
    try { Write-HmFileSafe -Path $full -Bytes $Bytes -ClearReadOnly:$ClearReadOnly }
    finally { $pin.Stream.Dispose() }
}
