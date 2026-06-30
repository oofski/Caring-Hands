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
      role         TEXT NOT NULL CHECK (role IN ('admin','doctor','triage','emt','checkout')),
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
}

const ROLES = ['admin', 'doctor', 'triage', 'emt', 'checkout'];

// SQLite can't ALTER a CHECK constraint, so recreate the users table with the
// widened role set. Idempotent: no-op once the stored SQL already allows 'emt'.
function recreateUsersRoleCheck() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!row || /'emt'/.test(row.sql)) return;
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        username     TEXT UNIQUE NOT NULL,
        full_name    TEXT NOT NULL,
        role         TEXT NOT NULL CHECK (role IN ('admin','doctor','triage','emt','checkout')),
        salt         TEXT NOT NULL,
        hash         TEXT NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL
      );
      INSERT INTO users_new (id, username, full_name, role, salt, hash, active, created_at)
        SELECT id, username, full_name, role, salt, hash, active, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
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
    const info = db.prepare(
      `INSERT INTO events (name, location, start_date, end_date, languages, active, created_at)
       VALUES (?,?,?,?,?,1,?)`
    ).run('Lowell Fairgrounds Clinic', 'Lowell, OR', today(), today(), 'en,es', now());
    setSetting('active_event_id', String(info.lastInsertRowid));
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
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

function createUser(actor, { username, full_name, role, password }) {
  const u = String(username || '').trim().toLowerCase();
  if (!u || !full_name || !role || !password) throw new Error('Missing required fields.');
  if (!ROLES.includes(role)) throw new Error('Invalid role.');
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
  if (exists) throw new Error('That username already exists.');
  const { salt, hash } = hashPassword(password);
  const info = db.prepare(
    `INSERT INTO users (username, full_name, role, salt, hash, active, created_at)
     VALUES (?,?,?,?,?,1,?)`
  ).run(u, full_name, role, salt, hash, now());
  audit(actor, 'create', 'user', info.lastInsertRowid, `${u} (${role})`);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
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

function deleteUser(actor, id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) throw new Error('User not found.');
  if (actor && actor.id === id) throw new Error('You cannot delete your own account.');
  if (row.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (admins <= 1) throw new Error('Cannot delete the last administrator.');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(actor, 'delete', 'user', id, row.username);
  return { deleted: true };
}

/* ------------------------------------------------------------------ */
/*  Events                                                             */
/* ------------------------------------------------------------------ */

function listEvents() {
  const rows = db.prepare('SELECT * FROM events ORDER BY active DESC, created_at DESC').all();
  return rows.map((e) => ({
    ...e,
    active: !!e.active,
    patient_count: db.prepare('SELECT COUNT(*) AS n FROM patients WHERE event_id = ?').get(e.id).n,
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
  setSetting('active_event_id', String(id));
  audit(actor, 'select', 'event', id, e.name);
  return e;
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

// Turn an event on/off. Turning off the active event clears the active setting
// and falls back to the most recent still-active event.
function setEventActive(actor, id, active) {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!e) throw new Error('Event not found.');
  db.prepare('UPDATE events SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  if (!active && Number(getSetting('active_event_id')) === id) {
    const next = db.prepare('SELECT id FROM events WHERE active = 1 ORDER BY created_at DESC').get();
    setSetting('active_event_id', next ? String(next.id) : '');
  }
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
  if (Number(getSetting('active_event_id')) === id) {
    const next = db.prepare('SELECT id FROM events WHERE active = 1 ORDER BY created_at DESC').get();
    setSetting('active_event_id', next ? String(next.id) : '');
  }
  audit(actor, 'delete', 'event', id, `${e.name} (+${count} patients)`);
  return { deleted: true, patients: count };
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
    demographics: JSON.parse(p.demographics || '{}'),
    medical_history: JSON.parse(p.medical_history || '{}'),
    dental_history: JSON.parse(p.dental_history || '{}'),
  };
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
  db.prepare(
    `INSERT INTO triage (patient_id, complaint, status) VALUES (?,?, 'waiting')`
  ).run(id, (d.dental_history && d.dental_history.reason) || null);

  // Persist consents
  (d.consents || []).forEach((c) => addConsent(id, c));

  audit(actor || { id: null, full_name: 'kiosk' }, 'create', 'patient', id,
    `${d.first_name || ''} ${d.last_name || ''}`.trim());
  return getPatient(id);
}

function updatePatient(actor, id, data) {
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!p) throw new Error('Patient not found.');
  const d = data || {};
  db.prepare(
    `UPDATE patients SET
       language=?, first_name=?, last_name=?, dob=?, gender=?, phone=?, email=?,
       demographics=?, medical_history=?, dental_history=?, updated_at=?
     WHERE id=?`
  ).run(
    d.language || p.language,
    (d.first_name ?? p.first_name),
    (d.last_name ?? p.last_name),
    d.dob ?? p.dob,
    d.gender ?? p.gender,
    d.phone ?? p.phone,
    d.email ?? p.email,
    JSON.stringify(d.demographics || JSON.parse(p.demographics)),
    JSON.stringify(d.medical_history || JSON.parse(p.medical_history)),
    JSON.stringify(d.dental_history || JSON.parse(p.dental_history)),
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
      const f = JSON.parse(tx.fillings || '[]').length, x = JSON.parse(tx.extractions || '[]').length;
      const c = Object.values(JSON.parse(tx.cleaning || '{}')).some(Boolean);
      if (f) summary.push(`${f} filling(s)`);
      if (x) summary.push(`${x} extraction(s)`);
      if (c) summary.push('cleaning');
    }
    return { id: r.id, event_name: r.event_name, created_at: r.created_at, status: r.status, summary: summary.join(', ') || '—' };
  });
}

function deletePatient(actor, id) {
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
  p.triage = tr ? { ...tr, flags: JSON.parse(tr.flags), checklist: JSON.parse(tr.checklist), teeth: JSON.parse(tr.teeth), teeth_notes: JSON.parse(tr.teeth_notes || '{}') } : null;
  const t = db.prepare('SELECT * FROM treatments WHERE patient_id = ?').get(id);
  p.treatment = t
    ? {
        ...t,
        locked: !!t.locked,
        fillings: JSON.parse(t.fillings),
        extractions: JSON.parse(t.extractions),
        cleaning: JSON.parse(t.cleaning),
        anesthetic: JSON.parse(t.anesthetic),
      }
    : null;
  p.xrays = db.prepare('SELECT id, station, note, created_at FROM xrays WHERE patient_id = ?').all(id);
  p.event = db.prepare('SELECT * FROM events WHERE id = ?').get(p.event_id);
  // v1.0.6 accountability: resolve the staff name for each recorded action.
  const nameOf = (uid) => { if (!uid) return null; const u = db.prepare('SELECT full_name FROM users WHERE id = ?').get(uid); return u ? u.full_name : null; };
  p.triaged_by_name = tr ? nameOf(tr.triaged_by) : null;
  p.vitals_by_name = tr ? nameOf(tr.vitals_by) : null;
  p.completed_by_name = t ? nameOf(t.completed_by) : null;
  p.dismissed_by_name = nameOf(p.dismissed_by);
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
  if (!tr) {
    db.prepare(`INSERT INTO triage (patient_id, status, bp_systolic, bp_diastolic, heart_rate, vitals_by, vitals_at)
                VALUES (?, 'waiting', ?, ?, ?, ?, ?)`).run(patientId, sys, dia, hr, actor ? actor.id : null, now());
  } else {
    db.prepare('UPDATE triage SET bp_systolic=?, bp_diastolic=?, heart_rate=?, vitals_by=?, vitals_at=? WHERE patient_id=?')
      .run(sys, dia, hr, actor ? actor.id : null, now(), patientId);
  }
  audit(actor, 'vitals', 'patient', patientId, `${sys == null ? '—' : sys}/${dia == null ? '—' : dia} HR ${hr == null ? '—' : hr}`);
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
  const t = db.prepare('SELECT locked FROM treatments WHERE patient_id = ?').get(id);
  if (!t || !t.locked) throw new Error('Patient has not been signed off by the provider yet.');
  db.prepare("UPDATE patients SET status='dismissed', dismissed_by=?, dismissed_at=?, updated_at=? WHERE id=?")
    .run(actor ? actor.id : null, now(), now(), id);
  audit(actor, 'dismiss', 'patient', id, `${p.first_name} ${p.last_name}`.trim());
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
  if (portable.treatment) saveTreatment(actor, pid, portable.treatment, !!portable.treatment.locked);
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
    const tr = db.prepare('SELECT status, complaint, flags, assigned_to FROM triage WHERE patient_id = ?').get(p.id);
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
      triage_status: tr ? tr.status : null,
      complaint: tr ? tr.complaint : null,
      flags: tr ? JSON.parse(tr.flags) : [],
      assigned_to: tr ? tr.assigned_to : null,
    };
  });
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
      finalize ? 1 : 0,
      finalize ? (actor ? actor.id : null) : null,
      finalize ? now() : null,
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
      d.provider_signature || null, finalize ? 1 : 0,
      finalize ? (actor ? actor.id : null) : null, finalize ? now() : null
    );
  }
  if (finalize) {
    db.prepare('UPDATE patients SET status = ?, updated_at = ? WHERE id = ?').run('completed', now(), patientId);
    db.prepare("UPDATE triage SET status = 'completed' WHERE patient_id = ?").run(patientId);
  } else {
    db.prepare('UPDATE patients SET status = ?, updated_at = ? WHERE id = ?').run('in_treatment', now(), patientId);
    db.prepare("UPDATE triage SET status = 'in_treatment' WHERE patient_id = ? AND status != 'completed'").run(patientId);
  }
  audit(actor, finalize ? 'sign_off' : 'treatment', 'patient', patientId, null);
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

function addXray(actor, patientId, { station, image_png, note }) {
  const info = db.prepare(
    `INSERT INTO xrays (patient_id, station, image_png, note, created_at, updated_at) VALUES (?,?,?,?,?,?)`
  ).run(patientId, station || null, image_png, note || null, now(), now());
  recountXrays(patientId);
  audit(actor, 'xray', 'patient', patientId, station ? `station ${station}` : 'uploaded');
  return { id: info.lastInsertRowid, count: recountXrays(patientId) };
}

function getXray(id) {
  return db.prepare('SELECT * FROM xrays WHERE id = ?').get(id);
}

// Full x-ray list WITH image data — used by the provider gallery.
function listXrays(patientId) {
  return db.prepare(
    'SELECT id, patient_id, station, note, image_png, created_at FROM xrays WHERE patient_id = ? ORDER BY id'
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
    waiting_triage: db.prepare(
      `SELECT COUNT(*) AS n FROM triage t JOIN patients p ON p.id = t.patient_id
       WHERE p.event_id = ? AND t.status = 'waiting'`
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

function exportEventJson(eventId) {
  const evId = eventId || Number(getSetting('active_event_id'));
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(evId);
  const patients = db.prepare('SELECT * FROM patients WHERE event_id = ?').all(evId).map((p) => {
    const full = getPatient(p.id);
    return full;
  });
  return { exported_at: now(), event, patients };
}

function close() {
  if (db) db.close();
  db = null;
}

module.exports = {
  init, close,
  login, listUsers, createUser, updateUser, deleteUser,
  listEvents, createEvent, updateEvent, setActiveEvent, setEventActive, deleteEvent, getActiveEvent,
  createPatient, updatePatient, deletePatient, getPatient, listPatients, searchAllPatients, patientHistory,
  listIncompletePatients, deleteIncompletePatients,
  saveVitals, updateConsentTeeth, dismissPatient, patientAudit, importPatientFromPortable,
  saveTriage, saveTreatment,
  addXray, getXray, listXrays, deleteXray,
  dashboardStats, listAudit, audit,
  backupTo, exportEventJson,
  getSetting, setSetting,
};
