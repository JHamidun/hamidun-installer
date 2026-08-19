'use strict';
/* assert-clean.js — дерево не осталось мутированным после lite-сборки.
 *
 * ЗАЧЕМ. tools/build-lite.js на время сборки правит ДВА файла и возвращает их назад в
 * finally: package.json (extraResources.from=vendor-lite, artifactName …-Lite) и
 * config.json (edition:'lite', offlineEdition:false). Возврат надёжен, пока процесс
 * доживает до finally, — но он до него не доживает при жёстком убийстве, падении
 * машины или Ctrl+C в неудачный момент.
 *
 * ЧТО БЫЛО НЕ ТАК. Проверка жила однострочником в package.json и смотрела ТОЛЬКО
 * package.json. Непроверенной оставалась ровно та половина, которая опаснее: preflight
 * решает «это lite-издание, гейты офлайн-сборки не применяются» по одному полю —
 * config.json → edition. То есть застрявшее edition:'lite' не просто пачкает дерево,
 * а МОЛЧА ОТКЛЮЧАЕТ ВСЕ предполётные проверки следующей офлайн-сборки: и свежесть
 * пака, и потолок makensis. Сборка при этом выглядит нормальной.
 *
 * Сюда же переехал текст: в JSON-строке он был без кириллицы (экранирование), и
 * человек читал транслит в момент, когда у него что-то сломалось.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];

// --- package.json: чем собираем и как называем ---
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const res = ((pkg.build && pkg.build.win && pkg.build.win.extraResources) || [])
  .find((x) => x && x.to === 'vendor');
if (!res) {
  problems.push('в package.json нет правила extraResources → vendor: офлайн-издание собирать не из чего');
} else if (res.from !== 'vendor') {
  problems.push(`package.json: extraResources.from = «${res.from}» вместо «vendor» — осталось от lite-сборки`);
}
for (const [where, name] of [
  ['build.win.artifactName', (pkg.build && pkg.build.win && pkg.build.win.artifactName) || ''],
  ['build.portable.artifactName', (pkg.build && pkg.build.portable && pkg.build.portable.artifactName) || ''],
]) {
  if (/Lite/.test(name)) problems.push(`package.json: ${where} = «${name}» — имя lite-артефакта осталось`);
}

// --- config.json: издание. Та самая непроверенная половина ---
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
if (cfg.edition === 'lite') {
  problems.push('config.json: edition = «lite» — по этому полю preflight ОТКЛЮЧАЕТ все предполётные '
    + 'гейты («проверять нечего для этого издания»). Офлайн-сборка ушла бы без проверки свежести пака '
    + 'и без потолка makensis, и по логу это выглядело бы нормально');
}
if (cfg.offlineEdition === false) {
  problems.push('config.json: offlineEdition = false — осталось от lite-сборки; офлайн-издание '
    + 'собралось бы с расчётом на докачку компонентов из сети');
}

if (problems.length) {
  console.error('[assert:clean] дерево осталось мутированным после lite-сборки:\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}`));
  console.error('\nВосстановить: git checkout package.json config.json && rm -rf vendor-lite');
  process.exit(1);
}
console.log('[assert:clean] package.json и config.json чистые — собираю ОФЛАЙН-издание из vendor/.');
