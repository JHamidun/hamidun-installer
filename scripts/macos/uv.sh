#!/usr/bin/env bash
# uv — быстрый менеджер Python (Astral). REMOTE-компонент: бинарь НЕ вшит,
# а докачан установщиком из CDN и распакован в $HM_REMOTE_CACHE (см. main.js
# fetch-remote / remote-fetch.js). Здесь только: скопировать в ~/.local/bin,
# добавить в PATH, проверить запуск. Honor HM_DRY_RUN. Честный статус.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
DRY="${HM_DRY_RUN:-}"

CACHE="${HM_REMOTE_CACHE:-}"
if [ -z "$CACHE" ] || [ ! -d "$CACHE" ]; then
  echo "ОШИБКА: HM_REMOTE_CACHE не задан/не существует — докачка uv не выполнена."
  exit 1
fi

# Ищем исполняемый uv (и uvx) в распакованном кэше.
UV="$(find "$CACHE" -type f -name uv 2>/dev/null | head -n1 || true)"
if [ -z "$UV" ]; then echo "ОШИБКА: бинарь uv не найден в распакованном кэше ($CACHE)."; exit 1; fi
UVX="$(find "$CACHE" -type f -name uvx 2>/dev/null | head -n1 || true)"

DEST="$HOME/.local/bin"
if [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: cp $UV -> $DEST/uv (+chmod +x) и добавить $DEST в PATH"
  exit 0
fi

mkdir -p "$DEST"
cp -f "$UV" "$DEST/uv"; chmod +x "$DEST/uv"
if [ -n "$UVX" ]; then cp -f "$UVX" "$DEST/uvx"; chmod +x "$DEST/uvx"; fi
# Провал копии под set -e уже прервёт скрипт; дополнительно убеждаемся, что
# бинарь реально на месте (не ложный успех перед проверкой запуска).
if [ ! -x "$DEST/uv" ]; then echo "ОШИБКА: uv не скопирован в $DEST."; exit 1; fi
persist_local_bin_path
export PATH="$DEST:$PATH"

if have uv; then echo "OK: uv установлен ($(uv --version 2>&1 | head -n1))"; exit 0; fi
echo "uv установлен в $DEST — команда появится в PATH после перезапуска терминала."
exit 0
