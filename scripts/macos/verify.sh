#!/usr/bin/env bash
# Verify — финальная диагностика установки (macOS)
# Печатает строки вида "CHECK ok <ярлык>" / "CHECK fail <ярлык>" — их ловит рендерер
# и рисует чеклист на финальном экране. Диагностика НЕ проваливает установку: всегда exit 0.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Список выбранных компонентов (id через запятую, из HM_SELECTED). Снятые компоненты
# помечаем как "skip", а не "fail", чтобы на финальном экране не было ложных крестиков.
# Переменная не задана => старый вызов установщика: проверяем всё, как раньше.
is_selected() {
  [ -z "${HM_SELECTED:-}" ] && return 0
  case ",${HM_SELECTED}," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "Финальная проверка установки..."

# --- Git ---
if ! is_selected git; then
  echo "CHECK skip Git"
else
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
fi

# --- Node ---
if ! is_selected node; then
  echo "CHECK skip Node"
else
  NODE_OK=0
  if have node && node -v >/dev/null 2>&1; then
    echo "  node: $(node -v 2>/dev/null)"
    NODE_OK=1
  fi
  if [ "$NODE_OK" -eq 1 ]; then echo "CHECK ok Node"; else echo "CHECK fail Node"; fi
fi

# --- Claude CLI (тот же поиск, что в claude.sh: PATH или ~/.local/bin) ---
if ! is_selected claude; then
  echo "CHECK skip Claude CLI"
else
  CLAUDE_OK=0
  if have claude; then
    echo "  claude: $(command -v claude)"
    CLAUDE_OK=1
  elif [ -x "$HOME/.local/bin/claude" ]; then
    echo "  claude: $HOME/.local/bin/claude (появится в PATH после перезапуска терминала)"
    CLAUDE_OK=1
  fi
  if [ "$CLAUDE_OK" -eq 1 ]; then echo "CHECK ok Claude CLI"; else echo "CHECK fail Claude CLI"; fi
fi

# --- Конфиг (~/.claude развёрнут?) ---
if ! is_selected config; then
  echo "CHECK skip Конфиг"
else
  if [ -f "$HOME/.claude/settings.json" ] || [ -d "$HOME/.claude/skills" ]; then
    echo "CHECK ok Конфиг"
  else
    echo "CHECK fail Конфиг"
  fi
fi

# --- Расширение Claude Code (через НАСТОЯЩИЕ CLI Cursor / VS Code, не шим) ---
if ! is_selected extension; then
  echo "CHECK skip Расширение"
else
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
fi

# Диагностика — не провал: всегда зелёный выход.
exit 0
