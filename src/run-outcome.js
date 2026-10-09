'use strict';
/**
 * run-outcome.js — как главный процесс читает исход одного шага установки.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Всё это жило внутри обработчика `run-component` в
 * `src/main.js`, а тот требует `electron` и из теста не грузится. Здесь — чистые
 * функции без ФС и без Electron, их гоняет test/run-tests.js напрямую.
 *
 * ЧТО ЗДЕСЬ РЕШАЕТСЯ:
 *
 * 1. Код 121 — «частичный успех» — здесь НЕ разбирается. Его переводит в ответ
 *    renderer'у `src/main.js` по `install-receipts` (isPartialExit / partialReason):
 *    `{ ok: true, partial: true, partialReason }`, маркер установки пишется. Здесь
 *    только зеркало кода: «Пропустить шаг» не должен перебить честный исход 121.
 *    Отрисовка жёлтого шага и вердикт прогона — в `src/renderer/run-status.js`.
 *
 * 2. Причина пропуска (код 120). Скрипт печатает её ПОСЛЕДНЕЙ строкой перед выходом.
 *    До 06.10.2026 причину брали выражением `String(outTail).split(/\r?\n/)` — но
 *    outTail это МАССИВ строк, и String() склеивал его через запятую в одну строку
 *    без переводов. В итоге «последней строкой» оказывался весь вывод, а после
 *    `.slice(0, 240)` — его НАЧАЛО. На финише под пропущенным Claude Desktop стояло
 *    «Скачиваю официальный установщик…» вместо настоящей причины — ровно та «не та
 *    причина в сообщении», на которую жаловались люди.
 *
 * 3. Сторож молчания. Для НЕОБЯЗАТЕЛЬНОГО компонента после STALL_SKIP_MIN минут без
 *    вывода человеку предлагается кнопка «Пропустить шаг». Обязательные по-прежнему
 *    не трогаем: убить посреди установки редактора или Node хуже, чем подождать.
 */

const EXIT_SKIP = 120;     // зеркало install-receipts.EXIT_SKIP: «нечего ставить»
const EXIT_PARTIAL = 121;  // зеркало кода частичного успеха (разбирает main по install-receipts)

// Служебные строки, которые объяснением не являются.
const SERVICE_LINE_RE = /^\[(dry-run|debug)\]/i;

// Сколько минут молчания терпим, прежде чем предложить «Пропустить шаг» у
// необязательного компонента. Восемь — с запасом больше самой долгой честной паузы
// без вывода (распаковка установщика редактора на медленном диске — 3–5 минут), но
// заметно меньше часа, который люди ждали в живых случаях (ChatGPT Desktop 72 мин,
// Cursor 2,7 ч).
const STALL_SKIP_MIN = 8;
// Предупреждение в журнал — раз в 10 минут молчания, как и было (для ВСЕХ шагов).
const STALL_WARN_EVERY_MIN = 10;

function isPartialExit(code) { return code === EXIT_PARTIAL; }
function isSkipExit(code) { return code === EXIT_SKIP; }

/**
 * Процесс скрипта уже завершился? Node выставляет exitCode/signalCode в момент выхода, а
 * событие 'close' приходит позже — когда закрыты все пайпы, и его может держать внук. У
 * «пустых» объектов (в тестах) полей нет — тогда считаем, что процесс жив.
 */
function childExited(c) {
  if (!c) return false;
  const has = (v) => v !== null && v !== undefined;
  return has(c.exitCode) || has(c.signalCode);
}

function toLines(tail) {
  if (Array.isArray(tail)) {
    // Элемент массива сам может нести переводы строк (склейка чанков) — режем и его.
    const out = [];
    for (const t of tail) String(t == null ? '' : t).split(/\r?\n/).forEach((l) => out.push(l));
    return out;
  }
  return String(tail == null ? '' : tail).split(/\r?\n/);
}

/**
 * Последняя содержательная строка вывода — то, что скрипт сказал перед выходом.
 * @param {string[]|string} tail
 * @param {number} [maxLen=240]
 */
function lastMeaningfulLine(tail, maxLen) {
  const lines = toLines(tail);
  const lim = Math.max(1, Number(maxLen) || 240);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || SERVICE_LINE_RE.test(l)) continue;
    return l.slice(0, lim);
  }
  return '';
}

/** Причина пропуска (код 120): последняя содержательная строка вывода. */
function skipReasonFrom(tail) { return lastMeaningfulLine(tail, 240); }

/**
 * Решение сторожа молчания на очередном тике.
 * @param {object} s
 * @param {number}  s.silentMs     сколько миллисекунд шаг не выдаёт вывод
 * @param {boolean} s.optional     компонент необязательный (components.json → optional)
 * @param {boolean} s.exited       процесс скрипта уже вышел (childExited): убивать по его PID нечего
 * @param {boolean} s.offered      кнопка «Пропустить шаг» уже предложена в этом эпизоде молчания
 * @param {number}  s.warnedAtMin  на какой минуте молчания было последнее предупреждение (0 — не было)
 * @returns {{mins: number, warn: boolean, offerSkip: boolean}}
 */
function stallDecision(s) {
  const o = s || {};
  const silent = Math.max(0, Number(o.silentMs) || 0);
  const mins = Math.floor(silent / 60000);
  const warnedAt = Math.max(0, Number(o.warnedAtMin) || 0);
  const warn = mins >= STALL_WARN_EVERY_MIN && mins >= warnedAt + STALL_WARN_EVERY_MIN;
  const offerSkip = o.optional === true && !o.offered && mins >= STALL_SKIP_MIN;
  return { mins, warn, offerSkip };
}

/**
 * Можно ли выполнить «Пропустить шаг» прямо сейчас. Решает MAIN, а не renderer:
 * renderer недоверенный, и кнопка — лишь просьба. Пропускаем только шаг, который
 * идёт СЕЙЧАС, только необязательный и только пока он по-прежнему молчит.
 */
function canSkipNow(s) {
  const o = s || {};
  if (!o.running || !o.id || o.id !== o.requestedId) return { ok: false, reason: 'not-running' };
  // Процесс уже ушёл, а шаг держит 'close' (пайпы у внука): taskkill по мёртвому PID либо ничего
  // не найдёт, либо — если Windows успела отдать PID чужому процессу — убьёт постороннее дерево.
  if (o.exited === true) return { ok: false, reason: 'not-running' };
  if (o.optional !== true) return { ok: false, reason: 'required' };
  const mins = Math.floor(Math.max(0, Number(o.silentMs) || 0) / 60000);
  if (mins < STALL_SKIP_MIN) return { ok: false, reason: 'alive' };
  return { ok: true, reason: '' };
}

module.exports = {
  EXIT_SKIP, EXIT_PARTIAL, STALL_SKIP_MIN, STALL_WARN_EVERY_MIN,
  isPartialExit, isSkipExit, childExited, lastMeaningfulLine, skipReasonFrom,
  stallDecision, canSkipNow,
};
