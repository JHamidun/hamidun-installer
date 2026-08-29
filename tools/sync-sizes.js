'use strict';
/**
 * sync-sizes.js — ЕДИНСТВЕННЫЙ источник цифр размера в components.json.
 *
 * ЗАЧЕМ. Раньше размер компонента задавался рукописной строкой components.json
 * `sizeHint` («~110 МБ»). Строку никто не пересчитывал при обновлении vendor, и она
 * разъезжалась с реальностью: vscode обещал ~110 МБ при 221,6 МиБ на диске, extension
 * ~10 МБ при 85,6 МиБ, claude ~50 МБ при 1036,8 МиБ. Цифру видно в двух местах —
 * бейджем на карточке и в попапе «Что скачается на мой ПК», то есть ровно там, где мы
 * снимаем страх «а не вирус ли это». Заниженная вдвое сумма рядом с честным файлом на
 * 1,9 ГБ этот страх УСИЛИВАЕТ. Поэтому число теперь не пишут руками — его считают.
 *
 * ЧТО ИМЕННО ОБЕЩАЕТ ЦИФРА (семантика, доказанная кодом и совпавшими хинтами):
 *   sizeBytes[<платформа>] = вес ДИСТРИБУТИВА компонента — сколько байт этот компонент
 *   приносит на ПК из самого установщика (офлайн-издание). Это НЕ след на диске после
 *   распаковки (установленный Git кратно больше git-setup.exe) и НЕ трафик.
 *   Проверка: все хинты, которые исторически сходились, равнялись размеру файла-
 *   дистрибутива — git 62,4 / node 31,4 / handy 20,0 / mascot 104,0 МиБ.
 *
 * ЧТО СЮДА НЕ ПОПАДАЕТ:
 *   • размер докачки в lite-издании — он берётся из remote-components.json (точный
 *     sizeBytes архива) и приезжает в renderer через bootstrap.remoteSizes. Второй копии
 *     этого числа в components.json НЕТ СОЗНАТЕЛЬНО: две копии одного факта = дрейф.
 *   • всё, что качает не установщик, а сам компонент при первом запуске (модель Handy,
 *     Chromium для Playwright, Python для Nomad). Это словами в `sizeNote` — числа там
 *     не измеримы отсюда, а выдумывать их запрещено (см. fail-closed ниже).
 *
 * FAIL-CLOSED. Не смог измерить — НЕ подставляю. Компонент без вшитого артефакта не
 * получает числа вовсе (получает честную пометку `sizeNote`), отсутствующий vendor не
 * стирает уже записанные числа, а --check отличает «разошлось» (exit 1) от «нечего
 * мерить» (exit 0 + явный список).
 *
 * ЗАПУСК:
 *   node tools/sync-sizes.js            пересчитать и записать components.json
 *   node tools/sync-sizes.js --check    ничего не писать; разошлось → exit 1
 *   node tools/sync-sizes.js --platform darwin   считать по mac-раскладке vendor
 *   node tools/sync-sizes.js --json     машиночитаемый отчёт в stdout
 *
 * ПЛАТФОРМЫ. Поле платформенное: один и тот же компонент едет РАЗНЫМИ артефактами
 * (vscode: win 221,6 МиБ setup.exe vs mac 520,1 МиБ zip). Скрипт заполняет ТОЛЬКО ту
 * платформу, чей vendor физически видит, и не трогает чужую. Чтобы появились числа для
 * macOS, запусти этот же скрипт на маке после tools/fetch-vendor-mac.sh.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const COMPONENTS = path.join(ROOT, 'components.json');

// ---------------------------------------------------------------------------
// КАРТА: id компонента → вшитые артефакты (пути относительно vendor/).
//
// Источник истины — сами install-скрипты (что они читают из $HM_VENDOR) и
// tools/publish-vendor.py (состав пака). Ключ карты = id компонента из
// components.json, а НЕ remoteId, чтобы не завести мёртвых записей.
//
// Запись части:
//   'apps/git-setup.exe'    — файл или каталог (каталог считается рекурсивно)
//   {glob:'apps/uv-macos-*.tar.gz', pick:'max'} — арх-варианты одного артефакта:
//       на mac-носителе едут ОБА (arm64 + x86_64), но ставится РОВНО ОДИН, поэтому
//       суммировать их нельзя — берём больший (консервативно, без занижения).
//   {rel:'...', optional:true} — часть может отсутствовать законно.
// ---------------------------------------------------------------------------
// Компоненты, чей вшитый артефакт ФИЗИЧЕСКИ один и тот же на всех платформах —
// значит его размер переносим и его можно записать в чужую платформу с этой машины.
//
// Сейчас такой ровно один: курс. Это закоммиченный в репозиторий zip
// (vendor/course/vibecoding-course.zip, `!vendor/course/` в .gitignore), а не то, что
// раскладывает fetch-vendor под конкретную ОС.
//
// Добавлять сюда можно ТОЛЬКО артефакт, лежащий в репозитории и одинаковый для всех
// ОС. Общий ПУТЬ основанием не является: у claude и nomad пути тоже общие
// (npm-cache/, nomad-src/), а содержимое туда кладёт fetch-vendor — своё для каждой
// системы.
const PLATFORM_INDEPENDENT = new Set(['course']);

const VENDOR_PARTS = {
  win32: {
    // scripts/windows/git.ps1:59
    git: ['apps/git-setup.exe'],
    // scripts/windows/node.ps1:30
    node: ['apps/node-lts.msi'],
    // scripts/windows/vscode.ps1:53. chatgpt.vsix СЮДА НЕ ВХОДИТ: package.json
    // build.win.extraResources фильтром '!apps/chatgpt.vsix' не кладёт его в exe
    // (лимит makensis 2 ГБ) — в офлайне панель Codex ставится из Marketplace.
    vscode: ['apps/vscode-setup.exe'],
    // scripts/windows/cursor.ps1:34
    cursor: ['apps/cursor-setup.exe'],
    // scripts/windows/claude.ps1:184 — офлайн-установка идёт из npm-кеша целиком.
    claude: ['npm-cache'],
    // scripts/windows/extension.ps1:37 + :170 (шрифт). Состав закреплён
    // publish-vendor.py:82-83 — ровно vsix + ttf.
    extension: ['apps/claude-code.vsix', 'apps/JetBrainsMono-Regular.ttf'],
    // src/main.js:1115 HM_BUNDLED_CONFIG → scripts/windows/config.ps1:58
    config: ['config-pack'],
    // scripts/windows/pydeps.ps1:51 + :144. playwright-browsers НЕ входит: тем же
    // фильтром package.json ('!playwright-browsers/**') он в Windows-exe не едет,
    // Chromium докачивается онлайн (pydeps.ps1:182) — это в sizeNote словами.
    pydeps: ['apps/python-setup.exe', 'pywheels'],
    // scripts/windows/course.ps1:31
    course: ['course/vibecoding-course.zip'],
    // scripts/windows/nomad.ps1:88-102 + манифест целостности (nomad.ps1:200-215)
    nomad: ['nomad-src', 'nomad-src.sha256'],
    // scripts/windows/uv.ps1:27 и :42 — обе копии кладутся 1:1
    uv: ['apps/uv'],
    // scripts/windows/mascot.ps1:7 — копия 1:1
    mascot: ['apps/claude-mascot'],
    // scripts/windows/handy.ps1:113 (онлайн-фолбэка нет намеренно)
    handy: ['apps/handy-setup.exe'],
  },
  darwin: {
    git: [{ glob: 'apps/git-macos-*.tar.gz', pick: 'max' }],       // scripts/macos/git.sh:43
    node: ['apps/node.pkg'],                                        // node.sh:11
    vscode: ['apps/vscode.zip'],                                    // vscode.sh:24
    cursor: ['apps/cursor.dmg'],                                    // cursor.sh:9
    claude: ['npm-cache'],                                          // claude.sh:33
    extension: [{ glob: 'apps/claude-code-*.vsix', pick: 'max' },   // extension.sh:11
      'apps/JetBrainsMono-Regular.ttf'],                            // extension.sh:73
    config: ['config-pack'],
    // pydeps.sh:15 (pkg) + :53 (колёса) + :72 (браузеры вшиты, в отличие от Windows)
    pydeps: ['apps/python.pkg', 'pywheels', { glob: 'playwright-browsers-*', pick: 'max' }],
    course: ['course/vibecoding-course.zip'],                       // course.sh:7
    nomad: ['nomad-src', 'nomad-src.sha256'],                       // nomad.sh:37,49
    uv: [{ glob: 'apps/uv-macos-*.tar.gz', pick: 'max' }],          // uv.sh:27
    mascot: ['apps/claude-mascot'],                                 // mascot.sh:41
    handy: [{ glob: 'apps/handy-macos-*.dmg', pick: 'max' }],       // handy.sh:47
  },
};

// Компоненты, у которых вшитого артефакта НЕТ ПО ПОСТРОЕНИЮ. Число им не положено —
// положена честная пометка. Пометка ставится ОДИН РАЗ (если её ещё нет) и дальше
// живёт как обычный текст: слова принадлежат человеку, цифры — этому скрипту.
const NO_BUNDLED_PAYLOAD = {
  // components.json: hidden:true — в UI не показывается вовсе.
  verify: { note: null, why: 'служебный шаг проверки, ничего не приносит' },
  // scripts/windows/bridge.ps1:59 (скрипт из resources/agent, 35 КБ) + :61 —
  // pystray/pillow из ЧУЖИХ vendor/pywheels (они уже посчитаны у pydeps).
  bridge: { note: 'ставится из уже вшитых Python-пакетов', why: 'своего артефакта в vendor нет' },
  // scripts/windows/claude-desktop.ps1:65 — редирект Anthropic, размер знает источник.
  'claude-desktop': { note: 'скачивается во время установки', why: 'качается с сайта Anthropic' },
  // scripts/windows/chatgpt-desktop.ps1 — winget msstore, размер задаёт магазин.
  'chatgpt-desktop': { note: 'размер задаёт магазин приложений · скачивается во время установки',
    why: 'ставится из Microsoft Store / .dmg OpenAI' },
};

// ---------------------------------------------------------------------------
// Измерение
// ---------------------------------------------------------------------------

// Рекурсивный размер файла/каталога. lstat (не stat): симлинк считаем как ссылку,
// а не как её цель — иначе один и тот же файл посчитается дважды.
function sizeOf(abs, deadline) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return st.size;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (deadline && Date.now() > deadline) {
      const e = new Error('превышен бюджет времени на обход ' + abs);
      e.hmTimeout = true;
      throw e;
    }
    const p = path.join(abs, ent.name);
    if (ent.isDirectory()) total += sizeOf(p, deadline);
    else if (ent.isSymbolicLink()) { try { total += fs.lstatSync(p).size; } catch (e) { /* оборванная ссылка */ } }
    else if (ent.isFile()) { try { total += fs.lstatSync(p).size; } catch (e) { /* исчез между readdir и lstat */ } }
  }
  return total;
}

// Раскрытие glob-lite ('apps/uv-macos-*.tar.gz') — только '*' внутри ОДНОГО сегмента.
function expandGlob(rel) {
  const dir = path.dirname(rel);
  const base = path.basename(rel);
  const absDir = path.join(VENDOR, dir === '.' ? '' : dir);
  let names = [];
  try { names = fs.readdirSync(absDir); } catch (e) { return []; }
  const rx = new RegExp('^' + base.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return names.filter((n) => rx.test(n)).sort().map((n) => (dir === '.' ? n : dir + '/' + n));
}

/**
 * Измерить один компонент.
 * @returns {{bytes:number, sources:string[]}} если измерено полностью
 *          {missing:string[]} если хотя бы одна обязательная часть отсутствует
 *          {timeout:true} если не уложились в бюджет
 */
function measureComponent(id, platform, deadline) {
  const parts = (VENDOR_PARTS[platform] || {})[id];
  if (!parts) return { unmapped: true };
  let bytes = 0;
  const sources = [];
  const missing = [];
  for (const raw of parts) {
    const spec = (typeof raw === 'string') ? { rel: raw } : raw;
    if (spec.glob) {
      const hits = expandGlob(spec.glob);
      if (!hits.length) { if (!spec.optional) missing.push(spec.glob); continue; }
      let best = -1; let bestRel = '';
      let sum = 0;
      for (const rel of hits) {
        let sz = 0;
        try { sz = sizeOf(path.join(VENDOR, rel), deadline); }
        catch (e) { if (e.hmTimeout) return { timeout: true }; throw e; }
        sum += sz;
        if (sz > best) { best = sz; bestRel = rel; }
      }
      // pick:'max' — арх-варианты одного артефакта: ставится ровно один.
      if (spec.pick === 'max') { bytes += best; sources.push(bestRel + ' (из ' + hits.length + ' арх-вариантов)'); }
      else { bytes += sum; hits.forEach((h) => sources.push(h)); }
      continue;
    }
    const abs = path.join(VENDOR, spec.rel);
    if (!fs.existsSync(abs)) { if (!spec.optional) missing.push(spec.rel); continue; }
    try { bytes += sizeOf(abs, deadline); }
    catch (e) { if (e.hmTimeout) return { timeout: true }; throw e; }
    sources.push(spec.rel);
  }
  if (missing.length) return { missing };
  if (!sources.length) return { missing: parts.map((p) => (typeof p === 'string' ? p : (p.rel || p.glob))) };
  return { bytes, sources };
}

// Есть ли вообще vendor этой платформы? Признак — хоть одна измеримая часть.
// Нужен, чтобы отличить «чистая машина / lite-чекаут» (мерить нечего, это НЕ ошибка)
// от «vendor есть, но кусок пропал» (это уже сигнал).
function vendorPresent(platform) {
  if (!fs.existsSync(VENDOR)) return false;
  for (const id of Object.keys(VENDOR_PARTS[platform] || {})) {
    const r = measureComponent(id, platform, null);
    if (r && typeof r.bytes === 'number') return true;
  }
  return false;
}

function eachComponent(data, fn) {
  for (const g of (data.groups || [])) for (const c of (g.components || [])) if (c && c.id) fn(c, g);
}

/**
 * Посчитать желаемое состояние размеров.
 * @returns {{updates:Map<string,number>, notes:Map<string,string>, skipped:Array, present:boolean, timedOut:string[]}}
 */
function computeSizes(data, platform, opts) {
  const o = opts || {};
  const deadline = o.budgetMs ? Date.now() + o.budgetMs : null;
  const only = o.only ? new Set(o.only) : null;
  const present = vendorPresent(platform);
  const updates = new Map();   // id → bytes (измерено)
  const notes = new Map();     // id → sizeNote, который нужно проставить (если пусто)
  const skipped = [];          // {id, reason}
  const timedOut = [];
  eachComponent(data, (c) => {
    if (only && !only.has(c.id)) return;
    if (Object.prototype.hasOwnProperty.call(NO_BUNDLED_PAYLOAD, c.id)) {
      const spec = NO_BUNDLED_PAYLOAD[c.id];
      if (spec.note) notes.set(c.id, spec.note);
      skipped.push({ id: c.id, reason: 'вшитого артефакта нет: ' + spec.why, kind: 'no-payload' });
      return;
    }
    const r = measureComponent(c.id, platform, deadline);
    if (r.unmapped) { skipped.push({ id: c.id, reason: 'нет в карте vendor для ' + platform, kind: 'unmapped' }); return; }
    if (r.timeout) { timedOut.push(c.id); skipped.push({ id: c.id, reason: 'не уложился в бюджет времени', kind: 'timeout' }); return; }
    if (r.missing) {
      skipped.push({
        id: c.id,
        reason: 'нет файлов: ' + r.missing.join(', ') + (present ? '' : ' (vendor не развёрнут)'),
        kind: present ? 'missing' : 'no-vendor',
      });
      return;
    }
    updates.set(c.id, r.bytes);
  });
  return { updates, notes, skipped, present, timedOut, platform };
}

// ---------------------------------------------------------------------------
// Запись / сверка
// ---------------------------------------------------------------------------

// Применить результат к разобранному components.json. Возвращает список изменений.
// Идемпотентность: пишем ровно те же числа при тех же файлах, ключи добавляем в
// фиксированном порядке, сериализуем тем же форматом (2 пробела + \n).
function applySizes(data, res) {
  const changes = [];
  eachComponent(data, (c) => {
    // Легаси-поле: рукописная строка, из-за которой всё и разъехалось. Сносим, чтобы
    // числу неоткуда было вернуться мимо этого скрипта.
    if (Object.prototype.hasOwnProperty.call(c, 'sizeHint')) {
      changes.push({ id: c.id, field: 'sizeHint', from: c.sizeHint, to: undefined });
      delete c.sizeHint;
    }
    if (res.notes.has(c.id) && !c.sizeNote) {
      const note = res.notes.get(c.id);
      changes.push({ id: c.id, field: 'sizeNote', from: undefined, to: note });
      c.sizeNote = note;
    }
    if (!res.updates.has(c.id)) return;
    const bytes = res.updates.get(c.id);
    const cur = (c.sizeBytes && typeof c.sizeBytes[res.platform] === 'number') ? c.sizeBytes[res.platform] : undefined;
    if (cur === bytes) return;
    if (!c.sizeBytes || typeof c.sizeBytes !== 'object') c.sizeBytes = {};
    c.sizeBytes[res.platform] = bytes;
    changes.push({ id: c.id, field: 'sizeBytes.' + res.platform, from: cur, to: bytes });
  });
  return changes;
}

function fmtMiB(bytes) {
  const mb = Number(bytes || 0) / (1024 * 1024);
  return (mb >= 1000 ? (mb / 1024).toFixed(2) + ' ГиБ' : mb.toFixed(1) + ' МиБ');
}

function readComponents() {
  return JSON.parse(fs.readFileSync(COMPONENTS, 'utf8'));
}
function serialize(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes('--check');
  const asJson = args.includes('--json');
  const pi = args.findIndex((a) => a === '--platform' || a.startsWith('--platform='));
  let platform = process.platform;
  if (pi !== -1) platform = args[pi].includes('=') ? args[pi].split('=')[1] : args[pi + 1];
  if (!VENDOR_PARTS[platform]) {
    console.error('sync-sizes: неизвестная платформа «' + platform + '». Есть: ' + Object.keys(VENDOR_PARTS).join(', '));
    return 2;
  }
  // ЧУЖУЮ ПЛАТФОРМУ НЕ МЕРЯЕМ. Часть путей общая (npm-cache, config-pack, nomad-src),
  // и `--platform darwin` на Windows тихо записал бы в darwin windows-байты — ровно тот
  // сорт правдоподобной выдумки, ради искоренения которого этот скрипт и написан.
  // mac-числа берутся ТОЛЬКО с мака, после tools/fetch-vendor-mac.sh.
  if (platform !== process.platform && !args.includes('--force')) {
    console.error('sync-sizes: платформа «' + platform + '» не совпадает с текущей ОС («' + process.platform + '»).');
    console.error('Часть путей vendor общая — измерение дало бы правдоподобные, но ЧУЖИЕ байты.');
    console.error('Запусти скрипт на нужной ОС (для macOS — после tools/fetch-vendor-mac.sh) либо, если');
    console.error('точно понимаешь последствия, добавь --force.');
    return 2;
  }

  const raw = fs.readFileSync(COMPONENTS, 'utf8');
  const data = JSON.parse(raw);
  const res = computeSizes(data, platform, {});

  // --force САМ ПО СЕБЕ ничего не защищает: он снимает вопрос, а не опасность.
  // Живой случай 29.08.2026 — понадобилось поправить darwin-размер курса (один и тот
  // же зип на обеих платформах), запуск с `--platform darwin --force` на Windows молча
  // переписал ЕЩЁ ТРИ числа виндовыми байтами: claude 135→103 МиБ, nomad 165→110,
  // mascot 202→279. Все три правдоподобны, ни одно не верно; заметил только потому,
  // что посмотрел дифф, а не код возврата (он был 0).
  //
  // Поэтому запрет теперь ПОКОМПОНЕНТНЫЙ: при измерении чужой платформы пишем только
  // те компоненты, что перечислены в PLATFORM_INDEPENDENT.
  //
  // Сравнивать пути между платформами БЕСПОЛЕЗНО, и это тоже проверено, а не
  // предположено: у claude и nomad пути как раз ОДИНАКОВЫЕ (npm-cache/, nomad-src/) —
  // содержимое туда кладёт fetch-vendor, своё для каждой ОС. То есть совпадение путей
  // здесь признак ОПАСНОСТИ, а не безопасности, и правило «совпали пути — пишем»
  // пропустило ровно те три числа, ради которых заводилось. Переносимость — свойство
  // артефакта, а не пути, и объявить её можно только руками.
  if (platform !== process.platform) {
    const dropped = [];
    for (const id of Array.from(res.updates.keys())) {
      if (!PLATFORM_INDEPENDENT.has(id)) { dropped.push(id); res.updates.delete(id); }
    }
    if (dropped.length) {
      console.log('НЕ ПИШУ (артефакт свой у каждой ОС — байты с этой машины про него ничего не говорят): ' + dropped.join(', '));
      console.log('  Эти числа берутся только на самой ' + platform + ', после fetch-vendor.');
    }
  }

  const changes = applySizes(data, res);
  const out = serialize(data);

  if (asJson) {
    console.log(JSON.stringify({
      platform, vendorPresent: res.present,
      measured: Object.fromEntries(res.updates),
      skipped: res.skipped, changes,
    }, null, 2));
    return (check && changes.length) ? 1 : 0;
  }

  console.log('sync-sizes: платформа ' + platform + ', vendor ' + (res.present ? 'найден' : 'НЕ развёрнут') + ' (' + VENDOR + ')');
  if (res.updates.size) {
    console.log('\nИЗМЕРЕНО (вес дистрибутива внутри установщика):');
    let sum = 0;
    for (const [id, b] of res.updates) { sum += b; console.log('  ' + id.padEnd(18) + String(b).padStart(12) + '  ' + fmtMiB(b)); }
    console.log('  ' + 'ИТОГО'.padEnd(18) + String(sum).padStart(12) + '  ' + fmtMiB(sum));
  }
  if (res.skipped.length) {
    console.log('\nБЕЗ ЧИСЛА (ничего не выдумываем):');
    for (const s of res.skipped) console.log('  ' + s.id.padEnd(18) + s.reason);
  }
  if (!res.present) {
    console.log('\nvendor для этой платформы не развёрнут — уже записанные числа НЕ трогаю.');
    console.log('Чтобы появились числа для macOS, запусти этот же скрипт на маке после tools/fetch-vendor-mac.sh.');
  }

  if (!changes.length) {
    // Разводим два РАЗНЫХ исхода, которые раньше печатались одинаково.
    // Без vendor сверять физически не с чем, а скрипт бодро сообщал «ОК: соответствует
    // vendor» и возвращал 0. На чистой машине и в CI это читалось как «числа проверены»,
    // хотя не было проверено ни одно — тот самый случай, когда сигнал не доказывает
    // утверждения. Код возврата оставляем нулевым (в CI действительно нечего делать),
    // но формулировка обязана называть вещи своими именами.
    if (!res.present) {
      console.log('\nПРОПУЩЕНО: vendor не развёрнут — НИ ОДНО число не сверено.');
      console.log('Чтобы сверить: tools/fetch-vendor.ps1 (Windows) или tools/fetch-vendor-mac.sh (macOS),');
      console.log('затем node tools/sync-sizes.js --check');
      return 0;
    }
    console.log('\nОК: все сверенные числа совпали с vendor — файл не тронут.');
    return 0;
  }
  console.log('\nРАСХОЖДЕНИЯ (' + changes.length + '):');
  for (const ch of changes) {
    const from = ch.from === undefined ? '—' : (typeof ch.from === 'number' ? ch.from + ' (' + fmtMiB(ch.from) + ')' : JSON.stringify(ch.from));
    const to = ch.to === undefined ? 'удалено' : (typeof ch.to === 'number' ? ch.to + ' (' + fmtMiB(ch.to) + ')' : JSON.stringify(ch.to));
    console.log('  ' + ch.id.padEnd(18) + ch.field.padEnd(18) + from + '  →  ' + to);
  }
  if (check) {
    console.error('\n--check: components.json разошёлся с vendor. Почини: node tools/sync-sizes.js');
    return 1;
  }
  if (out === raw) { console.log('\nФайл байт-в-байт прежний — не переписываю.'); return 0; }
  fs.writeFileSync(COMPONENTS, out, 'utf8');
  console.log('\nЗаписано: ' + COMPONENTS);
  return 0;
}

module.exports = {
  VENDOR_PARTS, NO_BUNDLED_PAYLOAD, VENDOR, COMPONENTS,
  sizeOf, expandGlob, measureComponent, vendorPresent, computeSizes, applySizes,
  readComponents, serialize, eachComponent, fmtMiB, PLATFORM_INDEPENDENT,
};

if (require.main === module) process.exit(main(process.argv));
