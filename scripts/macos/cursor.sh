#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

echo "Проверяю Cursor..."
if [ -d "/Applications/Cursor.app" ]; then echo "Cursor уже установлен."; exit 0; fi

if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/cursor.dmg" ]; then
  DMG="$HM_VENDOR/apps/cursor.dmg"; echo "Cursor из встроенного dmg (офлайн)..."
else
  echo "Скачиваю Cursor (darwin-$(arch_tag))..."
  CUR=$(curl -fsSL "https://www.cursor.com/api/download?platform=darwin-$(arch_tag)&releaseTrack=stable" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin).get("downloadUrl",""))' 2>/dev/null)
  DMG="/tmp/cursor.dmg"
  [ -n "$CUR" ] && dl "$CUR" "$DMG"
fi
[ -f "$DMG" ] || { echo "Cursor: установщик недоступен."; exit 1; }

MNT="/tmp/hm_cursor_mnt"
mkdir -p "$MNT"
hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null
APP=$(/bin/ls "$MNT" | grep -i '\.app$' | head -1)
echo "Копирую $APP в /Applications (потребуется пароль администратора)..."
admin_run "cp -R '$MNT/$APP' /Applications/"
hdiutil detach "$MNT" >/dev/null || true

[ -d "/Applications/Cursor.app" ] && { echo "OK: Cursor установлен."; exit 0; }
echo "Cursor не установился."; exit 1
