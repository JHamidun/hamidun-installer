#!/usr/bin/env bash
# Nomad Agent — macOS (Python CLI via uv)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
DRY="${HM_DRY_RUN:-}"

# 1. Источник Nomad: офлайн vendor → git repoUrl из config.json → graceful skip
SRC="${HM_NOMAD_SRC:-}"
WE_CLONED_SRC=0   # P0-4: клонировали ли МЫ исходники в ~/.nomad-src
REPO_CONFIGURED=0 # был ли реально задан repoUrl (тогда clone обязан был сработать)
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
    REPO_CONFIGURED=1
    echo "Клонирую Nomad из $REPO ..."
    if [ -z "$DRY" ]; then
      # P0-2: НЕ усыновляем существующий ЧУЖОЙ каталог. Существует БЕЗ нашего маркера
      # → НЕМЕДЛЕННЫЙ отказ (не pull, не mark, не трогаем). Маркер пишем ТОЛЬКО после
      # FRESH clone в РАНЕЕ ОТСУТСТВОВАВШИЙ каталог. git pull разрешён ТОЛЬКО для уже
      # отмеченного каталога И с проверкой remote.origin.url == нашего REPO.
      if [ -e "$SRC" ] || [ -L "$SRC" ]; then
        if [ ! -f "$SRC/.hamidun-nomad" ]; then
          echo "ОШИБКА: $SRC уже существует и не помечен нашим маркером (.hamidun-nomad отсутствует) — не трогаю чужой каталог."
          exit 1
        fi
        ORIGIN=$(git -C "$SRC" config --get remote.origin.url 2>/dev/null || true)
        if [ "$ORIGIN" != "$REPO" ]; then
          echo "ОШИБКА: $SRC помечен нашим, но remote.origin.url ($ORIGIN) ≠ ожидаемому ($REPO) — отказ обновлять."
          exit 1
        fi
        git -C "$SRC" pull --ff-only
      else
        git clone --depth 1 "$REPO" "$SRC"
        # P0-2/P0-3: маркер владения — ТОЛЬКО после успешного FRESH clone. pyproject.toml
        # есть у чужих проектов → он НЕ гейт удаления; гейт = наш уникальный .hamidun-nomad.
        [ -f "$SRC/pyproject.toml" ] && printf 'installed-by: hamidun-setup\n' > "$SRC/.hamidun-nomad"
      fi
    fi
  fi
fi
# P0-1: repoUrl был задан, но источник так и не появился (clone/pull упал или нет
# pyproject.toml) — это НАСТОЯЩИЙ провал, а не осознанный skip: честный выход 1.
if [ -z "$DRY" ] && [ "$REPO_CONFIGURED" = "1" ] && [ ! -f "$SRC/pyproject.toml" ]; then
  echo "ОШИБКА: источник Nomad не склонировался (git clone/pull упал или pyproject.toml не появился) — смотри лог выше."
  exit 1
fi
if [ ! -f "$SRC/pyproject.toml" ]; then
  echo "Источник Nomad не задан. Укажите nomad.repoUrl в config.json или вшейте vendor/nomad-src. Пропускаю."
  # P0-1: осознанный skip (нечего ставить) — distinct-код «не установлено», чтобы main
  # НЕ писал маркер установки (иначе uninstall снёс бы чужие venv/шимы). В dry-run — 0.
  [ -n "$DRY" ] && exit 0
  exit 120
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
  # P0-1: ownership-маркер ВНУТРЬ ФАКТИЧЕСКИ созданного venv uv-тула. Деинсталлятор
  # удаляет venv/шимы ТОЛЬКО при этом маркере — не «оба возможных venv + 4 шима»
  # (иначе снёс бы собственный uv-tool пользователя с тем же именем пакета).
  for v in "$HOME/.local/share/uv/tools/hermes-agent"; do
    [ -d "$v" ] && printf 'installed-by: hamidun-setup\n' > "$v/.hamidun-nomad" 2>/dev/null || true
  done
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
  # P1-4: uv-тул называется по pyproject [project].name = hermes-agent (не «nomad»).
  [ -d "$HOME/.local/share/uv/tools/hermes-agent" ] && echo "HM-RECEIPT path $HOME/.local/share/uv/tools/hermes-agent"
  [ -f "$HH/SOUL.md" ] && echo "HM-RECEIPT path $HH/SOUL.md"
  [ -f "$HH/skins/nomad.yaml" ] && echo "HM-RECEIPT path $HH/skins/nomad.yaml"
fi

if have nomad; then echo "OK: nomad установлен ($(nomad --version 2>&1 | head -n1))"; else echo "Nomad установлен — команда появится в PATH после перезапуска терминала."; fi
exit 0
