#!/usr/bin/env bash
# Claude Desktop (нативное приложение Anthropic) — macOS. ОПЦИОНАЛЬНЫЙ компонент.
#
# На macOS установка десктоп-приложения НЕЭЛЕВЕЙТЕД end-to-end (качаем .dmg, ставим
# .app в ~/Applications под своим токеном) — privesc-эскалации нет; полная изоляция от
# процессов ТОГО ЖЕ юзера без root на POSIX недостижима (нет integrity levels) —
# best-effort (mktemp 700 + проверка владельца).
#
# ГЛАВНЫЙ ГЕЙТ ЦЕЛОСТНОСТИ — подпись + нотаризация ДО установки (вместо SHA-пиннинга:
# версии десктопа меняются). Инструменты зовём по АБСОЛЮТНЫМ путям и ТРЕБУЕМ их наличие
# (нет codesign/spctl → fail-CLOSED, НЕ fail-open):
#   (a) /usr/bin/codesign --verify --deep --strict — целостность подписи бандла;
#   (b) пин ТОЧНОГО TeamIdentifier Anthropic (Q6L2SF6YDW) — крипто-пин команды-издателя,
#       НЕ подстрока authority; + точный bundle identifier (com.anthropic.claudefordesktop);
#   (c) нотаризация ОБЯЗАТЕЛЬНА: /usr/sbin/spctl --assess --type execute (Gatekeeper);
#       любой non-zero → fail-closed.
# Любой невыполненный вентиль → fail-closed skip (exit 120), НЕ ставим.
#
# Идемпотентность: приложение уже стоит → exit 0. Нет сети/скачивание/подпись не
# прошли → exit 120 (graceful). Авто-удаление чужого приложения НЕ делаем.
#
# Значения, подтверждённые сетью (2026-07): Team ID Anthropic = Q6L2SF6YDW (Developer ID
#   Application: Anthropic PBC — единый для подписанных бинарей Anthropic на macOS); bundle
#   id Claude Desktop = com.anthropic.claudefordesktop; redirect claude.ai/api/desktop/darwin/...
#   → downloads.claude.ai/.../Claude-*.dmg.
# TODO-verify (уточнение на реальном .app desktop-сборки): если у неё окажется иной Team ID
#   или bundle id, вентиль даст graceful skip (exit 120, fail-closed) — правим $CLAUDE_TEAM_ID
#   / $CLAUDE_BUNDLE_ID. Fail-closed сохраняется в любом случае (лучше пропустить, чем
#   поставить неподтверждённое).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh" 2>/dev/null || true
DRY="${HM_DRY_RUN:-}"

URL='https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect'
CODESIGN='/usr/bin/codesign'
SPCTL='/usr/sbin/spctl'
CLAUDE_TEAM_ID='Q6L2SF6YDW'
CLAUDE_BUNDLE_ID='com.anthropic.claudefordesktop'
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
  echo "  [dry-run] WOULD: скачать $URL (curl --proto '=https') в mktemp 700, hdiutil attach, $CODESIGN --verify --deep --strict + пин TeamID($CLAUDE_TEAM_ID) + bundle id($CLAUDE_BUNDLE_ID) + $SPCTL --assess (нотаризация ОБЯЗАТЕЛЬНА) ДО установки (fail-closed), ditto .app -> $DEST, снять карантин, detach, cleanup."
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
  # Инструменты — по АБСОЛЮТНЫМ путям + ТРЕБУЕМ наличие/исполняемость (нет → fail-CLOSED, НЕ fail-open).
  if [ ! -x "$CODESIGN" ]; then
    echo "БЕЗОПАСНОСТЬ: $CODESIGN недоступен/не исполняемый — не могу проверить подпись. Пропускаю Claude Desktop (fail-closed)."; return 1
  fi
  if [ ! -x "$SPCTL" ]; then
    echo "БЕЗОПАСНОСТЬ: $SPCTL недоступен/не исполняемый — не могу проверить нотаризацию. Пропускаю Claude Desktop (fail-closed)."; return 1
  fi
  if ! "$CODESIGN" --verify --deep --strict "$app" >/dev/null 2>&1; then
    echo "БЕЗОПАСНОСТЬ: подпись .app не прошла codesign --verify (подменён/повреждён): $app. Пропускаю (fail-closed)."; return 1
  fi
  local info; info="$("$CODESIGN" -dv --verbose=4 "$app" 2>&1)"
  # (b) ТОЧНЫЙ TeamIdentifier (крипто-пин команды-издателя, НЕ подстрока authority).
  local team; team="$(printf '%s\n' "$info" | sed -n 's/^TeamIdentifier=//p' | head -n1)"
  if [ "$team" != "$CLAUDE_TEAM_ID" ]; then
    echo "БЕЗОПАСНОСТЬ: .app подписан НЕ ожидаемым Team ID (TeamIdentifier='${team:-нет}', ожидался $CLAUDE_TEAM_ID): $app. Пропускаю (fail-closed)."; return 1
  fi
  # + ТОЧНЫЙ bundle identifier.
  local ident; ident="$(printf '%s\n' "$info" | sed -n 's/^Identifier=//p' | head -n1)"
  if [ "$ident" != "$CLAUDE_BUNDLE_ID" ]; then
    echo "БЕЗОПАСНОСТЬ: bundle identifier ('${ident:-нет}') != ожидаемого ($CLAUDE_BUNDLE_ID): $app. Пропускаю (fail-closed)."; return 1
  fi
  # (c) Нотаризация ОБЯЗАТЕЛЬНА (spctl вызывается ВСЕГДА; любой non-zero → fail-closed).
  if ! "$SPCTL" --assess --type execute -vv "$app" >/dev/null 2>&1; then
    echo "БЕЗОПАСНОСТЬ: нотаризация не подтверждена (spctl --assess не прошёл): $app. Пропускаю (fail-closed)."; return 1
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
