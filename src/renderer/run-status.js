/* Итог прогона установки — pure-логика, шарится между renderer (window.HMRunStatus)
   и тестами (require). UMD-обёртка — как у deps.js и finish-link.js.

   ЗАЧЕМ. До 06.10.2026 у установщика было два цвета: «встало» и «упало», и любой
   красный пункт делал весь прогон ok=False. Отсюда три беды из живых диалогов:
     • необязательный Cursor (или ChatGPT Desktop, Handy, скрепка) не встал — и вся
       установка рапортовала провал, хотя Claude Code и редактор работали;
     • редактор встал, а необязательная панель — нет: человек видел красный «VS Code»
       и решал, что не установилось ничего;
     • отчёт уходил с ok=False БЕЗ названного компонента (так было в пяти реальных
       отчётах): проверка после установки нашла проблему, а список упавших был пуст.
   Теперь правила одни для экрана и для отчёта, и лежат здесь, где их видно тесту. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HMRunStatus = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Ярлык строки «CHECK fail <ярлык>» из verify → id компонента. Ярлыки печатают
  // scripts/windows/verify.ps1 и scripts/macos/verify.sh (одинаковые на обеих ОС).
  var CHECK_LABEL_TO_ID = {
    'Git': 'git',
    'Node': 'node',
    'Claude CLI': 'claude',
    // Второй факт про Claude Code (только Windows): в cmd claude отвечает, а в PowerShell —
    // терминале VS Code по умолчанию — нет. verify.ps1 печатает эту строку только при
    // доказанной беде (claude.ps1: вердикт claude-ps = blocked или broken). Компонент тот же,
    // «claude»: красная строка называет его в отчёте, хотя сам Claude Code установлен.
    'Запуск claude в PowerShell': 'claude',
    'Конфиг': 'config',
    'Python-пакеты': 'pydeps',
    'Расширение': 'extension'
  };

  // Что значит красная строка и что делать — для ярлыков, которые сами этого не говорят.
  // short едет в отчёт боту (приёмник режет ошибку до 300 символов, а префикс «проверка
  // после установки не прошла: <ярлык> — » съедает около 65, поэтому short держим коротким),
  // hint — человеку под красной строкой на финише. «Git» или «Конфиг» понятны и так.
  //
  // Совета «разреши скрипты командой Set-ExecutionPolicy» здесь НЕТ намеренно: claude.ps1
  // сам пробует выставить CurrentUser = RemoteSigned, а красная строка появляется, только
  // когда этого сделать нельзя или нельзя нам (групповая политика, AllSigned, запись не
  // удалась) либо дело не в политике вовсе (PowerShell не ответил на --version). Повторять
  // ту же команду руками в таких случаях — отправлять человека по кругу.
  var CHECK_FAIL_WHY = {
    'Запуск claude в PowerShell': {
      short: 'в PowerShell claude не запускается (чаще всего политика выполнения скриптов); ' +
        'обход — claude.cmd или терминал «Command Prompt»',
      hint: 'Claude Code установлен, но в PowerShell (терминал VS Code по умолчанию) команда claude ' +
        'не запускается: чаще всего её не пускает политика выполнения скриптов. Набирай claude.cmd ' +
        'вместо claude или переключи терминал VS Code на «Command Prompt».'
    }
  };

  // Необязательный = основной путь (Claude Code в редакторе) работает и без него.
  // Объявляется ДАННЫМИ: components.json → "optional": true. Строго === true: опечатка
  // в поле не должна молча превращать обязательный компонент в «можно не ставить».
  function isOptional(comp) { return !!(comp && comp.optional === true); }

  function uniq(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (x) {
      if (x && out.indexOf(x) === -1) out.push(x);
    });
    return out;
  }

  // Ярлык проверки без уточнения в скобках: «Claude CLI (установлен, …)» → «Claude CLI».
  function checkBase(label) {
    var s = String(label == null ? '' : label);
    var m = s.match(/^([^(]+)\(/);
    return (m ? m[1] : s).trim();
  }

  // Пояснение к красной строке чеклиста или null, если ярлык говорит сам за себя.
  function checkFailWhy(label) {
    var base = checkBase(label);
    return Object.prototype.hasOwnProperty.call(CHECK_FAIL_WHY, base) ? CHECK_FAIL_WHY[base] : null;
  }

  // Красные строки чеклиста → id компонентов. Неизвестный ярлык не теряется: он
  // приписывается шагу «verify», чтобы ok=False ВСЕГДА называл хоть что-то.
  function failedCheckIds(checks) {
    var ids = [];
    (Array.isArray(checks) ? checks : []).forEach(function (c) {
      if (!c) return;
      var st = c.status || (c.ok ? 'ok' : 'fail');
      if (st !== 'fail') return;
      var id = CHECK_LABEL_TO_ID[checkBase(c.label)] || 'verify';
      if (ids.indexOf(id) === -1) ids.push(id);
    });
    return ids;
  }

  // Объяснение частичного успеха (код 121) для экрана и отчёта. Признак и текст
  // отдаёт main: res.partial и res.partialReason — строка скрипта «ЧАСТИЧНО: …» без
  // префикса. Текст пустой (скрипт строку не напечатал или main её не нашёл) — честная
  // общая фраза: молчать нельзя, а выдумывать конкретную причину за скрипт — тоже.
  var PARTIAL_FALLBACK = 'необязательная часть не встала (подробности — в журнале)';
  // Предел — страховка, а не обычный случай: скрипт печатает «ЧАСТИЧНО:» не длиннее 240
  // символов, и недостающее называет ПЕРВЫМ. Если строка всё же длиннее, режем С КОНЦА
  // (начало — самое важное) и показываем обрыв многоточием: молча оборванная фраза
  // выглядит законченной. Вместе с «…» выходит ровно PARTIAL_MAX.
  var PARTIAL_MAX = 240;
  function partialText(reason) {
    var s = String(reason == null ? '' : reason)
      .replace(/^\s*ЧАСТИЧНО\s*:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return PARTIAL_FALLBACK;
    return s.length > PARTIAL_MAX ? s.slice(0, PARTIAL_MAX - 1).trim() + '…' : s;
  }

  function failedCheckLabels(checks) {
    var out = {};
    (Array.isArray(checks) ? checks : []).forEach(function (c) {
      if (!c) return;
      var st = c.status || (c.ok ? 'ok' : 'fail');
      if (st !== 'fail') return;
      var id = CHECK_LABEL_TO_ID[checkBase(c.label)] || 'verify';
      if (!out[id]) out[id] = checkBase(c.label);
    });
    return out;
  }

  /**
   * Итог прогона — ОДИН для экрана и для отчёта боту.
   *
   * @param {object} o
   * @param {string[]} o.failed      обязательные компоненты, которые не встали
   * @param {string[]} o.softFailed  необязательные, которые не встали
   * @param {string[]} o.depSkipped  пропущены из-за упавшей зависимости
   * @param {string[]} o.partial     встали частично (код 121)
   * @param {string[]} o.gracefulSkipped  осознанно пропущены (код 120 или кнопкой)
   * @param {object[]} o.checks      чеклист verify: {status|ok, label}
   * @param {object}   o.byId        id → компонент (для признака optional)
   * @param {object[]} o.errors      {id, stage, error} — причины из прогона
   * @param {object}   o.partialWhy  id → объяснение частичного успеха
   * @returns {{ok: boolean, failed: string[], skipped: string[], errors: object[],
   *            hardFailed: string[], hardDepSkipped: string[], checkFailedIds: string[]}}
   */
  function installReport(o) {
    o = o || {};
    var byId = o.byId || {};
    var opt = function (id) { return isOptional(byId[id]); };
    var failed = uniq(o.failed).filter(function (id) { return !opt(id); });
    // Защита от путаницы на входе: необязательный компонент, переданный в failed,
    // уходит в «мягкие» — ok из-за него не падает.
    var soft = uniq((o.softFailed || []).concat(uniq(o.failed).filter(opt)));
    var depSkipped = uniq(o.depSkipped);
    var hardDep = depSkipped.filter(function (id) { return !opt(id); });
    var checkIds = failedCheckIds(o.checks);
    var checkLabels = failedCheckLabels(o.checks);
    var ok = failed.length === 0 && hardDep.length === 0 && checkIds.length === 0;

    // В отчёт ok=False обязан ехать с названным компонентом. Порядок: упавшие,
    // потом пропущенные из-за них, потом то, на что пожаловалась проверка.
    var reportFailed = failed.slice();
    hardDep.forEach(function (id) { if (reportFailed.indexOf(id) === -1) reportFailed.push(id); });
    checkIds.forEach(function (id) { if (reportFailed.indexOf(id) === -1) reportFailed.push(id); });
    if (!ok && !reportFailed.length) reportFailed.push('verify');

    // «Не установлено, но это не провал»: осознанные пропуски и необязательные.
    var skipped = uniq((o.gracefulSkipped || []).concat(soft));

    var errors = [];
    var seen = {};
    (Array.isArray(o.errors) ? o.errors : []).forEach(function (e) {
      if (!e || !e.id || seen[e.id]) return;
      seen[e.id] = true;
      var copy = { id: e.id, stage: e.stage || 'fail', error: String(e.error || '') };
      // Необязательный компонент: причина остаётся (её стадия — net/fail/…), но
      // помечена, чтобы бот не принял её за поломку установки.
      if (opt(e.id) && copy.error.indexOf('(необязательный)') !== 0) copy.error = '(необязательный) ' + copy.error;
      errors.push(copy);
    });
    checkIds.forEach(function (id) {
      if (seen[id]) return;
      seen[id] = true;
      var why = checkFailWhy(checkLabels[id]);
      errors.push({ id: id, stage: 'verify',
        error: 'проверка после установки не прошла: ' + (checkLabels[id] || id) + (why ? ' — ' + why.short : '') });
    });
    var pw = o.partialWhy || {};
    uniq(o.partial).forEach(function (id) {
      if (seen[id]) return;
      seen[id] = true;
      errors.push({ id: id, stage: 'partial', error: 'ЧАСТИЧНО: ' + partialText(pw[id]) });
    });
    // Приёмник принимает не больше десяти записей; важное — первым (упавшие идут раньше).
    errors.sort(function (a, b) {
      var rank = function (e) { return reportFailed.indexOf(e.id) !== -1 ? 0 : 1; };
      return rank(a) - rank(b);
    });

    return {
      ok: ok,
      failed: reportFailed,
      skipped: skipped,
      errors: errors.slice(0, 10),
      hardFailed: failed,
      hardDepSkipped: hardDep,
      checkFailedIds: checkIds
    };
  }

  return {
    CHECK_LABEL_TO_ID: CHECK_LABEL_TO_ID,
    isOptional: isOptional,
    failedCheckIds: failedCheckIds,
    checkFailWhy: checkFailWhy,
    partialText: partialText,
    installReport: installReport
  };
});
