// Parity test: the ONLINE pre-registration form vs the IN-PERSON check-in.
//
// The other two suites each test one side in isolation — cloud/test-worker.mjs
// imports only worker.js, scripts/ui-harness.mjs only src/. Nothing could see
// both, so every "parity" claim rested on a human-written string literal on one
// side happening to match the other. That is exactly how the Spanish
// oral-surgery consent came to be TWO DIFFERENT DOCUMENTS sharing one version
// string: the online copy was missing the post-operative and emergency
// paragraphs the desk had always shown, and no test could tell.
//
// This file imports both and compares them. Run: node cloud/test-parity.mjs
import { createRequire } from 'node:module';
import worker, { PARITY } from './worker.js';
const require = createRequire(import.meta.url);
import { CATALOG, VISIT_TYPES, CONDITIONS, ALLERGIES } from '../src/renderer/i18n/strings.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('PASS: ' + name); return; }
  console.log('FAIL: ' + name + (detail ? '\n      ' + detail : ''));
  failures++;
}

const W = PARITY();
const keysOf = (pairs) => pairs.map(([k]) => k);
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// 1. Option KEYS must match. A key that exists on one side and not the other
//    means an answer the other path can never record.
// ---------------------------------------------------------------------------
for (const lang of ['en', 'es']) {
  check(`[${lang}] visit types are the same set`,
    JSON.stringify(keysOf(W[lang].visits)) === JSON.stringify(VISIT_TYPES.map((v) => v.key)),
    `online=${keysOf(W[lang].visits)}\n      app=${VISIT_TYPES.map((v) => v.key)}`);

  check(`[${lang}] condition keys are the same set`,
    JSON.stringify(keysOf(W[lang].conditions)) === JSON.stringify(CONDITIONS.map((c) => c.key)),
    `online has ${W[lang].conditions.length}, app has ${CONDITIONS.length}`);

  // Compared against what the app OFFERS, not the whole catalog: an entry
  // marked intake:false (e.g. novocain, retired in v1.4.8) is kept only so old
  // records still render a label, and is correctly absent from both pickers.
  const offered = ALLERGIES.filter((a) => a.intake !== false).map((a) => a.key);
  check(`[${lang}] allergy keys are the same set`,
    JSON.stringify(keysOf(W[lang].allergies)) === JSON.stringify(offered),
    `online=${keysOf(W[lang].allergies)}\n      app offers=${offered}`);
}

// The history questions are what the dentist reads before treating. Both paths
// must ask the same ones, or a pre-registered patient arrives with a gap.
check('the medical history questions are the same set in both languages',
  JSON.stringify(keysOf(W.en.medYesNo)) === JSON.stringify(keysOf(W.es.medYesNo)));
check('the dental history questions are the same set in both languages',
  JSON.stringify(keysOf(W.en.dentalYesNo)) === JSON.stringify(keysOf(W.es.dentalYesNo)));

// ...and the app asks exactly those. The kiosk builds its questions from these
// i18n keys, so comparing the label text proves the same question is asked.
const APP_MED = ['underTreatment', 'hospitalized', 'tobacco', 'pregnancy'];
const APP_DENTAL = ['gumBleeding', 'sores', 'jawInjury', 'grinding', 'postExtraction', 'ortho'];
for (const lang of ['en', 'es']) {
  check(`[${lang}] the online form asks the same medical questions as the desk`,
    W[lang].medYesNo.map(([, l]) => norm(l)).join('|') === APP_MED.map((k) => norm(CATALOG[lang].intake[k])).join('|'),
    `online=${W[lang].medYesNo.map(([, l]) => l)}\n      app=${APP_MED.map((k) => CATALOG[lang].intake[k])}`);
  check(`[${lang}] the online form asks the same dental questions as the desk`,
    W[lang].dentalYesNo.map(([, l]) => norm(l)).join('|') === APP_DENTAL.map((k) => norm(CATALOG[lang].intake[k])).join('|'),
    `online=${W[lang].dentalYesNo.map(([, l]) => l)}\n      app=${APP_DENTAL.map((k) => CATALOG[lang].intake[k])}`);
}

// ---------------------------------------------------------------------------
// 2. The CONSENT the patient signs must be the same document, word for word.
//    This is the check that would have caught the Spanish surgery drift.
// ---------------------------------------------------------------------------
const appGeneral = (lang) => {
  const c = CATALOG[lang].consent;
  return (c.generalFull && c.generalFull.length ? c.generalFull : [c.oregon]).map(norm);
};
// The desk renders oralSurgeryFull when the language defines it, and otherwise
// falls back to intro + clauses + post-op + emergency (kiosk.js stepSurgeryConsent).
const appSurgery = (lang) => {
  const c = CATALOG[lang].consent;
  if (c.oralSurgeryFull && c.oralSurgeryFull.length) return c.oralSurgeryFull.map(norm);
  // postOpTitle is rendered as a heading on the consent screen, so it is part of
  // what the patient reads and belongs in the comparison.
  return [c.surgeryIntro, ...(c.surgeryClauses || []), c.postOpTitle, c.postOp, c.emergency].filter(Boolean).map(norm);
};

for (const lang of ['en', 'es']) {
  const online = W[lang].generalConsent.map(norm);
  const desk = appGeneral(lang);
  check(`[${lang}] the GENERAL consent is the same document online and at the desk`,
    JSON.stringify(online) === JSON.stringify(desk),
    `online ${online.length} para(s), desk ${desk.length} para(s)`
    + (online.length === desk.length
      ? '\n      first difference: ' + (online.find((p, i) => p !== desk[i]) || '').slice(0, 120)
      : ''));
}

for (const lang of ['en', 'es']) {
  const online = W[lang].oralSurgery.map(norm).join(' ');
  const desk = appSurgery(lang).map(norm).join(' ');
  // Compared as one body of text: the two surfaces legitimately split it into
  // different numbers of paragraphs, but the WORDS the patient agrees to must
  // be the same, and neither may carry a clause the other does not.
  check(`[${lang}] the ORAL SURGERY consent covers the same ground online and at the desk`,
    online === desk,
    online === desk ? '' : `online ${online.length} chars, desk ${desk.length} chars`
      + `\n      only online: ${desk.includes(online) ? '(none)' : 'yes'}`
      + `\n      only at desk: ${online.includes(desk) ? '(none)' : 'yes'}`);
}

// ---------------------------------------------------------------------------
// 3. Behavioural parity: a submission missing a field the DESK requires must be
//    refused ONLINE too. Driven through the real worker against a fake D1.
// ---------------------------------------------------------------------------
function fakeD1() {
  const store = new Map();
  store.set('evt-p', { uid: 'evt-p', entity: 'event', deleted: 0, data: JSON.stringify({ name: 'Parity Clinic', active: 1 }) });
  let seq = 0;
  return {
    prepare(sql) {
      return {
        _b: [],
        bind(...a) { this._b = a; return this; },
        async first() {
          if (/entity = 'event'/.test(sql)) { const r = store.get(this._b[0]); return r ? { data: r.data, deleted: 0 } : null; }
          if (/RETURNING v/.test(sql)) { seq += 1; return { v: seq }; }
          return null;
        },
        async run() { return { success: true }; },
        async all() { return { results: [] }; },
      };
    },
  };
}
const env = { CLINIC_KEY: 'k', DB: fakeD1() };
// A real PNG with an actual stroke in it, built here so the test has no fixture
// file to drift from. The server decodes the payload and checks the magic bytes.
const SIG = (() => {
  const zlib = require('node:zlib');
  const tbl = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c >>> 0; }
  const crc = (b) => { let r = 0xFFFFFFFF; for (const x of b) r = tbl[(r ^ x) & 0xFF] ^ (r >>> 8); return (r ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const W = 600, H = 150;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    const off = y * (W * 4 + 1);
    for (let x = 0; x < W; x++) {
      if (Math.abs(y - 75 - 40 * Math.sin(x / 18)) < 3) {
        const i = off + 1 + x * 4; raw[i] = 31; raw[i + 1] = 58; raw[i + 2] = 77; raw[i + 3] = 255;
      }
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
})();

async function post(patch) {
  const body = {
    first_name: 'Par', last_name: 'Ity', dob: '1990-01-01', gender: 'female',
    phone: '5035550100', city: 'Sandy', state: 'OR',
    emergency_name: 'Kin', emergency_phone: '5035550199',
    visit_type: 'cleaning', allergies: ['none'], conditions: ['none'], medications_none: true,
    under_treatment: 'no', hospitalized: 'no', tobacco: 'no', pregnancy: 'no',
    gum_bleeding: 'no', sores: 'no', jaw_injury: 'no', grinding: 'no',
    post_extraction_bleeding: 'no', ortho: 'no',
    consent_agree: true, signer_name: 'Par Ity', signature_png: SIG,
    ...patch,
  };
  const res = await worker.fetch(new Request('https://x/checkin/evt-p', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env, {});
  let data = null;
  try { data = await res.json(); } catch (_e) { /* non-JSON */ }
  return { status: res.status, data };
}

// Each row is a field the FRONT DESK refuses to advance without. Online must
// refuse it too, or the same patient is held to two different standards.
const DESK_REQUIRES = [
  ['first name', { first_name: '' }],
  ['last name', { last_name: '' }],
  ['date of birth', { dob: '' }],
  ['gender', { gender: '' }],
  ['phone', { phone: '' }],
  ['city', { city: '' }],
  ['state', { state: '' }],
  ['emergency contact name', { emergency_name: '' }],
  ['emergency contact phone', { emergency_phone: '' }],
  ['what they need today', { visit_type: '' }],
  ['the allergies question', { allergies: [] }],
  ['the conditions question', { conditions: [] }],
  ['the medications question', { medications_none: false, medications: [] }],
  ['a medical history answer', { tobacco: '' }],
  ['a dental history answer', { grinding: '' }],
  ['agreeing to the consent', { consent_agree: false }],
  ['a name on the signature', { signer_name: '' }],
  ['THE SIGNATURE ITSELF', { signature_png: '' }],
];

const ok = await post({});
check('a complete submission is accepted online', ok.status === 200 && ok.data && ok.data.ok === true,
  ok.status !== 200 ? `got ${ok.status}: ${ok.data && ok.data.error}` : '');

for (const [label, patch] of DESK_REQUIRES) {
  const r = await post(patch);
  check(`online refuses a submission missing ${label}`, r.status === 400,
    r.status !== 400 ? `expected 400, got ${r.status}` : '');
}

// The signature is the one the clinician relies on. A payload that merely LOOKS
// like an image must not pass — that was live until v1.7.0.
for (const [label, value] of [
  ['a placeholder that is not an image', 'data:image/png;base64,AAAA'],
  ['a bare string', 'signed'],
  ['an empty value', ''],
  ['a 1x1 pixel', 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex').toString('base64')],
]) {
  const r = await post({ signature_png: value });
  check(`online refuses ${label} as a signature`, r.status === 400);
}

// An extraction needs the surgery consent signed too — same rule as the desk.
const exNoSig = await post({ visit_type: 'extraction_pain', surgery_agree: true });
check('online refuses an extraction with the surgery consent unsigned', exNoSig.status === 400);
const exSigned = await post({ visit_type: 'extraction_pain', surgery_agree: true, surgery_signature_png: SIG });
check('online accepts an extraction once the surgery consent is signed', exSigned.status === 200);

// A minor cannot consent for themselves — the desk says so, so must the form.
const thisYear = new Date().getFullYear();
const minorNoRel = await post({ dob: `${thisYear - 10}-01-01` });
check('online refuses a minor with nobody named as signing', minorNoRel.status === 400);
const minorWithRel = await post({ dob: `${thisYear - 10}-01-01`, relationship: 'Mother' });
check('online accepts a minor once a parent or guardian is named', minorWithRel.status === 200);

console.log('');
if (failures) { console.log(failures + ' parity check(s) FAILED'); process.exit(1); }
console.log('All parity checks passed');
