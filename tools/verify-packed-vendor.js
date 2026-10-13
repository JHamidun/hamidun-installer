'use strict';
/**
 * verify-packed-vendor.js — постсборочный контроль: файлы vendor\ ВНУТРИ готовой сборки
 * побайтно совпадают с vendor\checksums.json.
 *
 * ЗАЧЕМ. После electron-builder в release\win-unpacked\resources\vendor лежат копии
 * вшитых файлов. Если хоть что-то переписало их байты (хук подписи, упаковщик,
 * антивирус на сборочной машине), Confirm-HmArtifact (scripts/windows/_verify.ps1) на
 * машине человека остановит установку каждого такого компонента: «файл подменён».
 * Именно так сломала бы всё первая подписанная сборка: хук подписи получает и чужие
 * exe из extraResources (см. tools/sign-win.js, isOwn). Узнать об этом на сборке —
 * минута; узнать из диалогов поддержки — недели.
 *
 * checksums.json хранит записи по ИМЕНИ файла ({sha256, bytes}); так же ищет их и
 * установщик. Лишнее в сборке, чего нет в манифесте, не проверяется: этим занимаются
 * preflight и release-check.
 *
 * ГДЕ искать файлы манифеста. Только там, откуда их берёт генератор манифеста
 * (tools/regen-checksums.js ← fetch-vendor.ps1): vendor/apps (рекурсивно), course/vibecoding-course.zip,
 * nomad-src.sha256 и nomad-src/pyproject.toml. Поиск «по имени где угодно» давал ложное «красное»
 * на здоровой офлайн-сборке: одноимённый JetBrainsMono-Regular.ttf лежит и в config-pack, и в
 * nomad-src (другой шрифт, 114 904 Б против 273 900 Б), и гейт ловил расхождение там, где его нет.
 *
 * ПУСТОЙ ЗЕЛЁНЫЙ — главный риск этого скрипта (S-7). Раньше он печатал «OK: проверено
 * файлов 0» и выходил с нулём, когда ничего не нашлось; запись без sha256 считалась
 * проверенной; пропавшие файлы только перечислялись. Проверка, которая не умеет
 * краснеть, — украшение, поэтому теперь:
 *   • код 2 — проверять нечего: нет папки или манифеста, манифест не разбирается или пуст,
 *     либо ни один файл из манифеста не найден в сборке и не проверен;
 *   • код 1 — найден дефект: хоть одно расхождение sha256/размера, запись манифеста БЕЗ
 *     sha256 (рантайм-гейт такую запись всё равно отвергнет), либо ОБЯЗАТЕЛЬНЫЙ файл из
 *     манифеста пропал из сборки;
 *   • код 0 — только если проверен хотя бы один файл и дефектов нет.
 *
 * Какие файлы из манифеста ОБЯЗАНЫ быть в сборке. Законное отсутствие бывает двух видов:
 *   1) исключение фильтром упаковки: package.json → build.win.extraResources (to: vendor)
 *      → filter с «!…» (сейчас !apps/chatgpt.vsix — расширение Codex не вшито). Имя файла
 *      берётся из самого фильтра, копии списка здесь нет;
 *   2) lite-сборка: манифест в ней полный, а вшиты только uv и курс. Там скрипту говорят,
 *      ИЗ ЧЕГО собирали (--source vendor-lite): обязательны записи манифеста, чьи файлы лежат
 *      в этой папке и проходят фильтр.
 * Всё остальное, чего нет в сборке, — дефект: упаковщик потерял файл, и на машине человека
 * этот компонент встанет в «файл не найден».
 *
 * Запуск: node tools/verify-packed-vendor.js [<папка vendor внутри сборки>] [--source <папка>]
 *   по умолчанию release/win-unpacked/resources/vendor.
 * Проверяется win-unpacked: итоговый portable-exe — самораспаковывающийся NSIS-архив, заглянуть
 * в него без распаковки нельзя; он собирается из этой же папки в этой же сборке.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHA256_RE = /^[0-9a-f]{64}$/i;

// Относительные пути (от vendor/), где лежат хешируемые файлы. Зеркало regen-checksums.js; тест
// сверяет, что список здесь и там не разъехался.
const HASHED_LOCATIONS = [/^apps\//, /^course\/vibecoding-course\.zip$/, /^nomad-src\.sha256$/, /^nomad-src\/pyproject\.toml$/];
const relOf = (dir, p) => path.relative(dir, p).split(path.sep).join('/');
const isHashedLocation = (rel) => HASHED_LOCATIONS.some((re) => re.test(rel));

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

// Имена файлов, которые фильтр упаковки исключает ПОИМЁННО: «!apps/chatgpt.vsix» → chatgpt.vsix.
// Маски («!playwright-browsers/**») — это каталоги, в манифесте их записей нет; их пропускаем.
function filterExcludedNames(pkg) {
  const pre = require('./preflight-build.js');
  const names = new Set();
  for (const p of pre.winVendorFilter(pkg).patterns) {
    if (typeof p !== 'string' || p[0] !== '!') continue;
    const rel = p.slice(1);
    if (/[*?]/.test(rel)) continue;
    names.add(rel.split('/').pop());
  }
  return names;
}

// Имена файлов в папке-источнике упаковщика, которые прошли бы фильтр упаковки.
function sourceNames(source, pkg) {
  const pre = require('./preflight-build.js');
  const pass = pre.winVendorFilter(pkg).filter;
  const names = new Set();
  for (const p of walk(source, [])) {
    const rel = relOf(source, p);
    if (!isHashedLocation(rel)) continue;
    if (pass(rel)) names.add(path.basename(p));
  }
  return names;
}

/**
 * @param {string} dir  папка vendor внутри сборки (в ней лежит checksums.json)
 * @param {{source?: string, pkg?: object}} [opts]
 * @returns {{checked:number, bad:Array, missing:string[], missingRequired:string[], excused:string[], unhashed:string[], entries:number}}
 *   missing — все имена из манифеста, которых нет в сборке (как и раньше, справочно);
 *   missingRequired — те из них, чьё отсутствие — дефект; excused — законно отсутствующие.
 */
function verify(dir, opts) {
  opts = opts || {};
  const manifestPath = path.join(dir, 'checksums.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = (manifest && typeof manifest === 'object' && manifest.files && typeof manifest.files === 'object') ? manifest.files : {};
  const pkg = opts.pkg || readPackage();
  const excusedByFilter = filterExcludedNames(pkg);
  const inSource = opts.source ? sourceNames(opts.source, pkg) : null;
  const isRequired = (name) => !excusedByFilter.has(name) && (inSource === null || inSource.has(name));

  const byName = new Map();
  for (const p of walk(dir, [])) {
    if (!isHashedLocation(relOf(dir, p))) continue;
    const name = path.basename(p);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(p);
  }
  const res = { checked: 0, bad: [], missing: [], missingRequired: [], excused: [], unhashed: [], entries: Object.keys(files).length };
  for (const [name, entry] of Object.entries(files)) {
    const copies = byName.get(name);
    if (!copies) {
      res.missing.push(name);
      (isRequired(name) ? res.missingRequired : res.excused).push(name);
      continue;
    }
    // Запись без sha256 проверкой считать нельзя: Confirm-HmArtifact (_verify.ps1) сравнивает
    // именно sha256, и пустое значение отвергает любой файл — установка этого компонента встанет.
    const hasHash = entry && typeof entry === 'object' && SHA256_RE.test(String(entry.sha256 || ''));
    if (!hasHash) { res.checked += copies.length; res.unhashed.push(name); continue; }
    for (const p of copies) {
      res.checked++;
      const actual = sha256(p);
      const size = fs.statSync(p).size;
      const why = [];
      if (actual !== String(entry.sha256).toLowerCase()) why.push('sha256');
      if (entry.bytes != null && size !== entry.bytes) why.push('размер');
      if (why.length) {
        res.bad.push({ name, file: path.relative(dir, p), expected: entry.sha256, actual, bytes: size, expectedBytes: entry.bytes, why: why.join('+') });
      }
    }
  }
  return res;
}

function parseArgs(argv) {
  const out = { dir: null, source: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') { out.source = argv[++i] || ''; continue; }
    if (out.dir === null) out.dir = argv[i];
  }
  return out;
}

function main(argv) {
  const a = parseArgs(argv);
  const dir = path.resolve(a.dir || path.join(ROOT, 'release', 'win-unpacked', 'resources', 'vendor'));
  const tag = '[verify-packed-vendor] ';
  if (a.source !== null && !(a.source && fs.existsSync(a.source) && fs.statSync(a.source).isDirectory())) {
    console.error(tag + '--source ' + (a.source || '(пусто)') + ': такой папки нет — не с чем сверять набор вшитых файлов');
    return 2;
  }
  if (!fs.existsSync(path.join(dir, 'checksums.json'))) {
    console.error(tag + 'нет ' + path.join(dir, 'checksums.json') + ' — нечего проверять (сборка ещё не сделана?)');
    return 2;
  }
  let r;
  try {
    r = verify(dir, { source: a.source ? path.resolve(a.source) : null });
  } catch (e) {
    console.error(tag + 'манифест ' + path.join(dir, 'checksums.json') + ' не разобрался: ' + (e && e.message) + ' — проверять нечего');
    return 2;
  }
  if (!r.entries) {
    console.error(tag + 'в checksums.json нет ни одной записи (files пуст) — проверять нечего');
    return 2;
  }
  // Порядок важен: сначала «нечего проверять» (код 2), потом «нашли дефект» (код 1). Если ни один файл
  // из манифеста не найден в сборке, проверять НЕЧЕГО — это не «много дефектов», а пустое место.
  if (r.checked === 0) {
    console.error(tag + 'не проверен ни один файл: из ' + r.entries + ' записей манифеста ни одной нет в ' + dir +
      (r.missing.length ? ' (нет: ' + r.missing.join(', ') + ')' : '') + ' — «зелёный» без проверки обманывает, поэтому код 2');
    return 2;
  }
  for (const b of r.bad) {
    console.error(tag + 'РАСХОЖДЕНИЕ (' + b.why + '): ' + b.file);
    console.error('    ожидалось ' + b.expected + (b.expectedBytes != null ? ' (' + b.expectedBytes + ' Б)' : ''));
    console.error('    в сборке  ' + b.actual + ' (' + b.bytes + ' Б)');
  }
  for (const n of r.unhashed) {
    console.error(tag + 'ЗАПИСЬ БЕЗ SHA-256: ' + n + ' — рантайм-гейт сверяет именно sha256 и остановит установку этого компонента');
  }
  for (const n of r.missingRequired) {
    console.error(tag + 'ПРОПАЛ ИЗ СБОРКИ: ' + n + ' — есть в манифесте и не исключён фильтром упаковки');
  }
  const defects = r.bad.length + r.unhashed.length + r.missingRequired.length;
  if (defects) {
    if (r.bad.length) {
      console.error(tag + r.bad.length + ' файл(ов) в сборке не совпадают с checksums.json: на машине человека ' +
        'Confirm-HmArtifact остановит их установку («файл подменён»). Чаще всего их переписал хук подписи — см. isOwn в tools/sign-win.js.');
    }
    if (r.missingRequired.length && a.source === null) {
      console.error(tag + 'если это lite-сборка (манифест полный, вшиты только uv и курс), укажи --source vendor-lite — тогда обязательны только вшитые файлы.');
    }
    return 1;
  }
  console.log(tag + 'OK: проверено файлов ' + r.checked + ', расхождений нет' +
    (r.excused.length ? ' (в сборке нет законно: ' + r.excused.join(', ') + ')' : ''));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { verify, sha256, main, filterExcludedNames, sourceNames, HASHED_LOCATIONS };
