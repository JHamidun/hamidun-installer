# Hamidun VPN — enrollment service (для персональных конфигов)

Когда купишь новый сервер, подними здесь сервис, который выдаёт **персональный WireGuard/AmneziaWG-конфиг** каждому установщику по инвайт-коду. Потом впиши его адрес в `../config.json` → `vpn.enrollEndpoint` и пересобери установщик.

## Контракт API (его ждут клиентские скрипты)

```
POST  https://vpn.ТВОЙ-ДОМЕН{enrollPath}      # enrollPath по умолчанию /enroll
Content-Type: application/json
{ "inviteCode": "abc123", "client": "DESKTOP-XYZ", "format": "amneziawg" }

200 (format=amneziawg) -> { "config": "<текст .conf>", "name": "hamidun" }
200 (format=amnezia)   -> { "vpnCode": "vpn://..." }
403 -> неверный инвайт-код
```

## Два пути развёртывания

### Вариант 1 — wg-easy + этот сервис как тонкий прокси (проще)
1. Поставь [wg-easy](https://github.com/wg-easy/wg-easy) (Docker) — даёт веб-админку и WireGuard.
2. Этот `enroll-server.js` оберни поверх его API, добавив проверку инвайт-кода. Веб-админка wg-easy остаётся для ручного управления/отзыва пиров.

### Вариант 2 — прямой `wg` (этот скрипт как есть)
1. Подними WireGuard/AmneziaWG-сервер (`awg0`), включи форвардинг + NAT.
2. Поставь Node 18+ и `wireguard-tools`.
3. Запусти сервис (см. ниже), закрой за nginx/caddy с HTTPS (Let's Encrypt).

## Запуск (Вариант 2)

```bash
sudo INVITE_CODES="код1,код2,код3" \
  MAX_PEERS_PER_INVITE=5 \
  WG_IFACE=awg0 \
  WG_SERVER_PUBKEY="<серверный публичный ключ>" \
  WG_ENDPOINT="vpn.твой-домен:51820" \
  WG_SUBNET="10.8.0" WG_DNS="1.1.1.1" \
  node enroll-server.js
```

Для AmneziaWG добавь обфускацию (должна совпадать с `[Interface]` сервера):
`AWG_JC, AWG_JMIN, AWG_JMAX, AWG_S1, AWG_S2, AWG_H1..AWG_H4`.

## Безопасность
- **Инвайт-коды обязательны** — иначе любой наплодит пиров. Раздавай разные коды разным людям → сможешь отозвать.
- **Лимит пиров на инвайт-код** — `MAX_PEERS_PER_INVITE` (по умолчанию 5). Утечка одного кода больше не забьёт /24 и не сломает enroll всем; сверх лимита сервер отвечает `403` с внятной ошибкой. Учёт — в `state.json` (`state.invites`); для прода — вынести в БД/Redis.
- HTTPS только. Сервис слушает 127.0.0.1 — наружу выставляй через reverse-proxy.
- **Rate-limit за прокси** — клиентский IP берётся из первого элемента `X-Forwarded-For` (заголовку доверяем, потому что сервис слушает только 127.0.0.1 и запросы приходят исключительно через локальный nginx/caddy). Если выставишь сервис наружу напрямую — убери доверие к XFF в `clientIp()`.
- Отзыв пира: убери из `wg`/wg-easy + `state.json` (и уменьши счётчик в `state.invites`, если код ещё живой).

## AI-мост (SSH) — `enroll-ssh-server.js`

Второй сервис в этой папке — enroll для «AI-моста» (SSH `-D` SOCKS вместо WireGuard). Контракт (его ждёт `agent/bridge_agent.py`, см. `docs/bridge-bot-spec.md`):

```
POST /enroll  { "bridgeToken": "...", "client": "hostname" }
200 -> { "sshHost", "sshPort", "sshUser", "sshKey", "pacDomains" }
```

Встроенная защита:

- **Токены** регистрирует бот через `POST /admin/token` (`x-admin-secret`). Модель токена: `maxDevices` (по умолчанию 5 — как в спеке «до 5 устройств на ключ», env `MAX_DEVICES_DEFAULT`), `expiresAt` (опционально), `devicesUsed` (учёт по `client`-hostname). Сверх лимита устройств — `403` с внятной ошибкой; повторный enroll с того же hostname лимит не тратит. Учёт — в `tokens.json`; для прода — БД/Redis.
- **Rate-limit** — по клиентскому IP с учётом `X-Forwarded-For` (та же логика доверия, что и выше: сервис слушает только 127.0.0.1 за reverse-proxy).

### Ограничение SSH-ключа на VPS (ОБЯЗАТЕЛЬНО)

Сервис только **возвращает** приватный ключ клиенту — `authorized_keys` на bridge-VPS настраивается при провижининге (вручную или скриптом). «Голый» ключ = полный шелл + открытый SOCKS куда угодно. Прописывай ключ ТОЛЬКО с опциями:

```
restrict,port-forwarding,permitopen="*:443",permitopen="*:80",command="/usr/sbin/nologin" ssh-ed25519 AAAA... hamidun-bridge
```

Что это даёт:

- `restrict` — выключает всё: pty, X11, agent-forwarding, user-rc, forwarding;
- `port-forwarding` — возвращает только TCP-forwarding (нужен для `ssh -D`);
- `permitopen="*:443"`/`"*:80"` — direct-tcpip каналы (в т.ч. через SOCKS от `-D`) только на 443/80: это «мост для AI-доменов», а не open proxy;
- `command="/usr/sbin/nologin"` — блокирует запуск команд/шелла (клиент подключается как `ssh -N`; `bridge_agent.py` шелл не запрашивает).

Плюс сам пользователь (`rele`) — с `shell=/usr/sbin/nologin`, без sudo. Отзыв доступа = удалить строку из `authorized_keys` (+ удалить токен из `tokens.json`).

## Что ещё не сделано
- `format=amnezia` (vpn://-код для полного клиента) — заглушка `501`. Дореализовать контейнер Amnezia (JSON → zlib → base64url → `vpn://`), когда понадобится продвинутый режим.
- Провижининг выделенного VPS под юзера (тариф «Стандарт») через API провайдера — сейчас выдача из `tokens.json`.
