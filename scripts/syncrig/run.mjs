#!/usr/bin/env node
// The sync rig: real copies of the app (db.js + cloud.js, any version from git)
// syncing through the real worker (any version from git) over HTTP, on real
// SQLite, with throttled clinic-grade links and injected failures.
//
// It exists because the worst bug this app has shipped — a check-out taking 15
// minutes to reach the other laptops at a clinic with 200+ x-rays — could not
// be seen in any unit test and could only be fixed once it was reproduced.
//
//   node scripts/syncrig/run.mjs                 # every scenario, full size
//   node scripts/syncrig/run.mjs --quick         # smaller, for routine checks
//   node scripts/syncrig/run.mjs catchup poison  # just these
//   node scripts/syncrig/run.mjs --json out.json # machine-readable results
//
// HARD checks are data safety and convergence: a failure exits non-zero.
// SOFT checks are latency targets: reported, and fail the run only with
// --strict. Old versions are expected to miss some soft targets; that is the
// point of measuring them.

import { fork, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer, KEY } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const QUICK = flag('--quick');
const STRICT = flag('--strict');
const JSON_OUT = opt('--json', null);
// Run the scenarios on a given app / worker version: 'current', a name from
// VERSIONS, or any git ref (e.g. --app 921cbfa to replay an old bug).
const APP = opt('--app', 'current');
const WORKER = opt('--worker', 'current');
const WANT = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--json', '--app', '--worker'].includes(argv[i - 1])));

const MB = (b) => (b / 1048576).toFixed(1) + 'MB';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(scenario, name, ok, { hard = true, detail = '' } = {}) {
  results.push({ scenario, name, ok: !!ok, hard, detail });
  const tag = ok ? 'PASS' : (hard ? 'FAIL' : 'WARN');
  console.log(`  ${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// Versions from git: old app versions and old workers, side by side.
// ---------------------------------------------------------------------------
export const VERSIONS = {
  // app versions (src/main) — the last commit of each release
  'app-1.12.0': 'c29c6ab',
  'app-1.13.0': '1f8c3c2',
  // the worker as clinics have it deployed today (unchanged since v1.11.0)
  'worker-1.11.0': '1f8c3c2',
};
function extract(ref, files) {
  // Inside the repo so the extracted db.js finds node_modules by walking up.
  const dir = path.join(HERE, '.versions', ref);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const out = path.join(dir, path.basename(f));
    if (!fs.existsSync(out)) fs.writeFileSync(out, execFileSync('git', ['show', `${ref}:${f}`], { cwd: REPO }));
  }
  return dir;
}
const refOf = (v) => VERSIONS[v] || v;
const appSrc = (v) => (v === 'current' ? path.join(REPO, 'src/main') : extract(refOf(v), ['src/main/db.js', 'src/main/cloud.js']));
const workerPath = (v) => (v === 'current' ? path.join(REPO, 'cloud/worker.js') : path.join(extract(refOf(v), ['cloud/worker.js']), 'worker.js'));

// ---------------------------------------------------------------------------
// A fleet of laptops on one server.
// ---------------------------------------------------------------------------
async function fleet(server, spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrig-'));
  const kids = {};
  let nextId = 1;
  const pending = new Map();
  for (const [name, version] of Object.entries(spec)) {
    await new Promise((resolve, reject) => {
      const k = fork(path.join(HERE, 'laptop.cjs'), [name, path.join(root, name), server.url, KEY], {
        env: { ...process.env, RIG_SRC: appSrc(version) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      kids[name] = k;
      k.on('message', (m) => {
        if (m.ready) return resolve();
        const p = pending.get(m.id); pending.delete(m.id);
        if (!p) return;
        if (m.err) p.reject(new Error(`${name}: ${m.err}`)); else p.resolve(m.res);
      });
      k.on('exit', (c) => { if (c) reject(new Error(`${name} exited ${c}`)); });
    });
  }
  const call = (n, cmd, args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    kids[n].send({ id, cmd, args });
  });
  return {
    call,
    names: Object.keys(spec),
    async syncAll(times = 1) { for (let t = 0; t < times; t++) for (const n of Object.keys(spec)) await call(n, 'sync'); },
    // Sync `who` until `first` reads `want`. Returns cycles, ms, and how many
    // cycles reported an error (a timeout, or anything else).
    async until(who, first, want, { maxCycles = 40, maxMs = 15 * 60000 } = {}) {
      const t0 = Date.now();
      let errors = 0;
      for (let c = 1; c <= maxCycles; c++) {
        const s = await call(who, 'sync');
        if (s.r && s.r.ok === false && !s.r.busy && !s.r.skipped) errors++;
        const st = (await call(who, 'status', { first })).status;
        if (st === want) return { ok: true, cycles: c, ms: Date.now() - t0, errors };
        if (Date.now() - t0 > maxMs) break;
      }
      return { ok: false, cycles: maxCycles, ms: Date.now() - t0, errors };
    },
    async close() { for (const k of Object.values(kids)) k.kill(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// Start a clinic on the first laptop, give it patients through vitals, and get
// every laptop onto it.
async function setup(f, patients = 40) {
  const [first] = f.names;
  await f.call(first, 'makeClinic', { name: 'Rig Clinic' });
  await f.call(first, 'createPatients', { prefix: 'P', n: patients });
  await f.syncAll(2);
  for (const n of f.names) await f.call(n, 'adoptClinic');
  await f.syncAll(1);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const SCENARIOS = {};

// Laptops that are keeping up: a status change should be visible on the next
// sync of any other laptop.
SCENARIOS.baseline = async ({ worker = WORKER, app = APP } = {}) => {
  const tag = `baseline[${app} on ${worker}]`;
  console.log(`\n# ${tag}`);
  const server = await startServer({ workerPath: workerPath(worker) });
  const f = await fleet(server, { X: app, C: app, O: app });
  try {
    await setup(f, 6);
    await f.call('X', 'complete', { first: 'P01' }); await f.call('X', 'sync');
    const c = await f.until('C', 'P01', 'completed', { maxCycles: 3 });
    record(tag, 'a completed visit reaches the check-out laptop', c.ok, { detail: `${c.cycles} cycle(s), ${c.ms}ms` });
    record(tag, '...on its next sync', c.ok && c.cycles === 1, { hard: false });
    await f.call('C', 'dismiss', { first: 'P01' }); await f.call('C', 'sync');
    for (const n of ['X', 'O']) {
      const r = await f.until(n, 'P01', 'dismissed', { maxCycles: 3 });
      record(tag, `the check-out reaches ${n}`, r.ok, { detail: `${r.cycles} cycle(s), ${r.ms}ms` });
      record(tag, `...on its next sync (${n})`, r.ok && r.cycles === 1, { hard: false });
    }
  } finally { await f.close(); await server.close(); }
};

// One laptop has fallen far behind (asleep, wifi down, restarted) while the
// clinic took hundreds of x-rays. Then a patient is checked out. How long until
// that laptop sees the check-out — and does it end up with everything?
SCENARIOS.catchup = async ({ worker = WORKER, app = APP, xrays = QUICK ? 60 : 200, kb = 300, down = 20, up = 5, targetCycles = 2 } = {}) => {
  const tag = `catchup[${app} on ${worker}, ${xrays} x-rays, ${down}/${up} Mbit]`;
  console.log(`\n# ${tag}`);
  const server = await startServer({ workerPath: workerPath(worker) });
  const f = await fleet(server, { X: app, C: app, O: app });
  try {
    await setup(f, 40);
    for (let i = 0; i < xrays; i += 10) {
      await f.call('X', 'addXrays', { first: ['P01', 'P02', 'P03', 'P04', 'P05'], count: Math.min(10, xrays - i), bytes: kb * 1024 });
      await f.call('X', 'sync'); await f.call('C', 'sync');
    }
    await f.call('X', 'complete', { first: 'P39' }); await f.call('X', 'sync');
    await f.call('C', 'sync'); await f.call('C', 'dismiss', { first: 'P39' }); await f.call('C', 'sync');
    server.setOpts({ downBps: down * 125000, upBps: up * 125000 });
    const r = await f.until('O', 'P39', 'dismissed', { maxCycles: 40 });
    record(tag, 'the far-behind laptop sees the check-out', r.ok, { detail: `${r.cycles} cycle(s), ${(r.ms / 1000).toFixed(1)}s, ${r.errors} failed cycle(s)` });
    record(tag, `...within ${targetCycles} cycle(s)`, r.ok && r.cycles <= targetCycles, { hard: false, detail: `${r.cycles}` });
    server.clearLinks();
    // Convergence. First let X finish sending: on a busy chair the x-ray laptop
    // can still be uploading its own backlog, and O can only hold what the
    // server has. Then O must hold everything X holds.
    let sendCycles = 0;
    for (; sendCycles < 80 && (await f.call('X', 'dirty')).rows > 0; sendCycles++) await f.call('X', 'sync');
    record(tag, 'the x-ray laptop finishes sending its backlog', (await f.call('X', 'dirty')).rows === 0, { detail: `${sendCycles} more cycle(s) after the check-out` });
    const same = (a, b) => ['patients', 'withVitals', 'consents', 'treatments', 'xrays'].every((k) => a[k] === b[k]);
    for (let i = 0; i < 40; i++) {
      await f.call('O', 'sync');
      if (same(await f.call('X', 'counts'), await f.call('O', 'counts'))) break;
    }
    const [x, o] = [await f.call('X', 'counts'), await f.call('O', 'counts')];
    record(tag, 'the far-behind laptop then holds every patient, vital sign, consent, treatment and x-ray', same(x, o),
      { detail: `X ${JSON.stringify(x)} / O ${JSON.stringify(o)}` });
  } finally { await f.close(); await server.close(); }
};

// The laptop taking the x-rays was offline, took 60 of them, finished a visit,
// and comes back on a poor uplink. Does the finished visit get out first?
SCENARIOS.xraylaptop = async ({ worker = WORKER, app = APP, xrays = QUICK ? 30 : 60, up = 5 } = {}) => {
  const tag = `xraylaptop[${app} on ${worker}, ${xrays} x-rays, ${up} Mbit up]`;
  console.log(`\n# ${tag}`);
  const server = await startServer({ workerPath: workerPath(worker) });
  const f = await fleet(server, { X: app, C: app });
  try {
    await setup(f, 40);
    await f.call('X', 'addXrays', { first: ['P10', 'P11'], count: xrays, bytes: 300 * 1024 });
    await f.call('X', 'complete', { first: 'P37' });
    server.setLink('X', { upBps: up * 125000, downBps: 20 * 125000 });
    const s1 = await f.call('X', 'sync');
    const onServer = (server.serverPatient('P37') || {}).status;
    record(tag, 'the finished visit is on the server after the first sync', onServer === 'completed', { hard: false, detail: `${onServer}, ${s1.ms}ms` });
    let ok = onServer === 'completed';
    for (let i = 0; i < 5 && !ok; i++) { await f.call('X', 'sync'); ok = (server.serverPatient('P37') || {}).status === 'completed'; }
    record(tag, 'the finished visit reaches the server', ok);
    const c = await f.until('C', 'P37', 'completed', { maxCycles: 4 });
    record(tag, '...and the check-out laptop', c.ok, { detail: `${c.cycles} cycle(s)` });
  } finally { await f.close(); await server.close(); }
};

// An image bigger than the cloud can store, saved by an older version. It must
// not stop anything else from syncing.
SCENARIOS.poison = async ({ worker = WORKER, app = APP } = {}) => {
  const tag = `poison[${app} on ${worker}]`;
  console.log(`\n# ${tag}`);
  const server = await startServer({ workerPath: workerPath(worker), d1: { maxValueBytes: 2000000 } });
  const f = await fleet(server, { X: app, C: app });
  try {
    await setup(f, 6);
    await f.call('X', 'addLegacyXray', { first: 'P01', bytes: 1600 * 1024 });
    await f.call('X', 'addXrays', { first: 'P02', count: 3, bytes: 200 * 1024 });
    await f.call('X', 'complete', { first: 'P03' });
    for (let i = 0; i < 4; i++) await f.call('X', 'sync');
    const c = await f.until('C', 'P03', 'completed', { maxCycles: 3 });
    record(tag, 'a visit finished on the laptop holding the oversized image still reaches the others', c.ok);
    const cx = await f.call('C', 'counts');
    record(tag, 'the ordinary x-rays behind the oversized one still reach the others', cx.xrays >= 3, { detail: `C holds ${cx.xrays} x-ray(s)` });
  } finally { await f.close(); await server.close(); }
};

// A page fails half-way through a catch-up. Nothing may be lost — the v1.13.0
// review's blocker: vitals that arrived before their patient were dropped.
SCENARIOS.orphans = async ({ worker = WORKER, app = APP } = {}) => {
  const tag = `orphans[${app} on ${worker}]`;
  console.log(`\n# ${tag}`);
  const server = await startServer({ workerPath: workerPath(worker) });
  const f = await fleet(server, { X: app, O: app });
  try {
    await setup(f, 6);
    // O falls behind while the clinic runs. Patients are checked in, x-rayed,
    // treated, then CHECKED OUT — and a check-out re-sends only the patient row,
    // which the server re-sequences behind that patient's vitals, consents,
    // treatment and x-rays. So during O's catch-up every one of those children
    // arrives BEFORE its patient: orphans, carried between pages. This is the
    // ordinary shape of a clinic day, not a contrivance.
    await f.call('X', 'createPatients', { prefix: 'Q', n: 40 });
    await f.call('X', 'addXrays', { first: ['Q01', 'Q02', 'Q03'], count: 21, bytes: 120 * 1024 });
    for (let i = 0; i < 40; i++) await f.call('X', 'complete', { first: `Q${String(i).padStart(2, '0')}` });
    await f.call('X', 'sync'); await f.call('X', 'sync'); await f.call('X', 'sync');
    for (let i = 0; i < 40; i++) await f.call('X', 'dismiss', { first: `Q${String(i).padStart(2, '0')}` });
    await f.call('X', 'sync'); await f.call('X', 'sync');
    server.failNextPulls(1, 'O', 1); // the SECOND page O asks for fails
    for (let i = 0; i < 15; i++) await f.call('O', 'sync');
    const [x, o] = [await f.call('X', 'counts'), await f.call('O', 'counts')];
    const same = ['patients', 'withVitals', 'consents', 'treatments', 'xrays'].every((k) => x[k] === o[k]);
    record(tag, 'after a failed page mid-catch-up, every patient arrives with their vitals, consents, treatment and x-rays', same,
      { detail: `X ${JSON.stringify(x)} / O ${JSON.stringify(o)}` });
  } finally { await f.close(); await server.close(); }
};

// A laptop that has just pushed its own x-rays should not download them again.
SCENARIOS.echo = async ({ worker = WORKER, app = APP } = {}) => {
  const tag = `echo[${app} on ${worker}]`;
  console.log(`\n# ${tag}`);
  const server = await startServer({ workerPath: workerPath(worker) });
  const f = await fleet(server, { X: app, C: app });
  try {
    await setup(f, 6);
    await f.call('X', 'sync');
    const before = await f.call('X', 'meters');
    await f.call('X', 'addXrays', { first: 'P01', count: 20, bytes: 300 * 1024 });
    for (let i = 0; i < 6; i++) await f.call('X', 'sync');
    const after = await f.call('X', 'meters');
    const pushed = after.uploaded - before.uploaded, pulledBack = after.downloaded - before.downloaded;
    record(tag, 'the x-ray laptop does not download its own images back', pulledBack < pushed * 0.1, { hard: false, detail: `uploaded ${MB(pushed)}, downloaded ${MB(pulledBack)}` });
    const c = await f.call('C', 'counts');
    for (let i = 0; i < 8 && c.xrays < 20; i++) { await f.call('C', 'sync'); Object.assign(c, await f.call('C', 'counts')); }
    record(tag, '...while every other laptop still receives them', c.xrays >= 20, { detail: `C holds ${c.xrays}` });
  } finally { await f.close(); await server.close(); }
};

// The Workers free plan allows a limited number of D1 statements per request.
SCENARIOS.freeplan = async ({ worker = WORKER, app = APP, maxQueries = 50 } = {}) => {
  const tag = `freeplan[${app} on ${worker}, ${maxQueries} statements/request]`;
  console.log(`\n# ${tag}`);
  const server = await startServer({ workerPath: workerPath(worker) });
  const f = await fleet(server, { X: app, C: app });
  try {
    await setup(f, 4);
    server.DB.setLimits({ maxQueries });
    await f.call('X', 'createPatients', { prefix: 'F', n: 60 });
    await f.call('X', 'complete', { first: 'F59' });
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) { await f.call('X', 'sync'); ok = (server.serverPatient('F59') || {}).status === 'completed'; }
    record(tag, 'a 120-row backlog gets through within the per-request statement limit', ok, { hard: false });
  } finally { await f.close(); await server.close(); }
};

// Mixed fleets: laptops on different app versions, on the old and new worker.
SCENARIOS.compat = async () => {
  for (const worker of ['worker-1.11.0', 'current']) {
    const tag = `compat[1.12.0 + 1.13.0 + current, on ${worker}]`;
    console.log(`\n# ${tag}`);
    const server = await startServer({ workerPath: workerPath(worker) });
    const f = await fleet(server, { A: 'app-1.12.0', B: 'app-1.13.0', C: 'current' });
    try {
      await setup(f, 6);
      await f.call('A', 'complete', { first: 'P01' }); await f.call('A', 'sync');
      await f.call('B', 'addXrays', { first: 'P02', count: 3, bytes: 150 * 1024 }); await f.call('B', 'sync');
      await f.call('C', 'sync');
      await f.call('C', 'dismiss', { first: 'P01' }); await f.call('C', 'sync');
      for (const n of ['A', 'B']) {
        const r = await f.until(n, 'P01', 'dismissed', { maxCycles: 3 });
        record(tag, `${n} sees a check-out made on the current version`, r.ok, { detail: `${r.cycles} cycle(s)` });
      }
      for (const n of ['A', 'C']) {
        let got = 0;
        for (let i = 0; i < 4 && got < 3; i++) { await f.call(n, 'sync'); got = (await f.call(n, 'chart', { first: 'P02' })).xrays; }
        record(tag, `${n} receives x-rays taken on 1.13.0`, got === 3, { detail: `${got}` });
      }
      const r = await f.until('C', 'P01', 'dismissed', { maxCycles: 2 });
      record(tag, 'the current version sees its own check-out after syncing', r.ok);
    } finally { await f.close(); await server.close(); }
  }
};

// ---------------------------------------------------------------------------
const ORDER = ['baseline', 'compat', 'xraylaptop', 'catchup', 'catchup5', 'poison', 'orphans', 'echo', 'freeplan'];
SCENARIOS.catchup5 = (o = {}) => SCENARIOS.catchup({ ...o, down: 5, up: 2, targetCycles: 3 });
const chosen = WANT.length ? WANT : (QUICK ? ['baseline', 'compat', 'xraylaptop', 'catchup', 'poison', 'orphans', 'echo'] : ORDER);
const started = Date.now();
for (const s of chosen) {
  if (!SCENARIOS[s]) { console.error('unknown scenario ' + s); process.exit(2); }
  try { await SCENARIOS[s](); } catch (e) { record(s, 'scenario ran to completion', false, { detail: e.message }); }
}
const hardFails = results.filter((r) => !r.ok && r.hard);
const softFails = results.filter((r) => !r.ok && !r.hard);
console.log(`\n=== ${results.length} checks: ${results.filter((r) => r.ok).length} passed, ${hardFails.length} HARD failures, ${softFails.length} soft (latency) misses — ${((Date.now() - started) / 1000).toFixed(0)}s ===`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ results, quick: QUICK, at: new Date().toISOString() }, null, 1));
process.exit(hardFails.length || (STRICT && softFails.length) ? 1 : 0);
