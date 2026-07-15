"""
Минимальный Telegram-бот на aiogram 3.

Что умеет:
  /start — приветствие
  /help  — краткая справка
  любое другое сообщение — повторяет его обратно (эхо)

Перед запуском:
  1. Скопируйте .env.example в .env
  2. Впишите в .env токен вашего бота (см. README.md)
  3. Установите зависимости:  pip install -r requirements.txt
  4. Запустите:               python bot.py
"""

import asyncio
import logging
import os

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
from aiogram.types import Message
from aiogram.utils.token import TokenValidationError
from dotenv import load_dotenv

# Загружаем переменные окружения из файла .env
load_dotenv()

BOT_TOKEN = (os.getenv("BOT_TOKEN") or "").strip()

# Диспетчер принимает входящие сообщения и раздаёт их обработчикам
dp = Dispatcher()


@dp.message(CommandStart())
async def cmd_start(message: Message) -> None:
    """Ответ на команду /start."""
    await message.answer(
        "Привет! Я учебный бот-заготовка.\n\n"
        "Отправь мне любое сообщение — я повторю его.\n"
        "Команда /help — справка."
    )


@dp.message(Command("help"))
async def cmd_help(message: Message) -> None:
    """Ответ на команду /help."""
    await message.answer(
        "Я умею:\n"
        "• /start — приветствие\n"
        "• /help — эта справка\n"
        "• эхо — повторяю любой текст\n\n"
        "Это стартовый шаблон: открой bot.py и добавь свои команды."
    )


@dp.message(F.text)
async def echo(message: Message) -> None:
    """Эхо: повторяем текст пользователя."""
    await message.answer(f"Ты написал: {message.text}")


@dp.message()
async def not_text(message: Message) -> None:
    """Всё, что не текст (фото, стикеры и т.п.)."""
    await message.answer("Пока я понимаю только текст. Отправь мне сообщение словами.")


async def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit(
            "Не найден BOT_TOKEN.\n"
            "1) Скопируйте .env.example в .env\n"
            "2) Впишите токен от @BotFather в строку BOT_TOKEN=\n"
            "Подробности — в README.md"
        )

    logging.basicConfig(level=logging.INFO)
    # Кривой/лишний-пробельный токен aiogram отвергает — покажем понятную подсказку,
    # а не сырой TokenValidationError с трейсбеком.
    try:
        bot = Bot(token=BOT_TOKEN)
    except TokenValidationError:
        raise SystemExit(
            "Токен бота выглядит неправильно.\n"
            "Проверьте BOT_TOKEN в .env — он должен быть вида <цифры>:<буквы_и_цифры>,\n"
            "скопированным от @BotFather целиком, без лишних пробелов и кавычек."
        )

    print("Бот запущен. Остановить: Ctrl+C")
    # Long polling: бот сам опрашивает Telegram о новых сообщениях
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
