'use strict';
/**
 * Turns a clinic bundle into readable spreadsheet sheets.
 *
 * This is the half a human reads, so it is flattened, labelled in plain English
 * and free of internal codes. It deliberately does NOT carry signatures or x-ray
 * images — those cannot live in a spreadsheet, which is why the export also
 * writes a .chbak.json backup alongside it.
 */
// Codes are title-cased for reading, the same way the printed record does it
// (pdf.js historyItems), so the spreadsheet and the PDF never disagree.
const titleKey = (k) => String(k || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const VISIT_TYPES = {
  extraction_pain: 'Extraction — in pain', extraction_no_pain: 'Extraction — not in pain',
  filling: 'Filling', cleaning: 'Dental cleaning',
};

const j = (v, fallback) => {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { const p = JSON.parse(v); return p == null ? fallback : p; } catch { return fallback; }
};
const yn = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v || '');

// Typed-in "other" text is always included, ticked or not — a written allergy
// must never be missing from an exported record.
function labelled(keys, other) {
  const out = (Array.isArray(keys) ? keys : [])
    .filter((k) => k !== 'other' && k !== 'none')
    .map(titleKey);
  if (other) out.push(String(other));
  if (!out.length && (keys || []).includes('none')) return 'None';
  return out.join(', ');
}

function ageFrom(dob) {
  if (!dob) return '';
  const d = new Date(dob);
  if (isNaN(d)) return '';
  return Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
}

function clinicSheets(bundle) {
  const b = bundle || {};
  const patients = b.patients || [];
  const triageBy = new Map((b.triage || []).map((r) => [r.patient_id, r]));
  const txBy = new Map((b.treatments || []).map((r) => [r.patient_id, r]));
  const consentsBy = new Map();
  (b.consents || []).forEach((c) => {
    if (!consentsBy.has(c.patient_id)) consentsBy.set(c.patient_id, []);
    consentsBy.get(c.patient_id).push(c);
  });
  const xraysBy = new Map();
  (b.xrays || []).forEach((x) => {
    if (!xraysBy.has(x.patient_id)) xraysBy.set(x.patient_id, []);
    xraysBy.get(x.patient_id).push(x);
  });

  const STATUS = {
    checked_in: 'Checked in', triaged: 'Ready for treatment',
    in_treatment: 'In treatment', completed: 'Completed', dismissed: 'Checked out',
  };

  const patientRows = patients.map((p) => {
    const d = j(p.demographics, {}), m = j(p.medical_history, {}), dh = j(p.dental_history, {});
    const tr = triageBy.get(p.id) || {};
    const meds = (m.medications || []).map((x) => (typeof x === 'string' ? x : [x.name, x.dose].filter(Boolean).join(' '))).filter(Boolean);
    return [
      p.last_name, p.first_name, p.dob, ageFrom(p.dob), p.gender, p.language,
      p.phone, p.email, d.address, d.city, d.state,
      d.emergency_name, d.emergency_phone,
      d.preregistered ? 'Online' : 'At the desk',
      VISIT_TYPES[dh.visit_type] || dh.visit_type || '',
      dh.reason,
      labelled(m.allergies, m.allergies_other),
      labelled(m.conditions, m.conditions_other),
      meds.length ? meds.join('; ') : (m.medications_none ? 'None' : ''),
      yn(m.under_treatment), yn(m.hospitalized), yn(m.tobacco), yn(m.pregnancy),
      tr.bp_systolic != null && tr.bp_diastolic != null ? `${tr.bp_systolic}/${tr.bp_diastolic}` : '',
      tr.heart_rate == null ? '' : tr.heart_rate,
      tr.route === 'dentist' ? 'Dentist' : tr.route === 'hygienist' ? 'Hygienist' : '',
      STATUS[p.status] || p.status,
      p.created_at, p.arrived_at, p.dismissed_at,
    ];
  });

  const treatmentRows = [];
  patients.forEach((p) => {
    const t = txBy.get(p.id);
    if (!t) return;
    const fillings = j(t.fillings, []), extractions = j(t.extractions, []), cleaning = j(t.cleaning, {});
    const anes = j(t.anesthetic, []);
    treatmentRows.push([
      p.last_name, p.first_name,
      extractions.length, extractions.map((e) => e.tooth).filter(Boolean).join(', '),
      fillings.length, fillings.map((f) => [f.tooth, (f.surfaces || []).join(',')].filter(Boolean).join(' ')).filter(Boolean).join(', '),
      cleaning && Object.keys(cleaning).length ? 'Yes' : '',
      anes.map((x) => [x.agent, x.carps && x.carps + ' carp(s)', x.tooth && 'tooth ' + x.tooth].filter(Boolean).join(' ')).join('; '),
      t.other_procedures, t.clinical_notes, t.provider_name, t.completed_at,
      t.locked ? 'Signed off' : '',
    ]);
  });

  const consentRows = [];
  patients.forEach((p) => {
    (consentsBy.get(p.id) || []).forEach((c) => consentRows.push([
      p.last_name, p.first_name,
      c.type === 'oral_surgery' ? 'Oral Surgery' : 'General',
      c.signer_name, c.relationship, c.tooth_numbers,
      String(c.signature_png || '').startsWith('data:image') ? 'Signed' : 'Not signed',
      c.signed_at, c.language, c.version,
    ]));
  });

  const xrayRows = [];
  patients.forEach((p) => {
    (xraysBy.get(p.id) || []).forEach((x) => xrayRows.push([
      p.last_name, p.first_name, x.note, x.tooth, x.station, x.created_at,
    ]));
  });

  return [
    {
      name: 'Patients',
      columns: ['Last name', 'First name', 'Date of birth', 'Age', 'Gender', 'Language',
        'Phone', 'Email', 'Address', 'City', 'State', 'Emergency contact', 'Emergency phone',
        'Registered', 'Needed today', 'Reason', 'Allergies', 'Conditions', 'Medications',
        'Under doctor’s care', 'Hospitalized (2 yrs)', 'Tobacco', 'Pregnant/nursing',
        'Blood pressure', 'Pulse', 'Sent to', 'Status', 'Checked in at', 'Arrived at', 'Checked out at'],
      rows: patientRows,
    },
    {
      name: 'Treatment',
      columns: ['Last name', 'First name', 'Extractions', 'Teeth extracted', 'Fillings',
        'Teeth filled', 'Cleaning', 'Anaesthetic', 'Other procedures', 'Clinical notes',
        'Provider', 'Completed at', 'Signed off'],
      rows: treatmentRows,
    },
    {
      name: 'Consents',
      columns: ['Last name', 'First name', 'Consent', 'Signed by', 'Relationship',
        'Tooth numbers', 'Signature', 'Signed at', 'Language', 'Version'],
      rows: consentRows,
    },
    {
      name: 'X-rays',
      columns: ['Last name', 'First name', 'Image name', 'Tooth', 'Station', 'Taken at'],
      rows: xrayRows,
    },
  ];
}

// Summary sheet for a finished clinic — counts only, no patients.
function summarySheets(summary) {
  const s = summary || {};
  const breakdown = (title, obj) => ({
    name: title,
    columns: [title, 'Patients'],
    rows: Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
  });
  return [
    {
      name: 'Summary',
      columns: ['Measure', 'Value'],
      rows: [
        ['Clinic', s.event_name], ['Location', s.event_location], ['Start date', s.event_start],
        ['Patients seen', s.patients_seen], ['Visits completed', s.visits_completed],
        ['Extractions', s.extractions], ['Fillings', s.fillings],
        ['Cleanings', s.cleanings], ['X-rays taken', s.xrays],
        ['Report generated', s.generated_at],
      ],
    },
    breakdown('By city', s.by_city),
    breakdown('By age', s.by_age),
    breakdown('By gender', s.by_gender),
    breakdown('By language', s.by_language),
    breakdown('By day', s.by_day),
  ];
}

module.exports = { clinicSheets, summarySheets };
