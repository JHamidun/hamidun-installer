#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

echo "Проверяю Cursor..."
if [ -d "/Applications/Cursor.app" ]; then echo "Cursor уже установлен."; exit 0; fi

BUNDLED=0
if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/cursor.dmg" ]; then
  DMG="$HM_VENDOR/apps/cursor.dmg"; BUNDLED=1; echo "Cursor из встроенного dmg (офлайн)..."
else
  echo "Скачиваю Cursor (darwin-$(arch_tag))..."
  # Парсим downloadUrl без python (bare python3 без CLT дёргает GUI-диалог).
  # Берём первую пару "downloadUrl": "..." и снимаем возможное JSON-экранирование \/.
  CUR=$(curl -fsSL "https://www.cursor.com/api/download?platform=darwin-$(arch_tag)&releaseTrack=stable" \
    | grep -o '"downloadUrl"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
    | sed -e 's/.*:[[:space:]]*"\([^"]*\)".*/\1/' -e 's#\\/#/#g' || true)
  DMG="/tmp/cursor.dmg"
  [ -n "$CUR" ] && dl "$CUR" "$DMG"
fi
[ -f "$DMG" ] || { echo "Cursor: установщик недоступен."; exit 1; }
[ "$BUNDLED" = 1 ] && verify_artifact "$DMG"  # вшитый артефакт — сверяем SHA-256 (fail-closed)

MNT="/tmp/hm_cursor_mnt"
mkdir -p "$MNT"
hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null
APP=$(/bin/ls "$MNT" | grep -i '\.app$' | head -1)
echo "Копирую $APP в /Applications (потребуется пароль администратора)..."
admin_run "cp -R '$MNT/$APP' /Applications/"
hdiutil detach "$MNT" >/dev/null || true

[ -d "/Applications/Cursor.app" ] && { echo "OK: Cursor установлен."; exit 0; }
echo "Cursor не установился."; exit 1
