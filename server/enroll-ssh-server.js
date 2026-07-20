'use strict';
/*
 * Hamidun Bridge — SSH enrollment service (REFERENCE).
 *
 * Контракт (его ждёт agent/bridge_agent.py):
 *   POST {bridge enroll url}
 *   body: { "bridgeToken": "...", "client": "hostname" }
 *   200 -> {
 *     "sshHost": "1.2.3.4", "sshPort": 22, "sshUser": "rele",
 *     "sshKey": "<OpenSSH private key text>",
 *     "pacDomains": ["claude.ai","anthropic.com","openai.com","chatgpt.com"]
 *   }
 *
 * Юзер платит в боте → бот выдаёт bridgeToken и регистрирует его здесь (POST /admin/token)
 * → приложение дёргает /enroll с токеном и САМО получает SSH-доступ (юзер ничего не вводит).
 *
 * Это reference: реальная выдача «1 юзер = 1 выделенный VPS/IP» — через API провайдера
 * (Hetzner/Vultr/собственный пул). Здесь — статический/пуловый вариант + контракт.
 *
 * ENV:
 *   PORT=8090
 *   PAC_DOMAINS=claude.ai,anthropic.com,openai.com,chatgpt.com,oaistatic.com,higgsfield.ai
 *   TOKENS_FILE=/var/lib/hamidun-bridge/tokens.json
 *     // { "<token>": { plan, vpsId, sshHost, sshPort, sshUser, sshKeyPath,
 *     //                maxDevices, expiresAt, devicesUsed: { "<hostname>": firstEnrollTs } } }
 *   ADMIN_SECRET=...   // для POST /admin/token (бот регистрирует выданные токены)
 *   MAX_DEVICES_DEFAULT=5   // лимит устройств на токен (спека: до 5 устройств на ключ)
 *   TRUSTED_PROXY_COUNT=1   // сколько НАШИХ reverse-proxy дописывают X-Forwarded-For (см. clientIp)
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8090', 10);
const TOKENS_FILE = process.env.TOKENS_FILE || '/var/lib/hamidun-bridge/tokens.json';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const PAC_DOMAINS = (process.env.PAC_DOMAINS ||
  'claude.ai,anthropic.com,openai.com,chatgpt.com,oaistatic.com,higgsfield.ai').split(',').map(s => s.trim()).filter(Boolean);
const MAX_DEVICES_DEFAULT = Math.max(1, parseInt(process.env.MAX_DEVICES_DEFAULT || '5', 10) || 5);
// Сколько НАШИХ reverse-proxy стоит перед сервисом (каждый дописывает ровно одну
// запись в X-Forwarded-For). Default 1 = одиночный nginx/caddy на этой же машине.
const TRUSTED_PROXY_COUNT = Math.max(1, parseInt(process.env.TRUSTED_PROXY_COUNT || '1', 10) || 1);

// --- Определение клиентского IP за reverse-proxy ---
// Сервис слушает ТОЛЬКО 127.0.0.1 и наружу выставляется через nginx/caddy.
// Без XFF rl-ключом был бы IP самого nginx (127.0.0.1) и один глобальный лимит
// делился бы на всех юзеров сразу.
// МОДЕЛЬ ДОВЕРИЯ: клиент может прислать СВОЙ X-Forwarded-For — его значения
// окажутся В НАЧАЛЕ списка, а наши прокси дописывают реальные IP В КОНЕЦ.
// Поэтому первому элементу верить НЕЛЬЗЯ (атакующий подменяет его на каждый
// запрос и обходит rate-limit). Доверяем только последним TRUSTED_PROXY_COUNT
// записям, которые дописали НАШИ прокси: при N доверенных прокси реальный
// клиент — элемент с индексом (length - N), т.е. запись, добавленная первым
// (внешним) доверенным прокси. Если записей меньше N — клиент XFF не слал,
// весь список дописан нашими прокси, берём первый элемент.
// ВНИМАНИЕ: если когда-нибудь сервис будет слушать 0.0.0.0 напрямую (без прокси) —
// доверие к XFF убрать целиком: остаётся только socket.remoteAddress.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      const idx = parts.length - TRUSTED_PROXY_COUNT;
      return parts[idx >= 0 ? idx : 0];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

// In-memory rate-limit (per клиентский IP). Публичный /enroll и admin /admin/token —
// РАЗНЫЕ бакеты: флуд по публичному эндпоинту не должен душить регистрацию токенов
// ботом (и наоборот). Для прод — вынести в БД/Redis (несколько инстансов, рестарты).
const rl = new Map();       // ip -> {count, resetAt}  — публичный /enroll (10/мин)
const rlAdmin = new Map();  // ip -> {count, resetAt}  — /admin/token (30/мин)
function limitedIn(map, ip, max) {
  const now = Date.now(), e = map.get(ip);
  if (!e || now >= e.resetAt) { map.set(ip, { count: 1, resetAt: now + 60000 }); return false; }
  return (++e.count) > max;
}
function limited(ip) { return limitedIn(rl, ip, 10); }
function limitedAdmin(ip) { return limitedIn(rlAdmin, ip, 30); }
// Периодически чистим истёкшие окна в обеих картах — иначе на публичном pre-auth
// эндпоинте Map растёт неограниченно (каждый новый IP навсегда → OOM при флуде).
setInterval(() => {
  const now = Date.now();
  for (const map of [rl, rlAdmin]) { for (const [ip, e] of map) { if (now >= e.resetAt) map.delete(ip); } }
}, 5 * 60000).unref();

// Константное по времени сравнение секрета (защита от timing-атаки). timingSafeEqual
// требует буферы равной длины — предварительно сверяем длину (её утечка через ранний
// возврат некритична, важно скрыть посимвольное совпадение самого секрета).
function secretEqual(provided, expected) {
  const a = Buffer.from(String(provided == null ? '' : provided), 'utf8');
  const b = Buffer.from(String(expected == null ? '' : expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    // Битый файл != пустой: молчаливый сброс сделал бы ВСЕ bridgeToken невалидными
    // (403), пока бот не перерегистрирует их. Падаем громко, не сбрасываем учёт.
    throw Object.assign(new Error(`tokens.json повреждён (${e.message}) — почини/удали ${TOKENS_FILE}`), { statusCode: 500 });
  }
}
function saveTokens(t) {
  const path = require('path');
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
  // Атомарно (tmp + rename) — краш посреди записи не оставит полу-файла.
  const tmp = TOKENS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
  fs.renameSync(tmp, TOKENS_FILE);
}
function readBody(req, cb) { let b = ''; req.on('data', c => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => cb(b)); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const ip = clientIp(req);

  // Бот регистрирует выданный токен -> к какому VPS он привязан.
  if (req.url.startsWith('/admin/token')) {
    // Admin — ОТДЕЛЬНЫЙ бакет rate-limit: публичный флуд по /enroll не должен
    // блокировать регистрацию токенов ботом.
    if (limitedAdmin(ip)) return json(res, 429, { error: 'too many requests' });
    // Константное по времени сравнение секрета (не утекает через тайминг раннего
    // несовпадения). Пустой ADMIN_SECRET по-прежнему = 403 (сервис не настроен).
    if (!ADMIN_SECRET || !secretEqual(req.headers['x-admin-secret'], ADMIN_SECRET)) return json(res, 403, { error: 'forbidden' });
    return readBody(req, body => {
      let d; try { d = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!d.token || !d.sshHost) return json(res, 400, { error: 'token & sshHost required' });
      const t = loadTokens();
      const prev = t[d.token] || {};
      t[d.token] = {
        plan: d.plan || 'lite', vpsId: d.vpsId || '', sshHost: d.sshHost,
        sshPort: d.sshPort || 22, sshUser: d.sshUser || 'rele', sshKeyPath: d.sshKeyPath || '',
        // Привязка устройств: спека (docs/bridge-bot-spec.md) — до 5 устройств на ключ.
        maxDevices: (Number.isInteger(d.maxDevices) && d.maxDevices > 0) ? d.maxDevices : (prev.maxDevices || MAX_DEVICES_DEFAULT),
        // Срок жизни токена: ISO-строка или ms. null = токен живёт, пока бот его не удалит
        // (бот сам перерегистрирует/чистит токены при окончании подписки/trial).
        expiresAt: d.expiresAt || prev.expiresAt || null,
        // Учёт использованных устройств (hostname -> ts первого enroll).
        // При перерегистрации токена ботом (смена плана/VPS) счётчик СОХРАНЯЕМ.
        devicesUsed: prev.devicesUsed || {}
      };
      saveTokens(t);
      return json(res, 200, { ok: true });
    });
  }

  // Публичный /enroll — публичный per-IP лимит (отдельный от admin-бакета).
  if (limited(ip)) return json(res, 429, { error: 'too many requests' });

  // Приложение получает SSH-доступ по токену.
  return readBody(req, body => {
    let d; try { d = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
    const tok = (d.bridgeToken || '').trim();
    const tokens = loadTokens();
    const t = tokens[tok];
    if (!tok || !t) return json(res, 403, { error: 'bad or unknown bridgeToken' });

    // Срок жизни токена (если задан ботом при регистрации).
    if (t.expiresAt && Date.now() > new Date(t.expiresAt).getTime()) {
      return json(res, 403, { error: 'bridgeToken expired — renew the subscription in the bot (@vibecodeguidebot)' });
    }

    // Приватный ключ читаем ДО учёта устройства: серверная мисконфигурация
    // (sshKeyPath не задан / файл нечитаем) — это 500 с внятной ошибкой,
    // а НЕ 200 с пустым sshKey (клиент получил бы битую конфигурацию и
    // молча не смог бы подключиться). Слот девайса при этом не тратим.
    let sshKey = '';
    if (t.sshKeyPath) {
      try { sshKey = fs.readFileSync(t.sshKeyPath, 'utf8'); }
      catch (e) { console.error(`enroll: cannot read sshKeyPath "${t.sshKeyPath}": ${e.message}`); }
    } else {
      console.error('enroll: token has no sshKeyPath configured');
    }
    if (!sshKey.trim()) {
      return json(res, 500, { error: 'server misconfiguration: SSH key for this token is missing or unreadable — contact support (@vibecodeguidebot)' });
    }

    // Привязка устройств: до maxDevices (спека: 5) устройств на один токен.
    // Устройство идентифицируем по client (hostname из тела запроса) — повторный
    // enroll с того же hostname лимит НЕ тратит (переустановка/переподключение ок).
    // Учёт — в TOKENS_FILE (файловый json). Для прод — вынести в БД/Redis
    // (конкурентные записи, несколько инстансов).
    const client = String(d.client || '').trim().slice(0, 128) || 'unknown-device';
    if (!t.devicesUsed) t.devicesUsed = {};
    if (!t.devicesUsed[client]) {
      const max = (Number.isInteger(t.maxDevices) && t.maxDevices > 0) ? t.maxDevices : MAX_DEVICES_DEFAULT;
      if (Object.keys(t.devicesUsed).length >= max) {
        return json(res, 403, {
          error: `device limit reached: this bridgeToken is already used on ${max} device(s); ` +
                 'detach an old device via the bot (/status) or contact support'
        });
      }
      t.devicesUsed[client] = Date.now();
      saveTokens(tokens);
    }

    // TODO: тут провизионить выделенный VPS под юзера (Standard) через API провайдера,
    //       либо вернуть из пула (Lite). Сейчас — из tokens.json.
    //
    // БЕЗОПАСНОСТЬ ВЫДАВАЕМОГО SSH-ДОСТУПА (ОБЯЗАТЕЛЬНО ПРИ ПРОВИЖИНИНГЕ VPS):
    // этот сервис только ВОЗВРАЩАЕТ приватный ключ клиенту; authorized_keys на
    // bridge-VPS настраивается отдельно (вручную/скриптом провижининга). Ключ
    // НЕЛЬЗЯ прописывать «голым» — иначе юзер получает полный шелл и открытый
    // SOCKS куда угодно. В ~rele/.ssh/authorized_keys перед ключом впиши опции:
    //
    //   restrict,port-forwarding,permitopen="*:443",permitopen="*:80",command="/usr/sbin/nologin" ssh-ed25519 AAAA... hamidun-bridge
    //
    //   - restrict         = выключает ВСЁ (pty, X11, agent, user-rc, forwarding);
    //   - port-forwarding  = возвращает только TCP-forwarding (нужен для ssh -D);
    //   - permitopen       = direct-tcpip каналы (в т.ч. через SOCKS от -D) только
    //                        на порты 443/80 — «мост для AI-доменов», не open proxy;
    //   - command=...      = блокирует запуск команд/шелла (клиент ходит как ssh -N;
    //                        agent/bridge_agent.py шелл не запрашивает).
    // Плюс сам юзер rele — с shell=/usr/sbin/nologin. Подробно: server/README.md,
    // раздел «AI-мост (SSH): ограничение ключа на VPS».
    return json(res, 200, {
      sshHost: t.sshHost, sshPort: t.sshPort, sshUser: t.sshUser, sshKey,
      pacDomains: PAC_DOMAINS
    });
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`bridge enroll-ssh on 127.0.0.1:${PORT}`));
