const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chirpyDesktop', {
  getStatus: () => ipcRenderer.invoke('chirpy:desktop-status'),
  getProfile: () => ipcRenderer.invoke('chirpy:get-profile'),
  saveProfile: (payload) => ipcRenderer.invoke('chirpy:save-profile', payload),
  semanticMatch: (payload) => ipcRenderer.invoke('chirpy:semantic-match', payload)
});
