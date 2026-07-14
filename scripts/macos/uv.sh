#!/usr/bin/env bash
# uv — быстрый менеджер Python (Astral). REMOTE-компонент: бинарь НЕ вшит, а
# докачан установщиком из CDN, проверен по SHA-256 и разложен в $HM_REMOTE_CACHE
# (см. main.js / remote-fetch.js). На macOS/Linux установка uv НЕЭЛЕВЕЙТЕД
# end-to-end (копируем в ~/.local/bin и запускаем под своим токеном) — эскалации
# нет. FIX-G: берём ОБЫЧНЫЙ файл (не симлинк), проверяем версию ЗАПУСКОМ ИЗ
# ИСТОЧНИКА, требуем exit 0 И валидный формат вывода — без безусловного успеха.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
DRY="${HM_DRY_RUN:-}"

DEST="$HOME/.local/bin"
# P1-8: dry-run ветвится ДО проверки кэша — в dry-run main НИЧЕГО не докачивает,
# поэтому HM_REMOTE_CACHE легитимно отсутствует; никаких обращений к сети/диску.
if [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: докачать uv из CDN (SHA-256), проверить запуском ИЗ КЭША, cp -> $DEST/uv (+chmod +x), добавить $DEST в PATH"
  exit 0
fi

CACHE="${HM_REMOTE_CACHE:-}"
if [ -z "$CACHE" ] || [ ! -d "$CACHE" ]; then
  echo "ОШИБКА: HM_REMOTE_CACHE не задан/не существует — докачка uv не выполнена."
  exit 1
fi

# Ищем ОБЫЧНЫЙ (не симлинк) исполняемый uv (и uvx) в проверенном кэше.
UV="$(find "$CACHE" -type f -name uv 2>/dev/null | head -n1 || true)"
if [ -z "$UV" ]; then echo "ОШИБКА: бинарь uv не найден в кэше ($CACHE)."; exit 1; fi
if [ -L "$UV" ]; then echo "ОШИБКА: uv в кэше — симлинк (отклонено)."; exit 1; fi
UVX="$(find "$CACHE" -type f -name uvx 2>/dev/null | head -n1 || true)"

# 1) ПРОВЕРКА ЗАПУСКОМ ИЗ ИСТОЧНИКА (кэш), а НЕ будущей копии. Проверяем и код
#    возврата, и ФОРМАТ вывода 'uv <версия>' (не наличие подстроки в тексте ошибки).
chmod +x "$UV" 2>/dev/null || true
if ! VER="$("$UV" --version 2>/dev/null)"; then
  echo "ОШИБКА: uv из кэша не запустился."
  exit 1
fi
case "$VER" in
  'uv '[0-9]*) : ;;
  *) echo "ОШИБКА: uv --version дал некорректный вывод ($VER)."; exit 1 ;;
esac

# 2) Копируем проверенный бинарь в пользовательский ~/.local/bin.
mkdir -p "$DEST"
cp -f "$UV" "$DEST/uv"; chmod +x "$DEST/uv"
if [ -n "$UVX" ] && [ ! -L "$UVX" ]; then cp -f "$UVX" "$DEST/uvx"; chmod +x "$DEST/uvx"; fi
if [ ! -x "$DEST/uv" ]; then echo "ОШИБКА: uv не скопирован в $DEST."; exit 1; fi
persist_local_bin_path

# P0-4: квитанция владения — ТОЧНЫЕ пути бинарей (НЕ каталог ~/.local/bin: он общий;
# и НЕ строки HAMIDUN_LOCAL_BIN в rc: их используют claude/git).
echo "HM-RECEIPT path $DEST/uv"
[ -e "$DEST/uvx" ] && echo "HM-RECEIPT path $DEST/uvx"

echo "OK: uv установлен ($VER) — проверен из кэша, скопирован в $DEST."
exit 0
