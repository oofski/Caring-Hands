// Detects anticoagulant / antiplatelet ("blood thinner") medications from a
// patient's medication list — critical to flag before any extraction (F12).
// Returns flag strings prefixed "Blood thinner: " so the UI can style them.

const BLOOD_THINNERS = [
  'eliquis', 'apixaban', 'warfarin', 'coumadin', 'xarelto', 'rivaroxaban',
  'plavix', 'clopidogrel', 'pradaxa', 'dabigatran', 'aspirin', 'asa',
  'heparin', 'lovenox', 'enoxaparin', 'brilinta', 'ticagrelor',
  'effient', 'prasugrel', 'savaysa', 'edoxaban', 'aggrenox', 'pletal', 'cilostazol',
];

const PREFIX = 'Blood thinner: ';

export function bloodThinnerFlags(medicalHistory) {
  const out = [];
  const seen = new Set();
  (medicalHistory && medicalHistory.medications ? medicalHistory.medications : []).forEach((m) => {
    const name = (m.name || '').toLowerCase();
    if (!name) return;
    const hit = BLOOD_THINNERS.find((b) => name.split(/[^a-z]+/).includes(b) || name.includes(b));
    if (hit) {
      const label = (m.name || hit).trim();
      if (!seen.has(label.toLowerCase())) { seen.add(label.toLowerCase()); out.push(PREFIX + label); }
    }
  });
  return out;
}

export function isBloodThinnerFlag(f) {
  return typeof f === 'string' && f.indexOf(PREFIX) === 0;
}
export const BLOOD_THINNER_PREFIX = PREFIX;

// v1.0.8: combine what the EMT confirmed with the patient (triage.blood_thinner)
// with what we auto-detected from the medication list. Returns a single object
// the banners can render consistently across EMT / triage / provider.
//   { onThinner:boolean, confirmed:'yes'|'no'|null, names:[...] }
export function bloodThinnerStatus(patient) {
  const p = patient || {};
  const tr = p.triage || {};
  const mh = p.medical_history || {};
  const detected = bloodThinnerFlags(mh).map((f) => f.replace(PREFIX, ''));
  // The patient may also self-report it as a CONDITION at check-in ("Takes blood
  // thinners") without naming a specific drug — that's an equally valid signal.
  // A "Bleeding disorder / bleeds easily" answer is treated the same bleeding
  // risk here, matching db.js (queue on_thinner) and pdf.js (printed record) so
  // the EMT/dentist screens can't under-warn relative to the queue and PDF.
  const conditionThinner = (mh.conditions || []).some((k) => k === 'blood_thinners' || k === 'bleeding');
  const confirmed = tr.blood_thinner === 'yes' || tr.blood_thinner === 'no' ? tr.blood_thinner : null;
  const names = new Set(detected);
  if (tr.blood_thinner === 'yes' && tr.blood_thinner_detail) {
    String(tr.blood_thinner_detail).split(/,\s*/).forEach((n) => n.trim() && names.add(n.trim()));
  }
  // SAFETY: any signal that the patient is on a thinner (EMT "yes", a detected
  // medication, OR the self-reported condition) raises the flag — a "No" answer
  // can never suppress it. `discrepancy` = the EMT said No but another source says yes.
  const selfReported = detected.length > 0 || conditionThinner;
  const onThinner = confirmed === 'yes' || selfReported;
  const discrepancy = confirmed === 'no' && selfReported;
  return { onThinner, confirmed, discrepancy, selfReported, conditionThinner, names: [...names] };
}

// One canonical blood-thinner line, used identically on EVERY screen (EMT,
// dentist, hygienist, check-out, PDF) so the patient's blood-thinner status can
// never read one way in one place and another way somewhere else.
//   level: 'danger' (on a thinner / disagreement) | 'ok' (confirmed none) | 'muted' (not asked)
export function bloodThinnerText(patient) {
  const s = bloodThinnerStatus(patient);
  const names = s.names.length ? ' — ' + s.names.join(', ') : '';
  if (s.discrepancy) {
    return { text: `Blood thinners: reported on the patient's history${names} — EMT marked "No"; verify before any extraction`, level: 'danger', status: s };
  }
  if (s.onThinner) {
    return { text: `Blood thinners: YES${names}`, level: 'danger', status: s };
  }
  if (s.confirmed === 'no') return { text: 'Blood thinners: No', level: 'ok', status: s };
  return { text: 'Blood thinners: not asked', level: 'muted', status: s };
}

// Hypertensive-crisis thresholds: a systolic OVER 180 or a diastolic OVER 100 is
// flagged red wherever the blood-pressure reading is shown (EMT vitals, the
// dentist's handoff strip, the record PDF). Strictly greater-than, so exactly
// 180/100 is not flagged. A blank/omitted reading is never "high".
// NOTE: pdf.js (main process, CommonJS) keeps its own copy of these two numbers —
// keep them in sync if you ever change the threshold.
export const BP_SYS_MAX = 180;
export const BP_DIA_MAX = 100;
export function bpStatus(sys, dia) {
  const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isNaN(n) ? null : n; };
  const s = num(sys);
  const d = num(dia);
  const sysHigh = s != null && s > BP_SYS_MAX;
  const diaHigh = d != null && d > BP_DIA_MAX;
  return { sys: s, dia: d, sysHigh, diaHigh, high: sysHigh || diaHigh };
}
