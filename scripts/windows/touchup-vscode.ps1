# Подтяжка VS Code до «готов для новичка» — Windows. Запускается проверкой (verify.ps1) при
# КАЖДОМ прогоне установщика и кнопкой «Проверить и починить», а не только при установке
# компонента VS Code.
#
# Зачем отдельный вход. Всё, что делает vscode.ps1 в конце (настройки без чата Copilot и
# Restricted Mode, русский интерфейс, профиль терминала, ярлык «Claude Code — мои проекты»),
# людям, у которых VS Code с обоими расширениями УЖЕ стоит, не доходило: карточка
# компонента у них снята («уже установлено»), vscode.ps1 не стартует, и именно они — те, кто
# писал во встроенный чат Copilot вместо Claude. Этот скрипт доходит до всех.
#
# Контракт:
#   - самостоятельный: подключает нужное сам (vscode-settings.ps1 рядом), ничего не ждёт;
#   - идемпотентный: второй прогон ничего не меняет и молчит;
#   - быстрый: потолок ~5 с, сети нет совсем;
#   - делает что-либо ТОЛЬКО если VS Code есть на диске (Code.exe);
#   - никогда не завершается с ненулевым кодом: любой сбой превращается в строку
#     «[touchup-vscode] пропущено: <причина>»;
#   - вывод: ОДНА строка «ОБНОВЛЕНО: …», только если что-то изменилось; иначе ни строки
#     (или «[touchup-vscode] пропущено: …», если сделать не удалось).
#
# Безопасность та же, что у vscode-settings.ps1: скрипт идёт под администратором, поэтому не
# пишет сквозь ссылки, проверяет путь от %APPDATA% вниз перед каждой записью и ничего не
# запускает (ни лаунчер, ни ярлык) — их запускает только сам человек.
$ErrorActionPreference = 'Continue'

# Подключён точкой (или вызван тестом ради функций) — ничего не делаем, чтобы exit ниже не
# оборвал вызывающего.
if ($MyInvocation.InvocationName -eq '.') { return }

$hmTouchupLine = ''
$hmFunctions = Join-Path $PSScriptRoot 'vscode-settings.ps1'
if (-not (Test-Path -LiteralPath $hmFunctions)) {
    $hmTouchupLine = '[touchup-vscode] пропущено: нет файла vscode-settings.ps1 рядом'
} else {
    try {
        . $hmFunctions
        # Точка выше выставила режим по умолчанию в нашей области — возвращаем тишину:
        # неожиданные ошибки cmdlet'ов не должны попадать в вывод проверки.
        $ErrorActionPreference = 'SilentlyContinue'
        $hmTouchupLine = Invoke-HmVsCodeTouchup
    } catch {
        $hmTouchupWhy = 'внутренний сбой'
        try { $hmTouchupWhy += ': ' + ($_.Exception.GetType().Name -replace 'Exception$', '') } catch { }
        $hmTouchupLine = "[touchup-vscode] пропущено: $hmTouchupWhy"
    }
}
if ($hmTouchupLine) { Write-Host $hmTouchupLine }
exit 0
