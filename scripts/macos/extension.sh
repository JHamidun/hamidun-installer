#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

EXT="${HM_CLAUDE_EXT_ID:-anthropic.claude-code}"
OK=0

CURSOR_CLI="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
if [ -x "$CURSOR_CLI" ]; then
  echo "Ставлю расширение в Cursor..."
  "$CURSOR_CLI" --install-extension "$EXT" --force && OK=1
else
  echo "Cursor CLI не найден — пропускаю Cursor."
fi

CODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
if [ -x "$CODE_CLI" ]; then
  echo "Ставлю расширение в VS Code..."
  "$CODE_CLI" --install-extension "$EXT" --force && OK=1
fi

[ "$OK" -eq 1 ] && { echo "OK: расширение установлено."; exit 0; }
echo "Не удалось установить расширение через CLI. Установите вручную из Marketplace ($EXT)."; exit 1
