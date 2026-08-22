'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  // Для remote-компонентов main сам докачивает+проверяет+распаковывает АТОМАРНО
  // внутри run-component (renderer не задаёт путь кэша и не вклинивается) — см. main.js.
  runComponent: (id, env) => ipcRenderer.invoke('run-component', { id, env }),
  // Фаза 2: детекция состояния (installed + версии) — грунд-труть через реальные проверки.
  detectState: () => ipcRenderer.invoke('detect-state'),
  // Фаза 2: деинсталляция компонента (только артефакты установщика, не данные юзера).
  uninstallComponent: (id, env) => ipcRenderer.invoke('uninstall-component', { id, env }),
  onLog: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('component-log', handler);
    return () => ipcRenderer.removeListener('component-log', handler);
  },
  // Прогресс докачки remote-компонента ({id, remoteId, pct, received, total}).
  onRemoteProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('remote-progress', handler);
    return () => ipcRenderer.removeListener('remote-progress', handler);
  },
  // PREFLIGHT LITE: доступность сервера докачки. Сеть трогает ТОЛЬКО main
  // (CSP renderer'а запрещает fetch); renderer аргументов не передаёт.
  probeRemote: () => ipcRenderer.invoke('probe-remote'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  saveStartHere: () => ipcRenderer.invoke('save-start-here'),
  // Встроенный просмотр памятки: main сам находит вшитый START-HERE.html
  // (путь из renderer'а НЕ принимается) и отдаёт его содержимое строкой.
  readStartHere: () => ipcRenderer.invoke('read-start-here'),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  launchCursor: () => ipcRenderer.invoke('launch-cursor'),
  launchVsCode: () => ipcRenderer.invoke('launch-vscode'),
  launchCourse: () => ipcRenderer.invoke('launch-course'),
  nomadSetKey: (key) => ipcRenderer.invoke('nomad-set-key', key),
  openClaudeTerminal: () => ipcRenderer.invoke('open-claude-terminal'),
  detectUserWarning: () => ipcRenderer.invoke('detect-user-warning'),
  saveCredentials: (obj) => ipcRenderer.invoke('save-credentials', obj),
  // Анонимная телеметрия установки ({ok, failed[], durationSec}) — URL зашит в
  // config.json на стороне main; ошибки там глотаются, ответ не важен.
  sendTelemetry: (payload) => ipcRenderer.invoke('send-telemetry', payload),
  // macOS: снять карантин с образа, перемонтировать и перезапуститься из свежего тома
  macSelfHeal: () => ipcRenderer.invoke('mac-selfheal'),
  // Чем закончилась ПРОШЛАЯ попытка починки: её хвост работает уже после нашего
  // выхода, и без этой крошки любой его отказ был бы невидим.
  macSelfHealStatus: () => ipcRenderer.invoke('mac-selfheal-status'),
  quit: () => ipcRenderer.invoke('quit')
});
