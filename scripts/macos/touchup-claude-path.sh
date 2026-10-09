#!/usr/bin/env bash
# touchup-claude-path.sh — always-run: claude (и команда nmd у Nomad) лежат в ~/.local/bin, но
# НОВОЕ окно Терминала их не находит («zsh: command not found: claude») — дописывает строку PATH
# и проверяет снова. Живой случай: отчёт установки ok=True, а в Терминале claude нет; проверка
# внутри claude.sh идёт только когда компонент выбран, а установленный при повторном запуске
# снимается с выбора. Nomad путь в профиль не прописывает вовсе.
# Ничего не исполняется: проверка нового окна — это `command -v` в оболочке входа человека.
# Сухой прогон (HM_DRY_RUN) ничего не пишет. Claude, про который известно, что он сломан
# (вердикт broken в ~/.hamidun-setup/checks.json), не трогаем: с ним нечего «находить».
# Контракт touchup-скриптов — в _lib.sh (hm_touchup_begin): автономен, идемпотентен, ≤5 с,
# без сети, никогда не ненулевой код; «ОБНОВЛЕНО: …» только если что-то изменилось.
set -uo pipefail
trap 'exit 0' EXIT
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_lib.sh" 2>/dev/null || { echo "[touchup-claude-path] пропущено: нет _lib.sh"; exit 0; }
hm_touchup_begin claude-path

if [ -n "${HM_DRY_RUN:-}" ]; then
  echo "  [dry-run] WOULD: если новое окно Терминала не находит claude или nmd из ~/.local/bin — дописать PATH в профиль оболочки входа"
  hm_touchup_end
fi

# Что проверять. claude: наш (~/.local/bin/claude), не выбран в этом прогоне (иначе claude.sh уже
# проверил новое окно сам) и без прошлого вердикта «broken». nmd: Nomad кладёт команду в
# ~/.local/bin; PATH для неё не пишет никто, кроме этого скрипта.
CHECK_CLAUDE=0
CHECK_NMD=0
# HM_SELECTED не задан (ручной запуск, старый вызов) — «claude не выбран»: проверяем всё, что видим;
# повтор безвреден — когда новое окно всё находит, скрипт молчит.
CLAUDE_SELECTED=0
case ",${HM_SELECTED:-}," in *",claude,"*) CLAUDE_SELECTED=1 ;; esac
if [ -x "$HOME/.local/bin/claude" ] && [ "$CLAUDE_SELECTED" -eq 0 ]; then
  CLAUDE_VERDICT=""
  CHECKS_FILE="$HOME/.hamidun-setup/checks.json"
  if [ -f "$CHECKS_FILE" ]; then
    # grep, а не парсер: нужен один ключ (так же читает verify.sh), а python3 на чистом маке —
    # заглушка CLT с системным окном.
    CLAUDE_VERDICT=$(grep -o '"claude"[^}]*"verdict"[[:space:]]*:[[:space:]]*"[a-z]*"' "$CHECKS_FILE" 2>/dev/null \
      | sed -e 's/.*"verdict"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/' | tail -n1)
  fi
  if [ "$CLAUDE_VERDICT" != "broken" ]; then CHECK_CLAUDE=1; fi
fi
if [ -x "$HOME/.local/bin/nmd" ]; then CHECK_NMD=1; fi
# Нечего проверять (нашего claude и nmd нет, или claude сломан/выбран) — чинить нечего (молчим).
if [ "$CHECK_CLAUDE" -eq 0 ] && [ "$CHECK_NMD" -eq 0 ]; then hm_touchup_end; fi

NAMES=""
PROBE=""
if [ "$CHECK_CLAUDE" -eq 1 ]; then NAMES="claude"; PROBE='command -v claude >/dev/null 2>&1'; fi
if [ "$CHECK_NMD" -eq 1 ]; then
  NAMES="${NAMES:+$NAMES и }nmd"
  PROBE="${PROBE:+$PROBE && }command -v nmd >/dev/null 2>&1"
fi

# Каждая проверка новым окном — отдельный запуск оболочки входа человека (zsh -i -l: читает
# ~/.zprofile и ~/.zshrc, а у тяжёлых конфигов это секунды). На обе проверки отведено ~4 с,
# дольше нельзя: весь скрипт — в пять. Не уложилась оболочка — это не «команда не найдена»,
# а «не успели посмотреть»: пропуск без правок.
export HM_FRESH_SHELL_TIMEOUT="${HM_TOUCHUP_SHELL_TIMEOUT:-2}"

hm_fresh_shell_run i "$PROBE" >/dev/null 2>&1
RC=$?
case "$RC" in
  0) hm_touchup_end ;;   # новое окно находит всё нужное — всё хорошо, молчим
  2) hm_touchup_skip "оболочка входа не zsh и не bash — проверить новое окно нельзя"; hm_touchup_end ;;
  124) hm_touchup_skip "новое окно Терминала не ответило за ${HM_FRESH_SHELL_TIMEOUT} с — не успел проверить"; hm_touchup_end ;;
esac

# Не находит. Чиним: строка PATH в ~/.zprofile (его читает ЛЮБАЯ оболочка входа zsh) и в rc-файлы,
# где её не было. Менять ли что-то — решаем по числу файлов с нашей отметкой до и после:
# так «ОБНОВЛЕНО» не печатается, если дописывать было нечего.
marks() {
  local n=0 f
  for f in "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bash_profile"; do
    if grep -qF 'HAMIDUN_LOCAL_BIN' "$f" 2>/dev/null; then n=$((n + 1)); fi
  done
  echo "$n"
}
BEFORE="$(marks)"
persist_local_bin_zprofile
persist_local_bin_path
AFTER="$(marks)"

hm_fresh_shell_run i "$PROBE" >/dev/null 2>&1
RC2=$?
PROFILE="$(hm_login_profile_name)"
if [ "$RC2" -eq 0 ]; then
  echo "ОБНОВЛЕНО: новое окно Терминала не находило $NAMES — дописал PATH в $PROFILE, теперь находит (уже открытые окна подхватят после перезапуска)"
elif [ "$AFTER" -gt "$BEFORE" ]; then
  echo "ОБНОВЛЕНО: дописал PATH в $PROFILE, но новое окно Терминала всё равно не находит $NAMES — проверь ~/.zshrc (ZDOTDIR?) или выполни вручную: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $PROFILE"
else
  hm_touchup_skip "новое окно Терминала не находит $NAMES, а строка PATH в профиле уже есть — проверь ~/.zshrc (ZDOTDIR?)"
fi
hm_touchup_end
