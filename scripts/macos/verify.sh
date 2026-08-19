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
  # Зеркало verify.ps1: дизъюнкция зеленела на половине разложенного дерева.
  # Свидетелей теперь двое — содержимое (оба маркера) и квитанция установщика,
  # которая пишется ТОЛЬКО при успехе.
  HAS_SETTINGS=0; [ -f "$HOME/.claude/settings.json" ] && HAS_SETTINGS=1
  HAS_SKILLS=0;   [ -d "$HOME/.claude/skills" ] && HAS_SKILLS=1
  RECORDED=0
  RECEIPT="$HOME/.hamidun-setup/installed.json"
  if [ -f "$RECEIPT" ] && grep -q '"config"' "$RECEIPT" 2>/dev/null; then RECORDED=1; fi
  if [ "$HAS_SETTINGS" = "1" ] && [ "$HAS_SKILLS" = "1" ] && [ "$RECORDED" = "1" ]; then
    echo "CHECK ok Конфиг"
  else
    if [ "$HAS_SETTINGS" = "1" ] || [ "$HAS_SKILLS" = "1" ]; then
      MISS=""
      [ "$HAS_SETTINGS" = "1" ] || MISS="$MISS settings.json"
      [ "$HAS_SKILLS" = "1" ]   || MISS="$MISS skills"
      [ "$RECORDED" = "1" ]     || MISS="$MISS запись-об-успешной-установке"
      echo "  конфиг разложен НЕ полностью, отсутствует:$MISS"
    fi
    echo "CHECK fail Конфиг"
  fi
fi

# --- Python-пакеты (pydeps доехал?) ---
# Зеркало verify.ps1. Весь класс молчаливых провалов pydeps раньше не всплывал нигде —
# на macOS вдобавок сам pydeps печатал «OK» поверх собственного предупреждения.
if ! is_selected pydeps; then
  echo "CHECK skip Python-пакеты"
else
  PYV=""
  for c in "$HOME/.hamidun-setup/python/bin/python3" /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
    [ -x "$c" ] && { PYV="$c"; break; }
  done
  if [ -z "$PYV" ]; then
    echo "  Python не найден — библиотеки ставить было некуда"
    echo "CHECK fail Python-пакеты"
  else
    IMP_OK=0; "$PYV" -c "import playwright" >/dev/null 2>&1 && IMP_OK=1
    BROWSER_OK=0
    if ls -d "$HOME/Library/Caches/ms-playwright/chromium"* >/dev/null 2>&1; then BROWSER_OK=1; fi
    if [ "$IMP_OK" = "1" ] && [ "$BROWSER_OK" = "1" ]; then
      echo "CHECK ok Python-пакеты"
    else
      [ "$IMP_OK" = "1" ]     || echo "  библиотека playwright не импортируется — часть навыков не заработает"
      [ "$BROWSER_OK" = "1" ] || echo "  браузер Playwright не распакован — скриншоты, экспорт и деки не заработают"
      echo "CHECK fail Python-пакеты"
    fi
  fi
fi

# --- Расширение Claude Code (через НАСТОЯЩИЕ CLI Cursor / VS Code, не шим) ---
if ! is_selected extension; then
  echo "CHECK skip Расширение"
else
  EXT="${HM_CLAUDE_EXT_ID:-anthropic.claude-code}"
  EXT_LC="$(printf '%s' "$EXT" | tr '[:upper:]' '[:lower:]')"
  EXT_OK=0
  # Редактор бывает и в ~/Applications (user-install без админа) — иначе «CHECK fail
  # Расширение» при реально установленном расширении. Порядок «сначала /Applications»
  # сохраняет прежнее поведение на обычных машинах.
  for CLI in "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
             "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
             "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
             "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
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
