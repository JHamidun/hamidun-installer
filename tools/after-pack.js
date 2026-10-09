'use strict';
/**
 * after-pack.js — ЕДИНЫЙ вход electron-builder afterPack (package.json → build.afterPack).
 *
 * Делает два шага СТРОГО по порядку:
 *   1. гасит fuse RunAsNode, EnableNodeOptionsEnvironmentVariable и EnableNodeCliInspectArguments
 *      в Electron-бинаре собранного приложения (Windows и macOS);
 *   2. передаёт управление прежнему хуку tools/mac-adhoc-sign.js (ad-hoc подпись .app на macOS,
 *      на остальных платформах он ничего не делает). Он остался как был: его экспорты и поведение
 *      не менялись.
 *
 * ЗАЧЕМ. Установщик — подписанный Certum exe с requireAdministrator, а окружение elevated-процесса
 * пересобирается из реестра, куда процесс того же пользователя пишет без UAC. С заводскими fuse
 * NODE_OPTIONS="--require x.js" или ELECTRON_RUN_AS_NODE=1 исполняют чужой JS внутри подписанного
 * elevated-процесса (разбор — шапка tools/verify-fuses.js). Закрывается это только в самом
 * бинаре: main.js чистит окружение ДОЧЕРНИХ процессов, но не своё.
 *
 * ПОЧЕМУ ЗДЕСЬ. Хук afterPack срабатывает при любом способе запуска electron-builder (в отличие от
 * npm-скрипта) и ДО rcedit и подписи: правка после подписи сломала бы Authenticode. На macOS
 * хук зовётся трижды — на слайс x64, на слайс arm64 и на склеенный universal-пакет; правка
 * идемпотентна, а ad-hoc подпись (или настоящая подпись electron-builder) идёт после неё.
 *
 * ПОЧЕМУ ПАКЕТ, А НЕ СВОЙ ПАТЧЕР. Правит байты официальный @electron/fuses (закреплён точно, у
 * него нет зависимостей и install-скриптов). Но верит ему хук не на слово:
 *   • до правки бинарь читается НЕЗАВИСИМЫМ читателем из tools/verify-fuses.js (тем же, что у
 *     финального гейта): нет sentinel, чужая версия проводки, обрезанная проводка, два sentinel с
 *     разным содержимым — отказ, файл не тронут;
 *   • после правки тот же читатель обязан увидеть три fuse выключенными, а размер файла, число
 *     проводок и КАЖДЫЙ остальной флаг — прежними (чужие fuse в этой волне не трогаем:
 *     GrantFileProtocolExtraPrivileges нужен рендереру на file://, ASAR-fuse требуют поддержки
 *     упаковщика);
 *   • индексы читателя сверяются с FuseV1Options пакета при каждом запуске.
 * Любой сбой — бросок: electron-builder останавливает сборку, exe с включёнными fuse не появится.
 *
 * Бинарь правится прямо в папке сборки (appOutDir). Это копия, но проверка nlink стоит на случай
 * жёстких ссылок на общий кэш Electron: правка через них испортила бы кэш для всех сборок.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const vf = require('./verify-fuses.js');
const adhoc = require('./mac-adhoc-sign.js');

const LIB = '@electron/fuses';

/**
 * Загружает пакет. Он только ESM — берём import(). У import() нет NODE_PATH, у require.resolve
 * есть: запасной путь нужен запуску без node_modules рядом с проектом (рабочие копии, тесты).
 */
async function loadFusesLib(spec) {
  const name = spec || LIB; // параметр — только для теста «пакета нет»
  const errs = [];
  try { return await import(name); } catch (e) { errs.push(e); }
  try { return await import(pathToFileURL(require.resolve(name)).href); } catch (e) { errs.push(e); }
  throw new Error('[fuses] не загружается пакет ' + name + ' (' + errs.map((e) => e && e.message).join(' | ') + '). ' +
    'Он нужен сборке: выполни `npm ci` в корне проекта. Без него exe ушёл бы с включёнными RunAsNode и NODE_OPTIONS — ' +
    'сборка остановлена.');
}

/** Индексы нашего читателя обязаны совпадать с порядком fuse в пакете (иначе гейт смотрел бы не туда). */
function assertLibMatches(lib) {
  if (String(lib.FuseVersion && lib.FuseVersion.V1) !== String(vf.WIRE_VERSION)) {
    throw new Error('[fuses] пакет ' + LIB + ': версия проводки V1 = «' + (lib.FuseVersion && lib.FuseVersion.V1) +
      '», а читатель гейта знает ' + vf.WIRE_VERSION + ' — обнови tools/verify-fuses.js вместе с пакетом.');
  }
  for (const g of vf.GUARDED) {
    if (!lib.FuseV1Options || lib.FuseV1Options[g.name] !== g.index) {
      throw new Error('[fuses] пакет ' + LIB + ': FuseV1Options.' + g.name + ' = ' + (lib.FuseV1Options && lib.FuseV1Options[g.name]) +
        ', а читатель гейта ждёт индекс ' + g.index + ' — порядок fuse разошёлся, гейт смотрел бы не в тот байт.');
    }
  }
}

/** Fail-fast для beforePack: без пакета хук упал бы только ПОСЛЕ получасовой упаковки. */
async function assertReady() {
  const lib = await loadFusesLib();
  assertLibMatches(lib);
  return lib;
}

/** Какие бинари править в собранном приложении. @returns {Array<{kind:'exe'|'framework', file:string}>} */
function binariesFor(context) {
  const platform = context && context.electronPlatformName;
  const name = context.packager.appInfo.productFilename;
  if (platform === 'win32') {
    return [{ kind: 'exe', file: path.join(context.appOutDir, name + '.exe') }];
  }
  if (platform === 'darwin' || platform === 'mas') {
    // Проводка живёт в Electron Framework, а не в основном исполняемом файле.
    const app = path.join(context.appOutDir, name + '.app');
    const files = vf.macFrameworkFiles(app);
    if (!files.length) {
      throw new Error('[fuses] в ' + app + ' нет Electron Framework (Contents/Frameworks/Electron Framework.framework/' +
        'Versions/A/Electron Framework) — fuse гасить негде, сборка остановлена.');
    }
    return files.map((file) => ({ kind: 'framework', file }));
  }
  throw new Error('[fuses] платформа «' + platform + '» не поддержана: гасить fuse умеем только в Windows- и macOS-сборке, ' +
    'а выпускать бинарь с заводскими fuse нельзя. Сборка остановлена.');
}

/** Проверки ДО правки: бинарь читается так, как ждёт гейт, иначе отказ без записи. */
function precheck(scan, kind, file) {
  if (!scan.wires.length) {
    throw new Error('[fuses] ' + file + ': не найден sentinel fuse-проводки — это не Electron ≥ 12 или файл повреждён. Файл не тронут.');
  }
  const max = kind === 'exe' ? 1 : 2; // universal-слайсы macOS дают две проводки, в exe — только одна
  if (scan.wires.length > max) {
    throw new Error('[fuses] ' + file + ': sentinel встречается ' + scan.wires.length + ' раз (допустимо не больше ' + max +
      ') — какая проводка настоящая, неизвестно. Файл не тронут.');
  }
  for (const w of scan.wires) {
    if (w.version !== vf.WIRE_VERSION) {
      throw new Error('[fuses] ' + file + ' (+' + w.offset + '): неизвестная версия проводки ' + w.version + ' (знаю ' + vf.WIRE_VERSION +
        ') — порядок fuse не определён. Файл не тронут.');
    }
    if (w.truncated || w.length <= vf.MAX_GUARDED_INDEX) {
      throw new Error('[fuses] ' + file + ' (+' + w.offset + '): проводка слишком короткая (' + w.length + ' флагов, в файле ' + w.states.length +
        ') для fuse с индексом ' + vf.MAX_GUARDED_INDEX + '. Файл не тронут.');
    }
  }
  if (scan.wires.length === 2) {
    const [a, b] = scan.wires;
    if (a.length !== b.length || !a.states.equals(b.states)) {
      throw new Error('[fuses] ' + file + ': две проводки с РАЗНЫМ содержимым (+' + a.offset + ' и +' + b.offset +
        ') — слайсы собраны из разных Electron или файл правили руками. Файл не тронут.');
    }
  }
}

/** Проверки ПОСЛЕ правки: три fuse выключены, всё остальное в проводке и размер файла прежние. */
function postcheck(before, after, file) {
  if (after.size !== before.size) {
    throw new Error('[fuses] ' + file + ': размер файла изменился (' + before.size + ' → ' + after.size + ') — правка вышла за проводку.');
  }
  if (after.wires.length !== before.wires.length) {
    throw new Error('[fuses] ' + file + ': число проводок изменилось (' + before.wires.length + ' → ' + after.wires.length + ').');
  }
  const guarded = new Set(vf.GUARDED.map((g) => g.index));
  after.wires.forEach((w, i) => {
    const was = before.wires[i];
    if (w.offset !== was.offset || w.version !== was.version || w.length !== was.length) {
      throw new Error('[fuses] ' + file + ': заголовок проводки #' + i + ' изменился — правка задела не то.');
    }
    for (let k = 0; k < w.length; k++) {
      if (!guarded.has(k) && w.states[k] !== was.states[k]) {
        throw new Error('[fuses] ' + file + ': fuse #' + k + ' изменился (' + vf.stateLabel(was.states[k]) + ' → ' + vf.stateLabel(w.states[k]) +
          '), а в этой волне трогаем только RunAsNode, NODE_OPTIONS и --inspect.');
      }
    }
    const v = vf.judgeWire(w);
    if (!v.ok) {
      throw new Error('[fuses] ' + file + ': после правки fuse всё ещё не выключены — ' + v.problems.join('; '));
    }
  });
}

/**
 * Только что скопированный 245-МБ exe на секунды берёт антивирус, и открытие на запись даёт EBUSY/
 * EPERM/EACCES. electron-builder сам повторяет rcedit и подпись по той же причине. Повтор безопасен:
 * правка ставит СОСТОЯНИЯ (а не переключает), так что вторая попытка ничего не удваивает. Прочие
 * ошибки — сразу наружу.
 */
async function withRetry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 2 || !e || !/^(EBUSY|EPERM|EACCES)$/.test(e.code)) throw e;
      console.log('[fuses] ' + e.code + ' (файл занят?) — повтор ' + (i + 1) + ' из 2');
      await new Promise((r) => setTimeout(r, 300 * (i + 1) * (i + 1)));
    }
  }
}

/** Гасит три fuse в одном файле (идемпотентно). */
async function flipFile(lib, file, kind) {
  let st;
  try { st = fs.statSync(file); } catch (e) {
    throw new Error('[fuses] нет бинаря Electron: ' + file + ' (' + e.message + ')');
  }
  if (!st.isFile()) throw new Error('[fuses] ' + file + ' — не файл.');
  if (st.nlink > 1) {
    throw new Error('[fuses] ' + file + ': у файла ' + st.nlink + ' жёсткие ссылки — правка на месте испортила бы общий кэш Electron ' +
      'для всех сборок. Собирай без USE_HARD_LINKS=true.');
  }
  const before = vf.scanFile(file);
  precheck(before, kind, file);
  const names = vf.GUARDED.map((g) => g.name).join(', ');
  if (before.wires.every((w) => vf.judgeWire(w).ok)) {
    console.log('[fuses] ' + path.basename(file) + ': ' + names + ' уже выключены — правка не нужна');
    return;
  }
  const was = before.wires.map((w) => vf.GUARDED.map((g) => g.name + '=' + vf.stateLabel(w.states[g.index])).join(', '));
  await withRetry(() => lib.flipFuses(file, {
    version: lib.FuseVersion.V1,
    [lib.FuseV1Options.RunAsNode]: false,
    [lib.FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [lib.FuseV1Options.EnableNodeCliInspectArguments]: false,
  }));
  const after = vf.scanFile(file);
  postcheck(before, after, file);
  console.log('[fuses] ' + path.basename(file) + ': ' + names + ' выключены в ' + after.wires.length + ' проводк' +
    (after.wires.length === 1 ? 'е' : 'ах') + ' (было: ' + was[0] + '); остальные fuse не тронуты');
}

/** Шаг 1 хука: fuse. */
async function flipFuses(context) {
  const lib = await assertReady();
  const targets = binariesFor(context);
  console.log('[fuses] ' + context.electronPlatformName + ': гашу RunAsNode, NODE_OPTIONS и --inspect в ' + targets.length +
    ' бинар' + (targets.length === 1 ? 'е' : 'ях') + ' (до rcedit и подписи)');
  for (const t of targets) await flipFile(lib, t.file, t.kind);
}

/**
 * electron-builder зовёт хук с одним аргументом; второй нужен тестам, чтобы подсмотреть порядок
 * (к моменту ad-hoc подписи fuse уже должны быть выключены).
 */
async function afterPack(context, deps) {
  const d = Object.assign({ adhoc: adhoc.default }, deps);
  await flipFuses(context);
  await d.adhoc(context);
}

exports.default = afterPack;
exports.precheck = precheck;
exports.postcheck = postcheck;
exports.assertReady = assertReady;
exports.loadFusesLib = loadFusesLib;
exports.assertLibMatches = assertLibMatches;
exports.binariesFor = binariesFor;
exports.flipFile = flipFile;
exports.flipFuses = flipFuses;
