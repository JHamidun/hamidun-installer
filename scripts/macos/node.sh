#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

echo "Проверяю Node.js..."
if have node; then echo "Node.js уже установлен: $(node --version)"; exit 0; fi

if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/node.pkg" ]; then
  PKG="$HM_VENDOR/apps/node.pkg"; echo "Node.js из встроенного pkg (офлайн)..."
else
  echo "Определяю последнюю LTS-версию..."
  # Без python3 (bare /usr/bin/python3 без CLT дёргает GUI-диалог установки).
  # Записи в index.json идут от новых к старым; у LTS "lts" — строка (кодовое имя), у остальных false.
  VER=$(curl -fsSL https://nodejs.org/dist/index.json \
    | grep -o '{[^{}]*}' | grep '"lts":"' | head -n1 \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)
  [ -z "$VER" ] && { echo "Не удалось определить LTS-версию Node.js (нет сети или изменился формат index.json)."; exit 1; }
  PKG="/tmp/node-${VER}.pkg"
  echo "Скачиваю Node.js ${VER}..."
  dl "https://nodejs.org/dist/${VER}/node-${VER}.pkg" "$PKG"
fi
echo "Устанавливаю (потребуется пароль администратора)..."
admin_run "installer -pkg '$PKG' -target /"

if have node || [ -x /usr/local/bin/node ]; then echo "OK: Node.js установлен."; exit 0; fi
echo "Node.js не обнаружен после установки."; exit 1
