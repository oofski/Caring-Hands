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
  'eventsCreate': ['admin'], 'eventsUpdate': ['admin'], 'eventsSetActive': ['admin'], 'eventsSetState': ['admin'], 'eventsDelete': ['admin'],
  'patientsUpdate': ['admin', 'triage', 'doctor'], 'patientsGet': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patientsList': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'], 'patientsRecords': ['admin', 'doctor'],
  'patientsSearchAll': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'], 'patientsHistory': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patientsIncomplete': ['admin'], 'patientsCleanupIncomplete': ['admin'], 'patientsDelete': ['admin'],
  'patientsDismiss': ['admin', 'checkout'], 'patientsMove': ['admin'], 'patientsAudit': ['admin', 'doctor', 'checkout', 'hygienist'],
  'vitalsSave': ['admin', 'doctor', 'triage', 'emt'], 'patientsRoute': ['admin', 'doctor', 'triage', 'emt'], 'consentSetTeeth': ['admin', 'doctor'], 'consentAdd': ['admin', 'doctor'],
  'usbLoad': ['admin', 'doctor', 'triage', 'checkout'], 'usbUploadCheckout': ['admin', 'doctor', 'triage', 'checkout'], 'usbClear': ['admin', 'doctor', 'triage', 'checkout'],
  'triageSave': ['admin', 'doctor', 'triage'], 'treatmentSave': ['admin', 'doctor', 'hygienist'],
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
  triageSave: okWrap(({ patientId, data }) => db.saveTriage(currentUser, patientId, data), 'triageSave'),
  treatmentSave: okWrap(({ patientId, data, finalize }) => db.saveTreatment(currentUser, patientId, data, finalize), 'treatmentSave'),
  vitalsSave: okWrap(({ patientId, data }) => db.saveVitals(currentUser, patientId, data), 'vitalsSave'),
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
  onCloudChanged: () => () => {},
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
  const dob = $all('.kiosk-body input').find((i) => i.type === 'date'); if (dob) setInput(dob, '1985-04-12');
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

  await tick();
  if (errors.length) errors.forEach((e) => log(false, 'RUNTIME: ' + e));
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n=== ' + (failed ? failed + ' FAILURES' : 'ALL ' + results.length + ' CHECKS PASSED') + ' ===');
  db.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
