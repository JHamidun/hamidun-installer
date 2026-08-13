#!/usr/bin/env node
/* regen-checksums.js — пересчитать vendor/checksums.json БЕЗ перекачки vendor.
 *
 * ЗАЧЕМ. Манифест генерится внутри fetch-vendor.ps1 последним шагом, и до сих пор
 * единственным способом его обновить была команда `npm run fetch:vendor` — то есть
 * повторная выкачка гигабайтов ради пересчёта хешей уже лежащих на диске файлов.
 * Расхождение при этом возникает от любой правки артефакта на месте: курс пересобрали
 * рядом — release-check честно встал с «манифест разошёлся с диском по размеру».
 *
 * НАБОР ФАЙЛОВ ПОВТОРЯЕТ fetch-vendor.ps1 ДОСЛОВНО (иначе манифест разъедется по составу):
 *   • всё непустое в vendor/apps, РЕКУРСИВНО (Confirm-HmArtifact ищет по ИМЕНИ файла,
 *     путь не важен — поэтому apps/claude-mascot/claude-mascot.exe тоже попадает);
 *   • vendor/course/vibecoding-course.zip — course.ps1 проверяет его fail-closed;
 *   • vendor/nomad-src.sha256 и vendor/nomad-src/pyproject.toml — nomad.ps1 верифицирует
 *     их перед установкой из непроверенного дерева.
 * Ключ записи — БАЗОВОЕ имя файла, как в оригинале. Имена в этом наборе уникальны.
 *
 * Формат байт-в-байт как у ps1: те же поля, тот же порядок (сортировка по имени),
 * CRLF, отступы. Иначе каждый прогон fetch:vendor давал бы шумный дифф.
 *
 * Запуск:  node tools/regen-checksums.js [--check]
 *   --check — не писать, только сказать, разошёлся ли манифест (exit 1 если да).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const OUT = path.join(VENDOR, 'checksums.json');
const CHECK = process.argv.includes('--check');

function walkFiles(dir, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc);
    else if (e.isFile()) {
      let st;
      try { st = fs.statSync(p); } catch (e2) { continue; }
      if (st.size > 0) acc.push(p);   // ps1 фильтрует Length -gt 0
    }
  }
  return acc;
}

const targets = walkFiles(path.join(VENDOR, 'apps'), []);
for (const rel of ['course/vibecoding-course.zip', 'nomad-src.sha256', 'nomad-src/pyproject.toml']) {
  const p = path.join(VENDOR, rel);
  try { if (fs.statSync(p).size > 0) targets.push(p); } catch (e) { /* нет — пропускаем, как ps1 */ }
}

if (!targets.length) {
  console.error('ОШИБКА: в vendor нечего хешировать — vendor не развёрнут?');
  process.exit(2);
}

// Сортировка по ИМЕНИ файла — как Sort-Object Name в оригинале.
targets.sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'en'));

const entries = [];
for (const p of targets) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  entries.push('    "' + path.basename(p) + '": { "sha256": "' + h.digest('hex') +
               '", "bytes": ' + fs.statSync(p).size + ' }');
}

const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const json = '{\r\n  "generatedAt": "' + ts + '",\r\n  "algorithm": "sha256",\r\n  "files": {\r\n' +
             entries.join(',\r\n') + '\r\n  }\r\n}\r\n';

// Сравниваем ТОЛЬКО содержимое files — generatedAt меняется всегда и о расхождении
// ничего не говорит.
const filesOf = (text) => {
  try { return JSON.stringify(JSON.parse(text).files); } catch (e) { return null; }
};
let prev = null;
try { prev = fs.readFileSync(OUT, 'utf8'); } catch (e) { /* нет манифеста */ }
const same = prev && filesOf(prev) === filesOf(json);

console.log('файлов захешировано: ' + entries.length);
if (same) {
  console.log('манифест уже соответствует диску — не трогаю.');
  process.exit(0);
}

if (prev) {
  // Показываем, что именно разошлось — иначе непонятно, почему манифест обновился.
  let before = {};
  try { before = JSON.parse(prev).files || {}; } catch (e) { before = {}; }
  const after = JSON.parse(json).files;
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[k], b = after[k];
    if (!a) console.log('  + ' + k + ' (' + b.bytes + ' Б)');
    else if (!b) console.log('  - ' + k + ' (был ' + a.bytes + ' Б)');
    else if (a.sha256 !== b.sha256) console.log('  ~ ' + k + ': ' + a.bytes + ' -> ' + b.bytes + ' Б');
  }
}

if (CHECK) {
  console.error('\n--check: манифест разошёлся с диском. Почини: node tools/regen-checksums.js');
  process.exit(1);
}
fs.writeFileSync(OUT, json);
console.log('\nЗаписано: ' + OUT);
