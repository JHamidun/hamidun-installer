'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  runComponent: (id, env) => ipcRenderer.invoke('run-component', { id, env }),
  onLog: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('component-log', handler);
    return () => ipcRenderer.removeListener('component-log', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  launchCursor: () => ipcRenderer.invoke('launch-cursor'),
  openClaudeTerminal: () => ipcRenderer.invoke('open-claude-terminal'),
  saveCredentials: (obj) => ipcRenderer.invoke('save-credentials', obj),
  quit: () => ipcRenderer.invoke('quit')
});
