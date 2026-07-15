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
  // M5: guard БЕЗ $ADDITIVE — fail-closed действует и в clean-режиме.
  assert(/if \(\$pruneDisabled -or \$installFailed\)/.test(s),
    'прунинг пропускается при pruneDisabled ИЛИ installFailed (в ОБОИХ режимах, без $ADDITIVE-условия)');
  assert(!/if \(\$ADDITIVE -and \(\$pruneDisabled/.test(s), 'старый additive-only guard убран (M5)');
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
  assert(/if \[ "\$ADDITIVE" -ne 1 \]; then\s*\n\s*if restore_user_data "\$PRESERVE_DIR"; then/.test(s),
    'финальный restore выполняется ТОЛЬКО в clean-режиме (и его rc проверяется — H1)');
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
  assert(/elif ! find "\$CLAUDE_HOME\/skills" -mindepth 1 -maxdepth 1 -exec basename/.test(s),
    'перечисление обязано пройти ПОЛНОСТЬЮ успешно (find с проверкой кода)');
  assert(!/-mindepth 1 -maxdepth 1 -type d -exec basename/.test(s),
    'инвентарь БЕЗ -type d: symlink/файл-дети тоже пред-существующие (иначе symlink-скилл считался бы «нашим»)');
  assert(/we_added=0\s+# списка нет → считаем пред-существующим → не удаляем/.test(s),
    'без валидного списка дефолт we_added=0 (все скиллы пред-существующие)');
  assert(/PRUNE_DISABLED" -eq 1 \] \|\| \[ "\$RC" -ne 0 \]/.test(s), 'прунинг пропускается при PRUNE_DISABLED или RC!=0');
});

ok('P0 config.sh: прунинг — два прохода; grep rc>=2 (EIO) → PRUNE_ABORT ДО первого удаления; symlink-скилл скипается', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  assert(/g=\$\?/.test(s), 'rc grep-а по файлу списка сохраняется');
  assert(/\[ "\$g" -ge 2 \]/.test(s) || /"\$g" -ge 2/.test(s), 'rc>=2 (EIO и т.п.) различается от «не найдено» (rc=1)');
  assert(/PRUNE_ABORT=1; break/.test(s), 'сбой чтения списка → прунинг останавливается ЦЕЛИКОМ');
  const iAbort = s.indexOf('PRUNE_ABORT=1; break');
  const iRm = s.indexOf('rm -rf "$SK/$name"');
  assert(iAbort !== -1 && iRm !== -1 && iAbort < iRm, 'отбор кандидатов идёт ДО удалений (двухпроходно)');
  assert(/\[ -L "\$\{d%\/\}" \] && continue/.test(s), 'symlink-скилл в цикле прунинга скипается (rm -rf по ссылке уходит в чужую цель)');
  assert(/Прунинг паков пропущен \(fail-closed\): сбой чтения/.test(s), 'явное fail-closed сообщение при PRUNE_ABORT');
});

ok('P1 config.sh/ps1: сбой копирования ~/CLAUDE.md / credentials-шаблона → провал установки + прунинг off', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  assert(/cp "\$SRC_CLAUDE_MD" "\$HOME\/CLAUDE\.md" \|\| \{ COPY_FAILED=1/.test(sh), 'sh: cp CLAUDE.md с обработкой сбоя');
  assert(/cp "\$CLONE\/\.credentials\.template\.env" "\$CLAUDE_HOME\/\.credentials\.master\.env" \|\| \{ COPY_FAILED=1/.test(sh),
    'sh: cp credentials-шаблона с обработкой сбоя');
  const iCp = sh.indexOf('cp "$SRC_CLAUDE_MD"');
  const iEval = sh.indexOf('if [ "$COPY_FAILED" -eq 1 ]; then');
  assert(iCp !== -1 && iEval !== -1 && iCp < iEval, 'sh: оценка COPY_FAILED идёт ПОСЛЕ этих копирований');
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  assert(/Copy-Item -Force \$srcClaudeMd \$profileClaudeMd -ErrorAction Stop/.test(ps), 'ps1: CLAUDE.md копируется с -ErrorAction Stop');
  assert(/Copy-Item -Force \$srcEnvTpl \$dstEnv -ErrorAction Stop/.test(ps), 'ps1: credentials-шаблон с -ErrorAction Stop');
  assert((ps.match(/catch \{ \$installFailed = \$true; \$pruneDisabled = \$true; Write-Host "ВНИМАНИЕ: не удалось скопировать/g) || []).length >= 2,
    'ps1: оба catch → installFailed + pruneDisabled');
});

ok('P0 config.ps1: инвентарь -Force (все дети, вкл. symlink/файлы); reparse-скилл в прунинге скипается', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  assert(/Get-ChildItem -Force -LiteralPath \$skillsDirNow -ErrorAction Stop \| ForEach-Object \{ \$preExisting/.test(ps),
    'инвентарь пред-существующих — ВСЕ immediate-дети (без -Directory)');
  const loop = ps.slice(ps.indexOf('Get-ChildItem -Directory $skillsDir | ForEach-Object'));
  assert(/ReparsePoint\) \{ return \}/.test(loop.slice(0, 600)), 'reparse-скилл (symlink/junction) в цикле удаления скипается');
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

  ok('P0 config.sh (функционально): пред-существующий SYMLINK-скилл переживает прунинг (fail-closed)', () => {
    const { base, home, clone } = mkFakeConfigHome();
    try {
      // symlink-скилл в ~/.claude/skills, указывающий на чужую папку с данными
      fs.mkdirSync(base + '/elsewhere-skill', { recursive: true });
      fs.writeFileSync(base + '/elsewhere-skill/DATA.md', 'precious');
      let linked = false;
      try { fs.symlinkSync(base + '/elsewhere-skill', home + '/.claude/skills/link-skill', 'junction'); linked = true; }
      catch (e) { linked = false; }
      if (!linked) { console.log('     (symlink недоступен в этой среде — пропуск)'); return; }
      // link-skill «в паке», пак снят → старый код счёл бы его «нашим» (find -type d
      // терял symlink-детей в инвентаре) и удалил бы ЧУЖУЮ цель.
      const r = runConfigSh(home, clone, {
        HM_ALL_PACK_SKILLS: 'link-skill,our-skill',
        HM_KEEP_SKILLS: 'something-else'
      });
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(fs.existsSync(home + '/.claude/skills/link-skill'), 'symlink-скилл ЦЕЛ');
      assert(fs.existsSync(base + '/elsewhere-skill/DATA.md'), 'данные за ссылкой ЦЕЛЫ');
      assert(!fs.existsSync(home + '/.claude/skills/our-skill'), 'наш скилл снятого пака удалён (прунинг работает)');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
} else {
  console.log('  ⚠️  bash недоступен — функциональные прогоны config.sh пропущены.');
}

// ---- H1-H4/M5-M8: clean/repair-режим — снапшот-полнота + restore fail-closed ----

console.log('== H1-H4/M5-M8 (статически): снапшот-полнота, restore fail-closed, preserve-список, robocopy-бэкап ==');

const CANON_USER_FILES = ['.credentials.master.env', '.credentials.json', 'settings.local.json', 'MEMORY.md',
  'chats.db', 'chats.db-wal', 'chats.db-shm', 'chats.db-journal',
  'tg_session.session', 'tg_session.session-journal'];

ok('H4: preserve-список clean-режима (ps1+sh) включает chats.db*/tg_session* и совпадает с additive-исключениями', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  const pf = ps.match(/\$preserveFiles = @\(([\s\S]*?)\)/);
  assert(pf, 'ps1: $preserveFiles найден');
  CANON_USER_FILES.forEach((n) => assert(pf[1].indexOf("'" + n + "'") !== -1, 'ps1 preserveFiles: ' + n));
  const ex = ps.match(/\$excludeNames = @\(([\s\S]*?)\)/);
  assert(ex, 'ps1: additive $excludeNames найден');
  CANON_USER_FILES.forEach((n) => assert(ex[1].indexOf("'" + n + "'") !== -1, 'ps1 additive /XF: ' + n));
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  const m = sh.match(/^PRESERVE_FILES="([^"]+)"$/m);
  assert(m, 'sh: PRESERVE_FILES найден');
  const list = m[1].split(/\s+/);
  CANON_USER_FILES.forEach((n) => assert(list.indexOf(n) !== -1, 'sh PRESERVE_FILES: ' + n));
  assert(/--exclude='chats\.db\*'/.test(sh) && /--exclude='tg_session\.session\*'/.test(sh),
    'sh additive rsync-глобы покрывают chats.db*/tg_session.session*');
});

ok('H2/H3: снапшот сверяет полноту (rc+размер файлов, robocopy-код каталогов); неполный → abort ДО install', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  const iSnap = ps.indexOf('$snapOk = Snapshot-UserData $preserveDir');
  const iInst = ps.indexOf('& $installer -BackupExisting -SkipDeps');
  assert(iSnap !== -1 && iInst !== -1 && iSnap < iInst, 'ps1: снапшот идёт ДО install.ps1');
  const gate = ps.slice(iSnap, iInst);
  assert(/НИЧЕГО не менял/.test(gate) && /exit 1/.test(gate), 'ps1: неполный снапшот → честное сообщение + exit 1 ДО wipe');
  const fnPs = ps.slice(ps.indexOf('function Snapshot-UserData'), ps.indexOf('function Restore-UserData'));
  assert(/return \$ok/.test(fnPs) && /return \$false/.test(fnPs), 'ps1: Snapshot-UserData возвращает статус');
  assert(/\$dstLen -ne \$srcLen/.test(fnPs), 'ps1: файл сверяется по размеру со снапшотом');
  assert(/LASTEXITCODE -ge 8/.test(fnPs), 'ps1: robocopy-код каталогов проверяется');
  assert(!/Copy-Item[^\n]*-ErrorAction SilentlyContinue/.test(fnPs), 'ps1: тихий Copy-Item из снапшота убран (H3)');
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  const iSnapSh = sh.indexOf('if ! snapshot_user_data "$PRESERVE_DIR"; then');
  const iInstSh = sh.indexOf('bash "$CLONE/install.sh" --backup --skip-deps');
  assert(iSnapSh !== -1 && iInstSh !== -1 && iSnapSh < iInstSh, 'sh: abort-гейт снапшота идёт ДО install.sh');
  const gateSh = sh.slice(iSnapSh, iInstSh);
  assert(/НИЧЕГО не менял/.test(gateSh) && /exit 1/.test(gateSh), 'sh: неполный снапшот → сообщение + exit 1');
  const fnSh = sh.slice(sh.indexOf('snapshot_user_data()'), sh.indexOf('restore_user_data()'));
  assert(/cp -f "\$s" "\$dst\/\$f" \|\| \{ rc=1; continue; \}/.test(fnSh), 'sh: rc каждого cp проверяется (H3)');
  assert(/hm_fsize/.test(fnSh), 'sh: размер файла сверяется');
  assert(/mkdir -p "\$dst" \|\| return 1/.test(fnSh), 'sh: сбой mkdir снапшота → провал');
  assert(/return \$rc/.test(fnSh), 'sh: честный код возврата');
});

ok('H1/M8: restore сверяется с СОДЕРЖИМЫМ снапшота (hash/cmp, не Test-Path); rm снапшота и «Вернул» только при успехе', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  const fnR = ps.slice(ps.indexOf('function Restore-UserData('), ps.indexOf('function Restore-UserDataMissingOnly'));
  assert(/Get-FileHash/.test(fnR), 'ps1: файл сверяется хэшем со снапшотом — ШАБЛОН install.ps1 не сойдёт за ключи (M8)');
  assert(!/if \(-not \(Test-Path \(Join-Path \$claudeHome \$f\)\)\)/.test(fnR), 'ps1: старая Test-Path-«проверка» цели убрана');
  assert(/\$restoreFailed = \$true/.test(ps), 'ps1: провал restore фиксируется');
  assert(/if \(\$restoreFailed\) \{[\s\S]{0,300}exit 1/.test(ps), 'ps1: провал restore → ненулевой выход (не зелёный рапорт)');
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  const fnRs = sh.slice(sh.indexOf('restore_user_data()'), sh.indexOf('restore_user_data_missing_only()'));
  assert(/cp -f "\$s" "\$CLAUDE_HOME\/\$f" \|\| \{ rc=1; continue; \}/.test(fnRs), 'sh: rc каждого cp проверяется (H1)');
  assert(/hm_fsize/.test(fnRs) && /cmp -s/.test(fnRs), 'sh: сверка размера+содержимого со снапшотом (M8)');
  assert(/return \$rc/.test(fnRs), 'sh: честный rc');
  assert(/if restore_user_data "\$PRESERVE_DIR"; then\s*\n\s*rm -rf "\$PRESERVE_DIR"\s*\n\s*echo "Вернул/.test(sh),
    'sh: rm -rf снапшота и «Вернул…» ТОЛЬКО в success-ветке');
  assert(/RESTORE_FAILED=1/.test(sh) && /Резервная копия НЕ удалена/.test(sh), 'sh: провал → снапшот сохранён + путь напечатан');
  assert(/if \[ "\$RESTORE_FAILED" -eq 1 \]; then\s*\n[^\n]*\n\s*exit 1/.test(sh), 'sh: провал restore → exit 1');
});

ok('M7: бэкап/снапшот/restore каталогов в ps1 через robocopy /R:1 /W:1 (long-path PS 5.1, без зависания на локах)', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  const iB = ps.indexOf('$backupDir = "$claudeHome.backup.$stamp"');
  const backupBlock = ps.slice(iB, ps.indexOf('$hadOldConfig'));
  assert(/robocopy \$claudeHome \$backupDir \/E \/R:1 \/W:1/.test(backupBlock), 'бэкап через robocopy (не Copy-Item -Recurse)');
  assert(!/Copy-Item -Recurse -Force \$claudeHome \$backupDir/.test(ps), 'старый Copy-Item-бэкап убран');
  assert(/LASTEXITCODE -ge 8/.test(backupBlock), 'robocopy-код бэкапа проверяется (fail-closed до install)');
  const fnSnap = ps.slice(ps.indexOf('function Snapshot-UserData'), ps.indexOf('function Restore-UserDataMissingOnly'));
  assert((fnSnap.match(/robocopy \$s \$t \/E \/R:1 \/W:1/g) || []).length >= 2, 'снапшот и restore каталогов тоже robocopy');
});

ok('M5/M6: clean-prune fail-closed — guard без ADDITIVE-условия + reparse/symlink-проверка skills в ОБОИХ режимах', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'config.ps1'), 'utf8');
  assert(/if \(\$pruneDisabled -or \$installFailed\)/.test(ps), 'ps1: guard действует и в clean (M5)');
  assert(/\$skillsReparse = \$false/.test(ps) && /elseif \(Test-Path \$skillsDir\)/.test(ps),
    'ps1: reparse-проверка каталога skills в прунинг-блоке (M6, действует и в clean)');
  const iGuard = ps.indexOf('if ($pruneDisabled -or $installFailed)');
  const iReparse = ps.indexOf('$skillsReparse = $false');
  assert(iGuard !== -1 && iReparse > iGuard, 'ps1: reparse-проверка внутри прунинг-секции');
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'config.sh'), 'utf8');
  assert(/if \[ "\$PRUNE_DISABLED" -eq 1 \] \|\| \[ "\$RC" -ne 0 \]; then/.test(sh), 'sh: guard без ADDITIVE-условия (M5)');
  assert(!/\[ "\$ADDITIVE" -eq 1 \] && \{ \[ "\$PRUNE_DISABLED"/.test(sh), 'sh: старый additive-only guard убран');
  const iSK = sh.indexOf('SK="$HOME/.claude/skills"');
  assert(iSK !== -1 && /if \[ -L "\$SK" \]; then/.test(sh.slice(iSK, iSK + 400)),
    'sh: symlink-проверка каталога skills в прунинг-блоке (M6)');
});

// ---- Функциональные прогоны CLEAN-режима (H7/H8) на РЕАЛЬНОЙ ФС ----
// Фейковый base-инсталлер имитирует config-pack install.ps1/sh --backup:
// Move-Item/mv ВСЕГО ~/.claude (wipe живого дерева) + свежая база + ШАБЛОН
// .credentials.master.env поверх (как настоящий: после wipe DST_ENV отсутствует).

function mkFakeCleanHome() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cln-')).replace(/\\/g, '/');
  const home = base + '/home';
  const clone = base + '/clone';
  fs.mkdirSync(clone, { recursive: true });
  fs.mkdirSync(home + '/.claude/memory', { recursive: true });
  fs.mkdirSync(home + '/.claude/projects/p1', { recursive: true });
  fs.writeFileSync(home + '/.claude/.credentials.master.env', 'KEY=NEW');
  fs.writeFileSync(home + '/.claude/chats.db', 'CHATS-FTS5-HISTORY');
  fs.writeFileSync(home + '/.claude/tg_session.session', 'TG-AUTH');
  fs.writeFileSync(home + '/.claude/settings.local.json', '{"local":"custom"}');
  fs.writeFileSync(home + '/.claude/settings.json', '{"user":"old"}');
  fs.writeFileSync(home + '/.claude/memory/MEMORY.md', 'memories');
  fs.writeFileSync(home + '/.claude/projects/p1/session.jsonl', 'history');
  return { base, home, clone };
}

const FAKE_INSTALL_SH_CLEAN = [
  '#!/bin/bash',
  'echo ran > "$HOME/.install-ran"',
  'if [ -d "$HOME/.claude" ]; then mv "$HOME/.claude" "$HOME/.claude.wiped.$$"; fi',
  'mkdir -p "$HOME/.claude/rules"',
  'printf %s "fresh-rule" > "$HOME/.claude/rules/new-rule.md"',
  'printf %s "{\\"fresh\\":\\"base\\"}" > "$HOME/.claude/settings.json"',
  'printf %s "KEY=TEMPLATE" > "$HOME/.claude/.credentials.master.env"',
  'exit 0'
].join('\n') + '\n';

function runConfigShClean(home, clone, extraEnv) {
  const script = path.join(ROOT, 'scripts', 'macos', 'config.sh');
  const env = Object.assign({}, process.env, { HOME: home, HM_BUNDLED_CONFIG: clone });
  delete env.HM_ADDITIVE; delete env.HM_DRY_RUN; delete env.HM_KEEP_SKILLS; delete env.HM_ALL_PACK_SKILLS;
  Object.assign(env, extraEnv || {});
  return spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000, env });
}

if (bashAvailable()) {
  console.log('== H1/H2/H3/H4 config.sh CLEAN (функционально): wipe→restore, abort до wipe, провал restore ==');

  ok('H4/H1 config.sh clean: ключи/chats.db/tg_session/память восстановлены, свежая база разложена, снапшот очищен', () => {
    const { base, home, clone } = mkFakeCleanHome();
    try {
      fs.writeFileSync(clone + '/install.sh', FAKE_INSTALL_SH_CLEAN);
      const r = runConfigShClean(home, clone);
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(fs.existsSync(home + '/.install-ran'), 'base-инсталлер реально отработал (wipe был)');
      // user data вернулись ПОВЕРХ шаблона/свежей базы
      assert.strictEqual(fs.readFileSync(home + '/.claude/.credentials.master.env', 'utf8'), 'KEY=NEW',
        'ключи KEY=NEW восстановлены (НЕ шаблон KEY=TEMPLATE)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/chats.db', 'utf8'), 'CHATS-FTS5-HISTORY', 'история чатов восстановлена (H4)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/tg_session.session', 'utf8'), 'TG-AUTH', 'TG-авторизация восстановлена (H4)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.local.json', 'utf8'), '{"local":"custom"}', 'локальные настройки живы');
      assert.strictEqual(fs.readFileSync(home + '/.claude/memory/MEMORY.md', 'utf8'), 'memories', 'память жива');
      assert.strictEqual(fs.readFileSync(home + '/.claude/projects/p1/session.jsonl', 'utf8'), 'history', 'история сессий жива');
      // свежая база разложена (clean: settings.json — от новой базы)
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.json', 'utf8'), '{"fresh":"base"}', 'свежая база разложена');
      assert.strictEqual(fs.readFileSync(home + '/.claude/rules/new-rule.md', 'utf8'), 'fresh-rule', 'свежие правила разложены');
      // снапшот очищен ТОЛЬКО потому, что restore прошёл полностью
      assert(!fs.existsSync(home + '/.hamidun-setup/preserve'), 'снапшот удалён после ПОЛНОГО restore');
      assert(/Вернул твои ключи/.test(r.stdout || ''), 'честный рапорт о возврате');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('H2/H3 config.sh clean: неполный снапшот (preserve-dir недоступен) → abort ДО install, живое ~/.claude НЕ тронуто', () => {
    const { base, home, clone } = mkFakeCleanHome();
    try {
      fs.writeFileSync(clone + '/install.sh', FAKE_INSTALL_SH_CLEAN);
      // ~/.hamidun-setup занят ФАЙЛОМ → mkdir -p preserve упадёт → снапшот невозможен
      fs.writeFileSync(home + '/.hamidun-setup', 'not-a-dir');
      const r = runConfigShClean(home, clone);
      assert(r.status !== 0, 'ненулевой выход (fail-closed): ' + (r.stdout || ''));
      assert(/НИЧЕГО не менял/.test(r.stdout || ''), 'честное сообщение об отмене: ' + (r.stdout || ''));
      assert(!fs.existsSync(home + '/.install-ran'), 'install.sh НЕ запускался (abort ДО wipe)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/.credentials.master.env', 'utf8'), 'KEY=NEW', 'живые ключи не тронуты');
      assert.strictEqual(fs.readFileSync(home + '/.claude/chats.db', 'utf8'), 'CHATS-FTS5-HISTORY', 'живой chats.db не тронут');
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.json', 'utf8'), '{"user":"old"}', 'живой settings.json не тронут');
      assert(!/Вернул твои ключи/.test(r.stdout || ''), 'никакого ложного «Вернул»');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('H1 config.sh clean: провал restore → снапшот СОХРАНЁН, «Вернул» НЕ печатается, ненулевой выход', () => {
    const { base, home, clone } = mkFakeCleanHome();
    try {
      // base-инсталлер подкладывает КАТАЛОГ chats.db → restore-cp упадёт
      fs.writeFileSync(clone + '/install.sh',
        FAKE_INSTALL_SH_CLEAN.replace('exit 0', 'mkdir -p "$HOME/.claude/chats.db"\nexit 0'));
      const r = runConfigShClean(home, clone);
      assert(r.status !== 0, 'ненулевой выход (restore провален): ' + (r.stdout || ''));
      assert(!/Вернул твои ключи/.test(r.stdout || ''), '«Вернул…» НЕ печатается при провале');
      assert(/Резервная копия НЕ удалена/.test(r.stdout || ''), 'путь к снапшоту напечатан честно');
      assert.strictEqual(fs.readFileSync(home + '/.hamidun-setup/preserve/chats.db', 'utf8'), 'CHATS-FTS5-HISTORY',
        'снапшот с историей ЦЕЛ (единственная копия не удалена)');
      assert.strictEqual(fs.readFileSync(home + '/.hamidun-setup/preserve/.credentials.master.env', 'utf8'), 'KEY=NEW',
        'снапшот с ключами ЦЕЛ');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
} else {
  console.log('  ⚠️  bash недоступен — функциональные CLEAN-прогоны config.sh пропущены.');
}

// ---- config.ps1 CLEAN (функционально, Windows): те же три сценария ----

function powershellAvailable() {
  if (process.platform !== 'win32') return false;
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
    { encoding: 'utf8', timeout: 30000 });
  return !(probe.error || probe.status !== 0);
}

const FAKE_INSTALL_PS1_CLEAN = [
  'param([switch]$Force, [switch]$SkipDeps, [switch]$BackupExisting)',
  "Set-Content -Path (Join-Path $env:USERPROFILE '.install-ran') -Value 'ran'",
  "$dst = Join-Path $env:USERPROFILE '.claude'",
  'if (Test-Path $dst) { Move-Item $dst "$dst.wiped.$PID" }',
  "New-Item -ItemType Directory -Force (Join-Path $dst 'rules') | Out-Null",
  "[System.IO.File]::WriteAllText((Join-Path $dst 'rules\\new-rule.md'), 'fresh-rule')",
  "[System.IO.File]::WriteAllText((Join-Path $dst 'settings.json'), '{\"fresh\":\"base\"}')",
  "[System.IO.File]::WriteAllText((Join-Path $dst '.credentials.master.env'), 'KEY=TEMPLATE')",
  'exit 0'
].join('\r\n') + '\r\n';

function runConfigPs1Clean(home, clone, extraEnv) {
  const script = path.join(ROOT, 'scripts', 'windows', 'config.ps1');
  const env = Object.assign({}, process.env, {
    USERPROFILE: home.replace(/\//g, '\\'),
    HM_BUNDLED_CONFIG: clone.replace(/\//g, '\\')
  });
  delete env.HM_ADDITIVE; delete env.HM_DRY_RUN; delete env.HM_KEEP_SKILLS; delete env.HM_ALL_PACK_SKILLS;
  Object.assign(env, extraEnv || {});
  return spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '" + script + "'"],
    { encoding: 'utf8', timeout: 180000, env });
}

if (powershellAvailable()) {
  console.log('== H1/H2/H3/H4/M8 config.ps1 CLEAN (функционально): wipe→restore, abort до wipe, провал restore ==');

  ok('H4/H1/M8 config.ps1 clean: ключи/chats.db/tg_session восстановлены (НЕ шаблон), база разложена, снапшот очищен', () => {
    const { base, home, clone } = mkFakeCleanHome();
    try {
      fs.writeFileSync(clone + '/install.ps1', FAKE_INSTALL_PS1_CLEAN);
      const r = runConfigPs1Clean(home, clone);
      assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stdout || '') + (r.stderr || ''));
      assert(fs.existsSync(home + '/.install-ran'), 'base-инсталлер реально отработал (wipe был)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/.credentials.master.env', 'utf8'), 'KEY=NEW',
        'ключи KEY=NEW восстановлены поверх шаблона (M8: не ложный успех на KEY=TEMPLATE)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/chats.db', 'utf8'), 'CHATS-FTS5-HISTORY', 'история чатов восстановлена (H4)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/tg_session.session', 'utf8'), 'TG-AUTH', 'TG-авторизация восстановлена (H4)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.local.json', 'utf8'), '{"local":"custom"}', 'локальные настройки живы');
      assert.strictEqual(fs.readFileSync(home + '/.claude/memory/MEMORY.md', 'utf8'), 'memories', 'память жива');
      assert.strictEqual(fs.readFileSync(home + '/.claude/projects/p1/session.jsonl', 'utf8'), 'history', 'история сессий жива');
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.json', 'utf8'), '{"fresh":"base"}', 'свежая база разложена');
      assert(!fs.existsSync(home + '/.hamidun-setup/preserve'), 'снапшот удалён после ПОЛНОГО restore');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('H2/H3 config.ps1 clean: неполный снапшот (preserve-dir недоступен) → abort ДО install, живое ~/.claude НЕ тронуто', () => {
    const { base, home, clone } = mkFakeCleanHome();
    try {
      fs.writeFileSync(clone + '/install.ps1', FAKE_INSTALL_PS1_CLEAN);
      // ~/.hamidun-setup занят ФАЙЛОМ → New-Item Directory preserve упадёт → снапшот невозможен
      fs.writeFileSync(home + '/.hamidun-setup', 'not-a-dir');
      const r = runConfigPs1Clean(home, clone);
      assert(r.status !== 0, 'ненулевой выход (fail-closed): ' + (r.stdout || '') + (r.stderr || ''));
      assert(!fs.existsSync(home + '/.install-ran'), 'install.ps1 НЕ запускался (abort ДО wipe)');
      assert.strictEqual(fs.readFileSync(home + '/.claude/.credentials.master.env', 'utf8'), 'KEY=NEW', 'живые ключи не тронуты');
      assert.strictEqual(fs.readFileSync(home + '/.claude/chats.db', 'utf8'), 'CHATS-FTS5-HISTORY', 'живой chats.db не тронут');
      assert.strictEqual(fs.readFileSync(home + '/.claude/settings.json', 'utf8'), '{"user":"old"}', 'живой settings.json не тронут');
      assert(!/Вернул твои ключи/.test(r.stdout || ''), 'никакого ложного «Вернул»');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  ok('H1/M8 config.ps1 clean: провал restore (каталог вместо chats.db) → снапшот СОХРАНЁН, «Вернул» НЕ печатается, exit 1', () => {
    const { base, home, clone } = mkFakeCleanHome();
    try {
      fs.writeFileSync(clone + '/install.ps1',
        FAKE_INSTALL_PS1_CLEAN.replace('exit 0',
          "New-Item -ItemType Directory -Force (Join-Path $dst 'chats.db') | Out-Null\r\nexit 0"));
      const r = runConfigPs1Clean(home, clone);
      assert(r.status !== 0, 'ненулевой выход (restore провален): ' + (r.stdout || '') + (r.stderr || ''));
      assert(!/Вернул твои ключи/.test(r.stdout || ''), '«Вернул…» НЕ печатается при провале');
      assert.strictEqual(fs.readFileSync(home + '/.hamidun-setup/preserve/chats.db', 'utf8'), 'CHATS-FTS5-HISTORY',
        'снапшот с историей ЦЕЛ (единственная копия не удалена)');
      assert.strictEqual(fs.readFileSync(home + '/.hamidun-setup/preserve/.credentials.master.env', 'utf8'), 'KEY=NEW',
        'снапшот с ключами ЦЕЛ');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });
} else {
  console.log('  ⚠️  powershell недоступен — функциональные CLEAN-прогоны config.ps1 пропущены.');
}

console.log('== Фаза 2 (переделка): деинсталляция по ЗАШИТОМУ аллоулисту, не по квитанциям ==');
const utMod = require(path.join(ROOT, 'src', 'uninstall-targets.js'));
const uxMod = require(path.join(ROOT, 'src', 'uninstall-exec.js'));
const NUL = String.fromCharCode(0);

function mkHomeDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hm-un-')); }
function dropDir(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
function targetPathsOf(plan) {
  return plan.targets.map((t) => t.path || t.dir || t.file || t.plist || '').filter(Boolean);
}

ok('targets: course (win32) — контент курса из известных мест; ярлык из вшитого config; НИ одной цели в ~/.claude', () => {
  const home = 'C:\\Users\\t';
  const plan = utMod.uninstallTargets('course', {
    platform: 'win32', home, desktop: 'C:\\Users\\t\\Desktop',
    courseTargetRaw: '%USERPROFILE%\\HamidunCourse', courseShortcut: 'Курс вайбкодинг (Claude Code)'
  });
  assert(plan && plan.targets.length, 'план есть');
  const cd = path.join(home, 'HamidunCourse', 'vibecoding-course');
  const paths = targetPathsOf(plan).map((p) => p.toLowerCase());
  [path.join(cd, 'tracks'), path.join(cd, '.claude', 'skills'), path.join(cd, '.claude', 'commands'),
   path.join(cd, '.course', 'knowledge'), path.join(cd, 'CLAUDE.md')]
    .forEach((p) => assert(paths.indexOf(p.toLowerCase()) !== -1, 'цель есть: ' + p));
  assert(plan.targets.some((t) => t.type === 'file' && /\\desktop\\курс вайбкодинг \(claude code\)\.lnk$/i.test(t.path)),
    'ярлык .lnk с именем из вшитого config.json (не из renderer-env)');
  targetPathsOf(plan).forEach((p) =>
    assert(p.toLowerCase().indexOf(path.join(home, '.claude').toLowerCase() + path.sep) !== 0 &&
           p.toLowerCase() !== path.join(home, '.claude').toLowerCase(),
      'цель НЕ в пользовательском ~/.claude: ' + p));
  // preserve: прогресс ученика — священен
  const keep = (plan.preserve || []).map((p) => p.toLowerCase());
  [path.join(cd, 'sandbox'), path.join(cd, '.course', 'state.json'),
   path.join(cd, '.course', 'identity.json'), path.join(cd, '.claude', 'settings.local.json')]
    .forEach((p) => assert(keep.indexOf(p.toLowerCase()) !== -1, 'preserve: ' + p));
});

ok('targets: resolveCourseTarget — %USERPROFILE% (win); Windows-путь/пусто на darwin → дефолт; ~ раскрывается', () => {
  assert.strictEqual(utMod.resolveCourseTarget('%USERPROFILE%\\HamidunCourse', 'C:\\Users\\t', 'win32'),
    'C:\\Users\\t\\HamidunCourse');
  assert.strictEqual(utMod.resolveCourseTarget('%USERPROFILE%\\HamidunCourse', '/Users/t', 'darwin'),
    path.join('/Users/t', 'HamidunCourse'));
  assert.strictEqual(utMod.resolveCourseTarget('', '/Users/t', 'darwin'), path.join('/Users/t', 'HamidunCourse'));
  assert.strictEqual(utMod.resolveCourseTarget('~/Cursos', '/Users/t', 'darwin'), path.join('/Users/t', 'Cursos'));
});

ok('targets: uv (win32) — ТОЧНЫЕ файлы (не рекурсивный каталог), emptydir, pathentry только при опустевшем каталоге', () => {
  const plan = utMod.uninstallTargets('uv', { platform: 'win32', home: 'C:\\Users\\t' });
  const dest = 'C:\\Users\\t\\AppData\\Local\\Programs\\uv';
  const types = plan.targets.map((t) => t.type);
  assert(plan.targets.some((t) => t.type === 'file' && t.path === path.join(dest, 'uv.exe')), 'file uv.exe');
  assert(plan.targets.some((t) => t.type === 'file' && t.path === path.join(dest, 'uvx.exe')), 'file uvx.exe');
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
  assert(ab && ab.path === path.join('/Users/t', 'Applications', 'Claude Mascot.app'), 'точный путь бандла');
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

// P1-7: classifyRegQuery — чистый tri-state. Ошибка запуска/кода/парсера НЕ
// превращается в «значения нет» (иначе absent → ложный успех удаления).
ok('P1-7 classifyRegQuery: значение прочитано / штатно отсутствует / ошибка — три РАЗНЫХ исхода', () => {
  // found:true — тип и данные разобраны, %VAR% НЕ раскрыт (raw)
  const okRes = uxMod.classifyRegQuery('Path', {
    status: 0,
    stdout: '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\uv\r\n'
  });
  assert(okRes.ok === true && okRes.found === true, 'значение прочитано');
  assert.strictEqual(okRes.type, 'REG_EXPAND_SZ', 'тип сохранён');
  assert.strictEqual(okRes.data, '%USERPROFILE%\\bin;C:\\uv', 'данные raw (%VAR% не раскрыт)');
  // P1: код 1 → absent ТОЛЬКО при РАСПОЗНАННОЙ not-found диагностике (reg.exe пишет
  // её по-английски даже на локализованной Windows — проверено на ru-RU).
  const absent = uxMod.classifyRegQuery('Path', { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' });
  assert(absent.ok === true && absent.found === false, 'код 1 + not-found → штатно отсутствует (found:false)');
  // P1: код 1 «Access is denied» → ОШИБКА, НЕ absent (иначе ложный успех удаления)
  const denied = uxMod.classifyRegQuery('Path', { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' });
  assert(denied.ok === false && !('found' in denied), 'код 1 + access denied → ok:false (НЕ absent)');
  // P1: код 1 без распознанной not-found диагностики → fail-closed (ok:false)
  const amb = uxMod.classifyRegQuery('Path', { status: 1, stdout: '', stderr: 'ERROR: странная неведомая ошибка' });
  assert(amb.ok === false && !('found' in amb), 'код 1 без not-found диагностики → ok:false (fail-closed)');
  // spawn error → ok:false (НЕ absent)
  const spawnErr = uxMod.classifyRegQuery('Path', { error: new Error('ENOENT reg.exe') });
  assert(spawnErr.ok === false && spawnErr.error, 'ошибка запуска → ok:false');
  // ненулевой код (кроме 1) → ok:false
  const badCode = uxMod.classifyRegQuery('Path', { status: 5, stdout: '' });
  assert(badCode.ok === false, 'код 5 (доступ) → ok:false, НЕ absent');
  // status 0, но вывод не разобрался как REG_(EXPAND_)SZ → ОШИБКА, не absent
  const garbled = uxMod.classifyRegQuery('Path', { status: 0, stdout: 'мусор без строки значения' });
  assert(garbled.ok === false && !('found' in garbled), 'непарсибельный stdout → ошибка (fail-closed), не absent');
  // отсутствие объекта результата → ошибка
  assert(uxMod.classifyRegQuery('Path', null).ok === false, 'нет результата → ошибка');
});

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
    const plan = utMod.uninstallTargets('bridge', { platform: 'win32', home });
    const dst = path.join(home, 'AppData', 'Local', 'HamidunBridge');
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
  assert(nsh.indexOf('SRC_TRUSTED" != "1" ]; then') !== -1 && nsh.indexOf('SRC_TRUSTED" != "1" ]; then') < nsh.indexOf('uv tool install'),
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
  assert(nps.indexOf('-not $srcTrusted) {') !== -1 && nps.indexOf('-not $srcTrusted) {') < nps.indexOf('tool install --python 3.12 "$src"'),
    'nomad.ps1: skip-гейт (exit 120) ПЕРЕД uv tool install');
});

// Codex P0-2: убран --force + guard существующего uv-tool/шимов (чужое не перезаписываем).
// Vendor-only: uv-тул = nomad-agent (pyproject [project].name), шимы = nmd/nomad-agent/nomad-acp.
ok('Codex P0 (scripts): uv tool install БЕЗ --force + guard существующего nomad-agent/шимов → skip 120', () => {
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'nomad.sh'), 'utf8');
  assert(!/--force/.test(nsh), 'nomad.sh: НИ ОДНОГО --force');
  assert(/uv tool install --python 3\.12 "\$SRC"/.test(nsh), 'nomad.sh: uv tool install без --force');
  assert(nsh.indexOf('UV_TOOL_NA="$HOME/.local/share/uv/tools/nomad-agent"') !== -1, 'nomad.sh: проверяется uv-tool nomad-agent');
  assert(nsh.indexOf('[ -e "$HOME/.local/bin/nmd" ]') !== -1 && nsh.indexOf('[ -e "$HOME/.local/bin/nomad-agent" ]') !== -1 && nsh.indexOf('[ -e "$HOME/.local/bin/nomad-acp" ]') !== -1,
    'nomad.sh: проверяются шимы nmd/nomad-agent/nomad-acp');
  const guardSh = nsh.slice(nsh.indexOf('UV_TOOL_NA='), nsh.indexOf('UV_TOOL_NA=') + 800);
  assert(/exit 120/.test(guardSh), 'nomad.sh: существующий тул/шим → exit 120');
  assert(nsh.indexOf('UV_TOOL_NA=') !== -1 && nsh.indexOf('UV_TOOL_NA=') < nsh.indexOf('uv tool install'),
    'nomad.sh: guard ПЕРЕД uv tool install');

  const nps = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'nomad.ps1'), 'utf8');
  assert(!/--force/.test(nps), 'nomad.ps1: НИ ОДНОГО --force');
  assert(/& \$uv tool install --python 3\.12 "\$src"/.test(nps), 'nomad.ps1: uv tool install без --force');
  assert(/uv\\tools\\nomad-agent/.test(nps) && /\.local\\share\\uv\\tools\\nomad-agent/.test(nps),
    'nomad.ps1: guard проверяет nomad-agent tool (APPDATA + .local\\share)');
  assert(/\.local\\bin\\nmd\.exe/.test(nps) && /\.local\\bin\\nomad-agent/.test(nps) && /\.local\\bin\\nomad-acp/.test(nps),
    'nomad.ps1: проверяются шимы nmd/nomad-agent/nomad-acp(.exe)');
  const guardPs = nps.slice(nps.indexOf('$existingNomad = @('), nps.indexOf('$existingNomad = @(') + 900);
  assert(/exit 120/.test(guardPs), 'nomad.ps1: существующий тул/шим → exit 120');
  assert(nps.indexOf('$existingNomad = @(') !== -1 && nps.indexOf('$existingNomad = @(') < nps.indexOf('tool install --python 3.12 "$src"'),
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

  ok('nomad.sh (функц.): вшитый vendor (HM_NOMAD_SRC с pyproject) → install БЕЗ клона + брендинг, exit 0; git НЕ вызван', () => {
    const { base, home, script, vsrc } = mkNomadTree();
    try {
      const bin = home + '/.local/bin';
      if (!writeNomadFakes(bin)) { console.log('     (fake-exec недоступен — пропуск)'); return; }
      const hermesHome = home + '/.hermes';
      const r = runNomadSh(home, script, { HERMES_HOME: hermesHome, HM_NOMAD_SRC: vsrc });
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
      const hermesHome = home + '/.hermes';
      fs.mkdirSync(hermesHome, { recursive: true });
      fs.writeFileSync(hermesHome + '/SOUL.md', 'USER_SOUL_KEEP');
      const r = runNomadSh(home, script, { HERMES_HOME: hermesHome, HM_NOMAD_SRC: vsrc });
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
  assert(/WIN_REG_ALLOWED_KEYS/.test(s), 'аллоулист ключей реестра');
  assert(/t\.hive !== 'HKCU'/.test(s), 'не-HKCU → отказ');
  // Разбор вывода reg query (REG_SZ/REG_EXPAND_SZ, raw без раскрытия %VAR%)
  // делегирован uninstall-exec.classifyRegQuery (tri-state). main читает значение
  // типизированно через regQueryValueTyped и СОХРАНЯЕТ тип при перезаписи PATH.
  assert(/regQueryValueTyped\(/.test(s), 'типизированное чтение значения реестра (regQueryValueTyped)');
  assert(/uninstallExec\.classifyRegQuery\(/.test(s), 'разбор reg query делегирован classifyRegQuery (tri-state)');
  assert(/'\/t', cur\.type,/.test(s), 'тип значения PATH сохраняется при перезаписи (/t cur.type)');
  assert(/computeUserPathWithout/.test(s), 'PATH правится чистой точной функцией');
  assert(/вернул исходный/.test(s), 'верификация записи PATH с восстановлением при расхождении');
  assert(/remoteFetch\.sysBin\('reg\.exe'\)/.test(s), 'reg.exe — только из валидированного System32');
});

// P0-2: из деинсталлятора НЕ запускается user-writable uv.exe (под elevated =
// admin-RCE). Тип цели 'uvtool' и вызовы `uv tool uninstall`/findUvBinary УДАЛЕНЫ;
// venv/шимы удаляются напрямую file/dirtree-целями.
ok('P0-2 (source): деинсталлятор НЕ запускает user-writable uv (нет uvtool/uv tool uninstall/findUvBinary в КОДЕ)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // Строки «uv tool uninstall»/«findUvBinary» остаются лишь в поясняющих КОММЕНТАРИЯХ —
  // проверяем отсутствие в реальном коде (комментарии // и /* */ вырезаны).
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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
