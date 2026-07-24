// Caring Hands — Cloud Sync Worker (v1.1.0)
// =============================================================================
// NO INSTALLS NEEDED. To deploy: create a Worker in the Cloudflare dashboard,
// paste THIS ENTIRE FILE into its code editor, then:
//   1. bind a D1 database with the variable name  DB   (Settings -> Bindings)
//   2. add a Secret named  CLINIC_KEY  = your shared clinic password
//   3. click Deploy.
// The database table is created automatically on first use (see ensureSchema),
// so there is no migration/CLI step. Full walkthrough: docs/CLOUD_SETUP.md.
// =============================================================================
// Cloudflare Worker + D1, implementing the shared "queue brain" sync API.
// Offline-first: the Electron app pushes locally-changed rows and pulls deltas.
// Dependency-free: pure Worker + D1 SQL via env.DB.
//
// See ./SYNC_CONTRACT.md for the exact API + schema this implements.

const SERVICE = 'caring-hands-sync';
const VERSION = '1.2.0';
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type',
};

// Self-initializing schema — so setup needs ZERO command-line tools. The Worker
// creates its own table on first use; the admin just pastes this file into the
// Cloudflare dashboard, binds a D1 database as "DB", sets CLINIC_KEY, and deploys.
const SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS sync_rows (' +
    'uid TEXT PRIMARY KEY, entity TEXT NOT NULL, event_uid TEXT, patient_uid TEXT, ' +
    'deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_sync_updated ON sync_rows(updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_event ON sync_rows(event_uid, updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_entity ON sync_rows(entity)',
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady || !env || !env.DB) return;
  for (const sql of SCHEMA_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  schemaReady = true;
}

export default {
  async fetch(request, env, ctx) {
    // CORS preflight — the Electron app calls from a file:// origin.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Friendly landing at the root so visiting the bare URL isn't alarming.
      // (The app never calls this — it uses /health and /v1/*.)
      if (path === '/' || path === '') {
        return json({
          ok: true,
          service: SERVICE,
          version: VERSION,
          message: 'Caring Hands sync server is running. There is no web page here — connect from the app under Admin -> Cloud. Health check: /health',
        });
      }

      // Health check — no auth (used by the app's "Test connection").
      if (path === '/health') {
        if (request.method !== 'GET') return methodNotAllowed();
        return json({
          ok: true,
          service: SERVICE,
          version: VERSION,
          time: nowIso(),
        });
      }

      // Public patient PRE-REGISTRATION form (no clinic key — patients don't
      // have one). GET serves a form for a specific event; POST files it as a
      // checked-in patient row scoped to that event, which the clinic's app
      // pulls in on its next sync. The event_uid in the path is a random,
      // unguessable id, and we only accept submissions for events that exist.
      if (path === '/checkin' || path.startsWith('/checkin/')) {
        await ensureSchema(env);
        const eventUid = decodeURIComponent((path.replace(/^\/checkin\/?/, '').split('/')[0] || '').trim());
        if (request.method === 'GET') return await handleCheckinGet(eventUid, env);
        if (request.method === 'POST') return await handleCheckinPost(eventUid, request, env);
        return methodNotAllowed();
      }

      // Everything under /v1/* requires a valid Bearer clinic key.
      if (path === '/v1/' || path.startsWith('/v1/')) {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }

        // Create the table on first authorized call — no CLI migration needed.
        await ensureSchema(env);

        if (path === '/v1/push') {
          if (request.method !== 'POST') return methodNotAllowed();
          return await handlePush(request, env);
        }

        if (path === '/v1/pull') {
          if (request.method !== 'GET') return methodNotAllowed();
          return await handlePull(url, env);
        }

        return json({ ok: false, error: 'not found' }, 404);
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: errMessage(err) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePush(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_e) {
    return json({ ok: false, error: 'invalid json body' }, 400);
  }

  const rows = body && Array.isArray(body.rows) ? body.rows : [];
  let applied = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!isValidRow(row)) {
      skipped++;
      continue;
    }

    // Last-Write-Wins: read the stored updated_at first, and only overwrite
    // only when the incoming updated_at is STRICTLY newer than the stored one.
    // updated_at is a globally-unique, totally-ordered stamp (monotonic ISO time
    // + device id), so this tie-break ("skip on <=") is identical to the client's
    // apply rule ("apply only when env > local") — server and client can never
    // diverge on an equal-timestamp tie.
    const existing = await env.DB
      .prepare('SELECT updated_at FROM sync_rows WHERE uid = ?')
      .bind(row.uid)
      .first();

    if (existing && String(row.updated_at) <= String(existing.updated_at)) {
      skipped++;
      continue;
    }

    const dataStr =
      typeof row.data === 'string' ? row.data : JSON.stringify(row.data);

    await env.DB
      .prepare(
        'INSERT OR REPLACE INTO sync_rows ' +
          '(uid, entity, event_uid, patient_uid, deleted, updated_at, data) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        row.uid,
        row.entity,
        row.event_uid != null ? row.event_uid : null,
        row.patient_uid != null ? row.patient_uid : null,
        row.deleted ? 1 : 0,
        row.updated_at,
        dataStr
      )
      .run();

    applied++;
  }

  return json({ ok: true, applied, skipped, time: nowIso() });
}

async function handlePull(url, env) {
  const since = url.searchParams.get('since') || '';
  const eventUid = url.searchParams.get('event_uid');
  const limit = clampLimit(url.searchParams.get('limit'));

  const columns =
    'uid, entity, event_uid, patient_uid, deleted, updated_at, data';

  let stmt;
  if (eventUid) {
    stmt = env.DB
      .prepare(
        'SELECT ' +
          columns +
          ' FROM sync_rows WHERE updated_at > ? AND event_uid = ?' +
          ' ORDER BY updated_at ASC LIMIT ?'
      )
      .bind(since, eventUid, limit);
  } else {
    stmt = env.DB
      .prepare(
        'SELECT ' +
          columns +
          ' FROM sync_rows WHERE updated_at > ?' +
          ' ORDER BY updated_at ASC LIMIT ?'
      )
      .bind(since, limit);
  }

  const result = await stmt.all();
  const dbRows = result && Array.isArray(result.results) ? result.results : [];

  const rows = dbRows.map((r) => ({
    entity: r.entity,
    uid: r.uid,
    event_uid: r.event_uid != null ? r.event_uid : null,
    patient_uid: r.patient_uid != null ? r.patient_uid : null,
    deleted: r.deleted ? 1 : 0,
    updated_at: r.updated_at,
    data: parseData(r.data),
  }));

  const cursor = rows.length ? rows[rows.length - 1].updated_at : since;
  const more = rows.length === limit;

  return json({ ok: true, rows, cursor, more });
}

// ---------------------------------------------------------------------------
// Patient pre-registration (public)
// ---------------------------------------------------------------------------

// Look up an event by its sync uid. Returns { name } or null. Events are stored
// as ordinary sync rows (entity='event'); the app pushes them up on sync.
async function getEventRow(env, uid) {
  if (!uid) return null;
  try {
    const row = await env.DB
      .prepare("SELECT data FROM sync_rows WHERE uid = ? AND entity = 'event' AND deleted = 0")
      .bind(uid)
      .first();
    if (!row) return null;
    const data = parseData(row.data) || {};
    return { name: typeof data.name === 'string' && data.name ? data.name : 'the clinic' };
  } catch (_e) {
    return null;
  }
}

async function handleCheckinGet(eventUid, env) {
  const ev = await getEventRow(env, eventUid);
  if (!ev) return htmlResponse(checkinErrorPage(), 404);
  return htmlResponse(checkinFormPage(eventUid, ev.name));
}

async function handleCheckinPost(eventUid, request, env) {
  const ev = await getEventRow(env, eventUid);
  if (!ev) return json({ ok: false, error: 'This pre-registration link is not valid.' }, 404);

  let body;
  try { body = await request.json(); } catch (_e) { return json({ ok: false, error: 'Invalid submission.' }, 400); }

  const clean = buildPreregPatient(body);
  if (!clean) return json({ ok: false, error: 'Please enter your first and last name.' }, 400);

  const iso = nowIso();
  const patientData = {
    language: clean.language,
    first_name: clean.first_name,
    last_name: clean.last_name,
    dob: clean.dob || null,
    gender: clean.gender || null,
    phone: clean.phone || null,
    email: clean.email || null,
    // demographics / *_history travel as JSON STRINGS (the patients table stores
    // them as TEXT), matching how the app itself pushes patient rows.
    demographics: JSON.stringify({ preregistered: true, prereg_at: iso }),
    medical_history: JSON.stringify(clean.medical_history),
    dental_history: JSON.stringify(clean.dental_history),
    status: 'checked_in',
    created_at: iso,
    dismissed_at: null,
    dismissed_by_name: null,
  };

  const uid = crypto.randomUUID();
  await env.DB
    .prepare(
      'INSERT OR REPLACE INTO sync_rows ' +
        '(uid, entity, event_uid, patient_uid, deleted, updated_at, data) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(uid, 'patient', eventUid, null, 0, iso + '@prereg', JSON.stringify(patientData))
    .run();

  return json({ ok: true });
}

// Sanitize + shape a submission into the patient structure the app understands.
// Everything is length-capped; unknown fields are ignored. Returns null if the
// name is missing.
function buildPreregPatient(b) {
  b = b || {};
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 120);
  const first = s(b.first_name, 60);
  const last = s(b.last_name, 60);
  if (!first || !last) return null;
  const keys = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 60).map((x) => s(x, 40)) : []);
  const meds = Array.isArray(b.medications)
    ? b.medications.map((m) => s(m, 80)).filter(Boolean).slice(0, 30).map((name) => ({ name, dose: '', reason: '' }))
    : [];

  const allergies = keys(b.allergies);
  const conditions = keys(b.conditions);
  const medical_history = {
    allergies,
    allergies_other: allergies.includes('other') ? s(b.allergies_other, 200) : '',
    conditions,
    conditions_other: conditions.includes('other') ? s(b.conditions_other, 200) : '',
    medications: meds,
  };
  if (allergies.includes('none')) medical_history.allergies_none = true;
  if (conditions.includes('none')) medical_history.conditions_none = true;
  if (!meds.length && (b.medications_none === true || b.medications_none === 'on')) medical_history.medications_none = true;

  const dental_history = { reason: s(b.reason, 400) };
  const VISITS = ['extraction_pain', 'extraction_no_pain', 'filling', 'cleaning'];
  if (VISITS.includes(b.visit_type)) {
    dental_history.visit_type = b.visit_type;
    if (b.visit_type === 'extraction_pain' || b.visit_type === 'extraction_no_pain') dental_history.may_need_extraction = 'yes';
  }

  return {
    first_name: first,
    last_name: last,
    dob: s(b.dob, 20),
    gender: s(b.gender, 20),
    phone: s(b.phone, 20).replace(/\D/g, '').slice(0, 10),
    email: s(b.email, 120),
    language: b.language === 'es' ? 'es' : 'en',
    medical_history,
    dental_history,
  };
}

// The check-in questions offered on the public form. Keys MUST match the app's
// i18n keys (renderer/i18n/strings.js) so selections render natively in-app.
const FORM_ALLERGIES = [
  ['penicillin', 'Penicillin'], ['nsaids', 'NSAIDs (Ibuprofen, Aspirin)'], ['codeine', 'Codeine'],
  ['lidocaine', 'Lidocaine'], ['articaine', 'Articaine'], ['tylenol', 'Tylenol (Acetaminophen)'],
];
const FORM_CONDITIONS = [
  ['high_bp', 'High blood pressure'], ['heart_disease', 'Heart disease'], ['diabetes', 'Diabetes'],
  ['asthma', 'Asthma'], ['bleeding', 'Bleeding disorder / bleeds easily'], ['blood_thinners', 'Takes blood thinners'],
  ['pregnant', 'Currently pregnant'], ['epilepsy', 'Epilepsy / seizures'], ['thyroid', 'Thyroid problems'],
  ['latex', 'Latex allergy'], ['anesthesia_reaction', 'Reaction to anesthesia'], ['stroke', 'Stroke'],
];
const FORM_VISITS = [
  ['extraction_pain', 'Extraction — in pain'], ['extraction_no_pain', 'Extraction — not in pain'],
  ['filling', 'Filling'], ['cleaning', 'Dental cleaning'],
];

function htmlEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function htmlResponse(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...CORS_HEADERS },
  });
}
function checkinErrorPage() {
  return checkinShell('Link not found', '<h1>Pre-registration link not found</h1><p>This link is not valid or the clinic event has ended. Please check the link with your clinic.</p>');
}
function checkinShell(title, inner) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + htmlEscape(title) + ' · Caring Hands</title>' +
    '<style>' +
    ':root{--g:#2f8f66;--ink:#12303f;--mut:#5b6b74;--line:#e2e8ec;--bg:#f4f6f7}' +
    '*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}' +
    '.wrap{max-width:560px;margin:0 auto;padding:20px 16px 60px}' +
    '.hero{background:var(--g);color:#fff;border-radius:14px;padding:20px;margin-bottom:18px}' +
    '.hero .ey{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85}' +
    '.hero h1{margin:6px 0 2px;font-size:22px}.hero p{margin:0;opacity:.9;font-size:14px}' +
    '.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}' +
    'h2{font-size:15px;margin:0 0 12px}label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}' +
    'input[type=text],input[type=tel],input[type=email],input[type=date],select,textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:16px;background:#fff;color:var(--ink)}' +
    'textarea{min-height:64px;resize:vertical}.row{display:flex;gap:10px}.row>*{flex:1}' +
    '.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}' +
    '.chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:8px 12px;font-size:14px;cursor:pointer;background:#fff}' +
    '.chip input{width:auto;margin:0}.chip.on{border-color:var(--g);background:#eaf5ef;color:var(--g);font-weight:600}' +
    '.hint{font-size:12px;color:var(--mut);margin:2px 0 0}' +
    '.btn{width:100%;padding:14px;border:0;border-radius:12px;background:var(--g);color:#fff;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px}' +
    '.btn:disabled{opacity:.6}.req{color:#c0392b}' +
    '.med-row{display:flex;gap:8px;margin-top:8px}.med-row input{flex:1}.med-row button{border:1px solid var(--line);background:#fff;border-radius:10px;padding:0 12px;cursor:pointer}' +
    '.addbtn{border:1px dashed var(--line);background:#fff;border-radius:10px;padding:9px 12px;font-size:14px;cursor:pointer;margin-top:8px}' +
    '.ok{text-align:center;padding:30px 10px}.ok .big{font-size:44px}.err{color:#c0392b;font-size:14px;margin-top:8px}' +
    '</style></head><body><div class="wrap">' + inner + '</div></body></html>';
}
function checkinFormPage(eventUid, eventName) {
  const chip = (name, k, label) => '<label class="chip"><input type="checkbox" name="' + name + '" value="' + htmlEscape(k) + '">' + htmlEscape(label) + '</label>';
  const allergyChips = FORM_ALLERGIES.map(([k, l]) => chip('allergy', k, l)).join('') +
    chip('allergy', 'none', 'None of the above') + chip('allergy', 'other', 'Other (type below)');
  const condChips = FORM_CONDITIONS.map(([k, l]) => chip('condition', k, l)).join('') +
    chip('condition', 'none', 'None of the above') + chip('condition', 'other', 'Other (type below)');
  const visitOpts = FORM_VISITS.map(([k, l]) => '<label class="chip"><input type="radio" name="visit" value="' + htmlEscape(k) + '">' + htmlEscape(l) + '</label>').join('');

  const inner =
    '<div class="hero"><div class="ey">Caring Hands · Pre-registration</div>' +
    '<h1>' + htmlEscape(eventName) + '</h1>' +
    '<p>Fill this out ahead of time to save time at the clinic. Your answers go straight to the front desk.</p></div>' +
    '<form id="f">' +
    '<div class="card"><h2>About you</h2>' +
    '<div class="row"><div><label>First name <span class="req">*</span></label><input type="text" id="first_name" autocomplete="given-name"></div>' +
    '<div><label>Last name <span class="req">*</span></label><input type="text" id="last_name" autocomplete="family-name"></div></div>' +
    '<div class="row"><div><label>Date of birth</label><input type="date" id="dob"></div>' +
    '<div><label>Gender</label><select id="gender"><option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></div></div>' +
    '<div class="row"><div><label>Phone</label><input type="tel" id="phone" inputmode="numeric" autocomplete="tel"></div>' +
    '<div><label>Email</label><input type="email" id="email" autocomplete="email"></div></div>' +
    '<label>Preferred language</label><select id="language"><option value="en">English</option><option value="es">Español</option></select>' +
    '</div>' +

    '<div class="card"><h2>What do you need?</h2>' +
    '<div class="chips">' + visitOpts + '</div>' +
    '<label style="margin-top:12px">Reason for your visit</label><textarea id="reason" placeholder="Tell us what is bothering you"></textarea></div>' +

    '<div class="card"><h2>Medication allergies</h2><div class="chips" id="allergies">' + allergyChips + '</div>' +
    '<input type="text" id="allergies_other" placeholder="Other allergies" style="margin-top:8px"></div>' +

    '<div class="card"><h2>Do you have any of these conditions?</h2><div class="chips" id="conditions">' + condChips + '</div>' +
    '<input type="text" id="conditions_other" placeholder="Other conditions" style="margin-top:8px"></div>' +

    '<div class="card"><h2>Current medications</h2>' +
    '<div id="meds"></div><button type="button" class="addbtn" id="addmed">+ Add a medication</button>' +
    '<label class="chip" style="margin-top:10px"><input type="checkbox" id="medications_none">I take no medications</label></div>' +

    '<div class="err" id="err"></div>' +
    '<button class="btn" id="submit" type="submit">Submit pre-registration</button>' +
    '<p class="hint" style="text-align:center;margin-top:14px">Caring Hands Worldwide — free dental care. Your information is shared only with the clinic team.</p>' +
    '</form>' +

    '<script>' +
    "var f=document.getElementById('f');" +
    "function chipwire(id){document.querySelectorAll('#'+id+' .chip input').forEach(function(i){i.addEventListener('change',function(){i.closest('.chip').classList.toggle('on',i.checked);});});}" +
    "chipwire('allergies');chipwire('conditions');" +
    "document.querySelectorAll('.chips .chip input[type=radio]').forEach(function(i){i.addEventListener('change',function(){document.querySelectorAll('.chip input[name=visit]').forEach(function(r){r.closest('.chip').classList.toggle('on',r.checked);});});});" +
    "var meds=document.getElementById('meds');function addmed(){var d=document.createElement('div');d.className='med-row';d.innerHTML='<input type=\"text\" placeholder=\"Medication name\"><button type=\"button\">✕</button>';d.querySelector('button').onclick=function(){d.remove();};meds.appendChild(d);}" +
    "document.getElementById('addmed').onclick=addmed;" +
    "function checked(name){return Array.prototype.slice.call(document.querySelectorAll('input[name='+name+']:checked')).map(function(i){return i.value;});}" +
    "f.addEventListener('submit',function(e){e.preventDefault();var err=document.getElementById('err');err.textContent='';" +
    "var fn=document.getElementById('first_name').value.trim(),ln=document.getElementById('last_name').value.trim();" +
    "if(!fn||!ln){err.textContent='Please enter your first and last name.';return;}" +
    "var payload={first_name:fn,last_name:ln,dob:document.getElementById('dob').value,gender:document.getElementById('gender').value,phone:document.getElementById('phone').value,email:document.getElementById('email').value,language:document.getElementById('language').value,reason:document.getElementById('reason').value,visit_type:(document.querySelector('input[name=visit]:checked')||{}).value||'',allergies:checked('allergy'),allergies_other:document.getElementById('allergies_other').value,conditions:checked('condition'),conditions_other:document.getElementById('conditions_other').value,medications:Array.prototype.slice.call(meds.querySelectorAll('input')).map(function(i){return i.value.trim();}).filter(Boolean),medications_none:document.getElementById('medications_none').checked};" +
    "var b=document.getElementById('submit');b.disabled=true;b.textContent='Submitting…';" +
    "fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}).then(function(r){return r.json();}).then(function(j){if(j&&j.ok){document.querySelector('.wrap').innerHTML='<div class=\"hero\"><div class=\"ey\">Caring Hands</div><h1>Thank you, '+fn.replace(/[<>&]/g,'')+'!</h1></div><div class=\"card ok\"><div class=\"big\">✅</div><p>Your pre-registration is complete. Please bring a photo ID and arrive at the clinic — the front desk already has your information.</p></div>';window.scrollTo(0,0);}else{err.textContent=(j&&j.error)||'Something went wrong. Please try again.';b.disabled=false;b.textContent='Submit pre-registration';}}).catch(function(){err.textContent='Network error. Please try again.';b.disabled=false;b.textContent='Submit pre-registration';});});" +
    '</script>';
  return checkinShell('Pre-register · ' + eventName, inner);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// The clinic key. Uses the CLINIC_KEY secret when set; otherwise falls back to
// the built-in default so a clinic that just pastes this Worker in is online with
// zero setup (the Caring Hands app ships with the same default baked in).
const DEFAULT_CLINIC_KEY = 'randy';

function isAuthorized(request, env) {
  const expected = (env && typeof env.CLINIC_KEY === 'string' && env.CLINIC_KEY.length)
    ? env.CLINIC_KEY
    : DEFAULT_CLINIC_KEY;

  const provided = extractBearer(request);
  if (provided == null) return false;

  return constantTimeEqual(provided, expected);
}

function extractBearer(request) {
  const header =
    request.headers.get('Authorization') ||
    request.headers.get('authorization') ||
    '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// Constant-time string comparison: guard length, then accumulate XOR over the
// char codes so the compare time does not depend on where the first mismatch is.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aLen = a.length;
  const bLen = b.length;
  // Seed the accumulator with the length difference so unequal lengths never
  // pass, without early-returning (which would leak length via timing).
  let diff = aLen ^ bLen;
  const max = Math.max(aLen, bLen) || 1;
  for (let i = 0; i < max; i++) {
    const ca = i < aLen ? a.charCodeAt(i) : 0;
    const cb = i < bLen ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Validation & helpers
// ---------------------------------------------------------------------------

function isValidRow(row) {
  return (
    !!row &&
    typeof row === 'object' &&
    typeof row.uid === 'string' &&
    row.uid.length > 0 &&
    typeof row.entity === 'string' &&
    row.entity.length > 0 &&
    typeof row.updated_at === 'string' &&
    row.updated_at.length > 0 &&
    row.data != null
  );
}

function clampLimit(raw) {
  let limit = parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  return limit;
}

function parseData(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return value;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function errMessage(err) {
  if (err && err.message) return String(err.message);
  return String(err);
}

function methodNotAllowed() {
  return json({ ok: false, error: 'method not allowed' }, 405);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}
