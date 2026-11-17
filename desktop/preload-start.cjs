// The chooser window's channel to the main process (#48): find servers,
// connect to one, or run the server here.
//
// As in preload.cjs, only contextBridge and ipcRenderer exist in a sandboxed
// preload; anything that acts on the machine lives in main.js. Connecting to
// a found server sends its system id, not an address: main.js holds the
// addresses it discovered, so this window never chooses where the app goes.
// A typed address is the exception, and main.js parses it and asks it who it
// is before saving anything.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prodmesh', {
  info: () => ipcRenderer.invoke('start:info'),
  discover: () => ipcRenderer.invoke('start:discover'),
  connectFound: (systemId) => ipcRenderer.invoke('start:connect', { systemId: String(systemId) }),
  connectAddress: (address) => ipcRenderer.invoke('start:connect', { address: String(address) }),
  runServer: () => ipcRenderer.invoke('start:server'),
});
