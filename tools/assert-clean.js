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
 *
 * ПОЧЕМУ ПРОВЕРЯЕМ ОБЕ ПЛАТФОРМЫ СРАЗУ. Проверка отвечает на вопрос «дерево чистое?»,
 * а не «чистое для той сборки, которую я сейчас запускаю». Windows-остаток обязан
 * валить и маковый прогон тоже: собирают эти два издания с одного и того же дерева,
 * и мутацию, оставленную одним, унесёт в релиз другое. Поэтому здесь нет ни одного
 * ветвления по process.platform.
 *
 * ЧТО ИМЕННО МУТИРУЕТ mutatePackage() в tools/build-lite.js (и что, значит, надо
 * проверять): win — extraResources.from и пару имён win/portable; mac — пару имён
 * mac/dmg и, если правило вообще есть, mac.extraResources.from. У каждой платформы
 * пара «общее правило + target-specific», причём target-specific ПЕРЕБИВАЕТ общее,
 * поэтому build-lite.js правит обе половины — и проверять надо обе, иначе застрявшее
 * имя …-Lite обнаружится только на выкладке.
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
// macOS: правила extraResources → vendor у build.mac НЕТ и быть не должно. vendor в .app
// не вшивается (нотаризация спотыкается о неподписанные Mach-O внутри .whl и .tar.gz) —
// он едет сиблингом рядом с .app на томе dmg, том собирает hdiutil в build-mac.yml.
// Поэтому ОТСУТСТВИЕ правила здесь ошибкой не считается, в отличие от win выше. А вот
// правило, показывающее на vendor-lite, — верный признак недовосстановленной lite-сборки:
// mutatePackage() переводит на vendor-lite всё, что найдёт в mac.extraResources, на случай
// если vendor туда однажды всё-таки пропишут.
for (const r of ((pkg.build && pkg.build.mac && pkg.build.mac.extraResources) || [])) {
  if (r && r.from === 'vendor-lite') {
    problems.push(`package.json: build.mac.extraResources.from = «vendor-lite» (to: «${r.to}») — `
      + 'осталось от lite-сборки; офлайн-dmg уехал бы с лёгким vendor вместо полного');
  }
}

for (const [where, name] of [
  ['build.win.artifactName', (pkg.build && pkg.build.win && pkg.build.win.artifactName) || ''],
  ['build.portable.artifactName', (pkg.build && pkg.build.portable && pkg.build.portable.artifactName) || ''],
  ['build.mac.artifactName', (pkg.build && pkg.build.mac && pkg.build.mac.artifactName) || ''],
  ['build.dmg.artifactName', (pkg.build && pkg.build.dmg && pkg.build.dmg.artifactName) || ''],
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
console.log('[assert:clean] package.json и config.json чистые (win + mac) — собираю ОФЛАЙН-издание '
  + 'из полного vendor/, без докачки.');
