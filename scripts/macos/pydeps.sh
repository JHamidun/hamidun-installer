#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# Пин подписи python.pkg ДО root-запуска installer (fail-closed, THREAT-MODEL round-4):
# /tmp-загрузку мог подменить процесс того же пользователя. Требуем Developer ID
# Installer с ТОЧНЫМ Team ID Python Software Foundation. Подтверждено сетью (2026-07):
# начиная с Python 3.11.4/3.12.0b1 установщики python.org подписаны сертификатами PSF
# c Apple Developer ID BMM5U3QVKW (python.org/downloads + docs.python.org/3/using/mac.html;
# мы ставим 3.12.7 > 3.11.4). Не подтвердится — fail-closed стоп.
PYTHON_TEAM_ID='BMM5U3QVKW'

# Предпочитаем bundled Python 3.12 (под него собраны wheels).
PY312="/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
if [ ! -x "$PY312" ] && [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/python.pkg" ]; then
  echo "Python 3.12 из встроенного pkg (офлайн)..."
  verify_artifact "$HM_VENDOR/apps/python.pkg"  # вшитый артефакт — сверяем SHA-256 (fail-closed)
  # verify + install атомарно под root на staged копии (Codex P1); пин подписи и для
  # вшитого pkg (defense-in-depth поверх SHA-256). Путь и Team ID — позиционные.
  if ! admin_run /bin/sh -c "$HM_PKG_INSTALL_SH" hm_pkg_install "$HM_VENDOR/apps/python.pkg" "$PYTHON_TEAM_ID"; then
    echo "Python: подпись .pkg не подтверждена или установка не удалась (fail-closed)."; exit 1
  fi
fi
if [ -x "$PY312" ]; then PY="$PY312"
else
  # НЕ берём системный шим /usr/bin/python3: без установленных Command Line Tools
  # его запуск дёргает GUI-диалог CLT. Принимаем python3 из PATH ТОЛЬКО если это
  # реальный интерпретатор (Homebrew/framework/…), а не CLT-шим.
  P3="$(command -v python3 2>/dev/null || true)"
  if [ -n "$P3" ] && [ "$P3" != "/usr/bin/python3" ]; then
    PY="$P3"
  else
    echo "Скачиваю Python с python.org..."
    PKG="/tmp/python.pkg"; dl "https://www.python.org/ftp/python/3.12.7/python-3.12.7-macos11.pkg" "$PKG" || exit 1
    # verify + install атомарно под root на staged копии (Codex P1) — окна подмены /tmp
    # между verify и install нет (PSF Team ID, fail-closed) — см. PYTHON_TEAM_ID выше.
    if ! admin_run /bin/sh -c "$HM_PKG_INSTALL_SH" hm_pkg_install "$PKG" "$PYTHON_TEAM_ID"; then
      echo "Python: подпись .pkg не подтверждена или установка не удалась (fail-closed)."; exit 1
    fi
    PY="$PY312"
  fi
fi
[ -x "$PY" ] || { echo "Python не установился — пропускаю зависимости."; exit 1; }

if [ -n "${HM_BUNDLED_CONFIG:-}" ] && [ -f "$HM_BUNDLED_CONFIG/requirements.txt" ]; then
  REQ="$HM_BUNDLED_CONFIG/requirements.txt"
else
  REQ="$HOME/.hamidun-setup/config-repo/requirements.txt"
fi
[ -f "$REQ" ] || { echo "requirements.txt не найден — сначала установите конфиг."; exit 1; }

echo "Использую Python: $PY"

# Вывод pip дублируем в файл, чтобы при провале объяснить причину ЧЕЛОВЕЧЕСКИ.
# Живой случай (Intel Mac, 07.08.2026): pip не нашёл готовое колесо cryptography под
# macOS x86_64 (upstream перестал их выпускать с 49.0.0), полез собирать исходники,
# упёрся в Rust/PyO3 — а скрипт печатал «Проверь сеть и повтори установку». Это ложь
# в обе стороны: сеть была в порядке, повтор не помогал бы никогда.
PIPLOG="$(mktemp "${TMPDIR:-/tmp}/hm-pydeps.XXXXXX" 2>/dev/null || echo '')"
cleanup_piplog() { [ -n "$PIPLOG" ] && rm -f "$PIPLOG" 2>/dev/null; }
trap cleanup_piplog EXIT
pip_run() {  # весь вывод — и в лог установки (человеку видно прогресс), и в файл
  if [ -n "$PIPLOG" ]; then "$@" 2>&1 | tee -a "$PIPLOG"; return "${PIPESTATUS[0]}"; fi
  "$@" 2>&1
}
WH="${HM_VENDOR:-}/pywheels"

# Собирать ли библиотеки из исходников (решение и живой случай — hm_build_policy в
# _lib.sh). На Intel, под Rosetta и без инструментов разработчика — ТОЛЬКО готовые
# сборки: pip сам берёт самую новую версию, у которой готовая сборка под этот Mac есть
# (для cryptography на Intel это 48.x), и компилятор не запускается никогда — ни Rust,
# ни системный cc с его окном «требуются инструменты разработчика». Исключение —
# чистый Python без компилятора (hm_pip_exempt_sdists: заведомо чистые + вшитые архивы,
# прошедшие проверку). На Apple Silicon с инструментами — как раньше, но готовая сборка
# в приоритете: новая версия «только исходниками» не тянет компиляцию, когда рядом есть
# чуть более старая готовая (так бывает на старых macOS).
PYDEPS_POLICY="$(hm_build_policy "$(arch_tag)" "$(hm_rosetta_flag)" "$(hm_clt_flag)")"
PIP_BUILD_OPTS="--prefer-binary"
case "$PYDEPS_POLICY" in
  wheels-only:*)
    hm_build_policy_note "$PYDEPS_POLICY"
    PIP_BUILD_OPTS="--only-binary=:all:"
    # Исключение — только чистый Python: заведомо чистые (pyaes, у которого на PyPI ТОЛЬКО
    # исходники, — зависимость Telethon; нужен и без вшитого набора) плюс вшитые архивы,
    # прошедшие проверку (hm_sdist_is_pure_python). Без этого `--only-binary=:all:` отказывал
    # бы всему набору из-за одного pyaes.
    PIP_SDIST_OK="$(hm_pip_exempt_sdists "$WH")"
    if [ -n "$PIP_SDIST_OK" ]; then PIP_BUILD_OPTS="$PIP_BUILD_OPTS --no-binary=$PIP_SDIST_OK"; fi
    ;;
esac
PIP_PARTIAL=""   # библиотеки без готовой сборки, пока остальные встали (см. pydeps_per_library)

# Доводка рантайма: маркетплейсы плагинов, зависимости dev-browser, интерпретатор для
# MCP. Скрипт лежит в паке, но зовут его только из config.sh — а config идёт РАНЬШЕ нас
# (pydeps needs=["config"]), и Python на тот момент ещё не установлен. Там он честно
# печатал «после установки Python запусти вручную», и на этом всё заканчивалось:
# перезапустить его было некому, и на чистой машине доводка не выполнялась НИ РАЗУ.
# Здесь Python уже есть. Скрипт идемпотентен — повторный вызов безвреден. Нужен он и
# тогда, когда библиотеки поставить нельзя: сам он на чистом Python (только stdlib).
RUNTIME_SCRIPT="$HOME/.claude/scripts/setup_runtime.py"
pydeps_runtime_setup() {
  if [ -f "$RUNTIME_SCRIPT" ]; then
    echo "Довожу рантайм (браузер Playwright, маркетплейсы плагинов, зависимости)..."
    if ! "$PY" "$RUNTIME_SCRIPT"; then
      echo "  ВНИМАНИЕ: часть доводки не прошла. На работу конфига это не влияет —"
      echo "  затронуты только соответствующие навыки. Повторить: python3 \"$RUNTIME_SCRIPT\""
    fi
  else
    echo "  (пропускаю доводку рантайма: $RUNTIME_SCRIPT не найден — конфиг ещё не разложен)"
  fi
}

# Готовых сборок части библиотек под этот Mac нет, а компилировать мы не стали. Это
# осознанный пропуск (120), а не красный провал: повтор установки ничего не изменит,
# Claude Code, конфиг и курс работают и без этих библиотек.
pydeps_skip_no_prebuilt() {
  # Имена: из поштучной установки (все библиотеки по одной), иначе — что назвал сам pip.
  PIP_MISSING="${PIP_MISSING_ALL:-$(hm_pip_missing_names "$PIPLOG")}"
  case "$PYDEPS_POLICY" in
    wheels-only:no-clt) PIP_WHY="без инструментов разработчика (Xcode Command Line Tools) их пришлось бы компилировать, а на этом Mac нечем" ;;
    *) PIP_WHY="на Mac с процессором Intel их пришлось бы компилировать из исходников: на обычном Mac для этого нет инструментов, а попытка только грела бы компьютер" ;;
  esac
  echo "--------------------------------------------------------------"
  echo "  Python-библиотеки для навыков: под этот Mac нет готовых сборок${PIP_MISSING:+ ($PIP_MISSING)}."
  echo "  Установщик их не ставит: $PIP_WHY."
  echo "  Это НЕ ошибка установки и не интернет. Claude Code, конфиг и курс работают;"
  echo "  не заработают только навыки, которым нужны эти Python-библиотеки."
  echo "--------------------------------------------------------------"
  pydeps_runtime_setup
  echo "Python-библиотеки пропущены: под этот Mac нет готовых сборок${PIP_MISSING:+ ($PIP_MISSING)}, а компилировать их здесь установщик не стал."
  exit 120
}

# Поштучная установка. pip решает requirements.txt целиком: одна библиотека без готовой
# сборки под этот Mac (версия выше последней для Intel, пакет, которого там не было вовсе)
# проваливала ВСЕ, и человек видел «пропущено» вместо тридцати пяти рабочих библиотек и
# одной недостающей. Теперь после отказа общего разбора каждая строка ставится отдельно
# (те же правила: только готовые, чистый Python из проверенного списка — можно):
#   • хоть одна поставилась, часть нет → возврат 0, имена в PIP_PARTIAL, в конце скрипта
#     строка «ЧАСТИЧНО:» и код 121 (для потока это успех жёлтого цвета);
#   • не поставилась ни одна → пропуск 120 со всеми именами;
#   • любой провал, который НЕ «нет готовой сборки» (сеть, место, сборка) → возврат 1: это
#     уже не про этот Mac, и объясняет его обычный путь pydeps_fail по логу последней попытки.
pydeps_per_library() {
  local line name ok=0 failed="" kind rc
  echo "  Общий набор не сложился — ставлю библиотеки по одной: что можно поставлю, остальное назову."
  while IFS= read -r line; do
    name="$(hm_requirement_name "$line")"
    [ -n "$name" ] || continue
    if [ -n "$PIPLOG" ]; then : > "$PIPLOG"; fi
    # stdin pip'а — /dev/null: цикл читает requirements из своего stdin, и всё, что pip
    # вздумал бы прочитать, съело бы следующие строки.
    if [ -n "${HM_VENDOR:-}" ] && [ -d "$WH" ]; then
      pip_run "$PY" -m pip install --user --break-system-packages --find-links "$WH" $PIP_BUILD_OPTS "$line" </dev/null
      rc=$?
    else
      pip_run "$PY" -m pip install --user --break-system-packages $PIP_BUILD_OPTS "$line" </dev/null
      rc=$?
    fi
    if [ "$rc" -eq 0 ]; then
      ok=$((ok + 1))
      continue
    fi
    kind="$(hm_pip_failure_kind "$PIPLOG")"
    if [ "$kind" != "no-wheel" ]; then return 1; fi
    failed="${failed:+$failed,}$name"
  done <<EOF_REQ
$(hm_requirement_lines "$REQ")
EOF_REQ
  if [ -z "$failed" ]; then return 0; fi
  if [ "$ok" -eq 0 ]; then
    PIP_MISSING_ALL="$(printf '%s' "$failed" | sed 's/,/, /g')"
    pydeps_skip_no_prebuilt
  fi
  PIP_PARTIAL="$failed"
  echo "  Не поставились (нет готовой сборки под этот Mac): $(printf '%s' "$failed" | sed 's/,/, /g'). Остальные библиотеки поставлены."
  return 0
}

# Единая точка честного отказа: сначала пытаемся объяснить по сигнатурам из лога,
# и только если причина не опознана — говорим про сеть (там это уместно).
pydeps_fail() {
  echo "Часть библиотек не установилась."
  PIP_FAIL_KIND="$(hm_pip_failure_kind "$PIPLOG")"
  case "$PYDEPS_POLICY:$PIP_FAIL_KIND" in
    wheels-only:*:no-wheel)
      # Не «всё или ничего»: сначала пробуем по одной. 0 — дальше (браузеры, рантайм, итог).
      if pydeps_per_library; then return 0; fi
      PIP_FAIL_KIND="$(hm_pip_failure_kind "$PIPLOG")"   # причина — по последней попытке
      ;;
  esac
  if [ "$PIP_FAIL_KIND" = "network" ]; then
    echo "  Причина: нет связи с сервером библиотек (PyPI). Проверь интернет (при необходимости включи VPN) и нажми «Повторить» на этом шаге."
  elif ! hm_explain_build_failure "$PIPLOG" "Python-пакеты"; then
    echo "  Что делать: проверь интернет и нажми «Повторить» на этом шаге."
  fi
  exit 1
}

if [ -n "${HM_VENDOR:-}" ] && [ -d "$WH" ]; then
  echo "Библиотеки из встроенных wheels (офлайн)..."
  # Провал офлайн-ветки (типовой случай — Intel: x86_64-колёса нативных пакетов
  # качаются на сборке best-effort и могли не вшиться) — НЕ жёсткий exit 1, а
  # честный онлайн-фолбэк, как у Chromium-ветки ниже: --find-links оставляем,
  # чтобы вшитые колёса всё равно использовались, сеть докачивает только дыры.
  if ! pip_run "$PY" -m pip install --user --break-system-packages --no-index --find-links "$WH" $PIP_BUILD_OPTS -r "$REQ"; then
    echo "  Встроенных библиотек под Mac на $(hm_arch_human) хватило не на всё — докачиваю недостающее из интернета..."
    "$PY" -m pip install --user --break-system-packages --upgrade pip >/dev/null 2>&1 || true
    # Причину провала судим по ОНЛАЙН-попытке: офлайн-отказ «нет версии» здесь ожидаем
    # и не должен выдать сетевой сбой за «нет готовой сборки».
    if [ -n "$PIPLOG" ]; then : > "$PIPLOG"; fi
    pip_run "$PY" -m pip install --user --break-system-packages --find-links "$WH" $PIP_BUILD_OPTS -r "$REQ" || pydeps_fail
  fi
else
  "$PY" -m pip install --user --break-system-packages --upgrade pip >/dev/null 2>&1 || true
  echo "Библиотеки из PyPI (онлайн)..."
  pip_run "$PY" -m pip install --user --break-system-packages $PIP_BUILD_OPTS -r "$REQ" || pydeps_fail
fi
# Arch-специфичный Chromium: вшит только под arm64 (раннер). На Intel папки
# playwright-browsers-x64 нет → уходим в онлайн-докачку ниже (единственный не-офлайн шаг на x64).
PWB="${HM_VENDOR:-}/playwright-browsers-$(arch_tag)"
if [ -n "${HM_VENDOR:-}" ] && [ -d "$PWB" ]; then
  echo "Встроенные браузеры Playwright (офлайн, $(arch_tag))..."
  mkdir -p "$HOME/Library/Caches/ms-playwright"
  # cp БЕЗ `|| true`: молчаливый сбой копирования раньше давал ложный OK, а потом
  # браузерные скиллы падали без следа. Ловим код возврата и честно фолбэчимся в онлайн.
  if cp -R "$PWB/"* "$HOME/Library/Caches/ms-playwright/" 2>/dev/null; then
    # macOS `cp` тащит xattrs, в т.ч. com.apple.quarantine. Ненотаризованный Chromium
    # с карантином блокируется Gatekeeper → браузер не стартует, а скрипт печатал OK.
    # Снимаем карантин рекурсивно (тот же приём, что в git.sh:51 для вшитого git).
    xattr -dr com.apple.quarantine "$HOME/Library/Caches/ms-playwright" 2>/dev/null || true
    # Вшитый набор может не совпасть с колесом playwright: ревизия Chromium прибита к
    # версии пакета (1.62 требует chromium-1234), плюс fetch-vendor срезает
    # chromium_headless_shell, через который идёт ВЕСЬ headless-рендер. Расхождение
    # раньше вылезало только в рантайме («Executable doesn't exist»).
    # `playwright install` идемпотентен: подходит вшитое — мгновенный no-op без сети.
    if ! "$PY" -m playwright install chromium; then
      PW_WARN=1
      echo "  ВНИМАНИЕ: вшитые браузеры не совпали с версией playwright, а докачать не вышло (проверь сеть и повтори установку этого компонента)."
    fi
  else
    echo "  ВНИМАНИЕ: встроенные браузеры Playwright не скопировались — качаю онлайн..."
    if ! "$PY" -m playwright install chromium; then
      PW_WARN=1
    echo "  ВНИМАНИЕ: браузеры Playwright не скачались (проверь сеть и повтори установку этого компонента). Остальные Python-зависимости на месте."
    fi
  fi
else
  # Онлайн-докачка браузеров (~150 МБ, самый хрупкий по сети шаг). Сбой раньше
  # молча глотался, а скрипт печатал OK — потом браузерные скиллы падали без следа.
  if ! "$PY" -m playwright install chromium; then
    PW_WARN=1
    echo "  ВНИМАНИЕ: браузеры Playwright не скачались (проверь сеть и повтори установку этого компонента). Остальные Python-зависимости на месте."
  fi
fi
# Доводка рантайма (pydeps_runtime_setup выше): маркетплейсы плагинов, зависимости
# dev-browser, интерпретатор для MCP.
pydeps_runtime_setup

# Итог должен соответствовать тому, что произошло. Раньше эта строка печаталась
# БЕЗУСЛОВНО — сразу после «ВНИМАНИЕ: браузеры Playwright не скачались», и установка
# выглядела успешной ровно в тот момент, когда браузерные навыки уже были сломаны.
# На Windows такой лжи не было: там ветка с $pwWarn существует с самого начала.
if [ -n "$PIP_PARTIAL" ]; then
  # Часть библиотек без готовой сборки под этот Mac, остальные стоят: частичный успех
  # (121), одна строка «ЧАСТИЧНО:» последней — её показывает жёлтый шаг. Ровно та строка,
  # что читает main.js; в 240 знаков она укладывается при любом числе имён (hm_names_summary).
  if [ "${PW_WARN:-0}" = "1" ]; then echo "Браузеры Playwright тоже не поставились (повтори установку этого компонента)."; fi
  echo "ЧАСТИЧНО: не поставились: $(hm_names_summary "$PIP_PARTIAL" 100) — нет готовой сборки под этот Mac; навыки с ними не заработают, остальное на месте"
  exit 121
fi
if [ "${PW_WARN:-0}" = "1" ]; then
  echo "Python-зависимости установлены, но браузеры Playwright — нет (повтори установку этого компонента)."
else
  echo "OK: Python-зависимости установлены."
fi
exit 0
