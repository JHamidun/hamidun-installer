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
 */
const http = require('http');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '8090', 10);
const TOKENS_FILE = process.env.TOKENS_FILE || '/var/lib/hamidun-bridge/tokens.json';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const PAC_DOMAINS = (process.env.PAC_DOMAINS ||
  'claude.ai,anthropic.com,openai.com,chatgpt.com,oaistatic.com,higgsfield.ai').split(',').map(s => s.trim()).filter(Boolean);
const MAX_DEVICES_DEFAULT = Math.max(1, parseInt(process.env.MAX_DEVICES_DEFAULT || '5', 10) || 5);

// --- Определение клиентского IP за reverse-proxy ---
// Сервис слушает ТОЛЬКО 127.0.0.1 и наружу выставляется через nginx/caddy.
// Поэтому запрос с X-Forwarded-For мог прийти только через наш локальный прокси —
// заголовку ДОВЕРЯЕМ и берём ПЕРВЫЙ IP из списка (реальный клиент; прокси дописывают
// свои IP в конец). Без этого rl-ключом был бы IP самого nginx (127.0.0.1) и
// один глобальный лимит делился бы на всех юзеров сразу.
// ВНИМАНИЕ: если когда-нибудь сервис будет слушать 0.0.0.0 напрямую (без прокси) —
// доверие к XFF убрать: клиент сможет подделывать заголовок и обходить rate-limit.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

// In-memory rate-limit (10 запросов/мин на клиентский IP).
// Для прод — вынести в БД/Redis (несколько инстансов, рестарты).
const rl = new Map(); // ip -> {count, resetAt}
function limited(ip) {
  const now = Date.now(), e = rl.get(ip);
  if (!e || now >= e.resetAt) { rl.set(ip, { count: 1, resetAt: now + 60000 }); return false; }
  return (++e.count) > 10;
}
function loadTokens() { try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return {}; } }
function saveTokens(t) { fs.mkdirSync(require('path').dirname(TOKENS_FILE), { recursive: true }); fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)); }
function readBody(req, cb) { let b = ''; req.on('data', c => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => cb(b)); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const ip = clientIp(req);
  if (limited(ip)) return json(res, 429, { error: 'too many requests' });

  // Бот регистрирует выданный токен -> к какому VPS он привязан.
  if (req.url.startsWith('/admin/token')) {
    if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) return json(res, 403, { error: 'forbidden' });
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

  // Приложение получает SSH-доступ по токену.
  return readBody(req, body => {
    let d; try { d = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
    const tok = (d.bridgeToken || '').trim();
    const tokens = loadTokens();
    const t = tokens[tok];
    if (!tok || !t) return json(res, 403, { error: 'bad or unknown bridgeToken' });

    // Срок жизни токена (если задан ботом при регистрации).
    if (t.expiresAt && Date.now() > new Date(t.expiresAt).getTime()) {
      return json(res, 403, { error: 'bridgeToken expired — renew the subscription in the bot (@HamidunAcademyBot)' });
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

    let sshKey = '';
    if (t.sshKeyPath) { try { sshKey = fs.readFileSync(t.sshKeyPath, 'utf8'); } catch {} }
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
