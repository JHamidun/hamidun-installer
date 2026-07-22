#!/usr/bin/env bash
# Nomad Agent — macOS (Python CLI via uv)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
DRY="${HM_DRY_RUN:-}"

# GUARD (Codex P0): не перезаписываем ЧУЖОЙ uv-tool/шимы. Если uv-tool nomad-agent ИЛИ
# команды nmd/nomad-agent/nomad-acp (entrypoints агента) уже существуют — установщик их
# НЕ трогает и НЕ ставит поверх (без принудительной перезаписи): осознанный skip (exit 120).
# Клонирования нет вовсе (vendor-only).
if [ -z "$DRY" ]; then
  UV_TOOL_NA="$HOME/.local/share/uv/tools/nomad-agent"
  if [ -e "$UV_TOOL_NA" ] || [ -L "$UV_TOOL_NA" ] \
     || [ -e "$HOME/.local/bin/nmd" ] || [ -L "$HOME/.local/bin/nmd" ] \
     || [ -e "$HOME/.local/bin/nomad-agent" ] || [ -L "$HOME/.local/bin/nomad-agent" ] \
     || [ -e "$HOME/.local/bin/nomad-acp" ] || [ -L "$HOME/.local/bin/nomad-acp" ]; then
    echo "uv-tool nomad-agent или команды nmd/nomad-agent/nomad-acp уже установлены — не перезаписываю чужое (без принудительной перезаписи). Пропускаю."
    exit 120
  fi
fi

# 1. Источник Nomad — VENDOR-ONLY: ТОЛЬКО вшитый bundled vendor (HM_NOMAD_SRC с
#    pyproject.toml; путь задаёт main из vendorRoot, не renderer). Клонирования НЕТ:
#    ветка клонирования удалена целиком, и с ней ушла TOCTOU-P0 (Фаза 2, Codex round-7) —
#    подмена чужого pyproject.toml между Test-Path и клоном → исполнение чужого
#    build-backend. Нет vendor → graceful skip 120 (НЕ клонируем, НЕ падаем).
SRC="${HM_NOMAD_SRC:-}"
SRC_TRUSTED=0      # можно ли ставить из SRC: доверенный вшитый vendor
if [ -n "$SRC" ] && [ -f "$SRC/pyproject.toml" ]; then
  # Доверенный bundled vendor — единственный источник, из которого можно ставить.
  SRC_TRUSTED=1
fi
# Vendor не вшит → осознанный skip: distinct-код 120 (main НЕ пишет маркер установки).
# В dry-run — 0.
if [ "$SRC_TRUSTED" != "1" ]; then
  echo "Источник Nomad (vendor/nomad-src) не вшит — устанавливать нечего (клонирование не выполняется). Вшей vendor/nomad-src (см. tools/fetch-vendor-mac.sh). Пропускаю."
  [ -n "$DRY" ] && exit 0
  exit 120
fi

# 1b. Целостность вшитого nomad-src — fail-closed ДО любого использования $SRC
#     (тот же принцип, что verify_artifact для vendor/apps): (а) манифест дерева
#     vendor/nomad-src.sha256 сам закреплён в checksums.json; (б) детерминированный
#     SHA-256 ДЕРЕВА $SRC (hm_tree_sha256, рецепт общий с fetch-vendor-mac.sh)
#     обязан совпасть с манифестом; (в) pyproject.toml дополнительно закреплён в
#     checksums.json. Несовпадение/нет манифеста → exit 1, uv tool install НЕ идёт.
if [ -z "$DRY" ]; then
  TREE_SHA_FILE="${HM_VENDOR:-}/nomad-src.sha256"
  if [ -z "${HM_VENDOR:-}" ] || [ ! -f "$TREE_SHA_FILE" ]; then
    echo "БЕЗОПАСНОСТЬ: нет манифеста целостности nomad-src (vendor/nomad-src.sha256) — отказываюсь ставить Nomad из непроверенного дерева. Пересобери установщик (tools/fetch-vendor-mac.sh). Установка остановлена."
    exit 1
  fi
  verify_artifact "$TREE_SHA_FILE"      # сам манифест — против checksums.json
  verify_artifact "$SRC/pyproject.toml" # точечный пин главного файла пакета
  TREE_WANT="$(tr -d '[:space:]' < "$TREE_SHA_FILE" | tr 'A-Z' 'a-z')"
  TREE_GOT="$(hm_tree_sha256 "$SRC")"
  if [ -z "$TREE_WANT" ] || [ "$TREE_GOT" != "$TREE_WANT" ]; then
    echo "БЕЗОПАСНОСТЬ: НЕ СОВПАЛ SHA-256 дерева nomad-src — vendor подменён/повреждён. Установка Nomad остановлена."
    echo "  ожидалось: ${TREE_WANT:-<пусто>}"
    echo "  получено:  $TREE_GOT"
    exit 1
  fi
  echo "  Целостность подтверждена (SHA-256 дерева): vendor/nomad-src"
fi

# 2. uv — менеджер Python. БЕЗ curl|sh (P1-фикс: неверифицированный сетевой
#    инсталлер ломал инвариант uv.sh P1-A «uv только из vendor c fail-closed SHA»).
#    Единственный источник uv = вшитый vendor-архив uv-macos-$(arch_tag).tar.gz —
#    пере-используем scripts/macos/uv.sh (verify_artifact + распаковка + проверка
#    запуском из источника), НЕ дублируем. Нет vendor-архива (uv.sh exit 120) →
#    честный graceful skip компонента: сначала выбери компонент uv.
if ! have uv; then
  echo "uv не найден — ставлю из вшитого vendor-архива (fail-closed SHA-256, без сети)..."
  if bash "$DIR/uv.sh"; then UV_RC=0; else UV_RC=$?; fi
  if [ "$UV_RC" = "120" ]; then
    echo "Компонент Nomad требует uv, а vendor-архив uv не вшит в эту сборку — сначала выбери компонент uv (или пересобери установщик с uv). Пропускаю Nomad."
    [ -n "$DRY" ] && exit 0
    exit 120
  elif [ "$UV_RC" != "0" ]; then
    echo "ОШИБКА: установка uv из вшитого архива не удалась (код $UV_RC) — Nomad не устанавливаю (fail-closed)."
    exit "$UV_RC"
  fi
  export PATH="$HOME/.local/bin:$PATH"
  if [ -z "$DRY" ] && ! have uv; then
    echo "ОШИБКА: uv не появился в PATH после установки — Nomad не устанавливаю."
    exit 1
  fi
fi

# 2b. Честная проверка сети (vendor-honesty): вшит только ИСХОДНИК Nomad —
#     `uv python install` тянет CPython с GitHub, а `uv tool install` резолвит
#     зависимости из PyPI. Полностью офлайн-машина падала бы криптичной ошибкой uv →
#     вместо этого осознанный skip 120 (НЕ красный крест): Nomad поставится позже при
#     подключении. Быстрая проба: TCP/TLS-ответ ЛЮБОГО из хостов с коротким таймаутом,
#     без скачиваний; curl внутри условия if — под set -e упавшая проба скрипт не убивает.
#     В dry-run сеть не пробуем.
if [ -z "$DRY" ]; then
  NET_OK=0
  for probe_host in https://github.com https://pypi.org; do
    if curl -sI --connect-timeout 3 --max-time 5 "$probe_host" >/dev/null 2>&1; then NET_OK=1; break; fi
  done
  if [ "$NET_OK" != "1" ]; then
    echo "Nomad требует интернет (Python + библиотеки, ~300 МБ) — сеть недоступна. Поставь позже при подключении к интернету. Пропускаю."
    exit 120
  fi
  echo "Nomad докачивает Python и библиотеки из интернета (~300 МБ) — это займёт время..."
fi

# 3. Python 3.12 (pyproject требует <3.14) + установка nomad (команды nmd/nomad-agent/nomad-acp).
# БЕЗ принудительной перезаписи: uv-тул/шимы этого имени уже отсеяны guard-ом выше, а
# принудительная замена могла бы затронуть и не-uv бинарь того же имени — недопустимо.
if [ -z "$DRY" ]; then
  uv python install 3.12
  echo "Устанавливаю Nomad (команды nmd/nomad-agent/nomad-acp)..."
  uv tool install --python 3.12 "$SRC"
  export PATH="$HOME/.local/bin:$PATH"
  # v1: ownership-маркеры в venv БОЛЬШЕ НЕ пишем (маркерная логика удалена вместе с
  # авто-удалением Nomad — см. src/uninstall-targets.js). Запись маркера-владения в
  # пользовательские candidate-venv была install-side P0 (портила чужой uv-tool).
fi

# 4. Брендинг → HERMES_HOME (по умолчанию ~/.hermes). Брендинг-файл копируем ТОЛЬКО если
# целевого НЕТ — существующий пользовательский файл НЕ перезаписываем.
HH="${HERMES_HOME:-$HOME/.hermes}"
WROTE_SOUL=0; WROTE_SKIN=0
if [ -z "$DRY" ]; then
  mkdir -p "$HH/skins"
  if [ ! -f "$HH/SOUL.md" ]; then
    if [ -f "$SRC/branding/SOUL.md" ]; then cp "$SRC/branding/SOUL.md" "$HH/SOUL.md"; WROTE_SOUL=1
    else echo "  [warn] branding/SOUL.md не найден — пропускаю"; fi
  else echo "  SOUL.md уже существует — не перезаписываю."; fi
  if [ ! -f "$HH/skins/nomad.yaml" ]; then
    if [ -f "$SRC/branding/skins/nomad.yaml" ]; then cp "$SRC/branding/skins/nomad.yaml" "$HH/skins/nomad.yaml"; WROTE_SKIN=1
    else echo "  [warn] branding/skins/nomad.yaml не найден — пропускаю"; fi
  else echo "  skins/nomad.yaml уже существует — не перезаписываю."; fi
  if [ ! -f "$HH/config.yaml" ]; then
    if [ -f "$SRC/branding/config.yaml.template" ]; then cp "$SRC/branding/config.yaml.template" "$HH/config.yaml"
    else echo "  [warn] branding/config.yaml.template не найден — пропускаю"; fi
  fi
fi

# 5. Nomad Cloud (cp.nomadnet.ai) — доступ к ИИ-моделям через облако владельца (без VPN).
#    OpenAI-совместимый custom-провайдер: model.provider=custom + base_url + api_key + default.
#    Ключ — ТОЛЬКО кабинетный ключ ДРУГА (HM_NOMAD_CLOUD_KEY), ключ владельца нигде не зашит.
#    Ключ не задан → блок НЕ пишем (graceful): любую нейросеть подключишь позже своим ключом
#    через `nmd model`. Идемпотентно: awk снимает прежний управляемый блок + top-level model:.
CLOUD_KEY="${HM_NOMAD_CLOUD_KEY:-}"
CLOUD_URL="${HM_NOMAD_CLOUD_BASEURL:-https://cp.nomadnet.ai/v1}"
CLOUD_MODEL="${HM_NOMAD_CLOUD_MODEL:-claude-opus-4-6}"
# trim + вычистка кавычек/переводов строк (значение уходит в YAML в кавычках)
CLOUD_KEY="$(printf '%s' "$CLOUD_KEY" | tr -d '"\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
CLOUD_URL="$(printf '%s' "$CLOUD_URL" | tr -d '"\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
CLOUD_MODEL="$(printf '%s' "$CLOUD_MODEL" | tr -d '"\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
CFGY="$HH/config.yaml"
if [ -z "$CLOUD_KEY" ]; then
  echo "Ключ Nomad Cloud не задан — облачный блок НЕ пишу (graceful). Подключишь позже: nmd model → custom endpoint $CLOUD_URL или свой ключ любой нейросети."
elif [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: в $CFGY вписать model.provider=custom base_url=$CLOUD_URL default=$CLOUD_MODEL api_key=<скрыт>"
else
  STRIPPED=""
  if [ -f "$CFGY" ]; then
    STRIPPED="$(awk '
      /^# >>> nomad-cloud/ { skipm=1; next }
      skipm==1 { if ($0 ~ /^# <<< nomad-cloud/) { skipm=0 } next }
      /^model:[[:blank:]]*$/ { skipmod=1; next }
      skipmod==1 { if ($0 ~ /^[[:blank:]]/ || $0 ~ /^[[:blank:]]*$/) { next } else { skipmod=0 } }
      { print }
    ' "$CFGY")"
  fi
  {
    echo '# >>> nomad-cloud (managed by installer -- do not edit inside markers) >>>'
    echo 'model:'
    echo '  provider: "custom"'
    echo "  base_url: \"$CLOUD_URL\""
    echo "  api_key: \"$CLOUD_KEY\""
    echo "  default: \"$CLOUD_MODEL\""
    echo '# <<< nomad-cloud <<<'
    printf '%s\n' "$STRIPPED"
  } > "$CFGY"
  echo "OK: Nomad подключён к облаку $CLOUD_URL (модель $CLOUD_MODEL). Ключ записан в config.yaml."
fi

# P0-4: квитанция владения — ТОЧНЫЕ пути СОЗДАННЫХ артефактов (main соберёт в receipt).
# ВАЖНО: $HH/config.yaml НЕ записываем — после установки это пользовательский конфиг.
# Vendor-only: клона ~/.nomad-src больше нет (источник — read-only вшитый vendor) → в
# квитанцию его НЕ пишем. Брендинг — ТОЛЬКО если МЫ его создали (чужой файл не присваиваем).
if [ -z "$DRY" ]; then
  for shim in nmd nomad-agent nomad-acp; do
    [ -e "$HOME/.local/bin/$shim" ] && echo "HM-RECEIPT path $HOME/.local/bin/$shim"
  done
  # P1-4: uv-тул называется по pyproject [project].name = nomad-agent.
  [ -d "$HOME/.local/share/uv/tools/nomad-agent" ] && echo "HM-RECEIPT path $HOME/.local/share/uv/tools/nomad-agent"
  [ "$WROTE_SOUL" = "1" ] && [ -f "$HH/SOUL.md" ] && echo "HM-RECEIPT path $HH/SOUL.md"
  [ "$WROTE_SKIN" = "1" ] && [ -f "$HH/skins/nomad.yaml" ] && echo "HM-RECEIPT path $HH/skins/nomad.yaml"
fi

if have nmd; then echo "OK: nomad установлен ($(nmd --version 2>&1 | head -n1))"; else echo "Nomad установлен — команда nmd появится в PATH после перезапуска терминала."; fi
exit 0
