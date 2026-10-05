'use strict';
// Метка человека, когда собственное имя файла её больше не несёт.
//
// Зачем это вообще нужно. Персональная ссылка отдаёт файл под именем
// Hamidun-Setup-Windows--u<tg_id>.exe, и uid-telemetry.js достаёт метку из имени
// запущенного файла (Windows) или из имени смонтированного образа (macOS). Замер
// по боевым событиям за 26.07–20.08 показал, где это перестаёт работать:
//
//   качнули с меткой  →  отчитались с меткой
//   Windows           73%  →  27%
//   macOS             77%  →   5%
//
// Причина у обоих провалов одна и та же и лежит НЕ в коде, а в том, как люди
// обращаются с файлом:
//   • на macOS приложение запускают не из образа, а из «Программ», куда его
//     перетащили, — образ к этому моменту отцеплен, и hdiutil про него молчит;
//   • на Windows файл переносят из «Загрузок» на рабочий стол, переименовывают,
//     запускают копию, присланную знакомым.
//
// Во всех этих случаях скачанный ФАЙЛ обычно никуда не делся — он так и лежит в
// «Загрузках» с меткой в имени. Этот модуль его там и ищет.
//
// Отдельным файлом, а не строкой в uid-telemetry.js, ровно потому, что здесь
// обход файловой системы: его надо гонять тестами на настоящих папках, а не
// доверять чтению кода.
//
// ── КАК ПОДКЛЮЧИТЬ (одна строка, ещё НЕ сделано) ────────────────────────────
// Модуль намеренно оставлен не подключённым: uid-telemetry.js в этот же день
// правила соседняя волна, и лезть туда третьей рукой значило бы затереть чужое.
// Подключение — вставка ДВУХ строк в конец блока try внутри resolveUid(), сразу
// после ветки `if (platform === 'darwin') { … }` и перед закрывающим `} catch`:
//
//     const fromDownloads = require('./uid-fallback').findDownloadedUid({ platform, env });
//     if (fromDownloads) return fromDownloads;
//
// Переменные `platform` и `env` там уже объявлены выше по функции. Порядок важен:
// это ПОСЛЕДНИЙ источник, он включается, только когда ни имя файла, ни файл рядом,
// ни смонтированный образ метку не дали. Тесты: `node test/uid-fallback.test.js`
// (23 проверки на настоящих папках); в test/run-tests.js их стоит добавить тем же
// заходом, чтобы блок не разъехался с соседней волной.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Тот же алфавит, что и у sanitizeUid в uid-telemetry.js: метка едет в тело POST,
// и подставлять туда что попало из имени файла нельзя.
const UID_RE = /^[A-Za-z0-9_-]{1,32}$/;

// Имя целиком, а не «содержит --u»: под правило должны попадать ТОЛЬКО наши
// установщики. Иначе достаточно положить в «Загрузки» файл с подходящим именем,
// чтобы чужая метка уехала в наши события.
//   Hamidun-Setup-Windows--u123456789.exe
//   Hamidun-Setup-Mac-Lite--u123456789 (1).dmg     ← Chrome при повторной загрузке
//   Hamidun-Setup-Mac--u123456789-2.dmg            ← Safari при повторной загрузке
const FILE_RE = /^Hamidun-Setup-[A-Za-z0-9-]+--u(\d{1,32})(?:\s*\(\d+\)|-\d{1,3})?\.(exe|dmg)$/i;

// Потолки обхода. Папка «Загрузки» у живого человека — это тысячи файлов, и
// установка не должна из-за неё замирать: разбор идёт при старте главного
// процесса, до появления окна.
const MAX_ENTRIES = 4000;   // сколько имён смотрим в одной папке
const MAX_DIRS = 8;         // сколько папок обходим всего

function uidFromFileName(name) {
  const m = FILE_RE.exec(String(name || ''));
  if (!m) return '';
  const uid = m[1];
  return UID_RE.test(uid) ? uid : '';
}

// Где люди держат скачанное. Порядок важен: «Загрузки» первыми, потому что там
// файл лежит в подавляющем большинстве случаев, а рабочий стол — уже следствие
// того, что его оттуда перетащили.
function searchDirs(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const home = o.home || os.homedir() || '';
  const out = [];
  const add = (p) => { if (p && out.indexOf(p) === -1) out.push(p); };
  // Переопределённая папка загрузок (у части людей это отдельный диск).
  add(env.HM_DOWNLOADS_DIR || '');
  if (home) {
    add(path.join(home, 'Downloads'));
    add(path.join(home, 'Загрузки'));   // локализованное имя встречается как реальная папка
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Рабочий стол'));
    add(home);
  }
  // Windows: рабочий стол и загрузки могут быть перенаправлены в OneDrive.
  const od = env.OneDrive || env.OneDriveConsumer || '';
  if (od) { add(path.join(od, 'Downloads')); add(path.join(od, 'Desktop')); }
  return out.slice(0, MAX_DIRS);
}

// Самый свежий подходящий файл. «Свежий» = по времени изменения: если человек
// качал дважды (а качают дважды именно те, у кого не пошло с первого раза),
// метка должна взяться из последнего скачивания, а не из первого.
function findDownloadedUid(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const wantExt = platform === 'darwin' ? 'dmg' : 'exe';
  const dirs = o.dirs || searchDirs(o);
  let best = null;   // {uid, mtime, file}
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue;   // папки нет или в неё не пускают — обычный случай, не ошибка
    }
    if (names.length > MAX_ENTRIES) names = names.slice(0, MAX_ENTRIES);
    for (const name of names) {
      if (name.length > 128) continue;                   // длинные имена — не наши
      if (!name.toLowerCase().endsWith('.' + wantExt)) continue;
      const uid = uidFromFileName(name);
      if (!uid) continue;
      const full = path.join(dir, name);
      let mtime = 0;
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        mtime = st.mtimeMs;
      } catch (e) {
        continue;   // файл исчез между чтением папки и stat — просто пропускаем
      }
      if (!best || mtime > best.mtime) best = { uid, mtime, file: full };
    }
  }
  return best ? best.uid : '';
}

module.exports = { UID_RE, FILE_RE, uidFromFileName, searchDirs, findDownloadedUid };
