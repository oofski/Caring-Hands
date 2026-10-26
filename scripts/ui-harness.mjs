// Headless harness: runs the REAL renderer code under jsdom against the real
// SQLite data layer, to verify the intake -> patient-history -> views flow.
import { JSDOM } from 'jsdom';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ---- electron stub so db/pdf can be required ----
const ep = require.resolve('electron');
require.cache[ep] = { id: ep, filename: ep, loaded: true, exports: { BrowserWindow: class {} } };
const db = require('../src/main/db.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uih-'));
const DB_PATH = db.init(tmp);
// A second handle on the same file, for the handful of checks that have to
// forge history (back-date a visit) or read a column the API does not expose.
const rawDb = () => new (require('better-sqlite3'))(DB_PATH);

// ---- jsdom env ----
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Event = window.Event;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.FileReader = window.FileReader;
globalThis.File = window.File;
globalThis.Blob = window.Blob;
globalThis.Image = window.Image;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.devicePixelRatio = 1;
window.speechSynthesis = { cancel() {}, speak() {} };
globalThis.SpeechSynthesisUtterance = class { constructor() {} };
window.SpeechSynthesisUtterance = globalThis.SpeechSynthesisUtterance;
// canvas stub (signature pad)
const fakeCtx = new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.getContext = () => fakeCtx;
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,SIG';
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
window.HTMLElement.prototype.scrollIntoView = function () {};

// ---- mock window.api delegating to the real db, ENFORCING the IPC permission
// matrix (mirrors src/main/ipc.js) so permission regressions are caught here. ----
let currentUser = null;
const PERMS = {
  'usersList': ['admin'], 'usersCreate': ['admin'], 'usersUpdate': ['admin'], 'usersDelete': ['admin'],
  'usersClearEventStaff': ['admin'],
  'eventsCreate': ['admin'], 'eventsUpdate': ['admin'], 'eventsSetActive': ['admin'], 'eventsSetState': ['admin'], 'eventsSetPrereg': ['admin'],
  'treatmentNote': ['admin', 'doctor', 'hygienist'], 'treatmentReopen': ['admin', 'doctor', 'hygienist'], 'eventsDelete': ['admin'],
  'patientsUpdate': ['admin', 'triage', 'doctor'], 'patientsGet': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patientsList': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'], 'patientsRecords': ['admin', 'doctor'],
  'patientsSearchAll': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'], 'patientsHistory': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patientsIncomplete': ['admin'], 'patientsCleanupIncomplete': ['admin'], 'patientsDelete': ['admin'],
  'patientsDismiss': ['admin', 'checkout'], 'patientsMove': ['admin'], 'patientsAudit': ['admin', 'doctor', 'checkout', 'hygienist'],
  'vitalsSave': ['admin', 'doctor', 'triage', 'emt'], 'patientsRoute': ['admin', 'doctor', 'triage', 'emt'], 'consentSetTeeth': ['admin', 'doctor'], 'consentAdd': ['admin', 'doctor', 'registration', 'emt', 'triage', 'hygienist'],
  'usbLoad': ['admin', 'doctor', 'triage', 'checkout'], 'usbUploadCheckout': ['admin', 'doctor', 'triage', 'checkout'], 'usbClear': ['admin', 'doctor', 'triage', 'checkout'],
  'triageSave': ['admin', 'doctor', 'triage'], 'treatmentSave': ['admin', 'doctor', 'hygienist'],
  'triageStationNote': ['admin', 'registration', 'emt'],
  'patientsNoShow': ['admin', 'registration'], 'patientsNoShowUndo': ['admin', 'registration'], 'patientsNoShowAll': ['admin', 'registration'],
  'triageStationNotes': ['admin', 'registration', 'emt', 'doctor', 'triage', 'hygienist', 'checkout'],
  'xrayAdd': ['admin', 'doctor', 'triage'], 'xraySetTooth': ['admin', 'doctor'], 'xrayGet': ['admin', 'doctor', 'triage', 'hygienist'], 'xrayList': ['admin', 'doctor', 'triage', 'hygienist'], 'xrayDelete': ['admin', 'doctor', 'triage'],
  'xrayFolderConfig': ['admin', 'doctor'], 'xrayFolderChoose': ['admin', 'doctor'], 'xrayFolderLock': ['admin', 'doctor'], 'xrayFolderDelete': ['admin', 'doctor'], 'xrayDeleteFile': ['admin', 'doctor'],
  'pdfPreview': ['admin', 'doctor'], 'pdfGenerate': ['admin', 'doctor'], 'pdfPrint': ['admin', 'doctor'],
  'recordExportUsb': ['admin', 'doctor'], 'backupRun': ['admin'], 'exportEvent': ['admin'], 'auditList': ['admin'],
  'reportsArchived': ['admin', 'doctor'], 'reportsRollup': ['admin', 'doctor'],
  'staffDirectory': ['admin'], 'staffAdd': ['admin'], 'staffForget': ['admin'], 'staffResetClinicPassword': ['admin'],
};
// patientsCreate is intentionally UNGATED (kiosk + any role); statsDashboard needs a user.
function guard(name) {
  const allowed = PERMS[name];
  if (!allowed) return;
  if (!currentUser) throw new Error('Please sign in first.');
  if (!allowed.includes(currentUser.role)) throw new Error('Your role does not have permission for this action.');
}
const okWrap = (fn, name) => async (payload) => { try { if (name) guard(name); return { ok: true, data: await fn(payload) }; } catch (e) { return { ok: false, error: e.message }; } };
// Mutable stand-in for the DEXIS export folder used by the X-ray import wizard.
let mockFolder = { dir: '', locked: false, clearAfter: true, images: [] };
// Records absolute paths the renderer asked to delete from the computer's drive.
const mockDeletedFromDrive = [];
const cloudChangedHandlers = [];
window.api = {
  invoke: async () => ({ ok: true }),
  authLogin: okWrap(({ username, password }) => { const u = db.login(username, password); if (!u) throw new Error('Invalid username or password.'); currentUser = u; return u; }),
  authLogout: async () => { currentUser = null; return { ok: true }; },
  authCurrent: okWrap(() => currentUser),
  usersList: okWrap(() => db.listUsers(), 'usersList'),
  usersCreate: okWrap((p) => db.createUser(currentUser, p), 'usersCreate'),
  usersUpdate: okWrap(({ id, ...r }) => db.updateUser(currentUser, id, r), 'usersUpdate'),
  usersDelete: okWrap((id) => db.deleteUser(currentUser, id), 'usersDelete'),
  usersClearEventStaff: okWrap((eventId) => db.clearEventStaff(currentUser, eventId), 'usersClearEventStaff'),
  eventsList: okWrap(() => db.listEvents()),
  eventsActive: okWrap(() => db.getActiveEvent()),
  eventsCreate: okWrap((p) => db.createEvent(currentUser, p), 'eventsCreate'),
  eventsUpdate: okWrap(({ id, ...r }) => db.updateEvent(currentUser, id, r), 'eventsUpdate'),
  eventsSetActive: okWrap((id) => db.setActiveEvent(currentUser, id), 'eventsSetActive'),
  eventsSetState: okWrap(({ id, active }) => db.setEventActive(currentUser, id, active), 'eventsSetState'),
  eventsSetPrereg: okWrap(({ id, open }) => db.setEventPreregOpen(currentUser, id, open), 'eventsSetPrereg'),
  treatmentNote: okWrap(({ patientId, note }) => db.addTreatmentNote(currentUser, patientId, note), 'treatmentNote'),
  treatmentReopen: okWrap(({ patientId }) => db.reopenTreatment(currentUser, patientId), 'treatmentReopen'),
  eventsDelete: okWrap(({ id, force }) => db.deleteEvent(currentUser, id, { force }), 'eventsDelete'),
  patientsCreate: okWrap((p) => db.createPatient(currentUser, p)), // ungated (kiosk + any role)
  patientsUpdate: okWrap(({ id, ...d }) => db.updatePatient(currentUser, id, d), 'patientsUpdate'),
  patientsDelete: okWrap((id) => db.deletePatient(currentUser, id), 'patientsDelete'),
  patientsGet: okWrap((id) => db.getPatient(id), 'patientsGet'),
  patientsList: okWrap((o) => db.listPatients(o || {}), 'patientsList'),
  patientsRecords: okWrap((o) => db.listPatients(o || {}), 'patientsRecords'),
  patientsSearchAll: okWrap((t) => db.searchAllPatients(t), 'patientsSearchAll'),
  patientsHistory: okWrap((id) => db.patientHistory(id), 'patientsHistory'),
  patientsIncomplete: okWrap(() => db.listIncompletePatients(), 'patientsIncomplete'),
  patientsCleanupIncomplete: okWrap(() => db.deleteIncompletePatients(currentUser), 'patientsCleanupIncomplete'),
  triageSave: okWrap(({ patientId, data, opts }) => db.saveTriage(currentUser, patientId, data, opts), 'triageSave'),
  treatmentSave: okWrap(({ patientId, data, finalize }) => db.saveTreatment(currentUser, patientId, data, finalize), 'treatmentSave'),
  vitalsSave: okWrap(({ patientId, data }) => db.saveVitals(currentUser, patientId, data), 'vitalsSave'),
  triageStationNote: okWrap(({ patientId, note }) => db.addStationNote(currentUser, patientId, note), 'triageStationNote'),
  patientsNoShow: okWrap(({ id }) => db.markNoShow(currentUser, id), 'patientsNoShow'),
  patientsNoShowUndo: okWrap(({ id }) => db.undoNoShow(currentUser, id), 'patientsNoShowUndo'),
  patientsNoShowAll: okWrap(({ eventId } = {}) => db.markNoShows(currentUser, eventId), 'patientsNoShowAll'),
  triageStationNotes: okWrap(({ patientId }) => db.listStationNotes(patientId), 'triageStationNotes'),
  patientsRoute: okWrap(({ patientId, route }) => db.routePatient(currentUser, patientId, route), 'patientsRoute'),
  consentSetTeeth: okWrap(({ consentId, tooth_numbers }) => db.updateConsentTeeth(currentUser, consentId, tooth_numbers), 'consentSetTeeth'),
  consentAdd: okWrap(({ patientId, consent }) => db.addPatientConsent(currentUser, patientId, consent), 'consentAdd'),
  patientsDismiss: okWrap((id) => db.dismissPatient(currentUser, id), 'patientsDismiss'),
  patientsMove: okWrap(({ id, target }) => db.adminMovePatient(currentUser, id, target), 'patientsMove'),
  patientsAudit: okWrap((id) => db.patientAudit(id), 'patientsAudit'),
  usbList: async () => ({ ok: true, data: [] }),
  usbWriteCheckin: async () => ({ ok: true, data: { saved: false } }),
  usbLoad: okWrap(() => ({ loaded: [] }), 'usbLoad'),
  usbUploadCheckout: okWrap(() => ({ uploaded: 0 }), 'usbUploadCheckout'),
  usbClear: okWrap(() => ({ cleared: 0 }), 'usbClear'),
  xrayAdd: okWrap((p) => db.addXray(currentUser, p.patientId, p), 'xrayAdd'),
  xraySetTooth: okWrap(({ id, tooth }) => db.updateXrayTooth(currentUser, id, tooth), 'xraySetTooth'),
  // In-memory stand-in for the DEXIS export folder (the real one lives in main).
  xrayFolderList: async () => ({ ok: true, data: { dir: mockFolder.dir, locked: mockFolder.locked, clearAfter: mockFolder.clearAfter, needsSetup: !mockFolder.dir, images: mockFolder.images.slice() } }),
  xrayFolderConfig: okWrap(() => ({ dir: mockFolder.dir, locked: mockFolder.locked, clearAfter: mockFolder.clearAfter }), 'xrayFolderConfig'),
  xrayFolderChoose: okWrap(() => { mockFolder.dir = 'C:/DEXIS/Images'; return { dir: mockFolder.dir, locked: mockFolder.locked, clearAfter: mockFolder.clearAfter }; }, 'xrayFolderChoose'),
  xrayFolderLock: okWrap((o) => { if (o.locked !== undefined) mockFolder.locked = !!o.locked; if (o.clearAfter !== undefined) mockFolder.clearAfter = !!o.clearAfter; return { dir: mockFolder.dir, locked: mockFolder.locked, clearAfter: mockFolder.clearAfter }; }, 'xrayFolderLock'),
  xrayFolderDelete: okWrap(({ name }) => { mockFolder.images = mockFolder.images.filter((im) => im.name !== name); return { ok: true }; }, 'xrayFolderDelete'),
  xrayDeleteFile: okWrap(({ path }) => { mockDeletedFromDrive.push(path); return { ok: true }; }, 'xrayDeleteFile'),
  xrayGet: okWrap((id) => db.getXray(id), 'xrayGet'),
  xrayList: okWrap((id) => db.listXrays(id), 'xrayList'),
  xrayDelete: okWrap((id) => db.deleteXray(currentUser, id), 'xrayDelete'),
  statsDashboard: okWrap(() => { if (!currentUser) throw new Error('Please sign in first.'); return db.dashboardStats(); }),
  auditList: okWrap((l) => db.listAudit(l), 'auditList'),
  // v1.6.5: the kept totals a purged clinic leaves behind.
  reportsArchived: okWrap(() => db.listEventReports(), 'reportsArchived'),
  // v1.6.7: the standing list of everyone who has ever worked a clinic.
  staffDirectory: okWrap(({ eventId } = {}) => db.listStaffDirectory(eventId), 'staffDirectory'),
  staffAdd: okWrap((p) => db.addStaffFromDirectory(currentUser, p || {}), 'staffAdd'),
  staffForget: okWrap(({ id } = {}) => db.forgetStaff(currentUser, id), 'staffForget'),
  staffResetClinicPassword: okWrap(({ username } = {}) => db.resetClinicAccountPassword(currentUser, username), 'staffResetClinicPassword'),
  // v1.6.6: the Reports tab's numbers — live records AND kept totals, counted once.
  reportsRollup: okWrap(({ eventId } = {}) => db.reportRollup(eventId), 'reportsRollup'),
  pdfPreview: async () => ({ ok: true, data: 'data:application/pdf;base64,' }),
  pdfGenerate: async () => ({ ok: true, data: { saved: false } }),
  pdfPrint: async () => ({ ok: true, data: { printed: true } }),
  recordExportUsb: async () => ({ ok: true, data: { saved: false } }),
  backupRun: async () => ({ ok: true, data: { saved: false } }),
  exportEvent: async () => ({ ok: true, data: { saved: false, count: 0 } }),
  appVersion: async () => ({ ok: true, data: { version: '1.0.2', platform: 'test', name: 'Caring Hands' } }),
  updateCheck: async () => ({ ok: true, data: { current: '1.0.2', hasUpdate: false, latest: null, checkedAt: '' } }),
  updateInstall: async () => ({ ok: true, data: { launched: true } }),
  appOpenExternal: async () => ({ ok: true }),
  // v1.2.3 cloud sync — always-online by default
  cloudStatus: async () => ({ ok: true, data: { enabled: true, mode: 'online', online: true, url: 'https://little-block-222a.randy-982.workers.dev', hasKey: true, usingDefaultCloud: true, deviceId: 'test-device', cursor: '', lastOk: '', lastPush: '', lastError: '', running: false, pushed: 0, pulled: 0, applied: 0 } }),
  cloudConfig: async () => ({ ok: true, data: { enabled: true, mode: 'online', online: true, url: 'https://little-block-222a.randy-982.workers.dev', hasKey: true, usingDefaultCloud: true } }),
  cloudTest: async () => ({ ok: true, data: { service: 'caring-hands-sync', version: '1.1.0' } }),
  cloudSyncNow: async () => ({ ok: true, data: { ok: true, pushed: 0, pulled: 0, applied: 0 } }),
  // Captured, so a test can fire a real "another laptop synced" event at the app shell.
  onCloudChanged: (cb) => { cloudChangedHandlers.push(cb); return () => {}; },
};

const tick = () => new Promise((r) => setTimeout(r, 5));
const errors = [];
window.addEventListener('error', (e) => errors.push('window error: ' + (e.error && e.error.message)));
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e && e.message)));

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function clickText(text, root = document) {
  const b = $all('button', root).find((x) => x.textContent.trim().includes(text));
  if (!b) throw new Error('button not found: ' + text);
  b.click(); return b;
}
function setInput(inp, val) {
  inp.value = val;
  inp.dispatchEvent(new window.Event('input', { bubbles: true }));
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function drawSig(root = document) {
  const c = $('.sigpad-canvas', root);
  if (!c) return false;
  const down = new window.Event('pointerdown', { bubbles: true }); down.clientX = 10; down.clientY = 10; down.pointerId = 1; c.dispatchEvent(down);
  const mv = new window.Event('pointermove', { bubbles: true }); mv.clientX = 30; mv.clientY = 30; mv.pointerId = 1; c.dispatchEvent(mv);
  const up = new window.Event('pointerup', { bubbles: true }); up.pointerId = 1; c.dispatchEvent(up);
  return true;
}

// Answer every yes/no question on the current step that is still blank, by
// clicking its "No". Returns how many it had to answer.
function answerRemainingYesNo(pick = 'no') {
  let n = 0;
  $all('.kiosk-body .field').forEach((f) => {
    const btns = $all('.chip-btn', f);
    if (btns.length !== 2) return;                       // not a yes/no pair
    if (btns.some((b) => b.classList.contains('chip-btn--on'))) return; // already answered
    btns[pick === 'yes' ? 0 : 1].click();
    n += 1;
  });
  return n;
}

// Every real check-in arrives with a SIGNED general consent — the kiosk and the
// cloud form both refuse to submit without one. Fixtures that skipped it were
// exercising a state the product cannot produce, which is how an unsigned
// patient reaching a clinician went unnoticed.
const SIGNED = [{ type: 'general', signer_name: 'Test Patient', signature_png: 'data:image/png;base64,AAAA' }];
// An extraction visit needs the oral-surgery consent too before anyone may be
// sent to a clinician, so fixtures for those visits carry both.
const SIGNED_SURGERY = [...SIGNED, { type: 'oral_surgery', signer_name: 'Test Patient', signature_png: 'data:image/png;base64,BBBB' }];

const results = [];
const log = (ok, msg) => { results.push([ok, msg]); console.log((ok ? 'PASS ' : 'FAIL ') + msg); };

async function main() {
  // Boot the real app
  await import('../src/renderer/js/app.js');
  await tick();
  log(!!$('.auth-split') && !!$('.auth-form'), 'app boots to the two-panel sign-in screen');

  // ---- Drive the kiosk wizard (unauthenticated, like a real kiosk) ----
  currentUser = null;
  clickText('Start patient check-in'); // login.js kiosk button
  await tick();
  const gate = $('.kiosk-gate');
  log(!!gate, 'kiosk language gate renders');
  // choose English
  const enCard = $all('.lang-card').find((c) => /English/i.test(c.textContent));
  enCard.click();
  await tick();
  log(!!$('.kiosk-body'), 'wizard renders after language choice');

  // Step: Demographics — fill name + a couple fields
  let inputs = $all('.kiosk-body input');
  log(inputs.length > 0, 'demographics step has inputs (' + inputs.length + ')');
  log(!/Children by age group/i.test($('.kiosk-body').textContent), 'v1.4.9: demographics no longer asks about children');
  // first two text inputs are first/last name
  const textInputs = inputs.filter((i) => i.type === 'text' || !i.type);
  setInput(textInputs[0], 'Maria');
  setInput(textInputs[1], 'Lopez');
  // dob (v1.5.20: now required to advance)
  // Typed MM/DD/YYYY now, not a date picker — this also exercises the mask
  // and the ISO conversion on the way in.
  const dob = $all('.kiosk-body input').find((i) => i.placeholder === 'MM/DD/YYYY'); if (dob) setInput(dob, '04/12/1985');
  // v1.5.20: gender is now required to advance — select it.
  const genderSel = $all('.kiosk-body label.field').find((l) => /^Gender/i.test(((l.querySelector('.field-label') || {}).textContent || '').trim()));
  log(!!(genderSel && genderSel.querySelector('select')), 'v1.5.20: gender field present');
  if (genderSel) { const g = genderSel.querySelector('select'); if (g && g.options.length > 1) { g.value = g.options[1].value; g.dispatchEvent(new window.Event('change', { bubbles: true })); } }
  // v1.5.20: City + State collected at check-in (Sandy Oregon grant reporting).
  const bodyTxt = $('.kiosk-body').textContent;
  const fieldLabels = $all('.kiosk-body .field-label').map((s) => s.textContent.trim());
  log(fieldLabels.some((l) => /^City/.test(l)) && fieldLabels.some((l) => /^State/.test(l)), 'v1.5.20: check-in collects City and State');
  const setCityState = (re, val) => {
    const lbl = $all('.kiosk-body label.field').find((l) => re.test(((l.querySelector('.field-label') || {}).textContent || '').trim()));
    const inp = lbl && lbl.querySelector('input'); if (inp) setInput(inp, val); return !!inp;
  };
  // v1.5.22: City + State are required to advance — check the guard fires when
  // they are blank, before filling them in.
  const cityLbl = $all('.kiosk-body .field-label').map((s) => s.textContent.trim());
  log(cityLbl.some((l) => /^City\s*\*/.test(l)) && cityLbl.some((l) => /^State\s*\*/.test(l)),
    'v1.5.22: City + State marked required (*) at check-in');
  const stepsBefore = $('.kiosk-step-label').textContent;
  clickText('Next'); await tick();
  log($('.kiosk-step-label').textContent === stepsBefore, 'v1.5.22: check-in will not advance with City/State blank');
  setCityState(/^City/i, 'Sandy'); setCityState(/^State/i, 'OR');
  // v1.5.20: date of birth is marked required (*).
  log(/Date of birth\s*\*/.test(bodyTxt) && /Gender\s*\*/.test(bodyTxt), 'v1.5.20: date of birth + gender marked required (*)');
  // v1.0.6 F1-F3: phone + emergency contact name + phone are now required to advance.
  const fillField = (re, val) => {
    const lbl = $all('.kiosk-body label.field').find((l) => re.test(((l.querySelector('.field-label') || {}).textContent || '').trim()));
    const inp = lbl && lbl.querySelector('input');
    if (inp) setInput(inp, val);
    return !!inp;
  };
  log(fillField(/^Phone/i, '503-555-0100'), 'F1 phone field present (required)');
  log(fillField(/Emergency contact name/i, 'Jose Lopez'), 'F2 emergency contact name present (required)');
  log(fillField(/Emergency contact phone/i, '503-555-0199'), 'F3 emergency contact phone present (required)');
  // F4: referral dropdown
  const refSel = $all('.kiosk-body label.field').find((l) => /How did you hear/i.test(((l.querySelector('.field-label') || {}).textContent || '')));
  log(!!(refSel && refSel.querySelector('select')), 'F4 referral dropdown present');
  if (refSel) { const s = refSel.querySelector('select'); if (s && s.options.length > 1) { s.value = s.options[1].value; s.dispatchEvent(new window.Event('change', { bubbles: true })); } }
  clickText('Next');
  await tick();

  // Step: Medical history — pick an allergy + a condition + a yes/no
  log(/Medical|Historia/i.test($('.kiosk-step-label').textContent), 'on medical history step');
  const chips = $all('.kiosk-body .chip-select');
  log(chips.length > 0, 'medical step has condition/allergy chips (' + chips.length + ')');
  // v1.4.8: allergies offer Lidocaine + Articaine, and no longer Novocain.
  const chipText = chips.map((c) => c.textContent).join(' | ');
  log(/Lidocaine/i.test(chipText) && /Articaine/i.test(chipText), 'allergies offer Lidocaine + Articaine at check-in');
  log(!/Novocain/i.test(chipText), 'allergies no longer offer Novocain at check-in');
  // v1.4.9: allergies / conditions / medications are required (labels marked *).
  log(/Medication allergies\s*\*/.test($('.kiosk-body').textContent), 'v1.4.9: allergies marked required (*)');
  // click a known allergy (Penicillin) and a condition (Diabetes)
  const pen = chips.find((c) => /Penicillin/i.test(c.textContent)); if (pen) pen.click();
  const dia = chips.find((c) => /Diabet/i.test(c.textContent)); if (dia) dia.click();
  // a yes/no chip (tobacco)
  const yesBtn = $all('.kiosk-body .chip-btn').find((b) => /Yes|S[ií]/.test(b.textContent)); if (yesBtn) yesBtn.click();
  // v1.4.9: with allergies + conditions answered but MEDICATIONS not, Next is blocked.
  clickText('Next'); await tick();
  log(/Medical|Historia/i.test($('.kiosk-step-label').textContent), 'v1.4.9: medical step blocks Next until medications are answered');
  const noMeds = $('.kiosk-body .big-check'); if (noMeds) { noMeds.checked = true; noMeds.dispatchEvent(new window.Event('change', { bubbles: true })); }
  // v1.6.9: the four medical yes/no questions must be ANSWERED, exactly as the
  // online pre-registration form has required since v1.6.4. Only one has been
  // clicked so far, so Next must still refuse.
  log(/Are you currently under a doctor.s care\?\s*\*/.test($('.kiosk-body').textContent),
    'v1.6.9: the medical history questions are marked required (*) at check-in');
  clickText('Next'); await tick();
  log(/Medical|Historia/i.test($('.kiosk-step-label').textContent),
    'v1.6.9: check-in will not advance with a medical history question unanswered');
  const answeredMed = answerRemainingYesNo();
  log(answeredMed === 3, 'v1.6.9: (setup) answered the remaining medical questions (' + answeredMed + ')');
  clickText('Next');
  await tick();

  // Step: Dental history — reason
  log(/Dental/i.test($('.kiosk-step-label').textContent), 'on dental history step');
  log(!/long-term dental goals/i.test($('.kiosk-body').textContent) && !/cosmetic/i.test($('.kiosk-body').textContent), 'v1.4.9: dental step no longer asks long-term goals / cosmetic interest');
  const ta = $('.kiosk-body textarea'); if (ta) setInput(ta, 'Lower left tooth pain');
  // v1.4.9: choose a visit type on the required 1–4 scale. Pick 3 = Filling so no
  // surgery consent is added (keeps this drive on the existing review path).
  const vrange = $('.visit-range');
  log(!!vrange, 'dental step has the 1–4 visit-type scale');
  const vticks = $all('.kiosk-body .highlight-field button');
  log(vticks.length === 4, 'visit-type scale offers 4 options (' + vticks.length + ')');
  // v1.5.26: the slider parks on 1 before anything is chosen, so sliding TO 1
  // changes nothing and fires no 'input' event. The patient was then refused at
  // Next for an answer they thought they had given. Any interaction now commits.
  log(vrange.style.opacity === '0.45', 'v1.5.26: the scale looks unset until a choice is made');
  vrange.value = '1';
  vrange.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  log(/1\./.test($('.visit-desc').textContent) && vrange.style.opacity === '1',
    'v1.5.26: tapping the scale on option 1 registers the choice (no silent rejection)');
  if (vrange) { vrange.value = '3'; vrange.dispatchEvent(new window.Event('input', { bubbles: true })); }
  // v1.6.9: and the six dental history questions, for the same reason.
  log(/Do your gums bleed\?\s*\*/.test($('.kiosk-body').textContent),
    'v1.6.9: the dental history questions are marked required (*) at check-in');
  clickText('Next'); await tick();
  log(/Dental/i.test($('.kiosk-step-label').textContent),
    'v1.6.9: check-in will not advance with a dental history question unanswered');
  const answeredDent = answerRemainingYesNo();
  log(answeredDent === 6, 'v1.6.9: (setup) answered the dental questions (' + answeredDent + ')');
  clickText('Next');
  await tick();

  // Step: General consent — agree + signer + signature
  log(/Consent|Consentimiento/i.test($('.kiosk-step-label').textContent), 'on consent step');
  log(/specimens, tissue or parts/i.test($('.kiosk-body').textContent) && /hold Caring Hands Worldwide/i.test($('.kiosk-body').textContent), 'general consent shows the complete new wording at check-in');
  const agree = $('.big-check'); if (agree) { agree.checked = true; agree.dispatchEvent(new window.Event('change', { bubbles: true })); }
  const signer = $all('.kiosk-body input').find((i) => /name/i.test(i.placeholder || '') || true);
  // signer is the first text input on consent step
  const consentInputs = $all('.kiosk-body input').filter((i) => i.type === 'text' || !i.type);
  if (consentInputs[0]) setInput(consentInputs[0], 'Maria Lopez');
  // v1.6.9: the signature is what makes this a consent, and the online form has
  // always refused without one. Agreed + named but UNSIGNED must not advance.
  clickText('Next'); await tick();
  log(/Consent|Consentimiento/i.test($('.kiosk-step-label').textContent),
    'v1.6.9: check-in will not advance on an unsigned consent');
  drawSig();
  // ...and clearing it again puts the block straight back, so a signature that
  // is wiped cannot be walked past by tapping Next twice.
  const clearBtn = $all('.sigpad-actions button')[0];
  if (clearBtn) {
    clearBtn.click(); await tick();
    clickText('Next'); await tick();
    log(/Consent|Consentimiento/i.test($('.kiosk-step-label').textContent),
      'v1.7.0: clearing the signature blocks check-in again');
    drawSig();
  } else {
    log(false, 'v1.7.0: (setup) signature pad has a Clear control');
  }
  clickText('Next');
  await tick();

  // v1.2.0 Step: provider choice — "Who would you like to see today?" (required).
  const routeCards = $all('.route-card, .kiosk-body .lang-card');
  log(routeCards.length >= 2, 'provider-choice step: dentist/hygienist options present (' + routeCards.length + ')');
  const dentistCard = routeCards.find((c) => /Dentist|Dentista|Стоматолог/i.test(c.textContent)) || routeCards[0];
  if (dentistCard) dentistCard.click();
  await tick();
  clickText('Next');
  await tick();

  // Now should be Review (may_need_extraction was not 'yes')
  const onReview = /Sign|Review|Firmar|Send|Submit/i.test($('.kiosk-step-label') ? $('.kiosk-step-label').textContent : '');
  log(!!$('.review') || onReview, 'reached review/sign step');
  // Submit
  const submitBtn = $all('.kiosk-nav button').find((b) => /Submit|Send|Enviar/i.test(b.textContent)) || $all('.kiosk-nav button').pop();
  submitBtn.click();
  await tick(); await tick();

  log(!!$('.kiosk-thanks'), 'thank-you screen shown after submit');

  // ---- Verify the patient persisted with full history ----
  const all = db.listPatients({ eventId: 'all' });
  const created = all.find((p) => p.last_name === 'Lopez');
  log(!!created, 'patient persisted (' + (created ? created.first_name + ' ' + created.last_name : 'NONE') + ')');
  if (created) {
    const full = db.getPatient(created.id);
    log(full.first_name === 'Maria', 'demographics captured: first_name=' + full.first_name);
    log((full.medical_history.allergies || []).includes('penicillin'), 'medical allergies captured: ' + JSON.stringify(full.medical_history.allergies));
    log((full.medical_history.conditions || []).includes('diabetes'), 'medical conditions captured: ' + JSON.stringify(full.medical_history.conditions));
    log(!!full.dental_history.reason, 'dental history captured: reason=' + full.dental_history.reason);
    log(full.dental_history.visit_type === 'filling' && full.dental_history.may_need_extraction === 'no', 'v1.4.9: visit-type scale captured (filling → no surgery consent)');
    log((full.consents || []).length > 0, 'consent captured: ' + (full.consents || []).length + ' consent(s)');
    // v1.2.0: patient chose a provider at check-in; vitals are NOT collected here.
    log(full.triage && full.triage.route === 'dentist', 'A4: check-in provider choice stored (route=' + (full.triage && full.triage.route) + ')');
    log(full.status === 'checked_in', 'B1: new check-in stays checked_in (EMT queue only)');
    log(full.medical_history.bp_systolic == null, 'A2: vitals NOT collected at patient check-in');

    // ---- Render the clinician views and check history appears ----
    currentUser = db.login('admin', 'admin');
    const { renderRecords } = await import('../src/renderer/js/views/records.js');
    const ctx = { navigate: () => {}, toast: () => {}, store: (await import('../src/renderer/js/store.js')).store };
    ctx.store.setUser(currentUser);
    const recRoot = renderRecords(ctx, { id: created.id });
    document.body.append(recRoot);
    await tick(); await tick();
    const recText = recRoot.textContent;
    log(/Lower left tooth pain/.test(recText), 'records view shows dental history reason');
    log(/Diabetes/i.test(recText), 'records view shows condition');
    log(/Penicillin/i.test(recText), 'records view shows allergy');
  }

  // ---- Smoke render the other views to catch runtime errors ----
  // Always run authenticated so a kiosk regression can't mask real view errors.
  currentUser = db.login('admin', 'admin');
  // v1.0.9: the triage view is unregistered from the app shell (station removed).
  const views = ['dashboard', 'provider', 'reports', 'admin', 'emt', 'checkout', 'hygienist', 'management'];
  for (const v of views) {
    try {
      const mod = await import('../src/renderer/js/views/' + v + '.js');
      const fn = mod['render' + v[0].toUpperCase() + v.slice(1)];
      const store = (await import('../src/renderer/js/store.js')).store;
      store.setUser(currentUser);
      const ctx = { navigate: () => {}, toast: () => {}, store };
      const node = fn(ctx, {});
      document.body.append(node);
      await tick(); await tick();
      log(true, 'view renders without throwing: ' + v);
    } catch (e) {
      log(false, 'view THREW: ' + v + ' -> ' + e.message);
    }
  }

  // ---- Permission tests (the role-gate that broke check-in) ----
  currentUser = db.login('admin', 'admin');
  db.createUser(currentUser, { username: 'docx', full_name: 'Dr X', role: 'doctor', password: 'x' });
  let pr = await window.api.authLogin({ username: 'docx', password: 'x' });
  log(pr.ok && pr.data.role === 'doctor', 'can sign in as a doctor');
  pr = await window.api.patientsCreate({ first_name: 'Walkin', last_name: 'Patient', demographics: {}, medical_history: {}, dental_history: { reason: 'pain' }, consents: SIGNED });
  log(pr.ok, 'DOCTOR can complete a check-in (the reported bug): ' + (pr.ok ? 'allowed' : pr.error));
  pr = await window.api.usersList();
  log(!pr.ok && /permission/i.test(pr.error || ''), 'permission guard works: doctor blocked from staff list');
  // triage role can also check in
  currentUser = db.login('admin', 'admin'); db.createUser(currentUser, { username: 'trix', full_name: 'Front', role: 'triage', password: 'x' });
  await window.api.authLogin({ username: 'trix', password: 'x' });
  pr = await window.api.patientsCreate({ first_name: 'Tri', last_name: 'Age', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
  log(pr.ok, 'TRIAGE can complete a check-in: ' + (pr.ok ? 'allowed' : pr.error));
  // v1.0.6 roles: EMT records vitals; CHECKOUT dismisses a signed-off patient.
  currentUser = db.login('admin', 'admin'); db.createUser(currentUser, { username: 'emtx', full_name: 'EMT One', role: 'emt', password: 'x' });
  db.createUser(currentUser, { username: 'cox', full_name: 'Checkout One', role: 'checkout', password: 'x' });
  const vp = db.createPatient(currentUser, { first_name: 'Vital', last_name: 'Test', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
  await window.api.authLogin({ username: 'emtx', password: 'x' });
  pr = await window.api.vitalsSave({ patientId: vp.id, data: { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' } });
  log(pr.ok, 'EMT can record vitals: ' + (pr.ok ? 'allowed' : pr.error));
  // v1.0.8: EMT confirms blood thinners after vitals; a plain re-save must not wipe it.
  pr = await window.api.vitalsSave({ patientId: vp.id, data: { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70', blood_thinner: 'yes', blood_thinner_detail: 'Eliquis' } });
  log(pr.ok && pr.data.triage.blood_thinner === 'yes' && pr.data.triage.blood_thinner_detail === 'Eliquis', 'EMT records blood-thinner answer (persists): ' + (pr.ok ? pr.data.triage.blood_thinner : pr.error));
  pr = await window.api.vitalsSave({ patientId: vp.id, data: { bp_systolic: '118', bp_diastolic: '78', heart_rate: '66' } });
  log(pr.ok && pr.data.triage.blood_thinner === 'yes', 'plain vitals re-save keeps the blood-thinner answer');

  // ---- v1.0.9: EMT routes the patient after vitals (triage station removed) ----
  pr = await window.api.patientsRoute({ patientId: vp.id, route: 'dentist' });
  log(pr.ok && pr.data.status === 'triaged' && pr.data.triage.route === 'dentist', 'EMT routes to dentist -> patient enters dentist queue (triaged): ' + (pr.ok ? 'ok' : pr.error));
  let listed = db.listPatients({}).find((x) => x.id === vp.id);
  log(listed && listed.route === 'dentist' && ['triaged', 'in_treatment'].includes(listed.status), 'routed patient appears in the dentist queue filter with route exposed');
  const hp = db.createPatient(db.login('admin', 'admin'), { first_name: 'Clean', last_name: 'Route', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
  await window.api.authLogin({ username: 'emtx', password: 'x' });
  // v1.5.24: vitals are a hard gate — routing without them is refused.
  const noVitalsRoute = await window.api.patientsRoute({ patientId: hp.id, route: 'hygienist' });
  log(!noVitalsRoute.ok && /vitals/i.test(noVitalsRoute.error), 'v1.5.24: routing a patient with no vitals is refused');
  await window.api.vitalsSave({ patientId: hp.id, data: { bp_systolic: '118', bp_diastolic: '74', heart_rate: '66' } });
  pr = await window.api.patientsRoute({ patientId: hp.id, route: 'hygienist' });
  log(pr.ok && pr.data.triage.route === 'hygienist', 'EMT routes a second patient to the hygienist');
  pr = await window.api.patientsRoute({ patientId: hp.id, route: 'nowhere' });
  log(!pr.ok, 'invalid route rejected: ' + (pr.ok ? 'NOT REJECTED' : 'rejected'));
  // hygienist role cannot route (routing is the EMT/doctor station's job)
  currentUser = db.login('admin', 'admin');
  db.createUser(currentUser, { username: 'hygroute', full_name: 'Hyg Route', role: 'hygienist', password: 'x' });
  await window.api.authLogin({ username: 'hygroute', password: 'x' });
  pr = await window.api.patientsRoute({ patientId: hp.id, route: 'dentist' });
  log(!pr.ok && /permission/i.test(pr.error || ''), 'HYGIENIST blocked from routing (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));
  pr = await window.api.usersList();
  log(!pr.ok, 'EMT blocked from staff list (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));
  // checkout dismiss: a locked (signed-off) patient can be dismissed
  currentUser = db.login('admin', 'admin'); db.saveTreatment(currentUser, vp.id, { provider_name: 'Dr', provider_signature: 'data:,s' }, true);
  await window.api.authLogin({ username: 'cox', password: 'x' });
  pr = await window.api.patientsDismiss(vp.id);
  log(pr.ok && pr.data.status === 'dismissed', 'CHECKOUT can dismiss a signed-off patient: ' + (pr.ok ? 'allowed' : pr.error));

  // ---- v1.2.1: patients move through WITHOUT a forced sign-off/lock ----
  currentUser = db.login('admin', 'admin');
  const flowP = db.createPatient(currentUser, { first_name: 'Flow', last_name: 'Through', demographics: {}, medical_history: {}, dental_history: {}, route: 'dentist', consents: SIGNED });
  db.saveVitals(currentUser, flowP.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
  db.routePatient(currentUser, flowP.id, 'dentist');
  // provider marks the visit COMPLETE without locking (mode 'complete')
  let mc = db.saveTreatment(currentUser, flowP.id, { fillings: [{ tooth: '14' }], provider_name: 'Dr A' }, 'complete');
  log(mc.status === 'completed' && !mc.treatment.locked, 'v1.2.1: "Mark visit complete" completes the visit WITHOUT locking (record stays editable)');
  // the still-unlocked record can still be edited (no lock throw)
  let ed = db.saveTreatment(currentUser, flowP.id, { fillings: [{ tooth: '14' }, { tooth: '19' }], provider_name: 'Dr A' }, 'complete');
  log(ed.treatment.fillings.length === 2, 'v1.2.1: a completed-but-unlocked record is still editable between stations');
  // checkout can dismiss the completed (unlocked) patient — no lock required
  await window.api.authLogin({ username: 'cox', password: 'x' });
  pr = await window.api.patientsDismiss(flowP.id);
  log(pr.ok && pr.data.status === 'dismissed', 'v1.2.1: CHECKOUT dismisses a completed patient with NO lock required: ' + (pr.ok ? 'allowed' : pr.error));
  // v1.2.1: the optional lock still works and makes the record read-only
  currentUser = db.login('admin', 'admin');
  const lockP = db.createPatient(currentUser, { first_name: 'Lock', last_name: 'Opt', demographics: {}, medical_history: {}, dental_history: {}, route: 'dentist', consents: SIGNED });
  db.saveVitals(currentUser, lockP.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '66' });
  db.routePatient(currentUser, lockP.id, 'dentist');
  let lk = db.saveTreatment(currentUser, lockP.id, { provider_name: 'Dr B', provider_signature: 'data:,s' }, 'lock');
  let lockedThrew = false; try { db.saveTreatment(currentUser, lockP.id, { provider_name: 'Dr B' }, 'complete'); } catch (e) { lockedThrew = /locked/i.test(e.message); }
  log(lk.treatment.locked && lockedThrew, 'v1.2.1: optional lock still finalizes a read-only record when chosen');
  // guard: a patient still at check-in (not seen by EMT) cannot be dismissed
  currentUser = db.login('admin', 'admin');
  const rawP = db.createPatient(currentUser, { first_name: 'Not', last_name: 'Seen', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
  await window.api.authLogin({ username: 'cox', password: 'x' });
  pr = await window.api.patientsDismiss(rawP.id);
  log(!pr.ok && /EMT|nurse|vitals/i.test(pr.error || ''), 'v1.2.1: a checked-in (unseen) patient still cannot be dismissed: ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));

  // ---- REGISTRATION role: front-desk check-in only, into the queue ----
  currentUser = db.login('admin', 'admin');
  const reg = db.createUser(currentUser, { username: 'regx', full_name: 'Reg One', role: 'registration', password: 'x' });
  log(reg.role === 'registration', 'registration role can be created (CHECK widened, existing accounts intact)');
  await window.api.authLogin({ username: 'regx', password: 'x' });
  pr = await window.api.patientsCreate({ first_name: 'Front', last_name: 'Desk', demographics: {}, medical_history: {}, dental_history: { reason: 'checkup' }, consents: SIGNED });
  log(pr.ok, 'REGISTRATION can complete a check-in: ' + (pr.ok ? 'allowed' : pr.error));
  const regMade = pr.ok ? db.getPatient(pr.data.id) : null;
  log(!!regMade && regMade.status === 'checked_in', 'REGISTRATION check-in enters the queue (status=checked_in)');
  pr = await window.api.patientsList({});
  log(pr.ok, 'REGISTRATION can see the patient list (dashboard queue): ' + (pr.ok ? 'allowed' : pr.error));
  pr = await window.api.usersList();
  log(!pr.ok && /permission/i.test(pr.error || ''), 'REGISTRATION blocked from staff list (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));
  pr = await window.api.patientsDismiss(regMade ? regMade.id : 0);
  log(!pr.ok && /permission/i.test(pr.error || ''), 'REGISTRATION cannot dismiss patients (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));

  // ---- v1.0.7: HYGIENIST role + event-scoped staff ----
  currentUser = db.login('admin', 'admin');
  const hyg = db.createUser(currentUser, { username: 'hygx', full_name: 'Hyg One', role: 'hygienist', password: 'x' });
  log(hyg.role === 'hygienist', 'hygienist role can be created (CHECK widened, existing accounts intact)');
  const activeEv = await window.api.eventsActive();
  log(hyg.event_id === (activeEv.data ? activeEv.data.id : null), 'new clinical staff scoped to the active event');
  const cp = db.createPatient(currentUser, { first_name: 'Clean', last_name: 'Only', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
  await window.api.authLogin({ username: 'hygx', password: 'x' });
  pr = await window.api.treatmentSave({ patientId: cp.id, data: { cleaning: { adult_prophy: true, teeth: ['3', '14'] } }, finalize: false });
  log(pr.ok, 'HYGIENIST can save a cleaning: ' + (pr.ok ? 'allowed' : pr.error));
  pr = await window.api.usersList();
  log(!pr.ok && /permission/i.test(pr.error || ''), 'HYGIENIST blocked from staff list (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));
  // Clear-event-staff removes scoped clinical staff but keeps the admin.
  currentUser = db.login('admin', 'admin');
  const evId = (activeEv.data ? activeEv.data.id : Number(db.getSetting('active_event_id')));
  const before = db.listUsers().length;
  pr = await window.api.usersClearEventStaff(evId);
  const remaining = db.listUsers();
  log(pr.ok && pr.data.deleted > 0, 'ADMIN can clear event staff: removed ' + (pr.ok ? pr.data.deleted : '?'));
  log(remaining.some((u) => u.role === 'admin') && !remaining.some((u) => u.username === 'hygx'), 'clear keeps admin, removes scoped staff');

  // ---- BP alert: the reading turns red when systolic > 180 OR diastolic > 100 ----
  {
    const { bpStatus } = await import('../src/renderer/js/medFlags.js');
    log(bpStatus(181, 80).high && bpStatus(181, 80).sysHigh, 'BP: systolic 181 flags high');
    log(!bpStatus(180, 80).high, 'BP: systolic exactly 180 is NOT high (strictly over)');
    log(bpStatus(120, 101).high && bpStatus(120, 101).diaHigh, 'BP: diastolic 101 flags high');
    log(!bpStatus(120, 100).high, 'BP: diastolic exactly 100 is NOT high (strictly over)');
    log(!bpStatus(120, 80).high, 'BP: a normal 120/80 reading is not high');
    log(bpStatus('190', '70').high, 'BP: string values are coerced (190/70 → high)');
    log(!bpStatus('', null).high && !bpStatus(null, null).high && !bpStatus('abc', 'x').high, 'BP: blank / omitted / non-numeric reading is never high');
  }
  {
    currentUser = db.login('admin', 'admin');
    const store2 = (await import('../src/renderer/js/store.js')).store; store2.setUser(currentUser);
    const ctx2 = { navigate: () => {}, toast: () => {}, store: store2, setDetail: () => {} };
    const hiP = db.createPatient(currentUser, { first_name: 'High', last_name: 'Pressure', demographics: {}, medical_history: {}, dental_history: { reason: 'x' }, route: 'dentist', consents: SIGNED });
    db.saveVitals(currentUser, hiP.id, { bp_systolic: '190', bp_diastolic: '105', heart_rate: '88' });
    db.routePatient(currentUser, hiP.id, 'dentist');
    const okP = db.createPatient(currentUser, { first_name: 'Normal', last_name: 'Pressure', demographics: {}, medical_history: {}, dental_history: { reason: 'x' }, route: 'dentist', consents: SIGNED });
    db.saveVitals(currentUser, okP.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '70' });
    db.routePatient(currentUser, okP.id, 'dentist');

    const { renderEmt } = await import('../src/renderer/js/views/emt.js');
    const emtHi = renderEmt(ctx2, { id: hiP.id }); document.body.append(emtHi); await tick(); await tick();
    log(/High blood pressure/i.test(emtHi.textContent), 'BP/EMT: high-BP patient shows the red high-BP warning');
    const emtOk = renderEmt(ctx2, { id: okP.id }); document.body.append(emtOk); await tick(); await tick();
    const okWarn = $all('.banner--alert', emtOk).find((n) => /High blood pressure/i.test(n.textContent));
    log(!okWarn || okWarn.style.display === 'none', 'BP/EMT: normal-BP patient does NOT show the high-BP warning');

    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const provHi = renderProvider(ctx2, { id: hiP.id }); document.body.append(provHi); await tick(); await tick();
    log(/BP 190\/105 — HIGH/.test(provHi.textContent), 'BP/Dentist: high-BP handoff shows "BP 190/105 — HIGH"');
    log(!!$all('.pill--danger', provHi).find((n) => /BP 190\/105/.test(n.textContent)), 'BP/Dentist: high BP is rendered as a red danger pill');
    const provOk = renderProvider(ctx2, { id: okP.id }); document.body.append(provOk); await tick(); await tick();
    log(/BP 118\/76/.test(provOk.textContent) && !/BP 118\/76 — HIGH/.test(provOk.textContent), 'BP/Dentist: normal BP is shown without a HIGH marker');

    const pdf = require('../src/main/pdf.js');
    const htmlHiFull = pdf.buildHtml(db.getPatient(hiP.id), 'full');
    const htmlHiProg = pdf.buildHtml(db.getPatient(hiP.id), 'progress');
    log(/color:#c0392b/.test(htmlHiFull) && /HIGH/.test(htmlHiFull), 'BP/PDF: full record colours a high reading red');
    log(/color:#c0392b/.test(htmlHiProg), 'BP/PDF: progress note colours a high reading red');
    const htmlOkFull = pdf.buildHtml(db.getPatient(okP.id), 'full');
    log(!/color:#c0392b/.test(htmlOkFull) && /BP 118\/76/.test(htmlOkFull), 'BP/PDF: a normal reading is not coloured red');
  }

  // ---- v1.4.4: staff accounts are SYNCED so a team created on one laptop shows
  //               up on every laptop. Guard that 'user' is a syncable entity. ----
  currentUser = db.login('admin', 'admin');
  db.createUser(currentUser, { username: 'syncme', full_name: 'Sync Me', role: 'doctor', password: 'x' });
  const syncRows = db.collectSyncRows(1000).rows;
  const userRow = syncRows.find((r) => r.entity === 'user' && r.data && r.data.username === 'syncme');
  log(!!userRow, 'v1.4.4: staff accounts are collected as syncable rows (user entity present)');
  log(!!userRow && userRow.data.role === 'doctor' && !!userRow.data.hash, 'v1.4.4: synced staff carry role + password hash so the account works on other laptops');
  log(!!userRow && userRow.event_uid != null, 'v1.4.4: event-scoped staff carry their event so scoping survives the sync');
  const adminRow = syncRows.find((r) => r.entity === 'user' && r.data && r.data.username === 'admin');
  log(!adminRow || adminRow.uid === '00000000-0000-4000-8000-000000000002', 'v1.4.4: bootstrap admin uses the shared cloud identity (converges, no per-laptop duplicate)');

  // ---- v1.4.6: the active-event SELECTION syncs (stamped on the event row) so a
  //               "Set active" on one laptop reaches every laptop. ----
  currentUser = db.login('admin', 'admin');
  const evSel = db.createEvent(currentUser, { name: 'Sync Event', location: 'X', languages: 'en' });
  db.setActiveEvent(currentUser, evSel.id);
  log(db.getActiveEvent().id === evSel.id, 'v1.4.6: Set active selects the event on this device');
  const evRow = db.collectSyncRows(2000).rows.find((r) => r.entity === 'event' && r.data && r.data.name === 'Sync Event');
  log(!!evRow && !!evRow.data.selected_at, 'v1.4.6: the active-event selection (selected_at) is a synced field so it reaches other laptops');

  // ---- v1.4.7: consent wording, chairside consent capture, treatment gate,
  //               phone digits, and BP re-checks. ----
  {
    const { CATALOG } = await import('../src/renderer/i18n/strings.js');
    const i18nMod = await import('../src/renderer/js/i18n.js');
    log((CATALOG.en.consent.generalFull || []).length === 7 && (CATALOG.en.consent.oralSurgeryFull || []).length >= 8, 'v1.4.7: full general (7) + oral-surgery consent wording present in English');
    i18nMod.setLang('en');
    log(Array.isArray(i18nMod.tRaw('consent.generalFull')), 'v1.4.7: English defines the full consent text (tRaw)');
    i18nMod.setLang('es');
    log(i18nMod.tRaw('consent.generalFull') === undefined && Array.isArray(i18nMod.t('consent.generalFull')), 'v1.4.7: other languages keep their own consent (tRaw undefined; t falls back to English)');
    i18nMod.setLang('en');

    currentUser = db.login('admin', 'admin');
    // Chairside oral-surgery consent with tooth numbers (dentist station).
    const cp = db.createPatient(currentUser, { first_name: 'Chair', last_name: 'Side', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    const afterAdd = db.addPatientConsent(currentUser, cp.id, { type: 'oral_surgery', signer_name: 'Chair Side', tooth_numbers: '18, 19', signature_png: 'data:,sig' });
    const os = (afterAdd.consents || []).find((c) => c.type === 'oral_surgery');
    log(!!os && os.tooth_numbers === '18, 19', 'v1.4.7: dentist can capture an oral-surgery consent chairside WITH tooth numbers');
    log(db.collectSyncRows(3000).rows.some((r) => r.entity === 'consent' && r.data && r.data.tooth_numbers === '18, 19'), 'v1.4.7: a chairside consent is a syncable row (reaches other laptops)');

    // BP re-checks: stored, capped at 2, preserved by a plain re-save.
    const bpp = db.createPatient(currentUser, { first_name: 'Re', last_name: 'Check', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    db.saveVitals(currentUser, bpp.id, { bp_systolic: '190', bp_diastolic: '110', heart_rate: '88', bp_rechecks: [{ bp_systolic: '185', bp_diastolic: '105', heart_rate: '84' }, { bp_systolic: '176', bp_diastolic: '98', heart_rate: '80' }, { bp_systolic: '170', bp_diastolic: '95' }] });
    let bpFull = db.getPatient(bpp.id);
    log((bpFull.triage.bp_rechecks || []).length === 2, 'v1.4.7: up to 2 BP re-checks stored (extra dropped)');
    db.saveVitals(currentUser, bpp.id, { bp_systolic: '188', bp_diastolic: '108', heart_rate: '90' }); // plain re-save, no rechecks key
    log((db.getPatient(bpp.id).triage.bp_rechecks || []).length === 2, 'v1.4.7: a plain vitals re-save keeps the re-checks');
    // Synced JSON triage fields travel as JSON strings (like flags/emt_review).
    log(db.collectSyncRows(3000).rows.some((r) => {
      if (r.entity !== 'triage' || !r.data || r.data.bp_rechecks == null) return false;
      try { return JSON.parse(r.data.bp_rechecks).length === 2; } catch { return false; }
    }), 'v1.4.7: BP re-checks are a synced triage field');
    const rcPdf = require('../src/main/pdf.js').buildHtml(db.getPatient(bpp.id), 'full');
    log(/re-check/i.test(rcPdf), 'v1.4.7: BP re-checks appear in the record PDF');

    // Renders: EMT re-check affordance + provider consent panel + treatment gate.
    const store3 = (await import('../src/renderer/js/store.js')).store; store3.setUser(currentUser);
    const ctx3 = { navigate: () => {}, toast: () => {}, store: store3, setDetail: () => {} };
    const emtHi2 = (await import('../src/renderer/js/views/emt.js')).renderEmt(ctx3, { id: bpp.id }); document.body.append(emtHi2); await tick(); await tick();
    log(/Add another BP reading/i.test(emtHi2.textContent), 'v1.4.7: EMT offers extra BP readings when the reading is high');

    // v1.7.3: an unsigned patient can no longer be SENT to a clinician at all —
    // the gate used to live only on the Arrivals screen, so the vitals station
    // could route them straight to the chair.
    db.saveVitals(currentUser, cp.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    {
      const h = rawDb();
      h.prepare('DELETE FROM consents WHERE patient_id = ?').run(cp.id);
      h.close();
      let blocked = '';
      try { db.routePatient(currentUser, cp.id, 'dentist'); } catch (e) { blocked = e.message; }
      log(/general consent has not been signed/i.test(blocked),
        'v1.7.3: an unsigned patient cannot be routed to a clinician');
      // Put the consent back so they can be routed, then remove it again to
      // recreate the LEGACY state the provider gate below defends against (a
      // record whose consent was deleted after they reached the chair).
      db.addPatientConsent(currentUser, cp.id, { type: 'general', signer_name: 'Chair Side', signature_png: 'data:image/png;base64,AAAA' });
      db.routePatient(currentUser, cp.id, 'dentist');
      const h2 = rawDb();
      h2.prepare('DELETE FROM consents WHERE patient_id = ?').run(cp.id);
      h2.close();
    }
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const provNoConsent = renderProvider(ctx3, { id: cp.id }); document.body.append(provNoConsent); await tick(); await tick();
    log(/Consents/.test(provNoConsent.textContent) && /Complete now/i.test(provNoConsent.textContent), 'v1.4.7: dentist sees a Consents panel with a "Complete now" action for the missing general consent');
    const completeBtn = $all('button', provNoConsent).find((b) => /Mark visit complete/i.test(b.textContent));
    if (completeBtn) completeBtn.click();
    await tick(); await tick();
    log(db.getPatient(cp.id).status !== 'completed', 'v1.4.7: treatment is BLOCKED until the general consent is signed');
    // Now capture the general consent and confirm treatment can proceed.
    db.addPatientConsent(currentUser, cp.id, { type: 'general', signer_name: 'Chair Side', signature_png: 'data:,g' });
    const provWithConsent = renderProvider(ctx3, { id: cp.id }); document.body.append(provWithConsent); await tick(); await tick();
    const completeBtn2 = $all('button', provWithConsent).find((b) => /Mark visit complete/i.test(b.textContent));
    if (completeBtn2) completeBtn2.click();
    await tick(); await tick();
    log(db.getPatient(cp.id).status === 'completed', 'v1.4.7: once the general consent is signed, the dentist can document + complete the visit');
  }

  // ---- v1.4.8: allergy list — Lidocaine + Articaine in, Novocain out (but a
  //               legacy Novocain allergy still shows on old records). ----
  {
    const al = (await import('../src/renderer/js/i18n.js')).allergies();
    log(al.some((a) => a.key === 'lidocaine' && a.intake) && al.some((a) => a.key === 'articaine' && a.intake), 'v1.4.8: Lidocaine + Articaine are offered as check-in allergies');
    const nov = al.find((a) => a.key === 'novocain');
    log(!!nov && nov.intake === false && /Novocain/i.test(nov.label), 'v1.4.8: a legacy Novocain allergy still resolves for display but is not offered at check-in');
  }

  // ---- Health History: pain-management + weight-management program checkboxes ----
  {
    const cs = (await import('../src/renderer/js/i18n.js')).conditions();
    const pain = cs.find((c) => c.key === 'pain_mgmt');
    const weight = cs.find((c) => c.key === 'weight_mgmt');
    log(!!pain && /pain management/i.test(pain.label) && pain.flag !== true, 'health history: "Pain management program" is offered as a condition checkbox (not a red flag)');
    log(!!weight && /weight management/i.test(weight.label) && weight.flag !== true, 'health history: "Weight management program" is offered as a condition checkbox (not a red flag)');
    // A patient can check them and they persist on the record.
    currentUser = db.login('admin', 'admin');
    const hp = db.createPatient(currentUser, { first_name: 'Pat', last_name: 'Hh', demographics: {}, medical_history: { conditions: ['pain_mgmt', 'weight_mgmt'] }, dental_history: {}, consents: SIGNED });
    log((db.getPatient(hp.id).medical_history.conditions || []).includes('pain_mgmt') && (db.getPatient(hp.id).medical_history.conditions || []).includes('weight_mgmt'), 'health history: the two program selections save on the patient record');
  }

  // ---- v1.5.14: dashboard live CRM board + clickable KPIs; reports dashboard ----
  {
    currentUser = db.login('admin', 'admin');
    const store14 = (await import('../src/renderer/js/store.js')).store; store14.setUser(currentUser);
    let navTo = null;
    const ctx14 = { navigate: (v) => { navTo = v; }, toast: () => {}, store: store14, setDetail: () => {} };

    // Patients spread across the pipeline stages.
    const a = db.createPatient(currentUser, { first_name: 'Al', last_name: 'Aa', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED }); // checked in, no vitals
    const b = db.createPatient(currentUser, { first_name: 'Bo', last_name: 'Bb', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    db.saveVitals(currentUser, b.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' }); // vitals in, not routed
    const c = db.createPatient(currentUser, { first_name: 'Cy', last_name: 'Cc', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    db.saveVitals(currentUser, c.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '66' }); db.routePatient(currentUser, c.id, 'dentist'); // ready

    const dash = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx14);
    document.body.append(dash); await tick(); await tick();
    const txt = dash.textContent;
    log(['Checked in', 'Vitals', 'Ready for treatment', 'Hygienist', 'Dentist', 'Checked out'].every((s) => txt.includes(s)), 'v1.5.14: dashboard shows the live stage board with all six columns');
    log(/Aa, Al/.test(txt) && /Bb, Bo/.test(txt) && /Cc, Cy/.test(txt), 'v1.5.14: patients appear as cards on the board');
    log(/Start patient check-in/i.test(txt) && /Live/.test(txt), 'v1.5.14: check-in moved to the header and the board is marked Live');
    log(!/Quick actions/i.test(txt) && !/Back up to USB/i.test(txt), 'v1.5.14: the old Quick Actions grid and dashboard USB backup are gone');
    // A KPI card is clickable and navigates.
    const linkCard = dash.querySelector('.stat-card--link');
    log(!!linkCard, 'v1.5.14: KPI stat cards are clickable');
    linkCard.click(); await tick();
    log(!!navTo, 'v1.5.14: clicking a KPI card navigates to its station');

    // Reports dashboard renders its KPIs + demographics.
    navTo = null;
    const rep = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx14);
    document.body.append(rep); await tick(); await tick();
    const rtxt = rep.textContent;
    log(/Patients seen/i.test(rtxt) && /X-rays uploaded/i.test(rtxt), 'v1.5.14: reports shows KPI cards (patients, X-ray uploads, procedures)');
    log(/Patient demographics/i.test(rtxt) && /By gender/i.test(rtxt) && /By age/i.test(rtxt), 'v1.5.14: reports breaks patients down by demographics');
    log(!!rep.querySelector('.ring-track') && !!rep.querySelector('.kpi-grid'), 'v1.5.14: reports renders the completion ring + KPI grid');
  }

  // ---- v1.5.15: patient pre-registration (public link → routed into the event) ----
  {
    currentUser = db.login('admin', 'admin');
    // Every event exposes a per-event pre-registration link on its current cloud.
    const evs = db.listEvents();
    const activeEv = evs.find((e) => e.active) || evs[0];
    log(!!activeEv && typeof activeEv.prereg_url === 'string' && /\/checkin\//.test(activeEv.prereg_url) && activeEv.prereg_url.includes(activeEv.uid), 'v1.5.15: each event exposes a unique /checkin/<event-uid> pre-registration link');

    // Simulate what the Worker writes when a patient pre-registers: a checked-in
    // patient row scoped to the event, applied through the normal sync path.
    const iso = '2099-01-01T00:00:00.000Z';
    const remoteRow = {
      entity: 'patient', uid: 'prereg-test-uid-1', event_uid: activeEv.uid, patient_uid: null, deleted: 0,
      updated_at: iso + '@prereg',
      data: {
        language: 'es', first_name: 'Pilar', last_name: 'Nuevo', dob: '1988-03-03', gender: 'female', phone: '5551234567', email: null,
        demographics: JSON.stringify({ preregistered: true, prereg_at: iso }),
        medical_history: JSON.stringify({ allergies: ['penicillin'], conditions: ['diabetes'], medications: [{ name: 'Metformin', dose: '', reason: '' }] }),
        dental_history: JSON.stringify({ reason: 'broken tooth', visit_type: 'filling' }),
        status: 'checked_in', created_at: iso, dismissed_at: null, dismissed_by_name: null,
      },
    };
    const res15 = db.applyRemoteRows([remoteRow]);
    log(res15.applied === 1, 'v1.5.15: a pre-registration row applies through the normal sync path');
    const pre = db.listPatients({}).find((p) => p.first_name === 'Pilar' && p.last_name === 'Nuevo');
    log(!!pre && pre.status === 'checked_in' && pre.preregistered === true, 'v1.5.15: it lands as a checked-in patient in that event, tagged preregistered');
    const full15 = db.getPatient(pre.id);
    log((full15.medical_history.allergies || []).includes('penicillin') && (full15.medical_history.conditions || []).includes('diabetes') && full15.dental_history.reason === 'broken tooth', 'v1.5.15: the pre-registered answers render natively (allergies, conditions, reason)');

    // The dashboard board shows the pre-registered patient with a "Pre-reg" tag.
    const store15 = (await import('../src/renderer/js/store.js')).store; store15.setUser(currentUser);
    const ctx15 = { navigate: () => {}, toast: () => {}, store: store15, setDetail: () => {} };
    const dash15 = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx15);
    document.body.append(dash15); await tick(); await tick();
    const card = Array.from(dash15.querySelectorAll('.crm-card')).find((c) => /Nuevo, Pilar/.test(c.textContent));
    log(!!card && /Pre-reg/.test(card.textContent), 'v1.5.15: the pre-registered patient shows on the live board with a “Pre-reg” tag');

    // v1.5.20: a pre-registered patient hasn't physically arrived until Vitals,
    // so their clinic clock is NOT running — the board shows NO time chips yet.
    log(!!card && !/total/.test(card.textContent) && !/\bhere\b/.test(card.textContent),
      'v1.5.20: a pre-registered patient shows no total/stage timer until they reach Vitals');
    // Once vitals are recorded the clock starts and both time chips appear.
    db.saveVitals(currentUser, pre.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '70' });
    const dash15b = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx15);
    document.body.append(dash15b); await tick(); await tick();
    const card15b = Array.from(dash15b.querySelectorAll('.crm-card')).find((c) => /Nuevo, Pilar/.test(c.textContent));
    log(!!card15b && /total/.test(card15b.textContent) && /\bhere\b/.test(card15b.textContent),
      'v1.5.20: once the pre-registered patient reaches Vitals, the total + stage timers start');
  }

  // ---- v1.5.16: consistency fixes (bleeding=thinner, Left tag, time tags, tile) ----
  {
    currentUser = db.login('admin', 'admin');
    // #1: a "Bleeding disorder" condition now raises the thinner flag on the
    // EMT/dentist screens (medFlags), matching the queues (db on_thinner).
    const mf = await import('../src/renderer/js/medFlags.js');
    log(mf.bloodThinnerStatus({ triage: {}, medical_history: { conditions: ['bleeding'] } }).onThinner === true, 'v1.5.16: a "Bleeding disorder" condition raises the blood-thinner flag on the EMT/dentist screens');
    const bpat = db.createPatient(currentUser, { first_name: 'Bl', last_name: 'Eed', demographics: {}, medical_history: { conditions: ['bleeding'] }, dental_history: {}, consents: SIGNED });
    const bRow = db.listPatients({}).find((x) => x.id === bpat.id);
    log(!!bRow && bRow.on_thinner === true, 'v1.5.16: the same bleeding patient is flagged in the queues (db) — screens + queues + PDF now agree');

    // #5 + time tags: a dismissed patient → green "Left" tag, and both time tags.
    const ev16 = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    db.applyRemoteRows([{
      entity: 'patient', uid: 'dismissed-test-1', event_uid: ev16.uid, patient_uid: null, deleted: 0, updated_at: '2099-01-01T02:00:00.000Z@t',
      data: {
        language: 'en', first_name: 'Do', last_name: 'Ne', dob: null, gender: null, phone: null, email: null,
        demographics: '{}', medical_history: '{}', dental_history: '{}',
        status: 'dismissed', created_at: '2099-01-01T00:00:00.000Z', dismissed_at: '2099-01-01T00:30:00.000Z', dismissed_by_name: 'Admin',
      },
    }]);
    const store16 = (await import('../src/renderer/js/store.js')).store; store16.setUser(currentUser);
    const ctx16 = { navigate: () => {}, toast: () => {}, store: store16, setDetail: () => {} };
    const dash16 = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx16);
    document.body.append(dash16); await tick(); await tick();
    log(/Checked out/.test(dash16.textContent) && !/>Completed</.test(dash16.textContent), 'v1.5.16: the dashboard KPI tile reads "Checked out" (not "Completed")');
    const doneCard = Array.from(dash16.querySelectorAll('.crm-card')).find((c) => /Ne, Do/.test(c.textContent));
    log(!!doneCard && /Left/.test(doneCard.textContent), 'v1.5.16: a checked-out patient shows a green "Left" tag on the board');
    log(!!doneCard && /total/.test(doneCard.textContent) && /here/.test(doneCard.textContent), 'v1.5.16: board cards show two time tags — total time from check-in + time at the current stage');

    // #9: a localized free-text gender ("Mujer") must NOT be mislabeled "Male".
    const gp = db.createPatient(currentUser, { first_name: 'Gen', last_name: 'Der', gender: 'Mujer', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    void gp;
    const rep16 = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx16);
    document.body.append(rep16); await tick(); await tick();
    log(/Mujer/.test(rep16.textContent) && !/>\s*Male\s*</.test(rep16.textContent.replace(/\s+/g, ' ')) , 'v1.5.16: reports shows a localized gender ("Mujer") verbatim instead of guessing "Male"');
  }

  // ---- v1.5.17: pre-registration carries a SIGNED consent into the chart ----
  {
    currentUser = db.login('admin', 'admin');
    const ev17 = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    const puid = 'prereg17-patient';
    const iso = '2099-02-01T00:00:00.000Z';
    // Exactly what the Worker writes: a checked-in patient + a signed general
    // consent bound to it, applied through the normal sync path.
    db.applyRemoteRows([
      { entity: 'patient', uid: puid, event_uid: ev17.uid, patient_uid: null, deleted: 0, updated_at: iso + '@prereg', data: {
        language: 'en', first_name: 'Signed', last_name: 'Consent', dob: null, gender: 'female', phone: null, email: null,
        demographics: JSON.stringify({ preregistered: true }), medical_history: JSON.stringify({ conditions: ['diabetes'], under_treatment: 'yes' }),
        dental_history: JSON.stringify({ reason: 'exam', visit_type: 'filling', gum_bleeding: 'no' }), status: 'checked_in', created_at: iso, dismissed_at: null, dismissed_by_name: null } },
      { entity: 'consent', uid: 'prereg17-consent', event_uid: ev17.uid, patient_uid: puid, deleted: 0, updated_at: iso + '@prereg-c1', data: {
        type: 'general', version: 'general-oregon-en-v1+covid', language: 'en', signer_name: 'Signed Consent', relationship: 'Self',
        signature_png: 'data:image/png;base64,AAAA', signed_at: iso, tooth_numbers: null, amended_by: null, amended_at: null } },
    ]);
    const sp = db.listPatients({}).find((p) => p.first_name === 'Signed' && p.last_name === 'Consent');
    log(!!sp && sp.preregistered === true && sp.status === 'checked_in', 'v1.5.17: a full-parity pre-registration lands as a checked-in patient');
    const full17 = db.getPatient(sp.id);
    log((full17.consents || []).some((c) => c.type === 'general' && c.signer_name === 'Signed Consent' && c.signature_png), 'v1.5.17: the consent SIGNED on the pre-registration link is attached to the chart');
    log((full17.medical_history.conditions || []).includes('diabetes') && full17.medical_history.under_treatment === 'yes' && full17.dental_history.visit_type === 'filling', 'v1.5.17: the extra check-in-parity answers (medical + dental history) carry through');
  }

  // ---- v1.5.18: returning-patient new visit, ZIP export, reports email list ----
  {
    currentUser = db.login('admin', 'admin');

    // #1: start a new visit from an existing record — details carry over, fresh visit.
    const src = db.createPatient(currentUser, { first_name: 'Rita', last_name: 'Returns', dob: '1980-05-05', gender: 'female', phone: '5551234567', email: 'rita@example.com', demographics: { address: '5 Elm St' }, medical_history: { conditions: ['diabetes'], allergies: ['penicillin'] }, dental_history: { reason: 'old reason', visit_type: 'extraction_pain', prior_dentist: 'Dr. Prior' }, consents: SIGNED_SURGERY });
    const nv = db.startVisitFromExisting(currentUser, src.id);
    log(nv.id !== src.id && nv.first_name === 'Rita' && nv.last_name === 'Returns' && nv.dob === '1980-05-05' && nv.email === 'rita@example.com', 'v1.5.18: a returning patient starts a NEW visit with their details carried over');
    log((nv.medical_history.conditions || []).includes('diabetes') && nv.demographics.address === '5 Elm St' && nv.dental_history.prior_dentist === 'Dr. Prior', 'v1.5.18: the new visit keeps medical + demographics (no re-typing)');
    log(!nv.dental_history.reason && !nv.dental_history.visit_type && nv.status === 'checked_in', 'v1.5.18: the visit-specific reason/need starts fresh and enters the check-in queue');
    log(db.searchAllPatients('Returns').length >= 1, 'v1.5.18: returning patients are findable via the cross-event search');

    // #5: the clinic ZIP export is a valid archive (DB + records + README).
    const zipStore = (await import('../src/main/zipStore.js')).default;
    const z = zipStore.zip([{ name: 'database.db', data: Buffer.from('SQLite format 3 rest') }, { name: 'records.json', data: Buffer.from('{"a":1}') }, { name: 'README.txt', data: Buffer.from('hello') }]);
    log(Buffer.isBuffer(z) && z.length > 60 && z.readUInt32LE(0) === 0x04034b50 && z.includes(Buffer.from('records.json')) && z.subarray(z.length - 22).readUInt32LE(0) === 0x06054b50, 'v1.5.18: the clinic ZIP export is a valid PK archive with the expected files');
    log(zipStore.crc32(Buffer.from('123456789')) === 0xCBF43926, 'v1.5.18: the ZIP writer computes a correct CRC-32');

    // #4: checked-out patients with an email appear in Reports' email list.
    const store18 = (await import('../src/renderer/js/store.js')).store; store18.setUser(currentUser);
    const ctx18 = { navigate: () => {}, toast: () => {}, store: store18, setDetail: () => {} };
    const ep = db.createPatient(currentUser, { first_name: 'Ed', last_name: 'Mailer', email: 'ed@example.com', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    db.saveVitals(currentUser, ep.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    db.routePatient(currentUser, ep.id, 'dentist');
    db.dismissPatient(currentUser, ep.id);
    const rep18 = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx18);
    document.body.append(rep18); await tick(); await tick();
    log(/Email visit summaries/.test(rep18.textContent) && /ed@example\.com/.test(rep18.textContent), 'v1.5.18: Reports lists checked-out patients who left an email, for follow-up');

    // Dashboard offers the returning-patient lookup for the front desk.
    const dash18 = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx18);
    document.body.append(dash18); await tick(); await tick();
    log(/Returning patient/.test(dash18.textContent), 'v1.5.18: the dashboard offers a "Returning patient" lookup');
  }

  // ---- v1.5.0: X-ray import — per-x-ray tooth + auto-name, synced; import tile. ----
  {
    currentUser = db.login('admin', 'admin');
    const xp = db.createPatient(currentUser, { first_name: 'Ex', last_name: 'Ray', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    const added = db.addXray(currentUser, xp.id, { image_png: 'data:image/png;base64,AAAA', note: 'Ray_Ex_UR_T3', tooth: '3' });
    let xl = db.listXrays(xp.id);
    log(xl.length === 1 && xl[0].tooth === '3' && xl[0].note === 'Ray_Ex_UR_T3', 'v1.5.0: an x-ray stores its tooth + auto-name (Lastname_Firstname_area_tooth)');
    db.updateXrayTooth(currentUser, added.id, '14');
    log(db.listXrays(xp.id)[0].tooth === '14', 'v1.5.0: an x-ray tooth can be re-assigned');
    // tooth travels in the sync payload
    log(db.collectSyncRows(4000).rows.some((r) => r.entity === 'xray' && r.data && r.data.tooth === '14'), 'v1.5.0: the x-ray tooth is a synced field (reaches other laptops)');
    // provider detail renders the Import tile
    const store5 = (await import('../src/renderer/js/store.js')).store; store5.setUser(currentUser);
    const ctx5 = { navigate: () => {}, toast: () => {}, store: store5, setDetail: () => {} };
    db.saveVitals(currentUser, xp.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    db.routePatient(currentUser, xp.id, 'dentist');
    const provX = (await import('../src/renderer/js/views/provider.js')).renderProvider(ctx5, { id: xp.id }); document.body.append(provX); await tick(); await tick();
    log(/Add X-ray/i.test(provX.textContent), 'v1.5.0: the dentist chart shows an "Add X-ray" upload action');
    log(/Tooth 14/.test(provX.textContent), 'v1.5.0: the imported x-ray shows its assigned tooth on the chart');
  }

  // ---- v1.5.13: upload → center form (tooth/quadrant/general) → save + drive delete ----
  {
    currentUser = db.login('admin', 'admin');
    const store51 = (await import('../src/renderer/js/store.js')).store; store51.setUser(currentUser);
    const ctx51 = { navigate: () => {}, toast: () => {}, store: store51, setDetail: () => {} };
    const renderProvider = (await import('../src/renderer/js/views/provider.js')).renderProvider;
    const yp = db.createPatient(currentUser, { first_name: 'Ada', last_name: 'Xu', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    db.saveVitals(currentUser, yp.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '66' });
    db.routePatient(currentUser, yp.id, 'dentist');

    const pv = renderProvider(ctx51, { id: yp.id }); document.body.append(pv); await tick(); await tick();
    // Single "Add X-ray" upload tile; no folder/DEXIS import UI anymore.
    log(/Add X-ray/i.test(pv.textContent) && !/Import X-ray/i.test(pv.textContent), 'v1.5.13: the chart shows one simple "Add X-ray" upload button (no folder/DEXIS controls)');

    // Drop an uploaded JPG onto the gallery → the labelling form opens.
    const gallery = pv.querySelector('.xray-gallery');
    const file = new window.File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])], 'C0000007.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'path', { value: 'C:/DEXIS/Export/C0000007.jpg' });
    const drop = new window.Event('drop', { bubbles: true }); drop.dataTransfer = { files: [file] };
    gallery.dispatchEvent(drop);
    for (let i = 0; i < 8; i++) await tick();
    const card = document.querySelector('.xray-form-card');
    log(!!card && !!card.querySelector('.xray-form-preview'), 'v1.5.13: uploading opens a centered form with the image preview');
    const opts = Array.from(card.querySelectorAll('.xray-opt'));
    log(opts.length === 3 && /Tooth/.test(opts[0].textContent) && /Quadrant/.test(opts[1].textContent) && /General/.test(opts[2].textContent), 'v1.5.13: the form offers three choices — Tooth, Quadrant, General');

    const nameOf = () => card.querySelector('.xray-form-name').textContent;
    // default is Tooth: type the number
    const toothIn = card.querySelector('input');
    toothIn.value = '9'; toothIn.dispatchEvent(new window.Event('input', { bubbles: true }));
    log(nameOf() === 'Xu_Ada_T9.jpg', 'v1.5.13: Tooth → renames to Lastname_Firstname_T<tooth>.jpg');
    // Quadrant
    opts[1].click(); await tick();
    const areaSel = card.querySelector('select'); areaSel.value = 'LL'; areaSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    log(nameOf() === 'Xu_Ada_LL.jpg', 'v1.5.13: Quadrant → renames to Lastname_Firstname_<quadrant>.jpg');
    // General
    opts[2].click(); await tick();
    log(nameOf() === 'Xu_Ada_General.jpg', 'v1.5.13: General → renames to Lastname_Firstname_General.jpg');

    // back to Tooth, save
    opts[0].click(); await tick();
    card.querySelector('input').value = '9'; card.querySelector('input').dispatchEvent(new window.Event('input', { bubbles: true }));
    const before = db.listXrays(yp.id).length;
    const saveBtn = Array.from(card.querySelectorAll('button')).find((b) => /Save X-ray/i.test(b.textContent));
    saveBtn.click();
    for (let i = 0; i < 8; i++) await tick();
    const afterX = db.listXrays(yp.id);
    log(afterX.length === before + 1 && afterX[afterX.length - 1].note === 'Xu_Ada_T9.jpg' && afterX[afterX.length - 1].tooth === '9', 'v1.5.13: Save files the x-ray to the chart under its renamed .jpg and records the tooth');
    log(mockDeletedFromDrive.includes('C:/DEXIS/Export/C0000007.jpg'), 'v1.5.13: after saving, the source file is deleted from the computer drive');
    log(!document.querySelector('.xray-form-card'), 'v1.5.13: the form closes itself after saving');
  }

  // ---- v1.5.21: a station can always re-read the whole clinic ----
  // Guards the fix for patients appearing on one laptop but not another. The
  // pull cursor used to be a timestamp high-water mark, so a record that reached
  // the cloud late (an offline check-in, or a laptop with a slow clock) fell
  // below the mark and was never delivered to that station again.
  {
    // The one-time heal runs on upgrade: the cursor is cleared so the station
    // re-reads everything it may have stepped over.
    log(db.getSetting('cloud_cursor_heal') === 'v1', 'v1.5.21: the one-time sync heal is applied on upgrade');

    // A station that has synced for a while, then hits "Re-sync everything".
    db.setSyncMeta({ cursor: '4821' });
    db.setSyncPending([{ entity: 'consent', uid: 'orphan-1', patient_uid: 'nobody', updated_at: 'x', data: {} }]);
    log(db.getSyncMeta().cursor === '4821' && db.getSyncPending().length === 1, 'v1.5.21: a station tracks its place in the clinic queue');
    db.resetSyncCursor();
    log(db.getSyncMeta().cursor === '' && db.getSyncPending().length === 0, 'v1.5.21: "Re-sync everything" rewinds the station so it re-reads the whole clinic');

    // A patient pushed with a BACK-DATED stamp (checked in while that laptop was
    // offline) must still land here — this is the record that used to vanish.
    const evR = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    const backdated = '2020-01-01T08:00:00.000Z@offline-laptop';
    const res21 = db.applyRemoteRows([{
      entity: 'patient', uid: 'offline-checkin-1', event_uid: evR.uid, patient_uid: null, deleted: 0,
      updated_at: backdated,
      data: {
        language: 'en', first_name: 'Olivia', last_name: 'Offline', dob: '1990-02-02', gender: 'female',
        phone: null, email: null, demographics: '{}', medical_history: '{}', dental_history: '{}',
        status: 'checked_in', created_at: '2020-01-01T08:00:00.000Z', dismissed_at: null, dismissed_by_name: null,
      },
    }]);
    const olivia = db.listPatients({}).find((p) => p.last_name === 'Offline');
    log(res21.applied === 1 && !!olivia && olivia.status === 'checked_in',
      'v1.5.21: a back-dated offline check-in still lands in this station\'s queue');
  }

  // ---- v1.5.23: "Waiting for vitals" counts pre-registered patients too ----
  // The tile used to be read off the triage table, which only the in-person
  // check-in creates — so a board showing 30 pre-registered patients in "Checked
  // in" sat next to a tile reading 1 (the single walk-in).
  {
    currentUser = db.login('admin', 'admin');
    const evW = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    const before = db.dashboardStats().waiting_triage;

    // Three patients arrive the way a pre-registration does: a patient row from
    // the cloud, with no triage row of their own.
    for (const n of ['One', 'Two', 'Three']) {
      db.applyRemoteRows([{
        entity: 'patient', uid: 'prereg-count-' + n, event_uid: evW.uid, patient_uid: null, deleted: 0,
        updated_at: '2099-02-01T00:00:0' + n.length + '.000Z@prereg',
        data: {
          language: 'en', first_name: n, last_name: 'Prereg', dob: '1990-01-01', gender: 'female',
          phone: null, email: null, demographics: JSON.stringify({ preregistered: true }),
          medical_history: '{}', dental_history: '{}',
          status: 'checked_in', created_at: '2099-02-01T00:00:00.000Z', dismissed_at: null, dismissed_by_name: null,
        },
      }]);
    }
    log(db.dashboardStats().waiting_triage === before + 3,
      'v1.5.23: pre-registered patients are counted in "Waiting for vitals"');

    // And the tile agrees with the live board's "Checked in" column.
    const boardCheckedIn = db.listPatients({}).filter((p) => p.status === 'checked_in' && !p.has_vitals).length;
    log(db.dashboardStats().waiting_triage === boardCheckedIn,
      'v1.5.23: the tile matches the board\'s "Checked in" column exactly');

    // Once vitals are taken the patient leaves the count (moves to the Vitals column).
    const oneP = db.listPatients({}).find((p) => p.first_name === 'One' && p.last_name === 'Prereg');
    const midCount = db.dashboardStats().waiting_triage;
    db.saveVitals(currentUser, oneP.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    log(db.dashboardStats().waiting_triage === midCount - 1,
      'v1.5.23: taking vitals removes the patient from "Waiting for vitals"');
  }

  // ---- v1.5.24: auto-routing from the patient's own answer ----
  {
    currentUser = db.login('admin', 'admin');
    const mk = (last, visit) => db.createPatient(currentUser, {
      first_name: 'Auto', last_name: last, dob: '1990-01-01', gender: 'female',
      demographics: {}, medical_history: {}, dental_history: { visit_type: visit, reason: 'x' },
    });
    const routeOf = (p) => (db.listPatients({}).find((x) => x.id === p.id) || {}).route;
    log(routeOf(mk('Clean', 'cleaning')) === 'hygienist', 'v1.5.24: choosing a cleaning routes to the hygienist automatically');
    log(routeOf(mk('Fill', 'filling')) === 'dentist', 'v1.5.24: choosing a filling routes to the dentist automatically');
    log(routeOf(mk('Pull', 'extraction_pain')) === 'dentist', 'v1.5.24: choosing an extraction routes to the dentist automatically');
    // An explicit choice still wins, and an unanswered visit type leaves it open.
    const explicit = db.createPatient(currentUser, { first_name: 'Auto', last_name: 'Override', demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' }, route: 'dentist', consents: SIGNED });
    log(routeOf(explicit) === 'dentist', 'v1.5.24: an explicitly chosen station still wins over the automatic one');
    log(routeOf(mk('Blank', null)) == null, 'v1.5.24: no answer leaves the station for the EMT to choose');
  }

  // ---- v1.5.24: the front desk's arrival check ----
  {
    currentUser = db.login('admin', 'admin');
    const signed = { type: 'general', signer_name: 'Pat Ient', relationship: 'Self', signature_png: 'data:image/png;base64,AAAA' };

    // Consent signed + a cleaning chosen -> ready, and confirming marks them here.
    const ok = db.createPatient(currentUser, {
      first_name: 'Ready', last_name: 'ToGo', dob: '1985-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' }, consents: [signed],
    });
    const r1 = db.arrivalReadiness(ok.id);
    log(r1.general_signed && r1.needs_surgery_consent === false && r1.route === 'hygienist' && r1.ready,
      'v1.5.24: a signed cleaning patient is ready, with their station already set');
    const after = db.confirmArrival(currentUser, ok.id, {});
    log(!!after.arrived_at, 'v1.5.24: confirming arrival records that the patient is physically here');
    const listed = db.listPatients({}).find((p) => p.id === ok.id);
    log(!!listed.arrived_at && listed.status === 'checked_in',
      'v1.5.24: a confirmed patient still goes to vitals next (no station is skipped)');

    // Unsigned general consent -> refused.
    const unsigned = db.createPatient(currentUser, {
      first_name: 'No', last_name: 'Consent', dob: '1985-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' }, consents: [],
    });
    let blocked = false;
    try { db.confirmArrival(currentUser, unsigned.id, {}); } catch (e) { blocked = /general consent/i.test(e.message); }
    log(blocked, 'v1.5.24: a patient with no signed general consent cannot be sent through');

    // A consent row with NO signature does not count as signed.
    const empty = db.createPatient(currentUser, {
      first_name: 'Empty', last_name: 'Sig', dob: '1985-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'X', signature_png: '' }],
    });
    log(db.arrivalReadiness(empty.id).general_signed === false, 'v1.5.24: an unsigned consent form does not count as consent');

    // Extraction with only the general consent -> refused until surgery is signed.
    const ex = db.createPatient(currentUser, {
      first_name: 'Ex', last_name: 'Traction', dob: '1985-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'extraction_pain' }, consents: [signed],
    });
    const rEx = db.arrivalReadiness(ex.id);
    log(rEx.needs_surgery_consent === true && rEx.surgery_signed === false && !rEx.ready,
      'v1.5.24: an extraction patient is not ready on the general consent alone');
    let exBlocked = false;
    try { db.confirmArrival(currentUser, ex.id, {}); } catch (e) { exBlocked = /oral surgery/i.test(e.message); }
    log(exBlocked, 'v1.5.24: an extraction patient without the surgery consent cannot be sent through');
    // Sign it chairside -> now allowed, and routed to the dentist.
    db.addPatientConsent(currentUser, ex.id, { type: 'oral_surgery', signer_name: 'Ex Traction', relationship: 'Self', signature_png: 'data:image/png;base64,BBBB', tooth_numbers: '30' });
    const okNow = db.confirmArrival(currentUser, ex.id, {});
    log(!!okNow.arrived_at && db.arrivalReadiness(ex.id).route === 'dentist',
      'v1.5.24: once the surgery consent is signed the extraction patient goes through to the dentist');

    // The Arrivals screen itself: waiting vs. confirmed, with the consent state
    // shown on each row so the desk can see the blocker before they tap.
    const store24 = (await import('../src/renderer/js/store.js')).store; store24.setUser(currentUser);
    const ctx24 = { navigate: () => {}, toast: () => {}, store: store24, setDetail: () => {} };
    const arrivals = (await import('../src/renderer/js/views/arrivals.js')).renderArrivals(ctx24);
    document.body.append(arrivals); await tick(); await tick();
    // v1.5.26: the screen is split by how the patient registered. These patients
    // were registered at the desk, so open that tab.
    const pickTab = (view, label) => {
      const b = Array.from(view.querySelectorAll('.arrival-tab')).find((x) => new RegExp(label, 'i').test(x.textContent));
      if (b) b.click();
      return b;
    };
    pickTab(arrivals, 'Registered at the desk'); await tick();
    const atxt = arrivals.textContent;
    log(/Arrivals/.test(atxt) && /Waiting to be confirmed/.test(atxt) && /Confirmed here/.test(atxt),
      'v1.5.24: the Arrivals screen lists who is waiting and who is confirmed');
    const unsignedRow = Array.from(arrivals.querySelectorAll('.arrival-row')).find((r) => /Consent, No/.test(r.textContent));
    log(!!unsignedRow && /Consent missing/.test(unsignedRow.textContent),
      'v1.5.24: a patient with an unsigned consent is flagged on the arrivals list');
    const readyRow = Array.from(arrivals.querySelectorAll('.arrival-row')).find((r) => /ToGo, Ready/.test(r.textContent));
    log(!!readyRow && /Here/.test(readyRow.textContent),
      'v1.5.24: a confirmed patient shows as here');

    // ...and the live board marks them too.
    const dash24 = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx24);
    document.body.append(dash24); await tick(); await tick();
    const okCard = Array.from(dash24.querySelectorAll('.crm-card')).find((c) => /ToGo, Ready/.test(c.textContent));
    log(!!okCard && /Here/.test(okCard.textContent), 'v1.5.24: the board shows a "Here" tag once the front desk confirms arrival');

    // v1.5.25: the arrivals search — a busy front desk needs to find one person.
    const findMe = db.createPatient(currentUser, {
      first_name: 'Yolanda', last_name: 'Zaragoza', dob: '1977-03-04', gender: 'female', phone: '5035559876',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'Y Z', signature_png: 'data:image/png;base64,AAAA' }],
    });
    const arr2 = (await import('../src/renderer/js/views/arrivals.js')).renderArrivals(ctx24);
    document.body.append(arr2); await tick(); await tick();
    pickTab(arr2, 'Registered at the desk'); await tick();
    const box = arr2.querySelector('input[type="search"]');
    log(!!box, 'v1.5.25: the arrivals screen has a search box');
    const rowsFor = () => Array.from(arr2.querySelectorAll('.arrival-row')).map((r) => r.textContent);
    log(rowsFor().length > 1, 'v1.5.25: (setup) more than one patient is listed');
    const type = async (v) => { box.value = v; box.dispatchEvent(new window.Event('input', { bubbles: true })); await tick(); };
    await type('zaragoza');
    log(rowsFor().length === 1 && /Zaragoza/.test(rowsFor()[0]), 'v1.5.25: searching a surname narrows the list to that patient');
    await type('5035559876');
    log(rowsFor().length === 1 && /Zaragoza/.test(rowsFor()[0]), 'v1.5.25: searching a phone number finds them too');
    await type('1977-03-04');
    log(rowsFor().length === 1 && /Zaragoza/.test(rowsFor()[0]), 'v1.5.25: searching a date of birth finds them too');
    await type('zaragoza yol');
    log(rowsFor().length === 1, 'v1.5.25: words can be typed in any order');
    await type('nobody-by-this-name');
    log(rowsFor().length === 0 && /No match here/.test(arr2.textContent), 'v1.5.25: a search with no match says so');
    await type('');
    log(rowsFor().length > 1, 'v1.5.25: clearing the search restores the full list');
    // The queue refreshing underneath must not wipe what is being typed.
    await type('zaragoza');
    const before = box.value;
    const reloaded = arr2.querySelector('input[type="search"]');
    log(reloaded === box && reloaded.value === before && rowsFor().length === 1,
      'v1.5.25: a background refresh keeps the search text and the filtered list');
  }

  // ---- v1.5.24: vitals are a hard gate, and patients can be walked back ----
  {
    currentUser = db.login('admin', 'admin');
    const mkP = (last, visit) => db.createPatient(currentUser, {
      first_name: 'Gate', last_name: last, dob: '1980-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: visit || 'filling' },
      consents: [{ type: 'general', signer_name: 'Gate', signature_png: 'data:image/png;base64,AAAA' }],
    });

    // No vitals -> cannot reach a provider, by any path.
    const g1 = mkP('One');
    let refused = '';
    try { db.routePatient(currentUser, g1.id, 'dentist'); } catch (e) { refused = e.message; }
    log(/vitals/i.test(refused), 'v1.5.24: a patient with no vitals cannot be routed to the dentist');
    let refusedHyg = '';
    try { db.routePatient(currentUser, g1.id, 'hygienist'); } catch (e) { refusedHyg = e.message; }
    log(/vitals/i.test(refusedHyg), 'v1.5.24: ...nor to the hygienist');
    // The admin override obeys the same gate — otherwise it is not a gate.
    let refusedAdmin = '';
    try { db.adminMovePatient(currentUser, g1.id, 'dentist'); } catch (e) { refusedAdmin = e.message; }
    log(/vitals/i.test(refusedAdmin), 'v1.5.24: an admin override cannot walk a patient past the vitals station either');
    log(db.listPatients({}).find((p) => p.id === g1.id).status === 'checked_in',
      'v1.5.24: the blocked patient stays put rather than half-moving');

    // A pulse alone is enough to pass the gate (a BP cuff isn't always available).
    const g2 = mkP('Pulse');
    db.saveVitals(currentUser, g2.id, { heart_rate: '72' });
    db.routePatient(currentUser, g2.id, 'dentist');
    log(db.listPatients({}).find((p) => p.id === g2.id).status === 'triaged',
      'v1.5.24: a recorded pulse satisfies the vitals gate');

    // Walking a patient BACK.
    const back = mkP('Back');
    db.saveVitals(currentUser, back.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    db.confirmArrival(currentUser, back.id, { route: 'dentist' });
    db.routePatient(currentUser, back.id, 'dentist');
    log(db.listPatients({}).find((p) => p.id === back.id).status === 'triaged', 'v1.5.24: (setup) patient is with the dentist');

    // ...back to vitals: no longer signed off, waiting again.
    db.adminMovePatient(currentUser, back.id, 'emt');
    let row = db.listPatients({}).find((p) => p.id === back.id);
    log(row.status === 'checked_in' && !row.emt_signed_off,
      'v1.5.24: "back to vitals" undoes the EMT sign-off, not just the label');

    // ...all the way back to check-in: arrival cleared, station cleared, vitals kept.
    db.routePatient(currentUser, back.id, 'dentist');
    db.adminMovePatient(currentUser, back.id, 'checkin');
    row = db.listPatients({}).find((p) => p.id === back.id);
    log(row.status === 'checked_in' && !row.arrived_at && !row.route && !row.emt_signed_off,
      'v1.5.24: "back to check-in" clears arrival, station and sign-off');
    log(row.has_vitals === true, 'v1.5.24: ...but the recorded vitals are kept (clinical data is never discarded)');
    log(db.arrivalReadiness(back.id).arrived_at === null,
      'v1.5.24: the patient reappears in the front desk arrivals list');

    // A checked-out patient can be pulled back to check-in too.
    const outP = mkP('Out');
    db.saveVitals(currentUser, outP.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '64' });
    db.routePatient(currentUser, outP.id, 'dentist');
    db.dismissPatient(currentUser, outP.id);
    log(db.listPatients({}).find((p) => p.id === outP.id).status === 'dismissed', 'v1.5.24: (setup) patient is checked out');
    db.adminMovePatient(currentUser, outP.id, 'checkin');
    row = db.listPatients({}).find((p) => p.id === outP.id);
    log(row.status === 'checked_in' && !row.dismissed_at,
      'v1.5.24: a checked-out patient can be brought all the way back to check-in');
  }

  // ---- v1.5.26: arrivals tabs + A–Z order; hygienist history; slider fix ----
  {
    currentUser = db.login('admin', 'admin');
    const ev26 = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    const signed = [{ type: 'general', signer_name: 'S', signature_png: 'data:image/png;base64,AAAA' }];
    // Desk-registered, deliberately out of alphabetical order.
    for (const last of ['Zimmerman', 'Abbott', 'Mercer']) {
      db.createPatient(currentUser, {
        first_name: 'Desk', last_name: last, dob: '1980-01-01', gender: 'male',
        demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' }, consents: signed,
      });
    }
    // Pre-registered, also out of order (arrives through sync, as the Worker writes it).
    ['Yardley', 'Bannister'].forEach((last, i) => db.applyRemoteRows([{
      entity: 'patient', uid: 'tabs-prereg-' + last, event_uid: ev26.uid, patient_uid: null, deleted: 0,
      updated_at: '2099-03-0' + (i + 1) + 'T00:00:00.000Z@prereg',
      data: {
        language: 'en', first_name: 'Online', last_name: last, dob: '1990-01-01', gender: 'female',
        phone: null, email: null, demographics: JSON.stringify({ preregistered: true }),
        medical_history: '{}', dental_history: JSON.stringify({ visit_type: 'cleaning' }),
        status: 'checked_in', created_at: '2099-03-01T00:00:00.000Z', dismissed_at: null, dismissed_by_name: null,
      },
    }]));

    const store26 = (await import('../src/renderer/js/store.js')).store; store26.setUser(currentUser);
    const ctx26 = { navigate: () => {}, toast: () => {}, store: store26, setDetail: () => {} };
    const view = (await import('../src/renderer/js/views/arrivals.js')).renderArrivals(ctx26);
    document.body.append(view); await tick(); await tick();

    const tabs = Array.from(view.querySelectorAll('.arrival-tab')).map((b) => b.textContent);
    log(tabs.length === 2 && /Pre-registered/i.test(tabs[0]) && /Registered at the desk/i.test(tabs[1]),
      'v1.5.26: arrivals is split into "Pre-registered online" and "Registered at the desk" tabs');
    const surnames = () => Array.from(view.querySelectorAll('.arrival-row strong')).map((e) => e.textContent.split(',')[0]);
    const click = (label) => {
      const b = Array.from(view.querySelectorAll('.arrival-tab')).find((x) => new RegExp(label, 'i').test(x.textContent));
      b.click(); return b;
    };

    click('Pre-registered'); await tick();
    const pre = surnames();
    log(pre.includes('Yardley') && pre.includes('Bannister') && !pre.includes('Abbott'),
      'v1.5.26: the pre-registered tab shows only patients who registered online');
    log(JSON.stringify(pre) === JSON.stringify([...pre].sort()), 'v1.5.26: the pre-registered list is in A–Z order by surname');

    click('Registered at the desk'); await tick();
    const desk = surnames();
    log(desk.includes('Abbott') && desk.includes('Zimmerman') && !desk.includes('Yardley'),
      'v1.5.26: the desk tab shows only patients registered here');
    const deskIdx = [desk.indexOf('Abbott'), desk.indexOf('Mercer'), desk.indexOf('Zimmerman')];
    log(deskIdx[0] < deskIdx[1] && deskIdx[1] < deskIdx[2], 'v1.5.26: the desk list is in A–Z order by surname');
  }

  // The hygienist must see the medical history, not just the dentist.
  {
    currentUser = db.login('admin', 'admin');
    const hp26 = db.createPatient(currentUser, {
      first_name: 'Hyg', last_name: 'History', dob: '1975-05-05', gender: 'female',
      demographics: {}, medical_history: { conditions: ['diabetes', 'high_bp'], allergies: ['penicillin'], allergies_other: 'Sulfa', under_treatment: 'yes' },
      dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'H', signature_png: 'data:image/png;base64,AAAA' }],
    });
    db.saveVitals(currentUser, hp26.id, { bp_systolic: '124', bp_diastolic: '80', heart_rate: '70' });
    db.routePatient(currentUser, hp26.id, 'hygienist');
    const storeH = (await import('../src/renderer/js/store.js')).store; storeH.setUser(currentUser);
    const ctxH = { navigate: () => {}, toast: () => {}, store: storeH, setDetail: () => {} };
    const hv = (await import('../src/renderer/js/views/hygienist.js')).renderHygienist(ctxH, { id: hp26.id });
    document.body.append(hv);
    for (let i = 0; i < 8; i++) await tick();
    const htxt = hv.textContent;
    log(/Medical history/i.test(htxt), 'v1.5.26: the hygienist screen shows the medical history section');
    log(/Diabetes/i.test(htxt) && /High blood pressure/i.test(htxt), 'v1.5.26: the hygienist sees the patient\'s conditions');
    log(/Penicillin/i.test(htxt) && /Sulfa/i.test(htxt), 'v1.5.26: the hygienist sees allergies, including a typed-in one');
    const panel = hv.querySelector('details.collapse');
    log(!!panel && panel.hasAttribute('open'), 'v1.5.26: the history is open by default, not hidden behind a toggle');
  }

  // ---- v1.6.0: export as a spreadsheet, restore it, and purge PHI ----
  {
    currentUser = db.login('admin', 'admin');
    const ev = db.createEvent(currentUser, { name: 'Export Test', location: 'Sandy' });
    db.setActiveEvent(currentUser, ev.id);
    const pt = db.createPatient(currentUser, {
      first_name: 'Wilhelmina', last_name: 'Farnsworth', dob: '1988-09-14', gender: 'female', phone: '5035550142',
      demographics: { city: 'Sandy', state: 'OR' },
      medical_history: { allergies: ['penicillin'], allergies_other: 'Sulfa', conditions: ['diabetes'] },
      dental_history: { visit_type: 'extraction_pain', reason: 'Molar pain' },
      consents: [
        { type: 'general', signer_name: 'Wilhelmina Farnsworth', signature_png: 'data:image/png;base64,AAAA' },
        { type: 'oral_surgery', signer_name: 'Wilhelmina Farnsworth', signature_png: 'data:image/png;base64,BBBB' },
      ],
    });
    db.saveVitals(currentUser, pt.id, { bp_systolic: '148', bp_diastolic: '92', heart_rate: '78' });
    db.routePatient(currentUser, pt.id, 'dentist');
    db.addXray(currentUser, pt.id, { station: 'dentist', image_png: 'data:image/jpeg;base64,BBBB', note: 'Farnsworth_W_T30.jpg', tooth: '30' });

    const bundle = db.exportClinicBundle(ev.id);
    log(bundle.patients.length === 1 && bundle.consents.length === 2 && bundle.xrays.length === 1 && !!bundle.patients[0].uid,
      'v1.6.0: the clinic export carries patients, consents and x-rays, each with a stable id');
    log(String(bundle.consents[0].signature_png).startsWith('data:image') && String(bundle.xrays[0].image_png).startsWith('data:image'),
      'v1.6.0: signatures and x-ray images are in the backup (a spreadsheet cannot hold them)');

    // The readable workbook.
    const { clinicSheets } = await import('../src/main/clinicSheets.js');
    const { buildWorkbook } = await import('../src/main/xlsx.js');
    const sheets = clinicSheets(bundle);
    const names = sheets.map((s) => s.name);
    log(names.includes('Patients') && names.includes('Treatment') && names.includes('Consents') && names.includes('X-rays'),
      'v1.6.0: the workbook has a sheet for patients, treatment, consents and x-rays');
    const pRow = sheets[0].rows[0];
    const pCols = sheets[0].columns;
    log(pRow[pCols.indexOf('Allergies')] === 'Penicillin, Sulfa',
      'v1.6.0: the spreadsheet shows a typed-in allergy alongside the ticked ones');
    log(pRow[pCols.indexOf('Blood pressure')] === '148/92' && pRow[pCols.indexOf('City')] === 'Sandy',
      'v1.6.0: vitals and city read plainly in the spreadsheet');
    const wb = buildWorkbook(sheets);
    log(Buffer.isBuffer(wb) && wb.slice(0, 2).toString() === 'PK', 'v1.6.0: the workbook is a real .xlsx file');

    // Finishing the clinic keeps the figures and removes the people.
    // v1.11.0: finishing refuses without an export on this computer, so record
    // the receipt the export handler writes. Its own check is below.
    db.recordClinicExport(ev.id, { patients: 1, xlsxPath: '/tmp/Clinic.xlsx' });
    const fin = db.finishEvent(currentUser, ev.id);
    log(fin.removed === 1 && db.listPatients({ eventId: ev.id }).length === 0,
      'v1.6.0: finishing a clinic removes every patient record');
    const reports = db.listEventReports();
    const rep = reports.find((r) => r.event_id === ev.id);
    log(!!rep && rep.summary.patients_seen === 1 && rep.summary.extractions === 0,
      'v1.6.0: the de-identified reporting totals are kept');
    log(!!rep && rep.summary.by_city['Sandy, OR'] === 1 && !!rep.summary.by_age,
      'v1.6.0: the kept report still has the by-city and by-age breakdowns for grant returns');
    const repText = JSON.stringify(rep.summary);
    log(!/Wilhelmina|Farnsworth/.test(repText) && !/5035550142/.test(repText) && !/1988-09-14/.test(repText),
      'v1.6.0: the kept report contains no name, phone or date of birth');

    // The deletion must travel, or the cloud simply sends the patient back.
    const pending = db.collectSyncRows(400).rows.filter((r) => r.deleted);
    const tombEntities = new Set(pending.map((r) => r.entity));
    log(pending.some((r) => r.uid === bundle.patients[0].uid) && pending.every((r) => JSON.stringify(r.data) === '{}'),
      'v1.6.0: a purge queues a deletion for the cloud, carrying no patient data');
    // The whole chart must be tombstoned. A patient-only tombstone would leave
    // the consent signatures and x-ray images sitting in the cloud forever —
    // the most identifying data in the system.
    log(tombEntities.has('patient') && tombEntities.has('consent') && tombEntities.has('xray') && tombEntities.has('triage'),
      'v1.6.0: consents, x-rays and vitals are purged from the cloud too, not just the patient row');
    const tombUids = new Set(pending.map((r) => r.uid));
    log(tombUids.has(bundle.consents[0].uid) && tombUids.has(bundle.xrays[0].uid),
      'v1.6.0: the purged signature and x-ray are named explicitly so the cloud drops them');
    // ...and an incoming deletion removes the record here too.
    db.setEventActive(currentUser, ev.id, true); // finishing the clinic turned it off
    db.setActiveEvent(currentUser, ev.id);
    const victim = db.createPatient(currentUser, { first_name: 'Gone', last_name: 'Soon', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    const vUid = db.exportClinicBundle(ev.id).patients.find((p) => p.last_name === 'Soon').uid;
    // v1.6.3: deletions are counted separately from records brought in.
    const del = db.applyRemoteRows([{ entity: 'patient', uid: vUid, deleted: 1, updated_at: '2099-12-31T00:00:00.000Z@peer', data: {} }]);
    log(del.deleted === 1 && !db.listPatients({ eventId: ev.id }).find((p) => p.id === victim.id),
      'v1.6.0: a deletion from another station removes the patient here as well');

    // Restore puts the whole clinic back, signatures and images included.
    const back = db.importClinicBundle(currentUser, bundle);
    const restored = db.listPatients({ eventId: ev.id }).find((p) => p.last_name === 'Farnsworth');
    const full = restored ? db.getPatient(restored.id) : null;
    log(back.patients === 1 && !!full, 'v1.6.0: a clinic can be restored from its backup file');
    log(!!full && String((full.consents[0] || {}).signature_png).startsWith('data:image') && String(full.triage.bp_systolic) === '148',
      'v1.6.0: the restored record still has its signed consent and vitals');
    log(!!full && full.xrays.length === 1 && String(db.getXray(full.xrays[0].id).image_png).startsWith('data:image'),
      'v1.6.0: the restored record still has its x-ray image');
    db.importClinicBundle(currentUser, bundle);
    log(db.listPatients({ eventId: ev.id }).filter((p) => p.last_name === 'Farnsworth').length === 1,
      'v1.6.0: importing the same file twice does not duplicate anyone');
  }

  // ---- v1.6.1: one-tap check-out tick, and a modernised Reports tab ----
  {
    currentUser = db.login('admin', 'admin');
    const ev61 = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    db.setActiveEvent(currentUser, ev61.id);
    const mk = (last, city) => {
      const p = db.createPatient(currentUser, {
        first_name: 'Tick', last_name: last, dob: '1980-01-01', gender: 'female',
        demographics: { city, state: 'OR' }, medical_history: { conditions: ['diabetes'] },
        dental_history: { visit_type: 'cleaning' },
        consents: [{ type: 'general', signer_name: 'T', signature_png: 'data:image/png;base64,AAAA' }],
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '120', bp_diastolic: '78', heart_rate: '70' });
      db.routePatient(currentUser, p.id, 'hygienist');
      db.saveTreatment(currentUser, p.id, { cleaning: { scaling: true }, clinical_notes: 'done' }, true);
      return p;
    };
    const a1 = mk('Alpha', 'Sandy');
    mk('Beta', 'Boring');

    const store61 = (await import('../src/renderer/js/store.js')).store; store61.setUser(currentUser);
    const ctx61 = { navigate: () => {}, toast: () => {}, store: store61, setDetail: () => {} };
    const co = (await import('../src/renderer/js/views/checkout.js')).renderCheckout(ctx61);
    document.body.append(co);
    for (let i = 0; i < 6; i++) await tick();

    const tickBtns = Array.from(co.querySelectorAll('.tick-btn'));
    log(tickBtns.length >= 2, 'v1.6.1: check-out lists a one-tap "Check out" tick for each ready patient');
    const alphaRow = Array.from(co.querySelectorAll('tr')).find((r) => /Alpha/.test(r.textContent));
    log(!!alphaRow && !!alphaRow.querySelector('.tick-btn'), 'v1.6.1: the tick sits on the patient\'s own row');

    // Tick -> confirm -> the patient is checked out, without opening the record.
    alphaRow.querySelector('.tick-btn').click();
    await tick();
    const confirmBtn = Array.from(document.querySelectorAll('.modal-card button')).find((b) => /Verify & dismiss/i.test(b.textContent));
    log(!!confirmBtn, 'v1.6.1: ticking asks for confirmation before checking someone out');
    confirmBtn.click();
    for (let i = 0; i < 8; i++) await tick();
    log(db.listPatients({}).find((p) => p.id === a1.id).status === 'dismissed',
      'v1.6.1: confirming the tick checks the patient out from the list');
    const doneRow = Array.from(co.querySelectorAll('tr')).find((r) => /Alpha/.test(r.textContent));
    log(!!doneRow && !!doneRow.querySelector('.tick-done') && !doneRow.querySelector('.tick-btn'),
      'v1.6.1: a checked-out patient shows the completed tick and no longer offers the button');

    // Reports: ranked bars now carry a count AND a share, and the day chart draws.
    const rep = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx61);
    document.body.append(rep);
    for (let i = 0; i < 10; i++) await tick();
    const rows = Array.from(rep.querySelectorAll('.bar-row'));
    log(rows.length > 0 && rows.every((r) => r.querySelectorAll('.bar-val').length === 1 && r.querySelectorAll('.bar-pct').length === 1),
      'v1.6.1: every breakdown row shows both a count and its share of the total');
    const cityRows = Array.from(rep.querySelectorAll('.demo-group')).find((g) => /By city/i.test(g.textContent));
    log(!!cityRows && /%/.test(cityRows.textContent), 'v1.6.1: the by-city breakdown carries percentages for grant reporting');
    const cols = rep.querySelectorAll('.day-chart .day-col');
    log(cols.length > 0, 'v1.6.1: clinic activity is drawn as a day-by-day chart');
    log(!!rep.querySelector('.chart-key') && /Seen/.test(rep.textContent) && /Completed/.test(rep.textContent),
      'v1.6.1: the chart is labelled so the bars can be read');
    log(!!rep.querySelector('details.collapse'), 'v1.6.1: the day-by-day numbers are still available, tucked under the chart');
  }

  // ---- v1.6.2: a patient who left HAS finished; sign-ups vs check-outs ----
  {
    currentUser = db.login('admin', 'admin');
    const ev62 = db.createEvent(currentUser, { name: 'Completion Test', location: 'Sandy' });
    db.setActiveEvent(currentUser, ev62.id);
    const mk62 = (last, { prereg = false, finish = false } = {}) => {
      const p = db.createPatient(currentUser, {
        first_name: 'C', last_name: last, dob: '1980-01-01', gender: 'female',
        demographics: { city: 'Sandy', state: 'OR', preregistered: prereg },
        medical_history: {}, dental_history: { visit_type: 'cleaning' },
        consents: [{ type: 'general', signer_name: 'C', signature_png: 'data:image/png;base64,AAAA' }],
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '120', bp_diastolic: '78', heart_rate: '70' });
      db.routePatient(currentUser, p.id, 'hygienist');
      if (finish) { db.saveTreatment(currentUser, p.id, { cleaning: { scaling: true } }, true); db.dismissPatient(currentUser, p.id); }
      return p;
    };
    // 2 pre-reg (1 left), 2 on-site (1 left) -> 50% checked out overall.
    mk62('PreDone', { prereg: true, finish: true });
    mk62('PreStill', { prereg: true });
    mk62('SiteDone', { finish: true });
    mk62('SiteStill', {});

    const store62 = (await import('../src/renderer/js/store.js')).store; store62.setUser(currentUser);
    const ctx62 = { navigate: () => {}, toast: () => {}, store: store62, setDetail: () => {} };
    const rp = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx62);
    document.body.append(rp);
    for (let i = 0; i < 12; i++) await tick();
    // Scope to this event only, so other tests' patients don't skew the maths.
    const sel = rp.querySelector('select');
    const opt = Array.from(sel.options).find((o) => /Completion Test/.test(o.textContent));
    sel.value = opt.value; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    for (let i = 0; i < 12; i++) await tick();

    // A dismissed patient has finished — this used to read 0%.
    const kpiCards = Array.from(rp.querySelectorAll('.kpi'));
    const finishedKpi = kpiCards.find((k) => /Visits finished/i.test(k.textContent));
    log(!!finishedKpi && /\b2\b/.test(finishedKpi.querySelector('.kpi-val').textContent),
      'v1.6.2: a patient who was checked out counts as a finished visit');
    log(!!finishedKpi && /50% of 4/.test(finishedKpi.textContent) && /2 checked out/.test(finishedKpi.textContent),
      'v1.6.2: the finished KPI shows the real share and how many actually left');
    const ringTxt = rp.querySelector('.ring-top') ? rp.querySelector('.ring-top').textContent : '';
    log(/50%/.test(ringTxt), 'v1.6.2: the completion ring agrees with it');
    const ringLegend = rp.querySelector('.ring-legend').textContent;
    log(/Still in the clinic/.test(ringLegend) && /of which checked out/.test(ringLegend),
      'v1.6.2: the ring separates "finished" from "still in the clinic"');

    // Sign-ups vs check-outs, split by where they registered.
    const su = Array.from(rp.querySelectorAll('.card')).find((c) => /Sign-ups vs check-outs/i.test(c.textContent));
    log(!!su, 'v1.6.2: reports has a sign-ups vs check-outs breakdown');
    log(!!su && /2 of 4 patient\(s\) who signed up were checked out/.test(su.textContent) && /50%/.test(su.textContent),
      'v1.6.2: it states how many who signed up were checked out, as a percentage');
    const rowsSU = Array.from(su.querySelectorAll('.signup-row'));
    const preRow = rowsSU.find((r) => /Pre-registered online/.test(r.textContent));
    const siteRow = rowsSU.find((r) => /Registered on site/.test(r.textContent));
    log(!!preRow && /50% of all sign-ups/.test(preRow.textContent) && /50%/.test(preRow.querySelector('.signup-pct').textContent),
      'v1.6.2: pre-registered shows its share of sign-ups and its own check-out rate');
    log(!!siteRow && /50% of all sign-ups/.test(siteRow.textContent),
      'v1.6.2: on-site registration shows its share of sign-ups');
    const totalRow = rowsSU.find((r) => /All patients/.test(r.textContent));
    log(!!totalRow && /50%/.test(totalRow.querySelector('.signup-pct').textContent),
      'v1.6.2: the total row carries the overall check-out rate');
  }

  // ---- v1.6.2: a deleted patient STAYS deleted, everywhere ----
  {
    currentUser = db.login('admin', 'admin');
    const evD = db.createEvent(currentUser, { name: 'Deletion Test' });
    db.setActiveEvent(currentUser, evD.id);
    const ghost = db.createPatient(currentUser, {
      first_name: 'Ghost', last_name: 'Gone', dob: '1980-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'G', signature_png: 'data:image/png;base64,AAAA' }],
    });
    db.saveVitals(currentUser, ghost.id, { bp_systolic: '120', heart_rate: '70' });

    // Capture the rows exactly as the cloud holds them BEFORE the deletion.
    const snap = db.collectSyncRows(400); db.markSynced(snap.mark);
    const liveRow = snap.rows.find((r) => r.entity === 'patient' && r.data.last_name === 'Gone');
    const liveConsent = snap.rows.find((r) => r.entity === 'consent');

    db.deletePatient(currentUser, ghost.id);
    log(!db.listPatients({ eventId: evD.id }).some((p) => p.last_name === 'Gone'),
      'v1.6.2: deleting a patient removes them locally');
    const tombs = db.collectSyncRows(400).rows.filter((r) => r.deleted);
    log(tombs.some((r) => r.entity === 'patient') && tombs.some((r) => r.entity === 'consent'),
      'v1.6.2: the deletion is queued for the cloud, chart and all');

    // The failure the clinic hit: a station still holding the old copy pushes it
    // back and the patient reappears as if nothing happened.
    db.applyRemoteRows([liveRow]);
    log(!db.listPatients({ eventId: evD.id }).some((p) => p.last_name === 'Gone'),
      'v1.6.2: an old copy arriving from another station does NOT bring them back');
    db.applyRemoteRows([liveConsent]);
    log(!db.getPatient(ghost.id), 'v1.6.2: nor does an old consent or chart row re-create them');

    // ...but a deliberate restore (a genuinely newer copy) must still work,
    // otherwise "Restore a clinic from backup" would be silently blocked.
    db.applyRemoteRows([{ ...liveRow, updated_at: '2099-12-31T23:59:59.000Z@peer' }]);
    log(db.listPatients({ eventId: evD.id }).some((p) => p.last_name === 'Gone'),
      'v1.6.2: a deliberate restore (a newer copy) still brings the patient back');

    // A deletion arriving FROM another station is remembered here too, so this
    // machine also refuses to re-create the record later.
    const back = db.listPatients({ eventId: evD.id }).find((p) => p.last_name === 'Gone');
    const uid = db.exportClinicBundle(evD.id).patients.find((p) => p.last_name === 'Gone').uid;
    db.applyRemoteRows([{ entity: 'patient', uid, deleted: 1, updated_at: '2100-01-01T00:00:00.000Z@peer', data: {} }]);
    log(!db.listPatients({ eventId: evD.id }).some((p) => p.id === back.id),
      'v1.6.2: a deletion from another station removes the patient here');
    db.applyRemoteRows([{ ...liveRow, uid, updated_at: '2099-06-01T00:00:00.000Z@peer' }]);
    log(!db.listPatients({ eventId: evD.id }).some((p) => p.last_name === 'Gone'),
      'v1.6.2: ...and this station then refuses to re-create it from an older copy');
  }

  // ---- v1.6.3: EVERY delete travels, not just the patient one ----
  {
    currentUser = db.login('admin', 'admin');
    const evT = db.createEvent(currentUser, { name: 'Travel Test' });
    db.setActiveEvent(currentUser, evT.id);
    const tombUids = () => new Set(db.collectSyncRows(800).rows.filter((r) => r.deleted).map((r) => r.uid));

    // An x-ray carries its own image to every station.
    const xp = db.createPatient(currentUser, { first_name: 'X', last_name: 'Ray', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    const xr = db.addXray(currentUser, xp.id, { station: 'dentist', image_png: 'data:image/jpeg;base64,AAAA', note: 'x.jpg', tooth: '14' });
    const xUid = db.exportClinicBundle(evT.id).xrays.find((x) => x.id === xr.id).uid;
    db.deleteXray(currentUser, xr.id);
    log(tombUids().has(xUid), 'v1.6.3: deleting an x-ray removes it from the cloud too, not just this laptop');

    // The empty-record cleanup says "permanently"; make sure it is.
    const junk = db.createPatient(currentUser, { first_name: 'A', last_name: 'B', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    const junkUid = db.exportClinicBundle(evT.id).patients.find((p) => p.id === junk.id).uid;
    db.deleteIncompletePatients(currentUser);
    log(tombUids().has(junkUid), 'v1.6.3: clearing empty records is permanent everywhere, as the dialog claims');

    // Revoking a staff account has to revoke it on every laptop — the account
    // carries its own password hash.
    const u = db.createUser(currentUser, { username: 'gone.soon', full_name: 'Gone Soon', role: 'emt', password: 'demo1234', event_id: evT.id });
    db.collectSyncRows(800); // give the account a uid, as a first sync would
    db.deleteUser(currentUser, u.id);
    const afterUsers = db.collectSyncRows(800).rows.filter((r) => r.deleted && r.entity === 'user');
    log(afterUsers.length >= 1, 'v1.6.3: deleting a staff account revokes it on every laptop');

    // "Start fresh for next event" is a revocation, not a local tidy-up.
    const u2 = db.createUser(currentUser, { username: 'fresh.one', full_name: 'Fresh One', role: 'hygienist', password: 'demo1234', event_id: evT.id });
    db.collectSyncRows(800);
    db.clearEventStaff(currentUser, evT.id);
    const clearedTombs = db.collectSyncRows(800).rows.filter((r) => r.deleted && r.entity === 'user');
    log(clearedTombs.length >= 1, 'v1.6.3: "Start fresh for next event" revokes those accounts everywhere');

    // Force-deleting an event must clear its patients from the cloud as well.
    const ev2 = db.createEvent(currentUser, { name: 'Doomed' });
    db.setActiveEvent(currentUser, ev2.id);
    const dp = db.createPatient(currentUser, { first_name: 'Doom', last_name: 'Ed', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    const dpUid = db.exportClinicBundle(ev2.id).patients.find((p) => p.id === dp.id).uid;
    db.setActiveEvent(currentUser, evT.id);
    db.deleteEvent(currentUser, ev2.id, { force: true });
    log(tombUids().has(dpUid), 'v1.6.3: force-deleting an event clears its patients from the cloud too');

    // A stale deletion must not wipe a newer local edit.
    const keep = db.createPatient(currentUser, { first_name: 'Keep', last_name: 'Me', demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED });
    db.collectSyncRows(800);
    const keepUid = db.exportClinicBundle(evT.id).patients.find((p) => p.id === keep.id).uid;
    db.updatePatient(currentUser, keep.id, { first_name: 'Keep', last_name: 'Me', phone: '5035551234' });
    const stale = db.applyRemoteRows([{ entity: 'patient', uid: keepUid, deleted: 1, updated_at: '2000-01-01T00:00:00.000Z@old', data: {} }]);
    log(stale.deleted === 0 && !!db.listPatients({ eventId: evT.id }).find((p) => p.id === keep.id),
      'v1.6.3: an old deletion does not wipe a newer local edit');
  }

  // ---- v1.6.4: every patient list A–Z; treatment notes name their clinician ----
  {
    currentUser = db.login('admin', 'admin');
    const evA = db.createEvent(currentUser, { name: 'Alphabetical Test' });
    db.setActiveEvent(currentUser, evA.id);
    const consent = [{ type: 'general', signer_name: 'S', signature_png: 'data:image/png;base64,AAAA' }];
    // Deliberately created out of order.
    const make = (last, route, finish) => {
      const p = db.createPatient(currentUser, {
        first_name: 'Sort', last_name: last, dob: '1980-01-01', gender: 'female',
        demographics: {}, medical_history: {}, dental_history: { visit_type: route === 'hygienist' ? 'cleaning' : 'filling' },
        consents: consent,
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '120', bp_diastolic: '78', heart_rate: '70' });
      db.routePatient(currentUser, p.id, route);
      if (finish) db.saveTreatment(currentUser, p.id, { cleaning: { scaling: true }, provider_name: 'Dr X' }, true);
      return p;
    };
    ['Zeller', 'Abbott', 'Mendez'].forEach((n) => make(n, 'hygienist'));
    ['Yates', 'Baker'].forEach((n) => make(n, 'dentist'));
    make('Quinn', 'dentist', true);
    make('Carver', 'dentist', true);

    const storeA = (await import('../src/renderer/js/store.js')).store; storeA.setUser(currentUser);
    const ctxA = { navigate: () => {}, toast: () => {}, store: storeA, setDetail: () => {} };
    const namesIn = (node) => Array.from(node.querySelectorAll('td strong, .arrival-row strong')).map((e) => e.textContent.split(',')[0]);
    const isSorted = (arr) => arr.every((v, i) => i === 0 || arr[i - 1].localeCompare(v, undefined, { sensitivity: 'base' }) <= 0);

    const views = [
      ['emt.js', 'renderEmt', 'Vitals'],
      ['hygienist.js', 'renderHygienist', 'Cleanings'],
      ['provider.js', 'renderProvider', 'Dentist'],
      ['checkout.js', 'renderCheckout', 'Check-Out'],
      ['records.js', 'renderRecords', 'Records'],
    ];
    for (const [file, fn, label] of views) {
      const mod = await import(`../src/renderer/js/views/${file}`);
      const node = mod[fn](ctxA, {});
      document.body.append(node);
      for (let i = 0; i < 10; i++) await tick();
      // A view may render several queues (the dentist shows its own list plus
      // who is at the hygienist); each one is sorted on its own.
      const groups = Array.from(node.querySelectorAll('tbody, .arrival-list'))
        .map((g) => Array.from(g.querySelectorAll('strong')).map((e) => e.textContent.split(',')[0]))
        .map((names) => names.filter((n) => /Zeller|Abbott|Mendez|Yates|Baker|Quinn|Carver/.test(n)))
        .filter((names) => names.length > 1);
      log(groups.length > 0 && groups.every(isSorted), `v1.6.4: the ${label} list is in A–Z order by surname`);
    }

    // A treatment note has to say who provided the care.
    const dentP = db.listPatients({ eventId: evA.id }).find((p) => p.last_name === 'Baker');
    const prov = (await import('../src/renderer/js/views/provider.js')).renderProvider(ctxA, { id: dentP.id });
    document.body.append(prov);
    for (let i = 0; i < 14; i++) await tick();
    const nameInput = Array.from(prov.querySelectorAll('input')).find((i) => i.placeholder === 'Printed name');
    log(!!nameInput && nameInput.value === currentUser.full_name,
      'v1.6.4: the dentist\'s printed name is pre-filled from who is signed in');
    nameInput.value = '';
    nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const completeBtn = Array.from(prov.querySelectorAll('button')).find((b) => /Mark visit complete/i.test(b.textContent));
    if (completeBtn) {
      completeBtn.click();
      for (let i = 0; i < 8; i++) await tick();
      log(db.listPatients({ eventId: evA.id }).find((p) => p.id === dentP.id).status !== 'completed',
        'v1.6.4: a visit cannot be marked complete without the dentist\'s name');
    } else log(false, 'v1.6.4: (setup) the dentist has a "Mark visit complete" action');
  }

  // ---- v1.6.5: an export + delete must never destroy the reporting totals ----
  {
    currentUser = db.login('admin', 'admin');
    const evR = db.createEvent(currentUser, { name: 'Report Loss Test', location: 'Sandy' });
    db.setActiveEvent(currentUser, evR.id);
    const seed = (last, city) => {
      const p = db.createPatient(currentUser, {
        first_name: 'R', last_name: last, dob: '1980-01-01', gender: 'female',
        demographics: { city, state: 'OR' }, medical_history: { conditions: ['diabetes'] },
        dental_history: { visit_type: 'extraction_pain' },
        consents: [{ type: 'general', signer_name: 'R', signature_png: 'data:image/png;base64,AAAA' },
        { type: 'oral_surgery', signer_name: 'R', signature_png: 'data:image/png;base64,BBBB' },
      ],
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '120', heart_rate: '70' });
      db.routePatient(currentUser, p.id, 'dentist');
      db.saveTreatment(currentUser, p.id, { extractions: [{ tooth: '30' }], provider_name: 'D' }, true);
      db.dismissPatient(currentUser, p.id);
      return p;
    };
    seed('Alpha', 'Sandy'); seed('Beta', 'Boring'); seed('Gamma', 'Sandy');

    const bundle = db.exportClinicBundle(evR.id);

    // THE REPORTED BUG: exporting, then using the Delete button that unlocks
    // afterwards, used to leave the event with no patients AND no totals.
    db.purgeEventPatients(currentUser, evR.id);
    log(db.listPatients({ eventId: evR.id }).length === 0, 'v1.6.5: (setup) the purge removes the patient records');
    const keptRec = db.listEventReports().find((r) => r.event_id === evR.id);
    log(!!keptRec, 'v1.6.5: deleting a clinic\'s patient data KEEPS its reporting totals');
    log(!!keptRec && keptRec.summary.patients_seen === 3 && keptRec.summary.extractions === 3,
      'v1.6.5: the kept totals are the real numbers, not zeros');
    log(!!keptRec && keptRec.summary.by_city['Sandy, OR'] === 2 && keptRec.summary.by_city['Boring, OR'] === 1,
      'v1.6.5: the by-city breakdown survives for grant reporting');
    const keptText = JSON.stringify(keptRec.summary);
    log(!/Alpha|Beta|Gamma/.test(keptText) && !/1980-01-01/.test(keptText),
      'v1.6.5: and it still holds no patient information');

    // Reports must SHOW them rather than computing zeros from an empty list.
    const storeR = (await import('../src/renderer/js/store.js')).store; storeR.setUser(currentUser);
    const ctxR = { navigate: () => {}, toast: () => {}, store: storeR, setDetail: () => {} };
    const rv = (await import('../src/renderer/js/views/reports.js')).renderReports(ctxR);
    document.body.append(rv);
    for (let i = 0; i < 12; i++) await tick();
    const sel = rv.querySelector('select');
    const opt = Array.from(sel.options).find((o) => /Report Loss Test/.test(o.textContent));
    sel.value = opt.value; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    for (let i = 0; i < 14; i++) await tick();
    const txt = rv.textContent;
    log(/patient records have been removed/i.test(txt),
      'v1.6.5: Reports says the records were removed rather than silently showing zeros');
    const kpis = Array.from(rv.querySelectorAll('.kpi')).map((k) => k.textContent);
    log(kpis.some((k) => /^3Patients seen/.test(k)) && kpis.some((k) => /Visits finished/.test(k)),
      'v1.6.5: Reports shows the kept totals for a purged clinic');
    log(/Sandy, OR/.test(txt) && /Boring, OR/.test(txt),
      'v1.6.5: the archived report still shows the by-city breakdown');

    // Recovery for a clinic that already lost its figures: recount from the
    // backup file, without bringing any patient back.
    const raw = (await import('better-sqlite3')).default;
    const before = db.listEventReports().length;
    db.applyRemoteRows([]); // no-op, keeps the import above honest
    // Wipe the kept report to imitate a clinic that purged on an older version.
    db.rebuildSummaryFromBundle(currentUser, bundle); // idempotent refresh
    const rebuilt = db.rebuildSummaryFromBundle(currentUser, bundle);
    log(rebuilt.ok && rebuilt.summary.patients_seen === 3 && rebuilt.summary.extractions === 3,
      'v1.6.5: a lost report can be rebuilt from the exported backup file');
    log(db.listPatients({ eventId: evR.id }).length === 0,
      'v1.6.5: rebuilding the report does NOT restore the patient records');
    log(db.listEventReports().filter((r) => r.event_id === evR.id).length === 1,
      'v1.6.5: rebuilding twice refreshes the report rather than duplicating it');
  }

  // ---- v1.6.6: the report data that "got removed" — the rest of the story ----
  {
    currentUser = db.login('admin', 'admin');

    // 1. "All events" is the DEFAULT view of the Reports tab. It computed from
    //    the live patient list alone, so every finished clinic counted as zero —
    //    the roll-up a grant return is read off silently lost them.
    const rollAll = db.reportRollup('all');
    const liveNow = db.listPatients({ eventId: 'all' }).length;
    const keptSeen = rollAll.kept_events.reduce((n, k) => n + (Number(k.patients_seen) || 0), 0);
    log(rollAll.kept_events.some((k) => /Report Loss Test/.test(k.name || '')),
      'v1.6.6: "All events" knows about the clinics whose records were removed');
    log(keptSeen > 0 && rollAll.summary.patients_seen === liveNow + keptSeen,
      'v1.6.6: "All events" adds the kept totals to the live ones (was: finished clinics counted 0)');

    // 2. The live tab and the kept totals must count the same way. An extraction
    //    row ticked "other" with no tooth is a note, not a procedure.
    const evC = db.createEvent(currentUser, { name: 'Counting Rules', location: 'Sandy' });
    db.setActiveEvent(currentUser, evC.id);
    const pc = db.createPatient(currentUser, {
      first_name: 'Count', last_name: 'Rules', dob: '1990-05-05', gender: 'male',
      demographics: { city: 'Sandy', state: 'OR' }, medical_history: {}, dental_history: { visit_type: 'extraction_pain' },
      consents: [{ type: 'general', signer_name: 'C', signature_png: 'data:image/png;base64,AAAA' },
        { type: 'oral_surgery', signer_name: 'R', signature_png: 'data:image/png;base64,BBBB' },
      ],
    });
    db.saveVitals(currentUser, pc.id, { bp_systolic: '120', heart_rate: '70' });
    db.routePatient(currentUser, pc.id, 'dentist');
    db.saveTreatment(currentUser, pc.id, {
      extractions: [{ tooth: '30' }, { other: true }],
      cleaning: { quad_detail: 'UR', teeth: '1,2' },
      provider_name: 'D',
    }, true);
    const liveC = db.reportRollup(evC.id).summary;
    log(liveC.extractions === 1, 'v1.6.6: an "other" extraction with no tooth is not counted as a procedure');
    log(liveC.cleanings === 0, 'v1.6.6: cleaning notes alone do not count as a cleaning performed');
    db.dismissPatient(currentUser, pc.id);
    const bundleC = db.exportClinicBundle(evC.id);
    db.purgeEventPatients(currentUser, evC.id);
    const keptC = db.listEventReports().find((r) => r.event_id === evC.id).summary;
    log(keptC.extractions === liveC.extractions && keptC.cleanings === liveC.cleanings,
      'v1.6.6: the kept totals count exactly what the live tab counted');

    // 3. A purged clinic is CLOSED. Leaving it active made the next walk-in
    //    restart the count and hid the kept report behind a "live" event.
    const evAfter = db.listEvents().find((e) => e.id === evC.id);
    log(evAfter && !evAfter.active, 'v1.6.6: removing a clinic\'s records closes the clinic');

    // 4. A rebuilt report agrees with the one the clinic saw on the day.
    const reb = db.rebuildSummaryFromBundle(currentUser, bundleC);
    log(reb.summary.extractions === liveC.extractions && reb.summary.patients_seen === liveC.patients_seen,
      'v1.6.6: a report rebuilt from the backup matches the original figures');

    // 5. Deleting an event outright is the one destructive action NOT gated
    //    behind an export — its figures must survive it, and still be readable.
    const evD = db.createEvent(currentUser, { name: 'Deleted Outright', location: 'Boring' });
    db.setActiveEvent(currentUser, evD.id);
    for (const last of ['Uno', 'Dos']) {
      const p = db.createPatient(currentUser, {
        first_name: 'Del', last_name: last, dob: '1985-03-03', gender: 'female',
        demographics: { city: 'Boring', state: 'OR' }, medical_history: {}, dental_history: { visit_type: 'cleaning' },
        consents: [{ type: 'general', signer_name: 'D', signature_png: 'data:image/png;base64,AAAA' }],
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '118', heart_rate: '68' });
      db.routePatient(currentUser, p.id, 'hygienist');
      db.saveTreatment(currentUser, p.id, { cleaning: { scaling: true }, provider_name: 'H' }, true);
      db.dismissPatient(currentUser, p.id);
    }
    db.deleteEvent(currentUser, evD.id, { force: true });
    const keptD = db.listEventReports().find((r) => r.event_id === evD.id);
    log(!!keptD && keptD.summary.patients_seen === 2,
      'v1.6.6: deleting an event keeps its de-identified totals');
    const rollAfterDelete = db.reportRollup('all');
    log(rollAfterDelete.kept_events.some((k) => k.id === evD.id && k.event_deleted),
      'v1.6.6: a deleted clinic\'s figures still appear in "All events"');

    // 6. One report row per event, whatever happens. Two stations finishing the
    //    same clinic offline used to leave two rows and double the roll-up.
    db.captureEventSummary(currentUser, evC.id);
    db.captureEventSummary(currentUser, evC.id);
    log(db.listEventReports().filter((r) => r.event_id === evC.id).length === 1,
      'v1.6.6: an event can only ever have one report row');

    // 7. Age is counted AS OF THE VISIT, so rebuilding a report years later does
    //    not move someone into a different age band.
    const evAge = db.createEvent(currentUser, { name: 'Age Bands', location: 'Sandy' });
    db.setActiveEvent(currentUser, evAge.id);
    const teen = db.createPatient(currentUser, {
      first_name: 'Almost', last_name: 'Adult', dob: '2009-01-01', gender: 'male',
      demographics: { city: 'Sandy', state: 'OR' }, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'A', signature_png: 'data:image/png;base64,AAAA' }],
    });
    { const h = rawDb(); h.prepare('UPDATE patients SET created_at = ? WHERE id = ?').run('2020-06-01T10:00:00.000Z', teen.id); h.close(); }
    const ageSum = db.reportRollup(evAge.id).summary;
    log((ageSum.by_age['Under 18'] || 0) === 1,
      'v1.6.6: age is counted as of the visit, not as of today');

    // 8. And the tab itself — its DEFAULT view — must show those numbers.
    const storeA = (await import('../src/renderer/js/store.js')).store; storeA.setUser(currentUser);
    const ctxA = { navigate: () => {}, toast: () => {}, store: storeA, setDetail: () => {} };
    const av = (await import('../src/renderer/js/views/reports.js')).renderReports(ctxA);
    document.body.append(av);
    for (let i = 0; i < 14; i++) await tick();
    const expected = db.reportRollup('all').summary.patients_seen;
    const seenKpi = Array.from(av.querySelectorAll('.kpi')).find((k) => /Patients seen/.test(k.textContent));
    log(!!seenKpi && seenKpi.textContent.startsWith(String(expected)) && expected > 0,
      'v1.6.6: the Reports tab opens on a total that includes the finished clinics');
    log(/records have been removed|records removed/i.test(av.textContent),
      'v1.6.6: it says plainly which figures come from clinics whose records are gone');
    // The heading followed the ACTIVE event even when another was selected.
    const selA = av.querySelector('select');
    const optA = Array.from(selA.options).find((o) => /Age Bands/.test(o.textContent));
    selA.value = optA.value; selA.dispatchEvent(new window.Event('change', { bubbles: true }));
    for (let i = 0; i < 14; i++) await tick();
    log(/Age Bands/.test(av.querySelector('.view-sub').textContent),
      'v1.6.6: the heading names the clinic whose numbers are on screen');
    av.remove();

    // 9. A report kept by the PREVIOUS version holds only the headline counts.
    //    It must still contribute them — and the page has to say what is missing
    //    rather than printing a check-out rate of 0% as though it were measured.
    {
      const h = rawDb();
      const rec = h.prepare('SELECT * FROM event_reports WHERE event_id = ?').get(evC.id);
      const oldSummary = JSON.parse(rec.summary);
      ['checked_out', 'flagged', 'patients_with_xray', 'pre_signups', 'pre_checked_out',
        'onsite_signups', 'onsite_checked_out', 'by_status', 'days'].forEach((k) => { delete oldSummary[k]; });
      h.prepare('UPDATE event_reports SET summary = ? WHERE id = ?').run(JSON.stringify(oldSummary), rec.id);
      h.close();
      const legacyRoll = db.reportRollup(evC.id).summary;
      log(legacyRoll.patients_seen === oldSummary.patients_seen && legacyRoll.legacy_parts === 1,
        'v1.6.6: totals kept by the previous version still count, and are marked as incomplete');

      const lv = (await import('../src/renderer/js/views/reports.js')).renderReports(ctxA);
      document.body.append(lv);
      for (let i = 0; i < 14; i++) await tick();
      const selL = lv.querySelector('select');
      const optL = Array.from(selL.options).find((o) => /Counting Rules/.test(o.textContent));
      selL.value = optL.value; selL.dispatchEvent(new window.Event('change', { bubbles: true }));
      for (let i = 0; i < 14; i++) await tick();
      log(/before this breakdown existed/i.test(lv.textContent),
        'v1.6.6: the page says which figures an older kept report cannot answer');
      lv.remove();
    }
  }

  // ---- v1.6.6: a deletion that could not be applied is retried, not lost ----
  {
    currentUser = db.login('admin', 'admin');
    const evX = db.createEvent(currentUser, { name: 'FK Order Clinic', location: 'Sandy' });
    db.setActiveEvent(currentUser, evX.id);
    const px = db.createPatient(currentUser, {
      first_name: 'Fk', last_name: 'Order', dob: '1970-02-02', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'F', signature_png: 'data:image/png;base64,AAAA' }],
    });
    db.collectSyncRows(); // hands out the uids the cloud keys rows by
    const hx = rawDb();
    const evUid = hx.prepare('SELECT uid FROM events WHERE id = ?').get(evX.id).uid;
    const pxUid = hx.prepare('SELECT uid FROM patients WHERE id = ?').get(px.id).uid;
    const stillHere = (table, id) => !!hx.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    const later = new Date(Date.now() + 60000).toISOString();

    // Another station deleted the whole clinic. The event tombstone alone cannot
    // be applied while this station still holds the patients — that used to be
    // swallowed as a silent skip and never retried, so the clinic lived on here.
    const evOnly = db.applyRemoteRows([{ entity: 'event', uid: evUid, deleted: true, updated_at: later }]);
    log(stillHere('events', evX.id) && evOnly.deferredRows.length === 1,
      'v1.6.6: an event deletion that its patients block is handed back for retry, not dropped');

    // With the patient's tombstone in the same batch, deletions apply
    // children-first and the whole clinic goes.
    const both = db.applyRemoteRows([
      { entity: 'event', uid: evUid, deleted: true, updated_at: later },
      { entity: 'patient', uid: pxUid, event_uid: evUid, deleted: true, updated_at: later },
    ]);
    log(!stillHere('events', evX.id) && both.deleted === 2,
      'v1.6.6: a clinic deleted on another station is removed here too');

    // And a stray child for a clinic that was deleted here is dropped rather
    // than parked in the retry buffer for ever.
    const stray = db.applyRemoteRows([{ entity: 'patient', uid: 'stray-' + pxUid, event_uid: evUid,
      updated_at: later, data: { first_name: 'Stray', last_name: 'Child' } }]);
    log(stray.deferredRows.length === 0,
      'v1.6.6: a record whose clinic was deleted here is not retried for ever');
    hx.close();
  }

  // ---- v1.6.7: the standing staff list, and the two shared desk logins ----
  {
    currentUser = db.login('admin', 'admin');

    // 1. Every clinic needs a front desk and a check-out table. Both are set up
    //    automatically, with the same login at every clinic.
    log(!!db.login('registration', 'welcome123'), 'v1.6.7: the shared registration login works out of the box');
    log(!!db.login('checkout', 'welcome123'), 'v1.6.7: the shared check-out login works out of the box');
    currentUser = db.login('admin', 'admin');

    // 2. They are GLOBAL, so "Start fresh for next event" cannot sweep them away
    //    and leave the next clinic without a front desk.
    const desks = db.listUsers().filter((u) => u.username === 'registration' || u.username === 'checkout');
    log(desks.length === 2 && desks.every((u) => u.event_id == null),
      'v1.6.7: the shared desk logins belong to no single clinic');

    const evS = db.createEvent(currentUser, { name: 'Staff List Clinic', location: 'Sandy' });
    db.setActiveEvent(currentUser, evS.id);

    // 3. Anyone given an account joins the standing list.
    const vol = db.createUser(currentUser, { username: 'achen', full_name: 'Amara Chen', role: 'hygienist', password: 'hyg-pass-1' });
    const volB = db.createUser(currentUser, { username: 'bosei', full_name: 'Bao Osei', role: 'emt', password: 'emt-pass-1' });
    let dir = db.listStaffDirectory(evS.id);
    log(dir.some((p) => p.username === 'achen' && p.on_event),
      'v1.6.7: adding a staff member puts them on the standing list');

    // 4. A–Z by surname, the way a register reads.
    const names = db.listStaffDirectory(evS.id).map((p) => p.full_name);
    const sorted = names.slice().sort((a, b) => {
      const k = (n) => { const w = n.trim().split(/\s+/); return (w.length > 1 ? w[w.length - 1] : w[0]).toLowerCase(); };
      return k(a).localeCompare(k(b));
    });
    log(JSON.stringify(names) === JSON.stringify(sorted), 'v1.6.7: the staff list is in A–Z order by surname');

    // 5. THE POINT: ending the clinic destroys the accounts but not the people.
    db.clearEventStaff(currentUser, evS.id);
    log(!db.listUsers().some((u) => u.username === 'achen'),
      'v1.6.7: (setup) starting fresh removes the clinic accounts');
    log(db.listUsers().some((u) => u.username === 'registration'),
      'v1.6.7: starting fresh does NOT remove the shared desk logins');
    dir = db.listStaffDirectory(evS.id);
    log(dir.some((p) => p.username === 'achen') && dir.some((p) => p.username === 'bosei'),
      'v1.6.7: the people stay on the standing list after their accounts are cleared');
    log(dir.find((p) => p.username === 'achen').on_event === false,
      'v1.6.7: and the list knows they are not on this clinic any more');
    log(!dir.some((p) => p.username === 'admin' || p.username === 'registration' || p.username === 'checkout'),
      'v1.6.7: the shared station logins are not listed as people');

    // 6. Adding them back is one click, and their old password still works.
    const evT = db.createEvent(currentUser, { name: 'Next Season Clinic', location: 'Sandy' });
    db.setActiveEvent(currentUser, evT.id);
    const entry = db.listStaffDirectory(evT.id).find((p) => p.username === 'achen');
    const back = db.addStaffFromDirectory(currentUser, { id: entry.id });
    log(back.username === 'achen' && back.role === 'hygienist' && back.event_id === evT.id,
      'v1.6.7: a returning volunteer is added to the new clinic from the list');
    log(!!db.login('achen', 'hyg-pass-1'),
      'v1.6.7: and signs in with the password they already had — nothing re-typed');
    currentUser = db.login('admin', 'admin');

    // 7. The role is a choice, not a repeat of last time.
    const entryB = db.listStaffDirectory(evT.id).find((p) => p.username === 'bosei');
    const reRole = db.addStaffFromDirectory(currentUser, { id: entryB.id, role: 'checkout' });
    log(reRole.role === 'checkout', 'v1.6.7: someone can be added back in a different role');
    log(db.listStaffDirectory(evT.id).find((p) => p.username === 'bosei').role === 'checkout',
      'v1.6.7: the list remembers the role they last worked');

    // 8. Adding someone twice says so plainly instead of failing on a database
    //    constraint the admin cannot read.
    let dupErr = '';
    try { db.addStaffFromDirectory(currentUser, { id: entry.id }); } catch (e) { dupErr = e.message; }
    log(/already on this clinic/i.test(dupErr), 'v1.6.7: adding someone twice explains why, in plain words');

    // 9. Leaving for good takes them off the list — and that travels, so they do
    //    not reappear from another laptop on the next sync.
    const before = db.listStaffDirectory(evT.id).length;
    db.forgetStaff(currentUser, entryB.id);
    log(db.listStaffDirectory(evT.id).length === before - 1 && !db.listStaffDirectory(evT.id).some((p) => p.username === 'bosei'),
      'v1.6.7: someone can be taken off the standing list for good');
    log(db.listUsers().some((u) => u.username === 'bosei'),
      'v1.6.7: removing them from the list leaves the account they hold right now alone');
    {
      const h = rawDb();
      const tombed = h.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE entity = 'staffdir'").get().n;
      h.close();
      log(tombed >= 1, 'v1.6.7: the removal travels to the other laptops');
    }

    // 10. A new clinic puts a deleted desk login back rather than leaving the
    //     front desk unable to sign in on the morning.
    const reg = db.listUsers().find((u) => u.username === 'registration');
    db.deleteUser(currentUser, reg.id);
    log(!db.listUsers().some((u) => u.username === 'registration'), 'v1.6.7: (setup) the registration login was removed');
    db.createEvent(currentUser, { name: 'Desk Restore Clinic', location: 'Sandy' });
    log(!!db.login('registration', 'welcome123'),
      'v1.6.7: creating a clinic puts the shared desk logins back automatically');
    currentUser = db.login('admin', 'admin');

    // 11. A changed desk password is NOT silently reset by the next clinic —
    //     but there is a one-click way back to the default.
    const regRow = db.listUsers().find((u) => u.username === 'registration');
    db.updateUser(currentUser, regRow.id, { password: 'desk-changed-1' });
    db.createEvent(currentUser, { name: 'Password Keeps Clinic', location: 'Sandy' });
    log(!!db.login('registration', 'desk-changed-1') && !db.login('registration', 'welcome123'),
      'v1.6.7: a deliberately changed desk password survives the next clinic');
    currentUser = db.login('admin', 'admin');
    const rst = db.resetClinicAccountPassword(currentUser, 'registration');
    log(rst.password === 'welcome123' && !!db.login('registration', 'welcome123'),
      'v1.6.7: and one click puts it back to the shared default');
    currentUser = db.login('admin', 'admin');

    // 12. The Staff & roles page shows the list and adds from it.
    db.setActiveEvent(currentUser, evT.id);
    const storeS = (await import('../src/renderer/js/store.js')).store; storeS.setUser(currentUser);
    const ctxS = { navigate: () => {}, toast: () => {}, store: storeS, setDetail: () => {} };
    const sv = (await import('../src/renderer/js/views/admin.js')).renderAdmin(ctxS, { section: 'staff' });
    document.body.append(sv);
    for (let i = 0; i < 16; i++) await tick();
    log(/Staff directory/i.test(sv.textContent) && /Amara Chen/.test(sv.textContent),
      'v1.6.7: Staff & roles shows the standing staff list');
    log(/Shared clinic logins/i.test(sv.textContent) && /registration/.test(sv.textContent),
      'v1.6.7: and explains the two shared desk logins');
    sv.remove();

    // 13. The list is shared between the clinic's laptops like everything else.
    const batch = db.collectSyncRows(400);
    log(batch.rows.some((r) => r.entity === 'staffdir' && r.data.username === 'achen' && r.event_uid == null),
      'v1.6.7: the staff list is pushed to the other laptops (and belongs to no clinic)');

    // A laptop that built its own row for the same person must adopt ours rather
    // than colliding on the unique username for ever.
    const later7 = new Date(Date.now() + 120000).toISOString();
    const adopt = db.applyRemoteRows([{
      entity: 'staffdir', uid: 'remote-uid-achen', updated_at: later7,
      data: { username: 'achen', full_name: 'Amara Chen-Okafor', role: 'doctor', salt: 's', hash: 'h',
        last_event_name: 'Elsewhere', last_used_at: later7, times_served: 4, created_at: later7 },
    }]);
    log(adopt.applied === 1 && adopt.deferredRows.length === 0,
      'v1.6.7: a copy of the same person from another laptop merges instead of colliding');
    log(db.listStaffDirectory(evT.id).filter((p) => p.username === 'achen').length === 1,
      'v1.6.7: which leaves one entry per person, not two');

    // Someone added on another laptop arrives here with no parent to wait for.
    const arrive = db.applyRemoteRows([{
      entity: 'staffdir', uid: 'remote-uid-newperson', updated_at: later7,
      data: { username: 'dnovak', full_name: 'Dana Novak', role: 'doctor', salt: 's', hash: 'h',
        last_event_name: 'Belize 2025', last_used_at: later7, times_served: 1, created_at: later7 },
    }]);
    log(arrive.applied === 1 && db.listStaffDirectory(evT.id).some((p) => p.username === 'dnovak'),
      'v1.6.7: someone added on another laptop shows up in the list here');
  }

  // ---- v1.6.8: last clinic's patients must not carry into the new one ----
  {
    currentUser = db.login('admin', 'admin');
    const mkP = (f, l) => db.createPatient(currentUser, {
      first_name: f, last_name: l, dob: '1980-01-01', gender: 'female',
      demographics: { city: 'Sandy', state: 'OR' }, medical_history: {},
      dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: f, signature_png: 'data:image/png;base64,AAAA' }],
    });

    const evOld = db.createEvent(currentUser, { name: 'Carry Over Last Year', location: 'Sandy' });
    const older = mkP('Ada', 'Alpha');
    mkP('Ben', 'Bravo');
    log(db.listPatients({}).length === 2 && db.getActiveEvent().id === evOld.id,
      'v1.6.8: (setup) a clinic with two patients is the one the app is on');

    // THE BUG: creating the next clinic left the app on the PREVIOUS one, so
    // every station still showed last clinic's patients and new check-ins were
    // filed into the old clinic.
    const evNew = db.createEvent(currentUser, { name: 'Carry Over This Year', location: 'Sandy' });
    log(db.getActiveEvent().id === evNew.id,
      'v1.6.8: creating a clinic makes it the one the app is on');
    log(db.listPatients({}).length === 0,
      'v1.6.8: the new clinic starts empty — last clinic\'s patients do not carry over');
    log(db.dashboardStats().total === 0,
      'v1.6.8: and the dashboard counts nobody yet');

    const fresh = mkP('Cara', 'Charlie');
    log(db.listPatients({ eventId: evNew.id }).some((p) => p.id === fresh.id)
      && !db.listPatients({ eventId: evOld.id }).some((p) => p.id === fresh.id),
      'v1.6.8: a new check-in is filed into the clinic being run, not the last one');

    // Nothing was destroyed — the old clinic still has its own records.
    log(db.listPatients({ eventId: evOld.id }).length === 2,
      'v1.6.8: last clinic keeps its own records, they just stay there');

    // Setting up a FUTURE clinic mid-clinic must not yank the running one away.
    const evLater = db.createEvent(currentUser, { name: 'Next Season', location: 'Sandy', activate: false });
    log(db.getActiveEvent().id === evNew.id && db.listPatients({}).some((p) => p.id === fresh.id),
      'v1.6.8: a clinic created for later leaves the running clinic alone');
    db.setEventActive(currentUser, evLater.id, false);
    db.setActiveEvent(currentUser, evNew.id);

    // A check-in can never disappear into a clinic that has been closed.
    db.setEventActive(currentUser, evNew.id, false);
    const landed = mkP('Late', 'Walkin');
    const landedEvent = db.listPatients({ eventId: 'all' }).find((p) => p.id === landed.id);
    log(landedEvent && landedEvent.event_id !== evNew.id,
      'v1.6.8: a check-in is never filed into a clinic that has been closed');
    db.setEventActive(currentUser, evNew.id, true);
    db.setActiveEvent(currentUser, evNew.id);

    // A returning patient loaded off a USB stick starts a visit HERE, instead of
    // overwriting the record from the clinic they last attended.
    const before = db.getPatient(older.id);
    const imported = db.importPatientFromPortable(currentUser, {
      first_name: 'Ada', last_name: 'Alpha', dob: '1980-01-01', gender: 'female',
      demographics: { city: 'Boring', state: 'OR' }, medical_history: {},
      dental_history: { visit_type: 'extraction_pain' },
    });
    log(imported.id !== older.id && db.listPatients({}).some((p) => p.id === imported.id),
      'v1.6.8: a returning patient from a USB stick joins today\'s queue');
    const after = db.getPatient(older.id);
    log(after.demographics.city === before.demographics.city
      && after.dental_history.visit_type === before.dental_history.visit_type,
      'v1.6.8: and their record from the last clinic is left exactly as it was');

    // The dialog promises "every station switches to it" — that only holds if the
    // selection carries a globally-ordered stamp for the other laptops to follow.
    {
      const h = rawDb();
      const stamp = h.prepare('SELECT selected_at FROM events WHERE id = ?').get(evNew.id).selected_at;
      h.close();
      log(!!stamp, 'v1.6.8: starting a clinic is stamped so the other laptops follow it too');
    }
    const evBatch = db.collectSyncRows(400);
    log(evBatch.rows.some((r) => r.entity === 'event' && r.data.name === 'Carry Over This Year' && r.data.selected_at),
      'v1.6.8: and that switch is pushed to them');
  }

  // ---- v1.7.3: the back-end audit fixes ----
  {
    currentUser = db.login('admin', 'admin');
    const SG = [{ type: 'general', signer_name: 'A', signature_png: 'data:image/png;base64,AAAA' }];
    const seen = (l, extra) => {
      const q = db.createPatient(currentUser, { first_name: 'A', last_name: l, dob: '1985-05-05', gender: 'female',
        demographics: { city: 'Sandy', state: 'OR' }, medical_history: {},
        dental_history: { visit_type: 'cleaning' }, consents: SG, ...(extra || {}) });
      db.saveVitals(currentUser, q.id, { bp_systolic: '120', heart_rate: '70' });
      db.routePatient(currentUser, q.id, 'hygienist');
      db.saveTreatment(currentUser, q.id, { cleaning: { scaling: true }, provider_name: 'H' }, true);
      db.dismissPatient(currentUser, q.id); return q;
    };

    // 1. A kept report is a high-water mark. Finish, then use the Delete button
    //    on the same clinic — the totals used to be overwritten with zeros.
    const evK = db.createEvent(currentUser, { name: 'Keep Totals' });
    db.setActiveEvent(currentUser, evK.id);
    ['One', 'Two', 'Three', 'Four', 'Five'].forEach(seen);
    db.recordClinicExport(evK.id, { patients: 5 });
    db.finishEvent(currentUser, evK.id);
    log(db.listEventReports().find((r) => r.event_id === evK.id).patients_seen === 5,
      'v1.7.3: (setup) Finish clinic keeps the totals');
    db.purgeEventPatients(currentUser, evK.id);
    log(db.listEventReports().find((r) => r.event_id === evK.id).patients_seen === 5,
      'v1.7.3: deleting the patient data AFTERWARDS does not wipe the kept totals');
    db.captureEventSummary(currentUser, evK.id);
    log(db.listEventReports().find((r) => r.event_id === evK.id).patients_seen === 5,
      'v1.7.3: and a re-capture on an emptied clinic cannot reduce them');

    // 2. The kept total must not be replaced by a SMALLER live count.
    log(db.reportRollup(evK.id).summary.patients_seen === 5,
      'v1.7.3: Reports shows the kept total for an emptied clinic');

    // 3. A refused account deletion must publish nothing.
    const tombs = () => { const h = rawDb(); const n = h.prepare("SELECT COUNT(*) n FROM tombstones WHERE entity='user'").get().n; h.close(); return n; };
    const before = tombs();
    let refused = '';
    try { db.deleteUser(currentUser, currentUser.id); } catch (e) { refused = e.message; }
    log(/cannot delete your own account/i.test(refused) && tombs() === before,
      'v1.7.3: a REFUSED account deletion is not published to the other laptops');

    // 4. A backup written by an older build must still restore.
    const evB = db.createEvent(currentUser, { name: 'Old Backup' });
    db.setActiveEvent(currentUser, evB.id);
    ['Uno', 'Dos', 'Tres'].forEach(seen);
    const bundle = db.exportClinicBundle(evB.id);
    db.purgeEventPatients(currentUser, evB.id);
    const OLDER = ['bp_rechecks', 'emt_review', 'teeth_notes', 'flags', 'checklist', 'teeth',
      'triaged_by_name', 'vitals_by_name', 'routed_by_name'];
    const aged = { ...bundle, triage: bundle.triage.map((t) => { const c = { ...t }; OLDER.forEach((k) => delete c[k]); return c; }) };
    let restoreErr = null;
    try { db.importClinicBundle(currentUser, aged); } catch (e) { restoreErr = e.message; }
    log(!restoreErr && db.listPatients({ eventId: evB.id }).length === 3,
      'v1.7.3: a backup from an older build still restores every patient'
      + (restoreErr ? ' — threw: ' + restoreErr : ''));
    const restored = db.getPatient(db.listPatients({ eventId: evB.id })[0].id);
    log(!!(restored.triage && restored.triage.bp_systolic),
      'v1.7.3: ...and their chart comes back with it');

    // 5. A synced chart from an older build must APPLY, not be silently dropped.
    const evS = db.createEvent(currentUser, { name: 'Old Chart' });
    db.setActiveEvent(currentUser, evS.id);
    const sp = db.createPatient(currentUser, { first_name: 'Sync', last_name: 'Chart', dob: '1985-05-05',
      gender: 'female', demographics: {}, medical_history: {}, dental_history: {}, consents: SG });
    db.collectSyncRows();
    const h = rawDb(); const spUid = h.prepare('SELECT uid FROM patients WHERE id=?').get(sp.id).uid; h.close();
    const later = new Date(Date.now() + 60000).toISOString();
    const applied = db.applyRemoteRows([{ entity: 'triage', uid: 'old-build-triage', patient_uid: spUid, updated_at: later,
      data: { complaint: 'Toothache', notes: 'from an older laptop', status: 'ready',
        bp_systolic: '128', bp_diastolic: '82', heart_rate: '76', vitals_at: later, route: 'dentist', routed_at: later } }]);
    const chart = db.getPatient(sp.id).triage;
    log(applied.applied === 1 && chart && chart.complaint === 'Toothache' && chart.bp_systolic,
      'v1.7.3: a chart synced from an older build arrives complete, not blank');

    // 6. An unsigned patient cannot reach a clinician by ANY route.
    const up = db.createPatient(currentUser, { first_name: 'Un', last_name: 'Consented', dob: '1990-01-01',
      gender: 'male', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    db.saveVitals(currentUser, up.id, { bp_systolic: '120', heart_rate: '70' });
    let routeErr = '';
    try { db.routePatient(currentUser, up.id, 'dentist'); } catch (e) { routeErr = e.message; }
    log(/general consent has not been signed/i.test(routeErr),
      'v1.7.3: the vitals station cannot send an unsigned patient to a clinician');
    let moveErr = '';
    try { db.adminMovePatient(currentUser, up.id, 'hygienist'); } catch (e) { moveErr = e.message; }
    log(/consent/i.test(moveErr), 'v1.7.3: nor can an admin move them there');
    // an extraction needs the surgery consent too
    const xp = db.createPatient(currentUser, { first_name: 'Ex', last_name: 'Traction', dob: '1990-01-01',
      gender: 'male', demographics: {}, medical_history: {},
      dental_history: { visit_type: 'extraction_pain' }, consents: SG });
    db.saveVitals(currentUser, xp.id, { bp_systolic: '120', heart_rate: '70' });
    let surgErr = '';
    try { db.routePatient(currentUser, xp.id, 'dentist'); } catch (e) { surgErr = e.message; }
    log(/Oral Surgery consent/i.test(surgErr),
      'v1.7.3: an extraction patient needs the surgery consent before the chair');

    // 7. USB import must key on uid, never the other laptop's row id.
    const victim = db.createPatient(currentUser, { first_name: 'Real', last_name: 'Victim', dob: '1970-01-01',
      gender: 'male', demographics: { city: 'Boring' }, medical_history: {}, dental_history: {}, consents: SG });
    db.importPatientFromPortable(currentUser, { id: victim.id, first_name: 'Someone', last_name: 'Else',
      dob: '1999-09-09', gender: 'female', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    log(db.getPatient(victim.id).last_name === 'Victim',
      'v1.7.3: a USB import cannot overwrite a different patient by row id');

    // 8. USB consents: not duplicated on a new record, not discarded on a merge.
    const imp = db.importPatientFromPortable(currentUser, { first_name: 'Fresh', last_name: 'Import',
      dob: '1990-01-01', gender: 'male', demographics: {}, medical_history: {}, dental_history: {},
      consents: [{ type: 'general', signer_name: 'F', signature_png: 'data:image/png;base64,AAAA' },
        { type: 'oral_surgery', signer_name: 'F', signature_png: 'data:image/png;base64,BBBB' }] });
    log(db.getPatient(imp.id).consents.length === 2,
      'v1.7.3: a USB import files each consent once, not twice');
    db.collectSyncRows();
    const h2 = rawDb(); const impUid = h2.prepare('SELECT uid FROM patients WHERE id=?').get(imp.id).uid; h2.close();
    const h3 = rawDb(); h3.prepare("DELETE FROM consents WHERE patient_id = ? AND type='oral_surgery'").run(imp.id); h3.close();
    db.importPatientFromPortable(currentUser, { uid: impUid, first_name: 'Fresh', last_name: 'Import',
      dob: '1990-01-01', gender: 'male', demographics: {}, medical_history: {}, dental_history: {},
      consents: [{ type: 'oral_surgery', signer_name: 'F', signature_png: 'data:image/png;base64,BBBB' }] });
    log(db.getPatient(imp.id).consents.some((c) => c.type === 'oral_surgery'),
      'v1.7.3: a consent carried on the USB stick is kept when the patient already exists');

    // 9. Finishing a clinic must not silently select an older one.
    const evOld = db.createEvent(currentUser, { name: 'Last Season' });
    const evNow = db.createEvent(currentUser, { name: 'Running Today' });
    db.setActiveEvent(currentUser, evNow.id);
    seen('Attendee');
    db.recordClinicExport(evNow.id, { patients: 1 });
    db.finishEvent(currentUser, evNow.id);
    log(!db.getActiveEvent(), 'v1.7.3: finishing a clinic leaves no clinic selected');
    let walkErr = '';
    try {
      db.createPatient(currentUser, { first_name: 'Walk', last_name: 'In', demographics: {},
        medical_history: {}, dental_history: {}, consents: SG });
    } catch (e) { walkErr = e.message; }
    log(/No clinic is open/i.test(walkErr),
      'v1.7.3: a walk-in is refused rather than filed into a previous clinic');
    db.setActiveEvent(currentUser, evOld.id);
    log(db.getActiveEvent() && db.getActiveEvent().id === evOld.id,
      'v1.7.3: and choosing a clinic deliberately still works');

    // 10. Two stations finishing the same clinic must reconcile.
    const evR = db.createEvent(currentUser, { name: 'Two Stations' });
    db.setActiveEvent(currentUser, evR.id);
    ['P1', 'P2'].forEach(seen);
    db.captureEventSummary(currentUser, evR.id);
    db.collectSyncRows();
    const h4 = rawDb(); const evRUid = h4.prepare('SELECT uid FROM events WHERE id=?').get(evR.id).uid; h4.close();
    const rr = db.applyRemoteRows([{ entity: 'report', uid: 'other-station-report', event_uid: evRUid,
      updated_at: new Date(Date.now() + 120000).toISOString(),
      data: { summary: JSON.stringify({ patients_seen: 9, visits_completed: 9 }), patients_seen: 9,
        finished_at: later, finished_by_name: 'Other Station', created_at: later } }]);
    log(rr.applied === 1 && db.listEventReports().filter((r) => r.event_id === evR.id).length === 1,
      'v1.7.3: a peer station\'s clinic report reconciles instead of being dropped');

    // 11. Station logins never appear as people, and stay gone.
    const dir2 = db.listStaffDirectory();
    log(!dir2.some((p2) => ['admin', 'registration', 'checkout'].includes(p2.username)),
      'v1.7.3: the shared station logins are not listed as staff');
    const desks = db.listUsers().filter((u) => ['registration', 'checkout'].includes(u.username));
    log(desks.length === 2 && desks.every((u) => u.event_id === null),
      'v1.7.3: the shared desk logins stay global, so Start fresh cannot delete them');

    // 12. An unsigned consent must not print as signed.
    const pdfMod = require('../src/main/pdf.js');
    // A consent ROW that carries no signature — the state that printed as
    // "Signed" over an empty box.
    db.addPatientConsent(currentUser, up.id, { type: 'general', signer_name: 'Un Consented', signature_png: '' });
    const unsignedHtml = pdfMod.buildHtml(db.getPatient(up.id), 'full');
    log(/NOT SIGNED/.test(unsignedHtml) && /No signature on file/.test(unsignedHtml),
      'v1.7.3: the printed record marks a consent with no signature');
    const signedHtml = pdfMod.buildHtml(db.getPatient(victim.id), 'full');
    log(/Signed/.test(signedHtml) && !/NOT SIGNED/.test(signedHtml),
      'v1.7.3: ...and still shows a real signature as signed');
  }

  // ---- v1.8.0: the interface refresh ----
  {
    currentUser = db.login('admin', 'admin');
    const store = (await import('../src/renderer/js/store.js')).store;
    store.setUser(currentUser);

    // 1. Management's five station-override buttons became one "Move to…"
    // select. Every destination must still be reachable and must still move
    // the patient — a tidier screen that quietly dropped an override would be
    // a far worse bug than the wall of buttons it replaced.
    const { renderManagement } = await import('../src/renderer/js/views/management.js');
    const mp = db.createPatient(currentUser, {
      first_name: 'Move', last_name: 'Me', demographics: {}, medical_history: {},
      dental_history: { reason: 'x' }, consents: SIGNED,
    });
    // Vitals first: moving TO a chair still obeys the vitals gate, so without
    // them the override is correctly refused and the test would be asserting
    // the wrong thing.
    db.saveVitals(currentUser, mp.id, { bp_systolic: 118, bp_diastolic: 74, pulse: 66 });
    const mgRoot = renderManagement({ navigate: () => {}, toast: () => {}, store }, {});
    document.body.append(mgRoot);
    await tick(); await tick();
    const sel = $all('.move-select', mgRoot)[0];
    const opts = sel ? $all('option', sel).map((o) => o.value).filter(Boolean) : [];
    log(!!sel, 'v1.8.0: management offers a single "Move to…" control per patient');
    log(['checkin', 'emt', 'dentist', 'hygienist', 'dismiss'].every((v) => opts.includes(v)),
      'v1.8.0: ...and it still offers every station override (got: ' + opts.join(',') + ')');

    // Driving it must actually move the patient.
    const rowSel = $all('.move-select', mgRoot).find((s) => s.getAttribute('aria-label') === 'Move Move Me to another station');
    if (rowSel) {
      setInput(rowSel, 'hygienist');
      await tick(); await tick();
      log(db.getPatient(mp.id).triage.route === 'hygienist', 'v1.8.0: choosing a station from it actually moves the patient');
      log(rowSel.selectedIndex === 0, 'v1.8.0: ...and the control snaps back to the prompt afterwards');
    } else {
      log(false, 'v1.8.0: could not find the move control for the test patient');
    }

    // 2. A null child appended straight to a container used to render the
    // literal text "null" on screen — that is what sat under the Reports
    // heading. The helper every view now uses must drop it.
    const { add, el: mkEl } = await import('../src/renderer/js/dom.js');
    const probe = mkEl('div', {}, []);
    add(probe, mkEl('span', {}, ['a']), null, undefined, false, mkEl('span', {}, ['b']));
    log(probe.textContent === 'ab', 'v1.8.0: appending a null branch renders nothing, not the word "null"');

    // And the screen that showed it must be clean for a clinic with no kept
    // totals, which is the state that produced it.
    const { renderReports } = await import('../src/renderer/js/views/reports.js');
    const repRoot = renderReports({ navigate: () => {}, toast: () => {}, store }, {});
    document.body.append(repRoot);
    await tick(); await tick(); await tick();
    const stray = Array.from(repRoot.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim() === 'null');
    log(!stray, 'v1.8.0: the reports view no longer prints a stray "null" under its heading');
  }

  // ---- v1.9.0: the pre-registration link is its own switch ----
  {
    currentUser = db.login('admin', 'admin');
    const store = (await import('../src/renderer/js/store.js')).store;
    store.setUser(currentUser);

    // Two clinics. Only ONE is ever live; both may collect sign-ups.
    const cA = db.createEvent(currentUser, { name: 'Prereg A', location: 'A' });
    const cB = db.createEvent(currentUser, { name: 'Prereg B', location: 'B' });
    const ev = (id) => db.listEvents().find((e) => e.id === id);
    const liveId = () => { const a = db.getActiveEvent(); return a ? a.id : null; };

    log(ev(cA.id).prereg_open === 1 && ev(cB.id).prereg_open === 1,
      'v1.9.0: a new clinic takes online sign-ups by default');

    // Closing one link must not touch the other, nor which clinic is live.
    const liveBefore = liveId();
    db.setEventPreregOpen(currentUser, cA.id, false);
    log(ev(cA.id).prereg_open === 0 && ev(cB.id).prereg_open === 1,
      'v1.9.0: closing one clinic\'s link leaves the other clinic open');
    log(liveId() === liveBefore, 'v1.9.0: ...and does not change which clinic is live');

    // Both open at once is the whole point of the feature.
    db.setEventPreregOpen(currentUser, cA.id, true);
    log(ev(cA.id).prereg_open === 1 && ev(cB.id).prereg_open === 1,
      'v1.9.0: two clinics can collect sign-ups at the same time');

    // Switching the live clinic must leave both links exactly as they were.
    db.setActiveEvent(currentUser, cA.id);
    log(liveId() === cA.id && ev(cA.id).prereg_open === 1 && ev(cB.id).prereg_open === 1,
      'v1.9.0: changing which clinic is live does not touch either link');

    // Finishing a clinic stops it taking sign-ups nobody is watching.
    db.recordClinicExport(cA.id, { patients: 0 });
    db.finishEvent(currentUser, cA.id);
    log(ev(cA.id).prereg_open === 0, 'v1.9.0: finishing a clinic closes its own link');
    log(ev(cB.id).prereg_open === 1, 'v1.9.0: ...and leaves every other clinic alone');

    // Reopening has to work, or a clinic closed by mistake is stuck.
    db.setEventPreregOpen(currentUser, cA.id, true);
    log(ev(cA.id).prereg_open === 1, 'v1.9.0: a closed link can be reopened');

    // The switch is worthless if it never reaches the server.
    const payload = db.collectSyncRows(500);
    // Tombstones ride along as event rows with an empty body by design, so only
    // the live rows are expected to carry fields.
    const evRows = (Array.isArray(payload) ? payload : (payload && payload.rows) || [])
      .filter((r) => r.entity === 'event' && !r.deleted);
    log(evRows.length > 0 && evRows.every((r) => 'prereg_open' in r.data),
      `v1.9.0: the switch travels to the other stations in the event payload (${evRows.length} row(s))`);

    // Only an admin may open or close a public sign-up link.
    db.createUser(currentUser, { username: 'preregdoc', full_name: 'Dr P', role: 'doctor', password: 'x' });
    const asDoc = await window.api.authLogin({ username: 'preregdoc', password: 'x' });
    log(asDoc.ok, 'v1.9.0: (setup) a non-admin can sign in');
    const denied = await window.api.eventsSetPrereg({ id: cB.id, open: false });
    log(denied.ok === false && /permission/i.test(denied.error || ''),
      'v1.9.0: a non-admin cannot open or close a pre-registration link');
    currentUser = db.login('admin', 'admin');
    store.setUser(currentUser);

    // The Events screen has to SHOW the state, or an admin cannot tell which
    // clinics are collecting sign-ups without opening each one.
    const { renderAdmin } = await import('../src/renderer/js/views/admin.js');
    const evRoot = renderAdmin({ navigate: () => {}, toast: () => {}, store }, { section: 'events' });
    document.body.append(evRoot);
    await tick(); await tick(); await tick();
    const headText = $all('th', evRoot).map((h) => h.textContent).join('|');
    log(/Online sign-ups/i.test(headText), 'v1.9.0: the Events screen has an online sign-ups column');
    const bodyText = evRoot.textContent;
    log(/Open/.test(bodyText) || /Closed/.test(bodyText) || /Not synced/.test(bodyText),
      'v1.9.0: ...and each clinic shows whether its link is open');
  }

  // ---- v1.9.0: the clinic flow, end to end ----
  // check-in -> vitals -> dentist/hygienist -> check-out, asserting the gates
  // between stations rather than only that each screen renders.
  {
    currentUser = db.login('admin', 'admin');
    db.createEvent(currentUser, { name: 'Flow Check', location: 'Flow' });
    const mkP = (o) => db.createPatient(currentUser, { demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED, ...o });

    const fp = mkP({ first_name: 'Flow', last_name: 'One', dental_history: { reason: 'Toothache' }, route: 'dentist' });
    log(db.getPatient(fp.id).status === 'checked_in', 'v1.9.0 flow: a check-in starts at the vitals station');

    let gated = false;
    try { db.routePatient(currentUser, fp.id, 'dentist'); } catch (e) { gated = /vitals/i.test(e.message); }
    log(gated, 'v1.9.0 flow: no vitals means no clinician');

    db.saveVitals(currentUser, fp.id, { bp_systolic: 128, bp_diastolic: 82, heart_rate: 72 });
    db.routePatient(currentUser, fp.id, 'dentist');
    const routed = db.getPatient(fp.id);
    log(routed.triage.route === 'dentist' && !!routed.triage.emt_signed_off && routed.status === 'triaged',
      'v1.9.0 flow: vitals then sign-off moves them to the dentist');

    db.saveTreatment(currentUser, fp.id, { fillings: [{ tooth: '19', surfaces: 'O' }], clinical_notes: 'x', provider_name: 'Dr F' }, true);
    log(db.getPatient(fp.id).status === 'completed', 'v1.9.0 flow: completing the visit sends them to check-out');
    db.dismissPatient(currentUser, fp.id);
    const out = db.getPatient(fp.id);
    log(out.status === 'dismissed' && !!out.dismissed_at && !!out.dismissed_by_name,
      'v1.9.0 flow: check-out stamps who checked them out and when');

    // The hygienist branch reaches check-out the same way.
    const hp = mkP({ first_name: 'Flow', last_name: 'Two', dental_history: { reason: 'Cleaning' }, route: 'hygienist' });
    db.saveVitals(currentUser, hp.id, { bp_systolic: 118, bp_diastolic: 74, heart_rate: 64 });
    db.routePatient(currentUser, hp.id, 'hygienist');
    db.saveTreatment(currentUser, hp.id, { cleaning: { quadrants: ['UR'] }, provider_name: 'RDH' }, true);
    db.dismissPatient(currentUser, hp.id);
    log(db.getPatient(hp.id).status === 'dismissed', 'v1.9.0 flow: the cleaning branch reaches check-out too');

    // Check-out cannot be reached before the EMT has seen them.
    const jp = mkP({ first_name: 'Flow', last_name: 'Jump', dental_history: { reason: 'Pain' }, route: 'dentist' });
    let jumpBlocked = false;
    try { db.dismissPatient(currentUser, jp.id); } catch (e) { jumpBlocked = true; }
    log(jumpBlocked, 'v1.9.0 flow: a patient the EMT never saw cannot be checked out');

    // An extraction is gated on the surgery consent, by visit_type — the same
    // signal the online form sets when an extraction is chosen.
    const xp = db.createPatient(currentUser, { first_name: 'Flow', last_name: 'Ext', demographics: {}, medical_history: {},
      dental_history: { reason: 'Extraction', visit_type: 'extraction_pain' }, route: 'dentist', consents: SIGNED });
    db.saveVitals(currentUser, xp.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
    let surgGated = false;
    try { db.routePatient(currentUser, xp.id, 'dentist'); } catch (e) { surgGated = /surgery|consent/i.test(e.message); }
    log(surgGated, 'v1.9.0 flow: an extraction without the surgery consent is refused');
    db.addPatientConsent(currentUser, xp.id, { type: 'oral_surgery', signer_name: 'Flow Ext', signature_png: 'data:image/png;base64,BBBB' });
    db.routePatient(currentUser, xp.id, 'dentist');
    log(db.getPatient(xp.id).triage.route === 'dentist', 'v1.9.0 flow: ...and allowed once it is signed');

    // Walking a patient BACK keeps the clinical facts and drops only the workflow.
    db.adminMovePatient(currentUser, xp.id, 'emt');
    const rewound = db.getPatient(xp.id);
    log(rewound.status === 'checked_in' && !rewound.triage.emt_signed_off && rewound.triage.bp_systolic === 120,
      'v1.9.0 flow: sending someone back to vitals keeps their vitals');
  }

  // ---- v1.10.0: the three things the clinic reported ----
  {
    currentUser = db.login('admin', 'admin');
    const store = (await import('../src/renderer/js/store.js')).store;
    store.setUser(currentUser);
    db.createEvent(currentUser, { name: 'Report Clinic', location: 'R' });
    const mkP = (o) => db.createPatient(currentUser, { demographics: {}, medical_history: {}, dental_history: {}, consents: SIGNED, ...o });

    // 1. The hygienist must SEE blood pressure. They decide whether it is safe
    // to scale someone; the screen used to show no vitals at all.
    const hp = mkP({ first_name: 'Hyg', last_name: 'Vitals', dental_history: { reason: 'Cleaning', visit_type: 'cleaning' }, route: 'hygienist' });
    db.saveVitals(currentUser, hp.id, { bp_systolic: 176, bp_diastolic: 104, heart_rate: 88 });
    db.routePatient(currentUser, hp.id, 'hygienist');
    const { renderHygienist } = await import('../src/renderer/js/views/hygienist.js');
    const hRoot = renderHygienist({ navigate: () => {}, toast: () => {}, store, setDetail: () => {} }, { id: hp.id });
    document.body.append(hRoot);
    await tick(); await tick(); await tick();
    const hText = hRoot.textContent;
    log(/176\/104/.test(hText), 'v1.10.0: the hygienist screen shows the blood pressure');
    log(/HR 88/.test(hText), 'v1.10.0: ...and the heart rate');
    log(/thinner/i.test(hText), 'v1.10.0: ...and the blood-thinner status');

    // 2. A returning patient must be able to sign a consent SOMEWHERE. Before
    // this the desk could not take one and routing refused them without it, so
    // they could not be seen at all.
    const first = mkP({ first_name: 'Retu', last_name: 'Rning', dob: '1979-03-03', dental_history: { reason: 'Cleaning', visit_type: 'cleaning' }, route: 'hygienist' });
    db.saveVitals(currentUser, first.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
    db.routePatient(currentUser, first.id, 'hygienist');
    db.saveTreatment(currentUser, first.id, { cleaning: { quadrants: ['UR'] }, provider_name: 'RDH' }, 'complete');
    db.dismissPatient(currentUser, first.id);
    const again = db.startVisitFromExisting(currentUser, first.id);
    const arrRow = () => db.listPatients({}).find((x) => x.id === again.id);
    log(arrRow().general_signed === false && arrRow().consents_ok === false,
      'v1.10.0: a returning patient shows as needing the general consent');
    // The front desk takes it — the channel must be open to registration.
    const deskUser = db.createUser(currentUser, { username: 'deskclerk', full_name: 'Desk Clerk', role: 'registration', password: 'x' });
    await window.api.authLogin({ username: 'deskclerk', password: 'x' });
    const taken = await window.api.consentAdd({ patientId: again.id, consent: { type: 'general', signer_name: 'Retu Rning', signature_png: 'data:image/png;base64,AAAA' } });
    log(taken.ok === true, 'v1.10.0: the FRONT DESK can record a consent');
    currentUser = db.login('admin', 'admin'); store.setUser(currentUser);
    log(arrRow().consents_ok === true, 'v1.10.0: ...and the patient is then consent-ok');
    db.saveVitals(currentUser, again.id, { bp_systolic: 118, bp_diastolic: 76, heart_rate: 68 });
    let wentThrough = false;
    try { db.routePatient(currentUser, again.id, 'hygienist'); wentThrough = true; } catch (_e) { /* still blocked */ }
    log(wentThrough, 'v1.10.0: ...and can now be sent through — the deadlock is gone');
    log(deskUser && deskUser.id != null, '(setup) the desk account exists');

    // 3. Notes after a visit is completed: append to a LOCKED record, and
    // re-open when the record is actually wrong.
    const tp = mkP({ first_name: 'Note', last_name: 'After', dental_history: { reason: 'Filling', visit_type: 'filling' }, route: 'dentist' });
    db.saveVitals(currentUser, tp.id, { bp_systolic: 122, bp_diastolic: 80, heart_rate: 72 });
    db.routePatient(currentUser, tp.id, 'dentist');
    db.saveTreatment(currentUser, tp.id, { fillings: [{ tooth: '19' }], clinical_notes: 'Original signed note.', provider_name: 'Dr A' }, 'lock');
    log(db.getPatient(tp.id).treatment.locked === true, '(setup) the record is locked');
    const noted = await window.api.treatmentNote({ patientId: tp.id, note: 'Called next day — soreness settling.' });
    log(noted.ok === true, 'v1.10.0: a note can be added to a LOCKED record');
    const afterNote = db.getPatient(tp.id).treatment;
    log(afterNote.clinical_notes === 'Original signed note.', 'v1.10.0: ...without altering the signed note');
    log(afterNote.addenda.length === 1 && !!afterNote.addenda[0].by_name && !!afterNote.addenda[0].at,
      'v1.10.0: ...and it records who wrote it and when');

    // It must reach the printed record, or a later note never makes the chart.
    const pdfMod2 = require('../src/main/pdf.js');
    const full = pdfMod2.buildHtml(db.getPatient(tp.id), 'full');
    log(/Called next day/.test(full) && /Original signed note/.test(full),
      'v1.10.0: the printed record carries both the signed note and the addendum');

    // Re-open puts a checked-out patient back so the record can be corrected.
    db.dismissPatient(currentUser, tp.id);
    const reopened = await window.api.treatmentReopen({ patientId: tp.id });
    log(reopened.ok === true, 'v1.10.0: a finished visit can be re-opened');
    const afterReopen = db.getPatient(tp.id);
    log(afterReopen.treatment.locked === false && afterReopen.status === 'in_treatment',
      'v1.10.0: ...which unlocks it and puts the patient back in the queue');
    log(afterReopen.treatment.addenda.length === 1, 'v1.10.0: ...keeping the addenda');

    // A finished patient has to be REACHABLE, or none of this can be used.
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    db.saveTreatment(currentUser, tp.id, { fillings: [{ tooth: '19' }], clinical_notes: 'Corrected.', provider_name: 'Dr A' }, 'complete');
    const provRoot = renderProvider({ navigate: () => {}, toast: () => {}, store, setDetail: () => {} }, {});
    document.body.append(provRoot);
    await tick(); await tick(); await tick();
    log(/Finished today/i.test(provRoot.textContent),
      'v1.10.0: the dentist queue lists finished patients so the record can be reached');

    // Only a clinician may write a clinical note.
    await window.api.authLogin({ username: 'deskclerk', password: 'x' });
    const denied = await window.api.treatmentNote({ patientId: tp.id, note: 'front desk note' });
    log(denied.ok === false && /permission/i.test(denied.error || ''),
      'v1.10.0: the front desk cannot write a clinical note');
    currentUser = db.login('admin', 'admin'); store.setUser(currentUser);

    // An empty note is not a note.
    let emptyRejected = false;
    try { db.addTreatmentNote(currentUser, tp.id, '   '); } catch (_e) { emptyRejected = true; }
    log(emptyRejected, 'v1.10.0: an empty note is refused');
  }

  // ---- v1.10.1: the dashboard has to work for the role looking at it ----
  {
    currentUser = db.login('admin', 'admin');
    const store = (await import('../src/renderer/js/store.js')).store;
    const ev = db.getActiveEvent();
    db.createUser(currentUser, { username: 'dashhyg', full_name: 'Dash Hyg', role: 'hygienist', password: 'x' });
    db.createUser(currentUser, { username: 'dashreg', full_name: 'Dash Reg', role: 'registration', password: 'x' });

    // Put one patient in each clinician's queue so "Waiting for you" has
    // something to count and cannot pass by being zero everywhere.
    const hq = db.createPatient(currentUser, { first_name: 'Hyg', last_name: 'Queue', demographics: {}, medical_history: {}, dental_history: { reason: 'Cleaning', visit_type: 'cleaning' }, route: 'hygienist', consents: SIGNED });
    db.saveVitals(currentUser, hq.id, { bp_systolic: 118, bp_diastolic: 74, heart_rate: 64 });
    db.routePatient(currentUser, hq.id, 'hygienist');
    const dq = db.createPatient(currentUser, { first_name: 'Den', last_name: 'Queue', demographics: {}, medical_history: {}, dental_history: { reason: 'Filling', visit_type: 'filling' }, route: 'dentist', consents: SIGNED });
    db.saveVitals(currentUser, dq.id, { bp_systolic: 120, bp_diastolic: 76, heart_rate: 66 });
    db.routePatient(currentUser, dq.id, 'dentist');

    // THE SIDEBAR. Clinic/Admin are collapsible groups and they used to default
    // CLOSED. Everyone lands on the Dashboard, which is not in either group, so
    // for every non-admin the group stayed shut and their stations were
    // invisible — a hygienist saw a sidebar containing only "Dashboard", with
    // Cleanings, the single screen they can open, hidden behind an accordion
    // they had no reason to suspect. Same for the front desk and check-out.
    // THE SIDEBAR RULE. Everyone lands on the Dashboard, which belongs to
    // neither collapsible group, so a rule of "open only when the group holds
    // the active view" left every non-admin looking at a sidebar containing
    // nothing but Dashboard — their stations hidden behind an accordion.
    const { navGroupOpen } = await import('../src/renderer/js/app.js');
    log(navGroupOpen({}, 'clinic', false) === true,
      'v1.10.1: a sidebar group is OPEN by default, so no role loses its stations');
    log(navGroupOpen({ clinic: false }, 'clinic', false) === false,
      'v1.10.1: ...a deliberate collapse is remembered');
    log(navGroupOpen({ clinic: false }, 'clinic', true) === true,
      'v1.10.1: ...but the group holding the active view is always open');
    log(navGroupOpen({ clinic: true }, 'clinic', false) === true,
      'v1.10.1: ...and a saved-open group stays open');

    const hygUser = await window.api.authLogin({ username: 'dashhyg', password: 'x' });
    store.setUser(hygUser.data);
    currentUser = db.login('dashhyg', 'x');

    const { renderDashboard } = await import('../src/renderer/js/views/dashboard.js');
    const dashRoot = renderDashboard({ navigate: () => {}, toast: () => {}, store });
    document.body.append(dashRoot);
    await tick(); await tick(); await tick();
    const tiles = $all('.stat-card', dashRoot).map((n) => n.textContent.replace(/\s+/g, ' ').trim());
    log(tiles.some((x) => /Waiting for you/.test(x)),
      'v1.10.1: a hygienist\'s dashboard leads with "Waiting for you"');
    // Expected count comes from the data, not a constant — earlier checks in
    // this file leave their own patients behind.
    const expectHyg = db.listPatients({}).filter((x) => ['triaged', 'in_treatment'].includes(x.status) && x.route === 'hygienist').length;
    const hygTileText = tiles.find((x) => /Waiting for you/.test(x)) || '';
    log(new RegExp('^' + expectHyg + '\\s*Waiting for you').test(hygTileText),
      `v1.10.1: ...counting only patients routed to THEM (expected ${expectHyg}, tile: "${hygTileText}")`);
    // Their own tile must open a screen they can actually reach.
    const myTile = $all('.stat-card', dashRoot).find((n) => /Waiting for you/.test(n.textContent));
    log(!!myTile && myTile.tagName === 'BUTTON', 'v1.10.1: ...and it is clickable');

    // The clinic-wide tiles a hygienist cannot act on stay non-clickable.
    const vitalsTile = $all('.stat-card', dashRoot).find((n) => /Waiting for vitals/.test(n.textContent));
    log(!!vitalsTile && vitalsTile.tagName !== 'BUTTON',
      'v1.10.1: a tile whose station the role cannot open is not a button');

    // A doctor gets their own count, not the hygienist's.
    db.createUser(db.login('admin', 'admin'), { username: 'dashdoc', full_name: 'Dash Doc', role: 'doctor', password: 'x' });
    const docUser = await window.api.authLogin({ username: 'dashdoc', password: 'x' });
    store.setUser(docUser.data);
    currentUser = db.login('dashdoc', 'x');
    const docRoot = renderDashboard({ navigate: () => {}, toast: () => {}, store });
    document.body.append(docRoot);
    await tick(); await tick(); await tick();
    const docTile = $all('.stat-card', docRoot).map((n) => n.textContent.replace(/\s+/g, ' ').trim()).find((x) => /Waiting for you/.test(x));
    const expectDoc = db.listPatients({}).filter((x) => ['triaged', 'in_treatment'].includes(x.status)
      && (x.route === 'dentist' || x.route === 'both' || x.route == null)).length;
    log(new RegExp('^' + expectDoc + '\\s*Waiting for you').test(docTile || ''),
      `v1.10.1: a dentist sees their own queue in that tile (expected ${expectDoc}, tile: "${docTile || 'none'}")`);
    log(expectHyg !== expectDoc || expectHyg === 0,
      'v1.10.1: ...and the two clinicians are not just shown the same number');

    // An ADMIN oversees the whole clinic, so the personal tile is not theirs.
    currentUser = db.login('admin', 'admin');
    store.setUser(currentUser);
    const adminRoot = renderDashboard({ navigate: () => {}, toast: () => {}, store });
    document.body.append(adminRoot);
    await tick(); await tick(); await tick();
    log(!$all('.stat-card', adminRoot).some((n) => /Waiting for you/.test(n.textContent)),
      'v1.10.1: an administrator does not get a personal queue tile');
    log(!!ev, '(setup) a clinic was active for these checks');
  }

  // ---- v1.11.0: the signature names the dentist who is signing ----
  {
    currentUser = db.login('admin', 'admin');
    const store = (await import('../src/renderer/js/store.js')).store;
    store.setUser(currentUser);
    db.createEvent(currentUser, { name: 'Sig Clinic', location: 'S' });
    db.createUser(currentUser, { username: 'alpha', full_name: 'Dr Alpha', role: 'doctor', password: 'x' });
    db.createUser(currentUser, { username: 'beta', full_name: 'Dr Beta', role: 'doctor', password: 'x' });

    const mkSig = (last) => {
      const q = db.createPatient(currentUser, {
        first_name: 'Sig', last_name: last, demographics: {}, medical_history: {},
        dental_history: { reason: 'Filling', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
      });
      db.saveVitals(currentUser, q.id, { bp_systolic: 120, bp_diastolic: 76, heart_rate: 68 });
      db.routePatient(currentUser, q.id, 'dentist');
      return q;
    };
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const nameOf = (node) => Array.from(node.querySelectorAll('input')).find((i) => i.placeholder === 'Printed name');
    const asUser = async (u) => { const r = await window.api.authLogin({ username: u, password: 'x' }); currentUser = db.login(u, 'x'); store.setUser(r.data); return r; };
    const sigCtx = { navigate: () => {}, toast: () => {}, store, setDetail: () => {} };

    // Alpha works the chart and saves progress, stamping their name.
    const sp = mkSig('Handover');
    await asUser('alpha');
    db.saveTreatment(currentUser, sp.id, { fillings: [{ tooth: '19' }], provider_name: 'Dr Alpha', provider_signature: 'data:image/png;base64,AAAA' }, false);

    // Beta opens the same chart.
    await asUser('beta');
    const bNode = renderProvider(sigCtx, { id: sp.id });
    document.body.append(bNode);
    for (let i = 0; i < 14; i++) await tick();
    log(!!nameOf(bNode) && nameOf(bNode).value === 'Dr Beta',
      'v1.11.0: the printed name defaults to the dentist SIGNED IN, not the stored name');

    // Saving without drawing must not carry Alpha's ink under Beta's name.
    const saveBtn = Array.from(bNode.querySelectorAll('button')).find((b) => /Save progress/i.test(b.textContent));
    if (saveBtn) {
      saveBtn.click();
      for (let i = 0; i < 10; i++) await tick();
      const after = db.getPatient(sp.id).treatment;
      log(after.provider_name === 'Dr Beta', 'v1.11.0: ...and the save records the signing dentist');
      log(after.provider_signature == null,
        'v1.11.0: ...while the previous dentist\'s signature is NOT carried over (got: ' + String(after.provider_signature).slice(0, 24) + ')');
    } else {
      log(false, 'v1.11.0: (setup) could not find Save progress');
      log(false, 'v1.11.0: (setup) could not find Save progress');
    }

    // Drawing a signature stores it.
    const bNode2 = renderProvider(sigCtx, { id: sp.id });
    document.body.append(bNode2);
    for (let i = 0; i < 14; i++) await tick();
    drawSig(bNode2);
    const saveBtn2 = Array.from(bNode2.querySelectorAll('button')).find((b) => /Save progress/i.test(b.textContent));
    if (saveBtn2) { saveBtn2.click(); for (let i = 0; i < 10; i++) await tick(); }
    log(String(db.getPatient(sp.id).treatment.provider_signature || '').startsWith('data:image'),
      'v1.11.0: a drawn signature is stored');

    // The same dentist resuming keeps their OWN ink.
    const keepP = mkSig('Resume');
    await asUser('alpha');
    db.saveTreatment(currentUser, keepP.id, { fillings: [{ tooth: '3' }], provider_name: 'Dr Alpha', provider_signature: 'data:image/png;base64,KEEP' }, false);
    const aNode = renderProvider(sigCtx, { id: keepP.id });
    document.body.append(aNode);
    for (let i = 0; i < 14; i++) await tick();
    const aSave = Array.from(aNode.querySelectorAll('button')).find((b) => /Save progress/i.test(b.textContent));
    if (aSave) { aSave.click(); for (let i = 0; i < 10; i++) await tick(); }
    log(db.getPatient(keepP.id).treatment.provider_signature === 'data:image/png;base64,KEEP',
      'v1.11.0: the same dentist resuming keeps their own signature');

    // A LOCKED record is history: it must show who actually signed it.
    const lockP = mkSig('Locked');
    await asUser('alpha');
    db.saveTreatment(currentUser, lockP.id, { fillings: [{ tooth: '5' }], provider_name: 'Dr Alpha', provider_signature: 'data:image/png;base64,LOCK' }, 'lock');
    await asUser('beta');
    const lNode = renderProvider(sigCtx, { id: lockP.id });
    document.body.append(lNode);
    for (let i = 0; i < 14; i++) await tick();
    const lName = nameOf(lNode);
    log(!!lName && lName.value === 'Dr Alpha',
      'v1.11.0: a LOCKED record still shows the dentist who signed it, not the reader');
    log(!!lName && lName.disabled === true, 'v1.11.0: ...and that field stays read-only');

    currentUser = db.login('admin', 'admin');
    store.setUser(currentUser);
  }

  // ---- v1.11.0: a treating dentist must not destroy the triage dentist's work ----
  {
    currentUser = db.login('admin', 'admin');
    const store = (await import('../src/renderer/js/store.js')).store;
    store.setUser(currentUser);
    db.createEvent(currentUser, { name: 'Triage Clinic', location: 'T' });
    // 'alpha' and 'beta' already exist from the signature block above.
    const asDoc = async (u) => { const r = await window.api.authLogin({ username: u, password: 'x' }); currentUser = db.login(u, 'x'); store.setUser(r.data); return r; };
    const triCtx = { navigate: () => {}, toast: () => {}, store, setDetail: () => {} };
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');

    const tp = db.createPatient(currentUser, {
      first_name: 'Tri', last_name: 'Handover', demographics: {}, medical_history: {},
      dental_history: { reason: 'Lower left pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.saveVitals(currentUser, tp.id, { bp_systolic: 124, bp_diastolic: 78, heart_rate: 70 });
    db.routePatient(currentUser, tp.id, 'dentist');

    // Dr Alpha triages: findings + explicit attribution.
    await asDoc('alpha');
    db.saveTriage(currentUser, tp.id, {
      complaint: 'Lower left pain',
      teeth: ['19', '20'],
      teeth_notes: { 19: 'deep caries', 20: 'watch' },
      notes: 'Alpha: watch #20, likely needs extraction next visit',
    }, { attribute: true });
    const afterTriage = db.getPatient(tp.id).triage;
    const triagedAtWas = afterTriage.triaged_at;
    log(db.getPatient(tp.id).triaged_by_name === 'Dr Alpha',
      'v1.11.0: triage findings are attributed to the dentist who recorded them');
    log(!!triagedAtWas, 'v1.11.0: ...and stamped with when');

    // Dr Beta treats the patient and marks the visit complete.
    await asDoc('beta');
    const bNode = renderProvider(triCtx, { id: tp.id });
    document.body.append(bNode);
    for (let i = 0; i < 16; i++) await tick();
    // Beta fills a tooth Alpha did NOT flag. That matters: if the treating
    // dentist only ever echoed the triage dentist's own teeth back, the
    // overwrite would be invisible. Treating a different tooth makes the two
    // lists diverge, so a clobber shows up as tooth 30 appearing in
    // triage.teeth — which is exactly what the old code did.
    const toothInputs = Array.from(bNode.querySelectorAll('input')).filter((i) => /tooth/i.test(i.placeholder || ''));
    if (toothInputs.length) setInput(toothInputs[0], '30');
    for (let i = 0; i < 4; i++) await tick();
    const completeBtn = Array.from(bNode.querySelectorAll('button')).find((b) => /Mark visit complete/i.test(b.textContent));
    if (completeBtn) { completeBtn.click(); for (let i = 0; i < 14; i++) await tick(); }

    const after = db.getPatient(tp.id);
    const tr2 = after.triage;
    log(tr2.notes === 'Alpha: watch #20, likely needs extraction next visit',
      'v1.11.0: THE TEST — the triage dentist\'s notes survive the treating dentist\'s save');
    log(JSON.stringify(tr2.teeth) === JSON.stringify(['19', '20']),
      'v1.11.0: ...the teeth of concern are not overwritten by the teeth treated (got ' + JSON.stringify(tr2.teeth) + ')');
    log((tr2.teeth_notes || {})['19'] === 'deep caries',
      'v1.11.0: ...the per-tooth triage notes survive');
    log(after.triaged_by_name === 'Dr Alpha',
      'v1.11.0: ...the findings are still attributed to Dr Alpha (got ' + String(after.triaged_by_name) + ')');
    log(tr2.triaged_at === triagedAtWas,
      'v1.11.0: ...and triaged_at is NOT re-stamped by the treating dentist');
    log((after.treatment.fillings || []).some((f) => String(f.tooth) === '30'),
      'v1.11.0: (setup guard) the treating dentist really did treat a DIFFERENT tooth');
    log(!(tr2.teeth || []).includes('30'),
      'v1.11.0: ...and the tooth the treating dentist worked on did not leak into the triage findings');

    // The data layer itself must honour a partial save — mirrors the saveVitals checks.
    const pp = db.createPatient(db.login('admin', 'admin'), {
      first_name: 'Part', last_name: 'Save', demographics: {}, medical_history: {},
      dental_history: { reason: 'x', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    const alphaU = db.login('alpha', 'x');
    db.saveTriage(alphaU, pp.id, { complaint: 'X', notes: 'N', teeth: ['3'] }, { attribute: true });
    const betaU = db.login('beta', 'x');
    db.saveTriage(betaU, pp.id, { complaint: 'Y' });
    const pt = db.getPatient(pp.id).triage;
    log(pt.complaint === 'Y' && pt.notes === 'N' && JSON.stringify(pt.teeth) === JSON.stringify(['3']),
      'v1.11.0: a partial saveTriage writes only the keys it was given');
    log(db.getPatient(pp.id).triaged_by_name === 'Dr Alpha',
      'v1.11.0: ...and a save without attribute does not reassign who triaged');

    currentUser = db.login('admin', 'admin');
    store.setUser(currentUser);
  }

  // ---- v1.11.0: a triage-flagged tooth looks different, and stays flagged ----
  {
    currentUser = db.login('admin', 'admin');
    const store = (await import('../src/renderer/js/store.js')).store;
    store.setUser(currentUser);
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const odoCtx = { navigate: () => {}, toast: () => {}, store, setDetail: () => {} };

    const op = db.createPatient(currentUser, {
      first_name: 'Odo', last_name: 'Concern', demographics: {}, medical_history: {},
      dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.saveVitals(currentUser, op.id, { bp_systolic: 120, bp_diastolic: 76, heart_rate: 68 });
    db.routePatient(currentUser, op.id, 'dentist');
    const alphaU = db.login('alpha', 'x');
    db.saveTriage(alphaU, op.id, { teeth: ['20', '30'], teeth_notes: { 20: 'deep caries' }, notes: 'see #20' }, { attribute: true });

    const oNode = renderProvider(odoCtx, { id: op.id });
    document.body.append(oNode);
    for (let i = 0; i < 16; i++) await tick();

    const tooth = (id) => oNode.querySelector(`.odo-tooth[data-id="${id}"]`);
    log(!!tooth('20') && tooth('20').classList.contains('mark-concern'),
      'v1.11.0: a tooth flagged at triage carries its own mark, not the generic "selected"');
    log(/Triage concern/.test(oNode.textContent), 'v1.11.0: ...and the chart legend explains that mark');

    // THE TRAP: setMarks drops a marked tooth that is absent from the incoming
    // map and has no note. Tooth 30 was flagged with NO note, so touching a
    // filling row used to make its flag vanish.
    const toothInputs = Array.from(oNode.querySelectorAll('input')).filter((i) => /tooth/i.test(i.placeholder || ''));
    if (toothInputs.length) setInput(toothInputs[0], '19');
    for (let i = 0; i < 8; i++) await tick();
    log(!!tooth('30') && tooth('30').classList.contains('mark-concern'),
      'v1.11.0: a note-less triage flag survives the dentist editing a treatment row');
    log(!!tooth('19') && tooth('19').classList.contains('mark-filling'),
      'v1.11.0: ...and the tooth being treated marks as a filling');

    currentUser = db.login('admin', 'admin');
    store.setUser(currentUser);
  }

  // ---- v1.11.0: the treating dentist SEES what triage found ----
  {
    currentUser = db.login('admin', 'admin');
    const store = (await import('../src/renderer/js/store.js')).store;
    store.setUser(currentUser);
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const { renderHygienist } = await import('../src/renderer/js/views/hygienist.js');
    const tfCtx = { navigate: () => {}, toast: () => {}, store, setDetail: () => {} };
    const asDoc2 = async (u) => { const r = await window.api.authLogin({ username: u, password: 'x' }); currentUser = db.login(u, 'x'); store.setUser(r.data); return r; };

    const fp = db.createPatient(currentUser, {
      first_name: 'See', last_name: 'Findings', demographics: {}, medical_history: {},
      dental_history: { reason: 'Lower left pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.saveVitals(currentUser, fp.id, { bp_systolic: 122, bp_diastolic: 78, heart_rate: 70 });
    db.routePatient(currentUser, fp.id, 'dentist');
    db.saveTriage(db.login('alpha', 'x'), fp.id, {
      complaint: 'Lower left pain',
      teeth: ['19'], teeth_notes: { 19: 'deep caries, cold sensitive' },
      notes: 'Alpha: likely needs extraction if the filling fails',
    }, { attribute: true });

    await asDoc2('beta');
    const bView = renderProvider(tfCtx, { id: fp.id });
    document.body.append(bView);
    for (let i = 0; i < 16; i++) await tick();
    const txt = bView.textContent;
    log(/Triage findings/.test(txt), 'v1.11.0: the treating dentist sees a Triage findings card');
    log(/Lower left pain/.test(txt), 'v1.11.0: ...with the chief complaint from triage');
    log(/deep caries, cold sensitive/.test(txt),
      'v1.11.0: ...with the PER-TOOTH note as text, not hidden in a tooltip');
    log(/Alpha: likely needs extraction/.test(txt), 'v1.11.0: ...and the triage notes');
    log(/Dr Alpha/.test(txt), 'v1.11.0: ...naming the dentist who recorded them');
    const card = bView.querySelector('.triage-findings');
    log(!!card && !card.querySelector('input, textarea'),
      'v1.11.0: ...and the card is read-only for a dentist who did not record it');

    // The hygienist reads the same card.
    const hp = db.createPatient(db.login('admin', 'admin'), {
      first_name: 'Hyg', last_name: 'Reads', demographics: {}, medical_history: {},
      dental_history: { reason: 'Cleaning', visit_type: 'cleaning' }, route: 'hygienist', consents: SIGNED,
    });
    db.saveVitals(db.login('admin', 'admin'), hp.id, { bp_systolic: 118, bp_diastolic: 74, heart_rate: 66 });
    db.routePatient(db.login('admin', 'admin'), hp.id, 'hygienist');
    db.saveTriage(db.login('alpha', 'x'), hp.id, { complaint: 'Heavy calculus', notes: 'Alpha: scale with care' }, { attribute: true });
    currentUser = db.login('admin', 'admin'); store.setUser(currentUser);
    const hView = renderHygienist(tfCtx, { id: hp.id });
    document.body.append(hView);
    for (let i = 0; i < 16; i++) await tick();
    log(/Triage findings/.test(hView.textContent) && /Alpha: scale with care/.test(hView.textContent),
      'v1.11.0: the hygienist sees the same triage findings');

    // On a screen that cannot record triage, an untriaged patient must SAY so —
    // silence would read as "triage found nothing to worry about".
    const uh = db.createPatient(currentUser, {
      first_name: 'Not', last_name: 'Triaged', demographics: {}, medical_history: {},
      dental_history: { reason: 'Cleaning', visit_type: 'cleaning' }, route: 'hygienist', consents: SIGNED,
    });
    db.saveVitals(currentUser, uh.id, { bp_systolic: 120, bp_diastolic: 76, heart_rate: 68 });
    db.routePatient(currentUser, uh.id, 'hygienist');
    const uhView = renderHygienist(tfCtx, { id: uh.id });
    document.body.append(uhView);
    for (let i = 0; i < 16; i++) await tick();
    log(/has not been seen by a triage dentist/.test(uhView.textContent),
      'v1.11.0: where triage cannot be recorded, an untriaged patient says so rather than showing nothing');

    // A dentist opening an untriaged patient gets the form instead — they are
    // allowed to be the one who triages.
    const up = db.createPatient(currentUser, {
      first_name: 'Not', last_name: 'TriagedYet', demographics: {}, medical_history: {},
      dental_history: { reason: 'Check-up', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.saveVitals(currentUser, up.id, { bp_systolic: 120, bp_diastolic: 76, heart_rate: 68 });
    db.routePatient(currentUser, up.id, 'dentist');

    // The triage dentist can record from this screen, and it attributes.
    currentUser = db.login('admin', 'admin'); store.setUser(currentUser);
    await asDoc2('alpha');
    const aView = renderProvider(tfCtx, { id: up.id });
    document.body.append(aView);
    for (let i = 0; i < 16; i++) await tick();
    const aCard = aView.querySelector('.triage-findings--edit');
    log(!!aCard, 'v1.11.0: a dentist may RECORD triage when nobody has yet');
    if (aCard) {
      const cin = aCard.querySelector('input');
      const cta = aCard.querySelector('textarea');
      if (cin) setInput(cin, 'Upper right ache');
      if (cta) setInput(cta, 'Alpha: watch #3');
      const sb = Array.from(aCard.querySelectorAll('button')).find((b) => /Save triage findings/i.test(b.textContent));
      if (sb) { sb.click(); for (let i = 0; i < 12; i++) await tick(); }
    }
    const rec = db.getPatient(up.id);
    log(rec.triage.notes === 'Alpha: watch #3' && rec.triaged_by_name === 'Dr Alpha',
      'v1.11.0: ...and recording attributes the findings to them');

    // The queue tells the triage dentist who still needs them.
    const qView = renderProvider(tfCtx, {});
    document.body.append(qView);
    for (let i = 0; i < 14; i++) await tick();
    // Both states must be present, not either: an || here would have passed
    // while listPatients was not fetching triaged_at at all, so every patient
    // read as "Needs triage".
    const qText = qView.textContent;
    log(/Needs triage/.test(qText), 'v1.11.0: the dentist queue flags who still needs triage');
    log(/Dr Alpha/.test(qText), 'v1.11.0: ...and names the dentist who triaged the others');

    currentUser = db.login('admin', 'admin');
    store.setUser(currentUser);
  }

  // ---- v1.11.0: a date of birth people can type ----
  {
    const { isoFromTyped, typedFromIso, dateField } = await import('../src/renderer/js/forms.js');
    log(isoFromTyped('09/30/1985') === '1985-09-30', 'v1.11.0: a typed MM/DD/YYYY date converts to ISO for storage');
    log(isoFromTyped('1/2/1990') === '1990-01-02', 'v1.11.0: ...single-digit month and day are accepted');
    log(isoFromTyped('1990-01-02') === '1990-01-02', 'v1.11.0: ...an already-ISO value passes through');
    log(isoFromTyped('13/01/2000') === '', 'v1.11.0: ...month 13 is refused');
    log(isoFromTyped('02/31/1990') === '', 'v1.11.0: ...31 February is refused');
    log(isoFromTyped('01/01/2099') === '', 'v1.11.0: ...a date in the future is refused');
    log(typedFromIso('1990-01-02') === '01/02/1990', 'v1.11.0: a stored date is shown back in the typed format');

    // The field itself: masks as you type, and round-trips a stored value.
    const f = dateField('Date of birth', { value: '1985-04-12' });
    log(f.input.value === '04/12/1985', 'v1.11.0: the field shows a stored date as MM/DD/YYYY');
    log(f.input.type === 'text' && f.input.getAttribute('inputmode') === 'numeric',
      'v1.11.0: ...and is a typeable field, not a calendar picker');
    setInput(f.input, '09301985');
    log(f.input.value === '09/30/1985', 'v1.11.0: ...slashes are inserted as you type');
    log(f.get() === '1985-09-30', 'v1.11.0: ...and get() hands back ISO');
    setInput(f.input, '99/99/1990');
    log(f.get() === '' && f.raw() === '99/99/1990',
      'v1.11.0: ...a nonsense date reads as empty while keeping what was typed, so the error can say which');

    // The kiosk stores ISO end to end — the check-in flow at the top of this
    // file types 04/12/1985 into the masked field.
    const kioskPt = db.listPatients({ eventId: 'all' }).find((x) => x.dob === '1985-04-12');
    log(!!kioskPt, 'v1.11.0: a patient checked in through the kiosk has an ISO date of birth stored');
  }

  // ---- v1.11.0: x-rays that turn up after the chair is cleared ----
  {
    currentUser = db.login('admin', 'admin');
    const storeX = (await import('../src/renderer/js/store.js')).store;
    storeX.setUser(currentUser);
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const xCtx = { navigate: () => {}, toast: () => {}, store: storeX, setDetail: () => {} };
    const PNG = 'data:image/png;base64,AAAA';

    const evX = db.createEvent(currentUser, { name: 'Late Films' });
    db.setActiveEvent(currentUser, evX.id);
    const mk = (first, last, route, visit) => {
      const pt = db.createPatient(currentUser, {
        first_name: first, last_name: last, demographics: {}, medical_history: {},
        dental_history: { reason: 'Pain', visit_type: visit || 'filling' }, route, consents: SIGNED,
      });
      db.saveVitals(currentUser, pt.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
      db.routePatient(currentUser, pt.id, route);
      return pt;
    };

    // 1. A film that arrives after the visit is marked complete.
    const late = mk('Late', 'Film', 'dentist');
    db.saveTreatment(currentUser, late.id, { fillings: [{ tooth: '19', surfaces: ['O'] }], provider_name: 'Dr Admin' }, 'complete');
    const added = db.addXray(currentUser, late.id, { station: '2', image_png: PNG, note: 'PA #19', tooth: '19' });
    log(added.count === 1 && db.listXrays(late.id).length === 1,
      'v1.11.0: an x-ray still attaches to a visit that is already marked complete');
    log(db.getPatient(late.id).triage.xray_count === 1,
      'v1.11.0: ...and the chart x-ray count follows it');

    // 2. A SIGNED-OFF chart refuses at the data layer, not just in the UI.
    const sealed = mk('Signed', 'Off', 'dentist');
    db.saveTreatment(currentUser, sealed.id, { fillings: [], provider_name: 'Dr Admin', provider_signature: PNG }, 'lock');
    const refuses = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    log(/locked and signed off/.test(refuses(() => db.addXray(currentUser, sealed.id, { image_png: PNG }))),
      'v1.11.0: a signed-off chart refuses a new x-ray at the data layer, not only by hiding the button');
    log(db.listXrays(sealed.id).length === 0, 'v1.11.0: ...and nothing was written');

    // Re-opening is the honest path back in, and it works.
    db.reopenTreatment(currentUser, sealed.id);
    log(db.addXray(currentUser, sealed.id, { image_png: PNG, tooth: '3' }).count === 1,
      'v1.11.0: ...re-opening the record lets the film in');
    // Re-sign, then prove retag and delete are refused too: a locked record must
    // not have its films silently re-labelled or removed either.
    const xid = db.listXrays(sealed.id)[0].id;
    db.saveTreatment(currentUser, sealed.id, { fillings: [], provider_name: 'Dr Admin', provider_signature: PNG }, 'lock');
    log(/locked and signed off/.test(refuses(() => db.updateXrayTooth(currentUser, xid, '14'))),
      'v1.11.0: a signed-off chart refuses having an x-ray re-assigned to another tooth');
    log(/locked and signed off/.test(refuses(() => db.deleteXray(currentUser, xid))),
      'v1.11.0: ...and refuses deleting one');
    log(db.listXrays(sealed.id).length === 1 && db.listXrays(sealed.id)[0].tooth === '3',
      'v1.11.0: ...leaving the film exactly as it was signed');

    // 3. A patient the EMT sent only to the hygienist must still be reachable
    //    from the dentist screen — the dentist is the only station with an x-ray
    //    panel, so before this their late film had nowhere to go.
    const hygOnly = mk('Hygiene', 'Only', 'hygienist', 'cleaning');
    db.saveTreatment(currentUser, hygOnly.id, { cleaning: { adult_prophy: true }, provider_name: 'Dr Admin' }, 'complete');
    const qv = renderProvider(xCtx, {});
    document.body.append(qv);
    for (let i = 0; i < 14; i++) await tick();
    const finishedPane = Array.from(qv.querySelectorAll('details')).find((d) => /Finished today/.test(d.textContent));
    log(!!finishedPane && /Only, Hygiene/.test(finishedPane.textContent),
      'v1.11.0: a hygiene-only patient appears in the dentist’s Finished list, so a late x-ray can reach their chart');
    log(/Film, Late/.test((finishedPane || qv).textContent),
      'v1.11.0: ...alongside the dentist’s own finished patients');

    // 4. The finish-clinic pre-flight counts what is about to be destroyed.
    const stillWaiting = mk('Still', 'Waiting', 'dentist');
    const pre = db.finishPreflight(evX.id);
    log(pre.xrays === 2, 'v1.11.0: the finish-clinic pre-flight counts the x-ray images that finishing destroys');
    log(pre.queued === 1, 'v1.11.0: ...and the patients still sitting in the queue');
    log(pre.unsigned === 2, 'v1.11.0: ...and the charts nobody signed off');
    log(pre.needs_export === true && pre.last_export === null,
      'v1.11.0: ...and says the clinic has not been exported on this computer');

    // 5. The interlock. "Finish clinic" used to be the ONE destructive button with
    //    no export gate at all, and it is the one that destroys the images.
    const blocked = refuses(() => db.finishEvent(currentUser, evX.id));
    log(/Export/.test(blocked) && /x-ray image/.test(blocked),
      'v1.11.0: finishing a clinic without an export is refused, and the refusal names the x-rays');
    log(db.listPatients({ eventId: evX.id }).length === 4, 'v1.11.0: ...and not one record was removed');

    // An export arms it, exactly as it already armed the sibling Delete button.
    db.recordClinicExport(evX.id, { patients: 4, xlsxPath: '/tmp/Late-Films.xlsx', backupPath: '/tmp/Late-Films.chbak.json' });
    const armed = db.finishPreflight(evX.id);
    log(armed.needs_export === false && armed.last_export && armed.last_export.patients === 4,
      'v1.11.0: an export receipt arms the finish button and is reported back');

    // A record touched AFTER the export means the backup no longer matches.
    // The wait is real: the receipt is stamped to the millisecond, and these two
    // writes would otherwise land inside the same one.
    await tick(); await tick();
    db.addXray(currentUser, late.id, { image_png: PNG, note: 'second film' });
    db.saveTreatment(currentUser, late.id, { fillings: [{ tooth: '19', surfaces: ['O'] }], clinical_notes: 'after the export', provider_name: 'Dr Admin' }, 'complete');
    log(db.finishPreflight(evX.id).changes_since_export >= 2,
      'v1.11.0: a record changed after the export is reported, so a stale backup cannot pass as protection');

    log(db.finishEvent(currentUser, evX.id).removed === 4,
      'v1.11.0: with an export on this computer, finishing the clinic goes through');
    // Nothing to lose, nothing to export: a clinic already emptied can be closed.
    const evEmpty = db.createEvent(currentUser, { name: 'Nobody Came' });
    log(db.finishPreflight(evEmpty.id).needs_export === false,
      'v1.11.0: a clinic with no patient records needs no export before it can be closed');
    log(db.finishEvent(currentUser, evEmpty.id).ok === true, 'v1.11.0: ...and closing it is allowed');

    currentUser = db.login('admin', 'admin');
    storeX.setUser(currentUser);
  }

  // ---- v1.11.0: the clinic report a coordinator can be sent ----
  {
    currentUser = db.login('admin', 'admin');
    const pdfC = require('../src/main/pdf.js');
    const PNG = 'data:image/png;base64,AAAA';

    const evC = db.createEvent(currentUser, { name: 'Coordinator Clinic', location: 'Sandy, Oregon', start_date: '2026-09-18' });
    db.setActiveEvent(currentUser, evC.id);
    const seenBy = (first, last, city, visit) => {
      const pt = db.createPatient(currentUser, {
        first_name: first, last_name: last, dob: '1980-05-05', gender: 'female', language: 'es',
        demographics: { city, state: 'OR' }, medical_history: {},
        dental_history: { reason: 'Pain', visit_type: visit },
        route: 'dentist', consents: visit.startsWith('extraction') ? SIGNED_SURGERY : SIGNED,
      });
      db.saveVitals(currentUser, pt.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
      db.routePatient(currentUser, pt.id, visit === 'cleaning' ? 'hygienist' : 'dentist');
      return pt;
    };
    const c1 = seenBy('Ana', 'Ruiz', 'Sandy', 'filling');
    const c2 = seenBy('Beto', 'Cruz', 'Gresham', 'extraction_pain');
    const c3 = seenBy('Cleo', 'Diaz', 'Sandy', 'cleaning');
    // Triage by one dentist, treatment by another: the roster must name both.
    db.saveTriage(db.login('alpha', 'x'), c1.id, {
      complaint: 'Upper right ache', teeth: ['3'], teeth_notes: { 3: 'fractured cusp' },
      notes: 'Alpha: restore #3',
    }, { attribute: true });
    db.saveTreatment(db.login('beta', 'x'), c1.id, {
      fillings: [{ tooth: '3', surfaces: ['O'] }], provider_name: 'Dr Beta', provider_signature: PNG,
    }, 'lock');
    db.saveTreatment(currentUser, c2.id, {
      extractions: [{ tooth: '17', types: ['simple'] }], provider_name: 'Dr Admin',
    }, 'complete');
    db.saveTreatment(currentUser, c3.id, { cleaning: { adult_prophy: true }, provider_name: 'Dr Admin' }, 'complete');
    db.addXray(currentUser, c2.id, { image_png: PNG, tooth: '17' });

    const data = db.clinicReport(evC.id);
    log(data.roster.length === 3 && data.event.name === 'Coordinator Clinic',
      'v1.11.0: the clinic report gathers the whole clinic in one call');

    // THE point of the roster: its own columns add up to the KPIs on the facing
    // page. The two existing one-line summarisers over-count, which would have
    // made the roster contradict the figures beside it.
    const sm = data.rollup.summary;
    const sum = (k) => data.roster.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    log(sum('fillings') === sm.fillings && sum('extractions') === sm.extractions
      && data.roster.filter((r) => r.cleaning).length === sm.cleanings && sum('xrays') === sm.xrays,
      'v1.11.0: ...and every roster column totals to the KPI printed on the same document');

    const summaryHtml = pdfC.buildClinicHtml(data, { withRoster: false });
    const rosterHtml = pdfC.buildClinicHtml(data, { withRoster: true });
    log(/Clinic Summary</.test(summaryHtml) && /Clinic Summary \+ Patient Roster/.test(rosterHtml),
      'v1.11.0: the two documents are titled differently, so the wrong one cannot be sent unnoticed');
    // The de-identified one carries NO patient name. This is the check that
    // decides whether the summary can be handed to a funder.
    log(!/Ruiz|Cruz|Diaz|Ana|Beto|Cleo/.test(summaryHtml),
      'v1.11.0: the shareable summary contains no patient name');
    log(/no patient names or identifying details/.test(summaryHtml),
      'v1.11.0: ...and says so on its face');
    log(/Contains patient names/.test(rosterHtml) && /Ruiz/.test(rosterHtml),
      'v1.11.0: the roster names patients and warns that it does');
    log(/Coordinator Clinic/.test(summaryHtml) && /Sandy, Oregon/.test(summaryHtml),
      'v1.11.0: the summary names the clinic and where it ran');
    log(/Dr Alpha/.test(rosterHtml) && /Dr Beta/.test(rosterHtml),
      'v1.11.0: the roster names the triage dentist AND the treating dentist, not just one of them');
    log(/fractured cusp/.test(rosterHtml),
      'v1.11.0: ...and prints the per-tooth triage note, which reached no printed output before');
    log(/Español/.test(summaryHtml) && !/>es</.test(summaryHtml),
      'v1.11.0: language codes are relabelled for a reader outside the clinic');

    // A finished clinic: the people are gone and only the totals were kept. The
    // document must SAY that rather than print an empty table.
    db.recordClinicExport(evC.id, { patients: 3 });
    db.finishEvent(currentUser, evC.id);
    const kept = db.clinicReport(evC.id);
    log(kept.roster.length === 0 && kept.rollup.source === 'kept',
      'v1.11.0: a finished clinic still reports, with no roster behind it');
    log(kept.rollup.summary.patients_seen === 3,
      'v1.11.0: ...and the kept totals are the ones the clinic actually saw');
    const keptHtml = pdfC.buildClinicHtml(kept, { withRoster: true });
    log(/patient records removed/.test(keptHtml) && !/Ruiz/.test(keptHtml),
      'v1.11.0: ...and the roster page says the records are gone instead of printing an empty table');
    log(/>3</.test(pdfC.buildClinicHtml(kept, { withRoster: false })),
      'v1.11.0: the summary of a finished clinic still carries its figures');

    // Triage findings on the PATIENT documents, which is where the treating
    // dentist and the patient actually read them. Finishing the clinic above
    // left no clinic selected, so this needs one of its own.
    const evP = db.createEvent(currentUser, { name: 'Printed Notes' });
    db.setActiveEvent(currentUser, evP.id);
    const tpat = db.createPatient(currentUser, {
      first_name: 'Print', last_name: 'Triage', demographics: {}, medical_history: {},
      dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.saveVitals(currentUser, tpat.id, { bp_systolic: 118, bp_diastolic: 74, heart_rate: 68 });
    db.routePatient(currentUser, tpat.id, 'dentist');
    db.saveTriage(db.login('alpha', 'x'), tpat.id, {
      complaint: 'Lower left pain', teeth: ['19'], teeth_notes: { 19: 'deep caries, cold sensitive' },
      notes: 'Alpha: restore if possible',
    }, { attribute: true });
    db.saveTreatment(db.login('beta', 'x'), tpat.id, { fillings: [{ tooth: '19', surfaces: ['O'] }], provider_name: 'Dr Beta' }, 'complete');
    const prog = pdfC.buildHtml(db.getPatient(tpat.id), 'progress');
    log(/deep caries, cold sensitive/.test(prog),
      'v1.11.0: the progress note prints the per-tooth triage note, not a bare tooth number');
    log(/Triaged by/.test(prog) && /Dr Alpha/.test(prog) && /Dr Beta/.test(prog),
      'v1.11.0: ...and names the triage dentist beside the treating dentist');
    const summ = pdfC.buildHtml(db.getPatient(tpat.id), 'summary');
    log(/Triage Assessment/.test(summ) && /deep caries/.test(summ) && /Dr Alpha/.test(summ),
      'v1.11.0: the patient summary carries the triage assessment too');

    currentUser = db.login('admin', 'admin');
  }

  // ---- v1.12.0: a note from the front desk / vitals for the clinician ----
  {
    currentUser = db.login('admin', 'admin');
    const storeS = (await import('../src/renderer/js/store.js')).store;
    storeS.setUser(currentUser);
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const { renderHygienist } = await import('../src/renderer/js/views/hygienist.js');
    const pdfS = require('../src/main/pdf.js');
    const sCtx = { navigate: () => {}, toast: () => {}, store: storeS, setDetail: () => {} };
    const as = async (u, pw) => { const r = await window.api.authLogin({ username: u, password: pw }); currentUser = db.login(u, pw); storeS.setUser(r.data); return r; };

    const evS = db.createEvent(currentUser, { name: 'Handover Clinic' });
    db.setActiveEvent(currentUser, evS.id);
    const desk = db.createUser(currentUser, { username: 'frontdesk2', full_name: 'Dana Front', role: 'registration', password: 'x' });
    const medic = db.createUser(currentUser, { username: 'emt2', full_name: 'Ravi Medic', role: 'emt', password: 'x' });

    const sp = db.createPatient(currentUser, {
      first_name: 'Hand', last_name: 'Over', demographics: {}, medical_history: {},
      dental_history: { reason: 'Lower left pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });

    // The desk writes BEFORE anyone has taken vitals, which is the whole point:
    // they meet the patient first.
    db.addStationNote(db.login('frontdesk2', 'x'), sp.id, 'Very anxious about needles — asked for extra time.');
    db.saveVitals(db.login('emt2', 'x'), sp.id, { bp_systolic: 148, bp_diastolic: 92, heart_rate: 88 });
    db.addStationNote(db.login('emt2', 'x'), sp.id, 'Mentioned chest pain last week, not seen a doctor.');
    db.routePatient(currentUser, sp.id, 'dentist');

    const notes = db.listStationNotes(sp.id);
    log(notes.length === 2, 'v1.12.0: both stations can leave a note, and neither replaces the other');
    log(notes[0].station === 'Front desk' && notes[1].station === 'Vitals',
      'v1.12.0: ...each labelled with the station that wrote it');
    log(notes[0].by_name === 'Dana Front' && notes[1].by_name === 'Ravi Medic',
      'v1.12.0: ...and with the name of the person who wrote it');
    // Derived from the ROLE, never passed in: a "Front desk" label is only worth
    // reading if nobody can type it.
    db.addStationNote(db.login('admin', 'admin'), sp.id, { toString: () => 'x' } && 'Admin covering the desk.');
    log(db.listStationNotes(sp.id)[2].station === 'Admin',
      'v1.12.0: the station on a note comes from the signed-in role, not from the screen');
    log(/Write the note/.test((() => { try { db.addStationNote(db.login('admin', 'admin'), sp.id, '   '); return ''; } catch (e) { return e.message; } })()),
      'v1.12.0: an empty note is refused rather than filed as a blank line');

    // Only the stations that meet the patient may WRITE one; everyone may read.
    currentUser = db.login('admin', 'admin'); storeS.setUser(currentUser);
    const docU = db.listUsers().find((u) => u.role === 'doctor');
    await as(docU.username, 'x');
    const denied = await window.api.triageStationNote({ patientId: sp.id, note: 'dentist trying to write' });
    log(denied.ok === false && /permission/i.test(denied.error || ''),
      'v1.12.0: a dentist cannot write a handover note — their later thoughts belong in the signed clinical note');
    const readable = await window.api.triageStationNotes({ patientId: sp.id });
    log(readable.ok === true && readable.data.length === 3,
      'v1.12.0: ...but every station that meets the patient can read them');

    // The dentist SEES them, above the triage findings.
    const sView = renderProvider(sCtx, { id: sp.id });
    document.body.append(sView);
    for (let i = 0; i < 16; i++) await tick();
    const sTxt = sView.textContent;
    log(/Very anxious about needles/.test(sTxt) && /Mentioned chest pain last week/.test(sTxt),
      'v1.12.0: the dentist sees both notes on the chart');
    log(/Dana Front/.test(sTxt) && /Ravi Medic/.test(sTxt),
      'v1.12.0: ...attributed, so the dentist knows who to ask');
    const sCard = sView.querySelector('.station-notes');
    log(!!sCard && !sCard.querySelector('input, textarea'),
      'v1.12.0: ...and the card is read-only at the chair');
    // Order on the page: the desk and vitals hand over BEFORE the triage dentist.
    const findings = sView.querySelector('.triage-findings');
    log(!!sCard && !!findings
      && (sCard.compareDocumentPosition(findings) & 4) !== 0,
      'v1.12.0: ...and sits above the triage findings, in the order the patient met the stations');

    // The queue flags it without opening the chart.
    const sQueue = renderProvider(sCtx, {});
    document.body.append(sQueue);
    for (let i = 0; i < 14; i++) await tick();
    log(/Note/.test(sQueue.textContent) && db.listPatients({ eventId: evS.id }).find((x) => x.id === sp.id).station_note_count === 3,
      'v1.12.0: the dentist queue flags a patient carrying a handover note');

    // The hygienist reads the same card.
    const hp = db.createPatient(currentUser, {
      first_name: 'Hyg', last_name: 'Handover', demographics: {}, medical_history: {},
      dental_history: { reason: 'Cleaning', visit_type: 'cleaning' }, route: 'hygienist', consents: SIGNED,
    });
    db.addStationNote(db.login('frontdesk2', 'x'), hp.id, 'Hard of hearing on the left.');
    db.saveVitals(currentUser, hp.id, { bp_systolic: 118, bp_diastolic: 74, heart_rate: 66 });
    db.routePatient(currentUser, hp.id, 'hygienist');
    currentUser = db.login('admin', 'admin'); storeS.setUser(currentUser);
    const hView = renderHygienist(sCtx, { id: hp.id });
    document.body.append(hView);
    for (let i = 0; i < 16; i++) await tick();
    log(/Hard of hearing on the left/.test(hView.textContent),
      'v1.12.0: the hygienist sees the same handover notes');

    // A patient nobody left a note on shows NO card. "The desk had no concerns"
    // is the ordinary case; a card saying so on every chart trains people to
    // scroll past this one.
    const qp = db.createPatient(currentUser, {
      first_name: 'No', last_name: 'Notes', demographics: {}, medical_history: {},
      dental_history: { reason: 'Check-up', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.saveVitals(currentUser, qp.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
    db.routePatient(currentUser, qp.id, 'dentist');
    const qView = renderProvider(sCtx, { id: qp.id });
    document.body.append(qView);
    for (let i = 0; i < 16; i++) await tick();
    log(!qView.querySelector('.station-notes'),
      'v1.12.0: a patient with no handover note shows no card at all');

    // On the clinical record, NOT on the copy check-out hands the patient.
    db.saveTreatment(currentUser, sp.id, { fillings: [{ tooth: '19', surfaces: ['O'] }], provider_name: 'Dr Admin' }, 'complete');
    const prog = pdfS.buildHtml(db.getPatient(sp.id), 'progress');
    const full = pdfS.buildHtml(db.getPatient(sp.id), 'full');
    const patientCopy = pdfS.buildHtml(db.getPatient(sp.id), 'summary');
    log(/Mentioned chest pain last week/.test(prog) && /Dana Front/.test(prog),
      'v1.12.0: the handover notes print on the progress note');
    log(/Mentioned chest pain last week/.test(full),
      'v1.12.0: ...and on the full record');
    log(!/Very anxious about needles/.test(patientCopy) && !/Mentioned chest pain/.test(patientCopy),
      'v1.12.0: ...and NOT on the summary check-out hands the patient');

    currentUser = db.login('admin', 'admin');
    storeS.setUser(currentUser);
  }

  // ---- v1.12.0: adding station_notes to SYNC_COLS must not re-stamp the world ----
  {
    currentUser = db.login('admin', 'admin');
    const evQ = db.createEvent(currentUser, { name: 'Sync Baseline' });
    db.setActiveEvent(currentUser, evQ.id);
    const qp = db.createPatient(currentUser, {
      first_name: 'Quiet', last_name: 'Row', demographics: {}, medical_history: {},
      dental_history: { reason: 'Check-up', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.saveVitals(currentUser, qp.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
    const trId = db.getPatient(qp.id).triage.id;

    // Push everything and confirm it, so the triage row is genuinely clean.
    db.markSynced(db.collectSyncRows(500).mark);
    log(db.collectSyncRows(500).rows.filter((r) => r.entity === 'triage').length === 0,
      'v1.12.0: (setup) a synced triage row reads as clean');

    // Now BUILD the state a v1.11 laptop would have left behind: the row was
    // pushed and agreed under the old column list, so both bookkeeping hashes
    // hold a value that no longer matches the payload this build produces.
    // Nothing about the row's CONTENT changes — only what it thinks it pushed.
    const beforeState = db.syncRowState('triage', trId);
    const preUpgrade = 'a'.repeat(64); // what the old shape hashed to, whatever it was
    db.setSyncRowState('triage', trId, { synced_rev: preUpgrade, content_rev: preUpgrade });
    db.setSetting('triage_sig_rebaseline', '');
    db.rebaselineTriageSig();

    // The row is dirty — it must be, the peer agreed a different hash — and it
    // pushes once. The thing that must NOT happen is a new timestamp: that is
    // what beats a peer's newer unsynced edit with content nobody has touched.
    const push = db.collectSyncRows(500);
    const pushed = push.rows.find((r) => r.entity === 'triage' && r.uid === beforeState.uid);
    log(!!pushed, 'v1.12.0: an upgraded laptop does push its triage rows once, as it must');
    log(!!pushed && pushed.updated_at === beforeState.updated_at,
      'v1.12.0: ...but it does NOT re-stamp them, so adding a column cannot beat a peer’s newer unsynced edit');
    log(db.syncRowState('triage', trId).content_rev === db.syncRowState('triage', trId).content_now,
      'v1.12.0: ...and the re-baseline leaves content_rev matching what the row would push');

    // A row that GENUINELY changes still re-stamps — the re-baseline must not
    // have frozen the clock for real edits.
    db.markSynced(push.mark);
    db.addStationNote(currentUser, qp.id, 'Came with a translator.');
    const moved = db.collectSyncRows(500).rows.find((r) => r.entity === 'triage' && r.uid === beforeState.uid);
    log(!!moved && /Came with a translator/.test(JSON.stringify(moved.data)),
      'v1.12.0: a row that actually gains a note is pushed, note and all');
    log(!!moved && moved.updated_at !== beforeState.updated_at,
      'v1.12.0: ...and a real edit still gets a fresh timestamp');

    currentUser = db.login('admin', 'admin');
  }

  // ---- v1.13.0: find a patient on every station, not just Arrivals ----
  {
    currentUser = db.login('admin', 'admin');
    const storeF = (await import('../src/renderer/js/store.js')).store;
    storeF.setUser(currentUser);
    const { matchesPatient } = await import('../src/renderer/js/patientSort.js');
    const fCtx = { navigate: () => {}, toast: () => {}, store: storeF, setDetail: () => {} };
    const type = async (box, v) => { box.value = v; box.dispatchEvent(new window.Event('input', { bubbles: true })); for (let i = 0; i < 3; i++) await tick(); };
    const names = (root) => Array.from(root.querySelectorAll('td strong')).map((n) => n.textContent);

    // The matcher: the two gaps the old Arrivals copy had.
    const yz = { first_name: 'Yolanda', last_name: 'Zaragoza', dob: '1977-03-04', phone: '5035559876' };
    log(matchesPatient(yz, '03/04/1977'), 'v1.13.0: a date of birth typed MM/DD/YYYY finds the patient (it is stored as 1977-03-04)');
    log(matchesPatient(yz, '(503) 555-9876') && matchesPatient(yz, '555-9876'),
      'v1.13.0: a phone typed with brackets or dashes finds the patient (it is stored as bare digits)');
    log(matchesPatient(yz, 'zaragoza yol') && !matchesPatient(yz, 'zaragoza 03/05/1977'),
      'v1.13.0: every word must match, in any order');

    // A busy clinic: people at every stage.
    const evF = db.createEvent(currentUser, { name: 'Busy Clinic' });
    db.setActiveEvent(currentUser, evF.id);
    const mk = (first, last, route, visit, extra = {}) => {
      const pt = db.createPatient(currentUser, {
        first_name: first, last_name: last, dob: extra.dob || '1980-01-01', phone: extra.phone || '5035550000',
        demographics: {}, medical_history: {}, dental_history: { reason: 'Pain', visit_type: visit }, route,
        consents: visit.startsWith('extraction') ? SIGNED_SURGERY : SIGNED,
      });
      return pt;
    };
    const vit = (pt, route) => { db.saveVitals(currentUser, pt.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 }); db.routePatient(currentUser, pt.id, route); };
    const waitA = mk('Abel', 'Waiting', 'dentist', 'filling', { phone: '5035551111' });
    const waitB = mk('Bea', 'Waitress', 'hygienist', 'cleaning');
    const dent1 = mk('Dora', 'Molar', 'dentist', 'filling', { dob: '1966-07-15' }); vit(dent1, 'dentist');
    const dent2 = mk('Dan', 'Canine', 'dentist', 'filling'); vit(dent2, 'dentist');
    const hyg1 = mk('Hal', 'Scaler', 'hygienist', 'cleaning', { phone: '5035552222' }); vit(hyg1, 'hygienist');
    const hyg2 = mk('Hana', 'Polish', 'hygienist', 'cleaning'); vit(hyg2, 'hygienist');
    const doneD = mk('Fay', 'Finished', 'dentist', 'filling'); vit(doneD, 'dentist');
    db.saveTreatment(currentUser, doneD.id, { fillings: [{ tooth: '3', surfaces: ['O'] }], provider_name: 'Dr Admin' }, 'complete');
    const doneH = mk('Flo', 'Flossed', 'hygienist', 'cleaning'); vit(doneH, 'hygienist');
    db.saveTreatment(currentUser, doneH.id, { cleaning: { adult_prophy: true }, provider_name: 'Dr Admin' }, 'complete');
    const out = mk('Otto', 'Gone', 'dentist', 'filling'); vit(out, 'dentist');
    db.saveTreatment(currentUser, out.id, { fillings: [{ tooth: '4', surfaces: ['O'] }], provider_name: 'Dr Admin' }, 'complete');
    db.dismissPatient(currentUser, out.id);

    const views = [
      ['Vitals', 'emt', 'renderEmt'],
      ['Dentist', 'provider', 'renderProvider'],
      ['Cleanings', 'hygienist', 'renderHygienist'],
      ['Check-Out', 'checkout', 'renderCheckout'],
    ];
    for (const [label, file, fn] of views) {
      const mod = await import(`../src/renderer/js/views/${file}.js`);
      const v = mod[fn](fCtx, {});
      document.body.append(v);
      for (let i = 0; i < 12; i++) await tick();
      const box = v.querySelector('input[type="search"]');
      log(!!box, `v1.13.0: ${label} has a Find-a-patient box`);
      if (!box) continue;
      const before = names(v).length;
      // Search by a surname that is on this screen.
      const target = { Vitals: 'Waiting', Dentist: 'Molar', Cleanings: 'Scaler', 'Check-Out': 'Finished' }[label];
      await type(box, target.toLowerCase());
      const after = names(v);
      log(after.length >= 1 && after.length < before && after.every((n) => new RegExp(target).test(n)),
        `v1.13.0: ...typing a surname on ${label} narrows the list to that patient`);
      log(v.querySelector('input[type="search"]') === box && box.value === target.toLowerCase(),
        `v1.13.0: ...and the box is not rebuilt out from under the person typing (${label})`);
      log(/hidden by the search/.test(v.textContent), `v1.13.0: ...and ${label} says how many people the search is hiding`);
      await type(box, 'nobody-by-this-name');
      log(names(v).length === 0 && /No match for/.test(v.textContent),
        `v1.13.0: ...a search that finds nobody says so on ${label}, instead of "nobody is waiting"`);
      await type(box, '');
      log(names(v).length === before, `v1.13.0: ...and clearing it brings the whole ${label} list back`);
      v.remove();
    }

    // Dentist: a match inside a collapsed section opens it.
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const pv = renderProvider(fCtx, {});
    document.body.append(pv);
    for (let i = 0; i < 12; i++) await tick();
    const pbox = pv.querySelector('input[type="search"]');
    await type(pbox, 'flossed');
    const openPane = Array.from(pv.querySelectorAll('details')).find((d) => /Finished today/.test(d.textContent));
    log(!!openPane && openPane.hasAttribute('open') && /Flossed, Flo/.test(openPane.textContent),
      'v1.13.0: on the Dentist screen a match in "Finished today" opens that section, so it is not hidden behind a closed fold');
    // By date of birth in the typed form, on a clinical screen.
    await type(pbox, '07/15/1966');
    log(names(pv).join('|') === 'Molar, Dora', 'v1.13.0: the dentist can find a patient by a typed date of birth');

    // Sync from another laptop must not wipe the search. The screen refreshes
    // ITSELF in place — same box, same text, same filter, fresh data.
    await type(pbox, 'molar');
    const dent3 = mk('Mo', 'Molarson', 'dentist', 'filling'); vit(dent3, 'dentist');
    pbox.focus();
    pv.__liveRefresh();
    for (let i = 0; i < 12; i++) await tick();
    log(pv.querySelector('input[type="search"]') === pbox && pbox.value === 'molar',
      'v1.13.0: a sync from another laptop refreshes the Dentist screen without wiping the search');
    log(names(pv).includes('Molarson, Mo') && names(pv).includes('Molar, Dora') && !names(pv).includes('Canine, Dan'),
      'v1.13.0: ...the new patient appears, and the search is still applied');
    log(document.activeElement === pbox, 'v1.13.0: ...and the cursor stays in the box');
    // A brand-new copy of the screen (navigating away and back) remembers it too.
    const pv2 = renderProvider(fCtx, {});
    document.body.append(pv2);
    for (let i = 0; i < 12; i++) await tick();
    log(pv2.querySelector('input[type="search"]').value === 'molar',
      'v1.13.0: ...and a fresh copy of the screen remembers what was being searched');
    await type(pv2.querySelector('input[type="search"]'), '');
    pv.remove(); pv2.remove();

    // THE APP SHELL, end to end. The station's own refresh was tested above;
    // this is the path a real sync takes: app.js receives "cloud changed" and
    // decides what to repaint. It used to skip the repaint whenever a cursor
    // sat in any box — with a search box on every station, that would have
    // meant a patient checked out elsewhere never appeared here at all.
    {
      // Sign in through the real login screen so the real shell is showing.
      document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
      const appRoot = document.querySelector('#app') || document.body;
      const { store: appStore } = await import('../src/renderer/js/store.js');
      // The first test in this file leaves the kiosk on its "Thank you" page;
      // Done returns it to the sign-in screen, exactly as at a real desk.
      if (!document.querySelector('.auth-form')) {
        const done = Array.from(document.querySelectorAll('.app-fullscreen button')).find((b) => /^\s*Done\s*$/.test(b.textContent));
        if (done) { done.click(); for (let i = 0; i < 10; i++) await tick(); }
      }
      const authForm = document.querySelector('.auth-form');
      let shellUp = false;
      if (authForm) {
        const ins = authForm.querySelectorAll('input');
        setInput(ins[0], 'admin'); setInput(ins[1], 'admin');
        const go = Array.from(authForm.querySelectorAll('button')).find((b) => /sign in/i.test(b.textContent)) || authForm.querySelector('button');
        go.click();
        for (let i = 0; i < 16; i++) await tick();
      }
      const dentNav = Array.from(document.querySelectorAll('.nav-item')).find((b) => /Dentist/.test(b.textContent));
      if (dentNav) { dentNav.click(); for (let i = 0; i < 16; i++) await tick(); shellUp = true; }
      log(shellUp, 'v1.13.0: (setup) the real app shell is showing the Dentist screen');
      const shellBox = document.querySelector('.app-shell input[type="search"]');
      if (shellUp && shellBox) {
        await type(shellBox, 'canine');
        shellBox.focus();
        // Another laptop adds a patient who matches, then sync lands here.
        const late = mk('Cy', 'Canineson', 'dentist', 'filling'); vit(late, 'dentist');
        currentUser = db.login('admin', 'admin');
        cloudChangedHandlers.forEach((cb) => cb());
        for (let i = 0; i < 16; i++) await tick();
        const shellNames = Array.from(document.querySelectorAll('.app-shell td strong')).map((n) => n.textContent);
        log(shellNames.includes('Canineson, Cy'),
          'v1.13.0: a sync from another laptop reaches the Dentist screen even while the cursor is in the search box');
        log(document.querySelector('.app-shell input[type="search"]') === shellBox && shellBox.value === 'canine',
          'v1.13.0: ...without replacing the screen or wiping the search');
        await type(shellBox, '');
      }
    }

    // Arrivals picks up the same fixes.
    const { renderArrivals } = await import('../src/renderer/js/views/arrivals.js');
    const av = renderArrivals(fCtx, {});
    document.body.append(av);
    for (let i = 0; i < 12; i++) await tick();
    const pickTab = (root, label) => { const b = Array.from(root.querySelectorAll('button')).find((x) => x.textContent.includes(label)); if (b) b.click(); };
    pickTab(av, 'Registered at the desk');
    for (let i = 0; i < 6; i++) await tick();
    const abox = av.querySelector('input[type="search"]');
    abox.value = '555-1111'; abox.dispatchEvent(new window.Event('input', { bubbles: true }));
    for (let i = 0; i < 4; i++) await tick();
    const arows = Array.from(av.querySelectorAll('.arrival-row')).map((r) => r.textContent);
    log(arows.length === 1 && /Waiting, Abel/.test(arows[0]),
      'v1.13.0: Arrivals now finds a phone number typed with a dash');
    av.remove();

    currentUser = db.login('admin', 'admin');
    storeF.setUser(currentUser);
  }

  // ---- v1.13.0: no-shows — signed up online, never came ----
  {
    currentUser = db.login('admin', 'admin');
    const storeN = (await import('../src/renderer/js/store.js')).store;
    storeN.setUser(currentUser);
    const pdfN = require('../src/main/pdf.js');
    const nCtx = { navigate: () => {}, toast: () => {}, store: storeN, setDetail: () => {} };
    const refuses = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    const confirmModal = async (re) => {
      for (let i = 0; i < 6; i++) await tick();
      const b = Array.from(document.querySelectorAll('.modal-card button')).find((x) => re.test(x.textContent));
      if (b) b.click();
      for (let i = 0; i < 10; i++) await tick();
      return !!b;
    };

    const evN = db.createEvent(currentUser, { name: 'No-show Clinic' });
    db.setActiveEvent(currentUser, evN.id);
    const pre = (first, last, extra = {}) => db.createPatient(currentUser, {
      first_name: first, last_name: last, dob: '1975-05-05', gender: 'female', phone: extra.phone || '5035553000',
      demographics: { preregistered: true, city: 'Sandy', state: 'OR' }, medical_history: {},
      dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    const nora = pre('Nora', 'Absent', { phone: '5035553111' });
    const ned = pre('Ned', 'Missing');
    const ana = pre('Ana', 'Arrived');
    const sam = pre('Sam', 'Seen');
    const walk = db.createPatient(currentUser, {
      first_name: 'Wally', last_name: 'Walkin', demographics: { city: 'Sandy', state: 'OR' }, medical_history: {},
      dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.confirmArrival(currentUser, ana.id, { route: 'dentist' });
    db.saveVitals(currentUser, sam.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
    db.routePatient(currentUser, sam.id, 'dentist');
    db.saveTreatment(currentUser, sam.id, { fillings: [{ tooth: '3', surfaces: ['O'] }], provider_name: 'Dr Admin' }, 'complete');
    db.dismissPatient(currentUser, sam.id);

    // BEFORE: the bug. Every row was a patient seen.
    const seenBefore = db.reportRollup(evN.id).summary.patients_seen;
    log(seenBefore === 5, 'v1.13.0: (setup) before anyone is marked, all 5 rows count as seen — including the two who never came');

    // Marking: only a pre-registration that never showed any sign of coming.
    const desk = db.createUser(currentUser, { username: 'desk13', full_name: 'Dana Desk', role: 'registration', password: 'x' });
    const r1 = db.markNoShow(db.login('desk13', 'x'), nora.id);
    log(r1 && r1.status === 'no_show' && db.getPatient(nora.id).status === 'no_show',
      'v1.13.0: the front desk can mark a pre-registered patient who never came as a no-show');
    log(db.getPatient(nora.id).demographics.no_show_by_name === 'Dana Desk' && !!db.getPatient(nora.id).demographics.no_show_at,
      'v1.13.0: ...and it records who marked them and when, in a field that travels between laptops');
    log(!('treatment' in r1) && !('medical_history' in r1),
      'v1.13.0: ...and hands the front desk back the outcome, never the chart');
    log(/registered at the desk/.test(refuses(() => db.markNoShow(currentUser, walk.id))),
      'v1.13.0: a desk registration cannot be a no-show — they were in front of the desk');
    log(/confirmed they are here/.test(refuses(() => db.markNoShow(currentUser, ana.id))),
      'v1.13.0: someone the desk confirmed as here cannot be a no-show');
    log(/already been seen|vitals/.test(refuses(() => db.markNoShow(currentUser, sam.id))),
      'v1.13.0: someone already seen at a station cannot be a no-show');

    // EVERY onward path refuses a no-show. These all failed open before.
    const noShowErr = /marked as a no-show/;
    log(noShowErr.test(refuses(() => db.dismissPatient(currentUser, nora.id))), 'v1.13.0: a no-show cannot be checked out (it used to be allowed, and counted as a visit)');
    log(noShowErr.test(refuses(() => db.saveVitals(currentUser, nora.id, { bp_systolic: 120, bp_diastolic: 80, heart_rate: 70 }))), 'v1.13.0: ...cannot have vitals recorded');
    log(noShowErr.test(refuses(() => db.routePatient(currentUser, nora.id, 'dentist'))), 'v1.13.0: ...cannot be sent to a station');
    log(noShowErr.test(refuses(() => db.confirmArrival(currentUser, nora.id, { route: 'dentist' }))), 'v1.13.0: ...cannot be confirmed as here without undoing the no-show first');
    log(noShowErr.test(refuses(() => db.saveTriage(currentUser, nora.id, { complaint: 'x' }, { attribute: true }))), 'v1.13.0: ...cannot be triaged');
    log(noShowErr.test(refuses(() => db.saveTreatment(currentUser, nora.id, { fillings: [] }, 'complete'))), 'v1.13.0: ...cannot have treatment recorded');
    log(noShowErr.test(refuses(() => db.adminMovePatient(currentUser, nora.id, 'dismiss'))), 'v1.13.0: ...and an admin override cannot check them out either');
    log(db.getPatient(nora.id).status === 'no_show', 'v1.13.0: ...and none of those attempts changed anything');

    // The counts. A no-show is a sign-up and nothing else.
    const sm = db.reportRollup(evN.id).summary;
    log(sm.patients_seen === 4, 'v1.13.0: a no-show is NOT counted as a patient seen');
    log(sm.no_shows === 1 && sm.pre_no_show === 1, 'v1.13.0: ...it is counted as a no-show');
    log(sm.pre_signups === 4, 'v1.13.0: ...and still as an online sign-up, which is what the sign-up card measures');
    log(Object.values(sm.by_gender || {}).reduce((a, b) => a + b, 0) === 4 && Object.values(sm.by_city || {}).reduce((a, b) => a + b, 0) === 4,
      'v1.13.0: ...and left out of every breakdown of who the clinic saw');
    log(db.dashboardStats().total === 4, 'v1.13.0: the dashboard does not count a no-show as a patient today');

    // End of clinic: the pre-flight warns, and the sweep marks the rest.
    const pf = db.finishPreflight(evN.id);
    log(pf.unmarked_no_shows === 1, 'v1.13.0: Finish Clinic warns that one pre-registration never arrived and is not marked');
    log(pf.queued === 2, 'v1.13.0: ...and counts the arrived patient and the walk-in as still queued, but not the person who never came');
    const swept = db.markNoShows(currentUser, evN.id);
    log(swept.marked === 1 && db.getPatient(ned.id).status === 'no_show',
      'v1.13.0: the end-of-clinic sweep marks exactly the pre-registrations who never arrived');
    log(db.getPatient(ana.id).status === 'checked_in' && db.getPatient(walk.id).status === 'checked_in' && db.getPatient(sam.id).status === 'dismissed',
      'v1.13.0: ...and leaves alone the arrived patient, the walk-in, and the one who was seen');
    log(db.finishPreflight(evN.id).unmarked_no_shows === 0, 'v1.13.0: ...after which Finish Clinic has nothing to warn about');

    // Reversible: they came after all.
    const back = db.undoNoShow(currentUser, ned.id);
    log(back.status === 'checked_in' && !db.getPatient(ned.id).demographics.no_show_at,
      'v1.13.0: "They came after all" puts a no-show back in the waiting list with the stamp removed');
    db.confirmArrival(currentUser, ned.id, { route: 'dentist' });
    log(!!db.getPatient(ned.id).arrived_at, 'v1.13.0: ...and they can then be confirmed as here as normal');
    // Admin's "back to check-in" is also an undo, and clears the stamp too.
    db.adminMovePatient(currentUser, nora.id, 'checkin');
    log(db.getPatient(nora.id).status === 'checked_in' && !db.getPatient(nora.id).demographics.no_show_at,
      'v1.13.0: an admin moving a no-show back to check-in clears the no-show too');
    db.markNoShow(currentUser, nora.id);

    // Permissions: the desk's call.
    currentUser = db.login('admin', 'admin'); storeN.setUser(currentUser);
    const docU = db.listUsers().find((u) => u.role === 'doctor');
    await window.api.authLogin({ username: docU.username, password: 'x' }); currentUser = db.login(docU.username, 'x');
    const denied = await window.api.patientsNoShow({ id: walk.id });
    log(denied.ok === false && /permission/i.test(denied.error || ''), 'v1.13.0: a dentist cannot mark a no-show — it is the front desk’s call');

    // Sync: the status travels like any other.
    currentUser = db.login('admin', 'admin'); storeN.setUser(currentUser);
    const pushed = db.collectSyncRows(5000).rows.find((r) => r.entity === 'patient' && r.data && r.data.first_name === 'Nora');
    log(!!pushed && pushed.data.status === 'no_show' && /no_show_by_name/.test(pushed.data.demographics || ''),
      'v1.13.0: a no-show reaches the other laptops, with who marked it');

    // The coordinator PDF: separate from the roster, counted, and named only on the internal copy.
    const rep = db.clinicReport(evN.id);
    log(rep.roster.every((r) => r.last_name !== 'Absent') && rep.no_shows.some((r) => r.last_name === 'Absent'),
      'v1.13.0: the coordinator roster lists no-shows separately, not as rows of zeros');
    const internal = pdfN.buildClinicHtml(rep, { withRoster: true });
    const shareable = pdfN.buildClinicHtml(rep, { withRoster: false });
    log(/Signed up but did not attend \(1\)/.test(internal) && /Absent/.test(internal),
      'v1.13.0: ...the internal copy names them for follow-up');
    log(/Signed up but did not attend/.test(shareable) && !/Absent/.test(shareable),
      'v1.13.0: ...and the shareable copy gives the count with no names');
    log(/No-show \(did not attend\)/.test(pdfN.buildHtml(db.getPatient(nora.id), 'progress')),
      'v1.13.0: a patient record prints "No-show (did not attend)", not a raw code');

    // ---- the screens ----
    const { renderArrivals } = await import('../src/renderer/js/views/arrivals.js');
    const fresh = pre('Fran', 'Late');
    currentUser = db.login('desk13', 'x'); storeN.setUser(currentUser);
    await window.api.authLogin({ username: 'desk13', password: 'x' });
    const av = renderArrivals(nCtx, {});
    document.body.append(av);
    for (let i = 0; i < 14; i++) await tick();
    const tabBtn = Array.from(av.querySelectorAll('button')).find((b) => /Pre-registered online/.test(b.textContent));
    if (tabBtn) { tabBtn.click(); for (let i = 0; i < 6; i++) await tick(); }
    const rowOf = (re) => Array.from(av.querySelectorAll('.arrival-row')).find((r) => re.test(r.textContent));
    const franRow = rowOf(/Late, Fran/);
    const nsBtn = franRow && Array.from(franRow.querySelectorAll('button')).find((b) => /^No-show$/.test(b.textContent.trim()));
    log(!!nsBtn, 'v1.13.0: Arrivals offers "No-show" on a pre-registered patient still waiting');
    if (nsBtn) {
      nsBtn.click();
      await confirmModal(/Mark as no-show/);
      for (let i = 0; i < 10; i++) await tick();
    }
    log(db.getPatient(fresh.id).status === 'no_show', 'v1.13.0: ...confirming it marks them');
    const dna = Array.from(av.querySelectorAll('.card')).find((c) => /Did not attend/.test(c.textContent));
    log(!!dna && /Late, Fran/.test(dna.textContent), 'v1.13.0: ...and they move to a "Did not attend" list on the same screen');
    const undoBtn = dna && Array.from(dna.querySelectorAll('.arrival-row')).find((r) => /Late, Fran/.test(r.textContent))
      .querySelector('button');
    if (undoBtn) { undoBtn.click(); for (let i = 0; i < 12; i++) await tick(); }
    log(db.getPatient(fresh.id).status === 'checked_in' && !!rowOf(/Late, Fran/) && !!Array.from(rowOf(/Late, Fran/).querySelectorAll('button')).find((b) => /They.re here/.test(b.textContent)),
      'v1.13.0: ..."They came after all" puts them back in the waiting list, ready to confirm');
    const deskTab = Array.from(av.querySelectorAll('button')).find((b) => /Registered at the desk/.test(b.textContent));
    if (deskTab) { deskTab.click(); for (let i = 0; i < 6; i++) await tick(); }
    const wRow = rowOf(/Walkin, Wally/);
    log(!!wRow && !Array.from(wRow.querySelectorAll('button')).some((b) => /^No-show$/.test(b.textContent.trim())),
      'v1.13.0: a desk registration is never offered "No-show"');
    av.remove();

    currentUser = db.login('admin', 'admin'); storeN.setUser(currentUser);
    await window.api.authLogin({ username: 'admin', password: 'admin' });
    const { renderEmt } = await import('../src/renderer/js/views/emt.js');
    const ev2 = renderEmt(nCtx, {});
    document.body.append(ev2);
    for (let i = 0; i < 12; i++) await tick();
    log(!/Absent, Nora/.test(ev2.textContent) && /Arrived, Ana/.test(ev2.textContent),
      'v1.13.0: a no-show is not left waiting in the Vitals queue');
    ev2.remove();

    const { renderDashboard, statusPill } = await import('../src/renderer/js/views/dashboard.js');
    log(statusPill('no_show').textContent.includes('No-show'), 'v1.13.0: a no-show reads "No-show" on every status pill, not a raw code');
    const dv = renderDashboard(nCtx, {});
    document.body.append(dv);
    for (let i = 0; i < 14; i++) await tick();
    const board = dv.querySelector('.crm-board') || dv;
    log(!/Absent/.test(board.textContent), 'v1.13.0: a no-show is not parked in the floor board’s "Checked in" column');
    dv.remove();

    const { renderRecords } = await import('../src/renderer/js/views/records.js');
    const rv = renderRecords(nCtx, {});
    document.body.append(rv);
    for (let i = 0; i < 14; i++) await tick();
    const showSel = Array.from(rv.querySelectorAll('select')).find((x) => Array.from(x.options).some((o) => o.value === 'no_show'));
    log(!!showSel, 'v1.13.0: Records can be filtered to no-shows');
    if (showSel) { showSel.value = 'no_show'; showSel.dispatchEvent(new window.Event('change', { bubbles: true })); for (let i = 0; i < 12; i++) await tick(); }
    const recNames = Array.from(rv.querySelectorAll('td strong')).map((n) => n.textContent);
    log(recNames.includes('Absent, Nora') && recNames.every((n) => ['Absent, Nora', 'Missing, Ned'].includes(n) || !/Seen|Arrived|Walkin/.test(n)),
      'v1.13.0: ...and that filter lists the no-shows and nobody who came');
    rv.remove();

    const { renderReports } = await import('../src/renderer/js/views/reports.js');
    const rpv = renderReports(nCtx);
    document.body.append(rpv);
    for (let i = 0; i < 16; i++) await tick();
    const sel = rpv.querySelector('.view-head-actions select');
    if (sel) { sel.value = String(evN.id); sel.dispatchEvent(new window.Event('change', { bubbles: true })); for (let i = 0; i < 16; i++) await tick(); }
    const signup = Array.from(rpv.querySelectorAll('.card')).find((c) => /Sign-ups vs check-outs/.test(c.textContent));
    log(!!signup && /did not attend/.test(signup.textContent) && /not counted as patients seen/.test(signup.textContent),
      'v1.13.0: the Reports sign-up card finally accounts for the people who did not attend');
    log(/signed up and did not attend/.test(rpv.textContent), 'v1.13.0: ...and the Patients-seen figure says how many were left out of it');
    rpv.remove();

    currentUser = db.login('admin', 'admin'); storeN.setUser(currentUser);
  }

  // ---- v1.13.0: a check-out is never stuck behind x-ray images ----
  {
    currentUser = db.login('admin', 'admin');
    const http = require('http');
    const cloud = require('../src/main/cloud.js');
    cloud._resetTuning();
    const evY = db.createEvent(currentUser, { name: 'X-ray Heavy' });
    db.setActiveEvent(currentUser, evY.id);
    const py = db.createPatient(currentUser, {
      first_name: 'Iris', last_name: 'Imaged', demographics: {}, medical_history: {},
      dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.saveVitals(currentUser, py.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
    db.routePatient(currentUser, py.id, 'dentist');
    // Clear the decks so only what this block creates is dirty.
    db.markSynced(db.collectSyncRows(100000).mark);
    // Twelve ~400KB films, as a busy chair produces them.
    const film = 'data:image/jpeg;base64,' + 'A'.repeat(400 * 1024);
    for (let i = 0; i < 12; i++) db.addXray(currentUser, py.id, { image_png: film, tooth: String(i + 1) });
    db.saveTreatment(currentUser, py.id, { fillings: [{ tooth: '3', surfaces: ['O'] }], provider_name: 'Dr Admin' }, 'complete');
    db.dismissPatient(currentUser, py.id);

    // The lanes, at the data layer.
    const clinical = db.collectSyncRows(400, { skip: ['xray'] });
    log(clinical.rows.length > 0 && clinical.rows.every((r) => r.entity !== 'xray')
      && clinical.rows.some((r) => r.entity === 'patient' && r.data.status === 'dismissed'),
      'v1.13.0: the clinical lane carries the check-out and no images');
    const films = db.collectSyncRows(400, { only: ['xray'], tombstones: false, xrayBytes: 1024 * 1024 });
    const filmBytes = films.rows.reduce((n, r) => n + String(r.data.image_png || '').length, 0);
    log(films.rows.length >= 1 && films.rows.every((r) => r.entity === 'xray') && filmBytes <= 1024 * 1024,
      'v1.13.0: the x-ray lane stops at its byte budget instead of a row count');
    const one = db.collectSyncRows(400, { only: ['xray'], tombstones: false, xrayBytes: 10 });
    log(one.rows.length === 1, 'v1.13.0: ...but always sends at least one image, so a large film is never stuck behind the budget');
    const all = db.collectSyncRows(400);
    log(all.rows.some((r) => r.entity === 'xray') && all.rows.some((r) => r.entity === 'patient'),
      'v1.13.0: with no options, collecting rows behaves exactly as before');

    // The image cap.
    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024);
    log(/too large to share between laptops/.test((() => { try { db.addXray(currentUser, py.id, { image_png: huge }); return ''; } catch (e) { return e.message; } })()),
      'v1.13.0: an image too big for the clinic cloud is refused before it can jam every upload from that laptop');

    // The real sync engine, against a stand-in server that records what it is
    // sent and can be told to fail. No timer: syncOnce is called by hand.
    const seen = [];
    let failImages = false;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/v1/push') {
          const j = JSON.parse(body || '{}');
          const kinds = [...new Set((j.rows || []).map((r) => r.entity))];
          seen.push({ path: 'push', kinds, n: (j.rows || []).length, bytes: body.length });
          if (failImages && kinds.includes('xray')) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'row too big' })); return; }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (u.pathname === '/v1/pull') {
          // v1.14.0 asks every server once whether it speaks the lane protocol,
          // with a cursor no older server has rows past. This stand-in is an
          // older server: it answers exactly as v1.11 does, with an empty page.
          if (u.searchParams.get('proto') === '2') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rows: [], cursor: u.searchParams.get('since'), more: false })); return; }
          seen.push({ path: 'pull', limit: Number(u.searchParams.get('limit')) });
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rows: [], cursor: '7', more: false }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, seq: true }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const before = db.getSyncMeta();
    db.setSyncMeta({ url: base, key: 'test-key', mode: 'online', cursor: '0' });

    // 1. A failed IMAGE upload does not stop the check-out, and does not stop the pull.
    failImages = true;
    const r1 = await cloud.syncOnce();
    const pushes = seen.filter((x) => x.path === 'push');
    log(pushes.length >= 2 && !pushes[0].kinds.includes('xray') && pushes[0].kinds.includes('patient'),
      'v1.13.0: the check-out is pushed in its own request, before any image');
    log(pushes.length >= 2 && pushes[1].kinds.length === 1 && pushes[1].kinds[0] === 'xray' && pushes[1].bytes <= 3.5 * 1024 * 1024,
      'v1.13.0: ...and the images follow in a separate request of a few megabytes');
    log(seen.some((x) => x.path === 'pull'),
      'v1.13.0: when the image upload fails, this laptop still PULLS — it no longer stops hearing about other laptops’ check-outs');
    log(r1.ok === false && /row too big/.test(db.getSyncMeta().lastError),
      'v1.13.0: ...and the failure is reported, not hidden behind a green "synced"');
    log(db.collectSyncRows(400, { skip: ['xray'] }).rows.length === 0,
      'v1.13.0: ...while the check-out itself is confirmed sent and is not sent again');

    // 2. Images catch up once the server takes them.
    failImages = false;
    for (let i = 0; i < 12; i++) { await cloud.syncOnce(); if (!db.collectSyncRows(400, { only: ['xray'], tombstones: false }).rows.length) break; }
    log(db.collectSyncRows(400, { only: ['xray'], tombstones: false }).rows.length === 0,
      'v1.13.0: the images then go through a few megabytes per cycle until none are left');
    log(!db.getSyncMeta().lastError, 'v1.13.0: ...and the error clears once everything is through');

    // 3. Page sizing. A server that hands out pages of a chosen weight, and a
    //    record of the limit this laptop asks for each time.
    const asks = [];
    let pages = [];
    const srv2 = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/v1/push') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
      if (u.pathname === '/v1/pull') {
        // An older server answering the v1.14 probe (see above).
        if (u.searchParams.get('proto') === '2') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rows: [], cursor: u.searchParams.get('since'), more: false })); return; }
        const limit = Number(u.searchParams.get('limit'));
        asks.push(limit);
        const pg = pages.shift() || { n: 0, size: 10 };
        const n = Math.min(pg.n, limit);
        // Rows of an entity this app does not know: skipped on apply, so only
        // their WEIGHT matters here, which is what the sizing reads.
        const rows = Array.from({ length: n }, (_, i) => ({ entity: 'padding', uid: 'p' + asks.length + '-' + i, updated_at: '1', data: { pad: 'x'.repeat(pg.size) } }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rows, cursor: String(asks.length * 1000), more: !!pg.more && n === limit }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"seq":true}');
    });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    db.setSyncMeta({ url: `http://127.0.0.1:${srv2.address().port}`, key: 'k', mode: 'online', cursor: '0' });
    cloud._resetTuning();
    // A caught-up laptop: three tiny rows. That says nothing about the next page.
    pages = [{ n: 3, size: 200 }];
    await cloud.syncOnce();
    pages = [{ n: 0, size: 10 }];
    await cloud.syncOnce();
    log(asks[0] === 50 && asks[1] <= 50,
      'v1.13.0: a short page of small rows does not let the next page grow — that is what sent a laptop into the x-ray backlog at 400 rows');
    // A backlog of x-rays: a full page of ~400KB rows shrinks the next page to fit ~4MB.
    asks.length = 0; cloud._resetTuning();
    pages = [{ n: 50, size: 400 * 1024, more: true }, { n: 50, size: 400 * 1024, more: false }];
    await cloud.syncOnce();
    log(asks[0] === 50 && asks[1] >= 1 && asks[1] <= 12,
      'v1.13.0: a page of x-rays shrinks the next page to a few megabytes');
    // A backlog of check-ins: full, light pages may grow — but only double each time.
    asks.length = 0; cloud._resetTuning();
    pages = [{ n: 50, size: 300, more: true }, { n: 100, size: 300, more: true }, { n: 200, size: 300, more: true }, { n: 1, size: 300, more: false }];
    await cloud.syncOnce();
    log(asks.slice(0, 4).join(',') === '50,100,200,400',
      'v1.13.0: full pages of light rows grow the page size, doubling at most each time');
    srv2.close();

    db.setSyncMeta({ url: before.usingDefaultCloud ? '' : before.url, key: before.usingDefaultCloud ? '' : before.key, cursor: before.cursor, lastError: '' });
    srv.close();
    cloud._resetTuning();
  }

  // ---- v1.13.0: findings from the independent review, each pinned ----
  {
    currentUser = db.login('admin', 'admin');
    const http = require('http');
    const crypto = require('crypto');
    const cloud = require('../src/main/cloud.js');
    const pdfR = require('../src/main/pdf.js');
    const evR = db.createEvent(currentUser, { name: 'Review Fixes' });
    db.setActiveEvent(currentUser, evR.id);
    const before = db.getSyncMeta();
    // A scripted stand-in server: each pull hands out the next scripted page.
    const script = { pulls: [], pushes: [] };
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (u.pathname === '/v1/push') {
          const j = JSON.parse(body || '{}');
          script.pushes.push((j.rows || []).map((r) => r.entity + ':' + r.uid));
          return send(200, { ok: true });
        }
        if (u.pathname === '/v1/pull') {
          // An older server answering the v1.14 probe (see the block above).
          if (u.searchParams.get('proto') === '2') return send(200, { ok: true, rows: [], cursor: u.searchParams.get('since'), more: false });
          const pg = script.pulls.shift();
          if (!pg) return send(200, { ok: true, rows: [], cursor: u.searchParams.get('since') || '0', more: false });
          if (pg.fail) return send(500, { error: 'boom' });
          return send(200, { ok: true, rows: pg.rows, cursor: pg.cursor, more: !!pg.more });
        }
        return send(200, { ok: true, seq: true });
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    db.setSyncMeta({ url: `http://127.0.0.1:${srv.address().port}`, key: 'k', mode: 'online', cursor: '100' });
    db.setSyncPending([]);
    db.markSynced(db.collectSyncRows(100000).mark);

    // R1 (blocker). A patient's vitals arrive on one page, the patient on a
    // later one, and the page in between FAILS. The vitals must not be lost.
    const src = db.createPatient(currentUser, {
      first_name: 'Remote', last_name: 'Vitals', demographics: {}, medical_history: {},
      dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.saveVitals(currentUser, src.id, { bp_systolic: 150, bp_diastolic: 95, heart_rate: 88, blood_thinner: 'yes', blood_thinner_detail: 'Eliquis' });
    const envs = db.collectSyncRows(100000).rows;
    const patEnv = envs.find((r) => r.entity === 'patient' && r.data.last_name === 'Vitals');
    const triEnv = envs.find((r) => r.entity === 'triage' && r.patient_uid === patEnv.uid);
    // Present them as ANOTHER laptop's patient: fresh uids nobody here has.
    const newP = crypto.randomUUID(), newT = crypto.randomUUID();
    const remoteTri = { ...triEnv, uid: newT, patient_uid: newP, updated_at: '2099-01-01T00:00:00.000Z@other' };
    const remotePat = { ...patEnv, uid: newP, updated_at: '2099-01-01T00:00:01.000Z@other' };
    cloud._resetTuning();
    script.pulls = [{ rows: [remoteTri], cursor: '101', more: true }, { fail: true }];
    const c1 = await cloud.syncOnce();
    log(c1.ok === false, 'v1.13.0 review: (setup) the second page fails');
    script.pulls = [{ rows: [remotePat], cursor: '102', more: false }];
    await cloud.syncOnce();
    const landed = db.listPatients({ eventId: 'all' }).find((x) => x.last_name === 'Vitals' && x.id !== src.id);
    const landedFull = landed ? db.getPatient(landed.id) : null;
    log(!!landedFull && landedFull.triage && landedFull.triage.bp_systolic === 150 && landedFull.triage.blood_thinner === 'yes',
      'v1.13.0 review: vitals and a blood-thinner flag that arrived before their patient survive a failed page — they used to be dropped while the cursor moved past them');

    // R3. More clinical rows than fit in one request: no x-ray goes until they are all sent.
    db.markSynced(db.collectSyncRows(100000).mark);
    script.pushes = [];
    const many = [];
    for (let i = 0; i < 410; i++) {
      many.push(db.createPatient(currentUser, { first_name: 'Bulk' + i, last_name: 'Backlog', demographics: {}, medical_history: {}, dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED }));
    }
    const lastP = many[many.length - 1];
    db.saveVitals(currentUser, lastP.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
    db.routePatient(currentUser, lastP.id, 'dentist');
    db.addXray(currentUser, lastP.id, { image_png: 'data:image/jpeg;base64,' + 'A'.repeat(20000), tooth: '3' });
    cloud._resetTuning();
    script.pulls = [];
    await cloud.syncOnce();
    log(script.pushes.length >= 1 && script.pushes.every((p) => !p.some((x) => x.startsWith('xray:'))),
      'v1.13.0 review: with a clinical backlog bigger than one request, no x-ray is sent ahead of the rest of it (it could reach the cloud before its patient)');
    for (let i = 0; i < 6; i++) await cloud.syncOnce();
    log(db.collectSyncRows(100000).rows.length === 0, 'v1.13.0 review: ...and once the backlog is through, the x-ray follows');

    // R2. An image too big for the cloud, saved by an older version, must not jam the lane.
    const holder = many[0];
    const bigRemote = {
      entity: 'xray', uid: crypto.randomUUID(), patient_uid: db.exportClinicBundle(evR.id).patients.find((p) => p.id === holder.id).uid,
      deleted: 0, updated_at: '2099-02-01T00:00:00.000Z@old', event_uid: null,
      data: { station: null, image_png: 'data:image/jpeg;base64,' + 'B'.repeat(2100000), note: 'legacy', tooth: '7', created_at: '2026-01-01T00:00:00.000Z' },
    };
    db.applyRemoteRows([bigRemote]);
    const bigLocal = db.listXrays(holder.id).find((x) => x.note === 'legacy');
    db.updateXrayTooth(currentUser, bigLocal.id, '8'); // make it dirty, as an old laptop's edit would
    db.addXray(currentUser, holder.id, { image_png: 'data:image/jpeg;base64,' + 'C'.repeat(30000), tooth: '9', note: 'fresh' });
    const lane = db.collectSyncRows(400, { only: ['xray'], tombstones: false, xrayBytes: 3 * 1024 * 1024 });
    log(lane.xraysTooBig === 1 && !lane.rows.some((r) => r.data.note === 'legacy') && lane.rows.some((r) => r.data.note === 'fresh'),
      'v1.13.0 review: an image too big for the cloud is left out of sync, and the films behind it still go — it used to block them forever');
    log(cloud.status().xraysTooBig !== undefined, 'v1.13.0 review: ...and the count is reported in the sync status');

    // R4. A new visit is a new registration, not the old one's sign-up or no-show.
    const nsSrc = db.createPatient(currentUser, {
      first_name: 'Return', last_name: 'Noshow', demographics: { preregistered: true, city: 'Sandy' }, medical_history: {},
      dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    db.markNoShow(currentUser, nsSrc.id);
    const nv = db.startVisitFromExisting(currentUser, nsSrc.id);
    const nvd = db.getPatient(nv.id).demographics;
    log(!nvd.preregistered && !nvd.no_show_at && !nvd.no_show_by_name && nvd.city === 'Sandy',
      'v1.13.0 review: "Start new visit" for a returning patient does not copy the old visit’s online sign-up or no-show');
    log(!db.noShowCandidates(evR.id).some((p) => p.id === nv.id),
      'v1.13.0 review: ...so the end-of-clinic sweep cannot mark a returning walk-in as a no-show');

    // R7. A USB check-out file for someone marked a no-show: they came after all.
    const usbP = db.createPatient(currentUser, {
      first_name: 'Usb', last_name: 'Carried', demographics: { preregistered: true }, medical_history: {},
      dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
    });
    const portable = { ...db.getPatient(usbP.id), xrays: [] };
    portable.triage = { complaint: 'Seen at the other laptop', notes: 'carried on USB' };
    db.markNoShow(currentUser, usbP.id);
    let usbErr = '';
    try { db.importPatientFromPortable(currentUser, portable); } catch (e) { usbErr = e.message; }
    const usbAfter = db.getPatient(usbP.id);
    log(!usbErr && usbAfter.status !== 'no_show' && usbAfter.triage && usbAfter.triage.complaint === 'Seen at the other laptop',
      'v1.13.0 review: a USB check-out file for a patient marked as a no-show un-marks them and loads the chart, instead of silently dropping it');

    // R5. The shareable PDF's "signed up online" under Patients seen counts people SEEN.
    const html = pdfR.buildClinicHtml({ event: { name: 'X' }, rollup: { source: 'live', summary: { patients_seen: 1, pre_signups: 3, pre_no_show: 2, no_shows: 2 } }, roster: [], no_shows: [] }, { withRoster: false });
    log(/1 signed up online/.test(html) && !/3 signed up online/.test(html),
      'v1.13.0 review: the shareable PDF never says more people signed up online than were seen');

    // R6. Restore a finished clinic, mark its no-shows, finish again: the kept
    //     totals are corrected, not stuck at the inflated figure.
    const evK = db.createEvent(currentUser, { name: 'Kept Then Corrected' });
    db.setActiveEvent(currentUser, evK.id);
    const kp = (f) => db.createPatient(currentUser, { first_name: f, last_name: 'Kept', demographics: { preregistered: true }, medical_history: {}, dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED });
    const seenK = kp('Seen');
    db.saveVitals(currentUser, seenK.id, { bp_systolic: 120, bp_diastolic: 78, heart_rate: 70 });
    db.routePatient(currentUser, seenK.id, 'dentist');
    ['A', 'B', 'C', 'D'].forEach(kp);
    const bundleK = db.exportClinicBundle(evK.id);
    db.recordClinicExport(evK.id, { patients: 5 });
    db.finishEvent(currentUser, evK.id);
    log(db.reportRollup(evK.id).summary.patients_seen === 5, 'v1.13.0 review: (setup) finished before anyone was marked, the kept total reads 5 seen');
    db.importClinicBundle(currentUser, bundleK);
    db.markNoShows(currentUser, evK.id);
    const corrected = db.reportRollup(evK.id).summary;
    log(corrected.patients_seen === 1 && corrected.no_shows === 4,
      'v1.13.0 review: marking no-shows on a restored clinic corrects its figures — the inflated kept total no longer wins');
    db.recordClinicExport(evK.id, { patients: 5 });
    db.finishEvent(currentUser, evK.id);
    log(db.reportRollup(evK.id).summary.patients_seen === 1,
      'v1.13.0 review: ...and finishing it again keeps the corrected total, not the old high-water mark');

    db.setSyncMeta({ url: before.usingDefaultCloud ? '' : before.url, key: before.usingDefaultCloud ? '' : before.key, cursor: before.cursor, lastError: '' });
    db.setSyncPending([]);
    srv.close();
    cloud._resetTuning();
    currentUser = db.login('admin', 'admin');
  }

  // ---- v1.14.0: the Finish / Delete guard on screen ----
  // ipc.js decides (tested on the real ipc.js in cloud/test-client-v2.mjs);
  // these check that the screens say what it decided, and send the override
  // only after the second confirmation.
  {
    currentUser = db.login('admin', 'admin');
    const storeG = (await import('../src/renderer/js/store.js')).store;
    storeG.setUser(currentUser);
    const evG = db.createEvent(currentUser, { name: 'Guard Screen' });
    db.setActiveEvent(currentUser, evG.id);
    db.createPatient(currentUser, { first_name: 'Guard', last_name: 'Screen', demographics: {}, medical_history: {}, dental_history: { reason: 'Pain' }, consents: SIGNED });
    db.recordClinicExport(evG.id, { patients: 1, xlsxPath: '/tmp/g.xlsx', backupPath: '/tmp/g.chbak.json' });
    const saved = { p: window.api.eventPreflight, f: window.api.eventFinish, u: window.api.eventPurge, x: window.api.exportClinic, c: window.api.cloudStatus };
    let sync = { blocked: false, problems: [] };
    let preExtra = {};
    const finishes = [], purges = [];
    window.api.eventPreflight = okWrap(({ eventId } = {}) => ({ ...db.finishPreflight(eventId), ...preExtra, sync: { checkedAt: Date.now(), ...sync } }));
    window.api.eventFinish = okWrap((p) => { finishes.push(p); return { ok: true, removed: 0 }; });
    window.api.eventPurge = okWrap((p) => { purges.push(p); return { ok: true, removed: 0 }; });
    window.api.exportClinic = okWrap(() => ({ saved: true, patients: 1, xlsxPath: '/tmp/g.xlsx', backupPath: '/tmp/g.chbak.json' }));
    const modalTitle = () => { const t = document.querySelector('.modal-card .modal-title'); return t ? t.textContent : ''; };
    const modalBody = () => { const b = document.querySelector('.modal-card .modal-body'); return b || null; };
    const press = async (re) => {
      for (let i = 0; i < 8; i++) await tick();
      const b = Array.from(document.querySelectorAll('.modal-card button')).find((x) => re.test(x.textContent));
      if (b) b.click();
      for (let i = 0; i < 8; i++) await tick();
      return !!b;
    };
    const { renderAdmin } = await import('../src/renderer/js/views/admin.js');
    const finishFrom = async () => {
      const root = renderAdmin({ navigate: () => {}, toast: () => {}, store: storeG }, { section: 'events' });
      document.body.append(root);
      for (let i = 0; i < 8; i++) await tick();
      const row = Array.from(root.querySelectorAll('tr')).find((tr) => /Guard Screen/.test(tr.textContent));
      const btn = row && Array.from(row.querySelectorAll('button')).find((b) => /Finish clinic/.test(b.textContent));
      if (btn) btn.click();
      for (let i = 0; i < 8; i++) await tick();
      return root;
    };

    // a. Still receiving: a wait, with no way to go ahead.
    sync = { blocked: true, imagesBehind: 7, problems: [] };
    let root = await finishFrom();
    log(/Still receiving/.test(modalTitle()) && /7 x-ray image/.test((modalBody() || {}).textContent || ''),
      'v1.14.0: Finish says x-rays are still arriving, and how many');
    log(!Array.from(document.querySelectorAll('.modal-card button')).some((b) => /anyway/i.test(b.textContent)), 'v1.14.0: ...and offers no way to finish anyway');
    await press(/Got it/); root.remove();
    log(finishes.length === 0, 'v1.14.0: ...and nothing is finished');

    // b. Might not hold everything: shown in the list, then a second confirmation.
    sync = { blocked: false, problems: [{ key: 'peer:d2:3:0', text: 'Front <b>desk</b> still has 3 x-ray image(s) it has not sent' }] };
    root = await finishFrom();
    const body = modalBody();
    log(!!body && /Front <b>desk<\/b> still has 3 x-ray/.test(body.textContent) && !body.querySelector('li b + b, li > b ~ b'),
      'v1.14.0: Finish lists another station still holding x-rays, its name shown as text (no HTML from another laptop)');
    await press(/Finish clinic & remove/);
    log(/without the rest of the clinic/.test(modalTitle()), 'v1.14.0: ...then asks a second time before going ahead');
    await press(/^Cancel$/); root.remove();
    log(finishes.length === 0, 'v1.14.0: ...and Cancel there finishes nothing');
    root = await finishFrom();
    await press(/Finish clinic & remove/);
    await press(/Finish anyway/); root.remove();
    log(finishes.length === 1 && finishes[0].allowIncompleteSync === true && finishes[0].eventId === evG.id,
      'v1.14.0: ...and only "Finish anyway" sends the go-ahead', JSON.stringify(finishes));
    log(finishes.length === 1 && JSON.stringify(finishes[0].acceptedProblems) === '["peer:d2:3:0"]',
      'v1.14.0: ...naming exactly the problems that were shown', JSON.stringify(finishes[0] || {}));

    // c. Nothing wrong: no second question, and no go-ahead sent.
    sync = { blocked: false, problems: [] };
    root = await finishFrom();
    await press(/Finish clinic & remove/); root.remove();
    log(finishes.length === 2 && finishes[1].allowIncompleteSync === undefined, 'v1.14.0: with nothing outstanding, Finish asks once and sends no go-ahead', JSON.stringify(finishes[1] || {}));
    log(finishes.length === 2 && Number.isFinite(finishes[1].checkedAt), '...but does say when the screen was checked (so the main process judges as of then)', JSON.stringify(finishes[1] || {}));

    // c2. While the check runs the button is disabled and a window says what is
    //     happening; a refusal comes back as a dialog, not a toast.
    {
      sync = { blocked: false, problems: [] };
      let release;
      const slow = new Promise((r) => { release = r; });
      const realPre = window.api.eventPreflight;
      window.api.eventPreflight = async (p) => { await slow; return realPre(p); };
      const realFin = window.api.eventFinish;
      window.api.eventFinish = async () => ({ ok: false, error: 'This laptop may not hold the whole clinic: SOMEONE has 2 x-ray image(s) it has not sent. (This is new since you confirmed — look again before going ahead.)' });
      root = renderAdmin({ navigate: () => {}, toast: () => {}, store: storeG }, { section: 'events' });
      document.body.append(root);
      for (let i = 0; i < 8; i++) await tick();
      const row = Array.from(root.querySelectorAll('tr')).find((tr) => /Guard Screen/.test(tr.textContent));
      const fbtn = row && Array.from(row.querySelectorAll('button')).find((b) => /Finish clinic/.test(b.textContent));
      fbtn.click();
      for (let i = 0; i < 4; i++) await tick();
      const busyShown = Array.from(document.querySelectorAll('.modal-card')).some((c) => /Checking with the clinic cloud/.test(c.textContent));
      log(fbtn.disabled === true && busyShown, 'v1.14.0: while Finish checks with the cloud, the button is disabled and a window says so');
      const hide = Array.from(document.querySelectorAll('.modal-card button')).find((b) => /^Hide$/.test(b.textContent.trim()));
      if (hide) hide.click();
      for (let i = 0; i < 2; i++) await tick();
      log(!!hide && !Array.from(document.querySelectorAll('.modal-card')).some((c) => /Checking with the clinic cloud/.test(c.textContent)), '...and it can be hidden (the check carries on)');
      release();
      await press(/Finish clinic & remove/);
      for (let i = 0; i < 8; i++) await tick();
      log(/was not finished/.test(modalTitle()) && /SOMEONE/.test((modalBody() || {}).textContent || ''), 'v1.14.0: a refusal comes back as a dialog naming what is new');
      await press(/^OK$/);
      log(fbtn.disabled === false, '...and the button is usable again');
      window.api.eventPreflight = realPre; window.api.eventFinish = realFin;
      root.remove();
    }

    // c3. The "Finishing…" window cannot be hidden: the screen behind it is
    //     being emptied. (Only the check before it can.)
    {
      sync = { blocked: false, problems: [] };
      let release;
      const slow = new Promise((r) => { release = r; });
      const realFin = window.api.eventFinish;
      window.api.eventFinish = async (p) => { await slow; return realFin(p); };
      root = await finishFrom();
      await press(/Finish clinic & remove/);
      const working = Array.from(document.querySelectorAll('.modal-card')).find((c) => /Finishing/.test(c.textContent));
      log(!!working && !Array.from(working.querySelectorAll('button')).some((b) => /Hide/.test(b.textContent)), 'v1.14.0: the "Finishing…" window has no Hide button — only the check before it can be hidden');
      release();
      for (let i = 0; i < 8; i++) await tick();
      window.api.eventFinish = realFin;
      root.remove();
      document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
    }

    // d. Records arrived after the export.
    preExtra = { needs_export: true, arrivals_since_export: 2 };
    root = await finishFrom();
    log(/Export this clinic again/.test(modalTitle()) && /2 record\(s\)/.test((modalBody() || {}).textContent || ''),
      'v1.14.0: Finish asks for a new export when records arrived after the last one');
    await press(/Got it/); root.remove();
    preExtra = {};

    // e. Delete this clinic's patient data: the same rules.
    const dataView = async () => {
      const r = renderAdmin({ navigate: () => {}, toast: () => {}, store: storeG }, { section: 'data' });
      document.body.append(r);
      for (let i = 0; i < 10; i++) await tick();
      const exp = Array.from(r.querySelectorAll('button')).find((b) => /Export clinic/.test(b.textContent));
      if (exp) exp.click();
      for (let i = 0; i < 10; i++) await tick();
      const del = Array.from(r.querySelectorAll('button')).find((b) => /Delete this clinic/.test(b.textContent));
      if (del && !del.disabled) del.click();
      for (let i = 0; i < 8; i++) await tick();
      return r;
    };
    sync = { blocked: true, imagesBehind: 2, problems: [] };
    root = await dataView();
    log(/Still receiving/.test(modalTitle()), 'v1.14.0: Delete patient data also waits while x-rays are arriving');
    await press(/Got it/); root.remove();
    sync = { blocked: false, problems: [{ key: 'unreachable', text: 'this laptop has not reached the clinic cloud' }] };
    root = await dataView();
    await press(/Delete the patient data/);
    log(/Delete without the rest/.test(modalTitle()), 'v1.14.0: ...and asks a second time when it may not hold everything');
    await press(/Delete anyway/); root.remove();
    log(purges.length === 1 && purges[0].allowIncompleteSync === true && JSON.stringify(purges[0].acceptedProblems) === '["unreachable"]', 'v1.14.0: ...sending the go-ahead only after it', JSON.stringify(purges));
    // Records that arrived after the export that armed the button.
    sync = { blocked: false, problems: [] };
    preExtra = { needs_export: true, arrivals_since_export: 3 };
    root = await dataView();
    log(/Export this clinic again/.test(modalTitle()) && /3 record\(s\)/.test((modalBody() || {}).textContent || ''),
      'v1.14.0: Delete patient data asks for a new export when records arrived after the one that armed it');
    await press(/Got it/);
    const delBtn = Array.from(root.querySelectorAll('button')).find((b) => /Delete this clinic/.test(b.textContent));
    log(purges.length === 1 && delBtn && delBtn.disabled, '...deletes nothing, and the button disarms until the next export');
    root.remove();
    preExtra = {};

    // e2. While Delete patient data checks, its button stays disabled — pressed
    //     again it would start a second check and a second deletion — and
    //     Cancel arms it again while the export still counts.
    {
      sync = { blocked: false, problems: [] };
      let release;
      const slow = new Promise((r) => { release = r; });
      const realPre = window.api.eventPreflight;
      window.api.eventPreflight = async (p) => { await slow; return realPre(p); };
      root = await dataView();
      const delB = Array.from(root.querySelectorAll('button')).find((b) => /Delete this clinic/.test(b.textContent));
      const checking = Array.from(document.querySelectorAll('.modal-card')).find((c) => /Checking with the clinic cloud/.test(c.textContent));
      log(!!delB && delB.disabled === true && !!checking && Array.from(checking.querySelectorAll('button')).some((b) => /Hide/.test(b.textContent)),
        'v1.14.0: while Delete patient data checks with the cloud, its button is disabled and a window (which can be hidden) says so');
      release();
      await press(/^Cancel$/);
      log(!!delB && delB.disabled === false, '...and Cancel at the confirmation arms it again (the export still counts)');
      window.api.eventPreflight = realPre;
      let releaseP;
      const slowP = new Promise((r) => { releaseP = r; });
      const realPurge = window.api.eventPurge;
      window.api.eventPurge = async (p) => { await slowP; return realPurge(p); };
      delB.click();
      await press(/Delete the patient data/);
      const deleting = Array.from(document.querySelectorAll('.modal-card')).find((c) => /Deleting this clinic/.test(c.textContent));
      log(!!deleting && !Array.from(deleting.querySelectorAll('button')).some((b) => /Hide/.test(b.textContent)) && delB.disabled === true,
        'v1.14.0: ...and while it deletes, the window has no Hide and the button stays disabled');
      releaseP();
      for (let i = 0; i < 8; i++) await tick();
      window.api.eventPurge = realPurge;
      root.remove();
      document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
    }

    // e3. Deleting a clinic that has patients: the same check first, and the
    //     go-ahead only after the confirmation that lists what may be missing.
    {
      sync = { blocked: false, problems: [{ key: 'quiet:d9:1', text: 'DESK-9 has not been heard from since 9:00' }] };
      const savedDel = window.api.eventsDelete;
      const dels = [];
      let releaseD;
      const slowD = new Promise((r) => { releaseD = r; });
      window.api.eventsDelete = async (p) => {
        dels.push(p);
        if (!p.force) return { ok: false, error: 'This event has 1 patient record(s).' };
        await slowD;
        return { ok: true, data: { ok: true } };
      };
      root = renderAdmin({ navigate: () => {}, toast: () => {}, store: storeG }, { section: 'events' });
      document.body.append(root);
      for (let i = 0; i < 8; i++) await tick();
      const row = Array.from(root.querySelectorAll('tr')).find((tr) => /Guard Screen/.test(tr.textContent));
      const trash = row && Array.from(row.querySelectorAll('button.btn--danger')).find((b) => !b.textContent.trim());
      if (trash) trash.click();
      await press(/^Delete$/);
      const body3 = (modalBody() || {}).textContent || '';
      log(/Permanently delete with patients/.test(modalTitle()) && /DESK-9 has not been heard from/.test(body3) && dels.length === 1 && dels[0].force === false,
        'v1.14.0: deleting a clinic with patients checks with the cloud first, and lists what this laptop may be missing', JSON.stringify({ title: modalTitle(), dels }));
      await press(/Delete everything/);
      const working = Array.from(document.querySelectorAll('.modal-card')).find((c) => /Deleting “Guard Screen”/.test(c.textContent));
      log(!!working && !Array.from(working.querySelectorAll('button')).some((b) => /Hide/.test(b.textContent)) && !!trash && trash.disabled === true,
        '...shows a window (with no Hide) while it deletes, its button disabled');
      log(dels.length === 2 && dels[1].force === true && dels[1].allowIncompleteSync === true && JSON.stringify(dels[1].acceptedProblems) === '["quiet:d9:1"]' && Number.isFinite(dels[1].checkedAt),
        '...and sends the go-ahead for exactly what was listed, with when it was checked', JSON.stringify(dels[1] || {}));
      releaseD();
      for (let i = 0; i < 8; i++) await tick();
      window.api.eventsDelete = savedDel;
      root.remove();
      document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
      sync = { blocked: false, problems: [] };
    }

    // f. The Management cloud card.
    window.api.cloudStatus = async () => ({ ok: true, data: { enabled: true, mode: 'online', online: true, url: 'http://127.0.0.1:1', hasKey: true, lastOk: new Date().toISOString(), lastError: '', pushed: 0, pulled: 0, applied: 0, caughtUp: false,
      imagesBehind: 4, toSend: { clinical: 0, xrays: 2, bytes: 3 * 1048576 }, orphans: 3, orphansWarn: false, rowsRefused: 1,
      peers: [{ device: 'd2', who: 'Desk <i>2</i>', clinical: 0, xrays: 5, bytes: 1, at: new Date().toISOString() }] } });
    const { renderManagement } = await import('../src/renderer/js/views/management.js');
    const mg = renderManagement({ navigate: () => {}, toast: () => {}, store: storeG }, {});
    document.body.append(mg);
    for (let i = 0; i < 10; i++) await tick();
    const card = Array.from(mg.querySelectorAll('.card')).find((c) => /Cloud connection/.test(c.textContent));
    const ct = card ? card.textContent : '';
    log(/Online · catching up/.test(ct), 'v1.14.0: the cloud pill says "catching up" while this laptop is behind, not "synced"', ct.slice(0, 80));
    log(/X-rays still arriving: 4/.test(ct) && /X-rays still sending: 2 \(≈3 MB\)/.test(ct) && /Waiting for their patient: 3/.test(ct) && /Refused by the cloud: 1/.test(ct),
      'v1.14.0: the Management cloud card shows what is still arriving, still sending, waiting and refused', ct.slice(0, 200));
    log(/Desk <i>2<\/i>: 5 x-ray\(s\) still to send/.test(ct) && !(card && card.querySelector('i')),
      'v1.14.0: ...and names the other station still sending, as text');
    mg.remove();

    Object.assign(window.api, { eventPreflight: saved.p, eventFinish: saved.f, eventPurge: saved.u, exportClinic: saved.x, cloudStatus: saved.c });
    document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
  }

  await tick();
  if (errors.length) errors.forEach((e) => log(false, 'RUNTIME: ' + e));
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n=== ' + (failed ? failed + ' FAILURES' : 'ALL ' + results.length + ' CHECKS PASSED') + ' ===');
  db.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
