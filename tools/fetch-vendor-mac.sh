#!/usr/bin/env bash
# Build-time (на macOS-раннере): качает Mac-бинари в vendor/ для ПОЛНОГО офлайна (arm64).
# set -u, НЕ -e: нативные тулзы пишут в stderr. Запуск: bash tools/fetch-vendor-mac.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="$ROOT/vendor/apps"
mkdir -p "$APPS"

dl() { if [ -f "$2" ]; then echo "  skip $(basename "$2")"; return; fi; echo "  GET $1"; curl -fsSL "$1" -o "$2" || echo "  ! не скачалось $(basename "$2")"; }

echo "[vendor-mac] Python 3.12.7 (universal2 pkg) — ставим на раннер, чтобы wheels совпали..."
PYPKG="$APPS/python.pkg"
dl "https://www.python.org/ftp/python/3.12.7/python-3.12.7-macos11.pkg" "$PYPKG"
sudo installer -pkg "$PYPKG" -target / >/dev/null 2>&1 || echo "  (install python skipped)"
PY="/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
[ -x "$PY" ] || PY="python3"
echo "  python для сборки: $("$PY" --version 2>&1)"

echo "[vendor-mac] Node.js LTS (universal2 pkg)..."
VER=$(curl -fsSL https://nodejs.org/dist/index.json | "$PY" -c 'import sys,json;print(next(x["version"] for x in json.load(sys.stdin) if x["lts"]))')
dl "https://nodejs.org/dist/$VER/node-$VER.pkg" "$APPS/node.pkg"

echo "[vendor-mac] Cursor (arm64 dmg)..."
CUR=$(curl -fsSL "https://www.cursor.com/api/download?platform=darwin-arm64&releaseTrack=stable" | "$PY" -c 'import sys,json;print(json.load(sys.stdin).get("downloadUrl",""))' 2>/dev/null)
[ -n "$CUR" ] && dl "$CUR" "$APPS/cursor.dmg" || echo "  ! Cursor API недоступен"

echo "[vendor-mac] AmneziaVPN (mac pkg/dmg)..."
# На macOS Amnezia раздаёт .pkg (раньше .dmg) — берём по расширению, .pkg приоритетнее.
AV=$(curl -fsSL https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest | "$PY" -c 'import sys,json;A=[x["browser_download_url"] for x in json.load(sys.stdin)["assets"]];p=[u for u in A if u.lower().endswith(".pkg")];d=[u for u in A if u.lower().endswith(".dmg")];print((p+d)[0] if p+d else "")' 2>/dev/null)
if [ -n "$AV" ]; then
  AVEXT=$(echo "${AV##*.}" | tr 'A-Z' 'a-z')
  dl "$AV" "$APPS/amneziavpn.$AVEXT"
else
  echo "  ! AmneziaVPN pkg/dmg не найден"
fi

echo "[vendor-mac] Claude Code CLI -> npm cache (офлайн -g)..."
CACHE="$ROOT/vendor/npm-cache"; TMP="$ROOT/vendor/_claudetmp"; mkdir -p "$TMP"
npm install '@anthropic-ai/claude-code' --prefix "$TMP" --cache "$CACHE" --no-audit --no-fund >/dev/null 2>&1 || true
rm -rf "$TMP"

echo "[vendor-mac] Claude Code VSIX (расширение для VSCode/Cursor, офлайн)..."
VSIX="$APPS/claude-code.vsix"
if [ -f "$VSIX" ]; then
  echo "  skip $(basename "$VSIX")"
else
  # Расширение платформо-специфичное: latest/vspackage БЕЗ targetPlatform отдаёт чужую платформу (linux-x64).
  # Резолвим последнюю версию под darwin-arm64 и качаем versioned URL.
  VSIXVER=$(curl -fsSL -m 60 -X POST "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.2-preview.1" -H "Content-Type: application/json" -d '{"filters":[{"criteria":[{"filterType":7,"value":"anthropic.claude-code"}]}],"flags":1}' | "$PY" -c 'import sys,json;vs=json.load(sys.stdin)["results"][0]["extensions"][0]["versions"];m=[v["version"] for v in vs if v.get("targetPlatform")=="darwin-arm64"];print(m[0] if m else "")' 2>/dev/null)
  if [ -n "$VSIXVER" ]; then
    VSIX_URL="https://marketplace.visualstudio.com/_apis/public/gallery/publishers/anthropic/vsextensions/claude-code/$VSIXVER/vspackage?targetPlatform=darwin-arm64"
    echo "  GET $VSIX_URL"
    # Marketplace отдаёт vspackage с Content-Encoding: gzip — --compressed распаковывает в валидный .vsix.
    curl -fsSL --compressed "$VSIX_URL" -o "$VSIX" || { rm -f "$VSIX"; echo "  ! VSIX недоступен — расширение поставится онлайн при установке"; }
  else
    echo "  ! Marketplace недоступен — VSIX пропущен (расширение поставится онлайн при установке)"
  fi
fi

echo "[vendor-mac] JetBrains Mono Regular (шрифт, лицензия OFL)..."
FONT="$APPS/JetBrainsMono-Regular.ttf"
if [ -s "$FONT" ]; then
  echo "  skip $(basename "$FONT")"
else
  # Официальный релиз JetBrains/JetBrainsMono — zip с fonts/ttf/*.ttf внутри.
  JBURL=$(curl -fsSL https://api.github.com/repos/JetBrains/JetBrainsMono/releases/latest | "$PY" -c 'import sys,json;A=[x["browser_download_url"] for x in json.load(sys.stdin).get("assets",[]) if x["name"].startswith("JetBrainsMono-") and x["name"].endswith(".zip")];print(A[0] if A else "")' 2>/dev/null)
  if [ -n "$JBURL" ]; then
    JBZIP="$APPS/_jbmono.zip"
    JBTMP="$APPS/_jbmono_extract"
    echo "  GET $JBURL"
    if curl -fsSL "$JBURL" -o "$JBZIP"; then
      rm -rf "$JBTMP"; mkdir -p "$JBTMP"
      unzip -q -o "$JBZIP" -d "$JBTMP" 2>/dev/null || echo "  ! zip не распаковался"
      JBTTF=$(find "$JBTMP" -type f -name 'JetBrainsMono-Regular.ttf' 2>/dev/null | head -n 1)
      [ -n "$JBTTF" ] && cp -f "$JBTTF" "$FONT"
      rm -rf "$JBTMP" "$JBZIP"
    else
      echo "  ! релиз JetBrains Mono не скачался"
    fi
  fi
  if [ ! -s "$FONT" ]; then
    # Фолбэк: raw-файл из репозитория (тот же OFL ttf).
    dl "https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Regular.ttf" "$FONT"
  fi
  if [ -s "$FONT" ]; then
    echo "  ok $(basename "$FONT")"
  else
    rm -f "$FONT"
    echo "  ! шрифт не скачался — extension поставится без шрифта (не критично)"
  fi
fi

echo "[vendor-mac] Python wheels (macosx, под bundled python 3.12)..."
WH="$ROOT/vendor/pywheels"; rm -rf "$WH"; mkdir -p "$WH"
REQ="$ROOT/vendor/config-pack/requirements.txt"
if [ -f "$REQ" ]; then
  "$PY" -m pip download pip setuptools wheel -d "$WH" >/dev/null 2>&1 || true
  "$PY" -m pip download -r "$REQ" pystray pillow -d "$WH" 2>&1 | tail -2
  echo "  wheels/sdists: $(ls "$WH" 2>/dev/null | wc -l | tr -d ' ')"
fi

echo "[vendor-mac] Playwright Chromium (mac)..."
PW="$ROOT/vendor/playwright-browsers"; mkdir -p "$PW"
"$PY" -m pip install --quiet playwright >/dev/null 2>&1 || true
PLAYWRIGHT_BROWSERS_PATH="$PW" "$PY" -m playwright install chromium >/dev/null 2>&1 || true

echo "[vendor-mac] Git: вшитый портативный dugite-native (офлайн, без Apple CLT-диалога)..."
# Пинним версию и SHA-256 (не 'latest' — иначе checksum поплывёт). dugite-native от
# GitHub Desktop: самодостаточный git, TLS через системный libcurl. arm64 + x64.
DUGITE_BASE="https://github.com/desktop/dugite-native/releases/download/v2.53.0-3"
dugite_get() {
  # ВАЖНО: раздельные local — под set -u forward-ссылка на $arch в одном local падает.
  local arch="$1" want="$2"
  local out="$APPS/git-macos-$arch.tar.gz"
  if [ -s "$out" ]; then echo "  skip git-macos-$arch.tar.gz"; return; fi
  echo "  GET dugite-native macOS-$arch"
  if curl -fsSL "$DUGITE_BASE/dugite-native-v2.53.0-f49d009-macOS-$arch.tar.gz" -o "$out"; then
    local got; got=$(shasum -a 256 "$out" | awk '{print $1}')
    if [ "$got" != "$want" ]; then
      echo "  ! SHA-256 git-macos-$arch НЕ совпал (ожидалось $want, получено $got) — удаляю."
      rm -f "$out"
    fi
  else
    echo "  ! dugite-native macOS-$arch не скачался — git на этой арх уйдёт в CLT-фолбэк."
  fi
}
dugite_get arm64 "e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437"
dugite_get x64   "caf27c36b8834969550535bcd5e58186f970e080d1e175e76d9c1de3aac409ed"
mkdir -p "$ROOT/vendor/licenses"
cat > "$ROOT/vendor/licenses/git-dugite-NOTICE.txt" <<'NOTICE'
Вшитый Git — сборка dugite-native (GitHub Desktop), git под лицензией GNU GPL v2.0.
Исходники: https://github.com/desktop/dugite-native  и  https://git-scm.com
Полный текст GPL-2.0: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
NOTICE

echo "[vendor-mac] checksums.json — SHA-256 всех файлов vendor/apps (целостность/доверие)..."
CHK="$ROOT/vendor/checksums.json"
{
  printf '{\n'
  printf '  "generatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "algorithm": "sha256",\n'
  printf '  "files": {\n'
  CHK_FIRST=1
  for f in "$APPS"/*; do
    [ -f "$f" ] || continue
    [ -s "$f" ] || continue
    CHK_SUM=$(shasum -a 256 "$f" | awk '{print $1}')
    CHK_SIZE=$(wc -c < "$f" | tr -d ' ')
    if [ "$CHK_FIRST" -eq 1 ]; then CHK_FIRST=0; else printf ',\n'; fi
    printf '    "%s": { "sha256": "%s", "bytes": %s }' "$(basename "$f")" "$CHK_SUM" "$CHK_SIZE"
  done
  printf '\n  }\n}\n'
} > "$CHK"
echo "  файлов захешировано: $(find "$APPS" -type f -size +0c 2>/dev/null | wc -l | tr -d ' ')"

echo "[vendor-mac] Проверка полноты vendor..."
MISSING=""
add_missing() { MISSING="$MISSING
  - $1"; }
chk_file() { [ -s "$1" ] || add_missing "$2"; }
chk_dir() { if [ -z "$(find "$1" -type f -size +0c 2>/dev/null | head -n 1)" ]; then add_missing "$2"; fi; }
chk_file "$APPS/python.pkg"       "apps/python.pkg"
chk_file "$APPS/node.pkg"         "apps/node.pkg"
chk_file "$APPS/cursor.dmg"       "apps/cursor.dmg"
chk_file "$APPS/claude-code.vsix" "apps/claude-code.vsix"
if [ ! -s "$APPS/amneziavpn.pkg" ] && [ ! -s "$APPS/amneziavpn.dmg" ]; then add_missing "apps/amneziavpn.pkg|dmg"; fi
chk_file "$APPS/git-macos-arm64.tar.gz" "apps/git-macos-arm64.tar.gz (вшитый git — иначе CLT-диалог)"
chk_dir "$ROOT/vendor/npm-cache"   "npm-cache/ (нет файлов)"
chk_dir "$ROOT/vendor/pywheels"    "pywheels/ (нет файлов)"
chk_dir "$ROOT/vendor/config-pack" "config-pack/ (нет файлов)"
if [ -n "$MISSING" ]; then
  echo ""
  echo "[vendor-mac] WARNING: неполный vendor — отсутствуют/пустые артефакты:$MISSING"
  echo "[vendor-mac] Установка на этих компонентах уйдёт в онлайн-фолбэк или упадёт."
else
  echo "[vendor-mac] OK: все ключевые артефакты на месте."
fi

echo "[vendor-mac] ГОТОВО: vendor = $(du -sh "$ROOT/vendor" 2>/dev/null | cut -f1)"
