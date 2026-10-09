#!/usr/bin/env bash
# touchup-config.sh — always-run: чинит профиль человека независимо от галочек. Установленный
# компонент при повторном запуске снимается с выбора, и правки внутри config.sh до такого
# человека не доходили. Здесь те же правила и та же отметка шага (scripts/macos/_cfgmigrate.js),
# но БЕЗ запуска компонента «Конфиг»:
#   • из ~/.claude/settings.json убирается устаревшее, что оставили прошлые версии пака (плагины
#     без токена, правила Write(путь), опрос, HTTP-хуки VSCODE_PORT, мёртвый раздел mcpServers);
#     CATALOG.md пака кладётся в ~/.claude, если пак под рукой и каталога там ещё нет; пишется
#     сводка для финального экрана. Всё это — только если config НЕ ставился в этом прогоне
#     (иначе его уже сделал config.sh);
#   • если на машине есть Codex — AGENTS.md пака ложится в ~/.codex/AGENTS.md (чужой файл не
#     перезаписывается, дописывается отмеченный блок). Это всегда, когда пак под рукой:
#     расширение Codex могло встать позже config.sh, а повтор безвреден.
# Сухой прогон (HM_DRY_RUN) ничего не пишет и только говорит, что было бы сделано. Ничего
# из профиля не исполняется (ни claude, ни python, ни nmd).
# Контракт touchup-скриптов — в _lib.sh (hm_touchup_begin): автономен, идемпотентен, ≤5 с,
# без сети, никогда не ненулевой код; «ОБНОВЛЕНО: …» только если что-то изменилось.
set -uo pipefail
trap 'exit 0' EXIT
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_lib.sh" 2>/dev/null || { echo "[touchup-config] пропущено: нет _lib.sh"; exit 0; }
hm_touchup_begin config
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

if [ -n "${HM_DRY_RUN:-}" ]; then
  echo "  [dry-run] WOULD: убрать из ~/.claude/settings.json известные дефекты прошлых версий пака (копия до правки рядом), положить CATALOG.md и сводку конфига; при установленном Codex — положить AGENTS.md пака в ~/.codex/AGENTS.md (чужой файл не перезаписывается)"
  hm_touchup_end
fi

SETTINGS="$HOME/.claude/settings.json"
# Вшитый пак: HM_BUNDLED_CONFIG (в лёгком издании его на руках нет — тогда только настройки).
PACK="${HM_BUNDLED_CONFIG:-}"
# Список выбранных в этом прогоне компонентов: config, выбранный сейчас, свою работу уже сделал.
# HM_SELECTED не задан (ручной запуск, старый вызов) — «config не выбран»: чиним то, что видим;
# повтор безвреден (правила и отметка шага те же, что у config.sh).
CONFIG_SELECTED=0
case ",${HM_SELECTED:-}," in *",config,"*) CONFIG_SELECTED=1 ;; esac

HAVE_SETTINGS=0
if [ "$CONFIG_SELECTED" -eq 0 ] && { [ -e "$SETTINGS" ] || [ -L "$SETTINGS" ]; }; then HAVE_SETTINGS=1; fi
HAVE_AGENTS=0
if [ -n "$PACK" ] && [ -f "$PACK/AGENTS.md" ]; then HAVE_AGENTS=1; fi
# Нет файла настроек (конфиг не ставили) и нечего положить для Codex — править нечего (молчим).
if [ "$HAVE_SETTINGS" -eq 0 ] && [ "$HAVE_AGENTS" -eq 0 ]; then hm_touchup_end; fi

# Движок — node: Node ставится раньше конфига, а python3 на чистом маке без Command Line
# Tools — заглушка с системным окном. Нет node — пропуск с понятной строкой.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  hm_touchup_skip "node не найден — настройки Claude Code и карту для Codex не правлю"
  hm_touchup_end
fi

# Модуль сам печатает ровно то, что нужно: «ОБНОВЛЕНО: …», «[touchup-config] пропущено: …»
# или ничего. Файл человека — один раз по отметке в ~/.hamidun-setup/config-migrations.json.
"$NODE_BIN" "$DIR/_cfgmigrate.js" --touchup "$HOME" "$PACK" "$CONFIG_SELECTED" || hm_touchup_skip "правка профиля завершилась ошибкой"
hm_touchup_end
