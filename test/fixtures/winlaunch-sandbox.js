'use strict';

// Песочница для теста «принципал одноразовой задачи запуска редактора берётся из ТОКЕНА» (security-fix u6,
// рецензия: остаток F9). Исполняет НАСТОЯЩИЙ текст `async function winLaunchDeElevated` из src/main.js
// (main.js целиком в тесте не поднять — он требует electron) с заглушками системных вызовов: schtasks,
// whoami, powershell, создание защищённого каталога. XML задачи, который функция записала бы в
// task.xml, перехватывается. Ничего настоящего (планировщик, реестр, процессы) не трогается.
//
// Отдельным процессом, а не в тесте: функция асинхронная, а раннер раздела (run_section.js) не умеет
// ждать async-тесты; здесь ответ приходит одной строкой HMJSON: в stdout.
//
// usage: node winlaunch-sandbox.js <config.json>
//   config: { fnSrc, deelevRoute, env, osUser, whoamiOut, whoamiThrows, staging, exe, folder }

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const calls = [];
const written = [];
const logs = [];
const trustedEnv = { SystemRoot: 'C:\\Windows', HM_TRUSTED_ENV: '1' };   // то, что вернул бы detectSpawnEnv()
const WIN_SYS = 'C:\\Windows\\System32\\';

const sb = {
  remoteFetch: {
    winSystemRoot: () => 'C:\\Windows',
    winPowershellPath: () => WIN_SYS + 'WindowsPowerShell\\v1.0\\powershell.exe',
    sysBin: (name) => WIN_SYS + name,
  },
  process: { env: cfg.env || {} },
  path: path.win32,
  fs: {
    existsSync: () => true,
    writeFileSync: (file, data, enc) => { written.push({ file: String(file), data: String(data), enc: enc || null }); },
    unlinkSync: () => {},
  },
  spawn: (bin, args) => { calls.push({ spawn: path.win32.basename(String(bin)).toLowerCase(), args: (args || []).slice() }); return { unref() {} }; },
  logToFile: (id, line) => { logs.push(String(id) + '|' + String(line)); },
  deelevRoute: require(cfg.deelevRoute),
  winShellTokenLaunch: async () => { calls.push({ shellToken: true }); return { gate: 'unavailable', code: -1, reason: 'заглушка' }; },
  execFileSync: (bin, args, opts) => {
    const name = path.win32.basename(String(bin)).toLowerCase();
    const a = (args || []).slice();
    if (name === 'whoami.exe') {
      calls.push({ exec: name, args: a, trustedEnv: !!(opts && opts.env === trustedEnv), timeout: opts && opts.timeout });
      if (cfg.whoamiThrows) throw new Error('whoami: заглушка падает');
      return cfg.whoamiOut == null ? '' : cfg.whoamiOut;
    }
    if (name === 'schtasks.exe') {
      calls.push({ exec: name, args: [a[0]] });
      if (a[0] === '/Query') return '"a","b","c","d","e","f","0"\r\n';   // Last Result = 0
      return '';
    }
    throw new Error('неожиданный запуск в песочнице: ' + name);
  },
  detectSpawnEnv: () => trustedEnv,
  winMakeSecureDir: async () => { calls.push({ winMakeSecureDir: true }); return cfg.staging; },
  rmStagingTree: (dir) => { calls.push({ rmStagingTree: String(dir) }); },
  crypto,
  Buffer,
  os: { userInfo: () => { if (cfg.osUser == null) throw new Error('нет пользователя'); return { username: cfg.osUser }; } },
  setTimeout: (fn) => setImmediate(fn),
};

vm.createContext(sb);
vm.runInContext(cfg.fnSrc + '\nthis.__f = winLaunchDeElevated;', sb);
sb.__f(cfg.exe, cfg.folder, []).then((result) => {
  process.stdout.write('HMJSON:' + JSON.stringify({ result, written, calls, logs }));
  process.exit(0);
}, (e) => {
  process.stdout.write('HMJSON:' + JSON.stringify({ error: String((e && e.stack) || e), written, calls, logs }));
  process.exit(0);
});
