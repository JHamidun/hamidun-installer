# Спеки фич

> Файл СГЕНЕРИРОВАН: `node tools/extract-features.js`. Руками не править —
> перезапишется. Состав берётся из `docs/INVENTORY.md`, расхождение ловит
> `npm run specs:check`.

Спека описывает ожидаемое поведение одной фичи и обязана быть проверяемой:
пути в шапке существуют, заголовки тестов присутствуют в `test/run-tests.js`
дословно. Иначе документ со временем врёт — см. [ADR-008](../adr/008-machine-checked-specs.md).

Продукт целиком и сквозные инварианты — [PRD](../PRD.md).

**Фич: 61. Из них с подтверждённым тестом: 55.**

## Установка компонентов — 22 (с тестом 21)

- [Git](git.md)
- [Node.js LTS](node-js-lts.md)
- [VS Code + два расширения](vs-code-dva-rasshireniya.md)
- [Cursor (опционально)](cursor-opcionalno.md)
- [Claude Code CLI](claude-code-cli.md)
- [Расширение Claude Code для Cursor](rasshirenie-claude-code-dlya-cursor.md)
- [Скрытый шаг «Проверка установки»](skrytyy-shag-proverka-ustanovki.md)
- [Конфиг Жемала (`~/.claude`)](konfig-zhemala-claude.md)
- [Наборы скиллов (packs) с прунингом](nabory-skillov-packs-s-pruningom.md)
- [Python-пакеты (pydeps) + Playwright-браузеры](python-pakety-pydeps-playwright-brauzery.md)
- [Nomad — приватный AI-агент](nomad-privatnyy-ai-agent.md)
- [Поле ключа Nomad на финише](pole-klyucha-nomad-na-finishe.md) — ⚠ тест не подтверждён
- [uv (только вшитый)](uv-tolko-vshityy.md)
- [AI-мост (split-tunnel к ИИ)](ai-most-split-tunnel-k-ii.md)
- [Скрепка (маскот)](skrepka-maskot.md)
- [Claude Desktop (онлайн)](claude-desktop-onlayn.md)
- [ChatGPT Desktop (онлайн)](chatgpt-desktop-onlayn.md)
- [Handy — голосовой ввод](handy-golosovoy-vvod.md)
- [Стартовый проект `~/HamidunStart`](startovyy-proekt-hamidunstart.md)
- [Детекция уже установленного](detekciya-uzhe-ustanovlennogo.md)
- [Удаление компонента с квитанциями](udalenie-komponenta-s-kvitanciyami.md)
- [«Переустановить начисто» (repair)](pereustanovit-nachisto-repair.md)

## Целостность и гейты — 7 (с тестом 7)

- [Гейт целостности вшитых артефактов](geyt-celostnosti-vshityh-artefaktov.md)
- [Второй гейт — внутри докачанного архива](vtoroy-geyt-vnutri-dokachannogo-arhiva.md)
- [Де-элевация](de-elevaciya.md)
- [Строгий allowlist окружения](strogiy-allowlist-okruzheniya.md)
- [Блокирующий стоп-экран при оторванном vendor](blokiruyuschiy-stop-ekran-pri-otorvannom-vendor.md)
- [Проба сервера докачки (preflight lite)](proba-servera-dokachki-preflight-lite.md)
- [Один экземпляр + уборка за собой](odin-ekzemplyar-uborka-za-soboy.md)

## Экраны и сценарий ученика — 18 (с тестом 14)

- [Экран приветствия](ekran-privetstviya.md)
- [Экран выбора компонентов с зависимостями](ekran-vybora-komponentov-s-zavisimostyami.md)
- [Попап «что попадёт / что скачается»](popap-chto-popadet-chto-skachaetsya.md)
- [Экран прогресса](ekran-progressa.md)
- [Прогресс докачки в мегабайтах](progress-dokachki-v-megabaytah.md)
- [Карусель подсказок](karusel-podskazok.md) — ⚠ тест не подтверждён
- [Маскот Омлетон в интерфейсе](maskot-omleton-v-interfeyse.md) — ⚠ тест не подтверждён
- [Финишный экран «три шага»](finishnyy-ekran-tri-shaga.md)
- [CTA бота с deep-link по результату](cta-bota-s-deep-link-po-rezultatu.md)
- [Памятка «Что дальше» офлайн](pamyatka-chto-dalshe-oflayn.md)
- [Мини-визард API-ключей](mini-vizard-api-klyuchey.md) — ⚠ тест не подтверждён
- [Кнопки запуска после установки](knopki-zapuska-posle-ustanovki.md)
- [Предупреждение «запущен под другой учёткой»](preduprezhdenie-zapuschen-pod-drugoy-uchetkoy.md)
- [Предполётные проверки машины](predpoletnye-proverki-mashiny.md) — ⚠ тест не подтверждён
- [Каскад «пропущено из-за зависимости»](kaskad-propuscheno-iz-za-zavisimosti.md)
- [Сторож молчащего шага](storozh-molchaschego-shaga.md)
- [Человеческий перевод провала](chelovecheskiy-perevod-provala.md)
- [macOS: самолечение карантина и транслокации](macos-samolechenie-karantina-i-translokacii.md)

## Публикация и издания — 8 (с тестом 8)

- [Два издания: офлайн и лёгкое](dva-izdaniya-oflayn-i-legkoe.md)
- [Докачка тяжёлых компонентов из CDN](dokachka-tyazhelyh-komponentov-iz-cdn.md)
- [Предполётные гейты сборки](predpoletnye-geyty-sborki.md)
- [Обслуживание vendor](obsluzhivanie-vendor.md)
- [Единый предрелизный вердикт GO/NO-GO](edinyy-predreliznyy-verdikt-go-no-go.md)
- [Публикация артефактов в S3](publikaciya-artefaktov-v-s3.md)
- [CI: обязательный юнит-гейт](ci-obyazatelnyy-yunit-geyt.md)
- [E2E-прогон настоящего GUI](e2e-progon-nastoyaschego-gui.md)

## Курс — 2 (с тестом 1)

- [Курс-симулятор + ярлык на столе](kurs-simulyator-yarlyk-na-stole.md)
- [Маяк завершения курса](mayak-zaversheniya-kursa.md) — ⚠ тест не подтверждён

## Сопутствующее — 4 (с тестом 4)

- [Телеметрия с opt-out и привязкой к человеку](telemetriya-s-opt-out-i-privyazkoy-k-cheloveku.md)
- [Журнал установки на диске](zhurnal-ustanovki-na-diske.md)
- [Аудит работоспособности конфига](audit-rabotosposobnosti-konfiga.md)
- [Режим холостого прогона (dry-run)](rezhim-holostogo-progona-dry-run.md)

