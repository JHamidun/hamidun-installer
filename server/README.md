# Hamidun — enroll-сервис «AI-моста» (SSH)

Серверная часть компонента «AI-мост»: выдаёт установщику SSH-доступ (`ssh -D` SOCKS) по токену.
Клиент — `agent/bridge_agent.py`; спека бота/биллинга — `docs/bridge-bot-spec.md`.
Когда купишь сервер: подними `enroll-ssh-server.js`, впиши адрес в `../config.json` → `bridge.enrollEndpoint` и пересобери установщик. Пока эндпоинт пуст — агент моста мягко простаивает.

> Ранее здесь лежал референс VPN-enroll сервера (WireGuard/AmneziaWG-конфиги). Он удалён:
> установщик VPN не ставит и не настраивает, мост работает поверх SSH.

## `enroll-ssh-server.js` — контракт API

```
POST /enroll  { "bridgeToken": "...", "client": "hostname" }
200 -> { "sshHost", "sshPort", "sshUser", "sshKey", "pacDomains" }
```

Приложение поднимает SSH `-D` (локальный SOCKS5), пишет PAC с `pacDomains` в системный прокси, для Claude Code CLI ставит `HTTPS_PROXY`.

## Встроенная защита

- **Токены** регистрирует бот через `POST /admin/token` (`x-admin-secret`). Модель токена: `maxDevices` (по умолчанию 5 — как в спеке «до 5 устройств на ключ», env `MAX_DEVICES_DEFAULT`), `expiresAt` (опционально), `devicesUsed` (учёт по `client`-hostname). Сверх лимита устройств — `403` с внятной ошибкой; повторный enroll с того же hostname лимит не тратит. Учёт — в `tokens.json`; для прода — БД/Redis.
- **Rate-limit** — по клиентскому IP с учётом `X-Forwarded-For`, но НЕ из первого элемента (его контролирует клиент → спуфинг и обход лимита), а из записи, дописанной НАШИМ прокси: элемент с индексом `length - TRUSTED_PROXY_COUNT` (env, по умолчанию 1 — одиночный nginx/caddy; каждый доверенный прокси дописывает одну запись в конец). Нет XFF — берётся `socket.remoteAddress`. Если выставишь сервис наружу напрямую (0.0.0.0, без прокси) — убери доверие к XFF в `clientIp()` целиком.
- **Ключ обязателен в ответе** — если `sshKeyPath` у токена не задан или файл нечитаем, сервис отвечает `500` с внятной ошибкой (а не `200` с пустым `sshKey`, который дал бы клиенту битую конфигурацию). Проверка идёт ДО учёта устройства — слот девайса на серверной ошибке не тратится.
- HTTPS только. Сервис слушает 127.0.0.1 — наружу выставляй через reverse-proxy (nginx/caddy + Let's Encrypt).

## Ограничение SSH-ключа на VPS (ОБЯЗАТЕЛЬНО)

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

- Провижининг выделенного VPS под юзера (тариф «Стандарт») через API провайдера — сейчас выдача из `tokens.json`.
