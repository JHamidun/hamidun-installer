'use strict';
/**
 * support-report.js — текст «отчёта для поддержки», который человек вставляет боту.
 *
 * ЗАЧЕМ. Когда установка спотыкается, помощь начинается с вопроса «какой шаг, что
 * написано, какая система?» — и человек отвечает скриншотами, по которым половину не
 * видно. Журнал на диске есть, но найти его и отправить файл новичок не умеет, а
 * фото в бот доходят не всегда. Кнопка «Скопировать отчёт для поддержки» кладёт в
 * буфер обмена ОДИН кусок текста: шаг, строку ошибки, хвост журнала, ОС, издание,
 * версию и uid — всё, с чего поддержка начинает разбор.
 *
 * ГРАНИЦА ДОВЕРИЯ. Текст уходит наружу (в чат), поэтому:
 *   1. каждая строка проходит scrubText (src/uid-telemetry.js) — та же чистка, что у
 *      телеметрии: пути профиля, имя пользователя, e-mail, IP, SID, имя машины;
 *   2. поверх неё — вырезание СЕКРЕТОВ (ключи API, токены, пароли в виде key=value):
 *      в журнале их быть не должно, но журнал пишут два десятка скриптов и чужие
 *      инструменты (pip, npm, winget), и гарантировать это за них нельзя;
 *   3. строки чистятся ПО ОДНОЙ: scrubText схлопывает пробелы и переводы строк, и
 *      пропущенный через неё журнал целиком превратился бы в одну нечитаемую строку.
 *
 * Поля от renderer (шаг, ошибка) — недоверенные: режутся по длине и чистятся так же.
 */
const fs = require('fs');

const LOG_TAIL_LINES = 60;
const LOG_TAIL_BYTES = 256 * 1024;
// Отчёт человек вставляет в чат с ботом ОДНИМ сообщением, а в Telegram оно не длиннее 4096
// знаков: длинное делится или режется, и теряется как раз хвост — строки с провалом. Держим
// отчёт в ~3500 знаках: шапка и упавшие шаги остаются целиком, из журнала берутся ПОСЛЕДНИЕ
// строки, что поместились.
const REPORT_MAX_CHARS = 3500;

// Явные форматы ключей. Префиксы — публичные соглашения провайдеров.
const SECRET_TOKEN_RES = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,                     // Anthropic
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,      // OpenAI
  /\bnmd_[A-Za-z0-9_-]{8,}/g,                         // ключ кабинета Nomad
  /\bAIza[0-9A-Za-z_-]{30,}/g,                        // Google
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,                    // GitHub
  /\bnpm_[A-Za-z0-9]{20,}/g,                          // токен npm (в т.ч. `:_authToken npm_…` через пробел)
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                  // Slack
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];
// «KEY=значение» / «token: значение» / JSON «"api_key": "значение"» (закрывающая кавычка
// имени перед разделителем допустима), где имя говорит, что это секрет. «auth» — только
// целыми формами (authorization, auth_token, auth-key): голое «auth» внутри слова
// зацепило бы безобидное «author: …».
const SECRET_KV_RE = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|passw(?:or)?d|authorization|auth[_-]?(?:token|key))[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// URL с логином и паролем: https://user:pass@host → https://<redacted>@host
const URL_CRED_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

function redactSecrets(line) {
  let t = String(line == null ? '' : line);
  for (const re of SECRET_TOKEN_RES) t = t.replace(re, '<secret>');
  t = t.replace(BEARER_RE, '$1 <secret>');
  t = t.replace(URL_CRED_RE, '$1<secret>@');
  t = t.replace(SECRET_KV_RE, (whole, k, sep, v) => (v === '<secret>' ? whole : k + sep + '<secret>'));
  return t;
}

/**
 * Последние N строк журнала. Читаем ХВОСТ файла, а не весь: журнал pip/npm/uv
 * легко вырастает до десятков мегабайт, а нужны последние 60 строк.
 * @returns {{ok: boolean, lines: string[], error?: string}}
 */
function readLogTail(file, n, maxBytes) {
  const want = Math.max(1, Number(n) || LOG_TAIL_LINES);
  const cap = Math.max(1024, Number(maxBytes) || LOG_TAIL_BYTES);
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - cap);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const r = fs.readSync(fd, buf, got, len - got, start + got);
      if (r <= 0) break;
      got += r;
    }
    let text = buf.slice(0, got).toString('utf8');
    // Начали с середины файла — первая строка обрезана, она не нужна.
    if (start > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    return { ok: true, lines: lines.slice(-want) };
  } catch (e) {
    return { ok: false, lines: [], error: (e && e.code) || String(e) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
}

const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, n);

/**
 * Собрать текст отчёта.
 * @param {object} o
 * @param {object}   o.meta     {version, edition, platform, osRelease, arch, uid, outcome, running}
 * @param {object[]} o.steps    [{id, name, stage, error}] — что не встало (от renderer)
 * @param {string[]} o.logTail  последние строки журнала
 * @param {string}   o.net      строка о связи с Anthropic (если проверялась)
 * @param {function} o.scrub    чистка ПД (uidTelemetry.scrubText)
 * @param {number}   o.maxChars потолок длины текста (по умолчанию REPORT_MAX_CHARS)
 */
function buildSupportReport(o) {
  const opts = o || {};
  const scrub = typeof opts.scrub === 'function' ? opts.scrub : (s) => String(s);
  // Сначала секреты, потом ПД: чистка ПД режет e-mail-образные куски, и пароль из
  // «https://логин:пароль@хост» иначе пропадал бы вместе с хостом, а логин оставался.
  const clean = (s) => scrub(redactSecrets(String(s == null ? '' : s)));
  const m = opts.meta || {};
  const maxChars = Math.max(1200, Number(opts.maxChars) || REPORT_MAX_CHARS);
  const os = m.platform === 'win32' ? 'Windows' : (m.platform === 'darwin' ? 'macOS' : String(m.platform || '?'));
  const stepsAll = (Array.isArray(opts.steps) ? opts.steps : []).slice(0, 10);

  // Шапка + упавшие шаги — главное, их из журнала не вытесняет ничто. Но если одни они
  // съедают почти весь бюджет (десять шагов по 400 знаков), описания ужимаются.
  const buildHead = (errClip, maxSteps) => {
    const out = [];
    out.push('Отчёт Hamidun Setup для поддержки');
    out.push('Установщик: ' + clip(m.version || '?', 40) + ' · издание: ' + (m.edition === 'lite' ? 'лёгкое (lite)' : 'офлайн'));
    out.push('Система: ' + os + ' ' + clip(m.osRelease || '', 40) + (m.arch ? ' (' + clip(m.arch, 16) + ')' : ''));
    out.push('uid: ' + (m.uid ? clip(m.uid, 32) : 'нет (установщик скачан без персональной ссылки)'));
    if (m.outcome) out.push('Итог: ' + clip(m.outcome, 120));
    const steps = stepsAll.slice(0, maxSteps);
    if (steps.length) {
      out.push('');
      out.push('Что не встало:');
      steps.forEach((s) => {
        const id = clip(s && s.id, 64).replace(/[^A-Za-z0-9_-]/g, '-');
        const name = clip(s && s.name, 80);
        const stage = clip(s && s.stage, 24).replace(/[^a-z-]/g, '');
        const err = clip(s && s.error, errClip);
        out.push('- шаг «' + clean(name || id) + '» (' + id + (stage ? ', ' + stage : '') + ')' +
          (err ? ': ' + clean(err) : ''));
      });
      if (stepsAll.length > steps.length) out.push('- … и ещё ' + (stepsAll.length - steps.length) + ' (подробности в логе)');
    } else if (m.running) {
      // Отчёт можно снять и посреди установки: «все выбранные установлены» там было бы неправдой.
      out.push('Что не встало: пока ничего — установка ещё идёт.');
    } else {
      out.push('Что не встало: ничего — все выбранные компоненты установлены.');
    }
    if (opts.net) out.push('Связь с Anthropic из консоли: ' + clean(clip(opts.net, 200)));
    return out;
  };
  const headBudget = maxChars - 900;      // не меньше ~900 знаков оставляем под хвост журнала
  let head = buildHead(400, 10);
  if (head.join('\n').length > headBudget) head = buildHead(160, 10);
  if (head.join('\n').length > headBudget) head = buildHead(100, 5);

  // Хвост журнала: с КОНЦА, пока помещается. 120 знаков — заголовок хвоста, подвал и переводы
  // строк. Строка длиннее остатка — берётся её КОНЕЦ (код ошибки обычно в конце).
  const room = maxChars - head.join('\n').length - 120;
  const all = Array.isArray(opts.logTail) ? opts.logTail.slice(-LOG_TAIL_LINES) : [];
  const picked = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const line = clean(clip(all[i], 600));
    if (used + line.length + 1 > room) {
      if (!picked.length && room > 80) picked.unshift(line.slice(-(room - 1)));
      break;
    }
    picked.unshift(line);
    used += line.length + 1;
  }
  const out = head.slice();
  out.push('');
  out.push('--- последние ' + picked.length + ' строк журнала установки' +
    (picked.length < all.length ? ' (из ' + all.length + ': старые не поместились в одно сообщение)' : '') + ' ---');
  picked.forEach((l) => out.push(l));
  out.push('--- конец ---');
  return out.join('\n');
}

module.exports = { LOG_TAIL_LINES, REPORT_MAX_CHARS, redactSecrets, readLogTail, buildSupportReport };
