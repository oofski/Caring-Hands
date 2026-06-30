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
