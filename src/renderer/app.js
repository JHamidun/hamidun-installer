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
};

const $ = (sel) => document.querySelector(sel);

async function init() {
  const boot = await window.installer.bootstrap();
  STATE.platform = boot.platform;
  STATE.homedir = boot.homedir;
  STATE.config = boot.config || {};
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

// ---- rendering ------------------------------------------------------

function renderGroups() {
  const root = $('#groups');
  root.innerHTML = '';
  STATE.groups.forEach((g) => {
    const gd = document.createElement('div');
    gd.className = 'group';
    gd.innerHTML = `<div class="group-title">${g.title}</div>`;
    g.components.forEach((c) => gd.appendChild(renderCard(c)));
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

function refreshDerived() {
  const n = selectedIds().length;
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
    HM_ALL_PACK_SKILLS: Array.from(allPackSkills).join(',')
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

async function runComponents(ids, env) {
  const off = window.installer.onLog(({ line }) => appendLog(line));
  const failed = [];
  let ok = 0;
  for (const id of ids) {
    setStep(id, 'running');
    appendLog(`\n=== ${STATE.byId[id].name} ===`);
    const res = await window.installer.runComponent(id, env);
    if (res.ok) { setStep(id, 'done'); ok++; }
    else {
      setStep(id, 'error');
      failed.push(id);
      appendLog(`[!] ${STATE.byId[id].name}: завершено с кодом ${res.code}${res.error ? ' — ' + res.error : ''}`);
    }
    $('#progress-summary').textContent = `Готово: ${ok} · Ошибок: ${failed.length} · Всего: ${ids.length}`;
  }
  off && off();
  return failed;
}

async function startInstall() {
  const order = installOrder();
  if (!order.length) return;
  $('#view-select').classList.add('hidden');
  $('#view-progress').classList.remove('hidden');
  buildSteps(order);
  LAST_ENV = envForRun();
  const failed = await runComponents(order, LAST_ENV);
  finishInstall(failed);
}

async function retryFailed(ids) {
  $('#next-steps').classList.add('hidden');
  $('#btn-finish').classList.add('hidden');
  buildSteps(ids);
  appendLog(`\n— Повторная установка: ${ids.map((i) => STATE.byId[i].name).join(', ')} —`);
  const failed = await runComponents(ids, LAST_ENV || envForRun());
  finishInstall(failed);
}

function finishInstall(failed) {
  const okAll = failed.length === 0;
  $('#progress-title').textContent = okAll ? 'Готово!' : 'Установка завершена с предупреждениями';
  $('#progress-sub').textContent = okAll
    ? 'Осталось войти в Claude Code своей подпиской — шаги ниже.'
    : 'Часть компонентов не установилась — можно повторить ниже.';
  renderNextSteps(failed);
  $('#btn-finish').classList.remove('hidden');
}

function renderNextSteps(failed) {
  const links = (STATE.config && STATE.config.links) || {};
  const fin = (STATE.config && STATE.config.finish) || {};
  const rel = (fin.credentialsRelPath || '.claude/.credentials.master.env').replace(/\//g, '\\');
  const credPath = STATE.homedir ? STATE.homedir + '\\' + rel : rel;

  const failHtml = failed.length
    ? `<div class="ns-fail">Не установилось: <b>${failed.map((i) => STATE.byId[i].name).join(', ')}</b>.
         <button type="button" id="ns-retry" class="btn-sm">Повторить неустановленное</button></div>`
    : '';
  const botBtn = links.bot ? `<button type="button" class="btn-sm" data-ext="${links.bot}">↩ Вернуться в бота</button>` : '';
  const videoBtn = links.video ? `<button type="button" class="btn-sm" data-ext="${links.video}">▶ Видео: что дальше</button>` : '';

  const ns = $('#next-steps');
  ns.innerHTML = `
    <div class="ns-title">Что дальше</div>
    <ol class="ns-steps">
      <li>Открой <b>Cursor</b> → панель <b>Claude Code</b> → войди своей подпиской (Pro/Max). Или в терминале команда <code>claude</code>.</li>
      <li>Если нужны доп. сервисы — вставь API-ключи в файл <code>.credentials.master.env</code>.</li>
      <li>Готово — можно работать. Продолжение инструкции — в боте.</li>
    </ol>
    ${failHtml}
    <div class="ns-actions">
      <button type="button" id="ns-cursor" class="btn-sm primary">Открыть Cursor</button>
      <button type="button" id="ns-keys" class="btn-sm">Открыть файл ключей</button>
      ${botBtn}
      ${videoBtn}
    </div>
    <label class="ns-auto"><input type="checkbox" id="ns-autocursor" ${fin.autoOpenCursorDefault ? 'checked' : ''}/> Открыть Cursor при нажатии «Готово»</label>`;
  ns.classList.remove('hidden');

  $('#ns-cursor').addEventListener('click', () => window.installer.launchCursor());
  $('#ns-keys').addEventListener('click', () => window.installer.openPath(credPath));
  ns.querySelectorAll('[data-ext]').forEach((b) => b.addEventListener('click', () => window.installer.openExternal(b.dataset.ext)));
  const retry = $('#ns-retry');
  if (retry) retry.addEventListener('click', () => retryFailed(failed));
}

document.addEventListener('DOMContentLoaded', init);
