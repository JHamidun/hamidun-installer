#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
if [ -n "${HM_VENDOR:-}" ] && [ -d "$HM_VENDOR/npm-cache" ] && have npm; then
  echo "Claude Code CLI из встроенного npm-кеша (офлайн)..."
  npm install -g '@anthropic-ai/claude-code' --offline --cache "$HM_VENDOR/npm-cache" --no-audit --no-fund
else
  echo "Устанавливаю Claude Code CLI (нативный установщик, онлайн)..."
  if curl -fsSL https://claude.ai/install.sh | bash; then echo "Готово."
  elif have npm; then npm install -g @anthropic-ai/claude-code; else echo "npm недоступен — установите Node.js."; exit 1; fi
fi

export PATH="$HOME/.local/bin:$PATH"
if have claude; then echo "OK: $(claude --version)"; else echo "claude установлен — появится в PATH после перезапуска терминала."; fi
exit 0
