#!/usr/bin/env bash
# Shared helpers for macOS component scripts.
have() { command -v "$1" >/dev/null 2>&1; }
# Скачивание с жёсткими сетевыми таймаутами: curl без --connect-timeout/--max-time
# на РФ-DPI виснет молча навсегда (эталон: claude-desktop.sh/chatgpt-desktop.sh).
# -# вместо -s — видимый прогресс (вывод curl стримится в UI установщика).
# При провале удаляем частично скачанный файл — обрывок не должен пройти проверки ниже.
dl() {
  if ! curl -fSL -# --connect-timeout 20 --max-time 900 --retry 3 --retry-connrefused "$1" -o "$2"; then
    rm -f "$2" 2>/dev/null || true
    echo "Сеть недоступна или очень медленная — повтори установку этого компонента."
    return 1
  fi
}
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

# ---- Архитектура Mac: честный выбор артефакта и честный отказ ----
# Живой случай 07.08.2026 (Intel Mac, x86_64): «Готово 1 · Ошибок 4 · Пропущено 2».
# Корень был НЕ в том, что файлы однорукие, а в том, что часть содержимого vendor
# собирается «под текущую платформу раннера», а раннер GitHub macos-latest — Apple
# Silicon. Всё, что тянется так (npm optionalDependencies, pip wheels, playwright),
# уезжает в сборку ТОЛЬКО в arm64-варианте, и на Intel и офлайн-, и онлайн-путь
# упираются в одно и то же: готового пакета под эту архитектуру нет.
#
# ПРАВИЛО: молчаливое падение хуже отсутствия компонента. Если под текущую арх
# артефакта нет — надо СКАЗАТЬ это словами, которые понимает человек, и уйти в
# осознанный пропуск (exit 120), а не рушить установку кодом 1 с простынёй из
# cargo/pip. Ниже — общий словарь таких сообщений (используют git/uv/extension/
# vscode/claude/pydeps).
hm_other_arch() { case "$(arch_tag)" in arm64) echo x64 ;; *) echo arm64 ;; esac; }
hm_arch_human() {
  case "${1:-$(arch_tag)}" in
    arm64) echo "Apple Silicon (M1/M2/M3/M4)" ;;
    *)     echo "Intel" ;;
  esac
}

# hm_arch_note_missing <каталог> <префикс> <суффикс> <человеческое имя>
# Артефакта под НАШУ архитектуру нет, а под ДРУГУЮ — есть: печатает честное
# объяснение и возвращает 0 (значит, дело именно в архитектуре сборки).
# Возвращает 1, если дело в другом (нет ни под одну арх / наш файл на месте) —
# тогда вызывающий печатает свой обычный текст.
hm_arch_note_missing() {
  hm_arch_dir="$1"; hm_arch_pre="$2"; hm_arch_suf="$3"; hm_arch_label="$4"
  [ -n "$hm_arch_dir" ] || return 1
  [ -f "$hm_arch_dir/$hm_arch_pre$(arch_tag)$hm_arch_suf" ] && return 1
  [ -f "$hm_arch_dir/$hm_arch_pre$(hm_other_arch)$hm_arch_suf" ] || return 1
  echo "--------------------------------------------------------------"
  echo "  $hm_arch_label: в этой сборке лежит версия только под $(hm_arch_human "$(hm_other_arch)"),"
  echo "  а твой Mac — на $(hm_arch_human). Подходящий файл в установщик не попал."
  echo "  Это не поломка компьютера и не ошибка установки — так собрана сборка."
  echo "  Что делать: напиши в бота поддержки, пришлём сборку под $(hm_arch_human)."
  echo "--------------------------------------------------------------"
  return 0
}

# hm_arch_unavailable <человеческое имя> [что делать]
# Единый текст «этого компонента для твоего Mac не существует» — когда готовой
# сборки нет НИ в установщике, НИ в интернете (собрать на месте нельзя: на чистом
# Mac нет компиляторов). Вызывающий после этого делает exit 120 (осознанный
# пропуск), а НЕ exit 1: остальные компоненты обязаны доставиться.
hm_arch_unavailable() {
  echo "--------------------------------------------------------------"
  echo "  «$1» недоступен для Mac на $(hm_arch_human)."
  echo "  Готовой сборки под эту архитектуру нет, а собрать её прямо на твоём"
  echo "  компьютере установщик не может — для этого нужны компиляторы, которых"
  echo "  на чистом Mac не бывает."
  [ -n "${2:-}" ] && echo "  Что делать: $2"
  echo "  Это НЕ ошибка установки. Остальные компоненты встанут нормально."
  echo "--------------------------------------------------------------"
  # Явный return 0 обязателен: без него результатом функции стал бы код последнего
  # `[ -n "$2" ] && echo` (=1 при пустом $2), и вызов голым statement'ом в скрипте
  # под `set -e` УБИЛ БЫ установку ровно в том месте, где мы объясняем, что всё в
  # порядке. Ровно тот класс тихой поломки, который этот блок и лечит.
  return 0
}

# hm_npm_cache_has_tarball <каталог npm-кеша> <имя пакета без scope>
# Есть ли в офлайн-кеше npm САМ АРХИВ пакета, а не только ответ реестра о нём.
# Разница принципиальная: `npm install` на сборочном раннере кеширует packument
# (метаданные) для ВСЕХ платформенных пакетов, а .tgz качает только под свою.
# Поэтому «имя встречается в кеше» ничего не доказывает — ключ архива в cacache
# всегда содержит "/<имя>/-/<имя>-<версия>.tgz", ключ метаданных — нет.
hm_npm_cache_has_tarball() {
  hm_npm_idx="$1/_cacache/index-v5"
  [ -d "$hm_npm_idx" ] || return 1
  grep -rlF -- "/$2/-/$2-" "$hm_npm_idx" >/dev/null 2>&1
}

# hm_explain_build_failure <файл с выводом> [человеческое имя компонента]
# Опознаёт причину провала по выводу менеджера пакетов и печатает ОДНУ честную
# строку на месте. Возвращает 0, если причина опознана (тогда совет «проверь
# интернет» давать НЕЛЬЗЯ — это была бы ложь), 1 — если нет.
#
# Почему одна строка, а не абзац: развёрнутое «что произошло / что делать»
# печатает главный процесс по хвосту вывода ЛЮБОГО компонента
# (src/failure-explain.js). Дублировать целый абзац здесь — значит показать
# человеку два похожих текста подряд. Здесь нужна ровно правда о причине,
# сказанная сразу после вывода pip, пока он ещё на экране.
hm_explain_build_failure() {
  hm_exp_log="${1:-}"; hm_exp_name="${2:-Компонент}"
  [ -f "$hm_exp_log" ] || return 1
  if grep -qE 'cargo|rustc|PYO3_PYTHON|maturin|setuptools_rust|Cargo\.toml|Rust compiler' "$hm_exp_log" 2>/dev/null; then
    echo "  Причина: $hm_exp_name потянул библиотеку, для которой БОЛЬШЕ НЕ выпускают"
    echo "  готовую версию под Mac на $(hm_arch_human) — её пробовали собрать из исходников"
    echo "  прямо здесь, и это не вышло. Дело НЕ в интернете и не в твоём компьютере."
    return 0
  fi
  if grep -qE 'No matching distribution found|Could not find a version that satisfies' "$hm_exp_log" 2>/dev/null; then
    echo "  Причина: готовой версии одной из библиотек под Mac на $(hm_arch_human) нет"
    echo "  ни в установщике, ни в интернете. Повторять установку бесполезно."
    return 0
  fi
  if grep -qE 'No space left on device|нет свободного места' "$hm_exp_log" 2>/dev/null; then
    echo "  Причина: на диске закончилось место. Освободи 5-10 ГБ и нажми «Повторить»."
    return 0
  fi
  return 1
}

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

# Детерминированный SHA-256 ДЕРЕВА каталога: sha256 от списка "sha256  ./путь"
# всех файлов в стабильном порядке (LC_ALL=C sort по путям). Используется с двух
# сторон ОДНИМ рецептом: build-time (tools/fetch-vendor-mac.sh пишет
# vendor/nomad-src.sha256) и install-time (nomad.sh сверяет fail-closed перед
# `uv tool install`). shasum есть на каждом macOS (/usr/bin/shasum, perl).
# Несуществующий каталог -> хеш пустого ввода -> закономерный mismatch (fail-closed).
hm_tree_sha256() {
  ( cd "$1" 2>/dev/null && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 2>/dev/null ) \
    | shasum -a 256 | awk '{print $1}'
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
