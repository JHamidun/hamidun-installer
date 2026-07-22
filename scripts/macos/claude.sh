#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# Ставим в ПОЛЬЗОВАТЕЛЬСКИЙ prefix (~/.local): node из .pkg держит глобальный
# npm-prefix в /usr/local (root:wheel) → `npm -g` без sudo падает с EACCES.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
INSTALLED=0

if [ -n "${HM_VENDOR:-}" ] && [ -d "$HM_VENDOR/npm-cache" ] && have npm; then
  echo "Claude Code CLI из встроенного npm-кеша (офлайн)..."
  if npm install -g --prefix "$HOME/.local" '@anthropic-ai/claude-code' \
       --offline --cache "$HM_VENDOR/npm-cache" --no-audit --no-fund; then
    INSTALLED=1
  else
    echo "Офлайн-установка не удалась — пробую онлайн-фолбэк."
  fi
fi

if [ "$INSTALLED" -eq 0 ]; then
  echo "Устанавливаю Claude Code CLI (нативный установщик, онлайн)..."
  # Таймауты обязательны: curl без --max-time на РФ-DPI виснет молча навсегда.
  if curl -fsSL --connect-timeout 20 --max-time 900 --retry 3 --retry-connrefused https://claude.ai/install.sh | bash; then
    INSTALLED=1
  elif have npm && npm install -g --prefix "$HOME/.local" '@anthropic-ai/claude-code' --no-audit --no-fund; then
    INSTALLED=1
  else
    echo "Сеть недоступна или очень медленная — повтори установку этого компонента."
  fi
fi

# persist_local_bin_path вынесена в _lib.sh (её использует и git.sh для вшитого git).

# Честная проверка: бинарь реально на диске? (иначе — красный статус, а не ложный OK)
export PATH="$HOME/.local/bin:$PATH"
if have claude || [ -x "$HOME/.local/bin/claude" ]; then
  persist_local_bin_path
  if have claude; then echo "OK: $(claude --version 2>&1 | head -n1)"
  else echo "OK: claude установлен, PATH прописан — открой НОВЫЙ терминал для команды claude."; fi
  exit 0
else
  echo "ОШИБКА: Claude Code CLI не установился — смотри лог выше."; exit 1
fi
