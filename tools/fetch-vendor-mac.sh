#!/usr/bin/env bash
# Build-time (на macOS-раннере): качает Mac-бинари в vendor/ для ПОЛНОГО офлайна (arm64).
# set -u, НЕ -e: нативные тулзы пишут в stderr. Запуск: bash tools/fetch-vendor-mac.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="$ROOT/vendor/apps"
mkdir -p "$APPS"

dl() { if [ -f "$2" ]; then echo "  skip $(basename "$2")"; return; fi; echo "  GET $1"; curl -fsSL "$1" -o "$2" || echo "  ! не скачалось $(basename "$2")"; }

echo "[vendor-mac] Python 3.12.7 (universal2 pkg) — ставим на раннер, чтобы wheels совпали..."
PYPKG="$APPS/python.pkg"
dl "https://www.python.org/ftp/python/3.12.7/python-3.12.7-macos11.pkg" "$PYPKG"
sudo installer -pkg "$PYPKG" -target / >/dev/null 2>&1 || echo "  (install python skipped)"
PY="/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
[ -x "$PY" ] || PY="python3"
echo "  python для сборки: $("$PY" --version 2>&1)"

echo "[vendor-mac] Node.js LTS (universal2 pkg)..."
VER=$(curl -fsSL https://nodejs.org/dist/index.json | "$PY" -c 'import sys,json;print(next(x["version"] for x in json.load(sys.stdin) if x["lts"]))')
dl "https://nodejs.org/dist/$VER/node-$VER.pkg" "$APPS/node.pkg"

echo "[vendor-mac] Cursor (arm64 dmg)..."
CUR=$(curl -fsSL "https://www.cursor.com/api/download?platform=darwin-arm64&releaseTrack=stable" | "$PY" -c 'import sys,json;print(json.load(sys.stdin).get("downloadUrl",""))' 2>/dev/null)
[ -n "$CUR" ] && dl "$CUR" "$APPS/cursor.dmg" || echo "  ! Cursor API недоступен"

echo "[vendor-mac] AmneziaVPN (mac dmg)..."
AV=$(curl -fsSL https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest | "$PY" -c 'import sys,json;a=[x["browser_download_url"] for x in json.load(sys.stdin)["assets"] if x["name"].lower().endswith(".dmg")];print(a[0] if a else "")' 2>/dev/null)
[ -n "$AV" ] && dl "$AV" "$APPS/amneziavpn.dmg" || echo "  ! AmneziaVPN dmg не найден"

echo "[vendor-mac] Claude Code CLI -> npm cache (офлайн -g)..."
CACHE="$ROOT/vendor/npm-cache"; TMP="$ROOT/vendor/_claudetmp"; mkdir -p "$TMP"
npm install '@anthropic-ai/claude-code' --prefix "$TMP" --cache "$CACHE" --no-audit --no-fund >/dev/null 2>&1 || true
rm -rf "$TMP"

echo "[vendor-mac] Python wheels (macosx, под bundled python 3.12)..."
WH="$ROOT/vendor/pywheels"; rm -rf "$WH"; mkdir -p "$WH"
REQ="$ROOT/vendor/config-pack/requirements.txt"
if [ -f "$REQ" ]; then
  "$PY" -m pip download pip setuptools wheel -d "$WH" >/dev/null 2>&1 || true
  "$PY" -m pip download -r "$REQ" -d "$WH" 2>&1 | tail -2
  echo "  wheels/sdists: $(ls "$WH" 2>/dev/null | wc -l | tr -d ' ')"
fi

echo "[vendor-mac] Playwright Chromium (mac)..."
PW="$ROOT/vendor/playwright-browsers"; mkdir -p "$PW"
"$PY" -m pip install --quiet playwright >/dev/null 2>&1 || true
PLAYWRIGHT_BROWSERS_PATH="$PW" "$PY" -m playwright install chromium >/dev/null 2>&1 || true

echo "[vendor-mac] Git: оставлен системный/CLT (офлайн-бандл git на mac — на будущее)."
echo "[vendor-mac] ГОТОВО: vendor = $(du -sh "$ROOT/vendor" 2>/dev/null | cut -f1)"
