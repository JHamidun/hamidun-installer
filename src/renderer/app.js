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
  detected: {},      // id -> {installed, detectedVersion, installedVersion, currentVersion, updateAvailable, receipted}
  repair: {},        // id -> bool: переустановить начисто (форс — отключает аддитивность)
  repairConfirmed: {}, // id -> bool: перезапись ~/.claude ОТДЕЛЬНО подтверждена диалогом (P0-1)
  detectDone: false,   // P0-1: кнопка установки выключена, пока детекция не завершилась
};

// Компоненты, которые деинсталлятор умеет безопасно удалить целиком (самодостаточные
// артефакты вне ~/.claude). Для остального «Удалить» в UI не показываем.
// v1: Nomad ИСКЛЮЧЁН из авто-удаления (TOCTOU/data-loss риск в сносе venv/шимов —
// Codex P0). Nomad по-прежнему СТАВИТСЯ, но кнопку «Удалить» для него не показываем
// и удаление не выполняем. Полноценный Nomad-uninstall вернём позже отдельной фазой.
const REMOVABLE = new Set(['course', 'uv', 'mascot', 'bridge']);

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
  const boot = await window.installer.bootstrap();
  STATE.platform = boot.platform;
  STATE.homedir = boot.homedir;
  STATE.config = boot.config || {};
  STATE.logPath = boot.logPath || '';
  STATE.freeGB = (typeof boot.freeGB === 'number') ? boot.freeGB : null;
  STATE.resourcesRoot = boot.resourcesRoot || '';
  STATE.userWarning = boot.userWarning || '';
  STATE.vendorAvailable = boot.vendorAvailable !== false;
  STATE.vendorBlock = boot.vendorBlock || { blocked: false };
  STATE.vendorBlocked = !!STATE.vendorBlock.blocked;
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

  // Хэндл бота на приветственном экране — из конфига (без хардкода в статике).
  const wcBot = $('#wc-bot-handle');
  if (wcBot) wcBot.textContent = botHandle();
  renderGroups();
  renderPacks();
  renderPreflight();
  renderUserWarning();
  renderVendorBlock();
  renderProgressBotBanner();
  refreshDerived();
  // Приветственный экран показываем ПЕРВЫМ — но только после renderVendorBlock,
  // чтобы стоп-экран App-Translocation имел приоритет (STATE.vendorBlocked уже выставлен).
  showInitialScreen();

  $('#btn-install').addEventListener('click', startInstall);
  $('#btn-welcome-go').addEventListener('click', goToSelect);
  const wcWhatBtn = $('#btn-wc-what');
  if (wcWhatBtn) wcWhatBtn.addEventListener('click', showWhatInstalls);
  const whatBtn = $('#btn-what-installs');
  if (whatBtn) whatBtn.addEventListener('click', showWhatInstalls);
  const nextBtn = $('#btn-what-next');
  if (nextBtn) nextBtn.addEventListener('click', () => openStartHereMemo());
  $('#btn-finish').addEventListener('click', async () => {
    const auto = $('#ns-autovscode');
    if (auto && auto.checked) { await window.installer.launchVsCode(); }
    window.installer.quit();
  });
  $('#packs-all').addEventListener('click', () => setAllPacks(true));
  $('#packs-none').addEventListener('click', () => setAllPacks(false));
  setupMascots();
  // Детекция состояния — best-effort, после первичного рендера (не блокирует UI).
  detectAndApply();
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
    Object.keys(STATE.detected).forEach((id) => {
      const c = STATE.byId[id];
      if (STATE.detected[id].installed && c && !c.hidden && !STATE.repair[id]) {
        STATE.selected[id] = false; // установленное по умолчанию не переустанавливаем
      }
    });
    renderGroups();
    renderInstalledBanner();
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
  const det = (STATE.detected && STATE.detected[c.id]) || null;
  const installed = !!(det && det.installed);
  const updateAvail = !!(det && det.updateAvailable);
  const el = document.createElement('div');
  el.className = 'card' + (checked ? ' checked' : '') + (installed ? ' installed' : '');
  const reqNames = (c.requires || []).map((r) => STATE.byId[r] && STATE.byId[r].name).filter(Boolean);
  const okBadge = installed
    ? `<span class="badge ok">✓ уже установлено${det.detectedVersion ? ' · ' + escapeHtml(det.detectedVersion) : ''}</span>`
    : '';
  const updBadge = updateAvail ? `<span class="badge upd">обновление доступно</span>` : '';
  const recBadge = c.recommended ? `<span class="badge rec">рекомендуется</span>` : '';
  el.innerHTML = `
    <div class="checkbox">${CHECK_SVG}</div>
    <div class="card-body">
      <div class="card-name">
        ${c.name}
        ${recBadge}
        ${c.why ? `<span class="info" tabindex="0" role="button" aria-label="Что это?">?<span class="tip">${c.why || c.desc}</span></span>` : ''}
        ${c.sizeHint ? `<span class="badge">${c.sizeHint}</span>` : ''}
        ${c.online ? `<span class="badge online" title="Скачивается онлайн во время установки">онлайн</span>` : ''}
        ${c.needsAdmin ? `<span class="badge admin">админ</span>` : ''}
        ${reqNames.length ? `<span class="badge dep">требует: ${reqNames.join(', ')}</span>` : ''}
        ${okBadge}
        ${updBadge}
      </div>
      <div class="card-desc">${c.desc}</div>
      ${installed ? renderInstalledActions(c) : ''}
    </div>`;
  el.addEventListener('click', () => toggle(c.id));
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
      '<p>macOS переместил приложение в защищённую область, поэтому офлайн-компоненты недоступны.</p>' +
      '<p>Закрой это окно и запусти установщик <b>двойным кликом прямо в открытом окне DMG</b> ' +
      '(<b>не</b> из «Программ»). Если уже перетащил в «Программы» — удали оттуда и запусти из образа.</p>',
    closeLabel: 'Понятно',
    blocking: true,
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
  el.innerHTML = '⚠️ Запусти установщик из окна, которое открылось при монтировании DMG ' +
    '(двойным кликом по «Hamidun Setup» там), а не из «Программы». Иначе офлайн-файлы ' +
    'не подхватятся и установка может не пройти.';
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

// Task 3 (страх вируса): попап «Что скачается на мой ПК» — реальный список из
// components.json (имя + описание + примерный размер sizeHint). Служебные (hidden,
// напр. verify) не показываем. Ничего не выдумываем — только данные конфига.
function showWhatInstalls() {
  const rows = [];
  (STATE.groups || []).forEach((g) => {
    (g.components || []).forEach((c) => {
      if (!c || c.hidden) return;
      const size = c.sizeHint ? ' <span class="wi-size">' + escapeHtml(c.sizeHint) + '</span>' : '';
      rows.push(
        '<li><div class="wi-name">' + escapeHtml(c.name) + size + '</div>' +
        '<div class="wi-desc">' + escapeHtml(c.desc || '') + '</div></li>'
      );
    });
  });
  const body =
    '<p class="wi-lead">Ставится только то, что ты выбрал. Основное — офлайн из самого ' +
    'установщика; компоненты с пометкой «онлайн» докачиваются с официальных источников ' +
    'с проверкой целостности.</p>' +
    '<ul class="wi-list">' + rows.join('') + '</ul>';
  openModal({
    id: 'what-installs',
    emoji: '📦',
    title: 'Что скачается на мой ПК',
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

// Task 4b: заметная плашка «Не едет? Напиши боту…» на экране прогресса (и финиша —
// это тот же view). Ссылка ведёт на бота-спутника из config.links.bot.
function renderProgressBotBanner() {
  const el = $('#progress-bot-banner');
  if (!el) return;
  const links = (STATE.config && STATE.config.links) || {};
  const botBase = links.bot || '';
  if (!botBase) return; // нет бота в конфиге — плашку не показываем
  el.innerHTML =
    '<span class="progress-bot-ico" aria-hidden="true">💬</span>' +
    '<span class="progress-bot-text">Не едет? Напиши боту, кинь скриншот — проведёт за руку.</span>' +
    '<button type="button" class="btn-sm progress-bot-btn" data-ext="' + escapeHtml(botBase) + '">Написать боту</button>';
  el.classList.remove('hidden');
  const btn = el.querySelector('[data-ext]');
  if (btn) btn.addEventListener('click', () => window.installer.openExternal(btn.dataset.ext));
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
  // P0-1: кнопка выключена, пока детекция установленного не завершилась — чтобы
  // установка не стартовала с недодетектированным состоянием (режим/галки).
  // App-Translocation / оторванный vendor (STATE.vendorBlocked) — жёсткий стоп:
  // «Установить» не даём, пока офлайн-vendor неполон (main решает авторитетно).
  $('#btn-install').disabled = n === 0 || !STATE.detectDone || !!STATE.vendorBlocked;

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
      .filter((id) => STATE.repairConfirmed[id] && STATE.repair[id]).join(',')
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
  // Два РАЗНЫХ вида пропуска (см. ветки ниже):
  //   depSkipped      — не встала ЗАВИСИМОСТЬ (это проблема: идёт в retry, ломает okAll);
  //   gracefulSkipped — осознанный exit 120 «нечего ставить / не входит в сборку»
  //                     (это НЕ ошибка: не идёт в retry, НЕ ломает okAll, не шлётся в ok:false).
  const depSkipped = [];
  const gracefulSkipped = [];
  const bad = new Set();
  // Компоненты, пропущенные В ХОДЕ прогона (dep-провал ИЛИ осознанный exit-120-skip).
  // Их убираем из HM_SELECTED перед verify, иначе verify нарисует по ним красный крест.
  const runtimeSkipped = new Set();
  let ok = 0;
  for (const id of ids) {
    appendLog(`\n=== ${STATE.byId[id].name} ===`);
    // If a dependency failed, skip (don't run) — a cascade of reds would hide the root cause.
    const broken = firstBrokenDep(id, bad);
    if (broken) {
      setStep(id, 'skipped');
      depSkipped.push(id);
      bad.add(id);
      runtimeSkipped.add(id);
      appendLog(`[~] Пропущено: не установлена зависимость «${STATE.byId[broken].name}»`);
      $('#progress-summary').textContent = `Готово: ${ok} · Ошибок: ${failed.length} · Пропущено: ${depSkipped.length + gracefulSkipped.length} · Всего: ${ids.length}`;
      continue;
    }
    // Свежий прогон проверки — старые результаты чеклиста неактуальны.
    if (id === 'verify') STATE.checks = [];
    setStep(id, 'running');

    // Remote-компонент: докачку+проверку+распаковку+запуск делает АТОМАРНО main
    // внутри runComponent (renderer не задаёт путь кэша и не вклинивается между
    // шагами — см. main.js). Здесь только показываем прогресс докачки в step-list;
    // логи докачки и «целостность подтверждена (SHA-256)» приходят из main по
    // тому же каналу component-log. Провал докачки → res.stage==='fetch'.
    const comp = STATE.byId[id];
    let offP = null;
    if (comp && comp.remote) {
      setStepLabel(id, `${comp.name} — Скачиваю…`);
      appendLog(`[↓] Докачка ${comp.name} из облака…`);
      offP = window.installer.onRemoteProgress((p) => {
        if (!p || p.id !== id) return;
        setStepLabel(id, (p.pct != null)
          ? `${comp.name} — Скачиваю ${p.pct}%`
          : `${comp.name} — Скачиваю…`);
      });
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

    if (offP) { offP(); setStepLabel(id, comp.name); } // вернуть обычную подпись

    if (res && res.skipped) {
      // P1: осознанный пропуск компонента (exit 120 — нечего ставить, напр. VS Code не
      // вшит в сборку И не установлен). НЕ успех и НЕ ошибка: помечаем skipped И заносим
      // в bad, чтобы зависимые (extension requires vscode) не запускались красным впустую,
      // а тоже грациозно пропускались. Из HM_SELECTED для verify компонент уже убираем.
      setStep(id, 'skipped');
      gracefulSkipped.push(id);
      bad.add(id);
      runtimeSkipped.add(id);
      appendLog(`[~] Пропущено: нечего устанавливать (${STATE.byId[id].name}).`);
    } else if (res && res.ok) { setStep(id, 'done'); ok++; }
    else {
      setStep(id, 'error');
      failed.push(id);
      bad.add(id);
      const name = STATE.byId[id].name;
      if (res && res.stage === 'fetch') {
        appendLog(`[!] ${name}: докачка не удалась — ${res.error || 'нет соединения'}`);
      } else {
        appendLog(`[!] ${name}: завершено с кодом ${res ? res.code : '?'}${res && res.error ? ' — ' + res.error : ''}`);
      }
    }
    $('#progress-summary').textContent = `Готово: ${ok} · Ошибок: ${failed.length} · Пропущено: ${depSkipped.length + gracefulSkipped.length} · Всего: ${ids.length}`;
  }
  off && off();
  return { failed, depSkipped, gracefulSkipped };
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
  // Жёсткий стоп при App-Translocation / оторванном vendor: даже если кнопку как-то
  // нажали — установку не начинаем, повторно показываем блокирующее окно.
  if (STATE.vendorBlocked) { renderVendorBlock(); return; }
  const order = ensureVerifyLast(installOrder());
  if (!order.length) return;
  // Телеметрия: момент старта (для duration_sec) и согласие — снимаем ДО ухода
  // с экрана выбора (чекбокс #telemetry-opt; нет элемента = считаем согласием,
  // как и было бы по умолчанию).
  STATE.installStartedAt = Date.now();
  const telOpt = $('#telemetry-opt');
  STATE.telemetryConsent = !telOpt || !!telOpt.checked;
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
  // depSkipped (упала зависимость) = проблема; gracefulSkipped (exit 120, «не входит
  // в сборку») = НЕ проблема и на исход установки не влияет.
  const depSkipped = res.depSkipped || [];
  const gracefulSkipped = res.gracefulSkipped || [];
  // Независимая проверка (verify) может найти проблему, даже когда все шаги
  // «прошли». Красный крестик чеклиста = провал; skip (снятые компоненты) — нет.
  const checkFailed = (STATE.checks || []).some(
    (c) => (c.status || (c.ok ? 'ok' : 'fail')) === 'fail'
  );
  // Осознанный exit-120-skip НЕ ломает okAll — компонент просто не входит в эту сборку.
  const okAll = failed.length === 0 && depSkipped.length === 0 && !checkFailed;
  let title, sub;
  if (okAll) {
    title = 'Готово!';
    sub = 'Всё установлено. Ниже — три простых шага до первого результата, или нажми кнопку бота — он поведёт дальше.';
  } else if (failed.length === 0 && depSkipped.length === 0) {
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
  renderNextSteps(failed, depSkipped, gracefulSkipped);
  sendInstallTelemetry(failed, okAll, gracefulSkipped);
  $('#btn-finish').classList.remove('hidden');
}

// Анонимная телеметрия установки: ОДИН POST по завершении (повторные финиши после
// «Повторить неустановленное» не шлют — guard telemetrySent). Opt-out — чекбоксом
// на экране выбора. БЕЗ uid и ПД: только исход, id упавших компонентов и длительность.
// Сам POST делает MAIN (CSP renderer'а запрещает сеть; URL зашит в config.json,
// renderer его не задаёт); там таймаут 5с и все ошибки глотаются — установка от
// телеметрии не зависит ни в каком исходе.
function sendInstallTelemetry(failed, okAll, gracefulSkipped) {
  if (STATE.telemetrySent || STATE.telemetryConsent === false) return;
  STATE.telemetrySent = true;
  const durationSec = STATE.installStartedAt
    ? Math.max(0, Math.round((Date.now() - STATE.installStartedAt) / 1000))
    : 0;
  try {
    // gracefulSkipped едет отдельным полем (симметрично тому, как main санитизирует
    // failed) — и НЕ влияет на ok: осознанный «не входит в сборку» это не провал.
    const p = window.installer.sendTelemetry({
      ok: !!okAll,
      failed: (failed || []).slice(),
      skipped: (gracefulSkipped || []).slice(),
      durationSec,
    });
    if (p && p.catch) p.catch(() => { /* молча */ });
  } catch (e) { /* телеметрия никогда не ломает финиш */ }
}

function renderNextSteps(failed, depSkipped, gracefulSkipped) {
  failed = failed || [];
  depSkipped = depSkipped || [];
  gracefulSkipped = gracefulSkipped || [];
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
  const retryList = failed.concat(depSkipped);
  const depSkipHtml = depSkipped.length
    ? `<div class="ns-fail">Пропущено (не встала зависимость): <b>${depSkipped.map((i) => STATE.byId[i].name).join(', ')}</b>.</div>`
    : '';
  const failHtml = retryList.length
    ? `<div class="ns-fail">${failed.length ? 'Не установилось: <b>' + failed.map((i) => STATE.byId[i].name).join(', ') + '</b>. ' : ''}
         <button type="button" id="ns-retry" class="btn-sm">Повторить неустановленное</button>
         <div class="ns-fail-hint">Если повтор не помогает — нажми «Показать лог для поддержки» ниже и пришли этот файл в ${botH}.</div></div>` + depSkipHtml
    : '';
  // Осознанный пропуск (не входит в эту сборку) — нейтральная строка, НЕ ошибка и БЕЗ кнопки повтора.
  const gracefulSkipHtml = gracefulSkipped.length
    ? `<div class="ns-note">Не входит в эту сборку — пропущено (это не ошибка): <b>${gracefulSkipped.map((i) => STATE.byId[i].name).join(', ')}</b>.</div>`
    : '';

  // Deep-link в бота — по РЕЗУЛЬТАТУ установки (pure-логика в finish-link.js, шарится
  // с тестами): всё ок → ?start=installed_win|installed_mac; есть упавшие компоненты →
  // ?start=failed_<первый-упавший-id>_win|_mac (напр. failed_cursor_win).
  const startPayload = window.HMFinishLink.botStartPayload(failed, isWin, fin.botStartPayload || 'installed');
  const botUrl = window.HMFinishLink.botUrl(links.bot || '', startPayload);
  // Заметная CTA-карточка бота академии: новичок должен сразу видеть, куда бежать
  // за помощью. Открытие ссылки — через тот же механизм data-ext → openExternal,
  // что и остальные внешние кнопки (обработчик вешается ниже одним querySelectorAll).
  const botCta = botUrl
    ? `<div class="ns-bot">
         <div class="ns-bot-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M21.5 3.6 2.9 10.8c-1 .4-1 1.8.1 2.1l4.6 1.5 1.7 5.2c.3 1 1.6 1.2 2.2.4l2.4-2.9 4.7 3.4c.8.6 2 .2 2.2-.9l2.5-14.2c.2-1.1-.8-2-1.8-1.6Z" fill="#fff"/></svg></div>
         <div class="ns-bot-body">
           <div class="ns-bot-title">Застрял или что-то непонятно?</div>
           <div class="ns-bot-text">Спроси бота академии — он ответит и проведёт по шагам. Это нормально в первый день.</div>
         </div>
         <button type="button" class="ns-bot-btn" data-ext="${botUrl}">Спросить бота ${botH}</button>
       </div>`
    : '';
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

  // Третий шаг ведёт на бота; если ссылки на бота в конфиге нет — на памятку.
  const step3 = botUrl
    ? `<li><b>Если что-то не получается</b> — не разбирайся в одиночку: нажми кнопку «Бот-помощник» рядом с «Открыть VS Code» — бот ответит и проведёт по шагам.</li>`
    : `<li><b>Если что-то не получается</b> — открой памятку «Что дальше» ниже: в ней ответы на весь первый день.</li>`;

  // ── Доступ к нейросети (CJM: главный барьер воронки «скачал → Claude заработал») ──
  // Два пути: своя подписка Claude ИЛИ Nomad для РФ (без VPN/зарубежной карты, рубли).
  // Карту Nomad показываем ВСЕГДА: это способ подключить нейросеть, а не отчёт об
  // установке. Меняется только ТЕКСТ — по РЕАЛЬНОМУ статусу установки (не по галочке
  // выбора): компонент прошёл успешно в этом прогоне ИЛИ уже стоял на машине (детект)
  // → «уже установлен»; упал / пропущен (exit 120, lite-сборка) / не выбирался →
  // честное «можно доустановить» (повторный запуск установщика с галочкой Nomad).
  const nomadInstalled =
    (!!(STATE.selected && STATE.selected.nomad) &&
      !failed.includes('nomad') && !depSkipped.includes('nomad') &&
      !gracefulSkipped.includes('nomad')) ||
    !!(STATE.detected && STATE.detected.nomad && STATE.detected.nomad.installed);
  const cloud = (STATE.config && STATE.config.nomad && STATE.config.nomad.cloud) || {};
  const claudeUrl = links.claude || 'https://claude.ai/login';
  const nomadText = nomadInstalled
    ? 'Без VPN и без зарубежной карты, оплата в рублях. Агент Nomad уже установлен: зарегистрируйся в кабинете, получи ключ и вставь его — Claude заработает через облако Nomad.'
    : 'Без VPN и без зарубежной карты, оплата в рублях. Агент Nomad не установлен — можно доустановить: запусти установщик ещё раз и отметь компонент Nomad. Зарегистрироваться в кабинете и получить ключ можно уже сейчас.';
  const nomadCard = cloud.registerUrl
    ? `<div class="ns-access-card ns-access-card--hl">
         <div class="ns-access-h">🇷🇺 Из России — через Nomad</div>
         <div class="ns-access-t">${nomadText}</div>
         <div class="ns-access-btns">
           <button type="button" class="ns-access-btn primary" data-ext="${cloud.registerUrl}">Регистрация в кабинете</button>
           ${cloud.keysUrl ? `<button type="button" class="ns-access-btn" data-ext="${cloud.keysUrl}">Получить ключ</button>` : ''}
         </div>
       </div>`
    : '';
  const accessHtml = `
    <div class="ns-access">
      <div class="ns-access-title">Осталось подключить нейросеть — без неё Claude не ответит. Выбери, как удобно:</div>
      <div class="ns-access-grid">
        <div class="ns-access-card">
          <div class="ns-access-h">💳 Своя подписка Claude</div>
          <div class="ns-access-t">Если есть зарубежная карта — оформи Claude Pro или Max. При первом запросе Claude сам попросит войти.</div>
          <div class="ns-access-btns"><button type="button" class="ns-access-btn" data-ext="${claudeUrl}">Войти на claude.ai</button></div>
        </div>
        ${nomadCard}
      </div>
    </div>`;

  const ns = $('#next-steps');
  ns.innerHTML = `
    <div class="ns-title">Что дальше — три простых шага</div>
    <ol class="ns-steps">
      <li><b>Открой VS Code</b> — синяя кнопка ниже. Это твоя мастерская: слева файлы проекта, сбоку — панель Claude со значком <b>✳</b>.</li>
      <li><b>Напиши первый запрос в панели Claude</b> — по-русски, своими словами: например, «сделай мне сайт-визитку». При первом запросе Claude попросит подключить нейросеть — как это сделать (своя подписка или Nomad для РФ), смотри в блоке ниже.</li>
      ${step3}
    </ol>
    ${accessHtml}
    ${checksHtml}
    ${failHtml}
    ${gracefulSkipHtml}
    <div class="ns-actions">
      <button type="button" id="ns-vscode" class="btn-sm primary ns-main">▶ Открыть VS Code</button>
      ${botUrl ? `<button type="button" class="btn-sm ns-bot-main" data-ext="${botUrl}">💬 ${window.HMFinishLink.botButtonLabel(failed)}</button>` : ''}
      ${cursorSelected ? `<button type="button" id="ns-cursor" class="btn-sm">Открыть Cursor</button>` : ''}
      <button type="button" id="ns-claude" class="btn-sm">⚡ Войти в Claude через терминал</button>
      <button type="button" id="ns-keys" class="btn-sm">Показать файл ключей</button>
      ${logBtn}
      ${videoBtn}
      ${startBtn}
    </div>
    ${botCta}
    ${keysHtml}
    <label class="ns-auto"><input type="checkbox" id="ns-autovscode" ${fin.autoOpenCursorDefault ? 'checked' : ''}/> Открыть VS Code на папке проекта при нажатии «Готово»</label>`;
  ns.classList.remove('hidden');

  $('#ns-claude').addEventListener('click', () => window.installer.openClaudeTerminal());
  $('#ns-vscode').addEventListener('click', () => window.installer.launchVsCode());
  const cursorBtn = $('#ns-cursor');
  if (cursorBtn) cursorBtn.addEventListener('click', () => window.installer.launchCursor());
  // reveal in Explorer/Finder — openPath on a .env silently fails on macOS.
  $('#ns-keys').addEventListener('click', () => window.installer.revealPath(credPath));
  const logBtnEl = $('#ns-log');
  if (logBtnEl) logBtnEl.addEventListener('click', () => window.installer.openPath(STATE.logPath));
  const startBtnEl = $('#ns-start');
  if (startBtnEl && startHtmlRel) {
    // Открытие памятки — через общий openStartHereMemo (тот же вход, что у кнопки
    // «Что будет дальше?» на экране выбора): save-на-стол + фолбэк на вшитую копию.
    if (!STATE.startHereOpened) {
      STATE.startHereOpened = true;
      openStartHereMemo(); // авто-открытие после установки + копия на рабочий стол
    }
    startBtnEl.addEventListener('click', () => openStartHereMemo());
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
