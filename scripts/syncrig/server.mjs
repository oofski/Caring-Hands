// The sync rig's server: the REAL cloud/worker.js, served over HTTP on
// 127.0.0.1, on the real-SQLite D1 stand-in, with the network made as bad as a
// clinic's can be.
//
//   - each laptop's link can be throttled separately (bytes/second, up and down)
//   - D1 limits can be imposed (row size, bound params, statements per request,
//     per-statement latency) — see cloud/d1-sqlite.mjs
//   - the next N pulls can be made to fail, to prove nothing is lost when a page
//     dies half-way through a catch-up
//
// Every request is logged with its size, time, rows and D1 statement count, so
// a scenario can assert on what actually crossed the wire.

import http from 'http';
import { pathToFileURL } from 'url';
import { makeD1 } from '../../cloud/d1-sqlite.mjs';

export const KEY = 'rig-clinic-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer({ workerPath, port = 0, d1 = {} } = {}) {
  // A query string gives every server its own module instance, so two workers
  // (old and new) can run side by side in one process.
  const load = async (p) => (await import(pathToFileURL(p).href + '?rig=' + Math.random().toString(36).slice(2))).default;
  let worker = await load(workerPath);
  const DB = makeD1(d1);
  const env = { DB, CLINIC_KEY: KEY };
  const opts = { upBps: 0, downBps: 0, links: {}, failPulls: 0, failPullsFor: null, failPullsAfter: 0 };
  const log = [];

  const linkOf = (laptop) => Object.assign({ upBps: opts.upBps, downBps: opts.downBps }, opts.links[laptop] || {});

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const laptop = req.headers['x-rig-laptop'] || '?';
    const link = linkOf(laptop);
    const entry = { laptop, method: req.method, path: '', qs: '', reqBytes: 0, respBytes: 0, ms: 0, status: 0, d1q: 0 };
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      entry.path = u.pathname; entry.qs = u.search.slice(1);
      // ---- upload, throttled ----
      const chunks = [];
      for await (const c of req) {
        chunks.push(c);
        entry.reqBytes += c.length;
        if (link.upBps) await sleep((c.length / link.upBps) * 1000);
      }
      const body = Buffer.concat(chunks);
      // ---- injected pull failure ----
      const failHere = u.pathname === '/v1/pull' && opts.failPulls > 0 && (!opts.failPullsFor || opts.failPullsFor === laptop);
      if (failHere && opts.failPullsAfter > 0) opts.failPullsAfter--; // let this many through first
      else if (failHere) {
        opts.failPulls--;
        entry.status = 500; entry.injected = true;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'injected failure' }));
        return;
      }
      // ---- the real worker ----
      DB.newRequest();
      const request = new Request('http://127.0.0.1' + req.url, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection'].includes(k))),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      const response = await worker.fetch(request, env, { waitUntil() {} });
      const text = await response.text();
      entry.status = response.status;
      entry.d1q = DB.queriesThisRequest;
      try {
        const j = JSON.parse(text);
        if (u.pathname === '/v1/pull' && j) {
          entry.rows = (j.rows || []).length; entry.more = j.more; entry.cursor = j.cursor;
          entry.entities = summarise((j.rows || []).map((r) => r.entity));
        }
        if (u.pathname === '/v1/push') {
          try {
            const pb = JSON.parse(body.toString('utf8') || '{}');
            entry.rows = (pb.rows || []).length;
            entry.entities = summarise((pb.rows || []).map((r) => r.entity));
          } catch (_e) { /* not json */ }
          if (j) { entry.applied = j.applied; entry.skipped = j.skipped; entry.error = j.error; }
        }
        if (j && j.error && !entry.error) entry.error = j.error;
      } catch (_e) { /* not json */ }
      // ---- download, throttled ----
      const out = Buffer.from(text, 'utf8');
      entry.respBytes = out.length;
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      headers['content-length'] = String(out.length);
      res.writeHead(response.status, headers);
      if (!link.downBps) { res.end(out); }
      else {
        const CHUNK = 64 * 1024;
        for (let i = 0; i < out.length; i += CHUNK) {
          if (res.destroyed) { entry.clientGone = true; break; }
          res.write(out.subarray(i, i + CHUNK));
          await sleep((Math.min(CHUNK, out.length - i) / link.downBps) * 1000);
        }
        res.end();
      }
    } catch (e) {
      entry.status = 500; entry.error = e.message;
      try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); } catch (_e) { /* gone */ }
    } finally {
      entry.ms = Date.now() - started;
      log.push(entry);
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    log,
    DB,
    setOpts(next) { Object.assign(opts, next || {}); },
    // Paste a different worker.js over the running one, keeping the database:
    // what a clinic does in the Cloudflare dashboard (and what a rollback is).
    // A fresh module instance, so it starts cold, as a new deploy does.
    async swapWorker(p) { worker = await load(p); },
    // The server's delivery counter, for cursor sanity checks.
    head() { try { return Number(DB._sqlite.prepare('SELECT v FROM sync_seq WHERE id = 1').get().v); } catch (_e) { return null; } },
    setLink(laptop, link) { opts.links[laptop] = Object.assign({}, opts.links[laptop] || {}, link); },
    clearLinks() { opts.links = {}; opts.upBps = 0; opts.downBps = 0; },
    // Fail `n` pulls from `laptop`, after letting `after` pulls through first.
    failNextPulls(n, laptop, after = 0) { opts.failPulls = n; opts.failPullsFor = laptop || null; opts.failPullsAfter = after; },
    // What the server holds for a patient, by first name (latest write wins).
    serverPatient(first) {
      for (const r of DB._store.values()) {
        if (r.entity !== 'patient' || r.deleted) continue;
        try { const d = JSON.parse(r.data); if (d.first_name === first) return d; } catch (_e) { /* skip */ }
      }
      return null;
    },
    close() { return new Promise((r) => server.close(() => { DB.close(); r(); })); },
  };
}

function summarise(list) {
  const out = [];
  let prev = null, n = 0;
  for (const e of list) {
    if (e === prev) { n++; continue; }
    if (prev) out.push(n > 1 ? `${prev}x${n}` : prev);
    prev = e; n = 1;
  }
  if (prev) out.push(n > 1 ? `${prev}x${n}` : prev);
  return out.join(' ');
}
