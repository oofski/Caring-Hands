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
    ? t.anesthetic.map((a) => `<span>${esc(a.agent)} × ${esc(a.carps)} carp(s)${a.location ? ' · ' + esc(a.location) : ''}</span>`)
    : Object.entries(t.anesthetic || {}).map(([k, v]) => {
        const label = k === 'other' && v.name ? `Other (${v.name})` : (ANES_LABELS[k] || k);
        return `<span>${esc(label)}${v.carps ? ' × ' + esc(v.carps) + ' carp(s)' : ''}${v.location ? ' · ' + esc(v.location) : ''}</span>`;
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
    ${(tr.bp_systolic != null || tr.heart_rate != null || tr.blood_thinner)
      ? `<div class="box"><span class="label">Vitals: </span>BP ${tr.bp_systolic != null ? esc(tr.bp_systolic) : '—'}/${tr.bp_diastolic != null ? esc(tr.bp_diastolic) : '—'} · HR ${tr.heart_rate != null ? esc(tr.heart_rate) : '—'}${tr.blood_thinner ? ' · Blood thinners: ' + (tr.blood_thinner === 'yes' ? 'YES' + (tr.blood_thinner_detail ? ' (' + esc(tr.blood_thinner_detail) + ')' : '') : 'No') : ''}</div>`
      : ''}
    <div class="chips">${checklist}</div>
    <div class="box"><span class="label">Teeth of concern: </span>${(tr.teeth || []).map((x) => `<b>${esc(x)}</b>`).join(', ') || '<span class="muted">—</span>'}</div>
    ${tr.notes ? `<div class="box"><span class="label">Assessment notes</span><br>${esc(tr.notes)}</div>` : ''}
    <div class="box"><span class="label">X-rays taken: </span>${esc(tr.xray_count || 0)}${tr.xray_station ? ' · Station ' + esc(tr.xray_station) : ''}</div>

    <h2>Treatment Provided</h2>
    <div><span class="label">Fillings</span><div class="chips">${fillings}</div></div>
    <div><span class="label">Extractions</span><div class="chips">${extractions}</div></div>
    <div><span class="label">Cleaning</span><div class="chips">${cleaning}</div></div>
    <div><span class="label">Anesthetic</span><div class="chips">${anesthetic}</div></div>
    ${t.other_procedures ? `<div class="box"><span class="label">Other procedures</span><br>${esc(t.other_procedures)}</div>` : ''}
    ${t.clinical_notes ? `<div class="box"><span class="label">Clinical notes</span><br>${esc(t.clinical_notes)}</div>` : ''}

    <h2>Provider Sign-Off</h2>
    <div class="two">
      <div>
        <div class="label">Provider</div>
        <div class="val">${esc(t.provider_name || '—')}</div>
        <div class="muted">${t.completed_at ? 'Signed ' + fmtDate(t.completed_at) : 'Not yet finalized'}</div>
      </div>
      <div>
        ${t.provider_signature ? `<div class="sig"><img src="${t.provider_signature}"/></div>` : '<span class="muted">No signature</span>'}
      </div>
    </div>`;
}

function fullPacketBody(p) {
  const d = p.demographics || {};
  const m = p.medical_history || {};
  const dh = p.dental_history || {};

  const allergies = (m.allergies || []).map((a) => `<span class="flag">${esc(a)}</span>`).join('') || '<span class="muted">None reported</span>';
  const conditions = (m.conditions || []).map((c) => `<span>${esc(c)}</span>`).join('') || '<span class="muted">None reported</span>';
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
    const consentBody = !isSurgery
      ? `<div class="box consent-body">${esc(c.body || OREGON_CONSENT)}</div>`
      : '';
    return `
    <div class="box">
      <div class="two">
        <div>
          <div class="label">${isSurgery ? 'Oral Surgery Consent' : 'General Dental Consent'}</div>
          <div class="val">${esc(c.signer_name)}${c.relationship ? ' (' + esc(c.relationship) + ')' : ''}</div>
          <div class="muted">${esc(c.version)} · Signed ${fmtDate(c.signed_at)}</div>
        </div>
        <div>${c.signature_png ? `<div class="sig"><img src="${c.signature_png}"/></div>` : ''}</div>
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
      <tr>${field('Marital status', d.marital_status)}${field('Children', (d.children || []).join(', '))}</tr>
      <tr>${field('Emergency contact', d.emergency_name)}${field('Emergency phone', d.emergency_phone)}</tr>
      <tr>${field('Referral source', d.referral === 'other' && d.referral_other ? d.referral_other : referralLabel(d.referral))}${field('Preferred language', p.language === 'es' ? 'Spanish' : 'English')}</tr>
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
      <tr>${field('Reason for visit', dh.reason)}${field('Long-term goals', dh.goals)}</tr>
      <tr>${field('Prior dentist', dh.prior_dentist)}${field('Gums bleed', dh.gum_bleeding)}</tr>
      <tr>${field('Sores / lumps', dh.sores)}${field('Head/neck/jaw injury', dh.jaw_injury)}</tr>
      <tr>${field('Clenching / grinding', dh.grinding)}${field('Bleeding after extraction', dh.post_extraction_bleeding)}</tr>
      <tr>${field('Orthodontic history', dh.ortho)}${field('Cosmetic interest', dh.cosmetic)}</tr>
    </table>

    <h2>Consents & Signatures</h2>
    ${consents}

    <div class="pagebreak"></div>
    ${header('Progress Note', `${p.event ? p.event.name : ''}`)}
    ${progressNoteBody(p)}`;
}

// F17: clean patient summary — procedures, anesthetic, notes, and x-ray images.
function summaryBody(p) {
  const t = p.treatment || {};

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
    ? t.anesthetic.map((a) => `<span>${esc(a.agent)} × ${esc(a.carps)} carp(s)${a.location ? ' · ' + esc(a.location) : ''}</span>`)
    : Object.entries(t.anesthetic || {}).map(([k, v]) => {
        const label = k === 'other' && v.name ? `Other (${v.name})` : (ANES_LABELS[k] || k);
        return `<span>${esc(label)}${v.carps ? ' × ' + esc(v.carps) + ' carp(s)' : ''}${v.location ? ' · ' + esc(v.location) : ''}</span>`;
      });
  const anesthetic = anesEntries.join('') || '<span class="muted">None</span>';

  const xrays = (p._xrays || []).filter((x) => x && x.image_png).map((x) => `
    <div class="xray">
      <img src="${x.image_png}"/>
      <div class="cap">${x.station ? 'Station ' + esc(x.station) : 'X-ray'}${x.note ? ' · ' + esc(x.note) : ''}</div>
    </div>`).join('');

  return `
    <h2>Patient & Visit</h2>
    <table class="grid">
      <tr>${field('Patient', `${p.first_name} ${p.last_name}`)}${field('Date of birth', p.dob)}</tr>
      <tr>${field('Event', p.event ? p.event.name : '—')}${field('Provider', t.provider_name)}</tr>
    </table>

    <h2>Procedures Performed</h2>
    <div><span class="label">Fillings</span><div class="chips">${fillings}</div></div>
    <div><span class="label">Extractions</span><div class="chips">${extractions}</div></div>
    <div><span class="label">Cleaning</span><div class="chips">${cleaning}</div></div>
    <div><span class="label">Anesthetic</span><div class="chips">${anesthetic}</div></div>
    ${t.other_procedures ? `<div class="box"><span class="label">Other procedures</span><br>${esc(t.other_procedures)}</div>` : ''}

    ${t.clinical_notes ? `<h2>Clinical / Dental Notes</h2><div class="box">${esc(t.clinical_notes)}</div>` : ''}

    <h2>X-Rays</h2>
    ${xrays ? `<div class="xrays">${xrays}</div>` : '<span class="muted">No x-rays on file</span>'}`;
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

module.exports = { renderPdf, buildHtml };
