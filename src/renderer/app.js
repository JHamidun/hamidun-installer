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
  logPath: '',     // ~/.hamidun-setup/install.log (из bootstrap)
  freeGB: null,    // свободное место на диске в ГБ (preflight, из bootstrap)
  checks: [],      // результаты "CHECK ok/fail/skip <ярлык>" от компонента verify
  resourcesRoot: '', // абсолютный путь к ресурсам (для оффлайн START-HERE)
  userWarning: '',   // предупреждение, если установщик запущен под другим пользователем
};

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

async function init() {
  const boot = await window.installer.bootstrap();
  STATE.platform = boot.platform;
  STATE.homedir = boot.homedir;
  STATE.config = boot.config || {};
  STATE.logPath = boot.logPath || '';
  STATE.freeGB = (typeof boot.freeGB === 'number') ? boot.freeGB : null;
  STATE.resourcesRoot = boot.resourcesRoot || '';
  STATE.userWarning = boot.userWarning || '';
  STATE.vendorAvailable = boot.vendorAvailable !== false;
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
    })
  );

  renderGroups();
  renderPacks();
  renderPreflight();
  renderUserWarning();
  renderVendorWarning();
  refreshDerived();

  $('#btn-install').addEventListener('click', startInstall);
  $('#btn-finish').addEventListener('click', async () => {
    const auto = $('#ns-autocursor');
    if (auto && auto.checked) { await window.installer.launchCursor(); }
    window.installer.quit();
  });
  $('#packs-all').addEventListener('click', () => setAllPacks(true));
  setupMascots();
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

// ---- selection / dependency logic ----------------------------------

// Dependency resolution lives in deps.js (window.HMDeps) — shared with tests.
function enableWithDeps(id) { window.HMDeps.enableWithDeps(STATE.selected, STATE.byId, id); }
function disableDependents(id) { window.HMDeps.disableDependents(STATE.selected, STATE.byId, id); }

function toggle(id) {
  if (STATE.selected[id]) disableDependents(id);
  else enableWithDeps(id);
  renderGroups();
  refreshDerived();
}

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
}

function renderCard(c) {
  const checked = STATE.selected[c.id];
  const el = document.createElement('div');
  el.className = 'card' + (checked ? ' checked' : '');
  const reqNames = (c.requires || []).map((r) => STATE.byId[r] && STATE.byId[r].name).filter(Boolean);
  el.innerHTML = `
    <div class="checkbox">${CHECK_SVG}</div>
    <div class="card-body">
      <div class="card-name">
        ${c.name}
        ${c.why ? `<span class="info" tabindex="0" role="button" aria-label="Что это?">?<span class="tip">${c.why || c.desc}</span></span>` : ''}
        ${c.sizeHint ? `<span class="badge">${c.sizeHint}</span>` : ''}
        ${c.needsAdmin ? `<span class="badge admin">админ</span>` : ''}
        ${reqNames.length ? `<span class="badge dep">требует: ${reqNames.join(', ')}</span>` : ''}
      </div>
      <div class="card-desc">${c.desc}</div>
    </div>`;
  el.addEventListener('click', () => toggle(c.id));
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

// Preflight: жёлтое предупреждение о нехватке места (не блокирует установку).
function renderPreflight() {
  if (STATE.freeGB === null || STATE.freeGB >= 4) return;
  if (document.getElementById('preflight-warn')) return;
  const el = document.createElement('div');
  el.id = 'preflight-warn';
  el.className = 'preflight-warn';
  el.innerHTML = `⚠️ На диске свободно всего <b>${STATE.freeGB} ГБ</b>, а для полной установки нужно ~4 ГБ. ` +
    `Установка может прерваться — освободи место или сними тяжёлые компоненты (Python-пакеты, Nomad).`;
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
  el.innerHTML = '⚠️ Запусти установщик из окна, которое открылось при монтировании DMG ' +
    '(двойным кликом по «Hamidun Setup» там), а не из «Программы». Иначе офлайн-файлы ' +
    'не подхватятся и установка может не пройти.';
  const hero = document.querySelector('#view-select .hero');
  if (hero) hero.insertAdjacentElement('afterend', el);
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
  $('#summary').textContent = `Выбрано: ${n} компонентов · наборов скиллов: ${np}/${total}${skillsPart}`;
  $('#btn-install').disabled = n === 0;

  // Наборы скиллов имеют смысл только если ставится Конфиг — иначе гасим секцию.
  const configOn = !!STATE.selected['config'];
  const pw = $('#packs-wrap');
  if (pw) pw.classList.toggle('disabled', !configOn);
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
    HM_SELECTED: selectedIds().join(',')
  };
}

function appendLog(line) {
  const log = $('#log');
  log.textContent += line + '\n';
  log.scrollTop = log.scrollHeight;
}

function setStep(id, status) {
  const step = document.querySelector(`.step[data-id="${id}"]`);
  if (step) step.className = 'step ' + status;
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
function firstBrokenDep(id, badSet) {
  const reqs = (STATE.byId[id] && STATE.byId[id].requires) || [];
  for (const r of reqs) {
    if (badSet.has(r)) return r;
    const deeper = firstBrokenDep(r, badSet);
    if (deeper) return deeper;
  }
  return null;
}

async function runComponents(ids, env) {
  const off = window.installer.onLog(({ line }) => {
    // Строки "CHECK ok <ярлык>" / "CHECK fail <ярлык>" от verify-скрипта не
    // сыпем в общий лог — собираем для чеклиста на финальном экране.
    if (line.startsWith('CHECK ')) {
      const m = line.match(/^CHECK (ok|fail|skip)\s+(.*)$/);
      if (m) { STATE.checks.push({ status: m[1], ok: m[1] === 'ok', label: m[2] }); return; }
    }
    appendLog(line);
  });
  const failed = [];
  const skipped = [];
  const bad = new Set();
  let ok = 0;
  for (const id of ids) {
    appendLog(`\n=== ${STATE.byId[id].name} ===`);
    // If a dependency failed, skip (don't run) — a cascade of reds would hide the root cause.
    const broken = firstBrokenDep(id, bad);
    if (broken) {
      setStep(id, 'skipped');
      skipped.push(id);
      bad.add(id);
      appendLog(`[~] Пропущено: не установлена зависимость «${STATE.byId[broken].name}»`);
      $('#progress-summary').textContent = `Готово: ${ok} · Ошибок: ${failed.length} · Пропущено: ${skipped.length} · Всего: ${ids.length}`;
      continue;
    }
    // Свежий прогон проверки — старые результаты чеклиста неактуальны.
    if (id === 'verify') STATE.checks = [];
    setStep(id, 'running');
    const res = await window.installer.runComponent(id, env);
    if (res.ok) { setStep(id, 'done'); ok++; }
    else {
      setStep(id, 'error');
      failed.push(id);
      bad.add(id);
      appendLog(`[!] ${STATE.byId[id].name}: завершено с кодом ${res.code}${res.error ? ' — ' + res.error : ''}`);
    }
    $('#progress-summary').textContent = `Готово: ${ok} · Ошибок: ${failed.length} · Пропущено: ${skipped.length} · Всего: ${ids.length}`;
  }
  off && off();
  return { failed, skipped };
}

// Карусель советов на время установки: то, что спасает новичка в первый день
// (сжато из памятки «Что дальше»). Общие для обоих установщиков — без курса.
const TIPS = [
  '<kbd>Esc</kbd> мгновенно останавливает Claude. Писать «стой» в чат бесполезно — сообщение просто встанет в очередь.',
  'Испортил файл? <code>/rewind</code> откатит правки: Claude сам делает точку сохранения перед каждым изменением.',
  'Открывая папку, Cursor спросит «Do you trust the authors?» — жми <b>Yes</b>, иначе панель Claude молча не заработает.',
  'В Cursor два ИИ-чата. Встроенный (<kbd>Ctrl</kbd>+<kbd>L</kbd>) — отдельный платный продукт Cursor. Твой — панель со значком <b>✳</b>.',
  '<kbd>Ctrl</kbd>+<kbd>Esc</kbd> открывает панель Claude из любого места Cursor.',
  'Квота подписки общая: переписка на claude.ai и работа в Claude Code тратят один лимит. Остаток покажет <code>/usage</code>.',
  '«Limit reached» — не поломка. Время сброса написано прямо в сообщении, ничего не теряется.',
  'Скриншот в чат: Windows — <kbd>Alt</kbd>+<kbd>V</kbd>, Mac — <kbd>Ctrl</kbd>+<kbd>V</kbd>. Или перетащи файл, зажав <kbd>Shift</kbd>.',
  'Одна задача — один разговор. Закончил — <code>/clear</code>, и следующая задача пойдёт быстрее и точнее.',
  'Правый клик по файлу → <b>Open Timeline</b>: Cursor хранит прошлые версии каждого файла, даже без git.',
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

async function startInstall() {
  const order = ensureVerifyLast(installOrder());
  if (!order.length) return;
  $('#view-select').classList.add('hidden');
  $('#view-progress').classList.remove('hidden');
  buildSteps(order);
  startTips();
  LAST_ENV = envForRun();
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
  const skipped = res.skipped || [];
  // Независимая проверка (verify) может найти проблему, даже когда все шаги
  // «прошли». Красный крестик чеклиста = провал; skip (снятые компоненты) — нет.
  const checkFailed = (STATE.checks || []).some(
    (c) => (c.status || (c.ok ? 'ok' : 'fail')) === 'fail'
  );
  const okAll = failed.length === 0 && skipped.length === 0 && !checkFailed;
  let title, sub;
  if (okAll) {
    title = 'Готово!';
    sub = 'Осталось войти в Claude Code своей подпиской — шаги ниже.';
  } else if (failed.length === 0 && skipped.length === 0) {
    // Все компоненты встали, но verify нашёл проблему — направляем в лог и бота.
    title = 'Установка завершена, но проверка нашла проблемы';
    sub = 'Нажми «Показать лог для поддержки» ниже и пришли файл в бота — поможем разобраться.';
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
    mascot.alt = okAll ? 'Омлетон доволен — всё установилось' : 'Омлетон задумался — есть проблемы';
  }
  renderNextSteps(failed, skipped);
  $('#btn-finish').classList.remove('hidden');
}

function renderNextSteps(failed, skipped) {
  failed = failed || [];
  skipped = skipped || [];
  const links = (STATE.config && STATE.config.links) || {};
  const fin = (STATE.config && STATE.config.finish) || {};
  const isWin = STATE.platform === 'win32';
  const relRaw = fin.credentialsRelPath || '.claude/.credentials.master.env';
  const sep = isWin ? '\\' : '/';
  const rel = isWin ? relRaw.replace(/\//g, '\\') : relRaw.replace(/\\/g, '/');
  const credPath = STATE.homedir ? STATE.homedir + sep + rel : rel;

  // Retry both the real failures and anything skipped because a dep failed
  // (retrying the dep may unblock them).
  const retryList = failed.concat(skipped);
  const skipHtml = skipped.length
    ? `<div class="ns-fail">Пропущено (не встала зависимость): <b>${skipped.map((i) => STATE.byId[i].name).join(', ')}</b>.</div>`
    : '';
  const failHtml = retryList.length
    ? `<div class="ns-fail">${failed.length ? 'Не установилось: <b>' + failed.map((i) => STATE.byId[i].name).join(', ') + '</b>. ' : ''}
         <button type="button" id="ns-retry" class="btn-sm">Повторить неустановленное</button>
         <div class="ns-fail-hint">Если повтор не помогает — нажми «Показать лог для поддержки» ниже и пришли этот файл в @HamidunAcademyBot.</div></div>` + skipHtml
    : '';

  // Deeplink в бота: payload кодирует результат (_f/_ok) и платформу (w/m), ≤64 символов.
  const basePayload = fin.botStartPayload || 'installed';
  const startPayload = (basePayload +
    ((failed.length || skipped.length) ? '_f' : '_ok') +
    '_' + (isWin ? 'w' : 'm')).slice(0, 64);
  const botUrl = links.bot ? links.bot + '?start=' + encodeURIComponent(startPayload) : '';
  const botBtn = botUrl ? `<button type="button" class="btn-sm primary" data-ext="${botUrl}">↩ Открыть бота — что дальше</button>` : '';
  const videoBtn = links.video ? `<button type="button" class="btn-sm" data-ext="${links.video}">▶ Видео: что дальше</button>` : '';
  // Памятка «Что дальше»: START-HERE.html вшит (finish.startHtmlRelPath). На финише
  // копируем её на рабочий стол (постоянная, всегда доступна) и открываем один раз.
  // Кнопка ниже переоткрывает памятку в любой момент.
  const startHtmlRel = fin.startHtmlRelPath || '';
  const startBtn = startHtmlRel
    ? `<button type="button" id="ns-start" class="btn-sm">📌 Открыть памятку «Что дальше»</button>`
    : '';
  const logBtn = STATE.logPath ? `<button type="button" id="ns-log" class="btn-sm">Показать лог для поддержки</button>` : '';

  // Чеклист из verify-скрипта ("CHECK ok/fail/skip <ярлык>").
  const checks = STATE.checks || [];
  const checkLi = (c) => {
    const st = c.status || (c.ok ? 'ok' : 'fail');
    // skip = компонент не выбирали: рисуем нейтрально (серым), НЕ как провал.
    if (st === 'skip') {
      return `<li class="skip" style="opacity:.5"><span class="mark">–</span><span>${escapeHtml(c.label)} <span style="font-size:11px">(не выбрано)</span></span></li>`;
    }
    return `<li class="${st === 'ok' ? 'ok' : 'fail'}"><span class="mark">${st === 'ok' ? '✓' : '✕'}</span><span>${escapeHtml(c.label)}</span></li>`;
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

  const ns = $('#next-steps');
  ns.innerHTML = `
    <div class="ns-title">Что дальше</div>
    <ol class="ns-steps">
      <li>Нажми <b>«Войти в Claude сейчас»</b> — откроется терминал с Claude Code, войди своей подпиской (Pro/Max). Позже это же — панель Claude Code в Cursor или команда <code>claude</code>.</li>
      <li>Если нужны доп. сервисы — вставь API-ключи ниже или в файл <code>.credentials.master.env</code>.</li>
      <li>Готово — можно работать. Продолжение инструкции — в боте.</li>
    </ol>
    ${checksHtml}
    ${failHtml}
    <div class="ns-actions">
      <button type="button" id="ns-claude" class="btn-sm primary">⚡ Войти в Claude сейчас</button>
      <button type="button" id="ns-cursor" class="btn-sm">Открыть Cursor</button>
      <button type="button" id="ns-keys" class="btn-sm">Показать файл ключей</button>
      ${logBtn}
      ${botBtn}
      ${videoBtn}
      ${startBtn}
    </div>
    ${keysHtml}
    <label class="ns-auto"><input type="checkbox" id="ns-autocursor" ${fin.autoOpenCursorDefault ? 'checked' : ''}/> Открыть Cursor при нажатии «Готово»</label>`;
  ns.classList.remove('hidden');

  $('#ns-claude').addEventListener('click', () => window.installer.openClaudeTerminal());
  $('#ns-cursor').addEventListener('click', () => window.installer.launchCursor());
  // reveal in Explorer/Finder — openPath on a .env silently fails on macOS.
  $('#ns-keys').addEventListener('click', () => window.installer.revealPath(credPath));
  const logBtnEl = $('#ns-log');
  if (logBtnEl) logBtnEl.addEventListener('click', () => window.installer.openPath(STATE.logPath));
  const startBtnEl = $('#ns-start');
  if (startBtnEl && startHtmlRel) {
    // Фолбэк-путь к вшитой памятке в ресурсах (если копия на стол не удалась).
    const startRel = isWin ? startHtmlRel.replace(/\//g, '\\') : startHtmlRel.replace(/\\/g, '/');
    const resPath = STATE.resourcesRoot ? STATE.resourcesRoot + sep + startRel : '';
    // Кэшируем путь копии ТОЛЬКО при успехе — иначе следующий клик повторит
    // попытку копирования (OneDrive/антивирус могли отпустить файл).
    const ensureSaved = async () => {
      if (STATE.startHerePath) return STATE.startHerePath;
      try {
        const r = await window.installer.saveStartHere();
        if (r && r.ok && r.dest) STATE.startHerePath = r.dest;
        return STATE.startHerePath || '';
      } catch (e) { return ''; }
    };
    // Открываем копию на столе; если не вышло (файл удалили, сломана
    // ассоциация .html) — открываем вшитую из ресурсов. Пропавшую копию
    // забываем: следующий клик пересоздаст её через ensureSaved.
    const openMemo = async (target) => {
      if (target) {
        const r = await window.installer.openPath(target);
        if (r && r.ok) return true;
        if (target === STATE.startHerePath) STATE.startHerePath = '';
      }
      if (resPath && target !== resPath) {
        const r2 = await window.installer.openPath(resPath);
        return !!(r2 && r2.ok);
      }
      return false;
    };
    // Один общий вход для авто-открытия и клика: пока операция в полёте,
    // повторный клик игнорируем — иначе память откроется двумя вкладками.
    let memoBusy = false;
    const saveAndOpen = async () => {
      if (memoBusy) return;
      memoBusy = true;
      try { await openMemo((await ensureSaved()) || resPath); }
      finally { memoBusy = false; }
    };
    if (!STATE.startHereOpened) {
      STATE.startHereOpened = true;
      saveAndOpen(); // авто-открытие после установки + копия на рабочий стол
    }
    startBtnEl.addEventListener('click', saveAndOpen);
  }
  const saveKeysBtn = $('#ns-save-keys');
  if (saveKeysBtn) saveKeysBtn.addEventListener('click', saveCredentialKeys);
  ns.querySelectorAll('[data-ext]').forEach((b) => b.addEventListener('click', () => window.installer.openExternal(b.dataset.ext)));
  const retry = $('#ns-retry');
  if (retry) retry.addEventListener('click', () => retryFailed(retryList));
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
      : 'Не удалось сохранить: ' + ((res && res.error) || 'неизвестная ошибка');
  }
}

document.addEventListener('DOMContentLoaded', init);
