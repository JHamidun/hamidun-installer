#!/usr/bin/env bash
# Исправления «на каждый запуск» (диспетчер, macOS) — близнец scripts/windows/_touchups.ps1.
#
# ЗАЧЕМ. Скрипт компонента запускается, только если компонент отмечен; у человека, который
# поставил его раньше, карточка на повторном запуске снята с галочки, и исправление внутри
# скрипта до него не доходит. Всё, что можно починить у УЖЕ установленного, живёт в
# scripts/macos/touchup-<имя>.sh; verify.sh (скрытый шаг, всегда последний, но стартует
# первым делом) зовёт их через hm_run_touchups, а кнопка «Проверить и починить» запускает
# один verify.
#
# КОНТРАКТ touch-up'а: самостоятельный скрипт; идемпотентный; быстрый и без сети (дольше
# 60 с его прерывают); трогает только профиль ТОГО ЖЕ пользователя; печатает «ОБНОВЛЕНО: …»
# только если что-то изменил. Исход прогон не красит: код выхода ребёнка не учитывается,
# а ошибка или таймаут превращаются в строку «[touchup-…] …» в журнале.
# Файлы берутся только из каталога самого verify.sh и по строгому имени touchup-<буквы-цифры-дефис>.sh.
# Здесь нет `exit`: это библиотека, её подключают через source.

hm_run_touchups() {
  local dir="$1" limit="${2:-60}" f name out pid waited line
  [ -d "$dir" ] || return 0
  for f in "$dir"/touchup-*.sh; do
    [ -f "$f" ] || continue
    name="$(basename "$f" .sh)"
    case "$name" in
      *[!A-Za-z0-9-]*) continue ;;   # строгое имя: только буквы, цифры и дефис
    esac
    out="$(mktemp "${TMPDIR:-/tmp}/hm-touchup.XXXXXX" 2>/dev/null)" || { echo "[$name] не запустился: нет временного файла"; continue; }
    /bin/bash "$f" >"$out" 2>&1 </dev/null &
    pid=$!
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$limit" ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      sleep 1
      kill -9 "$pid" 2>/dev/null
      echo "[$name] прервано: не уложился в ${limit} с"
    fi
    wait "$pid" 2>/dev/null
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$line" ] && echo "$line"
    done <"$out"
    rm -f "$out"
  done
  return 0
}
