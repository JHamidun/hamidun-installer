'use strict';
/**
 * pack-summary.js — «что встало из конфига»: сколько скиллов и агентов и где их каталог.
 *
 * ЗАЧЕМ. После установки люди не видели, что им поставили: где скиллы, сколько их, как
 * ими пользоваться. Помощник называл то 263, то «280+», а сам каталог (CATALOG.md) в
 * ~/.claude не попадал. Цифры пишет config-скрипт в ~/.hamidun-setup/config-summary.json;
 * здесь их только читают — осторожно, потому что файл лежит в профиле пользователя и
 * доверять его форме нельзя: берутся только неотрицательные целые, всё прочее — «не знаем».
 *
 * Отдельным модулем — чтобы тест гонял разбор напрямую (main.js требует electron).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BYTES = 512 * 1024;

// Число из значения: число/строка-число, массив (его длина) или {count}. Иначе null.
function countOf(v) {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return v.count !== undefined ? countOf(v.count) : null;
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return (Number.isFinite(n) && n >= 0 && n < 100000) ? Math.floor(n) : null;
}

// Форма файла может отличаться (skills / skillCount / skills_count / counts.skills) —
// принимаем все разумные, первое найденное число побеждает.
function parsePackSummary(j) {
  const o = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  const c = (o.counts && typeof o.counts === 'object') ? o.counts : {};
  const pick = (...vals) => { for (const v of vals) { const n = countOf(v); if (n !== null) return n; } return null; };
  return {
    skills: pick(o.skills, o.skillCount, o.skills_count, c.skills),
    agents: pick(o.agents, o.agentCount, o.agents_count, c.agents),
  };
}

// Те же три числа, что у parsePackSummary, плюс команды — для памятки. Отдельной функцией, а не
// третьим полем parsePackSummary: форма его ответа закреплена тестами и экраном финиша.
function parsePackCounts(j) {
  const o = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  const c = (o.counts && typeof o.counts === 'object') ? o.counts : {};
  const base = parsePackSummary(j);
  let commands = null;
  for (const v of [o.commands, o.commandCount, o.commands_count, c.commands]) {
    const n = countOf(v);
    if (n !== null) { commands = n; break; }
  }
  return { skills: base.skills, agents: base.agents, commands };
}

// Разобранная сводка ИЛИ null (нет файла, не файл, слишком большой, не JSON). Файл лежит в
// профиле пользователя — форме не доверяем, берутся только неотрицательные целые.
function readSummaryJson(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const file = o.file || path.join(home, '.hamidun-setup', 'config-summary.json');
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { return null; }
}

function ruPlural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Пара маркеров в памятке (assets/START-HERE.html). В исходнике между ними ПУСТО.
const COUNTS_RE = /<!--PACK-COUNTS-->[\s\S]*?<!--\/PACK-COUNTS-->/;

/**
 * Памятка с числами ЭТОГО человека. Раньше в ней было зашито «284 навыка, 155 команд и 66
 * помощников», а на финише стояло другое число, а в чате бот называл третье — три цифры про
 * один пак. Теперь числа берутся из config-summary.json (его пишет config-скрипт сразу после
 * раскладки) в момент, когда памятку кладут на рабочий стол или показывают в окне. Нет сводки
 * (мак без записи, пак не ставился, файл повреждён) — цифр в тексте нет вовсе, а предложение
 * остаётся целым: «Ниже собраны самые ходовые.»
 * @param {string} html  исходная памятка
 * @param {object|null} summary  разобранный config-summary.json (readSummaryJson) или null
 */
function fillStartHere(html, summary) {
  const s = String(html == null ? '' : html);
  const c = parsePackCounts(summary);
  const parts = [];
  if (c.skills !== null) parts.push(c.skills + ' ' + ruPlural(c.skills, 'навык', 'навыка', 'навыков'));
  if (c.commands !== null) parts.push(c.commands + ' ' + ruPlural(c.commands, 'команда', 'команды', 'команд'));
  if (c.agents !== null) parts.push(c.agents + ' ' + ruPlural(c.agents, 'помощник', 'помощника', 'помощников'));
  const list = parts.length < 2 ? parts.join('') : parts.slice(0, -1).join(', ') + ' и ' + parts[parts.length - 1];
  const text = parts.length ? 'В твоей сборке сейчас — ' + list + '. ' : '';
  return s.replace(COUNTS_RE, () => '<!--PACK-COUNTS-->' + text + '<!--/PACK-COUNTS-->');
}

/**
 * @returns {{ok: boolean, skills: number|null, agents: number|null, catalog: string}}
 */
function readPackSummary(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const file = o.file || path.join(home, '.hamidun-setup', 'config-summary.json');
  const none = { ok: false, skills: null, agents: null, catalog: '' };
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return none;
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const p = parsePackSummary(j);
    const catalog = path.join(home, '.claude', 'CATALOG.md');
    return {
      ok: p.skills !== null || p.agents !== null,
      skills: p.skills,
      agents: p.agents,
      catalog: fs.existsSync(catalog) ? catalog : '',
    };
  } catch (e) { return none; }
}

module.exports = { countOf, parsePackSummary, parsePackCounts, readSummaryJson, fillStartHere, readPackSummary };
