#!/usr/bin/env bash
# Hamidun uninstaller — macOS.
#
# P0-4 (ownership receipt): удаляет ТОЛЬКО точные абсолютные пути из квитанции
# установки (~/.hamidun-setup/receipts/<id>.json), которые main.js передаёт через
# HM_UNINSTALL_* (newline-joined). НИКАКИХ масок/glob. Нет квитанции → ОТКАЗ
# (мы это не ставили). Mac-приложения удаляются по точному пути бандла + проверке
# идентичности CFBundleIdentifier — НИКОГДА не по маске *.app.
#
# P0-5 (path-guard): цель канонизируется РЕАЛЬНЫМ путём ФС (perl Cwd::abs_path —
# realpath-эквивалент, есть на любой macOS); двойные слэши схлопываются ДО сравнения;
# если ЛЮБОЙ предок цели — симлинк, ИЛИ сама цель — симлинк → отказ. Защищённый
# набор (~/.claude целиком, credentials, memory, projects, todos…) сверяется и с
# лексическим, и с РАЗРЕШЁННЫМ реальным путём.
#
# P1-7: сбои агрегируются — частичное/неподдерживаемое удаление даёт ненулевой код.
# Точный инвентарь: LaunchAgents (unload+plist), строки shell-профиля моста (по
# маркеру), uv-tool Nomad. Запись манифеста чистит main.js ПОСЛЕ пост-детекции.
set -uo pipefail
DRY=0
[ -n "${HM_DRY_RUN:-}" ] && DRY=1

CLAUDE_HOME="$HOME/.claude"
# Защищённые ПОДДЕРЕВЬЯ: их самих, всё ВНУТРИ них и их ПРЕДКОВ удалять нельзя.
PROTECTED_SUBTREES="
$CLAUDE_HOME
$CLAUDE_HOME/skills
$CLAUDE_HOME/memory
$CLAUDE_HOME/projects
$CLAUDE_HOME/todos
$CLAUDE_HOME/shell-snapshots
$CLAUDE_HOME/.credentials.master.env
$CLAUDE_HOME/.credentials.json
$CLAUDE_HOME/settings.json
"

# Схлопнуть повторные слэши ($HOME//.claude → $HOME/.claude) и убрать хвостовой.
hm_squeeze() { printf '%s' "$1" | sed 's#//*#/#g; s#\(.\)/$#\1#'; }

# РЕАЛЬНЫЙ путь ФС (все симлинки разрешены). perl Cwd::abs_path есть на любой macOS.
# Пусто при сбое → вызывающий обязан отказать (fail-closed).
hm_realpath() {
  /usr/bin/perl -MCwd=abs_path -e 'my $p = abs_path($ARGV[0]); print $p if defined $p;' "$1" 2>/dev/null ||
    command realpath "$1" 2>/dev/null || true
}

# 0 (true) → в цепочке ПРЕДКОВ есть симлинк (перенаправленный путь — отказ).
hm_ancestor_symlink() {
  local d prev
  d="$(dirname "$1")"
  prev=""
  while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "." ] && [ "$d" != "$prev" ]; do
    [ -L "$d" ] && return 0
    prev="$d"
    d="$(dirname "$d")"
  done
  return 1
}

# Сравнение одного пути с защищённым набором. 0 (true) → защищён.
hm_in_protected() {
  local target="$1" home p pf pr
  home="$(hm_squeeze "$HOME")"
  [ "$target" = "$home" ] && return 0                 # сам домашний каталог
  case "$home" in "$target"/*) return 0 ;; esac       # предок дома (/Users)
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    pf="$(hm_squeeze "$p")"
    [ "$target" = "$pf" ] && return 0                 # сам защищённый путь
    case "$target" in "$pf"/*) return 0 ;; esac       # внутри защищённого
    case "$pf" in "$target"/*) return 0 ;; esac       # предок защищённого
    # и то же — против РАЗРЕШЁННОГО реального пути защищённого корня
    pr="$(hm_realpath "$pf")"
    if [ -n "$pr" ] && [ "$pr" != "$pf" ]; then
      [ "$target" = "$pr" ] && return 0
      case "$target" in "$pr"/*) return 0 ;; esac
      case "$pr" in "$target"/*) return 0 ;; esac
    fi
  done <<EOF
$PROTECTED_SUBTREES
EOF
  return 1
}

# 0 (true) → удалять НЕЛЬЗЯ. P0-5: нормализация // ДО сравнения, реджект симлинка
# в цели/предках, канонизация РЕАЛЬНЫМ путём, сверка защищённого набора с обоими видами.
hm_protected() {
  local target real
  target="$(hm_squeeze "$1")"
  [ -z "$target" ] && return 0
  [ "$target" = "/" ] && return 0
  # Не абсолютный → отказ (drive-форма X:/ допускается для смоук-прогонов вне macOS).
  case "$target" in /*|[A-Za-z]:/*) : ;; *) return 0 ;; esac
  # Не-канонические пути ("./", "../") не резолвим — fail-closed: отказ удалять.
  case "/$target/" in */../*|*/./*) return 0 ;; esac
  # Симлинк в цепочке предков = перенаправленный путь → отказ (fail-closed).
  if hm_ancestor_symlink "$target"; then return 0; fi
  # Сама цель — симлинк → отказ (мы создавали реальные файлы/каталоги, не ссылки).
  [ -L "$target" ] && return 0
  # Лексическая сверка.
  if hm_in_protected "$target"; then return 0; fi
  # Канонизация РЕАЛЬНЫМ путём ФС (существующая цель обязана резолвиться).
  # Перенаправление через симлинки уже отсечено выше (предки + сама цель);
  # здесь РАЗРЕШЁННЫЙ путь дополнительно сверяется с защищённым набором
  # (сравнение идёт realpath-против-realpath — формы путей совпадают).
  if [ -e "$target" ]; then
    real="$(hm_realpath "$target")"
    [ -z "$real" ] && return 0                        # не смогли канонизировать → отказ
    real="$(hm_squeeze "$real")"
    if hm_in_protected "$real"; then return 0; fi
  fi
  return 1
}

FAILED=0

# Возврат: 0 = удалено/нечего удалять; 1 = отказ guard-а или сбой удаления.
hm_remove() {
  local path="$1" label="$2"
  [ -z "$path" ] && return 0
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then echo "  $label: нечего удалять ($path)"; return 0; fi
  if hm_protected "$path"; then
    echo "  ЗАЩИТА: отказываюсь удалять «$path» (пользовательские данные / подозрительный путь) — пропускаю."
    return 1
  fi
  if [ "$DRY" -eq 1 ]; then echo "  [dry-run] WOULD remove: $path"; return 0; fi
  if rm -rf "$path" 2>/dev/null && [ ! -e "$path" ]; then
    echo "  Удалено ($label): $path"; return 0
  fi
  echo "  Не удалось удалить $path"; return 1
}

ID="$(printf '%s' "${HM_UNINSTALL:-}" | tr -d '[:space:]')"
[ -z "$ID" ] && { echo "HM_UNINSTALL не задан — нечего удалять."; exit 1; }
echo "Деинсталляция компонента: $ID"

# === P0-4: без квитанции НЕ удаляем (defense-in-depth: main уже проверил receipt) ===
if [ -z "${HM_UNINSTALL_PATHS:-}" ] && [ -z "${HM_UNINSTALL_LAUNCHAGENTS:-}" ] && \
   [ -z "${HM_UNINSTALL_PROFILELINES:-}" ]; then
  echo "ОТКАЗ: нет квитанции установки (receipt) для «$ID» — этот установщик его не ставил"
  echo "  (или квитанция утеряна). Ничего не удаляю (fail-closed). Удали вручную, если уверен."
  exit 3
fi

# CFBundleIdentifier бандла (пусто при сбое → отказ удалять .app).
hm_bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null ||
    defaults read "$1/Contents/Info" CFBundleIdentifier 2>/dev/null || true
}

# --- 1) LaunchAgents из квитанции: unload по label + удалить plist по точному пути ---
if [ -n "${HM_UNINSTALL_LAUNCHAGENTS:-}" ]; then
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    la_label="${entry%%|*}"
    la_plist="${entry#*|}"
    if [ "$DRY" -eq 1 ]; then
      echo "  [dry-run] WOULD: launchctl unload $la_plist + удалить plist"
    else
      launchctl unload "$la_plist" 2>/dev/null || true
      launchctl remove "$la_label" 2>/dev/null || true
    fi
    hm_remove "$la_plist" "автозапуск ($la_label)" || FAILED=1
  done <<EOF
${HM_UNINSTALL_LAUNCHAGENTS}
EOF
fi

# --- 2) Точные пути из квитанции. Для .app — ТОЛЬКО с проверкой идентичности ---
if [ -n "${HM_UNINSTALL_PATHS:-}" ]; then
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$p" in
      *.app)
        # Идентичность бандла ОБЯЗАТЕЛЬНА: без записанного CFBundleIdentifier или
        # при несовпадении — отказ (на месте могла оказаться ЧУЖАЯ программа).
        if [ ! -e "$p" ]; then echo "  приложение: нечего удалять ($p)"; continue; fi
        if [ -z "${HM_UNINSTALL_BUNDLEID:-}" ]; then
          echo "  ЗАЩИТА: в квитанции нет CFBundleIdentifier для «$p» — отказ удалять .app (fail-closed)."
          FAILED=1; continue
        fi
        actual_bid="$(hm_bundle_id "$p")"
        if [ -z "$actual_bid" ] || [ "$actual_bid" != "$HM_UNINSTALL_BUNDLEID" ]; then
          echo "  ЗАЩИТА: CFBundleIdentifier «${actual_bid:-нет}» не совпал с квитанцией «$HM_UNINSTALL_BUNDLEID» — это НЕ наш бандл, отказ удалять $p."
          FAILED=1; continue
        fi
        hm_remove "$p" "приложение ($actual_bid)" || FAILED=1
        ;;
      *)
        hm_remove "$p" "артефакт ($ID)" || FAILED=1
        ;;
    esac
  done <<EOF
${HM_UNINSTALL_PATHS}
EOF
fi

# --- 3) Строки shell-профиля из квитанции ('<rc>|<маркер>'): убрать ТОЧНО наши строки ---
if [ -n "${HM_UNINSTALL_PROFILELINES:-}" ]; then
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    rc_file="${entry%%|*}"
    marker="${entry#*|}"
    [ -f "$rc_file" ] || continue
    grep -qF "$marker" "$rc_file" 2>/dev/null || continue
    if [ "$DRY" -eq 1 ]; then echo "  [dry-run] WOULD: убрать строки с маркером «$marker» из $rc_file"; continue; fi
    tmp_rc="$(mktemp "${rc_file}.hm-XXXXXX" 2>/dev/null)" || { echo "  Не удалось создать temp для $rc_file"; FAILED=1; continue; }
    if grep -vF "$marker" "$rc_file" > "$tmp_rc" 2>/dev/null; then
      if cat "$tmp_rc" > "$rc_file" 2>/dev/null; then
        echo "  Строка моста убрана из $rc_file"
      else
        echo "  Не удалось обновить $rc_file"; FAILED=1
      fi
    else
      echo "  Не удалось отфильтровать $rc_file"; FAILED=1
    fi
    rm -f "$tmp_rc" 2>/dev/null
  done <<EOF
${HM_UNINSTALL_PROFILELINES}
EOF
fi

# --- 4) Компонент-специфичный инвентарь: Nomad = uv tool uninstall (среда uv) ---
if [ "$ID" = "nomad" ]; then
  UV_BIN="$HOME/.local/bin/uv"
  [ -x "$UV_BIN" ] || UV_BIN="$(command -v uv 2>/dev/null || true)"
  if [ -n "$UV_BIN" ] && [ -x "$UV_BIN" ]; then
    if [ "$DRY" -eq 1 ]; then echo "  [dry-run] WOULD: $UV_BIN tool uninstall nomad"
    else "$UV_BIN" tool uninstall nomad 2>/dev/null && echo "  uv tool uninstall nomad — выполнено." || true
    fi
  fi
  echo "Примечание: uv и Python НЕ удаляю (могут быть нужны другим инструментам)."
fi
case "$ID" in
  course) echo "Примечание: наставник курса в ~/.claude и твои данные НЕ тронуты." ;;
  mascot) echo "Примечание: хуки в ~/.claude/settings.json НЕ трогаю (там могут быть твои правки)." ;;
esac

if [ "$FAILED" -ne 0 ]; then
  echo "Деинсталляция «$ID» завершена ЧАСТИЧНО — часть артефактов не удалена (см. выше)."
  exit 1
fi
exit 0
