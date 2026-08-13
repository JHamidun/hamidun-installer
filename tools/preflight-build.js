'use strict';
/* preflight-build.js — ПРЕДПОЛЁТНЫЕ ГЕЙТЫ СБОРКИ (свежесть конфиг-пака + потолок NSIS).
 *
 * ЗАЧЕМ ЭТО ПОЯВИЛОСЬ — две дыры релиза, обе тихие:
 *
 *  1) СТАРЫЙ СНАПШОТ ПАКА. `npm run dist:win` зовёт fetch:config, но собрать можно и
 *     мимо него — `npx electron-builder --win` работает с тем, что лежит в
 *     vendor/config-pack прямо сейчас. Пак живёт своей жизнью и правится из других
 *     сессий: в exe уезжает вчерашний (или месячный) снапшот, и НИКАКОГО следа об
 *     этом в артефакте нет — человек получает конфиг, которого уже нет в репозитории.
 *     Здесь мы сверяем ФАКТИЧЕСКИ вшитый коммит (штамп .hamidun-config-pack.json,
 *     который пишет tools/fetch-config.js) с HEAD того ref'а, что заявлен в config.json.
 *
 *  2) ПОТОЛОК 2 ГиБ. Портабл-exe офлайн-издания собирает 32-битный makensis, который
 *     падает на mmap при размере > 2048 МиБ. Последний собранный артефакт
 *     (release/Hamidun-Setup-Windows.exe) = 1951 МиБ — запас ~5%. Одно обновление
 *     Cursor/VS Code/Python — и сборка ложится, причём НЕ понятной ошибкой размера, а
 *     невнятным падением makensis посреди получасовой упаковки. Здесь мы считаем vendor
 *     ДО сборки и говорим об этом словами.
 *
 * ГДЕ ВЫЗЫВАЕТСЯ:
 *   • tools/before-pack.js — хук electron-builder `beforePack`. Он срабатывает при
 *     ЛЮБОМ способе запуска сборки (npm run dist:win, npx electron-builder, CI) —
 *     именно это делает обход невозможным, а не строчка в npm-скрипте.
 *   • npm run preflight — явный ранний прогон в dist/dist:win (быстрый отказ ДО
 *     получасовой упаковки, а не в её середине).
 *   • tools/release-check.js — как часть общего вердикта перед выкладкой.
 *
 * ЗАПУСК ВРУЧНУЮ:
 *   node tools/preflight-build.js                 обе проверки для win32
 *   node tools/preflight-build.js --platform darwin
 *   node tools/preflight-build.js --skip-config   только размер
 *   node tools/preflight-build.js --skip-size     только свежесть пака
 *   node tools/preflight-build.js --json          машиночитаемо
 *
 * АВАРИЙНЫЕ ВЫКЛЮЧАТЕЛИ (осознанные, каждый печатается в лог сборки):
 *   HM_ALLOW_STALE_CONFIG=1   собрать со старым/непроверяемым снапшотом пака
 *   HM_ALLOW_OFFLINE_BUILD=1  git ls-remote недоступен (нет сети) — считать это warn
 *   HM_ALLOW_OVERSIZE=1       собрать, несмотря на прогноз выше потолка makensis
 * Выключатель НЕ прячет проблему: строка про него уезжает в лог с пометкой ВНИМАНИЕ.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const STAMP_REL = path.join('config-pack', '.hamidun-config-pack.json');

// --- потолок и модель размера ------------------------------------------------
//
// NSIS_LIMIT_BYTES — жёсткий предел 32-битного makensis (mmap файла целиком).
// Модель прогноза: exe ≈ ELECTRON_BASE + vendor_raw × VENDOR_COMPRESSION, где
// vendor_raw — сумма байт vendor/ ПОСЛЕ фильтра build.win.extraResources.
//
// КАЛИБРОВКА (числа проверяемые, не выдуманные):
//   • release/Hamidun-Setup-Windows.exe = 2 045 972 046 Б = 1951,2 МиБ (сборка 30.07);
//   • vendor на тот момент (текущий минус всё, что записано ПОСЛЕ mtime артефакта)
//     ≥ 1915,0 МиБ — это НИЖНЯЯ оценка, значит выведенный из неё коэффициент —
//     ВЕРХНЯЯ оценка, т.е. модель ошибается в безопасную сторону (перестраховка);
//   • отсюда при ELECTRON_BASE = 90 МиБ: k = (1951,2 − 90) / 1915,0 = 0,972.
//     Берём 0,98 — vendor почти целиком уже сжат (exe/msi/vsix/whl/tgz), дефлейт по
//     нему даёт единицы процентов.
//   • ELECTRON_BASE = 90 МиБ — оболочка Electron в сжатом виде с запасом: lite-exe
//     (release/Hamidun-Setup-Windows-Lite.exe) = 83,8 МиБ, и в нём УЖЕ лежит сжатый
//     uv (~28 МиБ) + курс, т.е. чистая оболочка меньше 60 МиБ.
//
// Прогноз — ОЦЕНКА, и он так и печатается. Если она разойдётся с реальностью,
// перекалибруй по свежему артефакту (числа выше — ровно те, что для этого нужны).
const MIB = 1024 * 1024;
const NSIS_LIMIT_BYTES = 2048 * MIB;
const ELECTRON_BASE_BYTES = 90 * MIB;
const VENDOR_COMPRESSION = 0.98;
const WARN_RATIO = 0.90; // ≥90% потолка — предупреждение (следующее обновление уронит)

function mib(b) { return (b / MIB).toFixed(1) + ' МиБ'; }

// --- glob-фильтр extraResources ---------------------------------------------
// Читаем ФАКТИЧЕСКИЙ фильтр из package.json (а не копию констант): изменили список
// исключений в сборке — проверка размера меняется вместе с ней, без правок здесь.
function globToRe(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        // '**/' — ноль и более сегментов; '**' в конце — что угодно, включая '/'
        if (pat[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; } else { out += '.*'; i += 1; }
      } else { out += '[^/]*'; }
    } else if (c === '?') { out += '[^/]';
    } else { out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
  }
  return new RegExp('^' + out + '$');
}

function makeFilter(patterns) {
  const pos = [];
  const neg = [];
  for (const p of (patterns || [])) {
    if (typeof p !== 'string' || !p) continue;
    if (p[0] === '!') neg.push(globToRe(p.slice(1)));
    else pos.push(globToRe(p));
  }
  if (!pos.length) pos.push(globToRe('**/*'));
  return (rel) => pos.some((re) => re.test(rel)) && !neg.some((re) => re.test(rel));
}

function winVendorFilter(pkg) {
  const list = (((pkg || {}).build || {}).win || {}).extraResources || [];
  const rec = list.find((r) => r && r.to === 'vendor');
  return { filter: makeFilter(rec && rec.filter), patterns: (rec && rec.filter) || ['**/*'] };
}

// Сумма байт vendor/, которые РЕАЛЬНО уедут в exe (с учётом фильтра), + разбивка
// по верхнему уровню — чтобы в отчёте было видно, где именно лежит вес.
function packedVendorBytes(opts) {
  opts = opts || {};
  const vendorDir = opts.vendorDir || VENDOR;
  const pkg = opts.pkg || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { filter, patterns } = winVendorFilter(pkg);
  const perTop = {};
  const excluded = {};
  let bytes = 0;
  let excludedBytes = 0;
  if (!fs.existsSync(vendorDir)) return { exists: false, bytes: 0, perTop, excluded, excludedBytes, patterns };
  const walk = (abs, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const a = path.join(abs, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(a, r); continue; }
      if (!e.isFile()) continue;
      let sz = 0;
      try { sz = fs.statSync(a).size; } catch (err) { continue; }
      const top = r.split('/')[0];
      if (filter(r)) { bytes += sz; perTop[top] = (perTop[top] || 0) + sz; }
      else { excludedBytes += sz; excluded[top] = (excluded[top] || 0) + sz; }
    }
  };
  walk(vendorDir, '');
  return { exists: true, bytes, perTop, excluded, excludedBytes, patterns };
}

// Чистая (без диска и сети) оценка — её и дёргают тесты.
function projectExeSize(vendorBytes) {
  const projected = ELECTRON_BASE_BYTES + Math.round(vendorBytes * VENDOR_COMPRESSION);
  return {
    vendorBytes,
    projected,
    limit: NSIS_LIMIT_BYTES,
    ratio: projected / NSIS_LIMIT_BYTES,
    over: projected > NSIS_LIMIT_BYTES,
    warn: projected > NSIS_LIMIT_BYTES * WARN_RATIO,
    headroom: NSIS_LIMIT_BYTES - projected,
  };
}

function checkNsisLimit(opts) {
  opts = opts || {};
  const measured = opts.measured || packedVendorBytes(opts);
  const lines = [];
  if (!measured.exists) {
    return { id: 'nsis-limit', level: 'skip', lines: ['vendor/ отсутствует — размер офлайн-сборки мерить не с чего.'], measured };
  }
  const p = projectExeSize(measured.bytes);
  const tops = Object.entries(measured.perTop).sort((a, b) => b[1] - a[1]);
  lines.push(`vendor в сборке (после фильтра ${JSON.stringify(measured.patterns)}): ${mib(measured.bytes)}`);
  for (const [k, v] of tops) lines.push(`    ${mib(v).padStart(12)}  vendor/${k}`);
  if (measured.excludedBytes) {
    lines.push(`исключено фильтром: ${mib(measured.excludedBytes)} (${Object.keys(measured.excluded).join(', ')})`);
  }
  lines.push(`прогноз portable-exe ≈ ${mib(ELECTRON_BASE_BYTES)} (Electron) + ${measured.bytes ? (VENDOR_COMPRESSION * 100).toFixed(0) : 0}% × vendor = ${mib(p.projected)}`);
  lines.push(`потолок 32-битного makensis: ${mib(p.limit)}; занято ${(p.ratio * 100).toFixed(1)}%, запас ${mib(p.headroom)}`);
  let level = 'ok';
  if (p.over) {
    level = 'fail';
    lines.push('ПРОГНОЗ ВЫШЕ ПОТОЛКА: makensis упадёт на mmap в середине упаковки (ошибка будет невнятной).');
    lines.push('Что резать — см. tools/release-check.js и раздел «чем ужать» в отчёте; самый крупный');
    lines.push('кандидат обычно vendor/npm-cache: `npm install --cache` ДОБАВЛЯЕТ версии, не удаляя старые.');
    lines.push('Первым делом: npm run prune:cache — снимает накопленные версии, ничего нужного не трогая');
    lines.push('(что именно уйдёт: npm run prune:cache -- --dry-run). Проверка ниже покажет, есть ли что снимать.');
  } else if (p.warn) {
    level = 'warn';
    lines.push(`Осталось меньше ${((1 - WARN_RATIO) * 100).toFixed(0)}% запаса — следующее обновление Cursor/VS Code/Python уронит сборку.`);
  }
  if (level === 'fail' && process.env.HM_ALLOW_OVERSIZE === '1') {
    level = 'warn';
    lines.push('ВНИМАНИЕ: HM_ALLOW_OVERSIZE=1 — гейт размера понижен до предупреждения осознанно.');
  }
  return { id: 'nsis-limit', level, lines, measured, projection: p };
}

// --- накопление версий в офлайн-кеше npm -------------------------------------
//
// ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ГЕЙТ, А НЕ СТРОЧКА В ОТЧЁТЕ О РАЗМЕРЕ.
// Гейт размера ловит проблему в момент, когда собирать УЖЕ нельзя. Накопление же
// видно задолго до потолка: `npm install --cache` добавляет версии и не удаляет
// старые, поэтому кеш растёт на ~80 МиБ с каждым релизом Claude Code молча. К
// 11.08.2026 накопилось 13 версий (1005 МиБ вместо 84) и прогноз exe ушёл на 112%
// от потолка makensis. Здесь мы говорим об этом на 2-3 версии раньше и сразу даём
// команду чистки — чтобы человеку не пришлось выяснять, что именно резать.
// Уровень всегда warn: лишние версии не ломают сборку сами по себе, они её
// приближают к потолку, а отказ по размеру выносит гейт nsis-limit.
function checkNpmCacheDupes(opts) {
  opts = opts || {};
  const lines = [];
  const cacheDir = opts.npmCacheDir || path.join(opts.vendorDir || VENDOR, 'npm-cache');
  let prune;
  try { prune = require('./prune-npm-cache.js'); }
  catch (e) { return { id: 'npm-cache-dupes', level: 'skip', lines: ['tools/prune-npm-cache.js недоступен — накопление версий не проверено.'] }; }
  let dupes, cache;
  try {
    cache = prune.readCache(cacheDir);
    if (!cache.exists) return { id: 'npm-cache-dupes', level: 'skip', lines: ['vendor/npm-cache отсутствует — проверять нечего.'] };
    dupes = prune.duplicateVersions(cache);
  } catch (e) {
    return { id: 'npm-cache-dupes', level: 'skip', lines: ['кеш не разобрался (' + String((e && e.message) || e) + ') — накопление версий не проверено.'] };
  }
  if (!dupes.length) {
    return { id: 'npm-cache-dupes', level: 'ok', lines: ['в офлайн-кеше npm по одной версии каждого пакета — лишнего веса нет.'] };
  }
  let waste = 0;
  for (const d of dupes) {
    const per = d.bytes / d.count;
    waste += d.bytes - per;   // оценка: всё, кроме одной версии
    lines.push(`${d.name}: ${d.count} версий в кеше (${d.versions.join(', ')}) = ${mib(d.bytes)}`);
  }
  lines.push(`лишнего примерно ${mib(waste)} — это чистый балласт в exe: офлайн-установка берёт ОДНУ версию.`);
  lines.push('Причина не в разовой ошибке: `npm install --cache` ДОБАВЛЯЕТ версии и никогда не удаляет старые,');
  lines.push('поэтому каждый релиз Claude Code оставляет предыдущий архив навсегда.');
  lines.push('Почини: npm run prune:cache        (посмотреть план, ничего не трогая: npm run prune:cache -- --dry-run)');
  return { id: 'npm-cache-dupes', level: 'warn', lines, dupes, wasteBytes: waste };
}

// --- свежесть вшитого конфиг-пака -------------------------------------------

function readConfigPackStamp(vendorDir) {
  const p = path.join(vendorDir || VENDOR, STAMP_REL);
  try { return { ok: true, path: p, stamp: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, path: p, error: String((e && e.message) || e) }; }
}

function isSha(s) { return /^[0-9a-f]{40}$/i.test(String(s || '')); }

// ЧИСТОЕ ЯДРО ГЕЙТА (ни диска, ни сети) — ровно его и проверяют тесты.
//   cfg        — содержимое config.json (нужны configRepoUrl / configRepoRef|Branch)
//   stamp      — содержимое vendor/config-pack/.hamidun-config-pack.json (или null)
//   remoteHead — { ok:true, sha } | { ok:false, error } — результат git ls-remote
//   envRef     — значение HM_CONFIG_REF, если сборка пинится переменной
function evaluateConfigFreshness(input) {
  const cfg = input.cfg || {};
  const stamp = input.stamp;
  const remoteHead = input.remoteHead || null;
  const allowStale = input.allowStale === true;
  const allowOffline = input.allowOffline === true;
  const wantRef = input.envRef || cfg.configRepoRef || cfg.configRepoBranch || 'main';
  const wantUrl = cfg.configRepoUrl || 'https://github.com/JHamidun/claude-code-config-pack';
  const lines = [];
  const soften = (level) => (level === 'fail' && allowStale
    ? (lines.push('ВНИМАНИЕ: HM_ALLOW_STALE_CONFIG=1 — гейт свежести пака понижен до предупреждения осознанно.'), 'warn')
    : level);

  if (!stamp) {
    lines.push('в vendor/config-pack НЕТ штампа .hamidun-config-pack.json — значит пак либо не выкачан,');
    lines.push('либо положен туда руками. Что именно уедет в exe — недоказуемо. Почини: npm run fetch:config');
    return { id: 'config-fresh', level: soften('fail'), lines, wantRef, wantUrl };
  }
  lines.push(`вшито: ${stamp.repo}#${stamp.ref} @ ${String(stamp.commit || '').slice(0, 12)} (${stamp.committedAt || '—'}), скиллов: ${stamp.skills}`);

  if (!isSha(stamp.commit)) {
    lines.push('в штампе нет валидного sha коммита — снапшот не идентифицируется. Почини: npm run fetch:config');
    return { id: 'config-fresh', level: soften('fail'), lines, wantRef, wantUrl };
  }
  if (String(stamp.repo || '') !== String(wantUrl)) {
    lines.push(`репозиторий в штампе (${stamp.repo}) НЕ совпадает с config.json (${wantUrl}) — в exe уедет чужой пак.`);
    lines.push('Почини: npm run fetch:config');
    return { id: 'config-fresh', level: soften('fail'), lines, wantRef, wantUrl };
  }
  // Пин по SHA: сверять с HEAD не нужно и НЕЛЬЗЯ — пин на то и пин.
  if (isSha(wantRef)) {
    if (String(stamp.commit).toLowerCase() !== String(wantRef).toLowerCase()) {
      lines.push(`сборка пинится на ${String(wantRef).slice(0, 12)}, а вшит ${String(stamp.commit).slice(0, 12)}.`);
      lines.push('Почини: npm run fetch:config (с тем же HM_CONFIG_REF)');
      return { id: 'config-fresh', level: soften('fail'), lines, wantRef, wantUrl };
    }
    lines.push(`ref закреплён по sha (${String(wantRef).slice(0, 12)}) и совпадает — сверка с HEAD не нужна.`);
    return { id: 'config-fresh', level: 'ok', lines, wantRef, wantUrl };
  }
  if (String(stamp.ref || '') !== String(wantRef)) {
    lines.push(`ref в штампе (${stamp.ref}) НЕ совпадает с заявленным (${wantRef}) — вшита не та ветка/тег.`);
    lines.push('Почини: npm run fetch:config');
    return { id: 'config-fresh', level: soften('fail'), lines, wantRef, wantUrl };
  }
  if (!remoteHead || !remoteHead.ok) {
    const why = (remoteHead && remoteHead.error) || 'git ls-remote не выполнялся';
    lines.push(`HEAD ветки «${wantRef}» узнать не удалось (${why}) — свежесть снапшота НЕДОКАЗУЕМА.`);
    if (allowOffline) {
      lines.push('ВНИМАНИЕ: HM_ALLOW_OFFLINE_BUILD=1 — собираем без сверки с origin осознанно.');
      return { id: 'config-fresh', level: 'warn', lines, wantRef, wantUrl };
    }
    lines.push('Дай сети дойти до origin, либо собери с HM_ALLOW_OFFLINE_BUILD=1, если это осознанно.');
    return { id: 'config-fresh', level: soften('fail'), lines, wantRef, wantUrl };
  }
  if (String(remoteHead.sha).toLowerCase() !== String(stamp.commit).toLowerCase()) {
    lines.push(`origin/${wantRef} = ${String(remoteHead.sha).slice(0, 12)}, а вшит ${String(stamp.commit).slice(0, 12)} — СНАПШОТ УСТАРЕЛ.`);
    lines.push('Почини: npm run fetch:config  (или закрепи осознанно: HM_CONFIG_REF=' + stamp.commit + ')');
    return { id: 'config-fresh', level: soften('fail'), lines, wantRef, wantUrl };
  }
  lines.push(`origin/${wantRef} совпадает со вшитым коммитом — снапшот свежий.`);
  return { id: 'config-fresh', level: 'ok', lines, wantRef, wantUrl };
}

function gitLsRemote(url, ref) {
  try {
    const out = String(execFileSync('git', ['ls-remote', url, ref], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' }),
    }));
    const line = out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (!line) return { ok: false, error: `ref «${ref}» не найден в ${url}` };
    return { ok: true, sha: line.split(/\s+/)[0] };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).split('\n')[0] };
  }
}

function checkConfigFresh(opts) {
  opts = opts || {};
  const cfg = opts.cfg || JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const st = readConfigPackStamp(opts.vendorDir);
  const envRef = process.env.HM_CONFIG_REF || '';
  const wantRef = envRef || cfg.configRepoRef || cfg.configRepoBranch || 'main';
  const wantUrl = cfg.configRepoUrl || 'https://github.com/JHamidun/claude-code-config-pack';
  let remoteHead = null;
  if (st.ok && !isSha(wantRef) && opts.network !== false) remoteHead = gitLsRemote(wantUrl, wantRef);
  return evaluateConfigFreshness({
    cfg, stamp: st.ok ? st.stamp : null, remoteHead, envRef,
    allowStale: process.env.HM_ALLOW_STALE_CONFIG === '1',
    allowOffline: process.env.HM_ALLOW_OFFLINE_BUILD === '1',
  });
}

// --- прогон ------------------------------------------------------------------

function isLiteBuild() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).edition === 'lite'; }
  catch (e) { return false; }
}

function runPreflight(opts) {
  opts = opts || {};
  const platform = opts.platform || 'win32';
  const lite = (opts.lite !== undefined) ? opts.lite : isLiteBuild();
  const results = [];
  // В lite конфиг-пак НЕ вшивается (build-lite.js: LITE_KEEP_*), он стримится с S3 —
  // сверять нечего, гейт свежести относится к ОПУБЛИКОВАННОМУ компоненту config
  // (это проверяет tools/release-check.js), а не к содержимому этого артефакта.
  if (!opts.skipConfig && !lite) results.push(checkConfigFresh(opts));
  // Потолок makensis — про офлайн-издание Windows. У lite свой size-assert
  // (build-lite.js), у mac — dmg без 32-битного упаковщика.
  if (!opts.skipSize && !lite && platform === 'win32') results.push(checkNsisLimit(opts));
  // Накопление версий в кеше — про ОБЕ офлайн-платформы (на маке в кеше лежат ещё и
  // архивы обеих darwin-арх, т.е. растёт он там вдвое быстрее). Только не в lite:
  // там npm-кеш не вшивается, а стримится с S3.
  if (!opts.skipSize && !lite) results.push(checkNpmCacheDupes(opts));
  const worst = results.some((r) => r.level === 'fail') ? 'fail'
    : results.some((r) => r.level === 'warn') ? 'warn' : 'ok';
  return { platform, lite, results, level: worst };
}

function printPreflight(rep) {
  const TAG = { ok: 'OK  ', warn: 'ВНИМАНИЕ', fail: 'СТОП', skip: 'ПРОПУСК' };
  console.log(`[preflight] платформа ${rep.platform}${rep.lite ? ' (lite-издание — гейты офлайн-сборки не применяются)' : ''}`);
  for (const r of rep.results) {
    console.log(`[preflight] ${TAG[r.level] || r.level} — ${r.id}`);
    for (const l of r.lines) console.log('            ' + l);
  }
  if (!rep.results.length) console.log('[preflight] проверять нечего для этого издания.');
  else if (rep.level === 'ok') console.log('[preflight] всё чисто — можно собирать.');
}

function main(argv) {
  const args = argv.slice(2);
  const platform = (() => {
    const i = args.indexOf('--platform');
    return i !== -1 ? args[i + 1] : (args.includes('--mac') ? 'darwin' : 'win32');
  })();
  const rep = runPreflight({
    platform,
    skipConfig: args.includes('--skip-config'),
    skipSize: args.includes('--skip-size'),
    network: !args.includes('--offline'),
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify(rep, null, 2));
  } else {
    printPreflight(rep);
  }
  return rep.level === 'fail' ? 1 : 0;
}

module.exports = {
  NSIS_LIMIT_BYTES, ELECTRON_BASE_BYTES, VENDOR_COMPRESSION, WARN_RATIO,
  globToRe, makeFilter, winVendorFilter, packedVendorBytes, projectExeSize, checkNsisLimit,
  checkNpmCacheDupes,
  readConfigPackStamp, evaluateConfigFreshness, gitLsRemote, checkConfigFresh,
  runPreflight, printPreflight, mib,
};

if (require.main === module) process.exit(main(process.argv));
