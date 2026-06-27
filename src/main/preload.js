'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted channels the renderer may invoke. Keeps the surface explicit.
const CHANNELS = [
  'auth:login', 'auth:logout', 'auth:current',
  'users:list', 'users:create', 'users:update', 'users:delete',
  'events:list', 'events:active', 'events:create', 'events:update',
  'events:setActive', 'events:setState', 'events:delete',
  'patients:create', 'patients:update', 'patients:delete', 'patients:get', 'patients:list',
  'patients:records', 'patients:searchAll',
  'triage:save', 'treatment:save',
  'xray:add', 'xray:get', 'xray:list', 'xray:delete',
  'stats:dashboard', 'audit:list',
  'pdf:preview', 'pdf:generate', 'pdf:print',
  'record:exportUsb',
  'backup:run', 'export:event',
  'app:version', 'update:check', 'update:install',
  'app:openExternal',
];

const api = {
  invoke(channel, payload) {
    if (!CHANNELS.includes(channel)) {
      return Promise.resolve({ ok: false, error: `Blocked channel: ${channel}` });
    }
    return ipcRenderer.invoke(channel, payload);
  },
};

// Convenience named methods for readability in the renderer.
for (const ch of CHANNELS) {
  const name = ch.replace(/[:](\w)/g, (_, c) => c.toUpperCase());
  api[name] = (payload) => ipcRenderer.invoke(ch, payload);
}

contextBridge.exposeInMainWorld('api', api);
