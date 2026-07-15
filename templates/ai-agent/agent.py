"""
Минимальный AI-агент: консольный чат с языковой моделью (LLM).

Как это работает:
  - вы пишете вопрос в терминале;
  - скрипт отправляет его модели через API (формат OpenAI-совместимый,
    подходит для большинства провайдеров);
  - ответ печатается в консоль;
  - история диалога сохраняется, поэтому модель помнит контекст беседы.

Перед запуском:
  1. Скопируйте .env.example в .env
  2. Впишите свой API-ключ (и, если нужно, адрес API) — см. README.md
  3. Установите зависимости:  pip install -r requirements.txt
  4. Запустите:               python agent.py
"""

import os

from dotenv import load_dotenv
from openai import OpenAI

# Загружаем настройки из файла .env
load_dotenv()

# .env кладёт пустые строки (LLM_MODEL=), а не отсутствие ключа — поэтому `or`,
# иначе os.getenv вернул бы "" и дефолт/официальный API не применились бы.
API_KEY = (os.getenv("LLM_API_KEY") or "").strip()
BASE_URL = (os.getenv("LLM_BASE_URL") or "").strip() or None  # пусто = официальный API OpenAI
MODEL = (os.getenv("LLM_MODEL") or "").strip() or "gpt-4o-mini"

# Инструкция агенту: кто он и как отвечать.
# Поменяйте этот текст — и характер агента изменится.
SYSTEM_PROMPT = (
    "Ты — дружелюбный помощник. Отвечай кратко, понятно и по-русски. "
    "Если не знаешь ответа — честно скажи об этом."
)


def create_client() -> OpenAI:
    """Создаёт клиент для обращения к API модели."""
    if not API_KEY:
        raise SystemExit(
            "Не найден LLM_API_KEY.\n"
            "1) Скопируйте .env.example в .env\n"
            "2) Впишите ваш API-ключ в строку LLM_API_KEY=\n"
            "Подробности — в README.md"
        )
    # base_url указываем только если он задан в .env
    if BASE_URL:
        return OpenAI(api_key=API_KEY, base_url=BASE_URL)
    return OpenAI(api_key=API_KEY)


def ask(client: OpenAI, history: list[dict]) -> str:
    """Отправляет историю диалога модели и возвращает её ответ."""
    response = client.chat.completions.create(
        model=MODEL,
        messages=history,
    )
    return response.choices[0].message.content


def main() -> None:
    client = create_client()

    # История диалога. Первое сообщение — системная инструкция.
    history: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

    print("AI-агент запущен. Модель:", MODEL)
    print("Пишите вопрос и жмите Enter. Выход: пустая строка или Ctrl+C.\n")

    while True:
        try:
            question = input("Вы: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nПока!")
            break

        if not question:
            print("Пока!")
            break

        # Добавляем вопрос пользователя в историю
        history.append({"role": "user", "content": question})

        try:
            answer = ask(client, history)
        except Exception as error:  # показываем ошибку человеку, а не трейсбек
            print(f"\nОшибка запроса к модели: {error}")
            print("Проверьте ключ и адрес API в файле .env\n")
            history.pop()  # убираем вопрос, оставшийся без ответа
            continue

        # Добавляем ответ модели в историю, чтобы она помнила контекст
        history.append({"role": "assistant", "content": answer})

        print(f"\nАгент: {answer}\n")


if __name__ == "__main__":
    main()
