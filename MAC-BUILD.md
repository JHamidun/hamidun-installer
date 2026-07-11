# Сборка macOS-версии

`.dmg` собирается **только на macOS** (electron-builder требует Mac-тулчейн — `hdiutil` и т.д.).
На Windows Mac-версию скомпилировать нельзя. Есть два пути.

## Вариант A — облако (без своего Mac), рекомендуется

GitHub Actions собирает `.dmg` на облачном macOS-раннере бесплатно.

1. Запушить проект в GitHub-репозиторий (один раз).
2. Вкладка **Actions → «Build macOS (.dmg)» → Run workflow**.
3. Через ~5-10 мин в **Artifacts** появится `Hamidun-Setup-Mac` с `.dmg`.

Workflow: `.github/workflows/build-mac.yml`. Сборка без Apple Developer ID (v1).

## ⚠️ Gatekeeper: «Приложение повреждено» — это НЕ битый файл

Проверено вживую (29.06.2026, MacBook Air): скачанный из браузера НЕподписанный `.app`
современная macOS блокирует с формулировкой **«повреждено, и его не удается открыть.
Переместите в Корзину»** — правый клик → «Открыть» больше НЕ помогает (убрали в Sequoia).
Диалог показывает «Chrome загрузил этот файл...» — это метка карантина, а не порча файла.

Что сделано в сборке:
1. **Ad-hoc подпись** (`tools/mac-adhoc-sign.js`, afterPack hook, `codesign -s -`) —
   без ЛЮБОЙ подписи arm64-бинарь ядро вообще не запускает («Killed: 9») даже после
   снятия карантина. Ad-hoc это чинит, но диалог Gatekeeper НЕ убирает.
2. **Инструкция внутри dmg** (`assets/mac/ПРОЧТИ ЕСЛИ ПИШЕТ ПОВРЕЖДЕНО.txt`,
   секция `build.dmg.contents`).

Инструкция пользователю (двухшаговая):
```bash
# 1) перетащить Hamidun Setup в Программы, 2) в Терминале:
xattr -cr "/Applications/Hamidun Setup.app"
```
После этого приложение открывается как обычно (одноразово).

Единственный способ убрать диалог совсем — подпись + нотаризация (см. ниже).

## Вариант B — на любом Mac

```bash
npm install
npm run dist:mac          # -> release/Hamidun-Setup-Mac.dmg
```

## Что входит в Mac-версию (v1, гибрид)

- **Конфиг (.claude) — офлайн**, вшит в установщик (как на Windows).
- **Приложения** (Git, Node, Cursor, Python, Claude CLI) — ставятся при установке
  через Homebrew / прямые `.pkg`/`.dmg` (нужен интернет). Скрипты: `scripts/macos/*.sh`.
- Финальный экран «Что дальше», выбор паков — те же, что на Windows.

## Полный офлайн на Mac (на будущее)

Нужен Mac, чтобы скачать Mac-бинари: `.pkg` Node/Python, `.dmg` Cursor,
Python-wheels (`macosx`), Playwright-браузеры (mac). Делается скриптом `fetch-vendor-mac.sh`
(аналог Windows `fetch-vendor.ps1`) — добавим, когда дойдут руки до полного офлайн-Mac.

## Подпись/нотаризация (чтобы убрать «не удаётся открыть»)

Нужен Apple Developer ID ($99/год): `codesign` + `notarytool` + `stapler`.
Настраивается в `package.json` → `mac` + секреты в GitHub Actions.
