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
const xrayFolder = require('./xrayFolder');
const zipStore = require('./zipStore');
const xlsx = require('./xlsx');
const { clinicSheets } = require('./clinicSheets');
const os = require('os');

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
  'patients:newVisit': ['admin', 'doctor', 'triage', 'emt', 'registration'],
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
  'xray:folderConfig': ['admin', 'doctor'],
  'xray:folderChoose': ['admin', 'doctor'],
  'xray:folderLock': ['admin', 'doctor'],
  'xray:folderDelete': ['admin', 'doctor'],
  'xray:deleteFile': ['admin', 'doctor'],
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
  'export:zip': ['admin'],
  'export:clinic': ['admin'],
  'import:clinic': ['admin'],
  'event:finish': ['admin'],
  'event:purge': ['admin'],
  'reports:archived': ['admin', 'doctor'],
  'reports:rollup': ['admin', 'doctor'],
  'reports:rebuild': ['admin'],
  'export:event': ['admin'],
  'audit:list': ['admin'],
  'cloud:config': ['admin'],
  'cloud:test': ['admin'],
  'cloud:status': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'cloud:syncNow': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'cloud:resync': ['admin'],
  'patients:arrivalCheck': ['admin', 'registration', 'emt', 'triage', 'doctor', 'hygienist'],
  'patients:confirmArrival': ['admin', 'registration', 'emt', 'triage'],
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
  handle('cloud:resync', () => cloud.resyncAll());

  /* ---- Clinic export / restore / purge (v1.6.0) ---- */
  // Two files: a readable workbook, and the backup that can actually put the
  // clinic back (signatures and x-ray images cannot live in a spreadsheet).
  handle('export:clinic', async ({ eventId } = {}) => {
    const bundle = db.exportClinicBundle(eventId);
    const evName = String((bundle.event && bundle.event.name) || 'clinic').replace(/[^a-z0-9]+/gi, '-');
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `Clinic-${evName}-${stamp}`;
    const res = await dialog.showSaveDialog({
      title: 'Save clinic export',
      defaultPath: path.join(os.homedir(), base + '.xlsx'),
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    const xlsxPath = res.filePath.endsWith('.xlsx') ? res.filePath : res.filePath + '.xlsx';
    const backupPath = xlsxPath.replace(/\.xlsx$/i, '') + '.chbak.json';
    fs.writeFileSync(xlsxPath, xlsx.buildWorkbook(clinicSheets(bundle)));
    fs.writeFileSync(backupPath, JSON.stringify(bundle));
    return { saved: true, xlsxPath, backupPath, patients: bundle.patients.length };
  });

  handle('import:clinic', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose a clinic backup file',
      properties: ['openFile'],
      filters: [{ name: 'Caring Hands backup', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { imported: false };
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')); }
    catch (_e) { throw new Error('That file could not be read. Choose the .chbak.json file saved with the export.'); }
    return { imported: true, ...db.importClinicBundle(currentUser, bundle) };
  });

  // Pull everything in before the records go. The kept totals are counted from
  // what is on THIS computer, so finishing a clinic while another station still
  // held unsynced check-ins used to record a number lower than the clinic
  // actually saw — and the patients were gone, so it could never be corrected.
  const syncBeforeRemoving = async () => {
    try { if (cloud.status().enabled) await cloud.syncOnce(); } catch (_e) { /* offline: proceed with local totals */ }
  };
  handle('event:finish', async ({ eventId } = {}) => {
    await syncBeforeRemoving();
    return db.finishEvent(currentUser, eventId);
  });
  handle('event:purge', async ({ eventId } = {}) => {
    await syncBeforeRemoving();
    return db.purgeEventPatients(currentUser, eventId);
  });
  handle('reports:archived', () => db.listEventReports());
  // The Reports tab's numbers, for one event or all of them — live records and
  // the kept totals of finished clinics counted the same way.
  handle('reports:rollup', ({ eventId } = {}) => db.reportRollup(eventId));

  // Recovery: recompute an event's reporting totals from an exported backup
  // WITHOUT restoring any patients — for a clinic whose figures were lost.
  handle('reports:rebuild', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose the clinic backup file to rebuild a report from',
      properties: ['openFile'],
      filters: [{ name: 'Caring Hands backup', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { rebuilt: false };
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')); }
    catch (_e) { throw new Error('That file could not be read. Choose the .chbak.json file saved with the export.'); }
    return { rebuilt: true, ...db.rebuildSummaryFromBundle(currentUser, bundle) };
  });

  /* ---- Front-desk arrivals (v1.5.24) ---- */
  handle('patients:arrivalCheck', (id) => db.arrivalReadiness(id));
  handle('patients:confirmArrival', ({ id, route }) => db.confirmArrival(currentUser, id, { route }));

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
  handle('patients:newVisit', (sourceId) => db.startVisitFromExisting(currentUser, sourceId));
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

  // ---- X-ray import from the imaging software's export folder (DEXIS) ----
  // The folder is chosen ONCE (start of day) and can be LOCKED so the dentist
  // only ever taps a single "Import X-ray" button. We read the images the
  // software saved there, convert DEXIS ".dex" files to a viewable image when a
  // standard image is embedded, and (optionally) clear each file from the folder
  // once it's filed to a chart so the next patient's captures are unambiguous.
  const { XRAY_RENDER_EXT, XRAY_CONVERT_EXT, extractStandardImage, resolveFolderTarget } = xrayFolder;
  const xrayDir = () => db.getSetting('xray_import_dir') || '';
  const xrayLocked = () => db.getSetting('xray_folder_locked') === '1';
  const xrayClearAfter = () => db.getSetting('xray_clear_after_import') !== '0'; // default ON
  const xrayCfg = (extra) => Object.assign({ dir: xrayDir(), locked: xrayLocked(), clearAfter: xrayClearAfter() }, extra || {});

  handle('xray:folderConfig', async () => xrayCfg());

  // Choose the folder (start-of-day setup). Remembered per PC.
  handle('xray:folderChoose', async () => {
    const cur = xrayDir();
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose the folder where the X-ray images are saved',
      properties: ['openDirectory'],
      defaultPath: cur || undefined,
    });
    if (res.canceled || !res.filePaths.length) return xrayCfg({ canceled: true });
    db.setSetting('xray_import_dir', res.filePaths[0]);
    return xrayCfg();
  });

  // Lock/hide the folder controls and/or set the "clear after import" preference.
  handle('xray:folderLock', async ({ locked, clearAfter } = {}) => {
    if (locked !== undefined) db.setSetting('xray_folder_locked', locked ? '1' : '0');
    if (clearAfter !== undefined) db.setSetting('xray_clear_after_import', clearAfter ? '1' : '0');
    return xrayCfg();
  });

  handle('xray:folderList', async () => {
    const d = xrayDir();
    if (!d) return xrayCfg({ needsSetup: true, images: [] });
    if (!fs.existsSync(d)) return xrayCfg({ error: 'That folder was not found on this computer.', images: [] });
    let files;
    try {
      files = fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const ext = path.extname(e.name).toLowerCase();
          if (!XRAY_RENDER_EXT[ext] && !XRAY_CONVERT_EXT[ext]) return null;
          const fp = path.join(d, e.name);
          let st = null; try { st = fs.statSync(fp); } catch (_) { /* skip */ }
          return st ? { name: e.name, ext, fp, mt: st.mtimeMs, size: st.size } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.mt - a.mt)
        .slice(0, 40);
    } catch (e) { return xrayCfg({ error: e.message, images: [] }); }
    const images = files.map((f) => {
      if (f.size > 40 * 1024 * 1024) return { name: f.name, mtime: f.mt, kind: 'unreadable', from: f.ext, reason: 'File is too large to import.' };
      let buf; try { buf = fs.readFileSync(f.fp); } catch (_) { return null; }
      if (XRAY_RENDER_EXT[f.ext]) {
        return { name: f.name, mtime: f.mt, kind: 'image', from: f.ext, dataUrl: `data:${XRAY_RENDER_EXT[f.ext]};base64,${buf.toString('base64')}` };
      }
      const ex = extractStandardImage(buf);
      if (ex) return { name: f.name, mtime: f.mt, kind: 'converted', from: f.ext, dataUrl: `data:${ex.mime};base64,${ex.buf.toString('base64')}` };
      return { name: f.name, mtime: f.mt, kind: 'unreadable', from: f.ext, reason: 'This DEXIS file has no embedded standard image. In DEXIS, use Export/Save as JPEG, then import that.' };
    }).filter(Boolean);
    return xrayCfg({ images });
  });

  // Delete a source file from the import folder AFTER it's filed to a chart, so
  // the folder stays clean for the next patient. Guard hard: only unlink a
  // regular image file whose basename resolves DIRECTLY inside the folder.
  handle('xray:folderDelete', async ({ name } = {}) => {
    const target = resolveFolderTarget(xrayDir(), name);
    try { if (!fs.statSync(target).isFile()) throw new Error('Not a file.'); }
    catch (_) { return { ok: true, alreadyGone: true }; }
    fs.unlinkSync(target);
    return { ok: true };
  });

  // Delete a source image file from the computer's drive by its absolute path,
  // AFTER the doctor's uploaded X-ray has been filed to the chart. Guard to real
  // image files that exist; a missing file is treated as already done.
  const XRAY_DISK_EXT = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.gif': 1, '.bmp': 1, '.webp': 1, '.tif': 1, '.tiff': 1, '.dex': 1, '.dexis': 1 };
  handle('xray:deleteFile', async ({ path: p } = {}) => {
    if (!p || typeof p !== 'string') throw new Error('No file specified.');
    if (!XRAY_DISK_EXT[path.extname(p).toLowerCase()]) throw new Error('Refusing to delete a non-image file.');
    try { if (!fs.statSync(p).isFile()) throw new Error('Not a file.'); }
    catch (_) { return { ok: true, alreadyGone: true }; }
    fs.unlinkSync(p);
    return { ok: true };
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

  handle('export:event', async ({ eventId } = {}) => {
    // Export the event the report is actually SHOWING, not whichever one happens
    // to be active — those are different the moment an admin changes the scope.
    const data = db.exportEventJson(eventId && eventId !== 'all' ? Number(eventId) : undefined);
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

  // Offload the whole clinic as ONE .zip for a hard drive: the full SQLite
  // database (restorable) + a human-readable records JSON + a README.
  handle('export:zip', async () => {
    const data = db.exportEventJson();
    const evName = (data.event ? data.event.name : 'clinic').replace(/[^a-z0-9]+/gi, '-');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const res = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export clinic data as a ZIP (for a hard drive)',
      defaultPath: `caring-hands-${evName}-${stamp}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    // Consistent DB snapshot into a temp file, then fold it into the zip.
    const tmp = path.join(os.tmpdir(), `ch-backup-${Date.now()}.db`);
    let dbBuf;
    try { await db.backupTo(tmp); dbBuf = fs.readFileSync(tmp); }
    finally { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    const readme = [
      'Caring Hands Worldwide — clinic data export',
      'Event: ' + (data.event ? data.event.name : '(none)'),
      'Exported: ' + new Date().toISOString(),
      'Patients in this event: ' + (data.patients ? data.patients.length : 0),
      '',
      'Contents:',
      '  database.db   full SQLite database — the complete clinic (open in Caring Hands or any SQLite tool)',
      '  records.json  all patient records for this event, human-readable',
      '',
      'This archive contains protected health information. Store it securely.',
    ].join('\r\n');
    const buf = zipStore.zip([
      { name: 'database.db', data: dbBuf },
      { name: 'records.json', data: Buffer.from(JSON.stringify(data, null, 2), 'utf8') },
      { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    ]);
    fs.writeFileSync(res.filePath, buf);
    db.audit(currentUser, 'export_zip', 'event', data.event ? data.event.id : null, path.basename(res.filePath));
    return { saved: true, path: res.filePath, count: data.patients ? data.patients.length : 0 };
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
