#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# Дружелюбные git-дефолты (идемпотентно; ошибки конфигурации НЕ валят установку).
set_git_defaults() {
  # Каждый дефолт ставим ТОЛЬКО если пользователь его ещё не задал — не затираем уже настроенное.
  if [ -z "$(git config --global core.longpaths 2>/dev/null || true)" ]; then
    git config --global core.longpaths true 2>/dev/null || true
  fi
  if [ -z "$(git config --global init.defaultBranch 2>/dev/null || true)" ]; then
    git config --global init.defaultBranch main 2>/dev/null || true
  fi
  if [ -z "$(git config --global core.autocrlf 2>/dev/null || true)" ]; then
    git config --global core.autocrlf input 2>/dev/null || true
  fi
  if [ -z "$(git config --global user.name 2>/dev/null || true)" ]; then
    un="${USER:-user}"
    git config --global user.name "$un" 2>/dev/null || true
    git config --global user.email "${un}@example.com" 2>/dev/null || true
    echo "Git: user.name/user.email заданы по умолчанию — поменяй потом: git config --global user.email твоя@почта"
  fi
  echo "Git-дефолты применены (longpaths, main, autocrlf=input)."
}

echo "Проверяю Git..."
if have git && git --version >/dev/null 2>&1; then
  echo "Git уже установлен: $(git --version)"
  set_git_defaults
  exit 0
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
    echo "OK: Git установлен: $(git --version 2>/dev/null || echo ok)"
    set_git_defaults
    exit 0
  fi
  i=$((i + 1))
  sleep 10
done

echo "ОШИБКА: Git пока не установлен — установка Command Line Tools ещё не завершилась."
echo "Дождись окончания установки в открывшемся окне и нажми «Повторить неустановленное»."
exit 1
