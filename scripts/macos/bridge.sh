#!/usr/bin/env bash
# AI-мост (Hamidun Bridge) — macOS: агент + автозапуск (LaunchAgent, headless)
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
DRY="${HM_DRY_RUN:-}"

DST="$HOME/Library/Application Support/HamidunBridge"
AGENT="${HM_AGENT_DIR:-}/bridge_agent.py"
[ -f "$AGENT" ] || { echo "Агент моста не найден ($AGENT)."; exit 1; }

if [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: агент -> $DST, pip pystray pillow, LaunchAgent, ssh -D"
  echo "[dry-run] AI-мост: без изменений."; exit 0
fi

# Ищем РЕАЛЬНЫЙ интерпретатор — тот же приоритет, что и pydeps.sh (framework-Python,
# под который собраны wheels и агент). НИКОГДА не берём CLT-шим /usr/bin/python3 при
# НЕустановленных Command Line Tools (xcode-select -p не проходит): его запуск дёргает
# GUI-диалог CLT, TRAY_OK=0, pip/import падают, а прописанный в LaunchAgent с
# KeepAlive=true шим уводит launchd в бесконечный рестарт нерабочего интерпретатора +
# шторм CLT-диалогов — при этом печаталось бы «OK: AI-мост установлен». Фолбэк-guard
# `[ -x "$PY" ]` был мёртвым: шим всегда существует и исполним на чистом маке.
PY=""
for CAND in \
  "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"; do
  [ -x "$CAND" ] && { PY="$CAND"; break; }
done
if [ -z "$PY" ]; then
  P3="$(command -v python3 2>/dev/null || true)"
  # Принимаем python3 из PATH ТОЛЬКО если это НЕ CLT-шим /usr/bin/python3 без
  # установленных CLT. Реальный интерпретатор (Homebrew/framework) — или сам
  # /usr/bin/python3, но лишь когда CLT уже стоят (xcode-select -p проходит) —
  # запускается без GUI-диалога и годен для plist LaunchAgent.
  if [ -n "$P3" ] && [ -x "$P3" ] && { [ "$P3" != "/usr/bin/python3" ] || xcode-select -p >/dev/null 2>&1; }; then
    PY="$P3"
  fi
fi
[ -n "$PY" ] && [ -x "$PY" ] || { echo "Python3 не найден (CLT-шим /usr/bin/python3 без Command Line Tools не годится) — выберите компонент «Python-пакеты»."; exit 1; }

mkdir -p "$DST"
cp -f "$AGENT" "$DST/bridge_agent.py"

WH="${HM_VENDOR:-}/pywheels"
TRAY_OK=1
if [ -d "$WH" ]; then
  "$PY" -m pip install --user --break-system-packages --no-index --find-links "$WH" pystray pillow >/dev/null 2>&1 || TRAY_OK=0
else
  "$PY" -m pip install --user --break-system-packages pystray pillow >/dev/null 2>&1 || TRAY_OK=0
fi
# честная проверка: реально ли доступны модули трея (pip мог упасть на чужом Python)
if ! "$PY" -c "import pystray, PIL" >/dev/null 2>&1; then TRAY_OK=0; fi
if [ "$TRAY_OK" != "1" ]; then
  echo "  ВНИМАНИЕ: pystray/pillow не установились — значок в трее будет недоступен."
  echo "  Мост будет работать в фоне (headless) и включаться только по сохранённому состоянию/боту."
fi

CFG="$DST/config.json"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<EOF
{
  "enrollEndpoint": "${HM_BRIDGE_ENDPOINT:-}",
  "bridgeToken": "${HM_BRIDGE_TOKEN:-}",
  "ssh": { "host": "", "port": 22, "user": "", "keyPath": "", "password": "" },
  "socksPort": 1080, "httpPort": 1081, "pacPort": 1082,
  "pacDomains": ["claude.ai","anthropic.com","openai.com","chatgpt.com","oaistatic.com","oaiusercontent.com","claudeusercontent.com","sora.com","higgsfield.ai"],
  "enabled": false
}
EOF
elif [ -n "${HM_BRIDGE_ENDPOINT:-}" ]; then
  # config.json уже есть, но издатель пересобрал установщик с адресом сервера — доставляем
  # новый endpoint/token в существующий конфиг, сохраняя ssh/enabled ученика. Иначе агент
  # простаивал бы с пустым endpoint, хотя сообщение говорило бы «сервер настроен». perl всегда есть.
  EP="$HM_BRIDGE_ENDPOINT" TK="${HM_BRIDGE_TOKEN:-}" /usr/bin/perl -pi -e '
    s/("enrollEndpoint"\s*:\s*")[^"]*(")/$1.$ENV{EP}.$2/e;
    s/("bridgeToken"\s*:\s*")[^"]*(")/$1.$ENV{TK}.$2/e;
  ' "$CFG" 2>/dev/null || true
fi

LA="$HOME/Library/LaunchAgents/com.hamidun.bridge.plist"
mkdir -p "$HOME/Library/LaunchAgents"
# Если трей доступен — запускаем БЕЗ --headless: значок реально появляется в меню-баре
# и пользователь может включить мост. Если трея нет — --headless (уважает сохранённое
# enabled и мягко простаивает, системный прокси не трогает).
if [ "$TRAY_OK" = "1" ]; then
  MODE_ARG="<string>$DST/bridge_agent.py</string>"
else
  MODE_ARG="<string>$DST/bridge_agent.py</string><string>--headless</string>"
fi
# ПРОВЕРКА ЗАПУСКОМ до того, как отдать агента launchd. Причина: живой случай —
# на маке процесс съел 99% CPU и перегрел ноут. KeepAlive заставляет launchd
# поднимать агента заново ПОСЛЕ ЛЮБОЙ смерти, а если он падает сразу (нет модуля,
# битый конфиг, несовместимый Python), это превращается в бесконечный цикл
# «запустился — упал — запустился», и каждый оборот стоит полного старта Python.
# Ниже стоят ограничители, но сначала — просто не отдавать launchd заведомо
# нерабочего агента.
# ПЕРЕД пробой останавливаем СВОЙ уже работающий агент. Без этого проба обречена
# на любой машине, где мост уже стоит: агент держит эксклюзивный порт-замок
# 127.0.0.1:1079 (agent/bridge_agent.py, acquire_single_instance), и ВТОРОЙ
# экземпляр выходит немедленно с кодом 0. Раньше это читалось как «агент сломан»,
# и скрипт СНОСИЛ рабочий автозапуск, убивал живой мост и печатал «OK» — то есть
# повторная установка ломала работающий компонент под видом успеха.
HAD_LA=0
LA_BAK=""
if [ -f "$LA" ]; then
  HAD_LA=1
  LA_BAK="$(mktemp 2>/dev/null || echo "$DST/.la.bak")"
  cp "$LA" "$LA_BAK" 2>/dev/null || LA_BAK=""
  launchctl unload "$LA" 2>/dev/null || true
  sleep 2                     # даём ядру освободить порт-замок
fi

AGENT_OK=0
"$PY" -m py_compile "$DST/bridge_agent.py" >/dev/null 2>&1 && AGENT_OK=1
if [ "$AGENT_OK" = "1" ]; then
  # Живой прогон: агент обязан продержаться пару секунд, а не умереть на старте.
  # Намеренно --headless: проба не должна мигать значком в меню-баре во время
  # установки. Режим трея отличается только инициализацией значка.
  "$PY" "$DST/bridge_agent.py" --headless >/dev/null 2>&1 &
  PROBE_PID=$!
  sleep 3
  if kill -0 "$PROBE_PID" 2>/dev/null; then
    kill "$PROBE_PID" 2>/dev/null || true
    wait "$PROBE_PID" 2>/dev/null || true
  else
    AGENT_OK=0
  fi
fi
if [ "$AGENT_OK" != "1" ]; then
  echo "  ВНИМАНИЕ: агент моста не запускается на этой системе — новый автозапуск НЕ ставлю."
  echo "  (иначе система бесконечно перезапускала бы его и грела процессор)"
  # Чужой РАБОЧИЙ автозапуск не трогаем ни при каких условиях: наша проба не
  # смогла — это не повод ломать то, что у человека работало.
  if [ "$HAD_LA" = "1" ] && [ -n "$LA_BAK" ] && [ -f "$LA_BAK" ]; then
    cp "$LA_BAK" "$LA" 2>/dev/null || true
    launchctl load "$LA" 2>/dev/null || true
    echo "  Прежний автозапуск моста возвращён на место и снова загружен."
  fi
  [ -n "$LA_BAK" ] && rm -f "$LA_BAK" 2>/dev/null || true
  echo "OK: AI-мост распакован, новый автозапуск не ставился (агент не стартовал)"
  exit 0
fi
[ -n "$LA_BAK" ] && rm -f "$LA_BAK" 2>/dev/null || true

cat > "$LA" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hamidun.bridge</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string>$MODE_ARG</array>
  <key>RunAtLoad</key><true/>
  <!-- KeepAlive БЕЗ УСЛОВИЙ поднимал агента даже после того, как человек сам его
       закрыл, и после штатного выхода. SuccessfulExit=false = поднимаем только
       после АВАРИЙНОГО завершения. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <!-- Жёсткий предел частоты перезапусков. Значение по умолчанию (10 с) НЕ
       спасает: если агент прожил дольше него, launchd поднимает следующий
       экземпляр немедленно, и падающий раз в 15 секунд агент грузит процессор
       непрерывно. 300 с превращают худший случай в незаметный. -->
  <key>ThrottleInterval</key><integer>300</integer>
  <!-- Мост — фоновая мелочь, он не должен соревноваться за процессор с тем,
       что человек делает руками. -->
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
</dict></plist>
EOF
launchctl unload "$LA" 2>/dev/null || true
launchctl load "$LA" 2>/dev/null || true

# CLI-прокси: агент пишет cli_proxy.env, но сам его никто не подключает —
# идемпотентно добавляем source-строку в ~/.zshrc и ~/.bash_profile
# (маркер-комментарий защищает от дублей при повторной установке).
BRIDGE_RC_MARK="# Hamidun Bridge CLI proxy"
BRIDGE_RC_LINE='[ -f "$HOME/Library/Application Support/HamidunBridge/cli_proxy.env" ] && . "$HOME/Library/Application Support/HamidunBridge/cli_proxy.env" # Hamidun Bridge CLI proxy'
for RC in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  if [ -f "$RC" ] && grep -qF "$BRIDGE_RC_MARK" "$RC"; then
    : # уже подключено — не дублируем
  else
    # Свежесозданный ~/.bash_profile маскирует существующий ~/.profile (bash login
    # читает только ПЕРВЫЙ) → сначала подсеваем source ~/.profile, чтобы не потерять
    # PATH/env пользователя.
    if [ ! -e "$RC" ] && [ "$RC" = "$HOME/.bash_profile" ] && [ -f "$HOME/.profile" ]; then
      printf '[ -f "$HOME/.profile" ] && . "$HOME/.profile"\n' >> "$RC"
    fi
    printf '\n%s\n' "$BRIDGE_RC_LINE" >> "$RC"
  fi
  # P0-4: наша строка в этом rc-файле (по маркеру) — фиксируем владение в квитанции.
  if [ -f "$RC" ] && grep -qF "$BRIDGE_RC_MARK" "$RC"; then
    echo "HM-RECEIPT profileline $RC|$BRIDGE_RC_MARK"
  fi
done

# P0-4: квитанция владения — ТОЧНЫЕ пути созданных артефактов (main соберёт в receipt).
echo "HM-RECEIPT path $DST"
echo "HM-RECEIPT launchagent com.hamidun.bridge|$LA"

if [ "$TRAY_OK" = "1" ]; then TRAY_MSG="значок в меню-баре"; else TRAY_MSG="фоновый режим без значка"; fi
if [ -n "${HM_BRIDGE_ENDPOINT:-}" ]; then echo "OK: AI-мост установлен ($TRAY_MSG). Сервер настроен."
else echo "OK: AI-мост установлен ($TRAY_MSG). Сервер ещё не настроен — включится после доступа в боте."; fi
exit 0
