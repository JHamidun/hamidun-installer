'use strict';
// Подпись Windows-сборок для electron-builder (package.json → build.win.signtoolOptions.sign).
//
// Сертификат — облачный Certum Code Signing (CN=Zhemal Khamidun, выпущен 05.10.2026,
// действует до 05.10.2027). Файла .pfx у него НЕТ и не будет: закрытый ключ живёт в
// HSM Certum, а signtool достаёт его через виртуальную смарт-карту SimplySign Desktop.
// Значит, подписать можно только там, где SimplySign Desktop установлен и в него
// выполнен вход (сессия ~2 часа). Поэтому порядок на каждый файл:
//   1. решить, подписываем ли вообще (decide): HM_WIN_SIGN=0 — осознанно без подписи;
//      на CI SimplySign нет — пропуск, если не задан HM_WIN_SIGN=1;
//   2. один раз за сборку — войти: HM_SIMPLYSIGN_CONNECT (команда) или
//      ~/.claude/tools/simplysign_connect.py, если он есть на машине;
//   3. signtool sign /sha1 <отпечаток> с меткой времени; при сбое — повтор,
//      третья попытка через запасной TSA;
//   4. signtool verify /pa — неподписанный или битый результат роняет сборку.
//
// Пропуск подписи печатается в лог, а не случается молча: неподписанный exe потом
// не пропустит ни tools/verify-signature.js (последний шаг npm run dist / dist:win /
// build-lite), ни tools/publish-dist.py (он проверяет подпись перед заливкой).

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Отпечаток SHA-1 сертификата — публичный, его видит каждый, кто откроет свойства exe.
// При перевыпуске (раз в год) — новый отпечаток сюда или в HM_WIN_CERT_SHA1.
const CERT_SHA1 = '0D519A2C48DF89680D004A0FA09F449573E9689F';
const TSA = ['http://time.certum.pl', 'http://time.certum.pl', 'http://timestamp.digicert.com'];
const CONNECTOR = path.join(os.homedir(), '.claude', 'tools', 'simplysign_connect.py');

function decide(env, platform) {
  if (env.HM_WIN_SIGN === '0') {
    return { sign: false, why: 'HM_WIN_SIGN=0 — сборка БЕЗ подписи осознанно' };
  }
  if (env.HM_WIN_SIGN === '1') return { sign: true, why: '' };
  if (platform !== 'win32') {
    return { sign: false, why: 'не Windows: нет signtool и SimplySign (HM_WIN_SIGN=1 — заставить)' };
  }
  if (env.CI || env.GITHUB_ACTIONS) {
    return { sign: false, why: 'CI: SimplySign там нет (HM_WIN_SIGN=1 — заставить)' };
  }
  return { sign: true, why: '' };
}

// Подписываем ТОЛЬКО своё — по списку (allow-list), а не «всё, кроме чужого» (S-8).
// electron-builder отдаёт хуку каждый .exe, попавший в resources\ через extraResources, то есть
// и вшитые установщики Git, VS Code, Cursor, Python, Handy, и uv, и скрепку (проверено мини-сборкой
// 09.10: хук получил resources\vendor\apps\*.exe). SHA-256 этих файлов закреплён в
// vendor\checksums.json, и Confirm-HmArtifact (scripts/windows/_verify.ps1) останавливает установку
// при любом расхождении («файл подменён»). Подпись меняет байты, поэтому после неё отказал бы
// КАЖДЫЙ вшитый компонент (в Lite — uv и uvx). Подписи вендоров остаются нетронутыми.
//
// Прежняя версия держала ЧЁРНЫЙ список по пути (win-*unpacked\resources\…): сменилась раскладка,
// например win-unpacked\vendor\apps\git-setup.exe мимо resources\, — и хук молча возвращал подпись
// вендорским файлам. Теперь подписывается ровно то, что названо здесь; всё прочее пропускается со
// строкой в логе. Названо три файла — столько подписей и тратит сборка (WIN-SIGNING.md):
//   1. exe приложения: прямо в win-*unpacked, имя = build.productName + .exe;
//   2. elevate.exe от electron-builder: прямо в каталоге resources (win-unpacked\resources\elevate.exe),
//      но не внутри vendor (проверяется только то, что НИЖЕ win-*unpacked);
//   3. итоговый portable: <output>\Hamidun-Setup-Windows.exe (lite — …-Lite.exe), не внутри win-*unpacked.
// Привязка к win-*unpacked нужна, чтобы папка «resources» в пути к репозиторию не сделала чужим всё.
// Имена сверяет тест с package.json: переименование продукта краснит тест, а не молча оставляет exe
// без подписи (а если и пройдёт мимо — tools/verify-signature.js остановит сборку на неподписанном файле).
const PRODUCT_EXE = 'Hamidun Setup.exe';
const OWN_ARTIFACT_RE = /^Hamidun-Setup-Windows(-Lite)?\.exe$/i;
const UNPACKED_DIR_RE = /^win-[\w.-]*unpacked$/i;
function isOwn(file) {
  const parts = String(file || '').split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return false;
  const name = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  const ancestors = parts.slice(0, -1);
  // «vendor» ищем только НИЖЕ каталога win-*unpacked: папка с таким именем выше в пути к репозиторию
  // (D:\vendor\repo\release\…) не делает свой elevate.exe чужим — иначе он остался бы без подписи, а сборку
  // остановил бы verify-signature. Если win-*unpacked в пути нет (рабочий каталог electron-builder), смотрим
  // только два ближайших звена: резать по всему пути к временной папке нечего.
  const unpackedAt = ancestors.map((a) => UNPACKED_DIR_RE.test(a)).lastIndexOf(true);
  const below = unpackedAt >= 0 ? ancestors.slice(unpackedAt + 1) : ancestors.slice(-2);
  if (name.toLowerCase() === PRODUCT_EXE.toLowerCase() && UNPACKED_DIR_RE.test(parent)) return true;
  if (name.toLowerCase() === 'elevate.exe' && parent.toLowerCase() === 'resources'
      && !below.some((a) => a.toLowerCase() === 'vendor')) return true;
  if (OWN_ARTIFACT_RE.test(name) && !ancestors.some((a) => UNPACKED_DIR_RE.test(a))) return true;
  return false;
}
// Для совместимости со старым именем: «чужой» = не из списка своих.
function isForeign(file) {
  return !isOwn(file);
}

// Решение по одному файлу — чистая функция (тестируется без signtool и SimplySign).
function plan(file, env, platform) {
  if (!isOwn(file)) {
    return {
      sign: false,
      foreign: true,
      why: 'не из списка своих файлов (подписываем exe приложения, elevate.exe и итоговый portable); ' +
        'у вшитых вендорских файлов SHA-256 закреплён в vendor\\checksums.json, подпись сломала бы проверку целостности',
    };
  }
  const d = decide(env, platform);
  return { sign: d.sign, foreign: false, why: d.why };
}

// Отпечаток, которым подписываем и который проверяет tools/verify-signature.js: один источник на двоих.
function certSha1(env) {
  return String((env && env.HM_WIN_CERT_SHA1) || CERT_SHA1).replace(/\s+/g, '').toUpperCase();
}

function signtoolArgs(file, sha1, tsa) {
  return ['sign', '/sha1', sha1, '/fd', 'sha256', '/tr', tsa, '/td', 'sha256', file];
}

function findSigntool(env) {
  if (env.HM_SIGNTOOL) return env.HM_SIGNTOOL;
  const base = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  let vers = [];
  try { vers = fs.readdirSync(base).filter((v) => /^10\.\d+\.\d+\.\d+$/.test(v)); } catch (e) { /* нет SDK */ }
  vers.sort((a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
  for (const v of vers) {
    const p = path.join(base, v, 'x64', 'signtool.exe');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('sign-win: signtool.exe не найден (Windows SDK). Поставь SDK или задай HM_SIGNTOOL');
}

let connected = null;
function connectOnce(env) {
  if (connected) return;
  if (env.HM_SIMPLYSIGN_CONNECT) {
    execSync(env.HM_SIMPLYSIGN_CONNECT, { stdio: 'inherit' });
  } else if (fs.existsSync(CONNECTOR)) {
    execFileSync('python', [CONNECTOR], { stdio: 'inherit' });
  } else {
    console.log('  • sign-win: коннектора SimplySign нет — считаю, что вход в SimplySign Desktop уже выполнен');
  }
  connected = true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sign(configuration) {
  const file = configuration.path;
  const env = process.env;
  const d = plan(file, env, process.platform);
  if (!d.sign) {
    // Для чужого файла печатаем путь от resources\ (или три последних звена), чтобы в логе было видно, какой именно.
    let shown = path.basename(file);
    if (d.foreign) {
      shown = /[\\/]resources[\\/]/i.test(String(file))
        ? String(file).replace(/^.*?[\\/](resources[\\/])/i, '$1')
        : String(file).split(/[\\/]+/).slice(-3).join('\\');
    }
    console.log('  • sign-win: ПРОПУСК подписи ' + shown + ' — ' + d.why);
    return;
  }
  connectOnce(env);
  const tool = findSigntool(env);
  const sha1 = certSha1(env);
  let last = null;
  for (let i = 0; i < TSA.length; i++) {
    try {
      execFileSync(tool, signtoolArgs(file, sha1, TSA[i]), { stdio: 'pipe', timeout: 300000 });
      last = null;
      break;
    } catch (e) {
      last = String((e.stdout || '') + (e.stderr || '') || e.message).trim();
      console.log('  • sign-win: попытка ' + (i + 1) + ' не удалась (' + TSA[i] + '): ' + last.split('\n').pop());
      if (i < TSA.length - 1) await sleep(5000 * (i + 1));
    }
  }
  if (last) {
    throw new Error('sign-win: не подписан ' + file + '. Вход в SimplySign Desktop выполнен? ' +
      '(python ~/.claude/tools/simplysign_connect.py --status). Последняя ошибка: ' + last);
  }
  execFileSync(tool, ['verify', '/pa', '/q', file], { stdio: 'pipe' });
  console.log('  • sign-win: подписан и проверен ' + path.basename(file));
}

module.exports = sign;
module.exports.default = sign;
module.exports.decide = decide;
module.exports.plan = plan;
module.exports.isOwn = isOwn;
module.exports.isForeign = isForeign;
module.exports.signtoolArgs = signtoolArgs;
module.exports.certSha1 = certSha1;
module.exports.CERT_SHA1 = CERT_SHA1;
module.exports.PRODUCT_EXE = PRODUCT_EXE;
module.exports.OWN_ARTIFACT_RE = OWN_ARTIFACT_RE;
