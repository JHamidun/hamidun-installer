'use strict';

const CHECK_SVG =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let STATE = {
  platform: 'win32',
  homedir: '',
  config: {},
  groups: [],
  byId: {},        // id -> component
  selected: {},    // id -> bool
  // Опции компонента — галочки ВНУТРИ карточки ("<id компонента>.<id опции>" -> bool).
  // Объявляются в components.json полем options[]; значение по умолчанию — options[].default.
  // Едут в install-скрипт отдельным env-ключом (см. envForRun), и только пока сам
  // компонент выбран: снятая карточка не должна ничего разрешать за человека.
  options: {},
  logPath: '',     // ~/.hamidun-setup/install.log (из bootstrap)
  freeGB: null,    // свободное место на диске в ГБ (preflight, из bootstrap)
  checks: [],      // результаты "CHECK ok/fail/skip <ярлык>" от компонента verify
  resourcesRoot: '', // абсолютный путь к ресурсам (для оффлайн START-HERE)
  userWarning: '',   // предупреждение, если установщик запущен под другим пользователем
  detected: {},      // id -> {installed, detectedVersion, installedVersion, currentVersion, updateAvailable, receipted}
  repair: {},        // id -> bool: переустановить начисто (форс — отключает аддитивность)
  repairConfirmed: {}, // id -> bool: перезапись ~/.claude ОТДЕЛЬНО подтверждена диалогом (P0-1)
  detectDone: false,   // P0-1: кнопка установки выключена, пока детекция не завершилась
  edition: 'offline',  // 'lite' = стриминг-издание (докачка с S3); из bootstrap (main решает)
  remoteSizes: {},     // componentId -> ТОЧНЫЙ sizeBytes докачки (реестр; НЕ рукописный sizeHint)
  netProbeDone: true,  // lite: false, пока main пробует сервер докачки (гейт «Установить»)
  netOnline: true,     // lite: false = сервер докачки недоступен (жёлтый баннер + «Проверить снова»)
  runActive: false,    // идёт прогон установки (гейт inline-кнопок «Повторить» на шагах)
  // id → {id, stage, error}: почему компонент не встал. Едет в телеметрию, чтобы бот
  // мог сказать «упало на шаге X, причина Y», а не «что-то не получилось». Кумулятивная
  // (как badEver): inline-«Повторить» одного шага не должен стирать картину остальных.
  errorDigest: new Map(),
};

// Компоненты, которые деинсталлятор умеет безопасно удалить целиком (самодостаточные
// артефакты вне ~/.claude). Для остального «Удалить» в UI не показываем.
// v1: Nomad ИСКЛЮЧЁН из авто-удаления (TOCTOU/data-loss риск в сносе venv/шимов —
// Codex P0). Nomad по-прежнему СТАВИТСЯ, но кнопку «Удалить» для него не показываем
// и удаление не выполняем. Полноценный Nomad-uninstall вернём позже отдельной фазой.
const REMOVABLE = new Set(['course', 'uv', 'mascot', 'bridge']);

// A18: Обязательные базовые шаги — при их провале конвейер установки немедленно останавливается,
// а оставшиеся шаги помечаются как пропущенные из-за базовой зависимости.
const MANDATORY_BASE_IDS = new Set(['git', 'node', 'claude']);

// B11: Набор компонентов пресета «Минимум (только Claude Code + конфиг)».
const MINIMAL_PRESET_IDS = new Set(['git', 'node', 'claude', 'config']);

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Хэндл бота-спутника из конфига (links.bot = https://t.me/<handle>) — ЕДИНЫЙ источник,
// без хардкода «@vibecodeguidebot» по коду. Пустой конфиг → нейтральный фолбэк.
function botHandle() {
  const bot = (STATE.config && STATE.config.links && STATE.config.links.bot) || '';
  const m = String(bot).match(/t\.me\/([A-Za-z0-9_]+)/i);
  return m ? '@' + m[1] : 'бота-помощника';
}

async function init() {
  // Крошку прошлой попытки самолечения читаем БЕЗУСЛОВНО при старте: иначе она
  // лежит на диске до первого заблокированного запуска и всплывает как свежая.
  try { await loadPrevSelfHealFailure(); } catch (e) { /* диагностика необязательна */ }
  const boot = await window.installer.bootstrap();
  STATE.platform = boot.platform;
  STATE.homedir = boot.homedir;
  STATE.config = boot.config || {};
  STATE.logPath = boot.logPath || '';
  STATE.freeGB = (typeof boot.freeGB === 'number') ? boot.freeGB : null;
  STATE.homeRoot = boot.homeRoot || '';   // «C:\» — на каком томе меряли место
  STATE.resourcesRoot = boot.resourcesRoot || '';
  STATE.userWarning = boot.userWarning || '';
  STATE.vendorAvailable = boot.vendorAvailable !== false;
  STATE.vendorBlock = boot.vendorBlock || { blocked: false };
  STATE.vendorBlocked = !!STATE.vendorBlock.blocked;
  // Лёгкое (стриминг) издание + превью размеров докачки — авторитетно из main.
  STATE.edition = boot.edition === 'lite' ? 'lite' : 'offline';
  STATE.remoteSizes = boot.remoteSizes || {};
  // PREFLIGHT LITE: до завершения probe-remote «Установить» не активируем.
  STATE.netProbeDone = STATE.edition !== 'lite';
  STATE.groups = (boot.components && boot.components.groups) || [];
  STATE.packsData = boot.packs || { core: [], packs: [] };
  STATE.selectedPacks = {};
  STATE.selectedSkills = {};  // имя скилла -> bool; по умолчанию включены все
  STATE.expandedPack = null;  // id пака с раскрытой панелью выбора скиллов
  STATE.packsData.packs.forEach((p) => {
    STATE.selectedPacks[p.id] = true;
    (p.skills || []).forEach((s) => (STATE.selectedSkills[s] = true));
  });

  STATE.groups.forEach((g) =>
    g.components.forEach((c) => {
      STATE.byId[c.id] = c;
      STATE.selected[c.id] = !!c.default;
      // Галочки внутри карточки. Значение ВСЕГДА инициализируем явно, чтобы optionOn()
      // мог сравнивать строго (=== true) и «нет ключа» никогда не читалось как «включено».
      (c.options || []).forEach((o) => { STATE.options[optKey(c.id, o.id)] = o.default === true; });
    })
  );

  // Хэндл бота на приветственном экране — из конфига (без хардкода в статике).
  const wcBot = $('#wc-bot-handle');
  if (wcBot) wcBot.textContent = botHandle();
  renderGroups();
  renderPacks();
  renderPreflight();
  // userWarning считается в main асинхронно (tasklist на Windows медленный) — не блокируем
  // первую отрисовку: дорисуем баннер, когда детект вернётся.
  if (window.installer.detectUserWarning) {
    window.installer.detectUserWarning()
      .then((w) => { STATE.userWarning = w || ''; renderUserWarning(); })
      .catch(() => {});
  } else {
    renderUserWarning();
  }
  renderVendorBlock();
  renderProgressBotBanner();
  refreshDerived();
  // Приветственный экран показываем ПЕРВЫМ — но только после renderVendorBlock,
  // чтобы стоп-экран App-Translocation имел приоритет (STATE.vendorBlocked уже выставлен).
  showInitialScreen();

  $('#btn-install').addEventListener('click', startInstall);
  const repairBtn = $('#btn-repair');
  if (repairBtn) repairBtn.addEventListener('click', () => startInstall({ repair: true }));
  const presetFullBtn = $('#preset-full');
  if (presetFullBtn) presetFullBtn.addEventListener('click', () => applyPreset('full'));
  const presetMinBtn = $('#preset-minimal');
  if (presetMinBtn) presetMinBtn.addEventListener('click', () => applyPreset('minimal'));
  const uninstallAllBtn = $('#btn-uninstall-all');
  if (uninstallAllBtn) uninstallAllBtn.addEventListener('click', openUninstallAllModal);
  const uninstallAllCancel = $('#uninstall-all-cancel');
  if (uninstallAllCancel) uninstallAllCancel.addEventListener('click', closeUninstallAllModal);
  const uninstallAllConfirm = $('#uninstall-all-confirm');
  if (uninstallAllConfirm) uninstallAllConfirm.addEventListener('click', runUninstallAll);
  const uninstallAllModal = $('#uninstall-all-modal');
  if (uninstallAllModal) {
    uninstallAllModal.addEventListener('click', (e) => {
      if (e.target === uninstallAllModal) closeUninstallAllModal();
    });
  }
  $('#btn-welcome-go').addEventListener('click', goToSelect);
  const wcWhatBtn = $('#btn-wc-what');
  if (wcWhatBtn) wcWhatBtn.addEventListener('click', showWhatInstalls);
  const whatBtn = $('#btn-what-installs');
  if (whatBtn) {
    // Подпись должна быть верна для КАЖДОГО издания: офлайн-установщик не качает
    // НИЧЕГО — всё уже внутри файла, который человек скачал. Старое «Что скачается
    // на мой ПК?» в офлайне обещало несуществующую загрузку.
    whatBtn.textContent = STATE.edition === 'lite' ? '📦 Что скачается на мой ПК?' : '📦 Что попадёт на мой ПК?';
    whatBtn.addEventListener('click', showWhatInstalls);
  }
  // «Что будет дальше?» — встроенный просмотр памятки в окне установщика;
  // внешний браузер — только по явной соседней кнопке (у части людей дефолтный
  // браузер «холодный» и его онбординг пугает сильнее самой памятки).
  const nextBtn = $('#btn-what-next');
  if (nextBtn) nextBtn.addEventListener('click', () => showStartHereInline());
  const nextExtBtn = $('#btn-what-next-ext');
  if (nextExtBtn) nextExtBtn.addEventListener('click', () => openStartHereMemo());
  $('#btn-finish').addEventListener('click', async () => {
    const auto = $('#ns-autovscode');
    if (auto && auto.checked) {
      let r = false;
      try { r = await window.installer.launchVsCode(); } catch (_) {}
      // true = поднялся редактор; 'explorer'/'finder' = открылась только папка;
      // false = не открылось ничего. Считать успехом любое truthy нельзя: тогда за
      // «дошёл до редактора» засчитывалось открытие Проводника.
      if (r === true) sendOpenEditorTelemetry();
      // #7: не закрываемся МОЛЧА, если редактор не открылся (нет в сборке / не встал) —
      // иначе установщик исчезает, а новичок остаётся на пустом рабочем столе.
      if (r !== true) {
        const cta = $('#ns-vscode');
        // Клик по CTA работает, только пока она включена. Когда редактора нет, она
        // намеренно disabled — и клик не доставляется: раньше на этом всё и обрывалось.
        if (cta && !cta.disabled) { cta.click(); return; }
        showEditorHint(r === 'explorer' || r === 'finder'
          ? 'Открылась папка с файлами, а не редактор — запустить его не удалось. Открой редактор сам и выбери в нём эту папку.'
          : 'Редактор не открылся — похоже, он не установлен. Запусти установщик ещё раз с компонентом «VS Code» либо спроси бота-помощника.');
        return;
      }
    }
    window.installer.quit();
  });
  $('#packs-all').addEventListener('click', () => setAllPacks(true));
  $('#packs-none').addEventListener('click', () => setAllPacks(false));
  // Сторож молчания из main: «шаг молчит N мин» → кнопка «Пропустить шаг» у
  // необязательного шага; «ожил» → кнопку убрать.
  if (window.installer.onStepStall) window.installer.onStepStall(onStepStall);
  setupMascots();
  // Детекция состояния — best-effort, после первичного рендера (не блокирует UI).
  detectAndApply();
  // PREFLIGHT LITE: пробуем сервер докачки (через main-IPC — CSP запрещает сеть
  // renderer'у). Нет сети → жёлтый баннер + «Проверить снова» (мягче vendorBlock).
  runNetProbe();
}

// PREFLIGHT LITE: доступность сервера докачки ДО активации «Установить». Сеть
// пробует ТОЛЬКО main (probe-remote); сбой самого IPC — fail-open (не запираем
// установку по ошибке пробы), честный offline от main → баннер runNetProbe→
// renderLiteNetBanner. В офлайн-издании — no-op (качать нечего).
async function runNetProbe() {
  if (STATE.edition !== 'lite' || !window.installer.probeRemote) {
    STATE.netProbeDone = true;
    refreshDerived();
    return;
  }
  STATE.netProbeDone = false;
  refreshDerived();
  let online = true;
  try {
    const r = await window.installer.probeRemote();
    online = !(r && r.online === false);
  } catch (e) { online = true; } // fail-open: ошибка пробы ≠ «сети нет»
  STATE.netOnline = online;
  STATE.netProbeDone = true;
  renderLiteNetBanner();
  refreshDerived();
}

// Жёлтый баннер лёгкой версии: сервер докачки недоступен. НЕ жёсткий стоп (в
// отличие от mac-vendorBlock): установку не запираем, но честно предупреждаем и
// даём «Проверить снова». Перерисовывается на каждый вызов (сброс кнопки).
function renderLiteNetBanner() {
  const existing = document.getElementById('lite-net-warn');
  if (existing) existing.remove();
  if (STATE.netOnline) return;
  const el = document.createElement('div');
  el.id = 'lite-net-warn';
  el.className = 'preflight-warn';
  el.innerHTML = '⚠️ Лёгкой версии нужен интернет для скачивания компонентов, а сервер загрузки ' +
    'сейчас недоступен. Проверь подключение (Wi-Fi/кабель, VPN может мешать) и нажми ' +
    '«Проверить снова» — иначе установка оборвётся на докачке. ' +
    '<button type="button" id="lite-net-retry" class="btn-sm">Проверить снова</button>';
  const hero = document.querySelector('#view-select .hero');
  if (hero) hero.insertAdjacentElement('afterend', el);
  const rb = document.getElementById('lite-net-retry');
  if (rb) rb.addEventListener('click', () => {
    rb.disabled = true;
    rb.textContent = 'Проверяю…';
    runNetProbe();
  });
}

// Определяем, что УЖЕ установлено (грунд-труть из main), помечаем «уже установлено» и
// по умолчанию СНИМАЕМ галку: аддитивно ставим только НЕДОСТАЮЩЕЕ. Пользователь может
// вручную включить компонент для доустановки/обновления, или «Переустановить начисто».
async function detectAndApply() {
  // P0-1: до завершения детекции кнопка установки выключена (refreshDerived смотрит
  // на detectDone). При сбое детекции кнопку всё равно включаем: режим конфига
  // авторитетно решает MAIN живой детекцией (fail-safe → additive), а не renderer.
  try {
    let r;
    try { r = await window.installer.detectState(); }
    catch (e) { return; } // детекция best-effort — не ломаем установку
    if (!r || !r.ok) return;
    STATE.detected = r.state || {};
    STATE.manifestPath = r.manifestPath || '';
    // pathReadOk===false → системный PATH прочитать не удалось (EDR/политика
    // заблокировали powershell.exe и т.п.), и «не установлено» ниже может быть
    // ложным. Честно предупреждаем, а не молча предлагаем переустановить рабочее.
    STATE.pathReadFailed = (r.pathReadOk === false);
    Object.keys(STATE.detected).forEach((id) => {
      const c = STATE.byId[id];
      if (STATE.detected[id].installed && c && !c.hidden && !STATE.repair[id]) {
        STATE.selected[id] = false; // установленное по умолчанию не переустанавливаем
      }
    });
    renderGroups();
    renderInstalledBanner();
    renderPathReadWarning();
  } finally {
    STATE.detectDone = true;
    refreshDerived();
  }
}

// Жёлтый баннер: обнаружены установленные компоненты — аддитивная доустановка.
function renderInstalledBanner() {
  const anyInstalled = Object.keys(STATE.detected || {}).some(
    (id) => STATE.detected[id].installed && STATE.byId[id] && !STATE.byId[id].hidden
  );
  const existing = document.getElementById('installed-banner');
  if (!anyInstalled) { if (existing) existing.remove(); return; }
  if (existing) return;
  const el = document.createElement('div');
  el.id = 'installed-banner';
  el.className = 'preflight-warn';
  el.innerHTML = '✓ Часть компонентов уже установлена — они помечены «уже установлено» и по ' +
    'умолчанию сняты. Доустановка добавит только НЕДОСТАЮЩЕЕ и не затронет то, что уже стоит ' +
    '(твои скиллы и настройки в ~/.claude в безопасности). Чтобы поставить заново — включи ' +
    'компонент или нажми «Переустановить начисто».';
  const hero = document.querySelector('#view-select .hero');
  if (hero) hero.insertAdjacentElement('afterend', el);
}

// Красный баннер: системный PATH прочитать не удалось, детекция ненадёжна.
// Без него человек видел бы «не установлено» на реально установленных компонентах
// (EDR/политика заблокировали powershell.exe) и переустанавливал бы поверх рабочего.
function renderPathReadWarning() {
  const existing = document.getElementById('pathread-warn');
  if (!STATE.pathReadFailed) { if (existing) existing.remove(); return; }
  if (existing) return;
  const el = document.createElement('div');
  el.id = 'pathread-warn';
  el.className = 'preflight-warn';
  el.innerHTML = '⚠️ Не удалось прочитать системный PATH (возможно, антивирус или политика ' +
    'блокируют системные команды). Список ниже может ошибочно показывать уже установленные ' +
    'программы как отсутствующие — проверь по факту, прежде чем ставить их заново.';
  const hero = document.querySelector('#view-select .hero');
  if (hero) hero.insertAdjacentElement('afterend', el);
}

// Омлетон-«пасхалка»: клик по маскоту → прыжок + смена позы. Чисто визуально,
// на установку не влияет (finish/retry потом всё равно ставят свою позу).
function setupMascots() {
  const poses = ['watching', 'thinking', 'success', 'loading'];
  document.querySelectorAll('.mascot, .tips-mascot').forEach((img) => {
    img.style.cursor = 'pointer';
    if (!img.title) img.title = 'Омлетон';
    let i = poses.indexOf((img.getAttribute('src') || '').replace(/.*\/(\w+)\.webp/, '$1'));
    img.addEventListener('click', () => {
      img.classList.remove('jump'); void img.offsetWidth; img.classList.add('jump');
      i = (i + 1) % poses.length;
      img.src = 'mascot/' + poses[i] + '.webp';
    });
    img.addEventListener('animationend', () => img.classList.remove('jump'));
  });
}

// ---- screen navigation (welcome → select → progress) ---------------

// Какой экран показать при старте. Приветствие (view-welcome) — первым, ДО выбора
// компонентов. Исключение и приоритет: App-Translocation / оторванный офлайн-vendor
// (STATE.vendorBlocked, решает main). В этом случае приветствие пропускаем и сразу
// показываем экран выбора — поверх него renderVendorBlock уже поднял блокирующее
// окно-стоп («Установить» погашен), и бодрый welcome под ним был бы неуместен.
function showInitialScreen() {
  const welcome = $('#view-welcome');
  const select = $('#view-select');
  if (STATE.vendorBlocked) {
    if (welcome) welcome.classList.add('hidden');
    if (select) select.classList.remove('hidden');
    return;
  }
  if (welcome) welcome.classList.remove('hidden');
  if (select) select.classList.add('hidden');
}

// Кнопка «Поехали →» — переход с приветствия на экран выбора компонентов.
function goToSelect() {
  const welcome = $('#view-welcome');
  const select = $('#view-select');
  if (welcome) welcome.classList.add('hidden');
  if (select) select.classList.remove('hidden');
}

// ---- selection / dependency logic ----------------------------------

// Dependency resolution lives in deps.js (window.HMDeps) — shared with tests.
function enableWithDeps(id) { window.HMDeps.enableWithDeps(STATE.selected, STATE.byId, id); }
function disableDependents(id) { window.HMDeps.disableDependents(STATE.selected, STATE.byId, id); }

function toggle(id) {
  if (STATE.selected[id]) disableDependents(id);
  else enableWithDeps(id);
  renderGroups();
  syncPresetBar();
  refreshDerived();
}

// B11: Пресеты выбора комплектации («Полный комплект» / «Минимум»).
// «Минимум» оставляет только базовую цепочку Claude Code + конфиг (git, node, claude, config),
// учитывая уже установленные компоненты (если компонент уже стоит и не помечен на repair, не включаем).
function applyPreset(mode) {
  const isMin = mode === 'minimal';
  STATE.groups.forEach((g) => {
    (g.components || []).forEach((c) => {
      if (c.hidden) {
        STATE.selected[c.id] = !!c.default;
        return;
      }
      const det = STATE.detected && STATE.detected[c.id];
      const installed = !!(det && det.installed && !STATE.repair[c.id]);
      if (isMin) {
        STATE.selected[c.id] = MINIMAL_PRESET_IDS.has(c.id) && !installed;
      } else {
        STATE.selected[c.id] = !!c.default && !installed;
      }
    });
  });
  renderGroups();
  syncPresetBar();
  refreshDerived();
}

function syncPresetBar() {
  const fullBtn = $('#preset-full');
  const minBtn = $('#preset-minimal');
  if (!fullBtn || !minBtn) return;
  let matchesMin = true;
  let matchesFull = true;
  STATE.groups.forEach((g) => {
    (g.components || []).forEach((c) => {
      if (!c || c.hidden) return;
      const det = STATE.detected && STATE.detected[c.id];
      const installed = !!(det && det.installed && !STATE.repair[c.id]);
      const sel = !!STATE.selected[c.id];
      const wantMin = MINIMAL_PRESET_IDS.has(c.id) && !installed;
      const wantFull = !!c.default && !installed;
      if (sel !== wantMin) matchesMin = false;
      if (sel !== wantFull) matchesFull = false;
    });
  });
  minBtn.classList.toggle('active', matchesMin && !matchesFull);
  fullBtn.classList.toggle('active', matchesFull);
}

// ---- опции компонента (галочки внутри карточки) ----------------------

// Ключ состояния одной опции. Плоская карта, а не вложенный объект: её удобно
// целиком отдавать в тесты и невозможно случайно «потерять» при перерендере.
function optKey(compId, optId) { return String(compId) + '.' + String(optId); }

// Строго === true: опция считается включённой ТОЛЬКО если её явно включили
// (инициализацией из options[].default или кликом). Любое «значения нет» = выключена,
// потому что эти галочки разрешают действия от имени человека.
function optionOn(compId, optId) { return STATE.options[optKey(compId, optId)] === true; }

function selectedIds() {
  return Object.keys(STATE.selected).filter((id) => STATE.selected[id]);
}

// Topological order so deps install before dependents (logic in deps.js).
function installOrder() { return window.HMDeps.installOrder(STATE.selected, STATE.byId); }

// Компонент проверки "verify" (hidden, авто-включён) всегда идёт последним —
// он проверяет всё, что поставили остальные.
function ensureVerifyLast(ids) {
  if (ids.indexOf('verify') === -1) return ids;
  return ids.filter((id) => id !== 'verify').concat('verify');
}

// ---- rendering ------------------------------------------------------

function renderGroups() {
  const root = $('#groups');
  root.innerHTML = '';
  STATE.groups.forEach((g) => {
    // Скрытые (служебные) компоненты вроде "verify" не показываем в выборе,
    // но они остаются в STATE.byId/STATE.selected и участвуют в установке.
    const visible = g.components.filter((c) => !c.hidden);
    if (!visible.length) return;
    const gd = document.createElement('div');
    gd.className = 'group';
    gd.innerHTML = `<div class="group-title">${g.title}</div>`;
    visible.forEach((c) => gd.appendChild(renderCard(c)));
    root.appendChild(gd);
  });
  syncPresetBar();
}

// Компонент, которому для РАБОТЫ нужен адрес сервиса из config.json. Объявляется в
// components.json полем `needsConfig` — путь через точку («bridge.enrollEndpoint»), а
// текст предупреждения — соседним `needsConfigNote`.
//
// ЗАЧЕМ. AI-мост просит права администратора, ставит прокси, PAC и автозапуск, а без
// адреса сервера в config.json встаёт и простаивает. Пока адрес пуст, такой компонент
// из выбора убирает и запускать не даёт MAIN (components.json → `hideWhileUnconfigured`,
// src/component-visibility.js). До экрана доходит только мост, уже поставленный нашим
// установщиком (квитанция): на его карточке живут «уже установлено» и «Удалить». Для
// него карточка и говорит правду — бейдж «не настроен» и подпись ниже. Заполнил адрес в
// config.json — компонент вернулся в выбор, бейдж и подпись пропали сами.
function configValueByPath(pathStr) {
  return String(pathStr || '').split('.').reduce(
    (obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined),
    STATE.config || {}
  );
}

function componentUnconfigured(c) {
  if (!c || !c.needsConfig) return false;
  const v = configValueByPath(c.needsConfig);
  if (Array.isArray(v)) return v.length === 0;
  return String(v == null ? '' : v).trim() === '';
}

// Текст предупреждения. Фолбэк на случай, если `needsConfigNote` забыли: молчать
// нельзя — именно молчание и было дефектом.
function unconfiguredNoteText(c) {
  return (c && c.needsConfigNote) ||
    'Адрес сервиса для этого компонента в сборке не заполнен — он установится, но работать не начнёт.';
}

function renderCard(c) {
  const checked = STATE.selected[c.id];
  const det = (STATE.detected && STATE.detected[c.id]) || null;
  const installed = !!(det && det.installed);
  const updateAvail = !!(det && det.updateAvailable);
  const el = document.createElement('div');
  el.className = 'card' + (checked ? ' checked' : '') + (installed ? ' installed' : '');
  el.dataset.id = c.id;   // якорь для GUI-автотестов (test/e2e-gui.js); в UI не виден
  const reqNames = (c.requires || []).map((r) => STATE.byId[r] && STATE.byId[r].name).filter(Boolean);
  const okBadge = installed
    ? `<span class="badge ok">✓ уже установлено${det.detectedVersion ? ' · ' + escapeHtml(det.detectedVersion) : ''}</span>`
    : '';
  const updBadge = updateAvail ? `<span class="badge upd">обновление доступно</span>` : '';
  const recBadge = c.recommended ? `<span class="badge rec">рекомендуется</span>` : '';
  // Сервис для компонента в этой сборке не прописан — говорим об этом на самой карточке,
  // до выбора, а не в логе после того, как человек отдал права администратора.
  // Стили инлайновые (жёлтый, как у бейджа «админ») — новых классов в styles.css не заводим.
  const unconf = componentUnconfigured(c);
  const unconfBadge = unconf
    ? `<span class="badge" style="color:var(--h-yellow);border-color:rgba(245,213,71,.3)">не настроен</span>`
    : '';
  const unconfNote = unconf
    ? `<div class="card-desc" style="margin-top:4px;color:var(--h-yellow)">⚠ ${escapeHtml(unconfiguredNoteText(c))}</div>`
    : '';
  el.innerHTML = `
    <div class="checkbox">${CHECK_SVG}</div>
    <div class="card-body">
      <div class="card-name">
        ${c.name}
        ${recBadge}
        ${c.why ? `<span class="info" tabindex="0" role="button" aria-label="Что это?">?<span class="tip">${c.why || c.desc}</span></span>` : ''}
        ${sizeBadgeHtml(c)}
        ${c.online ? `<span class="badge online" title="Скачивается онлайн во время установки">онлайн</span>` : ''}
        ${c.needsAdmin ? `<span class="badge admin">админ</span>` : ''}
        ${unconfBadge}
        ${reqNames.length ? `<span class="badge dep">требует: ${reqNames.join(', ')}</span>` : ''}
        ${okBadge}
        ${updBadge}
      </div>
      <div class="card-desc">${c.desc}</div>
      ${c.brief ? `<div class="card-brief">${escapeHtml(c.brief)}</div>` : ''}
      ${unconfNote}
      ${checked ? renderComponentOptions(c) : ''}
      ${installed ? renderInstalledActions(c) : ''}
    </div>`;
  el.addEventListener('click', () => toggle(c.id));
  wireComponentOptions(el, c);
  if (installed) wireInstalledActions(el, c);
  // Клик по «?» показывает подсказку и НЕ должен переключать карточку.
  const info = el.querySelector('.info');
  if (info) {
    info.addEventListener('pointerdown', (e) => e.stopPropagation());
    info.addEventListener('click', (e) => e.stopPropagation());
    // У нижней кромки скролл-зоны пузырь снизу обрезается — переворачиваем вверх.
    const flip = () => {
      const sc = document.querySelector('#view-select .scroll');
      const bounds = sc ? sc.getBoundingClientRect() : { bottom: window.innerHeight };
      info.classList.toggle('tip-up', info.getBoundingClientRect().bottom + 150 > bounds.bottom);
    };
    info.addEventListener('mouseenter', flip);
    info.addEventListener('focus', flip);
  }
  return el;
}

// Галочки-опции внутри карточки (components.json → options[]). Показываем их ТОЛЬКО
// у выбранного компонента: у снятой карточки опция ничего не значит и лишь путает.
// Стили инлайновые — новых классов в styles.css эта фича не заводит.
function renderComponentOptions(c) {
  const opts = c.options || [];
  if (!opts.length) return '';
  return `<div class="comp-options" data-id="${escapeHtml(c.id)}">` + opts.map((o) => `
      <label style="display:flex;align-items:flex-start;gap:7px;margin-top:6px;font-size:12px;color:var(--text-muted);cursor:pointer">
        <input type="checkbox" data-opt="${escapeHtml(o.id)}" ${optionOn(c.id, o.id) ? 'checked' : ''}
               style="width:13px;height:13px;flex:0 0 auto;margin-top:2px;accent-color:var(--h-primary);cursor:pointer" />
        <span>${escapeHtml(o.label || o.id)}${o.hint ? `<br><span style="opacity:.8">${escapeHtml(o.hint)}</span>` : ''}</span>
      </label>`).join('') + '</div>';
}

// Клик по опции НЕ должен снимать саму карточку (иначе галочка «разрешить» выключала бы
// компонент). Состояние пишем без перерендера — чекбокс не теряет фокус.
function wireComponentOptions(el, c) {
  const row = el.querySelector('.comp-options');
  if (!row) return;
  ['pointerdown', 'click'].forEach((ev) => row.addEventListener(ev, (e) => e.stopPropagation()));
  row.querySelectorAll('input[data-opt]').forEach((cb) =>
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      STATE.options[optKey(c.id, cb.dataset.opt)] = cb.checked;
    })
  );
}

// Ряд действий для УЖЕ установленного компонента: доустановка (аддитивно, по умолчанию),
// «Переустановить начисто» (форс) и «Удалить» (для самодостаточных артефактов).
function renderInstalledActions(c) {
  const isConfig = c.id === 'config';
  // P0-4: «Удалить» — ТОЛЬКО для компонентов с квитанцией установки (installer-owned),
  // а не для всего, что просто «обнаружено на диске» (могло быть поставлено не нами).
  const det = (STATE.detected && STATE.detected[c.id]) || null;
  const removable = REMOVABLE.has(c.id) && !!(det && det.receipted);
  const repairOn = !!STATE.repair[c.id];
  const note = isConfig
    ? `<div class="card-note">Доустановка добавит только НЕДОСТАЮЩЕЕ — твои скиллы и настройки в ~/.claude не тронет.</div>`
    : '';
  return `<div class="installed-actions" data-id="${escapeHtml(c.id)}">
      ${note}
      <button type="button" class="linkbtn act-repair${repairOn ? ' on' : ''}">${repairOn ? '✓ переустановить начисто' : 'Переустановить начисто'}</button>
      ${removable ? `<button type="button" class="linkbtn act-uninstall">Удалить</button>` : ''}
      <span class="installed-status"></span>
    </div>`;
}

function wireInstalledActions(el, c) {
  const row = el.querySelector('.installed-actions');
  if (!row) return;
  // Клики внутри ряда не должны переключать саму карточку.
  ['pointerdown', 'click'].forEach((ev) => row.addEventListener(ev, (e) => e.stopPropagation()));
  const rep = row.querySelector('.act-repair');
  if (rep) rep.addEventListener('click', (e) => {
    e.stopPropagation();
    const turningOn = !STATE.repair[c.id];
    // P0-1: перезапись ~/.claude свежей базой требует ЯВНОГО отдельного подтверждения.
    // Без него main всё равно не даст clean-install (авторитетная детекция + флаг).
    if (turningOn && c.id === 'config') {
      const yes = window.confirm(
        'Переустановить конфиг начисто?\n\n' +
        'Общая база ~/.claude будет перезаписана свежей версией. Перед началом будет сделана ' +
        'полная резервная копия ~/.claude, а ключи, память и история сессий будут сохранены ' +
        'и возвращены. Твои собственные скиллы и правки общих файлов при этом будут заменены ' +
        'свежей базой.\n\nПродолжить?');
      if (!yes) return;
      STATE.repairConfirmed[c.id] = true;
    }
    STATE.repair[c.id] = turningOn;
    if (!turningOn) STATE.repairConfirmed[c.id] = false;
    // «Переустановить начисто» = форс: выбираем компонент (и его зависимости) на установку.
    if (STATE.repair[c.id]) enableWithDeps(c.id);
    renderGroups();
    refreshDerived();
  });
  const un = row.querySelector('.act-uninstall');
  if (un) un.addEventListener('click', (e) => { e.stopPropagation(); uninstallComponent(c.id, row); });
}

// Деинсталляция одного компонента. Удаляет только артефакты установщика — данные
// пользователя (~/.claude/.credentials*, memory, projects, todos, скиллы) не трогаются.
async function uninstallComponent(id, row) {
  const name = (STATE.byId[id] && STATE.byId[id].name) || id;
  const status = row ? row.querySelector('.installed-status') : null;
  if (!window.confirm(`Удалить «${name}»?\n\nТвои данные и настройки (~/.claude, ключи, память, история) НЕ будут затронуты.`)) return;
  if (status) status.textContent = ' Удаляю…';
  let res;
  try { res = await window.installer.uninstallComponent(id, envForRun()); }
  catch (e) { res = { ok: false, error: String(e) }; }
  if (status) {
    if (res && res.ok) { status.textContent = ' Удалено ✓'; }
    else { status.textContent = ' Не удалось удалить' + ((res && res.error) ? ': ' + res.error : ''); }
  }
  STATE.repair[id] = false;
  STATE.selected[id] = false;
  await detectAndApply(); // пере-детекция: карточка обновит бейджи
}

// A27: «Удалить всё» — есть ли на машине установленные компоненты стека или квитанции.
function anyUninstallablePresent() {
  if (!STATE.detectDone) return false;
  return Object.keys(STATE.detected || {}).some((id) => {
    const d = STATE.detected[id];
    return !!(d && (d.installed || d.receipted));
  });
}

function openUninstallAllModal() {
  const modal = $('#uninstall-all-modal');
  if (!modal) return;
  const cb = $('#uninstall-all-include-claude');
  if (cb) cb.checked = false;
  const st = $('#uninstall-all-status');
  if (st) st.textContent = '';
  const confirmBtn = $('#uninstall-all-confirm');
  if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Удалить выбранное'; }
  modal.classList.remove('hidden');
}

function closeUninstallAllModal() {
  const modal = $('#uninstall-all-modal');
  if (modal) modal.classList.add('hidden');
}

async function runUninstallAll() {
  const cb = $('#uninstall-all-include-claude');
  const includeClaude = !!(cb && cb.checked);
  const st = $('#uninstall-all-status');
  const confirmBtn = $('#uninstall-all-confirm');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Удаляю…'; }
  if (st) {
    st.textContent = includeClaude
      ? 'Создаю резервную копию секретов ~/.claude и удаляю компоненты…'
      : 'Удаляю управляемые компоненты установщика…';
  }
  let res;
  try {
    res = await window.installer.uninstallAll({ includeClaude, env: envForRun() });
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (res && res.ok) {
    if (st) {
      st.textContent = '✓ Все выбранные компоненты удалены.' +
        (res.backupDir ? ' Резервная копия секретов сохранена в: ' + res.backupDir : '');
    }
    Object.keys(STATE.repair || {}).forEach((k) => { STATE.repair[k] = false; });
    await detectAndApply();
    setTimeout(() => closeUninstallAllModal(), 1400);
  } else {
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Удалить выбранное'; }
    if (st) {
      st.textContent = '⚠ Не удалось завершить удаление: ' + ((res && res.error) || 'ошибка');
    }
    await detectAndApply();
  }
}

// Сколько скиллов пака сейчас выбрано (по умолчанию все включены).
function packSelectedCount(p) {
  return (p.skills || []).filter((s) => STATE.selectedSkills[s] !== false).length;
}

function packBadgeText(p) {
  const total = (p.skills || []).length;
  const n = packSelectedCount(p);
  return n === total ? `${total} скиллов` : `${n} из ${total} скиллов`;
}

function renderPacks() {
  const root = $('#packs');
  root.innerHTML = '';
  (STATE.packsData.packs || []).forEach((p) => {
    const checked = STATE.selectedPacks[p.id];
    const el = document.createElement('div');
    el.className = 'pack-card' + (checked ? ' checked' : '');
    el.innerHTML = `
      <div class="checkbox">${CHECK_SVG}</div>
      <div class="pack-emoji">${p.emoji || '📦'}</div>
      <div class="pack-body">
        <div class="pack-name">${p.name} <span class="badge">${packBadgeText(p)}</span></div>
        <div class="pack-desc">${p.desc || ''}</div>
        <button type="button" class="linkbtn pack-skills-toggle">⚙ Выбрать скиллы</button>
      </div>`;
    el.addEventListener('click', () => togglePack(p.id));
    // Раскрытие панели скиллов не должно переключать сам пак.
    const tg = el.querySelector('.pack-skills-toggle');
    tg.addEventListener('pointerdown', (e) => e.stopPropagation());
    tg.addEventListener('click', (e) => {
      e.stopPropagation();
      // Одновременно раскрыт только один пак: открытие другого закрывает прежний.
      STATE.expandedPack = STATE.expandedPack === p.id ? null : p.id;
      renderPacks();
    });
    root.appendChild(el);
    if (STATE.expandedPack === p.id) root.appendChild(renderPackSkills(p, el));
  });
}

// Панель drill-down по скиллам пака — сосед карточки на всю ширину грида.
function renderPackSkills(p, cardEl) {
  const skills = p.skills || [];
  const panel = document.createElement('div');
  panel.className = 'pack-skills';
  panel.innerHTML = `
    <div class="pack-skills-head">
      <span class="pack-skills-count">${packSelectedCount(p)} из ${skills.length} выбрано</span>
      <button type="button" class="linkbtn" data-act="all">Все</button>
      <button type="button" class="linkbtn" data-act="none">Ничего</button>
    </div>
    <div class="pack-skills-grid">
      ${skills.map((s) => `
        <label class="skill-chip">
          <input type="checkbox" data-skill="${s}" ${STATE.selectedSkills[s] !== false ? 'checked' : ''} />
          <span>${s}</span>
        </label>`).join('')}
    </div>`;
  // Обновляем счётчики без полного перерендера — чтобы чекбокс не терял фокус.
  const syncCounts = () => {
    const badge = cardEl.querySelector('.pack-name .badge');
    if (badge) badge.textContent = packBadgeText(p);
    const head = panel.querySelector('.pack-skills-count');
    if (head) head.textContent = `${packSelectedCount(p)} из ${skills.length} выбрано`;
    refreshDerived();
  };
  panel.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      const on = b.dataset.act === 'all';
      skills.forEach((s) => (STATE.selectedSkills[s] = on));
      panel.querySelectorAll('input[data-skill]').forEach((cb) => (cb.checked = on));
      syncCounts();
    })
  );
  panel.querySelectorAll('input[data-skill]').forEach((cb) =>
    cb.addEventListener('change', () => {
      STATE.selectedSkills[cb.dataset.skill] = cb.checked;
      syncCounts();
    })
  );
  return panel;
}

function togglePack(id) {
  STATE.selectedPacks[id] = !STATE.selectedPacks[id];
  renderPacks();
  refreshDerived();
}

function setAllPacks(on) {
  Object.keys(STATE.selectedPacks).forEach((id) => (STATE.selectedPacks[id] = on));
  renderPacks();
  refreshDerived();
}

// Сколько места нужно под ВЫБРАННОЕ — оценка с запасом, а не прежние «~4 ГБ на всё».
// Берутся те же точные размеры, что в окне «что попадёт на мой ПК» (вес дистрибутива в
// офлайне, размер докачки в lite), и умножаются на DISK_FACTOR: распакованная программа
// больше своего архива, а пока шаг идёт, на диске лежат и архив, и распаковка. Сверху —
// DISK_BASE_BYTES на то, что компоненты тянут сами (браузер для скиллов, кэши, журнал).
// Число — оценка, поэтому на экране оно со знаком «≈» и округлено вверх до 0,5 ГБ.
const DISK_FACTOR = 2.5;
const DISK_BASE_BYTES = 0.5 * 1024 * 1024 * 1024;
function diskNeedGB() {
  const bytes = selectedIds().reduce((sum, id) => sum + componentSizeBytes(STATE.byId[id]), 0);
  if (!(bytes > 0)) return 0;
  const gb = (bytes * DISK_FACTOR + DISK_BASE_BYTES) / (1024 * 1024 * 1024);
  return Math.ceil(gb * 2) / 2;
}
// «на C:» — том, на котором main мерил свободное место (там же профиль, куда всё ставится).
function diskVolumeLabel() {
  const m = /^([A-Za-z]:)/.exec(String(STATE.homeRoot || ''));
  return m ? 'на ' + m[1].toUpperCase() : 'на диске';
}

// Preflight: строка «нужно ≈X ГБ, свободно Y ГБ на C:» под заголовком; при нехватке —
// жёлтое предупреждение (не блокирует установку, но «Установить» переспросит). Зовётся
// из refreshDerived — пересчитывается на каждый клик по галочке.
function renderPreflight() {
  const old = document.getElementById('preflight-warn');
  if (old) old.remove();
  const oldLine = document.getElementById('disk-line');
  if (oldLine) oldLine.remove();
  const need = diskNeedGB();
  // Не смогли измерить или нечего считать — молчим: пугать человека на догадке нельзя.
  if (STATE.freeGB === null || !(need > 0)) return;
  const where = diskVolumeLabel();
  // Где всё окажется — людям нужно знать до старта (выбора диска нет, и «а можно на D:?» спрашивали):
  // программы и настройки идут в профиль на системном диске, а свои проекты хранятся где угодно —
  // Claude Code работает в той папке, которую откроешь.
  const diskNote = 'Всё ставится в твой профиль на этом диске, а свои проекты можно хранить где угодно.';
  const el = document.createElement('div');
  if (STATE.freeGB < need) {
    el.id = 'preflight-warn';
    el.className = 'preflight-warn';
    el.innerHTML = `⚠️ Места может не хватить: для выбранного нужно ≈${need} ГБ, а свободно всего <b>${STATE.freeGB} ГБ</b> ${where}. ` +
      `Освободи место или сними тяжёлые компоненты (Python-пакеты, Nomad, Cursor) — иначе установка может прерваться. ${diskNote}`;
  } else {
    el.id = 'disk-line';
    el.className = 'disk-line';
    el.textContent = `💾 Понадобится ≈${need} ГБ, свободно ${STATE.freeGB} ГБ ${where}. ${diskNote}`;
  }
  const hero = document.querySelector('#view-select .hero');
  if (hero) hero.insertAdjacentElement('afterend', el);
}

// Жёлтый баннер, если установщик запущен под другим пользователем, чем
// интерактивный (детект в main.js; на Windows пока пусто — см. TODO там).
function renderUserWarning() {
  if (!STATE.userWarning) return;
  if (document.getElementById('userwarn')) return;
  const el = document.createElement('div');
  el.id = 'userwarn';
  el.className = 'preflight-warn'; // переиспользуем жёлтый стиль preflight
  el.innerHTML = '⚠️ ' + escapeHtml(STATE.userWarning);
  const hero = document.querySelector('#view-select .hero');
  if (hero) hero.insertAdjacentElement('afterend', el);
}

// macOS App Translocation / оторванный sibling-vendor (main решает авторитетно —
// vendorBlock.blocked). Жёсткий стоп ДО установки: блокирующее окно (не warning),
// «Установить» гасится (refreshDerived видит STATE.vendorBlocked). Если не заблокировано
// — обычная мягкая подсветка renderVendorWarning (dev / config-pack отсутствует).
function renderVendorBlock() {
  const vb = STATE.vendorBlock || {};
  if (!vb.blocked) { renderVendorWarning(); return; }
  STATE.vendorBlocked = true;
  openModal({
    id: 'vendor-block',
    emoji: '⚠️',
    title: 'Запусти установщик из окна DMG',
    bodyHtml:
      '<p>macOS поставил приложению «карантин» и запускает его из защищённой копии — офлайн-компоненты рядом с ним недоступны, установка заблокирована.</p>' +
      '<p><b>Почему «просто открыть из окна DMG» часто НЕ помогает:</b> если образ уже смонтирован, снятие карантина на него не подействует — образ надо ЗАКРЫТЬ (отмонтировать) и открыть заново. Команда ниже делает всё это сама.</p>' +
      '<ol style="margin:6px 0 6px 18px;line-height:1.55">' +
      // Порядок важен: кнопка живёт ЭТОМ ЖЕ окне, поэтому «закрой окно» не может стоять раньше неё —
      // человек закрывал установщик и оставался без кнопки. Сначала кнопка, закрывать окно — только
      // если она не помогла.
      '<li><b>Проще всего — нажми кнопку ниже</b>, закрывать это окно не нужно: установщик всё сделает сам — найдёт образ, снимет карантин, закроет старые окна образа, откроет свежее и перезапустится из него.<br>' +
      '<button type="button" id="mac-selfheal" class="btn" style="margin-top:8px">Исправить автоматически</button>' +
      '<div id="mac-selfheal-status" style="font-size:12px;opacity:.85;margin-top:6px"></div></li>' +
      '<li><b>Если кнопка не помогла</b> — закрой это окно установщика (перетащил приложение в «Программы» — удали его оттуда), открой <b>Терминал</b> (⌘+Пробел → «Терминал» → Enter) и вставь <b>ОДНОЙ строкой</b>:<br>' +
      '<code style="-webkit-user-select:all;user-select:all;font-size:11px;display:block;margin-top:4px;white-space:normal;word-break:break-all">DMG=$(find ~ -maxdepth 4 -iname &quot;Hamidun-Setup-Mac*.dmg&quot; 2&gt;/dev/null | head -1); echo &quot;Нашёл: $DMG&quot;; for v in /Volumes/Hamidun*; do hdiutil detach &quot;$v&quot; -force 2&gt;/dev/null; done; xattr -dr com.apple.quarantine &quot;$DMG&quot;; open &quot;$DMG&quot;</code>' +
      '<br><span style="font-size:12px;opacity:.82">Она сама найдёт образ (даже если он не в «Загрузках»), ЗАКРОЕТ все ранее открытые окна образа и откроет свежий — это ключевой шаг. Если после «Нашёл:» пусто — файла на маке нет, скачай заново.</span></li>' +
      '<li>В открывшемся <b>свежем</b> окне DMG запусти «Hamidun Setup» двойным кликом. Кнопка «Установить» станет активной.</li>' +
      '</ol>' +
      '<p style="font-size:12px;opacity:.82">Не получилось — пришли боту-помощнику скрин Терминала целиком: @vibecodeguidebot.</p>',
    closeLabel: 'Понятно',
    blocking: true,
  });
  // #8: модалку можно закрыть кнопкой «Понятно» — но «Установить» останется погашенной
  // без единого объяснения (повторный показ зашит только в startInstall, а он не стреляет
  // по disabled-кнопке) → глухой тупик до перезапуска приложения. Рисуем НЕсмываемый
  // баннер с той же командой xattr и кнопкой «Показать инструкцию» (re-open модалки).
  if (!document.getElementById('vendorblock-banner')) {
    const b = document.createElement('div');
    b.id = 'vendorblock-banner';
    b.className = 'preflight-warn';
    b.style.cssText = 'border-color:#e5484d;background:rgba(229,72,77,.08)';
    b.innerHTML = '🛑 Установка заблокирована: macOS запускает приложение из карантинной копии. ' +
      '<button type="button" id="mac-selfheal-banner" class="btn-sm" style="margin:6px 8px 6px 0">Исправить автоматически</button>' +
      '<span id="mac-selfheal-banner-status" style="font-size:12px;opacity:.85"></span><br>' +
      'Если кнопка не помогла — выполни ОДНОЙ строкой и запусти из СВЕЖЕГО окна DMG:<br>' +
      '<code style="-webkit-user-select:all;user-select:all;font-size:11px;display:block;margin-top:4px;white-space:normal;word-break:break-all">DMG=$(find ~ -maxdepth 4 -iname &quot;Hamidun-Setup-Mac*.dmg&quot; 2&gt;/dev/null | head -1); echo &quot;Нашёл: $DMG&quot;; for v in /Volumes/Hamidun*; do hdiutil detach &quot;$v&quot; -force 2&gt;/dev/null; done; xattr -dr com.apple.quarantine &quot;$DMG&quot;; open &quot;$DMG&quot;</code><br>' +
      '<button type="button" id="vendorblock-reopen" class="btn-sm" style="margin-top:6px">Показать инструкцию</button>';
    const hero = document.querySelector('#view-select .hero');
    if (hero) hero.insertAdjacentElement('afterend', b);
    const rb = document.getElementById('vendorblock-reopen');
    if (rb) rb.addEventListener('click', () => renderVendorBlock());
  }
  bindMacSelfHeal('mac-selfheal', 'mac-selfheal-status');
  bindMacSelfHeal('mac-selfheal-banner', 'mac-selfheal-banner-status');
  showPrevSelfHealFailure('mac-selfheal-status', 'mac-selfheal-banner-status');
}

// Если прошлая починка провалилась УЖЕ ПОСЛЕ нашего выхода, человек до сих пор
// не узнавал об этом ничего: окно исчезало, а новое не появлялось. Помощник
// оставляет крошку — показываем её причину при следующем запуске.
// Текст держим в модуле: крошка читается ОДИН раз (чтение её и удаляет), а модалку
// можно переоткрыть кнопкой «Показать инструкцию» — раньше сообщение при этом
// исчезало навсегда.
let PREV_SELFHEAL_TEXT = '';

// Читаем крошку ПРИ СТАРТЕ, а не внутри отрисовки блокирующей модалки. Раньше её
// читали только в сеансе, который сам заблокирован, — значит отказ мог пролежать
// на диске неделями и всплыть уже с другим, свежескачанным образом.
async function loadPrevSelfHealFailure() {
  if (!window.installer || !window.installer.macSelfHealStatus) return;
  let st = '';
  try { st = ((await window.installer.macSelfHealStatus()) || {}).status || ''; } catch (e) { return; }
  if (!st || st === 'ok' || st === 'started') return;
  PREV_SELFHEAL_TEXT = st === 'mount-failed'
    ? 'Прошлая попытка починки не смогла открыть образ — возможно, файл повреждён. Скачай установщик заново или выполни команду ниже в Терминале.'
    : st === 'verify-failed'
      ? 'Прошлая попытка починки остановилась: приложение в образе не прошло проверку подписи, поэтому я его не запускал. Скачай установщик заново с официальной страницы — команда ниже для этого случая не нужна.'
      : st === 'relaunch-not-seen'
        ? 'Прошлая попытка починки открыла образ, но установщик из него не запустился. Открой приложение из окна образа вручную или выполни команду ниже в Терминале.'
        : 'Прошлая попытка починки не смогла перезапустить установщик. Выполни команду ниже в Терминале.';
}

function showPrevSelfHealFailure(...statusIds) {
  if (!PREV_SELFHEAL_TEXT) return;
  for (const id of statusIds) {
    const el = document.getElementById(id);
    if (el) el.textContent = PREV_SELFHEAL_TEXT;
  }
}

// Кнопка «Исправить автоматически»: установщик сам снимает карантин с образа,
// перемонтирует его и перезапускается из свежего тома. Просить человека копировать
// команду в Терминал — плохой путь: живой случай показал, что там ошибаются (образ
// лежал не в «Загрузках», команда падала, и человек упирался в тупик).
// Защёлка самолечения. Кнопок ДВЕ (в модалке и в несмываемом баннере), и раньше,
// пока шла первая попытка, со второй кнопки можно было запустить починку ещё раз —
// а вторая попытка force-отцепляет том, с которого уже стартует новый установщик.
// Флаг общий на модуль: пока вызов идёт, повторный клик с ЛЮБОЙ кнопки невозможен.
// disabled на кнопках — только видимая часть; сама защита — этот флаг.
let SELF_HEAL_BUSY = false;
// Обе кнопки разом: блокируем и показываем, что починка уже идёт.
function setSelfHealButtonsBusy(busy) {
  ['mac-selfheal', 'mac-selfheal-banner'].forEach((bid) => {
    const b = document.getElementById(bid);
    if (!b) return;
    b.disabled = busy;
    if (busy) {
      if (!b.dataset.idleLabel) b.dataset.idleLabel = b.textContent;
      b.textContent = 'Чиню…';
    } else if (b.dataset.idleLabel) {
      b.textContent = b.dataset.idleLabel;
    }
  });
}
function bindMacSelfHeal(btnId, statusId) {
  const btn = document.getElementById(btnId);
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    if (SELF_HEAL_BUSY) return; // починка уже идёт — второй запуск невозможен
    SELF_HEAL_BUSY = true;
    const st = document.getElementById(statusId);
    const say = (s) => { if (st) st.textContent = s; };
    setSelfHealButtonsBusy(true);
    say('Ищу образ, проверяю подпись и снимаю карантин…');
    let res = null;
    try { res = await window.installer.macSelfHeal(); } catch (e) { res = { ok: false, error: String(e) }; }
    if (res && res.ok) {
      // Защёлку НЕ отпускаем: приложение сейчас перезапустится из свежего тома,
      // и повторная починка в этот момент отцепила бы том у него из-под ног.
      // Говорим ровно то, что уже произошло. Раньше здесь было «открыл свежее
      // окно образа и запускаю установщик оттуда» — заведомо неверно: остальное
      // делается уже после нашего выхода, и если у помощника не выйдет, человек
      // увидит только исчезнувшее окно. Поэтому и команда для Терминала остаётся
      // на экране: она — запасной путь, а не признак ошибки.
      say('Карантин снят. Сейчас закрою это окно — через несколько секунд установщик '
        + 'откроется заново из свежего образа. Если этого не произошло за полминуты, '
        + 'выполни команду ниже в Терминале.');
      // Выход НЕ отсюда: таймер в окне умирает вместе с окном, а модалка прямо
      // просит его закрыть. Закрытие окна человеком отменяло выход, процесс
      // оставался жив и держал замок единственного экземпляра — свежий установщик
      // закрывался сам, и человек оставался ни с чем. Теперь выход инициирует
      // главный процесс, и закрыть окно можно когда угодно.
      return;
    }
    SELF_HEAL_BUSY = false;
    setSelfHealButtonsBusy(false);
    const why = (res && res.error) || 'неизвестно';
    if (why === 'dmg-not-found') {
      say('Не нашёл файл образа (Hamidun-Setup-Mac.dmg) — похоже, он удалён. Скачай установщик заново.');
    } else if (why === 'verify-failed') {
      // Образ с нашим именем нашёлся, но приложение в нём подписано не так, как этот установщик:
      // карантин с него НЕ снят, ничего не отцеплено и не запущено. Команду из Терминала здесь не
      // советуем — она сняла бы карантин именно с такого файла.
      say('Нашёл образ, но подпись приложения внутри не совпала с подписью этого установщика — я не стал его запускать и ничего не менял. Скачай установщик заново с официальной страницы. Если файл точно оттуда, а сообщение повторяется, напиши боту-помощнику @vibecodeguidebot.');
    } else if (why === 'busy') {
      say('Проверка образа уже идёт — подожди несколько секунд и нажми ещё раз.');
    } else if (why === 'identity-unknown' || why === 'preflight-failed') {
      say('Не смог проверить подпись запущенного установщика, поэтому автоматическое исправление отключено — ничего не менял. Выполни команду ниже в Терминале.');
    } else if (why === 'volume-not-ready' || why === 'open-failed') {
      say('Образ не открылся сам. Выполни команду ниже в Терминале — она делает то же самое.');
    } else {
      say('Автоматически не вышло (' + why + '). Выполни команду ниже в Терминале.');
    }
  });
}

// На macOS офлайн-ресурсы (vendor) лежат в dmg РЯДОМ с приложением. Если .app
// перетащили в /Applications и запустили без dmg — vendor не найден: жёсткое
// предупреждение запускать из окна установщика (иначе офлайн-установка не сработает).
function renderVendorWarning() {
  if (STATE.vendorAvailable) return;
  if (STATE.platform !== 'darwin') return;
  if (document.getElementById('vendorwarn')) return;
  const el = document.createElement('div');
  el.id = 'vendorwarn';
  el.className = 'preflight-warn';
  // Текст ОБЯЗАН быть верным для ОБОИХ изданий. «офлайн-файлы» звучало как речь про
  // офлайн-издание, и лёгкое (стриминговое) издание выглядело так, будто плашка не про
  // него — хотя рядом с .app на томе dmg у него тоже лежит нужное (uv, курс,
  // checksums.json), и перетаскивание в «Программы» отрывает именно это.
  el.innerHTML = '⚠️ Запусти установщик из окна, которое открылось при монтировании DMG ' +
    '(двойным кликом по «Hamidun Setup» там), а не из «Программы». Иначе файлы, ' +
    'лежащие рядом с приложением в этом окне, не подхватятся и установка может не пройти.';
  const hero = document.querySelector('#view-select .hero');
  if (hero) hero.insertAdjacentElement('afterend', el);
}

// ---- модальные окна (блокирующий стоп + инфо-попапы) ----------------
// Универсальное модальное окно поверх всего экрана. blocking=true → закрыть можно
// только кнопкой (App-Translocation стоп); иначе — ещё и кликом по затемнённому фону.
// title — доверенный литерал; bodyHtml собирается вызывающим (пользовательские
// значения экранируются на его стороне).
function openModal(opts) {
  const id = opts.id;
  if (id && document.getElementById(id)) return null;
  const ov = document.createElement('div');
  if (id) ov.id = id;
  ov.className = 'modal-overlay';
  ov.innerHTML =
    '<div class="modal-card" role="' + (opts.blocking ? 'alertdialog' : 'dialog') + '" aria-modal="true">' +
      (opts.emoji ? '<div class="modal-emoji" aria-hidden="true">' + opts.emoji + '</div>' : '') +
      '<h2 class="modal-title">' + opts.title + '</h2>' +
      '<div class="modal-body">' + opts.bodyHtml + '</div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-primary modal-close">' +
          escapeHtml(opts.closeLabel || 'Понятно') + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const btn = ov.querySelector('.modal-close');
  if (btn) btn.addEventListener('click', close);
  if (!opts.blocking) {
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  }
  return ov;
}

// Task 3 (страх вируса): попап «что попадёт на мой ПК» — реальный список из
// components.json (имя + описание + измеренный размер). Служебные (hidden, напр.
// verify) не показываем. Ничего не выдумываем — только данные конфига.
//
// ПОДПИСЬ ВАЖНЕЕ ЧИСЛА. Заголовок «Что скачается на мой ПК» был верен лишь для
// лёгкого издания: офлайн-установщик не качает НИЧЕГО — всё уже внутри exe. И сама
// цифра — это вес дистрибутива, а не место на диске после установки; человек же читает
// её как «столько займёт». Поэтому и заголовок, и единицу измерения проговариваем
// словами, а не оставляем на догадку (см. componentSizeText).
function showWhatInstalls() {
  const lite = STATE.edition === 'lite';
  const rows = [];
  let unknown = 0;
  (STATE.groups || []).forEach((g) => {
    (g.components || []).forEach((c) => {
      if (!c || c.hidden) return;
      const sizeText = componentSizeText(c);
      if (!sizeText) unknown++;
      const size = sizeText ? ' <span class="wi-size">' + escapeHtml(sizeText) + '</span>' : '';
      // То же предупреждение, что и на карточке: в этом окне человек читает описание
      // компонента отдельно от карточки, и обещание «стабильный адрес» без оговорки
      // здесь было бы ровно таким же молчанием.
      const unconf = componentUnconfigured(c)
        ? '<div class="wi-desc" style="color:var(--h-yellow)">⚠ ' + escapeHtml(unconfiguredNoteText(c)) + '</div>'
        : '';
      rows.push(
        '<li><div class="wi-name">' + escapeHtml(c.name) + size + '</div>' +
        '<div class="wi-desc">' + escapeHtml(c.desc || '') + '</div>' + unconf + '</li>'
      );
    });
  });
  // Итог по ВЫБРАННЫМ компонентам: в lite — сколько скачается, в офлайн — сколько
  // весит внутри установщика (там же объясняем, почему сам файл установщика меньше
  // суммы: внутри всё сжато).
  const dlBytes = downloadTotalBytes();
  const bundledBytes = bundledTotalBytes();
  let totalLead = '';
  if (dlBytes > 0) {
    totalLead = '<p class="wi-lead"><b>Скачается: ~' + escapeHtml(fmtBytesRu(dlBytes)) + '</b> — лёгкая ' +
      'версия докачивает выбранные компоненты с сервера во время установки (с проверкой целостности).</p>';
  } else if (bundledBytes > 0) {
    totalLead = '<p class="wi-lead"><b>Внутри установщика: ~' + escapeHtml(fmtBytesRu(bundledBytes)) + '</b> — ' +
      'выбранные компоненты уже лежат в файле, который ты скачал, и качать их из интернета не нужно. ' +
      'Сам файл установщика меньше этой суммы: внутри всё сжато.</p>';
  }
  const unit = lite
    ? 'Цифра рядом с пунктом — сколько он весит при загрузке.'
    : 'Цифра рядом с пунктом — вес самого дистрибутива внутри установщика.';
  // Пустое место вместо числа объясняем прямо: не знаем — не пишем. Придуманная
  // цифра в этом окне вреднее отсутствующей.
  const unknownNote = unknown ? ' Там, где цифры нет, мы её заранее не знаем — и не придумываем.' : '';
  const body =
    '<p class="wi-lead">Ставится только то, что ты выбрал. Основное — офлайн из самого ' +
    'установщика; компоненты с пометкой «онлайн» докачиваются с официальных источников ' +
    'с проверкой целостности.</p>' +
    '<p class="wi-lead">' + unit + ' После установки программа занимает на диске больше: ' +
    'установщик распаковывается.' + unknownNote + '</p>' + totalLead +
    '<ul class="wi-list">' + rows.join('') + '</ul>';
  openModal({
    id: 'what-installs',
    emoji: '📦',
    title: lite ? 'Что скачается на мой ПК' : 'Что попадёт на мой ПК',
    bodyHtml: body,
    closeLabel: 'Закрыть',
    blocking: false,
  });
}

// Task 4: памятка «Что дальше» (START-HERE.html) — общий вход для кнопки на экране
// выбора, прогресса и финиша. Вшита в ресурсы; на финише копируется на рабочий стол.
// Копию кэшируем в STATE.startHerePath только при успехе; при неудаче открываем
// вшитую из ресурсов. Повторный клик во время открытия игнорируем (memoBusy).
async function openStartHereMemo() {
  const fin = (STATE.config && STATE.config.finish) || {};
  const startHtmlRel = fin.startHtmlRelPath || '';
  if (!startHtmlRel) return false;
  const isWin = STATE.platform === 'win32';
  const sep = isWin ? '\\' : '/';
  const startRel = isWin ? startHtmlRel.replace(/\//g, '\\') : startHtmlRel.replace(/\\/g, '/');
  const resPath = STATE.resourcesRoot ? STATE.resourcesRoot + sep + startRel : '';
  if (STATE.memoBusy) return false;
  STATE.memoBusy = true;
  try {
    let dest = STATE.startHerePath || '';
    if (!dest) {
      try {
        const r = await window.installer.saveStartHere();
        if (r && r.ok && r.dest) { dest = r.dest; STATE.startHerePath = r.dest; }
      } catch (e) { /* копия на стол не удалась — откроем вшитую */ }
    }
    const target = dest || resPath;
    if (target) {
      const r = await window.installer.openPath(target);
      if (r && r.ok) return true;
      if (target === STATE.startHerePath) STATE.startHerePath = '';
    }
    if (resPath && resPath !== target) {
      const r2 = await window.installer.openPath(resPath);
      return !!(r2 && r2.ok);
    }
    return false;
  } finally {
    STATE.memoBusy = false;
  }
}

// Тихая копия памятки на рабочий стол (без открытия чего-либо). На финише зовётся
// вместо прежнего авто-открытия браузера: артефакт «Что дальше — Hamidun.html» на
// столе остаётся, а браузер больше не выскакивает сам. Результат кэшируем как в
// openStartHereMemo; неудача не критична — вшитая копия всегда на месте.
async function saveStartHereQuiet() {
  if (STATE.startHerePath) return;
  try {
    const r = await window.installer.saveStartHere();
    if (r && r.ok && r.dest) STATE.startHerePath = r.dest;
  } catch (e) { /* копия на стол не удалась — не мешаем финишу */ }
}

// ---- встроенный просмотр памятки «Что дальше» (в окне установщика) ----------
// Раньше на финише памятка АВТОМАТИЧЕСКИ открывалась во внешнем браузере — у части
// людей дефолтный браузер стартует «с нуля» (холодный запуск с онбордингом), это
// раздражает и выглядит, будто установщик запускает что-то постороннее. Теперь
// памятка читается прямо здесь, в оверлее; браузер — только по явной кнопке.
// Памятка — статичный документ: <script> вырезаем целиком (его checklist-интерактив
// в оверлее не нужен, а CSP окна всё равно не дала бы ему исполниться).
function stripMemoScripts(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, ''); // незакрытый хвостовой <script …> тоже гасим
}

// CSS памятки писан для отдельного документа (:root / body / html). Внутри Shadow DOM
// эти селекторы не матчатся НИЧЕМУ — пропали бы все CSS-переменные (весь цвет памятки
// на var(--…)) и базовая типографика. Переписываем на :host / .memo-doc (обёртка).
function adaptMemoCss(css) {
  return String(css)
    .replace(/:root\b/g, ':host')
    .replace(/(^|[\s,{}])body\b/g, '$1.memo-doc')
    .replace(/(^|[\s,{}])html\b/g, '$1.memo-doc');
}

// Оверлей с памяткой поверх текущего экрана: заголовок, «Открыть в браузере»,
// крестик/Esc, прокрутка. Контент — в Shadow DOM, чтобы стили памятки и установщика
// не подрались. Содержимое отдаёт main (read-start-here, путь считает сам).
async function showStartHereInline() {
  if (document.getElementById('memo-overlay')) return; // уже открыта
  const fin = (STATE.config && STATE.config.finish) || {};
  if (!fin.startHtmlRelPath) return; // памятки в этой сборке нет — кнопки и не рисуем

  const ov = document.createElement('div');
  ov.id = 'memo-overlay';
  ov.className = 'modal-overlay memo-overlay';
  ov.innerHTML =
    '<div class="memo-card" role="dialog" aria-modal="true" aria-label="Памятка «Что дальше»">' +
      '<div class="memo-head">' +
        '<div class="memo-title">📌 Что дальше — памятка</div>' +
        '<button type="button" id="memo-ext" class="btn-sm">Открыть в браузере</button>' +
        '<button type="button" id="memo-close" class="memo-close" aria-label="Закрыть" title="Закрыть (Esc)">✕</button>' +
      '</div>' +
      '<div class="memo-body"><div id="memo-host"></div></div>' +
    '</div>';
  document.body.appendChild(ov);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('#memo-close').addEventListener('click', close);
  // «Открыть в браузере» — прежний путь целиком: копия на стол + системное открытие.
  ov.querySelector('#memo-ext').addEventListener('click', () => openStartHereMemo());

  const sh = ov.querySelector('#memo-host').attachShadow({ mode: 'open' });
  const fallback = (msg) => {
    // Честный отказ БЕЗ innerHTML с текстом ошибки (textContent) + путь наружу.
    sh.textContent = '';
    const box = document.createElement('div');
    box.className = 'memo-fallback';
    box.style.cssText = 'padding:28px 22px;font-size:14.5px;line-height:1.6';
    const p1 = document.createElement('p');
    p1.textContent = 'Не получилось показать памятку в этом окне' + (msg ? ' (' + msg + ')' : '') + '.';
    const p2 = document.createElement('p');
    p2.style.marginTop = '8px';
    p2.textContent = 'Нажми «Открыть в браузере» вверху — это та же памятка.';
    box.appendChild(p1); box.appendChild(p2);
    sh.appendChild(box);
  };

  let res = null;
  try { res = await window.installer.readStartHere(); } catch (e) { res = { ok: false, error: e.message }; }
  if (!res || !res.ok || !res.html) { fallback((res && res.error) || 'нет данных'); return; }

  const doc = new DOMParser().parseFromString(stripMemoScripts(res.html), 'text/html');
  const wrap = document.createElement('div');
  wrap.className = 'memo-doc';
  // Стили памятки: и из <head>, и из <body> (сейчас они в body) — адаптируем под shadow.
  Array.from(doc.querySelectorAll('style')).forEach((st) => { st.textContent = adaptMemoCss(st.textContent); });
  Array.from(doc.head.querySelectorAll('style')).forEach((st) => wrap.appendChild(st));
  while (doc.body.firstChild) wrap.appendChild(doc.body.firstChild);
  const base = document.createElement('style');
  base.textContent = ':host{display:block;min-height:100%} .memo-doc{min-height:100%}';
  sh.appendChild(base);
  sh.appendChild(wrap);

  // Ссылки: дефолтную навигацию давим ВСЕГДА (иначе клик увёл бы само окно установщика
  // с app.js). Якоря скроллим внутри shadow; внешние — через main-IPC openExternal,
  // где уже стоит allowlist схем (web/почта/telegram).
  wrap.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      const t = href.length > 1 ? sh.getElementById(href.slice(1)) : null;
      if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (href) {
      window.installer.openExternal(href);
    }
  });
}

// Task 4b: заметная плашка помощи на экране прогресса (и финиша — это тот же view). Раньше
// она просила «кинь скриншот» и вела на голую ссылку бота: скриншот до бота доходил не
// всегда, а у застрявшего посреди установки отчёта под рукой не было вовсе (кнопка жила
// только на финише). Теперь «Скопировать отчёт» работает и ВО ВРЕМЯ установки, а ссылка на
// бота несёт тот же payload, что и финишная кнопка: адрес собирается В МОМЕНТ клика
// (botUrlForState), поэтому плашку не нужно перерисовывать после каждого сбоя.
function renderProgressBotBanner() {
  const el = $('#progress-bot-banner');
  if (!el) return;
  const links = (STATE.config && STATE.config.links) || {};
  const botBase = links.bot || '';
  if (!botBase) return; // нет бота в конфиге — плашку не показываем
  el.innerHTML =
    '<span class="progress-bot-ico" aria-hidden="true">💬</span>' +
    '<span class="progress-bot-text">Не едет? Нажми «Скопировать отчёт» и вставь его в чат с ботом — ' +
    'он увидит, на каком шаге ты застрял, и проведёт за руку. <span id="pb-report-status" class="progress-bot-status"></span></span>' +
    '<button type="button" class="btn-sm progress-bot-btn" id="pb-report">📋 Скопировать отчёт</button>' +
    '<button type="button" class="btn-sm progress-bot-btn" id="pb-bot">Написать боту</button>';
  el.classList.remove('hidden');
  const rb = el.querySelector('#pb-report');
  if (rb) rb.addEventListener('click', () => copySupportReport());
  const bb = el.querySelector('#pb-bot');
  if (bb) bb.addEventListener('click', () => window.installer.openExternal(botUrlForState()));
}

// Байты → человекочитаемо: до ~1 ГБ — «N МБ», дальше — «N,N ГБ». Суммируются ТОЛЬКО
// точные sizeBytes из реестра докачки (рукописный sizeHint для математики не годится).
function fmtBytesRu(bytes) {
  const mb = Number(bytes || 0) / (1024 * 1024);
  if (mb >= 1000) {
    return String(Math.round((mb / 1024) * 10) / 10).replace('.', ',') + ' ГБ';
  }
  return String(Math.max(1, Math.round(mb))) + ' МБ';
}

// РАЗМЕР КОМПОНЕНТА — что именно обещает цифра.
//
// Она отвечает на вопрос «сколько весит этот пункт», и ответ зависит от издания:
//   • lite   — точный размер архива докачки (remote-components.json → bootstrap.remoteSizes);
//   • офлайн — вес вшитого дистрибутива (components.json sizeBytes[платформа]; считает
//              его tools/sync-sizes.js по РЕАЛЬНОМУ vendor, руками цифру больше не пишут).
//
// Это НЕ место на диске после установки: распакованная программа занимает заметно
// больше, чем её установщик (git-setup.exe — 62 МБ, установленный Git кратно больше).
// Поэтому единица измерения подписана словами в попапе, а не оставлена на догадку.
//
// ПОЧЕМУ В LITE НЕ ПОКАЗЫВАЕМ ВШИТЫЙ РАЗМЕР: lite везёт лишь малую часть vendor
// (tools/build-lite.js LITE_KEEP_WIN/LITE_KEEP_MAC — uv + курс), и components.json не
// знает, какой именно кусок доехал. Показать там «X МБ внутри установщика» значило бы
// снова угадывать. Нет точного числа для ЭТОГО издания и ЭТОЙ платформы — не показываем
// ничего: выдуманная цифра в окне «что попадёт на мой ПК» страшнее отсутствующей.
function componentSizeBytes(c) {
  if (!c) return 0;
  if (STATE.edition === 'lite') {
    const dl = Number((STATE.remoteSizes || {})[c.id]);
    return dl > 0 ? dl : 0;
  }
  const b = c.sizeBytes && Number(c.sizeBytes[STATE.platform]);
  return b > 0 ? b : 0;
}

// Короткая форма для бейджа на карточке: число + подсказка при наведении. Развёрнуто
// единица объясняется в попапе, но карточка — первый экран, и голое «~222 МБ» человек
// по привычке читает как «столько займёт на диске». Поэтому title говорит прямо.
function sizeBadgeHtml(c) {
  const b = componentSizeBytes(c);
  if (!(b > 0)) return '';
  const tip = STATE.edition === 'lite'
    ? 'Столько скачается с сервера во время установки'
    : 'Вес дистрибутива внутри установщика; на диске после установки будет больше';
  return '<span class="badge" title="' + escapeHtml(tip) + '">~' + escapeHtml(fmtBytesRu(b)) + '</span>';
}

// Приписка про то, чего в установщике НЕТ: модель Handy, Chromium для Playwright,
// Python для Nomad — их тянет сам компонент, и на Windows/macOS это по-разному
// (браузеры на маке вшиты, на Windows докачиваются). Поэтому строка может быть
// платформенной: sizeNote = "текст" | { win32: "...", darwin: "..." }.
function componentSizeNote(c) {
  const n = c && c.sizeNote;
  if (!n) return '';
  if (typeof n === 'string') return n;
  return (typeof n === 'object' && typeof n[STATE.platform] === 'string') ? n[STATE.platform] : '';
}

// Развёрнутая форма для попапа: число + ЧТО оно значит + честная приписка о том,
// что докачивает не установщик, а сам компонент (sizeNote из components.json).
function componentSizeText(c) {
  if (!c) return '';
  const parts = [];
  const b = componentSizeBytes(c);
  if (b > 0) parts.push('~' + fmtBytesRu(b) + (STATE.edition === 'lite' ? ' · скачается' : ' · внутри установщика'));
  const note = componentSizeNote(c);
  if (note) parts.push(note);
  return parts.join(' · ');
}

// Сумма ТОЧНЫХ размеров докачки по ВЫБРАННЫМ remote-компонентам (превью «Скачается:
// ~X»). Только lite-издание: в офлайн всё вшито — качать нечего, превью не показываем.
function downloadTotalBytes() {
  if (STATE.edition !== 'lite') return 0;
  const sizes = STATE.remoteSizes || {};
  return selectedIds().reduce((sum, id) => sum + (Number(sizes[id]) || 0), 0);
}

// Офлайн-издание: сколько байт ВЫБРАННЫЕ компоненты весят внутри самого установщика.
// Нужно ровно для доверия: человек скачал файл на 1,9 ГБ и хочет увидеть, что цифры
// внутри с ним сходятся. Считаем только измеренное — компоненты без числа в сумму не
// попадают (и об этом сказано в попапе), лишь бы не подгонять итог.
function bundledTotalBytes() {
  if (STATE.edition === 'lite') return 0;
  return selectedIds().reduce((sum, id) => sum + componentSizeBytes(STATE.byId[id]), 0);
}

function refreshDerived() {
  // Скрытые компоненты не считаем в сводке — пользователь их не выбирал.
  const n = selectedIds().filter((id) => !(STATE.byId[id] && STATE.byId[id].hidden)).length;
  const np = Object.values(STATE.selectedPacks || {}).filter(Boolean).length;
  const total = (STATE.packsData.packs || []).length;
  // Тематические скиллы из выбранных паков. База (core + некатегоризированные)
  // ставится всегда вместе с «Конфигом» — её в счётчик не мешаем, а без
  // «Конфига» скиллы не ставятся вовсе, поэтому хвост гасим.
  let nSkills = 0;
  (STATE.packsData.packs || []).forEach((p) => {
    if (STATE.selectedPacks[p.id]) nSkills += packSelectedCount(p);
  });
  const skillsPart = STATE.selected['config'] ? ` · тематических скиллов: ${nSkills}` : '';
  // Лёгкое издание: честное превью докачки по ТОЧНЫМ sizeBytes выбранных remote-
  // компонентов (реестр). В офлайн-издании dlBytes=0 — ничего не показываем.
  const dlBytes = downloadTotalBytes();
  const dlPart = dlBytes > 0 ? ` · Скачается: ~${fmtBytesRu(dlBytes)}` : '';
  // Нечего ставить (всё уже стоит) — «Установить» погашена, но есть что проверить и починить:
  // без этой подсказки человек видел глухую серую кнопку и не знал, что делать дальше.
  const repairable = repairAvailable();
  const repairPart = repairable ? ' · ничего не выбрано — можно «Проверить и починить» (установленное не тронем)' : '';
  $('#summary').textContent = `Выбрано: ${n} компонентов · наборов скиллов: ${np}/${total}${skillsPart}${dlPart}${repairPart}`;
  // P0-1: кнопка выключена, пока детекция установленного не завершилась — чтобы
  // установка не стартовала с недодетектированным состоянием (режим/галки).
  // App-Translocation / оторванный vendor (STATE.vendorBlocked) — жёсткий стоп:
  // «Установить» не даём, пока офлайн-vendor неполон (main решает авторитетно).
  // Лёгкое издание: ждём и preflight probe-remote (netProbeDone; сам результат
  // НЕ запирает кнопку — offline даёт мягкий баннер, не жёсткий стоп).
  const btnInstall = $('#btn-install');
  btnInstall.disabled = n === 0 || !STATE.detectDone || !STATE.netProbeDone || !!STATE.vendorBlocked;
  btnInstall.textContent = dlBytes > 0 ? `Установить · скачается ~${fmtBytesRu(dlBytes)}` : 'Установить';
  const btnRepair = $('#btn-repair');
  if (btnRepair) {
    btnRepair.classList.toggle('hidden', !repairable);
    btnRepair.classList.toggle('primary', repairable);   // когда ставить нечего — это главное действие
  }
  const btnUninstallAll = $('#btn-uninstall-all');
  if (btnUninstallAll) {
    btnUninstallAll.classList.toggle('hidden', !anyUninstallablePresent());
  }

  // Наборы скиллов имеют смысл только если ставится Конфиг — иначе гасим секцию.
  const configOn = !!STATE.selected['config'];
  const pw = $('#packs-wrap');
  if (pw) pw.classList.toggle('disabled', !configOn);
  // Место на диске зависит от выбора — пересчитываем строку на каждый клик.
  renderPreflight();
}

// ---- install flow ---------------------------------------------------

function envForRun() {
  const cfg = STATE.config || {};

  // Skill packs -> which skill dirs to keep / which belong to any pack.
  const core = (STATE.packsData && STATE.packsData.core) || [];
  const allPacks = (STATE.packsData && STATE.packsData.packs) || [];
  const keep = new Set(core);
  const allPackSkills = new Set();
  allPacks.forEach((p) =>
    (p.skills || []).forEach((s) => {
      allPackSkills.add(s);
      // Ставим скилл, только если выбран и пак, и сам скилл внутри пака.
      if (STATE.selectedPacks[p.id] && STATE.selectedSkills[s] !== false) keep.add(s);
    })
  );

  return {
    HM_CONFIG_REPO_URL: cfg.configRepoUrl || '',
    HM_CONFIG_REPO_BRANCH: cfg.configRepoBranch || 'main',
    HM_CLAUDE_EXT_ID: cfg.claudeCodeExtensionId || 'anthropic.claude-code',
    HM_HOME: STATE.homedir || '',
    HM_KEEP_SKILLS: Array.from(keep).join(','),
    HM_ALL_PACK_SKILLS: Array.from(allPackSkills).join(','),
    HM_BRIDGE_ENDPOINT: (cfg.bridge && cfg.bridge.enrollEndpoint) || '',
    HM_BRIDGE_PACDOMAINS: ((cfg.bridge && cfg.bridge.pacDomains) || []).join(','),
    // Список выбранных компонентов (id через запятую). verify печатает "skip"
    // для компонентов, которых тут нет, чтобы снятые не давали ложных крестиков.
    HM_SELECTED: selectedIds().join(','),
    // Аддитивная доустановка конфига — ПОДСКАЗКА для UI-логики. Авторитетное решение
    // принимает MAIN (P0-1): живая детекция ФС, fail-safe → additive; clean только
    // при подтверждённом repair. Renderer это значение переопределить не может.
    HM_ADDITIVE: (STATE.selected['config'] &&
                  STATE.detected['config'] && STATE.detected['config'].installed &&
                  !STATE.repair['config']) ? '1' : '',
    // Компоненты, отмеченные «Переустановить начисто» (форс — игнорировать «installed»).
    HM_REPAIR: Object.keys(STATE.repair || {}).filter((id) => STATE.repair[id]).join(','),
    // P0-1: перезапись ~/.claude отдельно подтверждена диалогом (main требует ОБА флага).
    HM_REPAIR_CONFIRMED: Object.keys(STATE.repairConfirmed || {})
      .filter((id) => STATE.repairConfirmed[id] && STATE.repair[id]).join(','),
    // Опции компонентов (components.json → options[]). Ключи перечислены ЯВНО, а не
    // собраны циклом по данным: каждый обязан быть в allowlist src/install-env.js, и
    // явный список — единственный способ увидеть расхождение тестом, а не в проде.
    // «1» только если И компонент выбран, И галочка стоит.
    HM_HANDY_MIC: (STATE.selected['handy'] && optionOn('handy', 'mic')) ? '1' : ''
  };
}

// Журнал установки. Раньше здесь было `log.textContent += line + '\n'` плюс чтение
// scrollHeight на КАЖДОЙ строке — и это разгоняло приложение до нескольких ядер.
// Живой случай: на Mac процесс съел 523% процессора и перегрел ноутбук.
// Почему так дорого:
//   • `textContent +=` читает ВЕСЬ накопленный текст и записывает заново — то есть
//     пересоздаёт текстовый узел целиком. При 40 000 строках (обычный объём для pip,
//     uv и npm) это мегабайты, скопированные десятки тысяч раз;
//   • чтение scrollHeight — принудительный синхронный пересчёт вёрстки этого же
//     мегабайтного блока, тоже на каждой строке.
// Теперь: кольцо из последних строк + одна перерисовка на кадр. ПОЛНЫЙ журнал
// никуда не девается — главный процесс пишет его в install.log целиком.
const LOG_MAX_LINES = 800;
const LOG_LINES = [];
let LOG_DIRTY = false;

function flushLog() {
  LOG_DIRTY = false;
  const log = $('#log');
  if (!log) return;
  // Прилипание к низу — только если человек и так внизу. Иначе автопрокрутка
  // вырывала бы у него из рук журнал, который он читает.
  const atBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 40;
  log.textContent = LOG_LINES.join('\n') + '\n';
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function appendLog(line) {
  const s = String(line == null ? '' : line);
  // Полоски прогресса (pip, uv, curl) перерисовывают строку возвратом каретки.
  // Главный процесс уже режет вывод на ПОЛНЫЕ логические строки (split /\r?\n/),
  // поэтому пришедший сюда \r — это перерисовка ВНУТРИ одной строки: видимым
  // остаётся её последний сегмент.
  // РАНЬШЕ здесь было `LOG_LINES[last] = ...`, то есть замена ПРЕДЫДУЩЕЙ строки —
  // и каждая полоска прогресса стирала стоявшее перед ней сообщение, в том числе
  // строку ошибки. Строка, оканчивающаяся на \r, уничтожала сразу две: предыдущую
  // заменяла пустой. Своя строка — своя запись, чужую не трогаем.
  const parts = s.split('\r');
  let last = parts[parts.length - 1];
  // Хвостовой \r («100%\r») даёт пустой сегмент — берём последний непустой,
  // иначе в журнале появлялись пустые строки вместо содержательных.
  if (last === '' && parts.length > 1) {
    for (let i = parts.length - 2; i >= 0; i--) {
      if (parts[i] !== '') { last = parts[i]; break; }
    }
  }
  LOG_LINES.push(last);
  while (LOG_LINES.length > LOG_MAX_LINES) LOG_LINES.shift();

  if (LOG_DIRTY) return;                 // перерисовка уже запланирована на этот кадр
  LOG_DIRTY = true;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushLog);
  else setTimeout(flushLog, 16);
}

// Часы на ИДУЩЕМ шаге. Просьба живых пользователей: «он крутит эту штуку и непонятно,
// что-то поломалось или процесс идёт». Настоящих процентов у установочных скриптов нет
// (они не сообщают прогресс), и рисовать выдуманную полосу — врать. Честный минимум:
// показать, СКОЛЬКО этот шаг уже идёт. Стоящие часы = завис, растущие = живой.
// Подпись докачки (там проценты настоящие) не трогаем: она перерисовывается своим
// обработчиком прогресса.
let STEP_TIMER = null;
// Фаза внутри шага ПОСЛЕ конца докачки («Устанавливаю»). Пока фаза пуста, часы
// уступают подписи докачки (там настоящие проценты). Раньше уступали ВСЕГДА по
// признаку «%» в тексте — и после «Скачиваю 100%» замирали навсегда: вся установка
// шла под замершей подписью, ровно то, на что жаловались живые пользователи.
let STEP_CLOCK_PHASE = '';
function setStepClockPhase(phase) { STEP_CLOCK_PHASE = phase || ''; }
function startStepClock(id, baseLabel) {
  stopStepClock();
  const t0 = Date.now();
  const tick = () => {
    const step = document.querySelector(`.step[data-id="${id}"]`);
    if (!step || !step.classList.contains('running')) { stopStepClock(); return; }
    const spans = step.querySelectorAll('span');
    const el = spans.length ? spans[spans.length - 1] : null;
    if (!el) return;
    // Пока докачка рисует НАСТОЯЩИЕ проценты — не мешаем ей. Но когда докачка
    // дошла до конца (фаза установки, см. handleRemoteProgress) — часы снова
    // главные и обязаны тикать до реального завершения шага.
    if (!STEP_CLOCK_PHASE) {
      if (/%/.test(el.textContent || '')) return;
    }
    const s = Math.floor((Date.now() - t0) / 1000);
    const phase = STEP_CLOCK_PHASE ? STEP_CLOCK_PHASE + ', ' : '';
    el.textContent = baseLabel + ' — ' + phase + 'идёт ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  STEP_TIMER = setInterval(tick, 1000);
}
function stopStepClock() {
  if (STEP_TIMER) { clearInterval(STEP_TIMER); STEP_TIMER = null; }
  STEP_CLOCK_PHASE = '';
}

// Общий прогресс прогона в ПРОЦЕНТАХ. Проценты настоящие — доля пройденных
// компонентов от выбранных; внутри шага скрипты прогресс не сообщают, поэтому там
// идут секунды (startStepClock), а выдуманную полосу мы не рисуем.
function setRunProgress(done, total, currentName, bad, okCount, skippedCount) {
  const box = document.getElementById('run-progress');
  const fill = document.getElementById('run-progress-fill');
  const label = document.getElementById('run-progress-label');
  if (!box || !fill || !label) return;
  box.classList.remove('hidden');
  const pct = window.HMFinishLink.runProgressPct(done, total);
  fill.style.width = pct + '%';
  // «100% · 15 из 15» при двух упавших компонентах — так было, и человек читал это
  // как «всё установилось». В числитель шло ЧИСЛО ОБРАБОТАННЫХ (ok + упавшие +
  // пропущенные), то есть полоса заполнялась одинаково при успехе и при провале.
  // Живой пример: у ученика внизу стояло «Готово: 12 · Ошибок: 2 · Пропущено: 1»,
  // а полоса сверху рапортовала 100% и 15 из 15 — две строки на одном экране
  // противоречили друг другу, и верили верхней.
  // Числитель «установлено» — РЕАЛЬНО прошедшие, а не «всё, кроме упавших». Полосу выше
  // уже чинили от того же обмана, но подпись осталась считать `total − failedN`: на
  // пятнадцати шагах, где третий упал, она объявляла «установлено 14 из 15», хотя встали
  // два, а двенадцать даже не запускались. Пропущенные называем отдельно — они не
  // установлены и не сломаны, и молча приписывать их к любой из двух групп нельзя.
  const failedN = Number(bad) || 0;
  const okN = Number.isFinite(okCount) ? okCount : Math.max(0, (Number(done) || 0) - failedN);
  const skipN = Number(skippedCount) || 0;
  fill.classList.toggle('warn', failedN > 0);
  const base = failedN > 0 || skipN > 0
    ? `${pct}% пройдено · установлено ${okN} из ${total}`
      + (failedN > 0 ? ` · с ошибкой ${failedN}` : '')
      + (skipN > 0 ? ` · пропущено ${skipN}` : '')
    : `${pct}% · ${done} из ${total}`;
  label.textContent = currentName ? `${base} · сейчас: ${currentName}` : base;
}

function setStep(id, status) {
  const step = document.querySelector(`.step[data-id="${id}"]`);
  if (step) step.className = 'step ' + status;
}

// Подменяет текст шага (последний <span>) — для прогресса докачки
// remote-компонента («Скачиваю uv… 45%»), не трогая класс/статус.
function setStepLabel(id, text) {
  const step = document.querySelector(`.step[data-id="${id}"]`);
  if (!step) return;
  const spans = step.querySelectorAll('span');
  if (spans.length) spans[spans.length - 1].textContent = text;
}

let LAST_ENV = null;

function buildSteps(ids) {
  const list = $('#step-list');
  list.innerHTML = '';
  ids.forEach((id) => {
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.id = id;
    li.innerHTML = `<span class="dot"></span><span>${STATE.byId[id].name}</span>`;
    list.appendChild(li);
  });
}

// Does any (transitive) requirement of id sit in the failed/skipped sets?
// Returns the offending dependency id, or null.
// A18: если упал обязательный базовый шаг (git, node, claude), для всех последующих
// рабочих шагов (кроме финальной диагностики verify) он возвращает id упавшего базового шага,
// останавливая конвейер установки и помечая оставшиеся шаги как пропущенные.
function firstBrokenDep(id, badSet) {
  if (id !== 'verify' && STATE.abortedByMandatoryId && STATE.abortedByMandatoryId !== id && badSet && badSet.has(STATE.abortedByMandatoryId)) {
    return STATE.abortedByMandatoryId;
  }
  const reqs = (STATE.byId[id] && STATE.byId[id].requires) || [];
  for (const r of reqs) {
    if (badSet.has(r)) return r;
    const deeper = firstBrokenDep(r, badSet);
    if (deeper) return deeper;
  }
  return null;
}

// ---- ЧЕСТНЫЙ КАСКАД ----
// Раньше зависимый компонент печатал ровно одну строку: «Пропущено: не установлена
// зависимость «VS Code»». Формально правда, но человеку она не даёт НИЧЕГО: он видит
// шесть таких строк подряд и не понимает, что случилось на самом деле, что чинить
// первым и не сломан ли его компьютер. Причина при этом ИЗВЕСТНА — она лежит в
// badWhy, куда её кладёт ветка провала (вид ошибки + человеческое объяснение из
// main). Собираем из этого одно понятное предложение.
//
// badWhy: id → { kind: 'net'|'integrity'|'env'|'fail'|'skip', hint?: строка }
const DEP_WHY_TEXT = {
  net: 'не удалось скачать — оборвалось соединение',
  integrity: 'скачанный файл не прошёл проверку подлинности',
  env: 'не подготовилась защищённая папка загрузки — часто мешает антивирус',
  skip: 'его нет в этой сборке — ставить было нечего',
  fail: 'установка не удалась',
};
function depSkipMessage(id, depId, badWhy) {
  const me = (STATE.byId[id] && STATE.byId[id].name) || id;
  const dep = (STATE.byId[depId] && STATE.byId[depId].name) || depId;
  const why = badWhy && badWhy.get ? badWhy.get(depId) : null;
  const reason = (why && why.hint) || (why && DEP_WHY_TEXT[why.kind]) || DEP_WHY_TEXT.fail;
  return [
    `[~] «${me}» пропущен — он работает только вместе с «${dep}», а «${dep}» не установился (${reason}).`,
    `    Это не отдельная поломка: почини «${dep}» — и «${me}» встанет сам.`,
    `    Как: нажми «Повторить» на шаге «${dep}» (или общую кнопку повтора внизу).`,
  ].join('\n');
}

// Провал ДОКАЧКИ бывает двух РАЗНЫХ природ, а main отдаёт для обеих stage:'fetch':
//   СЕТЬ         — обрыв/таймаут/зеркало не ответило: лечится ретраем;
//   ЦЕЛОСТНОСТЬ  — SHA-256 не совпал, распаковка fail-closed, нет валидного SHA в
//                  реестре, нет сборки для платформы. Это ДЕТЕРМИНИРОВАННО: авто-ретрай
//                  бесполезен (и стоит ещё ~1.5 ГБ трафика), а «проверь интернет»
//                  уводит пользователя не туда — чинить Wi-Fi при подменённом или
//                  устаревшем артефакте бессмысленно, это надо эскалировать.
// Признак: явный stage:'integrity' (если main его отдаёт) ИЛИ маркер в тексте ошибки.
// ТОЛЬКО подмена/расхождение содержимого. Раньше сюда попадали «нет прав администратора»
// и «не удалось создать защищённый кэш» — среда, а не атака: пользователю показывалось
// «Проверка целостности не пройдена» БЕЗ кнопки «Повторить», хотя повтор всё чинит.
// Стадию теперь авторитетно ставит main (stage:'integrity'); регекс — узкий фолбэк.
const INTEGRITY_ERR_RE = /SHA-?256|checksums\.json|не совпал|подмен/i;
function isIntegrityFail(res) {
  if (!res || res.ok) return false;
  if (res.stage === 'integrity') return true;
  if (res.stage !== 'fetch') return false;
  return INTEGRITY_ERR_RE.test(String(res.error || ''));
}
// Сетевой обрыв докачки = stage 'fetch' И НЕ провал целостности/среды.
// Отказ СРЕДЫ (не сеть и не подмена): не удалось подготовить защищённый каталог
// загрузки. Раньше это показывалось как «Сеть оборвалась», и пользователь бесконечно
// жал «Повторить», хотя чинится это запуском от администратора.
function isEnvFail(res) { return !!(res && !res.ok && res.stage === 'env'); }
// main сам распознаёт НЕсетевые провалы докачки («EPERM при публикации распаковки» —
// антивирус держит файл; «HTTP 403» — сервер отказал) и присылает их вид в hintKind.
// Такие — не «Сеть оборвалась»: авто-повтор их не лечит, а совет «проверь интернет»
// уводит не туда. Они идут в ветку с названной причиной (res.hint).
function isNetFail(res) {
  return !!(res && !res.ok && res.stage === 'fetch' && !isIntegrityFail(res) &&
    (!res.hintKind || res.hintKind === 'network'));
}
// Автоматический второй заход — на сетевом обрыве И на «файл держит антивирус» (EPERM при
// публикации распаковки): база повторяла любой нецелостный провал докачки, а после разбора причин
// file-locked остался без повтора, и тот, кому со второго раза обычно везёт, упирался в оранжевый
// шаг и кнопку «Повторить». 403, нехватка места и целостность повтора НЕ получают: результат тот же.
function isAutoRetryFail(res) {
  return isNetFail(res) || !!(res && !res.ok && res.stage === 'fetch' && res.hintKind === 'file-locked');
}

async function runComponents(ids, env) {
  STATE.runActive = true; // inline-«Повторить» на шагах заблокированы до конца прогона
  STATE.abortedByMandatoryId = '';
  const off = window.installer.onLog(({ line }) => {
    // Строки "CHECK ok <ярлык>" / "CHECK fail <ярлык>" от verify-скрипта не
    // сыпем в общий лог — собираем для чеклиста на финальном экране.
    if (line.startsWith('CHECK ')) {
      const m = line.match(/^CHECK (ok|fail|skip)\s+(.*)$/);
      if (m) { STATE.checks.push({ status: m[1], ok: m[1] === 'ok', label: m[2] }); return; }
    }
    if (STATE.repairMode) collectRepairLine(line);   // что напечатал verify — на финиш ремонта
    appendLog(line);
  });
  const failed = [];
  // Два РАЗНЫХ вида пропуска (см. ветки ниже):
  //   depSkipped      — не встала ЗАВИСИМОСТЬ (это проблема: идёт в retry, ломает okAll);
  //   gracefulSkipped — осознанный exit 120 «нечего ставить / не входит в сборку»
  //                     (это НЕ ошибка: не идёт в retry, НЕ ломает okAll, не шлётся в ok:false).
  const depSkipped = [];
  const gracefulSkipped = [];
  // Необязательные компоненты, которые не встали (components.json → optional): жёлтые,
  // идут в повтор, но ok прогона не роняют.
  const softFailed = [];
  // Частично вставшие (код 121): id → объяснение. Кумулятивно, как badEver.
  STATE.partialEver = STATE.partialEver || new Map();
  const bad = new Set();
  // Компоненты, пропущенные В ХОДЕ прогона (dep-провал ИЛИ осознанный exit-120-skip).
  // Их убираем из HM_SELECTED перед verify, иначе verify нарисует по ним красный крест.
  // КУМУЛЯТИВНО через прогоны (живёт в STATE, сбрасывается только новым startInstall):
  // на «Повторить» run1-пропуски (vscode/extension/nomad exit-120) обязаны остаться
  // исключёнными, иначе verify нарисует по ним ложные кресты на уже починенной сборке.
  STATE.installedEver = STATE.installedEver || new Set();
  STATE.skippedEver = STATE.skippedEver || new Set();
  const runtimeSkipped = STATE.skippedEver;
  // НЕРЕШЁННЫЕ проблемы — тоже КУМУЛЯТИВНО (id → 'net' | 'integrity' | 'fail' | 'dep').
  // Inline-«Повторить» на одном шаге запускает прогон ТОЛЬКО из этого id (+verify), и
  // per-прогонные failed/depSkipped после него пусты → финиш рапортовал бы «Готово!
  // Всё установлено», хотя остальные компоненты так и не встали, а кнопки повтора уже
  // нет. Карта переживает прогоны (сбрасывается только новым startInstall) и чистится
  // ровно тогда, когда компонент реально встал или осознанно пропущен.
  STATE.badEver = STATE.badEver || new Map();
  const badEver = STATE.badEver;
  // ПОЧЕМУ компонент оказался в bad — нужно зависимым, чтобы объяснить каскад
  // словами, а не строкой «не установлена зависимость». Кумулятивно, как badEver:
  // inline-«Повторить» одного шага не должен стирать причину, из-за которой
  // зависимые были пропущены в прошлом прогоне.
  STATE.badWhy = STATE.badWhy || new Map();
  const badWhy = STATE.badWhy;
  let ok = 0;
  for (const id of ids) {
    appendLog(`\n=== ${STATE.byId[id].name} ===`);
    // If a dependency failed, skip (don't run) — a cascade of reds would hide the root cause.
    const broken = firstBrokenDep(id, bad);
    if (broken) {
      setStep(id, 'skipped');
      depSkipped.push(id);
      bad.add(id);
      badEver.set(id, 'dep');
      runtimeSkipped.add(id);
      // Причина каскада наследуется: если зависимого пропустят дальше по цепочке,
      // он назовёт КОРНЕВУЮ причину, а не «упала зависимость зависимости».
      badWhy.set(id, badWhy.get(broken) || { kind: 'fail' });
      setStepLabel(id, `${STATE.byId[id].name} — ждёт «${STATE.byId[broken].name}»`);
      appendLog(depSkipMessage(id, broken, badWhy));
      $('#progress-summary').textContent = `Готово: ${ok} · Ошибок: ${failed.length} · Пропущено: ${depSkipped.length + gracefulSkipped.length} · Всего: ${ids.length}`;
      setRunProgress(ok + failed.length + softFailed.length + depSkipped.length + gracefulSkipped.length, ids.length, '', failed.length,
      ok, softFailed.length + depSkipped.length + gracefulSkipped.length);
      continue;
    }
    // Свежий прогон проверки — старые результаты чеклиста неактуальны.
    if (id === 'verify') STATE.checks = [];
    setStep(id, 'running');
    STATE.currentStepId = id;   // отчёт для поддержки посреди прогона называет этот шаг
    startStepClock(id, (STATE.byId[id] && STATE.byId[id].name) || id);
    setRunProgress(ok + failed.length + softFailed.length + depSkipped.length + gracefulSkipped.length,
      ids.length, (STATE.byId[id] && STATE.byId[id].name) || id, failed.length,
      ok, softFailed.length + depSkipped.length + gracefulSkipped.length);
    // Компонент реально ЗАПУСКАЕТСЯ → больше НЕ «осознанно пропущенный» из прошлого
    // прогона: снимаем из кумулятивного skippedEver. Снова graceful-skip (res.skipped
    // ниже) — вернётся; упадёт КРАСНЫМ — останется снятым, и verify обязан проверить
    // его и нарисовать честный крест, а не «– (не выбрано)».
    runtimeSkipped.delete(id);

    // Remote-компонент: докачку+проверку+распаковку+запуск делает АТОМАРНО main
    // внутри runComponent (renderer не задаёт путь кэша и не вклинивается между
    // шагами — см. main.js). Здесь только показываем прогресс докачки в step-list;
    // логи докачки и «целостность подтверждена (SHA-256)» приходят из main по
    // тому же каналу component-log. Провал докачки → res.stage==='fetch'.
    // Remote = явный флаг components.json ИЛИ lite-авто-remote (bootstrap.remoteSizes —
    // карта из main по loadRemoteMaps; в lite components.json remote-флагов не несёт).
    const comp = STATE.byId[id];
    const isRemote = !!(comp && comp.remote) || (STATE.remoteSizes && STATE.remoteSizes[id] != null);
    let offP = null;
    if (comp && isRemote) {
      setStepLabel(id, `${comp.name} — Скачиваю…`);
      appendLog(`[↓] Докачка ${comp.name} из облака…`);
      offP = window.installer.onRemoteProgress((p) => handleRemoteProgress(id, comp.name, p));
    }

    // verify читает HM_SELECTED, чтобы печатать "skip" для НЕ выбранных. Компоненты,
    // осознанно пропущенные В ХОДЕ прогона (exit 120 — нечего ставить — или из-за
    // провала зависимости), из HM_SELECTED для verify убираем: иначе он нарисует по
    // ним красный крест, хотя их корректно не ставили.
    let runEnv = env;
    if (id === 'verify' && runtimeSkipped.size) {
      const sel = String((env && env.HM_SELECTED) || '').split(',')
        .filter((s) => s && !runtimeSkipped.has(s));
      runEnv = Object.assign({}, env, { HM_SELECTED: sel.join(',') });
    }

    let res;
    try { res = await window.installer.runComponent(id, runEnv); }
    catch (e) { res = { id, ok: false, code: -1, error: String(e) }; }

    // ERROR-NET: обрыв ДОКАЧКИ (stage 'fetch') — это сеть, не провал установки.
    // ОДИН авто-ретрай внутри прогона: повторный runComponent того же id (main
    // заново пробует зеркала). Сетевой сбой НИКОГДА не маппится в graceful-skip.
    // Авто-ретрай — ТОЛЬКО на сетевом обрыве. Провал целостности/среды детерминирован:
    // повтор дал бы тот же результат ценой ещё одной полной докачки.
    if (isAutoRetryFail(res)) {
      const locked = !isNetFail(res);
      appendLog(locked
        ? `[↻] ${STATE.byId[id].name}: система не дала записать файл (похоже на антивирус) — пробую ещё раз через несколько секунд…`
        : `[↻] ${STATE.byId[id].name}: сеть оборвалась при докачке (${res.error || 'нет соединения'}) — пробую ещё раз…`);
      setStepLabel(id, locked ? `${comp.name} — файл занят, повторяю…` : `${comp.name} — сеть оборвалась, повторяю…`);
      // Антивирусу нужна пара секунд, чтобы отпустить свежераспакованные файлы; сеть ждать не надо.
      if (locked) await new Promise((r) => setTimeout(r, STATE.fileLockRetryMs == null ? 5000 : STATE.fileLockRetryMs));
      try { res = await window.installer.runComponent(id, runEnv); }
      catch (e) { res = { id, ok: false, code: -1, stage: 'fetch', error: String(e) }; }
    }

    stopStepClock();
    if (offP) { offP(); setStepLabel(id, comp.name); } // вернуть обычную подпись
    else setStepLabel(id, (STATE.byId[id] && STATE.byId[id].name) || id);   // снять «идёт М:СС»
    removeStepSkip(id);   // шаг завершился — кнопка «Пропустить шаг» больше не нужна

    if (res && res.skipped) {
      // P1: осознанный пропуск (exit 120 — нечего ставить, напр. VS Code не вшит в
      // сборку И не установлен). НЕ успех и НЕ ошибка: skipped + в bad, чтобы зависимые
      // не запускались красным впустую. Из HM_SELECTED для verify компонент уже убираем.
      setStep(id, 'skipped');
      gracefulSkipped.push(id);
      bad.add(id);
      runtimeSkipped.add(id);
      // Причину пропуска сохраняем: код 120 приходит и от «не вшито в сборку», и от
      // «нет сети», и от fail-closed отказа по подписи. Без неё финиш подписывал все
      // случаи одинаково — «не входит в эту сборку, это не ошибка».
      const skipWhy = (res.skipReason || '').trim();
      badWhy.set(id, { kind: 'skip', hint: skipWhy });
      badEver.delete(id); // осознанный «нечего ставить» — НЕ нерешённая проблема
      STATE.errorDigest.delete(id);
      STATE.partialEver.delete(id);
      // Пропущен кнопкой «Пропустить шаг» (решение человека, а не «нечего ставить»):
      // подпись шага говорит об этом прямо, чтобы финиш не выглядел как «всё встало».
      if (res.userSkipped) setStepLabel(id, `${STATE.byId[id].name} — пропущен по твоей кнопке`);
      appendLog(`[~] Пропущено: ${STATE.byId[id].name}${skipWhy ? ' — ' + skipWhy : ' (нечего устанавливать)'}.`);
    } else if (res && res.partial) {
      // Код 121: компонент РАБОТАЕТ, а необязательная его часть не встала (например,
      // редактор и панель Claude на месте, панель Codex — нет). Признак и текст строки
      // «ЧАСТИЧНО: …» отдаёт main (res.partial / res.partialReason). Жёлтый шаг с
      // объяснением вместо красного «не установилось»: живой редактор, нарисованный
      // провалом, люди читали как «ничего не встало». В провалы не идёт, ok не роняет.
      setStep(id, 'partial'); ok++;
      badEver.delete(id);
      STATE.errorDigest.delete(id);
      STATE.installedEver.add(id);
      const why = window.HMRunStatus.partialText(res.partialReason);
      STATE.partialEver.set(id, why);
      const name = STATE.byId[id].name;
      const whyShort = why.length > 60 ? why.slice(0, 59).trim() + '…' : why;
      setStepLabel(id, `${name} — работает, но: ${whyShort}`);
      addStepRetry(id);   // повтор может доставить недостающую часть
      appendLog(`[~] ${name}: установлено частично — ${why}. Работать можно; недостающее можно доставить «Повторить».`);
    } else if (res && res.ok) {
      setStep(id, 'done'); ok++;
      badEver.delete(id); // встало — проблема закрыта
      STATE.errorDigest.delete(id);   // поставилось с ретрая — в отчёт ошибка не едет
      STATE.partialEver.delete(id);   // встало целиком — «частично» больше не про него
      // Ground-truth «реально встало» для финиша (nomad/course-карточки): не по
      // per-прогонным спискам, а по факту успеха. (Из skippedEver уже снят при запуске.)
      STATE.installedEver.add(id);
      // Скрепка: false — установщик её НЕ запустил (mascot.ps1: HM-MASCOT launched=0); строка финиша не врёт.
      if (id === 'mascot') STATE.mascotLaunched = res.mascotLaunched;
    }
    else {
      // Сетевой обрыв докачки (после авто-ретрая) — ОРАНЖЕВЫЙ error-net, не красный
      // провал: «Сеть оборвалась» + inline-«Повторить». В failed компонент ВХОДИТ
      // (общий retry/финиш его видят); в graceful-skip НЕ уходит никогда.
      const isNet = isNetFail(res);
      const isIntegrity = isIntegrityFail(res);
      const isEnv = isEnvFail(res);
      // НЕОБЯЗАТЕЛЬНЫЙ компонент (components.json → optional: Cursor, десктоп-приложения,
      // Handy, скрепка, Nomad…) не встал — жёлтый шаг, а не красный: Claude Code и
      // редактор без него работают, и ok прогона из-за него не падает. Причина и
      // «Повторить» — те же, что у обязательного.
      const optional = window.HMRunStatus.isOptional(STATE.byId[id]);
      setStep(id, optional ? 'warn' : ((isNet || isEnv) ? 'error-net' : 'error'));
      if (optional) softFailed.push(id); else failed.push(id);
      bad.add(id);
      // Человеческое объяснение из main (res.hint — «нет готовой версии под этот
      // компьютер», «закончилось место на диске», …). Оно уже напечатано в лог
      // главным процессом; здесь оно нужно, чтобы зависимые назвали КОРНЕВУЮ
      // причину, а не абстрактное «упала зависимость».
      badWhy.set(id, {
        kind: isNet ? 'net' : (isIntegrity ? 'integrity' : (isEnv ? 'env' : 'fail')),
        hint: (res && res.hint) ? String(res.hint) : '',
      });
      // Диагностика для бота: id + стадия + текст. Без стадии «упал git» не отличить от
      // «нет интернета», «нет прав» и «подменён файл», а совет человеку в этих случаях
      // РАЗНЫЙ. Текст чистится от ПД в главном процессе (scrubText) перед отправкой.
      STATE.errorDigest.set(id, {
        id,
        stage: isNet ? 'net' : (isIntegrity ? 'integrity' : (isEnv ? 'env' : 'fail')),
        // Опознанный вид причины (hintKind) кладём В ТЕКСТ ошибки: без него бот
        // видит «код 1» и не может отличить «нет сборки под эту машину» (чинится
        // только новой сборкой) от «оборвалась сеть» (чинится повтором). Схему
        // события в main не трогаем — она валидируется по allowlist полей.
        error: (res && res.hintKind ? '[' + res.hintKind + '] ' : '')
          + String((res && res.error) || ('код ' + (res ? res.code : '?'))),
      });
      badEver.set(id, optional ? 'optional' : (isNet ? 'net' : (isIntegrity ? 'integrity' : (isEnv ? 'env' : 'fail'))));
      const name = STATE.byId[id].name;
      if (optional) appendLog(`[~] «${name}» — необязательный компонент: Claude Code и редактор работают и без него.`);
      if (isEnv) {
        // Не сеть, не подмена и не нехватка прав (установщик и так запущен от
        // администратора): защищённый каталог загрузки не успел подготовиться — чаще всего
        // его задерживает антивирус или занятый диск. Повтор через пару минут обычно
        // проходит; повторится — нужен отчёт для поддержки (кнопка на финише).
        setStepLabel(id, `${name} — не подготовилась защищённая папка загрузки (часто мешает антивирус): ` +
          'нажми «Повторить»; повторится — «Скопировать отчёт для поддержки» на финише');
        addStepRetry(id);
        appendLog(`[!] ${name}: ${res.error || 'не удалось подготовить защищённый каталог для загрузки'}`);
      } else if (isNet) {
        setStepLabel(id, `${name} — Сеть оборвалась`);
        addStepRetry(id);
        appendLog(`[!] ${name}: докачка не удалась — ${res.error || 'нет соединения'}. Проверь интернет и нажми «Повторить».`);
      } else if (isIntegrity) {
        // Скачанный файл не совпал с эталоном / среда не даёт защитить кэш: КРАСНЫЙ шаг,
        // БЕЗ кнопки «Повторить» (повтор детерминированно даст то же) и без «проверь интернет».
        setStepLabel(id, `${name} — Проверка целостности не пройдена`);
        appendLog(`[!] ${name}: файл не прошёл проверку подлинности — ${res.error || 'нет деталей'}. Повтор не поможет: нажми «Скопировать отчёт» и вставь текст в чат с ботом.`);
      } else if (res && res.hint) {
        // Причина опознана: на шаге пишем ЕЁ, а не «код 1». Подробное объяснение
        // («что произошло / что делать») main уже вывел в лог сразу после падения.
        setStepLabel(id, `${name} — ${res.hint}`);
        // Причины, которые повтор НЕ чинит: кнопка «Повторить» на них — приглашение
        // к бесконечному циклу. Провал сверки подлинности из той же породы: он
        // детерминирован (тот же файл, тот же эталон), чинится только новой сборкой.
        if (res.hintKind !== 'no-prebuilt-binary' && res.hintKind !== 'no-distribution'
          && res.hintKind !== 'artifact-integrity') addStepRetry(id);
        appendLog(`[!] ${name}: ${res.hint} (подробности выше).`);
      } else {
        // Причина не опознана словарём — но голый код возврата человеку не говорит
        // НИЧЕГО: ни что случилось, ни что делать. main теперь всегда присылает этап
        // (последний заголовок шага из вывода скрипта), и подпись строится по нему.
        const ph = (res && res.phase) ? String(res.phase).replace(/\s*\([^)]*\)\s*$/, '').trim() : '';
        const phShort = ph.length > 46 ? ph.slice(0, 45).trim() + '…' : ph;
        setStepLabel(id, phShort ? `${name} — не удалось: ${phShort}` : `${name} — не удалось`);
        addStepRetry(id);
        appendLog(`[!] ${name}: не удалось${ph ? ' на этапе «' + ph + '»' : ''}`
          + '. Что именно не получилось — в строках выше. Попробуй «Повторить»; '
          + 'если снова не выйдет — нажми «Скопировать отчёт» и вставь текст в чат с ботом поддержки.');
      }
      // A18: при провале обязательного базового шага (git, node, claude) останавливаем
      // выполнение остальных шагов конвейера — следующие итерации цикла уйдут в ветку broken.
      if (MANDATORY_BASE_IDS.has(id)) {
        STATE.abortedByMandatoryId = id;
        appendLog(`[СТОП] Обязательный базовый шаг «${name}» завершился с ошибкой — остальные шаги остановлены.`);
      }
    }
    $('#progress-summary').textContent = `Готово: ${ok} · Ошибок: ${failed.length}`
      + (softFailed.length ? ` · Не встало необязательное: ${softFailed.length}` : '')
      + ` · Пропущено: ${depSkipped.length + gracefulSkipped.length} · Всего: ${ids.length}`;
    setRunProgress(ok + failed.length + softFailed.length + depSkipped.length + gracefulSkipped.length, ids.length, '', failed.length,
      ok, softFailed.length + depSkipped.length + gracefulSkipped.length);
  }
  off && off();
  STATE.runActive = false;
  STATE.currentStepId = '';
  // Финиш строится по КУМУЛЯТИВНОЙ карте нерешённых проблем (badEver), а НЕ по
  // per-прогонным спискам: inline-«Повторить» одного шага запускает прогон только
  // из него (+verify), per-прогонные failed/depSkipped после него пусты — финиш
  // рапортовал бы «Готово! Всё установлено», хотя остальные провалы никуда не
  // делись, и кнопки повтора на них уже не было бы. Карта чистится ровно тогда,
  // когда компонент реально встал (res.ok) или осознанно пропущен (res.skipped).
  const unresolved = Array.from(badEver);
  return {
    // failed — только ОБЯЗАТЕЛЬНОЕ: именно оно решает исход прогона.
    failed: unresolved.filter(([, k]) => k !== 'dep' && k !== 'optional').map(([i]) => i),
    // Необязательное, что не встало: жёлтым на финише, в повтор — да, в провал — нет.
    softFailed: unresolved.filter(([, k]) => k === 'optional').map(([i]) => i),
    depSkipped: unresolved.filter(([, k]) => k === 'dep').map(([i]) => i),
    fetchFailed: unresolved.filter(([, k]) => k === 'net').map(([i]) => i),
    integrityFailed: unresolved.filter(([, k]) => k === 'integrity').map(([i]) => i),
    partial: Array.from(STATE.partialEver.keys()),
    gracefulSkipped,
  };
}

// Событие прогресса докачки для идущего шага (вынесено из runComponents, чтобы
// тестироваться без Electron). Пока идут байты — рисуем настоящие проценты и часы
// молчат. Когда докачка ДОШЛА ДО КОНЦА (100% или received==total) — у КАЖДОГО
// докачиваемого компонента дальше начинается собственно установка, и событий
// прогресса больше не будет: если подпись не сменить, на всю самую долгую фазу
// экран замирает на «Скачиваю 100%» (жалоба живых пользователей). Поэтому здесь
// подпись переключается на «Устанавливаю…», а часам возвращается право тикать
// (setStepClockPhase) до реального завершения шага.
function handleRemoteProgress(id, name, p) {
  if (!p || p.id !== id) return;
  const doneDl = (p.pct != null && p.pct >= 100) || (p.total > 0 && p.received >= p.total);
  if (doneDl) {
    setStepClockPhase('Устанавливаю');
    setStepLabel(id, `${name} — Устанавливаю…`);
    return;
  }
  // Сеть могла оборваться и докачка началась заново (ретрай) — проценты снова главные.
  setStepClockPhase('');
  setStepLabel(id, remoteProgressLabel(name, p));
}

// «Скачиваю 45% · 12 из 27 МБ» — подпись шага докачки (received/total шлёт main).
function remoteProgressLabel(name, p) {
  const mb = (n) => Math.max(0, Math.round(Number(n || 0) / (1024 * 1024)));
  if (p.pct != null && p.total) {
    return `${name} — Скачиваю ${p.pct}% · ${mb(p.received)} из ${mb(p.total)} МБ`;
  }
  if (p.received) return `${name} — Скачиваю… ${mb(p.received)} МБ`;
  return `${name} — Скачиваю…`;
}

// Inline-кнопка «Повторить» на шаге с оборванной докачкой (error-net). Повтор — через
// СУЩЕСТВУЮЩИЙ механизм retryFailed([id]) (runComponent того же id + verify в конце).
// До конца текущего прогона кнопка выключена (finishInstall включает) — второй
// параллельный прогон не запускаем.
function addStepRetry(id) {
  const step = document.querySelector(`.step[data-id="${id}"]`);
  if (!step || step.querySelector('.step-retry')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-sm step-retry';
  b.textContent = 'Повторить';
  b.disabled = true;
  b.addEventListener('click', () => { if (!STATE.runActive) retryFailed([id]); });
  step.appendChild(b);
}

// Карусель советов на время установки: то, что спасает новичка в первый день
// (сжато из памятки «Что дальше»). Общие для обоих установщиков — без курса.
const TIPS = [
  '<kbd>Esc</kbd> мгновенно останавливает Claude. Писать «стой» в чат бесполезно — сообщение просто встанет в очередь.',
  'Испортил файл? <code>/rewind</code> откатит правки: Claude сам делает точку сохранения перед каждым изменением.',
  'Открывая папку, VS Code (или Cursor) спросит «Do you trust the authors?» — жми <b>Yes</b>, иначе панель Claude молча не заработает.',
  'Твой чат — панель Claude со значком <b>✳</b>. В Cursor не перепутай с его встроенным чатом (<kbd>Ctrl</kbd>+<kbd>L</kbd>) — это отдельный платный продукт.',
  '<kbd>Ctrl</kbd>+<kbd>Esc</kbd> открывает панель Claude из любого места VS Code (и Cursor).',
  'Квота подписки общая: переписка на claude.ai и работа в Claude Code тратят один лимит. Остаток покажет <code>/usage</code>.',
  '«Limit reached» — не поломка. Время сброса написано прямо в сообщении, ничего не теряется.',
  'Скриншот в чат: Windows — <kbd>Alt</kbd>+<kbd>V</kbd>, Mac — <kbd>Ctrl</kbd>+<kbd>V</kbd>. Или перетащи файл, зажав <kbd>Shift</kbd>.',
  'Одна задача — один разговор. Закончил — <code>/clear</code>, и следующая задача пойдёт быстрее и точнее.',
  'Правый клик по файлу → <b>Open Timeline</b>: VS Code хранит прошлые версии каждого файла, даже без git.',
  'Claude спрашивает разрешение перед каждой правкой. Это твоя страховка — не отключай её.',
  'Claude «только рассказывает», но не делает? Ты случайно включил режим плана — нажми <kbd>Shift</kbd>+<kbd>Tab</kbd>.',
  'Что-то сломалось — набери <code>/doctor</code>: он сам проверит установку и предложит починить.',
  'Говори целями, а не шагами: «сделай сайт-визитку с прайсом и формой» работает лучше пошаговых команд.',
  'Попроси Claude вести файл <code>NOTES.md</code> — и новый разговор продолжит ровно с того места.',
  'После установки на рабочем столе появится памятка «Что дальше» — в ней ответы на весь первый день.',
];
let TIPS_TIMER = null;
function startTips() {
  const box = $('#tips'), txt = $('#tips-text');
  if (!box || !txt) return;
  // Второй старт без стопа затирал бы дескриптор, и первый setInterval остался бы
  // крутиться навсегда: stopTips гасит только последний. Сегодня пути двойного
  // старта нет (start/stop парные), но цена страховки — одна строка, а цена
  // осиротевшего таймера — советы, мигающие вдвое быстрее до конца установки.
  if (TIPS_TIMER) { clearInterval(TIPS_TIMER); TIPS_TIMER = null; }
  let i = Math.floor(Math.random() * TIPS.length);
  const show = () => {
    txt.classList.remove('tips-in');
    txt.innerHTML = TIPS[i % TIPS.length];
    // reflow, чтобы анимация появления срабатывала на каждом совете
    void txt.offsetWidth;
    txt.classList.add('tips-in');
    i++;
  };
  show();
  box.classList.remove('hidden');
  TIPS_TIMER = setInterval(show, 12000);
}
function stopTips() {
  if (TIPS_TIMER) { clearInterval(TIPS_TIMER); TIPS_TIMER = null; }
  const box = $('#tips');
  if (box) box.classList.add('hidden');
}

// opts.repair === true — режим «Проверить и починить»: в прогоне ТОЛЬКО скрытый verify
// (см. repairEnv). Обработчик клика передаёт сюда Event, поэтому режим включается строго
// по `repair === true`, а не по самому факту аргумента.
async function startInstall(opts) {
  const repair = !!(opts && opts.repair === true);
  // Жёсткий стоп при App-Translocation / оторванном vendor: даже если кнопку как-то
  // нажали — установку не начинаем, повторно показываем блокирующее окно.
  if (STATE.vendorBlocked) { renderVendorBlock(); return; }
  if (repair && !STATE.byId.verify) return;
  const order = repair ? ['verify'] : ensureVerifyLast(installOrder());
  if (!order.length) return;
  // Места мало — переспрашиваем ДО начала, а не обрываемся на середине (не блокируем:
  // оценка с запасом, и человек вправе рискнуть). Ремонт ничего не ставит — не спрашиваем.
  const needGB = repair ? 0 : diskNeedGB();
  if (STATE.freeGB !== null && needGB > 0 && STATE.freeGB < needGB) {
    const go = window.confirm('Места может не хватить.\n\nДля выбранного нужно примерно ' + needGB +
      ' ГБ, а свободно ' + STATE.freeGB + ' ГБ ' + diskVolumeLabel() + '. Установка может оборваться посередине.\n\n' +
      'Лучше освободить место или снять тяжёлые компоненты. Всё равно начать?');
    if (!go) return;
  }
  // Свежая установка — сбрасываем КУМУЛЯТИВНЫЕ (кросс-прогонные) наборы статусов:
  // installedEver (что реально встало хоть раз) и skippedEver (что осознанно
  // пропущено, exit 120). retryFailed их НЕ сбрасывает — иначе теряется, что
  // vscode/nomad/course не входили в сборку, и после «Повторить» verify рисует
  // ложные красные кресты, а финиш врёт «Агент Nomad уже установлен».
  STATE.repairMode = repair;   // true только у «Проверить и починить»
  STATE.repairLines = [];
  STATE.installedEver = new Set();
  STATE.skippedEver = new Set();
  // Карта НЕРЕШЁННЫХ проблем (id → 'net'|'integrity'|'fail'|'dep') — тоже кумулятивная
  // (retryFailed её НЕ сбрасывает): по ней финиш видит ВЕСЬ остаточный набор провалов,
  // а не только результат последнего (возможно, одношагового inline-)прогона.
  STATE.badEver = new Map();
  // Причины провалов (для объяснения каскада) живут ровно столько же, сколько badEver:
  // сбрасываются новой установкой, переживают inline-«Повторить».
  STATE.badWhy = new Map();
  STATE.errorDigest = new Map();
  STATE.partialEver = new Map();   // частично вставшие (код 121) — тоже на весь прогон
  // Защёлки телеметрии сбрасываем вместе с остальным состоянием прогона: иначе вторая
  // попытка (человек починил интернет и запустил установку заново) не отчитается ВООБЩЕ —
  // ни стартом, ни финишем, — а это как раз тот, кому нужна помощь.
  STATE.telemetrySent = false;
  STATE.telemetryStartSent = false;
  // Телеметрия: момент старта (для duration_sec) и согласие — снимаем ДО ухода
  // с экрана выбора (чекбокс #telemetry-opt; нет элемента = считаем согласием,
  // как и было бы по умолчанию).
  STATE.installStartedAt = Date.now();
  const telOpt = $('#telemetry-opt');
  STATE.telemetryConsent = !telOpt || !!telOpt.checked;
  $('#view-select').classList.add('hidden');
  $('#view-progress').classList.remove('hidden');
  // Повтор ремонта запускают и с финиша того же экрана: прячем прежний итог.
  const prevFinish = $('#next-steps');
  if (prevFinish) prevFinish.classList.add('hidden');
  const finishBtn = $('#btn-finish');
  if (finishBtn) finishBtn.classList.add('hidden');
  buildSteps(order);
  if (repair) {
    $('#progress-title').textContent = 'Проверяю и чиню…';
    $('#progress-sub').textContent = 'Установленное не переустанавливаю — смотрю настройки в твоём профиле. Это быстро.';
  } else {
    startTips();
  }
  LAST_ENV = repair ? repairEnv() : envForRun();
  sendStartTelemetry(order);
  const res = await runComponents(order, LAST_ENV);
  finishInstall(res);
}

async function retryFailed(ids) {
  // Всегда доганяем verify последним, даже если его не было в failed/skipped —
  // иначе чеклист останется со старыми крестиками у уже починенных компонентов
  // (ensureVerifyLast отфильтрует дубликат и поставит verify в конец).
  ids = ensureVerifyLast(ids.concat('verify'));
  // Свежий прогон проверки: сбрасываем накопленный чеклист, чтобы он
  // перерисовался по свежему запуску verify, а не по старым результатам.
  STATE.checks = [];
  $('#next-steps').classList.add('hidden');
  $('#btn-finish').classList.add('hidden');
  // Маскот обратно в «готовит» — иначе на весь повтор останется грустный/праздничный.
  const m = document.querySelector('#view-progress .mascot');
  if (m) { m.src = 'mascot/loading.webp'; m.alt = 'Омлетон готовит окружение'; }
  buildSteps(ids);
  startTips();
  appendLog(`\n— Повторная установка: ${ids.map((i) => STATE.byId[i].name).join(', ')} —`);
  const res = await runComponents(ids, LAST_ENV || envForRun());
  finishInstall(res);
}

function finishInstall(res) {
  stopTips();
  const failed = res.failed || [];
  // Обрывы докачки (stage 'fetch') — подмножество failed с сетевой формулировкой.
  const fetchFailed = res.fetchFailed || [];
  // Провалы ЦЕЛОСТНОСТИ (SHA-256 mismatch / fail-closed) — подмножество failed:
  // детерминированны, «проверь интернет» и ретрай не помогут — эскалация в бота.
  const integrityFailed = res.integrityFailed || [];
  // depSkipped (упала зависимость) = проблема; gracefulSkipped (exit 120, «не входит
  // в сборку») = НЕ проблема и на исход установки не влияет.
  const depSkipped = res.depSkipped || [];
  const gracefulSkipped = res.gracefulSkipped || [];
  // Необязательное, что не встало, и частично вставшее (код 121) — жёлтым, без провала.
  const softFailed = res.softFailed || [];
  const partial = res.partial || [];
  // Прогон завершён — inline-«Повторить» на error-net-шагах теперь можно нажимать.
  document.querySelectorAll('.step-retry').forEach((b) => { b.disabled = false; });
  // Итог прогона — ОДНОЙ функцией для экрана и для отчёта боту (run-status.js): так
  // экран не может сказать «Готово», пока отчёт уходит с ok=False, и наоборот.
  // Независимая проверка (verify) может найти проблему, даже когда все шаги «прошли»:
  // красный крестик чеклиста = провал, и компонент проверки называется в отчёте.
  // Осознанный exit-120-skip, необязательный провал и код 121 okAll НЕ ломают.
  const report = window.HMRunStatus.installReport({
    failed, softFailed, depSkipped, partial, gracefulSkipped,
    checks: STATE.checks, byId: STATE.byId,
    errors: Array.from(STATE.errorDigest.values()),
    partialWhy: Object.fromEntries(STATE.partialEver || new Map()),
  });
  STATE.lastReport = report;   // «Скопировать отчёт для поддержки» берёт итог отсюда
  const checkFailed = report.checkFailedIds.length > 0;
  const okAll = report.ok;
  let title, sub;
  if (STATE.repairMode) {
    // «Проверить и починить»: праздника «Всё установлено» нет — ничего не ставилось.
    const t = repairTitles(report);
    title = t.title; sub = t.sub;
  } else if (okAll) {
    title = 'Готово!';
    sub = (softFailed.length || partial.length)
      ? 'Главное установлено. Пара необязательных пунктов не встала — подробности ниже, работать это не мешает.'
      : 'Всё установлено. Ниже — три простых шага до первого результата, или нажми кнопку бота — он поведёт дальше.';
  } else if (report.hardFailed.length === 0 && report.hardDepSkipped.length === 0) {
    // Все компоненты встали, но verify нашёл проблему — направляем в лог и бота.
    title = 'Установка завершена, но проверка нашла проблемы';
    sub = 'Нажми «Скопировать отчёт для поддержки» ниже и вставь текст в чат с ботом — поможем разобраться.';
  } else if (integrityFailed.length && failed.every((id) => integrityFailed.indexOf(id) !== -1)) {
    // ВСЕ провалы — целостность: НЕ сеть. «Проверь интернет» увёл бы не туда —
    // подменённый/устаревший артефакт надо эскалировать, а не ретраить.
    title = 'Файл не прошёл проверку подлинности';
    sub = 'Скачанный компонент не совпал с эталоном — установка остановлена. Нажми «Скопировать отчёт для поддержки» ниже и вставь текст в чат с ботом.';
  } else if (fetchFailed.length && failed.every((id) => fetchFailed.indexOf(id) !== -1)) {
    // ВСЕ провалы — обрывы докачки: это сеть, а не установка. Говорим прямо.
    title = 'Сеть оборвалась при скачивании';
    sub = 'Часть компонентов не докачалась. Проверь интернет и нажми «Повторить» — установка продолжится.';
  } else {
    title = 'Установка завершена с предупреждениями';
    sub = 'Часть компонентов не установилась — можно повторить ниже.';
  }
  $('#progress-title').textContent = title;
  $('#progress-sub').textContent = sub;
  // Омлетон реагирует на исход: всё встало — радуется, есть проблемы — задумался.
  const mascot = document.querySelector('#view-progress .mascot');
  if (mascot) {
    mascot.src = okAll ? 'mascot/success.webp' : 'mascot/thinking.webp';
    mascot.alt = okAll ? (STATE.repairMode ? 'Омлетон доволен — проверка прошла' : 'Омлетон доволен — всё установилось') : 'Омлетон задумался — есть проблемы';
  }
  if (STATE.repairMode) renderRepairFinish(report);
  else renderNextSteps(failed, depSkipped, gracefulSkipped, checkFailed, fetchFailed, integrityFailed, softFailed, partial);
  sendInstallTelemetry(report);
  $('#btn-finish').classList.remove('hidden');
  renderProgressBotBanner();   // плашка помощи на финише несёт итоговый payload (C09)
}

// Телеметрия установки: ОДИН POST по завершении (повторные финиши после
// «Повторить неустановленное» не шлют — guard telemetrySent). Opt-out — чекбоксом
// на экране выбора. Везёт исход, id упавших компонентов с ПРИЧИНОЙ и длительность; uid
// добавляет main, если установка пришла по персональной ссылке (renderer его не знает).
// Сам POST делает MAIN (CSP renderer'а запрещает сеть; URL зашит в config.json,
// renderer его не задаёт); там таймаут 5с и все ошибки глотаются — установка от
// телеметрии не зависит ни в каком исходе.
function sendInstallTelemetry(report) {
  if (STATE.telemetrySent || STATE.telemetryConsent === false) return;
  STATE.telemetrySent = true;
  const durationSec = STATE.installStartedAt
    ? Math.max(0, Math.round((Date.now() - STATE.installStartedAt) / 1000))
    : 0;
  const r = report || {};
  try {
    // Поля собирает run-status.js (installReport): ok=False ВСЕГДА с названным
    // компонентом (раньше пять отчётов ушли ok=False с пустым failed — проверка нашла
    // проблему, а шаги «прошли»). Необязательное, что не встало, едет в skipped вместе
    // с осознанными пропусками (exit 120) и ok не роняет; его причина — в errors.
    const p = window.installer.sendTelemetry({
      event: 'installed',
      ok: !!r.ok,
      failed: (r.failed || []).slice(),
      skipped: (r.skipped || []).slice(),
      // Почему именно упало — без этого помощь человеку сводится к «пришли лог».
      errors: (r.errors || []).slice(),
      durationSec,
      // «repair» — прогон «Проверить и починить» (только verify): бот отличает его от
      // установки, иначе «ничего не встало» читалось бы как провал установки.
      mode: STATE.repairMode ? 'repair' : 'install',
    });
    if (p && p.catch) p.catch(() => { /* молча */ });
  } catch (e) { /* телеметрия никогда не ломает финиш */ }
}

// Событие ОТДЕЛЬНО от завершения: кто начал ставить и что выбрал. Без него не видно
// людей, у которых установка не дошла до финиша (закрыл окно, упало намертво,
// перезагрузился) — а это как раз те, кому нужна помощь. Шлётся один раз за прогон.
function sendStartTelemetry(order) {
  if (STATE.telemetryStartSent || STATE.telemetryConsent === false) return;
  STATE.telemetryStartSent = true;
  try {
    const p = window.installer.sendTelemetry({ event: 'install_started', selected: (order || []).slice(),
      mode: STATE.repairMode ? 'repair' : 'install' });
    if (p && p.catch) p.catch(() => { /* молча */ });
  } catch (e) { /* телеметрия никогда не ломает установку */ }
}

// «Открыл редактор» — единственный сигнал, что человек реально пошёл работать, а не
// просто получил зелёные галочки и закрыл окно.
// Ошибки записи — человеческим языком, а не сырым текстом Node.
//
// Наружу шли строки вида «Error: EACCES: permission denied, open 'C:\Users\…\.claude\
// .credentials.master.env'». Новичку, ради которого весь этот установщик и написан, они
// не говорят ничего — зато выкладывают на экран путь к файлу ключей. Ниже — те коды,
// что реально сюда доходят; всё прочее сворачиваем в общий совет, а технический текст
// оставляем в логе (он уже там), не на экране.
function humanIoError(raw) {
  const s = String(raw || '');
  if (!s) return 'неизвестная ошибка. Попробуй ещё раз или нажми «Скопировать отчёт для поддержки» и вставь текст в чат с ботом.';
  if (/EACCES|EPERM/.test(s)) {
    return 'нет прав на запись. Закрой Claude Code и редактор, потом попробуй снова; если не поможет — '
      + 'запусти установщик правым кликом → «Запуск от имени администратора».';
  }
  if (/ENOSPC/.test(s)) return 'на диске кончилось место. Освободи немного и попробуй снова.';
  if (/EBUSY|ETXTBSY/.test(s)) return 'файл занят другой программой. Закрой Claude Code и Cursor, потом попробуй снова.';
  if (/EROFS/.test(s)) return 'диск доступен только для чтения.';
  if (/EISDIR|ENOTDIR/.test(s)) return 'по этому пути лежит папка вместо файла — так бывает после сбоя. Нажми «Скопировать отчёт для поддержки» и вставь текст в чат с ботом.';
  if (/EMFILE|ENFILE/.test(s)) return 'система исчерпала лимит открытых файлов. Перезагрузи компьютер и повтори.';
  // Своё осмысленное сообщение (например, из credentials-merge) пропускаем как есть:
  // оно уже написано для человека. Признак — отсутствие «Error:» и кода в верхнем регистре.
  if (!/^Error:|\b[A-Z]{4,}\b/.test(s)) return s;
  return 'ошибка записи. Нажми «Скопировать отчёт для поддержки» и вставь текст в чат с ботом — там полный текст.';
}

function sendOpenEditorTelemetry() {
  // Защёлка на прогон: кнопок, ведущих сюда, три (финиш с автозапуском, «Открыть VS
  // Code», «Открыть Cursor»), а обратной связи у них нет — человек жмёт повторно, пока
  // окно не появится. Без защёлки один прогон давал бы несколько одинаковых событий и
  // воронка считала бы их разными людьми.
  if (STATE.telemetryConsent === false || STATE.telemetryEditorSent) return;
  STATE.telemetryEditorSent = true;
  try {
    const p = window.installer.sendTelemetry({ event: 'open_editor', ok: true });
    if (p && p.catch) p.catch(() => { /* молча */ });
  } catch (e) { /* никогда не мешаем запуску редактора */ }
}

// Подсказка под кнопкой «Открыть VS Code» — одним местом для всех, кто её показывает.
// Раньше «Готово» звало эту подсказку через cta.click(), а браузер клик по КНОПКЕ С
// disabled не доставляет вовсе. Кнопка же ровно в этом случае и стоит отключённой —
// когда редактора нет. Получалось: галка автозапуска отмечена по умолчанию, человек
// жмёт «Готово», установщик не закрывается, не открывает ничего и молчит.
function showEditorHint(text) {
  const cta = document.querySelector('#ns-vscode');
  if (!cta || !cta.parentElement) return false;
  let hint = cta.parentElement.querySelector('.ns-vscode-err');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'ns-course-err ns-vscode-err';
    cta.parentElement.appendChild(hint);
  }
  hint.textContent = text;
  return true;
}

function renderNextSteps(failed, depSkipped, gracefulSkipped, checkFailed, fetchFailed, integrityFailed, softFailed, partial) {
  failed = failed || [];
  depSkipped = depSkipped || [];
  gracefulSkipped = gracefulSkipped || [];
  checkFailed = !!checkFailed;
  fetchFailed = fetchFailed || [];
  integrityFailed = integrityFailed || [];
  softFailed = softFailed || [];
  partial = partial || [];
  const links = (STATE.config && STATE.config.links) || {};
  const fin = (STATE.config && STATE.config.finish) || {};
  const botH = botHandle();
  const isWin = STATE.platform === 'win32';
  // Cursor опционален: кнопку «Открыть Cursor» показываем ТОЛЬКО если пользователь его выбрал.
  const cursorSelected = !!(STATE.selected && STATE.selected.cursor);
  const relRaw = fin.credentialsRelPath || '.claude/.credentials.master.env';
  const sep = isWin ? '\\' : '/';
  const rel = isWin ? relRaw.replace(/\//g, '\\') : relRaw.replace(/\\/g, '/');
  const credPath = STATE.homedir ? STATE.homedir + sep + rel : rel;

  // Retry только реальные провалы и dep-skip (перезапуск зависимости может их
  // разблокировать). gracefulSkipped (exit 120) в retry НЕ идёт — там нечего ставить.
  // Необязательное и частично вставшее — идёт: повтор может их доставить, а исход
  // прогона они не портят ни до, ни после.
  const retryList = failed.concat(depSkipped).concat(softFailed).concat(partial);
  const depSkipHtml = depSkipped.length
    ? `<div class="ns-fail">Пропущено (не встала зависимость): <b>${depSkipped.map((i) => STATE.byId[i].name).join(', ')}</b>.</div>`
    : '';
  // Обрывы докачки — сетевая формулировка (не generic-ошибка): «проверь интернет
  // и нажми Повторить». Имена компонентов — из components.json (доверенный конфиг).
  const netHint = fetchFailed.length
    ? `<div class="ns-fail-hint">Сеть оборвалась при докачке: <b>${fetchFailed.map((i) => STATE.byId[i].name).join(', ')}</b>. Проверь интернет и нажми «Повторить неустановленное».</div>`
    : '';
  // Провал целостности — НЕ сетевая формулировка: «проверь интернет» тут вреден,
  // повтор детерминированно даст то же — направляем в лог и бота (эскалация).
  const integrityHint = integrityFailed.length
    ? `<div class="ns-fail-hint">Не прошли проверку подлинности: <b>${integrityFailed.map((i) => STATE.byId[i].name).join(', ')}</b>. Повтор не поможет — нажми «Скопировать отчёт для поддержки» и вставь текст в чат с ${botH}.</div>`
    : '';
  // Названная причина по КАЖДОМУ упавшему компоненту. Без неё финиш говорил только
  // «не установилось: VS Code» — то есть ровно столько же, сколько «код 1»: человек
  // не знает, мешает ли антивирус, нет ли интернета или дело в его редакторе сборки.
  // Тексты — из нашего словаря причин (failure-explain.js), имена — из components.json;
  // и то и другое наши, поэтому подставляются как есть. Сетевые провалы и провалы
  // подлинности здесь НЕ повторяем: у них свои строки выше.
  const whyMap = (STATE.badWhy && STATE.badWhy.get) ? STATE.badWhy : null;
  const whyLines = whyMap
    ? failed.map((i) => {
      const w = whyMap.get(i);
      if (!w || !w.hint || w.kind === 'net' || w.kind === 'integrity') return '';
      return '<b>' + STATE.byId[i].name + '</b> — ' + w.hint;
    }).filter(Boolean)
    : [];
  const whyHint = whyLines.length
    ? `<div class="ns-fail-hint">Что случилось: ${whyLines.join('; ')}. Подробнее — в логе для поддержки.</div>`
    : '';
  // Редактор — не рядовой компонент: ПЕРВЫЙ шаг инструкции целиком про него, и главная
  // кнопка экрана открывает именно его. Пока это не учитывалось, экран при упавшем
  // VS Code продолжал говорить «Открой VS Code — синяя кнопка ниже» и предлагал
  // активную кнопку, которая ничего не открывала. Человек жал и не понимал, почему
  // «ничего не происходит», а причина — редактора на диске нет.
  //
  // Считать это по одному лишь `failed.includes('vscode')` нельзя: кнопка открывает НЕ
  // только VS Code. launchVsCodeOn (main.js) при отсутствии VS Code берёт Cursor —
  // установщик оба редактора и предлагает на выбор. Человек, который снял VS Code и
  // оставил Cursor (или у которого VS Code упал, а Cursor встал), получал отключённую
  // кнопку и требование «доустанови редактор», хотя рабочий редактор у него на диске.
  // Поэтому «редактора нет» = нет НИ ОДНОГО из двух, а «есть» считается по тем же
  // данным, что и галки на экране выбора: упал сейчас / пропущен → нет; выбран и не
  // упал → поставился; не выбирали → смотрим, был ли обнаружен до установки.
  const editorReady = (id) => {
    if (failed.indexOf(id) !== -1) return false;
    if (gracefulSkipped.indexOf(id) !== -1 || depSkipped.indexOf(id) !== -1) return false;
    if (STATE.selected && STATE.selected[id]) return true;
    const d = STATE.detected && STATE.detected[id];
    return !!(d && d.installed);
  };
  const editorReadyId = ['vscode', 'cursor'].find(editorReady) || '';
  const editorMissing = !editorReadyId;
  const nameOf = (id, dflt) => ((STATE.byId[id] && STATE.byId[id].name) || dflt);
  // В тексте «доустанови» называем VS Code: он рекомендуемый и именно его чинит
  // «Повторить неустановленное». Имя рабочего редактора нужно для обратного случая —
  // когда открывать есть чем, но это Cursor, и звать его «VS Code» было бы ложью.
  const editorMissingName = editorMissing ? nameOf('vscode', 'VS Code') : '';
  const editorReadyName = editorReadyId === 'cursor' ? nameOf('cursor', 'Cursor') : 'VS Code';
  // Красный блок — только при ЖЁСТКОМ провале: не встало обязательное или его зависимость.
  // Если не встало лишь необязательное или частичное, красного нет вовсе, а «Повторить» живёт
  // в жёлтом блоке: красная плашка прямо под «Готово!» противоречила заголовку, а её подсказка
  // посылала к кнопке, спрятанной в «Ещё инструменты».
  const hardProblem = failed.length > 0 || depSkipped.length > 0;
  const retryBtnHtml = '<button type="button" id="ns-retry" class="btn-sm">Повторить неустановленное</button>';
  const failHtml = hardProblem
    ? `<div class="ns-fail">${failed.length ? 'Не установилось: <b>' + failed.map((i) => STATE.byId[i].name).join(', ') + '</b>. ' : ''}
         ${retryBtnHtml}${whyHint}${netHint}${integrityHint}
         <div class="ns-fail-hint">Если повтор не помогает — нажми «Скопировать отчёт для поддержки» ниже и вставь текст в чат с ${botH}.</div></div>` + depSkipHtml
    : '';
  // Осознанный пропуск (не входит в эту сборку) — нейтральная строка, НЕ ошибка и БЕЗ кнопки повтора.
  // Пропущенные — С ПРИЧИНОЙ у каждого. Прежняя строка объявляла ЛЮБОЙ exit 120
  // «не входит в эту сборку», а этот код выдают 74 места скриптов по несовместимым
  // поводам: нет сети, не найден winget, уже стоит чужая установка — и fail-closed
  // отказы безопасности («установщик не прошёл проверку подписи — НЕ запускаю»).
  // Последнее объявлять «не ошибкой» нельзя: человек как раз должен об этом узнать.
  // Текст берём тот, что скрипт напечатал перед выходом (см. skipReason в main.js).
  const skipLines = gracefulSkipped.map((i) => {
    const w = (whyMap && whyMap.get(i)) || null;
    const why = (w && w.hint) ? String(w.hint) : '';
    // Экранируем обязательно: текст пришёл из вывода скрипта и несёт пути, имена
    // файлов и системные сообщения — то есть данные машины пользователя, а не наш
    // литерал. Имена компонентов рядом свои, из components.json.
    return '<b>' + STATE.byId[i].name + '</b>' + (why ? ' — ' + escapeHtml(why) : '');
  });
  const gracefulSkipHtml = gracefulSkipped.length
    ? `<div class="ns-note">Пропущено (устанавливать не стали): ${skipLines.join('; ')}.</div>`
    : '';
  // Необязательное, что не встало, — жёлтым и С ПРИЧИНОЙ, но не как «установка не
  // удалась»: Claude Code и редактор работают и без этого. Причина — наш словарь
  // (failure-explain.js) или этап из вывода скрипта, поэтому экранируем.
  const softLines = softFailed.map((i) => {
    const w = (whyMap && whyMap.get(i)) || null;
    return '<b>' + escapeHtml(nameOfId(i)) + '</b>' + ((w && w.hint) ? ' — ' + escapeHtml(String(w.hint)) : '');
  });
  // Кнопка «Повторить» — в первом из жёлтых блоков, и только если красного нет (см. hardProblem).
  const softHtml = softFailed.length
    ? `<div class="ns-warn">Не встало необязательное: ${softLines.join('; ')}. Claude Code и редактор работают и без этого — можно поставить позже или попробовать ещё раз. ${hardProblem ? '' : retryBtnHtml}</div>`
    : '';
  // Код 121: компонент работает, но без необязательной части. Текст — из строки
  // «ЧАСТИЧНО: …» скрипта, то есть данные машины: только через escapeHtml.
  const partialWhy = STATE.partialEver || new Map();
  const partialHtml = partial.length
    ? `<div class="ns-warn">Установлено частично: ${partial.map((i) => '<b>' + escapeHtml(nameOfId(i)) + '</b>' +
        (partialWhy.get(i) ? ' — ' + escapeHtml(String(partialWhy.get(i))) : '')).join('; ')}. Работать можно уже сейчас. ${hardProblem || softFailed.length ? '' : retryBtnHtml}</div>`
    : '';

  // Deep-link в бота — по РЕЗУЛЬТАТУ установки (pure-логика в finish-link.js, шарится
  // с тестами): всё ок → ?start=installed_win|installed_mac; есть упавшие компоненты →
  // ?start=failed_<первый-упавший-id>_win|_mac (напр. failed_cursor_win). «Упавшие» берём
  // из итога прогона (botFailedIds): verify всегда выходит с 0, и красная ТОЛЬКО проверка
  // после установки раньше давала installed_<os> при ok=False в телеметрии.
  const startPayload = window.HMFinishLink.botStartPayload(botFailedIds(failed), isWin, fin.botStartPayload || 'installed');
  const botUrl = window.HMFinishLink.botUrl(links.bot || '', startPayload);
  // Заметная CTA-карточка бота академии: новичок должен сразу видеть, куда бежать
  // за помощью. Открытие ссылки — через тот же механизм data-ext → openExternal,
  // что и остальные внешние кнопки (обработчик вешается ниже одним querySelectorAll).
  const botCta = botUrl
    ? `<div class="ns-bot">
         <div class="ns-bot-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M21.5 3.6 2.9 10.8c-1 .4-1 1.8.1 2.1l4.6 1.5 1.7 5.2c.3 1 1.6 1.2 2.2.4l2.4-2.9 4.7 3.4c.8.6 2 .2 2.2-.9l2.5-14.2c.2-1.1-.8-2-1.8-1.6Z" fill="#fff"/></svg></div>
         <div class="ns-bot-body">
           <div class="ns-bot-title">Застрял или что-то непонятно?</div>
           <div class="ns-bot-text">Спроси бота-помощника — живого ИИ в Telegram: пиши своими словами, он ответит и проведёт по шагам. Это нормально в первый день.</div>
         </div>
         <button type="button" class="ns-bot-btn" data-ext="${botUrl}">Спросить бота ${botH}</button>
       </div>`
    : '';
  const videoBtn = links.video ? `<button type="button" class="btn-sm" data-ext="${links.video}">▶ Видео: что дальше</button>` : '';
  // Памятка «Что дальше»: START-HERE.html вшит (finish.startHtmlRelPath). На финише
  // копируем её на рабочий стол (постоянная, всегда доступна) и один раз показываем
  // ВСТРОЕННЫЙ просмотр — внешний браузер сам не открываем (холодный дефолтный
  // браузер со своим онбордингом пугает и выглядит как посторонний запуск).
  // Кнопки ниже: переоткрыть встроенный просмотр / явно открыть в браузере.
  const startHtmlRel = fin.startHtmlRelPath || '';
  const startBtn = startHtmlRel
    ? `<button type="button" id="ns-start" class="btn-sm">📌 Памятка «Что дальше»</button>
       <button type="button" id="ns-start-ext" class="btn-sm">Открыть памятку в браузере</button>`
    : '';
  const logBtn = STATE.logPath ? `<button type="button" id="ns-log" class="btn-sm">Показать лог для поддержки</button>` : '';

  // Чеклист из verify-скрипта ("CHECK ok/fail/skip <ярлык>").
  const checks = STATE.checks || [];
  // Ярлык проверки → id компонента.
  //
  // Нужен, чтобы отличить «не выбирал» от «выбрал, но не встала зависимость».
  // Различить их по самому чеклисту нельзя: verify печатает для обоих случаев
  // одинаковый «skip» — dep-пропущенные осознанно вычищаются из HM_SELECTED
  // перед его запуском, чтобы он не рисовал красный крест по тому, что
  // корректно не ставили (см. подготовку runEnv выше).
  //
  // Из-за этого экран противоречил сам себе двумя соседними строками:
  // «Расширение (не выбрано)», а строкой ниже — «Пропущено (не встала
  // зависимость): Расширение Claude Code». Человек на записи ровно на этом
  // блоке и усомнился, стоит ли жать «Повторить неустановленное».
  //
  // Карта дословная и короткая (проверок пять). Разъедется ярлык — вернётся
  // сегодняшнее поведение, а не ошибка: неизвестный ярлык просто не найдётся.
  const CHECK_LABEL_TO_ID = {
    'Git': 'git',
    'Node': 'node',
    'Claude CLI': 'claude',
    'Конфиг': 'config',
    'Расширение': 'extension',
  };
  const depSkippedIds = new Set(depSkipped);
  const checkLi = (c) => {
    const st = c.status || (c.ok ? 'ok' : 'fail');
    // skip = компонент не ставили: рисуем нейтрально (серым), НЕ как провал.
    if (st === 'skip') {
      // Протокол CHECK трёхзначный, а не двузначный. Скрипт может прислать skip с
      // СОБСТВЕННЫМ уточнением в скобках — «Claude CLI (установлен, запуск не
      // проверен)»: это не «не ставили», а «поставили, но запуск подтвердить не вышло».
      // Прежний код брал часть до скобки только для сопоставления id, а причину дописывал
      // свою — и на экране выходило «Claude CLI (установлен, запуск не проверен) (не
      // выбрано)»: дубль скобок и прямая ложь про невыбранный компонент.
      // Если уточнение пришло от скрипта — оно и есть причина; своё дописываем, только
      // когда скрипт молчит.
      const label = String(c.label || '');
      const m = label.match(/^([^(]+)\((.+)\)\s*$/);
      const base = (m ? m[1] : label).trim();
      const own = m ? m[2].trim() : '';
      const cid = CHECK_LABEL_TO_ID[base];
      const why = own || (cid && depSkippedIds.has(cid)
        ? 'не ставили: не встала зависимость'
        : 'не выбрано');
      return `<li class="skip" style="opacity:.5"><span class="mark">–</span><span>${escapeHtml(base)} <span style="font-size:11px">(${escapeHtml(why)})</span></span></li>`;
    }
    return checkLiHtml(st, c.label);   // строка чеклиста и пояснение под красной — в конце файла
  };
  const checksHtml = checks.length
    ? `<div class="ns-checks">
         <div class="ns-checks-title">Проверка установки</div>
         <ul class="ns-check-list">${checks.map(checkLi).join('')}</ul>
       </div>`
    : '';

  // Мини-визард ключей: пишутся merge'ем в .credentials.master.env.
  const keysHtml = `
    <div class="ns-keys">
      <div class="ns-keys-title">API-ключи для доп. сервисов (необязательно — можно добавить позже)</div>
      <div class="ns-keys-grid">
        <input id="key-GOOGLE_API_KEY" type="text" placeholder="GOOGLE_API_KEY — Gemini: картинки, видео" autocomplete="off" spellcheck="false" />
        <input id="key-OPENAI_API_KEY" type="text" placeholder="OPENAI_API_KEY — GPT, DALL-E" autocomplete="off" spellcheck="false" />
        <input id="key-ELEVENLABS_API_KEY" type="text" placeholder="ELEVENLABS_API_KEY — озвучка" autocomplete="off" spellcheck="false" />
      </div>
      <div class="ns-keys-row">
        <button type="button" id="ns-save-keys" class="btn-sm">Сохранить ключи</button>
        <span id="ns-keys-status" class="ns-keys-status"></span>
      </div>
    </div>`;

  // Третий шаг ведёт на бота; если ссылки на бота в конфиге нет — на памятку.
  const step3 = botUrl
    ? `<li><b>Застрял на любом шаге</b> — напиши боту-помощнику (кнопка «Бот-помощник» ниже). Это <b>живой ИИ-ассистент в Telegram</b>: пиши ему вопросы своими словами («не понял, что делать», «как запустить», «просит оплату — что это») — ответит и проведёт по установке, запуску и первому проекту.</li>`
    : `<li><b>Если что-то не получается</b> — открой памятку «Что дальше» ниже: в ней ответы на весь первый день.</li>`;

  // ── Доступ к нейросети (CJM: главный барьер воронки «скачал → Claude заработал») ──
  // Два пути: своя подписка Claude ИЛИ Nomad для РФ (без VPN/зарубежной карты, рубли).
  // Nomad closed beta (29.09.2026): the Nomad card is shown ONLY if Nomad is really installed.
  // Текст карточки — по РЕАЛЬНОМУ статусу установки (не по галочке
  // выбора): компонент прошёл успешно в этом прогоне ИЛИ уже стоял на машине (детект)
  // → «уже установлен»; упал / пропущен (exit 120, lite-сборка) / не выбирался →
  // честное «можно доустановить» (повторный запуск установщика с галочкой Nomad).
  // Ground-truth (кросс-прогонный): «уже установлен» ТОЛЬКО если nomad реально встал
  // в этой сессии (installedEver) ИЛИ был найден на машине детектом. НЕ по per-прогонным
  // спискам — иначе после «Повторить» (где nomad не перезапускался и его нет ни в
  // failed/skipped текущего прогона) карточка ложно звала регистрироваться и вставлять
  // ключ, хотя агента на машине нет (тупик на платном шаге воронки).
  const nomadInstalled =
    !!(STATE.installedEver && STATE.installedEver.has('nomad')) ||
    !!(STATE.detected && STATE.detected.nomad && STATE.detected.nomad.installed);
  const cloud = (STATE.config && STATE.config.nomad && STATE.config.nomad.cloud) || {};
  const claudeUrl = links.claude || 'https://claude.ai/login';
  const nomadText = nomadInstalled
    ? 'Закрытая бета — только для участников теста. Агент Nomad установлен: ключ из кабинета вставь в поле ниже.'
    : 'Nomad сейчас в закрытом тесте у команды.';
  // Поле ввода ключа показываем, только если Nomad реально встал: вписывать ключ в
  // конфиг несуществующего агента — обещание, которое не сработает. Раньше поля не
  // было вовсе, и фраза «получи ключ и вставь его» вела человека в тупик: ключ на
  // руках, вставлять некуда (nmd model — консоль, о ней на экране ни слова).
  const nomadKeyBox = nomadInstalled
    ? `<div class="ns-key">
         <label class="ns-key-lbl" for="ns-nomad-key">Ключ из кабинета (начинается с <code>nmd_</code>):</label>
         <div class="ns-key-row">
           <input type="text" id="ns-nomad-key" class="ns-key-input" spellcheck="false" autocomplete="off" placeholder="nmd_..." />
           <button type="button" id="ns-nomad-save" class="ns-access-btn primary">Сохранить ключ</button>
         </div>
         <div class="ns-key-msg" id="ns-nomad-msg"></div>
       </div>`
    : '';
  const nomadCard = (cloud.registerUrl && nomadInstalled)
    ? `<div class="ns-access-card ns-access-card--hl">
         <div class="ns-access-h">🇷🇺 Из России — через Nomad</div>
         <div class="ns-access-t">${nomadText}</div>
         <div class="ns-access-btns">
           <button type="button" class="ns-access-btn primary" data-ext="${cloud.registerUrl}">Регистрация в кабинете</button>
           ${cloud.keysUrl ? `<button type="button" class="ns-access-btn" data-ext="${cloud.keysUrl}">Получить ключ</button>` : ''}
         </div>
         ${nomadKeyBox}
       </div>`
    : '';
  const accessHtml = `
    <div class="ns-access">
      <div class="ns-access-title">Шаг 2 сам попросит войти в нейросеть — это нормально. Сначала открой VS Code и напиши запрос; когда Claude попросит доступ — выбери способ:</div>
      <div class="ns-access-grid">
        <div class="ns-access-card">
          <div class="ns-access-h">💳 Своя подписка Claude</div>
          <div class="ns-access-t">Понадобится зарубежная карта. Подписка платная — Claude Pro от $20/мес (для старта хватит). Заранее платить не нужно: Claude сам попросит войти при первом запросе.</div>
          <div class="ns-access-btns"><button type="button" class="ns-access-btn" data-ext="${claudeUrl}">Войти на claude.ai</button></div>
        </div>
        ${nomadCard}
      </div>
    </div>`;

  // Явный (НЕ автоматический) вход в курс-симулятор. Тестер-фидбек + решение
  // Жемала: по умолчанию симулятор не открывается, но должен быть чёткий путь и
  // команда активации. Показываем блок только если курс реально установлен.
  // Курс-симулятор бандлится всегда (не всегда попадает в STATE.selected). Блок
  // показываем, если курс в этой сборке НЕ упал и НЕ пропущен (exit 120 у
  // lite/partial-сборки без vendor/course-архива); финальную гарантию — что папка
  // курса реально на месте — даёт main-хендлер launch-course (иначе no-op).
  // Ground-truth (как у nomad): блок курса показываем, только если курс реально
  // встал в этой сессии ИЛИ найден на машине — не по per-прогонным спискам (после
  // «Повторить» они пусты и блок всплывал бы даже на сборке без курса).
  const courseInstalled =
    !!(STATE.installedEver && STATE.installedEver.has('course')) ||
    !!(STATE.detected && STATE.detected.course && STATE.detected.course.installed);
  const courseHtml = courseInstalled
    ? `<div class="ns-course">
         <div class="ns-course-h">🎓 Хочешь учиться по шагам? Включи курс-симулятор</div>
         <div class="ns-course-t">Отдельный режим: ИИ-наставник ведёт тебя за руку по миссиям на ТВОём проекте. Не знаешь, с чего начать — начни отсюда, это самый простой первый час. Есть своя задача — иди по шагам 1–2 выше, курс никуда не денется. Сам по себе не открывается — включаешь так:</div>
         <ol class="ns-course-steps">
           <li>Нажми «Открыть курс-симулятор» ниже — папка курса (<code>HamidunCourse</code>) откроется в VS Code. Это <b>не та же</b> папка, что стартовый проект <code>HamidunStart</code> из шага 1 — они лежат рядом и называются похоже.</li>
           <li>В панели Claude (значок <b>✳</b>) напиши <b>«начать»</b> — наставник поздоровается и поведёт по первой миссии.</li>
         </ol>
         <button type="button" id="ns-course" class="btn-sm">🎓 Открыть курс-симулятор</button>
       </div>`
    : '';

  // «Скопировать отчёт для поддержки»: когда что-то не так — среди главных кнопок, иначе
  // в «Ещё инструменты». Текст собирает main (хвост журнала, ОС, издание, uid).
  const hasProblems = !!(failed.length || checkFailed || softFailed.length || partial.length || depSkipped.length);
  const reportBtn = `<button type="button" id="ns-report" class="btn-sm">📋 Скопировать отчёт для поддержки</button>`;
  // Связь с Anthropic из консоли — проверяется ПОСЛЕ отрисовки (runNetCheck) и ничего
  // не блокирует; блок заполняется сам.
  const netHtml = `<div class="ns-net" id="ns-net">Проверяю, дойдёт ли Claude Code до серверов Anthropic…</div>`;
  // Скрепка: что это, как запустить и как убрать — одной строкой (иначе её принимали за чужую
  // программу). Только если скрепку поставил ЭТОТ прогон: у найденной на диске установщик её
  // не запускал, и «запустил её один раз после установки» было бы неправдой.
  const mascotInstalled = !!(STATE.installedEver && STATE.installedEver.has('mascot'));
  const mascotHtml = mascotInstalled ? `<div class="ns-note ns-mascot">📎 ${escapeHtml(mascotNoteText())}</div>` : '';
  // Сводка пака («Установлено N скиллов, M агентов» + каталог) — заполняется после отрисовки.
  const packHtml = `<div class="ns-note ns-pack hidden" id="ns-pack"></div>`;
  const ns = $('#next-steps');
  ns.innerHTML = `
    <div class="ns-title">Что дальше — три простых шага</div>
    <ol class="ns-steps">
      ${editorMissing ? `<li><b>Сначала доустанови редактор</b> — ${editorMissingName} не установился, а первый шаг делается именно в нём. Нажми <b>«Повторить неустановленное»</b> ниже. Не помогло — закрой установщик, запусти его правым кликом → <b>«Запуск от имени администратора»</b>, и отметь только этот компонент.</li>`
      : `<li><b>Открой ${editorReadyName}</b> — синяя кнопка ниже. Это твоя мастерская: слева файлы проекта, сбоку — панель Claude со значком <b>✳</b>. <b>Установщик больше не нужен</b> — Claude Code теперь живёт в ${editorReadyName}: закрыл окно — просто открой ${editorReadyName} снова (ярлык на рабочем столе / в меню Пуск).</li>`}
      <li><b>Напиши первый запрос в панели Claude</b> — по-русски, своими словами: например, «сделай мне сайт-визитку». Claude Code — это <b>чат</b>: ты пишешь задачу текстом, он делает. Пиши именно в панель со значком <b>✳</b> — не во встроенный чат редактора справа (это GitHub Copilot, другой продукт) и не в голое окно PowerShell. При первом запросе он попросит подключить нейросеть — как, смотри в блоке ниже.</li>
      ${step3}
    </ol>
    ${accessHtml}
    ${netHtml}
    ${courseHtml}
    ${mascotHtml}
    ${packHtml}
    ${checksHtml}
    ${failHtml}
    ${gracefulSkipHtml}
    ${partialHtml}
    ${softHtml}
    <div class="ns-actions">
      ${editorMissing
        ? `<button type="button" id="ns-vscode" class="btn-sm ns-main" disabled title="${editorMissingName} не установился — сначала доустанови его кнопкой «Повторить неустановленное»">▶ Открыть VS Code — сначала доустанови редактор</button>`
        : `<button type="button" id="ns-vscode" class="btn-sm primary ns-main">▶ Открыть ${editorReadyName} — начать здесь</button>`}
      ${videoBtn}
      ${(failed.length || checkFailed) ? logBtn : ''}
      ${hasProblems ? reportBtn : ''}
    </div>
    <div class="ns-report-status" id="ns-report-status"></div>
    ${botCta}
    <details class="ns-more">
      <summary>Ещё инструменты ▾</summary>
      <div class="ns-actions ns-actions-more">
        ${cursorSelected ? `<button type="button" id="ns-cursor" class="btn-sm">Открыть Cursor</button>` : ''}
        <button type="button" id="ns-claude" class="btn-sm">Запустить Claude в терминале (для продвинутых)</button>
        <button type="button" id="ns-keys" class="btn-sm">Показать файл ключей</button>
        ${startBtn}
        ${(failed.length || checkFailed) ? '' : logBtn}
        ${hasProblems ? '' : reportBtn}
      </div>
    </details>
    ${keysHtml}
    <label class="ns-auto"><input type="checkbox" id="ns-autovscode" ${fin.autoOpenCursorDefault ? 'checked' : ''}/> Открыть VS Code на папке проекта при нажатии «Готово»</label>`;
  ns.classList.remove('hidden');

  // #3: не молчим на false — Терминал мог не открыться (TCC-отказ на macOS / нет cmd).
  const claudeBtnEl = $('#ns-claude');
  claudeBtnEl.addEventListener('click', async () => {
    // Ответ main приходит через пару секунд (он ждёт, не упало ли окно): пока идёт — кнопка выключена,
    // повторное нажатие не открывало бы второе окно.
    if (claudeBtnEl.disabled) return;
    claudeBtnEl.disabled = true;
    let ok = false;
    try { ok = await window.installer.openClaudeTerminal(); } catch (_) {}
    claudeBtnEl.disabled = false;
    if (!ok) {
      let hint = claudeBtnEl.parentElement.querySelector('.ns-claude-err');
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'ns-course-err ns-claude-err'; // стиль ns-course-err + уникальный якорь для дедупа
        claudeBtnEl.parentElement.appendChild(hint);
      }
      hint.textContent = STATE.platform === 'darwin'
        ? 'Не удалось открыть Терминал (macOS не дал разрешение управлять Терминалом). Открой Терминал сам: ⌘+Пробел → «Терминал» → набери claude.'
        : 'Не удалось открыть терминал. Открой командную строку (Пуск → cmd) и набери claude.';
    }
  });
  // #7: не молчим на false. VS Code мог не войти в сборку / не установиться (lite,
  // антивирус, сеть), а на macOS launchVsCodeOn раньше врал true даже без .app.
  // Теперь ждём реальный результат и показываем подсказку про доустановку — как у курса.
  const vscodeBtnEl = $('#ns-vscode');
  vscodeBtnEl.addEventListener('click', async () => {
    let r = false;
    try { r = await window.installer.launchVsCode(); } catch (_) {}
    // Различаем «открылся редактор» и «открылась только папка». main отдаёт
    // 'explorer'/'finder', когда редактора запустить не вышло и показан проводник:
    // раньше любое truthy считалось успехом, человек читал, что редактор открыт, глядя
    // на окно с файлами, а в телеметрию уходило open_editor — то есть и метрика
    // «дошёл до редактора» считала эти случаи успешными.
    const openedEditor = r === true;
    const openedFolder = r === 'explorer' || r === 'finder';
    if (openedEditor) sendOpenEditorTelemetry();
    if (openedFolder) {
      showEditorHint('Открылась папка с файлами, а не редактор — запустить его не удалось. '
        + 'Открой ' + editorReadyName + ' сам (ярлык на рабочем столе / в меню Пуск) и выбери в нём эту папку: '
        + 'без редактора панель Claude не появится.');
    }
    if (!openedEditor && !openedFolder) {
      let hint = vscodeBtnEl.parentElement.querySelector('.ns-vscode-err');
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'ns-course-err ns-vscode-err'; // стиль ns-course-err + уникальный якорь для дедупа
        vscodeBtnEl.parentElement.appendChild(hint);
      }
      hint.textContent = editorReadyName + ' не открылся — похоже, он не установлен в этой сборке. ' +
        'Запусти установщик ещё раз с компонентом «VS Code», ' +
        (cursorSelected ? 'или открой Cursor кнопкой в «Ещё инструменты», ' : '') +
        'либо спроси бота-помощника.';
    }
  });
  // Сохранение ключа Nomad. Ответ показываем ВСЕГДА — молчащая кнопка на этом экране
  // уже один раз стоила тестировщику минуты растерянности (кнопка «Открыть VS Code»
  // при отсутствующем редакторе не давала никакого отклика).
  const nomadSaveBtn = $('#ns-nomad-save');
  const nomadKeyEl = $('#ns-nomad-key');
  const nomadMsgEl = $('#ns-nomad-msg');
  if (nomadSaveBtn && nomadKeyEl && nomadMsgEl) {
    const setMsg = (text, kind) => {
      nomadMsgEl.textContent = text;
      nomadMsgEl.className = 'ns-key-msg' + (kind ? ' ' + kind : '');
    };
    const save = async () => {
      const key = nomadKeyEl.value.trim();
      if (!key) { setMsg('Сначала вставь ключ из кабинета.', 'bad'); return; }
      nomadSaveBtn.disabled = true;
      setMsg('Сохраняю…', '');
      let res = null;
      try { res = await window.installer.nomadSetKey(key); } catch (e) { res = { ok: false, reason: 'io' }; }
      nomadSaveBtn.disabled = false;
      if (res && res.ok) {
        // Ключ на экран не возвращаем и в поле не оставляем.
        nomadKeyEl.value = '';
        setMsg('Готово: ключ записан, Nomad подключён к облаку (модель ' + (res.model || 'по умолчанию') +
               '). Теперь пиши запросы в панели Claude.', 'good');
      } else if (res && res.reason === 'malformed') {
        setMsg('Это не похоже на ключ: в нём пробелы или он слишком короткий. Скопируй строку целиком из кабинета.', 'bad');
      } else if (res && res.reason === 'empty') {
        setMsg('Поле пустое — вставь ключ из кабинета.', 'bad');
      } else {
        // Сообщение из nomad-key может быть уже человеческим («Ключ НЕ записан, чтобы не
        // потерять твои настройки агента») — humanIoError такие пропускает как есть и
        // переводит только сырые коды Node.
        setMsg('Не удалось записать ключ' + (res && res.message ? ': ' + humanIoError(res.message) : '') +
               ' Покажи эту строку боту-помощнику.', 'bad');
      }
    };
    nomadSaveBtn.addEventListener('click', save);
    nomadKeyEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }

  const courseBtn = $('#ns-course');
  if (courseBtn) courseBtn.addEventListener('click', async () => {
    // M2: не молчим на false — папки курса нет (не входил в сборку / снесли).
    let res = null;
    try { res = await window.installer.launchCourse(); } catch (_) {}
    // Совместимость со старым контрактом (голый boolean) — на случай рассинхрона версий.
    if (res === true) res = { ok: true, how: 'editor' };
    if (res === false || res == null) res = { ok: false, reason: 'no-dir' };

    const show = (text) => {
      let hint = courseBtn.parentElement.querySelector('.ns-course-err');
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'ns-course-err';
        courseBtn.parentElement.appendChild(hint);
      }
      hint.textContent = text;
    };

    if (res.ok) {
      // Папка открылась в проводнике, а не в редакторе: файлы человек видит, но
      // наставник подхватится только из редактора — говорим об этом прямо, иначе
      // он напишет «начать» в пустоту и решит, что курс сломан.
      if (res.how === 'explorer' || res.how === 'finder') {
        show('Редактор не найден, поэтому открыл папку курса в проводнике: ' + (res.dir || '') +
             '. Чтобы заработал наставник — открой эту папку в VS Code или Cursor ' +
             '(File → Open Folder) и напиши «начать» в панели Claude.');
      }
      return;
    }
    // Три РАЗНЫЕ причины — три разных совета. Раньше на любую печаталось «папка курса
    // не найдена», и человек с целой папкой шёл переустанавливать курс впустую.
    if (res.reason === 'no-editor') {
      show('Курс на месте (' + (res.dir || '') + '), но не нашёлся редактор — ни VS Code, ни Cursor. ' +
           'Поставь любой из них (можно этим же установщиком), потом открой в нём эту папку ' +
           'и напиши «начать» в панели Claude.');
    } else if (res.reason === 'no-mentor') {
      show('Папка курса есть (' + (res.dir || '') + '), но в ней нет файла CLAUDE.md с наставником — ' +
           'распаковка прошла не до конца. Запусти установщик ещё раз с компонентом «Курс».');
    } else {
      show('Папка курса не найдена — курс не входил в эту сборку или папку удалили. ' +
           'Запусти установщик ещё раз с компонентом «Курс», либо спроси бота-помощника.');
    }
  });
  const cursorBtn = $('#ns-cursor');
  if (cursorBtn) {
    // Результат ЖДЁМ: кнопка рисуется по ВЫБОРУ компонента, а не по факту установки —
    // если Cursor не встал, окно не откроется, и слать «открыл редактор» было бы враньём
    // (бот на этом сигнале решает, что человек пошёл работать). Симметрично VS Code.
    cursorBtn.addEventListener('click', async () => {
      let ok = false;
      try { ok = await window.installer.launchCursor(); } catch (_) { ok = false; }
      if (ok) sendOpenEditorTelemetry();
    });
  }
  // reveal in Explorer/Finder — openPath on a .env silently fails on macOS.
  //
  // Результат IPC ЧИТАЕМ. Обе ручки честно возвращают статус: reveal-path отдаёт false,
  // когда файла нет (а на финише с упавшим конфигом ключей и не будет), open-path —
  // {ok:false,error}. Раньше оба вызова стояли однострочными стрелками без обработки:
  // человек жал кнопку, не происходило ничего, и понять, что не так, было неоткуда —
  // тот же «пустой клик», который уже ловили на кнопке редактора.
  const sayNear = (btn, text) => {
    if (!btn || !btn.parentElement) return;
    let note = btn.parentElement.querySelector('.ns-reveal-err');
    if (!note) {
      note = document.createElement('div');
      note.className = 'ns-course-err ns-reveal-err';
      btn.parentElement.appendChild(note);
    }
    note.textContent = text;
  };
  const keysBtnEl = $('#ns-keys');
  keysBtnEl.addEventListener('click', async () => {
    let ok = false;
    try { ok = await window.installer.revealPath(credPath); } catch (_) { ok = false; }
    if (!ok) {
      sayNear(keysBtnEl, 'Файл ключей пока не создан — он появится, когда сохранишь хотя бы один ключ '
        + 'кнопкой «Сохранить ключи» выше. Путь: ' + credPath);
    }
  });
  const logBtnEl = $('#ns-log');
  if (logBtnEl) {
    logBtnEl.addEventListener('click', async () => {
      let res = null;
      try { res = await window.installer.openPath(STATE.logPath); } catch (_) { res = null; }
      if (!res || res.ok !== true) {
        sayNear(logBtnEl, 'Не удалось открыть лог. Нажми «Скопировать отчёт для поддержки» и вставь текст в чат с ботом — '
          + 'хвост лога уже в нём. Сам файл лежит здесь: ' + STATE.logPath);
      }
    });
  }
  const startBtnEl = $('#ns-start');
  if (startBtnEl && startHtmlRel) {
    // Авто-показ ОДИН раз — встроенный просмотр (Shadow DOM-оверлей), НЕ браузер.
    // Копию на рабочий стол кладём по-прежнему сразу, но тихо (без открытия).
    if (!STATE.startHereOpened) {
      STATE.startHereOpened = true;
      saveStartHereQuiet();   // «Что дальше — Hamidun.html» на столе — как раньше
      showStartHereInline();  // памятка читается прямо в окне установщика
    }
    startBtnEl.addEventListener('click', () => showStartHereInline());
    // Браузер — осознанная ВОЗМОЖНОСТЬ: прежний путь openStartHereMemo целиком
    // (копия на стол + системное открытие с фолбэком на вшитую).
    const startExtEl = $('#ns-start-ext');
    if (startExtEl) startExtEl.addEventListener('click', () => openStartHereMemo());
  }
  const saveKeysBtn = $('#ns-save-keys');
  if (saveKeysBtn) saveKeysBtn.addEventListener('click', saveCredentialKeys);
  ns.querySelectorAll('[data-ext]').forEach((b) => b.addEventListener('click', () => window.installer.openExternal(b.dataset.ext)));
  const retry = $('#ns-retry');
  if (retry) retry.addEventListener('click', () => retryFailed(retryList));
  const reportBtnEl = $('#ns-report');
  if (reportBtnEl) reportBtnEl.addEventListener('click', () => copySupportReport());
  // После отрисовки и без ожидания: связь с Anthropic и сводка пака.
  runNetCheck();
  renderPackSummary();
}

const CRED_KEY_NAMES = ['GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY'];

async function saveCredentialKeys() {
  const status = $('#ns-keys-status');
  const keys = {};
  CRED_KEY_NAMES.forEach((k) => {
    const el = document.getElementById('key-' + k);
    const v = el ? el.value.trim() : '';
    if (v) keys[k] = v; // пустые поля игнорируем
  });
  if (!Object.keys(keys).length) {
    if (status) status.textContent = 'Заполни хотя бы одно поле.';
    return;
  }
  if (status) status.textContent = 'Сохраняю…';
  const res = await window.installer.saveCredentials(keys);
  if (status) {
    status.textContent = res && res.ok
      ? `Сохранено (${(res.saved || []).length}) в .credentials.master.env ✓`
      : 'Не удалось сохранить: ' + humanIoError(res && res.error);
  }
}

// ---- после установки и во время неё: сторож, отчёт поддержке, связь, сводка ----
// Функции новые и стоят в конце файла намеренно: вставка в середину сдвинула бы
// ссылки «файл:строка» из docs/specs на код ниже.

// Имя компонента для текста (сырое; в HTML — только через escapeHtml).
function nameOfId(id) { return (STATE.byId[id] && STATE.byId[id].name) || String(id); }

// «1 скилл / 3 скилла / 5 скиллов».
function ruPlural(n, one, few, many) {
  const a = Math.abs(Number(n) || 0) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Скрепка появлялась без объяснений: её принимали за чужую программу. Одна строка на
// финише: что это, что установщик запустил её один раз и как запустить снова. Про
// автозапуск здесь ни слова намеренно — решение владельца 06.10: скрепка больше не
// ставится в автозагрузку (правит mascot.ps1 / mascot.sh отдельно). Путь к exe — тот же,
// что в mascot.ps1 ($destDir = %LOCALAPPDATA%\Programs\ClaudeMascot).
function mascotNoteText() {
  const again = STATE.platform === 'darwin'
    ? '⌘+Пробел → «Claude Mascot» (или Finder → домашняя папка → «Программы»).'
    : 'Пуск → «Claude Mascot» (или файл %LOCALAPPDATA%\\Programs\\ClaudeMascot\\claude-mascot.exe).';
  // Установщик мог её НЕ запустить (нет оболочки обычного уровня, UAC выключен…): mascot.ps1 говорит об этом
  // маркером HM-MASCOT launched=0 → STATE.mascotLaunched === false. Тогда ни «запустил», ни «на рабочем столе».
  const notLaunched = STATE.mascotLaunched === false;
  // Как убрать — карточка «Скрепка Claude (маскот)» → «Удалить» (скрепка в REMOVABLE). И честно:
  // сама она больше не стартует, а хуки Claude Code к ней остаются в настройках, поэтому, пока
  // скрепка не запущена, они упираются в закрытый порт и притормаживают работу.
  return 'Скрепка ' + (notLaunched ? '' : 'на рабочем столе ') + '— помощник Claude: показывает, что он сейчас делает, и даёт кнопки ' +
    '«Разрешить / Отклонить» прямо на экране. ' +
    (notLaunched ? 'Установщик не смог запустить её сам, поэтому на экране её пока нет. Запустить: '
      : 'Установщик запустил её один раз после установки. Запустить снова: ') + again +
    ' Убрать совсем: карточка «Скрепка Claude (маскот)» в этом установщике → «Удалить». ' +
    'Пока скрепка не запущена, Claude Code напрасно обращается к ней и из-за этого может притормаживать: ' +
    'запусти её или удали.';
}

// ---- «Пропустить шаг» ------------------------------------------------------
// main шлёт step-stall: 'stalled' — необязательный шаг молчит STALL_SKIP_MIN минут
// (кнопку можно показать), 'alive' — шаг снова пишет вывод (кнопку убрать). Решение о
// пропуске всё равно за main: кнопка лишь просит (skip-step), и отказ показываем честно.
function onStepStall(p) {
  if (!p || !p.id) return;
  if (p.state === 'alive') { removeStepSkip(p.id); return; }
  if (p.state === 'stalled') addStepSkip(p.id, p.mins);
}

function addStepSkip(id, mins) {
  const step = document.querySelector(`.step[data-id="${id}"]`);
  if (!step || step.querySelector('.step-skip')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-sm step-skip';
  b.textContent = 'Пропустить шаг';
  b.title = 'Шаг молчит ' + (Number(mins) || 8) + ' мин. При медленном интернете большая загрузка идёт молча — тогда лучше подождать. ' +
    'Ничего не качается — нажми: компонент необязательный, установка продолжится без него, поставить его можно позже.';
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'Останавливаю…';
    let r = null;
    try { r = await window.installer.skipStep(id); } catch (e) { r = null; }
    if (r && r.ok) {
      appendLog(`[~] «${nameOfId(id)}» — останавливаю шаг по кнопке «Пропустить шаг», установка пойдёт дальше…`);
      return;
    }
    removeStepSkip(id);
    const why = (r && r.reason === 'alive') ? 'шаг снова ожил — пропускать не стал, установка идёт дальше'
      : (r && r.reason === 'required') ? 'это обязательный компонент — его пропустить нельзя'
        : 'шаг уже закончился';
    appendLog(`[~] «${nameOfId(id)}»: ${why}.`);
  });
  step.appendChild(b);
}

function removeStepSkip(id) {
  const step = document.querySelector(`.step[data-id="${id}"]`);
  const b = step ? step.querySelector('.step-skip') : null;
  if (b) b.remove();
}

// ---- «Скопировать отчёт для поддержки» ---------------------------------------
// Что не встало и почему — из того же итога, что ушёл в телеметрию (STATE.lastReport):
// упавшее, необязательное, частичное, жалоба проверки. Текст собирает и чистит MAIN.
function supportSteps() {
  // Посреди прогона прежний итог устарел (повтор идёт) — смотрим на живую карту причин.
  const rep = STATE.runActive === true ? null : STATE.lastReport;
  const errs = (rep && Array.isArray(rep.errors)) ? rep.errors : Array.from((STATE.errorDigest || new Map()).values());
  return errs.slice(0, 10).map((e) => ({ id: e.id, name: nameOfId(e.id), stage: e.stage || '', error: e.error || '' }));
}

async function copySupportReport() {
  // Кнопка живёт и на финише (#ns-report-status), и в плашке помощи во время установки.
  const st = document.getElementById('ns-report-status') || document.getElementById('pb-report-status');
  const say = (t) => { if (st) st.textContent = t; };
  let r = null;
  try {
    r = await window.installer.supportReport({ outcome: supportOutcome(), running: STATE.runActive === true, steps: supportSteps() });
  } catch (e) { r = null; }
  if (r && r.ok) {
    // Не обещаем «ключей нет»: чистка находит известные виды секретов и ПД, а не все возможные.
    say('Отчёт скопирован — вставь его в чат с ботом-помощником (Ctrl+V, на Mac — ⌘+V). ' +
      'Имя пользователя, пути и ключи из текста убраны автоматически; всё равно просмотри его перед отправкой.');
    // Человек вправе видеть, что именно он отправит: показываем скопированный текст.
    openModal({
      id: 'report-preview',
      emoji: '📋',
      title: 'Отчёт скопирован в буфер обмена',
      bodyHtml: '<p class="wi-lead">Вставь его боту-помощнику одним сообщением. Вот что в нём:</p>' +
        '<pre class="report-pre">' + escapeHtml(r.text || '') + '</pre>',
      closeLabel: 'Понятно',
      blocking: false,
    });
  } else {
    say('Скопировать не получилось' + (r && r.error ? ' (' + r.error + ')' : '') +
      '. Открой лог кнопкой «Показать лог для поддержки» и пришли боту файл журнала.');
  }
}

// ---- связь с Anthropic из консоли ------------------------------------------
// Браузер через VPN открывает claude.ai, а Claude Code — консольная программа и
// системный прокси Windows не видит: «403», «Unable to connect». main проверяет связь
// тем же сетевым путём, каким пойдёт Claude Code, и находит прокси VPN-клиента. Здесь —
// только рассказ и кнопка с согласием; установку это не блокирует никогда.
async function runNetCheck() {
  const box = document.getElementById('ns-net');
  if (!box) return;
  if (!window.installer.netCheck) { box.remove(); return; }
  let r = null;
  try { r = await window.installer.netCheck(); } catch (e) { r = null; }
  renderNetCheck(r);
}

function tunStepsHtml() {
  return '<ol class="ns-net-steps">' +
    '<li>Открой свой VPN-клиент (Happ, v2rayN, Throne, Hiddify — какой есть).</li>' +
    '<li>Включи режим <b>TUN</b> — в разных клиентах он называется «TUN», «VPN-режим» или «весь трафик». ' +
    'Режима «системный прокси» мало: через него ходит только браузер.</li>' +
    '<li>Перезапусти VS Code (или терминал) и открой Claude снова — он подключится.</li>' +
    '</ol><div class="ns-net-note">Для самой установки VPN не нужен (кроме необязательных Claude Desktop, ChatGPT и Cursor — их сайты без VPN могут не открыться) — он нужен для входа и работы Claude.</div>';
}

function renderNetCheck(r) {
  const box = document.getElementById('ns-net');
  if (!box) return;
  const res = r || {};
  if (res.kind === 'skipped') { box.remove(); return; }   // пробный прогон: в сеть не ходили
  box.className = 'ns-net';
  if (res.kind === 'reachable') {
    box.classList.add('ok');
    box.textContent = '✓ Связь с серверами Claude из консоли есть — Claude Code сможет подключиться.';
    return;
  }
  if (res.configuredKind === 'reachable') {
    box.classList.add('ok');
    box.textContent = '✓ Напрямую серверы Claude не отвечают, но Claude Code настроен ходить через прокси ' +
      (res.configured || '') + ' — через него связь есть.';
    return;
  }
  box.classList.add('warn');
  const detail = escapeHtml(res.detail || 'проверить не удалось');
  const note = (t) => '<div class="ns-net-note">' + t + '</div>';
  // Совет — по ВИДУ ответа, а не один на все случаи: раньше «нужен VPN на весь компьютер» говорилось
  // и когда нет интернета, и когда соединение подменяет антивирус, и когда упала сама проверка.
  if (res.kind === 'unknown') {
    box.innerHTML = '<b>Связь с серверами Anthropic проверить не удалось</b> (' + detail + '). ' +
      'Это не значит, что связи нет: открой Claude Code и посмотри, подключится ли он. Если нет — включи VPN на весь компьютер (режим TUN).';
    return;
  }
  if (res.kind === 'offline') {
    box.innerHTML = '<b>Похоже, нет выхода в интернет</b> (' + detail + '). Установку это не портит, но без сети Claude Code не заработает.' +
      note('Проверь подключение (Wi-Fi или кабель). Когда сеть появится, просто открой Claude Code — заново ставить ничего не нужно.');
    return;
  }
  if (res.kind === 'tls') {
    box.innerHTML = '<b>Соединение с серверами Anthropic кто-то подменяет</b> (' + detail + '). Установку это не портит, но входу и работе Claude Code это мешает.' +
      note('Чаще всего это антивирус с проверкой защищённых соединений (HTTPS) или корпоративный прокси. Отключи проверку HTTPS («веб-защиту») ' +
        'в антивирусе и перезапусти VS Code. На рабочем компьютере спроси администратора про корневой сертификат — его указывают в переменной NODE_EXTRA_CA_CERTS.');
    return;
  }
  let html = '<b>Claude Code пока не достучится до серверов Anthropic</b> (' + detail + '). ' +
    'Установку это не портит, но для входа и работы нужен VPN на весь компьютер.';
  if (res.configuredUnreadable) {
    // Значение прокси на экран не выводим (в адресе бывает пароль) и заменить его не предлагаем.
    html += note('В настройках Claude Code уже прописан прокси, но разобрать его адрес не получилось, поэтому заменить его я не предлагаю. ' +
      'Проверь строки HTTPS_PROXY и HTTP_PROXY в файле settings.json в папке .claude твоего профиля — или включи в VPN-клиенте режим TUN.') + tunStepsHtml();
  } else if (res.configured && res.configuredKind) {
    html += note('В настройках Claude Code прописан прокси <code>' + escapeHtml(res.configured) +
      '</code>, но через него связи нет — включи VPN-клиент. Не пользуешься им больше — убери строки HTTPS_PROXY и ' +
      'HTTP_PROXY из файла settings.json в папке .claude твоего профиля.');
  } else if (res.proxy && res.proxy.kind === 'geo') {
    // Прокси VPN-клиента отвечает, но Anthropic отказывает уже ему: дело в стране выходного адреса.
    html += note('VPN-клиент включён (системный прокси <code>' + escapeHtml(res.proxy.url || '') + '</code>), но Anthropic отказывает и через него: ' +
      'выходной адрес VPN — в стране, которую он не пускает. Смени сервер или страну в VPN-клиенте и проверь снова.');
  } else if (res.proxy && res.proxy.works && res.proxy.url) {
    html += note('Похоже, VPN-клиент включён в режиме «системный прокси» (<code>' +
      escapeHtml(res.proxy.url) + '</code>): браузер через него ходит, а Claude Code — нет. Могу прописать этот ' +
      'прокси в настройки Claude Code — тогда он тоже пойдёт через VPN.') +
      '<button type="button" id="ns-proxy" class="btn-sm">Прописать прокси для Claude Code</button>';
  } else {
    html += tunStepsHtml();
  }
  box.innerHTML = html;
  const pb = document.getElementById('ns-proxy');
  if (pb) pb.addEventListener('click', () => applyProxyClick(res.proxy.url));
}

const PROXY_FAIL_TEXT = {
  'existing-proxy': 'в настройках Claude Code уже прописан другой прокси — заменять его не стал',
  'no-local-proxy': 'системный прокси уже выключен или сменился — проверь VPN-клиент и нажми ещё раз',
  'proxy-not-working': 'через прокси серверы Claude сейчас не отвечают — ничего не записал',
  'invalid-json': 'файл ~/.claude/settings.json повреждён (это не JSON) — не трогал его',
  'env-not-object': 'в ~/.claude/settings.json поле env устроено необычно — не трогал файл',
  'not-object': 'файл ~/.claude/settings.json устроен необычно — не трогал его',
  'not-regular-file': 'файл настроек — ссылка или папка, а не обычный файл — не трогал его',
  'link-in-path': 'папка .claude (или путь к ней) — ссылка (junction/symlink), а не обычная папка — писать через ссылку не стал, ничего не изменил',
  'read-failed': 'не получилось прочитать ~/.claude/settings.json — ничего не записал',
  'write-failed': 'не получилось записать ~/.claude/settings.json',
};

async function applyProxyClick(url) {
  const yes = window.confirm('Прописать прокси VPN-клиента в настройки Claude Code?\n\n' +
    'В файл ~/.claude/settings.json (блок "env") добавятся HTTPS_PROXY и HTTP_PROXY = ' + url +
    ' и NO_PROXY для локальных адресов. Остальные настройки не меняются, рядом сохранится копия файла.\n\n' +
    'Важно: пока прокси прописан, Claude Code работает только при ВКЛЮЧЁННОМ VPN-клиенте. ' +
    'Выключишь клиент — Claude Code перестанет подключаться, пока не включишь его снова или не уберёшь эти строки.\n\n' +
    'Прописать?');
  if (!yes) return;
  const pb = document.getElementById('ns-proxy');
  if (pb) { pb.disabled = true; pb.textContent = 'Записываю…'; }
  let r = null;
  try { r = await window.installer.applyProxy(); } catch (e) { r = null; }
  const box = document.getElementById('ns-net');
  if (!box) return;
  if (r && r.ok) {
    box.className = 'ns-net ok';
    box.textContent = '✓ Прокси ' + (r.url || '') + ' прописан в ' + (r.path || '~/.claude/settings.json') +
      (r.backup ? ' (копия прежнего файла: ' + r.backup + ')' : '') +
      '. Перезапусти VS Code или терминал — Claude Code пойдёт через VPN.';
    return;
  }
  if (pb) { pb.disabled = false; pb.textContent = 'Прописать прокси для Claude Code'; }
  const why = (r && PROXY_FAIL_TEXT[r.reason]) || 'не получилось';
  const note = document.createElement('div');
  note.className = 'ns-net-note';
  note.textContent = 'Не прописал: ' + why + '. Надёжнее — включить в VPN-клиенте режим TUN («весь трафик»).';
  box.appendChild(note);
}

// ---- сводка пака -------------------------------------------------------------
// «Что встало и где список»: люди не находили, что за скиллы им поставили и сколько
// их. Число берём из сводки, которую пишет config-скрипт; нет сводки — молчим.
async function renderPackSummary() {
  const box = document.getElementById('ns-pack');
  if (!box || !window.installer.packSummary) return;
  const configHere = !!(STATE.installedEver && STATE.installedEver.has('config')) ||
    !!(STATE.detected && STATE.detected.config && STATE.detected.config.installed);
  if (!configHere) return;
  let r = null;
  try { r = await window.installer.packSummary(); } catch (e) { return; }
  if (!r || !r.ok) return;
  const parts = [];
  if (Number.isFinite(r.skills)) parts.push(r.skills + ' ' + ruPlural(r.skills, 'скилл', 'скилла', 'скиллов'));
  if (Number.isFinite(r.agents)) parts.push(r.agents + ' ' + ruPlural(r.agents, 'агент', 'агента', 'агентов'));
  if (!parts.length) return;
  // Где они работают — людям это не очевидно (искали скиллы в приложении Claude и на claude.ai).
  box.innerHTML = '🧩 Из конфига в Claude Code установлено ' + parts.join(' и ') + '. ' +
    'Работают они в Claude Code — в панели ✳ в VS Code или после команды <code>claude</code> в терминале; ' +
    'в обычном чате приложения Claude, на claude.ai и в телефоне их нет. ' +
    (r.catalog
      ? 'Что каждый умеет — в каталоге <code>~/.claude/CATALOG.md</code>. ' +
        '<button type="button" id="ns-catalog" class="btn-sm">Показать каталог</button>'
      : 'Они лежат в папке <code>~/.claude/skills</code>.');
  box.classList.remove('hidden');
  const cb = document.getElementById('ns-catalog');
  if (cb) cb.addEventListener('click', async () => {
    let ok = false;
    try { ok = await window.installer.revealCatalog(); } catch (e) { ok = false; }
    if (!ok) cb.textContent = 'Каталог не найден';
  });
}

// Строка чеклиста «Проверка установки» на финише (её зовёт renderNextSteps): ✓ или ✕ и
// ярлык проверки. Под КРАСНОЙ строкой — пояснение «что это и что делать», но только для
// ярлыков, которые сами этого не говорят (HMRunStatus.checkFailWhy): «Запуск claude в
// PowerShell» без него читается как «Claude Code не установился», хотя в cmd он работает.
// Ярлык печатает скрипт, а пояснение живёт в run-status.js, поэтому оба — через escapeHtml.
// Сбой помощника не должен гасить финишный экран: без пояснения строка рисуется как раньше.
function checkLiHtml(st, label) {
  const good = st === 'ok';
  let why = null;
  try {
    const rs = window.HMRunStatus;
    if (!good && rs && typeof rs.checkFailWhy === 'function') why = rs.checkFailWhy(label);
  } catch (e) { why = null; }
  const whyHtml = why ? `<span class="ns-check-why">${escapeHtml(why.hint)}</span>` : '';
  return `<li class="${good ? 'ok' : 'fail'}${why ? ' has-why' : ''}"><span class="mark">${good ? '✓' : '✕'}</span><span>${escapeHtml(label)}${whyHtml}</span></li>`;
}

// ---- «Проверить и починить» -----------------------------------------------------
// У человека, у которого всё уже стоит, «Установить» погашена: детект снял галочки, ставить
// нечего, и ни одна починка, спрятанная в скрипты компонентов, до него не доезжала. Починки
// профиля (настройки Claude Code, PATH, политика PowerShell, первый запуск VS Code, старый
// автозапуск скрепки) живут в скрытом шаге verify: он идёт последним в КАЖДОМ прогоне и
// чинит то, чего в этом прогоне нет в HM_SELECTED. Кнопка запускает ровно его одного.
function repairAvailable() {
  const n = selectedIds().filter((id) => !(STATE.byId[id] && STATE.byId[id].hidden)).length;
  return n === 0 && !!STATE.detectDone && !STATE.vendorBlocked && !!(STATE.byId && STATE.byId.verify);
}

// Окружение прогона ремонта. HM_SELECTED = только verify: для verify «выбран» значит «этот
// прогон поставил компонент сам и починил его в своём скрипте», а здесь не ставится ничего —
// иначе он пропустил бы починки по компонентам, которых мы не трогали.
function repairEnv() {
  const env = envForRun();
  env.HM_SELECTED = 'verify';
  return env;
}

// Строки, которые verify напечатал в прогоне ремонта (CHECK-строки сюда не попадают — они
// идут в чеклист). Из них на финише складывается «что сделала проверка».
function collectRepairLine(line) {
  const t = String(line == null ? '' : line).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!t || /^\[debug\]/i.test(t) || /^Финальная проверка/i.test(t)) return;
  if (!STATE.repairLines) STATE.repairLines = [];
  if (STATE.repairLines.length < 80 && STATE.repairLines.indexOf(t) === -1) STATE.repairLines.push(t);
}

// Строки verify о неудаче («починка не удалась», «не удалось»): ok прогона они не роняют
// (verify по замыслу идёт дальше), но «всё починено» про такой прогон сказать нельзя.
const REPAIR_TROUBLE_RE = /не удал|ошибк|не смог|пропущен|не нашл/i;

function repairTitles(report) {
  const lines = STATE.repairLines || [];
  if (!report.ok) {
    return {
      title: 'Проверка нашла проблемы',
      sub: 'Ничего не переустанавливалось. Что нашлось — ниже. Нажми «Скопировать отчёт для поддержки» и вставь текст в чат с ботом-помощником.',
    };
  }
  if (lines.some((l) => REPAIR_TROUBLE_RE.test(l))) {
    return {
      title: 'Проверка завершена, но кое-что не починилось',
      sub: 'Что именно — ниже. Работать это обычно не мешает; если что-то не запускается, нажми «Скопировать отчёт для поддержки».',
    };
  }
  return lines.length
    ? { title: 'Проверка и починка завершены', sub: 'Установленное не переустанавливалось. Что именно сделала проверка — ниже.' }
    : { title: 'Проверка завершена: всё на месте', sub: 'Чинить было нечего. Установленное не переустанавливалось.' };
}

// Финиш ремонта: не «Всё установлено, три шага», а «что сделала проверка» + чеклист +
// связь с Anthropic + помощь. Тексты скриптов (строки verify, ярлыки) — только через escapeHtml.
function renderRepairFinish(report) {
  const ns = $('#next-steps');
  const links = (STATE.config && STATE.config.links) || {};
  const fin = (STATE.config && STATE.config.finish) || {};
  const botH = botHandle();
  const lines = STATE.repairLines || [];
  const shown = lines.slice(0, 12);
  const more = lines.length - shown.length;
  const didHtml = shown.length
    ? '<div class="ns-note ns-repair"><b>Что сделала проверка</b><ul class="ns-repair-list">' +
      shown.map((l) => '<li>' + escapeHtml(l) + '</li>').join('') + '</ul>' +
      (more > 0 ? '<div class="ns-repair-more">…и ещё ' + more + ' ' + ruPlural(more, 'строка', 'строки', 'строк') + ' — в журнале.</div>' : '') +
      '</div>'
    : '<div class="ns-note ns-repair"><b>Что сделала проверка:</b> менять ничего не пришлось — известных неполадок в настройках профиля не нашлось. Установленное не переустанавливалось.</div>';
  const restartHint = shown.length
    ? '<div class="ns-note">Если проверка что-то поменяла (PATH, политику PowerShell, настройки Claude Code), закрой VS Code и все терминалы и открой заново: уже запущенные окна изменений не увидят.</div>'
    : '';
  // «skip» (компонент в прогоне не выбирался) в ремонте — это все проверки подряд: показывать
  // нечего. Остаются только ✓ и ✕, которые verify напечатал.
  const rows = (STATE.checks || []).filter((c) => (c.status || (c.ok ? 'ok' : 'fail')) !== 'skip');
  const checksHtml = rows.length
    ? '<div class="ns-checks"><div class="ns-checks-title">Проверка</div><ul class="ns-check-list">' +
      rows.map((c) => checkLiHtml(c.status || (c.ok ? 'ok' : 'fail'), c.label)).join('') + '</ul></div>'
    : '';
  const failIds = report.failed || [];
  const failHtml = report.ok ? '' :
    '<div class="ns-fail">Проверка нашла проблемы' +
    (failIds.length ? ': <b>' + failIds.map((i) => escapeHtml(nameOfId(i))).join(', ') + '</b>' : '') +
    '. Починить автоматически не вышло — нажми «Скопировать отчёт для поддержки» ниже и вставь текст в чат с ' + escapeHtml(botH) + ': разберёмся.</div>';
  const botBase = links.bot || '';
  const isWin = STATE.platform === 'win32';
  const botUrl = botBase
    ? (failIds.length ? window.HMFinishLink.botUrl(botBase, window.HMFinishLink.botStartPayload(failIds, isWin, 'installed')) : botBase)
    : '';
  const botBtn = botUrl ? '<button type="button" class="btn-sm" data-ext="' + escapeHtml(botUrl) + '">Спросить бота ' + escapeHtml(botH) + '</button>' : '';
  const startBtn = fin.startHtmlRelPath ? '<button type="button" id="ns-start" class="btn-sm">📌 Памятка «Что дальше»</button>' : '';
  const logBtn = STATE.logPath ? '<button type="button" id="ns-log" class="btn-sm">Показать лог для поддержки</button>' : '';
  ns.innerHTML =
    '<div class="ns-title">Проверка и починка</div>' +
    didHtml + restartHint + checksHtml + failHtml +
    '<div class="ns-net" id="ns-net">Проверяю, дойдёт ли Claude Code до серверов Anthropic…</div>' +
    '<div class="ns-note ns-pack hidden" id="ns-pack"></div>' +
    '<div class="ns-actions">' +
      '<button type="button" id="ns-repair-again" class="btn-sm' + (report.ok ? '' : ' primary') + '">Проверить ещё раз</button>' +
      '<button type="button" id="ns-report" class="btn-sm">📋 Скопировать отчёт для поддержки</button>' +
      logBtn + startBtn + botBtn +
    '</div>' +
    '<div class="ns-report-status" id="ns-report-status"></div>';
  ns.classList.remove('hidden');
  ns.querySelectorAll('[data-ext]').forEach((b) => b.addEventListener('click', () => window.installer.openExternal(b.dataset.ext)));
  const again = $('#ns-repair-again');
  if (again) again.addEventListener('click', () => startInstall({ repair: true }));
  const rep = $('#ns-report');
  if (rep) rep.addEventListener('click', () => copySupportReport());
  const logEl = $('#ns-log');
  if (logEl) logEl.addEventListener('click', async () => {
    let res = null;
    try { res = await window.installer.openPath(STATE.logPath); } catch (_) { res = null; }
    const st = $('#ns-report-status');
    if ((!res || res.ok !== true) && st) {
      st.textContent = 'Не удалось открыть лог. Нажми «Скопировать отчёт для поддержки» — хвост лога уже в нём. Файл лежит здесь: ' + STATE.logPath;
    }
  });
  const memo = $('#ns-start');
  if (memo) memo.addEventListener('click', () => showStartHereInline());
  runNetCheck();
  renderPackSummary();
}

// ---- помощь: payload для бота и итог для отчёта (C09) ------------------------------
// Финишная кнопка бота строилась из `res.failed`, а verify всегда выходит с кодом 0: когда
// красной была ТОЛЬКО проверка после установки, бот получал installed_<os>, хотя отчёт
// ушёл с ok=False. Берём итог прогона (run-status.js): упавшие обязательные + компонент,
// названный красной проверкой.
function botFailedIds(failed) {
  const rep = STATE.lastReport;
  if (rep && Array.isArray(rep.failed) && rep.failed.length) return rep.failed;
  return failed || [];
}

// Нерешённые обязательные провалы ПРЯМО СЕЙЧАС (идёт прогон): корневые причины из badEver,
// без «пропущен из-за зависимости» и без необязательных.
function failedIdsNow() {
  if (STATE.runActive !== true && STATE.lastReport && Array.isArray(STATE.lastReport.failed)) {
    return STATE.lastReport.failed.slice();
  }
  const out = [];
  if (STATE.badEver && typeof STATE.badEver.forEach === 'function') {
    STATE.badEver.forEach((kind, id) => { if (['net', 'integrity', 'env', 'fail'].indexOf(kind) !== -1) out.push(id); });
  }
  return out;
}

// Адрес бота для плашки помощи: тот же payload, что у финишной кнопки; ничего не упало —
// голая ссылка (как было), потому что «installed_*» посреди установки было бы враньём.
function botUrlForState() {
  const links = (STATE.config && STATE.config.links) || {};
  const base = links.bot || '';
  if (!base) return '';
  const ids = failedIdsNow();
  if (!ids.length) return base;
  const isWin = STATE.platform === 'win32';
  return window.HMFinishLink.botUrl(base, window.HMFinishLink.botStartPayload(ids, isWin, 'installed'));
}

// Одна строка «Итог» в отчёте для поддержки — по состоянию прогона: идёт / ремонт / установка.
function supportOutcome() {
  const rep = STATE.lastReport || {};
  if (STATE.runActive === true) {
    const cur = STATE.currentStepId ? nameOfId(STATE.currentStepId) : '';
    return 'установка идёт' + (cur ? ', сейчас шаг «' + cur + '»' : '');
  }
  const names = (rep.failed || []).map(nameOfId).join(', ');
  if (STATE.repairMode) return rep.ok ? 'проверка и починка прошли' : 'проверка нашла проблемы: ' + names;
  return rep.ok
    ? 'установка прошла' + (rep.errors && rep.errors.length ? ' (есть оговорки ниже)' : '')
    : 'не встало: ' + names;
}

document.addEventListener('DOMContentLoaded', init);
