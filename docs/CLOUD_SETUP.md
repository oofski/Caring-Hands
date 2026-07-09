# Caring Hands — Cloud Sync Setup & Verification Runbook (v1.1.0)

This guide walks a **clinic administrator** (not a developer) through turning on
**Cloud Sync** so that every station at your clinic shares one live patient queue.
You can copy and paste every command exactly as written.

## What Cloud Sync does (in plain words)

Normally each Caring Hands station keeps its own patients on its own computer.
Cloud Sync adds a small, private "mailbox" in the cloud (a **Cloudflare Worker** plus a
**D1** database) that all your stations talk to. When you check a patient in on one
station, they show up on the other stations within a few seconds, so the queue moves
through the clinic live.

Important things to know before you start:

- **It is off by default.** The app works completely offline. Nothing leaves a station
  until you turn sync on.
- **Offline-first.** If the internet drops, every station keeps working locally and
  catches up automatically when it reconnects.
- **One password protects everything.** A single shared **CLINIC_KEY** is the only
  credential. The same key goes into every station.
- **Staff accounts are never synced.** Logins and passwords stay on each station. Only
  the patient-flow data is shared (see the last section).

You do this setup **once** for the whole clinic. Then you connect each station to it.

---

## Table of contents

1. [One-time prerequisites](#1-one-time-prerequisites)
2. [Create the cloud database (D1)](#2-create-the-cloud-database-d1)
3. [Apply the schema (create the table)](#3-apply-the-schema-create-the-table)
4. [Set the shared clinic key](#4-set-the-shared-clinic-key)
5. [Deploy the Worker](#5-deploy-the-worker)
6. [Verify the server is alive](#6-verify-the-server-is-alive)
7. [Connect each station to the cloud](#7-connect-each-station-to-the-cloud)
8. [Prove the queue moves (acceptance test)](#8-prove-the-queue-moves-acceptance-test)
9. [Offline behavior](#9-offline-behavior)
10. [Troubleshooting](#10-troubleshooting)
11. [Cost & security notes](#11-cost--security-notes)
12. [What's synced / what's not](#whats-synced--whats-not)

> Steps 1–6 are done **once**, on any one computer (this becomes your "setup computer").
> Step 7 is repeated on **every** station. Steps 8–9 are how you confirm it works.

---

## 1. One-time prerequisites

You need three things on your **setup computer**: Node.js, the Wrangler tool, and a free
Cloudflare account.

### 1a. Install Node.js

Node.js is the runtime the setup tools need.

1. Go to <https://nodejs.org> and download the **LTS** version for your operating system.
2. Run the installer and accept the defaults.
3. Confirm it worked by opening a terminal (macOS: **Terminal**; Windows: **PowerShell**)
   and running:

```bash
node --version
npm --version
```

**Expected output** (your numbers may be a little higher — that's fine):

```text
v20.11.1
10.2.4
```

### 1b. Install Wrangler (the Cloudflare command-line tool)

```bash
npm install -g wrangler
```

**Expected output** (last line):

```text
added 1 package in 6s
```

Confirm it installed:

```bash
wrangler --version
```

**Expected output:**

```text
 ⛅️ wrangler 3.x.x
```

> **No-install alternative:** You can skip the global install and put `npx` in front of
> every `wrangler` command instead (for example, `npx wrangler login`). Everywhere this
> guide says `wrangler …`, `npx wrangler …` also works.

### 1c. Log in to Cloudflare

This links Wrangler to your Cloudflare account. The **free tier is more than enough** for
a clinic (see [Section 11](#11-cost--security-notes)).

```bash
wrangler login
```

This opens your web browser. Sign in (or create a free account at
<https://dash.cloudflare.com/sign-up>) and click **Allow** to authorize Wrangler.

**Expected output** back in the terminal:

```text
Successfully logged in.
```

---

## 2. Create the cloud database (D1)

All remaining commands are run **inside the `cloud` folder** of Caring Hands.

### 2a. Open the cloud folder and install its dependencies

```bash
cd cloud
npm install
```

**Expected output** (last line, roughly):

```text
added 45 packages in 4s
```

### 2b. Create the database

D1 is Cloudflare's small built-in database. Create one named **`caring-hands`**:

```bash
wrangler d1 create caring-hands
```

**Expected output** (yours will have a different ID):

```text
✅ Successfully created DB 'caring-hands'

[[d1_databases]]
binding = "DB"
database_name = "caring-hands"
database_id = "b1c2d3e4-5678-90ab-cdef-1234567890ab"
```

### 2c. Copy the database ID into the config file — this step is required

Copy the long **`database_id`** value from that output (the part in quotes, like
`b1c2d3e4-5678-90ab-cdef-1234567890ab`).

Open the file **`cloud/wrangler.toml`** in any text editor (Notepad, TextEdit, VS Code).
Find the line that reads:

```toml
database_id = "REPLACE_WITH_YOUR_D1_ID"
```

Replace `REPLACE_WITH_YOUR_D1_ID` with your real ID, keeping the quotes, so it looks like:

```toml
database_id = "b1c2d3e4-5678-90ab-cdef-1234567890ab"
```

Save the file. This is what tells the Worker which database to use. If you skip this, the
deploy and migration steps will fail with a D1 error.

---

## 3. Apply the schema (create the table)

This creates the single `sync_rows` table (the shared "mailbox") inside your cloud
database. Run it against the **remote** (cloud) database:

```bash
npm run migrate:remote
```

**Expected output:**

```text
🌀 Executing on remote database caring-hands:
🚣 3 commands executed successfully.
```

That's it — the cloud database is now ready to receive data.

> **Optional local dry run.** If you want to test the setup on your own computer first
> without touching the cloud, run `npm run migrate:local` instead. It builds the same
> table in a throwaway local copy. It is safe and does not affect the cloud database.
> When you're ready for real, run `npm run migrate:remote` (above).

---

## 4. Set the shared clinic key

The **CLINIC_KEY** is the single password that protects your cloud mailbox. Every station
will use this exact value. Choose a **strong passphrase** (for example, four or more
random words, 16+ characters). Write it down somewhere safe — you will type it into each
station later, and you cannot read it back out of Cloudflare afterward.

```bash
wrangler secret put CLINIC_KEY
```

You will be prompted to type the passphrase (it stays hidden as you type). Paste or type
your chosen key and press **Enter**.

**Expected output:**

```text
✨ Success! Uploaded secret CLINIC_KEY
```

> **Keep this safe.** The CLINIC_KEY is the only thing standing between your patient data
> and the public internet. Do not email it, do not put it in a shared doc, and only give
> it to staff who set up stations. See [Section 11](#11-cost--security-notes) for how to
> rotate (change) it later.

---

## 5. Deploy the Worker

This publishes the sync server to Cloudflare and gives you your **Cloud URL**.

```bash
npm run deploy
```

**Expected output** (your subdomain will differ):

```text
Total Upload: 12.34 KiB / gzip: 3.21 KiB
Uploaded caring-hands-sync (1.05 sec)
Published caring-hands-sync (0.98 sec)
  https://caring-hands-sync.your-subdomain.workers.dev
Current Deployment ID: 4a2f...
```

**Write down the URL** on that line — for example
`https://caring-hands-sync.your-subdomain.workers.dev`. This is your **Cloud URL**. You
will paste it into every station in [Step 7](#7-connect-each-station-to-the-cloud).

---

## 6. Verify the server is alive

Before touching any station, confirm the server responds. Replace the example URL with
**your** Cloud URL from Step 5:

```bash
curl https://caring-hands-sync.your-subdomain.workers.dev/health
```

**Expected output:**

```json
{"ok":true,"service":"caring-hands-sync","version":"1.1.0","time":"2026-07-09T14:03:22.481Z"}
```

If you see `"ok":true`, your server is live and healthy. The `/health` check needs **no
password** — it is exactly what the app's "Test connection" button uses. If this fails,
jump to [Troubleshooting](#10-troubleshooting) before continuing.

---

## 7. Connect each station to the cloud

Do this on **every** station (computer) at the clinic. Use the **same Cloud URL** and the
**same CLINIC_KEY** everywhere.

1. Open **Caring Hands** on the station.
2. **Sign in as an administrator.**
3. Go to **Admin** → open the **Cloud** tab.
4. In **Cloud URL**, paste your URL from Step 5, e.g.
   `https://caring-hands-sync.your-subdomain.workers.dev`
5. In **Clinic key**, type the **CLINIC_KEY** exactly as you set it in Step 4.
6. Click **Test connection**. The indicator should turn **green** ("Connected").
   - If it stays red, re-check the URL (no trailing spaces) and the key. See
     [Troubleshooting](#10-troubleshooting).
7. Toggle **Enable cloud sync** to **ON**.
8. **Pick / confirm the active event.** Sync only moves rows for the clinic's **active
   event**. Make sure every station is set to the **same** active event (Admin → Events).
9. Repeat steps 1–8 on each remaining station, using the **identical** URL and key.

> Once enabled, each station quietly pushes its changes and pulls everyone else's about
> every few seconds. You do not need to press anything to sync — it runs on its own.

---

## 8. Prove the queue moves (acceptance test)

This is the real test: a patient checked in on one station should flow through the clinic
on the others. You can use **three separate computers** (Station A, B, C) or, for a quick
test, **three windows** of the app on machines that are all connected and enabled.

Make sure all three are: signed in, on the **same active event**, with **Enable cloud
sync ON** and a **green** connection.

| Step | Where | What you do | What to watch for elsewhere |
|------|-------|-------------|-----------------------------|
| 1 | **Station A** | Check a new patient in (intake / kiosk). | Within a few seconds the patient appears on **Station B's** Dashboard and **EMT** queue. |
| 2 | **Station B** | Open that patient, record **vitals** and **route** them to a dentist or hygienist. | The patient moves into the **dentist / hygienist** queue on **Station C**. |
| 3 | **Station C** | Open the patient in the **provider (dentist)** or **hygienist** view; add a treatment. | Back on **Station A/B**, the patient's status/treatment updates. |

**What "it's working" looks like:**

- New and updated patients appear on the other stations within roughly **2–6 seconds**.
- The **Cloud** tab (or status area) shows a **"Synced · &lt;time&gt;"** indicator that
  updates to the current time after each successful sync. If that timestamp keeps moving,
  data is flowing.
- The person who did each step is shown by name on the other stations (e.g. who took
  vitals), even though staff accounts themselves are not shared.

If any step doesn't appear on the next station, go to
[Troubleshooting](#10-troubleshooting) — most often it's sync not enabled on that station,
or the stations are on different active events.

---

## 9. Offline behavior

Cloud Sync is **offline-first**, so a dropped connection is not an emergency.

**Try it:**

1. On one station, disconnect the network (unplug Ethernet or turn off Wi-Fi).
2. Keep working — check patients in, record vitals, add treatments. Everything continues
   normally; the app is reading and writing its own local database. The Cloud indicator
   will show it's offline / not synced.
3. Reconnect the network.
4. Within a few seconds the station catches up automatically: it **pushes** everything you
   did while offline and **pulls** anything the other stations did. The "Synced ·
   &lt;time&gt;" indicator starts updating again.

**How conflicts are settled — Last-Write-Wins (LWW).** If two stations edited the *same*
record while apart, the app keeps the version with the **most recent edit time**
(`updated_at`). The newest edit wins; older edits to that same record are discarded. In
normal clinic flow this is rarely an issue, because different stations usually touch
different patients or different stages of the same patient.

---

## 10. Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|-----------|
| `curl …/health` fails, times out, or returns an error page | Wrong URL, or the Worker isn't deployed | Re-check the URL spelling (must end in `/health`). Re-run `npm run deploy` from the `cloud` folder and use the exact URL it prints. |
| "Test connection" is green, but a station shows **401** / "Unauthorized" when syncing | The **CLINIC_KEY** on that station doesn't match the one on the server | Re-type the key in Admin → Cloud. It must exactly match what you set with `wrangler secret put CLINIC_KEY` (watch for extra spaces or autocorrect). If unsure, rotate the key (Section 11) and re-enter it everywhere. |
| Connection is green but **nothing syncs** | Sync not enabled on that station | Confirm **Enable cloud sync** is ON on **every** station. |
| Some stations sync, one doesn't see the patients | Stations are on **different active events** | Sync is scoped to the active event. Set all stations to the **same** active event (Admin → Events). |
| Records appear but the **wrong version wins**, or updates seem to "go backward" | **Clock skew** — a station's system clock is wrong | LWW uses timestamps, so a badly wrong clock can make an old edit look newer. Set every station's date/time to automatic (network time). |
| `npm run deploy` or `migrate:remote` fails with a **D1 / database error** | The `database_id` wasn't pasted into `wrangler.toml`, or the schema wasn't applied | Re-do [Step 2c](#2c-copy-the-database-id-into-the-config-file--this-step-is-required) (paste the real ID) and re-run `npm run migrate:remote` ([Step 3](#3-apply-the-schema-create-the-table)). |
| `wrangler` "not found" | Wrangler isn't installed globally | Use `npx wrangler …` instead, or re-run `npm install -g wrangler` ([Step 1b](#1b-install-wrangler-the-cloudflare-command-line-tool)). |
| "Not logged in" / authorization error during deploy | Cloudflare session expired | Run `wrangler login` again ([Step 1c](#1c-log-in-to-cloudflare)). |

**Quick health re-check anytime:**

```bash
curl https://caring-hands-sync.your-subdomain.workers.dev/health
```

A healthy server always returns `{"ok":true, ... "version":"1.1.0", ...}`.

---

## 11. Cost & security notes

**Cost.** This runs on Cloudflare's **free tier**, which is ample for a clinic:

- Workers free tier includes on the order of **100,000 requests per day**. A busy clinic
  with several stations syncing every few seconds uses only a small fraction of that.
- D1's free tier includes millions of row reads/writes per day and gigabytes of storage —
  far more than an event's worth of patients, vitals, and treatments.
- In short: for a single clinic, expect to stay comfortably within free limits. You do not
  need a paid Cloudflare plan to run this.

**Security.**

- The **CLINIC_KEY is the only credential.** Anyone with the Cloud URL *and* the key can
  read and write the queue; anyone without the key gets **401 Unauthorized**. Treat the
  key like the clinic's front-door key.
- Only the shared patient-flow data lives in D1 (see next section). **Staff logins and
  passwords are never uploaded.**
- All traffic is over **HTTPS**, and the key is stored on Cloudflare as an encrypted
  secret — even you cannot read it back out (you can only overwrite it).

**Rotating (changing) the key.** Do this if the key may have leaked, or periodically as
good hygiene:

1. On your setup computer, in the `cloud` folder, set a new key:

   ```bash
   wrangler secret put CLINIC_KEY
   ```

   Type the **new** passphrase. (No re-deploy needed — it takes effect immediately.)
2. On **every station**, go to Admin → Cloud and update the **Clinic key** to the new
   value, then click **Test connection** (should go green again).

Until a station's key is updated, that station will get **401** and stop syncing — which
is exactly the point of rotating.

---

## What's synced / what's not

**Synced across stations** (the shared patient-flow for the active event):

- **Events** (the clinic event itself)
- **Patients** (intake / demographics)
- **Triage / vitals / routing** (who was seen, their vitals, and which provider they were
  routed to)
- **Treatments** (clinical work recorded by dentists and hygienists)
- **Consents**
- **X-rays**

**Not synced** (stays on each station):

- **Staff accounts and passwords.** These are created **per station** and never leave it.
  Accountability still shows across the clinic because names are attached to the records
  themselves (e.g. "vitals taken by …"), without sharing any login.

---

*Setup steps 1–6 are done once for the whole clinic. Step 7 is repeated on every station
with the same Cloud URL and CLINIC_KEY. If `/health` returns `"ok":true` and the
"Synced · &lt;time&gt;" indicator keeps updating, your clinic is live on Cloud Sync.*
