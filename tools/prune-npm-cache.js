'use strict';
/* prune-npm-cache.js — ЧИСТКА vendor/npm-cache ОТ УСТАРЕВШИХ ВЕРСИЙ ПАКЕТОВ.
 *
 * ЗАЧЕМ ЭТО ПОЯВИЛОСЬ.
 *   tools/fetch-vendor.ps1 и tools/fetch-vendor-mac.sh наполняют офлайн-кеш командой
 *   `npm install ... --cache <dir>`. Эта команда ДОБАВЛЯЕТ версии в кеш и НИКОГДА не
 *   удаляет старые. Каждый релиз Claude Code оставляет предыдущий архив (~80 МиБ)
 *   в кеше навсегда. К 11.08.2026 в кеше лежало 13 версий claude-code-win32-x64
 *   (2.1.183 … 2.1.220) = 1005 МиБ вместо 84 МиБ, и прогноз portable-exe ушёл на
 *   112% от потолка 32-битного makensis (2048 МиБ) — офлайн-сборка Windows перестала
 *   собираться, причём падением на mmap посреди упаковки, без внятной ошибки.
 *   Разовая чистка лечит симптом: без этого шага через 5-6 релизов будет то же самое.
 *
 * ЧТО ИМЕННО УДАЛЯЕТСЯ.
 *   Только АРХИВЫ (.tgz) тех версий, до которых npm при офлайн-установке дотянуться
 *   не может. Packument'ы (ответы реестра с метаданными) НЕ трогаются никогда —
 *   они весят единицы МиБ и нужны arborist'у для резолва optionalDependencies, в том
 *   числе для ЧУЖИХ платформ.
 *
 * КАК ВЫЧИСЛЯЕТСЯ «НУЖНАЯ ВЕРСИЯ» (важно: НЕ «самая новая в кеше»).
 *   Установка идёт без пина: `npm install -g @anthropic-ai/claude-code --offline --cache`.
 *   Значит npm берёт dist-tags.latest из ЗАКЕШИРОВАННОГО packument'а, а версии
 *   платформенных пакетов — из optionalDependencies этой версии (они пиновые, точные).
 *   Ровно это здесь и воспроизводится, чтобы KEEP совпадал с тем, что реально поставится.
 *
 *   ПОЧЕМУ НЕ ЗАШИТ win32-x64. На macOS нужный архив — darwin-arm64 И darwin-x64,
 *   и прунер, зашитый на win32-x64, вычистил бы там ровно то единственное, что нужно.
 *   Поэтому набор платформ берётся из optionalDependencies, а не из констант.
 *
 * ПОРЯДОК УДАЛЕНИЯ — НЕ ДЕТАЛЬ РЕАЛИЗАЦИИ, А ГАРАНТИЯ БЕЗОПАСНОСТИ.
 *   В cacache нет обратной ссылки «блоб → индекс»: контент адресуется хешем. Поэтому
 *     • снести строку индекса, оставив блоб — БЕЗВРЕДНО (блоб станет висячим, GC уберёт);
 *     • снести блоб, оставив строку — ХУЖЕ ВСЕГО: npm --offline найдёт запись, полезет
 *       за содержимым и упадёт с ENOENT/EINTEGRITY уже НА МАШИНЕ ПОЛЬЗОВАТЕЛЯ.
 *       Плюс scripts/macos/_lib.sh:hm_npm_cache_has_tarball проверяет наличие архива
 *       ГРЕПОМ ПО index-v5 — осиротевшая строка заставит его соврать «офлайн-копия есть»,
 *       и claude.sh уйдёт в офлайн-ветку вместо честного онлайн-фолбэка.
 *   Здесь всегда: сначала строка индекса, потом блоб. И только после этого — GC
 *   висячих блобов (то же, что делает `npm cache verify`, но детерминированно).
 *
 * ЗАПУСК:
 *   node tools/prune-npm-cache.js                 почистить vendor/npm-cache
 *   node tools/prune-npm-cache.js --dry-run       показать план, ничего не трогая
 *   node tools/prune-npm-cache.js --cache <путь>  другой каталог кеша
 *   node tools/prune-npm-cache.js --keep pkg@ver  оставить дополнительную версию
 *   node tools/prune-npm-cache.js --json          машиночитаемо
 *   npm run prune:cache        /  npm run prune:cache -- --dry-run
 *
 * ОТКАТ: чистка ОБРАТИМА при наличии сети — `npm run fetch:vendor` заново скачает
 * то, что нужно. Удаляются только те версии, которые fetch:vendor и так не запросит.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CACHE = path.join(ROOT, 'vendor', 'npm-cache');
const ROOT_PKG = '@anthropic-ai/claude-code';
const MIB = 1024 * 1024;

function mib(b) { return (b / MIB).toFixed(1) + ' МиБ'; }

function walk(dir, out) {
  out = out || [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// integrity ('sha512-<base64>') → путь блоба в content-v2 (та же схема, что у cacache).
function blobPath(conRoot, integrity) {
  if (!integrity || typeof integrity !== 'string') return null;
  const first = String(integrity).split(/\s+/)[0];
  const i = first.indexOf('-');
  if (i < 0) return null;
  const algo = first.slice(0, i);
  let hex;
  try { hex = Buffer.from(first.slice(i + 1), 'base64').toString('hex'); } catch (e) { return null; }
  if (hex.length < 5) return null;
  return path.join(conRoot, algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

// Ключ архива в cacache всегда вида '<...>/<имя-пакета>/-/<имя-без-scope>-<версия>.tgz'.
// Ключ packument'а такого хвоста НЕ содержит — на этом и держится различение.
function parseTarballKey(key) {
  const m = /^(?:.*?)https?:\/\/[^/]+\/((?:@[^/]+\/)?[^/]+)\/-\/([^/]+)\.tgz$/.exec(String(key || ''));
  if (!m) return null;
  const name = decodeURIComponent(m[1]);
  const unscoped = name.slice(name.lastIndexOf('/') + 1);
  const file = m[2];
  if (file.slice(0, unscoped.length + 1) !== unscoped + '-') return null;
  return { name, version: file.slice(unscoped.length + 1) };
}

// Ключ packument'а: '<...>/<имя>' (scope закодирован как %2f).
function parsePackumentKey(key) {
  const m = /^(?:.*?)https?:\/\/[^/]+\/([^/?]+)$/.exec(String(key || ''));
  if (!m) return null;
  const name = decodeURIComponent(m[1]);
  if (!name || name.indexOf('.tgz') !== -1) return null;
  return { name };
}

function cmpSemver(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  const preA = String(a).indexOf('-') !== -1, preB = String(b).indexOf('-') !== -1;
  if (preA !== preB) return preA ? -1 : 1;   // релиз старше пререлиза
  return String(a).localeCompare(String(b));
}

/* Полный разбор кеша. Возвращает всё, что нужно и прунеру, и предполётной проверке —
 * одна реализация, чтобы гейт и чистка не разъехались в трактовке того же кеша. */
function readCache(cacheDir) {
  const idxRoot = path.join(cacheDir, '_cacache', 'index-v5');
  const conRoot = path.join(cacheDir, '_cacache', 'content-v2');
  const res = {
    cacheDir, idxRoot, conRoot,
    exists: fs.existsSync(idxRoot),
    entries: [],       // { file, lineIdx, raw, key, integrity, size, tarball, packument }
    tarballs: {},      // имя пакета → { версия → [entry] }
    packuments: {},    // имя пакета → entry (последняя строка)
  };
  if (!res.exists) return res;
  for (const file of walk(idxRoot)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    const lines = text.split('\n');
    lines.forEach((raw, lineIdx) => {
      const t = raw.indexOf('\t');
      if (t < 0) return;
      let j;
      try { j = JSON.parse(raw.slice(t + 1)); } catch (e) { return; }
      if (!j || !j.key) return;
      const e = { file, lineIdx, raw, key: j.key, integrity: j.integrity, size: j.size || 0 };
      const tb = parseTarballKey(j.key);
      if (tb) {
        e.tarball = tb;
        (res.tarballs[tb.name] = res.tarballs[tb.name] || {});
        (res.tarballs[tb.name][tb.version] = res.tarballs[tb.name][tb.version] || []).push(e);
      } else {
        const pk = parsePackumentKey(j.key);
        if (pk) { e.packument = pk; res.packuments[pk.name] = e; }
      }
      res.entries.push(e);
    });
  }
  return res;
}

// Пакеты, у которых в кеше лежит больше одной версии АРХИВА. Для предполётного гейта.
function duplicateVersions(cache) {
  const out = [];
  for (const name of Object.keys(cache.tarballs)) {
    const versions = Object.keys(cache.tarballs[name]).sort(cmpSemver);
    if (versions.length > 1) {
      let bytes = 0;
      for (const v of versions) for (const e of cache.tarballs[name][v]) bytes += e.size;
      out.push({ name, versions, count: versions.length, bytes });
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/* Какие версии оставляем.
 * Источник истины — packument корневого пакета: dist-tags.latest + optionalDependencies
 * ЭТОЙ версии. Именно так резолвит `npm install --offline` без пина.
 * Страховка: если версия из dist-tags в кеше архивом НЕ лежит (метаданные обновились,
 * а архив не докачался), опускаемся до самой новой версии, которая в кеше ЕСТЬ, и
 * говорим об этом вслух — молча удалять единственную рабочую версию нельзя. */
function resolveKeep(cache, opts) {
  opts = opts || {};
  const notes = [];
  const keep = {};                       // имя пакета → Set версий
  const add = (name, ver) => { (keep[name] = keep[name] || new Set()).add(String(ver)); };

  for (const spec of (opts.keepExtra || [])) {
    const at = String(spec).lastIndexOf('@');
    if (at > 0) { add(spec.slice(0, at), spec.slice(at + 1)); notes.push(`--keep: ${spec}`); }
  }

  const rootPack = cache.packuments[ROOT_PKG];
  const cachedRootVersions = Object.keys(cache.tarballs[ROOT_PKG] || {}).sort(cmpSemver);
  let rootVersion = null;
  let doc = null;

  if (rootPack) {
    const bp = blobPath(cache.conRoot, rootPack.integrity);
    if (bp && fs.existsSync(bp)) {
      try { doc = JSON.parse(fs.readFileSync(bp, 'utf8')); } catch (e) { doc = null; }
    }
  }
  if (doc && doc['dist-tags'] && doc['dist-tags'].latest) {
    const tagged = String(doc['dist-tags'].latest);
    if (cachedRootVersions.indexOf(tagged) !== -1) {
      rootVersion = tagged;
      notes.push(`нужная версия ${ROOT_PKG} = ${rootVersion} (dist-tags.latest из закешированного packument'а — её и поставит npm --offline)`);
    } else if (cachedRootVersions.length) {
      rootVersion = cachedRootVersions[cachedRootVersions.length - 1];
      notes.push(`ВНИМАНИЕ: dist-tags.latest = ${tagged}, но её архива в кеше НЕТ. Оставляю самую новую из имеющихся: ${rootVersion}.`);
      notes.push('Это значит, что метаданные в кеше новее архивов — офлайн-установка выберет ' + tagged + ' и упадёт. Почини: npm run fetch:vendor');
    }
  } else if (cachedRootVersions.length) {
    rootVersion = cachedRootVersions[cachedRootVersions.length - 1];
    notes.push(`packument ${ROOT_PKG} не прочитан — беру самую новую версию из кеша: ${rootVersion}`);
  }

  if (rootVersion) {
    add(ROOT_PKG, rootVersion);
    // Платформенные пакеты: версии берём из optionalDependencies КОРНЕВОЙ версии —
    // они точные, и это ровно то, что запросит arborist на любой платформе.
    let optDeps = null;
    if (doc && doc.versions && doc.versions[rootVersion]) optDeps = doc.versions[rootVersion].optionalDependencies;
    if (optDeps && typeof optDeps === 'object') {
      for (const dep of Object.keys(optDeps)) add(dep, optDeps[dep]);
      notes.push(`платформенные пакеты закреплены по optionalDependencies@${rootVersion} (${Object.keys(optDeps).length} шт., все платформы — win/mac/linux)`);
    } else {
      // Без optionalDependencies версию платформенных пакетов не доказать —
      // консервативно оставляем ту же, что у корня, плюс самую новую из имеющихся.
      notes.push('optionalDependencies корневой версии не прочитаны — платформенные пакеты оставляю по совпадению версии с корнем.');
      for (const name of Object.keys(cache.tarballs)) {
        if (name === ROOT_PKG) continue;
        if (cache.tarballs[name][rootVersion]) add(name, rootVersion);
      }
    }
  }

  // Пакеты, не связанные с корневым (в этом кеше их нет, но прунер не должен на них
  // спотыкаться): оставляем самую новую версию, ничего не выбрасывая молча.
  for (const name of Object.keys(cache.tarballs)) {
    if (keep[name] && keep[name].size) continue;
    const vs = Object.keys(cache.tarballs[name]).sort(cmpSemver);
    if (!vs.length) continue;
    add(name, vs[vs.length - 1]);
    if (vs.length > 1) notes.push(`${name}: пакет вне дерева ${ROOT_PKG} — оставляю самую новую версию ${vs[vs.length - 1]}`);
  }

  return { keep, rootVersion, notes };
}

/* План чистки + ПРОВЕРКИ БЕЗОПАСНОСТИ.
 * Главная: для каждого пакета, у которого мы что-то удаляем, оставляемая версия
 * обязана присутствовать И записью индекса, И блобом на диске. Иначе — отказ целиком
 * (ничего не трогаем): лучше не почистить, чем оставить кеш, который врёт о своём
 * содержимом установщику на машине пользователя. */
function planPrune(cache, opts) {
  const { keep, rootVersion, notes } = resolveKeep(cache, opts);
  const removeEntries = [];
  const keptEntries = [];
  const blockers = [];
  const perPackage = [];

  for (const name of Object.keys(cache.tarballs).sort()) {
    const versions = Object.keys(cache.tarballs[name]).sort(cmpSemver);
    const keepSet = keep[name] || new Set();
    const drop = versions.filter((v) => !keepSet.has(v));
    const stay = versions.filter((v) => keepSet.has(v));
    let bytes = 0;
    for (const v of drop) for (const e of cache.tarballs[name][v]) bytes += e.size;
    perPackage.push({ name, keep: stay, drop, bytes });

    if (drop.length) {
      if (!stay.length) {
        blockers.push(`${name}: под удаление попали ВСЕ версии (${drop.join(', ')}) — нечего оставить.`);
      }
      for (const v of stay) {
        for (const e of cache.tarballs[name][v]) {
          const bp = blobPath(cache.conRoot, e.integrity);
          if (!bp || !fs.existsSync(bp)) {
            blockers.push(`${name}@${v}: оставляемая версия есть в индексе, но её блоба НЕТ на диске — кеш уже повреждён, чистить нельзя.`);
          }
        }
      }
    }
    for (const v of drop) for (const e of cache.tarballs[name][v]) removeEntries.push(e);
    for (const v of stay) for (const e of cache.tarballs[name][v]) keptEntries.push(e);
  }

  // Блобы под удаление: те, на которые после чистки не сошлётся НИ ОДНА строка индекса
  // (включая packument'ы и висячий контент — устаревшие ревизии метаданных).
  const survivingKeys = new Set();
  const removeSet = new Set(removeEntries);
  for (const e of cache.entries) {
    if (removeSet.has(e)) continue;
    const bp = blobPath(cache.conRoot, e.integrity);
    if (bp) survivingKeys.add(path.resolve(bp));
  }
  const blobsToRemove = [];
  let blobBytes = 0;
  for (const b of walk(cache.conRoot)) {
    const abs = path.resolve(b);
    if (survivingKeys.has(abs)) continue;
    let sz = 0;
    try { sz = fs.statSync(abs).size; } catch (e) { continue; }
    blobsToRemove.push(abs);
    blobBytes += sz;
  }

  return {
    keep, rootVersion, notes, perPackage,
    removeEntries, keptEntries, blockers,
    blobsToRemove, blobBytes,
    indexBytes: removeEntries.reduce((s, e) => s + e.size, 0),
  };
}

// Применение плана. Строки индекса — ПЕРВЫМИ, блобы — вторыми (см. шапку файла).
function applyPrune(cache, plan) {
  const byFile = new Map();
  for (const e of plan.removeEntries) {
    if (!byFile.has(e.file)) byFile.set(e.file, new Set());
    byFile.get(e.file).add(e.lineIdx);
  }
  let filesRewritten = 0, filesDeleted = 0;
  for (const [file, lineIdxs] of byFile) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const keptLines = lines.filter((l, i) => !lineIdxs.has(i));
    const meaningful = keptLines.filter((l) => l.indexOf('\t') !== -1);
    if (!meaningful.length) { fs.unlinkSync(file); filesDeleted++; }
    else { fs.writeFileSync(file, keptLines.join('\n')); filesRewritten++; }
  }
  let blobsDeleted = 0;
  for (const b of plan.blobsToRemove) {
    try { fs.unlinkSync(b); blobsDeleted++; } catch (e) { /* уже нет — не беда */ }
  }
  // Пустые каталоги content-v2/index-v5 после чистки — мусор, но безвредный; убираем.
  const pruneEmptyDirs = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name));
    try { if (!fs.readdirSync(dir).length && dir !== cache.conRoot && dir !== cache.idxRoot) fs.rmdirSync(dir); } catch (e) { /* занят — пропускаем */ }
  };
  pruneEmptyDirs(cache.conRoot);
  pruneEmptyDirs(cache.idxRoot);
  return { filesRewritten, filesDeleted, blobsDeleted };
}

function dirBytes(dir) {
  let b = 0;
  for (const f of walk(dir)) { try { b += fs.statSync(f).size; } catch (e) { /* исчез */ } }
  return b;
}

function main(argv) {
  const args = argv.slice(2);
  const at = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const cacheDir = at('--cache') || DEFAULT_CACHE;
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const asJson = args.includes('--json');
  const keepExtra = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--keep' && args[i + 1]) keepExtra.push(args[++i]);

  const cache = readCache(cacheDir);
  if (!cache.exists) {
    const msg = `[prune-cache] кеша нет: ${path.join(cacheDir, '_cacache', 'index-v5')} — чистить нечего.`;
    console.log(asJson ? JSON.stringify({ ok: true, skipped: true, reason: 'no-cache', cacheDir }) : msg);
    return 0;
  }

  const before = dirBytes(cacheDir);
  const plan = planPrune(cache, { keepExtra });

  if (asJson) {
    console.log(JSON.stringify({
      ok: !plan.blockers.length, dryRun, cacheDir, rootVersion: plan.rootVersion,
      notes: plan.notes, blockers: plan.blockers,
      packages: plan.perPackage.map((p) => ({ name: p.name, keep: p.keep, drop: p.drop, bytes: p.bytes })),
      removeIndexEntries: plan.removeEntries.length, indexBytes: plan.indexBytes,
      removeBlobs: plan.blobsToRemove.length, blobBytes: plan.blobBytes, beforeBytes: before,
    }, null, 2));
    if (plan.blockers.length) return 1;
    if (!dryRun && (plan.removeEntries.length || plan.blobsToRemove.length)) applyPrune(cache, plan);
    return 0;
  }

  console.log(`[prune-cache] кеш: ${cacheDir}`);
  for (const n of plan.notes) console.log('  ' + n);
  for (const p of plan.perPackage) {
    if (!p.drop.length) { console.log(`  = ${p.name}: ${p.keep.join(', ') || '—'} (лишнего нет)`); continue; }
    console.log(`  - ${p.name}: оставляю ${p.keep.join(', ')}; удаляю ${p.drop.length} шт. (${p.drop.join(', ')}) = ${mib(p.bytes)}`);
  }
  if (plan.blockers.length) {
    console.log('[prune-cache] ОТКАЗ — чистка НЕ выполнена, кеш не тронут:');
    for (const b of plan.blockers) console.log('  ! ' + b);
    console.log('  Почини кеш и повтори: npm run fetch:vendor');
    return 1;
  }
  const dangling = plan.blobsToRemove.length - plan.removeEntries.length;
  console.log(`[prune-cache] к удалению: ${plan.removeEntries.length} записей индекса, ${plan.blobsToRemove.length} блобов (${mib(plan.blobBytes)})`);
  if (dangling > 0) console.log(`              из них ${dangling} висячих (устаревшие ревизии packument'ов, на них не ссылается ни одна запись)`);
  if (!plan.removeEntries.length && !plan.blobsToRemove.length) {
    console.log('[prune-cache] кеш уже чистый — делать нечего.');
    return 0;
  }
  if (dryRun) {
    console.log('[prune-cache] --dry-run: ничего не удалено.');
    return 0;
  }
  const applied = applyPrune(cache, plan);
  const after = dirBytes(cacheDir);
  console.log(`[prune-cache] удалено: строк индекса ${plan.removeEntries.length} (файлов переписано ${applied.filesRewritten}, удалено ${applied.filesDeleted}), блобов ${applied.blobsDeleted}`);
  console.log(`[prune-cache] кеш: ${mib(before)} -> ${mib(after)} (освобождено ${mib(before - after)})`);
  console.log('[prune-cache] откат при необходимости: npm run fetch:vendor (скачает заново то, что нужно).');
  return 0;
}

module.exports = {
  ROOT_PKG, DEFAULT_CACHE,
  walk, blobPath, parseTarballKey, parsePackumentKey, cmpSemver,
  readCache, duplicateVersions, resolveKeep, planPrune, applyPrune, dirBytes, mib,
};

if (require.main === module) process.exit(main(process.argv));
