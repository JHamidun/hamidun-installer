'use strict';
/**
 * check-specs.js — гейт против расхождения спек с кодом.
 *
 * ЗАЧЕМ. Аудит 2026-08-25 нашёл 48 дефектов, и ДВЕНАДЦАТЬ из них — это документы,
 * противоречащие коду; половина высоких была именно там. Ни один такой документ не
 * был помечен устаревшим: они читались как источник правды и отправляли не туда.
 *
 * Из этого следует простое требование: спека, которую нельзя проверить машиной, со
 * временем неизбежно врёт. Поэтому у каждой спеки фиксированная шапка со ссылками на
 * код и на тесты, а этот скрипт держит их живыми:
 *
 *   1. у каждой фичи из docs/specs/_features.json есть файл спеки;
 *   2. нет спек-сирот (фича удалена, документ остался);
 *   3. spec-id внутри файла совпадает с именем файла;
 *   4. каждый путь из «Код:» существует;
 *   5. каждый заголовок теста из «Тесты:» ДОСЛОВНО присутствует в test/run-tests.js;
 *   6. фича с тестом обязана его процитировать — иначе спека скрывает покрытие;
 *   7. обязательные разделы на месте.
 *
 * Пункт 5 — главный. Тест переименовали, спека продолжает ссылаться на старое имя —
 * это ровно начало того самого расхождения, и ловится оно здесь за секунду.
 *
 * Запуск: node tools/check-specs.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SPECS_DIR = path.join(ROOT, 'docs', 'specs');
const FEATURES = path.join(SPECS_DIR, '_features.json');
const TESTS = path.join(ROOT, 'test', 'run-tests.js');

const REQUIRED_SECTIONS = [
  'Что обещает человеку',
  'Как работает',
  'Инварианты',
  'Что ломается, если инвариант нарушить',
  'Границы',
  'Риски и открытые вопросы',
];

// Строка «Тесты: НЕТ» — законный ответ: тестов у фичи может не быть, и врать об этом
// хуже, чем признать. Проверка на такую спеку не ругается, но пункт 6 не даёт
// поставить «НЕТ» там, где инвентарь тест видел.
//
// БЕЗ \b НАМЕРЕННО. В JS \b строится на \w = [A-Za-z0-9_], то есть кириллическая «Т»
// для него НЕ буква, и `/^\s*НЕТ\b/` на строке «НЕТ» не совпадает вовсе. Проверено
// подлогом: честная спека без тестов уезжала в «нечитаемую шапку» — то есть гейт
// наказывал за честность и подталкивал выдумать заголовок теста. Ровно наоборот тому,
// ради чего он написан.
const NO_TESTS = /^\s*НЕТ(?:$|[\s.,;:—–-])/;

function readHeaderField(md, label) {
  const re = new RegExp('^\\s*-\\s*\\*\\*' + label + ':\\*\\*\\s*(.+)$', 'm');
  const m = re.exec(md);
  return m ? m[1].trim() : null;
}

function backticked(s) {
  const out = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1].trim());
  return out;
}

// Заголовки тестов пишутся в «ёлочках»: «...». Кавычки внутри заголовка встречаются,
// поэтому берём нежадно до ближайшей закрывающей.
function quotedTitles(s) {
  const out = [];
  const re = /«([^»]+)»/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1].trim());
  return out;
}

function main() {
  try { process.stdout.reconfigure && process.stdout.reconfigure({ encoding: 'utf8' }); } catch (e) { /* ignore */ }

  if (!fs.existsSync(FEATURES)) {
    console.error('FATAL: нет ' + path.relative(ROOT, FEATURES) + ' — сгенерируй: node tools/extract-features.js');
    return 2;
  }
  const { features } = JSON.parse(fs.readFileSync(FEATURES, 'utf8'));
  const testsSrc = fs.existsSync(TESTS) ? fs.readFileSync(TESTS, 'utf8') : '';
  if (!testsSrc) {
    console.error('FATAL: не читается ' + path.relative(ROOT, TESTS) + ' — сверять заголовки тестов не с чем');
    return 2;
  }

  const problems = [];        // [{ id, kind, text }]
  const add = (id, kind, text) => problems.push({ id, kind, text });

  // README.md здесь — СГЕНЕРИРОВАННЫЙ указатель (tools/extract-features.js), а не
  // спека. Без этого исключения он читался бы как спека-сирота, и гейт требовал бы
  // удалить собственный оглавительный файл.
  const NOT_A_SPEC = new Set(['README.md']);
  const onDisk = fs.existsSync(SPECS_DIR)
    ? fs.readdirSync(SPECS_DIR).filter((n) => n.endsWith('.md') && !n.startsWith('_') && !NOT_A_SPEC.has(n))
    : [];
  const expected = new Set(features.map((f) => f.id + '.md'));

  // (2) сироты
  for (const name of onDisk) {
    if (!expected.has(name)) {
      add(name.replace(/\.md$/, ''), 'сирота',
        'спека есть, а фичи с таким id в инвентаре нет — удали файл или верни фичу в INVENTORY.md');
    }
  }

  let checkedTests = 0;
  let checkedPaths = 0;

  for (const f of features) {
    const file = path.join(SPECS_DIR, f.id + '.md');
    // (1) наличие
    if (!fs.existsSync(file)) { add(f.id, 'нет спеки', 'фича «' + f.name + '» без документа'); continue; }
    const md = fs.readFileSync(file, 'utf8');

    // (3) spec-id
    const idm = /<!--\s*spec-id:\s*([^\s>]+)\s*-->/.exec(md);
    if (!idm) add(f.id, 'нет маркера', 'в файле нет <!-- spec-id: ' + f.id + ' -->');
    else if (idm[1] !== f.id) add(f.id, 'чужой маркер', 'spec-id = «' + idm[1] + '», а файл — ' + f.id + '.md');

    // (7) разделы
    for (const s of REQUIRED_SECTIONS) {
      if (md.indexOf('## ' + s) === -1) add(f.id, 'нет раздела', '«' + s + '»');
    }

    // (4) пути
    const codeLine = readHeaderField(md, 'Код');
    if (!codeLine) add(f.id, 'нет шапки', 'строка «- **Код:** …» отсутствует');
    else {
      const refs = backticked(codeLine);
      if (!refs.length) add(f.id, 'пустая шапка', 'в строке «Код» нет ни одного пути в обратных кавычках');
      for (const ref of refs) {
        const p = ref.split(':')[0];
        if (/[*?]/.test(p)) continue;              // шаблон — не проверяем
        // В строке «Код» допускаются ТОЛЬКО пути. Идентификаторы (`startTips`,
        // `#tips`, `.hidden`) в этой строке — не мелочь стиля: шапка машиночитаемая,
        // и по ней ходит проверка существования. Пустив их, пришлось бы угадывать,
        // «путь это или имя функции», а угадывающая проверка перестаёт быть
        // проверкой. Имена функций и селекторов — в разделы прозы, там им и место.
        if (!p.includes('/') && !/\.[A-Za-z0-9]{1,6}$/.test(p)) {
          add(f.id, 'в строке «Код» не путь', '«' + p + '» — перенеси в текст раздела');
          continue;
        }
        checkedPaths++;
        if (!fs.existsSync(path.join(ROOT, p))) add(f.id, 'путь не существует', p);
      }
    }

    // (5) и (6) тесты
    const testLine = readHeaderField(md, 'Тесты');
    if (!testLine) add(f.id, 'нет шапки', 'строка «- **Тесты:** …» отсутствует');
    else if (NO_TESTS.test(testLine)) {
      if (f.tested === 'yes') {
        add(f.id, 'скрытое покрытие',
          'спека пишет «НЕТ», а инвентарь видел тест — либо найди и процитируй, либо поправь INVENTORY.md');
      }
    } else {
      // Две законные формы цитирования, и вторая появилась не для удобства.
      //
      //   «заголовок»          — тест внутри test/run-tests.js, ищется ДОСЛОВНО;
      //   `test/что-то.test.js` — тест ОТДЕЛЬНЫМ ФАЙЛОМ, проверяется существование.
      //
      // Первая редакция знала только про run-tests.js — и развернула спеку фичи
      // «аудит работоспособности конфига», у которой тесты лежат в
      // test/audit-pack-regex.test.js и test/audit-pack-run.test.js. Агент честно
      // написал «НЕТ», потому что заголовков в run-tests.js нет, а гейт обвинил его
      // в сокрытии покрытия. Виноват был гейт: его модель «все тесты в одном файле»
      // не совпадала с деревом.
      const titles = quotedTitles(testLine);
      const files = backticked(testLine).filter((p) => /^test\//.test(p));
      if (!titles.length && !files.length) {
        add(f.id, 'нечитаемая шапка',
          'в строке «Тесты» нет ни заголовка в «ёлочках», ни пути к тест-файлу, ни слова НЕТ');
      }
      for (const t of titles) {
        checkedTests++;
        if (testsSrc.indexOf(t) === -1) {
          add(f.id, 'теста нет', '«' + t.slice(0, 80) + (t.length > 80 ? '…' : '') + '» не найден в test/run-tests.js');
        }
      }
      for (const p of files) {
        checkedTests++;
        if (!fs.existsSync(path.join(ROOT, p))) add(f.id, 'теста нет', 'файла ' + p + ' не существует');
      }
    }
  }

  // (8) Те же ссылки в PRD и ADR. Правило «документ, который нельзя проверить,
  // со временем врёт» не знает исключений для документов уровнем выше: как раз
  // README и модель угроз в этом проекте разъехались с кодом сильнее всего.
  // Здесь проверка мягче, чем у спек (шапки нет), но путь в обратных кавычках
  // обязан существовать — на этом уже поймана одна неточность в самом ADR-008.
  const PATH_IN_BACKTICKS = /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:js|json|ps1|sh|py|yml|yaml|md|txt|html))(?::[\d,\-]+)?`/g;
  const prose = [];
  if (fs.existsSync(path.join(ROOT, 'docs', 'PRD.md'))) prose.push('docs/PRD.md');
  const adrDir = path.join(ROOT, 'docs', 'adr');
  if (fs.existsSync(adrDir)) {
    for (const n of fs.readdirSync(adrDir)) if (n.endsWith('.md')) prose.push('docs/adr/' + n);
  }
  let checkedProse = 0;
  for (const rel of prose) {
    const md = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let m;
    PATH_IN_BACKTICKS.lastIndex = 0;
    while ((m = PATH_IN_BACKTICKS.exec(md)) !== null) {
      const p = m[1];
      // Голое имя без каталога — почти всегда сокращение в прозе («INVENTORY.md»),
      // а не путь. Требуем каталог: иначе проверка ругалась бы на нормальный текст.
      if (!p.includes('/')) continue;
      if (/[*?]/.test(p)) continue;
      checkedProse++;
      if (!fs.existsSync(path.join(ROOT, p))) add(rel, 'путь не существует', p);
    }
  }

  const withSpec = features.filter((f) => fs.existsSync(path.join(SPECS_DIR, f.id + '.md'))).length;
  console.log('Спеки: ' + withSpec + ' из ' + features.length +
    ' | сверено путей: ' + checkedPaths + ' | сверено заголовков тестов: ' + checkedTests +
    ' | путей в PRD/ADR: ' + checkedProse);

  if (!problems.length) {
    console.log('\nОК: каждая спека ссылается на существующий код и на реально существующие тесты.');
    return 0;
  }

  const byKind = {};
  for (const p of problems) (byKind[p.kind] = byKind[p.kind] || []).push(p);
  console.log('\nПРОБЛЕМ: ' + problems.length);
  for (const [kind, list] of Object.entries(byKind)) {
    console.log('\n  ' + kind + ' (' + list.length + '):');
    for (const p of list.slice(0, 15)) console.log('    ' + p.id.padEnd(42) + ' ' + p.text);
    if (list.length > 15) console.log('    …и ещё ' + (list.length - 15));
  }
  console.log('\nСпека, которую нельзя проверить машиной, со временем врёт. Почини и повтори.');
  return 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
