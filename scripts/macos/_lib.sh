#!/usr/bin/env bash
# Shared helpers for macOS component scripts.
have() { command -v "$1" >/dev/null 2>&1; }
dl()   { curl -fsSL "$1" -o "$2"; }
# ---- Запуск команды под root с нативным macOS GUI-промптом пароля ----
# admin_run ПРИНИМАЕТ ARGV (НЕ строку): admin_run /bin/cp -R "$SRC" "$DEST".
# Каждый аргумент отдельно квотируется для shell ('...', внутренние ' -> '\''
# — bash 3.2-safe), ЗАТЕМ вся строка экранируется для AppleScript (\ и ").
# Имя .app / путь из DMG с ' ; $(...) ` " НЕ может инъецировать root-команду
# (THREAT-MODEL round-4: shell-инъекция через admin_run закрыта).

# Безопасное POSIX-квотирование ОДНОГО аргумента: '...' + внутренние ' -> '\''.
shell_quote_arg() {
  local s="$1" q="'\''"
  s=${s//\'/$q}
  printf "'%s'" "$s"
}

# Склейка argv -> безопасная sh-команда (вынесено отдельно — тестируемо без osascript).
admin_build_cmd() {
  local c="" a
  for a in "$@"; do
    c="${c:+$c }$(shell_quote_arg "$a")"
  done
  printf '%s' "$c"
}

admin_run() {
  if [ "$#" -lt 1 ]; then
    echo "admin_run: нужна команда как argv (аргументы), не строка"; return 1
  fi
  local c
  c="$(admin_build_cmd "$@")"
  # Экранирование для строкового литерала AppleScript: \ и ", затем сырые
  # переводы строк (AppleScript-строка не может содержать raw LF/CR; \n/\r
  # декодируются обратно внутри одинарных sh-кавычек байт-в-байт).
  c=${c//\\/\\\\}
  c=${c//\"/\\\"}
  c=${c//$'\n'/\\n}
  c=${c//$'\r'/\\r}
  # Санитизация окружения root-исполнения (Codex P1, env-hijack). `do shell script
  # ... with administrator privileges` ЗАПУСКАЕТ root `/bin/sh -c` и НАСЛЕДУЕТ
  # окружение osascript, а его — от medium-шелла (Apple TN2065). Same-UID атакующий
  # экспортирует любой из: BASH_FUNC_mktemp%%=() {payload;} (функция перекрывает
  # системный binary ДАЖЕ при фикс-PATH — функции старше PATH-поиска), ENV/BASH_ENV
  # (/bin/sh=bash в POSIX-режиме сорсит $ENV на старте), SHELLOPTS=xtrace + PS4='$(payload)'
  # (xtrace вычисляет PS4 command-substitution ПЕРЕД первой командой), DYLD_INSERT_LIBRARIES —
  # и payload выполнится КАК ROOT ещё до строки PATH и до codesign. Фикс-PATH в скриптах
  # закрывает ТОЛЬКО PATH; функции/SHELLOPTS/ENV/DYLD он не трогает. `env -i` СТИРАЕТ ВСЁ
  # окружение и передаёт root-шеллу лишь PATH (только системные каталоги) + HOME (osascript
  # читает префы; root-скрипты используют абсолютные /var/root-пути и НЕ ссылаются на ~/$HOME,
  # поэтому HOME инертен для root-исполнения). Так root-шелл гарантированно стартует из
  # чистого окружения — весь класс env-hijack закрыт в ОДНОЙ точке (фикс-PATH остаётся как
  # defense-in-depth). Диалог пароля рисует SecurityAgent через Mach-порт (наследуется задачей,
  # не env) — env -i его не ломает.
  /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" \
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

# ---- Атомарные root-скрипты: verify + install под ОДНИМ admin_run (fail-closed) ----
# ЗАКРЫВАЕТ TOCTOU verify(medium)->install(root) (Codex round-4 P1). Раньше подпись
# проверялась medium-процессом СНАРУЖИ admin_run, а installer/cp шёл root'ом ВНУТРИ:
# пока открыт osascript-промпт пароля, процесс ТОГО ЖЕ пользователя мог перезаписать
# /tmp/*.pkg или detach mount и подменить .app -> root ставил ДРУГИЕ байты.
# Теперь ОДИН root-процесс: (1) копирует артефакт в root-owned приватный staging
# (mktemp -d /var/root, режим 0700 — процесс пользователя туда не запишет), (2) проверяет
# подпись ИМЕННО staged-объекта, (3) ставит/копирует РОВНО его, (4) чистит staging.
# Между verify и install окна нет: staged-объект root-owned и недоступен на запись.
#
# Helper-функции _lib.sh внутри `sh -c` под root НЕДОСТУПНЫ (свежий шелл от osascript) —
# поэтому проверка подписи ИНЛАЙНится в этих скриптах. ВСЕ внешние значения (путь,
# Team ID, имя назначения) передаются ТОЛЬКО ПОЗИЦИОННЫМИ параметрами ($1/$2/$3), НЕ
# интерполяцией в текст скрипта — инъекция через имя/путь невозможна (admin_run
# шелл-квотирует каждый argv-элемент, включая сам скрипт как единый элемент).
# Инструменты — АБСОЛЮТНЫЕ пути; отсутствие/не-исполняемость -> fail-CLOSED (|| exit 1).
#
# env-hijack (Codex P1): osascript `do shell script ... with administrator privileges`
# НАСЛЕДУЕТ окружение запускающего medium-шелла (Apple TN2065). ПЕРВИЧНОЕ закрытие —
# в admin_run: osascript запускается под `env -i PATH=... HOME=...`, root-шелл стартует
# из чистого окружения (нет BASH_FUNC_*/ENV/BASH_ENV/SHELLOPTS/DYLD_*/hostile PATH).
# Фикс-PATH ниже — defense-in-depth: даже если бы окружение утекло, bare-команды (mktemp,
# head, rm в trap, grep, find) резолвятся ТОЛЬКО из системных каталогов. ПЕРВОЙ строкой
# КАЖДОГО скрипта фиксируем PATH=/usr/bin:/bin:/usr/sbin:/sbin.

# HM_PKG_INSTALL_SH — .pkg под root: $1=путь к .pkg, $2=Developer ID Installer Team ID.
#   pkgutil --check-signature на staged pkg: exit-код + статус Apple Developer ID +
#   leaf-серт "1. Developer ID Installer: ... (TeamID)$" (Team ID заякорен в конце CN —
#   подстрока в середине имени не пройдёт). Затем installer РОВНО staged pkg.
HM_PKG_INSTALL_SH='PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
set -e
[ -x /usr/sbin/pkgutil ] || exit 1
[ -x /usr/sbin/installer ] || exit 1
d="$(mktemp -d /var/root/hm_pkg.XXXXXX)" || exit 1
trap "rm -rf \"$d\"" EXIT
/bin/cp "$1" "$d/p.pkg" || exit 1
out="$(/usr/sbin/pkgutil --check-signature "$d/p.pkg" 2>/dev/null)" || exit 1
printf "%s\n" "$out" | grep -q "Status: signed by a developer certificate issued by Apple" || exit 1
printf "%s\n" "$out" | grep -Eq "^[[:space:]]*1\. Developer ID Installer: .* \($2\)[[:space:]]*$" || exit 1
/usr/sbin/installer -pkg "$d/p.pkg" -target / || exit 1'

# HM_APP_INSTALL_SH — .app из DMG под root: $1=исходный .app (на mount), $2=Team ID,
#   $3=имя бандла в /Applications. codesign --verify -R (нативный designated requirement:
#   anchor apple generic + ТОЧНЫЙ Team ID через certificate leaf[subject.OU]; крипто-оценка
#   самой подписи, НЕ парсинг -dv) + spctl --assess (нотаризация) на STAGED копии, затем
#   cp staged в /Applications. detach mount ПОСЛЕ этого уже не влияет (работаем с копией).
HM_APP_INSTALL_SH='PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
set -e
[ -x /usr/bin/codesign ] || exit 1
[ -x /usr/sbin/spctl ] || exit 1
d="$(mktemp -d /var/root/hm_app.XXXXXX)" || exit 1
trap "rm -rf \"$d\"" EXIT
/bin/cp -R "$1" "$d/app.app" || exit 1
/usr/bin/codesign --verify --deep --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \"$2\"" "$d/app.app" >/dev/null 2>&1 || exit 1
/usr/sbin/spctl --assess --type execute "$d/app.app" >/dev/null 2>&1 || exit 1
/bin/cp -R "$d/app.app" "/Applications/$3" || exit 1'

# HM_VSCODE_INSTALL_SH — вшитый .zip VS Code под root: $1=путь к .zip, $2=Team ID,
#   $3=ПОЛНЫЙ путь назначения (/Applications/Visual Studio Code.app). cp zip в staging ->
#   ditto распаковка в staging -> codesign -R (Team ID Microsoft) + spctl (нотаризация)
#   распакованного .app -> cp .app в назначение -> снять карантин. Всё над root-owned
#   staging: SHA на вшитом zip НЕ защищает от same-UID подмены (checksums.json тоже
#   same-UID) — гейт = крипто-подпись Microsoft на распакованном бандле.
HM_VSCODE_INSTALL_SH='PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
set -e
[ -x /usr/bin/ditto ] || exit 1
[ -x /usr/bin/find ] || exit 1
[ -x /usr/bin/codesign ] || exit 1
[ -x /usr/sbin/spctl ] || exit 1
[ -x /usr/bin/xattr ] || exit 1
d="$(mktemp -d /var/root/hm_vsc.XXXXXX)" || exit 1
trap "rm -rf \"$d\"" EXIT
/bin/cp "$1" "$d/vscode.zip" || exit 1
/usr/bin/ditto -x -k "$d/vscode.zip" "$d/unz" || exit 1
app="$(/usr/bin/find "$d/unz" -maxdepth 2 -type d -name "*.app" | head -n1)"
[ -n "$app" ] || exit 1
/usr/bin/codesign --verify --deep --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \"$2\"" "$app" >/dev/null 2>&1 || exit 1
/usr/sbin/spctl --assess --type execute "$app" >/dev/null 2>&1 || exit 1
/bin/cp -R "$app" "$3" || exit 1
/usr/bin/xattr -dr com.apple.quarantine "$3" || exit 1'
