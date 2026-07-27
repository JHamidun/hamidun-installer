#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# Ставим в ПОЛЬЗОВАТЕЛЬСКИЙ prefix (~/.local): node из .pkg держит глобальный
# npm-prefix в /usr/local (root:wheel) → `npm -g` без sudo падает с EACCES.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
INSTALLED=0

# === ЕДИНЫЙ гейт «claude РАБОТАЕТ» — для ВСЕХ путей установки (офлайн/онлайн/финал) ===
# НУЛЕВОЙ КОД ВОЗВРАТА УСТАНОВЩИКА НИЧЕГО НЕ ДОКАЗЫВАЕТ. Настоящий бинарь Claude
# ставится ПЛАТФОРМЕННЫМ optional-пакетом (@anthropic-ai/claude-code-darwin-<arch>).
# Если его нет, npm считает optional-зависимость необязательной, ОТЧИТЫВАЕТСЯ УСПЕХОМ
# и оставляет обёртку, чей bin печатает «claude native binary not installed» и выходит
# с ошибкой. Живой случай: npm отчитался успехом ОНЛАЙН, человек получил зелёную
# галочку и нерабочий claude — худший исход из всех. Раньше проверка запуском была
# ТОЛЬКО в офлайн-ветке; теперь «установлен» = ОТВЕТИЛ СВОЕЙ ВЕРСИЕЙ на любом пути.
# При провале НАШ артефакт (~/.local) удаляется: иначе нерабочая обёртка перехватит
# PATH и «claude» будет падать даже после успешной установки другим путём. Чужой
# claude (brew и т.п.) НЕ трогаем — удаляем только то, что кладём сами.
claude_install_ok() {
  local bin=""
  if [ -x "$HOME/.local/bin/claude" ]; then bin="$HOME/.local/bin/claude"
  elif have claude; then bin="$(command -v claude)"
  else return 1; fi
  if "$bin" --version >/dev/null 2>&1; then return 0; fi
  echo "Проверка запуском: claude на месте, но НЕ отвечает — убираю нерабочий артефакт из ~/.local."
  rm -f "$HOME/.local/bin/claude" 2>/dev/null
  rm -rf "$HOME/.local/lib/node_modules/@anthropic-ai/claude-code" 2>/dev/null
  return 1
}

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
      # Проверка не кодом npm, а РАБОТОЙ (claude_install_ok выше): в кеше может не быть
      # платформенного бинаря — обёртка-пустышка удаляется там же.
      if claude_install_ok; then
        INSTALLED=1
      else
        echo "Офлайн-установка отчиталась успехом, но claude не запускается (в кеше нет платформенного бинаря) — пробую онлайн-фолбэк."
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
  # ОБА онлайн-пути гейтятся claude_install_ok: скрипт claude.ai и npm умеют
  # отчитаться успехом, оставив нерабочий артефакт (тот же класс сбоя, что офлайн).
  # При провале проверки нерабочая обёртка уже удалена — следующий путь стартует чисто.
  if curl -fsSL --connect-timeout 20 --max-time 900 --retry 3 --retry-connrefused https://claude.ai/install.sh | bash \
     && claude_install_ok; then
    INSTALLED=1
  elif have npm && npm install -g --prefix "$HOME/.local" '@anthropic-ai/claude-code' --no-audit --no-fund \
     && claude_install_ok; then
    INSTALLED=1
  else
    echo "Сеть недоступна, очень медленная или установка не дала РАБОТАЮЩИЙ claude — повтори установку этого компонента."
  fi
fi

# persist_local_bin_path вынесена в _lib.sh (её использует и git.sh для вшитого git).

# Честный финальный гейт: не «файл на диске», а РАБОТАЕТ. Тот же claude_install_ok:
# нерабочий артефакт здесь же удаляется, и человек видит красный статус, а не ложный OK
# с бинарём, который упадёт при первом запуске.
export PATH="$HOME/.local/bin:$PATH"
if claude_install_ok; then
  persist_local_bin_path
  if have claude; then echo "OK: $(claude --version 2>&1 | head -n1)"
  else echo "OK: claude установлен, PATH прописан — открой НОВЫЙ терминал для команды claude."; fi
  exit 0
else
  echo "ОШИБКА: Claude Code CLI не установился или не запускается — смотри лог выше."; exit 1
fi
