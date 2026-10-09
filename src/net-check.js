'use strict';
/**
 * net-check.js — «дойдёт ли Claude Code до Anthropic из консоли» и подстановка прокси.
 *
 * ЗАЧЕМ. Самая частая беда после установки — не сбой, а среда: VPN-клиент включён в
 * режиме «системный прокси», браузер через него ходит, а Claude Code — отдельная
 * консольная программа, системный прокси Windows она не читает и идёт напрямую. Итог:
 * claude.ai в браузере открывается, а в Claude Code — «403 Request not allowed»,
 * «Unable to connect to Anthropic services», ERR_BAD_REQUEST. Человек не понимает,
 * что «VPN включён» и «VPN включён для Claude Code» — разные вещи.
 *
 * ЧТО ДЕЛАЕМ.
 *   1. Запрос к api.anthropic.com ИЗ ГЛАВНОГО ПРОЦЕССА Node — тем же сетевым путём,
 *      каким пойдёт сам Claude Code (без системного прокси, без браузерного стека).
 *      Любой HTTP-ответ, кроме 403/451, — «сервер доступен». 403/451 — Anthropic
 *      отказывает по адресу (страна/сеть). Ошибка TLS — соединение перехватывают или
 *      режут на этапе шифрования. Таймаут, сброс, DNS — не достучаться вовсе.
 *   2. Не дошли — читаем системный прокси Windows (HKCU\…\Internet Settings:
 *      ProxyEnable/ProxyServer). Это ровно тот адрес, через который ходит браузер.
 *      Если там ЛОКАЛЬНЫЙ http-прокси (127.0.0.1:порт — так выглядит VPN-клиент в
 *      режиме «системный прокси»), проверяем тем же запросом, работает ли через него.
 *   3. Работает — предлагаем (кнопкой, с согласием) прописать HTTPS_PROXY/HTTP_PROXY/
 *      NO_PROXY в блок "env" файла ~/.claude/settings.json. Claude Code эти переменные
 *      понимает. Иначе — подсказка «включи в VPN-клиенте режим TUN».
 *
 * ЧЕГО НЕ ДЕЛАЕМ. Не блокируем установку ничем отсюда; не трогаем системный прокси и
 * сам VPN; не пишем адрес, присланный renderer'ом (renderer недоверенный — подставил бы
 * чужой прокси для всего трафика Claude Code): main сам перечитывает реестр и сам
 * проверяет прокси перед записью.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const tls = require('tls');
const http = require('http');
const crypto = require('crypto');

const ANTHROPIC_HOST = 'api.anthropic.com';
const PROBE_TIMEOUT_MS = 10000;
// Свои адреса через прокси не гоняем: локальные MCP-серверы и хуки на 127.0.0.1
// (например, скрепка слушает 127.0.0.1:45832) пошли бы в VPN-клиент и сломались.
const NO_PROXY_DEFAULT = ['localhost', '127.0.0.1', '::1'];
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

/**
 * Итог пробы → вид ответа. Чистая функция — её проверяет тест на всех ветках.
 * @param {{status?: number, code?: string, message?: string, timedOut?: boolean}} r
 * @returns {'reachable'|'geo'|'tls'|'timeout'|'dns'|'reset'|'offline'|'proxy-down'|'proxy-refused'|'unknown'}
 */
function classifyProbe(r) {
  const o = r || {};
  if (typeof o.status === 'number' && o.status > 0) {
    // 403 — ответ Anthropic из закрытой страны («Request not allowed»); 451 — то же
    // по закону. Любой другой код (404 на корень, 401 без ключа, 429, 5xx) значит, что
    // до сервера МЫ ДОШЛИ — этого и достаточно: дальше Claude Code войдёт сам.
    if (o.status === 403 || o.status === 451) return 'geo';
    return 'reachable';
  }
  const code = String(o.code || '').toUpperCase();
  const msg = String(o.message || '');
  if (o.proxyDown) return 'proxy-down';
  if (o.proxyRefused) return 'proxy-refused';
  if (o.timedOut || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (/^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_CERT)/.test(code) ||
      code === 'EPROTO' || /certificate|self.signed|ssl3?_|tls/i.test(msg)) return 'tls';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') return 'dns';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'ECONNABORTED') return 'reset';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'ENETDOWN' || code === 'EHOSTDOWN') return 'offline';
  return 'unknown';
}

/** Человеческое объяснение вида ответа — одна фраза для экрана и отчёта. */
function describeKind(kind) {
  switch (kind) {
    case 'reachable': return 'связь есть — Claude Code сможет подключиться';
    case 'geo': return 'Anthropic отказал по адресу (ответ 403): из твоей сети или страны без VPN не пускает';
    case 'tls': return 'соединение перехватывают или режут на этапе шифрования (антивирус, VPN или провайдер)';
    case 'timeout': return 'сервер не ответил за 10 секунд — соединение, похоже, блокируется';
    case 'dns': return 'адрес api.anthropic.com не находится (DNS)';
    case 'reset': return 'соединение сбрасывается — похоже на блокировку провайдером';
    case 'offline': return 'нет выхода в интернет';
    case 'proxy-down': return 'прокси VPN-клиента не отвечает (клиент выключен?)';
    case 'proxy-refused': return 'прокси VPN-клиента отказался соединять с Anthropic';
    default: return 'не удалось проверить';
  }
}

// «HTTP/1.1 404 Not Found» → 404. null, пока первая строка не пришла целиком.
function parseStatusLine(buf) {
  const s = String(buf || '');
  const m = /^HTTP\/\d(?:\.\d)? (\d{3})\b/.exec(s);
  if (m) return Number(m[1]);
  return s.indexOf('\n') !== -1 || s.length > 4096 ? NaN : null;
}

// GET / по TLS и код ответа. tlsOpts: {host, port} для прямого соединения или
// {socket} — поверх туннеля CONNECT через прокси. Сертификат проверяется (по
// умолчанию rejectUnauthorized), SNI — api.anthropic.com.
function httpStatusOverTls(tlsOpts, timeoutMs, connect) {
  const doConnect = connect || tls.connect;
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    let sock = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (sock) sock.destroy(); } catch (e) { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ timedOut: true, code: 'ETIMEDOUT' }), Math.max(500, timeoutMs || PROBE_TIMEOUT_MS));
    try {
      sock = doConnect(Object.assign({ servername: ANTHROPIC_HOST, ALPNProtocols: ['http/1.1'] }, tlsOpts));
    } catch (e) { finish({ code: (e && e.code) || 'ERROR', message: String((e && e.message) || e) }); return; }
    if (sock.setEncoding) sock.setEncoding('latin1');
    sock.on('secureConnect', () => {
      try {
        sock.write('GET / HTTP/1.1\r\nHost: ' + ANTHROPIC_HOST + '\r\nUser-Agent: hamidun-setup-netcheck\r\n' +
          'Accept: */*\r\nConnection: close\r\n\r\n');
      } catch (e) { finish({ code: (e && e.code) || 'ERROR', message: String((e && e.message) || e) }); }
    });
    sock.on('data', (d) => {
      buf += String(d);
      const st = parseStatusLine(buf);
      if (st === null) return;
      if (Number.isNaN(st)) finish({ code: 'EBADRESPONSE', message: 'не HTTP-ответ: ' + buf.slice(0, 60) });
      else finish({ status: st });
    });
    sock.on('error', (e) => finish({ code: (e && e.code) || 'ERROR', message: String((e && e.message) || e) }));
    sock.on('end', () => finish({ code: 'ECONNRESET', message: 'соединение закрыто без ответа' }));
    sock.on('close', () => finish({ code: 'ECONNRESET', message: 'соединение закрыто без ответа' }));
  });
}

/** Прямая проба — так пойдёт сам Claude Code без прокси. */
function probeDirect(opts) {
  const o = opts || {};
  return httpStatusOverTls({ host: ANTHROPIC_HOST, port: 443 }, o.timeoutMs || PROBE_TIMEOUT_MS, o.tlsConnect);
}

/**
 * Проба ЧЕРЕЗ http-прокси: CONNECT api.anthropic.com:443, затем TLS поверх туннеля —
 * ровно так Claude Code пойдёт с HTTPS_PROXY. Прокси не ответил — proxyDown; ответил
 * не 200 — proxyRefused.
 */
function probeViaProxy(proxy, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || PROBE_TIMEOUT_MS;
  const request = o.httpRequest || http.request;
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } finish({ timedOut: true, code: 'ETIMEDOUT' }); }, timeoutMs);
    let req;
    try {
      req = request({
        host: proxy.host, port: proxy.port, method: 'CONNECT',
        path: ANTHROPIC_HOST + ':443', headers: { Host: ANTHROPIC_HOST + ':443' },
      });
    } catch (e) { finish({ proxyDown: true, code: (e && e.code) || 'ERROR', message: String((e && e.message) || e) }); return; }
    req.on('connect', (res, socket) => {
      if (!res || res.statusCode !== 200) {
        try { socket.destroy(); } catch (e) { /* ignore */ }
        finish({ proxyRefused: true, code: 'EPROXY', message: 'прокси ответил ' + (res && res.statusCode) });
        return;
      }
      const left = Math.max(500, timeoutMs - (Date.now() - t0));
      httpStatusOverTls({ socket }, left, o.tlsConnect).then(finish);
    });
    req.on('error', (e) => finish({ proxyDown: true, code: (e && e.code) || 'ERROR', message: String((e && e.message) || e) }));
    req.end();
  });
}

const LOOPBACK_RE = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|\[::1\])$/i;

/**
 * Разбор системного прокси Windows (значения ProxyEnable / ProxyServer из
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings).
 *   «127.0.0.1:10809»                                  — один прокси на всё;
 *   «http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808» — по протоколам;
 *   «socks=127.0.0.1:10808»                            — только SOCKS: Claude Code его
 *                                                        через HTTPS_PROXY не возьмёт.
 * @returns {{enabled: boolean, host?: string, port?: number, local?: boolean,
 *            url?: string, socksOnly?: boolean, reason?: string}}
 */
function parseWinProxy(enableRaw, serverRaw) {
  const en = String(enableRaw == null ? '' : enableRaw).trim();
  const enabled = en === '1' || /^0x0*1$/i.test(en);
  if (!enabled) return { enabled: false, reason: 'disabled' };
  const s = String(serverRaw == null ? '' : serverRaw).trim();
  if (!s) return { enabled: true, reason: 'empty' };
  let hostport = '';
  if (s.indexOf('=') !== -1) {
    const map = {};
    s.split(';').forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) map[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    });
    hostport = map.https || map.http || '';
    if (!hostport) return { enabled: true, socksOnly: !!map.socks, reason: map.socks ? 'socks' : 'empty' };
  } else {
    hostport = s.split(';')[0].trim();
  }
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\[[0-9a-f:]+\]|[A-Za-z0-9.-]+):(\d{1,5})\/?$/i.exec(hostport);
  if (!m) return { enabled: true, reason: 'unparsed' };
  const scheme = (m[1] || 'http').toLowerCase();
  if (/^socks/.test(scheme)) return { enabled: true, socksOnly: true, reason: 'socks' };
  if (scheme !== 'http' && scheme !== 'https') return { enabled: true, reason: 'unparsed' };
  const port = Number(m[3]);
  if (!(port > 0 && port < 65536)) return { enabled: true, reason: 'unparsed' };
  const host = m[2];
  const local = LOOPBACK_RE.test(host);
  return { enabled: true, host: host.replace(/^\[|\]$/g, ''), port, local, url: 'http://' + host + ':' + port };
}

/**
 * Прокси, УЖЕ прописанный в настройках Claude Code, — как мы его поняли.
 *   present    — в настройках есть HTTPS_PROXY (любой);
 *   unreadable — он есть, но разобрать его нельзя (логин:пароль@хост, socks://…, мусор);
 *   parsed     — разобранный {host, port, …} или null.
 * Зачем отдельно. Нечитаемый прокси раньше считался «не прописан», и предложение записать
 * системный прокси VPN-клиента молча заменяло его (чаще всего это прокси на работе). Теперь
 * при unreadable предложения записи нет вовсе, а само значение на экран не уходит: в нём может
 * быть пароль.
 */
function classifyConfiguredProxy(configured) {
  const c = String(configured == null ? '' : configured).trim();
  if (!c) return { present: false, unreadable: false, parsed: null };
  const p = parseWinProxy('1', c);
  if (p.host && p.port) return { present: true, unreadable: false, parsed: p };
  return { present: true, unreadable: true, parsed: null };
}

function mergeNoProxy(existing) {
  const items = String(existing == null ? '' : existing).split(',').map((x) => x.trim()).filter(Boolean);
  NO_PROXY_DEFAULT.forEach((d) => { if (!items.some((x) => x.toLowerCase() === d)) items.push(d); });
  return items.join(',');
}

/**
 * Слить прокси в объект настроек Claude Code. Всё остальное — как было: другие ключи
 * верхнего уровня, другие переменные в env, их порядок. Чужой NO_PROXY дополняется,
 * а не затирается.
 * @returns {{ok: true, settings: object} | {ok: false, reason: string}}
 */
function mergeProxyEnv(settings, proxyUrl) {
  // Только http://хост:порт — без логина и пароля (`user:pw@`): такой адрес легко записал бы чужой
  // секрет в настройки открытым текстом. Единственный вызывающий строит адрес из parseWinProxy,
  // но этой функцией пользуются и тесты, и она не должна полагаться на вежливость вызывающего.
  if (!/^http:\/\/(?:\[[0-9a-f:]+\]|[A-Za-z0-9.-]+):\d{1,5}$/i.test(String(proxyUrl || ''))) return { ok: false, reason: 'bad-url' };
  if (settings !== undefined && settings !== null &&
      (typeof settings !== 'object' || Array.isArray(settings))) return { ok: false, reason: 'not-object' };
  const out = settings ? JSON.parse(JSON.stringify(settings)) : {};
  if (out.env !== undefined && (out.env === null || typeof out.env !== 'object' || Array.isArray(out.env))) {
    return { ok: false, reason: 'env-not-object' };
  }
  const env = out.env || {};
  env.HTTPS_PROXY = proxyUrl;
  env.HTTP_PROXY = proxyUrl;
  env.NO_PROXY = mergeNoProxy(env.NO_PROXY);
  out.env = env;
  return { ok: true, settings: out };
}

function settingsPath(home) { return path.join(home || os.homedir(), '.claude', 'settings.json'); }

/** Что сейчас прописано в env настроек (для экрана: «уже стоит такой-то прокси»). */
function readProxyEnv(home) {
  try {
    const raw = fs.readFileSync(settingsPath(home), 'utf8').replace(/^﻿/, '');
    const j = JSON.parse(raw);
    const env = (j && j.env && typeof j.env === 'object') ? j.env : {};
    return { ok: true, httpsProxy: String(env.HTTPS_PROXY || env.https_proxy || '') };
  } catch (e) {
    return { ok: false, httpsProxy: '', error: (e && e.code) || 'parse' };
  }
}

/**
 * Записать прокси в ~/.claude/settings.json. Инварианты те же, что у
 * credentials-merge.js: не прочитали — не пишем (кроме «файла нет»), невалидный JSON
 * не трогаем (иначе затёрли бы все настройки человека), перед записью — копия рядом,
 * сама запись атомарная через случайный временный файл в режиме 'wx'.
 * @returns {{ok: true, path: string, backup: string} | {ok: false, reason: string, error?: string}}
 */
function writeProxyEnv(proxyUrl, opts) {
  const o = opts || {};
  const file = o.file || settingsPath(o.home);
  let raw = null;
  try {
    const st = fs.lstatSync(file);
    // Ссылку не трогаем: rename поверх неё молча оторвал бы человеку его схему с
    // общими настройками, а писать СКВОЗЬ неё из процесса с правами администратора —
    // значит писать туда, куда указал не мы.
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: 'not-regular-file' };
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) {
      return { ok: false, reason: 'read-failed', error: (e && e.code) || String(e) };
    }
    raw = null;
  }
  let current = null;
  if (raw !== null) {
    try { current = JSON.parse(raw.replace(/^﻿/, '')); }
    catch (e) { return { ok: false, reason: 'invalid-json' }; }
  }
  const merged = mergeProxyEnv(current, proxyUrl);
  if (!merged.ok) return merged;
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let backup = '';
    if (raw !== null) {
      // Имя с секундами и случайным хвостом: два нажатия подряд не должны упасть на
      // EEXIST, а 'wx' не даёт записать копию по заранее подложенной ссылке.
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
      backup = file + '.hamidun-bak-' + stamp + '-' + crypto.randomBytes(3).toString('hex');
      fs.writeFileSync(backup, raw, { encoding: 'utf8', flag: 'wx' });
    }
    let tmp = '';
    let fd = null;
    for (let i = 0; i < 3 && fd === null; i++) {
      const cand = path.join(dir, path.basename(file) + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
      try { fd = fs.openSync(cand, 'wx', 0o600); tmp = cand; }
      catch (e) { if (e && e.code === 'EEXIST') continue; throw e; }
    }
    if (fd === null) return { ok: false, reason: 'tmp-exists' };
    try {
      fs.writeFileSync(fd, JSON.stringify(merged.settings, null, 2) + '\n', 'utf8');
      try { fs.fsyncSync(fd); } catch (e) { /* fsync не везде обязателен */ }
    } finally {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
    try { fs.renameSync(tmp, file); }
    catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ } throw e; }
    return { ok: true, path: file, backup };
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: (e && e.code) || String(e) };
  }
}

module.exports = {
  ANTHROPIC_HOST, PROBE_TIMEOUT_MS, NO_PROXY_DEFAULT, PROXY_ENV_KEYS,
  classifyProbe, describeKind, parseStatusLine, httpStatusOverTls, probeDirect, probeViaProxy,
  parseWinProxy, classifyConfiguredProxy, mergeNoProxy, mergeProxyEnv, settingsPath, readProxyEnv, writeProxyEnv,
};
