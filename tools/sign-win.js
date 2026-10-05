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
// не пропустит tools/publish-dist.py (он проверяет подпись перед заливкой).

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
  const d = decide(env, process.platform);
  if (!d.sign) {
    console.log('  • sign-win: ПРОПУСК подписи ' + path.basename(file) + ' — ' + d.why);
    return;
  }
  connectOnce(env);
  const tool = findSigntool(env);
  const sha1 = (env.HM_WIN_CERT_SHA1 || CERT_SHA1).toUpperCase();
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
module.exports.signtoolArgs = signtoolArgs;
module.exports.CERT_SHA1 = CERT_SHA1;
