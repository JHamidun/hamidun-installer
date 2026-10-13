'use strict';

// #4 (finalize) — ИСТИННЫЙ allowlist для renderer-env элевейтед install-скриптов.
// Вынесено из main.js отдельным ЧИСТЫМ модулем (без electron), чтобы тесты могли
// прогонять фильтр напрямую.
//
// Renderer (medium integrity, тот же юзер) НЕЛЬЗЯ доверять произвольные env-ключи:
// NODE_OPTIONS=--require=...\evil.js, npm_config_*, GIT_EXEC_PATH, NODE_PATH и т.п.
// выполнили бы чужой код при старте npm/node под нашим elevated-токеном. Поэтому из
// renderer-env пропускаем ТОЛЬКО ключи, которые установщик реально эмитит.
//
// Это ЯВНЫЙ СПИСОК КЛЮЧЕЙ, а не префикс-тест HM_*: префикс пропускал бы и ключи,
// которых envForRun не эмитит НИКОГДА (HM_COURSE_TARGET, HM_COURSE_BEACON_URL,
// HM_NOMAD_CLOUD_BASEURL/KEY, HM_BRIDGE_TOKEN…), а их читают элевейтед install-скрипты
// как путь раскладки / внешний URL. HM_REMOTE_CACHE отсутствует в списке намеренно:
// его задаёт main из проверенного (sha256) пути, renderer не должен его подменять.
//
// ВАЖНО: новый HM_-ключ в src/renderer/app.js → envForRun ОБЯЗАН быть добавлен сюда,
// иначе он молча не доедет до install-скрипта.
const RENDERER_ENV_ALLOW = new Set([
  'hm_config_repo_url', 'hm_config_repo_branch', 'hm_claude_ext_id', 'hm_home',
  'hm_keep_skills', 'hm_all_pack_skills', 'hm_bridge_endpoint', 'hm_bridge_pacdomains',
  'hm_selected', 'hm_additive', 'hm_repair', 'hm_repair_confirmed',
  // Опции компонентов (галочки внутри карточки, components.json → options[]).
  // hm_handy_mic: '1' = человек разрешил записать согласие на микрофон для Handy.
  // Значение НИЧЕГО не резолвит (не путь, не URL) — только «да/нет» для install-скрипта.
  'hm_handy_mic'
]);

// Сравнение имён РЕГИСТРОНЕЗАВИСИМО: в Windows env 'Path'/'PATH'/'path' — одно имя,
// поэтому и allowlist сверяем в нижнем регистре (иначе 'nodE_optionS' проскочил бы).
// HM_REMOTE_CACHE режется самим списком (его там нет и быть не должно: ставит ТОЛЬКО
// main из sha256-проверенного пути; плюс main безусловно delete-ит его из renderer-env).
function isAllowedRendererEnvKey(k) {
  return RENDERER_ENV_ALLOW.has(String(k).toLowerCase());
}

// Вернуть НОВЫЙ объект с подмножеством renderer-env по allowlist (исходник не мутируем).
function filterRendererEnv(rendererEnv) {
  const out = {};
  const src = rendererEnv || {};
  for (const k of Object.keys(src)) {
    if (isAllowedRendererEnvKey(k)) out[k] = src[k];
  }
  return out;
}

// POSIX (macOS): окружение дочерних скриптов компонентов = КОПИЯ process.env за вычетом
// списка запретов. Allowlist, как на Windows, здесь не годится: скрипты законно ищут
// brew/node/python/git по пользовательскому PATH, а прокси и локаль (https_proxy, LANG,
// LC_*) обязаны дойти до curl/pip/npm. Поэтому режем только то, что ЗАПУСКАЕТ чужой код
// или подменяет настройки инструментов ещё до первой строки скрипта.
//
// Зачем это нужно именно на macOS. Главный процесс и каждый скрипт компонента работают
// от ПРОСТОГО пользователя; root появляется только внутри admin_run (osascript «with
// administrator privileges»), и там окружение стирается `env -i` (_lib.sh). Но команду
// для root — и тексты HM_*_INSTALL_SH — собирает НЕпривилегированный bash. Код того же
// пользователя (launchctl setenv, LaunchAgent с EnvironmentVariables, ~/.zshenv при запуске
// из терминала) кладёт в окружение установщика BASH_ENV/ENV/SHELLOPTS+PS4/BASH_FUNC_*, и bash
// каждого скрипта выполняет это ДО его первой строки: `unset BASH_ENV` внутри скрипта уже
// опоздал. Подменённый admin_run или переписанный HM_APP_INSTALL_SH уходит в окно с
// настоящим системным запросом пароля — и человек сам вводит пароль для чужого текста.
// Единственное место, где это закрывается целиком, — окружение, с которым bash стартует.
//
// Сознательно НЕ режем (остаточное, тот же пользователь = тот же доступ): PATH, HOME, прокси,
// локаль и переменные доверия к TLS (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, CURL_CA_BUNDLE —
// нужны людям за корпоративным прокси; скачанное всё равно сверяется по sha256 и подписи),
// PIP_*/UV_* (зеркала пакетов), переменные сборочных инструментов (CC, CFLAGS, RUSTFLAGS).
// Режем же DEVELOPER_DIR/SDKROOT/TOOLCHAINS: это не «настройки сборки», а выбор исполняемого файла
// ЗА системными шимами /usr/bin/git, /usr/bin/python3, /usr/bin/clang (xcode-select(1), xcrun(1):
// шим запускает `$DEVELOPER_DIR/usr/bin/<tool>`) — тот же класс, что GIT_EXEC_PATH.
//
// Сравнение имён РЕГИСТРОНЕЗАВИСИМО: legitimate-переменных, отличающихся от этих только
// регистром, нет, а лишний отброс безвреден.
const POSIX_ENV_DENY_EXACT = new Set([
  // bash/sh: что исполняется или включается при старте оболочки
  'env', 'shellopts', 'bashopts', 'ps4', 'prompt_command', 'cdpath', 'globignore', 'ifs', 'posixly_correct',
  // интерпретаторы: чужой код/модули до первой строки программы
  'node_options', 'node_path',
  'rubyopt', 'rubylib',
  'perl5opt', 'perl5lib',
  // JVM: -javaagent и подобное подхватывается любой java, которую запустит скрипт
  'java_tool_options', '_java_options', 'jdk_java_options',
  // OpenSSL: engine/provider из конфига — это загрузка чужой динамической библиотеки
  'openssl_conf', 'openssl_modules', 'openssl_engines',
  // xcode-select: набор инструментов за шимами /usr/bin/git, python3, clang … (см. комментарий выше)
  'developer_dir', 'sdkroot', 'toolchains'
]);
const POSIX_ENV_DENY_PREFIX = [
  'bash_',         // BASH_ENV, BASH_FUNC_<имя>%% (экспортируемые функции), BASH_XTRACEFD, BASH_LOADABLES_PATH
  'dyld_', 'ld_',  // динамический загрузчик (DYLD_INSERT_LIBRARIES, LD_PRELOAD)
  'python',        // PYTHONSTARTUP, PYTHONPATH, PYTHONHOME, PYTHONINSPECT, PYTHONUSERBASE, PYTHONBREAKPOINT …
  'perl', 'ruby',  // PERL5DB, PERLLIB, RUBYPATH, RUBYSHELL … (в паре с точными именами выше)
  'git_',          // GIT_EXEC_PATH, GIT_CONFIG*, GIT_SSH*, GIT_PROXY_COMMAND, GIT_TEMPLATE_DIR … (нужные нам
                   // GIT_TERMINAL_PROMPT/GIT_ASKPASS main задаёт сам ПОСЛЕ — NONINTERACTIVE_ENV)
  'npm_config_',   // как и на Windows (npm_config_yes main возвращает через NONINTERACTIVE_ENV)
  'hm_'            // переменные установщика: те, что нужны скриптам, main задаёт сам и авторитетно
];

// Старая форма экспорта функции bash (до Shellshock-патча значение вида «() { … }» под ЛЮБЫМ
// именем становилось функцией). Системный bash 3.2.57 её не принимает, но вложенный/чужой bash
// в PATH мог бы; отбросить такое значение ничего не стоит.
const LEGACY_BASH_FUNCTION_VALUE = /^\s*\(\)\s*\{/;

function isDeniedPosixEnvEntry(key, value) {
  const k = String(key).toLowerCase();
  if (POSIX_ENV_DENY_EXACT.has(k)) return true;
  if (POSIX_ENV_DENY_PREFIX.some((p) => k.startsWith(p))) return true;
  return typeof value === 'string' && LEGACY_BASH_FUNCTION_VALUE.test(value);
}

// Вернуть НОВЫЙ объект: process.env без запрещённых записей (исходник не мутируем).
function sanitizePosixEnv(src) {
  const out = {};
  const env = src || {};
  for (const k of Object.keys(env)) {
    if (!isDeniedPosixEnvEntry(k, env[k])) out[k] = env[k];
  }
  return out;
}

// #4 (finalize round-2) — АВТОРИТЕТНЫЕ системные path-переменные из ВАЛИДИРОВАННОГО
// диска, а НЕ из launch-env. Update-Path в install-скриптах выводит каталоги git/node
// из $env:ProgramFiles/$env:SystemRoot; если установщик запущен с crafted env
// (ProgramFiles=C:\Users\...\evil), то без этой перезаписи в elevated PATH попал бы
// evil\Git\cmd\git.exe. Диск/корень берём из validated winSystemRoot (reparse-safe).
// Профильные переменные (USERPROFILE/LOCALAPPDATA/APPDATA) сюда НЕ входят: у них свой
// источник истины — профиль учётной записи по ТОКЕНУ процесса (src/profile-env.js; замок стоит в
// самом начале main.js и правит process.env до того, как отсюда что-либо копируется). Содержимое
// самого профиля по природе user-writable — это принятый остаток; выбор КАКОГО профиля — уже нет.
function authoritativeWinSystemEnv(winRoot, drive) {
  // Всегда win32-семантика (вызывается ТОЛЬКО из if(IS_WIN) в main.js, см. main.js:768) —
  // path.win32 явно, а не host-зависимый require('path'): иначе на CI-раннере macOS/Linux
  // (path === path.posix) join('C:\\Windows\\', 'Program Files') не строил бы Windows-путь,
  // и функция была бы непроверяема без физической Windows-машины.
  const path = require('path').win32;
  const root = String(winRoot);
  const drv = String(drive);
  const pf = path.join(drv, 'Program Files');
  const pf86 = path.join(drv, 'Program Files (x86)');
  const programData = path.join(drv, 'ProgramData');
  return {
    SystemRoot: root,
    windir: root,
    SystemDrive: drv.replace(/[\\/]+$/, ''),        // "C:" без хвостового слэша
    ProgramFiles: pf,
    'ProgramFiles(x86)': pf86,
    ProgramW6432: pf,
    ProgramData: programData,
    ALLUSERSPROFILE: programData,
    CommonProgramFiles: path.join(pf, 'Common Files'),
    'CommonProgramFiles(x86)': path.join(pf86, 'Common Files'),
    CommonProgramW6432: path.join(pf, 'Common Files')
  };
}

module.exports = {
  isAllowedRendererEnvKey, filterRendererEnv, authoritativeWinSystemEnv,
  isDeniedPosixEnvEntry, sanitizePosixEnv
};
