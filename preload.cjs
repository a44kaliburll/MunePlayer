// Bridge between the Zoon Player UI (served from 127.0.0.1) and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zoonShell', {
  win: (action) => ipcRenderer.send('win', action),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, state) => cb(state)),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  setThumbar: (state) => ipcRenderer.send('thumbar', state),
  onThumbar: (cb) => ipcRenderer.on('thumbar:click', (_e, action) => cb(action)),
});
