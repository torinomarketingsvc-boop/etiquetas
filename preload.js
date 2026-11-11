'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_RE = /^[a-z]+:[a-zA-Z]+$/;

contextBridge.exposeInMainWorld('api', {
  call: (channel, payload) =>
    CHANNEL_RE.test(channel)
      ? ipcRenderer.invoke(channel, payload)
      : Promise.resolve({ ok: false, error: 'Canal não permitido.' }),
  onUpdate: (cb) => {
    const listener = (_e, status) => cb(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
