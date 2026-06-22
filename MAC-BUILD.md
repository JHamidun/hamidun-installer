# Сборка macOS-версии

`.dmg` собирается **только на macOS** (electron-builder требует Mac-тулчейн — `hdiutil` и т.д.).
На Windows Mac-версию скомпилировать нельзя. Есть два пути.

## Вариант A — облако (без своего Mac), рекомендуется

GitHub Actions собирает `.dmg` на облачном macOS-раннере бесплатно.

1. Запушить проект в GitHub-репозиторий (один раз).
2. Вкладка **Actions → «Build macOS (.dmg)» → Run workflow**.
3. Через ~5-10 мин в **Artifacts** появится `Hamidun-Setup-Mac` с `.dmg`.

Workflow: `.github/workflows/build-mac.yml`. Сборка без подписи (v1) — при первом запуске
пользователь делает правый клик → «Открыть» (Gatekeeper).

## Вариант B — на любом Mac

```bash
npm install
npm run dist:mac          # -> release/Hamidun-Setup-Mac.dmg
```

## Что входит в Mac-версию (v1, гибрид)

- **Конфиг (.claude) — офлайн**, вшит в установщик (как на Windows).
- **Приложения** (Git, Node, Cursor, Python, Claude CLI, AmneziaVPN) — ставятся при установке
  через Homebrew / прямые `.pkg`/`.dmg` (нужен интернет). Скрипты: `scripts/macos/*.sh`.
- Финальный экран «Что дальше», выбор паков, VPN-логика — те же, что на Windows.

## Полный офлайн на Mac (на будущее)

Нужен Mac, чтобы скачать Mac-бинари: `.pkg` Node/Python, `.dmg` Cursor/AmneziaVPN,
Python-wheels (`macosx`), Playwright-браузеры (mac). Делается скриптом `fetch-vendor-mac.sh`
(аналог Windows `fetch-vendor.ps1`) — добавим, когда дойдут руки до полного офлайн-Mac.

## Подпись/нотаризация (чтобы убрать «не удаётся открыть»)

Нужен Apple Developer ID ($99/год): `codesign` + `notarytool` + `stapler`.
Настраивается в `package.json` → `mac` + секреты в GitHub Actions.
