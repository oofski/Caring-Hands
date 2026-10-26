// One simulated clinic laptop for the sync rig: a child process running a REAL
// copy of the app's data layer (db.js) and sync engine (cloud.js) on its own
// SQLite file, driven by the orchestrator over IPC.
//
// Which version of the app it runs is chosen by RIG_SRC — a directory holding
// db.js and cloud.js. By default that is this checkout's src/main; run.mjs
// extracts older versions from git so a mixed fleet can be tested.
//
// argv: name, dataDir, serverUrl, key

'use strict';
const path = require('path');
const crypto = require('crypto');

const [name, dataDir, url, key] = process.argv.slice(2);
// The app's built-in default cloud is the clinic's REAL server. A rig laptop
// must never be able to reach it: refuse anything that is not this machine.
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(url || ''))) {
  console.error(`[${name}] refusing to start: rig laptops only talk to 127.0.0.1 (got ${url})`);
  process.exit(2);
}

const SRC = process.env.RIG_SRC || path.resolve(__dirname, '../../src/main');
const db = require(path.join(SRC, 'db.js'));

// Tag every request with this laptop's name so the server can log and
// throttle per laptop. Also count what this laptop actually downloaded.
let downloaded = 0, uploaded = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const headers = Object.assign({}, init.headers || {}, { 'x-rig-laptop': name });
  if (init.body) uploaded += Buffer.byteLength(String(init.body));
  const res = await realFetch(input, Object.assign({}, init, { headers }));
  const len = Number(res.headers.get('content-length') || 0);
  downloaded += len;
  return res;
};

db.init(dataDir);
// Point at the rig BEFORE the sync engine is ever loaded or run.
db.setSyncMeta({ url, key, mode: 'online', cursor: '' });
const cloud = require(path.join(SRC, 'cloud.js'));
const admin = db.login('admin', 'admin');

const SIGNED = [{ type: 'general', signer_name: 'Rig Patient', signature_png: 'data:image/png;base64,' + Buffer.alloc(400, 7).toString('base64') }];
const byFirst = (first) => {
  const all = db.listPatients({ eventId: 'all' }).filter((p) => p.first_name === first);
  return all.length ? all[all.length - 1] : null;
};
const image = (bytes) => 'data:image/jpeg;base64,' + crypto.randomBytes(bytes).toString('base64');

const commands = {
  async idle() { return { ok: true }; },

  async sync() {
    const t0 = Date.now();
    const r = await cloud.syncOnce();
    const m = db.getSyncMeta();
    return { r, ms: Date.now() - t0, cursor: m.cursor, lastError: m.lastError, downloaded, uploaded, settings: lanes() };
  },

  async makeClinic({ name: evName }) {
    const ev = db.createEvent(admin, { name: evName || 'Rig Clinic' });
    db.setActiveEvent(admin, ev.id);
    return { id: ev.id };
  },

  async adoptClinic() {
    // Laptops that joined later take the clinic the others are running.
    const ev = db.getActiveEvent && db.getActiveEvent();
    if (ev) return { id: ev.id, name: ev.name };
    const list = db.listEvents();
    if (list.length) { db.setActiveEvent(admin, list[list.length - 1].id); return { id: list[list.length - 1].id }; }
    return { id: null };
  },

  // Patients checked in and through vitals, routed to the dentist.
  async createPatients({ prefix = 'P', n = 1, start = 0 }) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const first = `${prefix}${String(start + i).padStart(2, '0')}`;
      const p = db.createPatient(admin, {
        first_name: first, last_name: 'Rig', dob: '1980-01-01', demographics: { city: 'Sandy' }, medical_history: {},
        dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED,
      });
      db.saveVitals(admin, p.id, { bp_systolic: 120 + (i % 20), bp_diastolic: 78, heart_rate: 70 });
      db.routePatient(admin, p.id, 'dentist');
      out.push(first);
    }
    return { created: out.length };
  },

  async addXrays({ first, count = 1, bytes = 300 * 1024 }) {
    const names = Array.isArray(first) ? first : [first];
    let added = 0;
    for (let i = 0; i < count; i++) {
      const p = byFirst(names[i % names.length]);
      if (!p) throw new Error('no patient ' + names[i % names.length]);
      db.addXray(admin, p.id, { image_png: image(bytes), tooth: String((i % 32) + 1), note: 'rig' });
      added++;
    }
    return { added };
  },

  // An image saved by an OLDER app version: bigger than the cloud can store.
  // Arrives through the same path a restore or an old laptop's edit would.
  async addLegacyXray({ first, bytes = 1600 * 1024 }) {
    const p = byFirst(first);
    const bundle = db.exportClinicBundle(p.event_id);
    const pu = bundle.patients.find((x) => x.id === p.id).uid;
    db.applyRemoteRows([{ entity: 'xray', uid: crypto.randomUUID(), patient_uid: pu, deleted: 0,
      updated_at: '2026-01-01T00:00:00.000Z@legacy', event_uid: null,
      data: { station: null, image_png: image(bytes), note: 'legacy', tooth: '7', created_at: '2026-01-01T00:00:00.000Z' } }]);
    const x = db.listXrays(p.id).find((r) => r.note === 'legacy');
    db.updateXrayTooth(admin, x.id, '8'); // dirty, as an old laptop's edit would leave it
    return { id: x.id };
  },

  async complete({ first }) {
    const p = byFirst(first);
    db.saveTreatment(admin, p.id, { fillings: [{ tooth: '3', surfaces: ['O'] }], provider_name: 'Dr Rig' }, 'complete');
    return { ok: true };
  },

  async dismiss({ first }) {
    const p = byFirst(first);
    db.dismissPatient(admin, p.id);
    return { ok: true };
  },

  async status({ first }) {
    const p = byFirst(first);
    return { status: p ? p.status : null };
  },

  // Everything a laptop knows about a patient that matters for safety checks.
  async chart({ first }) {
    const p = byFirst(first);
    if (!p) return null;
    const full = db.getPatient(p.id);
    return {
      status: full.status,
      bp: full.triage ? full.triage.bp_systolic : null,
      xrays: db.listXrays(p.id).length,
      consents: (full.consents || []).length,
    };
  },

  // What this laptop holds, for convergence checks. Every child kind is
  // counted: a lost orphan shows up here as a shortfall in one of them.
  async counts() {
    const pts = db.listPatients({ eventId: 'all' });
    let xr = 0, triaged = 0, consents = 0, treatments = 0;
    for (const p of pts) {
      xr += db.listXrays(p.id).length;
      const full = db.getPatient(p.id);
      if (full.triage && full.triage.bp_systolic != null) triaged++;
      consents += (full.consents || []).length;
      if (full.treatment) treatments++;
    }
    return { patients: pts.length, xrays: xr, withVitals: triaged, consents, treatments, pending: (db.getSyncPending ? db.getSyncPending() : []).length };
  },

  async resetCursor() {
    if (db.resetSyncCursor) db.resetSyncCursor();
    else db.setSyncMeta({ cursor: '' });
    return { ok: true };
  },

  async meters() { return { downloaded, uploaded }; },
};

// Any setting whose name mentions a cursor, so lane cursors show up whatever
// they end up being called.
function lanes() {
  try {
    const m = db.getSyncMeta();
    const out = { cursor: m.cursor };
    for (const k of ['cloud_cursor_xray', 'cloud_lanes', 'cloud_server_caps']) {
      const v = db.getSetting ? db.getSetting(k) : undefined;
      if (v != null && v !== '') out[k] = v;
    }
    return out;
  } catch (_e) { return {}; }
}

process.on('message', async (m) => {
  try {
    const fn = commands[m.cmd];
    if (!fn) throw new Error('unknown command ' + m.cmd);
    const res = await fn(m.args || {});
    process.send({ id: m.id, res });
  } catch (e) {
    process.send({ id: m.id, err: e && e.message ? e.message : String(e) });
  }
});
process.send({ ready: true });
