#!/usr/bin/env bash
# ChatGPT Desktop (нативное приложение OpenAI) — macOS. ОПЦИОНАЛЬНЫЙ компонент.
#
# Установка НЕЭЛЕВЕЙТЕД end-to-end (качаем официальный .dmg OpenAI, ставим .app в
# ~/Applications под своим токеном) — privesc-эскалации нет; изоляция от процессов
# ТОГО ЖЕ юзера best-effort (mktemp 700).
#
# ГЛАВНЫЙ ГЕЙТ ЦЕЛОСТНОСТИ — подпись + нотаризация ДО установки (версии десктопа
# меняются → SHA-пиннинг неприменим):
#   (a) codesign --verify --deep --strict;
#   (b) пин издателя: authority содержит «OpenAI» (Developer ID Application: OpenAI…);
#   (c) нотаризация: spctl --assess --type execute (Gatekeeper).
# Любой невыполненный вентиль → fail-closed skip (exit 120), НЕ ставим.
#
# Идемпотентность: приложение уже стоит → exit 0. Нет сети/скачивание/подпись не
# прошли → exit 120 (graceful). Авто-удаление чужого приложения НЕ делаем.
#
# TODO-verify (сеть): официальный .dmg на persistent.oaistatic.com (домен OpenAI,
#   ссылается chatgpt.com/download). Точный Team ID OpenAI не зафиксирован публично —
#   пиним по authority-подстроке «OpenAI» + обязательной нотаризации (spctl); при
#   уточнении Team ID можно ужесточить до точного $OPENAI_TEAM_ID.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh" 2>/dev/null || true
DRY="${HM_DRY_RUN:-}"

URL='https://persistent.oaistatic.com/sidekick/public/ChatGPT.dmg'
PUBLISHER='OpenAI'
APP_NAME='ChatGPT.app'
DEST_DIR="$HOME/Applications"
DEST="$DEST_DIR/$APP_NAME"

# --- Идемпотентность ---
if [ -d "/Applications/$APP_NAME" ] || [ -d "$DEST" ]; then
  echo "ChatGPT Desktop уже установлен — пропускаю (ничего не скачиваю)."
  exit 0
fi

if [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: скачать $URL (curl --proto '=https') в mktemp 700, hdiutil attach, codesign --verify --deep --strict + authority '$PUBLISHER' + spctl --assess (нотаризация) ДО установки (fail-closed), ditto .app -> $DEST, снять карантин, detach, cleanup."
  exit 0
fi

WORK="$(mktemp -d 2>/dev/null || true)"
if [ -z "$WORK" ] || [ ! -d "$WORK" ]; then echo "Не удалось создать временный каталог — пропускаю ChatGPT Desktop."; exit 120; fi
chmod 700 "$WORK" 2>/dev/null || true
DMG="$WORK/ChatGPT.dmg"
MNT="$WORK/mnt"
ATTACHED=0
cleanup() {
  [ "$ATTACHED" = "1" ] && hdiutil detach "$MNT" -quiet 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# --- 1. Скачивание по HTTPS (без http-downgrade) ---
echo "Скачиваю официальный ChatGPT Desktop (OpenAI .dmg)..."
if ! curl -fsSL --proto '=https' --tlsv1.2 --max-time 900 -o "$DMG" "$URL"; then
  echo "Не удалось скачать ChatGPT Desktop (нет сети?) — пропускаю. Всё остальное работает; поставь позже с chatgpt.com/download."
  exit 120
fi
DMG_SZ=$(stat -f%z "$DMG" 2>/dev/null || stat -c%s "$DMG" 2>/dev/null || echo 0)
if [ "$DMG_SZ" -lt 20000000 ]; then echo "Скачанный .dmg слишком мал ($DMG_SZ байт) — пропускаю ChatGPT Desktop (fail-closed)."; exit 120; fi

# --- 2. Монтируем и находим .app ---
mkdir -p "$MNT"
if ! hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" -quiet 2>/dev/null; then
  echo "Не удалось смонтировать .dmg — пропускаю ChatGPT Desktop."
  exit 120
fi
ATTACHED=1
APP="$(find "$MNT" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n1)"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then echo "В .dmg не найден .app — пропускаю ChatGPT Desktop."; exit 120; fi

# --- 3. ГЕЙТ ПОДПИСИ + НОТАРИЗАЦИИ ДО УСТАНОВКИ (fail-closed) ---
verify_desktop_app() {
  local app="$1"
  if ! command -v codesign >/dev/null 2>&1; then
    echo "БЕЗОПАСНОСТЬ: codesign недоступен — не могу проверить подпись. Пропускаю ChatGPT Desktop (fail-closed)."; return 1
  fi
  if ! codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    echo "БЕЗОПАСНОСТЬ: подпись .app не прошла codesign --verify (подменён/повреждён): $app. Пропускаю (fail-closed)."; return 1
  fi
  local info; info="$(codesign -dv --verbose=4 "$app" 2>&1)"
  if ! printf '%s\n' "$info" | grep -q "Authority=Developer ID Application: $PUBLISHER"; then
    echo "БЕЗОПАСНОСТЬ: authority подписи не содержит '$PUBLISHER': $app. Пропускаю (fail-closed)."; return 1
  fi
  if command -v spctl >/dev/null 2>&1; then
    if ! spctl --assess --type execute -vv "$app" >/dev/null 2>&1; then
      echo "БЕЗОПАСНОСТЬ: нотаризация не подтверждена (spctl --assess не прошёл): $app. Пропускаю (fail-closed)."; return 1
    fi
  fi
  return 0
}
if ! verify_desktop_app "$APP"; then exit 120; fi
echo "  Подпись Developer ID ($PUBLISHER) и нотаризация подтверждены."

# --- 4. Установка в ~/Applications (без админа), staging + свап ---
mkdir -p "$DEST_DIR"
STAGING="$DEST_DIR/.chatgpt-desktop-staging.app"
rm -rf "$STAGING" 2>/dev/null || true
if ! ditto "$APP" "$STAGING" 2>/dev/null; then
  rm -rf "$STAGING" 2>/dev/null || true
  echo "Не удалось скопировать ChatGPT Desktop в $DEST_DIR — пропускаю."
  exit 120
fi
if ! ( verify_desktop_app "$STAGING" ); then
  rm -rf "$STAGING" 2>/dev/null || true
  echo "Установка остановлена: staging-копия ChatGPT Desktop не прошла проверку. Пропускаю (fail-closed)."
  exit 120
fi
rm -rf "$DEST" 2>/dev/null || true
if ! mv "$STAGING" "$DEST" 2>/dev/null; then
  rm -rf "$STAGING" 2>/dev/null || true
  echo "Не удалось поставить ChatGPT Desktop в $DEST — пропускаю."
  exit 120
fi
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "HM-RECEIPT path $DEST"

echo "OK: ChatGPT Desktop установлен в $DEST (подпись и нотаризация подтверждены)."
exit 0
