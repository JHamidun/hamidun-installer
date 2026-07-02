#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

echo "Проверяю Git..."
if have git && git --version >/dev/null 2>&1; then
  echo "Git уже установлен: $(git --version)"; exit 0
fi

echo "Запускаю установку Command Line Tools (включает Git)..."
xcode-select --install 2>/dev/null || true
echo "Открылось системное окно установки Command Line Tools — подтверди установку в нём."
echo "Жду завершения установки (до ~2.5 мин)..."

# Ограниченный поллинг: диалог CLT идёт в отдельном GUI-окне (часто позади),
# поэтому ждём появления рабочего git, но не блокируемся навечно.
i=0
while [ "$i" -lt 15 ]; do
  if have git && git --version >/dev/null 2>&1; then
    echo "OK: Git установлен: $(git --version)"; exit 0
  fi
  i=$((i + 1))
  sleep 10
done

echo "ОШИБКА: Git пока не установлен."
echo "Заверши установку Command Line Tools в открывшемся окне и нажми «Повторить неустановленное»."
exit 1
