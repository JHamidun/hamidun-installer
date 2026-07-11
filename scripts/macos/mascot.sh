#!/usr/bin/env bash
# Скрепка Claude (маскот) — macOS: живой помощник поверх окон + кнопки разрешений.
# Аналог scripts/windows/mascot.ps1. Ставит ПОДПИСАННУЮ+НОТАРИЗОВАННУЮ .app из vendor
# в ~/Applications (без админа), снимает карантин, аккуратно правит хуки Claude Code,
# ставит автозапуск (LaunchAgent) и делает health-check :45832.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
DRY="${HM_DRY_RUN:-}"

# python3 нужен ТОЛЬКО для безопасной правки settings.json (валидация JSON + literal
# replace). Если его нет — правку пропускаем, скрепка пропишет хуки сама при запуске.
PY="/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
[ -x "$PY" ] || PY="$(command -v python3 2>/dev/null || true)"

# Вшитый артефакт: подписанная .app-сборка скрепки (кладёт tools/fetch-vendor-mac.sh).
MASCOT_DIR="${HM_VENDOR:-}/apps/claude-mascot"
APP="$(find "$MASCOT_DIR" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n1)"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "Скрепка не найдена в сборке ($MASCOT_DIR) — компонент собирается из подписанной mac-сборки; пересобери установщик с fetch-vendor-mac."
  exit 1
fi
APP_NAME="$(basename "$APP")"
APP_BIN="$(ls "$APP/Contents/MacOS" 2>/dev/null | head -n1)"
DEST_DIR="$HOME/Applications"
DEST="$DEST_DIR/$APP_NAME"

if [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: verify SHA-256(bin)+codesign, xattr -dr com.apple.quarantine, копия .app -> $DEST, хуки (settings.json: 127.0.0.1:VSCODE_PORT/hook -> :45832/hook, атомарно + бэкап .hm-bak), LaunchAgent автозапуск, запуск + health-check http://127.0.0.1:45832/health"
  echo "[dry-run] Скрепка: ветка выбрана, без изменений."; exit 0
fi

# 1. Целостность — двойной fail-closed вентиль:
#    (a) SHA-256 главного бинаря против vendor/checksums.json (как Confirm-HmArtifact на Windows);
#    (b) codesign --verify --deep --strict всего бандла (подпись Developer ID + нотаризация).
if [ -z "$APP_BIN" ]; then
  echo "БЕЗОПАСНОСТЬ: в .app нет исполняемого файла (Contents/MacOS пуст) — установка остановлена."; exit 1
fi
verify_artifact "$APP/Contents/MacOS/$APP_BIN"   # сам делает exit 1 при несовпадении/отсутствии манифеста
if command -v codesign >/dev/null 2>&1; then
  if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
    echo "  Подпись Developer ID подтверждена (codesign --verify)."
  else
    echo "БЕЗОПАСНОСТЬ: подпись .app не прошла проверку (codesign --verify) — файл подменён/повреждён. Установка остановлена."; exit 1
  fi
fi

# 2. Остановить работающую скрепку (bundle может быть залочен) и поставить свежую копию.
[ -n "$APP_BIN" ] && pkill -f "/Contents/MacOS/$APP_BIN" 2>/dev/null || true
sleep 1
mkdir -p "$DEST_DIR"
rm -rf "$DEST" 2>/dev/null || true
# ditto (НЕ cp -R): сохраняет символлинки/подпись/нотаризацию бандла целиком.
if ! ditto "$APP" "$DEST" 2>/dev/null; then
  echo "Не удалось скопировать скрепку в $DEST — закрой её и повтори установку."; exit 1
fi
# Снять карантин (dmg метит содержимое com.apple.quarantine) — иначе Gatekeeper заблокирует запуск.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# 3. Хуки Claude Code: конфиг-пак несёт hook-записи с плейсхолдером VSCODE_PORT в url —
# подставляем порт скрепки (45832). Безопасность (settings.json — ВЕСЬ конфиг пользователя):
#   - правим ТОЛЬКО подстроку hook-url `127.0.0.1:VSCODE_PORT/hook`;
#   - JSON валидируем до и после замены; битый файл НЕ трогаем;
#   - запись атомарная: бэкап .hm-bak -> tmp в той же папке -> валидация tmp -> mv поверх оригинала;
#   - при любом сбое оригинал остаётся нетронутым, а маркер .installed НЕ сбрасываем.
SET="$HOME/.claude/settings.json"
HOOK_OLD='127.0.0.1:VSCODE_PORT/hook'
HOOK_NEW='127.0.0.1:45832/hook'
KEEP_MARKER=0
if [ ! -f "$SET" ]; then
  echo "  ~/.claude/settings.json отсутствует — скрепка пропишет хуки сама при первом запуске."
elif [ -z "${PY:-}" ] || [ ! -x "${PY:-}" ]; then
  echo "  python3 недоступен для безопасной правки JSON — файл не тронут, хуки пропишет скрепка сама."
  KEEP_MARKER=1
else
  RC=0
  "$PY" - "$SET" "$HOOK_OLD" "$HOOK_NEW" <<'PYEOF' || RC=$?
import sys, json
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    raw = open(p, encoding="utf-8").read()
except Exception:
    sys.exit(10)          # не прочитался
try:
    json.loads(raw)
except Exception:
    sys.exit(11)          # не JSON — не трогаем
if old not in raw:
    sys.exit(3)           # плейсхолдера нет — менять нечего
newraw = raw.replace(old, new)
try:
    json.loads(newraw)
except Exception:
    sys.exit(12)          # после замены сломался — откат
open(p + ".hm-tmp", "w", encoding="utf-8").write(newraw)
sys.exit(0)
PYEOF
  case "$RC" in
    0)
      cp -f "$SET" "$SET.hm-bak" 2>/dev/null || true
      if mv -f "$SET.hm-tmp" "$SET" 2>/dev/null; then
        echo "  Хуки Claude Code направлены на скрепку (порт 45832). Бэкап: settings.json.hm-bak."
      else
        rm -f "$SET.hm-tmp" 2>/dev/null || true
        echo "  ВНИМАНИЕ: не удалось безопасно обновить settings.json — оригинал не тронут."
        KEEP_MARKER=1
      fi ;;
    3) : ;;  # плейсхолдера нет — ок, ничего не меняем
    11) echo "  settings.json не парсится как JSON — файл не тронут, скрепка разберётся с хуками сама."; KEEP_MARKER=1 ;;
    12) echo "  ВНИМАНИЕ: после замены hook-url JSON стал невалидным — откат, файл не тронут."; rm -f "$SET.hm-tmp" 2>/dev/null || true; KEEP_MARKER=1 ;;
    *) echo "  Не удалось обработать settings.json — файл не тронут, скрепка разберётся с хуками сама."; rm -f "$SET.hm-tmp" 2>/dev/null || true; KEEP_MARKER=1 ;;
  esac
fi
if [ "$KEEP_MARKER" = "0" ]; then
  # Сбросить маркер первой установки: приложение перепропишет свои хуки заново (merge аддитивный).
  rm -f "$HOME/.claude-mascot/.installed" 2>/dev/null || true
else
  echo "  Маркер .installed оставлен — правку хуков скрепка докрутит сама."
fi

# 4. Автозапуск при входе (LaunchAgent, ~/Library/LaunchAgents, без админа). RunAtLoad
# также запускает скрепку прямо сейчас. KeepAlive НЕ ставим — если пользователь закрыл
# скрепку, она не должна воскресать до следующего входа.
LA_DIR="$HOME/Library/LaunchAgents"
LA="$LA_DIR/com.hamidun.claude-mascot.plist"
mkdir -p "$LA_DIR"
EXECBIN="$DEST/Contents/MacOS/$APP_BIN"
cat > "$LA" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hamidun.claude-mascot</string>
  <key>ProgramArguments</key>
  <array><string>$EXECBIN</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
launchctl unload "$LA" 2>/dev/null || true
LAUNCHED=0
if launchctl load "$LA" 2>/dev/null; then
  LAUNCHED=1   # RunAtLoad=true поднимет скрепку сейчас и при каждом входе
else
  echo "  ВНИМАНИЕ: автозапуск (LaunchAgent) не загрузился — пробую запустить напрямую."
  open "$DEST" 2>/dev/null && LAUNCHED=1 || echo "  ВНИМАНИЕ: скрепка не запустилась — открой вручную: $DEST"
fi

# 5. Health-check (НЕ критичный: скрепка поднимает http://127.0.0.1:45832/health, но
# может не успеть за 10 с).
HEALTHY=0
if [ "$LAUNCHED" = "1" ]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if curl -fsS -m 2 "http://127.0.0.1:45832/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  done
fi
if [ "$HEALTHY" = "1" ]; then
  echo "OK: Скрепка установлена и запущена — она уже на экране. Ctrl+Shift+D откроет твои сессии Claude."
elif [ "$LAUNCHED" = "1" ]; then
  echo "OK: Скрепка установлена и запускается (не успела ответить на проверку — это не ошибка). Если не появится — открой вручную: $DEST"
else
  echo "Скрепка установлена, но не подтвердила запуск — стартует при следующем входе (автозапуск). Вручную: $DEST"
fi
exit 0
