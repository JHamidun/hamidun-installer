#!/usr/bin/env bash
# Nomad Agent — macOS (Python CLI via uv)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
DRY="${HM_DRY_RUN:-}"

# 1. Источник Nomad: офлайн vendor → git repoUrl из config.json → graceful skip
SRC="${HM_NOMAD_SRC:-}"
WE_CLONED_SRC=0   # P0-4: клонировали ли МЫ исходники в ~/.nomad-src
if [ ! -f "$SRC/pyproject.toml" ]; then
  REPO=""
  CFG="$DIR/../../config.json"
  if [ -f "$CFG" ]; then
    # Парсим nomad.repoUrl без python (иначе bare python3 без CLT дёргает диалог).
    # Берём первую строку вида "repoUrl": "..." и вытаскиваем значение в кавычках.
    REPO=$(grep -o '"repoUrl"[[:space:]]*:[[:space:]]*"[^"]*"' "$CFG" 2>/dev/null | head -n1 | sed 's/.*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
  fi
  if [ -n "$REPO" ]; then
    SRC="$HOME/.nomad-src"
    WE_CLONED_SRC=1
    echo "Клонирую Nomad из $REPO ..."
    if [ -z "$DRY" ]; then
      if [ -d "$SRC/.git" ]; then git -C "$SRC" pull --ff-only; else git clone --depth 1 "$REPO" "$SRC"; fi
    fi
  fi
fi
if [ ! -f "$SRC/pyproject.toml" ]; then
  echo "Источник Nomad не задан. Укажите nomad.repoUrl в config.json или вшейте vendor/nomad-src. Пропускаю."
  exit 0
fi

# 2. uv — менеджер Python
if ! have uv; then
  echo "Устанавливаю uv..."
  [ -z "$DRY" ] && curl -fsSL https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi

# 3. Python 3.12 (pyproject требует <3.14) + установка nomad (команды nomad/hermes)
if [ -z "$DRY" ]; then
  uv python install 3.12
  echo "Устанавливаю Nomad (команды nomad/hermes)..."
  uv tool install --python 3.12 --force "$SRC"
  export PATH="$HOME/.local/bin:$PATH"
fi

# 4. Брендинг → HERMES_HOME (по умолчанию ~/.hermes)
HH="${HERMES_HOME:-$HOME/.hermes}"
if [ -z "$DRY" ]; then
  mkdir -p "$HH/skins"
  if [ -f "$SRC/branding/SOUL.md" ]; then cp "$SRC/branding/SOUL.md" "$HH/SOUL.md"
  else echo "  [warn] branding/SOUL.md не найден — пропускаю"; fi
  if [ -f "$SRC/branding/skins/nomad.yaml" ]; then cp "$SRC/branding/skins/nomad.yaml" "$HH/skins/nomad.yaml"
  else echo "  [warn] branding/skins/nomad.yaml не найден — пропускаю"; fi
  if [ ! -f "$HH/config.yaml" ]; then
    if [ -f "$SRC/branding/config.yaml.template" ]; then cp "$SRC/branding/config.yaml.template" "$HH/config.yaml"
    else echo "  [warn] branding/config.yaml.template не найден — пропускаю"; fi
  fi
fi

# P0-4: квитанция владения — ТОЧНЫЕ пути созданных артефактов (main соберёт в receipt).
# ВАЖНО: $HH/config.yaml НЕ записываем — после установки это пользовательский конфиг.
if [ -z "$DRY" ]; then
  [ "$WE_CLONED_SRC" = "1" ] && [ -d "$SRC" ] && echo "HM-RECEIPT path $SRC"
  for shim in nomad hermes; do
    [ -e "$HOME/.local/bin/$shim" ] && echo "HM-RECEIPT path $HOME/.local/bin/$shim"
  done
  [ -d "$HOME/.local/share/uv/tools/nomad" ] && echo "HM-RECEIPT path $HOME/.local/share/uv/tools/nomad"
  [ -f "$HH/SOUL.md" ] && echo "HM-RECEIPT path $HH/SOUL.md"
  [ -f "$HH/skins/nomad.yaml" ] && echo "HM-RECEIPT path $HH/skins/nomad.yaml"
fi

if have nomad; then echo "OK: nomad установлен ($(nomad --version 2>&1 | head -n1))"; else echo "Nomad установлен — команда появится в PATH после перезапуска терминала."; fi
exit 0
