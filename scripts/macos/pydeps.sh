#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

PY=""
if have python3; then PY="$(command -v python3)"; fi
if [ -z "$PY" ]; then
  echo "Python3 не найден — устанавливаю с python.org..."
  # последняя стабильная 3.12 universal2
  PKG="/tmp/python.pkg"
  dl "https://www.python.org/ftp/python/3.12.7/python-3.12.7-macos11.pkg" "$PKG"
  admin_run "installer -pkg '$PKG' -target /"
  have python3 && PY="$(command -v python3)"
fi
[ -z "$PY" ] && { echo "Python не установился — пропускаю зависимости."; exit 1; }

if [ -n "${HM_BUNDLED_CONFIG:-}" ] && [ -f "$HM_BUNDLED_CONFIG/requirements.txt" ]; then
  REQ="$HM_BUNDLED_CONFIG/requirements.txt"
else
  REQ="$HOME/.hamidun-setup/config-repo/requirements.txt"
fi
[ -f "$REQ" ] || { echo "requirements.txt не найден — сначала установите конфиг."; exit 1; }

echo "Использую Python: $PY"
"$PY" -m pip install --user --break-system-packages --upgrade pip >/dev/null 2>&1 || true
echo "Ставлю библиотеки (пара минут)..."
"$PY" -m pip install --user --break-system-packages -r "$REQ" || { echo "Часть библиотек не установилась."; exit 1; }
echo "Ставлю браузер Playwright (best-effort)..."
"$PY" -m playwright install chromium >/dev/null 2>&1 || true
echo "OK: Python-зависимости установлены."
exit 0
