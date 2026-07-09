-- Caring Hands — Cloud Sync schema (v1.1.0)
-- One generic table keyed by cloud `uid`, so new entity fields never need a
-- migration (they ride inside the JSON `data` column). Conflict resolution is
-- Last-Write-Wins by `updated_at` (ISO-8601 UTC string), handled in the Worker.

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
