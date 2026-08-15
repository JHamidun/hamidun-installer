#!/usr/bin/env node
/* audit-pack.js — проверить, что конфиг после установки действительно РАБОТАЕТ.
 *
 * ЗАЧЕМ. Аудит на машине ученика показал картину «пол конфига ставится фантомно»:
 * 33 плагина включены, но каталог маркетплейсов пуст; MCP-серверы объявлены, но ни
 * один не поднялся; правила ссылаются на скрипты, которых на диске нет; счётчики в
 * CLAUDE.md разошлись с реальностью. Всё это «успешно установилось» — потому что
 * раскладка файлов и работоспособность это разные вещи, а проверяли только первое.
 *
 * Корень большинства симптомов был один: каталог Node не попадал в СИСТЕМНЫЙ PATH.
 * Наши скрипты правили PATH только внутри своего процесса, поэтому сами находили
 * node и рапортовали успех, а у человека в новом терминале не было ни node, ни npx,
 * ни claude — а значит ни MCP (12 из 21 запускаются через npx), ни регистрации
 * плагинов. Здесь эта связь проверяется явно, чтобы регрессия не прошла молча.
 *
 * Запуск:  node tools/audit-pack.js [путь к паку]
 *   По умолчанию проверяется vendor/config-pack — то, что реально едет пользователю.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PACK = process.argv[2] || path.join(__dirname, '..', 'vendor', 'config-pack');
const C = path.join(PACK, '.claude');

const problems = [];
const notes = [];
const ok = [];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/* ---------- 1. MCP: чем запускаются и есть ли личные пути ---------- */

const settings = readJson(path.join(C, 'settings.json')) || {};
const mcp = settings.mcpServers || {};
const active = Object.entries(mcp).filter(([, c]) => c && !c.disabled);
const viaNpx = active.filter(([, c]) => /^npx/i.test(c.command || ''));

ok.push(`MCP объявлено ${Object.keys(mcp).length}, активных ${active.length}`);
if (viaNpx.length) {
  notes.push(`${viaNpx.length} из ${active.length} активных MCP запускаются через npx — без каталога Node ` +
    `в СИСТЕМНОМ PATH они не поднимутся, и у человека это выглядит как «MCP просто нет»`);
}

// Сам по себе ${HOME} — нормальная подстановка, она раскроется у любого пользователя.
// Значение имеет другое: ведёт ли путь в файл, который ПРИЕДЕТ ВМЕСТЕ С ПАКОМ. Ссылка
// на ~/.brain/brain_mcp.py или на .venv в личном каталоге автора не разрешится ни у
// кого, кроме него, — такой сервер молча не поднимется.
// Проверяем по ФОРМЕ пути, а не по чьему-то имени: абсолютный путь в чей-то домашний
// каталог у другого человека не существует. Слеши экранированы обеими формами —
// строка приходит из JSON.stringify, где каждый бэкслеш удвоен, и паттерн вида
// `C:\\Vibecode` не совпал бы никогда: он ждёт один бэкслеш там, где стоят два.
const HARDCODED = /^[A-Za-z]:[\\/]+(Users|Vibecode)[\\/]|^\/(Users|home)\//i;
for (const [name, cfg] of Object.entries(mcp)) {
  const blob = JSON.stringify(cfg);
  // Пути, которые программа СОЗДАЁТ сама (профиль браузера, каталог вывода), проверять
  // на существование бессмысленно: их и не должно быть до первого запуска.
  const rawArgs = [cfg.command, ...(cfg.args || [])].filter((x) => typeof x === 'string');
  const CREATED_BY_FLAG = /^--(user-data-dir|output|out|profile|storage|cache|data-dir)$/i;
  const args = rawArgs.filter((a, i) => !(i > 0 && CREATED_BY_FLAG.test(rawArgs[i - 1])));
  // Путь внутрь ~/.claude/... проверяем по паку: он и разворачивается в ~/.claude.
  const local = args
    .filter((a) => /\$\{HOME\}[\\/]\.claude[\\/]/i.test(a))
    .map((a) => a.replace(/\$\{HOME\}[\\/]\.claude[\\/]/i, '').replace(/\//g, path.sep));
  const missing = local.filter((rel) => !fs.existsSync(path.join(C, rel)));
  const outside = args.filter((a) => /\$\{HOME\}[\\/](?!\.claude)/i.test(a));

  let line = null;
  const hard = args.find((a) => HARDCODED.test(a));
  if (hard) line = `MCP «${name}»: жёстко прописан путь конкретной машины — ${hard.slice(0, 70)}`;
  else if (missing.length) line = `MCP «${name}»: файла нет в паке — ${missing[0]}`;
  else if (outside.length) line = `MCP «${name}»: ссылается вне пака (${outside[0].slice(0, 60)}) — у ученика этого не будет`;
  if (!line) continue;
  if (cfg.disabled) notes.push(line + ' [отключён]');
  else problems.push(line);
}

/* ---------- 2. Плагины: включены ли те, что негде взять ---------- */

const enabled = Object.entries(settings.enabledPlugins || {}).filter(([, v]) => v);
const known = settings.extraKnownMarketplaces || {};
if (enabled.length && !Object.keys(known).length) {
  problems.push(`включено ${enabled.length} плагинов, но не объявлено ни одного маркетплейса — ` +
    `ставить их будет неоткуда`);
} else if (enabled.length) {
  ok.push(`плагинов включено ${enabled.length}, маркетплейсов объявлено ${Object.keys(known).length}`);
}

// Плагины включены, но их маркетплейс не объявлен — самая тихая поломка: в списке
// плагин «есть», а команд от него нет. Официальный маркетплейс Anthropic объявлять
// не нужно — Claude Code знает его сам, поэтому он в исключениях.
const BUILTIN_MARKETS = new Set(['claude-plugins-official', 'anthropics']);
const marketNames = new Set([...Object.keys(known), ...BUILTIN_MARKETS]);
const localMarket = readJson(path.join(PACK, '.claude-plugin', 'marketplace.json'));
if (localMarket && localMarket.name) marketNames.add(localMarket.name);
const orphan = enabled
  .map(([k]) => k)
  .filter((k) => k.includes('@') && !marketNames.has(k.split('@').pop()));
if (orphan.length) {
  problems.push(`плагины без объявленного маркетплейса (${orphan.length}): ${orphan.slice(0, 5).join(', ')}`);
}

/* ---------- 3. Правила: ссылки на скрипты, которых нет ---------- */

const rulesDir = path.join(C, 'rules');
let refsTotal = 0;
const broken = new Set();
if (fs.existsSync(rulesDir)) {
  for (const f of fs.readdirSync(rulesDir).filter((x) => x.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(rulesDir, f), 'utf8');
    for (const m of text.matchAll(/python3?\s+([^\s`'")]+\.py)/g)) {
      const ref = m[1];
      refsTotal++;
      // ${WORKSPACE} нигде не задаётся — такие команды не выполнимы в принципе.
      if (ref.includes('${')) { broken.add(ref); continue; }
      const rel = ref.replace(/^~[\\/]?/, '').replace(/^\.claude[\\/]/, '');
      const cand = [path.join(C, rel), path.join(PACK, rel), path.join(C, ref.replace(/^~[\\/]\.claude[\\/]/, ''))];
      if (!cand.some((p) => fs.existsSync(p))) broken.add(ref);
    }
  }
}
if (broken.size) {
  problems.push(`в правилах ${broken.size} ссылок на скрипты, которых в паке нет (из ${refsTotal}): ` +
    [...broken].slice(0, 4).map((s) => s.slice(0, 60)).join(' · '));
} else if (refsTotal) {
  ok.push(`ссылки на скрипты в правилах разрешаются: ${refsTotal}`);
}

/* ---------- 4. Хуки: описаны в правилах, но не подключены ---------- */

const hooksDoc = path.join(rulesDir, 'hooks.md');
const realHooks = JSON.stringify(settings.hooks || {});
if (fs.existsSync(hooksDoc)) {
  const text = fs.readFileSync(hooksDoc, 'utf8');
  const named = [...text.matchAll(/([a-z0-9_-]+\.(?:js|py|ps1|sh))/gi)].map((m) => m[1]);
  const missing = [...new Set(named)].filter((n) => !realHooks.includes(n));
  if (missing.length) {
    notes.push(`rules/hooks.md упоминает ${missing.length} хуков, которых нет в settings.json: ` +
      missing.slice(0, 4).join(', '));
  }
}

/* ---------- 5. Счётчики в CLAUDE.md против диска ---------- */

const claudeMd = path.join(PACK, 'CLAUDE.md');
if (fs.existsSync(claudeMd)) {
  const text = fs.readFileSync(claudeMd, 'utf8');
  const count = (sub, deep) => {
    const d = path.join(C, sub);
    if (!fs.existsSync(d)) return 0;
    if (!deep) return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    let n = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md') && e.name.toLowerCase() !== 'readme.md') n++;
      }
    };
    walk(d);
    return n;
  };
  const real = { скиллов: count('skills', false), агентов: count('agents', true), команд: count('commands', true) };
  for (const [word, actual] of Object.entries(real)) {
    if (!actual) continue;
    const re = new RegExp('(\\d{2,4})\\s*' + word.slice(0, 5), 'gi');
    const claimed = [...text.matchAll(re)].map((m) => Number(m[1])).filter((n) => Math.abs(n - actual) > 0);
    if (claimed.length) {
      notes.push(`CLAUDE.md обещает ${claimed[0]} ${word}, на диске ${actual}`);
    }
  }
}

/* ---------- вывод ---------- */

console.log('ПАК: ' + PACK + '\n');
for (const s of ok) console.log('  OK   ' + s);
for (const s of notes) console.log('  ~    ' + s);
for (const s of problems) console.log('  СТОП ' + s);
console.log('\n' + '='.repeat(70));
if (problems.length) {
  console.log(`ВЕРДИКТ: ${problems.length} проблем(ы), ${notes.length} замечани(й).`);
  process.exit(1);
}
console.log(`ВЕРДИКТ: связность в порядке. Замечаний: ${notes.length}.`);
