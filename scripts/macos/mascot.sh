#!/usr/bin/env bash
# Скрепка Claude (маскот) — macOS: живой помощник поверх окон + кнопки разрешений.
# Аналог scripts/windows/mascot.ps1. Ставит ПОДПИСАННУЮ+НОТАРИЗОВАННУЮ .app из vendor
# в ~/Applications (без админа): проверяет SHA-256 + codesign + пин TeamID + spctl
# (нотаризация), ставит через staging с атомарным swap, снимает карантин, аккуратно
# правит хуки Claude Code, ставит автозапуск (LaunchAgent) и делает health-check :45832.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
DRY="${HM_DRY_RUN:-}"

# Пин издателя: скрепка обязана быть подписана ИМЕННО нашим Developer ID (Apple Team ID).
MASCOT_TEAM_ID="3VN93XA9DY"

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
  echo "  [dry-run] WOULD: verify SHA-256(bin)+codesign+TeamID($MASCOT_TEAM_ID)+spctl (нотаризация), staging-копия .app -> $DEST (атомарный swap) + re-verify результата, xattr -dr com.apple.quarantine, хуки (settings.json: 127.0.0.1:VSCODE_PORT/hook -> :45832/hook; python: tmp 0600 + fsync + ре-валидация с диска + анти-гонка + атомарный os.replace + бэкап .hm-bak), LaunchAgent автозапуск, запуск + health-check http://127.0.0.1:45832/health (дедлайн 10 с)"
  echo "[dry-run] Скрепка: ветка выбрана, без изменений."; exit 0
fi

# 1. Целостность — fail-closed вентили (эквивалент Confirm-HmArtifact + Gatekeeper):
#    (a) SHA-256 главного бинаря против vendor/checksums.json (как на Windows);
#    (b) codesign --verify --deep --strict всего бандла — целостность ПОДПИСИ (и только её);
#    (c) пин издателя: TeamIdentifier обязан быть нашим ($MASCOT_TEAM_ID);
#    (d) нотаризация: spctl --assess --type execute (вердикт Gatekeeper; есть на любой
#        macOS) или staple-тикет (xcrun stapler validate). codesign сам по себе
#        нотаризацию НЕ подтверждает — потому оба вентиля (c)+(d) обязательны.
if [ -z "$APP_BIN" ]; then
  echo "БЕЗОПАСНОСТЬ: в .app нет исполняемого файла (Contents/MacOS пуст) — установка остановлена."; exit 1
fi
verify_artifact "$APP/Contents/MacOS/$APP_BIN"   # сам делает exit 1 при несовпадении/отсутствии манифеста

# Полная проверка бандла (подпись + издатель + нотаризация). Вызывается для исходника
# ДО установки и для результата в ~/Applications ПЕРЕД снятием карантина.
verify_app_bundle() {
  local app="$1"
  if ! command -v codesign >/dev/null 2>&1; then
    echo "БЕЗОПАСНОСТЬ: codesign недоступен — не могу проверить подпись скрепки. Установка остановлена."; exit 1
  fi
  if ! codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    echo "БЕЗОПАСНОСТЬ: подпись .app не прошла проверку (codesign --verify): $app — файл подменён/повреждён. Установка остановлена."; exit 1
  fi
  if ! codesign -dv --verbose=4 "$app" 2>&1 | grep -q "TeamIdentifier=$MASCOT_TEAM_ID"; then
    echo "БЕЗОПАСНОСТЬ: .app подписан НЕ нашим Developer ID (ожидался TeamIdentifier=$MASCOT_TEAM_ID): $app. Установка остановлена."; exit 1
  fi
  # Основной вентиль нотаризации — spctl (есть всегда); запасной — staple-тикет.
  if command -v spctl >/dev/null 2>&1 && spctl --assess --type execute -vv "$app" >/dev/null 2>&1; then
    return 0
  fi
  if command -v xcrun >/dev/null 2>&1 && xcrun stapler validate "$app" >/dev/null 2>&1; then
    return 0
  fi
  echo "БЕЗОПАСНОСТЬ: нотаризация .app не подтверждена (spctl --assess и stapler validate не прошли): $app. Установка остановлена."; exit 1
}
verify_app_bundle "$APP"
echo "  Подпись Developer ID ($MASCOT_TEAM_ID) и нотаризация подтверждены (codesign + spctl)."

# 2. Остановить работающую скрепку (bundle может быть залочен) и поставить свежую копию
# через staging + атомарный swap. Копировать сразу в $DEST нельзя: если rm -rf старого
# бандла молча не удался (файл залочен), ditto СМЕРЖИТ новую версию в выживший бандл —
# получится микс двух версий со сломанной подписью.
[ -n "$APP_BIN" ] && pkill -f "/Contents/MacOS/$APP_BIN" 2>/dev/null || true
sleep 1
mkdir -p "$DEST_DIR"
STAGING="$DEST_DIR/.claude-mascot-staging.app"
rm -rf "$STAGING" 2>/dev/null || true
if [ -e "$STAGING" ]; then
  echo "Не удалось очистить staging ($STAGING) — удали папку вручную и повтори установку."; exit 1
fi
# ditto (НЕ cp -R): сохраняет символлинки/подпись/нотаризацию бандла целиком.
if ! ditto "$APP" "$STAGING" 2>/dev/null; then
  rm -rf "$STAGING" 2>/dev/null || true
  echo "Не удалось скопировать скрепку в $DEST_DIR — проверь место на диске и повтори установку."; exit 1
fi
rm -rf "$DEST" 2>/dev/null || true
if [ -e "$DEST" ]; then
  rm -rf "$STAGING" 2>/dev/null || true
  echo "Не удалось заменить старую скрепку ($DEST занята) — закрой её и повтори установку."; exit 1
fi
if ! mv "$STAGING" "$DEST" 2>/dev/null; then
  rm -rf "$STAGING" 2>/dev/null || true
  echo "Не удалось поставить скрепку в $DEST — повтори установку."; exit 1
fi
# Проверяем РЕЗУЛЬТАТ установки (не только исходник) — и лишь потом снимаем карантин:
# непроверенный бандл не должен получить зелёный свет Gatekeeper.
verify_app_bundle "$DEST"
# Снять карантин (dmg метит содержимое com.apple.quarantine) — иначе Gatekeeper заблокирует запуск.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# 3. Хуки Claude Code: конфиг-пак несёт hook-записи с плейсхолдером VSCODE_PORT в url —
# подставляем порт скрепки (45832). Безопасность (settings.json — ВЕСЬ конфиг пользователя);
# вся операция «прочитать -> заменить -> записать -> подменить» — ОДИН python-процесс:
#   - правим ТОЛЬКО подстроку hook-url `127.0.0.1:VSCODE_PORT/hook` (чужой "VSCODE_PORT" не задеваем);
#   - JSON валидируем до и после замены; битый файл НЕ трогаем;
#   - tmp в той же папке, права 0600, запись с fsync и РЕ-ВАЛИДАЦИЕЙ содержимого С ДИСКА —
#     усечённая запись (ENOSPC) не может затереть оригинал;
#   - анти-гонка: перед подменой оригинал сверяется с прочитанным — чужую свежую правку не затираем;
#   - бэкап .hm-bak (copy2 сохраняет права), исходные права восстанавливаются на tmp,
#     подмена атомарная (os.replace);
#   - при ЛЮБОМ сбое оригинал остаётся нетронутым, а маркер .installed НЕ сбрасываем.
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
import sys, os, json, shutil

p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
tmp = p + ".hm-tmp"
bak = p + ".hm-bak"

def drop_tmp():
    try:
        os.remove(tmp)
    except OSError:
        pass

# 1. Читаем оригинал; запоминаем права и содержимое (для восстановления и анти-гонки).
try:
    st = os.stat(p)
    with open(p, encoding="utf-8") as f:
        raw = f.read()
except Exception:
    sys.exit(10)          # не прочитался — не трогаем
# 2. Оригинал обязан быть валидным JSON.
try:
    json.loads(raw)
except Exception:
    sys.exit(11)          # не JSON — не трогаем
# 3. Плейсхолдера нет — менять нечего.
if old not in raw:
    sys.exit(3)
# 4. Literal replace + валидация результата в памяти.
newraw = raw.replace(old, new)
try:
    json.loads(newraw)
except Exception:
    sys.exit(12)          # после замены сломался — не трогаем
# 5. Стерильность: stale tmp от прошлого (упавшего) запуска.
drop_tmp()
# 6. tmp В ТОЙ ЖЕ папке (rename в пределах ФС), права 0600 (не слабее любого конфига),
#    полная запись + fsync: при ENOSPC/сбое падаем ЗДЕСЬ, оригинал цел.
try:
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        data = newraw.encode("utf-8")
        off = 0
        while off < len(data):
            off += os.write(fd, data[off:])
        os.fsync(fd)
    finally:
        os.close(fd)
except Exception:
    drop_tmp()
    sys.exit(13)          # запись не удалась — оригинал цел
# 7. Ре-валидация С ДИСКА: то, что реально легло в tmp, целиком и парсится.
try:
    with open(tmp, encoding="utf-8") as f:
        ondisk = f.read()
    if not ondisk or ondisk != newraw:
        raise ValueError("tmp не совпал с ожидаемым содержимым")
    json.loads(ondisk)
except Exception:
    drop_tmp()
    sys.exit(14)          # tmp пуст/усечён/битый — оригинал цел
# 8. Анти-гонка: если оригинал изменили, пока мы работали (например, сам Claude Code),
#    чужую свежую правку НЕ затираем.
try:
    with open(p, encoding="utf-8") as f:
        cur = f.read()
except Exception:
    cur = None
if cur != raw:
    drop_tmp()
    sys.exit(15)          # файл изменился между чтением и подменой
# 9. Бэкап (copy2 сохраняет права и времена).
try:
    shutil.copy2(p, bak)
except Exception:
    drop_tmp()
    sys.exit(16)          # бэкап не удался — подмену не делаем
# 10-11. Восстановить исходные права на tmp и атомарно заменить оригинал.
try:
    os.chmod(tmp, st.st_mode & 0o777)
    os.replace(tmp, p)
except Exception:
    drop_tmp()
    sys.exit(17)
sys.exit(0)
PYEOF
  case "$RC" in
    0) echo "  Хуки Claude Code направлены на скрепку (порт 45832). Бэкап: settings.json.hm-bak." ;;
    3) : ;;  # плейсхолдера нет — ок, ничего не меняем
    11) echo "  settings.json не парсится как JSON — файл не тронут, скрепка разберётся с хуками сама."; KEEP_MARKER=1 ;;
    12) echo "  ВНИМАНИЕ: после замены hook-url JSON стал невалидным — файл не тронут."; KEEP_MARKER=1 ;;
    13) echo "  ВНИМАНИЕ: не удалось записать новый settings.json (нет места/прав?) — оригинал не тронут."; KEEP_MARKER=1 ;;
    14) echo "  ВНИМАНИЕ: новый settings.json не прошёл проверку с диска (запись неполная?) — оригинал не тронут."; KEEP_MARKER=1 ;;
    15) echo "  ВНИМАНИЕ: settings.json изменился во время установки (его пишет другой процесс) — правку пропускаю, оригинал не тронут."; KEEP_MARKER=1 ;;
    16) echo "  ВНИМАНИЕ: не удалось сохранить бэкап settings.json.hm-bak — оригинал не тронут."; KEEP_MARKER=1 ;;
    *) echo "  Не удалось обработать settings.json (код $RC) — файл не тронут, скрепка разберётся с хуками сама."; KEEP_MARKER=1 ;;
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

# 5. Health-check (НЕ критичный): абсолютный дедлайн 10 с (а не 10 итераций по
# sleep 1 + curl -m 2 = до 30 с). curl на неподнятый порт падает мгновенно.
HEALTHY=0
if [ "$LAUNCHED" = "1" ]; then
  END=$((SECONDS+10))
  while [ "$SECONDS" -lt "$END" ]; do
    if curl -fsS -m 1 "http://127.0.0.1:45832/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
    sleep 1
  done
fi
# «OK, запускается» — только если процесс реально жив: молчащий health + мёртвый
# процесс = НЕ успех, честно говорим «стартует при следующем входе».
PROC_ALIVE=0
if [ -n "$APP_BIN" ] && pgrep -f "/Contents/MacOS/$APP_BIN" >/dev/null 2>&1; then PROC_ALIVE=1; fi
if [ "$HEALTHY" = "1" ]; then
  echo "OK: Скрепка установлена и запущена — она уже на экране. Ctrl+Shift+D откроет твои сессии Claude."
elif [ "$LAUNCHED" = "1" ] && [ "$PROC_ALIVE" = "1" ]; then
  echo "OK: Скрепка установлена и запускается (не успела ответить на проверку — это не ошибка). Если не появится — открой вручную: $DEST"
else
  echo "Скрепка установлена, но не подтвердила запуск — стартует при следующем входе (автозапуск). Вручную: $DEST"
fi
exit 0
