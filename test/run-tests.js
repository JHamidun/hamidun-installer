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
