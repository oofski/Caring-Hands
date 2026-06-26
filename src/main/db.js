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
      role         TEXT NOT NULL CHECK (role IN ('admin','doctor','triage')),
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

  // Additive column migrations (safe to run on existing v1.0.0 databases).
  addColumn('triage', 'triage_signature', 'TEXT');
  addColumn('triage', 'triage_signer_name', 'TEXT');
  addColumn('xrays', 'updated_at', 'TEXT');
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
    const { salt, hash } = hashPassword('admin');
    db.prepare(
      `INSERT INTO users (username, full_name, role, salt, hash, active, created_at)
       VALUES (?,?,?,?,?,1,?)`
    ).run('admin', 'Clinic Administrator', 'admin', salt, hash, now());

    // Helpful starter accounts so the clinic can log in to every role on day one.
    const doc = hashPassword('doctor');
    db.prepare(
      `INSERT INTO users (username, full_name, role, salt, hash, active, created_at)
       VALUES (?,?,?,?,?,1,?)`
    ).run('doctor', 'Dr. Demo Provider', 'doctor', doc.salt, doc.hash, now());

    const tri = hashPassword('triage');
    db.prepare(
      `INSERT INTO users (username, full_name, role, salt, hash, active, created_at)
       VALUES (?,?,?,?,?,1,?)`
    ).run('triage', 'Front Desk', 'triage', tri.salt, tri.hash, now());
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
  if (!['admin', 'doctor', 'triage'].includes(role)) throw new Error('Invalid role.');
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
  setSetting('active_event_id', String(id));
  audit(actor, 'select', 'event', id, e.name);
  return e;
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

function getPatient(id) {
  const p = rowToPatient(db.prepare('SELECT * FROM patients WHERE id = ?').get(id));
  if (!p) return null;
  p.consents = db.prepare('SELECT * FROM consents WHERE patient_id = ? ORDER BY signed_at').all(id);
  const tr = db.prepare('SELECT * FROM triage WHERE patient_id = ?').get(id);
  p.triage = tr ? { ...tr, flags: JSON.parse(tr.flags), checklist: JSON.parse(tr.checklist), teeth: JSON.parse(tr.teeth) } : null;
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
  return p;
}

function listPatients({ eventId, search } = {}) {
  const evId = eventId || Number(getSetting('active_event_id'));
  let sql = 'SELECT * FROM patients WHERE event_id = ?';
  const args = [evId];
  if (search) {
    sql += ' AND (lower(first_name) LIKE ? OR lower(last_name) LIKE ? OR phone LIKE ? OR dob LIKE ?)';
    const s = `%${String(search).toLowerCase()}%`;
    args.push(s, s, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
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
      `UPDATE triage SET complaint=?, flags=?, checklist=?, teeth=?, notes=?,
         xray_count=?, xray_station=?, assigned_to=?, status=?,
         triage_signature=?, triage_signer_name=?, triaged_by=?, triaged_at=?
       WHERE patient_id=?`
    ).run(
      d.complaint || null,
      JSON.stringify(d.flags || []),
      JSON.stringify(d.checklist || {}),
      JSON.stringify(d.teeth || []),
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
      `INSERT INTO triage (patient_id, complaint, flags, checklist, teeth, notes,
          xray_count, xray_station, assigned_to, status, triage_signature, triage_signer_name, triaged_by, triaged_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      patientId, d.complaint || null, JSON.stringify(d.flags || []),
      JSON.stringify(d.checklist || {}), JSON.stringify(d.teeth || []), d.notes || null,
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
  login, listUsers, createUser, updateUser,
  listEvents, createEvent, setActiveEvent, getActiveEvent,
  createPatient, updatePatient, getPatient, listPatients, searchAllPatients,
  saveTriage, saveTreatment,
  addXray, getXray, listXrays, deleteXray,
  dashboardStats, listAudit, audit,
  backupTo, exportEventJson,
  getSetting, setSetting,
};
