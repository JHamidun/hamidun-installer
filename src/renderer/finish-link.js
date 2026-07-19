/* Финишный deep-link в бота-спутника — pure-логика, шарится между renderer
   (window.HMFinishLink) и тестами (require). UMD-обёртка — как у deps.js.
   Формат payload (Telegram /start: только [A-Za-z0-9_-], ≤64 символов):
     всё ок              → installed_win | installed_mac
     есть упавшие компы  → failed_<первый-упавший-id>_win | _mac  (напр. failed_cursor_win)
   Платформенный суффикс НЕ обрезается: клампится сам id. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HMFinishLink = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var MAX_PAYLOAD = 64; // лимит Telegram на параметр start

  // Telegram принимает в start только A-Za-z0-9_- — всё прочее гасим в '-'.
  function sanitizeId(id) {
    return String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '-');
  }

  // failed: массив id упавших компонентов (порядок прогона); isWin: платформа;
  // okBase: база успешного payload (config.finish.botStartPayload, деф. 'installed').
  function botStartPayload(failed, isWin, okBase) {
    var plat = isWin ? 'win' : 'mac';
    var suffix = '_' + plat;
    var list = Array.isArray(failed) ? failed.filter(Boolean) : [];
    if (!list.length) {
      // Клампим базу, суффикс дописываем ПОСЛЕ — платформа никогда не срезается.
      var base = sanitizeId(okBase || 'installed').slice(0, Math.max(1, MAX_PAYLOAD - suffix.length));
      return base + suffix;
    }
    var prefix = 'failed_';
    var room = Math.max(1, MAX_PAYLOAD - prefix.length - suffix.length);
    return prefix + sanitizeId(list[0]).slice(0, room) + suffix;
  }

  function botUrl(botBase, payload) {
    if (!botBase || !payload) return '';
    return botBase + '?start=' + encodeURIComponent(payload);
  }

  // Подпись заметной кнопки на финише: при ошибках зовём разбираться.
  function botButtonLabel(failed) {
    return (Array.isArray(failed) && failed.length)
      ? 'Бот-помощник: разобраться с ошибкой'
      : 'Бот-помощник: что дальше?';
  }

  return { botStartPayload: botStartPayload, botUrl: botUrl, botButtonLabel: botButtonLabel };
});
