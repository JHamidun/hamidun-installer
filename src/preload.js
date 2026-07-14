'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  runComponent: (id, env) => ipcRenderer.invoke('run-component', { id, env }),
  // Докачка remote-компонента (CDN) — вызывается перед его install-скриптом.
  fetchRemote: (id, remoteId) => ipcRenderer.invoke('fetch-remote', { id, remoteId }),
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
