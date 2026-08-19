'use strict';
/* build-lite.js — сборка ЛЁГКОГО (стриминг с S3) издания Hamidun-Setup.
 *
 *   node tools/build-lite.js          → Windows portable exe (Hamidun-Setup-Windows-Lite.exe)
 *   node tools/build-lite.js --mac    → macOS universal dmg (Hamidun-Setup-Mac-Lite.dmg), НА маке
 *
 * Отличия от офлайн (dist:win / dist:mac):
 *   • config.json: edition:'lite' + offlineEdition:false (main → авто-remote по реестру,
 *     кроме bundled-only uv; vendorBlockInfo не блокирует за неполный vendor);
 *   • vendor-lite/ (ТОЛЬКО uv + course + checksums, ~26МБ win / ~40МБ mac) вместо полного
 *     vendor (2.5ГБ win / 2.7ГБ mac) — иначе extraResources.from=vendor молча вшил бы всё с диска;
 *   • fetch:vendor и fetch:config НЕ запускаются — тяжёлое и конфиг стримятся с S3;
 *   • size-assert итогового артефакта — страховка от случайного вшивания vendor.
 *
 * macOS-специфика — ЧИТАТЬ ДО ПРАВОК:
 *   • vendor в .app НЕ вшивается (у build.mac нет extraResources с vendor, и мы его НЕ
 *     добавляем): нотаризация ругается на неподписанные Mach-O ВНУТРИ вложенных архивов
 *     (.so в .whl — исходная причина выноса; uv-macos-*.tar.gz несёт ровно такие бинари).
 *     vendor едет в dmg РЯДОМ с .app — vendorRoot() (src/main.js) ищет sibling-папку первой.
 *   • Поэтому electron-builder здесь даёт НОТАРИЗОВАННЫЙ .app (release/mac-universal/) и
 *     промежуточный dmg БЕЗ vendor. Финальный shippable dmg (.app + лёгкий vendor + ярлык
 *     Applications) собирает hdiutil в .github/workflows/build-mac-lite.yml — как и офлайн
 *     dmg в build-mac.yml. Своим dmg-contents этого не сделать: computeAssetSize
 *     (dmg-builder) сайзит том ТОЛЬКО под .app (+10%) → лишние файлы дают ENOSPC.
 *   • vendor-lite здесь — стейджинг и вход гейта (из него читается checksums.json),
 *     а также «источник истины» для сборщика dmg, пока не убран в finally.
 *
 * Мутации config.json/package.json — ВРЕМЕННЫЕ: оригиналы восстанавливаются в finally
 * (даже если electron-builder упал), vendor-lite убирается. Тесты видят чистое дерево.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFG = path.join(ROOT, 'config.json');
const PKG = path.join(ROOT, 'package.json');
const VENDOR = path.join(ROOT, 'vendor');
const VENDOR_LITE = path.join(ROOT, 'vendor-lite');

// Что вшивается в lite (bundled-only): uv (P1-A, security-sensitive, мал), курс,
// вшитый checksums.json (второй fail-closed гейт для докачек).
// Шрифт JetBrainsMono НЕ здесь: в lite компонент extension удалённый → HM_VENDOR=staging
// (не bundled vendor-lite), поэтому шрифт едет ВНУТРИ zip extension (publish-vendor.py).
const LITE_KEEP_WIN = [
  ['checksums.json',                    'checksums.json'],
  ['apps/uv',                           'apps/uv'],
  ['course/vibecoding-course.zip',      'course/vibecoding-course.zip'],
];
// macOS: uv — арх-специфичные тарболлы (uv.sh берёт uv-macos-$(arch_tag).tar.gz), dmg
// универсальный → кладём ОБА (arm64 + x64). Имена — из tools/fetch-vendor-mac.sh.
// Курс обязателен ещё и потому, что vendorComplete() (main.js) ищет apps/uv-macos-*.tar.gz
// и course/*.zip — без них mac-издание выглядит как оторванный sibling-vendor.
// Третий элемент = «необязательно» (нет в vendor → просто не кладём).
const LITE_KEEP_MAC = [
  ['checksums.json',                    'checksums.json'],
  ['apps/uv-macos-*.tar.gz',            'apps'],
  ['course/vibecoding-course.zip',      'course/vibecoding-course.zip'],
  ['licenses',                          'licenses',               true],
];

// Профиль целевой платформы: что вшиваем, чем собираем, как называем и какой потолок.
const TARGETS = {
  win: {
    platform: 'win32',
    keep: LITE_KEEP_WIN,
    builderArgs: ['--win', '--publish', 'never'],
    artifactName: 'Hamidun-Setup-Windows-Lite.${ext}',
    artifactFile: 'Hamidun-Setup-Windows-Lite.exe',
    artifactRe: /Lite.*\.exe$/i,
    maxBytes: 320 * 1024 * 1024, // ~300МБ — потолок «лёгкости»
    vendorHint: 'npm run fetch:vendor',
    hostPlatform: null,          // Windows-сборка кросс-платформенна (nsis/portable)
  },
  mac: {
    platform: 'darwin',
    keep: LITE_KEEP_MAC,
    builderArgs: ['--mac', '--universal', '--publish', 'never'],
    artifactName: 'Hamidun-Setup-Mac-Lite.${ext}',
    artifactFile: 'Hamidun-Setup-Mac-Lite.dmg',
    artifactRe: /Lite.*\.dmg$/i,
    maxBytes: 400 * 1024 * 1024, // universal .app (два слайса) + uv×2 + курс
    vendorHint: 'bash tools/fetch-vendor-mac.sh',
    hostPlatform: 'darwin',      // dmg/codesign/notarize существуют только на macOS
  },
};

function parseTarget(argv) {
  const wantMac = argv.includes('--mac') || argv.includes('--darwin');
  const wantWin = argv.includes('--win') || argv.includes('--windows');
  if (wantMac && wantWin) {
    throw new Error('укажи ОДНУ платформу: --win либо --mac.');
  }
  return wantMac ? 'mac' : 'win';
}

function dirSize(p) {
  let t = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    t += e.isDirectory() ? dirSize(fp) : fs.statSync(fp).size;
  }
  return t;
}

// glob-lite: только '*' в БАЗОВОМ имени (напр. apps/uv-macos-*.tar.gz). Каталог — литерал.
// Возвращает ФАКТИЧЕСКИ существующие пути (относительно vendor/); пусто = «нечего брать»,
// решение (пропустить или упасть) принимает вызывающий по флагу «необязательно».
function expandKeep(srcRel) {
  if (!srcRel.includes('*')) return fs.existsSync(path.join(VENDOR, srcRel)) ? [srcRel] : [];
  const dir = path.posix.dirname(srcRel);
  const pat = path.posix.basename(srcRel);
  if (dir.includes('*')) throw new Error(`vendor-lite: '*' допустим только в имени файла, не в пути: ${srcRel}`);
  const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  let names = [];
  try {
    names = fs.readdirSync(path.join(VENDOR, dir)).filter((n) => re.test(n)).sort();
  } catch (e) { names = []; }
  return names.map((n) => path.posix.join(dir, n));
}

function buildVendorLite(t) {
  fs.rmSync(VENDOR_LITE, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_LITE, { recursive: true });
  for (const [srcRel, dstRel, optional] of t.keep) {
    const sources = expandKeep(srcRel);
    if (!sources.length) {
      if (optional) { console.log(`[build-lite] vendor-lite: необязательный ${srcRel} отсутствует — пропускаю.`); continue; }
      throw new Error('vendor-lite: нет обязательного ' + srcRel + ' — запусти `' + t.vendorHint
        + '` хотя бы раз, чтобы наполнить vendor/.');
    }
    const isPattern = srcRel.includes('*');
    for (const rel of sources) {
      const s = path.join(VENDOR, rel);
      if (!fs.existsSync(s)) {
        throw new Error('vendor-lite: нет обязательного ' + rel + ' — запусти `' + t.vendorHint
          + '` хотя бы раз, чтобы наполнить vendor/.');
      }
      // Для glob-записей dstRel = КАТАЛОГ назначения (имя файла сохраняем),
      // для литеральных — точный путь назначения (как было в win-раскладке).
      const d = isPattern ? path.join(VENDOR_LITE, dstRel, path.posix.basename(rel))
                          : path.join(VENDOR_LITE, dstRel);
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.cpSync(s, d, { recursive: true });
    }
  }
  console.log(`[build-lite] vendor-lite собран: ${(dirSize(VENDOR_LITE) / 1048576).toFixed(1)} МБ`);
}

// Сверка ДВУХ гейтов целостности между собой (иначе релизная ошибка выглядит как атака).
// Первый гейт — sha ZIP-а из remote-components.json (проверяет remote-fetch).
// Второй — вшитый vendor/checksums.json (Confirm-HmArtifact / verify_artifact внутри
// install-скриптов, по БАЗОВОМУ имени файла). Второй манифест едет в артефакт, а содержимое
// zip-ов зафиксировано в момент публикации: пересобрал vendor (обновился python/маскот/nomad)
// и собрал lite БЕЗ перепубликации → у пользователя докачка проходит, а гейт падает с «файл
// подменён». Поэтому перед сборкой сверяем: sha файлов, реально лежащих в опубликованных
// архивах (push-component.py пишет их в запись реестра как gatedFiles), == sha в манифесте,
// который вшивается в этот артефакт. Проверяем ТОЛЬКО записи своей платформы.
function assertRegistryMatchesChecksums(platform) {
  const chkPath = path.join(VENDOR_LITE, 'checksums.json'); // ровно тот, что уедет в артефакт
  const files = (JSON.parse(fs.readFileSync(chkPath, 'utf8')).files) || {};
  const regPath = path.join(ROOT, 'remote-components.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  let checked = 0;
  let entries = 0;
  const ungated = [];
  for (const e of (reg.components || [])) {
    if (!e || !e.remoteId || e.platform !== platform) continue;
    entries++;
    const gated = e.gatedFiles;
    // ПУСТОЙ объект — это не «проверено», это «проверять нечем». Так шли две самые
    // тяжёлые и важные записи: «claude» (npm-кеш, ~1 ГБ) и «config» (весь конфиг-пак).
    // gatedFiles собирается из vendor/checksums.json, а туда попадают только отдельные
    // ФАЙЛЫ (apps/*, курс, nomad) — у компонентов-КАТАЛОГОВ представителя там нет, и
    // цикл ниже honestly не сверял ничего. Снаружи это выглядело как «всё сошлось».
    if (gated && typeof gated === 'object' && !Object.keys(gated).length) {
      ungated.push(e.remoteId);
    }
    if (!gated || typeof gated !== 'object') {
      throw new Error(
        `реестр докачки: у «${e.remoteId}» нет поля gatedFiles — запись опубликована старой версией ` +
        `tools/push-component.py, и сверить её с вшитым checksums.json невозможно. Перепубликуй компонент: ` +
        `python tools/publish-vendor.py --platform ${platform} --only ${e.remoteId}`
      );
    }
    for (const [name, sha] of Object.entries(gated)) {
      const local = files[name];
      if (!local) continue; // имени нет в манифесте → рантайм-гейт его не проверяет
      if (String(local.sha256).toLowerCase() !== String(sha).toLowerCase()) {
        throw new Error(
          `рассинхрон вшитого checksums.json и опубликованного «${e.remoteId}»: файл ${name} ` +
          `в архиве = ${String(sha).slice(0, 12)}…, в манифесте = ${String(local.sha256).slice(0, 12)}… — ` +
          `у КАЖДОГО lite-пользователя компонент упадёт после докачки с «файл подменён». ` +
          `Перепубликуй компонент: python tools/publish-vendor.py --platform ${platform} --only ${e.remoteId} — ` +
          `и только потом собирай lite.`
        );
      }
      checked++;
    }
  }
  // Свежесть конфиг-пака. В lite пак НЕ вшит — он едет компонентом «config», и его
  // байты стережёт sha архива в реестре. Но идентичность не стережёт НИЧТО: у «config»
  // gatedFiles пуст, а гейт config-fresh для lite-издания не применяется вовсе
  // (preflight сам себя обнуляет: «проверять нечего для этого издания»). То есть lite
  // мог уехать, указывая на конфиг-архив произвольного возраста, и ни один гейт на пути
  // этого бы не заметил. Здесь мы сверяем штамп пака, из которого СЕЙЧАС собирается
  // сборка, с тем, на чём её закрепили.
  const stampPath = path.join(ROOT, 'vendor', 'config-pack', '.hamidun-config-pack.json');
  if (!fs.existsSync(stampPath)) {
    throw new Error(
      'нет vendor/config-pack/.hamidun-config-pack.json — какой пак опубликован компонентом ' +
      '«config», недоказуемо. Почини: npm run fetch:config'
    );
  }
  const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  const wantRef = process.env.HM_CONFIG_REF || '';
  if (/^[0-9a-f]{7,40}$/i.test(wantRef) && String(stamp.commit || '').toLowerCase().indexOf(wantRef.toLowerCase()) !== 0) {
    throw new Error(
      `сборка закреплена на ${wantRef.slice(0, 12)}, а в vendor лежит пак ${String(stamp.commit).slice(0, 12)} — ` +
      'компонент «config» опубликован не из того снапшота. Почини: npm run fetch:config (с тем же HM_CONFIG_REF)'
    );
  }
  console.log(`[build-lite] конфиг-пак: ${String(stamp.commit).slice(0, 12)} (${stamp.committedAt || '—'}), скиллов: ${stamp.skills}`);
  if (ungated.length) {
    console.log(`[build-lite] ВНИМАНИЕ: записи без gatedFiles (сверять с манифестом нечем): ${ungated.join(', ')}.`);
    console.log('            Целостность их архивов стережёт только sha в реестре — этого хватает против порчи,');
    console.log('            но НЕ против устаревшей публикации. Для «config» возраст проверен штампом выше.');
  }

  // Ни одной записи своей платформы = lite-сборка, которой НЕЧЕГО качать: все тяжёлые
  // компоненты у пользователя уйдут в «нет сборки для платформы». Ловим до сборки.
  if (!entries) {
    throw new Error(
      `в remote-components.json нет НИ ОДНОЙ записи для платформы ${platform} — lite-издание было бы ` +
      `пустышкой (тяжёлые компоненты недостижимы). Сначала опубликуй компоненты: ` +
      `python tools/publish-vendor.py --platform ${platform}`
    );
  }
  console.log(`[build-lite] реестр докачки (${platform}, записей: ${entries}) сверен с вшитым checksums.json: ${checked} файл(ов) совпало.`);
}

function findLiteArtifact(t) {
  for (const dir of ['dist', 'release', path.join('dist', 'win-unpacked')]) {
    const p = path.join(ROOT, dir, t.artifactFile);
    if (fs.existsSync(p)) return p;
  }
  // fallback: любой подходящий артефакт с 'Lite' в имени
  for (const dir of ['dist', 'release']) {
    const d = path.join(ROOT, dir);
    if (!fs.existsSync(d)) continue;
    const hit = fs.readdirSync(d).find((f) => t.artifactRe.test(f));
    if (hit) return path.join(d, hit);
  }
  return null;
}

// Мутация package.json под lite-издание нужной платформы (возврат — из бэкапа в finally).
function mutatePackage(t, pkg) {
  if (t.platform === 'win32') {
    for (const r of (pkg.build.win.extraResources || [])) {
      if (r.from === 'vendor') r.from = 'vendor-lite';
    }
    // Target-specific (portable) artifactName ИМЕЕТ ПРИОРИТЕТ над win.artifactName в
    // electron-builder — меняем ОБА, иначе lite-exe выйдет под именем офлайн-сборки,
    // findLiteArtifact() его не найдёт и size-assert молча не сработает.
    pkg.build.win.artifactName = t.artifactName;
    if (pkg.build.portable) pkg.build.portable.artifactName = t.artifactName;
    return;
  }
  // macOS: extraResources с vendor НЕ добавляем СОЗНАТЕЛЬНО (см. шапку файла — нотаризация
  // и вложенные архивы с Mach-O). Меняем только имя артефакта, чтобы промежуточный dmg не
  // перезаписал офлайн-релиз Hamidun-Setup-Mac.dmg в release/.
  pkg.build.mac = pkg.build.mac || {};
  if (Array.isArray(pkg.build.mac.extraResources)) {
    // Если vendor однажды всё-таки пропишут в mac.extraResources — переводим на vendor-lite,
    // иначе в lite-.app молча уехал бы полный офлайн-vendor (2.7 ГБ).
    for (const r of pkg.build.mac.extraResources) {
      if (r && r.from === 'vendor') r.from = 'vendor-lite';
    }
  }
  pkg.build.mac.artifactName = t.artifactName;
  // dmg.artifactName (target-specific) перебил бы mac.artifactName — тот же урок, что с
  // portable на Windows: ставим ОБА, иначе dmg выйдет под именем офлайн-сборки.
  pkg.build.dmg = pkg.build.dmg || {};
  pkg.build.dmg.artifactName = t.artifactName;
}

function main() {
  const target = parseTarget(process.argv.slice(2));
  const t = TARGETS[target];
  if (t.hostPlatform && process.platform !== t.hostPlatform && process.env.HM_LITE_FORCE_CROSS !== '1') {
    throw new Error(`сборка ${target}-издания требует host ${t.hostPlatform} (сейчас ${process.platform}): `
      + 'dmg/codesign/notarize существуют только на macOS. Запусти на macOS-раннере '
      + '(.github/workflows) или выстави HM_LITE_FORCE_CROSS=1, если знаешь, что делаешь.');
  }
  console.log(`[build-lite] цель: ${target} (${t.platform}); артефакт: ${t.artifactFile}`);
  // Выключатель, о котором в логе не сказано ни строки, через неделю никто не помнит.
  // А цена у него не косметическая: кросс-сборка dmg на не-macOS даёт артефакт без
  // подписи и нотаризации — у получателя он открывается как «повреждён». Раз уж мы
  // пропускаем проверку, это должно быть написано ровно там, где потом будут читать.
  if (t.hostPlatform && process.platform !== t.hostPlatform) {
    console.log(`[build-lite] ВНИМАНИЕ: HM_LITE_FORCE_CROSS=1 — проверка хоста снята осознанно.`);
    console.log(`             Собираем ${target} на ${process.platform} вместо ${t.hostPlatform}:`);
    console.log('             подпись и нотаризация не выполнятся, артефакт НЕ раздавать.');
  }

  const cfgBak = fs.readFileSync(CFG);
  const pkgBak = fs.readFileSync(PKG);
  // Ctrl+C во время долгого electron-builder НЕ должен оставить дерево мутированным
  // (package.json с from:'vendor-lite' молча испортил бы следующую офлайн-сборку).
  // Достаточно зарегистрировать слушателя: он отменяет default-terminate, дочерний
  // процесс получает свой SIGINT и падает, execFileSync бросает → finally отрабатывает.
  const onSig = () => { process.exitCode = 130; };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    // 1. config.json: edition:lite + offlineEdition:false + configRepoBranch:v38
    const cfg = JSON.parse(cfgBak.toString('utf8'));
    cfg.edition = 'lite';
    cfg.offlineEdition = false;
    // Фолбэк-клон, если докачка компонента config не удалась. Здесь стояло 'v38' —
    // ветки с таким именем в репозитории НЕТ (git ls-remote показывает только main и
    // feat/sdat-skill), то есть запасной путь гарантированно падал: клон по имени
    // несуществующей ветки не делается вовсе. Отказ докачки означал бы отказ установки
    // конфига целиком, хотя запасной путь для того и заведён. Берём main.
    cfg.configRepoBranch = 'main';
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');

    // 2. package.json: extraResources vendor→vendor-lite; отдельное имя lite-артефакта
    const pkg = JSON.parse(pkgBak.toString('utf8'));
    mutatePackage(t, pkg);
    fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');

    // 3. vendor-lite
    buildVendorLite(t);

    // 3b. Вшитый checksums.json vs опубликованные архивы (fail-closed, ДО долгой сборки)
    assertRegistryMatchesChecksums(t.platform);

    // 4. electron-builder (БЕЗ fetch:vendor/fetch:config — тяжёлое и конфиг стримятся)
    console.log(`[build-lite] electron-builder ${t.builderArgs.join(' ')} …`);
    // Node 22 на Windows НЕ спавнит .cmd напрямую через execFileSync (EINVAL, CVE-фикс) —
    // нужен shell:true (тогда 'npx' резолвится шеллом в npx.cmd). На macOS безвреден.
    execFileSync('npx', ['electron-builder'].concat(t.builderArgs), { cwd: ROOT, stdio: 'inherit', shell: true });

    // 5. size-assert — страховка от случайного вшивания полного vendor
    const art = findLiteArtifact(t);
    if (art) {
      const sz = fs.statSync(art).size;
      console.log(`[build-lite] итоговый артефакт: ${art} = ${(sz / 1048576).toFixed(1)} МБ`);
      if (sz > t.maxBytes) {
        throw new Error(`lite-артефакт ${(sz / 1048576).toFixed(0)}МБ > потолка ${(t.maxBytes / 1048576).toFixed(0)}МБ — вероятно вшит лишний vendor (проверь extraResources.from=vendor-lite).`);
      }
    } else {
      console.log(`[build-lite] ВНИМАНИЕ: итоговый lite-артефакт (${t.artifactFile}) не найден для size-assert (проверь release/).`);
    }
    if (target === 'mac') {
      // Честно про границы шага: dmg от electron-builder НЕ содержит vendor (см. шапку),
      // значит uv и курс-симулятор в нём недоступны. Shippable dmg собирает hdiutil-шаг
      // workflow'а, кладя vendor-lite РЯДОМ с .app на том.
      console.log('[build-lite] macOS: собран НОТАРИЗОВАННЫЙ .app (release/mac-universal/) '
        + 'и промежуточный dmg БЕЗ vendor — в нём НЕТ uv и курса.');
      console.log('[build-lite] Финальный dmg собирает шаг «Assemble final lite dmg» в '
        + '.github/workflows/build-mac-lite.yml: .app + лёгкий vendor (uv ×2 арх, курс, '
        + 'checksums.json) СИБЛИНГОМ на томе + ярлык /Applications.');
    }
    console.log('[build-lite] ГОТОВО — lite-издание собрано.');
  } finally {
    // Каждый restore независимо: сбой одного (EPERM/AV-lock) не должен блокировать
    // остальные. package.json ПЕРВЫМ — оставленный мутированным (from:vendor-lite) он
    // молча испортил бы следующую офлайн-сборку (пол-компонентов).
    let restoreOk = true;
    const safe = (label, fn) => {
      try { fn(); } catch (e) { restoreOk = false; console.error(`[build-lite] restore ${label} FAILED: ${e.message}`); }
    };
    safe('package.json', () => fs.writeFileSync(PKG, pkgBak));
    safe('config.json', () => fs.writeFileSync(CFG, cfgBak));
    safe('vendor-lite', () => fs.rmSync(VENDOR_LITE, { recursive: true, force: true }));
    if (restoreOk) {
      console.log('[build-lite] config.json/package.json восстановлены, vendor-lite убран.');
    } else {
      process.exitCode = process.exitCode || 1;
      console.error('[build-lite] ВНИМАНИЕ: восстановление НЕ полное — ВОССТАНОВИ ВРУЧНУЮ: '
        + 'git checkout package.json config.json && rm -rf vendor-lite '
        + '(иначе следующая офлайн-сборка соберётся из vendor-lite и выйдет под именем …-Lite).');
    }
  }
}

main();
