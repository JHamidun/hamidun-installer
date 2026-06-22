#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

echo "Проверяю Cursor..."
if [ -d "/Applications/Cursor.app" ]; then echo "Cursor уже установлен."; exit 0; fi

DMG="/tmp/cursor.dmg"
echo "Скачиваю Cursor ($(arch_tag))..."
dl "https://downloader.cursor.sh/mac/dmg/$(arch_tag)" "$DMG" || dl "https://downloader.cursor.sh/mac/dmg/universal" "$DMG"

MNT="/tmp/hm_cursor_mnt"
mkdir -p "$MNT"
hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null
APP=$(/bin/ls "$MNT" | grep -i '\.app$' | head -1)
echo "Копирую $APP в /Applications (потребуется пароль администратора)..."
admin_run "cp -R '$MNT/$APP' /Applications/"
hdiutil detach "$MNT" >/dev/null || true

[ -d "/Applications/Cursor.app" ] && { echo "OK: Cursor установлен."; exit 0; }
echo "Cursor не установился."; exit 1
