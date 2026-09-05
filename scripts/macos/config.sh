#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# Под GUI/Electron PATH урезан до /usr/bin:/bin:/usr/sbin:/sbin (launchd не читает
# /etc/paths.d и профили шеллов), и до сих пор это был ЕДИНСТВЕННЫЙ рабочий скрипт
# без такой строки — node.sh/claude.sh/verify.sh её уже имеют. Без неё процесс не
# видит ни node/npx (/usr/local/bin — туда кладёт node.pkg), ни claude (~/.local/bin —
# туда кладёт claude.sh), ни brew-инструменты. Критично для setup_runtime.py ниже:
# он ищет npx и claude через shutil.which, то есть по PATH ИМЕННО ЭТОГО процесса, —
# и с урезанным PATH молча пропускал регистрацию маркетплейсов плагинов («плагины
# подтянутся при первом запуске» — а сами не подтягиваются) и браузер Playwright.
# Ровно та болезнь, что ловили на Windows: плагины включены, но не установлены.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# === РЕДИЗАЙН: config НИКОГДА не стирает и не переносит ~/.claude ===
# Пользовательские данные ОСТАЮТСЯ НА МЕСТЕ. Мы лишь раскладываем НАШУ базу ПОВЕРХ
# существующего ~/.claude копированием (merge), НИКОГДА не делая mv всего дерева. Два режима:
#   add-missing (HM_ADDITIVE=1) — rsync --ignore-existing / hm_copy (missing): докладываем
#                                 ТОЛЬКО отсутствующие файлы; существующее НЕ трогаем.
#   repair      (HM_ADDITIVE≠1) — rsync без --ignore-existing / hm_copy (overwrite):
#                                 перезаписываем НАШИ базовые файлы свежими.
# В ОБОИХ режимах preserve-list (--exclude globs / case) защищает ключи, память, историю,
# локальные настройки и ~/CLAUDE.md — не перезаписываются даже в repair. Механизм
# snapshot/restore/rescue УДАЛЁН — без wipe он не нужен (именно wipe в инциденте затирал
# реальный ~/.claude). Полная копия-бэкап делается первой операцией как сейф-нет; её
# неполнота НЕ фатальна (оригинал на месте). Режим решает MAIN и сообщает через HM_ADDITIVE.
ADDITIVE=0
[ "${HM_ADDITIVE:-}" = "1" ] && ADDITIVE=1
CLAUDE_HOME="$HOME/.claude"
RC=0
COPY_FAILED=0
PRUNE_DISABLED=0   # сбой перечисления/копирования → прунинг ПОЛНОСТЬЮ выключен
PRE_EXISTING_SKILLS=""

# --- источник конфига (dry-run ветвится ДО clone/fetch/reset/chmod) ---
BUNDLED="${HM_BUNDLED_CONFIG:-}"
HAVE_BUNDLED=0
[ -n "$BUNDLED" ] && [ -f "$BUNDLED/install.sh" ] && HAVE_BUNDLED=1

if [ -n "${HM_DRY_RUN:-}" ]; then
  if [ "$HAVE_BUNDLED" -eq 1 ]; then
    echo "  [dry-run] Источник: встроенный конфиг (офлайн) $BUNDLED"
  else
    echo "  [dry-run] WOULD: git clone/fetch конфига с GitHub (в dry-run НЕ выполняется)"
  fi
  echo "  [dry-run] WOULD: копия-бэкап ~/.claude → ~/.claude.backup.<stamp> (сейф-нет, КОПИЯ, НЕ move; неполнота не фатальна; секреты — ключи/tg-сессия — в бэкап НЕ кладутся)"
  if [ "$ADDITIVE" -eq 1 ]; then
    echo "  [dry-run] WOULD (add-missing): скопировать ТОЛЬКО недостающие файлы (существующее НЕ трогать); ~/.claude НЕ переносится и не стирается; preserve-list исключён"
  else
    echo "  [dry-run] WOULD (repair): перезаписать НАШИ базовые файлы свежими, пользовательское (ключи/память/история/settings.local/CLAUDE.md) исключено; БЕЗ mv/wipe"
  fi
  echo "[dry-run] Конфиг: без изменений."
  exit 0
fi

if [ "$HAVE_BUNDLED" -eq 1 ]; then
  echo "Использую встроенный конфиг (офлайн): $BUNDLED"
  CLONE="$BUNDLED"
else
  # #13: НЕ запускаем /usr/bin/git-шим на чистом маке без Command Line Tools (он сам
  # открывает GUI-диалог «установить инструменты разработчика»). Предпочитаем портативный
  # git.sh (~/.local/bin/git), иначе рабочий git (не шим ИЛИ CLT установлены).
  GIT_BIN=""
  if [ -x "$HOME/.local/bin/git" ]; then GIT_BIN="$HOME/.local/bin/git";
  elif have git && { [ "$(command -v git)" != "/usr/bin/git" ] || xcode-select -p >/dev/null 2>&1; }; then GIT_BIN="$(command -v git)"; fi
  if [ -z "$GIT_BIN" ]; then echo "Встроенный конфиг не найден и рабочий Git недоступен — выберите компонент Git или пересоберите установщик офлайн."; exit 1; fi
  # Источник конфига разворачивается в ~/.claude (settings.json + hooks), поэтому URL из
  # окружения принимаем ТОЛЬКО как https://github.com/... — второй рубеж к авторитетному
  # override в main (renderer не должен уводить клон на чужой хост). Всё остальное —
  # откат на источник по умолчанию, а не clone откуда попало.
  URL_DEFAULT="https://github.com/JHamidun/claude-code-config-pack"
  URL="${HM_CONFIG_REPO_URL:-$URL_DEFAULT}"
  case "$URL" in
    https://github.com/?*) ;;
    *) echo "ВНИМАНИЕ: источник конфига ($URL) не с https://github.com/ — использую источник по умолчанию."; URL="$URL_DEFAULT" ;;
  esac
  BRANCH="${HM_CONFIG_REPO_BRANCH:-main}"
  CLONE="$HOME/.hamidun-setup/config-repo"
  # #7: НЕ доверяем ранее существующему репо — атакующий (medium, тот же юзер) мог
  # пред-создать $CLONE/.git с core.fsmonitor/hooksPath = payload → code-exec под нашим
  # git. Всегда СВЕЖИЙ clone + hardening-флаги (командные -c перебивают repo-local).
  rm -rf "$CLONE"
  echo "Скачиваю конфиг с GitHub ($URL)..."
  mkdir -p "$(dirname "$CLONE")"
  # credential.helper ПУСТОЙ + запрет интерактива: иначе помощник кредов (в macOS это
  # osxkeychain, а при установленном GCM — графическое окно) при любом отказе доступа
  # ждёт ввода, и установка виснет ВЕЧНО. Репозиторий конфига публичный: запрос
  # кредов = сломанная ситуация, правильный исход — быстро упасть с ошибкой.
  "$GIT_BIN" -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.symlinks=false -c credential.helper= -c credential.interactive=false clone --depth 1 -b "$BRANCH" "$URL" "$CLONE"
fi

# Раскладываем из клонированного/вшитого source САМИ (merge-копией), НЕ через install.sh
# (его --backup делает mv всего ~/.claude — именно этот wipe удалён).
SRC_CLAUDE="$CLONE/.claude"
SRC_CLAUDE_MD="$CLONE/CLAUDE.md"
[ -d "$SRC_CLAUDE" ] || { echo "Источник конфига (.claude) не найден: $SRC_CLAUDE"; exit 1; }
echo "Разворачиваю .claude в домашнюю папку..."

# preserve-list — ПОЛЬЗОВАТЕЛЬСКОЕ, НИКОГДА не перезаписываем (ни в add-missing, ни в repair).
# Glob-aware: chats.db* (FTS5 + -wal/-shm/-journal), tg_session.session* (+ -wal/-shm/-journal).
# settings.json (НАШ базовый) в список НЕ входит: add-missing в обычном, overwrite в repair.
# ~/CLAUDE.md обрабатывается отдельно (только-если-нет). Каталоги memory/projects/todos/
# shell-snapshots — пользовательский рантайм.
PRESERVE_FILE_GLOBS="--exclude=.credentials.master.env --exclude=.credentials.json --exclude=settings.local.json --exclude=MEMORY.md --exclude=chats.db* --exclude=tg_session.session*"
PRESERVE_DIR_GLOBS="--exclude=memory/ --exclude=projects/ --exclude=todos/ --exclude=shell-snapshots/"

# === Полная копия-бэкап ~/.claude — сейф-нет, ПЕРВАЯ операция (КОПИЯ, не move) ===
# ВАЖНО: неполный бэкап НЕ фатален — оригинал ~/.claude НЕ переносится и не стирается,
# данные на месте. Предупреждаем и ПРОДОЛЖАЕМ (это иначе, чем раньше, где бэкап был
# единственной копией перед wipe).
# СЕКРЕТЫ В БЭКАП НЕ КЛАДЁМ (зеркало config.ps1: robocopy /XF в бэкапе): копий хранится
# 3 ротируемых, то есть ключи и telegram-сессия РАЗМНОЖАЛИСЬ БЫ в трёх экземплярах рядом
# с ~/.claude. Список исключений — РОВНО тот же, что в Windows-версии:
# .credentials.master.env, .credentials.json, tg_session.session* (глоб покрывает
# -wal/-shm/-journal). Оригиналы остаются в ~/.claude нетронутыми (preserve-list merge их
# не перезаписывает) — бэкап без них полноценно выполняет роль сейф-нета.
BACKUP_EXCLUDES="--exclude=.credentials.master.env --exclude=.credentials.json --exclude=tg_session.session*"
if [ -d "$CLAUDE_HOME" ]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  BACKUP_DIR="$CLAUDE_HOME.backup.$STAMP"
  echo "Резервная копия ~/.claude → $BACKUP_DIR (без ключей и tg-сессии; храню 3 последние, старые удаляю)..."
  BACKUP_OK=0
  if command -v rsync >/dev/null 2>&1; then
    rsync -a $BACKUP_EXCLUDES "$CLAUDE_HOME/" "$BACKUP_DIR/" 2>/dev/null && BACKUP_OK=1
  else
    # Fallback без rsync: cp -R копирует ВСЁ, затем вычищаем секреты из КОПИИ тем же
    # списком (robocopy /XF режет имена на любой глубине — find -name делает то же).
    if cp -R "$CLAUDE_HOME" "$BACKUP_DIR" 2>/dev/null; then
      if find "$BACKUP_DIR" \( -name '.credentials.master.env' -o -name '.credentials.json' -o -name 'tg_session.session*' \) -exec rm -f {} + 2>/dev/null; then
        BACKUP_OK=1
      else
        # Секреты вычистить не удалось — бэкап с ключами держать нельзя (fail-closed).
        rm -rf "$BACKUP_DIR" 2>/dev/null
        echo "ВНИМАНИЕ: не удалось исключить секреты из бэкапа — копия удалена (оригинал ~/.claude цел)."
      fi
    fi
  fi
  if [ "$BACKUP_OK" -eq 1 ]; then
    # Сверка полноты считает источник БЕЗ исключённых секретов — иначе каждый бэкап
    # с ключами ложно рапортовал бы «неполный».
    SRC_N=$(find "$CLAUDE_HOME" ! -name '.credentials.master.env' ! -name '.credentials.json' ! -name 'tg_session.session*' 2>/dev/null | wc -l | tr -d ' ')
    DST_N=$(find "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d ' ')
    if [ "${DST_N:-0}" -lt "${SRC_N:-0}" ]; then
      echo "ВНИМАНИЕ: неполный бэкап ~/.claude (часть файлов недоступна). НЕ критично: оригинал НЕ переносится и не стирается — данные на месте. Продолжаю."
    fi
  else
    echo "ВНИМАНИЕ: бэкап ~/.claude снять не удалось. НЕ критично: оригинал ~/.claude на месте (не переносится/не стирается). Продолжаю."
  fi
  # Ретенция: держим 3 ПОСЛЕДНИЕ копии. Без неё каждый прогон (repair/повтор/ручной
  # перезапуск) оставлял полную копию ~/.claude навсегда — гигабайты, о которых юзер не
  # знает и которые никто не чистит (деинсталляция config не поддерживается). Имена —
  # $CLAUDE_HOME.backup.<YYYYMMDD-HHMMSS>, лексикографический sort = хронологический.
  ls -d "$CLAUDE_HOME".backup.* 2>/dev/null | sort -r | tail -n +4 | while IFS= read -r old; do
    case "$old" in
      "$CLAUDE_HOME".backup.*) [ -d "$old" ] && rm -rf "$old" ;;
    esac
  done
fi

# hm_copy — копирование из вшитого/клонированного source ПОВЕРХ ~/.claude, БЕЗ переноса.
# mode=missing  → копировать ТОЛЬКО отсутствующие в цели файлы (add-missing);
# mode=overwrite → перезаписывать существующие НАШИ базовые файлы (repair).
# В ОБОИХ режимах preserve-list (case) исключён — пользовательское не трогаем.
# Fallback без rsync: НЕ cp -Rn (GNU coreutils ≥9.2 трактует пропуск как ошибку) —
# явный per-file цикл с ЧЕСТНОЙ агрегацией кода возврата.
hm_copy() {
  local src="$1" dst="$2" mode="$3" rc=0 list rel d
  list="$(mktemp "${TMPDIR:-/tmp}/hm-copylist.XXXXXX" 2>/dev/null)" || return 1
  if ! ( cd "$src" && find . -type f ) > "$list" 2>/dev/null; then
    rm -f "$list"; return 1   # перечисление источника сбойнуло → провал копирования
  fi
  while IFS= read -r rel; do
    rel="${rel#./}"
    [ -z "$rel" ] && continue
    case "/$rel" in
      */.credentials.master.env|*/.credentials.json|*/settings.local.json|*/MEMORY.md) continue ;;
      */chats.db*|*/tg_session.session*) continue ;;
      */memory/*|*/projects/*|*/todos/*|*/shell-snapshots/*) continue ;;
    esac
    # skills — reparse point (симлинк/junction)? НЕ пишем сквозь ссылку (cp ушёл бы во внешнюю
    # цель). $SKILLS_REPARSE — глобал, выставляется до вызова hm_copy.
    if [ "${SKILLS_REPARSE:-0}" -eq 1 ]; then
      case "/$rel" in */skills/*) continue ;; esac
    fi
    if [ "$mode" = "missing" ] && [ -e "$dst/$rel" ]; then continue; fi   # add-missing: существующее не трогаем
    d="$(dirname "$dst/$rel")"
    mkdir -p "$d" || { rc=1; continue; }
    cp -p "$src/$rel" "$dst/$rel" || rc=1
  done < "$list"
  rm -f "$list"
  return $rc
}

mkdir -p "$CLAUDE_HOME"

# Какие скиллы БЫЛИ до раскладки — для консервативного прунинга (fail-closed при сбое).
# Файл списка — ТОЛЬКО через mktemp (не предсказуемое имя в world-writable /tmp),
# не симлинк, чистится через trap; перечисление обязано пройти ПОЛНОСТЬЮ успешно.
PRE_EXISTING_SKILLS="$(mktemp "${TMPDIR:-/tmp}/hm-preskills.XXXXXX" 2>/dev/null)" || PRE_EXISTING_SKILLS=""
if [ -z "$PRE_EXISTING_SKILLS" ]; then
  PRUNE_DISABLED=1
  echo "  Не удалось создать временный файл списка скиллов — прунинг паков отключён (ничего не удаляем)."
elif [ -L "$PRE_EXISTING_SKILLS" ]; then
  PRUNE_DISABLED=1; rm -f "$PRE_EXISTING_SKILLS" 2>/dev/null; PRE_EXISTING_SKILLS=""
  echo "  Временный файл списка скиллов оказался симлинком — прунинг паков отключён (ничего не удаляем)."
else
  trap '[ -n "$PRE_EXISTING_SKILLS" ] && rm -f "$PRE_EXISTING_SKILLS"' EXIT
  if [ -d "$CLAUDE_HOME/skills" ]; then
    if [ -L "$CLAUDE_HOME/skills" ]; then
      PRUNE_DISABLED=1
      echo "  ~/.claude/skills — симлинк, перечисление небезопасно — прунинг паков отключён."
    # ВСЕ immediate-дети, ВКЛЮЧАЯ симлинки и файлы (find -type d терял symlink-детей →
    # пред-существующий symlink-скилл считался «нашим» и удалялся).
    elif ! find "$CLAUDE_HOME/skills" -mindepth 1 -maxdepth 1 -exec basename {} \; > "$PRE_EXISTING_SKILLS"; then
      PRUNE_DISABLED=1
      echo "  Перечисление существующих скиллов сбойнуло — прунинг паков отключён (ничего не удаляем)."
    fi
  fi
fi

# skills корень ИЛИ дочерний skill — симлинк/junction? Тогда merge НЕЛЬЗЯ пускать в skills:
# rsync/cp пойдут ПО ссылке и в repair перезапишут ВНЕШНЮЮ цель (data-loss). Исключаем skills.
SKILLS_REPARSE=0
if [ -L "$CLAUDE_HOME/skills" ]; then
  SKILLS_REPARSE=1
elif [ -d "$CLAUDE_HOME/skills" ]; then
  # ВСЕ дети, включая скрытые (dot): *, .[!.]*, ..?*. Иначе skills/.foo → external
  # (symlink) не заметили бы и merge прошёл бы сквозь него (Codex regate #3).
  # Нераскрытый glob остаётся литералом → [ -L литерал ] = false (нет ложных срабатываний);
  # .[!.]* и ..?* НЕ матчат сами "." и ".." (нужен непустой хвост).
  for _c in "$CLAUDE_HOME/skills"/* "$CLAUDE_HOME/skills"/.[!.]* "$CLAUDE_HOME/skills"/..?*; do
    [ -L "$_c" ] && { SKILLS_REPARSE=1; break; }
  done
fi
SKILLS_EXCLUDE=""
if [ "$SKILLS_REPARSE" -eq 1 ]; then
  SKILLS_EXCLUDE="--exclude=/skills"   # rsync: не трогать skills (внешняя цель за ссылкой цела)
  echo "  ~/.claude/skills — симлинк/junction: пропускаю skills в раскладке (внешняя цель не тронута)."
fi

# Правило «не писать СКВОЗЬ ссылку» действует НЕ только на skills — зеркало config.ps1,
# где исключаются ВСЕ непосредственные дети ~/.claude, помеченные reparse point.
# Пакет везёт agents, commands, rules, hooks, tools, config, templates… и любой из них
# человек мог слинковать на свой dotfiles-репозиторий (`ln -s`). Здесь проверялся один
# skills, поэтому rsync в repair шёл по такой ссылке и перезаписывал файлы ВО ВНЕШНЕЙ
# цели — в его же рабочем репозитории, молча и без следа в выводе.
# Нераскрытый glob остаётся литералом → `[ -L литерал ]` ложно, лишних исключений нет.
REPARSE_EXCLUDE=""
for _kid in "$CLAUDE_HOME"/* "$CLAUDE_HOME"/.[!.]* "$CLAUDE_HOME"/..?*; do
  if [ -L "$_kid" ]; then
    _kn=$(basename "$_kid")
    if [ "$_kn" != "skills" ]; then      # skills уже покрыт SKILLS_EXCLUDE выше
      REPARSE_EXCLUDE="$REPARSE_EXCLUDE --exclude=/$_kn"
      echo "  ~/.claude/$_kn — ссылка: пропускаю в раскладке (внешняя цель не тронута)."
    fi
  fi
done

# === Merge-copy НАШЕЙ базы ПОВЕРХ ~/.claude (БЕЗ переноса/стирания) ===
# add-missing: rsync --ignore-existing (существующее не трогаем) / hm_copy missing.
# repair:      rsync без --ignore-existing (перезапись наших базовых) / hm_copy overwrite.
# preserve-list (--exclude globs / case) исключает пользовательское в ОБОИХ режимах.
# Коды возврата НЕ маскируются (`|| true` не используем) — сбой = COPY_FAILED.
if [ "$ADDITIVE" -eq 1 ]; then
  echo "Добавляю только НЕДОСТАЮЩИЕ файлы конфига (существующее сохраняю)..."
  if command -v rsync >/dev/null 2>&1; then
    if ! rsync -a --ignore-existing $PRESERVE_FILE_GLOBS $PRESERVE_DIR_GLOBS $SKILLS_EXCLUDE $REPARSE_EXCLUDE "$SRC_CLAUDE/" "$CLAUDE_HOME/"; then
      COPY_FAILED=1
    fi
  else
    hm_copy "$SRC_CLAUDE" "$CLAUDE_HOME" missing || COPY_FAILED=1
  fi
else
  echo "Переустановка начисто: перезаписываю НАШИ базовые файлы свежими (пользовательское — ключи/память/история/CLAUDE.md — не трогаю)..."
  if command -v rsync >/dev/null 2>&1; then
    if ! rsync -a $PRESERVE_FILE_GLOBS $PRESERVE_DIR_GLOBS $SKILLS_EXCLUDE $REPARSE_EXCLUDE "$SRC_CLAUDE/" "$CLAUDE_HOME/"; then
      COPY_FAILED=1
    fi
  else
    hm_copy "$SRC_CLAUDE" "$CLAUDE_HOME" overwrite || COPY_FAILED=1
  fi
fi

# settings.json — НАШ базовый: add-missing (rsync --ignore-existing пропускает существующий) /
# перезапись в repair. settings.local.json (пользовательский) — в preserve-list, цел всегда.

# CLAUDE.md в корне профиля — ПОЛЬЗОВАТЕЛЬСКИЙ: добавляем ТОЛЬКО если отсутствует (в ОБОИХ
# режимах — не затираем правки юзера даже в repair). Сбой копирования → COPY_FAILED.
if [ -f "$SRC_CLAUDE_MD" ] && [ ! -f "$HOME/CLAUDE.md" ]; then
  cp "$SRC_CLAUDE_MD" "$HOME/CLAUDE.md" || { COPY_FAILED=1; echo "ВНИМАНИЕ: не удалось скопировать ~/CLAUDE.md."; }
fi
# credentials-шаблон — только если ключей ещё нет (в ОБОИХ режимах: preserve-list).
if [ -f "$CLONE/.credentials.template.env" ] && [ ! -f "$CLAUDE_HOME/.credentials.master.env" ]; then
  cp "$CLONE/.credentials.template.env" "$CLAUDE_HOME/.credentials.master.env" || { COPY_FAILED=1; echo "ВНИМАНИЕ: не удалось скопировать шаблон credentials."; }
fi

if [ "$COPY_FAILED" -eq 1 ]; then
  RC=1; PRUNE_DISABLED=1
  echo "ВНИМАНИЕ: копирование файлов конфига завершилось с ошибками — прунинг паков отключён, установка будет помечена как неудачная."
else
  if [ "$ADDITIVE" -eq 1 ]; then
    echo "Готово: добавлено недостающее, существующее сохранено."
  else
    echo "Готово: наши базовые файлы обновлены, пользовательские данные (ключи/память/история) на месте."
  fi
fi

# Список скиллов, разложенных НАМИ (накопительный) — зеркало .hamidun-skills.txt из
# config.ps1:191,303. Пишем ПОСЛЕ успешной раскладки и только при валидном перечислении
# пред-существующих: имя, которого не было в skills до merge, а после merge появилось —
# наше. Прошлые записи сохраняем (список накопительный, иначе он забудет позавчерашнее).
# Сбой записи не фатален: без файла прунинг просто останется консервативным, как раньше.
OUR_PREV_LIST="$CLAUDE_HOME/.hamidun-skills.txt"
if [ "$COPY_FAILED" -eq 0 ] && [ "$PRUNE_DISABLED" -eq 0 ] \
   && [ -n "$PRE_EXISTING_SKILLS" ] && [ -f "$PRE_EXISTING_SKILLS" ] && [ -d "$CLAUDE_HOME/skills" ]; then
  OUR_NOW="$(mktemp "${TMPDIR:-/tmp}/hm-ourskills.XXXXXX" 2>/dev/null)" || OUR_NOW=""
  if [ -n "$OUR_NOW" ] && [ ! -L "$OUR_NOW" ]; then
    [ -f "$OUR_PREV_LIST" ] && cat "$OUR_PREV_LIST" >> "$OUR_NOW" 2>/dev/null
    for _sd in "$CLAUDE_HOME/skills"/*/; do
      [ -d "$_sd" ] || continue
      [ -L "${_sd%/}" ] && continue          # ссылку мы не клали
      _sn=$(basename "$_sd")
      if ! grep -qxF "$_sn" "$PRE_EXISTING_SKILLS" 2>/dev/null; then echo "$_sn" >> "$OUR_NOW"; fi
    done
    if sort -u "$OUR_NOW" > "$OUR_PREV_LIST.tmp" 2>/dev/null && mv -f "$OUR_PREV_LIST.tmp" "$OUR_PREV_LIST" 2>/dev/null; then :; else
      rm -f "$OUR_PREV_LIST.tmp" 2>/dev/null || true
    fi
  fi
  [ -n "$OUR_NOW" ] && rm -f "$OUR_NOW" 2>/dev/null
fi

# --- фильтрация скиллов по выбранным наборам (пакам) ---
# fail-closed: PRUNE_DISABLED (mktemp/симлинк/перечисление/копирование сбойнули) или RC!=0
# → прунинг НЕ выполняется вовсе. В add-missing скилл без ЗАПИСИ в списке считается
# пред-существующим ТОЛЬКО при валидном списке; без списка не удаляем ничего.
if [ -n "${HM_KEEP_SKILLS:-}" ] && [ -n "${HM_ALL_PACK_SKILLS:-}" ]; then
  if [ "$PRUNE_DISABLED" -eq 1 ] || [ "$RC" -ne 0 ]; then
    echo "Прунинг паков пропущен (fail-closed): раскладка/перечисление не подтверждены. Удалено: 0."
  else
    SK="$HOME/.claude/skills"
    # symlink-проверка skills-каталога: ссылка на месте ~/.claude/skills уводит rm -rf в ЧУЖУЮ цель.
    if [ -L "$SK" ]; then
      echo "Прунинг паков пропущен (fail-closed): ~/.claude/skills — симлинк (перечисление небезопасно). Удалено: 0."
    elif [ -d "$SK" ]; then
      # ДВА прохода: сперва собираем кандидатов БЕЗ удалений, затем удаляем.
      # grep по файлу списка различает rc: 0 = пред-существующий; 1 = не найден;
      # >=2 (EIO и т.п.) = сбой чтения → остановить прунинг ЦЕЛИКОМ ДО первого удаления.
      PRUNE_LIST=""
      PRUNE_ABORT=0
      for d in "$SK"/*/; do
        [ -d "$d" ] || continue
        name=$(basename "$d")
        # Симлинк-скилл НИКОГДА не удаляем: rm -rf по ссылке с хвостовым слэшем
        # уходит в ЧУЖУЮ цель, и симлинк по определению не «доложен нами».
        [ -L "${d%/}" ] && continue
        # В ОБОИХ режимах не удаляем скиллы, бывшие ДО нашей раскладки (не наши — не трогаем,
        # даже в repair). PRE_EXISTING_SKILLS собран до merge в любом режиме; сбой сбора →
        # PRUNE_DISABLED → сюда не доходим. we_added=1 ТОЛЬКО при валидном списке
        # пред-существующих и отсутствии имени в нём (пустой список = skills не было = всё наше).
        we_added=1
        if [ -n "$PRE_EXISTING_SKILLS" ] && [ -f "$PRE_EXISTING_SKILLS" ]; then
          grep -qxF "$name" "$PRE_EXISTING_SKILLS"
          g=$?
          if [ "$g" -eq 0 ]; then
            we_added=0
            # …но «пред-существующий» может означать «положен НАМИ в прошлый прогон».
            # Без этой поправки снятие набора работало ровно ОДИН раз — на чистой машине:
            # во второй раз наши вчерашние скиллы уже лежат в skills, попадают в список
            # пред-существующих, we_added=0 — и прунинг молча не удаляет ничего, хотя
            # человек набор снял. На Windows такой список ведётся (.hamidun-skills.txt,
            # config.ps1:191), на mac его просто не было.
            if [ -f "$OUR_PREV_LIST" ] && grep -qxF "$name" "$OUR_PREV_LIST" 2>/dev/null; then
              we_added=1
            fi
          elif [ "$g" -ge 2 ]; then
            PRUNE_ABORT=1; break
          fi
        else
          we_added=0   # списка нет → считаем пред-существующим → не удаляем
        fi
        if [ "$we_added" -eq 1 ] && printf ',%s,' "$HM_ALL_PACK_SKILLS" | grep -q ",$name," && ! printf ',%s,' "$HM_KEEP_SKILLS" | grep -q ",$name,"; then
          PRUNE_LIST="${PRUNE_LIST}${name}
"
        fi
      done
      if [ "$PRUNE_ABORT" -eq 1 ]; then
        echo "Прунинг паков пропущен (fail-closed): сбой чтения списка пред-существующих скиллов. Удалено: 0."
      else
        removed=0
        while IFS= read -r name; do
          [ -z "$name" ] && continue
          rm -rf "$SK/$name"; removed=$((removed + 1))
        done <<PRUNE_EOF
$PRUNE_LIST
PRUNE_EOF
        echo "Скиллы отфильтрованы по выбранным наборам (убрано: $removed)."
      fi
    fi
  fi
fi

# --- стартовый проект из вшитых ассетов (идемпотентно: существующий НЕ перезаписываем) ---
if [ -n "${HM_ASSETS:-}" ] && [ -d "$HM_ASSETS/starter-project" ]; then
  STARTER_SRC="$HM_ASSETS/starter-project"
  STARTER_DST="$HOME/HamidunStart"
  # ДОКЛАДЫВАЕМ НЕДОСТАЮЩЕЕ, а не пропускаем папку целиком (зеркало config.ps1).
  # Раньше было «папка есть → не перезаписываю», и человек оставался БЕЗ файлов:
  # ~/HamidunStart появляется не только отсюда — её создаёт пустой кнопка «Открыть
  # VS Code» (main.js делает mkdir перед запуском редактора), могла оставить прошлая
  # установка, мог создать сам человек. Дальше памятка говорит «открой PROMPTS.md» —
  # а его там нет, и ученик пишет «извини, я не нахожу файл».
  # Существующие файлы НЕ трогаем (в них могла быть работа человека), отсутствующие кладём.
  [ -d "$STARTER_DST" ] || mkdir -p "$STARTER_DST" 2>/dev/null
  if [ -d "$STARTER_DST" ]; then
    ST_ADDED=0; ST_KEPT=0; ST_FAILED=0
    while IFS= read -r f; do
      rel="${f#$STARTER_SRC/}"
      dst="$STARTER_DST/$rel"
      if [ -e "$dst" ]; then ST_KEPT=$((ST_KEPT + 1)); continue; fi
      mkdir -p "$(dirname "$dst")" 2>/dev/null
      if cp -p "$f" "$dst" 2>/dev/null; then ST_ADDED=$((ST_ADDED + 1)); else ST_FAILED=$((ST_FAILED + 1)); fi
    done <<EOF
$(find "$STARTER_SRC" -type f 2>/dev/null)
EOF
    if [ "$ST_ADDED" -gt 0 ] && [ "$ST_KEPT" -eq 0 ]; then
      echo "Стартовый проект создан: $STARTER_DST (файлов: $ST_ADDED)"
    elif [ "$ST_ADDED" -gt 0 ]; then
      echo "Стартовый проект дополнен: $STARTER_DST (добавлено: $ST_ADDED, твоё не тронуто: $ST_KEPT)"
    elif [ "$ST_KEPT" -gt 0 ]; then
      echo "Стартовый проект уже полный: $STARTER_DST — ничего не менял."
    fi
    [ "$ST_FAILED" -gt 0 ] && echo "  ВНИМАНИЕ: не удалось скопировать файлов: $ST_FAILED"
    # Памятка прямым текстом велит открыть PROMPTS.md — проверяем именно его.
    if [ ! -e "$STARTER_DST/PROMPTS.md" ]; then
      echo "  ВНИМАНИЕ: PROMPTS.md в $STARTER_DST не появился."
      echo "  Возьми его вручную: $STARTER_SRC"
    fi
  fi
else
  # Раньше отсутствие ассетов проходило совершенно молча.
  echo "Стартовый проект НЕ создан: не найдены вшитые ассеты (HM_ASSETS не задан или в нём нет starter-project)."
  echo "  Памятка ссылается на PROMPTS.md из этой папки — без неё первый шаг не выполнить."
fi

# --- честная проверка развёртывания (зеркало config.ps1) ---
DEPLOYED=0
if [ -d "$CLAUDE_HOME/skills" ] || [ -f "$CLAUDE_HOME/settings.json" ]; then DEPLOYED=1; fi

# Ненулевой код раскладки — не выдаём ложный зелёный. Пользовательские данные НЕ тронуты
# (мы их не переносим/не стираем), поэтому даже при сбое они на месте.
if [ "$RC" -ne 0 ]; then
  echo "ВНИМАНИЕ: раскладка конфига завершилась с ошибкой (rc=$RC) — конфиг мог обновиться НЕ полностью."
  if [ "$DEPLOYED" -eq 1 ]; then
    echo "~/.claude на месте; твои ключи, память и история сессий НЕ тронуты. Запусти установку повторно после устранения причины."
  else
    echo "~/.claude пуст — конфиг не развернулся. Смотри лог выше."
  fi
  exit 1
fi

if [ "$DEPLOYED" -eq 1 ]; then
  # --- РАНТАЙМ: то, что живёт НЕ в файлах (зеркало config.ps1) ---------------------------
  # Разложить файлы — ещё не «конфиг работает». Три вещи существуют только как состояние
  # машины, и копирование их не создаёт: бинарь браузера Playwright (пакет python ставит
  # pydeps, БРАУЗЕР — нет; на него завязаны 42 скилла), регистрация маркетплейсов плагинов
  # (объявлено 29, но свежая машина не знает, откуда их брать) и node_modules скилла
  # dev-browser. Именно это ученики и «донастраивали сами».
  # Лечение уже ехало в паке и вызывалось из install.sh — но ТЕМ маршрутом ставят с
  # GitHub, а через установщик раскладку делает ЭТОТ скрипт, и здесь вызова не было.
  RUNTIME_SCRIPT="$CLAUDE_HOME/scripts/setup_runtime.py"
  if [ -f "$RUNTIME_SCRIPT" ]; then
    # Ищем python и ПО PATH, и ПО АБСОЛЮТНЫМ ПУТЯМ (зеркало блока python в config.ps1).
    # Здесь две ловушки, из-за которых голый `command -v python3` даёт не то:
    # 1) /usr/bin/python3 на маке БЕЗ Command Line Tools — не интерпретатор, а шим,
    #    который при запуске открывает системный GUI-диалог «установить инструменты
    #    разработчика» и не возвращается (аналог Store-заглушки WindowsApps на Windows).
    #    Берём его ТОЛЬКО когда CLT реально стоят (xcode-select -p) — тогда это обычный
    #    рабочий python. Тот же гвард уже используют pydeps.sh и git-детект выше.
    # 2) python из компонента «Python-пакеты» живёт в /Library/Frameworks — его bin
    #    НЕ попадает в PATH этого процесса никогда (профиль-апдейтер python.org пишет
    #    только в ~/.zprofile будущих терминалов), поэтому его ищем по абсолютным путям.
    PY_RT=""
    P3="$(command -v python3 2>/dev/null || true)"
    if [ -n "$P3" ] && { [ "$P3" != "/usr/bin/python3" ] || xcode-select -p >/dev/null 2>&1; }; then
      PY_RT="$P3"
    fi
    if [ -z "$PY_RT" ]; then
      for _p in /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
                /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
                /Library/Frameworks/Python.framework/Versions/3.11/bin/python3; do
        [ -x "$_p" ] && { PY_RT="$_p"; break; }
      done
    fi
    if [ -z "$PY_RT" ]; then
      # Последний шанс — голый `python` (pyenv и т.п.); системного /usr/bin/python
      # на современных macOS нет, но гвард оставляем по той же логике, что выше.
      P2="$(command -v python 2>/dev/null || true)"
      [ -n "$P2" ] && [ "$P2" != "/usr/bin/python" ] && PY_RT="$P2"
    fi
    if [ -n "$PY_RT" ]; then
      echo ""
      echo "Довожу рантайм: браузер Playwright, маркетплейсы плагинов, node_modules..."
      # Зеркало config.ps1: скрипт печатает значки ✔ ✓ ✗, а вывод перенаправлен. На маке
      # локаль обычно UTF-8, но под launchd её может не быть вовсе (LANG не задан) —
      # тогда Python берёт ASCII и валится на первом же значке, обрывая доводку.
      if ! PYTHONIOENCODING=utf-8 PYTHONUTF8=1 "$PY_RT" "$RUNTIME_SCRIPT"; then
        echo "  Рантайм доехал НЕ полностью — часть скиллов упадёт при первом запуске."
        echo "  Что именно: $PY_RT \"$RUNTIME_SCRIPT\" --check"
        echo "  Доделать:   $PY_RT \"$RUNTIME_SCRIPT\""
      fi
    else
      # На ПЕРВОЙ чистой установке это штатная ситуация: python ставит компонент
      # «Python-пакеты», а он идёт в очереди ПОСЛЕ конфига (pydeps requires config).
      echo "Python не найден — рантайм пока не доведён (браузер Playwright и плагины)."
      echo "  Python ставится следующим компонентом («Python-пакеты»); после него запусти:"
      echo "  python3 \"$RUNTIME_SCRIPT\""
    fi
  fi

  # #19: маркер завершённости (зеркало config.ps1) — детекция в main.js смотрит на него,
  # а не на одну папку skills, чтобы оборванная установка не выглядела завершённой.
  : > "$CLAUDE_HOME/.hamidun-config-complete" 2>/dev/null || true
  echo "OK: конфиг развёрнут. Заполни ~/.claude/.credentials.master.env"
  exit 0
fi
echo "Конфиг не развернулся (~/.claude пуст) — смотри лог выше (rc=$RC)."
exit 1
