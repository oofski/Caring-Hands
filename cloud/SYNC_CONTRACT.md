# Caring Hands — Cloud Sync Contract (v1.14.0)

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
- `GET /v1/pull?since=<cursor>&event_uid=<uid>&limit=500` — returns rows with
  `seq > since` (optionally scoped to `event_uid`), ordered by `seq` asc.
  → `{ ok:true, rows:[<envelope>...], cursor:"<seq>", more:false, mode:"seq" }`.
  `cursor` = the last `seq` returned (or `since` when empty); the app stores it and
  passes it as the next `since`. `more:true` when the limit was hit (app pulls again).

  **Delivery order is the server's counter, never a clock (v1.5.0).** `seq` is assigned
  by the Worker on every write. Ordering by `updated_at` was unsafe: a row can reach the
  cloud with an *older* stamp than rows already delivered — a check-in made while a laptop
  was offline (its original edit time is deliberately preserved for fair LWW), or any write
  from a laptop whose clock is behind. A timestamp high-water cursor steps straight over
  those rows and never returns them, so a patient could be permanently visible on one
  laptop and missing on another. `seq` cannot be back-dated, so a late arrival is still
  delivered to every device that hasn't reached it.

  `updated_at` is unchanged and still decides last-write-wins — it answers "who edited
  last", which is a different question from "what has this device already been given".

  **Rolling updates:** a `since` that is a number (or empty) selects seq mode; a legacy
  `<iso>@<device>` cursor is served exactly as before (`mode:"time"`), so laptops can be
  updated one at a time. `GET /health` reports `seq:true` on a seq-capable server; the app
  uses that to switch its cursor over once, which also re-reads anything it had skipped.

## v1.14 — lanes, byte caps, atomic writes (sync_api 2)

A v1.14 Worker reports `sync_api: 2` and `caps` (including `atomic_seq`) on `/health`.
Everything above still works unchanged for older apps; v1.14 apps add the following,
and fall back to the protocol above, in the same sync cycle, whenever a server does not
answer in it.

**Writes are atomic.** Each write takes its `seq` and stores its row in ONE D1 batch, so
no row is ever visible while a lower `seq` it reserved is still unwritten. (Before v1.14
the two were separate calls, and a pull landing between them could step a laptop past a
row for good.) Last-write-wins and sticky deletions are decided inside the same SQL
statement: a stored row changes only if the incoming `updated_at` is newer AND (the stored
row is live, OR the incoming row is a deletion, OR it carries `undelete`).

**Push, v2.** Body `{ device_id, proto: 2, origin: "<per-run token>", rows }`. Answer:
```json
{ "ok": true, "proto": 2, "applied": 3, "skipped": 1, "complete": false, "max_rows": 40,
  "results": ["applied", "skipped", "applied", "applied", "retry", "..."], "time": "<iso>" }
```
`results` is index-aligned with `rows`: `applied` / `skipped` / `invalid` are final (the app
marks them sent), `too_big` can never be stored as it is (the app sets it aside until it is
edited), `retry` was not stored this time (the request ran out of D1 statements — the
Workers free plan allows 50 — and the app re-sends it at once, at most `max_rows` per
request). Rows are written in request order, and nothing after the first `retry` is stored.
An older app (no `proto`) gets `ok:true` only when every row is final, and
`{ ok:false, partial:true }` (HTTP 200) when some were stored — never a false "synced".

**Pull, v2.**
```
GET /v1/pull?proto=2&since=9007199254740991&limit=1
            &since_e=&since_p=&since_k=&since_x=     lane cursors
            &rows=1000&max_bytes=<bytes>&origin=<token>&echo_min=<seq>
            &device=<device id>&backlog=<json>
```
`since=9007199254740991&limit=1` is the probe: an older Worker ignores the rest and answers
an empty legacy page, which the app takes as "use the old protocol" (and asks again in ten
minutes). The four lanes partition every row:

| lane | holds |
|---|---|
| `e` | every deletion (x-ray tombstones included), clinics, the volunteer list |
| `p` | staff accounts, kept reports, patients |
| `k` | everything else clinical: vitals and routing, treatment, consents |
| `x` | x-ray images |

A lane is served only if every earlier lane drained in the same response, so parents
always arrive before their children, and a laptop that has fallen behind gets every
check-out before the image backlog. Pages are capped at `max_bytes` (64 KiB–8 MiB; the
first row of a response always goes, so one row bigger than the cap still moves — alone). The answer:
```json
{ "ok": true, "proto": 2, "mode": "seq", "head": "5120", "instance": "<db id>", "more": true,
  "lanes": { "e": { "cursor": "5120", "more": false, "left": 0, "left_exact": true },
             "x": { "cursor": "3301", "more": true, "left": 140, "left_exact": true }, "...": {} },
  "peers": [{ "device": "...", "who": "FRONT-DESK", "clinical": 0, "xrays": 3, "bytes": 912000, "at": "<iso>" }],
  "rows": [{ "lane": "p", "seq": 5101, "entity": "patient", "...": "..." }] }
```
- A row this app run pushed itself (`origin` = its token, `seq > echo_min`) comes back as
  a **stub** — `own: 1`, no `data`. The app accepts a page of stubs only if applying the
  full rows would change nothing locally; otherwise it discards the whole page and asks
  again with `echo_min` raised past it, which brings the full rows.
- A lane cursor never moves backwards and never past `head`; an app that sees otherwise
  applies nothing from that page. A lane that drained advances to the highest `seq` in
  the response, keeping every lane close to the frontier.
- `reset: "cursor_ahead"` (a cursor past `head`) or a changed `instance` means a different
  database behind the same address: the app starts from nothing and re-sends everything.
- `backlog` (`{c, x, b, w}`: unsent clinical rows, x-rays, bytes, station name) is stored
  only when it changes (or every 5 minutes while something is outstanding), outside the
  read batch so a refused write never fails the pull, and is reported to the other laptops
  as `peers` for 7 days — long on purpose, because the station that matters is one that
  went offline holding unsent x-rays and cannot update its report. Finish clinic names it.

**App side (v1.14).** Settings: `cloud_lanes` (`{v:1, e, p, k, x, base}`), `cloud_cursor` =
the lowest lane (so an older version, if a laptop is downgraded, re-reads rather than
skips), `cloud_server_instance`, `cloud_sync_gen` (bumped by every reset; a cycle that
started before a reset saves nothing), `cloud_refused`, `cloud_sync_state` (what the last
good pull said about completeness, for the Finish guard). Lanes, waiting rows and the
instance are saved in ONE SQLite transaction after each page is applied. The rows waiting
for a parent are never truncated.

**Worker settings (optional, Settings → Variables):**
- `SYNC_V2 = off` — the kill switch: the Worker answers every app in the old protocol.
- `SYNC_STATEMENT_BUDGET` — D1 statements one request may use (10–950, default 950). The
  Worker also learns a lower figure on its own when a request is refused for using too many.

## D1 schema
One table `sync_rows` (generic, so new fields never need a migration):
```sql
CREATE TABLE IF NOT EXISTS sync_rows (
  uid         TEXT PRIMARY KEY,
  entity      TEXT NOT NULL,
  event_uid   TEXT,
  patient_uid TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,         -- device stamp; decides last-write-wins
  data        TEXT NOT NULL,         -- JSON string of the envelope.data
  seq         INTEGER                -- server delivery counter; decides pull order
);
CREATE INDEX IF NOT EXISTS idx_sync_updated ON sync_rows(updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_event   ON sync_rows(event_uid, updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_entity  ON sync_rows(entity);
CREATE INDEX IF NOT EXISTS idx_sync_seq     ON sync_rows(seq);
-- The counter itself. Every write takes the next value atomically.
CREATE TABLE IF NOT EXISTS sync_seq (id INTEGER PRIMARY KEY, v INTEGER NOT NULL);
-- v1.14: origin (which app run wrote the row) and nbytes (stored size, read
-- without touching the data); sync_meta (schema marker, instance id, backlogs);
-- one partial covering index per lane.
CREATE TABLE IF NOT EXISTS sync_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```
The Worker migrates an existing database on its own (adds `seq`, backfills it from each
row's insertion order, seeds the counter), so a redeploy needs no CLI step.

## App side (already implemented in src/main/cloud.js + db.js)
- Settings (in local `settings` table): `cloud_url`, `cloud_key`, `cloud_enabled` ('1'/'0'),
  `cloud_device_id` (uuid), `cloud_cursor` (iso), `cloud_last_push` (iso), `cloud_last_ok` (iso).
- `db.collectSyncRows(sinceIso)` → envelopes for locally-changed rows.
- `db.applyRemoteRows(rows)` → upserts remote envelopes into local SQLite (remapping parent
  uids → local ids, preferring denormalized names), never echoing them back as dirty.
- Engine loop (main process): push dirty → pull deltas → apply, every ~4s when enabled.
