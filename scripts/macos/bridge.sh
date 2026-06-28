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

PY="/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
[ -x "$PY" ] || PY="$(command -v python3 || true)"
[ -n "$PY" ] && [ -x "$PY" ] || { echo "Python3 не найден — выберите «Python-пакеты»."; exit 1; }

mkdir -p "$DST"
cp -f "$AGENT" "$DST/bridge_agent.py"

WH="${HM_VENDOR:-}/pywheels"
if [ -d "$WH" ]; then "$PY" -m pip install --user --break-system-packages --no-index --find-links "$WH" pystray pillow >/dev/null 2>&1 || true
else "$PY" -m pip install --user --break-system-packages pystray pillow >/dev/null 2>&1 || true; fi

CFG="$DST/config.json"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<EOF
{
  "enrollEndpoint": "${HM_BRIDGE_ENDPOINT:-}",
  "bridgeToken": "${HM_BRIDGE_TOKEN:-}",
  "ssh": { "host": "", "port": 22, "user": "", "keyPath": "", "password": "" },
  "socksPort": 1080, "httpPort": 1081, "pacPort": 1082,
  "pacDomains": ["claude.ai","anthropic.com","openai.com","chatgpt.com","oaistatic.com","higgsfield.ai"],
  "enabled": false
}
EOF
fi

LA="$HOME/Library/LaunchAgents/com.hamidun.bridge.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$LA" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hamidun.bridge</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$DST/bridge_agent.py</string><string>--headless</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl unload "$LA" 2>/dev/null || true
launchctl load "$LA" 2>/dev/null || true

if [ -n "${HM_BRIDGE_ENDPOINT:-}" ]; then echo "OK: AI-мост установлен. Сервер настроен."
else echo "OK: AI-мост установлен. Сервер ещё не настроен — включится после доступа в боте."; fi
exit 0
