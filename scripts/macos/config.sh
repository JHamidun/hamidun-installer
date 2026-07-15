#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

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
  echo "  [dry-run] WOULD: копия-бэкап ~/.claude → ~/.claude.backup.<stamp> (сейф-нет, КОПИЯ, НЕ move; неполнота не фатальна)"
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
  if ! have git; then echo "Встроенный конфиг не найден и Git недоступен — выберите Git или пересоберите установщик."; exit 1; fi
  URL="${HM_CONFIG_REPO_URL:-https://github.com/JHamidun/claude-code-config-pack}"
  BRANCH="${HM_CONFIG_REPO_BRANCH:-main}"
  CLONE="$HOME/.hamidun-setup/config-repo"
  if [ -d "$CLONE/.git" ]; then
    echo "Обновляю конфиг с GitHub..."
    git -C "$CLONE" fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1
    git -C "$CLONE" reset --hard "origin/$BRANCH" >/dev/null 2>&1
  else
    echo "Скачиваю конфиг с GitHub ($URL)..."
    mkdir -p "$(dirname "$CLONE")"
    git clone --depth 1 -b "$BRANCH" "$URL" "$CLONE"
  fi
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
if [ -d "$CLAUDE_HOME" ]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  BACKUP_DIR="$CLAUDE_HOME.backup.$STAMP"
  echo "Резервная копия ~/.claude → $BACKUP_DIR ..."
  if cp -R "$CLAUDE_HOME" "$BACKUP_DIR" 2>/dev/null; then
    SRC_N=$(find "$CLAUDE_HOME" 2>/dev/null | wc -l | tr -d ' ')
    DST_N=$(find "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d ' ')
    if [ "${DST_N:-0}" -lt "${SRC_N:-0}" ]; then
      echo "ВНИМАНИЕ: неполный бэкап ~/.claude (часть файлов недоступна). НЕ критично: оригинал НЕ переносится и не стирается — данные на месте. Продолжаю."
    fi
  else
    echo "ВНИМАНИЕ: бэкап ~/.claude снять не удалось. НЕ критично: оригинал ~/.claude на месте (не переносится/не стирается). Продолжаю."
  fi
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

# === Merge-copy НАШЕЙ базы ПОВЕРХ ~/.claude (БЕЗ переноса/стирания) ===
# add-missing: rsync --ignore-existing (существующее не трогаем) / hm_copy missing.
# repair:      rsync без --ignore-existing (перезапись наших базовых) / hm_copy overwrite.
# preserve-list (--exclude globs / case) исключает пользовательское в ОБОИХ режимах.
# Коды возврата НЕ маскируются (`|| true` не используем) — сбой = COPY_FAILED.
if [ "$ADDITIVE" -eq 1 ]; then
  echo "Добавляю только НЕДОСТАЮЩИЕ файлы конфига (существующее сохраняю)..."
  if command -v rsync >/dev/null 2>&1; then
    if ! rsync -a --ignore-existing $PRESERVE_FILE_GLOBS $PRESERVE_DIR_GLOBS $SKILLS_EXCLUDE "$SRC_CLAUDE/" "$CLAUDE_HOME/"; then
      COPY_FAILED=1
    fi
  else
    hm_copy "$SRC_CLAUDE" "$CLAUDE_HOME" missing || COPY_FAILED=1
  fi
else
  echo "Переустановка начисто: перезаписываю НАШИ базовые файлы свежими (пользовательское — ключи/память/история/CLAUDE.md — не трогаю)..."
  if command -v rsync >/dev/null 2>&1; then
    if ! rsync -a $PRESERVE_FILE_GLOBS $PRESERVE_DIR_GLOBS $SKILLS_EXCLUDE "$SRC_CLAUDE/" "$CLAUDE_HOME/"; then
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
  STARTER_DST="$HOME/HamidunStart"
  if [ -e "$STARTER_DST" ]; then
    echo "Стартовый проект уже есть: $STARTER_DST — не перезаписываю."
  else
    echo "Копирую стартовый проект в $STARTER_DST..."
    if cp -R "$HM_ASSETS/starter-project" "$STARTER_DST" 2>/dev/null; then
      echo "Стартовый проект создан: $STARTER_DST"
    else
      echo "Стартовый проект не скопировался — пропускаю."
    fi
  fi
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
  echo "OK: конфиг развёрнут. Заполни ~/.claude/.credentials.master.env"
  exit 0
fi
echo "Конфиг не развернулся (~/.claude пуст) — смотри лог выше (rc=$RC)."
exit 1
