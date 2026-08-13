#!/usr/bin/env bash
# VS Code (рекомендуемый редактор) + расширения Claude Code и Codex — macOS.
# Аналог scripts/windows/vscode.ps1. Ставит VS Code из вшитого vendor/apps/vscode.zip
# (офлайн) в /Applications, снимает карантин, затем ставит ОБА расширения в VS Code.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

DRY="${HM_DRY_RUN:-}"
# P1: VS Code может стоять в /Applications (обычная установка) ИЛИ ~/Applications
# (user-install без прав администратора). detectComponents (main.js) поддерживает оба —
# поэтому детектим ОБА и здесь: иначе при user-install мы ошибочно вернули бы 120 и не
# доставили расширения, а при vendor — поставили бы ВТОРУЮ копию в /Applications.
APP_SYS="/Applications/Visual Studio Code.app"
APP_USER="$HOME/Applications/Visual Studio Code.app"
if   [ -d "$APP_SYS" ];  then APP="$APP_SYS"
elif [ -d "$APP_USER" ]; then APP="$APP_USER"
else APP="$APP_SYS"; fi   # ни одного нет -> цель установки по умолчанию /Applications
CODE_CLI="$APP/Contents/Resources/app/bin/code"

echo "Проверяю VS Code..."
if [ -d "$APP" ]; then
  echo "VS Code уже установлен — доставлю только расширения."
else
  ZIP="${HM_VENDOR:-}/apps/vscode.zip"
  if [ -z "${HM_VENDOR:-}" ] || [ ! -f "$ZIP" ]; then
    # Офлайн-архив не вшит И VS Code не установлен — как скрепка (mascot): грациозный
    # пропуск (exit 120). Всё остальное работает; VS Code можно поставить позже.
    echo "VS Code не вошёл в эту сборку и не установлен — пропускаю. Остальное работает без него (поставь VS Code позже с code.visualstudio.com)."
    exit 120
  fi
  if [ -n "$DRY" ]; then
    echo "  [dry-run] WOULD: под ОДНИМ admin_run (root): staging /var/root, cp вшитого vscode.zip в staging, ditto -x -k, codesign -R Team ID(UBF8T346G9)+spctl распакованного .app в staging, cp .app в /Applications, xattr -dr com.apple.quarantine; поставить расширения anthropic.claude-code + openai.chatgpt"
  else
    verify_artifact "$ZIP"    # вшитый артефакт — предварительный fail-closed SHA-256 (быстрый отсев повреждённого zip без пароля)
    # verify + install АТОМАРНО под root на root-owned staging (Codex — тот же TOCTOU, что
    # закрыт для cursor/node/pydeps). Раньше SHA проверялась medium'ом, ZIP распаковывался
    # в same-UID /tmp, а root копировал .app ВНУТРИ admin_run — пока открыт пароль-промпт,
    # same-user мог подменить распакованный .app. SHA на вшитом zip от этого НЕ защищает:
    # checksums.json тоже same-UID (атакующий подменит и zip, и хэш). Теперь под root в
    # ОДНОМ admin_run (HM_VSCODE_INSTALL_SH): cp вшитого zip -> root-owned staging (0700) ->
    # ditto распаковка в staging -> codesign -R (ТОЧНЫЙ Team ID Microsoft; крипто-оценка
    # подписи, не парсинг -dv) + spctl (нотаризация) распакованного .app -> cp .app в
    # /Applications -> снять карантин. Между verify и install окна нет (всё над root-owned
    # staging). Team ID и dest — ПОЗИЦИОННЫЕ параметры (не интерполяция в текст).
    # Team ID VS Code. Подтверждено сетью (2026-07): официальные сборки VS Code подписаны
    # "Developer ID Application: Microsoft Corporation (UBF8T346G9)", TeamIdentifier=UBF8T346G9
    # (community.jamf.com — codesign output; fullmetalmac.com/team-ids — Microsoft = UBF8T346G9).
    # TODO-verify: сменит Microsoft Team ID -> fail-closed стоп; обновить VSCODE_TEAM_ID.
    VSCODE_TEAM_ID='UBF8T346G9'
    # Место на системном томе. Root-установка идёт через staging: копия zip +
    # ditto-распаковка + cp в /Applications — это ~3 размера архива ПОВЕРХ самого
    # архива. Не хватило места → admin_run падает молча, и человек читал «подпись
    # не подтверждена», хотя подпись ни при чём. Считаем ДО пароля.
    ZIP_KB="$(( $(stat -f %z "$ZIP" 2>/dev/null || echo 0) / 1024 ))"
    FREE_KB="$(df -k / 2>/dev/null | awk 'NR==2{print $4}')"
    NEED_KB="$(( ZIP_KB * 3 + 512 * 1024 ))"
    if [ "${ZIP_KB:-0}" -gt 0 ] && [ -n "${FREE_KB:-}" ] && [ "$FREE_KB" -lt "$NEED_KB" ]; then
      echo "Не хватает места на диске для установки VS Code."
      echo "  Нужно примерно $(( NEED_KB / 1024 / 1024 )) ГБ свободного места, сейчас свободно $(( FREE_KB / 1024 / 1024 )) ГБ."
      echo "  Что делать: освободи место (Корзина, «Хранилище» в настройках Mac) и нажми «Повторить»."
      exit 1
    fi
    echo "Проверяю подпись и устанавливаю VS Code в /Applications (может потребоваться пароль администратора)..."
    if ! admin_run /bin/sh -c "$HM_VSCODE_INSTALL_SH" hm_vscode_install "$ZIP" "$VSCODE_TEAM_ID" "$APP"; then
      # Один код возврата — три разные причины, и советы у них РАЗНЫЕ. Раньше все
      # три сливались в «подпись/нотаризация не подтверждены (fail-closed)», после
      # которого человек не знал, что делать. Разводим текстом.
      echo "VS Code установить не удалось. Возможные причины — в порядке частоты:"
      echo "  1) Окно с паролем администратора закрыли или пароль ввели неверно."
      echo "     → нажми «Повторить» и введи пароль от своей учётной записи Mac."
      echo "  2) Mac не смог подтвердить подпись приложения у серверов Apple."
      echo "     Так бывает при плохом или ограниченном интернете (в том числе из РФ)."
      echo "     → включи VPN или другую сеть и нажми «Повторить»."
      echo "  3) Закончилось место на системном диске во время распаковки."
      echo "     → освободи 3-5 ГБ и нажми «Повторить»."
      echo "Проверка подписи специально строгая: без подтверждения мы НЕ ставим приложение."
      exit 1
    fi
    if [ -d "$APP" ]; then
      echo "VS Code установлен."
      echo "HM-RECEIPT path $APP"
    else
      echo "ВНИМАНИЕ: VS Code не подтвердил установку — расширения всё равно попробую доставить."
    fi
  fi
fi

# --- Расширения: ОБА — панель Claude (anthropic.claude-code) и Codex (openai.chatgpt) ---
ext_present() {
  # $1=cli $2=extId ; ретрай на лаг --list-extensions. Сравнение в lowercase (GNU grep 3.0-safe).
  k=0
  while [ "$k" -lt 3 ]; do
    if "$1" --list-extensions 2>/dev/null | tr '[:upper:]' '[:lower:]' \
        | grep -Fx "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" >/dev/null; then
      return 0
    fi
    k=$((k + 1)); sleep 1
  done
  return 1
}

# Вшитый .vsix (офлайн). vsix исполняется как код внутри VS Code -> целостность ДО установки
# (fail-closed, в ГЛАВНОМ шелле — не в субшелле, иначе exit не остановил бы установку).
VSIX_OUT=""
resolve_vsix() {
  VSIX_OUT=""
  [ -n "${HM_VENDOR:-}" ] || return 0
  local p="$HM_VENDOR/apps/$1"
  [ -f "$p" ] || return 0
  verify_artifact "$p"
  VSIX_OUT="$p"
}

install_ext() {
  # $1=cli $2=extId $3=vsix(опц.)
  cli="$1"; extId="$2"; vsix="${3:-}"
  echo "Ставлю расширение $extId в VS Code..."
  # Приоритет — вшитый .vsix (офлайн); фолбэк — Marketplace по id.
  if [ -n "$vsix" ]; then
    echo "  из вшитого vsix (офлайн): $vsix"
    "$cli" --install-extension "$vsix" --force
    if ext_present "$cli" "$extId"; then echo "  $extId: на месте (офлайн vsix)."; return 0; fi
    echo "  $extId: vsix не подтвердился — пробую Marketplace..."
  fi
  "$cli" --install-extension "$extId" --force
  if ext_present "$cli" "$extId"; then echo "  $extId: на месте."; return 0; fi
  echo "  $extId: не подтвердилось."; return 1
}

if [ -n "$DRY" ]; then
  echo "  [dry-run] расширения: anthropic.claude-code + openai.chatgpt (ветка выбрана, без изменений)."
  exit 0
fi

if [ ! -x "$CODE_CLI" ]; then
  echo "CLI VS Code не найден ($CODE_CLI) — расширения не поставить автоматически. Открой VS Code -> Extensions -> 'Claude Code' и 'ChatGPT - Codex' -> Install."
  exit 1
fi

resolve_vsix "claude-code-$(arch_tag).vsix"; CLAUDE_VSIX="$VSIX_OUT"
resolve_vsix "chatgpt-$(arch_tag).vsix";     CODEX_VSIX="$VSIX_OUT"
# Офлайн-vsix под ЭТУ архитектуру не вшит, а под другую — вшит: скажем прямо, что
# дальше пойдём в интернет-магазин, иначе без сети шаг просто «не подтвердится».
if [ -z "$CLAUDE_VSIX" ] && hm_arch_note_missing "${HM_VENDOR:-}/apps" "claude-code-" ".vsix" "Панель Claude Code"; then
  echo "Поставлю панель из интернет-магазина расширений — потребуется подключение."
fi

EXT_OK_CLAUDE=0
EXT_OK_CODEX=0
install_ext "$CODE_CLI" "anthropic.claude-code" "$CLAUDE_VSIX" && EXT_OK_CLAUDE=1
install_ext "$CODE_CLI" "openai.chatgpt" "$CODEX_VSIX" && EXT_OK_CODEX=1

[ "$EXT_OK_CLAUDE" -eq 1 ] && echo "OK: панель Claude Code в VS Code установлена."
[ "$EXT_OK_CODEX" -eq 1 ] && echo "OK: Codex (openai.chatgpt) в VS Code установлен."
# Успех (exit 0) — по ОБЯЗАТЕЛЬНОМУ расширению Claude. Codex ОПЦИОНАЛЕН: сборка его не
# гейтит (chatgpt-*.vsix не входит в completeness-проверку fetch-vendor-mac.sh, «поставится
# онлайн»), verify.sh его не проверяет — значит его отсутствие НЕ должно красить компонент
# и утаскивать в dep-skip зависимый «Расширение». Пишем честное предупреждение.
if [ "$EXT_OK_CODEX" -ne 1 ]; then
  echo "ПРЕДУПРЕЖДЕНИЕ: Codex (openai.chatgpt) не установился — это опциональная панель. Поставить позже: VS Code -> Extensions -> 'ChatGPT - Codex' -> Install."
fi
if [ "$EXT_OK_CLAUDE" -eq 1 ]; then exit 0; fi
# Сам редактор при этом уже стоит — говорим об этом прямо, иначе человек видит
# красный крест на «VS Code» и думает, что редактора у него нет.
echo "Не установилось расширение Claude Code (anthropic.claude-code)."
echo "Редактор VS Code при этом установлен — не хватает только панели внутри него."
echo "  Что делать: открой VS Code → Extensions (значок кубиков слева) → набери"
echo "  «Claude Code» → Install. Либо нажми «Повторить» на этом шаге."
echo "  Claude Code при этом уже работает в терминале командой 'claude' — панель"
echo "  нужна только для удобства."
exit 1
