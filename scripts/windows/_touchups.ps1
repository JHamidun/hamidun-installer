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
# Файлы берутся только из каталога самого verify.ps1 и только по строгому имени
# touchup-<буквы-цифры-дефис>.ps1: ничего нового в доверии к каталогу скриптов это не вносит.
# Здесь нет `exit`: это библиотека.

# Одиночные кавычки внутри '…' удваиваем все пять видов: PowerShell считает ограничителем и
# ASCII ', и U+2018/U+2019/U+201A/U+201B («O’Brien» в пути иначе ломал бы запуск).
function ConvertTo-HmTouchupLiteral {
    param([string]$Text)
    $pattern = "['" + [char]0x2018 + [char]0x2019 + [char]0x201A + [char]0x201B + ']'
    return [regex]::Replace([string]$Text, $pattern, '$0$0')
}

# Какие touch-up'ы лежат в каталоге — в алфавитном порядке (порядок виден в журнале и стабилен).
function Get-HmTouchupFiles {
    param([string]$Dir)
    $found = @()
    try {
        $found = @(Get-ChildItem -LiteralPath $Dir -File -ErrorAction Stop |
            Where-Object { $_.Name -match '^touchup-[A-Za-z0-9-]+\.ps1$' } |
            Sort-Object Name)
    } catch { $found = @() }
    return ,$found
}

function Invoke-HmTouchups {
    param([Parameter(Mandatory = $true)][string]$Dir, [int]$TimeoutSec = 60)
    $sysRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $psExe = [System.IO.Path]::Combine($sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (-not (Test-Path -LiteralPath $psExe)) {
        Write-Host '[touchups] пропущено: нет powershell.exe в System32'
        return
    }
    foreach ($f in (Get-HmTouchupFiles -Dir $Dir)) {
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
