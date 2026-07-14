#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# P0-1: аддитивная доустановка ПОВЕРХ существующего ~/.claude (HM_ADDITIVE=1):
# добавляем только НЕДОСТАЮЩЕЕ, НЕ затирая пользовательские кастомизации.
# HM_ADDITIVE ставит АВТОРИТЕТНО main.js (живой детекцией ФС, fail-safe → additive);
# при HM_ADDITIVE base install.sh (перезапись свежей базой) НЕ запускается.
ADDITIVE=0
[ "${HM_ADDITIVE:-}" = "1" ] && ADDITIVE=1
CLAUDE_HOME="$HOME/.claude"

# --- источник конфига (P1-8: dry-run ветвится ДО clone/fetch/reset/chmod) ---
BUNDLED="${HM_BUNDLED_CONFIG:-}"
HAVE_BUNDLED=0
[ -n "$BUNDLED" ] && [ -f "$BUNDLED/install.sh" ] && HAVE_BUNDLED=1

if [ -n "${HM_DRY_RUN:-}" ]; then
  if [ "$HAVE_BUNDLED" -eq 1 ]; then
    echo "  [dry-run] Источник: встроенный конфиг (офлайн) $BUNDLED"
  else
    echo "  [dry-run] WOULD: git clone/fetch конфига с GitHub (в dry-run НЕ выполняется)"
  fi
  if [ "$ADDITIVE" -eq 1 ]; then
    echo "  [dry-run] WOULD (аддитивно): полный таймштамп-бэкап ~/.claude ПЕРВОЙ операцией, скопировать ТОЛЬКО недостающие файлы (существующее НЕ трогать, settings.json НЕ перезаписывать, БЕЗ snapshot/restore hamidun-preserve; прунинг паков fail-closed)"
  else
    echo "  [dry-run] WOULD: полный таймштамп-бэкап ~/.claude, bash install.sh --backup --skip-deps (+ фильтр паков по HM_KEEP_SKILLS)"
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

[ -f "$CLONE/install.sh" ] || { echo "В конфиге нет install.sh."; exit 1; }
echo "Разворачиваю .claude в домашнюю папку..."
chmod +x "$CLONE/install.sh" 2>/dev/null || true

# === P0-2: ПОЛНЫЙ таймштамп-бэкап ~/.claude — ПЕРВАЯ операция, трогающая ~/.claude ===
# КОПИЯ (не move), в ОБОИХ режимах. Неполный бэкап → fail-closed: ничего не меняем.
if [ -d "$CLAUDE_HOME" ]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  BACKUP_DIR="$CLAUDE_HOME.backup.$STAMP"
  echo "Резервная копия ~/.claude → $BACKUP_DIR ..."
  if cp -R "$CLAUDE_HOME" "$BACKUP_DIR" 2>/dev/null; then
    SRC_N=$(find "$CLAUDE_HOME" 2>/dev/null | wc -l | tr -d ' ')
    DST_N=$(find "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d ' ')
    if [ "${DST_N:-0}" -lt "${SRC_N:-0}" ]; then
      echo "ВНИМАНИЕ: неполный бэкап ~/.claude (возможно, кончилось место) — установка конфига ОТМЕНЕНА, ничего не менял."; exit 1
    fi
  else
    echo "ВНИМАНИЕ: не удалось сделать бэкап ~/.claude — установка конфига ОТМЕНЕНА, ничего не менял."; exit 1
  fi
fi

# --- защита пользовательских данных при ЧИСТОЙ переустановке (НЕ additive) ---
# install.sh кладёт свежую базу поверх ~/.claude. Сохраняем пользовательские данные
# ДО и возвращаем merge-ом ПОСЛЕ. P0-2: снапшот живёт в ~/.hamidun-setup/preserve
# (user-owned; НЕ предсказуемый и не world-writable /tmp). В АДДИТИВНОМ режиме
# snapshot/restore НЕ используются вовсе (живое дерево не трогаем).
PRESERVE_DIR="$HOME/.hamidun-setup/preserve"
PRESERVE_FILES=".credentials.master.env .credentials.json settings.local.json"
PRESERVE_DIRS="memory projects todos shell-snapshots"

snapshot_user_data() {
  mkdir -p "$1"
  for f in $PRESERVE_FILES; do [ -f "$CLAUDE_HOME/$f" ] && cp -f "$CLAUDE_HOME/$f" "$1/$f"; done
  for d in $PRESERVE_DIRS; do [ -d "$CLAUDE_HOME/$d" ] && { rm -rf "$1/$d"; cp -R "$CLAUDE_HOME/$d" "$1/$d"; }; done
}
restore_user_data() {
  mkdir -p "$CLAUDE_HOME"
  for f in $PRESERVE_FILES; do [ -f "$1/$f" ] && cp -f "$1/$f" "$CLAUDE_HOME/$f"; done
  for d in $PRESERVE_DIRS; do [ -d "$1/$d" ] && { mkdir -p "$CLAUDE_HOME/$d"; cp -R "$1/$d/." "$CLAUDE_HOME/$d/"; }; done
}
# P0-2: восстановление СТАРОГО снапшота — ТОЛЬКО недостающих файлов (никогда не льём
# старые значения KEY=OLD поверх живых KEY=NEW). Нужно для rescue после краша прошлого
# прогона МЕЖДУ wipe и restore (файлов в живом дереве нет — они вернутся).
restore_user_data_missing_only() {
  mkdir -p "$CLAUDE_HOME"
  for f in $PRESERVE_FILES; do
    [ -f "$1/$f" ] && [ ! -e "$CLAUDE_HOME/$f" ] && cp "$1/$f" "$CLAUDE_HOME/$f"
  done
  for d in $PRESERVE_DIRS; do
    [ -d "$1/$d" ] || continue
    ( cd "$1/$d" 2>/dev/null && find . -type f 2>/dev/null ) | while IFS= read -r rel; do
      rel="${rel#./}"
      [ -e "$CLAUDE_HOME/$d/$rel" ] && continue
      mkdir -p "$(dirname "$CLAUDE_HOME/$d/$rel")" 2>/dev/null
      cp "$1/$d/$rel" "$CLAUDE_HOME/$d/$rel" 2>/dev/null
    done
  done
  return 0
}

# P1-6: копирование ТОЛЬКО недостающих файлов с ЧЕСТНОЙ агрегацией ошибок.
# Fallback без rsync: НЕ cp -Rn (GNU coreutils ≥9.2 трактует пропуск существующего
# как ошибку, BSD — нет; коды несравнимы) — явный per-file цикл с кодом возврата.
hm_copy_missing() {
  local src="$1" dst="$2" rc=0 list rel d
  list="$(mktemp "${TMPDIR:-/tmp}/hm-copylist.XXXXXX" 2>/dev/null)" || return 1
  if ! ( cd "$src" && find . -type f ) > "$list" 2>/dev/null; then
    rm -f "$list"; return 1   # перечисление источника сбойнуло → провал копирования
  fi
  while IFS= read -r rel; do
    rel="${rel#./}"
    [ -z "$rel" ] && continue
    case "/$rel" in
      */.credentials.master.env|*/.credentials.json|*/settings.local.json|*/MEMORY.md) continue ;;
      */chats.db|*/chats.db-*|*/tg_session.session|*/tg_session.session-*) continue ;;
      */memory/*|*/projects/*|*/todos/*|*/shell-snapshots/*) continue ;;
    esac
    [ -e "$dst/$rel" ] && continue                 # существующее НЕ перезаписываем
    d="$(dirname "$dst/$rel")"
    mkdir -p "$d" || { rc=1; continue; }
    cp -p "$src/$rel" "$dst/$rel" || rc=1
  done < "$list"
  rm -f "$list"
  return $rc
}

RC=0
COPY_FAILED=0
PRUNE_DISABLED=0   # P0-3: сбой перечисления/копирования → прунинг ПОЛНОСТЬЮ выключен
PRE_EXISTING_SKILLS=""

if [ "$ADDITIVE" -eq 1 ]; then
  # === АДДИТИВНАЯ доустановка ПОВЕРХ существующего ~/.claude — НЕ затираем ===
  # P0-2: НИКАКОГО hamidun-preserve здесь — ни restore старого снапшота, ни нового
  # снапшота. Полный таймштамп-бэкап уже сделан выше ПЕРВОЙ операцией.
  SRC_CLAUDE="$CLONE/.claude"
  SRC_CLAUDE_MD="$CLONE/CLAUDE.md"
  if [ ! -d "$SRC_CLAUDE" ]; then
    echo "Источник конфига (.claude) не найден: $SRC_CLAUDE"; RC=1
  else
    mkdir -p "$CLAUDE_HOME"

    # P0-3: какие скиллы БЫЛИ до раскладки. Файл списка — ТОЛЬКО через mktemp
    # (не фиксированное предсказуемое имя в world-writable /tmp), не симлинк,
    # чистится через trap; перечисление обязано пройти ПОЛНОСТЬЮ успешно.
    # Любой сбой (mktemp/симлинк/find) → прунинг ПОЛНОСТЬЮ выключен (fail-closed).
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
        elif ! find "$CLAUDE_HOME/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; > "$PRE_EXISTING_SKILLS"; then
          PRUNE_DISABLED=1
          echo "  Перечисление существующих скиллов сбойнуло — прунинг паков отключён (ничего не удаляем)."
        fi
      fi
    fi

    # Merge-copy ТОЛЬКО недостающих файлов. rsync --ignore-existing НЕ перезаписывает
    # существующие (кастомизации юзера, settings.json); без rsync — hm_copy_missing.
    # P1-6: коды возврата НЕ маскируются (`|| true` убран) — сбой = COPY_FAILED.
    echo "Добавляю только НЕДОСТАЮЩИЕ файлы конфига (существующее сохраняю)..."
    if command -v rsync >/dev/null 2>&1; then
      if ! rsync -a --ignore-existing \
        --exclude='.credentials.master.env' --exclude='.credentials.json' \
        --exclude='settings.local.json' --exclude='MEMORY.md' \
        --exclude='chats.db*' --exclude='tg_session.session*' \
        --exclude='memory/' --exclude='projects/' --exclude='todos/' --exclude='shell-snapshots/' \
        "$SRC_CLAUDE/" "$CLAUDE_HOME/"; then
        COPY_FAILED=1
      fi
    else
      hm_copy_missing "$SRC_CLAUDE" "$CLAUDE_HOME" || COPY_FAILED=1
    fi
    if [ "$COPY_FAILED" -eq 1 ]; then
      RC=1; PRUNE_DISABLED=1
      echo "ВНИМАНИЕ: копирование недостающих файлов завершилось с ошибками — прунинг паков отключён, установка будет помечена как неудачная."
    fi

    # settings.json НЕ перезаписываем (existing пропущен и rsync-ом, и hm_copy_missing).
    # Semver-мерж JSON намеренно не делаем — консервативно.

    # CLAUDE.md в корне профиля — только если отсутствует (не затираем правки юзера).
    if [ -f "$SRC_CLAUDE_MD" ] && [ ! -f "$HOME/CLAUDE.md" ]; then cp "$SRC_CLAUDE_MD" "$HOME/CLAUDE.md"; fi
    # credentials-шаблон — только если ключей ещё нет.
    if [ -f "$CLONE/.credentials.template.env" ] && [ ! -f "$CLAUDE_HOME/.credentials.master.env" ]; then
      cp "$CLONE/.credentials.template.env" "$CLAUDE_HOME/.credentials.master.env"
    fi
    [ "$COPY_FAILED" -eq 0 ] && echo "Аддитивная доустановка: добавлено недостающее, существующее сохранено."
  fi
else
  # === Чистая установка: свежая база поверх (кастомизаций не было / подтверждённый repair) ===
  # Легаси-снапшот в ${TMPDIR:-/tmp}/hamidun-preserve НЕ восстанавливаем автоматически
  # (P0-2: предсказуемый world-writable путь; старые значения не льём) — только сообщаем.
  LEGACY_PRESERVE="${TMPDIR:-/tmp}/hamidun-preserve"
  if [ -d "$LEGACY_PRESERVE" ] && [ -n "$(ls -A "$LEGACY_PRESERVE" 2>/dev/null)" ]; then
    echo "ВНИМАНИЕ: найден снапшот старого установщика: $LEGACY_PRESERVE — он НЕ восстанавливается автоматически."
    echo "  Если после прошлой установки пропали ключи/память — скопируй нужные файлы оттуда вручную."
  fi
  # Снапшот ПРЕРВАННОГО прошлого прогона: возвращаем ТОЛЬКО отсутствующие файлы
  # (краш между wipe и restore — файлы пропали → вернутся; живые НЕ трогаем),
  # затем откладываем его в rescue-папку (не удаляем: там может быть единственная копия).
  if [ -d "$PRESERVE_DIR" ] && [ -n "$(ls -A "$PRESERVE_DIR" 2>/dev/null)" ]; then
    echo "Обнаружен снапшот прерванной установки — возвращаю только НЕДОСТАЮЩИЕ файлы..."
    restore_user_data_missing_only "$PRESERVE_DIR"
    RESCUE="$HOME/.hamidun-setup/preserve-rescue-$(date +%Y%m%d-%H%M%S)"
    if mv "$PRESERVE_DIR" "$RESCUE" 2>/dev/null; then echo "  Старый снапшот отложен: $RESCUE"
    else echo "  Не удалось отложить старый снапшот — оставляю на месте."; fi
  fi
  echo "Сохраняю твои ключи, память и историю сессий перед обновлением..."
  snapshot_user_data "$PRESERVE_DIR"

  bash "$CLONE/install.sh" --backup --skip-deps
  RC=$?
fi

# --- фильтрация скиллов по выбранным наборам (пакам) ---
# P0-3 fail-closed: PRUNE_DISABLED (mktemp/симлинк/перечисление/копирование сбойнули)
# → прунинг НЕ выполняется вовсе. В additive скилл без ЗАПИСИ в списке считается
# пред-существующим ТОЛЬКО при валидном списке; без списка не удаляем ничего.
if [ -n "${HM_KEEP_SKILLS:-}" ] && [ -n "${HM_ALL_PACK_SKILLS:-}" ]; then
  if [ "$ADDITIVE" -eq 1 ] && { [ "$PRUNE_DISABLED" -eq 1 ] || [ "$RC" -ne 0 ]; }; then
    echo "Прунинг паков пропущен (fail-closed): не удалось надёжно определить, что добавили мы. Удалено: 0."
  else
    SK="$HOME/.claude/skills"
    if [ -d "$SK" ]; then
      removed=0
      for d in "$SK"/*/; do
        [ -d "$d" ] || continue
        name=$(basename "$d")
        # В АДДИТИВНОМ режиме не удаляем скиллы, бывшие ДО нашей раскладки (не наши —
        # не трогаем). we_added=1 ТОЛЬКО при валидном списке пред-существующих и
        # отсутствии имени в нём; любой изъян списка выше уже отключил прунинг целиком.
        we_added=1
        if [ "$ADDITIVE" -eq 1 ]; then
          if [ -n "$PRE_EXISTING_SKILLS" ] && [ -f "$PRE_EXISTING_SKILLS" ]; then
            grep -qxF "$name" "$PRE_EXISTING_SKILLS" && we_added=0
          else
            we_added=0   # списка нет → считаем пред-существующим → не удаляем
          fi
        fi
        if [ "$we_added" -eq 1 ] && printf ',%s,' "$HM_ALL_PACK_SKILLS" | grep -q ",$name," && ! printf ',%s,' "$HM_KEEP_SKILLS" | grep -q ",$name,"; then
          rm -rf "$d"; removed=$((removed + 1))
        fi
      done
      echo "Скиллы отфильтрованы по выбранным наборам (убрано: $removed)."
    fi
  fi
fi

# --- вернуть пользовательские данные поверх свежей базы (merge) — ТОЛЬКО clean-режим ---
# P0-2: в additive живое дерево не трогали — восстанавливать нечего и НЕЛЬЗЯ.
if [ "$ADDITIVE" -ne 1 ]; then
  restore_user_data "$PRESERVE_DIR"
  rm -rf "$PRESERVE_DIR"
  echo "Вернул твои ключи, память и историю сессий."
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

# Ненулевой код раскладки — не выдаём ложный зелёный: существующий ~/.claude мог
# остаться от ПРОШЛОЙ установки, а обновление на самом деле упало.
if [ "$RC" -ne 0 ]; then
  echo "ВНИМАНИЕ: раскладка конфига завершилась с ошибкой (rc=$RC) — конфиг мог НЕ обновиться."
  if [ "$DEPLOYED" -eq 1 ]; then
    echo "~/.claude присутствует, но, возможно, от ПРОШЛОЙ установки — не считаю это успехом. Смотри лог выше."
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
