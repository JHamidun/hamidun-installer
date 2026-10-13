'use strict';
/**
 * desktop-path.js — рабочий стол, в который можно писать из-под администратора.
 *
 * ЗАЧЕМ. Памятку «Что дальше» установщик кладёт на рабочий стол (save-start-here), а при
 * удалении курса снимает с него ярлык. Адрес стола main.js брал у оболочки
 * (`app.getPath('desktop')`), а оболочка узнаёт его из
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders — ветки, которую
 * без UAC правит любая программа того же пользователя. Подмени она «Desktop» на каталог, куда
 * пользователь писать не может, а администратор может (автозагрузка всех пользователей в
 * ProgramData, профиль другой учётной записи), — и файл, который создаёт ПРОЦЕСС АДМИНИСТРАТОРА,
 * лёг бы туда: плацдарм вне прав того, кто подменил запись.
 *
 * ЧТО ДЕЛАЕМ. Ответ оболочки принимается, только если папка:
 *   1. лежит строго ВНУТРИ профиля. Профиль берётся из токена процесса (`os.userInfo().homedir`,
 *      GetUserProfileDirectory → список профилей в HKLM), а НЕ из `os.homedir()`: тот читает
 *      переменную USERPROFILE, которую тоже переписывают без UAC. Проверено запуском в Electron
 *      44.5.1: при USERPROFILE=C:\evil homedir() = C:\evil, userInfo().homedir = настоящий профиль;
 *   2. существует и это каталог;
 *   3. на пути от профиля до неё нет ссылок: junction и symlink lstat называет ссылкой, и сделать
 *      это невидимым (запретом чтения на самой ссылке) нельзя — проверено; облачные папки OneDrive
 *      («Перенос известных папок») помечены точкой повторной обработки, но lstat ссылкой их НЕ
 *      считает — они остаются на месте, и стол в OneDrive (…\OneDrive\Desktop, «Рабочий стол»,
 *      «OneDrive - Компания») принимается;
 *   4. каноническая форма (GetFinalPathNameByHandle) совпадает с названной: это ловит всё, что lstat
 *      ссылкой не назвал. Профиль, лежащий за junction (перенесён на другой диск), законен — его
 *      подменяет администратор, а не пользователь, — поэтому сравнивается каноника папки с
 *      каноникой профиля + остаток пути, а не с буквальным путём.
 * Не прошла — отказ с причиной (вызывающий пишет её в журнал), файл не создаётся.
 *
 * Только Windows. На macOS процесс не повышен (обычный пользователь пишет в свой стол), проверка
 * ничего бы не защитила, а ложный отказ при ссылке на стол (Dropbox, iCloud) был бы вредом.
 *
 * Модуль чистый (без electron): файловая система приходит параметром, тесты гоняют его на
 * настоящих junction и на подставных отказах.
 */
const fs = require('fs');
const path = require('path');

function refuse(reason) { return { ok: false, dir: '', reason }; }
function codeOf(e) { return (e && (e.code || e.message)) || String(e); }

/**
 * @param {object} o
 * @param {string} o.profile       профиль из токена (os.userInfo().homedir)
 * @param {string} o.shellDesktop  ответ оболочки (app.getPath('desktop'))
 * @param {string} [o.platform]    process.platform (параметром — для тестов)
 * @param {object} [o.fsx]         fs для тестов
 * @returns {{ok: boolean, dir: string, reason: string, unchecked?: boolean}}
 */
function resolveSafeDesktop(o) {
  const opts = o || {};
  const platform = opts.platform || process.platform;
  const shell = String(opts.shellDesktop == null ? '' : opts.shellDesktop);
  if (platform !== 'win32') {
    return shell.trim() ? { ok: true, dir: shell, reason: '', unchecked: true } : refuse('оболочка не назвала рабочий стол');
  }
  const f = opts.fsx || fs;
  const W = path.win32;
  const profileRaw = String(opts.profile == null ? '' : opts.profile);
  if (!profileRaw.trim()) return refuse('профиль пользователя не определён');
  if (!shell.trim()) return refuse('оболочка не назвала рабочий стол');
  // Только локальные пути «диск:\…»: UNC, \\?\, относительные пути и «C:папка» сюда не годятся.
  const LOCAL = /^[A-Za-z]:[\\/]/;
  if (!LOCAL.test(profileRaw) || !LOCAL.test(shell)) return refuse('путь не локальный (ждём диск:\\папка)');
  // Джокеры, знаки, запрещённые в именах, управляющие знаки (в том числе C1 и разделители строк: в журнал
  // идёт одна строка) и «:» дальше буквы диска (потоки данных).
  const BAD = /[<>"|?*\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  if (BAD.test(profileRaw) || BAD.test(shell) || profileRaw.indexOf(':', 2) !== -1 || shell.indexOf(':', 2) !== -1) {
    return refuse('в пути недопустимые знаки');
  }
  const profile = W.resolve(profileRaw);
  const cand = W.resolve(shell);
  // Профиль — не корень диска: иначе «внутри профиля» значило бы «где угодно на диске».
  if (profile.length <= W.parse(profile).root.length) return refuse('профиль пользователя — корень диска');

  // Строго внутри профиля. relative() сравнивает без учёта регистра и не путает «user» с «user2».
  const rel = W.relative(profile, cand);
  if (!rel || rel === '..' || rel.startsWith('..' + W.sep) || W.isAbsolute(rel)) {
    return refuse('папка вне профиля пользователя (' + cand + ' вне ' + profile + ')');
  }

  // Профиль — существующий каталог (сам он может стоять за junction: его переносит администратор).
  try {
    if (!f.statSync(profile).isDirectory()) return refuse('профиль пользователя — не папка');
  } catch (e) { return refuse('профиль пользователя не читается (' + codeOf(e) + ')'); }

  // Каждое звено от профиля вниз: существует, каталог, не ссылка. Ошибка чтения — отказ.
  let cur = profile;
  for (const seg of rel.split(W.sep)) {
    if (!seg) continue;
    // Точки и пробелы на конце имени Win32 отбрасывает при проверке, но не в середине пути при записи
    // («Desktop » и «Desktop» — для оболочки одна папка, а для записи две): законная папка так не называется.
    // Правило одно на обе стороны установщика: PowerShell (.NET) срезает на конце пути ещё неразрывный пробел
    // (табы и U+0085 отсекает фильтр знаков выше), поэтому отказ по точке и по любому пробельному знаку.
    if (/[.\s]$/.test(seg)) return refuse('имя папки кончается точкой или пробелом: ' + seg);
    cur = W.join(cur, seg);
    let st;
    try { st = f.lstatSync(cur); }
    catch (e) {
      const c = codeOf(e);
      return refuse(c === 'ENOENT' || c === 'ENOTDIR' ? 'папки нет на диске: ' + cur : 'путь не читается (' + c + '): ' + cur);
    }
    if (st.isSymbolicLink()) return refuse('в пути есть ссылка (junction/symlink): ' + cur);
    if (!st.isDirectory()) return refuse('на месте папки лежит не папка: ' + cur);
  }

  // Каноническая форма: то, что lstat ссылкой не назвал, но что ведёт в другое место.
  let realProfile;
  let realCand;
  try {
    const rp = f.realpathSync.native || f.realpathSync;
    realProfile = rp(profile);
    realCand = rp(cand);
  } catch (e) { return refuse('канонический путь не получен (' + codeOf(e) + ')'); }
  const want = W.join(realProfile, rel);
  if (W.resolve(realCand).toLowerCase() !== W.resolve(want).toLowerCase()) {
    return refuse('канонический путь не совпал с названным (' + realCand + ')');
  }
  return { ok: true, dir: cand, reason: '' };
}

module.exports = { resolveSafeDesktop };
