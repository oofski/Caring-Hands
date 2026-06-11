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

function progressNoteBody(p) {
  const t = p.treatment || {};
  const tr = p.triage || {};
  const fillings = (t.fillings || []).map(
    (f) => `<span>#${esc(f.tooth)} · ${esc(f.surfaces || '')} ${esc(f.position || '')}</span>`
  ).join('') || '<span class="muted">None</span>';
  const extractions = (t.extractions || []).map(
    (e) => `<span>#${esc(e.tooth)} · ${esc(e.type)}</span>`
  ).join('') || '<span class="muted">None</span>';
  const anesthetic = (t.anesthetic || []).map(
    (a) => `<span>${esc(a.agent)} × ${esc(a.carps)} carp(s)${a.location ? ' · ' + esc(a.location) : ''}</span>`
  ).join('') || '<span class="muted">None</span>';
  const cleaning = Object.entries(t.cleaning || {})
    .filter(([, v]) => v)
    .map(([k]) => `<span>${esc(k)}</span>`)
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

    <h2>Triage Assessment</h2>
    <div class="chips">${checklist}</div>
    <div class="box"><span class="label">Teeth of concern: </span>${(tr.teeth || []).map((x) => `<b>${esc(x)}</b>`).join(', ') || '<span class="muted">—</span>'}</div>
    ${tr.notes ? `<div class="box"><span class="label">Triage notes</span><br>${esc(tr.notes)}</div>` : ''}
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

  const consents = (p.consents || []).map((c) => `
    <div class="box">
      <div class="two">
        <div>
          <div class="label">${c.type === 'oral_surgery' ? 'Oral Surgery Consent' : 'General Dental Consent'}</div>
          <div class="val">${esc(c.signer_name)}${c.relationship ? ' (' + esc(c.relationship) + ')' : ''}</div>
          <div class="muted">${esc(c.version)} · Signed ${fmtDate(c.signed_at)}</div>
        </div>
        <div>${c.signature_png ? `<div class="sig"><img src="${c.signature_png}"/></div>` : ''}</div>
      </div>
    </div>`).join('') || '<span class="muted">No consents on file</span>';

  return `
    <h2>Patient Information</h2>
    <table class="grid">
      <tr>${field('Full name', `${p.first_name} ${p.last_name}`)}${field('Date of birth', p.dob)}</tr>
      <tr>${field('Age', p.age)}${field('Gender', p.gender)}</tr>
      <tr>${field('Phone', p.phone)}${field('Email', p.email)}</tr>
      <tr>${field('Address', d.address)}${field('Mailing address', d.mailing_address)}</tr>
      <tr>${field('Marital status', d.marital_status)}${field('Children', (d.children || []).join(', '))}</tr>
      <tr>${field('Emergency contact', d.emergency_name)}${field('Emergency phone', d.emergency_phone)}</tr>
      <tr>${field('Referral source', d.referral)}${field('Preferred language', p.language === 'es' ? 'Spanish' : 'English')}</tr>
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

function buildHtml(p, format) {
  const title = format === 'full' ? 'Patient Record — Full Packet' : 'Progress Note';
  const body = format === 'full' ? fullPacketBody(p) : progressNoteBody(p);
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
