#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
# Под GUI/Electron PATH урезан — без этого только что установленный node не виден.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"

echo "Проверяю Node.js..."
if have node; then echo "Node.js уже установлен: $(node --version)"; exit 0; fi

BUNDLED=0
if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/node.pkg" ]; then
  PKG="$HM_VENDOR/apps/node.pkg"; BUNDLED=1; echo "Node.js из встроенного pkg (офлайн)..."
else
  echo "Определяю последнюю LTS-версию..."
  # Без python3 (bare /usr/bin/python3 без CLT дёргает GUI-диалог установки).
  # Записи в index.json идут от новых к старым; у LTS "lts" — строка (кодовое имя), у остальных false.
  # Таймауты обязательны: curl без --max-time на РФ-DPI виснет молча навсегда.
  VER=$(curl -fsSL --connect-timeout 20 --max-time 900 --retry 3 --retry-connrefused https://nodejs.org/dist/index.json \
    | grep -o '{[^{}]*}' | grep '"lts":"' | head -n1 \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)
  [ -z "$VER" ] && { echo "Не удалось определить LTS-версию Node.js (сеть недоступна или очень медленная, либо изменился формат index.json) — повтори установку этого компонента."; exit 1; }
  PKG="/tmp/node-${VER}.pkg"
  echo "Скачиваю Node.js ${VER}..."
  # set -e здесь нет — без явного чека провал скачивания молча дошёл бы до admin_run.
  dl "https://nodejs.org/dist/${VER}/node-${VER}.pkg" "$PKG" || exit 1
fi
[ "$BUNDLED" = 1 ] && verify_artifact "$PKG"  # вшитый артефакт — сверяем SHA-256 (fail-closed)
# verify + install АТОМАРНО под root на root-owned staged копии (Codex round-4 P1):
# подпись .pkg проверяется тем же root-процессом, что и ставит, на staged pkg — окна
# подмены /tmp между verify и install больше нет. Требуем Developer ID Installer с
# ТОЧНЫМ Team ID Node.js Foundation. Подтверждено сетью (2026-07): официальные сборки
# Node.js подписаны "Node.js Foundation (HX7739G8FX)", TeamIdentifier=HX7739G8FX
# (github.com/Homebrew/homebrew-core/issues/117452 — codesign output официального
# бинаря; Team ID един для Application/Installer сертификатов одного Apple-аккаунта).
# Не подтвердится — fail-closed (installer не запустится). Путь и Team ID — позиционные.
NODE_TEAM_ID='HX7739G8FX'
echo "Устанавливаю (потребуется пароль администратора)..."
if ! admin_run /bin/sh -c "$HM_PKG_INSTALL_SH" hm_pkg_install "$PKG" "$NODE_TEAM_ID"; then
  echo "Node.js: подпись .pkg не подтверждена или установка не удалась (fail-closed)."; exit 1
fi

if have node || [ -x /usr/local/bin/node ]; then echo "OK: Node.js установлен."; exit 0; fi
echo "Node.js не обнаружен после установки."; exit 1
