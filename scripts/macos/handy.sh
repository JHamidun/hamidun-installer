#!/bin/bash
# Handy — голосовой ввод (speech-to-text), macOS
#
# Handy (github.com/cjpais/Handy, MIT) — локальное распознавание речи: зажал хоткей,
# продиктовал, текст вставился в активное поле. Ничего не уходит в облако.
#
# ФАКТЫ, на которых построен этот скрипт (проверены, не предположены):
#   • Релиз даёт ДВА арх-специфичных dmg (aarch64 и x64), НЕ universal — поэтому берём
#     по arch_tag, как для uv.
#   • Бандл подписан Developer ID и нотаризован. Снято зондом
#     .github/workflows/probe-handy-teamid.yml на macOS-раннере с ОФИЦИАЛЬНОГО релиза
#     v0.9.4, обе архитектуры:
#         Identifier=com.pais.handy
#         Authority=Developer ID Application: Christopher Pais (UWFLB4GC25)
#         TeamIdentifier=UWFLB4GC25
#         spctl: accepted, source=Notarized Developer ID
#         stapler validate: The validate action worked!
#     Отсюда пин ниже. Если Handy когда-нибудь переподпишут другим Team ID, гейт даст
#     fail-closed отказ — это правильный исход (лучше не поставить, чем поставить
#     неподтверждённое); тогда перезапустить зонд и обновить пин.
#   • МОДЕЛЬ РАСПОЗНАВАНИЯ В DMG НЕ ВХОДИТ и сама не качается: внутри только VAD,
#     загрузка стартует после выбора пользователем в onboarding.
#   • Accessibility и микрофон на macOS выдать скриптом НЕЛЬЗЯ (база TCC под SIP,
#     программно это умеют только MDM-профили). Значит два ручных шага неизбежны —
#     честно говорим об этом, а не делаем вид, что «поставили и работает».
set -uo pipefail
. "$(dirname "$0")/_lib.sh"   # arch_tag, admin_run, verify_artifact, HM_APP_INSTALL_SH

DRY="${HM_DRY_RUN:-}"
APP_PATH="/Applications/Handy.app"
DATA_DIR="$HOME/Library/Application Support/com.pais.handy"
STORE="$DATA_DIR/settings_store.json"

# Пин издателя — см. шапку. Снят с официального релиза, не угадан.
HANDY_TEAM_ID='UWFLB4GC25'

echo "Проверяю Handy (голосовой ввод)..."
if [ -d "$APP_PATH" ]; then
  echo "Handy уже установлен: $APP_PATH"
  if [ -z "$DRY" ]; then
    echo "HM-RECEIPT path $APP_PATH"
    exit 0
  fi
fi

DMG=""
if [ -n "${HM_VENDOR:-}" ]; then
  CAND="$HM_VENDOR/apps/handy-macos-$(arch_tag).dmg"
  [ -f "$CAND" ] && DMG="$CAND"
fi

if [ -n "$DRY" ]; then
  if [ -n "$DMG" ]; then
    echo "  [dry-run] WOULD: установить Handy из $DMG (проверка подписи, Team ID $HANDY_TEAM_ID)"
  else
    echo "  [dry-run] WOULD: dmg Handy не вшит — компонент был бы пропущен (exit 120)"
  fi
  echo "  [dry-run] WOULD: пре-сид $STORE (язык ru, история 1000, хранение months3) — ТОЛЬКО если файла нет"
  echo "[dry-run] Handy: без изменений."
  exit 0
fi

if [ -z "$DMG" ]; then
  # Онлайн-фолбэка нет намеренно: качать бандл мимо sha-проверенного канала и ставить
  # его в /Applications — ровно тот класс риска, который закрыт у прочих компонентов.
  echo "Установщик Handy не найден в наборе — пропускаю компонент (это не ошибка)."
  echo "  Поставить вручную: https://handy.computer"
  exit 120
fi

verify_artifact "$DMG"   # вшитый артефакт — sha-256 из checksums.json, fail-closed

MNT="/tmp/hm_handy_mnt"
/usr/bin/hdiutil detach "$MNT" 2>/dev/null || true
mkdir -p "$MNT"
if ! /usr/bin/hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null; then
  echo "Не смог открыть образ Handy (dmg повреждён?)."; exit 1
fi
APP=$(/bin/ls "$MNT" | grep -i '\.app$' | head -1)
if [ -z "$APP" ]; then
  echo "В образе Handy не найдено приложение (.app)."
  /usr/bin/hdiutil detach "$MNT" >/dev/null 2>&1 || true
  exit 1
fi

# Проверка подписи и копирование — ОДНОЙ операцией под root на root-owned staged копии
# (тот же примитив, что у Cursor): между verify и cp нет окна, в которое процесс того же
# пользователя мог бы подменить .app на смонтированном образе.
echo "Проверяю подпись и копирую $APP в /Applications (потребуется пароль администратора)..."
if ! admin_run /bin/sh -c "$HM_APP_INSTALL_SH" hm_app_install "$MNT/$APP" "$HANDY_TEAM_ID" "$APP"; then
  echo "Handy: подпись/нотаризация не подтверждены или копирование не удалось (fail-closed)."
  /usr/bin/hdiutil detach "$MNT" >/dev/null 2>&1 || true
  exit 1
fi
/usr/bin/hdiutil detach "$MNT" >/dev/null 2>&1 || true

if [ ! -d "$APP_PATH" ]; then
  echo "Копирование прошло, но $APP_PATH не появился — считаю установку неудачной."
  exit 1
fi
echo "OK: Handy установлен ($APP_PATH)"

# --- Пре-сид настроек: только если пользователь ещё ничего не настраивал ---
# Дефолты Handy: history_limit = 5 записей, recording_retention_period = preserve_limit
# (аудио живёт ровно столько же) — вчерашняя диктовка уже недоступна. Ставим максимум,
# который он поддерживает. Хоткей на macOS по умолчанию alt+space; оставляем его —
# конфликта с переключением раскладки, как у ctrl+space на Windows, здесь нет.
if [ -f "$STORE" ]; then
  echo "  Настройки Handy уже есть — не трогаю ($STORE)"
else
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  TMP="$STORE.tmp"
  cat > "$TMP" <<'JSON'
{
  "settings": {
    "selected_language": "ru",
    "history_limit": 1000,
    "recording_retention_period": "months3"
  }
}
JSON
  if [ -s "$TMP" ] && mv -f "$TMP" "$STORE" 2>/dev/null; then
    echo "  Пред-настроено: язык распознавания «русский», история диктовок — 1000 записей"
  else
    rm -f "$TMP" 2>/dev/null || true
    echo "  Пред-настройку записать не удалось — Handy запустится с настройками по умолчанию."
  fi
fi

echo ""
echo "ЧТО СДЕЛАТЬ ПОСЛЕ УСТАНОВКИ (один раз, ~3 минуты):"
echo "  1. Запусти Handy из «Программ» — откроется выбор модели распознавания."
echo "  2. Выбери «Parakeet TDT 0.6B v3» — около 705 МБ."
echo "     Это лучший выбор для русского: точность как у самых тяжёлых моделей,"
echo "     но работает вдвое быстрее них."
echo "     Жалко трафика? «Whisper Small» — 257 МБ, точность чуть ниже."
echo "     ВНИМАНИЕ: не путай с «Parakeet Unified EN» (обычно стоит ПЕРВЫМ в списке) —"
echo "     вот он русский НЕ понимает. Нужен именно тот, где в названии «v3»."
echo "  3. Дождись загрузки модели — она качается ОДИН раз и дальше работает без интернета."
echo "  4. macOS попросит ДВА разрешения — их обязан выдать ты сам, программа этого"
echo "     сделать не может (так устроена защита macOS):"
echo "       • Микрофон — чтобы слышать речь;"
echo "       • Универсальный доступ (Accessibility) — чтобы ловить горячую клавишу"
echo "         и вставлять текст в активное окно."
echo "     Обе кнопки Handy покажет сам, нужно только подтвердить."
echo "Дальше: зажми Alt+Пробел, продиктуй — текст вставится сам."

echo "HM-RECEIPT path $APP_PATH"
exit 0
