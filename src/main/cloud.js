'use strict';

// v1.1.0 — Cloud sync engine (main process). Drives the row-level sync in db.js
// against the Cloudflare Worker (see cloud/SYNC_CONTRACT.md). Offline-first:
// nothing runs unless an admin has entered a URL + key and enabled sync. All
// network failures are swallowed into a status field so the app keeps working.

const db = require('./db');

const INTERVAL_MS = 4000;
const HTTP_TIMEOUT_MS = 12000;
const PULL_LIMIT = 400;

let timer = null;
let running = false;      // a sync cycle is in flight
let getWindow = () => null;
let lastResult = { pushed: 0, pulled: 0, applied: 0 };

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

async function httpJson(method, url, key, body) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = 'Bearer ' + key;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    if (!res.ok) {
      const msg = (json && json.error) || `HTTP ${res.status}`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return json || {};
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

async function pushOnce(base, key, deviceId) {
  const { rows, mark } = db.collectSyncRows(PULL_LIMIT);
  if (!rows.length) return 0;
  const r = await httpJson('POST', base + '/v1/push', key, { device_id: deviceId, rows });
  if (r && r.ok) { db.markSynced(mark); db.setSyncMeta({ lastPush: new Date().toISOString() }); }
  return rows.length;
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
  let pulled = 0, applied = 0, guard = 0;
  // Retry any previously-orphaned rows first — their parent may have arrived
  // since (e.g. a treatment that was pulled before its patient).
  let carry = db.getSyncPending();
  // Follow `more` pages so a first sync catches up fully. A child whose parent
  // lands in a later page is carried forward within the loop. The server hands
  // rows out in its own counter order, so no row is ever skipped at a page
  // boundary, so the cursor can always advance — orphans that outlive the whole
  // delta are parked in the persistent pending buffer and retried next cycle
  // (never dropped, never wedging the cursor).
  for (;;) {
    if (guard++ > 500) break;
    const qs = `?since=${encodeURIComponent(cursor)}&limit=${PULL_LIMIT}`;
    const r = await httpJson('GET', base + '/v1/pull' + qs, key);
    const rows = (r && r.rows) || [];
    const batch = carry.length ? carry.concat(rows) : rows;
    if (batch.length) {
      const res = db.applyRemoteRows(batch);
      applied += res.applied; pulled += rows.length;
      carry = res.deferredRows || [];
    }
    // Accept "0" as a real cursor value (a counter can legitimately be 0).
    const pageCursor = (r && r.cursor != null && r.cursor !== '') ? String(r.cursor) : cursor;
    if (pageCursor !== cursor) { cursor = pageCursor; db.setSyncMeta({ cursor }); }
    if (!r || !r.more) break;
  }
  // Park still-unresolved orphans for the next cycle (bounded, persisted).
  db.setSyncPending(carry);
  return { pulled, applied };
}

// One full push+pull cycle. Never throws — records status instead.
async function syncOnce() {
  const meta = db.getSyncMeta();
  if (!meta.enabled || !meta.url || !meta.key) return { ok: false, skipped: true };
  if (running) return { ok: false, busy: true };
  running = true;
  const base = trimUrl(meta.url);
  const deviceId = db.ensureDeviceId();
  try {
    const pushed = await pushOnce(base, meta.key, deviceId);
    const { pulled, applied } = await pullOnce(base, meta.key);
    db.setSyncMeta({ lastOk: new Date().toISOString(), lastError: '' });
    lastResult = { pushed, pulled, applied };
    if (applied > 0) notifyRenderer();
    return { ok: true, pushed, pulled, applied };
  } catch (e) {
    db.setSyncMeta({ lastError: e.message || String(e) });
    return { ok: false, error: e.message || String(e) };
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
    running, ...lastResult,
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
  db.resetSyncCursor();
  const r = await syncOnce();
  return { ok: true, ...r };
}

module.exports = { start, stop, syncOnce, resyncAll, testConnection, status, applyConfig, normalizeUrl: trimUrl };
