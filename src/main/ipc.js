'use strict';

/**
 * IPC handlers — the bridge between the renderer UI and the local data layer.
 *
 * Role-based access control mirrors the permission matrix in the product map
 * (Admin / Doctor / Triage). Every protected channel checks the signed-in
 * user's role before touching data.
 */

const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const pdf = require('./pdf');
const updater = require('./updater');

let currentUser = null;

// Role matrix — keys are IPC channels, values are roles allowed to call them.
const PERMS = {
  'users:list': ['admin'],
  'users:create': ['admin'],
  'users:update': ['admin'],
  'users:delete': ['admin'],
  'events:create': ['admin'],
  'events:update': ['admin'],
  'events:setActive': ['admin'],
  'events:setState': ['admin'],
  'events:delete': ['admin'],
  'patients:delete': ['admin'],
  'patients:create': ['admin', 'triage'],
  'patients:update': ['admin', 'triage', 'doctor'],
  'patients:get': ['admin', 'doctor', 'triage'],
  'patients:list': ['admin', 'doctor', 'triage'],
  'patients:searchAll': ['admin', 'doctor', 'triage'],
  'patients:records': ['admin', 'doctor'],
  'triage:save': ['admin', 'doctor', 'triage'],
  'treatment:save': ['admin', 'doctor'],
  'xray:add': ['admin', 'doctor', 'triage'],
  'xray:get': ['admin', 'doctor', 'triage'],
  'xray:list': ['admin', 'doctor', 'triage'],
  'xray:delete': ['admin', 'doctor', 'triage'],
  'pdf:generate': ['admin', 'doctor'],
  'pdf:preview': ['admin', 'doctor'],
  'pdf:print': ['admin', 'doctor'],
  'record:exportUsb': ['admin', 'doctor'],
  'backup:run': ['admin'],
  'export:event': ['admin'],
  'audit:list': ['admin'],
  // update:* and app:version are open to any signed-in user (available in any view).
};

function ensure(channel) {
  const allowed = PERMS[channel];
  if (!allowed) return; // open to any authenticated user
  if (!currentUser) throw new Error('Please sign in first.');
  if (!allowed.includes(currentUser.role)) {
    throw new Error('Your role does not have permission for this action.');
  }
}

// Wrap a handler so thrown errors return a clean { ok:false, error } shape.
function handle(channel, fn, { requireAuth = true } = {}) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      if (requireAuth && channel !== 'auth:login' && !currentUser && PERMS[channel] !== undefined) {
        // protected channels need a user
      }
      ensure(channel);
      const result = await fn(...args);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function register(getMainWindow) {
  /* ---- Auth ---- */
  ipcMain.handle('auth:login', async (_e, { username, password }) => {
    try {
      const user = db.login(username, password);
      if (!user) return { ok: false, error: 'Invalid username or password.' };
      currentUser = user;
      return { ok: true, data: user };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('auth:logout', async () => {
    if (currentUser) db.audit(currentUser, 'logout', 'user', currentUser.id, null);
    currentUser = null;
    return { ok: true };
  });
  ipcMain.handle('auth:current', async () => ({ ok: true, data: currentUser }));

  /* ---- Users ---- */
  handle('users:list', () => db.listUsers());
  handle('users:create', (payload) => db.createUser(currentUser, payload));
  handle('users:update', ({ id, ...rest }) => db.updateUser(currentUser, id, rest));
  handle('users:delete', (id) => db.deleteUser(currentUser, id));

  /* ---- Events ---- */
  handle('events:list', () => db.listEvents(), { });
  ipcMain.handle('events:active', async () => ({ ok: true, data: db.getActiveEvent() }));
  handle('events:create', (payload) => db.createEvent(currentUser, payload));
  handle('events:update', ({ id, ...rest }) => db.updateEvent(currentUser, id, rest));
  handle('events:setActive', (id) => db.setActiveEvent(currentUser, id));
  handle('events:setState', ({ id, active }) => db.setEventActive(currentUser, id, active));
  handle('events:delete', ({ id, force }) => db.deleteEvent(currentUser, id, { force }));

  /* ---- Patient delete (admin) ---- */
  handle('patients:delete', (id) => db.deletePatient(currentUser, id));

  /* ---- Patients ---- */
  // Check-in is special: a dedicated kiosk (no signed-in user) may create
  // patients, and so may Admin / Triage staff. Doctors cannot.
  ipcMain.handle('patients:create', async (_e, payload) => {
    try {
      if (currentUser && !['admin', 'triage'].includes(currentUser.role)) {
        throw new Error('Your role does not have permission to complete check-in.');
      }
      return { ok: true, data: db.createPatient(currentUser, payload) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('patients:update', ({ id, ...data }) => db.updatePatient(currentUser, id, data));
  handle('patients:get', (id) => db.getPatient(id));
  handle('patients:list', (opts) => db.listPatients(opts || {}));
  handle('patients:records', (opts) => db.listPatients(opts || {}));
  handle('patients:searchAll', (term) => db.searchAllPatients(term));

  /* ---- Triage & treatment ---- */
  handle('triage:save', ({ patientId, data }) => db.saveTriage(currentUser, patientId, data));
  handle('treatment:save', ({ patientId, data, finalize }) =>
    db.saveTreatment(currentUser, patientId, data, !!finalize));

  /* ---- X-rays ---- */
  handle('xray:add', ({ patientId, station, image_png, note }) =>
    db.addXray(currentUser, patientId, { station, image_png, note }));
  handle('xray:get', (id) => db.getXray(id));
  handle('xray:list', (patientId) => db.listXrays(patientId));
  handle('xray:delete', (id) => db.deleteXray(currentUser, id));

  /* ---- Dashboard / audit ---- */
  ipcMain.handle('stats:dashboard', async () => {
    try {
      if (!currentUser) throw new Error('Please sign in first.');
      return { ok: true, data: db.dashboardStats() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('audit:list', (limit) => db.listAudit(limit));

  /* ---- PDF: preview, save, print ---- */
  handle('pdf:preview', async ({ patientId, format }) => {
    const patient = db.getPatient(patientId);
    if (!patient) throw new Error('Patient not found.');
    const buf = await pdf.renderPdf(patient, format);
    db.audit(currentUser, 'export_preview', 'patient', patientId, format);
    return 'data:application/pdf;base64,' + buf.toString('base64');
  });

  handle('pdf:generate', async ({ patientId, format }) => {
    const patient = db.getPatient(patientId);
    if (!patient) throw new Error('Patient not found.');
    const buf = await pdf.renderPdf(patient, format);
    const suggested = `${patient.last_name}_${patient.first_name}_${format === 'full' ? 'FullRecord' : 'ProgressNote'}.pdf`
      .replace(/[^a-z0-9_.-]/gi, '');
    const res = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Save patient record',
      defaultPath: suggested,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    fs.writeFileSync(res.filePath, buf);
    db.audit(currentUser, 'export_pdf', 'patient', patientId, path.basename(res.filePath));
    return { saved: true, path: res.filePath };
  });

  handle('pdf:print', async ({ patientId, format }) => {
    const patient = db.getPatient(patientId);
    if (!patient) throw new Error('Patient not found.');
    const html = pdf.buildHtml(patient, format || 'progress');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((resolve, reject) => {
      win.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
        win.destroy();
        if (!success && reason && reason !== 'cancelled') reject(new Error(reason));
        else resolve();
      });
    });
    db.audit(currentUser, 'print', 'patient', patientId, format);
    return { printed: true };
  });

  /* ---- Backup & export ---- */
  handle('backup:run', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const res = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Back up clinic database to USB / drive',
      defaultPath: `caring-hands-backup-${stamp}.db`,
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    await db.backupTo(res.filePath);
    db.audit(currentUser, 'backup', 'event', null, path.basename(res.filePath));
    return { saved: true, path: res.filePath };
  });

  handle('export:event', async () => {
    const data = db.exportEventJson();
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = (data.event ? data.event.name : 'event').replace(/[^a-z0-9]+/gi, '-');
    const res = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export event records (JSON)',
      defaultPath: `${safe}-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
    db.audit(currentUser, 'export_event', 'event', data.event ? data.event.id : null, path.basename(res.filePath));
    return { saved: true, path: res.filePath, count: data.patients.length };
  });

  /* ---- Patient-portable record (USB the patient carries) ---- */
  handle('record:exportUsb', async ({ patientId }) => {
    const patient = db.getPatient(patientId);
    if (!patient) throw new Error('Patient not found.');
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose USB drive / folder for the patient record',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { saved: false };
    const destDir = res.filePaths[0];
    const base = `${patient.last_name}_${patient.first_name}_CaringHands`.replace(/[^a-z0-9_]/gi, '');
    const folder = path.join(destDir, base);
    fs.mkdirSync(folder, { recursive: true });
    // Full clinical PDF + portable JSON (with x-ray images) for continuity of care.
    const pdfBuf = await pdf.renderPdf(patient, 'full');
    fs.writeFileSync(path.join(folder, `${base}.pdf`), pdfBuf);
    const portable = { ...patient, xrays: db.listXrays(patientId), exported_at: new Date().toISOString() };
    fs.writeFileSync(path.join(folder, `${base}.json`), JSON.stringify(portable, null, 2));
    db.audit(currentUser, 'export_usb', 'patient', patientId, folder);
    return { saved: true, path: folder };
  });

  /* ---- Version & offline updates (available from any view) ---- */
  ipcMain.handle('app:version', async () => {
    try {
      return { ok: true, data: { version: updater.currentVersion(), platform: process.platform, name: 'Caring Hands' } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('update:check', async (_e, payload) => {
    try {
      if (!currentUser) throw new Error('Please sign in first.');
      let dir = payload && payload.dir;
      if (payload && payload.choose) {
        const res = await dialog.showOpenDialog(getMainWindow(), {
          title: 'Select the USB drive / folder that has the update',
          properties: ['openDirectory'],
        });
        if (!res.canceled && res.filePaths.length) dir = res.filePaths[0];
      }
      const result = updater.checkForUpdates(dir);
      db.setSetting('update_last_checked', result.checkedAt);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('update:install', async (_e, { path: installerPath }) => {
    try {
      if (!currentUser || currentUser.role !== 'admin') throw new Error('Only an administrator can install updates.');
      const r = await updater.openInstaller(installerPath);
      db.audit(currentUser, 'update_install', 'app', null, installerPath);
      return { ok: true, data: r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ---- Misc ---- */
  ipcMain.handle('app:openExternal', async (_e, url) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
    return { ok: true };
  });
}

module.exports = { register, getCurrentUser: () => currentUser };
