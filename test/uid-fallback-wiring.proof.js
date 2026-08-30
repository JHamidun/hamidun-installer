'use strict';
// Доказательство, что предложенная вставка в uid-telemetry.js применяется чисто и
// действительно чинит потерю метки. Настоящий файл НЕ трогаем: делаем копию рядом
// с оригиналом (чтобы require('./uid-fallback') разрешился), патчим её и гоняем.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Путь считается от САМОГО файла, а не от машины автора. Раньше здесь стоял
// абсолютный `C:/Vibecode/hamidun-installer/src`: у любого другого человека и на
// раннере доказательство падало бы на первом же чтении.
const SRC = path.join(__dirname, '..', 'src');
const orig = fs.readFileSync(path.join(SRC, 'uid-telemetry.js'), 'utf8');

const ANCHOR = '  } catch (e) { /* uid необязателен: без него всё работает, просто анонимно */ }';
assert.ok(orig.indexOf(ANCHOR) !== -1, 'якорь вставки не найден — спека устарела');
assert.strictEqual(orig.split(ANCHOR).length - 1, 1, 'якорь встречается не один раз');

// Доказательство имеет смысл, только пока вставки в боевом файле НЕТ. Она внесена
// (риск 1.1 закрыт, модуль восстановлен и подключён), поэтому повторная вставка
// объявляла бы `fromDownloads` дважды и падала загадочным
// `SyntaxError: Identifier 'fromDownloads' has already been declared` — из которого
// не видно, что доказывать уже нечего. Говорим это прямо и выходим успешно.
if (/const fromDownloads = require\('\.\/uid-fallback'\)/.test(orig)) {
  console.log('  ℹ️  вставка УЖЕ в src/uid-telemetry.js — доказывать нечего, риск 1.1 закрыт.');
  console.log('     Файл оставлен как исторический след разбора; в run-tests.js он не входит.');
  process.exit(0);
}

const PATCH = [
  '    const fromDownloads = require(\'./uid-fallback\').findDownloadedUid({ platform, env });',
  '    if (fromDownloads) return fromDownloads;',
  ANCHOR,
].join('\n');
const patched = orig.replace(ANCHOR, PATCH);

const tmpName = 'uid-telemetry.__wireproof.js';
const tmpPath = path.join(SRC, tmpName);
fs.writeFileSync(tmpPath, patched);

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + (e && e.message)); }
};

try {
  const ut = require(tmpPath);

  // «Загрузки» с помеченным файлом и запуск ИЗ ДРУГОГО МЕСТА — та самая ситуация,
  // в которой метка сейчас теряется.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-home-'));
  fs.mkdirSync(path.join(home, 'Downloads'));
  fs.writeFileSync(path.join(home, 'Downloads', 'Hamidun-Setup-Windows--u908070605.exe'), 'x');

  console.log('\n── Проверка вставки в resolveUid ──');

  t('ДО вставки метка теряется (это и есть сегодняшнее поведение)', () => {
    const before = require(path.join(SRC, 'uid-telemetry.js'));
    const got = before.resolveUid({
      env: {}, execPath: 'C:\\Users\\kolya\\Desktop\\установщик.exe',
      platform: 'win32', home,
    });
    assert.strictEqual(got, '');
  });

  t('ПОСЛЕ вставки метка находится в «Загрузках»', () => {
    const got = ut.resolveUid({
      env: { HM_DOWNLOADS_DIR: path.join(home, 'Downloads') },
      execPath: 'C:\\Users\\kolya\\Desktop\\установщик.exe',
      platform: 'win32', home,
    });
    assert.strictEqual(got, '908070605');
  });

  t('имя запущенного файла по-прежнему главнее «Загрузок»', () => {
    // Иначе свежий чужой файл в «Загрузках» перебивал бы верную метку.
    const got = ut.resolveUid({
      env: { HM_DOWNLOADS_DIR: path.join(home, 'Downloads') },
      execPath: 'C:\\dl\\Hamidun-Setup-Windows--u111222333.exe',
      platform: 'win32', home,
    });
    assert.strictEqual(got, '111222333');
  });

  t('HM_UID из окружения по-прежнему главнее всего', () => {
    const got = ut.resolveUid({
      env: { HM_UID: 'envwins', HM_DOWNLOADS_DIR: path.join(home, 'Downloads') },
      execPath: 'C:\\Users\\kolya\\Desktop\\установщик.exe',
      platform: 'win32', home,
    });
    assert.strictEqual(got, 'envwins');
  });

  t('в «Загрузках» пусто — остаёмся анонимными, ничего не выдумываем', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-empty-'));
    const got = ut.resolveUid({
      env: { HM_DOWNLOADS_DIR: empty },
      execPath: 'C:\\Users\\kolya\\Desktop\\установщик.exe',
      platform: 'win32', home: empty,
    });
    assert.strictEqual(got, '');
  });

  t('macOS: образ отцеплен, но dmg лежит в «Загрузках» — метка находится', () => {
    const mhome = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mac-'));
    fs.mkdirSync(path.join(mhome, 'Downloads'));
    fs.writeFileSync(path.join(mhome, 'Downloads', 'Hamidun-Setup-Mac--u404504604.dmg'), 'x');
    const got = ut.resolveUid({
      env: { HM_DOWNLOADS_DIR: path.join(mhome, 'Downloads') },
      execPath: '/Applications/Hamidun Setup.app/Contents/MacOS/Hamidun Setup',
      platform: 'darwin', home: mhome,
      execFileSync: () => { throw new Error('образ отцеплен'); },
    });
    assert.strictEqual(got, '404504604');
  });

  t('очистка текстов от ПД не задета вставкой', () => {
    assert.strictEqual(ut.scrubText('C:\\Users\\Иван\\AppData\\x'), '~\\AppData\\x');
  });
} finally {
  try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
}

console.log('\nИТОГ вставки: прошло ' + passed + ', упало ' + failed);
console.log('копия удалена, src/uid-telemetry.js не изменён');
process.exit(failed ? 1 : 0);
