'use strict';
/* Build-time: fetch the LATEST config-pack from GitHub and bake it into the installer.
   Runs before electron-builder (see package.json dist scripts). Rebuild = refresh. */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const url = cfg.configRepoUrl || 'https://github.com/JHamidun/claude-code-config-pack';
const branch = cfg.configRepoBranch || 'main';
const dest = path.join(ROOT, 'vendor', 'config-pack');

console.log(`[fetch-config] ${url}#${branch} -> ${dest}`);
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
execSync(`git clone --depth 1 -b ${branch} ${url} "${dest}"`, { stdio: 'inherit' });
// Slim: drop .git history so it doesn't bloat the installer.
fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });

const skills = path.join(dest, '.claude', 'skills');
const n = fs.existsSync(skills) ? fs.readdirSync(skills).length : 0;
console.log(`[fetch-config] OK — ${n} скиллов вшито в установщик.`);
