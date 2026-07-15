#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# Предпочитаем bundled Python 3.12 (под него собраны wheels).
PY312="/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
if [ ! -x "$PY312" ] && [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/python.pkg" ]; then
  echo "Python 3.12 из встроенного pkg (офлайн)..."
  verify_artifact "$HM_VENDOR/apps/python.pkg"  # вшитый артефакт — сверяем SHA-256 (fail-closed)
  admin_run "installer -pkg '$HM_VENDOR/apps/python.pkg' -target /"
fi
if [ -x "$PY312" ]; then PY="$PY312"
else
  # НЕ берём системный шим /usr/bin/python3: без установленных Command Line Tools
  # его запуск дёргает GUI-диалог CLT. Принимаем python3 из PATH ТОЛЬКО если это
  # реальный интерпретатор (Homebrew/framework/…), а не CLT-шим.
  P3="$(command -v python3 2>/dev/null || true)"
  if [ -n "$P3" ] && [ "$P3" != "/usr/bin/python3" ]; then
    PY="$P3"
  else
    echo "Скачиваю Python с python.org..."
    PKG="/tmp/python.pkg"; dl "https://www.python.org/ftp/python/3.12.7/python-3.12.7-macos11.pkg" "$PKG"
    admin_run "installer -pkg '$PKG' -target /"
    PY="$PY312"
  fi
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
  # cp БЕЗ `|| true`: молчаливый сбой копирования раньше давал ложный OK, а потом
  # браузерные скиллы падали без следа. Ловим код возврата и честно фолбэчимся в онлайн.
  if cp -R "$PWB/"* "$HOME/Library/Caches/ms-playwright/" 2>/dev/null; then
    # macOS `cp` тащит xattrs, в т.ч. com.apple.quarantine. Ненотаризованный Chromium
    # с карантином блокируется Gatekeeper → браузер не стартует, а скрипт печатал OK.
    # Снимаем карантин рекурсивно (тот же приём, что в git.sh:51 для вшитого git).
    xattr -dr com.apple.quarantine "$HOME/Library/Caches/ms-playwright" 2>/dev/null || true
  else
    echo "  ВНИМАНИЕ: встроенные браузеры Playwright не скопировались — качаю онлайн..."
    if ! "$PY" -m playwright install chromium >/dev/null 2>&1; then
      echo "  ВНИМАНИЕ: браузеры Playwright не скачались (проверь сеть и повтори установку этого компонента). Остальные Python-зависимости на месте."
    fi
  fi
else
  # Онлайн-докачка браузеров (~150 МБ, самый хрупкий по сети шаг). Сбой раньше
  # молча глотался, а скрипт печатал OK — потом браузерные скиллы падали без следа.
  if ! "$PY" -m playwright install chromium >/dev/null 2>&1; then
    echo "  ВНИМАНИЕ: браузеры Playwright не скачались (проверь сеть и повтори установку этого компонента). Остальные Python-зависимости на месте."
  fi
fi
echo "OK: Python-зависимости установлены."
exit 0
