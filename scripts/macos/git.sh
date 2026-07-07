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
  # user.name и user.email — каждый независимо: у пользователя может быть настроен
  # только email (или только имя), затирать уже заданное нельзя.
  un="${USER:-user}"
  local set_any=0
  if [ -z "$(git config --global user.name 2>/dev/null || true)" ]; then
    git config --global user.name "$un" 2>/dev/null || true; set_any=1
  fi
  if [ -z "$(git config --global user.email 2>/dev/null || true)" ]; then
    git config --global user.email "${un}@example.com" 2>/dev/null || true; set_any=1
  fi
  [ "$set_any" -eq 1 ] && echo "Git: user.name/user.email заданы по умолчанию — поменяй потом: git config --global user.email твоя@почта"
  echo "Git-дефолты применены (longpaths, main, autocrlf=input)."
}

echo "Проверяю Git..."
# Не дёргаем голый /usr/bin/git-шим на чистом маке (его вызов сам может открыть
# CLT-диалог): доверяем `git --version` только если git НЕ шим ИЛИ CLT уже стоит.
if have git && { [ "$(command -v git)" != "/usr/bin/git" ] || xcode-select -p >/dev/null 2>&1; } && git --version >/dev/null 2>&1; then
  echo "Git уже установлен: $(git --version)"
  set_git_defaults
  exit 0
fi

# --- Вшитый портативный Git (dugite-native от GitHub Desktop) — офлайн, БЕЗ окон Apple ---
# Основной путь на чистом маке: не триггерит установку Command Line Tools (и её баг
# «осталось 130 часов»). CLT-ветка ниже остаётся фолбэком, если пакета нет/не завёлся.
GIT_TGZ="${HM_VENDOR:-}/apps/git-macos-$(arch_tag).tar.gz"
if [ -n "${HM_VENDOR:-}" ] && [ -f "$GIT_TGZ" ]; then
  echo "Ставлю Git из встроенного пакета (офлайн, без системных окон Apple)..."
  verify_artifact "$GIT_TGZ"                       # fail-closed SHA-256
  GROOT="$HOME/.local/hamidun-git"
  rm -rf "$GROOT"; mkdir -p "$GROOT" "$HOME/.local/bin"
  if tar -xzf "$GIT_TGZ" -C "$GROOT" 2>/dev/null && [ -x "$GROOT/bin/git" ]; then
    # Снимаем quarantine (если vendor копировался через Finder/.dmg) — иначе Gatekeeper.
    xattr -dr com.apple.quarantine "$GROOT" 2>/dev/null || true
    # Wrapper: dugite собран без RUNTIME_PREFIX, бинарю нужны GIT_EXEC_PATH и шаблоны.
    cat > "$HOME/.local/bin/git" <<EOF
#!/bin/sh
export GIT_EXEC_PATH="$GROOT/libexec/git-core"
export GIT_TEMPLATE_DIR="$GROOT/share/git-core/templates"
[ -z "\${GIT_CONFIG_SYSTEM:-}" ] && export GIT_CONFIG_SYSTEM="$GROOT/etc/gitconfig"
exec "$GROOT/bin/git" "\$@"
EOF
    chmod +x "$HOME/.local/bin/git"
    export PATH="$HOME/.local/bin:$PATH"
    if "$HOME/.local/bin/git" --version >/dev/null 2>&1; then
      persist_local_bin_path
      echo "OK: Git установлен из встроенного пакета: $("$HOME/.local/bin/git" --version)"
      set_git_defaults
      exit 0
    fi
    echo "Встроенный Git не запустился — перехожу к установке через Apple Command Line Tools."
    rm -f "$HOME/.local/bin/git"
  else
    echo "Встроенный пакет Git не распаковался — перехожу к Apple Command Line Tools."
  fi
fi

echo "Запускаю установку Command Line Tools (включает Git)..."
xcode-select --install 2>/dev/null || true
echo "Открылось системное окно Apple «Установка ПО» — нажми «Установить»."
echo ""
echo "  ВНИМАНИЕ: если Apple показывает оценку в десятки или сотни часов"
echo "  (\"осталось 130 часов\") — это ИЗВЕСТНЫЙ БАГ macOS, а не реальное время."
echo "  Реальный размер ~1 ГБ, обычно 5-15 минут. Если оценка абсурдная или"
echo "  прогресс завис — сделай так:"
echo "    1. Нажми «Остановить» в окне Apple."
echo "    2. Скачай Command Line Tools вручную (качается за минуты на полной скорости):"
echo "       https://developer.apple.com/download/all/"
echo "       (в поиске набери «Command Line Tools», нужен бесплатный Apple ID)"
echo "    3. Установи скачанный .dmg и нажми в установщике «Повторить неустановленное» —"
echo "       Git подхватится сам."
echo ""
echo "Жду завершения установки Command Line Tools..."

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
