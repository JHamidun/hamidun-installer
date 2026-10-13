'use strict';
/**
 * verify-signature.js — последний шаг Windows-сборки: итоговые exe ДЕЙСТВИТЕЛЬНО подписаны нашим
 * сертификатом (S-8).
 *
 * ЗАЧЕМ. Хук tools/sign-win.js в CI, не на Windows и при HM_WIN_SIGN=0 молча пропускает подпись, а
 * electron-builder при этом рапортует успех (пользовательский sign возвращает управление, и
 * forceCodeSigning на него не действует). До этого шага ничто в npm run dist / dist:win / build-lite не
 * проверяло, что итоговый exe подписан: это делал только tools/publish-dist.py уже перед заливкой, то
 * есть сборка «зелёная», а человек с неподписанным exe получает жёлтый UAC «Издатель: неизвестно».
 *
 * Что считается подписанным: Get-AuthenticodeSignature даёт Status=Valid (подпись цела, хеш файла не
 * подменён, цепочка доверенная) И отпечаток сертификата подписанта равен нашему — тому же, которым
 * подписывает sign-win.js (CERT_SHA1 или HM_WIN_CERT_SHA1), единый источник на двоих. «Valid» чужой
 * подписью не годится: проверка именно на НАШ сертификат. Плюс метка времени: без неё подпись умрёт
 * вместе с сертификатом (05.10.2027), и все скачанные установщики станут «недействительными».
 *
 * Запуск: node tools/verify-signature.js [<exe> ...]
 *   без аргументов — три файла, которые подписывает sign-win.js: release/Hamidun-Setup-Windows.exe,
 *   release/win-unpacked/Hamidun Setup.exe и release/win-unpacked/resources/elevate.exe.
 *
 * Коды выхода: 0 — все файлы подписаны нашим сертификатом (или проверка ПРОПУЩЕНА громко: HM_WIN_SIGN=0
 *   — сборка без подписи осознанно); 1 — хоть один файл не найден / не подписан / подписан не тем /
 *   проверить нельзя (не Windows); 2 — ошибка запуска самой проверки.
 *
 * Пропуск ТОЛЬКО по HM_WIN_SIGN=0 — это единственный осознанный выключатель. «Хук пропустил подпись, потому
 * что CI или не Windows» осознанным выбором не является: такая сборка должна краснеть, а не проходить.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const signWin = require('./sign-win.js');

const ROOT = path.join(__dirname, '..');
const TAG = '[verify-signature] ';

function defaultFiles() {
  return [
    path.join(ROOT, 'release', 'Hamidun-Setup-Windows.exe'),
    path.join(ROOT, 'release', 'win-unpacked', signWin.PRODUCT_EXE),
    path.join(ROOT, 'release', 'win-unpacked', 'resources', 'elevate.exe'),
  ];
}

// Чистое решение по результатам Get-AuthenticodeSignature (тестируется без PowerShell).
// results: [{ file, exists, status, thumbprint, timestamped, error }]
function evaluate(results, expectedThumbprint) {
  const want = String(expectedThumbprint || '').replace(/\s+/g, '').toUpperCase();
  const failures = [];
  const okLines = [];
  for (const r of results) {
    const name = path.basename(r.file);
    if (!r.exists) { failures.push(name + ': файл не найден (' + r.file + ')'); continue; }
    if (r.error) { failures.push(name + ': подпись не прочиталась: ' + r.error); continue; }
    if (r.status !== 'Valid') { failures.push(name + ': подпись не действительна (Status=' + (r.status || 'нет') + ')'); continue; }
    const got = String(r.thumbprint || '').replace(/\s+/g, '').toUpperCase();
    if (!got) { failures.push(name + ': Status=Valid, но сертификата подписанта нет'); continue; }
    if (got !== want) {
      failures.push(name + ': подписан НЕ нашим сертификатом (отпечаток ' + got + ', ожидался ' + want + ')');
      continue;
    }
    if (r.timestamped === false) {
      failures.push(name + ': подпись без метки времени — умрёт вместе с сертификатом');
      continue;
    }
    okLines.push(name + ': подписан нашим сертификатом ' + got);
  }
  return { ok: failures.length === 0 && okLines.length > 0, failures, okLines };
}

const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }",
  "$files = @(ConvertFrom-Json -InputObject $env:HM_VERIFY_FILES | ForEach-Object { $_ })",  // PS 5.1 отдаёт массив одним элементом: разворачиваем
  "$out = New-Object System.Collections.Generic.List[string]",
  "foreach ($f in $files) {",
  "  $exists = [bool](Test-Path -LiteralPath $f)",
  "  $status = ''; $thumb = ''; $stamped = $false; $err = ''",
  "  if ($exists) {",
  "    try {",
  "      $s = Get-AuthenticodeSignature -LiteralPath $f",
  "      $status = [string]$s.Status",
  "      if ($s.SignerCertificate) { $thumb = [string]$s.SignerCertificate.Thumbprint }",
  "      $stamped = [bool]($null -ne $s.TimeStamperCertificate)",
  "    } catch { $err = [string]$_.Exception.Message }",
  "  }",
  "  $out.Add(([pscustomobject]@{ exists = $exists; status = $status; thumbprint = $thumb; timestamped = $stamped; error = $err } | ConvertTo-Json -Compress))",
  "}",
  "'[' + ($out -join ',') + ']'",
].join('\n');

// Настоящий Get-AuthenticodeSignature через Windows PowerShell 5.1 (есть на каждой Windows).
function readSignatures(files, env) {
  const sysRoot = (env && env.SystemRoot) || process.env.SystemRoot || 'C:\\Windows';
  const ps = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env || {}, { HM_VERIFY_FILES: JSON.stringify(files) }),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 900000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = [].concat(JSON.parse(String(out).trim()));
  return files.map((file, i) => Object.assign({ file }, parsed[i] || { exists: false }));
}

function main(argv, env, platform, deps) {
  env = env || process.env;
  platform = platform || process.platform;
  deps = deps || {};
  const read = deps.readSignatures || readSignatures;
  const files = (argv && argv.length ? argv : defaultFiles()).map((f) => path.resolve(f));

  // Единственный осознанный пропуск. Печатается ГРОМКО: строка в логе сборки не должна теряться.
  if (env.HM_WIN_SIGN === '0') {
    console.log(TAG + 'ПРОПУЩЕНО: HM_WIN_SIGN=0 — сборка БЕЗ подписи осознанно; подпись ' + files.length +
      ' файл(ов) НЕ проверена. Такой exe нельзя раздавать (UAC покажет «Издатель: неизвестно»).');
    return 0;
  }
  if (platform !== 'win32') {
    console.error(TAG + 'проверить подпись можно только на Windows (Get-AuthenticodeSignature), а сборка сейчас на ' + platform +
      '. Если exe собран без подписи осознанно — задай HM_WIN_SIGN=0, и этот шаг пропустится с записью в логе.');
    return 1;
  }
  let results;
  try {
    results = read(files, env);
  } catch (e) {
    const why = (e && typeof e.status === 'number')
      ? 'powershell.exe завершился с кодом ' + e.status
      : String((e && e.message) || e).split('\n')[0].slice(0, 200);
    console.error(TAG + 'не удалось запустить проверку подписи: ' + why);
    return 2;
  }
  const verdict = evaluate(results, signWin.certSha1(env));
  for (const l of verdict.okLines) console.log(TAG + 'OK ' + l);
  for (const f of verdict.failures) console.error(TAG + 'ОШИБКА ' + f);
  if (!verdict.ok) {
    console.error(TAG + 'сборка НЕ подписана нашим сертификатом: хук tools/sign-win.js в этом окружении пропустил подпись или ' +
      'она не легла. Войди в SimplySign Desktop на Windows-машине (python ~/.claude/tools/simplysign_connect.py) и пересобери; ' +
      'сборку без подписи делают только осознанно — HM_WIN_SIGN=0.');
    return 1;
  }
  console.log(TAG + 'OK: ' + verdict.okLines.length + ' файл(ов) подписаны сертификатом ' + signWin.certSha1(env));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { evaluate, main, readSignatures, defaultFiles, PS_SCRIPT };
