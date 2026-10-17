'use strict';

// Охрана окна установщика: куда оно может уходить и что может открывать.
//
// ЗАЧЕМ. Окно — это Chromium со страницей из src/renderer/ и preload.js, который отдаёт странице весь
// IPC-интерфейс установщика (запуск компонентов, запись ключей, прокси, открытие терминала…). Процесс
// установщика работает с токеном АДМИНИСТРАТОРА, и main исполняет всё, о чём попросит страница. Если окно
// когда-нибудь окажется на чужом документе (XSS в разметке, которую собирает app.js, или уход по ссылке),
// этот документ получит тот же интерфейс. Сегодня конкретного пути нет — CSP `default-src 'self'`, все
// динамические данные идут через escapeHtml, ссылки памятки гасятся в app.js и открываются через main-IPC
// с разрешённым списком схем, — поэтому это защита в глубину: окно остаётся ТОЛЬКО на собственной странице.
//
// ЧТО ДЕЛАЕМ.
//   • will-navigate / will-redirect / will-frame-navigate: переход разрешён, только если адрес — наша же
//     index.html (file:// без хоста, тот же файл; якорь и запрос не в счёт). Всё остальное — preventDefault.
//     Перезагрузка окна (Ctrl+R, webContents.reload) и loadFile из main этих событий не вызывают.
//   • setWindowOpenHandler → deny: ни window.open, ни <a target=_blank> новых окон не создают. Внешние
//     ссылки открываются так же, как раньше, — кнопками через IPC open-external (разрешённые схемы
//     http/https/mailto/tg проверяет main, src/main.js), а не самим окном.
// Каждый отказ уходит в onBlock — main пишет одну строку в install.log (сбой виден, а не молчаливый).

const path = require('path');
const { fileURLToPath } = require('url');

const caseFold = (platform) => platform === 'win32' || platform === 'darwin';

/** Адрес указывает на нашу страницу indexFile? file: без хоста (UNC file://сервер/… — нет), тот же путь. */
function isOwnIndexUrl(url, indexFile, platform) {
  const plat = platform || process.platform;
  const win = plat === 'win32';
  let u;
  try { u = new URL(String(url)); } catch (e) { return false; }
  if (u.protocol !== 'file:') return false;
  if (u.hostname) return false;
  let p;
  // Разбор адреса и пути — по аргументу platform, а не по системе, где идёт проверка: «Windows-ветку» нельзя проверить на Mac, пока
  // fileURLToPath и path.resolve читают C:\... как POSIX-путь. На настоящей платформе поведение прежнее.
  try { p = fileURLToPath(u, { windows: win }); } catch (e) { return false; }
  const pth = win ? path.win32 : path;
  const norm = (x) => { const n = pth.resolve(x); return caseFold(plat) ? n.toLowerCase() : n; };
  return norm(p) === norm(indexFile);
}

// Electron 25+: адрес лежит в event.url; прежняя форма (url вторым аргументом) на случай старого рантайма.
function urlOf(event, legacyUrl) {
  if (event && typeof event.url === 'string') return event.url;
  return typeof legacyUrl === 'string' ? legacyUrl : '';
}

/**
 * Повесить охрану на webContents окна.
 * @param {Electron.WebContents} webContents
 * @param {{indexFile: string, onBlock?: (kind: string, url: string) => void, platform?: string}} opts
 */
function install(webContents, opts) {
  const o = opts || {};
  if (!o.indexFile) throw new Error('window-guards: нужен indexFile');
  const block = (kind) => (event, legacyUrl) => {
    const url = urlOf(event, legacyUrl);
    if (isOwnIndexUrl(url, o.indexFile, o.platform)) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof o.onBlock === 'function') { try { o.onBlock(kind, url); } catch (e) { /* журнал не роняет окно */ } }
  };
  webContents.on('will-navigate', block('will-navigate'));
  webContents.on('will-redirect', block('will-redirect'));
  webContents.on('will-frame-navigate', block('will-frame-navigate'));
  webContents.setWindowOpenHandler((details) => {
    if (typeof o.onBlock === 'function') { try { o.onBlock('window-open', String((details && details.url) || '')); } catch (e) { /* ignore */ } }
    return { action: 'deny' };
  });
}

module.exports = { install, isOwnIndexUrl };
