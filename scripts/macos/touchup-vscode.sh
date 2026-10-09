#!/usr/bin/env bash
# Подтяжка VS Code до «готов для новичка» — macOS. Зеркало scripts/windows/touchup-vscode.ps1.
#
# Запускается проверкой (verify.sh) при КАЖДОМ прогоне установщика и кнопкой «Проверить и
# починить», а не только при установке компонента VS Code: у людей, у которых VS Code с
# обоими расширениями УЖЕ стоит, карточка компонента снята («уже установлено»), vscode.sh не
# стартует, и настройки без чата Copilot до них не доходили.
#
# Контракт: самостоятельный (подключает _lib.sh сам); идемпотентный (второй прогон молчит);
# без сети, потолок ~5 с; делает что-либо ТОЛЬКО если приложение VS Code есть на диске;
# никогда не завершается с ненулевым кодом; вывод — ОДНА строка «ОБНОВЛЕНО: …», только если
# что-то изменилось, иначе пусто (или «[touchup-vscode] пропущено: …», если сделать не вышло).
#
# Весь ход — внутри функции, а все переменные скрипта локальны или с префиксом HM_TU_:
# если verify.sh подключит этот файл через source, он не должен затереть чужие DIR/APP/DRY.
# Конец файла «return 0 || exit 0»: при source — return, при запуске отдельным процессом —
# exit; ни тот ни другой не уносят с собой ненулевой код.
hm_touchup_vscode() {
  local here app out
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || { echo "[touchup-vscode] пропущено: не нашёл свою папку"; return 0; }
  # shellcheck disable=SC1091
  source "$here/_lib.sh" 2>/dev/null || { echo "[touchup-vscode] пропущено: нет файла _lib.sh рядом"; return 0; }

  if   [ -d "/Applications/Visual Studio Code.app" ];    then app="/Applications/Visual Studio Code.app"
  elif [ -d "$HOME/Applications/Visual Studio Code.app" ]; then app="$HOME/Applications/Visual Studio Code.app"
  else return 0; fi
  [ -n "${HM_DRY_RUN:-}" ] && return 0
  [ -f "$here/vscode-settings.js" ] || { echo "[touchup-vscode] пропущено: нет файла vscode-settings.js рядом"; return 0; }

  # Один вызов osascript: stderr глушим — в выводе проверки нужна ровно одна строка.
  if ! out="$(hm_jxa "$here/vscode-settings.js" "$HOME" touchup 2>/dev/null)"; then
    echo "[touchup-vscode] пропущено: скрипт настройки не запустился или завершился с ошибкой"
    return 0
  fi
  [ -n "$out" ] && printf '%s\n' "$out"
  return 0
}
hm_touchup_vscode || true
return 0 2>/dev/null || exit 0
