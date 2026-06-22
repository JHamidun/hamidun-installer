#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# Предпочитаем bundled Python 3.12 (под него собраны wheels).
PY312="/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
if [ ! -x "$PY312" ] && [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/python.pkg" ]; then
  echo "Python 3.12 из встроенного pkg (офлайн)..."
  admin_run "installer -pkg '$HM_VENDOR/apps/python.pkg' -target /"
fi
if [ -x "$PY312" ]; then PY="$PY312"
elif have python3; then PY="$(command -v python3)"
else
  echo "Скачиваю Python с python.org..."
  PKG="/tmp/python.pkg"; dl "https://www.python.org/ftp/python/3.12.7/python-3.12.7-macos11.pkg" "$PKG"
  admin_run "installer -pkg '$PKG' -target /"
  PY="$PY312"
fi
[ -x "$PY" ] || { echo "Python не установился — пропускаю зависимости."; exit 1; }

if [ -n "${HM_BUNDLED_CONFIG:-}" ] && [ -f "$HM_BUNDLED_CONFIG/requirements.txt" ]; then
  REQ="$HM_BUNDLED_CONFIG/requirements.txt"
else
  REQ="$HOME/.hamidun-setup/config-repo/requirements.txt"
fi
[ -f "$REQ" ] || { echo "requirements.txt не найден — сначала установите конфиг."; exit 1; }

echo "Использую Python: $PY"
WH="${HM_VENDOR:-}/pywheels"
if [ -n "${HM_VENDOR:-}" ] && [ -d "$WH" ]; then
  echo "Библиотеки из встроенных wheels (офлайн)..."
  "$PY" -m pip install --user --break-system-packages --no-index --find-links "$WH" -r "$REQ" || { echo "Часть библиотек не установилась."; exit 1; }
else
  "$PY" -m pip install --user --break-system-packages --upgrade pip >/dev/null 2>&1 || true
  echo "Библиотеки из PyPI (онлайн)..."
  "$PY" -m pip install --user --break-system-packages -r "$REQ" || { echo "Часть библиотек не установилась."; exit 1; }
fi
PWB="${HM_VENDOR:-}/playwright-browsers"
if [ -n "${HM_VENDOR:-}" ] && [ -d "$PWB" ]; then
  echo "Встроенные браузеры Playwright (офлайн)..."
  mkdir -p "$HOME/Library/Caches/ms-playwright"
  cp -R "$PWB/"* "$HOME/Library/Caches/ms-playwright/" 2>/dev/null || true
else
  "$PY" -m playwright install chromium >/dev/null 2>&1 || true
fi
echo "OK: Python-зависимости установлены."
exit 0
