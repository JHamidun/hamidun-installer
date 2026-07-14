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

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '  -> ' + e.message); fail++; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '  -> ' + e.message); fail++; }
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
      assert(order.indexOf(r) < order.indexOf(id), `${r} must come before ${id}`);
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

ok('BUG #11: uv гейтнут win32-only (на darwin/linux в UI не предлагается → pickEntry не зовётся)', () => {
  const uv = byId['uv'];
  assert(uv && Array.isArray(uv.platforms) && uv.platforms.length === 1 && uv.platforms[0] === 'win32',
    'uv должен иметь platforms:["win32"]');
  const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
  assert(rf.pickEntry(remoteReg, 'uv', 'win32'), 'uv/win32 сборка есть в реестре');
  assert(!rf.pickEntry(remoteReg, 'uv', 'darwin'), 'uv/darwin сборки НЕТ (и не требуется — не показан)');
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

// (2) легитимные HM_* сохраняются (happy-path не теряет нужные переменные).
ok('#4 allowlist: HM_SELECTED и прочие HM_* сохраняются', () => {
  const out = installEnv.filterRendererEnv({
    HM_SELECTED: 'git,node,claude',
    HM_COURSE_TARGET: 'C:\\Users\\x\\HamidunCourse',
    HM_KEEP_SKILLS: 'a,b,c',
    HM_HOME: 'C:\\Users\\x'
  });
  assert(out.HM_SELECTED === 'git,node,claude', 'HM_SELECTED должен сохраниться');
  assert(out.HM_COURSE_TARGET && out.HM_KEEP_SKILLS && out.HM_HOME, 'все HM_* должны сохраниться');
  assert(Object.keys(out).length === 4, 'ровно 4 HM_* ключа: ' + JSON.stringify(out));
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

ok('Фаза 2 main.js: манифест справочный — запись при успехе (не hidden, не dry-run), удаление при uninstall, id авторитетно из main', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/if \(okRun && !isDryRun && !\(meta && meta\.hidden\)\)/.test(s), 'запись версии только при успехе, не dry-run, не hidden');
  assert(/manifest\.recordInstall\(os\.homedir\(\), id, ver, src\)/.test(s), 'recordInstall провязан в run-component');
  assert(/manifest\.removeEntry\(os\.homedir\(\), id\)/.test(s), 'removeEntry провязан в uninstall-component');
  assert(/function detectComponents/.test(s), 'детекция «установлен» — живая проверка ФС (detectComponents), не манифест');
  assert(/childEnv\.HM_UNINSTALL = id/.test(s), 'что удалять — задаёт main из валидированного id, не renderer');
  assert(/VALID_COMPONENT_IDS\.has\(id\)/.test(s), 'uninstall принимает только известные id');
});

console.log('== Фаза 2: аддитивная доустановка (merge-safe, НЕ затирает ~/.claude) ==');

// Аддитивная ветка в config.ps1: lastIndexOf, потому что первый `if ($ADDITIVE)` —
// это dry-run echo выше по файлу; конец — маркер «Чистая установка» (else-ветка).
function ps1AdditiveBranch() {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  const i = s.lastIndexOf('if ($ADDITIVE) {');
  const j = s.indexOf('Чистая установка', i);
  assert(i !== -1 && j > i, 'аддитивная ветка найдена');
  return { s, branch: s.slice(i, j) };
}

ok('config.ps1: additive-ветка копирует ТОЛЬКО недостающее (robocopy /XC /XN /XO), НЕ запускает install.ps1', () => {
  const { s, branch } = ps1AdditiveBranch();
  assert(/robocopy [^\r\n]*\/E \/XC \/XN \/XO/.test(branch), 'robocopy /E /XC /XN /XO — существующие файлы любой версии НЕ перезаписываются');
  assert(!/& \$installer/.test(branch), 'аддитивная ветка НЕ запускает install.ps1 (он кладёт свежую базу поверх)');
  assert(/\.credentials\.master\.env/.test(branch) && /settings\.local\.json/.test(branch) && /chats\.db/.test(branch),
    'ключи/локальные настройки/история в исключениях /XF');
  // P0-2: полный таймштамп-бэкап — ДО ветвления (первая операция над ~/.claude), fail-closed.
  const iBackup = s.indexOf('$claudeHome.backup.$stamp');
  const iBranch = s.lastIndexOf('if ($ADDITIVE) {');
  assert(iBackup !== -1 && iBackup < iBranch, 'полный бэкап идёт ДО additive/clean-ветвления (первая операция)');
  const backupBlock = s.slice(iBackup, iBranch);
  assert(/exit 1/.test(backupBlock) && /ОТМЕНЕНА/.test(backupBlock), 'неполный бэкап → fail-closed exit 1 (ничего не менял)');
});

// P0-2: в additive-режиме НИКАКОГО hamidun-preserve (ни snapshot, ни restore) —
// стейл-снапшот прошлого прогона не может залить старые KEY=OLD поверх живых KEY=NEW.
ok('P0-2 config.ps1: additive БЕЗ Snapshot/Restore; restore только в clean; stale → только недостающие', () => {
  const { s, branch } = ps1AdditiveBranch();
  assert(!/Snapshot-UserData/.test(branch), 'в additive-ветке НЕТ Snapshot-UserData');
  assert(!/Restore-UserData/.test(branch), 'в additive-ветке НЕТ Restore-UserData');
  assert(!/preserveDir/.test(branch), 'в additive-ветке НЕТ обращений к preserve-каталогу');
  assert(/if \(-not \$ADDITIVE\) \{[\s\S]*?Restore-UserData \$preserveDir/.test(s),
    'финальный restore выполняется ТОЛЬКО в clean-режиме');
  assert(/Restore-UserDataMissingOnly \$preserveDir/.test(s),
    'stale-снапшот прерванного прогона возвращает ТОЛЬКО недостающие файлы (не поверх живых)');
  assert(/\.hamidun-setup\\preserve/.test(s), 'снапшот clean-режима живёт в ~/.hamidun-setup (не в общем TEMP)');
  assert(!/Join-Path \$env:TEMP 'hamidun-preserve'[\s\S]*Restore-UserData \$legacyPreserve/.test(s),
    'легаси-снапшот из TEMP НЕ восстанавливается автоматически');
});

// P0-3: прунинг паков fail-closed — сбой перечисления/копирования отключает прунинг целиком.
ok('P0-3 config.ps1: сбой перечисления скиллов/robocopy → $pruneDisabled → прунинг пропущен', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  assert(/\$pruneDisabled = \$false/.test(s), 'есть флаг pruneDisabled');
  assert(/catch\s*\{[\s\S]{0,200}\$pruneDisabled = \$true/.test(s), 'сбой перечисления (catch) → pruneDisabled');
  assert(/ReparsePoint/.test(s.slice(s.lastIndexOf('if ($ADDITIVE) {'))), 'skills-reparse (junction) → перечисление отвергается');
  assert(/if \(\$ADDITIVE -and \(\$pruneDisabled -or \$installFailed\)\)/.test(s),
    'прунинг пропускается при pruneDisabled ИЛИ installFailed');
  assert(/Прунинг паков пропущен \(fail-closed\)/.test(s), 'явное сообщение о fail-closed пропуске');
  assert(/-ErrorAction Stop \| ForEach-Object \{ \$preExisting/.test(s),
    'перечисление pre-existing скиллов идёт с -ErrorAction Stop (не SilentlyContinue)');
});

ok('config.ps1: settings.json/CLAUDE.md/credentials добавляются ТОЛЬКО если отсутствуют', () => {
  const { branch } = ps1AdditiveBranch();
  assert(/settings\.json НИКОГДА не перезаписываем/.test(branch), 'политика settings.json зафиксирована');
  assert(/-not \(Test-Path \$profileClaudeMd\)/.test(branch), 'CLAUDE.md — только при отсутствии');
  assert(/-not \(Test-Path \$dstEnv\)/.test(branch), 'credentials-шаблон — только при отсутствии ключей');
});

ok('config.ps1: прунинг паков в additive НЕ трогает скиллы, бывшие у юзера ДО раскладки ($preExisting)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  assert(/\$weAdded = \(-not \$ADDITIVE\) -or \(-not \$preExisting\.ContainsKey\(\$_\.Name\)\)/.test(s),
    'guard $weAdded: additive + был до раскладки → не удаляем');
  assert(/-and \$weAdded\)/.test(s.replace(/\s+/g, ' ')), 'guard участвует в условии удаления');
  assert(/\$preExisting\[\$_\.Name\] = \$true/.test(s), 'список ранее бывших скиллов собирается ДО robocopy');
});

// Аддитивная ветка config.sh: от маркера до top-level `else` (clean-ветка) на колонке 0.
function shAdditiveBranch() {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  const i = s.indexOf('# === АДДИТИВНАЯ доустановка');
  const j = s.indexOf('\nelse\n', i);
  assert(i !== -1 && j > i, 'аддитивная ветка найдена');
  return { s, branch: s.slice(i, j) };
}

ok('config.sh: additive rsync --ignore-existing (fallback hm_copy_missing), user-данные в excludes, прунинг щадит PRE_EXISTING', () => {
  const { s, branch } = shAdditiveBranch();
  assert(/--ignore-existing/.test(branch), 'rsync --ignore-existing — существующее НЕ перезаписывается');
  assert(/hm_copy_missing "\$SRC_CLAUDE" "\$CLAUDE_HOME"/.test(branch), 'fallback без rsync: hm_copy_missing (только недостающее, честные коды)');
  assert(!/install\.sh/.test(branch), 'аддитивная ветка НЕ запускает install.sh');
  ['.credentials.master.env', '.credentials.json', 'settings.local.json', 'memory/', 'projects/', 'todos/', 'shell-snapshots/']
    .forEach((x) => assert(branch.indexOf("--exclude='" + x + "'") !== -1, 'exclude ' + x));
  assert(/grep -qxF "\$name" "\$PRE_EXISTING_SKILLS"/.test(s), 'прунинг сверяется со списком ранее бывших скиллов');
  assert(/\[ ! -f "\$HOME\/CLAUDE\.md" \]/.test(branch), 'CLAUDE.md — только при отсутствии');
});

// P0-2: additive БЕЗ hamidun-preserve; полный бэкап первым; restore только в clean.
ok('P0-2 config.sh: additive БЕЗ snapshot/restore; бэкап ДО ветвления; stale → только недостающие', () => {
  const { s, branch } = shAdditiveBranch();
  assert(!/snapshot_user_data/.test(branch), 'в additive-ветке НЕТ snapshot_user_data');
  assert(!/restore_user_data\b/.test(branch), 'в additive-ветке НЕТ restore_user_data');
  assert(!/PRESERVE_DIR/.test(branch), 'в additive-ветке НЕТ обращений к preserve-каталогу');
  const iBackup = s.indexOf('BACKUP_DIR="$CLAUDE_HOME.backup.$STAMP"');
  assert(iBackup !== -1 && iBackup < s.indexOf('# === АДДИТИВНАЯ доустановка'), 'полный бэкап идёт ДО additive/clean-ветвления');
  assert(/if \[ "\$ADDITIVE" -ne 1 \]; then\s*\n\s*restore_user_data "\$PRESERVE_DIR"/.test(s),
    'финальный restore выполняется ТОЛЬКО в clean-режиме');
  assert(/restore_user_data_missing_only "\$PRESERVE_DIR"/.test(s),
    'stale-снапшот прерванного прогона возвращает ТОЛЬКО недостающие файлы');
  assert(/PRESERVE_DIR="\$HOME\/\.hamidun-setup\/preserve"/.test(s),
    'снапшот clean-режима живёт в $HOME/.hamidun-setup (не в world-writable /tmp)');
  assert(!/restore_user_data[^\n]*LEGACY_PRESERVE/.test(s), 'легаси /tmp-снапшот НЕ восстанавливается автоматически');
});

// P1-6: коды возврата rsync/копирования ловятся (никаких `|| true`), при сбое —
// RC=1, прунинг пропущен, выход ненулевой.
ok('P1-6 config.sh: rsync/копирование без `|| true`, COPY_FAILED → RC=1 + прунинг пропущен', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  assert(/if ! rsync -a --ignore-existing/.test(s), 'rsync обёрнут в if ! (код возврата ловится)');
  assert(!/rsync[^\n]*\|\| true/.test(s), 'у rsync нет `|| true`');
  assert(!/cp -Rn "/.test(s), 'команда cp -Rn убрана (GNU ≥9.2 даёт ложный exit 1 на пропуске; заменена hm_copy_missing)');
  assert(/hm_copy_missing "\$SRC_CLAUDE" "\$CLAUDE_HOME" \|\| COPY_FAILED=1/.test(s), 'сбой hm_copy_missing → COPY_FAILED');
  assert(/COPY_FAILED" -eq 1[\s\S]{0,120}RC=1; PRUNE_DISABLED=1/.test(s), 'COPY_FAILED → RC=1 и прунинг выключен');
  const fn = s.slice(s.indexOf('hm_copy_missing()'), s.indexOf('RC=0'));
  assert(/cp -p "\$src\/\$rel" "\$dst\/\$rel" \|\| rc=1/.test(fn), 'per-file cp агрегирует ошибки');
  assert(/return \$rc/.test(fn), 'hm_copy_missing возвращает честный код');
});

// P0-3: PRE_EXISTING_SKILLS через mktemp (не предсказуемое имя), trap-чистка,
// симлинк/сбой перечисления → прунинг выключен; дефолт we_added=0 без списка.
ok('P0-3 config.sh: mktemp + trap + реджект симлинка + полный успех перечисления, иначе прунинг off', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  assert(/PRE_EXISTING_SKILLS="\$\(mktemp "\$\{TMPDIR:-\/tmp\}\/hm-preskills\.XXXXXX"/.test(s),
    'список pre-existing скиллов создаётся через mktemp');
  assert(!/hamidun-preexisting-skills\.txt/.test(s), 'фиксированное предсказуемое имя убрано');
  assert(/trap '\[ -n "\$PRE_EXISTING_SKILLS" \] && rm -f "\$PRE_EXISTING_SKILLS"' EXIT/.test(s), 'trap-чистка временного файла');
  assert(/-L "\$PRE_EXISTING_SKILLS"/.test(s), 'симлинк вместо temp-файла → отклоняется');
  assert(/elif ! find "\$CLAUDE_HOME\/skills" -mindepth 1 -maxdepth 1 -type d/.test(s),
    'перечисление обязано пройти ПОЛНОСТЬЮ успешно (find с проверкой кода)');
  assert(/we_added=0\s+# списка нет → считаем пред-существующим → не удаляем/.test(s),
    'без валидного списка дефолт we_added=0 (все скиллы пред-существующие)');
  assert(/PRUNE_DISABLED" -eq 1 \] \|\| \[ "\$RC" -ne 0 \]/.test(s), 'прунинг пропускается при PRUNE_DISABLED или RC!=0');
});

// ---- Функциональные прогоны config.sh на РЕАЛЬНОЙ ФС (bash) --------------
// Фейковый CLONE (bundled config) + фейковый HOME. Проверяем additive-инварианты.

function bashAvailable() {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  return !(probe.error || probe.status !== 0);
}

function mkFakeConfigHome() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cfg-')).replace(/\\/g, '/');
  const home = base + '/home';
  const clone = base + '/clone';
  // источник (bundled config-pack)
  fs.mkdirSync(clone + '/.claude/skills/our-skill', { recursive: true });
  fs.writeFileSync(clone + '/.claude/skills/our-skill/SKILL.md', 'ours');
  fs.mkdirSync(clone + '/.claude/rules', { recursive: true });
  fs.writeFileSync(clone + '/.claude/rules/new-rule.md', 'fresh rule');
  fs.writeFileSync(clone + '/.claude/settings.json', '{"fresh":"base"}');
  fs.writeFileSync(clone + '/install.sh', '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(clone + '/CLAUDE.md', 'fresh claude md');
  // живой дом с кастомизациями
  fs.mkdirSync(home + '/.claude/skills/user-skill', { recursive: true });
  fs.writeFileSync(home + '/.claude/skills/user-skill/SKILL.md', 'user skill');
  fs.writeFileSync(home + '/.claude/settings.json', '{"user":"custom"}');
  fs.writeFileSync(home + '/.claude/.credentials.master.env', 'KEY=NEW');
  return { base, home, clone };
}

function runConfigSh(home, clone, extraEnv) {
  const script = path.join(ROOT, 'scripts', 'macos', 'config.sh');
  return spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, {
      HOME: home, HM_BUNDLED_CONFIG: clone, HM_ADDITIVE: '1'
    }, extraEnv || {})
  });
}

if (bashAvailable()) {
  console.log('== P0-1/P0-2 config.sh (функционально): additive не затирает, бэкап первым, без restore ==');

  ok('P0-2 config.sh: additive добавляет недостающее, НЕ трогает живое, бэкап есть, stale preserve НЕ восстановлен', () => {
    const { base, home, clone } = mkFakeConfigHome();
    try {
      // отравленный stale-снапшот (KEY=OLD) в предсказуемом месте прошлой схемы и в новой
      fs.mkdirSync(home + '/.hamidun-setup/preserve', { recursive: true });
      fs.writeFileSync(home + '/.hamidun-setup/preserve/.credentials.master.env', 'KEY=OLD');
      const r = runConfigSh(home, clone);
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      // существующее НЕ перезаписано
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.json', 'utf8'), '{"user":"custom"}', 'settings.json юзера цел');
      assert.strictEqual(fs.readFileSync(home + '/.claude/.credentials.master.env', 'utf8'), 'KEY=NEW', 'ключи KEY=NEW НЕ перезаписаны KEY=OLD');
      assert(fs.existsSync(home + '/.claude/skills/user-skill/SKILL.md'), 'скилл юзера цел');
      // недостающее добавлено
      assert.strictEqual(fs.readFileSync(home + '/.claude/rules/new-rule.md', 'utf8'), 'fresh rule', 'новый файл доложен');
      assert(fs.existsSync(home + '/.claude/skills/our-skill/SKILL.md'), 'наш скилл доложен');
      // полный бэкап сделан ПЕРВОЙ операцией
      const backups = fs.readdirSync(home).filter((n) => n.startsWith('.claude.backup.'));
      assert(backups.length === 1, 'есть ровно один таймштамп-бэкап: ' + backups.join(','));
      assert.strictEqual(
        fs.readFileSync(home + '/' + backups[0] + '/settings.json', 'utf8'), '{"user":"custom"}',
        'бэкап содержит исходное состояние');
      // stale preserve не тронут и не «восстановлен»
      assert.strictEqual(fs.readFileSync(home + '/.hamidun-setup/preserve/.credentials.master.env', 'utf8'), 'KEY=OLD',
        'stale-снапшот лежит на месте (в additive его никто не читает и не льёт)');
      assert(!/восстанавлив/i.test(r.stdout || ''), 'никаких сообщений о restore в additive');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('P0-3 config.sh (функционально): прунинг удаляет ТОЛЬКО доложенное нами, щадит пред-существующее', () => {
    const { base, home, clone } = mkFakeConfigHome();
    try {
      // user-skill был ДО раскладки; our-skill доложим мы. Оба «в паках», ни один не выбран.
      const r = runConfigSh(home, clone, {
        HM_ALL_PACK_SKILLS: 'user-skill,our-skill',
        HM_KEEP_SKILLS: 'something-else'
      });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(fs.existsSync(home + '/.claude/skills/user-skill/SKILL.md'), 'пред-существующий скилл юзера ЦЕЛ');
      assert(!fs.existsSync(home + '/.claude/skills/our-skill'), 'доложенный нами скилл снятого пака удалён');
      assert(/убрано: 1/.test(r.stdout || ''), 'удалён ровно 1 (наш): ' + (r.stdout || ''));
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('P0-3 config.sh (функционально): TMPDIR недоступен → mktemp сбой → 0 удалений (fail-closed) + ненулевой выход', () => {
    const { base, home, clone } = mkFakeConfigHome();
    try {
      const r = runConfigSh(home, clone, {
        HM_ALL_PACK_SKILLS: 'user-skill,our-skill',
        HM_KEEP_SKILLS: 'something-else',
        TMPDIR: base + '/no-such-tmpdir'   // mktemp упадёт → PRUNE_DISABLED
      });
      // копирование тоже фейлится fail-closed (mktemp) → честный ненулевой выход
      assert(r.status !== 0, 'ожидается ненулевой выход (fail-closed): ' + (r.stdout || ''));
      assert(/Прунинг паков пропущен \(fail-closed\)|прунинг паков отключён/i.test(r.stdout || ''), 'сообщение о fail-closed: ' + (r.stdout || ''));
      assert(fs.existsSync(home + '/.claude/skills/user-skill/SKILL.md'), 'скилл юзера ЦЕЛ (0 удалений)');
      assert(!/убрано: [1-9]/.test(r.stdout || ''), 'ни одного удаления');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('P1-8 config.sh (функционально): dry-run БЕЗ bundled → никакого clone, ничего не создано, exit 0', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-dry-')).replace(/\\/g, '/');
    const home = base + '/home';
    fs.mkdirSync(home, { recursive: true });
    try {
      const script = path.join(ROOT, 'scripts', 'macos', 'config.sh');
      const r = spawnSync('bash', [script], {
        encoding: 'utf8', timeout: 30000,
        env: Object.assign({}, process.env, {
          HOME: home, HM_DRY_RUN: '1', HM_BUNDLED_CONFIG: '',
          HM_CONFIG_REPO_URL: 'https://127.0.0.1:1/nonexistent.git'
        })
      });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(!fs.existsSync(home + '/.hamidun-setup/config-repo'), 'clone-каталог НЕ создан (P1-8: dry-run до clone)');
      assert(!fs.existsSync(home + '/.claude'), '~/.claude НЕ создан');
      assert(/\[dry-run\] WOULD: git clone/.test(r.stdout || ''), 'dry-run печатает WOULD-clone');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
} else {
  console.log('  ⚠️  bash недоступен — функциональные прогоны config.sh пропущены.');
}

console.log('== Фаза 2: деинсталлятор (НЕ трогает пользовательские данные) ==');

ok('uninstall.ps1: защищённые поддеревья (credentials/memory/projects/todos/...) + guard ПЕРЕД удалением', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uninstall.ps1'), 'utf8');
  ['.credentials.master.env', '.credentials.json', 'memory', 'projects', 'todos', 'shell-snapshots', 'settings.json', 'skills']
    .forEach((p) => assert(s.indexOf("'" + p + "'") !== -1, 'в ProtectedSubtrees есть ' + p));
  const fn = s.slice(s.indexOf('function Remove-HmArtifact'), s.indexOf('$id ='));
  assert(/Test-HmProtected \$path/.test(fn), 'Remove-HmArtifact зовёт Test-HmProtected');
  assert(fn.indexOf('Test-HmProtected') < fn.indexOf('Remove-Item'), 'guard стоит ДО Remove-Item');
  assert(/-ieq \$userHome/.test(s), 'домашний каталог защищён целиком');
  assert(/\$full\.Length -le 3/.test(s), 'корень диска защищён');
  // Remove-Item по файловой системе — ТОЛЬКО внутри Remove-HmArtifact.
  const outside = s.replace(fn, '');
  assert(!/Remove-Item -LiteralPath/.test(outside), 'файловый Remove-Item только за guard-ом');
});

// P0-5 (source): канонизация РЕАЛЬНЫМ путём по хэндлу + реджект reparse в цепочке.
ok('P0-5 uninstall.ps1: GetFinalPathNameByHandle + Test-HmReparseChain + IsPathRooted + resolved-сверка', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uninstall.ps1'), 'utf8');
  assert(/GetFinalPathNameByHandleW/.test(s), 'резолв реального пути по ХЭНДЛУ (не только GetFullPath)');
  assert(/FILE_FLAG_BACKUP_SEMANTICS|0x02000000/.test(s), 'каталоги открываются с BACKUP_SEMANTICS');
  assert(/function Test-HmReparseChain/.test(s), 'есть проверка reparse по всей цепочке предков');
  assert(/if \(Test-HmReparseChain \$full\) \{ return \$true \}/.test(s), 'reparse в цепочке → отказ');
  assert(/IsPathRooted/.test(s), 'не-абсолютный путь → отказ');
  assert(/\$real = Get-HmRealPath \$full/.test(s), 'существующая цель канонизируется реальным путём');
  assert(/if \(-not \$real\) \{ return \$true \}/.test(s), 'сбой канонизации → отказ (fail-closed)');
  assert(/Test-HmInProtected \$real/.test(s), 'защищённый набор сверяется с РАЗРЕШЁННЫМ реальным путём');
  assert(/catch \{ return \$true \}/.test(s.slice(s.indexOf('function Test-HmReparseChain'), s.indexOf('$claudeHome ='))),
    'не смогли проверить цепочку → отказ');
});

// P0-4 (source): uninstall-скрипты работают ТОЛЬКО по квитанции, без масок/glob.
ok('P0-4 uninstall.ps1/sh: отказ без квитанции; удаление только точных путей; никаких glob', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uninstall.ps1'), 'utf8');
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'uninstall.sh'), 'utf8');
  assert(/нет квитанции установки[\s\S]{0,200}exit 3/.test(ps), 'ps1: без receipt-env → отказ exit 3');
  assert(/нет квитанции установки[\s\S]{0,200}exit 3/.test(sh), 'sh: без receipt-env → отказ exit 3');
  assert(/HM_UNINSTALL_PATHS/.test(ps) && /HM_UNINSTALL_PATHS/.test(sh), 'удаление идёт по HM_UNINSTALL_PATHS из квитанции');
  assert(!/\*\[Cc\]laude\*/.test(sh), 'sh: маска *[Cc]laude* убрана (никаких glob)');
  assert(!/for app in "\$HOME\/Applications"\/\*\.app/.test(sh), 'sh: перебор ~/Applications/*.app убран');
  assert(!/Join-Path \$env:LOCALAPPDATA 'Programs\\ClaudeMascot'/.test(ps), 'ps1: захардкоженные пути компонентов убраны (только квитанция)');
  assert(/CFBundleIdentifier/.test(sh), 'sh: .app удаляется только после сверки CFBundleIdentifier');
  assert(/HM_UNINSTALL_BUNDLEID/.test(sh), 'sh: идентичность бандла берётся из квитанции');
});

// P1-7 (source): агрегация сбоев + точный инвентарь не-файловых артефактов.
ok('P1-7 uninstall.ps1/sh: FAILED-агрегация, exit 1 при частичном; реестр/PATH/LaunchAgent/профиль/uv-tool', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uninstall.ps1'), 'utf8');
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'uninstall.sh'), 'utf8');
  assert(/ЧАСТИЧНО[\s\S]{0,80}exit 1/.test(ps), 'ps1: частичное удаление → exit 1');
  assert(/ЧАСТИЧНО[\s\S]{0,80}exit 1/.test(sh), 'sh: частичное удаление → exit 1');
  assert(/HM_UNINSTALL_REG/.test(ps), 'ps1: реестр по точным записям квитанции');
  assert(/'HKCU'/.test(ps) && /не-HKCU запись реестра/.test(ps), 'ps1: только HKCU, прочее отклоняется');
  assert(/HM_UNINSTALL_PATHENTRIES/.test(ps), 'ps1: PATH-запись uv убирается точным совпадением');
  assert(/HM_UNINSTALL_LAUNCHAGENTS/.test(sh) && /launchctl unload/.test(sh), 'sh: LaunchAgent unload + точный plist');
  assert(/HM_UNINSTALL_PROFILELINES/.test(sh) && /grep -vF "\$marker"/.test(sh), 'sh: строки профиля моста убираются по маркеру');
  assert(/tool uninstall nomad/.test(ps) && /tool uninstall nomad/.test(sh), 'nomad: uv tool uninstall в обоих');
});

ok('uninstall.sh: hm_protected гейт + защищённые поддеревья; rm -rf только внутри hm_remove', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'uninstall.sh'), 'utf8');
  ['$CLAUDE_HOME/skills', '$CLAUDE_HOME/memory', '$CLAUDE_HOME/projects', '$CLAUDE_HOME/todos',
    '$CLAUDE_HOME/.credentials.master.env', '$CLAUDE_HOME/settings.json']
    .forEach((p) => assert(s.indexOf(p) !== -1, 'в PROTECTED_SUBTREES есть ' + p));
  const fn = s.slice(s.indexOf('hm_remove()'), s.indexOf('ID='));
  assert(/hm_protected "\$path"/.test(fn), 'hm_remove зовёт hm_protected');
  assert.strictEqual((s.match(/rm -rf "\$path"/g) || []).length, 1, 'rm -rf по цели ровно один — внутри hm_remove');
  assert(/\[ "\$target" = "\$home" \] && return 0/.test(s), 'домашний каталог защищён');
  assert(/\[ "\$target" = "\/" \] && return 0/.test(s), 'корень ФС защищён');
  // P0-5: канонизация + реджекты
  assert(/hm_realpath\(\)/.test(s) && /Cwd=abs_path/.test(s), 'канонизация РЕАЛЬНЫМ путём (perl Cwd::abs_path)');
  assert(/hm_ancestor_symlink "\$target"; then return 0/.test(s), 'симлинк-предок → отказ');
  assert(/\[ -L "\$target" \] && return 0/.test(s), 'сама цель-симлинк → отказ');
  assert(/s#\/\/\*#\/#g/.test(s), 'двойные слэши схлопываются ДО сравнения');
  assert(/hm_in_protected "\$real"/.test(s), 'защищённый набор сверяется с разрешённым реальным путём');
});

// Хелпер: запустить uninstall.sh с env-инвентарём «как из квитанции» (envFromReceipt).
function runUninstallSh(home, id, receiptEnv) {
  const script = path.join(ROOT, 'scripts', 'macos', 'uninstall.sh');
  return spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, { HOME: home, HM_UNINSTALL: id }, receiptEnv || {})
  });
}

ok('uninstall.sh (функционально): точный путь из квитанции удалён, ~/.claude цел; цель внутри ~/.claude → ЗАЩИТА', () => {
  if (!bashAvailable()) { console.log('     (bash недоступен — пропуск функциональной части)'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-un-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(home + '/.claude/skills/my-custom-skill', { recursive: true });
    fs.writeFileSync(home + '/.claude/skills/my-custom-skill/SKILL.md', 'user skill');
    fs.writeFileSync(home + '/.claude/.credentials.master.env', 'KEY=secret');
    fs.mkdirSync(home + '/.claude/memory', { recursive: true });
    fs.writeFileSync(home + '/.claude/memory/MEMORY.md', 'memories');
    fs.mkdirSync(home + '/HamidunCourse/vibecoding-course', { recursive: true });
    fs.writeFileSync(home + '/HamidunCourse/vibecoding-course/CLAUDE.md', 'course');
    // Точный инвентарь «как из квитанции» (envFromReceipt).
    const r = runUninstallSh(home, 'course', { HM_UNINSTALL_PATHS: home + '/HamidunCourse/vibecoding-course' });
    assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
    assert(!fs.existsSync(home + '/HamidunCourse/vibecoding-course'), 'артефакт курса удалён');
    assert(fs.existsSync(home + '/.claude/.credentials.master.env'), 'credentials целы');
    assert(fs.existsSync(home + '/.claude/skills/my-custom-skill/SKILL.md'), 'пользовательский скилл цел');
    assert(fs.existsSync(home + '/.claude/memory/MEMORY.md'), 'память цела');
    // Квитанция «уводит» цель ВНУТРЬ ~/.claude → guard отказывает, exit ненулевой (частично).
    fs.mkdirSync(home + '/.claude/vibecoding-course', { recursive: true });
    fs.writeFileSync(home + '/.claude/vibecoding-course/x.md', 'inside claude');
    const r2 = runUninstallSh(home, 'course', { HM_UNINSTALL_PATHS: home + '/.claude/vibecoding-course' });
    assert(/ЗАЩИТА/.test(r2.stdout || ''), 'guard печатает ЗАЩИТА: ' + (r2.stdout || '') + (r2.stderr || ''));
    assert(r2.status !== 0, 'частичное/отклонённое удаление → ненулевой код (P1-7)');
    assert(fs.existsSync(home + '/.claude/vibecoding-course/x.md'), 'внутри ~/.claude ничего не удалено');
    // Не-канонический путь ("..") → fail-closed отказ (без резолва).
    const r3 = runUninstallSh(home, 'course', { HM_UNINSTALL_PATHS: home + '/HamidunCourse/../.claude' });
    assert(/ЗАЩИТА/.test(r3.stdout || ''), 'путь с .. → fail-closed ЗАЩИТА: ' + (r3.stdout || ''));
    assert(fs.existsSync(home + '/.claude/vibecoding-course/x.md'), 'обход через .. не удалил ничего');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P0-4 uninstall.sh (функционально): БЕЗ квитанции → отказ exit 3, ничего не удалено', () => {
  if (!bashAvailable()) { console.log('     (bash недоступен — пропуск)'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-unr-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(home + '/HamidunCourse/vibecoding-course', { recursive: true });
    fs.writeFileSync(home + '/HamidunCourse/vibecoding-course/CLAUDE.md', 'course');
    const r = runUninstallSh(home, 'course', {}); // никакого HM_UNINSTALL_PATHS
    assert.strictEqual(r.status, 3, 'exit 3 (отказ): ' + (r.stdout || ''));
    assert(/нет квитанции установки/.test(r.stdout || ''), 'сообщение об отказе');
    assert(fs.existsSync(home + '/HamidunCourse/vibecoding-course/CLAUDE.md'), 'артефакт НЕ тронут');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P0-4 uninstall.sh (функционально): mascot .app — без/с чужим CFBundleIdentifier → отказ, ничего не удалено', () => {
  if (!bashAvailable()) { console.log('     (bash недоступен — пропуск)'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-unm-')).replace(/\\/g, '/');
  try {
    const app = home + '/Applications/Claude Mascot.app';
    fs.mkdirSync(app + '/Contents/MacOS', { recursive: true });
    fs.writeFileSync(app + '/Contents/Info.plist', '<plist/>');
    // (а) в квитанции НЕТ bundleid → отказ удалять .app
    const r1 = runUninstallSh(home, 'mascot', { HM_UNINSTALL_PATHS: app });
    assert(/нет CFBundleIdentifier|ЗАЩИТА/.test(r1.stdout || ''), 'без bundleid → отказ: ' + (r1.stdout || ''));
    assert(r1.status !== 0, 'ненулевой код (частично)');
    assert(fs.existsSync(app + '/Contents/Info.plist'), '.app НЕ удалён');
    // (б) bundleid задан, но идентичность не подтверждается (PlistBuddy недоступен /
    // фейковый plist не читается) → тоже отказ (fail-closed), .app цел.
    const r2 = runUninstallSh(home, 'mascot', { HM_UNINSTALL_PATHS: app, HM_UNINSTALL_BUNDLEID: 'com.hamidun.claude-mascot' });
    assert(/не совпал с квитанцией|ЗАЩИТА/.test(r2.stdout || ''), 'неподтверждённая идентичность → отказ: ' + (r2.stdout || ''));
    assert(fs.existsSync(app + '/Contents/Info.plist'), '.app НЕ удалён (идентичность не доказана)');
    // Никакого перебора масок: соседний чужой Claude.app вообще не упоминается.
    const alien = home + '/Applications/Claude.app';
    fs.mkdirSync(alien, { recursive: true });
    const r3 = runUninstallSh(home, 'mascot', { HM_UNINSTALL_PATHS: app, HM_UNINSTALL_BUNDLEID: 'x' });
    assert(fs.existsSync(alien), 'чужой Claude.app цел (нет glob-перебора)');
    assert((r3.stdout || '').indexOf('Claude.app') === -1, 'чужой бандл даже не рассматривался');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P0-5 uninstall.sh (функционально): $HOME//.claude (двойной слэш) → ЗАЩИТА; symlink-предок → отказ', () => {
  if (!bashAvailable()) { console.log('     (bash недоступен — пропуск)'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-unp-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(home + '/.claude/memory', { recursive: true });
    fs.writeFileSync(home + '/.claude/memory/MEMORY.md', 'memories');
    // Двойной слэш НЕ должен обойти префикс-сравнение защищённого набора.
    const r = runUninstallSh(home, 'course', { HM_UNINSTALL_PATHS: home + '//.claude' });
    assert(/ЗАЩИТА/.test(r.stdout || ''), '$HOME//.claude → ЗАЩИТА: ' + (r.stdout || ''));
    assert(r.status !== 0, 'ненулевой код');
    assert(fs.existsSync(home + '/.claude/memory/MEMORY.md'), '~/.claude цел');
    // Предок-симлинк → отказ (если ФС/окружение умеет настоящие симлинки — иначе скип).
    fs.mkdirSync(home + '/realdir/payload', { recursive: true });
    fs.writeFileSync(home + '/realdir/payload/f.txt', 'x');
    let linked = false;
    try { fs.symlinkSync(home + '/realdir', home + '/linkdir', 'junction'); linked = true; } catch (e) { linked = false; }
    // bash обязан ВИДЕТЬ ссылку как симлинк (MSYS-junction может маппиться иначе) — иначе скип.
    if (linked) {
      const probe = spawnSync('bash', ['-c', '[ -L "$1" ] && echo yes || echo no', '-', home + '/linkdir'], { encoding: 'utf8' });
      linked = /yes/.test(probe.stdout || '');
    }
    if (linked) {
      const r2 = runUninstallSh(home, 'course', { HM_UNINSTALL_PATHS: home + '/linkdir/payload' });
      assert(/ЗАЩИТА/.test(r2.stdout || ''), 'symlink/junction-предок → ЗАЩИТА: ' + (r2.stdout || ''));
      assert(fs.existsSync(home + '/realdir/payload/f.txt'), 'цель за ссылкой НЕ удалена');
    } else {
      console.log('     (symlink недоступен в этой среде — ветка предка-симлинка пропущена)');
    }
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P1-7 uninstall.sh (функционально): смесь удаляемого и защищённого → удаляемое удалено, exit 1', () => {
  if (!bashAvailable()) { console.log('     (bash недоступен — пропуск)'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-unx-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(home + '/.claude', { recursive: true });
    fs.writeFileSync(home + '/.claude/settings.json', '{}');
    fs.mkdirSync(home + '/ok-artifact', { recursive: true });
    fs.writeFileSync(home + '/ok-artifact/a.txt', 'a');
    const r = runUninstallSh(home, 'bridge', {
      HM_UNINSTALL_PATHS: home + '/ok-artifact\n' + home + '/.claude/settings.json'
    });
    assert(!fs.existsSync(home + '/ok-artifact'), 'легитимный артефакт удалён');
    assert(fs.existsSync(home + '/.claude/settings.json'), 'защищённый settings.json цел');
    assert(r.status !== 0, 'частичное удаление → ненулевой код: ' + (r.stdout || ''));
    assert(/ЧАСТИЧНО/.test(r.stdout || ''), 'сообщение о частичном удалении');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

// Хелпер: запустить uninstall.ps1 (PS 5.1) с receipt-инвентарём через env.
function runUninstallPs(home, id, receiptEnv) {
  const script = path.join(ROOT, 'scripts', 'windows', 'uninstall.ps1');
  const inline = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; " +
    "& '" + script.replace(/'/g, "''") + "'; if ($null -eq $LASTEXITCODE) { exit 1 } else { exit $LASTEXITCODE }";
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inline], {
    encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, { USERPROFILE: home, HM_UNINSTALL: id }, receiptEnv || {})
  });
}

ok('uninstall.ps1 (функционально, win32): точный путь из квитанции удалён, ~/.claude цел; цель внутри ~/.claude → ЗАЩИТА', () => {
  if (process.platform !== 'win32') return; // Windows-специфично
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-unw-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'my-custom-skill'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'my-custom-skill', 'SKILL.md'), 'user skill');
    fs.writeFileSync(path.join(home, '.claude', '.credentials.master.env'), 'KEY=secret');
    fs.mkdirSync(path.join(home, '.claude', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'memory', 'MEMORY.md'), 'memories');
    fs.mkdirSync(path.join(home, 'HamidunCourse', 'vibecoding-course'), { recursive: true });
    fs.writeFileSync(path.join(home, 'HamidunCourse', 'vibecoding-course', 'CLAUDE.md'), 'course');
    const r = runUninstallPs(home, 'course', { HM_UNINSTALL_PATHS: path.join(home, 'HamidunCourse', 'vibecoding-course') });
    if (r.error) { console.log('     (powershell недоступен — пропуск функциональной части)'); return; }
    assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
    assert(!fs.existsSync(path.join(home, 'HamidunCourse', 'vibecoding-course')), 'артефакт курса удалён');
    assert(fs.existsSync(path.join(home, '.claude', '.credentials.master.env')), 'credentials целы');
    assert(fs.existsSync(path.join(home, '.claude', 'skills', 'my-custom-skill', 'SKILL.md')), 'пользовательский скилл цел');
    assert(fs.existsSync(path.join(home, '.claude', 'memory', 'MEMORY.md')), 'память цела');
    // Квитанция «уводит» цель ВНУТРЬ ~/.claude → guard отказывает, ничего не удалено, exit 1.
    fs.mkdirSync(path.join(home, '.claude', 'vibecoding-course'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'vibecoding-course', 'x.md'), 'inside claude');
    const r2 = runUninstallPs(home, 'course', { HM_UNINSTALL_PATHS: path.join(home, '.claude', 'vibecoding-course') });
    assert(/ЗАЩИТА/.test(r2.stdout || ''), 'guard печатает ЗАЩИТА: ' + (r2.stdout || '') + (r2.stderr || ''));
    assert(r2.status !== 0, 'отклонённое удаление → ненулевой код (P1-7)');
    assert(fs.existsSync(path.join(home, '.claude', 'vibecoding-course', 'x.md')), 'внутри ~/.claude ничего не удалено');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P0-4 uninstall.ps1 (функционально, win32): БЕЗ квитанции → отказ exit 3, ничего не удалено', () => {
  if (process.platform !== 'win32') return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-unwr-'));
  try {
    fs.mkdirSync(path.join(home, 'HamidunCourse', 'vibecoding-course'), { recursive: true });
    fs.writeFileSync(path.join(home, 'HamidunCourse', 'vibecoding-course', 'CLAUDE.md'), 'course');
    const r = runUninstallPs(home, 'course', {});
    if (r.error) { console.log('     (powershell недоступен — пропуск)'); return; }
    assert.strictEqual(r.status, 3, 'exit 3 (отказ): ' + (r.stdout || ''));
    assert(/нет квитанции установки/.test(r.stdout || ''), 'сообщение об отказе');
    assert(fs.existsSync(path.join(home, 'HamidunCourse', 'vibecoding-course', 'CLAUDE.md')), 'артефакт НЕ тронут');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('P0-5 uninstall.ps1 (функционально, win32): двойной слэш → ЗАЩИТА; junction-предок → отказ (реальная ФС)', () => {
  if (process.platform !== 'win32') return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-unwj-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'memory', 'MEMORY.md'), 'memories');
    // Двойной разделитель НЕ должен обойти префикс-сравнение (GetFullPath схлопывает ДО сравнения).
    const doubled = home + '\\\\.claude';
    const r = runUninstallPs(home, 'course', { HM_UNINSTALL_PATHS: doubled });
    if (r.error) { console.log('     (powershell недоступен — пропуск)'); return; }
    assert(/ЗАЩИТА/.test(r.stdout || ''), 'двойной слэш → ЗАЩИТА: ' + (r.stdout || ''));
    assert(fs.existsSync(path.join(home, '.claude', 'memory', 'MEMORY.md')), '~/.claude цел');
    // Junction-предок (реальная ФС, без админа): mklink /J → цель за junction НЕ удаляется.
    fs.mkdirSync(path.join(home, 'realdir', 'payload'), { recursive: true });
    fs.writeFileSync(path.join(home, 'realdir', 'payload', 'f.txt'), 'x');
    const mk = spawnSync('cmd.exe', ['/c', 'mklink', '/J', path.join(home, 'linkdir'), path.join(home, 'realdir')],
      { encoding: 'utf8', timeout: 30000 });
    if (mk.status !== 0) { console.log('     (mklink /J не сработал — ветка junction пропущена)'); return; }
    const r2 = runUninstallPs(home, 'course', { HM_UNINSTALL_PATHS: path.join(home, 'linkdir', 'payload') });
    assert(/ЗАЩИТА/.test(r2.stdout || ''), 'junction-предок → ЗАЩИТА: ' + (r2.stdout || ''));
    assert(r2.status !== 0, 'отклонено → ненулевой код');
    assert(fs.existsSync(path.join(home, 'realdir', 'payload', 'f.txt')), 'цель за junction НЕ удалена');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('uninstall: REMOVABLE (app.js) гейтится квитанцией; скрипты — generic receipt-driven', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const m = app.match(/REMOVABLE = new Set\(\[([^\]]+)\]\)/);
  assert(m, 'REMOVABLE найден в app.js');
  const ids = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  assert(ids.length >= 1, 'набор не пуст');
  // P0-4: «Удалить» в UI показывается ТОЛЬКО при наличии квитанции (installer-owned).
  assert(/REMOVABLE\.has\(c\.id\) && !!\(det && det\.receipted\)/.test(app),
    'кнопка «Удалить» гейтится det.receipted');
  // Скрипты удаляют по инвентарю квитанции (HM_UNINSTALL_PATHS) — id-ветки нужны
  // только для не-файловых шагов; наличие путей для любого id обрабатывается generic-ом.
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uninstall.ps1'), 'utf8');
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'uninstall.sh'), 'utf8');
  assert(/Split-HmLines \$env:HM_UNINSTALL_PATHS/.test(ps), 'ps1: generic-удаление по путям квитанции');
  assert(/HM_UNINSTALL_PATHS\}/.test(sh), 'sh: generic-удаление по путям квитанции');
  assert(ids.some((id) => byId[id]), 'хотя бы часть REMOVABLE присутствует в components.json этой редакции');
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

// ---- P0-4: ownership receipts (install-receipts.js) -------------------------
console.log('== P0-4: ownership receipts (квитанции владения) ==');
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

ok('receipts: validArtifact — относительный путь/не-HKCU реестр отбрасываются (fail-closed)', () => {
  assert(!receiptsMod.validArtifact({ type: 'path', value: 'relative/path' }), 'относительный path отброшен');
  assert(receiptsMod.validArtifact({ type: 'path', value: process.platform === 'win32' ? 'C:\\abs\\path' : '/abs/path' }), 'абсолютный path принят');
  assert(!receiptsMod.validArtifact({ type: 'reg', value: 'HKLM|Key|Val' }), 'HKLM отброшен (только HKCU)');
  assert(receiptsMod.validArtifact({ type: 'reg', value: 'HKCU|Key\\Sub|Val' }), 'HKCU принят');
  assert(!receiptsMod.validArtifact({ type: 'launchagent', value: 'label-only' }), 'launchagent без plist отброшен');
});

ok('receipts: write → read round-trip; битый JSON/чужой id → null (отказ в деинсталляции)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rcp-'));
  try {
    const absPath = process.platform === 'win32' ? 'C:\\x\\artifact' : '/x/artifact';
    const rec = receiptsMod.buildReceipt('course', process.platform, [
      { type: 'path', value: absPath }, { type: 'path', value: 'relative-dropped' }
    ]);
    assert.strictEqual(rec.artifacts.length, 1, 'относительный путь отброшен при сборке');
    const w = receiptsMod.writeReceipt(home, 'course', rec);
    assert(w.ok, 'запись ok');
    const back = receiptsMod.readReceipt(home, 'course');
    assert(back && back.id === 'course' && back.artifacts.length === 1, 'round-trip');
    assert(receiptsMod.hasReceipt(home, 'course'), 'hasReceipt true');
    assert.strictEqual(receiptsMod.readReceipt(home, 'nomad'), null, 'нет квитанции → null');
    // битый JSON → null (fail-closed: отказ удалять)
    fs.writeFileSync(receiptsMod.receiptPath(home, 'uv'), '{broken', 'utf8');
    assert.strictEqual(receiptsMod.readReceipt(home, 'uv'), null, 'битый JSON → null');
    // чужой id внутри файла → null
    fs.writeFileSync(receiptsMod.receiptPath(home, 'bridge'),
      JSON.stringify({ schemaVersion: 1, id: 'mascot', artifacts: [] }), 'utf8');
    assert.strictEqual(receiptsMod.readReceipt(home, 'bridge'), null, 'id mismatch → null');
    // dryRun не пишет
    const w2 = receiptsMod.writeReceipt(home, 'dryid', rec, { dryRun: true });
    assert(w2.ok && w2.dryRun && !fs.existsSync(receiptsMod.receiptPath(home, 'dryid')), 'dryRun не пишет');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

ok('receipts: envFromReceipt — точный инвентарь newline-joined по типам', () => {
  const rec = {
    schemaVersion: 1, id: 'mascot', artifacts: [
      { type: 'path', value: '/a/b.app' }, { type: 'path', value: '/c/d' },
      { type: 'launchagent', value: 'com.x|/la/x.plist' },
      { type: 'bundleid', value: 'com.hamidun.claude-mascot' },
      { type: 'teamid', value: '3VN93XA9DY' },
      { type: 'reg', value: 'HKCU|K|V' },
      { type: 'pathentry', value: 'C:\\p\\uv' },
      { type: 'profileline', value: '/h/.zshrc|# Hamidun Bridge CLI proxy' }
    ]
  };
  const env = receiptsMod.envFromReceipt(rec);
  assert.strictEqual(env.HM_UNINSTALL_PATHS, '/a/b.app\n/c/d');
  assert.strictEqual(env.HM_UNINSTALL_LAUNCHAGENTS, 'com.x|/la/x.plist');
  assert.strictEqual(env.HM_UNINSTALL_BUNDLEID, 'com.hamidun.claude-mascot');
  assert.strictEqual(env.HM_UNINSTALL_TEAMID, '3VN93XA9DY');
  assert.strictEqual(env.HM_UNINSTALL_REG, 'HKCU|K|V');
  assert.strictEqual(env.HM_UNINSTALL_PATHENTRIES, 'C:\\p\\uv');
  assert.strictEqual(env.HM_UNINSTALL_PROFILELINES, '/h/.zshrc|# Hamidun Bridge CLI proxy');
});

ok('P0-4 main.js: uninstall гейтится readReceipt; env из envFromReceipt; receipted в detect-state', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/const rec = receipts\.readReceipt\(os\.homedir\(\), id\)/.test(s), 'квитанция читается ДО запуска');
  assert(/if \(!rec\) \{[\s\S]{0,400}Удаление отклонено/.test(s), 'нет квитанции → отказ (fail-closed)');
  assert(/Object\.assign\(childEnv, receipts\.envFromReceipt\(rec\)\)/.test(s), 'инвентарь уезжает в env скрипта');
  assert(/receipted: receipts\.hasReceipt\(home, id\)/.test(s), 'detect-state отдаёт receipted');
  assert(/receipts\.writeReceipt\(os\.homedir\(\), id,\s*\n?\s*receipts\.buildReceipt/.test(s), 'квитанция пишется при успешной установке');
  assert(/receipts\.parseReceiptLine\(l\)/.test(s), 'строки HM-RECEIPT собираются из вывода скрипта');
});

ok('P0-4: install-скрипты эмитят HM-RECEIPT (точные пути; mascot mac — bundleid+teamid, без глобов)', () => {
  const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } };
  const musts = [
    ['scripts/windows/uv.ps1', /HM-RECEIPT path \$dest/, /HM-RECEIPT pathentry \$dest/],
    ['scripts/macos/uv.sh', /HM-RECEIPT path \$DEST\/uv/],
    ['scripts/windows/mascot.ps1', /HM-RECEIPT path \$destDir/, /HM-RECEIPT reg HKCU\|Software\\Microsoft\\Windows\\CurrentVersion\\Run\|ClaudeMascot/],
    ['scripts/macos/mascot.sh', /HM-RECEIPT path \$DEST/, /HM-RECEIPT bundleid/, /HM-RECEIPT teamid \$MASCOT_TEAM_ID/, /HM-RECEIPT launchagent com\.hamidun\.claude-mascot\|\$LA/],
    ['scripts/windows/bridge.ps1', /HM-RECEIPT path \$dst/, /HM-RECEIPT reg HKCU\|Software\\Microsoft\\Windows\\CurrentVersion\\Run\|HamidunBridge/],
    ['scripts/macos/bridge.sh', /HM-RECEIPT path \$DST/, /HM-RECEIPT launchagent com\.hamidun\.bridge\|\$LA/, /HM-RECEIPT profileline \$RC\|\$BRIDGE_RC_MARK/],
    ['scripts/windows/nomad.ps1', /HM-RECEIPT path \$src/, /HM-RECEIPT path \$p/],
    ['scripts/macos/nomad.sh', /HM-RECEIPT path \$SRC/, /HM-RECEIPT path \$HOME\/\.local\/bin\/\$shim/]
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

ok('P1-7 main.js: запись манифеста/квитанция чистятся ТОЛЬКО после пост-детекции отсутствия', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const i = s.indexOf("ipcMain.handle('uninstall-component'");
  const block = s.slice(i);
  assert(/let stillThere = true/.test(block), 'дефолт: считаем, что компонент остался');
  assert(/detectComponents\(\)/.test(block), 'пост-uninstall детекция вызывается');
  assert(/if \(!stillThere\) \{[\s\S]{0,300}manifest\.removeEntry/.test(block), 'removeEntry только при подтверждённом отсутствии');
  assert(/receipts\.removeReceipt/.test(block), 'квитанция чистится там же');
  assert(/catch \(e\) \{ stillThere = true; \}/.test(block), 'сбой детекции → НЕ чистим (fail-closed)');
});

ok('P1-8 main.js: dry-run — БЕЗ докачки и БЕЗ записи install.log', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/if \(declared && isDryRun\) \{/.test(s), 'докачка remote-компонента гейтится dry-run ДО download');
  assert(/const logLine = \(line\) => \{ if \(!isDryRun\) logToFile\(id, line\); \};/.test(s), 'логирование в файл гейтится dry-run');
  const un = s.slice(s.indexOf("ipcMain.handle('uninstall-component'"));
  assert(/const logLine = \(line\) => \{ if \(!isDryRun\) logToFile\(id, line\); \};/.test(un), 'и в uninstall тоже');
});

ok('P1-8 config.ps1/sh + uv.ps1/sh: dry-run ветвится ДО clone/fetch/chmod/докачки', () => {
  const cps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  const iDryPs = cps.indexOf('if ($DRY) {');
  assert(iDryPs !== -1 && iDryPs < cps.indexOf('git clone'), 'config.ps1: dry-run раньше git clone');
  assert(iDryPs < cps.indexOf('git -C $clone fetch'), 'config.ps1: dry-run раньше git fetch/reset');
  const csh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  const iDrySh = csh.indexOf('if [ -n "${HM_DRY_RUN:-}" ]; then');
  assert(iDrySh !== -1 && iDrySh < csh.indexOf('git clone'), 'config.sh: dry-run раньше git clone');
  assert(iDrySh < csh.indexOf('chmod +x'), 'config.sh: dry-run раньше chmod');
  const ups = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'uv.ps1'), 'utf8');
  assert(ups.indexOf('if ($DRY) {') < ups.indexOf('$cache = $env:HM_REMOTE_CACHE'), 'uv.ps1: dry-run раньше проверки кэша');
  const ush = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'uv.sh'), 'utf8');
  assert(ush.indexOf('if [ -n "$DRY" ]; then') < ush.indexOf('CACHE="${HM_REMOTE_CACHE:-}"'), 'uv.sh: dry-run раньше проверки кэша');
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

  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

asyncTests().then(() => {
  console.log(`\nИТОГ: ${pass} прошло, ${fail} упало`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL async tests:', e); process.exit(1); });
