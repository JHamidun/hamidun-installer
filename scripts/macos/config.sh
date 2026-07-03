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

bash "$CLONE/install.sh" --backup --skip-deps
RC=$?

# --- фильтрация скиллов по выбранным наборам (пакам) ---
if [ -n "${HM_KEEP_SKILLS:-}" ] && [ -n "${HM_ALL_PACK_SKILLS:-}" ]; then
  SK="$HOME/.claude/skills"
  if [ -d "$SK" ]; then
    removed=0
    for d in "$SK"/*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      if printf ',%s,' "$HM_ALL_PACK_SKILLS" | grep -q ",$name," && ! printf ',%s,' "$HM_KEEP_SKILLS" | grep -q ",$name,"; then
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
if [ -d "$CLAUDE_HOME/skills" ] || [ -f "$CLAUDE_HOME/settings.json" ]; then
  echo "OK: конфиг развёрнут. Заполни ~/.claude/.credentials.master.env"
  exit 0
fi
echo "Конфиг не развернулся (~/.claude пуст) — смотри лог выше (install.sh rc=$RC)."
exit 1
