#!/usr/bin/env bash
# uv — быстрый менеджер Python (Astral). ВШИТЫЙ компонент (100% офлайн, BUNDLED-ONLY):
# архив едет внутри установщика (vendor/apps/uv-macos-<arch>.tar.gz — кладёт
# tools/fetch-vendor-mac.sh из GitHub releases astral-sh/uv; имена арх-специфичные,
# т.к. checksums.json ключуется по basename) и проверяется fail-closed по SHA-256
# (verify_artifact) ДО распаковки. Сеть при установке НЕ нужна.
#
# БЕЗОПАСНОСТЬ (P1-A): легаси-фолбэк на HM_REMOTE_CACHE УБРАН полностью — он позволял
# запустить НЕпроверенный uv из унаследованного окружения. Единственный источник uv =
# $HM_VENDOR/apps с fail-closed SHA. Нет vendor → graceful skip (exit 120), НЕ фолбэк.
#
# На macOS установка uv НЕЭЛЕВЕЙТЕД end-to-end (копируем в ~/.local/bin и запускаем
# под своим токеном) — эскалации нет. FIX-G: берём ОБЫЧНЫЙ файл (не симлинк),
# проверяем версию ЗАПУСКОМ ИЗ ИСТОЧНИКА, требуем exit 0 И валидный формат вывода.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
DRY="${HM_DRY_RUN:-}"

DEST="$HOME/.local/bin"
# P1-8: dry-run ветвится ДО проверки vendor — никаких обращений к диску.
if [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: проверить SHA-256 вшитого uv-архива (vendor/apps), распаковать, проверить запуском ИЗ ИСТОЧНИКА, cp -> $DEST/uv (+chmod +x), добавить $DEST в PATH"
  exit 0
fi

# 0) Источник бинарей — ТОЛЬКО вшитый vendor-архив (bundled-only). Нет vendor → skip.
UV_TGZ="${HM_VENDOR:-}/apps/uv-macos-$(arch_tag).tar.gz"
if [ -z "${HM_VENDOR:-}" ] || [ ! -f "$UV_TGZ" ]; then
  echo "uv не вошёл в эту сборку (нет $UV_TGZ) — пропускаю. Всё остальное работает без него."
  exit 120
fi

echo "Ставлю uv из встроенного пакета (офлайн, без обращений к сети)..."
verify_artifact "$UV_TGZ"                       # fail-closed SHA-256 ДО распаковки
EXTRACT=""
cleanup_extract() { [ -n "$EXTRACT" ] && rm -rf "$EXTRACT" 2>/dev/null || true; }
trap cleanup_extract EXIT
EXTRACT="$(mktemp -d "${TMPDIR:-/tmp}/hm-uv.XXXXXX")"
tar -xzf "$UV_TGZ" -C "$EXTRACT" 2>/dev/null || { echo "ОШИБКА: вшитый пакет uv не распаковался."; exit 1; }
# Снимаем quarantine (если vendor копировался через Finder/.dmg) — иначе Gatekeeper.
xattr -dr com.apple.quarantine "$EXTRACT" 2>/dev/null || true
UV="$(find "$EXTRACT" -type f -name uv 2>/dev/null | head -n1 || true)"
if [ -z "$UV" ]; then echo "ОШИБКА: в вшитом пакете нет бинаря uv."; exit 1; fi
UVX="$(find "$EXTRACT" -type f -name uvx 2>/dev/null | head -n1 || true)"
if [ -L "$UV" ]; then echo "ОШИБКА: uv в источнике — симлинк (отклонено)."; exit 1; fi

# 1) ПРОВЕРКА ЗАПУСКОМ ИЗ ИСТОЧНИКА (vendor после SHA-проверки), а НЕ будущей копии.
#    Проверяем и код возврата, и ФОРМАТ вывода 'uv <версия>' (не наличие подстроки
#    в тексте ошибки).
chmod +x "$UV" 2>/dev/null || true
if ! VER="$("$UV" --version 2>/dev/null)"; then
  echo "ОШИБКА: uv из источника не запустился."
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
xattr -d com.apple.quarantine "$DEST/uv" "$DEST/uvx" 2>/dev/null || true
persist_local_bin_path

# P0-4: квитанция владения — ТОЧНЫЕ пути бинарей (НЕ каталог ~/.local/bin: он общий;
# и НЕ строки HAMIDUN_LOCAL_BIN в rc: их используют claude/git).
echo "HM-RECEIPT path $DEST/uv"
[ -e "$DEST/uvx" ] && echo "HM-RECEIPT path $DEST/uvx"

echo "OK: uv установлен ($VER) — целостность подтверждена, скопирован в $DEST."
exit 0
