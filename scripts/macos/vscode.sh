#!/usr/bin/env bash
# VS Code (рекомендуемый редактор) + расширения Claude Code и Codex — macOS.
# Аналог scripts/windows/vscode.ps1. Ставит VS Code из вшитого vendor/apps/vscode.zip
# (офлайн) в /Applications, снимает карантин, затем ставит ОБА расширения в VS Code.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

DRY="${HM_DRY_RUN:-}"
# P1: VS Code может стоять в /Applications (обычная установка) ИЛИ ~/Applications
# (user-install без прав администратора). detectComponents (main.js) поддерживает оба —
# поэтому детектим ОБА и здесь: иначе при user-install мы ошибочно вернули бы 120 и не
# доставили расширения, а при vendor — поставили бы ВТОРУЮ копию в /Applications.
APP_SYS="/Applications/Visual Studio Code.app"
APP_USER="$HOME/Applications/Visual Studio Code.app"
if   [ -d "$APP_SYS" ];  then APP="$APP_SYS"
elif [ -d "$APP_USER" ]; then APP="$APP_USER"
else APP="$APP_SYS"; fi   # ни одного нет -> цель установки по умолчанию /Applications
CODE_CLI="$APP/Contents/Resources/app/bin/code"

echo "Проверяю VS Code..."
if [ -d "$APP" ]; then
  echo "VS Code уже установлен — доставлю только расширения."
else
  ZIP="${HM_VENDOR:-}/apps/vscode.zip"
  if [ -z "${HM_VENDOR:-}" ] || [ ! -f "$ZIP" ]; then
    # Офлайн-архив не вшит И VS Code не установлен — как скрепка (mascot): грациозный
    # пропуск (exit 120). Всё остальное работает; VS Code можно поставить позже.
    echo "VS Code не вошёл в эту сборку и не установлен — пропускаю. Остальное работает без него (поставь VS Code позже с code.visualstudio.com)."
    exit 120
  fi
  if [ -n "$DRY" ]; then
    echo "  [dry-run] WOULD: под ОДНИМ admin_run (root): staging /var/root, cp вшитого vscode.zip в staging, ditto -x -k, codesign -R Team ID(UBF8T346G9)+spctl распакованного .app в staging, cp .app в /Applications, xattr -dr com.apple.quarantine; поставить расширения anthropic.claude-code + openai.chatgpt"
  else
    verify_artifact "$ZIP"    # вшитый артефакт — предварительный fail-closed SHA-256 (быстрый отсев повреждённого zip без пароля)
    # verify + install АТОМАРНО под root на root-owned staging (Codex — тот же TOCTOU, что
    # закрыт для cursor/node/pydeps). Раньше SHA проверялась medium'ом, ZIP распаковывался
    # в same-UID /tmp, а root копировал .app ВНУТРИ admin_run — пока открыт пароль-промпт,
    # same-user мог подменить распакованный .app. SHA на вшитом zip от этого НЕ защищает:
    # checksums.json тоже same-UID (атакующий подменит и zip, и хэш). Теперь под root в
    # ОДНОМ admin_run (HM_VSCODE_INSTALL_SH): cp вшитого zip -> root-owned staging (0700) ->
    # ditto распаковка в staging -> codesign -R (ТОЧНЫЙ Team ID Microsoft; крипто-оценка
    # подписи, не парсинг -dv) + spctl (нотаризация) распакованного .app -> cp .app в
    # /Applications -> снять карантин. Между verify и install окна нет (всё над root-owned
    # staging). Team ID и dest — ПОЗИЦИОННЫЕ параметры (не интерполяция в текст).
    # Team ID VS Code. Подтверждено сетью (2026-07): официальные сборки VS Code подписаны
    # "Developer ID Application: Microsoft Corporation (UBF8T346G9)", TeamIdentifier=UBF8T346G9
    # (community.jamf.com — codesign output; fullmetalmac.com/team-ids — Microsoft = UBF8T346G9).
    # TODO-verify: сменит Microsoft Team ID -> fail-closed стоп; обновить VSCODE_TEAM_ID.
    VSCODE_TEAM_ID='UBF8T346G9'
    echo "Проверяю подпись и устанавливаю VS Code в /Applications (может потребоваться пароль администратора)..."
    if ! admin_run /bin/sh -c "$HM_VSCODE_INSTALL_SH" hm_vscode_install "$ZIP" "$VSCODE_TEAM_ID" "$APP"; then
      echo "VS Code: подпись/нотаризация не подтверждены или установка не удалась (fail-closed)."; exit 1
    fi
    if [ -d "$APP" ]; then
      echo "VS Code установлен."
      echo "HM-RECEIPT path $APP"
    else
      echo "ВНИМАНИЕ: VS Code не подтвердил установку — расширения всё равно попробую доставить."
    fi
  fi
fi

# --- Расширения: ОБА — панель Claude (anthropic.claude-code) и Codex (openai.chatgpt) ---
ext_present() {
  # $1=cli $2=extId ; ретрай на лаг --list-extensions. Сравнение в lowercase (GNU grep 3.0-safe).
  k=0
  while [ "$k" -lt 3 ]; do
    if "$1" --list-extensions 2>/dev/null | tr '[:upper:]' '[:lower:]' \
        | grep -Fx "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" >/dev/null; then
      return 0
    fi
    k=$((k + 1)); sleep 1
  done
  return 1
}

# Вшитый .vsix (офлайн). vsix исполняется как код внутри VS Code -> целостность ДО установки
# (fail-closed, в ГЛАВНОМ шелле — не в субшелле, иначе exit не остановил бы установку).
VSIX_OUT=""
resolve_vsix() {
  VSIX_OUT=""
  [ -n "${HM_VENDOR:-}" ] || return 0
  local p="$HM_VENDOR/apps/$1"
  [ -f "$p" ] || return 0
  verify_artifact "$p"
  VSIX_OUT="$p"
}

install_ext() {
  # $1=cli $2=extId $3=vsix(опц.)
  cli="$1"; extId="$2"; vsix="${3:-}"
  echo "Ставлю расширение $extId в VS Code..."
  # Приоритет — вшитый .vsix (офлайн); фолбэк — Marketplace по id.
  if [ -n "$vsix" ]; then
    echo "  из вшитого vsix (офлайн): $vsix"
    "$cli" --install-extension "$vsix" --force
    if ext_present "$cli" "$extId"; then echo "  $extId: на месте (офлайн vsix)."; return 0; fi
    echo "  $extId: vsix не подтвердился — пробую Marketplace..."
  fi
  "$cli" --install-extension "$extId" --force
  if ext_present "$cli" "$extId"; then echo "  $extId: на месте."; return 0; fi
  echo "  $extId: не подтвердилось."; return 1
}

if [ -n "$DRY" ]; then
  echo "  [dry-run] расширения: anthropic.claude-code + openai.chatgpt (ветка выбрана, без изменений)."
  exit 0
fi

if [ ! -x "$CODE_CLI" ]; then
  echo "CLI VS Code не найден ($CODE_CLI) — расширения не поставить автоматически. Открой VS Code -> Extensions -> 'Claude Code' и 'ChatGPT - Codex' -> Install."
  exit 1
fi

resolve_vsix "claude-code-$(arch_tag).vsix"; CLAUDE_VSIX="$VSIX_OUT"
resolve_vsix "chatgpt-$(arch_tag).vsix";     CODEX_VSIX="$VSIX_OUT"

EXT_OK_CLAUDE=0
EXT_OK_CODEX=0
install_ext "$CODE_CLI" "anthropic.claude-code" "$CLAUDE_VSIX" && EXT_OK_CLAUDE=1
install_ext "$CODE_CLI" "openai.chatgpt" "$CODEX_VSIX" && EXT_OK_CODEX=1

[ "$EXT_OK_CLAUDE" -eq 1 ] && echo "OK: панель Claude Code в VS Code установлена."
[ "$EXT_OK_CODEX" -eq 1 ] && echo "OK: Codex (openai.chatgpt) в VS Code установлен."
# P1: успех (exit 0) ТОЛЬКО когда встали ОБА расширения. Иначе называем отсутствующее.
if [ "$EXT_OK_CLAUDE" -eq 1 ] && [ "$EXT_OK_CODEX" -eq 1 ]; then exit 0; fi
missing=""
[ "$EXT_OK_CLAUDE" -eq 1 ] || missing="Claude Code (anthropic.claude-code)"
[ "$EXT_OK_CODEX" -eq 1 ]  || missing="${missing:+$missing, }Codex (openai.chatgpt)"
echo "Не установились расширения: $missing. Открой VS Code -> Extensions -> найди их по имени -> Install. Claude Code также работает в терминале командой 'claude'."
exit 1
