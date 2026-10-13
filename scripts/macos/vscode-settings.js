// Настройки VS Code для новичка — macOS. Запуск: osascript -l JavaScript vscode-settings.js <HOME> [dry|touchup]
//
// Зеркало scripts/windows/vscode-settings.ps1 в части settings.json и argv.json: тот же
// разбор JSON с комментариями, те же ключи, та же отметка .hamidun-applied.json. Ярлыка и
// профиля терминала здесь нет — они про Windows (cmd и ярлыки «Пуска»).
//
// Два входа, как у Windows-версии:
//   - без второго аргумента — подробный ход из vscode.sh (ловушка EXIT в vscode-firstrun.sh);
//   - «touchup» — тихий ход из touchup-vscode.sh (его зовёт проверка при каждом запуске
//     установщика, в том числе когда карточка VS Code снята как «уже установлено»): ОДНА
//     строка «ОБНОВЛЕНО: …» только если что-то изменилось, «[touchup-vscode] пропущено: …»,
//     если сделать не вышло, иначе пусто;
//   - «dry» — только строки [dry-run], на диске ничего не меняется.
//
// Почему JavaScript для osascript, а не bash: правка чужого JSONC без разбора — это
// регулярки по живому файлу, а python3 на чистом Mac без Command Line Tools вызывает окно
// «установить инструменты разработчика» (строка A12 разбора). osascript есть в любой macOS.
//
// Почему файл один на двоих: чистые функции ниже (без ObjC) экспортируются для Node —
// test/run-tests.js гоняет их напрямую и сверяет с PowerShell-версией на одном наборе
// файлов. Функции run()/macIo() — точка входа osascript; Node их не вызывает.
//
// Тексты строк лога — без многоточия на конце и без слов «не найден», «не удалось»,
// «ошибка»: шаг печатает ПОСЛЕ сообщений о расширениях, и src/failure-explain.js принял бы
// такие строки за этап и причину провала всего шага VS Code.
'use strict';

const HM_SETTINGS = [
  // Прячет встроенный чат Copilot и все его входы (кнопка «Sign in», меню аккаунтов).
  ['chat.disableAIFeatures', true],
  // Правая панель по умолчанию скрыта: там жили сразу Copilot, Codex и боковая панель
  // Claude, и новичок писал не туда. Claude открывается кнопкой ✳ над файлом.
  ['workbench.secondarySideBar.defaultVisibility', 'hidden'],
  // Без всплывающих «поставь рекомендуемое расширение»; предложение русского пакета этот
  // ключ не гасит — оно живёт отдельно.
  ['extensions.ignoreRecommendations', true],
  // Без английской страницы Welcome при открытии папки.
  ['workbench.startupEditor', 'none'],
  // Доверие к папкам выключено — решение владельца 06.10 (строка A03): в «Restricted Mode»
  // VS Code молча гасил панель Claude и задачи, а с 1.131 даже не спрашивает (startupPrompt
  // по умолчанию never). Решение принято в предположении, что иного пути нет. Он есть,
  // но другой: доверить заранее только HamidunStart и курс ключом нельзя (список доверенных
  // папок VS Code держит в своей базе состояния), зато extensions.supportUntrustedWorkspaces
  // (документирована, область «приложение») снимает ограничение с одного расширения и
  // оставляет Restricted Mode для всего остального; в решение владельца это не вошло.
  ['security.workspace.trust.enabled', false],
];

const HM_NOTES = {
  'chat.disableAIFeatures': 'встроенный чат Copilot скрыт: писать нужно в Claude',
  'workbench.secondarySideBar.defaultVisibility': 'правая панель с чатами скрыта, Claude открывается кнопкой ✳ над файлом',
  'extensions.ignoreRecommendations': 'без всплывающих советов поставить расширения',
  'workbench.startupEditor': 'без английской страницы Welcome',
  'security.workspace.trust.enabled': 'без «Restricted Mode»: панель Claude и задачи работают в любой папке',
  'locale': 'интерфейс VS Code на русском после перезапуска',
};

// Файл больше этого не разбираем: разбор идёт токен за токеном, а шаг обязан уложиться в
// несколько секунд. Тот же потолок, что у Windows-версии.
const HM_MAX_CHARS = 262144;
// Потолок в БАЙТАХ до чтения файла в память (находка M-10/N2): символ UTF-8 занимает до 4 байт, так что
// файл в HM_MAX_CHARS символов не больше 4×HM_MAX_CHARS байт. Всё крупнее не читаем вообще — прежний код
// сначала загружал файл целиком (NSData) и только потом сверял длину текста.
const HM_MAX_BYTES = 4 * HM_MAX_CHARS;

// Годится ли путь для чтения: ТОЛЬКО обычный файл разумного размера. info — { type, size } из атрибутов
// файла или null, если атрибуты не прочитались. Канал FIFO (NSFileTypeUnknown), устройство, сокет, папка:
// NSData.dataWithContentsOfFile на канале без писателя не возвращается НИКОГДА, и шаг VS Code встал бы
// навсегда. Чистая функция — тест гоняет её в Node. Тексты — без слов «не найден/не удалось/ошибка» (см. шапку).
function readVerdict(info) {
  if (!info || typeof info.type !== 'string') return { ok: false, error: 'тип файла не определён' };
  if (info.type !== 'NSFileTypeRegular') return { ok: false, error: 'это не обычный файл (папка, канал, устройство или ссылка)' };
  const size = Number(info.size);
  if (!(size >= 0)) return { ok: false, error: 'размер файла не определён' };
  if (size > HM_MAX_BYTES) return { ok: false, error: 'файл слишком большой (' + Math.floor(size / 1024) + ' КБ)' };
  return { ok: true };
}

// Является ли путь символической ссылкой — с отказом «закрытым» (находка M-10/N2). Прежний isSymlink()
// при недоступных атрибутах отвечал «нет», то есть ссылку, чьи атрибуты не прочитались, считал обычным
// файлом. type — NSFileType из атрибутов или null, если атрибуты не прочитались; listed — стоит ли имя в
// списке родительского каталога. Нет атрибутов и нет имени в каталоге — пути просто нет (не ссылка:
// на свежем Mac ~/Library/Application Support/Code/User ещё не создан). Нет атрибутов, но имя в каталоге
// есть — путь существует, а проверить его не вышло: считаем ссылкой, файл не трогаем.
function symlinkVerdict(type, listed) {
  if (typeof type === 'string') return type === 'NSFileTypeSymbolicLink';
  return !!listed;
}

// Токены JSONC — тот же набор, что в PowerShell-версии ($script:HmJsoncRx): пробел любой,
// включая неразрывный и BOM; в строке — сырой TAB и «\» с любым символом после (путь
// «C:\Python312\python.exe», вставленный из учебника, VS Code читает).
const HM_TOKEN_SRC = '(?:([ \\t\\r\\n\\v\\f\\u00A0\\uFEFF]+)|(//[^\\r\\n]*)|(/\\*[\\s\\S]*?\\*/)|' +
  '("(?:[^"\\\\\\r\\n]|\\\\[^\\n])*")|' +
  '(-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|' +
  '(true|false|null)|([{}\\[\\]:,]))';

function jsonString(value) {
  let out = '"';
  for (const ch of String(value)) {
    const c = ch.charCodeAt(0);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5C) out += '\\\\';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

// unit — один уровень отступа, base — отступ строки со значением (см. ConvertTo-HmJsonLiteral).
function jsonLiteral(value, unit, base, eol) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return jsonString(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return '[' + value.map((v) => jsonLiteral(v, unit, base, eol)).join(', ') + ']';
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  const inner = base + unit;
  return '{' + eol + keys.map((k) => inner + jsonString(k) + ': ' + jsonLiteral(value[k], unit, inner, eol))
    .join(',' + eol) + eol + base + '}';
}

// Имя ключа из токена строки: допустимые escape расшифровываются, недопустимые («\P») остаются.
function decodeKey(tok) {
  const inner = tok.slice(1, -1);
  if (inner.indexOf('\\') < 0) return inner;
  return inner.replace(/\\(?:u([0-9A-Fa-f]{4})|(["\\/bfnrt])|([^\n]))/g, (m, hex, simple) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    if (simple) return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[simple] || simple;
    return m;
  });
}

// Разбор формы файла — см. Get-HmJsoncShape в PowerShell-версии (тот же автомат).
function jsoncShape(text) {
  const r = { ok: false, empty: false, error: '', keys: [], tokens: [], closeIdx: -1, firstKeyIdx: -1 };
  const re = new RegExp(HM_TOKEN_SRC, 'y');
  let pos = 0;
  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m || !m[0].length) { r.error = 'непонятный символ в позиции ' + pos; return r; }
    const tok = { v: m[0], s: pos, e: pos + m[0].length };
    if (m[4] !== undefined) { tok.t = 'str'; r.tokens.push(tok); }
    else if (m[5] !== undefined || m[6] !== undefined) { tok.t = 'scalar'; r.tokens.push(tok); }
    else if (m[7] !== undefined) { tok.t = 'p'; r.tokens.push(tok); }
    pos += m[0].length;
  }
  const toks = r.tokens;
  if (!toks.length) { r.ok = true; r.empty = true; return r; }
  if (toks[0].v !== '{') { r.error = 'в корне файла не объект { }'; return r; }
  const stack = [];
  let expect = 'value';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; const v = t.v; let done = false;
    if (expect === 'end') { r.error = 'лишний текст после закрывающей скобки (позиция ' + t.s + ')'; return r; }
    else if (expect === 'value' || expect === 'value-or-close') {
      if (v === ']' && expect === 'value-or-close') { stack.pop(); done = true; }
      else if (v === '{') { stack.push('{'); expect = 'key-or-close'; }
      else if (v === '[') { stack.push('['); expect = 'value-or-close'; }
      else if (t.t === 'str' || t.t === 'scalar') { done = true; }
      else { r.error = 'ожидалось значение (позиция ' + t.s + ')'; return r; }
      if (stack.length > 256) { r.error = 'слишком глубокая вложенность'; return r; }
    } else if (expect === 'key-or-close') {
      if (v === '}') { stack.pop(); done = true; }
      else if (t.t === 'str') {
        if (stack.length === 1) {
          r.keys.push(decodeKey(v));
          if (r.firstKeyIdx < 0) r.firstKeyIdx = i;
        }
        expect = 'colon';
      } else { r.error = 'ожидалось имя ключа в кавычках (позиция ' + t.s + ')'; return r; }
    } else if (expect === 'colon') {
      if (v === ':') expect = 'value'; else { r.error = 'ожидалось двоеточие (позиция ' + t.s + ')'; return r; }
    } else {
      const top = stack[stack.length - 1];
      if (v === ',') expect = top === '{' ? 'key-or-close' : 'value-or-close';
      else if ((v === '}' && top === '{') || (v === ']' && top === '[')) { stack.pop(); done = true; }
      else { r.error = 'ожидалась запятая или закрывающая скобка (позиция ' + t.s + ')'; return r; }
    }
    if (done) {
      if (!stack.length) { expect = 'end'; r.closeIdx = i; } else expect = 'comma-or-close';
    }
  }
  if (expect !== 'end') { r.error = 'файл обрывается: нет закрывающей скобки'; return r; }
  r.ok = true;
  return r;
}

// Отступ строки, на которой начинается токен в позиции pos (если перед ним только пробелы).
function lineIndent(text, pos) {
  let j = pos - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  return (j < 0 || text[j] === '\n') ? text.slice(j + 1, pos) : '';
}

// Один уровень отступа файла: отступ первого ключа корня, если он из одних табов или из
// 1-8 пробелов; иначе четыре пробела (см. Get-HmIndentUnit).
function indentUnit(text, shape) {
  let unit = '    ';
  if (shape.firstKeyIdx >= 0) {
    const ind = lineIndent(text, shape.tokens[shape.firstKeyIdx].s);
    if (ind && (/^\t+$/.test(ind) || /^ {1,8}$/.test(ind))) unit = ind;
  }
  return unit;
}

// Вставка ключей в корневой объект — см. Add-HmJsoncKeys/Add-HmJsoncMembers. entries: [[ключ, значение], ...].
function addKeys(text, shape, entries, defaultEol) {
  let eol = defaultEol;
  if (text.includes('\r\n')) eol = '\r\n'; else if (text.includes('\n')) eol = '\n';
  const unit = shape.empty ? '    ' : indentUnit(text, shape);
  if (shape.empty) {
    const block = entries.map(([k, v]) => unit + jsonString(k) + ': ' + jsonLiteral(v, unit, unit, eol)).join(',' + eol);
    let prefix = text;
    if (prefix.length && !prefix.endsWith('\n')) prefix += eol;
    return prefix + '{' + eol + block + eol + '}' + eol;
  }
  let memberIndent = '';
  if (shape.closeIdx > 1 && shape.tokens[1].t === 'str') memberIndent = lineIndent(text, shape.tokens[1].s);
  if (!memberIndent) memberIndent = unit;
  const block = entries.map(([k, v]) => memberIndent + jsonString(k) + ': ' + jsonLiteral(v, unit, memberIndent, eol)).join(',' + eol);
  const close = shape.tokens[shape.closeIdx];
  const last = shape.tokens[shape.closeIdx - 1];
  const needComma = last.v !== '{' && last.v !== ',';
  let j = close.s - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  let at; let ins;
  if (j < 0 || text[j] === '\n') { at = j + 1; ins = block + eol; } else { at = close.s; ins = eol + block + eol; }
  let out = text.slice(0, at) + ins + text.slice(at);
  if (needComma) out = out.slice(0, last.e) + ',' + out.slice(last.e);
  return out;
}

function keyCovered(keys, name) {
  return keys.some((k) => k === name || name.startsWith(k + '.') || k.startsWith(name + '.'));
}

// Первая ссылка на пути от якоря вниз до файла ('' — чисто). Как Get-HmLinkOnPath в
// PowerShell-версии, но на macOS установщик это шаг БЕЗ повышения прав: смысл проверки —
// не превратить молча в обычный файл ссылку человека (часто — на репозиторий dotfiles).
// includeAnchor=false — для домашней папки: сама она может быть ссылкой законно.
function linkOnPath(io, p, anchor, includeAnchor) {
  const chain = [];
  if (anchor && (p === anchor || p.startsWith(anchor + '/'))) {
    if (includeAnchor) chain.push(anchor);
    let cur = anchor;
    p.slice(anchor.length).split('/').filter(Boolean).forEach((seg) => { cur += '/' + seg; chain.push(cur); });
  } else {
    let cur = '';
    p.split('/').filter(Boolean).forEach((seg) => { cur += '/' + seg; chain.push(cur); });
  }
  for (const c of chain) {
    // Сначала ссылка: повисшая ссылка «не существует» для exists(), но она-то и опасна.
    if (io.isSymlink(c)) return c;
    if (!io.exists(c)) break;
  }
  return '';
}

// План правки одного файла без ввода-вывода. read: null (файла нет) | {ok, text, bom, error}.
// Результат: lines (журнал), write/newText/bom, added (ключи), kept, touched, skipped/reason,
// restored (откат файла целиком).
function planFile(name, read, wanted, marker, what, defaultEol) {
  const res = { lines: [], write: false, newText: '', bom: false, added: [], kept: 0, touched: [], skipped: false, reason: '', restored: false };
  let text = ''; let bom = false;
  if (read) {
    if (!read.ok) { res.skipped = true; res.reason = read.error; res.lines.push('  ' + name + ': ' + read.error + ' — оставляю файл как есть.'); return res; }
    if (read.text.length > HM_MAX_CHARS) {
      const kb = Math.floor(read.text.length / 1024);
      res.skipped = true; res.reason = 'файл слишком большой (' + kb + ' КБ)';
      res.lines.push('  ' + name + ': файл слишком большой (' + kb + ' КБ) — не разбираю, оставляю как есть.');
      return res;
    }
    text = read.text; bom = !!read.bom;
  }
  const shape = jsoncShape(text);
  if (!shape.ok) {
    res.skipped = true; res.reason = 'разобрать файл не вышло (' + shape.error + ')';
    res.lines.push('  ' + name + ': разобрать файл не вышло (' + shape.error + ') — оставляю его как есть, VS Code работает со своими настройками.');
    return res;
  }
  const fresh = []; const ourMissing = [];
  for (const [k, v] of wanted) {
    const ours = marker.has(what + ':' + k);
    if (keyCovered(shape.keys, k)) {
      if (!ours) { res.lines.push('  = ' + k + ': уже задан тобой — не трогаю.'); res.kept++; }
      res.touched.push(k);
    } else if (ours) ourMissing.push([k, v]);
    else fresh.push([k, v]);
  }
  // Нет сразу нескольких наших ключей — это откат файла целиком, а не «убрал по одному».
  if (what === 'settings' && ourMissing.length >= 4) {
    res.lines.push('  ' + name + ': нет сразу ' + ourMissing.length + ' ключей, которые установщик добавлял раньше, — похоже на откат файла целиком (синхронизация, копия) — возвращаю их.');
    ourMissing.forEach((e) => fresh.push(e));
    res.restored = true;
  } else {
    ourMissing.forEach(([k]) => { res.lines.push('  = ' + k + ': этого нет, а установщик раньше уже добавлял — считаю, что ты убрал сам, не возвращаю.'); res.kept++; });
  }
  if (!fresh.length) return res;
  const newText = addKeys(text, shape, fresh, defaultEol);
  const check = jsoncShape(newText);
  const lost = !check.ok || shape.keys.some((k) => !check.keys.includes(k)) || fresh.some(([k]) => !check.keys.includes(k));
  if (lost) {
    res.skipped = true; res.reason = 'после вставки файл не прошёл самопроверку';
    res.lines.push('  ' + name + ': после вставки файл не прошёл самопроверку — ничего не записываю, файл прежний.');
    return res;
  }
  res.write = true; res.newText = newText; res.bom = bom;
  res.added = fresh.map(([k]) => k);
  for (const [k, v] of fresh) {
    res.lines.push('  + ' + k + ' = ' + jsonLiteral(v, '', '', ' ') + (HM_NOTES[k] ? ' (' + HM_NOTES[k] + ')' : ''));
    res.touched.push(k);
  }
  return res;
}

// Русский языковой пакет на диске (см. Test-HmRuLanguagePack). io: {exists, readText, list}.
function ruPackInstalled(io, extDir) {
  if (!io.exists(extDir)) return false;
  const rx = /^ms-ceintl\.vscode-language-pack-ru-\d/i;
  const obsolete = {};
  const obs = io.readText(extDir + '/.obsolete');
  if (obs && obs.ok) {
    try { const o = JSON.parse(obs.text); Object.keys(o).forEach((k) => { if (o[k]) obsolete[k.toLowerCase()] = true; }); } catch (e) { /* битый .obsolete — считаем пустым */ }
  }
  const live = (folder) => !!folder && rx.test(folder) && !obsolete[folder.toLowerCase()] && io.exists(extDir + '/' + folder + '/package.json');
  const man = io.readText(extDir + '/extensions.json');
  if (man && man.ok) {
    let list = null;
    try { list = JSON.parse(man.text); } catch (e) { list = null; }
    if (Array.isArray(list)) {
      return list.some((e) => {
        if (!e || !e.identifier || String(e.identifier.id).toLowerCase() !== 'ms-ceintl.vscode-language-pack-ru') return false;
        let folder = e.relativeLocation ? String(e.relativeLocation) : '';
        if (!folder && e.location && e.location.path) folder = String(e.location.path).split('/').pop();
        return live(folder);
      });
    }
  }
  return io.list(extDir).some(live);
}

// ---------------------------------------------------------------------------
// Ввод-вывод osascript (ObjC). В Node не исполняется — кроме теста, который подставляет вместо ObjC/$ заглушки
// (test/run-tests.js, «vscode-settings.js (macOS): чтение и проверка ссылок …»).
// ---------------------------------------------------------------------------
function macIo() {
  ObjC.import('Foundation');
  const fm = $.NSFileManager.defaultManager;
  return {
    exists: (p) => !!fm.fileExistsAtPath(p),
    isSymlink: (p) => {
      const attrs = fm.attributesOfItemAtPathError(p, null);
      if (attrs && !attrs.isNil()) return symlinkVerdict(ObjC.unwrap(attrs.objectForKey($.NSFileType)), true);
      // Атрибуты не прочитались: пути нет вовсе или он есть, но недоступен. Различаем по списку родителя.
      const cut = p.lastIndexOf('/');
      const parent = cut > 0 ? p.slice(0, cut) : '/';
      const listing = fm.contentsOfDirectoryAtPathError(parent, null);
      const names = (!listing || listing.isNil()) ? [] : ObjC.deepUnwrap(listing);
      return symlinkVerdict(null, names.indexOf(p.slice(cut + 1)) !== -1);
    },
    readText: (p) => {
      if (!fm.fileExistsAtPath(p)) return null;
      // Тип и размер — ДО чтения: канал/устройство не читаем вовсе, гигабайтный файл не грузим в память.
      const attrs = fm.attributesOfItemAtPathError(p, null);
      const verdict = readVerdict((!attrs || attrs.isNil()) ? null : {
        type: ObjC.unwrap(attrs.objectForKey($.NSFileType)),
        size: ObjC.unwrap(attrs.objectForKey($.NSFileSize)),
      });
      if (!verdict.ok) return verdict;
      const data = $.NSData.dataWithContentsOfFile(p);
      if (!data || data.isNil()) return { ok: false, error: 'файл не читается' };
      const s = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
      if (!s || s.isNil()) return { ok: false, error: 'файл не в кодировке UTF-8' };
      let text = s.js;
      const bom = text.charCodeAt(0) === 0xFEFF || ObjC.unwrap(data.base64EncodedStringWithOptions(0)).indexOf('77u/') === 0;
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      return { ok: true, text, bom };
    },
    // writeToFile:atomically: пишет во временный файл и переименовывает — файл не бывает полузаписанным.
    writeText: (p, text) => !!$(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null),
    copy: (a, b) => !!fm.copyItemAtPathToPathError(a, b, null),
    mkdirp: (d) => !!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(d, true, $(), null),
    list: (d) => {
      const a = fm.contentsOfDirectoryAtPathError(d, null);
      return (!a || a.isNil()) ? [] : ObjC.deepUnwrap(a);
    },
  };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// Одна правка файла целиком: план -> копия -> атомарная запись. log — функция строки журнала.
function applyFile(io, log, path, wanted, marker, what, anchor, includeAnchor) {
  const name = path.split('/').pop();
  const dir = path.slice(0, path.lastIndexOf('/'));
  const none = { added: [], kept: 0, touched: [], skipped: false, reason: '', restored: false };
  const skip = (reason, keep) => Object.assign({}, none, { skipped: true, reason, kept: keep || 0 });
  // Ссылку (часто — на репозиторий dotfiles) не превращаем молча в обычный файл.
  const hit = linkOnPath(io, path, anchor, includeAnchor);
  if (hit) {
    log('  ' + name + ': путь ведёт по символической ссылке (например, на репозиторий настроек: ' + hit + ') — оставляю как есть.');
    return skip('путь ведёт по ссылке');
  }
  const plan = planFile(name, io.readText(path), wanted, marker, what, '\n');
  plan.lines.forEach(log);
  if (plan.skipped) return skip(plan.reason, plan.kept);
  if (!plan.write) return { added: [], kept: plan.kept, touched: plan.touched, skipped: false, reason: '', restored: false };
  if (!io.exists(dir) && !io.mkdirp(dir)) {
    log('  ' + name + ': папку ' + dir + ' создать не вышло — пропускаю.');
    return skip('папку ' + dir + ' создать не вышло', plan.kept);
  }
  let bak = '';
  if (io.exists(path)) {
    bak = path + '.hm-bak-' + stamp();
    if (!io.copy(path, bak)) {
      log('  ' + name + ': копию прежнего файла сделать не вышло — ничего не записываю.');
      return skip('копию прежнего файла сделать не вышло', plan.kept);
    }
  }
  // Перепроверка сразу перед записью: между разбором и ней прошло время.
  const again = linkOnPath(io, path, anchor, includeAnchor);
  if (again) {
    log('  ' + name + ': путь стал ссылкой (' + again + ') — ничего не записываю.');
    return skip('путь стал ссылкой', plan.kept);
  }
  if (!io.writeText(path, (plan.bom ? '\uFEFF' : '') + plan.newText)) {
    log('  ' + name + ': записать не вышло — файл остался прежним.');
    return skip('записать не вышло', plan.kept);
  }
  if (bak) log('  Копия прежнего ' + name + ': ' + bak);
  return { added: plan.added, kept: plan.kept, touched: plan.touched, skipped: false, reason: '', restored: plan.restored };
}

// Весь ход. mode: '' (подробный) | 'dry' | 'touchup'. io — ввод-вывод (в Node тесты подают свой).
// Возвращает массив строк для вывода.
function hmMain(argv, io) {
  const out = [];
  const mode = argv[1] === 'dry' || argv[1] === 'touchup' ? argv[1] : '';
  const quiet = mode === 'touchup';
  const log = (l) => { if (!quiet) out.push(l); };
  const home = argv[0];
  const userDir = home + '/Library/Application Support/Code/User';
  const dotVsCode = home + '/.vscode';
  if (mode === 'dry') {
    out.push('  [dry-run] WOULD: дописать недостающие ключи в ' + userDir + '/settings.json (' + HM_SETTINGS.map((e) => e[0]).join(', ') + '), заданные человеком не трогать, копия перед записью');
    out.push('  [dry-run] WOULD: locale=ru в ' + dotVsCode + '/argv.json — только если русский языковой пакет уже стоит');
    return out;
  }
  log('Настройки VS Code для новичка: прячу встроенный чат Copilot и правую панель с чатами, выключаю Restricted Mode и всплывающие советы.');
  const libAnchor = home + '/Library/Application Support';
  const markerPath = userDir + '/.hamidun-applied.json';
  const marker = new Set();
  const m = io.readText(markerPath);
  if (m && m.ok) {
    try {
      const o = JSON.parse(m.text);
      (o.settings || []).forEach((k) => marker.add('settings:' + k));
      (o.argv || []).forEach((k) => marker.add('argv:' + k));
    } catch (e) { /* битая отметка — как будто её нет */ }
  }
  const before = marker.size;
  const problems = []; const parts = [];
  let added = 0; let kept = 0; let changed = false;
  const s = applyFile(io, log, userDir + '/settings.json', HM_SETTINGS, marker, 'settings', libAnchor, true);
  s.touched.forEach((k) => marker.add('settings:' + k));
  added += s.added.length; kept += s.kept;
  if (s.skipped) problems.push('settings.json — ' + s.reason);
  if (s.added.length) { changed = true; parts.push('настройки VS Code (+' + s.added.length + ')' + (s.restored ? ', возвращены после отката файла' : '')); }
  if (ruPackInstalled(io, dotVsCode + '/extensions')) {
    const a = applyFile(io, log, dotVsCode + '/argv.json', [['locale', 'ru']], marker, 'argv', home, false);
    a.touched.forEach((k) => marker.add('argv:' + k));
    added += a.added.length; kept += a.kept;
    if (a.skipped) problems.push('argv.json — ' + a.reason);
    if (a.added.length) { changed = true; parts.push('русский интерфейс VS Code'); }
  } else {
    log('  Русского языкового пакета VS Code на диске нет — язык интерфейса не трогаю.');
  }
  if (marker.size !== before) {
    const pick = (pre) => [...marker].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)).sort();
    const body = JSON.stringify({
      note: 'Hamidun Setup: ключи и ярлыки, которые установщик уже добавлял в настройки VS Code. Удалённое человеком из этого списка установщик не возвращает.',
      settings: pick('settings:'), argv: pick('argv:'), shortcuts: pick('shortcut:'),
    }, null, 2) + '\n';
    if (linkOnPath(io, markerPath, libAnchor, true) || !io.writeText(markerPath, body)) {
      log('  Отметку о записанном сохранить не вышло — при повторной проверке убранное тобой может вернуться.');
    }
  }
  if (quiet) {
    if (changed) return [('ОБНОВЛЕНО: ' + parts.join(', ')) + (problems.length ? '; пропущено: ' + problems.join('; ') : '')];
    if (problems.length) return ['[touchup-vscode] пропущено: ' + problems.join('; ')];
    return [];
  }
  if (problems.length) {
    out.push('Настройки VS Code для новичка: применены не полностью — ' + problems.join('; ') + '. Редактор работает; то, что не применилось, останется как было (причины выше). Пришли этот журнал в поддержку.');
  } else if (added === 0 && kept === 0) {
    out.push('Настройки VS Code для новичка: всё уже на месте, файлы настроек не менял.');
  } else {
    out.push('Настройки VS Code для новичка: добавлено ' + added + ', оставлено как было ' + kept + '.');
  }
  return out;
}

// Точка входа osascript: вывод — возвращаемой строкой (osascript печатает её в stdout).
function run(argv) {
  argv = argv || [];
  const touchup = argv[1] === 'touchup';
  try {
    const a = argv.slice();
    const io = macIo();
    if (!a[0]) a[0] = ObjC.unwrap($.NSHomeDirectory());
    return hmMain(a, io).join('\n');
  } catch (e) {
    const kind = String((e && e.name) || 'Error').replace(/Error$/, '') || 'сбой';
    if (touchup) return '[touchup-vscode] пропущено: внутренний сбой: ' + kind;
    return 'Настройки VS Code для новичка: шаг остановлен (непредвиденная ситуация: ' + kind + ') — редактор работает и без них.';
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HM_SETTINGS, HM_MAX_CHARS, HM_MAX_BYTES, jsoncShape, addKeys, keyCovered, decodeKey, jsonLiteral, jsonString, planFile, ruPackInstalled, linkOnPath, applyFile, hmMain, run, readVerdict, symlinkVerdict, macIo };
}
