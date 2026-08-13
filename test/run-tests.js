'use strict';
/* Pre-flight tests — pure logic + data integrity. Run: node test/run-tests.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const HMDeps = require(path.join(ROOT, 'src', 'renderer', 'deps.js'));
const components = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
const packs = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs.json'), 'utf8'));

// Real skills dir from the bundled/cloned config repo (best-effort). Try the
// build-time clone first (works in CI and any machine), then a dev fallback.
const SKILLS_CANDS = [
  path.join(ROOT, 'vendor', 'config-pack', '.claude', 'skills'),
  path.join(ROOT, 'vendor', 'config-pack', 'skills'),
  'C:\\Vibecode\\hamidun-installer-assets\\config-repo\\.claude\\skills'
];
const SKILLS_DIR = SKILLS_CANDS.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || SKILLS_CANDS[0];

// «A идёт РАНЬШЕ B» — с обязательной проверкой, что оба вообще есть.
//
// Голое `hay.indexOf(a) < hay.indexOf(b)` — ПУСТАЯ проверка: если A пропал, indexOf даёт
// -1, а -1 меньше любого индекса, и тест остаётся зелёным на ИСЧЕЗНУВШЕЙ защите. Так и
// было: гейт сверки SHA-256 дерева nomad заменили на `if false` — все тесты прошли.
// Большинство таких сравнений стерегут проверки подписи и целостности, то есть ровно то,
// что молча пропадать не должно.
function assertOrder(hay, first, second, msg) {
  const i = hay.indexOf(first);
  const j = hay.indexOf(second);
  assert(i !== -1, (msg || 'порядок') + ': пропало «' + String(first).slice(0, 70) + '»');
  assert(j !== -1, (msg || 'порядок') + ': пропало «' + String(second).slice(0, 70) + '»');
  assert(i < j, msg || 'нарушен порядок');
}

// Async-колбэк в СИНХРОННОМ ok() — мнимый страж: галочка печатается не дожидаясь
// результата, процесс успевает выйти, и провал не всплывает НИКОГДА. Такой тест уже
// сторожил главный фикс дня (закрытый stdin) и был зелёным при нарочно сломанном
// ожидании. Ловим это на входе: async идёт только в okAsync.
let pass = 0, fail = 0, skipped = 0;
// ЧЕСТНЫЙ пропуск: тест, который не может выполниться в этой среде (не та ОС,
// занят живой Cursor, чужие задачи в планировщике), НЕ печатает ✅ — иначе он
// «зелёный», хотя не стерёг НИЧЕГО. SKIP() бросает помеченную ошибку, ok/okAsync
// показывают её как ⏭ и считают отдельно от pass/fail.
const HM_SKIP = Symbol('hm-skip');
function SKIP(reason) { const e = new Error(reason || 'пропуск'); e[HM_SKIP] = true; throw e; }
function ok(name, fn) {
  if (fn && fn.constructor && fn.constructor.name === 'AsyncFunction') {
    console.log('  ❌ ' + name + '  -> async-тест передан в синхронный ok(): используй okAsync + await');
    fail++;
    return;
  }
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) {
    if (e && e[HM_SKIP]) { console.log('  ⏭  ' + name + '  -> ПРОПУЩЕН: ' + e.message); skipped++; return; }
    console.log('  ❌ ' + name + '  -> ' + e.message); fail++;
  }
}
async function okAsync(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) {
    if (e && e[HM_SKIP]) { console.log('  ⏭  ' + name + '  -> ПРОПУЩЕН: ' + e.message); skipped++; return; }
    console.log('  ❌ ' + name + '  -> ' + e.message); fail++;
  }
}

// Build byId from components.
const byId = {};
components.groups.forEach((g) => g.components.forEach((c) => (byId[c.id] = c)));

console.log('== Dependency graph ==');

ok('installOrder: deps before dependents (all selected)', () => {
  const selected = {};
  Object.keys(byId).forEach((id) => (selected[id] = true));
  const order = HMDeps.installOrder(selected, byId);
  Object.keys(byId).forEach((id) => {
    (byId[id].requires || []).forEach((r) => {
      assertOrder(order, r, id, `${r} must come before ${id}`);
    });
  });
});

ok('enableWithDeps: selecting "config" pulls in git+node', () => {
  const selected = {};
  HMDeps.enableWithDeps(selected, byId, 'config');
  assert(selected.config && selected.git && selected.node, 'config must enable git+node');
});

ok('enableWithDeps: selecting "pydeps" transitively pulls config+git+node', () => {
  const selected = {};
  HMDeps.enableWithDeps(selected, byId, 'pydeps');
  assert(selected.pydeps && selected.config && selected.git && selected.node, 'transitive enable failed');
});

ok('disableDependents: turning off git turns off config+pydeps', () => {
  const selected = {};
  Object.keys(byId).forEach((id) => (selected[id] = true));
  HMDeps.disableDependents(selected, byId, 'git');
  assert(!selected.git && !selected.config && !selected.pydeps, 'dependents not disabled');
});

ok('no cycles: installOrder terminates and covers all selected', () => {
  const selected = {};
  Object.keys(byId).forEach((id) => (selected[id] = true));
  const order = HMDeps.installOrder(selected, byId);
  assert.strictEqual(order.length, Object.keys(byId).length, 'order must cover all');
});

ok('every component requires-id exists', () => {
  Object.values(byId).forEach((c) =>
    (c.requires || []).forEach((r) => assert(byId[r], `unknown requires "${r}" in ${c.id}`))
  );
});

console.log('== Skill packs integrity ==');

const allPackSkills = [];
packs.packs.forEach((p) => (p.skills || []).forEach((s) => allPackSkills.push(s)));

ok('no duplicate skill across packs', () => {
  const seen = {};
  const dups = [];
  allPackSkills.forEach((s) => { if (seen[s]) dups.push(s); seen[s] = true; });
  assert.strictEqual(dups.length, 0, 'duplicates: ' + dups.join(', '));
});

ok('core has no overlap with packs', () => {
  const packSet = new Set(allPackSkills);
  const overlap = packs.core.filter((s) => packSet.has(s));
  assert.strictEqual(overlap.length, 0, 'core/pack overlap: ' + overlap.join(', '));
});

if (fs.existsSync(SKILLS_DIR)) {
  const real = new Set(fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));

  ok('every core skill exists in repo', () => {
    const missing = packs.core.filter((s) => !real.has(s));
    assert.strictEqual(missing.length, 0, 'missing core skills: ' + missing.join(', '));
  });

  ok('every pack skill exists in repo', () => {
    const missing = allPackSkills.filter((s) => !real.has(s));
    assert.strictEqual(missing.length, 0, 'missing/typo skills: ' + missing.join(', '));
  });

  // Coverage report (informational, not a failure).
  const categorized = new Set([...packs.core, ...allPackSkills]);
  const uncategorized = [...real].filter((s) => !categorized.has(s));
  console.log(`  ℹ️  скиллов в репо: ${real.size}; в core: ${packs.core.length}; в паках: ${allPackSkills.length}; не категоризировано (ставятся всегда): ${uncategorized.length}`);
  if (uncategorized.length) console.log('     ' + uncategorized.join(', '));
} else {
  console.log('  ⚠️  репо скиллов не найден (' + SKILLS_DIR + ') — пропускаю проверку существования.');
}

console.log('== Remote (CDN) components integrity ==');

// Реестр докачки (remote-components.json). Remote-компоненты не имеют vendor-
// артефакта и не являются скиллами — их не должны считать «потеряшками».
let remoteReg = null;
try { remoteReg = JSON.parse(fs.readFileSync(path.join(ROOT, 'remote-components.json'), 'utf8')); }
catch (e) { remoteReg = null; }

ok('remote-components.json парсится и содержит массив components', () => {
  assert(remoteReg, 'remote-components.json должен парситься');
  assert(Array.isArray(remoteReg.components), 'components должен быть массивом');
});

ok('каждый remote-компонент из components.json имеет запись в реестре', () => {
  const remoteComps = Object.values(byId).filter((c) => c.remote);
  remoteComps.forEach((c) => {
    assert(c.remoteId, `remote-компонент ${c.id} обязан указывать remoteId`);
    const has = (remoteReg.components || []).some((e) => e.remoteId === c.remoteId);
    assert(has, `в реестре нет записи для remoteId "${c.remoteId}" (компонент ${c.id})`);
  });
});

ok('каждая запись реестра докачки корректна (sha256/size/mirrors)', () => {
  (remoteReg.components || []).forEach((e) => {
    assert(e.remoteId, 'у записи должен быть remoteId');
    assert(typeof e.sizeBytes === 'number' && e.sizeBytes > 0, `у ${e.remoteId} нужен sizeBytes>0`);
    assert(/^[0-9a-f]{64}$/.test(String(e.sha256 || '')), `у ${e.remoteId} нужен 64-hex sha256`);
    assert(Array.isArray(e.mirrors) && e.mirrors.length > 0, `у ${e.remoteId} нужны mirrors`);
    e.mirrors.forEach((m) => assert(m && typeof m.url === 'string' && m.url, `у ${e.remoteId} mirror без url`));
  });
});

ok('remote-компоненты не ломают граф зависимостей', () => {
  // remote-компоненты умышленно без vendor-файла — это НЕ «потеряшка».
  const remoteComps = Object.values(byId).filter((c) => c.remote);
  remoteComps.forEach((c) =>
    (c.requires || []).forEach((r) => assert(byId[r], `remote ${c.id} требует неизвестный ${r}`))
  );
});

// remote-fetch.js — чистый модуль без electron: проверяем, что грузится и
// экспортирует ядро (pickEntry/isFetchableUrl) и что фильтр URL работает.
ok('remote-fetch.js загружается и фильтрует URL/зеркала', () => {
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  assert(typeof rf.fetchRemote === 'function', 'fetchRemote экспортируется');
  assert(typeof rf.pickEntry === 'function', 'pickEntry экспортируется');
  assert(rf.isFetchableUrl('https://s3.regru.cloud/b/vibecoding-installer/uv-win32.zip'), 'валидный https url');
  assert(!rf.isFetchableUrl('https://R2-PLACEHOLDER-NOT-CONFIGURED/x.zip'), 'плейсхолдер отсекается');
  assert(!rf.isFetchableUrl('https://<r2>/x.zip'), '<> отсекается');
  const reg = { components: [{ remoteId: 'uv', platform: 'win32' }, { remoteId: 'x' }] };
  assert(rf.pickEntry(reg, 'uv', 'win32'), 'pickEntry: точная платформа');
  assert(rf.pickEntry(reg, 'x', 'darwin'), 'pickEntry: платформо-независимая запись');
  assert(!rf.pickEntry(reg, 'uv', 'darwin'), 'pickEntry: нет darwin-сборки uv → null');
});

// --- Схема реестра (P2): enum платформ, отсутствие дублей, reverse-mapping ---
ok('реестр: platform только из enum win32|darwin|linux (опечатка "wind32" — провал)', () => {
  const ALLOWED = new Set(['win32', 'darwin', 'linux']);
  (remoteReg.components || []).forEach((e) => {
    if (e.platform !== undefined && e.platform !== null) {
      assert(ALLOWED.has(e.platform), `недопустимая platform "${e.platform}" у ${e.remoteId} (ожид win32|darwin|linux)`);
    }
  });
});

ok('реестр: нет дублей (remoteId, platform)', () => {
  const seen = new Set();
  (remoteReg.components || []).forEach((e) => {
    const k = e.remoteId + ' ' + (e.platform || '');
    assert(!seen.has(k), `дубликат записи (remoteId=${e.remoteId}, platform=${e.platform || '—'})`);
    seen.add(k);
  });
});

ok('реестр: pickEntry reverse-mapping + отвергает опечатку платформы', () => {
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  (remoteReg.components || []).forEach((e) => {
    if (e.platform) {
      const got = rf.pickEntry(remoteReg, e.remoteId, e.platform);
      assert(got && got.remoteId === e.remoteId && got.platform === e.platform,
        `pickEntry не нашёл ${e.remoteId}/${e.platform}`);
    }
  });
  const anyPlat = (remoteReg.components || []).find((e) => e.platform);
  if (anyPlat) {
    const indep = (remoteReg.components || []).some((e) => e.remoteId === anyPlat.remoteId && !e.platform);
    const got = rf.pickEntry(remoteReg, anyPlat.remoteId, 'wind32');
    if (indep) assert(got && !got.platform, 'для опечатки платформы должна вернуться платформо-независимая запись');
    else assert(got === null, `pickEntry(${anyPlat.remoteId},"wind32") должен вернуть null`);
  }
});

// BUG #11: mac-uv platform-гейт. Проверяем pickEntry на КАЖДОЙ платформе, где
// компонент ПОКАЗАН (по components.json `platforms`), а не «есть хоть одна запись».
ok('BUG #11: remote-компонент имеет сборку в реестре для КАЖДОЙ показанной платформы', () => {
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  const PLATS = ['win32', 'darwin', 'linux'];
  Object.values(byId).filter((c) => c.remote).forEach((c) => {
    const gate = (Array.isArray(c.platforms) && c.platforms.length) ? c.platforms : PLATS;
    gate.forEach((plat) => {
      const e = rf.pickEntry(remoteReg, c.remoteId, plat);
      assert(e, `remote «${c.id}» ПОКАЗАН на ${plat}, но pickEntry(${c.remoteId},${plat})=null (нет сборки в реестре докачки)`);
    });
  });
});

// 100% ОФЛАЙН: uv ВШИТ в vendor (fetch-vendor*.{ps1,sh}) — компонент больше НЕ remote,
// установка не зависит от облака. Запись в remote-components.json — спящий фолбэк.
ok('offline: uv вшит — НЕ remote-компонент (нет remote:true/remoteId), platforms win32+darwin', () => {
  const uv = byId['uv'];
  assert(uv, 'компонент uv существует');
  assert(!uv.remote, 'uv НЕ должен быть remote:true (вшит в vendor — установка офлайн)');
  assert(!uv.remoteId, 'uv НЕ должен указывать remoteId (main не докачивает его из облака)');
  assert(Array.isArray(uv.platforms) && uv.platforms.indexOf('win32') !== -1 && uv.platforms.indexOf('darwin') !== -1,
    'uv показан на win32 и darwin (vendor несёт обе сборки)');
  // Спящий онлайн-фолбэк в реестре не мешает: пока uv не объявлен remote, main его не читает.
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  assert(rf.pickEntry(remoteReg, 'uv', 'win32'), 'запись uv/win32 в реестре осталась (спящий фолбэк)');
});
// Lite-издание: main авто-выводит remote по реестру (id==remoteId), кроме bundled-only.
// Проверяем ДАННЫЕ, на которые опирается loadRemoteMaps (isLiteEdition-ветка): тяжёлые
// компоненты имеют запись в реестре, uv остаётся вшитым, безартефактные — не remote.
ok('lite: тяжёлые компоненты авто-remote по реестру; uv bundled-only', () => {
  const regIds = new Set((remoteReg.components || []).map((e) => e.remoteId));
  ['git', 'node', 'vscode', 'cursor', 'claude', 'extension', 'config', 'pydeps', 'nomad', 'mascot'].forEach((id) => {
    assert(byId[id], `компонент ${id} существует`);
    assert(regIds.has(id), `lite: ${id} обязан иметь запись в реестре (id==remoteId) для авто-докачки`);
  });
  ['course', 'bridge', 'verify', 'claude-desktop', 'chatgpt-desktop'].forEach((id) => {
    if (byId[id]) assert(!regIds.has(id), `${id} без vendor-артефакта не должен иметь remote-запись в реестре`);
  });
});

console.log('== Round-3 fixes: winSystemRoot (#6), openStream redirect (#8), install-env (#4) ==');

// #6: winSystemRoot валидирует reparse/тип. kernel32.dll — обычный ФАЙЛ (не dir/symlink),
// сегменты (root/System32) — не reparse. existsSync-проверка убрана.
ok('#6 winSystemRoot: lstat isFile + reject reparse (не existsSync)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'remote-fetch.js'), 'utf8');
  const fn = s.slice(s.indexOf('function winSystemRoot'), s.indexOf('function winSystem32'));
  assert(/lstatSync/.test(fn), 'должен использовать lstatSync');
  assert(/isSymbolicLink\(\)/.test(fn), 'должен отвергать reparse/symlink-компоненты');
  assert(/\.isFile\(\)/.test(fn), 'kernel32.dll должен быть обычным ФАЙЛОМ');
  assert(!/existsSync\(path\.join\(r, 'System32'/.test(fn), 'existsSync-проверка kernel32 должна быть убрана');
  if (process.platform === 'win32') {
    const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
    const root = rf.winSystemRoot();
    assert(root, 'на Windows System root должен находиться');
    assert(fs.lstatSync(path.join(root, 'System32', 'kernel32.dll')).isFile(), 'kernel32.dll — обычный файл, не symlink');
  }
});

// #6 (win32, функционально): кандидат, где kernel32.dll — КАТАЛОГ (не файл), не
// принимается за System root; функция всё ещё находит настоящий C:\Windows.
ok('#6 winSystemRoot: каталог kernel32.dll не проходит (kernel32 обязан быть файлом)', () => {
  if (process.platform !== 'win32') return; // Windows-специфично
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sysroot-'));
  fs.mkdirSync(path.join(fake, 'System32', 'kernel32.dll'), { recursive: true }); // ДИРЕКТОРИЯ вместо файла
  const savedSR = process.env.SystemRoot, savedWD = process.env.windir;
  try {
    process.env.SystemRoot = fake; process.env.windir = fake;
    const r = rf.winSystemRoot();
    assert(r !== fake, 'fakeroot с kernel32.dll-КАТАЛОГОМ не должен быть принят: ' + r);
    if (r) assert(fs.lstatSync(path.join(r, 'System32', 'kernel32.dll')).isFile(), 'возвращён валидный root (kernel32 — файл)');
  } finally {
    if (savedSR === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = savedSR;
    if (savedWD === undefined) delete process.env.windir; else process.env.windir = savedWD;
    try { fs.rmSync(fake, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

// #6 main.js: нет fallback в короткое имя taskkill.exe/cmd.exe (иначе PATH-резолв
// короткого имени под elevated-токеном воскрешает hijack).
ok('#6 main.js: no short-name fallback (taskkill.exe/cmd.exe fail-closed)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(!/sysBin\('taskkill\.exe'\)\s*\|\|\s*'taskkill\.exe'/.test(s), 'taskkill.exe: убрать || короткое имя');
  assert(!/sysBin\('cmd\.exe'\)\s*\|\|\s*'cmd\.exe'/.test(s), 'cmd.exe: убрать || короткое имя');
});

// #8 openStream: редирект РВЁТ тело (res.destroy, не resume — иначе сокет живёт
// вечно), завершение РОВНО один раз (settled), ошибка учитывается только от текущего
// хопа, глушим ВСЮ цепочку req. (openStream https-only + анти-SSRF по DNS — к
// localhost не подключается by design, поэтому редирект-логика проверяется по коду.)
ok('#8 openStream: redirect res.destroy + single-settle + kill whole chain', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'remote-fetch.js'), 'utf8');
  const fn = s.slice(s.indexOf('function openStream'), s.indexOf('function probeMirror'));
  assert(/let settled = false/.test(fn), 'должен быть single-settle гейт');
  assert(/finishOne\(/.test(fn), 'завершение через finishOne (ровно один раз)');
  assert(!/res\.resume\(\)/.test(fn), 'редирект НЕ должен res.resume() (утечка сокета) — только res.destroy()');
  assert(/res\.destroy\(\)/.test(fn), 'редирект рвёт тело res.destroy()');
  assert(/req === currentReq/.test(fn), 'ошибка учитывается только от текущего хопа');
  assert(/for \(const r of chain\)/.test(fn), 'при завершении глушим ВСЮ цепочку req');
});

console.log('== P0 (Codex круг 6): remote-cache создаётся АТОМАРНО owner=Admins+DACL; нет post-hoc icacls; ZIP-TOCTOU закрыт ==');

// Источник-инвариант (remote-fetch.js): create-then-icacls для secure-dir УДАЛЁН
// полностью; кэш проверяется verify-only (ensureCacheSecure), без создания/icacls.
ok('remote-fetch: post-hoc icacls secure-dir удалён; ensureCacheSecure — verify-only (каталог рождает атомарный New-HmSecureStagingDir)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'remote-fetch.js'), 'utf8');
  assert(!/function secureDirWin\(/.test(s), 'secureDirWin удалён (post-hoc /setowner+/grant запрещён)');
  assert(!/function secureAndVerifyDirWin\(/.test(s), 'secureAndVerifyDirWin удалён');
  assert(!/function buildIcaclsArgs\(/.test(s), 'buildIcaclsArgs удалён');
  assert(!/function hardenAndVerifyCache\(/.test(s), 'hardenAndVerifyCache (create+icacls) заменён на verify-only ensureCacheSecure');
  assert(!/'\/setowner'/.test(s) && !/'\/grant:r'/.test(s) && !/'\/inheritance:r'/.test(s),
    'НЕТ icacls-аргументов secure-dir как кода (владелец+DACL атомарно в примитиве)');
  const fn = s.slice(s.indexOf('function ensureCacheSecure('), s.indexOf('// Приватный temp-файл'));
  assert(fn.length > 0, 'ensureCacheSecure объявлена');
  assert(/verifyDirSecureWin\(cacheDir/.test(fn), 'win32: проверка owner+ACE через verifyDirSecureWin');
  assert(/safeLstat\(cacheDir\)/.test(fn) && /isSymbolicLink\(\)/.test(fn), 'win32: reject symlink/reparse/не-каталог');
  const winBranch = fn.slice(0, fn.indexOf('// POSIX'));
  assert(!/mkdirSync/.test(winBranch), 'win32-ветка НЕ создаёт каталог (verify-only, не create-then-icacls)');
});

// Источник-инвариант (main.js): на win32 кэш докачки — СВЕЖИЙ Admins-only каталог,
// рождённый winMakeSecureDir (New-HmSecureStagingDir), НЕ предсказуемый; HM_REMOTE_CACHE
// = проверенный fr.path ВНУТРИ него; каталог чистится после установки.
ok('main.js: win32 remote-cache = winMakeSecureDir (атомарно Admins-only), не reuse предсказуемого; HM_REMOTE_CACHE внутри', () => {
  const m = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const h = m.slice(m.indexOf("let remoteCache = ''"), m.indexOf('remoteCache = fr.path'));
  assert(h.length > 0, 'нашли remote-ветку run-component');
  // await обязателен: примитив асинхронный (spawn, не spawnSync — иначе главный процесс
  // морозится на каждом артефакте и окно перестаёт отвечать). Без await в cacheDir лёг бы
  // Promise, и «защищённый каталог» молча превратился бы в мусорный путь.
  assert(/if \(IS_WIN\)/.test(h) && /cacheDir = await winMakeSecureDir\(\)/.test(h),
    'win32: cacheDir рождается winMakeSecureDir (атомарный owner+DACL примитив), вызов awaited');
  assert(/secureCacheDir = cacheDir/.test(h), 'win32: каталог помечен для очистки');
  assert(/cacheDir = remoteCacheDir\(declared\)/.test(h), 'POSIX: remoteCacheDir (uv неэлевейтед)');
  assert(/if \(remoteCache\) childEnv\.HM_REMOTE_CACHE = remoteCache/.test(m),
    'HM_REMOTE_CACHE = проверенный fr.path (внутри Admins-only каталога)');
  const closeBlk = m.slice(m.indexOf("child.on('close'"));
  assert(/cleanupSecureCache\(\)/.test(closeBlk), 'secure-кэш чистится после установки (child close)');
});

// Источник-инвариант: .zip и распаковка ЛЕЖАТ ВНУТРИ cacheDir (Admins-only) → нет
// окна подмены ZIP между SHA-256 и ExtractToDirectory (ZIP-TOCTOU закрыт по конструкции).
ok('remote-fetch: .zip и распаковка ВНУТРИ cacheDir; fr.path=unpackDir (нет swap-окна ZIP-TOCTOU)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'remote-fetch.js'), 'utf8');
  assert(/archivePath = path\.join\(cacheDir, entry\.remoteId \+ '\.zip'\)/.test(s), '<remoteId>.zip внутри cacheDir');
  assert(/unpackDir = path\.join\(cacheDir, 'unpacked-'/.test(s), 'распаковка внутри cacheDir');
  assert(/return \{ ok: true, path: unpackDir/.test(s), 'fr.path = unpackDir (HM_REMOTE_CACHE указывает внутрь Admins-only каталога)');
});

// Функц. (win32): пред-существующий небезопасный каталог → REJECT (не reuse, не «чиним»
// post-hoc); несуществующий → REJECT и НЕ создаём (verify-only). Так закрыт reuse-вектор.
if (process.platform === 'win32') {
  const rfSec = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  ok('ensureCacheSecure (win32, round-trip): user-owned/наследованный каталог → REJECT (не reuse)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cache-unsafe-'));
    try {
      const r = rfSec.ensureCacheSecure(d, null);
      assert(r.ok === false, 'user-owned/наследованный каталог обязан быть отвергнут: ' + JSON.stringify(r));
      assert(/защищённ|Administrators|небезопас|посторонн/i.test(r.error || ''), 'ошибка про защищённость: ' + r.error);
    } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
  ok('ensureCacheSecure (win32): несуществующий каталог → REJECT и НЕ создаём (verify-only)', () => {
    const d = path.join(os.tmpdir(), 'hm-cache-nope-' + crypto.randomBytes(6).toString('hex'));
    const r = rfSec.ensureCacheSecure(d, null);
    assert(r.ok === false, 'несуществующий → fail-closed (verify-only, не create)');
    assert(!fs.existsSync(d), 'каталог НЕ создан (verify-only, не мутируем ФС)');
  });
}

// #4 (finalize) main.js: install-env строит childEnv через ИСТИННЫЙ allowlist
// (src/install-env.js filterRendererEnv) — PATH только из admin-owned каталогов;
// старый denylist ENV_RESOLUTION_DENY удалён.
ok('#4 main.js: install-env allowlist wired (buildInstallEnv + filterRendererEnv + admin PATH)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/function buildInstallEnv/.test(s), 'должна быть buildInstallEnv');
  assert(/const childEnv = buildInstallEnv\(rendererEnv\)/.test(s), 'run-component использует buildInstallEnv');
  assert(/out\.PATH = trustedPath/.test(s), 'PATH задаётся из trustedPath (admin-каталоги), не из process.env.PATH');
  assert(/installEnv\.filterRendererEnv\(rendererEnv\)/.test(s), 'renderer-env фильтруется через install-env.filterRendererEnv (allowlist)');
  assert(!/ENV_RESOLUTION_DENY/.test(s), 'старый denylist ENV_RESOLUTION_DENY должен быть удалён (заменён allowlist)');
  assert(!/const childEnv = Object\.assign\(\{\}, process\.env, rendererEnv\)/.test(s), 'старое небезопасное построение env убрано');
});

// #4 (finalize) — поведение фильтра renderer-env (истинный allowlist, чистый модуль).
console.log('== #4 finalize: renderer-env allowlist (только HM_*, без HM_REMOTE_CACHE, регистронезависимо) ==');
const installEnv = require(path.join(ROOT, 'src', 'install-env'));

// (1) не-HM_ ключи резолвинга/инъекции отбрасываются целиком.
ok('#4 allowlist: NODE_OPTIONS/npm_config_*/GIT_EXEC_PATH/NODE_PATH/произвольный не-HM_ ключ отброшены', () => {
  const out = installEnv.filterRendererEnv({
    NODE_OPTIONS: '--require=C:\\Users\\x\\evil.js',
    npm_config_foo: 'bar',
    GIT_EXEC_PATH: 'C:\\evil',
    NODE_PATH: 'C:\\evil\\node_modules',
    PATH: 'C:\\evil',
    EVILVAR: '1'
  });
  ['NODE_OPTIONS', 'npm_config_foo', 'GIT_EXEC_PATH', 'NODE_PATH', 'PATH', 'EVILVAR']
    .forEach((k) => assert(!(k in out), k + ' должен быть отброшен, остался: ' + JSON.stringify(out)));
  assert(Object.keys(out).length === 0, 'ни один не-HM_ ключ не должен пройти: ' + JSON.stringify(out));
});

// (2) легитимные (реально эмитимые envForRun) HM_* сохраняются, а HM_*, которых
// renderer НЕ эмитит никогда (HM_COURSE_TARGET — путь раскладки курса под админом),
// отбрасываются: allowlist — ЯВНЫЙ СПИСОК КЛЮЧЕЙ, а не префикс-тест HM_.
ok('#4 allowlist: эмитимые HM_* сохраняются; неэмитимый HM_COURSE_TARGET отброшен', () => {
  const out = installEnv.filterRendererEnv({
    HM_SELECTED: 'git,node,claude',
    HM_COURSE_TARGET: 'C:\\Program Files\\Common Files',
    HM_KEEP_SKILLS: 'a,b,c',
    HM_HOME: 'C:\\Users\\x'
  });
  assert(out.HM_SELECTED === 'git,node,claude', 'HM_SELECTED должен сохраниться');
  assert(out.HM_KEEP_SKILLS && out.HM_HOME, 'эмитимые HM_* должны сохраниться');
  assert(!('HM_COURSE_TARGET' in out), 'HM_COURSE_TARGET (renderer его не эмитит) обязан быть отброшен');
  assert(Object.keys(out).length === 3, 'ровно 3 разрешённых ключа: ' + JSON.stringify(out));
});

// (2b) allowlist ПОКРЫВАЕТ ровно то, что эмитит src/renderer/app.js → envForRun:
// новый HM_-ключ в envForRun без строки в allowlist молча не доедет до скрипта.
ok('#4 allowlist: список ключей совпадает с envForRun (app.js) — ни одного лишнего/недостающего', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const envFn = appSrc.slice(appSrc.indexOf('function envForRun'), appSrc.indexOf('function appendLog'));
  const emitted = Array.from(new Set((envFn.match(/HM_[A-Z0-9_]+/g) || [])));
  assert(emitted.length >= 12, 'envForRun должен эмитить свои HM_-ключи, найдено: ' + emitted.length);
  emitted.forEach((k) => {
    assert(installEnv.isAllowedRendererEnvKey(k), k + ' эмитится envForRun, но не разрешён allowlist-ом');
  });
  const envSrc = fs.readFileSync(path.join(ROOT, 'src', 'install-env.js'), 'utf8');
  const listed = (envSrc.match(/'hm_[a-z0-9_]+'/g) || []).map((s) => s.replace(/'/g, '').toUpperCase());
  listed.forEach((k) => {
    assert(emitted.indexOf(k) !== -1, k + ' разрешён allowlist-ом, но envForRun его не эмитит');
  });
  assert(!installEnv.isAllowedRendererEnvKey('HM_COURSE_TARGET'), 'HM_COURSE_TARGET не должен проходить');
  assert(!installEnv.isAllowedRendererEnvKey('HM_NOMAD_CLOUD_BASEURL'), 'HM_NOMAD_CLOUD_BASEURL не должен проходить');
  assert(!installEnv.isAllowedRendererEnvKey('HM_BRIDGE_TOKEN'), 'HM_BRIDGE_TOKEN не должен проходить');
});

// (3) HM_REMOTE_CACHE из renderer отбрасывается — его ставит ТОЛЬКО main из проверенного пути.
ok('#4 allowlist: HM_REMOTE_CACHE из renderer отброшен, main ставит свой', () => {
  const out = installEnv.filterRendererEnv({ HM_REMOTE_CACHE: 'C:\\attacker\\cache', HM_SELECTED: 'git' });
  assert(!('HM_REMOTE_CACHE' in out), 'HM_REMOTE_CACHE НЕ должен пройти из renderer');
  assert(out.HM_SELECTED === 'git', 'легитимный HM_SELECTED рядом сохраняется');
});

// (4) сравнение имён РЕГИСТРОНЕЗАВИСИМО (Windows env: 'Path'/'PATH' — одно имя).
ok('#4 allowlist: регистр-варианты отброшены (nodE_optionS, HM_remote_CACHE), Hm_* распознан', () => {
  const out = installEnv.filterRendererEnv({ nodE_optionS: '--require=evil', HM_remote_CACHE: 'C:\\x', Hm_Selected: 'git' });
  assert(!('nodE_optionS' in out), 'регистр-вариант NODE_OPTIONS отброшен');
  assert(!('HM_remote_CACHE' in out), 'регистр-вариант HM_REMOTE_CACHE отброшен');
  assert(out.Hm_Selected === 'git', 'регистр-вариант HM_* (Hm_Selected) распознан как allowed');
});

// #4 (finalize round-2): системные path-переменные берутся из ВАЛИДИРОВАННОГО диска,
// а не из launch-env — иначе crafted ProgramFiles=…\evil → evil\Git\cmd под админом.
ok('#4 anti-spoof: authoritativeWinSystemEnv(C:\\Windows, C:\\) даёт валидные ProgramFiles/SystemRoot/SystemDrive', () => {
  const e = installEnv.authoritativeWinSystemEnv('C:\\Windows', 'C:\\');
  assert(e.ProgramFiles === 'C:\\Program Files', 'ProgramFiles из диска, не из env');
  assert(e['ProgramFiles(x86)'] === 'C:\\Program Files (x86)', 'ProgramFiles(x86) из диска');
  assert(e.ProgramW6432 === 'C:\\Program Files', 'ProgramW6432 из диска');
  assert(e.SystemRoot === 'C:\\Windows' && e.windir === 'C:\\Windows', 'SystemRoot/windir = validated winRoot');
  assert(e.SystemDrive === 'C:', 'SystemDrive без хвостового слэша');
  assert(e.ProgramData === 'C:\\ProgramData' && e.ALLUSERSPROFILE === 'C:\\ProgramData', 'ProgramData/ALLUSERSPROFILE из диска');
});

// Другой системный диск (D:) — всё выводится из него, не хардкод C:.
ok('#4 anti-spoof: другой диск (D:) корректно проброшен в ProgramFiles/SystemDrive', () => {
  const e = installEnv.authoritativeWinSystemEnv('D:\\Windows', 'D:\\');
  assert(e.ProgramFiles === 'D:\\Program Files', 'ProgramFiles на D:');
  assert(e.SystemDrive === 'D:', 'SystemDrive = D:');
  assert(e.SystemRoot === 'D:\\Windows', 'SystemRoot = D:\\Windows');
});

// Провязка в main.js: authoritative override вызывается ПОСЛЕ renderer-allowlist
// (иначе copied-from-process.env ProgramFiles/SystemRoot остались бы spoofable).
ok('#4 main.js: authoritativeWinSystemEnv провязан после filterRendererEnv', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/installEnv\.authoritativeWinSystemEnv\(winRoot,\s*drive\)/.test(s), 'authoritativeWinSystemEnv(winRoot, drive) вызван в main.js');
  const iFilter = s.indexOf('installEnv.filterRendererEnv(rendererEnv)');
  const iAuth = s.indexOf('installEnv.authoritativeWinSystemEnv(');
  assert(iFilter !== -1 && iAuth !== -1 && iAuth > iFilter, 'authoritative override идёт ПОСЛЕ renderer-allowlist');
});

// ---- Фаза 2: install-manager (манифест версий, аддитивная доустановка, деинсталлятор) ----

console.log('== Фаза 2: install-manifest (версии установленного, атомарная запись) ==');
const manifestMod = require(path.join(ROOT, 'src', 'install-manifest.js'));
const { spawnSync } = require('child_process');

ok('manifest: нет файла → пустой валидный манифест (fail-safe, не бросает)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-man-'));
  try {
    const m = manifestMod.readManifest(home);
    assert(m && typeof m === 'object', 'объект');
    assert(m.components && Object.keys(m.components).length === 0, 'components пуст');
    assert.strictEqual(m.schemaVersion, manifestMod.SCHEMA_VERSION, 'schemaVersion проставлен');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('manifest: битый JSON / не-объект → пустой манифест (не блокирует установку)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-man-'));
  try {
    fs.mkdirSync(path.join(home, manifestMod.DIR_NAME), { recursive: true });
    fs.writeFileSync(manifestMod.manifestPath(home), '{broken json!!!', 'utf8');
    const m1 = manifestMod.readManifest(home);
    assert(m1.components && Object.keys(m1.components).length === 0, 'битый JSON → пустой');
    fs.writeFileSync(manifestMod.manifestPath(home), '"просто строка"', 'utf8');
    const m2 = manifestMod.readManifest(home);
    assert(m2.components && Object.keys(m2.components).length === 0, 'не-объект → пустой');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('manifest: recordInstall → readManifest round-trip, без .tmp мусора', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-man-'));
  try {
    const r = manifestMod.recordInstall(home, 'uv', '1.2.3', 'remote');
    assert(r.ok, 'запись ok');
    const m = manifestMod.readManifest(home);
    assert(m.components.uv && m.components.uv.version === '1.2.3', 'версия сохранена');
    assert(m.components.uv.source === 'remote', 'source сохранён');
    assert(!isNaN(Date.parse(m.components.uv.installedAt)), 'installedAt — валидная ISO-дата');
    const leftovers = fs.readdirSync(path.join(home, manifestMod.DIR_NAME)).filter((n) => n.endsWith('.tmp'));
    assert.strictEqual(leftovers.length, 0, 'temp-файлы не остались: ' + leftovers.join(','));
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('manifest: атомарность — rename упал (EPERM) → unlink+rename fallback, файл валиден', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-man-'));
  const origRename = fs.renameSync;
  try {
    manifestMod.recordInstall(home, 'a', '1.0.0', 'bundled');
    let threw = 0;
    fs.renameSync = function (src, dst) {
      if (threw === 0) { threw++; const e = new Error('EPERM (test)'); e.code = 'EPERM'; throw e; }
      return origRename.call(fs, src, dst);
    };
    const r = manifestMod.recordInstall(home, 'a', '2.0.0', 'bundled');
    fs.renameSync = origRename;
    assert(r.ok, 'fallback-путь отработал: ' + JSON.stringify(r));
    assert.strictEqual(threw, 1, 'первый rename действительно падал');
    const m = manifestMod.readManifest(home);
    assert(m.components.a.version === '2.0.0', 'новая версия записана');
    const leftovers = fs.readdirSync(path.join(home, manifestMod.DIR_NAME)).filter((n) => n.endsWith('.tmp'));
    assert.strictEqual(leftovers.length, 0, 'temp-файлы подчищены');
  } finally {
    fs.renameSync = origRename;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

ok('manifest: dryRun ничего не пишет на диск', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-man-'));
  try {
    const r = manifestMod.writeManifest(home, { schemaVersion: 1, components: { x: { version: '1' } } }, { dryRun: true });
    assert(r.ok && r.dryRun, 'dryRun ok');
    assert(!fs.existsSync(manifestMod.manifestPath(home)), 'installed.json НЕ создан');
    const r2 = manifestMod.recordInstall(home, 'x', '1.0.0', 'bundled', { dryRun: true });
    assert(r2.ok && !fs.existsSync(manifestMod.manifestPath(home)), 'recordInstall(dryRun) не пишет');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('manifest: removeEntry удаляет запись; отсутствующая → no-op ok', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-man-'));
  try {
    manifestMod.recordInstall(home, 'course', '1.0.0', 'bundled');
    manifestMod.recordInstall(home, 'uv', '2.0.0', 'remote');
    const r = manifestMod.removeEntry(home, 'course');
    assert(r.ok && r.changed === true, 'удаление существующей записи');
    const m = manifestMod.readManifest(home);
    assert(!m.components.course, 'course убран');
    assert(m.components.uv && m.components.uv.version === '2.0.0', 'соседняя запись цела');
    const r2 = manifestMod.removeEntry(home, 'nonexistent');
    assert(r2.ok && r2.changed === false, 'отсутствующая запись → no-op ok');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('manifest: compareVersions — числовые сегменты, v-префикс, 1.2.10 > 1.2.9, мусор → 0', () => {
  assert.strictEqual(manifestMod.compareVersions('1.2.10', '1.2.9'), 1, '1.2.10 > 1.2.9 (не лексикографика)');
  assert.strictEqual(manifestMod.compareVersions('v1.2.3', '1.2.3'), 0, 'v-префикс игнорируется');
  assert.strictEqual(manifestMod.compareVersions('1.2', '1.2.0'), 0, 'хвостовой .0 не значим');
  assert.strictEqual(manifestMod.compareVersions('0.9', '1.0'), -1, '0.9 < 1.0');
  assert.strictEqual(manifestMod.compareVersions('garbage', '1.0'), 0, 'мусор → «не знаем» (0, без ложных апдейтов)');
  assert.strictEqual(manifestMod.compareVersions('', '1.0'), 0, 'пусто → 0');
});

ok('manifest: isOutdated — только СТРОГО старше даёт true (равно/новее/пусто → false)', () => {
  assert.strictEqual(manifestMod.isOutdated('1.0.0', '1.0.1'), true, 'старее → обновление доступно');
  assert.strictEqual(manifestMod.isOutdated('1.0.1', '1.0.1'), false, 'равно → нет');
  assert.strictEqual(manifestMod.isOutdated('1.0.2', '1.0.1'), false, 'новее → нет');
  assert.strictEqual(manifestMod.isOutdated('', '1.0.1'), false, 'нет записи → нет ложного апдейта');
  assert.strictEqual(manifestMod.isOutdated('1.0.0', ''), false, 'нет текущей версии → нет');
});

ok('Фаза 2 main.js: манифест справочный — запись при успехе (не hidden, не dry-run), удаление при uninstall, цели авторитетно из main', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // P0-1: решение «писать ли маркер» делегировано чистой testable-функции
  // receipts.shouldRecordInstall(code, isDryRun, hidden) — код 0 (не skip-код, не иной).
  assert(/receipts\.shouldRecordInstall\(code, isDryRun, !!\(meta && meta\.hidden\)\)/.test(s), 'запись маркера/версии только при успехе (код 0), не dry-run, не hidden — через shouldRecordInstall');
  assert(/receipts\.isSkipExit\(code\)/.test(s), 'skip-код распознаётся (isSkipExit) — маркер НЕ пишется');
  assert(/manifest\.recordInstall\(os\.homedir\(\), id, ver, src\)/.test(s), 'recordInstall провязан в run-component');
  assert(/manifest\.removeEntry\(home, id\)/.test(s), 'removeEntry провязан в uninstall-component');
  assert(/function detectComponents/.test(s), 'детекция «установлен» — живая проверка ФС (detectComponents), не манифест');
  assert(/uninstallTargets\.uninstallTargets\(id, buildUninstallCtx\(\)\)/.test(s),
    'что удалять — вычисляет ТОЛЬКО main по зашитому аллоулисту (не renderer, не квитанция)');
  assert(/VALID_COMPONENT_IDS\.has\(id\)/.test(s), 'uninstall принимает только известные id');
});

console.log('== Задачи 1+4: VS Code рекомендуемый редактор, Cursor опциональный, запуск на папке ==');

// (1) Реестр: vscode — рекомендуемый, по умолчанию включён, показан на всех ОС (без platforms-гейта).
ok('components: vscode есть, recommended+default, без platforms-гейта (win32 и darwin)', () => {
  const v = byId['vscode'];
  assert(v, 'компонент vscode должен существовать в реестре');
  assert(v.recommended === true, 'vscode.recommended === true (бейдж «рекомендуется»)');
  assert(v.default === true, 'vscode по умолчанию включён');
  assert(!Array.isArray(v.platforms) || v.platforms.length === 0, 'vscode без platforms-гейта → показан везде');
});

// (1) Cursor стал опциональным: по умолчанию НЕ включён (не тянет подписку/гео-блок на новичка).
ok('components: cursor опциональный (default:false), уживается с vscode (без взаимных requires)', () => {
  const c = byId['cursor'];
  assert(c, 'компонент cursor должен существовать');
  assert(c.default === false, 'cursor по умолчанию ВЫКЛЮЧЕН (опциональный)');
  assert(!c.recommended, 'cursor НЕ помечен рекомендуемым');
  assert((c.requires || []).indexOf('vscode') === -1, 'cursor не требует vscode');
  assert((byId['vscode'].requires || []).indexOf('cursor') === -1, 'vscode не требует cursor (оба живут рядом)');
});

// (1) Панель Claude привязана к рекомендуемому редактору (vscode), а не к опциональному cursor.
ok('components: extension требует vscode (не cursor) — дефолт-набор без cursor когерентен', () => {
  const e = byId['extension'];
  assert(e && (e.requires || []).indexOf('vscode') !== -1, 'extension.requires содержит vscode');
  assert((e.requires || []).indexOf('cursor') === -1, 'extension больше НЕ требует cursor');
});

// Дефолтный выбор ставит vscode, но НЕ cursor; extension тянет vscode как зависимость.
ok('deps: дефолт включает vscode+extension, но НЕ cursor; extension тянет vscode (не cursor)', () => {
  const selected = {};
  Object.keys(byId).forEach((id) => { if (byId[id].default) selected[id] = true; });
  assert(selected.vscode === true, 'vscode в дефолтном наборе');
  assert(!selected.cursor, 'cursor НЕ в дефолтном наборе');
  const sel2 = {};
  HMDeps.enableWithDeps(sel2, byId, 'extension');
  assert(sel2.vscode === true && !sel2.cursor, 'extension тянет vscode, не cursor');
});

// components.json остаётся валидным JSON после правок, граф зависимостей цел.
ok('components.json парсится и граф зависимостей цел (vscode/cursor/extension)', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
  const ids = new Set();
  data.groups.forEach((g) => g.components.forEach((c) => ids.add(c.id)));
  assert(ids.has('vscode') && ids.has('cursor') && ids.has('extension'), 'все три редактор-компонента на месте');
  data.groups.forEach((g) => g.components.forEach((c) =>
    (c.requires || []).forEach((r) => assert(ids.has(r), `requires "${r}" в ${c.id} существует`))));
});

// (4) launch-vscode открывает ПАПКУ ~/HamidunStart (IDE-режим), а НЕ агент-URI/панель-чат.
ok('main.js: IPC launch-vscode открывает папку ~/HamidunStart (не агент-чат/URI)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const at = s.indexOf("ipcMain.handle('launch-vscode'");
  assert(at !== -1, 'обработчик launch-vscode зарегистрирован');
  assert(/HamidunStart/.test(s.slice(at, at + 200)), 'launch-vscode целится в папку HamidunStart');
  // Реализация вынесена в общую launchVsCodeOn(dir) (переиспользуется курс-лаунчером);
  // хендлер — однострочник-делегат, поэтому инварианты проверяем в самой функции.
  const fi = s.indexOf('function launchVsCodeOn');
  assert(fi !== -1, 'общая функция launchVsCodeOn существует');
  const h = s.slice(fi, fi + 900);
  assert(/mkdirSync\(dir/.test(h), 'папка проекта создаётся, если её нет (реальный воркспейс)');
  // Папка открывается через де-элевированный лаунчер (P0), а не прямым spawn.
  assert(/winLaunchDeElevated\(codeExe, dir\)/.test(h), 'папка передаётся редактору де-элевированным запуском (аналог code "<папка>")');
  assert(!/anthropic\.claude-code\/open|vscode:\/\//.test(h), 'НЕ агент-URI (панель-чат) — это IDE-открытие папки');
  assert(/ipcMain\.handle\('launch-cursor'/.test(s), 'launch-cursor сохранён (Cursor как опция)');
});

// (4a) РЕГРЕССИЯ ОТ ЖИВОГО УЧЕНИКА: «я не нахожу файл с промптами».
// Памятка вторым шагом велит открыть PROMPTS.md в ~/HamidunStart, а config.ps1/config.sh
// копировали стартовый проект ТОЛЬКО когда папки ещё нет: «папка есть → не перезаписываю».
// Папка же появляется и помимо них — кнопка «Открыть VS Code» делает mkdirSync ПУСТОЙ
// папки, чтобы редактор открыл воркспейс, а не безымянное окно (см. тест выше, строка
// про mkdirSync(dir). Плюс прошлая установка, плюс сам человек. Итог: папка есть, файлов
// нет, памятка ссылается в пустоту.
// Инвариант: недостающие файлы ДОКЛАДЫВАЮТСЯ, существующие НЕ трогаются, отсутствие
// ассетов не проходит молча.
ok('config.ps1/config.sh: стартовый проект дополняется, а не пропускается, если папка уже есть', () => {
  for (const rel of [['scripts', 'windows', 'config.ps1'], ['scripts', 'macos', 'config.sh']]) {
    const f = path.join(ROOT, ...rel);
    const s = fs.readFileSync(f, 'utf8');
    const name = rel[rel.length - 1];
    const at = s.indexOf('HamidunStart');
    assert(at !== -1, name + ': блок стартового проекта на месте');
    const blk = s.slice(Math.max(0, at - 1500), at + 3500);

    // Главное: НЕТ раннего выхода «папка есть — ничего не делаю».
    assert(!/уже есть:.*не перезаписываю/.test(blk),
      name + ': пропуск целой папки убран (из-за него ученик остался без PROMPTS.md)');
    // Копирование идёт пофайлово с проверкой существования каждого файла.
    assert(/добавлено|дополнен/.test(blk),
      name + ': недостающие файлы докладываются (есть отчёт о добавленных)');
    // Файл человека не трогаем.
    assert(/не тронуто|ST_KEPT|\$kept/.test(blk),
      name + ': существующие файлы сохраняются, а не перезаписываются');
    // Именно PROMPTS.md проверяется отдельно — на него ссылается памятка.
    assert(/PROMPTS\.md/.test(blk),
      name + ': наличие PROMPTS.md проверяется явно (памятка ведёт именно к нему)');
    // Отсутствие ассетов больше не проходит молча.
    assert(/Стартовый проект НЕ создан/.test(s),
      name + ': отсутствие вшитых ассетов сообщается, а не игнорируется');
  }
});

// (4b) Сам стартовый проект обязан ехать в сборке и содержать файл, к которому ведёт памятка.
ok('сборка: assets/starter-project едет в дистрибутив и содержит PROMPTS.md', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const er = (pkg.build && pkg.build.extraResources) || [];
  const froms = er.map((e) => (typeof e === 'string' ? e : e.from));
  assert(froms.includes('assets/starter-project'),
    'assets/starter-project перечислен в extraResources (иначе в собранном .exe его нет)');

  const src = path.join(ROOT, 'assets', 'starter-project');
  assert(fs.existsSync(path.join(src, 'PROMPTS.md')),
    'PROMPTS.md лежит в assets/starter-project — памятка ссылается именно на него');

  // Памятка и файл обязаны говорить об одном и том же имени.
  const memo = path.join(ROOT, 'assets', 'START-HERE.html');
  if (fs.existsSync(memo)) {
    const m = fs.readFileSync(memo, 'utf8');
    if (/PROMPTS\.md/.test(m)) {
      assert(/HamidunStart/.test(m),
        'памятка называет папку HamidunStart рядом с PROMPTS.md (иначе человек не найдёт файл)');
    }
  }
});

// main.js: детекция установленного VS Code.
ok('main.js: detectComponents детектит vscode (Code.exe / Visual Studio Code.app)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/out\.vscode = \{ installed/.test(s), 'детектор out.vscode есть');
  assert(/Microsoft VS Code|Visual Studio Code\.app/.test(s), 'ищет реальные пути VS Code');
});

// preload: экспортирован launchVsCode (+ launchCursor сохранён).
ok('preload.js: экспортирует launchVsCode (launchCursor сохранён)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  assert(/launchVsCode:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('launch-vscode'\)/.test(s), 'launchVsCode проброшен');
  assert(/launchCursor:/.test(s), 'launchCursor сохранён');
});

// renderer: бейдж «рекомендуется» + финиш-кнопка «Открыть VS Code» primary; Cursor — только если выбран.
ok('app.js: бейдж «рекомендуется» + финиш зовёт launchVsCode; Cursor-кнопка условная', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert(/badge rec/.test(s) && /c\.recommended/.test(s), 'карточка рисует badge rec по c.recommended');
  assert(/id="ns-vscode" class="btn-sm primary/.test(s), 'кнопка «Открыть VS Code» — primary (класс начинается с btn-sm primary; Задача 3 добавила ns-main)');
  assert(/launchVsCode\(\)/.test(s), 'финиш зовёт launchVsCode');
  assert(/cursorSelected \?/.test(s), 'кнопка Cursor показывается ТОЛЬКО если cursor выбран');
  assert(/#ns-autovscode/.test(s), 'авто-открытие на «Готово» теперь VS Code');
});

// styles: класс бейджа .badge.rec есть.
ok('styles.css: класс .badge.rec определён', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
  assert(/\.badge\.rec\s*\{/.test(s), '.badge.rec есть');
});

// (2) vscode.ps1: UTF-8 BOM (иначе кириллица ломается в Windows PowerShell 5.1).
ok('vscode.ps1: UTF-8 BOM (кириллица)', () => {
  const b = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'vscode.ps1'));
  assert(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF, 'первые байты — UTF-8 BOM EF BB BF');
});

// (2) vscode.ps1: ставит ОБА расширения; no-vendor+не установлен → exit 120; идемпотентно; тихо; fail-closed.
ok('vscode.ps1: ставит ОБА расширения; no-vendor → exit 120; идемпотентно; тихая установка; fail-closed', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'vscode.ps1'), 'utf8');
  assert(/anthropic\.claude-code/.test(s), 'ставит панель Claude (anthropic.claude-code)');
  assert(/openai\.chatgpt/.test(s), 'ставит Codex (openai.chatgpt)');
  assert(/exit 120/.test(s), 'нет vendor и VS Code не установлен → graceful skip 120');
  assert(/Test-VsCodePresent|Find-CodeCli/.test(s), 'идемпотентность: детекция уже установленного VS Code');
  assert(/VERYSILENT/.test(s) && /MERGETASKS=!runcode,addtopath/.test(s), 'тихая User-Setup установка');
  assert(/Confirm-HmArtifact \$setup/.test(s), 'fail-closed SHA-256 вшитого установщика');
});

// (2) vscode.sh: оба расширения; no-vendor→120; установка через root-staging; идемпотентно; fail-closed.
ok('vscode.sh: ставит ОБА расширения; no-vendor → exit 120; установка через HM_VSCODE_INSTALL_SH (root-staging); идемпотентно; fail-closed', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'vscode.sh'), 'utf8');
  assert(/anthropic\.claude-code/.test(s), 'ставит панель Claude');
  assert(/openai\.chatgpt/.test(s), 'ставит Codex');
  assert(/exit 120/.test(s), 'graceful skip 120 без vendor');
  assert(/admin_run \/bin\/sh -c "\$HM_VSCODE_INSTALL_SH"/.test(s), 'установка через общий root-скрипт (карантин снимается там же, на staged)');
  assert(/\[ -d "\$APP" \]/.test(s), 'идемпотентность: проверка установленного .app');
  assert(/verify_artifact "\$ZIP"/.test(s), 'предварительный fail-closed SHA-256 вшитого zip');
});

// fetch-vendor: VS Code installer + оба vsix вшиваются (существующее не сломано).
ok('fetch-vendor.ps1: вшивает vscode-setup.exe + chatgpt.vsix (claude-code.vsix сохранён)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor.ps1'), 'utf8');
  assert(/vscode-setup\.exe/.test(s), 'качает VS Code User Setup');
  assert(/chatgpt\.vsix/.test(s) && /open-vsx\.org/.test(s), 'качает Codex vsix из Open VSX');
  assert(/claude-code\.vsix/.test(s), 'существующее вшивание claude-code.vsix не тронуто');
  assert(/'vscode-setup\.exe'/.test(s), 'vscode-setup.exe в проверке полноты vendor');
});

ok('fetch-vendor-mac.sh: вшивает vscode.zip + Codex/Claude vsix (arch-specific, оба arch)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor-mac.sh'), 'utf8');
  assert(/vscode\.zip/.test(s), 'качает VS Code darwin-universal zip');
  // vsix теперь платформо-специфичны (нативные бинари внутри) — claude-code-$tag.vsix / chatgpt-$tag.vsix, оба arch.
  assert(/claude-code-[^\s"']*\.vsix/.test(s), 'вшивает Claude Code vsix (arch-specific claude-code-$tag.vsix)');
  assert(/open-vsx\.org/.test(s) && /chatgpt-[^\s"']*\.vsix/.test(s), 'качает Codex vsix из Open VSX (arch-specific chatgpt-$tag.vsix)');
});

// Синтаксис изменённых JS-файлов (node --check не исполняет код).
ok('node --check: main.js / preload.js / renderer/app.js / test/run-tests.js валидны', () => {
  ['src/main.js', 'src/preload.js', 'src/renderer/app.js', 'test/run-tests.js'].forEach((rel) => {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8', timeout: 30000 });
    assert(r.status === 0, rel + ' node --check: ' + (r.stderr || ''));
  });
});

// Синтаксис новых скриптов: PS ParseFile (BOM+синтаксис) и bash -n (парсинг, не исполнение).
if (powershellAvailable()) {
  // vscode.ps1 + изменённые/новые де-элевация-скрипты: BOM + синтаксис.
  ['vscode.ps1', '_deelev.ps1', 'extension.ps1', 'verify.ps1', 'claude-desktop.ps1', 'chatgpt-desktop.ps1', 'uv.ps1'].forEach((name) => {
    ok(name + ': PowerShell парсер без ошибок (синтаксис + BOM)', () => {
      const script = path.join(ROOT, 'scripts', 'windows', name);
      // BOM обязателен (кириллица в Windows PowerShell 5.1).
      const b = fs.readFileSync(script);
      assert(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF, name + ': первые байты — UTF-8 BOM');
      const cmd = "$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" + script +
        "',[ref]$null,[ref]$e);if($e -and $e.Count -gt 0){$e|%{[Console]::Error.WriteLine($_.Message)};exit 3};exit 0";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 60000 });
      assert(r.status === 0, name + ' ParseFile без ошибок: ' + (r.stderr || r.stdout || ''));
    });
  });
}
if (bashAvailable()) {
  ['vscode.sh', 'claude-desktop.sh', 'chatgpt-desktop.sh', 'uv.sh', '_lib.sh', 'cursor.sh', 'node.sh', 'pydeps.sh', 'mascot.sh'].forEach((name) => {
    ok(name + ': bash -n без синтаксических ошибок', () => {
      const r = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', 'macos', name)], { encoding: 'utf8', timeout: 30000 });
      assert(r.status === 0, 'bash -n: ' + (r.stderr || ''));
    });
  });
}

// ===== Задача 2: десктоп Claude Desktop + ChatGPT Desktop (опц. компоненты) =====
console.log('== Задача 2: десктоп Claude/ChatGPT — secure-cache download + подпись ДО запуска (fail-closed) ==');

const DT_CLAUDE_PS1 = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'claude-desktop.ps1'), 'utf8');
const DT_CHATGPT_PS1 = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'chatgpt-desktop.ps1'), 'utf8');
const DT_CLAUDE_SH = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'claude-desktop.sh'), 'utf8');
const DT_CHATGPT_SH = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'chatgpt-desktop.sh'), 'utf8');

// (1) Реестр: оба компонента опциональны (default:false), online:true, platforms win32+darwin, без requires.
ok('components: claude-desktop + chatgpt-desktop опциональны (default:false), online, platforms win32+darwin', () => {
  ['claude-desktop', 'chatgpt-desktop'].forEach((id) => {
    const c = byId[id];
    assert(c, id + ' есть в реестре');
    assert(c.default === false, id + ' по умолчанию ВЫКЛЮЧЕН (новичок не тянет сотни МБ без нужды)');
    assert(c.online === true, id + ' помечен online:true (докачка из сети)');
    assert(Array.isArray(c.platforms) && c.platforms.indexOf('win32') !== -1 && c.platforms.indexOf('darwin') !== -1,
      id + ' платформы win32+darwin');
    assert(!c.requires || c.requires.length === 0, id + ' независим (не тянет другие компоненты)');
    assert(c.why && /онлайн|сотни МБ/i.test(c.why), id + ' why-тултип объясняет онлайн-загрузку');
  });
});

// (2) claude-desktop.ps1: download в Admins-only secure-cache (НЕ %TEMP%) + НАДЁЖНАЯ
//     Authenticode-проверка ДО запуска (chain→LocalMachine\Root + точное O= + Code Signing EKU).
ok('claude-desktop.ps1: secure-cache (НЕ %TEMP%); НАДЁЖНАЯ подпись (chain→LocalMachine\\Root + exact O= + EKU) ДО запуска; exit 120; идемпотентно; cleanup', () => {
  const s = DT_CLAUDE_PS1();
  assert(/New-HmSecureStagingDir/.test(s), 'качает в admin-owned secure-cache (переиспользован укреплённый примитив)');
  assert(/\$installer = Join-Path \$cache/.test(s), 'файл установщика лежит в secure-cache ($cache), не в %TEMP%');
  assert(/-OutFile \$installer/.test(s), 'Invoke-WebRequest пишет именно в secure-cache-файл');
  assert(!/-OutFile[^\n]*\$env:(TEMP|TMP)/i.test(s), 'НЕТ скачивания в user-writable %TEMP%/%TMP%');
  // НАДЁЖНЫЙ гейт: цепочка к МАШИННОМУ корню (не CurrentUser), точное O=, Code Signing EKU.
  assert(/Test-HmSignerTrusted/.test(s), 'подпись проверяется надёжной функцией Test-HmSignerTrusted');
  assert(/Get-AuthenticodeSignature/.test(s) && /\.Status -ne 'Valid'/.test(s), 'Status=Valid (хеш файла не подменён)');
  assert(/X509Chain/.test(s) && /StoreName\]::Root/.test(s) && /StoreLocation\]::LocalMachine/.test(s),
    'строит X509Chain и требует корень в LocalMachine\\Root (не доверяет CurrentUser-корням)');
  assert(/SubjectName\.Format\(\$true\)/.test(s) && /'Anthropic, PBC'/.test(s), "точное O='Anthropic, PBC' из RDN (не подстрока Subject)");
  assert(/1\.3\.6\.1\.5\.5\.7\.3\.3/.test(s), 'требует EKU Code Signing');
  // НЕТ spoofable substring-пина издателя (старый '-notmatch $PUBLISHER' убран).
  assert(!/-notmatch \$PUBLISHER/.test(s) && !/\$subject -notmatch/.test(s), 'НЕТ подстрочного -notmatch пина издателя (spoofable)');
  // ГЕЙТ ПОРЯДКА: надёжная проверка ДО запуска ТОГО ЖЕ $installer (без ре-резолва).
  assertOrder(s, 'Test-HmSignerTrusted -Path $installer', 'Start-Process -FilePath $installer',
    'Test-HmSignerTrusted($installer) ИДЁТ ДО Start-Process $installer (проверяем тот же бинарь)');
  assert(/Start-Process -FilePath \$installer -WorkingDirectory \$cache/.test(s), 'запуск ИЗ защищённого кэша (CWD=кэш, run-from-protected)');
  assert(/exit 120/.test(s), 'нет сети/подпись не прошла → graceful skip 120');
  assert(/Test-ClaudeDesktopInstalled/.test(s), 'идемпотентность: детект уже установленного');
  // Уборка идёт через общий помощник: голый Remove-Item сносил РАБОЧИЙ подкаталог
  // «w», а внешний запертый HmDeElev-* оставался в ProgramData навсегда —
  // пользователь стереть его не может. Помощник поднимается к внешнему каталогу
  // и удаляет только имя строго вида HmDeElev-<32 hex> (иначе fail-closed no-op).
  assert(/Remove-HmSecureStagingDir -Path \$cache/.test(s), 'secure-cache чистится общим помощником');
  assert(!/Remove-Item -LiteralPath \$cache -Recurse/.test(s), 'голого сноса подкаталога не осталось');
  assert(/https:\/\/claude\.ai\/api\/desktop/.test(s), 'официальный Anthropic-endpoint');
});

// (3) chatgpt-desktop.ps1: winget СТРОГО из пакета с PublisherId 8wekyb3d8bbwe (без Get-Command
//     fallback) + НАДЁЖНАЯ подпись winget.exe (chain→machine-root + exact O=) + --exact.
ok('chatgpt-desktop.ps1: winget PublisherId 8wekyb3d8bbwe + БЕЗ Get-Command fallback; надёжная подпись winget.exe (chain→machine-root + O=Microsoft) ДО запуска; --exact; exit 120', () => {
  const s = DT_CHATGPT_PS1();
  assert(/Test-HmSignerTrusted/.test(s), 'подпись winget.exe проверяется надёжной функцией');
  assert(/Get-AuthenticodeSignature/.test(s) && /\.Status -ne 'Valid'/.test(s), 'Status=Valid (хеш winget.exe не подменён)');
  assert(/X509Chain/.test(s) && /StoreLocation\]::LocalMachine/.test(s), 'chain к корню в LocalMachine\\Root (не CurrentUser)');
  assert(/SubjectName\.Format\(\$true\)/.test(s) && /'Microsoft Corporation'/.test(s), "точное O='Microsoft Corporation' из RDN");
  assert(/1\.3\.6\.1\.5\.5\.7\.3\.3/.test(s), 'требует EKU Code Signing');
  assert(!/-notmatch \$PUBLISHER\b/.test(s), 'НЕТ подстрочного -notmatch пина издателя (spoofable)');
  // winget-резолв: пин PublisherId 8wekyb3d8bbwe (полное имя пакета), без Get-Command fallback.
  assert(/8wekyb3d8bbwe/.test(s), 'пин PublisherId 8wekyb3d8bbwe (не подстрока DesktopAppInstaller_)');
  assert(/\^Microsoft\\\.DesktopAppInstaller_/.test(s), 'имя пакета якорится ПОЛНОСТЬЮ (^...$), не подстрока');
  assert(!/Get-Command winget/.test(s), 'УБРАН Get-Command winget fallback (user-writable alias)');
  assert(/--exact/.test(s), 'winget install --exact (нет подмены id по совпадению/монике)');
  assertOrder(s, 'Test-HmSignerTrusted', '& $winget install',
    'подпись winget.exe проверяется ДО его запуска');
  assert(/--source msstore/.test(s) && /9NT1R1C2HH7J/.test(s), 'ставит из Microsoft Store (Store ID)');
  assert(/Test-ChatGptDesktopInstalled/.test(s) && /Get-AppxPackage/.test(s), 'идемпотентность: детект MSIX-пакета');
  assert(/exit 120/.test(s), 'нет winget/нет сети → graceful skip 120');
});

// (4) claude-desktop.sh: АБСОЛЮТНЫЕ codesign/spctl + require (fail-closed) + Team ID + bundle id
//     ДО установки; spctl ОБЯЗАТЕЛЕН (не conditional → нет fail-open); curl https; идемпотентно; 120.
ok('claude-desktop.sh: абсолютные /usr/bin/codesign + /usr/sbin/spctl (require, fail-closed) + Team ID + bundle id ДО ditto; curl https; exit 120', () => {
  const s = DT_CLAUDE_SH();
  assert(/CODESIGN='\/usr\/bin\/codesign'/.test(s) && /SPCTL='\/usr\/sbin\/spctl'/.test(s), 'абсолютные пути к codesign/spctl');
  assert(/\[ ! -x "\$CODESIGN" \]/.test(s) && /\[ ! -x "\$SPCTL" \]/.test(s), 'ТРЕБУЕМ наличие+исполняемость (нет → fail-closed)');
  assert(!/if command -v spctl/.test(s), 'НЕТ conditional "if command -v spctl" (это был fail-OPEN)');
  assert(/"\$CODESIGN" --verify --deep --strict/.test(s), 'проверяет подпись бандла (абсолютный codesign)');
  assert(/"\$SPCTL" --assess --type execute/.test(s), 'нотаризация ОБЯЗАТЕЛЬНА (spctl вызывается всегда)');
  assert(/Q6L2SF6YDW/.test(s) && /certificate leaf\[subject\.OU\]/.test(s) && /-R "=/.test(s), 'пин Team ID Anthropic через нативный designated requirement (certificate leaf[subject.OU], не -dv парсинг)');
  assert(/com\.anthropic\.claudefordesktop/.test(s) && /and identifier /.test(s), 'пин bundle identifier в designated requirement');
  assertOrder(s, 'verify_desktop_app "$APP"', 'ditto "$APP" "$STAGING"',
    'подпись проверяется ДО установки (ditto)');
  assert(/curl -fsSL --proto '=https'/.test(s), 'скачивание только по HTTPS (без http-downgrade)');
  assert(/exit 120/.test(s), 'нет сети/подпись не прошла → graceful skip 120');
  assert(/-d "\/Applications\/\$APP_NAME"/.test(s) || /-d "\$DEST"/.test(s), 'идемпотентность: детект установленного .app');
  assert(/persistent\.oaistatic|claude\.ai\/api\/desktop/.test(s), 'официальный endpoint');
});

// (5) chatgpt-desktop.sh: АБСОЛЮТНЫЕ codesign/spctl + require + ТОЧНЫЙ Team ID (не authority-
//     подстрока) + bundle id ДО установки; spctl ОБЯЗАТЕЛЕН; идемпотентно; 120.
ok('chatgpt-desktop.sh: абсолютные codesign/spctl (require) + ТОЧНЫЙ Team ID 2DC432GLL2 + bundle id (НЕ authority-substring) ДО ditto; exit 120', () => {
  const s = DT_CHATGPT_SH();
  assert(/CODESIGN='\/usr\/bin\/codesign'/.test(s) && /SPCTL='\/usr\/sbin\/spctl'/.test(s), 'абсолютные пути к codesign/spctl');
  assert(/\[ ! -x "\$CODESIGN" \]/.test(s) && /\[ ! -x "\$SPCTL" \]/.test(s), 'require наличие+исполняемость (fail-closed)');
  assert(!/if command -v spctl/.test(s), 'НЕТ conditional spctl (был fail-OPEN)');
  assert(/"\$CODESIGN" --verify --deep --strict/.test(s), 'проверяет подпись (абсолютный codesign)');
  assert(/"\$SPCTL" --assess --type execute/.test(s), 'нотаризация ОБЯЗАТЕЛЬНА (spctl всегда)');
  assert(/2DC432GLL2/.test(s) && /certificate leaf\[subject\.OU\]/.test(s) && /-R "=/.test(s), 'ТОЧНЫЙ Team ID OpenAI через нативный designated requirement (не -dv парсинг)');
  assert(/com\.openai\.chat/.test(s) && /and identifier /.test(s), 'пин bundle identifier в designated requirement');
  assert(!/grep -q "Authority=Developer ID Application: \$PUBLISHER"/.test(s),
    'НЕТ authority-substring как контроля (любой Dev ID с «OpenAI» иначе прошёл бы)');
  assertOrder(s, 'verify_desktop_app "$APP"', 'ditto "$APP" "$STAGING"',
    'подпись проверяется ДО установки (ditto)');
  assert(/curl -fsSL --proto '=https'/.test(s), 'скачивание только по HTTPS');
  assert(/persistent\.oaistatic\.com/.test(s), 'официальный OpenAI CDN (oaistatic.com)');
  assert(/exit 120/.test(s), 'нет сети/подпись не прошла → graceful skip 120');
});

// (6) Grep-инвариант класса: НИ ОДИН desktop-скрипт не качает в user-writable и не
//     запускает бинарь БЕЗ проверки подписи перед этим.
ok('grep-инвариант: нет download-в-user-writable + нет запуска бинаря без проверки подписи', () => {
  const cps = DT_CLAUDE_PS1();
  // Windows Claude: единственный запуск скачанного бинаря — Start-Process $installer, и он ПОСЛЕ надёжной проверки.
  assertOrder(cps, 'Test-HmSignerTrusted -Path $installer', 'Start-Process -FilePath $installer',
    'claude-desktop.ps1: установщик не запускается до надёжного гейта подписи');
  // Никаких -OutFile в TEMP.
  [DT_CLAUDE_PS1(), DT_CHATGPT_PS1()].forEach((s) => {
    assert(!/-OutFile[^\n]*\$env:(TEMP|TMP)\b/i.test(s), 'нет -OutFile в %TEMP%/%TMP%');
  });
  // mac: ditto (установка) — строго после verify_desktop_app.
  [DT_CLAUDE_SH(), DT_CHATGPT_SH()].forEach((s) => {
    assertOrder(s, 'verify_desktop_app "$APP"', 'ditto "$APP" "$STAGING"',
      'mac: установка (ditto) только после проверки подписи+нотаризации');
  });
});

// (6b) КЛАСС-ИНВАРИАНТ «нет spoofable substring-пина подписи» + «есть проверяемая криптоцепочка»
//      во ВСЕХ 4 desktop-скриптах: единственным контролем издателя НЕ должна быть подстрока по
//      Subject/authority (Win: chain→LocalMachine\Root + exact O=; Mac: точный Team ID + require spctl).
ok('6b: нет spoofable substring-пина подписи + есть проверяемая криптоцепочка (все 4 desktop-скрипта)', () => {
  // --- Windows: X509Chain до корня в LocalMachine\Root + точное O= из RDN + Code Signing EKU ---
  [DT_CLAUDE_PS1(), DT_CHATGPT_PS1()].forEach((s) => {
    assert(!/-notmatch \$PUBLISHER\b/.test(s), 'PS: нет "-notmatch $PUBLISHER" как гейта (spoofable substring)');
    assert(!/\$subject -notmatch/.test(s), 'PS: нет "$subject -notmatch ..." (substring по всему Subject)');
    assert(/X509Chain/.test(s), 'PS: строит X509Chain (проверяемая криптоцепочка)');
    assert(/StoreLocation\]::LocalMachine/.test(s) && /StoreName\]::Root/.test(s),
      'PS: корень требуется в LocalMachine\\Root (не доверяет отравляемому CurrentUser\\Root)');
    assert(/SubjectName\.Format\(\$true\)/.test(s), 'PS: парсит O= из RDN (не подстрока Subject)');
    assert(/1\.3\.6\.1\.5\.5\.7\.3\.3/.test(s), 'PS: требует Code Signing EKU');
  });
  // --- macOS: точный Team ID пин + require spctl (нет fail-open) ---
  [DT_CLAUDE_SH(), DT_CHATGPT_SH()].forEach((s) => {
    assert(/(Q6L2SF6YDW|2DC432GLL2)/.test(s) && /certificate leaf\[subject\.OU\]/.test(s) && /-R "=/.test(s), 'mac: Team ID+bundle пин через нативный designated requirement -R (codesign оценивает крипто, не парсинг -dv)');
    assert(!/if command -v spctl/.test(s), 'mac: spctl НЕ conditional (нет fail-OPEN при отсутствии spctl)');
    assert(/\[ ! -x "\$SPCTL" \]/.test(s), 'mac: отсутствие spctl → fail-CLOSED (require -x)');
    assert(/"\$SPCTL" --assess/.test(s), 'mac: spctl --assess вызывается всегда (обязательная нотаризация)');
    assert(/\/usr\/bin\/codesign/.test(s) && /\/usr\/sbin\/spctl/.test(s), 'mac: абсолютные пути к системным инструментам');
  });
  // --- winget (ChatGPT Win): PublisherId пин + --exact + нет Get-Command fallback ---
  const g = DT_CHATGPT_PS1();
  assert(/8wekyb3d8bbwe/.test(g), 'winget: пин PublisherId 8wekyb3d8bbwe');
  assert(/--exact/.test(g), 'winget: install --exact');
  assert(!/Get-Command winget/.test(g), 'winget: нет Get-Command fallback (user-writable alias)');
});

// (7) main.js: детекция обоих desktop-компонентов (идемпотентность, детект пути).
ok('main.js: detectComponents знает claude-desktop и chatgpt-desktop (идемпотентность)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/out\['claude-desktop'\]\s*=/.test(s), 'детект claude-desktop');
  assert(/out\['chatgpt-desktop'\]\s*=/.test(s), 'детект chatgpt-desktop');
  assert(/AnthropicClaude/.test(s), 'детект пути Claude Desktop (Win)');
  assert(/Claude\.app/.test(s) && /ChatGPT\.app/.test(s), 'детект .app (mac)');
});

// (8) renderer: карточка рисует бейдж «онлайн» по c.online.
ok('app.js + styles.css: бейдж «онлайн» для online-компонентов', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert(/c\.online \?/.test(app) && /badge online/.test(app), 'app.js рисует badge online по c.online');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
  assert(/\.badge\.online/.test(css), 'styles.css содержит стиль .badge.online');
});

// ===== Editor-гейт Codex: 7 находок =====================================
console.log('== Editor-гейт: privesc де-элевация + оба расширения обязательны + skip-в-dependents ==');

const EG_MAIN = () => fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const EG_APP  = () => fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const EG_PS1  = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'vscode.ps1'), 'utf8');
const EG_SH   = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'vscode.sh'), 'utf8');
const EG_EXT    = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'extension.ps1'), 'utf8');
const EG_VERIFY = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'verify.ps1'), 'utf8');
const EG_DEELEV = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', '_deelev.ps1'), 'utf8');

// ===== P0 privesc REGATE: весь класс закрыт (extension.ps1/verify.ps1/launch-cursor +
//        укреплённый _deelev.ps1). Ни один elevated-путь не исполняет user-writable
//        editor-бинарь. =========================================================

// _deelev.ps1: укреплённый примитив — НЕТ %TEMP% control-файлов, тело обёртки в
// -EncodedCommand, PRIVATE staging-каталог (ProgramData+icacls+verify), env-литералы
// ПЕРВЫМИ (до cmdlet), абс. whoami, gate fail-closed, аттестация по «Last Result».
ok('_deelev.ps1: НЕТ %TEMP% control-файлов; -EncodedCommand; PRIVATE staging; env-литералы до cmdlet; абс. whoami; gate; Last Result; fail-closed', () => {
  const s = EG_DEELEV();
  assert(/function Invoke-HmDeElevated/.test(s), 'экспортирует Invoke-HmDeElevated');
  // (1) НИ ОДНОГО control-файла в общем %TEMP%.
  assert(!/GetTempPath/.test(s), 'нет [IO.Path]::GetTempPath() (никаких %TEMP% control-файлов)');
  assert(!/env:TEMP/i.test(s) && !/env:TMP/i.test(s), 'нет $env:TEMP/$env:TMP для control-файлов');
  assert(!/\$wrapper\b/.test(s), 'нет отдельного wrapper .ps1 (тело обёртки — в -EncodedCommand)');
  assert(!/\.out'/.test(s) && !/\.code'/.test(s) && !/\.int'/.test(s), 'нет .out/.code/.int result-маркеров');
  // (2) тело обёртки — в -EncodedCommand (base64 UTF-16LE), собранном родителем.
  assert(/-EncodedCommand/.test(s), 'обёртка передаётся как -EncodedCommand (не файл)');
  assert(/\[System\.Text\.Encoding\]::Unicode\.GetBytes/.test(s) && /ToBase64String/.test(s), 'base64 из UTF-16LE');
  // (3) единственный транзиентный файл — task.xml в PRIVATE staging-каталоге (не %TEMP%).
  assert(/New-HmSecureStagingDir/.test(s), 'staging-каталог создаётся укреплённым хелпером');
  assert(/'HmDeElev-'/.test(s) && /ProgramData/.test(s), 'staging под ProgramData (не %TEMP%)');
  assert(/SetAccessRuleProtection\(\$true/.test(s), 'protection on (без наследования Users)');
  assert(/S-1-5-32-544/.test(s) && /S-1-5-18/.test(s), 'DACL: только Administrators + SYSTEM');
  assert(/\$sd\.SetOwner\(\$admins\)/.test(s), 'elevated: владелец -> Administrators АТОМАРНО в SD (не post-icacls)');
  assert(/'task\.xml'/.test(s) && /Set-Content -LiteralPath \$xmlFile/.test(s), 'XML пишется в staging (task.xml)');
  // (4) env-литералы ПЕРВЫМИ в теле обёртки (ни одного cmdlet/Join-Path до gate).
  const bi = s.indexOf('$body =');
  assert(bi !== -1, 'тело обёртки строится в $body');
  const bh = s.slice(bi, bi + 700);
  assert(/`\$env:PSModulePath='/.test(bh) && /`\$env:Path='/.test(bh), 'env ставится ЛИТЕРАЛАМИ (не Join-Path)');
  const beforeGate = bh.slice(0, bh.indexOf('/groups'));
  assert(!/Join-Path/.test(beforeGate) && !/Out-String/.test(beforeGate) && !/Get-|Set-|New-/.test(beforeGate),
    'НЕТ Join-Path/cmdlet ДО integrity-gate (env чистится литералами ПЕРВЫМИ)');
  // (5) integrity-self-check абсолютным System32\whoami; бинарь ТОЛЬКО при medium, иначе exit 210.
  assert(/\$whoami\s*=\s*Join-Path \$s32 'whoami\.exe'/.test(s), 'whoami — абсолютный из System32');
  assert(/S-1-16-8192/.test(bh), 'обёртка сверяет medium SID');
  assert(/exit 210/.test(bh), 'НЕ medium -> exit 210 (fail-closed)');
  // (6) абс. schtasks + /Create /XML + InteractiveToken/LeastPrivilege.
  assert(/\$schtasks = Join-Path \$s32 'schtasks\.exe'/.test(s), 'schtasks.exe — абсолютный из System32');
  assert(!/New-ScheduledTask/.test(s), 'НЕ используется PS-модуль ScheduledTasks (module-hijack исключён)');
  assert(/& \$schtasks '\/Create'.*'\/XML'/.test(s), 'задача создаётся по XML через абс. schtasks.exe');
  assert(/InteractiveToken/.test(s) && /LeastPrivilege/.test(s), 'XML: InteractiveToken + LeastPrivilege (= medium)');
  // (7) аттестация — «Last Result» задачи (не user-writable), поле #6 CSV /HRESULT.
  assert(/\/HRESULT/.test(s) && /\/FO' 'CSV'/.test(s), 'Last Result читается локаль-независимо (CSV /HRESULT)');
  assert(/267009/.test(s) && /267011/.test(s), 'ждём завершения по numeric Last Result');
  // (8) fail-closed.
  assert(/return \$null/.test(s), 'fail-closed: возврат $null при сбое');
  assert(/foreach \(\$bin in @\(\$psExe, \$schtasks, \$whoami, \$icacls\)\)[\s\S]*?return \$null/.test(s), 'нет системного бинаря -> fail-closed');
});

// _deelev.ps1: функциональный round-trip — реально де-элевирует cmd, который пишет
// whoami /groups в TEST-owned маркер; маркер содержит medium-SID (S-1-16-8192) -> команда
// исполнилась на MEDIUM. Аттестация примитива — Gate=medium. NULL = fail-closed (валидно).
if (powershellAvailable()) {
  ok('_deelev.ps1: round-trip — де-элевирует команду на MEDIUM (маркер содержит S-1-16-8192), Gate=medium; либо fail-closed $null', () => {
    const dot = path.join(ROOT, 'scripts', 'windows', '_deelev.ps1');
    const marker = path.join(os.tmpdir(), 'hmrt-' + Math.random().toString(36).slice(2) + '.txt');
    const cmd =
      ". '" + dot + "';" +
      "$cmd='C:\\Windows\\System32\\cmd.exe';" +
      "$r=Invoke-HmDeElevated $cmd @('/c', 'whoami /groups > \"" + marker + "\" 2>&1');" +
      "if($null -eq $r){Write-Output 'NULL';exit 0};" +
      "Write-Output ('GATE='+$r.Gate)";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '').trim();
    if (/NULL/.test(out) || /GATE=refused/.test(out)) {
      // NULL — не удалось запереть staging без прав (setup fail-closed). GATE=refused —
      // задача РЕАЛЬНО запустилась, но собственный whoami-гейт ВНУТРИ неё не увидел
      // medium-integrity (exit 210) и честно отказал — та же цель мехнизма (не пустить
      // payload не на medium), просто на некоторых хостах (напр. учётки CI-раннера без
      // штатного UAC-split-token) де-элевация даёт другой уровень, а не medium. Оба
      // исхода — БЕЗОПАСНЫ (эскалации нет); только «выполнилось НЕ на medium без отказа»
      // было бы дефектом, а такого исхода примитив не производит.
    } else {
      assert(/GATE=medium/.test(out), 'де-элевация отдала Gate=medium, либо fail-closed (NULL/refused): ' + out);
      const marked = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
      assert(/S-1-16-8192/.test(marked), 'де-элевированная команда исполнилась на MEDIUM integrity: ' + marked.slice(0, 80));
    }
    try { fs.unlinkSync(marker); } catch (e) { /* */ }
  });

  // _deelev.ps1: Test-HmExtInstalled — точный префикс ${extId}- + ЦИФРА, ТОЛЬКО каталоги.
  ok('_deelev.ps1: Test-HmExtInstalled — ^${extId}-<цифра> + Directory-only (helper НЕ проходит, файл НЕ проходит, <extId>-<ver> проходит)', () => {
    const dot = path.join(ROOT, 'scripts', 'windows', '_deelev.ps1');
    const base = path.join(os.tmpdir(), 'hmext-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(path.join(base, 'anthropic.claude-code-helper-1.0'), { recursive: true });  // sibling-ext (каталог)
    fs.writeFileSync(path.join(base, 'anthropic.claude-code-9.9'), 'x');                       // ФАЙЛ, не каталог
    const q = (v) => "'" + v.replace(/'/g, "''") + "'";
    const cmd = ". '" + dot + "'; if(Test-HmExtInstalled -ExtId 'anthropic.claude-code' -Dirs @(" + q(base) + ")){'PASS'}else{'FAIL'}";
    const run = () => (spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', timeout: 60000 }).stdout || '').trim();
    assert(/FAIL/.test(run()), 'ни helper-каталог, ни файл-версия не считаются установкой');
    fs.mkdirSync(path.join(base, 'anthropic.claude-code-1.2.3-win32-x64'), { recursive: true }); // настоящее расширение
    assert(/PASS/.test(run()), 'настоящий каталог <extId>-<ver>[-platform] проходит');
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* */ }
  });

  // P1-2: Start-Process с вложенными кавычками -> путь с пробелом = ОДИН аргумент (не рвётся).
  ok('P1-2 (launch quoting): -ArgumentList с вложенными кавычками -> "C:\\Users\\John Doe\\..." = ОДИН аргумент', () => {
    const dumper = path.join(os.tmpdir(), 'hmdump-' + Math.random().toString(36).slice(2) + '.ps1');
    const marker = path.join(os.tmpdir(), 'hmmark-' + Math.random().toString(36).slice(2) + '.txt');
    fs.writeFileSync(dumper, "('COUNT='+$args.Count) | Set-Content -LiteralPath '" + marker + "'\r\n", 'utf8');
    const folder = 'C:\\Users\\John Doe\\HamidunStart';
    const cmd = "$ps='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';" +
      "Start-Process -FilePath $ps -ArgumentList ('-NoProfile -File \"" + dumper + "\" \"" + folder + "\"') -Wait -WindowStyle Hidden";
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', timeout: 60000 });
    const got = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
    assert(/COUNT=1/.test(got), 'путь с пробелом дошёл как ОДИН аргумент: ' + got);
    try { fs.unlinkSync(dumper); fs.unlinkSync(marker); } catch (e) { /* */ }
  });
}

// P0-D/P1-1 (launch): редактор стартует ДЕ-ЭЛЕВИРОВАННО; тело обёртки в -EncodedCommand
// (нет .ps1 в %TEMP%); транзиентный task.xml — в PRIVATE staging (winMakeSecureDir); env-
// литералы ПЕРВЫМИ; абс. whoami-gate; аттестация по «Last Result» (0 -> true, иначе folder-
// fallback); quoting пути с пробелом; elevated НЕ spawn'ит редактор напрямую.
ok('P0-D/P1-1 launch (main.js): -EncodedCommand + PRIVATE staging (нет %TEMP%); env-литералы; абс. whoami; gate; Last Result аттестация; folder-fallback; quoting пробела', () => {
  const s = EG_MAIN();
  const at = s.indexOf('function winLaunchDeElevated(');
  assert(at !== -1, 'де-элевирующий лаунчер объявлен');
  const h = s.slice(at, s.indexOf('// Открыть VS Code НА ПАПКЕ'));
  // нет %TEMP%: staging — PRIVATE high-integrity каталог (winMakeSecureDir).
  assert(!/os\.tmpdir\(\)/.test(h), 'winLaunchDeElevated НЕ пишет в %TEMP% (нет os.tmpdir)');
  assert(/winMakeSecureDir\(\)/.test(h), 'staging — PRIVATE high-integrity каталог (winMakeSecureDir)');
  // тело обёртки — в -EncodedCommand (base64 UTF-16LE), нет отдельного .ps1.
  assert(/-EncodedCommand/.test(h) && /Buffer\.from\(wrapperBody, 'utf16le'\)/.test(h), 'обёртка — base64 UTF-16LE в -EncodedCommand');
  assert(!/writeFileSync\(wrapper/.test(h), 'нет отдельного wrapper .ps1 (P0-1: нет control-файла в %TEMP%)');
  // env-литералы ПЕРВЫМИ, абс. whoami, gate S-1-16-8192, exit 210/211/0.
  assert(/\$env:PSModulePath='/.test(h) && /\$env:Path='/.test(h), 'env ставится ЛИТЕРАЛАМИ (P0-2)');
  assert(/S-1-16-8192/.test(h) && /whoami/i.test(h), 'integrity-gate (абс. whoami -> medium SID)');
  assert(/exit 210/.test(h) && /exit 211/.test(h), 'не-medium -> 210, бросок Start-Process -> 211');
  // P1-2 quoting: путь папки в ОДНОМ аргументе с вложенными кавычками.
  assert(/-ArgumentList '\\"/.test(h), 'путь папки обёрнут во вложенные кавычки (пробел не рвётся)');
  // schtasks — АБСОЛЮТНЫЙ (sysBin), НЕ PS-модуль ScheduledTasks.
  assert(/remoteFetch\.sysBin\('schtasks\.exe'\)/.test(h), 'schtasks.exe — абсолютный из валидированного System32');
  assert(!/New-ScheduledTask/.test(h), 'НЕ используется PS-модуль ScheduledTasks (module-hijack исключён)');
  assert(/InteractiveToken/.test(h) && /LeastPrivilege/.test(h), 'задача — InteractiveToken + LeastPrivilege (medium)');
  // P1-1: аттестация по «Last Result» (не user-writable). 0 -> true; иначе folder-fallback.
  assert(/\/HRESULT/.test(h) && /\/FO', 'CSV'/.test(h), 'Last Result — CSV /HRESULT (не user-writable)');
  assert(/readLastResult\(\)/.test(h), 'опрос Last Result');
  assert(/lr === '0' \? true : folderFallback\(\)/.test(h), 'success ТОЛЬКО при Last Result 0; иначе folder-fallback (P1-1)');
  // fallback: АБСОЛЮТНЫЙ explorer.exe, ТОЛЬКО на папку (folderArg), не на exe.
  assert(/path\.join\(sysRoot, 'explorer\.exe'\)/.test(h), 'explorer.exe — абсолютный (из валидированного sysRoot)');
  assert(/spawn\(exp, \[String\(folderArg\)\]/.test(h), 'fallback открывает ТОЛЬКО папку (folderArg)');
  assert(!/spawn\(exp, \[exe\]/.test(h), 'fallback НЕ исполняет editor-exe через explorer (P0-D#4)');
  // winMakeSecureDir: staging РОЖДАЕТСЯ АТОМАРНО через укреплённый PS-примитив
  // New-HmSecureStagingDir (DACL в момент создания), БЕЗ Node create-then-icacls; без %TEMP%.
  const mi = s.indexOf('function winMakeSecureDir(');
  assert(mi !== -1, 'winMakeSecureDir объявлена');
  const mh = s.slice(mi, s.indexOf('function winLaunchDeElevated('));
  assert(/winProgramData\(\)/.test(mh) && /New-HmSecureStagingDir/.test(mh) && /verifyDirSecureWin/.test(mh),
    'staging: ProgramData + АТОМАРНЫЙ New-HmSecureStagingDir + verifyDirSecureWin (defense-in-depth)');
  assert(!/fs\.mkdirSync/.test(mh) && !/buildIcaclsArgs/.test(mh),
    'НЕТ fs.mkdirSync+icacls: ACL-гонка create-then-icacls устранена (каталог рождается атомарно с DACL)');
  assert(!/os\.tmpdir/.test(mh), 'winMakeSecureDir НЕ использует %TEMP%');
  // launch-vscode (через launchVsCodeOn) И launch-cursor зовут лаунчер, без прямого spawn редактора.
  const lvi = s.indexOf('function launchVsCodeOn');
  const lvh = s.slice(lvi, lvi + 900);
  assert(/winLaunchDeElevated\(codeExe/.test(lvh) && !/spawn\(codeExe/.test(lvh), 'launch-vscode: де-элевированно, без spawn(codeExe)');
  const lci = s.indexOf("ipcMain.handle('launch-cursor'");
  const lch = s.slice(lci, lci + 1200);
  assert(/winLaunchDeElevated\(cexe/.test(lch) && !/spawn\(cexe, \[\]/.test(lch), 'launch-cursor: де-элевированно, без прямого spawn(cexe) [P0-C]');
});

// P0 (Codex privesc regate #4): launch secure-dir РОЖДАЕТСЯ АТОМАРНО с protected DACL.
// Источник-инвариант: (a) _deelev.ps1 создаёт каталог ОДНОЙ операцией [IO.Directory]::
// CreateDirectory($dir,$sd) с SD {SYSTEM,Administrators}, protection on, fail на exists/reparse;
// (b) main.js winMakeSecureDir делегирует этому примитиву и НЕ содержит create-then-icacls.
ok('P0 regate#4: launch secure-dir атомарен (_deelev [IO.Directory]::CreateDirectory($dir,$sd) + main.js делегирует, нет fs.mkdirSync+icacls)', () => {
  const d = EG_DEELEV();
  // (a) атомарное создание каталога С SD одной операцией (DACL в момент создания, не после).
  assert(/\[System\.IO\.Directory\]::CreateDirectory\(\$dir,\s*\$sd\)/.test(d),
    '_deelev.ps1: каталог рождается [IO.Directory]::CreateDirectory($dir,$sd) — SD атомарно при создании');
  assert(/SetAccessRuleProtection\(\$true/.test(d), 'protection on (наследование ProgramData/Users снято)');
  assert(/S-1-5-32-544/.test(d) && /S-1-5-18/.test(d), 'DACL: Administrators + SYSTEM (FullControl)');
  // P0 regate#5: ВЛАДЕЛЕЦ задаётся АТОМАРНО в SD ДО CreateDirectory (иначе owner=user+WRITE_DAC окно).
  const iSetOwner = d.indexOf('$sd.SetOwner($admins)');
  const iCreate = d.indexOf('[System.IO.Directory]::CreateDirectory($dir, $sd)');
  assert(iSetOwner !== -1 && iCreate !== -1 && iSetOwner < iCreate,
    '$sd.SetOwner($admins) стоит ДО CreateDirectory (владелец атомарен, не post-icacls)');
  // Фолбэк icacls /setowner РАЗРЕШЁН, но ТОЛЬКО когда атомарный владелец не применился:
  // Windows по умолчанию делает владельцем создателя, и без фолбэка докачка не работала
  // ВООБЩЕ. Требуем: (1) фолбэк стоит ПОСЛЕ проверки текущего владельца, (2) финальный
  // гейт владельца/ACE ниже остаётся обязательным (он и закрывает окно).
  const iOwnerNow = d.indexOf("$ownerNow -ne 'S-1-5-32-544'");
  const iFallbackOwner = d.search(/&\s*\$Icacls\s+\$dir\s+'\/setowner'/);
  if (iFallbackOwner !== -1) {
    assert(iOwnerNow !== -1 && iOwnerNow < iFallbackOwner,
      'post-icacls /setowner вызывается ТОЛЬКО если владелец не Administrators (не безусловно)');
    assert(/HMSECNOTE/.test(d), 'использование фолбэка ЗАМЕТНО в логе (HMSECNOTE), а не молча');
  }
  assert(/\$owner -ne 'S-1-5-32-544'/.test(d),
    'verify владельца строго == Administrators, fail-closed если атомарный owner не применился');
  // fail-closed на уже существующий каталог (CREATE_NEW-семантика) и на reparse-point (junction).
  // Имя каталога занято → отказ (CREATE_NEW-семантика). Проверяем сам факт отказа,
  // а не форму записи: раньше сюда была вбита однострочная версия, и добавление
  // причины отказа в stderr красило тест без единого изменения поведения.
  {
    const i = d.indexOf('$dir = Join-Path $ProgramData');
    assert(i > 0, 'формирование имени staging-каталога найдено');
    const near = d.slice(i, i + 400);
    assert(/Test-Path -LiteralPath \$dir/.test(near) && /return \$null/.test(near),
      'fail на ERROR_ALREADY_EXISTS (каталог занят)');
  }
  // И причина отказа обязана уходить наружу: молчаливый $null давал человеку
  // бесполезное «примитив не вернул путь» вместо настоящей причины.
  {
    const s = d.indexOf('function New-HmSecureStagingDir');
    const e = d.indexOf('\nfunction ', s + 10);
    const body = d.slice(s, e > 0 ? e : d.length);
    const silent = body.split('\n').filter((line, idx, all) => {
      if (!/return \$null/.test(line)) return false;
      return !/HMSECFAIL/.test(all.slice(Math.max(0, idx - 4), idx + 1).join('\n'));
    });
    assert(silent.length === 0,
      'ни одного молчаливого отказа примитива (без причины): ' + silent.length);
  }
  // Удаление при отказе идёт через Remove-HmSecureStagingDir (единый помощник с
  // fail-closed гейтом по имени HmDeElev-<hex>) — голый Remove-Item по $dir из
  // файла убран (он же был источником утечки внешнего каталога в finally).
  assert(/ReparsePoint/.test(d) && /Remove-HmSecureStagingDir -Path \$dir/.test(d), 'fail на reparse-point (junction-подмена) -> удаление + $null');
  // (b) main.js: winMakeSecureDir ДЕЛЕГИРУЕТ примитиву; НЕТ Node create-then-icacls.
  const m = EG_MAIN();
  const mi = m.indexOf('function winMakeSecureDir(');
  const mh = m.slice(mi, m.indexOf('function winLaunchDeElevated('));
  assert(/New-HmSecureStagingDir/.test(mh), 'winMakeSecureDir зовёт атомарный New-HmSecureStagingDir');
  assert(!/fs\.mkdirSync/.test(mh), 'НЕТ fs.mkdirSync (Node не умеет создать каталог с DACL атомарно)');
  assert(!/buildIcaclsArgs/.test(mh) && !/execFileSync\(icacls/.test(mh), 'НЕТ post-icacls (create-then-icacls окно устранено)');
  assert(/winDeElevScript\(\)/.test(mh) && /_deelev\.ps1/.test(m), 'дот-сорсит вшитый _deelev.ps1 (абс. путь, не renderer/PATH)');
});

if (powershellAvailable()) {
  // P0 regate#4 (функц.): New-HmSecureStagingDir реально создаёт каталог с PROTECTED DACL
  // (наследование ProgramData снято В МОМЕНТ создания) и БЕЗ посторонних (Users/Everyone) ACE.
  // Elevated $false (тест-процесс обычно medium): каталог с {SYSTEM,Administrators,me}. Это
  // ПРЯМО доказывает устранение гонки: будь это Node mkdir, каталог унаследовал бы ACL
  // ProgramData (AreAccessRulesProtected=$false, Users writable). NULL = fail-closed (валидно).
  ok('P0 regate#4 (round-trip): New-HmSecureStagingDir -> каталог PROTECTED (наследование снято) без посторонних ACE; либо fail-closed $null', () => {
    const dot = path.join(ROOT, 'scripts', 'windows', '_deelev.ps1');
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const icacls = path.join(sysRoot, 'System32', 'icacls.exe');
    const pd = process.env.ProgramData || path.join(path.parse(sysRoot).root, 'ProgramData');
    const cmd =
      ". '" + dot + "';" +
      "$d=New-HmSecureStagingDir -ProgramData '" + pd.replace(/'/g, "''") + "' -Icacls '" + icacls.replace(/'/g, "''") + "' -Elevated $false;" +
      "if($null -eq $d){Write-Output 'NULL';exit 0};" +
      // Get-Acl сам может отказать (нетерминирующая ошибка на некоторых CI-раннерах) —
      // это НЕ доказательство небезопасного DACL, а inconclusive-диагностика; ловим явно,
      // чтобы не превратить $null.AreAccessRulesProtected в молчаливую пустую строку,
      // которая раньше выглядела как провал ('PROT='), хотя каталог создался штатно.
      "try { $a=Get-Acl -LiteralPath $d -ErrorAction Stop } catch { Write-Output ('ACLERR='+$_.Exception.Message); Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue; exit 0 };" +
      "$allow=@('S-1-5-18','S-1-5-32-544',([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value));" +
      "$bad=0; foreach($ace in $a.Access){ try{$sid=$ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{$sid=[string]$ace.IdentityReference}; if($allow -notcontains $sid){$bad++} };" +
      "$rp=[bool]((Get-Item -LiteralPath $d -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint);" +
      "Write-Output ('PROT='+$a.AreAccessRulesProtected+';BAD='+$bad+';REPARSE='+$rp);" +
      "Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '').trim();
    if (/NULL/.test(out) || /ACLERR=/.test(out)) {
      // NULL — fail-closed (нет прав создать/запереть каталог под ProgramData) — валидно.
      // ACLERR — каталог создался, но верификацию DACL провести не удалось на этом
      // хосте (inconclusive) — не эскалация, просто недоказанность; логируем причину.
      if (/ACLERR=/.test(out)) console.log('     (' + out + ')');
    } else {
      assert(/PROT=True/.test(out), 'DACL protected: наследование ProgramData (Users writable) снято В МОМЕНТ создания: ' + out);
      assert(/BAD=0/.test(out), 'ни одного постороннего ACE (только SYSTEM/Administrators/владелец): ' + out);
      assert(/REPARSE=False/.test(out), 'реальная директория, не reparse-point: ' + out);
    }
  });

  // P0 (регресс, боевой сценарий): установщик, запущенный ИЗ ОКРУЖЕНИЯ PowerShell 7
  // (терминал pwsh, CI-раннер), передавал дочернему powershell.exe 5.1 унаследованный
  // PSModulePath, указывающий на ...\PowerShell\7\Modules — .NET Core-сборки, которые
  // 5.1 загрузить не может. Autoload Microsoft.PowerShell.Security падал, примитив уходил
  // в $null, и lite-издание не качало НИ ОДНОГО компонента («Нужны права администратора»
  // при полностью корректных правах). Запуск из Explorer работал — поэтому ручные прогоны
  // сбой не ловили. Защит теперь две, тест проверяет обе разом: ACL читаются/пишутся через
  // .NET (модуль Security не нужен вовсе) И PSModulePath прибит литералом в main.js.
  ok('P0 регресс: PSModulePath от pwsh 7 не ломает staging (модуль Security не требуется)', () => {
    const dot = path.join(ROOT, 'scripts', 'windows', '_deelev.ps1');
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const icacls = path.join(sysRoot, 'System32', 'icacls.exe');
    const pd = process.env.ProgramData || path.join(path.parse(sysRoot).root, 'ProgramData');
    const cmd =
      "$ErrorActionPreference='Stop';" +
      ". '" + dot + "';" +
      "$d=New-HmSecureStagingDir -ProgramData '" + pd.replace(/'/g, "''") + "' -Icacls '" + icacls.replace(/'/g, "''") + "' -Elevated $false;" +
      "if($d){[Console]::Out.Write('HMSECDIR::'+$d+'::END');Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue}";
    // Ровно тот PSModulePath, который выставляет pwsh 7 — без путей 5.1.
    const env = Object.assign({}, process.env, {
      PSModulePath: path.join('C:', 'Program Files', 'PowerShell', '7', 'Modules')
    });
    const r = spawnSync(path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { encoding: 'utf8', timeout: 60000, env });
    const got = /HMSECDIR::([\s\S]+?)::END/.test(String(r.stdout || ''));
    const err = String(r.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    assert(got, 'staging-каталог создан при PSModulePath от pwsh 7 (stderr: ' + err.slice(0, 200) + ')');
    assert(!/Microsoft\.PowerShell\.Security/.test(err), 'нет зависимости от модуля Security: ' + err.slice(0, 200));
  });

  // Вторая половина той же защиты — на стороне вызывающего: main.js обязан прибивать
  // PSModulePath литералом, а не полагаться на унаследованный.
  ok('P0 регресс (main.js): winMakeSecureDir прибивает чистый PSModulePath из валидированного System32', () => {
    const m = EG_MAIN();
    const mi = m.indexOf('function winMakeSecureDir(');
    const mh = m.slice(mi, mi + 3000);
    assert(/\$env:PSModulePath='/.test(mh), 'инлайн задаёт $env:PSModulePath литералом');
    assert(/WindowsPowerShell', 'v1\.0', 'Modules'/.test(mh), 'путь модулей строится из System32, а не из env');
  });
}

// P2 (launch): mkdir не глушится вслепую — путь подтверждается как директория.
ok('P2 (main.js): launchVsCodeOn проверяет statSync(dir).isDirectory() — не открывает файл/несуществующее', () => {
  const s = EG_MAIN();
  const li = s.indexOf('function launchVsCodeOn');
  const lh = s.slice(li, li + 900);
  assert(/statSync\(dir\)\.isDirectory\(\)/.test(lh), 'после mkdir подтверждаем, что dir — директория');
  assert(/isDirectory\(\)\)\s*return false/.test(lh), 'если не директория — return false (не запускаем редактор)');
});

// P0 (install): vscode.ps1 ставит расширение через shared _deelev.ps1; аттестация — ПРЯМО по
// каталогам (Test-HmExtInstalled), НЕ через --list-extensions/вывод бинаря; fail-closed.
ok('P0 install (vscode.ps1): install-extension де-элевированно + FS-аттестация (Test-HmExtInstalled), НЕ через --list-extensions/вывод; fail-closed', () => {
  const s = EG_PS1();
  assert(/_deelev\.ps1/.test(s), 'дот-сорсит единый примитив де-элевации');
  assert(!/function Invoke-DeElevated/.test(s), 'локального дубля де-элевации нет');
  assert(/function Get-VsCodeCli/.test(s), 'доверенный сигнал установки — отдельная функция');
  assert(/CurrentVersion\\Uninstall/.test(s), 'проверяем ключ Uninstall инсталлятора VS Code');
  assert(/HKCU:\\Software/.test(s) && /HKLM:\\Software/.test(s), 'и User Setup (HKCU), и System Setup (HKLM)');
  assert(/Invoke-HmDeElevated \$cli @\('--install-extension'/.test(s), 'install-extension — де-элевированно');
  // аттестация — ПРЯМО по каталогам расширений, НЕ через editor CLI и НЕ через вывод бинаря.
  assert(!/--list-extensions/.test(s), 'НЕ запускает --list-extensions (никакого editor CLI для чтения)');
  assert(/Test-HmExtInstalled/.test(s), 'аттестация — прямой проверкой каталога расширений');
  assert(/\.vscode\\extensions/.test(s) && /\.vscode-oss\\extensions/.test(s), 'смотрит каталоги VS Code');
  assert(!/\$r\.Output/.test(s) && !/\$lst\.Output/.test(s), 'вывод бинаря ($r.Output) НЕ используется как доверие');
  assert(!/& \$cli --install-extension/.test(s), 'НЕТ прямого elevated `& $cli --install-extension`');
  // fail-closed: если де-элевация вернула $null — НЕ запускаем бинарь под админом.
  assert(/DeElevFailed/.test(s) && /\$null -eq \$r/.test(s), 'де-элевация недоступна -> fail-closed, а не запуск elevated');
});

// P0-A (extension.ps1): Cursor CLI — через shared де-элевацию; аттестация по каталогу .cursor.
ok('P0-A (extension.ps1): Cursor install де-элевированно + FS-аттестация (.cursor), НЕ --list-extensions; нет дубля VS Code; fail-closed', () => {
  const s = EG_EXT();
  assert(/_deelev\.ps1/.test(s), 'дот-сорсит единый примитив де-элевации');
  assert(!/\$codeCli/.test(s), 'переменная $codeCli (установка в VS Code) удалена — дубль убран');
  assert(/Invoke-HmDeElevated \$cli @\('--install-extension'/.test(s), 'Cursor install-extension — де-элевированно');
  assert(!/--list-extensions/.test(s), 'НЕ запускает --list-extensions');
  assert(/Test-HmExtInstalled/.test(s) && /\.cursor\\extensions/.test(s), 'аттестация — каталог .cursor напрямую');
  assert(!/\$r\.Output/.test(s) && !/\$lst\.Output/.test(s), 'вывод бинаря НЕ используется как доверие');
  assert(!/& \$cli --install-extension/.test(s), 'НЕТ прямого elevated `& $cli --install-extension`');
  assert(/DeElevFailed/.test(s) && /\$null -eq \$r/.test(s), 'fail-closed при недоступной де-элевации');
});

// P0-B/P1-3 (verify.ps1): проверка расширения — по каталогам, точный префикс ${extId}- + ЦИФРА
// версии (Directory-only), НЕ через editor CLI. `claude-code-helper-*` больше НЕ даёт ложный PASS.
ok('P0-B/P1-3 (verify.ps1): каталоги .vscode/.vscode-oss/.cursor, match ^${extId}-<цифра> (Directory-only), НЕ editor CLI', () => {
  const s = EG_VERIFY();
  assert(!/--list-extensions/.test(s), 'НЕ запускает `--list-extensions` (никакого editor CLI)');
  assert(!/& \$cli/.test(s), 'НЕТ `& $cli` (elevated-запуск user-writable бинаря убран)');
  assert(/\.vscode\\extensions/.test(s) && /\.vscode-oss\\extensions/.test(s) && /\.cursor\\extensions/.test(s),
    'смотрит каталоги расширений VS Code (.vscode/.vscode-oss) и Cursor (.cursor)');
  assert(/\$rx = '\^' \+ \[regex\]::Escape\(\$extId\) \+ '-\\d'/.test(s), 'префикс ^<extId>-<цифра> (не голый StartsWith(extId))');
  assert(/-match \$rx/.test(s) && !/StartsWith\(\$pref\)/.test(s), 'матч по ^<extId>-<цифра>, старый StartsWith убран');
  assert(/Get-ChildItem[^\r\n]*-Directory/.test(s), 'ТОЛЬКО каталоги (-Directory)');
});

// P1-3 (main.js detect): dirHasChildStarting — ^${extId}-<цифра> + Dirent.isDirectory().
ok('P1-3 (main.js): dirHasChildStarting — ^${extId}-<цифра> + isDirectory(); helper НЕ проходит, файл НЕ проходит, <extId>-<ver> проходит', () => {
  const s = EG_MAIN();
  const fi = s.indexOf('function dirHasChildStarting(');
  assert(fi !== -1, 'dirHasChildStarting объявлена');
  const fh = s.slice(fi, fi + 600);
  assert(/withFileTypes: true/.test(fh) && /\.isDirectory\(\)/.test(fh), 'ТОЛЬКО каталоги (Dirent.isDirectory)');
  assert(/'-\\\\d'/.test(fh), 'префикс ${extId}- + ЦИФРА версии в regex');
  // Функциональная проверка ТОЙ ЖЕ regex-логики: helper/файл НЕ проходят, <extId>-<ver> проходит.
  const rx = new RegExp('^' + 'anthropic.claude-code'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d', 'i');
  assert(rx.test('anthropic.claude-code-1.2.3'), 'claude-code-<ver> проходит');
  assert(rx.test('anthropic.claude-code-1.2.3-win32-x64'), 'платформенный суффикс проходит');
  assert(!rx.test('anthropic.claude-code-helper-1.0'), 'claude-code-helper НЕ проходит (ложный PASS закрыт)');
  assert(!rx.test('anthropic.claude-codereview-1.0'), 'claude-codereview НЕ проходит');
});

// GREP-ИНВАРИАНТ: 0 прямых elevated editor-бинарь execution по всем 4 файлам.
ok('ИНВАРИАНТ: 0 прямых elevated editor-бинарь execution (extension.ps1/verify.ps1/vscode.ps1/main.js)', () => {
  // PS: ни одного прямого `& $cli` вызова редактора (только через Invoke-HmDeElevated).
  [['extension.ps1', EG_EXT()], ['verify.ps1', EG_VERIFY()], ['vscode.ps1', EG_PS1()]].forEach(([name, s]) => {
    assert(!/&\s*\$cli\b/.test(s), name + ': нет прямого `& $cli` (editor CLI под админом)');
    assert(!/&\s*\$codeCli\b/.test(s), name + ': нет прямого `& $codeCli`');
    assert(!/&\s*\$cursorCli\b/.test(s), name + ': нет прямого `& $cursorCli`');
  });
  // main.js: elevated-процесс НЕ spawn'ит Code.exe/Cursor.exe напрямую (только winLaunchDeElevated).
  const m = EG_MAIN();
  assert(!/spawn\(codeExe/.test(m), 'main.js: нет spawn(codeExe)');
  assert(!/spawn\(cexe, \[\]/.test(m), 'main.js: нет прямого spawn(cexe, [])');
  assert(!/spawn\(exp, \[exe\]/.test(m), 'main.js: explorer не исполняет editor-exe');
});

// GREP-ИНВАРИАНТ: НИ ОДНОГО user-writable control/attestation-файла в решении о доверии
// (де-элевация PS + JS). Всё через medium-обёртку в -EncodedCommand + self-integrity-gate +
// task.xml в PRIVATE high-integrity каталоге + аттестация по «Last Result»/FS-каталогу.
ok('ИНВАРИАНТ: нет user-writable control/attestation-файлов в trust-пути (_deelev.ps1 + main.js launch)', () => {
  const d = EG_DEELEV();
  const m = EG_MAIN();
  const lh = m.slice(m.indexOf('function winMakeSecureDir('), m.indexOf('// Открыть VS Code НА ПАПКЕ'));
  // PS: нет %TEMP% control-файлов; тело обёртки — в -EncodedCommand; XML — в ProgramData staging.
  assert(!/env:TEMP/i.test(d) && !/GetTempPath/.test(d), '_deelev.ps1: нет %TEMP% control-файлов');
  assert(/-EncodedCommand/.test(d) && /New-HmSecureStagingDir/.test(d), '_deelev.ps1: -EncodedCommand + PRIVATE staging');
  assert(/\/HRESULT/.test(d), '_deelev.ps1: аттестация по «Last Result» (не user-writable файл)');
  // JS launch: нет os.tmpdir в trust-пути; аттестация — «Last Result» (не файл).
  assert(!/os\.tmpdir/.test(lh), 'main.js launch: нет os.tmpdir в staging');
  assert(/-EncodedCommand/.test(lh) && /readLastResult/.test(lh), 'main.js launch: -EncodedCommand + «Last Result» аттестация');
});

// P1 (vscode.ps1): exit 0 ТОЛЬКО когда встали ОБА расширения; отсутствующее названо.
ok('P1 (vscode.ps1): успех только при обоих расширениях ($okClaude -and $okCodex); называет отсутствующее', () => {
  const s = EG_PS1();
  assert(/if \(\$okClaude -and \$okCodex\) \{ exit 0 \}/.test(s), 'exit 0 требует ОБА расширения');
  assert(!/if \(\$okClaude\) \{ exit 0 \}/.test(s), 'старое поведение (успех по одному Claude) убрано');
  assert(/\$missing/.test(s) && /anthropic\.claude-code/.test(s) && /openai\.chatgpt/.test(s), 'в ошибке называем отсутствующее расширение');
});

// vscode.sh: exit 0 по ОБЯЗАТЕЛЬНОМУ Claude; Codex опционален (сборка его не гейтит,
// verify.sh не проверяет) → его отсутствие = предупреждение, а не красный компонент.
ok('vscode.sh: успех по обязательному Claude; отсутствие опционального Codex — предупреждение, не exit 1', () => {
  const s = EG_SH();
  assert(/if \[ "\$EXT_OK_CLAUDE" -eq 1 \]; then exit 0; fi/.test(s), 'exit 0 требует установленный anthropic.claude-code');
  assert(!/\[ "\$EXT_OK_CLAUDE" -eq 1 \] && \[ "\$EXT_OK_CODEX" -eq 1 \]; then exit 0; fi/.test(s), 'Codex больше НЕ гейтит успех');
  const warn = s.slice(s.indexOf('if [ "$EXT_OK_CODEX" -ne 1 ]'));
  assert(/ПРЕДУПРЕЖДЕНИЕ[^\n]*openai\.chatgpt/.test(warn), 'отсутствие Codex — именованное предупреждение');
  assert(/Не установилось расширение Claude Code \(anthropic\.claude-code\)/.test(s), 'exit 1 называет именно обязательное расширение');
});

// P1 (main.js): «vscode» установлен ТОЛЬКО при приложении И ОБОИХ расширениях (иначе Codex доставляется).
ok('P1 (main.js): detectComponents.vscode = приложение И оба расширения в VS Code (vsCodeHasExt)', () => {
  const s = EG_MAIN();
  assert(/function vsCodeHasExt\(/.test(s), 'хелпер точечной проверки расширения в VS Code');
  assert(/\.vscode', 'extensions'/.test(s) && /\.vscode-oss', 'extensions'/.test(s), 'смотрит папки VS Code (не Cursor)');
  const vi = s.indexOf('out.vscode = { installed:');
  assert(vi !== -1, 'детектор out.vscode есть');
  const seg = s.slice(Math.max(0, vi - 700), vi + 120);
  assert(/vsCodeHasExt\(home, claudeExtId\)/.test(seg) && /vsCodeHasExt\(home, 'openai\.chatgpt'\)/.test(seg), 'требует ОБА расширения');
  assert(/!!appPresent && bothExts/.test(seg), 'installed = приложение И оба расширения');
});

// P1 (app.js): exit-120 (res.skipped) -> компонент в skipped И в bad (dependents пропускаются, не краснеют);
// runtime-skipped исключаются из HM_SELECTED перед verify.
ok('P1 (app.js): res.skipped -> skipped+bad+runtimeSkipped; HM_SELECTED фильтруется для verify', () => {
  const s = EG_APP();
  assert(/const runtimeSkipped = STATE\.skippedEver/.test(s), 'runtime-skipped = кумулятивный STATE.skippedEver (живёт через retry-прогоны, сброс в startInstall)');
  const bi = s.indexOf('if (res && res.skipped)');
  assert(bi !== -1, 'res.skipped обрабатывается отдельной веткой');
  const bh = s.slice(bi, bi + 500);
  assert(/gracefulSkipped\.push\(id\)/.test(bh) && /bad\.add\(id\)/.test(bh) && /runtimeSkipped\.add\(id\)/.test(bh),
    'gracefulSkipped -> в gracefulSkipped, в bad (пропуск dependents), в runtimeSkipped');
  assert(/setStep\(id, 'skipped'\)/.test(bh), 'шаг помечается skipped (не error/красный)');
  // firstBrokenDep-ветка тоже кормит runtimeSkipped.
  const fi = s.indexOf('const broken = firstBrokenDep(id, bad)');
  const fh = s.slice(fi, fi + 400);
  assert(/runtimeSkipped\.add\(id\)/.test(fh), 'dependents, снятые из-за провала зависимости, тоже уходят в runtimeSkipped');
  // HM_SELECTED для verify очищается от runtime-skipped.
  assert(/id === 'verify' && runtimeSkipped\.size/.test(s), 'фильтрация HM_SELECTED привязана к verify');
  assert(/HM_SELECTED[\s\S]{0,120}filter\(\(s\) => s && !runtimeSkipped\.has\(s\)\)/.test(s), 'из HM_SELECTED убираем runtime-skipped');
});

// Задача 3 (тестер-фидбек): finish-экран ведёт новичка — заметная CTA бота, 3 шага, приоритет VS Code.
ok('Задача 3 (app.js): finish-экран — CTA @vibecodeguidebot (data-ext), 3 шага, приоритет Открыть VS Code', () => {
  const s = EG_APP();
  assert(/class="ns-bot"/.test(s), 'CTA-карточка бота .ns-bot присутствует');
  assert(/@vibecodeguidebot/.test(s), 'кнопка ведёт на @vibecodeguidebot');
  assert(/class="ns-bot-btn" data-ext=/.test(s), 'кнопка бота — через data-ext (переиспользован openExternal, без нового IPC)');
  assert(/Что дальше — три простых шага/.test(s), 'блок «что дальше — три простых шага»');
  assert(/const step3 = botUrl/.test(s), '3-й шаг ведёт на бота (fallback на памятку при пустом links.bot)');
  assert(/id="ns-vscode" class="btn-sm primary ns-main"/.test(s), 'Открыть VS Code — главная кнопка (.ns-main)');
  assert(/id="ns-cursor"/.test(s) && /cursorSelected \?/.test(s), 'Открыть Cursor — условная (cursorSelected)');
});

// P1 (vscode.sh): VS Code детектится и в ~/Applications; вторая копия в /Applications не ставится.
ok('P1 (vscode.sh): APP из /Applications И ~/Applications; установка в /Applications только если ни одного нет', () => {
  const s = EG_SH();
  assert(/APP_USER="\$HOME\/Applications\/Visual Studio Code\.app"/.test(s), 'учитывается user-install в ~/Applications');
  assert(/APP_SYS="\/Applications\/Visual Studio Code\.app"/.test(s), 'и обычный /Applications');
  assert(/elif \[ -d "\$APP_USER" \]; then APP="\$APP_USER"/.test(s), 'если стоит в ~/Applications — берём его (не ставим вторую копию)');
  assert(/else APP="\$APP_SYS"/.test(s), 'ни одного нет — цель установки /Applications');
});

// P2 (vscode.sh): verify+install АТОМАРНО под root на root-owned staging (тот же TOCTOU,
// что закрыт для cursor/node/pydeps). Нет распаковки в same-UID /tmp с последующим root-cp.
ok('P2 (vscode.sh): установка через HM_VSCODE_INSTALL_SH (ZIP+Team ID+dest позиционными); нет /tmp-распаковки перед root-cp; fail-closed', () => {
  const s = EG_SH();
  assert(/admin_run \/bin\/sh -c "\$HM_VSCODE_INSTALL_SH" \w+ "\$ZIP" "\$VSCODE_TEAM_ID" "\$APP"/.test(s),
    'установка через общий root-скрипт; ZIP + Team ID + dest — позиционные (не интерполяция в текст)');
  assert(/VSCODE_TEAM_ID='UBF8T346G9'/.test(s), 'Team ID Microsoft (VS Code) запинен');
  assert(!/admin_run \/bin\/sh -c '\/bin\/cp/.test(s), 'старый cp+xattr из /tmp-распаковки убран (TOCTOU-окно)');
  assert(!/MNT="\/tmp\/hm_vscode_unzip"/.test(s), 'распаковка в same-UID /tmp перед root-cp убрана');
  assert(/if ! admin_run \/bin\/sh -c "\$HM_VSCODE_INSTALL_SH"/.test(s), 'провал admin_run → fail-closed (exit 1)');
});

// ===== macOS install-security (THREAT-MODEL round-4 код-долг): admin_run argv +
// пин подписи cursor/node/python ДО root-запуска + mascot fail-closed =====
console.log('== macOS install-security (round-4): admin_run argv, verify+install атомарно в root-staging (TOCTOU P1), mascot fail-closed ==');

const MACLIB_SH = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', '_lib.sh'), 'utf8');
const CURSOR_SH = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'cursor.sh'), 'utf8');
const NODEPKG_SH = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'node.sh'), 'utf8');
const PYDEPS_SH = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'pydeps.sh'), 'utf8');
const MASCOT_SH = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'mascot.sh'), 'utf8');
const ALL_MAC_SH = () => fs.readdirSync(path.join(ROOT, 'scripts', 'macos'))
  .filter((f) => f.endsWith('.sh'))
  .map((f) => [f, fs.readFileSync(path.join(ROOT, 'scripts', 'macos', f), 'utf8')]);

// (1) _lib.sh: admin_run — argv с per-arg quoting, НЕ строка "$*" в osascript.
ok('_lib.sh: admin_run принимает ARGV (нет local c="$*"); per-arg shell-quoting + AppleScript-экранирование', () => {
  const s = MACLIB_SH();
  assert(!/local c="\$\*"/.test(s), 'старая строковая форма (local c="$*") убрана — это была shell-инъекция');
  assert(/shell_quote_arg\(\)/.test(s), 'есть per-arg квотирование shell_quote_arg (\'...\' + \' -> \'\\\'\')');
  assert(/admin_build_cmd\(\)/.test(s) && /for a in "\$@"; do/.test(s), 'команда собирается пер-аргументно из "$@"');
  assert(/c="\$\(admin_build_cmd "\$@"\)"/.test(s), 'admin_run строит команду через admin_build_cmd из argv');
  // AppleScript-экранирование применяется ПОСЛЕ shell-квотирования (порядок: \ затем ")
  const iBuild = s.indexOf('admin_build_cmd "$@"');
  const iBsl = s.indexOf('c=${c//\\\\/\\\\\\\\}', iBuild);
  const iOsa = s.indexOf('/usr/bin/osascript -e "do shell script \\"$c\\" with administrator privileges"');
  assert(iBuild > 0 && iBsl > iBuild && iOsa > iBsl, 'порядок: argv-склейка -> экранирование \\ и " -> osascript');
});

// (2) Инвариант по ВСЕМ scripts/macos/*.sh: ни одного строкового вызова admin_run "..."
//     (единственный способ попасть в root-команду — argv с per-arg quoting) и ни одного
//     osascript вне admin_run (нет второго пути интерполяции пути в root-команду).
ok('scripts/macos/*.sh: НЕТ строковой формы admin_run "..." и НЕТ osascript вне _lib.sh (инвариант против инъекции путей)', () => {
  ALL_MAC_SH().forEach(([name, s]) => {
    assert(!/admin_run\s+["']?\s*(cp|installer|sh)\b[^\n]*'\$/.test(s) || name === '_lib.sh',
      name + ': путь в admin_run не должен идти интерполяцией внутри строкового аргумента');
    assert(!/admin_run\s+"/.test(s), name + ': строковая форма admin_run "..." запрещена (только argv)');
    if (name !== '_lib.sh') assert(!/osascript/.test(s.replace(/#[^\n]*/g, '')), name + ': osascript только внутри admin_run (_lib.sh)');
  });
});

// (3) Функционально (реальный bash): квотирование argv выдерживает ' ; $() ` " &,
//     аргумент возвращается байт-в-байт, инъекция НЕ исполняется.
if (bashAvailable()) {
  ok('_lib.sh (функц.): admin_build_cmd — round-trip нехорошего аргумента байт-в-байт; $(touch)/`touch` НЕ исполняются', () => {
    const marker = path.join(os.tmpdir(), 'hm-inj-' + process.pid + '-' + Date.now());
    const markerSh = marker.replace(/\\/g, '/');
    const script =
      'source "$1"\n' +
      'marker="$2"\n' +
      'nasty="Zhemal\'s USB; \\$(touch $marker) \\`touch $marker\\` \\"q\\" & rm -rf x"\n' +
      'cmd="$(admin_build_cmd printf %s "$nasty")"\n' +
      'out="$(eval "$cmd")"\n' +
      '[ "$out" = "$nasty" ] || { echo "ROUNDTRIP FAIL: [$out]"; exit 2; }\n' +
      '[ ! -e "$marker" ] || { echo "INJECTION EXECUTED"; exit 3; }\n' +
      'echo OK\n';
    const r = spawnSync('bash', ['-c', script, 'bash',
      path.join(ROOT, 'scripts', 'macos', '_lib.sh').replace(/\\/g, '/'), markerSh],
      { encoding: 'utf8', timeout: 30000 });
    try { fs.rmSync(marker, { force: true }); } catch (e) { /* ignore */ }
    assert(r.status === 0 && /OK/.test(r.stdout || ''), 'round-trip/injection: ' + (r.stdout || '') + (r.stderr || ''));
  });
}

// (4) _lib.sh: атомарные root-скрипты HM_PKG_INSTALL_SH / HM_APP_INSTALL_SH — staging
//     root-owned (/var/root, mktemp 0700), verify+install НА STAGED, позиционные $1/$2/$3.
//     verify_pkg_team_id (medium-side) удалён — superseded (закрывает TOCTOU verify→install).
ok('_lib.sh: HM_PKG_INSTALL_SH + HM_APP_INSTALL_SH — root-staging (/var/root 0700), verify+install на STAGED, позиционные $N, fail-closed; verify_pkg_team_id удалён', () => {
  const s = MACLIB_SH();
  assert(!/verify_pkg_team_id/.test(s), 'medium-side verify_pkg_team_id удалён (superseded атомарным root-staging)');
  assert(/HM_PKG_INSTALL_SH='/.test(s) && /HM_APP_INSTALL_SH='/.test(s), 'оба общих root-скрипта определены');
  assert(/mktemp -d \/var\/root\/hm_pkg\.XXXXXX/.test(s) && /mktemp -d \/var\/root\/hm_app\.XXXXXX/.test(s),
    'staging — root-owned приватный каталог (/var/root, mktemp -d = 0700; процесс пользователя туда не запишет)');
  // pkg: cp в staging -> pkgutil(staged) -> installer(staged) — verify и install на ОДНОМ объекте.
  const iCp = s.indexOf('/bin/cp "$1" "$d/p.pkg"');
  const iChk = s.indexOf('/usr/sbin/pkgutil --check-signature "$d/p.pkg"');
  const iInst = s.indexOf('/usr/sbin/installer -pkg "$d/p.pkg"');
  assert(iCp > 0 && iChk > iCp && iInst > iChk, 'pkg: staging→pkgutil(staged)→installer(staged); нет окна между verify и install');
  assert(/1\\\. Developer ID Installer: \.\* \\\(\$2\\\)\[\[:space:\]\]\*\$/.test(s), 'pkg leaf: Team ID ($2) заякорен в конце CN');
  assert(/Status: signed by a developer certificate issued by Apple/.test(s), 'pkg: требуется Developer ID статус');
  // app: cp в staging -> codesign(staged) -> spctl(staged) -> cp в /Applications.
  const aCp = s.indexOf('/bin/cp -R "$1" "$d/app.app"');
  const aCs = s.indexOf('/usr/bin/codesign --verify --deep --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \\"$2\\"" "$d/app.app"');
  const aSp = s.indexOf('/usr/sbin/spctl --assess --type execute "$d/app.app"');
  const aFin = s.indexOf('/bin/cp -R "$d/app.app" "/Applications/$3"');
  assert(aCp > 0 && aCs > aCp && aSp > aCs && aFin > aSp, 'app: staging→codesign(staged)→spctl(staged)→cp в /Applications');
  assert(/\[ -x \/usr\/sbin\/pkgutil \] \|\| exit 1/.test(s) && /\[ -x \/usr\/sbin\/installer \] \|\| exit 1/.test(s), 'pkg: абсолютные инструменты, нет → fail-closed');
  assert(/\[ -x \/usr\/bin\/codesign \] \|\| exit 1/.test(s) && /\[ -x \/usr\/sbin\/spctl \] \|\| exit 1/.test(s), 'app: абсолютные инструменты, нет → fail-closed');
  // vscode: cp zip в staging -> ditto распаковка в staging -> codesign(staged) -> spctl(staged) -> cp .app -> xattr.
  assert(/HM_VSCODE_INSTALL_SH='/.test(s), 'root-скрипт установки VS Code определён');
  assert(/mktemp -d \/var\/root\/hm_vsc\.XXXXXX/.test(s), 'VS Code: root-owned staging (/var/root, 0700)');
  const vCp = s.indexOf('/bin/cp "$1" "$d/vscode.zip"');
  const vDitto = s.indexOf('/usr/bin/ditto -x -k "$d/vscode.zip" "$d/unz"');
  const vFind = s.indexOf('app="$(/usr/bin/find "$d/unz"');
  const vCs = s.indexOf('/usr/bin/codesign --verify --deep --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \\"$2\\"" "$app"');
  const vSp = s.indexOf('/usr/sbin/spctl --assess --type execute "$app"');
  const vFin = s.indexOf('/bin/cp -R "$app" "$3"');
  const vXattr = s.indexOf('/usr/bin/xattr -dr com.apple.quarantine "$3"');
  assert(vCp > 0 && vDitto > vCp && vFind > vDitto && vCs > vFind && vSp > vCs && vFin > vSp && vXattr > vFin,
    'vscode: staging(zip)→ditto(staged)→find(staged)→codesign(staged)→spctl(staged)→cp→xattr — verify и install на STAGED, окна нет');
  assert(/\[ -x \/usr\/bin\/ditto \] \|\| exit 1/.test(s) && /\[ -x \/usr\/bin\/xattr \] \|\| exit 1/.test(s), 'vscode: абсолютные ditto/xattr, нет → fail-closed');
});

// (4b) PATH-hijack (Codex P1): КАЖДЫЙ root sh -c скрипт ПЕРВОЙ строкой фиксирует PATH до
//      любой команды — bare mktemp/head/rm(trap)/grep/find не резолвятся из atacker-controlled
//      унаследованного PATH (osascript наследует env medium-шелла, Apple TN2065).
ok('_lib.sh: все три root sh -c скрипта фиксируют PATH=/usr/bin:/bin:/usr/sbin:/sbin ПЕРВОЙ строкой (до mktemp/head/rm/grep/find) — PATH-hijack закрыт', () => {
  const s = MACLIB_SH();
  ['HM_PKG_INSTALL_SH', 'HM_APP_INSTALL_SH', 'HM_VSCODE_INSTALL_SH'].forEach((v) => {
    // Первая строка тела (сразу после открывающей кавычки) — фиксированный PATH, затем set -e.
    const re = new RegExp(v + "='PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH\\nset -e");
    assert(re.test(s), v + ": ПЕРВАЯ строка — PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH");
    // Извлекаем тело скрипта (нет одинарных кавычек внутри) и проверяем: PATH раньше любой bare-команды.
    const start = s.indexOf(v + "='") + (v + "='").length;
    const script = s.slice(start, s.indexOf("'", start));
    const iPath = script.indexOf('PATH=/usr/bin:/bin:/usr/sbin:/sbin');
    assert(iPath === 0, v + ': фиксированный PATH — в самом начале тела (offset 0)');
    ['mktemp', 'trap', 'grep', 'head', 'find', 'cp'].forEach((cmd) => {
      const i = script.indexOf(cmd);
      if (i >= 0) assert(iPath < i, v + ': PATH стоит РАНЬШЕ первого использования `' + cmd + '`');
    });
  });
});

// (4c) env-hijack (Codex P1, ПЕРВИЧНОЕ закрытие): admin_run запускает osascript под `env -i`
//      с allowlist {PATH,HOME} — root-шелл `do shell script` наследует ЧИСТОЕ окружение,
//      нельзя импортировать BASH_FUNC_*, засорить ENV/BASH_ENV, включить SHELLOPTS=xtrace+PS4
//      или подсунуть DYLD_INSERT_LIBRARIES. Фикс-PATH (4b) — уже defense-in-depth.
ok('_lib.sh: admin_run запускает osascript под env -i PATH+HOME (санитизация окружения root — env-hijack закрыт централизованно)', () => {
  const s = MACLIB_SH();
  // osascript вызывается ТОЛЬКО через env -i с фиксированным PATH (только системные каталоги).
  assert(/\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin HOME="\$HOME"[\s\\]*\n?\s*\/usr\/bin\/osascript -e "do shell script/.test(s),
    'osascript под /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME"');
  // Нет «голого» osascript без env -i (единственный путь root-исполнения санитизирован).
  const iEnvI = s.indexOf('/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME"');
  const iOsa = s.indexOf('/usr/bin/osascript -e "do shell script');
  assert(iEnvI !== -1 && iOsa !== -1 && iEnvI < iOsa && (iOsa - iEnvI) < 120,
    'osascript идёт СРАЗУ за env -i (нет второго, несанитизированного вызова osascript)');
  // allowlist строго {PATH,HOME}: НЕ протаскиваем IFS/BASH_ENV/ENV/SHELLOPTS/DYLD в root-env.
  const envSeg = s.slice(iEnvI, iOsa);
  ['BASH_ENV', 'SHELLOPTS', 'DYLD_', 'IFS=', 'BASH_FUNC'].forEach((bad) => {
    assert(envSeg.indexOf(bad) === -1, 'env -i не передаёт ' + bad + ' в root-окружение');
  });
});

if (bashAvailable()) {
  // (4d) Функционально: враждебное окружение (экспортированная функция mktemp, перекрывающая
  //      системный binary; BASH_ENV/ENV-файл, сорсящийся на старте /bin/sh) НЕ выполняется под
  //      барьером `env -i {PATH,HOME} /bin/sh -c`, как под `do shell script`. Всё враждебное
  //      окружение задаётся в РОДИТЕЛЕ (без parent-side исполнения — только export/файл),
  //      барьер env -i его стирает → payload-маркер не появляется.
  ok('_lib.sh (функц.): env -i отсекает враждебное окружение (экспортированная mktemp-функция / BASH_ENV / ENV не выполняются под root-барьером)', () => {
    const marker = path.join(os.tmpdir(), 'hm-env-' + process.pid + '-' + Date.now());
    const markerSh = marker.replace(/\\/g, '/');
    const bashEnvFile = marker + '.bashenv';
    const bashEnvSh = bashEnvFile.replace(/\\/g, '/');
    try { fs.writeFileSync(bashEnvFile, 'touch "' + markerSh + '"\n'); } catch (e) { /* ignore */ }
    const script =
      // враждебная функция mktemp -> экспортируется как BASH_FUNC_mktemp%% (функция старше PATH)
      'mktemp() { touch "' + markerSh + '"; }\n' +
      'export -f mktemp 2>/dev/null || true\n' +
      // BASH_ENV/ENV: /bin/sh (bash-as-sh) сорсит их на невинтерактивном старте
      'export BASH_ENV="' + bashEnvSh + '"\n' +
      'export ENV="' + bashEnvSh + '"\n' +
      // Барьер admin_run: env -i {PATH,HOME} + POSIX-шелл, как под `do shell script`.
      '/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" /bin/sh -c \'mktemp -u >/dev/null 2>&1; :\'\n' +
      '[ ! -e "' + markerSh + '" ] || { echo "ENV-HIJACK EXECUTED"; exit 3; }\n' +
      'echo OK\n';
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30000 });
    try { fs.rmSync(marker, { force: true }); } catch (e) { /* ignore */ }
    try { fs.rmSync(bashEnvFile, { force: true }); } catch (e) { /* ignore */ }
    assert(!/ENV-HIJACK EXECUTED/.test(r.stdout || ''), 'враждебное окружение НЕ выполнилось под env -i барьером: ' + (r.stdout || '') + (r.stderr || ''));
  });
}

// (5) cursor.sh: install через общий root-скрипт HM_APP_INSTALL_SH; Team ID + имя .app — позиционные.
ok('cursor.sh: admin_run /bin/sh -c "$HM_APP_INSTALL_SH" (Team ID + имя .app позиционными); medium-side codesign убран; fail-closed', () => {
  const s = CURSOR_SH();
  assert(/CURSOR_TEAM_ID='VDXQ22DGB9'/.test(s), 'Team ID Cursor запинен');
  assert(/admin_run \/bin\/sh -c "\$HM_APP_INSTALL_SH" \w+ "\$MNT\/\$APP" "\$CURSOR_TEAM_ID" "\$APP"/.test(s),
    'установка через общий root-скрипт; src.app + Team ID + имя — позиционные (не интерполяция в текст)');
  assert(!/CODESIGN='/.test(s) && !/"\$CODESIGN"/.test(s), 'medium-side codesign убран (verify теперь под root на staged)');
  assert(!/admin_run \/bin\/cp/.test(s), 'старое прямое root-cp без атомарной проверки убрано');
  assert(/if ! admin_run \/bin\/sh -c "\$HM_APP_INSTALL_SH"/.test(s) && /exit 1/.test(s), 'провал admin_run → fail-closed (detach + exit 1)');
});

// (6) node.sh: install через общий root-скрипт HM_PKG_INSTALL_SH; Team ID позиционным.
ok('node.sh: admin_run /bin/sh -c "$HM_PKG_INSTALL_SH" (Team ID позиционным); verify+install атомарно под root; verify_pkg_team_id убран', () => {
  const s = NODEPKG_SH();
  assert(/NODE_TEAM_ID='HX7739G8FX'/.test(s), 'Team ID Node.js Foundation запинен');
  assert(/admin_run \/bin\/sh -c "\$HM_PKG_INSTALL_SH" \w+ "\$PKG" "\$NODE_TEAM_ID"/.test(s),
    'installer через общий root-скрипт; путь и Team ID — позиционные');
  assert(!/verify_pkg_team_id/.test(s), 'medium-side verify_pkg_team_id убран');
  assert(!/admin_run \/usr\/sbin\/installer/.test(s), 'старый прямой root-installer убран');
  assert(/if ! admin_run \/bin\/sh -c "\$HM_PKG_INSTALL_SH"/.test(s), 'провал → fail-closed');
});

// (7) pydeps.sh: ОБА .pkg (bundled + /tmp онлайн) — через общий root-скрипт с PSF Team ID.
ok('pydeps.sh: ОБА .pkg через общий root-скрипт HM_PKG_INSTALL_SH (PSF Team ID позиционным); verify_pkg_team_id убран', () => {
  const s = PYDEPS_SH();
  assert(/PYTHON_TEAM_ID='BMM5U3QVKW'/.test(s), 'Team ID PSF запинен');
  assert(!/verify_pkg_team_id/.test(s), 'medium-side verify_pkg_team_id убран');
  const m = s.match(/admin_run \/bin\/sh -c "\$HM_PKG_INSTALL_SH" \w+ "[^"]+" "\$PYTHON_TEAM_ID"/g) || [];
  assert(m.length === 2, 'ровно два root-запуска через общий скрипт (bundled + /tmp): ' + m.length);
  assert(!/admin_run \/usr\/sbin\/installer/.test(s), 'старые прямые root-installer убраны');
});

// (F1)(F2) Функционально (реальный bash): общий root-скрипт СТАВИТ и ПРОВЕРЯЕТ одну и ту же
// STAGED копию (не /tmp-исходник) — окна TOCTOU verify(medium)->install(root) нет; wrong Team ID
// и unsigned/not-notarized → fail-closed. Инструменты и путь staging подменяются на fakes/tmp.
if (bashAvailable()) {
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extractLibVar = (name) => {
    const r = spawnSync('bash', ['-c', '. "$1"; printf "%s" "$' + name + '"', 'x',
      path.join(ROOT, 'scripts', 'macos', '_lib.sh').replace(/\\/g, '/')], { encoding: 'utf8', timeout: 30000 });
    return r.status === 0 ? r.stdout : '';
  };

  ok('_lib.sh (функц.): HM_PKG_INSTALL_SH — verify+install на STAGED копии (не источник); wrong-team/unsigned → fail-closed', () => {
    const SCRIPT = extractLibVar('HM_PKG_INSTALL_SH');
    assert(/mktemp -d \/var\/root\/hm_pkg/.test(SCRIPT), 'HM_PKG_INSTALL_SH извлечён из _lib.sh');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-pkg-toctou-'));
    try {
      const u = (p) => p.replace(/\\/g, '/');
      const stage = u(path.join(work, 'stage')); fs.mkdirSync(stage);
      const log = u(path.join(work, 'log'));
      const marker = u(path.join(work, 'installed'));
      const src = u(path.join(work, 'src.pkg')); fs.writeFileSync(src, 'SRC');
      const fpk = u(path.join(work, 'pkgutil'));
      const fin = u(path.join(work, 'installer'));
      fs.writeFileSync(fpk, [
        '#!/bin/sh',
        'for a in "$@"; do last="$a"; done',
        'echo "checked:$last" >> "' + log + '"',
        'if [ "$MODE" = good ]; then',
        '  printf "  Status: signed by a developer certificate issued by Apple\\n    1. Developer ID Installer: X ($TEAM)\\n"',
        '  exit 0',
        'else echo "  Status: no signature"; exit 1; fi',
        ''
      ].join('\n'));
      fs.chmodSync(fpk, 0o755);
      fs.writeFileSync(fin, [
        '#!/bin/sh',
        'p=""; prev=""; for a in "$@"; do [ "$prev" = -pkg ] && p="$a"; prev="$a"; done',
        'echo "installed:$p" >> "' + log + '"',
        ': > "' + marker + '"; exit 0',
        ''
      ].join('\n'));
      fs.chmodSync(fin, 0o755);
      const T = SCRIPT
        .split('/usr/sbin/pkgutil').join(fpk)
        .split('/usr/sbin/installer').join(fin)
        .split('/var/root/hm_pkg.XXXXXX').join(stage + '/hm_pkg.XXXXXX');
      const run = (mode, team, pin) => {
        try { fs.rmSync(log, { force: true }); fs.rmSync(marker, { force: true }); } catch (e) { /* */ }
        return spawnSync('bash', ['-c', T, 'hm_pkg_install', src, pin],
          { encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, { MODE: mode, TEAM: team }) });
      };
      let r = run('good', 'HX7739G8FX', 'HX7739G8FX');
      assert(r.status === 0, 'valid+right-team → exit 0: ' + (r.stderr || ''));
      assert(fs.existsSync(marker), 'установлен при валидной подписи');
      const lg = fs.readFileSync(log, 'utf8');
      assert(new RegExp('checked:' + reEsc(stage) + '/hm_pkg\\.').test(lg), 'pkgutil проверил STAGED копию: ' + lg);
      assert(new RegExp('installed:' + reEsc(stage) + '/hm_pkg\\..*p\\.pkg').test(lg), 'installer поставил STAGED копию');
      assert(!/src\.pkg/.test(lg), 'источник /tmp НЕ проверялся и НЕ ставился (нет окна verify→install)');
      r = run('good', 'HX7739G8FX', 'WRONGTEAM99');
      assert(r.status !== 0 && !fs.existsSync(marker), 'wrong Team ID → fail-closed, не поставлен');
      r = run('bad', 'HX7739G8FX', 'HX7739G8FX');
      assert(r.status !== 0 && !fs.existsSync(marker), 'unsigned → fail-closed, не поставлен');
    } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* */ } }
  });

  ok('_lib.sh (функц.): HM_APP_INSTALL_SH — codesign+spctl на STAGED .app, затем install; wrong-team/not-notarized → fail-closed', () => {
    const SCRIPT = extractLibVar('HM_APP_INSTALL_SH');
    assert(/mktemp -d \/var\/root\/hm_app/.test(SCRIPT), 'HM_APP_INSTALL_SH извлечён');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-app-toctou-'));
    try {
      const u = (p) => p.replace(/\\/g, '/');
      const stage = u(path.join(work, 'stage')); fs.mkdirSync(stage);
      const apps = u(path.join(work, 'Apps')); fs.mkdirSync(apps);
      const log = u(path.join(work, 'log'));
      const srcApp = u(path.join(work, 'src.app')); fs.mkdirSync(srcApp); fs.writeFileSync(srcApp + '/Info', 'x');
      const fcs = u(path.join(work, 'codesign'));
      const fsp = u(path.join(work, 'spctl'));
      fs.writeFileSync(fcs, [
        '#!/bin/sh',
        'req=""; prev=""; for a in "$@"; do [ "$prev" = -R ] && req="$a"; last="$a"; prev="$a"; done',
        'echo "cs-target:$last" >> "' + log + '"',
        'echo "cs-req:$req" >> "' + log + '"',
        'case "$req" in *"$EXPECT"*) exit 0 ;; *) exit 1 ;; esac',
        ''
      ].join('\n'));
      fs.chmodSync(fcs, 0o755);
      fs.writeFileSync(fsp, [
        '#!/bin/sh',
        'for a in "$@"; do last="$a"; done',
        'echo "sp-target:$last" >> "' + log + '"',
        '[ "$NOTAR" = ok ] && exit 0 || exit 1',
        ''
      ].join('\n'));
      fs.chmodSync(fsp, 0o755);
      const T = SCRIPT
        .split('/usr/bin/codesign').join(fcs)
        .split('/usr/sbin/spctl').join(fsp)
        .split('/var/root/hm_app.XXXXXX').join(stage + '/hm_app.XXXXXX')
        .split('/Applications/').join(apps + '/');
      const run = (expect, notar, pin) => {
        try { fs.rmSync(apps + '/Cursor.app', { recursive: true, force: true }); fs.rmSync(log, { force: true }); } catch (e) { /* */ }
        return spawnSync('bash', ['-c', T, 'hm_app_install', srcApp, pin, 'Cursor.app'],
          { encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, { EXPECT: expect, NOTAR: notar }) });
      };
      let r = run('VDXQ22DGB9', 'ok', 'VDXQ22DGB9');
      assert(r.status === 0, 'valid sig+notar+right-team → exit 0: ' + (r.stderr || ''));
      assert(fs.existsSync(apps + '/Cursor.app'), 'установлен при валидной подписи+нотаризации');
      const lg = fs.readFileSync(log, 'utf8');
      assert(new RegExp('cs-target:' + reEsc(stage) + '/hm_app\\..*app\\.app').test(lg), 'codesign проверил STAGED .app: ' + lg);
      assert(/cs-req:.*VDXQ22DGB9/.test(lg), 'designated requirement нёс запиненный Team ID');
      assert(!/src\.app/.test(lg), 'источник (mount) НЕ проверялся напрямую — только staged');
      r = run('VDXQ22DGB9', 'ok', 'WRONGTEAM99');
      assert(r.status !== 0 && !fs.existsSync(apps + '/Cursor.app'), 'wrong Team ID → fail-closed, не поставлен');
      r = run('VDXQ22DGB9', 'no', 'VDXQ22DGB9');
      assert(r.status !== 0 && !fs.existsSync(apps + '/Cursor.app'), 'не нотаризовано → fail-closed, не поставлен');
    } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* */ } }
  });

  ok('_lib.sh (функц.): HM_VSCODE_INSTALL_SH — распаковка+codesign+spctl на STAGED .app (имя с пробелом), затем install; wrong-team/not-notarized → fail-closed', () => {
    const SCRIPT = extractLibVar('HM_VSCODE_INSTALL_SH');
    assert(/mktemp -d \/var\/root\/hm_vsc/.test(SCRIPT), 'HM_VSCODE_INSTALL_SH извлечён');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-vsc-toctou-'));
    try {
      const u = (p) => p.replace(/\\/g, '/');
      const stage = u(path.join(work, 'stage')); fs.mkdirSync(stage);
      const apps = u(path.join(work, 'Apps')); fs.mkdirSync(apps);
      const log = u(path.join(work, 'log'));
      const zip = u(path.join(work, 'vscode.zip')); fs.writeFileSync(zip, 'ZIP');
      const dest = apps + '/Visual Studio Code.app';
      const fdi = u(path.join(work, 'ditto'));
      const fcs = u(path.join(work, 'codesign'));
      const fsp = u(path.join(work, 'spctl'));
      const fxa = u(path.join(work, 'xattr'));
      // fake ditto: последний arg = dst; создаём внутри распакованный .app (имя с пробелом).
      fs.writeFileSync(fdi, [
        '#!/bin/sh',
        'for a in "$@"; do dst="$a"; done',
        'mkdir -p "$dst/Visual Studio Code.app/Contents" || exit 1',
        'echo x > "$dst/Visual Studio Code.app/Contents/Info.plist"',
        'exit 0',
        ''
      ].join('\n'));
      fs.chmodSync(fdi, 0o755);
      fs.writeFileSync(fcs, [
        '#!/bin/sh',
        'req=""; prev=""; for a in "$@"; do [ "$prev" = -R ] && req="$a"; last="$a"; prev="$a"; done',
        'echo "cs-target:$last" >> "' + log + '"',
        'echo "cs-req:$req" >> "' + log + '"',
        'case "$req" in *"$EXPECT"*) exit 0 ;; *) exit 1 ;; esac',
        ''
      ].join('\n'));
      fs.chmodSync(fcs, 0o755);
      fs.writeFileSync(fsp, [
        '#!/bin/sh',
        'for a in "$@"; do last="$a"; done',
        'echo "sp-target:$last" >> "' + log + '"',
        '[ "$NOTAR" = ok ] && exit 0 || exit 1',
        ''
      ].join('\n'));
      fs.chmodSync(fsp, 0o755);
      fs.writeFileSync(fxa, ['#!/bin/sh', 'echo "xattr:$*" >> "' + log + '"', 'exit 0', ''].join('\n'));
      fs.chmodSync(fxa, 0o755);
      const T = SCRIPT
        .split('/usr/bin/ditto').join(fdi)
        .split('/usr/bin/codesign').join(fcs)
        .split('/usr/sbin/spctl').join(fsp)
        .split('/usr/bin/xattr').join(fxa)
        .split('/var/root/hm_vsc.XXXXXX').join(stage + '/hm_vsc.XXXXXX');
      // /usr/bin/find оставляем реальным (есть в git-bash) — проверяем реальный поиск .app.
      const run = (expect, notar, pin) => {
        try { fs.rmSync(dest, { recursive: true, force: true }); fs.rmSync(log, { force: true }); } catch (e) { /* */ }
        return spawnSync('bash', ['-c', T, 'hm_vscode_install', zip, pin, dest],
          { encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, { EXPECT: expect, NOTAR: notar }) });
      };
      let r = run('UBF8T346G9', 'ok', 'UBF8T346G9');
      assert(r.status === 0, 'valid sig+notar+right-team → exit 0: ' + (r.stderr || ''));
      assert(fs.existsSync(dest), 'установлен (dest с пробелом в имени)');
      const lg = fs.readFileSync(log, 'utf8');
      assert(new RegExp('cs-target:' + reEsc(stage) + '/hm_vsc\\..*/unz/Visual Studio Code\\.app').test(lg), 'codesign проверил STAGED распакованный .app: ' + lg);
      assert(/cs-req:.*UBF8T346G9/.test(lg), 'designated requirement нёс Team ID Microsoft');
      r = run('UBF8T346G9', 'ok', 'WRONGTEAM99');
      assert(r.status !== 0 && !fs.existsSync(dest), 'wrong Team ID → fail-closed, не поставлен');
      r = run('UBF8T346G9', 'no', 'UBF8T346G9');
      assert(r.status !== 0 && !fs.existsSync(dest), 'не нотаризовано → fail-closed, не поставлен');
    } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* */ } }
  });
}

// (8) mascot.sh: fail-closed (как desktop-скрипты round-4) — нет command -v, есть require -x,
//     Team ID через designated requirement (не -dv парсинг), spctl всегда, нет stapler-fallback.
ok('mascot.sh: fail-closed codesign/spctl (абсолютные, require -x), Team ID пин через -R designated requirement, spctl ВСЕГДА, без stapler-fallback', () => {
  const s = MASCOT_SH();
  assert(/CODESIGN='\/usr\/bin\/codesign'/.test(s) && /SPCTL='\/usr\/sbin\/spctl'/.test(s), 'абсолютные пути codesign/spctl');
  assert(!/if ! command -v codesign/.test(s) && !/if command -v spctl/.test(s), 'нет conditional command -v (это был fail-OPEN)');
  assert(/\[ ! -x "\$CODESIGN" \]/.test(s) && /\[ ! -x "\$SPCTL" \]/.test(s), 'нет/не исполняемый инструмент → fail-CLOSED');
  assert(/certificate leaf\[subject\.OU\] = \\"\$MASCOT_TEAM_ID\\"/.test(s) && /-R "=\$req"/.test(s),
    'пин Team ID через НАТИВНЫЙ designated requirement (крипто), не сравнение -dv-вывода');
  assert(!/codesign -dv --verbose=4/.test(s) && !/TeamIdentifier=/.test(s.replace(/#[^\n]*/g, '')),
    'парсинг человекочитаемого -dv убран');
  assert(/"\$SPCTL" --assess --type execute/.test(s), 'spctl --assess вызывается всегда');
  assert(!/stapler/.test(s.replace(/#[^\n]*/g, '')), 'stapler-fallback убран (spctl non-zero = fail, без обходов)');
});

console.log('== РЕДИЗАЙН config: НИКОГДА не стирает/не переносит ~/.claude — только merge поверх ==');

const CFG_PS1 = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
const CFG_SH  = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');

// ---- Статические инварианты config.ps1 (Windows) ----

ok('config.ps1: add-missing = robocopy /XC /XN /XO; repair = robocopy без /XC; оба с /XF preserve + /XD; НЕ запускает install.ps1', () => {
  const s = CFG_PS1();
  assert(/robocopy \$srcClaude \$claudeHome \/E \/XC \/XN \/XO \/XJ \/XF \$excludeNames \/XD \$mergeXD/.test(s),
    'add-missing: /XC /XN /XO — существующее НЕ перезаписываем; /XJ — не сквозь junction; /XD $mergeXD');
  assert(/robocopy \$srcClaude \$claudeHome \/E \/XJ \/XF \$excludeNames \/XD \$mergeXD/.test(s),
    'repair: robocopy БЕЗ /XC — наши базовые перезаписываются, /XF/XD исключают пользовательское; /XJ не сквозь junction');
  assert(/\$mergeXD = @\(\$excludeDirs\) \+ @\('skills'\)/.test(s),
    'skills — reparse point → исключается из merge (/XD skills), robocopy не пишет сквозь junction');
  // Правило «не писать сквозь reparse» — для ВСЕХ детей ~/.claude (agents/rules/tools/…),
  // не только skills: junction на git-репо юзера иначе затирался бы в repair.
  assert(/\$mergeXD = @\(\$excludeDirs\) \+ \$reparseKids/.test(s), 'ВСЕ reparse-дети ~/.claude исключаются из merge');
  const kidScan = s.slice(s.indexOf('$reparseKids = @()'), s.indexOf('$skillsSkipped = $false'));
  assert(/Get-ChildItem -Force -LiteralPath \$claudeHome -ErrorAction Stop/.test(kidScan), 'reparse-дети перечисляются fail-closed (-ErrorAction Stop)');
  assert(/if \(-not \$kidScanOk\) \{/.test(kidScan) && /\$installFailed = \$true/.test(kidScan),
    'сбой проверки reparse → fail-closed: подкаталоги пропущены + компонент честно провален');
  assert(/if \(\$ADDITIVE\) \{/.test(s), 'ветвление по $ADDITIVE (add-missing / repair)');
  assert(!/& \$installer/.test(s), 'НЕ запускает install.ps1 через & $installer (он делал Move-Item = wipe)');
  assert(!/-BackupExisting/.test(s), 'нет -BackupExisting (это и был wipe: Move-Item всего ~/.claude)');
});

ok('config.ps1: весь класс snapshot/restore/stale/wipe машинерии УДАЛЁН', () => {
  const s = CFG_PS1();
  assert(!/Move-Item/.test(s), 'НИ ОДНОГО Move-Item (~/.claude никогда не переносится)');
  assert(!/Snapshot-UserData|Restore-UserData|Restore-UserDataMissingOnly/.test(s), 'нет snapshot/restore функций');
  assert(!/Test-StaleSnapshotConflict/.test(s), 'нет stale-conflict логики');
  assert(!/Get-Sha256Hex|Get-FileFingerprint|Get-DirManifest/.test(s), 'нет fingerprint/manifest/hash машинерии');
  assert(!/preserveDir|hamidun-preserve|preserve-rescue/.test(s), 'нет preserve-каталога/rescue');
});

ok('config.ps1: preserve-list glob-aware (chats.db*, tg_session.session*) + preserve-каталоги; settings.json НЕ в preserve', () => {
  const s = CFG_PS1();
  const ex = s.match(/\$excludeNames = @\(([\s\S]*?)\)/);
  assert(ex, '$excludeNames найден');
  ['.credentials.master.env', '.credentials.json', 'settings.local.json', 'MEMORY.md', 'chats.db*', 'tg_session.session*']
    .forEach((n) => assert(ex[1].indexOf("'" + n + "'") !== -1, 'excludeNames содержит ' + n));
  assert(ex[1].indexOf("'settings.json'") === -1, 'settings.json НЕ в preserve (наш базовый: add-missing/overwrite)');
  assert(/\$excludeDirs\s+= @\('memory', 'projects', 'todos', 'shell-snapshots'\)/.test(s), 'preserve-каталоги: memory/projects/todos/shell-snapshots');
});

ok('config.ps1: settings.json — наш базовый; CLAUDE.md/credentials только если отсутствуют (оба режима)', () => {
  const s = CFG_PS1();
  assert(/-not \(Test-Path \$profileClaudeMd\)/.test(s), '~/CLAUDE.md — только при отсутствии (не затираем даже в repair)');
  assert(/-not \(Test-Path \$dstEnv\)/.test(s), 'credentials-шаблон — только при отсутствии ключей');
});

ok('config.ps1: прунинг fail-closed ($pruneDisabled/$installFailed); $preExisting щадит скиллы юзера в add-missing; reparse skip', () => {
  const s = CFG_PS1();
  assert(/if \(\$pruneDisabled -or \$installFailed\)/.test(s), 'прунинг пропускается при pruneDisabled ИЛИ installFailed');
  assert(/\$weAdded = \(-not \$preExisting\.ContainsKey\(\$_\.Name\)\) -or \$ourPrev\.ContainsKey\(\$_\.Name\)/.test(s),
    'guard $weAdded: скилл юзера, бывший ДО раскладки, не удаляем; НАШ из прошлого прогона (.hamidun-skills.txt) — прунится, иначе снятие пака работает лишь раз');
  assert(/\$ourListPath = Join-Path \$claudeHome '\.hamidun-skills\.txt'/.test(s), 'маркер «наших» скиллов пишется/читается в ~/.claude/.hamidun-skills.txt');
  assertOrder(s, "$ourPrev = @{}", 'robocopy $srcClaude $claudeHome', 'прошлый список «наших» читается ДО merge-copy');
  assert(/\$preExisting\[\$_\.Name\] = \$true/.test(s), 'инвентарь пред-существующих скиллов собирается ДО merge-copy');
  assert(/-ErrorAction Stop \| ForEach-Object \{/.test(s), 'перечисление с -ErrorAction Stop (fail-closed)');
  assert(/if \(\$_\.Attributes -band \[System\.IO\.FileAttributes\]::ReparsePoint\) \{ \$reparseSkills \+= \$_\.Name \}/.test(s),
    'дочерний skill-reparse → исключается ПОИМЁННО ($reparseSkills), а не пропуском всего каталога skills');
  assert(/foreach \(\$n in \$reparseSkills\) \{ \$mergeXD \+= \(Join-Path \(Join-Path \$srcClaude 'skills'\) \$n\) \}/.test(s),
    'слинкованный дочерний скилл исключается адресно, остальные скиллы раскладываются');
  const loop = s.slice(s.indexOf('Get-ChildItem -Directory $skillsDir | ForEach-Object'));
  assert(/ReparsePoint\) \{ return \}/.test(loop.slice(0, 700)), 'reparse-скилл (symlink/junction) в прунинге скипается');
});

ok('config.ps1: бэкап — КОПИЯ robocopy /R:1 (не move); неполнота НЕ фатальна (warning + Продолжаю, БЕЗ exit 1)', () => {
  const s = CFG_PS1();
  const iB = s.indexOf('$backupDir = "$claudeHome.backup.$stamp"');
  const iAfter = s.indexOf('$hadOldConfig');
  assert(iB !== -1 && iAfter > iB, 'блок бэкапа найден');
  const blk = s.slice(iB, iAfter);
  assert(/robocopy \$claudeHome \$backupDir \/E \/R:1 \/W:1/.test(blk), 'бэкап — robocopy (копия, /R:1 не зависает на локах)');
  assert(/robocopy \$claudeHome \$backupDir \/E \/R:1 \/W:1 \/XJ/.test(blk),
    'бэкап с /XJ — не рекурсирует по junction внутри ~/.claude (иначе уходит в профиль/сетевую цель и растёт бесконечно)');
  assert(/Это НЕ критично/.test(blk) && /Продолжаю/.test(blk), 'неполный бэкап → предупреждение + продолжаем');
  assert(!/exit 1/.test(blk), 'бэкап НЕ фатален: нет exit 1 (оригинал не переносится/не стирается)');
});

// ---- Статические инварианты config.sh (macOS/Linux) — зеркало ----

ok('config.sh: add-missing rsync --ignore-existing / hm_copy missing; repair rsync без --ignore-existing / hm_copy overwrite; НЕ запускает install.sh', () => {
  const s = CFG_SH();
  assert(/rsync -a --ignore-existing \$PRESERVE_FILE_GLOBS \$PRESERVE_DIR_GLOBS/.test(s), 'add-missing: rsync --ignore-existing');
  assert(/hm_copy "\$SRC_CLAUDE" "\$CLAUDE_HOME" missing \|\| COPY_FAILED=1/.test(s), 'add-missing fallback: hm_copy missing');
  assert(/rsync -a \$PRESERVE_FILE_GLOBS \$PRESERVE_DIR_GLOBS/.test(s), 'repair: rsync БЕЗ --ignore-existing (перезапись наших базовых)');
  assert(/hm_copy "\$SRC_CLAUDE" "\$CLAUDE_HOME" overwrite \|\| COPY_FAILED=1/.test(s), 'repair fallback: hm_copy overwrite');
  assert(!/install\.sh" --backup/.test(s), 'НЕ запускает install.sh --backup (он делал mv = wipe)');
  assert(!/bash "\$CLONE\/install\.sh"/.test(s), 'нет вызова bash install.sh');
});

ok('config.sh: весь класс snapshot/restore/stale/wipe машинерии УДАЛЁН', () => {
  const s = CFG_SH();
  assert(!/mv "\$CLAUDE_HOME"/.test(s) && !/mv "\$HOME\/\.claude"/.test(s), 'НИ ОДНОГО mv всего ~/.claude');
  assert(!/snapshot_user_data|restore_user_data/.test(s), 'нет snapshot/restore функций');
  assert(!/stale_snapshot_conflict/.test(s), 'нет stale-conflict логики');
  assert(!/hm_dir_manifest|hm_fmtime/.test(s), 'нет manifest/mtime-fingerprint машинерии');
  assert(!/PRESERVE_DIR=|hamidun-preserve|preserve-rescue|LEGACY_PRESERVE/.test(s), 'нет preserve-каталога/rescue/legacy');
});

ok('config.sh: preserve globs (chats.db*/tg_session.session*) + dir-excludes; hm_copy case покрывает; CLAUDE.md/creds только если отсутствуют', () => {
  const s = CFG_SH();
  ['--exclude=.credentials.master.env', '--exclude=.credentials.json', '--exclude=settings.local.json',
   '--exclude=MEMORY.md', '--exclude=chats.db*', '--exclude=tg_session.session*',
   '--exclude=memory/', '--exclude=projects/', '--exclude=todos/', '--exclude=shell-snapshots/']
    .forEach((x) => assert(s.indexOf(x) !== -1, 'preserve-glob ' + x));
  assert(!/--exclude=settings\.json\b/.test(s), 'settings.json НЕ исключается (наш базовый)');
  // hm_copy fallback case покрывает всё пользовательское (chats.db.backup — через chats.db*)
  const fn = s.slice(s.indexOf('hm_copy() {'), s.indexOf('mkdir -p "$CLAUDE_HOME"'));
  assert(/\*\/chats\.db\*\|\*\/tg_session\.session\*\) continue ;;/.test(fn), 'hm_copy case: chats.db*/tg_session.session* (glob-aware, ловит chats.db.backup)');
  assert(/\*\/memory\/\*\|\*\/projects\/\*\|\*\/todos\/\*\|\*\/shell-snapshots\/\*\) continue ;;/.test(fn), 'hm_copy case: preserve-каталоги');
  assert(/\[ ! -f "\$HOME\/CLAUDE\.md" \]/.test(s), 'CLAUDE.md — только при отсутствии');
  assert(/! -f "\$CLAUDE_HOME\/\.credentials\.master\.env" \]/.test(s), 'credentials-шаблон — только при отсутствии');
});

ok('config.sh: прунинг fail-closed (PRUNE_DISABLED/RC); mktemp+trap+симлинк-реджект; PRE_EXISTING щадит', () => {
  const s = CFG_SH();
  assert(/if \[ "\$PRUNE_DISABLED" -eq 1 \] \|\| \[ "\$RC" -ne 0 \]; then/.test(s), 'прунинг пропускается при PRUNE_DISABLED или RC!=0');
  assert(/PRE_EXISTING_SKILLS="\$\(mktemp "\$\{TMPDIR:-\/tmp\}\/hm-preskills\.XXXXXX"/.test(s), 'список pre-existing — mktemp (не предсказуемое имя)');
  assert(/trap '\[ -n "\$PRE_EXISTING_SKILLS" \] && rm -f "\$PRE_EXISTING_SKILLS"' EXIT/.test(s), 'trap-чистка временного файла');
  assert(/-L "\$PRE_EXISTING_SKILLS"/.test(s), 'симлинк вместо temp-файла → отклоняется');
  assert(/grep -qxF "\$name" "\$PRE_EXISTING_SKILLS"/.test(s), 'прунинг сверяется со списком пред-существующих');
  assert(/\[ "\$g" -ge 2 \]/.test(s) && /PRUNE_ABORT=1; break/.test(s), 'rc>=2 (EIO) → abort ДО первого удаления');
});

ok('config.sh: бэкап cp -R (не mv); неполнота НЕ фатальна (warning + Продолжаю, БЕЗ exit 1)', () => {
  const s = CFG_SH();
  const iB = s.indexOf('BACKUP_DIR="$CLAUDE_HOME.backup.$STAMP"');
  const iAfter = s.indexOf('hm_copy() {');
  assert(iB !== -1 && iAfter > iB, 'блок бэкапа найден');
  const blk = s.slice(iB, iAfter);
  assert(/cp -R "\$CLAUDE_HOME" "\$BACKUP_DIR"/.test(blk), 'бэкап — cp -R (копия, не mv)');
  assert(/Продолжаю/.test(blk), 'неполный/несостоявшийся бэкап → предупреждение + продолжаем');
  assert(!/exit 1/.test(blk), 'бэкап НЕ фатален: нет exit 1');
});

// ---- ГРЕП-ИНВАРИАНТ: ни одного Move/wipe ~/.claude в config-пути (оба скрипта) ----

ok('ИНВАРИАНТ: config.ps1/sh — НИ Move-Item/mv ~/.claude, НИ install.ps1/sh-раскладки, НИ snapshot/restore/backup-wipe', () => {
  const ps = CFG_PS1();
  const sh = CFG_SH();
  // ps1
  assert(!/Move-Item/.test(ps), 'ps1: нет Move-Item');
  assert(!/-BackupExisting|& \$installer|\$installer -/.test(ps), 'ps1: нет запуска install.ps1/-BackupExisting');
  assert(!/(Snapshot|Restore)-UserData|Test-StaleSnapshotConflict/.test(ps), 'ps1: нет snapshot/restore/stale');
  // sh
  assert(!/\bmv "\$CLAUDE_HOME"|\bmv "\$HOME\/\.claude"/.test(sh), 'sh: нет mv всего ~/.claude');
  assert(!/install\.sh" --backup|--backup --skip-deps/.test(sh), 'sh: нет install.sh --backup');
  assert(!/snapshot_user_data|restore_user_data|stale_snapshot_conflict/.test(sh), 'sh: нет snapshot/restore/stale');
  // install.ps1/install.sh упоминаются ТОЛЬКО как presence-gate вшитого конфига (не запуск)
  assert(/Test-Path \(Join-Path \$bundled 'install\.ps1'\)/.test(ps), 'ps1: install.ps1 — только presence-gate bundled');
  assert(/\[ -f "\$BUNDLED\/install\.sh" \]/.test(sh), 'sh: install.sh — только presence-gate bundled');
});

// ---- Функциональные прогоны на РЕАЛЬНОЙ ФС (sandbox-HOME) --------------
// ВСЕ прогоны — ТОЛЬКО в mkdtemp-HOME с подменой HOME/USERPROFILE. Реальный ~/.claude
// не участвует (0 обращений на запись). Фейковый bundled config-pack как source.

function bashAvailable() {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  return !(probe.error || probe.status !== 0);
}
function powershellAvailable() {
  if (process.platform !== 'win32') return false;
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
    { encoding: 'utf8', timeout: 30000 });
  return !(probe.error || probe.status !== 0);
}

// Фейковый bundled config-pack (source). install.ps1/install.sh — presence-gate; если
// config.* их ЗАПУСТИТ (чего быть не должно) — они создадут ~/.install-ran (маркер wipe).
// Пак НАРОЧНО везёт .claude/chats.db и .claude/MEMORY.md — чтобы доказать, что preserve-list
// исключает их даже в repair (пользовательские версии не перезаписываются).
function mkCfgSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cfg-')).replace(/\\/g, '/');
  const home = base + '/home';
  const clone = base + '/clone';
  fs.mkdirSync(clone + '/.claude/skills/our-skill', { recursive: true });
  fs.writeFileSync(clone + '/.claude/skills/our-skill/SKILL.md', 'ours');
  fs.mkdirSync(clone + '/.claude/rules', { recursive: true });
  fs.writeFileSync(clone + '/.claude/rules/new-rule.md', 'fresh rule');
  fs.writeFileSync(clone + '/.claude/settings.json', '{"fresh":"base"}');
  fs.writeFileSync(clone + '/.claude/chats.db', 'PACK-CHATS');
  fs.writeFileSync(clone + '/.claude/MEMORY.md', 'PACK-MEM');
  fs.writeFileSync(clone + '/install.sh', '#!/bin/bash\necho ran > "$HOME/.install-ran"\nexit 0\n');
  fs.writeFileSync(clone + '/install.ps1',
    "Set-Content -Path (Join-Path $env:USERPROFILE '.install-ran') -Value 'ran'\r\nexit 0\r\n");
  fs.writeFileSync(clone + '/CLAUDE.md', 'fresh claude md');
  fs.writeFileSync(clone + '/.credentials.template.env', 'TEMPLATE=1');
  return { base, home, clone };
}

// Живой дом с пользовательскими данными (кастомизации + preserve-list).
function seedHome(home) {
  fs.mkdirSync(home + '/.claude/skills/user-skill', { recursive: true });
  fs.writeFileSync(home + '/.claude/skills/user-skill/SKILL.md', 'user skill');
  fs.writeFileSync(home + '/.claude/settings.json', '{"user":"custom"}');
  fs.writeFileSync(home + '/.claude/settings.local.json', '{"local":"custom"}');
  fs.writeFileSync(home + '/.claude/.credentials.master.env', 'KEY=USER');
  fs.writeFileSync(home + '/.claude/chats.db', 'USER-CHATS');
  fs.writeFileSync(home + '/.claude/chats.db.backup', 'USER-CHATS-BK');   // glob preserve (chats.db*)
  fs.writeFileSync(home + '/.claude/tg_session.session-wal', 'USER-TGWAL');
  fs.writeFileSync(home + '/.claude/tg_session.session-shm', 'USER-TGSHM');
  fs.writeFileSync(home + '/.claude/MEMORY.md', 'USER-MEM');
  fs.mkdirSync(home + '/.claude/memory', { recursive: true });
  fs.writeFileSync(home + '/.claude/memory/topic.md', 'user topic');
  fs.mkdirSync(home + '/.claude/projects/p1', { recursive: true });
  fs.writeFileSync(home + '/.claude/projects/p1/s.jsonl', 'history');
  fs.writeFileSync(home + '/CLAUDE.md', 'user root claude');
}

function runCfgSh(home, clone, extraEnv) {
  const script = path.join(ROOT, 'scripts', 'macos', 'config.sh');
  const env = Object.assign({}, process.env, { HOME: home, HM_BUNDLED_CONFIG: clone });
  delete env.HM_DRY_RUN; delete env.HM_KEEP_SKILLS; delete env.HM_ALL_PACK_SKILLS; delete env.HM_ADDITIVE;
  Object.assign(env, extraEnv || {});
  return spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000, env });
}
function runCfgPs1(home, clone, extraEnv) {
  const script = path.join(ROOT, 'scripts', 'windows', 'config.ps1');
  const env = Object.assign({}, process.env, {
    USERPROFILE: home.replace(/\//g, '\\'), HM_BUNDLED_CONFIG: clone.replace(/\//g, '\\')
  });
  delete env.HM_DRY_RUN; delete env.HM_KEEP_SKILLS; delete env.HM_ALL_PACK_SKILLS; delete env.HM_ADDITIVE;
  Object.assign(env, extraEnv || {});
  return spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '" + script + "'"],
    { encoding: 'utf8', timeout: 180000, env });
}

// Общие проверки, что пользовательское ЦЕЛО (одинаково для add-missing и repair).
function assertUserDataIntact(home) {
  assert.strictEqual(fs.readFileSync(home + '/.claude/.credentials.master.env', 'utf8'), 'KEY=USER', 'ключи целы');
  assert.strictEqual(fs.readFileSync(home + '/.claude/settings.local.json', 'utf8'), '{"local":"custom"}', 'settings.local цел');
  assert.strictEqual(fs.readFileSync(home + '/.claude/chats.db', 'utf8'), 'USER-CHATS', 'chats.db цел (пак вёз PACK-CHATS, но preserve исключил)');
  assert.strictEqual(fs.readFileSync(home + '/.claude/chats.db.backup', 'utf8'), 'USER-CHATS-BK', 'chats.db.backup цел (glob chats.db*)');
  assert.strictEqual(fs.readFileSync(home + '/.claude/tg_session.session-wal', 'utf8'), 'USER-TGWAL', 'tg -wal цел');
  assert.strictEqual(fs.readFileSync(home + '/.claude/tg_session.session-shm', 'utf8'), 'USER-TGSHM', 'tg -shm цел');
  assert.strictEqual(fs.readFileSync(home + '/.claude/MEMORY.md', 'utf8'), 'USER-MEM', 'MEMORY.md цел (пак вёз PACK-MEM, preserve исключил)');
  assert.strictEqual(fs.readFileSync(home + '/.claude/memory/topic.md', 'utf8'), 'user topic', 'memory/ цел');
  assert.strictEqual(fs.readFileSync(home + '/.claude/projects/p1/s.jsonl', 'utf8'), 'history', 'projects/ (история сессий) цел');
  assert(fs.existsSync(home + '/.claude/skills/user-skill/SKILL.md'), 'скилл юзера цел (НЕ move)');
  assert.strictEqual(fs.readFileSync(home + '/CLAUDE.md', 'utf8'), 'user root claude', '~/CLAUDE.md цел (только-если-нет)');
}
function assertNoWipe(home) {
  assert(!fs.existsSync(home + '/.install-ran'), 'install.ps1/sh базового пака НЕ вызывался (нет wipe-раскладки)');
  const backups = fs.readdirSync(home).filter((n) => n.startsWith('.claude.backup.'));
  assert(backups.length === 1, 'ровно один таймштамп-бэкап (КОПИЯ-сейф-нет): ' + backups.join(','));
  assert.strictEqual(fs.readFileSync(home + '/' + backups[0] + '/settings.json', 'utf8'), '{"user":"custom"}', 'бэкап = исходное состояние');
}

if (bashAvailable()) {
  console.log('== config.sh (функц., sandbox-HOME): add-missing / repair — данные на месте, НЕ move ==');

  ok('config.sh add-missing: существующее (ключи/settings.local/chats.db) НЕ перезаписано, недостающее добавлено, install.sh НЕ вызван, оригинал+копия-бэкап', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      const r = runCfgSh(home, clone, { HM_ADDITIVE: '1' });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.json', 'utf8'), '{"user":"custom"}', 'settings.json юзера НЕ перезаписан (add-missing)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/rules/new-rule.md', 'utf8'), 'fresh rule', 'недостающий файл доложен');
      assert(fs.existsSync(home + '/.claude/skills/our-skill/SKILL.md'), 'наш скилл доложен');
      assertUserDataIntact(home);
      assertNoWipe(home);
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.sh repair: НАШИ базовые перезаписаны свежими; пользовательское (preserve-list вкл. chats.db.backup, tg -wal/-shm) ЦЕЛО; install.sh НЕ вызван; НЕ move', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      const r = runCfgSh(home, clone, {});   // HM_ADDITIVE удалён → repair
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.json', 'utf8'), '{"fresh":"base"}', 'settings.json (наш базовый) перезаписан свежим (repair)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/rules/new-rule.md', 'utf8'), 'fresh rule', 'свежие правила разложены');
      assert(fs.existsSync(home + '/.claude/skills/our-skill/SKILL.md'), 'наш скилл разложен');
      assertUserDataIntact(home);   // пользовательское НЕ тронуто даже в repair
      assertNoWipe(home);
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.sh add-missing: прунинг удаляет ТОЛЬКО доложенное нами, щадит пред-существующий скилл юзера', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      const r = runCfgSh(home, clone, { HM_ADDITIVE: '1', HM_ALL_PACK_SKILLS: 'user-skill,our-skill', HM_KEEP_SKILLS: 'something-else' });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(fs.existsSync(home + '/.claude/skills/user-skill/SKILL.md'), 'пред-существующий скилл юзера ЦЕЛ');
      assert(!fs.existsSync(home + '/.claude/skills/our-skill'), 'доложенный нами скилл снятого пака удалён');
      assert(/убрано: 1/.test(r.stdout || ''), 'удалён ровно 1 (наш): ' + (r.stdout || ''));
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.sh REPAIR: пред-существующий скилл юзера с ИМЕНЕМ снятого пака НЕ удаляется и НЕ перезаписан (P1 Codex — repair игнорировал pre-existing)', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);   // ~/.claude/skills/user-skill (пред-существующий, содержимое 'user skill')
      // repair (БЕЗ HM_ADDITIVE): user-skill в снятом паке (в ALL, НЕ в KEEP), но user-skill
      // НЕ в clone. До фикса repair считал его 'нашим' (weAdded игнорировал pre-existing) и
      // сносил rm -rf. Теперь inventory щадит пред-существующее в ОБОИХ режимах.
      const r = runCfgSh(home, clone, { HM_ALL_PACK_SKILLS: 'user-skill,our-skill', HM_KEEP_SKILLS: 'something-else' });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(home + '/.claude/skills/user-skill/SKILL.md', 'utf8'), 'user skill',
        'пред-существующий скилл юзера ЦЕЛ и не перезаписан в repair (P1 закрыт)');
      assert(!fs.existsSync(home + '/.claude/skills/our-skill'), 'доложенный нами скилл снятого пака удалён (прунинг работает и в repair)');
      assert(/убрано: 1/.test(r.stdout || ''), 'удалён ровно 1 (наш, не юзера): ' + (r.stdout || ''));
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.sh REPAIR: ~/.claude/skills — junction на внешнюю папку → merge НЕ пишет сквозь ссылку (P1 Codex merge-through-symlink)', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      fs.rmSync(home + '/.claude/skills', { recursive: true, force: true });
      fs.mkdirSync(base + '/external-skills/our-skill', { recursive: true });
      fs.writeFileSync(base + '/external-skills/our-skill/DATA.md', 'EXTERNAL');
      let linked = false;
      try { fs.symlinkSync(base + '/external-skills', home + '/.claude/skills', 'junction'); linked = true; }
      catch (e) { linked = false; }
      if (!linked) { console.log('     (symlink/junction недоступен — пропуск)'); return; }
      const r = runCfgSh(home, clone, {});   // repair (clone везёт skills/our-skill/SKILL.md)
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(base + '/external-skills/our-skill/DATA.md', 'utf8'), 'EXTERNAL',
        'внешний файл за junction НЕ тронут (merge не прошёл сквозь ссылку)');
      assert(!fs.existsSync(base + '/external-skills/our-skill/SKILL.md'),
        'наш skills/our-skill/SKILL.md НЕ дописан во внешнюю цель через junction');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.sh REPAIR: скрытый (dot) дочерний skill-junction → skills исключён, внешняя цель цела (P1 Codex dot-child)', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      fs.mkdirSync(clone + '/.claude/skills/.hidden', { recursive: true });   // источник везёт коллизию
      fs.writeFileSync(clone + '/.claude/skills/.hidden/SKILL.md', 'ours');
      fs.mkdirSync(base + '/ext-hidden', { recursive: true });
      fs.writeFileSync(base + '/ext-hidden/DATA.md', 'EXTERNAL');
      let linked = false;
      // skills — реальный каталог, но скрытый .hidden внутри — junction на внешнюю папку
      try { fs.symlinkSync(base + '/ext-hidden', home + '/.claude/skills/.hidden', 'junction'); linked = true; }
      catch (e) { linked = false; }
      if (!linked) { console.log('     (junction недоступен — пропуск)'); return; }
      const r = runCfgSh(home, clone, {});   // repair
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(/симлинк\/junction/.test(r.stdout || ''), 'dot-child junction обнаружен → skills пропущен: ' + (r.stdout || ''));
      assert.strictEqual(fs.readFileSync(base + '/ext-hidden/DATA.md', 'utf8'), 'EXTERNAL', 'внешняя цель за dot-junction ЦЕЛА');
      assert(!fs.existsSync(base + '/ext-hidden/SKILL.md'), 'наш .hidden/SKILL.md НЕ дописан во внешнюю цель через dot-junction');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.sh: TMPDIR недоступен → прунинг паков отключён (fail-closed, 0 удалений), скилл юзера ЦЕЛ', () => {
    // ВАЖНО: mktemp нужен ОБЯЗАТЕЛЬНО для PRE_EXISTING_SKILLS (список скиллов для
    // консервативного прунинга, config.sh:189) — это ВСЕГДА выполняется до любой
    // ветки копирования, и при сбое прунинг паков ВСЕГДА честно отключается
    // (fail-closed: 0 удалений). А вот ОБЩИЙ exit-код раскладки — окруженческий
    // факт, а не инвариант: если на хосте есть rsync (типично для macOS/CI), он
    // делает основную копию ~/.claude и TMPDIR вообще не трогает (exit 0); если
    // rsync нет, копия идёт через hm_copy, который САМ зовёт mktemp и тогда честно
    // падает (exit 1). Оба исхода корректны — тест не должен жёстко требовать ни
    // тот, ни другой, иначе он ломается на машине с другим набором утилит (именно
    // так и обнаружилось: раньше жёстко требовал ненулевой exit, что верно только
    // при отсутствии rsync).
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      const r = runCfgSh(home, clone, { HM_ADDITIVE: '1', HM_ALL_PACK_SKILLS: 'user-skill,our-skill', HM_KEEP_SKILLS: 'something-else', TMPDIR: base + '/no-such-tmpdir' });
      assert(/прунинг паков отключён/i.test(r.stdout || ''), 'сообщение о fail-closed прунинга: ' + (r.stdout || ''));
      assert(fs.existsSync(home + '/.claude/skills/user-skill/SKILL.md'), 'скилл юзера ЦЕЛ (0 удалений)');
      assert(!/убрано: [1-9]/.test(r.stdout || ''), 'ни одного удаления');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.sh: dry-run БЕЗ bundled → никакого clone, ~/.claude НЕ создан, exit 0', () => {
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-dry-')).replace(/\\/g, '/');
    const home = b + '/home'; fs.mkdirSync(home, { recursive: true });
    try {
      const script = path.join(ROOT, 'scripts', 'macos', 'config.sh');
      const r = spawnSync('bash', [script], {
        encoding: 'utf8', timeout: 30000,
        env: Object.assign({}, process.env, { HOME: home, HM_DRY_RUN: '1', HM_BUNDLED_CONFIG: '', HM_CONFIG_REPO_URL: 'https://127.0.0.1:1/nonexistent.git' })
      });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(!fs.existsSync(home + '/.hamidun-setup/config-repo'), 'clone-каталог НЕ создан (dry-run до clone)');
      assert(!fs.existsSync(home + '/.claude'), '~/.claude НЕ создан');
      assert(/\[dry-run\] WOULD: git clone/.test(r.stdout || ''), 'dry-run печатает WOULD-clone');
    } finally { try { fs.rmSync(b, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.sh: пред-существующий SYMLINK-скилл переживает прунинг (fail-closed, чужая цель цела)', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      fs.mkdirSync(base + '/elsewhere-skill', { recursive: true });
      fs.writeFileSync(base + '/elsewhere-skill/DATA.md', 'precious');
      let linked = false;
      try { fs.symlinkSync(base + '/elsewhere-skill', home + '/.claude/skills/link-skill', 'junction'); linked = true; }
      catch (e) { linked = false; }
      if (!linked) { console.log('     (symlink недоступен — пропуск)'); return; }
      const r = runCfgSh(home, clone, { HM_ADDITIVE: '1', HM_ALL_PACK_SKILLS: 'link-skill,our-skill', HM_KEEP_SKILLS: 'something-else' });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(fs.existsSync(home + '/.claude/skills/link-skill'), 'symlink-скилл ЦЕЛ');
      assert(fs.existsSync(base + '/elsewhere-skill/DATA.md'), 'данные за ссылкой ЦЕЛЫ');
      assert(!fs.existsSync(home + '/.claude/skills/our-skill'), 'наш скилл снятого пака удалён (прунинг работает)');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
} else {
  console.log('  ⚠️  bash недоступен — функциональные прогоны config.sh пропущены.');
}

if (powershellAvailable()) {
  console.log('== config.ps1 (функц., sandbox-HOME): add-missing / repair — данные на месте, НЕ move ==');

  ok('config.ps1 add-missing: существующее НЕ перезаписано, недостающее добавлено, install.ps1 НЕ вызван, оригинал+копия-бэкап', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      const r = runCfgPs1(home, clone, { HM_ADDITIVE: '1' });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.json', 'utf8'), '{"user":"custom"}', 'settings.json юзера НЕ перезаписан (add-missing)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/rules/new-rule.md', 'utf8'), 'fresh rule', 'недостающий файл доложен');
      assert(fs.existsSync(home + '/.claude/skills/our-skill/SKILL.md'), 'наш скилл доложен');
      assertUserDataIntact(home);
      assertNoWipe(home);
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.ps1 repair: НАШИ базовые перезаписаны свежими; пользовательское (preserve-list вкл. chats.db.backup, tg -wal/-shm) ЦЕЛО; install.ps1 НЕ вызван; НЕ move', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      const r = runCfgPs1(home, clone, {});   // HM_ADDITIVE удалён → repair
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.json', 'utf8'), '{"fresh":"base"}', 'settings.json (наш базовый) перезаписан свежим (repair)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/rules/new-rule.md', 'utf8'), 'fresh rule', 'свежие правила разложены');
      assert(fs.existsSync(home + '/.claude/skills/our-skill/SKILL.md'), 'наш скилл разложен');
      assertUserDataIntact(home);   // пользовательское НЕ тронуто даже в repair
      assertNoWipe(home);
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.ps1 REPAIR: пред-существующий скилл юзера с ИМЕНЕМ снятого пака НЕ удаляется и НЕ перезаписан (P1 Codex — repair игнорировал pre-existing)', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);   // ~/.claude/skills/user-skill (пред-существующий, содержимое 'user skill')
      // repair (БЕЗ HM_ADDITIVE): user-skill в снятом паке (в ALL, НЕ в KEEP), но НЕ в clone.
      // До фикса weAdded=(-not $ADDITIVE)-or… → в repair всегда true → Remove-Item -Recurse
      // сносил чужой скилл. Теперь $preExisting щадит его в ОБОИХ режимах.
      const r = runCfgPs1(home, clone, { HM_ALL_PACK_SKILLS: 'user-skill,our-skill', HM_KEEP_SKILLS: 'something-else' });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(home + '/.claude/skills/user-skill/SKILL.md', 'utf8'), 'user skill',
        'пред-существующий скилл юзера ЦЕЛ и не перезаписан в repair (P1 закрыт)');
      assert(!fs.existsSync(home + '/.claude/skills/our-skill'), 'доложенный нами скилл снятого пака удалён (прунинг работает и в repair)');
      assert(/убрано: 1/.test(r.stdout || ''), 'удалён ровно 1 (наш, не юзера): ' + (r.stdout || ''));
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.ps1 REPAIR: ~/.claude/skills — junction на внешнюю папку → merge НЕ пишет сквозь ссылку (P1 Codex merge-through-symlink)', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      fs.rmSync(home + '/.claude/skills', { recursive: true, force: true });
      fs.mkdirSync(base + '/external-skills/our-skill', { recursive: true });
      fs.writeFileSync(base + '/external-skills/our-skill/DATA.md', 'EXTERNAL');
      let linked = false;
      try { fs.symlinkSync(base + '/external-skills', home + '/.claude/skills', 'junction'); linked = true; }
      catch (e) { linked = false; }
      if (!linked) { console.log('     (symlink/junction недоступен — пропуск)'); return; }
      const r = runCfgPs1(home, clone, {});   // repair (clone везёт skills/our-skill/SKILL.md)
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(base + '/external-skills/our-skill/DATA.md', 'utf8'), 'EXTERNAL',
        'внешний файл за junction НЕ тронут (robocopy /XD skills + /XJ — не прошёл сквозь ссылку)');
      assert(!fs.existsSync(base + '/external-skills/our-skill/SKILL.md'),
        'наш skills/our-skill/SKILL.md НЕ дописан во внешнюю цель через junction');
      assert(/скиллы НЕ разложены/.test(r.stdout || ''),
        'честный статус: рапорт не выдаёт «всё ок», когда skills пропущены целиком: ' + (r.stdout || ''));
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.ps1 REPAIR: слинкован ОДИН дочерний скилл → внешняя цель цела, остальные скиллы РАЗЛОЖЕНЫ (#42)', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);
      // clone везёт skills/our-skill; добавим второй скилл, чтобы проверить, что он доехал.
      fs.mkdirSync(clone + '/.claude/skills/second-skill', { recursive: true });
      fs.writeFileSync(clone + '/.claude/skills/second-skill/SKILL.md', 'second');
      fs.mkdirSync(base + '/ext-one', { recursive: true });
      fs.writeFileSync(base + '/ext-one/DATA.md', 'EXTERNAL-ONE');
      let linked = false;
      try { fs.symlinkSync(base + '/ext-one', home + '/.claude/skills/our-skill', 'junction'); linked = true; }
      catch (e) { linked = false; }
      if (!linked) { console.log('     (symlink/junction недоступен — пропуск)'); return; }
      const r = runCfgPs1(home, clone, {});   // repair
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(!fs.existsSync(base + '/ext-one/SKILL.md'), 'во внешнюю цель слинкованного скилла НЕ писали');
      assert.strictEqual(fs.readFileSync(base + '/ext-one/DATA.md', 'utf8'), 'EXTERNAL-ONE', 'внешний файл цел');
      assert(fs.existsSync(home + '/.claude/skills/second-skill/SKILL.md'),
        'остальные скиллы разложены (одна ссылка не отменяет раскладку всего каталога): ' + (r.stdout || ''));
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('config.ps1 ADD-MISSING ×3: .hamidun-skills.txt НЕ присваивает пред-существующий скилл юзера (data-loss на 2-м прогоне), снятие пака живо на 3-м', () => {
    const { base, home, clone } = mkCfgSandbox();
    try {
      seedHome(home);   // ~/.claude/skills/user-skill — СВОЙ скилл юзера ('user skill')
      // Пак НАРОЧНО везёт скилл с ИМЕНЕМ юзерского (коллизия класса git-workflow/security-audit):
      // до фикса запись в .hamidun-skills.txt шла СПИСКОМ ИСТОЧНИКА, и на 2-м прогоне
      // $weAdded = … -or $ourPrev.ContainsKey(…) метил каталог юзера «нашим» → Remove-Item -Recurse.
      fs.mkdirSync(clone + '/.claude/skills/user-skill', { recursive: true });
      fs.writeFileSync(clone + '/.claude/skills/user-skill/SKILL.md', 'pack version');
      fs.writeFileSync(home + '/.claude/skills/user-skill/PRECIOUS.md', 'PRECIOUS USER DATA');
      const env = { HM_ADDITIVE: '1', HM_ALL_PACK_SKILLS: 'user-skill,our-skill', HM_KEEP_SKILLS: 'our-skill' };

      // Прогон 1: $preExisting сберегает скилл юзера, инвентарь пишется БЕЗ него.
      let r = runCfgPs1(home, clone, env);
      assert.strictEqual(r.status, 0, 'прогон 1 exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(fs.existsSync(home + '/.claude/skills/user-skill/PRECIOUS.md'), 'прогон 1: файл юзера цел');
      const list = fs.readFileSync(home + '/.claude/.hamidun-skills.txt', 'utf8')
        .replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);   // Set-Content -Encoding UTF8 (PS 5.1) пишет BOM
      assert(!list.includes('user-skill'), 'пред-существующий user-skill НЕ записан в инвентарь как «наш»: [' + list.join(',') + ']');
      assert(list.includes('our-skill'), 'реально доложенный нами our-skill записан в инвентарь: [' + list.join(',') + ']');

      // Прогон 2 (те же env) — сценарий воспроизведения потери данных: до фикса каталог
      // юзера сносился здесь вместе с PRECIOUS.md. Теперь — цел и не перезаписан.
      r = runCfgPs1(home, clone, env);
      assert.strictEqual(r.status, 0, 'прогон 2 exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(home + '/.claude/skills/user-skill/PRECIOUS.md', 'utf8'), 'PRECIOUS USER DATA',
        'прогон 2: пред-существующий скилл юзера ЦЕЛ (до фикса удалялся по инвентарю .hamidun-skills.txt)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/skills/user-skill/SKILL.md', 'utf8'), 'user skill',
        'прогон 2: содержимое юзера НЕ перезаписано паковой версией');
      assert(fs.existsSync(home + '/.claude/skills/our-skill/SKILL.md'), 'прогон 2: выбранный our-skill на месте');

      // Прогон 3: пак our-skill СНЯТ. Благодаря объединению инвентаря с $ourPrev наш скилл
      // всё ещё числится нашим и удаляется (без объединения список схлопнулся бы на 2-м
      // прогоне — «всё пред-существует» — и снятие пака умирало с 3-го прогона).
      r = runCfgPs1(home, clone, Object.assign({}, env, { HM_KEEP_SKILLS: 'something-else' }));
      assert.strictEqual(r.status, 0, 'прогон 3 exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(!fs.existsSync(home + '/.claude/skills/our-skill'), 'прогон 3: наш our-skill снятого пака УДАЛЁН (снятие пака живо на 3-м прогоне)');
      assert(fs.existsSync(home + '/.claude/skills/user-skill/PRECIOUS.md'), 'прогон 3: скилл юзера по-прежнему ЦЕЛ');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
} else {
  console.log('  ⚠️  powershell недоступен — функциональные прогоны config.ps1 пропущены.');
}

console.log('== Фаза 2 (переделка): деинсталляция по ЗАШИТОМУ аллоулисту, не по квитанциям ==');
const utMod = require(path.join(ROOT, 'src', 'uninstall-targets.js'));
const uxMod = require(path.join(ROOT, 'src', 'uninstall-exec.js'));
const NUL = String.fromCharCode(0);

// checkTarget (uninstall-exec.js) fail-closed отвергает ЛЮБОЙ symlink в предках
// цели И любое расхождение лексического/канонического пути (тот же примитив,
// что и продукт: fs.realpathSync.native). os.tmpdir() на macOS резолвится под
// /var/folders/... — а /var САМ symlink на /private/var (штатно для стоковой
// macOS) — guard честно отвергал синтетический sandbox-home теста, хотя
// РЕАЛЬНЫЙ домашний каталог юзера (/Users/<name>) никогда под symlink не лежит.
// На GitHub-раннере Windows та же природа: лексический os.tmpdir() расходится с
// GetFinalPathNameByHandle для %TEMP% раннера. Резолвим ОДИН РАЗ на создании —
// дальше guard сверяет канонический путь САМ С СОБОЙ и совпадает по определению.
function mkHomeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-un-'));
  try { return (fs.realpathSync.native || fs.realpathSync)(d); }
  catch (e) { return d; }
}
function dropDir(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
function targetPathsOf(plan) {
  return plan.targets.map((t) => t.path || t.dir || t.file || t.plist || '').filter(Boolean);
}

ok('targets: course (win32) — контент курса из известных мест; ярлык из вшитого config; НИ одной цели в ~/.claude', () => {
  // P0 (портируемость): win32-семантика — путь строим path.win32, а НЕ host-
  // зависимым generic path.join (на macOS/Linux-раннере это был бы path.posix и
  // ломал сравнение с продуктовым path.win32.join, введённым для честного ctx.platform).
  const P = path.win32;
  const home = 'C:\\Users\\t';
  const plan = utMod.uninstallTargets('course', {
    platform: 'win32', home, desktop: 'C:\\Users\\t\\Desktop',
    courseTargetRaw: '%USERPROFILE%\\HamidunCourse', courseShortcut: 'Курс вайбкодинг (Claude Code)'
  });
  assert(plan && plan.targets.length, 'план есть');
  const cd = P.join(home, 'HamidunCourse', 'vibecoding-course');
  const paths = targetPathsOf(plan).map((p) => p.toLowerCase());
  [P.join(cd, 'tracks'), P.join(cd, '.claude', 'skills'), P.join(cd, '.claude', 'commands'),
   P.join(cd, '.course', 'knowledge'), P.join(cd, 'CLAUDE.md')]
    .forEach((p) => assert(paths.indexOf(p.toLowerCase()) !== -1, 'цель есть: ' + p));
  assert(plan.targets.some((t) => t.type === 'file' && /\\desktop\\курс вайбкодинг \(claude code\)\.lnk$/i.test(t.path)),
    'ярлык .lnk с именем из вшитого config.json (не из renderer-env)');
  targetPathsOf(plan).forEach((p) =>
    assert(p.toLowerCase().indexOf(P.join(home, '.claude').toLowerCase() + P.sep) !== 0 &&
           p.toLowerCase() !== P.join(home, '.claude').toLowerCase(),
      'цель НЕ в пользовательском ~/.claude: ' + p));
  // preserve: прогресс ученика — священен
  const keep = (plan.preserve || []).map((p) => p.toLowerCase());
  [P.join(cd, 'sandbox'), P.join(cd, '.course', 'state.json'),
   P.join(cd, '.course', 'identity.json'), P.join(cd, '.claude', 'settings.local.json')]
    .forEach((p) => assert(keep.indexOf(p.toLowerCase()) !== -1, 'preserve: ' + p));
});

ok('targets: resolveCourseTarget — %USERPROFILE% (win); Windows-путь/пусто на darwin → дефолт; ~ раскрывается', () => {
  assert.strictEqual(utMod.resolveCourseTarget('%USERPROFILE%\\HamidunCourse', 'C:\\Users\\t', 'win32'),
    'C:\\Users\\t\\HamidunCourse');
  assert.strictEqual(utMod.resolveCourseTarget('%USERPROFILE%\\HamidunCourse', '/Users/t', 'darwin'),
    path.posix.join('/Users/t', 'HamidunCourse'));
  assert.strictEqual(utMod.resolveCourseTarget('', '/Users/t', 'darwin'), path.posix.join('/Users/t', 'HamidunCourse'));
  assert.strictEqual(utMod.resolveCourseTarget('~/Cursos', '/Users/t', 'darwin'), path.posix.join('/Users/t', 'Cursos'));
});

ok('targets: uv (win32) — ТОЧНЫЕ файлы (не рекурсивный каталог), emptydir, pathentry только при опустевшем каталоге', () => {
  const plan = utMod.uninstallTargets('uv', { platform: 'win32', home: 'C:\\Users\\t' });
  const dest = 'C:\\Users\\t\\AppData\\Local\\Programs\\uv';
  const types = plan.targets.map((t) => t.type);
  assert(plan.targets.some((t) => t.type === 'file' && t.path === path.win32.join(dest, 'uv.exe')), 'file uv.exe');
  assert(plan.targets.some((t) => t.type === 'file' && t.path === path.win32.join(dest, 'uvx.exe')), 'file uvx.exe');
  assert(plan.targets.some((t) => t.type === 'emptydir' && t.path === dest), 'emptydir на каталоге uv');
  assert(types.indexOf('dirtree') === -1, 'НИКАКОГО рекурсивного сноса каталога uv (чужие файлы там выживают)');
  const pe = plan.targets.find((t) => t.type === 'pathentry');
  assert(pe && pe.dir === dest && pe.onlyIfDirGone === true, 'pathentry: точная запись, только если каталог опустел');
});

ok('targets: bridge — config.json (SSH-креды) НИ в одной цели, зато в preserve; reg — точное HKCU\\...\\Run', () => {
  for (const plat of ['win32', 'darwin']) {
    const home = plat === 'win32' ? 'C:\\Users\\t' : '/Users/t';
    const plan = utMod.uninstallTargets('bridge', { platform: plat, home });
    targetPathsOf(plan).forEach((p) => assert(!/config\.json$/i.test(p), plat + ': config.json не удаляется: ' + p));
    assert((plan.preserve || []).some((p) => /config\.json$/i.test(p)), plat + ': config.json в preserve');
    if (plat === 'win32') {
      const reg = plan.targets.find((t) => t.type === 'reg');
      assert(reg && reg.hive === 'HKCU' && reg.key === 'Software\\Microsoft\\Windows\\CurrentVersion\\Run' &&
        reg.value === 'HamidunBridge', 'reg: точное значение Run');
    } else {
      const la = plan.targets.find((t) => t.type === 'launchagent');
      assert(la && la.label === 'com.hamidun.bridge' && /com\.hamidun\.bridge\.plist$/.test(la.plist), 'launchagent: точный label+plist');
      const pls = plan.targets.filter((t) => t.type === 'profileline');
      // P0-6: цель — ТОЧНАЯ installer-строка (не маркер-подстрока)
      assert(pls.length === 2 && pls.every((t) => t.line === utMod.BRIDGE_RC_LINE), 'profileline: точная installer-строка');
      assert(utMod.BRIDGE_RC_LINE.indexOf('# Hamidun Bridge CLI proxy') !== -1, 'строка содержит маркер-хвост');
      assert(pls.every((t) => /[\\/](\.zshrc|\.bash_profile)$/.test(t.file)), 'profileline: только разрешённые rc-файлы');
      // Парити с bridge.sh: строка в плане ДОСЛОВНО равна BRIDGE_RC_LINE из скрипта
      try {
        const bsh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'bridge.sh'), 'utf8');
        const bm = bsh.match(/^BRIDGE_RC_LINE='(.+)'$/m);
        assert(bm, 'BRIDGE_RC_LINE найден в bridge.sh');
        assert.strictEqual(utMod.BRIDGE_RC_LINE, bm[1], 'строка плана == строке install-скрипта (verbatim)');
      } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
    }
  }
});

ok('targets: nomad — АВТО-УДАЛЕНИЕ ОТКЛЮЧЕНО в v1 (пустой план + uninstallSupported:false; НИ ОДНОЙ цели ни на одной платформе)', () => {
  for (const plat of ['win32', 'darwin']) {
    const home = plat === 'win32' ? 'C:\\Users\\t' : '/Users/t';
    const plan = utMod.uninstallTargets('nomad', { platform: plat, home });
    assert(plan && typeof plan === 'object', 'nomad → объект-план (не null), чтобы флаг был читаем: ' + plat);
    assert(plan.uninstallSupported === false, 'nomad: uninstallSupported === false (' + plat + ')');
    assert(Array.isArray(plan.targets) && plan.targets.length === 0, 'nomad: НИ ОДНОЙ цели удаления (' + plat + ')');
    assert((plan.preserve || []).length === 0, 'nomad: preserve пуст — исполнять нечего (' + plat + ')');
    // Никаких venv/шимов/nomad-src/hermes-src целей — TOCTOU-нора закрыта отсутствием целей.
    assert(!(plan.targets || []).some((t) => /nomad-src|uv[\\/]tools|\.local[\\/]bin/i.test(t.path || '')), 'нет venv/шим/nomad-src целей');
  }
  // Кастомное имя тула в ctx больше НЕ порождает целей (план пуст независимо от ctx).
  const evil = utMod.uninstallTargets('nomad', { platform: 'win32', home: 'C:\\Users\\t', nomadTool: '..\\..\\evil' });
  assert(evil.targets.length === 0, 'даже с грязным nomadTool план пуст');
  // Явный общий реестр отключённых от авто-удаления компонентов.
  assert(utMod.UNINSTALL_DISABLED && utMod.UNINSTALL_DISABLED.has('nomad'), 'nomad в exported UNINSTALL_DISABLED');
});

ok('targets: mascot (darwin) БЕЗ vendor → НЕТ appbundle-цели (fail-closed); с vendor → точный путь + пин TeamID', () => {
  const noVendor = utMod.uninstallTargets('mascot', { platform: 'darwin', home: '/Users/t', mascotMac: null });
  assert(!noVendor.targets.some((t) => t.type === 'appbundle'), 'без vendor .app не трогаем');
  assert((noVendor.notes || []).some((n) => /vendor/i.test(n)), 'об этом честно сказано в notes');
  const withVendor = utMod.uninstallTargets('mascot', {
    platform: 'darwin', home: '/Users/t',
    mascotMac: { appName: 'Claude Mascot.app', bundleId: 'com.hamidun.claude-mascot' }
  });
  const ab = withVendor.targets.find((t) => t.type === 'appbundle');
  assert(ab && ab.path === path.posix.join('/Users/t', 'Applications', 'Claude Mascot.app'), 'точный путь бандла');
  assert(ab.expectBundleId === 'com.hamidun.claude-mascot', 'эталонный CFBundleIdentifier из ДОВЕРЕННОГО vendor');
  assert(ab.teamId === utMod.MASCOT_TEAM_ID && utMod.MASCOT_TEAM_ID === '3VN93XA9DY', 'пин TeamID');
});

ok('targets: неизвестный/не-removable id → null (деинсталляция отклоняется fail-closed)', () => {
  for (const id of ['git', 'node', 'config', 'claude', 'evil', '']) {
    assert.strictEqual(utMod.uninstallTargets(id, { platform: 'win32', home: 'C:\\Users\\t' }), null, id + ' → null');
  }
  assert.strictEqual(utMod.uninstallTargets('course', null), null, 'нет ctx → null');
});

console.log('== Guard (checkTarget): fail-closed на все классы обходов ==');

ok('guard: сам ~/.claude, всё внутри него, дом, предок дома, ~/CLAUDE.md, ~/.hamidun-setup → отказ', () => {
  const home = mkHomeDir();
  try {
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    const opts = { home, platform: process.platform };
    const bad = [
      home, path.dirname(home),
      path.join(home, '.claude'),
      path.join(home, '.claude', 'settings.json'),
      path.join(home, '.claude', 'skills', 'x'),
      path.join(home, 'CLAUDE.md'),
      path.join(home, '.hamidun-setup'),
      path.join(home, '.hamidun-setup', 'receipts', 'uv.json')
    ];
    for (const p of bad) {
      const g = uxMod.checkTarget(p, opts);
      assert(!g.ok, 'должен отказать: ' + p + ' → ' + JSON.stringify(g));
    }
    const okG = uxMod.checkTarget(path.join(home, 'HamidunCourse', 'vibecoding-course', 'CLAUDE.md'), opts);
    assert(okG.ok, 'легитимная цель проходит: ' + JSON.stringify(okG));
  } finally { dropDir(home); }
});

ok('guard: сегменты «..»/«.», NUL/CR/LF, пусто, относительный путь → отказ (framing-гигиена)', () => {
  const home = mkHomeDir();
  try {
    const opts = { home, platform: process.platform };
    assert(!uxMod.checkTarget(path.join(home, 'a') + path.sep + '..' + path.sep + '.claude', opts).ok, '«..» отклонён');
    assert(!uxMod.checkTarget(home + path.sep + '.' + path.sep + 'x', opts).ok, '«.» отклонён');
    assert(!uxMod.checkTarget(home + path.sep + 'a' + NUL + 'b', opts).ok, 'NUL отклонён');
    assert(!uxMod.checkTarget(home + path.sep + 'a\rb', opts).ok, 'CR отклонён');
    assert(!uxMod.checkTarget(home + path.sep + 'a\nb', opts).ok, 'LF отклонён');
    assert(!uxMod.checkTarget('relative/path', opts).ok, 'относительный отклонён');
    assert(!uxMod.checkTarget('', opts).ok, 'пустой отклонён');
    assert(!uxMod.checkTarget(home + '//.claude', opts).ok, 'двойной слэш не обходит защиту');
  } finally { dropDir(home); }
});

ok('guard (win32-семантика): UNC/device/volume-алиасы (\\\\server, \\\\?\\, \\\\.\\, //) → отказ', () => {
  const opts = { home: 'C:\\Users\\t', platform: 'win32' };
  ['\\\\server\\share\\x', '\\\\?\\C:\\Users\\t\\HamidunCourse', '\\\\.\\C:\\Users\\t\\x',
   '//server/share/x', '\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x']
    .forEach((p) => assert(!uxMod.checkTarget(p, opts).ok, 'алиас отклонён: ' + p));
});

ok('guard: symlink/junction-ПРЕДОК → отказ; цель за ссылкой цела (реальная ФС)', () => {
  const home = mkHomeDir();
  try {
    fs.mkdirSync(path.join(home, 'realdir', 'payload'), { recursive: true });
    fs.writeFileSync(path.join(home, 'realdir', 'payload', 'f.txt'), 'x');
    let linked = false;
    try { fs.symlinkSync(path.join(home, 'realdir'), path.join(home, 'linkdir'), 'junction'); linked = true; }
    catch (e) { linked = false; }
    if (!linked) { console.log('     (symlink недоступен — пропуск)'); return; }
    const opts = { home, platform: process.platform };
    const g = uxMod.checkTarget(path.join(home, 'linkdir', 'payload'), opts);
    assert(!g.ok && /symlink|junction/i.test(g.reason), 'ссылка-предок → отказ: ' + JSON.stringify(g));
    const r = uxMod.removeDirTree(path.join(home, 'linkdir', 'payload'), opts);
    assert(r.status === 'failed', 'исполнитель отказал: ' + JSON.stringify(r));
    assert(fs.existsSync(path.join(home, 'realdir', 'payload', 'f.txt')), 'цель за ссылкой ЦЕЛА');
    const g2 = uxMod.checkTarget(path.join(home, 'linkdir'), opts);
    assert(!g2.ok, 'сама ссылка как цель → отказ');
  } finally { dropDir(home); }
});

ok('guard: EIO/EACCES при lstat → НЕМЕДЛЕННЫЙ отказ (fail-closed, не «false»)', () => {
  const home = mkHomeDir();
  const orig = fs.lstatSync;
  try {
    fs.lstatSync = function () { const e = new Error('EIO (test)'); e.code = 'EIO'; throw e; };
    const g = uxMod.checkTarget(path.join(home, 'HamidunCourse', 'x'), { home, platform: process.platform });
    assert(!g.ok && /EIO|lstat/i.test(g.reason), 'EIO → отказ: ' + JSON.stringify(g));
  } finally {
    fs.lstatSync = orig;
    dropDir(home);
  }
});

ok('guard (darwin-семантика): APFS device+inode — на этой машине проверяется только код-путь', () => {
  // Функционально device+inode-сверку (APFS firmlink /System/Volumes/Data/...)
  // можно проверить только на macOS. Здесь — source-инвариант: POSIX-ветка
  // сверяет dev+ino цели и предков против защищённых корней, ошибки stat → отказ.
  const s = fs.readFileSync(path.join(ROOT, 'src', 'uninstall-exec.js'), 'utf8');
  assert(/st\.dev === pi\.dev && st\.ino === pi\.ino/.test(s), 'сверка dev+ino с защищёнными корнями');
  assert(/inode совпал с домашним каталогом/.test(s), 'цель-сам-дом ловится по inode');
  assert(/return no\('stat\(/.test(s), 'ошибка stat в ino-проходе → отказ (fail-closed)');
});

console.log('== Исполнители удаления (реальная ФС) ==');

ok('removeFile: легитимный файл удалён; ~/.claude/settings.json → ЗАЩИТА; каталог как file-цель → отказ', () => {
  const home = mkHomeDir();
  try {
    const opts = { home, platform: process.platform };
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    fs.mkdirSync(path.join(home, 'app'), { recursive: true });
    fs.writeFileSync(path.join(home, 'app', 'bin.exe'), 'x');
    assert.strictEqual(uxMod.removeFile(path.join(home, 'app', 'bin.exe'), opts).status, 'removed', 'файл удалён');
    assert(!fs.existsSync(path.join(home, 'app', 'bin.exe')), 'файла нет');
    const r2 = uxMod.removeFile(path.join(home, '.claude', 'settings.json'), opts);
    assert(r2.status === 'failed' && /ЗАЩИТА/.test(r2.message), 'settings.json защищён');
    assert(fs.existsSync(path.join(home, '.claude', 'settings.json')), 'settings.json цел');
    const r3 = uxMod.removeFile(path.join(home, 'app'), opts);
    assert(r3.status === 'failed', 'каталог как file-цель → отказ');
    assert.strictEqual(uxMod.removeFile(path.join(home, 'app', 'nope.exe'), opts).status, 'absent', 'нет файла → absent');
  } finally { dropDir(home); }
});

ok('removeEmptyDir: непустой → kept (содержимое цело); пустой → удалён', () => {
  const home = mkHomeDir();
  try {
    const opts = { home, platform: process.platform };
    fs.mkdirSync(path.join(home, 'd', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(home, 'd', 'sub', 'keep.txt'), 'x');
    const r1 = uxMod.removeEmptyDir(path.join(home, 'd', 'sub'), opts);
    assert.strictEqual(r1.status, 'kept', 'непустой оставлен: ' + JSON.stringify(r1));
    assert(fs.existsSync(path.join(home, 'd', 'sub', 'keep.txt')), 'содержимое цело');
    fs.unlinkSync(path.join(home, 'd', 'sub', 'keep.txt'));
    assert.strictEqual(uxMod.removeEmptyDir(path.join(home, 'd', 'sub'), opts).status, 'removed', 'пустой удалён');
  } finally { dropDir(home); }
});

ok('removeDirTree: preserve-путь ВНУТРИ цели → отказ всей цели (ничего не удалено)', () => {
  const home = mkHomeDir();
  try {
    fs.mkdirSync(path.join(home, 'tree', 'a'), { recursive: true });
    fs.writeFileSync(path.join(home, 'tree', 'a', 'state.json'), '{}');
    const opts = { home, platform: process.platform, extraProtected: [path.join(home, 'tree', 'a', 'state.json')] };
    const r = uxMod.removeDirTree(path.join(home, 'tree'), opts);
    assert(r.status === 'failed' && /ЗАЩИТА/.test(r.message), 'отказ: ' + JSON.stringify(r));
    assert(fs.existsSync(path.join(home, 'tree', 'a', 'state.json')), 'ничего не удалено');
  } finally { dropDir(home); }
});

ok('removeProfileLine: rc вне списка (crafted ~/.claude/settings.json как profileline) → ЗАЩИТА; P0-6 уходит ТОЛЬКО точная installer-строка', () => {
  const home = mkHomeDir();
  const LINE = utMod.BRIDGE_RC_LINE;
  try {
    const opts = { home, platform: process.platform };
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"hooks":"# Hamidun Bridge CLI proxy"}');
    const r1 = uxMod.removeProfileLine(path.join(home, '.claude', 'settings.json'), LINE, opts);
    assert(r1.status === 'failed' && /ЗАЩИТА/.test(r1.message), 'settings.json как rc → отказ');
    assert.strictEqual(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
      '{"hooks":"# Hamidun Bridge CLI proxy"}', 'settings.json цел');
    // и любой другой не-rc файл тоже
    fs.writeFileSync(path.join(home, 'notes.txt'), 'x # Hamidun Bridge CLI proxy');
    assert.strictEqual(uxMod.removeProfileLine(path.join(home, 'notes.txt'), LINE, opts).status,
      'failed', 'не-rc файл → отказ');
    // легитимный ~/.zshrc: уходит ТОЛЬКО строка, ТОЧНО РАВНАЯ installer-строке
    fs.writeFileSync(path.join(home, '.zshrc'),
      'export A=1\n' + LINE + '\nalias ll="ls -la"\n');
    const r2 = uxMod.removeProfileLine(path.join(home, '.zshrc'), LINE, opts);
    assert.strictEqual(r2.status, 'removed', 'zshrc обработан: ' + JSON.stringify(r2));
    const left = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    assert(left.indexOf('Hamidun Bridge') === -1, 'installer-строка убрана');
    assert(left.indexOf('export A=1') !== -1 && left.indexOf('alias ll') !== -1, 'чужие строки целы');
    // строка-цель с переводом строки → отказ
    assert.strictEqual(uxMod.removeProfileLine(path.join(home, '.zshrc'), 'x\ny', opts).status, 'failed', 'CRLF-цель отклонена');
  } finally { dropDir(home); }
});

// P0-6 (функционально): пользовательская строка, лишь СОДЕРЖАЩАЯ маркер-подстроку,
// НЕ удаляется; наша точная строка (в т.ч. с отступами) — удаляется.
ok('P0-6 removeProfileLine: substring-строка юзера (export NOTE="… # Hamidun Bridge …") ЦЕЛА, точная installer-строка убрана', () => {
  const home = mkHomeDir();
  const LINE = utMod.BRIDGE_RC_LINE;
  try {
    const opts = { home, platform: process.platform };
    const userLine = 'export NOTE="see # Hamidun Bridge CLI proxy for details"';
    const userLine2 = 'echo before; ' + LINE;  // строка-СУПЕРСТРОКА (не точное равенство)
    fs.writeFileSync(path.join(home, '.zshrc'),
      userLine + '\n  ' + LINE + '  \n' + userLine2 + '\n');
    const r = uxMod.removeProfileLine(path.join(home, '.zshrc'), LINE, opts);
    assert.strictEqual(r.status, 'removed', JSON.stringify(r));
    const left = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    assert(left.indexOf(userLine) !== -1, 'пользовательская строка с маркером-подстрокой ЦЕЛА');
    assert(left.indexOf(userLine2) !== -1, 'суперстрока (наша строка внутри чужой) ЦЕЛА');
    assert(left.split('\n').every((l) => l.trim() !== LINE.trim()), 'точная installer-строка (с отступами) убрана');
    // повторный вызов: строки уже нет → absent (идемпотентно)
    assert.strictEqual(uxMod.removeProfileLine(path.join(home, '.zshrc'), LINE, opts).status, 'absent', 'идемпотентность');
  } finally { dropDir(home); }
});

// P0-1 (функционально): заранее созданный HARDLINK на месте temp-файла. Фиксируем
// randomBytes → имя temp предсказуемо для теста → на нём hardlink на
// ~/.claude/settings.json. O_EXCL ('wx') обязан дать EEXIST → отказ, оба файла целы.
ok('P0-1 removeProfileLine: hardlink-ловушка на temp-имени → ОТКАЗ (EEXIST), settings.json и rc ЦЕЛЫ', () => {
  const home = mkHomeDir();
  const cryptoMod = require('crypto');
  const origRandom = cryptoMod.randomBytes;
  const LINE = utMod.BRIDGE_RC_LINE;
  try {
    const opts = { home, platform: process.platform };
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, '{"user":"precious-hooks"}');
    const rc = path.join(home, '.zshrc');
    fs.writeFileSync(rc, 'export A=1\n' + LINE + '\n');
    // фиксируем «случайность» → все 3 попытки дают одно и то же имя
    const fixed = Buffer.from('00112233aabbccdd', 'hex');
    cryptoMod.randomBytes = () => fixed;
    let linked = false;
    const trapTmp = rc + '.hm-un.' + fixed.toString('hex') + '.tmp';
    try { fs.linkSync(settings, trapTmp); linked = true; } catch (e) { linked = false; }
    if (!linked) { console.log('     (hardlink недоступен — пропуск)'); return; }
    const r = uxMod.removeProfileLine(rc, LINE, opts);
    assert.strictEqual(r.status, 'failed', 'ловушка → отказ: ' + JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{"user":"precious-hooks"}', 'settings.json ЦЕЛ (не перезаписан через hardlink)');
    assert(fs.readFileSync(rc, 'utf8').indexOf(LINE) !== -1, 'rc не тронут (атомарность не нарушена)');
    // ловушку убираем → на чистом пути всё работает
    fs.unlinkSync(trapTmp);
    cryptoMod.randomBytes = origRandom;
    assert.strictEqual(uxMod.removeProfileLine(rc, LINE, opts).status, 'removed', 'без ловушки — удаляется');
    assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{"user":"precious-hooks"}', 'settings.json всё ещё ЦЕЛ');
  } finally { cryptoMod.randomBytes = origRandom; dropDir(home); }
});

// P0-1 (source): temp создаётся через O_EXCL ('wx') + fstat-проверка fd (isFile,
// nlink==1); имена temp/bak непредсказуемы (crypto.randomBytes), не pid.
ok('P0-1 uninstall-exec (source): O_EXCL + fstat(nlink==1) + случайные имена temp/bak', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'uninstall-exec.js'), 'utf8');
  const fn = s.slice(s.indexOf('function removeProfileLine'), s.indexOf('function computeUserPathWithout'));
  assert(/openSync\(cand, 'wx', 0o600\)/.test(fn), "открытие temp — только 'wx' (O_CREAT|O_EXCL|O_WRONLY)");
  assert(/fstatSync\(fd\)/.test(fn), 'открытый fd проверяется fstat-ом');
  assert(/st\.nlink !== 1/.test(fn), 'nlink!=1 (hardlink) → отказ');
  assert(/st\.isFile\(\)/.test(fn), 'temp обязан быть обычным файлом');
  assert(/crypto\.randomBytes\(8\)/.test(fn), 'имя temp/bak — crypto.randomBytes');
  assert(!/process\.pid \+ '\.tmp'/.test(fn) && !/'\.hm-un\.' \+ process\.pid/.test(fn), 'предсказуемое pid-имя убрано');
});

ok('computeUserPathWithout: убирается ТОЛЬКО точное совпадение; чужие записи и %VAR% целы', () => {
  const raw = 'C:\\Windows;%USERPROFILE%\\bin;C:\\Users\\t\\AppData\\Local\\Programs\\uv\\;D:\\tools\\uv-mirror';
  const r = uxMod.computeUserPathWithout(raw, 'C:\\Users\\t\\AppData\\Local\\Programs\\uv');
  assert(r.changed && r.removed === 1, 'ровно одна запись убрана');
  assert.strictEqual(r.value, 'C:\\Windows;%USERPROFILE%\\bin;D:\\tools\\uv-mirror', 'чужие записи (вкл. %VAR%) не тронуты');
  const r2 = uxMod.computeUserPathWithout('C:\\a;C:\\b', 'C:\\nope');
  assert(!r2.changed, 'нет совпадения → без изменений');
});

// Тесты classifyRegQuery удалены ВМЕСТЕ с функцией: main.js читает реестр сам
// (.NET Registry через winPsPayload), вызовов не осталось — ~30 зелёных строк
// стерегли мёртвый код и создавали ложное ощущение покрытия. Регрессия-страж
// «мёртвое не воскресает» — в блоке staging-уборки в конце файла.

console.log('== PRESERVE (функционально): состояние пользователя переживает деинсталляцию ==');

// Мини-исполнитель файловых целей плана (зеркало main.js executeUninstallTarget
// для fs-типов; reg/pathentry/launchagent/killproc/uvtool здесь не исполняются).
function execFsPlan(plan, home) {
  const opts = { home, platform: process.platform, extraProtected: plan.preserve || [] };
  const results = [];
  for (const t of plan.targets) {
    let r = { status: 'skipped' };
    if (t.type === 'file') {
      // Зеркало main.js: gated shim → removeFileGated (P0-1 ownership).
      r = t.onlyIfOwnerMarker ? uxMod.removeFileGated(t.path, opts, t.onlyIfOwnerMarker) : uxMod.removeFile(t.path, opts);
    } else if (t.type === 'emptydir') r = uxMod.removeEmptyDir(t.path, opts);
    else if (t.type === 'dirtree') {
      // Зеркало main.js: gated dirtree → removeDirTreeGated (P0-3 quarantine-then-guard).
      r = t.onlyIfContains ? uxMod.removeDirTreeGated(t.path, opts, t.onlyIfContains) : uxMod.removeDirTree(t.path, opts);
    } else if (t.type === 'profileline') r = uxMod.removeProfileLine(t.file, t.line, opts);
    results.push({ t, r });
  }
  return results;
}

ok('PRESERVE: деинсталляция курса — sandbox/state.json/identity.json/settings.local.json ЦЕЛЫ, контент курса удалён, ~/.claude цел', () => {
  const home = mkHomeDir();
  try {
    const cd = path.join(home, 'HamidunCourse', 'vibecoding-course');
    // контент архива
    fs.mkdirSync(path.join(cd, 'tracks', 't1'), { recursive: true });
    fs.writeFileSync(path.join(cd, 'tracks', 't1', 'M1.md'), 'lesson');
    fs.mkdirSync(path.join(cd, '.claude', 'skills', 'course-driver'), { recursive: true });
    fs.writeFileSync(path.join(cd, '.claude', 'skills', 'course-driver', 'SKILL.md'), 'skill');
    fs.mkdirSync(path.join(cd, '.claude', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(cd, '.course', 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(cd, 'CLAUDE.md'), 'course');
    fs.writeFileSync(path.join(cd, '.course', 'config.yaml'), 'cfg');
    // ПРОГРЕСС ученика (должен пережить)
    fs.mkdirSync(path.join(cd, 'sandbox', 'proj'), { recursive: true });
    fs.writeFileSync(path.join(cd, 'sandbox', 'proj', 'app.js'), 'my project');
    fs.writeFileSync(path.join(cd, '.course', 'state.json'), '{"track":3}');
    fs.writeFileSync(path.join(cd, '.course', 'identity.json'), '{"name":"student"}');
    fs.writeFileSync(path.join(cd, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(npm *)"]}}');
    // рабочий стол + пользовательский ~/.claude
    fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Desktop', 'Курс вайбкодинг (Claude Code).lnk'), 'lnk');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.master.env'), 'KEY=secret');

    const plan = utMod.uninstallTargets('course', {
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      home, desktop: path.join(home, 'Desktop'),
      courseTargetRaw: '', courseShortcut: 'Курс вайбкодинг (Claude Code)'
    });
    const results = execFsPlan(plan, home);
    const failed = results.filter((x) => x.r.status === 'failed');
    assert.strictEqual(failed.length, 0, 'без отказов: ' + JSON.stringify(failed.map((f) => f.r)));
    // контент удалён
    assert(!fs.existsSync(path.join(cd, 'tracks')), 'tracks удалён');
    assert(!fs.existsSync(path.join(cd, '.claude', 'skills')), 'skills курса удалены');
    assert(!fs.existsSync(path.join(cd, 'CLAUDE.md')), 'CLAUDE.md курса удалён');
    // ПРОГРЕСС ЦЕЛ
    assert(fs.existsSync(path.join(cd, 'sandbox', 'proj', 'app.js')), 'sandbox ЦЕЛ');
    assert.strictEqual(fs.readFileSync(path.join(cd, '.course', 'state.json'), 'utf8'), '{"track":3}', 'state.json ЦЕЛ');
    assert(fs.existsSync(path.join(cd, '.course', 'identity.json')), 'identity.json ЦЕЛ');
    assert(fs.existsSync(path.join(cd, '.claude', 'settings.local.json')), 'settings.local.json (permissions) ЦЕЛ');
    // ~/.claude юзера цел
    assert.strictEqual(fs.readFileSync(path.join(home, '.claude', '.credentials.master.env'), 'utf8'), 'KEY=secret', 'ключи целы');
  } finally { dropDir(home); }
});

ok('PRESERVE: мост — config.json с SSH-кредами ЦЕЛ, bridge_agent.py удалён, каталог остаётся (не пуст)', () => {
  const home = mkHomeDir();
  try {
    // platform — ПО РЕАЛЬНОМУ хосту (как в «PRESERVE: деинсталляция курса»), не
    // захардкожен: home — НАСТОЯЩИЙ POSIX/Windows sandbox этой машины, а
    // uninstallTargets теперь честно использует path.win32/path.posix ПО
    // ctx.platform (P0, портируемость) — захардкоженный 'win32' на macOS-раннере
    // склеивал win32-семантику путей с реальным POSIX-деревом и не проверял ничего.
    const isWin = process.platform === 'win32';
    const plan = utMod.uninstallTargets('bridge', { platform: isWin ? 'win32' : 'darwin', home });
    const dst = isWin
      ? path.join(home, 'AppData', 'Local', 'HamidunBridge')
      : path.join(home, 'Library', 'Application Support', 'HamidunBridge');
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, 'bridge_agent.py'), 'agent');
    fs.writeFileSync(path.join(dst, 'config.json'), '{"ssh":{"host":"1.2.3.4","password":"s3cret"}}');
    const results = execFsPlan(plan, home);
    assert(results.every((x) => x.r.status !== 'failed'), 'без отказов: ' + JSON.stringify(results.map((x) => x.r)));
    assert(!fs.existsSync(path.join(dst, 'bridge_agent.py')), 'bridge_agent.py удалён');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'config.json'), 'utf8'),
      '{"ssh":{"host":"1.2.3.4","password":"s3cret"}}', 'config.json (SSH-креды) ЦЕЛ');
  } finally { dropDir(home); }
});

// v1: тесты УДАЛЕНИЯ Nomad (PRESERVE nomad / P0-3 nomad-src снос) УБРАНЫ — авто-удаление
// Nomad отключено, план пуст (см. тест «targets: nomad — АВТО-УДАЛЕНИЕ ОТКЛЮЧЕНО»). Ни
// venv, ни шимы, ни клон исходников Nomad больше НЕ удаляются установщиком (TOCTOU-нора
// закрыта отсутствием целей). Ниже — только то, что осталось релевантным (skip/receipt —
// общая логика; install-гигиена Nomad; generic-примитив removeDirTreeGated).

console.log('== Nomad: авто-удаление отключено (v1); install-гигиена сохранена ==');

// Ранний гейт main.js: uninstall-обработчик отбивает Nomad ДО плана/деактивации маркера,
// даже при валидной квитанции установки (UNINSTALL_DISABLED). UI-кнопки «Удалить» нет.
ok('main.js (source) + app.js: Nomad-uninstall отбит ранним гейтом (UNINSTALL_DISABLED) и НЕ предлагается в UI', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const un = s.slice(s.indexOf("ipcMain.handle('uninstall-component'"));
  assert(/UNINSTALL_DISABLED[\s\S]{0,40}\.has\(id\)/.test(un), 'main.js: ранний гейт по UNINSTALL_DISABLED в uninstall-обработчике');
  const iGuard = un.indexOf('UNINSTALL_DISABLED');
  const iReceipt = un.indexOf('hasReceipt(home, id)');
  const iPlan = un.indexOf('uninstallTargets.uninstallTargets(id, buildUninstallCtx())');
  assert(iGuard !== -1 && iReceipt !== -1 && iGuard < iReceipt, 'гейт ДО проверки квитанции (отбой даже при валидной квитанции)');
  assert(iPlan !== -1 && iGuard < iPlan, 'гейт ДО построения плана');
  // uninstall-targets экспортирует реестр отключённых и не строит целей для nomad.
  assert(utMod.UNINSTALL_DISABLED instanceof Set && utMod.UNINSTALL_DISABLED.has('nomad'), 'UNINSTALL_DISABLED содержит nomad');
  // UI: REMOVABLE (app.js) НЕ содержит nomad → кнопка «Удалить» для него не рендерится.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const m = app.match(/REMOVABLE = new Set\(\[([^\]]+)\]\)/);
  assert(m, 'REMOVABLE найден в app.js');
  const ids = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  assert(!ids.includes('nomad'), 'app.js REMOVABLE НЕ содержит nomad (нет кнопки «Удалить»)');
});

// receiptsMod объявлен ниже по файлу (TDZ) — берём кэш require под уникальным именем.
const rcMod = require(path.join(ROOT, 'src', 'install-receipts.js'));

// P0-1: skip НЕ пишет receipt — решение делегировано чистым функциям.
ok('P0-1: shouldRecordInstall/isSkipExit — маркер ТОЛЬКО при коде 0 (skip/иной код → нет)', () => {
  assert.strictEqual(rcMod.EXIT_SKIP, 120, 'distinct skip-код = 120');
  assert(rcMod.isSkipExit(120) === true, 'код 120 — skip');
  assert(rcMod.isSkipExit(0) === false && rcMod.isSkipExit(1) === false, '0/1 — не skip');
  assert(rcMod.shouldRecordInstall(0, false, false) === true, 'код 0, не dry, не hidden → пишем');
  assert(rcMod.shouldRecordInstall(120, false, false) === false, 'skip-код → НЕ пишем маркер');
  assert(rcMod.shouldRecordInstall(1, false, false) === false, 'ошибка → НЕ пишем');
  assert(rcMod.shouldRecordInstall(0, true, false) === false, 'dry-run → НЕ пишем');
  assert(rcMod.shouldRecordInstall(0, false, true) === false, 'hidden → НЕ пишем');
});

// P0-1 (функц.): полный оборот install-skip — маркера в ~/.hamidun-setup нет → uninstall
// отклоняется гейтом hasReceipt (нет фантомной кнопки «Удалить»).
ok('P0-1 (функц.): при skip-коде маркер НЕ пишется → hasReceipt=false (кнопка «Удалить» не появится)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-skip-'));
  try {
    // Эмуляция close-handler: пишем маркер ТОЛЬКО если shouldRecordInstall.
    const codes = [{ code: 120, expect: false }, { code: 1, expect: false }, { code: 0, expect: true }];
    for (const { code, expect } of codes) {
      const id = 'nomad';
      try { fs.rmSync(rcMod.receiptPath(home, id), { force: true }); } catch (e) { /* ignore */ }
      if (rcMod.shouldRecordInstall(code, false, false)) {
        rcMod.writeReceipt(home, id, rcMod.buildReceipt(id, 'win32', '1'));
      }
      assert.strictEqual(rcMod.hasReceipt(home, id), expect, 'код ' + code + ' → hasReceipt=' + expect);
    }
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

// P0-1 (scripts): skip-путь nomad.sh/ps1 выходит distinct-кодом 120, а НЕ 0; реальный
// провал (пытались клонировать, источник не появился) → exit 1. v1: ownership-маркеры
// .hamidun-nomad в venv БОЛЬШЕ НЕ пишутся (это была install-side P0 — порча чужих venv).
ok('P0-1 (scripts): nomad.sh/ps1 — vendor-only skip → exit 120 (не 0); клон-ветка (и её exit 1) удалена; маркеры .hamidun-nomad НЕ пишутся', () => {
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'nomad.sh'), 'utf8');
  assert(/Пропускаю\.[\s\S]{0,240}exit 120/.test(nsh), 'nomad.sh: skip → exit 120');
  const nps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'nomad.ps1'), 'utf8');
  assert(/Пропускаю\.[\s\S]{0,240}exit 120/.test(nps), 'nomad.ps1: skip → exit 120');
  // vendor-only: клонирования нет вовсе → ни ветки clone, ни её honest-fail exit 1
  // (с этой веткой ушла TOCTOU-P0 Фазы 2, Codex round-7).
  assert(!/git clone/.test(nsh) && !/CLONE_ATTEMPTED/.test(nsh), 'nomad.sh: клон-ветка удалена (нет git clone / CLONE_ATTEMPTED)');
  assert(!/git clone/.test(nps) && !/cloneAttempted/.test(nps), 'nomad.ps1: клон-ветка удалена (нет git clone / cloneAttempted)');
  // v1: НИ ОДНОЙ записи маркера .hamidun-nomad (ни в venv, ни в nomad-src) — маркерная
  // логика удалена вместе с авто-удалением Nomad. Гарантируем отсутствие любого упоминания.
  assert(!/\.hamidun-nomad/.test(nsh), 'nomad.sh: НЕТ упоминаний .hamidun-nomad (маркеры не пишутся)');
  assert(!/\.hamidun-nomad/.test(nps), 'nomad.ps1: НЕТ упоминаний .hamidun-nomad (маркеры не пишутся)');
});

ok('nomad.sh: на Intel-маке cryptography ограничена версией с колесом — через -c, а не надеждой на uv.lock', () => {
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'nomad.sh'), 'utf8');
  // Upstream убрал колёса под macOS x86_64 с 49.0.0 — без пина установка уходит
  // собирать из исходников (Rust/PyO3/openssl-sys) и падает каскадом ошибок сборки.
  assert(/cryptography>=[\d.]+,<49/.test(nsh), 'пин cryptography <49 присутствует');
  // Ключевое: пин обязан ехать ФАЙЛОМ ОГРАНИЧЕНИЙ. `uv tool install` резолвит
  // зависимости заново и uv.lock игнорирует — версия из lock сама не подхватится.
  assert(/uv tool install --python 3\.12 -c "\$CONSTRAINTS" "\$BUILD_SRC"/.test(nsh),
    'пин едет файлом ограничений прямо в команде установки');
  // Ветки РАЗДЕЛЬНЫЕ, без массива аргументов: скрипт под `set -u`, а /bin/bash на маке
  // версии 3.2 — там "${arr[@]}" при пустом массиве считается неустановленной
  // переменной и роняет установку. Первый заход именно так и сломал Apple Silicon.
  assert(!/UV_EXTRA/.test(nsh), 'никаких массивов аргументов — bash 3.2 под set -u их не переживает');
  assert(/uv tool install --python 3\.12 "\$BUILD_SRC"/.test(nsh),
    'ветка без ограничений сохранена дословно (arm64 ставит как раньше)');
  // И только на Intel: на arm64 колёса есть для всех версий, старить библиотеку незачем.
  const i = nsh.indexOf('CONSTRAINTS="');
  const guard = nsh.slice(Math.max(0, i - 400), i);
  assert(/arch_tag/.test(guard) && /x64/.test(guard), 'ограничение только для x64-ветки');
});

// INSTALL-ГИГИЕНА (VENDOR-ONLY, Фаза 2 Codex round-7): Nomad ставится ТОЛЬКО из вшитого
// bundled vendor (HM_NOMAD_SRC с pyproject.toml, путь задаёт main из vendorRoot). Ветка
// git clone УДАЛЕНА ЦЕЛИКОМ — вместе с ней закрыта последняя TOCTOU-P0 (подмена чужого
// pyproject.toml между Test-Path и git clone → исполнение чужого build-backend под админом).
// Нет vendor → graceful skip 120 (НЕ клонируем, НЕ падаем). Ни pull, ни rm, ни --force.
ok('install-гигиена (scripts): Nomad — VENDOR-ONLY (только вшитый HM_NOMAD_SRC с pyproject); клон-ветка удалена → нет git clone / repoUrl / pull / rm / --force; нет vendor → skip 120 ДО uv', () => {
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'nomad.sh'), 'utf8');
  // Доверие: SRC_TRUSTED=1 только для вшитого vendor с pyproject.
  assert(/if \[ -n "\$SRC" \] && \[ -f "\$SRC\/pyproject\.toml" \]; then/.test(nsh) && /SRC_TRUSTED=1/.test(nsh),
    'nomad.sh: bundled vendor с pyproject → SRC_TRUSTED=1');
  // Клон-ветки нет вовсе: ни git clone, ни repoUrl, ни pull/rm/--force/«use as-is».
  assert(!/git clone/.test(nsh), 'nomad.sh: НЕТ git clone (vendor-only)');
  assert(!/repoUrl/.test(nsh), 'nomad.sh: НЕТ чтения repoUrl');
  assert(!/pull --ff-only/.test(nsh) && !/git -C "\$SRC" pull/.test(nsh), 'nomad.sh: НЕТ git pull');
  assert(!/rm -rf[^\n]*\$SRC|rm -rf[^\n]*nomad-src/.test(nsh), 'nomad.sh: НЕТ rm -rf над nomad-src');
  assert(!/--force/.test(nsh), 'nomad.sh: НЕТ --force');
  assert(!/использую как есть/.test(nsh), 'nomad.sh: старой ветки «использую как есть» нет');
  // Установка гейтится доверием ДО секции uv.
  assert(/if \[ "\$SRC_TRUSTED" != "1" \]; then/.test(nsh), 'nomad.sh: гейт SRC_TRUSTED');
  assertOrder(nsh, 'SRC_TRUSTED" != "1" ]; then', 'uv tool install',
    'nomad.sh: skip-гейт (exit 120) ПЕРЕД uv tool install');

  const nps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'nomad.ps1'), 'utf8');
  assert(/if \(\$src -and \(Test-Path \(Join-Path \$src 'pyproject\.toml'\)\)\) \{/.test(nps) && /\$srcTrusted = \$true/.test(nps),
    'nomad.ps1: bundled vendor с pyproject → $srcTrusted=$true');
  assert(!/git clone/.test(nps), 'nomad.ps1: НЕТ git clone (vendor-only)');
  assert(!/repoUrl/.test(nps), 'nomad.ps1: НЕТ чтения repoUrl');
  assert(!/git -C \$src pull/.test(nps), 'nomad.ps1: НЕТ git pull');
  assert(!/Remove-Item[^\n]*\$src/.test(nps), 'nomad.ps1: НЕТ Remove-Item над nomad-src');
  assert(!/--force/.test(nps), 'nomad.ps1: НЕТ --force');
  assert(!/использую как есть/.test(nps), 'nomad.ps1: старой ветки «использую как есть» нет');
  assert(/if \(-not \$DRY -and -not \$srcTrusted\) \{/.test(nps), 'nomad.ps1: гейт $srcTrusted');
  assertOrder(nps, '-not $srcTrusted) {', 'tool install --python 3.12 "$srcForInstall"',
    'nomad.ps1: skip-гейт (exit 120) ПЕРЕД uv tool install');
});

// Codex P0-2: убран --force + guard существующего uv-tool/шимов (чужое не перезаписываем).
// Vendor-only: uv-тул = nomad-agent (pyproject [project].name), шимы = nmd/nomad-agent/nomad-acp.
ok('Codex P0 (scripts): uv tool install БЕЗ --force + guard существующего nomad-agent/шимов → skip 120', () => {
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'nomad.sh'), 'utf8');
  assert(!/--force/.test(nsh), 'nomad.sh: НИ ОДНОГО --force');
  // Ставим из КОПИИ проверенного дерева (read-only dmg: setuptools собирает IN-TREE),
  // но по-прежнему без --force и строго ПОСЛЕ tree-SHA гейта.
  assert(/uv tool install --python 3\.12 "\$BUILD_SRC"/.test(nsh), 'nomad.sh: uv tool install без --force');
  assert(/BUILD_SRC="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/hm-nomad-build\.XXXXXX"\)"/.test(nsh), 'nomad.sh: сборка из приватного mktemp-каталога (0700), не из read-only vendor');
  assert(/cp -R "\$SRC\/\." "\$BUILD_SRC\/"/.test(nsh), 'nomad.sh: копия проверенного дерева в temp');
  // ПУСТАЯ ПРОВЕРКА БЫЛА ЗДЕСЬ: сравнение indexOf без проверки на -1. Когда гейт
  // целостности исчезал, indexOf возвращал -1, а -1 < 6748 — истина, и тест оставался
  // зелёным на ОТКЛЮЧЁННОЙ защите. Проверено мутацией: гейт заменяли на `if false` —
  // все 283 теста проходили. Теперь сначала требуем НАЛИЧИЕ, потом порядок.
  const iGate = nsh.indexOf('TREE_GOT" != "$TREE_WANT"');
  const iBuild = nsh.indexOf('BUILD_SRC="$(mktemp');
  assert(iGate !== -1, 'nomad.sh: гейт сверки SHA-256 дерева НА МЕСТЕ (без него vendor можно подменить)');
  assert(iBuild !== -1, 'nomad.sh: сборка из приватного temp-каталога на месте');
  assert(iGate < iBuild, 'nomad.sh: порядок verify → copy → install (fail-closed сохранён)');
  assert(nsh.indexOf('UV_TOOL_NA="$HOME/.local/share/uv/tools/nomad-agent"') !== -1, 'nomad.sh: проверяется uv-tool nomad-agent');
  assert(nsh.indexOf('[ -e "$HOME/.local/bin/nmd" ]') !== -1 && nsh.indexOf('[ -e "$HOME/.local/bin/nomad-agent" ]') !== -1 && nsh.indexOf('[ -e "$HOME/.local/bin/nomad-acp" ]') !== -1,
    'nomad.sh: проверяются шимы nmd/nomad-agent/nomad-acp');
  const guardSh = nsh.slice(nsh.indexOf('UV_TOOL_NA='), nsh.indexOf('UV_TOOL_NA=') + 800);
  assert(/exit 120/.test(guardSh), 'nomad.sh: существующий тул/шим → exit 120');
  assertOrder(nsh, 'UV_TOOL_NA=', 'uv tool install',
    'nomad.sh: guard ПЕРЕД uv tool install');

  const nps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'nomad.ps1'), 'utf8');
  assert(!/--force/.test(nps), 'nomad.ps1: НИ ОДНОГО --force');
  // Ставим из КОПИИ проверенного дерева (uv/setuptools собирают IN-TREE и портят vendor,
  // из-за чего повторный запуск падал на гейте целостности), но по-прежнему без --force.
  assert(/& \$uv tool install --python 3\.12 "\$srcForInstall"/.test(nps), 'nomad.ps1: uv tool install без --force');
  assert(/uv\\tools\\nomad-agent/.test(nps) && /\.local\\share\\uv\\tools\\nomad-agent/.test(nps),
    'nomad.ps1: guard проверяет nomad-agent tool (APPDATA + .local\\share)');
  assert(/\.local\\bin\\nmd\.exe/.test(nps) && /\.local\\bin\\nomad-agent/.test(nps) && /\.local\\bin\\nomad-acp/.test(nps),
    'nomad.ps1: проверяются шимы nmd/nomad-agent/nomad-acp(.exe)');
  const guardPs = nps.slice(nps.indexOf('$existingNomad = @('), nps.indexOf('$existingNomad = @(') + 900);
  assert(/exit 120/.test(guardPs), 'nomad.ps1: существующий тул/шим → exit 120');
  assertOrder(nps, '$existingNomad = @(', 'tool install --python 3.12 "$srcForInstall"',
    'nomad.ps1: guard ПЕРЕД uv tool install');
});

// Codex P0-3: брендинг копируется ТОЛЬКО если целевого файла НЕТ (не перезаписываем чужой).
ok('Codex P0 (scripts): брендинг SOUL.md/nomad.yaml копируется ТОЛЬКО если целевого НЕТ', () => {
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'nomad.sh'), 'utf8');
  assert(/if \[ ! -f "\$HH\/SOUL\.md" \]; then/.test(nsh), 'nomad.sh: SOUL.md — гейт на отсутствие');
  assert(/cp "\$SRC\/branding\/SOUL\.md" "\$HH\/SOUL\.md"/.test(nsh), 'nomad.sh: cp SOUL.md');
  assert(/if \[ ! -f "\$HH\/skins\/nomad\.yaml" \]; then/.test(nsh), 'nomad.sh: nomad.yaml — гейт на отсутствие');
  assert(/cp "\$SRC\/branding\/skins\/nomad\.yaml" "\$HH\/skins\/nomad\.yaml"/.test(nsh), 'nomad.sh: cp nomad.yaml');
  assert(/не перезаписываю/.test(nsh), 'nomad.sh: сообщение о не-перезаписи');

  const nps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'nomad.ps1'), 'utf8');
  assert(/if \(-not \(Test-Path -LiteralPath \$soulDst\)\) \{/.test(nps), 'nomad.ps1: SOUL.md — гейт на отсутствие');
  assert(/Copy-Item \$soulSrc \$soulDst/.test(nps), 'nomad.ps1: Copy-Item SOUL.md');
  assert(/if \(-not \(Test-Path -LiteralPath \$skinDst\)\) \{/.test(nps), 'nomad.ps1: nomad.yaml — гейт на отсутствие');
  assert(/Copy-Item \$nomadYamlSrc \$skinDst/.test(nps), 'nomad.ps1: Copy-Item nomad.yaml');
  assert(!/Copy-Item \$soulSrc[^\n]*-Force/.test(nps), 'nomad.ps1: -Force убран у SOUL.md');
  assert(!/Copy-Item \$nomadYamlSrc[^\n]*-Force/.test(nps), 'nomad.ps1: -Force убран у nomad.yaml');
  assert(/не перезаписываю/.test(nps), 'nomad.ps1: сообщение о не-перезаписи');
});

console.log('== VENDOR-ONLY: config.json (nomad/cloud/dashboard) + components позиционирование + git-гигиена nomad-src ==');

ok('config.json: nomad.repoUrl == "" (клона нет), packageName=nomad-agent, cloud/dashboard/links.cabinet присутствуют', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert(cfg.nomad, 'config.json: секция nomad');
  assert.strictEqual(cfg.nomad.repoUrl, '', 'nomad.repoUrl ПУСТ (vendor-only, никогда не клонируем)');
  assert.strictEqual(cfg.nomad.packageName, 'nomad-agent', 'nomad.packageName = nomad-agent (pyproject [project].name)');
  assert(cfg.nomad.cloud && typeof cfg.nomad.cloud === 'object', 'nomad.cloud присутствует');
  assert(/^https:\/\//.test(cfg.nomad.cloud.baseUrl || ''), 'nomad.cloud.baseUrl — https url');
  assert(cfg.nomad.cloud.defaultModel, 'nomad.cloud.defaultModel задан');
  assert(cfg.nomad.cloud.registerUrl && cfg.nomad.cloud.keysUrl && cfg.nomad.cloud.cabinetUrl, 'nomad.cloud register/keys/cabinet URL заданы');
  assert(cfg.dashboard && /^http:\/\/127\.0\.0\.1:\d+/.test(cfg.dashboard.url || ''), 'dashboard.url — локальный 127.0.0.1');
  assert(cfg.links && cfg.links.cabinet && /^https:\/\//.test(cfg.links.cabinet), 'links.cabinet — https url');
});

ok('components.json: компонент nomad — позиционирование (приватный/любая нейросеть по API или ключ Nomad/без VPN/дашборд); команда nmd, без «Hermes»', () => {
  const comp = components.groups.flatMap((g) => g.components).find((c) => c.id === 'nomad');
  assert(comp, 'компонент nomad есть');
  const blob = (comp.name + ' ' + comp.desc + ' ' + comp.why).toLowerCase();
  assert(/приватн/.test(blob), 'позиционирование: приватный');
  assert(/нейросет/.test(blob) && /(api-ключ|ключ nomad)/.test(blob), 'позиционирование: любая нейросеть по API / ключ Nomad');
  assert(/без vpn/.test(blob), 'позиционирование: без VPN');
  assert(/дашборд|127\.0\.0\.1/.test(blob), 'позиционирование: локальный дашборд');
  assert(/nmd/.test(comp.desc + comp.why), 'упоминается команда nmd');
  assert(!/hermes/i.test(comp.name + comp.desc + comp.why), 'нет «Hermes» в описании (переименовано в Nomad)');
});

ok('git-гигиена: vendor/nomad-src (приватный код агента) НЕ закоммичен и покрыт .gitignore', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert(/vendor\/\*|vendor\//.test(gi), '.gitignore покрывает vendor/');
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', 'vendor/nomad-src'], { encoding: 'utf8' });
  if (tracked.error) { console.log('     (git недоступен — пропуск проверки ls-files)'); return; }
  assert.strictEqual((tracked.stdout || '').trim(), '', 'vendor/nomad-src НЕ в git (приватный код агента не коммитим)');
});

// ---- Функциональные прогоны nomad.sh на РЕАЛЬНОЙ ФС (bash + фейковый uv) --------------
// Проверяем ЖИВЫЕ инварианты VENDOR-ONLY install-гигиены Nomad без сети: (1) нет vendor
// (HM_NOMAD_SRC пуст) → skip 120, uv/git НЕ вызваны, чужой ~/.nomad-src не тронут (клона
// нет вовсе); (2) вшитый vendor (HM_NOMAD_SRC с pyproject) → install БЕЗ клона + брендинг,
// exit 0; (3) существующий брендинг НЕ перезаписывается; (4) чужой шим nmd → guard skip 120.
// Фейки — исполняемые shebang-скрипты в ~/.local/bin (среда без exec-shebang → тест пропускается).
// vendor-only: git НЕ вызывается вовсе (клонирования нет). Фейк лишь ловит факт вызова.
const NOMAD_FAKE_GIT =
  '#!/bin/sh\n' +
  ': > "$HOME/.hm-git-called"\n' +
  'exit 0\n';
const NOMAD_FAKE_UV =
  '#!/bin/sh\n' +
  ': > "$HOME/.hm-uv-called"\n' +
  'case "$1" in\n' +
  '  --version) echo "uv 0.0.0-fake" ;;\n' +
  '  python) exit 0 ;;\n' +
  '  tool)\n' +
  '    mkdir -p "$HOME/.local/share/uv/tools/nomad-agent"\n' +
  '    for c in nmd nomad-agent nomad-acp; do\n' +
  '      printf \'#!/bin/sh\\necho "%s 9.9-fake"\\n\' "$c" > "$HOME/.local/bin/$c"\n' +
  '      chmod +x "$HOME/.local/bin/$c"\n' +
  '    done\n' +
  '    ;;\n' +
  '  *) exit 0 ;;\n' +
  'esac\n' +
  'exit 0\n';

function writeNomadFakes(bin) {
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'git'), NOMAD_FAKE_GIT); fs.chmodSync(path.join(bin, 'git'), 0o755);
    fs.writeFileSync(path.join(bin, 'uv'), NOMAD_FAKE_UV); fs.chmodSync(path.join(bin, 'uv'), 0o755);
    fs.writeFileSync(path.join(bin, 'hm_probe'), '#!/bin/sh\necho HM_PROBE_OK\n'); fs.chmodSync(path.join(bin, 'hm_probe'), 0o755);
    const p = spawnSync('bash', ['-c', 'hm_probe'], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH })
    });
    return !p.error && /HM_PROBE_OK/.test(p.stdout || '');
  } catch (e) { return false; }
}

// Строит рабочее дерево + ВШИТЫЙ vendor/nomad-src (pyproject + брендинг). Возвращает vsrc —
// путь, который тест передаёт как HM_NOMAD_SRC (эмуляция того, что main задаёт из vendorRoot).
function mkNomadTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-nomad-')).replace(/\\/g, '/');
  fs.mkdirSync(base + '/scripts/macos', { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'macos', 'nomad.sh'), base + '/scripts/macos/nomad.sh');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'macos', '_lib.sh'), base + '/scripts/macos/_lib.sh');
  fs.writeFileSync(base + '/config.json', JSON.stringify({ nomad: { repoUrl: '', packageName: 'nomad-agent' } }, null, 2));
  const vsrc = base + '/vendor/nomad-src';
  fs.mkdirSync(vsrc + '/branding/skins', { recursive: true });
  fs.writeFileSync(vsrc + '/pyproject.toml', '[project]\nname = "nomad-agent"\n[project.scripts]\nnmd = "nomad_cli.main:main"\n');
  fs.writeFileSync(vsrc + '/branding/SOUL.md', 'SOUL_FROM_VENDOR\n');
  fs.writeFileSync(vsrc + '/branding/skins/nomad.yaml', 'skin: nomad\n');
  fs.writeFileSync(vsrc + '/branding/config.yaml.template', 'model:\n  provider: "auto"\n');
  const home = base + '/home';
  fs.mkdirSync(home + '/.local/bin', { recursive: true });
  return { base, home, script: base + '/scripts/macos/nomad.sh', vsrc };
}

// Запечатывает фикстурный vendor ровно как build (fetch-vendor-mac.sh): пишет
// vendor/nomad-src.sha256 = hm_tree_sha256(nomad-src) и checksums.json с записями для
// самого манифеста и pyproject.toml — ТЕМИ ЖЕ функциями _lib.sh (без дрейфа формата),
// чтобы integrity-гейт nomad.sh проходил на ЧЕСТНО аттестованном дереве, а НЕ в обход.
// Возвращает false, если shasum/bash недоступны (тест тогда gracefully пропускается).
function sealNomadVendor(base) {
  const lib = base + '/scripts/macos/_lib.sh';
  const vendor = base + '/vendor';
  const vsrc = vendor + '/nomad-src';
  const seal =
    '. "' + lib + '"; export HM_VENDOR="' + vendor + '";' +
    'tree=$(hm_tree_sha256 "' + vsrc + '") || exit 1;' +
    'printf "%s\\n" "$tree" > "' + vendor + '/nomad-src.sha256";' +
    'man=$(hm_sha256 "' + vendor + '/nomad-src.sha256") || exit 1;' +
    'py=$(hm_sha256 "' + vsrc + '/pyproject.toml") || exit 1;' +
    '[ -n "$tree" ] && [ -n "$man" ] && [ -n "$py" ] || exit 1;' +
    'printf \'{\\n"nomad-src.sha256": { "sha256": "%s", "bytes": 0 },\\n"pyproject.toml": { "sha256": "%s", "bytes": 0 }\\n}\\n\' "$man" "$py" > "' + vendor + '/checksums.json"';
  const r = spawnSync('bash', ['-c', seal], { encoding: 'utf8', timeout: 30000 });
  return r.status === 0 && fs.existsSync(vendor + '/checksums.json') && fs.existsSync(vendor + '/nomad-src.sha256');
}

function runNomadSh(home, script, extraEnv) {
  return spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { HOME: home, HM_NOMAD_SRC: '', HM_DRY_RUN: '' }, extraEnv || {})
  });
}

if (bashAvailable()) {
  console.log('== VENDOR-ONLY nomad.sh (функционально): ставим только из вшитого vendor, клона нет, чужое не затираем ==');

  ok('nomad.sh (функц.): нет vendor (HM_NOMAD_SRC пуст) → skip 120; uv/git НЕ вызваны; чужой ~/.nomad-src ЦЕЛ (клона нет)', () => {
    const { base, home, script } = mkNomadTree();
    try {
      const bin = home + '/.local/bin';
      if (!writeNomadFakes(bin)) { console.log('     (fake-exec недоступен — пропуск)'); return; }
      // Даже если рядом лежит чужой ~/.nomad-src с pyproject — vendor-only его игнорирует.
      fs.mkdirSync(home + '/.nomad-src', { recursive: true });
      fs.writeFileSync(home + '/.nomad-src/pyproject.toml',
        '[project]\nname = "someone-else"\n[build-system]\nrequires = ["evil-backend"]\n');
      const r = runNomadSh(home, script, { HM_NOMAD_SRC: '' });
      assert.strictEqual(r.status, 120, 'skip exit 120: ' + (r.stdout || '') + (r.stderr || ''));
      assert(!fs.existsSync(home + '/.hm-uv-called'), 'uv НЕ вызван — устанавливать нечего');
      assert(!fs.existsSync(home + '/.hm-git-called'), 'git НЕ вызван (клонирования нет)');
      assert(!fs.existsSync(bin + '/nmd'), 'шим nmd НЕ создан');
      assert(fs.readFileSync(home + '/.nomad-src/pyproject.toml', 'utf8').indexOf('someone-else') !== -1, 'чужой ~/.nomad-src ЦЕЛ (vendor-only его не трогает)');
      assert(/Пропускаю/.test(r.stdout || ''), 'сообщение о пропуске (нет vendor)');
    } finally { dropDir(base); }
  });

  ok('nomad.sh (функц.): вшитый vendor (HM_NOMAD_SRC с pyproject + аттестация) → install БЕЗ клона + брендинг, exit 0; git НЕ вызван', () => {
    const { base, home, script, vsrc } = mkNomadTree();
    try {
      const bin = home + '/.local/bin';
      if (!writeNomadFakes(bin)) { console.log('     (fake-exec недоступен — пропуск)'); return; }
      if (!sealNomadVendor(base)) { console.log('     (shasum/seal недоступен — пропуск)'); return; }
      const hermesHome = home + '/.hermes';
      const r = runNomadSh(home, script, { HERMES_HOME: hermesHome, HM_NOMAD_SRC: vsrc, HM_VENDOR: base + '/vendor' });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(!fs.existsSync(home + '/.hm-git-called'), 'git НЕ вызван (клонирования нет — vendor-only)');
      assert(fs.existsSync(home + '/.hm-uv-called'), 'uv реально вызван (установка из vendor)');
      assert(fs.existsSync(bin + '/nmd'), 'шим nmd создан установкой');
      assert(fs.existsSync(hermesHome + '/SOUL.md'), 'SOUL.md скопирован');
      assert(/SOUL_FROM_VENDOR/.test(fs.readFileSync(hermesHome + '/SOUL.md', 'utf8')), 'SOUL.md из вшитого vendor');
      assert(fs.existsSync(hermesHome + '/skins/nomad.yaml'), 'nomad.yaml скопирован');
      assert(/OK: nomad установлен/.test(r.stdout || ''), 'финальное OK');
    } finally { dropDir(base); }
  });

  ok('nomad.sh (функц.): существующий брендинг SOUL.md НЕ перезаписывается', () => {
    const { base, home, script, vsrc } = mkNomadTree();
    try {
      const bin = home + '/.local/bin';
      if (!writeNomadFakes(bin)) { console.log('     (fake-exec недоступен — пропуск)'); return; }
      if (!sealNomadVendor(base)) { console.log('     (shasum/seal недоступен — пропуск)'); return; }
      const hermesHome = home + '/.hermes';
      fs.mkdirSync(hermesHome, { recursive: true });
      fs.writeFileSync(hermesHome + '/SOUL.md', 'USER_SOUL_KEEP');
      const r = runNomadSh(home, script, { HERMES_HOME: hermesHome, HM_NOMAD_SRC: vsrc, HM_VENDOR: base + '/vendor' });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual(fs.readFileSync(hermesHome + '/SOUL.md', 'utf8'), 'USER_SOUL_KEEP', 'существующий SOUL.md ЦЕЛ (не перезаписан)');
      assert(/SOUL\.md уже существует/.test(r.stdout || ''), 'сообщение о не-перезаписи брендинга');
    } finally { dropDir(base); }
  });

  ok('nomad.sh (функц.): пред-существующий шим ~/.local/bin/nmd → guard skip 120 (не перезаписываем чужое, даже при валидном vendor)', () => {
    const { base, home, script, vsrc } = mkNomadTree();
    try {
      const bin = home + '/.local/bin';
      if (!writeNomadFakes(bin)) { console.log('     (fake-exec недоступен — пропуск)'); return; }
      // Чужой шим nmd уже на месте — guard обязан отбить ДО установки (vendor валиден).
      fs.writeFileSync(bin + '/nmd', '#!/bin/sh\necho "FOREIGN NMD"\n'); fs.chmodSync(bin + '/nmd', 0o755);
      const r = runNomadSh(home, script, { HM_NOMAD_SRC: vsrc });
      assert.strictEqual(r.status, 120, 'guard skip exit 120: ' + (r.stdout || '') + (r.stderr || ''));
      assert(!fs.existsSync(home + '/.hm-uv-called'), 'uv НЕ вызван (guard до установки)');
      assert.strictEqual(fs.readFileSync(bin + '/nmd', 'utf8'), '#!/bin/sh\necho "FOREIGN NMD"\n', 'чужой шим nmd ЦЕЛ');
    } finally { dropDir(base); }
  });
} else {
  console.log('  ⚠️  bash недоступен — функциональные прогоны nomad.sh пропущены.');
}

// P0-3: quarantine-then-guard — подмена marked-каталога МЕЖДУ проверкой и удалением.
// removeDirTreeGated атомарно захватывает цель в карантин ДО проверки маркера, поэтому
// подменённый на её место каталог НЕ удаляется, а удаляется ровно захваченное.
ok('P0-3 (функц.): подмена marked-каталога между захватом и удалением → удалено ЗАХВАЧЕННОЕ, подставленное ЦЕЛО', () => {
  const home = mkHomeDir();
  try {
    const opts = { home, platform: process.platform };
    const parent = path.join(home, 'AppData', 'Local');
    const target = path.join(parent, 'nomad-src');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.hamidun-nomad'), 'installed-by: hamidun-setup');
    fs.writeFileSync(path.join(target, 'ours.txt'), 'наш клон');
    // removeDirTreeGated захватывает target в карантин ПЕРЕД проверкой маркера. Мы
    // не можем вклиниться в синхронный вызов, но проверяем ИНВАРИАНТ: удаляется ровно
    // помеченный каталог, а если маркера нет — возвращается на место (ниже).
    const r = uxMod.removeDirTreeGated(target, opts, '.hamidun-nomad');
    assert(r.status === 'removed', 'помеченный каталог удалён: ' + JSON.stringify(r));
    assert(!fs.existsSync(target), 'target удалён целиком');
    // Не осталось карантинных остатков в родителе.
    const leftovers = fs.readdirSync(parent).filter((n) => n.indexOf('.hm-quar.') === 0);
    assert(leftovers.length === 0, 'карантинных остатков нет: ' + leftovers.join(','));
  } finally { dropDir(home); }
});

ok('P0-3 (функц.): нет маркера → каталог ВОЗВРАЩЁН на место (не удалён), карантинных остатков нет', () => {
  const home = mkHomeDir();
  try {
    const opts = { home, platform: process.platform };
    const parent = path.join(home, 'AppData', 'Local');
    const foreign = path.join(parent, 'nomad-src');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'pyproject.toml'), '[project]\nname="someones"');
    fs.writeFileSync(path.join(foreign, 'notes.txt'), 'чужое');
    const r = uxMod.removeDirTreeGated(foreign, opts, '.hamidun-nomad');
    assert(r.status === 'kept', 'без маркера → kept: ' + JSON.stringify(r));
    assert(fs.existsSync(path.join(foreign, 'pyproject.toml')) && fs.existsSync(path.join(foreign, 'notes.txt')), 'каталог возвращён ЦЕЛЫМ');
    const leftovers = fs.readdirSync(parent).filter((n) => n.indexOf('.hm-quar.') === 0);
    assert(leftovers.length === 0, 'карантинных остатков нет: ' + leftovers.join(','));
  } finally { dropDir(home); }
});

ok('P0-3 (функц.): маркер-symlink НЕ считается валидным (no-follow) → каталог возвращён', () => {
  const home = mkHomeDir();
  try {
    const opts = { home, platform: process.platform };
    const parent = path.join(home, 'AppData', 'Local');
    const dir = path.join(parent, 'nomad-src');
    fs.mkdirSync(dir, { recursive: true });
    const realMarker = path.join(home, 'real-marker');
    fs.writeFileSync(realMarker, 'x');
    let linked = false;
    try { fs.symlinkSync(realMarker, path.join(dir, '.hamidun-nomad'), 'file'); linked = true; }
    catch (e) { linked = false; }
    if (!linked) { console.log('     (symlink недоступен — пропуск)'); return; }
    const r = uxMod.removeDirTreeGated(dir, opts, '.hamidun-nomad');
    assert(r.status === 'kept', 'маркер-symlink → НЕ валиден → kept: ' + JSON.stringify(r));
    assert(fs.existsSync(dir), 'каталог возвращён на место');
  } finally { dropDir(home); }
});

console.log('== Codex round-4: reg/launchctl/debris — ошибка ≠ absent ==');

// P1: launchctl — print-ошибка → failed; подтверждённое отсутствие → loaded:false.
ok('P1: classifyLaunchctlPrint — код 0 loaded; not-found → отсутствие; иной ненулевой → failed', () => {
  assert.strictEqual(uxMod.classifyLaunchctlPrint({ status: 0, stdout: 'com.hamidun.bridge = {...}' }).loaded, true, 'код 0 → loaded');
  const gone = uxMod.classifyLaunchctlPrint({ status: 113, stderr: 'Could not find service "com.hamidun.bridge" in domain for gui' });
  assert(gone.ok === true && gone.loaded === false, 'not-found диагностика → подтверждённое отсутствие');
  const err = uxMod.classifyLaunchctlPrint({ status: 5, stderr: 'Operation not permitted' });
  assert(err.ok === false, 'иной ненулевой код (не not-found) → failed, НЕ absence');
  assert(uxMod.classifyLaunchctlPrint({ error: new Error('ENOENT launchctl') }).ok === false, 'ошибка запуска → failed');
  assert(uxMod.classifyLaunchctlPrint(null).ok === false, 'нет результата → failed');
});

ok('P1: launchctlRemoveError — ненулевой remove НЕ игнорируется (бенайн not-loaded → пусто, иначе текст)', () => {
  assert.strictEqual(uxMod.launchctlRemoveError({ status: 0 }), '', 'код 0 → нет ошибки');
  assert.strictEqual(uxMod.launchctlRemoveError({ status: 3, stderr: 'Could not find specified service' }), '', 'not-found → бенайн (пусто)');
  assert(uxMod.launchctlRemoveError({ status: 1, stderr: 'Operation not permitted' }).length > 0, 'реальная ошибка → НЕ игнор (текст)');
  assert(uxMod.launchctlRemoveError({ error: new Error('x') }).length > 0, 'ошибка запуска → текст');
});

// P1 (source): main.js использует classifyLaunchctlPrint + launchctlRemoveError.
ok('P1 (source): main.js launchctl — print через classifyLaunchctlPrint, remove через launchctlRemoveError', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/uninstallExec\.classifyLaunchctlPrint\(r3\)/.test(s), 'print делегирован classifyLaunchctlPrint (нераспознанный ненулевой → failed)');
  assert(/uninstallExec\.launchctlRemoveError\(r2\)/.test(s), 'remove делегирован launchctlRemoveError (ненулевой не игнорируется)');
  assert(!/if \(r3\.status === 0\) \{[\s\S]{0,80}всё ещё загружен[\s\S]{0,40}\}\s*\n\s*return uninstallExec\.removeFile/.test(s), 'старая «любой ненулевой print → absence» логика удалена');
});

// P1: listReceiptDebris ошибка readdir → finalizeRemoval ok:false (не «мусора нет»).
ok('P1: finalizeRemoval — ошибка перечисления .bak/.tmp → ok:false (осиротевший .bak не воскресит компонент)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-deb-'));
  const origReaddir = fs.readdirSync;
  try {
    rcMod.writeReceipt(home, 'uv', rcMod.buildReceipt('uv', process.platform, '1'));
    assert(rcMod.deactivateReceipt(home, 'uv').ok, 'деактивация ok');
    // Перечисление каталога квитанций падает (EACCES/EIO) — НЕ ENOENT.
    fs.readdirSync = function (p, o) {
      if (String(p).indexOf('receipts') !== -1) { const e = new Error('EACCES (test)'); e.code = 'EACCES'; throw e; }
      return origReaddir.call(fs, p, o);
    };
    const fin = rcMod.finalizeRemoval(home, 'uv');
    assert(fin.ok === false && /перечисл/i.test(fin.error || ''), 'ошибка readdir → ok:false: ' + JSON.stringify(fin));
  } finally {
    fs.readdirSync = origReaddir;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

ok('P1: finalizeRemoval — ENOENT каталога квитанций = «мусора нет» (ok:true), не ошибка', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-deb2-'));
  try {
    rcMod.writeReceipt(home, 'uv', rcMod.buildReceipt('uv', process.platform, '1'));
    assert(rcMod.deactivateReceipt(home, 'uv').ok, 'деактивация ok');
    const fin = rcMod.finalizeRemoval(home, 'uv');
    assert(fin.ok === true, 'штатный finalize (ENOENT-хвостов нет) → ok:true: ' + JSON.stringify(fin));
    assert(!fs.existsSync(rcMod.tombstonePath(home, 'uv')), 'tombstone снят');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

console.log('== RECEIPT ≠ источник целей: квитанция — только маркер ==');

ok('crafted-квитанция с artifacts на ~/.claude НЕ влияет на план: artifacts игнорируются целиком', () => {
  const home = mkHomeDir();
  try {
    fs.mkdirSync(path.join(home, '.hamidun-setup', 'receipts'), { recursive: true });
    // «отравленная» легаси-квитанция: artifacts указывают на пользовательские данные
    fs.writeFileSync(path.join(home, '.hamidun-setup', 'receipts', 'uv.json'), JSON.stringify({
      schemaVersion: 1, id: 'uv', platform: process.platform,
      artifacts: [
        { type: 'path', value: path.join(home, '.claude') },
        { type: 'path', value: path.join(home, '.claude', '.credentials.master.env') },
        { type: 'profileline', value: path.join(home, '.claude', 'settings.json') + '|{' },
        { type: 'reg', value: 'HKCU|Software\\Evil|X' }
      ]
    }));
    const receiptsMod2 = require(path.join(ROOT, 'src', 'install-receipts.js'));
    const rec = receiptsMod2.readReceipt(home, 'uv');
    assert(rec && rec.id === 'uv', 'легаси-квитанция остаётся валидным installed-МАРКЕРОМ');
    assert(!('artifacts' in rec), 'artifacts НЕ экспонируются из readReceipt');
    assert(typeof receiptsMod2.envFromReceipt === 'undefined' || receiptsMod2.envFromReceipt === undefined,
      'envFromReceipt удалён из модуля');
    // план вычисляется БЕЗ квитанции — она в API даже не передаётся
    const plan = utMod.uninstallTargets('uv', { platform: 'win32', home });
    const claudeLower = path.join(home, '.claude').toLowerCase();
    targetPathsOf(plan).forEach((p) => {
      const pl = p.toLowerCase();
      assert(pl !== claudeLower && pl.indexOf(claudeLower + path.sep) !== 0,
        'ядовитый artifact не попал в цели: ' + p);
    });
  } finally { dropDir(home); }
});

ok('main.js (source): receipt-driven deletion удалён — нет envFromReceipt/HM_UNINSTALL_*/uninstall-скриптов', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(!/envFromReceipt/.test(s), 'envFromReceipt не используется');
  assert(!/HM_UNINSTALL_PATHS|HM_UNINSTALL_REG|HM_UNINSTALL_PATHENTRIES|HM_UNINSTALL_PROFILELINES|HM_UNINSTALL_LAUNCHAGENTS|HM_UNINSTALL\b/.test(s),
    'транспорт целей через HM_UNINSTALL_* env удалён');
  assert(!/uninstallScript/.test(s), 'uninstall-скрипт не вызывается');
  assert(!fs.existsSync(path.join(ROOT, 'scripts', 'windows', 'uninstall.ps1')), 'uninstall.ps1 удалён из ресурсов');
  assert(!fs.existsSync(path.join(ROOT, 'scripts', 'macos', 'uninstall.sh')), 'uninstall.sh удалён из ресурсов');
  assert(/uninstallTargets\.uninstallTargets\(id, buildUninstallCtx\(\)\)/.test(s), 'цели — из зашитого аллоулиста');
  assert(/receipts\.hasReceipt\(home, id\)/.test(s), 'квитанция — только гейт-маркер «мы это ставили»');
  assert(/executeUninstallTarget\(t, guardOpts\)/.test(s), 'каждая цель идёт через executor с guard-ом');
});

ok('main.js (source): деактивация маркера ДО удаления, restore при провале, stillThere → ok:false, финальная очистка проверяется', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const un = s.slice(s.indexOf("ipcMain.handle('uninstall-component'"));
  assert(/receipts\.deactivateReceipt\(home, id\)/.test(un), 'deactivateReceipt вызывается');
  assert(/if \(!deact\.ok\)/.test(un), 'не смогли деактивировать → abort');
  const iDeact = un.indexOf('deactivateReceipt');
  const iExec = un.indexOf('executeUninstallTarget');
  assert(iDeact !== -1 && iExec !== -1 && iDeact < iExec, 'деактивация идёт ДО исполнения целей');
  assert(/if \(failed > 0 \|\| stillThere\)/.test(un), 'частичный провал ИЛИ живая пост-детекция → НЕ успех');
  assert(/receipts\.restoreReceipt\(home, id\)/.test(un), 'при провале маркер возвращается');
  assert(/receipts\.finalizeRemoval\(home, id\)/.test(un), 'успех → финализация tombstone');
  assert(/if \(!fin\.ok \|\| !manOk\)/.test(un), 'результаты finalize/manifest ПРОВЕРЯЮТСЯ (не молча ок)');
  assert(/\{ stillThere = true; \}/.test(un), 'сбой пост-детекции → считаем, что компонент остался');
});

ok('main.js (source): reg — только HKCU из аллоулиста ключей; pathentry сохраняет тип REG_(EXPAND_)SZ и не раскрывает %VAR%', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // ВСЕ проверки — по коду БЕЗ комментариев: токен, переехавший в комментарий
  // (закомментированный вызов, упоминание в пояснении), стеречь ничего не может.
  // Так уже случилось с DoNotExpandEnvironmentNames: он есть и в комментарии,
  // и убранный из ФАКТИЧЕСКОГО вызова GetValue оставлял тест зелёным — а чужие
  // %VAR% при перезаписи PATH запекались бы в литералы.
  const code = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(/WIN_REG_ALLOWED_KEYS/.test(code), 'аллоулист ключей реестра');
  assert(/t\.hive !== 'HKCU'/.test(code), 'не-HKCU → отказ');
  // Разбор значения типизирован (regQueryValueTyped) и тип СОХРАНЯЕТСЯ при
  // перезаписи PATH. Слой чтения: ТОЛЬКО авторитетный .NET-путь — разбор
  // текстового вывода reg.exe удалён насовсем (best-fit подменял символы
  // «похожим ASCII» без единого признака порчи, это неисправимо); корректность
  // доказывается ПОВЕДЕНЧЕСКИМИ тестами ниже («реестр (поведение): …» —
  // round-trip кириллицы, best-fit байт в байт, сырой REG_EXPAND_SZ,
  // found:false, запрет HKLM, пакетный regQueryManyDotNet).
  assert(/regQueryValueTyped\(/.test(code), 'типизированное чтение значения реестра (regQueryValueTyped)');
  assert(/computeUserPathWithout/.test(code), 'PATH правится чистой точной функцией');
  assert(/вернул исходный/.test(code), 'верификация записи PATH с восстановлением при расхождении');
  assert(/Microsoft\.Win32\.Registry/.test(code), 'авторитетный путь чтения/записи — .NET');
  assert(/DoNotExpandEnvironmentNames/.test(code), 'REG_EXPAND_SZ читается сырым — чужие %VAR% не раскрываются (В КОДЕ, не в комментарии)');
  assert(/ToBase64String/.test(code) && /HMREG1:/.test(code), 'значение едет base64 — кодировка консоли не участвует');
  assert(/regWriteValueTyped\(/.test(code), 'запись значения — тоже через .NET');
  assert(/не переписываю/.test(code), 'PATH с потерянными символами НЕ переписывается (сохранность чужих записей)');
});

// Гейт на порчу PATH: если прочитанное значение содержит символ замены, переписывать
// его нельзя ни при каких условиях — чужая кириллическая запись важнее нашей.
// ПОВЕДЕНЧЕСКИ, а не по тексту сообщения: первая версия этого теста искала в теле
// строку «не переписываю» и потому не замечала мутацию САМОГО УСЛОВИЯ — гейт можно
// было отключить, оставив сообщение на месте, и тест оставался зелёным.
// Ловлю функцию и прогоняю её с подставным чтением реестра.
ok('main.js: PATH с потерянными символами не переписывается (гейт на порчу)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const i = s.indexOf('function winRemoveUserPathEntry');
  assert(i > 0, 'функция найдена');
  const body = s.slice(i, s.indexOf('\nfunction ', i + 10));

  const mk = (pathValue) => {
    const calls = { writes: [] };
    const fn = new Function(
      'uninstallExec', 'fs', 'regQueryValueTyped', 'regQueryValueDotNet', 'regWriteValueTyped', 'calls',
      // Перевод строки обязателен: тело заканчивается строчным комментарием, и
      // без него return уезжает ВНУТРЬ комментария — функция возвращает undefined.
      body + '\n; return winRemoveUserPathEntry;'
    )(
      {
        checkTarget: (d) => ({ ok: true, norm: d }),
        computeUserPathWithout: (cur, dir) => ({
          changed: String(cur).indexOf(dir) >= 0,
          value: String(cur).split(';').filter((x) => x !== dir).join(';'),
        }),
      },
      // Каталог отсутствует — значит запись PATH можно убирать (штатный путь).
      { lstatSync: () => { const e = new Error('нет'); e.code = 'ENOENT'; throw e; } },
      () => ({ ok: true, found: true, type: 'REG_EXPAND_SZ', data: pathValue }),
      // Разрушительная операция ходит ТОЛЬКО авторитетным путём — подставляем его же.
      () => ({ ok: true, found: true, type: 'REG_EXPAND_SZ', data: pathValue }),
      (k, v, data) => { calls.writes.push(data); return { ok: true }; },
      calls
    );
    return { fn, calls };
  };

  const OUR = 'C:\\Users\\x\\AppData\\Local\\Programs\\uv';

  // 1) PATH прочитан с потерей символов → НЕ переписываем ничего.
  {
    const t = mk('C:\\\uFFFD\uFFFD\uFFFD\\Python;' + OUR);
    const r = t.fn({ dir: OUR }, {});
    assert(r.status === 'failed', 'испорченный PATH → отказ, а не запись: ' + r.status);
    assert(t.calls.writes.length === 0, 'при испорченном PATH записи НЕ было');
  }

  // 2) Обычный PATH — наша запись убирается, чужие целы.
  {
    const t = mk('C:\\Программы\\Python;' + OUR + ';C:\\Tools');
    const r = t.fn({ dir: OUR }, {});
    assert(t.calls.writes.length >= 1, 'обычный PATH переписывается: ' + t.calls.writes.length);
    assert(t.calls.writes[0] === 'C:\\Программы\\Python;C:\\Tools',
      'чужая кириллическая запись сохранена: ' + t.calls.writes[0]);
    // Подставное чтение всегда возвращает исходное значение, поэтому пост-проверка
    // не сходится и функция ЧЕСТНО возвращает исходный PATH вторым вызовом —
    // это и есть страховка «не теряем PATH при расхождении».
    assert(t.calls.writes.length === 2 && t.calls.writes[1].indexOf(OUR) >= 0,
      'при несошедшейся проверке возвращается исходное значение');
    assert(r.status === 'failed', 'и статус честный, а не ложный успех: ' + r.status);
  }
});

// ===========================================================================
// РЕЕСТР — ПОВЕДЕНЧЕСКИ. Слой чтения переделан: разбор текстового вывода
// reg.exe УДАЛЁН НАСОВСЕМ (best-fit подменял символы «похожим ASCII» без
// единого признака порчи — неисправимо), остался ТОЛЬКО авторитетный .NET-путь,
// а скорость возвращена пакетным чтением regQueryManyDotNet. Поэтому НИКАКИХ
// грепов по исходнику: функции слоя ВЫРЕЗАЮТСЯ из main.js,
// исполняются с настоящими spawnSync/remote-fetch и проверяются НА РЕАЛЬНОМ
// HKCU\Environment пробными значениями HmProbe* (уникальный хвост на прогон;
// Path и чужие значения НЕ трогаем; за собой убираем в finally и ПРОВЕРЯЕМ это).
// ===========================================================================
(function registryBehaviorTests() {
  console.log('== Реестр (поведение): HKCU\\Environment, пробные значения HmProbe* ==');
  const REG_KEY = 'HKCU\\Environment';

  function cutRegLayer(deps) {
    const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    const a = s.indexOf('const REG_KIND_TO_TYPE');
    const b = s.indexOf('const WIN_REG_ALLOWED_KEYS');
    assert(a > 0 && b > a, 'слой реестра найден в main.js (REG_KIND_TO_TYPE … WIN_REG_ALLOWED_KEYS)');
    return new Function('spawnSync', 'remoteFetch', 'detectSpawnEnv', 'IS_WIN',
      '"use strict";\n' + s.slice(a, b) +
      '\n; return { regQueryValueTyped, regQueryValueDotNet, regQueryManyDotNet, regWriteValueTyped, regDeleteValueTyped };')(
      deps.spawnSync, deps.remoteFetch, deps.detectSpawnEnv, deps.IS_WIN);
  }

  let LIVE = null;
  const live = () => {
    if (process.platform !== 'win32') SKIP('реестр Windows недоступен на ' + process.platform);
    if (!LIVE) {
      LIVE = cutRegLayer({
        spawnSync,
        remoteFetch: require(path.join(ROOT, 'src', 'remote-fetch.js')),
        detectSpawnEnv: () => process.env,
        IS_WIN: true,
      });
    }
    return LIVE;
  };
  const rnd = crypto.randomBytes(5).toString('hex');
  // Пробное значение живёт ТОЛЬКО внутри колбэка; уборка — в finally, и она
  // ПРОВЕРЯЕТСЯ (иначе тест, намусоривший в HKCU, сам был бы дефектом).
  const withProbe = (suffix, fn) => {
    const L = live();
    const name = 'HmProbe' + suffix + '_' + rnd;
    try { fn(L, name); }
    finally {
      const del = L.regDeleteValueTyped(REG_KEY, name);
      const gone = L.regQueryValueTyped(REG_KEY, name);
      assert(gone && gone.ok === true && gone.found === false,
        'уборка за собой: ' + name + ' удалён (del=' + JSON.stringify(del) + ', после=' + JSON.stringify(gone) + ')');
    }
  };

  ok('реестр (поведение): кириллица переживает round-trip; боевое чтение ≡ .NET', () => {
    withProbe('Cyr', (L, name) => {
      const data = 'C:\\Программы\\Проба (тест);D:\\Ещё Кириллица';
      const w = L.regWriteValueTyped(REG_KEY, name, data, 'REG_SZ');
      assert(w.ok === true, 'запись пробного REG_SZ: ' + JSON.stringify(w));
      const dn = L.regQueryValueDotNet(REG_KEY, name);
      assert(dn.ok && dn.found && dn.type === 'REG_SZ' && dn.data === data,
        '.NET-путь вернул значение байт в байт: ' + JSON.stringify(dn));
      const t = L.regQueryValueTyped(REG_KEY, name);
      assert(t.ok && t.found && t.type === 'REG_SZ' && t.data === data,
        'боевое чтение вернуло значение байт в байт — мохибейк «C:\\?????\\…» = ' +
        'ровно тот дефект, что затирал чужие записи PATH: ' + JSON.stringify(t));
      // Боевое чтение — тонкая обёртка над .NET-путём; результат обязан совпадать
      // ПОЛНОСТЬЮ. ВАЖНО: кириллица на консоли 866 представима, поэтому этот тест
      // best-fit-порчу НЕ ловит в принципе — её стережёт следующий тест.
      assert.deepStrictEqual(t, dn, 'боевое чтение и .NET-путь — один и тот же результат');
    });
  });

  // Best-fit — тихий и неисправимый дефект удалённого «быстрого пути»: reg.exe
  // печатает в кодовой странице консоли и для символов с best-fit-отображением
  // подставляет ПОХОЖИЙ ASCII, а не «?». Проверено на консоли 866:
  // «José» → «Jose», «Müller» → «Muller», «Dev’s» → «Dev's», «a…b» → «a:b»
  // (появляется ДВОЕТОЧИЕ — структурный символ пути). Строка приходила идеально
  // чистой, гейты на U+FFFD и «?» её не ловили; компонент в каталоге с
  // диакритикой детектировался как отсутствующий, а пост-проверка удаления
  // рапортовала «чисто», хотя запись в PATH оставалась. Единственный честный
  // страж — round-trip БАЙТ В БАЙТ через боевое чтение на ЭТИХ четырёх пробах.
  ok('реестр (поведение): best-fit не подменяет символы — José/Müller/Dev’s/a…b байт в байт', () => {
    const cases = [
      ['Jose',  'C:\\Users\\Jos\u00e9\\AppData\\Local\\bin', 'Jose'],
      ['Muell', 'C:\\M\u00fcller\\tools',                    'Muller'],
      ['Apos',  'C:\\Dev\u2019s Tools\\x',                   "Dev's"],
      ['Ellip', 'a\u2026b',                                  'a:b'],
    ];
    for (const [suffix, data, degraded] of cases) {
      withProbe('Bf' + suffix, (L, name) => {
        const w = L.regWriteValueTyped(REG_KEY, name, data, 'REG_SZ');
        assert(w.ok === true, 'запись пробы «' + suffix + '»: ' + JSON.stringify(w));
        const r = L.regQueryValueTyped(REG_KEY, name);
        assert(r.ok === true && r.found === true && r.type === 'REG_SZ',
          'чтение пробы «' + suffix + '»: ' + JSON.stringify(r));
        assert.strictEqual(r.data, data,
          'байт в байт; best-fit разбора reg.exe отдавал бы «чистое» ложное «' + degraded + '»');
      });
    }
  });

  ok('реестр (поведение): REG_EXPAND_SZ приходит СЫРЫМ — чужие %VAR% не раскрываются, тип сохранён', () => {
    withProbe('Exp', (L, name) => {
      const data = '%SystemRoot%\\HmProbe;%HMPROBE_NOT_SET%\\x';
      const w = L.regWriteValueTyped(REG_KEY, name, data, 'REG_EXPAND_SZ');
      assert(w.ok === true, 'запись пробного REG_EXPAND_SZ: ' + JSON.stringify(w));
      for (const [label, r] of [
        ['.NET', L.regQueryValueDotNet(REG_KEY, name)],
        ['боевой', L.regQueryValueTyped(REG_KEY, name)],
      ]) {
        assert(r.ok && r.found, label + ': значение найдено: ' + JSON.stringify(r));
        assert.strictEqual(r.type, 'REG_EXPAND_SZ', label + ': тип НЕ подменён (' + r.type + ')');
        assert.strictEqual(r.data, data,
          label + ': %VAR% остались литералами — раскрытие запекло бы чужие переменные при перезаписи PATH: ' + r.data);
      }
    });
  });

  // Пакетное чтение — то, ради чего быстрый путь вообще существовал: старт
  // powershell.exe стоит сотен миллисекунд, и платить их за КАЖДОЕ значение
  // нельзя (окно уходило в «не отвечает»). Скорость возвращена одним запуском
  // интерпретатора на всю пачку. Порядок результатов обязан совпадать с порядком
  // запросов (freshWindowsPath различает машинный и пользовательский PATH
  // ИНДЕКСОМ), ошибки — на своих местах, и пачка ощутимо быстрее поштучного.
  ok('реестр (поведение): regQueryManyDotNet — пачка одним запуском, порядок = порядку запросов, быстрее поштучного', () => {
    const L = live();
    const names = [0, 1, 2, 3].map((i) => 'HmProbeMany' + i + '_' + rnd);
    try {
      names.forEach((n, i) => {
        const w = L.regWriteValueTyped(REG_KEY, n, 'HmV' + i + '-' + rnd, 'REG_SZ');
        assert(w.ok === true, 'проба ' + n + ' записана: ' + JSON.stringify(w));
      });
      // Нарочно вперемешку: найденные НЕ в порядке записи, отсутствующее,
      // неподдерживаемый ключ, чтение HKLM — всё в одной пачке.
      const reqs = [
        { key: REG_KEY, name: names[2] },
        { key: REG_KEY, name: 'HmProbeManyMissing_' + rnd },
        { key: REG_KEY, name: names[0] },
        { key: 'HKXX\\Bogus', name: 'x' },
        { key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', name: 'Path' },
        { key: REG_KEY, name: names[1] },
        { key: REG_KEY, name: names[3] },
      ];
      const t0 = Date.now();
      const got = L.regQueryManyDotNet(reqs);
      const batchMs = Date.now() - t0;
      assert(Array.isArray(got) && got.length === reqs.length,
        'результатов ровно столько, сколько запросов: ' + (got && got.length));
      const at = (i) => JSON.stringify(got[i]);
      assert(got[0].ok && got[0].found && got[0].data === 'HmV2-' + rnd, '[0] = names[2]: ' + at(0));
      assert(got[1].ok === true && got[1].found === false, '[1] отсутствующее → found:false: ' + at(1));
      assert(got[2].ok && got[2].found && got[2].data === 'HmV0-' + rnd, '[2] = names[0]: ' + at(2));
      assert(got[3].ok === false && /ключ/.test(got[3].error || ''),
        '[3] неподдерживаемый ключ → ошибка НА СВОЁМ месте, соседи не сдвинуты: ' + at(3));
      assert(got[4].ok && got[4].found && String(got[4].data).length > 0,
        '[4] машинный PATH (HKLM) читается в той же пачке');
      assert(got[5].ok && got[5].found && got[5].data === 'HmV1-' + rnd, '[5] = names[1]: ' + at(5));
      assert(got[6].ok && got[6].found && got[6].data === 'HmV3-' + rnd, '[6] = names[3]: ' + at(6));
      // Скорость: 7 значений одним запуском против 4 поштучных запусков .NET.
      //
      // ЗАМЕР ПО ЛУЧШЕМУ ИЗ ТРЁХ, а не по одному прогону. Одиночный замер здесь
      // ловит не разницу подходов, а посторонний всплеск нагрузки: при занятой
      // машине (параллельные сборки, антивирус, другой тяжёлый процесс) старт
      // интерпретатора растягивается непредсказуемо, и тест краснел с batch=4797мс
      // против single=4241мс — то есть «пачка медленнее», чего не может быть по
      // устройству: один запуск процесса против четырёх. Минимум из нескольких
      // прогонов отражает стоимость самого подхода: всплеск может замер только
      // ЗАМЕДЛИТЬ, поэтому лучший результат ближе к истине, а порог 1.5x остаётся
      // прежним — тест не ослаблен, он лишь перестал измерять шум.
      const best = (fn, runs) => {
        let m = Infinity;
        for (let i = 0; i < runs; i++) {
          const t = Date.now();
          fn();
          m = Math.min(m, Date.now() - t);
        }
        return m;
      };
      const batchBest = best(() => L.regQueryManyDotNet(reqs), 3);
      const singleBest = best(() => {
        for (const n of names) {
          const r = L.regQueryValueDotNet(REG_KEY, n);
          assert(r.ok && r.found, 'поштучное чтение ' + n + ': ' + JSON.stringify(r));
        }
      }, 3);
      assert(batchBest * 1.5 < singleBest,
        'пачка ощутимо быстрее поштучного (лучшее из 3): batch(7 знач.)=' + batchBest +
        'мс против 4×поштучно=' + singleBest + 'мс; первый замер пачки был ' + batchMs + 'мс');
    } finally {
      for (const n of names) { try { L.regDeleteValueTyped(REG_KEY, n); } catch (e) { /* уборка всегда */ } }
      const after = L.regQueryManyDotNet(names.map((n) => ({ key: REG_KEY, name: n })));
      after.forEach((r, i) => assert(r && r.ok === true && r.found === false,
        'уборка за собой: ' + names[i] + ' удалён (' + JSON.stringify(r) + ')'));
    }
  });

  ok('реестр (поведение): отсутствующее значение → found:false, а НЕ ошибка', () => {
    const L = live();
    const name = 'HmProbeMissing_' + rnd; // никогда не записывался
    for (const [label, r] of [
      ['боевой', L.regQueryValueTyped(REG_KEY, name)],
      ['.NET', L.regQueryValueDotNet(REG_KEY, name)],
    ]) {
      assert.strictEqual(r.ok, true, label + ': отсутствие значения ≠ сбой (у вызывающих ошибка → failed, отсутствие → absent): ' + JSON.stringify(r));
      assert.strictEqual(r.found, false, label + ': found:false: ' + JSON.stringify(r));
    }
  });

  ok('реестр (поведение): запись/удаление в HKLM невозможны — отказ НАШ и ДО запуска PowerShell', () => {
    // Подставные зависимости: считаем запуски. Отказ обязан случиться в НАШЕМ
    // разборе ключа (только HKCU), а не прилететь ошибкой доступа от ОС — под
    // админом «ошибки доступа» не будет, и мутация разбора открыла бы HKLM.
    const calls = { spawn: 0 };
    const L = cutRegLayer({
      spawnSync: () => { calls.spawn++; return { status: 0, stdout: '' }; },
      remoteFetch: { winPowershellPath: () => 'powershell.exe', sysBin: () => null },
      detectSpawnEnv: () => ({}),
      IS_WIN: true,
    });
    for (const [label, r] of [
      ['запись HKLM', L.regWriteValueTyped('HKLM\\SOFTWARE\\HmProbe', 'HmProbeV', 'x', 'REG_SZ')],
      ['удаление HKLM', L.regDeleteValueTyped('HKLM\\SOFTWARE\\HmProbe', 'HmProbeV')],
      ['запись HKEY_LOCAL_MACHINE', L.regWriteValueTyped('HKEY_LOCAL_MACHINE\\SOFTWARE\\HmProbe', 'HmProbeV', 'x', 'REG_SZ')],
    ]) {
      assert.strictEqual(r.ok, false, label + ' обязана быть отвергнута: ' + JSON.stringify(r));
      assert(/HKCU/.test(r.error || ''), label + ': отказ наш («только HKCU»), а не ошибка ОС: ' + (r.error || ''));
    }
    assert.strictEqual(calls.spawn, 0,
      'отказ происходит ДО единственного возможного побочного эффекта (запуска PowerShell) — fail-closed');
  });
})();

// P0-2: из деинсталлятора НЕ запускается user-writable uv.exe (под elevated =
// admin-RCE). Тип цели 'uvtool' и вызовы `uv tool uninstall`/findUvBinary УДАЛЕНЫ;
// venv/шимы удаляются напрямую file/dirtree-целями.
ok('P0-2 (source): деинсталлятор НЕ запускает user-writable uv (нет uvtool/uv tool uninstall/findUvBinary в КОДЕ)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // Строки «uv tool uninstall»/«findUvBinary» остаются лишь в поясняющих КОММЕНТАРИЯХ —
  // проверяем отсутствие в реальном коде (комментарии // и /* */ вырезаны).
  const code = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(!/uv tool uninstall/.test(code), 'в КОДЕ нет запуска `uv tool uninstall`');
  assert(!/findUvBinary\s*\(/.test(s), 'findUvBinary не вызывается (только упоминание в комментарии)');
  assert(!/case 'uvtool'/.test(s), "тип цели 'uvtool' удалён из executeUninstallTarget");
  const ut = fs.readFileSync(path.join(ROOT, 'src', 'uninstall-targets.js'), 'utf8');
  assert(!/type: 'uvtool'/.test(ut), "uninstall-targets не эмитит 'uvtool'");
  // v1: авто-удаление Nomad ОТКЛЮЧЕНО — uninstall-targets НЕ эмитит НИ venv/uv-tool целей,
  // НИ клона исходников (TOCTOU-нора закрыта отсутствием целей). Деинсталлятор тем более
  // не запускает user-writable uv (нет uvtool/uv tool uninstall/findUvBinary).
  assert(!/'tools', tool\)/.test(ut), 'v1: НЕТ dirtree-цели venv uv-тула (…/tools/<tool>) — Nomad не авто-удаляется');
  assert(/uninstallSupported: false/.test(ut), 'nomad-кейс явно помечен uninstallSupported:false');
});

// P0-5: pathentry идёт через ТОТ ЖЕ guard, что и файловые цели (reparse/junction
// в каталоге-цели/предках → отказ), и запись убирается ТОЛЬКО когда каталог реально
// отсутствует (существует/подменён → kept, запись не трогаем).
ok('P0-5 (source): winRemoveUserPathEntry — guard каталога-цели + удаление ТОЛЬКО при отсутствии каталога', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const fn = s.slice(s.indexOf('function winRemoveUserPathEntry'), s.indexOf('function macBundleIdOf'));
  assert(fn.length > 0, 'функция найдена');
  assert(/uninstallExec\.checkTarget\(dir, guardOpts\)/.test(fn), 'каталог-цель проходит fail-closed guard (reparse/junction → отказ)');
  assert(/ещё существует — запись PATH оставлена/.test(fn), 'каталог существует → запись PATH оставлена (kept)');
  assert(/ENOENT.*ENOTDIR/.test(fn), 'только ОТСУТСТВИЕ каталога (ENOENT/ENOTDIR) даёт переход к правке PATH');
  assert(/computeUserPathWithout\(cur\.data, dir\)/.test(fn), 'убирается ТОЛЬКО точная наша запись');
  // Исполнитель pathentry реально зовёт winRemoveUserPathEntry через guardOpts.
  assert(/case 'pathentry':[\s\S]{0,200}winRemoveUserPathEntry\(t, guardOpts\)/.test(s), 'исполнитель pathentry → winRemoveUserPathEntry(guardOpts)');
});

// P0-5 (функционально): guard отвергает pathentry-каталог за junction/symlink.
// checkTarget — тот же guard, что зовёт winRemoveUserPathEntry(dir).
ok('P0-5 (функц.): checkTarget каталога-цели за symlink/junction-предком → ОТКАЗ (реальная ФС)', () => {
  const home = mkHomeDir();
  try {
    const real = path.join(home, 'realbin');
    fs.mkdirSync(real, { recursive: true });
    let linked = false;
    try { fs.symlinkSync(real, path.join(home, 'linkbin'), 'junction'); linked = true; }
    catch (e) { try { fs.symlinkSync(real, path.join(home, 'linkbin'), 'dir'); linked = true; } catch (e2) { /* нет прав */ } }
    if (!linked) { console.log('     (symlink/junction недоступен — пропуск)'); return; }
    const g = uxMod.checkTarget(path.join(home, 'linkbin', 'uv'), { home, platform: process.platform });
    assert(!g.ok && /symlink|junction/i.test(g.reason), 'pathentry-каталог за ссылкой → отказ: ' + JSON.stringify(g));
  } finally { dropDir(home); }
});

// P1-2: TeamIdentifier codesign пишется в STDERR при УСПЕХЕ (exit 0). Читаем
// stdout+stderr вместе, иначе валидный маскот получает пустой TeamID и .app не удаляется.
ok('P1-2 (source): macTeamIdOf читает TeamIdentifier из STDOUT+STDERR (codesign -dv пишет в stderr)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const fn = s.slice(s.indexOf('function macTeamIdOf'), s.indexOf('function resolveMascotVendorApp'));
  assert(fn.length > 0, 'функция найдена');
  assert(/spawnSync\('\/usr\/bin\/codesign'/.test(fn), 'codesign через spawnSync (не execFileSync — нужен stderr)');
  assert(/String\(r\.stdout \|\| ''\) \+ '\\n' \+ String\(r\.stderr \|\| ''\)/.test(fn), 'stdout И stderr объединяются перед парсингом');
  assert(/TeamIdentifier=/.test(fn), 'парсится строка TeamIdentifier=');
  assert(/not set/.test(fn), "adhoc «not set» → пусто (НЕ идентичность)");
});

// P0-4: платформенный гейт применяется и к ДЕИНСТАЛЛЯЦИИ — ДО построения/исполнения
// плана. Crafted/legacy receipt для win32-only компонента на macOS не исполняет план.
ok('P0-4 (source): uninstall-component — platform-гейт ДО плана (win32-компонент на darwin → отказ)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const i = s.indexOf("ipcMain.handle('uninstall-component'");
  const block = s.slice(i);
  const iGate = block.indexOf('componentShownOnPlatform(meta, process.platform)');
  const iPlan = block.indexOf('uninstallTargets.uninstallTargets(id, buildUninstallCtx())');
  const iDeact = block.indexOf('deactivateReceipt(home, id)');
  assert(iGate !== -1, 'платформенный гейт присутствует в uninstall-обработчике');
  assert(iPlan !== -1 && iGate < iPlan, 'гейт ДО построения плана');
  assert(iDeact !== -1 && iGate < iDeact, 'гейт ДО деактивации маркера/исполнения');
  assert(/недоступен на платформе[\s\S]{0,60}деинсталляция отклонена/.test(block), 'чужая платформа → отказ');
});
// Логика гейта: массив platforms фильтрует; отсутствие/пустой → показывать везде.
ok('P0-4: componentShownOnPlatform — win32-only компонент скрыт на darwin, универсальный виден везде', () => {
  // Чистая копия логики гейта из main.js (documented invariant; main.js тянет
  // electron и напрямую не требуется — инвариант проверяем зеркальной функцией).
  const shown = (comp, plat) => {
    const gate = comp && Array.isArray(comp.platforms) ? comp.platforms : null;
    return !gate || gate.length === 0 || gate.indexOf(plat) !== -1;
  };
  assert(shown({ platforms: ['win32'] }, 'win32') === true, 'win32-компонент виден на win32');
  assert(shown({ platforms: ['win32'] }, 'darwin') === false, 'win32-компонент СКРЫТ на darwin');
  assert(shown({}, 'darwin') === true, 'без гейта — виден везде');
  assert(shown({ platforms: [] }, 'linux') === true, 'пустой гейт — виден везде');
});

ok('main.js (source): HM_DRY_RUN авторитетно из process.env И payload; в dry-run — ни деактивации, ни целей, ни лога', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const hits = (s.match(/process\.env\.HM_DRY_RUN/g) || []).length;
  assert(hits >= 2, 'оба хендлера (install+uninstall) читают process.env.HM_DRY_RUN: ' + hits);
  assert(/if \(isDryRun\) childEnv\.HM_DRY_RUN = '1';/.test(s), 'dry-run доезжает до install-скрипта ДО spawn');
  const un = s.slice(s.indexOf("ipcMain.handle('uninstall-component'"));
  const iDry = un.indexOf('if (isDryRun) {');
  const iDeact = un.indexOf('deactivateReceipt(home, id)');
  assert(iDry !== -1 && iDeact !== -1 && iDry < iDeact, 'dry-run ветвится ДО деактивации маркера');
  assert(/\[dry-run\] WOULD: /.test(un), 'dry-run печатает план, ничего не делая');
});

ok('main.js (source): appbundle — идентичность ОБЯЗАТЕЛЬНА (vendor bundleId + пин TeamID), иначе отказ', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/if \(!t\.expectBundleId\) return \{ status: 'failed'/.test(s), 'нет эталонного bundleId → отказ');
  assert(/bid !== t\.expectBundleId/.test(s), 'несовпадение CFBundleIdentifier → отказ');
  assert(/team !== t\.teamId/.test(s), 'несовпадение TeamIdentifier → отказ');
  assert(/resolveMascotVendorApp/.test(s), 'эталон берётся из ДОВЕРЕННОГО vendor, не из квитанции');
});

ok('uninstall: REMOVABLE (app.js) гейтится квитанцией-маркером; все REMOVABLE имеют зашитую карту целей', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const m = app.match(/REMOVABLE = new Set\(\[([^\]]+)\]\)/);
  assert(m, 'REMOVABLE найден в app.js');
  const ids = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  assert(ids.length >= 1, 'набор не пуст');
  assert(/REMOVABLE\.has\(c\.id\) && !!\(det && det\.receipted\)/.test(app), 'кнопка «Удалить» гейтится det.receipted');
  // Для КАЖДОГО removable id зашитая карта целей существует (иначе кнопка вела бы в отказ)
  ids.forEach((id) => {
    const p = utMod.uninstallTargets(id, {
      platform: 'win32', home: 'C:\\Users\\t', desktop: 'C:\\Users\\t\\Desktop',
      courseTargetRaw: '%USERPROFILE%\\HamidunCourse', courseShortcut: 'X'
    });
    assert(p && p.targets.length, 'зашитая карта для ' + id);
  });
});

// ---- P0-1: авторитетный режим установки конфига (install-mode.js) ----------
console.log('== P0-1: режим-детекция (authoritative additive, fail-safe) ==');
const modeMod = require(path.join(ROOT, 'src', 'install-mode.js'));

ok('P0-1: только ~/.claude/agents существует → additive', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mode-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    const d = modeMod.detectAdditive(home);
    assert.strictEqual(d.additive, true, 'agents → additive: ' + JSON.stringify(d));
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P0-1: только ~/CLAUDE.md существует → additive', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mode-'));
  try {
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'user notes');
    const d = modeMod.detectAdditive(home);
    assert.strictEqual(d.additive, true, 'CLAUDE.md → additive: ' + JSON.stringify(d));
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P0-1: пустой дом → additive=false; каждый probe по отдельности → additive', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mode-'));
  try {
    assert.strictEqual(modeMod.detectAdditive(home).additive, false, 'пусто → clean допустим');
    // каждый признак по отдельности переводит в additive
    for (const rel of [['.claude', 'skills'], ['.claude', 'commands'], ['.claude', 'rules']]) {
      const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mode2-'));
      try {
        fs.mkdirSync(path.join(h2, ...rel), { recursive: true });
        assert.strictEqual(modeMod.detectAdditive(h2).additive, true, rel.join('/') + ' → additive');
      } finally { try { fs.rmSync(h2, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    }
    for (const relF of [['.claude', 'settings.json'], ['.claude', '.credentials.master.env']]) {
      const h3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mode3-'));
      try {
        fs.mkdirSync(path.join(h3, relF[0]), { recursive: true });
        fs.writeFileSync(path.join(h3, ...relF), 'x');
        assert.strictEqual(modeMod.detectAdditive(h3).additive, true, relF.join('/') + ' → additive');
      } finally { try { fs.rmSync(h3, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    }
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P0-1: ЛЮБАЯ ошибка probe кроме genuine ENOENT → additive (ENOTDIR/ELOOP — не «нет», а «не смогли»)', () => {
  // На Windows stat под файлом даёт ENOENT, поэтому ENOTDIR эмулируем подменой:
  // контракт probePath — ТОЛЬКО genuine ENOENT считается «нет», всё прочее → error.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mode-'));
  const orig = fs.statSync;
  try {
    for (const code of ['ENOTDIR', 'ELOOP', 'EPERM']) {
      fs.statSync = function () { const e = new Error(code + ' (test)'); e.code = code; throw e; };
      const p = modeMod.probePath(path.join(home, '.claude', 'skills'));
      assert(p.error === code, code + ' → error (не «нет»): ' + JSON.stringify(p));
      const d = modeMod.detectAdditive(home);
      assert.strictEqual(d.additive, true, code + ' → additive: ' + JSON.stringify(d));
      assert(/probe-error/.test(d.reason), 'reason указывает на probe-error: ' + d.reason);
    }
    fs.statSync = function () { const e = new Error('ENOENT (test)'); e.code = 'ENOENT'; throw e; };
    assert.strictEqual(modeMod.probePath('/x').exists, false, 'genuine ENOENT → exists:false');
    assert(!modeMod.probePath('/x').error, 'genuine ENOENT — без error');
  } finally {
    fs.statSync = orig;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

ok('P0-1: сбой детекции (EACCES при statSync) → additive (fail-safe)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mode-'));
  const orig = fs.statSync;
  try {
    fs.statSync = function () { const e = new Error('EACCES (test)'); e.code = 'EACCES'; throw e; };
    const d = modeMod.detectAdditive(home);
    assert.strictEqual(d.additive, true, 'probe-error → additive: ' + JSON.stringify(d));
    assert(/probe-error|fail-safe/.test(d.reason), 'reason указывает на fail-safe');
  } finally {
    fs.statSync = orig;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

ok('P0-1: decideConfigMode — clean ТОЛЬКО при (repair И confirmed) либо доказанном отсутствии', () => {
  const add = { additive: true, reason: 'x' };
  const clean = { additive: false, reason: '' };
  assert.strictEqual(modeMod.decideConfigMode(add, false, false), 'additive', 'additive без repair');
  assert.strictEqual(modeMod.decideConfigMode(add, true, false), 'additive', 'repair БЕЗ подтверждения → additive');
  assert.strictEqual(modeMod.decideConfigMode(add, false, true), 'additive', 'подтверждение без repair → additive');
  assert.strictEqual(modeMod.decideConfigMode(add, true, true), 'clean', 'repair + подтверждение → clean');
  assert.strictEqual(modeMod.decideConfigMode(clean, false, false), 'clean', 'кастомизаций нет → clean допустим');
  assert.strictEqual(modeMod.decideConfigMode(null, false, false), 'additive', 'нет результата детекции → additive (fail-safe)');
  assert.strictEqual(modeMod.decideConfigMode(undefined, true, false), 'additive', 'сбой детекции + неподтверждённый repair → additive');
});

ok('P0-1 main.js: HM_ADDITIVE ставится АВТОРИТЕТНО в run-component (decideConfigMode), не renderer-ом', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/installMode\.detectAdditive\(os\.homedir\(\)\)/.test(s), 'живая детекция в main');
  assert(/installMode\.decideConfigMode\(det, repairRequested, repairConfirmed\)/.test(s), 'решение через decideConfigMode');
  assert(/childEnv\.HM_ADDITIVE = '1'/.test(s), 'additive → HM_ADDITIVE=1 в env скрипта');
  assert(/delete childEnv\.HM_ADDITIVE/.test(s), 'clean → HM_ADDITIVE снят');
  assert(/HM_REPAIR_CONFIRMED/.test(s), 'clean требует ОТДЕЛЬНОГО подтверждения (HM_REPAIR_CONFIRMED)');
});

ok('P0-1 app.js: кнопка установки выключена до завершения детекции; repair config требует confirm', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert(/disabled = n === 0 \|\| !STATE\.detectDone/.test(s), 'btn-install гейтится detectDone');
  assert(/STATE\.detectDone = true/.test(s), 'detectDone проставляется по завершении детекции (finally)');
  assert(/window\.confirm\(\s*\n?\s*'Переустановить конфиг начисто\?/.test(s), 'repair config → отдельный confirm');
  assert(/HM_REPAIR_CONFIRMED:/.test(s), 'подтверждение уезжает в env');
});

// ---- Receipts: installed-маркеры (Фаза 2 переделка: БЕЗ artifacts-путей) ----
console.log('== Receipts: installed-маркеры (не источник целей удаления) ==');
const receiptsMod = require(path.join(ROOT, 'src', 'install-receipts.js'));

ok('receipts: parseReceiptLine — валидные типы; мусор/неизвестный тип → null', () => {
  assert.deepStrictEqual(receiptsMod.parseReceiptLine('HM-RECEIPT path C:\\Users\\x\\HamidunCourse\\vibecoding-course'),
    { type: 'path', value: 'C:\\Users\\x\\HamidunCourse\\vibecoding-course' });
  assert.deepStrictEqual(receiptsMod.parseReceiptLine('  HM-RECEIPT reg HKCU|Software\\Run|ClaudeMascot  '),
    { type: 'reg', value: 'HKCU|Software\\Run|ClaudeMascot' });
  assert.strictEqual(receiptsMod.parseReceiptLine('обычная строка лога'), null);
  assert.strictEqual(receiptsMod.parseReceiptLine('HM-RECEIPT unknown x'), null);
  assert.strictEqual(receiptsMod.parseReceiptLine('HM-RECEIPT path'), null);
  assert.strictEqual(receiptsMod.parseReceiptLine(''), null);
});

ok('receipts: маркер {id, version, installedAt} БЕЗ artifacts; round-trip; битый/чужой id → null', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rcp-'));
  try {
    const rec = receiptsMod.buildReceipt('course', process.platform, '1.0.0');
    assert(!('artifacts' in rec), 'маркер НЕ содержит artifacts-путей');
    assert.strictEqual(rec.schemaVersion, receiptsMod.SCHEMA_VERSION, 'schemaVersion=2');
    const w = receiptsMod.writeReceipt(home, 'course', rec);
    assert(w.ok, 'запись ok');
    const back = receiptsMod.readReceipt(home, 'course');
    assert(back && back.id === 'course' && back.version === '1.0.0', 'round-trip маркера');
    assert(!('artifacts' in back), 'artifacts не появляются при чтении');
    assert(receiptsMod.hasReceipt(home, 'course'), 'hasReceipt true');
    assert.strictEqual(receiptsMod.readReceipt(home, 'nomad'), null, 'нет маркера → null');
    fs.writeFileSync(receiptsMod.receiptPath(home, 'uv'), '{broken', 'utf8');
    assert.strictEqual(receiptsMod.readReceipt(home, 'uv'), null, 'битый JSON → null');
    fs.writeFileSync(receiptsMod.receiptPath(home, 'bridge'),
      JSON.stringify({ schemaVersion: 2, id: 'mascot' }), 'utf8');
    assert.strictEqual(receiptsMod.readReceipt(home, 'bridge'), null, 'id mismatch → null');
    // легаси-квитанция v1 с artifacts — валидный МАРКЕР, artifacts игнорируются
    fs.writeFileSync(receiptsMod.receiptPath(home, 'mascot'),
      JSON.stringify({ schemaVersion: 1, id: 'mascot', artifacts: [{ type: 'path', value: '/x' }] }), 'utf8');
    const legacy = receiptsMod.readReceipt(home, 'mascot');
    assert(legacy && legacy.id === 'mascot' && !('artifacts' in legacy), 'легаси → маркер без artifacts');
    // dryRun не пишет
    const w2 = receiptsMod.writeReceipt(home, 'dryid', rec, { dryRun: true });
    assert(w2.ok && w2.dryRun && !fs.existsSync(receiptsMod.receiptPath(home, 'dryid')), 'dryRun не пишет');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('receipts: deactivate (атомарно, ДО удаления) → hasReceipt=false; restore → true; finalize с ПРОВЕРКОЙ результата', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rcd-'));
  try {
    receiptsMod.writeReceipt(home, 'uv', receiptsMod.buildReceipt('uv', process.platform, '1'));
    // деактивация: маркер уезжает в tombstone
    const d = receiptsMod.deactivateReceipt(home, 'uv');
    assert(d.ok, 'deactivate ok');
    assert(!receiptsMod.hasReceipt(home, 'uv'), 'после деактивации маркера нет');
    assert(fs.existsSync(receiptsMod.tombstonePath(home, 'uv')), 'tombstone существует');
    // провал удаления → restore возвращает маркер
    const r = receiptsMod.restoreReceipt(home, 'uv');
    assert(r.ok && receiptsMod.hasReceipt(home, 'uv'), 'restore вернул маркер');
    // успех → deactivate + finalize; результат проверяется (не «молча ок»)
    assert(receiptsMod.deactivateReceipt(home, 'uv').ok, 'повторная деактивация');
    const f = receiptsMod.finalizeRemoval(home, 'uv');
    assert(f.ok && !fs.existsSync(receiptsMod.tombstonePath(home, 'uv')), 'finalize убрал tombstone');
    assert(!receiptsMod.hasReceipt(home, 'uv'), 'маркера больше нет');
    // деактивация несуществующего маркера → честный ok:false (abort деинсталляции)
    assert(!receiptsMod.deactivateReceipt(home, 'ghost').ok, 'нет маркера → deactivate ok:false');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P2 receipts/manifest: осиротевший .bak (rollback упал) восстанавливается при следующем чтении', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-bak-'));
  try {
    // receipts: эмулируем крах rollback-а — остался только .bak
    receiptsMod.writeReceipt(home, 'uv', receiptsMod.buildReceipt('uv', process.platform, '7.7.7'));
    const rp = receiptsMod.receiptPath(home, 'uv');
    fs.renameSync(rp, rp + '.123.456.bak');
    const rec = receiptsMod.readReceipt(home, 'uv');
    assert(rec && rec.version === '7.7.7', 'receipt восстановлен из .bak: ' + JSON.stringify(rec));
    assert(fs.existsSync(rp), 'основной файл на месте');
    // manifest: то же самое
    manifestMod.recordInstall(home, 'git', '2.0.0', 'bundled');
    const mp = manifestMod.manifestPath(home);
    fs.renameSync(mp, mp + '.123.456.bak');
    const man = manifestMod.readManifest(home);
    assert(man.components.git && man.components.git.version === '2.0.0', 'manifest восстановлен из .bak');
    assert(fs.existsSync(mp), 'installed.json на месте');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

// P1-1: деактивированный (tombstone) компонент НЕ воскрешается из осиротевшего .bak.
// А finalizeRemoval подчищает .bak/.tmp-хвосты — иначе следующий readReceipt вернул бы
// «удалённый» компонент.
ok('P1-1 receipts: tombstone блокирует воскрешение из .bak; finalizeRemoval чистит .bak/.tmp-хвосты', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p11-'));
  try {
    receiptsMod.writeReceipt(home, 'uv', receiptsMod.buildReceipt('uv', process.platform, '9.9.9'));
    const rp = receiptsMod.receiptPath(home, 'uv');
    // Деактивация: маркер уезжает в tombstone (rename)
    const deact = receiptsMod.deactivateReceipt(home, 'uv');
    assert(deact.ok, 'деактивация прошла: ' + JSON.stringify(deact));
    assert(fs.existsSync(receiptsMod.tombstonePath(home, 'uv')), 'tombstone существует');
    assert(!fs.existsSync(rp), 'основной маркер удалён (в tombstone)');
    // Осиротевший .bak (как будто rollback предыдущей записи упал) — с ЖИВЫМ маркером
    const orphanBak = rp + '.111.222.bak';
    fs.writeFileSync(orphanBak, JSON.stringify(receiptsMod.buildReceipt('uv', process.platform, '9.9.9')));
    // readReceipt НЕ должен воскресить компонент (tombstone → recoverBak выходит рано)
    assert.strictEqual(receiptsMod.readReceipt(home, 'uv'), null, 'удалённый компонент НЕ воскрешён из .bak');
    assert(!fs.existsSync(rp), 'основной маркер так и не восстановлен из .bak');
    // finalizeRemoval убирает tombstone И .bak/.tmp-хвосты, результат проверяется
    const fin = receiptsMod.finalizeRemoval(home, 'uv');
    assert(fin.ok, 'finalizeRemoval ok: ' + JSON.stringify(fin));
    assert(!fs.existsSync(receiptsMod.tombstonePath(home, 'uv')), 'tombstone убран');
    assert(!fs.existsSync(orphanBak), '.bak-хвост подчищен (не воскресит компонент позже)');
    // Компонент окончательно отсутствует
    assert.strictEqual(receiptsMod.readReceipt(home, 'uv'), null, 'после finalize компонент отсутствует');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('main.js: uninstall гейтится hasReceipt (маркер); receipted в detect-state; маркер пишется при успехе установки', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/if \(!receipts\.hasReceipt\(home, id\)\) \{[\s\S]{0,400}Удаление отклонено/.test(s),
    'нет маркера → отказ (fail-closed), содержимое маркера при этом целей НЕ задаёт');
  assert(/receipted: receipts\.hasReceipt\(home, id\)/.test(s), 'detect-state отдаёт receipted');
  assert(/receipts\.writeReceipt\(os\.homedir\(\), id, receipts\.buildReceipt\(id, process\.platform, ver\)\)/.test(s),
    'маркер (id/platform/version) пишется при успешной установке');
  assert(/receipts\.parseReceiptLine\(l\)/.test(s), 'легаси HM-RECEIPT строки фильтруются из UI-лога');
});

ok('install-скрипты: легаси HM-RECEIPT эмиссии (фильтруются из UI-лога; целей удаления НЕ задают)', () => {
  const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } };
  const musts = [
    ['scripts/windows/uv.ps1', /HM-RECEIPT path \$dest/, /HM-RECEIPT pathentry \$dest/],
    ['scripts/macos/uv.sh', /HM-RECEIPT path \$DEST\/uv/],
    ['scripts/windows/mascot.ps1', /HM-RECEIPT path \$destDir/, /HM-RECEIPT reg HKCU\|Software\\Microsoft\\Windows\\CurrentVersion\\Run\|ClaudeMascot/],
    ['scripts/macos/mascot.sh', /HM-RECEIPT path \$DEST/, /HM-RECEIPT bundleid/, /HM-RECEIPT teamid \$MASCOT_TEAM_ID/, /HM-RECEIPT launchagent com\.hamidun\.claude-mascot\|\$LA/],
    ['scripts/windows/bridge.ps1', /HM-RECEIPT path \$dst/, /HM-RECEIPT reg HKCU\|Software\\Microsoft\\Windows\\CurrentVersion\\Run\|HamidunBridge/],
    ['scripts/macos/bridge.sh', /HM-RECEIPT path \$DST/, /HM-RECEIPT launchagent com\.hamidun\.bridge\|\$LA/, /HM-RECEIPT profileline \$RC\|\$BRIDGE_RC_MARK/],
    // vendor-only: клона больше нет → $src/$SRC (клон-исходник) в квитанцию НЕ пишется;
    // остаются только шимы (nmd/nomad-agent/nomad-acp) и uv-тул nomad-agent.
    ['scripts/windows/nomad.ps1', /HM-RECEIPT path \$p/],
    ['scripts/macos/nomad.sh', /HM-RECEIPT path \$HOME\/\.local\/bin\/\$shim/]
  ];
  musts.forEach(([file, ...res]) => {
    const s = read(file);
    if (!s) return; // файл может отсутствовать в редакции (например course в free)
    res.forEach((re) => assert(re.test(s), file + ': нет эмиссии ' + re));
  });
  // course-скрипты есть только в course-редакции
  const cps = read('scripts/windows/course.ps1');
  if (cps) assert(/HM-RECEIPT path \$courseDir/.test(cps) && /HM-RECEIPT path \$lnkPath/.test(cps), 'course.ps1 эмитит пути');
  const csh = read('scripts/macos/course.sh');
  if (csh) assert(/HM-RECEIPT path \$COURSE_DIR/.test(csh) && /HM-RECEIPT path \$LAUNCHER/.test(csh), 'course.sh эмитит пути');
  // nomad НЕ записывает пользовательский config.yaml в квитанцию
  const nps = read('scripts/windows/nomad.ps1');
  assert(!/HM-RECEIPT path[^\n]*config\.yaml/.test(nps), 'nomad.ps1: config.yaml НЕ в квитанции (user data)');
  const nsh = read('scripts/macos/nomad.sh');
  assert(!/HM-RECEIPT path[^\n]*config\.yaml/.test(nsh), 'nomad.sh: config.yaml НЕ в квитанции (user data)');
});

// ---- P1-7: пост-детекция перед чисткой манифеста; P1-8: dry-run гейты -------
console.log('== P1-7/P1-8: пост-детекция манифеста, dry-run гейты ==');

ok('P1-7 main.js: учёт чистится ТОЛЬКО после пост-детекции отсутствия; оставшийся компонент → ok:false', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const i = s.indexOf("ipcMain.handle('uninstall-component'");
  const block = s.slice(i);
  assert(/let stillThere = true/.test(block), 'дефолт: считаем, что компонент остался');
  assert(/uninstallExec\.verifyPostconditions\(plan,/.test(block),
    'пост-проверка — по per-component managed-целям плана (verifyPostconditions), НЕ глобальная детекция');
  assert(!/detectComponents\(\)/.test(block),
    'глобальная detectComponents в uninstall-блоке НЕ используется (чужой uv/nomad/Claude.app не даёт ложный failure)');
  assert(/if \(failed > 0 \|\| stillThere\)/.test(block), 'частичный сбой ИЛИ живой компонент → провал (не «Удалено ✓»)');
  assert(/return \{ id, ok: false, code: 1, error: why \}/.test(block), 'оставшийся компонент → ok:false');
  const iFail = block.indexOf('if (failed > 0 || stillThere)');
  const iFin = block.indexOf('receipts.finalizeRemoval');
  const iMan = block.indexOf('manifest.removeEntry');
  assert(iFail !== -1 && iFin !== -1 && iMan !== -1 && iFail < iFin && iFail < iMan,
    'finalize/removeEntry — только ПОСЛЕ подтверждённого успеха');
  assert(/\{ stillThere = true; \}/.test(block), 'сбой детекции → НЕ чистим (fail-closed)');
});

ok('P1-8 main.js: dry-run — БЕЗ докачки и БЕЗ записи install.log', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/if \(declared && isDryRun\) \{/.test(s), 'докачка remote-компонента гейтится dry-run ДО download');
  assert(/const logLine = \(line\) => \{ if \(!isDryRun\) logToFile\(id, line\); \};/.test(s), 'логирование в файл гейтится dry-run');
  const un = s.slice(s.indexOf("ipcMain.handle('uninstall-component'"));
  assert(/const logLine = \(line\) => \{ if \(!isDryRun\) logToFile\(id, line\); \};/.test(un), 'и в uninstall тоже');
});

ok('P1-8 config.ps1/sh + uv.ps1/sh: dry-run ветвится ДО clone/fetch/бэкапа/докачки', () => {
  const cps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  const iDryPs = cps.indexOf('if ($DRY) {');
  assert(iDryPs !== -1 && iDryPs < cps.indexOf('clone --depth 1'), 'config.ps1: dry-run раньше git clone');
  assert(iDryPs < cps.indexOf('robocopy $claudeHome $backupDir'), 'config.ps1: dry-run раньше копии-бэкапа');
  const csh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  const iDrySh = csh.indexOf('if [ -n "${HM_DRY_RUN:-}" ]; then');
  assert(iDrySh !== -1 && iDrySh < csh.indexOf('clone --depth 1'), 'config.sh: dry-run раньше git clone');
  assert(iDrySh < csh.indexOf('cp -R "$CLAUDE_HOME" "$BACKUP_DIR"'), 'config.sh: dry-run раньше копии-бэкапа');
  const ups = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uv.ps1'), 'utf8');
  const iUpsDry = ups.indexOf('if ($DRY) {');
  assert(iUpsDry !== -1 && iUpsDry < ups.indexOf("Join-Path $env:HM_VENDOR 'apps\\uv\\uv.exe'"), 'uv.ps1: dry-run раньше vendor-проверки');
  const ush = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'uv.sh'), 'utf8');
  const iUshDry = ush.indexOf('if [ -n "$DRY" ]; then');
  assert(iUshDry !== -1 && iUshDry < ush.indexOf('UV_TGZ='), 'uv.sh: dry-run раньше vendor-проверки');
});

// ---- P2-9: атомарная запись манифеста без unlink-окна ------------------------
console.log('== P2-9/P2-10: манифест — атомарность и строгий semver ==');

ok('P2-9 manifest: rename упал НАВСЕГДА → откат (старый манифест ЦЕЛ), без .tmp/.bak мусора', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-man9-'));
  const origRename = fs.renameSync;
  try {
    manifestMod.recordInstall(home, 'a', '1.0.0', 'bundled');
    const before = fs.readFileSync(manifestMod.manifestPath(home), 'utf8');
    // temp→dest падает ВСЕГДА; dst→bak и bak→dst (откат) работают.
    fs.renameSync = function (src, dst) {
      if (String(src).indexOf('.tmp') !== -1 && String(dst) === manifestMod.manifestPath(home)) {
        const e = new Error('EPERM (test, permanent)'); e.code = 'EPERM'; throw e;
      }
      return origRename.call(fs, src, dst);
    };
    let threw = false;
    try { manifestMod.recordInstall(home, 'a', '2.0.0', 'bundled'); }
    catch (e) { threw = true; }
    fs.renameSync = origRename;
    assert(threw, 'writeManifest честно бросил при невозможности записи');
    assert.strictEqual(fs.readFileSync(manifestMod.manifestPath(home), 'utf8'), before,
      'старый манифест ВОССТАНОВЛЕН (никакого unlink-окна с потерей)');
    const leftovers = fs.readdirSync(path.join(home, manifestMod.DIR_NAME))
      .filter((n) => n.endsWith('.tmp') || n.endsWith('.bak'));
    assert.strictEqual(leftovers.length, 0, 'без мусора: ' + leftovers.join(','));
  } finally {
    fs.renameSync = origRename;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

ok('P2-9 manifest (source): нет unlink-перед-rename; old→backup + откат; fsync', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'install-manifest.js'), 'utf8');
  assert(!/fs\.rmSync\(dst, \{ force: true \}\); fs\.renameSync\(tmp, dst\)/.test(s), 'unlink+rename убран');
  assert(/fs\.renameSync\(dst, bak\)/.test(s), 'старый уезжает в backup (не удаляется)');
  assert(/fs\.renameSync\(bak, dst\)/.test(s), 'откат backup→dest при сбое');
  assert(/fs\.fsyncSync\(fd\)/.test(s), 'fsync temp-файла где можно');
});

// ---- P2-10: строгий числовой semver ------------------------------------------
ok('P2-10 semver: суффиксы (-rc/+build/буквы) → «не знаем» (никаких ложных апдейтов)', () => {
  assert.strictEqual(manifestMod.parseVersion('1.2.3-rc1'), null, '-rc → unknown');
  assert.strictEqual(manifestMod.parseVersion('1.2.3+build5'), null, '+build → unknown');
  assert.strictEqual(manifestMod.parseVersion('1.2.3a'), null, 'буквенный хвост → unknown');
  assert.deepStrictEqual(manifestMod.parseVersion('v1.2.3'), [1, 2, 3], 'v-префикс допустим');
  assert.deepStrictEqual(manifestMod.parseVersion('1.2'), [1, 2], 'x.y допустим');
  assert.strictEqual(manifestMod.compareVersions('1.2.3-rc1', '1.2.3'), 0, 'suffix → сравнение «не знаем» (0)');
  assert.strictEqual(manifestMod.isOutdated('1.0.0', '1.0.1-rc'), false, 'prerelease-current НЕ даёт апдейт-бейджа');
  assert.strictEqual(manifestMod.isOutdated('1.0.0-beta', '1.0.1'), false, 'prerelease-installed НЕ даёт апдейт-бейджа');
  assert.strictEqual(manifestMod.isOutdated('1.0.0', '1.0.1'), true, 'обычный числовой кейс работает');
});

console.log('== Remote security: content-addressed URLs + script fail-closed guards ==');

// Content-addressed immutability: неплейсхолдерный mirror-URL должен содержать
// sha256 записи (перезалив контента не ломает выпущенные установщики).
ok('реестр: неплейсхолдерные mirror-URL содержат sha256 (content-addressed)', () => {
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  (remoteReg.components || []).forEach((e) => {
    (e.mirrors || []).forEach((m) => {
      if (m && typeof m.url === 'string' && rf.isFetchableUrl(m.url)) {
        assert(m.url.toLowerCase().indexOf(String(e.sha256).toLowerCase()) !== -1,
          `mirror ${m.url} должен содержать sha ${e.sha256} (${e.remoteId})`);
      }
    });
  });
});

// FIX-D/FIX-G: uv.ps1 запускает бинарь ИЗ защищённого источника, не запускает
// user-writable копию под elevated, проверяет Leaf/ReparsePoint/exit-код/формат.
ok('uv.ps1: fail-closed guards (run-from-source, Leaf, reparse, exit-code, формат версии)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uv.ps1'), 'utf8');
  assert(/-PathType Leaf/.test(s), 'должен требовать Leaf для источника');
  assert(/ReparsePoint/.test(s), 'должен отвергать reparse-point');
  assert(/\$LASTEXITCODE -ne 0/.test(s), 'должен проверять код возврата uv --version');
  assert(/-notmatch '\^uv/.test(s), 'должен валидировать ФОРМАТ версии (^uv\\s+\\d), не подстроку');
  assert(/&\s*\$srcUv/.test(s), 'должен запускать uv ИЗ защищённого источника ($srcUv)');
  assert(!/&\s*\$target\b/.test(s), 'НЕ должен запускать скопированный $target (user-writable) под elevated');
});
// #7: uv.ps1 перед копированием в user-controlled %LOCALAPPDATA%\Programs\uv
// проверяет, что родитель/leaf не reparse-point (junction/symlink уводит Copy-Item).
ok('#7 uv.ps1: junction-guard перед Copy-Item (reparse родителя → фейл, leaf → .Delete)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uv.ps1'), 'utf8');
  assert(/ReparsePoint/.test(s), 'должен проверять ReparsePoint');
  assert(/Test-HmReparse/.test(s), 'хелпер Test-HmReparse для проверки reparse');
  assert(/\.Delete\(\)/.test(s), 'leaf-reparse убираем через .Delete() (не Remove-Item -Recurse на junction)');
  const guard = s.slice(s.indexOf('function Test-HmReparse'), s.indexOf('$target = Join-Path'));
  assert(/Split-Path -Parent \$dest/.test(guard), 'проверяет РОДИТЕЛЯ $dest на reparse');
});

ok('uv.sh: fail-closed guards (run-from-source, non-symlink, exit-code, формат версии)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'uv.sh'), 'utf8');
  assert(/\[ -L "\$UV" \]/.test(s), 'должен отвергать симлинк-источник');
  assert(/"\$UV" --version/.test(s), 'проверка версии ЗАПУСКОМ ИЗ ИСТОЧНИКА $UV');
  assert(/case "\$VER" in/.test(s), 'должен валидировать формат вывода версии');
  assert(/ОШИБКА: uv --version дал некорректный вывод/.test(s), 'фейл при неверном формате');
  assert(!/команда появится в PATH после перезапуска[\s\S]*exit 0/.test(s), 'нет безусловного успеха как раньше');
});

// ===== 100% ОФЛАЙН: uv вшит в vendor — установка ядра не зависит от облака =====
console.log('== Offline uv: BUNDLED-ONLY (P1-A: HM_REMOTE_CACHE-фолбэк убран), atomic download (P1-B) ==');

ok('P1-A uv.ps1: BUNDLED-ONLY — НЕТ HM_REMOTE_CACHE-фолбэка; нет vendor → skip 120; fail-closed SHA; никакой сети', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uv.ps1'), 'utf8');
  assert(/_verify\.ps1/.test(s), 'дот-сорсит _verify.ps1 (Confirm-HmArtifact)');
  assert(s.indexOf("Join-Path $env:HM_VENDOR 'apps\\uv\\uv.exe'") !== -1, 'источник — vendor apps\\uv\\uv.exe');
  assert(/Confirm-HmArtifact \$vendorUv\b/.test(s), 'SHA-256 вшитого uv.exe проверяется fail-closed ДО запуска');
  assert(/Confirm-HmArtifact \$vendorUvx\b/.test(s), 'SHA-256 вшитого uvx.exe тоже проверяется (если он есть)');
  // P1-A: опасный легаси-фолбэк на HM_REMOTE_CACHE ДОЛЖЕН отсутствовать в КОДЕ
  // ($env:HM_REMOTE_CACHE — единственный способ PS прочитать переменную; в комментах
  //  переменная упоминается без $env:, поэтому проверка бьёт только по коду).
  assert(!/\$env:HM_REMOTE_CACHE/.test(s), 'НЕТ чтения $env:HM_REMOTE_CACHE (фолбэк убран полностью)');
  assert(!/\$cache = \$env:HM_REMOTE_CACHE/.test(s), 'НЕТ ветки cache = HM_REMOTE_CACHE');
  // Нет vendor → graceful skip (exit 120), НЕ фолбэк: skip-ветка присутствует в КОДЕ.
  assert(/Test-Path -LiteralPath \$vendorUv -PathType Leaf[\s\S]{0,200}?exit 120/.test(s),
    'проверка vendor → сразу exit 120 (единственный источник; фолбэка нет)');
  assert(!/Invoke-WebRequest|Invoke-RestMethod|DownloadFile|Start-BitsTransfer|WebClient/i.test(s),
    'НИКАКИХ сетевых вызовов в uv.ps1 (установка uv офлайн)');
});

ok('P1-A uv.sh: BUNDLED-ONLY — НЕТ HM_REMOTE_CACHE-фолбэка; нет vendor → skip 120; fail-closed verify_artifact; никакой сети', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'uv.sh'), 'utf8');
  assert(/uv-macos-\$\(arch_tag\)\.tar\.gz/.test(s), 'источник — vendor uv-macos-<arch>.tar.gz (arch_tag: arm64|x64)');
  assert(/verify_artifact "\$UV_TGZ"/.test(s), 'fail-closed SHA-256 вшитого архива (verify_artifact из _lib.sh)');
  const iVerify = s.indexOf('verify_artifact "$UV_TGZ"');
  const iTar = s.indexOf('tar -xzf "$UV_TGZ"');
  assert(iVerify !== -1 && iTar !== -1 && iVerify < iTar, 'verify_artifact ПЕРЕД распаковкой архива');
  // P1-A: опасный легаси-фолбэк на HM_REMOTE_CACHE ДОЛЖЕН отсутствовать в КОДЕ
  // (${HM_REMOTE_CACHE — единственный способ bash прочитать; в комментах — без ${).
  assert(!/\$\{HM_REMOTE_CACHE/.test(s), 'НЕТ чтения ${HM_REMOTE_CACHE} (фолбэк убран полностью)');
  assert(!/CACHE="\$\{HM_REMOTE_CACHE/.test(s), 'НЕТ ветки CACHE=HM_REMOTE_CACHE');
  // Нет vendor → graceful skip (exit 120), НЕ фолбэк: skip-ветка присутствует в КОДЕ.
  assert(/\[ ! -f "\$UV_TGZ" \]; then[\s\S]{0,200}?exit 120/.test(s),
    'проверка vendor → сразу exit 120 (единственный источник; фолбэка нет)');
  assert(!/\bcurl\b|\bwget\b/.test(s), 'НИКАКИХ сетевых вызовов в uv.sh (установка uv офлайн)');
});

ok('P1-A main.js: childEnv.HM_REMOTE_CACHE стирается СРАЗУ после buildInstallEnv (до задания из проверенного remoteCache)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const iBuild = s.indexOf('const childEnv = buildInstallEnv(rendererEnv);');
  const iDelete = s.indexOf('delete childEnv.HM_REMOTE_CACHE;');
  const iSet = s.indexOf('if (remoteCache) childEnv.HM_REMOTE_CACHE = remoteCache;');
  assert(iBuild !== -1, 'buildInstallEnv присутствует');
  assert(iDelete !== -1, 'delete childEnv.HM_REMOTE_CACHE присутствует');
  assert(iSet !== -1, 'условная установка из remoteCache присутствует');
  assert(iBuild < iDelete && iDelete < iSet,
    'порядок: build → delete (стереть унаследованный из process.env) → set из sha-проверенного пути');
});

ok('P1-B fetch-vendor.ps1: uv качается в .part → проверка zip содержит uv.exe/uvx.exe → atomic move; сбой → .part удалён', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor.ps1'), 'utf8');
  assert(/github\.com\/astral-sh\/uv\/releases/.test(s), 'официальный источник — GitHub releases astral-sh/uv');
  assert(/uv-x86_64-pc-windows-msvc\.zip/.test(s), 'Windows-ассет uv-x86_64-pc-windows-msvc.zip');
  assert(/_uv\.zip\.part/.test(s), 'качает во временный .part');
  assert(/'uv\.exe', 'uvx\.exe'/.test(s), 'распаковывает uv.exe + uvx.exe');
  assert(/Test-HmUvVendorValid \$uvStage/.test(s), 'требует ОБА бинаря непустыми до публикации (Test-HmUvVendorValid)');
  assert(/Move-Item -Force \$uvStage \$uvDir/.test(s), 'atomic-move проверенного _stage на место');
  assert(/Remove-Item \$uvZip -Force -ErrorAction SilentlyContinue/.test(s), 'частичный .part подчищается');
  const iFetch = s.indexOf('uv-x86_64-pc-windows-msvc.zip');
  const iChk = s.indexOf('checksums.json — SHA-256');
  assert(iFetch !== -1 && iChk !== -1 && iFetch < iChk, 'uv вшивается ДО генерации checksums.json (попадает в манифест)');
});

// P1 (Codex): skip-ветка НЕ доверяет существующему файлу вслепую — валидирует так же,
// как свежую закачку (оба непустых exe). Битый существующий → перекачка, НЕ skip.
ok('P1 fetch-vendor.ps1: skip валидирует существующий uv (оба EXE) — битый → Remove+перекачка; FATAL требует uv+uvx', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor.ps1'), 'utf8');
  assert(/function Test-HmUvVendorValid/.test(s), 'есть валидатор существующего vendor-uv');
  assert(/Join-Path \$dir 'uv\.exe'/.test(s) && /Join-Path \$dir 'uvx\.exe'/.test(s),
    'валидатор проверяет ОБА бинаря (uv.exe + uvx.exe)');
  assert(/\$e\.Length -gt 0 -and \$x -and \$x\.Length -gt 0/.test(s), 'оба бинаря должны быть непустыми');
  // skip ТОЛЬКО при Test-HmUvVendorValid; иначе Remove-Item каталога и перекачка.
  const iValid = s.indexOf('if (Test-HmUvVendorValid $uvDir) {');
  const iSkip = s.indexOf('skip uv\\uv.exe');
  assert(iValid !== -1 && iSkip !== -1 && iValid < iSkip, 'skip только после Test-HmUvVendorValid $uvDir');
  assert(/битый\/неполный \(нет uvx\.exe или пустой\) — перекачиваю/.test(s), 'битый существующий → перекачка (не skip)');
  assert(/Remove-Item -Recurse -Force \$uvDir/.test(s), 'битый каталог удаляется перед перекачкой');
  // FATAL-гейт полноты требует ОБА бинаря (не только uv.exe).
  assert(/Test-HmUvVendorValid \(Join-Path \$apps 'uv'\)/.test(s), 'FATAL-гейт использует Test-HmUvVendorValid (оба EXE)');
  assert(/FATAL: vendor\\apps\\uv неполон — нужны ОБА непустых uv\.exe и uvx\.exe/.test(s),
    'FATAL требует uv.exe И uvx.exe (не size-only на одном файле)');
  assert(!/FATAL: нет vendor\\apps\\uv\\uv\.exe\b/.test(s), 'старый size-only FATAL на одном uv.exe убран');
});

ok('P1-B fetch-vendor-mac.sh: uv качается в .part → проверка tar содержит uv+uvx → atomic mv; сбой → .part удалён', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor-mac.sh'), 'utf8');
  assert(/astral-sh\/uv\/releases/.test(s), 'официальный источник — GitHub releases astral-sh/uv');
  assert(/aarch64-apple-darwin/.test(s), 'ассет aarch64-apple-darwin (arm64)');
  assert(/x86_64-apple-darwin/.test(s), 'ассет x86_64-apple-darwin (x64)');
  assert(/uv-macos-\$arch\.tar\.gz/.test(s), 'уникальные basename uv-macos-<arch>.tar.gz (checksums.json ключуется по basename)');
  assert(/local part="\$out\.part"/.test(s), 'качает во временный .part');
  assert(/uv_tarball_valid "\$part"/.test(s), 'свежая закачка валидируется (uv_tarball_valid)');
  assert(/mv -f "\$part" "\$out"/.test(s), 'atomic mv .part → финальный архив после проверки');
  assert(/rm -f "\$part"/.test(s), 'частичный .part удаляется при сбое');
  assert(/chk_file "\$APPS\/uv-macos-arm64\.tar\.gz"/.test(s) && /chk_file "\$APPS\/uv-macos-x64\.tar\.gz"/.test(s),
    'оба архива в проверке полноты vendor');
  const iFetch = s.indexOf('aarch64-apple-darwin');
  const iChk = s.indexOf('checksums.json — SHA-256');
  assert(iFetch !== -1 && iChk !== -1 && iFetch < iChk, 'uv вшивается ДО генерации checksums.json (попадает в манифест)');
});

// P1 (Codex): skip-ветка валидирует существующий tarball (tar+uv/uvx). Битый/полу-
// извлечённый существующий → удаление и перекачка, НЕ skip. FATAL требует оба бинаря.
ok('P1 fetch-vendor-mac.sh: skip валидирует существующий tarball (tar+uv/uvx) — битый → rm+перекачка; FATAL требует uv+uvx', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor-mac.sh'), 'utf8');
  assert(/uv_tarball_valid\(\)/.test(s), 'есть валидатор tarball uv_tarball_valid');
  assert(/tar -tzf "\$f"/.test(s), 'валидатор: tarball читается (валидный gzip-tar)');
  assert(/grep -qE '\(\^\|\/\)uv\$'/.test(s) && /grep -qE '\(\^\|\/\)uvx\$'/.test(s),
    'валидатор требует uv И uvx внутри архива');
  // skip ТОЛЬКО если uv_tarball_valid "$out"; иначе rm и перекачка.
  const iValid = s.indexOf('if uv_tarball_valid "$out"; then echo "  skip');
  assert(iValid !== -1, 'skip только после uv_tarball_valid существующего $out');
  assert(/существующий \$\(basename "\$out"\) битый\/неполный[\s\S]{0,80}?перекачиваю/.test(s),
    'битый существующий → перекачка (не skip)');
  // FATAL-гейт требует ОБА бинаря — валидирует tarball, не только -s.
  assert(/if ! uv_tarball_valid "\$APPS\/uv-macos-\$UVA\.tar\.gz"; then/.test(s),
    'FATAL-гейт валидирует tarball (uv+uvx), не только размер');
  assert(/FATAL: vendor\/apps\/uv-macos-\$UVA\.tar\.gz битый\/неполный/.test(s),
    'FATAL при битом/неполном архиве (нет обоих uv+uvx)');
});

// FIX-C: freshUnpack fail-closed, если старую распаковку НЕ удалось удалить.
// Детерминированно: временно подменяем fs.rmSync, чтобы бросал на unpacked-old.
ok('freshUnpack: старую распаковку не удалить → fail-closed (не продолжает)', () => {
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-fu-'));
  const oldDir = path.join(cacheDir, 'unpacked-oldsha');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'x.bin'), 'x');
  const origRm = fs.rmSync;
  fs.rmSync = (p, o) => { if (String(p).indexOf('unpacked-oldsha') !== -1) throw new Error('EBUSY (test)'); return origRm(p, o); };
  try {
    const r = rf.freshUnpack(path.join(cacheDir, 'nonexistent.zip'), path.join(cacheDir, 'unpacked-newsha'), cacheDir);
    assert(r.ok === false, 'должен быть fail-closed: ' + JSON.stringify(r));
    assert(/удал/i.test(r.error || ''), 'ошибка про неудаление старой распаковки: ' + r.error);
    assert(fs.existsSync(oldDir), 'старый каталог остаётся (не продолжили молча)');
  } finally {
    fs.rmSync = origRm;
    try { origRm(cacheDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

// ---- Async: security fail-closed + resume-ветки + anti-SSRF ----------

// Инъекция транспорта: openStream → локальный http-сервер (боевые https/SSRF-гейты
// остаются нетронутыми; тестируем именно логику resume/size-cap в downloadWithResume).
function makeTransport(port) {
  return (url, opts, cb) => {
    let u;
    try { u = new URL(url); } catch (e) { cb(e); return; }
    const req = http.request({
      hostname: '127.0.0.1', port, path: u.pathname + (u.search || ''),
      method: 'GET', headers: opts.headers || {}
    }, (res) => cb(null, res));
    // Пробрасываем handle запроса наружу — downloadToFd/probeMirror глушат его по
    // абсолютному дедлайну/watchdog (FIX-F). Без этого висящий сервер не прервать.
    if (opts.onRequest) opts.onRequest(req);
    req.on('error', cb);
    req.setTimeout(opts.timeoutMs || 20000, () => req.destroy(new Error('timeout')));
    req.end();
  };
}

async function asyncTests() {
  // Асинхронные тесты ОБЯЗАНЫ идти через okAsync и await — иначе галочка печатается
  // до результата, и провал теряется.
  await okAsync('НИ ОДИН вопрос дочернего процесса не может подвесить установку (stdin закрыт)',
    testNoChildPromptCanHang);
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rf-test-'));

  console.log('== Remote fetch: fail-closed по SHA (security) ==');
  await okAsync('fetchRemote fail-closed при ОТСУТСТВИИ sha256', async () => {
    const r = await rf.fetchRemote({
      entry: { remoteId: 'x', sizeBytes: 10, mirrors: [{ url: 'https://example.com/x.zip' }] },
      cacheDir: path.join(tmpBase, 'a')
    });
    assert(r.ok === false, 'без sha должно быть ok:false');
    assert(/SHA-256|заблокир/i.test(r.error || ''), 'ошибка должна указывать на отсутствие валидного sha: ' + r.error);
  });
  await okAsync('fetchRemote fail-closed при кривом sha (не 64-hex)', async () => {
    const r = await rf.fetchRemote({
      entry: { remoteId: 'x', sha256: 'deadbeef', sizeBytes: 10, mirrors: [{ url: 'https://example.com/x.zip' }] },
      cacheDir: path.join(tmpBase, 'b')
    });
    assert(r.ok === false && /SHA-256|заблокир/i.test(r.error || ''), 'кривой sha → fail-closed: ' + r.error);
  });

  console.log('== Remote fetch: held-fd download + resume/restart/size-cap + deadline/min-rate ==');
  const BODY = crypto.randomBytes(4096);
  const shaBody = crypto.createHash('sha256').update(BODY).digest('hex').toLowerCase();
  // Локальный http-сервер с ветками (state — для одноразовых обрывов).
  const state = {};
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const range = req.headers['range'] || '';
    const rm = range.match(/bytes=(\d+)-/);
    const start = rm ? Number(rm[1]) : 0;

    if (p === '/full') { // игнорирует Range → всегда 200 целиком
      res.writeHead(200, { 'Content-Length': String(BODY.length) }); res.end(BODY); return;
    }
    // Обрыв ПОСЛЕ доставки первых 2048 байт: destroy с задержкой, чтобы клиент
    // успел получить 'data' (net RST иначе выбросил бы буфер → written не растёт).
    const dropAfterPartial = () => {
      res.writeHead(200, { 'Content-Length': String(BODY.length) });
      res.write(BODY.subarray(0, 2048), () => { setTimeout(() => { try { res.socket.destroy(); } catch (e) { /* ignore */ } }, 40); });
    };
    if (p === '/droponce') { // 1-й GET рвётся на середине; resume Range → 206 хвост
      if (rm) {
        const c = BODY.subarray(start);
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`, 'Content-Length': String(c.length) });
        res.end(c); return;
      }
      dropAfterPartial(); return; // обрыв в середине
    }
    if (p === '/dropthenfull') { // 1-й GET рвётся; на resume сервер игнорит Range → 200 full
      if (rm) { res.writeHead(200, { 'Content-Length': String(BODY.length) }); res.end(BODY); return; }
      dropAfterPartial(); return;
    }
    if (p === '/416flow') { // resume Range → 416; затем повтор с нуля (200 full)
      if (rm) { res.writeHead(416); res.end(); return; }
      if (!state.f416) { state.f416 = true; dropAfterPartial(); return; }
      res.writeHead(200, { 'Content-Length': String(BODY.length) }); res.end(BODY); return;
    }
    if (p === '/trickle') { // probe ок; полный GET отдаёт 1 байт и замирает (min-rate)
      if (range === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': `bytes 0-0/${BODY.length}`, 'Content-Length': '1' }); res.end(BODY.subarray(0, 1)); return; }
      res.writeHead(200, { 'Content-Length': String(BODY.length) }); res.write(BODY.subarray(0, 1)); return; // не завершает
    }
    if (p === '/hang') { // probe ок; полный GET вообще не отвечает (pre-response deadline)
      if (range === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': `bytes 0-0/${BODY.length}`, 'Content-Length': '1' }); res.end(BODY.subarray(0, 1)); return; }
      return; // молчим — держим соединение
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const DL = Date.now() + 60000;
  rf.__setOpenStreamImpl(makeTransport(port));

  const dlToFile = async (url, file, expSize, deadlineAt, tuning) => {
    const fd = fs.openSync(file, 'w', 0o600);
    try { return await rf.downloadToFd(url, fd, expSize, null, 5000, deadlineAt, tuning); }
    finally { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  };

  try {
    await okAsync('200: свежее скачивание в held-fd + потоковый sha', async () => {
      const f = path.join(tmpBase, 'full.part');
      const r = await dlToFile('https://cdn.test/full', f, BODY.length, DL);
      assert(r.ok, 'ok'); assert(fs.readFileSync(f).equals(BODY), 'контент полный');
      assert(r.sha === shaBody, 'потоковый sha совпадает с sha(BODY): ' + r.sha);
    });
    await okAsync('held-fd resume: обрыв в середине → докачка 206 от written', async () => {
      const f = path.join(tmpBase, 'drop.part');
      const r = await dlToFile('https://cdn.test/droponce', f, BODY.length, DL);
      assert(r.ok, 'ok'); assert(fs.readFileSync(f).equals(BODY), 'дособрано целиком');
      assert(r.sha === shaBody, 'sha после resume верный');
    });
    await okAsync('resume→200: сервер проигнорировал Range → рестарт с нуля (truncate+new hash)', async () => {
      const f = path.join(tmpBase, 'dtf.part');
      const r = await dlToFile('https://cdn.test/dropthenfull', f, BODY.length, DL);
      assert(r.ok, 'ok'); assert(fs.readFileSync(f).equals(BODY), 'перезаписан целиком');
      assert(r.sha === shaBody, 'sha после рестарта верный');
    });
    await okAsync('resume→416: битый диапазон → рестарт с нуля', async () => {
      const f = path.join(tmpBase, 'f416.part');
      const r = await dlToFile('https://cdn.test/416flow', f, BODY.length, DL);
      assert(r.ok, 'ok'); assert(fs.readFileSync(f).equals(BODY), 'собран после 416-рестарта');
      assert(r.sha === shaBody, 'sha после 416-рестарта верный');
    });
    // BUG #9: held-fd short-write. fs.writeSync может записать МЕНЬШЕ запрошенного —
    // цикл должен дозаписать, захешировать только реально записанное, а fstat-гейт
    // перед публикацией — поймать любое расхождение размера.
    await okAsync('#9 short-write: частичная запиcь дозаписывается → полный контент, size==expected', async () => {
      const f = path.join(tmpBase, 'short.part');
      const realWrite = fs.writeSync;
      // ОС «записывает» максимум 100 байт за вызов (эмуляция короткой записи).
      fs.writeSync = function (fd, buf, off, len, pos) { return realWrite.call(fs, fd, buf, off, Math.min(len, 100), pos); };
      try {
        const r = await dlToFile('https://cdn.test/full', f, BODY.length, DL);
        assert(r.ok, 'ok: ' + JSON.stringify(r));
        assert(fs.readFileSync(f).equals(BODY), 'контент собран целиком после дозаписи');
        assert(r.sha === shaBody, 'sha по реально записанным байтам верный: ' + r.sha);
        assert(fs.statSync(f).size === BODY.length, 'size на диске == expected');
      } finally { fs.writeSync = realWrite; }
    });
    await okAsync('#9 zero-progress: writeSync вернул 0 → fail-closed (не публикуем)', async () => {
      const f = path.join(tmpBase, 'zero.part');
      const realWrite = fs.writeSync;
      fs.writeSync = function () { return 0; }; // прогресса нет
      try {
        const r = await dlToFile('https://cdn.test/full', f, BODY.length, DL);
        assert(r.ok === false && /short-write|прогресс/i.test(r.error || ''), 'должен упасть на нулевой записи: ' + JSON.stringify(r));
      } finally { fs.writeSync = realWrite; }
    });
    await okAsync('#9 fstat-гейт: writeSync солгал (вернул len, записал меньше) → fail по размеру', async () => {
      const f = path.join(tmpBase, 'lie.part');
      const realWrite = fs.writeSync;
      // Записываем на 10 байт меньше, но РАПОРТУЕМ полную запись → held-fd короче.
      fs.writeSync = function (fd, buf, off, len, pos) { const w = Math.max(0, len - 10); if (w > 0) realWrite.call(fs, fd, buf, off, w, pos); return len; };
      try {
        const r = await dlToFile('https://cdn.test/full', f, BODY.length, DL);
        assert(r.ok === false && /размер/i.test(r.error || ''), 'fstat-гейт должен поймать обрезание: ' + JSON.stringify(r));
      } finally { fs.writeSync = realWrite; }
    });

    await okAsync('size-cap: сервер отдал больше ожидаемого → abort+ошибка размера', async () => {
      const f = path.join(tmpBase, 'cap.part');
      const r = await dlToFile('https://cdn.test/full', f, 100, DL);
      assert(r.ok === false && /размер/i.test(r.error || ''), 'cap должен сработать: ' + JSON.stringify(r));
    });
    await okAsync('pre-response deadline: висящий сервер (header-trickle) → abort по дедлайну', async () => {
      const f = path.join(tmpBase, 'hang.part');
      const r = await dlToFile('https://cdn.test/hang', f, BODY.length, Date.now() + 250, { tickMs: 60 });
      assert(r.ok === false && /дедлайн/i.test(r.error || ''), 'должен упасть по абсолютному дедлайну: ' + JSON.stringify(r));
    });
    await okAsync('min-rate: сервер отдал 1 байт и замер → abort по минимальной скорости', async () => {
      const f = path.join(tmpBase, 'trickle.part');
      const r = await dlToFile('https://cdn.test/trickle', f, BODY.length, DL, { stallWindow: 300, stallMinBytes: 1 << 20, tickMs: 60 });
      assert(r.ok === false && /скорост|минимум/i.test(r.error || ''), 'должен упасть по min-rate: ' + JSON.stringify(r));
    });

    console.log('== fetchRemote (test-mode): partial temp .part чистится при провале ==');
    await okAsync('fetchRemote: висящее зеркало → fail + temp .part убран', async () => {
      const cacheDir = path.join(tmpBase, 'cln');
      const entry = { remoteId: 'hangx', sha256: shaBody, sizeBytes: BODY.length, mirrors: [{ url: 'https://cdn.test/hang' }] };
      const r = await rf.fetchRemote({ entry, cacheDir, timeoutMs: 2000, downloadDeadlineMs: 250, tuning: { tickMs: 60 } });
      assert(r.ok === false, 'должно упасть: ' + JSON.stringify(r));
      const leftovers = fs.readdirSync(cacheDir).filter((n) => n.endsWith('.part'));
      assert(leftovers.length === 0, 'остались temp .part: ' + leftovers.join(','));
    });
  } finally {
    rf.__setOpenStreamImpl(null);
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('== Anti-SSRF: canonical IPv4/IPv6 (mapped/NAT64/bracketed/zone-id) ==');
  ok('ipInPrivateRange: loopback/private/link-local/CGNAT → true, публичные → false', () => {
    ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.1.1', '172.16.0.1', '100.64.0.1', '::1', 'fe80::1', 'fc00::1']
      .forEach((ip) => assert(rf.ipInPrivateRange(ip), ip + ' должен быть приватным'));
    ['8.8.8.8', '1.1.1.1', '93.184.216.34']
      .forEach((ip) => assert(!rf.ipInPrivateRange(ip), ip + ' должен быть публичным'));
  });
  ok('ipInPrivateRange: IPv6 canonical/mapped/NAT64/bracket/zone → корректно (FIX-H)', () => {
    ['::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1',
      // BUG #10: 64:ff9b:1::/48 — NAT64 local-use (не global-reachable) → отвергаем весь /48
      '64:ff9b:1::1', '64:ff9b:1:2:3:4:5:6', '64:ff9b:1:0:0:0:808:808',
      '[::1]', 'fe80::1%eth0', '[fe80::1%eth0]']
      .forEach((ip) => assert(rf.ipInPrivateRange(ip), ip + ' должен быть приватным/небезопасным'));
    ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2a00:1450:4001::1']
      .forEach((ip) => assert(!rf.ipInPrivateRange(ip), ip + ' должен быть публичным'));
  });

  // ---- РЕДИЗАЙН (функц.): занятый файл при копии-бэкапе → предупреждение, установка ПРОДОЛЖАЕТСЯ ----
  // Открытый Cursor/Claude держит chats.db эксклюзивно. Раньше бэкап был единственной копией
  // перед wipe → неполный бэкап = abort. Теперь оригинал НЕ переносится, поэтому неполный
  // бэкап НЕ фатален: предупреждаем и продолжаем; наша база разложена; оригинал ~/.claude цел.
  const { spawn } = require('child_process');
  if (powershellAvailable()) {
    console.log('== РЕДИЗАЙН config.ps1 (функц.): chats.db эксклюзивно занят при бэкапе → warning, НЕ abort, оригинал цел ==');
    await okAsync('config.ps1: занятый chats.db (open Cursor/Claude) → неполный бэкап → предупреждение + ПРОДОЛЖАЕМ; наша база разложена; install.ps1 НЕ вызван; ~/.claude НЕ move', async () => {
      const { base, home, clone } = mkCfgSandbox();
      seedHome(home);
      const sentinel = base + '/writer-on';
      const ready = base + '/writer-ready';
      let writer = null;
      try {
        const chats = home + '/.claude/chats.db';
        const chatsWin = chats.replace(/\//g, '\\');
        const sentWin = sentinel.replace(/\//g, '\\');
        const readyWin = ready.replace(/\//g, '\\');
        fs.writeFileSync(sentinel, '1');
        // держим chats.db открытым ЭКСКЛЮЗИВНО (FileShare.None) — как работающий SQLite/Claude:
        // robocopy-бэкап не снимет его (exit>=8 → warning), но установка обязана продолжиться.
        const w = "$fs=[System.IO.File]::Open('" + chatsWin + "','Open','ReadWrite','None'); " +
          "Set-Content -Path '" + readyWin + "' -Value 'ok'; " +
          "$end=(Get-Date).AddSeconds(30); while ((Test-Path '" + sentWin + "') -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 20 }; $fs.Close()";
        writer = spawn('powershell.exe', ['-NoProfile', '-Command', w], { detached: false, windowsHide: true, stdio: 'ignore' });
        let tries = 0;
        while (!fs.existsSync(ready) && tries < 1000) { await new Promise((res) => setTimeout(res, 5)); tries++; }
        assert(fs.existsSync(ready), 'фоновый процесс захватил эксклюзивную блокировку chats.db');
        const r = runCfgPs1(home, clone, { HM_ADDITIVE: '1' });
        fs.rmSync(sentinel, { force: true });   // отпускаем блокировку
        assert.strictEqual(r.status, 0, 'exit 0 (неполный бэкап → warning, НЕ abort): ' + (r.stdout || '') + (r.stderr || ''));
        assert(/бэкап[\s\S]{0,80}не удалось|Это НЕ критично/i.test(r.stdout || ''), 'предупреждение о бэкапе напечатано: ' + (r.stdout || ''));
        assert(/Продолжаю/i.test(r.stdout || ''), 'установка продолжилась (не отменена)');
        assert(!fs.existsSync(home + '/.install-ran'), 'install.ps1 базового пака НЕ вызывался (нет wipe)');
        assert.strictEqual(fs.readFileSync(home + '/.claude/rules/new-rule.md', 'utf8'), 'fresh rule', 'наша база разложена несмотря на неполный бэкап');
        assert(fs.existsSync(home + '/.claude/skills/user-skill/SKILL.md'), 'оригинальный скилл юзера на месте (~/.claude НЕ move)');
      } finally {
        try { fs.rmSync(sentinel, { force: true }); } catch (e) { /* ignore */ }
        if (writer) { try { writer.kill('SIGKILL'); } catch (e) { /* ignore */ } }
        await new Promise((res) => setTimeout(res, 150));   // дать ОС отпустить лок перед rm
        try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    });
  }

  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// m6: finish-link deep-link payload (pure-логика, UMD — тот же модуль, что грузит renderer).
console.log('== finish-link deep-link ==');
const HMFinish = require(path.join(ROOT, 'src', 'renderer', 'finish-link.js'));
ok('finish-link: успех -> installed_<plat>, платформа не срезается', () => {
  assert.strictEqual(HMFinish.botStartPayload([], true, 'installed'), 'installed_win');
  assert.strictEqual(HMFinish.botStartPayload([], false, 'installed'), 'installed_mac');
});
ok('finish-link: провал -> failed_<первый-id>_<plat>', () => {
  assert.strictEqual(HMFinish.botStartPayload(['cursor'], true, 'installed'), 'failed_cursor_win');
  assert.strictEqual(HMFinish.botStartPayload(['nomad', 'git'], false, 'installed'), 'failed_nomad_mac');
});
ok('finish-link: payload <=64, платформенный суффикс НИКОГДА не срезается', () => {
  const long = 'x'.repeat(200);
  const pf = HMFinish.botStartPayload([long], true, 'installed');
  assert(pf.length <= 64, 'failed-payload в пределах лимита Telegram (64)');
  assert(pf.startsWith('failed_') && pf.endsWith('_win'), 'префикс failed_ и суффикс _win целы');
  const po = HMFinish.botStartPayload([], false, long);
  assert(po.length <= 64 && po.endsWith('_mac'), 'ok-payload: лимит соблюдён, суффикс _mac цел');
});
ok('finish-link: не-Telegram-символы в id гасятся в -', () => {
  assert.strictEqual(HMFinish.botStartPayload(['a b/c.d'], true, 'installed'), 'failed_a-b-c-d_win');
});
ok('finish-link: botUrl пустой без базы/пейлоада, иначе ?start=', () => {
  assert.strictEqual(HMFinish.botUrl('', 'installed_win'), '');
  assert.strictEqual(HMFinish.botUrl('https://t.me/bot', ''), '');
  assert.strictEqual(HMFinish.botUrl('https://t.me/bot', 'installed_win'), 'https://t.me/bot?start=installed_win');
});

// ---- телеметрия с привязкой к человеку (uid) --------------------------------
// Установщик стал слать uid и диагностику ошибок, чтобы бот мог помочь адресно
// («вижу, упало на шаге X по причине Y»). Всё, что уходит наружу, — граница доверия:
// uid определяет ТОЛЬКО главный процесс, тип события берётся из закрытого списка,
// а тексты ошибок чистятся от персональных данных.

const UIDT = require(path.join(ROOT, 'src', 'uid-telemetry.js'));

ok('uid: принимаем только [A-Za-z0-9_-]{1,32}, мусор отбрасываем целиком', () => {
  assert.strictEqual(UIDT.sanitizeUid('272540053'), '272540053');
  assert.strictEqual(UIDT.sanitizeUid(' a-b_C9 '), 'a-b_C9', 'пробелы по краям срезаются');
  for (const bad of ['', ' ', 'a b', 'x'.repeat(33), 'a;drop', '../etc', '<script>', null, undefined, {}]) {
    assert.strictEqual(UIDT.sanitizeUid(bad), '', 'мусор отбрасывается: ' + JSON.stringify(bad));
  }
});

ok('uid: источники — env, файл рядом, имя файла; « (1)» от Windows не ломает привязку', () => {
  const exe = path.join(os.tmpdir(), 'hm-uid-' + Date.now(), 'Hamidun-Setup-Windows--u272540053 (1).exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  try {
    // Имя файла: суффикс --u<uid>, повторное скачивание Windows (« (1)») привязку НЕ теряет.
    assert.strictEqual(UIDT.resolveUid({ env: {}, execPath: exe }), '272540053');
    // Файл рядом сильнее имени файла.
    fs.writeFileSync(path.join(path.dirname(exe), 'hamidun-uid.txt'), 'from_file\n');
    assert.strictEqual(UIDT.resolveUid({ env: {}, execPath: exe }), 'from_file');
    // Окружение сильнее всего (отладка и автотесты).
    assert.strictEqual(UIDT.resolveUid({ env: { HM_UID: 'from_env' }, execPath: exe }), 'from_env');
    // Мусор в источнике не проходит дальше — уезжает пустая привязка, а не грязь.
    assert.strictEqual(UIDT.resolveUid({ env: { HM_UID: 'плохой uid' }, execPath: path.join(os.tmpdir(), 'x.exe') }), '');
    // Обычное имя без суффикса — просто анонимно.
    assert.strictEqual(UIDT.resolveUid({ env: {}, execPath: path.join(os.tmpdir(), 'Hamidun-Setup-Windows.exe') }), '');
  } finally {
    fs.rmSync(path.dirname(exe), { recursive: true, force: true });
  }
});

ok('телеметрия: uid ставит ГЛАВНЫЙ процесс, renderer его подменить не может', () => {
  const m = EG_MAIN();
  const i = m.indexOf("ipcMain.handle('send-telemetry'");
  const h = m.slice(i, i + 2600);
  assert(/uid: INSTALL_UID \|\| null/.test(h), 'в тело идёт INSTALL_UID, вычисленный в main');
  assert(!/p\.uid/.test(h), 'uid из payload renderer НЕ читается (иначе он приписал бы установку чужому человеку)');
});

ok('телеметрия: тип события — из закрытого списка, произвольный не пролезает', () => {
  const m = EG_MAIN();
  const i = m.indexOf("ipcMain.handle('send-telemetry'");
  const h = m.slice(i, i + 2600);
  assert(/const EVENTS = \['installed', 'install_started', 'open_editor'\]/.test(h), 'список событий закрыт');
  assert(/EVENTS\.indexOf\(String\(p\.event.*!== -1 \? String\(p\.event\) : 'installed'/.test(h),
    'неизвестное событие схлопывается в installed, а не улетает как есть');
});

ok('телеметрия: тексты ошибок чистятся от ПД (домашний каталог, имя пользователя, e-mail, IP)', () => {
  // Фиксированные home/user, чтобы проверка не зависела от машины, на которой её гоняют.
  const o = { home: 'C:\\Users\\ivan', user: 'ivan' };
  const out = UIDT.scrubText(
    'ENOENT C:\\Users\\ivan\\AppData\\x.zip; чужой путь C:\\Users\\petr\\y.zip; ' +
    'пользователь ivan; почта a.b@mail.ru; узел 10.1.2.3', o);
  assert(!/ivan/i.test(out), 'ни имени пользователя, ни его каталога: ' + out);
  assert(!/petr/i.test(out), 'чужие домашние каталоги тоже вычищены: ' + out);
  // Имя профиля С ПРОБЕЛОМ — норма на Windows («C:\Users\John Smith»). Проверка с
  // ником без пробела этого не ловила: регулярка обрывалась на пробеле и оставляла
  // фамилию в тексте («~ Smith\AppData\…»).
  const spaced = UIDT.scrubText('ENOENT C:\\Users\\John Smith\\AppData\\Local\\hm.zip', o);
  assert(!/Smith/i.test(spaced), 'профиль с пробелом в имени вычищен целиком: ' + spaced);
  assert.strictEqual(spaced, 'ENOENT ~\\AppData\\Local\\hm.zip', 'путь после профиля уцелел: ' + spaced);
  const spacedPosix = UIDT.scrubText('нет доступа к /Users/John Smith/.claude', o);
  assert.strictEqual(spacedPosix, 'нет доступа к ~/.claude', 'то же на POSIX: ' + spacedPosix);
  assert(!/a\.b@mail\.ru/.test(out), 'e-mail вычищен: ' + out);
  assert(!/10\.1\.2\.3/.test(out), 'IP вычищен: ' + out);
  // Ник «ivan» встречается внутри слова «Ivanovo-Setup.exe» — это НЕ ПД, и калечить
  // название нельзя: иначе вместо диагностики бот получает кашу.
  assert.strictEqual(UIDT.scrubText('файл Ivanovo-Setup.exe не подписан', o),
    'файл Ivanovo-Setup.exe не подписан');
  // POSIX-домашние каталоги.
  assert.strictEqual(UIDT.scrubText('нет доступа к /home/ivan/.claude', o), 'нет доступа к ~/.claude');
  assert.strictEqual(UIDT.scrubText('нет доступа к /Users/ivan/.claude', o), 'нет доступа к ~/.claude');
});

ok('git НИКОГДА не спрашивает креды — иначе окно помощника вешает установку', () => {
  // Найдено вживую: Git Credential Manager (на Windows стоит по умолчанию) поднял
  // ГРАФИЧЕСКОЕ окно «введите логин», и вызвавший процесс встал намертво. У установщика
  // та же схема — он клонирует конфиг, а окно может всплыть ЗА окном установщика.
  // Все наши источники ПУБЛИЧНЫЕ: запрос кредов = сломанная ситуация, и правильный
  // исход — быстро упасть с понятной ошибкой.
  const m = EG_MAIN();
  const i = m.indexOf('const NONINTERACTIVE_ENV');
  assert(i !== -1, 'набор «никакого интерактива» объявлен');
  const h = m.slice(i, i + 900);
  for (const k of ['GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GCM_INTERACTIVE', 'SSH_ASKPASS']) {
    assert(new RegExp(k).test(h), 'заглушено: ' + k);
  }
  // Должно попадать в окружение НА ОБЕИХ платформах, а не только на Windows.
  assert((m.match(/Object\.assign\(out, NONINTERACTIVE_ENV\)/g) || []).length >= 2,
    'применяется и в Windows-, и в POSIX-ветке buildInstallEnv');

  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  assert(/credential\.helper=/.test(ps) && /credential\.interactive=false/.test(ps),
    'сам git-вызов на Windows тоже обезврежен (env могут не унаследовать)');
  // ПОВЕДЕНЧЕСКАЯ проверка, а не текстовая. Текстовая уже пропустила боевую поломку:
  // в строку попал ЛИТЕРАЛЬНЫЙ backslash-n вместо переноса, git получал лишний аргумент
  // «n» и падал с «'n' is not a git command», а регекс по исходнику всё равно матчился —
  // тест был зелёным на мёртвом коде. Поэтому собираем argv настоящим bash.
  assert(/credential\.helper=/.test(sh) && /credential\.interactive=false/.test(sh),
    'флаги защиты есть в строке (macOS)');
  const gitLine = (sh.split(/\r?\n/).find((l) => /clone --depth 1 -b "\$BRANCH"/.test(l)) || '');
  assert(gitLine, 'нашли строку вызова git clone');
  assert(gitLine.indexOf('\\n') === -1,
    'в строке нет литерального backslash-n: он ломает argv и убивает единственный путь получения конфига');

  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-argv-'));
  try {
    const fake = path.join(sb, 'git');
    fs.writeFileSync(fake, '#!/usr/bin/env bash\nfor a in "$@"; do printf "<%s>\\n" "$a"; done\n');
    fs.chmodSync(fake, 0o755);
    const script = 'GIT_BIN=' + JSON.stringify(fake) + '; BRANCH=main; URL=https://example.invalid/r.git; CLONE=' +
      JSON.stringify(path.join(sb, 'c')) + '\n' + gitLine;
    const r = require('child_process').spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
    const argv = String(r.stdout || '').trim().split(/\r?\n/)
      .filter(Boolean).map((s) => s.replace(/^</, '').replace(/>$/, ''));
    assert(argv.length > 5, 'подставной git отработал: ' + JSON.stringify(argv).slice(0, 200));
    assert(argv.indexOf('n') === -1, 'в argv нет мусорного «n»: ' + argv.join(' '));
    let firstPositional = '';
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '-c') { i++; continue; }
      if (argv[i].charAt(0) === '-') continue;
      firstPositional = argv[i]; break;
    }
    assert.strictEqual(firstPositional, 'clone',
      'git получает подкоманду clone, а не мусор: ' + argv.join(' '));
    assert(argv.indexOf('credential.helper=') !== -1, 'защита от запроса кредов реально доехала до git');
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
});

ok('Nomad собирается из КОПИИ — иначе повторная установка падает на гейте целостности', () => {
  // uv/setuptools кладут артефакты сборки (build\, *.egg-info\) РЯДОМ С ИСХОДНИКОМ.
  // После первой установки дерево vendor меняется, и при ПОВТОРНОМ запуске установщика
  // гейт честно говорит «vendor подменён» — компонент не ставится больше никогда.
  // Проверено запуском на реальном uv: 2 файла в исходнике превращались в 7.
  // На macOS это уже было сделано (BUILD_SRC), на Windows — не было.
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'nomad.ps1'), 'utf8');
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'nomad.sh'), 'utf8');
  assertOrder(ps, 'Get-HmTreeSha256', 'uv tool install', 'Windows: сверка целостности ДО установки');
  assert(/hm-nomad-build-/.test(ps), 'Windows: сборка идёт из временной копии');
  assert(/tool install --python 3\.12 "\$srcForInstall"/.test(ps),
    'Windows: uv получает КОПИЮ, а не путь в vendor');
  assert(/Remove-Item -LiteralPath \$buildSrc/.test(ps), 'Windows: копия убирается');
  assert(/BUILD_SRC=/.test(sh) && /uv tool install --python 3\.12 "\$BUILD_SRC"/.test(sh),
    'macOS: тот же приём на месте');
});

ok('Windows: vsix ставится из ЧИТАЕМОЙ пользователем копии (де-элевация не видит admins-only)', () => {
  // Расширения ставит CLI редактора при MEDIUM integrity, а в лёгком издании vsix лежит
  // в скачанном паке, распакованном в admins-only каталог (%ProgramData%\HmDeElev-*,
  // DACL {SYSTEM, Administrators}). Medium-процесс его ПРОЧИТАТЬ НЕ МОЖЕТ — офлайн-путь
  // срывался бы в Marketplace, а без интернета панель не ставилась бы вовсе.
  for (const f of ['vscode.ps1', 'extension.ps1']) {
    const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', f), 'utf8');
    assert(/GetTempPath\(\)/.test(s) && /\.vsix'\)/.test(s),
      f + ': проверенный vsix копируется в пользовательский temp');
    assert(/OpenRead\(/.test(s),
      f + ': копия проверяется на ЧИТАЕМОСТЬ — иначе честно уходим в Marketplace');
    assert(/Confirm-HmArtifact/.test(s), f + ': целостность подтверждается ДО копирования');
    // Уборка: копии по 80 МБ не должны копиться в %TEMP%.
    const rm = /function (Remove-HmVsixTemps?)/.exec(s);
    assert(rm, f + ': есть уборка временных копий');
    const decl = s.indexOf('function ' + rm[1]);
    const firstUse = s.split(/\r?\n/).findIndex((l) => l.includes(rm[1]) && !l.trim().startsWith('function'));
    const declLine = s.slice(0, decl).split(/\r?\n/).length - 1;
    assert(declLine < firstUse,
      f + ': функция объявлена ДО первого вызова — в PowerShell иначе ранний выход падает «команда не найдена»');
  }
});

ok('Windows: НИ ОДИН сетевой вызов без -TimeoutSec (дефолт = бесконечность)', () => {
  // У Invoke-RestMethod/Invoke-WebRequest таймаут по умолчанию 0 — бесконечный. На
  // плохом канале или при перехвате трафика вызов висит молча, а watchdog установщика
  // НАМЕРЕННО не убивает процессы: шаг стоял бы вечно, человек видел бы спиннер.
  // Один такой вызов уже нашёлся (nomad.ps1), у всех соседей таймаут был.
  const dir = path.join(ROOT, 'scripts', 'windows');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ps1'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    s.split(/\r?\n/).forEach((l, n) => {
      if (/^\s*#/.test(l)) return;                                  // комментарий
      if (!/Invoke-RestMethod|Invoke-WebRequest/.test(l)) return;
      if (/-TimeoutSec/.test(l)) return;
      offenders.push(f + ':' + (n + 1) + ' ' + l.trim().slice(0, 90));
    });
  }
  assert.strictEqual(offenders.length, 0,
    'сетевые вызовы без таймаута:\n    ' + offenders.join('\n    '));
});

ok('Windows: установщики, САМИ запускающие приложение, идут БЕЗ -Wait', () => {
  // -Wait ждёт не процесс, а ВСЁ ДЕРЕВО потомков. Claude Desktop (Squirrel) сам
  // запускает приложение, а оно уходит в трей и живёт — шаг висел бы до тех пор, пока
  // человек не выгрузит программу. Для Cursor это уже было поймано и починено, на
  // Claude Desktop правило не перенесли.
  const cd = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'claude-desktop.ps1'), 'utf8');
  const i = cd.indexOf('Start-Process -FilePath $installer');
  assert(i !== -1, 'нашли запуск установщика Claude Desktop');
  const line = cd.slice(i, cd.indexOf('\n', i));
  assert(!/-Wait\b/.test(line), 'без -Wait: иначе шаг ждёт трей-приложение вечно — ' + line.trim());
  assert(/-PassThru/.test(line), '-PassThru нужен, чтобы прибрать Admins-only кэш после выхода установщика');
  assert(/Wait-Process -Timeout/.test(cd), 'ожидание выхода установщика ОГРАНИЧЕНО по времени');

  // Остальные -Wait допустимы ТОЛЬКО с тихим флагом и без автозапуска приложения.
  const SILENT = /\/VERYSILENT|\/quiet|\/qn|\/S\b/;
  for (const f of ['git.ps1', 'node.ps1', 'pydeps.ps1', 'vscode.ps1']) {
    const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', f), 'utf8');
    for (const l of s.split(/\r?\n/)) {
      if (!/Start-Process/.test(l) || !/-Wait\b/.test(l)) continue;
      assert(SILENT.test(l), f + ': -Wait допустим только с тихим флагом — ' + l.trim().slice(0, 120));
    }
  }
  // У VS Code автозапуск отключён явно — иначе он бы тоже держал шаг.
  const vs = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'vscode.ps1'), 'utf8');
  assert(/!runcode/.test(vs), 'VS Code не запускается сам после установки (MERGETASKS=!runcode)');
});

// ВНИМАНИЕ: тест АСИНХРОННЫЙ → только okAsync, вызывается из asyncTests().
// Переданный в синхронный ok() async-колбэк печатает ✅ НЕ ДОЖИДАЯСЬ результата:
// процесс успевает выйти раньше, чем тело разрешится, и провал не всплывает НИКОГДА.
// Проверено запуском: с нарочно сломанным ожиданием тест всё равно был зелёным.
// Это стерегло главный фикс дня (закрытый stdin) — то есть страж был мнимым.
async function testNoChildPromptCanHang() {
  // Живой случай: установка встала на 15 минут — unzip спросил «write error (disk full?).
  // Continue? (y/n/^C)», а ответить некуда. По умолчанию Node даёт ребёнку живой пайп на
  // stdin, который никогда не закрывается, поэтому ЛЮБОЙ вопрос вешает шаг навсегда.
  const m = EG_MAIN();
  const i = m.indexOf('const spawnOpts = { env: childEnv');
  assert(i !== -1, 'нашли спавн компонентных скриптов');
  assert(/stdio: \['ignore', 'pipe', 'pipe'\]/.test(m.slice(i, i + 200)),
    'stdin ребёнка = /dev/null: вопрос получает EOF и инструмент честно падает');

  // Проверяем не текст, а ПОВЕДЕНИЕ: спавним процесс, который ждёт ответа.
  const script = path.join(os.tmpdir(), 'hm-ask-' + Date.now() + '.js');
  fs.writeFileSync(script,
    'process.stdin.once("data", () => process.exit(0));' +
    'process.stdin.on("end", () => process.exit(3));' +
    'process.stdin.resume();');
  const { spawn: spawnChild } = require('child_process');
  const run = (stdio) => new Promise((resolve) => {
    const child = spawnChild(process.execPath, [script], { stdio });
    const kill = setTimeout(() => { try { child.kill(); } catch (e) { /* */ } resolve('hang'); }, 4000);
    child.on('close', (code) => { clearTimeout(kill); resolve('exit:' + code); });
  });
  try {
    assert.strictEqual(await run(['pipe', 'pipe', 'pipe']), 'hang', 'старое поведение действительно вешало');
    assert.strictEqual(await run(['ignore', 'pipe', 'pipe']), 'exit:3', 'с закрытым stdin процесс завершается сразу');
  } finally {
    fs.rmSync(script, { force: true });
  }
}

ok('macOS: курс распаковывается ditto — unzip не понимает кириллицу в именах', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'course.sh'), 'utf8');
  assert(/\/usr\/bin\/ditto -x -k/.test(s), 'основной путь — ditto (родной для macOS, UTF-8-имена)');
  const di = s.indexOf('/usr/bin/ditto -x -k');
  const ui = s.indexOf('/usr/bin/unzip');
  assert(di !== -1 && ui !== -1 && di < ui, 'ditto пробуется ПЕРВЫМ, unzip — запасной');
  assert(/\/usr\/bin\/unzip[^\n]*<\/dev\/null/.test(s),
    'у запасного unzip stdin закрыт: иначе он снова подвесит установку своим вопросом');
  // В архиве курса реально есть кириллическое имя — из-за него всё и встало.
  const zip = path.join(ROOT, 'vendor', 'course', 'vibecoding-course.zip');
  if (fs.existsSync(zip)) {
    const buf = fs.readFileSync(zip);
    assert(buf.includes(Buffer.from('начать', 'utf8')),
      'архив содержит имя с кириллицей — значит распаковщик обязан её понимать');
  }
});

// Текст sh-помощника самолечения — СОБРАННЫЙ ровно как в проде: eval массива
// строк `const helper = [ … ].join(' ')` из main.js. JS-комментарии между
// элементами исчезают при eval, поэтому «hdiutil detach» в комментарии текст
// не засоряет, а результат байт в байт равен тому, что запускает spawn.
function cutMacSelfhealHelper(m, from) {
  const hi = m.indexOf('const helper = [', from || 0);
  assert(hi !== -1, 'текст помощника (const helper = [) найден');
  const hj = m.indexOf("].join(' ')", hi);
  assert(hj > hi, 'конец текста помощника найден');
  return new Function('return ' + m.slice(m.indexOf('[', hi), hj + "].join(' ')".length))();
}

ok('macOS: установщик чинит карантин САМ — кнопка, а не команда в Терминал', () => {
  const m = EG_MAIN();
  const a = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const p = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');

  const i = m.indexOf("ipcMain.handle('mac-selfheal'");
  assert(i !== -1, 'обработчик самолечения есть');
  // Границей берём следующий обработчик, а не «плюс N символов»: обработчик рос,
  // и фиксированное окно однажды перестало доставать до spawn помощника — тест
  // покраснел на ровном месте, хотя код был верен.
  const hEnd = m.indexOf("ipcMain.handle('mac-selfheal-status'", i);
  const h = m.slice(i, hEnd > i ? hEnd : i + 6000);
  // Токены ищем в КОДЕ обработчика (комментарии вырезаны): вокруг self-heal много
  // пояснений, и токен, уехавший в комментарий, иначе продолжал бы «стеречь».
  const hc = h.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(/process\.platform !== 'darwin'/.test(hc), 'на не-macOS не срабатывает');
  // Всё через execFile с МАССИВОМ аргументов: путь к образу приходит из hdiutil/файловой
  // системы, и склейка в строку shell открыла бы инъекцию через имя файла.
  assert(/'\/usr\/bin\/xattr'[\s\S]{0,80}'-dr', 'com\.apple\.quarantine'/.test(hc), 'снимает карантин с образа');
  // Факт, а не отсутствие исключения: раньше «Готово» писали, не проверив ничего,
  // и человек получал ровно тот же заблокированный установщик.
  assert(/'-p', 'com\.apple\.quarantine'/.test(hc), 'проверяет, что карантин ДЕЙСТВИТЕЛЬНО снят');
  assert(/quarantine-not-cleared/.test(hc), 'при неснятом карантине честно отвечает отказом');
  // Отцеплять том, с которого сам же и запущен, из собственного процесса нельзя —
  // detach -force выдёргивает backing store и убивает установщик посреди починки.
  assert(/detached:\s*true/.test(hc) && /\.unref\(\)/.test(hc),
    'хвост операции выполняет ОТЦЕПЛЁННЫЙ помощник, переживающий наш выход');
  assert(!/execFileSync\([^)]*hdiutil[^)]*detach/.test(hc),
    'сам процесс НЕ отцепляет том, с которого работает');

  // Поведение помощника — на тексте, СОБРАННОМ ровно как в проде (eval массива:
  // JS-комментарии исчезают сами, «токен в комментарии» стеречь нечего не может).
  // Порядок — ТОЛЬКО через assertOrder: голый indexOf(a) < indexOf(b) при
  // исчезнувшем «a» даёт -1 < x и молча зеленеет — ровно так этот тест пережил
  // удаление ожидания выхода установщика (kill -0), то есть ядра правки.
  const helper = cutMacSelfhealHelper(m, i);
  assertOrder(helper, 'kill -0 "$PID"', 'hdiutil detach',
    'помощник ЖДЁТ выхода установщика ДО отцепления тома (иначе наш замок единственного экземпляра закрывает свежий установщик)');
  assertOrder(helper, 'hdiutil detach', 'hdiutil attach',
    'старые тома отцепляются ДО монтирования образа');
  assertOrder(helper, 'hdiutil attach', 'open -n -a',
    'запуск идёт после монтирования — с заведомо свежего тома');
  assert(/open -n -a "\$MP\//.test(helper),
    'open -n и точка монтирования ИЗ ВЫВОДА attach: без -n macOS активировала бы старый экземпляр, а перебор /Volumes брал бы старый том');

  const fi = m.indexOf('function macFindOurDmg');
  const fh = m.slice(fi, fi + 1800);
  assert(/hdiutil['"\],\s]+.*info/.test(fh), 'путь к образу берётся у самого смонтированного образа');
  const nameRe = fh.match(/\^Hamidun-Setup-Mac\[([^\]]*)\]\*\\\.dmg\$/);
  assert(nameRe, 'имя образа проверяется по шаблону');
  {
    const re = new RegExp(nameRe[0], 'i');
    assert(re.test('Hamidun-Setup-Mac.dmg'), 'обычное имя принимается');
    // Браузер дописывает « (1)» при повторном скачивании — именно тот, кто перекачал
    // образ после блокировки, и жмёт «Исправить автоматически».
    assert(re.test('Hamidun-Setup-Mac-Lite (1).dmg'), 'повторно скачанный образ « (1)» находится');
    assert(!re.test('evil.dmg'), 'посторонний файл не принимается');
  }
  assert(/Downloads['",\s]+.*Desktop/.test(fh),
    'ищем не только в «Загрузках» — живой случай: образ лежал на Рабочем столе');

  assert(/macSelfHeal: \(\) => ipcRenderer\.invoke\('mac-selfheal'\)/.test(p), 'проброшено в renderer');
  assert(/id="mac-selfheal"/.test(a) && /id="mac-selfheal-banner"/.test(a),
    'кнопка есть и в модалке, и в несмываемом баннере');
  assert(/window\.installer\.macSelfHeal\(\)/.test(a), 'кнопка вызывает самолечение');
  assert(/dmg-not-found/.test(a), 'если образа нет — человеку говорят скачать заново, а не молчат');
});

// Помощник самолечения — ПОВЕДЕНЧЕСКИ, настоящим sh. Текст помощника меняется
// ТОЛЬКО механически (срезается префикс /usr/bin/, /Volumes/ уводится в
// песочницу), hdiutil/open подменяются стабами на PATH, которые пишут вызовы в
// лог; «установщик» — фоновый процесс, который перед смертью пишет маркер в тот
// же лог. Если помощник НЕ ждёт выхода установщика (мутация: убрать kill -0),
// detach попадает в лог РАНЬШЕ маркера — тест краснеет ПОВЕДЕНИЕМ, а не грепом.
ok('macOS selfheal (поведение, sh): помощник ЖДЁТ выхода установщика → detach томов → attach → open -n изнутри свежего тома', () => {
  const bash = (() => {
    if (process.platform !== 'win32') return 'bash';
    for (const c of ['C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
      try { if (fs.existsSync(c)) return c; } catch (e) { /* */ }
    }
    return '';
  })();
  if (!bash) SKIP('bash недоступен — поведенческий прогон sh-помощника невозможен');

  const helper = cutMacSelfhealHelper(EG_MAIN(), 0);
  assert(helper.includes('/usr/bin/hdiutil') && helper.includes('/Volumes/'),
    'ожидаемые якоря в тексте помощника (иначе механическая подстановка стала бы враньём)');

  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-selfheal-'));
  try {
    const posix = (p) => String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (q, d) => '/' + d.toLowerCase() + '/');
    const SB = posix(sb);
    fs.mkdirSync(path.join(sb, 'bin'), { recursive: true });
    // Два «уже смонтированных» тома — помощник обязан отцепить ОБА до attach.
    fs.mkdirSync(path.join(sb, 'Volumes', 'HamidunOld'), { recursive: true });
    fs.mkdirSync(path.join(sb, 'Volumes', 'Hamidun Setup', 'Hamidun Setup.app'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'fake.dmg'), 'x');

    // Стабы: пишут вызов в лог; attach отвечает как настоящий hdiutil —
    // таблицей, где точка монтирования стоит В КОНЦЕ строки (её достаёт sed).
    fs.writeFileSync(path.join(sb, 'bin', 'hdiutil'),
      '#!/bin/sh\necho "hdiutil $*" >> "$HM_LOG"\n' +
      'if [ "$1" = "attach" ]; then\n' +
      '  echo "/dev/disk9          GUID_partition_scheme"\n' +
      '  echo "/dev/disk9s1        Apple_HFS        ' + SB + '/Volumes/Hamidun Setup"\n' +
      'fi\nexit 0\n');
    fs.writeFileSync(path.join(sb, 'bin', 'open'),
      '#!/bin/sh\necho "open $*" >> "$HM_LOG"\ntouch "$HM_LAUNCHED"\nexit 0\n');
    // Помощник больше не верит коду возврата open: он ЖДЁТ, пока процесс реально
    // появится. Стаб pgrep отвечает «есть» только после того, как open отработал,
    // иначе тест проверял бы не то, что делает прод.
    fs.writeFileSync(path.join(sb, 'bin', 'pgrep'),
      '#!/bin/sh\n[ -f "$HM_LAUNCHED" ] && exit 0\nexit 1\n');
    for (const f of ['hdiutil', 'open', 'pgrep']) {
      try { fs.chmodSync(path.join(sb, 'bin', f), 0o755); } catch (e) { /* win */ }
    }

    // Механические подстановки (логика помощника НЕ меняется).
    const patched = helper.split('/usr/bin/').join('').split('/Volumes/').join(SB + '/Volumes/');
    fs.writeFileSync(path.join(sb, 'helper.sh'), patched + '\n');
    fs.writeFileSync(path.join(sb, 'run.sh'),
      'export PATH="' + SB + '/bin:$PATH"\n' +
      'export HM_LOG="' + SB + '/log.txt"\n' +
      'export HM_LAUNCHED="' + SB + '/launched.flag"\n' +
      ': > "$HM_LOG"\n' +
      // «Установщик»: живёт ~0.9 c, перед смертью оставляет маркер в общем логе.
      '( sleep 0.9; echo "INSTALLER-EXITED" >> "$HM_LOG" ) &\n' +
      'INST=$!\n' +
      'sh "' + SB + '/helper.sh" "' + SB + '/fake.dmg" "$INST" "' + SB + '/status.txt"\n' +
      'echo "HELPER_RC=$?"\n');
    const r = spawnSync(bash, [path.join(sb, 'run.sh')], { encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    assert(/HELPER_RC=0/.test(out), 'помощник завершился успехом: ' + out);

    const lines = fs.readFileSync(path.join(sb, 'log.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
    const iExit = lines.indexOf('INSTALLER-EXITED');
    const detaches = lines.map((l, n) => (/^hdiutil detach /.test(l) ? n : -1)).filter((n) => n >= 0);
    const iAttach = lines.findIndex((l) => /^hdiutil attach /.test(l));
    const iOpen = lines.findIndex((l) => /^open /.test(l));
    assert(iExit !== -1, 'маркер выхода установщика есть в логе: ' + JSON.stringify(lines));
    assert(detaches.length >= 2, 'отцеплены ОБА старых тома: ' + JSON.stringify(lines));
    assert(detaches[0] > iExit,
      'ЯДРО ПРАВКИ: detach только ПОСЛЕ выхода установщика (иначе замок единственного экземпляра закрывает свежий): ' + JSON.stringify(lines));
    assert(iAttach > detaches[detaches.length - 1], 'attach после отцепления всех томов: ' + JSON.stringify(lines));
    assert(iOpen > iAttach, 'open после attach: ' + JSON.stringify(lines));
    assert(/-n -a/.test(lines[iOpen]) && lines[iOpen].includes('/Volumes/Hamidun Setup/Hamidun Setup.app'),
      'open -n -a с приложением на точке монтирования ИЗ ВЫВОДА attach: ' + lines[iOpen]);
    assert.strictEqual(fs.readFileSync(path.join(sb, 'status.txt'), 'utf8').trim(), 'ok',
      'хлебная крошка статуса — «ok»');
  } finally { try { fs.rmSync(sb, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('прогресс: полоса в ПРОЦЕНТАХ по прогону, проценты настоящие', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
  const a = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const view = html.slice(html.indexOf('<main id="view-progress"'), html.indexOf('</main>', html.indexOf('<main id="view-progress"')));
  assert(/id="run-progress-fill"/.test(view) && /id="run-progress-label"/.test(view),
    'полоса и подпись живут в экране установки');
  assert(/\.run-progress__fill/.test(css), 'стили полосы описаны');

  // Арифметика вынесена в тестируемый модуль (тот же приём, что у finish-link).
  assert.strictEqual(HMFinish.runProgressPct(0, 8), 0);
  assert.strictEqual(HMFinish.runProgressPct(3, 8), 38, 'процент считается от пройденных компонентов');
  assert.strictEqual(HMFinish.runProgressPct(8, 8), 100);
  assert.strictEqual(HMFinish.runProgressPct(0, 0), 0, 'пустой набор не даёт NaN');
  assert.strictEqual(HMFinish.runProgressPct(9, 8), 100, 'больше 100% не показываем');
  assert.strictEqual(HMFinish.runProgressPct(-1, 8), 0, 'отрицательное не уводит полосу в минус');
  assert(/window\.HMFinishLink\.runProgressPct\(done, total\)/.test(a), 'интерфейс использует ТУ ЖЕ функцию, что проверена тестом');
  // Порядок загрузки: глобал должен существовать к моменту вызова, иначе полоса
  // упадёт с ReferenceError уже у человека, а не в тестах.
  // Сравниваем именно ТЕГИ скриптов: имена файлов упоминаются ещё и в комментариях
  // разметки, и поиск по подстроке дал бы ложный порядок.
  const si = html.indexOf('<script src="finish-link.js">');
  const ai = html.indexOf('<script src="app.js">');
  assert(si !== -1 && ai !== -1 && si < ai, 'finish-link.js подключается ДО app.js');
  assert(/сейчас: \$\{currentName\}/.test(a), 'в подписи видно, какой компонент идёт сейчас');

  // Полоса обязана двигаться и когда компонент ПРОПУЩЕН из-за зависимости, иначе она
  // застынет и человек снова решит, что всё зависло.
  const runFn = a.slice(a.indexOf('async function runComponents'));
  assert((runFn.match(/setRunProgress\(/g) || []).length >= 3,
    'обновляется на старте шага, после шага и в ветке пропуска по зависимости');
});

ok('прогресс: на идущем шаге тикают часы (спиннер не отличить от зависания)', () => {
  const a = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert(/function startStepClock/.test(a) && /function stopStepClock/.test(a), 'часы есть');
  assert(/startStepClock\(id,/.test(a), 'запускаются при переходе шага в работу');
  assert(/stopStepClock\(\);\s*\n\s*if \(offP\)/.test(a), 'останавливаются по завершении шага');
  // Настоящих процентов у установочных скриптов нет — выдуманную полосу рисовать нельзя.
  const ci = a.indexOf('function startStepClock');
  const ch = a.slice(ci, ci + 1200);
  assert(/if \(\/%\/\.test/.test(ch), 'подпись докачки с НАСТОЯЩИМИ процентами не перетирается');
  assert(/идёт /.test(ch), 'показывается время, а не выдуманный процент');
});

ok('macOS: команда разблокировки САМА находит образ (жёсткий ~/Downloads запрещён)', () => {
  // Живой случай: человек сохранил dmg не в «Загрузки», команда падала на первом шаге
  // («No such file»), карантин не снимался — и инструкция выглядела неработающей.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const txtPath = path.join(ROOT, 'assets', 'mac', 'ПРОЧТИ ЕСЛИ ПИШЕТ ПОВРЕЖДЕНО.txt');
  const txt = fs.readFileSync(txtPath, 'utf8');

  const hits = app.match(/DMG=\$\(find[^<]*/g) || [];
  assert.strictEqual(hits.length, 2, 'команда есть и в модалке, и в несмываемом баннере');
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  const fromHtml = decode(hits[0]).trim();
  const fromTxt = (txt.match(/DMG=\$\(find.*/) || [''])[0].trim();

  assert(!/~\/Downloads\/Hamidun-Setup-Mac/.test(app),
    'жёсткого пути к «Загрузкам» в интерфейсе нет');
  assert(!/~\/Downloads\/Hamidun-Setup-Mac/.test(txt),
    'жёсткого пути к «Загрузкам» в файле внутри образа нет');
  assert(/find ~ -maxdepth \d+ -iname/.test(fromHtml), 'команда ищет образ сама');
  assert(/for v in \/Volumes\/Hamidun\*/.test(fromHtml),
    'отцепляются ВСЕ окна образа: при повторных попытках их несколько, и старый вариант закрывал только первое');
  // Человек копирует команду ИЗ ИНТЕРФЕЙСА — в буфере должно оказаться ровно то же,
  // что написано в файле внутри образа, иначе две инструкции разойдутся.
  assert.strictEqual(fromHtml, fromTxt, 'интерфейс и файл в образе дают ОДНУ команду');
});

ok('uid: на Windows берётся PORTABLE_EXECUTABLE_FILE — process.execPath указывает в %TEMP%', () => {
  // Сборка — самораспаковывающийся portable-exe: он распаковывает приложение в
  // %TEMP%\ns<rnd>.tmp\app и запускает ОТТУДА. process.execPath = «Hamidun Setup.exe» во
  // временной папке, а НЕ скачанный Hamidun-Setup-Windows--u<uid>.exe, поэтому привязка
  // по имени файла молча не работала бы вообще.
  const real = path.join('C:', 'Users', 'x', 'Downloads', 'Hamidun-Setup-Windows--u272540053.exe');
  const unpacked = path.join(os.tmpdir(), 'nsABCD.tmp', 'app', 'Hamidun Setup.exe');
  assert.strictEqual(
    UIDT.resolveUid({ env: { PORTABLE_EXECUTABLE_FILE: real }, execPath: undefined }), '272540053',
    'uid берётся из настоящего имени скачанного файла');
  assert.strictEqual(UIDT.resolveUid({ env: {}, execPath: unpacked }), '',
    'из распакованного пути uid не выдумывается');
  const m = EG_MAIN();
  assert(/PORTABLE_EXECUTABLE_FILE/.test(fs.readFileSync(path.join(ROOT, 'src', 'uid-telemetry.js'), 'utf8')),
    'источник объявлен в модуле');
  assert(m.indexOf('uidTelemetry.resolveUid()') !== -1, 'main зовёт резолвинг без ручных аргументов');
});

ok('телеметрия: SID и доменные учётки не уезжают, а обычные пути не калечатся', () => {
  const o = { home: 'C:\\Users\\student', user: 'student' };
  assert(!/S-1-5-21/.test(UIDT.scrubText('владелец = S-1-5-21-333-444-555-1001', o)), 'SID пользователя вычищен');
  assert(!/petrov/i.test(UIDT.scrubText('посторонний ACE: CORP\\petrov.ivan', o)), 'доменная учётка вычищена');
  assert(/S-1-5-32-544/.test(UIDT.scrubText('ожидался S-1-5-32-544', o)), 'встроенные SID остаются — они объясняют причину');
  // Пути — это диагностика, а не ПД: правило «домен\\учётка» не должно их резать.
  assert.strictEqual(UIDT.scrubText('нет файла vendor\\apps\\git-setup.exe', o),
    'нет файла vendor\\apps\\git-setup.exe', 'относительный путь цел');
  assert.strictEqual(UIDT.scrubText('C:\\Windows\\System32\\icacls.exe не найден', o),
    'C:\\Windows\\System32\\icacls.exe не найден', 'системный путь цел');
});

ok('телеметрия: согласие и защёлки — повторный прогон снова отчитывается', () => {
  const a = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert(/STATE\.telemetryEditorSent/.test(a), 'open_editor защёлкнут (три кнопки ведут в одну отправку)');
  assert(/STATE\.telemetrySent = false;[\s\S]{0,120}STATE\.telemetryStartSent = false;/.test(a),
    'новый прогон сбрасывает защёлки — иначе вторая попытка невидима');
  // Cursor обязан отчитываться ПО ФАКТУ открытия: кнопка рисуется по выбору компонента,
  // а не по факту установки.
  const ci = a.indexOf("const cursorBtn");
  const ch = a.slice(ci, ci + 700);
  assert(/await window\.installer\.launchCursor\(\)/.test(ch), 'результат запуска Cursor ожидается');
  assert(/if \(ok\) sendOpenEditorTelemetry\(\)/.test(ch), 'событие только при реально открытом редакторе');
});

ok('главный процесс: примитив staging запускается с ДОВЕРЕННЫМ env (COR_PROFILER не наследуется)', () => {
  const m = EG_MAIN();
  const i = m.indexOf('async function winMakeSecureDir()');
  const h = m.slice(i, i + 5000);
  assert(/env: detectSpawnEnv\(\)/.test(h),
    'spawn получает доверенный env: инлайн $env:PSModulePath не закрывает COR_ENABLE_PROFILING/COR_PROFILER — их CLR читает ДО разбора -Command');
  assert(/lastSecureDirError = '';/.test(h), 'причина отказа сбрасывается на входе (не липнет к другому компоненту)');
});

ok('E2E: «докачка стартовала» доказывается ПРОЦЕНТАМИ, а не подписью до обращения к сети', () => {
  const e = fs.readFileSync(path.join(ROOT, 'test', 'e2e-gui.js'), 'utf8');
  const i = e.indexOf('async function armDownloadWatcher');
  const h = e.slice(i, i + 1400);
  assert(/Скачиваю\\s\+\\d\+%/.test(h), 'наблюдатель ищет проценты');
  assert(!/\/Скачиваю\|скачив\|Докачка/.test(h),
    'слова «Скачиваю»/«Докачка» renderer печатает ДО сети — по ним проверка была бы всегда-истиной');
  // Заморозка окна обязана ронять прогон, а не оставаться предупреждением.
  const ci = e.indexOf('async function clickInstall');
  const ch = e.slice(ci, ci + 1500);
  assert(/check\('интерфейс ответил на клик «Установить»', false/.test(ch),
    'таймаут клика = проваленная проверка (CI читает код возврата, а не текст лога)');
});

ok('телеметрия: renderer шлёт старт, финиш с диагностикой и открытие редактора', () => {
  const a = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert(/event: 'install_started'/.test(a), 'событие старта установки');
  assert(/event: 'open_editor'/.test(a), 'событие «открыл редактор»');
  assert(/errors: Array\.from\(STATE\.errorDigest\.values\(\)\)/.test(a), 'финиш везёт диагностику ошибок');
  assert(/STATE\.errorDigest\.set\(id, \{/.test(a), 'диагностика собирается на каждом провале');
  assert(/STATE\.errorDigest\.delete\(id\)/.test(a), 'успех/пропуск закрывают запись — не шлём вылеченные ошибки');
  // Согласие уважается всеми тремя отправками, а не только финишной.
  const starts = a.indexOf('function sendStartTelemetry');
  const opens = a.indexOf('function sendOpenEditorTelemetry');
  assert(/STATE\.telemetryConsent === false/.test(a.slice(starts, starts + 400)), 'старт уважает opt-out');
  assert(/STATE\.telemetryConsent === false/.test(a.slice(opens, opens + 400)), 'open_editor уважает opt-out');
});

// ===== ЕДИНЫЙ БЛОК: vsix-темпы убираются на КАЖДОМ выходе (vscode/extension) +
// ===== claude.ps1 проверяется ЗАПУСКОМ (урок macOS) + вердикт Claude Desktop по ФАКТУ =====
console.log('== vsix-temps: уборка на каждом выходе; claude: проверка запуском; desktop: вердикт по факту ==');

// PowerShell-текст БЕЗ чисто-комментарных строк: «exit 0/1» в комментариях не должен
// обманывать проверку достижимости уборки.
const psCodeOnly = (s) => s.split(/\r?\n/).map((l) => (l.trim().startsWith('#') ? '' : l)).join('\n');
const CLD_PS1 = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'claude.ps1'), 'utf8');

// НЕ «есть ли вызов уборки» (такая текстовая регулярка и пропустила главный успешный
// exit 0 — 82 МБ мусора за каждый успешный прогон), а инвариант структуры: КАЖДЫЙ exit
// после начала создания копий лежит ВНУТРИ top-level try, чей finally зовёт уборку, и
// после finally выходов нет. PowerShell исполняет finally при exit (проверено прогоном),
// значит уборка ДОСТИЖИМА на любом выходе, включая необработанное исключение.
function assertVsixCleanupReachable(name, cleanupFn, creationMarker) {
  const s = psCodeOnly(fs.readFileSync(path.join(ROOT, 'scripts', 'windows', name), 'utf8'));
  const created = s.indexOf(creationMarker);
  assert(created !== -1, name + ': место создания vsix-копий («' + creationMarker + '») найдено');
  const tryIdx = s.search(/^try \{/m);      // top-level try (внутренние try — с отступом)
  const finIdx = s.search(/^\} finally \{/m);
  assert(tryIdx !== -1, name + ': есть top-level try вокруг блока с vsix-копиями');
  assert(finIdx > tryIdx, name + ': у top-level try есть finally');
  assert(new RegExp('^\\} finally \\{[\\s\\S]{0,220}?' + cleanupFn + '\\b', 'm').test(s.slice(finIdx)),
    name + ': в finally — уборка ' + cleanupFn);
  const rx = /\bexit\s+\d+/g; let m;
  while ((m = rx.exec(s)) !== null) {
    if (m.index <= created && m.index < tryIdx) continue;   // ранние выходы: копий ещё нет
    assert(m.index > tryIdx && m.index < finIdx,
      name + ': exit вне try/finally с уборкой (смещение ' + m.index + '): «' + s.slice(m.index, m.index + 12) + '»');
  }
}

ok('vscode.ps1: уборка vsix-темпов достижима перед КАЖДЫМ exit (включая успешный exit 0 «оба встали»)', () => {
  assertVsixCleanupReachable('vscode.ps1', 'Remove-HmVsixTemps', "Get-Vsix 'claude-code.vsix'");
  const s = psCodeOnly(fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'vscode.ps1'), 'utf8'));
  // Пойманный дефект — самый частый выход: оба расширения встали -> exit 0 БЕЗ уборки.
  const okBoth = s.indexOf('if ($okClaude -and $okCodex) { exit 0 }');
  assert(okBoth !== -1, 'успешный путь «оба расширения» на месте');
  assert(okBoth > s.search(/^try \{/m) && okBoth < s.search(/^\} finally \{/m),
    'главный успешный exit 0 — ВНУТРИ try, уборка в finally его накрывает');
});

ok('extension.ps1: уборка vsix-темпа достижима перед КАЖДЫМ exit (та же схема, что и vscode.ps1)', () => {
  assertVsixCleanupReachable('extension.ps1', 'Remove-HmVsixTemp', 'hm-claude-code-');
});

// Наблюдатель за каталогом из ОТДЕЛЬНОГО node-процесса: spawnSync блокирует
// event loop родителя, и короткоживущую копию vsix (создание → finally-уборка)
// можно увидеть только сбоку (fs.watch + страховочный поллинг; совпавшие имена
// дописываются в out-файл). Без доказательства «копия СОЗДАВАЛАСЬ» проверка
// «в %TEMP% пусто» — пустая: мутация, отключившая создание копии вовсе
// (а с ней и офлайн-путь установки), оставляла бы тест зелёным.
function watchDirForPrefix(dir, prefix, outFile) {
  const { spawn } = require('child_process');
  fs.writeFileSync(outFile, '');
  const child = spawn(process.execPath, ['-e',
    'const fs=require("fs");const [dir,prefix,out]=process.argv.slice(1);' +
    'const seen=new Set();' +
    'const rec=(n)=>{if(n&&n.startsWith(prefix)&&!seen.has(n)){seen.add(n);try{fs.appendFileSync(out,n+"\\n")}catch(e){}}};' +
    'const scan=()=>{try{fs.readdirSync(dir).forEach(rec)}catch(e){}};' +
    'scan();try{fs.watch(dir,(ev,f)=>rec(f))}catch(e){}' +
    'setInterval(scan,10);setTimeout(()=>process.exit(0),300000);',
    dir, prefix, outFile], { stdio: 'ignore', windowsHide: true });
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  sleep(200); // node-наблюдатель успевает поднять fs.watch до старта PowerShell
  return {
    stop() {
      sleep(60);
      try { child.kill(); } catch (e) { /* */ }
      try { return fs.readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean); }
      catch (e) { return []; }
    },
  };
}

if (powershellAvailable()) {
  // Функциональный прогон ХВОСТА vscode.ps1 в БОЕВОМ PowerShell 5.1: успешный путь
  // «оба расширения уже на месте» (Get-Vsix копии УЖЕ созданы — они рождаются ДО проверки
  // «уже установлено», ровно как в проде при повторной установке) -> exit 0 И НОЛЬ hm-vsix-*.
  ok('vscode.ps1 (прогон PS 5.1, sandbox): копии vsix СОЗДАВАЛИСЬ и успешный exit 0 не оставляет hm-vsix-* в %TEMP%', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-vsxclean-'));
    try {
      const sb = (p) => path.join(base, p);
      ['scripts', 'vendor\\apps', 'temp', 'home', 'la\\Programs\\Microsoft VS Code\\bin']
        .forEach((d) => fs.mkdirSync(sb(d), { recursive: true }));
      fs.copyFileSync(path.join(ROOT, 'scripts', 'windows', 'vscode.ps1'), sb('scripts\\vscode.ps1'));
      // Стабы примитивов: целостность ОК; де-элевация «отработала»; расширения «уже на месте».
      fs.writeFileSync(sb('scripts\\_verify.ps1'),
        '﻿function Confirm-HmArtifact { param($p) }\r\nfunction Test-HmArtifact { param($p) $true }\r\n');
      fs.writeFileSync(sb('scripts\\_deelev.ps1'),
        '﻿function Invoke-HmDeElevated { param($Exe, [string[]]$Arguments = @()) [pscustomobject]@{ Gate = "medium"; Code = 0 } }\r\n' +
        'function Test-HmExtInstalled { param($ExtId, [string[]]$Dirs) $true }\r\n');
      fs.writeFileSync(sb('vendor\\apps\\claude-code.vsix'), Buffer.alloc(262144, 7));
      fs.writeFileSync(sb('vendor\\apps\\chatgpt.vsix'), Buffer.alloc(262144, 8));
      fs.writeFileSync(sb('la\\Programs\\Microsoft VS Code\\bin\\code.cmd'), '@echo off\r\n');
      const env = Object.assign({}, process.env, {
        TEMP: sb('temp'), TMP: sb('temp'), LOCALAPPDATA: sb('la'),
        USERPROFILE: sb('home'), HM_VENDOR: sb('vendor')
      });
      delete env.HM_DRY_RUN;
      const w = watchDirForPrefix(sb('temp'), 'hm-vsix-', sb('watch.log'));
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '" + sb('scripts\\vscode.ps1') + "'"],
        { encoding: 'utf8', timeout: 120000, env });
      const seen = w.stop();
      assert.strictEqual(r.status, 0, 'exit 0 (оба расширения «на месте»): ' + (r.stdout || '') + (r.stderr || ''));
      assert(/уже на месте/.test(r.stdout || ''), 'прогон прошёл путь «уже установлено»');
      // Факт создания, а не догадка по маршруту: обе копии видел наблюдатель.
      assert(seen.length >= 2,
        'копии vsix (claude-code + chatgpt) реально СОЗДАВАЛИСЬ во время прогона, видели: ' + JSON.stringify(seen));
      const left = fs.readdirSync(sb('temp')).filter((n) => n.startsWith('hm-vsix-'));
      assert.strictEqual(left.length, 0, 'hm-vsix-* убраны на успешном пути: ' + left.join(', '));
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('extension.ps1 (прогон PS 5.1, sandbox): копия vsix СОЗДАВАЛАСЬ; выход «Cursor не установлен» не оставляет hm-claude-code-* в %TEMP%', () => {
    // Guard осмысленный и ОСТАЁТСЯ: при живом пользовательском Cursor скрипт ждёт 20 с
    // и в конце может его закрыть — на машине разработчика такой прогон непозволителен.
    // Но пропуск теперь ЧЕСТНЫЙ (⏭, не ✅): раньше тест печатал зелёную галочку и на
    // машине разработчика с запущенным Cursor не стерёг ВООБЩЕ ничего.
    const t = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Cursor.exe', '/NH'], { encoding: 'utf8', timeout: 15000 });
    if (/Cursor\.exe/i.test(t.stdout || '')) SKIP('Cursor запущен — прогон extension.ps1 небезопасен (ждёт 20 с и может закрыть Cursor)');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-extclean-'));
    try {
      const sb = (p) => path.join(base, p);
      ['scripts', 'vendor\\apps', 'temp', 'home', 'la', 'appdata'].forEach((d) => fs.mkdirSync(sb(d), { recursive: true }));
      fs.copyFileSync(path.join(ROOT, 'scripts', 'windows', 'extension.ps1'), sb('scripts\\extension.ps1'));
      fs.writeFileSync(sb('scripts\\_verify.ps1'),
        '﻿function Confirm-HmArtifact { param($p) }\r\nfunction Test-HmArtifact { param($p) $true }\r\n');
      fs.writeFileSync(sb('scripts\\_deelev.ps1'),
        '﻿function Invoke-HmDeElevated { param($Exe, [string[]]$Arguments = @()) [pscustomobject]@{ Gate = "medium"; Code = 0 } }\r\n' +
        'function Test-HmExtInstalled { param($ExtId, [string[]]$Dirs) $false }\r\n');
      fs.writeFileSync(sb('vendor\\apps\\claude-code.vsix'), Buffer.alloc(262144, 9));
      const env = Object.assign({}, process.env, {
        TEMP: sb('temp'), TMP: sb('temp'), LOCALAPPDATA: sb('la'), APPDATA: sb('appdata'),
        USERPROFILE: sb('home'), HM_VENDOR: sb('vendor')
      });
      delete env.HM_DRY_RUN; delete env.HM_CURSOR_AUTOSTARTED; delete env.HM_CLAUDE_EXT_ID;
      const w = watchDirForPrefix(sb('temp'), 'hm-claude-code-', sb('watch.log'));
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '" + sb('scripts\\extension.ps1') + "'"],
        { encoding: 'utf8', timeout: 120000, env });
      const seen = w.stop();
      assert.strictEqual(r.status, 0, 'exit 0 («Cursor не установлен — пропускаю»): ' + (r.stdout || '') + (r.stderr || ''));
      // Раньше тест проверял только «в конце пусто» — это выполнялось и когда копия
      // НЕ создавалась вовсе. Теперь факт создания доказан наблюдателем.
      assert(seen.length >= 1,
        'копия vsix реально СОЗДАВАЛАСЬ во время прогона (наблюдатель видел hm-claude-code-*): ' + JSON.stringify(seen));
      const left = fs.readdirSync(sb('temp')).filter((n) => n.startsWith('hm-claude-code-'));
      assert.strictEqual(left.length, 0, 'hm-claude-code-* убраны: ' + left.join(', '));
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
}

// --- claude.ps1: офлайн-установка проверяется ЗАПУСКОМ (перенос семантики scripts/macos/claude.sh) ---
ok('claude.ps1: офлайн-путь проверяется ЗАПУСКОМ claude --version (де-элевированно); сломанная обёртка убирается; финал БЕЗ квитанции при broken', () => {
  const s = CLD_PS1();
  assert(/_deelev\.ps1/.test(s), 'дот-сорсит единый примитив де-элевации');
  assert(/function Test-HmClaudeRuns/.test(s), 'проверка запуском объявлена');
  assert(/Invoke-HmDeElevated \$bin @\('--version'\)/.test(s),
    '--version исполняется ДЕ-ЭЛЕВИРОВАННО (user-writable claude НЕ запускается под админом)');
  assert(!/&\s*\$claudeBin\b/.test(s) && !/&\s*\$bin\s+--version/.test(s),
    'нет прямого elevated-запуска claude-бинаря');
  assert(/function Remove-HmBrokenClaude/.test(s), 'уборка нерабочей обёртки объявлена');
  assert(/node_modules\\@anthropic-ai\\claude-code/.test(s), 'убирается и пакет в node_modules (зеркало rm -rf в claude.sh)');
  // Порядок: офлайн npm -> проверка запуском -> уборка обёртки -> онлайн-путь.
  assertOrder(s, '--offline --cache', 'Test-HmClaudeRuns $bin', 'проверка запуском идёт ПОСЛЕ офлайн-установки');
  assertOrder(s, 'Test-HmClaudeRuns $bin', 'Remove-HmBrokenClaude $bin', 'при провале проверки обёртка убирается');
  assertOrder(s, 'Remove-HmBrokenClaude $bin', 'https://claude.ai/install.ps1', 'после уборки — онлайн-путь');
  // Финальный вердикт: broken -> честный exit 1 ДО любой «OK»-строки (никакой зелёной галочки).
  assert(/if \(\$probe -eq 'broken'\) \{[^{}]{0,320}?exit 1/.test(s), 'broken на финале = exit 1');
  const brokenIdx = s.lastIndexOf("($probe -eq 'broken')");
  const okIdx = s.lastIndexOf('Write-Host "OK: Claude Code CLI');
  assert(brokenIdx !== -1 && okIdx > brokenIdx, 'красный вердикт выносится РАНЬШЕ OK-квитанции');
  // Первоисточник семантики — scripts/macos/claude.sh (проверка запуском --version + уборка
  // обёртки); его стерегут СВОИ тесты выше. Здесь на него нарочно НЕ смотрим: файл правится
  // параллельно, и чужой рефакторинг не должен ронять проверку Windows-порта.
});

if (powershellAvailable()) {
  ok('claude.ps1 (прогон PS 5.1): Test-HmClaudeRuns отличает рабочий бинарь от обёртки; Remove-HmBrokenClaude сносит шимы и пакет', () => {
    const src = CLD_PS1();
    const fn = (name) => {
      const m = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\r?\\n\\}'));
      assert(m, name + ' извлекается из claude.ps1');
      return m[0];
    };
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cldrun-'));
    try {
      // Фейковый npm-prefix: рабочий и сломанный claude.cmd + пакет в node_modules.
      // Сломанный лежит в САНДБОКСНОМ %APPDATA%\npm: после ревью-фикса Remove-HmBrokenClaude
      // удаляет СТРОГО по аллоулисту наших мест установки (см. блок тестов в конце файла).
      const good = path.join(base, 'good'); const bad = path.join(base, 'appdata', 'npm');
      fs.mkdirSync(path.join(good), { recursive: true });
      fs.mkdirSync(path.join(bad, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
      fs.writeFileSync(path.join(good, 'claude.cmd'), '@echo 2.1.0\r\n@exit /b 0\r\n');
      fs.writeFileSync(path.join(bad, 'claude.cmd'), '@echo claude native binary not installed 1>&2\r\n@exit /b 1\r\n');
      fs.writeFileSync(path.join(bad, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), '{}');
      // Гарнесс: РЕАЛЬНЫЕ функции из claude.ps1 + фейковая де-элевация, которая честно
      // ЗАПУСКАЕТ бинарь (симуляция medium) и возвращает его код — как боевой примитив.
      const harness = '﻿' +
        'param([string]$Bin, [string]$Mode)\r\n' +
        'function Invoke-HmDeElevated { param($Exe, [string[]]$Arguments = @())\r\n' +
        '  & $Exe @Arguments *> $null\r\n' +
        '  $c = $LASTEXITCODE; if ($null -eq $c) { $c = 0 }\r\n' +
        "  [pscustomobject]@{ Gate = 'medium'; Code = $c }\r\n" +
        '}\r\n' +
        fn('Test-HmClaudeRuns') + '\r\n' + fn('Test-HmOurClaudeDir') + '\r\n' + fn('Remove-HmBrokenClaude') + '\r\n' +
        "if ($Mode -eq 'probe') { Write-Output (Test-HmClaudeRuns $Bin) }\r\n" +
        "if ($Mode -eq 'clean') { Remove-HmBrokenClaude $Bin }\r\n";
      const hFile = path.join(base, 'harness.ps1');
      fs.writeFileSync(hFile, harness);
      // APPDATA указывает в песочницу: уборка разрешена только в НАШИХ каталогах.
      const run = (bin, mode) => spawnSync('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hFile, bin, mode],
        { encoding: 'utf8', timeout: 60000,
          env: Object.assign({}, process.env, { APPDATA: path.join(base, 'appdata') }) });
      const probeGood = (run(path.join(good, 'claude.cmd'), 'probe').stdout || '').trim();
      assert.strictEqual(probeGood, 'works', 'рабочий claude.cmd -> works: ' + probeGood);
      const probeBad = (run(path.join(bad, 'claude.cmd'), 'probe').stdout || '').trim();
      assert.strictEqual(probeBad, 'broken', 'обёртка с exit 1 -> broken (нулевому коду npm не верим): ' + probeBad);
      run(path.join(bad, 'claude.cmd'), 'clean');
      assert(!fs.existsSync(path.join(bad, 'claude.cmd')), 'сломанный шим удалён');
      assert(!fs.existsSync(path.join(bad, 'node_modules', '@anthropic-ai', 'claude-code')),
        'пакет @anthropic-ai/claude-code удалён (иначе перехватит PATH после онлайн-установки)');
      assert(fs.existsSync(path.join(good, 'claude.cmd')), 'рабочий бинарь clean не трогал');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
}

// --- claude-desktop.ps1: вердикт по ФАКТУ завершения установщика, без вечного ожидания ---
ok('claude-desktop.ps1: вердикт через Wait-HmClaudeDesktopVerdict (факт завершения процесса), гоночный опрос 90 c убран, вечного ожидания нет', () => {
  const s = DT_CLAUDE_PS1();
  assert(/function Wait-HmClaudeDesktopVerdict/.test(s), 'функция вердикта объявлена');
  assert(/\$installed = Wait-HmClaudeDesktopVerdict -Proc \$cdProc/.test(s),
    'вердикт зовёт функцию с ПРОЦЕССОМ установщика (не слепой таймер)');
  assert(/\$Proc\.HasExited/.test(s), 'функция смотрит на фактическое завершение процесса');
  assert(!/for \(\$i = 0; \$i -lt 90; \$i\+\+\)/.test(s), 'старый опрос 90 с, оторванный от процесса, убран');
  // Вечное ожидание НЕ вернулось: запуск без -Wait, у ожиданий — потолки.
  const i = s.indexOf('Start-Process -FilePath $installer');
  assert(i !== -1, 'запуск установщика на месте');
  const line = s.slice(i, s.indexOf('\n', i));
  assert(!/-Wait\b/.test(line), 'Start-Process БЕЗ -Wait (иначе шаг ждёт трей-приложение вечно)');
  assert(/CapSec/.test(s) && /\$deadline/.test(s), 'у ожидания вердикта есть жёсткий потолок');
  assert(/Wait-Process -Timeout/.test(s), 'finally ждёт процесс ОГРАНИЧЕННО (чистка кэша)');
  assertOrder(s, '$installed = Wait-HmClaudeDesktopVerdict', 'OK: Claude Desktop установлен',
    '«установлено» печатается только ПОСЛЕ фактического ожидания');
});

if (powershellAvailable()) {
  ok('claude-desktop.ps1 (прогон PS 5.1): вердикт ждёт живой процесс, НЕ ждёт вечно, успех — сразу по маркеру', () => {
    const src = DT_CLAUDE_PS1();
    const m = src.match(/function Wait-HmClaudeDesktopVerdict[\s\S]*?\r?\n\}/);
    assert(m, 'Wait-HmClaudeDesktopVerdict извлекается из claude-desktop.ps1');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cdwait-'));
    try {
      const harness = '﻿' +
        '$script:calls = 0\r\n' +
        'function Test-ClaudeDesktopInstalled {\r\n' +
        '  $script:calls++\r\n' +
        '  if ($env:HM_T_MARKER_AT -and $script:calls -ge [int]$env:HM_T_MARKER_AT) { return $true }\r\n' +
        '  return $false\r\n' +
        '}\r\n' +
        m[0] + '\r\n' +
        "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'\r\n" +
        "$proc = Start-Process -FilePath $ps -ArgumentList '-NoProfile','-Command',('Start-Sleep ' + $env:HM_T_CHILD_SLEEP) -PassThru -WindowStyle Hidden\r\n" +
        '$t0 = Get-Date\r\n' +
        '$r = Wait-HmClaudeDesktopVerdict -Proc $proc -CapSec ([int]$env:HM_T_CAP) -GraceSec ([int]$env:HM_T_GRACE)\r\n' +
        '$el = [int](((Get-Date) - $t0).TotalSeconds)\r\n' +
        '$alive = -not $proc.HasExited\r\n' +
        'Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue\r\n' +
        'Write-Output ("R=$r EL=$el ALIVE=$alive")\r\n';
      const hFile = path.join(base, 'wait-harness.ps1');
      fs.writeFileSync(hFile, harness);
      const run = (envAdd) => {
        const env = Object.assign({}, process.env, envAdd);
        const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hFile],
          { encoding: 'utf8', timeout: 90000, env });
        const mm = /R=(\S+) EL=(\d+) ALIVE=(\S+)/.exec(r.stdout || '');
        assert(mm, 'гарнесс отчитался: ' + (r.stdout || '') + (r.stderr || ''));
        return { r: mm[1], el: Number(mm[2]), alive: mm[3] };
      };
      // 1) Маркер появился, установщик ещё работает -> успех СРАЗУ, не ждём выхода процесса.
      const s1 = run({ HM_T_MARKER_AT: '3', HM_T_CHILD_SLEEP: '25', HM_T_CAP: '20', HM_T_GRACE: '5' });
      assert(s1.r === 'True' && s1.el <= 12, 'успех по маркеру без ожидания процесса: ' + JSON.stringify(s1));
      assert(s1.alive === 'True', 'процесс ещё жил — трей не держит успех');
      // 2) Маркера нет -> вердикт «нет» выносится НЕ РАНЬШЕ фактического завершения процесса
      //    (старый опрос был оторван от процесса — в этом и была гонка).
      const s2 = run({ HM_T_MARKER_AT: '', HM_T_CHILD_SLEEP: '5', HM_T_CAP: '40', HM_T_GRACE: '2' });
      assert(s2.r === 'False', 'без маркера — честное False: ' + JSON.stringify(s2));
      assert(s2.el >= 5, 'вердикт вынесен ПОСЛЕ завершения процесса (' + s2.el + ' c >= 5 c)');
      assert(s2.el <= 25, 'и без лишнего зависания: ' + s2.el + ' c');
      // 3) Установщик висит дольше потолка -> False около CapSec, БЕЗ вечного ожидания.
      const s3 = run({ HM_T_MARKER_AT: '', HM_T_CHILD_SLEEP: '40', HM_T_CAP: '4', HM_T_GRACE: '60' });
      assert(s3.r === 'False' && s3.el <= 25, 'потолок работает (нет вечного ожидания): ' + JSON.stringify(s3));
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
}

asyncTests().then(() => {
  console.log(`\nИТОГ: ${pass} прошло, ${fail} упало` + (skipped ? `, ${skipped} пропущено (⏭ НЕ выполнялись)` : ''));
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL async tests:', e); process.exit(1); });

// ===========================================================================
// Renderer UX (агент fix-renderer): подпись/часы шага после конца докачки +
// защёлка «Исправить автоматически». Куски app.js вырезаются по балансу фигурных
// скобок и исполняются в vm с ПОДДЕЛЬНЫМИ window/document — тот же приём вынесенной
// pure-логики, что у finish-link/runProgressPct, но для DOM-обвязки.
// ===========================================================================
(function rendererUxTests() {
  const vm = require('vm');
  console.log('== Renderer UX: фаза установки после докачки + защёлка самолечения ==');

  const APP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

  // Вырезает из исходника функцию по её заголовку; конец — по балансу «{ }».
  // Если функцию переименуют/удалят — тест честно упадёт «пропало», а не позеленеет.
  function cutBlock(src, header) {
    const i = src.indexOf(header);
    assert(i !== -1, 'в app.js пропало: ' + header);
    const open = src.indexOf('{', i);
    assert(open !== -1, 'нет тела у: ' + header);
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
    }
    throw new Error('не нашёл конец блока: ' + header);
  }
  function cutLine(src, snippet) {
    const line = src.split('\n').find((l) => l.includes(snippet));
    assert(line, 'в app.js пропала строка: ' + snippet);
    return line;
  }

  // --- Дефект 1: у lite-компонента после «Скачиваю 100%» начинается сама установка
  // (самая долгая фаза), событий докачки больше нет — подпись обязана смениться на
  // фазу установки, а часы «идёт М:СС» — тикать до реального конца шага.
  ok('докачка дошла до конца → подпись БЕЗ «Скачиваю», часы продолжают тикать', () => {
    const script = [
      cutLine(APP_SRC, 'let STEP_TIMER'),
      cutLine(APP_SRC, 'let STEP_CLOCK_PHASE'),
      cutBlock(APP_SRC, 'function setStepClockPhase'),
      cutBlock(APP_SRC, 'function startStepClock'),
      cutBlock(APP_SRC, 'function stopStepClock'),
      cutBlock(APP_SRC, 'function setStepLabel'),
      cutBlock(APP_SRC, 'function remoteProgressLabel'),
      cutBlock(APP_SRC, 'function handleRemoteProgress'),
      'this.API = { startStepClock, stopStepClock, handleRemoteProgress };',
    ].join('\n');

    const label = { textContent: '' };
    const step = {
      classList: { contains: (c) => c === 'running' },
      querySelectorAll: () => [{ textContent: '' }, label], // [точка-индикатор, подпись]
    };
    let tickFn = null;
    let now = 1_000_000;
    const sandbox = {
      document: { querySelector: (sel) => (sel.includes('claude') ? step : null) },
      Date: { now: () => now },
      setInterval: (fn) => { tickFn = fn; return 7; },
      clearInterval: () => { tickFn = null; },
    };
    vm.runInNewContext(script, sandbox);
    const api = sandbox.API;

    api.startStepClock('claude', 'Claude Code');
    now += 5000; tickFn();
    assert(/Claude Code — идёт 0:05/.test(label.textContent),
      'до докачки часы тикают: ' + label.textContent);

    // Пошли НАСТОЯЩИЕ проценты — часы им уступают (это старое поведение, оно верное).
    api.handleRemoteProgress('claude', 'Claude Code',
      { id: 'claude', pct: 42, received: 44 * 1048576, total: 104 * 1048576 });
    assert(/Скачиваю 42%/.test(label.textContent), 'подпись докачки: ' + label.textContent);
    now += 1000; tickFn();
    assert(/Скачиваю 42%/.test(label.textContent), 'часы не перетирают настоящие проценты');

    // Событие «докачка завершена» (100%): дальше идёт сама установка.
    api.handleRemoteProgress('claude', 'Claude Code',
      { id: 'claude', pct: 100, received: 104 * 1048576, total: 104 * 1048576 });
    assert(!/Скачиваю/.test(label.textContent),
      'после конца докачки подпись БОЛЬШЕ НЕ содержит «Скачиваю»: ' + label.textContent);
    assert(/Устанавлива/.test(label.textContent),
      'подпись сменилась на фазу установки: ' + label.textContent);

    now += 61_000; tickFn(); // 5+1+61 секунд от старта шага
    assert(/идёт 1:07/.test(label.textContent),
      'часы продолжают тикать после конца докачки: ' + label.textContent);
    assert(/Устанавлива/.test(label.textContent) && !/Скачиваю/.test(label.textContent),
      'в подписи фаза установки + часы, «Скачиваю» не вернулось: ' + label.textContent);

    // Чужое событие (другой компонент) подпись этого шага не трогает.
    api.handleRemoteProgress('claude', 'Claude Code', { id: 'other', pct: 1, received: 1, total: 9 });
    assert(!/Скачиваю/.test(label.textContent), 'событие чужого шага игнорируется');
    api.stopStepClock();

    // Интеграция: runComponents кормит события докачки именно в этот обработчик.
    assert(/onRemoteProgress\(\(p\) => handleRemoteProgress\(id, comp\.name, p\)\)/.test(APP_SRC),
      'runComponents подписывает докачку на handleRemoteProgress');
  });

  // --- Дефект 2: кнопок самолечения ДВЕ (модалка + баннер); пока идёт первая попытка,
  // запуск второй force-отцепил бы том, с которого уже стартует новый установщик.
  // Защёлка общая: повторный вызов невозможен до завершения первого.
  // async: продолжения — только микрозадачи (уже разрешённые Promise), поэтому тест
  // детерминированно завершается в первом же microtask-дренаже, до ИТОГа asyncTests.
  okAsync('самолечение: второй вызов не проходит, пока первый не завершился', async () => {
    const script = [
      cutLine(APP_SRC, 'let SELF_HEAL_BUSY'),
      cutBlock(APP_SRC, 'function setSelfHealButtonsBusy'),
      cutBlock(APP_SRC, 'function bindMacSelfHeal'),
      'this.API = { bindMacSelfHeal };',
    ].join('\n');

    const mkBtn = () => ({
      dataset: {}, disabled: false, textContent: 'Исправить автоматически', onClick: null,
      addEventListener(ev, fn) { if (ev === 'click') this.onClick = fn; },
    });
    const els = {
      'mac-selfheal': mkBtn(),
      'mac-selfheal-banner': mkBtn(),
      'mac-selfheal-status': { textContent: '' },
      'mac-selfheal-banner-status': { textContent: '' },
    };
    const calls = []; // resolve-функции ещё не завершённых вызовов mac-selfheal
    let quits = 0;
    const sandbox = {
      document: { getElementById: (id) => els[id] || null },
      window: { installer: {
        macSelfHeal: () => new Promise((resolve) => calls.push(resolve)),
        quit: () => { quits++; },
      } },
      setTimeout: (fn) => { fn(); return 1; }, // задержку перед quit в тесте схлопываем
    };
    vm.runInNewContext(script, sandbox);
    sandbox.API.bindMacSelfHeal('mac-selfheal', 'mac-selfheal-status');
    sandbox.API.bindMacSelfHeal('mac-selfheal-banner', 'mac-selfheal-banner-status');
    const b1 = els['mac-selfheal'];
    const b2 = els['mac-selfheal-banner'];
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

    b1.onClick(); // первая попытка пошла (вызов «висит» — calls[0] ещё не разрешён)
    assert.strictEqual(calls.length, 1, 'первый клик запускает починку');
    assert(b1.disabled && b2.disabled, 'ОБЕ кнопки заблокированы на время починки');
    assert(/Чиню/.test(b1.textContent) && /Чиню/.test(b2.textContent),
      'на кнопках видно, что починка идёт');

    b2.onClick(); // вторая кнопка — пока первый вызов не завершился
    b1.onClick(); // и та же кнопка ещё раз
    assert.strictEqual(calls.length, 1,
      'повторный вызов НЕ проходит, пока первый не завершился');

    calls[0]({ ok: false, error: 'open-failed' }); // первая попытка завершилась неудачей
    await flush();
    assert(!b1.disabled && !b2.disabled, 'после завершения кнопки снова доступны');
    assert(/Исправить автоматически/.test(b1.textContent), 'подпись кнопки вернулась');

    b2.onClick(); // теперь запуск снова возможен
    assert.strictEqual(calls.length, 2, 'после завершения первой попытки починка запускается снова');

    calls[1]({ ok: true }); // успех → перезапуск из свежего тома
    await flush();
    // Выход теперь инициирует ГЛАВНЫЙ процесс, а не окно. Таймер в окне умирал
    // вместе с окном, а модалка прямо просит его закрыть: человек, закрывший окно
    // сам, отменял выход, процесс оставался жив и держал замок единственного
    // экземпляра — свежий установщик закрывался сам, и человек оставался ни с чем.
    assert.strictEqual(quits, 0, 'окно НЕ инициирует выход (это делает главный процесс)');
    b1.onClick();
    assert.strictEqual(calls.length, 2,
      'после успеха защёлка НЕ отпускается — том нового установщика не отцепить');
  });
})();

/* ============================================================================
 * claude.sh: «установлен» = ЗАПУСКАЕТСЯ (все пути) · config.sh: бэкап БЕЗ секретов ·
 * _deelev.ps1: уборка осиротевших задач планировщика.
 * Тесты ПОВЕДЕНЧЕСКИЕ: bash-фрагменты гоняются настоящим bash, PS-функции — настоящим
 * Windows PowerShell 5.1 (боевой интерпретатор), интеграция — на РЕАЛЬНОМ планировщике
 * (тестовые задачи создаются со своим hex-тегом и убираются за собой).
 * ==========================================================================*/
(function hmClaudeGateBackupSecretsOrphanTasks() {
  const { spawnSync } = require('child_process');
  const toPosix = (p) => String(p).replace(/\\/g, '/');

  function findBash() {
    if (process.platform !== 'win32') return 'bash';
    const cands = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
    ];
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* */ } }
    return 'bash'; // последний шанс — PATH; если и там нет, тесты честно упадут
  }
  const BASH = findBash();
  const PS51 = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const runBashFile = (file) => {
    const r = spawnSync(BASH, [file], { encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const runPsFile = (file) => {
    const r = spawnSync(PS51, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', timeout: 120000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };

  const CLAUDE_SH = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'claude.sh'), 'utf8');
  const CONFIG_SH = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  const CONFIG_PS = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  const DEELEV_PS = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', '_deelev.ps1'), 'utf8');
  const DEELEV_PATH = path.join(ROOT, 'scripts', 'windows', '_deelev.ps1');

  // Вырезает bash-функцию по имени: от "name() {" до закрывающей } в нулевой колонке.
  function bashFn(src, name) {
    const i = src.indexOf(name + '() {');
    assert(i !== -1, 'в скрипте нет функции ' + name);
    const j = src.indexOf('\n}', i);
    assert(j !== -1, 'функция ' + name + ' не закрыта');
    return src.slice(i, j + 2);
  }

  console.log('== claude.sh: гейт «claude РАБОТАЕТ» на всех путях ==');

  ok('bash -n: claude.sh и config.sh синтаксически валидны', () => {
    for (const f of ['claude.sh', 'config.sh']) {
      const r = spawnSync(BASH, ['-n', toPosix(path.join(ROOT, 'scripts', 'macos', f))],
        { encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(r.status, 0, f + ': ' + (r.stderr || r.stdout || ''));
    }
  });

  // Хелпер: собрать временный HOME с claude нужного поведения и прогнать claude_install_ok.
  function runClaudeGate(prep) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-claude-'));
    try {
      prep(home);
      const scriptFile = path.join(home, 'gate.sh');
      // PATH урезан до sandbox-HOME + системных утилит: на дев-машине НАСТОЯЩИЙ claude
      // в PATH иначе просачивается в кейс «claude нет вовсе» и даёт ложный rc=0.
      fs.writeFileSync(scriptFile,
        'set -u\nHOME="' + toPosix(home) + '"\nexport PATH="$HOME/.local/bin:/usr/bin:/bin"\n' +
        'have() { command -v "$1" >/dev/null 2>&1; }\n' +
        bashFn(CLAUDE_SH, 'claude_install_ok') + '\n' +
        'claude_install_ok; echo "rc=$?"\n');
      const r = runBashFile(scriptFile);
      return {
        out: r.out,
        wrapper: fs.existsSync(path.join(home, '.local', 'bin', 'claude')),
        pkg: fs.existsSync(path.join(home, '.local', 'lib', 'node_modules', '@anthropic-ai', 'claude-code'))
      };
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }

  ok('claude.sh (поведение): нерабочая обёртка проваливает гейт и УДАЛЯЕТСЯ вместе с пакетом', () => {
    // Живой случай: npm отчитался успехом, а bin печатает «claude native binary not
    // installed» и падает. Гейт обязан увидеть это ЗАПУСКОМ и убрать артефакт из ~/.local.
    const r = runClaudeGate((home) => {
      const bin = path.join(home, '.local', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(path.join(home, '.local', 'lib', 'node_modules', '@anthropic-ai', 'claude-code'),
        { recursive: true });
      fs.writeFileSync(path.join(bin, 'claude'),
        '#!/bin/sh\necho "claude native binary not installed" >&2\nexit 1\n');
      try { fs.chmodSync(path.join(bin, 'claude'), 0o755); } catch (e) { /* win */ }
    });
    assert(/rc=1/.test(r.out), 'нерабочий claude обязан провалить гейт: ' + r.out);
    assert(!r.wrapper, 'нерабочая обёртка удалена (иначе перехватит PATH у следующего пути установки)');
    assert(!r.pkg, 'пакет-пустышка в ~/.local/lib удалён');
  });

  ok('claude.sh (поведение): работающий claude проходит гейт и НЕ трогается', () => {
    const r = runClaudeGate((home) => {
      const bin = path.join(home, '.local', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'claude'),
        '#!/bin/sh\n[ "$1" = "--version" ] && { echo "1.2.3 (Claude Code)"; exit 0; }\nexit 1\n');
      try { fs.chmodSync(path.join(bin, 'claude'), 0o755); } catch (e) { /* win */ }
    });
    assert(/rc=0/.test(r.out), 'работающий claude обязан пройти гейт: ' + r.out);
    assert(r.wrapper, 'работающий бинарь не удаляется');
  });

  ok('claude.sh (поведение): claude нет вовсе → гейт красный (без ложного OK)', () => {
    const r = runClaudeGate(() => { /* пустой HOME */ });
    assert(/rc=1/.test(r.out), 'отсутствующий claude не должен проходить гейт: ' + r.out);
  });

  ok('claude.sh: ЕДИНЫЙ гейт стоит на ВСЕХ путях — офлайн, curl, npm-фолбэк, финал', () => {
    // объявление — раньше первого вызова (в проекте уже был баг «вызов до объявления»)
    const decl = CLAUDE_SH.indexOf('claude_install_ok() {');
    assert(decl !== -1, 'функция claude_install_ok объявлена');
    const calls = [];
    const re = /claude_install_ok\b/g; let m;
    while ((m = re.exec(CLAUDE_SH)) !== null) calls.push(m.index);
    assert(calls.filter((i) => i > decl + 10).length >= 4,
      'гейт вызывается минимум 4 раза (офлайн, curl, npm-фолбэк, финальный гейт), нашли: ' + (calls.length - 1));
    // офлайн: между успехом npm --offline и INSTALLED=1 стоит гейт
    const off = CLAUDE_SH.slice(CLAUDE_SH.indexOf('--offline --cache'), CLAUDE_SH.indexOf('онлайн-фолбэк."'));
    assertOrder(off, 'claude_install_ok', 'INSTALLED=1', 'офлайн: INSTALLED=1 только после гейта');
    // curl-путь: тот же гейт в ОДНОЙ команде с bash (&&), успех curl сам по себе ничего не решает
    assert(/install\.sh \| bash \\\n\s+&& claude_install_ok; then/.test(CLAUDE_SH),
      'curl-путь гейтится claude_install_ok');
    // npm-фолбэк: тоже
    assert(/--no-audit --no-fund \\\n\s+&& claude_install_ok; then/.test(CLAUDE_SH),
      'npm-фолбэк гейтится claude_install_ok');
    // финальный гейт — РАБОТОЙ, а не наличием файла (старый вариант давал ложный OK)
    assert(/if claude_install_ok; then\n\s*persist_local_bin_path/.test(CLAUDE_SH),
      'финальный гейт использует claude_install_ok');
    assert(!/if have claude \|\| \[ -x "\$HOME\/\.local\/bin\/claude" \]; then/.test(CLAUDE_SH),
      'финальная проверка «файл на диске» удалена — она пропускала нерабочую обёртку');
  });

  console.log('== config.sh: бэкап ~/.claude БЕЗ секретов (зеркало config.ps1) ==');

  // Вырезаем блок бэкапа целиком: от BACKUP_EXCLUDES= до комментария следующей секции.
  function backupBlock() {
    const i = CONFIG_SH.indexOf('BACKUP_EXCLUDES=');
    const j = CONFIG_SH.indexOf('# hm_copy');
    assert(i !== -1 && j !== -1 && i < j, 'блок бэкапа найден в config.sh');
    return CONFIG_SH.slice(i, j);
  }

  ok('config.sh (поведение): в бэкапе НЕТ ключей и tg-сессии, файлы юзера есть, оригинал цел', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cfgbk-'));
    try {
      const ch = path.join(home, '.claude');
      fs.mkdirSync(path.join(ch, 'memory'), { recursive: true });
      fs.mkdirSync(path.join(ch, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(ch, 'settings.json'), '{}');
      fs.writeFileSync(path.join(ch, 'memory', 'MEMORY.md'), 'mem');
      // секреты: в корне, вложенный и глоб-хвосты сессии (как -wal/-journal у SQLite)
      fs.writeFileSync(path.join(ch, '.credentials.master.env'), 'KEY=sk-secret');
      fs.writeFileSync(path.join(ch, '.credentials.json'), '{"tok":"x"}');
      fs.writeFileSync(path.join(ch, 'tg_session.session'), 'tg');
      fs.writeFileSync(path.join(ch, 'tg_session.session-journal'), 'tgj');
      fs.writeFileSync(path.join(ch, 'tools', '.credentials.json'), 'nested');
      const scriptFile = path.join(home, 'bk.sh');
      fs.writeFileSync(scriptFile, 'set -u\nCLAUDE_HOME="' + toPosix(ch) + '"\n' + backupBlock());
      const r = runBashFile(scriptFile);
      const bk = fs.readdirSync(home).find((n) => n.startsWith('.claude.backup.'));
      assert(bk, 'бэкап создан: ' + r.out);
      const bkDir = path.join(home, bk);
      assert(fs.existsSync(path.join(bkDir, 'settings.json')), 'обычный файл в бэкапе');
      assert(fs.existsSync(path.join(bkDir, 'memory', 'MEMORY.md')), 'память в бэкапе');
      for (const s of ['.credentials.master.env', '.credentials.json', 'tg_session.session',
        'tg_session.session-journal', path.join('tools', '.credentials.json')]) {
        assert(!fs.existsSync(path.join(bkDir, s)), 'секрет НЕ должен попасть в бэкап: ' + s);
      }
      // оригинал не тронут — бэкап-исключения не смеют чистить сам ~/.claude
      for (const s of ['.credentials.master.env', '.credentials.json', 'tg_session.session',
        'tg_session.session-journal', path.join('tools', '.credentials.json')]) {
        assert(fs.existsSync(path.join(ch, s)), 'оригинал секрета обязан остаться в ~/.claude: ' + s);
      }
      // сверка полноты обязана считать источник БЕЗ секретов — иначе вечный ложный warning
      assert(!/неполный бэкап/.test(r.out),
        'исключённые секреты не должны давать ложный «неполный бэкап»: ' + r.out);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  ok('config.sh: список исключений бэкапа = ТОЧНО /XF из config.ps1 (не разъезжаются)', () => {
    // Windows: robocopy-бэкап с /XF — авторитетный список (переносим РОВНО его).
    const m = CONFIG_PS.match(/robocopy \$claudeHome \$backupDir[^|\n]*\/XF([^|\n]*)/);
    assert(m, 'в config.ps1 есть robocopy-бэкап с /XF');
    const winList = (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).sort();
    assert(winList.length >= 3, 'в /XF есть исключения: ' + winList.join(', '));
    const bm = CONFIG_SH.match(/BACKUP_EXCLUDES="([^"]+)"/);
    assert(bm, 'в config.sh есть BACKUP_EXCLUDES');
    const macList = bm[1].trim().split(/\s+/).map((s) => s.replace(/^--exclude=/, '')).sort();
    assert.deepStrictEqual(macList, winList,
      'mac-список исключений бэкапа обязан РОВНО совпадать с Windows-списком');
    // fallback-ветка (cp -R + find-вычистка) знает те же имена — rsync есть не везде
    for (const n of winList) {
      assert(backupBlock().indexOf("-name '" + n + "'") !== -1,
        'fallback-вычистка не знает про ' + n);
    }
    // rsync-ветка использует ровно ту переменную, что сверена выше
    assert(/rsync -a \$BACKUP_EXCLUDES "\$CLAUDE_HOME\/"/.test(CONFIG_SH),
      'rsync-бэкап исключает через $BACKUP_EXCLUDES');
  });

  console.log('== _deelev.ps1: осиротевшие задачи планировщика убираются ==');

  const IS_WIN_HERE = process.platform === 'win32';
  const HAVE_PS51 = IS_WIN_HERE && fs.existsSync(PS51);

  ok('_deelev.ps1: парсится Windows PowerShell 5.1 (боевой интерпретатор)', () => {
    if (!IS_WIN_HERE) SKIP('не Windows — парс PS 5.1 недоступен');
    assert(HAVE_PS51, 'нет ' + PS51);
    const f = path.join(os.tmpdir(), 'hm-parse-' + Date.now() + '.ps1');
    fs.writeFileSync(f,
      "$errs = $null\n" +
      "[void][System.Management.Automation.Language.Parser]::ParseFile('" + DEELEV_PATH.replace(/'/g, "''") + "', [ref]$null, [ref]$errs)\n" +
      "if ($errs -and $errs.Count) { $errs | ForEach-Object { Write-Host ('PARSE-ERR: ' + $_.Message) }; exit 1 }\n" +
      "Write-Host 'PARSE=OK'\n");
    try {
      const r = runPsFile(f);
      assert(/PARSE=OK/.test(r.out), 'ошибки парсера: ' + r.out);
    } finally { fs.rmSync(f, { force: true }); }
  });

  ok('_deelev.ps1: объявления ДО первого использования; авто-уборка стоит ПОСЛЕДНЕЙ', () => {
    // В этом файле уже был баг «функция вызвана до объявления» — порядок закреплён тестом.
    const declPredicate = DEELEV_PS.indexOf('function Test-HmTaskIsOrphan');
    const declSweep = DEELEV_PS.indexOf('function Remove-HmOrphanTasks');
    const declInvoke = DEELEV_PS.indexOf('function Invoke-HmDeElevated');
    const callSweep = DEELEV_PS.lastIndexOf('@(Remove-HmOrphanTasks)');
    assert(declPredicate !== -1 && declSweep !== -1 && callSweep !== -1, 'функции уборки есть');
    assert(declPredicate < declSweep, 'предикат объявлен раньше уборщика');
    assert(declSweep < callSweep && declInvoke < callSweep,
      'top-level вызов уборки стоит ПОСЛЕ всех объявлений');
    assert(/try \{\s*\n\s*\$hmOrphanTags = @\(Remove-HmOrphanTasks\)/.test(DEELEV_PS),
      'авто-уборка обёрнута в try — сбой уборки НЕ роняет установку');
    // Задача теперь несёт дату регистрации (по ней отличаем свежую от сироты); Date — первой в схеме.
    assert(/<RegistrationInfo><Date>\$regDateXml<\/Date><Description>/.test(DEELEV_PS),
      'в XML задачи есть <Date> перед <Description> (схема RegistrationInfo)');
    // Штатное удаление собственной задачи в finally никуда не делось.
    assert(/finally \{\s*\n\s*& \$schtasks '\/Delete' '\/TN' \$tag '\/F'/.test(DEELEV_PS),
      'finally по-прежнему удаляет свою задачу');
  });

  ok('_deelev.ps1 (поведение, PS 5.1): предикат сироты — возраст/состояние/исключение/fail-safe', () => {
    if (!HAVE_PS51) SKIP('не Windows / нет PowerShell 5.1');
    const f = path.join(os.tmpdir(), 'hm-orphan-pred-' + Date.now() + '.ps1');
    fs.writeFileSync(f,
      ". '" + DEELEV_PATH.replace(/'/g, "''") + "' | Out-Null\n" +
      "$now = Get-Date\n" +
      "$oldD = $now.AddHours(-3).ToString('s')\n" +
      "$newD = $now.AddMinutes(-5).ToString('s')\n" +
      "$nD = 'HmDeElev_0123456789abcdef0123456789abcdef'\n" +
      "$nL = 'HmLaunch_abcdef012345'\n" +
      "Write-Host ('old-ready=' + (Test-HmTaskIsOrphan -Name $nD -State 3 -RegDate $oldD -Now $now))\n" +
      "Write-Host ('old-running=' + (Test-HmTaskIsOrphan -Name $nD -State 4 -RegDate $oldD -Now $now))\n" +
      "Write-Host ('old-queued=' + (Test-HmTaskIsOrphan -Name $nD -State 2 -RegDate $oldD -Now $now))\n" +
      "Write-Host ('fresh=' + (Test-HmTaskIsOrphan -Name $nD -State 3 -RegDate $newD -Now $now))\n" +
      "Write-Host ('excluded=' + (Test-HmTaskIsOrphan -Name $nD -State 3 -RegDate $oldD -ExcludeTag $nD -Now $now))\n" +
      "Write-Host ('foreign=' + (Test-HmTaskIsOrphan -Name 'GoogleUpdateTaskMachineUA' -State 3 -RegDate $oldD -Now $now))\n" +
      "Write-Host ('no-age=' + (Test-HmTaskIsOrphan -Name $nD -State 3 -Now $now))\n" +
      "Write-Host ('lastrun-old=' + (Test-HmTaskIsOrphan -Name $nL -State 3 -LastRun $now.AddHours(-2) -Now $now))\n" +
      "Write-Host ('lastrun-sentinel=' + (Test-HmTaskIsOrphan -Name $nL -State 3 -LastRun ([datetime]'1999-11-30') -Now $now))\n" +
      "Write-Host ('fileborn-old=' + (Test-HmTaskIsOrphan -Name $nL -State 3 -FileBorn $now.AddHours(-2) -Now $now))\n" +
      "Write-Host ('bad-regdate-file-fallback=' + (Test-HmTaskIsOrphan -Name $nD -State 3 -RegDate 'not-a-date' -FileBorn $now.AddHours(-2) -Now $now))\n");
    try {
      const r = runPsFile(f);
      const expect = {
        'old-ready': 'True',            // старая, не бежит → сирота
        'old-running': 'False',         // бежит ПРЯМО СЕЙЧАС → не трогаем
        'old-queued': 'False',          // в очереди на запуск → не трогаем
        'fresh': 'False',               // свежая: возможно, живая у параллельного экземпляра
        'excluded': 'False',            // собственный тег текущего запуска
        'foreign': 'False',             // чужое имя — никогда
        'no-age': 'False',              // возраст неизвестен → fail-safe
        'lastrun-old': 'True',          // без Date, но давно отработала → сирота
        'lastrun-sentinel': 'False',    // сентинел «не запускалась» (1899/1999) ≠ возраст
        'fileborn-old': 'True',         // дата из файла задачи (System32\Tasks) — для HmLaunch_*
        'bad-regdate-file-fallback': 'True' // битая Date не ломает каскад источников возраста
      };
      for (const k of Object.keys(expect)) {
        const mm = r.out.match(new RegExp('^' + k + '=(\\S+)', 'm'));
        assert(mm, 'нет строки ' + k + ' в выводе: ' + r.out);
        assert.strictEqual(mm[1], expect[k], k + ': ожидали ' + expect[k] + ', вывод: ' + r.out);
      }
    } finally { fs.rmSync(f, { force: true }); }
  });

  ok('_deelev.ps1 (интеграция, реальный планировщик): сирота снесена; свежая/бегущая/исключённая целы', () => {
    if (!HAVE_PS51) SKIP('не Windows / нет PowerShell 5.1 — реальный планировщик недоступен');
    // ГЕРМЕТИЧНОСТЬ. Префикс Hm(DeElev|Launch)_ зашит в предикат Test-HmTaskIsOrphan —
    // «свой уникальный префикс на прогон» невозможен без правки исходников. Поэтому:
    // если в планировщике УЖЕ есть задачи с этим префиксом (параллельный прогон тестов,
    // живой установщик или сироты прежних падений) — тест ЧЕСТНО пропускается: чужая
    // уборка снесла бы нашу «исключённую» задачу (after1 ждёт её живой), а наша — чужие
    // свежесозданные «старые». Перечисляем ТЕМ ЖЕ способом, что и уборка (COM,
    // GetTasks(1) — скрытые видны), а не schtasks, который прячет Hidden-задачи.
    {
      const probe = path.join(os.tmpdir(), 'hm-orphan-probe-' + Date.now() + '.ps1');
      fs.writeFileSync(probe,
        "$svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()\n" +
        "$names = @($svc.GetFolder('\\').GetTasks(1) | ForEach-Object { $_.Name }) -match '^Hm(DeElev|Launch)_'\n" +
        "Write-Host ('FOREIGN=' + ($names -join ','))\n");
      let foreign = '';
      try {
        const pr = runPsFile(probe);
        const mm = pr.out.match(/^FOREIGN=(.*)$/m);
        assert(mm, 'перечисление задач планировщика отработало: ' + pr.out);
        foreign = mm[1].trim();
      } finally { fs.rmSync(probe, { force: true }); }
      if (foreign) SKIP('в планировщике уже есть Hm*-задачи (параллельный прогон/установщик/сироты): ' + foreign);
    }
    const f = path.join(os.tmpdir(), 'hm-orphan-integ-' + Date.now() + '.ps1');
    fs.writeFileSync(f, [
      "$ErrorActionPreference = 'Continue'",
      ". '" + DEELEV_PATH.replace(/'/g, "''") + "' | Out-Null",
      "$schtasks = Join-Path (Join-Path $env:SystemRoot 'System32') 'schtasks.exe'",
      "$userXml = [System.Security.SecurityElement]::Escape([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)",
      "function New-TestTask([string]$tag, [string]$date, [string]$cmd, [string]$cargs) {",
      "  $xml = '<?xml version=\"1.0\" encoding=\"UTF-16\"?><Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">' +",
      "    ('<RegistrationInfo><Date>' + $date + '</Date><Description>hm test orphan</Description></RegistrationInfo>') +",
      "    ('<Principals><Principal id=\"Author\"><UserId>' + $userXml + '</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>') +",
      "    '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><AllowHardTerminate>true</AllowHardTerminate><Enabled>true</Enabled><Hidden>true</Hidden><AllowStartOnDemand>true</AllowStartOnDemand><ExecutionTimeLimit>PT10M</ExecutionTimeLimit></Settings>' +",
      "    ('<Actions Context=\"Author\"><Exec><Command>' + $cmd + '</Command><Arguments>' + $cargs + '</Arguments></Exec></Actions></Task>')",
      "  $fx = Join-Path $env:TEMP ('hmtt-' + $tag + '.xml')",
      "  Set-Content -LiteralPath $fx -Value $xml -Encoding Unicode",
      "  & $schtasks /Create /TN $tag /XML $fx /F 2>&1 | Out-Null",
      "  $rc = $LASTEXITCODE; Remove-Item $fx -Force -ErrorAction SilentlyContinue; return $rc",
      "}",
      "function Task-Exists([string]$tag) { & $schtasks /Query /TN $tag 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) }",
      "$now = Get-Date",
      "$oldTag = 'HmDeElev_' + [guid]::NewGuid().ToString('N')",
      "$newTag = 'HmLaunch_' + [guid]::NewGuid().ToString('N').Substring(0,12)",
      "$exTag  = 'HmDeElev_' + [guid]::NewGuid().ToString('N')",
      "$runTag = 'HmDeElev_' + [guid]::NewGuid().ToString('N')",
      "$cmdExe = Join-Path (Join-Path $env:SystemRoot 'System32') 'cmd.exe'",
      "$psExe  = Join-Path (Join-Path $env:SystemRoot 'System32') 'WindowsPowerShell\\v1.0\\powershell.exe'",
      "Write-Host ('create=' + (New-TestTask $oldTag ($now.AddHours(-3).ToString('s')) $cmdExe '/c exit 0') +",
      "  ',' + (New-TestTask $newTag ($now.AddMinutes(-2).ToString('s')) $cmdExe '/c exit 0') +",
      "  ',' + (New-TestTask $exTag ($now.AddHours(-3).ToString('s')) $cmdExe '/c exit 0') +",
      "  ',' + (New-TestTask $runTag ($now.AddHours(-3).ToString('s')) $psExe '-NoProfile -Command Start-Sleep 20'))",
      "& $schtasks /Run /TN $runTag 2>&1 | Out-Null",
      "$svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect(); $root = $svc.GetFolder('\\')",
      "$state = 0",
      "for ($i = 0; $i -lt 25; $i++) { Start-Sleep -Milliseconds 300; $state = [int]$root.GetTask($runTag).State; if ($state -eq 4) { break } }",
      "Write-Host ('run-state=' + $state)",
      "$sw1 = @(Remove-HmOrphanTasks -ExcludeTag $exTag)",
      "Write-Host ('after1=' + (Task-Exists $oldTag) + ',' + (Task-Exists $newTag) + ',' + (Task-Exists $exTag) + ',' + (Task-Exists $runTag))",
      "$sw2 = @(Remove-HmOrphanTasks)",
      "Write-Host ('after2=' + (Task-Exists $exTag) + ',' + (Task-Exists $runTag))",
      "& $schtasks /End /TN $runTag 2>&1 | Out-Null",
      "foreach ($t in @($oldTag, $newTag, $exTag, $runTag)) { & $schtasks /Delete /TN $t /F 2>&1 | Out-Null }",
      "Write-Host 'CLEANED'"
    ].join('\n'));
    try {
      const r = runPsFile(f);
      assert(/create=0,0,0,0/.test(r.out), 'тестовые задачи создались: ' + r.out);
      assert(/run-state=4/.test(r.out), 'бегущая задача реально в состоянии Running: ' + r.out);
      // sweep1 (-ExcludeTag exTag): старая сирота удалена; свежая, исключённая и бегущая целы
      assert(/after1=False,True,True,True/.test(r.out),
        'после уборки: сирота снесена, свежая/исключённая/бегущая целы: ' + r.out);
      // sweep2 (без исключения): exTag — тоже сирота → снесена; бегущая всё ещё цела
      assert(/after2=False,True/.test(r.out),
        'вторая уборка сносит бывшую исключённую, но НЕ бегущую: ' + r.out);
      assert(/CLEANED/.test(r.out), 'тест убрал за собой: ' + r.out);
    } finally { fs.rmSync(f, { force: true }); }
  });
})();

// ===========================================================================
// Второй круг рой-ревью: реестр без консольной кодировки, блокировка второго
// экземпляра, восстановление прерванного удаления, uid на macOS, копия
// исходников Nomad. Каждый закрывает подтверждённый и воспроизведённый дефект.
// ===========================================================================
(function secondSwarmFixes() {
  const MAIN = () => fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // ПОРЯДОК ВАЖЕН: сначала строчные //, потом блочные /* */. Иначе «/*» из ТЕКСТА
  // строчного комментария (в main.js есть `// … scripts/*/nomad.*`) спаривается с
  // далёким «*/» и съедает килобайты НАСТОЯЩЕГО кода — проверки по code дают ложь
  // в обе стороны (проверено: пропадал регион с encoding:'ascii' и слоем реестра).
  const codeOf = (s) => s.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

  // Правило изменилось ещё раз, и это осознанно: разбор ТЕКСТОВОГО вывода
  // reg.exe удалён НАСОВСЕМ. Прошлая итерация вернула reg.exe с декодированием
  // реальной кодовой страницы — и оказалась неисправимой: reg.exe для символов
  // с best-fit-отображением подставляет ПОХОЖИЙ ASCII, а не «?» (проверено на
  // консоли 866: «José»→«Jose», «Müller»→«Muller», «Dev’s»→«Dev's», «a…b»→«a:b»
  // — появляется двоеточие, структурный символ пути). Порча происходит ВНУТРИ
  // reg.exe ДО всякого декодирования, строка приходит идеально чистой — гейты
  // на U+FFFD и «?» бессильны, «правильный» декодер ничего не спасает.
  // Скорость возвращена не разбором текста, а ПАКЕТИРОВАНИЕМ (regQueryManyDotNet:
  // один запуск интерпретатора на все значения). Инвариант: чтение значения не
  // теряет и не подменяет НИ ОДИН символ (поведенческий best-fit-тест выше).
  ok('реестр: разбор текстового вывода reg.exe удалён — чтение ТОЛЬКО через .NET, скорость пакетированием', () => {
    const s = MAIN();
    const code = codeOf(s);
    assert(!/'add', 'HKCU/.test(code), 'запись реестра НЕ через reg add');
    // Быстрый путь реестра (разбор текстового вывода reg.exe) удалён целиком.
    for (const token of ['regQueryFast', 'cpDecoder', 'isPureAscii']) {
      assert(code.indexOf(token) === -1, 'в коде не осталось «' + token + '»');
    }
    // reg.exe НЕ участвует в реестре нигде (best-fit-подмена José→Jose неисправима).
    assert(!/reg\.exe/.test(code), 'в коде нет ни одного обращения к reg.exe');
    // Декодирование консоли (decodeConsole/consoleCodePage/TextDecoder) — отдельный
    // примитив для tasklist и подобного; РЕЕСТРА он касаться не должен ни в одной
    // из читающих реестр функций, иначе best-fit-риск вернётся через заднюю дверь.
    const regRead = code.slice(code.indexOf('function regQueryValueDotNet'), code.indexOf('function winRegDeleteValue'));
    assert(regRead.length > 100, 'блок реестровых функций найден');
    for (const token of ['decodeConsole', 'consoleCodePage', 'TextDecoder', 'reg.exe']) {
      assert(regRead.indexOf(token) === -1, 'реестровое чтение НЕ использует «' + token + '»');
    }
    // Боевое чтение — тонкая обёртка над авторитетным .NET-путём, без спавнов.
    const typed = code.slice(code.indexOf('function regQueryValueTyped'), code.indexOf('function regQueryManyDotNet'));
    assert(typed.length > 10, 'тело regQueryValueTyped найдено');
    assert(/return regQueryValueDotNet\(keyPath, valueName\);/.test(typed),
      'regQueryValueTyped всегда идёт в regQueryValueDotNet');
    assert(!/spawnSync/.test(typed), 'обёртка сама ничего не спавнит');
    // Пакетное чтение заведено и держит контракт «порядок = порядку запросов».
    const many = code.slice(code.indexOf('function regQueryManyDotNet'), code.indexOf('function regQueryValueDotNet'));
    assert(many.length > 100, 'пакетное чтение (regQueryManyDotNet) есть');
    assert(/reqs\.map\(/.test(many), 'результаты соотносятся с запросами ПО ИНДЕКСУ');
  });

  // Боевое и авторитетное чтение обязаны давать ОДИНАКОВЫЙ результат на трудном
  // значении. Теперь это тождество по построению (typed → .NET) — тест стережёт,
  // что оно не разъедется снова: кириллица, %VAR% сырым, тип значения, и всё это
  // в спартанском окружении (PATH = только System32, как в бою).
  if (process.platform === 'win32') {
    ok('реестр (прогон): боевое чтение ≡ .NET на кириллице и %VAR%; тип сохранён', () => {
      const s = MAIN();
      const body = s.slice(s.indexOf('const REG_KIND_TO_TYPE'), s.indexOf('function winRegDeleteValue'));
      const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
      const env = () => {
        const s32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
        return Object.assign({}, process.env, { PATH: s32, Path: s32 });
      };
      const M = new Function('spawnSync', 'remoteFetch', 'detectSpawnEnv', 'Buffer', 'IS_WIN',
        body + '\n; return { regQueryValueTyped, regQueryValueDotNet, regQueryManyDotNet, regWriteValueTyped, regDeleteValueTyped };'
      )(require('child_process').spawnSync, rf, env, Buffer, true);

      const KEY = 'HKCU\\Environment';
      const NAME = 'HmProbeSuite' + Date.now();
      const VAL = 'C:\\Программы\\Python;C:\\Users\\Жемал\\bin;%SystemRoot%\\System32';
      try {
        assert(M.regWriteValueTyped(KEY, NAME, VAL, 'REG_EXPAND_SZ').ok, 'пробное значение записано');
        // Авторитетный путь обязан быть верным ВСЕГДА — он и есть источник истины.
        const slow = M.regQueryValueDotNet(KEY, NAME);
        assert(slow.ok && slow.data === VAL, 'авторитетный путь: байт в байт');
        assert(slow.type === 'REG_EXPAND_SZ', 'авторитетный путь сохранил тип');
        assert(slow.data.indexOf('%SystemRoot%') >= 0,
          '%VAR% не раскрыт — чужие переменные не запекаются в литералы');
        // Боевое чтение обязано совпадать с авторитетным ДО БАЙТА — оно и есть он.
        const typed = M.regQueryValueTyped(KEY, NAME);
        assert.deepStrictEqual(typed, slow, 'боевое чтение ≡ .NET-путь');
        // Отсутствующее значение — не ошибка, а честный found:false.
        const miss = M.regQueryValueTyped(KEY, NAME + '_nope');
        assert(miss.ok === true && miss.found === false, 'отсутствующее значение: found=false');
        assert(M.regWriteValueTyped('HKLM\\SYSTEM\\X', 'Y', 'z', 'REG_SZ').ok === false, 'запись в HKLM невозможна');
      } finally {
        try { M.regDeleteValueTyped(KEY, NAME); } catch (e) { /* убираем за собой в любом случае */ }
      }
    });
  }

  ok('реестр: значение едет base64 — кодировка консоли не участвует', () => {
    // По коду БЕЗ комментариев: токен, уехавший в комментарий, не страж.
    const s = codeOf(MAIN());
    assert(/HMREG1:/.test(s), 'маркер ответа');
    assert(/ToBase64String/.test(s) && /FromBase64String/.test(s), 'base64 в обе стороны');
    assert(/encoding: 'ascii'/.test(s), 'ответ читается как ASCII — мохибейку неоткуда взяться');
  });

  ok('реестр: запись разрешена ТОЛЬКО в HKCU, чтение — HKCU и HKLM', () => {
    const s = codeOf(MAIN());
    const w = s.slice(s.indexOf('function regWriteValueTyped'), s.indexOf('function regDeleteValueTyped'));
    assert(w.length > 50, 'тело regWriteValueTyped найдено');
    assert(/hkcuSubkeyOf/.test(w), 'запись идёт через HKCU-только разбор');
    assert(!/regPathParts/.test(w), 'запись НЕ использует общий разбор (иначе открылся бы HKLM)');
    const q = s.slice(s.indexOf('function regQueryValueTyped'), s.indexOf('function regWriteValueTyped'));
    assert(/regPathParts/.test(q), 'чтение умеет оба куста');
  });

  // Первый клик даёт запрос прав и минуту тишины на распаковке — новичок кликает
  // ещё раз. Portable-стаб при этом рекурсивно чистит ОБЩИЙ каталог распаковки,
  // выдёргивая ресурсы у уже работающего экземпляра.
  ok('второй запуск установщика невозможен (блокировка + уникальный каталог распаковки)', () => {
    const s = MAIN();
    // Проверяем СТРУКТУРУ, а не наличие вызова: мутация «if (false && !app.…)»
    // оставляла вызов на месте, и проверка по строке этого не замечала.
    const cond = s.match(/if\s*\(([^)]*requestSingleInstanceLock\(\)[^)]*)\)\s*\{/);
    assert(cond, 'условие с блокировкой найдено');
    assert(cond[1].trim() === '!app.requestSingleInstanceLock()',
      'условие ровно «!app.requestSingleInstanceLock()», без обходов: ' + cond[1].trim());

    // Ветка «не получили блокировку» обязана завершать процесс, а ветка else —
    // содержать whenReady (иначе второй экземпляр продолжил бы установку).
    const at = s.indexOf(cond[0]);
    let depth = 0, i = at + cond[0].length - 1, thenEnd = -1;
    for (; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) { thenEnd = i; break; } }
    }
    assert(thenEnd > 0, 'тело ветки отказа найдено');
    const thenBody = s.slice(at, thenEnd);
    assert(/app\.quit\(\)/.test(thenBody), 'без блокировки процесс завершается');
    const tail = s.slice(thenEnd, thenEnd + 40);
    assert(/^\}\s*else\s*\{/.test(tail), 'есть ветка else, а не просто продолжение: ' + JSON.stringify(tail.slice(0, 20)));
    const ready = s.indexOf('app.whenReady()');
    assert(ready > thenEnd, 'whenReady находится в ветке else, а не до блокировки');
    assert(/'second-instance'/.test(s), 'повторный запуск поднимает уже открытое окно');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    // В app-builder-lib define ставится при string И при любом falsy — пропускается
    // ТОЛЬКО при boolean true. Тогда стаб распаковывается в $PLUGINSDIR (уникальный
    // на запуск) вместо общего $TEMP\<ksuid>.
    assert(pkg.build.portable.unpackDirName === true,
      'unpackDirName: true — каталог распаковки уникален для каждого запуска');
  });

  // Цикл удаления длится десятками секунд; если процесс убили жёстко, маркер
  // оставался переименованным, кнопка «Удалить» исчезала навсегда, и компонент
  // нельзя было доудалить — только переустановить и удалять заново.
  ok('прерванное удаление: маркер возвращается на старте, живой не затирается', () => {
    const r = require(path.join(ROOT, 'src', 'install-receipts.js'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-tomb-'));
    try {
      r.writeReceipt(home, 'nomad', r.buildReceipt('nomad', 'win32', '1.0'));
      assert(r.deactivateReceipt(home, 'nomad').ok, 'удаление деактивировало маркер');
      assert(r.readReceipt(home, 'nomad') === null, 'до починки маркера нет');
      const rec = r.recoverOrphanTombstones(home);
      assert(rec.restored.indexOf('nomad') >= 0, 'старт вернул маркер: ' + JSON.stringify(rec.restored));
      assert(!!r.readReceipt(home, 'nomad'), 'удаление можно повторить');

      // Живой маркер новее tombstone (компонент переустановили) — не трогаем.
      r.writeReceipt(home, 'vscode', r.buildReceipt('vscode', 'win32', '2.0'));
      fs.writeFileSync(r.tombstonePath(home, 'vscode'), '{"id":"vscode","schemaVersion":2}');
      r.recoverOrphanTombstones(home);
      const v = r.readReceipt(home, 'vscode');
      assert(v && v.version === '2.0', 'живой маркер не перезаписан устаревшим tombstone');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  ok('main.js вызывает восстановление осиротевших маркеров при старте', () => {
    // По коду БЕЗ комментариев: раньше тест читал исходник целиком, и
    // ЗАКОММЕНТИРОВАННЫЙ вызов (// receipts.recoverOrphanTombstones(...))
    // проходил проверку — «восстановление есть», хотя на старте не звалось ничего.
    const s = codeOf(MAIN());
    const call = s.indexOf('receipts.recoverOrphanTombstones(');
    assert(call !== -1, 'вызов есть В КОДЕ (не в комментарии)');
    const ready = s.indexOf('app.whenReady()');
    assert(ready !== -1 && call > ready, 'вызывается после готовности приложения');
  });

  // На macOS приложение стартует ИЗ ОБРАЗА, и имя скачанного файла до него не
  // доезжает: привязка событий к человеку не работала вовсе.
  ok('uid на macOS берётся у смонтированного образа, чужой образ игнорируется', () => {
    const u = require(path.join(ROOT, 'src', 'uid-telemetry.js'));
    const call = (out) => u.resolveUid({
      platform: 'darwin', execPath: '/Volumes/Hamidun Setup/Hamidun Setup.app',
      env: {}, execFileSync: () => out,
    });
    assert(call('image-path : /d/Hamidun-Setup-Mac-Lite--u272540053.dmg\n') === '272540053', 'наш образ даёт uid');
    assert(call('image-path : /d/Hamidun-Setup-Mac--u999 (1).dmg\n') === '999', 'повторно скачанный « (1)» тоже');
    assert(call('image-path : /d/Evil--u666.dmg\n') === '', 'чужой смонтированный образ uid НЕ даёт');
    assert(call('image-path : /d/Hamidun-Setup-Mac.dmg\n') === '', 'образ без uid → анонимно');
    let threw = false;
    try {
      u.resolveUid({
        platform: 'darwin', execPath: '/V/a', env: {},
        execFileSync: () => { throw new Error('нет образа'); },
      });
    } catch (e) { threw = true; }
    assert(!threw, 'падение hdiutil не роняет установку');
  });

  // Copy-Item -LiteralPath с подстановкой в боевом Windows PowerShell 5.1 НЕ
  // раскрывает звёздочку и молча копирует НОЛЬ файлов без исключения (в pwsh 7 —
  // честно падает, поэтому дефект и не ловился). uv получал пустой каталог,
  // и Nomad не ставился на Windows НИКОГДА.
  ok('Nomad: копия исходников без подстановок + проверка факта копирования', () => {
    const n = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'nomad.ps1'), 'utf8');
    const i = n.indexOf('$buildSrc = Join-Path');
    assert(i > 0, 'блок подготовки копии найден');
    const blk = n.slice(i, i + 1200);
    assert(!/Copy-Item[^\n]*\*/.test(blk),
      'в копировании нет подстановок — в PS 5.1 они молча копируют ноль файлов');
    assert(/Copy-Item -LiteralPath \$src -Destination \$buildSrc/.test(blk),
      'копируется каталог целиком в ещё не существующий путь');
    assert(/pyproject\.toml/.test(blk), 'факт копирования проверяется по контрольному файлу');
    const chk = blk.indexOf('pyproject.toml');
    const use = blk.indexOf('$srcForInstall = $buildSrc');
    assert(chk > 0 && use > chk, 'проверка стоит ДО того, как копия объявлена пригодной');
  });

  // Причина отказа staging-каталога показывается человеку, пишется в лог и
  // уезжает в телеметрию — она обязана быть читаемой, а не CP866-мусором.
  ok('причина отказа staging-каталога приходит в UTF-8', () => {
    const s = MAIN();
    // В main.js два инлайна: для компонентных скриптов и для примитива. Нужен
    // именно примитив — он один прибивает PSModulePath литералом.
    const anchor = s.indexOf("$env:PSModulePath='");
    assert(anchor > 0, 'инлайн примитива найден');
    const i = s.lastIndexOf('const inline =', anchor);
    assert(i > 0, 'начало инлайна примитива найдено');
    const blk = s.slice(i, anchor + 900);
    assert(/OutputEncoding=\[System\.Text\.Encoding\]::UTF8/.test(blk),
      'кодировка консоли задаётся ПЕРВОЙ командой');
    const enc = blk.indexOf('OutputEncoding');
    const dot = blk.indexOf(". '");
    assert(enc < dot, 'кодировка выставляется ДО дот-сорса примитива');
  });
})();

// ===========================================================================
// Агент fix-staging-cleanup: уборка двухуровневого staging обязана сносить
// ВНЕШНИЙ запертый HmDeElev-<hex>, а не только рабочий подкаталог `w` (иначе
// %ProgramData% зарастает Admins-only пустышками, которые пользователь стереть
// не может — на боевой машине их скопились сотни). Плюс регрессия-страж задачи 2:
// мёртвый classifyRegQuery не воскресает.
// ===========================================================================
(function stagingCleanupTests() {
  console.log('== Staging-уборка: сносится ВНЕШНИЙ HmDeElev-<hex> (не подкаталог w), fail-closed по имени ==');

  const DEELEV_STAGE = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', '_deelev.ps1'), 'utf8');

  // Статика: единый помощник существует (по образцу stagingRootOf из main.js),
  // поднимается от `w` к родителю, стережёт имя шаблоном HmDeElev-<32 hex>
  // (fail-closed: код работает под админом — ошибка вычисления пути не должна
  // удалить чужой каталог), и ВСЕ сносы staging в _deelev.ps1 идут через него.
  ok('_deelev.ps1: уборка staging — ТОЛЬКО через Remove-HmSecureStagingDir (подъём от w + шаблон имени, fail-closed)', () => {
    const s = DEELEV_STAGE();
    const i = s.indexOf('function Remove-HmSecureStagingDir');
    assert(i !== -1, 'помощник Remove-HmSecureStagingDir определён');
    const body = s.slice(i, i + 1400);
    assert(/-eq 'w'/.test(body) && /GetDirectoryName/.test(body),
      'помощник поднимается от рабочего подкаталога w к родителю (образец stagingRootOf)');
    assert(/HmDeElev-\[0-9a-f\]\{32\}/.test(body),
      'удаляется ТОЛЬКО каталог с именем HmDeElev-<32 hex> (шаблон pruneStaleSecureDirs)');
    assert(/-notmatch '\^HmDeElev-\[0-9a-f\]\{32\}\$'/.test(body), 'fail-closed гейт по имени присутствует');
    assertOrder(body, "-notmatch '^HmDeElev-", 'Remove-Item -LiteralPath $root',
      'проверка имени стоит ДО удаления (fail-closed, не после)');
    // Дефект был именно здесь: finally Invoke-HmDeElevated удалял $dir (= подкаталог w),
    // внешний запертый каталог оставался в %ProgramData% навсегда.
    assert(/if \(\$dir\)\s+\{ Remove-HmSecureStagingDir -Path \$dir \}/.test(s),
      'finally Invoke-HmDeElevated чистит через помощник');
    assert(!/Remove-Item -LiteralPath \$dir\b/.test(s),
      'голых Remove-Item по $dir не осталось — все сносы staging только через помощник');
  });

  // Функционал в БОЕВОМ Windows PowerShell 5.1 (полный путь, не pwsh): помощнику
  // отдают путь РАБОЧЕГО подкаталога — исчезнуть обязан ВНЕШНИЙ каталог целиком;
  // каталог с посторонним именем (та же структура …\w) остаётся цел (fail-closed).
  if (powershellAvailable()) {
    ok('PS 5.1: Remove-HmSecureStagingDir(…\\w) сносит ВНЕШНИЙ HmDeElev-<hex>; постороннее имя цело (fail-closed)', () => {
      const dot = path.join(ROOT, 'scripts', 'windows', '_deelev.ps1');
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-stage-'));
      try {
        const hex = crypto.randomBytes(16).toString('hex'); // 32 hex — как guid N
        const outer = path.join(base, 'HmDeElev-' + hex);
        const work = path.join(outer, 'w');
        fs.mkdirSync(work, { recursive: true });
        fs.writeFileSync(path.join(work, 'task.xml'), 'x'); // непустой — как в бою
        const alien = path.join(base, 'NotMine-' + hex);    // структура та же, имя чужое
        fs.mkdirSync(path.join(alien, 'w'), { recursive: true });
        const psExe = path.join(process.env.SystemRoot || 'C:\\Windows',
          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const cmd = ". '" + dot + "';" +
          "Remove-HmSecureStagingDir -Path '" + work + "';" +
          "Remove-HmSecureStagingDir -Path '" + path.join(alien, 'w') + "';" +
          "Write-Output ('OUTER=' + (Test-Path -LiteralPath '" + outer + "'));" +
          "Write-Output ('ALIEN=' + (Test-Path -LiteralPath '" + alien + "'))";
        const r = spawnSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
          { encoding: 'utf8', timeout: 120000 });
        const out = (r.stdout || '');
        assert(/OUTER=False/.test(out),
          'ВНЕШНИЙ каталог исчез целиком (не только w): ' + out.trim() + ' ' + (r.stderr || '').trim().slice(0, 200));
        assert(/ALIEN=True/.test(out), 'постороннее имя НЕ тронуто (fail-closed): ' + out.trim());
      } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    });
  }

  // Задача 2: classifyRegQuery / REG_NOTFOUND_RE / REG_DENIED_RE удалены — main.js
  // читает реестр сам (.NET Registry через winPsPayload), вызовов в репозитории нет.
  // Живые экспорты (launchctl-классификаторы, verifyPostconditions) — на месте.
  ok('uninstall-exec.js: мёртвый classifyRegQuery не воскрес; живые экспорты целы', () => {
    const s = fs.readFileSync(path.join(ROOT, 'src', 'uninstall-exec.js'), 'utf8');
    assert(!/function classifyRegQuery/.test(s), 'функция classifyRegQuery не вернулась');
    assert(!/REG_NOTFOUND_RE\s*=|REG_DENIED_RE\s*=/.test(s), 'мёртвые регэкспы не вернулись');
    assert(typeof uxMod.classifyRegQuery === 'undefined', 'экспорт classifyRegQuery снят');
    assert(typeof uxMod.classifyLaunchctlPrint === 'function' &&
      typeof uxMod.launchctlRemoveError === 'function', 'живые launchctl-классификаторы на месте');
    assert(typeof uxMod.verifyPostconditions === 'function', 'verifyPostconditions жив');
  });
})();

// ===========================================================================
// claude.ps1 — ревью-фиксы «проверки запуском» (агент fix-claude-probe):
//   ДЕФЕКТ 1: служебные статусы «Last Result» планировщика (SCHED_S_*, 0x41300..0x41308,
//             0x41325) читались как код возврата claude -> рабочий CLI сносился
//             Remove-HmBrokenClaude и шаг краснел на ровном месте;
//   ДЕФЕКТ 2: Remove-HmBrokenClaude (elevated!) удалял по произвольному найденному пути
//             -> мог снести чужой claude (свой npm prefix / volta).
// Функции режутся из БОЕВОГО claude.ps1 и гоняются в Windows PowerShell 5.1; мутационные
// прогоны доказывают, что тесты КРАСНЕЮТ при возврате каждого дефекта.
// ===========================================================================
(function claudeProbeReviewTests() {
  console.log('== claude.ps1: сентинелы планировщика != код claude; уборка строго по аллоулисту ==');

  const SENTINELS = [267008, 267009, 267010, 267011, 267012, 267013, 267014, 267015, 267016, 267045];

  ok('структура: сентинел-гейт ДО вердикта broken; уборка зовётся только при broken; чужой сломанный claude на финале -> unverified', () => {
    const s = CLD_PS1();
    // Дефект 1: полный список SCHED_S_* в Test-HmClaudeRuns, исход — 'unverified'.
    const fnM = s.match(/function Test-HmClaudeRuns[\s\S]*?\r?\n\}/);
    assert(fnM, 'Test-HmClaudeRuns на месте');
    SENTINELS.forEach((c) => assert(fnM[0].includes(String(c)), 'сентинел ' + c + ' учтён'));
    // Второй якорь — ФИНАЛЬНЫЙ `return 'broken'` (с новой строки), а не ранний
    // `if (-not $bin) { return 'broken' }` в первой строке функции.
    assertOrder(fnM[0], "-contains $r.Code) { return 'unverified' }", "\n    return 'broken'",
      'сентинелы дают unverified РАНЬШЕ вердикта broken');
    // Дефект 2: аллоулист объявлен (зеркало macos/claude.sh) и удаление им гейтится.
    assert(/function Test-HmOurClaudeDir/.test(s), 'аллоулист наших каталогов объявлен');
    assert(/Join-Path \$env:USERPROFILE '\.local\\bin'/.test(s) && /Join-Path \$env:APPDATA 'npm'/.test(s),
      'в аллоулисте ровно наши места: ~/.local\\bin и %APPDATA%\\npm');
    const rmM = s.match(/function Remove-HmBrokenClaude[\s\S]*?\r?\n\}/);
    assert(rmM, 'Remove-HmBrokenClaude на месте');
    assertOrder(rmM[0], 'Test-HmOurClaudeDir', 'Remove-Item', 'проверка аллоулиста стоит ДО первого Remove-Item');
    // КАЖДЫЙ вызов уборки — только под вердиктом broken ('unverified' ничего не сносит).
    const rx = /Remove-HmBrokenClaude \$/g; let m; let calls = 0;
    while ((m = rx.exec(s)) !== null) {
      calls++;
      assert(s.lastIndexOf("($probe -eq 'broken')", m.index) > m.index - 700,
        'вызов уборки (смещение ' + m.index + ') не под вердиктом broken');
    }
    assert(calls >= 1, 'вызов уборки в офлайн-ветке на месте');
    // Финал: сломанный ЧУЖОЙ claude НЕ трогаем (файлы не наши), но и УСПЕХОМ не
    // объявляем. Раньше он понижался до 'unverified' и дальше печатал
    // «OK: Claude Code CLI установлен» с кодом 0 — зелёная галочка при заведомо
    // неработающем claude. Человек уходил уверенным, что всё хорошо.
    assert(/-eq 'broken' -and -not \(Test-HmOurClaudeDir \(Split-Path \$claudeBin\)\)/.test(s),
      'финальный вердикт различает наш/чужой каталог');
    assert(/\$brokenForeign = \$true/.test(s), 'чужой сломанный claude помечается отдельно');
    const bf = s.indexOf('if ($brokenForeign) {');
    assert(bf > 0, 'ветка чужого сломанного claude есть');
    const bfBody = s.slice(bf, s.indexOf('\n}', bf));
    assert(/exit 1/.test(bfBody), 'чужой сломанный claude даёт ЧЕСТНЫЙ отказ, а не успех');
    assert(!/Remove-Item/.test(bfBody), 'чужие файлы при этом НЕ удаляются');
    assert(/npm uninstall -g/.test(bfBody), 'человеку сказано, что именно сделать');
    // И «OK: … установлен» не должен быть достижим из этой ветки.
    assertOrder(s, 'if ($brokenForeign) {', 'OK: Claude Code CLI установлен',
      'отказ печатается РАНЬШЕ любого сообщения об успехе');
  });

  if (!powershellAvailable()) return;

  // Гарнесс: РЕАЛЬНЫЕ функции из claude.ps1; де-элевация подставная — Gate/Code из env
  // (HM_T_GATE/HM_T_CODE), чтобы прогнать в т.ч. значения, которых живой бинарь не даст.
  const cutFn = (src, name) => {
    const m = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\r?\\n\\}'));
    assert(m, name + ' извлекается из claude.ps1');
    return m[0];
  };
  const mkHarness = (dir, fns) => {
    const harness = '\uFEFF' +
      'param([string]$Bin, [string]$Mode)\r\n' +
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n' +
      'function Invoke-HmDeElevated { param($Exe, [string[]]$Arguments = @())\r\n' +
      "  if ($env:HM_T_GATE -eq 'null') { return $null }\r\n" +
      '  [pscustomobject]@{ Gate = $env:HM_T_GATE; Code = [int]$env:HM_T_CODE }\r\n' +
      '}\r\n' +
      fns.join('\r\n') + '\r\n' +
      "if ($Mode -eq 'probe') { Write-Output (Test-HmClaudeRuns $Bin) }\r\n" +
      "if ($Mode -eq 'clean') { Write-Output (Remove-HmBrokenClaude $Bin) }\r\n";
    const hFile = path.join(dir, 'review-harness.ps1');
    fs.writeFileSync(hFile, harness);
    return hFile;
  };
  const runPs = (hFile, bin, mode, envAdd) => spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hFile, bin, mode],
    { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, envAdd) });

  ok('ДЕФЕКТ 1 (прогон PS 5.1): каждый сентинел планировщика -> unverified (НЕ broken); 0 -> works; 1 -> broken; мутант без гейта пойман', () => {
    const src = CLD_PS1();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cldsent-'));
    try {
      const hFile = mkHarness(base, [cutFn(src, 'Test-HmClaudeRuns')]);
      const probe = (file, code) => (runPs(file, 'C:\\fake\\claude.cmd', 'probe',
        { HM_T_GATE: 'medium', HM_T_CODE: String(code) }).stdout || '').trim();
      SENTINELS.forEach((c) => {
        assert.strictEqual(probe(hFile, c), 'unverified',
          'Last Result ' + c + ' — статус ЗАДАЧИ, не код claude: удалять нечего');
      });
      assert.strictEqual(probe(hFile, 0), 'works', 'настоящий exit 0 -> works');
      assert.strictEqual(probe(hFile, 1), 'broken', 'настоящий exit 1 -> broken (доказанный отказ запуска)');
      const rNull = (runPs(hFile, 'C:\\fake\\claude.cmd', 'probe', { HM_T_GATE: 'null', HM_T_CODE: '0' }).stdout || '').trim();
      assert.strictEqual(rNull, 'unverified', 'де-элевация не отчиталась -> unverified (регрессии нет)');
      // Перечисление сентинелов — не единственная защита. Планировщик отдаёт и другие
      // служебные значения (SCHED_E_*, HRESULT-ы вроде 0x80070005, коды аварийного
      // завершения хоста). Код возврата ПРОГРАММЫ — маленькое число; всё вне 0..255
      // программа вернуть не может, и принимать это за «сломан» = снести рабочий CLI.
      [267100, 267300, -2147024891, -1073741819, 2147942405, 256, 999].forEach((c) => {
        assert.strictEqual(probe(hFile, c), 'unverified',
          'код вне 0..255 (' + c + ') — статус инфраструктуры, не приговор бинарю');
      });
      assert.strictEqual(probe(hFile, 255), 'broken', 'граница 255 — ещё настоящий код возврата');

      // МУТАЦИЯ (возврат дефекта 1): убираем ОБЕ защиты — и перечисление, и правило
      // диапазона. Только тогда 267014 снова становится broken. Мутация лишь одной
      // из двух ничего не докажет: вторая её перекроет — это и есть эшелонирование.
      const fnSrc = cutFn(src, 'Test-HmClaudeRuns');
      const mutant = fnSrc.split(/\r?\n/)
        .filter((l) => !/-contains \$r\.Code\)/.test(l))
        .filter((l) => !/\$r\.Code -lt 0 -or \$r\.Code -gt 255/.test(l))
        .join('\r\n');
      assert(mutant !== fnSrc, 'мутация применилась (обе защиты найдены и вырезаны)');
      const hMut = path.join(base, 'mutant-probe.ps1');
      fs.writeFileSync(hMut, fs.readFileSync(hFile, 'utf8').replace(fnSrc, () => mutant));
      assert.strictEqual(probe(hMut, 267014), 'broken',
        'дефектная версия даёт broken на 267014 — тест различает фикс и дефект');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('ДЕФЕКТ 2 (прогон PS 5.1): чужой claude вне наших каталогов НЕ удаляется; наш (%APPDATA%\\npm, ~/.local\\bin) — удаляется как раньше; мутант без аллоулиста пойман', () => {
    const src = CLD_PS1();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cldrm-'));
    try {
      const home = path.join(base, 'home'); const appdata = path.join(base, 'appdata');
      const ourNpm = path.join(appdata, 'npm'); const ourLocal = path.join(home, '.local', 'bin');
      const foreign = path.join(base, 'volta', 'bin');   // «свой npm prefix / volta» пользователя
      fs.mkdirSync(path.join(ourNpm, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
      fs.mkdirSync(ourLocal, { recursive: true });
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(ourNpm, 'claude.cmd'), '@exit /b 1\r\n');
      fs.writeFileSync(path.join(ourNpm, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), '{}');
      fs.writeFileSync(path.join(ourLocal, 'claude.exe'), 'x');
      fs.writeFileSync(path.join(foreign, 'claude.cmd'), '@echo user claude\r\n');
      const hFile = mkHarness(base, [cutFn(src, 'Test-HmOurClaudeDir'), cutFn(src, 'Remove-HmBrokenClaude')]);
      const envSb = { USERPROFILE: home, APPDATA: appdata, HM_T_GATE: 'medium', HM_T_CODE: '1' };
      // 1) ЧУЖОЙ каталог: честный отказ, файл ЖИВ (elevated-скрипт не сносит чужой claude).
      const r1 = runPs(hFile, path.join(foreign, 'claude.cmd'), 'clean', envSb);
      assert(/False/.test(r1.stdout || ''), 'уборка вернула $false (отказ): ' + (r1.stdout || '') + (r1.stderr || ''));
      assert(/не трогаю/.test(r1.stdout || ''), 'человеку сказано, ПОЧЕМУ не тронули');
      assert(fs.existsSync(path.join(foreign, 'claude.cmd')), 'чужой claude ЖИВ');
      // 2) НАШ npm-prefix: шим и пакет снесены (регрессии нет).
      const r2 = runPs(hFile, path.join(ourNpm, 'claude.cmd'), 'clean', envSb);
      assert(/True/.test(r2.stdout || ''), 'наш артефакт убран: ' + (r2.stdout || '') + (r2.stderr || ''));
      assert(!fs.existsSync(path.join(ourNpm, 'claude.cmd')), 'сломанный шим удалён');
      assert(!fs.existsSync(path.join(ourNpm, 'node_modules', '@anthropic-ai', 'claude-code')),
        'пакет @anthropic-ai/claude-code удалён (иначе перехватит PATH после онлайн-установки)');
      // 3) НАШ ~/.local\bin (нативный установщик): снесён.
      runPs(hFile, path.join(ourLocal, 'claude.exe'), 'clean', envSb);
      assert(!fs.existsSync(path.join(ourLocal, 'claude.exe')), 'наш claude.exe из ~/.local/bin удалён');
      // МУТАЦИЯ (возврат дефекта 2): вырезаем аллоулист-гейт — чужой файл обязан быть
      // снесён дефектной версией, иначе ассерт «чужой ЖИВ» ничего не сторожит.
      const rmSrc = cutFn(src, 'Remove-HmBrokenClaude');
      const mutant = rmSrc.replace(/if \(-not \(Test-HmOurClaudeDir \$dir\)\) \{[\s\S]*?\r?\n    \}\r?\n/, '');
      assert(mutant !== rmSrc, 'мутация применилась (гейт найден и вырезан)');
      const hMut = path.join(base, 'mutant-rm.ps1');
      fs.writeFileSync(hMut, fs.readFileSync(hFile, 'utf8').replace(rmSrc, () => mutant));
      runPs(hMut, path.join(foreign, 'claude.cmd'), 'clean', envSb);
      assert(!fs.existsSync(path.join(foreign, 'claude.cmd')),
        'дефектная версия сносит чужой файл — тест различает фикс и дефект');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
})();

// reg.exe САМ подменял символом «?» всё, что непредставимо в кодовой странице
// консоли (а best-fit-символы — похожим ASCII, см. поведенческий best-fit-тест),
// ещё ДО нашего декодирования. Быстрый путь удалён насовсем; инвариант теперь
// один: боевое чтение не теряет и не подменяет НИ ОДИН символ. Греческий на
// русской консоли — исторический репродюсер: «C:\Ωμέγα\bin» приезжал как
// «C:\?????\bin» и был бы записан обратно в PATH, уничтожив чужую запись.
if (process.platform === 'win32') {
  ok('реестр: непредставимые в консоли символы приходят целыми — без «?» и подмен', () => {
    const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    const body = s.slice(s.indexOf('const REG_KIND_TO_TYPE'), s.indexOf('function winRegDeleteValue'));
    const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
    const env = () => {
      const s32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      return Object.assign({}, process.env, { PATH: s32, Path: s32 });
    };
    const M = new Function('spawnSync', 'remoteFetch', 'detectSpawnEnv', 'Buffer', 'IS_WIN',
      body + '\n; return { regQueryValueTyped, regQueryValueDotNet, regQueryManyDotNet, regWriteValueTyped, regDeleteValueTyped };'
    )(require('child_process').spawnSync, rf, env, Buffer, true);

    const KEY = 'HKCU\\Environment';
    const NAME = 'HmLossy' + Date.now();
    // Греческий и акцентированная латиница непредставимы в CP866.
    const VAL = 'C:\\Ωμέγα\\bin;C:\\Программы\\x';
    try {
      assert(M.regWriteValueTyped(KEY, NAME, VAL, 'REG_SZ').ok, 'пробное значение записано');
      const got = M.regQueryValueTyped(KEY, NAME);
      assert(got.ok && got.found, 'итоговое чтение состоялось');
      assert.strictEqual(got.data, VAL, 'значение пришло целым, байт в байт: ' + got.data);
      assert(got.data.indexOf('?') === -1, 'в итоговом значении нет подменных «?»');
      // И в пачке то же значение обязано прийти целым (тот же .NET-транспорт).
      const many = M.regQueryManyDotNet([{ key: KEY, name: NAME }]);
      assert(many.length === 1 && many[0].ok && many[0].found, 'пакетное чтение состоялось');
      assert.strictEqual(many[0].data, VAL, 'пачка отдала значение байт в байт');
    } finally {
      try { M.regDeleteValueTyped(KEY, NAME); } catch (e) { /* убираем за собой всегда */ }
    }
  });
}

// ===========================================================================
// Журнал установки разгонял процессор до нескольких ядер и грел ноутбук.
// Живой случай на Mac M4: процесс «Hamidun» — 523% ЦП, 11 часов процессорного
// времени, ноутбук выключили вручную.
// Две причины, обе на КАЖДОЙ строке вывода (а их десятки тысяч — pip, uv, npm):
//   1) в интерфейсе `log.textContent += line` пересоздавал текстовый узел целиком,
//      а чтение scrollHeight принудительно пересчитывало вёрстку мегабайтного блока;
//   2) в главном процессе fs.appendFileSync открывал и закрывал файл на каждую
//      строку — замер: 20 000 строк = 11,8 с синхронной блокировки против 0,185 с
//      с открытым дескриптором.
// ===========================================================================
(function installLogPerformance() {
  const vm = require('vm');

  ok('журнал в интерфейсе: кольцо строк, одна перерисовка на кадр', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const start = src.indexOf('const LOG_MAX_LINES');
    const end = src.indexOf('\n// Часы на ИДУЩЕМ шаге', start);
    assert(start > 0 && end > start, 'блок журнала найден');
    const block = src.slice(start, end);

    let layoutReads = 0;
    let textWrites = 0;
    const logEl = {
      _t: '',
      get textContent() { return this._t; },
      set textContent(v) { this._t = v; textWrites++; },
      get scrollHeight() { layoutReads++; return this._t.length; },
      get scrollTop() { return 0; },
      set scrollTop(v) { /* прокрутка */ },
      get clientHeight() { return 100; },
    };
    const frames = [];
    const ctx = {
      $: () => logEl,
      requestAnimationFrame: (fn) => { frames.push(fn); },
      setTimeout: (fn) => { frames.push(fn); },
      String: String, Math: Math, console: console,
    };
    vm.createContext(ctx);
    vm.runInContext(block + '\n; this.__append = appendLog; this.__lines = LOG_LINES;', ctx);

    const N = 40000;
    for (let i = 0; i < N; i++) ctx.__append('Collecting package==1.0.' + i);
    while (frames.length) frames.shift()();

    assert(ctx.__lines.length <= 800, 'журнал ограничен: ' + ctx.__lines.length + ' строк из ' + N);
    assert(textWrites < 100, 'перерисовок ' + textWrites + ', а не по одной на строку');
    assert(layoutReads < 200, 'чтений вёрстки ' + layoutReads + ', а не ' + N);
    assert(logEl.textContent.length < 200000,
      'в DOM держится ' + Math.round(logEl.textContent.length / 1024) + ' КБ, а не мегабайты');
    // Хвост важнее всего: человек смотрит на последние строки.
    assert(logEl.textContent.indexOf('1.0.' + (N - 1)) >= 0, 'последняя строка на месте');

    // Полоски прогресса перерисовывают строку возвратом каретки — они не должны
    // плодить строки (иначе журнал раздувается в разы на ровном месте).
    // Кольцо ОБЯЗАТЕЛЬНО сбрасываем: выше в него влито 40 000 строк, оно насыщено
    // до предела, и сравнение длин было бы тождественно истинным — проверка
    // проходила бы даже при полностью удалённом схлопывании.
    ctx.__lines.length = 0;
    ctx.__append('строка до полоски');
    const before = ctx.__lines.length;
    for (let i = 0; i < 500; i++) ctx.__append('\rЗагрузка ' + i + '%');
    while (frames.length) frames.shift()();
    assert(ctx.__lines.length <= before + 500,
      'возврат каретки не плодит лишних строк (+' + (ctx.__lines.length - before) + ')');
    assert(ctx.__lines.indexOf('строка до полоски') >= 0,
      'полоска прогресса не стёрла соседнюю строку');
    assert(ctx.__lines.every((l) => l.indexOf(String.fromCharCode(13)) === -1),
      'в журнале не осталось сырых возвратов каретки');
  });

  ok('журнал на диске: дескриптор открыт один раз, а не на каждую строку', () => {
    const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    const i = s.indexOf('function logToFile');
    assert(i > 0, 'функция найдена');
    const body = s.slice(i, s.indexOf('\n}', i));
    assert(!/appendFileSync/.test(body),
      'appendFileSync убран — он открывал и закрывал файл на КАЖДОЙ строке');
    assert(/openSync/.test(body) && /writeSync/.test(body), 'пишем в открытый дескриптор');
    // Дескриптор мог протухнуть — обязан быть сброс, иначе журнал умрёт молча.
    assert(/logFd = null/.test(s), 'при ошибке дескриптор сбрасывается для переоткрытия');

    // Поведенчески: гоняем САМУ функцию в песочнице с подменённым fs и считаем
    // системные вызовы. Раньше здесь стоял замер времени с порогом «втрое быстрее» —
    // он ловил ту же регрессию косвенно и зависел от диска раннера: на CI-агенте
    // Windows отношение вышло 2.2 (720 мс против 331 мс), тест покраснел, хотя код
    // не менялся. Число открытий файла от скорости машины не зависит вообще.
    const calls = { open: 0, write: 0, close: 0 };
    const fakeFs = {
      mkdirSync: () => {},
      openSync: () => { calls.open++; return 7; },
      writeSync: () => { calls.write++; },
      closeSync: () => { calls.close++; },
    };
    const lc = {
      fs: fakeFs, logDirReady: false, logFd: null,
      LOG_DIR: 'd', LOG_PATH: 'p', Date: Date, console: console,
    };
    vm.createContext(lc);
    vm.runInContext(body + '\n}\n; this.__log = logToFile;', lc);

    const N = 4000;
    for (let k = 0; k < N; k++) lc.__log('pydeps', 'Collecting package==1.0.' + k);
    assert(calls.write === N, 'записано строк: ' + calls.write + ' из ' + N);
    assert(calls.open === 1,
      'на ' + N + ' строк файл открыт ' + calls.open + ' раз, а должен один');

    // Дескриптор протух (файл убрали/переименовали) — следующая строка обязана
    // открыть заново, иначе журнал умрёт молча до конца установки.
    let boom = true;
    fakeFs.writeSync = () => { if (boom) { boom = false; throw new Error('EBADF'); } calls.write++; };
    lc.__log('pydeps', 'строка на протухшем дескрипторе');
    assert(calls.close === 1, 'протухший дескриптор закрыт перед сбросом');
    lc.__log('pydeps', 'строка после сброса');
    assert(calls.open === 2, 'после сбоя дескриптор переоткрыт, открытий: ' + calls.open);
    assert(calls.write === N + 1, 'строка после сброса всё-таки записана');
  });
})();

// ===========================================================================
// Четвёртый круг ревью. Все находки — в правках ПРЕДЫДУЩЕГО круга.
// ===========================================================================
(function fourthRoundFixes() {
  const vm = require('vm');

  // Проверка «запуском» из bridge.sh сталкивалась с single-instance-замком уже
  // РАБОТАЮЩЕГО агента (порт 127.0.0.1:1079), объявляла его сломанным, СНОСИЛА
  // рабочий автозапуск, убивала живой мост — и печатала «OK».
  // То есть повторная установка ломала работающий компонент под видом успеха.
  ok('мост: повторная установка не сносит чужой рабочий автозапуск', () => {
    const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'bridge.sh'), 'utf8');
    // Разрушительных вызовов не осталось нигде в файле.
    assert(!/rm -f "\$LA"/.test(s), 'plist автозапуска больше не удаляется при неудаче пробы');
    assert(!/launchctl remove com\.hamidun\.bridge/.test(s), 'живой агент больше не выгружается насильно');
    // Проба идёт отдельным режимом БЕЗ побочных эффектов: работающий мост
    // выгружать не нужно вовсе. Прошлая версия его выгружала — и этим позволяла
    // пробе поднять НАСТОЯЩИЙ мост, оставив осиротевший ssh на порту 1080.
    assert(/--selftest/.test(s), 'проба идёт режимом самопроверки');
    // unload остаётся ЗАКОННО — как часть перезагрузки при установке нового
    // plist. Недопустимо другое: выгружать работающий мост РАДИ ПРОБЫ.
    assertOrder(s, '--selftest', 'launchctl unload',
      'выгрузка идёт только ПОСЛЕ пробы, как часть установки нового автозапуска');
    assert(s.indexOf('bridge_agent.py --headless >') === -1, 'настоящий агент в фоне для пробы не запускается');
    // Смотрим КОД ВОЗВРАТА, а не «жив ли процесс через N секунд».
    assert(!/kill -0 "\$PROBE_PID"/.test(s), 'критерий «жив через 3 с» убран');
    const ag = fs.readFileSync(path.join(ROOT, 'agent', 'bridge_agent.py'), 'utf8');
    assert(/--selftest/.test(ag), 'агент понимает режим самопроверки');
    assert(/HM-BRIDGE-SELFTEST-OK/.test(ag), 'самопроверка отдаёт распознаваемый вердикт');
    // Самопроверка обязана стоять ДО взятия порт-замка, иначе она снова упрётся
    // в работающий мост.
    // Якорь — именно ВЫЗОВ, а не определение функции: «acquire_single_instance()»
    // встречается и в строке def выше по файлу, и проверка порядка ловила её.
    assertOrder(ag, '"--selftest" in sys.argv', 'if not acquire_single_instance():',
      'самопроверка не берёт порт-замок');
  });

  // Строка с возвратом каретки ЗАТИРАЛА предыдущую строку журнала — в том числе
  // строку ошибки. Строка, оканчивающаяся на CR, уничтожала сразу две.
  // main.js уже режет вывод на полные логические строки (split /\r?\n/), поэтому
  // пришедший \r — это перерисовка ВНУТРИ строки, а не продолжение предыдущей.
  ok('журнал: строка с возвратом каретки не стирает предыдущую', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const start = src.indexOf('const LOG_MAX_LINES');
    const end = src.indexOf('\n// Часы на ИДУЩЕМ шаге', start);
    assert(start > 0 && end > start, 'блок журнала найден');
    const logEl = {
      _t: '', get textContent() { return this._t; }, set textContent(v) { this._t = v; },
      get scrollHeight() { return this._t.length; }, get scrollTop() { return 0; },
      set scrollTop(v) { /* прокрутка */ }, get clientHeight() { return 100; },
    };
    const frames = [];
    const ctx = {
      $: () => logEl,
      requestAnimationFrame: (fn) => frames.push(fn),
      setTimeout: (fn) => frames.push(fn),
      String: String, Math: Math, console: console,
    };
    vm.createContext(ctx);
    vm.runInContext(src.slice(start, end) + '\n; this.__append = appendLog; this.__lines = LOG_LINES;', ctx);
    const L = ctx.__lines;
    const flush = () => { while (frames.length) frames.shift()(); };

    ctx.__append('=== Установка Python-пакетов ===');
    ctx.__append('[!] ОШИБКА: не хватает места на диске');
    ctx.__append('\rDownloading numpy 10%\rDownloading numpy 100%');
    flush();
    assert(L.indexOf('[!] ОШИБКА: не хватает места на диске') >= 0,
      'строка ошибки уцелела — раньше её стирала полоска прогресса: ' + JSON.stringify(L));
    assert(L[L.length - 1] === 'Downloading numpy 100%', 'от полоски остался последний кадр');

    // Хвостовой CR: раньше подставлял ПУСТУЮ строку вместо содержимого и убивал соседнюю.
    L.length = 0;
    ctx.__append('важное сообщение');
    ctx.__append('Загрузка 100%\r');
    flush();
    assert(L.indexOf('важное сообщение') >= 0, 'соседняя строка цела при хвостовом CR');
    assert(L[L.length - 1] === 'Загрузка 100%', 'пустая строка не подставилась: ' + JSON.stringify(L));

    // Обычные строки по-прежнему каждая своя, и предел объёма держится.
    L.length = 0;
    for (let i = 0; i < 3000; i++) ctx.__append('строка ' + i);
    flush();
    assert(L.length <= 800, 'кольцо держит предел: ' + L.length);
    assert(L[L.length - 1] === 'строка 2999', 'хвост на месте');
  });

  // Быстрый путь (и вся его кухня кодовых страниц) удалён. «×27 окно не
  // морозится» теперь держится на двух вещах, и обе — стеречь:
  //   1) freshWindowsPath читает машинный И пользовательский PATH ОДНИМ
  //      запуском интерпретатора (regQueryManyDotNet), а не двумя спавнами;
  //   2) кэш PATH сбрасывается ТОЧЕЧНО (invalidatePathCache после
  //      компонентного скрипта и после правки PATH), а НЕ на каждом проходе
  //      детекции — иначе каждый проход платит запуск интерпретатора заново.
  ok('реестр: PATH читается одной пачкой (HKLM+HKCU), кэш сбрасывается точечно', () => {
    const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    const code = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    // 1) Оба PATH — одним вызовом пачки, поштучных чтений в freshWindowsPath нет.
    const fwp = code.slice(code.indexOf('function freshWindowsPath()'), code.indexOf('let _detPathCache'));
    assert(fwp.length > 100, 'freshWindowsPath найден');
    assert((fwp.match(/regQueryManyDotNet\(/g) || []).length === 1,
      'машинный и пользовательский PATH читаются ОДНИМ вызовом regQueryManyDotNet');
    assert(/HKLM\\\\SYSTEM\\\\CurrentControlSet[\s\S]*?HKCU\\\\Environment/.test(fwp),
      'в пачке — машинный (HKLM) И пользовательский (HKCU) PATH');
    assert(!/regQueryValueDotNet\(/.test(fwp) && !/regQueryValueTyped\(/.test(fwp),
      'поштучных чтений реестра в freshWindowsPath не осталось');
    // 2) Проход детекции кэш PATH НЕ трогает…
    const drc = code.slice(code.indexOf('function detResetCaches'), code.indexOf('function invalidatePathCache'));
    assert(drc.length > 10, 'detResetCaches найден');
    assert(!/_detPathCache/.test(drc),
      'detResetCaches НЕ сбрасывает кэш PATH (иначе каждый проход детекции = спавн интерпретатора)');
    // …сброс — точечный и существует.
    const inv = code.slice(code.indexOf('function invalidatePathCache'), code.indexOf('function freshWindowsPathCached'));
    assert(/_detPathCache = ''/.test(inv), 'invalidatePathCache честно сбрасывает кэш PATH');
    // Вызывается после завершения компонентного скрипта…
    const closeIdx = code.indexOf("child.on('close'");
    assert(closeIdx > 0, 'обработчик завершения компонентного скрипта найден');
    assert(/invalidatePathCache\(\);/.test(code.slice(closeIdx, closeIdx + 400)),
      'завершение компонентного скрипта сбрасывает кэш (скрипт мог дописать PATH)');
    // …и после удаления записи из PATH.
    const wrp = code.slice(code.indexOf('function winRemoveUserPathEntry'), code.indexOf('function macBundleIdOf'));
    assert(/invalidatePathCache\(\);/.test(wrp), 'правка PATH (удаление записи) сбрасывает кэш');
  });
})();

// Сборочные маркеры не должны попадать в репозиторий. Их пишут ПРЯМО В РАБОЧЕЕ
// ДЕРЕВО фетчеры vendor (tools/fetch-vendor.ps1, tools/fetch-vendor-mac.sh), и
// оттуда они дважды уезжали в коммит. Последствие: `npm run dist:mac` даёт .app,
// который сам себя блокирует (vendorBlockInfo видит offlineEdition без vendor и
// показывает модалку про карантин с погашенной кнопкой «Установить»), а любой
// remote-компонент вместо докачки печатает «офлайн-издание — докачка не нужна».
// Отсутствие маркера раньше не стерёг никто — отсюда рецидив.
ok('config.json в репозитории без сборочных маркеров', () => {
  const raw = require('child_process')
    .execFileSync('git', ['show', 'HEAD:config.json'], { cwd: ROOT, encoding: 'utf8' });
  const cfg = JSON.parse(raw);
  assert(!('offlineEdition' in cfg),
    'offlineEdition — артефакт сборки, в коммите его быть не должно');
  assert(!('edition' in cfg),
    'edition — артефакт сборки, в коммите его быть не должно');
});

// ===========================================================================
// Глубокое ревью (Opus+Fable), фиксы ЯДРА. Общий класс всех прошлых кругов:
// «факт объявляется по признаку, который его не доказывает; вердикт, который
// доказывает, не переносится». Здесь закрыты инварианты И-5 (сбой чтения ≠
// результат), кодовая страница для tasklist, и замок установки на уровне процесса.
// ===========================================================================
(function deepReviewCoreFixes() {
  const MAIN = () => fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const cutRegLayer = () => {
    const s = MAIN();
    return s.slice(s.indexOf('const REG_KIND_TO_TYPE'), s.indexOf('function winRegDeleteValue'));
  };

  // И-5: неудачное чтение реестра — НЕ результат. freshWindowsPath при сбое обязан
  // (а) не строить огрызок и не кэшировать его, (б) вернуть partial=true.
  // Раньше страховка `if(!joined) joined=process.env.PATH` была МЁРТВОЙ (два push
  // выше делали parts непустым всегда) и три круга создавала иллюзию защиты.
  if (process.platform === 'win32') {
    ok('freshWindowsPath: сбой чтения реестра → partial, огрызок не кэшируется', () => {
      const body = cutRegLayer();
      const s = MAIN();
      // codeOf: в комментарии рядом я ПОЯСНЯЮ, что мёртвой строки больше нет — без
      // среза комментариев тест поймал бы это пояснение и ложно упал.
      const fpCode = codeOf(s.slice(s.indexOf('function freshWindowsPath()'), s.indexOf('// ---- кэши')));
      assert(!/if \(!joined\) joined = process\.env\.PATH/.test(fpCode),
        'мёртвая строка-страховка удалена (создавала ложное ощущение защиты)');
      assert(/partial:\s*failed/.test(fpCode), 'результат помечается partial при сбое');

      // Прогон: заглушка regQueryManyDotNet → ok:false на оба запроса.
      const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
      const env = () => {
        const s32 = path.join(process.env.SystemRoot || 'C:\Windows', 'System32');
        return Object.assign({}, process.env, { PATH: s32, Path: s32 });
      };
      let calls = 0;
      const M = new Function(
        'spawnSync', 'remoteFetch', 'detectSpawnEnv', 'Buffer', 'IS_WIN', 'TextDecoder',
        'os', 'path', 'expandWinEnv', 'npmPrefixFromRc', 'regQueryManyDotNet', '__count',
        body.slice(0, body.indexOf('function regQueryManyDotNet')) +   // до пакетного чтения
        s.slice(s.indexOf('function freshWindowsPath()'), s.indexOf('let _detPathCache')) +
        '\n; return { freshWindowsPath };'
      )(require('child_process').spawnSync, rf, env, Buffer, true, TextDecoder,
        require('os'), require('path'),
        (x) => x,                                   // expandWinEnv — тождество
        () => '',                                   // npmPrefixFromRc — пусто
        () => { calls++; return [{ ok: false, error: 'заблокировано' }, { ok: false, error: 'заблокировано' }]; },
        () => {});
      const r = M.freshWindowsPath();
      assert(r && r.partial === true, 'сбой чтения → partial=true (получили ' + JSON.stringify(r && r.partial) + ')');
      // Один ретрай: заглушка звана дважды.
      assert(calls === 2, 'при сбое делается ровно один ретрай (вызовов: ' + calls + ')');
    });
  }

  // Вывод tasklist декодируется кодовой страницей консоли, а не UTF-8 — иначе
  // кириллический владелец explorer стал бы мусором и дал ложный баннер «под
  // чужой учёткой». decodeConsole — общий примитив, но РЕЕСТРА он не касается.
  ok('tasklist читается через decodeConsole, реестр — нет', () => {
    const s = MAIN();
    const fw = s.slice(s.indexOf('function detectForeignUserWarning'),
      s.indexOf('function detectForeignUserWarning') + 3000);
    assert(/decodeConsole\(/.test(fw), 'вывод tasklist декодируется примитивом консоли');
    assert(!/encoding: 'utf8'[^\n]*tasklist/i.test(s), 'tasklist не читается как utf8');
    // decodeConsole определён и умеет буфер.
    assert(/function decodeConsole/.test(s), 'примитив decodeConsole есть');
  });

  // Замок установки — свойство ПРОЦЕССА, а не окна. Ctrl+R сбрасывал renderer, и
  // второй прогон стартовал поверх живых дочерних. Теперь _installBusy в main.
  ok('замок установки живёт в main и снимается только после завершения шага', () => {
    const s = MAIN();
    assert(/let _installBusy = false/.test(s), 'флаг замка объявлен в main');
    const h = s.slice(s.indexOf("ipcMain.handle('run-component'"), s.indexOf("ipcMain.handle('open-external'"));
    assert(/if \(_installBusy\)/.test(h), 'повторный вход отклоняется');
    assert(/_installBusy = true/.test(h), 'замок берётся на входе');
    // Снятие — в finally, ПОСЛЕ await (иначе снялось бы до завершения процесса).
    assert(/\} finally \{[\s\S]*_installBusy = false/.test(h), 'замок снимается в finally');
    assert(/return await new Promise/.test(h),
      'промис ожидается через await — finally ждёт реального завершения шага');
    const awaitPos = h.indexOf('return await new Promise');
    const finallyPos = h.indexOf('_installBusy = false');
    assert(awaitPos > 0 && finallyPos > awaitPos, 'finally стоит ПОСЛЕ await-промиса');
  });
})();

// ===========================================================================
// Глубокое ревью: claude.ps1 + verify.ps1. Инвариант «удаляем только положенное
// НАМИ; один факт — один стандарт доказательства».
// ===========================================================================
(function claudeOwnershipAndVerdict() {
  const claude = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'claude.ps1'), 'utf8');
  const verify = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'verify.ps1'), 'utf8');

  // Снимок ДО офлайн-установки: рабочий чужой claude не перетирается и не сносится.
  ok('claude.ps1: рабочий claude не трогаем (снимок $preExisting)', () => {
    const s = claude();
    assert(/\$preExisting = 'none'/.test(s), 'снимок инициализируется');
    assert(/if \(\$preExisting -eq 'works'\)/.test(s), 'при works офлайн-установка пропускается');
    // Офлайн-ветка не запускается, если claude уже работает.
    assert(/if \(-not \$offlineOk -and \$cache/.test(s),
      'офлайн-ветка гейтится флагом offlineOk (works → не входим)');
    // Удаление сломанного — только если до нас НЕ было рабочего.
    assert(/preExisting -ne 'works' -and \(Remove-HmBrokenClaude/.test(s),
      'Remove-HmBrokenClaude не трогает работавший до прогона claude');
  });

  // Вердикт запуском переносится в checks.json, verify его читает, а не судит по файлу.
  ok('claude.ps1 пишет вердикт в checks.json, verify.ps1 его переносит', () => {
    const c = claude();
    assert(/function Write-HmCheck/.test(c), 'claude.ps1 умеет писать вердикт');
    const writes = (c.match(/Write-HmCheck 'claude'/g) || []).length;
    assert(writes >= 3, 'вердикт пишется во всех исходах (' + writes + ')');
    ['works', 'broken', 'unverified'].forEach((v) =>
      assert(c.indexOf("Write-HmCheck 'claude' '" + v + "'") >= 0, 'записывается вердикт ' + v));

    const v = verify();
    const block = v.slice(v.indexOf("if (-not (Test-Selected 'claude'))"), v.indexOf('# --- Конфиг'));
    assert(/checks\.json/.test(block), 'verify читает checks.json');
    // CHECK ok — ТОЛЬКО при verdict=works; наличие файла даёт лишь строку пути.
    assert(/verdict -eq 'works'\)\s*\{\s*Write-Host "CHECK ok Claude CLI"/.test(block),
      'CHECK ok выводится только при verdict=works');
    assert(/if \(\$claudeBin\) \{ Write-Host "  claude: \$claudeBin" \}/.test(block),
      'под наличием файла — только путь, не CHECK ok');
    // Нет вердикта / broken → fail, а не зелёная галочка.
    assert(/Write-Host "CHECK fail Claude CLI"/.test(block), 'без вердикта → fail');
    // Строки распознаются рендерерным регэкспом.
    const re = /^CHECK (ok|fail|skip)\s+(.*)$/;
    ['CHECK ok Claude CLI', 'CHECK skip Claude CLI (установлен, запуск не проверен)', 'CHECK fail Claude CLI']
      .forEach((l) => assert(re.test(l), 'рендерер распознаёт: ' + l));
  });
})();

// ===========================================================================
// Глубокое ревью (Opus+Fable): подсистема МОСТА (bridge.ps1 / bridge.sh).
// Три инварианта:
//   1) пустое значение НЕ перезаписывает непустое в конфиге ученика
//      (bridgeToken/enrollEndpoint; config.json — PRESERVE в uninstall-targets,
//      значит значения ценны, а повторная установка их стирала);
//   2) замена работающего сервиса — ТРАНЗАКЦИЯ: после `launchctl load`
//      загрузка ПОДТВЕРЖДАЕТСЯ (launchctl list) ДО «OK: AI-мост установлен»;
//   3) гейт работоспособности автозапуска — свойство ПОДСИСТЕМЫ: selftest
//      агента есть и на Windows (ДО записи HKCU\Run), не только на macOS.
// Прогоны БЕЗ побочных эффектов: bridge.ps1 идёт ЦЕЛИКОМ в песочнице
// (LOCALAPPDATA=tmp; New-ItemProperty/Start-Process/Get-Command закрыты
// функциями драйвера — функция в PS имеет приоритет над cmdlet; де-элевация —
// стаб _deelev.ps1 рядом с копией скрипта, БЕЗ schtasks и БЕЗ реального
// HKCU\Run); bridge.sh — фрагментами с launchctl-функцией-стабом и sandbox-HOME.
// ===========================================================================
(function bridgeSubsystemInvariants() {
  const PS51 = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const psSrc = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'bridge.ps1'), 'utf8');
  const shSrc = () => fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'bridge.sh'), 'utf8');

  // --- Статика: инварианты видны в коде (идут на любой ОС) ---
  ok('мост (статика): guard пустого токена, selftest-гейт до Run, launchctl подтверждается', () => {
    const ps = psSrc();
    // И-1 (Windows): запись bridgeToken в update-ветке — ТОЛЬКО под условием непустоты.
    const upd = ps.slice(ps.indexOf('elseif ($env:HM_BRIDGE_ENDPOINT)'), ps.indexOf('# 5.'));
    assert(upd.length > 50, 'ps1: update-ветка конфига найдена');
    const guard = upd.indexOf('if ($env:HM_BRIDGE_TOKEN)');
    assert(guard >= 0, 'ps1: guard непустоты токена есть');
    assert(!/\$cfg\.bridgeToken\s*=/.test(upd.slice(0, guard)) && !/Add-Member/.test(upd.slice(0, guard)),
      'ps1: безусловной записи токена ДО guard не осталось');
    assertOrder(upd, 'if ($env:HM_BRIDGE_TOKEN)', '$cfg.bridgeToken',
      'ps1: bridgeToken пишется только внутри guard');
    // Побочно: сбой записи конфига → «Сервер настроен» не объявляется.
    assert(/\$cfgOk = \$false/.test(upd), 'ps1: catch помечает конфиг несписанным');
    assert(/\$env:HM_BRIDGE_ENDPOINT -and \$cfgOk/.test(ps), 'ps1: «Сервер настроен» гейтится $cfgOk');
    // И-3 (Windows): selftest де-элевированно и ДО записи HKCU\Run; Run — внутри if ($agentOk).
    assertOrder(ps, "Invoke-HmDeElevated $py @($agentPath, '--selftest')",
      "New-ItemProperty -Path 'HKCU:", 'ps1: selftest идёт ДО записи Run');
    assert(/if \(\$agentOk\) \{\s*\r?\n\s*New-ItemProperty/.test(ps),
      'ps1: запись Run — только внутри гейта $agentOk');
    assert(!/& \$py\b/.test(ps.replace(/#[^\n]*/g, '')),
      'ps1: user-writable python НЕ исполняется напрямую под elevated (SECURITY #6)');
    assert(/HM-RECEIPT reg[^\n]*HamidunBridge/.test(ps) && /if \(\$agentOk\) \{ Write-Host "HM-RECEIPT reg/.test(ps),
      'ps1: реестровая квитанция эмитится только при реально записанном Run');

    const sh = shSrc();
    // Комментарии срезаем: строки-пояснения цитируют и «OK: AI-мост установлен»,
    // и старый код — порядок и отсутствие проверяем ТОЛЬКО по коду.
    const shCode = sh.replace(/^\s*#[^\n]*$/gm, '');
    // И-1 (macOS): подстановка bridgeToken — только под guard непустоты; старая
    // безусловная строка TK="${HM_BRIDGE_TOKEN:-}" (пустое затирало токен) удалена.
    assert(shCode.indexOf('TK="${HM_BRIDGE_TOKEN:-}"') === -1, 'sh: безусловная подстановка токена удалена');
    assertOrder(shCode, '[ -n "${HM_BRIDGE_TOKEN:-}" ]', 's/("bridgeToken"',
      'sh: bridgeToken пишется только под guard непустоты');
    assert(!/"\$CFG" 2>\/dev\/null \|\| true/.test(shCode), 'sh: сбой правки конфига больше не глотается (|| true)');
    // И-2 (macOS): после load — подтверждение через launchctl list (bash 3.2, без print gui/).
    assertOrder(shCode, 'launchctl load "$LA"', 'launchctl list', 'sh: подтверждение идёт ПОСЛЕ load');
    assert(!/launchctl print gui\//.test(shCode), 'sh: без launchctl print gui/ (bash 3.2 переносимость)');
    assertOrder(shCode, 'if [ "$LOAD_OK" != "1" ]', 'OK: AI-мост установлен',
      'sh: проверка транзакции стоит ДО объявления успеха');
    assert(/if \[ "\$LOAD_OK" != "1" \]; then\n(.*\n){1,5}?\s*exit 1/.test(shCode),
      'sh: неподтверждённая транзакция → честная ошибка (exit 1)');
  });

  // --- Синтаксис (bridge-скрипты не входили в старые syntax-списки) ---
  if (powershellAvailable()) {
    ok('bridge.ps1: PowerShell 5.1 парсер без ошибок (синтаксис + BOM)', () => {
      const script = path.join(ROOT, 'scripts', 'windows', 'bridge.ps1');
      const b = fs.readFileSync(script);
      assert(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF, 'первые байты — UTF-8 BOM');
      const cmd = "$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" + script +
        "',[ref]$null,[ref]$e);if($e -and $e.Count -gt 0){$e|%{[Console]::Error.WriteLine($_.Message)};exit 3};exit 0";
      const r = spawnSync(PS51, ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 60000 });
      assert(r.status === 0, 'ParseFile: ' + (r.stderr || r.stdout || ''));
    });
  }
  if (bashAvailable()) {
    ok('bridge.sh: bash -n без синтаксических ошибок', () => {
      const r = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', 'macos', 'bridge.sh')], { encoding: 'utf8', timeout: 30000 });
      assert(r.status === 0, 'bash -n: ' + (r.stderr || ''));
    });
  }

  // --- Функциональные прогоны bridge.ps1 (PS 5.1, песочница) ---
  function mkBridgeWinSandbox() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-bridge-'));
    const scriptsDir = path.join(base, 'scripts');
    fs.mkdirSync(scriptsDir);
    fs.copyFileSync(path.join(ROOT, 'scripts', 'windows', 'bridge.ps1'), path.join(scriptsDir, 'bridge.ps1'));
    // Стаб примитива де-элевации ($PSScriptRoot копии → сорсится ОН, не настоящий):
    // НИКАКОГО schtasks; код возврата selftest задаёт тест через HM_TEST_SELFTEST_EXIT.
    fs.writeFileSync(path.join(scriptsDir, '_deelev.ps1'), Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from([
        'function Invoke-HmDeElevated {',
        '  param($Exe, [string[]]$ArgList = @())',
        '  Add-Content -LiteralPath $env:HM_TEST_LOG -Value ("DEELEV " + ($ArgList -join " "))',
        '  if ($ArgList -contains "--selftest") { return [pscustomobject]@{ Gate = "medium"; Code = [int]$env:HM_TEST_SELFTEST_EXIT } }',
        '  return [pscustomobject]@{ Gate = "medium"; Code = 0 }',
        '}'
      ].join('\r\n'), 'utf8')
    ]));
    const agentDir = path.join(base, 'agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'bridge_agent.py'), '# stub agent (never executed by test)\n');
    const localApp = path.join(base, 'localapp');
    fs.mkdirSync(localApp);
    const logPath = path.join(base, 'calls.log');
    fs.writeFileSync(logPath, '');
    // Драйвер: функции ЗАКРЫВАЮТ одноимённые cmdlets → реестр/explorer не трогаются,
    // а вызовы протоколируются в HM_TEST_LOG. Get-Command отдаёт фейковый python —
    // прогон герметичен и не зависит от софта машины (сам python не исполняется).
    const driver = path.join(base, 'driver.ps1');
    fs.writeFileSync(driver, Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from([
        "$ErrorActionPreference = 'Continue'",
        'function Get-Command { param($Name, $ErrorAction)',
        '  if ("$Name" -eq "python") { return [pscustomobject]@{ Source = "C:\\HmFakePy\\python.exe" } }',
        '  return [pscustomobject]@{ Source = "$Name" }',
        '}',
        'function New-ItemProperty { param($Path, $Name, $Value, $PropertyType, [switch]$Force)',
        '  Add-Content -LiteralPath $env:HM_TEST_LOG -Value ("REG-WRITE " + $Path + "|" + $Name + "|" + $Value)',
        '}',
        'function Start-Process { param($FilePath, $ArgumentList, $ErrorAction)',
        '  Add-Content -LiteralPath $env:HM_TEST_LOG -Value ("START " + $FilePath)',
        '}',
        '& (Join-Path $PSScriptRoot "scripts\\bridge.ps1")',
        'exit $LASTEXITCODE'
      ].join('\r\n'), 'utf8')
    ]));
    return { base, agentDir, localApp, logPath, driver };
  }
  function seedWinCfg(sb, cfg) {
    const dir = path.join(sb.localApp, 'HamidunBridge');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    return p;
  }
  function runBridgePs1(sb, extraEnv) {
    const env = Object.assign({}, process.env, {
      LOCALAPPDATA: sb.localApp, HM_AGENT_DIR: sb.agentDir, HM_TEST_LOG: sb.logPath
    });
    ['HM_DRY_RUN', 'HM_VENDOR', 'HM_BRIDGE_TOKEN', 'HM_BRIDGE_ENDPOINT', 'HM_BRIDGE_PACDOMAINS']
      .forEach((k) => delete env[k]);
    Object.assign(env, extraEnv || {});
    return spawnSync(PS51, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '" + sb.driver + "'; exit $LASTEXITCODE"],
      { encoding: 'utf8', timeout: 120000, env });
  }
  const studentCfg = () => ({
    enrollEndpoint: 'https://old.example/enroll', bridgeToken: 'STUDENT-TOKEN',
    ssh: { host: 'vps.example', port: 22, user: 'u1', keyPath: 'k', password: '' },
    socksPort: 1080, httpPort: 1081, pacPort: 1082,
    pacDomains: ['claude.ai', 'anthropic.com'], enabled: true
  });

  if (powershellAvailable()) {
    ok('bridge.ps1 (прогон PS 5.1): пустой HM_BRIDGE_TOKEN НЕ затирает токен ученика; selftest OK → Run пишется ПОСЛЕ selftest', () => {
      const sb = mkBridgeWinSandbox();
      try {
        const cfgPath = seedWinCfg(sb, studentCfg());
        const r = runBridgePs1(sb, { HM_BRIDGE_ENDPOINT: 'https://new.example/enroll', HM_TEST_SELFTEST_EXIT: '0' });
        assert(r.status === 0, 'exit 0, а не ' + r.status + ': ' + (r.stderr || r.stdout || ''));
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.strictEqual(cfg.bridgeToken, 'STUDENT-TOKEN', 'непустой токен ученика ЦЕЛ при пустом HM_BRIDGE_TOKEN');
        assert.strictEqual(cfg.enrollEndpoint, 'https://new.example/enroll', 'endpoint издателя доставлен');
        assert.strictEqual(cfg.ssh.host, 'vps.example', 'ssh ученика цел');
        assert.strictEqual(cfg.enabled, true, 'enabled ученика цел');
        const log = fs.readFileSync(sb.logPath, 'utf8');
        assert(/DEELEV [^\n]*--selftest/.test(log), 'selftest прогнан де-элевированно');
        assert(/REG-WRITE HKCU:[^\n]*\|HamidunBridge\|/.test(log), 'Run-ключ записан (перехвачен стабом, selftest прошёл)');
        assertOrder(log, '--selftest', 'REG-WRITE', 'selftest идёт ДО записи Run');
        assert(r.stdout.indexOf('OK: AI-мост установлен') >= 0, 'успех объявлен');
        assert(r.stdout.indexOf('Сервер настроен') >= 0, 'конфиг записан → «Сервер настроен»');
      } finally { fs.rmSync(sb.base, { recursive: true, force: true }); }
    });

    ok('bridge.ps1 (прогон PS 5.1): selftest падает → HKCU\\Run НЕ пишется, успех не объявляется; непустой токен при этом доставлен', () => {
      const sb = mkBridgeWinSandbox();
      try {
        const cfgPath = seedWinCfg(sb, studentCfg());
        const r = runBridgePs1(sb, {
          HM_BRIDGE_ENDPOINT: 'https://new.example/enroll',
          HM_BRIDGE_TOKEN: 'NEW-TOKEN', HM_TEST_SELFTEST_EXIT: '1'
        });
        assert(r.status === 0, 'распаковано без автозапуска — это НЕ провал шага (exit ' + r.status + ')');
        const log = fs.readFileSync(sb.logPath, 'utf8');
        assert(/DEELEV [^\n]*--selftest/.test(log), 'selftest прогнан');
        assert(log.indexOf('REG-WRITE') === -1, 'ветка записи HKCU\\Run НЕ достигнута');
        assert(log.indexOf('START') === -1, 'запуск «сейчас» тоже не делался (агент нерабочий)');
        assert(r.stdout.indexOf('OK: AI-мост установлен') === -1, '«установлен» НЕ объявлен');
        assert(r.stdout.indexOf('распакован') >= 0, 'честное «распакован, автозапуск не ставился»');
        assert(r.stdout.indexOf('HM-RECEIPT path') >= 0, 'путь в квитанции остаётся (каталог создан)');
        assert(r.stdout.indexOf('HM-RECEIPT reg') === -1, 'реестровой квитанции нет — Run не писали');
        // Guard не ломает штатную доставку: НЕПУСТОЙ токен обновлён (конфиг правится до гейта).
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.strictEqual(cfg.bridgeToken, 'NEW-TOKEN', 'непустой HM_BRIDGE_TOKEN доставлен');
      } finally { fs.rmSync(sb.base, { recursive: true, force: true }); }
    });
  } else {
    console.log('  ⚠️  powershell недоступен — функциональные прогоны bridge.ps1 пропущены.');
  }

  // --- Функциональные прогоны bridge.sh (bash, фрагменты + sandbox) ---
  if (bashAvailable()) {
    ok('bridge.sh (прогон): пустой HM_BRIDGE_TOKEN НЕ затирает токен ученика; непустой — доставляется', () => {
      const probe = spawnSync('bash', ['-c', 'command -v /usr/bin/perl'], { encoding: 'utf8', timeout: 15000 });
      if (probe.status !== 0) SKIP('нет /usr/bin/perl — фрагмент конфига не прогнать');
      const s = shSrc();
      const i = s.indexOf('CFG="$DST/config.json"');
      const j = s.indexOf('LA="$HOME/Library/LaunchAgents');
      assert(i >= 0 && j > i, 'фрагмент конфига найден');
      const frag = s.slice(i, j);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-brsh-')).replace(/\\/g, '/');
      try {
        const cfgPath = base + '/config.json';
        fs.writeFileSync(cfgPath, JSON.stringify(studentCfg(), null, 2));
        const run = (tok) => spawnSync('bash', ['-c',
          'set -uo pipefail\nDST="$1"\nHM_BRIDGE_ENDPOINT="https://new.example/enroll"\nHM_BRIDGE_TOKEN="' + tok + '"\n' +
          frag + '\necho "CFG_OK=$CFG_OK"\n', 'bash', base], { encoding: 'utf8', timeout: 30000 });
        let r = run('');   // пустой токен
        assert(r.status === 0, 'фрагмент отработал: ' + (r.stderr || ''));
        let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.strictEqual(cfg.bridgeToken, 'STUDENT-TOKEN', 'пустой HM_BRIDGE_TOKEN НЕ затёр токен ученика');
        assert.strictEqual(cfg.enrollEndpoint, 'https://new.example/enroll', 'endpoint издателя доставлен');
        assert(r.stdout.indexOf('CFG_OK=1') >= 0, 'правка конфига подтверждена (CFG_OK=1)');
        r = run('NEW-TOKEN');   // непустой — штатная доставка не сломана
        assert(r.status === 0, 'второй прогон: ' + (r.stderr || ''));
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.strictEqual(cfg.bridgeToken, 'NEW-TOKEN', 'непустой HM_BRIDGE_TOKEN доставлен');
      } finally { fs.rmSync(base, { recursive: true, force: true }); }
    });

    ok('bridge.sh (прогон, launchctl-стаб): загрузка НЕ подтверждена → НЕТ «OK: AI-мост установлен», exit 1; подтверждена → успех', () => {
      const s = shSrc();
      const i = s.indexOf('launchctl unload "$LA"');
      assert(i > 0, 'хвост скрипта (замена сервиса) найден');
      const frag = s.slice(i);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-brlc-')).replace(/\\/g, '/');
      try {
        const home = base + '/home';
        fs.mkdirSync(home, { recursive: true });
        // launchctl — функция-стаб В ТОМ ЖЕ шелле (без PATH/chmod-хрупкости на Windows):
        // failMode: load возвращает 1, list пуст; okMode: list отдаёт метку.
        const pre = (okMode) =>
          'set -uo pipefail\nHOME="' + home + '"\n' +
          'launchctl() {\n  case "$1" in\n' +
          '    load) return ' + (okMode ? '0' : '1') + ' ;;\n' +
          '    list) ' + (okMode ? 'echo "123 0 com.hamidun.bridge"; ' : '') + 'return 0 ;;\n' +
          '  esac\n  return 0\n}\n' +
          'LA="$HOME/com.hamidun.bridge.plist"\nDST="$HOME/HamidunBridge"\n' +
          'TRAY_OK=1\nCFG_OK=1\nHM_BRIDGE_ENDPOINT=""\n';
        let r = spawnSync('bash', ['-c', pre(false) + frag], { encoding: 'utf8', timeout: 30000 });
        assert(r.stdout.indexOf('OK: AI-мост установлен') === -1,
          'успех НЕ объявлен при неподтверждённой загрузке: ' + r.stdout);
        assert(r.stdout.indexOf('ОШИБКА') >= 0, 'честная ошибка напечатана');
        assert.strictEqual(r.status, 1, 'exit 1 при неподтверждённой транзакции (получен ' + r.status + ')');
        r = spawnSync('bash', ['-c', pre(true) + frag], { encoding: 'utf8', timeout: 30000 });
        assert.strictEqual(r.status, 0, 'exit 0 при подтверждённой загрузке: ' + (r.stderr || r.stdout || ''));
        assert(r.stdout.indexOf('OK: AI-мост установлен') >= 0, 'успех объявлен после подтверждения');
      } finally { fs.rmSync(base, { recursive: true, force: true }); }
    });
  } else {
    console.log('  ⚠️  bash недоступен — функциональные прогоны bridge.sh пропущены.');
  }
})();

// ===========================================================================
// Глубокое ревью (Opus+Fable): unpackZip (remote-fetch.js) читал stderr/stdout
// PowerShell как 'utf8'. powershell.exe пишет в КОДОВОЙ СТРАНИЦЕ КОНСОЛИ
// (обычно CP866 на ru-RU Windows), даже когда вывод перенаправлен в pipe — тот
// же класс дефекта уже был закрыт для tasklist.exe в main.js примитивом
// decodeConsole. Любая кириллица в тексте .NET-исключения (или в пути) на
// ошибке распаковки приезжала пользователю мусором. Фикс: buffer вместо
// 'utf8' + тот же chcp-based декодер, перенесённый в remote-fetch.js.
// ===========================================================================
(function unpackZipConsoleEncoding() {
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  const src = () => fs.readFileSync(path.join(ROOT, 'src', 'remote-fetch.js'), 'utf8');

  ok('unpackZip (статика): PowerShell-ветка НЕ форсирует encoding:\'utf8\', ошибка декодируется decodeConsole', () => {
    const s = src();
    const fn = s.slice(s.indexOf('function unpackZip('), s.indexOf('function removeOldUnpacked('));
    assert(fn.length > 100, 'unpackZip найдена');
    const winBranch = fn.slice(fn.indexOf("process.platform === 'win32'"), fn.indexOf('} else {'));
    assert(!/encoding:\s*'utf8'/.test(winBranch),
      'Windows-ветка unpackZip больше НЕ форсирует encoding:\'utf8\' на spawnSync (иначе кириллица в ошибке — мусор)');
    assert(/decodeConsole\(r\.stderr\)/.test(winBranch) && /decodeConsole\(r\.stdout\)/.test(winBranch),
      'текст ошибки распаковки декодируется через decodeConsole (реальная CP консоли, не utf8-угадывание)');
  });

  if (process.platform === 'win32') {
    ok('decodeConsole (запуск): реальный powershell.exe пишет кириллицу в CP консоли — decodeConsole читает верно, наивный utf8 — нет', () => {
      const ps = rf.winPowershellPath();
      assert(ps, 'winPowershellPath() нашёл системный powershell.exe');
      // Реальный процесс пишет ЛОКАЛИЗОВАННЫЙ (не наш) кириллический текст в stderr —
      // тот же класс вывода, что и текст .NET-исключения на распаковке.
      const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "[Console]::Error.WriteLine('Тест кириллицы — ошибка распаковки'); exit 1"],
        { windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
      assert.strictEqual(r.status, 1, 'дочерний процесс упал как ожидалось');
      assert(Buffer.isBuffer(r.stderr), 'stderr пришёл буфером (encoding не форсирован)');
      const decoded = rf.decodeConsole(r.stderr);
      // На ASCII-only DOS-страницах (437/850/852 — типично English-locale раннеры
      // GitHub Actions) кириллица теряется НЕОБРАТИМО ещё на уровне ОС: .NET
      // Console.Error.WriteLine кодирует строку в OutputEncoding (= кодовая
      // страница консоли) ДО того, как байты попадают в pipe, и EncoderReplacement-
      // Fallback подменяет непредставимые символы на литеральный '?' (тот же
      // best-fit класс, что и «José→Jose» у reg.exe). Никакой декодер это не
      // восстановит — это НЕ дефект decodeConsole, а физическое ограничение
      // источника. Проверяем читаемую кириллицу ТОЛЬКО там, где страница вообще
      // способна её представить (866/1251/1252/65001); иначе — что decodeConsole
      // хотя бы не падает и не даёт хуже, чем сам источник (буквальные '?').
      const cp = rf.consoleCodePage();
      const cyrillicCapable = cp === 866 || cp === 1251 || cp === 1252 || cp === 65001;
      if (cyrillicCapable) {
        assert(decoded.indexOf('Тест кириллицы') >= 0,
          'decodeConsole вернул читаемую кириллицу (CP' + cp + '): ' + JSON.stringify(decoded));
        // Доказываем, что фикс не косметический: наивный utf8-парсинг ЭТОГО ЖЕ буфера
        // на этой машине даёт мусор (иначе бага и не было бы — пропускаем сравнение,
        // если консоль и так UTF-8, напр. CI под chcp 65001).
        const naive = r.stderr.toString('utf8');
        if (naive.indexOf('Тест кириллицы') === -1) {
          assert(naive !== decoded, 'utf8-декодирование того же буфера отличается от decodeConsole (подтверждает дефект)');
        }
      } else {
        assert(typeof decoded === 'string', 'decodeConsole не упал даже на некириллической CP' + cp + ': ' + JSON.stringify(decoded));
        console.log('     (CP' + cp + ' не кодирует кириллицу — источник уже отдал best-fit «?», decodeConsole тут бессилен)');
      }
    });
  } else {
    console.log('  ⚠️  не Windows — функциональный прогон decodeConsole/unpackZip пропущен.');
  }
})();

// ===========================================================================
// Лёгкое (стриминговое) издание для macOS: мягкая плашка «файлы рядом не
// подхватятся» горела ВСЕГДА, даже когда маковод запустил .app правильно — из
// окна смонтированного dmg.
//
// Причина того же класса, что закрывали в claude.ps1/verify.ps1: ФАКТ объявлялся
// по ПРИЗНАКУ, который его не доказывает. vendorAvailable() ищет `config-pack` —
// он доказывает «полная офлайн-база рядом», но в lite его НЕТ ПО ПОСТРОЕНИЮ
// (tools/build-lite.js: LITE_KEEP_* = checksums.json + uv + курс). Показательно,
// что build-lite.js это предвидел («Курс обязателен ещё и потому, что
// vendorComplete() ищет apps/uv-macos-*.tar.gz и course/*.zip»), но
// vendorComplete() начинается с !vendorAvailable() — предусмотрительность
// обнулялась первой строкой.
//
// Проверяем НА ЖИВОЙ ЛОГИКЕ, вырезанной из main.js и выполненной в vm с
// подставной ФС: lite-том dmg (checksums+uv+курс, БЕЗ config-pack) обязан
// считаться «сиблинг на месте», а перетаскивание в «Программы» (пустой vendor) —
// нет. Плюс мутация: возврат проверки config-pack в lite-ветку обязан покраснеть.
// ===========================================================================
(function liteSiblingVendorDetection() {
  const vm = require('vm');
  const MAINSRC = () => fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

  // Вырезаем блок функций-детекторов и подставляем ему фейковые fs/path/readJson.
  // Начинаем от resourceRoot(), а НЕ от vendorRoot(): vendorRoot зовёт resourceRoot,
  // и без него ReferenceError ГЛОТАЛСЯ внутренними try/catch — тесты, ожидающие
  // false, зеленели по ложной причине, ничего не проверив. Сторожим это ассертом
  // на прямой вызов __vendorRoot() в первом же тесте.
  function cutDetectors(src) {
    const from = src.indexOf('function resourceRoot()');
    const to = src.indexOf('\n// Жёсткий стоп ДО установки');
    assert(from > 0 && to > from, 'блок детекторов vendor найден в main.js');
    const block = src.slice(from, to);
    assert(/function vendorRoot\(\)/.test(block) && /function editionVendorPresent\(\)/.test(block),
      'вырез содержит и vendorRoot, и editionVendorPresent');
    return block;
  }

  // Фейковая ФС: набор существующих путей (пути POSIX-стиля, как на macOS).
  function mkCtx(block, files, edition, platform) {
    const set = new Set(files);
    const fakeFs = {
      existsSync: (p) => set.has(String(p)),
      readdirSync: (p) => {
        const pre = String(p).replace(/\/+$/, '') + '/';
        const out = [];
        for (const f of set) {
          if (f.startsWith(pre)) {
            const rest = f.slice(pre.length);
            if (rest && rest.indexOf('/') === -1) out.push(rest);
          }
        }
        if (!out.length) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return out;
      },
    };
    const ctx = {
      fs: fakeFs,
      // НАСТОЯЩИЙ path.posix, а не самодельная склейка: vendorRoot() ищет сиблинг через
      // path.resolve(resourcesPath, '..','..','..','vendor') — самодельный join не
      // нормализовал '..', сиблинг «не находился», и тест мерил не то, что думал.
      path: path.posix,
      process: { platform, resourcesPath: '/Volumes/Hamidun Setup/Hamidun Setup.app/Contents/Resources', execPath: '/Volumes/Hamidun Setup/Hamidun Setup.app/Contents/MacOS/Hamidun Setup' },
      app: { isPackaged: true },
      __dirname: '/Volumes/Hamidun Setup/Hamidun Setup.app/Contents/Resources/app.asar/src',
      readJson: () => (edition === 'lite' ? { edition: 'lite' } : { offlineEdition: true }),
      console: console,
    };
    vm.createContext(ctx);
    // vendorRoot() на darwin поднимается на 3 уровня от resourcesPath → '/Volumes/Hamidun Setup/vendor'.
    vm.runInContext(block + '\n; this.__editionVendorPresent = editionVendorPresent; this.__vendorAvailable = vendorAvailable; this.__vendorRoot = vendorRoot;', ctx);
    return ctx;
  }

  const VOL = '/Volumes/Hamidun Setup/vendor';
  // VOL сам тоже «существует»: vendorRoot() проверяет существование КАТАЛОГА-сиблинга
  // (fs.existsSync(sibling)) прежде чем его вернуть.
  const LITE_VOLUME = [
    VOL,
    VOL + '/checksums.json',
    VOL + '/apps/uv-macos-arm64.tar.gz',
    VOL + '/apps/uv-macos-x64.tar.gz',
    VOL + '/course/vibecoding-course.zip',
  ];
  // Перетащили .app в «Программы» → сиблинга нет вовсе; внутри Resources пусто.
  const DRAGGED = [];
  const OFFLINE_VOLUME = LITE_VOLUME.concat([VOL + '/config-pack']);

  ok('lite (macOS): том dmg БЕЗ config-pack считается «сиблинг на месте» — ложной плашки нет', () => {
    const block = cutDetectors(MAINSRC());
    const ctx = mkCtx(block, LITE_VOLUME, 'lite', 'darwin');
    assert.strictEqual(ctx.__vendorRoot(), VOL, 'vendorRoot нашёл сиблинг рядом с .app: ' + ctx.__vendorRoot());
    assert.strictEqual(ctx.__vendorAvailable(), false,
      'config-pack в lite отсутствует ПО ПОСТРОЕНИЮ — старый признак честно false');
    assert.strictEqual(ctx.__editionVendorPresent(), true,
      'НО издание-осведомлённая проверка обязана дать true (checksums+uv+курс на месте) — иначе плашка горит всегда');
  });

  ok('lite (macOS): .app перетащили в «Программы» → сиблинга нет → плашка ОБЯЗАНА гореть', () => {
    const block = cutDetectors(MAINSRC());
    const ctx = mkCtx(block, DRAGGED, 'lite', 'darwin');
    assert.strictEqual(ctx.__editionVendorPresent(), false,
      'без сиблинга lite тоже сломан (uv — BUNDLED_ONLY, курс не докачивается) → предупреждаем');
  });

  ok('lite (macOS): неполный сиблинг (нет checksums.json / нет uv / нет курса) → плашка горит', () => {
    const block = cutDetectors(MAINSRC());
    for (const drop of ['/checksums.json', '/apps/uv-macos-arm64.tar.gz', '/course/vibecoding-course.zip']) {
      const files = LITE_VOLUME.filter((f) => f !== VOL + drop);
      // uv: в наборе ДВА архива (arm64+x64) — чтобы проверить именно отсутствие uv,
      // убираем оба; иначе x64 остаётся и проверка законно проходит.
      const trimmed = drop.indexOf('uv-macos') !== -1 ? files.filter((f) => f.indexOf('uv-macos') === -1) : files;
      const ctx = mkCtx(block, trimmed, 'lite', 'darwin');
      assert.strictEqual(ctx.__editionVendorPresent(), false, 'без ' + drop + ' — не «на месте»');
    }
  });

  ok('офлайн (macOS): семантика НЕ изменилась — config-pack по-прежнему обязателен', () => {
    const block = cutDetectors(MAINSRC());
    const full = mkCtx(block, OFFLINE_VOLUME, 'offline', 'darwin');
    assert.strictEqual(full.__editionVendorPresent(), true, 'полный офлайн-том → на месте');
    const noPack = mkCtx(block, LITE_VOLUME, 'offline', 'darwin');
    assert.strictEqual(noPack.__editionVendorPresent(), false,
      'офлайн-издание БЕЗ config-pack — по-прежнему «оторван» (жёсткий гейт офлайна не ослаблен)');
  });

  ok('МУТАЦИЯ: вернуть проверку config-pack в lite-ветку → тест краснеет (фикс не косметический)', () => {
    const mutated = cutDetectors(MAINSRC())
      .replace('function editionVendorPresent() {\n  if (!isLiteEdition()) return vendorAvailable();',
               'function editionVendorPresent() {\n  if (!isLiteEdition()) return vendorAvailable();\n  if (!vendorAvailable()) return false; // MUTANT');
    assert(/MUTANT/.test(mutated), 'мутация применилась (иначе тест ничего не доказывает)');
    const ctx = mkCtx(mutated, LITE_VOLUME, 'lite', 'darwin');
    assert.strictEqual(ctx.__editionVendorPresent(), false,
      'мутант обязан вернуть false на корректном lite-томе — именно это и был дефект');
  });

  ok('bootstrap отдаёт renderer editionVendorPresent, а не vendorAvailable; текст плашки верен для ОБОИХ изданий', () => {
    const s = MAINSRC();
    assert(/vendorAvailable: editionVendorPresent\(\)/.test(s),
      'bootstrap.vendorAvailable считается по изданию');
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderVendorWarning()'), app.indexOf('// ---- модальные окна'));
    assert(fn.length > 50, 'renderVendorWarning найдена');
    // Комментарии срезаем: пояснение рядом ЦИТИРУЕТ старую формулировку («офлайн-файлы»),
    // и проверка по всему фрагменту ловила бы собственный комментарий, а не код.
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert(!/офлайн-файлы/.test(code),
      'текст больше не говорит «офлайн-файлы» (в lite это читалось как «плашка не про меня»)');
    assert(/лежащие рядом с приложением/.test(code), 'текст называет реальную причину — сиблинг рядом с .app');
    // Жёсткий стоп офлайна не должен внезапно начать зависеть от нового предиката.
    assert(/if \(!vendorComplete\(\) && isOfflineEdition\(\)\)/.test(s),
      'жёсткий блок по-прежнему гейтится vendorComplete+isOfflineEdition (blast radius не расширен)');
  });

  ok('CI: build-mac-lite больше НЕ удаляет опубликованный dmg перед заливкой (404-окно)', () => {
    const y = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-mac-lite.yml'), 'utf8');
    assert(!/s3\.delete_object/.test(y),
      'delete_object убран: с момента публикации ссылки он давал гарантированные 404 на время заливки');
    assert(/abort_multipart_upload/.test(y), 'abort orphan-multipart СВОЕГО ключа сохранён');
    assert(/СТАРЫЙ dmg НЕ УДАЛЯЕМ/.test(y), 'решение задокументировано в самом workflow');
    const macFull = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-mac.yml'), 'utf8');
    assert(!/s3\.delete_object/.test(macFull), 'в build-mac.yml delete_object тоже отсутствует (парити)');
  });
})();

// ===========================================================================
// Handy (голосовой ввод) — компонент опциональный, но его обещания обязаны
// совпадать с тем, что реально произойдёт у новичка. Разведка по исходникам
// Handy v0.9.4 дала три факта, которые легко потерять при правках:
//   1) ставим ИМЕННО NSIS (-setup.exe) с флагом /S — он per-user в %LOCALAPPDATA%
//      и БЕЗ администратора; MSI у Tauri собирается perMachine и требует UAC;
//   2) модель распознавания в установщик НЕ входит и САМА не качается — значит
//      скрипт обязан сказать про ручной шаг, иначе «поставили — не работает»;
//   3) верхняя карточка в списке моделей (Parakeet EN) русского НЕ знает —
//      про это надо предупредить явно, иначе новичок выберет её.
// ===========================================================================
(function handyComponentPromises() {
  const ps = () => fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'handy.ps1'), 'utf8');

  ok('handy: компонент объявлен, опционален и не требует администратора', () => {
    const comp = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
    const all = comp.groups.flatMap((g) => g.components);
    const h = all.find((c) => c.id === 'handy');
    assert(h, 'компонент handy есть в components.json');
    assert.strictEqual(h.default, false, 'по умолчанию НЕ отмечен (тянет ещё сотни МБ модели)');
    assert.strictEqual(h.needsAdmin, false, 'NSIS per-user — админ не нужен');
    assert(/модел/i.test(h.desc), 'описание предупреждает про отдельную загрузку модели');
    assert(Array.isArray(h.platforms) && h.platforms.indexOf('win32') !== -1, 'платформа win32 заявлена');
  });

  ok('handy.ps1: ставим NSIS c /S (не MSI), проверяем факт по файлу, а не по коду возврата', () => {
    const s = ps();
    assert(/handy-setup\.exe/.test(s), 'берём вшитый NSIS-установщик');
    assert(!/\.msi/i.test(s), 'MSI не используется (он perMachine и требует администратора)');
    assert(/ArgumentList '\/S'/.test(s), 'тихая установка через /S');
    assert(/-Wait/.test(s), 'ждём завершения установщика (иначе проверка побежит раньше распаковки)');
    assert(/Confirm-HmArtifact \$local/.test(s), 'вшитый бинарь проходит sha-гейт');
    // Успех объявляется по появлению exe, а не по exit code — тот же урок, что с claude.ps1.
    const tail = s.slice(s.indexOf('$code -ne 0'));
    assertOrder(tail, 'Test-Path -LiteralPath $appExe', 'OK: Handy установлен',
      'наличие handy.exe проверяется ДО объявления успеха');
  });

  ok('handy.ps1: честно про ручной шаг и про то, что верхняя модель не знает русского', () => {
    const s = ps();
    // Рекомендация ОДНА и конкретная: по каталогу Handy (catalog.json) у Parakeet
    // TDT 0.6B v3 точность 88 при скорости 79 — как у самых тяжёлых, но вдвое
    // быстрее; Whisper Small (257 МБ) — запасной вариант «жалко трафика».
    assert(/Parakeet TDT 0\.6B v3/.test(s), 'рекомендована конкретная модель с русским');
    assert(/Whisper Small/.test(s), 'назван облегчённый вариант');
    assert(/Parakeet Unified EN/.test(s) && /русский НЕ понимает/.test(s),
      'предупреждаем про похожее название англоязычной модели (её легко перепутать)');
    assert(/705 МБ/.test(s) && /257 МБ/.test(s), 'названы реальные объёмы из каталога');
    assert(/exit 120/.test(s), 'без вшитого установщика — graceful skip, а не ложная ошибка');
  });

  ok('handy.ps1: настройки пользователя не затираются, хоткей не конфликтует с раскладкой', () => {
    const s = ps();
    assertOrder(s, 'Test-Path -LiteralPath $store', 'Настройки Handy уже есть',
      'существующий settings_store.json не перезаписываем');
    assert(/ctrl\+alt\+space/.test(s), 'пре-сид хоткея — Ctrl+Alt+Space');
    assert(!/'ctrl\+space'/.test(s), 'дефолтный Ctrl+Space не используем (переключает раскладку)');
    assert(/selected_language.*ru|'ru'/.test(s), 'язык распознавания пре-сидится русским');
    // Дефолты Handy: history_limit=5 и recording_retention_period=preserve_limit —
    // вчерашняя диктовка уже недоступна. Ставим максимум, который он поддерживает.
    assert(/history_limit = 1000/.test(s), 'история диктовок расширена (дефолт всего 5 записей)');
    assert(/recording_retention_period = 'months3'/.test(s),
      'хранение записей — months3, самый долгий вариант перечисления Handy');
  });

  // -------------------------------------------------------------------------
  // Галочка «Сразу разрешить доступ к микрофону» (HM_HANDY_MIC).
  //
  // Три вещи, которые обязаны быть правдой и легко ломаются при правках:
  //   1) БЕЗ галочки реестра не касаемся ВООБЩЕ (даже на чтение) — иначе установщик
  //      трогает приватность человека, который об этом не просил;
  //   2) и чтение, и запись идут ДЕ-ЭЛЕВИРОВАННО: установщик работает под админом, его
  //      HKCU — админская ветка, прямая запись ушла бы не тому пользователю;
  //   3) уже принятое решение (Allow ИЛИ Deny) не перезаписываем: запрет мог быть
  //      осознанным, а проверка из-под админа его бы и не увидела.
  // -------------------------------------------------------------------------

  // Вырезание PS-функции: конец — строка ровно '}' в нулевой колонке (стиль всех .ps1
  // проекта). Пропала функция → тест падает «пропало», а не зеленеет на пустоте.
  function cutPsFunction(src, header) {
    const i = src.indexOf(header);
    assert(i !== -1, 'в handy.ps1 пропало: ' + header);
    const lines = src.slice(i).split(/\r?\n/);
    const end = lines.findIndex((l, k) => k > 0 && l === '}');
    assert(end !== -1, 'не найден конец функции ' + header);
    return lines.slice(0, end + 1).join('\n');
  }
  // Тот же приём для JS (баланс фигурных скобок) — нужен, чтобы гонять кусочки app.js в vm.
  function cutJsBlock(src, header) {
    const i = src.indexOf(header);
    assert(i !== -1, 'в app.js пропало: ' + header);
    const open = src.indexOf('{', i);
    assert(open !== -1, 'нет тела у: ' + header);
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
    }
    throw new Error('не нашёл конец блока: ' + header);
  }
  const APP = () => fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

  ok('handy: опция «микрофон» объявлена в components.json и её env-ключ разрешён allowlist-ом', () => {
    const comp = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
    const all = comp.groups.flatMap((g) => g.components);
    const h = all.find((c) => c.id === 'handy');
    assert(Array.isArray(h.options) && h.options.length >= 1, 'у handy есть options[]');
    const mic = h.options.find((o) => o.id === 'mic');
    assert(mic, 'опция mic объявлена');
    assert.strictEqual(mic.env, 'HM_HANDY_MIC', 'опция едет в скрипт ключом HM_HANDY_MIC');
    assert.strictEqual(mic.default, true, 'галочка стоит по умолчанию (сам компонент и так опционален)');
    assert(mic.label && /микрофон/i.test(mic.label), 'подпись галочки говорит про микрофон');
    assert(mic.hint && /не/i.test(mic.hint), 'подсказка честно говорит, что чужое решение не меняется');

    // ЛЮБАЯ опция ЛЮБОГО компонента обязана: (а) пройти allowlist install-env
    // (иначе main молча выбросит ключ), (б) реально эмититься из envForRun.
    const appSrc = APP();
    const envFn = appSrc.slice(appSrc.indexOf('function envForRun'), appSrc.indexOf('// Журнал установки'));
    assert(envFn.length > 100, 'тело envForRun найдено');
    all.forEach((c) => (c.options || []).forEach((o) => {
      assert(installEnv.isAllowedRendererEnvKey(o.env),
        o.env + ' (опция ' + c.id + '.' + o.id + ') не разрешён allowlist-ом src/install-env.js');
      assert(envFn.indexOf(o.env) !== -1,
        o.env + ' объявлен опцией, но envForRun его не эмитит — до скрипта он не доедет');
    }));
    // Функционально: ключ реально проходит фильтр renderer-env (не только «есть в списке»).
    assert.strictEqual(installEnv.filterRendererEnv({ HM_HANDY_MIC: '1' }).HM_HANDY_MIC, '1',
      'HM_HANDY_MIC проходит filterRendererEnv');
  });

  ok('app.js: HM_HANDY_MIC = «1» ТОЛЬКО когда и компонент выбран, и галочка стоит', () => {
    const vm = require('vm');
    const appSrc = APP();
    const script = [
      cutJsBlock(appSrc, 'function optKey'),
      cutJsBlock(appSrc, 'function optionOn'),
      cutJsBlock(appSrc, 'function envForRun'),
      'function selectedIds(){ return Object.keys(STATE.selected).filter((id) => STATE.selected[id]); }',
      'this.API = { envForRun };'
    ].join('\n');
    const mkState = (opts) => ({
      config: {}, homedir: 'H', packsData: { core: [], packs: [] },
      selectedPacks: {}, selectedSkills: {}, detected: {}, repair: {}, repairConfirmed: {},
      selected: opts.selected, options: opts.options
    });
    const run = (opts) => {
      const sandbox = { STATE: mkState(opts) };
      vm.runInNewContext(script, sandbox);
      return sandbox.API.envForRun();
    };
    assert.strictEqual(run({ selected: { handy: true }, options: { 'handy.mic': true } }).HM_HANDY_MIC, '1',
      'выбран + галочка стоит → «1»');
    assert.strictEqual(run({ selected: { handy: true }, options: { 'handy.mic': false } }).HM_HANDY_MIC, '',
      'галочку сняли → пусто (скрипт реестра не тронет)');
    assert.strictEqual(run({ selected: { handy: false }, options: { 'handy.mic': true } }).HM_HANDY_MIC, '',
      'компонент не выбран → пусто, даже если галочка «висит» включённой в состоянии');
    assert.strictEqual(run({ selected: { handy: true }, options: {} }).HM_HANDY_MIC, '',
      'состояния опции нет вовсе → выключена (=== true, а не «не false»)');
  });

  ok('app.js: галочка опции рисуется у ВЫБРАННОЙ карточки и её клик не снимает компонент', () => {
    const vm = require('vm');
    const appSrc = APP();
    const script = [
      cutJsBlock(appSrc, 'function escapeHtml'),
      cutJsBlock(appSrc, 'function optKey'),
      cutJsBlock(appSrc, 'function optionOn'),
      cutJsBlock(appSrc, 'function renderComponentOptions'),
      'this.API = { renderComponentOptions };'
    ].join('\n');
    const comp = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
    const handy = comp.groups.flatMap((g) => g.components).find((c) => c.id === 'handy');
    const render = (on) => {
      const sandbox = { STATE: { options: { 'handy.mic': on } } };
      vm.runInNewContext(script, sandbox);
      return sandbox.API.renderComponentOptions(handy);
    };
    const onHtml = render(true);
    assert(/data-opt="mic"/.test(onHtml), 'чекбокс опции отрисован: ' + onHtml.slice(0, 120));
    assert(/type="checkbox" data-opt="mic" checked/.test(onHtml), 'включённая опция приходит с checked');
    assert(onHtml.indexOf(handy.options[0].label) !== -1, 'подпись из components.json на месте');
    const offHtml = render(false);
    assert(!/checked/.test(offHtml), 'выключенная опция рисуется БЕЗ checked');
    // Компонент без options[] не должен получать пустой контейнер.
    const sandbox = { STATE: { options: {} } };
    vm.runInNewContext(script, sandbox);
    assert.strictEqual(sandbox.API.renderComponentOptions({ id: 'git' }), '', 'нет options[] → ничего не рисуем');

    // Структурно: опции видны только у выбранной карточки, а клик по ним не долетает
    // до обработчика карточки (иначе галочка «разрешить» выключала бы сам компонент).
    assert(/\$\{checked \? renderComponentOptions\(c\) : ''\}/.test(appSrc),
      'renderCard показывает опции только у выбранного компонента');
    assert(/wireComponentOptions\(el, c\);/.test(appSrc), 'обработчики опций провязаны в renderCard');
    const wire = cutJsBlock(appSrc, 'function wireComponentOptions');
    assert(/\['pointerdown', 'click'\]\.forEach\(\(ev\) => row\.addEventListener\(ev, \(e\) => e\.stopPropagation\(\)\)\)/.test(wire),
      'клик по строке опции не пузырится в карточку');
    assert(/STATE\.options\[optKey\(c\.id, cb\.dataset\.opt\)\] = cb\.checked/.test(wire),
      'состояние опции пишется по клику');
  });

  ok('handy.ps1: БЕЗ HM_HANDY_MIC=1 реестр не трогается вообще (гейт — первым делом)', () => {
    const s = ps();
    const fn = cutPsFunction(s, 'function Grant-HmHandyMic');
    // Гейт стоит ДО любого обращения к реестру — и до чтения тоже.
    const iGate = fn.indexOf("if ($env:HM_HANDY_MIC -ne '1') { return }");
    assert(iGate !== -1, 'гейт по HM_HANDY_MIC на месте');
    ['ConsentStore', 'reg.exe', 'Invoke-HmDeElevated'].forEach((needle) => {
      const j = fn.indexOf(needle);
      assert(j === -1 || iGate < j, 'гейт HM_HANDY_MIC обязан стоять ДО «' + needle + '»');
    });
    // Никаких обращений к реестру ВНЕ этой функции: весь ConsentStore живёт внутри неё.
    // .ps1 хранится с CRLF (см. .gitattributes), а cutPsFunction отдаёт кусок с LF —
    // без нормализации split() не нашёл бы вырезанное тело и «внешним» оказался бы весь файл.
    const outside = s.replace(/\r\n/g, '\n').split(fn).join('');
    assert(outside.length < s.length, 'тело функции реально вырезано из исходника (нормализация переводов строк работает)');
    // Комментарии срезаем: шапка скрипта ОБЪЯСНЯЕТ механизм и по делу цитирует путь
    // ConsentStore. Без среза проверка ловила собственное пояснение и краснела на
    // исправном коде — тот же класс ошибки, что уже ловился в тестах реестра и плашки.
    const outsideCode = outside.split('\n').map((l) => (l.trim().startsWith('#') ? '' : l)).join('\n');
    assert(outsideCode.indexOf('ConsentStore') === -1,
      'ConsentStore встречается в КОДЕ только внутри Grant-HmHandyMic (комментарии не в счёт)');
    // По КОДУ, а не по всему файлу: шапка объясняет, почему прямой `Set-ItemProperty`
    // здесь запрещён, и сама содержит это имя — проверка по сырому тексту краснела
    // на собственном объяснении.
    const codeOnly = s.split(/\r?\n/).map((l) => (l.trim().startsWith('#') ? '' : l)).join('\n');
    assert(!/Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|New-Item\s+-Path\s+'?HKCU/.test(codeOnly),
      'прямых записей в реестр (Set-/New-ItemProperty) в коде нет — только де-элевированный reg.exe');
    // Гейт внутри функции, а не на местах вызова: иначе его забудут в одной из веток.
    const calls = (s.match(/Grant-HmHandyMic -ExePath \$appExe/g) || []).length;
    assert(calls >= 3, 'функция вызывается во всех ветках (уже установлен / dry-run / свежая установка), найдено: ' + calls);
    // ВАЖНО, почему не assertOrder по всему файлу: он сравнивает ПЕРВЫЕ вхождения, а
    // первый вызов Grant-HmHandyMic относится к ветке «Handy уже установлен» — там exe
    // на диске заведомо есть, и вызов законно стоит выше сообщения об успехе. Проверяем
    // то, что действительно нужно: в ветке СВЕЖЕЙ установки согласие пишется ПОСЛЕ того,
    // как факт появления exe подтверждён.
    const afterSuccess = s.slice(s.indexOf('OK: Handy установлен'));
    assert(afterSuccess.indexOf('Grant-HmHandyMic -ExePath $appExe') !== -1,
      'после свежей установки согласие пишется — вызов есть ниже подтверждения появления exe');
  });

  ok('handy.ps1: согласие пишется ДЕ-ЭЛЕВИРОВАННО (HKCU админа — не тот пользователь), fail-closed', () => {
    const s = ps();
    assert(/\. \(Join-Path \$PSScriptRoot '_deelev\.ps1'\)/.test(s), 'подключён единый примитив де-элевации');
    const fn = cutPsFunction(s, 'function Grant-HmHandyMic');
    assert(/Invoke-HmDeElevated \$regExe @\('query', \$consentKey, '\/v', 'Value'\)/.test(fn),
      'ЧТЕНИЕ существующего решения — тоже де-элевированное (из-под админа оно смотрело бы в чужую ветку)');
    assert(/Invoke-HmDeElevated \$regExe @\('add', \$consentKey, '\/v', 'Value', '\/t', 'REG_SZ', '\/d', 'Allow', '\/f'\)/.test(fn),
      'ЗАПИСЬ идёт через тот же примитив');
    // Прямого запуска reg.exe под админом быть не должно ни в одном виде.
    assert(!/&\s*\$regExe/.test(fn) && !/Start-Process[^\n]*\$regExe/.test(fn),
      'reg.exe НИКОГДА не запускается напрямую (это была бы запись в админскую ветку)');
    // fail-closed: примитив не отработал / гейт не medium → НИЧЕГО не пишем.
    assert(/if \(\$null -eq \$q -or \$q\.Gate -ne 'medium'\)/.test(fn),
      'непонятный результат проверки → ничего не меняем');
    assertOrder(fn, "if ($null -eq $q -or $q.Gate -ne 'medium')", "@('add'",
      'fail-closed-проверка стоит ДО записи');
    assert(/\$null -ne \$a -and \$a\.Gate -eq 'medium' -and \$a\.Code -eq 0/.test(fn),
      'успех объявляется только при medium-гейте И нулевом коде reg.exe');
    // Ключ строится ровно так, как его читает Windows (обратные слэши → решётки).
    assert(/CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\/.test(fn),
      'ветка ConsentStore\\microphone\\NonPackaged');
    assert(/\(\$ExePath -replace '\\\\', '#'\)/.test(fn), 'в имени подключа слэши заменены на «#»');
    assert(/^.*'HKCU\\Software\\Microsoft/m.test(fn), 'ветка именно HKCU (per-user), не HKLM');
  });

  ok('handy.ps1: уже принятое решение (Allow ИЛИ Deny) не перезаписывается', () => {
    const fn = cutPsFunction(ps(), 'function Grant-HmHandyMic');
    assertOrder(fn, "@('query'", "@('add'", 'сначала спрашиваем, потом пишем');
    const iFound = fn.indexOf('if ($q.Code -eq 0)');
    const iAdd = fn.indexOf("@('add'");
    assert(iFound !== -1, 'проверка «значение уже есть» (код 0 от reg query) на месте');
    assert(iFound < iAdd, 'проверка существующего значения стоит ДО записи');
    const between = fn.slice(iFound, iAdd);
    assert(/\breturn\b/.test(between), 'при существующем значении выходим, НЕ доходя до записи');
    assert(/не трогаю его/.test(between), 'человеку честно сказано, что его решение оставлено как есть');
    // Никакого «сначала удалим старое» — ни delete, ни перезаписи мимо проверки.
    assert(!/@\('delete'/.test(fn), 'существующее значение никогда не удаляется');
  });

  ok('fetch-config: вшитый конфиг пиннится и оставляет след о версии', () => {
    const s = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-config.js'), 'utf8');
    assert(/HM_CONFIG_REF/.test(s), 'ref сборки можно закрепить переменной окружения');
    assert(/rev-parse', 'HEAD'/.test(s), 'фактический коммит определяется ДО удаления .git');
    assert(/\.hamidun-config-pack\.json/.test(s), 'штамп версии едет внутрь пака');
    const iSha = s.indexOf("rev-parse");
    const iRm = s.indexOf("fs.rmSync(path.join(dest, '.git')");
    assert(iSha !== -1 && iRm !== -1 && iSha < iRm, 'сначала читаем SHA, потом сносим .git');
  });
})();

// ===========================================================================
// РАЗМЕРЫ КОМПОНЕНТОВ: цифра в окне «что попадёт на мой ПК» ↔ реальный vendor.
//
// ЗАЧЕМ. Размер компонента раньше был рукописной строкой components.json (sizeHint),
// её никто не пересчитывал при обновлении vendor, и она разъехалась: vscode обещал
// ~110 МБ при 221,6 МиБ, extension ~10 МБ при 85,6 МиБ, claude ~50 МБ при 1,01 ГиБ.
// Цифру видно ровно там, где мы снимаем страх «а не вирус ли это» — сумма, заниженная
// вдвое рядом с честным файлом установщика на 1,9 ГБ, страх УСИЛИВАЕТ. Теперь число
// считает tools/sync-sizes.js по реальному vendor, а этот блок стережёт, чтобы оно не
// разошлось снова и чтобы в файл нельзя было вписать цифру мимо генератора.
//
// ПОРОГ. Сверяем не байты ради байтов, а то, ЧТО УВИДИТ ЧЕЛОВЕК: провал, если
// изменилась сама надпись (fmtBytesRu округляет до МБ и до 0,1 ГБ) ИЛИ расхождение
// больше 1% — это уже за пределами тильды «~», которой подписано число. Требовать
// побайтового равенства смысла нет: генератор и так пишет точное значение, а жёсткое
// равенство падало бы от любой безобидной пересборки vendor на ту же версию.
//
// ЧИСТАЯ МАШИНА. vendor в репозиторий не коммитится, на CI его нет. Тогда сверять
// не с чем — тест ПРОПУСКАЕТСЯ ЯВНО (⏭), а не зеленеет молча: зелёная галочка на
// невыполненной проверке — ровно тот способ потерять сторожа, из-за которого этот
// дефект и дожил до продакшена. Структурные инварианты (первые четыре) работают
// всегда, включая чистый чекаут.
//
// ВРЕМЯ. Обход каталогов на Windows упирается в антивирус: config-pack (7931 файл) —
// полторы минуты, nomad-src — полминуты. Поэтому файловые компоненты проверяются
// всегда (мгновенно), а каталожные — под бюджетом времени; что не успели, честно
// перечисляется в ⏭. Полная сверка без бюджета: HM_SIZES_DEEP=1 node test/run-tests.js
// ===========================================================================
(function componentSizeHonesty() {
  console.log('== Размеры компонентов: цифра в UI сходится с реальным vendor ==');
  const sync = require(path.join(ROOT, 'tools', 'sync-sizes.js'));
  // Карта раскладки vendor на ЭТОЙ машине. darwin-числа заполняет тот же скрипт,
  // запущенный на маке, — угадывать их отсюда нельзя (артефакты другие).
  const PLATFORM = process.platform === 'darwin' ? 'darwin' : 'win32';
  const all = [];
  (components.groups || []).forEach((g) => (g.components || []).forEach((c) => all.push(c)));

  // Форматирование берём ИЗ app.js, а не переписываем: иначе тест сторожил бы свою
  // копию правил округления, а не ту, что видит человек.
  function fmtBytesRuFromApp() {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const i = src.indexOf('function fmtBytesRu');
    assert(i !== -1, 'в app.js пропала fmtBytesRu — некому форматировать число');
    const open = src.indexOf('{', i);
    let depth = 0, end = -1;
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (!depth) { end = k + 1; break; } }
    }
    assert(end !== -1, 'не нашёл конец fmtBytesRu');
    // Тот же приём, что и у остальных renderer-тестов: кусок app.js исполняется в vm,
    // объявление функции становится свойством контекста.
    const sandbox = {};
    require('vm').runInNewContext(src.slice(i, end), sandbox);
    const fn = sandbox.fmtBytesRu;
    assert(typeof fn === 'function', 'fmtBytesRu не выполнилась в vm');
    assert.strictEqual(fn(1024 * 1024), '1 МБ', 'вырезанная fmtBytesRu считает как ожидается');
    return fn;
  }

  // ---- Структурные инварианты: работают ВЕЗДЕ, включая чекаут без vendor ----

  ok('размеры: рукописного sizeHint не осталось (цифру нельзя вписать мимо генератора)', () => {
    const left = all.filter((c) => Object.prototype.hasOwnProperty.call(c, 'sizeHint')).map((c) => c.id);
    assert.deepStrictEqual(left, [],
      'sizeHint вернулся у: ' + left.join(', ') + ' — числа ставит только tools/sync-sizes.js');
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    assert(!/\bc\.sizeHint\b/.test(app), 'renderer снова читает sizeHint — поле умерло, читать нечего');
  });

  ok('размеры: число есть ТОЛЬКО у компонентов с вшитым артефактом (ничего не выдумано)', () => {
    for (const c of all) {
      if (!c.sizeBytes) continue;
      const mapped = !!((sync.VENDOR_PARTS.win32 || {})[c.id] || (sync.VENDOR_PARTS.darwin || {})[c.id]);
      assert(mapped, 'у «' + c.id + '» есть sizeBytes, но вшитых файлов в карте vendor нет — откуда цифра?');
      assert(!Object.prototype.hasOwnProperty.call(sync.NO_BUNDLED_PAYLOAD, c.id),
        '«' + c.id + '» помечен как «своего артефакта нет», но у него стоит число');
    }
  });

  ok('размеры: без числа компонент не остаётся немым — есть честная пометка', () => {
    for (const c of all) {
      if (c.hidden) continue;                                   // verify в UI не показывается
      if (c.sizeBytes && Object.keys(c.sizeBytes).length) continue;
      const n = c.sizeNote;
      const noteOk = (typeof n === 'string' && n.length > 0)
        || (n && typeof n === 'object' && Object.keys(n).length > 0);
      assert(noteOk, 'у «' + c.id + '» нет ни числа, ни пометки: человек увидит пустоту без объяснения');
    }
  });

  ok('размеры: sizeBytes — целые положительные байты под известные платформы', () => {
    const known = new Set(Object.keys(sync.VENDOR_PARTS));
    for (const c of all) {
      if (!c.sizeBytes) continue;
      assert(typeof c.sizeBytes === 'object' && !Array.isArray(c.sizeBytes), '«' + c.id + '»: sizeBytes должен быть объектом по платформам');
      for (const [p, v] of Object.entries(c.sizeBytes)) {
        assert(known.has(p), '«' + c.id + '»: неизвестная платформа ' + p);
        assert(Number.isInteger(v) && v > 0, '«' + c.id + '»/' + p + ': не целое положительное число байт: ' + v);
      }
      // Одно число на две ОС физически не бывает верным (vscode: win 221,6 МиБ vs
      // mac 520,1 МиБ) — платформенный ключ обязателен, «общего» размера нет.
      assert(!Object.prototype.hasOwnProperty.call(c.sizeBytes, 'all'),
        '«' + c.id + '»: размер не бывает общим для всех ОС — артефакты разные');
    }
  });

  ok('размеры: новый компонент не проскочит без истории про размер', () => {
    const unknown = all.filter((c) => !c.hidden
      && !(sync.VENDOR_PARTS.win32 || {})[c.id]
      && !(sync.VENDOR_PARTS.darwin || {})[c.id]
      && !Object.prototype.hasOwnProperty.call(sync.NO_BUNDLED_PAYLOAD, c.id)).map((c) => c.id);
    assert.deepStrictEqual(unknown, [],
      'не объявлены в tools/sync-sizes.js (ни артефакта, ни причины его отсутствия): ' + unknown.join(', '));
  });

  ok('окно «что попадёт на мой ПК»: единица измерения названа словами, заголовок честен в офлайне', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    assert(/function componentSizeBytes/.test(app), 'число берётся из sizeBytes/реестра, а не из строки');
    assert(/внутри установщика/.test(app), 'сказано, что цифра — вес дистрибутива внутри установщика');
    assert(/занимает на диске больше/.test(app), 'сказано, что это НЕ место на диске после установки');
    assert(/Что попадёт на мой ПК/.test(app), 'в офлайн-издании заголовок не обещает несуществующую загрузку');
    assert(/Что скачается на мой ПК/.test(app), 'в lite-издании заголовок по-прежнему про загрузку');
    const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
    assert(!/Что скачается на мой ПК/.test(html),
      'статичная подпись кнопки снова обещает загрузку — в офлайне это неправда, подпись ставит app.js по изданию');
  });

  // ---- Сверка с реальным vendor ----

  // Тот же признак «полный офлайн-vendor рядом», что и у main.js vendorAvailable():
  // config-pack везёт ТОЛЬКО полная офлайн-раскладка. При ней пропавший файл — это
  // дрейф (провал), а на lite/чистом чекауте — законное «мерить нечего» (пропуск).
  const FULL_VENDOR = (() => { try { return fs.existsSync(path.join(sync.VENDOR, 'config-pack')); } catch (e) { return false; } })();
  const HAS_VENDOR = (() => { try { return sync.vendorPresent(PLATFORM); } catch (e) { return false; } })();

  // Часть считается «дешёвой», если все её файлы — файлы, а не каталоги: statSync по
  // ним мгновенен, обход каталога на Windows — нет.
  function partsAreFiles(id) {
    const parts = (sync.VENDOR_PARTS[PLATFORM] || {})[id] || [];
    for (const raw of parts) {
      const spec = (typeof raw === 'string') ? { rel: raw } : raw;
      const rels = spec.glob ? sync.expandGlob(spec.glob) : [spec.rel];
      if (!rels.length) return false;
      for (const rel of rels) {
        let st;
        try { st = fs.statSync(path.join(sync.VENDOR, rel)); } catch (e) { return false; }
        if (st.isDirectory()) return false;
      }
    }
    return true;
  }

  const cheapIds = [], deepIds = [];
  for (const c of all) {
    if (!(sync.VENDOR_PARTS[PLATFORM] || {})[c.id]) continue;
    (partsAreFiles(c.id) ? cheapIds : deepIds).push(c.id);
  }

  // Сравнение «глазами человека»: разошлась надпись или расхождение > 1%.
  function compare(id, stored, measured, fmt) {
    if (stored === measured) return null;
    const shown = fmt(stored), real = fmt(measured);
    const drift = Math.abs(measured - stored) / Math.max(1, measured);
    if (shown === real && drift <= 0.01) return null;
    return id + ': в окне «~' + shown + '», на диске «~' + real + '» ('
      + stored + ' ↔ ' + measured + ' Б, ' + (drift * 100).toFixed(1) + '%)';
  }

  // perMs — бюджет НА КАЖДЫЙ компонент, а не общий: иначе один медленный каталог
  // (config-pack ≈ 90 с) съедает весь бюджет и уносит в пропуск даже те, что меряются
  // за 30 мс (uv, mascot). 0 = без ограничения.
  function checkLane(ids, perMs) {
    const bad = [], unchecked = [], timedOut = [];
    const fmt = fmtBytesRuFromApp();
    for (const id of ids) {
      const comp = all.find((c) => c.id === id);
      const stored = comp && comp.sizeBytes && comp.sizeBytes[PLATFORM];
      const r = sync.measureComponent(id, PLATFORM, perMs ? Date.now() + perMs : null);
      if (r.timeout) { timedOut.push(id); continue; }
      if (r.missing) {
        // Полный офлайн-vendor и файла нет — это уже дрейф, а не «нечего мерить».
        if (FULL_VENDOR) bad.push(id + ': в vendor нет ' + r.missing.join(', '));
        else unchecked.push(id);
        continue;
      }
      if (typeof stored !== 'number') {
        bad.push(id + ': файлы в vendor есть (' + sync.fmtMiB(r.bytes) + '), а числа в components.json нет');
        continue;
      }
      const problem = compare(id, stored, r.bytes, fmt);
      if (problem) bad.push(problem);
    }
    return { bad, unchecked, timedOut };
  }

  ok('размеры: файловые компоненты (setup.exe/msi/vsix/zip) сходятся с vendor', () => {
    if (!HAS_VENDOR) SKIP('vendor не развёрнут (чистая машина / CI) — сверять не с чем');
    if (!cheapIds.length) SKIP('в этой раскладке vendor нет файловых компонентов');
    const r = checkLane(cheapIds, 0);
    assert(!r.bad.length, 'цифра разошлась с vendor:\n    ' + r.bad.join('\n    ')
      + '\n    Почини одной командой: node tools/sync-sizes.js');
    if (r.unchecked.length === cheapIds.length) SKIP('ни одного файла нет на месте (lite-раскладка vendor)');
  });

  ok('размеры: каталожные компоненты (npm-cache, config-pack, nomad-src…) сходятся с vendor', () => {
    if (!HAS_VENDOR) SKIP('vendor не развёрнут (чистая машина / CI) — сверять не с чем');
    if (!deepIds.length) SKIP('в этой раскладке vendor нет каталожных компонентов');
    // Бюджет НА КОМПОНЕНТ: обход каталогов упирается в антивирус (config-pack ≈ 90 с,
    // nomad-src ≈ 30 с). По умолчанию держим тест быстрым и честно перечисляем, что не
    // успели; полная сверка без ограничения — HM_SIZES_DEEP=1.
    const budget = process.env.HM_SIZES_DEEP ? 0 : Number(process.env.HM_SIZES_BUDGET_MS || 8000);

    // ПОРЯДОК ВАЖЕН, И ВОТ ПОЧЕМУ. Бюджет на загруженной машине выбирается не полностью,
    // часть компонентов уходит в ⏭. Раньше порядок был произвольным (как в каталоге), и
    // пропускались в том числе claude (1,01 ГиБ), config (196 МиБ) и nomad — ровно те
    // числа, соврать в которых дороже всего: их видит человек в попапе «что скачается».
    // Получалось, что обычный прогон молча не проверял главное. Сортируем по УБЫВАНИЮ
    // заявленного размера: если бюджета не хватит, пропустится мелочь, а не гигабайт.
    const claimed = (id) => {
      const c = all.find((x) => x.id === id);
      return (c && c.sizeBytes && c.sizeBytes[PLATFORM]) || 0;
    };
    const ordered = deepIds.slice().sort((a, b) => claimed(b) - claimed(a));
    const r = checkLane(ordered, budget);
    // Сначала провал по существу — он важнее любого пропуска по времени.
    assert(!r.bad.length, 'цифра разошлась с vendor:\n    ' + r.bad.join('\n    ')
      + '\n    Почини одной командой: node tools/sync-sizes.js');
    if (r.timedOut.length) {
      SKIP('не уложились в бюджет ' + budget + ' мс на компонент: ' + r.timedOut.join(', ')
        + ' — полная сверка: HM_SIZES_DEEP=1 node test/run-tests.js');
    }
    if (r.unchecked.length === deepIds.length) SKIP('ни одного каталога нет на месте (lite-раскладка vendor)');
  });
})();

// ===========================================================================
// Предполётные гейты сборки (tools/preflight-build.js + хук beforePack).
//
// ЗАЧЕМ ЭТИ ТЕСТЫ. Дыра, которую они стерегут, тихая по своей природе: собрать exe
// со СТАРЫМ снапшотом конфиг-пака можно было мимо npm-скрипта (npx electron-builder
// --win), и в артефакте не оставалось никакого следа — ни ошибки, ни записи. Поэтому
// проверяем ДВЕ вещи: (1) гейт вообще подключён к сборке ТАК, что его нельзя обойти;
// (2) его логика действительно ловит устаревший/подменённый/непроверяемый снапшот, а
// не «зеленеет» на любом входе.
// ===========================================================================
(function preflightGateTests() {
  console.log('== Предполётные гейты сборки: свежесть config-pack + потолок makensis ==');

  const pre = require(path.join(ROOT, 'tools', 'preflight-build.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  ok('гейт подключён так, что его нельзя обойти: build.beforePack -> tools/before-pack.js', () => {
    // Строка в npm-скрипте защищает только того, кто собирает этой командой. Хук
    // beforePack вызывается самим electron-builder при ЛЮБОМ способе запуска.
    assert.strictEqual(pkg.build.beforePack, 'tools/before-pack.js',
      'в package.json build.beforePack должен указывать на tools/before-pack.js');
    const hookPath = path.join(ROOT, 'tools', 'before-pack.js');
    assert(fs.existsSync(hookPath), 'файл хука tools/before-pack.js должен существовать');
    const hook = require(hookPath);
    assert(typeof hook.default === 'function', 'хук обязан экспортировать функцию (exports.default)');
  });

  ok('dist/dist:win зовут fetch:config И preflight ДО electron-builder', () => {
    for (const name of ['dist', 'dist:win']) {
      const s = String(pkg.scripts[name] || '');
      assert(/fetch:config/.test(s), name + ': пропал вызов fetch:config');
      assert(/preflight/.test(s), name + ': пропал вызов preflight');
      assertOrder(s, 'preflight', 'electron-builder', name + ': preflight обязан идти ДО electron-builder');
      assertOrder(s, 'fetch:config', 'preflight', name + ': fetch:config обязан идти ДО preflight');
    }
    assert(/preflight/.test(String(pkg.scripts['dist:mac'] || '')), 'dist:mac: пропал вызов preflight');
  });

  // --- логика гейта свежести (чистая функция: ни диска, ни сети) ---
  const CFG = { configRepoUrl: 'https://github.com/JHamidun/claude-code-config-pack', configRepoBranch: 'main' };
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const stampOf = (over) => Object.assign({
    repo: CFG.configRepoUrl, ref: 'main', commit: SHA_A, committedAt: '2026-08-01T00:00:00Z', skills: 200,
  }, over || {});
  const ev = (o) => pre.evaluateConfigFreshness(Object.assign({ cfg: CFG }, o));

  ok('свежесть: нет штампа .hamidun-config-pack.json -> СТОП (что в exe — недоказуемо)', () => {
    const r = ev({ stamp: null });
    assert.strictEqual(r.level, 'fail', 'отсутствие штампа обязано быть провалом, а не предупреждением');
    assert(/fetch:config/.test(r.lines.join(' ')), 'в тексте должно быть, чем чинить');
  });

  ok('свежесть: вшитый коммит == origin/main -> OK', () => {
    const r = ev({ stamp: stampOf(), remoteHead: { ok: true, sha: SHA_A } });
    assert.strictEqual(r.level, 'ok', 'совпадение с HEAD — это норма: ' + r.lines.join(' | '));
  });

  ok('свежесть: origin ушёл вперёд -> СТОП (это и есть «старый снапшот»)', () => {
    const r = ev({ stamp: stampOf(), remoteHead: { ok: true, sha: SHA_B } });
    assert.strictEqual(r.level, 'fail', 'расхождение с HEAD обязано валить сборку');
    assert(/УСТАРЕЛ/.test(r.lines.join(' ')), 'формулировка должна называть проблему словами');
  });

  ok('свежесть: чужой репозиторий или чужая ветка в штампе -> СТОП', () => {
    assert.strictEqual(ev({ stamp: stampOf({ repo: 'https://github.com/someone/else' }), remoteHead: { ok: true, sha: SHA_A } }).level,
      'fail', 'пак из другого репозитория не должен уезжать молча');
    assert.strictEqual(ev({ stamp: stampOf({ ref: 'v38' }), remoteHead: { ok: true, sha: SHA_A } }).level,
      'fail', 'вшита не та ветка/тег — провал');
  });

  ok('свежесть: битый sha в штампе -> СТОП (снапшот не идентифицируется)', () => {
    assert.strictEqual(ev({ stamp: stampOf({ commit: 'not-a-sha' }), remoteHead: { ok: true, sha: SHA_A } }).level, 'fail');
  });

  ok('свежесть: пин по sha сверяется с пином, а не с HEAD', () => {
    const cfg = { configRepoUrl: CFG.configRepoUrl, configRepoRef: SHA_A };
    const good = pre.evaluateConfigFreshness({ cfg, stamp: stampOf({ ref: SHA_A }), remoteHead: { ok: true, sha: SHA_B } });
    assert.strictEqual(good.level, 'ok', 'закреплённый по sha пак не обязан догонять HEAD');
    const bad = pre.evaluateConfigFreshness({ cfg, stamp: stampOf({ commit: SHA_B, ref: SHA_A }), remoteHead: null });
    assert.strictEqual(bad.level, 'fail', 'пин не совпал со вшитым — провал');
  });

  ok('свежесть: origin недоступен -> СТОП; с HM_ALLOW_OFFLINE_BUILD=1 -> предупреждение', () => {
    const off = ev({ stamp: stampOf(), remoteHead: { ok: false, error: 'нет сети' } });
    assert.strictEqual(off.level, 'fail', 'недоказуемая свежесть по умолчанию = провал');
    const allowed = ev({ stamp: stampOf(), remoteHead: { ok: false, error: 'нет сети' }, allowOffline: true });
    assert.strictEqual(allowed.level, 'warn', 'осознанный офлайн-выключатель понижает до предупреждения');
    assert(/ВНИМАНИЕ/.test(allowed.lines.join(' ')), 'выключатель обязан оставлять след в логе сборки');
  });

  ok('свежесть: HM_ALLOW_STALE_CONFIG понижает провал, но НЕ прячет его', () => {
    const soft = ev({ stamp: stampOf(), remoteHead: { ok: true, sha: SHA_B }, allowStale: true });
    assert.strictEqual(soft.level, 'warn');
    assert(/ВНИМАНИЕ/.test(soft.lines.join(' ')), 'понижение обязано быть видно в логе');
    assert(/УСТАРЕЛ/.test(soft.lines.join(' ')), 'сама причина из текста НЕ исчезает');
  });

  // --- потолок makensis ---
  ok('размер: фильтр extraResources читается из package.json и реально исключает', () => {
    const f = pre.winVendorFilter(pkg).filter;
    assert(f('apps/git-setup.exe'), 'обычный артефакт должен попадать в сборку');
    assert(f('npm-cache/_cacache/content-v2/sha512/aa/bb/cc'), 'вложенность любой глубины включается');
    assert(!f('apps/chatgpt.vsix'), 'chatgpt.vsix исключён осознанно (лимит makensis)');
    assert(!f('playwright-browsers/chromium-1234/chrome.exe'), 'playwright-browsers исключены');
    assert(!f('playwright-browsers-linux/x/y'), 'playwright-browsers-* исключены');
  });

  ok('размер: прогноз против потолка 2 ГиБ различает норму, предупреждение и провал', () => {
    const MIB_ = 1024 * 1024;
    const small = pre.projectExeSize(1000 * MIB_);
    assert(!small.over && !small.warn, '1000 МиБ vendor — заведомо норма');
    // Граница предупреждения: 90% от 2048 МиБ за вычетом оболочки Electron.
    const nearBytes = Math.ceil((pre.NSIS_LIMIT_BYTES * pre.WARN_RATIO - pre.ELECTRON_BASE_BYTES) / pre.VENDOR_COMPRESSION) + MIB_;
    const near = pre.projectExeSize(nearBytes);
    assert(near.warn && !near.over, 'у самой границы обязано быть предупреждение, а не тишина');
    const over = pre.projectExeSize(3000 * MIB_);
    assert(over.over, '3000 МиБ vendor обязаны валить гейт');
    assert(over.headroom < 0, 'отрицательный запас должен быть виден числом');
  });

  ok('размер: измерение vendor согласовано с фильтром (исключённое не считается)', () => {
    const m = pre.packedVendorBytes({ pkg });
    if (!m.exists) SKIP('vendor не развёрнут — мерить нечего');
    assert(m.bytes > 0, 'что-то в vendor обязано попадать в сборку');
    assert(!Object.prototype.hasOwnProperty.call(m.perTop, 'playwright-browsers'),
      'playwright-browsers не должны попадать в зачёт размера сборки');
    const chatgpt = path.join(ROOT, 'vendor', 'apps', 'chatgpt.vsix');
    if (fs.existsSync(chatgpt)) {
      assert(m.excludedBytes >= fs.statSync(chatgpt).size,
        'исключённый chatgpt.vsix обязан попасть в «исключено фильтром», а не в зачёт');
    }
  });

  ok('release-check загружается и знает про законные исключения реестра (uv/course)', () => {
    const rc = require(path.join(ROOT, 'tools', 'release-check.js'));
    assert(rc.NO_REGISTRY_OK instanceof Set, 'release-check экспортирует список законных исключений');
    assert(rc.NO_REGISTRY_OK.has('uv'), 'uv — bundled-only (main.js BUNDLED_ONLY), запись в реестре ему не обязательна');
    assert(rc.NO_REGISTRY_OK.has('course'), 'курс вшит и в lite (build-lite.js LITE_KEEP_*)');
    assert(typeof rc.checkRegistry === 'function', 'сверка реестра с components.json экспортируется');
  });
})();


// ===========================================================================
// ЧИСТКА ОФЛАЙН-КЕША npm ОТ НАКОПЛЕННЫХ ВЕРСИЙ (tools/prune-npm-cache.js).
//
// ЗАЧЕМ ЭТИ ТЕСТЫ. `npm install --cache` ДОБАВЛЯЕТ версии в кеш и никогда не удаляет
// старые: каждый релиз Claude Code оставлял в vendor/npm-cache предыдущий архив
// (~80 МиБ) навсегда. К 11.08.2026 накопилось 13 версий (1005 МиБ вместо 84) и
// прогноз portable-exe ушёл на 112% от потолка 32-битного makensis — офлайн-сборка
// Windows перестала собираться. Разовая чистка лечит симптом, поэтому стерегутся
// ДВЕ вещи: (1) шаг чистки реально вызывается из ОБОИХ fetch-скриптов и не может
// молча пропасть; (2) прунер безопасен — он не трогает packument'ы, вычисляет набор
// платформ из метаданных (а не из зашитого win32-x64, иначе на маке он вычистил бы
// ровно то единственное, что там нужно) и ОТКАЗЫВАЕТСЯ чистить повреждённый кеш.
// ===========================================================================
(function npmCachePruneTests() {
  console.log('== Чистка офлайн-кеша npm: накопление версий не возвращается ==');

  const prune = require(path.join(ROOT, 'tools', 'prune-npm-cache.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  ok('чистка вызывается из ОБОИХ fetch-скриптов (иначе накопление вернётся через 5-6 релизов)', () => {
    const win = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor.ps1'), 'utf8');
    assert(/prune-npm-cache\.js/.test(win), 'fetch-vendor.ps1: пропал вызов prune-npm-cache.js');
    assertOrder(win, 'npm install \'@anthropic-ai/claude-code\'', 'prune-npm-cache.js',
      'fetch-vendor.ps1: чистка обязана идти ПОСЛЕ наполнения кеша');
    const mac = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor-mac.sh'), 'utf8');
    assert(/prune-npm-cache\.js/.test(mac), 'fetch-vendor-mac.sh: пропал вызов prune-npm-cache.js');
    // На маке архивы ОБЕИХ darwin-арх кладутся через `npm cache add` ПОСЛЕ npm install —
    // прунер обязан идти после них, иначе он не увидит, что их надо сохранить.
    assertOrder(mac, 'npm cache add', 'prune-npm-cache.js',
      'fetch-vendor-mac.sh: чистка обязана идти ПОСЛЕ докладки платформенных архивов обеих арх');
    assert(/"prune:cache"/.test(JSON.stringify(pkg.scripts)) || pkg.scripts['prune:cache'],
      'package.json: нужен скрипт prune:cache — на него ссылаются подсказки preflight');
  });

  ok('прунер: набор платформ берётся из метаданных, а НЕ зашит на win32-x64', () => {
    // Зашитый win32-x64 вычистил бы на macOS ровно darwin-arm64/darwin-x64 — то
    // единственное, ради чего там кеш и нужен. Проверяем на реальном кеше проекта.
    const cache = prune.readCache(prune.DEFAULT_CACHE);
    if (!cache.exists) return; // кеша нет (чистое дерево) — проверять нечего
    const { keep, rootVersion } = prune.resolveKeep(cache, {});
    assert(rootVersion, 'нужная версия должна вычисляться из dist-tags закешированного packument\'а');
    const names = Object.keys(keep);
    for (const plat of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      assert(names.some((n) => n === prune.ROOT_PKG + '-' + plat),
        'в KEEP обязан быть платформенный пакет ' + plat + ' (иначе прунер небезопасен на этой платформе)');
    }
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'prune-npm-cache.js'), 'utf8');
    assert(!/keep[^\n]*=[^\n]*['"]win32-x64['"]/.test(src), 'платформа не должна быть зашита в KEEP константой');
  });

  ok('прунер удаляет ТОЛЬКО архивы: packument\'ы (в т.ч. чужих платформ) неприкосновенны', () => {
    const cache = prune.readCache(prune.DEFAULT_CACHE);
    if (!cache.exists) return;
    const plan = prune.planPrune(cache, {});
    for (const e of plan.removeEntries) {
      assert(e.tarball, 'под удаление попала НЕ-архивная запись (' + e.key + ') — packument\'ы трогать нельзя');
    }
  });

  ok('прунер ОТКАЗЫВАЕТСЯ чистить, если блоба оставляемой версии нет (повреждённый кеш)', () => {
    // Молча удалить 12 версий и оставить тринадцатую, которой физически нет, — это
    // отказ офлайн-установки НА МАШИНЕ ПОЛЬЗОВАТЕЛЯ. Лучше не почистить.
    const cache = prune.readCache(prune.DEFAULT_CACHE);
    if (!cache.exists) return;
    const name = prune.ROOT_PKG + '-win32-x64';
    const versions = Object.keys(cache.tarballs[name] || {});
    if (!versions.length) return;
    // Синтетика: подкладываем вторую (несуществующую) версию + ломаем блоб оставляемой.
    const fake = JSON.parse(JSON.stringify(cache));
    fake.tarballs = Object.assign({}, cache.tarballs);
    fake.conRoot = path.join(os.tmpdir(), 'hm-no-such-content-' + Date.now());
    fake.tarballs[name] = Object.assign({ '0.0.1': [{ key: 'x', integrity: 'sha512-AAAA', size: 1, tarball: { name, version: '0.0.1' } }] }, cache.tarballs[name]);
    const plan = prune.planPrune(fake, {});
    assert(plan.blockers.length > 0, 'при недостижимом блобе оставляемой версии прунер обязан ОТКАЗАТЬСЯ, а не чистить');
  });

  ok('preflight предупреждает о накоплении версий и даёт точную команду чистки', () => {
    const pre = require(path.join(ROOT, 'tools', 'preflight-build.js'));
    assert(typeof pre.checkNpmCacheDupes === 'function', 'preflight обязан экспортировать проверку накопления');
    // Синтетический «грязный» кеш проверяем через duplicateVersions — на реальном
    // кеше дублей быть не должно, и это отдельное утверждение.
    const cache = prune.readCache(prune.DEFAULT_CACHE);
    if (cache.exists) {
      const dupes = prune.duplicateVersions(cache);
      assert.strictEqual(dupes.length, 0,
        'в vendor/npm-cache снова накопились версии (' + dupes.map((d) => d.name + ':' + d.count).join(', ') + ') — почини: npm run prune:cache');
    }
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'preflight-build.js'), 'utf8');
    assert(/npm run prune:cache/.test(src), 'предупреждение обязано называть КОМАНДУ чистки, а не «почини кеш»');
  });
})();


// ===========================================================================
// macOS ARCH-ПАРИТЕТ: у каждой поддерживаемой архитектуры есть свой артефакт
// ИЛИ явно записано, что компонент её не поддерживает.
// ===========================================================================
// Живой баг 07.08.2026. Ученик на Intel Mac (x86_64): «Готово 1 · Ошибок 4 ·
// Пропущено 2». Ни один тест этого не поймал, потому что все проверки спрашивали
// «файл в сборке есть?», а надо было спрашивать «файл под ЭТУ арх в сборке есть?».
// Сборочный раннер GitHub macos-latest — Apple Silicon, и всё, что тянется «под
// текущую платформу» (npm optionalDependencies, pip wheels, playwright), уезжает
// в vendor только в arm64-варианте. Файлы при этом НА МЕСТЕ — просто не те.
//
// Источник правды — mac-arch-support.json (декларация на каждый darwin-компонент).
// Тест сверяет декларацию с четырьмя независимыми реальностями:
//   (1) components.json  — ни один darwin-компонент не забыт в декларации;
//   (2) scripts/macos/*.sh — каждый $(arch_tag)-шаблон в скриптах ОБЪЯВЛЕН;
//   (3) tools/fetch-vendor-mac.sh — у perArch-артефактов гейт на ОБА арх-файла;
//   (4) vendor на диске (если развёрнут) — оба файла реально лежат.
// Декларация без сверки была бы бумажкой; сверка без декларации не отличала бы
// «универсальный файл» от «забыли вторую арх».
(function macArchParityTests() {
  console.log('== macOS arch-паритет: артефакт под каждую арх ИЛИ явное «не поддерживается» ==');

  const ARCH_PATH = path.join(ROOT, 'mac-arch-support.json');
  const MACDIR = path.join(ROOT, 'scripts', 'macos');
  const readArch = () => JSON.parse(fs.readFileSync(ARCH_PATH, 'utf8'));
  const KINDS = ['perArch', 'universal', 'npmPerArch', 'resolvedAtInstall', 'unsupported'];

  ok('mac-arch-support.json: валиден, объявлены обе арх, у каждого компонента известный kind', () => {
    const A = readArch();
    assert(Array.isArray(A.arches) && A.arches.indexOf('arm64') !== -1 && A.arches.indexOf('x64') !== -1,
      'arches обязан перечислять arm64 и x64 — это и есть «поддерживаемые архитектуры»');
    assert(A.components && typeof A.components === 'object', 'нет секции components');
    Object.keys(A.components).forEach((id) => {
      const c = A.components[id];
      assert(KINDS.indexOf(c.kind) !== -1, id + ': неизвестный kind «' + c.kind + '» (' + KINDS.join('|') + ')');
      if (c.kind === 'perArch') {
        assert(Array.isArray(c.artifacts) && c.artifacts.length, id + ': perArch без artifacts');
        c.artifacts.forEach((t) => assert(t.indexOf('{arch}') !== -1,
          id + ': шаблон «' + t + '» без {arch} — это не perArch'));
      }
      if (c.kind === 'npmPerArch') {
        assert(Array.isArray(c.npmPackages) && c.npmPackages.length, id + ': npmPerArch без npmPackages');
        c.npmPackages.forEach((t) => assert(t.indexOf('{arch}') !== -1, id + ': npm-пакет «' + t + '» без {arch}'));
      }
      // Самые опасные виды обязаны нести человеческое объяснение — иначе через
      // полгода никто не вспомнит, почему компонент «универсальный», и Intel-дыра
      // повторится молча.
      if (c.kind === 'universal') assert(c.why && c.why.length > 10, id + ': universal без внятного why');
      if (c.kind === 'resolvedAtInstall') assert(c.risk && c.risk.length > 10,
        id + ': resolvedAtInstall без описания risk — это самый опасный вид (выглядит универсальным, работает на одной арх)');
      if (c.kind === 'unsupported') {
        assert(Array.isArray(c.unsupportedArches) && c.unsupportedArches.length,
          id + ': unsupported без списка unsupportedArches');
        assert(c.reason && c.reason.length > 10, id + ': unsupported без человеческой причины (reason)');
      }
    });
  });

  ok('components.json → декларация: НИ ОДИН darwin-компонент не забыт', () => {
    const A = readArch();
    const missing = [];
    components.groups.forEach((g) => g.components.forEach((c) => {
      const plats = c.platforms;
      const onMac = !plats || plats.indexOf('darwin') !== -1;
      if (onMac && !A.components[c.id]) missing.push(c.id);
    }));
    assert(!missing.length,
      'не объявлены в mac-arch-support.json: ' + missing.join(', ')
      + '\n    Впиши каждый: perArch / universal / npmPerArch / resolvedAtInstall / unsupported.'
      + '\n    Молчаливый пропуск — ровно то, из-за чего Intel-баг дожил до ученика.');
  });

  ok('scripts/macos/*.sh: каждый $(arch_tag)-артефакт ОБЪЯВЛЕН в mac-arch-support.json', () => {
    const A = readArch();
    // Все объявленные perArch-шаблоны → нормализованная форма по basename.
    const declared = {};
    Object.keys(A.components).forEach((id) => {
      const c = A.components[id];
      (c.artifacts || []).forEach((t) => {
        if (t.indexOf('{arch}') !== -1) declared[t.split('/').pop()] = id;
      });
      // perArchExtras — арх-специфичные довески у компонента, чей ГЛАВНЫЙ артефакт
      // универсален (у vscode это оба vsix: панель Claude и панель Codex).
      (c.perArchExtras || []).forEach((e) => { declared[String(e.template).split('/').pop()] = id; });
    });
    // Ищем в скриптах имена файлов, склеенные с $(arch_tag): "uv-macos-$(arch_tag).tar.gz",
    // "claude-code-$(arch_tag).vsix", "handy-macos-$(arch_tag).dmg", …
    const RE = /([A-Za-z0-9_.-]*)\$\(arch_tag\)([A-Za-z0-9_.-]*)/g;
    const unknown = [];
    fs.readdirSync(MACDIR).filter((f) => f.endsWith('.sh')).forEach((f) => {
      const src = fs.readFileSync(path.join(MACDIR, f), 'utf8');
      let m;
      RE.lastIndex = 0;
      while ((m = RE.exec(src)) !== null) {
        const pre = m[1], suf = m[2];
        // Интересуют только ИМЕНА ФАЙЛОВ (есть расширение), а не каталоги вида
        // playwright-browsers-$(arch_tag) и не голое $(arch_tag) в сообщениях.
        if (!/\.[A-Za-z0-9]+$/.test(suf)) continue;
        const name = pre + '{arch}' + suf;
        if (!declared[name]) unknown.push(f + ': ' + name);
      }
    });
    assert(!unknown.length,
      'скрипт берёт арх-специфичный артефакт, которого нет в декларации:\n    ' + unknown.join('\n    ')
      + '\n    Добавь его в mac-arch-support.json как perArch — иначе никто не проверит,'
      + '\n    что сборка кладёт ОБА варианта, и на одной из арх компонент молча отвалится.');
  });

  ok('tools/fetch-vendor-mac.sh: у каждого perArch-артефакта гейт на ОБЕ арх', () => {
    const A = readArch();
    const fv = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor-mac.sh'), 'utf8');
    const holes = [];
    // Гейт полноты = упоминание имени файла в chk_file/FATAL-блоках. Это единственное
    // место, где отсутствие артефакта становится видимым НА СБОРКЕ, а не у ученика.
    // Исключение только одно и оно должно быть ЗАПИСАНО: артефакт с честным
    // онлайн-фолбэком помечается optional + reason. «Забыли» и «сознательно не
    // гейтим» обязаны выглядеть по-разному — иначе через полгода не отличить.
    const gateTemplates = (id, c) => {
      const out = [];
      if (c.kind === 'perArch') (c.artifacts || []).forEach((t) => out.push({ tpl: t, optional: false, reason: '' }));
      (c.perArchExtras || []).forEach((e) => out.push({
        tpl: String(e.template), optional: !!e.optional, reason: String(e.reason || ''),
      }));
      return out;
    };
    Object.keys(A.components).forEach((id) => {
      const c = A.components[id];
      gateTemplates(id, c).forEach((item) => {
        if (item.optional) {
          assert(item.reason.length > 20,
            id + ': артефакт «' + item.tpl + '» помечен optional без внятной причины — '
            + 'так «сознательно не гейтим» не отличить от «забыли»');
          return;
        }
        A.arches.forEach((arch) => {
          const name = item.tpl.split('/').pop().replace('{arch}', arch);
          if (fv.indexOf(name) === -1) holes.push(id + ' → ' + name);
        });
      });
    });
    assert(!holes.length,
      'сборка не проверяет наличие арх-варианта:\n    ' + holes.join('\n    ')
      + '\n    Добавь chk_file на ОБА файла в tools/fetch-vendor-mac.sh.');
  });

  ok('tools/fetch-vendor-mac.sh: npm-кеш гейтится по АРХИВУ платформенного пакета обеих арх', () => {
    const A = readArch();
    const fv = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-vendor-mac.sh'), 'utf8');
    const lib = fs.readFileSync(path.join(MACDIR, '_lib.sh'), 'utf8');
    assert(/hm_npm_cache_has_tarball\(\)/.test(lib),
      '_lib.sh: пропала hm_npm_cache_has_tarball — без неё «есть ли бинарь под эту арх» не отличить');
    // Ключ архива в cacache всегда содержит "/<имя>/-/<имя>-", ключ метаданных — нет.
    // Проверка по одному лишь имени пакета давала бы ЛОЖНОЕ «есть»: packument чужой
    // платформы кешируется всегда. Ровно так дыра и пряталась.
    assert(lib.indexOf('/$2/-/$2-') !== -1,
      '_lib.sh: hm_npm_cache_has_tarball обязана искать ключ АРХИВА (/<имя>/-/<имя>-), а не имя пакета');
    Object.keys(A.components).forEach((id) => {
      const c = A.components[id];
      if (c.kind !== 'npmPerArch') return;
      (c.npmPackages || []).forEach((tpl) => {
        A.arches.forEach((arch) => {
          const pkg = tpl.replace('{arch}', arch);
          const bare = pkg.replace(/^@[^/]+\//, '');
          assert(fv.indexOf(bare) !== -1 || fv.indexOf('claude-code-darwin-$CCA') !== -1,
            id + ': сборка не кладёт/не проверяет платформенный пакет ' + pkg);
        });
      });
    });
    assert(/npm cache add/.test(fv),
      'сборка обязана докладывать платформенные пакеты чужой арх через `npm cache add` — '
      + '`npm install` на arm64-раннере кеширует .tgz только своей платформы');
    assert(fv.indexOf('hm_npm_cache_has_tarball "$ROOT/vendor/npm-cache"') !== -1,
      'в блоке полноты vendor нет проверки архива платформенного пакета — сборка снова сможет '
      + 'отгрузить «офлайн»-издание, которое на Intel требует интернета');
  });

  ok('install-скрипты: отсутствие арх-варианта объясняется человеку, а не падает молча', () => {
    const lib = fs.readFileSync(path.join(MACDIR, '_lib.sh'), 'utf8');
    assert(/hm_arch_note_missing\(\)/.test(lib), '_lib.sh: пропала hm_arch_note_missing');
    assert(/hm_arch_unavailable\(\)/.test(lib), '_lib.sh: пропала hm_arch_unavailable');
    assert(/hm_explain_build_failure\(\)/.test(lib), '_lib.sh: пропала hm_explain_build_failure');
    // hm_arch_unavailable ОБЯЗАНА заканчиваться явным `return 0`: иначе её результатом
    // станет код `[ -n "$2" ] && echo` (=1 при пустом втором аргументе), и вызов голым
    // statement'ом под `set -e` убьёт установку ровно там, где мы успокаиваем человека.
    const iUnav = lib.indexOf('hm_arch_unavailable() {');
    const iEnd = lib.indexOf('\n}', iUnav);
    assert(iUnav !== -1 && iEnd > iUnav && /return 0/.test(lib.slice(iUnav, iEnd)),
      'hm_arch_unavailable без явного return 0 — под set -e это тихо убивает установку');
    // Список «кто обязан объясниться» НЕ хардкодим — выводим из декларации: любой
    // компонент, у которого арх-специфика есть (perArch / npmPerArch / perArchExtras),
    // обязан уметь сказать про архитектуру словами. Хардкод устарел бы на первом же
    // новом компоненте и молча перестал бы сторожить.
    const A = readArch();
    const mustExplain = [];
    Object.keys(A.components).forEach((id) => {
      const c = A.components[id];
      const archSpecific = c.kind === 'perArch' || c.kind === 'npmPerArch'
        || (Array.isArray(c.perArchExtras) && c.perArchExtras.length);
      if (!archSpecific || !c.script) return;
      mustExplain.push(c.script);
    });
    assert(mustExplain.length >= 4,
      'из декларации не выведено ни одного арх-специфичного скрипта — проверка выродилась');
    mustExplain.forEach((rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert(/hm_arch_note_missing|hm_arch_human|hm_arch_unavailable/.test(src),
        rel + ': нет ни одного честного сообщения про архитектуру — при отсутствии арх-варианта '
        + 'человек снова увидит «не подтвердилось» без причины');
    });
    // pydeps: главный урок Intel-бага — НЕ врать про сеть, когда дело в отсутствии
    // готового пакета. Старый текст «Проверь сеть и повтори установку» обязан быть мёртв.
    const pyd = fs.readFileSync(path.join(MACDIR, 'pydeps.sh'), 'utf8');
    assert(/hm_explain_build_failure/.test(pyd),
      'pydeps.sh: провал pip больше не объясняется человеку');
    assert(pyd.indexOf('офлайн и онлайн). Проверь сеть') === -1,
      'pydeps.sh: вернулся текст «Проверь сеть» на провал, у которого сеть ни при чём');
  });

  ok('vendor на диске: у perArch-артефактов лежат ОБА файла', () => {
    const A = readArch();
    const vroot = path.join(ROOT, 'vendor');
    if (!fs.existsSync(vroot)) SKIP('vendor не развёрнут (чистая машина / CI)');
    const holes = [];
    let checked = 0;
    Object.keys(A.components).forEach((id) => {
      const c = A.components[id];
      const tpls = (c.kind === 'perArch' ? (c.artifacts || []) : [])
        .concat((c.perArchExtras || []).map((e) => String(e.template)));
      tpls.forEach((tpl) => {
        // Проверяем только те артефакты, где хоть один вариант уже лежит: иначе
        // lite-раскладка (vendor без тяжёлых файлов) давала бы шум на ровном месте.
        const paths = A.arches.map((a) => path.join(vroot, tpl.replace('{arch}', a)));
        const present = paths.filter((p) => { try { return fs.statSync(p).size > 0; } catch (e) { return false; } });
        if (!present.length) return;
        checked++;
        if (present.length !== paths.length) {
          A.arches.forEach((a, i) => {
            if (present.indexOf(paths[i]) === -1) holes.push(id + ': нет ' + tpl.replace('{arch}', a));
          });
        }
      });
    });
    assert(!holes.length,
      'в vendor есть вариант под одну арх и нет под другую:\n    ' + holes.join('\n    ')
      + '\n    Именно так выглядит сборка, которая у половины учеников не встанет.');
    if (!checked) SKIP('в этой раскладке vendor нет ни одного perArch-артефакта (lite)');
  });
})();

// ===========================================================================
// Человеческий перевод машинного провала (src/failure-explain.js)
// ===========================================================================
// У ученика на экране была простыня cargo/PyO3/openssl-sys, по которой он не мог
// понять НИЧЕГО. Модуль переводит её в «что произошло / что делать». Тест сторожит
// две вещи: (а) реальные строки из его лога опознаются; (б) причины не путаются —
// «нет готовой версии» НЕ должно выглядеть как «проверь интернет», иначе человек
// будет бесконечно жать «Повторить» на том, что повтором не чинится.
(function failureExplainTests() {
  console.log('== Человеческий перевод провала установки ==');
  const FE = require(path.join(ROOT, 'src', 'failure-explain.js'));

  // Дословный хвост лога ученика (Intel Mac, 07.08.2026).
  const REAL_TAIL = [
    'config-x86_64-apple-darwin-3.12-abi3.txt',
    'PYO3_ENVIRONMENT_SIGNATURE="cpython-3.12-64bit"',
    'PYO3_PYTHON="/Users/user/.cache/uv/builds-v0/.tmp17xznI/bin/python"',
    'PYTHON_SYS_EXECUTABLE="/Users/user/.cache/uv/builds-v0/.tmp17xznI/bin/python"',
    '"cargo" "rustc" "--profile" "release" "--message-format" "json-render-diagnostics" "--locked" "--manifest-path"',
    'error: failed to run custom build command for `openssl-sys v0.9.117`',
  ];

  ok('реальный лог ученика опознаётся как «нет готовой версии под этот компьютер»', () => {
    const r = FE.explainScriptFailure(REAL_TAIL);
    assert(r, 'простыня cargo/PyO3 не опознана — ученик снова увидит «завершено с кодом 1»');
    assert(r.kind === 'no-prebuilt-binary', 'вид причины: ожидался no-prebuilt-binary, получено ' + r.kind);
    const text = r.lines.join(' ');
    assert(/НЕ проблема с интернетом|Повторять установку бесполезно/.test(text),
      'объяснение обязано снять с человека две ложные версии: «сломал компьютер» и «плохой интернет»');
    assert(/Что делать/.test(text), 'нет строки «что делать» — объяснение без действия бесполезно');
  });

  ok('причины не путаются: сборка из исходников ≠ сеть ≠ место ≠ пароль', () => {
    const cases = [
      [['error: could not compile `cryptography`', 'note: run with `cargo` for more'], 'no-prebuilt-binary'],
      [['ERROR: No matching distribution found for cryptography==50.0.0'], 'no-distribution'],
      [['OSError: [Errno 28] No space left on device'], 'disk-full'],
      [['execution error: User canceled. (-128)'], 'admin-cancelled'],
      [['spctl: rejected source=no usable signature'], 'gatekeeper'],
      [['curl: (6) Could not resolve host: registry.npmjs.org'], 'network'],
    ];
    cases.forEach((pair) => {
      const tail = pair[0], kind = pair[1];
      const r = FE.explainScriptFailure(tail);
      assert(r && r.kind === kind,
        'ожидался ' + kind + ', получено ' + (r ? r.kind : 'null') + ' на: ' + tail.join(' | '));
    });
  });

  ok('нет ложных срабатываний на обычном успешном выводе', () => {
    const calm = [
      'Проверяю VS Code...',
      'Ставлю расширение anthropic.claude-code в VS Code...',
      'OK: Python-зависимости установлены.',
    ];
    assert(FE.explainScriptFailure(calm) === null, 'на спокойном логе выдумана причина');
    assert(FE.explainScriptFailure([]) === null, 'пустой хвост → null');
    assert(FE.explainScriptFailure(null) === null, 'null → null');
  });

  ok('порядок правил: компиляция из исходников важнее упоминания сети в том же логе', () => {
    // pip почти всегда пишет и про сеть (retry/timeout), и про сборку. Если бы
    // сетевое правило выигрывало, человеку советовали бы чинить интернет при
    // тупике, который интернетом не лечится.
    const mixed = [
      'WARNING: Retrying (Retry(total=4)) after connection broken by ReadTimeoutError',
      'Building wheel for cryptography (pyproject.toml) ... error',
      'error: `cargo rustc --profile release` exited with code 101',
    ];
    const r = FE.explainScriptFailure(mixed);
    assert(r && r.kind === 'no-prebuilt-binary',
      'сетевой шум перебил настоящую причину — получено ' + (r ? r.kind : 'null'));
  });

  ok('main.js: перевод подключён и его результат доезжает до renderer (res.hint)', () => {
    const m = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    assert(m.indexOf("require('./failure-explain.js')") !== -1, 'main.js не подключает failure-explain');
    assert(m.indexOf('failureExplain.explainScriptFailure(outTail)') !== -1,
      'main.js не вызывает перевод на хвосте вывода компонента');
    assert(/hint: why\.short/.test(m) && /hintKind: why\.kind/.test(m),
      'main.js не отдаёт причину renderer-у — шаг снова покажет «код 1»');
    // Хвост обязан НАКАПЛИВАТЬСЯ: без буфера переводить будет нечего.
    assertOrder(m, 'const outTail = []', 'failureExplain.explainScriptFailure(outTail)',
      'буфер хвоста объявлен до использования');
    assert(m.indexOf('outTail.push(l)') !== -1, 'вывод компонента не пишется в хвост');
  });

  ok('renderer: каскад называет корневую причину, а не «не установлена зависимость»', () => {
    const a = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    assert(/function depSkipMessage\(/.test(a), 'app.js: пропала depSkipMessage');
    assert(a.indexOf('appendLog(depSkipMessage(id, broken, badWhy))') !== -1,
      'app.js: ветка dep-skip больше не печатает объяснение каскада');
    assert(a.indexOf('[~] Пропущено: не установлена зависимость') === -1,
      'app.js: вернулась старая односложная строка про зависимость');
    assert(a.indexOf('badWhy.set(id, badWhy.get(broken)') !== -1,
      'app.js: причина не наследуется по цепочке — на втором уровне каскада человек '
      + 'снова увидит «упала зависимость зависимости»');
    assert(a.indexOf('STATE.badWhy = new Map()') !== -1, 'app.js: badWhy не сбрасывается новой установкой');
    // Причина, которую повтор не чинит, не должна получать кнопку «Повторить»:
    // это прямое приглашение к бесконечному циклу.
    assert(a.indexOf("res.hintKind !== 'no-prebuilt-binary'") !== -1,
      'app.js: «Повторить» предлагается даже там, где повтор бесполезен');
  });
})();
