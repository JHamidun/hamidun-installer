#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# Пин подписи python.pkg ДО root-запуска installer (fail-closed, THREAT-MODEL round-4):
# /tmp-загрузку мог подменить процесс того же пользователя. Требуем Developer ID
# Installer с ТОЧНЫМ Team ID Python Software Foundation. Подтверждено сетью (2026-07):
# начиная с Python 3.11.4/3.12.0b1 установщики python.org подписаны сертификатами PSF
# c Apple Developer ID BMM5U3QVKW (python.org/downloads + docs.python.org/3/using/mac.html;
# мы ставим 3.12.7 > 3.11.4). Не подтвердится — fail-closed стоп.
PYTHON_TEAM_ID='BMM5U3QVKW'

# Предпочитаем bundled Python 3.12 (под него собраны wheels).
PY312="/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
if [ ! -x "$PY312" ] && [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/python.pkg" ]; then
  echo "Python 3.12 из встроенного pkg (офлайн)..."
  verify_artifact "$HM_VENDOR/apps/python.pkg"  # вшитый артефакт — сверяем SHA-256 (fail-closed)
  # verify + install атомарно под root на staged копии (Codex P1); пин подписи и для
  # вшитого pkg (defense-in-depth поверх SHA-256). Путь и Team ID — позиционные.
  if ! admin_run /bin/sh -c "$HM_PKG_INSTALL_SH" hm_pkg_install "$HM_VENDOR/apps/python.pkg" "$PYTHON_TEAM_ID"; then
    echo "Python: подпись .pkg не подтверждена или установка не удалась (fail-closed)."; exit 1
  fi
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
    # verify + install атомарно под root на staged копии (Codex P1) — окна подмены /tmp
    # между verify и install нет (PSF Team ID, fail-closed) — см. PYTHON_TEAM_ID выше.
    if ! admin_run /bin/sh -c "$HM_PKG_INSTALL_SH" hm_pkg_install "$PKG" "$PYTHON_TEAM_ID"; then
      echo "Python: подпись .pkg не подтверждена или установка не удалась (fail-closed)."; exit 1
    fi
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
  # Провал офлайн-ветки (типовой случай — Intel: x86_64-колёса нативных пакетов
  # качаются на сборке best-effort и могли не вшиться) — НЕ жёсткий exit 1, а
  # честный онлайн-фолбэк, как у Chromium-ветки ниже: --find-links оставляем,
  # чтобы вшитые колёса всё равно использовались, сеть докачивает только дыры.
  if ! "$PY" -m pip install --user --break-system-packages --no-index --find-links "$WH" -r "$REQ"; then
    echo "  ВНИМАНИЕ: офлайн-установка из встроенных wheels не удалась (часть колёс под эту архитектуру не вшита) — докачиваю недостающее из PyPI (онлайн)..."
    "$PY" -m pip install --user --break-system-packages --upgrade pip >/dev/null 2>&1 || true
    "$PY" -m pip install --user --break-system-packages --find-links "$WH" -r "$REQ" || { echo "Часть библиотек не установилась (офлайн и онлайн). Проверь сеть и повтори установку этого компонента."; exit 1; }
  fi
else
  "$PY" -m pip install --user --break-system-packages --upgrade pip >/dev/null 2>&1 || true
  echo "Библиотеки из PyPI (онлайн)..."
  "$PY" -m pip install --user --break-system-packages -r "$REQ" || { echo "Часть библиотек не установилась."; exit 1; }
fi
# Arch-специфичный Chromium: вшит только под arm64 (раннер). На Intel папки
# playwright-browsers-x64 нет → уходим в онлайн-докачку ниже (единственный не-офлайн шаг на x64).
PWB="${HM_VENDOR:-}/playwright-browsers-$(arch_tag)"
if [ -n "${HM_VENDOR:-}" ] && [ -d "$PWB" ]; then
  echo "Встроенные браузеры Playwright (офлайн, $(arch_tag))..."
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
