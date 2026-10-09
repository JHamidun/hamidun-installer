'use strict';

// Классификация «Last Result» одноразовой задачи планировщика — зеркало Get-HmTaskVerdict
// из scripts/windows/_deelev.ps1 (их согласие стережёт тест, прогоняя обе на одних числах).
// Отдельный модуль, потому что main.js в тестах не грузится (требует electron), а цена
// ошибки здесь двусторонняя: принять «действие не стартовало» за код программы — значит
// сдаться там, где запасной путь помог бы; принять живой запуск за несостоявшийся — значит
// открыть редактор вторым запуском поверх первого.
//
// Числа планировщика:
//   210                          — обёртка увидела НЕ medium и программу не запускала;
//   0x8007xxxx, 0x800413xx       — HRESULT самого планировщика: действие задачи не
//                                  стартовало (у людей так: 0x80070005, «отказано в доступе»);
//   0x00041306 (267014)          — задачу прервал лимит: что-то могло остаться жить;
//   прочие 0x000413xx            — служебные статусы задачи, ничего не доказывают;
//   остальное                    — код выхода обёртки (то есть программы).
function taskVerdict(lastResult) {
  const s = lastResult == null ? '' : String(lastResult).trim();
  const none = { gate: 'unknown', code: -1, hex: '', kind: 'no-result' };
  if (!/^-?\d{1,10}$/.test(s)) return none;
  const n = Number(s);
  if (n < -2147483648 || n > 4294967295) return none;
  const u = n >>> 0;
  const signed = u | 0;
  const hex = '0x' + u.toString(16).toUpperCase().padStart(8, '0');
  if (u === 210) return { gate: 'refused', code: -1, hex, kind: 'refused' };
  if (u === 0x41306) return { gate: 'terminated', code: signed, hex, kind: 'sched-terminated' };
  if (u >= 0x41300 && u <= 0x413FF) return { gate: 'unknown', code: signed, hex, kind: 'sched-status' };
  if (((u & 0xFFFF0000) >>> 0) === 0x80070000 || ((u & 0xFFFFFF00) >>> 0) === 0x80041300) {
    return { gate: 'not-started', code: signed, hex, kind: 'launch-failed' };
  }
  return { gate: 'medium', code: signed, hex, kind: 'exit' };
}

// Можно ли запускать то же действие запасным путём (токен оболочки Explorer) — только
// когда ДОКАЗАНО, что задача ничего не запустила: сбой до /Run (stage = prereq | staging |
// create | run), отказ гейта обёртки (210) или HRESULT планировщика. Код 211 (Start-Process
// упал уже на medium) и таймаут опроса — НЕТ: в первом случае запасной путь упрётся в то же,
// во втором первый запуск может ещё идти.
function shellFallbackAllowed(stage, lastResult) {
  if (stage === 'prereq' || stage === 'staging' || stage === 'create' || stage === 'run') return true;
  if (stage !== 'done') return false;
  const v = taskVerdict(lastResult);
  return v.gate === 'not-started' || v.gate === 'refused';
}

// Литерал для `Start-Process -ArgumentList …` в обёртке запуска редактора: каждый путь —
// ОТДЕЛЬНЫЙ элемент массива в своих двойных кавычках ('"C:\Users\John Doe\X"'), иначе пробел
// в имени пользователя рвёт его на два аргумента. PowerShell 5.1 склеивает элементы через
// пробел, кавычки сам не ставит. Одинарная кавычка в пути удваивается (литерал PS); путь с
// двойной кавычкой или переводом строки в Windows невозможен — такой отвергаем (null),
// вызывающий тогда откроет без него. Хвостовые «\» удваиваются: перед закрывающей кавычкой
// они бы её экранировали при разборе командной строки редактором (CommandLineToArgvW).
function psArgList(values) {
  const list = (values || []).map((v) => String(v));
  if (!list.length || list.some((v) => !v || /["\r\n\0]/.test(v))) return null;
  return list.map((v) => "'\"" + psQuoteBody(v.replace(/(\\+)$/, '$1$1')) + "\"'").join(',');
}

// Тело одинарно-кавыченного литерала PowerShell (БЕЗ внешних кавычек). Разбор PowerShell считает
// ограничителями не только ASCII ' , но и четыре типографские кавычки U+2018 U+2019 U+201A
// U+201B; удвоение любой пары даёт один литеральный знак. Удвоения одного ASCII хватало для
// «O'Brien», но не для «O’Brien»: незакрытый литерал ломал разбор обёртки целиком, и запуск
// отчитывался ошибкой программы, которая на деле не стартовала, — без запасного пути.
// Парная функция на стороне PowerShell — ConvertTo-HmPsLiteral в scripts/windows/_deelev.ps1.
function psQuoteBody(value) {
  return String(value == null ? '' : value).replace(/['‘’‚‛]/g, '$&$&');
}
// Тот же литерал вместе с внешними кавычками.
function psLit(value) { return "'" + psQuoteBody(value) + "'"; }

// Файл, который редактор откроет вкладкой рядом с папкой (code <папка> <файл>). Кнопка ✳
// панели Claude в заголовке редактора видна только при ОТКРЫТОМ файле — без него новичок
// её не находит. Отдаём путь, только если это реально существующий файл: несуществующий
// VS Code открыл бы пустой вкладкой «файл будет создан».
function editorOpenFiles(dir, openFile) {
  if (!dir || !openFile) return [];
  const f = require('path').join(String(dir), String(openFile));
  try { return require('fs').statSync(f).isFile() ? [f] : []; } catch (e) { return []; }
}

// Аргументы osascript для кнопки «Войти в Claude» на macOS: Terminal открывается в
// ~/HamidunStart (как на Windows), а не в $HOME. Путь едет ОТДЕЛЬНЫМ аргументом (`on run argv`),
// а не вставляется в текст скрипта: в AppleScript-литерале пришлось бы экранировать «\» и «"», а
// в оболочку Terminal путь всё равно обязан попасть shell-quoted — это делает `quoted form of`.
// Путь с пробелом, апострофом, кавычкой или «$» остаётся одним словом для cd. Команда собирается
// ДО `tell application "Terminal"`: внутри блока `item 1 of argv` могло бы уйти приложению как
// команда. Пустой startDir (папка не создалась) — прежний сценарий: Terminal в домашней папке.
function claudeTerminalOsaArgs(startDir) {
  if (!startDir) {
    return ['-e', 'tell application "Terminal" to activate',
      '-e', 'tell application "Terminal" to do script "claude"'];
  }
  return ['-e', 'on run argv',
    '-e', 'set cmd to "cd " & quoted form of (item 1 of argv) & " && claude"',
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', 'do script cmd',
    '-e', 'end tell',
    '-e', 'end run',
    String(startDir)];
}

module.exports = { taskVerdict, shellFallbackAllowed, psArgList, psQuoteBody, psLit, editorOpenFiles, claudeTerminalOsaArgs };
