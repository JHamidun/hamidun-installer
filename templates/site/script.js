// ============================================
// Стартовый скрипт лендинга.
// Здесь три маленькие функции — можно смело
// менять и дописывать свои.
// ============================================

// 1. Актуальный год в подвале
document.getElementById("year").textContent = new Date().getFullYear();

// 2. Мобильное меню (кнопка-бургер)
const navToggle = document.getElementById("navToggle");
const navLinks = document.getElementById("navLinks");

navToggle.addEventListener("click", () => {
  navLinks.classList.toggle("open");
});

// Закрываем меню после клика по ссылке
navLinks.addEventListener("click", (event) => {
  if (event.target.tagName === "A") {
    navLinks.classList.remove("open");
  }
});

// 3. Форма-заглушка: пока никуда не отправляет,
//    просто показывает сообщение. Подключение
//    реальной отправки — отличная первая задача
//    для Claude Code или Cursor.
const form = document.getElementById("contactForm");
const formStatus = document.getElementById("formStatus");

form.addEventListener("submit", (event) => {
  event.preventDefault(); // отменяем перезагрузку страницы

  const name = form.elements.name.value.trim();
  formStatus.textContent = `Спасибо, ${name}! Форма пока в режиме заглушки — данные никуда не отправлены.`;
  form.reset();
});
