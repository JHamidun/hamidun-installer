#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# Ставим в ПОЛЬЗОВАТЕЛЬСКИЙ prefix (~/.local): node из .pkg держит глобальный
# npm-prefix в /usr/local (root:wheel) → `npm -g` без sudo падает с EACCES.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
INSTALLED=0

if [ -n "${HM_VENDOR:-}" ] && [ -d "$HM_VENDOR/npm-cache" ] && have npm; then
  echo "Claude Code CLI из встроенного npm-кеша (офлайн)..."
  # npm ТРЕБУЕТ записываемый кэш: он пишет туда логи, локи и _cacache/tmp даже в режиме
  # --offline. На macOS vendor лежит на ОБРАЗЕ ТОЛЬКО ДЛЯ ЧТЕНИЯ (/Volumes/...), поэтому
  # прямой --cache на него давал «ENOTCACHED» и «Log files were not written to
  # .../npm-cache/_logs» — офлайн-установка падала ВСЕГДА, спасал только онлайн-фолбэк,
  # то есть «офлайн-издание» на маке офлайн не работало. Копируем кэш в записываемый
  # временный каталог и ставим уже из копии.
  NPMTMP="$(mktemp -d "${TMPDIR:-/tmp}/hm-npmcache.XXXXXX" 2>/dev/null || echo '')"
  if [ -n "$NPMTMP" ] && cp -R "$HM_VENDOR/npm-cache" "$NPMTMP/npm-cache" 2>/dev/null; then
    # Права на копии доводим явно: файлы на образе могут прийти без права записи, и
    # тогда npm упрётся в то же самое уже во временном каталоге.
    chmod -R u+w "$NPMTMP/npm-cache" 2>/dev/null || true
    if npm install -g --prefix "$HOME/.local" '@anthropic-ai/claude-code' \
         --offline --cache "$NPMTMP/npm-cache" --no-audit --no-fund; then
      # НУЛЕВОЙ КОД ВОЗВРАТА ЗДЕСЬ НИЧЕГО НЕ ДОКАЗЫВАЕТ.
      # Настоящий бинарь Claude ставится ПЛАТФОРМЕННЫМ optional-пакетом
      # (@anthropic-ai/claude-code-darwin-<arch>). Если его в кэше нет, npm считает
      # optional-зависимость необязательной, ОТЧИТЫВАЕТСЯ УСПЕХОМ и оставляет обёртку,
      # чей bin печатает «claude native binary not installed» и выходит с ошибкой.
      # Человек увидел бы зелёную галочку и нерабочий claude — худший исход из всех.
      # Поэтому проверяем не код, а РАБОТУ: команда обязана ответить своей версией.
      if "$HOME/.local/bin/claude" --version >/dev/null 2>&1; then
        INSTALLED=1
      else
        echo "Офлайн-установка отчиталась успехом, но claude не запускается (в кеше нет платформенного бинаря) — пробую онлайн-фолбэк."
        # Убираем нерабочую обёртку: иначе она перехватит PATH и «claude» будет падать
        # даже после успешной онлайн-установки в другой каталог.
        rm -f "$HOME/.local/bin/claude" 2>/dev/null
        rm -rf "$HOME/.local/lib/node_modules/@anthropic-ai/claude-code" 2>/dev/null
      fi
    else
      echo "Офлайн-установка не удалась — пробую онлайн-фолбэк."
    fi
  else
    echo "Не удалось подготовить временный npm-кеш — пробую онлайн-фолбэк."
  fi
  [ -n "$NPMTMP" ] && rm -rf "$NPMTMP"
fi

if [ "$INSTALLED" -eq 0 ]; then
  echo "Устанавливаю Claude Code CLI (нативный установщик, онлайн)..."
  # Таймауты обязательны: curl без --max-time на РФ-DPI виснет молча навсегда.
  if curl -fsSL --connect-timeout 20 --max-time 900 --retry 3 --retry-connrefused https://claude.ai/install.sh | bash; then
    INSTALLED=1
  elif have npm && npm install -g --prefix "$HOME/.local" '@anthropic-ai/claude-code' --no-audit --no-fund; then
    INSTALLED=1
  else
    echo "Сеть недоступна или очень медленная — повтори установку этого компонента."
  fi
fi

# persist_local_bin_path вынесена в _lib.sh (её использует и git.sh для вшитого git).

# Честная проверка: бинарь реально на диске? (иначе — красный статус, а не ложный OK)
export PATH="$HOME/.local/bin:$PATH"
if have claude || [ -x "$HOME/.local/bin/claude" ]; then
  persist_local_bin_path
  if have claude; then echo "OK: $(claude --version 2>&1 | head -n1)"
  else echo "OK: claude установлен, PATH прописан — открой НОВЫЙ терминал для команды claude."; fi
  exit 0
else
  echo "ОШИБКА: Claude Code CLI не установился — смотри лог выше."; exit 1
fi
