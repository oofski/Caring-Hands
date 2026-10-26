// A Cloudflare D1 stand-in backed by REAL SQLite (better-sqlite3).
//
// The worker's test suite used to run against a fake that pattern-matched the
// exact SQL strings worker.js happened to send. That made every new query a
// test-infrastructure change, and — worse — a fake can agree with SQL that the
// real database would reject. This runs the worker's actual SQL on an actual
// SQLite engine, so indexes, ALTER TABLE, ON CONFLICT ... RETURNING, LIMIT and
// ORDER BY behave as they do in D1 (which is SQLite).
//
// It also models the D1 / Workers limits that have bitten this app, so a test
// or the sync rig can reproduce them instead of guessing:
//   maxValueBytes   — a string/blob value or an inserted row over this many
//                     bytes fails with SQLITE_TOOBIG (D1: ~2,000,000)
//   maxBoundParams  — more bound parameters than this fails (D1: 100)
//   maxQueries      — more statements than this in one request fails, like the
//                     Workers per-invocation limit (call newRequest() per request)
//   latencyMs       — added to every statement, to model a slow D1
//   jitterMs        — random extra delay, so concurrent calls can overtake
//
// The API is the subset worker.js uses: prepare(sql).bind(...).first() /
// .all() / .run(), batch([stmts]) and exec(sql).

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byteLength = (v) => (typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : (v && v.byteLength) || 0);

export function makeD1(opts = {}) {
  const db = new Database(opts.file || ':memory:');
  db.pragma('journal_mode = WAL');
  const limits = {
    maxValueBytes: opts.maxValueBytes || 0,
    maxBoundParams: opts.maxBoundParams || 0,
    maxQueries: opts.maxQueries || 0,
    latencyMs: opts.latencyMs || 0,
    // Random extra delay per statement. Real D1 calls do not finish in the order
    // they started; without jitter two writers' calls could never overtake each
    // other, and a race between them could never be observed.
    jitterMs: opts.jitterMs || 0,
  };
  const delay = () => (limits.latencyMs || limits.jitterMs ? sleep(limits.latencyMs + Math.random() * limits.jitterMs) : null);
  let queries = 0;      // in the current request
  let totalQueries = 0; // ever
  // Fault injection, for tests that must prove nothing is lost when D1 fails:
  //   failBatches   — the next N batches throw failBatchMessage (nothing commits)
  //   failWritesWith — every INSERT/UPDATE throws this (e.g. a full database)
  //   beforeBatch   — called with the batch's SQL before it runs; may write
  //   failSql       — { re, message, times }: the next `times` statements whose
  //                   SQL matches `re` throw `message`
  const faults = { failBatches: 0, failBatchMessage: 'D1_ERROR: network connection lost', failWritesWith: null, beforeBatch: null, failSql: null };

  function normalise(args) {
    return args.map((a) => {
      // D1 refuses undefined outright; better-sqlite3 refuses booleans. D1
      // stores booleans as 1/0, so do the same.
      if (a === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'');
      if (a === true) return 1;
      if (a === false) return 0;
      return a;
    });
  }

  function checkLimits(sql, binds) {
    queries++; totalQueries++;
    if (faults.failWritesWith && /^\s*(INSERT|REPLACE|UPDATE)/i.test(sql)) throw new Error(faults.failWritesWith);
    if (faults.failSql && faults.failSql.times > 0 && faults.failSql.re.test(sql)) { faults.failSql.times--; throw new Error(faults.failSql.message); }
    if (limits.maxQueries && queries > limits.maxQueries) {
      throw new Error('Too many API requests by single worker invocation.');
    }
    if (limits.maxBoundParams && binds.length > limits.maxBoundParams) {
      throw new Error('D1_ERROR: too many SQL variables: SQLITE_ERROR');
    }
    if (limits.maxValueBytes) {
      let rowBytes = 0;
      for (const v of binds) {
        const n = byteLength(v);
        if (n > limits.maxValueBytes) throw new Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG');
        rowBytes += n;
      }
      if (/^\s*(INSERT|REPLACE|UPDATE)/i.test(sql) && rowBytes > limits.maxValueBytes) {
        throw new Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG');
      }
    }
  }

  function statement(sql, binds = []) {
    const exec = async (mode) => {
      checkLimits(sql, binds);
      await delay();
      const st = db.prepare(sql);
      const args = normalise(binds);
      if (mode === 'first') {
        if (!st.reader) { st.run(...args); return null; }
        const row = st.get(...args);
        return row === undefined ? null : row;
      }
      if (mode === 'all') {
        if (!st.reader) { const info = st.run(...args); return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } }; }
        return { results: st.all(...args), success: true, meta: {} };
      }
      // run
      if (st.reader) { const results = st.all(...args); return { results, success: true, meta: { changes: 0 } }; }
      const info = st.run(...args);
      return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
    };
    return {
      _sql: sql,
      _binds: binds,
      bind(...args) { return statement(sql, args); },
      first(col) { return exec('first').then((r) => (col && r ? r[col] : r)); },
      all() { return exec('all'); },
      run() { return exec('run'); },
      raw() { return exec('all').then((r) => r.results.map((o) => Object.values(o))); },
    };
  }

  const api = {
    prepare(sql) { return statement(sql, []); },
    // D1 runs a batch as one implicit transaction: all or nothing.
    async batch(stmts) {
      if (faults.beforeBatch) await faults.beforeBatch(stmts.map((s) => s._sql), api, stmts.map((s) => s._binds));
      if (faults.failBatches > 0) { faults.failBatches--; throw new Error(faults.failBatchMessage); }
      const out = [];
      const tx = db.transaction(() => {
        for (const s of stmts) {
          checkLimits(s._sql, s._binds);
          const st = db.prepare(s._sql);
          const args = normalise(s._binds);
          if (st.reader) out.push({ results: st.all(...args), success: true, meta: {} });
          else { const info = st.run(...args); out.push({ results: [], success: true, meta: { changes: info.changes } }); }
        }
      });
      await delay();
      tx();
      return out;
    },
    async exec(sql) { checkLimits(sql, []); db.exec(sql); return { count: 1 }; },

    // ---- test / rig hooks (not part of D1) ----
    // Call at the start of every HTTP request so maxQueries is per request.
    newRequest() { queries = 0; },
    get queriesThisRequest() { return queries; },
    get totalQueries() { return totalQueries; },
    setLimits(next) { Object.assign(limits, next || {}); },
    setFaults(next) { Object.assign(faults, next || {}); },
    // The old fake's view of the table, which the worker suite inspects:
    // uid -> row, with data still the stored JSON text.
    get _store() {
      let rows = [];
      try { rows = db.prepare('SELECT * FROM sync_rows').all(); } catch (_e) { rows = []; }
      return new Map(rows.map((r) => [r.uid, r]));
    },
    _sqlite: db,
    close() { db.close(); },
  };
  return api;
}
