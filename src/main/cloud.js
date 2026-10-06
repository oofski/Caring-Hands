'use strict';

// v1.1.0 — Cloud sync engine (main process). Drives the row-level sync in db.js
// against the Cloudflare Worker (see cloud/SYNC_CONTRACT.md). Offline-first:
// nothing runs unless an admin has entered a URL + key and enabled sync. All
// network failures are swallowed into a status field so the app keeps working.

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

let timer = null;
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

async function httpJson(method, url, key, body, info) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = 'Bearer ' + key;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    let text = '';
    try { text = await res.text(); } catch (e) {
      // The body timed out half-way. This used to be swallowed and returned as
      // an empty success: no rows, cursor unmoved, error cleared, badge green.
      if (controller.signal.aborted) {
        const err = new Error('The clinic cloud took too long to answer.');
        err.timeout = true; throw err;
      }
      throw new Error('The connection to the clinic cloud dropped part-way through. It will try again.');
    }
    if (info) info.bytes = text.length;
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!res.ok) {
      const msg = (json && json.error) || `HTTP ${res.status}`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return json || {};
  } catch (e) {
    if (controller.signal.aborted && !e.timeout) {
      const err = new Error('The clinic cloud took too long to answer.');
      err.timeout = true; throw err;
    }
    throw e;
  } finally { clearTimeout(to); }
}

// Verify a URL + key: /health must be reachable, and the key must authorize a pull.
async function testConnection(url, key) {
  const base = trimUrl(url);
  if (!base) throw new Error('Enter the Cloud URL first.');
  const health = await httpJson('GET', base + '/health', null);
  if (!health || health.ok !== true) throw new Error('That URL did not return a Caring Hands sync server.');
  // Key check — a bad key returns 401.
  await httpJson('GET', base + '/v1/pull?since=&limit=1', key);
  return { ok: true, service: health.service, version: health.version, time: health.time };
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
async function pushOnce(base, key, deviceId) {
  let pushed = 0;
  const clinical = db.collectSyncRows(clinicalMax, { skip: ['xray'] });
  if (clinical.rows.length) {
    try {
      const r = await httpJson('POST', base + '/v1/push', key, { device_id: deviceId, rows: clinical.rows });
      if (r && r.ok) { db.markSynced(clinical.mark); db.setSyncMeta({ lastPush: new Date().toISOString() }); }
      pushed += clinical.rows.length;
      if (clinical.rows.length >= clinicalMax) clinicalMax = Math.min(PULL_LIMIT, clinicalMax * 2);
    } catch (e) {
      if (isTimeout(e)) clinicalMax = Math.max(1, Math.floor(clinicalMax / 2));
      throw e;
    }
    // More clinical rows still waiting? They go first, next cycle. (Asking for
    // one row is a peek: collecting only stamps a row whose content changed,
    // exactly as the real collect next cycle would.)
    if (db.collectSyncRows(1, { skip: ['xray'] }).rows.length) return pushed;
  }
  const xr = db.collectSyncRows(PULL_LIMIT, { only: ['xray'], tombstones: false, xrayBytes: xrayBatchBytes });
  xraysTooBig = xr.xraysTooBig || 0;
  if (xr.rows.length) {
    try {
      const r = await httpJson('POST', base + '/v1/push', key, { device_id: deviceId, rows: xr.rows });
      if (r && r.ok) { db.markSynced(xr.mark); db.setSyncMeta({ lastPush: new Date().toISOString() }); }
      pushed += xr.rows.length;
      // It fitted. Only grow if the budget was actually what limited it: a
      // one-small-image push says nothing about whether a bigger one would fit,
      // and growing on it swung a marginal link back into a timeout.
      const sent = xr.rows.reduce((n, row) => n + String((row.data && row.data.image_png) || '').length, 0);
      if (sent >= xrayBatchBytes / 2) xrayBatchBytes = Math.min(XRAY_BATCH_MAX, Math.round(xrayBatchBytes * 1.5));
    } catch (e) {
      // Too big for this link: send less next time rather than the identical
      // batch again. Down to a single image, which always goes.
      if (isTimeout(e)) xrayBatchBytes = Math.max(XRAY_BATCH_MIN, Math.floor(xrayBatchBytes / 2));
      throw e;
    }
  }
  return pushed;
}

// A cursor is either the server's delivery counter (a plain number, v1.5.0+
// servers) or the old timestamp stamp. Only the counter is safe: it cannot skip
// a row that reaches the cloud late (an offline check-in, or a laptop whose
// clock is behind).
const isSeqCursor = (c) => /^\d+$/.test(String(c || ''));

async function pullOnce(base, key) {
  let cursor = db.getSyncMeta().cursor || '';
  // Still on a timestamp cursor? Ask whether this server now delivers by
  // counter, and if so restart from the beginning ONCE. That both switches this
  // station over and re-reads anything the old timestamp cursor stepped past.
  if (cursor && !isSeqCursor(cursor)) {
    let health = null;
    try { health = await httpJson('GET', base + '/health', null); } catch { /* offline / older server */ }
    if (health && health.seq === true) { cursor = ''; db.setSyncMeta({ cursor }); }
  }
  let pulled = 0, applied = 0, removed = 0, guard = 0;
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
  // try/finally, because the cursor is saved after EVERY page but the orphans
  // carried between pages were only saved when the loop ended normally. A page
  // that failed — and since v1.13.0 a timeout fails instead of being swallowed —
  // dropped every orphan collected so far while the cursor had already moved
  // past them for good. Reproduced: a patient arrived on another laptop as
  // "triaged" with NO vitals and NO blood-thinner flag.
  try {
  for (;;) {
    if (guard++ > 500) break;
    const qs = `?since=${encodeURIComponent(cursor)}&limit=${pullLimit}`;
    const info = {};
    let r;
    try {
      r = await httpJson('GET', base + '/v1/pull' + qs, key, null, info);
    } catch (e) {
      // A page too heavy for this link: ask for half as many rows next time.
      // It used to ask for the identical 400-row page again, forever.
      if (isTimeout(e)) pullLimit = Math.max(1, Math.floor(pullLimit / 2));
      throw e;
    }
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
    if (pageCursor !== cursor) { cursor = pageCursor; db.setSyncMeta({ cursor }); }
    // The server sets `more` against the limit we asked for, so it stays right
    // whatever size we choose.
    if (!r || !r.more) break;
    // Give the push its turn; the next cycle carries on from this cursor. Not
    // while orphans are waiting for their parent, though: during a catch-up
    // the parent is usually a page or two away, and stopping here would park
    // full x-ray images in the pending buffer instead of applying them.
    if (Date.now() - started > PULL_TIME_BUDGET_MS && !carry.length) break;
  }
  } finally {
    // Park still-unresolved orphans for the next cycle (bounded, persisted) —
    // on the way out of a failure as much as of a success.
    db.setSyncPending(carry);
  }
  return { pulled, applied, deleted: removed };
}

// One full push+pull cycle. Never throws — records status instead.
async function syncOnce() {
  const meta = db.getSyncMeta();
  if (!meta.enabled || !meta.url || !meta.key) return { ok: false, skipped: true };
  if (running) return { ok: false, busy: true };
  running = true;
  const base = trimUrl(meta.url);
  const deviceId = db.ensureDeviceId();
  // Push and pull fail separately. A failed push used to skip the pull, so the
  // laptop busy uploading x-rays was exactly the one that stopped hearing about
  // everyone else's check-outs. Applying rows is last-write-wins, so pulling
  // while our own push is unfinished is safe.
  let pushed = 0, pushError = null;
  try {
    pushed = await pushOnce(base, meta.key, deviceId);
  } catch (e) { pushError = e; }
  try {
    const { pulled, applied, deleted } = await pullOnce(base, meta.key);
    lastResult = { pushed, pulled, applied, deleted };
    if (applied > 0) notifyRenderer();
    if (pushError) {
      db.setSyncMeta({ lastError: pushError.message || String(pushError) });
      return { ok: false, error: pushError.message || String(pushError), pushed, pulled, applied, deleted };
    }
    db.setSyncMeta({ lastOk: new Date().toISOString(), lastError: '' });
    return { ok: true, pushed, pulled, applied, deleted };
  } catch (e) {
    const msg = (pushError ? (pushError.message || String(pushError)) + ' · ' : '') + (e.message || String(e));
    db.setSyncMeta({ lastError: msg });
    return { ok: false, error: msg };
  } finally {
    running = false;
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
  return {
    enabled: m.enabled, mode: m.mode, online: m.mode === 'online',
    url: m.url, hasKey: !!m.key, usingDefaultCloud: m.usingDefaultCloud,
    deviceId: m.deviceId, cursor: m.cursor,
    lastOk: m.lastOk, lastPush: m.lastPush, lastError: m.lastError,
    running, ...lastResult, xraysTooBig,
  };
}

function applyConfig({ url, key, enabled, mode, online }) {
  const patch = {};
  if (url !== undefined) patch.url = trimUrl(url);
  if (key !== undefined) patch.key = key;
  // Accept mode ('online'|'offline'), an `online` boolean, or legacy `enabled`.
  if (mode !== undefined) patch.mode = mode === 'offline' ? 'offline' : 'online';
  else if (online !== undefined) patch.mode = online ? 'online' : 'offline';
  else if (enabled !== undefined) patch.mode = enabled ? 'online' : 'offline';
  db.ensureDeviceId();
  db.setSyncMeta(patch);
  restartTimer();
  return status();
}

function restartTimer() {
  if (timer) { clearInterval(timer); timer = null; }
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
function stop() { if (timer) { clearInterval(timer); timer = null; } }

// Forget this station's place in the queue and re-read everything on the next
// sync — the fix when a laptop is missing patients the other laptops can see.
async function resyncAll() {
  // A cycle already running would carry on from the OLD cursor and could save
  // it back over the reset. Let it finish first. Cycles can now legitimately
  // take a while on a slow link, so this waits up to two minutes.
  for (let i = 0; running && i < 240; i++) await new Promise((r) => setTimeout(r, 500));
  db.resetSyncCursor();
  const r = await syncOnce();
  return { ok: true, ...r };
}

// For the tests: the adaptive sizes, and a way to put them back.
function _tuning() { return { xrayBatchBytes, pullLimit, httpTimeoutMs: HTTP_TIMEOUT_MS }; }
function _resetTuning() { xrayBatchBytes = XRAY_BATCH_MAX; pullLimit = PULL_FIRST_LIMIT; clinicalMax = PULL_LIMIT; }

module.exports = { start, stop, syncOnce, resyncAll, testConnection, status, applyConfig, normalizeUrl: trimUrl, _tuning, _resetTuning };
