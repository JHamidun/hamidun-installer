#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

EXT="${HM_CLAUDE_EXT_ID:-anthropic.claude-code}"

# Вшитый vsix (полный офлайн) — кладёт build-задача в HM_VENDOR/apps/claude-code.vsix.
# vsix исполняется как код внутри Cursor/VS Code -> сверяем целостность ДО установки (fail-closed).
VSIX=""
if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/claude-code.vsix" ]; then
  VSIX="$HM_VENDOR/apps/claude-code.vsix"
  verify_artifact "$VSIX"
fi

OK=0

# Честный статус: расширение реально в списке, а не только exit code инсталлятора.
# Без grep -iF (падает на GNU grep 3.0): сравнение в lowercase через tr + точный -Fx.
ext_present() {
  # ретрай: --list-extensions лагает сразу после установки
  k=0
  while [ "$k" -lt 3 ]; do
    if "$1" --list-extensions 2>/dev/null | tr '[:upper:]' '[:lower:]' \
        | grep -Fx "$(printf '%s' "$EXT" | tr '[:upper:]' '[:lower:]')" >/dev/null; then
      return 0
    fi
    k=$((k + 1)); sleep 1
  done
  return 1
}

install_into() {
  cli="$1"; label="$2"
  echo "Ставлю расширение в $label..."
  if [ -n "$VSIX" ]; then
    echo "  из вшитого vsix (офлайн): $VSIX"
    "$cli" --install-extension "$VSIX" --force
    if ext_present "$cli"; then echo "  $label: расширение на месте."; return 0; fi
    echo "  $label: vsix не подтвердился — пробую Marketplace ($EXT)..."
  fi
  "$cli" --install-extension "$EXT" --force
  if ext_present "$cli"; then echo "  $label: расширение на месте."; return 0; fi
  echo "  $label: расширение не подтвердилось."
  return 1
}

CURSOR_CLI="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
if [ -x "$CURSOR_CLI" ]; then
  install_into "$CURSOR_CLI" "Cursor" && OK=1
else
  echo "Cursor CLI не найден — пропускаю Cursor."
fi

CODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
if [ -x "$CODE_CLI" ]; then
  install_into "$CODE_CLI" "VS Code" && OK=1
fi

# --- вшитый шрифт JetBrains Mono (пер-юзерно, БЕЗ админа) ---
if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/JetBrainsMono-Regular.ttf" ]; then
  if ! verify_artifact_soft "$HM_VENDOR/apps/JetBrainsMono-Regular.ttf"; then
    # Шрифт не критичен — при несовпадении SHA-256 просто НЕ ставим (парсинг ttf — потенц. вектор).
    echo "Шрифт JetBrains Mono не прошёл проверку целостности — пропускаю (не критично)."
  else
    mkdir -p "$HOME/Library/Fonts"
    if cp -f "$HM_VENDOR/apps/JetBrainsMono-Regular.ttf" "$HOME/Library/Fonts/JetBrainsMono-Regular.ttf" 2>/dev/null; then
      echo "Шрифт JetBrains Mono установлен (пер-юзерно)."
    else
      echo "Шрифт не скопировался — пропускаю."
    fi
  fi
fi

# --- сид settings.json Cursor (ТОЛЬКО если файла нет; существующий НЕ трогаем) ---
CURSOR_SETTINGS="$HOME/Library/Application Support/Cursor/User/settings.json"
if [ -f "$CURSOR_SETTINGS" ]; then
  echo "settings.json Cursor уже существует — не трогаю."
else
  mkdir -p "$(dirname "$CURSOR_SETTINGS")" 2>/dev/null || true
  if cat > "$CURSOR_SETTINGS" <<'EOF'
{
  "files.autoSave": "afterDelay",
  "editor.fontFamily": "JetBrains Mono",
  "terminal.integrated.fontFamily": "JetBrains Mono"
}
EOF
  then
    echo "Создал стартовый settings.json Cursor (autoSave + JetBrains Mono)."
  else
    echo "settings.json Cursor не создался — пропускаю."
  fi
fi

[ "$OK" -eq 1 ] && { echo "OK: расширение установлено."; exit 0; }
echo "Не удалось установить расширение через CLI. Установите вручную из Marketplace ($EXT)."; exit 1
