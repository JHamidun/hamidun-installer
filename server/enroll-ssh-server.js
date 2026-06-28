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
 *   TOKENS_FILE=/var/lib/hamidun-bridge/tokens.json   // { "<token>": {plan,vpsId,sshHost,sshPort,sshUser,sshKeyPath} }
 *   ADMIN_SECRET=...   // для POST /admin/token (бот регистрирует выданные токены)
 */
const http = require('http');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '8090', 10);
const TOKENS_FILE = process.env.TOKENS_FILE || '/var/lib/hamidun-bridge/tokens.json';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const PAC_DOMAINS = (process.env.PAC_DOMAINS ||
  'claude.ai,anthropic.com,openai.com,chatgpt.com,oaistatic.com,higgsfield.ai').split(',').map(s => s.trim()).filter(Boolean);

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
  const ip = req.socket.remoteAddress || 'unknown';
  if (limited(ip)) return json(res, 429, { error: 'too many requests' });

  // Бот регистрирует выданный токен -> к какому VPS он привязан.
  if (req.url.startsWith('/admin/token')) {
    if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) return json(res, 403, { error: 'forbidden' });
    return readBody(req, body => {
      let d; try { d = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!d.token || !d.sshHost) return json(res, 400, { error: 'token & sshHost required' });
      const t = loadTokens();
      t[d.token] = { plan: d.plan || 'lite', vpsId: d.vpsId || '', sshHost: d.sshHost,
        sshPort: d.sshPort || 22, sshUser: d.sshUser || 'rele', sshKeyPath: d.sshKeyPath || '' };
      saveTokens(t);
      return json(res, 200, { ok: true });
    });
  }

  // Приложение получает SSH-доступ по токену.
  return readBody(req, body => {
    let d; try { d = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
    const tok = (d.bridgeToken || '').trim();
    const t = loadTokens()[tok];
    if (!tok || !t) return json(res, 403, { error: 'bad or unknown bridgeToken' });
    let sshKey = '';
    if (t.sshKeyPath) { try { sshKey = fs.readFileSync(t.sshKeyPath, 'utf8'); } catch {} }
    // TODO: тут провизионить выделенный VPS под юзера (Standard) через API провайдера,
    //       либо вернуть из пула (Lite). Сейчас — из tokens.json.
    return json(res, 200, {
      sshHost: t.sshHost, sshPort: t.sshPort, sshUser: t.sshUser, sshKey,
      pacDomains: PAC_DOMAINS
    });
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`bridge enroll-ssh on 127.0.0.1:${PORT}`));
