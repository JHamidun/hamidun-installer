#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

EXT="${HM_CLAUDE_EXT_ID:-anthropic.claude-code}"

# Вшитый vsix (полный офлайн) — кладёт build-задача в HM_VENDOR/apps/claude-code.vsix.
VSIX=""
if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/claude-code.vsix" ]; then
  VSIX="$HM_VENDOR/apps/claude-code.vsix"
fi

OK=0

# Честный статус: расширение реально в списке, а не только exit code инсталлятора.
# Без grep -iF (падает на GNU grep 3.0): сравнение в lowercase через tr + точный -Fx.
ext_present() {
  "$1" --list-extensions 2>/dev/null | tr '[:upper:]' '[:lower:]' \
    | grep -Fx "$(printf '%s' "$EXT" | tr '[:upper:]' '[:lower:]')" >/dev/null
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

[ "$OK" -eq 1 ] && { echo "OK: расширение установлено."; exit 0; }
echo "Не удалось установить расширение через CLI. Установите вручную из Marketplace ($EXT)."; exit 1
