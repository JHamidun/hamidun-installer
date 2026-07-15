#!/usr/bin/env bash
# Claude Desktop (нативное приложение Anthropic) — macOS. ОПЦИОНАЛЬНЫЙ компонент.
#
# На macOS установка десктоп-приложения НЕЭЛЕВЕЙТЕД end-to-end (качаем .dmg, ставим
# .app в ~/Applications под своим токеном) — privesc-эскалации нет; полная изоляция от
# процессов ТОГО ЖЕ юзера без root на POSIX недостижима (нет integrity levels) —
# best-effort (mktemp 700 + проверка владельца).
#
# ГЛАВНЫЙ ГЕЙТ ЦЕЛОСТНОСТИ — подпись + нотаризация ДО установки (вместо SHA-пиннинга:
# версии десктопа меняются):
#   (a) codesign --verify --deep --strict — целостность подписи бандла;
#   (b) пин издателя: TeamIdentifier обязан быть Anthropic (Q6L2SF6YDW) И authority
#       содержит «Anthropic»;
#   (c) нотаризация: spctl --assess --type execute (вердикт Gatekeeper).
# Любой невыполненный вентиль → fail-closed skip (exit 120), НЕ ставим.
#
# Идемпотентность: приложение уже стоит → exit 0. Нет сети/скачивание/подпись не
# прошли → exit 120 (graceful). Авто-удаление чужого приложения НЕ делаем.
#
# TODO-verify (сеть): redirect-URL подтверждён (claude.ai/api/desktop/darwin/... →
#   downloads.claude.ai/.../Claude-*.dmg). Team ID Anthropic (Q6L2SF6YDW) взят из
#   публичной подписи Anthropic PBC — если у десктоп-сборки окажется другой Team ID,
#   вентиль (b) даст graceful skip; уточнить на реальном .app и при необходимости
#   поправить $CLAUDE_TEAM_ID.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh" 2>/dev/null || true
DRY="${HM_DRY_RUN:-}"

URL='https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect'
CLAUDE_TEAM_ID='Q6L2SF6YDW'
PUBLISHER='Anthropic'
APP_NAME='Claude.app'
DEST_DIR="$HOME/Applications"
DEST="$DEST_DIR/$APP_NAME"

# --- Идемпотентность ---
if [ -d "/Applications/$APP_NAME" ] || [ -d "$DEST" ]; then
  echo "Claude Desktop уже установлен — пропускаю (ничего не скачиваю)."
  exit 0
fi

if [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: скачать $URL (curl --proto '=https') в mktemp 700, hdiutil attach, codesign --verify --deep --strict + пин TeamID($CLAUDE_TEAM_ID)+authority '$PUBLISHER' + spctl --assess (нотаризация) ДО установки (fail-closed), ditto .app -> $DEST, снять карантин, detach, cleanup."
  exit 0
fi

# --- Секьюр рабочий каталог (best-effort на POSIX) ---
WORK="$(mktemp -d 2>/dev/null || true)"
if [ -z "$WORK" ] || [ ! -d "$WORK" ]; then echo "Не удалось создать временный каталог — пропускаю Claude Desktop."; exit 120; fi
chmod 700 "$WORK" 2>/dev/null || true
DMG="$WORK/Claude.dmg"
MNT="$WORK/mnt"
ATTACHED=0
cleanup() {
  [ "$ATTACHED" = "1" ] && hdiutil detach "$MNT" -quiet 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# --- 1. Скачивание по HTTPS (без http-downgrade) ---
echo "Скачиваю официальный Claude Desktop (Anthropic .dmg)..."
if ! curl -fsSL --proto '=https' --tlsv1.2 --max-time 900 -o "$DMG" "$URL"; then
  echo "Не удалось скачать Claude Desktop (нет сети?) — пропускаю. Всё остальное работает; поставь позже с claude.com/download."
  exit 120
fi
DMG_SZ=$(stat -f%z "$DMG" 2>/dev/null || stat -c%s "$DMG" 2>/dev/null || echo 0)
if [ "$DMG_SZ" -lt 20000000 ]; then echo "Скачанный .dmg слишком мал ($DMG_SZ байт) — пропускаю Claude Desktop (fail-closed)."; exit 120; fi

# --- 2. Монтируем и находим .app ---
mkdir -p "$MNT"
if ! hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" -quiet 2>/dev/null; then
  echo "Не удалось смонтировать .dmg — пропускаю Claude Desktop."
  exit 120
fi
ATTACHED=1
APP="$(find "$MNT" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n1)"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then echo "В .dmg не найден .app — пропускаю Claude Desktop."; exit 120; fi

# --- 3. ГЕЙТ ПОДПИСИ + НОТАРИЗАЦИИ ДО УСТАНОВКИ (fail-closed) ---
verify_desktop_app() {
  local app="$1"
  if ! command -v codesign >/dev/null 2>&1; then
    echo "БЕЗОПАСНОСТЬ: codesign недоступен — не могу проверить подпись. Пропускаю Claude Desktop (fail-closed)."; return 1
  fi
  if ! codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    echo "БЕЗОПАСНОСТЬ: подпись .app не прошла codesign --verify (подменён/повреждён): $app. Пропускаю (fail-closed)."; return 1
  fi
  local info; info="$(codesign -dv --verbose=4 "$app" 2>&1)"
  local team; team="$(printf '%s\n' "$info" | sed -n 's/^TeamIdentifier=//p' | head -n1)"
  if [ "$team" != "$CLAUDE_TEAM_ID" ]; then
    echo "БЕЗОПАСНОСТЬ: .app подписан НЕ ожидаемым Team ID (TeamIdentifier='${team:-нет}', ожидался $CLAUDE_TEAM_ID): $app. Пропускаю (fail-closed)."; return 1
  fi
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
echo "  Подпись Developer ID ($PUBLISHER / $CLAUDE_TEAM_ID) и нотаризация подтверждены."

# --- 4. Установка в ~/Applications (без админа), staging + свап ---
mkdir -p "$DEST_DIR"
STAGING="$DEST_DIR/.claude-desktop-staging.app"
rm -rf "$STAGING" 2>/dev/null || true
if ! ditto "$APP" "$STAGING" 2>/dev/null; then
  rm -rf "$STAGING" 2>/dev/null || true
  echo "Не удалось скопировать Claude Desktop в $DEST_DIR — пропускаю."
  exit 120
fi
# Верифицируем staging-копию ДО подмены (битая копия не должна встать).
if ! ( verify_desktop_app "$STAGING" ); then
  rm -rf "$STAGING" 2>/dev/null || true
  echo "Установка остановлена: staging-копия Claude Desktop не прошла проверку. Пропускаю (fail-closed)."
  exit 120
fi
rm -rf "$DEST" 2>/dev/null || true
if ! mv "$STAGING" "$DEST" 2>/dev/null; then
  rm -rf "$STAGING" 2>/dev/null || true
  echo "Не удалось поставить Claude Desktop в $DEST — пропускаю."
  exit 120
fi
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# Квитанция владения (для справки; авто-удаление чужого приложения НЕ делаем).
echo "HM-RECEIPT path $DEST"
echo "HM-RECEIPT teamid $CLAUDE_TEAM_ID"

echo "OK: Claude Desktop установлен в $DEST (подпись и нотаризация подтверждены)."
exit 0
