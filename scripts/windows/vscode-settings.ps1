# Первый запуск VS Code у новичка — Windows: настройки редактора, русский интерфейс,
# профиль терминала «Claude Code» и ярлык «Claude Code — мои проекты».
#
# Один файл функций на два входа:
#   - vscode.ps1 зовёт этот скрипт в блоке finally — ПОСЛЕ попытки поставить расширения, на
#     любом исходе шага; журнал подробный, код выхода шага не меняется;
#   - touchup-vscode.ps1 (подключает этот файл точкой и зовёт Invoke-HmVsCodeTouchup) идёт из
#     проверки при КАЖДОМ запуске установщика, в том числе когда карточка VS Code снята
#     («уже установлено») и vscode.ps1 не стартует вовсе. Тихий ход: одна строка или ничего.
#
# Зачем (диалоги Ники 05.10.2026, строки A02/A03/A04/A05/A39 разбора):
#   - справа открыт встроенный чат GitHub Copilot, и новичок пишет туда вместо Claude:
#     «Language model unavailable», вход в GitHub, «Credits at 90%»;
#   - папка открывается в «Restricted Mode», и панель Claude выключена;
#   - всплывают рекомендации расширений (Python и др.) и английская страница Welcome;
#   - Claude стартует в домашней папке, а промпты вставляют в голый PowerShell.
#
# Правила записи — это ЧУЖИЕ, пользовательские файлы, а пишет их процесс администратора:
#   - дописываем только ключи, которых нет; заданный человеком ключ не трогаем никогда;
#   - файл, который не разобрался как JSON с комментариями, не трогаем вовсе;
#   - перед записью — копия рядом, запись через временный файл и подмену целиком;
#   - сквозь ссылки (symlink, junction, hardlink) не пишем: проверяем ВЕСЬ путь от якоря
#     (%APPDATA% и ниже) и перепроверяем сразу перед каждой записью, а не один раз в начале;
#   - ярлыки кладём только в папки «Рабочий стол» и «меню Пуск», ПРОВЕРЕННЫЕ по профилю
#     (Test-HmShellFolder, _userpath.ps1): ответ оболочки лежит в ветке реестра, которую без UAC
#     правит любая программа пользователя, и перенаправленный в чужую папку (автозагрузка всех
#     пользователей, чужой профиль) стол получил бы файл, созданный администратором;
#   - владельца файла возвращаем пользователю через ДЕРЖИМЫЙ нами дескриптор своего же
#     свежего файла, а не по пути: по пути привилегированная смена владельца пошла бы за
#     подложенной ссылкой и отдала бы пользователю чужой файл;
#   - ключ, который мы однажды записали, а человек потом убрал, не возвращаем: VS Code сам
#     удаляет ключ, когда его возвращают к значению по умолчанию в окне настроек, и без
#     отметки повторный запуск установщика молча отменял бы выбор человека. Исключение —
#     откат файла целиком (синхронизация, восстановление копии): тогда пропадает сразу
#     несколько наших ключей, и мы возвращаем их, говоря об этом прямо.
#
# Тексты строк лога подобраны так, чтобы не путать разбор провала (src/failure-explain.js):
# этот шаг печатает ПОСЛЕ сообщений о расширениях, и строка с многоточием на конце или со
# словами «не найден»/«не удалось» подменила бы человеку этап и причину настоящего сбоя.
#
# Тестовый ход: HM_FIRSTRUN_ROOT=<папка внутри %TEMP%> переносит ВСЕ пути (профиль, AppData,
# рабочий стол, меню «Пуск», Program Files) под эту папку — иначе прогон скрипта целиком на
# машине разработчика писал бы в его настоящий профиль и на настоящий рабочий стол. Вне
# %TEMP% переменная игнорируется. Любой прогон vscode.ps1 целиком в песочнице обязан её задать.
$ErrorActionPreference = 'Continue'

# Общий помощник: проверка папок стола и «Пуска» по профилю (Test-HmShellFolder), запись ярлыка
# без Save() по пути (New-HmShortcutFile), чтение тега точки повторной обработки без Add-Type.
# Нет файла рядом — ярлыки не пишем (см. Set-HmShellDirs), остальной шаг работает как раньше.
$hmUserPathLib = Join-Path $PSScriptRoot '_userpath.ps1'
if (Test-Path -LiteralPath $hmUserPathLib) { . $hmUserPathLib }

# ---------------------------------------------------------------------------
# Журнал шага
# ---------------------------------------------------------------------------
# В обычном ходе строки идут на экран установщика; в тихом (touchup) копятся в памяти, а на
# экран выходит ровно одна итоговая строка либо ничего.
$script:HmQuiet = $false
$script:HmLogLines = New-Object System.Collections.Generic.List[string]
$script:HmDeadline = $null     # тихий ход обязан уложиться в ~5 с: поздно — пропускаем остальное
$script:HmLnkName = 'Claude Code — мои проекты.lnk'
$script:HmMaxJsoncBytes = 262144

function Write-HmLog {
    param([string]$Text)
    if ($script:HmQuiet) { $script:HmLogLines.Add($Text) } else { Write-Host $Text }
}
function Write-HmReceipt {
    param([string]$Path)
    if (-not $script:HmQuiet) { Write-Host "HM-RECEIPT path $Path" }
}
function Test-HmPastDeadline {
    return [bool]($script:HmDeadline -and ((Get-Date) -gt $script:HmDeadline))
}

# ---------------------------------------------------------------------------
# JSON с комментариями (JSONC): разбор «формы» файла без пересборки текста.
# ---------------------------------------------------------------------------
# Файл не пересобираем из объекта: ConvertFrom-Json/ConvertTo-Json потеряли бы комментарии
# и порядок, а в Windows PowerShell 5.1 ещё и падают на ключах, различающихся регистром.
# Вместо этого — разбор токенов: если весь файл разобрался, знаем ключи верхнего уровня и
# место закрывающей скобки, и новые ключи ВСТАВЛЯЕМ в исходный текст.
#
# Мягче строгого JSON ровно там, где мягок сам VS Code: пробел — любой, включая неразрывный
# и BOM внутри; в строке допустимы сырой TAB и «\» с любым символом после («C:\Python312\
# python.exe», вставленный из учебника, — красная волна в редакторе, но файл читается).
# Раньше такой файл признавался неразбираемым, и человек оставался без настроек. Текст
# человека при этом не переписывается: расшифровываются только ИМЕНА ключей.
$script:HmJsoncRx = New-Object System.Text.RegularExpressions.Regex(
    '\G(?:(?<ws>[ \t\r\n\v\f\u00A0\uFEFF]+)|(?<lc>//[^\r\n]*)|(?<bc>/\*[\s\S]*?\*/)|' +
    '(?<str>"(?:[^"\\\r\n]|\\[^\n])*")|' +
    '(?<num>-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|' +
    '(?<lit>true|false|null)|(?<p>[{}\[\]:,]))')

function ConvertFrom-HmJsonString {
    # Токен строки в кавычках -> значение. Допустимые escape-последовательности
    # расшифровываются, недопустимые («\P») остаются как есть.
    param([string]$Token)
    $inner = $Token.Substring(1, $Token.Length - 2)
    if ($inner.IndexOf('\') -lt 0) { return $inner }
    return [regex]::Replace($inner, '\\(?:u([0-9A-Fa-f]{4})|(["\\/bfnrt])|([^\n]))', {
        param($m)
        if ($m.Groups[1].Success) { return [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) }
        if ($m.Groups[2].Success) {
            switch -CaseSensitive ($m.Groups[2].Value) {
                'b' { return [string][char]8 }
                'f' { return [string][char]12 }
                'n' { return "`n" }
                'r' { return "`r" }
                't' { return "`t" }
                default { return $m.Groups[2].Value }
            }
        }
        return $m.Value
    })
}

function ConvertTo-HmJsonString {
    param([string]$Value)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int]$ch
        if ($code -eq 0x22) { [void]$sb.Append('\"') }
        elseif ($code -eq 0x5C) { [void]$sb.Append('\\') }
        elseif ($code -lt 0x20) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
        else { [void]$sb.Append($ch) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

# Значение -> текст JSON. Unit — один уровень отступа, Base — отступ строки, на которой
# стоит значение: дети объекта идут с Base+Unit, закрывающая скобка — с Base. Объекты —
# построчно, массивы скаляров — в одну строку, как пишет сам VS Code.
function ConvertTo-HmJsonLiteral {
    param($Value, [string]$Unit, [string]$Base, [string]$Eol)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [string]) { return (ConvertTo-HmJsonString $Value) }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) {
        return [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}', $Value)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        if ($Value.Count -eq 0) { return '{}' }
        $inner = $Base + $Unit
        $parts = @(foreach ($k in $Value.Keys) {
            $inner + (ConvertTo-HmJsonString ([string]$k)) + ': ' + (ConvertTo-HmJsonLiteral $Value[$k] $Unit $inner $Eol)
        })
        return '{' + $Eol + ($parts -join (',' + $Eol)) + $Eol + $Base + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @(foreach ($v in $Value) { ConvertTo-HmJsonLiteral $v $Unit $Base $Eol })
        return '[' + ($items -join ', ') + ']'
    }
    throw ('тип значения не поддержан: ' + $Value.GetType().FullName)
}

# Разбор формы. Возвращает:
#   Ok          — весь текст разобрался как JSONC, корень — объект (или файл пуст);
#   Empty       — значимых токенов нет (пустой файл или одни комментарии);
#   Keys        — ключи верхнего уровня (раскодированные);
#   Members     — члены корня: {Name, KeyIdx, ValStart, ValEnd} (индексы токенов значения);
#   Tokens      — значимые токены {T, V, S, E} (T: str|scalar|p);
#   CloseIdx    — индекс токена «}», закрывающего корень;
#   FirstKeyIdx — индекс токена первого ключа верхнего уровня (-1, если ключей нет);
#   Error       — почему не разобрался (по-русски, для лога).
function Get-HmJsoncShape {
    param([string]$Text)
    $r = @{ Ok = $false; Empty = $false; Error = ''; CloseIdx = -1; FirstKeyIdx = -1
            Keys = (New-Object System.Collections.Generic.List[string])
            Members = (New-Object System.Collections.Generic.List[object])
            Tokens = (New-Object System.Collections.Generic.List[object]) }
    $toks = $r.Tokens
    $pos = 0
    while ($pos -lt $Text.Length) {
        $m = $script:HmJsoncRx.Match($Text, $pos)
        if (-not $m.Success -or $m.Length -eq 0) { $r.Error = "непонятный символ в позиции $pos"; return $r }
        if (-not ($m.Groups['ws'].Success -or $m.Groups['lc'].Success -or $m.Groups['bc'].Success)) {
            $type = 'scalar'
            if ($m.Groups['str'].Success) { $type = 'str' } elseif ($m.Groups['p'].Success) { $type = 'p' }
            $toks.Add([pscustomobject]@{ T = $type; V = $m.Value; S = $m.Index; E = $m.Index + $m.Length })
        }
        $pos += $m.Length
    }
    if ($toks.Count -eq 0) { $r.Ok = $true; $r.Empty = $true; return $r }
    if ($toks[0].V -ne '{') { $r.Error = 'в корне файла не объект { }'; return $r }

    # Автомат вместо рекурсии: стек открытых скобок и «что ждём дальше».
    $stack = New-Object System.Collections.Generic.List[string]
    $expect = 'value'
    $cur = $null
    for ($i = 0; $i -lt $toks.Count; $i++) {
        $t = $toks[$i]; $v = $t.V; $done = $false
        if ($expect -eq 'end') { $r.Error = "лишний текст после закрывающей скобки (позиция $($t.S))"; return $r }
        elseif ($expect -eq 'value' -or $expect -eq 'value-or-close') {
            if ($v -eq ']' -and $expect -eq 'value-or-close') { $stack.RemoveAt($stack.Count - 1); $done = $true }
            elseif ($v -eq '{') { $stack.Add('{'); $expect = 'key-or-close' }
            elseif ($v -eq '[') { $stack.Add('['); $expect = 'value-or-close' }
            elseif ($t.T -eq 'str' -or $t.T -eq 'scalar') { $done = $true }
            else { $r.Error = "ожидалось значение (позиция $($t.S))"; return $r }
            if ($stack.Count -gt 256) { $r.Error = 'слишком глубокая вложенность'; return $r }
        }
        elseif ($expect -eq 'key-or-close') {
            if ($v -eq '}') { $stack.RemoveAt($stack.Count - 1); $done = $true }
            elseif ($t.T -eq 'str') {
                if ($stack.Count -eq 1) {
                    $name = ConvertFrom-HmJsonString $v
                    $r.Keys.Add($name)
                    if ($r.FirstKeyIdx -lt 0) { $r.FirstKeyIdx = $i }
                    $cur = @{ Name = $name; KeyIdx = $i; ValStart = -1; ValEnd = -1 }
                }
                $expect = 'colon'
            }
            else { $r.Error = "ожидалось имя ключа в кавычках (позиция $($t.S))"; return $r }
        }
        elseif ($expect -eq 'colon') {
            if ($v -eq ':') {
                $expect = 'value'
                if ($cur -and $stack.Count -eq 1 -and $cur.ValStart -lt 0) { $cur.ValStart = $i + 1 }
            }
            else { $r.Error = "ожидалось двоеточие (позиция $($t.S))"; return $r }
        }
        else {   # comma-or-close
            $top = $stack[$stack.Count - 1]
            if ($v -eq ',') { if ($top -eq '{') { $expect = 'key-or-close' } else { $expect = 'value-or-close' } }
            elseif (($v -eq '}' -and $top -eq '{') -or ($v -eq ']' -and $top -eq '[')) { $stack.RemoveAt($stack.Count - 1); $done = $true }
            else { $r.Error = "ожидалась запятая или закрывающая скобка (позиция $($t.S))"; return $r }
        }
        if ($done) {
            if ($stack.Count -eq 0) { $expect = 'end'; $r.CloseIdx = $i }
            else {
                $expect = 'comma-or-close'
                # Значение члена корня закончилось: запоминаем, где оно лежит среди токенов.
                if ($stack.Count -eq 1 -and $cur) { $cur.ValEnd = $i; $r.Members.Add($cur); $cur = $null }
            }
        }
    }
    if ($expect -ne 'end') { $r.Error = 'файл обрывается: нет закрывающей скобки'; return $r }
    $r.Ok = $true
    return $r
}

# Прямые ключи объекта-значения члена корня (например, имена профилей терминала).
function Get-HmNestedKeys {
    param($Shape, $Member)
    $keys = New-Object System.Collections.Generic.List[string]
    $depth = 0; $expectKey = $true
    for ($i = $Member.ValStart + 1; $i -lt $Member.ValEnd; $i++) {
        $t = $Shape.Tokens[$i]
        if ($t.T -eq 'p') {
            if ($t.V -eq '{' -or $t.V -eq '[') { $depth++ }
            elseif ($t.V -eq '}' -or $t.V -eq ']') { $depth-- }
            elseif ($t.V -eq ',' -and $depth -eq 0) { $expectKey = $true }
        }
        elseif ($t.T -eq 'str' -and $depth -eq 0 -and $expectKey) {
            $keys.Add((ConvertFrom-HmJsonString $t.V))
            $expectKey = $false
        }
    }
    return ,$keys
}

# Отступ строки, на которой начинается токен в позиции Pos (если перед ним только пробелы).
function Get-HmLineIndent {
    param([string]$Text, [int]$Pos)
    $j = $Pos - 1
    while ($j -ge 0 -and ($Text[$j] -eq ' ' -or $Text[$j] -eq "`t")) { $j-- }
    if ($j -lt 0 -or $Text[$j] -eq "`n") { return $Text.Substring($j + 1, $Pos - $j - 1) }
    return ''
}

# Один уровень отступа файла: отступ первого ключа корня, если он из одних табов или из
# 1-8 пробелов; иначе четыре пробела.
function Get-HmIndentUnit {
    param([string]$Text, $Shape)
    $unit = '    '
    if ($Shape.FirstKeyIdx -ge 0) {
        $ind = Get-HmLineIndent $Text $Shape.Tokens[$Shape.FirstKeyIdx].S
        if ($ind -and ($ind -match '^\t+$' -or $ind -match '^ {1,8}$')) { $unit = $ind }
    }
    return $unit
}

# Вставляет члены в объект между токенами OpenIdx («{») и CloseIdx («}»), не трогая остальной
# текст. Новые члены встают ПОСЛЕ последнего — с отступом первого члена этого же объекта и
# концом строки этого же файла. Комментарии и запятые человека остаются на местах.
function Add-HmJsoncMembers {
    param([string]$Text, $Shape, [int]$OpenIdx, [int]$CloseIdx, [System.Collections.IDictionary]$Entries,
          [string]$DefaultEol, [string]$ParentIndent = '')
    $eol = $DefaultEol
    if ($Text.Contains("`r`n")) { $eol = "`r`n" } elseif ($Text.Contains("`n")) { $eol = "`n" }
    $unit = Get-HmIndentUnit $Text $Shape
    $memberIndent = ''
    if ($CloseIdx -gt $OpenIdx + 1 -and $Shape.Tokens[$OpenIdx + 1].T -eq 'str') {
        $memberIndent = Get-HmLineIndent $Text $Shape.Tokens[$OpenIdx + 1].S
    }
    if (-not $memberIndent) { $memberIndent = $ParentIndent + $unit }
    $members = @(foreach ($k in $Entries.Keys) {
        $memberIndent + (ConvertTo-HmJsonString ([string]$k)) + ': ' + (ConvertTo-HmJsonLiteral $Entries[$k] $unit $memberIndent $eol)
    })
    $block = $members -join (',' + $eol)
    $close = $Shape.Tokens[$CloseIdx]
    $last = $Shape.Tokens[$CloseIdx - 1]
    # Запятая нужна, если перед «}» стоит значение; после «{» и после висячей запятой — нет.
    $needComma = ($last.V -ne '{' -and $last.V -ne ',')
    $j = $close.S - 1
    while ($j -ge 0 -and ($Text[$j] -eq ' ' -or $Text[$j] -eq "`t")) { $j-- }
    if ($j -lt 0 -or $Text[$j] -eq "`n") { $at = $j + 1; $ins = $block + $eol }                  # «}» на своей строке
    else { $at = $close.S; $ins = $eol + $block + $eol + $ParentIndent }                        # «}» в строке с текстом
    $out = $Text.Insert($at, $ins)
    # Запятую — сразу за последним значением, а не перед «}»: между ними может стоять
    # строчный комментарий, и запятая после «//» стала бы его частью.
    if ($needComma) { $out = $out.Insert($last.E, ',') }
    return $out
}

# Вставляет ключи в КОРНЕВОЙ объект. Пустой файл (или одни комментарии) получает объект.
function Add-HmJsoncKeys {
    param([string]$Text, $Shape, [System.Collections.IDictionary]$Entries, [string]$DefaultEol)
    if ($Shape.Empty) {
        $eol = $DefaultEol
        if ($Text.Contains("`r`n")) { $eol = "`r`n" } elseif ($Text.Contains("`n")) { $eol = "`n" }
        $unit = '    '
        $members = @(foreach ($k in $Entries.Keys) {
            $unit + (ConvertTo-HmJsonString ([string]$k)) + ': ' + (ConvertTo-HmJsonLiteral $Entries[$k] $unit $unit $eol)
        })
        $prefix = $Text
        if ($prefix.Length -gt 0 -and -not $prefix.EndsWith("`n")) { $prefix += $eol }
        return $prefix + '{' + $eol + ($members -join (',' + $eol)) + $eol + '}' + $eol
    }
    return (Add-HmJsoncMembers -Text $Text -Shape $Shape -OpenIdx 0 -CloseIdx $Shape.CloseIdx -Entries $Entries -DefaultEol $DefaultEol)
}

# Ключ уже задан, если он есть дословно ИЛИ записан «вложенно»: VS Code раскладывает
# "workbench": { "startupEditor": ... } в то же дерево, и наш "workbench.startupEditor"
# перебил бы значение человека. Регистр важен: VS Code различает ключи с учётом регистра.
function Test-HmKeyCovered {
    param($Keys, [string]$Name)
    foreach ($k in $Keys) {
        if ($k -ceq $Name) { return $true }
        if ($Name.StartsWith($k + '.', [StringComparison]::Ordinal)) { return $true }
        if ($k.StartsWith($Name + '.', [StringComparison]::Ordinal)) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Пути и безопасная работа с файлами профиля из-под администратора
# ---------------------------------------------------------------------------

# Папки ярлыков — не «как сказала оболочка», а после проверки по профилю (Test-HmShellFolder):
# ответ оболочки лежит в ветке реестра, которую без UAC правит любая программа пользователя, и
# перенаправленный в чужую папку стол получил бы ярлык, созданный администратором. Не прошла —
# Desktop/Programs = $null, а причина в DesktopWhy/ProgramsWhy: её увидит человек в журнале.
# ShellProfile — профиль, по которому проверяли (список профилей Windows, не $env:USERPROFILE; в
# песочнице — её home); им же проверка повторяется на месте использования (Set-HmClaudeShortcut).
function Set-HmShellDirs {
    param($Paths, [string]$ProfileDir, [string]$DesktopAnswer, [string]$ProgramsAnswer)
    $Paths.ShellProfile = $ProfileDir
    $Paths.Desktop = $null; $Paths.DesktopWhy = ''
    $Paths.Programs = $null; $Paths.ProgramsWhy = ''
    if (-not (Get-Command Test-HmShellFolder -ErrorAction SilentlyContinue)) {
        # Общий помощник не подключился (_userpath.ps1 не рядом): без проверки ярлыки не пишем.
        $Paths.DesktopWhy = 'рядом нет _userpath.ps1, папку проверить нечем'
        $Paths.ProgramsWhy = $Paths.DesktopWhy
        return
    }
    $d = Test-HmShellFolder -ProfileDir $ProfileDir -Candidate $DesktopAnswer -Kind Desktop
    if ($d.Ok) { $Paths.Desktop = $d.Dir } else { $Paths.DesktopWhy = $d.Reason }
    # Меню «Пуск» — только на обычном месте профиля (Kind = Programs): выбирать другую папку незачем,
    # а выбор подменяющего (пустой каталог внутри профиля) — это то, что проверка и отсекает.
    $p = Test-HmShellFolder -ProfileDir $ProfileDir -Candidate $ProgramsAnswer -Kind Programs
    if ($p.Ok) { $Paths.Programs = $p.Dir } else { $Paths.ProgramsWhy = $p.Reason }
}

# Все пути шага в одном месте. HM_FIRSTRUN_ROOT работает только внутри %TEMP% (см. шапку).
function Get-HmPaths {
    $root = $env:HM_FIRSTRUN_ROOT
    if ($root) {
        try {
            $full = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
            $tmp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
            if ($full.StartsWith($tmp + '\', [StringComparison]::OrdinalIgnoreCase)) {
                $prof = Join-Path $full 'home'
                $sp = @{
                    Profile = $prof; AppData = (Join-Path $prof 'AppData\Roaming'); LocalAppData = (Join-Path $prof 'AppData\Local')
                    ProgramFiles = (Join-Path $full 'pf'); Sandbox = $true
                }
                # «Ответ оболочки» песочницы — её же папки; суд над ними — тот же, что и в бою.
                Set-HmShellDirs $sp $prof (Join-Path $prof 'Desktop') (Join-Path $prof 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs')
                return $sp
            }
        } catch { }
    }
    $rp = @{
        Profile = $env:USERPROFILE; AppData = $env:APPDATA; LocalAppData = $env:LOCALAPPDATA
        ProgramFiles = $env:ProgramFiles; Sandbox = $false
    }
    if (Get-Command Get-HmShellAnswer -ErrorAction SilentlyContinue) {
        Set-HmShellDirs $rp (Get-HmProfileRoot) (Get-HmShellAnswer 'Desktop') (Get-HmShellAnswer 'Programs')
    } else {
        Set-HmShellDirs $rp '' '' ''
    }
    return $rp
}

# $true — путь существует и это ссылка (symlink, junction, hardlink) либо прочитать его не
# удалось. Облачные заглушки OneDrive ссылками не считаются: LinkType у них пуст, хотя сырой
# атрибут ReparsePoint стоит. Но LinkType пуст и у настоящей junction/symlink, у которой владелец
# запретил чтение на САМОЙ ссылке (icacls /deny — прав для этого не нужно): Get-Item тогда не
# читает данные ссылки (проверено на PS 5.1). Поэтому при пустом LinkType и атрибуте ReparsePoint
# решает тег из записи каталога (Get-HmReparseTag из _userpath.ps1 читает его без прав на саму
# ссылку): облачный тег — не ссылка, любой другой и нечитаемый — ссылка.
function Test-HmLinkItem {
    param([string]$Path)
    $fi = New-Object System.IO.FileInfo($Path)
    if ([int]$fi.Attributes -eq -1) { return $false }   # пути нет
    try { $it = Get-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { return $true }
    if ([bool]$it.LinkType) { return $true }
    if (([int]$fi.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -and (Get-Command Get-HmReparseTag -ErrorAction SilentlyContinue)) {
        return (-not (Test-HmCloudReparseTag (Get-HmReparseTag $Path)))
    }
    return $false
}

# Идёт по ВСЕМУ пути от якоря вниз до самого файла и возвращает первую ссылку ('' — чисто).
# Одной проверки «папка и файл» мало: обычный файл, достигнутый ЧЕРЕЗ junction выше по
# цепочке, сам ссылкой не выглядит. Якорь — корень пользовательской ветки (%APPDATA%,
# %LOCALAPPDATA%): всё ниже него принадлежит процессам этого пользователя и может быть
# подменено. IncludeAnchor=$false — для профиля: перенесённый на другой диск через junction
# профиль целиком не повод отказывать человеку. Путь вне якоря проверяется от первой
# папки под корнем диска.
function Get-HmLinkOnPath {
    param([string]$Path, [string]$Anchor = '', [bool]$IncludeAnchor = $true)
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $chain = New-Object System.Collections.Generic.List[string]
    if ($Anchor) {
        $a = [System.IO.Path]::GetFullPath($Anchor).TrimEnd('\')
        if ($full.Equals($a, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($a + '\', [StringComparison]::OrdinalIgnoreCase)) {
            if ($IncludeAnchor) { $chain.Add($a) }
            $cur = $a
            foreach ($seg in $full.Substring($a.Length).TrimStart('\').Split('\')) {
                if ($seg) { $cur = $cur + '\' + $seg; $chain.Add($cur) }
            }
        }
    }
    if ($chain.Count -eq 0) {
        $rootDir = [System.IO.Path]::GetPathRoot($full)
        $cur = $rootDir.TrimEnd('\')
        foreach ($seg in $full.Substring($rootDir.Length).Split('\')) {
            if ($seg) { $cur = $cur + '\' + $seg; $chain.Add($cur) }
        }
    }
    foreach ($p in $chain) {
        $fi = New-Object System.IO.FileInfo($p)
        if ([int]$fi.Attributes -eq -1) { break }      # дальше ничего нет — проверять нечего
        if (Test-HmLinkItem $p) { return $p }
    }
    return ''
}

# Причина сбоя — человеческими словами, без английских «Access is denied» и т.п.: эти строки
# идут в лог ПОСЛЕ сообщений о расширениях, и словарь failure-explain.js принял бы чужое
# «отказано в доступе» за причину провала всего шага VS Code.
function Get-HmReason {
    param($Exception, [switch]$Read)
    # Вызов .NET-метода PowerShell оборачивает в MethodInvocationException — причина внутри.
    while ($Exception -is [System.Management.Automation.MethodException] -and $Exception.InnerException) { $Exception = $Exception.InnerException }
    if ($Exception -is [System.UnauthorizedAccessException]) {
        if ($Read) { return 'нет права прочитать файл' }
        return 'нет прав на запись — файл только для чтения или защищён'
    }
    if ($Exception -is [System.IO.IOException]) { return 'файл занят другой программой или путь недоступен' }
    # Имя типа без хвоста «Exception»: сам этот хвост словарь разбора считает признаком провала.
    return ('непредвиденная ситуация: ' + ($Exception.GetType().Name -replace 'Exception$', ''))
}

# Текст файла: UTF-8 (с BOM или без). Другие кодировки не трогаем — признаём «не разобрался».
function Read-HmTextFile {
    param([string]$Path)
    try { $bytes = [System.IO.File]::ReadAllBytes($Path) }
    catch { return @{ Ok = $false; Error = 'файл не читается: ' + (Get-HmReason $_.Exception -Read) } }
    $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if (-not $bom -and $bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))) {
        return @{ Ok = $false; Error = 'файл в кодировке UTF-16' }
    }
    $off = 0; if ($bom) { $off = 3 }
    try { $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes, $off, $bytes.Length - $off) }
    catch { return @{ Ok = $false; Error = 'файл не в кодировке UTF-8' } }
    return @{ Ok = $true; Text = $text; Bom = $bom }
}

# Запись целиком: копия прежнего файла (по запросу) -> новый временный файл с уникальным
# именем в той же папке -> подмена. Временное имя случайное и создаётся с CreateNew:
# заранее подложить по нему ссылку нельзя. Подмена через File.Replace сохраняет права
# прежнего файла; новый файл — File.Move.
#
# Путь проверяется на ссылки перед созданием временного файла И перед каждой попыткой
# подмены (между ними проходят секунды повторов), а не один раз в начале шага.
#
# Владельца ставим пользователю тут же, через дескриптор СВОЕГО временного файла, пока он
# открыт: так смена владельца не заново разрешает путь, и подложенная ссылка не может
# увести привилегированную операцию на чужой файл. Косметика: права у пользователя и так
# есть по наследству от папки профиля — не вышло, файл остаётся рабочим.
function Write-HmFileSafely {
    param([string]$Path, [string]$Text, [bool]$Bom, [bool]$Backup, [string]$Anchor = '', [bool]$IncludeAnchor = $true)
    $dir = Split-Path -Parent $Path
    $leaf = Split-Path -Leaf $Path
    $rand = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $tmp = Join-Path $dir ($leaf + '.hm-tmp-' + $rand)
    $bak = ''
    $exists = Test-Path -LiteralPath $Path
    try {
        $hit = Get-HmLinkOnPath $Path $Anchor $IncludeAnchor
        if ($hit) { throw (New-Object System.InvalidOperationException("путь стал ссылкой: $hit")) }
        if ($exists -and $Backup) {
            $bak = Join-Path $dir ($leaf + '.hm-bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $rand)
            [System.IO.File]::Copy($Path, $bak, $false)
        }
        $enc = New-Object System.Text.UTF8Encoding($Bom)
        $pre = $enc.GetPreamble()
        $body = $enc.GetBytes($Text)
        $fs = $null
        try {
            $rights = [System.Security.AccessControl.FileSystemRights]'Write, ReadPermissions, ChangePermissions, TakeOwnership'
            $fs = New-Object System.IO.FileStream($tmp, [System.IO.FileMode]::CreateNew, $rights, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None)
        } catch {
            # Расширенные права на свежий файл не дали — пишем обычным дескриптором, без смены владельца.
            $fs = $null
        }
        if ($null -eq $fs) {
            $fs = New-Object System.IO.FileStream($tmp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        }
        $owned = $false
        try {
            if ($pre.Length -gt 0) { $fs.Write($pre, 0, $pre.Length) }
            $fs.Write($body, 0, $body.Length)
            $fs.Flush($true)
            try {
                $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
                $sec = $fs.GetAccessControl()
                if ($sec.GetOwner([System.Security.Principal.SecurityIdentifier]) -eq $sid) { $owned = $true }
                else { $sec.SetOwner($sid); $fs.SetAccessControl($sec); $owned = $true }
            } catch { $owned = $false }
        } finally { $fs.Dispose() }
        # [NullString]::Value, а не $null: PowerShell превращает $null в пустую строку, и
        # File.Replace принял бы её за имя файла копии.
        #
        # Повтор с паузами — только на «файл занят» (IOException). Антивирус открывает
        # только что записанный файл на проверку и держит его без права на удаление, а
        # подмене оно нужно: на тестовой машине так срывалась каждая третья запись argv.json
        # (замер 06.10). «Нет прав» (UnauthorizedAccess) не повторяем: ожидание его не лечит.
        for ($try = 1; ; $try++) {
            $hit = Get-HmLinkOnPath $Path $Anchor $IncludeAnchor
            if ($hit) { throw (New-Object System.InvalidOperationException("путь стал ссылкой: $hit")) }
            try {
                if ($exists) { [System.IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $Path) }
                break
            } catch {
                $inner = $_.Exception
                while ($inner -is [System.Management.Automation.MethodException] -and $inner.InnerException) { $inner = $inner.InnerException }
                if ($try -ge 6 -or -not ($inner -is [System.IO.IOException]) -or (Test-HmPastDeadline)) { throw }
                Start-Sleep -Milliseconds (250 * $try)
            }
        }
        return @{ Ok = $true; Backup = $bak; Owned = $owned; Error = '' }
    } catch {
        $ex = $_.Exception
        $why = Get-HmReason $ex
        if ($ex -is [System.InvalidOperationException] -and $ex.Message -like 'путь стал ссылкой*') { $why = $ex.Message }
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        # Файл не тронут — его копия не нужна, мусор рядом с настройками не оставляем.
        if ($bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }
        return @{ Ok = $false; Backup = ''; Owned = $false; Error = $why }
    }
}

# ---------------------------------------------------------------------------
# Отметка «это уже ставили» — рядом с settings.json
# ---------------------------------------------------------------------------
# Идентификаторы: settings:<ключ>, settings:<ключ>#<вложенный ключ> (профиль терминала),
# argv:<ключ>, shortcut:<desktop|programs>. Пропала вместе с папкой настроек (человек
# сбросил VS Code) — значит, ставим заново; это и нужно.
function Read-HmAppliedMarker {
    param([string]$Path)
    $set = New-Object 'System.Collections.Generic.HashSet[string]'
    if (-not (Test-Path -LiteralPath $Path)) { return ,$set }
    try {
        $o = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
        foreach ($k in @($o.settings)) { if ($k) { [void]$set.Add('settings:' + [string]$k) } }
        foreach ($k in @($o.argv)) { if ($k) { [void]$set.Add('argv:' + [string]$k) } }
        foreach ($k in @($o.shortcuts)) { if ($k) { [void]$set.Add('shortcut:' + [string]$k) } }
    } catch { }
    return ,$set
}

function Write-HmAppliedMarker {
    param([string]$Path, $Set, [string]$Anchor = '')
    $s = @(); $a = @(); $l = @()
    foreach ($e in $Set) {
        if ($e.StartsWith('settings:')) { $s += $e.Substring(9) }
        elseif ($e.StartsWith('argv:')) { $a += $e.Substring(5) }
        elseif ($e.StartsWith('shortcut:')) { $l += $e.Substring(9) }
    }
    $o = [ordered]@{
        note      = 'Hamidun Setup: ключи и ярлыки, которые установщик уже добавлял в настройки VS Code. Удалённое человеком из этого списка установщик не возвращает.'
        settings  = @($s | Sort-Object)
        argv      = @($a | Sort-Object)
        shortcuts = @($l | Sort-Object)
    }
    return (Write-HmFileSafely -Path $Path -Text ((ConvertTo-HmJsonLiteral $o '  ' '' "`r`n") + "`r`n") -Bom $false -Backup $false -Anchor $Anchor -IncludeAnchor $true)
}

# ---------------------------------------------------------------------------
# Что пишем
# ---------------------------------------------------------------------------
# Каждый ключ сверен с исходниками VS Code 1.131 (вшитая сборка) и 1.140/1.141.
function Get-HmBeginnerSettings {
    $s = [ordered]@{}
    # Прячет встроенный чат Copilot и все его входы: кнопку «Sign in» в заголовке окна,
    # пункт в меню аккаунтов, значок в строке состояния.
    $s['chat.disableAIFeatures'] = $true
    # Правая боковая панель по умолчанию скрыта. В ней поселились сразу три чата —
    # Copilot, Codex и боковая панель Claude, — и новичок писал не туда. Claude открывается
    # кнопкой ✳ над редактором (вкладкой) и профилем терминала ниже.
    $s['workbench.secondarySideBar.defaultVisibility'] = 'hidden'
    # Без всплывающих «Установить рекомендуемое расширение Python…». Предложение русского
    # языкового пакета этот ключ НЕ гасит (оно живёт отдельно) — и не должен.
    $s['extensions.ignoreRecommendations'] = $true
    # Без английской страницы Welcome при открытии папки.
    $s['workbench.startupEditor'] = 'none'
    # Доверие к папкам выключено — решение владельца 06.10 (строка A03 разбора). В «Restricted
    # Mode» VS Code молча гасил панель Claude (расширение объявляет, что в недоверенной папке
    # не работает) и задачи, а с 1.131 он даже не спрашивает: по умолчанию startupPrompt =
    # never. Решение принято в предположении, что иного пути нет. Он есть, но другой:
    # заранее доверить ТОЛЬКО HamidunStart и курс ключом нельзя (список доверенных папок VS
    # Code держит в своей базе состояния), зато настройка extensions.supportUntrustedWorkspaces
    # (документирована, область «приложение») снимает ограничение с одного расширения и
    # оставляет Restricted Mode для всего остального; в решение владельца это не вошло.
    $s['security.workspace.trust.enabled'] = $false
    return $s
}

# Вложенные члены: профиль терминала «Claude Code» кладётся ВНУТРЬ списка профилей человека.
# Не профиль по умолчанию — решение владельца: задачи и «Run Python File» идут через
# профиль по умолчанию, и Claude получал бы чужие команды.
#
# args — СТРОКОЙ, а не массивом, и это не прихоть. VS Code собирает командную строку через
# node-pty, который в массиве экранирует каждую кавычку как \" — cmd.exe этого не понимает,
# и ни одна форма с массивом не работает для имён профиля с & ^ ; , (проверено прогоном
# настоящей функции node-pty 1.141 + cmd.exe). Строка уходит в командную строку как есть:
# /s снимает внешние кавычки, а внутренние, удвоенные, оставляют путь целым при любых
# символах. На Windows VS Code принимает строку явно (terminalProfiles.ts: «isWindows ?
# profile.args : …»), цена — жёлтая волна «Expected array» в схеме, если открыть settings.json.
function Get-HmBeginnerNested {
    param([bool]$WithClaudeProfile, [string]$LauncherVar)
    if (-not $WithClaudeProfile) { return @() }
    return @(@{
        Parent = 'terminal.integrated.profiles.windows'
        Child  = 'Claude Code'
        Value  = [ordered]@{
            path         = '${env:windir}\System32\cmd.exe'
            args         = ('/d /s /k ""' + $LauncherVar + '""')
            icon         = 'sparkle'
            overrideName = $true
        }
    })
}

# Пояснение к строке лога «+ ключ = значение».
function Get-HmKeyNote {
    param([string]$Key)
    switch ($Key) {
        'chat.disableAIFeatures'                       { return 'встроенный чат Copilot скрыт: писать нужно в Claude' }
        'workbench.secondarySideBar.defaultVisibility' { return 'правая панель с чатами скрыта, Claude открывается кнопкой ✳ над файлом' }
        'extensions.ignoreRecommendations'             { return 'без всплывающих советов поставить расширения' }
        'workbench.startupEditor'                      { return 'без английской страницы Welcome' }
        'security.workspace.trust.enabled'             { return 'без «Restricted Mode»: панель Claude и задачи работают в любой папке' }
        'terminal.integrated.profiles.windows#Claude Code' { return 'в терминале VS Code появился профиль «Claude Code»' }
        'locale'                                       { return 'интерфейс VS Code на русском после перезапуска' }
    }
    return ''
}

# Дописать недостающее в JSONC-файл. $What — 'settings' или 'argv' (для отметки).
# Возвращает @{ Added; Kept; Written; Touched; Skipped; Reason; Restored }: Skipped=$true,
# когда файл НЕ обработан (ссылка, слишком большой, не разобрался, запись не удалась), —
# итоговая строка шага обязана об этом сказать, а не рапортовать «всё на месте».
function Update-HmJsoncFile {
    param([string]$Path, [System.Collections.IDictionary]$Wanted, $Nested = @(), $Marker, [string]$What,
          [string]$Anchor = '', [bool]$IncludeAnchor = $true, [string]$DefaultEol = "`r`n")
    $res = @{ Added = 0; Kept = 0; Written = $false; Touched = (New-Object System.Collections.Generic.List[string])
              Skipped = $false; Reason = ''; Restored = $false }
    $name = Split-Path -Leaf $Path
    $dir = Split-Path -Parent $Path

    $bad = Get-HmLinkOnPath $Path $Anchor $IncludeAnchor
    if ($bad) {
        $res.Skipped = $true; $res.Reason = 'путь ведёт по ссылке'
        Write-HmLog "  ${name}: путь ведёт по ссылке (symlink/junction/hardlink: $bad) — под правами администратора сквозь неё не пишу, оставляю как есть."
        return $res
    }
    $text = ''; $bom = $false
    if (Test-Path -LiteralPath $Path) {
        $len = (New-Object System.IO.FileInfo($Path)).Length
        if ($len -gt $script:HmMaxJsoncBytes) {
            $res.Skipped = $true; $res.Reason = "файл слишком большой ($([int]($len / 1024)) КБ)"
            Write-HmLog "  ${name}: файл слишком большой ($([int]($len / 1024)) КБ) — не разбираю, оставляю как есть."
            return $res
        }
        $rd = Read-HmTextFile $Path
        if (-not $rd.Ok) {
            $res.Skipped = $true; $res.Reason = $rd.Error
            Write-HmLog "  ${name}: $($rd.Error) — оставляю файл как есть."
            return $res
        }
        $text = $rd.Text; $bom = $rd.Bom
    }
    $shape = Get-HmJsoncShape $text
    if (-not $shape.Ok) {
        $res.Skipped = $true; $res.Reason = "разобрать файл не вышло ($($shape.Error))"
        Write-HmLog "  ${name}: разобрать файл не вышло ($($shape.Error)) — оставляю его как есть, VS Code работает со своими настройками."
        return $res
    }

    # Разбор по трём корзинам: уже есть (молча или «задан тобой»), раньше добавляли и теперь
    # нет (убрал человек — или файл откатили целиком), и новое.
    $fresh = New-Object System.Collections.Generic.List[object]
    $ourMissing = New-Object System.Collections.Generic.List[object]
    foreach ($k in $Wanted.Keys) {
        $id = $What + ':' + $k
        $ours = $Marker.Contains($id)
        if (Test-HmKeyCovered $shape.Keys $k) {
            # Записан нами в прошлый раз — молча; задан человеком — говорим, что не трогаем.
            if (-not $ours) { Write-HmLog "  = ${k}: уже задан тобой — не трогаю."; $res.Kept++ }
            $res.Touched.Add($k)
        }
        elseif ($ours) { $ourMissing.Add(@{ Kind = 'top'; Label = $k; Id = $id; Key = $k; Value = $Wanted[$k] }) }
        else { $fresh.Add(@{ Kind = 'top'; Label = $k; Id = $id; Key = $k; Value = $Wanted[$k] }) }
    }
    foreach ($n in $Nested) {
        $p = $n.Parent; $c = $n.Child; $nid = $p + '#' + $c; $id = $What + ':' + $nid
        $ours = $Marker.Contains($id)
        $label = "$p -> «$c»"
        $member = $null
        foreach ($m in $shape.Members) { if ($m.Name -ceq $p) { $member = $m; break } }
        if ($member) {
            if ($shape.Tokens[$member.ValStart].V -ne '{') {
                Write-HmLog "  = ${p}: задан тобой не списком — профиль «$c» не добавляю."; $res.Kept++
                continue
            }
            $childKeys = Get-HmNestedKeys $shape $member
            if ($childKeys -ccontains $c) {
                if (-not $ours) { Write-HmLog "  = ${p}: профиль «$c» у тебя уже есть — не трогаю."; $res.Kept++ }
                $res.Touched.Add($nid)
            }
            elseif ($ours) { $ourMissing.Add(@{ Kind = 'nested'; Label = $label; Id = $id; Nid = $nid; Parent = $p; Child = $c; Value = $n.Value; Member = $member }) }
            else { $fresh.Add(@{ Kind = 'nested'; Label = $label; Id = $id; Nid = $nid; Parent = $p; Child = $c; Value = $n.Value; Member = $member }) }
        }
        elseif (Test-HmKeyCovered $shape.Keys $p) {
            # Задан вложенной записью или через точку глубже — слить с ней по тексту нельзя.
            Write-HmLog "  = ${p}: задан тобой иначе — профиль «$c» не добавляю."; $res.Kept++
        }
        else {
            $item = @{ Kind = 'newparent'; Label = $label; Id = $id; Nid = $nid; Parent = $p; Child = $c; Value = $n.Value }
            if ($ours) { $ourMissing.Add($item) } else { $fresh.Add($item) }
        }
    }
    # Нет сразу нескольких наших ключей — это не «человек убрал по одному», а откат файла
    # целиком (синхронизация настроек, восстановленная копия, сброс): возвращаем их и говорим.
    if ($What -eq 'settings' -and $ourMissing.Count -ge 4) {
        Write-HmLog "  ${name}: нет сразу $($ourMissing.Count) ключей, которые установщик добавлял раньше, — похоже на откат файла целиком (синхронизация, копия) — возвращаю их."
        foreach ($it in $ourMissing) { $fresh.Add($it) }
        $res.Restored = $true
    }
    else {
        foreach ($it in $ourMissing) {
            Write-HmLog "  = $($it.Label): этого нет, а установщик раньше уже добавлял — считаю, что ты убрал сам, не возвращаю."
            $res.Kept++
        }
    }
    if ($fresh.Count -eq 0) { return $res }

    $topAdd = [ordered]@{}
    $nestAdd = New-Object System.Collections.Generic.List[object]
    foreach ($it in $fresh) {
        if ($it.Kind -eq 'top') { $topAdd[$it.Key] = $it.Value }
        elseif ($it.Kind -eq 'newparent') {
            if (-not $topAdd.Contains($it.Parent)) { $topAdd[$it.Parent] = [ordered]@{} }
            $topAdd[$it.Parent][$it.Child] = $it.Value
        }
        else { $nestAdd.Add($it) }
    }
    # Сначала корень (его вставки лежат ПОЗЖЕ по тексту), потом вложенные — от конца к началу:
    # так смещения токенов исходного разбора остаются верными для всех следующих вставок.
    $newText = $text
    if ($topAdd.Count -gt 0) { $newText = Add-HmJsoncKeys -Text $newText -Shape $shape -Entries $topAdd -DefaultEol $DefaultEol }
    foreach ($it in @($nestAdd | Sort-Object { $_.Member.ValEnd } -Descending)) {
        $entries = [ordered]@{}; $entries[$it.Child] = $it.Value
        $parentIndent = Get-HmLineIndent $text $shape.Tokens[$it.Member.KeyIdx].S
        $newText = Add-HmJsoncMembers -Text $newText -Shape $shape -OpenIdx $it.Member.ValStart -CloseIdx $it.Member.ValEnd -Entries $entries -DefaultEol $DefaultEol -ParentIndent $parentIndent
    }
    # Самопроверка до записи: новый текст разбирается, прежние ключи на месте, новые добавились.
    $check = Get-HmJsoncShape $newText
    $lost = -not $check.Ok
    if ($check.Ok) {
        foreach ($k in $shape.Keys) { if (-not $check.Keys.Contains($k)) { $lost = $true } }
        foreach ($k in $topAdd.Keys) { if (-not $check.Keys.Contains($k)) { $lost = $true } }
        foreach ($it in $fresh) {
            if ($it.Kind -eq 'top') { continue }
            $mem = $null
            foreach ($m in $check.Members) { if ($m.Name -ceq $it.Parent) { $mem = $m; break } }
            if (-not $mem -or -not ((Get-HmNestedKeys $check $mem) -ccontains $it.Child)) { $lost = $true }
        }
    }
    if ($lost) {
        $res.Skipped = $true; $res.Reason = 'после вставки файл не прошёл самопроверку'
        Write-HmLog "  ${name}: после вставки файл не прошёл самопроверку — ничего не записываю, файл прежний."
        return $res
    }
    if (-not (Test-Path -LiteralPath $dir)) {
        try { New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null }
        catch {
            $res.Skipped = $true; $res.Reason = "папку $dir создать не вышло"
            Write-HmLog "  ${name}: папку $dir создать не вышло ($(Get-HmReason $_.Exception)) — пропускаю."
            return $res
        }
    }
    $w = Write-HmFileSafely -Path $Path -Text $newText -Bom $bom -Backup $true -Anchor $Anchor -IncludeAnchor $IncludeAnchor
    if (-not $w.Ok) {
        $res.Skipped = $true; $res.Reason = "записать не вышло ($($w.Error))"
        Write-HmLog "  ${name}: записать не вышло ($($w.Error)) — файл остался прежним."
        return $res
    }
    foreach ($it in $fresh) {
        $tid = $it.Key
        if ($it.Kind -ne 'top') { $tid = $it.Nid }
        $note = Get-HmKeyNote $tid
        $val = ConvertTo-HmJsonLiteral $it.Value '' '' ' '
        if ($val.Length -gt 60) { $val = '{ ... }' }
        if ($it.Kind -eq 'top') { $line = "  + $($it.Key) = $val" } else { $line = "  + $($it.Label)" }
        if ($note) { $line += " ($note)" }
        Write-HmLog $line
        $res.Touched.Add($tid)
    }
    if ($w.Backup) { Write-HmLog "  Копия прежнего ${name}: $($w.Backup)" }
    $res.Added = $fresh.Count; $res.Written = $true
    return $res
}

# ---------------------------------------------------------------------------
# Русский интерфейс: "locale": "ru" в argv.json — ТОЛЬКО если языковой пакет уже на диске
# ---------------------------------------------------------------------------
# Без пакета locale=ru ничего не даёт, а сам пакет ставит конвейер расширений (не этот
# шаг). argv.json живёт в %USERPROFILE%\.vscode, а не в папке User с settings.json.
function Test-HmRuLanguagePack {
    param([string]$ExtDir)
    if (-not $ExtDir -or -not (Test-Path -LiteralPath $ExtDir)) { return $false }
    $rx = '^ms-ceintl\.vscode-language-pack-ru-\d'
    # Пакет, удалённый, но ещё не стёртый с диска, VS Code отмечает в .obsolete.
    $obsolete = @{}
    $obsPath = Join-Path $ExtDir '.obsolete'
    if (Test-Path -LiteralPath $obsPath) {
        try {
            $o = [System.IO.File]::ReadAllText($obsPath) | ConvertFrom-Json
            foreach ($p in $o.PSObject.Properties) { if ($p.Value) { $obsolete[$p.Name.ToLowerInvariant()] = $true } }
        } catch { }
    }
    $isLive = {
        param([string]$folder)
        if (-not $folder -or $folder -notmatch $rx) { return $false }
        if ($obsolete.ContainsKey($folder.ToLowerInvariant())) { return $false }
        return (Test-Path -LiteralPath (Join-Path (Join-Path $ExtDir $folder) 'package.json'))
    }
    # Источник правды у VS Code — extensions.json (реестр установленного); папка без
    # записи в нём не загрузится. Нет реестра (старый VS Code) — смотрим папки.
    $manifest = Join-Path $ExtDir 'extensions.json'
    if (Test-Path -LiteralPath $manifest) {
        $list = $null
        try { $list = @([System.IO.File]::ReadAllText($manifest) | ConvertFrom-Json) } catch { $list = $null }
        if ($null -ne $list) {
            foreach ($e in $list) {
                if ($e.identifier -and ([string]$e.identifier.id) -eq 'ms-ceintl.vscode-language-pack-ru') {
                    $folder = [string]$e.relativeLocation
                    if (-not $folder -and $e.location -and $e.location.path) { $folder = [System.IO.Path]::GetFileName([string]$e.location.path) }
                    if (& $isLive $folder) { return $true }
                }
            }
            return $false
        }
    }
    foreach ($d in @(Get-ChildItem -LiteralPath $ExtDir -Directory -ErrorAction SilentlyContinue)) {
        if (& $isLive $d.Name) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Лаунчер и ярлыки Claude Code
# ---------------------------------------------------------------------------
# Один .cmd на два входа: ярлык «Claude Code — мои проекты» (с ключом --projects уходит в
# %USERPROFILE%\HamidunStart) и профиль терминала VS Code (без ключа — остаётся в папке,
# открытой в редакторе). Лежит в %LOCALAPPDATA%\Programs\Hamidun, а не в HamidunStart:
# в папке проекта новичка не должно быть служебных файлов.
#
# БЕЗОПАСНОСТЬ: файл пишет процесс администратора, но ЗАПУСКАЕТ его только сам человек —
# двойным щелчком (explorer, обычные права) или из терминала VS Code. Этот скрипт его не
# исполняет ни в каком виде: пользовательский .cmd под правами администратора — ровно та
# эскалация, которую закрывают _deelev.ps1 и запуск токеном оболочки в mascot.ps1 и main.js.
#
# claude ищется ТОЛЬКО по PATH. cmd для голого имени сначала смотрит ТЕКУЩУЮ папку, а профиль
# терминала стартует в папке, открытой в редакторе (при выключенном доверии — в любом
# скачанном репозитории): лежащий там claude.bat исполнился бы вместо настоящего. Поэтому
# NoDefaultCurrentDirectoryInExePath (cwd не участвует в поиске самого cmd) и проверка
# `where $PATH:claude` вместо `where claude`: без $PATH: `where` текущую папку смотрит всегда.
# Порядок поиска остаётся родным для cmd (каталог за каталогом по PATH, расширения по
# PATHEXT), как у человека, который набрал claude сам.
#
# Строки до chcp — только ASCII: cmd читает файл построчно и до смены кодовой страницы
# понимает только её. BOM не пишем: cmd спотыкается на нём в первой строке.
# call перед claude обязателен: npm ставит claude.cmd, а переход в другой .cmd без call
# не возвращается назад, и строка с pause не выполнилась бы никогда.
function Get-HmClaudeLauncherText {
    return (@(
        '@echo off',
        'set "NoDefaultCurrentDirectoryInExePath=1"',
        'chcp 65001 >nul',
        'rem Claude Code: лаунчер установщика Hamidun.',
        'rem Ярлык «Claude Code — мои проекты» зовёт его с ключом --projects (папка HamidunStart),',
        'rem профиль терминала «Claude Code» в VS Code — без ключа (папка, открытая в редакторе).',
        'set "PATH=%USERPROFILE%\.local\bin;%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH%"',
        'if /i "%~1"=="--projects" (',
        '  if not exist "%USERPROFILE%\HamidunStart\" mkdir "%USERPROFILE%\HamidunStart"',
        '  cd /d "%USERPROFILE%\HamidunStart"',
        ')',
        'title Claude Code',
        'where $PATH:claude >nul 2>nul',
        'if errorlevel 1 goto noclaude',
        'call claude',
        'if errorlevel 1 pause',
        'goto :eof',
        ':noclaude',
        'echo Команды claude на этом компьютере пока нет.',
        'echo Запусти установщик Hamidun ещё раз и отметь компонент «Claude Code».',
        'echo.',
        'pause'
    ) -join "`r`n") + "`r`n"
}

# Лаунчер на диск. Ok — лаунчер на месте (записан сейчас или уже был таким же); Changed —
# записан сейчас; Problem — что сказать в итоговой строке, если не вышло.
function Install-HmClaudeLauncher {
    param([string]$LauncherDir, [string]$Launcher, [string]$Anchor = '')
    $res = @{ Ok = $false; Changed = $false; Problem = '' }
    $hit = Get-HmLinkOnPath $Launcher $Anchor $true
    if ($hit) {
        $res.Problem = 'лаунчер Claude Code — путь ведёт по ссылке'
        Write-HmLog "  Лаунчер Claude Code: путь ведёт по ссылке (symlink/junction/hardlink: $hit) — под правами администратора туда не пишу; ярлык и профиль терминала пропускаю."
        return $res
    }
    $want = Get-HmClaudeLauncherText
    if (Test-Path -LiteralPath $Launcher) {
        $rd = Read-HmTextFile $Launcher
        if ($rd.Ok -and $rd.Text -ceq $want) { $res.Ok = $true; return $res }
    }
    if (-not (Test-Path -LiteralPath $LauncherDir)) {
        try { New-Item -ItemType Directory -Force -Path $LauncherDir -ErrorAction Stop | Out-Null }
        catch {
            $res.Problem = 'лаунчер Claude Code — папку создать не вышло'
            Write-HmLog "  Лаунчер Claude Code: папку $LauncherDir создать не вышло ($(Get-HmReason $_.Exception)) — ярлык и профиль терминала пропускаю."
            return $res
        }
    }
    $w = Write-HmFileSafely -Path $Launcher -Text $want -Bom $false -Backup $false -Anchor $Anchor -IncludeAnchor $true
    if (-not $w.Ok) {
        $res.Problem = "лаунчер Claude Code — записать не вышло ($($w.Error))"
        Write-HmLog "  Лаунчер Claude Code: записать не вышло ($($w.Error)) — ярлык и профиль терминала пропускаю."
        return $res
    }
    Write-HmReceipt $Launcher
    $res.Ok = $true; $res.Changed = $true
    return $res
}

# Ярлык на лаунчер: только если его нет и человек его раньше не удалял (отметка
# shortcut:<id>). Создание файла .lnk НИЧЕГО не запускает; флаг «запускать от имени
# администратора» WScript.Shell не ставит, и мы его не трогаем. State: created | exists |
# removed (убран человеком) | skipped (Error — почему).
function Set-HmClaudeShortcut {
    param([string]$Id, [string]$Dir, [string]$Launcher, [string]$WorkDir, $Marker, [string]$Anchor, [bool]$IncludeAnchor,
          [string]$ProfileDir = '', [string]$Why = '')
    # Папка не прошла проверку профиля уже при сборке путей (Get-HmPaths) — причина пришла в $Why.
    if (-not $Dir) {
        $e = 'папка не определена'
        if ($Why) { $e = $Why }
        return @{ State = 'skipped'; Path = ''; Error = $e }
    }
    # Проверка на месте использования: пути могли собрать где и когда угодно, а папка за это время
    # могла стать ссылкой. Сверяем с профилем (список профилей Windows), а не с переменной окружения.
    $kind = 'Desktop'
    if ($Id -eq 'programs') { $kind = 'Programs' }
    $vf = Test-HmShellFolder -ProfileDir $ProfileDir -Candidate $Dir -Kind $kind
    if (-not $vf.Ok) { return @{ State = 'skipped'; Path = ''; Error = $vf.Reason } }
    if (-not (Test-Path -LiteralPath $Dir)) { return @{ State = 'skipped'; Path = ''; Error = "папки $Dir нет" } }
    $lnk = Join-Path $Dir $script:HmLnkName
    $hit = Get-HmLinkOnPath $lnk $Anchor $IncludeAnchor
    if ($hit) { return @{ State = 'skipped'; Path = $lnk; Error = "путь ведёт по ссылке ($hit), под правами администратора туда не пишу" } }
    if (Test-Path -LiteralPath $lnk) { return @{ State = 'exists'; Path = $lnk; Error = '' } }
    if ($Marker.Contains('shortcut:' + $Id)) { return @{ State = 'removed'; Path = $lnk; Error = '' } }
    try {
        # Поля ярлыка — блоком: сам ярлык New-HmShortcutFile сохраняет под случайным именем во временной
        # папке и переносит на место одним Move. Save() прямо по этому пути писал бы сквозь ссылку,
        # подложенную на имя ярлыка; перед Move там же повторяется проверка папки (Test-HmShellFolder).
        $fill = {
            param($sc)
            $sc.TargetPath = $Launcher
            $sc.Arguments = '--projects'
            $sc.WorkingDirectory = $WorkDir
            $sc.IconLocation = (Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe') + ',0'
            $sc.Description = 'Открыть Claude Code в папке HamidunStart'
        }.GetNewClosure()
        # Перепроверка перед записью, как и раньше (LinkType); она не видит junction, у которой владелец
        # запретил чтение на самой ссылке, — её видит проверка по атрибуту и тегу внутри New-HmShortcutFile.
        $hit = Get-HmLinkOnPath $lnk $Anchor $IncludeAnchor
        if ($hit) { return @{ State = 'skipped'; Path = $lnk; Error = "путь стал ссылкой ($hit)" } }
        [void](New-HmShortcutFile -Dir $Dir -Name $script:HmLnkName -Fill $fill -ProfileDir $ProfileDir)
        return @{ State = 'created'; Path = $lnk; Error = '' }
    } catch {
        $ex = $_.Exception
        $why = Get-HmReason $ex
        if ($ex -is [System.InvalidOperationException]) { $why = $ex.Message }   # наша причина, уже по-русски
        return @{ State = 'skipped'; Path = $lnk; Error = $why }
    }
}

# ---------------------------------------------------------------------------
# Главное
# ---------------------------------------------------------------------------
function Test-HmVsCodeInstalled {
    param($Paths = $null)
    if ($null -eq $Paths) { $Paths = Get-HmPaths }
    foreach ($e in @((Join-Path $Paths.LocalAppData 'Programs\Microsoft VS Code\Code.exe'),
                     (Join-Path $Paths.ProgramFiles 'Microsoft VS Code\Code.exe'))) {
        if ($e -and (Test-Path -LiteralPath $e)) { return $true }
    }
    return $false
}

# Сама работа. Результат: Changed — что-то записано (кроме отметки); Parts — что именно,
# для строки «ОБНОВЛЕНО»; Problems — что НЕ удалось применить и почему; Added/Kept — счётчики
# ключей; Shortcuts — созданные ярлыки. Подробности идут в журнал (Write-HmLog).
function Invoke-HmVsCodeSetup {
    param($Paths)
    $r = @{ Changed = $false; Added = 0; Kept = 0
            Parts = (New-Object System.Collections.Generic.List[string])
            Problems = (New-Object System.Collections.Generic.List[string])
            Shortcuts = (New-Object System.Collections.Generic.List[string]) }
    $userDir = Join-Path $Paths.AppData 'Code\User'
    $dotVsCode = Join-Path $Paths.Profile '.vscode'
    $launcherDir = Join-Path $Paths.LocalAppData 'Programs\Hamidun'
    $launcher = Join-Path $launcherDir 'claude-code.cmd'
    $markerPath = Join-Path $userDir '.hamidun-applied.json'
    $marker = Read-HmAppliedMarker $markerPath
    $touched = New-Object System.Collections.Generic.List[string]
    $timeUp = $false

    # 1) Лаунчер — первым: без него профиль терминала и ярлык вели бы в пустоту.
    $lr = Install-HmClaudeLauncher -LauncherDir $launcherDir -Launcher $launcher -Anchor $Paths.LocalAppData
    if ($lr.Problem) { $r.Problems.Add($lr.Problem) }
    if ($lr.Changed) { $r.Changed = $true; $r.Parts.Add('лаунчер Claude Code') }
    if (Test-HmPastDeadline) { $timeUp = $true }

    # 2) settings.json
    if (-not $timeUp) {
        $launcherVar = '${env:LOCALAPPDATA}\Programs\Hamidun\claude-code.cmd'
        $sr = Update-HmJsoncFile -Path (Join-Path $userDir 'settings.json') -Wanted (Get-HmBeginnerSettings) `
            -Nested @(Get-HmBeginnerNested -WithClaudeProfile $lr.Ok -LauncherVar $launcherVar) `
            -Marker $marker -What 'settings' -Anchor $Paths.AppData -IncludeAnchor $true
        foreach ($k in $sr.Touched) { $touched.Add('settings:' + $k) }
        $r.Added += $sr.Added; $r.Kept += $sr.Kept
        if ($sr.Skipped) { $r.Problems.Add("settings.json — $($sr.Reason)") }
        if ($sr.Written) {
            $r.Changed = $true
            $txt = "настройки VS Code (+$($sr.Added))"
            if ($sr.Restored) { $txt += ', возвращены после отката файла' }
            $r.Parts.Add($txt)
        }
        if (Test-HmPastDeadline) { $timeUp = $true }
    }

    # 3) argv.json — русский интерфейс
    if (-not $timeUp) {
        if (Test-HmRuLanguagePack (Join-Path $dotVsCode 'extensions')) {
            $ar = Update-HmJsoncFile -Path (Join-Path $dotVsCode 'argv.json') -Wanted ([ordered]@{ locale = 'ru' }) `
                -Marker $marker -What 'argv' -Anchor $Paths.Profile -IncludeAnchor $false
            foreach ($k in $ar.Touched) { $touched.Add('argv:' + $k) }
            $r.Added += $ar.Added; $r.Kept += $ar.Kept
            if ($ar.Skipped) { $r.Problems.Add("argv.json — $($ar.Reason)") }
            if ($ar.Written) { $r.Changed = $true; $r.Parts.Add('русский интерфейс VS Code') }
        } else {
            Write-HmLog "  Русского языкового пакета VS Code на диске нет — язык интерфейса не трогаю."
        }
        if (Test-HmPastDeadline) { $timeUp = $true }
    }

    # 4) Ярлыки (только при исправном лаунчере)
    if (-not $timeUp -and $lr.Ok) {
        $targets = @(
            @{ Id = 'desktop'; Title = 'Рабочий стол'; Dir = $Paths.Desktop; Why = $Paths.DesktopWhy; Anchor = $Paths.Profile; Inc = $false },
            @{ Id = 'programs'; Title = 'меню Пуск'; Dir = $Paths.Programs; Why = $Paths.ProgramsWhy; Anchor = $Paths.AppData; Inc = $true }
        )
        foreach ($tg in $targets) {
            $sc = Set-HmClaudeShortcut -Id $tg.Id -Dir $tg.Dir -Why $tg.Why -ProfileDir $Paths.ShellProfile -Launcher $launcher -WorkDir $Paths.Profile -Marker $marker -Anchor $tg.Anchor -IncludeAnchor $tg.Inc
            switch ($sc.State) {
                'created' { $touched.Add('shortcut:' + $tg.Id); $r.Changed = $true; $r.Shortcuts.Add($tg.Title); Write-HmLog "  Ярлык: $($sc.Path)"; Write-HmReceipt $sc.Path }
                'exists'  { $touched.Add('shortcut:' + $tg.Id) }
                'removed' { Write-HmLog "  Ярлык ($($tg.Title)): тебя он, похоже, не устроил (удалён после прошлой установки) — не возвращаю." }
                default   { Write-HmLog "  Ярлык ($($tg.Title)) пропущен: $($sc.Error)."; $r.Problems.Add("ярлык ($($tg.Title)) — $($sc.Error)") }
            }
        }
        if ($r.Shortcuts.Count -gt 0) { $r.Parts.Add("ярлык «Claude Code — мои проекты» ($($r.Shortcuts -join ', '))") }
    }
    if ($timeUp) { $r.Problems.Add('не уложился во время, остальное при следующей проверке') }

    # 5) Отметка — только когда в ней что-то новое: повторный прогон без изменений файл не трогает.
    $grew = $false
    foreach ($t in $touched) { if ($marker.Add($t)) { $grew = $true } }
    if ($grew) {
        $mw = Write-HmAppliedMarker -Path $markerPath -Set $marker -Anchor $Paths.AppData
        if (-not $mw.Ok) {
            Write-HmLog "  Отметку о записанном сохранить не вышло ($($mw.Error)) — при повторной проверке убранное тобой может вернуться."
        }
    }
    return $r
}

# Подробный ход — из vscode.ps1. Пути — параметром: тесты гоняют функцию в песочнице.
function Invoke-HmVsCodeFirstRun {
    param($Paths = $null)
    if ($null -eq $Paths) { $Paths = Get-HmPaths }
    if ($env:HM_DRY_RUN) {
        $userDir = Join-Path $Paths.AppData 'Code\User'
        Write-Host "  [dry-run] WOULD: дописать недостающие ключи в $userDir\settings.json (chat.disableAIFeatures, workbench.secondarySideBar.defaultVisibility, extensions.ignoreRecommendations, workbench.startupEditor, security.workspace.trust.enabled, профиль терминала «Claude Code»), заданные человеком не трогать, копия перед записью"
        Write-Host "  [dry-run] WOULD: locale=ru в $(Join-Path $Paths.Profile '.vscode\argv.json') — только если русский языковой пакет уже стоит"
        Write-Host "  [dry-run] WOULD: лаунчер $(Join-Path $Paths.LocalAppData 'Programs\Hamidun\claude-code.cmd') и ярлык «Claude Code — мои проекты» (рабочий стол, меню Пуск); ничего не запускать"
        return
    }
    Write-Host "Настройки VS Code для новичка: прячу встроенный чат Copilot, выключаю Restricted Mode и всплывающие советы, добавляю Claude Code в терминал и ярлык."
    $r = Invoke-HmVsCodeSetup -Paths $Paths

    $tail = ''
    if ($r.Shortcuts.Count -gt 0) { $tail = ' Ярлык «Claude Code — мои проекты» открывает Claude в папке HamidunStart.' }
    if ($r.Problems.Count -gt 0) {
        # Честный итог: ни слова «всё на месте» там, где что-то не применилось.
        Write-Host "Настройки VS Code для новичка: применены не полностью — $($r.Problems -join '; '). Редактор работает; то, что не применилось, останется как было (причины выше). Пришли этот журнал в поддержку.$tail"
    }
    elseif ($r.Added -eq 0 -and $r.Kept -eq 0) { Write-Host "Настройки VS Code для новичка: всё уже на месте, файлы настроек не менял.$tail" }
    else { Write-Host "Настройки VS Code для новичка: добавлено $($r.Added), оставлено как было $($r.Kept).$tail" }
}

# Тихий ход — из touchup-vscode.ps1. Возвращает ОДНУ строку для вывода или '' (выводить
# нечего). Контракт: без сети, ~5 с потолок, идемпотентно (второй прогон молчит), делает
# что-либо ТОЛЬКО если VS Code есть на диске.
function Invoke-HmVsCodeTouchup {
    $script:HmQuiet = $true
    $script:HmLogLines.Clear()
    $script:HmDeadline = (Get-Date).AddMilliseconds(4500)
    try {
        if ($env:HM_DRY_RUN) { return '' }
        $paths = Get-HmPaths
        if (-not (Test-HmVsCodeInstalled $paths)) { return '' }
        $r = Invoke-HmVsCodeSetup -Paths $paths
        if ($r.Changed) {
            $line = 'ОБНОВЛЕНО: ' + ($r.Parts -join ', ')
            if ($r.Problems.Count -gt 0) { $line += '; пропущено: ' + ($r.Problems -join '; ') }
            return $line
        }
        if ($r.Problems.Count -gt 0) { return '[touchup-vscode] пропущено: ' + ($r.Problems -join '; ') }
        return ''
    }
    finally {
        $script:HmQuiet = $false
        $script:HmDeadline = $null
    }
}

# Точка входа. При dot-source (тесты, touchup) — только функции, иначе exit оборвал бы
# вызывающего. exit 0 — всегда: шаг необязательный, а код выхода самого шага VS Code задаёт
# vscode.ps1 (exit внутри скрипта, вызванного из finally, его exit не перебивает — проверено
# на PS 5.1).
if ($MyInvocation.InvocationName -ne '.') {
    $hmPaths = Get-HmPaths
    if (-not (Test-HmVsCodeInstalled $hmPaths)) {
        Write-Host "Настройки VS Code для новичка: редактора на этом компьютере нет — пропускаю."
    } else {
        try { Invoke-HmVsCodeFirstRun -Paths $hmPaths }
        catch { Write-Host "Настройки VS Code для новичка: шаг остановлен ($(Get-HmReason $_.Exception)) — редактор работает и без них." }
    }
    exit 0
}
