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
  # Убираем ТОЛЬКО то, что положили сами. Снимок PRE_EXISTING снят до любой нашей
  # установки (ниже): если claude в ~/.local уже лежал ДО нас, он не наш — его мог
  # поставить сам человек своим npm, и не ответить на --version тот может по причине,
  # к нам не относящейся (урезанный PATH под GUI, отсутствующий node). Зеркало
  # claude.ps1:196-201, где такой снимок есть; здесь его просто не было, и установщик
  # удалял чужие файлы, ничего при этом не установив.
  if [ "${PRE_EXISTING:-none}" = "ours-absent" ]; then
    echo "Проверка запуском: claude на месте, но НЕ отвечает — убираю нерабочий артефакт из ~/.local."
    rm -f "$HOME/.local/bin/claude" 2>/dev/null
    rm -rf "$HOME/.local/lib/node_modules/@anthropic-ai/claude-code" 2>/dev/null
  else
    echo "Проверка запуском: claude на месте, но НЕ отвечает. Он лежал здесь ДО установки — не трогаю чужое."
  fi
  return 1
}

# Снимок ДО любой нашей установки: был ли claude в ~/.local уже на месте.
# 'ours-absent' — файла не было, значит всё, что появится там дальше, положили мы (и
# нерабочее можно убрать). 'pre-existing' — файл был, трогать его нельзя.
PRE_EXISTING='ours-absent'
if [ -e "$HOME/.local/bin/claude" ] || [ -L "$HOME/.local/bin/claude" ]; then PRE_EXISTING='pre-existing'; fi

# Платформенный пакет Claude Code для ТЕКУЩЕЙ архитектуры. Настоящий бинарь едет
# именно в нём (@anthropic-ai/claude-code-darwin-arm64 | -darwin-x64), а не в
# основном пакете. Сборочный раннер GitHub macos-latest — Apple Silicon, поэтому
# `npm install` кеширует .tgz ТОЛЬКО под arm64: на Intel офлайн-ветка ставила
# обёртку-пустышку, claude_install_ok её ловил и молча уходил в интернет — то есть
# «офлайн-издание» на Intel офлайн НЕ работало, и человек этого не знал.
# Проверяем наличие АРХИВА (не ответа реестра — он кеширован для обеих платформ) и
# говорим правду ДО того, как потратим минуту на заведомо пустую установку.
CLAUDE_PLAT_PKG="claude-code-darwin-$(arch_tag)"
OFFLINE_HAS_ARCH=0
if [ -n "${HM_VENDOR:-}" ] && [ -d "$HM_VENDOR/npm-cache" ]; then
  if hm_npm_cache_has_tarball "$HM_VENDOR/npm-cache" "$CLAUDE_PLAT_PKG"; then
    OFFLINE_HAS_ARCH=1
  else
    echo "Офлайн-копия Claude Code в этой сборке собрана только под $(hm_arch_human "$(hm_other_arch)")."
    echo "Твой Mac — на $(hm_arch_human), поэтому этот компонент нужно скачать из интернета."
    echo "Это не ошибка: сейчас установлю Claude Code онлайн (нужно рабочее подключение)."
  fi
fi

if [ "$OFFLINE_HAS_ARCH" -eq 1 ] && have npm; then
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
    if [ "$OFFLINE_HAS_ARCH" -eq 0 ]; then
      echo "Важно: офлайн-копии под $(hm_arch_human) в этой сборке нет, поэтому без интернета этот компонент не поставить."
    fi
  fi
fi

# persist_local_bin_path вынесена в _lib.sh (её использует и git.sh для вшитого git).

# Честный финальный гейт: не «файл на диске», а РАБОТАЕТ. Тот же claude_install_ok:
# нерабочий артефакт здесь же удаляется, и человек видит красный статус, а не ложный OK
# с бинарём, который упадёт при первом запуске.

# Вердикт ЗАПУСКОМ пишем в ~/.hamidun-setup/checks.json — зеркало Write-HmCheck из
# claude.ps1:269. Финальный чек-лист (verify.sh) обязан ПЕРЕНЕСТИ его, а не выводить
# заново по наличию файла: наличие обёртки ничего не доказывает — её оставляет и
# провалившаяся установка, и «✓» по файлу давало зелёную галочку при неработающем
# claude. Один факт «claude работает» — один стандарт доказательства на обеих ОС;
# до сих пор он был только на Windows. Диагностика не должна ломать установку,
# поэтому все ошибки записи глушим.
hm_write_check() {
  local name="$1" verdict="$2" dir="$HOME/.hamidun-setup" file tmp now
  file="$dir/checks.json"; tmp="$file.$$.tmp"; now=$(date +%s000 2>/dev/null || echo 0)
  mkdir -p "$dir" 2>/dev/null || return 0
  # Правим JSON через python3 только если он есть и не голый CLT-шим; иначе пишем
  # одиночную запись — verify.sh читает конкретный ключ, а не всю структуру.
  if command -v python3 >/dev/null 2>&1 && { [ "$(command -v python3)" != "/usr/bin/python3" ] || xcode-select -p >/dev/null 2>&1; }; then
    python3 - "$file" "$tmp" "$name" "$verdict" "$now" <<'PY' 2>/dev/null || return 0
import io, json, os, sys
f, tmp, name, verdict, now = sys.argv[1:6]
data = {}
try:
    with io.open(f, encoding='utf-8') as fh: data = json.load(fh)
    if not isinstance(data, dict): data = {}
except Exception:
    data = {}
data[name] = {'verdict': verdict, 'at': int(now)}
with io.open(tmp, 'w', encoding='utf-8') as fh: json.dump(data, fh, ensure_ascii=False)
os.replace(tmp, f)
PY
  else
    printf '{"%s":{"verdict":"%s","at":%s}}' "$name" "$verdict" "$now" > "$tmp" 2>/dev/null && mv -f "$tmp" "$file" 2>/dev/null
  fi
  return 0
}

export PATH="$HOME/.local/bin:$PATH"
if claude_install_ok; then
  persist_local_bin_path
  hm_write_check claude works
  if have claude; then echo "OK: $(claude --version 2>&1 | head -n1)"
  else echo "OK: claude установлен, PATH прописан — открой НОВЫЙ терминал для команды claude."; fi
  exit 0
else
  hm_write_check claude broken
  echo "ОШИБКА: Claude Code CLI не установился или не запускается — смотри лог выше."; exit 1
fi
