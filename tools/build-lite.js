'use strict';
/* build-lite.js — сборка ЛЁГКОГО (стриминг с S3) издания Hamidun-Setup.
 *
 * Отличия от офлайн (dist:win):
 *   • config.json: edition:'lite' + offlineEdition:false (main → авто-remote по реестру,
 *     кроме bundled-only uv; vendorBlockInfo не блокирует за неполный vendor);
 *   • vendor-lite/ (ТОЛЬКО uv + course + шрифт + checksums, ~26МБ) вместо полного
 *     vendor (2.5ГБ) — иначе extraResources.from=vendor молча вшил бы 2ГБ с диска;
 *   • fetch:vendor и fetch:config НЕ запускаются — тяжёлое и конфиг стримятся с S3;
 *   • size-assert итогового exe (<~300МБ) — страховка от случайного вшивания vendor.
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
const MAX_EXE_BYTES = 320 * 1024 * 1024; // ~300МБ — потолок «лёгкости»

// Что вшивается в lite (bundled-only): uv (P1-A, security-sensitive, мал), курс,
// вшитый checksums.json (второй fail-closed гейт для докачек).
// Шрифт JetBrainsMono НЕ здесь: в lite компонент extension удалённый → HM_VENDOR=staging
// (не bundled vendor-lite), поэтому шрифт едет ВНУТРИ zip extension (publish-vendor.py).
const LITE_KEEP = [
  ['checksums.json',                    'checksums.json'],
  ['apps/uv',                           'apps/uv'],
  ['course/vibecoding-course.zip',      'course/vibecoding-course.zip'],
];

function dirSize(p) {
  let t = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    t += e.isDirectory() ? dirSize(fp) : fs.statSync(fp).size;
  }
  return t;
}

function buildVendorLite() {
  fs.rmSync(VENDOR_LITE, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_LITE, { recursive: true });
  for (const [src, dst] of LITE_KEEP) {
    const s = path.join(VENDOR, src);
    if (!fs.existsSync(s)) {
      throw new Error('vendor-lite: нет обязательного ' + src + ' — запусти `npm run fetch:vendor` хотя бы раз, чтобы наполнить vendor/.');
    }
    const d = path.join(VENDOR_LITE, dst);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.cpSync(s, d, { recursive: true });
  }
  console.log(`[build-lite] vendor-lite собран: ${(dirSize(VENDOR_LITE) / 1048576).toFixed(1)} МБ`);
}

// Сверка ДВУХ гейтов целостности между собой (иначе релизная ошибка выглядит как атака).
// Первый гейт — sha ZIP-а из remote-components.json (проверяет remote-fetch).
// Второй — вшитый vendor/checksums.json (Confirm-HmArtifact внутри install-скриптов, по
// БАЗОВОМУ имени файла). Второй манифест едет в exe, а содержимое zip-ов зафиксировано в
// момент публикации: пересобрал vendor (обновился python/маскот/nomad) и собрал lite БЕЗ
// перепубликации → у пользователя докачка проходит, а Confirm-HmArtifact падает с «файл
// подменён». Поэтому перед сборкой сверяем: sha файлов, реально лежащих в опубликованных
// архивах (push-component.py пишет их в запись реестра как gatedFiles), == sha в манифесте,
// который вшивается в этот exe.
function assertRegistryMatchesChecksums() {
  const chkPath = path.join(VENDOR_LITE, 'checksums.json'); // ровно тот, что уедет в exe
  const files = (JSON.parse(fs.readFileSync(chkPath, 'utf8')).files) || {};
  const regPath = path.join(ROOT, 'remote-components.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  let checked = 0;
  for (const e of (reg.components || [])) {
    if (!e || !e.remoteId || e.platform !== 'win32') continue;
    const gated = e.gatedFiles;
    if (!gated || typeof gated !== 'object') {
      throw new Error(
        `реестр докачки: у «${e.remoteId}» нет поля gatedFiles — запись опубликована старой версией ` +
        `tools/push-component.py, и сверить её с вшитым checksums.json невозможно. Перепубликуй компонент: ` +
        `python tools/publish-vendor.py --only ${e.remoteId}`
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
          `Перепубликуй компонент: python tools/publish-vendor.py --only ${e.remoteId} — и только потом собирай lite.`
        );
      }
      checked++;
    }
  }
  console.log(`[build-lite] реестр докачки сверен с вшитым checksums.json: ${checked} файл(ов) совпало.`);
}

function findLiteExe() {
  for (const dir of ['dist', 'release', path.join('dist', 'win-unpacked')]) {
    const p = path.join(ROOT, dir, 'Hamidun-Setup-Windows-Lite.exe');
    if (fs.existsSync(p)) return p;
  }
  // fallback: любой *.exe в dist/ с 'Lite'
  for (const dir of ['dist', 'release']) {
    const d = path.join(ROOT, dir);
    if (!fs.existsSync(d)) continue;
    const hit = fs.readdirSync(d).find((f) => /Lite.*\.exe$/i.test(f));
    if (hit) return path.join(d, hit);
  }
  return null;
}

function main() {
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
    cfg.configRepoBranch = 'v38'; // фолбэк-clone config.ps1 берёт v38, если докачка config упала
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');

    // 2. package.json: win.extraResources vendor→vendor-lite; отдельное имя lite-exe
    const pkg = JSON.parse(pkgBak.toString('utf8'));
    for (const r of (pkg.build.win.extraResources || [])) {
      if (r.from === 'vendor') r.from = 'vendor-lite';
    }
    // Target-specific (portable) artifactName ИМЕЕТ ПРИОРИТЕТ над win.artifactName в
    // electron-builder — меняем ОБА, иначе lite-exe выйдет под именем офлайн-сборки,
    // findLiteExe() его не найдёт и size-assert молча не сработает.
    pkg.build.win.artifactName = 'Hamidun-Setup-Windows-Lite.${ext}';
    if (pkg.build.portable) pkg.build.portable.artifactName = 'Hamidun-Setup-Windows-Lite.${ext}';
    fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');

    // 3. vendor-lite
    buildVendorLite();

    // 3b. Вшитый checksums.json vs опубликованные архивы (fail-closed, ДО долгой сборки)
    assertRegistryMatchesChecksums();

    // 4. electron-builder --win (БЕЗ fetch:vendor/fetch:config — тяжёлое и конфиг стримятся)
    console.log('[build-lite] electron-builder --win …');
    // Node 22 на Windows НЕ спавнит .cmd напрямую через execFileSync (EINVAL, CVE-фикс) —
    // нужен shell:true (тогда 'npx' резолвится шеллом в npx.cmd).
    execFileSync('npx', ['electron-builder', '--win'], { cwd: ROOT, stdio: 'inherit', shell: true });

    // 5. size-assert — страховка от случайного вшивания полного vendor
    const exe = findLiteExe();
    if (exe) {
      const sz = fs.statSync(exe).size;
      console.log(`[build-lite] итоговый exe: ${exe} = ${(sz / 1048576).toFixed(1)} МБ`);
      if (sz > MAX_EXE_BYTES) {
        throw new Error(`lite-exe ${(sz / 1048576).toFixed(0)}МБ > потолка ${(MAX_EXE_BYTES / 1048576).toFixed(0)}МБ — вероятно вшит лишний vendor (проверь extraResources.from=vendor-lite).`);
      }
    } else {
      console.log('[build-lite] ВНИМАНИЕ: итоговый lite-exe не найден для size-assert (проверь dist/).');
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
        + '(иначе следующая офлайн-сборка соберётся из vendor-lite и выйдет под именем …-Lite.exe).');
    }
  }
}

main();
