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
  # Таймауты обязательны: curl без --max-time на РФ-DPI виснет молча навсегда.
  CUR=$(curl -fsSL --connect-timeout 20 --max-time 900 --retry 3 --retry-connrefused "https://www.cursor.com/api/download?platform=darwin-$(arch_tag)&releaseTrack=stable" \
    | grep -o '"downloadUrl"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
    | sed -e 's/.*:[[:space:]]*"\([^"]*\)".*/\1/' -e 's#\\/#/#g' || true)
  DMG="/tmp/cursor.dmg"
  # Сносим протухший /tmp/cursor.dmg от прерванного прежнего запуска — иначе при
  # неудачном парсинге URL (CUR пуст, dl пропущен) старый битый файл прошёл бы проверку ниже.
  rm -f "$DMG"
  # set -e здесь нет — без явного чека провал скачивания молча дошёл бы до attach/установки.
  if [ -n "$CUR" ]; then dl "$CUR" "$DMG" || exit 1; fi
fi
[ -f "$DMG" ] || { echo "Cursor: установщик недоступен (сеть недоступна или очень медленная — повтори установку этого компонента)."; exit 1; }
[ "$BUNDLED" = 1 ] && verify_artifact "$DMG"  # вшитый артефакт — сверяем SHA-256 (fail-closed)

MNT="/tmp/hm_cursor_mnt"
# Отцепляем возможный примонтированный образ от прерванного прогона, иначе attach
# упадёт или мы скопируем содержимое старого образа.
/usr/bin/hdiutil detach "$MNT" 2>/dev/null || true
mkdir -p "$MNT"
if ! /usr/bin/hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null; then
  echo "Не смог открыть образ Cursor (dmg повреждён?)."; exit 1
fi
APP=$(/bin/ls "$MNT" | grep -i '\.app$' | head -1)
# Пустой APP → admin_run скопировал бы мусор и зря спросил пароль администратора.
if [ -z "$APP" ]; then
  echo "В образе Cursor не найдено приложение (.app)."
  /usr/bin/hdiutil detach "$MNT" >/dev/null 2>&1 || true
  exit 1
fi

# --- verify + install АТОМАРНО под root на root-owned staged копии (Codex round-4 P1) ---
# Онлайн-DMG в /tmp мог подменить процесс ТОГО ЖЕ пользователя; имя .app из образа —
# НЕ доверенное. Раньше подпись проверялась medium'ом СНАРУЖИ admin_run, а cp шёл root'ом
# ВНУТРИ: пока открыт пароль-промпт, same-user мог detach mount и подсунуть чужой .app.
# Теперь ОДИН admin_run под root (HM_APP_INSTALL_SH): cp .app с mount в root-owned staging
# (0700) -> codesign -R (designated requirement с ТОЧНЫМ Team ID; крипто-оценка подписи,
# не парсинг -dv) + spctl (нотаризация) на STAGED -> cp staged .app в /Applications.
# Между verify и cp окна нет; detach mount после этого уже не влияет (работаем с копией).
# Инструменты — абсолютные внутри скрипта; нет/не исполняемы -> fail-CLOSED. Team ID и имя
# бандла — ПОЗИЦИОННЫЕ параметры (не интерполяция), инъекция через имя .app невозможна.
# Team ID издателя Cursor. Подтверждено сетью (2026-07): Cursor.app подписан Developer ID
# с TeamIdentifier=VDXQ22DGB9 (ToDesktop-сборка Anysphere; источники:
#   forum.cursor.com/t/why-is-cursor-app-signed-by-hilary-stout/67551 — codesign output
#     "Authority=Developer ID Application: Hilary Stout (VDXQ22DGB9)", TeamIdentifier=VDXQ22DGB9;
#   appcatalog.cloud/apps/cursor — code requirement "certificate leaf[subject.OU] = VDXQ22DGB9").
# TODO-verify: если Anysphere переподпишет приложение СВОИМ Team ID, вентиль даст
# fail-closed стоп (лучше пропустить установку, чем поставить неподтверждённое) —
# тогда обновить CURSOR_TEAM_ID по свежему codesign-output официального DMG.
CURSOR_TEAM_ID='VDXQ22DGB9'
echo "Проверяю подпись и копирую $APP в /Applications (потребуется пароль администратора)..."
if ! admin_run /bin/sh -c "$HM_APP_INSTALL_SH" hm_app_install "$MNT/$APP" "$CURSOR_TEAM_ID" "$APP"; then
  echo "Cursor: подпись/нотаризация не подтверждены или копирование не удалось (fail-closed)."
  /usr/bin/hdiutil detach "$MNT" >/dev/null 2>&1 || true
  exit 1
fi
/usr/bin/hdiutil detach "$MNT" >/dev/null || true

[ -d "/Applications/Cursor.app" ] && { echo "OK: Cursor установлен."; exit 0; }
echo "Cursor не установился."; exit 1
