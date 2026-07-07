#!/usr/bin/env bash
# Shared helpers for macOS component scripts.
have() { command -v "$1" >/dev/null 2>&1; }
dl()   { curl -fsSL "$1" -o "$2"; }
# Run a shell command with a native macOS admin (GUI password) prompt.
# Экранируем \ и " для строки AppleScript: путь к приложению может лежать в папке
# с апострофом/кавычкой (напр. "Zhemal's USB"), иначе команда root'а ломается или
# в неё инъецируются лишние токены. bash 3.2-safe.
admin_run() {
  local c="$*"
  c=${c//\\/\\\\}
  c=${c//\"/\\\"}
  /usr/bin/osascript -e "do shell script \"$c\" with administrator privileges"
}
arch_tag() { case "$(uname -m)" in arm64) echo arm64 ;; *) echo x64 ;; esac; }

# Прописывает ~/.local/bin в PATH новых терминалов (claude и вшитый git кладутся туда).
# Вынесено сюда из claude.sh: git.sh исполняется раньше и тоже это использует.
persist_local_bin_path() {
  line='export PATH="$HOME/.local/bin:$PATH"'
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
    # Создавать ~/.bash_profile «с нуля» опасно: bash-login читает ПЕРВЫЙ из
    # .bash_profile/.bash_login/.profile — новый .bash_profile замаскирует
    # существующий ~/.profile с пользовательским PATH/env. Если создаём —
    # сначала подключаем .profile.
    if [ ! -e "$rc" ]; then
      : > "$rc"
      if [ "$rc" = "$HOME/.bash_profile" ] && [ -f "$HOME/.profile" ]; then
        printf '[ -f "$HOME/.profile" ] && . "$HOME/.profile"\n' >> "$rc"
      fi
    fi
    if ! grep -qF 'HAMIDUN_LOCAL_BIN' "$rc" 2>/dev/null; then
      printf '\n# HAMIDUN_LOCAL_BIN — claude/git в PATH\n%s\n' "$line" >> "$rc"
    fi
  done
}

# ---- Целостность вшитых артефактов (SHA-256 против vendor/checksums.json) ----
# Fail-closed: перед запуском ЛЮБОГО вшитого установщика (vendor/apps/*) сверяем
# его SHA-256 с манифестом. При несовпадении/отсутствии манифеста — стоп (exit 1),
# вшитый установщик НЕ исполняется. Вызывать ТОЛЬКО для вшитых артефактов, НЕ для
# онлайн-загрузок (у них другая версия -> хэш законно не совпадёт).

hm_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" 2>/dev/null | awk '{print $NF}'
  else echo ""; fi
}

# Достаёт ожидаемый sha256 для имени файла из $HM_VENDOR/checksums.json
# (одна запись = одна строка: "name": { "sha256": "<64hex>", "bytes": N }).
hm_expected_sha256() {
  local chk="${HM_VENDOR:-}/checksums.json" name="$1"
  [ -f "$chk" ] || return 1
  grep -F "\"$name\":" "$chk" 2>/dev/null | head -n1 \
    | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{64\}\)".*/\1/p'
}

# Fail-closed вентиль: при несовпадении печатает ошибку и exit 1 (останавливает скрипт).
verify_artifact() {
  local f="$1" name expected actual
  name="$(basename "$f")"
  if [ ! -f "$f" ]; then
    echo "БЕЗОПАСНОСТЬ: файл для проверки не найден ($f) — установка остановлена."; exit 1
  fi
  if [ -z "${HM_VENDOR:-}" ]; then
    echo "БЕЗОПАСНОСТЬ: не задан HM_VENDOR — невозможно проверить целостность '$name'. Установка остановлена."; exit 1
  fi
  if [ ! -f "${HM_VENDOR}/checksums.json" ]; then
    echo "БЕЗОПАСНОСТЬ: манифест целостности не найден (${HM_VENDOR}/checksums.json). Отказываюсь запускать вшитый '$name'. Установка остановлена."; exit 1
  fi
  expected="$(hm_expected_sha256 "$name" | tr 'A-Z' 'a-z')"
  if [ -z "$expected" ]; then
    echo "БЕЗОПАСНОСТЬ: в checksums.json нет записи для '$name' — возможна подмена. Установка остановлена."; exit 1
  fi
  actual="$(hm_sha256 "$f" | tr 'A-Z' 'a-z')"
  if [ -z "$actual" ]; then
    echo "БЕЗОПАСНОСТЬ: не удалось вычислить SHA-256 для '$name' (нет shasum/openssl). Установка остановлена."; exit 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "БЕЗОПАСНОСТЬ: НЕ СОВПАЛ SHA-256 для '$name' — файл подменён/повреждён. Установка остановлена."
    echo "  ожидалось: $expected"
    echo "  получено:  $actual"
    exit 1
  fi
  echo "  Целостность подтверждена (SHA-256): $name"
}

# Нефатальный вариант — для НЕ исполняемых best-effort артефактов (шрифт):
# возвращает 0 при совпадении, 1 иначе; НЕ рушит установку.
verify_artifact_soft() {
  local f="$1" name expected actual
  name="$(basename "$f")"
  [ -f "$f" ] || return 1
  [ -n "${HM_VENDOR:-}" ] || return 1
  expected="$(hm_expected_sha256 "$name" | tr 'A-Z' 'a-z')"
  [ -n "$expected" ] || return 1
  actual="$(hm_sha256 "$f" | tr 'A-Z' 'a-z')"
  [ -n "$actual" ] || return 1
  [ "$actual" = "$expected" ]
}
