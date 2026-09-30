'use strict';

/**
 * PDF generation for patient records.
 *
 * Builds an HTML representation of the record and renders it to PDF with
 * Electron's offscreen print engine (works fully offline). Two formats:
 *   - 'progress'  : the clinical Progress Note (matches the CHW form)
 *   - 'full'      : complete packet (demographics, histories, consents, note)
 */

const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function yn(v) {
  return v === true || v === 'yes' || v === 'Yes' ? 'Yes' : v === false || v === 'no' ? 'No' : esc(v || '—');
}

// Only allow safe image sources (data:image or http(s)) and strip any stray
// quotes, so a crafted signature/x-ray value can't break out of the src="" and
// inject markup/handlers into the print renderer.
function imgSrc(v) {
  const s = String(v == null ? '' : v);
  if (!/^(data:image\/|https?:\/\/)/i.test(s)) return '';
  return s.replace(/"/g, '%22');
}

// Embedded x-ray images block, shared by the summary and full-record PDFs.
function xrayGallery(p) {
  return (p._xrays || []).filter((x) => x && x.image_png).map((x) => `
    <div class="xray">
      <img src="${imgSrc(x.image_png)}"/>
      <div class="cap">${x.tooth ? 'Tooth ' + esc(x.tooth) : (x.station ? 'Station ' + esc(x.station) : 'X-ray')}${x.note ? ' · ' + esc(x.note) : ''}</div>
    </div>`).join('');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function styles() {
  return `
    <style>
      * { box-sizing: border-box; }
      body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2933; font-size: 12px; margin: 0; }
      .page { padding: 36px 40px; }
      .hdr { display:flex; justify-content:space-between; align-items:flex-start; border-bottom: 3px solid #1a6aa8; padding-bottom: 10px; margin-bottom: 16px; }
      .brand { font-size: 20px; font-weight: 700; color:#1a6aa8; letter-spacing:.5px; }
      .brand small { display:block; font-size: 10px; color:#7cb342; font-weight:700; letter-spacing:3px; }
      .doc-title { text-align:right; font-size: 14px; font-weight:700; color:#334e68; }
      .doc-title small { display:block; font-weight: 400; color:#627d98; font-size: 10px; }
      h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color:#1a6aa8; border-bottom:1px solid #d9e2ec; padding-bottom:4px; margin: 18px 0 8px; }
      table { width:100%; border-collapse: collapse; }
      td, th { text-align:left; vertical-align: top; padding: 3px 6px; }
      .grid td { width: 50%; }
      .label { color:#627d98; font-size: 10px; text-transform: uppercase; letter-spacing:.5px; }
      .val { font-weight: 600; }
      .chips span { display:inline-block; background:#eaf3f9; color:#1a6aa8; border:1px solid #cfe2f0; border-radius: 10px; padding: 2px 9px; margin: 2px 4px 2px 0; font-size: 11px; }
      .flag { background:#fdecec !important; color:#b3261e !important; border-color:#f5c2c0 !important; }
      .box { border:1px solid #d9e2ec; border-radius:6px; padding:8px 10px; margin: 6px 0; background:#fbfdff; }
      .sig { border:1px solid #d9e2ec; border-radius:6px; padding:6px; display:inline-block; margin-right: 12px; }
      .sig img { height: 56px; display:block; }
      .muted { color:#627d98; }
      .footer { margin-top: 22px; border-top:1px solid #d9e2ec; padding-top:8px; font-size: 10px; color:#829ab1; display:flex; justify-content:space-between; }
      .two { display:flex; gap: 18px; }
      .two > div { flex:1; }
      .pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:700; }
      .pagebreak { page-break-before: always; }
      .consent-body { white-space: pre-wrap; line-height: 1.45; }
      .xrays { display:flex; flex-wrap:wrap; gap: 10px; margin-top: 4px; }
      .xray { border:1px solid #d9e2ec; border-radius:6px; padding:6px; background:#fbfdff; width: 168px; }
      .xray img { width: 100%; height: 110px; object-fit: cover; display:block; border-radius:4px; background:#000; }
      .xray .cap { font-size: 10px; color:#627d98; margin-top:4px; }
    </style>`;
}

function header(title, subtitle) {
  return `
    <div class="hdr">
      <div class="brand">CARING HANDS<small>WORLDWIDE</small></div>
      <div class="doc-title">${esc(title)}<small>${esc(subtitle || '')}</small></div>
    </div>`;
}

function footer(p) {
  return `<div class="footer">
      <span>Caring Hands Worldwide — Confidential Patient Record</span>
      <span>${esc(p.last_name)}, ${esc(p.first_name)} · Generated ${fmtDate(new Date().toISOString())}</span>
    </div>`;
}

function field(label, value) {
  return `<td><div class="label">${esc(label)}</div><div class="val">${value == null || value === '' ? '—' : esc(value)}</div></td>`;
}
// Same as field() but the value is trusted, pre-built HTML (already escaped where
// needed) — used for the blood-pressure cell, which colours a high reading red.
function fieldRaw(label, valueHtml) {
  return `<td><div class="label">${esc(label)}</div><div class="val">${valueHtml == null || valueHtml === '' ? '—' : valueHtml}</div></td>`;
}

// Hypertensive-crisis threshold — mirrors src/renderer/js/medFlags.js (systolic
// OVER 180 or diastolic OVER 100, strictly). Returns the "BP x/y" fragment, red +
// bold when high so the printed record matches the on-screen alert. The numbers
// are escaped, so the returned HTML is safe to inline.
const PDF_BP_SYS_MAX = 180;
const PDF_BP_DIA_MAX = 100;
function bpHtml(tr, label = 'BP') {
  const t = tr || {};
  const sys = t.bp_systolic != null ? esc(t.bp_systolic) : '—';
  const dia = t.bp_diastolic != null ? esc(t.bp_diastolic) : '—';
  const sN = t.bp_systolic == null || t.bp_systolic === '' ? null : Number(t.bp_systolic);
  const dN = t.bp_diastolic == null || t.bp_diastolic === '' ? null : Number(t.bp_diastolic);
  const high = (sN != null && !Number.isNaN(sN) && sN > PDF_BP_SYS_MAX) || (dN != null && !Number.isNaN(dN) && dN > PDF_BP_DIA_MAX);
  const text = `${label} ${sys}/${dia}`;
  return high ? `<span style="color:#c0392b;font-weight:bold">${text} — HIGH</span>` : text;
}
// Any additional BP re-checks the EMT recorded (each red if still high).
function bpRechecksHtml(tr) {
  const rc = (tr && Array.isArray(tr.bp_rechecks)) ? tr.bp_rechecks : [];
  return rc.map((r) => bpHtml({ bp_systolic: r.bp_systolic, bp_diastolic: r.bp_diastolic }, 're-check')).join(' · ');
}

const EXT_LABELS = {
  simple: 'Simple', impact_soft: 'Impact soft tissue', impact_bony: 'Impact part bony',
  surgical: 'Surgical', root_tip: 'Root tip',
};
const CLEAN_LABELS = {
  adult_prophy: 'Adult prophy', adult_fluoride: 'Adult fluoride', fluoride: 'Fluoride',
  gross_debridement: 'Gross debridement', quad_deep_scaling: 'Quadrant deep scaling',
  sealant: 'Sealant', ohi: 'Oral hygiene instruction',
};
const ANES_LABELS = { lidocaine: 'Lidocaine 2%', articaine: 'Articaine 4%', other: 'Other', supplemental: 'Supplemental' };

// F4: map known referral keys to English labels; pass legacy/free text through.
// (pdf.js cannot import the renderer i18n module, so the small map is hardcoded.)
const REFERRAL_LABELS = {
  email: 'Email',
  text: 'Text message',
  sign: 'Sign / banner',
  friend_referral: 'Friend / referral',
  flyer: 'Flyer',
  church: 'Church / community',
  social_media: 'Social media',
  other: 'Other',
};
function referralLabel(key) {
  if (key == null || key === '') return '';
  return REFERRAL_LABELS[key] || String(key);
}

// F9: EXACT Oregon statutory general-consent language (English authoritative —
// do not alter). Kept verbatim in sync with i18n strings (consent.oregon).
const OREGON_CONSENT =
  'I certify that I have read this Consent, or that it has been read to me, and that I understand the above. ' +
  'The nature and purpose of such operation(s), procedure(s), treatment(s), and/or services and the reasons why ' +
  'the same is (are) considered necessary or advisable has been explained to me. I hereby hold Caring Hands ' +
  'Worldwide, Associate Dentist and/or such assistants harmless for the free dental care provided. Services are ' +
  'provided without compensation and that the provider’s liability is limited and the provider may not be held ' +
  'liable for any injury, death or other loss arising out of the provision of these services, unless the injury, ' +
  'death or other loss results from gross negligence. I am also aware of the risk of exposure to COVID during a ' +
  'dental procedure and I consent to participate in this clinic at my own risk.';

// Teeth flagged at triage, WITH the note attached to each one.
//
// triage.teeth_notes is written by the odontogram, travels in sync, and until
// v1.11.0 appeared on no printed output at all: the progress note listed bare
// tooth numbers, so "#19 — deep caries, cold sensitive" reached the paper chart
// as "19". On screen it is reachable only by hovering an SVG title, which on a
// clinic touchscreen means invisible.
function teethOfConcern(tr) {
  const teeth = (tr && tr.teeth) || [];
  if (!teeth.length) return '<span class="muted">—</span>';
  const notes = (tr && tr.teeth_notes) || {};
  return teeth.map((x) => `<b>#${esc(x)}</b>${notes[x] ? ' — ' + esc(notes[x]) : ''}`).join(' &middot; ');
}

// The front desk's and the vitals station's handover notes.
//
// On the clinical record only — NOT on summaryBody, which is the copy check-out
// hands the patient. "Patient seems agitated" is a fair thing for one clinician
// to tell the next and the wrong thing to print on what someone takes home.
function stationNotesHtml(tr) {
  const list = (tr && Array.isArray(tr.station_notes)) ? tr.station_notes : [];
  if (!list.length) return '';
  const items = list.map((n) => `<div class="box"><span class="label">${esc(n.station || 'Clinic')} \u00b7 ${esc(n.by_name || 'Unknown')}${n.at ? ' \u00b7 ' + fmtDate(n.at) : ''}</span><br>${esc(n.note || '')}</div>`).join('');
  return `<h2>Notes from the front desk &amp; vitals</h2>${items}`;
}

// Which dentist saw the patient first. With a triage dentist and a separate
// treating dentist, "Provider" at the foot of the note names only the second of
// them, and the assessment the note is built on has no author on the page.
function triagedByLine(tr) {
  if (!tr || (!tr.triaged_by_name && !tr.triaged_at)) return '';
  return `<div class="box"><span class="label">Triaged by: </span>${esc(tr.triaged_by_name || 'Not recorded')}${tr.triaged_at ? ' · ' + fmtDate(tr.triaged_at) : ''}</div>`;
}

function progressNoteBody(p) {
  const t = p.treatment || {};
  const tr = p.triage || {};
  const fillings = (t.fillings || []).map((f) => {
    const surf = Array.isArray(f.surfaces) ? f.surfaces.join(',') : (f.surfaces || '');
    const ap = [f.ant ? 'Ant' : '', f.post ? 'Post' : ''].filter(Boolean).join('/') || esc(f.position || '');
    return `<span>#${esc(f.tooth)}${surf ? ' · surf ' + esc(surf) : ''}${ap ? ' · ' + esc(ap) : ''}${f.note ? ' — ' + esc(f.note) : ''}</span>`;
  }).join('') || '<span class="muted">None</span>';
  const extractions = (t.extractions || []).map((e) => {
    if (e.other) return `<span>Other: ${esc(e.other)}${e.tooth ? ' · #' + esc(e.tooth) : ''}</span>`;
    const types = Array.isArray(e.types) ? e.types.map((k) => EXT_LABELS[k] || k).join(', ') : (e.type || '');
    return `<span>#${esc(e.tooth)} · ${esc(types)}${e.note ? ' — ' + esc(e.note) : ''}</span>`;
  }).join('') || '<span class="muted">None</span>';
  const anesEntries = Array.isArray(t.anesthetic)
    ? t.anesthetic.map((a) => `<span>${esc(a.agent === 'other' ? (a.name || 'Other') : (ANES_LABELS[a.agent] || a.agent))}${a.carps ? ' × ' + esc(a.carps) + ' carp(s)' : ''}${a.tooth ? ' · #' + esc(a.tooth) : ''}${a.location ? ' · ' + esc(a.location) : ''}</span>`)
    : Object.entries(t.anesthetic || {}).map(([k, v]) => {
        const label = k === 'other' && v.name ? `Other (${v.name})` : (ANES_LABELS[k] || k);
        return `<span>${esc(label)}${v.carps ? ' × ' + esc(v.carps) + ' carp(s)' : ''}${v.tooth ? ' · #' + esc(v.tooth) : ''}${v.location ? ' · ' + esc(v.location) : ''}</span>`;
      });
  const anesthetic = anesEntries.join('') || '<span class="muted">None</span>';
  const cleaning = Object.entries(t.cleaning || {})
    .filter(([k, v]) => v && k !== 'quad_detail')
    .map(([k]) => `<span>${esc(CLEAN_LABELS[k] || k)}${k === 'quad_deep_scaling' && t.cleaning.quad_detail ? ' (' + esc(t.cleaning.quad_detail) + ')' : ''}</span>`)
    .join('') || '<span class="muted">None</span>';
  const checklist = Object.entries(tr.checklist || {})
    .filter(([, v]) => v)
    .map(([k]) => `<span>${esc(k)}</span>`)
    .join('') || '<span class="muted">—</span>';

  return `
    <h2>Patient & Visit</h2>
    <table class="grid">
      <tr>${field('Patient', `${p.first_name} ${p.last_name}`)}${field('Date of Birth', p.dob)}</tr>
      <tr>${field('Age', p.age != null ? p.age : '—')}${field('Event', p.event ? p.event.name : '—')}</tr>
      <tr>${field('Chief Complaint', tr.complaint)}${field('Status', p.status)}</tr>
    </table>

    <h2>Clinical Assessment</h2>
    ${(tr.bp_systolic != null || tr.bp_diastolic != null || tr.heart_rate != null || tr.blood_thinner)
      ? `<div class="box"><span class="label">Vitals: </span>${bpHtml(tr)}${bpRechecksHtml(tr) ? ' · ' + bpRechecksHtml(tr) : ''} · HR ${tr.heart_rate != null ? esc(tr.heart_rate) : '—'} · Blood thinners: ${esc(bloodThinnerLine(p))}</div>`
      : ''}
    <div class="chips">${checklist}</div>
    <div class="box"><span class="label">Teeth of concern: </span>${teethOfConcern(tr)}</div>
    ${tr.notes ? `<div class="box"><span class="label">Assessment notes</span><br>${esc(tr.notes)}</div>` : ''}
    ${triagedByLine(tr)}
    <div class="box"><span class="label">X-rays taken: </span>${esc(tr.xray_count || 0)}${tr.xray_station ? ' · Station ' + esc(tr.xray_station) : ''}</div>

    ${stationNotesHtml(tr)}

    <h2>Treatment Provided</h2>
    <div><span class="label">Fillings</span><div class="chips">${fillings}</div></div>
    <div><span class="label">Extractions</span><div class="chips">${extractions}</div></div>
    <div><span class="label">Cleaning</span><div class="chips">${cleaning}</div></div>
    <div><span class="label">Anesthetic</span><div class="chips">${anesthetic}</div></div>
    ${t.other_procedures ? `<div class="box"><span class="label">Other procedures</span><br>${esc(t.other_procedures)}</div>` : ''}
    ${t.clinical_notes ? `<div class="box"><span class="label">Clinical notes</span><br>${esc(t.clinical_notes)}</div>` : ''}
    ${addendaHtml(t, esc)}

    <h2>Provider Sign-Off</h2>
    <div class="two">
      <div>
        <div class="label">Provider</div>
        <div class="val">${esc(t.provider_name || '—')}</div>
        <div class="muted">${t.completed_at ? 'Signed ' + fmtDate(t.completed_at) : 'Not yet finalized'}</div>
      </div>
      <div>
        ${t.provider_signature ? `<div class="sig"><img src="${imgSrc(t.provider_signature)}"/></div>` : '<span class="muted">No signature</span>'}
      </div>
    </div>`;
}

function fullPacketBody(p) {
  const d = p.demographics || {};
  const m = p.medical_history || {};
  const dh = p.dental_history || {};

  const aItems = historyItems(m.allergies, m, 'allergies_other');
  const allergies = aItems.length
    ? aItems.map((a) => `<span class="flag">${a}</span>`).join('')
    : `<span class="muted">${(m.allergies || []).includes('none') ? 'None (reviewed)' : 'None reported'}</span>`;
  const cItems = historyItems(m.conditions, m, 'conditions_other');
  const conditions = cItems.length
    ? cItems.map((c) => `<span>${c}</span>`).join('')
    : `<span class="muted">${(m.conditions || []).includes('none') ? 'None (reviewed)' : 'None reported'}</span>`;
  const meds = (m.medications || []).map(
    (x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.dose || '')}</td><td>${esc(x.reason || '')}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="muted">None reported</td></tr>';

  const consents = (p.consents || []).map((c) => {
    const isSurgery = c.type === 'oral_surgery';
    // F10: oral-surgery consent tooth numbers (set later by the doctor).
    let teethBlock = '';
    if (isSurgery) {
      if (c.tooth_numbers != null && String(c.tooth_numbers).trim() !== '') {
        const amend = c.amended_by || c.amended_at
          ? ` <span class="muted">(added after signature${c.amended_by ? ' by ' + esc(c.amended_by) : ''}${c.amended_at ? ' on ' + fmtDate(c.amended_at) : ''})</span>`
          : '';
        teethBlock = `<div class="box"><span class="label">Tooth #(s): </span><b>${esc(c.tooth_numbers)}</b>${amend}</div>`;
      } else {
        teethBlock = `<div class="box"><span class="label">Tooth #(s): </span>____________________</div>`;
      }
    }
    // F9: render the verbatim Oregon general-consent body for general consents.
    // `c.body` was never a column on consents — nothing has ever written it —
    // so this always fell through to the constant. Read it straight.
    const consentBody = !isSurgery
      ? `<div class="box consent-body">${esc(OREGON_CONSENT)}</div>`
      : '';
    // A consent is only SIGNED if there is a signature. Printing "Signed" over
    // an empty box asserted something the record does not support.
    const isSigned = !!String(c.signature_png || '').trim();
    return `
    <div class="box">
      <div class="two">
        <div>
          <div class="label">${isSurgery ? 'Oral Surgery Consent' : 'General Dental Consent'}</div>
          <div class="val">${esc(c.signer_name)}${c.relationship ? ' (' + esc(c.relationship) + ')' : ''}</div>
          <div class="muted">${esc(c.version)} · ${isSigned ? 'Signed ' + fmtDate(c.signed_at) : '<b>NOT SIGNED</b>'}</div>
        </div>
        <div>${isSigned
          ? `<div class="sig"><img src="${imgSrc(c.signature_png)}"/></div>`
          : '<div class="sig sig--unsigned"><span class="muted">No signature on file</span></div>'}</div>
      </div>
      ${consentBody}
      ${teethBlock}
    </div>`;
  }).join('') || '<span class="muted">No consents on file</span>';

  return `
    <h2>Patient Information</h2>
    <table class="grid">
      <tr>${field('Full name', `${p.first_name} ${p.last_name}`)}${field('Date of birth', p.dob)}</tr>
      <tr>${field('Age', p.age)}${field('Gender', p.gender)}</tr>
      <tr>${field('Phone', p.phone)}${field('Email', p.email)}</tr>
      <tr>${field('Address', d.address)}${field('Mailing address', d.mailing_address)}</tr>
      <tr>${field('City', d.city)}${field('State', d.state)}</tr>
      <tr>${field('Marital status', d.marital_status)}${field('Emergency contact', d.emergency_name)}</tr>
      <tr>${field('Emergency phone', d.emergency_phone)}${field('Referral source', d.referral === 'other' && d.referral_other ? d.referral_other : referralLabel(d.referral))}</tr>
      <tr>${field('Preferred language', p.language === 'es' ? 'Spanish' : 'English')}</tr>
    </table>

    <h2>Medical History</h2>
    <table class="grid">
      <tr>${field('Currently under treatment', m.under_treatment)}${field('Recent hospitalization', m.hospitalized)}</tr>
      <tr>${field('Tobacco use', m.tobacco)}${field('Pregnant / nursing', m.pregnancy)}</tr>
    </table>
    <div><span class="label">Medication allergies</span><div class="chips">${allergies}</div></div>
    <div><span class="label">Conditions</span><div class="chips">${conditions}</div></div>
    <div><span class="label">Current medications</span>
      <table class="box"><tr><th>Medication</th><th>Dose</th><th>Reason</th></tr>${meds}</table>
    </div>

    <h2>Dental History</h2>
    <table class="grid">
      <tr>${field('What they need today', VISIT_LABELS[dh.visit_type] || '')}${field('May need extraction', dh.may_need_extraction === 'yes' ? 'Yes' : '')}</tr>
      <tr>${field('Reason for visit', dh.reason)}${field('Prior dentist', dh.prior_dentist)}</tr>
      <tr>${field('Gums bleed', dh.gum_bleeding)}${field('Sores / lumps', dh.sores)}</tr>
      <tr>${field('Head/neck/jaw injury', dh.jaw_injury)}${field('Clenching / grinding', dh.grinding)}</tr>
      <tr>${field('Bleeding after extraction', dh.post_extraction_bleeding)}${field('Orthodontic history', dh.ortho)}</tr>
    </table>

    <h2>Consents & Signatures</h2>
    ${consents}

    <h2>X-Rays</h2>
    ${xrayGallery(p) ? `<div class="xrays">${xrayGallery(p)}</div>` : '<span class="muted">No x-rays on file</span>'}

    <div class="pagebreak"></div>
    ${header('Progress Note', `${p.event ? p.event.name : ''}`)}
    ${progressNoteBody(p)}`;
}

// F17: clean patient summary — procedures, anesthetic, notes, and x-ray images.
// Title-case a stored key ("blood_pressure_meds" -> "Blood Pressure Meds").
function titleKey(k) {
  return String(k || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Display items for an allergies/conditions list, used by BOTH PDF paths so they
// can never disagree: drop the 'other'/'none' sentinel keys, title-case the real
// keys, and APPEND the typed "Other" free text — so a written-in allergen (e.g.
// "Sulfa") is never dropped from the printed record.
function historyItems(arr, m, otherKey) {
  const items = (arr || []).filter((x) => x !== 'other' && x !== 'none').map((x) => esc(titleKey(x)));
  // Print typed-in text whenever present, ticked or not (matches the screens).
  if (m && m[otherKey]) items.push(esc(m[otherKey]));
  return items;
}

// The patient's stated need from the 1–4 check-in scale.
const VISIT_LABELS = {
  extraction_pain: 'Extraction — in pain', extraction_no_pain: 'Extraction — not in pain',
  filling: 'Filling', cleaning: 'Dental cleaning',
};

// Reconcile the blood-thinner status for the RECORD the same way the app screens
// do (EMT answer + medication list + self-reported condition), so a printed record
// can never say "Blood thinners: No" while the app is flagging a thinner. Mirrors
// src/renderer/js/medFlags.js.
const PDF_THINNER_MEDS = [
  'eliquis', 'apixaban', 'warfarin', 'coumadin', 'xarelto', 'rivaroxaban', 'plavix', 'clopidogrel',
  'pradaxa', 'dabigatran', 'aspirin', 'asa', 'heparin', 'lovenox', 'enoxaparin', 'brilinta',
  'ticagrelor', 'effient', 'prasugrel', 'savaysa', 'edoxaban', 'aggrenox', 'pletal', 'cilostazol',
];
function bloodThinnerLine(p) {
  const tr = p.triage || {}, m = p.medical_history || {};
  const names = new Set();
  ((m.medications) || []).forEach((x) => {
    const n = (x && x.name ? x.name : '').toLowerCase();
    if (n && PDF_THINNER_MEDS.some((b) => n.split(/[^a-z]+/).includes(b) || n.includes(b))) names.add(String(x.name).trim());
  });
  const medHit = names.size > 0;
  const condHit = ((m.conditions) || []).some((k) => k === 'blood_thinners' || k === 'bleeding');
  const confirmed = tr.blood_thinner === 'yes' || tr.blood_thinner === 'no' ? tr.blood_thinner : null;
  if (confirmed === 'yes' && tr.blood_thinner_detail) String(tr.blood_thinner_detail).split(/,\s*/).forEach((n) => n.trim() && names.add(n.trim()));
  const nm = names.size ? ` (${[...names].join(', ')})` : '';
  if (confirmed === 'no' && (medHit || condHit)) return `Reported on history${nm} — EMT marked "No" — VERIFY before extraction`;
  if (confirmed === 'yes' || medHit || condHit) return `YES${nm}`;
  if (confirmed === 'no') return 'No';
  return 'Not asked';
}

// v1.2.0: the Vitals & Health block that was previously MISSING from the summary
// PDF — EMT-entered vitals, the blood-thinner answer, the patient's medical
// history, and the EMT's yes/no confirmations now attach to the record.
function healthBlock(p) {
  const tr = p.triage || {};
  const m = p.medical_history || {};
  // Blood thinner is passed through field() which escapes — build it RAW (no esc)
  // to avoid double-escaping a detail like "A & B". Vitals go through fieldRaw()
  // instead so a high blood-pressure reading can render red (bpHtml is pre-escaped).
  const vitals = (tr.bp_systolic != null || tr.bp_diastolic != null || tr.heart_rate != null)
    ? `${bpHtml(tr)}${bpRechecksHtml(tr) ? ' · ' + bpRechecksHtml(tr) : ''} · HR ${tr.heart_rate != null ? esc(tr.heart_rate) : '—'} bpm`
    : 'Not recorded';
  const thinner = bloodThinnerLine(p);
  const list = (arr, otherKey) => {
    // Shared with the full-packet PDF via historyItems() so the two record
    // formats can never disagree on allergies/conditions.
    const items = historyItems(arr, m, otherKey);
    return items.length ? items.join(', ') : (arr && arr.includes('none') ? 'None (reviewed)' : 'None reported');
  };
  const allergies = list(m.allergies, 'allergies_other');
  const conditions = list(m.conditions, 'conditions_other');
  const meds = (m.medications || []).length
    ? (m.medications || []).map((x) => `${esc(x.name)}${x.dose ? ' ' + esc(x.dose) : ''}`).join(', ')
    : (m.medications_none ? 'None (reviewed)' : 'None reported');
  const review = tr.emt_review && typeof tr.emt_review === 'object'
    ? Object.entries(tr.emt_review).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${titleKey(k)}: ${esc(String(v)).toUpperCase()}`)
    : [];
  return `
    <h2>Vitals & Health</h2>
    <table class="grid">
      <tr>${fieldRaw('Vitals (by EMT)', vitals)}${field('Blood thinners', thinner)}</tr>
    </table>
    <div><span class="label">Allergies</span> ${allergies}</div>
    <div><span class="label">Conditions</span> ${conditions}</div>
    <div><span class="label">Medications</span> ${meds}</div>
    ${review.length ? `<div class="box"><span class="label">EMT review</span><br>${review.join(' · ')}</div>` : ''}`;
}

function summaryBody(p) {
  const t = p.treatment || {};
  const tr = p.triage || {};

  const fillings = (t.fillings || []).map((f) => {
    const surf = Array.isArray(f.surfaces) ? f.surfaces.join(',') : (f.surfaces || '');
    const ap = [f.ant ? 'Ant' : '', f.post ? 'Post' : ''].filter(Boolean).join('/') || esc(f.position || '');
    return `<span>#${esc(f.tooth)}${surf ? ' · surf ' + esc(surf) : ''}${ap ? ' · ' + esc(ap) : ''}${f.note ? ' — ' + esc(f.note) : ''}</span>`;
  }).join('') || '<span class="muted">None</span>';

  const extractions = (t.extractions || []).map((e) => {
    if (e.other) return `<span>Other: ${esc(e.other)}${e.tooth ? ' · #' + esc(e.tooth) : ''}</span>`;
    const types = Array.isArray(e.types) ? e.types.map((k) => EXT_LABELS[k] || k).join(', ') : (e.type || '');
    return `<span>#${esc(e.tooth)} · ${esc(types)}${e.note ? ' — ' + esc(e.note) : ''}</span>`;
  }).join('') || '<span class="muted">None</span>';

  const cleaning = Object.entries(t.cleaning || {})
    .filter(([k, v]) => v && k !== 'quad_detail')
    .map(([k]) => `<span>${esc(CLEAN_LABELS[k] || k)}${k === 'quad_deep_scaling' && t.cleaning.quad_detail ? ' (' + esc(t.cleaning.quad_detail) + ')' : ''}</span>`)
    .join('') || '<span class="muted">None</span>';

  const anesEntries = Array.isArray(t.anesthetic)
    ? t.anesthetic.map((a) => `<span>${esc(a.agent === 'other' ? (a.name || 'Other') : (ANES_LABELS[a.agent] || a.agent))}${a.carps ? ' × ' + esc(a.carps) + ' carp(s)' : ''}${a.tooth ? ' · #' + esc(a.tooth) : ''}${a.location ? ' · ' + esc(a.location) : ''}</span>`)
    : Object.entries(t.anesthetic || {}).map(([k, v]) => {
        const label = k === 'other' && v.name ? `Other (${v.name})` : (ANES_LABELS[k] || k);
        return `<span>${esc(label)}${v.carps ? ' × ' + esc(v.carps) + ' carp(s)' : ''}${v.tooth ? ' · #' + esc(v.tooth) : ''}${v.location ? ' · ' + esc(v.location) : ''}</span>`;
      });
  const anesthetic = anesEntries.join('') || '<span class="muted">None</span>';

  const xrays = xrayGallery(p);

  return `
    <h2>Patient & Visit</h2>
    <table class="grid">
      <tr>${field('Patient', `${p.first_name} ${p.last_name}`)}${field('Date of birth', p.dob)}</tr>
      <tr>${field('Event', p.event ? p.event.name : '—')}${field('Provider', t.provider_name)}</tr>
    </table>

    ${tr.complaint || (tr.teeth || []).length || tr.notes || tr.triaged_by_name ? `<h2>Triage Assessment</h2>
      ${tr.complaint ? `<div class="box"><span class="label">Chief complaint: </span>${esc(tr.complaint)}</div>` : ''}
      <div class="box"><span class="label">Teeth of concern: </span>${teethOfConcern(tr)}</div>
      ${tr.notes ? `<div class="box"><span class="label">Assessment notes</span><br>${esc(tr.notes)}</div>` : ''}
      ${triagedByLine(tr)}` : ''}

    ${healthBlock(p)}

    <h2>Procedures Performed</h2>
    <div><span class="label">Fillings</span><div class="chips">${fillings}</div></div>
    <div><span class="label">Extractions</span><div class="chips">${extractions}</div></div>
    <div><span class="label">Cleaning</span><div class="chips">${cleaning}</div></div>
    <div><span class="label">Anesthetic</span><div class="chips">${anesthetic}</div></div>
    ${t.other_procedures ? `<div class="box"><span class="label">Other procedures</span><br>${esc(t.other_procedures)}</div>` : ''}

    ${t.clinical_notes ? `<h2>Clinical / Dental Notes</h2><div class="box">${esc(t.clinical_notes)}</div>` : ''}
    ${addendaHtml(t, esc)}

    <h2>X-Rays</h2>
    ${xrays ? `<div class="xrays">${xrays}</div>` : '<span class="muted">No x-rays on file</span>'}`;
}

// v1.10.0: notes added after the visit was completed. They print BELOW the
// signed clinical note, each stamped with who wrote it and when, so the chart
// the patient takes away is the whole account — not just what was known at the
// moment the record was signed.
function addendaHtml(t, esc) {
  let list = t && t.addenda;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (_e) { list = []; } }
  if (!Array.isArray(list) || !list.length) return '';
  const when = (v) => { const d = new Date(v); return isNaN(d.getTime()) ? String(v || '') : d.toLocaleString(); };
  const items = list.map((a) => `<div class="box"><span class="label">${esc(a.by_name || 'Unknown')} · ${esc(when(a.at))}</span><br>${esc(a.note || '')}</div>`).join('');
  return `<h2>Added after completion</h2>${items}`;
}

/* ================================================================== */
/*  Clinic report — the document a coordinator can be sent              */
/* ================================================================== */

// A PARALLEL generator, not a fourth buildHtml format. buildHtml takes a
// PATIENT: its footer hardcodes p.last_name and the words "Confidential Patient
// Record", and an unrecognised format falls through to the progress note rather
// than failing. A clinic-wide document shares the stylesheet and the helpers and
// nothing else.

// The wordmark, read off disk once and inlined as a data URL. It cannot be
// referenced as a file:// path: the document is loaded as a data: URL (see
// renderClinicPdf) so it has no base to resolve against, and in a packaged build
// the file lives inside the asar. A missing logo must not fail the document —
// the text brand in header() already carries it.
let LOGO_CACHE;
function logoDataUrl() {
  if (LOGO_CACHE !== undefined) return LOGO_CACHE;
  try {
    const svg = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'logo.svg'));
    LOGO_CACHE = 'data:image/svg+xml;base64,' + svg.toString('base64');
  } catch (_e) { LOGO_CACHE = ''; }
  return LOGO_CACHE;
}

function clinicStyles() {
  return `
    <style>
      .logo { height: 42px; display:block; }
      .lede { font-size: 12px; color:#334e68; margin: 2px 0 14px; }
      .barblock { margin-bottom: 12px; }
      .kpis { display:flex; flex-wrap:wrap; gap:8px; margin: 4px 0 6px; }
      .kpi { flex:1 1 30%; min-width:140px; border:1px solid #d9e2ec; border-radius:8px; padding:9px 12px; background:#fbfdff; }
      .kpi b { display:block; font-size:22px; color:#1a6aa8; line-height:1.15; }
      .kpi span { font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:#627d98; }
      .kpi em { display:block; font-style:normal; font-size:10px; color:#829ab1; margin-top:2px; }
      .bars td { padding: 2px 6px 2px 0; font-size: 11px; }
      .bars td.n { text-align:right; width: 46px; font-weight:700; color:#334e68; }
      .bars td.k { width: 130px; color:#334e68; }
      .bar { height:9px; background:#eaf3f9; border-radius:5px; overflow:hidden; }
      .bar i { display:block; height:100%; background:#1a6aa8; }
      .rtable { border:1px solid #d9e2ec; border-radius:6px; overflow:hidden; }
      .rtable th { background:#f0f5fa; font-size:9.5px; text-transform:uppercase; letter-spacing:.4px; color:#627d98; border-bottom:1px solid #d9e2ec; }
      .rtable td { font-size:11px; border-bottom:1px solid #eef2f7; }
      .rtable tr:last-child td { border-bottom:0; }
      .rtable td.n, .rtable th.n { text-align:right; }
      .tnote { color:#627d98; font-size:10px; }
      .note-strip { border-left:3px solid #f0a202; background:#fffaf0; padding:6px 10px; margin:6px 0; border-radius:0 6px 6px 0; }
      .warn { border:1px solid #f5c2c0; background:#fdecec; color:#b3261e; border-radius:6px; padding:9px 12px; margin: 8px 0; font-size:11px; }
    </style>`;
}

function clinicHeader(title, subtitle) {
  const logo = logoDataUrl();
  return `
    <div class="hdr">
      <div>${logo ? `<img class="logo" src="${logo}" alt="Caring Hands Worldwide"/>` : '<div class="brand">CARING HANDS<small>WORLDWIDE</small></div>'}</div>
      <div class="doc-title">${esc(title)}<small>${esc(subtitle || '')}</small></div>
    </div>`;
}

function clinicFooter(withRoster) {
  return `<div class="footer">
      <span>Caring Hands Worldwide${withRoster ? ' — Contains patient names. Internal use only.' : ' — No patient names or identifying details'}</span>
      <span>Generated ${fmtDate(new Date().toISOString())}</span>
    </div>`;
}

function kpiCard(value, label, sub) {
  return `<div class="kpi"><b>${esc(value)}</b><span>${esc(label)}</span>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
}

// A labelled breakdown as proportional bars. Sorted biggest first, because a
// coordinator reads the top of this list and stops.
function barBlock(title, obj, { limit = 6, relabel } = {}) {
  const rows = Object.entries(obj || {})
    .map(([k, v]) => [relabel ? relabel(k) : k, Number(v) || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '';
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit).reduce((n, r) => n + r[1], 0);
  if (rest) shown.push(['Other', rest]);
  const max = Math.max(...shown.map((r) => r[1]));
  const body = shown.map(([k, v]) => `<tr>
      <td class="k">${esc(k)}</td>
      <td><div class="bar"><i style="width:${max ? Math.round((v / max) * 100) : 0}%"></i></div></td>
      <td class="n">${esc(v)}</td>
    </tr>`).join('');
  return `<div class="barblock"><div class="label">${esc(title)}</div><table class="bars">${body}</table></div>`;
}

const GENDER_LABEL = { male: 'Male', m: 'Male', female: 'Female', f: 'Female', other: 'Other' };
const LANG_LABEL = { en: 'English', es: 'Español', bzj: 'Belizean Creole', nya: 'Chichewa', ru: 'Русский', fr: 'Français', pt: 'Português' };
// The summary stores raw codes so it stays language-neutral on disk. Relabelled
// here exactly as the Reports tab does, and never by first letter — that is what
// once printed the Spanish "Mujer" as Male.
const genderLabel = (k) => (k === 'Not recorded' ? k : (GENDER_LABEL[String(k).trim().toLowerCase()] || String(k).charAt(0).toUpperCase() + String(k).slice(1)));
const langLabel = (k) => (k === 'Not recorded' ? k : (LANG_LABEL[k] || String(k).toUpperCase()));

function clinicSummaryBody(data) {
  const r = data.rollup || {};
  const s = r.summary || {};
  const ev = data.event || {};
  const seen = Number(s.patients_seen) || 0;
  const done = Number(s.visits_completed) || 0;
  const pct = seen ? Math.round((done / seen) * 100) : 0;
  const treatments = (Number(s.fillings) || 0) + (Number(s.extractions) || 0) + (Number(s.cleanings) || 0);
  const day = (d) => fmtDate(d + 'T12:00:00').replace(/,\s*\d{1,2}:.*$/, '');
  const dates = [ev.start_date, ev.end_date && ev.end_date !== ev.start_date ? ev.end_date : null]
    .filter(Boolean).map(day).join(' – ');
  const days = (s.days || []).filter((d) => d.date && d.date !== 'Not recorded');
  const dayRows = days.map((d) => `<tr>
      <td>${esc(day(d.date))}</td>
      <td class="n">${esc(d.seen || 0)}</td><td class="n">${esc(d.completed || 0)}</td>
      <td class="n">${esc(d.fillings || 0)}</td><td class="n">${esc(d.extractions || 0)}</td>
      <td class="n">${esc(d.cleanings || 0)}</td>
    </tr>`).join('');

  return `
    ${dates ? `<div class="lede">Clinic dates: ${esc(dates)}</div>` : ''}
    ${r.source === 'kept'
      ? '<div class="box muted">These figures are the totals kept when this clinic was closed and its patient records removed. They are complete; the records behind them are no longer on this computer.</div>'
      : ''}

    <h2>What the clinic did</h2>
    <div class="kpis">
      ${kpiCard(seen, 'Patients seen', s.pre_signups ? `${s.pre_signups} signed up online` : null)}
      ${kpiCard(done, 'Visits finished', seen ? `${pct}% of those seen` : null)}
      ${kpiCard(treatments, 'Procedures', 'fillings + extractions + cleanings')}
    </div>
    <div class="kpis">
      ${kpiCard(Number(s.fillings) || 0, 'Fillings')}
      ${kpiCard(Number(s.extractions) || 0, 'Extractions')}
      ${kpiCard(Number(s.cleanings) || 0, 'Cleanings')}
    </div>
    <div class="kpis">
      ${kpiCard(Number(s.xrays) || 0, 'X-rays taken', s.patients_with_xray ? `for ${s.patients_with_xray} patient(s)` : null)}
      ${kpiCard(Number(s.flagged) || 0, 'With a medical flag', 'allergy, condition or pregnancy')}
      ${kpiCard(Number(s.checked_out) || 0, 'Checked out')}
    </div>

    <h2>Who the clinic saw</h2>
    <div class="two">
      <div>${barBlock('By age', s.by_age, { limit: 5 })}${barBlock('By gender', s.by_gender, { limit: 4, relabel: genderLabel })}</div>
      <div>${barBlock('By city', s.by_city, { limit: 6 })}${barBlock('By language', s.by_language, { limit: 4, relabel: langLabel })}</div>
    </div>

    ${dayRows ? `<h2>Day by day</h2>
    <table class="rtable">
      <thead><tr><th>Day</th><th class="n">Seen</th><th class="n">Finished</th><th class="n">Fillings</th><th class="n">Extractions</th><th class="n">Cleanings</th></tr></thead>
      <tbody>${dayRows}</tbody>
    </table>` : ''}`;
}

function rosterBody(data) {
  const roster = data.roster || [];
  const r = data.rollup || {};
  if (!roster.length) {
    return `<div class="pagebreak"></div><h2>Patient roster</h2>
      <div class="warn">${r.source === 'kept'
        ? 'This clinic has been closed and its patient records removed from this computer, so there is no roster to print. The figures on the previous page are the totals that were kept.'
        : 'No patient records were found for this clinic.'}</div>`;
  }
  const yesNo = (b) => (b ? 'Yes' : '—');
  const rows = roster.map((p) => {
    // The per-tooth triage notes. They are in the database and travel in sync,
    // and until now they appeared on no printed output at all — the progress
    // note prints bare tooth numbers.
    const teeth = (p.teeth || []).map((tn) => {
      const n = p.teeth_notes ? p.teeth_notes[tn] : '';
      return `#${esc(tn)}${n ? ' — ' + esc(n) : ''}`;
    }).join('; ');
    const detail = [
      p.complaint ? `<b>Complaint:</b> ${esc(p.complaint)}` : '',
      teeth ? `<b>Teeth of concern:</b> ${teeth}` : '',
      p.triage_notes ? `<b>Triage notes:</b> ${esc(p.triage_notes)}` : '',
    ].filter(Boolean).join(' &middot; ');
    return `<tr>
        <td>${esc(p.last_name)}, ${esc(p.first_name)}</td>
        <td class="n">${p.age == null ? '—' : esc(p.age)}</td>
        <td>${esc(p.city || '—')}</td>
        <td class="n">${esc(p.fillings)}</td>
        <td class="n">${esc(p.extractions)}</td>
        <td>${yesNo(p.cleaning)}</td>
        <td class="n">${esc(p.xrays)}</td>
        <td>${esc(p.triaged_by_name || '—')}</td>
        <td>${esc(p.provider_name || p.completed_by_name || '—')}${p.signed ? ' <span class="tnote">(signed)</span>' : ''}</td>
      </tr>${detail ? `<tr><td colspan="9" class="tnote" style="padding-top:0">${detail}</td></tr>` : ''}`;
  }).join('');
  // The totals on this page are counted from the same roster rows, so a
  // coordinator can add the column up and get the number printed beneath it.
  const sum = (k) => roster.reduce((n, p) => n + (Number(p[k]) || 0), 0);
  const cleanings = roster.filter((p) => p.cleaning).length;
  return `<div class="pagebreak"></div>
    <h2>Patient roster (${esc(roster.length)})</h2>
    <div class="lede">Every patient on this clinic's list, with what was done. Counted the same way as the figures on the summary page.</div>
    <table class="rtable">
      <thead><tr>
        <th>Patient</th><th class="n">Age</th><th>City</th>
        <th class="n">Fill</th><th class="n">Extr</th><th>Cleaning</th><th class="n">X-ray</th>
        <th>Triaged by</th><th>Treated by</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td><b>Total</b></td><td></td><td></td>
        <td class="n"><b>${esc(sum('fillings'))}</b></td>
        <td class="n"><b>${esc(sum('extractions'))}</b></td>
        <td><b>${esc(cleanings)}</b></td>
        <td class="n"><b>${esc(sum('xrays'))}</b></td>
        <td></td><td></td>
      </tr></tfoot>
    </table>`;
}

// withRoster decides which of the TWO documents this is. They are titled
// differently on purpose: the wrong one cannot be sent by accident if the cover
// says which it is and the footer repeats it on every page.
function buildClinicHtml(data, { withRoster = false } = {}) {
  const d = data || {};
  const ev = d.event || {};
  const sub = [ev.name || (d.rollup && d.rollup.summary && d.rollup.summary.event_name), ev.location].filter(Boolean).join(' · ');
  const title = withRoster ? 'Clinic Summary + Patient Roster' : 'Clinic Summary';
  return `<!doctype html><html><head><meta charset="utf-8">${styles()}${clinicStyles()}</head>
    <body><div class="page">
      ${clinicHeader(title, sub)}
      ${withRoster ? '' : '<div class="box muted">This summary contains <b>no patient names or identifying details</b> — it is safe to share with partners, funders and the wider community.</div>'}
      ${withRoster ? '<div class="warn"><b>Contains patient names.</b> This copy is for the clinic’s own coordinators. Send the summary-only version to anyone outside the clinic.</div>' : ''}
      ${clinicSummaryBody(d)}
      ${withRoster ? rosterBody(d) : ''}
      ${clinicFooter(withRoster)}
    </div></body></html>`;
}

async function renderClinicPdf(data, opts) {
  const html = buildClinicHtml(data, opts || {});
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'none' },
      pageSize: 'Letter',
    });
  } finally {
    win.destroy();
  }
}

function buildHtml(p, format) {
  const title = format === 'full'
    ? 'Patient Record — Full Packet'
    : format === 'summary'
      ? 'Patient Summary'
      : 'Progress Note';
  const body = format === 'full'
    ? fullPacketBody(p)
    : format === 'summary'
      ? summaryBody(p)
      : progressNoteBody(p);
  return `<!doctype html><html><head><meta charset="utf-8">${styles()}</head>
    <body><div class="page">
      ${header(title, p.event ? p.event.name : '')}
      ${body}
      ${footer(p)}
    </div></body></html>`;
}

async function renderPdf(patient, format) {
  const html = buildHtml(patient, format || 'progress');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const data = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'none' },
      pageSize: 'Letter',
    });
    return data; // Buffer
  } finally {
    win.destroy();
  }
}

module.exports = { renderPdf, buildHtml, renderClinicPdf, buildClinicHtml };
