# Подпись Windows (убрать SmartScreen «неизвестный издатель»)

Сейчас `Hamidun-Setup-Windows.exe` **не подписан** (в логе сборки: `signing is skipped`).
При запуске новичок видит синий экран **«Windows защитила ваш компьютер»** → «Подробнее →
Выполнить в любом случае». Работает, но добавляет трение и страх.

## Варианты (по возрастанию цены/эффекта)

1. **Никак (сейчас)** — пользователь жмёт «Подробнее → Выполнить в любом случае». Бесплатно.
2. **Azure Trusted Signing (~$10/мес, рекомендую)** — Microsoft держит ключ в облачном HSM, ты не
   покупаешь физический токен. Нужен: Azure-аккаунт + верификация личности/ИП (для Individual — 3+
   года истории; иначе через Organization). Подпись снимает «неизвестный издатель», репутация
   SmartScreen копится по мере скачиваний.
3. **OV/EV код-сертификат от CA** (DigiCert/Sectigo, ~$200–600/год) — EV даёт мгновенную репутацию
   SmartScreen, но требует аппаратный токен/HSM. Дороже и муторнее Azure.

## Почему я не могу оформить это за тебя

Как и с Apple: нужен **аккаунт на твоё имя + проверка личности + оплата твоей картой**. Автоматизировать
нельзя — оформляешь ты (Azure-портал → Trusted Signing → создать Account + Certificate Profile).

## Что прислать мне после оформления (Azure Trusted Signing)

Через **GitHub Secrets** (repo JHamidun/hamidun-installer):
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — сервис-принципал с ролью
  «Trusted Signing Certificate Profile Signer»;
- `TRUSTED_SIGNING_ENDPOINT` (например `https://eus.codesigning.azure.net`);
- `TRUSTED_SIGNING_ACCOUNT`, `TRUSTED_SIGNING_PROFILE` — имя аккаунта и профиля сертификата.

(Для обычного OV/EV .pfx-сертификата вместо Azure: `CSC_LINK` = base64 .pfx + `CSC_KEY_PASSWORD`.)

## Что делаю я, когда секреты появятся

- Windows-сборка сейчас идёт **локально** (`npm run dist:win`). Для подписи переведу её на тот же
  GitHub Actions, что и Mac (добавлю job `build-win` на `windows-latest`), либо подпишу локально через
  Azure Trusted Signing Tool (`Invoke-TrustedSigning`) шагом electron-builder `sign`.
- electron-builder умеет Azure Trusted Signing из коробки (`azureSignOptions`) — пропишу в `package.json`
  → `win`, активируется только при наличии секретов; без них остаётся текущая неподписанная сборка.
- Результат: SmartScreen перестаёт пугать «неизвестным издателем».

## Итог по обеим платформам

Платформы разъехались — не сваливать их в одну фразу «подписи нет».

**Windows — не подписан.** Юзер видит SmartScreen «неизвестный издатель» → «Подробнее →
Выполнить в любом случае». Ждём сертификат Certum: он висит у удостоверяющего центра
с 17 августа со статусом `CA has sent the inquiry about the order`. Альтернатива, если
Certum так и не сдвинется, — Azure Trusted Signing (~$10/мес, вариант 2 выше).

**macOS — подписан Developer ID, нотаризован, застейплен.** Юзер не видит ничего особенного:
приложение открывается как обычная программа. Сделано, подробности — [MAC-SIGNING.md](MAC-SIGNING.md).

Единственное, что осталось у mac-пользователя, — запускать установщик **из окна dmg, не
перетаскивая в «Программы»**. Это требование не про подпись, а про офлайн-vendor, который
лежит в образе рядом с приложением ([MAC-BUILD.md](MAC-BUILD.md)).
