#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

if [ -z "${HM_VPN_ENROLL_URL:-}" ]; then
  echo "VPN-сервер ещё не настроен (enrollEndpoint пуст в config.json) — пропускаю."
  echo "Когда купишь сервер: впиши адрес в config.json и пересобери установщик."
  exit 0
fi

echo "Запрашиваю персональный VPN-конфиг..."
RESP=$(curl -fsSL -X POST -H 'Content-Type: application/json' \
  -d "{\"inviteCode\":\"${HM_INVITE_CODE:-}\",\"client\":\"$(hostname)\",\"format\":\"amneziawg\"}" \
  "${HM_VPN_ENROLL_URL%/}${HM_VPN_ENROLL_PATH:-/enroll}")
# Ожидаемый ответ: {"config":"<текст .conf>","name":"hamidun"}
CONF=$(printf '%s' "$RESP" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin).get("config",""))')
NAME=$(printf '%s' "$RESP" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin).get("name","hamidun"))')
[ -z "$CONF" ] && { echo "Сервер не вернул конфиг."; exit 1; }

# Установить полный клиент AmneziaVPN (на macOS он включает поддержку AmneziaWG)
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
  else
    echo "Не нашёл .dmg в релизах — скачайте вручную с amnezia.org."
  fi
fi

# На macOS авто-подхвата watched-папки нет — сохраняем конфиг и подсказываем импорт.
OUT="$HOME/Downloads/${NAME}.conf"
printf '%s' "$CONF" > "$OUT"
echo "Конфиг сохранён: $OUT"
echo "Открой AmneziaVPN → '+' → 'Импорт из файла' и выбери $OUT"
exit 0
