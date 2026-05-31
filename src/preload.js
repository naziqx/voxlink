const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voxlink', {
  startHost:          (port)        => ipcRenderer.invoke('start-host', port),
  stopHost:           ()            => ipcRenderer.invoke('stop-host'),
  getLocalIPs:        ()            => ipcRenderer.invoke('get-local-ips'),
  getScreenSources:   ()            => ipcRenderer.invoke('get-screen-sources'),
  showNotification:   (opts)        => ipcRenderer.invoke('show-notification', opts),
});
