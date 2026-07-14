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
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  saveStartHere: () => ipcRenderer.invoke('save-start-here'),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  launchCursor: () => ipcRenderer.invoke('launch-cursor'),
  openClaudeTerminal: () => ipcRenderer.invoke('open-claude-terminal'),
  saveCredentials: (obj) => ipcRenderer.invoke('save-credentials', obj),
  quit: () => ipcRenderer.invoke('quit')
});
