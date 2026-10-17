'use strict';
/**
 * verify-fuses.js — постсборочный гейт: в упакованном Electron-бинаре выключены три fuse,
 * через которые код того же пользователя попадает ВНУТРЬ подписанного elevated-процесса.
 *
 * ЗАЧЕМ. Установщик — exe с requireAdministrator, подписанный Certum. Окружение
 * elevated-процесса пересобирается из реестра (HKCU\Environment), а писать туда может любой
 * процесс пользователя без UAC. С заводскими fuse Electron:
 *   • EnableNodeOptionsEnvironmentVariable — NODE_OPTIONS="--require x.js" исполняется внутри
 *     main-процесса ДО первой строки кода установщика, как только человек примет честный UAC;
 *   • RunAsNode — ELECTRON_RUN_AS_NODE=1 делает из подписанного exe Node-интерпретатор
 *     («подписанный Node» для любого, кому достался клик по UAC);
 *   • EnableNodeCliInspectArguments — --inspect и сигнал SIGUSR1 открывают отладчик в процессе.
 * Гасит их хук tools/after-pack.js (до rcedit и подписи). ЭТОТ скрипт — независимая сверка
 * результата: он не импортирует хук и не пользуется пакетом @electron/fuses, а сам читает
 * проводку из готового бинаря. Если зелёный отчёт можно получить, не посмотрев на байты, то
 * это не гейт.
 *
 * ФОРМАТ ПРОВОДКИ (V1). Сразу после 32-байтного sentinel лежат: байт версии (1), байт длины
 * N и N байт состояний по одному на fuse: '0' (0x30) выключен, '1' (0x31) включён, 'r' (0x72)
 * убран. Порядок fuse зафиксирован самим Electron (RunAsNode=0, EnableNodeOptionsEnvironment
 * Variable=2, EnableNodeCliInspectArguments=3); сверен с реальной проводкой Electron 44.5.1 и
 * с FuseV1Options пакета @electron/fuses 2.1.3 (тест «fuses: индексы гейта сверены с FuseV1Options …»).
 *
 * ГДЕ ИСКАТЬ.
 *   Windows — в корне папки сборки каждый *.exe (там один Electron-бинарь «Hamidun Setup.exe»;
 *     лишний electron.exe с заводскими fuse тоже завалит гейт);
 *   macOS — в «Electron Framework.framework/Versions/A/Electron Framework» внутри каждого .app
 *     (в основном исполняемом файле проводки нет). У universal-сборки в файле ДВЕ проводки —
 *     по одной на слайс; проверяется каждая.
 *
 * Запуск: node tools/verify-fuses.js [<папка сборки>]
 *   по умолчанию release/win-unpacked; для macOS — папка с .app (release/mac-universal) или
 *   сам .app. Код выхода: 0 — во всех найденных проводках три fuse выключены; 1 — хотя бы один
 *   включён либо проводку нельзя прочитать (неизвестная версия, обрезана, состояние «removed»:
 *   «выключен» не доказан); 2 — проверять нечего (нет папки, нет бинаря, нет ни одной проводки)
 *   либо гейт вызван неверно (папок больше одной: лишние аргументы раньше молча отбрасывались).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
const WIRE_VERSION = 1;
const STATE = { DISABLED: 0x30, ENABLED: 0x31, REMOVED: 0x72 };

// Опасная тройка и её индексы в проводке V1. Что делает каждый fuse — в шапке файла.
const GUARDED = [
  { name: 'RunAsNode', index: 0, why: 'ELECTRON_RUN_AS_NODE=1 превращает подписанный exe в Node-интерпретатор' },
  { name: 'EnableNodeOptionsEnvironmentVariable', index: 2, why: 'NODE_OPTIONS="--require x.js" исполняется внутри процесса до кода установщика' },
  { name: 'EnableNodeCliInspectArguments', index: 3, why: '--inspect и SIGUSR1 открывают отладчик в elevated-процессе' },
];
const MAX_GUARDED_INDEX = Math.max.apply(null, GUARDED.map((g) => g.index));

const CHUNK = 8 * 1024 * 1024;

/** Подпись состояния для людей. */
function stateLabel(b) {
  if (b === STATE.DISABLED) return 'выключен';
  if (b === STATE.ENABLED) return 'ВКЛЮЧЁН';
  if (b === STATE.REMOVED) return 'removed («r»: выключен не доказан)';
  return 'неизвестное состояние 0x' + Number(b).toString(16).padStart(2, '0');
}

/** Читает ровно len байт (короткое чтение на файловой системе не должно резать sentinel). */
function readFull(fd, buf, len, pos) {
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return got;
}

/**
 * Все вхождения sentinel в файле и проводка за каждым. Читает кусками по 8 МиБ с нахлёстом в
 * 31 байт (sentinel на стыке кусков не теряется, дублей не бывает: совпадение целиком внутри
 * нахлёста в буфер не влезает). @returns {{size:number, wires:Array}}
 */
function scanFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(CHUNK + SENTINEL.length - 1);
    const offsets = [];
    for (let pos = 0; pos < size; pos += CHUNK) {
      const n = readFull(fd, buf, Math.min(buf.length, size - pos), pos);
      const view = buf.subarray(0, n);
      let i = view.indexOf(SENTINEL);
      while (i !== -1) {
        offsets.push(pos + i);
        i = view.indexOf(SENTINEL, i + 1);
      }
    }
    const wires = offsets.map((off) => {
      const head = Buffer.alloc(2 + 255);
      const got = readFull(fd, head, head.length, off + SENTINEL.length);
      if (got < 2) return { offset: off, version: null, length: null, states: Buffer.alloc(0), truncated: true };
      const length = head[1];
      const states = Buffer.from(head.subarray(2, Math.min(2 + length, got)));
      return { offset: off, version: head[0], length, states, truncated: states.length < length };
    });
    return { size, wires };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Вердикт по одной проводке: все ли три fuse ДОКАЗАННО выключены.
 * @returns {{ok:boolean, problems:string[], states:Array<{name:string,index:number,byte:number|null,off:boolean}>}}
 */
function judgeWire(w) {
  const problems = [];
  const states = [];
  if (w.version !== WIRE_VERSION) {
    problems.push('неизвестная версия проводки: ' + w.version + ' (знаю только ' + WIRE_VERSION + ') — порядок fuse не определён, выключенность не доказана');
    return { ok: false, problems, states };
  }
  if (w.truncated) {
    problems.push('проводка обрезана: заявлено ' + w.length + ' флагов, в файле только ' + w.states.length);
  }
  for (const g of GUARDED) {
    if (g.index >= w.states.length) {
      problems.push(g.name + ': в проводке из ' + w.length + ' флагов нет индекса ' + g.index + ' — выключенность не доказана');
      states.push({ name: g.name, index: g.index, byte: null, off: false });
      continue;
    }
    const b = w.states[g.index];
    const off = b === STATE.DISABLED;
    states.push({ name: g.name, index: g.index, byte: b, off });
    if (!off) problems.push(g.name + ' ' + stateLabel(b) + ' — ' + g.why);
  }
  return { ok: problems.length === 0, problems, states };
}

/**
 * Файлы с Electron Framework внутри одного .app. Основной путь — Versions/A (его называет
 * сам Electron), запасной — верхняя ссылка Electron Framework.framework/Electron Framework.
 * На настоящем маке верхний файл — симлинк на тот же файл: дубли убираются по realpath, чтобы
 * не считать один бинарь дважды. @returns {string[]} только существующие файлы
 */
function macFrameworkFiles(app) {
  const fw = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework');
  const seen = new Set();
  const out = [];
  for (const rel of [['Versions', 'A', 'Electron Framework'], ['Electron Framework']]) {
    const p = path.join.apply(path, [fw].concat(rel));
    let real;
    try { real = fs.realpathSync(p); } catch (e) { continue; }
    if (seen.has(real)) continue;
    try { if (!fs.statSync(real).isFile()) continue; } catch (e) { continue; }
    seen.add(real);
    out.push(p);
  }
  return out;
}

/** Кандидаты на проверку в папке сборки. @returns {Array<{kind:'exe'|'framework', file:string}>} */
function locate(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && /\.exe$/i.test(e.name)) out.push({ kind: 'exe', file: path.join(dir, e.name) });
  }
  const apps = /\.app$/i.test(dir)
    ? [dir]
    : entries.filter((e) => e.isDirectory() && /\.app$/i.test(e.name)).map((e) => path.join(dir, e.name));
  for (const app of apps) {
    for (const f of macFrameworkFiles(app)) out.push({ kind: 'framework', file: f });
  }
  return out;
}

/**
 * Полная проверка папки. Чистая функция от диска: ничего не печатает и не завершает процесс.
 * @returns {{code:0|1|2, lines:Array<{err:boolean,text:string}>, wires:number, files:number}}
 */
function checkDir(dir) {
  const lines = [];
  const info = (text) => lines.push({ err: false, text: '[verify-fuses] ' + text });
  const bad = (text) => lines.push({ err: true, text: '[verify-fuses] ' + text });
  const res = (code, extra) => Object.assign({ code, lines, wires: 0, files: 0 }, extra || {});

  let st;
  try { st = fs.statSync(dir); } catch (e) {
    bad('нечего проверять: нет ' + dir + ' — сборка ещё не сделана?');
    return res(2);
  }
  if (!st.isDirectory()) {
    bad('нечего проверять: ' + dir + ' — не папка');
    return res(2);
  }
  let cands;
  try { cands = locate(dir); } catch (e) {
    bad('не прочитать папку ' + dir + ': ' + e.message);
    return res(2);
  }
  if (!cands.length) {
    bad('в ' + dir + ' нет ни exe в корне, ни Electron Framework внутри .app — fuse искать негде. ' +
      'По умолчанию проверяется release/win-unpacked; для macOS укажи папку с .app (release/mac-universal).');
    return res(2);
  }

  let wires = 0;
  let files = 0;
  let failed = 0;
  for (const c of cands) {
    let scan;
    try { scan = scanFile(c.file); } catch (e) {
      failed++;
      bad('ПРОВАЛ: не прочитать ' + c.file + ': ' + e.message);
      continue;
    }
    const rel = path.relative(dir, c.file) || path.basename(c.file);
    if (!scan.wires.length) {
      info('пропуск ' + rel + ': sentinel fuse не найден (не Electron-бинарь)');
      continue;
    }
    files++;
    for (const w of scan.wires) {
      wires++;
      const v = judgeWire(w);
      if (v.ok) {
        info(rel + ' (+' + w.offset + ', проводка v' + w.version + ', флагов ' + w.length + '): ' +
          v.states.map((s) => s.name + ' ' + stateLabel(s.byte)).join(', '));
      } else {
        failed++;
        for (const p of v.problems) bad('ПРОВАЛ: ' + rel + ' (+' + w.offset + '): ' + p);
      }
    }
  }

  if (failed) {
    bad('сборка НЕГОДНА: хотя бы одна проводка не доказывает, что RunAsNode, NODE_OPTIONS и --inspect выключены. ' +
      'Гасит их хук tools/after-pack.js. Он не отработал, если сборку делали через electron-builder --prepackaged ' +
      '(хуки пропускаются) или exe подставил кэш electron-builder (release/.cache, ELECTRON_BUILDER_DISABLE_BUILD_CACHE=true).');
    return res(1, { wires, files });
  }
  if (!wires) {
    bad('нечего проверять: ни в одном из ' + cands.length + ' файл(ов) нет fuse-проводки — это не Electron ≥ 12 или бинарь подменён.');
    return res(2, { wires, files });
  }
  info('OK: проверено проводок ' + wires + ' в ' + files + ' файл(ах); RunAsNode, EnableNodeOptionsEnvironmentVariable и ' +
    'EnableNodeCliInspectArguments выключены.');
  return res(0, { wires, files });
}

function main(argv) {
  // Читается ровно одна папка. Раньше остальные аргументы молча отбрасывались: `<плохая> <хорошая>`
  // падал, а `<хорошая> <плохая>` давал зелёный код, хотя вторая папка не проверялась вовсе. Гейт,
  // который смотрит неизвестно какую из двух, ничего не доказывает: лишнее — отказ (2: проверка не сделана).
  if (argv.length > 1) {
    console.error('[verify-fuses] ожидается одна папка сборки, а передано ' + argv.length + ': ' + argv.join(' ') + '. ' +
      'Лишние аргументы молча не проверяются — запусти гейт отдельно для каждой папки.');
    return 2;
  }
  const dir = path.resolve(argv[0] || path.join(ROOT, 'release', 'win-unpacked'));
  const r = checkDir(dir);
  for (const l of r.lines) (l.err ? console.error : console.log)(l.text);
  return r.code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = {
  SENTINEL, WIRE_VERSION, STATE, GUARDED, MAX_GUARDED_INDEX,
  stateLabel, scanFile, judgeWire, macFrameworkFiles, locate, checkDir, main,
};
