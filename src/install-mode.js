'use strict';

// P0-1: АВТОРИТЕТНОЕ определение режима установки конфига (~/.claude) — ЧИСТЫЙ
// модуль (без electron), тестируемый. Решение принимает MAIN (не renderer):
// renderer-подсказка HM_ADDITIVE не может перевести установку в перезапись.
//
// Принцип fail-safe: при ЛЮБОЙ неопределённости (ошибка чтения ФС, EACCES, EIO,
// исключение) считаем, что пользовательские данные ЕСТЬ → additive. Перезапись
// свежей базой (clean) допускается ТОЛЬКО когда детекция УСПЕШНО доказала, что
// кастомизаций нет, ЛИБО пользователь ЯВНО выбрал repair И отдельно подтвердил.

const fs = require('fs');
const path = require('path');

// Признаки существующей кастомизации: ЛЮБОЙ из этих путей существует → additive.
function additiveProbes(homedir) {
  const ch = path.join(homedir, '.claude');
  return [
    path.join(ch, 'skills'),
    path.join(ch, 'agents'),
    path.join(ch, 'commands'),
    path.join(ch, 'rules'),
    path.join(ch, 'settings.json'),
    path.join(ch, '.credentials.master.env'),
    path.join(homedir, 'CLAUDE.md')
  ];
}

// Существует ли путь — с ЧЕСТНЫМ различением «нет» и «не смогли проверить».
// ТОЛЬКО genuine ENOENT → { exists:false }. ЛЮБАЯ другая ошибка (EACCES, EIO,
// ELOOP, ENOTDIR…) → { error } — вызывающий обязан трактовать как «возможно есть»
// (fail-safe → additive). ENOTDIR намеренно НЕ считается «нет»: файл на месте
// каталога — аномалия, при которой clean-перезапись небезопасна.
function probePath(p) {
  try {
    fs.statSync(p);
    return { exists: true };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false };
    return { exists: false, error: (e && e.code) || String(e) };
  }
}

// Детекция режима. ВСЕГДА возвращает объект (не бросает):
//   { additive: bool, reason: string }
// additive=true, если существует ЛЮБОЙ probe ИЛИ детекция не смогла отработать.
function detectAdditive(homedir) {
  try {
    if (!homedir) return { additive: true, reason: 'no-homedir (fail-safe)' };
    let unsure = '';
    for (const p of additiveProbes(homedir)) {
      const r = probePath(p);
      if (r.exists) return { additive: true, reason: p };
      if (r.error && !unsure) unsure = p + ' (' + r.error + ')';
    }
    if (unsure) return { additive: true, reason: 'probe-error: ' + unsure + ' (fail-safe)' };
    return { additive: false, reason: 'кастомизации не обнаружены' };
  } catch (e) {
    return { additive: true, reason: 'detect-error: ' + String(e && e.message || e) + ' (fail-safe)' };
  }
}

// Есть ли id в comma-separated списке (как в HM_REPAIR / HM_REPAIR_CONFIRMED).
function listHas(csv, id) {
  if (!csv || !id) return false;
  return String(csv).split(',').map((s) => s.trim()).indexOf(id) !== -1;
}

// Итоговое решение: 'additive' | 'clean'.
//   detection       — результат detectAdditive (null/undefined → fail-safe additive)
//   repairRequested — пользователь ЯВНО включил «Переустановить начисто» для config
//   repairConfirmed — и ОТДЕЛЬНО подтвердил перезапись (диалог)
// clean разрешён ТОЛЬКО когда: детекция доказала отсутствие кастомизаций, ЛИБО
// (repairRequested И repairConfirmed) одновременно. Всё прочее → additive.
function decideConfigMode(detection, repairRequested, repairConfirmed) {
  const additive = !detection || detection.additive !== false; // сбой детекции → additive
  if (!additive) return 'clean';
  return (repairRequested === true && repairConfirmed === true) ? 'clean' : 'additive';
}

module.exports = { additiveProbes, probePath, detectAdditive, listHas, decideConfigMode };
