const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webOutput', {
  get: () => ipcRenderer.invoke('get'),
  start: (opts) => ipcRenderer.invoke('start', opts),
  stop: () => ipcRenderer.invoke('stop'),
  reload: () => ipcRenderer.invoke('reload'),
  configure: (opts) => ipcRenderer.invoke('configure', opts),
  onState: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
});
