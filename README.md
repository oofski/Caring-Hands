# Caring Hands Worldwide — Practice Management Software

An **offline-first** desktop application for free dental clinics operating in
underserved communities — fairgrounds, rural areas, and international mission
deployments. It replaces the bilingual 5-page paper packet with a unified
digital workflow: patient intake, clinical documentation, consent management,
and reporting.

Built as a Windows desktop app (Electron). **No cloud. No servers. All patient
data lives on the device** and is only ever copied out by an authorized staff
member.

---

## ⬇️ Download the Windows app

Every push builds a fresh Windows `.exe` on GitHub's Windows runners and
publishes it on the **[Releases](../../releases)** page. Grab the latest build:

- **`Caring-Hands-Setup-1.0.0.exe`** — standard installer (Start-menu + desktop
  shortcuts).
- **`Caring-Hands-Portable-1.0.0.exe`** — single portable executable that runs
  without installing (ideal for a USB stick on shared clinic laptops).

You can also download the same files from the **Actions → Build Windows App →
Artifacts** section of any successful run.

### Default sign-in accounts

| Role | Username | Password |
|------|----------|----------|
| Administrator | `admin` | `admin` |
| Doctor | `doctor` | `doctor` |
| Triage / Front Desk | `triage` | `triage` |

> Change these in **Admin → Staff** before a real deployment.

---

## Feature coverage (Phase 1 / v1.0)

Mirrors the six modules of the product map:

1. **Patient Check-In & Intake** — bilingual (English / Spanish) kiosk wizard,
   full demographics, 28-condition medical history, dental history, digital
   **consent with signature capture**, conditional oral-surgery consent, and
   **read-aloud** of every consent section in the patient's language.
2. **Triage** — live patient queue, **auto-flagged medical conditions**,
   consent-status indicator, triage checklist (cleaning / extraction / filling /
   no treatment / referral), interactive **tooth charts** (Universal adult 1–32
   and primary A–T), x-ray upload, and routing to a provider.
3. **Provider / Clinical View** — fillings (tooth # + surface + position),
   extractions (simple → surgical → root tip), cleaning options, **anesthetic
   log** (Lidocaine, Articaine, …), clinical notes, and a provider **sign-off
   that locks the record**.
4. **Reporting & Export** — **PDF Progress Note** and **full-packet PDF** that
   match the CHW form, on-screen preview, print to a local wireless printer,
   "screen display" mode for the patient to photograph, and email hand-off.
5. **Admin & Settings** — roles (Admin / Doctor / Triage), staff management,
   **event creation & patient grouping**, language-pack overview, backup, and an
   **audit log**.
6. **Data & Connectivity** — embedded **SQLite** database, USB / drive backup
   (single-file `.db`), JSON event export, returning-patient lookup across
   events. Zero network calls for any core function.

---

## Design principles

- **Offline-first** — every core feature works with no internet at all.
- **Language-agnostic** — language is chosen at the first intake screen; English
  and Spanish ship built-in, more packs add per deployment.
- **Low-friction intake** — large touch targets, minimal scrolling, a guided
  step-by-step wizard a patient can finish in a few minutes.
- **Clinical simplicity** — provider screens mirror the paper Progress Note
  (checklists, not complex data entry).
- **Data sovereignty** — no cloud, no third-party servers; data stays on the
  device.

---

## Run from source (developers)

```bash
npm install
npm start          # launch the app in development
npm run icon       # regenerate brand icons from assets/icon.svg (needs sharp)
npm run dist       # build the Windows installer + portable exe into release/
```

> `npm run dist` produces Windows binaries and is intended to run on Windows (or
> via the included GitHub Actions workflow, which builds on `windows-latest`).

### Project layout

```
assets/                 Brand icon (svg/png/ico) and header logo
src/main/               Electron main process
  main.js               Window + lifecycle
  preload.js            Secure context-bridge IPC API
  db.js                 SQLite schema, repositories, auth (scrypt)
  ipc.js                IPC handlers + role-based access control
  pdf.js                Progress Note / full-packet PDF rendering
src/renderer/           UI (vanilla ES modules, no bundler)
  index.html
  styles/               Design system (theme + components)
  i18n/strings.js       Bilingual catalogue + medical condition lists
  js/                   App shell, router, views, components
.github/workflows/      Windows build → release
```

---

## Security & data handling

- Patient data is stored in a local SQLite database under the OS user-data
  directory; it never leaves the machine unless a staff member exports or backs
  it up.
- Staff passwords are hashed with scrypt and a per-user salt.
- Access is enforced per role at the IPC layer, matching the product-map
  permission matrix.
- The renderer runs with context isolation, no Node integration, and a strict
  Content-Security-Policy.

_Confidential — Caring Hands Worldwide © 2025–2026._
