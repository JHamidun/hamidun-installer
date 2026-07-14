'use strict';
/*
 * remote-fetch-live.js — ЖИВОЙ тест докачки: качает реальный uv-архив из CDN
 * (Reg.ru S3), проверяет SHA-256, распаковывает. Доказывает, что backbone
 * докачки работает вживую (сеть + resume-логика + verify + unzip).
 *
 * Требует интернет и уже залитый архив (tools/push-component.py uv ...).
 * Запуск: node test/remote-fetch-live.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rf = require(path.join(ROOT, 'src', 'remote-fetch.js'));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'remote-components.json'), 'utf8'));

(async () => {
  const platform = process.platform;
  const entry = rf.pickEntry(registry, 'uv', platform);
  assert(entry, `нет записи uv для платформы ${platform} в реестре`);
  console.log('Запись реестра: uv', JSON.stringify({
    platform: entry.platform, sizeBytes: entry.sizeBytes,
    sha256: entry.sha256.slice(0, 16) + '…',
    mirrors: entry.mirrors.map((m) => m.host)
  }));

  // Свежий временный кэш — чтобы тест реально КАЧАЛ, а не читал старое.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-remote-live-'));
  console.log('Кэш:', cacheDir);

  let lastPct = -1;
  const t0 = Date.now();
  const res = await rf.fetchRemote({
    entry,
    cacheDir,
    timeoutMs: 30000,
    onProgress: (p) => {
      if (p.pct != null && p.pct !== lastPct && p.pct % 10 === 0) {
        lastPct = p.pct;
        process.stdout.write(`  докачка ${p.pct}% (${(p.received / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(1)} МБ)\n`);
      }
    },
    onLog: (m) => console.log('  [log]', m)
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\nРезультат fetchRemote:', JSON.stringify({
    ok: res.ok, bytes: res.bytes, sha256: (res.sha256 || '').slice(0, 16) + '…',
    mirror: res.mirror, cached: !!res.cached, path: res.path, error: res.error
  }));

  let failed = 0;
  const check = (name, cond) => {
    if (cond) { console.log('  ✅ ' + name); } else { console.log('  ❌ ' + name); failed++; }
  };

  check('fetchRemote вернул ok', res.ok === true);
  check('sha256 совпал с реестром', String(res.sha256 || '').toLowerCase() === String(entry.sha256).toLowerCase());
  check('скачано байт == sizeBytes реестра', Number(res.bytes) === Number(entry.sizeBytes));
  const uvExe = res.path ? path.join(res.path, platform === 'win32' ? 'uv.exe' : 'uv') : '';
  const unpackedOk = res.path && fs.existsSync(res.path) && fs.readdirSync(res.path).length > 0;
  check('папка распаковки не пуста', !!unpackedOk);
  check('в распаковке есть бинарь uv' + (platform === 'win32' ? '.exe' : ''),
    !!(uvExe && fs.existsSync(uvExe)));

  // Идемпотентность: повторный вызов должен взять из кэша (cached:true), без сети.
  const res2 = await rf.fetchRemote({ entry, cacheDir, timeoutMs: 30000, onLog: () => {} });
  check('повторный вызов идемпотентен (cached=true, без докачки)', res2.ok && res2.cached === true);

  console.log(`\nЖивой тест: ${failed === 0 ? 'ПРОЙДЕН' : 'ПРОВАЛЕН'} за ${secs}s (провалов: ${failed})`);

  // Чистим временный кэш.
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
