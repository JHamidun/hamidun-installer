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

# --- защитный снапшот пользовательских данных ПЕРЕД разворачиванием ---
# При повторной установке install.sh перезаписывает наши свежие базовые файлы
# поверх пользовательских — теряются API-ключи и накопленная память.
# Снимаем снапшот ДО, вернём ПОСЛЕ. При первой установке снапшота нет — нечего восстанавливать.
CLAUDE_HOME="$HOME/.claude"
PRESERVE_DIR="${TMPDIR:-/tmp}/hamidun-preserve"
SRC_CRED="$CLAUDE_HOME/.credentials.master.env"
SRC_MEM="$CLAUDE_HOME/memory"
SNAPSHOT_TAKEN=0
if [ -f "$SRC_CRED" ] || [ -d "$SRC_MEM" ]; then
  echo "Сохраняю твои ключи и память перед обновлением..."
  rm -rf "$PRESERVE_DIR"
  mkdir -p "$PRESERVE_DIR"
  [ -f "$SRC_CRED" ] && cp -f "$SRC_CRED" "$PRESERVE_DIR/.credentials.master.env"
  [ -d "$SRC_MEM" ] && cp -R "$SRC_MEM" "$PRESERVE_DIR/memory"
  SNAPSHOT_TAKEN=1
fi

bash "$CLONE/install.sh" --backup --skip-deps

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

# --- восстановление пользовательских данных из снапшота ---
# Возвращаем ключи и память ПОВЕРХ свежих базовых файлов (merge: пользовательские
# файлы перезаписывают базовые, новые базовые файлы не удаляем).
if [ "$SNAPSHOT_TAKEN" = "1" ]; then
  mkdir -p "$CLAUDE_HOME"
  [ -f "$PRESERVE_DIR/.credentials.master.env" ] && cp -f "$PRESERVE_DIR/.credentials.master.env" "$SRC_CRED"
  if [ -d "$PRESERVE_DIR/memory" ]; then
    mkdir -p "$SRC_MEM"
    cp -R "$PRESERVE_DIR/memory/." "$SRC_MEM/"
  fi
  rm -rf "$PRESERVE_DIR"
  echo "Вернул твои ключи и память."
fi

echo "OK: конфиг развёрнут. Заполни ~/.claude/.credentials.master.env"
exit 0
