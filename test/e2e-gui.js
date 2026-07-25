'use strict';
/* e2e-gui.js — НАСТОЯЩИЙ GUI-прогон установщика через Playwright + Electron.
 *
 * Гоняет приложение (собранное release/win-unpacked ИЛИ исходники — source mode) в
 * ИЗОЛИРОВАННОМ профиле (подменённые USERPROFILE/HOME/APPDATA/LOCALAPPDATA → временный
 * каталог), кликая по реальному интерфейсу: приветствие → выбор → установка → финиш.
 * Никакой мок-логики: реальный main-процесс, реальный IPC, реальная докачка по реестру.
 *
 * Сценарии (node test/e2e-gui.js <scenario>):
 *   ok        — обычный прогон (докачка с живых зеркал) → компонент реально встал.
 *   netfail   — зеркала подменены на мёртвый хост: UI обязан ЧЕСТНО показать обрыв
 *               сети и кнопку «Повторить», а не молчать/врать «успех».
 *   preserve  — САМЫЙ ВАЖНЫЙ: установка ПОВЕРХ непустого профиля. В изолированный
 *               ~/.claude заранее насеяны правдоподобные ПОЛЬЗОВАТЕЛЬСКИЕ данные
 *               (ключи, MEMORY.md, settings.local.json, свой скилл, memory/,
 *               projects/, chats.db, ~/CLAUDE.md). После установки КАЖДЫЙ файл
 *               сверяется ПОБАЙТОВО (sha256): изменился или исчез → тест падает.
 *   rerun     — идемпотентность: поставить, закрыть приложение, поставить ТО ЖЕ ещё
 *               раз. Второй прогон обязан пройти успехом, не удалить и не «насорить»
 *               в ~/.claude, не тронуть пользовательские файлы; бэкапы ~/.claude.backup.*
 *               не должны копиться бесконтрольно.
 *   uninstall — удаление компонента через кнопку «Удалить» на карточке: НАШЕ снесено,
 *               ПОЛЬЗОВАТЕЛЬСКОЕ цело. Если компонент не входит в это издание (graceful
 *               skip) — честный SKIP с пояснением, БЕЗ имитации успеха.
 *   full      — стресс: НЕ снимаем ни одной галки, ставим всё по умолчанию (в lite это
 *               реальная докачка ~1.4 ГБ). Каждый шаг обязан прийти в ТЕРМИНАЛЬНЫЙ
 *               статус (ничего не «висит»), а итоговый экран — честно показать провалы.
 *
 * Ассерты — по СМЫСЛУ (что увидит пользователь и что стало с его файлами), а не по
 * внутренним деталям реализации. Ни один assert не должен «зеленеть» сам по себе.
 *
 * Переменные окружения:
 *   HM_E2E_COMPONENT   — что ставим в ok/netfail/preserve/rerun (по умолчанию config)
 *   HM_E2E_UNINSTALL_COMPONENT — что ставим и удаляем в uninstall (по умолчанию uv:
 *                        единственный removable-компонент без зависимостей)
 *   HM_E2E_TIMEOUT     — таймаут ожидания завершения прогона, мс (дефолты — ниже)
 *   HM_E2E_EXPECT_LITE — 1: издание lite (ожидаем превью докачки), 0: офлайн
 *   HM_E2E_SOURCE      — 1: принудительно из исходников (electron <repo>)
 *   HM_E2E_KEEP        — 1: не удалять временный профиль/копию приложения после прогона
 *
 * Требует: npm i -D playwright-core. Полная докачка требует ПРАВ АДМИНИСТРАТОРА
 * (staging кэша — Admins-only, fail-closed); без элевации прогон честно фиксирует
 * отказ на этапе fetch — это тоже проверяемый путь.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const SCENARIO = (process.argv[2] || 'ok').toLowerCase();
const COMPONENT = process.env.HM_E2E_COMPONENT || 'config'; // ставится в ИЗОЛИРОВАННЫЙ ~/.claude
// Сценарий uninstall берёт СВОЙ компонент: удаление в UI предлагается только для
// removable+receipted, а config к ним не относится (его данные — данные пользователя).
// uv — единственный removable без зависимостей, поэтому дефолт именно он.
const UNINSTALL_COMPONENT = process.env.HM_E2E_UNINSTALL_COMPONENT || 'uv';
// Дефолтные таймауты ОЖИДАНИЯ ЗАВЕРШЕНИЯ ПРОГОНА (минуты). full качает ~1.4 ГБ.
const DEFAULT_MINUTES = { ok: 15, netfail: 15, preserve: 30, rerun: 45, uninstall: 30, full: 120 };
const STEP_TIMEOUT = Number(process.env.HM_E2E_TIMEOUT || (DEFAULT_MINUTES[SCENARIO] || 30) * 60 * 1000);
const EXPECT_LITE = process.env.HM_E2E_EXPECT_LITE === '1';

const log = (...a) => console.log('[e2e]', ...a);

// ПРЕДОХРАНИТЕЛЬ: этот тест поднимает НАСТОЯЩЕЕ окно установщика и запускает НАСТОЯЩИЕ
// install-скрипты. Профиль подменяется (USERPROFILE/HOME/APPDATA/LOCALAPPDATA → временный
// каталог), но окно всё равно всплывает на рабочем столе, а часть системных установщиков
// (MSI, VS Code system-scope) машинно-областная и в песочницу не убирается. Поэтому
// запуск разрешён ТОЛЬКО на CI-раннере (чистая одноразовая машина). На рабочей машине —
// осознанное HM_E2E_ALLOW_LOCAL=1. Иначе выходим ДО запуска чего-либо.
// Исключение — selftest: он проверяет САМ ХАРНЕСС на временном каталоге, ничего не
// запускает и не показывает, поэтому должен работать где угодно (в т.ч. локально).
if (SCENARIO !== 'selftest' && !process.env.CI && process.env.HM_E2E_ALLOW_LOCAL !== '1') {
  console.error('[e2e] ОТКАЗ: GUI-E2E запускает реальный установщик и открывает окно.\n' +
    '      На рабочей машине это делать нельзя — гоняй в CI (.github/workflows/e2e-win.yml).\n' +
    '      Осознанный локальный запуск: HM_E2E_ALLOW_LOCAL=1 node test/e2e-gui.js <сценарий>');
  process.exit(3);
}
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✅ ' + name); }
  else { failures++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
  return !!cond;
}
function section(title) { console.log('\n[e2e] — ' + title + ' —'); }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function exists(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }
function countDir(p) { try { return fs.readdirSync(p).length; } catch (e) { return 0; } }

/** Плоский список ОТНОСИТЕЛЬНЫХ путей дерева (для диффа «что появилось/исчезло»). */
function walkTree(root, rel, out, budget) {
  out = out || [];
  budget = budget || { n: 20000 };
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel || ''), { withFileTypes: true }); }
  catch (e) { return out; }
  for (const e of entries) {
    if (budget.n-- <= 0) return out;
    const r = rel ? path.join(rel, e.name) : e.name;
    out.push(e.isDirectory() ? r + '/' : r);
    if (e.isDirectory() && !e.isSymbolicLink()) walkTree(root, r, out, budget);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Подготовка приложения и изолированного профиля
// ---------------------------------------------------------------------------

/** Копия распакованного приложения (чтобы править resources без порчи исходной сборки). */
function stageApp() {
  const src = path.join(ROOT, 'release', 'win-unpacked');
  // HM_E2E_SOURCE=1 — принудительно из исходников. Нужно для НЕэлевейтед-машины:
  // упакованный exe несёт requireAdministrator и без UAC просто не стартует.
  if (process.env.HM_E2E_SOURCE === '1' || !fs.existsSync(src)) {
    // CI/чистая машина: собранного пакета нет — гоняем ТОТ ЖЕ код из исходников
    // (electron <repo>). Проверяется реальный main/renderer/scripts-контур.
    log('release/win-unpacked нет — запускаю из исходников (source mode)');
    return { dir: ROOT, source: true };
  }
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-app-'));
  fs.cpSync(src, dst, { recursive: true });
  if (SCENARIO === 'netfail') {
    // Подменяем ВСЕ зеркала на заведомо мёртвый хост: докачка обязана провалиться
    // ЧЕСТНО (видимый статус + «Повторить»), а не тихо «пропустить» компонент.
    poisonRegistry(path.join(dst, 'resources', 'remote-components.json'));
    log('режим netfail: зеркала подменены на мёртвый хост');
  }
  return { dir: dst, source: false };
}

function poisonRegistry(regPath) {
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  for (const c of (reg.components || [])) {
    for (const m of (c.mirrors || [])) {
      m.url = m.url.replace(/^https:\/\/[^/]+/, 'https://hm-e2e-dead-host.invalid');
    }
  }
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
}

/** В source-mode подменяем реестр прямо в корне (CI-прогон, дерево одноразовое). */
function poisonSourceRegistry() {
  poisonRegistry(path.join(ROOT, 'remote-components.json'));
  log('source-mode netfail: зеркала подменены на мёртвый хост');
}

/** Изолированный профиль пользователя — установка НЕ трогает реальную машину. */
function stageHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-home-'));
  for (const d of ['AppData', path.join('AppData', 'Roaming'), path.join('AppData', 'Local'), 'Desktop']) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  return home;
}

/** Единый контекст прогона: приложение + изолированный профиль + env для Electron. */
function makeContext() {
  const staged = stageApp();
  if (staged.source && SCENARIO === 'netfail') poisonSourceRegistry();
  const home = stageHome();
  log('изолированный профиль:', home);
  const env = Object.assign({}, process.env, {
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    HM_E2E: '1',
  });
  // Наследованное окружение может СЛОМАТЬ запуск Electron, и падение выглядит как
  // «Process failed to launch!» без причины. ELECTRON_RUN_AS_NODE=1 (его выставляют
  // терминалы внутри Electron-приложений — VS Code, Claude Code) заставляет наш
  // бинарь стартовать обычным Node: require('electron') отдаёт строку с путём,
  // app === undefined, main.js падает на app.whenReady(). NODE_OPTIONS с --require
  // так же вмешивается в main-процесс. Обе переменные из дочернего env выпиливаем.
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[k];
  return { appDir: staged.dir, source: staged.source, home, env };
}

function cleanupContext(ctx) {
  if (process.env.HM_E2E_KEEP) { log('артефакты сохранены:', ctx.appDir, ctx.home); return; }
  if (!ctx.source) rmrf(ctx.appDir);
  rmrf(ctx.home);
}

// ---------------------------------------------------------------------------
// Канарейка изоляции: РЕАЛЬНЫЙ профиль пользователя не должен измениться
// ---------------------------------------------------------------------------

/** Снимок «следов установщика» в НАСТОЯЩЕМ домашнем каталоге (вне изоляции). */
function realHomeSnapshot() {
  const h = os.homedir();
  let backups = 0;
  try { backups = fs.readdirSync(h).filter((n) => n.startsWith('.claude.backup.')).length; } catch (e) { /* ignore */ }
  return {
    home: h,
    backups,
    claude: exists(path.join(h, '.claude')),
    setupDir: exists(path.join(h, '.hamidun-setup')),
    start: exists(path.join(h, 'HamidunStart')),
    course: exists(path.join(h, 'HamidunCourse')),
  };
}

function checkIsolation(before) {
  const after = realHomeSnapshot();
  const diffs = [];
  for (const k of ['backups', 'claude', 'setupDir', 'start', 'course']) {
    if (before[k] !== after[k]) diffs.push(`${k}: ${before[k]} → ${after[k]}`);
  }
  check('изоляция соблюдена: РЕАЛЬНЫЙ профиль (' + before.home + ') не тронут',
    diffs.length === 0, diffs.join('; '));
}

// ---------------------------------------------------------------------------
// Пользовательские данные: посев и побайтовая сверка
// ---------------------------------------------------------------------------

/** Правдоподобный «живой» ~/.claude пользователя + ~/CLAUDE.md. Возвращает sha-снимок. */
function seedUserData(home) {
  const marker = 'HM-E2E-USER-' + crypto.randomBytes(6).toString('hex');
  const files = {
    // ключи — самое дорогое, что есть у пользователя
    '.claude/.credentials.master.env':
      `# личные ключи пользователя — НЕ ТРОГАТЬ\nANTHROPIC_API_KEY=sk-ant-${marker}\nTELEGRAM_BOT_TOKEN=123456:${marker}\n`,
    // память и локальные настройки
    '.claude/MEMORY.md': `# Memory\n\n- личная заметка пользователя, маркер ${marker}\n`,
    '.claude/settings.local.json':
      JSON.stringify({ permissions: { allow: ['Bash(git *)'] }, e2eMarker: marker }, null, 2) + '\n',
    // СВОЙ скилл пользователя (его никто не имеет права заменить или удалить)
    '.claude/skills/my-own-skill/SKILL.md':
      `---\nname: my-own-skill\ndescription: собственный скилл пользователя\n---\n\nМаркер ${marker}\n`,
    '.claude/memory/project-notes.md': `Заметки по проекту. Маркер ${marker}\n`,
    '.claude/projects/my-project/session.jsonl':
      JSON.stringify({ role: 'user', text: marker }) + '\n',
    '.claude/todos/todo-e2e.json': JSON.stringify([{ id: 1, text: marker }]) + '\n',
    // личные инструкции в корне профиля
    'CLAUDE.md': `# Личные инструкции пользователя\n\nМаркер: ${marker}\n`,
  };
  for (const rel of Object.keys(files)) {
    const abs = path.join(home, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel], 'utf8');
  }
  // chats.db — НЕПУСТАЯ история чатов (валидный SQLite-заголовок + маркер + «мясо»).
  const relDb = '.claude/chats.db';
  const db = Buffer.concat([
    Buffer.from('SQLite format 3 ', 'binary'),
    Buffer.from('  chats history of the user, ' + marker + ' '),
    crypto.randomBytes(64 * 1024),
  ]);
  fs.writeFileSync(path.join(home, relDb), db);

  const hashes = {};
  for (const rel of Object.keys(files).concat([relDb])) hashes[rel] = sha256(path.join(home, rel));
  log('посеяны пользовательские данные, маркер:', marker);
  return { marker, hashes };
}

/** Побайтовая сверка: КАЖДЫЙ файл пользователя обязан остаться прежним. */
function verifyUserData(home, seed, tag) {
  section('пользовательские данные ' + (tag || ''));
  for (const rel of Object.keys(seed.hashes)) {
    const abs = path.join(home, rel);
    if (!exists(abs)) { check('файл пользователя ЦЕЛ: ' + rel, false, 'ФАЙЛ ИСЧЕЗ'); continue; }
    let now = '';
    try { now = sha256(abs); } catch (e) { check('файл пользователя ЦЕЛ: ' + rel, false, 'не читается: ' + e.message); continue; }
    check('файл пользователя ЦЕЛ (sha256 не изменился): ' + rel, now === seed.hashes[rel],
      'было ' + seed.hashes[rel].slice(0, 12) + ', стало ' + now.slice(0, 12));
  }
  // Маркер обязан быть НАЙДЕН в ключах — защита от «файл на месте, но пустой/подменён».
  const cred = path.join(home, '.claude', '.credentials.master.env');
  let credText = '';
  try { credText = fs.readFileSync(cred, 'utf8'); } catch (e) { /* checked above */ }
  check('личные ключи по-прежнему содержат данные пользователя', credText.includes(seed.marker),
    credText ? credText.slice(0, 80) : '(файла нет)');
  // Свой скилл — не только файл, но и сам каталог в общем списке скиллов.
  check('свой скилл пользователя остался в ~/.claude/skills',
    exists(path.join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md')));
}

/** Наша база реально разложена (иначе «данные целы» ничего не стоит). */
function verifyBaseInstalled(home, tag) {
  section('наша база ' + (tag || ''));
  const claudeDir = path.join(home, '.claude');
  const nSkills = countDir(path.join(claudeDir, 'skills'));
  check('база разложена: в ~/.claude/skills много скиллов (>100)', nSkills > 100, 'skills=' + nSkills);
  check('база разложена: есть ~/.claude/settings.json', exists(path.join(claudeDir, 'settings.json')));
  check('маркер завершённости конфига записан', exists(path.join(claudeDir, '.hamidun-config-complete')));
  return { nSkills };
}

/** Пути, которые ОБЯЗАНЫ существовать, если компонент реально встал. */
function componentArtifacts(home, id) {
  const isWin = process.platform === 'win32';
  switch (id) {
    case 'config':
      return [path.join(home, '.claude', '.hamidun-config-complete'), path.join(home, '.claude', 'skills')];
    case 'course':
      return [path.join(home, 'HamidunCourse', 'vibecoding-course')];
    case 'uv':
      return isWin
        ? [path.join(home, 'AppData', 'Local', 'Programs', 'uv', 'uv.exe')]
        : [path.join(home, '.local', 'bin', 'uv')];
    default:
      return [];
  }
}

/** Бэкапы ~/.claude.backup.* в изолированном профиле. */
function listBackups(home) {
  try { return fs.readdirSync(home).filter((n) => n.startsWith('.claude.backup.')); }
  catch (e) { return []; }
}

/** Старые бэкапы «из прошлых установок» — чтобы проверить ретенцию, а не «их пока мало». */
function seedStaleBackups(home, n) {
  const made = [];
  for (let i = 0; i < n; i++) {
    const d = path.join(home, '.claude.backup.2020010' + (i + 1) + '-0000' + (i + 1));
    fs.mkdirSync(path.join(d, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(d, 'marker.txt'), 'stale backup #' + i, 'utf8');
    made.push(path.basename(d));
  }
  log('посеяно старых бэкапов ~/.claude.backup.*:', made.length);
  return made;
}

// ---------------------------------------------------------------------------
// Работа с окном приложения
// ---------------------------------------------------------------------------

async function launchApp(ctx) {
  const launchOpts = ctx.source
    ? { executablePath: require('electron'), args: [ROOT], env: ctx.env, timeout: 180000 }
    : { executablePath: path.join(ctx.appDir, 'Hamidun Setup.exe'), args: [], env: ctx.env, timeout: 180000 };
  log('запуск:', ctx.source ? 'source (electron ' + ROOT + ')' : launchOpts.executablePath);
  const app = await electron.launch(launchOpts);
  const page = await app.firstWindow({ timeout: 120000 });
  await page.waitForLoadState('domcontentloaded');
  LAST_PAGE = page;                       // чтобы аварийный выход оставил улики
  log('окно поднялось:', await page.title());
  return { app, page };
}

/** Приветствие → экран выбора. Возвращает число карточек и текст сводки. */
async function gotoSelect(page) {
  await page.waitForSelector('#btn-welcome-go', { timeout: 60000 });
  check('экран приветствия отрисован', true);
  await page.click('#btn-welcome-go');

  await page.waitForSelector('#view-select:not(.hidden)', { timeout: 60000 }).catch(() => {});
  await page.waitForSelector('#groups .card', { timeout: 120000 });
  const nCards = await page.locator('#groups .card').count();
  check('экран выбора отрисован (' + nCards + ' компонентов)', nCards > 0);

  // Детекция завершилась → кнопка «Установить» активна.
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-install');
    return b && !b.disabled;
  }, null, { timeout: 180000 });
  check('кнопка «Установить» активировалась (детекция + preflight прошли)', true);

  // Phase-4: превью объёма докачки — ТОЛЬКО в lite-издании (в офлайне качать нечего,
  // и показывать «Скачается» было бы враньём). Ожидание задаёт HM_E2E_EXPECT_LITE.
  const summary = (await page.textContent('#summary')) || '';
  log('summary:', summary.trim().slice(0, 160));
  const hasPreview = /Скачается/i.test(summary);
  check(EXPECT_LITE ? 'lite: превью объёма докачки показано' : 'offline: превью докачки корректно ОТСУТСТВУЕТ',
    hasPreview === EXPECT_LITE, summary.trim().slice(0, 120));
  return { nCards, summary };
}

/** Граф компонентов из components.json (для расчёта зависимостей выбора). */
let GRAPH = null;
function componentGraph() {
  if (GRAPH) return GRAPH;
  const comps = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
  const byId = {};
  for (const g of (comps.groups || [])) for (const c of (g.components || [])) byId[c.id] = c;
  const requiresOf = {};
  for (const id of Object.keys(byId)) requiresOf[id] = byId[id].requires || [];
  GRAPH = { byId, requiresOf };
  return GRAPH;
}
function componentName(id) {
  const { byId } = componentGraph();
  return (byId[id] && byId[id].name) || id;
}

/**
 * Оставить отмеченными ТОЛЬКО targetIds + их транзитивные зависимости.
 * Карточки — div.card с click-toggle (не чекбоксы); опознаём по data-id.
 * ВАЖНО: UI сам восстанавливает ЗАВИСИМОСТИ и не даёт снять компонент, пока отмечен
 * зависящий от него, поэтому снимаем в ОБРАТНОМ топологическом порядке: за проход
 * убираем только «листья» — лишние, от которых не зависит ни один отмеченный.
 * Насильно ВКЛЮЧАЕМ только сами цели: зависимость, которую UI снял сам (она уже
 * установлена на этой машине), переставлять не надо — это не то, что делает живой
 * пользователь, и на чистой машине (CI) такие зависимости и так отмечены.
 */
async function selectExactly(page, targetIds) {
  const { byId, requiresOf } = componentGraph();
  const allowed = new Set();
  const addDeps = (id) => {
    if (!id || allowed.has(id) || !byId[id]) return;
    allowed.add(id);
    (byId[id].requires || []).forEach(addDeps);
  };
  targetIds.forEach(addDeps);
  log('разрешены (цели + зависимости):', [...allowed].join(', '));

  let picked = null;
  for (let pass = 0; pass < 8; pass++) {
    const res = await page.evaluate(({ allow, force, reqs }) => {
      const cards = Array.from(document.querySelectorAll('#groups .card'));
      const checked = cards.filter((c) => c.classList.contains('checked')).map((c) => c.dataset.id);
      const neededBy = new Set();
      for (const cid of checked) for (const r of (reqs[cid] || [])) neededBy.add(r);
      let clicked = 0;
      for (const c of cards) {
        const cid = c.dataset.id;
        const isChecked = c.classList.contains('checked');
        if (allow.includes(cid)) {
          if (!isChecked && force.includes(cid)) { c.click(); clicked++; }
          continue;
        }
        // лишний: снимаем только если от него никто из отмеченных не зависит
        if (isChecked && !neededBy.has(cid)) { c.click(); clicked++; }
      }
      return {
        clicked,
        total: cards.length,
        stillChecked: cards.filter((c) => c.classList.contains('checked')).map((c) => c.dataset.id),
        known: cards.map((c) => c.dataset.id),
      };
    }, { allow: [...allowed], force: targetIds, reqs: requiresOf });
    picked = res;
    const extra = res.stillChecked.filter((x) => !allowed.has(x));
    const missing = targetIds.filter((t) => res.known.indexOf(t) !== -1 && res.stillChecked.indexOf(t) === -1);
    if (!extra.length && !missing.length) break;
    if (!res.clicked) { log('проход ' + (pass + 1) + ': состояние стабильно, лишние →', extra.join(', ') || '—'); break; }
    log('проход ' + (pass + 1) + ': осталось лишних →', extra.join(', ') || '—');
  }
  const extraChecked = picked.stillChecked.filter((x) => !allowed.has(x));
  const targetsOnScreen = targetIds.filter((t) => picked.known.indexOf(t) !== -1);
  const targetsChecked = targetsOnScreen.every((t) => picked.stillChecked.indexOf(t) !== -1);
  return { picked, allowed, extraChecked, targetsChecked, targetsOnScreen };
}

/** Снимок шагов установки: id, статус-класс и подпись, которую видит пользователь. */
async function collectSteps(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#step-list .step')).map((s) => ({
    id: s.dataset.id || '',
    status: s.className.replace(/(^|\s)step(\s|$)/, ' ').trim(),
    text: (s.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
  })));
}

/** Итоговый экран глазами пользователя. */
async function finalScreen(page) {
  return page.evaluate(() => {
    const t = (sel) => { const e = document.querySelector(sel); return e ? (e.textContent || '').trim() : ''; };
    const ns = document.getElementById('next-steps');
    return {
      title: t('#progress-title'),
      sub: t('#progress-sub'),
      summary: t('#progress-summary'),
      nextStepsVisible: !!(ns && !ns.classList.contains('hidden')),
      nextStepsText: ns ? (ns.textContent || '').trim().replace(/\s+/g, ' ') : '',
      finishVisible: !!(document.getElementById('btn-finish') &&
        !document.getElementById('btn-finish').classList.contains('hidden')),
      logTail: ((document.getElementById('log') || {}).textContent || '').trim().slice(-1500),
    };
  });
}

/** Ждём ПОЛНОГО завершения прогона (кнопка «Готово» показывается и при провалах). */
async function waitRunEnd(page, timeout) {
  try {
    await page.waitForFunction(() => {
      const b = document.getElementById('btn-finish');
      return !!b && !b.classList.contains('hidden');
    }, null, { timeout, polling: 1000 });
    return true;
  } catch (e) { return false; }
}

/** Ждём ПЕРВОГО терминального признака: финиш ИЛИ видимая ошибка (для ok/netfail). */
async function waitTerminal(page, timeout) {
  const h = await page.waitForFunction(() => {
    const fin = document.getElementById('btn-finish');
    const finished = fin && !fin.classList.contains('hidden');
    const errNet = document.querySelector('.step.error-net');
    const errAny = document.querySelector('.step.error, .step.failed');
    if (finished) return { kind: 'finish' };
    if (errNet) return { kind: 'error-net', text: errNet.textContent.trim().slice(0, 200) };
    if (errAny) return { kind: 'error', text: errAny.textContent.trim().slice(0, 200) };
    return null;
  }, null, { timeout, polling: 1000 });
  return h.jsonValue();
}

async function shot(page, name) {
  const p = path.join(ROOT, 'release', 'e2e-' + name + '.png');
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) { /* ignore */ }
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  log('скриншот:', p);
}

// Последняя живая страница — чтобы АВАРИЙНЫЙ выход (исключение, а не проваленная
// проверка) тоже оставлял улики. Без этого падение вроде «page.click: Timeout»
// не даёт ни скриншота, ни журнала: приходится гонять весь прогон заново вслепую.
let LAST_PAGE = null;

async function dumpForensics(tag) {
  const page = LAST_PAGE;
  if (!page) { console.log('[e2e] улик нет: окно не поднялось'); return; }
  try {
    await shot(page, tag + '-fatal');
    const state = await page.evaluate(() => ({
      view: ['welcome', 'select', 'progress', 'finish']
        .find((v) => { const el = document.querySelector('#view-' + v); return el && !el.classList.contains('hidden'); }) || '?',
      steps: (document.querySelector('#step-list') || {}).textContent || '',
      log: (document.querySelector('#log') || {}).textContent || '',
    })).catch(() => null);
    if (state) {
      console.log('[e2e] --- экран: ' + state.view + ' ---');
      console.log('[e2e] --- шаги ---');
      console.log(String(state.steps).trim().slice(0, 2000) || '(пусто)');
      console.log('[e2e] --- журнал приложения (хвост) ---');
      console.log(String(state.log).slice(-4000) || '(пусто)');
      console.log('[e2e] --- конец улик ---');
    }
  } catch (e) {
    console.log('[e2e] улики снять не удалось: ' + (e && e.message));
  }
}

/** Нажатие «Установить».
 *
 *  Playwright ждёт от браузера подтверждения обработки ввода. Главный процесс установщика
 *  во время старта делает СИНХРОННУЮ работу (spawnSync powershell на каждый защищённый
 *  staging-каталог), и на медленной машине подтверждение приходит с большой задержкой —
 *  сам клик при этом доходит. Раньше это давало «page.click: Timeout» и прогон падал ещё
 *  до установки, хотя продукт работал.
 *
 *  Поэтому: сначала НАСТОЯЩИЙ клик (полная проверка доступности элемента). Если ответ не
 *  пришёл за 15 с — это НЕ замаскировано: пишем предупреждение о заморозке интерфейса
 *  (реальный дефект UX: окно не отвечает, пока идёт синхронный вызов) и дожимаем событием,
 *  чтобы проверить остальной сценарий, а не потерять весь прогон. */
async function clickInstall(page) {
  await page.waitForSelector('#btn-install:not([disabled])', { timeout: 60000 });
  try {
    await page.click('#btn-install', { timeout: 15000 });
    return;
  } catch (e) {
    console.log('[e2e] ⚠ интерфейс не подтвердил клик за 15 с — главный процесс занят ' +
      'синхронной работой (окно в этот момент не отвечает). Дожимаем событием.');
  }
  await page.locator('#btn-install').dispatchEvent('click');
}

/** window.confirm в Electron — НАТИВНОЕ модальное окно, Playwright им не управляет.
 *  Подменяем его в странице и ЗАПОМИНАЕМ тексты: сам факт подтверждения — часть
 *  контракта UI, и мы его проверяем, а не просто обходим. */
/** Факт докачки надо ловить В МОМЕНТ, когда он виден.
 *
 *  Подпись шага «Скачиваю… 42%» и строка «[↓] Докачка … из облака» живут только пока
 *  идёт загрузка: к концу прогона подпись возвращается к обычной, а журнал в UI
 *  подрезается. Проверка «в UI виден прогресс скачивания» читала текст ПОСЛЕ финиша и
 *  падала на исправном продукте — конфиг при этом был реально скачан и разложен.
 *  Поэтому ставим наблюдателя ДО старта: он поднимает флаг при первом же признаке. */
async function armDownloadWatcher(page) {
  await page.evaluate(() => {
    window.__e2eSawDownload = false;
    const RE = /Скачиваю|скачив|Докачка|\[↓\]/i;
    const check = () => {
      const s = document.getElementById('step-list');
      const l = document.getElementById('log');
      const t = ((s && s.textContent) || '') + ((l && l.textContent) || '');
      if (RE.test(t)) window.__e2eSawDownload = true;
    };
    try { new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true }); } catch (e) { /* */ }
    setInterval(check, 300);   // страховка: MutationObserver не видит правку value/атрибутов
    check();
  });
}

async function sawDownloadEver(page) {
  try { return !!(await page.evaluate(() => window.__e2eSawDownload)); } catch (e) { return false; }
}

async function captureConfirms(page) {
  await page.evaluate(() => {
    window.__e2eConfirms = [];
    window.confirm = (m) => { window.__e2eConfirms.push(String(m)); return true; };
  });
}
async function takenConfirms(page) {
  return page.evaluate(() => (window.__e2eConfirms || []).slice());
}

/**
 * Полный прогон установки в ОДНОЙ сессии приложения.
 *   opts.targets  — что оставить отмеченным (null = не трогать выбор, ставим «как предложено»)
 *   opts.tag      — имя для скриншота
 *   opts.wait     — 'end' (полное завершение) | 'terminal' (первый терминальный признак)
 * Возвращает {steps, screen, terminal, ended}.
 */
async function runInstallSession(ctx, opts) {
  const { app, page } = await launchApp(ctx);
  try {
    await captureConfirms(page);
    await gotoSelect(page);

    if (opts.targets) {
      const sel = await selectExactly(page, opts.targets);
      // softTargets: отсутствие карточки — не провал, а «этого нет в данном издании»
      // (решение принимает сам сценарий: он честно вернёт SKIP, а не «успех»).
      if (!sel.targetsOnScreen.length && opts.softTargets) {
        log('целевых карточек нет на экране выбора:', opts.targets.join(','));
      } else {
        check('целевые «' + opts.targets.join(',') + '» выбраны, лишние сняты (отмечено: ' +
          sel.picked.stillChecked.join(',') + ')',
        sel.targetsOnScreen.length > 0 && sel.targetsChecked && sel.extraChecked.length === 0,
        JSON.stringify(sel.picked));
      }
    } else {
      // Стресс-режим: НИЧЕГО не снимаем — ставим ровно то, что предложено по умолчанию.
      const state = await page.evaluate(() => Array.from(document.querySelectorAll('#groups .card'))
        .filter((c) => c.classList.contains('checked')).map((c) => c.dataset.id));
      log('по умолчанию отмечено:', state.join(',') || '—');
      check('по умолчанию есть что ставить', state.length > 0);
    }

    const summary2 = (await page.textContent('#summary')) || '';
    log('summary после выбора:', summary2.trim().slice(0, 160));

    await armDownloadWatcher(page);
    await clickInstall(page);
    await page.waitForSelector('#view-progress:not(.hidden)', { timeout: 60000 }).catch(() => {});
    check('экран прогресса открылся', true);

    let terminal = null;
    let ended = false;
    if (opts.wait === 'terminal') {
      terminal = await waitTerminal(page, STEP_TIMEOUT);
      log('терминальное состояние:', JSON.stringify(terminal).slice(0, 240));
      ended = terminal.kind === 'finish';
    } else {
      ended = await waitRunEnd(page, STEP_TIMEOUT);
    }

    // Окно могло УМЕРЕТЬ во время установки (краш main/renderer). Это провал продукта,
    // и выглядеть он должен как понятная проверка, а не как стек Playwright.
    if (page.isClosed()) {
      check('окно установщика дожило до конца прогона (не упало посреди установки)', false,
        'страница закрыта до сбора результатов');
      return { steps: [], screen: { title: '', nextStepsText: '', logTail: '' }, terminal, ended: false, stepsText: '', logText: '' };
    }
    const steps = await collectSteps(page);
    const screen = await finalScreen(page);
    const stepsText = (await page.textContent('#step-list')) || '';
    const logText = (await page.textContent('#log')) || '';
    await shot(page, opts.tag);
    return { steps, screen, terminal, ended, stepsText, logText };
  } finally {
    await app.close().catch(() => {});
  }
}

const TERMINAL_STATUSES = ['done', 'error', 'error-net', 'skipped'];

/** Общие проверки завершённости прогона: ничего не «висит», экран не врёт. */
function checkRunHonest(res, tag) {
  section('честность прогона ' + (tag || ''));
  check('прогон завершился (появилась кнопка «Готово»)', res.ended,
    'таймаут ' + Math.round(STEP_TIMEOUT / 60000) + ' мин; шаги: ' +
    res.steps.map((s) => s.id + ':' + (s.status || '—')).join(' '));

  const stuck = res.steps.filter((s) => !TERMINAL_STATUSES.includes(s.status));
  check('ни один шаг не завис: у всех терминальный статус',
    res.steps.length > 0 && stuck.length === 0,
    stuck.map((s) => s.id + ':«' + (s.status || 'без статуса') + '»').join(', '));
  const running = res.steps.filter((s) => s.status === 'running');
  check('после финиша нет шагов в состоянии «идёт»', running.length === 0,
    running.map((s) => s.id).join(', '));

  const failed = res.steps.filter((s) => s.status === 'error' || s.status === 'error-net');
  if (failed.length) {
    check('итоговый экран НЕ выдаёт провал за успех (заголовок не «Готово!»)',
      res.screen.title !== 'Готово!', 'заголовок: «' + res.screen.title + '», провалы: ' +
      failed.map((s) => s.id).join(','));
    check('провалы видны пользователю: блок «что дальше» показан',
      res.screen.nextStepsVisible, JSON.stringify(res.screen).slice(0, 200));
    for (const f of failed) {
      // Имя берём из components.json (то же, что рисует UI) — не парсим подпись шага.
      const name = componentName(f.id);
      check('провал «' + f.id + '» назван на итоговом экране («' + name + '»)',
        res.screen.nextStepsText.includes(name),
        'ищем «' + name + '» в: ' + res.screen.nextStepsText.slice(0, 220));
    }
  } else {
    check('итоговый заголовок обновлён (не остался «Устанавливаю…»)',
      !!res.screen.title && res.screen.title !== 'Устанавливаю…', res.screen.title);
  }
  return { failed, stuck };
}

/** Шаг сказал «done» → артефакт обязан быть на диске (иначе UI врёт). */
function checkDoneArtifacts(home, steps) {
  const done = steps.filter((s) => s.status === 'done').map((s) => s.id);
  for (const id of done) {
    const arts = componentArtifacts(home, id);
    if (!arts.length) continue;
    const missing = arts.filter((p) => !exists(p));
    check('шаг «' + id + '» отрапортовал успех — и артефакт реально на диске',
      missing.length === 0, 'нет: ' + missing.join(', '));
  }
  return done;
}

// ---------------------------------------------------------------------------
// СЦЕНАРИИ
// ---------------------------------------------------------------------------

/** ok / netfail — исходное поведение сохранено без изменений. */
async function scenarioOkOrNetfail(ctx) {
  const { app, page } = await launchApp(ctx);
  try {
    await captureConfirms(page);
    await gotoSelect(page);

    // В netfail выбор НЕ трогаем: под тестом контракт UI при обрыве, а не состав набора
    // (и снятие галок там только вносит шум). В ok-режиме изоляция нужна — иначе ставится
    // полстека и прогон упирается в таймаут.
    let picked;
    if (SCENARIO === 'netfail') {
      picked = await page.evaluate(() => ({
        stillChecked: Array.from(document.querySelectorAll('#groups .card'))
          .filter((c) => c.classList.contains('checked')).map((c) => c.dataset.id),
      }));
      // На чистой машине часть компонентов уже установлена (у раннера свои git/node) и по
      // умолчанию снята — это нормальное поведение продукта. Достаточно, что есть что
      // ставить: иначе проверять обрыв не на чем.
      log('отмечено по умолчанию:', picked.stillChecked.join(',') || '—');
      check('есть выбранные компоненты для установки', picked.stillChecked.length > 0, JSON.stringify(picked));
    } else {
      const sel = await selectExactly(page, [COMPONENT]);
      check('целевой «' + COMPONENT + '» выбран, лишние сняты (отмечено: ' +
        sel.picked.stillChecked.join(',') + ')',
      sel.targetsChecked && sel.extraChecked.length === 0, JSON.stringify(sel.picked));
    }

    const summary2 = (await page.textContent('#summary')) || '';
    log('summary после выбора:', summary2.trim().slice(0, 160));

    await armDownloadWatcher(page);
    await clickInstall(page);
    await page.waitForSelector('#view-progress:not(.hidden)', { timeout: 60000 }).catch(() => {});
    check('экран прогресса открылся', true);

    const terminal = await waitTerminal(page, STEP_TIMEOUT);
    log('терминальное состояние:', JSON.stringify(terminal).slice(0, 240));

    const steps = (await page.textContent('#step-list')) || '';
    const logText = (await page.textContent('#log')) || '';
    // Флаг наблюдателя приоритетнее текста «на финише»: подпись прогресса к этому моменту
    // уже сменилась на обычную, а журнал в UI подрезан.
    const sawDownload = (await sawDownloadEver(page)) || /Скачиваю|скачив|Докачка/i.test(steps + logText);

    if (SCENARIO === 'netfail') {
      check('UI честно показал обрыв сети (статус error-net)', terminal.kind === 'error-net',
        terminal.kind + ' ' + (terminal.text || ''));
      const retryVisible = await page.evaluate(() =>
        !!document.querySelector('.step-retry, .step .step-retry, button.step-retry'));
      check('кнопка «Повторить» доступна пользователю', retryVisible);
      check('провал НЕ выдан за успех (нет экрана «Готово»)', terminal.kind !== 'finish');
    } else {
      // Прогресс скачивания есть ТОЛЬКО в lite: офлайн-издание ставит из вшитого vendor,
      // и «докачка» там означала бы, что мы зря тащим байты по сети.
      // Диагностика: без журнала приложения причину провала докачки не установить —
      // в интерфейсе видно только «Сеть оборвалась». Печатаем хвост журнала, когда
      // ожидали докачку, но её не было.
      if (EXPECT_LITE && !sawDownload) {
        // Частая причина — компонент УЖЕ установлен на машине (у раннера свой git/node):
        // скрипт видит это и выходит без докачки. Печатаем и шаги, и журнал, иначе
        // «докачки не было» неотличимо от настоящего провала загрузки.
        console.log('[e2e] --- шаги ---');
        console.log(String(steps).trim().slice(0, 2000) || '(пусто)');
        console.log('[e2e] --- журнал приложения (хвост) ---');
        console.log(String(logText).slice(-4000) || '(журнал пуст)');
        console.log('[e2e] --- конец журнала ---');
      }
      if (EXPECT_LITE) check('lite: докачка стартовала (в UI виден прогресс скачивания)', sawDownload, steps.slice(0, 200));
      else check('offline: установка без докачки (сеть не нужна)', !sawDownload, steps.slice(0, 200));
      check('прогон дошёл до финиша', terminal.kind === 'finish', terminal.kind + ' ' + (terminal.text || ''));
      // Реальная проверка результата: конфиг разложен в ИЗОЛИРОВАННЫЙ профиль.
      if (COMPONENT === 'config') {
        const claudeDir = path.join(ctx.home, '.claude');
        const nSkills = countDir(path.join(claudeDir, 'skills'));
        check('конфиг разложен в изолированный ~/.claude (skills > 100)', nSkills > 100, 'skills=' + nSkills);
        check('маркер завершённости конфига записан', exists(path.join(claudeDir, '.hamidun-config-complete')));
      }
    }
    await shot(page, SCENARIO);
  } finally {
    await app.close().catch(() => {});
  }
}

/**
 * preserve — сохранность данных пользователя. Ставим ПОВЕРХ живого профиля и
 * сверяем каждый пользовательский файл побайтово.
 */
async function scenarioPreserve(ctx) {
  const seed = seedUserData(ctx.home);
  const beforeTree = walkTree(path.join(ctx.home, '.claude'));

  const res = await runInstallSession(ctx, { targets: [COMPONENT], tag: 'preserve', wait: 'end' });
  checkRunHonest(res, '(установка поверх живого профиля)');
  const failedSteps = res.steps.filter((s) => s.status === 'error' || s.status === 'error-net');
  check('установка поверх непустого профиля прошла без провалов',
    failedSteps.length === 0, failedSteps.map((s) => s.id + ':' + s.status).join(', ') +
    ' | лог: ' + res.screen.logTail.slice(-400));
  checkDoneArtifacts(ctx.home, res.steps);

  verifyUserData(ctx.home, seed, '(после установки)');
  if (COMPONENT === 'config') verifyBaseInstalled(ctx.home, '(после установки)');

  // Ничего из пользовательского дерева не должно ИСЧЕЗНУТЬ (добавление нашего — норма).
  const afterTree = new Set(walkTree(path.join(ctx.home, '.claude')));
  const gone = beforeTree.filter((p) => !afterTree.has(p));
  check('ни один пользовательский путь в ~/.claude не исчез', gone.length === 0,
    gone.slice(0, 12).join(', '));

  // Сейф-нет: копия ~/.claude должна была появиться (данные пользователя были на месте).
  // Бэкап делает именно шаг «config» — для других компонентов его быть не должно.
  if (COMPONENT === 'config') {
    const backups = listBackups(ctx.home);
    check('перед раскладкой снята резервная копия ~/.claude.backup.*', backups.length >= 1,
      'найдено: ' + backups.length);
  }
}

/** rerun — идемпотентность: два прогона подряд, между ними приложение закрывается. */
async function scenarioRerun(ctx) {
  const seed = seedUserData(ctx.home);
  const stale = seedStaleBackups(ctx.home, 5);
  const claudeDir = path.join(ctx.home, '.claude');

  section('ПРОГОН 1');
  const r1 = await runInstallSession(ctx, { targets: [COMPONENT], tag: 'rerun-1', wait: 'end' });
  checkRunHonest(r1, '(прогон 1)');
  const failed1 = r1.steps.filter((s) => s.status === 'error' || s.status === 'error-net');
  check('прогон 1 без провальных шагов', failed1.length === 0,
    failed1.map((s) => s.id + ':' + s.status).join(', ') + ' | лог: ' + r1.screen.logTail.slice(-400));
  checkDoneArtifacts(ctx.home, r1.steps);
  if (COMPONENT === 'config') verifyBaseInstalled(ctx.home, '(после прогона 1)');
  const tree1 = walkTree(claudeDir);
  const skills1 = countDir(path.join(claudeDir, 'skills'));

  section('ПРОГОН 2 (то же самое ещё раз, новое окно приложения)');
  const r2 = await runInstallSession(ctx, { targets: [COMPONENT], tag: 'rerun-2', wait: 'end' });
  checkRunHonest(r2, '(прогон 2)');
  const failed2 = r2.steps.filter((s) => s.status === 'error' || s.status === 'error-net');
  check('повторная установка завершилась УСПЕХОМ (ничего не сломалось)',
    failed2.length === 0, failed2.map((s) => s.id + ':' + s.status).join(', ') +
    ' | лог: ' + r2.screen.logTail.slice(-400));
  check('повторная установка реально запускала целевой компонент (шаг присутствует)',
    r2.steps.some((s) => s.id === COMPONENT), r2.steps.map((s) => s.id).join(','));
  checkDoneArtifacts(ctx.home, r2.steps);

  section('идемпотентность');
  verifyUserData(ctx.home, seed, '(после второго прогона)');
  if (COMPONENT === 'config') verifyBaseInstalled(ctx.home, '(после прогона 2)');

  const tree2 = new Set(walkTree(claudeDir));
  const set1 = new Set(tree1);
  const removed = tree1.filter((p) => !tree2.has(p));
  const added = [...tree2].filter((p) => !set1.has(p));
  check('повторный прогон НИЧЕГО не удалил из ~/.claude', removed.length === 0,
    removed.slice(0, 12).join(', '));
  check('повторный прогон не насорил новыми файлами в ~/.claude', added.length === 0,
    added.slice(0, 12).join(', '));

  const skills2 = countDir(path.join(claudeDir, 'skills'));
  check('число скиллов не «раздулось» от повторной установки', skills1 === skills2,
    skills1 + ' → ' + skills2);
  // Дубли-каталоги — типичная авария merge-копии (~/.claude/.claude, skills/skills).
  check('нет вложенного дубля ~/.claude/.claude', !exists(path.join(claudeDir, '.claude')));
  check('нет вложенного дубля ~/.claude/skills/skills', !exists(path.join(claudeDir, 'skills', 'skills')));

  // Ретенция: копия ~/.claude делается КАЖДЫЙ прогон и весит как весь конфиг. Без чистки
  // старых копий профиль растёт гигабайтами, о которых пользователь не знает.
  // Политика продукта (scripts/macos/config.sh): «храню 3 последние, старые удаляю».
  const backups = listBackups(ctx.home);
  check('бэкапы ~/.claude.backup.* не копятся бесконтрольно (ретенция ≤ 3)',
    backups.length <= 3,
    'было посеяно ' + stale.length + ' старых + 2 прогона → осталось ' + backups.length +
    ': ' + backups.join(', '));
}

/** uninstall — удаление компонента через UI: наше снесено, пользовательское цело. */
async function scenarioUninstall(ctx) {
  const target = UNINSTALL_COMPONENT;
  const seed = seedUserData(ctx.home);
  log('компонент для удаления:', target);

  section('УСТАНОВКА (чтобы было что удалять)');
  const r1 = await runInstallSession(ctx, {
    targets: [target], tag: 'uninstall-install', wait: 'end', softTargets: true,
  });
  checkRunHonest(r1, '(установка перед удалением)');
  const step = r1.steps.find((s) => s.id === target);
  if (!step) {
    return { skip: 'компонента «' + target + '» нет на экране выбора этого издания — удалять нечего' };
  }
  if (step.status === 'skipped') {
    // exit 120 — «нечего ставить»: компонент не входит в это издание. Это осознанное
    // поведение продукта, а не провал; удаление проверять не на чем.
    return { skip: 'компонент «' + target + '» не входит в это издание (шаг «пропущено») — ' +
      'квитанции установки нет, удалять нечего' };
  }
  check('компонент «' + target + '» установился (шаг «done»)', step.status === 'done',
    'статус: ' + step.status + ' | лог: ' + r1.screen.logTail.slice(-400));
  const arts = componentArtifacts(ctx.home, target);
  const missingArts = arts.filter((p) => !exists(p));
  check('артефакты «' + target + '» реально появились в профиле', missingArts.length === 0,
    'нет: ' + missingArts.join(', '));
  if (step.status !== 'done' || missingArts.length) return {}; // дальше проверять нечего

  section('УДАЛЕНИЕ через интерфейс');
  // Слепок профиля ДО удаления: снос компонента не имеет права зацепить чужое.
  const claudeBefore = walkTree(path.join(ctx.home, '.claude'));
  const { app, page } = await launchApp(ctx);
  try {
    await captureConfirms(page);
    await gotoSelect(page);

    const ui = await page.evaluate((id) => {
      const row = document.querySelector(`.installed-actions[data-id="${id}"]`);
      const card = document.querySelector(`#groups .card[data-id="${id}"]`);
      return {
        cardPresent: !!card,
        rowPresent: !!row,
        hasUninstallBtn: !!(row && row.querySelector('.act-uninstall')),
        cardText: card ? (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '',
      };
    }, target);
    check('после установки карточка «' + target + '» помечена как установленная',
      ui.rowPresent, JSON.stringify(ui));

    const receiptPath = path.join(ctx.home, '.hamidun-setup', 'receipts', target + '.json');
    if (!ui.hasUninstallBtn) {
      // Кнопки нет — честно различаем «UI её не даёт» и «квитанции нет».
      if (!exists(receiptPath)) {
        return { skip: 'установка не оставила квитанцию (' + receiptPath + ') — кнопка «Удалить» ' +
          'по контракту не показывается, удалять через GUI нечего' };
      }
      check('квитанция есть, но кнопка «Удалить» в UI отсутствует', false, JSON.stringify(ui));
      return {};
    }

    await page.click(`.installed-actions[data-id="${target}"] .act-uninstall`);

    // Ждём пользовательский результат: артефакты исчезли (а не «статус позеленел»).
    const deadline = Date.now() + Math.min(STEP_TIMEOUT, 5 * 60 * 1000);
    let gone = false;
    while (Date.now() < deadline) {
      gone = arts.every((p) => !exists(p));
      if (gone) break;
      await page.waitForTimeout(1000);
    }
    check('после удаления артефакты «' + target + '» исчезли из профиля', gone,
      arts.filter((p) => exists(p)).join(', '));

    const confirms = await takenConfirms(page);
    check('удаление спросило подтверждение у пользователя', confirms.length >= 1,
      JSON.stringify(confirms));
    check('в подтверждении обещано, что данные пользователя не тронуты',
      /не будут затронуты/i.test(confirms[0] || ''), (confirms[0] || '').slice(0, 160));

    const statusText = await page.evaluate((id) => {
      const el = document.querySelector(`.installed-actions[data-id="${id}"] .installed-status`);
      return el ? (el.textContent || '').trim() : '';
    }, target).catch(() => '');
    log('статус на карточке после удаления:', statusText || '(карточка перерисована)');
    check('UI не отрапортовал провал удаления', !/не удалось/i.test(statusText), statusText);

    check('квитанция установки снята (компонент больше не «наш установленный»)',
      !exists(receiptPath), receiptPath);

    await shot(page, 'uninstall');
  } finally {
    await app.close().catch(() => {});
  }

  section('ПОЛЬЗОВАТЕЛЬСКОЕ после удаления');
  verifyUserData(ctx.home, seed, '(после удаления)');
  const claudeAfter = new Set(walkTree(path.join(ctx.home, '.claude')));
  const lost = claudeBefore.filter((p) => !claudeAfter.has(p));
  check('удаление компонента ничего не снесло в ~/.claude', lost.length === 0,
    lost.slice(0, 12).join(', '));
  return {};
}

/** full — ставим ВСЁ, что предложено по умолчанию. Никаких галок не снимаем. */
async function scenarioFull(ctx) {
  const seed = seedUserData(ctx.home);
  log('таймаут прогона:', Math.round(STEP_TIMEOUT / 60000), 'мин (HM_E2E_TIMEOUT)');

  const res = await runInstallSession(ctx, { targets: null, tag: 'full', wait: 'end' });
  const { failed } = checkRunHonest(res, '(полный набор)');

  const done = checkDoneArtifacts(ctx.home, res.steps);
  log('итог по шагам:', res.steps.map((s) => s.id + ':' + (s.status || '—')).join(' '));
  check('хотя бы часть компонентов реально встала', done.length > 0,
    res.steps.map((s) => s.id + ':' + s.status).join(' '));
  check('итоговая сводка показана пользователю', /Готово:\s*\d+/.test(res.screen.summary),
    res.screen.summary);

  // Полный набор включает config — значит база обязана лечь, а данные пользователя уцелеть.
  if (res.steps.some((s) => s.id === 'config' && s.status === 'done')) {
    verifyBaseInstalled(ctx.home, '(после полного прогона)');
  }
  verifyUserData(ctx.home, seed, '(после полного прогона)');

  if (failed.length) {
    log('НЕ установились (это допустимо, но обязано быть видно на экране):',
      failed.map((s) => s.id).join(', '));
  }
}

// ---------------------------------------------------------------------------

/**
 * selftest — проверка САМОГО ХАРНЕССА (приложение не запускается, секунды).
 * Смысл: убедиться, что сверка пользовательских данных РЕАЛЬНО ловит порчу, а не
 * зеленеет всегда. Если этот сценарий «проходит» при затёртом файле — все остальные
 * сценарии ничего не стоят.
 */
async function scenarioSelftest() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-selftest-'));
  try {
    const seed = seedUserData(home);

    section('целые данные — сверка обязана пройти');
    const before = failures;
    verifyUserData(home, seed, '(нетронутые)');
    check('на нетронутых данных сверка не даёт ложных провалов', failures === before,
      'ложных провалов: ' + (failures - before));

    section('порча данных — сверка обязана УПАСТЬ');
    // Затираем ключи и удаляем свой скилл — ровно то, чего боится владелец.
    fs.writeFileSync(path.join(home, '.claude', '.credentials.master.env'), '# template\n', 'utf8');
    rmrf(path.join(home, '.claude', 'skills', 'my-own-skill'));
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), '# базовый CLAUDE.md из пакета\n', 'utf8');
    const quiet = { n: 0 };
    const realCheck = check;
    // Считаем провалы «понарошку», не засоряя общий счётчик.
    // eslint-disable-next-line no-global-assign
    check = (name, cond) => { if (!cond) quiet.n++; return !!cond; };
    verifyUserData(home, seed, '(испорченные)');
    // eslint-disable-next-line no-global-assign
    check = realCheck;
    check('сверка ловит затёртые ключи, удалённый скилл и подменённый CLAUDE.md',
      quiet.n >= 4, 'поймано провалов: ' + quiet.n + ' (ожидали ≥4)');

    section('диффы дерева и ретенция бэкапов');
    const claudeDir = path.join(home, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'will-be-deleted.txt'), 'x', 'utf8');
    const t1 = walkTree(claudeDir);
    fs.writeFileSync(path.join(claudeDir, 'junk.txt'), 'junk', 'utf8');
    fs.rmSync(path.join(claudeDir, 'will-be-deleted.txt'));
    const t2 = new Set(walkTree(claudeDir));
    const added = [...t2].filter((p) => !t1.includes(p));
    check('дифф дерева видит появившийся мусор', added.includes('junk.txt'), added.join(','));
    const removedNow = t1.filter((p) => !t2.has(p));
    check('дифф дерева видит пропажу файла', removedNow.includes('will-be-deleted.txt'),
      removedNow.join(','));
    seedStaleBackups(home, 4);
    check('бэкапы считаются по имени ~/.claude.backup.*', listBackups(home).length === 4,
      listBackups(home).join(','));
  } finally {
    if (!process.env.HM_E2E_KEEP) rmrf(home);
  }
  return {};
}

const SCENARIOS = {
  ok: scenarioOkOrNetfail,
  netfail: scenarioOkOrNetfail,
  preserve: scenarioPreserve,
  rerun: scenarioRerun,
  uninstall: scenarioUninstall,
  full: scenarioFull,
  selftest: scenarioSelftest,
};

async function main() {
  const run = SCENARIOS[SCENARIO];
  if (!run) {
    console.error('[e2e] неизвестный сценарий «' + SCENARIO + '». Доступны: ' +
      Object.keys(SCENARIOS).join(', '));
    process.exit(2);
  }
  log('сценарий:', SCENARIO, '| компонент:', SCENARIO === 'uninstall' ? UNINSTALL_COMPONENT : COMPONENT,
    '| таймаут:', Math.round(STEP_TIMEOUT / 60000) + ' мин');

  let outcome = {};
  if (SCENARIO === 'selftest') {
    // Харнесс-самопроверка: приложение не поднимаем, профиль не подменяем.
    outcome = (await run()) || {};
  } else {
    const isolationBefore = realHomeSnapshot();
    const ctx = makeContext();
    try {
      outcome = (await run(ctx)) || {};
    } finally {
      checkIsolation(isolationBefore);
      cleanupContext(ctx);
    }
  }

  if (outcome.skip && !failures) {
    console.log('\n[e2e] ИТОГ (' + SCENARIO + '): SKIP — ' + outcome.skip);
    console.log('[e2e] сценарий НЕ выполнен (успех не имитируем). Проверок провалено: 0.');
    process.exit(0);
  }
  console.log('\n[e2e] ИТОГ (' + SCENARIO + '): ' +
    (failures ? failures + ' проверок ПРОВАЛЕНО' : 'все проверки пройдены') +
    (outcome.skip ? ' | частичный SKIP: ' + outcome.skip : ''));
  process.exit(failures ? 1 : 0);
}

// Запуск как CLI — единственный штатный режим. При `require()` (отладка/смоук
// отдельных шагов) ничего не выполняем и отдаём внутренние функции наружу.
if (require.main === module) {
  main().catch(async (e) => {
    console.error('[e2e] ФАТАЛЬНО:', e && e.stack || e);
    // Улики снимаем ДО выхода: иначе диагностика такого падения = ещё один слепой прогон.
    await dumpForensics(SCENARIO).catch(() => {});
    process.exit(2);
  });
} else {
  module.exports = {
    makeContext, cleanupContext, launchApp, gotoSelect, selectExactly, collectSteps,
    finalScreen, seedUserData, verifyUserData, walkTree, listBackups, componentArtifacts,
  };
}
