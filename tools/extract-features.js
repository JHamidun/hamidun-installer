'use strict';
/**
 * extract-features.js — разбирает docs/INVENTORY.md в машинный список фич.
 *
 * ЗАЧЕМ. Спеки пишутся по инвентарю, и входные данные для этого должны быть
 * ТОЧНЫМИ, а не пересказанными. Пересказ markdown-таблицы «на глаз» — ровно тот
 * способ, которым в этот проект уже приезжали расхождения документов с кодом.
 *
 * Выход — docs/specs/_features.json: id, раздел, имя, описание, пути в коде,
 * есть ли тест. id получается из имени детерминированно (транслитерация +
 * kebab-case), поэтому один и тот же инвентарь всегда даёт одни и те же id, и
 * файл спеки не переезжает от прогона к прогону.
 *
 * Запуск: node tools/extract-features.js [--check]
 *   --check   не писать файл; упасть, если он разошёлся с инвентарём
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INVENTORY = path.join(ROOT, 'docs', 'INVENTORY.md');
const OUT = path.join(ROOT, 'docs', 'specs', '_features.json');
const INDEX = path.join(ROOT, 'docs', 'specs', 'README.md');

// Транслитерация для id. Спека живёт в файле, имя файла должно быть латиницей:
// кириллица в путях уже ломала распаковку курса на macOS (unzip vs ditto).
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function toId(name) {
  const lower = String(name).toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (Object.prototype.hasOwnProperty.call(TRANSLIT, ch)) out += TRANSLIT[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// `path/to/file.js:12-40` или `path/to/file.js` внутри обратных кавычек.
//
// Гоча запятой. В инвентаре пишут `src/main.js:1605-1877,1177-1187` — это ОДИН
// файл с двумя диапазонами, а не два файла. Наивный split(',') давал «файл» с
// именем «1177-1187», и проверка существования путей честно ругалась на 21
// несуществующий файл. Поэтому кусок без разделителя пути и без точки в имени,
// состоящий из цифр и дефисов, приклеивается диапазоном к ПРЕДЫДУЩЕЙ ссылке.
const BARE_RANGE = /^\d+(?:-\d+)?$/;
function parseCodeRefs(cell) {
  const refs = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(cell)) !== null) {
    for (const piece of m[1].split(',')) {
      const raw = piece.trim();
      if (!raw) continue;
      if (BARE_RANGE.test(raw) && refs.length) {
        const prev = refs[refs.length - 1];
        prev.lines = prev.lines ? prev.lines + ',' + raw : raw;
        prev.raw += ',' + raw;
        continue;
      }
      const mm = /^([^\s:]+?)(?::([\d,\-]+))?$/.exec(raw);
      if (!mm) { refs.push({ raw, file: raw, lines: '' }); continue; }
      let file = mm[1];
      // Второе сокращение инвентаря: соседний файл пишут одним именем —
      // `.github/workflows/unit-tests.yml, e2e-win.yml, build-mac.yml`.
      //
      // Но приклеивать каталог предыдущей ссылки ВСЛЕПУЮ нельзя: рядом с
      // `scripts/windows/nomad.ps1` в том же списке стоит корневой `config.json`,
      // и слепая склейка родила «scripts/windows/config.json» — файл, которого нет.
      // Поэтому выбираем из двух кандидатов ТОТ, ЧТО СУЩЕСТВУЕТ: сосед или корень.
      // Разрешение по факту, а не по правилу, — здесь это дешевле и честнее.
      if (!file.includes('/') && !file.includes('\\') && refs.length) {
        const prevDir = refs[refs.length - 1].file.replace(/[^/\\]+$/, '');
        const sibling = prevDir ? prevDir + file : file;
        const exists = (p) => { try { return fs.existsSync(path.join(ROOT, p)); } catch (e) { return false; } };
        if (sibling !== file && exists(sibling) && !exists(file)) file = sibling;
        else if (sibling !== file && !exists(file) && !exists(sibling)) file = sibling; // оба мимо — пусть ругается на более конкретный
      }
      refs.push({ raw, file, lines: mm[2] || '' });
    }
  }
  return refs;
}

function parse() {
  const md = fs.readFileSync(INVENTORY, 'utf8');
  const lines = md.split(/\r?\n/);
  const features = [];
  let section = '';
  let inTable = false;

  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { section = h[1].replace(/\s*\(\d+.*$/, '').trim(); inTable = false; continue; }
    if (/^\|\s*Фича\s*\|/.test(line)) { inTable = true; continue; }
    if (/^\|\s*-{2,}/.test(line)) continue;
    if (!inTable) continue;
    if (!line.startsWith('|')) { inTable = false; continue; }

    // | Фича | Что делает | Где код | Тест | Спека |
    //
    // Экранированная черта `\|` внутри ячейки — ЛИТЕРАЛ, а не разделитель колонок
    // (строка dry-run пишет `scripts/*/*.ps1\|sh`). Наивный split('|') разъезжал
    // колонки на этой одной строке: «Тест» получал обрывок пути, фича считалась
    // непокрытой, и итог расходился с шапкой инвентаря на единицу — 46 против 47.
    // Ошибка ровно того класса, ради которого этот скрипт и написан: пересчёт
    // markdown-таблицы «на глаз» врёт тихо.
    const PIPE = '__HM_PIPE__';
    const cells = line.replace(/\\\|/g, PIPE)
      .split('|').slice(1, -1)
      .map((c) => c.split(PIPE).join('|').trim());
    if (cells.length < 5) continue;
    const [name, what, code, test] = cells;
    if (!name || name === 'Фича') continue;

    features.push({
      id: toId(name),
      section,
      name: name.replace(/\*\*/g, ''),
      what,
      codeRefs: parseCodeRefs(code),
      // «есть» / «не найден» / «**нет**» — нормализуем в три состояния.
      //
      // Без `\b`, и это НАМЕРЕННО. В JavaScript `\b` строится на латинском `\w`,
      // поэтому «т» для него не буква, и `/нет\b/` НЕ совпадает с «нет» в конце
      // строки. Маяк курса помечен `**нет**` и полгода числился не «явное нет», а
      // «теста найти не удалось» — то есть инвентарь тихо путал «решили не писать»
      // с «не нашли». Ровно тот же дефект уже ловили в гейте спек (ADR-008,
      // раздел про честное «НЕТ»); здесь он жил незамеченным, пока не появилась
      // сверка счётчиков.
      tested: /^\*?\*?есть/.test(test) ? 'yes'
        : /^нет(?:$|[\s.,;:—–-])/.test(test.replace(/\*/g, '').trim()) ? 'no'
          : 'unknown',
      testRaw: test.replace(/\*/g, ''),
    });
  }
  return features;
}

// Счётчики в шапках инвентаря («61 фича, покрыто 55», «Экраны (18; покрыто 14)»)
// правятся РУКАМИ, и потому обязаны проверяться машиной — иначе повторится то, что
// уже было: инвентарь месяц занижал покрытие на восемь фич, и по этой цифре
// планировали, что писать дальше. Считаем по строкам таблицы и сверяем.
//
// Разметку в ячейке снимаем: маяк курса помечен `**нет**`, и счётчик без снятия
// звёздочек засчитывал его покрытым. На этом я и споткнулся при первом пересчёте.
const SECTION_COUNTS = /^##\s+(.+?)\s*\((\d+);\s*(?:тестами\s+)?покрыто\s+(\d+)\)\s*$/;
const TOTAL_LINE = /\*\*Всего фич:\s*(\d+)\.\s*Покрыто тестами:\s*(\d+)\s*\((\d+)%\)\.\*\*/;
const UNCOVERED_LINE = /^\*\*Не покрыто (\d+)\.\*\* Явное «нет» — (\d+)\. Теста не нашлось — (\d+)\./;

function verifyCounts(features) {
  const md = fs.readFileSync(INVENTORY, 'utf8');
  const problems = [];

  const actual = new Map(); // раздел без чисел -> [всего, покрыто]
  for (const f of features) {
    const cur = actual.get(f.section) || [0, 0];
    cur[0] += 1;
    if (f.tested === 'yes') cur[1] += 1;
    actual.set(f.section, cur);
  }

  const seen = new Set();
  for (const line of md.split(/\r?\n/)) {
    const m = SECTION_COUNTS.exec(line);
    if (!m) continue;
    const [, name, declTotal, declTested] = m;
    seen.add(name);
    const got = actual.get(name);
    if (!got) { problems.push('шапка «' + name + '» есть, а строк таблицы под ней нет'); continue; }
    if (Number(declTotal) !== got[0] || Number(declTested) !== got[1]) {
      problems.push('«' + name + '»: в шапке ' + declTotal + '/' + declTested
        + ', по строкам таблицы ' + got[0] + '/' + got[1]);
    }
  }
  for (const name of actual.keys()) {
    if (!seen.has(name)) problems.push('у раздела «' + name + '» в шапке нет счётчика (N; покрыто M)');
  }

  const total = features.length;
  const tested = features.filter((f) => f.tested === 'yes').length;
  const explicitNo = features.filter((f) => f.tested === 'no').length;
  const unknown = features.filter((f) => f.tested === 'unknown').length;

  const t = TOTAL_LINE.exec(md);
  if (!t) problems.push('не нашёл строку «Всего фич: N. Покрыто тестами: M (P%)»');
  else {
    if (Number(t[1]) !== total) problems.push('итог «всего фич»: в шапке ' + t[1] + ', по таблице ' + total);
    if (Number(t[2]) !== tested) problems.push('итог «покрыто»: в шапке ' + t[2] + ', по таблице ' + tested);
    const pct = Math.round((tested / total) * 100);
    if (Number(t[3]) !== pct) problems.push('процент покрытия: в шапке ' + t[3] + '%, по таблице ' + pct + '%');
  }

  const u = md.split(/\r?\n/).map((l) => UNCOVERED_LINE.exec(l)).find(Boolean);
  if (!u) {
    problems.push('не нашёл строку «**Не покрыто N.** Явное «нет» — A. Теста не нашлось — B.»');
  } else {
    // Три числа, а не два: «решили не писать тест» и «теста не нашли» — разные
    // состояния, и слияние их в одно уже пряталo реальный пробел за решением.
    if (Number(u[1]) !== explicitNo + unknown) {
      problems.push('«не покрыто»: в шапке ' + u[1] + ', по таблице ' + (explicitNo + unknown));
    }
    if (Number(u[2]) !== explicitNo) {
      problems.push('«явное нет»: в шапке ' + u[2] + ', по таблице ' + explicitNo);
    }
    if (Number(u[3]) !== unknown) {
      problems.push('«теста не нашлось»: в шапке ' + u[3] + ', по таблице ' + unknown);
    }
  }

  return problems;
}

// Указатель по спекам ГЕНЕРИРУЕТСЯ, а не пишется руками — по той же причине, по
// которой существует check-specs.js: рукописный список из шестидесяти одной строки
// разъедется с каталогом на первой же правке, и заметит это никто.
function renderIndex(features) {
  const bySection = new Map();
  for (const f of features) {
    if (!bySection.has(f.section)) bySection.set(f.section, []);
    bySection.get(f.section).push(f);
  }
  const L = [];
  L.push('# Спеки фич');
  L.push('');
  L.push('> Файл СГЕНЕРИРОВАН: `node tools/extract-features.js`. Руками не править —');
  L.push('> перезапишется. Состав берётся из `docs/INVENTORY.md`, расхождение ловит');
  L.push('> `npm run specs:check`.');
  L.push('');
  L.push('Спека описывает ожидаемое поведение одной фичи и обязана быть проверяемой:');
  L.push('пути в шапке существуют, заголовки тестов присутствуют в `test/run-tests.js`');
  L.push('дословно. Иначе документ со временем врёт — см. [ADR-008](../adr/008-machine-checked-specs.md).');
  L.push('');
  L.push('Продукт целиком и сквозные инварианты — [PRD](../PRD.md).');
  L.push('');
  const total = features.length;
  const tested = features.filter((f) => f.tested === 'yes').length;
  L.push('**Фич: ' + total + '. Из них с подтверждённым тестом: ' + tested + '.**');
  L.push('');
  for (const [section, list] of bySection) {
    const t = list.filter((f) => f.tested === 'yes').length;
    L.push('## ' + section + ' — ' + list.length + ' (с тестом ' + t + ')');
    L.push('');
    for (const f of list) {
      const mark = f.tested === 'yes' ? '' : ' — ⚠ тест не подтверждён';
      L.push('- [' + f.name.replace(/\|/g, '\\|') + '](' + f.id + '.md)' + mark);
    }
    L.push('');
  }
  return L.join('\n') + '\n';
}

function main(argv) {
  try { process.stdout.reconfigure && process.stdout.reconfigure({ encoding: 'utf8' }); } catch (e) { /* ignore */ }
  const features = parse();

  const ids = features.map((f) => f.id);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dup.length) {
    console.error('FATAL: одинаковые id — спеки перезаписали бы друг друга: ' + Array.from(new Set(dup)).join(', '));
    return 1;
  }

  // Сверка счётчиков — до записи: расхождение шапки с таблицей означает, что
  // инвентарь врёт, и генерировать из него спеки уже нельзя.
  const countProblems = verifyCounts(features);
  if (countProblems.length) {
    console.error('FATAL: счётчики в шапках INVENTORY.md разошлись с самой таблицей:');
    for (const p of countProblems) console.error('  - ' + p);
    console.error('Числа в шапках правятся руками; пересчитай по строкам таблицы, а не «на глаз».');
    return 1;
  }

  const payload = JSON.stringify({ generatedFrom: 'docs/INVENTORY.md', count: features.length, features }, null, 2) + '\n';
  const index = renderIndex(features);
  const check = argv.includes('--check');

  if (check) {
    const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
    if (read(OUT) !== payload) {
      console.error('--check: docs/specs/_features.json разошёлся с INVENTORY.md. Почини: node tools/extract-features.js');
      return 1;
    }
    if (read(INDEX) !== index) {
      console.error('--check: docs/specs/README.md разошёлся с INVENTORY.md. Почини: node tools/extract-features.js');
      return 1;
    }
    console.log('ОК: список фич и указатель совпадают с инвентарём (' + features.length + ').');
    return 0;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, payload, 'utf8');
  fs.writeFileSync(INDEX, index, 'utf8');
  console.log('Записано: ' + path.relative(ROOT, OUT) + ' и ' + path.relative(ROOT, INDEX) + ' — фич ' + features.length);
  const bySection = {};
  for (const f of features) bySection[f.section] = (bySection[f.section] || 0) + 1;
  for (const [s, n] of Object.entries(bySection)) console.log('  ' + String(n).padStart(3) + '  ' + s);
  const untested = features.filter((f) => f.tested !== 'yes').length;
  console.log('  без подтверждённого теста: ' + untested);
  return 0;
}

module.exports = { parse, toId, parseCodeRefs, verifyCounts };
if (require.main === module) process.exit(main(process.argv.slice(2)));
