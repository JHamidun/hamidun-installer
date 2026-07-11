# Hamidun Bridge Bot — спецификация воронки (хэндофф для разработки бота)

> **ЦЕЛЕВОЙ БОТ: существующий `@HamidunAcademyBot`** (уже развёрнут на сервере). Это НЕ новый бот —
> воронку ниже встраиваем в него. Установщик уже шлёт юзера сюда (`config.json` → `links.bot`).
> Бот опознаёт юзера по `tg_id` (он уже /start'нул бота через email-deeplink на лендинге), поэтому
> пост-инсталл payload может быть простым (`?start=installed`) — персональный токен в установщике НЕ обязателен.

Бот = вход в продукт Hamidun: выдаёт ссылку на установщик, ловит юзера после установки (deeplink),
даёт инструкцию «как пользоваться» и продаёт «AI-мост» (стабильный зарубежный IP для Claude/OpenAI)
тем, у кого блокировки. **Базовый продукт (установщик + конфиг + Claude Code) — бесплатный лид-магнит.
Мост — монетизация.** Сделано по разбору конкурента «Реле AI» — с исправлением его ошибок (см. в конце).

## Полный флоу

```
Лендинг (email-капча)
  → бот+email получают ссылку на установщик (deeplink t.me/Bot?start=dl_<token>)
  → юзер качает установщик → ставит (Claude Code + Cursor + конфиг + компонент «AI-мост» [выкл])
  → установщик после установки открывает t.me/Bot?start=inst_<token>
  → бот: пост-инсталл экран
       ├─ «Просто пользоваться»  → инструкция (3 шага) + видео
       └─ «Есть блокировки → мост» → ценность → trial 14д → тарифы → оплата
             → бот выдаёт bridge_token → приложение само тянет SSH-доступ по токену
             → тумблер «AI-мост» в приложении → Включить
```

## Deep-link токены (склейка лендинг ↔ бот ↔ установщик)

- `dl_<token>` — выдаётся при email-капче на лендинге. `/start dl_<token>` → бот связывает email↔tg_id,
  отдаёт ссылку на установщик (и дублирует на email).
- `inst_<token>` — зашит в установщик (через `config.json` или подставлен при генерации ссылки).
  Установщик в финальном экране открывает `t.me/Bot?start=inst_<token>` → бот помечает «installed»,
  показывает пост-инсталл меню. (Можно один сквозной токен на user — главное стабильная связка user↔token.)
- `bridge_token` — выдаётся после оплаты/trial. Приложение (компонент «AI-мост») дёргает enroll-endpoint
  с этим токеном и САМО получает SSH-доступ. Юзер ничего руками не вводит.

## Состояния пользователя (FSM — ПРОЩАЮЩАЯ)

`new → email_captured → installer_sent → installed → (free | trial | paid)`.
**Любой неожиданный ввод → показать текущее меню. НЕ зацикливать** (главная ошибка ReleAI — см. ниже).

## Команды и экраны

- `/start [payload]` — роутинг по payload (`dl_`/`inst_`/пусто). Пустой → приветствие + меню.
- **Экран после email (`dl_`):** «Спасибо! Вот установщик: [ссылка]. После установки я сам тебя встречу.»
- **Пост-инсталл (`inst_`):** «Установка готова! 🎉 Открой Cursor → панель Claude Code → войди подпиской.»
  Две кнопки:
  - «✅ Просто пользоваться» → 3-шаговая инструкция + ссылка на короткое видео.
  - «🔓 У меня блокировки → включить мост» → экран моста.
- **Экран моста:** объяснить ценность (стабильный чистый IP только для Claude — не VPN, не тормозит,
  работает поверх твоего VPN, аккаунт не банят за прыжки IP) → кнопка «Включить trial 14 дн бесплатно».
- `/status` — план, остаток trial, кол-во устройств, ключ.
- `/pay` — тарифы + оплата (TG Stars / ЮKassa). После оплаты/trial → выдать `bridge_token` + инструкция
  «Открой приложение → переключатель «AI-мост» → Включить».
- `/bridge` — статус моста / вкл-выкл / сменить сервер.
- `/support` — @поддержка.
- Атрибуцию («откуда узнал») спрашивать ОПЦИОНАЛЬНО и ПОСЛЕ выдачи ценности, кнопкой «пропустить». НЕ гейтом.
- **Mac-примечание (обязательно в экран выдачи ссылки для Mac):** приложение не подписано Apple
  Developer ID → macOS после скачивания пишет «приложение повреждено» (это Gatekeeper, не порча).
  Бот сразу даёт 2 шага: перетащить в «Программы», затем в Терминале
  `xattr -cr "/Applications/Hamidun Setup.app"` — и открыть. Та же инструкция лежит внутри dmg
  (файл «ПРОЧТИ ЕСЛИ ПИШЕТ ПОВРЕЖДЕНО.txt»). Убрать диалог совсем = нотаризация (v2, $99/год).

## Тарифы (рекомендация — дешевле ReleAI 399/599)

- **Лайт ~199 ₽/мес** — свой VPS (вводишь доступ или по нашему enroll), общий пул IP.
- **Стандарт ~299 ₽/мес** — +выделенный VPS/IP под юзера (1 юзер = 1 IP), страна под биллинг карты.
- Trial 14 дн бесплатно, до 5 устройств на ключ.
- Опция: мост **бесплатно** для платных студентов Академии (вшить в тариф обучения).

## Bridge enroll-контракт (бэкенд моста)

Реализация — `installer/server/enroll-ssh-server.js` (выдаёт SSH-доступ):

```
POST https://bridge.hamidun.../enroll
  body: { "bridgeToken": "...", "client": "hostname" }
  200 -> { "sshHost": "1.2.3.4", "sshPort": 22, "sshUser": "rele",
           "sshKey": "<private key>", "pacDomains": ["claude.ai","anthropic.com","openai.com","chatgpt.com"] }
```

Приложение поднимает SSH `-D` (paramiko, локальный SOCKS5), пишет PAC с `pacDomains` в системный прокси,
для Claude Code CLI ставит `HTTPS_PROXY`. 1 платящий = 1 выделенный VPS (Стандарт) либо общий пул (Лайт).
Инвайт/токен-авторизация обязательна (иначе любой наплодит пиров). Rate-limit + fail-closed (см. enroll-ssh-server.js).

## Биллинг/БД (минимум)

```
users(tg_id, email, state, source, created)
tokens(token, type[dl|inst|bridge], user, used, created)
subs(user, plan, status, trial_ends, devices_used)
bridge(user, vps_id, ip, ssh_creds, active)
```

## Анти-паттерны (исправляем ошибки ReleAI — проверено вживую)

- ❌ **НЕ гейтить вход атрибуцией.** У ReleAI `/start` сразу спрашивает «откуда узнал?» inline-кнопкой,
  и пока не нажмёшь — `/key`, `/status`, `/pay` ВСЕ зацикливаются назад. Новый юзер застревает → конверсия 0.
- ❌ **FSM не должна зацикливаться** на любом «неожиданном» вводе — показывай меню, не кидай в начало.
- ❌ **Единые факты лендинг↔бот↔приложение.** У ReleAI лендинг пишет «оплата в Telegram», бот — ЮKassa. Доверие падает.
- ❌ **Не заставляй вводить SSH/ключ вручную.** У ReleAI: скачай exe → введи ключ → введи SSH к VPS. Для новичка стена.
  У нас: deeplink-токен → приложение само всё подтягивает. Один клик.
- ✅ Партнёрку/промокоды — продуктизировать (у ReleAI 50% спрятано только в личку).
- ✅ Mac — есть (через GitHub Actions), не извиняться за отсутствие DMG.

## Модель БД (минимум)

```sql
users(tg_id PK, email, state, source, created_at)
tokens(token PK, type, user_tg_id, used BOOL, created_at)   -- type: dl | bridge
subs(user_tg_id PK, plan, status, trial_ends_at, devices_used)  -- plan: lite|standard; status: trial|active|expired
bridge(user_tg_id PK, vps_id, ip, ssh_user, active BOOL)
```

## Пример хендлера /start (псевдокод, разбор payload)

```python
async def on_start(msg):
    user = upsert_user(msg.from_user)            # создаём/находим по tg_id
    payload = parse_start_payload(msg)            # "dl_<t>" | "installed" | "" 
    if payload.startswith("dl_"):
        tok = consume_token(payload[3:], type="dl")   # связываем email<->tg_id
        user.state = "installer_sent"
        return send(user, "Спасибо! Вот установщик: " + installer_url(user),
                    also_email=tok.email)             # дублируем ссылку на email
    if payload == "installed":
        user.state = "installed"
        return send_post_install_menu(user)           # «Просто пользоваться / Включить мост»
    # обычный /start
    return send_welcome_menu(user)                    # ценность + кнопка «Получить установщик»

# Включение моста после оплаты/trial:
async def grant_bridge(user, plan):
    vps = provision_or_pick_vps(user, plan)           # Standard: выделенный; Lite: пул
    bt = issue_bridge_token(user, vps)                # сохраняем в tokens(type=bridge)
    register_token_on_enroll_server(bt, vps)          # POST /admin/token (см. enroll-ssh-server.js)
    return send(user, "Мост готов 🎉 Открой приложение → значок в трее → Включить.\n"
                      "Токен подтянется автоматически.")  # либо отдать bridge_token для вставки
```

**Связь с установленным приложением:** приложение (агент `agent/bridge_agent.py`) дёргает
`bridge.enrollEndpoint` с `bridgeToken` и САМО получает SSH-доступ. Бот лишь выдаёт токен и
регистрирует его на enroll-сервере. Юзер ничего руками не вводит.
