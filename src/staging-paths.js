'use strict';
/**
 * staging-paths.js — единственное место, где JS решает, какой каталог можно снести.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Установщик работает ПОД АДМИНОМ, а
 * `fs.rmSync(p, { recursive: true, force: true })` ничего не спрашивает. Значит
 * вычисление пути для сноса — код с ценой ошибки «стёрли чужой каталог», и он
 * обязан быть проверяемым напрямую, а не через выковыривание функции из
 * `src/main.js` (Electron-модуль, из теста не требуется).
 *
 * ЗАЩИЩЁННЫЙ STAGING — ПАРА КАТАЛОГОВ:
 *   %ProgramData%\HmDeElev-<32 hex>\        внешний, заперт на Administrators
 *   %ProgramData%\HmDeElev-<32 hex>\w\      рабочий, его и отдают наружу
 * Убирать надо ВНЕШНИЙ: снос только `w` оставляет пользователю Admins-only
 * пустышку, которую он сам стереть не может.
 *
 * ЧТО ЗДЕСЬ БЫЛО НЕ ТАК. Подъём от `w` к родителю жил в `main.js` без единой
 * проверки имени: `stagingRootOf('<любой путь>\w')` отдавал родителя, и все
 * потребители сносили его рекурсивно. PowerShell-сторона
 * (`scripts/windows/_deelev.ps1:113-125`, `Remove-HmSecureStagingDir`) сверяет имя
 * с `^HmDeElev-[0-9a-f]{32}$` и молча выходит при несовпадении — то есть гейт
 * существовал, но только на одной стороне. Хуже: комментарий в тесте называл
 * JS-функцию «образцом» для PowerShell, хотя образец был слабее копии.
 */
const path = require('path');
const fs = require('fs');

// Имя внешнего каталога: ровно то, что порождает New-HmSecureStagingDir
// (`[guid]::NewGuid().ToString('N')` — 32 знака, СТРОЧНЫЕ hex).
const STAGING_NAME = /^HmDeElev-[0-9a-f]{32}$/;

function isStagingName(p) {
  try { return STAGING_NAME.test(path.basename(String(p || ''))); } catch (e) { return false; }
}

/**
 * Путь каталога, который надо снести: внешний staging, если на входе рабочий `w`.
 * Подъём разрешён ТОЛЬКО когда родитель действительно наш — иначе вход
 * возвращается неизменным, и снос его же отклонит гейт по имени.
 */
function stagingRootOf(p) {
  try {
    const s = String(p || '');
    if (!s) return s;
    if (path.basename(s) !== 'w') return s;
    const parent = path.dirname(s);
    return isStagingName(parent) ? parent : s;
  } catch (e) { return p; }
}

/**
 * Снести staging. Fail-closed: всё, что не `HmDeElev-<32 hex>`, не трогаем вовсе.
 * Возвращает true, только если каталог действительно удалён.
 */
function rmStagingTree(p) {
  const root = stagingRootOf(p);
  if (!isStagingName(root)) return false;
  try { fs.rmSync(root, { recursive: true, force: true }); return true; }
  catch (e) { return false; }
}

module.exports = { STAGING_NAME, isStagingName, stagingRootOf, rmStagingTree };
