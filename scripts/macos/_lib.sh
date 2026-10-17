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
  # читает префы). Дойдёт ли этот HOME до root-инструментов, утверждать нельзя, поэтому
  # инертность HOME обеспечена не надеждой, а первой строкой каждого HM_*_INSTALL_SH:
  # `HOME=/var/root; export HOME` (находка M-8). Так root-шелл гарантированно стартует из
  # чистого окружения — весь класс env-hijack закрыт в ОДНОЙ точке (фикс-PATH остаётся как
  # defense-in-depth). Диалог пароля рисует SecurityAgent через Mach-порт (наследуется задачей,
  # не env) — env -i его не ломает.
  /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" \
    /usr/bin/osascript -e "do shell script \"$c\" with administrator privileges"
}
# JavaScript для osascript (JXA) БЕЗ прав администратора — второй и последний вызов
# osascript в скриптах (сторожит тест «НЕТ osascript вне _lib.sh»). Скрипт приходит
# ФАЙЛОМ, данные — argv-ом (run(argv) в JS), в текст скрипта ничего не подставляется:
# той интерполяции, от которой защищает admin_run, здесь нет. Прав не поднимает —
# исполняется от того же пользователя, что и сам установочный скрипт.
hm_jxa() { hm_run_with_timeout "${HM_JXA_TIMEOUT:-20}" /usr/bin/osascript -l JavaScript "$@"; }
# Потолок времени у JXA (находка M-10/N2). Скрипт читает и пишет файлы пользователя; всё, что не
# возвращается (settings.json, подменённый каналом FIFO или зависшим сетевым томом), держало бы шаг
# VS Code вечно, а при вызове из touch-up'а — осиротевший osascript после того, как диспетчер убил
# только bash. hm_run_with_timeout (ниже) снимает всё дерево команды; код 124 — не уложился.
# 20 с с запасом перекрывают нормальную работу (доли секунды) и меньше лимита диспетчера (30 с).
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

# Запасная строка PATH в ~/.zprofile: её читает ЛЮБАЯ оболочка входа zsh — даже если
# ~/.zshrc выходит раньше нашей строки, недоступен на запись или падает без терминала.
# Вынесено сюда из claude.sh: её же зовёт always-run touchup-claude-path.sh.
persist_local_bin_zprofile() {
  local zp="$HOME/.zprofile"
  if [ ! -e "$zp" ]; then : > "$zp" 2>/dev/null || return 0; fi
  if ! grep -qF 'HAMIDUN_LOCAL_BIN' "$zp" 2>/dev/null; then
    printf '\n# HAMIDUN_LOCAL_BIN — claude/git в PATH\n%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$zp" 2>/dev/null || true
  fi
  return 0
}

# Файл, который читает оболочка входа человека, — для подсказки «что дописать, если не
# вышло само». Не только zsh: у человека с bash это ~/.bash_profile, и совет про ~/.zprofile
# ему бесполезен.
hm_login_profile_name() {
  case "$(hm_login_shell)" in
    */zsh)  printf '%s' '~/.zprofile' ;;
    */bash) printf '%s' '~/.bash_profile' ;;
    *)      printf '%s' '~/.profile' ;;
  esac
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
# head, rm в trap, grep, find) резолвятся ТОЛЬКО из системных каталогов. Первой строкой
# КАЖДОГО скрипта идёт HOME=/var/root (ниже), второй — PATH=/usr/bin:/bin:/usr/sbin:/sbin.
#
# Это закрывает ROOT-шелл. НЕпривилегированный bash, который эту команду собирает, `env -i` не
# защищает: BASH_ENV/ENV/SHELLOPTS+PS4/BASH_FUNC_* в его окружении выполняются ДО первой строки
# любого скрипта, и `unset BASH_ENV` внутри скрипта уже опоздал бы. Поэтому лекарство — в окружении,
# с которым main.js запускает скрипт (installEnv.sanitizePosixEnv) и в самом запуске (`bash -p`),
# а не здесь (находка M-1).

# HOME в root-шелле (находка M-8). admin_run передаёт osascript HOME пользователя (osascript читает
# префы), а комментарий выше обещает, что root-скрипты от него не зависят, — на деле эта гарантия
# держалась только на том, что они не читают ~/$HOME. Теперь она настоящая: ПЕРВАЯ строка каждого
# HM_*_INSTALL_SH — HOME=/var/root; это присваивание без внешних команд, поэтому порядок с PATH
# не важен, а всё, что запустится ниже (в том числе скрипты postinstall пакета), увидит домашний
# каталог root, а не каталог того, кто может в нём писать.
#
# Тексты ниже — ТОЛЬКО ASCII и без одинарных кавычек: переменная задана в '...', а `do shell script`
# получает строку через AppleScript, где не-ASCII зависит от кодировки. Пояснения — здесь, в комментариях.
#
# HM_PKG_INSTALL_SH — .pkg под root: $1=путь к .pkg, $2=Developer ID Installer Team ID.
#   pkgutil --check-signature на staged pkg: exit-код + статус Apple Developer ID +
#   leaf-серт "1. Developer ID Installer: ... (TeamID)$" (Team ID заякорен в конце CN —
#   подстрока в середине имени не пройдёт). Затем installer РОВНО staged pkg.
HM_PKG_INSTALL_SH='HOME=/var/root; export HOME
PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
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
#   staged-бандл ПЕРЕИМЕНОВЫВАЕТСЯ в /Applications. detach mount ПОСЛЕ этого уже не влияет.
#
#   Назначение (находка M-3). /Applications на macOS — root:admin 0775, обычный ученик состоит в
#   admin, значит ТОТ ЖЕ пользователь, пока открыто окно пароля (оно может висеть сколько угодно),
#   создаёт /Applications/Cursor.app каталогом со ссылками внутри. Прежний `cp -R staged
#   /Applications/$3` не отличал это от пустого места: при существующем каталоге клал копию ВНУТРЬ
#   него, а root писал по ссылкам туда, куда указал не он. Поэтому:
#     • $3 — ровно ОДНО имя *.app из [A-Za-z0-9 ._+()-] (без «/», без ведущей точки, без
#       управляющих символов): проверка идёт ДО создания staging и до любого инструмента;
#     • на месте назначения не должно быть НИЧЕГО (ни файла, ни каталога, ни ссылки, в том числе
#       висячей). Заменять установленное это скрипт не умеет и не должен: вызывающие (cursor.sh,
#       handy.sh) вовсе не доходят сюда, если /Applications/<имя> уже есть, а прежний cp -R поверх
#       существующего каталога давал не обновление, а вложенный «…app/app.app». Занято —
#       fail-closed;
#     • на место встаёт ГОТОВЫЙ проверенный staged-бандл одним переименованием (mv -n: на том же
#       томе это rename(2) — бандл никогда не виден наполовину и ничего не пишется «сквозь» путь);
#       та самая копия, что прошла codesign+spctl, а не вторая копия с mount;
#     • окно между проверкой «пусто» и переименованием сведено к одной команде: проверка
#       повторена прямо перед mv, а после него подтверждено, что на месте назначения именно
#       наш бандл (не ссылка, и staged действительно ушёл туда, а не ВНУТРЬ чужого каталога).
#       Полностью закрыть его нельзя — родитель доступен на запись admin-группе, и любая
#       операция по имени в нём гоняется. Остаток честно назван: если в это окно кто-то успеет
#       поставить на место назначения каталог или ссылку на каталог, mv положит ПОДЛИННЫЙ
#       проверенный бандл внутрь него (под именем app.app), проверка «по назначению лежит бандл»
#       откажет, установка провалится, и ничего чужого не исполнится. Прежний `cp -R` в этой
#       гонке, а главное — при ЗАРАНЕЕ подложенном каталоге, писал по чужим ссылкам.
HM_APP_INSTALL_SH='HOME=/var/root; export HOME
PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
set -e
[ -x /usr/bin/codesign ] || exit 1
[ -x /usr/sbin/spctl ] || exit 1
[ -x /bin/mv ] || exit 1
case "$3" in
  ""|.*|*/*|*[[:cntrl:]]*|*[!A-Za-z0-9._+\ \(\)-]*) exit 1 ;;
  *.[aA][pP][pP]) ;;
  *) exit 1 ;;
esac
dest="/Applications/$3"
[ ! -e "$dest" ] && [ ! -L "$dest" ] || exit 1
d="$(mktemp -d /var/root/hm_app.XXXXXX)" || exit 1
trap "rm -rf \"$d\"" EXIT
/bin/cp -R "$1" "$d/app.app" || exit 1
/usr/bin/codesign --verify --deep --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \"$2\"" "$d/app.app" >/dev/null 2>&1 || exit 1
/usr/sbin/spctl --assess --type execute "$d/app.app" >/dev/null 2>&1 || exit 1
[ ! -e "$dest" ] && [ ! -L "$dest" ] || exit 1
/bin/mv -n "$d/app.app" "$dest" || exit 1
[ ! -e "$d/app.app" ] && [ ! -L "$dest" ] && [ -d "$dest/Contents" ] || exit 1'

# HM_VSCODE_INSTALL_SH — вшитый .zip VS Code под root: $1=путь к .zip, $2=Team ID,
#   $3=ПОЛНЫЙ путь назначения (/Applications/Visual Studio Code.app). cp zip в staging ->
#   ditto распаковка в staging -> codesign -R (Team ID Microsoft) + spctl (нотаризация)
#   распакованного .app -> снять карантин и отдать владельцу ТУТ ЖЕ, на staged -> переименовать
#   на место. Всё над root-owned staging: SHA на вшитом zip НЕ защищает от same-UID подмены
#   (checksums.json тоже same-UID) — гейт = крипто-подпись Microsoft на распакованном бандле.
#   $4 (необязательный) = владелец: .app уже ПРОВЕРЕН и скопирован, отдаём его человеку.
#   Иначе бандл принадлежит root, и самообновление VS Code каждый раз просит пароль
#   или Touch ID для «вспомогательной программы» (A42). Имя проверяется здесь же
#   (только [A-Za-z0-9._-], не root, учётка существует); провал chown установку НЕ валит.
#
#   Назначение (находка M-3) — те же правила, что у HM_APP_INSTALL_SH: $3 обязан быть РОВНО
#   /Applications/<одно имя>.app, на месте не должно быть ничего (ни ссылки, ни каталога, ни
#   файла), на место встаёт готовый проверенный бандл одним переименованием. Плюс: xattr и chown
#   раньше шли по КОНЕЧНОМУ пути (`xattr -dr … "$3"`) уже после копирования — подложенная в
#   последний момент ссылка превращала их в root-действия над чужим деревом. Теперь оба
#   выполняются над staged-копией в root-private каталоге (туда пользователь не попадёт), а по
#   пути в /Applications не делается ничего, кроме проверки и самого rename.
#   Раньше при негодном владельце скрипт выходил `exit 0` в конце; теперь владелец решается ДО
#   переименования, поэтому выхода посередине нет — установка заканчивается переименованием.
HM_VSCODE_INSTALL_SH='HOME=/var/root; export HOME
PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
set -e
[ -x /usr/bin/ditto ] || exit 1
[ -x /usr/bin/find ] || exit 1
[ -x /usr/bin/codesign ] || exit 1
[ -x /usr/sbin/spctl ] || exit 1
[ -x /usr/bin/xattr ] || exit 1
[ -x /bin/mv ] || exit 1
case "$3" in
  /Applications/*) n="${3#/Applications/}" ;;
  *) exit 1 ;;
esac
case "$n" in
  ""|.*|*/*|*[[:cntrl:]]*|*[!A-Za-z0-9._+\ \(\)-]*) exit 1 ;;
  *.[aA][pP][pP]) ;;
  *) exit 1 ;;
esac
[ ! -e "$3" ] && [ ! -L "$3" ] || exit 1
d="$(mktemp -d /var/root/hm_vsc.XXXXXX)" || exit 1
trap "rm -rf \"$d\"" EXIT
/bin/cp "$1" "$d/vscode.zip" || exit 1
/usr/bin/ditto -x -k "$d/vscode.zip" "$d/unz" || exit 1
app="$(/usr/bin/find "$d/unz" -maxdepth 2 -type d -name "*.app" | head -n1)"
[ -n "$app" ] || exit 1
/usr/bin/codesign --verify --deep --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \"$2\"" "$app" >/dev/null 2>&1 || exit 1
/usr/sbin/spctl --assess --type execute "$app" >/dev/null 2>&1 || exit 1
/usr/bin/xattr -dr com.apple.quarantine "$app" || exit 1
own=""
case "$4" in
  ""|root|-*|*[!A-Za-z0-9._-]*) ;;
  *) if /usr/bin/id -u "$4" >/dev/null 2>&1; then own="$4"; fi ;;
esac
if [ -n "$own" ]; then /usr/sbin/chown -R -h "$own":staff "$app" || :; fi
[ ! -e "$3" ] && [ ! -L "$3" ] || exit 1
/bin/mv -n "$app" "$3" || exit 1
[ ! -e "$app" ] && [ ! -L "$3" ] && [ -d "$3/Contents" ] || exit 1'

# ---- Готовые сборки вместо компиляции на машине человека (Intel / Rosetta / нет CLT) ----
# Живой случай 23.09.2026 (Mac на Intel, офлайн-издание): pip не нашёл готовую
# cryptography под x86_64 и пошёл собирать её из исходников — сборщик сам скачал Rust
# (сотни мегабайт, ноутбук грелся минутами) и всё равно упал на линковке. Nomad следом
# потянул библиотеку на CMake, проверка компилятора вызвала /usr/bin/cc — а это заглушка
# macOS, которая без Xcode Command Line Tools показывает окно «Для команды "cc" требуются
# инструменты разработчика». Человек получил красные шаги, горячий компьютер и окно,
# которое советует поставить несколько гигабайт ради ничего.
# Правило: без инструментов разработчика НИЧЕГО не компилируем, а на Intel не компилируем
# вообще — нужного там (Rust, CMake, системные библиотеки) на обычном Mac всё равно нет.

# Запущены ли мы через Rosetta (x86_64-трансляция на Apple Silicon). Тогда uname -m
# отвечает x86_64, и всё, что мы запускаем, тоже идёт как x86_64 — для готовых сборок
# библиотек это ровно тот же случай, что Intel. На Intel и вне macOS ключа нет → 0.
hm_rosetta_flag() {
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then echo 1; else echo 0; fi
  return 0
}

# Есть ли инструменты разработчика (Xcode Command Line Tools или Xcode). Только
# `xcode-select -p` и проверка файла: ни cc, ни clang, ни xcrun НЕ запускаем — запуск
# заглушки и есть то, что показывает системное окно. Путь, который печатает
# xcode-select, мог остаться от удалённых CLT, поэтому компилятор ищем на диске.
hm_clt_flag() {
  hm_clt_dir="$(xcode-select -p 2>/dev/null)" || { echo 0; return 0; }
  if [ -n "$hm_clt_dir" ] && { [ -x "$hm_clt_dir/usr/bin/clang" ] \
       || [ -x "$hm_clt_dir/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang" ]; }; then
    echo 1
  else
    echo 0
  fi
  return 0
}

# Можно ли собирать библиотеки из исходников. Чистая функция — проверяется без Mac.
#   $1 = arch_tag (arm64|x64), $2 = Rosetta (1|0), $3 = инструменты разработчика (1|0).
# Печатает allow-build | wheels-only:rosetta | wheels-only:intel | wheels-only:no-clt.
# allow-build остаётся только у Apple Silicon с инструментами разработчика: там
# компилятор есть, а готовые сборки нужны лишь как предпочтение (--prefer-binary).
hm_build_policy() {
  if [ "${2:-0}" = "1" ]; then echo "wheels-only:rosetta"; return 0; fi
  if [ "${1:-}" != "arm64" ]; then echo "wheels-only:intel"; return 0; fi
  if [ "${3:-0}" != "1" ]; then echo "wheels-only:no-clt"; return 0; fi
  echo "allow-build"
  return 0
}

# Одна строка в журнал: почему ставим только готовые сборки (и что это не поломка).
hm_build_policy_note() {
  case "${1:-}" in
    wheels-only:rosetta)
      echo "  Установщик запущен через Rosetta: библиотеки ставлю только готовыми сборками, как для Intel, без компиляции на этом Mac." ;;
    wheels-only:intel)
      echo "  Mac на Intel: библиотеки ставлю только готовыми сборками. Компилировать их здесь нечем, попытка лишь грела бы компьютер." ;;
    wheels-only:no-clt)
      echo "  На этом Mac нет инструментов разработчика (Xcode Command Line Tools): библиотеки ставлю только готовыми сборками, без компиляции и без системного окна про «cc»." ;;
  esac
  return 0
}

# Признаки сетевого сбоя в выводе pip/uv. Без них «нет готовой сборки» не отличить от
# «нет интернета»: без сети pip тоже пишет «No matching distribution found».
hm_log_has_network_error() {
  [ -f "${1:-}" ] || return 1
  grep -qiE 'NewConnectionError|Failed to establish a new connection|Max retries exceeded|ConnectTimeout|ReadTimeout|timed out|Temporary failure in name resolution|nodename nor servname|Name or service not known|Network is unreachable|Connection (refused|reset)|SSLError|CERTIFICATE_VERIFY_FAILED|ProxyError|error sending request|dns error|failed to lookup address|Could not connect|Failed to fetch' "$1" 2>/dev/null
}

# Вид провала pip по его выводу: build | network | no-wheel | disk | other.
# Порядок важен: компиляция — самое конкретное (в её выводе бывают и сетевые строки
# докачки Rust), сеть — раньше «нет версии» (без сети pip пишет и то и другое).
hm_pip_failure_kind() {
  if [ ! -f "${1:-}" ]; then echo other; return 0; fi
  if grep -qE 'cargo|rustc|PYO3_PYTHON|maturin|setuptools_rust|Cargo\.toml|Rust compiler|Failed building wheel|Failed to build|CMake' "$1" 2>/dev/null; then
    echo build; return 0
  fi
  if hm_log_has_network_error "$1"; then echo network; return 0; fi
  if grep -qE 'No matching distribution found|Could not find a version that satisfies|ResolutionImpossible' "$1" 2>/dev/null; then
    echo no-wheel; return 0
  fi
  if grep -qE 'No space left on device' "$1" 2>/dev/null; then echo disk; return 0; fi
  echo other
  return 0
}

# Имена библиотек, для которых pip не нашёл подходящей версии, — через запятую.
hm_pip_missing_names() {
  [ -f "${1:-}" ] || return 0
  sed -n 's/.*No matching distribution found for \([A-Za-z0-9._-]*\).*/\1/p' "$1" 2>/dev/null \
    | awk 'NF && !seen[$0]++' | tr '\n' ',' | sed -e 's/,$//' -e 's/,/, /g'
  return 0
}

# --- Чистый Python или нет: исключение из «только готовых» держится на проверке, а не на вере.
# Режим «только готовые» обязан пропустить чистый Python без компилятора (pyaes — зависимость
# Telethon, у PyPI только исходники), иначе он отказал бы всем библиотекам разом из-за одной.
# Исходник попадает во вшитый набор не только как чистый Python: `pip download` берёт
# исходники и для скомпилированной библиотеки, у которой НОВЕЙШИЙ выпуск не имеет колеса
# под раннер. Пустить такой архив в обход запрета значило бы собирать его на Mac человека
# (Rust, системный cc с окном про инструменты разработчика) — то самое, от чего защищаемся.
# Поэтому исключаются: (а) имена из списка заведомо чистых, у которых на PyPI ТОЛЬКО
# исходники (pyaes — зависимость Telethon), хоть вшит набор, хоть нет; (б) архивы из набора,
# в которых нет ни исходников на компилируемых языках, ни расширений в сборочных файлах.
HM_PURE_SDIST_ALLOW="pyaes"

# Имя дистрибутива по имени файла исходников: pyaes-1.6.1.tar.gz -> pyaes.
hm_sdist_dist_name() {
  local n
  n="$(basename "$1")"
  n="${n%.tar.gz}"; n="${n%.tgz}"; n="${n%.zip}"
  n="${n%-*}"
  case "$n" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  printf '%s' "$n"
}

# Файлы архива, по одному в строке, и один файл архива на stdout. Только tar и unzip —
# оба есть на чистом маке (python3 там — заглушка с системным окном). Архив tar отдаётся
# через stdin (`-f -`): путь с «C:/…» GNU tar принимает за «хост:файл» (тестовые прогоны
# на Windows), а перенаправление его не касается.
hm_archive_list() {
  case "$1" in
    *.tar.gz|*.tgz) tar -tzf - < "$1" 2>/dev/null ;;
    *.zip)          unzip -Z1 "$1" 2>/dev/null ;;
    *)              return 1 ;;
  esac
}
hm_archive_cat() {
  case "$1" in
    *.tar.gz|*.tgz) tar -xOzf - "$2" < "$1" 2>/dev/null ;;
    *.zip)          unzip -p "$1" "$2" 2>/dev/null ;;
    *)              return 1 ;;
  esac
}

# Архив исходников — чистый Python? Решение консервативное: сомнение = «нет».
hm_sdist_is_pure_python() {
  local f="$1" list m content
  list="$(hm_archive_list "$f")" || return 1
  [ -n "$list" ] || return 1
  # 1) исходники на компилируемых языках и описания их сборки
  if printf '%s\n' "$list" | grep -qiE '\.(c|cc|cpp|cxx|h|hpp|pyx|pxd|rs|cu|f90)$|(^|/)(Cargo\.toml|Cargo\.lock|CMakeLists\.txt|meson\.build|build\.rs)$'; then return 1; fi
  # 2) сборочные файлы верхнего уровня: расширения и бэкенды на компилируемом коде
  for m in $(printf '%s\n' "$list" | grep -E '^[^/]+/(setup\.py|setup\.cfg|pyproject\.toml)$'); do
    content="$(hm_archive_cat "$f" "$m")"
    if printf '%s' "$content" | grep -qiE 'ext_modules|Extension\(|cythonize|build_ext|setuptools[-_]rust|RustExtension|cffi_modules|maturin|scikit-build|meson|pybind11|cmake|pyo3'; then return 1; fi
  done
  # 3) и это вообще исходники Python
  printf '%s\n' "$list" | grep -qE '\.py$'
}

# Имена, которым можно ставиться из исходников в режиме «только готовые», — через запятую:
# список заведомо чистых + вшитые архивы, прошедшие проверку выше.
hm_pip_exempt_sdists() {
  local out="$HM_PURE_SDIST_ALLOW" f n
  for f in "${1:-}"/*.tar.gz "${1:-}"/*.tgz "${1:-}"/*.zip; do
    [ -f "$f" ] || continue
    n="$(hm_sdist_dist_name "$f")" || continue
    case ",$out," in *",$n,"*) continue ;; esac
    if hm_sdist_is_pure_python "$f"; then out="$out,$n"; fi
  done
  printf '%s' "$out"
  return 0
}

# --- requirements.txt по строкам: чтобы поставить библиотеки по одной, когда общий разбор
# pip отказал. Строки без комментариев, пустых и строк-опций (-r, -c, --index-url…).
hm_requirement_lines() {
  tr -d '\r' < "$1" 2>/dev/null \
    | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | awk 'NF && substr($0, 1, 1) != "-"'
}
# Имя библиотеки из строки требования: requests>=2.31 ; python_version>"3.8" -> requests.
hm_requirement_name() {
  printf '%s\n' "$1" | sed -E -e 's/[[:space:]]*;.*$//' -e 's/\[[^]]*\]//' -e 's/[[:space:]]*(@|[<>=!~]).*$//' -e 's/[[:space:]].*$//'
}
# «a, b, c» из списка через запятую, но не длиннее $2 символов; хвост — «и ещё N».
# Строка «ЧАСТИЧНО:» обязана уложиться в 240 знаков, а имён бывает несколько десятков.
hm_names_summary() {
  local list="${1:-}" max="${2:-110}" out="" n=0 total next name
  total="$(printf '%s' "$list" | tr ',' '\n' | awk 'NF' | wc -l | tr -d ' ')"
  for name in $(printf '%s' "$list" | tr ',' ' '); do
    next="${out:+$out, }$name"
    if [ "${#next}" -gt "$max" ]; then break; fi
    out="$next"; n=$((n + 1))
  done
  if [ "$n" -lt "$total" ]; then out="${out:+$out }и ещё $((total - n))"; fi
  printf '%s' "$out"
  return 0
}

# Провал uv в режиме «только готовые сборки» = под этот Mac готовой версии нет (а не сеть).
hm_uv_no_wheel() {
  [ -f "${1:-}" ] || return 1
  grep -qE "has no usable wheels|no wheels with a matching|building from source is disabled|doesn.t have a source distribution or wheel" "$1" 2>/dev/null || return 1
  ! hm_log_has_network_error "$1"
}

# ---- Офлайн-кеш Claude Code: ставим ровно ту версию, что в нём ЕСТЬ целиком ----
# Живой случай 23.09.2026 (Mac на Intel, офлайн-издание): в кеше лежали архивы 2.1.197,
# а метаданные реестра там же указывали на 2.1.278 как на latest. `npm install --offline`
# без версии берёт latest, архива не находит — ENOTCACHED — и установка уходила в
# интернет. Проверка «архив под эту арх есть» проходила: он был, только другой версии.

# Версии АРХИВОВ пакета в кеше, по одной в строке, по возрастанию.
# $1 = каталог npm-кеша, $2 = имя пакета без scope (claude-code, claude-code-darwin-x64).
hm_npm_cache_tarball_versions() {
  [ -d "$1/_cacache/index-v5" ] || return 0
  grep -rhoE -- "/$2/-/$2-[0-9][0-9A-Za-z.+-]*\.tgz" "$1/_cacache/index-v5" 2>/dev/null \
    | sed -e "s|.*/$2-||" -e 's|\.tgz$||' | sort -u | sort -t. -k1,1n -k2,2n -k3,3n
  return 0
}

# Самая новая версия, для которой в кеше лежат ОБА архива: основной пакет и платформенный
# claude-code-darwin-<арх> той же версии. Пусто — офлайн на этой арх не поставить.
hm_claude_offline_version() {
  hm_cov_best=""
  hm_cov_plat="$(hm_npm_cache_tarball_versions "$1" "claude-code-darwin-$2")"
  for hm_cov_v in $(hm_npm_cache_tarball_versions "$1" "claude-code"); do
    if printf '%s\n' "$hm_cov_plat" | grep -qxF -- "$hm_cov_v"; then hm_cov_best="$hm_cov_v"; fi
  done
  printf '%s' "$hm_cov_best"
  return 0
}

# ---- Сторож времени для сетевых шагов ----
# hm_run_with_timeout <секунды> <команда> [аргументы…]
# Код возврата — код команды; 124 — оборвано по времени (как у GNU timeout, которого на
# маке нет). Безопасно и под `set -e`.
#
# Команда остаётся В ГРУППЕ ПРОЦЕССОВ СКРИПТА — никакого `set -m`. Главный процесс
# запускает каждый скрипт отдельной группой (spawn detached) и при закрытии окна
# убивает её одним SIGKILL по отрицательному pid (src/main.js, killChildren). Команда в
# собственной группе (так было в первой редакции) этот удар переживала: `curl | bash`
# или `npm install -g` жили дальше как невидимые сироты без потолка по времени, а
# повторный запуск шага ставил второй экземпляр поверх первого. Пока команда в группе
# скрипта, тот же SIGKILL снимает и её, и всё её дерево.
#
# По таймауту (и по TERM/INT/HUP, которые получил сам скрипт) обрывается ДЕРЕВО команды:
# у `curl … | bash` есть дети (скрипт установки и его curl), и убитый родитель оставил
# бы их качать. Группу целиком убивать нельзя — в ней сам скрипт, поэтому дерево
# обходится по родителям (hm_descendants).
# Все потомки процесса (дети, внуки…), по одному pid в строке. На macOS это pgrep -P
# (/usr/bin/pgrep, миллисекунды на уровень). Запасной путь — один снимок `ps -ef` и
# замыкание по родителям в awk: PID и PPID стоят во 2-й и 3-й колонках и на macOS, и в
# Git Bash, где `ps -ef` дорог (сотни процессов) и звать его на каждом уровне нельзя.
hm_descendants() {
  local k
  if command -v pgrep >/dev/null 2>&1; then
    for k in $(pgrep -P "$1" 2>/dev/null); do
      printf '%s\n' "$k"
      hm_descendants "$k"
    done
  else
    ps -ef 2>/dev/null | awk -v root="$1" '
      NR > 1 { pid[NR] = $2; par[NR] = $3; n = NR }
      END {
        want[root] = 1
        changed = 1
        while (changed) {
          changed = 0
          for (i = 2; i <= n; i++)
            if ((par[i] in want) && !(pid[i] in want)) { want[pid[i]] = 1; changed = 1; print pid[i] }
        }
      }'
  fi
  return 0
}

# TERM процессу и всем его потомкам, через 2 с — KILL тем, кто ещё жив. Список берётся
# ДО первого сигнала: убитый родитель отдаёт детей init'у, и по родителю их уже не найти.
hm_terminate_tree() {
  local list p
  list="$1 $(hm_descendants "$1" | tr '\n' ' ')"
  for p in $list; do kill -TERM "$p" 2>/dev/null; done
  sleep 2
  list="$list $(hm_descendants "$1" | tr '\n' ' ')"
  for p in $list; do kill -KILL "$p" 2>/dev/null; done
  return 0
}

# Обработчик TERM/INT/HUP, пришедших самому скрипту: снять дерево команды и сторожа и
# выйти с кодом 128+сигнал. SIGKILL перехватить нельзя — его покрывает группа (см. выше).
hm_to_abort() {
  trap - TERM INT HUP
  if [ -n "${hm_to_wd:-}" ]; then kill "$hm_to_wd" 2>/dev/null; fi
  if [ -n "${hm_to_pid:-}" ]; then hm_terminate_tree "$hm_to_pid"; fi
  exit "$1"
}

hm_run_with_timeout() {
  hm_to_secs="$1"; shift
  hm_to_start=$SECONDS
  hm_to_pid=""; hm_to_wd=""
  trap 'hm_to_abort 143' TERM
  trap 'hm_to_abort 130' INT
  trap 'hm_to_abort 129' HUP
  "$@" &
  hm_to_pid=$!
  ( while [ $((SECONDS - hm_to_start)) -lt "$hm_to_secs" ]; do
      sleep 1
      kill -0 "$hm_to_pid" 2>/dev/null || exit 0
    done
    hm_terminate_tree "$hm_to_pid"
    exit 0 ) &
  hm_to_wd=$!
  hm_to_rc=0
  wait "$hm_to_pid" || hm_to_rc=$?
  # Сторожа не ждём: по таймауту он в середине hm_terminate_tree (там sleep 2), и ожидание
  # его завершения растягивало бы возврат на секунды. disown — чтобы bash не печатал
  # «Terminated» про убитую задачу.
  kill "$hm_to_wd" 2>/dev/null || true
  disown "$hm_to_wd" 2>/dev/null || true
  trap - TERM INT HUP
  if [ "$hm_to_rc" -ge 128 ] && [ $((SECONDS - hm_to_start)) -ge "$hm_to_secs" ]; then return 124; fi
  return "$hm_to_rc"
}

# ---- «Новое окно Терминала» — проверка тем же путём, каким пойдёт человек ----
# Оболочка входа человека (её запускает Терминал): из учётки, иначе $SHELL, иначе zsh.
hm_login_shell() {
  hm_ls_s="$(dscl . -read "/Users/$(id -un 2>/dev/null)" UserShell 2>/dev/null | awk '{print $2}')"
  if [ -z "$hm_ls_s" ] || [ ! -x "$hm_ls_s" ]; then hm_ls_s="${SHELL:-}"; fi
  if [ -z "$hm_ls_s" ] || [ ! -x "$hm_ls_s" ]; then hm_ls_s=/bin/zsh; fi
  printf '%s\n' "$hm_ls_s"
}

# hm_fresh_shell_run <i|n> <команда>
# Выполняет команду так, как её выполнит НОВОЕ окно: окружение чистое (как у программ
# из Dock — PATH только системный), оболочка входа человека и его rc-файлы.
# Наследовать окружение установщика нельзя: в нём ~/.local/bin уже стоит в PATH, и
# «claude находится» прошло бы даже там, где новое окно отвечает command not found.
#   i — как Терминал (zsh: вход + интерактивная, читает ~/.zprofile И ~/.zshrc);
#   n — вход без интерактива (zsh читает ~/.zprofile, но не ~/.zshrc).
# Код: код команды; 2 — оболочка не zsh/bash (проверять не умеем); 124 — не ответила
# за HM_FRESH_SHELL_TIMEOUT секунд (по умолчанию 30; тесты ставят меньше).
hm_fresh_shell_run() {
  hm_fs_sh="$(hm_login_shell)"
  case "$hm_fs_sh" in
    */zsh) if [ "$1" = "i" ]; then hm_fs_mode="-i -l -c"; else hm_fs_mode="-l -c"; fi ;;
    */bash) hm_fs_mode="-l -c" ;;
    *) return 2 ;;
  esac
  hm_run_with_timeout "${HM_FRESH_SHELL_TIMEOUT:-30}" /usr/bin/env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" \
    SHELL="$hm_fs_sh" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" TERM=dumb \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin "$hm_fs_sh" $hm_fs_mode "$2" </dev/null
}

# ---- Владелец приложения в /Applications ----
# Годится ли строка в имя учётки, которой можно отдать приложение.
hm_valid_login() {
  case "${1:-}" in ''|root|loginwindow|_mbsetupuser|-*|*[!A-Za-z0-9._-]*) return 1 ;; esac
  return 0
}

# Кому отдать установленное приложение: человеку за экраном (владелец /dev/console),
# а если там root или экран входа — тому, кто запустил установщик.
hm_console_user() {
  hm_cu="$(stat -f %Su /dev/console 2>/dev/null || true)"
  if ! hm_valid_login "$hm_cu"; then hm_cu="$(id -un 2>/dev/null || true)"; fi
  hm_valid_login "$hm_cu" || return 1
  printf '%s\n' "$hm_cu"
}

# ---- Always-run правки: контракт touchup-*.sh ----
# Установленные компоненты при повторном запуске установщика снимаются с выбора, и починка,
# добавленная в скрипт компонента позже, не доходит до тех, кто уже ставил. Поэтому такие
# починки вынесены в отдельные скрипты scripts/macos/touchup-*.sh, которые чек-лист
# (verify.sh) гоняет на КАЖДОМ запуске. Контракт каждого:
#   • автономен (сам подключает _lib.sh), идемпотентен, укладывается в 5 секунд, не ходит
#     в сеть и НИКОГДА не завершается ненулевым кодом;
#   • не смог — одна строка «[touchup-<имя>] пропущено: <причина>»;
#   • что-то изменил — одна строка «ОБНОВЛЕНО: …»; ничего не изменил — молчит.
# Вызывать hm_touchup_begin <имя> первой строкой после подключения _lib.sh, а на нормальном
# выходе — hm_touchup_end. Любой неожиданный выход (set -u, упавшая команда) перехватит
# ловушка на EXIT: строка «пропущено» и код 0.
hm_touchup_begin() {
  HM_TOUCHUP_NAME="$1"; HM_TOUCHUP_DONE=0
  trap 'hm_touchup_exit' EXIT
}
hm_touchup_exit() {
  if [ "${HM_TOUCHUP_DONE:-0}" != "1" ]; then
    echo "[touchup-${HM_TOUCHUP_NAME:-?}] пропущено: непредвиденная ошибка скрипта"
  fi
  exit 0
}
hm_touchup_skip() { echo "[touchup-${HM_TOUCHUP_NAME:-?}] пропущено: $1"; }
hm_touchup_end() { HM_TOUCHUP_DONE=1; exit 0; }

# ---- VS Code в /Applications принадлежит root ----
# Прежние сборки ставили его под root (cp внутри admin_run), и каждое самообновление VS Code
# просило пароль или Touch ID для «вспомогательной программы». Чинить без спроса нельзя —
# это ещё одно окно с паролем, — поэтому только честная строка и точная команда.
hm_app_is_root_owned() {
  [ -d "$1" ] && [ "$(stat -f %Su "$1" 2>/dev/null || true)" = "root" ]
}
hm_vscode_owner_hint() {
  printf '%s' "ВНИМАНИЕ: VS Code принадлежит root — при самообновлении macOS будет спрашивать пароль администратора. Исправить в Терминале (спросит твой пароль): sudo chown -R -h \"\$(whoami)\":staff \"$1\""
}
