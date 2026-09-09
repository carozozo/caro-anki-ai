const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CaroDesktop', {
  onMenuCommand: callback => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('caro-menu-command', listener);
    return () => ipcRenderer.removeListener('caro-menu-command', listener);
  },
  updateMenuState: state => ipcRenderer.send('caro-menu-state', state),
  updateMenuShortcuts: accelerators => ipcRenderer.send('caro-menu-shortcuts', accelerators),
});
