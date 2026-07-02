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
echo "Установка CLT обычно занимает 5–15 минут (скачивает ~700 МБ). Жду..."

# Проверяем готовность БЕЗ дёргания xcode-select-шима (иначе повторно всплывает диалог):
# сперва прямой путь бинаря CLT, затем — git только если CLT уже стоит (xcode-select -p).
git_ready() {
  [ -x /Library/Developer/CommandLineTools/usr/bin/git ] && return 0
  xcode-select -p >/dev/null 2>&1 && git --version >/dev/null 2>&1 && return 0
  return 1
}

# Ограниченный поллинг до ~15 минут — реальная установка CLT длиннее старых 2.5 мин.
i=0
while [ "$i" -lt 90 ]; do
  if git_ready; then
    echo "OK: Git установлен: $(git --version 2>/dev/null || echo ok)"; exit 0
  fi
  i=$((i + 1))
  sleep 10
done

echo "ОШИБКА: Git пока не установлен — установка Command Line Tools ещё не завершилась."
echo "Дождись окончания установки в открывшемся окне и нажми «Повторить неустановленное»."
exit 1
