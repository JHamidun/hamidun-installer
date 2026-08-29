'use strict';
// Тесты на НАСТОЯЩИХ папках и файлах: модуль ходит по файловой системе, и проверять
// его чтением кода бессмысленно — ровно здесь ошибаются в правах, регистре и
// порядке файлов.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const uf = require('../src/uid-fallback');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + (e && e.message)); }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hm-uidfb-'));
}
function touch(dir, name, mtimeMs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  if (mtimeMs) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

console.log('\n── Метка из скачанного файла (uid-fallback) ──');

// ── разбор имени ────────────────────────────────────────────────────────────
t('обычное имя', () => {
  assert.strictEqual(uf.uidFromFileName('Hamidun-Setup-Windows--u123456789.exe'), '123456789');
});
t('лёгкая версия macOS', () => {
  assert.strictEqual(uf.uidFromFileName('Hamidun-Setup-Mac-Lite--u42.dmg'), '42');
});
t('офлайн-версия Windows', () => {
  assert.strictEqual(uf.uidFromFileName('Hamidun-Setup-Windows-Offline--u42.exe'), '42');
});
t('повторная загрузка в Chrome: « (1)»', () => {
  assert.strictEqual(uf.uidFromFileName('Hamidun-Setup-Windows--u123456789 (1).exe'), '123456789');
});
t('повторная загрузка в Safari: «-2»', () => {
  assert.strictEqual(uf.uidFromFileName('Hamidun-Setup-Mac--u123456789-2.dmg'), '123456789');
});
t('без метки — пусто, а не мусор', () => {
  assert.strictEqual(uf.uidFromFileName('Hamidun-Setup-Windows.exe'), '');
});
t('чужой файл с похожим хвостом не считается нашим', () => {
  // Иначе достаточно положить в «Загрузки» такой файл, чтобы чужая метка уехала
  // в наши события и человеку написали про чужую упавшую установку.
  assert.strictEqual(uf.uidFromFileName('setup--u999.exe'), '');
  assert.strictEqual(uf.uidFromFileName('Hamidun-Setup-Windows--u999.exe.txt'), '');
  assert.strictEqual(uf.uidFromFileName('not-Hamidun-Setup-Windows--u999.exe'), '');
});
t('нечисловая метка отброшена (tg_id — только цифры)', () => {
  assert.strictEqual(uf.uidFromFileName('Hamidun-Setup-Windows--uabc.exe'), '');
});
t('метка длиннее допустимого отброшена', () => {
  assert.strictEqual(uf.uidFromFileName('Hamidun-Setup-Windows--u' + '9'.repeat(40) + '.exe'), '');
});

// ── поиск по папкам ─────────────────────────────────────────────────────────
t('находит файл в папке загрузок', () => {
  const d = tmpdir();
  touch(d, 'Hamidun-Setup-Windows--u777.exe');
  assert.strictEqual(uf.findDownloadedUid({ dirs: [d], platform: 'win32' }), '777');
});

t('берёт САМЫЙ СВЕЖИЙ — тот, кто качал дважды, интересует последним разом', () => {
  const d = tmpdir();
  const now = Date.now();
  touch(d, 'Hamidun-Setup-Windows--u111.exe', now - 3 * 86400000);
  touch(d, 'Hamidun-Setup-Windows--u222 (1).exe', now - 60000);
  assert.strictEqual(uf.findDownloadedUid({ dirs: [d], platform: 'win32' }), '222');
});

t('на macOS смотрит образы, а не exe', () => {
  const d = tmpdir();
  touch(d, 'Hamidun-Setup-Windows--u111.exe');
  touch(d, 'Hamidun-Setup-Mac--u222.dmg');
  assert.strictEqual(uf.findDownloadedUid({ dirs: [d], platform: 'darwin' }), '222');
});

t('на Windows смотрит exe, а не образы', () => {
  const d = tmpdir();
  touch(d, 'Hamidun-Setup-Mac--u222.dmg');
  touch(d, 'Hamidun-Setup-Windows--u111.exe');
  assert.strictEqual(uf.findDownloadedUid({ dirs: [d], platform: 'win32' }), '111');
});

t('ничего похожего — пусто, ничего не выдумываем', () => {
  const d = tmpdir();
  touch(d, 'отчёт.docx');
  touch(d, 'Hamidun-Setup-Windows.exe');
  assert.strictEqual(uf.findDownloadedUid({ dirs: [d], platform: 'win32' }), '');
});

t('несуществующая папка не роняет разбор', () => {
  const d = tmpdir();
  touch(d, 'Hamidun-Setup-Windows--u333.exe');
  const missing = path.join(d, 'нет-такой-папки');
  assert.strictEqual(uf.findDownloadedUid({ dirs: [missing, d], platform: 'win32' }), '333');
});

t('папка вместо файла не считается установщиком', () => {
  const d = tmpdir();
  fs.mkdirSync(path.join(d, 'Hamidun-Setup-Windows--u444.exe'));
  assert.strictEqual(uf.findDownloadedUid({ dirs: [d], platform: 'win32' }), '');
});

t('ищет и во второй папке, если в первой пусто', () => {
  const a = tmpdir(), b = tmpdir();
  touch(b, 'Hamidun-Setup-Windows--u555.exe');
  assert.strictEqual(uf.findDownloadedUid({ dirs: [a, b], platform: 'win32' }), '555');
});

t('регистр расширения не важен (.EXE с сетевого диска)', () => {
  const d = tmpdir();
  touch(d, 'Hamidun-Setup-Windows--u666.EXE');
  assert.strictEqual(uf.findDownloadedUid({ dirs: [d], platform: 'win32' }), '666');
});

t('тысячи посторонних файлов рядом не мешают и не вешают', () => {
  const d = tmpdir();
  for (let i = 0; i < 1200; i++) fs.writeFileSync(path.join(d, 'file' + i + '.tmp'), '');
  touch(d, 'Hamidun-Setup-Windows--u888.exe', Date.now());
  const t0 = Date.now();
  assert.strictEqual(uf.findDownloadedUid({ dirs: [d], platform: 'win32' }), '888');
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, 'обход занял ' + ms + ' мс — слишком долго для старта');
});

// ── список папок ────────────────────────────────────────────────────────────
t('в список папок попадают «Загрузки» и рабочий стол', () => {
  const dirs = uf.searchDirs({ home: path.join('C:', 'Users', 'kolya'), env: {} });
  assert.ok(dirs.some((d) => /Downloads$/.test(d)), dirs.join(' | '));
  assert.ok(dirs.some((d) => /Desktop$/.test(d)), dirs.join(' | '));
});
t('перенаправление в OneDrive учтено', () => {
  const dirs = uf.searchDirs({ home: 'C:\\Users\\kolya', env: { OneDrive: 'C:\\Users\\kolya\\OneDrive' } });
  assert.ok(dirs.some((d) => /OneDrive[\\/]Downloads$/.test(d)), dirs.join(' | '));
});
t('своя папка загрузок из окружения идёт первой', () => {
  const dirs = uf.searchDirs({ home: 'C:\\Users\\kolya', env: { HM_DOWNLOADS_DIR: 'D:\\Скачанное' } });
  assert.strictEqual(dirs[0], 'D:\\Скачанное');
});
t('число обходимых папок ограничено', () => {
  const dirs = uf.searchDirs({ home: 'C:\\Users\\kolya', env: { OneDrive: 'C:\\OD' } });
  assert.ok(dirs.length <= 8, 'папок ' + dirs.length);
});

console.log('\nИТОГ uid-fallback: прошло ' + passed + ', упало ' + failed);
if (require.main === module) process.exit(failed ? 1 : 0);
module.exports = { passed, failed };
