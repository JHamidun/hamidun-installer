#!/usr/bin/env bash
# VS Code (рекомендуемый редактор) + расширения Claude Code и Codex — macOS.
# Аналог scripts/windows/vscode.ps1. Ставит VS Code из вшитого vendor/apps/vscode.zip
# (офлайн) в /Applications, снимает карантин, затем ставит ОБА расширения в VS Code.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

DRY="${HM_DRY_RUN:-}"
APP="/Applications/Visual Studio Code.app"
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
    echo "  [dry-run] WOULD: verify SHA-256 vscode.zip, распаковать 'Visual Studio Code.app' в /Applications, снять карантин, поставить расширения anthropic.claude-code + openai.chatgpt"
  else
    verify_artifact "$ZIP"    # вшитый артефакт — fail-closed SHA-256
    echo "Распаковываю VS Code из встроенного архива (офлайн)..."
    MNT="/tmp/hm_vscode_unzip"
    rm -rf "$MNT"; mkdir -p "$MNT"
    # ditto (НЕ unzip): сохраняет символлинки/xattr/подпись бандла целиком.
    if ! ditto -x -k "$ZIP" "$MNT" 2>/dev/null; then
      echo "Не смог распаковать архив VS Code (повреждён?)."; rm -rf "$MNT"; exit 1
    fi
    SRC="$(find "$MNT" -maxdepth 1 -type d -name '*.app' | head -n1)"
    # Пустой SRC → admin_run скопировал бы мусор и зря спросил пароль администратора.
    if [ -z "$SRC" ]; then
      echo "В архиве VS Code не найдено приложение (.app)."; rm -rf "$MNT"; exit 1
    fi
    echo "Копирую $(basename "$SRC") в /Applications (может потребоваться пароль администратора)..."
    admin_run "cp -R '$SRC' /Applications/"
    rm -rf "$MNT"
    # Снять карантин (архив метит содержимое com.apple.quarantine) — иначе Gatekeeper заблокирует запуск.
    xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
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

resolve_vsix claude-code.vsix; CLAUDE_VSIX="$VSIX_OUT"
resolve_vsix chatgpt.vsix;     CODEX_VSIX="$VSIX_OUT"

EXT_OK_CLAUDE=0
EXT_OK_CODEX=0
install_ext "$CODE_CLI" "anthropic.claude-code" "$CLAUDE_VSIX" && EXT_OK_CLAUDE=1
install_ext "$CODE_CLI" "openai.chatgpt" "$CODEX_VSIX" && EXT_OK_CODEX=1

[ "$EXT_OK_CLAUDE" -eq 1 ] && echo "OK: панель Claude Code в VS Code установлена."
[ "$EXT_OK_CODEX" -eq 1 ] && echo "OK: Codex (openai.chatgpt) в VS Code установлен."
[ "$EXT_OK_CLAUDE" -eq 1 ] && exit 0
echo "Claude Code расширение не подтвердилось. Открой VS Code -> Extensions -> 'Claude Code' -> Install. Claude Code также работает в терминале командой 'claude'."
exit 1
