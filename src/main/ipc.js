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
const autoupdate = require('./autoupdate');
const cloud = require('./cloud');
const usb = require('./usb');

let currentUser = null;

// Role matrix — keys are IPC channels, values are roles allowed to call them.
const PERMS = {
  'users:list': ['admin'],
  'users:create': ['admin'],
  'users:update': ['admin'],
  'users:delete': ['admin'],
  'users:clearEventStaff': ['admin'],
  'events:create': ['admin'],
  'events:update': ['admin'],
  'events:setActive': ['admin'],
  'events:setState': ['admin'],
  'events:delete': ['admin'],
  'patients:delete': ['admin'],
  // 'registration' is a front-desk check-in role. patients:create is registered
  // raw (ungated, like the kiosk) so it can start check-ins; this list is the
  // documented intent.
  'patients:create': ['admin', 'doctor', 'triage', 'emt', 'registration'],
  'patients:update': ['admin', 'triage', 'doctor'],
  'patients:get': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patients:list': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'patients:searchAll': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patients:history': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patients:incomplete': ['admin'],
  'patients:cleanupIncomplete': ['admin'],
  'patients:dismiss': ['admin', 'checkout'],
  'patients:move': ['admin'],
  'patients:audit': ['admin', 'doctor', 'checkout', 'hygienist'],
  'patients:records': ['admin', 'doctor'],
  'triage:save': ['admin', 'doctor', 'triage'],
  'vitals:save': ['admin', 'doctor', 'triage', 'emt'],
  'patients:route': ['admin', 'doctor', 'triage', 'emt'],
  'treatment:save': ['admin', 'doctor', 'hygienist'],
  'consent:setTeeth': ['admin', 'doctor'],
  'consent:add': ['admin', 'doctor'],
  'xray:add': ['admin', 'doctor', 'triage', 'emt'],
  'xray:setTooth': ['admin', 'doctor'],
  'xray:folderList': ['admin', 'doctor'],
  'xray:get': ['admin', 'doctor', 'triage', 'emt', 'hygienist'],
  'xray:list': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'xray:delete': ['admin', 'doctor', 'triage', 'emt'],
  'pdf:generate': ['admin', 'doctor', 'checkout'],
  'pdf:preview': ['admin', 'doctor', 'checkout'],
  'pdf:print': ['admin', 'doctor', 'checkout'],
  'record:exportUsb': ['admin', 'doctor'],
  'usb:list': ['admin', 'doctor', 'triage', 'emt', 'checkout'],
  'usb:load': ['admin', 'doctor', 'triage', 'checkout'],
  'usb:uploadCheckout': ['admin', 'doctor', 'triage', 'checkout'],
  'usb:clear': ['admin', 'doctor', 'triage', 'checkout'],
  'backup:run': ['admin'],
  'export:event': ['admin'],
  'audit:list': ['admin'],
  'cloud:config': ['admin'],
  'cloud:test': ['admin'],
  'cloud:status': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'cloud:syncNow': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
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
  handle('users:clearEventStaff', (eventId) => db.clearEventStaff(currentUser, eventId));

  // v1.1.0 cloud sync
  handle('cloud:config', (payload) => cloud.applyConfig(payload || {}));
  handle('cloud:test', ({ url, key }) => cloud.testConnection(url, key));
  handle('cloud:status', () => cloud.status());
  handle('cloud:syncNow', () => cloud.syncOnce());

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
  // Check-in is the patient-facing intake: a dedicated kiosk (no signed-in
  // user) may create patients, and so may ANY signed-in staff member
  // (admin / doctor / triage). It is intentionally not role-gated.
  ipcMain.handle('patients:create', async (_e, payload) => {
    try {
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
  handle('patients:history', (id) => db.patientHistory(id));
  handle('patients:incomplete', () => db.listIncompletePatients());
  handle('patients:cleanupIncomplete', () => db.deleteIncompletePatients(currentUser));

  /* ---- Triage & treatment ---- */
  handle('triage:save', ({ patientId, data }) => db.saveTriage(currentUser, patientId, data));
  // finalize may be false, 'complete' (mark done, no lock), or 'lock'/true — pass
  // it through so v1.2.1's "complete without lock" mode reaches the data layer.
  handle('treatment:save', ({ patientId, data, finalize }) =>
    db.saveTreatment(currentUser, patientId, data, finalize));

  /* ---- v1.0.6: vitals, consent teeth, dismissal, per-patient audit ---- */
  handle('vitals:save', ({ patientId, data }) => db.saveVitals(currentUser, patientId, data));
  handle('patients:route', ({ patientId, route }) => db.routePatient(currentUser, patientId, route));
  handle('consent:setTeeth', ({ consentId, tooth_numbers }) => db.updateConsentTeeth(currentUser, consentId, tooth_numbers));
  handle('consent:add', ({ patientId, consent }) => db.addPatientConsent(currentUser, patientId, consent));
  handle('patients:dismiss', (id) => db.dismissPatient(currentUser, id));
  handle('patients:move', ({ id, target }) => db.adminMovePatient(currentUser, id, target));
  handle('patients:audit', (id) => db.patientAudit(id));

  /* ---- X-rays ---- */
  handle('xray:add', ({ patientId, station, image_png, note, tooth }) =>
    db.addXray(currentUser, patientId, { station, image_png, note, tooth }));
  handle('xray:setTooth', ({ id, tooth }) => db.updateXrayTooth(currentUser, id, tooth));
  handle('xray:get', (id) => db.getXray(id));
  handle('xray:list', (patientId) => db.listXrays(patientId));
  handle('xray:delete', (id) => db.deleteXray(currentUser, id));

  // Import: list recent standard image files (JPG/PNG/…) from the folder where the
  // imaging software (e.g. DEXIS) exports/saves images, as data URLs the renderer
  // can show as thumbnails and attach to the patient. Remembers the folder per PC.
  const XRAY_IMG_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' };
  handle('xray:folderList', async ({ dir, choose } = {}) => {
    let d = dir || db.getSetting('xray_import_dir') || '';
    if (choose || !d) {
      const res = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Choose the folder where the X-ray images are saved',
        properties: ['openDirectory'],
        defaultPath: d || undefined,
      });
      if (res.canceled || !res.filePaths.length) return { dir: d, images: [], canceled: true };
      d = res.filePaths[0];
      db.setSetting('xray_import_dir', d);
    }
    if (!d || !fs.existsSync(d)) return { dir: d, images: [], error: 'That folder was not found on this computer.' };
    let files = [];
    try {
      files = fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isFile() && XRAY_IMG_EXT[path.extname(e.name).toLowerCase()])
        .map((e) => { const fp = path.join(d, e.name); let st = null; try { st = fs.statSync(fp); } catch (_) { /* skip */ } return st ? { name: e.name, fp, mt: st.mtimeMs, size: st.size } : null; })
        .filter(Boolean)
        .sort((a, b) => b.mt - a.mt)
        .slice(0, 24);
    } catch (e) { return { dir: d, images: [], error: e.message }; }
    const images = files.map((f) => {
      if (f.size > 20 * 1024 * 1024) return null; // skip oversized files
      try {
        const buf = fs.readFileSync(f.fp);
        const mime = XRAY_IMG_EXT[path.extname(f.name).toLowerCase()] || 'image/png';
        return { name: f.name, mtime: f.mt, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
      } catch (_) { return null; }
    }).filter(Boolean);
    return { dir: d, images };
  });

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
  // Attach x-ray images so the summary/full PDF can embed them.
  const patientForPdf = (id) => { const p = db.getPatient(id); if (p) p._xrays = db.listXrays(id); return p; };

  handle('pdf:preview', async ({ patientId, format }) => {
    const patient = patientForPdf(patientId);
    if (!patient) throw new Error('Patient not found.');
    const buf = await pdf.renderPdf(patient, format);
    db.audit(currentUser, 'export_preview', 'patient', patientId, format);
    return 'data:application/pdf;base64,' + buf.toString('base64');
  });

  handle('pdf:generate', async ({ patientId, format }) => {
    const patient = patientForPdf(patientId);
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
    const patient = patientForPdf(patientId);
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

  /* ---- v1.0.6: USB per-patient transfer workflow ---- */
  async function pickDir(title) {
    const res = await dialog.showOpenDialog(getMainWindow(), { title, properties: ['openDirectory'] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  }
  handle('usb:list', () => usb.listDrives());

  // Write the patient's file to the drive at check-in. OPEN (kiosk may be
  // unauthenticated) — registered raw, like patients:create.
  ipcMain.handle('usb:writeCheckin', async (_e, { patientId, choose } = {}) => {
    try {
      const patient = db.getPatient(patientId);
      if (!patient) throw new Error('Patient not found.');
      const dir = await pickDir('Insert/choose the USB drive for this patient');
      if (!dir) return { ok: true, data: { saved: false } };
      const portable = { ...patient, xrays: db.listXrays(patientId), exported_at: new Date().toISOString() };
      let pdfBuf = null;
      try { pdfBuf = await pdf.renderPdf({ ...patient, _xrays: portable.xrays }, 'full'); } catch (e) { /* pdf optional */ }
      const r = usb.writePatientFile(dir, patient, JSON.stringify(portable, null, 2), pdfBuf);
      db.audit(currentUser, 'usb_write', 'patient', patientId, r.path);
      return { ok: true, data: r };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  handle('usb:load', async () => {
    const dir = await pickDir('Choose the USB drive to load the patient from');
    if (!dir) return { loaded: [] };
    const files = usb.loadPatientFiles(dir);
    return { dir, loaded: files.map((f) => ({ name: f.name, first_name: f.patient.first_name, last_name: f.patient.last_name, dob: f.patient.dob })) };
  });

  // Upload every patient file on the drive into the local DB (checkout).
  handle('usb:uploadCheckout', async () => {
    const dir = await pickDir('Choose the USB drive to upload to the local database');
    if (!dir) return { uploaded: 0 };
    const files = usb.loadPatientFiles(dir);
    let uploaded = 0;
    for (const f of files) { try { db.importPatientFromPortable(currentUser, f.patient); uploaded++; } catch (e) { /* skip bad file */ } }
    return { dir, uploaded };
  });

  handle('usb:clear', async ({ dir, choose } = {}) => {
    let d = dir;
    if (!d || choose) d = await pickDir('Choose the USB drive to clear');
    if (!d) return { cleared: 0 };
    const r = usb.clearDrive(d);
    db.audit(currentUser, 'usb_clear', 'patient', null, `${r.cleared} folder(s)`);
    return r;
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
  // Online auto-update (electron-updater / GitHub releases).
  ipcMain.handle('update:onlineAvailable', async () => {
    try { return { ok: true, data: { available: autoupdate.available() } }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('update:checkOnline', async () => {
    try { if (!currentUser) throw new Error('Please sign in first.'); return { ok: true, data: await autoupdate.check() }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('update:downloadOnline', async () => {
    try { if (!currentUser) throw new Error('Please sign in first.'); return { ok: true, data: await autoupdate.download() }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('update:installOnline', async () => {
    try {
      if (!currentUser || currentUser.role !== 'admin') throw new Error('Only an administrator can install updates.');
      return { ok: true, data: autoupdate.quitAndInstall() };
    } catch (err) { return { ok: false, error: err.message }; }
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
