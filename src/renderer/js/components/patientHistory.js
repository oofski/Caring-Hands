import { el } from '../dom.js';
import { icon } from '../icons.js';
import { conditions, allergies, visitTypeLabel } from '../i18n.js';

// A record created by the old (v1.0) intake bug has no name / empty histories.
export function isIncompleteRecord(p) {
  const noName = !(p.first_name || '').trim() || !(p.last_name || '').trim();
  const d = p.demographics || {}, m = p.medical_history || {}, dh = p.dental_history || {};
  const emptyData = !Object.keys(d).length && !Object.keys(m).length && !Object.keys(dh).length;
  return noName || emptyData;
}

// A clear banner explaining an incomplete legacy record, with optional actions.
export function incompleteBanner(p, { isAdmin, onDelete, onNewCheckin } = {}) {
  if (!isIncompleteRecord(p)) return null;
  const acts = el('div', { class: 'inline-row', style: 'margin-top:10px' });
  if (onNewCheckin) acts.append(el('button', { class: 'btn btn--primary btn--sm', onClick: onNewCheckin }, [icon('clipboard', { size: 14 }), 'Start a new check-in']));
  if (isAdmin && onDelete) acts.append(el('button', { class: 'btn btn--danger btn--sm', onClick: onDelete }, [icon('trash', { size: 14 }), 'Delete this empty record']));
  return el('div', { class: 'banner banner--alert', style: 'flex-direction:column;align-items:flex-start' }, [
    el('div', { style: 'display:flex;gap:9px;align-items:center' }, [
      icon('alert', { size: 16 }),
      el('span', {}, ['This record is missing its intake data. It was created on an older version of the app, before the intake fix. New check-ins capture everything correctly — this empty record can be removed.']),
    ]),
    acts,
  ]);
}

// Full patient history (demographics + medical + dental + consents + prior
// visits) rendered as a set of cards. Shared by Records, Provider, and Triage
// so clinicians always see the complete intake history.
export function patientHistoryCards(p, priorVisits = []) {
  const d = p.demographics || {};
  const m = p.medical_history || {};
  const dh = p.dental_history || {};
  const condLabels = conditions().filter((c) => (m.conditions || []).includes(c.key));
  const allergyLabels = allergies().filter((a) => (m.allergies || []).includes(a.key));
  // SAFETY: a typed "Other" allergy/condition (e.g. "Sulfa") must be visible on
  // screen, not buried in a PDF. Build the display pills with the free text added.
  const allergyPills = allergyLabels.map((a) => el('span', { class: 'pill pill--danger' }, [el('span', { class: 'pill-dot' }), a.label]));
  // Show typed-in text whenever it exists, even if the 'Other' chip wasn't
  // ticked — a written allergy must never be invisible because of a missing box.
  if (m.allergies_other) allergyPills.push(el('span', { class: 'pill pill--danger' }, [el('span', { class: 'pill-dot' }), m.allergies_other]));
  const condPills = condLabels.map((c) => el('span', { class: `pill ${c.flag ? 'pill--danger' : 'pill--info'}` }, [c.flag ? el('span', { class: 'pill-dot' }) : null, c.label]));
  if (m.conditions_other) condPills.push(el('span', { class: 'pill pill--info' }, [m.conditions_other]));

  const kv = (label, val) => el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, [label]), el('span', { class: 'kv-val' }, [val == null || val === '' ? '—' : String(val)])]);
  const card = (ic, title, ...kids) => el('div', { class: 'card' }, [el('div', { class: 'card-title' }, [icon(ic, { size: 15 }), title]), ...kids]);

  const out = [];

  out.push(card('user', 'Patient information',
    el('div', { class: 'kv-grid' }, [
      kv('Date of birth', p.dob), kv('Age', p.age != null ? p.age : '—'),
      kv('Gender', p.gender), kv('Marital status', d.marital_status),
      kv('Phone', p.phone), kv('Email', p.email),
      kv('Address', d.address), kv('Mailing address', d.mailing_address),
      kv('Referral', d.referral),
      kv('Emergency contact', d.emergency_name), kv('Emergency phone', d.emergency_phone),
    ])));

  out.push(card('clipboard', 'Medical history',
    el('div', { class: 'kv-grid' }, [
      kv('Under doctor’s care', m.under_treatment), kv('Hospitalized (2 yrs)', m.hospitalized),
      kv('Tobacco use', m.tobacco), kv('Pregnant / nursing', m.pregnancy),
    ]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Allergies']),
      el('div', { class: 'chip-row' }, allergyPills.length ? allergyPills : [el('span', { class: 'muted' }, [m.allergies_none ? 'None (reviewed)' : 'None reported'])])]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Conditions']),
      el('div', { class: 'chip-row' }, condPills.length ? condPills : [el('span', { class: 'muted' }, [m.conditions_none ? 'None (reviewed)' : 'None reported'])])]),
    (m.medications || []).length ? el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Current medications']),
      el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table data-table--mini' }, [
        el('thead', {}, [el('tr', {}, ['Medication', 'Dose', 'Reason'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, m.medications.map((x) => el('tr', {}, [el('td', {}, [x.name]), el('td', {}, [x.dose || '—']), el('td', {}, [x.reason || '—'])]))),
      ])]),
    ]) : null,
  ));

  out.push(card('tooth', 'Dental history',
    el('div', { class: 'kv-grid' }, [
      kv('What patient needs', visitTypeLabel(dh.visit_type)), kv('Reason for visit', (p.triage && p.triage.complaint) || dh.reason),
      kv('Prior dentist', dh.prior_dentist), kv('Gums bleed', dh.gum_bleeding),
      kv('Sores / lumps', dh.sores), kv('Head/neck/jaw injury', dh.jaw_injury),
      kv('Clenching / grinding', dh.grinding), kv('Bleeding after extraction', dh.post_extraction_bleeding),
      kv('Orthodontic history', dh.ortho),
    ])));

  if ((p.consents || []).length) {
    out.push(card('pen', 'Consents & signatures',
      el('div', { class: 'consent-grid' }, p.consents.map((c) => el('div', { class: 'consent-card' }, [
        el('div', { class: 'consent-card-title' }, [c.type === 'oral_surgery' ? 'Oral Surgery Consent' : 'General Consent']),
        el('div', { class: 'muted' }, [`${c.signer_name}${c.relationship ? ' (' + c.relationship + ')' : ''}`]),
        el('div', { class: 'muted small' }, [`${c.version} · ${new Date(c.signed_at).toLocaleString()}`]),
        c.signature_png ? el('img', { class: 'sig-thumb', src: c.signature_png }) : null,
      ])))));
  }

  if (priorVisits && priorVisits.length) {
    out.push(card('calendar', `Previous visits (${priorVisits.length})`,
      el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table data-table--mini' }, [
        el('thead', {}, [el('tr', {}, ['Date', 'Event', 'Treatment', 'Status'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, priorVisits.map((v) => el('tr', {}, [
          el('td', {}, [new Date(v.created_at).toLocaleDateString()]),
          el('td', {}, [v.event_name]),
          el('td', {}, [v.summary]),
          el('td', {}, [v.status]),
        ]))),
      ])])));
  }

  return out;
}

// Collapsible wrapper around patientHistoryCards. Keeps dense clinical screens
// tidy — the full intake history stays one click away instead of always open.
// Pass { open:true } to expand by default.
export function patientHistoryPanel(p, priorVisits = [], { open = false, title = 'Patient health history' } = {}) {
  const cards = patientHistoryCards(p, priorVisits);
  const body = el('div', { class: 'collapse-body' }, [el('div', { class: 'history-grid' }, cards)]);
  const state = el('span', { class: 'subtle small' }, [open ? 'Hide' : 'Show']);
  const summary = el('summary', {}, [
    el('span', { style: 'display:flex;align-items:center;gap:9px' }, [icon('records', { size: 16 }), title]),
    state,
  ]);
  const details = el('details', { class: 'collapse' }, [summary, body]);
  if (open) details.setAttribute('open', '');
  details.addEventListener('toggle', () => { state.textContent = details.open ? 'Hide' : 'Show'; });
  return details;
}
