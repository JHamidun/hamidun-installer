#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

echo "Проверяю Git..."
if have git && git --version >/dev/null 2>&1; then
  echo "Git уже установлен: $(git --version)"; exit 0
fi
echo "Запускаю установку Command Line Tools (включает Git)..."
xcode-select --install 2>/dev/null || true
echo "Если открылось системное окно установки — заверши его, затем перезапусти установщик."
# Не блокируем: установка CLT идёт в отдельном GUI-окне.
exit 0
