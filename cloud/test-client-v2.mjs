#!/usr/bin/env node
// The v1.14 sync CLIENT (src/main/db.js + cloud.js), tested against the REAL
// worker over HTTP on real SQLite — the sync rig's server (scripts/syncrig) —
// with a stand-in "peer" laptop that pushes rows straight to the server.
//
//   node cloud/test-client-v2.mjs
//   CLIENT_SRC=scripts/syncrig/.versions/1f8c3c2 node cloud/test-client-v2.mjs
//
// The second form runs the same checks against v1.13's client, which must FAIL
// the ones this release fixes: that is how each check is known to test
// something. (Checks that need a v1.14 function report it missing.)
//
// Every laptop here talks only to 127.0.0.1. The app's built-in default cloud
// is the clinic's real server; the URL is set before the sync engine loads.

import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { startServer, KEY } from '../scripts/syncrig/server.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = process.env.CLIENT_SRC ? path.resolve(process.env.CLIENT_SRC) : path.join(REPO, 'src/main');
const CUR_WORKER = path.join(HERE, 'worker.js');
// The worker clinics run today (unchanged since v1.11.0).
const OLD_WORKER = (() => {
  const dir = path.join(REPO, 'scripts/syncrig/.versions/1f8c3c2');
  const f = path.join(dir, 'worker.js');
  if (!fs.existsSync(f)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, execFileSync('git', ['show', '1f8c3c2:cloud/worker.js'], { cwd: REPO })); }
  return f;
})();

const db = require(path.join(SRC, 'db.js'));
let cloud = null;
let admin = null;
let dataDir = null;
let raw = null; // a second connection to the laptop's database, for counting and for simulating damage

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
let passed = 0, failed = 0;
function check(ok, name, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const has = (fn) => typeof db[fn] === 'function';

// What this laptop downloads and uploads, measured on the wire.
const realFetch = globalThis.fetch;
const meter = { down: 0, up: 0 };
globalThis.fetch = async (input, init = {}) => {
  if (init.body) meter.up += Buffer.byteLength(String(init.body));
  const res = await realFetch(input, init);
  meter.down += Number(res.headers.get('content-length') || 0);
  return res;
};

// A cycle may still be running from a timer (applyConfig starts one). Wait for
// it: syncOnce answers {busy:true} straight away while one is in flight.
async function idle() { while (cloud && cloud.status().running) await sleep(25); }
async function freshLaptop(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('refusing a non-local URL: ' + url);
  if (cloud) { cloud.stop(); await idle(); }
  try { if (raw) raw.close(); } catch (_e) { /* closed */ }
  try { db.close(); } catch (_e) { /* first */ }
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chv2-'));
  db.init(dataDir);
  db.setSyncMeta({ url, key: KEY, mode: 'online', cursor: '' });
  if (!cloud) cloud = require(path.join(SRC, 'cloud.js'));
  cloud._resetTuning();
  if (cloud.rotateEchoToken) cloud.rotateEchoToken();
  admin = db.login('admin', 'admin');
  raw = new Database(path.join(dataDir, 'caring-hands.db'));
  return dataDir;
}
const n = (sql, ...a) => raw.prepare(sql).get(...a).n;
const statusOf = (first) => { const r = raw.prepare('SELECT status FROM patients WHERE first_name = ? ORDER BY id DESC').get(first); return r ? r.status : null; };

// ---- a stand-in peer laptop, pushing rows straight to the server ----------
let tick = 0;
const stamp = (who = 'peer') => new Date(Date.UTC(2026, 9, 1, 8, 0, 0) + (tick++) * 1000).toISOString() + '@' + who;
async function peer(server, rows, device = 'peer-laptop') {
  for (let i = 0; i < rows.length; i += 200) {
    const res = await realFetch(server.url + '/v1/push', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ device_id: device, rows: rows.slice(i, i + 200) }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error('peer push failed: ' + JSON.stringify(j).slice(0, 200));
  }
}
const eventRow = (uid, name = 'Peer Clinic') => ({ entity: 'event', uid, event_uid: null, patient_uid: null, deleted: 0, updated_at: stamp(),
  data: { name, location: 'Sandy', start_date: '2026-10-01', end_date: null, languages: '["en"]', active: 1, created_at: '2026-10-01T08:00:00.000Z', selected_at: stamp(), prereg_open: 1 } });
const patientRow = (ev, uid, first, status = 'waiting', at = stamp()) => ({ entity: 'patient', uid, event_uid: ev, patient_uid: null, deleted: 0, updated_at: at,
  data: { language: 'en', first_name: first, last_name: 'Peer', dob: '1980-01-01', gender: null, phone: null, email: null, demographics: '{}', medical_history: '{}', dental_history: '{}', status, created_at: '2026-10-01T08:00:00.000Z', dismissed_at: null, dismissed_by_name: null, arrived_at: null, arrived_by_name: null } });
const triageRow = (pu, bp = 120) => ({ entity: 'triage', uid: uuid(), event_uid: null, patient_uid: pu, deleted: 0, updated_at: stamp(),
  data: { complaint: 'Pain', status: 'waiting', bp_systolic: bp, bp_diastolic: 80, heart_rate: 70, flags: '{}', checklist: '{}', teeth: '[]', teeth_notes: '{}', emt_review: '{}', bp_rechecks: '[]', emt_signed_off: 0 } });
const xrayRow = (pu, bytes) => ({ entity: 'xray', uid: uuid(), event_uid: null, patient_uid: pu, deleted: 0, updated_at: stamp(),
  data: { station: null, image_png: 'data:image/jpeg;base64,' + crypto.randomBytes(bytes).toString('base64'), note: 'peer', created_at: '2026-10-01T09:00:00.000Z', tooth: '3' } });
function clinic(nPatients) {
  const ev = uuid();
  const pts = Array.from({ length: nPatients }, (_, i) => ({ uid: uuid(), first: 'Peer' + String(i).padStart(2, '0') }));
  const rows = [eventRow(ev)];
  for (const p of pts) rows.push(patientRow(ev, p.uid, p.first));
  for (const p of pts) rows.push(triageRow(p.uid));
  return { ev, pts, rows };
}
// One sync cycle of this test's own, never a {busy:true} no-op.
async function sync() { await idle(); return cloud.syncOnce(); }
async function syncUntil(pred, max = 30) {
  for (let i = 0; i < max; i++) { if (pred()) return i; await sync(); }
  return pred() ? max : -1;
}
const SIGNED = [{ type: 'general', signer_name: 'Test Patient', signature_png: 'data:image/png;base64,' + Buffer.alloc(300, 9).toString('base64') }];
function localPatient(first, extra = {}) {
  return db.createPatient(admin, { first_name: first, last_name: 'Local', demographics: {}, medical_history: {},
    dental_history: { reason: 'Pain', visit_type: 'filling' }, route: 'dentist', consents: SIGNED, ...extra });
}
function localClinic(name = 'Local Clinic') { const ev = db.createEvent(admin, { name }); db.setActiveEvent(admin, ev.id); return ev; }

// A forwarding proxy, so one address can be pointed at a different server —
// what a clinic sees when the database behind its address is replaced.
async function proxy(target) {
  const p = { target };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, p.target);
    const up = http.request(u, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch (_e) { /* gone */ } });
    req.pipe(up);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  p.url = `http://127.0.0.1:${srv.address().port}`;
  p.close = () => new Promise((r) => srv.close(r));
  return p;
}

console.log(`client under test: ${path.relative(REPO, SRC) || SRC}`);

// ===========================================================================
// 1. Lanes: a laptop far behind gets the check-out before the image backlog.
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  const c = clinic(40);
  await peer(server, c.rows);
  for (let i = 0; i < 120; i += 10) await peer(server, Array.from({ length: 10 }, (_, j) => xrayRow(c.pts[(i + j) % 5].uid, 150 * 1024)));
  // The check-out is the LAST thing the server received: behind all 120 images.
  await peer(server, [patientRow(c.ev, c.pts[39].uid, 'Peer39', 'dismissed')]);
  await freshLaptop(server.url);
  server.setOpts({ downBps: 10 * 125000, upBps: 5 * 125000 }); // 10 / 5 Mbit
  const t0 = Date.now();
  await sync();
  const ms = Date.now() - t0;
  const xr = n('SELECT COUNT(*) AS n FROM xrays');
  check(statusOf('Peer39') === 'dismissed', 'lanes: a laptop far behind sees the check-out in its first cycle, ahead of 120 x-rays', `${ms}ms, ${xr}/120 images here`);
  check(xr < 120, '...while the images are still on their way (they no longer hold it up)', `${xr}/120`);
  check(n("SELECT COUNT(*) AS n FROM triage WHERE bp_systolic IS NOT NULL") === 40, '...and every patient’s vitals came with it');
  server.clearLinks();
  await syncUntil(() => n('SELECT COUNT(*) AS n FROM xrays') === 120, 40);
  check(n('SELECT COUNT(*) AS n FROM xrays') === 120, '...then every image arrives', `${n('SELECT COUNT(*) AS n FROM xrays')}/120`);
  check((db.getSyncPending() || []).length === 0, '...and nothing is left waiting for a parent');
  await server.close();
}

// ===========================================================================
// 2. Rows waiting for their parent are never dropped, however many.
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  const ev = uuid();
  await peer(server, [eventRow(ev)]);
  // 5200 sets of vitals whose patients reach the server only later.
  const pts = Array.from({ length: 5200 }, (_, i) => ({ uid: uuid(), first: 'Late' + i }));
  await peer(server, pts.map((p) => triageRow(p.uid)));
  await freshLaptop(server.url);
  await syncUntil(() => false, 3);
  const parked = (db.getSyncPending() || []).length;
  check(parked === 5200, 'orphans: 5200 rows waiting for their patient are all kept (v1.13 kept 5000 and dropped the rest)', `${parked} kept`);
  await peer(server, pts.map((p) => patientRow(ev, p.uid, p.first)));
  await syncUntil(() => n('SELECT COUNT(*) AS n FROM triage') === 5200, 10);
  check(n('SELECT COUNT(*) AS n FROM triage') === 5200, '...and when the patients arrive, every one of them gets their vitals', `${n('SELECT COUNT(*) AS n FROM triage')}/5200`);
  await server.close();
}

// ===========================================================================
// 3. A reset during a sync wins over the sync.
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  const c = clinic(30);
  await peer(server, c.rows);
  await freshLaptop(server.url);
  server.DB.setLimits({ latencyMs: 150 });
  await idle();
  const running = cloud.syncOnce();
  await sleep(60);
  db.resetSyncCursor(); // what "Re-sync everything" does, while the cycle is mid-flight
  await running;
  server.DB.setLimits({ latencyMs: 0 });
  const cur = db.getSyncMeta().cursor;
  check(cur === '' && !db.getSetting('cloud_lanes'), 'reset: a sync already in flight cannot save its place back over "Re-sync everything"', `cursor after: ${JSON.stringify(cur)}`);
  await syncUntil(() => n('SELECT COUNT(*) AS n FROM patients WHERE last_name = ?', 'Peer') === 30, 6);
  check(n('SELECT COUNT(*) AS n FROM patients WHERE last_name = ?', 'Peer') === 30, '...and the next sync reads the whole clinic again');
  await server.close();
}

// ===========================================================================
// 4. Echo: a laptop does not download its own uploads back.
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  await freshLaptop(server.url);
  localClinic();
  const p = localPatient('Echo');
  await sync();
  const before = { ...meter };
  for (let i = 0; i < 12; i++) db.addXray(admin, p.id, { image_png: 'data:image/jpeg;base64,' + crypto.randomBytes(300 * 1024).toString('base64'), tooth: String(i + 1) });
  for (let i = 0; i < 5; i++) await sync();
  const up = meter.up - before.up, down = meter.down - before.down;
  check(up > 3e6 && down < up * 0.05, 'echo: the x-ray laptop does not download the images it just uploaded', `up ${(up / 1e6).toFixed(1)}MB, down ${(down / 1e6).toFixed(2)}MB`);
  // Another laptop (no origin of its own) gets the full images.
  const lanes = 'since_e=0&since_p=0&since_k=0&since_x=0';
  const other = await (await realFetch(`${server.url}/v1/pull?proto=2&since=9007199254740991&limit=1&${lanes}&rows=1000&max_bytes=8388608`, { headers: { authorization: 'Bearer ' + KEY } })).json();
  const imgs = (other.rows || []).filter((r) => r.entity === 'xray');
  check(imgs.length === 12 && imgs.every((r) => r.data && String(r.data.image_png || '').length > 300000), '...while any other laptop still gets every image in full', `${imgs.length} full`);

  // A stub is believed only if this laptop really has the row. Lose one image
  // locally (as a restore of an older file would), then re-read: it comes back.
  raw.prepare('DELETE FROM xrays WHERE id = (SELECT MAX(id) FROM xrays)').run();
  db.resetSyncCursor(); // NOT a token rotation: the server still sends stubs
  await syncUntil(() => n('SELECT COUNT(*) AS n FROM xrays') === 12, 6);
  check(n('SELECT COUNT(*) AS n FROM xrays') === 12, '...and a stub for an image this laptop no longer holds is refused and fetched in full', `${n('SELECT COUNT(*) AS n FROM xrays')}/12`);
  await server.close();
}

// ===========================================================================
// 5. Against the worker clinics run today: v1.13 behaviour, one probe.
// ===========================================================================
{
  const server = await startServer({ workerPath: OLD_WORKER });
  const c = clinic(20);
  await peer(server, c.rows);
  await peer(server, Array.from({ length: 15 }, (_, j) => xrayRow(c.pts[j % 3].uid, 100 * 1024)));
  await freshLaptop(server.url);
  localClinic('Mine');
  localPatient('OldWorker');
  for (let i = 0; i < 8; i++) await sync();
  const probes = server.log.filter((e) => e.path === '/v1/pull' && /(^|&)proto=2/.test(e.qs)).length;
  check(probes <= 1, 'old server: the new protocol is asked for at most once (then every ten minutes)', `${probes} probe(s) in 8 cycles`);
  check(n('SELECT COUNT(*) AS n FROM patients WHERE last_name = ?', 'Peer') === 20 && n('SELECT COUNT(*) AS n FROM xrays') === 15, '...and the whole clinic arrives the old way');
  check(!!server.serverPatient('OldWorker'), '...and this laptop’s patients reach it');
  check(!db.getSyncMeta().lastError, '...with no error showing', db.getSyncMeta().lastError);
  await server.close();
}

// ===========================================================================
// 6. A different database behind the same address.
// ===========================================================================
{
  const A = await startServer({ workerPath: CUR_WORKER });
  const B = await startServer({ workerPath: CUR_WORKER });
  const E = await startServer({ workerPath: CUR_WORKER });
  const px = await proxy(A.url);
  const a = clinic(5);
  await peer(A, a.rows);
  await freshLaptop(px.url);
  localClinic('Moving Clinic');
  for (let i = 0; i < 4; i++) localPatient('Mover' + i);
  for (let i = 0; i < 3; i++) await sync();
  check(!!A.serverPatient('Mover3'), '(setup) the laptop’s patients are on the first database');
  // B already holds more rows than this laptop has read from A, so only the
  // database's identity tells them apart.
  const b = clinic(150);
  await peer(B, b.rows);
  px.target = B.url;
  await syncUntil(() => !!B.serverPatient('Mover3') && n('SELECT COUNT(*) AS n FROM patients WHERE first_name = ?', 'Peer149') > 0, 10);
  check(!!B.serverPatient('Mover3'), 'new database: this laptop sends everything it holds to a database it has never synced with');
  check(n('SELECT COUNT(*) AS n FROM patients WHERE first_name = ?', 'Peer149') > 0, '...and reads that database from the start');
  // An empty database: this laptop's place is ahead of everything it holds.
  px.target = E.url;
  await syncUntil(() => !!E.serverPatient('Mover3'), 10);
  check(!!E.serverPatient('Mover3'), '...and the same for an empty one (this laptop’s place is past its end)');
  await px.close(); await A.close(); await B.close(); await E.close();
}

// ===========================================================================
// 7. Changing the server address in settings.
// ===========================================================================
{
  const A = await startServer({ workerPath: CUR_WORKER });
  const B = await startServer({ workerPath: CUR_WORKER });
  await freshLaptop(A.url);
  localClinic('Switching');
  localPatient('Switcher');
  await sync(); await sync();
  check(!!A.serverPatient('Switcher'), '(setup) on the old server');
  cloud.applyConfig({ url: B.url });
  cloud.stop();
  await idle();
  await syncUntil(() => !!B.serverPatient('Switcher'), 8);
  check(!!B.serverPatient('Switcher'), 'new address: what this laptop already sent to the old server is sent to the new one');
  await A.close(); await B.close();
}

// ===========================================================================
// 8. A row the cloud can never store is set aside, not re-sent for ever.
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  await freshLaptop(server.url);
  localClinic('Big Signature');
  const big = [{ type: 'general', signer_name: 'Huge', signature_png: 'data:image/png;base64,' + 'A'.repeat(2050000) }];
  localPatient('HugeSig', { consents: big });
  await sync();
  // Uploads carrying the 2MB signature (every other row here is tiny).
  const sends = () => server.log.filter((e) => e.path === '/v1/push' && e.reqBytes > 2e6).length;
  const after1 = sends();
  await sync(); await sync(); await sync();
  check(after1 >= 1 && sends() === after1, 'refused: a consent too big for the cloud is not sent again unchanged every cycle', `${after1} then ${sends()}`);
  check(!!server.serverPatient('HugeSig'), '...while the patient it belongs to does reach the cloud');
  localPatient('After');
  await sync();
  check(!!server.serverPatient('After'), '...and so does everything after it');
  raw.prepare("UPDATE consents SET signer_name = 'Huge Edited' WHERE signer_name = 'Huge'").run();
  await sync();
  check(sends() === after1 + 1, '...and it is tried again once it is edited', `${after1} then ${sends()}`);
  await server.close();
}

// ===========================================================================
// 9. Rows the server could not store this time stay waiting (free plan).
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  await freshLaptop(server.url);
  localClinic('Free Plan');
  await sync(); await sync(); // the server sets itself up on the first requests
  for (let i = 0; i < 60; i++) localPatient('Free' + i);
  server.DB.setLimits({ maxQueries: 40 });
  await sync();
  // Every row this laptop now counts as sent must really be on the server.
  const stored = new Set(server.DB._store.keys());
  const tables = ['patients', 'triage', 'consents'];
  const sentUids = [];
  const stillDirty = new Set(db.collectSyncRows(100000, { skip: ['xray'] }).rows.map((r) => r.uid));
  for (const t of tables) for (const r of raw.prepare(`SELECT uid FROM ${t} WHERE uid IS NOT NULL`).all()) if (!stillDirty.has(r.uid)) sentUids.push(r.uid);
  const lost = sentUids.filter((u) => !stored.has(u));
  check(sentUids.length > 0 && stillDirty.size > 0, '(setup) the first cycle stores some rows and not others', `${sentUids.length} sent, ${stillDirty.size} still to send`);
  check(lost.length === 0, 'free plan: nothing is marked sent that the server did not store', `${lost.length} marked sent but missing, of ${sentUids.length}`);
  await syncUntil(() => !!server.serverPatient('Free59') && db.collectSyncRows(100000).rows.length === 0, 30);
  check(db.collectSyncRows(100000).rows.length === 0 && !!server.serverPatient('Free59'), '...and the rest all get through on the following cycles');
  await server.close();
}

// ===========================================================================
// 10. A broken answer in the new protocol is not believed.
// ===========================================================================
{
  const asked = [];
  const bogus = uuid();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/v1/push') return send({ ok: true });
    if (u.pathname === '/v1/pull') {
      asked.push(u.searchParams.get('proto') === '2' ? 'v2' : 'legacy');
      if (u.searchParams.get('proto') === '2') {
        // A lane cursor past the server's own counter: impossible, so wrong.
        const lane = { cursor: '99', more: false, left: 0, left_exact: true };
        return send({ ok: true, proto: 2, mode: 'seq', head: '5', instance: 'bogus-db-0001', more: false, lanes: { e: lane, p: lane, k: lane, x: lane }, peers: [],
          rows: [{ lane: 'e', seq: 99, ...eventRow(bogus, 'Bogus Clinic') }] });
      }
      return send({ ok: true, rows: [], cursor: u.searchParams.get('since') || '0', more: false });
    }
    return send({ ok: true, seq: true });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await freshLaptop(`http://127.0.0.1:${srv.address().port}`);
  const r = await sync();
  check(n('SELECT COUNT(*) AS n FROM events WHERE uid = ?', bogus) === 0, 'sanity: rows from a page whose cursors make no sense are not applied');
  check(asked.join(',') === 'v2,legacy' && r.ok, '...and the laptop pulls the old way in the same cycle', asked.join(','));
  check(db.getSyncMeta().cursor === '0' || db.getSyncMeta().cursor === '', '...without saving the bad cursor', db.getSyncMeta().cursor);
  await sync(); await sync();
  check(asked.join(',') === 'v2,legacy,v2,legacy,v2,legacy', '...a bad answer or two is not enough to give up on the new protocol', asked.join(','));
  await sync(); await sync();
  check(asked.slice(6).join(',') === 'legacy,legacy', '...but after three in a row it stops asking for a while', asked.join(','));
  await new Promise((r2) => srv.close(r2));
}

// ===========================================================================
// 11. The one-time heal: rows an older server let a laptop step past.
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  const c = clinic(10);
  await peer(server, c.rows);
  await freshLaptop(server.url);
  await syncUntil(() => false, 2);
  // The state of a laptop that synced the old way, upgraded, and had once been
  // stepped past one patient's vitals by the old server's race.
  const head = Number(db.getSyncMeta().cursor || 0) || 50;
  raw.prepare('DELETE FROM triage WHERE patient_id = (SELECT id FROM patients WHERE first_name = ?)').run('Peer07');
  db.setSetting('cloud_lanes', ''); db.setSetting('cloud_lanes_heal', '');
  db.setSyncMeta({ cursor: String(head) });
  await sync();
  check(n('SELECT COUNT(*) AS n FROM triage t JOIN patients p ON p.id = t.patient_id WHERE p.first_name = ?', 'Peer07') === 1,
    'heal: on the first sync in lanes, clinical rows a laptop had been stepped past are read again', JSON.stringify({ head, lanes: db.getSetting('cloud_lanes'), err: db.getSyncMeta().lastError }));
  const lanesAfter = JSON.parse(db.getSetting('cloud_lanes') || '{}');
  check(Number(lanesAfter.x) >= head, '...without re-downloading the images', JSON.stringify(lanesAfter));
  await server.close();
}

// ===========================================================================
// 12. The lane cursors' bookkeeping (db.js only).
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  await freshLaptop(server.url);
  if (!has('getSyncLanes') || !has('commitPull')) {
    check(false, 'lanes bookkeeping: getSyncLanes / commitPull exist');
  } else {
    db.setSetting('cloud_lanes_heal', 'v1');
    db.setSyncMeta({ cursor: '50' });
    check(JSON.stringify(db.getSyncLanes()) === '{"e":50,"p":50,"k":50,"x":50}', 'lanes: an upgraded laptop starts every lane at its old cursor');
    const gen = db.syncGen();
    check(db.commitPull({ gen, lanes: { e: 60, p: 70, k: 80, x: 40 }, pending: [] }) === true, '(commit)');
    check(db.getSyncMeta().cursor === '40', 'lanes: the old single cursor is kept at the lowest lane, so a downgrade re-reads rather than skips');
    check(JSON.stringify(db.getSyncLanes()) === '{"e":60,"p":70,"k":80,"x":40}', 'lanes: ...and the lanes are read back as saved');
    db.setSyncMeta({ cursor: '75' }); // an older version pulled the old way, up to 75
    check(JSON.stringify(db.getSyncLanes()) === '{"e":75,"p":75,"k":80,"x":75}', 'lanes: an old-style pull past them lifts every lane to it');
    db.setSyncMeta({ cursor: '10' }); // an older version reset
    check(JSON.stringify(db.getSyncLanes()) === '{"e":10,"p":10,"k":10,"x":10}', 'lanes: an old-style reset below them brings every lane back');
    db.setSyncMeta({ cursor: '2026-01-01T00:00:00.000Z@x' });
    check(db.getSyncLanes() === null, 'lanes: a timestamp cursor never seeds lanes');
    db.setSyncMeta({ cursor: '10' });
    check(db.commitPull({ gen: gen - 1, lanes: { e: 99, p: 99, k: 99, x: 99 }, pending: [{ x: 1 }] }) === false
      && db.getSyncMeta().cursor === '10' && (db.getSyncPending() || []).length === 0, 'lanes: a commit from before a reset saves nothing');
  }
  await server.close();
}

// ===========================================================================
// 13. The x-ray signature cache changes nothing but the time.
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  await freshLaptop(server.url);
  localClinic('Cache');
  const p = localPatient('Cached');
  for (let i = 0; i < 6; i++) db.addXray(admin, p.id, { image_png: 'data:image/jpeg;base64,' + crypto.randomBytes(40 * 1024).toString('base64'), tooth: String(i + 1) });
  db.markSynced(db.collectSyncRows(3, { only: ['xray'], tombstones: false }).mark); // half sent
  const shape = (r) => JSON.stringify({ rows: r.rows.map((x) => [x.uid, x.updated_at, x.data.tooth]), mark: r.mark.map((m) => [m.id, m.sig]) });
  const on1 = shape(db.collectSyncRows(400, { only: ['xray'], tombstones: false }));
  db.setSetting('cloud_xray_sigcache', 'off');
  const off = shape(db.collectSyncRows(400, { only: ['xray'], tombstones: false }));
  db.setSetting('cloud_xray_sigcache', '');
  const on2 = shape(db.collectSyncRows(400, { only: ['xray'], tombstones: false }));
  check(on1 === off && off === on2, 'x-ray cache: what is sent is identical with the cache on and off');
  const clean = db.listXrays(p.id)[0];
  db.markSynced(db.collectSyncRows(400, { only: ['xray'], tombstones: false }).mark);
  check(db.collectSyncRows(400, { only: ['xray'], tombstones: false }).rows.length === 0, '(all sent)');
  db.updateXrayTooth(admin, clean.id, '30');
  const again = db.collectSyncRows(400, { only: ['xray'], tombstones: false });
  check(again.rows.length === 1 && again.rows[0].data.tooth === '30', 'x-ray cache: an edit to an image already sent is noticed and sent');
  raw.prepare("UPDATE xrays SET note = 'raw edit' WHERE id = ?").run(clean.id); // any writer, not just the app's functions
  const again2 = db.collectSyncRows(400, { only: ['xray'], tombstones: false });
  check(again2.rows.length === 1 && again2.rows[0].data.note === 'raw edit', 'x-ray cache: ...whoever makes it');
  // Something rebuilt the table and dropped the triggers: every kept hash goes.
  if (n("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'xray_sig'")) {
    db.markSynced(again2.mark);
    check(db.collectSyncRows(400, { only: ['xray'], tombstones: false }).rows.length === 0, '(clean again)');
    for (const t of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_xray_sig%'").all()) raw.exec(`DROP TRIGGER "${t.name}"`);
    raw.prepare("UPDATE xrays SET note = 'unseen edit' WHERE id = ?").run(clean.id);
    db.close(); db.init(dataDir);
    const healed = db.collectSyncRows(400, { only: ['xray'], tombstones: false });
    check(healed.rows.some((r) => r.data.note === 'unseen edit'), 'x-ray cache: an edit made while its triggers were missing is still noticed after restart');
  } else check(false, 'x-ray cache: the cache table exists');
  await server.close();
}

// ===========================================================================
// 14. An export taken before other stations' rows arrived is not enough.
// ===========================================================================
{
  const server = await startServer({ workerPath: CUR_WORKER });
  await freshLaptop(server.url);
  const ev = localClinic('Export Watermark');
  const p = localPatient('Exported');
  await sync();
  db.recordClinicExport(ev.id, { patients: 1, xlsxPath: '/tmp/x.xlsx', backupPath: '/tmp/x.chbak.json' });
  check(db.finishPreflight(ev.id).needs_export === false, '(an export clears the way)');
  // Another station x-rays this patient after the export was taken.
  const pu = raw.prepare('SELECT uid FROM patients WHERE id = ?').get(p.id).uid;
  await peer(server, [xrayRow(pu, 20 * 1024)]);
  await sync();
  const pre = db.finishPreflight(ev.id);
  check(pre.needs_export === true && pre.arrivals_since_export === 1, 'export: an x-ray that arrived from another station after the export means exporting again', JSON.stringify({ needs: pre.needs_export, since: pre.arrivals_since_export }));
  let msg = '';
  try { db.finishEvent(admin, ev.id); } catch (e) { msg = e.message; }
  check(/again/.test(msg), '...and finishing is refused until then', msg.slice(0, 80));
  db.recordClinicExport(ev.id, { patients: 1, xlsxPath: '/tmp/y.xlsx', backupPath: '/tmp/y.chbak.json' });
  check(db.finishPreflight(ev.id).needs_export === false, '...which a fresh export clears');
  await server.close();
}

// ===========================================================================
// 15. The Finish / Delete guard, in the real ipc.js (Electron stood in for).
// ===========================================================================
if (SRC !== path.join(REPO, 'src/main')) {
  console.log('SKIP the Finish guard lives in ipc.js, which is only tested on this checkout (see the mutation run in the release notes)');
} else {
  const Module = require('module');
  const handlers = {};
  const fakeElectron = {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, dialog: {}, shell: {},
    BrowserWindow: { getAllWindows: () => [] },
    app: { getVersion: () => '1.14.0', getPath: () => os.tmpdir(), isPackaged: false, on() {}, whenReady: () => Promise.resolve() },
  };
  const origLoad = Module._load;
  Module._load = function (req) { return req === 'electron' ? fakeElectron : origLoad.apply(this, arguments); };
  // A server whose answers the test chooses: how far behind this laptop is,
  // and what the other stations still have to send.
  const answer = { more: false, xMore: false, xLeft: 0, peers: [] };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/v1/push') {
        const rows = (JSON.parse(body || '{}').rows || []);
        return send({ ok: true, proto: 2, applied: rows.length, skipped: 0, complete: true, max_rows: 400, results: rows.map(() => 'applied') });
      }
      if (u.pathname === '/v1/pull') {
        const lane = (more, left) => ({ cursor: '0', more, left, left_exact: true });
        return send({ ok: true, proto: 2, mode: 'seq', head: '10', instance: 'guard-db-0001', more: answer.more,
          lanes: { e: lane(false, 0), p: lane(false, 0), k: lane(false, 0), x: lane(answer.xMore, answer.xLeft) }, peers: answer.peers, rows: [] });
      }
      return send({ ok: true, seq: true });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  await freshLaptop(url);
  const ipc = require(path.join(SRC, 'ipc.js'));
  ipc.register(() => null);
  Module._load = origLoad;
  const call = (ch, payload) => handlers[ch](null, payload);
  await call('auth:login', { username: 'admin', password: 'admin' });
  const ev = localClinic('Guarded');
  localPatient('Guarded1');
  db.recordClinicExport(ev.id, { patients: 1, xlsxPath: '/tmp/g.xlsx', backupPath: '/tmp/g.chbak.json' });

  // a. Still downloading, and the cloud is reachable: no override.
  answer.more = true; answer.xMore = true; answer.xLeft = 7;
  await idle(); await sync();
  const pre = (await call('event:preflight', { eventId: ev.id })).data;
  check(pre.sync && pre.sync.blocked === true && pre.sync.imagesBehind === 7, 'guard: Finish knows this laptop is still receiving 7 x-rays', JSON.stringify(pre.sync || {}).slice(0, 120));
  let r = await call('event:finish', { eventId: ev.id });
  check(r.ok === false && /7 x-ray image\(s\).*still arriving/.test(r.error), 'guard: ...and refuses to finish while they arrive', r.error);
  r = await call('event:finish', { eventId: ev.id, allowIncompleteSync: true });
  check(r.ok === false && /still arriving/.test(r.error), '...even when asked to go ahead anyway — it only has to wait');
  r = await call('event:purge', { eventId: ev.id });
  check(r.ok === false && /still arriving/.test(r.error), '...and so does Delete this clinic’s patient data');

  // b. Rows waiting for their patient: refused unless confirmed.
  answer.more = false; answer.xMore = false; answer.xLeft = 0;
  await idle(); await sync();
  db.setSyncPending([{ entity: 'xray', uid: uuid(), patient_uid: uuid(), deleted: 0, updated_at: stamp(), data: {} }]);
  r = await call('event:finish', { eventId: ev.id });
  check(r.ok === false && /waiting for the patient/.test(r.error), 'guard: records waiting for their patient stop Finish', r.error);
  db.setSyncPending([]);

  // c. Another station still has x-rays to send.
  answer.peers = [{ device: 'desk-2', who: 'Front <desk>', clinical: 0, xrays: 3, bytes: 900000, at: new Date().toISOString() }];
  await idle(); await sync();
  const pre2 = (await call('event:preflight', { eventId: ev.id })).data;
  check((pre2.sync.problems || []).some((p) => /Front <desk> still has 3 x-ray/.test(p)), 'guard: Finish names the station still holding unsent x-rays', JSON.stringify(pre2.sync.problems));
  r = await call('event:finish', { eventId: ev.id });
  check(r.ok === false && /Front <desk>/.test(r.error), '...and refuses without confirmation');
  answer.peers = [];

  // d. The cloud cannot be reached.
  await new Promise((r2) => srv.close(r2));
  cloud._resetTuning(); // forget the last good contact, as a restart would
  r = await call('event:finish', { eventId: ev.id });
  check(r.ok === false && /has not reached the clinic cloud/.test(r.error), 'guard: a laptop that cannot reach the cloud must confirm before finishing', r.error);
  r = await call('event:finish', { eventId: ev.id, allowIncompleteSync: true });
  check(r.ok === true && r.data && r.data.removed === 1, '...and can, once confirmed', JSON.stringify(r).slice(0, 120));

  // e. Running offline by choice: this laptop is the whole clinic.
  const ev2 = localClinic('Offline Clinic');
  localPatient('Offline1');
  db.recordClinicExport(ev2.id, { patients: 1, xlsxPath: '/tmp/o.xlsx', backupPath: '/tmp/o.chbak.json' });
  db.setSyncMeta({ mode: 'offline' });
  r = await call('event:finish', { eventId: ev2.id });
  check(r.ok === true, 'guard: a clinic running offline by choice finishes without being asked about the cloud', r.error || '');
}

if (cloud) cloud.stop();
try { raw.close(); } catch (_e) { /* closed */ }
try { db.close(); } catch (_e) { /* closed */ }
console.log(`\n=== ${passed + failed} checks: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
