'use strict';
/*
 * Hamidun VPN enrollment service — REFERENCE implementation.
 *
 * Contract expected by the installer scripts (scripts/{windows,macos}/vpn-*.{ps1,sh}):
 *
 *   POST {HM_VPN_ENROLL_URL}{HM_VPN_ENROLL_PATH}      (default path: /enroll)
 *   body: { "inviteCode": "...", "client": "hostname", "format": "amneziawg" | "amnezia" }
 *
 *   format=amneziawg  -> 200 { "config": "<text of a WireGuard/AmneziaWG .conf>", "name": "hamidun" }
 *   format=amnezia    -> 200 { "vpnCode": "vpn://..." }   (TODO: build Amnezia container)
 *
 * Deploy on the NEW server (root) behind HTTPS (nginx/caddy). Requires `wireguard-tools`.
 * Set INVITE_CODES, WG_* env vars. State (assigned IPs) persists to STATE_FILE.
 * MAX_PEERS_PER_INVITE (default 5) caps peers per invite code — a leaked code
 * can no longer fill the whole /24 and break enrollment for everyone.
 *
 * Alternative: run wg-easy (https://github.com/wg-easy/wg-easy) and make this a thin
 * auth proxy in front of its API instead of shelling to `wg` directly.
 */
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '8088', 10);
const INVITES = new Set((process.env.INVITE_CODES || '').split(',').map(s => s.trim()).filter(Boolean));
const STATE_FILE = process.env.STATE_FILE || '/var/lib/hamidun-vpn/state.json';
// Лимит пиров на один инвайт-код (утечка кода не должна забивать /24 и ломать
// enroll всем). Учёт — в STATE_FILE (state.invites). Для прод — вынести в БД/Redis.
const MAX_PEERS_PER_INVITE = Math.max(1, parseInt(process.env.MAX_PEERS_PER_INVITE || '5', 10) || 5);

// Validate WG_IFACE before any execSync usage.
const WG_IFACE_RAW = process.env.WG_IFACE || 'awg0';
if (!/^[a-zA-Z][a-zA-Z0-9_]{0,14}$/.test(WG_IFACE_RAW)) {
  console.error(`FATAL: WG_IFACE "${WG_IFACE_RAW}" is invalid (must match ^[a-zA-Z][a-zA-Z0-9_]{0,14}$)`);
  process.exit(1);
}

// --- Определение клиентского IP за reverse-proxy ---
// Сервис слушает ТОЛЬКО 127.0.0.1 и наружу выставляется через nginx/caddy,
// поэтому X-Forwarded-For мог прийти только через наш локальный прокси —
// заголовку доверяем и берём ПЕРВЫЙ IP (реальный клиент). Иначе rate-limit
// ключевался бы по IP прокси = один глобальный лимит на всех юзеров.
// ВНИМАНИЕ: если сервис выставить наружу напрямую (0.0.0.0) — доверие к XFF
// убрать: клиент сможет подделывать заголовок и обходить rate-limit.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Per-IP in-memory rate limiter: 5 attempts per 60 seconds.
const _rateLimitMap = new Map(); // ip -> { count, resetAt }
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = _rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    _rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return false; // not limited
  }
  entry.count += 1;
  if (entry.count > 5) return true; // limited
  return false;
}

const WG = {
  iface: WG_IFACE_RAW,
  serverPub: process.env.WG_SERVER_PUBKEY || '',
  endpoint: process.env.WG_ENDPOINT || '',          // host:port
  subnet: process.env.WG_SUBNET || '10.8.0',        // /24 base, clients get .2..254
  dns: process.env.WG_DNS || '1.1.1.1',
  // AmneziaWG obfuscation params (must match the server's [Interface]); empty = plain WireGuard
  awg: {
    Jc: process.env.AWG_JC || '', Jmin: process.env.AWG_JMIN || '', Jmax: process.env.AWG_JMAX || '',
    S1: process.env.AWG_S1 || '', S2: process.env.AWG_S2 || '',
    H1: process.env.AWG_H1 || '', H2: process.env.AWG_H2 || '', H3: process.env.AWG_H3 || '', H4: process.env.AWG_H4 || ''
  }
};

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { peers: {} }; } }
function saveState(s) { fs.mkdirSync(require('path').dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function nextIp(state) {
  const used = new Set(Object.values(state.peers).map(p => p.ip));
  for (let i = 2; i < 255; i++) { const ip = `${WG.subnet}.${i}`; if (!used.has(ip)) return ip; }
  throw new Error('subnet full');
}

function createPeer(clientName, inviteCode) {
  const state = loadState();

  // Лимит пиров на инвайт-код — проверяем ДО генерации ключей и `wg set`.
  // state.invites: { "<code>": { peers: N, clients: { "<hostname>": count } } }.
  // Простой файловый учёт; для прод — вынести в БД/Redis.
  if (!state.invites) state.invites = {};
  const inv = state.invites[inviteCode] || (state.invites[inviteCode] = { peers: 0, clients: {} });
  if (inv.peers >= MAX_PEERS_PER_INVITE) {
    const err = new Error(
      `invite code peer limit reached (${MAX_PEERS_PER_INVITE} peers per code); ` +
      'ask for a new invite code or have an old peer revoked');
    err.statusCode = 403;
    throw err;
  }

  const priv = execSync('wg genkey').toString().trim();
  const pub = execSync(`echo ${priv} | wg pubkey`, { shell: '/bin/bash' }).toString().trim();
  const ip = nextIp(state);

  // register peer on the live interface
  execSync(`wg set ${WG.iface} peer ${pub} allowed-ips ${ip}/32`);
  try { execSync(`wg-quick save ${WG.iface}`); } catch {}

  state.peers[pub] = { ip, client: clientName, invite: inviteCode, ts: Date.now() };
  inv.peers += 1;
  inv.clients[clientName] = (inv.clients[clientName] || 0) + 1;
  saveState(state);

  const a = WG.awg;
  const awgLines = a.Jc ? [
    `Jc = ${a.Jc}`, `Jmin = ${a.Jmin}`, `Jmax = ${a.Jmax}`,
    `S1 = ${a.S1}`, `S2 = ${a.S2}`, `H1 = ${a.H1}`, `H2 = ${a.H2}`, `H3 = ${a.H3}`, `H4 = ${a.H4}`
  ].join('\n') + '\n' : '';

  return [
    '[Interface]',
    `PrivateKey = ${priv}`,
    `Address = ${ip}/24`,
    `DNS = ${WG.dns}`,
    awgLines.trim(),
    '',
    '[Peer]',
    `PublicKey = ${WG.serverPub}`,
    `Endpoint = ${WG.endpoint}`,
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'PersistentKeepalive = 25',
    ''
  ].filter(l => l !== undefined).join('\n');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }

  // Fail-closed: refuse all enrollments if INVITE_CODES was not configured.
  if (INVITES.size === 0) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'server not configured: INVITE_CODES empty' }));
  }

  // Per-IP rate limit: 5 attempts / 60 s (клиентский IP с учётом X-Forwarded-For).
  const ip = clientIp(req);
  if (checkRateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'too many requests' }));
  }

  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
  req.on('end', () => {
    let data; try { data = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }
    const inviteCode = (data.inviteCode || '').trim();
    if (!INVITES.has(inviteCode)) { res.writeHead(403); return res.end('bad invite'); }
    try {
      if (data.format === 'amnezia') {
        // TODO: build Amnezia vpn:// container (JSON -> zlib -> base64url -> "vpn://").
        res.writeHead(501, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'amnezia vpn:// not implemented yet; use amneziawg' }));
      }
      const clientName = String(data.client || 'client').trim().slice(0, 128) || 'client';
      const config = createPeer(clientName, inviteCode);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config, name: 'hamidun' }));
    } catch (e) {
      // err.statusCode = 403 у лимита пиров на инвайт; остальное — 500.
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`enroll-server on 127.0.0.1:${PORT}`));
