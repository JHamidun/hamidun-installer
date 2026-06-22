#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

if [ -z "${HM_VPN_ENROLL_URL:-}" ]; then
  echo "VPN-сервер ещё не настроен (enrollEndpoint пуст) — пропускаю AmneziaVPN."
  exit 0
fi

if [ ! -d "/Applications/AmneziaVPN.app" ]; then
  echo "Скачиваю AmneziaVPN..."
  DMG="/tmp/amnezia.dmg"
  URL=$(curl -fsSL https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest \
    | /usr/bin/python3 -c 'import sys,json;a=[x["browser_download_url"] for x in json.load(sys.stdin)["assets"] if x["name"].lower().endswith(".dmg")];print(a[0] if a else "")')
  if [ -n "$URL" ]; then
    dl "$URL" "$DMG"
    MNT="/tmp/hm_amnezia_mnt"; mkdir -p "$MNT"
    hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null
    APP=$(/bin/ls "$MNT" | grep -i '\.app$' | head -1)
    admin_run "cp -R '$MNT/$APP' /Applications/"
    hdiutil detach "$MNT" >/dev/null || true
  fi
fi

echo "Запрашиваю код подключения (vpn://)..."
RESP=$(curl -fsSL -X POST -H 'Content-Type: application/json' \
  -d "{\"inviteCode\":\"${HM_INVITE_CODE:-}\",\"client\":\"$(hostname)\",\"format\":\"amnezia\"}" \
  "${HM_VPN_ENROLL_URL%/}${HM_VPN_ENROLL_PATH:-/enroll}" || true)
CODE=$(printf '%s' "$RESP" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin).get("vpnCode",""))' 2>/dev/null || true)
if [ -n "$CODE" ]; then
  OUT="$HOME/Desktop/amnezia-vpn-код.txt"
  printf '%s' "$CODE" > "$OUT"
  echo "Код сохранён: $OUT"
  echo "Открой AmneziaVPN → '+' → 'Вставить из буфера' и вставь код."
fi
exit 0
