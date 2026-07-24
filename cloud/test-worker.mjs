// Self-contained Node test for worker.js — no external deps.
// Exercises the Worker's default export against a tiny in-memory fake D1 that
// implements prepare().bind().run()/.all()/.first() over an array.
//
// Run: node test-worker.mjs   (exits non-zero on any failed check)

import worker from './worker.js';

const CLINIC_KEY = 'super-secret-clinic-key';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log('PASS: ' + name);
  } else {
    console.log('FAIL: ' + name);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Tiny fake D1 — recognizes exactly the SQL that worker.js issues.
// ---------------------------------------------------------------------------
function makeFakeD1() {
  const store = new Map(); // uid -> row object

  function prepare(sql) {
    return {
      _sql: sql,
      _binds: [],
      bind(...args) {
        this._binds = args;
        return this;
      },
      async first() {
        const s = this._sql;
        if (/SELECT updated_at FROM sync_rows WHERE uid = \?/.test(s)) {
          const uid = this._binds[0];
          const row = store.get(uid);
          return row ? { updated_at: row.updated_at } : null;
        }
        // Pre-registration: look up an event row by uid (must exist, not deleted).
        if (/SELECT data FROM sync_rows WHERE uid = \? AND entity = 'event' AND deleted = 0/.test(s)) {
          const uid = this._binds[0];
          const row = store.get(uid);
          return row && row.entity === 'event' && !row.deleted ? { data: row.data } : null;
        }
        throw new Error('fake D1: unsupported first() SQL: ' + s);
      },
      async run() {
        const s = this._sql;
        // Self-initializing schema DDL (CREATE TABLE/INDEX IF NOT EXISTS) — the
        // in-memory store needs no schema, so these are no-ops.
        if (/^\s*CREATE\s+(TABLE|INDEX)/i.test(s)) {
          return { success: true, meta: { changes: 0 } };
        }
        if (/INSERT OR REPLACE INTO sync_rows/.test(s)) {
          const [uid, entity, event_uid, patient_uid, deleted, updated_at, data] =
            this._binds;
          store.set(uid, {
            uid,
            entity,
            event_uid,
            patient_uid,
            deleted,
            updated_at,
            data,
          });
          return { success: true, meta: { changes: 1 } };
        }
        throw new Error('fake D1: unsupported run() SQL: ' + s);
      },
      async all() {
        const s = this._sql;
        if (/SELECT .* FROM sync_rows WHERE updated_at > \?/.test(s)) {
          const hasEvent = /event_uid = \?/.test(s);
          let since, eventUid, limit;
          if (hasEvent) {
            [since, eventUid, limit] = this._binds;
          } else {
            [since, limit] = this._binds;
          }
          let rows = Array.from(store.values()).filter(
            (r) => String(r.updated_at) > String(since)
          );
          if (hasEvent) rows = rows.filter((r) => r.event_uid === eventUid);
          rows.sort((a, b) =>
            a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0
          );
          rows = rows.slice(0, limit);
          return { results: rows.map((r) => ({ ...r })) };
        }
        throw new Error('fake D1: unsupported all() SQL: ' + s);
      },
    };
  }

  return { prepare, _store: store };
}

// ---------------------------------------------------------------------------
// Helper to invoke the worker like a real HTTP request.
// ---------------------------------------------------------------------------
async function call(env, method, path, { auth, body } = {}) {
  const headers = {};
  if (auth) headers['Authorization'] = 'Bearer ' + auth;
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const req = new Request('https://sync.example.com' + path, init);
  const res = await worker.fetch(req, env, {});
  let data = null;
  try {
    data = await res.json();
  } catch (_e) {
    data = null;
  }
  return { status: res.status, data, res };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  const env = { CLINIC_KEY, DB: makeFakeD1() };

  // --- /health (no auth) ---
  const h = await call(env, 'GET', '/health');
  check(
    '/health ok',
    h.status === 200 &&
      h.data &&
      h.data.ok === true &&
      h.data.service === 'caring-hands-sync' &&
      h.data.version === '1.2.0' &&
      typeof h.data.time === 'string'
  );

  // --- push without auth -> 401 ---
  const noAuth = await call(env, 'POST', '/v1/push', {
    body: { device_id: 'd1', rows: [] },
  });
  check(
    'push without auth -> 401',
    noAuth.status === 401 && noAuth.data && noAuth.data.ok === false
  );

  // --- push with wrong bearer -> 401 ---
  const badAuth = await call(env, 'POST', '/v1/push', {
    auth: 'not-the-key',
    body: { device_id: 'd1', rows: [] },
  });
  check('push with wrong bearer -> 401', badAuth.status === 401);

  // --- push with correct bearer -> applied count (+ 1 invalid row skipped) ---
  const rows1 = [
    {
      entity: 'event',
      uid: 'evt-1',
      event_uid: null,
      updated_at: '2026-07-04T03:00:00.000Z',
      data: { name: 'Field Day Clinic' },
    },
    {
      entity: 'patient',
      uid: 'pat-1',
      event_uid: 'evt-1',
      updated_at: '2026-07-04T03:05:00.000Z',
      data: { name: 'Alice', vitals_by_name: 'Nurse Joy' },
    },
    {
      entity: 'patient',
      uid: 'pat-2',
      event_uid: 'evt-2',
      updated_at: '2026-07-04T03:06:00.000Z',
      data: { name: 'Bob' },
    },
    // invalid: missing updated_at + data -> must be skipped
    { uid: 'bad-row', entity: 'patient' },
  ];
  const push1 = await call(env, 'POST', '/v1/push', {
    auth: CLINIC_KEY,
    body: { device_id: 'd1', rows: rows1 },
  });
  check(
    'push applied=3 skipped=1 (invalid skipped)',
    push1.status === 200 &&
      push1.data.ok === true &&
      push1.data.applied === 3 &&
      push1.data.skipped === 1 &&
      typeof push1.data.time === 'string'
  );

  // --- LWW: older updated_at is skipped ---
  const older = await call(env, 'POST', '/v1/push', {
    auth: CLINIC_KEY,
    body: {
      device_id: 'd1',
      rows: [
        {
          entity: 'patient',
          uid: 'pat-1',
          event_uid: 'evt-1',
          updated_at: '2026-07-04T02:00:00.000Z', // older than stored 03:05
          data: { name: 'Alice STALE' },
        },
      ],
    },
  });
  check(
    'LWW older updated_at skipped',
    older.data.applied === 0 && older.data.skipped === 1
  );

  // --- LWW: newer updated_at is applied ---
  const newer = await call(env, 'POST', '/v1/push', {
    auth: CLINIC_KEY,
    body: {
      device_id: 'd1',
      rows: [
        {
          entity: 'patient',
          uid: 'pat-1',
          event_uid: 'evt-1',
          updated_at: '2026-07-04T04:00:00.000Z', // newer than stored
          data: { name: 'Alice FRESH' },
        },
      ],
    },
  });
  check(
    'LWW newer updated_at applied',
    newer.data.applied === 1 && newer.data.skipped === 0
  );

  // --- pull since returns rows in asc order with a cursor ---
  const pull = await call(
    env,
    'GET',
    '/v1/pull?since=2026-07-04T00:00:00.000Z&limit=500',
    { auth: CLINIC_KEY }
  );
  const uats = pull.data.rows.map((r) => r.updated_at);
  const ascending = uats.every((v, i, a) => i === 0 || a[i - 1] <= v);
  check(
    'pull ok + 3 rows + ascending order',
    pull.status === 200 &&
      pull.data.ok === true &&
      pull.data.rows.length === 3 &&
      ascending
  );
  check(
    'pull data parsed back to objects',
    pull.data.rows.every(
      (r) => r.data && typeof r.data === 'object' && !Array.isArray(r.data)
    )
  );
  const lastUat = pull.data.rows[pull.data.rows.length - 1].updated_at;
  check(
    'pull cursor = last updated_at',
    pull.data.cursor === lastUat && lastUat === '2026-07-04T04:00:00.000Z'
  );
  check('pull more=false when limit not hit', pull.data.more === false);
  check(
    'pull reflects LWW winner (Alice FRESH)',
    pull.data.rows.find((r) => r.uid === 'pat-1').data.name === 'Alice FRESH'
  );

  // --- pull with event_uid filters ---
  const pullEvt = await call(
    env,
    'GET',
    '/v1/pull?since=2026-07-04T00:00:00.000Z&event_uid=evt-1',
    { auth: CLINIC_KEY }
  );
  check(
    'pull event_uid=evt-1 only returns that event\'s rows',
    pullEvt.data.rows.length === 1 &&
      pullEvt.data.rows[0].uid === 'pat-1' &&
      pullEvt.data.rows.every((r) => r.event_uid === 'evt-1')
  );
  check(
    'pull event_uid filter excludes evt-2 patient',
    pullEvt.data.rows.every((r) => r.uid !== 'pat-2')
  );

  // --- pull with empty result: cursor = incoming since ---
  const pullEmpty = await call(
    env,
    'GET',
    '/v1/pull?since=2030-01-01T00:00:00.000Z',
    { auth: CLINIC_KEY }
  );
  check(
    'pull empty -> cursor = since, more=false',
    pullEmpty.data.rows.length === 0 &&
      pullEmpty.data.cursor === '2030-01-01T00:00:00.000Z' &&
      pullEmpty.data.more === false
  );

  // --- pull with limit hit -> more=true ---
  const pullLim = await call(
    env,
    'GET',
    '/v1/pull?since=2026-07-04T00:00:00.000Z&limit=1',
    { auth: CLINIC_KEY }
  );
  check(
    'pull more=true when limit hit',
    pullLim.data.rows.length === 1 && pullLim.data.more === true
  );

  // --- unknown /v1 route -> 404 ---
  const notFound = await call(env, 'GET', '/v1/nope', { auth: CLINIC_KEY });
  check('unknown /v1 route -> 404', notFound.status === 404);

  // --- unknown top-level route -> 404 ---
  const notFound2 = await call(env, 'GET', '/whatever');
  check('unknown top-level route -> 404', notFound2.status === 404);

  // --- wrong method on push -> 405 ---
  const wrongMethod = await call(env, 'GET', '/v1/push', { auth: CLINIC_KEY });
  check('GET /v1/push -> 405', wrongMethod.status === 405);

  // --- wrong method on health -> 405 ---
  const healthPost = await call(env, 'POST', '/health');
  check('POST /health -> 405', healthPost.status === 405);

  // --- OPTIONS preflight -> 204 with CORS headers ---
  const opt = await call(env, 'OPTIONS', '/v1/push');
  check(
    'OPTIONS preflight -> 204 + CORS',
    opt.status === 204 &&
      opt.res.headers.get('Access-Control-Allow-Origin') === '*'
  );

  // --- CORS header present on a normal JSON response ---
  check(
    'CORS header on /health response',
    h.res.headers.get('Access-Control-Allow-Origin') === '*'
  );

  // --- push accepts data already given as a JSON string ---
  const strData = await call(env, 'POST', '/v1/push', {
    auth: CLINIC_KEY,
    body: {
      device_id: 'd1',
      rows: [
        {
          entity: 'triage',
          uid: 'tri-1',
          patient_uid: 'pat-1',
          updated_at: '2026-07-04T05:00:00.000Z',
          data: JSON.stringify({ bp: '120/80' }),
        },
      ],
    },
  });
  const pullStr = await call(
    env,
    'GET',
    '/v1/pull?since=2026-07-04T04:30:00.000Z',
    { auth: CLINIC_KEY }
  );
  const triRow = pullStr.data.rows.find((r) => r.uid === 'tri-1');
  check(
    'push string data round-trips to an object on pull',
    strData.data.applied === 1 &&
      triRow &&
      typeof triRow.data === 'object' &&
      triRow.data.bp === '120/80'
  );

  // --- Pre-registration (public /checkin) — event 'evt-1' was pushed above ---
  async function getText(path) {
    const res = await worker.fetch(new Request('https://sync.example.com' + path, { method: 'GET' }), env, {});
    return { status: res.status, ctype: res.headers.get('content-type') || '', text: await res.text() };
  }
  const formGet = await getText('/checkin/evt-1');
  check('GET /checkin/<event> serves the HTML form for that event',
    formGet.status === 200 && /text\/html/.test(formGet.ctype) && formGet.text.includes('Field Day Clinic') && /Pre-registration/i.test(formGet.text));

  const badGet = await getText('/checkin/does-not-exist');
  check('GET /checkin/<unknown> -> 404 error page', badGet.status === 404 && /not valid|not found/i.test(badGet.text));

  const preReg = await call(env, 'POST', '/checkin/evt-1', {
    body: { first_name: 'Pre', last_name: 'Reg', dob: '1990-01-02', gender: 'female', phone: '(555) 123-4567', language: 'es', reason: 'tooth hurts', visit_type: 'filling', allergies: ['penicillin', 'other'], allergies_other: 'shellfish', conditions: ['diabetes'], medications: ['Metformin', 'Lisinopril'] },
  });
  check('POST /checkin/<event> accepts a submission', preReg.status === 200 && preReg.data && preReg.data.ok === true);

  // The submission must have been written as a checked-in patient row for evt-1.
  const stored = Array.from(env.DB._store.values()).find((r) => r.entity === 'patient' && r.event_uid === 'evt-1' && /@prereg$/.test(String(r.updated_at)));
  const pd = stored ? JSON.parse(stored.data) : null;
  check('pre-registration is stored as a checked-in patient row scoped to the event',
    !!pd && pd.status === 'checked_in' && pd.first_name === 'Pre' && pd.last_name === 'Reg');
  const demo = pd ? JSON.parse(pd.demographics) : null;
  const mh = pd ? JSON.parse(pd.medical_history) : null;
  const dh = pd ? JSON.parse(pd.dental_history) : null;
  check('pre-registration is tagged preregistered + phone digits-only + answers mapped natively',
    !!demo && demo.preregistered === true && pd.phone === '5551234567' &&
    !!mh && mh.allergies.includes('penicillin') && mh.allergies_other === 'shellfish' && mh.conditions.includes('diabetes') && mh.medications.length === 2 &&
    !!dh && dh.reason === 'tooth hurts' && dh.visit_type === 'filling');

  const noName = await call(env, 'POST', '/checkin/evt-1', { body: { first_name: '', last_name: '' } });
  check('POST /checkin with no name -> 400', noName.status === 400 && noName.data.ok === false);

  const postBadEvent = await call(env, 'POST', '/checkin/does-not-exist', { body: { first_name: 'A', last_name: 'B' } });
  check('POST /checkin/<unknown> -> 404 (only real events accept submissions)', postBadEvent.status === 404 && postBadEvent.data.ok === false);

  // --- summary ---
  console.log('');
  if (failures) {
    console.log(failures + ' check(s) FAILED');
    process.exit(1);
  } else {
    console.log('All checks passed');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('Test harness crashed:', e);
  process.exit(1);
});
