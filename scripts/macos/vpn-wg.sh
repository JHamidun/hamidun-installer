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
# Санитизируем: "name" из ответа сервера идёт в путь $HOME/Downloads/${NAME}.conf;
# без чистки '../' или '/' в нём дал бы запись за пределы Downloads (скомпрометированный
# сервер/MITM). Оставляем только безопасные символы, срезаем ведущие точки.
NAME=$(printf '%s' "$NAME" | tr -cd 'A-Za-z0-9._-')
NAME=${NAME#"${NAME%%[!.]*}"}
[ -n "$NAME" ] || NAME="hamidun"
# Разворачиваем \n/\t из JSON-строки в реальные переводы строк
CONF=$(printf '%b' "$CONF_RAW")
[ -z "$CONF" ] && { echo "Сервер не вернул конфиг."; exit 1; }

# Установить полный клиент AmneziaVPN (на macOS он включает поддержку AmneziaWG).
# Amnezia на macOS раздаётся как .pkg; поддерживаем и .pkg, и .dmg.
if [ ! -d "/Applications/AmneziaVPN.app" ]; then
  SRC=""
  BUNDLED=0
  if [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/amneziavpn.pkg" ]; then
    SRC="$HM_VENDOR/apps/amneziavpn.pkg"; BUNDLED=1; echo "AmneziaVPN из встроенного pkg (офлайн)..."
  elif [ -n "${HM_VENDOR:-}" ] && [ -f "$HM_VENDOR/apps/amneziavpn.dmg" ]; then
    SRC="$HM_VENDOR/apps/amneziavpn.dmg"; BUNDLED=1; echo "AmneziaVPN из встроенного dmg (офлайн)..."
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
    [ "$BUNDLED" = 1 ] && verify_artifact "$SRC"  # вшитый артефакт — сверяем SHA-256 (fail-closed)
    case "$SRC" in
      *.pkg)
        admin_run "installer -pkg '$SRC' -target /"
        ;;
      *.dmg)
        MNT="/tmp/hm_amnezia_mnt"
        hdiutil detach "$MNT" 2>/dev/null || true
        mkdir -p "$MNT"
        if hdiutil attach "$SRC" -nobrowse -mountpoint "$MNT" >/dev/null; then
          APP=$(/bin/ls "$MNT" | grep -i '\.app$' | head -1)
          [ -n "$APP" ] && admin_run "cp -R '$MNT/$APP' /Applications/"
          hdiutil detach "$MNT" >/dev/null 2>&1 || true
        fi
        ;;
    esac
  fi
fi

# На macOS авто-подхвата watched-папки нет — сохраняем конфиг и подсказываем импорт.
# Сохраняем СНАЧАЛА (enrollment не пропадает), потом честно проверяем, что клиент реально
# установился — иначе зелёная галка и совет «открой AmneziaVPN» указывали бы на несуществующее
# приложение (напр. если пользователь отменил ввод пароля администратора).
OUT="$HOME/Downloads/${NAME}.conf"
printf '%s' "$CONF" > "$OUT"
echo "Конфиг сохранён: $OUT"
if [ ! -d "/Applications/AmneziaVPN.app" ]; then
  echo "Клиент AmneziaVPN НЕ установился — повтори установку этого компонента или скачай приложение с amnezia.org, затем импортируй конфиг $OUT вручную."
  exit 1
fi
echo "Открой AmneziaVPN → '+' → 'Импорт из файла' и выбери $OUT"
exit 0
