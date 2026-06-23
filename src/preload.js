const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voxlink', {
  startHost:          (port)        => ipcRenderer.invoke('start-host', port),
  stopHost:           ()            => ipcRenderer.invoke('stop-host'),
  getLocalIPs:        ()            => ipcRenderer.invoke('get-local-ips'),
  getScreenSources:   ()            => ipcRenderer.invoke('get-screen-sources'),
  showNotification:   (opts)        => ipcRenderer.invoke('show-notification', opts),
});

// expose loopback control
const { ipcRenderer: ipc2 } = require('electron');
contextBridge.exposeInMainWorld('audioLoopback', {
  enable:  () => ipc2.invoke('enable-loopback'),
  disable: () => ipc2.invoke('disable-loopback'),
});

contextBridge.exposeInMainWorld('pipewire', {
  start: () => ipc2.invoke('pipewire-start'),
  stop:  () => ipc2.invoke('pipewire-stop'),
});
