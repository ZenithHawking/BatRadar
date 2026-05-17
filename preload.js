'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    invoke: (channel, args) => ipcRenderer.invoke(channel, args),

    // Wraps data in { payload } to stay compatible with existing frontend code
    on: (channel, callback) => {
        const listener = (_event, data) => callback({ payload: data });
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    },
});
