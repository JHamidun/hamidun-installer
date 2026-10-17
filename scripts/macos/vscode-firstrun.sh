# Настройки VS Code для новичка — macOS. Подключается из vscode.sh (строка с CODE_CLI)
# точкой, а не запускается: ставит ловушку EXIT в оболочке самого vscode.sh.
#
# Зачем ловушка: у шага VS Code много выходов (редактора нет, CLI нет, расширения не
# встали, всё встало), а настройки нужны на любом из них, где редактор уже стоит, — и
# ПОСЛЕ расширений: русский интерфейс включается, только если языковой пакет уже на диске.
# Ловушка EXIT код выхода шага не меняет: его задаёт exit, а сама она exit не зовёт.
#
# Сама правка settings.json и argv.json — в vscode-settings.js, зеркале
# scripts/windows/vscode-settings.ps1; запускает его hm_jxa из _lib.sh (osascript живёт
# только там). Переменные APP, DIR, DRY и функцию hm_jxa даёт vscode.sh (он сорсит _lib.sh).
hm_vscode_firstrun() {
  if [ ! -d "${APP:-}" ]; then
    echo "Настройки VS Code для новичка: редактора на этом компьютере нет — пропускаю."
    return 0
  fi
  hm_jxa "${DIR:-.}/vscode-settings.js" "$HOME" "${DRY:+dry}" 2>&1 \
    || echo "Настройки VS Code для новичка: шаг остановлен — редактор работает и без них."
  return 0
}
trap hm_vscode_firstrun EXIT
