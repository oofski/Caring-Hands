import { el } from '../dom.js';
import { icon } from '../icons.js';
import { conditions, allergies } from '../i18n.js';

// Full patient history (demographics + medical + dental + consents + prior
// visits) rendered as a set of cards. Shared by Records, Provider, and Triage
// so clinicians always see the complete intake history.
export function patientHistoryCards(p, priorVisits = []) {
  const d = p.demographics || {};
  const m = p.medical_history || {};
  const dh = p.dental_history || {};
  const condLabels = conditions().filter((c) => (m.conditions || []).includes(c.key));
  const allergyLabels = allergies().filter((a) => (m.allergies || []).includes(a.key));

  const kv = (label, val) => el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, [label]), el('span', { class: 'kv-val' }, [val == null || val === '' ? '—' : String(val)])]);
  const card = (ic, title, ...kids) => el('div', { class: 'card' }, [el('div', { class: 'card-title' }, [icon(ic, { size: 15 }), title]), ...kids]);

  const out = [];

  out.push(card('user', 'Patient information',
    el('div', { class: 'kv-grid' }, [
      kv('Date of birth', p.dob), kv('Age', p.age != null ? p.age : '—'),
      kv('Gender', p.gender), kv('Marital status', d.marital_status),
      kv('Phone', p.phone), kv('Email', p.email),
      kv('Address', d.address), kv('Mailing address', d.mailing_address),
      kv('Children', (d.children || []).join(', ')), kv('Referral', d.referral),
      kv('Emergency contact', d.emergency_name), kv('Emergency phone', d.emergency_phone),
    ])));

  out.push(card('clipboard', 'Medical history',
    el('div', { class: 'kv-grid' }, [
      kv('Under doctor’s care', m.under_treatment), kv('Hospitalized (2 yrs)', m.hospitalized),
      kv('Tobacco use', m.tobacco), kv('Pregnant / nursing', m.pregnancy),
    ]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Allergies']),
      el('div', { class: 'chip-row' }, allergyLabels.length ? allergyLabels.map((a) => el('span', { class: 'pill pill--danger' }, [el('span', { class: 'pill-dot' }), a.label])) : [el('span', { class: 'muted' }, ['None reported'])])]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Conditions']),
      el('div', { class: 'chip-row' }, condLabels.length ? condLabels.map((c) => el('span', { class: `pill ${c.flag ? 'pill--danger' : 'pill--info'}` }, [c.flag ? el('span', { class: 'pill-dot' }) : null, c.label])) : [el('span', { class: 'muted' }, ['None reported'])])]),
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
      kv('Reason for visit', dh.reason), kv('Long-term goals', dh.goals),
      kv('Prior dentist', dh.prior_dentist), kv('Gums bleed', dh.gum_bleeding),
      kv('Sores / lumps', dh.sores), kv('Head/neck/jaw injury', dh.jaw_injury),
      kv('Clenching / grinding', dh.grinding), kv('Bleeding after extraction', dh.post_extraction_bleeding),
      kv('Orthodontic history', dh.ortho), kv('Cosmetic interest', dh.cosmetic),
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
