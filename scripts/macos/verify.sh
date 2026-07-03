#!/usr/bin/env bash
# Verify — финальная диагностика установки (macOS)
# Печатает строки вида "CHECK ok <ярлык>" / "CHECK fail <ярлык>" — их ловит рендерер
# и рисует чеклист на финальном экране. Диагностика НЕ проваливает установку: всегда exit 0.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

echo "Финальная проверка установки..."

# --- Git ---
# ВАЖНО: не дёргаем /usr/bin/git-шим, пока CLT не стоит — иначе всплывает системный диалог.
GIT_OK=0
if [ -x /Library/Developer/CommandLineTools/usr/bin/git ] || xcode-select -p >/dev/null 2>&1; then
  if git --version >/dev/null 2>&1; then
    echo "  git: $(git --version 2>/dev/null)"
    GIT_OK=1
  fi
elif have git && [ "$(command -v git)" != "/usr/bin/git" ]; then
  # git не из CLT-шима (например, Homebrew) — звать безопасно.
  if git --version >/dev/null 2>&1; then
    echo "  git: $(git --version 2>/dev/null)"
    GIT_OK=1
  fi
fi
if [ "$GIT_OK" -eq 1 ]; then echo "CHECK ok Git"; else echo "CHECK fail Git"; fi

# --- Node ---
NODE_OK=0
if have node && node -v >/dev/null 2>&1; then
  echo "  node: $(node -v 2>/dev/null)"
  NODE_OK=1
fi
if [ "$NODE_OK" -eq 1 ]; then echo "CHECK ok Node"; else echo "CHECK fail Node"; fi

# --- Claude CLI (тот же поиск, что в claude.sh: PATH или ~/.local/bin) ---
CLAUDE_OK=0
if have claude; then
  echo "  claude: $(command -v claude)"
  CLAUDE_OK=1
elif [ -x "$HOME/.local/bin/claude" ]; then
  echo "  claude: $HOME/.local/bin/claude (появится в PATH после перезапуска терминала)"
  CLAUDE_OK=1
fi
if [ "$CLAUDE_OK" -eq 1 ]; then echo "CHECK ok Claude CLI"; else echo "CHECK fail Claude CLI"; fi

# --- Конфиг (~/.claude развёрнут?) ---
if [ -f "$HOME/.claude/settings.json" ] || [ -d "$HOME/.claude/skills" ]; then
  echo "CHECK ok Конфиг"
else
  echo "CHECK fail Конфиг"
fi

# --- Расширение Claude Code (через НАСТОЯЩИЕ CLI Cursor / VS Code, не шим) ---
EXT="${HM_CLAUDE_EXT_ID:-anthropic.claude-code}"
EXT_LC="$(printf '%s' "$EXT" | tr '[:upper:]' '[:lower:]')"
EXT_OK=0
for CLI in "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
           "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
  [ -x "$CLI" ] || continue
  if "$CLI" --list-extensions 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -Fx "$EXT_LC" >/dev/null; then
    echo "  расширение найдено через: $CLI"
    EXT_OK=1
    break
  fi
done
if [ "$EXT_OK" -eq 1 ]; then echo "CHECK ok Расширение"; else echo "CHECK fail Расширение"; fi

# Диагностика — не провал: всегда зелёный выход.
exit 0
