#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

echo "Устанавливаю Claude Code CLI (нативный установщик)..."
if curl -fsSL https://claude.ai/install.sh | bash; then
  echo "Нативная установка завершена."
else
  echo "Нативный установщик не сработал — пробую npm..."
  if have npm; then npm install -g @anthropic-ai/claude-code; else echo "npm недоступен — установите Node.js."; exit 1; fi
fi

export PATH="$HOME/.local/bin:$PATH"
if have claude; then echo "OK: $(claude --version)"; else echo "claude установлен — появится в PATH после перезапуска терминала."; fi
exit 0
