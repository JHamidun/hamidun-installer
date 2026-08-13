// electron-builder beforePack hook — ПОСЛЕДНИЙ рубеж предполётных гейтов.
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ npm-СКРИПТА. В package.json уже стоит `npm run preflight` внутри
// dist/dist:win — но это защищает только тех, кто собирает ИМЕННО этой командой.
// `npx electron-builder --win`, ручной прогон из IDE, чужой CI-шаг — всё это идёт
// мимо npm-скрипта, и раньше собирало exe со СТАРЫМ снапшотом конфиг-пака или с
// vendor'ом за потолком makensis, ничего не сказав. Хук beforePack вызывается самим
// electron-builder при ЛЮБОМ способе запуска — обойти его, не правя package.json,
// нельзя. Это и есть смысл дублирования: npm-скрипт даёт БЫСТРЫЙ отказ (до фетчей и
// получасовой упаковки), хук — НЕОБХОДИМЫЙ.
//
// Что проверяется — см. tools/preflight-build.js (свежесть vendor/config-pack по
// .hamidun-config-pack.json против origin + прогноз размера portable-exe против
// 2 ГиБ-потолка 32-битного makensis). Гейты применяются только к тому изданию, к
// которому относятся: lite (config.json edition:'lite') пропускается — там пак не
// вшит вовсе, а размер стережёт свой size-assert в tools/build-lite.js.
const preflight = require('./preflight-build.js');

exports.default = async function beforePack(context) {
  const platform = (context && context.electronPlatformName) || process.platform;
  const rep = preflight.runPreflight({ platform });
  preflight.printPreflight(rep);
  if (rep.level === 'fail') {
    // Бросаем — electron-builder прекращает сборку. Молча продолжить нельзя: ровно
    // это и приводило к выкладке артефакта, про который никто не знает, что в нём.
    const bad = rep.results.filter((r) => r.level === 'fail').map((r) => r.id).join(', ');
    throw new Error('[preflight] сборка остановлена ДО упаковки — не пройдены гейты: ' + bad
      + '. Причины и как починить — в строках выше.');
  }
};
