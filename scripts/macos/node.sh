#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

echo "Проверяю Node.js..."
if have node; then echo "Node.js уже установлен: $(node --version)"; exit 0; fi

echo "Определяю последнюю LTS-версию..."
VER=$(curl -fsSL https://nodejs.org/dist/index.json | /usr/bin/python3 -c 'import sys,json;print(next(x["version"] for x in json.load(sys.stdin) if x["lts"]))')
PKG="/tmp/node-${VER}.pkg"
echo "Скачиваю Node.js ${VER}..."
dl "https://nodejs.org/dist/${VER}/node-${VER}.pkg" "$PKG"
echo "Устанавливаю (потребуется пароль администратора)..."
admin_run "installer -pkg '$PKG' -target /"

if have node || [ -x /usr/local/bin/node ]; then echo "OK: Node.js установлен."; exit 0; fi
echo "Node.js не обнаружен после установки."; exit 1
