// Tests for the v1.14 sync engine in worker.js, on real SQLite (d1-sqlite.mjs).
//
// Each group targets one guarantee and is written so it can FAIL: the race test
// runs against the previous worker from git too, and must catch the bug there.
//
// Run: node cloud/test-sync-v2.mjs   (exits non-zero on any failed check)

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeD1 } from './d1-sqlite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX = '9007199254740991';
let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('PASS: ' + name); }
  else { failures++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

let instances = 0;
async function workerAt(file) { return (await import(pathToFileURL(file).href + '?i=' + (++instances))).default; }
const CURRENT = path.join(HERE, 'worker.js');
async function mkEnv(d1 = {}, workerFile = CURRENT, extraEnv = {}) {
  return { CLINIC_KEY: 'k', DB: makeD1(d1), __w: await workerAt(workerFile), ...extraEnv };
}
async function call(e, method, p, body) {
  if (e.DB.newRequest) e.DB.newRequest();
  const init = { method, headers: { authorization: 'Bearer k' } };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await e.__w.fetch(new Request('https://sync.test' + p, init), e, {});
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (_e) { /* not json */ }
  return { status: res.status, data, text };
}
const push = (e, rows, extra = {}) => call(e, 'POST', '/v1/push', { device_id: 'dev-a', rows, ...extra });
const pull = (e, since, limit = 400) => call(e, 'GET', `/v1/pull?since=${since}&limit=${limit}`);
function pull2(e, lanes, o = {}) {
  const qs = new URLSearchParams({ proto: '2', since: MAX, limit: '1', since_e: String(lanes.e), since_p: String(lanes.p), since_k: String(lanes.k), since_x: String(lanes.x),
    rows: String(o.rows || 1000), max_bytes: String(o.max_bytes || 4194304), origin: o.origin || '', echo_min: String(o.echo_min || 0), device: o.device || '', backlog: o.backlog ? JSON.stringify(o.backlog) : '' });
  return call(e, 'GET', '/v1/pull?' + qs.toString());
}

let clock = 0;
const stamp = (dev = 'dev') => new Date(Date.UTC(2026, 0, 1) + (++clock) * 1000).toISOString() + '@' + dev;
const R = (entity, uid, data, x = {}) => ({ entity, uid, event_uid: x.event_uid ?? null, patient_uid: x.patient_uid ?? null, deleted: x.deleted ? 1 : 0, updated_at: x.updated_at || stamp(x.dev), data, ...(x.undelete ? { undelete: true } : {}) });
const img = (kb) => 'data:image/jpeg;base64,' + 'A'.repeat(kb * 1024);

// What the server holds, straight from SQLite: uid -> {seq, updated_at, deleted, entity}.
const table = (e) => new Map(e.DB._sqlite.prepare('SELECT uid, seq, updated_at, deleted, entity, patient_uid, event_uid FROM sync_rows').all().map((r) => [r.uid, r]));
const head = (e) => { const r = e.DB._sqlite.prepare('SELECT v FROM sync_seq WHERE id = 1').get(); return r ? r.v : 0; };

// Drain v2 pulls to the end. Returns every response, and a reader view
// uid -> latest {updated_at, deleted} the way a client would hold it.
async function drain2(e, o = {}, start = { e: 0, p: 0, k: 0, x: 0 }, onPage) {
  const lanes = { ...start };
  const pages = [];
  const view = new Map();
  for (let i = 0; i < 2000; i++) {
    const r = await pull2(e, lanes, o);
    if (!r.data || r.data.proto !== 2) return { pages, view, lanes, error: r.text.slice(0, 200) };
    pages.push(r.data);
    for (const row of r.data.rows) {
      const cur = view.get(row.uid);
      if (!cur || String(row.updated_at) > String(cur.updated_at)) view.set(row.uid, { updated_at: row.updated_at, deleted: row.deleted, entity: row.entity, stub: !!row.own });
    }
    for (const L of ['e', 'p', 'k', 'x']) {
      const c = Number(r.data.lanes[L].cursor);
      if (c < lanes[L]) return { pages, view, lanes, error: `lane ${L} cursor went backwards` };
      lanes[L] = c;
    }
    if (onPage) await onPage(r.data, lanes);
    if (!r.data.more) break;
  }
  return { pages, view, lanes };
}
async function drainLegacy(e, since = '', limit = 400) {
  const pages = [];
  let cursor = since;
  for (let i = 0; i < 2000; i++) {
    const r = await pull(e, cursor, limit);
    pages.push({ ...r.data, bytes: r.text.length });
    cursor = r.data.cursor;
    if (!r.data.more) break;
  }
  return { pages, cursor };
}

// A small clinic, written so that many children have LOWER seqs than their
// (re-written) patient — the shape of a real day, where checking a patient out
// re-sends only the patient row.
async function clinic(e, { patients = 30, xrays = 2, kb = 40, pad = 0 } = {}) {
  const note = 'n'.repeat(pad);
  await push(e, [R('event', 'ev1', { name: 'Clinic' })]);
  const rows = [];
  for (let i = 0; i < patients; i++) rows.push(R('patient', 'p' + i, { first_name: 'P' + i, status: 'checked_in', note }, { event_uid: 'ev1' }));
  await push(e, rows);
  const kids = [];
  for (let i = 0; i < patients; i++) {
    kids.push(R('triage', 't' + i, { bp_systolic: 120 + i }, { patient_uid: 'p' + i }));
    kids.push(R('consent', 'c' + i, { type: 'general', signature_png: 'data:image/png;base64,' + 'S'.repeat(2000) }, { patient_uid: 'p' + i }));
  }
  await push(e, kids);
  for (let i = 0; i < patients; i++) for (let j = 0; j < xrays; j++) await push(e, [R('xray', `x${i}_${j}`, { image_png: img(kb), tooth: String(j + 1) }, { patient_uid: 'p' + i })]);
  // Check-outs: the patient row is re-written, so it now sits AFTER its children.
  // In REVERSE, so the earliest charts belong to the patients whose records are
  // now the very last in line — the order that actually tests "parents first".
  for (let i = patients - 1; i >= 0; i--) if (i % 2 === 0) await push(e, [R('patient', 'p' + i, { first_name: 'P' + i, status: 'dismissed', note }, { event_uid: 'ev1' })]);
  // And the clinic row is re-written last (the active clinic is re-stamped).
  await push(e, [R('event', 'ev1', { name: 'Clinic', selected_at: stamp() })]);
}

async function main() {
  // ------------------------------------------------------------------ 1
  {
    const e = await mkEnv();
    await clinic(e, { patients: 40, xrays: 3, kb: 300 });
    const all = [...table(e).values()].sort((a, b) => a.seq - b.seq);
    const { pages } = await drainLegacy(e, '', 400);
    const got = pages.flatMap((p) => p.rows.map((r) => r.uid));
    check('legacy pages: every row exactly once, in delivery order', JSON.stringify(got) === JSON.stringify(all.map((r) => r.uid)), `${got.length} vs ${all.length}`);
    check('legacy pages are byte-capped near 2MB (an older app can no longer ask for 400 images at once)', pages.every((p) => p.bytes <= 2097152 + 400 * 1024 + 4096) && pages.length > 1, pages.map((p) => p.bytes).join(','));
    check('legacy page shape is unchanged for older apps', pages.every((p) => p.ok === true && p.mode === 'seq' && typeof p.cursor === 'string' && !('proto' in p)) && pages[0].rows.every((r) => Object.keys(r).sort().join(',') === 'data,deleted,entity,event_uid,patient_uid,uid,updated_at'));
    const r0 = pages[0].rows.find((r) => r.entity === 'consent');
    check('legacy rows carry their data as objects, as before', r0 && typeof r0.data === 'object' && r0.data.type === 'general');
  }

  // ------------------------------------------------------------------ 2
  {
    const e = await mkEnv();
    // Enough patients, with enough on each record, that the patients alone span
    // several pages — otherwise "parents first" is never actually exercised.
    await clinic(e, { patients: 120, xrays: 1, kb: 60, pad: 1500 });
    const { pages, view, error } = await drain2(e, { max_bytes: 131072 });
    check('v2 drains without error', !error, error);
    const all = table(e);
    check('v2: every row on the server reaches the reader', [...all.keys()].every((u) => view.has(u)), `${view.size}/${all.size}`);
    // Parents first: a child is never delivered before its patient, a patient never before its clinic.
    const seenAt = new Map();
    pages.forEach((p, i) => p.rows.forEach((r) => { if (!seenAt.has(r.uid)) seenAt.set(r.uid, i); }));
    let orphans = 0;
    for (const [uid, i] of seenAt) {
      const row = all.get(uid);
      if (row.patient_uid && !(seenAt.get(row.patient_uid) <= i)) orphans++;
      if (row.entity === 'patient' && row.event_uid && !(seenAt.get(row.event_uid) <= i)) orphans++;
    }
    check('v2: no child arrives before its parent, even though children were written first', orphans === 0, `${orphans} orphan(s)`);
    const lanesOf = new Map();
    pages.forEach((p) => p.rows.forEach((r) => lanesOf.set(r.uid, r.lane)));
    const want = (row) => (row.deleted ? 'e' : ['event', 'staffdir'].includes(row.entity) ? 'e' : ['user', 'report', 'patient'].includes(row.entity) ? 'p' : row.entity === 'xray' ? 'x' : 'k');
    check('v2: every row is in exactly the lane its kind belongs to', [...all.values()].every((r) => lanesOf.get(r.uid) === want(r)));
    const biggest = 60 * 1024 + 4096;
    check('v2: pages respect the byte budget (plus at most one row, so a big one still moves)', pages.every((p) => p.bytes <= 131072 + biggest), pages.map((p) => p.bytes).join(','));
    check('v2: images come after every clinical row in a catch-up', (() => { const firstX = pages.findIndex((p) => p.rows.some((r) => r.lane === 'x')); const lastClin = pages.map((p, i) => (p.rows.some((r) => r.lane !== 'x') ? i : -1)).reduce((a, b) => Math.max(a, b), -1); return firstX >= lastClin; })());
  }

  // A check-out must never share a response with an image the link cannot
  // fetch in time: the client applies nothing from a page that fails, so the
  // check-out would wait behind the image for as long as images are pending.
  {
    const e = await mkEnv();
    const ev = 'ev-slow', pt = 'pt-slow';
    await push(e, [R('event', ev, { name: 'Slow link' })]);
    await push(e, [R('xray', 'xr-big', { image_png: img(1500) }, { patient_uid: pt })]);
    await push(e, [R('patient', pt, { first_name: 'Out', status: 'dismissed' }, { event_uid: ev }), R('triage', 'tr-slow', { bp_systolic: 120 }, { patient_uid: pt })]);
    const lanes = { e: 0, p: 0, k: 0, x: 0 };
    const first = (await pull2(e, lanes, { max_bytes: 65536 })).data;
    check('byte cap: on a 64 KB page the check-out comes without the 1.5 MB image', first && first.rows.some((r) => r.uid === pt) && !first.rows.some((r) => r.lane === 'x') && first.bytes < 65536,
      first ? `${first.bytes} bytes: ${first.rows.map((r) => r.lane + ':' + r.uid).join(' ')}` : 'no page');
    for (const L of ['e', 'p', 'k', 'x']) lanes[L] = Number(first.lanes[L].cursor);
    const second = (await pull2(e, lanes, { max_bytes: 65536 })).data;
    check('...and the image still moves on its own, the next page', second && second.rows.length === 1 && second.rows[0].uid === 'xr-big', second ? second.rows.map((r) => r.uid).join(' ') : 'no page');
  }

  // ------------------------------------------------------------------ 3
  // A row is re-written BETWEEN a page's plan and its fetch. Its lane must stop
  // at the gap, later lanes must wait, and nothing may be lost.
  {
    let lost = 0, trials = 0, breaks = 0;
    for (let t = 0; t < 25; t++) {
      const e = await mkEnv();
      await clinic(e, { patients: 12, xrays: 1, kb: 30 });
      const writer = { ...e, __w: await workerAt(CURRENT) };
      let fired = false;
      e.DB.setFaults({
        beforeBatch: async (sqls) => {
          if (fired || !sqls.some((s) => /CASE WHEN origin/.test(s))) return;
          fired = true;
          e.DB.setFaults({ beforeBatch: null });
          // Re-write a patient and a triage row the plan has probably taken.
          const pi = t % 12;
          await push(writer, [R('patient', 'p' + pi, { first_name: 'P' + pi, status: 'in_treatment', n: t }, { event_uid: 'ev1' }), R('triage', 't' + pi, { bp_systolic: 200 + t }, { patient_uid: 'p' + pi })]);
          e.DB.setFaults({ beforeBatch: null });
        },
      });
      const d = await drain2(e, { max_bytes: 65536 + (t % 5) * 20000 });
      trials++;
      if (d.pages.some((p) => Object.values(p.lanes).some((l) => l.more) && p.more)) breaks++;
      const all = table(e);
      for (const [uid, row] of all) { const v = d.view.get(uid); if (!v || v.updated_at !== row.updated_at) lost++; }
    }
    check(`v2: a row re-written mid-page is never lost (${trials} trials)`, lost === 0, `${lost} row(s) missing or stale`);
  }

  // ------------------------------------------------------------------ 4
  // The race the old worker had: a delivery number reserved, then the row
  // stored, as two separate calls. A reader landing in between steps past it.
  async function raceTrial(file) {
    const e = await mkEnv({ latencyMs: 1, jitterMs: 4 }, file);
    await push(e, [R('event', 'ev1', { name: 'C' })]);
    const seen = new Set();
    let cursor = '';
    let writing = true;
    const writers = [0, 1, 2].map(async (w) => {
      for (let i = 0; i < 12; i++) await push({ ...e, __w: e.__w }, [R('patient', `w${w}_${i}`, { n: i }, { event_uid: 'ev1', dev: 'w' + w })]);
    });
    const reader = (async () => {
      while (writing) {
        const r = await pull(e, cursor, 3);
        for (const row of (r.data && r.data.rows) || []) seen.add(row.uid);
        cursor = r.data ? r.data.cursor : cursor;
        await new Promise((res) => setImmediate(res));
      }
    })();
    await Promise.all(writers);
    writing = false;
    await reader;
    for (let i = 0; i < 50; i++) { const r = await pull(e, cursor, 400); for (const row of r.data.rows) seen.add(row.uid); cursor = r.data.cursor; if (!r.data.more) break; }
    let missing = 0;
    for (let w = 0; w < 3; w++) for (let i = 0; i < 12; i++) if (!seen.has(`w${w}_${i}`)) missing++;
    return missing;
  }
  {
    let missingNew = 0;
    for (let t = 0; t < 40; t++) missingNew += await raceTrial(CURRENT);
    check('atomic writes: a reader polling during concurrent pushes misses nothing (40 trials)', missingNew === 0, `${missingNew} row(s) never delivered`);
    let oldFile = null;
    try {
      const src = execFileSync('git', ['show', '1f8c3c2:cloud/worker.js'], { cwd: HERE, stdio: ['ignore', 'pipe', 'ignore'] });
      oldFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oldworker-')), 'worker.js');
      fs.writeFileSync(oldFile, src);
    } catch (_e) { oldFile = null; }
    if (oldFile) {
      let missingOld = 0;
      for (let t = 0; t < 40 && missingOld === 0; t++) missingOld += await raceTrial(oldFile);
      check('...and the same test DOES catch the race on the v1.11 worker (so it is a real test)', missingOld > 0, `${missingOld} lost on v1.11`);
    } else console.log('SKIP: v1.11 worker not available from git');
  }

  // ------------------------------------------------------------------ 5
  {
    const e = await mkEnv();
    await push(e, [R('event', 'ev1', { name: 'C' })]);
    const O1 = 'origin-aaaa-1111', O2 = 'origin-bbbb-2222';
    await push(e, [R('xray', 'xa', { image_png: img(200) }, { patient_uid: 'p0' })], { proto: 2, origin: O1 });
    const mine = (await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { origin: O1 })).data;
    const xa = mine.rows.find((r) => r.uid === 'xa');
    check('echo: the laptop that pushed a row gets it back as a small stub, not the image', xa && xa.own === 1 && !('data' in xa) && mine.stubs === 1);
    const theirs = (await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { origin: O2 })).data;
    const xb = theirs.rows.find((r) => r.uid === 'xa');
    check('...while every other laptop gets the full row', xb && !xb.own && xb.data && xb.data.image_png.length > 200000);
    const after = (await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { origin: O1, echo_min: Number(mine.head) })).data;
    check('...and echo_min turns stubs off for rows at or below it (the app\'s re-read)', after.rows.find((r) => r.uid === 'xa').data.image_png.length > 200000);
  }

  // ------------------------------------------------------------------ 6
  {
    const e = await mkEnv();
    await push(e, [R('event', 'ev1', { name: 'C' })]);
    const h = head(e);
    const r = (await pull2(e, { e: h + 50, p: 0, k: 0, x: 0 })).data;
    check('a cursor from a different database is answered with a reset, not silence', r && r.reset === 'cursor_ahead' && r.rows.length === 0);
  }

  // ------------------------------------------------------------------ 7
  {
    const e = await mkEnv();
    const old = R('patient', 'pp', { v: 1 });
    await push(e, [old]);
    const rows = [
      { bogus: true },                                                   // invalid
      R('xray', 'big', { image_png: img(2000) }),                        // too big
      { ...old },                                                        // same stamp: skipped
      R('patient', 'fresh', { v: 1 }),                                   // applied
    ];
    const r = (await push(e, rows, { proto: 2, origin: 'origin-cccc-3333' })).data;
    check('v2 push: one result per row, in order', r.proto === 2 && JSON.stringify(r.results) === JSON.stringify(['invalid', 'too_big', 'skipped', 'applied']), JSON.stringify(r.results));
    const legacy = await push(e, [R('patient', 'fresh2', { v: 1 }), R('xray', 'big2', { image_png: img(2000) })]);
    check('legacy push with an oversized row is NOT reported as ok (an older app would mark it synced and lose it)', legacy.data.ok === false && legacy.data.partial === true && /too large/.test(legacy.data.error));
    check('...and it is an HTTP error, as the old server\'s was, so an older app does not show "synced"', legacy.status >= 500, `HTTP ${legacy.status}`);
    check('...while the rest of that push is stored', table(e).has('fresh2') && !table(e).has('big2'));
  }

  // ------------------------------------------------------------------ 8
  {
    const e = await mkEnv();
    const t1 = stamp(), t2 = stamp(), t3 = stamp(), t4 = stamp();
    await push(e, [R('patient', 'a', { v: 2 }, { updated_at: t2 })]);
    await push(e, [R('patient', 'a', { v: 1 }, { updated_at: t1 })]);
    check('last-write-wins: an older write never replaces a newer one', JSON.parse(e.DB._sqlite.prepare("SELECT data FROM sync_rows WHERE uid='a'").get().data).v === 2);
    await push(e, [R('patient', 'a', {}, { updated_at: t3, deleted: true })]);
    await push(e, [R('patient', 'a', { v: 4 }, { updated_at: t4 })]);
    check('a deletion is sticky: a newer ordinary write does not resurrect it', table(e).get('a').deleted === 1);
    await push(e, [R('patient', 'a', { v: 5 }, { undelete: true })]);
    check('...but an explicit restore does', table(e).get('a').deleted === 0);
  }

  // ------------------------------------------------------------------ 9
  {
    const e = await mkEnv({ maxQueries: 50 });
    await push(e, [R('event', 'ev1', { name: 'C' })]);
    const rows = Array.from({ length: 120 }, (_, i) => R('patient', 'f' + i, { i }, { event_uid: 'ev1' }));
    let tries = 0, ok = false, first = null;
    while (tries < 15 && !ok) { const r = await push(e, rows); if (!first) first = r; ok = r.data && r.data.ok === true; tries++; }
    check('free plan (50 statements a request): an older app\'s 120-row push gets through, a part each time', ok && [...table(e).keys()].filter((u) => u.startsWith('f')).length === 120, `${tries} request(s)`);
    check('...each partial step is reported as partial, not as success (an HTTP error to an older app)', first.status === 503 && first.data.ok === false && first.data.partial === true);
    const e2 = await mkEnv({ maxQueries: 50 });
    const v2 = (await push(e2, Array.from({ length: 120 }, (_, i) => R('patient', 'g' + i, { i })), { proto: 2, origin: 'origin-dddd-4444' })).data;
    check('...and a v2 push says exactly which rows to send again', v2.complete === false && v2.results.includes('retry') && v2.results.indexOf('retry') === v2.results.filter((x) => x !== 'retry').length);
  }

  // A transient D1 error is not the per-request limit, and a learned limit
  // does not last for ever.
  {
    const e = await mkEnv();
    await push(e, [R('event', 'ev1', { name: 'C' })]);
    e.DB.setFaults({ failBatches: 1, failBatchMessage: 'D1_ERROR: D1 DB is overloaded. Too many requests queued.' });
    await push(e, Array.from({ length: 30 }, (_, i) => R('patient', 'o' + i, { i })), { proto: 2, origin: 'origin-ffff-6666' });
    const after = (await push(e, Array.from({ length: 100 }, (_, i) => R('patient', 'q' + i, { i })), { proto: 2, origin: 'origin-ffff-6666' })).data;
    check('budget: one "D1 DB is overloaded" error does not throttle later uploads', after.complete === true && after.applied === 100, `applied ${after.applied}, max_rows ${after.max_rows}`);

    const f = await mkEnv({ maxQueries: 50 });
    await push(f, [R('event', 'ev1', { name: 'C' })]);
    await push(f, Array.from({ length: 120 }, (_, i) => R('patient', 'h' + i, { i })), { proto: 2, origin: 'origin-ffff-7777' }); // learns ~50
    f.DB.setLimits({ maxQueries: 0 }); // the clinic moves to the paid plan
    const capped = (await push(f, Array.from({ length: 120 }, (_, i) => R('patient', 'j' + i, { i })), { proto: 2, origin: 'origin-ffff-7777' })).data;
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    let freed;
    try { freed = (await push(f, Array.from({ length: 120 }, (_, i) => R('patient', 'k' + i, { i })), { proto: 2, origin: 'origin-ffff-7777' })).data; }
    finally { Date.now = realNow; }
    check('budget: a learned limit is forgotten after ten minutes (and learned again only if it still holds)', capped.complete === false && freed.complete === true && freed.applied === 120,
      `before: ${capped.applied}/120, after: ${freed.applied}/120`);
  }

  // ------------------------------------------------------------------ 10
  {
    const e = await mkEnv();
    await push(e, [R('event', 'ev1', { name: 'C' })]);
    e.DB.setFaults({ failWritesWith: 'D1_ERROR: database or disk is full: SQLITE_FULL' });
    const legacy = await push(e, [R('patient', 'z1', {})]);
    check('a push that stores nothing is a visible error (503), never "synced"', legacy.status === 503 && legacy.data.ok === false && /FULL/.test(legacy.data.error));
    const v2 = (await push(e, [R('patient', 'z2', {})], { proto: 2, origin: 'origin-eeee-5555' })).data;
    check('...and a v2 push says it is incomplete, with the reason', v2.complete === false && /FULL/.test(v2.error || ''));
    e.DB.setFaults({ failWritesWith: null });
  }

  // ------------------------------------------------------------------ 11
  {
    const e = await mkEnv();
    await push(e, [R('event', 'ev1', { name: 'C' })]);
    const before = head(e);
    e.DB.setFaults({ failBatches: 1 });
    const r = await push(e, Array.from({ length: 10 }, (_, i) => R('patient', 'b' + i, { i })));
    const t = table(e);
    const seqs = Array.from({ length: 10 }, (_, i) => (t.get('b' + i) || {}).seq);
    check('a batch that fails is retried in rebuilt halves, and everything is stored', r.data.ok === true && seqs.every((s) => s != null));
    check('...with every number above what readers had already passed, and none reused', seqs.every((s) => s > before) && new Set(seqs).size === 10);
    const { pages } = await drainLegacy(e, String(before));
    check('...so a laptop that had read up to then receives all of them', pages.flatMap((p) => p.rows.map((x) => x.uid)).filter((u) => u.startsWith('b')).length === 10);
  }

  // ------------------------------------------------------------------ 12
  // A database the v1.11 worker built, opened by this one.
  {
    let src = null;
    try { src = execFileSync('git', ['show', '1f8c3c2:cloud/worker.js'], { cwd: HERE, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_e) { /* no git */ }
    if (src) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migr-'));
      const oldFile = path.join(dir, 'worker.js'); fs.writeFileSync(oldFile, src);
      const file = path.join(dir, 'd1.sqlite');
      const eo = await mkEnv({ file }, oldFile);
      await clinic(eo, { patients: 8, xrays: 1, kb: 20 });
      const oldHead = head(eo);
      eo.DB._sqlite.prepare("UPDATE sync_rows SET seq = NULL WHERE uid = 'p3'").run(); // a stray row with no number
      eo.DB.close();
      const en = await mkEnv({ file });
      const first = await push(en, [R('patient', 'after', {})]);
      check('migration: the new worker opens a v1.11 database and keeps working', first.data.ok === true);
      const p3 = table(en).get('p3');
      check('...a row with no delivery number gets a fresh one ABOVE every cursor (v1.11 put it at rowid, below them)', p3.seq > oldHead, `seq ${p3.seq} vs old head ${oldHead}`);
      const { view, error } = await drain2(en);
      check('...and v2 delivers every row written by the old worker', !error && [...table(en).keys()].every((u) => view.has(u)), error);
      const leg = await drainLegacy(en, String(oldHead));
      check('...and an older laptop that had read up to the old head still receives the stray row', leg.pages.some((p) => p.rows.some((r) => r.uid === 'p3')));
    } else console.log('SKIP: migration test needs git');
  }

  // ------------------------------------------------------------------ 13
  {
    const e = await mkEnv({}, CURRENT, { SYNC_V2: 'off' });
    await push(e, [R('event', 'ev1', { name: 'C' })]);
    const r = (await pull2(e, { e: 0, p: 0, k: 0, x: 0 })).data;
    check('kill switch: SYNC_V2=off gives an old-style empty page, never a v2 one', r && !('proto' in r) && r.rows.length === 0);
    const h = (await call(e, 'GET', '/health')).data;
    check('...and /health says protocol 1', h.sync_api === 1);
    e.DB._sqlite.close(); // the database fails every query
    const broken = await pull2(e, { e: 0, p: 0, k: 0, x: 0 });
    check('...and even its errors are old-style, so an app drops back at once', broken.status === 500 && broken.data && !('proto' in broken.data), broken.text.slice(0, 80));
  }

  // ------------------------------------------------------------------ 14
  {
    const e = await mkEnv();
    await push(e, [R('event', 'ev1', { name: 'C' })]);
    await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-A', backlog: { c: 2, x: 37, b: 15000000, w: 'Dr Rivera' } });
    const b = (await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-B', backlog: { c: 0, x: 0, b: 0 } })).data;
    check('backlog: every laptop is told what another still has to send', b.peers.length === 1 && b.peers[0].device === 'laptop-A' && b.peers[0].xrays === 37 && b.peers[0].who === 'Dr Rivera');
    const a = (await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-A', backlog: { c: 0, x: 0, b: 0 } })).data;
    const b2 = (await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-B' })).data;
    check('...a laptop is never told about itself, and a cleared backlog disappears', a.peers.every((p) => p.device !== 'laptop-A') && b2.peers.length === 0);
    // A laptop that goes back to uploading the old way (downgraded) has its report dropped.
    await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-D', backlog: { c: 0, x: 3, b: 9, w: 'D' } });
    await call(e, 'POST', '/v1/push', { device_id: 'laptop-D', rows: [] });
    const afterOld = (await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-B', backlog: { c: 0, x: 0, b: 0 } })).data;
    check('backlog: a laptop that uploads the old way (downgraded) is no longer reported as holding x-rays', !afterOld.peers.some((p) => p.device === 'laptop-D'));
    // Written only when it changes: an unchanged report is not rewritten on every pull.
    const at = () => { const r = e.DB._sqlite.prepare("SELECT v FROM sync_meta WHERE k = 'backlog:laptop-C'").get(); return r ? JSON.parse(r.v).at : null; };
    await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-C', backlog: { c: 0, x: 4, b: 900, w: 'C' } });
    const at1 = at();
    await new Promise((r) => setTimeout(r, 5));
    await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-C', backlog: { c: 0, x: 4, b: 900, w: 'C' } });
    check('backlog: an unchanged report is not written again on every pull', at1 != null && at() === at1);
    await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-C', backlog: { c: 0, x: 3, b: 600, w: 'C' } });
    check('...a changed one is', at() !== at1);
    // A laptop that went offline holding unsent x-rays is still reported hours later.
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 3600 * 1000;
    let late;
    try { late = (await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-B', backlog: { c: 0, x: 0, b: 0 } })).data; }
    finally { Date.now = realNow; }
    check('backlog: a laptop that went offline holding x-rays is still reported three hours later', late.peers.some((p) => p.device === 'laptop-C' && p.xrays === 3));
    // A refused write (the daily write quota, say) does not cost the pull.
    e.DB.setFaults({ failWritesWith: 'D1_ERROR: Exceeded maximum rows written per day' });
    const refused = await pull2(e, { e: 0, p: 0, k: 0, x: 0 }, { device: 'laptop-C', backlog: { c: 0, x: 9, b: 1, w: 'C' } });
    e.DB.setFaults({ failWritesWith: null });
    check('...and a report the database refuses to store does not fail the pull', refused.status === 200 && refused.data.ok === true && refused.data.proto === 2);
    // A passing D1 error on a pull is not taken for a broken index.
    e.DB.setFaults({ failBatches: 1, failBatchMessage: 'D1_ERROR: D1 DB is overloaded. Too many requests queued.' });
    const hiccup = await pull2(e, { e: 0, p: 0, k: 0, x: 0 });
    const next = await pull2(e, { e: 0, p: 0, k: 0, x: 0 });
    check('a passing D1 error on a pull does not switch the server back to the old protocol', hiccup.status === 500 && next.data && next.data.proto === 2, `then: ${next.text.slice(0, 80)}`);
  }

  // ------------------------------------------------------------------ 15
  {
    const e = await mkEnv();
    const r = await push(e, [R('event', 'ev1', { name: 'C' }), R('patient', 'q', {})]);
    check('an ordinary push from an older app gets exactly the old response', r.status === 200 && Object.keys(r.data).sort().join(',') === 'applied,ok,skipped,time' && r.data.ok === true && r.data.applied === 2);
    const h = (await call(e, 'GET', '/health')).data;
    check('/health offers protocol 2 once the lanes are built', h.sync_api === 2 && h.caps.includes('pull2'));
  }

  // ------------------------------------------------------------------ 16
  {
    const e = await mkEnv();
    await clinic(e, { patients: 10, xrays: 0 });
    const t = table(e);
    const ok = [...t.values()].every((r) => Number.isInteger(r.seq));
    const rows = e.DB._sqlite.prepare('SELECT uid, data, nbytes FROM sync_rows').all();
    const canon = rows.every((r) => r.nbytes == null || (JSON.stringify(JSON.parse(r.data)) === r.data && Buffer.byteLength(r.data) === r.nbytes));
    check('every stored row has a number, and every row this worker wrote is canonical JSON of the size it claims', ok && canon);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
