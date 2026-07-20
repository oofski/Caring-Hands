// Caring Hands — Cloud Sync Worker (v1.1.0)
// =============================================================================
// NO INSTALLS NEEDED. To deploy: create a Worker in the Cloudflare dashboard,
// paste THIS ENTIRE FILE into its code editor, then:
//   1. bind a D1 database with the variable name  DB   (Settings -> Bindings)
//   2. add a Secret named  CLINIC_KEY  = your shared clinic password
//   3. click Deploy.
// The database table is created automatically on first use (see ensureSchema),
// so there is no migration/CLI step. Full walkthrough: docs/CLOUD_SETUP.md.
// =============================================================================
// Cloudflare Worker + D1, implementing the shared "queue brain" sync API.
// Offline-first: the Electron app pushes locally-changed rows and pulls deltas.
// Dependency-free: pure Worker + D1 SQL via env.DB.
//
// See ./SYNC_CONTRACT.md for the exact API + schema this implements.

const SERVICE = 'caring-hands-sync';
const VERSION = '1.1.0';
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type',
};

// Self-initializing schema — so setup needs ZERO command-line tools. The Worker
// creates its own table on first use; the admin just pastes this file into the
// Cloudflare dashboard, binds a D1 database as "DB", sets CLINIC_KEY, and deploys.
const SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS sync_rows (' +
    'uid TEXT PRIMARY KEY, entity TEXT NOT NULL, event_uid TEXT, patient_uid TEXT, ' +
    'deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_sync_updated ON sync_rows(updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_event ON sync_rows(event_uid, updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_entity ON sync_rows(entity)',
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady || !env || !env.DB) return;
  for (const sql of SCHEMA_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  schemaReady = true;
}

export default {
  async fetch(request, env, ctx) {
    // CORS preflight — the Electron app calls from a file:// origin.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Friendly landing at the root so visiting the bare URL isn't alarming.
      // (The app never calls this — it uses /health and /v1/*.)
      if (path === '/' || path === '') {
        return json({
          ok: true,
          service: SERVICE,
          version: VERSION,
          message: 'Caring Hands sync server is running. There is no web page here — connect from the app under Admin -> Cloud. Health check: /health',
        });
      }

      // Health check — no auth (used by the app's "Test connection").
      if (path === '/health') {
        if (request.method !== 'GET') return methodNotAllowed();
        return json({
          ok: true,
          service: SERVICE,
          version: VERSION,
          time: nowIso(),
        });
      }

      // Everything under /v1/* requires a valid Bearer clinic key.
      if (path === '/v1/' || path.startsWith('/v1/')) {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }

        // Create the table on first authorized call — no CLI migration needed.
        await ensureSchema(env);

        if (path === '/v1/push') {
          if (request.method !== 'POST') return methodNotAllowed();
          return await handlePush(request, env);
        }

        if (path === '/v1/pull') {
          if (request.method !== 'GET') return methodNotAllowed();
          return await handlePull(url, env);
        }

        return json({ ok: false, error: 'not found' }, 404);
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: errMessage(err) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePush(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_e) {
    return json({ ok: false, error: 'invalid json body' }, 400);
  }

  const rows = body && Array.isArray(body.rows) ? body.rows : [];
  let applied = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!isValidRow(row)) {
      skipped++;
      continue;
    }

    // Last-Write-Wins: read the stored updated_at first, and only overwrite
    // only when the incoming updated_at is STRICTLY newer than the stored one.
    // updated_at is a globally-unique, totally-ordered stamp (monotonic ISO time
    // + device id), so this tie-break ("skip on <=") is identical to the client's
    // apply rule ("apply only when env > local") — server and client can never
    // diverge on an equal-timestamp tie.
    const existing = await env.DB
      .prepare('SELECT updated_at FROM sync_rows WHERE uid = ?')
      .bind(row.uid)
      .first();

    if (existing && String(row.updated_at) <= String(existing.updated_at)) {
      skipped++;
      continue;
    }

    const dataStr =
      typeof row.data === 'string' ? row.data : JSON.stringify(row.data);

    await env.DB
      .prepare(
        'INSERT OR REPLACE INTO sync_rows ' +
          '(uid, entity, event_uid, patient_uid, deleted, updated_at, data) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        row.uid,
        row.entity,
        row.event_uid != null ? row.event_uid : null,
        row.patient_uid != null ? row.patient_uid : null,
        row.deleted ? 1 : 0,
        row.updated_at,
        dataStr
      )
      .run();

    applied++;
  }

  return json({ ok: true, applied, skipped, time: nowIso() });
}

async function handlePull(url, env) {
  const since = url.searchParams.get('since') || '';
  const eventUid = url.searchParams.get('event_uid');
  const limit = clampLimit(url.searchParams.get('limit'));

  const columns =
    'uid, entity, event_uid, patient_uid, deleted, updated_at, data';

  let stmt;
  if (eventUid) {
    stmt = env.DB
      .prepare(
        'SELECT ' +
          columns +
          ' FROM sync_rows WHERE updated_at > ? AND event_uid = ?' +
          ' ORDER BY updated_at ASC LIMIT ?'
      )
      .bind(since, eventUid, limit);
  } else {
    stmt = env.DB
      .prepare(
        'SELECT ' +
          columns +
          ' FROM sync_rows WHERE updated_at > ?' +
          ' ORDER BY updated_at ASC LIMIT ?'
      )
      .bind(since, limit);
  }

  const result = await stmt.all();
  const dbRows = result && Array.isArray(result.results) ? result.results : [];

  const rows = dbRows.map((r) => ({
    entity: r.entity,
    uid: r.uid,
    event_uid: r.event_uid != null ? r.event_uid : null,
    patient_uid: r.patient_uid != null ? r.patient_uid : null,
    deleted: r.deleted ? 1 : 0,
    updated_at: r.updated_at,
    data: parseData(r.data),
  }));

  const cursor = rows.length ? rows[rows.length - 1].updated_at : since;
  const more = rows.length === limit;

  return json({ ok: true, rows, cursor, more });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// The clinic key. Uses the CLINIC_KEY secret when set; otherwise falls back to
// the built-in default so a clinic that just pastes this Worker in is online with
// zero setup (the Caring Hands app ships with the same default baked in).
const DEFAULT_CLINIC_KEY = 'randy';

function isAuthorized(request, env) {
  const expected = (env && typeof env.CLINIC_KEY === 'string' && env.CLINIC_KEY.length)
    ? env.CLINIC_KEY
    : DEFAULT_CLINIC_KEY;

  const provided = extractBearer(request);
  if (provided == null) return false;

  return constantTimeEqual(provided, expected);
}

function extractBearer(request) {
  const header =
    request.headers.get('Authorization') ||
    request.headers.get('authorization') ||
    '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// Constant-time string comparison: guard length, then accumulate XOR over the
// char codes so the compare time does not depend on where the first mismatch is.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aLen = a.length;
  const bLen = b.length;
  // Seed the accumulator with the length difference so unequal lengths never
  // pass, without early-returning (which would leak length via timing).
  let diff = aLen ^ bLen;
  const max = Math.max(aLen, bLen) || 1;
  for (let i = 0; i < max; i++) {
    const ca = i < aLen ? a.charCodeAt(i) : 0;
    const cb = i < bLen ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Validation & helpers
// ---------------------------------------------------------------------------

function isValidRow(row) {
  return (
    !!row &&
    typeof row === 'object' &&
    typeof row.uid === 'string' &&
    row.uid.length > 0 &&
    typeof row.entity === 'string' &&
    row.entity.length > 0 &&
    typeof row.updated_at === 'string' &&
    row.updated_at.length > 0 &&
    row.data != null
  );
}

function clampLimit(raw) {
  let limit = parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  return limit;
}

function parseData(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return value;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function errMessage(err) {
  if (err && err.message) return String(err.message);
  return String(err);
}

function methodNotAllowed() {
  return json({ ok: false, error: 'method not allowed' }, 405);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}
