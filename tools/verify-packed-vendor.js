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
 * exe из extraResources (см. tools/sign-win.js, isForeign). Узнать об этом на сборке —
 * минута; узнать из диалогов поддержки — недели.
 *
 * checksums.json хранит записи по ИМЕНИ файла ({sha256, bytes}); так же ищет их и
 * установщик. Файла из манифеста может не быть в сборке — это нормально (lite-сборка
 * несёт только uv и курс, chatgpt.vsix исключён фильтром упаковки). Лишнее в сборке,
 * чего нет в манифесте, не проверяется: этим занимаются preflight и release-check.
 *
 * Запуск: node tools/verify-packed-vendor.js [<папка vendor внутри сборки>]
 *   по умолчанию release/win-unpacked/resources/vendor. Код выхода 0 — всё совпало,
 *   1 — есть расхождение (сборка негодна), 2 — нечего проверять (нет папки/манифеста).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

/** @returns {{checked:number, bad:Array, missing:string[]}} */
function verify(dir) {
  const manifestPath = path.join(dir, 'checksums.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = manifest.files || {};
  const byName = new Map();
  for (const p of walk(dir, [])) {
    const name = path.basename(p);
    if (name === 'checksums.json') continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(p);
  }
  const res = { checked: 0, bad: [], missing: [] };
  for (const [name, entry] of Object.entries(files)) {
    const copies = byName.get(name);
    if (!copies) { res.missing.push(name); continue; }
    for (const p of copies) {
      res.checked++;
      const actual = sha256(p);
      const size = fs.statSync(p).size;
      const why = [];
      if (entry.sha256 && actual !== String(entry.sha256).toLowerCase()) why.push('sha256');
      if (entry.bytes != null && size !== entry.bytes) why.push('размер');
      if (why.length) {
        res.bad.push({ name, file: path.relative(dir, p), expected: entry.sha256, actual, bytes: size, expectedBytes: entry.bytes, why: why.join('+') });
      }
    }
  }
  return res;
}

function main(argv) {
  const dir = path.resolve(argv[0] || path.join(ROOT, 'release', 'win-unpacked', 'resources', 'vendor'));
  if (!fs.existsSync(path.join(dir, 'checksums.json'))) {
    console.error('[verify-packed-vendor] нет ' + path.join(dir, 'checksums.json') + ' — нечего проверять (сборка ещё не сделана?)');
    return 2;
  }
  const r = verify(dir);
  for (const b of r.bad) {
    console.error('[verify-packed-vendor] РАСХОЖДЕНИЕ (' + b.why + '): ' + b.file);
    console.error('    ожидалось ' + b.expected + (b.expectedBytes != null ? ' (' + b.expectedBytes + ' Б)' : ''));
    console.error('    в сборке  ' + b.actual + ' (' + b.bytes + ' Б)');
  }
  if (r.bad.length) {
    console.error('[verify-packed-vendor] ' + r.bad.length + ' файл(ов) в сборке не совпадают с checksums.json: на машине человека ' +
      'Confirm-HmArtifact остановит их установку («файл подменён»). Чаще всего их переписал хук подписи — см. isForeign в tools/sign-win.js.');
    return 1;
  }
  console.log('[verify-packed-vendor] OK: проверено файлов ' + r.checked + ', расхождений нет' +
    (r.missing.length ? ' (в сборке нет по манифесту: ' + r.missing.join(', ') + ')' : ''));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { verify, sha256 };
