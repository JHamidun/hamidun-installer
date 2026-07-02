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
# Ожидаемый ответ: {"config":"<текст .conf с \n-экранированием>","name":"hamidun"}
# Парсим без python3: bare /usr/bin/python3 на чистом mac без CLT дёргает GUI-диалог установки.
CONF_RAW=$(printf '%s\n' "$RESP" | sed -n 's/.*"config"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)
NAME=$(printf '%s\n' "$RESP" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)
[ -n "$NAME" ] || NAME="hamidun"
# Разворачиваем \n/\t из JSON-строки в реальные переводы строк
CONF=$(printf '%b' "$CONF_RAW")
[ -z "$CONF" ] && { echo "Сервер не вернул конфиг."; exit 1; }

# Установить полный клиент AmneziaVPN (на macOS он включает поддержку AmneziaWG).
# Amnezia на macOS раздаётся как .pkg; поддерживаем и .pkg, и .dmg.
if [ ! -d "/Applications/AmneziaVPN.app" ]; then
  SRC=""
  if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/amneziavpn.pkg" ]; then
    SRC="$HM_VENDOR/apps/amneziavpn.pkg"; echo "AmneziaVPN из встроенного pkg (офлайн)..."
  elif [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/amneziavpn.dmg" ]; then
    SRC="$HM_VENDOR/apps/amneziavpn.dmg"; echo "AmneziaVPN из встроенного dmg (офлайн)..."
  else
    echo "Скачиваю AmneziaVPN..."
    # .pkg приоритетнее .dmg; без python3 (не дёргаем CLT-диалог). BSD grep -E для (pkg|dmg).
    URL=$(curl -fsSL https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest \
      | grep -ioE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.(pkg|dmg)"' \
      | sed 's/.*"\([^"]*\)"$/\1/' | sort | grep -i '\.pkg$' | head -n1 || true)
    [ -n "$URL" ] || URL=$(curl -fsSL https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest \
      | grep -ioE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.dmg"' | head -n1 \
      | sed 's/.*"\([^"]*\)"$/\1/' || true)
    if [ -n "$URL" ]; then
      case "$URL" in *.pkg) SRC="/tmp/amnezia.pkg" ;; *) SRC="/tmp/amnezia.dmg" ;; esac
      dl "$URL" "$SRC"
    else
      echo "Не нашёл установщик в релизах — скачайте вручную с amnezia.org."
    fi
  fi
  if [ -n "$SRC" ] && [ -f "$SRC" ]; then
    case "$SRC" in
      *.pkg)
        admin_run "installer -pkg '$SRC' -target /"
        ;;
      *.dmg)
        MNT="/tmp/hm_amnezia_mnt"; mkdir -p "$MNT"
        hdiutil attach "$SRC" -nobrowse -mountpoint "$MNT" >/dev/null
        APP=$(/bin/ls "$MNT" | grep -i '\.app$' | head -1)
        admin_run "cp -R '$MNT/$APP' /Applications/"
        hdiutil detach "$MNT" >/dev/null || true
        ;;
    esac
  fi
fi

# На macOS авто-подхвата watched-папки нет — сохраняем конфиг и подсказываем импорт.
OUT="$HOME/Downloads/${NAME}.conf"
printf '%s' "$CONF" > "$OUT"
echo "Конфиг сохранён: $OUT"
echo "Открой AmneziaVPN → '+' → 'Импорт из файла' и выбери $OUT"
exit 0
