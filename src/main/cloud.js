'use strict';

// v1.1.0 — Cloud sync engine (main process). Drives the row-level sync in db.js
// against the Cloudflare Worker (see cloud/SYNC_CONTRACT.md). Offline-first:
// nothing runs unless an admin has entered a URL + key and enabled sync. All
// network failures are swallowed into a status field so the app keeps working.

const crypto = require('crypto');
const os = require('os');
const db = require('./db');

const INTERVAL_MS = 4000;
const HTTP_TIMEOUT_MS = 20000;
const PULL_LIMIT = 400;

// v1.13.0 — the 15-minute check-out delay.
//
// Reported from a large clinic with 200+ x-rays: a patient checked out on one
// laptop could take a quarter of an hour to show as checked out on the others.
// Reproduced against the real worker with four simulated laptops on a throttled
// link. Every x-ray row carries the whole image, and batches and pages were
// capped by ROW COUNT only under a flat 12-second timeout, so:
//   - the laptop taking x-rays sent one request with the check-out at the top
//     and 60 images behind it, which never finished uploading in time, was
//     retried identically every 4 seconds, and — because a failed push skipped
//     the pull — also never received anyone else's check-outs;
//   - a laptop that fell behind (sleep, wifi drop, restart, "Re-sync
//     everything") asked for a 400-row page holding ~80MB of images, timed out,
//     and asked for the identical page again, forever;
//   - and a timeout while reading the response was swallowed, reported as an
//     empty success, and the badge kept saying "Cloud · synced".
// Nothing produced 15 minutes deliberately; that was how long it took for a
// stuck laptop to come unstuck by luck. The fixes below are all on this side,
// so they work against the clinic server as it is — no Cloudflare paste.

// Images go in their own requests, after the clinical rows, at most this many
// bytes at a time. Halved after a timeout, regrown after a success.
const XRAY_BATCH_MAX = 3 * 1024 * 1024;
const XRAY_BATCH_MIN = 1; // always at least one image (see collectSyncRows)
let xrayBatchBytes = XRAY_BATCH_MAX;
// The clinical lane is small in the ordinary case, but consents carry signature
// images, so a backlog of hundreds of them is not. Same rule: halve the row cap
// after a timeout, double it back after a success.
let clinicalMax = PULL_LIMIT;

// Pull pages are sized from what the previous page actually weighed, aiming
// for pages a slow clinic link can fetch well inside the timeout.
const PULL_TARGET_BYTES = 4 * 1024 * 1024;
// The FIRST page after the app starts is a guess, so guess small: 50 rows is
// nothing for a page of check-outs, and at most ~20MB for a page of x-rays.
// Starting at 400 cost a laptop that had fallen behind two full timeouts before
// it found a size that fitted. After one page, the measured weight takes over.
const PULL_FIRST_LIMIT = 50;
let pullLimit = PULL_FIRST_LIMIT;

// Stop paging after this long so the laptop gets back to PUSHING its own
// check-outs; the next cycle carries on from the same cursor.
const PULL_TIME_BUDGET_MS = 20000;

const isTimeout = (e) => !!(e && (e.name === 'AbortError' || e.timeout || /abort/i.test(String(e.message || ''))));

// v1.14.0 — four lanes. See cloud/SYNC_CONTRACT.md.
//
// A v1.14 server hands rows out in four lanes — deletions and clinics, then
// patients, then the rest of the chart, then x-ray images — each with its own
// cursor, and every page capped in BYTES. A laptop that has fallen behind gets
// every check-out first and the image backlog after, instead of the check-outs
// queued behind the images. It also sends this app's own uploads back as
// stubs instead of a second copy of every image.
//
// RULE: when the server does not answer in the new protocol, every code path
// below is v1.13's. An older server is asked once every ten minutes, with a
// request it answers with an empty page.
const LANES = ['e', 'p', 'k', 'x'];
const PROBE_SINCE = '9007199254740991'; // an older server: "rows after this" = none
const PULL_BYTES_INIT = 1024 * 1024;
const PULL_BYTES_FLOOR = 256 * 1024;  // where the measured rate cannot push it below
const PULL_BYTES_MIN = 64 * 1024;     // where timeouts can
const PULL_BYTES_CAP = 4 * 1024 * 1024;
const PAGE_TARGET_MS = 3000;          // aim for pages this link fetches in ~3 s
const IMAGE_SLICE_MS = 4000;          // images only: give the push its turn this often
const PROTO_RETRY_MS = 10 * 60 * 1000;
const PUSH_V2_ROUNDS = 3;
const PUSH_TIME_BUDGET_MS = 8000;
const CEILING_MS = 10 * 60 * 1000;
const NOTIFY_THROTTLE_MS = 1000;
const REACHABLE_MS = 120000;

// The echo token names THIS run of the app to the server, which then sends our
// own rows back as stubs. Never saved: after a restart, a restore or an import
// the local database may no longer hold what this run pushed, so a new run
// gets a new token and full copies of everything.
let echoToken = crypto.randomUUID();
let echoMin = 0;
function rotateEchoToken() { echoToken = crypto.randomUUID(); echoMin = 0; }

let serverProto = 0;    // 0 not yet known, 1 older server, 2 lanes
let protoRetryAt = 0;
let v2Fails = 0;
let pullBytes = PULL_BYTES_INIT;
let rateBps = 0;
let serverMaxRows = PULL_LIMIT;
let serverRowsUntil = 0;    // the server's "this many rows per request" holds until then
let clinicalCeiling = null; // { max, until }: no growing back past a size that failed
let xrayCeiling = null;
let lastPull = null;        // what the last good page said about how complete this laptop is
let lastPullOkAt = 0;
let lastNotify = 0;
let backlog = { c: 0, x: 0, b: 0 };
const isSeq = (v) => /^\d+$/.test(String(v == null ? '' : v));
const ceilingOf = (c) => (c && Date.now() < c.until ? c.max : Infinity);
// A failed request counts against its size if it timed out or the server
// errored. Not an offline laptop: that is no reason to send less.
const sizeFailure = (e) => isTimeout(e) || (e && e.status >= 500);

let timer = null;
let againTimer = null;    // v1.14.0: the quick follow-up cycle while catching up
let running = false;      // a sync cycle is in flight
let getWindow = () => null;
let lastResult = { pushed: 0, pulled: 0, applied: 0 };
// X-rays too big for the clinic cloud, left on this laptop rather than allowed
// to jam every upload behind them. Shown on the Management cloud card.
let xraysTooBig = 0;

// Normalize whatever the admin pasted into a usable base URL. Handles the common
// mistakes: no scheme (workers.dev address pasted bare), a trailing slash, or an
// accidentally-included path like /health or /v1/pull. Returns the bare origin
// (e.g. https://caring-hands-sync.acme.workers.dev).
function trimUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s; // add https:// when missing
  try { return new URL(s).origin; } catch { return s.replace(/\/+$/, ''); }
}

// v1.14.0: a request is given up when nothing moves, not when it is merely
// slow. A fixed 20 s for the whole request meant that below about 0.8 Mbit a
// 2 MB x-ray could never arrive (or leave): it was tried again every cycle, 20 s
// at a time, and every image behind it waited.
//   - until the answer starts: 20 s, plus what the upload needs at a slow
//     256 kbit/s, so a large x-ray on a poor uplink still gets there;
//   - after that: 20 s with not a single byte arriving;
//   - and never more than five minutes in all.
const UPLOAD_FLOOR_BPS = 32 * 1024;
const HTTP_MAX_MS = 5 * 60 * 1000;

// opts.deadlineMs: a limit on the WHOLE request instead — for a page from a
// server that does not cap its pages in bytes (see pullLegacy).
async function httpJson(method, url, key, body, info, opts = {}) {
  const controller = new AbortController();
  const payload = body ? JSON.stringify(body) : undefined;
  let stall = null;
  const arm = (ms) => { clearTimeout(stall); stall = setTimeout(() => controller.abort(), ms); };
  const cap = setTimeout(() => controller.abort(), opts.deadlineMs || HTTP_MAX_MS);
  arm(HTTP_TIMEOUT_MS + (payload ? Math.round((Buffer.byteLength(payload) / UPLOAD_FLOOR_BPS) * 1000) : 0));
  const t0 = Date.now();
  try {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = 'Bearer ' + key;
    const res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    arm(HTTP_TIMEOUT_MS);
    let text = '';
    try { text = await readBody(res, () => arm(HTTP_TIMEOUT_MS)); } catch (e) {
      // The body timed out half-way. This used to be swallowed and returned as
      // an empty success: no rows, cursor unmoved, error cleared, badge green.
      if (controller.signal.aborted) {
        const err = new Error('The clinic cloud took too long to answer.');
        err.timeout = true; throw err;
      }
      throw new Error('The connection to the clinic cloud dropped part-way through. It will try again.');
    }
    if (info) { info.bytes = text.length; info.ms = Date.now() - t0; }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!res.ok) {
      const msg = (json && json.error) || `HTTP ${res.status}`;
      const err = new Error(msg); err.status = res.status; err.body = json; throw err;
    }
    return json || {};
  } catch (e) {
    if (controller.signal.aborted && !e.timeout) {
      const err = new Error('The clinic cloud took too long to answer.');
      err.timeout = true; throw err;
    }
    throw e;
  } finally { clearTimeout(stall); clearTimeout(cap); }
}

// The answer's body, calling onChunk as each piece arrives (the stall timer).
async function readBody(res, onChunk) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    onChunk();
  }
  return Buffer.concat(parts).toString('utf8');
}

// Verify a URL + key: /health must be reachable, and the key must authorize a pull.
async function testConnection(url, key) {
  const base = trimUrl(url);
  if (!base) throw new Error('Enter the Cloud URL first.');
  const health = await httpJson('GET', base + '/health', null);
  if (!health || health.ok !== true) throw new Error('That URL did not return a Caring Hands sync server.');
  // Key check — a bad key returns 401.
  await httpJson('GET', base + '/v1/pull?since=&limit=1', key);
  return { ok: true, service: health.service, version: health.version, time: health.time, sync_api: health.sync_api || 1 };
}

// Two requests, in this order:
//   1. everything clinical — patients, vitals, triage, treatment, consents,
//      deletions. Small, so it lands in well under a second even on a poor
//      link, and it is never waiting behind an image again.
//   2. x-ray images, a few megabytes at a time — but ONLY once the clinical
//      backlog has been fully sent. With more clinical rows than fit in one
//      request (a day offline, a restored backup), sending images in the same
//      cycle could put an x-ray on the cloud before its patient; other laptops
//      would then hold it as an orphan until the patient caught up.
async function pushOnce(base, key, deviceId, ctx) {
  let pushed = 0, more = false, note = null;
  const t0 = Date.now();
  // The clinical lane. Against a v1.14 server it may take more than one round:
  // on the free Cloudflare plan the server can store only so many rows per
  // request, and says how many it got through, so the rest go straight after
  // rather than four seconds later.
  let sentClinical = false;
  for (let round = 0; ; round++) {
    const max = Math.max(1, Math.min(clinicalMax, serverMaxRows));
    const clinical = db.collectSyncRows(max, { skip: ['xray'] });
    if (!clinical.rows.length) break;
    sentClinical = true;
    let res;
    try {
      res = await pushBatch(base, key, deviceId, clinical, ctx);
    } catch (e) {
      // Too big for this link or this server: send fewer next time, and do not
      // grow back past the size that failed for a while. A free-plan server
      // that cannot store 400 rows in one request used to be sent the same
      // 400 rows every four seconds, forever.
      if (sizeFailure(e)) {
        clinicalMax = Math.max(1, Math.floor(clinicalMax / 2));
        clinicalCeiling = { max: clinicalMax, until: Date.now() + CEILING_MS };
      }
      // Still holding all of it: say so to the other laptops (the pull still
      // runs, and carries this). Left as it was, a laptop whose uploads kept
      // failing told everyone it had nothing to send.
      backlog = { c: 1, ...xrayBacklogNow() };
      throw e;
    }
    pushed += clinical.rows.length;
    if (res.error) note = res.error;
    if (res.settled === 0) {
      // Nothing stored at all. Same as an error, said honestly.
      clinicalMax = Math.max(1, Math.floor(clinicalMax / 2));
      clinicalCeiling = { max: clinicalMax, until: Date.now() + CEILING_MS };
      backlog = { c: 1, ...xrayBacklogNow() };
      throw new Error(res.error || 'The clinic cloud did not store this upload. It will try again.');
    }
    if (clinical.rows.length >= max && res.complete) clinicalMax = Math.min(PULL_LIMIT, clinicalMax * 2, ceilingOf(clinicalCeiling));
    const again = res.v2 && (!res.complete || clinical.truncated)
      && round + 1 < PUSH_V2_ROUNDS && Date.now() - t0 < PUSH_TIME_BUDGET_MS;
    if (!again) break;
  }
  // More clinical rows still waiting? They go first, next cycle. (Asking for
  // one row is a peek: collecting only stamps a row whose content changed,
  // exactly as the real collect next cycle would.) Only after something was
  // sent: when the first collect found nothing, nothing can have changed, and
  // the peek — which hashes every chart row, signatures included — doubled the
  // idle cycle's freeze.
  if (sentClinical && db.collectSyncRows(1, { skip: ['xray'] }).rows.length) {
    backlog = { c: 1, ...xrayBacklogNow() };
    return { pushed, more: true, note };
  }
  const xr = db.collectSyncRows(PULL_LIMIT, { only: ['xray'], tombstones: false, xrayBytes: xrayBatchBytes });
  xraysTooBig = xr.xraysTooBig || 0;
  if (xr.rows.length) {
    let res;
    try {
      res = await pushBatch(base, key, deviceId, xr, ctx, 'xray');
    } catch (e) {
      // Too big for this link: send less next time rather than the identical
      // batch again. Down to a single image, which always goes.
      if (sizeFailure(e)) {
        xrayBatchBytes = Math.max(XRAY_BATCH_MIN, Math.floor(xrayBatchBytes / 2));
        xrayCeiling = { max: xrayBatchBytes, until: Date.now() + CEILING_MS };
      }
      backlog = { c: 0, ...xrayBacklogNow() };
      throw e;
    }
    pushed += xr.rows.length;
    if (res.error) note = res.error;
    if (res.settled === 0) {
      xrayBatchBytes = Math.max(XRAY_BATCH_MIN, Math.floor(xrayBatchBytes / 2));
      xrayCeiling = { max: xrayBatchBytes, until: Date.now() + CEILING_MS };
      backlog = { c: 0, ...xrayBacklogNow() };
      throw new Error(res.error || 'The clinic cloud did not store this upload. It will try again.');
    }
    // It fitted. Only grow if the budget was actually what limited it: a
    // one-small-image push says nothing about whether a bigger one would fit,
    // and growing on it swung a marginal link back into a timeout.
    const sent = xr.rows.reduce((n, row) => n + String((row.data && row.data.image_png) || '').length, 0);
    if (sent >= xrayBatchBytes / 2 && res.complete) xrayBatchBytes = Math.min(XRAY_BATCH_MAX, Math.round(xrayBatchBytes * 1.5), ceilingOf(xrayCeiling));
    more = xr.truncated || !res.complete;
  }
  backlog = { c: 0, ...xrayBacklogNow() };
  return { pushed, more, note };
}

// The clinic this laptop is on, sent with its report so only that clinic's
// stations are named when they go quiet.
function activeEventUid() {
  try { return db.eventUid(Number(db.getSetting('active_event_id')) || null) || ''; } catch (_e) { return ''; }
}

// Closing (or switching to offline): send a last report saying so, with what
// is still outstanding, so the other laptops' Finish does not mistake a laptop
// shut down with everything sent for one that went quiet holding x-rays. Best
// effort, three seconds at most; a server older than v1.14 has nowhere to put it.
async function signOff() {
  const m = db.getSyncMeta();
  if (!m.enabled || !m.url || !m.key || serverProto !== 2) return { ok: false, skipped: true };
  const clinicalLeft = db.collectSyncRows(1, { skip: ['xray'] }).rows.length;
  const b = { c: clinicalLeft ? 1 : 0, ...xrayBacklogNow(), w: String(os.hostname() || '').slice(0, 60), e: activeEventUid() };
  const run = httpJson('POST', trimUrl(m.url) + '/v1/signoff', m.key, { device_id: db.ensureDeviceId(), backlog: b }).catch(() => null);
  const r = await Promise.race([run, new Promise((res) => setTimeout(() => res(null), 3000))]);
  return { ok: !!(r && r.ok) };
}

function xrayBacklogNow() {
  try { const b = db.xrayBacklog(); return { x: b.count || 0, b: b.bytes || 0, t: b.stuck || 0 }; } catch (_e) { return { x: 0, b: 0, t: 0 }; }
}

// One upload, and what it settled. A v1.14 server answers row by row:
//   applied / skipped / invalid — final, marked sent
//   too_big — it can never be stored as it is; set aside until it changes
//   retry   — not stored this time (the server ran out of room in this
//             request); still waiting, sent again
// An older server answers ok:true for the whole batch, or fails it.
async function pushBatch(base, key, deviceId, batch, ctx, lane = 'clinical') {
  const r = await httpJson('POST', base + '/v1/push', key, { device_id: deviceId, proto: 2, origin: echoToken, rows: batch.rows });
  // A reset (Re-sync everything, a new server address) happened while this
  // upload was in flight. Marking now would mark rows sent that the reset just
  // asked to send again — to a different server, possibly.
  if (ctx && db.syncGen() !== ctx.gen) return { v2: false, settled: batch.rows.length, complete: true };
  if (r && r.proto === 2 && Array.isArray(r.results) && r.results.length === batch.rows.length) {
    const done = [], refused = [];
    r.results.forEach((res, i) => {
      if (res === 'applied' || res === 'skipped' || res === 'invalid') done.push(batch.mark[i]);
      else if (res === 'too_big') refused.push(batch.mark[i]);
    });
    if (done.length) { db.markSynced(done); db.setSyncMeta({ lastPush: new Date().toISOString() }); }
    if (refused.length) db.markRefused(refused);
    // The server says how many rows a request could store only when one could
    // not store them all (a complete answer always says 400). So a limit it
    // gives is kept for a while, and only grown back after a request of that
    // size came back complete: taking every answer at its word sent a
    // 200-row request after every 26-row one on the free plan, each storing 26.
    // Only when the server says it truly ran out of room (limited): an answer
    // cut short by a passing error says nothing about how much fits, and
    // taking its count pinned uploads at one row a request for ten minutes.
    // Only from chart uploads, whose size this governs.
    const mr = Number(r.max_rows);
    if (lane === 'clinical') {
      if (!r.complete && r.limited && mr >= 1) {
        serverMaxRows = Math.min(serverMaxRows, PULL_LIMIT, Math.floor(mr));
        serverRowsUntil = Date.now() + CEILING_MS;
      } else if (r.complete && batch.rows.length >= serverMaxRows && Date.now() >= serverRowsUntil) {
        serverMaxRows = Math.min(PULL_LIMIT, serverMaxRows * 2);
      }
    }
    return { v2: true, settled: done.length + refused.length, complete: !!r.complete, error: r.error || (refused.length ? 'Some items are too large for the clinic cloud to store; they stay on this laptop.' : null) };
  }
  // A v2 answer whose results do not line up with what was sent: its ok:true
  // does NOT mean every row was stored (a v2 answer says ok:true with rows
  // still to retry), so mark nothing and send again.
  if (r && r.proto === 2) return { v2: false, settled: 0, complete: false, error: r.error || 'The clinic cloud\'s answer did not match the upload. It will try again.' };
  if (r && r.ok) {
    db.markSynced(batch.mark); db.setSyncMeta({ lastPush: new Date().toISOString() });
    return { v2: false, settled: batch.rows.length, complete: true };
  }
  // Part stored, part not ({ok:false, partial:true}), or an answer whose
  // results do not line up with what was sent: mark nothing, send again. The
  // stored rows are skipped cheaply the second time.
  return { v2: false, settled: r && r.partial ? batch.rows.length : 0, complete: false, error: (r && r.error) || null };
}

// A cursor is either the server's delivery counter (a plain number, v1.5.0+
// servers) or the old timestamp stamp. Only the counter is safe: it cannot skip
// a row that reaches the cloud late (an offline check-in, or a laptop whose
// clock is behind).
const isSeqCursor = (c) => /^\d+$/.test(String(c || ''));

async function pullOnce(base, key, ctx) {
  let cursor = db.getSyncMeta().cursor || '';
  // Still on a timestamp cursor? Ask whether this server now delivers by
  // counter, and if so restart from the beginning ONCE. That both switches this
  // station over and re-reads anything the old timestamp cursor stepped past.
  if (cursor && !isSeqCursor(cursor)) {
    let health = null;
    try { health = await httpJson('GET', base + '/health', null); } catch { /* offline / older server */ }
    if (health && health.seq === true) { cursor = ''; db.setSyncMeta({ cursor }); }
  }
  if (serverProto !== 1 || Date.now() >= protoRetryAt) {
    const r = await pullV2(base, key, ctx);
    if (r !== 'legacy') return r;
  }
  return pullLegacy(base, key, ctx);
}

// The single-cursor pull, for a server older than v1.14 (or one with the new
// protocol switched off). v1.13's loop, except that the cursor and the rows
// waiting for a parent are now saved together, after every page.
async function pullLegacy(base, key, ctx) {
  let cursor = db.getSyncMeta().cursor || '';
  let pulled = 0, applied = 0, removed = 0, guard = 0, more = true;
  // Retry any previously-orphaned rows first — their parent may have arrived
  // since (e.g. a treatment that was pulled before its patient).
  let carry = db.getSyncPending();
  // Follow `more` pages so a first sync catches up fully. A child whose parent
  // lands in a later page is carried forward within the loop. The server hands
  // rows out in its own counter order, so no row is ever skipped at a page
  // boundary, so the cursor can always advance — orphans that outlive the whole
  // delta are parked in the persistent pending buffer and retried next cycle
  // (never dropped, never wedging the cursor).
  const started = Date.now();
  for (;;) {
    if (guard++ > 500) break;
    const qs = `?since=${encodeURIComponent(cursor)}&limit=${pullLimit}`;
    const info = {};
    let r;
    try {
      // An older server caps a page by rows only, so one can be tens of MB of
      // images: give it 20 s in all, as v1.13 did, so a page too big for the
      // link times out, the page shrinks, and this laptop's own uploads get
      // their turn. Waiting "until nothing moves" held a cycle — and every
      // check-out made meanwhile — for up to five minutes. A page of ONE row
      // has nowhere smaller to go, so that one may take as long as it keeps
      // arriving.
      r = await httpJson('GET', base + '/v1/pull' + qs, key, null, info, { deadlineMs: pullLimit > 1 ? HTTP_TIMEOUT_MS : 0 });
    } catch (e) {
      // A page too heavy for this link: ask for half as many rows next time.
      // It used to ask for the identical 400-row page again, forever.
      if (isTimeout(e)) pullLimit = Math.max(1, Math.floor(pullLimit / 2));
      throw e;
    }
    // A reset (a new server address, Re-sync everything) while this page was
    // on its way: it is from the old server, or from before the reset. Apply
    // none of it. Applying marks rows as already sent, which cancelled the
    // reset's "send everything to the new server" for every row on the page.
    if (db.syncGen() !== ctx.gen) break;
    const rows = (r && r.rows) || [];
    // Size the NEXT page from what this one weighed: a page of check-outs is a
    // few KB a row; a page of x-rays is half a megabyte a row.
    //
    // Shrinking is immediate. GROWING is only allowed after a page came back
    // FULL and light, and then at most double: a short page of three check-outs
    // says nothing about how heavy the next page will be, and letting it set the
    // limit back to 400 sent a laptop straight into a timeout on the x-ray
    // backlog behind it (seen in the reproduction).
    if (rows.length && info.bytes) {
      const asked = pullLimit;
      const fit = Math.floor(PULL_TARGET_BYTES / Math.max(1, info.bytes / rows.length));
      const ceiling = rows.length >= asked ? asked * 2 : asked;
      pullLimit = Math.max(1, Math.min(PULL_LIMIT, fit, ceiling));
    }
    const batch = carry.length ? carry.concat(rows) : rows;
    if (batch.length) {
      const res = db.applyRemoteRows(batch);
      applied += res.applied; removed += (res.deleted || 0); pulled += rows.length;
      carry = res.deferredRows || [];
    }
    // Accept "0" as a real cursor value (a counter can legitimately be 0).
    const pageCursor = (r && r.cursor != null && r.cursor !== '') ? String(r.cursor) : cursor;
    more = !!(r && r.more);
    // One transaction: the cursor never moves past rows that are not either
    // applied or saved as waiting. v1.13 saved the waiting rows only when the
    // loop ended, so a crash in between lost them for good.
    const state = completeness(1, more, null, carry);
    if (!db.commitPull({ gen: ctx.gen, cursor: pageCursor, pending: carry, state })) break; // reset meanwhile
    cursor = pageCursor;
    lastPull = state; lastPullOkAt = Date.now();
    // The server sets `more` against the limit we asked for, so it stays right
    // whatever size we choose.
    if (!more) break;
    // Give the push its turn; the next cycle carries on from this cursor. Not
    // while orphans are waiting for their parent, though: during a catch-up
    // the parent is usually a page or two away, and stopping here would park
    // full x-ray images in the pending buffer instead of applying them.
    if (Date.now() - started > PULL_TIME_BUDGET_MS && !carry.length) break;
  }
  return { pulled, applied, deleted: removed, again: false };
}

// What a pull knows about how complete this laptop is, kept on disk with the
// cursor so the Finish guard can use it even after the network has gone.
function completeness(proto, behind, r, carry) {
  const x = r && r.lanes && r.lanes.x;
  // The other stations' reports come only with the new protocol. A page pulled
  // the old way keeps the last ones for ten minutes (a passing fallback), and
  // after that has none — which the Finish guard then says, rather than read
  // "no reports" as "nothing outstanding".
  let peers = [], peersAt = null;
  if (r && Array.isArray(r.peers)) { peers = r.peers.slice(0, 200); peersAt = Date.now(); }
  else {
    const prev = lastPull || db.getSyncState();
    if (prev && prev.peersAt && Date.now() - prev.peersAt < PEERS_KEEP_MS) { peers = prev.peers || []; peersAt = prev.peersAt; }
  }
  return {
    at: new Date().toISOString(), proto, behind: !!behind,
    imagesBehind: x && x.more ? Number(x.left) || 0 : 0,
    imagesBehindExact: x ? x.left_exact !== false : true,
    orphans: carry.length,
    orphanXrays: carry.filter((row) => row.entity === 'xray').length,
    peers, peersAt,
  };
}
const PEERS_KEEP_MS = 10 * 60 * 1000;

// Is this a page in the new protocol, and a sane one? A lane cursor that went
// BACKWARDS, or past the server's own counter, means something is wrong on the
// server: apply nothing from it.
function isV2(r, sent) {
  if (!r || r.ok !== true || r.proto !== 2 || !Array.isArray(r.rows) || !isSeq(r.head) || !r.lanes) return false;
  for (const L of LANES) {
    const l = r.lanes[L];
    if (!l || !isSeq(l.cursor) || Number(l.cursor) < Number(sent[L])) return false;
    if (!r.reset && Number(l.cursor) > Number(r.head)) return false;
  }
  return true;
}

// The server did not answer in the new protocol. An older server answers the
// probe with an ordinary empty page: believe it straight away, and ask again
// in ten minutes (the clinic may paste the new server in at any time). Anything
// else — an error from a new server — needs three in a row.
function noteV2Failure(body) {
  if (body && body.ok === true && body.proto === undefined) { v2Fails = 0; serverProto = 1; protoRetryAt = Date.now() + PROTO_RETRY_MS; return; }
  v2Fails++;
  if (v2Fails >= 3) { v2Fails = 0; serverProto = 1; protoRetryAt = Date.now() + PROTO_RETRY_MS; }
}

// The clinic database behind this address is not the one this laptop's place
// in the queue came from: start again from nothing, and send everything this
// laptop holds, since the new database may have none of it.
function newDatabase() {
  db.startOver();
  db.unmarkResendXrays(XRAY_UNMARK_PER_CYCLE);
  rotateEchoToken();
  forgetPullState();
}
// X-rays to send again are recorded in a side table, which older versions of
// the app do not read; they decide by the "sent" mark on the image row. So the
// marks are also cleared, a few dozen images per cycle — clearing them all at
// once rewrote every image in the clinic in one go — and a laptop put back on
// an older version still sends them.
const XRAY_UNMARK_PER_CYCLE = 40;
// What the last pull said about how complete this laptop is no longer holds
// after a reset. Kept, it told the Finish guard "caught up and reachable" until
// the first page after the reset arrived.
function forgetPullState() { lastPull = null; lastPullOkAt = 0; }

async function pullV2(base, key, ctx) {
  let lanes = db.getSyncLanes();
  if (!lanes) return 'legacy'; // still on the old timestamp cursor
  const knownInstance = db.getSetting('cloud_server_instance') || '';
  let carry = db.getSyncPending();
  let carryTried = false;
  let pulled = 0, applied = 0, removed = 0, guard = 0, pages = 0, again = false;
  const started = Date.now();
  const who = String(os.hostname() || '').slice(0, 60);
  for (;;) {
    if (guard++ > 500) break;
    const q = new URLSearchParams({
      proto: '2', since: PROBE_SINCE, limit: '1',
      since_e: String(lanes.e), since_p: String(lanes.p), since_k: String(lanes.k), since_x: String(lanes.x),
      rows: '1000', max_bytes: String(Math.round(pullBytes)),
      origin: echoToken, echo_min: String(echoMin),
      device: ctx.deviceId, backlog: JSON.stringify({ c: backlog.c, x: backlog.x, b: backlog.b, t: backlog.t || 0, w: who, e: activeEventUid() }),
    });
    const info = {};
    let r;
    try {
      r = await httpJson('GET', base + '/v1/pull?' + q.toString(), key, null, info);
    } catch (e) {
      if (db.syncGen() !== ctx.gen) throw e; // a reset meanwhile: learn nothing from the old server
      if (isTimeout(e)) { pullBytes = Math.max(PULL_BYTES_MIN, Math.floor(pullBytes / 2)); throw e; }
      if (!e.status) throw e; // offline: not a protocol question
      if (e.status >= 500) pullBytes = Math.max(PULL_BYTES_MIN, Math.floor(pullBytes / 2));
      noteV2Failure(e.body);
      // Nothing from this page was applied. Fall back to the old protocol for
      // the rest of this cycle — unless pages already came in, in which case
      // stop here and let the next cycle carry on.
      if (pages) throw e;
      return 'legacy';
    }
    // A reset while this page was on its way (see pullLegacy): apply nothing,
    // and take nothing about the server from it either.
    if (db.syncGen() !== ctx.gen) break;
    if (!isV2(r, lanes)) {
      noteV2Failure(r);
      if (pages) throw new Error('The clinic cloud sent a page this laptop could not use. It will try again.');
      return 'legacy';
    }
    serverProto = 2; v2Fails = 0;
    pages++;
    if (r.reset === 'cursor_ahead' || (r.instance && knownInstance && r.instance !== knownInstance)) {
      newDatabase();
      return { pulled, applied, deleted: removed, again: true };
    }
    // Our own uploads come back as stubs. Accept a page of them only if every
    // one is already here exactly as the server holds it; otherwise ask again
    // for full copies of the whole range.
    const stubs = r.rows.filter((row) => row.own === 1);
    if (stubs.length && db.echoMissing(stubs).length) {
      echoMin = Math.max(echoMin, ...LANES.map((L) => Number(r.lanes[L].cursor)));
      continue;
    }
    const rows = stubs.length ? r.rows.filter((row) => row.own !== 1) : r.rows;
    // A waiting row is freed only by its parent, and parents travel in lanes
    // e (clinics) and p (patients). So waiting rows are retried once a cycle and
    // then only on pages that brought some of those — not re-applied and
    // re-hashed on every page of an image download.
    const retryCarry = carry.length > 0 && (!carryTried || rows.some((row) => row.lane === 'e' || row.lane === 'p'));
    if (retryCarry) carryTried = true;
    const batch = retryCarry ? carry.concat(rows) : rows;
    let pageApplied = 0;
    if (batch.length) {
      const res = db.applyRemoteRows(batch);
      pageApplied = res.applied;
      applied += res.applied; removed += (res.deleted || 0);
      carry = retryCarry ? (res.deferredRows || []) : carry.concat(res.deferredRows || []);
    }
    pulled += rows.length;
    const next = {};
    for (const L of LANES) next[L] = Number(r.lanes[L].cursor);
    const state = completeness(2, r.more, r, carry);
    if (!db.commitPull({ gen: ctx.gen, lanes: next, pending: carry, instance: r.instance || null, state })) break; // reset meanwhile
    lanes = next;
    lastPull = state; lastPullOkAt = Date.now();
    // Let the screens update while a long catch-up is still running.
    if (pageApplied && Date.now() - lastNotify > NOTIFY_THROTTLE_MS) {
      lastResult = { ...lastResult, pulled, applied, deleted: removed };
      notifyRenderer();
    }
    // Size the next page from how fast this link actually is.
    if (info.bytes >= 65536 && info.ms > 0) {
      const bps = info.bytes / (info.ms / 1000);
      rateBps = rateBps ? 0.7 * rateBps + 0.3 * bps : bps;
      pullBytes = Math.min(PULL_BYTES_CAP, Math.max(PULL_BYTES_FLOOR, rateBps * PAGE_TARGET_MS / 1000));
    }
    if (!r.more) break;
    const elapsed = Date.now() - started;
    // Give the push its turn, as v1.13 did — and when only images are left,
    // much sooner, so a laptop downloading a backlog of x-rays still sends its
    // own check-outs every few seconds. (v1.13 would not stop while rows waited
    // for a parent, because the parent was usually a page or two away. With
    // parents first it is not on its way at all, and one row that can never be
    // applied held this laptop's check-outs behind the whole image download.)
    const onlyImages = !r.lanes.e.more && !r.lanes.p.more && !r.lanes.k.more && r.lanes.x.more;
    if (elapsed > PULL_TIME_BUDGET_MS || (onlyImages && elapsed >= IMAGE_SLICE_MS)) { again = true; break; }
  }
  return { pulled, applied, deleted: removed, again };
}

// One full push+pull cycle. Never throws — records status instead.
async function syncOnce() {
  const meta = db.getSyncMeta();
  if (!meta.enabled || !meta.url || !meta.key) return { ok: false, skipped: true };
  if (running) return { ok: false, busy: true };
  running = true;
  const base = trimUrl(meta.url);
  const deviceId = db.ensureDeviceId();
  // Captured once. A reset while this cycle is in flight changes it, and then
  // nothing this cycle learned is saved over the reset.
  const ctx = { gen: db.syncGen(), deviceId };
  try { db.unmarkResendXrays(XRAY_UNMARK_PER_CYCLE); } catch (_e) { /* next cycle */ }
  // Push and pull fail separately. A failed push used to skip the pull, so the
  // laptop busy uploading x-rays was exactly the one that stopped hearing about
  // everyone else's check-outs. Applying rows is last-write-wins, so pulling
  // while our own push is unfinished is safe.
  let pushed = 0, pushMore = false, pushNote = null, pushError = null, again = false;
  try {
    const p = await pushOnce(base, meta.key, deviceId, ctx);
    pushed = p.pushed; pushMore = p.more; pushNote = p.note;
  } catch (e) { pushError = e; }
  try {
    const { pulled, applied, deleted, again: pullAgain } = await pullOnce(base, meta.key, ctx);
    lastResult = { pushed, pulled, applied, deleted };
    if (applied > 0) notifyRenderer();
    if (pushError) {
      db.setSyncMeta({ lastError: pushError.message || String(pushError) });
      // The download worked: this laptop has what the cloud has. Only its own
      // upload failed (pushFailed), and what it holds is in its own export.
      return { ok: false, pushFailed: true, error: pushError.message || String(pushError), pushed, pulled, applied, deleted };
    }
    // Still catching up, or more of our own to send: go again straight away
    // rather than four seconds from now.
    again = !!(pullAgain || pushMore);
    // (A server's note about a partial upload or a refused row is not an
    // error: the rest is on its way, and refused rows have their own count.)
    void pushNote;
    db.setSyncMeta({ lastOk: new Date().toISOString(), lastError: '' });
    return { ok: true, pushed, pulled, applied, deleted, again };
  } catch (e) {
    const pullMsg = e.message || String(e);
    const pushMsg = pushError ? (pushError.message || String(pushError)) : '';
    const msg = pushMsg && pushMsg !== pullMsg ? `${pushMsg} · ${pullMsg}` : pullMsg;
    db.setSyncMeta({ lastError: msg });
    return { ok: false, pullFailed: true, error: msg };
  } finally {
    running = false;
    if (again && timer && !againTimer) {
      againTimer = setTimeout(() => { againTimer = null; syncOnce(); }, 250);
      if (againTimer.unref) againTimer.unref();
    }
  }
}

// Tell the renderer fresh data arrived so open views can refresh.
function notifyRenderer() {
  try {
    const win = getWindow && getWindow();
    if (win && win.webContents) win.webContents.send('cloud:changed', { at: new Date().toISOString(), ...lastResult });
  } catch { /* ignore */ }
}

function status() {
  const m = db.getSyncMeta();
  const st = lastPull || db.getSyncState();
  return {
    enabled: m.enabled, mode: m.mode, online: m.mode === 'online',
    url: m.url, hasKey: !!m.key, usingDefaultCloud: m.usingDefaultCloud,
    deviceId: m.deviceId, cursor: m.cursor,
    lastOk: m.lastOk, lastPush: m.lastPush, lastError: m.lastError,
    running, ...lastResult, xraysTooBig,
    // v1.14.0
    protocol: serverProto === 2 ? 'lanes' : serverProto === 1 ? 'single' : 'unknown',
    reachable: Date.now() - lastPullOkAt < REACHABLE_MS,
    caughtUp: st ? !st.behind : null,
    imagesBehind: st ? st.imagesBehind || 0 : 0,
    imagesBehindExact: st ? st.imagesBehindExact !== false : true,
    orphans: st ? st.orphans || 0 : 0,
    orphansWarn: !!(st && st.orphans >= db.PENDING_WARN),
    rowsRefused: Object.keys(db.getRefused()).length,
    toSend: { clinical: backlog.c, xrays: backlog.x, bytes: backlog.b },
    // Only the stations that still hold something: the full list (with when
    // each was last heard from) is for the Finish guard.
    peers: ((st && st.peers) || []).filter((p) => p.clinical > 0 || p.xrays > 0 || p.stuck > 0),
  };
}

// How complete this laptop's copy of the clinic is — what the Finish and
// Delete guards in ipc.js decide on. A laptop that cannot reach the cloud
// answers from what the last good pull saved.
function syncCompleteness() {
  const m = db.getSyncMeta();
  const st = lastPull || db.getSyncState();
  const pending = db.pendingCounts();
  return {
    online: !!m.enabled,
    reachable: Date.now() - lastPullOkAt < REACHABLE_MS,
    lastContactAt: st ? st.at : null,
    // Never heard from the cloud at all: assume the worst.
    behind: st ? !!st.behind : true,
    imagesBehind: st ? st.imagesBehind || 0 : 0,
    imagesBehindExact: st ? st.imagesBehindExact !== false : true,
    orphans: pending.rows,
    orphanXrays: pending.xrays,
    peers: (st && st.peers) || [],
    // When those reports were received, by this laptop's clock: a report's age
    // is the server's measure at that moment plus the time since.
    peersAt: (st && st.peersAt) || null,
    proto: st ? st.proto : null,
  };
}

function applyConfig({ url, key, enabled, mode, online }) {
  const before = trimUrl(db.getSyncMeta().url);
  const wasOnline = db.getSyncMeta().enabled;
  const goingOffline = wasOnline && (mode === 'offline' || online === false || enabled === false);
  if (goingOffline) signOff().catch(() => {}); // sent with the settings still online
  const patch = {};
  if (url !== undefined) patch.url = trimUrl(url);
  if (key !== undefined) patch.key = key;
  // Accept mode ('online'|'offline'), an `online` boolean, or legacy `enabled`.
  if (mode !== undefined) patch.mode = mode === 'offline' ? 'offline' : 'online';
  else if (online !== undefined) patch.mode = online ? 'online' : 'offline';
  else if (enabled !== undefined) patch.mode = enabled ? 'online' : 'offline';
  db.ensureDeviceId();
  db.setSyncMeta(patch);
  // A different server. This laptop's place in the old one's queue means
  // nothing there, and the new one may hold none of this laptop's records, so
  // start over in both directions. (v1.13 kept the old cursor, and never sent
  // the new server anything already sent to the old one.)
  if (trimUrl(db.getSyncMeta().url) !== before) {
    newDatabase();
    serverProto = 0; v2Fails = 0; protoRetryAt = 0;
  }
  restartTimer();
  return status();
}

function restartTimer() {
  if (timer) { clearInterval(timer); timer = null; }
  if (againTimer) { clearTimeout(againTimer); againTimer = null; }
  const m = db.getSyncMeta();
  if (m.enabled && m.url && m.key) {
    // Kick one immediately, then on an interval.
    syncOnce();
    timer = setInterval(syncOnce, INTERVAL_MS);
    if (timer.unref) timer.unref();
  }
}

function start(windowGetter) {
  getWindow = windowGetter || (() => null);
  restartTimer();
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (againTimer) { clearTimeout(againTimer); againTimer = null; }
}

// Forget this station's place in the queue and re-read everything on the next
// sync — the fix when a laptop is missing patients the other laptops can see.
async function resyncAll() {
  // A cycle already running would carry on from the OLD cursor and could save
  // it back over the reset. Let it finish first. Cycles can now legitimately
  // take a while on a slow link, so this waits up to two minutes.
  // (Since v1.14.0 a cycle that outlasts the wait cannot save over the reset
  // either: the reset changes the sync generation it checks before saving.)
  for (let i = 0; running && i < 240; i++) await new Promise((r) => setTimeout(r, 500));
  rotateEchoToken();
  db.resetSyncCursor();
  forgetPullState();
  const r = await syncOnce();
  return { ok: true, ...r };
}

// For the tests: the adaptive sizes, and a way to put them back.
function _tuning() {
  return { xrayBatchBytes, pullLimit, httpTimeoutMs: HTTP_TIMEOUT_MS, pullBytes, serverProto, protoRetryAt, v2Fails, echoMin, echoToken, clinicalMax, serverMaxRows };
}
function _resetTuning() {
  xrayBatchBytes = XRAY_BATCH_MAX; pullLimit = PULL_FIRST_LIMIT; clinicalMax = PULL_LIMIT;
  pullBytes = PULL_BYTES_INIT; rateBps = 0; serverProto = 0; protoRetryAt = 0; v2Fails = 0;
  serverMaxRows = PULL_LIMIT; serverRowsUntil = 0; clinicalCeiling = null; xrayCeiling = null; lastPull = null; lastPullOkAt = 0;
}

module.exports = {
  start, stop, syncOnce, resyncAll, testConnection, status, applyConfig, normalizeUrl: trimUrl,
  syncCompleteness, rotateEchoToken, signOff, _tuning, _resetTuning,
};
