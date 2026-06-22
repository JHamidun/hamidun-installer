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
- HTTPS только. Сервис слушает 127.0.0.1 — наружу выставляй через reverse-proxy.
- Отзыв пира: убери из `wg`/wg-easy + `state.json`.

## Что ещё не сделано
- `format=amnezia` (vpn://-код для полного клиента) — заглушка `501`. Дореализовать контейнер Amnezia (JSON → zlib → base64url → `vpn://`), когда понадобится продвинутый режим.
