'use strict';

// macOS: самолечение карантина и транслокации (кнопка «Исправить автоматически») —
// ЧИСТАЯ часть, без electron: тесты гоняют её напрямую, а все обращения к системе
// (hdiutil, codesign, ФС) приходят снаружи функциями-зависимостями.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Раньше всё решалось ИМЕНЕМ ФАЙЛА: первый образ из `hdiutil info`
// или самый свежий «Hamidun-Setup-Mac*.dmg» в Загрузках/Столе/Документах получал
// `xattr -dr com.apple.quarantine`; отцеплённый помощник насильно отцеплял ВСЕ тома
// /Volumes/Hamidun* (в том числе посторонние с таким началом имени) и запускал приложение
// из образа после единственной проверки «каталог существует». Файл с нашим именем, пришедший
// из сети (или подложенный тем же пользователем), получал и снятый карантин — Gatekeeper его
// уже не оценит, — и запуск. Теперь:
//   1. Имя только НОМИНИРУЕТ кандидата. Берётся первый образ, приложение внутри которого
//      проходит `codesign --verify --deep --strict -R <требование>`, где требование строится
//      из подписи ЗАПУЩЕННОГО установщика: тот же Team ID и тот же идентификатор бандла
//      (у ad-hoc тестовой сборки Team ID нет — тогда тот же идентификатор бандла + проходящая
//      проверка подписи). Требование проверяет сам codesign по подписи, а не разбор текста.
//   2. Карантин снимается только с файла, который это прошёл (main.js).
//   3. Помощник отцепляет только точки монтирования ЭТОГО образа — их отдаёт
//      `hdiutil info -plist`, а не маска /Volumes/Hamidun*.
//   4. После монтирования помощник проверяет приложение ЕЩЁ РАЗ (файл могли подменить,
//      пока установщик закрывался) и только потом делает `open`; не прошло — том отцеплен,
//      в крошку пишется verify-failed, приложение не запускается (fail-closed).

const path = require('path');

const APP_NAME = 'Hamidun Setup.app';                                 // внутри образа (productName)
const DMG_NAME_RE = /^Hamidun-Setup-Mac[A-Za-z0-9._ ()-]*\.dmg$/i;   // единый шаблон имени нашего образа
const MAX_CANDIDATES = 4;     // сколько образов-кандидатов проверяем (каждая проверка — монтирование и codesign)
const MAX_DETACH = 8;         // потолок точек монтирования, которые отдаём помощнику
const CTRL_RE = /[\x00-\x1f\x7f]/;

// ---------------------------------------------------------------------------
// XML-plist (вывод `hdiutil info -plist`). Минимальный разбор без зависимостей: только то, что
// выдаёт CoreFoundation (dict/array/key/string/integer/real/true/false/date/data).
// Вход ограничен по размеру и глубине; любое отклонение — исключение (вызывающий действует
// как будто образов нет, то есть отцепляет МЕНЬШЕ, а не больше).
// ---------------------------------------------------------------------------
function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return '\'';
      default: {
        const cp = e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return (cp > 0 && cp <= 0x10FFFF) ? String.fromCodePoint(cp) : '';
      }
    }
  });
}

function tokenizePlist(src) {
  const text = String(src == null ? '' : src);
  if (text.length > 4 * 1024 * 1024) throw new Error('plist слишком велик');
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) { toks.push({ t: 'text', v: text.slice(i) }); break; }
    if (lt > i) toks.push({ t: 'text', v: text.slice(i, lt) });
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      if (e === -1) throw new Error('plist: не закрыта инструкция <? ?>');
      i = e + 2; continue;
    }
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e === -1) throw new Error('plist: не закрыт комментарий');
      i = e + 3; continue;
    }
    if (/^<!DOCTYPE/i.test(text.slice(lt, lt + 9))) {
      const e = text.indexOf('>', lt);
      if (e === -1) throw new Error('plist: не закрыт DOCTYPE');
      i = e + 1; continue;
    }
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) throw new Error('plist: не закрыт тег');
    const m = /^(\/)?([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/)?$/.exec(text.slice(lt + 1, gt));
    if (!m || (m[1] && m[4])) throw new Error('plist: непонятный тег');
    toks.push(m[1] ? { t: 'close', name: m[2] } : { t: 'open', name: m[2], self: !!m[4] });
    i = gt + 1;
  }
  return toks;
}

function parsePlistXml(src) {
  const toks = tokenizePlist(src);
  let p = 0;
  const skipWs = () => { while (p < toks.length && toks[p].t === 'text' && !toks[p].v.trim()) p++; };
  const peek = () => { skipWs(); return toks[p]; };
  const next = () => { skipWs(); return toks[p++]; };
  const leaf = (open) => {               // текст до парного закрывающего тега
    if (open.self) return '';
    let s = '';
    while (p < toks.length && toks[p].t === 'text') s += toks[p++].v;
    const c = toks[p++];
    if (!c || c.t !== 'close' || c.name !== open.name) throw new Error('plist: ожидался </' + open.name + '>');
    return decodeXml(s);
  };
  const value = (depth) => {
    if (depth > 64) throw new Error('plist: слишком глубокая вложенность');
    const o = next();
    if (!o || o.t !== 'open') throw new Error('plist: ожидалось значение');
    switch (o.name) {
      case 'dict': {
        const obj = Object.create(null);     // без прототипа: ключ «__proto__» — обычный ключ
        if (o.self) return obj;
        for (;;) {
          const k = next();
          if (!k) throw new Error('plist: dict не закрыт');
          if (k.t === 'close' && k.name === 'dict') return obj;
          if (k.t !== 'open' || k.name !== 'key') throw new Error('plist: в dict ожидался <key>');
          const key = leaf(k);
          obj[key] = value(depth + 1);
        }
      }
      case 'array': {
        const arr = [];
        if (o.self) return arr;
        for (;;) {
          const q = peek();
          if (!q) throw new Error('plist: array не закрыт');
          if (q.t === 'close' && q.name === 'array') { next(); return arr; }
          arr.push(value(depth + 1));
        }
      }
      case 'string': case 'date': case 'data': return leaf(o);
      case 'integer': {
        const v = leaf(o).trim();
        if (!/^-?\d+$/.test(v)) throw new Error('plist: неверный integer');
        return Number(v);
      }
      case 'real': {
        const v = Number(leaf(o).trim());
        if (!Number.isFinite(v)) throw new Error('plist: неверный real');
        return v;
      }
      case 'true': if (!o.self) leaf(o); return true;
      case 'false': if (!o.self) leaf(o); return false;
      default: throw new Error('plist: неизвестный элемент <' + o.name + '>');
    }
  };
  const root = next();
  if (!root || root.t !== 'open' || root.name !== 'plist') throw new Error('plist: нет корня <plist>');
  const v = value(0);
  const end = next();
  if (!end || end.t !== 'close' || end.name !== 'plist') throw new Error('plist: нет </plist>');
  return v;
}

// Образы, которые сейчас подключены: [{ imagePath, imageAlias, mountPoints[], devEntries[] }].
function parseHdiutilInfoPlist(xml) {
  const root = parsePlistXml(xml);
  const imgs = root && Array.isArray(root.images) ? root.images : [];
  const out = [];
  for (const im of imgs) {
    if (!im || typeof im !== 'object') continue;
    const imageAlias = typeof im['image-alias'] === 'string' ? im['image-alias'] : '';
    const imagePath = typeof im['image-path'] === 'string' && im['image-path'] ? im['image-path'] : imageAlias;
    if (!imagePath) continue;
    const mountPoints = []; const devEntries = [];
    for (const e of (Array.isArray(im['system-entities']) ? im['system-entities'] : [])) {
      if (!e || typeof e !== 'object') continue;
      if (typeof e['mount-point'] === 'string' && e['mount-point']) mountPoints.push(e['mount-point']);
      if (typeof e['dev-entry'] === 'string' && e['dev-entry']) devEntries.push(e['dev-entry']);
    }
    out.push({ imagePath, imageAlias, mountPoints, devEntries });
  }
  return out;
}

function samePath(a, b) {
  return !!a && !!b && path.posix.normalize(String(a)) === path.posix.normalize(String(b));
}

// Точки монтирования, которые принадлежат ИМЕННО этому файлу образа (все подключения одного и того же
// файла: «Hamidun Setup» и «Hamidun Setup 1»). Совпадение пути точное; посторонние тома с похожим
// именем сюда не попадают — в этом и отличие от маски /Volumes/Hamidun*.
function mountPointsOfImage(images, dmg) {
  const out = [];
  for (const im of images || []) {
    if (!samePath(im.imagePath, dmg) && !samePath(im.imageAlias, dmg)) continue;
    for (const m of im.mountPoints || []) if (!out.includes(m)) out.push(m);
  }
  return out;
}

// То, что отдаём помощнику для `hdiutil detach -force`: только абсолютные нормализованные пути без
// управляющих символов (не «/», не «-флаг», не «..»), не больше MAX_DETACH.
function safeMountPoints(list) {
  const out = [];
  for (const m of list || []) {
    if (typeof m !== 'string' || m.length > 1024 || CTRL_RE.test(m)) continue;
    if (!path.posix.isAbsolute(m) || m === '/' || m.endsWith('/') || path.posix.normalize(m) !== m) continue;
    if (!out.includes(m)) out.push(m);
    if (out.length >= MAX_DETACH) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Подпись запущенного установщика → требование для codesign
// ---------------------------------------------------------------------------
const isValidTeamId = (s) => typeof s === 'string' && /^[A-Z0-9]{10}$/.test(s);
const isValidBundleId = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(s);

// Разбор вывода `codesign -dv --verbose=4 <app>` (он идёт в stderr). Строки читаются построчно с
// якорями; Team ID и идентификатор принимаются только в строгой форме. Сам вывод здесь НЕ источник
// доверия к проверяемому образу — тот проверяет codesign по требованию; разбор нужен лишь затем,
// чтобы узнать, чьё приложение РАБОТАЕТ СЕЙЧАС.
function parseCodesignIdentity(text) {
  const t = String(text == null ? '' : text);
  const id = /^Identifier=(.+?)\s*$/m.exec(t);
  const team = /^TeamIdentifier=(.+?)\s*$/m.exec(t);
  const identifier = id && isValidBundleId(id[1]) ? id[1] : '';
  const teamRaw = team ? team[1] : '';
  const teamId = isValidTeamId(teamRaw) ? teamRaw : '';
  const adhoc = !teamId && (/^Signature=adhoc\s*$/m.test(t) || /flags=0x[0-9a-f]+\([^)]*adhoc/i.test(t));
  return { identifier, teamId, adhoc };
}

// Требование на языке codesign (подставляется как `-R "=<требование>"`). Developer ID: цепочка до Apple +
// тот же идентификатор + тот же Team ID — как у пина Claude Desktop в claude-desktop.sh. Ad-hoc тестовая
// сборка: только идентификатор (Team ID у неё нет), но проверка подписи обязательна всё равно.
// Пустая строка = личность не установлена → самолечение отказывает (fail-closed). Тихо ослаблять требование
// до одного идентификатора нельзя: это допустимо только для подписи, ЯВНО помеченной ad-hoc.
function buildRequirement(identity) {
  const id = identity && identity.identifier;
  if (!isValidBundleId(id)) return '';
  if (identity.teamId) {
    if (!isValidTeamId(identity.teamId)) return '';
    return 'anchor apple generic and identifier "' + id + '" and certificate leaf[subject.OU] = "' + identity.teamId + '"';
  }
  if (identity.adhoc === true) return 'identifier "' + id + '"';
  return '';
}

// Путь к .app запущенного процесса: /…/Hamidun Setup.app/Contents/MacOS/Hamidun Setup → /…/Hamidun Setup.app.
function bundlePathFromExecPath(execPath) {
  const m = /^(\/.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''));
  return m ? m[1] : '';
}

const okDmgName = (p) => typeof p === 'string' && path.posix.isAbsolute(p) && !CTRL_RE.test(p)
  && DMG_NAME_RE.test(path.posix.basename(p));

// ---------------------------------------------------------------------------
// Проверка до любых изменений
// ---------------------------------------------------------------------------
// d: {
//   exec(file, args, timeoutMs) -> Promise<{code, stdout, stderr}>  (code 0 = успех; не бросает),
//   runningBundle: путь к .app запущенного установщика ('' — неизвестен),
//   fileCandidates() -> string[]   образы на диске, от свежего к старому (имена уже проверены),
//   isFile(p), isDir(p) -> bool,
//   mkPrivateDir() -> string, rmPrivateDir(dir),   служебная точка монтирования (владелец — пользователь)
//   log(line)
// }
// Возврат:
//   { ok: true, dmg, mountPoints[], requirement, via: 'mounted'|'private-mount' }
//   { ok: false, error: 'identity-unknown' | 'dmg-not-found' | 'verify-failed', dmg? }
// Ничего не меняет в системе, кроме служебного монтирования только для чтения, которое сразу снимает.
// Главный процесс никогда не отцепляет уже существующие тома: под `detach` попадает только служебная
// точка, созданная здесь же.
async function preflight(d) {
  const log = typeof d.log === 'function' ? d.log : () => {};
  const bundle = String(d.runningBundle || '');
  if (!bundle || CTRL_RE.test(bundle)) {
    log('Самолечение: не нашёл .app запущенного установщика — подпись не с чем сверять, ничего не меняю.');
    return { ok: false, error: 'identity-unknown' };
  }
  const idr = await d.exec('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], 30000);
  const identity = parseCodesignIdentity(String(idr.stdout || '') + '\n' + String(idr.stderr || ''));
  const requirement = idr.code === 0 ? buildRequirement(identity) : '';
  if (!requirement) {
    log('Самолечение: не смог прочитать подпись запущенного установщика (codesign -dv) — подпись не с чем сверять, ничего не меняю.');
    return { ok: false, error: 'identity-unknown' };
  }
  log('Самолечение: подпись запущенного установщика — ' +
    (identity.teamId ? 'Developer ID, команда ' + identity.teamId : 'ad-hoc (тестовая сборка)') + ', бандл ' + identity.identifier + '.');

  // Подключённые сейчас образы (для точек монтирования) — из plist, а не из текстового вывода.
  let images = [];
  const inf = await d.exec('/usr/bin/hdiutil', ['info', '-plist'], 20000);
  if (inf.code === 0) {
    try { images = parseHdiutilInfoPlist(inf.stdout); }
    catch (e) { log('Самолечение: не разобрал вывод hdiutil info -plist (' + String(e && e.message || e) + ') — тома не отцепляю.'); }
  } else {
    log('Самолечение: hdiutil info -plist не ответил — тома не отцепляю.');
  }

  // Кандидаты: сначала подключённые образы с нашим именем, затем файлы на диске (свежие раньше).
  const cands = [];
  const add = (p) => { if (okDmgName(p) && d.isFile(p) && !cands.includes(p)) cands.push(p); };
  images.forEach((im) => add(im.imagePath));
  let files = [];
  try { files = d.fileCandidates() || []; } catch (e) { files = []; }
  files.forEach(add);
  if (!cands.length) {
    log('Самолечение: файл образа Hamidun-Setup-Mac*.dmg не найден.');
    return { ok: false, error: 'dmg-not-found' };
  }

  const verify = async (appDir) => {
    const r = await d.exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=' + requirement, appDir], 180000);
    return r.code === 0;
  };

  for (const dmg of cands.slice(0, MAX_CANDIDATES)) {
    const base = path.posix.basename(dmg);
    const mounts = safeMountPoints(mountPointsOfImage(images, dmg));
    let ok = false; let via = ''; let why = '';
    const mountedApp = mounts.map((m) => path.posix.join(m, APP_NAME)).find((a) => d.isDir(a));
    if (mountedApp) {
      via = 'mounted';
      log('Самолечение: образ «' + base + '» уже подключён — проверяю приложение на его томе.');
      ok = await verify(mountedApp);
      if (!ok) why = 'подпись приложения на подключённом томе не совпала с подписью установщика';
    } else {
      via = 'private-mount';
      log('Самолечение: образ «' + base + '» не подключён — монтирую только для чтения в служебную папку, проверю и отцеплю.');
      const dir = d.mkPrivateDir();
      let attached = false;
      try {
        const at = await d.exec('/usr/bin/hdiutil',
          ['attach', '-nobrowse', '-readonly', '-noautoopen', '-noverify', '-mountpoint', dir, dmg], 120000);
        if (at.code !== 0) {
          why = 'образ не удалось смонтировать для проверки';
        } else {
          attached = true;
          const appDir = path.posix.join(dir, APP_NAME);
          if (!d.isDir(appDir)) why = 'в образе нет ' + APP_NAME;
          else {
            ok = await verify(appDir);
            if (!ok) why = 'подпись приложения в образе не совпала с подписью установщика';
          }
        }
      } finally {
        if (attached) {
          let dt = await d.exec('/usr/bin/hdiutil', ['detach', dir], 60000);
          if (dt.code !== 0) dt = await d.exec('/usr/bin/hdiutil', ['detach', dir, '-force'], 60000);
          if (dt.code !== 0) log('Самолечение: служебный том не отцепился сам — оставляю как есть (он только для чтения).');
        }
        try { d.rmPrivateDir(dir); } catch (e) { /* каталог мог остаться занятым */ }
      }
    }
    if (ok) {
      log('Самолечение: образ «' + base + '» прошёл проверку подписи. Карантин снимаю только с него.');
      return { ok: true, dmg, mountPoints: mounts, requirement, via };
    }
    log('Самолечение: образ «' + base + '» НЕ прошёл проверку — ' + why + '. Карантин с него не снимаю, приложение из него не запускаю.');
  }
  log('Самолечение остановлено: ни один найденный образ не подтверждён подписью установщика (fail-closed).');
  return { ok: false, error: 'verify-failed', dmg: cands[0] };
}

// ---------------------------------------------------------------------------
// Отцеплённый помощник (sh), который работает ПОСЛЕ выхода установщика
// ---------------------------------------------------------------------------
// Позиционные параметры: $1 — файл образа, $2 — pid установщика, $3 — файл-крошка,
// $4 — требование codesign, $5… — точки монтирования ЭТОГО образа (из `hdiutil info -plist`).
// Всё, что приходит снаружи, едет аргументами, а не подстановкой в текст.
//
// Порядок (проверяется тестами): ждём выхода → отцепляем только переданные тома → монтируем сами и
// берём точку монтирования из вывода → ПРОВЕРЯЕМ приложение (подпись + издатель) → open -n → ждём процесс.
//   • Ждать выхода обязательно: пока мы живы, наш замок единственного экземпляра не отпущен, и
//     запущенный помощником свежий установщик закроется сам. Потолок щедрый — 120 с.
//   • Свой mount-point берём из вывода attach: том может держать Finder, detach тогда не проходит,
//     macOS монтирует «Hamidun Setup 1» рядом, а перебор /Volumes брал бы первый по алфавиту —
//     СТАРЫЙ, всё ещё карантинный том.
//   • `open` вернул 0 — это лишь «команда принята»: ждём, пока процесс РЕАЛЬНО появится.
function buildHelperScript() {
  const app = APP_NAME;
  return [
    'DMG="$1"; PID="$2"; ST="$3"; REQ="$4"; shift 4;',
    'i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 240 ]; do sleep 0.5; i=$((i+1)); done;',
    // Только тома ЭТОГО образа (аргументы $5…), не маска /Volumes/Hamidun*: посторонний том с похожим
    // именем остаётся на месте.
    'for v in "$@"; do [ -d "$v" ] && /usr/bin/hdiutil detach "$v" -force >/dev/null 2>&1; done;',
    'MP=$(/usr/bin/hdiutil attach -nobrowse "$DMG" 2>/dev/null | /usr/bin/sed -n "s|.*\\(/Volumes/.*\\)$|\\1|p" | /usr/bin/tail -1);',
    'if [ -z "$MP" ] || [ ! -d "$MP/' + app + '" ]; then printf mount-failed > "$ST"; exit 1; fi;',
    // Образ могли подменить, пока установщик закрывался: проверяем приложение на ТОЛЬКО ЧТО смонтированном
    // томе (подпись целиком + тот же издатель и бандл) и лишь затем запускаем. Не прошло — том отцепляем.
    'if ! /usr/bin/codesign --verify --deep --strict -R "=$REQ" "$MP/' + app + '" >/dev/null 2>&1; then',
    '  /usr/bin/hdiutil detach "$MP" -force >/dev/null 2>&1; printf verify-failed > "$ST"; exit 1;',
    'fi;',
    'if ! /usr/bin/open -n -a "$MP/' + app + '"; then printf relaunch-failed > "$ST"; exit 1; fi;',
    'i=0; while [ $i -lt 20 ]; do',
    '  if /usr/bin/pgrep -f "' + app + '/Contents/MacOS" >/dev/null 2>&1; then',
    '    printf ok > "$ST"; exit 0;',
    '  fi;',
    '  sleep 1; i=$((i+1));',
    'done;',
    'printf relaunch-not-seen > "$ST"; exit 1'
  ].join(' ');
}

// Строка для install.log по слову из крошки (помощник работает после выхода и сам в журнал не пишет).
function statusMessageRu(status) {
  switch (String(status || '')) {
    case 'mount-failed':
      return 'Самолечение (после выхода установщика): не удалось смонтировать образ — возможно, файл повреждён.';
    case 'verify-failed':
      return 'Самолечение (после выхода установщика): приложение в смонтированном образе не прошло проверку подписи и издателя — я его не запускал (fail-closed).';
    case 'relaunch-failed':
      return 'Самолечение (после выхода установщика): команда открытия приложения из образа завершилась ошибкой.';
    case 'relaunch-not-seen':
      return 'Самолечение (после выхода установщика): образ открыт, но процесс установщика из него не появился.';
    default:
      return '';
  }
}

module.exports = {
  APP_NAME, DMG_NAME_RE, MAX_CANDIDATES, MAX_DETACH,
  parsePlistXml, parseHdiutilInfoPlist, mountPointsOfImage, safeMountPoints,
  parseCodesignIdentity, buildRequirement, bundlePathFromExecPath, isValidTeamId, isValidBundleId,
  preflight, buildHelperScript, statusMessageRu
};
