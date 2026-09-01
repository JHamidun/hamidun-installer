'use strict';
/* release-check.js — ОДИН ПРОГОН, ОДИН ВЕРДИКТ перед выкладкой.
 *
 * ЗАЧЕМ. Проверок перед релизом уже было много, но каждая жила отдельно и запускалась
 * (или не запускалась) по памяти: свежесть vendor — глазами, цифры components.json —
 * `sync-sizes --check`, сверка реестра с checksums — только внутри build-lite, живость
 * зеркал — вообще никем. Пропустить одну из них ничего не стоило, а цена пропуска —
 * артефакт у людей: компонент, которого нет; докачка в мёртвое зеркало; «файл подменён»
 * после честной загрузки. Здесь всё это собрано в один прогон с явным GO / NO-GO.
 *
 * ЗАПУСК:
 *   node tools/release-check.js                    полный прогон (win32 + darwin, с сетью)
 *   node tools/release-check.js --platform win32   только одна платформа
 *   node tools/release-check.js --offline          без сети (зеркала и origin не трогаем)
 *   node tools/release-check.js --deep             + пересчёт SHA-256 файлов vendor
 *   node tools/release-check.js --json             машиночитаемый отчёт
 *
 * Коды выхода: 0 — GO (провалов нет), 1 — NO-GO.
 * Предупреждения (WARN) вердикт не роняют, но печатаются отдельным списком: это то,
 * что сломается не сегодня, а на следующем обновлении.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const preflight = require('./preflight-build.js');
const sync = require('./sync-sizes.js');
const remoteFetch = require(path.join(ROOT, 'src', 'remote-fetch.js'));

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

// Компоненты, у которых ОТСУТСТВИЕ записи в реестре докачки — норма, а не дыра.
//   uv     — BUNDLED_ONLY в src/main.js: едет внутри lite-издания (мал, security-sensitive);
//   course — так же вшит в lite (tools/build-lite.js LITE_KEEP_*);
// Всё остальное, у чего есть вшитый артефакт в vendor, обязано иметь запись: иначе в
// lite-издании компонент недостижим НИ ОТКУДА и уходит в тихий пропуск.
//
// ПРО uv ОТДЕЛЬНО, чтобы не удивляться. Запись для него в реестре ЕСТЬ (win32, с
// sha256 и двумя живыми зеркалами), просто код до неё не доходит: BUNDLED_ONLY берёт
// вшитую копию раньше. То есть послабление написано под случай, который сегодня не
// наступает, и это осознанно — оно страхует от обратного: darwin-записи у uv нет, и
// без послабления гейт требовал бы опубликовать mac-сборку, которой в этой модели
// неоткуда взяться. Опубликованный win32-объект — спящий фолбэк, мёртвый груз
// ценой в несколько мегабайт; удалять его нельзя (content-addressed, ADR-001:
// на него могут ссылаться уже розданные сборки). Подробности — docs/adr/003-uv-bundled-only.md.
const NO_REGISTRY_OK = new Set(['uv', 'course']);

const results = [];   // {section, level:'ok'|'warn'|'fail', msg}
function add(section, level, msg) { results.push({ section, level, msg }); }
const okLine = (s, m) => add(s, 'ok', m);
const warn = (s, m) => add(s, 'warn', m);
const fail = (s, m) => add(s, 'fail', m);

function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
const mib = (b) => (b / MIB).toFixed(1) + ' МиБ';

// --- 1. vendor: манифест целостности и его соответствие диску -----------------
function checkVendor(deep) {
  const S = 'vendor';
  const chkPath = path.join(ROOT, 'vendor', 'checksums.json');
  if (!fs.existsSync(chkPath)) {
    fail(S, 'нет vendor/checksums.json — офлайн-издание собирать нечем, а публиковать компоненты запрещено (push-component.py упадёт). Почини: npm run fetch:vendor');
    return null;
  }
  const chk = JSON.parse(fs.readFileSync(chkPath, 'utf8'));
  const files = chk.files || {};
  const age = Date.now() - Date.parse(chk.generatedAt || 0);
  if (!Object.keys(files).length) { fail(S, 'vendor/checksums.json пуст — манифест целостности ничего не стережёт.'); return chk; }
  if (isFinite(age) && age > 30 * DAY) warn(S, `манифест vendor снят ${Math.round(age / DAY)} дней назад (${chk.generatedAt}) — установщики Cursor/VS Code/Python наверняка обновились.`);
  else okLine(S, `манифест vendor от ${chk.generatedAt}, файлов: ${Object.keys(files).length}`);

  // Манифест описывает vendor/apps/*, course/*, nomad-src.sha256 — ищем по базовому имени.
  const index = new Map(); // basename → [abs]
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(npm-cache|pywheels|config-pack|playwright-browsers.*)$/.test(e.name)) walk(p); }
      else if (e.isFile()) { if (!index.has(e.name)) index.set(e.name, []); index.get(e.name).push(p); }
    }
  };
  walk(path.join(ROOT, 'vendor'));

  const missing = [];
  const wrongSize = [];
  const wrongSha = [];
  for (const [name, meta] of Object.entries(files)) {
    const hits = index.get(name);
    if (!hits || !hits.length) { missing.push(name); continue; }
    const abs = hits[0];
    const sz = fs.statSync(abs).size;
    if (typeof meta.bytes === 'number' && sz !== meta.bytes) { wrongSize.push(`${name}: на диске ${sz}, в манифесте ${meta.bytes}`); continue; }
    if (deep) {
      const h = crypto.createHash('sha256');
      h.update(fs.readFileSync(abs));
      const got = h.digest('hex');
      if (got.toLowerCase() !== String(meta.sha256).toLowerCase()) wrongSha.push(`${name}: sha ${got.slice(0, 12)}… ≠ ${String(meta.sha256).slice(0, 12)}…`);
    }
  }
  // Отсутствие файла в vendor само по себе не провал релиза (mac-раскладка, lite-машина),
  // но РАСХОЖДЕНИЕ размера/sha — провал: ровно оно даёт у человека «файл подменён».
  if (missing.length) warn(S, `в манифесте есть, а в vendor нет: ${missing.join(', ')} (норма для чужой платформы / lite-машины)`);
  if (wrongSize.length) fail(S, 'манифест разошёлся с диском по размеру:\n      ' + wrongSize.join('\n      ') + '\n      Почини: npm run fetch:vendor (перегенерит манифест) и ПЕРЕПУБЛИКУЙ затронутые компоненты.');
  if (wrongSha.length) fail(S, 'манифест разошёлся с диском по SHA-256:\n      ' + wrongSha.join('\n      '));
  if (!missing.length && !wrongSize.length && !wrongSha.length) okLine(S, deep ? 'все файлы манифеста на месте, SHA-256 сходятся' : 'все файлы манифеста на месте, размеры сходятся (SHA — с флагом --deep)');
  return chk;
}

// --- 2. цифры components.json против vendor -----------------------------------
function checkSizes(platform) {
  const S = 'размеры';
  if (platform !== process.platform) { warn(S, `цифры для ${platform} мерятся ТОЛЬКО на ${platform} (часть путей vendor общая — иначе записали бы чужие байты). Прогони release-check на той ОС.`); return; }
  if (!sync.vendorPresent(platform)) { warn(S, `vendor (${platform}-раскладка) не развёрнут — цифры components.json сверить не с чем.`); return; }
  // Считаем ТЕМ ЖЕ путём, что `node tools/sync-sizes.js --check`: компоненты без
  // вшитого артефакта (verify/bridge/desktop-приложения) он честно кладёт в skipped,
  // и выдумывать им «расхождение» нельзя — у них числа и не должно быть.
  const data = sync.readComponents();
  // Бюджет обхода: 240 с по умолчанию (было 60).
  //
  // 01.09 конфиг-пак вырос до 314 навыков, и в 60 с перестали укладываться пять
  // компонентов разом — config, pydeps, nomad, uv, mascot. Гейт честно печатал
  // «не уложились», но по факту это значит, что ПЯТЬ ЦИФР ОН НЕ СВЕРИЛ, а вердикт
  // при этом остался GO. Предупреждение, которое видно в каждом прогоне, за неделю
  // становится фоном — и в тот день, когда цифра действительно разойдётся, его
  // снова пролистают.
  //
  // Замер после роста пака: с бюджетом 600 с обход укладывается целиком. 240 с —
  // с запасом, но всё ещё сторож от зависания, а не «жди сколько потребуется».
  // HM_SIZES_BUDGET_MS=0 снимает предел полностью.
  const budgetRaw = process.env.HM_SIZES_BUDGET_MS;
  const budgetMs = budgetRaw === undefined || budgetRaw === '' ? 240000 : Number(budgetRaw);
  const res = sync.computeSizes(data, platform, { budgetMs });
  const bad = [];
  sync.eachComponent(data, (c) => {
    if (!res.updates.has(c.id)) return;
    const measured = res.updates.get(c.id);
    const stored = (c.sizeBytes && typeof c.sizeBytes[platform] === 'number') ? c.sizeBytes[platform] : undefined;
    if (stored === undefined) { bad.push(`${c.id}: файлы есть (${mib(measured)}), а числа в components.json нет`); return; }
    if (stored !== measured) bad.push(`${c.id}: в components.json ${mib(stored)}, на диске ${mib(measured)}`);
  });
  if (bad.length) fail(S, 'цифра, которую видит человек в попапе «что скачается», разошлась с vendor:\n      ' + bad.join('\n      ') + '\n      Почини одной командой: node tools/sync-sizes.js');
  else okLine(S, `цифры components.json (${platform}) сходятся с vendor: сверено ${res.updates.size}, не мерялось ${res.skipped.length}`);
  if (res.timedOut.length) warn(S, `не уложились в бюджет обхода: ${res.timedOut.join(', ')} — прогони с HM_SIZES_BUDGET_MS=0`);
}

// --- 3. свежесть вшитого конфиг-пака ------------------------------------------
function checkConfigPack(network) {
  const S = 'config-pack';
  const r = preflight.checkConfigFresh({ network });
  const level = r.level === 'fail' ? 'fail' : (r.level === 'warn' ? 'warn' : 'ok');
  add(S, level, r.lines.join('\n      '));
}

// --- 4. реестр докачки против components.json ---------------------------------
function checkRegistry(platforms, chk) {
  const S = 'реестр докачки';
  const reg = readJson('remote-components.json');
  const comps = readJson('components.json');
  const byId = {};
  (comps.groups || []).forEach((g) => (g.components || []).forEach((c) => (byId[c.id] = c)));
  const entriesById = new Map(); // remoteId → [entry]
  for (const e of (reg.components || [])) {
    if (!e || !e.remoteId) { fail(S, 'в реестре есть запись без remoteId'); continue; }
    if (!entriesById.has(e.remoteId)) entriesById.set(e.remoteId, []);
    entriesById.get(e.remoteId).push(e);
  }

  // 4a. висячие записи: remoteId, которому не соответствует ни один компонент.
  // loadRemoteMaps выводит remote СТРОГО по id компонента — такая запись недостижима.
  for (const rid of entriesById.keys()) {
    if (!byId[rid]) fail(S, `запись «${rid}» ни к чему не привязана: компонента с таким id нет в components.json — докачка недостижима (loadRemoteMaps ключуется по id компонента).`);
  }

  // 4b. ГЛАВНАЯ ДЫРА КЛАССА «HANDY»: у компонента есть вшитый артефакт и install-скрипт,
  // но нет записи в реестре. В офлайне он работает, а в lite не существует ни в vendor-lite,
  // ни в облаке — и уходит в тихий graceful skip. Именно так пропал Handy.
  for (const plat of platforms) {
    const parts = sync.VENDOR_PARTS[plat] || {};
    for (const id of Object.keys(parts)) {
      if (!byId[id]) continue;
      if (NO_REGISTRY_OK.has(id)) continue;
      const gate = Array.isArray(byId[id].platforms) && byId[id].platforms.length ? byId[id].platforms : null;
      if (gate && gate.indexOf(plat) === -1) continue; // компонент на этой ОС не показывается
      const e = remoteFetch.pickEntry(reg, id, plat);
      if (!e) {
        fail(S, `«${id}» (${plat}): компонент едет вшитым артефактом (карта vendor в tools/sync-sizes.js) и имеет install-скрипт, а записи в реестре докачки НЕТ.\n`
          + `      В lite-издании этот артефакт не вшит (build-lite.js кладёт только uv+курс+checksums) и качать его неоткуда → тихий пропуск у пользователя.\n`
          + `      Почини: python tools/publish-vendor.py --platform ${plat} --only ${id}   (на ${plat === 'darwin' ? 'маке, после bash tools/fetch-vendor-mac.sh' : 'Windows, после npm run fetch:vendor'})`);
      }
    }
  }

  // 4c. Платформенное покрытие: компонент показан на ОС, а сборки для неё нет.
  // Как только компонент попадает в реестр хотя бы одной платформой, lite считает его
  // удалённым НА ВСЕХ показанных ОС (авто-remote по id) — вторая платформа обязана быть.
  // Проверяем ВСЕ показанные платформы, а не только выбранную флагом: дыра от выбора
  // флага не исчезает. Исключение — NO_REGISTRY_OK: у uv запись win32 в реестре есть,
  // но это СПЯЩИЙ фолбэк (uv — BUNDLED_ONLY в main.js, авто-remote его не берёт), и
  // требовать от него darwin-сборку значит выдумывать блокер на ровном месте.
  for (const [rid] of entriesById) {
    const c = byId[rid];
    if (!c || NO_REGISTRY_OK.has(rid)) continue;
    const gate = Array.isArray(c.platforms) && c.platforms.length ? c.platforms : ['win32', 'darwin'];
    for (const plat of gate) {
      if (!remoteFetch.pickEntry(reg, rid, plat)) {
        fail(S, `«${rid}» показан на ${plat} (components.json platforms), но сборки для ${plat} в реестре нет — в lite человек получит «нет сборки для платформы».`);
      }
    }
  }

  // 4d. install-скрипт записи существует (иначе после докачки сотен МБ — «script not found»).
  for (const e of (reg.components || [])) {
    if (!e.installRelPath) { warn(S, `у «${e.remoteId}/${e.platform || '—'}» нет installRelPath — main выведет путь по id, проверь вручную.`); continue; }
    if (!fs.existsSync(path.join(ROOT, e.installRelPath))) fail(S, `у «${e.remoteId}/${e.platform || '—'}» installRelPath указывает на несуществующий ${e.installRelPath}`);
  }

  // 4e. gatedFiles записи против вшитого vendor/checksums.json — тот же гейт, что в
  // build-lite.js, но здесь он гоняется для ОБЕИХ платформ и до сборки чего угодно.
  //
  // ВАЖНО ПРО ПЛАТФОРМУ: манифест vendor/checksums.json на диске — манифест ЭТОЙ ОС
  // (его генерит свой фетчер), и в артефакт чужой ОС уедет ЧУЖОЙ манифест. Сверять
  // darwin-записи с windows-манифестом бессмысленно: nomad-src.sha256 и pyproject.toml
  // там законно другие, и мы бы «нашли» рассинхрон, которого нет. Поэтому гейт гоняем
  // ТОЛЬКО по записям своей ОС; чужие честно помечаем как непроверенные.
  const manifest = (chk && chk.files) || {};
  let gatedChecked = 0;
  const gatedMissing = [];
  const gatedSkippedPlat = new Set();
  for (const e of (reg.components || [])) {
    if (!platforms.includes(e.platform || 'win32')) continue;
    if ((e.platform || 'win32') !== process.platform) { gatedSkippedPlat.add(e.platform || 'win32'); continue; }
    if (!e.gatedFiles || typeof e.gatedFiles !== 'object') {
      fail(S, `у «${e.remoteId}/${e.platform || '—'}» нет gatedFiles — запись опубликована старой версией push-component.py, сверить с checksums.json нечем. Перепубликуй: python tools/publish-vendor.py --platform ${e.platform || 'win32'} --only ${e.remoteId}`);
      continue;
    }
    for (const [name, sha] of Object.entries(e.gatedFiles)) {
      const local = manifest[name];
      // Раньше здесь стоял голый continue. Но мы уже отфильтровали записи ЧУЖИХ
      // платформ выше — значит имя из gatedFiles обязано быть в манифесте этой ОС.
      // Его отсутствие означает, что опубликованный компонент стережёт файл, которого
      // в локальном vendor нет: либо vendor неполон, либо запись от другой сборки.
      // Молчаливый пропуск превращал это в «сверено 0 файлов» без единого слова.
      if (!local) { gatedMissing.push(`${name} (${e.remoteId}/${e.platform})`); continue; }
      gatedChecked++;
      if (String(local.sha256).toLowerCase() !== String(sha).toLowerCase()) {
        fail(S, `РАССИНХРОН: файл ${name} в опубликованном «${e.remoteId}/${e.platform}» = ${String(sha).slice(0, 12)}…, а во вшитом checksums.json = ${String(local.sha256).slice(0, 12)}… — у КАЖДОГО lite-пользователя компонент упадёт с «файл подменён» ПОСЛЕ честной загрузки. Перепубликуй: python tools/publish-vendor.py --platform ${e.platform} --only ${e.remoteId}`);
      }
    }
  }
  if (gatedChecked) okLine(S, `gatedFiles сверены с вшитым checksums.json (${process.platform}): ${gatedChecked} файл(ов)`);
  if (gatedMissing.length) {
    fail(S, `в манифесте vendor НЕТ файлов, которые стерегут опубликованные записи своей платформы: `
      + `${gatedMissing.slice(0, 6).join(', ')}${gatedMissing.length > 6 ? ` и ещё ${gatedMissing.length - 6}` : ''}. `
      + `Либо vendor неполон (npm run fetch:vendor), либо запись опубликована из другой сборки (перепубликуй компонент).`);
  }
  if (gatedSkippedPlat.size) warn(S, `gatedFiles записей ${[...gatedSkippedPlat].join(', ')} НЕ сверены: на диске манифест ${process.platform}. Прогони release-check на той ОС — иначе рассинхрон «файл подменён» вылезет только у пользователя.`);

  // 4f. схема записей (то же, что стерегут юнит-тесты — но здесь это часть вердикта).
  const seen = new Set();
  for (const e of (reg.components || [])) {
    const k = e.remoteId + '|' + (e.platform || '');
    if (seen.has(k)) fail(S, `дубликат записи (${e.remoteId}, ${e.platform || '—'})`);
    seen.add(k);
    if (e.platform && !['win32', 'darwin', 'linux'].includes(e.platform)) fail(S, `у «${e.remoteId}» недопустимая platform «${e.platform}»`);
    if (!(typeof e.sizeBytes === 'number' && e.sizeBytes > 0)) fail(S, `у «${e.remoteId}/${e.platform || '—'}» нет sizeBytes>0`);
    if (!/^[0-9a-f]{64}$/.test(String(e.sha256 || ''))) fail(S, `у «${e.remoteId}/${e.platform || '—'}» нет 64-hex sha256`);
    if (!Array.isArray(e.mirrors) || !e.mirrors.length) fail(S, `у «${e.remoteId}/${e.platform || '—'}» нет зеркал`);
  }
  return reg;
}

// --- 5. живость зеркал --------------------------------------------------------
async function checkMirrors(reg, platforms) {
  const S = 'зеркала';
  const jobs = [];
  // Считаем пригодные зеркала ПОКОМПОНЕНТНО. Раньше непригодный url давал warn и
  // continue — и компонент, у которого НИ ОДНО зеркало не годится, просто не попадал
  // в проверку: ни одной задачи, ни одного блокера, вердикт GO. То есть чем хуже
  // запись, тем тише она проходила: одно мёртвое зеркало из двух — предупреждение,
  // два мёртвых из двух — тишина. Схема (4f) это не ловит: там проверяется, что
  // массив mirrors НЕ ПУСТ, а не что в нём есть хоть один рабочий адрес.
  const usable = new Map();
  for (const e of (reg.components || [])) {
    if (!platforms.includes(e.platform || 'win32')) continue;
    const key = e.remoteId + '/' + (e.platform || '—');
    if (!usable.has(key)) usable.set(key, 0);
    for (const m of (e.mirrors || [])) {
      if (!m || !remoteFetch.isFetchableUrl(m.url)) { warn(S, `у «${key}» зеркало ${m && m.host} с непригодным url — remote-fetch его не возьмёт.`); continue; }
      usable.set(key, usable.get(key) + 1);
      jobs.push({ e, m });
    }
  }
  for (const [key, n] of usable) {
    if (!n) fail(S, `«${key}»: НИ ОДНОГО пригодного адреса зеркала — remote-fetch не возьмёт ни один, в lite компонент недостижим. Перезалей: python tools/publish-vendor.py --only ${key.split('/')[0]}`);
  }
  // Пустой список задач — это не «нечего проверять», а «проверка не состоялась».
  // Вердикт, выданный без единой сетевой пробы, не должен выглядеть как проверенный.
  if (!jobs.length) {
    if (usable.size) fail(S, 'ни одной пробы не выполнено, хотя записи в реестре есть — живость зеркал НЕ проверена.');
    else warn(S, `в реестре нет записей под ${platforms.join(', ')} — проверять нечего.`);
    return;
  }
  const byEntry = new Map();
  const BATCH = 8;
  // «Не ответил» и «объекта нет» — РАЗНЫЕ вещи, и раньше они смешивались.
  //
  // Проба одна, без повтора, восемь штук разом к двум хостам, таймаут 8 с. Любая
  // заминка CDN (или его лимит на всплеск запросов) читалась как «зеркало мёртво»,
  // а при обоих мёртвых гейт выдавал СТОП с советом перезалить гигабайты. Замер
  // 31.08: три прогона подряд на одной машине дали 7, 3 и 0 «мёртвых» зеркал —
  // то есть измеритель мерил не зеркала, а сеть в этот момент.
  //
  // Формы ответа `probeMirror` различимы (`src/remote-fetch.js`): сетевой отказ и
  // таймаут дают `code` пустым или 0, а ответивший сервер — настоящий HTTP-код.
  // Поэтому повторяем ТОЛЬКО первое: 404/403 — это ответ, его переспрашивать
  // незачем. Повтор идёт по одной пробе, без всплеска.
  const answered = (r) => !!r && typeof r.code === 'number' && r.code > 0;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const slice = jobs.slice(i, i + BATCH);
    /* eslint-disable no-await-in-loop */
    const res = await Promise.all(slice.map((j) => remoteFetch.probeMirror(j.m.url, 8000)));
    for (let k = 0; k < slice.length; k++) {
      if (res[k] && res[k].ok) continue;
      if (answered(res[k])) continue;            // сервер ответил отказом — это факт, не помеха
      res[k] = await remoteFetch.probeMirror(slice[k].m.url, 15000);
    }
    slice.forEach((j, k) => {
      const key = j.e.remoteId + '/' + (j.e.platform || '—');
      if (!byEntry.has(key)) byEntry.set(key, { alive: [], dead: [] });
      const r = res[k] || {};
      (r.ok ? byEntry.get(key).alive : byEntry.get(key).dead).push(j.m.host +
        (r.code ? ` (HTTP ${r.code})` : ' (не ответил дважды)'));
    });
  }
  let allAlive = 0;
  for (const [key, st] of byEntry) {
    if (!st.alive.length) fail(S, `«${key}»: НИ ОДНО зеркало не отдаёт объект (${st.dead.join(', ')}) — в lite компонент недостижим. Перезалей: python tools/publish-vendor.py --only ${key.split('/')[0]}`);
    else if (st.dead.length) warn(S, `«${key}»: живо только ${st.alive.join(', ')}; мёртво ${st.dead.join(', ')} — запас на отказ потерян.`);
    else allAlive++;
  }
  if (allAlive) okLine(S, `${allAlive} компонент(ов) доступны на всех своих зеркалах`);
}

// --- 6. размер против потолка makensis ---------------------------------------
function checkSize() {
  const S = 'размер';
  // Потолок makensis — ограничение УПАКОВЩИКА WINDOWS: 32-битный NSIS падает на mmap
  // около 2 ГиБ. На маке из того же по смыслу vendor собирается .dmg через
  // electron-builder, и makensis там не участвует вовсе — полная маковая сборка на
  // 3,0 ГБ проходит штатно, это прямое доказательство. Пока проверка запускалась
  // безусловно, она валила маковый релиз блокером, которого на маке не существует:
  // mac-vendor 2763,8 МиБ против «потолка» 2048 — NO-GO на работающей сборке.
  // Гейт, останавливающий исправное, вредит ровно так же, как гейт, пропускающий
  // сломанное: и то и другое учит не верить вердикту.
  if (process.platform !== 'win32') {
    warn(S, `потолок makensis не проверяю: это ограничение упаковщика Windows, а здесь `
      + `${process.platform} и .dmg. Windows-редакцию гейтит прогон на Windows.`);
    return;
  }
  const r = preflight.checkNsisLimit({});
  add(S, r.level === 'skip' ? 'warn' : r.level, r.lines.join('\n      '));
  reportBuiltArtifacts(S);
}

// Личные данные в том, что ФИЗИЧЕСКИ доезжает до ученика.
//
// ЗАЧЕМ ОТДЕЛЬНАЯ ПРОВЕРКА. Утечка в репозитории — неприятность; утечка в vendor —
// это файл на диске у каждого, кто поставил установщик, и отозвать его нельзя.
// 29.08.2026 личный путь владельца (C:\Users\<имя>\claude-mascot\…) нашёлся
// захардкоженным в tools/fetch-vendor.ps1 ПУБЛИЧНОГО репозитория, причём `git grep`
// его не видел: файл считался двоичным. Нашёл только сплошной обход с перебором
// кодировок — он здесь и повторён.
//
// Проверяется ровно раздаваемое: снимок конфиг-пака, зип курса, стартовый проект,
// Подпись маяка завершения курса. Проверяем НЕ config.json на диске: там поле
// обязано быть пустым (секрет подставляет сборка, в git он не коммитится), и
// проверка диска краснела бы ровно тогда, когда всё правильно.
//
// Правильный вопрос другой: СМОЖЕТ ли сборка подписать — то есть доступен ли
// секрет в этом окружении. Без него маяк уходит неподписанным, академия помечает
// его недоказанным, и до 01.09.2026 гейт об этом МОЛЧАЛ: вердикт был зелёным, а
// половина продукта работала вхолостую.
//
// WARN, а не СТОП: собирать установщик должен уметь и тот, у кого нет доступа к
// академии. Но молчать об этом нельзя — «не настроено» и «работает» разные вещи.
function checkBeaconSignature() {
  const S = 'маяк курса';
  let fromCreds = '';
  try { fromCreds = require('./stamp-beacon-secret.js').fromCreds('CC_BEACON_SECRET'); }
  catch (e) { /* инструмента нет — ниже скажем честно */ }
  const fromEnv = process.env.HM_COURSE_BEACON_SECRET || '';
  const secret = fromEnv || fromCreds;

  if (secret) {
    add(S, 'ok', 'подпись маяка будет включена: секрет доступен из ' +
      (fromEnv ? 'HM_COURSE_BEACON_SECRET' : 'CC_BEACON_SECRET (креды)') +
      ', длина ' + secret.length + '. В сборке его подставит npm run beacon:stamp.');
  } else {
    add(S, 'warn', 'секрета подписи нет ни в HM_COURSE_BEACON_SECRET, ни в CC_BEACON_SECRET — ' +
      'маяк уйдёт НЕПОДПИСАННЫМ, и академия пометит завершение курса недоказанным.\n' +
      '      Истина живёт в CC_BEACON_SECRET контейнера academy-funnel на vertex; ' +
      'для CI он лежит секретом репозитория HM_COURSE_BEACON_SECRET.');
  }
}

// офлайн-памятка. Не гейт по строгости, а WARN: vendor может быть не развёрнут, и
// падать из-за его отсутствия значило бы останавливать исправное. Но НАЙДЕННОЕ
// валит — это уже не «нечего проверять», а факт.
function checkShippedPrivacy() {
  const S = 'приватность';
  const NEEDLES = ['Users\\hamid', 'Users/hamid', 'C:\\Vibecode', 'C:/Vibecode'];
  const TEXT_EXT = new Set(['md', 'js', 'json', 'py', 'sh', 'ps1', 'txt', 'yml', 'yaml', 'html', 'css']);
  const hits = [];
  let scanned = 0;

  const scanBuf = (name, buf) => {
    scanned++;
    for (const enc of ['utf8', 'utf16le']) {
      let t;
      try { t = buf.toString(enc); } catch (e) { continue; }
      for (const nd of NEEDLES) if (t.indexOf(nd) !== -1) { hits.push(name + ' → ' + nd); return; }
      return;                       // одной кодировки достаточно: utf8 покрывает наши файлы
    }
  };
  const walk = (dir, label) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return false; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') walk(p, label); continue; }
      if (!e.isFile()) continue;
      const ext = (e.name.split('.').pop() || '').toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      let b;
      try { b = fs.readFileSync(p); } catch (e2) { continue; }
      if (b.length > 3 * MIB) continue;
      scanBuf(path.relative(ROOT, p), b);
    }
    return true;
  };

  const targets = [
    [path.join(ROOT, 'vendor', 'config-pack'), 'конфиг-пак'],
    [path.join(ROOT, 'assets', 'starter-project'), 'стартовый проект'],
    [path.join(ROOT, 'assets'), 'assets'],
  ];
  let any = false;
  for (const [dir, label] of targets) if (walk(dir, label)) any = true;

  if (!any || !scanned) {
    warn(S, 'нечего проверять: vendor не развёрнут (нормально до fetch:vendor) — прогони ещё раз перед выкладкой');
    return;
  }
  if (hits.length) {
    fail(S, 'ЛИЧНЫЕ ПУТИ в раздаваемом (отозвать нельзя — файл окажется на диске у каждого):\n      ' + hits.slice(0, 10).join('\n      '));
    return;
  }
  okLine(S, 'в раздаваемом нет личных путей: сверено ' + scanned + ' текстовых файлов');
}

// Фактический размер УЖЕ СОБРАННЫХ артефактов.
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ checkNsisLimit. Тот считает ПРОГНОЗ по содержимому vendor — до
// сборки, чтобы не выпустить заведомо битый exe. А здесь печатается то, что реально
// лежит на диске ПОСЛЕ неё, и печатается ровно там, где человек принимает решение
// «выкладывать или нет».
//
// Без этого текущий размер не зафиксирован нигде, и в репозитории живут три разных
// числа: package.json помнит замер от 19.08 (1 253 186 377 Б), preflight — от 30.07
// (2 045 972 046 Б), а на диске лежит 1 438 688 139 Б. Из этого разнобоя уже вырос
// дефект: сценарий ручного теста требовал сверять с «~2.0 ГБ» — округлением
// ОТМЕНЁННОГО замера, — и тестировщик ставил ✘ на исправном продукте.
//
// Не гейт, а строка отчёта: артефакта может не быть вовсе (release-check гоняют и до
// сборки), а падать из-за отсутствия файла, который эта команда не обязана видеть, —
// значит останавливать исправное.
function reportBuiltArtifacts(S) {
  const NSIS_CEILING = 2 * 1024 * MIB;   // 32-битный makensis падает на mmap около 2 ГиБ
  const known = [
    ['Hamidun-Setup-Windows.exe', true],
    ['Hamidun-Setup-Windows-Lite.exe', true],
    ['Hamidun-Setup-Mac.dmg', false],
    ['Hamidun-Setup-Mac-Lite.dmg', false],
  ];
  const found = [];
  for (const [name, nsisBound] of known) {
    const abs = path.join(ROOT, 'release', name);
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const when = new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
    let line = `${name}: ${st.size} Б (${mib(st.size)}), собран ${when}`;
    if (nsisBound) {
      const left = NSIS_CEILING - st.size;
      line += left > 0
        ? ` — до потолка makensis ${mib(left)}`
        : ` — ПОТОЛОК makensis ПРЕВЫШЕН на ${mib(-left)}`;
      if (left <= 0) fail(S, line);
    }
    found.push([line, nsisBound && st.size >= NSIS_CEILING]);
  }
  if (!found.length) {
    okLine(S, 'собранных артефактов в release/ нет — размер печатать нечего (это не ошибка: проверку гоняют и до сборки)');
    return;
  }
  for (const [line, bad] of found) if (!bad) okLine(S, line);
}

// --- прогон и вердикт ---------------------------------------------------------
async function main(argv) {
  const args = argv.slice(2);
  const network = !args.includes('--offline');
  const deep = args.includes('--deep');
  const json = args.includes('--json');
  // Значение --platform раньше принималось любое. `--platform` без значения давало
  // platforms=[undefined], `--platform --deep` — ['--deep'], опечатка «wind32» проходила
  // как есть. Дальше по такой «платформе» тихо схлопывались проверки реестра и живость
  // зеркал: циклы фильтруют по e.platform и просто не находят ни одной записи. Вердикт
  // при этом печатался обычный, будто прогон был полным. Опечатка в флаге не должна
  // превращать проверку в ничто — она должна её останавливать.
  const KNOWN = ['win32', 'darwin'];
  const pi = args.indexOf('--platform');
  let platforms = KNOWN.slice();
  if (pi !== -1) {
    const v = args[pi + 1];
    if (!v || v.startsWith('--') || !KNOWN.includes(v)) {
      console.error(`release-check: --platform требует значение из ${KNOWN.join(' | ')}, `
        + `получено «${v === undefined ? '(пусто)' : v}».`);
      console.error('Прогон остановлен: с неизвестной платформой молча отключаются проверки');
      console.error('реестра и живость зеркал, а вердикт при этом выглядит полноценным.');
      return 1;
    }
    platforms = [v];
  }

  console.log('== release-check: ' + platforms.join(' + ') + (network ? ' (с сетью)' : ' (офлайн)') + ' ==\n');

  const chk = checkVendor(deep);
  // Размеры сверяются по одной платформе — той, чей vendor лежит на этой машине.
  // Про вторую честно говорим, что не смотрели, вместо молчания.
  checkSizes(platforms.includes('win32') ? 'win32' : platforms[0]);
  const sizeSkipped = platforms.filter((p) => p !== (platforms.includes('win32') ? 'win32' : platforms[0]));
  if (sizeSkipped.length) {
    warn('размеры', `цифры ${sizeSkipped.join(', ')} НЕ сверены: vendor на диске принадлежит `
      + `${platforms.includes('win32') ? 'win32' : platforms[0]}. Прогони release-check на той ОС.`);
  }
  checkConfigPack(network);
  const reg = checkRegistry(platforms, chk);
  checkSize();
  checkShippedPrivacy();
  checkBeaconSignature();
  if (network) await checkMirrors(reg, platforms);
  else warn('зеркала', '--offline: живость зеркал НЕ проверена — перед выкладкой прогони с сетью.');

  const fails = results.filter((r) => r.level === 'fail');
  const warns = results.filter((r) => r.level === 'warn');
  if (json) {
    console.log(JSON.stringify({ verdict: fails.length ? 'NO-GO' : 'GO', results }, null, 2));

    return fails.length ? 1 : 0;
  }
  const TAG = { ok: '  OK ', warn: 'WARN ', fail: 'СТОП ' };
  let section = '';
  for (const r of results) {
    if (r.section !== section) { section = r.section; console.log('-- ' + section + ' --'); }
    console.log(TAG[r.level] + ' ' + r.msg);
  }
  console.log('\n' + '='.repeat(72));
  if (fails.length) {
    console.log(`ВЕРДИКТ: NO-GO — блокеров ${fails.length}, предупреждений ${warns.length}.`);
    console.log('Блокеры:');
    fails.forEach((f, i) => console.log(`  ${i + 1}. [${f.section}] ${f.msg.split('\n')[0]}`));
  } else {
    console.log(`ВЕРДИКТ: GO — блокеров нет, предупреждений ${warns.length}.`);
  }
  if (warns.length) {
    console.log('Предупреждения (сломается не сегодня, а на следующем обновлении):');
    warns.forEach((w, i) => console.log(`  ${i + 1}. [${w.section}] ${w.msg.split('\n')[0]}`));
  }

  // Аварийные выключатели должны быть видны ИМЕННО ЗДЕСЬ. Строка «гейт понижен
  // осознанно» печаталась в теле секции, а в вердикт попадала только ПЕРВАЯ строка
  // сообщения — безобидная «вшито: … @ 24b54b6». Человек, читающий один вердикт (а
  // читают именно его), видел «GO, 2 предупреждения» и не узнавал, что блокер снят
  // рукой. Выключатель, незаметный в итоге, отменяет смысл гейта: следующий, кто
  // выставит переменную «на разок», оставит её навсегда, и не заметит никто.
  const overrides = [
    ['HM_ALLOW_STALE_CONFIG', 'гейт свежести пака понижен до предупреждения'],
    ['HM_ALLOW_OFFLINE_BUILD', 'сверка с origin отключена'],
    ['HM_ALLOW_OVERSIZE', 'потолок makensis не блокирует'],
  ].filter(([k]) => process.env[k]);
  if (overrides.length) {
    console.log('');
    console.log('ВЕРДИКТ ПОЛУЧЕН С ВКЛЮЧЁННЫМИ ВЫКЛЮЧАТЕЛЯМИ — он слабее, чем выглядит:');
    overrides.forEach(([k, why]) => console.log('  • ' + k + '=' + process.env[k] + ' — ' + why));
  }
  return fails.length ? 1 : 0;
}

module.exports = { checkVendor, checkSizes, checkConfigPack, checkRegistry, checkMirrors, NO_REGISTRY_OK };

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code)).catch((e) => { console.error('FATAL release-check:', e); process.exit(1); });
}
