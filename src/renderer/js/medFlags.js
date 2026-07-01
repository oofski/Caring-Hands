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
  const detected = bloodThinnerFlags(p.medical_history).map((f) => f.replace(PREFIX, ''));
  const confirmed = tr.blood_thinner === 'yes' || tr.blood_thinner === 'no' ? tr.blood_thinner : null;
  const names = new Set(detected);
  if (tr.blood_thinner === 'yes' && tr.blood_thinner_detail) {
    String(tr.blood_thinner_detail).split(/,\s*/).forEach((n) => n.trim() && names.add(n.trim()));
  }
  const onThinner = confirmed === 'yes' || (confirmed == null && detected.length > 0);
  return { onThinner, confirmed, names: [...names] };
}
