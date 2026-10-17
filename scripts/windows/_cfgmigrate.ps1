# _cfgmigrate.ps1 — бережная правка ~/.claude/settings.json у тех, кто ставил раньше,
# плюс опись того, что встало (CATALOG.md и config-summary.json) и карта конфига для Codex
# (AGENTS.md пака → ~/.codex/AGENTS.md, в самом конце файла).
# Дот-сорсится из config.ps1 (после раскладки конфига) и из verify.ps1 (на КАЖДОМ прогоне,
# когда config не ставился, — иначе до людей с уже поставленным конфигом правка не дойдёт:
# повторный запуск снимает галочку со всего найденного на диске). Библиотека: кода верхнего
# уровня и своего exit нет.
#
# ЗАЧЕМ. Обычный повторный запуск существующий settings.json не трогает (add-missing в
# config.ps1), а «Переустановить начисто» перезаписывает его целиком свежим паком. Поэтому
# исправления пака до людей, поставивших раньше, не доходили вовсе: у них оставались
# плагины, которые без токена падают на каждом старте («N MCP servers need
# authentication»), Semgrep, требующий входа после каждой записи файла, hookify, который
# на каждый вызов зовёт python3 (на Windows это заглушка Магазина — «hook error» в каждом
# ответе), правила, на которые Claude Code ругается при каждом запуске, HTTP-хуки с
# незаполненным VSCODE_PORT («Settings Error … Invalid URL») и раздел mcpServers,
# который в settings.json не читается.
#
# Цель — сойтись с тем, что получает свежая установка: пак 5cf4a39 приводит к этим
# значениям свой settings.json скриптом guard_student_defaults.py (--apply), и правила
# ниже повторяют его. Плюс то, что из пака ушло раньше и осталось только у старых
# установок: Semgrep и коннекторы июня–августа, хуки VSCODE_PORT, раздел mcpServers,
# MCP_TIMEOUT=30000 (пак 19.08–06.09; сейчас 120000).
#
# Меняем ТОЛЬКО эти известные дефекты. Модель, effort, режим разрешений, свои хуки и
# остальные правила человека не трогаем. Перед записью — копия файла рядом. Файл не
# разобрался как JSON-объект — не трогаем вовсе. Текст пишем своим сериализатором в
# формате JSON.stringify(…, null, 2) — в нём же файл и лежит в паке. ConvertTo-Json из
# Windows PowerShell 5.1 переписал бы весь файл по-своему: угловые скобки и амперсанд
# кодами, лишние пробелы после двоеточия, обрезка вложенности на глубине 2.
#
# Скрипт идёт под администратором, а пишет в каталоги, доступные обычному пользователю
# (~/.claude, ~/.hamidun-setup). Поэтому: ни одна запись не идёт «сквозь» ссылку (junction
# или symlink на каталоге или файле — проверка повторяется непосредственно перед записью),
# копия создаётся режимом CreateNew (падает на любом занятом имени, в том числе на ссылке),
# а сам файл пишется во временный CreateNew-файл и переносится поверх целевого.
. (Join-Path $PSScriptRoot '_userpath.ps1')   # Test-HmIsReparse, Write-HmFileSafe

# Плагины, которые без токена или входа падают при запуске Claude Code, блокируют запись
# файлов или шумят на каждом ответе. Первые восемь — PLUGINS_OFF из guard_student_defaults.py
# пака (hookify — шумит python3 на каждый вызов). Остальные — то, что пак июня–августа
# (до 17.07 и до 03.08) отдавал ВКЛЮЧЁННЫМ, а потом убрал, и у ранних установок оно осталось:
# semgrep, а также коннекторы slack, sentry, figma, huggingface-skills, legalzoom,
# adspirer-ads-agent — у каждого удалённый MCP-сервер со своим входом (OAuth/логин), без
# которого он только пишет «needs authentication». Список сверен по истории
# .claude/settings.json пака (git log), а не по памяти. Идентификаторы — с суффиксом
# @claude-plugins-official.
$HmOffPlugins = @('greptile', 'sourcegraph', 'coderabbit', 'github', 'linear', 'notion', 'telegram',
                  'hookify', 'semgrep',
                  'slack', 'sentry', 'figma', 'huggingface-skills', 'legalzoom', 'adspirer-ads-agent')
# Значения по умолчанию, которые человек вправе поменять: к его СОБСТВЕННОМУ файлу они
# применяются один раз. Включил плагин обратно (поставил токен) или вернул опрос —
# повторный запуск установщика это не откатит. Правила-«близнецы», хуки VSCODE_PORT и
# mcpServers, наоборот, проверяются по содержимому при каждом запуске.
$HmDefaultsStepId = 'student-defaults-2026-10'

function ConvertTo-HmJsonString([string]$s) {
    $e = $s.Replace('\', '\\').Replace('"', '\"')
    $e = [regex]::Replace($e, '[\x00-\x1F]', [System.Text.RegularExpressions.MatchEvaluator] {
            param($m)
            $c = [int][char]$m.Value
            if ($c -eq 8) { return '\b' }
            if ($c -eq 9) { return '\t' }
            if ($c -eq 10) { return '\n' }
            if ($c -eq 12) { return '\f' }
            if ($c -eq 13) { return '\r' }
            return ('\u{0:x4}' -f $c)
        })
    return '"' + $e + '"'
}

# Значение из ConvertFrom-Json → текст JSON с отступом 2 пробела и "\n" между строками.
function ConvertTo-HmJsonText {
    param($Value, [int]$Level = 0)
    $pad = '  ' * $Level
    $pad1 = '  ' * ($Level + 1)
    if ($Value -is [array]) {
        if ($Value.Count -eq 0) { return '[]' }
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($it in $Value) { $parts.Add($pad1 + (ConvertTo-HmJsonText -Value $it -Level ($Level + 1))) }
        return "[`n" + ($parts -join ",`n") + "`n" + $pad + ']'
    }
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [string]) { return (ConvertTo-HmJsonString $Value) }
    if ($Value -is [double] -or $Value -is [single]) {
        if ([double]::IsNaN($Value) -or [double]::IsInfinity($Value)) { return 'null' }
        return ([double]$Value).ToString('R', [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [decimal] -or $Value -is [int16] -or
        $Value -is [byte] -or $Value -is [uint32] -or $Value -is [uint64]) {
        return ([System.IFormattable]$Value).ToString($null, [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $props = @($Value.PSObject.Properties)
        if ($props.Count -eq 0) { return '{}' }
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($p in $props) {
            $parts.Add($pad1 + (ConvertTo-HmJsonString $p.Name) + ': ' + (ConvertTo-HmJsonText -Value $p.Value -Level ($Level + 1)))
        }
        return "{`n" + ($parts -join ",`n") + "`n" + $pad + '}'
    }
    throw ('непредусмотренный тип значения в JSON: ' + $Value.GetType().FullName)
}

# Правило, на которое Claude Code ругается при КАЖДОМ запуске, и чем его заменить; $null —
# правило в порядке. Повторяет warned_rule из guard_student_defaults.py пака, а тот —
# валидатор правил claude.exe 2.1.283 (проверено запуском `claude -p` без входа на файлах всех
# версий пака: предупреждают именно эти две формы; `mcp__*` в allow — нет, его не трогаем):
#   • путь в правиле Write/MultiEdit/NotebookEdit/Glob: доступ к файлам проверяется только
#     правилами Edit(путь) и Read(путь), такое правило не применяется никогда. Замена —
#     «близнец» Edit(…)/Read(…). Tool(*) означает весь инструмент — его не трогаем;
#   • Bash-правило, где * смешана с устаревшим хвостом :* — сравнивается буквально и не
#     срабатывает. В deny/ask замена — форма, которую советует сам Claude Code (:* -> *);
#     в allow не трогаем: там выбор за человеком.
# КУДА применять замену решает Invoke-HmSettingsFixes (см. там): в allow она ЗАПРЕЩЕНА, если
# «близнеца» ещё нет, — иначе неработающее правило стало бы работающим разрешением.
function Get-HmWarnedRuleFix([string]$Rule, [string]$List) {
    if ($Rule -cmatch '^(Write|MultiEdit|NotebookEdit|Glob)\(([\s\S]*)\)$') {
        $tool = $Matches[1]; $content = $Matches[2]
        if ($content -eq '*' -or $content.Contains(':*')) { return $null }
        $twin = if ($tool -ceq 'Glob') { 'Read' } else { 'Edit' }
        return $twin + '(' + $content + ')'
    }
    if ($Rule -cmatch '^Bash\(([\s\S]*)\)$') {
        $content = $Matches[1]
        if ($content.EndsWith(':*')) {
            $prefix = $content.Substring(0, $content.Length - 2).TrimEnd()
            if ($prefix.Contains('*') -and $List -cne 'allow') { return 'Bash(' + $prefix + '*)' }
        }
    }
    return $null
}

# Чистая часть: правит РАЗОБРАННЫЙ settings.json на месте и возвращает список сделанного
# (строки для журнала). $Defaults — применять ли шаг значений по умолчанию (плагины, опрос).
# $Hints — сюда складываются подсказки о том, что НЕ менялось (их печатает вызывающий, на
# решение «писать ли файл» они не влияют).
function Invoke-HmSettingsFixes {
    param([Parameter(Mandatory = $true)]$Settings, [bool]$Defaults,
          [System.Collections.Generic.List[string]]$Hints)
    $done = New-Object System.Collections.Generic.List[string]
    $isObj = { param($v) $v -is [System.Management.Automation.PSCustomObject] }

    if ($Defaults) {
        # 1. Плагины: только точное значение true -> false.
        $ep = $Settings.PSObject.Properties['enabledPlugins']
        if ($ep -and (& $isObj $ep.Value)) {
            $off = New-Object System.Collections.Generic.List[string]
            foreach ($name in $HmOffPlugins) {
                $p = $ep.Value.PSObject.Properties[$name + '@claude-plugins-official']
                if ($p -and ($p.Value -is [bool]) -and $p.Value) { $p.Value = $false; $off.Add($name) }
            }
            if ($off.Count -gt 0) {
                $done.Add('выключил плагины ' + ($off -join ', ') + ' — без токена или входа они падают при запуске Claude Code, hookify шумит ошибкой в каждом ответе (включить обратно: /plugin)')
            }
        }
        # 2. Опрос «How is Claude doing this session?» и просьба прислать переписку сбивали
        #    новичков посреди работы. Документированный выключатель — только если не задан.
        $envP = $Settings.PSObject.Properties['env']
        if (-not $envP) {
            $Settings | Add-Member -NotePropertyName 'env' -NotePropertyValue ([pscustomobject]@{})
            $envP = $Settings.PSObject.Properties['env']
        }
        if ((& $isObj $envP.Value) -and -not $envP.Value.PSObject.Properties['CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY']) {
            $envP.Value | Add-Member -NotePropertyName 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY' -NotePropertyValue '1'
            $done.Add('выключил опрос «How is Claude doing this session?» (env CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1)')
        }
        # 2б. MCP_TIMEOUT: пак с 19.08 по 06.09 отдавал 30000 мс, потом вернул 120000 — npx на холодном
        #     кэше качает пакет MCP-сервера дольше 30 секунд, и сервер «не подключался». У ранних
        #     установок осталось 30000. Поднимаем ТОЛЬКО ровно строку "30000": любое другое значение
        #     (и число, и чужая строка) человек выбрал сам. Шаг одноразовый, как и остальные значения
        #     по умолчанию: вернёт 30000 обратно — повторный запуск его не тронет.
        $mt = $null
        if (& $isObj $envP.Value) { $mt = $envP.Value.PSObject.Properties['MCP_TIMEOUT'] }
        if ($mt -and ($mt.Value -is [string]) -and ($mt.Value -ceq '30000')) {
            $mt.Value = '120000'
            $done.Add('поднял env MCP_TIMEOUT с 30000 до 120000 мс — MCP-серверы на холодном кэше npx стартуют дольше 30 секунд')
        }
    }

    # 3. Правила разрешений, на которые Claude Code ругается при каждом запуске.
    #    • allow: правило с путём в Write/MultiEdit/NotebookEdit/Glob сейчас НЕ ДЕЙСТВУЕТ. Если
    #      «близнец» (Edit/Read с тем же путём) уже есть в списке — убираем лишнее, права не
    #      меняются. Если нет — НЕ трогаем и подсказываем: замена превратила бы неработающее
    #      правило в работающее разрешение, которого у человека на деле нет, а решать это ему.
    #    • deny и ask: заменяем «близнецом» на том же месте — запрет и вопрос только
    #      ужесточаются (правило, которое не срабатывало, начинает срабатывать).
    $perm = $Settings.PSObject.Properties['permissions']
    if ($perm -and (& $isObj $perm.Value)) {
        foreach ($listName in @('allow', 'deny', 'ask')) {
            $lp = $perm.Value.PSObject.Properties[$listName]
            if (-not $lp -or -not ($lp.Value -is [array])) { continue }
            $orig = @($lp.Value)
            $out = New-Object System.Collections.Generic.List[object]
            $notes = New-Object System.Collections.Generic.List[string]
            foreach ($r in $orig) {
                $fix = $null
                if ($r -is [string]) { $fix = Get-HmWarnedRuleFix -Rule $r -List $listName }
                if (-not $fix) { $out.Add($r); continue }
                if (($orig -ccontains $fix) -or $out.Contains($fix)) {
                    $notes.Add($r + ' убрал (' + $fix + ' уже есть)')
                    continue
                }
                if ($listName -ceq 'allow') {
                    $out.Add($r)
                    if ($null -ne $Hints) {
                        $Hints.Add('permissions.allow: ' + $r + ' не действует — для файлов Claude Code читает только ' + $fix + '. Оставил как есть: замена выдала бы разрешение, которого сейчас нет. Нужен доступ — замени сам на ' + $fix + '.')
                    }
                    continue
                }
                $out.Add($fix)
                $notes.Add($r + ' → ' + $fix)
            }
            if ($notes.Count -gt 0) {
                $lp.Value = $out.ToArray()
                $why = if ($listName -ceq 'allow') { 'это дубли правил, которые Claude Code и так не применял (рабочий близнец уже в списке) — права не изменились' }
                       else { 'такое правило не срабатывало и Claude Code предупреждал о нём при каждом запуске; теперь оно действует (запрет или вопрос — только строже)' }
                $done.Add('permissions.' + $listName + ': ' + ($notes -join '; ') + ' — ' + $why)
            }
        }
    }

    # 4. HTTP-хуки с незаполненным адресом VSCODE_PORT (http://127.0.0.1:VSCODE_PORT/hook):
    #    Claude Code отвергает такой URL целиком — «Settings Error», меню «Fix with Claude».
    #    Опустевшую группу и опустевшее событие убираем вместе с хуком; чужие хуки целы.
    $hooks = $Settings.PSObject.Properties['hooks']
    if ($hooks -and (& $isObj $hooks.Value)) {
        $removed = 0
        foreach ($ev in @($hooks.Value.PSObject.Properties)) {
            if (-not ($ev.Value -is [array])) { continue }
            $groupsOut = New-Object System.Collections.Generic.List[object]
            $evChanged = $false
            foreach ($g in $ev.Value) {
                $hp = $null
                if (& $isObj $g) { $hp = $g.PSObject.Properties['hooks'] }
                if (-not $hp -or -not ($hp.Value -is [array])) { $groupsOut.Add($g); continue }
                $keep = New-Object System.Collections.Generic.List[object]
                foreach ($h in $hp.Value) {
                    $url = ''
                    if ((& $isObj $h) -and $h.PSObject.Properties['url']) { $url = [string]$h.PSObject.Properties['url'].Value }
                    if ($url -match 'VSCODE_PORT') { $removed++; $evChanged = $true } else { $keep.Add($h) }
                }
                if ($keep.Count -eq @($hp.Value).Count) { $groupsOut.Add($g); continue }
                if ($keep.Count -gt 0) { $hp.Value = $keep.ToArray(); $groupsOut.Add($g) }
            }
            if ($evChanged) {
                if ($groupsOut.Count -gt 0) { $ev.Value = $groupsOut.ToArray() }
                else { $hooks.Value.PSObject.Properties.Remove($ev.Name) }
            }
        }
        if ($removed -gt 0) {
            $done.Add("убрал HTTP-хуки с незаполненным адресом VSCODE_PORT ($removed шт.) — из-за них Claude Code показывал «Settings Error»")
        }
    }

    # 5. Раздел mcpServers: Claude Code читает MCP-серверы из ~/.claude.json и .mcp.json,
    #    в settings.json он мёртв (пак убрал его 06.09). Копия остаётся в бэкапе.
    $mcp = $Settings.PSObject.Properties['mcpServers']
    if ($mcp) {
        $n = 0
        if (& $isObj $mcp.Value) { $n = @($mcp.Value.PSObject.Properties).Count }
        $Settings.PSObject.Properties.Remove('mcpServers')
        $done.Add("убрал раздел mcpServers ($n серв.) — в settings.json Claude Code его не читает; копия — в бэкапе")
    }
    return $done.ToArray()
}

# (Write-HmFileSafe — запись без хода сквозь ссылку — живёт в _userpath.ps1: её зовут и другие
# скрипты, а копия в двух местах расходится молча.)

# Копия файла рядом: <имя>.hamidun-bak-<дата-время>. Режим CreateNew не перезапишет и не пройдёт
# сквозь существующее имя (файл, каталог, ссылка) — берётся следующее (-2 … -9). Возвращает
# путь копии или $null; на ссылку в каталоге не пишет.
function New-HmBackupFile {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][byte[]]$Bytes)
    $dir = Split-Path -Parent $Path
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    for ($n = 1; $n -le 9; $n++) {
        if (Test-HmIsReparse $dir) { return $null }
        $bak = $Path + '.hamidun-bak-' + $stamp + $(if ($n -gt 1) { "-$n" } else { '' })
        $fs = $null
        $made = $false
        try {
            $fs = [IO.File]::Open($bak, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $made = $true
            $fs.Write($Bytes, 0, $Bytes.Length)
            $fs.Dispose(); $fs = $null
            return $bak
        } catch [System.IO.IOException], [System.UnauthorizedAccessException] {
            # Занятое имя: файл → IOException, а каталог или ссылка-junction → «отказано в доступе»
            # (UnauthorizedAccessException). В обоих случаях берём следующее имя, а не бросаем ошибку.
            if ($made) { try { if ($fs) { $fs.Dispose(); $fs = $null }; Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue } catch { }; return $null }
        } finally { if ($fs) { $fs.Dispose() } }
    }
    return $null
}

# Ввод-вывод вокруг Invoke-HmSettingsFixes. $Fresh — файл только что положен НАМИ из пака
# (его не было, или «Переустановить начисто» перезаписал его): тогда значения по умолчанию
# применяются без оглядки на отметку — это наш файл, а не выбор человека. $MarkerPath —
# отметка применённых шагов (~/.hamidun-setup/config-migrations.json).
function Invoke-HmSettingsMigration {
    param([Parameter(Mandatory = $true)][string]$Path, [bool]$Fresh, [string]$MarkerPath)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $home_ = Split-Path -Parent $Path
    # Файл или каталог-ссылка: правка ушла бы во ВНЕШНЮЮ цель — не трогаем (то же правило,
    # что у раскладки в config.ps1: сквозь reparse-point не пишем).
    if ((Test-HmIsReparse $Path) -or (Test-HmIsReparse $home_)) {
        Write-Host "Настройки Claude Code: settings.json или ~/.claude — ссылка (symlink/junction), правки пропускаю (внешний файл не трогаю)."
        return
    }
    try {
        $bytes = [IO.File]::ReadAllBytes($Path)
        $off = 0
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $off = 3 }
        # Строгий UTF-8: битый файл не «чиним», а оставляем как есть.
        $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes, $off, $bytes.Length - $off)
    } catch {
        Write-Host "Настройки Claude Code: settings.json прочитать не удалось ($($_.Exception.Message)) — правки пропускаю."
        return
    }
    $obj = $null
    # Корень обязан быть объектом. Проверяем и по тексту: ConvertFrom-Json в новых PowerShell
    # разворачивает массив из одного объекта в сам объект, и «[{…}]» прошёл бы за настройки.
    if ($text.TrimStart().StartsWith('{')) {
        try { $obj = $text | ConvertFrom-Json -ErrorAction Stop } catch { $obj = $null }
    }
    if (-not ($obj -is [System.Management.Automation.PSCustomObject])) {
        Write-Host "Настройки Claude Code: settings.json не разбирается как JSON-объект — правки пропускаю, файл не трогаю."
        return
    }

    $applied = [ordered]@{}
    if ($MarkerPath -and (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
        try {
            $m = Get-Content -Raw -LiteralPath $MarkerPath -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
            foreach ($p in @($m.PSObject.Properties)) { $applied[$p.Name] = [string]$p.Value }
        } catch { $applied = [ordered]@{} }
    }
    $defaults = $Fresh -or -not $applied.Contains($HmDefaultsStepId)
    $hints = New-Object System.Collections.Generic.List[string]
    $changes = @(Invoke-HmSettingsFixes -Settings $obj -Defaults $defaults -Hints $hints)
    foreach ($h in $hints) { Write-Host "Настройки Claude Code: $h" }

    if ($changes.Count -gt 0) {
        $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        $tail = if ($text.EndsWith("`n")) { $nl } else { '' }
        $newText = (ConvertTo-HmJsonText -Value $obj).Replace("`n", $nl) + $tail
        # Самопроверка сериализатора: разобранный обратно текст обязан дать ровно тот же
        # текст. Не сошлось — ошибка у нас, а не у человека: файл не трогаем.
        $same = $false
        try {
            $back = $newText | ConvertFrom-Json -ErrorAction Stop
            $same = (((ConvertTo-HmJsonText -Value $back).Replace("`n", $nl) + $tail) -ceq $newText)
        } catch { $same = $false }
        if (-not $same) {
            Write-Host "Настройки Claude Code: самопроверка записи не прошла — settings.json оставляю как есть."
            return
        }
        $bak = $null
        try { $bak = New-HmBackupFile -Path $Path -Bytes $bytes }
        catch { Write-Host "Настройки Claude Code: копию снять не удалось ($($_.Exception.Message)) — settings.json не трогаю."; return }
        if (-not $bak) {
            Write-Host "Настройки Claude Code: копию снять не удалось (имена заняты, диск полон или ~/.claude стал ссылкой) — settings.json не трогаю."
            return
        }
        try {
            $out = (New-Object System.Text.UTF8Encoding($false)).GetBytes($newText)
            if ($off -eq 3) { $out = [byte[]](@(0xEF, 0xBB, 0xBF) + $out) }
            Write-HmFileSafe -Path $Path -Bytes $out
        } catch {
            Write-Host "Настройки Claude Code: записать settings.json не удалось ($($_.Exception.Message)). Копия до правки: $bak"
            return
        }
        Write-Host "Настройки Claude Code (~/.claude/settings.json): убрал устаревшее из прошлых версий пака. Копия до правки: $bak"
        foreach ($c in $changes) { Write-Host "  • $c" }
    } else {
        Write-Host "Настройки Claude Code: устаревших правок в settings.json нет — файл не менял."
    }

    if ($MarkerPath -and -not $applied.Contains($HmDefaultsStepId)) {
        $applied[$HmDefaultsStepId] = (Get-Date).ToString('s')
        try {
            $dir = Split-Path -Parent $MarkerPath
            if ($dir -and (Test-HmIsReparse $dir)) { throw "каталог — ссылка (symlink/junction): $dir" }
            if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            Write-HmFileSafe -Path $MarkerPath -Bytes ((New-Object System.Text.UTF8Encoding($false)).GetBytes((ConvertTo-HmJsonText -Value ([pscustomobject]$applied)) + "`n"))
        } catch { }   # без отметки шаг значений по умолчанию просто повторится один раз — не беда
    }
}

# Сколько *.md (без README.md) в каталоге и его подкаталогах до глубины $Depth. Ссылки
# (junction/symlink) не обходим: считаем своё, а не чужое дерево по ссылке.
function Get-HmMdCount([string]$Dir, [int]$Depth = 2) {
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return 0 }
    $n = 0
    try {
        foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction Stop)) {
            if ($f.PSIsContainer) {
                if ($Depth -gt 0 -and -not ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    $n += Get-HmMdCount $f.FullName ($Depth - 1)
                }
            } elseif ($f.Extension -ieq '.md' -and $f.Name -ine 'README.md') { $n++ }
        }
    } catch { }
    return $n
}

# B13: опись поставленного. CATALOG.md пака кладём в ~/.claude (раньше он оставался в
# корне пака, и человек не находил, что вообще встало), а цифры — в
# ~/.hamidun-setup/config-summary.json для финального экрана: «Установлено N навыков,
# M агентов». Считаем то, что реально лежит в ~/.claude после раскладки и фильтра наборов.
# -OnlyIfMissing (verify.ps1, config не ставился): существующий CATALOG.md не заменяем —
# раскладка не делалась, и каталог другой версии пака описывал бы не то, что лежит на диске.
# Пака под рукой нет ($Clone пуст) — каталог не кладём, а цифры всё равно пишем.
function Write-HmConfigSummary {
    param([string]$Clone, [string]$ClaudeHome, [string]$SetupDir, [switch]$OnlyIfMissing)
    $catalogDst = Join-Path $ClaudeHome 'CATALOG.md'
    $catalogOut = ''
    $src = if ($Clone) { Join-Path $Clone 'CATALOG.md' } else { '' }
    $haveSrc = [bool]($src -and (Test-Path -LiteralPath $src -PathType Leaf))
    $haveDst = Test-Path -LiteralPath $catalogDst -PathType Leaf
    if ((Test-HmIsReparse $ClaudeHome) -or (Test-HmIsReparse $catalogDst)) {
        Write-Host "  ~/.claude или CATALOG.md в нём — ссылка, каталог пака не пишу."
    } elseif ($haveSrc -and -not ($OnlyIfMissing -and $haveDst)) {
        try {
            Write-HmFileSafe -Path $catalogDst -Bytes ([IO.File]::ReadAllBytes($src))
            $catalogOut = $catalogDst
        } catch { Write-Host "  Каталог пака (CATALOG.md) скопировать не удалось: $($_.Exception.Message)" }
    } elseif ($haveDst) {
        $catalogOut = $catalogDst
    } else {
        Write-Host "  CATALOG.md пака сейчас недоступен — каталог навыков не положен."
    }
    $skills = 0
    $skillsDir = Join-Path $ClaudeHome 'skills'
    if (Test-Path -LiteralPath $skillsDir -PathType Container) {
        try {
            foreach ($d in @(Get-ChildItem -LiteralPath $skillsDir -Directory -Force -ErrorAction Stop)) {
                if (Test-Path -LiteralPath (Join-Path $d.FullName 'SKILL.md') -PathType Leaf) { $skills++ }
            }
        } catch { }
    }
    $agents = Get-HmMdCount (Join-Path $ClaudeHome 'agents') 2
    $commands = Get-HmMdCount (Join-Path $ClaudeHome 'commands') 2
    $summary = [pscustomobject][ordered]@{
        skills   = $skills
        agents   = $agents
        commands = $commands
        catalog  = $catalogOut
        at       = [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds
    }
    try {
        if (Test-HmIsReparse $SetupDir) { throw "каталог ~/.hamidun-setup — ссылка (symlink/junction)" }
        if (-not (Test-Path -LiteralPath $SetupDir)) { New-Item -ItemType Directory -Force -Path $SetupDir | Out-Null }
        Write-HmFileSafe -Path (Join-Path $SetupDir 'config-summary.json') -Bytes ((New-Object System.Text.UTF8Encoding($false)).GetBytes((ConvertTo-HmJsonText -Value $summary) + "`n"))
    } catch { Write-Host "  Сводку конфига записать не удалось: $($_.Exception.Message)" }
    Write-Host "В ~/.claude сейчас: навыков $skills, агентов $agents, команд $commands$(if ($catalogOut) { ' — перечень в ~/.claude/CATALOG.md' })."
}

# --- AGENTS.md пака → ~/.codex/AGENTS.md (B12: те, кто работает только через Codex) ---------------
# Codex (расширение «ChatGPT» openai.chatgpt-* для VS Code и одноимённый CLI) читает ГЛОБАЛЬНЫЙ
# AGENTS.md из своего домашнего каталога ~/.codex (в codex.exe: «Failed to read global AGENTS.md
# instructions»; AGENTS.override.md, если он есть, читается вместо AGENTS.md). В паке AGENTS.md
# лежит в корне и ведёт агента к каталогу навыков, но туда, где Codex его ищет, его никто не клал:
# у тех, кто работает ТОЛЬКО через Codex, без Claude Code, пак оставался невидимым.
# Файл в ~/.codex — это файл ЧЕЛОВЕКА, поэтому:
#   • Codex на машине нет (ни ~/.codex, ни расширения) — ничего не создаём;
#   • файла нет — создаём; содержимое пака лежит в отмеченном блоке, чтобы потом узнать своё;
#   • файл есть, блока в нём нет — дописываем отмеченный блок В КОНЕЦ, остальное байт в байт как было;
#   • блок уже есть — не трогаем (ни повторно, ни «обновлением»: хочешь свежий — удали блок);
#   • вместо ~/.codex или AGENTS.md ссылка (junction/symlink), либо файл не в UTF-8 — не пишем.
# Каталог берётся ТОЛЬКО под профилем пользователя: переменную CODEX_HOME не читаем — установщик
# идёт под администратором, и путь из пользовательского окружения сделал бы запись произвольной.
# В скопированном тексте единственная относительная ссылка на каталог навыков (CATALOG.md рядом
# с AGENTS.md в корне пака) переписана на ~/.claude/CATALOG.md: именно туда B13 кладёт каталог, а
# рядом с ~/.codex/AGENTS.md его нет.
$HmPackBlockBegin = '<!-- hamidun-pack begin -->'
$HmPackBlockEnd = '<!-- hamidun-pack end -->'

function Test-HmCodexPresent([string]$UserHome) {
    try {
        if (Test-Path -LiteralPath (Join-Path $UserHome '.codex')) { return $true }
        foreach ($editor in '.vscode', '.vscode-oss', '.cursor') {
            $ext = Join-Path $UserHome ($editor + '\extensions')
            if (-not (Test-Path -LiteralPath $ext -PathType Container)) { continue }
            if (@(Get-ChildItem -LiteralPath $ext -Directory -Filter 'openai.chatgpt-*' -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
        }
    } catch { }
    return $false
}

# Возвращает статус строкой: 'created' | 'appended' | 'present' | 'no-codex' | 'no-source' | 'link' |
# 'skipped' | 'failed' (причина напечатана). Исключений наружу не бросает.
function Install-HmCodexAgents {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$UserHome)
    try {
        if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return 'no-source' }
        if (-not (Test-HmCodexPresent $UserHome)) { return 'no-codex' }
        $codexDir = Join-Path $UserHome '.codex'
        $dst = Join-Path $codexDir 'AGENTS.md'
        if ((Test-HmIsReparse $codexDir) -or (Test-HmIsReparse $dst)) {
            Write-Host "Codex: ~/.codex или AGENTS.md в нём — ссылка (symlink/junction), AGENTS.md пака не кладу (внешний файл не трогаю)."
            return 'link'
        }
        if ((Test-Path -LiteralPath $codexDir) -and -not (Test-Path -LiteralPath $codexDir -PathType Container)) {
            Write-Host "Codex: ~/.codex — не каталог, AGENTS.md пака не кладу."
            return 'skipped'
        }
        $strict = New-Object System.Text.UTF8Encoding($false, $true)
        $plain = New-Object System.Text.UTF8Encoding($false)
        $skip = { param([byte[]]$b) if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { 3 } else { 0 } }
        $srcBytes = [IO.File]::ReadAllBytes($Source)
        $so = & $skip $srcBytes
        $packText = $strict.GetString($srcBytes, $so, $srcBytes.Length - $so).Trim()
        if (-not $packText) { return 'no-source' }
        $packText = $packText.Replace('](CATALOG.md)', '](~/.claude/CATALOG.md)')

        $exists = Test-Path -LiteralPath $dst -PathType Leaf
        $existing = New-Object byte[] 0
        $nl = "`n"
        if ($exists) {
            $existing = [IO.File]::ReadAllBytes($dst)
            $eo = & $skip $existing
            try { $oldText = $strict.GetString($existing, $eo, $existing.Length - $eo) }
            catch {
                Write-Host "Codex: ~/.codex/AGENTS.md не в кодировке UTF-8 — не трогаю, блок пака не дописываю."
                return 'skipped'
            }
            if ($oldText.Contains($HmPackBlockBegin)) { return 'present' }
            if ($oldText.Contains("`r`n")) { $nl = "`r`n" }
        } elseif ($packText.Contains("`r`n")) { $nl = "`r`n" }

        $block = $HmPackBlockBegin + $nl + $packText.Replace("`r`n", "`n").Replace("`n", $nl) + $nl + $HmPackBlockEnd + $nl
        $lead = ''
        if ($existing.Length -gt 0) {
            # пустая строка между текстом человека и нашим блоком
            $lead = $nl
            if ($existing[$existing.Length - 1] -ne 0x0A) { $lead = $nl + $nl }
        }
        $appendBytes = $plain.GetBytes($lead + $block)
        $ms = New-Object System.IO.MemoryStream
        $ms.Write($existing, 0, $existing.Length)
        $ms.Write($appendBytes, 0, $appendBytes.Length)
        $newBytes = $ms.ToArray()

        if (-not (Test-Path -LiteralPath $codexDir)) {
            New-Item -ItemType Directory -Force -Path $codexDir | Out-Null
            # между проверкой и созданием процесс обычного пользователя мог подсунуть ссылку
            if (Test-HmIsReparse $codexDir) {
                Write-Host "Codex: ~/.codex оказался ссылкой (symlink/junction) — AGENTS.md пака не кладу."
                return 'link'
            }
        }
        Write-HmFileSafe -Path $dst -Bytes $newBytes
        if ($exists) {
            Write-Host "Codex: в ~/.codex/AGENTS.md уже был твой файл — дописал в конец блок пака между метками $HmPackBlockBegin и $HmPackBlockEnd, остальное не тронуто. Убрать: удали блок между метками."
            return 'appended'
        }
        Write-Host "Codex: положил карту конфига в ~/.codex/AGENTS.md — Codex читает глобальный AGENTS.md оттуда и по нему находит навыки пака (каталог: ~/.claude/CATALOG.md)."
        return 'created'
    } catch {
        Write-Host "Codex: AGENTS.md пака положить не удалось ($($_.Exception.Message)) — на остальную установку это не влияет."
        return 'failed'
    }
}
