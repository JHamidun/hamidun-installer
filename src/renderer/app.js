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
  STATE.groups = (boot.components && boot.components.groups) || [];
  STATE.packsData = boot.packs || { core: [], packs: [] };
  STATE.selectedPacks = {};
  STATE.packsData.packs.forEach((p) => (STATE.selectedPacks[p.id] = true));

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
  refreshDerived();

  $('#btn-install').addEventListener('click', startInstall);
  $('#btn-finish').addEventListener('click', async () => {
    const auto = $('#ns-autocursor');
    if (auto && auto.checked) { await window.installer.launchCursor(); }
    window.installer.quit();
  });
  $('#packs-all').addEventListener('click', () => setAllPacks(true));
  $('#packs-none').addEventListener('click', () => setAllPacks(false));
}

// ---- selection / dependency logic ----------------------------------

function isVpnSelected() {
  return Object.keys(STATE.selected).some(
    (id) => STATE.selected[id] && (id === 'vpn-wg' || id === 'vpn-full')
  );
}

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
        ${c.sizeHint ? `<span class="badge">${c.sizeHint}</span>` : ''}
        ${c.needsAdmin ? `<span class="badge admin">админ</span>` : ''}
        ${reqNames.length ? `<span class="badge dep">требует: ${reqNames.join(', ')}</span>` : ''}
      </div>
      <div class="card-desc">${c.desc}</div>
    </div>`;
  el.addEventListener('click', () => toggle(c.id));
  return el;
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
        <div class="pack-name">${p.name} <span class="badge">${(p.skills || []).length} скиллов</span></div>
        <div class="pack-desc">${p.desc || ''}</div>
      </div>`;
    el.addEventListener('click', () => togglePack(p.id));
    root.appendChild(el);
  });
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

function refreshDerived() {
  // Скрытые компоненты не считаем в сводке — пользователь их не выбирал.
  const n = selectedIds().filter((id) => !(STATE.byId[id] && STATE.byId[id].hidden)).length;
  const np = Object.values(STATE.selectedPacks || {}).filter(Boolean).length;
  const total = (STATE.packsData.packs || []).length;
  $('#summary').textContent = `Выбрано: ${n} компонентов · наборов скиллов: ${np}/${total}`;
  $('#btn-install').disabled = n === 0;

  // Наборы скиллов имеют смысл только если ставится Конфиг — иначе гасим секцию.
  const configOn = !!STATE.selected['config'];
  const pw = $('#packs-wrap');
  if (pw) pw.classList.toggle('disabled', !configOn);

  const needInvite =
    isVpnSelected() && STATE.config.vpn && STATE.config.vpn.requireInviteCode;
  $('#vpn-options').classList.toggle('hidden', !needInvite);
}

// ---- install flow ---------------------------------------------------

function envForRun() {
  const cfg = STATE.config || {};
  const vpn = cfg.vpn || {};

  // Skill packs -> which skill dirs to keep / which belong to any pack.
  const core = (STATE.packsData && STATE.packsData.core) || [];
  const allPacks = (STATE.packsData && STATE.packsData.packs) || [];
  const keep = new Set(core);
  const allPackSkills = new Set();
  allPacks.forEach((p) =>
    (p.skills || []).forEach((s) => {
      allPackSkills.add(s);
      if (STATE.selectedPacks[p.id]) keep.add(s);
    })
  );

  return {
    HM_CONFIG_REPO_URL: cfg.configRepoUrl || '',
    HM_CONFIG_REPO_BRANCH: cfg.configRepoBranch || 'main',
    HM_VPN_ENROLL_URL: vpn.enrollEndpoint || '',
    HM_VPN_ENROLL_PATH: vpn.enrollPath || '/enroll',
    HM_INVITE_CODE: ($('#invite-code') && $('#invite-code').value.trim()) || '',
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

async function startInstall() {
  const order = ensureVerifyLast(installOrder());
  if (!order.length) return;
  $('#view-select').classList.add('hidden');
  $('#view-progress').classList.remove('hidden');
  buildSteps(order);
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
  buildSteps(ids);
  appendLog(`\n— Повторная установка: ${ids.map((i) => STATE.byId[i].name).join(', ')} —`);
  const res = await runComponents(ids, LAST_ENV || envForRun());
  finishInstall(res);
}

function finishInstall(res) {
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
  // Оффлайн-фолбэк «Первые 10 минут»: показываем ТОЛЬКО когда видео-ссылки нет и
  // START-HERE.html вшит (finish.startHtmlRelPath) — открывается локально из ресурсов.
  const startHtmlRel = fin.startHtmlRelPath || '';
  const startBtn = (!links.video && startHtmlRel && STATE.resourcesRoot)
    ? `<button type="button" id="ns-start" class="btn-sm">▶ Первые 10 минут</button>`
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
  if (startBtnEl) {
    // openPath(resourcesRoot + разделитель + startHtmlRelPath). Нормализуем слэши под ОС.
    const startRel = isWin ? startHtmlRel.replace(/\//g, '\\') : startHtmlRel.replace(/\\/g, '/');
    startBtnEl.addEventListener('click', () => window.installer.openPath(STATE.resourcesRoot + sep + startRel));
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
