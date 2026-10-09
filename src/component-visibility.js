'use strict';

// Компоненты, которым для РАБОТЫ нужен адрес сервиса из config.json (components.json →
// `needsConfig`, путь через точку, например «bridge.enrollEndpoint»).
//
// ЗАЧЕМ ПРЯТАТЬ. AI-мост просит права администратора, ставит прокси, PAC и автозапуск, а
// адреса enroll-сервиса в сборке нет: мост встаёт и простаивает у всех. Предупреждения на
// карточке оказалось мало — люди ставили его, путали с VPN и шли к боту с «нет
// сервера/токена». Поэтому компонент с флагом `hideWhileUnconfigured` в выбор не попадает,
// пока адрес пуст. Исключение — тот, у кого мост УЖЕ стоит от нашего установщика
// (квитанция): на его карточке живут «уже установлено» и «Удалить», и прятать её значило
// бы отнять у человека кнопку удаления. Впишут адрес в config.json — компонент вернётся
// сам, править код не нужно.
//
// Чистый модуль без electron: main.js подставляет конфиг и проверку квитанции, тесты —
// свои значения.

// Значение по пути «a.b.c» в объекте конфига; нет пути — undefined.
function configValueByPath(cfg, dotted) {
  return String(dotted || '').split('.').reduce(
    (obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined),
    cfg || {}
  );
}

// Та же семантика, что componentUnconfigured в renderer/app.js: пустая строка, одни
// пробелы, пустой массив и несуществующий путь — «не настроен» (fail-closed).
function isUnconfigured(comp, cfg) {
  if (!comp || !comp.needsConfig) return false;
  const v = configValueByPath(cfg, comp.needsConfig);
  if (Array.isArray(v)) return v.length === 0;
  return String(v == null ? '' : v).trim() === '';
}

// true — компонент в выбор НЕ отдаём и запускать не даём. hasReceipt(id) — ставил ли его
// этот установщик раньше (тогда карточку оставляем ради «Удалить»).
function hiddenWhileUnconfigured(comp, cfg, hasReceipt) {
  if (!comp || comp.hideWhileUnconfigured !== true) return false;
  if (!isUnconfigured(comp, cfg)) return false;
  let installed = false;
  try { installed = typeof hasReceipt === 'function' && !!hasReceipt(comp.id); } catch (e) { installed = false; }
  return !installed;
}

module.exports = { configValueByPath, isUnconfigured, hiddenWhileUnconfigured };
