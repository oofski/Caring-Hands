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
db.init(tmp);

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
  if (vrange) { vrange.value = '3'; vrange.dispatchEvent(new window.Event('input', { bubbles: true })); }
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
  drawSig();
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
  pr = await window.api.patientsCreate({ first_name: 'Walkin', last_name: 'Patient', demographics: {}, medical_history: {}, dental_history: { reason: 'pain' }, consents: [] });
  log(pr.ok, 'DOCTOR can complete a check-in (the reported bug): ' + (pr.ok ? 'allowed' : pr.error));
  pr = await window.api.usersList();
  log(!pr.ok && /permission/i.test(pr.error || ''), 'permission guard works: doctor blocked from staff list');
  // triage role can also check in
  currentUser = db.login('admin', 'admin'); db.createUser(currentUser, { username: 'trix', full_name: 'Front', role: 'triage', password: 'x' });
  await window.api.authLogin({ username: 'trix', password: 'x' });
  pr = await window.api.patientsCreate({ first_name: 'Tri', last_name: 'Age', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
  log(pr.ok, 'TRIAGE can complete a check-in: ' + (pr.ok ? 'allowed' : pr.error));
  // v1.0.6 roles: EMT records vitals; CHECKOUT dismisses a signed-off patient.
  currentUser = db.login('admin', 'admin'); db.createUser(currentUser, { username: 'emtx', full_name: 'EMT One', role: 'emt', password: 'x' });
  db.createUser(currentUser, { username: 'cox', full_name: 'Checkout One', role: 'checkout', password: 'x' });
  const vp = db.createPatient(currentUser, { first_name: 'Vital', last_name: 'Test', demographics: {}, medical_history: {}, dental_history: {} });
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
  const hp = db.createPatient(db.login('admin', 'admin'), { first_name: 'Clean', last_name: 'Route', demographics: {}, medical_history: {}, dental_history: {} });
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
  const flowP = db.createPatient(currentUser, { first_name: 'Flow', last_name: 'Through', demographics: {}, medical_history: {}, dental_history: {}, route: 'dentist' });
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
  const lockP = db.createPatient(currentUser, { first_name: 'Lock', last_name: 'Opt', demographics: {}, medical_history: {}, dental_history: {}, route: 'dentist' });
  db.saveVitals(currentUser, lockP.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '66' });
  db.routePatient(currentUser, lockP.id, 'dentist');
  let lk = db.saveTreatment(currentUser, lockP.id, { provider_name: 'Dr B', provider_signature: 'data:,s' }, 'lock');
  let lockedThrew = false; try { db.saveTreatment(currentUser, lockP.id, { provider_name: 'Dr B' }, 'complete'); } catch (e) { lockedThrew = /locked/i.test(e.message); }
  log(lk.treatment.locked && lockedThrew, 'v1.2.1: optional lock still finalizes a read-only record when chosen');
  // guard: a patient still at check-in (not seen by EMT) cannot be dismissed
  currentUser = db.login('admin', 'admin');
  const rawP = db.createPatient(currentUser, { first_name: 'Not', last_name: 'Seen', demographics: {}, medical_history: {}, dental_history: {} });
  await window.api.authLogin({ username: 'cox', password: 'x' });
  pr = await window.api.patientsDismiss(rawP.id);
  log(!pr.ok && /EMT|nurse|vitals/i.test(pr.error || ''), 'v1.2.1: a checked-in (unseen) patient still cannot be dismissed: ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));

  // ---- REGISTRATION role: front-desk check-in only, into the queue ----
  currentUser = db.login('admin', 'admin');
  const reg = db.createUser(currentUser, { username: 'regx', full_name: 'Reg One', role: 'registration', password: 'x' });
  log(reg.role === 'registration', 'registration role can be created (CHECK widened, existing accounts intact)');
  await window.api.authLogin({ username: 'regx', password: 'x' });
  pr = await window.api.patientsCreate({ first_name: 'Front', last_name: 'Desk', demographics: {}, medical_history: {}, dental_history: { reason: 'checkup' }, consents: [] });
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
  const cp = db.createPatient(currentUser, { first_name: 'Clean', last_name: 'Only', demographics: {}, medical_history: {}, dental_history: {} });
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
    const hiP = db.createPatient(currentUser, { first_name: 'High', last_name: 'Pressure', demographics: {}, medical_history: {}, dental_history: { reason: 'x' }, route: 'dentist' });
    db.saveVitals(currentUser, hiP.id, { bp_systolic: '190', bp_diastolic: '105', heart_rate: '88' });
    db.routePatient(currentUser, hiP.id, 'dentist');
    const okP = db.createPatient(currentUser, { first_name: 'Normal', last_name: 'Pressure', demographics: {}, medical_history: {}, dental_history: { reason: 'x' }, route: 'dentist' });
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
    const cp = db.createPatient(currentUser, { first_name: 'Chair', last_name: 'Side', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    const afterAdd = db.addPatientConsent(currentUser, cp.id, { type: 'oral_surgery', signer_name: 'Chair Side', tooth_numbers: '18, 19', signature_png: 'data:,sig' });
    const os = (afterAdd.consents || []).find((c) => c.type === 'oral_surgery');
    log(!!os && os.tooth_numbers === '18, 19', 'v1.4.7: dentist can capture an oral-surgery consent chairside WITH tooth numbers');
    log(db.collectSyncRows(3000).rows.some((r) => r.entity === 'consent' && r.data && r.data.tooth_numbers === '18, 19'), 'v1.4.7: a chairside consent is a syncable row (reaches other laptops)');

    // BP re-checks: stored, capped at 2, preserved by a plain re-save.
    const bpp = db.createPatient(currentUser, { first_name: 'Re', last_name: 'Check', demographics: {}, medical_history: {}, dental_history: {} });
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

    // Provider consent panel + gate: patient with NO general consent cannot be documented.
    db.saveVitals(currentUser, cp.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    db.routePatient(currentUser, cp.id, 'dentist');
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
    const hp = db.createPatient(currentUser, { first_name: 'Pat', last_name: 'Hh', demographics: {}, medical_history: { conditions: ['pain_mgmt', 'weight_mgmt'] }, dental_history: {}, consents: [] });
    log((db.getPatient(hp.id).medical_history.conditions || []).includes('pain_mgmt') && (db.getPatient(hp.id).medical_history.conditions || []).includes('weight_mgmt'), 'health history: the two program selections save on the patient record');
  }

  // ---- v1.5.14: dashboard live CRM board + clickable KPIs; reports dashboard ----
  {
    currentUser = db.login('admin', 'admin');
    const store14 = (await import('../src/renderer/js/store.js')).store; store14.setUser(currentUser);
    let navTo = null;
    const ctx14 = { navigate: (v) => { navTo = v; }, toast: () => {}, store: store14, setDetail: () => {} };

    // Patients spread across the pipeline stages.
    const a = db.createPatient(currentUser, { first_name: 'Al', last_name: 'Aa', demographics: {}, medical_history: {}, dental_history: {}, consents: [] }); // checked in, no vitals
    const b = db.createPatient(currentUser, { first_name: 'Bo', last_name: 'Bb', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    db.saveVitals(currentUser, b.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' }); // vitals in, not routed
    const c = db.createPatient(currentUser, { first_name: 'Cy', last_name: 'Cc', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
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
    const bpat = db.createPatient(currentUser, { first_name: 'Bl', last_name: 'Eed', demographics: {}, medical_history: { conditions: ['bleeding'] }, dental_history: {}, consents: [] });
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
    const gp = db.createPatient(currentUser, { first_name: 'Gen', last_name: 'Der', gender: 'Mujer', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
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
    const src = db.createPatient(currentUser, { first_name: 'Rita', last_name: 'Returns', dob: '1980-05-05', gender: 'female', phone: '5551234567', email: 'rita@example.com', demographics: { address: '5 Elm St' }, medical_history: { conditions: ['diabetes'], allergies: ['penicillin'] }, dental_history: { reason: 'old reason', visit_type: 'extraction_pain', prior_dentist: 'Dr. Prior' }, consents: [] });
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
    const ep = db.createPatient(currentUser, { first_name: 'Ed', last_name: 'Mailer', email: 'ed@example.com', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
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
    const xp = db.createPatient(currentUser, { first_name: 'Ex', last_name: 'Ray', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
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
    const yp = db.createPatient(currentUser, { first_name: 'Ada', last_name: 'Xu', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
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
    const explicit = db.createPatient(currentUser, { first_name: 'Auto', last_name: 'Override', demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' }, route: 'dentist' });
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

  await tick();
  if (errors.length) errors.forEach((e) => log(false, 'RUNTIME: ' + e));
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n=== ' + (failed ? failed + ' FAILURES' : 'ALL ' + results.length + ' CHECKS PASSED') + ' ===');
  db.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
