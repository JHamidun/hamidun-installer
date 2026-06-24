#!/usr/bin/env bash
# Nomad Agent — macOS (Python CLI via uv)
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
DRY="${HM_DRY_RUN:-}"

# 1. Источник Nomad: офлайн vendor → git repoUrl из config.json → graceful skip
SRC="${HM_NOMAD_SRC:-}"
if [ ! -f "$SRC/pyproject.toml" ]; then
  REPO=""
  CFG="$DIR/../../config.json"
  if [ -f "$CFG" ]; then
    REPO=$(python3 -c "import json;print(json.load(open('$CFG')).get('nomad',{}).get('repoUrl',''))" 2>/dev/null || echo "")
  fi
  if [ -n "$REPO" ]; then
    SRC="$HOME/.nomad-src"
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
  cp "$SRC/branding/SOUL.md"          "$HH/SOUL.md"
  cp "$SRC/branding/skins/nomad.yaml" "$HH/skins/nomad.yaml"
  [ -f "$HH/config.yaml" ] || cp "$SRC/branding/config.yaml.template" "$HH/config.yaml"
fi

if have nomad; then echo "OK: nomad установлен ($(nomad --version 2>&1 | head -n1))"; else echo "Nomad установлен — команда появится в PATH после перезапуска терминала."; fi
exit 0
