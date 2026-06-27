'use strict';

/**
 * Online auto-update via electron-updater (GitHub Releases provider).
 *
 * The app checks the project's GitHub releases for a newer version, downloads
 * the installer in the background, and installs on restart — so the team does
 * not have to re-download the .exe by hand. (Online; the offline USB updater in
 * updater.js remains as a no-internet fallback.)
 */

const { app } = require('electron');

let autoUpdater = null;
let getWin = () => null;
const state = { status: 'idle', currentVersion: null, version: null, percent: 0, error: null };

function load() {
  if (autoUpdater) return autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;          // ask the user before downloading
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => emit('checking'));
    autoUpdater.on('update-available', (info) => { state.version = info.version; emit('available'); });
    autoUpdater.on('update-not-available', () => emit('none'));
    autoUpdater.on('error', (e) => { state.error = (e && e.message) || String(e || 'Update error'); emit('error'); });
    autoUpdater.on('download-progress', (p) => { state.percent = Math.round(p.percent || 0); emit('downloading'); });
    autoUpdater.on('update-downloaded', (info) => { state.version = info.version; emit('downloaded'); });
  } catch (e) {
    autoUpdater = null;
  }
  return autoUpdater;
}

function emit(status) {
  state.status = status;
  state.currentVersion = app.getVersion();
  const w = getWin();
  if (w && !w.isDestroyed()) {
    try { w.webContents.send('update:event', { ...state }); } catch (e) { /* ignore */ }
  }
}

function init(winGetter) {
  getWin = winGetter || getWin;
  load();
}

function available() {
  // Online updates require the packaged app + internet.
  return app.isPackaged && !!load();
}

async function check() {
  if (!app.isPackaged) return { supported: false, reason: 'Online updates work in the installed app only (not in dev / portable run).' };
  const u = load();
  if (!u) return { supported: false, reason: 'Updater unavailable.' };
  try {
    const r = await u.checkForUpdates();
    const latest = r && r.updateInfo ? r.updateInfo.version : null;
    const cur = app.getVersion();
    return { supported: true, currentVersion: cur, latestVersion: latest, hasUpdate: !!latest && latest !== cur };
  } catch (e) {
    return { supported: true, error: (e && e.message) || String(e) };
  }
}

async function download() {
  const u = load();
  if (!u) throw new Error('Updater unavailable.');
  await u.downloadUpdate();
  return { downloading: true };
}

function quitAndInstall() {
  const u = load();
  if (!u) throw new Error('Updater unavailable.');
  setImmediate(() => u.quitAndInstall(false, true));
  return { installing: true };
}

// Silent check shortly after launch; result is pushed to the renderer.
function checkSilently() {
  if (!app.isPackaged) return;
  const u = load();
  if (u) { try { u.checkForUpdates().catch(() => {}); } catch (e) { /* ignore */ } }
}

module.exports = { init, available, check, download, quitAndInstall, checkSilently, state: () => state };
