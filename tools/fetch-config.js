'use strict';
/* Build-time: fetch the config-pack from GitHub and bake it into the installer.
   Runs before electron-builder (see package.json dist scripts).

   ПИННИНГ И ВОСПРОИЗВОДИМОСТЬ. Раньше здесь был безусловный
   `git clone --depth 1 -b main` — то есть «что лежит в main ровно в эту секунду».
   Два следствия, оба кусаются:
     • сборку нельзя воспроизвести и нельзя ответить на вопрос «какая версия
       конфига уехала вот в этот exe» — в артефакте не оставалось НИКАКОГО следа;
     • если в момент сборки кто-то ещё правит пак (а он живёт своей жизнью и
       правится из других сессий), в установщик молча уезжает ПОЛУФАБРИКАТ.
   Теперь: ref можно закрепить (HM_CONFIG_REF / configRepoRef — тег, ветка или
   SHA), а ФАКТИЧЕСКИ вшитый коммит всегда записывается в
   vendor/config-pack/.hamidun-config-pack.json и печатается в лог сборки. */
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const url = cfg.configRepoUrl || 'https://github.com/JHamidun/claude-code-config-pack';
// Приоритет: переменная окружения сборки > config.json > ветка по умолчанию.
// HM_CONFIG_REF позволяет собрать релиз от КОНКРЕТНОГО коммита/тега, не трогая config.json.
const ref = process.env.HM_CONFIG_REF || cfg.configRepoRef || cfg.configRepoBranch || 'main';
const dest = path.join(ROOT, 'vendor', 'config-pack');

console.log(`[fetch-config] ${url}#${ref} -> ${dest}`);
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });

// --depth 1 -b <ref> работает для ветки и тега, но НЕ для произвольного SHA.
// Поэтому: пробуем быстрый путь, при неудаче — полный clone + checkout по SHA.
try {
  execSync(`git clone --depth 1 -b ${ref} ${url} "${dest}"`, { stdio: 'inherit' });
} catch (e) {
  console.log(`[fetch-config] ref «${ref}» не ветка и не тег — полный clone + checkout`);
  fs.rmSync(dest, { recursive: true, force: true });
  execSync(`git clone ${url} "${dest}"`, { stdio: 'inherit' });
  execSync(`git -C "${dest}" checkout --detach ${ref}`, { stdio: 'inherit' });
}

// Фактический коммит фиксируем ДО удаления .git — иначе спросить будет уже не у кого.
let sha = '';
let committed = '';
try {
  sha = String(execFileSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).trim();
  committed = String(execFileSync('git', ['-C', dest, 'log', '-1', '--format=%cI'], { encoding: 'utf8' })).trim();
} catch (e) {
  throw new Error('[fetch-config] не удалось определить вшиваемый коммит конфига: ' + (e.message || e));
}

// Slim: drop .git history so it doesn't bloat the installer.
fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });

// Скилл = каталог с SKILL.md, а не любая запись в skills/. Простой readdirSync().length
// считал заодно CATALOG.md и README.md, лежащие рядом, и давал 287 вместо 285. Цифра
// попадает в штамп версии и оттуда в анонс релиза — прошлый анонс уже врал по той же
// причине, поэтому считаем ровно то, что называем.
const skills = path.join(dest, '.claude', 'skills');
const n = fs.existsSync(skills)
  ? fs.readdirSync(skills, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(skills, e.name, 'SKILL.md')))
      .length
  : 0;

// Штамп версии едет ВНУТРЬ пака: по нему потом видно, что именно установлено у
// ученика, и воспроизводится ровно эта сборка (HM_CONFIG_REF=<sha>).
fs.writeFileSync(path.join(dest, '.hamidun-config-pack.json'),
  JSON.stringify({ repo: url, ref, commit: sha, committedAt: committed, skills: n }, null, 2) + '\n',
  'utf8');

console.log(`[fetch-config] OK — ${n} скиллов вшито; коммит ${sha.slice(0, 12)} (${committed})`);
console.log('[fetch-config] воспроизвести эту сборку: HM_CONFIG_REF=' + sha);
