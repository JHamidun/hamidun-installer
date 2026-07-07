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
  # Сносим протухший /tmp/cursor.dmg от прерванного прежнего запуска — иначе при
  # неудачном парсинге URL (CUR пуст, dl пропущен) старый битый файл прошёл бы проверку ниже.
  rm -f "$DMG"
  [ -n "$CUR" ] && dl "$CUR" "$DMG"
fi
[ -f "$DMG" ] || { echo "Cursor: установщик недоступен."; exit 1; }
[ "$BUNDLED" = 1 ] && verify_artifact "$DMG"  # вшитый артефакт — сверяем SHA-256 (fail-closed)

MNT="/tmp/hm_cursor_mnt"
# Отцепляем возможный примонтированный образ от прерванного прогона, иначе attach
# упадёт или мы скопируем содержимое старого образа.
hdiutil detach "$MNT" 2>/dev/null || true
mkdir -p "$MNT"
if ! hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null; then
  echo "Не смог открыть образ Cursor (dmg повреждён?)."; exit 1
fi
APP=$(/bin/ls "$MNT" | grep -i '\.app$' | head -1)
# Пустой APP → admin_run скопировал бы мусор и зря спросил пароль администратора.
if [ -z "$APP" ]; then
  echo "В образе Cursor не найдено приложение (.app)."
  hdiutil detach "$MNT" >/dev/null 2>&1 || true
  exit 1
fi
echo "Копирую $APP в /Applications (потребуется пароль администратора)..."
admin_run "cp -R '$MNT/$APP' /Applications/"
hdiutil detach "$MNT" >/dev/null || true

[ -d "/Applications/Cursor.app" ] && { echo "OK: Cursor установлен."; exit 0; }
echo "Cursor не установился."; exit 1
