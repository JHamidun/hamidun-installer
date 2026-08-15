#!/usr/bin/env node
/* Проверка распознавания «путь конкретной машины» в audit-pack.js.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ТЕСТ. Первая версия проверки была написана как `C:\\Vibecode` и
 * применялась к JSON.stringify(конфига), где каждый бэкслеш удвоен. Паттерн ждал один
 * бэкслеш там, где в строке стояло два, и ветка не срабатывала НИКОГДА: запись MCP с
 * жёстко прописанным путём машины автора проходила аудит зелёной. Ошибка тихая —
 * аудит «зелёный» выглядит одинаково и когда всё хорошо, и когда проверка мертва.
 * Поэтому проверяем обе формы слешей и обе формы записи явно.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'tools', 'audit-pack.js'), 'utf8');
const line = SRC.split('\n').find((l) => l.trim().startsWith('const HARDCODED'));
assert(line, 'в audit-pack.js не найдено объявление HARDCODED');

// Разбираем литерал руками, без eval: тело между первым и последним «/», флаги после.
// Читать исходник и исполнять его — плохая привычка даже в тестах.
const m = line.match(/const HARDCODED\s*=\s*\/(.+)\/([gimsuy]*)\s*;/);
assert(m, `не разобрал литерал регулярного выражения: ${line}`);
const HARDCODED = new RegExp(m[1], m[2]);

const ЛОВИТ = [
  'C:\\Vibecode\\tools\\x.py',
  'C:/Vibecode/tools/x.py',
  'C:\\Users\\bob\\a.py',
  'D:/Users/anna/b.py',
  '/Users/bob/a.py',
  '/home/bob/a.py',
];
const ПРОПУСКАЕТ = [
  '${HOME}/.claude/mcps/graph-memory/server.py',
  '${HOME}\\.claude\\scripts\\memory_graph.py',
  'npx',
  'python',
  '@playwright/mcp@0.0.78',
  '-y',
];

for (const s of ЛОВИТ) {
  assert(HARDCODED.test(s), `должен ловить путь конкретной машины, но пропустил: ${s}`);
}
for (const s of ПРОПУСКАЕТ) {
  assert(!HARDCODED.test(s), `не должен трогать переносимое значение, но поймал: ${s}`);
}

console.log(`  OK  распознавание путей машины: ${ЛОВИТ.length} ловит, ${ПРОПУСКАЕТ.length} пропускает`);
