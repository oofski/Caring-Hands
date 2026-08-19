'use strict';

/**
 * Caring Hands — local-first data layer.
 *
 * A single embedded SQLite database holds every clinic record. No network
 * calls are ever made from this module; all data lives on the device and is
 * only ever copied out by an explicit export/backup action.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let db = null;

/* ------------------------------------------------------------------ */
/*  Connection & schema                                                */
/* ------------------------------------------------------------------ */

function init(userDataDir) {
  const dir = userDataDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'caring-hands.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate();
  seed();
  return dbPath;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT UNIQUE NOT NULL,
      full_name    TEXT NOT NULL,
      role         TEXT NOT NULL CHECK (role IN ('admin','doctor','triage','emt','checkout','hygienist')),
      salt         TEXT NOT NULL,
      hash         TEXT NOT NULL,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      location     TEXT,
      start_date   TEXT,
      end_date     TEXT,
      languages    TEXT NOT NULL DEFAULT 'en,es',
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patients (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        INTEGER NOT NULL REFERENCES events(id),
      language        TEXT NOT NULL DEFAULT 'en',
      first_name      TEXT NOT NULL,
      last_name       TEXT NOT NULL,
      dob             TEXT,
      gender          TEXT,
      phone           TEXT,
      email           TEXT,
      demographics    TEXT NOT NULL DEFAULT '{}',   -- JSON: address, contacts, etc.
      medical_history TEXT NOT NULL DEFAULT '{}',   -- JSON
      dental_history  TEXT NOT NULL DEFAULT '{}',   -- JSON
      status          TEXT NOT NULL DEFAULT 'checked_in',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      type          TEXT NOT NULL,                  -- 'general' | 'oral_surgery'
      version       TEXT NOT NULL,                  -- consent text version + language
      language      TEXT NOT NULL,
      signer_name   TEXT NOT NULL,
      relationship  TEXT,
      signature_png TEXT NOT NULL,                  -- data URL
      signed_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS triage (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id       INTEGER NOT NULL UNIQUE REFERENCES patients(id) ON DELETE CASCADE,
      complaint        TEXT,
      flags            TEXT NOT NULL DEFAULT '[]',  -- JSON array of flag keys
      checklist        TEXT NOT NULL DEFAULT '{}',  -- JSON: cleaning/extraction/filling/none/referral
      teeth            TEXT NOT NULL DEFAULT '[]',  -- JSON array of tooth ids
      notes            TEXT,
      xray_count       INTEGER NOT NULL DEFAULT 0,
      xray_station     TEXT,
      assigned_to      TEXT,                        -- provider/station name
      status           TEXT NOT NULL DEFAULT 'waiting',
      triaged_by       INTEGER REFERENCES users(id),
      triaged_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS treatments (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id         INTEGER NOT NULL UNIQUE REFERENCES patients(id) ON DELETE CASCADE,
      fillings           TEXT NOT NULL DEFAULT '[]',  -- JSON
      extractions        TEXT NOT NULL DEFAULT '[]',  -- JSON
      cleaning           TEXT NOT NULL DEFAULT '{}',  -- JSON
      anesthetic         TEXT NOT NULL DEFAULT '[]',  -- JSON
      other_procedures   TEXT,
      clinical_notes     TEXT,
      provider_name      TEXT,
      provider_signature TEXT,                        -- data URL
      locked             INTEGER NOT NULL DEFAULT 0,
      completed_by       INTEGER REFERENCES users(id),
      completed_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS xrays (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      station     TEXT,
      image_png   TEXT NOT NULL,                      -- data URL
      note        TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER REFERENCES users(id),
      user_name   TEXT,
      action      TEXT NOT NULL,
      entity      TEXT,
      entity_id   INTEGER,
      detail      TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_patients_event ON patients(event_id);
    CREATE INDEX IF NOT EXISTS idx_patients_name  ON patients(last_name, first_name);
    CREATE INDEX IF NOT EXISTS idx_consents_pt    ON consents(patient_id);
    CREATE INDEX IF NOT EXISTS idx_xrays_pt       ON xrays(patient_id);
  `);

  // Widen the users.role CHECK to include the new roles (must run before seed).
  recreateUsersRoleCheck();

  // Additive column migrations (safe to run on existing databases).
  addColumn('triage', 'triage_signature', 'TEXT');
  addColumn('triage', 'triage_signer_name', 'TEXT');
  addColumn('triage', 'teeth_notes', "TEXT NOT NULL DEFAULT '{}'");
  // v1.0.6: staff-measured vitals (with accountability) on the triage row.
  addColumn('triage', 'bp_systolic', 'INTEGER');
  addColumn('triage', 'bp_diastolic', 'INTEGER');
  addColumn('triage', 'heart_rate', 'INTEGER');
  addColumn('triage', 'vitals_by', 'INTEGER');
  addColumn('triage', 'vitals_at', 'TEXT');
  // v1.0.6: oral-surgery consent tooth numbers the doctor fills in later.
  addColumn('consents', 'tooth_numbers', 'TEXT');
  addColumn('consents', 'amended_by', 'TEXT');
  addColumn('consents', 'amended_at', 'TEXT');
  // v1.0.6: checkout dismissal.
  addColumn('patients', 'dismissed_by', 'INTEGER');
  addColumn('patients', 'dismissed_at', 'TEXT');
  addColumn('xrays', 'updated_at', 'TEXT');
  // v1.5.0: an x-ray can be assigned to a specific tooth (e.g. imported from DEXIS).
  addColumn('xrays', 'tooth', 'TEXT');
  // v1.0.7: event-scoped staff. NULL = global (e.g. administrators) so they
  // survive every event. Existing rows default to NULL and stay global.
  addColumn('users', 'event_id', 'INTEGER');
  // v1.0.8: EMT confirms blood-thinner use with the patient after vitals.
  addColumn('triage', 'blood_thinner', 'TEXT');          // 'yes' | 'no' | null (unasked)
  addColumn('triage', 'blood_thinner_detail', 'TEXT');   // which thinner(s), when known
  // v1.0.9: the EMT station routes each patient after vitals — to the dentist
  // (fillings/extractions + treatment planning), the hygienist (cleaning), or
  // both. Replaces the separate triage station.
  addColumn('triage', 'route', 'TEXT');                  // 'dentist' | 'hygienist' | 'both' | null
  addColumn('triage', 'routed_by', 'INTEGER');
  addColumn('triage', 'routed_at', 'TEXT');
  // v1.2.0: the EMT's yes/no medical confirmations (JSON), and whether the EMT
  // has signed the patient off from the vitals station into a clinical queue.
  addColumn('triage', 'emt_review', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('triage', 'emt_signed_off', 'INTEGER NOT NULL DEFAULT 0');
  // v1.4.7: when a reading is high, the EMT may record up to 2 additional BP
  // readings (re-checks). Stored as a small JSON array on the triage row.
  addColumn('triage', 'bp_rechecks', "TEXT NOT NULL DEFAULT '[]'");

  // v1.1.0: cloud sync. Each syncable row carries a stable uid (cloud identity),
  // an updated_at revision, and synced_rev (the revision last pushed/applied —
  // a row is "dirty" when updated_at != synced_rev). Denormalized *_by_name
  // columns let accountability survive across devices without syncing accounts.
  // v1.4.4: staff accounts sync too, so a team created on one laptop appears on
  // every laptop. The users table gets the same sync bookkeeping columns.
  for (const tbl of ['events', 'patients', 'triage', 'treatments', 'consents', 'xrays', 'users']) {
    addColumn(tbl, 'uid', 'TEXT');
    addColumn(tbl, 'updated_at', 'TEXT');
    addColumn(tbl, 'synced_rev', 'TEXT');   // sig last confirmed synced (== sig means clean)
    addColumn(tbl, 'content_rev', 'TEXT');  // sig that updated_at currently corresponds to
  }
  // v1.4.6: which event the clinic is CURRENTLY on is synced across laptops via a
  // globally-ordered "selected_at" stamp (the event with the greatest one, that is
  // still turned on, is the active event everywhere). Before this, "Set active" was
  // a local-only setting, so laptops could sit on different events and split the queue.
  addColumn('events', 'selected_at', 'TEXT');
  addColumn('patients', 'dismissed_by_name', 'TEXT');
  // v1.5.24: the front desk confirms the patient is physically here and ready to
  // be seen (consents checked, station assigned). Pre-registered patients can sit
  // in the queue for days before they walk in, so "checked in" alone can't mean
  // "present".
  addColumn('patients', 'arrived_at', 'TEXT');
  addColumn('patients', 'arrived_by_name', 'TEXT');
  // v1.6.0: deleting a record locally used to be undone by the next sync — the
  // row was simply pulled back from the cloud. A tombstone is the record OF a
  // deletion: it carries the uid and nothing else (no patient data), is pushed
  // like any other row, and tells every other station and the cloud to drop it.
  db.exec(`CREATE TABLE IF NOT EXISTS tombstones (
    uid TEXT PRIMARY KEY, entity TEXT NOT NULL, event_uid TEXT,
    updated_at TEXT NOT NULL, synced_rev TEXT, created_at TEXT NOT NULL)`);
  // v1.6.0: what a finished clinic leaves behind — counts only, no patients.
  db.exec(`CREATE TABLE IF NOT EXISTS event_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, event_id INTEGER,
    summary TEXT NOT NULL, patients_seen INTEGER, finished_at TEXT,
    finished_by_name TEXT, created_at TEXT, updated_at TEXT,
    synced_rev TEXT, content_rev TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_event ON event_reports(event_id)');
  addColumn('triage', 'triaged_by_name', 'TEXT');
  addColumn('triage', 'vitals_by_name', 'TEXT');
  addColumn('triage', 'routed_by_name', 'TEXT');
  addColumn('treatments', 'completed_by_name', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sync_patients ON patients(uid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sync_events ON events(uid)');
  // v1.5.21 ONE-TIME HEAL. Until now the pull cursor was a timestamp high-water
  // mark, so any row that reached the cloud with an older stamp — a check-in made
  // while this station was offline, or anything written by a laptop whose clock
  // was behind — fell below the mark and was never handed to this station again.
  // Patients really were missing on one laptop and present on another. Clearing
  // the cursor once makes this station re-read the whole clinic and pick up
  // everyone it skipped; applying rows is idempotent, so it is safe to repeat.
  if (getSetting('cloud_cursor_heal') !== 'v1') {
    setSetting('cloud_cursor', '');
    setSetting('cloud_pending', '[]');
    setSetting('cloud_cursor_heal', 'v1');
  }
}

const ROLES = ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'];
// Roles that do their clinical work on real patients (used for event-scoped
// staff clearing — administrators are global and never swept). 'registration'
// is a front-desk role scoped to the event, so it clears with the rest.
const EVENT_STAFF_ROLES = ['doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'];

// SQLite can't ALTER a CHECK constraint, so recreate the users table whenever a
// role in ROLES is missing from the stored CHECK. This is how new roles ship
// (emt/checkout in v1.0.6, hygienist in v1.0.7) WITHOUT ever disabling, dropping
// or resetting existing accounts — every row is copied verbatim, active flag and
// all. Idempotent: no-op once the stored SQL already allows every current role.
function recreateUsersRoleCheck() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!row) return;
  const missingRole = ROLES.some((r) => !new RegExp(`'${r}'`).test(row.sql));
  if (!missingRole) return;
  // Preserve every column that currently exists (incl. event_id on later
  // upgrades) so no accounts, roles, active flags, or event scoping are lost.
  const existingCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const rolesSql = ROLES.map((r) => `'${r}'`).join(',');
  // Carry EVERY column that currently exists — including the cloud-sync bookkeeping
  // columns (uid/updated_at/synced_rev/content_rev) so a future role addition never
  // strips a staff account's sync identity (which would re-duplicate them on sync).
  const carried = ['id', 'username', 'full_name', 'role', 'salt', 'hash', 'active', 'created_at', 'event_id', 'uid', 'updated_at', 'synced_rev', 'content_rev']
    .filter((c) => existingCols.includes(c));
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        username     TEXT UNIQUE NOT NULL,
        full_name    TEXT NOT NULL,
        role         TEXT NOT NULL CHECK (role IN (${rolesSql})),
        salt         TEXT NOT NULL,
        hash         TEXT NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL,
        event_id     INTEGER,
        uid          TEXT,
        updated_at   TEXT,
        synced_rev   TEXT,
        content_rev  TEXT
      );
    `);
    db.exec(
      `INSERT INTO users_new (${carried.join(', ')}) SELECT ${carried.join(', ')} FROM users;
       DROP TABLE users;
       ALTER TABLE users_new RENAME TO users;`
    );
  });
  tx();
  db.pragma('foreign_keys = ON');
}

// Add a column only if it does not already exist.
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Password hashing (scrypt)                                          */
/* ------------------------------------------------------------------ */

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
  return { salt: useSalt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/*  Seed: default admin + starter event                               */
/* ------------------------------------------------------------------ */

// v1.2.4: the default clinic event shares ONE identity across every device, so a
// patient created on any computer lands in the same event everywhere and shows up
// in every station's queue. Without this each device made its own event with a
// different id, and the active-event queue filtered out patients synced from
// other devices (they synced into the DB but were invisible).
const DEFAULT_EVENT_UID = '00000000-0000-4000-8000-000000000001';
// v1.4.4: the bootstrap administrator (username 'admin') is seeded independently
// on every device. Give it ONE shared cloud identity — exactly like the default
// event — so the seeded admin is a single synced row instead of N colliding
// 'admin' rows (one per laptop). Real, admin-created accounts keep their own
// unique uid and sync normally.
const DEFAULT_ADMIN_UID = '00000000-0000-4000-8000-000000000002';

// Ensure this device's default clinic event uses the shared identity above, and
// that the active event points at it — so cloud-synced patients are visible.
function convergeDefaultEvent() {
  // Already converged on this device — do nothing.
  if (db.prepare('SELECT 1 FROM events WHERE uid = ? LIMIT 1').get(DEFAULT_EVENT_UID)) return;
  // CONSERVATIVE: only ever promote the PRISTINE auto-seed event, identified by
  // its exact seed name + location (never a renamed or user-created event), and
  // never change which event is active. This avoids merging genuinely different
  // clinic events or yanking a clinic off the event they deliberately chose.
  const seedEv = db.prepare("SELECT id FROM events WHERE name = 'Lowell Fairgrounds Clinic' AND location = 'Lowell, OR' ORDER BY id ASC LIMIT 1").get();
  if (!seedEv) return; // no pristine seed to promote — leave every event alone
  db.prepare('UPDATE events SET uid = ?, synced_rev = NULL, content_rev = NULL WHERE id = ?').run(DEFAULT_EVENT_UID, seedEv.id);
  // Re-push its patients so their event_uid updates to the shared identity on
  // every device (the applyRemoteRows UPDATE now carries event_id — see below).
  db.prepare('UPDATE patients SET synced_rev = NULL, content_rev = NULL WHERE event_id = ?').run(seedEv.id);
}

// Point this device's bootstrap admin at the shared identity so every laptop's
// seeded 'admin' is ONE cloud row (not N colliding ones). Conservative: only the
// pristine seed admin (username 'admin', role admin) is promoted, and only when
// nothing already holds the shared uid here.
function convergeSeedAdmin() {
  if (db.prepare('SELECT 1 FROM users WHERE uid = ? LIMIT 1').get(DEFAULT_ADMIN_UID)) return;
  const seed = db.prepare("SELECT * FROM users WHERE username = 'admin' AND role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!seed) return;
  if (verifyPassword('admin', seed.salt, seed.hash)) {
    // STILL the untouched default admin/admin. Converge it to the shared uid but
    // stamp it "ancient" so it ALWAYS loses last-write-wins to a laptop that set a
    // real admin password — a fresh install must never reset the clinic's admin.
    // content_rev = sig(data) makes collectSyncRows push it verbatim (no re-stamp).
    const s = sig(buildData('user', seed));
    const ancient = '0000-01-01T00:00:00.000Z@' + (getSetting('cloud_device_id') || '0');
    db.prepare('UPDATE users SET uid = ?, updated_at = ?, synced_rev = NULL, content_rev = ? WHERE id = ?')
      .run(DEFAULT_ADMIN_UID, ancient, s, seed.id);
  } else {
    // The admin password was changed on this laptop: converge to the shared uid and
    // let collectSyncRows stamp it with a real current time so it propagates and
    // wins over any default admin still out there.
    db.prepare('UPDATE users SET uid = ?, synced_rev = NULL, content_rev = NULL WHERE id = ?')
      .run(DEFAULT_ADMIN_UID, seed.id);
  }
}

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    // Only a bootstrap administrator is created. The admin creates all other
    // staff accounts from Admin > Staff. (No demo doctor/triage accounts.)
    const { salt, hash } = hashPassword('admin');
    db.prepare(
      `INSERT INTO users (username, full_name, role, salt, hash, active, created_at)
       VALUES (?,?,?,?,?,1,?)`
    ).run('admin', 'Clinic Administrator', 'admin', salt, hash, now());
  } else {
    // One-time cleanup for databases seeded by an earlier version: disable the
    // old demo doctor/triage accounts if they still use the default password.
    for (const [u, pw] of [['doctor', 'doctor'], ['triage', 'triage']]) {
      const row = db.prepare("SELECT * FROM users WHERE username = ?").get(u);
      if (row && row.active && verifyPassword(pw, row.salt, row.hash)) {
        db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(row.id);
      }
    }
  }

  const eventCount = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  if (eventCount === 0) {
    // Fresh install: create the default event already carrying the shared
    // identity, so every device's default event is the same cloud entity.
    const info = db.prepare(
      `INSERT INTO events (name, location, start_date, end_date, languages, active, created_at, uid)
       VALUES (?,?,?,?,?,1,?,?)`
    ).run('Lowell Fairgrounds Clinic', 'Lowell, OR', today(), today(), 'en,es', now(), DEFAULT_EVENT_UID);
    setSetting('active_event_id', String(info.lastInsertRowid));
  }
  // Existing installs (or after any event change): make sure the default event is
  // the shared, cross-device identity and the queue is pointed at it.
  convergeDefaultEvent();
  convergeSeedAdmin();
  // Align this laptop's active event with the clinic-wide selection (synced).
  resolveActiveEvent();

  // v1.0.7: adopt any legacy clinical staff (created before event scoping, so
  // event_id IS NULL) into the active event, so "Start fresh for next event"
  // can clear them like any other event staff. Administrators stay global.
  const activeId = Number(getSetting('active_event_id'));
  if (activeId) {
    db.prepare("UPDATE users SET event_id = ? WHERE event_id IS NULL AND role != 'admin'").run(activeId);
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
// Never let a malformed JSON column (e.g. from a bad cloud-sync row) throw and
// take down a whole patient list / detail. Falls back to the given default.
function safeJson(str, fallback) {
  if (str == null || str === '') return fallback;
  try { const v = JSON.parse(str); return v == null ? fallback : v; } catch { return fallback; }
}
const today = () => new Date().toISOString().slice(0, 10);

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function audit(user, action, entity, entityId, detail) {
  db.prepare(
    `INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, detail, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    user ? user.id : null,
    user ? user.full_name : 'system',
    action,
    entity || null,
    entityId || null,
    detail || null,
    now()
  );
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    active: !!row.active,
    created_at: row.created_at,
    event_id: row.event_id != null ? row.event_id : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Auth & users                                                       */
/* ------------------------------------------------------------------ */

function login(username, password) {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ? AND active = 1')
    .get(String(username || '').trim().toLowerCase());
  if (!row) return null;
  if (!verifyPassword(password, row.salt, row.hash)) return null;
  audit(publicUser(row), 'login', 'user', row.id, null);
  return publicUser(row);
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY role, full_name').all().map(publicUser);
}

function createUser(actor, { username, full_name, role, password, event_id }) {
  const u = String(username || '').trim().toLowerCase();
  if (!u || !full_name || !role || !password) throw new Error('Missing required fields.');
  if (!ROLES.includes(role)) throw new Error('Invalid role.');
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
  if (exists) throw new Error('That username already exists.');
  // Administrators are always global (event_id NULL). Clinical staff are scoped
  // to an event so they can be cleared out when the clinic moves on (v1.0.7).
  // A scoped role with no event given falls back to the active event.
  let eid = null;
  if (role !== 'admin') {
    eid = event_id != null ? Number(event_id) : Number(getSetting('active_event_id')) || null;
  }
  const { salt, hash } = hashPassword(password);
  const info = db.prepare(
    `INSERT INTO users (username, full_name, role, salt, hash, active, created_at, event_id)
     VALUES (?,?,?,?,?,1,?,?)`
  ).run(u, full_name, role, salt, hash, now(), eid);
  audit(actor, 'create', 'user', info.lastInsertRowid, `${u} (${role})`);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
}

// Remove all event-scoped clinical staff for an event so the next clinic starts
// clean. Administrators (global) are never touched, and the actor can't delete
// their own account. Returns the number of accounts removed. (v1.0.7)
function clearEventStaff(actor, eventId) {
  const eid = Number(eventId);
  if (!eid) throw new Error('An event is required to clear its staff.');
  const rows = db.prepare(
    `SELECT * FROM users WHERE event_id = ? AND role != 'admin'`
  ).all(eid).filter((r) => !(actor && actor.id === r.id));
  const ids = rows.map((r) => r.id);
  const del = db.prepare('DELETE FROM users WHERE id = ?');
  const tx = db.transaction(() => { detachUserRefs(ids); ids.forEach((id) => del.run(id)); });
  tx();
  audit(actor, 'clear_staff', 'event', eid, `${rows.length} staff account(s)`);
  return { deleted: rows.length };
}

function updateUser(actor, id, { full_name, role, active, password }) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) throw new Error('User not found.');
  const fields = [];
  const vals = [];
  if (full_name != null) { fields.push('full_name = ?'); vals.push(full_name); }
  if (role != null) { fields.push('role = ?'); vals.push(role); }
  if (active != null) { fields.push('active = ?'); vals.push(active ? 1 : 0); }
  if (password) {
    const { salt, hash } = hashPassword(password);
    fields.push('salt = ?', 'hash = ?'); vals.push(salt, hash);
  }
  if (fields.length) {
    vals.push(id);
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  audit(actor, 'update', 'user', id, full_name || row.full_name);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

// Null out every reference to these user ids before deleting them, so a staff
// account that has already logged in / triaged / treated / dismissed patients
// can still be removed without hitting a foreign-key constraint. Accountability
// text (audit_log.user_name) is denormalized and stays intact.
function detachUserRefs(ids) {
  if (!ids || !ids.length) return;
  const ph = ids.map(() => '?').join(',');
  // v1.1.0: preserve the accountability name into the denormalized column BEFORE
  // clearing the id, so deleting a staff account doesn't erase (or, via sync,
  // overwrite on other devices) the record of who performed each action.
  db.prepare(`UPDATE triage SET triaged_by_name = COALESCE(triaged_by_name, (SELECT full_name FROM users WHERE id = triaged_by)) WHERE triaged_by IN (${ph})`).run(...ids);
  db.prepare(`UPDATE triage SET vitals_by_name = COALESCE(vitals_by_name, (SELECT full_name FROM users WHERE id = vitals_by)) WHERE vitals_by IN (${ph})`).run(...ids);
  db.prepare(`UPDATE triage SET routed_by_name = COALESCE(routed_by_name, (SELECT full_name FROM users WHERE id = routed_by)) WHERE routed_by IN (${ph})`).run(...ids);
  db.prepare(`UPDATE treatments SET completed_by_name = COALESCE(completed_by_name, (SELECT full_name FROM users WHERE id = completed_by)) WHERE completed_by IN (${ph})`).run(...ids);
  db.prepare(`UPDATE patients SET dismissed_by_name = COALESCE(dismissed_by_name, (SELECT full_name FROM users WHERE id = dismissed_by)) WHERE dismissed_by IN (${ph})`).run(...ids);
  db.prepare(`UPDATE audit_log SET user_id = NULL WHERE user_id IN (${ph})`).run(...ids);
  db.prepare(`UPDATE triage SET triaged_by = NULL WHERE triaged_by IN (${ph})`).run(...ids);
  db.prepare(`UPDATE triage SET vitals_by = NULL WHERE vitals_by IN (${ph})`).run(...ids);
  db.prepare(`UPDATE triage SET routed_by = NULL WHERE routed_by IN (${ph})`).run(...ids);
  db.prepare(`UPDATE treatments SET completed_by = NULL WHERE completed_by IN (${ph})`).run(...ids);
  db.prepare(`UPDATE patients SET dismissed_by = NULL WHERE dismissed_by IN (${ph})`).run(...ids);
}

function deleteUser(actor, id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) throw new Error('User not found.');
  if (actor && actor.id === id) throw new Error('You cannot delete your own account.');
  // Only guard against removing the last ACTIVE administrator. Deleting an
  // already-inactive admin can never leave the clinic without a usable admin.
  if (row.role === 'admin' && row.active) {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (admins <= 1) throw new Error('Cannot delete the last administrator.');
  }
  const tx = db.transaction(() => { detachUserRefs([id]); db.prepare('DELETE FROM users WHERE id = ?').run(id); });
  tx();
  audit(actor, 'delete', 'user', id, row.username);
  return { deleted: true };
}

/* ------------------------------------------------------------------ */
/*  Events                                                             */
/* ------------------------------------------------------------------ */

function listEvents() {
  const rows = db.prepare('SELECT * FROM events ORDER BY active DESC, created_at DESC').all();
  // Per-event public pre-registration link: patients open it ahead of time, fill
  // the check-in questions, and the submission is routed into THIS event. The
  // link lives on the same cloud server the app already syncs against.
  const base = (getSyncMeta().url || '').replace(/\/+$/, '');
  return rows.map((e) => ({
    ...e,
    active: !!e.active,
    patient_count: db.prepare('SELECT COUNT(*) AS n FROM patients WHERE event_id = ?').get(e.id).n,
    prereg_url: (base && e.uid) ? `${base}/checkin/${e.uid}` : null,
  }));
}

function createEvent(actor, { name, location, start_date, end_date, languages }) {
  if (!name) throw new Error('Event name is required.');
  const info = db.prepare(
    `INSERT INTO events (name, location, start_date, end_date, languages, active, created_at)
     VALUES (?,?,?,?,?,1,?)`
  ).run(name, location || '', start_date || today(), end_date || '', languages || 'en,es', now());
  audit(actor, 'create', 'event', info.lastInsertRowid, name);
  return db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid);
}

function setActiveEvent(actor, id) {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) throw new Error('Event not found.');
  if (!e.active) throw new Error('That event is turned off. Reactivate it first.');
  // Stamp this event as the clinic's current selection with a globally-ordered
  // stamp (monotonic time + device id). The event with the greatest selected_at
  // that is still turned on is the active event on EVERY laptop — so "Set active"
  // now propagates through cloud sync instead of staying local to this computer.
  db.prepare('UPDATE events SET selected_at = ? WHERE id = ?').run(stampNow(), id);
  persistStamp();
  setSetting('active_event_id', String(id));
  audit(actor, 'select', 'event', id, e.name);
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

function updateEvent(actor, id, { name, location, start_date, end_date, languages }) {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) throw new Error('Event not found.');
  db.prepare(
    `UPDATE events SET name=?, location=?, start_date=?, end_date=?, languages=? WHERE id=?`
  ).run(name ?? e.name, location ?? e.location, start_date ?? e.start_date, end_date ?? e.end_date, languages ?? e.languages, id);
  audit(actor, 'update', 'event', id, name || e.name);
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

// Turn an event on/off. Turning off the active event re-resolves the clinic's
// active event (the most recently selected event that is still on).
function setEventActive(actor, id, active) {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) throw new Error('Event not found.');
  db.prepare('UPDATE events SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  resolveActiveEvent();
  audit(actor, active ? 'activate' : 'deactivate', 'event', id, e.name);
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

function deleteEvent(actor, id, { force } = {}) {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) throw new Error('Event not found.');
  const count = db.prepare('SELECT COUNT(*) AS n FROM patients WHERE event_id = ?').get(id).n;
  if (count > 0 && !force) {
    throw new Error(`This event has ${count} patient record(s). Turn it off instead, or confirm permanent deletion.`);
  }
  // Cascade: patients -> (triage/treatments/consents/xrays cascade via FK ON DELETE CASCADE)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM patients WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
  });
  tx();
  if (Number(getSetting('active_event_id')) === id) resolveActiveEvent();
  audit(actor, 'delete', 'event', id, `${e.name} (+${count} patients)`);
  return { deleted: true, patients: count };
}

// Recompute which event this laptop is on, keeping it in step with every other
// laptop: the ON event with the greatest selected_at (a globally-ordered stamp)
// wins, so a "Set active" done on ANY computer becomes the active event here once
// it syncs. Falls back to the current local event, then any active event.
function resolveActiveEvent() {
  const chosen = db.prepare(
    "SELECT id FROM events WHERE active = 1 AND selected_at IS NOT NULL AND selected_at != '' ORDER BY selected_at DESC LIMIT 1"
  ).get();
  if (chosen) { setSetting('active_event_id', String(chosen.id)); return chosen.id; }
  // No event was ever explicitly selected — keep a valid, still-on local event.
  const curId = Number(getSetting('active_event_id'));
  if (curId && db.prepare('SELECT 1 FROM events WHERE id = ? AND active = 1').get(curId)) return curId;
  const fallback = db.prepare('SELECT id FROM events WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
  setSetting('active_event_id', fallback ? String(fallback.id) : '');
  return fallback ? fallback.id : null;
}

function getActiveEvent() {
  const id = getSetting('active_event_id');
  if (!id) return null;
  return db.prepare('SELECT * FROM events WHERE id = ?').get(Number(id)) || null;
}

/* ------------------------------------------------------------------ */
/*  Patients & intake                                                  */
/* ------------------------------------------------------------------ */

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d)) return null;
  const diff = Date.now() - d.getTime();
  return Math.floor(diff / (365.25 * 24 * 3600 * 1000));
}

function rowToPatient(p) {
  if (!p) return null;
  return {
    ...p,
    age: ageFromDob(p.dob),
    demographics: safeJson(p.demographics, {}),
    medical_history: safeJson(p.medical_history, {}),
    dental_history: safeJson(p.dental_history, {}),
  };
}

// What the patient said they need decides who they see, so nobody has to pick a
// station by hand: a cleaning is hygienist work; a filling or an extraction is
// dentist work. Returns null for an unrecognised/absent answer, which leaves the
// choice to the EMT exactly as before.
const VISIT_ROUTE = {
  cleaning: 'hygienist',
  filling: 'dentist',
  extraction_pain: 'dentist',
  extraction_no_pain: 'dentist',
};
function routeFromVisitType(visitType) {
  return VISIT_ROUTE[String(visitType || '')] || null;
}
// An extraction is the only answer that also needs the oral-surgery consent.
function visitNeedsSurgeryConsent(visitType) {
  return String(visitType || '').startsWith('extraction');
}

function createPatient(actor, data) {
  const eventId = Number(getSetting('active_event_id'));
  if (!eventId) throw new Error('No active clinic event. Ask an admin to create one.');
  const d = data || {};
  // Hard guard: never persist a nameless patient (defense-in-depth against any
  // intake bug — this is what produced the empty legacy records).
  if (!(d.first_name || '').trim() || !(d.last_name || '').trim()) {
    throw new Error('Patient first and last name are required.');
  }
  const info = db.prepare(
    `INSERT INTO patients
       (event_id, language, first_name, last_name, dob, gender, phone, email,
        demographics, medical_history, dental_history, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    eventId,
    d.language || 'en',
    (d.first_name || '').trim(),
    (d.last_name || '').trim(),
    d.dob || null,
    d.gender || null,
    d.phone || null,
    d.email || null,
    JSON.stringify(d.demographics || {}),
    JSON.stringify(d.medical_history || {}),
    JSON.stringify(d.dental_history || {}),
    'checked_in',
    now(),
    now()
  );
  const id = info.lastInsertRowid;

  // Auto-create an empty triage row so the patient appears in the queue.
  // v1.2.0: the patient chooses dentist or hygienist at check-in (their intended
  // provider). We store that choice on the triage row now, but the patient stays
  // status 'checked_in' — they appear ONLY in the EMT/nurse queue until the EMT
  // records vitals and signs them off into the chosen clinical queue.
  // v1.5.24: if no station was picked explicitly, derive it from what the patient
  // said they need — cleaning to the hygienist, filling/extraction to the dentist.
  const intendedRoute = ['dentist', 'hygienist'].includes(d.route)
    ? d.route
    : routeFromVisitType(d.dental_history && d.dental_history.visit_type);
  db.prepare(
    `INSERT INTO triage (patient_id, complaint, status, route) VALUES (?,?, 'waiting', ?)`
  ).run(id, (d.dental_history && d.dental_history.reason) || null, intendedRoute);

  // Persist consents
  (d.consents || []).forEach((c) => addConsent(id, c));

  audit(actor || { id: null, full_name: 'kiosk' }, 'create', 'patient', id,
    `${d.first_name || ''} ${d.last_name || ''}`.trim());
  return getPatient(id);
}

// Returning patient: start a NEW visit (new patient row) in the active event,
// pre-filled from an existing record so the front desk doesn't re-type. Carries
// demographics + medical history; the visit-specific bits (reason / what they
// need / prior signed consents) start fresh so this visit is captured cleanly.
function startVisitFromExisting(actor, sourceId) {
  const src = getPatient(sourceId);
  if (!src) throw new Error('Patient not found.');
  const dental = Object.assign({}, src.dental_history || {});
  delete dental.reason; delete dental.visit_type; delete dental.may_need_extraction;
  return createPatient(actor, {
    first_name: src.first_name, last_name: src.last_name, dob: src.dob, gender: src.gender,
    phone: src.phone, email: src.email, language: src.language,
    demographics: src.demographics || {}, medical_history: src.medical_history || {},
    dental_history: dental, consents: [],
  });
}

function updatePatient(actor, id, data) {
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!p) throw new Error('Patient not found.');
  const d = data || {};
  // Same guard as createPatient: never let an edit blank the patient's name
  // (an explicit '' is not caught by ??), which reintroduces nameless records.
  const first = (d.first_name ?? p.first_name);
  const last = (d.last_name ?? p.last_name);
  if (!String(first || '').trim() || !String(last || '').trim()) {
    throw new Error('Patient first and last name are required.');
  }
  db.prepare(
    `UPDATE patients SET
       language=?, first_name=?, last_name=?, dob=?, gender=?, phone=?, email=?,
       demographics=?, medical_history=?, dental_history=?, updated_at=?
     WHERE id=?`
  ).run(
    d.language || p.language,
    first,
    last,
    d.dob ?? p.dob,
    d.gender ?? p.gender,
    d.phone ?? p.phone,
    d.email ?? p.email,
    JSON.stringify(d.demographics || safeJson(p.demographics, {})),
    JSON.stringify(d.medical_history || safeJson(p.medical_history, {})),
    JSON.stringify(d.dental_history || safeJson(p.dental_history, {})),
    now(),
    id
  );
  audit(actor, 'update', 'patient', id, null);
  return getPatient(id);
}

function addConsent(patientId, c) {
  db.prepare(
    `INSERT INTO consents (patient_id, type, version, language, signer_name, relationship, signature_png, signed_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    patientId,
    c.type,
    c.version || `${c.type}-${c.language || 'en'}-v1`,
    c.language || 'en',
    c.signer_name || '',
    c.relationship || '',
    c.signature_png || '',
    c.signed_at || now()
  );
}

// Prior visits for the same person (matched by name + DOB) across all events —
// the returning-patient / continuity-of-care history.
function patientHistory(patientId) {
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!p) return [];
  const rows = db.prepare(
    `SELECT pt.id, pt.created_at, pt.status, e.name AS event_name
     FROM patients pt JOIN events e ON e.id = pt.event_id
     WHERE pt.id != ? AND lower(pt.first_name) = lower(?) AND lower(pt.last_name) = lower(?)
       AND (pt.dob = ? OR (? IS NULL))
     ORDER BY pt.created_at DESC`
  ).all(patientId, p.first_name, p.last_name, p.dob, p.dob);
  return rows.map((r) => {
    const tr = db.prepare("SELECT checklist FROM triage WHERE patient_id = ?").get(r.id);
    const tx = db.prepare('SELECT fillings, extractions, cleaning FROM treatments WHERE patient_id = ?').get(r.id);
    let summary = [];
    if (tx) {
      const f = safeJson(tx.fillings, []).length, x = safeJson(tx.extractions, []).length;
      const c = Object.values(safeJson(tx.cleaning, {})).some(Boolean);
      if (f) summary.push(`${f} filling(s)`);
      if (x) summary.push(`${x} extraction(s)`);
      if (c) summary.push('cleaning');
    }
    return { id: r.id, event_name: r.event_name, created_at: r.created_at, status: r.status, summary: summary.join(', ') || '—' };
  });
}

function tombstonePatient(id) {
  const p = db.prepare('SELECT id, uid, event_id FROM patients WHERE id = ?').get(id);
  if (!p) return;
  ensureUids();
  const evUid = p.event_id ? uidOf('events', p.event_id) : null;
  const tomb = db.prepare(
    `INSERT INTO tombstones (uid, entity, event_uid, updated_at, synced_rev, created_at)
     VALUES (?,?,?,?,NULL,?) ON CONFLICT(uid) DO UPDATE SET synced_rev = NULL, updated_at = excluded.updated_at`
  );
  for (const [table, entity] of [['triage', 'triage'], ['treatments', 'treatment'], ['consents', 'consent'], ['xrays', 'xray']]) {
    for (const c of db.prepare(`SELECT uid FROM ${table} WHERE patient_id = ?`).all(id)) {
      if (c.uid) tomb.run(c.uid, entity, evUid, stampNow(), now());
    }
  }
  const fresh = db.prepare('SELECT uid FROM patients WHERE id = ?').get(id);
  if (fresh && fresh.uid) tomb.run(fresh.uid, 'patient', evUid, stampNow(), now());
}

function deletePatient(actor, id) {
  // Record the deletion BEFORE the rows go, so it reaches the cloud and the
  // other stations instead of the record simply being pulled back.
  tombstonePatient(id);
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!p) throw new Error('Patient not found.');
  // triage/treatments/consents/xrays cascade via FK ON DELETE CASCADE.
  db.prepare('DELETE FROM patients WHERE id = ?').run(id);
  audit(actor, 'delete', 'patient', id, `${p.first_name} ${p.last_name}`.trim());
  return { deleted: true };
}

// Records left empty by the v1.0 intake bug (no name + empty histories).
function listIncompletePatients() {
  return db.prepare(
    `SELECT p.id, p.first_name, p.last_name, p.created_at, e.name AS event_name
     FROM patients p JOIN events e ON e.id = p.event_id
     WHERE (trim(coalesce(p.first_name,'')) = '' OR trim(coalesce(p.last_name,'')) = '')
        OR (p.demographics = '{}' AND p.medical_history = '{}' AND p.dental_history = '{}')
     ORDER BY p.created_at`
  ).all();
}

function deleteIncompletePatients(actor) {
  const rows = listIncompletePatients();
  const del = db.prepare('DELETE FROM patients WHERE id = ?');
  const tx = db.transaction(() => { rows.forEach((r) => del.run(r.id)); });
  tx();
  audit(actor, 'cleanup', 'patient', null, `${rows.length} incomplete record(s)`);
  return { deleted: rows.length };
}

function getPatient(id) {
  const p = rowToPatient(db.prepare('SELECT * FROM patients WHERE id = ?').get(id));
  if (!p) return null;
  p.consents = db.prepare('SELECT * FROM consents WHERE patient_id = ? ORDER BY signed_at').all(id);
  const tr = db.prepare('SELECT * FROM triage WHERE patient_id = ?').get(id);
  p.triage = tr ? { ...tr, flags: safeJson(tr.flags, []), checklist: safeJson(tr.checklist, {}), teeth: safeJson(tr.teeth, []), teeth_notes: safeJson(tr.teeth_notes, {}), emt_review: safeJson(tr.emt_review, {}), bp_rechecks: safeJson(tr.bp_rechecks, []), emt_signed_off: !!tr.emt_signed_off } : null;
  const t = db.prepare('SELECT * FROM treatments WHERE patient_id = ?').get(id);
  p.treatment = t
    ? {
        ...t,
        locked: !!t.locked,
        fillings: safeJson(t.fillings, []),
        extractions: safeJson(t.extractions, []),
        cleaning: safeJson(t.cleaning, {}),
        anesthetic: safeJson(t.anesthetic, []),
      }
    : null;
  p.xrays = db.prepare('SELECT id, station, note, created_at FROM xrays WHERE patient_id = ?').all(id);
  p.event = db.prepare('SELECT * FROM events WHERE id = ?').get(p.event_id);
  // v1.0.6 accountability: resolve the staff name for each recorded action.
  // v1.1.0: prefer the denormalized *_by_name column (set by cloud sync from
  // another device) so accountability survives across stations; fall back to
  // resolving the local user id for rows created on this device.
  const nameOf = (uid) => { if (!uid) return null; const u = db.prepare('SELECT full_name FROM users WHERE id = ?').get(uid); return u ? u.full_name : null; };
  p.triaged_by_name = tr ? (tr.triaged_by_name || nameOf(tr.triaged_by)) : null;
  p.vitals_by_name = tr ? (tr.vitals_by_name || nameOf(tr.vitals_by)) : null;
  p.routed_by_name = tr ? (tr.routed_by_name || nameOf(tr.routed_by)) : null;
  p.completed_by_name = t ? (t.completed_by_name || nameOf(t.completed_by)) : null;
  p.dismissed_by_name = p.dismissed_by_name || nameOf(p.dismissed_by);
  return p;
}

/* ------------------------------------------------------------------ */
/*  v1.0.6: vitals, consent teeth, dismissal, audit, USB import        */
/* ------------------------------------------------------------------ */

const toIntOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// EMT / staff-measured vitals stored (with accountability) on the triage row.
function saveVitals(actor, patientId, data) {
  const tr = db.prepare('SELECT id FROM triage WHERE patient_id = ?').get(patientId);
  const d = data || {};
  const sys = toIntOrNull(d.bp_systolic), dia = toIntOrNull(d.bp_diastolic), hr = toIntOrNull(d.heart_rate);
  // Only treat this as a vitals write when at least one vitals key is present, so
  // a review-only or blood-thinner-only save never nulls out previously recorded
  // vitals (or reassigns vitals_by/vitals_at to the wrong actor).
  const hasVitals = ['bp_systolic', 'bp_diastolic', 'heart_rate'].some((k) => Object.prototype.hasOwnProperty.call(d, k));
  // Blood-thinner confirmation is optional and only written when the key is
  // present, so a plain vitals save never clears a previously recorded answer.
  const hasBT = Object.prototype.hasOwnProperty.call(d, 'blood_thinner');
  const bt = hasBT ? (d.blood_thinner || null) : null;
  const btd = hasBT ? (d.blood_thinner_detail || null) : null;
  if (!tr) {
    db.prepare(`INSERT INTO triage (patient_id, status, bp_systolic, bp_diastolic, heart_rate, vitals_by, vitals_at, blood_thinner, blood_thinner_detail)
                VALUES (?, 'waiting', ?, ?, ?, ?, ?, ?, ?)`).run(patientId, sys, dia, hr, hasVitals && actor ? actor.id : null, hasVitals ? now() : null, bt, btd);
  } else {
    if (hasVitals) {
      db.prepare('UPDATE triage SET bp_systolic=?, bp_diastolic=?, heart_rate=?, vitals_by=?, vitals_at=? WHERE patient_id=?')
        .run(sys, dia, hr, actor ? actor.id : null, now(), patientId);
    }
    if (hasBT) db.prepare('UPDATE triage SET blood_thinner=?, blood_thinner_detail=? WHERE patient_id=?').run(bt, btd, patientId);
  }
  // v1.2.0: the EMT's yes/no confirmations, stored only when at least one answer
  // is present so a blank/plain save never wipes a previously filled review.
  if (Object.prototype.hasOwnProperty.call(d, 'emt_review') && d.emt_review && typeof d.emt_review === 'object' && Object.keys(d.emt_review).length) {
    db.prepare('UPDATE triage SET emt_review=? WHERE patient_id=?').run(JSON.stringify(d.emt_review), patientId);
  }
  // Up to 2 additional BP re-checks (only written when the key is present, so a
  // plain save never wipes them). Each keeps only the vitals fields.
  if (Object.prototype.hasOwnProperty.call(d, 'bp_rechecks') && Array.isArray(d.bp_rechecks)) {
    const cleaned = d.bp_rechecks
      .map((r) => ({ bp_systolic: toIntOrNull(r.bp_systolic), bp_diastolic: toIntOrNull(r.bp_diastolic), heart_rate: toIntOrNull(r.heart_rate) }))
      .filter((r) => r.bp_systolic != null || r.bp_diastolic != null || r.heart_rate != null)
      .slice(0, 2);
    db.prepare('UPDATE triage SET bp_rechecks=? WHERE patient_id=?').run(JSON.stringify(cleaned), patientId);
  }
  audit(actor, 'vitals', 'patient', patientId, `${sys == null ? '—' : sys}/${dia == null ? '—' : dia} HR ${hr == null ? '—' : hr}${hasBT ? ' · thinner:' + (bt || 'no') : ''}`);
  return getPatient(patientId);
}

// v1.0.9: the EMT station sends the patient onward after vitals — to the
// dentist, the hygienist, or both. This is what moves a patient into the
// treatment queues (patients.status 'triaged' is the legacy value the doctor
// and dashboard queues already key on, so routing reuses it).
const ROUTES = ['dentist', 'hygienist', 'both'];
// v1.5.24: vitals are a hard gate. A patient cannot reach a treatment chair
// without a blood pressure or pulse on file — the reading is what tells the
// dentist whether it is safe to give anaesthetic or extract, so a visit that
// skips it is not safe to treat. Enforced here rather than in the UI so every
// path (EMT station, admin override, sync) obeys the same rule.
function hasVitalsRecorded(patientId) {
  const tr = db.prepare('SELECT bp_systolic, heart_rate FROM triage WHERE patient_id = ?').get(patientId);
  return !!(tr && (tr.bp_systolic != null || tr.heart_rate != null));
}
function requireVitals(patientId) {
  if (!hasVitalsRecorded(patientId)) {
    throw new Error('Vitals have not been recorded yet. This patient must have their blood pressure or pulse taken at the vitals station before they can go to the dentist or hygienist.');
  }
}
function routePatient(actor, patientId, route) {
  if (!ROUTES.includes(route)) throw new Error('Choose where the patient goes next: dentist, hygienist, or both.');
  requireVitals(patientId);
  const tr = db.prepare('SELECT id FROM triage WHERE patient_id = ?').get(patientId);
  if (!tr) {
    db.prepare(`INSERT INTO triage (patient_id, status, route, routed_by, routed_at, emt_signed_off)
                VALUES (?, 'ready', ?, ?, ?, 1)`).run(patientId, route, actor ? actor.id : null, now());
  } else {
    db.prepare(`UPDATE triage SET route=?, routed_by=?, routed_at=?, emt_signed_off=1,
                  status = CASE WHEN status IN ('completed','in_treatment') THEN status ELSE 'ready' END
                WHERE patient_id=?`).run(route, actor ? actor.id : null, now(), patientId);
  }
  // Routing IS the EMT sign-off: it moves the patient out of the vitals queue and
  // into the chosen clinical queue (checked_in -> triaged). Re-routing later
  // (dentist <-> hygienist transfer) keeps whatever clinical status they're in.
  db.prepare("UPDATE patients SET status='triaged', updated_at=? WHERE id=? AND status='checked_in'").run(now(), patientId);
  audit(actor, 'route', 'patient', patientId, route);
  return getPatient(patientId);
}

// What still stands between this patient and being seen: the consents their
// visit needs, and a station to send them to. Used by the front desk's arrivals
// list and by confirmArrival below, so the screen and the guard can never
// disagree about what is missing.
function arrivalReadiness(patientId) {
  const p = db.prepare('SELECT id, dental_history, arrived_at FROM patients WHERE id = ?').get(patientId);
  if (!p) throw new Error('Patient not found.');
  const dental = safeJson(p.dental_history, {}) || {};
  const consents = db.prepare('SELECT type, signature_png FROM consents WHERE patient_id = ?').all(patientId);
  // A consent counts only when it carries an actual signature — an unsigned row
  // is a form that was opened, not a consent that was given.
  const signed = (type) => consents.some((c) => c.type === type && String(c.signature_png || '').trim().length > 0);
  const tr = db.prepare('SELECT route FROM triage WHERE patient_id = ?').get(patientId);
  const needsSurgery = visitNeedsSurgeryConsent(dental.visit_type);
  const route = (tr && tr.route) || routeFromVisitType(dental.visit_type) || null;
  return {
    patient_id: patientId,
    visit_type: dental.visit_type || null,
    general_signed: signed('general'),
    needs_surgery_consent: needsSurgery,
    surgery_signed: needsSurgery ? signed('oral_surgery') : true,
    route,
    arrived_at: p.arrived_at || null,
    get ready() { return this.general_signed && this.surgery_signed && !!this.route; },
  };
}

// The front desk marking a patient as physically present and ready to be seen.
// Deliberately refuses when a required consent is unsigned or no station is
// assigned — this is the last checkpoint before a patient enters clinical care.
function confirmArrival(actor, patientId, opts = {}) {
  const r = arrivalReadiness(patientId);
  const route = ['dentist', 'hygienist'].includes(opts.route) ? opts.route : r.route;
  if (!r.general_signed) throw new Error('The general consent has not been signed yet. Have the patient sign it before sending them through.');
  if (!r.surgery_signed) throw new Error('This patient is here for an extraction, so the Oral Surgery consent must be signed too.');
  if (!route) throw new Error('Choose which station this patient goes to: dentist or hygienist.');
  const tr = db.prepare('SELECT id FROM triage WHERE patient_id = ?').get(patientId);
  if (!tr) db.prepare("INSERT INTO triage (patient_id, status, route) VALUES (?, 'waiting', ?)").run(patientId, route);
  else db.prepare('UPDATE triage SET route = ? WHERE patient_id = ?').run(route, patientId);
  // Presence only — they still go to vitals next. This does NOT skip a station.
  db.prepare('UPDATE patients SET arrived_at = ?, arrived_by_name = ?, updated_at = ? WHERE id = ?')
    .run(now(), (actor && actor.full_name) || null, now(), patientId);
  audit(actor, 'arrive', 'patient', patientId, route);
  return getPatient(patientId);
}

// A consent completed chairside for an EXISTING patient — e.g. the dentist has the
// patient sign the oral-surgery consent at the chair (capturing the tooth numbers
// at the same time), or captures a general consent the intake missed.
function addPatientConsent(actor, patientId, consent) {
  const p = db.prepare('SELECT id FROM patients WHERE id = ?').get(patientId);
  if (!p) throw new Error('Patient not found.');
  const c = consent || {};
  if (c.type !== 'general' && c.type !== 'oral_surgery') throw new Error('Unknown consent type.');
  const teeth = c.tooth_numbers != null && String(c.tooth_numbers).trim() ? String(c.tooth_numbers).trim() : null;
  db.prepare(
    `INSERT INTO consents (patient_id, type, version, language, signer_name, relationship, signature_png, signed_at, tooth_numbers, amended_by, amended_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    patientId, c.type, c.version || `${c.type}-${c.language || 'en'}-chairside-v1`, c.language || 'en',
    c.signer_name || '', c.relationship || '', c.signature_png || '', c.signed_at || now(),
    teeth, teeth ? (actor ? actor.full_name : null) : null, teeth ? now() : null
  );
  audit(actor, 'consent_add', 'patient', patientId, c.type + (teeth ? ' · teeth ' + teeth : ''));
  return getPatient(patientId);
}

// Doctor adds tooth number(s) to an oral-surgery consent AFTER the patient signed.
function updateConsentTeeth(actor, consentId, toothNumbers) {
  const c = db.prepare("SELECT * FROM consents WHERE id = ? AND type = 'oral_surgery'").get(consentId);
  if (!c) throw new Error('Oral surgery consent not found.');
  db.prepare('UPDATE consents SET tooth_numbers=?, amended_by=?, amended_at=? WHERE id=?')
    .run(String(toothNumbers || '').trim(), actor ? actor.full_name : null, now(), consentId);
  audit(actor, 'consent_teeth', 'patient', c.patient_id, String(toothNumbers || ''));
  return getPatient(c.patient_id);
}

// Checkout staff dismiss a patient — only after the provider has signed off.
function dismissPatient(actor, id) {
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!p) throw new Error('Patient not found.');
  // v1.2.1: patients move through the stations freely — check-out no longer
  // requires the provider to have signed off and LOCKED the record. We only
  // guard the obvious cases so nobody is dismissed before they've been seen.
  if (p.status === 'dismissed') throw new Error('Patient is already checked out.');
  if (p.status === 'checked_in') throw new Error('Patient still needs vitals from the EMT/nurse before check-out.');
  db.prepare("UPDATE patients SET status='dismissed', dismissed_by=?, dismissed_at=?, updated_at=? WHERE id=?")
    .run(actor ? actor.id : null, now(), now(), id);
  audit(actor, 'dismiss', 'patient', id, `${p.first_name} ${p.last_name}`.trim());
  return getPatient(id);
}

// v1.4.0: admin management override — move a patient to any stage regardless of
// the normal flow (send back to vitals, re-route, re-open a finished record so it
// can be edited again, or check them out). Admin-only via the IPC role matrix.
// Where an admin can move a patient, forwards or back. 'checkin' and 'emt' walk
// the patient BACK up the flow; the rest move them on.
const MOVE_TARGETS = ['checkin', 'emt', 'dentist', 'hygienist', 'reopen', 'dismiss'];
function adminMovePatient(actor, id, target) {
  if (!MOVE_TARGETS.includes(target)) throw new Error('Unknown move target.');
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!p) throw new Error('Patient not found.');
  // Moving TO a treatment chair still obeys the vitals gate, so an override
  // can't quietly walk a patient past the vitals station.
  if (target === 'dentist' || target === 'hygienist') return routePatient(actor, id, target);
  if (target === 'checkin') {
    // All the way back to the front desk: they are no longer confirmed present,
    // no longer signed off by the EMT, and no longer assigned onward. Recorded
    // vitals are kept — they are clinical facts, not workflow state — so the
    // patient reappears in the arrivals list and the vitals queue.
    db.prepare(`UPDATE patients SET status='checked_in', arrived_at=NULL, arrived_by_name=NULL,
                  dismissed_by=NULL, dismissed_by_name=NULL, dismissed_at=NULL, updated_at=? WHERE id=?`).run(now(), id);
    db.prepare(`UPDATE triage SET route=NULL, routed_by=NULL, routed_at=NULL, emt_signed_off=0,
                  status='waiting' WHERE patient_id=?`).run(id);
    db.prepare('UPDATE treatments SET locked=0 WHERE patient_id=?').run(id);
  } else if (target === 'emt') {
    // Back to the vitals queue: undo the EMT sign-off that sent them onward, so
    // they are genuinely waiting to be seen again rather than sitting in a
    // treatment queue with a 'checked_in' label.
    db.prepare(`UPDATE patients SET status='checked_in', dismissed_by=NULL, dismissed_by_name=NULL,
                  dismissed_at=NULL, updated_at=? WHERE id=?`).run(now(), id);
    db.prepare(`UPDATE triage SET routed_at=NULL, emt_signed_off=0,
                  status='waiting' WHERE patient_id=?`).run(id);
    db.prepare('UPDATE treatments SET locked=0 WHERE patient_id=?').run(id);
  } else if (target === 'reopen') {
    // Bring a completed OR dismissed patient back into treatment and unlock the
    // record so it can be edited again (clears any dismissal).
    db.prepare("UPDATE patients SET status='in_treatment', dismissed_by=NULL, dismissed_by_name=NULL, dismissed_at=NULL, updated_at=? WHERE id=?").run(now(), id);
    db.prepare('UPDATE treatments SET locked=0 WHERE patient_id=?').run(id);
    db.prepare("UPDATE triage SET status='in_treatment' WHERE patient_id=? AND status='completed'").run(id);
  } else if (target === 'dismiss') {
    // Admin override: check a patient out from any stage.
    db.prepare("UPDATE patients SET status='dismissed', dismissed_by=?, dismissed_at=?, updated_at=? WHERE id=?").run(actor ? actor.id : null, now(), now(), id);
  }
  audit(actor, 'admin_move', 'patient', id, target);
  return getPatient(id);
}

// Per-patient action log (who did what, when) — for the accountability views.
function patientAudit(id) {
  return db.prepare(
    "SELECT user_name, action, entity, detail, created_at FROM audit_log WHERE entity = 'patient' AND entity_id = ? ORDER BY id DESC LIMIT 100"
  ).all(id);
}

// USB import: upsert a portable patient record (match by id, else name+dob+event).
function importPatientFromPortable(actor, portable) {
  if (!portable || !portable.first_name) throw new Error('Invalid patient file.');
  const evId = Number(getSetting('active_event_id'));
  let existing = portable.id ? db.prepare('SELECT * FROM patients WHERE id = ?').get(portable.id) : null;
  if (!existing) {
    existing = db.prepare('SELECT * FROM patients WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?) AND (dob = ? OR ? IS NULL) ORDER BY created_at DESC')
      .get(portable.first_name, portable.last_name, portable.dob, portable.dob);
  }
  let pid;
  if (existing) {
    pid = existing.id;
    updatePatient(actor, pid, {
      language: portable.language, first_name: portable.first_name, last_name: portable.last_name,
      dob: portable.dob, gender: portable.gender, phone: portable.phone, email: portable.email,
      demographics: portable.demographics, medical_history: portable.medical_history, dental_history: portable.dental_history,
    });
  } else {
    const created = createPatient(actor, portable);
    pid = created.id;
    (portable.consents || []).forEach((c) => addConsent(pid, c));
  }
  // Triage, treatment, vitals, x-rays from the portable file.
  if (portable.triage) saveTriage(actor, pid, portable.triage);
  if (portable.treatment) {
    // Preserve the treatment's completion state on import: a locked record stays
    // locked, a completed-but-unlocked record stays completed (v1.2.1 "Mark visit
    // complete"), and only a genuinely in-progress record imports as such —
    // otherwise USB checkout silently reverted completed visits to in_treatment.
    const t = portable.treatment;
    const mode = t.locked ? 'lock' : (t.completed_at ? 'complete' : false);
    saveTreatment(actor, pid, t, mode);
  }
  (portable.xrays || []).forEach((x) => { if (x.image_png) db.prepare('INSERT INTO xrays (patient_id, station, image_png, note, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(pid, x.station || null, x.image_png, x.note || null, x.created_at || now(), now()); });
  recountXrays(pid);
  audit(actor, 'usb_import', 'patient', pid, `${portable.first_name} ${portable.last_name}`.trim());
  return getPatient(pid);
}

// eventId: a numeric id, or 'all' to span every event, or omitted = active event.
function listPatients({ eventId, search } = {}) {
  const allEvents = eventId === 'all';
  const evId = allEvents ? null : (eventId || Number(getSetting('active_event_id')));
  let sql = 'SELECT p.*, e.name AS event_name FROM patients p JOIN events e ON e.id = p.event_id';
  const args = [];
  const where = [];
  if (!allEvents) { where.push('p.event_id = ?'); args.push(evId); }
  if (search) {
    where.push('(lower(p.first_name) LIKE ? OR lower(p.last_name) LIKE ? OR p.phone LIKE ? OR p.dob LIKE ?)');
    const s = `%${String(search).toLowerCase()}%`;
    args.push(s, s, `%${search}%`, `%${search}%`);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY p.created_at DESC';
  return db.prepare(sql).all(...args).map((p) => {
    const pt = rowToPatient(p);
    const tr = db.prepare('SELECT status, complaint, flags, assigned_to, route, bp_systolic, bp_diastolic, heart_rate, blood_thinner, emt_signed_off, vitals_at, routed_at FROM triage WHERE patient_id = ?').get(p.id);
    return {
      id: pt.id,
      first_name: pt.first_name,
      last_name: pt.last_name,
      dob: pt.dob,
      age: pt.age,
      gender: pt.gender,
      language: pt.language,
      status: pt.status,
      created_at: pt.created_at,
      event_id: p.event_id,
      event_name: p.event_name,
      email: pt.email || (pt.demographics && pt.demographics.email) || null,
      phone: pt.phone || null,
      triage_status: tr ? tr.status : null,
      complaint: tr ? tr.complaint : null,
      flags: tr ? safeJson(tr.flags, []) : [],
      assigned_to: tr ? tr.assigned_to : null,
      route: tr ? tr.route : null,
      has_vitals: !!(tr && (tr.bp_systolic != null || tr.heart_rate != null)),
      preregistered: !!(pt.demographics && pt.demographics.preregistered),
      // v1.5.24: front-desk arrival state — confirmed present, and whether the
      // consents this visit needs are actually signed.
      arrived_at: p.arrived_at || null,
      visit_type: (pt.dental_history && pt.dental_history.visit_type) || null,
      consents_ok: (() => { try { const r = arrivalReadiness(p.id); return r.general_signed && r.surgery_signed; } catch { return false; } })(),
      // Stage timestamps for the live board's "total time" + "time at stage" tags.
      vitals_at: tr ? tr.vitals_at : null,
      routed_at: tr ? tr.routed_at : null,
      dismissed_at: pt.dismissed_at || null,
      emt_signed_off: !!(tr && tr.emt_signed_off),
      blood_thinner: tr ? tr.blood_thinner : null,
      // Reconciled thinner signal so the QUEUES can't understate the risk: true if
      // the EMT confirmed it, OR a thinner is in the med list, OR the patient
      // self-reported the condition at check-in. Queue pills read this.
      on_thinner: (tr && tr.blood_thinner === 'yes') || detectsBloodThinner(pt.medical_history),
    };
  });
}

// Backend mirror of the renderer's blood-thinner detection (medFlags.js), used so
// listPatients can expose a reconciled on_thinner to the queue views (which don't
// carry the full medical history). Keep this list in sync with medFlags.js.
const BLOOD_THINNER_MEDS = [
  'eliquis', 'apixaban', 'warfarin', 'coumadin', 'xarelto', 'rivaroxaban', 'plavix', 'clopidogrel',
  'pradaxa', 'dabigatran', 'aspirin', 'asa', 'heparin', 'lovenox', 'enoxaparin', 'brilinta',
  'ticagrelor', 'effient', 'prasugrel', 'savaysa', 'edoxaban', 'aggrenox', 'pletal', 'cilostazol',
];
function detectsBloodThinner(mh) {
  const m = mh || {};
  const medHit = ((m.medications) || []).some((x) => {
    const n = (x && x.name ? x.name : '').toLowerCase();
    return n && BLOOD_THINNER_MEDS.some((b) => n.split(/[^a-z]+/).includes(b) || n.includes(b));
  });
  const condHit = ((m.conditions) || []).some((k) => k === 'blood_thinners' || k === 'bleeding');
  return medHit || condHit;
}

// Returning-patient lookup across ALL events.
function searchAllPatients(term) {
  const s = `%${String(term || '').toLowerCase()}%`;
  return db.prepare(
    `SELECT p.*, e.name AS event_name FROM patients p
     JOIN events e ON e.id = p.event_id
     WHERE lower(p.first_name) LIKE ? OR lower(p.last_name) LIKE ? OR p.phone LIKE ? OR p.dob LIKE ?
     ORDER BY p.created_at DESC LIMIT 50`
  ).all(s, s, `%${term}%`, `%${term}%`).map((p) => ({
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    dob: p.dob,
    age: ageFromDob(p.dob),
    phone: p.phone,
    event_name: p.event_name,
    created_at: p.created_at,
  }));
}

/* ------------------------------------------------------------------ */
/*  Triage                                                             */
/* ------------------------------------------------------------------ */

function saveTriage(actor, patientId, data) {
  const existing = db.prepare('SELECT id FROM triage WHERE patient_id = ?').get(patientId);
  const d = data || {};
  if (existing) {
    db.prepare(
      `UPDATE triage SET complaint=?, flags=?, checklist=?, teeth=?, teeth_notes=?, notes=?,
         xray_count=?, xray_station=?, assigned_to=?, status=?,
         triage_signature=?, triage_signer_name=?, triaged_by=?, triaged_at=?
       WHERE patient_id=?`
    ).run(
      d.complaint || null,
      JSON.stringify(d.flags || []),
      JSON.stringify(d.checklist || {}),
      JSON.stringify(d.teeth || []),
      JSON.stringify(d.teeth_notes || {}),
      d.notes || null,
      d.xray_count || 0,
      d.xray_station || null,
      d.assigned_to || null,
      d.status || 'ready',
      d.triage_signature || null,
      d.triage_signer_name || null,
      actor ? actor.id : null,
      now(),
      patientId
    );
  } else {
    db.prepare(
      `INSERT INTO triage (patient_id, complaint, flags, checklist, teeth, teeth_notes, notes,
          xray_count, xray_station, assigned_to, status, triage_signature, triage_signer_name, triaged_by, triaged_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      patientId, d.complaint || null, JSON.stringify(d.flags || []),
      JSON.stringify(d.checklist || {}), JSON.stringify(d.teeth || []), JSON.stringify(d.teeth_notes || {}), d.notes || null,
      d.xray_count || 0, d.xray_station || null, d.assigned_to || null,
      d.status || 'ready', d.triage_signature || null, d.triage_signer_name || null,
      actor ? actor.id : null, now()
    );
  }
  if (d.status === 'ready') {
    db.prepare('UPDATE patients SET status = ?, updated_at = ? WHERE id = ?').run('triaged', now(), patientId);
  }
  audit(actor, 'triage', 'patient', patientId, d.status || 'saved');
  return getPatient(patientId);
}

/* ------------------------------------------------------------------ */
/*  Treatment                                                          */
/* ------------------------------------------------------------------ */

function saveTreatment(actor, patientId, data, finalize) {
  const existing = db.prepare('SELECT * FROM treatments WHERE patient_id = ?').get(patientId);
  if (existing && existing.locked) throw new Error('This record is locked and signed off.');
  const d = data || {};
  // v1.2.1: decouple "complete" from "lock". Patients move through the stations
  // without being forced to sign off and lock a record. finalize can be:
  //   falsy      -> save progress (status in_treatment), record stays editable
  //   'complete' -> mark the visit done (status completed) but NOT locked/editable
  //   'lock'/true-> mark done AND lock the record read-only (optional sign-off)
  const lock = finalize === true || finalize === 'lock';
  const complete = lock || finalize === 'complete';
  if (existing) {
    db.prepare(
      `UPDATE treatments SET fillings=?, extractions=?, cleaning=?, anesthetic=?,
         other_procedures=?, clinical_notes=?, provider_name=?, provider_signature=?,
         locked=?, completed_by=?, completed_at=?
       WHERE patient_id=?`
    ).run(
      JSON.stringify(d.fillings || []),
      JSON.stringify(d.extractions || []),
      JSON.stringify(d.cleaning || {}),
      JSON.stringify(d.anesthetic || []),
      d.other_procedures || null,
      d.clinical_notes || null,
      d.provider_name || null,
      d.provider_signature || null,
      lock ? 1 : 0,
      complete ? (actor ? actor.id : null) : null,
      complete ? now() : null,
      patientId
    );
  } else {
    db.prepare(
      `INSERT INTO treatments (patient_id, fillings, extractions, cleaning, anesthetic,
          other_procedures, clinical_notes, provider_name, provider_signature, locked, completed_by, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      patientId, JSON.stringify(d.fillings || []), JSON.stringify(d.extractions || []),
      JSON.stringify(d.cleaning || {}), JSON.stringify(d.anesthetic || []),
      d.other_procedures || null, d.clinical_notes || null, d.provider_name || null,
      d.provider_signature || null, lock ? 1 : 0,
      complete ? (actor ? actor.id : null) : null, complete ? now() : null
    );
  }
  if (complete) {
    db.prepare('UPDATE patients SET status = ?, updated_at = ? WHERE id = ?').run('completed', now(), patientId);
    db.prepare("UPDATE triage SET status = 'completed' WHERE patient_id = ?").run(patientId);
  } else {
    db.prepare('UPDATE patients SET status = ?, updated_at = ? WHERE id = ?').run('in_treatment', now(), patientId);
    db.prepare("UPDATE triage SET status = 'in_treatment' WHERE patient_id = ? AND status != 'completed'").run(patientId);
  }
  audit(actor, lock ? 'sign_off' : complete ? 'complete' : 'treatment', 'patient', patientId, null);
  return getPatient(patientId);
}

/* ------------------------------------------------------------------ */
/*  X-rays                                                             */
/* ------------------------------------------------------------------ */

function recountXrays(patientId) {
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM xrays WHERE patient_id = ?').get(patientId).n;
  db.prepare('UPDATE triage SET xray_count = ? WHERE patient_id = ?').run(cnt, patientId);
  return cnt;
}

function addXray(actor, patientId, { station, image_png, note, tooth }) {
  const info = db.prepare(
    `INSERT INTO xrays (patient_id, station, image_png, note, tooth, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`
  ).run(patientId, station || null, image_png, note || null, tooth != null && String(tooth).trim() ? String(tooth).trim() : null, now(), now());
  recountXrays(patientId);
  audit(actor, 'xray', 'patient', patientId, [station ? `station ${station}` : 'uploaded', tooth ? `tooth ${tooth}` : null].filter(Boolean).join(' · '));
  return { id: info.lastInsertRowid, count: recountXrays(patientId) };
}

// Assign / change the tooth an x-ray belongs to (dentist, chairside).
function updateXrayTooth(actor, id, tooth) {
  const row = db.prepare('SELECT patient_id FROM xrays WHERE id = ?').get(id);
  if (!row) throw new Error('X-ray not found.');
  const t = tooth != null && String(tooth).trim() ? String(tooth).trim() : null;
  db.prepare('UPDATE xrays SET tooth = ?, updated_at = ? WHERE id = ?').run(t, now(), id);
  audit(actor, 'xray_tooth', 'patient', row.patient_id, `#${id} → ${t || '—'}`);
  return { id, tooth: t };
}

function getXray(id) {
  return db.prepare('SELECT * FROM xrays WHERE id = ?').get(id);
}

// Full x-ray list WITH image data — used by the provider gallery.
function listXrays(patientId) {
  return db.prepare(
    'SELECT id, patient_id, station, note, tooth, image_png, created_at FROM xrays WHERE patient_id = ? ORDER BY id'
  ).all(patientId);
}

function deleteXray(actor, id) {
  const row = db.prepare('SELECT patient_id FROM xrays WHERE id = ?').get(id);
  if (!row) throw new Error('X-ray not found.');
  db.prepare('DELETE FROM xrays WHERE id = ?').run(id);
  const count = recountXrays(row.patient_id);
  audit(actor, 'xray_delete', 'patient', row.patient_id, `#${id}`);
  return { count };
}

/* ------------------------------------------------------------------ */
/*  Dashboard stats & audit                                           */
/* ------------------------------------------------------------------ */

function dashboardStats() {
  const evId = Number(getSetting('active_event_id'));
  const base = 'SELECT COUNT(*) AS n FROM patients WHERE event_id = ?';
  const count = (extra, ...a) => db.prepare(base + extra).get(evId, ...a).n;
  return {
    total: count(''),
    checked_in: count(" AND status = 'checked_in'"),
    triaged: count(" AND status = 'triaged'"),
    in_treatment: count(" AND status = 'in_treatment'"),
    completed: count(" AND status = 'completed'"),
    // "Waiting for vitals" = checked in, no vitals taken yet. This must be read
    // from the PATIENT's state, not from a triage row: a triage row is created
    // by the in-person check-in, but a patient who PRE-REGISTERED online arrives
    // as a patient row alone, so an inner join to triage counted the walk-ins and
    // silently ignored everyone who pre-registered. Now it matches what the live
    // board's "Checked in" column and the vitals station queue already show
    // (both key on status + whether a BP/pulse has been recorded).
    waiting_triage: db.prepare(
      `SELECT COUNT(*) AS n FROM patients p LEFT JOIN triage t ON t.patient_id = p.id
       WHERE p.event_id = ? AND p.status = 'checked_in'
         AND t.bp_systolic IS NULL AND t.heart_rate IS NULL`
    ).get(evId).n,
  };
}

function listAudit(limit = 200) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

/* ------------------------------------------------------------------ */
/*  Backup / export                                                    */
/* ------------------------------------------------------------------ */

function backupTo(destPath) {
  // better-sqlite3 online backup -> single consistent .db file
  return db.backup(destPath);
}

/* ---------------- Clinic bundle: export, restore, purge ----------------- */

// A COMPLETE, restorable copy of one clinic event — raw rows, uids and all,
// including the things a spreadsheet cannot hold (consent signatures, x-ray
// images). This is the file that makes it safe to wipe a laptop after a clinic:
// the spreadsheet is for reading, this is for putting the clinic back.
const BUNDLE_FORMAT = 'caring-hands-clinic';
const BUNDLE_VERSION = 1;
function exportClinicBundle(eventId) {
  // uids are normally handed out lazily by the first cloud sync. A clinic that
  // ran entirely offline would otherwise export rows with no uid at all, and
  // nothing could be matched on restore — every re-import would duplicate the
  // whole clinic and every consent and x-ray would be dropped.
  ensureUids();
  const evId = eventId || Number(getSetting('active_event_id'));
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(evId);
  if (!event) throw new Error('No clinic event to export.');
  const patients = db.prepare('SELECT * FROM patients WHERE event_id = ?').all(evId);
  const ids = patients.map((p) => p.id);
  const kids = (table) => (ids.length
    ? db.prepare(`SELECT * FROM ${table} WHERE patient_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : []);
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exported_at: now(),
    event,
    patients,
    triage: kids('triage'),
    treatments: kids('treatments'),
    consents: kids('consents'),
    xrays: kids('xrays'),
  };
}

// Put a clinic back. Matched by uid, so re-importing the same file twice cannot
// duplicate anyone, and importing a clinic that is partly still present merges
// rather than doubling it.
function importClinicBundle(actor, bundle) {
  const b = bundle || {};
  if (b.format !== BUNDLE_FORMAT) throw new Error('That is not a Caring Hands clinic backup file.');
  if (!b.event || !Array.isArray(b.patients)) throw new Error('This backup file is incomplete or damaged.');

  const counts = { patients: 0, updated: 0, consents: 0, xrays: 0 };
  const tx = db.transaction(() => {
    // The event first — everything else hangs off it.
    let ev = b.event.uid ? db.prepare('SELECT * FROM events WHERE uid = ?').get(b.event.uid) : null;
    if (!ev) ev = db.prepare('SELECT * FROM events WHERE name = ? AND created_at = ?').get(b.event.name, b.event.created_at);
    let eventId;
    if (ev) {
      eventId = ev.id;
    } else {
      const info = db.prepare(
        `INSERT INTO events (uid, name, location, start_date, end_date, languages, active, created_at, selected_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(b.event.uid || crypto.randomUUID(), b.event.name, b.event.location || '', b.event.start_date || today(),
        b.event.end_date || '', b.event.languages || 'en,es', 0, b.event.created_at || now(), null);
      eventId = info.lastInsertRowid;
    }

    // Patients, keyed by uid so a repeat import updates instead of duplicating.
    const PCOLS = ['language', 'first_name', 'last_name', 'dob', 'gender', 'phone', 'email',
      'demographics', 'medical_history', 'dental_history', 'status', 'created_at', 'updated_at',
      'dismissed_at', 'dismissed_by_name', 'arrived_at', 'arrived_by_name'];
    const idByUid = new Map();
    for (const p of b.patients) {
      const uid = p.uid || crypto.randomUUID();
      const existing = db.prepare('SELECT id FROM patients WHERE uid = ?').get(uid);
      if (existing) {
        db.prepare(`UPDATE patients SET ${PCOLS.map((c) => c + '=?').join(', ')}, event_id=? WHERE id=?`)
          .run(...PCOLS.map((c) => (p[c] === undefined ? null : p[c])), eventId, existing.id);
        idByUid.set(uid, existing.id);
        counts.updated++;
      } else {
        const info = db.prepare(
          `INSERT INTO patients (uid, event_id, ${PCOLS.join(', ')}) VALUES (?, ?, ${PCOLS.map(() => '?').join(', ')})`
        ).run(uid, eventId, ...PCOLS.map((c) => (p[c] === undefined ? null : p[c])));
        idByUid.set(uid, info.lastInsertRowid);
        counts.patients++;
      }
    }

    // Child rows. triage/treatments are one-per-patient, so they upsert on the
    // patient rather than on their own uid.
    const childOf = (row) => {
      const puid = (b.patients.find((p) => p.id === row.patient_id) || {}).uid;
      return puid ? idByUid.get(puid) : null;
    };
    const restoreOnePerPatient = (table, cols) => {
      for (const row of (b[table] || [])) {
        const pid = childOf(row);
        if (!pid) continue;
        const existing = db.prepare(`SELECT id FROM ${table} WHERE patient_id = ?`).get(pid);
        const vals = cols.map((c) => (row[c] === undefined ? null : row[c]));
        if (existing) {
          db.prepare(`UPDATE ${table} SET ${cols.map((c) => c + '=?').join(', ')} WHERE id=?`).run(...vals, existing.id);
        } else {
          db.prepare(`INSERT INTO ${table} (uid, patient_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
            .run(row.uid || crypto.randomUUID(), pid, ...vals);
        }
      }
    };
    const restoreMany = (table, cols, counterKey) => {
      for (const row of (b[table] || [])) {
        const pid = childOf(row);
        if (!pid) continue;
        const uid = row.uid || crypto.randomUUID();
        const existing = db.prepare(`SELECT id FROM ${table} WHERE uid = ?`).get(uid);
        const vals = cols.map((c) => (row[c] === undefined ? null : row[c]));
        if (existing) {
          db.prepare(`UPDATE ${table} SET ${cols.map((c) => c + '=?').join(', ')} WHERE id=?`).run(...vals, existing.id);
        } else {
          db.prepare(`INSERT INTO ${table} (uid, patient_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
            .run(uid, pid, ...vals);
          if (counterKey) counts[counterKey]++;
        }
      }
    };
    restoreOnePerPatient('triage', SYNC_COLS.triage);
    restoreOnePerPatient('treatments', SYNC_COLS.treatment);
    restoreMany('consents', SYNC_COLS.consent, 'consents');
    restoreMany('xrays', SYNC_COLS.xray, 'xrays');
    return eventId;
  });
  const eventId = tx();
  // A restored record must not be re-deleted by its own tombstone on the next
  // sync — and the cloud copy must be re-published, so clear the sent marker.
  const uids = [];
  for (const p of (b.patients || [])) if (p.uid) uids.push(p.uid);
  for (const t of ['triage', 'treatments', 'consents', 'xrays']) {
    for (const r of (b[t] || [])) if (r.uid) uids.push(r.uid);
  }
  if (uids.length) {
    const chunk = 400;
    for (let i = 0; i < uids.length; i += chunk) {
      const part = uids.slice(i, i + chunk);
      db.prepare(`DELETE FROM tombstones WHERE uid IN (${part.map(() => '?').join(',')})`).run(...part);
    }
  }
  audit(actor, 'import', 'event', eventId, `${counts.patients} restored, ${counts.updated} updated`);
  return { ok: true, event_id: eventId, ...counts };
}

// The de-identified figures a finished clinic leaves behind. Everything here is
// a count or a band — there is no row that belongs to a person, so it can sit on
// the server indefinitely without holding patient information.
function buildEventSummary(eventId) {
  const evId = eventId || Number(getSetting('active_event_id'));
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(evId);
  const patients = db.prepare('SELECT * FROM patients WHERE event_id = ?').all(evId).map(rowToPatient);
  const bump = (o, k) => { const key = k || 'Not recorded'; o[key] = (o[key] || 0) + 1; };
  const ageBand = (a) => (a == null ? 'Not recorded' : a < 18 ? 'Under 18' : a < 35 ? '18–34' : a < 55 ? '35–54' : '55+');
  const by_gender = {}, by_age = {}, by_language = {}, by_city = {}, by_day = {}, conditions = {}, visit_types = {};
  let extractions = 0, fillings = 0, cleanings = 0, xrays = 0, completed = 0;
  for (const p of patients) {
    const d = p.demographics || {}, m = p.medical_history || {}, dh = p.dental_history || {};
    bump(by_gender, p.gender); bump(by_age, ageBand(p.age)); bump(by_language, p.language);
    bump(by_city, d.city ? (d.city + (d.state ? ', ' + d.state : '')) : 'Not recorded');
    bump(by_day, String(p.created_at || '').slice(0, 10) || 'Not recorded');
    bump(visit_types, dh.visit_type);
    (m.conditions || []).forEach((c) => bump(conditions, c));
    if (p.status === 'completed' || p.status === 'dismissed') completed++;
    const t = db.prepare('SELECT * FROM treatments WHERE patient_id = ?').get(p.id);
    if (t) {
      extractions += safeJson(t.extractions, []).length;
      fillings += safeJson(t.fillings, []).length;
      const cl = safeJson(t.cleaning, {});
      if (cl && Object.keys(cl).length) cleanings++;
    }
    xrays += db.prepare('SELECT COUNT(*) AS n FROM xrays WHERE patient_id = ?').get(p.id).n;
  }
  return {
    event_name: event ? event.name : null,
    event_location: event ? event.location : null,
    event_start: event ? event.start_date : null,
    patients_seen: patients.length,
    visits_completed: completed,
    extractions, fillings, cleanings, xrays,
    by_gender, by_age, by_language, by_city, by_day, visit_types,
    conditions,
    generated_at: now(),
  };
}

// Remove every patient record for an event from THIS device and, via tombstones,
// from the cloud and every other station. Irreversible by design — the caller is
// expected to have exported a backup first, which the UI enforces.
function purgeEventPatients(actor, eventId) {
  const evId = eventId || Number(getSetting('active_event_id'));
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(evId);
  if (!ev) throw new Error('Event not found.');
  ensureUids(); // nothing can be tombstoned that has no uid yet
  const patients = db.prepare('SELECT id, uid FROM patients WHERE event_id = ?').all(evId);
  const tomb = db.prepare(
    `INSERT INTO tombstones (uid, entity, event_uid, updated_at, synced_rev, created_at)
     VALUES (?,?,?,?,NULL,?) ON CONFLICT(uid) DO UPDATE SET synced_rev = NULL, updated_at = excluded.updated_at`
  );
  // Deleting the patient row locally cascades to the chart, but the CLOUD holds
  // each row separately — so every child needs its own tombstone. Miss them and
  // the consent signatures and x-ray images (the most identifying data in the
  // system) stay in the cloud forever and are re-served to every station.
  const CHILDREN = [['triage', 'triage'], ['treatments', 'treatment'], ['consents', 'consent'], ['xrays', 'xray']];
  const tx = db.transaction(() => {
    for (const p of patients) {
      for (const [table, entity] of CHILDREN) {
        for (const c of db.prepare(`SELECT uid FROM ${table} WHERE patient_id = ?`).all(p.id)) {
          if (c.uid) tomb.run(c.uid, entity, ev.uid || null, stampNow(), now());
        }
      }
      if (p.uid) tomb.run(p.uid, 'patient', ev.uid || null, stampNow(), now());
      db.prepare('DELETE FROM patients WHERE id = ?').run(p.id);
    }
    // A purged patient's rows may also be parked in the orphan buffer waiting for
    // a parent that will never come back; drop them or they are re-applied later.
    const purged = new Set(patients.map((p) => p.uid).filter(Boolean));
    const pending = safeJson(getSetting('cloud_pending'), []) || [];
    setSetting('cloud_pending', JSON.stringify(pending.filter((r) => !purged.has(r.patient_uid) && !purged.has(r.uid))));
  });
  tx();
  persistStamp();
  audit(actor, 'purge', 'event', evId, `${patients.length} patient record(s) removed`);
  return { ok: true, removed: patients.length, event_uid: ev.uid || null };
}

// Close a clinic: keep the de-identified figures, remove every patient record.
function finishEvent(actor, eventId) {
  const evId = eventId || Number(getSetting('active_event_id'));
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(evId);
  if (!ev) throw new Error('Event not found.');
  const summary = buildEventSummary(evId);
  const existing = db.prepare('SELECT id FROM event_reports WHERE event_id = ?').get(evId);
  if (existing) {
    db.prepare('UPDATE event_reports SET summary=?, patients_seen=?, finished_at=?, finished_by_name=?, updated_at=?, synced_rev=NULL, content_rev=NULL WHERE id=?')
      .run(JSON.stringify(summary), summary.patients_seen, now(), (actor && actor.full_name) || null, now(), existing.id);
  } else {
    db.prepare(`INSERT INTO event_reports (uid, event_id, summary, patients_seen, finished_at, finished_by_name, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), evId, JSON.stringify(summary), summary.patients_seen, now(),
        (actor && actor.full_name) || null, now(), now());
  }
  const purged = purgeEventPatients(actor, evId);
  db.prepare('UPDATE events SET active = 0 WHERE id = ?').run(evId);
  resolveActiveEvent();
  audit(actor, 'finish', 'event', evId, `${purged.removed} record(s) purged; report kept`);
  return { ok: true, summary, removed: purged.removed, event_uid: ev.uid || null };
}

function listEventReports() {
  return db.prepare(`SELECT r.*, e.name AS event_name, e.location AS event_location, e.start_date
                     FROM event_reports r LEFT JOIN events e ON e.id = r.event_id
                     ORDER BY r.finished_at DESC`).all()
    .map((r) => ({ ...r, summary: safeJson(r.summary, {}) }));
}

function exportEventJson(eventId) {
  const evId = eventId || Number(getSetting('active_event_id'));
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(evId);
  const patients = db.prepare('SELECT * FROM patients WHERE event_id = ?').all(evId).map((p) => {
    const full = getPatient(p.id);
    return full;
  });
  return { exported_at: now(), event, patients };
}

/* ================================================================== */
/*  v1.1.0 — CLOUD SYNC (row-level, uid-keyed, last-write-wins)        */
/*  Offline-first: these functions are only driven by cloud.js when an */
/*  admin enables sync. Dirtiness is content-based (a row's syncable   */
/*  fields are hashed) so no write path had to change.                 */
/* ================================================================== */

const ENTITY_TABLE = { event: 'events', user: 'users', report: 'event_reports', patient: 'patients', triage: 'triage', treatment: 'treatments', consent: 'consents', xray: 'xrays' };
// 'user' is applied right after 'event' (a scoped staff account is parented to an
// event, exactly like a patient) and before patients.
const APPLY_ORDER = ['event', 'user', 'report', 'patient', 'triage', 'treatment', 'consent', 'xray'];
// Syncable payload columns per entity (fixed order -> stable content hash).
const SYNC_COLS = {
  event: ['name', 'location', 'start_date', 'end_date', 'languages', 'active', 'created_at', 'selected_at'],
  // Staff account. salt+hash travel so the account can sign in on every laptop;
  // event scoping travels via event_uid (the parent), NULL for global admins.
  user: ['username', 'full_name', 'role', 'salt', 'hash', 'active', 'created_at'],
  patient: ['language', 'first_name', 'last_name', 'dob', 'gender', 'phone', 'email', 'demographics', 'medical_history', 'dental_history', 'status', 'created_at', 'dismissed_at', 'dismissed_by_name', 'arrived_at', 'arrived_by_name'],
  triage: ['complaint', 'flags', 'checklist', 'teeth', 'teeth_notes', 'notes', 'xray_count', 'xray_station', 'assigned_to', 'status', 'triage_signature', 'triage_signer_name', 'triaged_at', 'bp_systolic', 'bp_diastolic', 'heart_rate', 'vitals_at', 'blood_thinner', 'blood_thinner_detail', 'route', 'routed_at', 'emt_review', 'emt_signed_off', 'bp_rechecks', 'triaged_by_name', 'vitals_by_name', 'routed_by_name'],
  treatment: ['fillings', 'extractions', 'cleaning', 'anesthetic', 'other_procedures', 'clinical_notes', 'provider_name', 'provider_signature', 'locked', 'completed_at', 'completed_by_name'],
  consent: ['type', 'version', 'language', 'signer_name', 'relationship', 'signature_png', 'signed_at', 'tooth_numbers', 'amended_by', 'amended_at'],
  xray: ['station', 'image_png', 'note', 'created_at', 'tooth'],
  // v1.6.0: the de-identified totals a finished clinic leaves behind. Event-
  // scoped like a patient, so it survives on the server after the PHI is gone.
  report: ['summary', 'patients_seen', 'finished_at', 'finished_by_name', 'created_at'],
};
// Denormalized name field -> the local user-id column it is resolved from.
const NAME_SOURCE = {
  dismissed_by_name: 'dismissed_by', triaged_by_name: 'triaged_by',
  vitals_by_name: 'vitals_by', routed_by_name: 'routed_by', completed_by_name: 'completed_by',
};

function nameOfId(uid) { if (!uid) return null; const u = db.prepare('SELECT full_name FROM users WHERE id = ?').get(uid); return u ? u.full_name : null; }
// A globally-unique, totally-ordered revision stamp: a strictly-increasing
// per-device ISO time, PERSISTED across restarts (so a wall-clock rewind can't
// hand out an older stamp), with the device id appended so two devices can never
// produce an identical stamp. String comparison of these stamps is therefore a
// deterministic total order — used identically for the pull cursor AND for
// last-write-wins on both the server and the client, so ms-level ties can neither
// skip a row at a page boundary nor cause the two devices to disagree.
let _lastStamp = null;
function monotonicIso() {
  if (_lastStamp == null) _lastStamp = getSetting('cloud_last_stamp') || '';
  let t = now();
  if (t <= _lastStamp) t = new Date(Date.parse(_lastStamp || t) + 1).toISOString();
  _lastStamp = t;
  return t;
}
function stampNow() {
  return monotonicIso() + '@' + (getSetting('cloud_device_id') || '0');
}
function persistStamp() { if (_lastStamp) setSetting('cloud_last_stamp', _lastStamp); }
function sig(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
function uidOf(table, id) { if (!id) return null; const r = db.prepare(`SELECT uid FROM ${table} WHERE id = ?`).get(id); return r ? r.uid : null; }
function localIdByUid(table, uid) { if (!uid) return null; const r = db.prepare(`SELECT id FROM ${table} WHERE uid = ?`).get(uid); return r ? r.id : null; }

// Build the ordered, stable payload object for a row (denormalizing names).
function buildData(entity, row) {
  const out = {};
  for (const col of SYNC_COLS[entity]) {
    if (NAME_SOURCE[col]) {
      // Keep an already-stored name verbatim (including an empty string synced
      // from a peer) so its content hash is stable and it isn't re-pushed every
      // cycle; only resolve from the local user id when the column is null.
      out[col] = row[col] != null ? row[col] : (nameOfId(row[NAME_SOURCE[col]]) || null);
    } else {
      out[col] = row[col] === undefined ? null : row[col];
    }
  }
  return out;
}

// Give every syncable row a uid (once). Cheap, idempotent.
function ensureUids() {
  const tx = db.transaction(() => {
    for (const table of Object.values(ENTITY_TABLE)) {
      const missing = db.prepare(`SELECT id FROM ${table} WHERE uid IS NULL`).all();
      const upd = db.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`);
      for (const r of missing) upd.run(crypto.randomUUID(), r.id);
    }
  });
  tx();
}

// Local-change cursor: gather dirty rows (content sig != synced_rev) as sync
// envelopes. Stamps updated_at only when the content actually changed (tracked
// by content_rev) so an offline edit keeps its original timestamp for fair LWW.
function collectSyncRows(max = 400) {
  ensureUids();
  const rows = [];
  const mark = [];
  for (const entity of APPLY_ORDER) {
    if (rows.length >= max) break;
    const table = ENTITY_TABLE[entity];
    const all = db.prepare(`SELECT * FROM ${table}`).all();
    for (const row of all) {
      if (rows.length >= max) break;
      const data = buildData(entity, row);
      const s = sig(data);
      if (s === row.synced_rev) continue; // clean
      // Stamp updated_at only when the content is different from what it was
      // last stamped for (content_rev), keeping timestamps stable across retries.
      let updatedAt = row.updated_at;
      if (row.content_rev !== s || !updatedAt) {
        if (row.content_rev == null && updatedAt && !String(updatedAt).includes('@')) {
          // First sync of a pre-existing row: KEEP its real edit time (fair LWW)
          // but append the device id so the stamp is still globally unique and
          // totally ordered (no page-boundary ties across devices).
          updatedAt = String(updatedAt) + '@' + (getSetting('cloud_device_id') || '0');
          db.prepare(`UPDATE ${table} SET updated_at = ?, content_rev = ? WHERE id = ?`).run(updatedAt, s, row.id);
        } else {
          updatedAt = stampNow();
          db.prepare(`UPDATE ${table} SET updated_at = ?, content_rev = ? WHERE id = ?`).run(updatedAt, s, row.id);
        }
      }
      rows.push({
        entity, uid: row.uid,
        // Patients and (event-scoped) staff both hang off an event; a global admin
        // has event_id NULL -> event_uid NULL (no parent, never deferred on apply).
        event_uid: (entity === 'patient' || entity === 'user' || entity === 'report') ? uidOf('events', row.event_id) : null,
        patient_uid: (entity !== 'event' && entity !== 'patient' && entity !== 'user' && entity !== 'report') ? uidOf('patients', row.patient_id) : null,
        deleted: 0, updated_at: updatedAt, data,
      });
      mark.push({ table, id: row.id, sig: s });
    }
  }
  // Deletions travel too. A tombstone carries a uid and nothing else, so a
  // purge reaches every other station and the cloud instead of being quietly
  // undone by the next pull.
  for (const tomb of db.prepare('SELECT * FROM tombstones WHERE synced_rev IS NULL').all()) {
    if (rows.length >= max) break;
    rows.push({
      entity: tomb.entity, uid: tomb.uid,
      event_uid: tomb.event_uid || null, patient_uid: null,
      deleted: 1, updated_at: tomb.updated_at, data: {},
    });
    mark.push({ tombstone: tomb.uid });
  }
  persistStamp(); // survive restarts / clock rewinds
  return { rows, mark };
}

// Confirm rows as synced (called after a successful push). Only marks clean if
// the content hasn't changed again since it was collected.
function markSynced(mark) {
  const tx = db.transaction(() => {
    for (const m of (mark || [])) {
      if (m.tombstone) {
        db.prepare("UPDATE tombstones SET synced_rev = 'sent' WHERE uid = ?").run(m.tombstone);
        continue;
      }
      db.prepare(`UPDATE ${m.table} SET synced_rev = ? WHERE id = ? AND content_rev = ?`).run(m.sig, m.id, m.sig);
    }
  });
  tx();
}

// Apply remote envelopes into the local database (LWW), remapping parent uids to
// local ids and marking applied rows clean so they are never echoed back.
function applyRemoteRows(remoteRows) {
  const list = (remoteRows || []).slice().sort((a, b) => APPLY_ORDER.indexOf(a.entity) - APPLY_ORDER.indexOf(b.entity));
  let applied = 0, skipped = 0, deferred = 0;
  const deferredRows = [];
  const applyOne = (env) => {
    const entity = env.entity, table = ENTITY_TABLE[entity];
    if (!table || !env.uid) { skipped++; return; }
    // A tombstone from another station (or the cloud purge): remove the record
    // here too. Children cascade via the schema's ON DELETE CASCADE.
    if (env.deleted) {
      const hit = db.prepare(`SELECT id FROM ${table} WHERE uid = ?`).get(env.uid);
      if (hit) { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(hit.id); applied++; }
      else skipped++;
      // Remember the deletion locally too. Without this the record is gone now
      // but any station still holding an old copy re-creates it on the next
      // sync — the patient reappears and the deletion looks like it never took.
      // Marked 'sent' because this tombstone came FROM the cloud.
      db.prepare(`INSERT INTO tombstones (uid, entity, event_uid, updated_at, synced_rev, created_at)
                  VALUES (?,?,?,?,'sent',?)
                  ON CONFLICT(uid) DO UPDATE SET updated_at = excluded.updated_at`)
        .run(env.uid, entity, env.event_uid || null, env.updated_at || stampNow(), now());
      return;
    }
    // Was this record deleted here? A deletion beats any copy that is not newer
    // than the deletion itself. A copy that IS newer means the record was
    // deliberately brought back (a restore, or an edit after the delete), so the
    // tombstone is retired and the row applies normally.
    const tomb = db.prepare('SELECT updated_at FROM tombstones WHERE uid = ?').get(env.uid);
    if (tomb) {
      if (!(env.updated_at && String(env.updated_at) > String(tomb.updated_at))) { skipped++; return; }
      db.prepare('DELETE FROM tombstones WHERE uid = ?').run(env.uid);
    }
    if (!env.data) { skipped++; return; }
    const existing = db.prepare(`SELECT id, updated_at FROM ${table} WHERE uid = ?`).get(env.uid);
    if (existing && existing.updated_at && env.updated_at && existing.updated_at >= env.updated_at) { skipped++; return; }
    // Rebuild an ordered data object so the applied sig matches the origin's.
    const data = {};
    for (const col of SYNC_COLS[entity]) data[col] = env.data[col] === undefined ? null : env.data[col];
    const rowSig = sig(data);
    // Resolve parent local id.
    let parentCol = null, parentId = null;
    if (entity === 'patient' || entity === 'report') { parentCol = 'event_id'; parentId = localIdByUid('events', env.event_uid); if (!parentId) { deferred++; deferredRows.push(env); return; } }
    else if (entity === 'user') {
      // A staff account is parented to an event (NULL for a global admin). Defer a
      // scoped account whose event hasn't synced here yet; a NULL parent is fine.
      parentCol = 'event_id';
      if (env.event_uid) { parentId = localIdByUid('events', env.event_uid); if (!parentId) { deferred++; deferredRows.push(env); return; } }
      else parentId = null;
      // UNIQUE(username) guard: if a DIFFERENT local row already owns this username
      // (every device seeds its own 'admin'; two admins could also create the same
      // username offline), adopt that row's identity instead of a colliding INSERT
      // that would otherwise skip this account forever. LWW then reconciles fields.
      if (!existing) {
        const uname = env.data && env.data.username;
        const dupe = uname ? db.prepare('SELECT id FROM users WHERE username = ?').get(uname) : null;
        if (dupe) { db.prepare('UPDATE users SET uid = ? WHERE id = ?').run(env.uid, dupe.id); return applyOne(env); }
      }
    }
    else if (entity !== 'event') {
      parentCol = 'patient_id'; parentId = localIdByUid('patients', env.patient_uid); if (!parentId) { deferred++; deferredRows.push(env); return; }
      // Guard the UNIQUE(patient_id) tables (triage/treatments): if a row already
      // exists for this patient under a DIFFERENT uid, adopt it instead of a
      // colliding INSERT (can't happen in the normal single-check-in flow, but
      // keeps a stray/duplicate from wedging the whole batch).
      if (!existing && (table === 'triage' || table === 'treatments')) {
        const dupe = db.prepare(`SELECT id FROM ${table} WHERE patient_id = ?`).get(parentId);
        if (dupe) { db.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`).run(env.uid, dupe.id); return applyOne(env); }
      }
    }
    const cols = [...SYNC_COLS[entity]];
    const vals = cols.map((c) => data[c]);
    const extraCols = ['uid', 'updated_at', 'synced_rev', 'content_rev'];
    const extraVals = [env.uid, env.updated_at, rowSig, rowSig];
    if (parentCol) { extraCols.push(parentCol); extraVals.push(parentId); }
    if (existing) {
      // Include the parent FK (event_id / patient_id) in the UPDATE so a row that
      // was re-parented on another device (e.g. moved to the shared clinic event)
      // actually moves here too — not just on first INSERT.
      const upCols = [...cols, 'updated_at', 'synced_rev', 'content_rev'];
      const upVals = [...vals, env.updated_at, rowSig, rowSig];
      if (parentCol) { upCols.push(parentCol); upVals.push(parentId); }
      const setSql = upCols.map((c) => `${c} = ?`).join(', ');
      db.prepare(`UPDATE ${table} SET ${setSql} WHERE id = ?`).run(...upVals, existing.id);
    } else {
      const allCols = [...cols, ...extraCols];
      const ph = allCols.map(() => '?').join(', ');
      db.prepare(`INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${ph})`).run(...vals, ...extraVals);
    }
    applied++;
  };
  // Each row is applied in its own transaction so one malformed/poison row can
  // never roll back or wedge the whole pull batch — it is counted and skipped.
  for (const env of list) {
    try { db.transaction(applyOne)(env); }
    catch (e) { skipped++; }
  }
  // If any event synced in, re-resolve the clinic's active event so a "Set active"
  // performed on another laptop takes effect here too (highest selected_at wins).
  if (list.some((e) => e.entity === 'event')) resolveActiveEvent();
  // deferredRows = children whose parent wasn't present in THIS batch. The caller
  // (cloud.js) holds the sync cursor back so they are re-pulled, never lost.
  return { applied, skipped, deferred, deferredRows };
}

// Cloud config/state lives in the settings table under a cloud_ prefix.
// v1.2.3: the app ships ALWAYS-ONLINE. Every install auto-connects to the clinic
// cloud below with zero setup; the only thing a clinic ever changes is the simple
// Online / Run-offline switch (cloud_mode). Advanced users can still override the
// URL/key, and those saved values win over these baked defaults.
const DEFAULT_CLOUD = {
  url: 'https://little-block-222a.randy-982.workers.dev',
  key: 'randy',
};
function getSyncMeta() {
  const savedUrl = (getSetting('cloud_url') || '').trim();
  const savedKey = (getSetting('cloud_key') || '').trim();
  const url = savedUrl || DEFAULT_CLOUD.url;
  const key = savedKey || DEFAULT_CLOUD.key;
  // Online unless the clinic explicitly chose to run offline (no wifi).
  const mode = getSetting('cloud_mode') === 'offline' ? 'offline' : 'online';
  return {
    url, key, mode,
    enabled: mode === 'online' && !!url && !!key,
    usingDefaultCloud: !savedUrl,
    deviceId: getSetting('cloud_device_id') || '',
    cursor: getSetting('cloud_cursor') || '',
    lastPush: getSetting('cloud_last_push') || '',
    lastOk: getSetting('cloud_last_ok') || '',
    lastError: getSetting('cloud_last_error') || '',
  };
}
function setSyncMeta(patch) {
  const map = { url: 'cloud_url', key: 'cloud_key', mode: 'cloud_mode', deviceId: 'cloud_device_id', cursor: 'cloud_cursor', lastPush: 'cloud_last_push', lastOk: 'cloud_last_ok', lastError: 'cloud_last_error' };
  for (const [k, v] of Object.entries(patch || {})) {
    // Back-compat: an `enabled` boolean maps onto the online/offline mode.
    if (k === 'enabled') { setSetting('cloud_mode', v ? 'online' : 'offline'); continue; }
    if (!map[k]) continue;
    setSetting(map[k], v == null ? '' : String(v));
  }
  return getSyncMeta();
}
// Recovery hatch: forget where this station had got to and re-read the whole
// clinic from the cloud on the next sync. Used by Admin -> Cloud -> "Re-sync
// everything" when a station is missing patients the others can see. Applying
// rows is idempotent (last-write-wins), so nothing local is lost or duplicated.
function resetSyncCursor() {
  setSetting('cloud_cursor', '');
  setSetting('cloud_pending', '[]');
  return { ok: true };
}

function ensureDeviceId() {
  let id = getSetting('cloud_device_id');
  if (!id) { id = crypto.randomUUID(); setSetting('cloud_device_id', id); }
  return id;
}

// A small, persistent buffer of pulled rows whose parent wasn't present yet
// (e.g. a treatment arriving before its patient). They are retried on every
// pull until their parent shows up, so the pull cursor can always move forward
// instead of wedging — and no row is ever dropped.
// Sized for a whole clinic day's records rather than a single queue, so a
// station that pulls a big backlog (or re-reads everything after a "Re-sync
// everything") never has to drop a child whose parent lands later in the run.
// If it ever does overflow, the oldest are kept — they are the ones whose parent
// is most likely already on its way — and a re-sync recovers the rest.
const PENDING_CAP = 5000;
function getSyncPending() { return safeJson(getSetting('cloud_pending'), []); }
function setSyncPending(rows) {
  const arr = Array.isArray(rows) ? rows.slice(0, PENDING_CAP) : [];
  setSetting('cloud_pending', JSON.stringify(arr));
}

function close() {
  if (db) db.close();
  db = null;
}

module.exports = {
  init, close,
  login, listUsers, createUser, updateUser, deleteUser, clearEventStaff,
  listEvents, createEvent, updateEvent, setActiveEvent, setEventActive, deleteEvent, getActiveEvent,
  createPatient, startVisitFromExisting, updatePatient, deletePatient, getPatient, listPatients, searchAllPatients, patientHistory,
  listIncompletePatients, deleteIncompletePatients,
  saveVitals, routePatient, updateConsentTeeth, addPatientConsent, dismissPatient, adminMovePatient, patientAudit, importPatientFromPortable,
  arrivalReadiness, confirmArrival, routeFromVisitType, visitNeedsSurgeryConsent,
  saveTriage, saveTreatment,
  addXray, updateXrayTooth, getXray, listXrays, deleteXray,
  dashboardStats, listAudit, audit,
  backupTo, exportEventJson,
  exportClinicBundle, importClinicBundle, buildEventSummary, purgeEventPatients, finishEvent, listEventReports,
  getSetting, setSetting,
  // v1.1.0 cloud sync
  collectSyncRows, applyRemoteRows, markSynced, getSyncMeta, setSyncMeta, ensureDeviceId,
  getSyncPending, setSyncPending, resetSyncCursor,
};
