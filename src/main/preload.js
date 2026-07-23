'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted channels the renderer may invoke. Keeps the surface explicit.
const CHANNELS = [
  'auth:login', 'auth:logout', 'auth:current',
  'users:list', 'users:create', 'users:update', 'users:delete', 'users:clearEventStaff',
  'events:list', 'events:active', 'events:create', 'events:update',
  'events:setActive', 'events:setState', 'events:delete',
  'patients:create', 'patients:update', 'patients:delete', 'patients:get', 'patients:list',
  'patients:records', 'patients:searchAll', 'patients:history',
  'patients:incomplete', 'patients:cleanupIncomplete',
  'patients:dismiss', 'patients:move', 'patients:audit',
  'triage:save', 'treatment:save', 'vitals:save', 'patients:route', 'consent:setTeeth', 'consent:add',
  'xray:add', 'xray:setTooth', 'xray:folderList', 'xray:get', 'xray:list', 'xray:delete',
  'usb:list', 'usb:writeCheckin', 'usb:load', 'usb:uploadCheckout', 'usb:clear',
  'stats:dashboard', 'audit:list',
  'pdf:preview', 'pdf:generate', 'pdf:print',
  'record:exportUsb',
  'backup:run', 'export:event',
  'app:version', 'update:check', 'update:install',
  'update:onlineAvailable', 'update:checkOnline', 'update:downloadOnline', 'update:installOnline',
  'app:openExternal',
  'cloud:config', 'cloud:test', 'cloud:status', 'cloud:syncNow',
];

const api = {
  invoke(channel, payload) {
    if (!CHANNELS.includes(channel)) {
      return Promise.resolve({ ok: false, error: `Blocked channel: ${channel}` });
    }
    return ipcRenderer.invoke(channel, payload);
  },
  // Subscribe to auto-update progress events from the main process.
  onUpdateEvent(cb) {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('update:event', listener);
    return () => ipcRenderer.removeListener('update:event', listener);
  },
  // Subscribe to cloud-sync change events (remote data pulled) so open views can refresh.
  onCloudChanged(cb) {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('cloud:changed', listener);
    return () => ipcRenderer.removeListener('cloud:changed', listener);
  },
};

// Convenience named methods for readability in the renderer.
for (const ch of CHANNELS) {
  const name = ch.replace(/[:](\w)/g, (_, c) => c.toUpperCase());
  api[name] = (payload) => ipcRenderer.invoke(ch, payload);
}

contextBridge.exposeInMainWorld('api', api);
