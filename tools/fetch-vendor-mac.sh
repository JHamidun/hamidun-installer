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

echo "[vendor-mac] VS Code (рекомендуемый редактор, darwin-universal zip — офлайн)..."
# Редирект на актуальный .zip с 'Visual Studio Code.app' внутри; curl -L следует за ним.
dl "https://update.code.visualstudio.com/latest/darwin-universal/stable" "$APPS/vscode.zip"

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

echo "[vendor-mac] Codex VSIX (openai.chatgpt из Open VSX, офлайн — Codex прямо в VS Code)..."
CXVSIX="$APPS/chatgpt.vsix"
if [ -f "$CXVSIX" ]; then
  echo "  skip $(basename "$CXVSIX")"
else
  # Open VSX отдаёт метаданные последней версии с прямой ссылкой files.download на .vsix.
  CXURL=$(curl -fsSL -m 60 "https://open-vsx.org/api/openai/chatgpt/latest" | "$PY" -c 'import sys,json;print(json.load(sys.stdin).get("files",{}).get("download",""))' 2>/dev/null)
  if [ -n "$CXURL" ]; then dl "$CXURL" "$CXVSIX"; else echo "  ! Open VSX недоступен — Codex поставится онлайн при установке"; fi
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
  # $1=arch(arm64|x64) $2=ожидаемый sha256
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
# GPLv2-комплаенс: вкладываем текст лицензии + ссылки на исходники.
mkdir -p "$ROOT/vendor/licenses"
cat > "$ROOT/vendor/licenses/git-dugite-NOTICE.txt" <<'NOTICE'
Вшитый Git — сборка dugite-native (GitHub Desktop), git под лицензией GNU GPL v2.0.
Исходники: https://github.com/desktop/dugite-native  и  https://git-scm.com
Полный текст GPL-2.0: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
NOTICE

echo "[vendor-mac] Скрепка Claude (маскот, arm64 .app — подписан + нотаризован)..."
# Тянем ПОДПИСАННУЮ+НОТАРИЗОВАННУЮ .app-сборку скрепки из публичного релиза
# claude-mascot-macos-ci (репозиторий public → без токена). URL переопределяется через
# HM_MASCOT_MAC_URL. Идемпотентно: пропускаем, если .app уже лежит в vendor.
MASCOT_DIR="$APPS/claude-mascot"
MASCOT_APP="$(find "$MASCOT_DIR" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n1)"
if [ -n "$MASCOT_APP" ] && [ -d "$MASCOT_APP" ]; then
  echo "  skip $(basename "$MASCOT_APP") (уже в vendor)"
else
  mkdir -p "$MASCOT_DIR"
  MURL="${HM_MASCOT_MAC_URL:-}"
  if [ -z "$MURL" ]; then
    MURL=$(curl -fsSL -m 60 "https://api.github.com/repos/JHamidun/claude-mascot-macos-ci/releases?per_page=15" \
      | "$PY" -c 'import sys,json
u=""
try:
  for r in json.load(sys.stdin):
    for a in r.get("assets",[]):
      if a.get("name","").endswith(".app.zip"): u=a["browser_download_url"]; break
    if u: break
except Exception: pass
print(u)' 2>/dev/null)
  fi
  if [ -n "$MURL" ]; then
    MZIP="$MASCOT_DIR/_mascot.app.zip"
    echo "  GET $MURL"
    if curl -fsSL -m 600 "$MURL" -o "$MZIP"; then
      # ditto (НЕ unzip!): сохраняет символлинки/xattr/подпись бандла — unzip ломает code signature.
      ditto -x -k "$MZIP" "$MASCOT_DIR" 2>/dev/null || echo "  ! .app.zip не распаковался (ditto)"
      rm -f "$MZIP"
      MASCOT_APP="$(find "$MASCOT_DIR" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n1)"
    else
      echo "  ! скрепка не скачалась ($MURL)"
    fi
  else
    echo "  ! не нашёл .app.zip в релизах claude-mascot-macos-ci (задай HM_MASCOT_MAC_URL)"
  fi
  if [ -n "${MASCOT_APP:-}" ] && [ -d "$MASCOT_APP" ]; then
    # Ранний сигнал (только подпись; полный fail-closed гейт с TeamID и нотаризацией — ниже).
    if codesign --verify --deep --strict "$MASCOT_APP" >/dev/null 2>&1; then
      echo "  ok $(basename "$MASCOT_APP") (подпись цела — codesign --verify)"
    else
      echo "  ! ВНИМАНИЕ: codesign --verify не подтвердил подпись скрепки"
    fi
  fi
fi

echo "[vendor-mac] Исходник Nomad → vendor/nomad-src (git archive, БЕЗ .git; vendor-only установка)..."
# Компонент Nomad объявлен? На локальной машине: git archive из HM_NOMAD_AGENT_REPO.
# На GitHub-раннере (нет локального репо): git clone --depth 1 из NOMAD_AGENT_GIT_URL
#   (приватный репо → URL со встроенным токеном, напр. https://x:${TOKEN}@github.com/OWNER/nomad-agent.git).
# nomad-src приватный, в git НЕ коммитится (.gitignore vendor/*). Нет исходника →
# компонент Nomad у пользователя выполнит graceful skip (exit 120) — сборку НЕ валим (WARNING).
if grep -q '"nomad"' "$ROOT/components.json" 2>/dev/null; then
  AGENT_REPO="${HM_NOMAD_AGENT_REPO:-/c/Vibecode/hamidun-agent}"
  NOMAD_REF="${HM_NOMAD_REF:-main}"
  GITURL="${NOMAD_AGENT_GIT_URL:-}"
  SRCOUT="$ROOT/vendor/nomad-src"
  rm -rf "$SRCOUT"; mkdir -p "$SRCOUT"
  if [ -d "$AGENT_REPO/.git" ]; then
    echo "  git archive $NOMAD_REF из локального репо $AGENT_REPO"
    git -C "$AGENT_REPO" archive --format=tar "$NOMAD_REF" | tar -x -C "$SRCOUT"
  elif [ -n "$GITURL" ]; then
    echo "  git clone --depth 1 -b $NOMAD_REF <NOMAD_AGENT_GIT_URL> (раннер без локального репо)"
    TMPC="$(mktemp -d)"
    if git clone --depth 1 -b "$NOMAD_REF" "$GITURL" "$TMPC" 2>/dev/null || git clone --depth 1 "$GITURL" "$TMPC"; then
      (cd "$TMPC" && git archive --format=tar HEAD) | tar -x -C "$SRCOUT"
      rm -rf "$TMPC"
    else
      echo "  ! git clone не удался — проверь NOMAD_AGENT_GIT_URL/токен. Компонент Nomad → graceful skip."
      rm -rf "$TMPC"
    fi
  else
    echo "  ! нет локального репо ($AGENT_REPO) и не задан NOMAD_AGENT_GIT_URL — nomad-src НЕ вшит (компонент Nomad → graceful skip)."
  fi
  if [ -f "$SRCOUT/pyproject.toml" ]; then
    echo "  ok vendor/nomad-src (pyproject.toml на месте)"
  else
    echo "  ! в vendor/nomad-src нет pyproject.toml — компонент Nomad у пользователя выполнит graceful skip."
  fi
else
  echo "  (компонент nomad не объявлен в components.json — пропускаю nomad-src)"
fi

echo "[vendor-mac] checksums.json — SHA-256 всех файлов vendor/apps (целостность/доверие)..."
CHK="$ROOT/vendor/checksums.json"
{
  printf '{\n'
  printf '  "generatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "algorithm": "sha256",\n'
  printf '  "files": {\n'
  CHK_FIRST=1
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    [ -s "$f" ] || continue
    CHK_SUM=$(shasum -a 256 "$f" | awk '{print $1}')
    CHK_SIZE=$(wc -c < "$f" | tr -d ' ')
    if [ "$CHK_FIRST" -eq 1 ]; then CHK_FIRST=0; else printf ',\n'; fi
    printf '    "%s": { "sha256": "%s", "bytes": %s }' "$(basename "$f")" "$CHK_SUM" "$CHK_SIZE"
  done < <(
    find "$APPS" -maxdepth 1 -type f
    # Главный бинарь скрепки лежит ВНУТРИ .app — Confirm/verify_artifact ищет по basename,
    # путь не важен (как -Recurse в Windows-манифесте).
    find "$APPS/claude-mascot" -type f -path '*/Contents/MacOS/*' 2>/dev/null
  )
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
chk_file "$APPS/vscode.zip"       "apps/vscode.zip (рекомендуемый редактор — иначе компонент VS Code пропустится)"
chk_file "$APPS/claude-code.vsix" "apps/claude-code.vsix"
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

# Курсовое издание: архив симулятора ОБЯЗАН быть в vendor/course — без него компонент
# «Курс интенсива» падает у КАЖДОГО покупателя. Валим сборку сразу, а не пользователя.
# (Архив трекается в git — см. исключение !vendor/course/ в .gitignore.)
if grep -q '"course"' "$ROOT/components.json" 2>/dev/null; then
  if [ ! -s "$ROOT/vendor/course/vibecoding-course.zip" ]; then
    echo "[vendor-mac] FATAL: нет vendor/course/vibecoding-course.zip — курс-симулятор покупательского издания не попадёт в сборку."
    exit 1
  fi
  echo "[vendor-mac] OK: курс-симулятор на месте (vendor/course/vibecoding-course.zip)."
fi

# Скрепка: если компонент «mascot» объявлен в components.json — .app ОБЯЗАНА лежать в
# vendor целой, подписанной нашим Team ID и нотаризованной (FATAL, как в Windows
# fetch-vendor.ps1). Транзиентный сетевой сбой честно валит mac-сборку, а не отгружает
# dmg с нерабочим компонентом: mascot.sh у пользователя всё равно делает hard exit 1
# без валидной .app — «пропуска компонента» при установке НЕ существует.
MASCOT_TEAM_ID="3VN93XA9DY"
mascot_fatal() {
  echo "[vendor-mac] FATAL: Скрепка: $1 — задай HM_MASCOT_MAC_URL или убери компонент mascot из components.json."
  exit 1
}
# Гейт по СТРУКТУРЕ components.json (как его читает renderer), не по подстроке:
# случайная строка "mascot" в описании не должна валить билд, а реально объявленный
# компонент — обязан ловиться.
if "$PY" -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        d = json.load(f)
except Exception:
    sys.exit(1)
ok = any(c.get("id") == "mascot"
         for g in d.get("groups", [])
         for c in g.get("components", []))
sys.exit(0 if ok else 1)
' "$ROOT/components.json" 2>/dev/null; then
  GATE_APP="$(find "$APPS/claude-mascot" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n1)"
  if [ -z "$GATE_APP" ] || [ ! -d "$GATE_APP" ]; then
    mascot_fatal "нет vendor/apps/claude-mascot/*.app (не скачалась)"
  fi
  # Главный бинарь — ИМЕННО CFBundleExecutable из Info.plist, не «первый файл в
  # Contents/MacOS»: sha256-пин обязан указывать на реально запускаемый бинарь.
  GATE_PLIST="$GATE_APP/Contents/Info.plist"
  if [ ! -f "$GATE_PLIST" ]; then
    mascot_fatal "в .app нет Contents/Info.plist"
  fi
  GATE_BIN=""
  if [ -x /usr/libexec/PlistBuddy ]; then
    GATE_BIN="$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$GATE_PLIST" 2>/dev/null || true)"
  fi
  if [ -z "$GATE_BIN" ]; then
    GATE_BIN="$(defaults read "$GATE_APP/Contents/Info" CFBundleExecutable 2>/dev/null || true)"
  fi
  if [ -z "$GATE_BIN" ]; then
    mascot_fatal "в Info.plist нет ключа CFBundleExecutable"
  fi
  GATE_BIN_PATH="$GATE_APP/Contents/MacOS/$GATE_BIN"
  if [ ! -f "$GATE_BIN_PATH" ] || [ ! -x "$GATE_BIN_PATH" ]; then
    mascot_fatal "главный бинарь из CFBundleExecutable не найден или не исполняем (Contents/MacOS/$GATE_BIN)"
  fi
  if ! file "$GATE_BIN_PATH" 2>/dev/null | grep -q "Mach-O"; then
    mascot_fatal "главный бинарь не является Mach-O (Contents/MacOS/$GATE_BIN)"
  fi
  # Подпись цела (codesign проверяет ТОЛЬКО подпись — нотаризацию подтверждаем отдельно ниже).
  if ! codesign --verify --deep --strict "$GATE_APP" >/dev/null 2>&1; then
    mascot_fatal "подпись .app не прошла codesign --verify --deep --strict"
  fi
  # Пин издателя: TeamID сравниваем ТОЧНО (извлекаем значение), не подстрокой —
  # grep -q поймал бы и TeamIdentifier=${MASCOT_TEAM_ID}EVIL.
  GATE_TEAM="$(codesign -dv --verbose=4 "$GATE_APP" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -n1)"
  if [ "$GATE_TEAM" != "$MASCOT_TEAM_ID" ]; then
    mascot_fatal "TeamIdentifier='${GATE_TEAM:-нет}' не равен $MASCOT_TEAM_ID (подписано чужим Developer ID)"
  fi
  # Нотаризация: staple-тикет (офлайн) или вердикт Gatekeeper (spctl). На раннере есть оба.
  MASCOT_NOTAR_OK=0
  if command -v xcrun >/dev/null 2>&1 && xcrun stapler validate "$GATE_APP" >/dev/null 2>&1; then MASCOT_NOTAR_OK=1; fi
  if [ "$MASCOT_NOTAR_OK" = "0" ] && command -v spctl >/dev/null 2>&1 && spctl --assess --type execute -vv "$GATE_APP" >/dev/null 2>&1; then MASCOT_NOTAR_OK=1; fi
  if [ "$MASCOT_NOTAR_OK" != "1" ]; then
    mascot_fatal "нотаризация не подтверждена (stapler validate и spctl --assess оба не прошли)"
  fi
  # Целостность на установке: главный бинарь обязан быть в манифесте checksums.json.
  if ! grep -Fq "\"$GATE_BIN\":" "$CHK" 2>/dev/null; then
    mascot_fatal "в checksums.json нет записи для '$GATE_BIN'"
  fi
  echo "[vendor-mac] OK: скрепка на месте ($(basename "$GATE_APP") — подпись Developer ID $MASCOT_TEAM_ID + нотаризация подтверждены)."
fi

echo "[vendor-mac] ГОТОВО: vendor = $(du -sh "$ROOT/vendor" 2>/dev/null | cut -f1)"
