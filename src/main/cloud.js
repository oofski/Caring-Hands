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

function trimUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

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

async function pullOnce(base, key) {
  let cursor = db.getSyncMeta().cursor || '';
  let pulled = 0, applied = 0, guard = 0;
  // Follow `more` pages so a first sync catches up fully.
  for (;;) {
    if (guard++ > 50) break;
    const qs = `?since=${encodeURIComponent(cursor)}&limit=${PULL_LIMIT}`;
    const r = await httpJson('GET', base + '/v1/pull' + qs, key);
    const rows = (r && r.rows) || [];
    if (rows.length) {
      const res = db.applyRemoteRows(rows);
      applied += res.applied; pulled += rows.length;
    }
    if (r && r.cursor && r.cursor !== cursor) { cursor = r.cursor; db.setSyncMeta({ cursor }); }
    if (!r || !r.more) break;
  }
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
    enabled: m.enabled, url: m.url, hasKey: !!m.key,
    deviceId: m.deviceId, cursor: m.cursor,
    lastOk: m.lastOk, lastPush: m.lastPush, lastError: m.lastError,
    running, ...lastResult,
  };
}

function applyConfig({ url, key, enabled }) {
  const patch = {};
  if (url !== undefined) patch.url = trimUrl(url);
  if (key !== undefined) patch.key = key;
  if (enabled !== undefined) patch.enabled = !!enabled;
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

module.exports = { start, stop, syncOnce, testConnection, status, applyConfig };
