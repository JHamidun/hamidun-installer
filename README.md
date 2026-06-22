# Hamidun Setup

Установщик «в один клик» для полностью настроенного окружения Claude Code + VPN.
Галочками выбираешь компоненты → жмёшь «Установить» → на чистой машине появляется рабочий Cursor + Claude Code + конфиг Жемала + VPN.

Electron-приложение. Один продукт → две сборки: `Hamidun-Setup-Windows.exe` и `Hamidun-Setup-Mac.dmg`. Это **онлайн-установщик** (бутстрэппер): компоненты качаются с официальных источников на лету, поэтому сам установщик лёгкий и всегда ставит свежие версии.

## Компоненты (галочки)

| Группа | Компонент | Что делает |
|---|---|---|
| Редактор и Claude Code | Git, Node.js, Cursor, Claude Code CLI, Расширение Claude Code | базовый стек |
| Конфиг Жемала | Конфиг (.claude), Python-пакеты | клон [claude-code-config-pack](https://github.com/JHamidun/claude-code-config-pack) + зависимости |
| VPN (Amnezia) | AmneziaWG (авто), AmneziaVPN (продвинутый) | персональный конфиг с сервера |

Зависимости разрешаются автоматически: «Конфиг» включает Git+Node, «Расширение» — Cursor, «Python-пакеты» — Конфиг.

## Разработка

```bash
cd C:\Vibecode\hamidun-installer
npm install
npm start            # запустить GUI локально
```

## Сборка дистрибутивов

```bash
npm run dist:win        # ПОЛНЫЙ ОФЛАЙН: тянет конфиг + всё ПО в vendor/ и вшивает (~1 ГБ exe)
npm run dist:win:lite   # ГИБРИД: вшит только конфиг, приложения качаются при установке (~75 МБ)
npm run dist:mac        # macOS .dmg (запускать на Mac; офлайн-vendor пока только Windows)
```

На выходе один файл `release/Hamidun-Setup-Windows.exe` — portable, сам запрашивает админа.

**Офлайн-сборка** (`dist:win`) перед упаковкой качает в `vendor/`:
- `config-pack/` — свежий конфиг с GitHub (`tools/fetch-config.js`);
- `apps/` — установщики Git, Node, Cursor, Python 3.12, AmneziaWG, AmneziaVPN;
- `npm-cache/` — Claude Code CLI для офлайн `npm i -g`;
- `pywheels/` — Python-библиотеки (cp312 / win_amd64);
- `playwright-browsers/` — Chromium.

Скрипты ставят компонент из `vendor/`, если он там есть (офлайн), иначе winget/прямая загрузка (онлайн-фолбэк). Обновление версий = пересборка (`tools/fetch-*` тянут свежее).

## Архитектура

- `src/main.js` — главный процесс: читает `config.json`/`components.json`, по IPC запускает скрипт компонента (`scripts/<os>/<id>.ps1|sh`), стримит вывод в UI.
- `src/preload.js` — безопасный мост (contextIsolation, без nodeIntegration).
- `src/renderer/` — UI в брендовой палитре Hamidun Academy (тёмно-синий, Inter Tight / Manrope / JetBrains Mono).
- `scripts/windows/*.ps1`, `scripts/macos/*.sh` — идемпотентные установщики, передача параметров через env `HM_*`.
- `server/` — референс enrollment-сервиса для персональных VPN-конфигов.
- `config.json` — параметры (URL конфиг-репо, VPN-эндпоинт, id расширения).

## Параметризация VPN

`config.json` → `vpn.enrollEndpoint` пока пуст. Пока пуст — VPN-скрипты **мягко пропускаются**. Когда купишь сервер: подними `server/` (см. `server/README.md`), впиши адрес в `config.json`, пересобери.

## Что НЕ автоматизируется

- **Вход в Claude Code** — каждый пользователь логинится в свою подписку Max/Pro (интерактивно, первый запуск). Установщик в конце предлагает запустить вход.
- **AmneziaVPN (полный, XRay/Shadowsocks)** — импорт `vpn://`-кода вручную (одна вставка). AmneziaWG ставится и подключается сам (на Windows — авто-подхват watched-папки; на macOS — импорт файла).

## v1: без подписи кода

Сборки пока не подписаны (по решению на старте). Что увидит новичок и как обойти:
- **Windows:** SmartScreen «Windows защитила компьютер» → *Подробнее → Выполнить в любом случае*.
- **macOS:** «не удаётся открыть» → правый клик по приложению → *Открыть*, либо `xattr -dr com.apple.quarantine /Applications/...`.

Для бесшовной установки позже: Azure Trusted Signing (Win) + Apple Developer ID + нотаризация (Mac).

## Заметка по безопасности

`src/renderer/app.js` использует `innerHTML` только для данных из bundled `components.json` (доверенный источник). Пользовательский ввод — только инвайт-код, он идёт в `value`, не в разметку. XSS-вектора нет.

## Статус

- ✅ Windows-скрипты всех компонентов (winget + прямые загрузки).
- ✅ macOS-скрипты (нативные .pkg/.dmg + osascript admin) — **требуют проверки на реальном Mac**.
- ✅ UI, граф зависимостей, стрим логов.
- ⏳ VPN-сервер — ждёт покупки сервера + адреса.
- ⏳ Иконки приложения (`assets/`), подпись/нотаризация.
