# Caring Hands — Cloud Sync Contract (v1.1.0)

The Cloudflare Worker + D1 is a **shared queue brain**. Each clinic station runs the
Electron app and syncs the active event's patient-flow rows through the Worker so the
queue moves through live across devices. Offline-first: sync is OFF by default; the app
works locally and re-syncs when reconnected.

## Identity & conflict model
- Every syncable row carries a stable **`uid`** (UUID v4) — the cloud identity. Local
  SQLite integer PKs stay for local foreign keys; the cloud keys everything by `uid`.
- Foreign keys travel as **parent uids**: `patient.event_uid`, and
  `triage/treatment/consent/xray.patient_uid`.
- Conflict resolution = **Last-Write-Wins by `updated_at`** (ISO-8601 UTC string). The
  Worker only overwrites a stored row when the incoming `updated_at` is `>=` the stored one.
- Accountability names are **denormalized** into `data` (e.g. `vitals_by_name`) so other
  devices display "who did what" without syncing user accounts.

## Entities (sync `entity` values)
`event`, `patient`, `triage`, `treatment`, `consent`, `xray`. (Users/auth are NOT synced.)

## Row envelope (used by both push and pull)
```json
{
  "entity": "patient",
  "uid": "8f...uuid",
  "event_uid": "1a...uuid",      // required for patient; null for event
  "patient_uid": "8f...uuid",    // required for triage/treatment/consent/xray
  "deleted": 0,                   // 1 = tombstone
  "updated_at": "2026-07-04T03:31:07.000Z",
  "data": { /* entity fields as JSON, incl. denormalized *_by_name */ }
}
```

## HTTP API (Worker)
Base URL = the deployed Worker, e.g. `https://caring-hands-sync.<subdomain>.workers.dev`.

- `GET /health` → `{ ok:true, service:"caring-hands-sync", version:"1.1.0", time:"<iso>" }`
  (no auth — used by the app's "Test connection").
- **Auth (all other routes):** header `Authorization: Bearer <CLINIC_KEY>`. The Worker
  compares against the `CLINIC_KEY` secret (constant-time). Mismatch → `401 {ok:false,error}`.
- `POST /v1/push` — body `{ device_id, rows: [<envelope>...] }`.
  Upserts each row into D1 with LWW. → `{ ok:true, applied:<n>, skipped:<n>, time:"<iso>" }`.
- `GET /v1/pull?since=<iso>&event_uid=<uid>&limit=500` — returns rows with
  `updated_at > since` (optionally scoped to `event_uid`), ordered by `updated_at` asc.
  → `{ ok:true, rows:[<envelope>...], cursor:"<iso>", more:false }`.
  `cursor` = the max `updated_at` returned (or `since` when empty); the app stores it and
  passes it as the next `since`. `more:true` when the limit was hit (app pulls again).

## D1 schema
One table `sync_rows` (generic, so new fields never need a migration):
```sql
CREATE TABLE IF NOT EXISTS sync_rows (
  uid         TEXT PRIMARY KEY,
  entity      TEXT NOT NULL,
  event_uid   TEXT,
  patient_uid TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  data        TEXT NOT NULL          -- JSON string of the envelope.data
);
CREATE INDEX IF NOT EXISTS idx_sync_updated ON sync_rows(updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_event   ON sync_rows(event_uid, updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_entity  ON sync_rows(entity);
```

## App side (already implemented in src/main/cloud.js + db.js)
- Settings (in local `settings` table): `cloud_url`, `cloud_key`, `cloud_enabled` ('1'/'0'),
  `cloud_device_id` (uuid), `cloud_cursor` (iso), `cloud_last_push` (iso), `cloud_last_ok` (iso).
- `db.collectSyncRows(sinceIso)` → envelopes for locally-changed rows.
- `db.applyRemoteRows(rows)` → upserts remote envelopes into local SQLite (remapping parent
  uids → local ids, preferring denormalized names), never echoing them back as dirty.
- Engine loop (main process): push dirty → pull deltas → apply, every ~4s when enabled.
