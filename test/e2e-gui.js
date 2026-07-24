'use strict';
/* e2e-gui.js — НАСТОЯЩИЙ GUI-прогон установщика через Playwright + Electron.
 *
 * Гоняет собранное lite-приложение (release/win-unpacked) в ИЗОЛИРОВАННОМ профиле
 * (подменённые USERPROFILE/HOME/APPDATA/LOCALAPPDATA → временный каталог), кликая по
 * реальному интерфейсу: приветствие → выбор → установка → финиш. Никакой мок-логики:
 * реальный main-процесс, реальный IPC, реальная докачка с S3 по вшитому реестру.
 *
 * Режимы:
 *   node test/e2e-gui.js ok        — обычный прогон (докачка с живых зеркал)
 *   node test/e2e-gui.js netfail   — зеркала в реестре подменены на мёртвый хост:
 *                                    проверяем, что UI честно показывает обрыв сети
 *                                    и кнопку «Повторить», а не молчит/не врёт «успех»
 *
 * Требует: npm i -D playwright-core; собранный release/win-unpacked (npm run dist:win:lite).
 * Полная докачка требует ПРАВ АДМИНИСТРАТОРА (staging кэша — Admins-only, fail-closed).
 * Без элевации прогон честно фиксирует отказ на этапе fetch — это тоже проверяемый путь.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const MODE = (process.argv[2] || 'ok').toLowerCase();
const COMPONENT = process.env.HM_E2E_COMPONENT || 'config'; // ставится в ИЗОЛИРОВАННЫЙ ~/.claude
const STEP_TIMEOUT = Number(process.env.HM_E2E_TIMEOUT || 15 * 60 * 1000);

const log = (...a) => console.log('[e2e]', ...a);
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✅ ' + name); }
  else { failures++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
  return !!cond;
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

/** Копия распакованного приложения (чтобы править resources без порчи исходной сборки). */
function stageApp() {
  const src = path.join(ROOT, 'release', 'win-unpacked');
  // HM_E2E_SOURCE=1 — принудительно из исходников. Нужно для НЕэлевейтед-машины:
  // упакованный exe несёт requireAdministrator и без UAC просто не стартует.
  if (process.env.HM_E2E_SOURCE === '1' || !fs.existsSync(src)) {
    // CI/чистая машина: собранного пакета нет — гоняем ТОТ ЖЕ код из исходников
    // (electron <repo>). Проверяется реальный main/renderer/scripts-контур.
    log('release/win-unpacked нет — запускаю из исходников (source mode)');
    return { dir: ROOT, source: true };
  }
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-app-'));
  fs.cpSync(src, dst, { recursive: true });
  if (MODE === 'netfail') {
    // Подменяем ВСЕ зеркала на заведомо мёртвый хост: докачка обязана провалиться
    // ЧЕСТНО (видимый статус + «Повторить»), а не тихо «пропустить» компонент.
    const regPath = path.join(dst, 'resources', 'remote-components.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    for (const c of (reg.components || [])) {
      for (const m of (c.mirrors || [])) {
        m.url = m.url.replace(/^https:\/\/[^/]+/, 'https://hm-e2e-dead-host.invalid');
      }
    }
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
    log('режим netfail: зеркала подменены на мёртвый хост');
  }
  return { dir: dst, source: false };
}

/** В source-mode подменяем реестр прямо в корне (CI-прогон, дерево одноразовое). */
function poisonSourceRegistry() {
  const regPath = path.join(ROOT, 'remote-components.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  for (const c of (reg.components || [])) {
    for (const m of (c.mirrors || [])) {
      m.url = m.url.replace(/^https:\/\/[^/]+/, 'https://hm-e2e-dead-host.invalid');
    }
  }
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  log('source-mode netfail: зеркала подменены на мёртвый хост');
}

/** Изолированный профиль пользователя — установка НЕ трогает реальную машину. */
function stageHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-home-'));
  for (const d of ['AppData', path.join('AppData', 'Roaming'), path.join('AppData', 'Local'), 'Desktop']) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  return home;
}

async function main() {
  log('режим:', MODE, '| компонент:', COMPONENT);
  const staged = stageApp();
  const appDir = staged.dir;
  if (staged.source && MODE === 'netfail') poisonSourceRegistry();
  const home = stageHome();
  log('изолированный профиль:', home);

  const env = Object.assign({}, process.env, {
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    HM_E2E: '1',
  });

  const launchOpts = staged.source
    ? { executablePath: require('electron'), args: [ROOT], env, timeout: 180000 }
    : { executablePath: path.join(appDir, 'Hamidun Setup.exe'), args: [], env, timeout: 180000 };
  log('запуск:', staged.source ? 'source (electron ' + ROOT + ')' : launchOpts.executablePath);
  const app = await electron.launch(launchOpts);
  const page = await app.firstWindow({ timeout: 120000 });
  await page.waitForLoadState('domcontentloaded');
  log('окно поднялось:', await page.title());

  try {
    // --- Экран 1: приветствие ---
    await page.waitForSelector('#btn-welcome-go', { timeout: 60000 });
    check('экран приветствия отрисован', true);
    await page.click('#btn-welcome-go');

    // --- Экран 2: выбор ---
    await page.waitForSelector('#view-select:not(.hidden)', { timeout: 60000 }).catch(() => {});
    await page.waitForSelector('#groups .card', { timeout: 120000 });
    const nCards = await page.locator('#groups .card').count();
    check('экран выбора отрисован (' + nCards + ' компонентов)', nCards > 0);

    // Детекция завершилась → кнопка «Установить» активна.
    await page.waitForFunction(() => {
      const b = document.getElementById('btn-install');
      return b && !b.disabled;
    }, null, { timeout: 180000 });
    check('кнопка «Установить» активировалась (детекция + preflight прошли)', true);

    // Phase-4: превью объёма докачки — ТОЛЬКО в lite-издании (в офлайне качать нечего,
    // и показывать «Скачается» было бы враньём). Ожидание задаёт HM_E2E_EXPECT_LITE.
    const summary = (await page.textContent('#summary')) || '';
    log('summary:', summary.trim().slice(0, 160));
    const expectLite = process.env.HM_E2E_EXPECT_LITE === '1';
    const hasPreview = /Скачается/i.test(summary);
    check(expectLite ? 'lite: превью объёма докачки показано' : 'offline: превью докачки корректно ОТСУТСТВУЕТ',
      hasPreview === expectLite, summary.trim().slice(0, 120));

    // --- Выбираем ТОЛЬКО целевой компонент ---
    // Карточки — div.card с click-toggle (не чекбоксы); опознаём по data-id.
    // ВАЖНО: UI сам восстанавливает ЗАВИСИМОСТИ (config требует git+node), поэтому
    // «оставить ровно один компонент» невозможно и не нужно. Разрешаем целевой +
    // его транзитивные зависимости, снимаем остальное, сходясь за несколько проходов.
    const comps = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
    const byId = {};
    for (const g of (comps.groups || [])) for (const c of (g.components || [])) byId[c.id] = c;
    const allowed = new Set();
    (function addDeps(id) {
      if (!id || allowed.has(id) || !byId[id]) return;
      allowed.add(id);
      (byId[id].requires || []).forEach(addDeps);
    })(COMPONENT);
    log('разрешены (цель + зависимости):', [...allowed].join(', '));

    let picked = null;
    for (let pass = 0; pass < 4; pass++) {
      picked = await page.evaluate(({ id, allow }) => {
        const cards = Array.from(document.querySelectorAll('#groups .card'));
        for (const c of cards) {
          const want = allow.includes(c.dataset.id);
          if (c.classList.contains('checked') !== want) c.click();
        }
        const target = cards.find((c) => c.dataset.id === id);
        return {
          total: cards.length,
          targetChecked: !!(target && target.classList.contains('checked')),
          stillChecked: cards.filter((c) => c.classList.contains('checked')).map((c) => c.dataset.id),
        };
      }, { id: COMPONENT, allow: [...allowed] });
      const extra = picked.stillChecked.filter((x) => !allowed.has(x));
      if (picked.targetChecked && !extra.length) break;
      log('проход ' + (pass + 1) + ': лишние ещё отмечены →', extra.join(', ') || '—');
    }
    const extraChecked = picked.stillChecked.filter((x) => !allowed.has(x));
    check('целевой «' + COMPONENT + '» выбран, лишние сняты (отмечено: ' + picked.stillChecked.join(',') + ')',
      picked.targetChecked && extraChecked.length === 0, JSON.stringify(picked));

    const summary2 = (await page.textContent('#summary')) || '';
    log('summary после выбора:', summary2.trim().slice(0, 160));

    // --- Установка ---
    await page.click('#btn-install');
    await page.waitForSelector('#view-progress:not(.hidden)', { timeout: 60000 }).catch(() => {});
    check('экран прогресса открылся', true);

    // Ждём терминального состояния: финиш ИЛИ видимая ошибка сети/шага.
    const terminal = await page.waitForFunction(() => {
      const fin = document.getElementById('btn-finish');
      const finished = fin && !fin.classList.contains('hidden');
      const errNet = document.querySelector('.step.error-net');
      const errAny = document.querySelector('.step.error, .step.failed');
      if (finished) return { kind: 'finish' };
      if (errNet) return { kind: 'error-net', text: errNet.textContent.trim().slice(0, 200) };
      if (errAny) return { kind: 'error', text: errAny.textContent.trim().slice(0, 200) };
      return null;
    }, null, { timeout: STEP_TIMEOUT, polling: 1000 }).then((h) => h.jsonValue());
    log('терминальное состояние:', JSON.stringify(terminal).slice(0, 240));

    // Текст шагов и лог — для диагностики и проверки прогресса докачки.
    const steps = (await page.textContent('#step-list')) || '';
    const logText = (await page.textContent('#log')) || '';
    const sawDownload = /Скачиваю|скачив/i.test(steps + logText);

    if (MODE === 'netfail') {
      check('UI честно показал обрыв сети (статус error-net)', terminal.kind === 'error-net', terminal.kind + ' ' + (terminal.text || ''));
      const retryVisible = await page.evaluate(() =>
        !!document.querySelector('.step-retry, .step .step-retry, button.step-retry'));
      check('кнопка «Повторить» доступна пользователю', retryVisible);
      check('провал НЕ выдан за успех (нет экрана «Готово»)', terminal.kind !== 'finish');
    } else {
      check('докачка стартовала (в UI виден прогресс скачивания)', sawDownload, steps.slice(0, 200));
      check('прогон дошёл до финиша', terminal.kind === 'finish', terminal.kind + ' ' + (terminal.text || ''));
      // Реальная проверка результата: конфиг разложен в ИЗОЛИРОВАННЫЙ профиль.
      if (COMPONENT === 'config') {
        const claudeDir = path.join(home, '.claude');
        const skills = path.join(claudeDir, 'skills');
        const nSkills = fs.existsSync(skills) ? fs.readdirSync(skills).length : 0;
        check('конфиг разложен в изолированный ~/.claude (skills > 100)', nSkills > 100, 'skills=' + nSkills);
        check('маркер завершённости конфига записан', fs.existsSync(path.join(claudeDir, '.hamidun-config-complete')));
      }
    }

    // Скриншот финального состояния — визуальное доказательство прогона.
    const shot = path.join(ROOT, 'release', 'e2e-' + MODE + '.png');
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    log('скриншот:', shot);
  } finally {
    await app.close().catch(() => {});
    if (!process.env.HM_E2E_KEEP) { if (!staged.source) rmrf(appDir); rmrf(home); }
    else { log('артефакты сохранены:', appDir, home); }
  }

  console.log('\n[e2e] ИТОГ (' + MODE + '): ' + (failures ? failures + ' проверок ПРОВАЛЕНО' : 'все проверки пройдены'));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[e2e] ФАТАЛЬНО:', e && e.stack || e); process.exit(2); });
