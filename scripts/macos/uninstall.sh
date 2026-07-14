#!/usr/bin/env bash
# Hamidun uninstaller — macOS. Удаляет ТОЛЬКО артефакты установщика по ЯВНОМУ id
# ($HM_UNINSTALL). ЖЕЛЕЗНО: НИКОГДА не трогает пользовательские данные —
# ~/.claude/.credentials*, memory, projects, todos, shell-snapshots, settings.json и
# пользовательские скиллы защищены жёстким guard'ом (hm_protected / hm_remove).
# Запись версии в манифесте чистит main.js (тестируемый JS-модуль) — не этот скрипт.
set -uo pipefail
DRY=0
[ -n "${HM_DRY_RUN:-}" ] && DRY=1

CLAUDE_HOME="$HOME/.claude"
# Защищённые ПОДДЕРЕВЬЯ: их самих, всё ВНУТРИ и их ПРЕДКОВ удалять нельзя.
PROTECTED_SUBTREES="
$CLAUDE_HOME
$CLAUDE_HOME/skills
$CLAUDE_HOME/memory
$CLAUDE_HOME/projects
$CLAUDE_HOME/todos
$CLAUDE_HOME/shell-snapshots
$CLAUDE_HOME/.credentials.master.env
$CLAUDE_HOME/.credentials.json
$CLAUDE_HOME/settings.json
"

# Нормализуем путь без требования его существования (realpath может не быть).
hm_norm() { printf '%s' "${1%/}"; }

# 0 (true) → удалять НЕЛЬЗЯ.
hm_protected() {
  local target; target="$(hm_norm "$1")"
  [ -z "$target" ] && return 0
  [ "$target" = "/" ] && return 0
  # Не-канонические пути ("./", "../") не резолвим — fail-closed: отказ удалять.
  # Иначе "$HOME/x/../.claude" обошёл бы префикс-сравнение (PS-версия закрыта GetFullPath).
  case "/$target/" in */../*|*/./*) return 0 ;; esac
  local home; home="$(hm_norm "$HOME")"
  [ "$target" = "$home" ] && return 0                 # сам домашний каталог
  case "$home" in "$target"/*) return 0 ;; esac       # предок дома (/Users)
  local p pf
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    pf="$(hm_norm "$p")"
    [ "$target" = "$pf" ] && return 0                 # сам защищённый путь
    case "$target" in "$pf"/*) return 0 ;; esac       # внутри защищённого
    case "$pf" in "$target"/*) return 0 ;; esac       # предок защищённого
  done <<EOF
$PROTECTED_SUBTREES
EOF
  return 1
}

hm_remove() {
  local path="$1" label="$2"
  [ -z "$path" ] && return 0
  if hm_protected "$path"; then
    echo "  ЗАЩИТА: отказываюсь удалять «$path» (пользовательские данные) — пропускаю."
    return 0
  fi
  if [ ! -e "$path" ]; then echo "  $label: нечего удалять ($path)"; return 0; fi
  if [ "$DRY" -eq 1 ]; then echo "  [dry-run] WOULD remove: $path"; return 0; fi
  if rm -rf "$path" 2>/dev/null; then echo "  Удалено ($label): $path"; else echo "  Не удалось удалить $path"; fi
}

ID="$(printf '%s' "${HM_UNINSTALL:-}" | tr -d '[:space:]')"
[ -z "$ID" ] && { echo "HM_UNINSTALL не задан — нечего удалять."; exit 1; }
echo "Деинсталляция компонента: $ID"

case "$ID" in
  course)
    TARGET="${HM_COURSE_TARGET:-$HOME/HamidunCourse}"
    hm_remove "$TARGET/vibecoding-course" 'курс'
    SHORTCUT="${HM_COURSE_SHORTCUT:-Курс вайбкодинг (Claude Code)}"
    hm_remove "$HOME/Desktop/$SHORTCUT.command" 'ярлык курса'
    echo "Примечание: наставник курса в ~/.claude и твои данные НЕ тронуты."
    ;;
  nomad)
    hm_remove "$HOME/.nomad-src" 'исходники Nomad'
    hm_remove "$HOME/.local/bin/nomad" 'бинарь nomad'
    echo "Примечание: uv и Python НЕ удаляю (могут быть нужны другим инструментам)."
    ;;
  uv)
    hm_remove "$HOME/.local/bin/uv" 'uv'
    hm_remove "$HOME/.local/bin/uvx" 'uvx'
    ;;
  mascot)
    for app in "$HOME/Applications"/*.app; do
      [ -d "$app" ] || continue
      case "$(basename "$app")" in *[Mm]ascot*|*[Cc]laude*) hm_remove "$app" 'скрепка (приложение)' ;; esac
    done
    echo "Примечание: хуки в ~/.claude/settings.json НЕ трогаю (там могут быть твои правки)."
    ;;
  bridge)
    hm_remove "$HOME/Library/Application Support/HamidunBridge" 'AI-мост'
    hm_remove "$HOME/Library/LaunchAgents/com.hamidun.bridge.plist" 'автозапуск моста'
    ;;
  *)
    echo "Автоматическое удаление «$ID» не поддерживается (системный инструмент или общая база конфига)."
    echo "Твои данные сохранены. При необходимости удали вручную."
    ;;
esac
exit 0
