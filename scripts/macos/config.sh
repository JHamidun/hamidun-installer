#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

BUNDLED="${HM_BUNDLED_CONFIG:-}"
if [ -n "$BUNDLED" ] && [ -f "$BUNDLED/install.sh" ]; then
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
echo "Разворачиваю .claude в домашнюю папку (с бэкапом, без Python-зависимостей)..."
chmod +x "$CLONE/install.sh" 2>/dev/null || true

# Аддитивная доустановка ПОВЕРХ существующего ~/.claude (HM_ADDITIVE=1): добавляем
# только НЕДОСТАЮЩЕЕ, НЕ затирая пользовательские кастомизации.
ADDITIVE=0
[ "${HM_ADDITIVE:-}" = "1" ] && ADDITIVE=1
PRE_EXISTING_SKILLS="${TMPDIR:-/tmp}/hamidun-preexisting-skills.txt"

# Dry-run: ничего не пишем (паритет с config.ps1 — ранний выход ДО снапшота/раскладки).
if [ -n "${HM_DRY_RUN:-}" ]; then
  if [ "$ADDITIVE" -eq 1 ]; then
    echo "  [dry-run] WOULD (аддитивно): бэкап ~/.claude, скопировать ТОЛЬКО недостающие файлы из $CLONE/.claude (существующее НЕ трогать, settings.json НЕ перезаписывать; прунинг паков не трогает ранее бывшие скиллы)"
  else
    echo "  [dry-run] WOULD: bash $CLONE/install.sh --backup --skip-deps (+ фильтр паков по HM_KEEP_SKILLS)"
  fi
  echo "[dry-run] Конфиг: источник '$CLONE', без изменений."
  exit 0
fi

# --- защита пользовательских данных при ПОВТОРНОЙ установке ---
# install.sh кладёт свежую базу поверх ~/.claude. Сохраняем пользовательские данные
# (ключи, накопленную память, историю сессий projects/, локальные настройки) ДО и
# возвращаем merge-ом ПОСЛЕ. Общий конфиг (skills/agents/commands/rules/settings.json)
# НЕ сохраняем — он должен обновиться.
CLAUDE_HOME="$HOME/.claude"
PRESERVE_DIR="${TMPDIR:-/tmp}/hamidun-preserve"
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

# сперва вернуть данные ПРЕРВАННОГО прошлого прогона — краш между снапшотом и restore
# мог оставить в снапшоте ЕДИНСТВЕННУЮ копию реальных ключей; не потеряем их.
if [ -d "$PRESERVE_DIR" ] && [ -n "$(ls -A "$PRESERVE_DIR" 2>/dev/null)" ]; then
  echo "Обнаружен снапшот прерванной установки — восстанавливаю..."
  restore_user_data "$PRESERVE_DIR"
fi
echo "Сохраняю твои ключи, память и историю сессий перед обновлением..."
snapshot_user_data "$PRESERVE_DIR"

RC=0
if [ "$ADDITIVE" -eq 1 ]; then
  # === АДДИТИВНАЯ доустановка ПОВЕРХ существующего ~/.claude — НЕ затираем ===
  SRC_CLAUDE="$CLONE/.claude"
  SRC_CLAUDE_MD="$CLONE/CLAUDE.md"
  if [ ! -d "$SRC_CLAUDE" ]; then
    echo "Источник конфига (.claude) не найден: $SRC_CLAUDE"; RC=1
  else
    # 1) Полный таймштамп-бэкап ~/.claude ДО изменений (fail-closed при нехватке места).
    if [ -d "$CLAUDE_HOME" ]; then
      STAMP=$(date +%Y%m%d-%H%M%S)
      BACKUP_DIR="$CLAUDE_HOME.backup.$STAMP"
      echo "Аддитивный режим: резервная копия ~/.claude → $BACKUP_DIR ..."
      if cp -R "$CLAUDE_HOME" "$BACKUP_DIR" 2>/dev/null; then
        SRC_N=$(find "$CLAUDE_HOME" 2>/dev/null | wc -l | tr -d ' ')
        DST_N=$(find "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d ' ')
        if [ "${DST_N:-0}" -lt "${SRC_N:-0}" ]; then
          echo "ВНИМАНИЕ: неполный бэкап ~/.claude (возможно, кончилось место) — аддитивная доустановка ОТМЕНЕНА."; exit 1
        fi
      else
        echo "ВНИМАНИЕ: не удалось сделать бэкап ~/.claude — аддитивная доустановка ОТМЕНЕНА."; exit 1
      fi
    fi
    mkdir -p "$CLAUDE_HOME"

    # 2) Какие скиллы БЫЛИ до раскладки (для консервативного прунинга).
    : > "$PRE_EXISTING_SKILLS" 2>/dev/null || true
    if [ -d "$CLAUDE_HOME/skills" ]; then
      for d in "$CLAUDE_HOME/skills"/*/; do [ -d "$d" ] && basename "$d"; done >> "$PRE_EXISTING_SKILLS" 2>/dev/null || true
    fi

    # 3) Merge-copy ТОЛЬКО недостающих файлов. rsync --ignore-existing НЕ перезаписывает
    #    существующие (кастомизации юзера, settings.json); без rsync — cp -Rn (no-clobber).
    echo "Добавляю только НЕДОСТАЮЩИЕ файлы конфига (существующее сохраняю)..."
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --ignore-existing \
        --exclude='.credentials.master.env' --exclude='.credentials.json' \
        --exclude='settings.local.json' --exclude='MEMORY.md' \
        --exclude='chats.db*' --exclude='tg_session.session*' \
        --exclude='memory/' --exclude='projects/' --exclude='todos/' --exclude='shell-snapshots/' \
        "$SRC_CLAUDE/" "$CLAUDE_HOME/"
    else
      cp -Rn "$SRC_CLAUDE/." "$CLAUDE_HOME/" 2>/dev/null || true
    fi

    # settings.json НЕ перезаписываем (rsync --ignore-existing / cp -n сохранили
    # существующий). Semver-мерж JSON намеренно не делаем — консервативно.

    # CLAUDE.md в корне профиля — только если отсутствует (не затираем правки юзера).
    if [ -f "$SRC_CLAUDE_MD" ] && [ ! -f "$HOME/CLAUDE.md" ]; then cp "$SRC_CLAUDE_MD" "$HOME/CLAUDE.md"; fi
    # credentials-шаблон — только если ключей ещё нет.
    if [ -f "$CLONE/.credentials.template.env" ] && [ ! -f "$CLAUDE_HOME/.credentials.master.env" ]; then
      cp "$CLONE/.credentials.template.env" "$CLAUDE_HOME/.credentials.master.env"
    fi
    echo "Аддитивная доустановка: добавлено недостающее, существующее сохранено."
  fi
else
  bash "$CLONE/install.sh" --backup --skip-deps
  RC=$?
fi

# --- фильтрация скиллов по выбранным наборам (пакам) ---
if [ -n "${HM_KEEP_SKILLS:-}" ] && [ -n "${HM_ALL_PACK_SKILLS:-}" ]; then
  SK="$HOME/.claude/skills"
  if [ -d "$SK" ]; then
    removed=0
    for d in "$SK"/*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      # В АДДИТИВНОМ режиме не удаляем скиллы, бывшие ДО нашей раскладки (не наши —
      # не трогаем). Удаляем только доложенное этим прогоном и чей пак снят.
      we_added=1
      if [ "$ADDITIVE" -eq 1 ] && [ -f "$PRE_EXISTING_SKILLS" ] && grep -qxF "$name" "$PRE_EXISTING_SKILLS"; then we_added=0; fi
      if [ "$we_added" -eq 1 ] && printf ',%s,' "$HM_ALL_PACK_SKILLS" | grep -q ",$name," && ! printf ',%s,' "$HM_KEEP_SKILLS" | grep -q ",$name,"; then
        rm -rf "$d"; removed=$((removed + 1))
      fi
    done
    echo "Скиллы отфильтрованы по выбранным наборам (убрано: $removed)."
  fi
fi

# --- вернуть пользовательские данные поверх свежей базы (merge) ---
restore_user_data "$PRESERVE_DIR"
rm -rf "$PRESERVE_DIR"
echo "Вернул твои ключи, память и историю сессий."

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

# Ненулевой код install.sh — не выдаём ложный зелёный: существующий ~/.claude мог
# остаться от ПРОШЛОЙ установки, а обновление на самом деле упало.
if [ "$RC" -ne 0 ]; then
  echo "ВНИМАНИЕ: install.sh завершился с ошибкой (rc=$RC) — конфиг мог НЕ обновиться."
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
echo "Конфиг не развернулся (~/.claude пуст) — смотри лог выше (install.sh rc=$RC)."
exit 1
