'use strict';
/**
 * window-guards-probe.js — проверка охраны окна установщика под НАСТОЯЩИМ Electron.
 *
 * Запускается тестом из run-tests.js (раздел «u10a/D»), не руками:
 *   electron test/window-guards-probe.js          (параметры — в переменных HM_PROBE_*)
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОЦЕСС. Два вывода должны быть доказаны на живом рантайме, а не по тексту:
 *   1) `sandbox: true` совместим с настоящим preload.js: страница видит window.installer, а обмен с main
 *      (ipcRenderer.invoke) проходит. Без такого прогона включать песочницу рискованно: сломанный preload
 *      молча убил бы весь интерфейс установщика;
 *   2) will-navigate / setWindowOpenHandler реально останавливают уход окна на чужие адреса: локальный
 *      HTTP-сервер считает запросы, которые дошли.
 * Окно создаётся с теми же webPreferences, что и в main.js (литерал вырезается из настоящего main.js), и с
 * настоящим preload.js; страница — настоящая src/renderer/index.html. Каталог данных, профиль и TEMP — в scratch
 * (их подставляет тест); окно скрыто (show: false).
 *
 * Переменные:
 *   HM_PROBE_ROOT    корень репозитория (обязательна)
 *   HM_PROBE_OUT     файл для JSON-результата (обязательна)
 *   HM_PROBE_NO_GUARDS=1    не ставить охрану окна (контроль «до»: чужой адрес ДОХОДИТ)
 *   HM_PROBE_SANDBOX=0|1    принудительно задать sandbox (контроль): по умолчанию — как в main.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = process.env.HM_PROBE_ROOT;
const OUT = process.env.HM_PROBE_OUT;
if (!ROOT || !OUT) { console.error('HM_PROBE_ROOT и HM_PROBE_OUT обязательны'); process.exit(2); }
const result = { stage: 'start' };
const finish = (code) => {
  try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(code), 50);
};
const fail = (e) => { result.error = String((e && e.stack) || e); finish(1); };
process.on('uncaughtException', fail);
const watchdog = setTimeout(() => { result.error = 'таймаут пробы (90 с)'; finish(3); }, 90000);
if (watchdog.unref) watchdog.unref();

// Данные Chromium — рядом с результатом (scratch), а не в профиле человека.
app.setPath('userData', path.join(path.dirname(OUT), 'userData'));
app.disableHardwareAcceleration();

// Литерал webPreferences — из НАСТОЯЩЕГО main.js (единственный источник истины); __dirname = src/.
function realWebPreferences() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const i = src.indexOf('webPreferences: {');
  if (i < 0) throw new Error('в main.js нет webPreferences');
  let depth = 0; let end = -1;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) { end = k + 1; break; }
  }
  const lit = src.slice(i + 'webPreferences:'.length, end);
  return new Function('path', '__dirname', 'return (' + lit + ');')(path, path.join(ROOT, 'src'));
}

// Все каналы настоящего preload.js получают заглушку (страница при старте дёргает часть из них); канал пробы
// отвечает меткой — это «один безвредный обмен», который обязан пройти через песочницу.
function stubChannels() {
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const names = Array.from(new Set((pre.match(/invoke\('([a-z-]+)'/g) || []).map((s) => s.slice(8, -1))));
  names.forEach((ch) => {
    if (ch === 'detect-user-warning') ipcMain.handle(ch, () => ({ probe: 'pong' }));
    else ipcMain.handle(ch, () => null);
  });
  return names;
}

function startServer() {
  return new Promise((resolve) => {
    const hits = [];
    const srv = http.createServer((req, res) => { hits.push(req.url); res.end('<!doctype html><title>x</title>'); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, port: srv.address().port }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    result.stage = 'ready';
    const WG = require(path.join(ROOT, 'src', 'window-guards.js'));
    const wp = realWebPreferences();
    result.webPreferencesFromMain = JSON.parse(JSON.stringify(wp));
    if (process.env.HM_PROBE_SANDBOX === '0') wp.sandbox = false;
    if (process.env.HM_PROBE_SANDBOX === '1') wp.sandbox = true;
    const channels = stubChannels();
    result.channels = channels.length;
    const { srv, hits, port } = await startServer();
    const indexFile = path.join(ROOT, 'src', 'renderer', 'index.html');
    const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: wp });
    const wc = win.webContents;
    const blocked = [];
    // Какие события навигации реально приходят (слушатели ставятся ДО охраны и срабатывают независимо от preventDefault):
    // охрана вешается на все три, и этот список показывает, какие из них живы в этой версии Electron.
    const seen = [];
    ['will-navigate', 'will-frame-navigate', 'will-redirect'].forEach((ev) => wc.on(ev, (e) => seen.push(ev + ' ' + String((e && e.url) || ''))));
    if (process.env.HM_PROBE_NO_GUARDS !== '1') {
      WG.install(wc, { indexFile, onBlock: (kind, url) => blocked.push(kind + ' ' + url) });
    }
    const extraWindows = [];
    app.on('browser-window-created', (e, w) => { if (w !== win) extraWindows.push(w.id); });
    await win.loadFile(indexFile);
    result.stage = 'loaded';
    result.url = wc.getURL();
    const js = (code) => wc.executeJavaScript(code, true);

    // 1) настоящий preload под текущим sandbox: объект есть, обмен идёт, Node в странице нет
    result.page = await js(`(async () => {
      const r = {};
      r.hasInstaller = typeof window.installer === 'object' && window.installer !== null;
      r.keys = Object.keys(window.installer || {}).sort();
      r.noNode = typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined';
      try { r.pong = await window.installer.detectUserWarning(); } catch (e) { r.pongError = String(e && e.message || e); }
      return r;
    })()`);

    // песочница уровня ОС у процесса этой страницы (поле ProcessMetric.sandboxed, Windows/macOS)
    const pid = wc.getOSProcessId();
    const m = app.getAppMetrics().find((x) => x.pid === pid);
    result.rendererSandboxedByOS = m ? m.sandboxed : null;
    result.lastWebPreferencesSandbox = wc.getLastWebPreferences().sandbox;

    // 2) навигация и окна
    const startUrl = wc.getURL();
    const tmpPage = path.join(path.dirname(OUT), 'other.html');
    fs.writeFileSync(tmpPage, '<!doctype html><title>other</title><p>other</p>');
    const attempt = async (code) => { await js(code).catch(() => {}); await sleep(1500); };
    await attempt(`location.href = 'http://127.0.0.1:${port}/nav-http'`);
    result.afterHttpNav = { url: wc.getURL(), hits: hits.slice() };
    // Что получила бы страница, на которую окно ушло: тот же preload, то есть весь IPC установщика (суть находки F18).
    result.pageAfterHttpNav = await js(`typeof window.installer + '|' + location.protocol`).catch((e) => 'error: ' + e.message);
    await attempt(`location.href = ${JSON.stringify(require('url').pathToFileURL(tmpPage).href)}`);
    result.afterFileNav = { url: wc.getURL() };
    await attempt(`window.__w = window.open('http://127.0.0.1:${port}/open-http'); void 0`);
    result.openReturnedNull = await js('window.__w === null');
    await attempt(`(() => { const a = document.createElement('a'); a.href = 'http://127.0.0.1:${port}/link-blank'; a.target = '_blank'; document.body.appendChild(a); a.click(); })()`);
    await attempt(`(() => { const a = document.createElement('a'); a.href = 'http://127.0.0.1:${port}/link-self'; document.body.appendChild(a); a.click(); })()`);
    result.finalUrl = wc.getURL();
    result.sameDocument = wc.getURL().split('#')[0] === startUrl.split('#')[0];
    // собственный адрес с якорем — законен (внутристраничный переход)
    await attempt(`location.hash = '#probe-anchor'`);
    result.afterHash = wc.getURL();
    result.hits = hits.slice();
    result.extraWindows = extraWindows.length;
    result.allWindows = BrowserWindow.getAllWindows().length;
    result.blocked = blocked;
    result.navigationEvents = seen;
    result.stage = 'done';
    srv.close();
    clearTimeout(watchdog);
    finish(0);
  } catch (e) { fail(e); }
});
app.on('window-all-closed', () => { /* окно закрываем мы сами в finish() через exit */ });
