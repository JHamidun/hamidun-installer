#!/usr/bin/env node
/* Прогон audit-pack.js на СИНТЕТИЧЕСКИХ паках: зелёный и заведомо битый.
 *
 * ЗАЧЕМ. Три проверки аудитора нельзя доказать прогоном на реальном паке — там всё
 * на месте, и «зелёный» вывод неотличим от вывода, где проверка мертва (тот же урок,
 * что и с HARDCODED: паттерн не срабатывал НИКОГДА, а аудит светился зелёным). Поэтому
 * собираем во временном каталоге два пака и смотрим на РЕАКЦИЮ аудитора:
 *   1) хук/statusLine с пропавшим файлом обязан дать СТОП (битый PreToolUse бьёт по
 *      каждому вызову Bash — молчать тут нельзя);
 *   2) inline-форма «--user-data-dir=значение» НЕ должна давать ложный СТОП —
 *      каталог профиля создаётся при первом запуске, его отсутствие нормально;
 *   3) счётчик npx обязан видеть npx.cmd/npx.exe/абсолютный путь и НЕ считать
 *      команды, лишь начинающиеся с букв «npx».
 */
'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUDIT = path.join(__dirname, '..', 'tools', 'audit-pack.js');

// Пак = каталог с .claude/settings.json и файлами-заглушками по относительным путям.
function makePack(settings, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pack-'));
  const c = path.join(root, '.claude');
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, 'settings.json'), JSON.stringify(settings, null, 2));
  for (const rel of files || []) {
    const p = path.join(c, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// заглушка для теста\n');
  }
  return root;
}

function runAudit(pack) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [AUDIT, pack], { encoding: 'utf8' }) };
  } catch (e) {
    // execFileSync бросает при ненулевом коде выхода — для битого пака это НОРМА.
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const tmpDirs = [];
try {
  /* ---------- зелёный пак: все формы, которые аудит обязан ПРОПУСТИТЬ ---------- */
  const green = makePack({
    mcpServers: {
      plain: { command: 'npx', args: ['-y', 'pkg'] },
      // inline-форма флага: значение в том же токене; каталога в паке нет и не должно быть
      wincmd: { command: 'npx.cmd', args: ['pkg', '--user-data-dir=${HOME}/.claude/pw-profiles/live1'] },
      // абсолютный путь до npx (не Users/Vibecode — это НЕ путь конкретной машины)
      winabs: { command: 'C:\\Program Files\\nodejs\\npx.exe', args: ['pkg'] },
      posix: { command: '/usr/local/bin/npx', args: ['pkg'] },
      // старая двухтокенная форма — регресс-страховка, что её не сломали правкой
      pair: { command: 'npx', args: ['pkg', '--user-data-dir', '${HOME}/.claude/pw-profiles/live2'] },
      notnpx: { command: 'node', args: ['-e', '1'] },
      // ловушка на перещёт: начинается с «npx», но npx-ом не является
      trap: { command: 'npx-foo', args: [] },
    },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${HOME}/.claude/hooks/bash-guard.js"' }] }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${HOME}/.claude/hooks/stop-beep.js"' }] }],
    },
    statusLine: { type: 'command', command: 'node "${HOME}/.claude/hooks/gsd-statusline.js"' },
  }, ['hooks/bash-guard.js', 'hooks/stop-beep.js', 'hooks/gsd-statusline.js']);
  tmpDirs.push(green);

  const g = runAudit(green);
  assert.strictEqual(g.code, 0, 'зелёный пак должен проходить аудит, вывод:\n' + g.out);
  assert(g.out.includes('связность в порядке'), 'нет вердикта «связность в порядке»:\n' + g.out);
  // 5 из 7: plain, wincmd, winabs, posix, pair — да; node и npx-foo — нет.
  assert(g.out.includes('5 из 7 активных MCP'), 'счётчик npx не увидел npx.cmd/npx.exe/абс.путь ' +
    'или посчитал лишнее (ждём «5 из 7»):\n' + g.out);
  assert(g.out.includes('хуки и statusLine: файлы на месте (3)'),
    'проверка хуков не отчиталась о трёх найденных файлах:\n' + g.out);
  assert(!g.out.includes('файла нет в паке'),
    'ложный СТОП: inline-форма --user-data-dir=… уехала в проверку существования:\n' + g.out);
  console.log('  OK  зелёный пак: 5/7 npx, 3 файла хуков, без ложных СТОПов');

  /* ---------- битый пак: всё, на что аудит обязан ОРАТЬ ---------- */
  const broken = makePack({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${HOME}/.claude/hooks/missing-guard.js"' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "C:\\Users\\author\\hook.js"' }] }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${HOME}/.brain/outside.js"' }] }],
    },
    statusLine: { type: 'command', command: 'node "${HOME}/.claude/hooks/no-statusline.js"' },
  }, []);
  tmpDirs.push(broken);

  const b = runAudit(broken);
  assert.strictEqual(b.code, 1, 'битый пак должен падать кодом 1, вывод:\n' + b.out);
  assert(b.out.includes('missing-guard.js'), 'пропавший файл PreToolUse-хука не пойман:\n' + b.out);
  assert(b.out.includes('no-statusline.js'), 'пропавший файл statusLine не пойман:\n' + b.out);
  assert(b.out.includes('путь конкретной машины'), 'жёсткий путь в команде хука не пойман:\n' + b.out);
  assert(b.out.includes('вне пака'), 'ссылка хука вне пака (~/.brain) не поймана:\n' + b.out);
  console.log('  OK  битый пак: 4 поломки хуков/statusLine дают СТОП и код 1');
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* мусор в tmp не критичен */ }
  }
}
