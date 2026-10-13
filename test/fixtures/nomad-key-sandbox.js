'use strict';

// Песочница для проверки записи ключа Nomad на НАСТОЯЩЕЙ файловой системе (security-fix u6: HERMES_HOME).
//
// Зачем такая обвязка. Однажды прогон НОВОГО теста против ещё не исправленного кода записал поддельный ключ
// в настоящий пользовательский конфиг агента: старый код игнорировал переданное окружение и брал process.env.
// Поэтому проверка, которая может дотянуться до профиля, обязана быть безопасной САМА ПО СЕБЕ — даже если
// проверяемый код регресснул или это его прежняя версия:
//   1) родитель запускает этот файл ТОЛЬКО с песочным окружением (USERPROFILE, HOME, APPDATA, LOCALAPPDATA,
//      HERMES_HOME, TEMP, TMP — внутри каталога песочницы);
//   2) ПЕРВОЕ действие — до загрузки проверяемого модуля — проверить, что каждый корень, из которого модуль
//      мог бы вывести путь (os.homedir(), перечисленные переменные, os.tmpdir()), лежит внутри песочницы, и
//      что внутри неё лежит путь, который выбрал бы прежний код (по process.env); иначе — ответ unsafe и
//      выход, ничего не вызвав;
//   3) os.userInfo() подменяется песочным профилем (код, читающий «профиль токена» в обход окружения,
//      иначе попал бы в настоящий профиль);
//   4) после загрузки модуля fs оборачивается сторожем: любое обращение к пути ВНЕ песочницы (чтение тоже)
//      бросает исключение и записывается в violations — модуль не может ни изменить, ни прочитать чужое;
//   5) ответ — одна строка HMJSON:… в stdout.
//
// usage: node nomad-key-sandbox.js <config.json>
//   config: { module, sandbox, nomadConfig, key, cases: [{ id, hermesHome | null }], observe: [абсолютные пути] }

const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

// Ответ одной строкой; выход — в колбэке записи (process.exit сразу после write мог бы обрезать вывод в канал).
const out = (o) => { process.stdout.write('HMJSON:' + JSON.stringify(o), () => process.exit(0)); };

function main() {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const SANDBOX = path.resolve(cfg.sandbox);
  const real = { existsSync: fs.existsSync, readFileSync: fs.readFileSync, statSync: fs.statSync };

  const within = (p) => {
    if (typeof p !== 'string' || !p) return false;
    const rel = path.relative(SANDBOX, path.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

  // 2) корни — внутри песочницы, ДО загрузки проверяемого модуля
  const E = process.env;
  const roots = {
    homedir: os.homedir(), USERPROFILE: E.USERPROFILE, HOME: E.HOME, APPDATA: E.APPDATA,
    LOCALAPPDATA: E.LOCALAPPDATA, TEMP: E.TEMP, TMP: E.TMP, tmpdir: os.tmpdir(),
  };
  const outsideRoots = Object.keys(roots).filter((k) => roots[k] !== undefined && roots[k] !== '' && !within(roots[k]));
  if (outsideRoots.length) return out({ unsafe: true, why: 'корни вне песочницы', outsideRoots, roots });
  for (const c of cfg.cases) {
    // путь, который выбрал бы ПРЕЖНИЙ код (HERMES_HOME без проверки, иначе LOCALAPPDATA\hermes)
    const legacyDir = c.hermesHome ? c.hermesHome : path.join(E.LOCALAPPDATA || '', 'hermes');
    if (!within(legacyDir)) return out({ unsafe: true, why: 'путь прежнего кода вне песочницы', caseId: c.id, legacyDir });
  }

  // 3) профиль «по токену» — песочный
  os.userInfo = () => ({ username: 'hmtest', uid: -1, gid: -1, shell: null, homedir: roots.USERPROFILE });

  // проверяемый модуль грузится ДО сторожа (загрузчик сам читает файлы исходников вне песочницы)
  const NK = require(cfg.module);

  // 4) сторож fs
  const violations = [];
  const toPath = (a) => {
    if (typeof a === 'string') return a;
    if (Buffer.isBuffer(a)) return a.toString();
    if (a && typeof a === 'object' && typeof a.href === 'string') { try { return url.fileURLToPath(a); } catch (e) { return String(a.href); } }
    return null;
  };
  const guard = (name, argIdx) => {
    const orig = fs[name];
    if (typeof orig !== 'function') return;
    fs[name] = function () {
      for (const i of argIdx) {
        const p = toPath(arguments[i]);
        if (p !== null && !within(p)) {
          violations.push({ fn: name, path: p });
          throw new Error('SANDBOX VIOLATION: ' + name + ' ' + p);
        }
      }
      return orig.apply(this, arguments);
    };
  };
  ['mkdirSync', 'openSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync',
    'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'realpathSync', 'chmodSync', 'utimesSync',
    'truncateSync'].forEach((n) => guard(n, [0]));
  ['renameSync', 'copyFileSync', 'linkSync', 'symlinkSync'].forEach((n) => guard(n, [0, 1]));

  // 5) сценарии: вызов ровно так, как зовёт main.js (окружение НЕ передаётся — модуль берёт process.env)
  const results = [];
  for (const c of cfg.cases) {
    if (c.hermesHome === null || c.hermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = c.hermesHome;
    let res = null;
    let threw = null;
    try { res = NK.writeNomadKey(cfg.key, { config: cfg.nomadConfig }); } catch (e) { threw = String((e && e.message) || e); }
    results.push({ id: c.id, res, threw });
  }

  const observed = (cfg.observe || []).map((p) => {
    const o = { path: p, exists: real.existsSync(p) };
    if (o.exists) {
      try { o.isDir = real.statSync(p).isDirectory(); } catch (e) { o.isDir = null; }
      if (o.isDir === false) { try { o.content = real.readFileSync(p, 'utf8'); } catch (e) { o.content = null; } }
    }
    return o;
  });

  return out({ platform: process.platform, roots, results, observed, violations });
}

main();
