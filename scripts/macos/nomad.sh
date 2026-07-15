#!/usr/bin/env bash
# Nomad Agent — macOS (Python CLI via uv)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
DRY="${HM_DRY_RUN:-}"

# GUARD (Codex P0): не перезаписываем ЧУЖОЙ uv-tool/шимы. Если uv-tool hermes-agent ИЛИ
# команды nomad/hermes уже существуют — установщик их НЕ трогает и НЕ ставит поверх
# (без принудительной перезаписи): осознанный skip (exit 120). Клон/сборку тоже не запускаем.
if [ -z "$DRY" ]; then
  UV_TOOL_HA="$HOME/.local/share/uv/tools/hermes-agent"
  if [ -e "$UV_TOOL_HA" ] || [ -L "$UV_TOOL_HA" ] \
     || [ -e "$HOME/.local/bin/nomad" ] || [ -L "$HOME/.local/bin/nomad" ] \
     || [ -e "$HOME/.local/bin/hermes" ] || [ -L "$HOME/.local/bin/hermes" ]; then
    echo "uv-tool hermes-agent или команды nomad/hermes уже установлены — не перезаписываю чужое (без принудительной перезаписи). Пропускаю."
    exit 120
  fi
fi

# 1. Источник Nomad — ТОЛЬКО доверенный: (а) вшитый bundled vendor (HM_NOMAD_SRC с
#    pyproject.toml; путь задаёт main из vendorRoot, не renderer), ЛИБО (б) СВЕЖИЙ git
#    clone в РАНЕЕ ОТСУТСТВОВАВШИЙ путь ~/.nomad-src. Любой уже существующий ~/.nomad-src
#    (в т.ч. с pyproject.toml — чужой) НЕ доверяем: не клонируем, НЕ ставим из него и НЕ
#    исполняем его build-backend. Иначе → graceful skip ниже.
SRC="${HM_NOMAD_SRC:-}"
WE_CLONED_SRC=0    # клонировали ли МЫ исходники этим запуском (для квитанции владения)
REPO_CONFIGURED=0  # был ли реально задан repoUrl
CLONE_ATTEMPTED=0  # реально ли запускали git clone (отличаем «clone упал» от «пропущен»)
SRC_TRUSTED=0      # можно ли ставить из SRC: доверенный vendor ИЛИ наш свежий clone
if [ -n "$SRC" ] && [ -f "$SRC/pyproject.toml" ]; then
  # (а) Доверенный bundled vendor — единственный «существующий каталог», из которого можно ставить.
  SRC_TRUSTED=1
else
  # (б) vendor не вшит → пробуем СВЕЖИЙ git clone из repoUrl в ОТСУТСТВУЮЩИЙ путь.
  REPO=""
  CFG="$DIR/../../config.json"
  if [ -f "$CFG" ]; then
    # Парсим nomad.repoUrl без python (иначе bare python3 без CLT дёргает диалог).
    # Берём первую строку вида "repoUrl": "..." и вытаскиваем значение в кавычках.
    REPO=$(grep -o '"repoUrl"[[:space:]]*:[[:space:]]*"[^"]*"' "$CFG" 2>/dev/null | head -n1 | sed 's/.*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
  fi
  if [ -n "$REPO" ]; then
    SRC="$HOME/.nomad-src"
    REPO_CONFIGURED=1
    if [ -z "$DRY" ]; then
      # ЖЁСТКО: клонируем ТОЛЬКО в ОТСУТСТВУЮЩИЙ путь. ЛЮБОЙ существующий $SRC (файл,
      # каталог или симлинк — в т.ч. чужой с pyproject.toml) → НЕ трогаем и НЕ ставим
      # из него: не исполняем чужой build-backend. Уходит в graceful skip (SRC_TRUSTED=0).
      if [ -e "$SRC" ] || [ -L "$SRC" ]; then
        echo "Каталог $SRC уже существует — чужому источнику не доверяю: не клонирую и не устанавливаю из него. Пропускаю."
      else
        echo "Клонирую Nomad из $REPO ..."
        CLONE_ATTEMPTED=1
        git clone --depth 1 "$REPO" "$SRC"
        if [ -f "$SRC/pyproject.toml" ]; then SRC_TRUSTED=1; WE_CLONED_SRC=1; fi
      fi
    fi
  fi
fi
# repoUrl задан и МЫ пытались клонировать, но источник так и не появился (git clone упал
# / нет pyproject.toml) — НАСТОЯЩИЙ провал: честный выход 1. Намеренный пропуск клона
# (чужой каталог) сюда НЕ попадает (CLONE_ATTEMPTED=0) → уходит в graceful skip ниже.
if [ -z "$DRY" ] && [ "$CLONE_ATTEMPTED" = "1" ] && [ "$SRC_TRUSTED" != "1" ]; then
  echo "ОШИБКА: источник Nomad не склонировался (git clone упал или pyproject.toml не появился) — смотри лог выше."
  exit 1
fi
# Ставим ТОЛЬКО из доверенного источника. Недоверенный/отсутствующий (чужой существующий
# каталог, либо clone не выполнен) → осознанный skip: distinct-код 120 (main НЕ пишет
# маркер установки). В dry-run — 0.
if [ "$SRC_TRUSTED" != "1" ]; then
  echo "Источник Nomad не задан/недоступен/недоверенный. Укажите nomad.repoUrl в config.json или вшейте vendor/nomad-src. Пропускаю."
  [ -n "$DRY" ] && exit 0
  exit 120
fi

# 2. uv — менеджер Python
if ! have uv; then
  echo "Устанавливаю uv..."
  [ -z "$DRY" ] && curl -fsSL https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi

# 3. Python 3.12 (pyproject требует <3.14) + установка nomad (команды nomad/hermes).
# БЕЗ принудительной перезаписи: uv-тул/шимы этого имени уже отсеяны guard-ом выше, а
# принудительная замена могла бы затронуть и не-uv бинарь того же имени — недопустимо.
if [ -z "$DRY" ]; then
  uv python install 3.12
  echo "Устанавливаю Nomad (команды nomad/hermes)..."
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

# P0-4: квитанция владения — ТОЧНЫЕ пути СОЗДАННЫХ артефактов (main соберёт в receipt).
# ВАЖНО: $HH/config.yaml НЕ записываем — после установки это пользовательский конфиг.
# Брендинг попадает в квитанцию ТОЛЬКО если МЫ его создали (чужой файл не присваиваем).
if [ -z "$DRY" ]; then
  [ "$WE_CLONED_SRC" = "1" ] && [ -d "$SRC" ] && echo "HM-RECEIPT path $SRC"
  for shim in nomad hermes; do
    [ -e "$HOME/.local/bin/$shim" ] && echo "HM-RECEIPT path $HOME/.local/bin/$shim"
  done
  # P1-4: uv-тул называется по pyproject [project].name = hermes-agent (не «nomad»).
  [ -d "$HOME/.local/share/uv/tools/hermes-agent" ] && echo "HM-RECEIPT path $HOME/.local/share/uv/tools/hermes-agent"
  [ "$WROTE_SOUL" = "1" ] && [ -f "$HH/SOUL.md" ] && echo "HM-RECEIPT path $HH/SOUL.md"
  [ "$WROTE_SKIN" = "1" ] && [ -f "$HH/skins/nomad.yaml" ] && echo "HM-RECEIPT path $HH/skins/nomad.yaml"
fi

if have nomad; then echo "OK: nomad установлен ($(nomad --version 2>&1 | head -n1))"; else echo "Nomad установлен — команда появится в PATH после перезапуска терминала."; fi
exit 0
