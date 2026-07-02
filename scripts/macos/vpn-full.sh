#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

if [ -z "${HM_VPN_ENROLL_URL:-}" ]; then
  echo "VPN-сервер ещё не настроен (enrollEndpoint пуст) — пропускаю AmneziaVPN."
  exit 0
fi

# AmneziaVPN на macOS раздаётся как .pkg; поддерживаем и .pkg, и .dmg.
if [ ! -d "/Applications/AmneziaVPN.app" ]; then
  SRC=""
  if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/amneziavpn.pkg" ]; then
    SRC="$HM_VENDOR/apps/amneziavpn.pkg"; echo "AmneziaVPN из встроенного pkg (офлайн)..."
  elif [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/amneziavpn.dmg" ]; then
    SRC="$HM_VENDOR/apps/amneziavpn.dmg"; echo "AmneziaVPN из встроенного dmg (офлайн)..."
  else
    echo "Скачиваю AmneziaVPN..."
    # .pkg приоритетнее .dmg; без python3 (не дёргаем CLT-диалог).
    URL=$(curl -fsSL https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest \
      | grep -ioE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.(pkg|dmg)"' \
      | sed 's/.*"\([^"]*\)"$/\1/' | grep -i '\.pkg$' | head -n1 || true)
    [ -n "$URL" ] || URL=$(curl -fsSL https://api.github.com/repos/amnezia-vpn/amnezia-client/releases/latest \
      | grep -ioE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.dmg"' | head -n1 \
      | sed 's/.*"\([^"]*\)"$/\1/' || true)
    if [ -n "$URL" ]; then
      case "$URL" in *.pkg) SRC="/tmp/amnezia.pkg" ;; *) SRC="/tmp/amnezia.dmg" ;; esac
      dl "$URL" "$SRC"
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

echo "Запрашиваю код подключения (vpn://)..."
RESP=$(curl -fsSL -X POST -H 'Content-Type: application/json' \
  -d "{\"inviteCode\":\"${HM_INVITE_CODE:-}\",\"client\":\"$(hostname)\",\"format\":\"amnezia\"}" \
  "${HM_VPN_ENROLL_URL%/}${HM_VPN_ENROLL_PATH:-/enroll}" || true)
# Парсим без python3 (не дёргаем CLT-диалог); vpnCode — плоская строка без кавычек внутри.
CODE=$(printf '%s\n' "$RESP" | sed -n 's/.*"vpnCode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)
if [ -n "$CODE" ]; then
  OUT="$HOME/Desktop/amnezia-vpn-код.txt"
  printf '%s' "$CODE" > "$OUT"
  echo "Код сохранён: $OUT"
  echo "Открой AmneziaVPN → '+' → 'Вставить из буфера' и вставь код."
fi
exit 0
