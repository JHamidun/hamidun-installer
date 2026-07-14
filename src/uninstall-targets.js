'use strict';

// Фаза 2 (переделка): ЖЁСТКО ЗАШИТЫЙ per-component аллоулист целей деинсталляции.
// ЧИСТЫЙ модуль (без electron), тестируемый.
//
// МОДЕЛЬ ДОВЕРИЯ (новая): цели удаления вычисляет ТОЛЬКО этот доверенный код из
// ИЗВЕСТНЫХ мест установки (пути строятся от homedir/валидированных корней).
// Квитанции (receipts) в user-writable ~/.hamidun-setup БОЛЬШЕ НЕ являются
// источником путей удаления — они лишь installed-маркер {id, version, installedAt}
// для решения, показывать ли кнопку «Удалить» в UI. Компрометация/подмена
// квитанции НЕ может увести удаление в чужой путь: подобранные в ней artifacts
// игнорируются целиком.
//
// Типы целей (строго типизированные; исполняет main через uninstall-exec c guard-ом):
//   file        — ТОЧНЫЙ файл (не каталог); отсутствует → пропуск
//   dirtree     — точный allowlisted подкаталог с известным installer-owned контентом
//                 (контент курса, venv uv-тула, каталог приложения) — рекурсивно.
//                 НИКОГДА не применяется к каталогам с пользовательскими данными.
//   emptydir    — родительский каталог; удалять ТОЛЬКО если реально пуст
//   reg         — точное значение HKCU-реестра {key, value} (только Windows)
//   pathentry   — точная запись пользовательского PATH; убирается ТОЛЬКО если
//                 каталог установки реально ОТСУТСТВУЕТ (guard: не junction,
//                 не подменён — P0-5) после удаления файлов
//   profileline — ТОЧНАЯ installer-строка в разрешённом rc-файле (~/.zshrc и
//                 т.п., macOS); полное совпадение строки, не подстрока (P0-6)
//   launchagent — точный label + точный plist-путь (macOS)
//   appbundle   — точный .app-бандл; удаляется ТОЛЬКО при подтверждённой
//                 идентичности (CFBundleIdentifier из ДОВЕРЕННОГО vendor + пин TeamID)
//   killproc    — best-effort остановка НАШЕГО процесса перед удалением
// (типа uvtool больше НЕТ — P0-2: деинсталлятор не запускает user-writable
//  uv.exe; инвентарь uv-тула удаляется напрямую file/dirtree-целями)
//
// preserve[] — пути, которые деинсталляция ОБЯЗАНА пережить (пользовательское
// состояние: прогресс курса, SSH-конфиг моста, конфиг hermes). Guard добавляет их
// в protected-набор; сами цели структурно их не задевают (siblings).

const path = require('path');

// v1: компоненты, у которых АВТО-УДАЛЕНИЕ ВРЕМЕННО ОТКЛЮЧЕНО (устанавливаются, но не
// удаляются установщиком). Nomad — из-за TOCTOU/data-loss риска в сносе venv/шимов
// (Codex P0). Гейт применяется и в UI (кнопка «Удалить» скрыта), и в main (ранний
// отказ уже на входе в uninstall-обработчик), и здесь (case возвращает пустой план).
const UNINSTALL_DISABLED = new Set(['nomad']);

// Пин издателя маскота (Apple Team ID) — как в scripts/macos/mascot.sh.
const MASCOT_TEAM_ID = '3VN93XA9DY';

// P0-6: ТОЧНАЯ installer-строка CLI-прокси моста — verbatim BRIDGE_RC_LINE из
// scripts/macos/bridge.sh. Деинсталляция убирает из rc ТОЛЬКО строки, целиком
// равные ей (после trim); строки, лишь СОДЕРЖАЩИЕ маркер-текст, не трогаются.
const BRIDGE_RC_LINE = '[ -f "$HOME/Library/Application Support/HamidunBridge/cli_proxy.env" ] && . "$HOME/Library/Application Support/HamidunBridge/cli_proxy.env" # Hamidun Bridge CLI proxy';

// Известные install-корни, производные ТОЛЬКО от home (не из подменяемого env).
function winLocalAppData(home) { return path.join(home, 'AppData', 'Local'); }
function winRoamingAppData(home) { return path.join(home, 'AppData', 'Roaming'); }

// Целевая папка курса: значение из ВШИТОГО config.json (course.targetDirDefault),
// НЕ из renderer-env. Зеркало логики course.ps1/course.sh (expand %USERPROFILE%,
// защита от Windows-пути на macOS).
function resolveCourseTarget(raw, home, platform) {
  const def = path.join(home, 'HamidunCourse');
  if (!raw || typeof raw !== 'string') return def;
  if (platform === 'win32') {
    return raw.replace(/%USERPROFILE%/gi, home);
  }
  // macOS/Linux: Windows-стилевые пути (% или \) → дефолт, ~ → home.
  if (/[%\\]/.test(raw)) return def;
  if (raw.startsWith('~')) return path.join(home, raw.slice(1));
  return raw;
}

// ctx: {
//   platform: 'win32'|'darwin',
//   home: абсолютный homedir,
//   desktop: абсолютный путь рабочего стола (Electron app.getPath('desktop')),
//   courseTargetRaw: config.json course.targetDirDefault (вшитый ресурс),
//   courseShortcut: config.json course.shortcutName (вшитый ресурс),
//   nomadTool: config.json nomad.packageName (вшитый ресурс; после гигиены,
//              иначе дефолт 'hermes-agent') — P1-4,
//   mascotMac: { appName, bundleId } | null — из ДОВЕРЕННОГО vendor-бандла
//              (main резолвит на macOS; null = vendor недоступен → .app НЕ удаляем)
// }
// Возврат: { targets: [...], preserve: [...], notes: [...] } либо null (id не поддержан).
function uninstallTargets(id, ctx) {
  if (!ctx || !ctx.home || !ctx.platform) return null;
  const home = ctx.home;
  const isWin = ctx.platform === 'win32';
  const targets = [];
  const preserve = [];
  const notes = [];

  switch (id) {
    case 'course': {
      const target = resolveCourseTarget(ctx.courseTargetRaw, home, ctx.platform);
      const courseDir = path.join(target, 'vibecoding-course');
      // Контент архива курса (тот же набор, что install-скрипт сносит при обновлении).
      for (const sub of ['tracks', path.join('.claude', 'skills'), path.join('.claude', 'commands'), path.join('.course', 'knowledge')]) {
        targets.push({ type: 'dirtree', path: path.join(courseDir, sub), why: 'контент архива курса' });
      }
      for (const f of ['CLAUDE.md', 'AGENTS.md', 'README.md',
        path.join('.course', 'config.yaml'), path.join('.course', 'state.example.json')]) {
        targets.push({ type: 'file', path: path.join(courseDir, f) });
      }
      // Ярлык на рабочем столе — имя ТОЛЬКО из вшитого config.json.
      const shortcut = String(ctx.courseShortcut || 'Курс вайбкодинг (Claude Code)');
      const desktop = ctx.desktop || path.join(home, 'Desktop');
      targets.push({ type: 'file', path: path.join(desktop, shortcut + (isWin ? '.lnk' : '.command')) });
      // Родители — только если пусты. ПРОГРЕСС УЧЕНИКА СВЯЩЕНЕН: sandbox,
      // state.json, identity.json, settings.local.json переживают удаление —
      // если они есть, каталоги НЕ пусты и остаются.
      targets.push({ type: 'emptydir', path: path.join(courseDir, '.claude') });
      targets.push({ type: 'emptydir', path: path.join(courseDir, '.course') });
      targets.push({ type: 'emptydir', path: courseDir });
      targets.push({ type: 'emptydir', path: target });
      preserve.push(
        path.join(courseDir, 'sandbox'),
        path.join(courseDir, '.course', 'state.json'),
        path.join(courseDir, '.course', 'identity.json'),
        path.join(courseDir, '.claude', 'settings.local.json')
      );
      notes.push('Прогресс курса (sandbox, state.json, identity.json, накопленные разрешения) НЕ удаляется.');
      notes.push('Наставник в ~/.claude и твои данные НЕ тронуты.');
      break;
    }

    case 'uv': {
      if (isWin) {
        const dest = path.join(winLocalAppData(home), 'Programs', 'uv');
        // ТОЛЬКО наши точные файлы — НЕ рекурсивный снос каталога.
        targets.push({ type: 'file', path: path.join(dest, 'uv.exe') });
        targets.push({ type: 'file', path: path.join(dest, 'uvx.exe') });
        targets.push({ type: 'emptydir', path: dest });
        // PATH-запись убираем ТОЛЬКО если каталог опустел/исчез (чужие файлы в нём →
        // запись остаётся, чтобы не сломать чужие инструменты).
        targets.push({ type: 'pathentry', dir: dest, onlyIfDirGone: true });
      } else {
        targets.push({ type: 'file', path: path.join(home, '.local', 'bin', 'uv') });
        targets.push({ type: 'file', path: path.join(home, '.local', 'bin', 'uvx') });
        // ~/.local/bin — ОБЩИЙ каталог (claude/nomad и др.): НИКОГДА не удаляем.
      }
      notes.push('Python и чужие инструменты НЕ трогаю.');
      break;
    }

    case 'bridge': {
      if (isWin) {
        const dst = path.join(winLocalAppData(home), 'HamidunBridge');
        targets.push({ type: 'file', path: path.join(dst, 'bridge_agent.py') });
        // config.json (SSH-креды ученика) СОХРАНЯЕТСЯ → каталог не пуст → остаётся.
        targets.push({ type: 'emptydir', path: dst });
        targets.push({ type: 'reg', hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', value: 'HamidunBridge' });
        preserve.push(path.join(dst, 'config.json'));
      } else {
        const dst = path.join(home, 'Library', 'Application Support', 'HamidunBridge');
        targets.push({
          type: 'launchagent', label: 'com.hamidun.bridge',
          plist: path.join(home, 'Library', 'LaunchAgents', 'com.hamidun.bridge.plist')
        });
        targets.push({ type: 'file', path: path.join(dst, 'bridge_agent.py') });
        targets.push({ type: 'emptydir', path: dst });
        // P0-6: удаляем ТОЛЬКО строку, ТОЧНО РАВНУЮ installer-строке из bridge.sh
        // (BRIDGE_RC_LINE, verbatim) — НЕ любую строку, содержащую маркер-подстроку.
        targets.push({ type: 'profileline', file: path.join(home, '.zshrc'), line: BRIDGE_RC_LINE });
        targets.push({ type: 'profileline', file: path.join(home, '.bash_profile'), line: BRIDGE_RC_LINE });
        preserve.push(path.join(dst, 'config.json'));
      }
      notes.push('config.json моста (SSH-настройки) НЕ удаляется.');
      break;
    }

    case 'mascot': {
      if (isWin) {
        const destDir = path.join(winLocalAppData(home), 'Programs', 'ClaudeMascot');
        targets.push({ type: 'killproc', image: 'claude-mascot.exe' });
        // Каталог приложения (installer-owned, пользовательских данных не содержит).
        targets.push({ type: 'dirtree', path: destDir, why: 'каталог приложения скрепки' });
        targets.push({ type: 'file', path: path.join(home, '.claude-mascot', '.installed') });
        targets.push({ type: 'emptydir', path: path.join(home, '.claude-mascot') });
        targets.push({ type: 'reg', hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', value: 'ClaudeMascot' });
      } else {
        targets.push({
          type: 'launchagent', label: 'com.hamidun.claude-mascot',
          plist: path.join(home, 'Library', 'LaunchAgents', 'com.hamidun.claude-mascot.plist')
        });
        if (ctx.mascotMac && ctx.mascotMac.appName && /\.app$/i.test(ctx.mascotMac.appName)) {
          targets.push({ type: 'killproc', pattern: 'claude-mascot' });
          targets.push({
            type: 'appbundle',
            path: path.join(home, 'Applications', ctx.mascotMac.appName),
            expectBundleId: String(ctx.mascotMac.bundleId || ''),
            teamId: MASCOT_TEAM_ID
          });
        } else {
          // Vendor недоступен (например, .app перетащили из dmg) → имя/идентичность
          // бандла подтвердить нечем → .app НЕ удаляем (fail-closed).
          notes.push('Vendor недоступен — .app скрепки не удаляю (не могу подтвердить идентичность). Удали из ~/Applications вручную.');
        }
        targets.push({ type: 'file', path: path.join(home, '.claude-mascot', '.installed') });
        targets.push({ type: 'emptydir', path: path.join(home, '.claude-mascot') });
      }
      notes.push('Хуки в ~/.claude/settings.json НЕ трогаю (там могут быть твои правки).');
      break;
    }

    case 'nomad': {
      // v1: АВТО-УДАЛЕНИЕ NOMAD ОТКЛЮЧЕНО (уровень целей). Codex нашёл 4 P0 + 2 P1,
      // ВСЕ — в удалении Nomad (TOCTOU-нора при сносе venv/шимов + клона исходников,
      // риск затереть чужой uv-tool/venv пользователя с тем же именем пакета). Решение
      // владельца: в v1 Nomad ПО-ПРЕЖНЕМУ СТАВИТСЯ, но НЕ авто-удаляется — так разом
      // снимается весь data-loss риск. Возвращаем ПУСТОЙ план + явный флаг
      // uninstallSupported:false: доверенный код НЕ вычисляет НИ ОДНОЙ цели удаления
      // Nomad; исполнять нечего. main дополнительно отбивает Nomad-uninstall ранним
      // гейтом (UNINSTALL_DISABLED), а UI не показывает кнопку «Удалить» для Nomad.
      // Полноценный Nomad-uninstall вернём позже отдельной фазой, когда TOCTOU закроем.
      notes.push('Авто-удаление Nomad в этой версии отключено — Nomad остаётся установленным (при необходимости удали вручную). uv, Python и твой config.yaml не трогаются.');
      return { targets: [], preserve: [], notes, uninstallSupported: false };
    }

    default:
      return null; // компонент не поддерживает деинсталляцию — отказ (fail-closed)
  }

  return { targets, preserve, notes };
}

module.exports = { uninstallTargets, resolveCourseTarget, MASCOT_TEAM_ID, BRIDGE_RC_LINE, UNINSTALL_DISABLED };
