# Caring Hands — Cloud Sync Setup (no installs, all in your browser)

This sets up the shared cloud so every station sees one live patient queue. You do
**not** need to install Node.js, a terminal, or any command-line tool. Everything is
done by clicking around the **Cloudflare dashboard** in a web browser, then pasting one
URL and one password into the app.

It's a one-time setup of about **10 minutes**. You'll do it once for the whole clinic.

> **Offline-first:** Cloud sync is OFF until you turn it on. The app works with no
> internet at all. If the connection drops mid-clinic, each station keeps working and
> re-syncs automatically when it's back.

---

## Part A — Stand up your cloud (once, on any computer with a browser)

### 1. Make a free Cloudflare account
Go to **https://dash.cloudflare.com/sign-up**, create a free account, and log in. The
free plan is more than enough for a clinic.

### 2. Create the database (D1)
1. In the left menu, open **Storage & Databases → D1 SQL Database**.
2. Click **Create**. Name it `caring-hands` and click **Create**.
3. That's it — you do **not** need to add any tables. The app's server creates them
   for you automatically the first time it runs.

### 3. Create the server (Worker)
1. In the left menu, open **Compute (Workers) → Workers & Pages**.
2. Click **Create application → Create Worker**.
3. Name it `caring-hands-sync` and click **Deploy** (this makes a placeholder).
4. Click **Edit code** (the `< >` button).
5. Select **all** the placeholder code in the editor and delete it.
6. Open the file **`cloud/worker.js`** from this project, copy its **entire** contents,
   and paste them into the editor.
7. Click **Deploy** (top right).

### 4. Connect the database to the server
1. On the Worker's page, open **Settings → Bindings** (older dashboards: *Settings →
   Variables → D1 database bindings*).
2. Click **Add binding → D1 database**.
3. **Variable name:** type `DB` (exactly, uppercase).
4. **D1 database:** choose `caring-hands`.
5. Click **Deploy** / **Save**.

### 5. Set your clinic password (the shared key)
1. Still in **Settings**, open **Variables and Secrets** (older dashboards: *Settings →
   Variables → Environment Variables*).
2. Click **Add**, choose **Secret** (encrypt) if offered, and:
   - **Name:** `CLINIC_KEY`
   - **Value:** a strong passphrase you invent, e.g. `belize-clinic-2026-7Kq!` — this is
     the one password every station will share. Write it down somewhere safe.
3. Click **Deploy** / **Save**.

### 6. Copy your Cloud URL
On the Worker's main page, find its address near the top — it looks like:

```
https://caring-hands-sync.<your-name>.workers.dev
```

Copy that whole address. This is your **Cloud URL**.

### 7. Quick check it's alive
Paste your Cloud URL into a browser and add `/health` to the end, e.g.:

```
https://caring-hands-sync.<your-name>.workers.dev/health
```

You should see something like:

```json
{ "ok": true, "service": "caring-hands-sync", "version": "1.1.0", "time": "..." }
```

If you see that, your cloud is ready. ✅ (If not, see Troubleshooting below.)

---

## Part B — Connect each station (the Caring Hands app)

Do this on **every** computer that should share the queue, using the **same** Cloud URL
and the **same** CLINIC_KEY.

1. Open **Caring Hands** and sign in as an **admin**.
2. Go to **Admin → Cloud**.
3. Paste your **Cloud URL** into the *Cloud URL* box.
4. Type your **CLINIC_KEY** into the *Clinic key* box.
5. Click **Test connection** — it should turn green ("Connected to sync server v1.1.0").
6. Click **Save**.
7. Turn on **Enable cloud sync for this station**.
8. Go to **Admin → Events** and make sure every station has the **same active event**
   selected (set the shared event **Active** on each one). New patients are filed under
   the active event, so they must match for the queue to line up.

Repeat 1–8 on each station.

---

## Part C — Prove the queue moves through (5-minute acceptance test)

Use two or three stations (or two windows on different computers):

1. **Station A (front desk):** check in a patient.
2. **Station B (EMT):** within a few seconds the patient appears on the dashboard / Vitals
   list. Record vitals, then route to **Dentist** (or Hygienist).
3. **Station C (Dentist/Hygienist):** the patient shows up in that queue automatically.
4. Watch the **Admin → Cloud** status — it shows **Synced · <time>** and a running count
   of pushed / pulled / applied rows.
5. **Offline test:** disconnect one station's internet. It keeps working. Reconnect — its
   changes sync up within a few seconds. (If two people edited the *same* record while
   apart, the most recent edit wins.)

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/health` doesn't load | Worker not deployed, or wrong URL | Re-check Part A step 3 and copy the exact URL from the Worker page |
| "Test connection" fails with a 401 | Wrong clinic key | Re-type the key; make sure the app's key matches the `CLINIC_KEY` secret exactly (case-sensitive) |
| Connected, but nothing syncs | Sync not enabled, or different active event | Turn on **Enable cloud sync**; make sure every station's **active event** is the same one |
| "Test connection" fails but `/health` works | The `DB` binding or `CLINIC_KEY` isn't set | Re-check Part A steps 4 and 5, then **Deploy** again |
| Errors mentioning `env.DB` / "no such table" | D1 binding name isn't exactly `DB` | Fix the binding variable name to `DB` (uppercase) and Deploy |

---

## What's synced vs. what stays local

- **Synced across stations:** clinic events, patients, vitals/routing (triage), treatments,
  consents, and x-rays — everything the queue needs.
- **Stays on each device:** staff accounts and passwords. Create your team on each station
  (or on one and reuse it). Keeping logins local means the shared key is the only cloud
  credential.

## Security & cost
- The only cloud credential is your **CLINIC_KEY** — keep it private; share it only with
  your stations. To rotate it, change the `CLINIC_KEY` secret in the dashboard and update
  each station's Cloud tab.
- All traffic is HTTPS. The server checks the key on every request with a constant-time
  comparison and refuses everything if the key isn't set.
- A clinic's volume sits comfortably inside Cloudflare's **free** tier.

---

## Appendix — Advanced (optional, for developers with the CLI)

If you *prefer* the command line, the repo also supports Wrangler:

```bash
cd cloud
npm install
npx wrangler d1 create caring-hands      # paste the id into wrangler.toml
npx wrangler deploy                       # deploys worker.js
npx wrangler secret put CLINIC_KEY        # set the shared key
```

The table is still created automatically on first use, so `wrangler d1 migrations apply`
is optional. The dashboard steps in Part A are the recommended, no-install path.
