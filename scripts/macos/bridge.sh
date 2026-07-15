#!/usr/bin/env bash
# AI-мост (Hamidun Bridge) — macOS: агент + автозапуск (LaunchAgent, headless)
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
DRY="${HM_DRY_RUN:-}"

DST="$HOME/Library/Application Support/HamidunBridge"
AGENT="${HM_AGENT_DIR:-}/bridge_agent.py"
[ -f "$AGENT" ] || { echo "Агент моста не найден ($AGENT)."; exit 1; }

if [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: агент -> $DST, pip pystray pillow, LaunchAgent, ssh -D"
  echo "[dry-run] AI-мост: без изменений."; exit 0
fi

# Ищем РЕАЛЬНЫЙ интерпретатор — тот же приоритет, что и pydeps.sh (framework-Python,
# под который собраны wheels и агент). НИКОГДА не берём CLT-шим /usr/bin/python3 при
# НЕустановленных Command Line Tools (xcode-select -p не проходит): его запуск дёргает
# GUI-диалог CLT, TRAY_OK=0, pip/import падают, а прописанный в LaunchAgent с
# KeepAlive=true шим уводит launchd в бесконечный рестарт нерабочего интерпретатора +
# шторм CLT-диалогов — при этом печаталось бы «OK: AI-мост установлен». Фолбэк-guard
# `[ -x "$PY" ]` был мёртвым: шим всегда существует и исполним на чистом маке.
PY=""
for CAND in \
  "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"; do
  [ -x "$CAND" ] && { PY="$CAND"; break; }
done
if [ -z "$PY" ]; then
  P3="$(command -v python3 2>/dev/null || true)"
  # Принимаем python3 из PATH ТОЛЬКО если это НЕ CLT-шим /usr/bin/python3 без
  # установленных CLT. Реальный интерпретатор (Homebrew/framework) — или сам
  # /usr/bin/python3, но лишь когда CLT уже стоят (xcode-select -p проходит) —
  # запускается без GUI-диалога и годен для plist LaunchAgent.
  if [ -n "$P3" ] && [ -x "$P3" ] && { [ "$P3" != "/usr/bin/python3" ] || xcode-select -p >/dev/null 2>&1; }; then
    PY="$P3"
  fi
fi
[ -n "$PY" ] && [ -x "$PY" ] || { echo "Python3 не найден (CLT-шим /usr/bin/python3 без Command Line Tools не годится) — выберите компонент «Python-пакеты»."; exit 1; }

mkdir -p "$DST"
cp -f "$AGENT" "$DST/bridge_agent.py"

WH="${HM_VENDOR:-}/pywheels"
TRAY_OK=1
if [ -d "$WH" ]; then
  "$PY" -m pip install --user --break-system-packages --no-index --find-links "$WH" pystray pillow >/dev/null 2>&1 || TRAY_OK=0
else
  "$PY" -m pip install --user --break-system-packages pystray pillow >/dev/null 2>&1 || TRAY_OK=0
fi
# честная проверка: реально ли доступны модули трея (pip мог упасть на чужом Python)
if ! "$PY" -c "import pystray, PIL" >/dev/null 2>&1; then TRAY_OK=0; fi
if [ "$TRAY_OK" != "1" ]; then
  echo "  ВНИМАНИЕ: pystray/pillow не установились — значок в трее будет недоступен."
  echo "  Мост будет работать в фоне (headless) и включаться только по сохранённому состоянию/боту."
fi

CFG="$DST/config.json"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<EOF
{
  "enrollEndpoint": "${HM_BRIDGE_ENDPOINT:-}",
  "bridgeToken": "${HM_BRIDGE_TOKEN:-}",
  "ssh": { "host": "", "port": 22, "user": "", "keyPath": "", "password": "" },
  "socksPort": 1080, "httpPort": 1081, "pacPort": 1082,
  "pacDomains": ["claude.ai","anthropic.com","openai.com","chatgpt.com","oaistatic.com","oaiusercontent.com","claudeusercontent.com","sora.com","higgsfield.ai"],
  "enabled": false
}
EOF
elif [ -n "${HM_BRIDGE_ENDPOINT:-}" ]; then
  # config.json уже есть, но издатель пересобрал установщик с адресом сервера — доставляем
  # новый endpoint/token в существующий конфиг, сохраняя ssh/enabled ученика. Иначе агент
  # простаивал бы с пустым endpoint, хотя сообщение говорило бы «сервер настроен». perl всегда есть.
  EP="$HM_BRIDGE_ENDPOINT" TK="${HM_BRIDGE_TOKEN:-}" /usr/bin/perl -pi -e '
    s/("enrollEndpoint"\s*:\s*")[^"]*(")/$1.$ENV{EP}.$2/e;
    s/("bridgeToken"\s*:\s*")[^"]*(")/$1.$ENV{TK}.$2/e;
  ' "$CFG" 2>/dev/null || true
fi

LA="$HOME/Library/LaunchAgents/com.hamidun.bridge.plist"
mkdir -p "$HOME/Library/LaunchAgents"
# Если трей доступен — запускаем БЕЗ --headless: значок реально появляется в меню-баре
# и пользователь может включить мост. Если трея нет — --headless (уважает сохранённое
# enabled и мягко простаивает, системный прокси не трогает).
if [ "$TRAY_OK" = "1" ]; then
  MODE_ARG="<string>$DST/bridge_agent.py</string>"
else
  MODE_ARG="<string>$DST/bridge_agent.py</string><string>--headless</string>"
fi
cat > "$LA" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hamidun.bridge</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string>$MODE_ARG</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl unload "$LA" 2>/dev/null || true
launchctl load "$LA" 2>/dev/null || true

# CLI-прокси: агент пишет cli_proxy.env, но сам его никто не подключает —
# идемпотентно добавляем source-строку в ~/.zshrc и ~/.bash_profile
# (маркер-комментарий защищает от дублей при повторной установке).
BRIDGE_RC_MARK="# Hamidun Bridge CLI proxy"
BRIDGE_RC_LINE='[ -f "$HOME/Library/Application Support/HamidunBridge/cli_proxy.env" ] && . "$HOME/Library/Application Support/HamidunBridge/cli_proxy.env" # Hamidun Bridge CLI proxy'
for RC in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  if [ -f "$RC" ] && grep -qF "$BRIDGE_RC_MARK" "$RC"; then
    : # уже подключено — не дублируем
  else
    printf '\n%s\n' "$BRIDGE_RC_LINE" >> "$RC"
  fi
  # P0-4: наша строка в этом rc-файле (по маркеру) — фиксируем владение в квитанции.
  if [ -f "$RC" ] && grep -qF "$BRIDGE_RC_MARK" "$RC"; then
    echo "HM-RECEIPT profileline $RC|$BRIDGE_RC_MARK"
  fi
done

# P0-4: квитанция владения — ТОЧНЫЕ пути созданных артефактов (main соберёт в receipt).
echo "HM-RECEIPT path $DST"
echo "HM-RECEIPT launchagent com.hamidun.bridge|$LA"

if [ "$TRAY_OK" = "1" ]; then TRAY_MSG="значок в меню-баре"; else TRAY_MSG="фоновый режим без значка"; fi
if [ -n "${HM_BRIDGE_ENDPOINT:-}" ]; then echo "OK: AI-мост установлен ($TRAY_MSG). Сервер настроен."
else echo "OK: AI-мост установлен ($TRAY_MSG). Сервер ещё не настроен — включится после доступа в боте."; fi
exit 0
