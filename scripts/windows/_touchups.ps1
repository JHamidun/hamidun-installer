# Исправления «на каждый запуск» (диспетчер).
#
# ЗАЧЕМ. Скрипт компонента (vscode.ps1, mascot.ps1, config.ps1 …) запускается, только если
# компонент отмечен. У человека, который поставил его раньше, карточка на повторном запуске
# снята с галочки, и исправление, лежащее внутри скрипта, до него не доходит. Проверка
# покрытия диалогов с Никой показала, что именно так «не доехали» исправления для строк
# A02–A09, A26, A39, A42. Поэтому всё, что можно починить у УЖЕ установленного, живёт в
# отдельных scripts/windows/touchup-<имя>.ps1, verify.ps1 (скрытый шаг, всегда последний и
# первым делом) зовёт их через Invoke-HmTouchups, а кнопка «Проверить и починить» в окне
# запускает один verify.
#
# КОНТРАКТ touch-up'а: самостоятельный скрипт; идемпотентный; быстрый и без сети (дольше
# TimeoutSec диспетчер его прерывает); трогает только профиль и HKCU ТОГО ЖЕ пользователя;
# никогда не исполняет user-writable бинари; печатает «ОБНОВЛЕНО: …» только если что-то
# изменил. Исход touch-up'а прогон не красит: код выхода ребёнка не учитывается, а ошибка
# или таймаут превращаются в одну строку «[touchup-…] …» в журнале.
#
# Запуск — ОТДЕЛЬНЫМ powershell.exe по абсолютному пути из System32, как главный процесс
# запускает скрипты компонентов: консоль переводится в UTF-8 ДО скрипта (иначе кириллица в
# его выводе превращается в мусор), а `exit` внутри touch-up'а не может оборвать verify.
#
# КАКИЕ ФАЙЛЫ ЗАПУСКАТЬ — решает СПИСОК ИМЁН, вшитый в вызов в verify.ps1 (параметр -Names), а не содержимое каталога
# (F19, разбор безопасности). Раньше диспетчер запускал ВСЁ, что совпало с touchup-*.ps1 рядом с verify.ps1, отдельными
# процессами под администратором: новый файл, положенный в каталог распаковки, был всегда готовым слотом исполнения,
# причём мимо любой проверки, которая закрепит известные скрипты. Теперь лишний файл не запускается никогда, а
# забытый в списке ловит тест (список обязан совпасть с touchup-*.ps1 в репозитории: test/run-tests.js, раздел u10b).
# Порядок запуска — порядок списка (в verify.ps1 он алфавитный, как был у сортировки по имени). Имя в списке проходит строгую
# проверку touchup-<буквы-цифры-дефис> (без пути и расширения), файл ищется только в каталоге самого verify.ps1.
# Чего это НЕ делает: файл из списка по-прежнему исполняется под администратором из каталога распаковки (принятый владельцем
# остаток F12), и сами touch-up'ы по-прежнему идут с токеном verify — запуск без повышения прав отдельная задача.
# Здесь нет `exit`: это библиотека.

# Одиночные кавычки внутри '…' удваиваем все пять видов: PowerShell считает ограничителем и
# ASCII ', и U+2018/U+2019/U+201A/U+201B («O’Brien» в пути иначе ломал бы запуск).
function ConvertTo-HmTouchupLiteral {
    param([string]$Text)
    $pattern = "['" + [char]0x2018 + [char]0x2019 + [char]0x201A + [char]0x201B + ']'
    return [regex]::Replace([string]$Text, $pattern, '$0$0')
}

# Файл touch-up'а по ИМЕНИ из списка: объект FileInfo либо $null, если имя не строгое или файла нет. Имя — без пути и без
# расширения: «..\evil», «touchup-x.ps1», «touchup_x», «touchup-q'uote» не проходят.
function Resolve-HmTouchupFile {
    param([string]$Dir, [string]$Name)
    if ($Name -notmatch '\Atouchup-[A-Za-z0-9-]+\z') { return $null }
    $p = [System.IO.Path]::Combine($Dir, $Name + '.ps1')
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
    return (Get-Item -LiteralPath $p -Force)
}

function Invoke-HmTouchups {
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Names, [int]$TimeoutSec = 60)
    $sysRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $psExe = [System.IO.Path]::Combine($sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (-not (Test-Path -LiteralPath $psExe)) {
        Write-Host '[touchups] пропущено: нет powershell.exe в System32'
        return
    }
    foreach ($listed in $Names) {
        $f = Resolve-HmTouchupFile -Dir $Dir -Name $listed
        if (-not $f) {
            # Не молча: пропажа файла из списка или кривое имя — это ошибка упаковки, и она должна быть видна в журнале.
            Write-Host ('[touchups] пропущено: «' + ([string]$listed -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]', '?') + '» — имя не строгое или файла нет рядом с verify.ps1')
            continue
        }
        $name = $f.BaseName
        $proc = $null
        try {
            # Исключение touch-up'а ловим ВНУТРИ ребёнка и печатаем обычной строкой: через stderr оно
            # приходит XML-ом (CLIXML), и текст ошибки терялся бы вместе с обёрткой.
            $inline = '$ProgressPreference=''SilentlyContinue''; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ' +
                'try { & ''' + (ConvertTo-HmTouchupLiteral $f.FullName) + ''' } catch { Write-Host (''[' + $name + '] ошибка: '' + ($_.Exception.Message -replace ''\s+'', '' '')) }; exit 0'
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $psExe
            # -OutputFormat Text: при перенаправленном выводе PowerShell иначе заворачивает stderr
            # и прогресс в XML (#< CLIXML), и эта обёртка попадала бы в журнал как «ошибка».
            $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand ' +
                [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($inline))
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
            $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
            $proc = [System.Diagnostics.Process]::Start($psi)
            $outTask = $proc.StandardOutput.ReadToEndAsync()
            $errTask = $proc.StandardError.ReadToEndAsync()
            if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
                try { $proc.Kill() } catch { }
                Write-Host ('[' + $name + '] прервано: не уложился в ' + $TimeoutSec + ' с')
                continue
            }
            $proc.WaitForExit()   # дожидаемся полного закрытия потоков вывода
            foreach ($line in ([string]$outTask.Result -split '\r?\n')) {
                if ($line.Trim()) { Write-Host $line }
            }
            # Служебные строки CLIXML (#< CLIXML, <Objs …) — не ошибка touch-up'а.
            $errLines = @(([string]$errTask.Result -split '\r?\n') | Where-Object { $_ -and ($_ -notmatch '^(#<|<Objs|</Objs)') })
            $err = ($errLines -join "`n").Trim()
            if ($err) {
                $first = ($err -split '\r?\n')[0]
                if ($first.Length -gt 200) { $first = $first.Substring(0, 200) }
                Write-Host ('[' + $name + '] ошибка: ' + $first)
            }
        } catch {
            Write-Host ('[' + $name + '] не запустился: ' + $_.Exception.Message)
        } finally {
            if ($proc) { try { $proc.Dispose() } catch { } }
        }
    }
}
