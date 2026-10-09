'use strict';
// _cfgmigrate.js — бережная правка профиля пользователя после раскладки конфига (macOS):
//   • ~/.claude/settings.json у тех, кто ставил раньше (миграция, основная работа файла);
//   • опись поставленного: CATALOG.md пака в ~/.claude и сводка для финального экрана;
//   • карта конфига для Codex: AGENTS.md пака → ~/.codex/AGENTS.md.
// Зовёт config.sh (после раскладки) и touchup-config.sh (на КАЖДОМ прогоне):
//   node _cfgmigrate.js <settings.json> <fresh 1|0> <файл отметки>        — миграция
//   node _cfgmigrate.js --summary <~/.claude> <~/.hamidun-setup> <пак>    — опись
//   node _cfgmigrate.js --codex <домашний каталог> <AGENTS.md пака>       — карта для Codex
//   node _cfgmigrate.js --touchup <домашний каталог> <пак> <config выбран 1|0>
// Зеркало scripts/windows/_cfgmigrate.ps1 — те же правила, та же отметка шага, тот же
// формат записи. Разойдись они — Mac и Windows после повторной установки получили бы
// разный settings.json из одного и того же пака.
//
// ЗАЧЕМ. Обычный повторный запуск существующий settings.json не трогает (add-missing:
// rsync --ignore-existing), а «Переустановить начисто» перезаписывает его целиком свежим
// паком. Поэтому исправления пака до тех, кто поставил раньше, не доходили вовсе: у них
// оставались плагины, которые без токена падают на каждом старте («N MCP servers need
// authentication»), Semgrep, требующий входа после каждой записи файла, hookify, который на
// каждый вызов зовёт python3, правила, на которые Claude Code ругается при каждом запуске,
// HTTP-хуки с незаполненным VSCODE_PORT («Settings Error … Invalid URL») и раздел mcpServers,
// который в settings.json не читается.
//
// Цель — то, что получает свежая установка: пак 5cf4a39 приводит к этим значениям свой
// settings.json скриптом guard_student_defaults.py (--apply), правила ниже повторяют его.
// Плюс то, что из пака ушло раньше и осталось только у старых установок: Semgrep и
// коннекторы июня–августа, хуки VSCODE_PORT, раздел mcpServers, MCP_TIMEOUT=30000 (пак
// 19.08–06.09; сейчас 120000).
//
// Меняем ТОЛЬКО эти известные дефекты. Модель, effort, режим разрешений, свои хуки и
// остальные правила человека не трогаем (решение владельца 06.10: значения пака по
// умолчанию остаются). Перед записью — копия файла рядом. Файл не разобрался как
// JSON-объект, не читается как UTF-8 или достаётся через ссылку — не трогаем вовсе.
// Пишем JSON.stringify(…, null, 2) — в этом формате файл и лежит в паке.
//
// Пишем в каталоги пользователя (~/.claude, ~/.hamidun-setup, ~/.codex), а проверять их
// приходится и под повторными запусками, и из чужих рук: ни одна запись не идёт «сквозь»
// ссылку (проверка повторяется непосредственно перед записью), копия создаётся флагом wx
// (падает на любом занятом имени, в том числе на ссылке), а сам файл пишется во временный
// wx-файл и переносится поверх целевого (writeFileSafe). Те же правила, что у Windows.
//
// Движок — node: config.sh идёт после компонента Node (requires), а python3 на чистом маке
// без Command Line Tools — заглушка с системным окном. Нет node — config.sh пропускает
// правку с понятной строкой (fail-closed).
const fs = require('fs');
const path = require('path');

// Плагины, которые без токена или входа падают при запуске Claude Code, блокируют запись
// файлов или шумят на каждом ответе. Первые восемь — PLUGINS_OFF из guard_student_defaults.py
// пака (hookify шумит python3 на каждый вызов). Остальные — то, что пак июня–августа (до 17.07
// и до 03.08) отдавал ВКЛЮЧЁННЫМ, а потом убрал, и у ранних установок оно осталось: semgrep,
// а также коннекторы slack, sentry, figma, huggingface-skills, legalzoom, adspirer-ads-agent —
// у каждого удалённый MCP-сервер со своим входом, без которого он только пишет «needs
// authentication». Список тот же, что у Windows-миграции (там он сверен по истории
// .claude/settings.json пака); идентификаторы — с суффиксом @claude-plugins-official.
const OFF_PLUGINS = ['greptile', 'sourcegraph', 'coderabbit', 'github', 'linear', 'notion', 'telegram',
  'hookify', 'semgrep',
  'slack', 'sentry', 'figma', 'huggingface-skills', 'legalzoom', 'adspirer-ads-agent'];
// Значения по умолчанию, которые человек вправе поменять: к его СОБСТВЕННОМУ файлу они
// применяются один раз. Включил плагин обратно (поставил токен) или вернул опрос —
// повторный запуск установщика это не откатит. Правила-«близнецы», хуки VSCODE_PORT и
// mcpServers, наоборот, проверяются по содержимому при каждом запуске. Тот же идентификатор
// шага, что на Windows.
const DEFAULTS_STEP_ID = 'student-defaults-2026-10';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Правило, на которое Claude Code ругается при КАЖДОМ запуске, и чем его заменить; null —
// правило в порядке. Повторяет warned_rule из guard_student_defaults.py пака:
//   • путь в правиле Write/MultiEdit/NotebookEdit/Glob: доступ к файлам проверяется только
//     правилами Edit(путь) и Read(путь), такое правило не применяется никогда. Замена —
//     «близнец» Edit(…)/Read(…). Tool(*) означает весь инструмент — его не трогаем;
//   • Bash-правило, где * смешана с устаревшим хвостом :* — сравнивается буквально и не
//     срабатывает. В deny/ask замена — форма, которую советует сам Claude Code (:* -> *);
//     в allow не трогаем: там выбор за человеком.
// КУДА применять замену решает applyFixes (см. там): в allow она ЗАПРЕЩЕНА, если «близнеца»
// ещё нет, — иначе неработающее правило стало бы работающим разрешением.
function warnedRuleFix(rule, list) {
  let m = /^(Write|MultiEdit|NotebookEdit|Glob)\(([\s\S]*)\)$/.exec(rule);
  if (m) {
    const content = m[2];
    if (content === '*' || content.indexOf(':*') !== -1) return null;
    return (m[1] === 'Glob' ? 'Read' : 'Edit') + '(' + content + ')';
  }
  m = /^Bash\(([\s\S]*)\)$/.exec(rule);
  if (m && m[1].endsWith(':*')) {
    const prefix = m[1].slice(0, -2).replace(/\s+$/, '');
    if (prefix.indexOf('*') !== -1 && list !== 'allow') return 'Bash(' + prefix + '*)';
  }
  return null;
}

// Чистая часть: правит РАЗОБРАННЫЙ settings.json на месте и возвращает список сделанного
// (строки для журнала). defaults — применять ли шаг значений по умолчанию (плагины, опрос,
// MCP_TIMEOUT). hints — массив, куда складываются подсказки о том, что НЕ менялось (их
// печатает вызывающий; на решение «писать ли файл» они не влияют).
function applyFixes(settings, defaults, hints) {
  const done = [];
  done.short = [];   // коротко, для одной строки always-run правки (touchup-config.sh)
  if (defaults) {
    // 1. Плагины: только точное значение true -> false.
    if (isObj(settings.enabledPlugins)) {
      const ep = settings.enabledPlugins;
      const off = OFF_PLUGINS.filter((name) => {
        const key = name + '@claude-plugins-official';
        if (has(ep, key) && ep[key] === true) { ep[key] = false; return true; }
        return false;
      });
      if (off.length) {
        done.short.push('плагины без токена: ' + off.join(', '));
        done.push('выключил плагины ' + off.join(', ') + ' — без токена или входа они падают при запуске Claude Code, hookify шумит ошибкой в каждом ответе (включить обратно: /plugin)');
      }
    }
    // 2. Опрос «How is Claude doing this session?» и просьба прислать переписку сбивали
    //    новичков посреди работы. Документированный выключатель — только если не задан.
    if (!has(settings, 'env')) settings.env = {};
    if (isObj(settings.env) && !has(settings.env, 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY')) {
      settings.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY = '1';
      done.short.push('опрос Claude');
      done.push('выключил опрос «How is Claude doing this session?» (env CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1)');
    }
    // 2б. MCP_TIMEOUT: пак с 19.08 по 06.09 отдавал 30000 мс, потом вернул 120000 — npx на
    //     холодном кэше качает пакет MCP-сервера дольше 30 секунд, и сервер «не подключался».
    //     У ранних установок осталось 30000. Поднимаем ТОЛЬКО ровно строку "30000": любое
    //     другое значение (и число, и чужая строка) человек выбрал сам. Шаг одноразовый, как и
    //     остальные значения по умолчанию: вернёт 30000 обратно — повторный запуск не тронет.
    if (isObj(settings.env) && has(settings.env, 'MCP_TIMEOUT') && settings.env.MCP_TIMEOUT === '30000') {
      settings.env.MCP_TIMEOUT = '120000';
      done.short.push('MCP_TIMEOUT 30000 → 120000');
      done.push('поднял env MCP_TIMEOUT с 30000 до 120000 мс — MCP-серверы на холодном кэше npx стартуют дольше 30 секунд');
    }
  }

  // 3. Правила разрешений, на которые Claude Code ругается при каждом запуске.
  //    • allow: правило с путём в Write/MultiEdit/NotebookEdit/Glob сейчас НЕ ДЕЙСТВУЕТ. Если
  //      «близнец» (Edit/Read с тем же путём) уже есть в списке — убираем лишнее, права не
  //      меняются. Если нет — НЕ трогаем и подсказываем: замена превратила бы неработающее
  //      правило в работающее разрешение, которого у человека на деле нет, а решать это ему.
  //    • deny и ask: заменяем «близнецом» на том же месте — запрет и вопрос только
  //      ужесточаются (правило, которое не срабатывало, начинает срабатывать).
  if (isObj(settings.permissions)) {
    const perm = settings.permissions;
    ['allow', 'deny', 'ask'].forEach((listName) => {
      const orig = perm[listName];
      if (!Array.isArray(orig)) return;
      const out = [];
      const notes = [];
      orig.forEach((r) => {
        const fix = typeof r === 'string' ? warnedRuleFix(r, listName) : null;
        if (!fix) { out.push(r); return; }
        if (orig.indexOf(fix) !== -1 || out.indexOf(fix) !== -1) { notes.push(r + ' убрал (' + fix + ' уже есть)'); return; }
        if (listName === 'allow') {
          out.push(r);
          if (hints) hints.push('permissions.allow: ' + r + ' не действует — для файлов Claude Code читает только ' + fix + '. Оставил как есть: замена выдала бы разрешение, которого сейчас нет. Нужен доступ — замени сам на ' + fix + '.');
          return;
        }
        out.push(fix);
        notes.push(r + ' → ' + fix);
      });
      if (notes.length) {
        perm[listName] = out;
        done.short.push('правила permissions.' + listName + ' (' + notes.length + ')');
        done.push('permissions.' + listName + ': ' + notes.join('; ') + ' — ' + (listName === 'allow'
          ? 'это дубли правил, которые Claude Code и так не применял (рабочий близнец уже в списке) — права не изменились'
          : 'такое правило не срабатывало и Claude Code предупреждал о нём при каждом запуске; теперь оно действует (запрет или вопрос — только строже)'));
      }
    });
  }

  // 4. HTTP-хуки с незаполненным адресом VSCODE_PORT (http://127.0.0.1:VSCODE_PORT/hook):
  //    Claude Code отвергает такой URL целиком — «Settings Error», меню «Fix with Claude».
  //    Опустевшую группу и опустевшее событие убираем вместе с хуком; чужие хуки целы.
  if (isObj(settings.hooks)) {
    const hooks = settings.hooks;
    let removed = 0;
    Object.keys(hooks).forEach((ev) => {
      const groups = hooks[ev];
      if (!Array.isArray(groups)) return;
      const groupsOut = [];
      let evChanged = false;
      groups.forEach((g) => {
        if (!isObj(g) || !Array.isArray(g.hooks)) { groupsOut.push(g); return; }
        const keep = g.hooks.filter((h) => {
          const url = isObj(h) && has(h, 'url') && h.url !== null ? String(h.url) : '';
          if (/VSCODE_PORT/i.test(url)) { removed++; evChanged = true; return false; }
          return true;
        });
        if (keep.length === g.hooks.length) { groupsOut.push(g); return; }
        if (keep.length > 0) { g.hooks = keep; groupsOut.push(g); }
      });
      if (evChanged) {
        if (groupsOut.length) hooks[ev] = groupsOut;
        else delete hooks[ev];
      }
    });
    if (removed) {
      done.short.push('хуки VSCODE_PORT (' + removed + ')');
      done.push('убрал HTTP-хуки с незаполненным адресом VSCODE_PORT (' + removed + ' шт.) — из-за них Claude Code показывал «Settings Error»');
    }
  }

  // 5. Раздел mcpServers: Claude Code читает MCP-серверы из ~/.claude.json и .mcp.json,
  //    в settings.json он мёртв (пак убрал его 06.09). Копия остаётся в бэкапе.
  if (has(settings, 'mcpServers')) {
    const n = isObj(settings.mcpServers) ? Object.keys(settings.mcpServers).length : 0;
    delete settings.mcpServers;
    done.short.push('раздел mcpServers');
    done.push('убрал раздел mcpServers (' + n + ' серв.) — в settings.json Claude Code его не читает; копия — в бэкапе');
  }
  return done;
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { return false; }
}
function isFileLike(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}
function pathExists(p) {
  try { fs.lstatSync(p); return true; } catch (e) { return false; }
}

// Записать файл так, чтобы не писать «сквозь» ссылку и не оставить половину: новый временный
// файл рядом (флаг wx — O_EXCL, падает на любом занятом имени, в том числе на ссылке), затем
// rename поверх целевого (подменённая ссылка на целевом имени заменяется, а не пишется
// насквозь; читатель видит либо старый файл, либо новый целиком — kill посреди записи не
// оставляет обрубок). Каталог и целевой файл проверяются на ссылку и ПЕРЕД созданием
// временного файла, и ПЕРЕД rename: между проверкой и записью другой процесс того же
// пользователя мог подменить каталог ссылкой. Права берём у заменяемого файла — в env
// человека бывают ключи API. Бросает исключение с причиной.
//
// Перенос поверх целевого повторяется при временном замке (RENAME_RETRY): на Windows только что
// прочитанный или записанный файл на мгновенье держит антивирус или индексатор поиска, и rename
// падает EPERM/EBUSY/EACCES — само проходит через доли секунды. На macOS/Linux rename поверх
// открытого файла не падает, и цикл не повторяется ни разу. Ссылку проверяем перед КАЖДОЙ
// попыткой: пауза — это окно для подмены каталога. Целевой путь, который не файл (каталог),
// повторами не лечится — отказ сразу.
const RENAME_RETRY = { attempts: 8, baseMs: 150 };   // отдельным объектом — чтобы тест не ждал секунды
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* ждём */ } }
}
function renameOver(tmp, file, dir) {
  for (let attempt = 1; ; attempt++) {
    if (isLink(dir) || isLink(file)) throw new Error('каталог или файл стал ссылкой во время записи: ' + file);
    try { fs.renameSync(tmp, file); return; } catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      let notAFile = false;
      try { notAFile = fs.lstatSync(file).isDirectory(); } catch (x) { notAFile = false; }
      if (!transient || notAFile || attempt >= RENAME_RETRY.attempts) throw e;
      sleepSync(RENAME_RETRY.baseMs * attempt);
    }
  }
}
function writeFileSafe(file, buf, mode) {
  const dir = path.dirname(file);
  if (isLink(dir) || isLink(file)) throw new Error('каталог или файл — ссылка (symlink): ' + file);
  if (mode === undefined) { try { mode = fs.statSync(file).mode; } catch (e) { mode = 0o644; } }
  const tmp = file + '.hamidun-tmp-' + process.pid + '-' + Math.random().toString(16).slice(2, 10);
  let fd = null;
  let created = false;
  try {
    fd = fs.openSync(tmp, 'wx', mode & 0o777);
    created = true;
    try { fs.fchmodSync(fd, mode & 0o777); } catch (e) { /* umask мог убрать биты — права не шире оригинала */ }
    fs.writeSync(fd, buf, 0, buf.length);
    fs.closeSync(fd);
    fd = null;
    renameOver(tmp, file, dir);
    created = false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* уже закрыт */ } }
    if (created) { try { fs.unlinkSync(tmp); } catch (e) { /* нечего убирать */ } }
  }
}

function stamp(d) {
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
}
// Местное время без пояса, как у Windows (`(Get-Date).ToString('s')`): значение в отметке шага
// только для человека, код смотрит лишь на наличие ключа, но одинаковая запись на двух
// платформах не вводит в заблуждение при разборе.
function isoLocal(d) {
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
}

// Копия файла рядом: <имя>.hamidun-bak-<дата-время>. Флаг wx не перезапишет и не пройдёт
// сквозь занятое имя (файл, каталог или ссылка, в том числе висячая) — берётся следующее
// (-2 … -9). Две правки в одну секунду не затирают первую копию (там исходный файл).
// Недописанная копия (диск полон) убирается. На ссылку вместо каталога не пишет.
// Возвращает { path } или { err }.
function createBackup(file, bytes, mode) {
  const dir = path.dirname(file);
  const base = file + '.hamidun-bak-' + stamp(new Date());
  let lastErr = null;
  for (let i = 1; i <= 9; i++) {
    if (isLink(dir)) return { err: new Error('~/.claude стал ссылкой (symlink)') };
    const name = i === 1 ? base : base + '-' + i;
    let fd = null;
    let made = false;
    try {
      fd = fs.openSync(name, 'wx', mode & 0o777);
      made = true;
      try { fs.fchmodSync(fd, mode & 0o777); } catch (e) { /* права не шире оригинала */ }
      fs.writeSync(fd, bytes, 0, bytes.length);
      fs.closeSync(fd);
      fd = null;
      return { path: name };
    } catch (e) {
      lastErr = e;
      if (fd !== null) { try { fs.closeSync(fd); } catch (x) { /* уже закрыт */ } }
      if (made) { try { fs.unlinkSync(name); } catch (x) { /* нечего убирать */ } return { err: e }; }
      // Занятое имя: файл и каталог — EEXIST; на некоторых системах каталог или ссылка дают
      // «отказано в доступе». И то и другое — повод взять следующее имя, а не бросать ошибку.
      const taken = e && (e.code === 'EEXIST' || ((e.code === 'EPERM' || e.code === 'EACCES') && pathExists(name)));
      if (!taken) return { err: e };
    }
  }
  return { err: lastErr || new Error('девять имён копии заняты') };
}

// Ввод-вывод вокруг applyFixes. fresh — файл только что положен НАМИ из пака (его не было,
// или «Переустановить начисто» перезаписал его): тогда значения по умолчанию применяются без
// оглядки на отметку — это наш файл, а не выбор человека. markerPath — отметка применённых
// шагов (~/.hamidun-setup/config-migrations.json), формат тот же, что на Windows.
function migrateFile(file, fresh, markerPath, log, detail) {
  const say = log || ((s) => process.stdout.write(s + '\n'));
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return 'absent'; }
  // Файл или каталог-ссылка: правка ушла бы во ВНЕШНЮЮ цель — не трогаем (то же правило,
  // что у раскладки в config.sh: сквозь ссылку не пишем).
  if (st.isSymbolicLink() || isLink(path.dirname(file))) {
    say('Настройки Claude Code: settings.json или ~/.claude — ссылка (symlink), правки пропускаю (внешний файл не трогаю).');
    return 'link';
  }
  if (!st.isFile()) return 'absent';
  let bytes;
  let text;
  let bom = false;
  try {
    bytes = fs.readFileSync(file);
    bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    // Строгий UTF-8: битый файл не «чиним», а оставляем как есть.
    text = new (require('util').TextDecoder)('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch (e) {
    say('Настройки Claude Code: settings.json прочитать не удалось (' + (e && e.message) + ') — правки пропускаю.');
    return 'unreadable';
  }
  let obj = null;
  if (text.replace(/^\s+/, '').charAt(0) === '{') {
    try { obj = JSON.parse(text); } catch (e) { obj = null; }
  }
  if (!isObj(obj)) {
    say('Настройки Claude Code: settings.json не разбирается как JSON-объект — правки пропускаю, файл не трогаю.');
    return 'unparsable';
  }

  let applied = {};
  if (markerPath) {
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (isObj(m)) Object.keys(m).forEach((k) => { applied[k] = String(m[k]); });
    } catch (e) { applied = {}; }
  }
  const defaults = !!fresh || !has(applied, DEFAULTS_STEP_ID);
  const hints = [];
  const changes = applyFixes(obj, defaults, hints);
  hints.forEach((h) => say('Настройки Claude Code: ' + h));
  let result = 'clean';

  if (changes.length) {
    const nl = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
    const tail = text.endsWith('\n') ? nl : '';
    const render = (o) => JSON.stringify(o, null, 2).replace(/\n/g, nl) + tail;
    const newText = render(obj);
    // Самопроверка записи: разобранный обратно текст обязан дать ровно тот же текст.
    // Не сошлось — ошибка у нас, а не у человека: файл не трогаем.
    let same = false;
    try { same = render(JSON.parse(newText)) === newText; } catch (e) { same = false; }
    if (!same) {
      say('Настройки Claude Code: самопроверка записи не прошла — settings.json оставляю как есть.');
      return 'selfcheck';
    }
    // Копия с теми же правами, что у оригинала: в env человека бывают ключи API.
    const bk = createBackup(file, bytes, st.mode);
    if (!bk.path) {
      say('Настройки Claude Code: копию снять не удалось (' + (bk.err && bk.err.message) + ') — settings.json не трогаю.');
      return 'nobackup';
    }
    const bak = bk.path;
    try {
      const body = Buffer.from(newText, 'utf8');
      writeFileSafe(file, bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]) : body, st.mode);
    } catch (e) {
      say('Настройки Claude Code: записать settings.json не удалось (' + (e && e.message) + '). Копия до правки: ' + bak);
      if (detail) detail.backup = bak;
      return 'nowrite';
    }
    say('Настройки Claude Code (~/.claude/settings.json): убрал устаревшее из прошлых версий пака. Копия до правки: ' + bak);
    changes.forEach((c) => say('  • ' + c));
    result = 'changed';
    if (detail) { detail.short = changes.short || []; detail.backup = bak; }
  } else {
    say('Настройки Claude Code: устаревших правок в settings.json нет — файл не менял.');
  }

  if (markerPath && !has(applied, DEFAULTS_STEP_ID)) {
    applied[DEFAULTS_STEP_ID] = isoLocal(new Date());
    try {
      const mdir = path.dirname(markerPath);
      if (isLink(mdir)) throw new Error('каталог отметки — ссылка (symlink): ' + mdir);
      fs.mkdirSync(mdir, { recursive: true });
      writeFileSafe(markerPath, Buffer.from(JSON.stringify(applied, null, 2) + '\n', 'utf8'));
    } catch (e) { /* без отметки шаг значений по умолчанию просто повторится один раз — не беда */ }
  }
  return result;
}

// ---- Опись поставленного: CATALOG.md пака и сводка для финального экрана ----------------------
// CATALOG.md пака кладём в ~/.claude (раньше он оставался в корне пака, и человек не находил,
// что вообще встало), а цифры — в ~/.hamidun-setup/config-summary.json: финальный экран пишет
// «Установлено N навыков, M агентов». Считаем то, что реально лежит в ~/.claude после раскладки
// и фильтра наборов. onlyIfMissing (touchup-config.sh, config не ставился в этом прогоне):
// существующий CATALOG.md не заменяем — раскладка не делалась, и каталог другой версии пака
// описывал бы не то, что лежит на диске. Пака под рукой нет (clone пуст) — каталог не кладём,
// а цифры всё равно пишем. skipUnchanged (там же): файл сводки не переписываем, если цифры те
// же, — повторный прогон не должен менять ни байта. Зеркало Write-HmConfigSummary.

// Сколько .md (кроме README) лежит в каталоге на глубину depth; ссылки на каталоги пропускаем.
function mdCount(dir, depth) {
  let n = 0;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  ents.forEach((f) => {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) { if (depth > 0) n += mdCount(full, depth - 1); return; }
    if (f.isSymbolicLink()) { try { if (fs.statSync(full).isDirectory()) return; } catch (e) { /* висячая ссылка — как файл */ } }
    if (/\.md$/i.test(f.name) && f.name.toLowerCase() !== 'readme.md') n++;
  });
  return n;
}

function writeConfigSummary(clone, claudeHome, setupDir, opts) {
  const o = opts || {};
  const say = o.say || ((s) => process.stdout.write(s + '\n'));
  const res = { catalogPlaced: false, summaryWritten: false, skills: 0, agents: 0, commands: 0, catalog: '' };
  const catalogDst = path.join(claudeHome, 'CATALOG.md');
  const src = clone ? path.join(clone, 'CATALOG.md') : '';
  const haveSrc = !!src && isFileLike(src);
  const haveDst = isFileLike(catalogDst);
  let catalogOut = '';
  if (isLink(claudeHome) || isLink(catalogDst)) {
    say('  ~/.claude или CATALOG.md в нём — ссылка, каталог пака не пишу.');
  } else if (haveSrc && !(o.onlyIfMissing && haveDst)) {
    try {
      writeFileSafe(catalogDst, fs.readFileSync(src));
      catalogOut = catalogDst;
      res.catalogPlaced = true;
    } catch (e) { say('  Каталог пака (CATALOG.md) скопировать не удалось: ' + (e && e.message)); }
  } else if (haveDst) {
    catalogOut = catalogDst;
  } else {
    say('  CATALOG.md пака сейчас недоступен — каталог навыков не положен.');
  }
  let skills = 0;
  const skillsDir = path.join(claudeHome, 'skills');
  try {
    fs.readdirSync(skillsDir, { withFileTypes: true }).forEach((d) => {
      const full = path.join(skillsDir, d.name);
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch (e) { isDir = false; } }
      if (isDir && isFileLike(path.join(full, 'SKILL.md'))) skills++;
    });
  } catch (e) { /* нет каталога skills — ноль */ }
  const agents = mdCount(path.join(claudeHome, 'agents'), 2);
  const commands = mdCount(path.join(claudeHome, 'commands'), 2);
  Object.assign(res, { skills, agents, commands, catalog: catalogOut });
  const summaryFile = path.join(setupDir, 'config-summary.json');
  try {
    if (isLink(setupDir)) throw new Error('каталог ~/.hamidun-setup — ссылка (symlink)');
    let same = false;
    if (o.skipUnchanged) {
      try {
        const old = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        same = isObj(old) && old.skills === skills && old.agents === agents && old.commands === commands && old.catalog === catalogOut;
      } catch (e) { same = false; }
    }
    if (!same) {
      fs.mkdirSync(setupDir, { recursive: true });
      const summary = { skills, agents, commands, catalog: catalogOut, at: Date.now() };
      writeFileSafe(summaryFile, Buffer.from(JSON.stringify(summary, null, 2) + '\n', 'utf8'));
      res.summaryWritten = true;
    }
  } catch (e) { say('  Сводку конфига записать не удалось: ' + (e && e.message)); }
  say('В ~/.claude сейчас: навыков ' + skills + ', агентов ' + agents + ', команд ' + commands + (catalogOut ? ' — перечень в ~/.claude/CATALOG.md' : '') + '.');
  return res;
}

// ---- Карта конфига для Codex: AGENTS.md пака → ~/.codex/AGENTS.md ------------------------------
// Codex (расширение «ChatGPT» openai.chatgpt-* для VS Code и одноимённый CLI) читает ГЛОБАЛЬНЫЙ
// AGENTS.md из своего домашнего каталога ~/.codex (AGENTS.override.md, если он есть, читается
// вместо AGENTS.md). В паке AGENTS.md лежит в корне и ведёт агента к каталогу навыков, но туда,
// где Codex его ищет, его никто не клал: у тех, кто работает ТОЛЬКО через Codex, без Claude
// Code, пак оставался невидимым. Файл в ~/.codex — это файл ЧЕЛОВЕКА, поэтому:
//   • Codex на машине нет (ни ~/.codex, ни расширения) — ничего не создаём;
//   • файла нет — создаём; содержимое пака лежит в отмеченном блоке, чтобы потом узнать своё;
//   • файл есть, блока в нём нет — дописываем отмеченный блок В КОНЕЦ, остальное байт в байт;
//   • блок уже есть — не трогаем (ни повторно, ни «обновлением»: хочешь свежий — удали блок);
//   • вместо ~/.codex или AGENTS.md ссылка, либо файл не в UTF-8 — не пишем.
// Каталог берётся ТОЛЬКО под профилем пользователя: переменную CODEX_HOME не читаем — путь из
// окружения сделал бы запись произвольной. В скопированном тексте единственная относительная
// ссылка на каталог навыков (CATALOG.md рядом с AGENTS.md в корне пака) переписана на
// ~/.claude/CATALOG.md: именно туда кладётся каталог, а рядом с ~/.codex/AGENTS.md его нет.
const PACK_BLOCK_BEGIN = '<!-- hamidun-pack begin -->';
const PACK_BLOCK_END = '<!-- hamidun-pack end -->';

function codexPresent(userHome) {
  try {
    if (pathExists(path.join(userHome, '.codex'))) return true;
    for (const editor of ['.vscode', '.vscode-oss', '.cursor']) {
      const ext = path.join(userHome, editor, 'extensions');
      let names;
      try { names = fs.readdirSync(ext, { withFileTypes: true }); } catch (e) { continue; }
      if (names.some((d) => (d.isDirectory() || d.isSymbolicLink()) && /^openai\.chatgpt-/i.test(d.name))) return true;
    }
  } catch (e) { /* не нашли — значит, нет */ }
  return false;
}

// Возвращает статус строкой: 'created' | 'appended' | 'present' | 'no-codex' | 'no-source' |
// 'link' | 'skipped' | 'failed' (причина напечатана). Исключений наружу не бросает.
function installCodexAgents(source, userHome, log) {
  const say = log || ((s) => process.stdout.write(s + '\n'));
  try {
    if (!isFileLike(source)) return 'no-source';
    if (!codexPresent(userHome)) return 'no-codex';
    const codexDir = path.join(userHome, '.codex');
    const dst = path.join(codexDir, 'AGENTS.md');
    if (isLink(codexDir) || isLink(dst)) {
      say('Codex: ~/.codex или AGENTS.md в нём — ссылка (symlink), AGENTS.md пака не кладу (внешний файл не трогаю).');
      return 'link';
    }
    if (pathExists(codexDir) && !fs.statSync(codexDir).isDirectory()) {
      say('Codex: ~/.codex — не каталог, AGENTS.md пака не кладу.');
      return 'skipped';
    }
    const strict = new (require('util').TextDecoder)('utf-8', { fatal: true });
    const skipBom = (b) => (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? 3 : 0);
    // Пак не в UTF-8 — это поломанный пак, а не «нет источника»: исключение уходит в catch ниже,
    // человек видит причину (как в Windows-версии), файл не трогается.
    const srcBytes = fs.readFileSync(source);
    let packText = strict.decode(srcBytes.subarray(skipBom(srcBytes))).trim();
    if (!packText) return 'no-source';
    packText = packText.split('](CATALOG.md)').join('](~/.claude/CATALOG.md)');

    const exists = isFileLike(dst);
    let existing = Buffer.alloc(0);
    let nl = '\n';
    if (exists) {
      existing = fs.readFileSync(dst);
      let oldText;
      try { oldText = strict.decode(existing.subarray(skipBom(existing))); } catch (e) {
        say('Codex: ~/.codex/AGENTS.md не в кодировке UTF-8 — не трогаю, блок пака не дописываю.');
        return 'skipped';
      }
      if (oldText.indexOf(PACK_BLOCK_BEGIN) !== -1) return 'present';
      if (oldText.indexOf('\r\n') !== -1) nl = '\r\n';
    } else if (packText.indexOf('\r\n') !== -1) {
      nl = '\r\n';
    }
    const block = PACK_BLOCK_BEGIN + nl + packText.replace(/\r\n/g, '\n').replace(/\n/g, nl) + nl + PACK_BLOCK_END + nl;
    let lead = '';
    if (existing.length > 0) {
      // пустая строка между текстом человека и нашим блоком
      lead = nl;
      if (existing[existing.length - 1] !== 0x0A) lead = nl + nl;
    }
    const newBytes = Buffer.concat([existing, Buffer.from(lead + block, 'utf8')]);

    if (!pathExists(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
      // между проверкой и созданием процесс обычного пользователя мог подсунуть ссылку
      if (isLink(codexDir)) {
        say('Codex: ~/.codex оказался ссылкой (symlink) — AGENTS.md пака не кладу.');
        return 'link';
      }
    }
    writeFileSafe(dst, newBytes);
    if (exists) {
      say('Codex: в ~/.codex/AGENTS.md уже был твой файл — дописал в конец блок пака между метками ' + PACK_BLOCK_BEGIN + ' и ' + PACK_BLOCK_END + ', остальное не тронуто. Убрать: удали блок между метками.');
      return 'appended';
    }
    say('Codex: положил карту конфига в ~/.codex/AGENTS.md — Codex читает глобальный AGENTS.md оттуда и по нему находит навыки пака (каталог: ~/.claude/CATALOG.md).');
    return 'created';
  } catch (e) {
    say('Codex: AGENTS.md пака положить не удалось (' + ((e && e.message) || e) + ') — на остальную установку это не влияет.');
    return 'failed';
  }
}

// ---- Режим always-run правки (scripts/macos/touchup-config.sh) ----------------------------------
// Тихий. Ничего не печатает, если править нечего; ОДНА строка «ОБНОВЛЕНО: …» со всем, что
// изменилось; ОДНА строка «[touchup-config] пропущено: …» со всем, что трогать нельзя или не
// вышло. Исключения не пробрасываются — контракт touchup-скриптов: НИКОГДА не падать.
// Установленный компонент при повторном запуске снимается с галочки, и правки внутри его
// скрипта (config.sh) до такого человека не доходили. Здесь то же самое, но по содержимому
// профиля, а не по галочкам:
//   • settings.json (миграция) и опись пака — только если config НЕ ставился в этом прогоне
//     (иначе их уже сделал config.sh) и файл настроек есть; CATALOG.md кладём лишь когда пак
//     под рукой и в ~/.claude каталога ещё нет;
//   • карта для Codex — всегда, когда пак под рукой: расширение Codex могло встать позже
//     config.sh, а повтор безвреден — свой блок узнаётся, файл не меняется.
const TOUCHUP_SKIP = {
  link: 'settings.json или ~/.claude — ссылка (symlink), внешний файл не трогаю',
  unreadable: 'settings.json не читается как UTF-8, файл не трогаю',
  unparsable: 'settings.json не разбирается как JSON-объект, файл не трогаю',
  selfcheck: 'самопроверка записи не прошла, файл не трогаю',
  nobackup: 'не удалось снять копию перед правкой, файл не трогаю',
};
const noop = () => {};
function runTouchup(userHome, packDir, configSelected, out) {
  const say = out || ((s) => process.stdout.write(s + '\n'));
  const claudeHome = path.join(userHome, '.claude');
  const setupDir = path.join(userHome, '.hamidun-setup');
  const settings = path.join(claudeHome, 'settings.json');
  const changed = [];
  const skipped = [];
  try {
    if (!configSelected && pathExists(settings)) {
      const detail = {};
      const res = migrateFile(settings, false, path.join(setupDir, 'config-migrations.json'), noop, detail);
      if (res === 'changed') {
        changed.push('~/.claude/settings.json — убрал устаревшее из прошлых версий пака (' + (detail.short || []).join('; ') + '); копия до правки: ' + detail.backup);
      } else if (res === 'nowrite') {
        skipped.push('не удалось записать settings.json (копия до правки: ' + detail.backup + ')');
      } else if (TOUCHUP_SKIP[res]) {
        skipped.push(TOUCHUP_SKIP[res]);
      }
      const hasCatalog = !!packDir && isFileLike(path.join(packDir, 'CATALOG.md'));
      // Сводку для финального экрана пишем молча: это служебный файл, человеку о нём знать не
      // нужно. Заметна только новая видимая вещь — каталог навыков в ~/.claude.
      const sum = writeConfigSummary(hasCatalog ? packDir : '', claudeHome, setupDir, { onlyIfMissing: true, skipUnchanged: true, say: noop });
      if (sum.catalogPlaced) changed.push('положил ~/.claude/CATALOG.md — каталог навыков пака');
    }
  } catch (e) {
    skipped.push('непредвиденная ошибка (' + String((e && e.message) || e).slice(0, 120) + ')');
  }
  try {
    const agentsSrc = packDir ? path.join(packDir, 'AGENTS.md') : '';
    if (agentsSrc && isFileLike(agentsSrc)) {
      const st = installCodexAgents(agentsSrc, userHome, noop);
      if (st === 'created') changed.push('~/.codex/AGENTS.md — положил карту конфига для Codex');
      else if (st === 'appended') changed.push('~/.codex/AGENTS.md — дописал блок пака в твой файл (убрать: удали блок между метками)');
      else if (st === 'link') skipped.push('~/.codex или AGENTS.md в нём — ссылка (symlink), карту для Codex не кладу');
      else if (st === 'skipped') skipped.push('~/.codex/AGENTS.md не в UTF-8 или ~/.codex не каталог — карту для Codex не кладу');
      else if (st === 'failed') skipped.push('карту для Codex положить не удалось');
    }
  } catch (e) {
    skipped.push('непредвиденная ошибка Codex (' + String((e && e.message) || e).slice(0, 120) + ')');
  }
  if (changed.length) say('ОБНОВЛЕНО: ' + changed.join('; '));
  if (skipped.length) say('[touchup-config] пропущено: ' + skipped.join('; '));
  return { changed, skipped };
}

module.exports = {
  OFF_PLUGINS, DEFAULTS_STEP_ID, PACK_BLOCK_BEGIN, PACK_BLOCK_END,
  warnedRuleFix, applyFixes, migrateFile, writeFileSafe, RENAME_RETRY, createBackup,
  writeConfigSummary, codexPresent, installCodexAgents, runTouchup,
};

if (require.main === module) {
  const a = process.argv.slice(2);
  // Режимы, которые зовут скрипты установщика: что бы ни случилось, наружу выходим кодом 0 —
  // сбой описи или карты для Codex на установку не влияет (строка о причине уже напечатана).
  try {
    if (a[0] === '--touchup') {
      runTouchup(a[1] || '', a[2] || '', a[3] === '1');
      process.exit(0);
    }
    if (a[0] === '--summary') {
      writeConfigSummary(a[3] || '', a[1] || '', a[2] || '', {});
      process.exit(0);
    }
    if (a[0] === '--codex') {
      installCodexAgents(a[2] || '', a[1] || '');
      process.exit(0);
    }
  } catch (e) {
    process.stdout.write('[_cfgmigrate] ' + ((e && e.message) || e) + '\n');
    process.exit(0);
  }
  if (a.length < 2) {
    process.stderr.write('usage: node _cfgmigrate.js <settings.json> <fresh 1|0> [marker.json]\n'
      + '       node _cfgmigrate.js --summary <~/.claude> <~/.hamidun-setup> [пак]\n'
      + '       node _cfgmigrate.js --codex <домашний каталог> <AGENTS.md пака>\n'
      + '       node _cfgmigrate.js --touchup <домашний каталог> [пак] [config выбран 1|0]\n');
    process.exit(2);
  }
  migrateFile(a[0], a[1] === '1', a[2] || '');
}
