// electron-builder afterPack hook: ad-hoc подпись Mac-бандла (codesign -s -).
// Без Apple Developer ID совсем неподписанный arm64-бинарь ядро убивает даже
// после снятия карантина (xattr -cr). Ad-hoc НЕ убирает диалог Gatekeeper
// «приложение повреждено» у скачанного из браузера — но гарантирует запуск
// после снятия карантина. Полное решение (без диалога) = Developer ID + notarytool, v2.
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[adhoc-sign] codesign --force --deep -s - "${appPath}"`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
  console.log('[adhoc-sign] OK: бандл подписан ad-hoc и прошёл verify');
};
