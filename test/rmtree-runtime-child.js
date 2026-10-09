'use strict';
/**
 * Дочерний сценарий теста «снос дерева не идёт по ссылкам» (раздел в test/run-tests.js).
 *
 * Запускается ДВАЖДЫ — системным Node и настоящим Electron (ELECTRON_RUN_AS_NODE=1), потому что с
 * Electron 40 `fs.rmSync(recursive)` реализован в C++ (std::filesystem) и ИДЁТ по junction внутрь,
 * а в Node 20/22 — нет. Печатает один JSON: что осталось от «чужой» цели (victim) в каждом случае.
 *
 * env: HM_COMPAT — путь к src/fs-compat.js, HM_UX — к src/uninstall-exec.js, HM_BASE — пустой
 *      каталог для фикстур, HM_VOLGUID — \\?\Volume{guid}\ диска фикстур (может быть пуст),
 *      HM_UX_OLD — путь к копии uninstall-exec со СТАРЫМ сносом (fs.rmSync) для контроля (может быть пуст).
 *
 * Все фикстуры — во временном каталоге теста. «Цель» (victim) — тоже наша: в ней два файла, и
 * «жива» значит «оба на месте». Случаи, чьё имя начинается с `raw-` или `ctl-`, — КОНТРОЛИ: они
 * показывают, что рантайм/старый код опасен, и сами «безопасными» быть не обязаны.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const compat = require(process.env.HM_COMPAT);
const ux = require(process.env.HM_UX);
const uxOld = process.env.HM_UX_OLD ? require(process.env.HM_UX_OLD) : null;
const base = process.env.HM_BASE;
const volGuid = process.env.HM_VOLGUID || '';
// fs без подмены под .asar (в обычном Node — тот же fs)
const rawFs = (() => { try { return require('original-fs'); } catch (e) { return fs; } })();

const out = {
  runtime: process.versions.electron ? 'electron ' + process.versions.electron : 'node ' + process.version,
  electronMajor: process.versions.electron ? Number(String(process.versions.electron).split('.')[0]) : 0,
  hasNoFollow: typeof compat.removeTreeNoFollow === 'function',
  hasOriginalFs: rawFs !== fs,
  volGuid: !!volGuid,
  cases: {},
};

function mkVictim(dir) {
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'precious.txt'), 'p1');
  fs.writeFileSync(path.join(dir, 'sub', 'precious2.txt'), 'p2');
}
function victimAlive(dir) {
  return fs.existsSync(path.join(dir, 'precious.txt')) && fs.existsSync(path.join(dir, 'sub', 'precious2.txt'));
}
// Настоящий (минимальный, но разбираемый Electron'ом) архив .asar: заголовок-«pickle» + один файл.
// Пишем через rawFs: подменённый fs на пути *.asar открывает архив и держит его (файл потом не удалить).
function writeAsar(file) {
  const content = Buffer.from('hello');
  const hb = Buffer.from(JSON.stringify({ files: { 'a.txt': { size: content.length, offset: '0' } } }));
  const padded = (hb.length + 3) & ~3;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0); headerPickle.writeUInt32LE(hb.length, 4); hb.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0); sizePickle.writeUInt32LE(headerPickle.length, 4);
  rawFs.mkdirSync(path.dirname(file), { recursive: true });
  rawFs.writeFileSync(file, Buffer.concat([sizePickle, headerPickle, content]));
}
// junction «обычная» (то, что делает mklink /J C:\dir) или «через том» (\\?\Volume{guid}\dir): lstat её за
// ссылку не принимает, а ходит через неё как через каталог.
function plant(link, victim, how) {
  if (how === 'volume') {
    const rel = victim.slice(path.parse(victim).root.length);
    const target = volGuid.replace(/\\?$/, '\\') + rel;
    const r = cp.spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('mklink /J (volume) не создал ссылку: ' + (r.stdout || '') + (r.stderr || ''));
  } else {
    fs.symlinkSync(victim, link, 'junction');
  }
}
let seq = 0;
// Дерево с вложенной ссылкой: tree/{a.txt, sub/b.txt, evil -> victim}.
function fixture(how) {
  const dir = path.join(base, 'c' + (++seq));
  const victim = path.join(dir, 'victim');
  const tree = path.join(dir, 'tree');
  mkVictim(victim);
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'a.txt'), 'a');
  fs.writeFileSync(path.join(tree, 'sub', 'b.txt'), 'b');
  plant(path.join(tree, 'evil'), victim, how);
  return { dir, victim, tree };
}
// Один случай: фикстура → действие → что стало с жертвой. Ошибка действия не роняет сценарий.
function run(name, how, fn) {
  const r = { error: null };
  let fx = null;
  try { fx = fixture(how); } catch (e) { r.setupError = String((e && e.message) || e); out.cases[name] = r; return; }
  try { Object.assign(r, fn(fx) || {}); } catch (e) { r.error = String((e && e.code) || (e && e.message) || e); }
  r.victimAlive = victimAlive(fx.victim);
  out.cases[name] = r;
}

const hows = ['junction'].concat(volGuid ? ['volume'] : []);

// --- контроль: «голый» рантаймовый rmSync (ДО install()) ------------------------------------------
const rawRm = fs.rmSync;
for (const how of hows) {
  run('raw-nested-' + how, how, (fx) => { rawRm(fx.tree, { recursive: true, force: true }); return { treeGone: !fs.existsSync(fx.tree) }; });
  // корень удаления — сама ссылка
  run('raw-root-' + how, how, (fx) => {
    const lnk = path.join(fx.dir, 'rootlink');
    plant(lnk, fx.victim, how);
    rawRm(lnk, { recursive: true, force: true });
    return { linkGone: !fs.existsSync(lnk) };
  });
}

// --- removeTreeNoFollow напрямую ------------------------------------------------------------------
for (const how of hows) {
  run('nofollow-nested-' + how, how, (fx) => {
    if (!out.hasNoFollow) throw new Error('removeTreeNoFollow не экспортируется');
    compat.removeTreeNoFollow(fx.tree, { force: false });
    return { treeGone: !fs.existsSync(fx.tree) };
  });
  run('nofollow-root-' + how, how, (fx) => {
    if (!out.hasNoFollow) throw new Error('removeTreeNoFollow не экспортируется');
    const lnk = path.join(fx.dir, 'rootlink');
    plant(lnk, fx.victim, how);
    compat.removeTreeNoFollow(lnk, { force: false });
    return { linkGone: !fs.existsSync(lnk) };
  });
}

// --- настоящий модуль удаления компонентов на «домашнем» каталоге ---------------------------------
// asar: 'valid' | 'invalid' | '' — кладём в дерево Скрепки архив, как у настоящих Electron-приложений.
function uninstallCase(mod, how, gated, asar) {
  return (fx) => {
    const home = path.join(fx.dir, 'home');
    const target = path.join(home, 'AppData', 'Local', 'Programs', 'ClaudeMascot');
    fs.mkdirSync(path.join(target, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(target, 'claude-mascot.exe'), 'x');
    if (asar === 'valid') writeAsar(path.join(target, 'resources', 'app.asar'));
    else if (asar === 'invalid') rawFs.writeFileSync(path.join(target, 'resources', 'app.asar'), 'not an archive');
    else fs.writeFileSync(path.join(target, 'resources', 'data.bin'), 'y');
    if (gated) fs.writeFileSync(path.join(target, '.hm-owner'), 'ours');
    plant(path.join(target, 'evil'), fx.victim, how);
    const opts = { home, platform: process.platform };
    // захват в карантин (rename) идёт без повторов и под нагрузкой транзиентно падает EPERM (антивирус держит
    // только что созданные файлы) — прежнее поведение, не предмет сценария: повторяем сам вызов
    let r = null;
    for (let i = 0; i < 8; i++) {
      r = gated ? mod.removeDirTreeGated(target, opts, '.hm-owner') : mod.removeDirTree(target, opts);
      if (!/карантин \(rename\): (EPERM|EACCES|EBUSY)|не удалось захватить дерево в карантин/.test(r.message || '')) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    const left = fs.readdirSync(path.dirname(target)).filter((n) => n.indexOf('.hm-quar.') === 0);
    return { status: r.status, message: r.message, targetGone: !fs.existsSync(target), quarantineLeft: left.length };
  };
}
for (const how of hows) {
  run('uninstall-removeDirTree-' + how, how, uninstallCase(ux, how, false, ''));
  run('uninstall-removeDirTreeGated-' + how, how, uninstallCase(ux, how, true, ''));
}
// .asar внутри сносимого дерева: подменённый fs принимал бы его за каталог / держал открытым
run('asar-valid-removeDirTree', 'junction', uninstallCase(ux, 'junction', false, 'valid'));
run('asar-valid-removeDirTreeGated', 'junction', uninstallCase(ux, 'junction', true, 'valid'));
run('asar-invalid-removeDirTree', 'junction', uninstallCase(ux, 'junction', false, 'invalid'));
// КОНТРОЛЬ: прежний снос (fs.rmSync) в uninstall-exec — на Electron 40+ стирает цель
if (uxOld) {
  for (const how of hows) run('ctl-old-removeDirTree-' + how, how, uninstallCase(uxOld, how, false, ''));
}

// --- removeTreeNoFollow с .asar внутри: рабочий fs и КОНТРОЛЬ с подменённым ------------------------
run('asar-nofollow', 'junction', (fx) => {
  writeAsar(path.join(fx.tree, 'res', 'app.asar'));
  compat.removeTreeNoFollow(fx.tree, { force: false });
  return { treeGone: !fs.existsSync(fx.tree) };
});
run('ctl-asar-patched-fs', 'junction', (fx) => {
  writeAsar(path.join(fx.tree, 'res', 'app.asar'));
  compat.removeTreeNoFollow(fx.tree, { force: false, fs });      // подменённый fs — так делать НЕЛЬЗЯ
  return { treeGone: !fs.existsSync(fx.tree) };
});

// --- install(): обёрнутый fs.rmSync -----------------------------------------------------------------
const logged = [];
out.installed = compat.install((line) => { logged.push(line); });
for (const how of hows) {
  run('wrapped-nested-' + how, how, (fx) => { fs.rmSync(fx.tree, { recursive: true, force: true }); return { treeGone: !fs.existsSync(fx.tree) }; });
  run('wrapped-root-' + how, how, (fx) => {
    const lnk = path.join(fx.dir, 'rootlink');
    plant(lnk, fx.victim, how);
    fs.rmSync(lnk, { recursive: true, force: true });
    return { linkGone: !fs.existsSync(lnk) };
  });
}
run('wrapped-asar', 'junction', (fx) => {
  writeAsar(path.join(fx.tree, 'res', 'app.asar'));
  fs.rmSync(fx.tree, { recursive: true, force: true });
  return { treeGone: !fs.existsSync(fx.tree) };
});
out.log = logged.slice(0, 20);

process.stdout.write(JSON.stringify(out));
