import { el, clear, toast, modal } from '../dom.js';
import { t, conditions, allergies } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { statusPill } from './dashboard.js';
import { exportButtons } from './provider.js';
import { incompleteBanner } from '../components/patientHistory.js';

export function renderRecords(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else list();
  return root;

  async function list() {
    const events = await api.listEvents();
    const searchInput = el('input', { class: 'input search-input', placeholder: 'Search by name, DOB, phone…' });
    const allInput = el('input', { class: 'input search-input', placeholder: 'Returning patient lookup (all events)…' });
    // Default to ALL events so records are always visible regardless of which
    // event is currently active.
    const eventSel = el('select', { class: 'input select' });
    eventSel.append(el('option', { value: 'all' }, ['All events']));
    events.forEach((e) => eventSel.append(el('option', { value: String(e.id) }, [`${e.name} (${e.patient_count})`])));
    const tbody = el('tbody', {});

    async function refresh() {
      const eventId = eventSel.value === 'all' ? 'all' : Number(eventSel.value);
      const patients = await api.listPatients({ eventId, search: searchInput.value.trim() });
      clear(tbody);
      if (!patients.length) tbody.append(el('tr', {}, [el('td', { colspan: 6, class: 'empty' }, ['No matching records.'])]));
      patients.forEach((p) => tbody.append(el('tr', {}, [
        el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`])]),
        el('td', {}, [p.dob || '—']),
        el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
        el('td', { class: 'subtle small' }, [p.event_name || '—']),
        el('td', {}, [statusPill(p.status)]),
        el('td', {}, [el('button', { class: 'btn btn--ghost btn--sm', onClick: () => detail(p.id) }, ['Open'])]),
      ])));
    }
    searchInput.addEventListener('input', debounce(refresh, 200));
    eventSel.addEventListener('change', refresh);

    const allResults = el('div', { class: 'lookup-results' });
    allInput.addEventListener('input', debounce(async () => {
      const term = allInput.value.trim();
      clear(allResults);
      if (term.length < 2) return;
      const res = await api.searchAll(term);
      if (!res.length) { allResults.append(el('div', { class: 'muted' }, ['No prior records found.'])); return; }
      res.forEach((r) => allResults.append(el('button', { class: 'lookup-item', onClick: () => detail(r.id) }, [
        el('strong', {}, [`${r.last_name}, ${r.first_name}`]),
        el('span', { class: 'muted' }, [` ${r.dob || ''} · ${r.event_name}`]),
      ])));
    }, 250));

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [el('div', {}, [el('h1', {}, [t('nav.records')]), el('p', { class: 'view-sub' }, ['All patient records across events'])])]),
      el('div', { class: 'card' }, [
        el('div', { class: 'lookup-row' }, [
          el('div', {}, [el('span', { class: 'field-label' }, ['Event']), eventSel]),
          el('div', {}, [el('span', { class: 'field-label' }, ['Search']), searchInput]),
        ]),
        el('div', { style: 'margin-bottom:12px' }, [el('span', { class: 'field-label' }, ['Returning patient lookup (all events)']), allInput, allResults]),
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Patient', 'DOB', 'Age', 'Event', 'Status', ''].map((h) => el('th', {}, [h])))]),
            tbody,
          ]),
        ]),
      ]),
    );
    refresh();
  }

  async function detail(id) {
    const p = await api.getPatient(id);
    const condLabels = conditions().filter((c) => (p.medical_history.conditions || []).includes(c.key)).map((c) => ({ label: c.label, flag: c.flag }));
    const allergyLabels = allergies().filter((a) => (p.medical_history.allergies || []).includes(a.key)).map((a) => a.label);

    const kv = (label, val) => el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, [label]), el('span', { class: 'kv-val' }, [val || '—'])]);

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => ctx.navigate('records') }, [icon('back', { size: 15 }), t('common.back')]),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [`${p.event ? p.event.name : ''} · ${p.language === 'es' ? 'Español' : 'English'}`]),
        ]),
        statusPill(p.status),
      ]),
      incompleteBanner(p, {
        isAdmin: store.is('admin'),
        onDelete: () => deletePatient(p),
        onNewCheckin: () => ctx.navigate('kiosk'),
      }),
      el('div', { class: 'split' }, [
        el('div', { class: 'col col--wide' }, [
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Patient information']),
            el('div', { class: 'kv-grid' }, [
              kv('Date of birth', p.dob), kv('Age', p.age != null ? String(p.age) : '—'),
              kv('Gender', p.gender), kv('Marital status', p.demographics.marital_status),
              kv('Phone', p.phone), kv('Email', p.email),
              kv('Address', p.demographics.address), kv('Mailing address', p.demographics.mailing_address),
              kv('Children', (p.demographics.children || []).join(', ')), kv('Referral', p.demographics.referral),
              kv('Emergency contact', p.demographics.emergency_name), kv('Emergency phone', p.demographics.emergency_phone),
            ]),
          ]),
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Medical history']),
            el('div', { class: 'kv-grid' }, [
              kv('Under care', p.medical_history.under_treatment), kv('Hospitalized', p.medical_history.hospitalized),
              kv('Tobacco', p.medical_history.tobacco), kv('Pregnancy', p.medical_history.pregnancy),
            ]),
            el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Allergies']),
              el('div', { class: 'chip-row' }, allergyLabels.length ? allergyLabels.map((a) => el('span', { class: 'pill pill--red' }, [a])) : [el('span', { class: 'muted' }, ['None'])])]),
            el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Conditions']),
              el('div', { class: 'chip-row' }, condLabels.length ? condLabels.map((c) => el('span', { class: `pill ${c.flag ? 'pill--red' : 'pill--blue'}` }, [c.label])) : [el('span', { class: 'muted' }, ['None'])])]),
            (p.medical_history.medications || []).length ? el('div', { class: 'field' }, [
              el('span', { class: 'field-label' }, ['Medications']),
              el('table', { class: 'data-table data-table--mini' }, [
                el('thead', {}, [el('tr', {}, ['Medication', 'Dose', 'Reason'].map((h) => el('th', {}, [h])))]),
                el('tbody', {}, p.medical_history.medications.map((m) => el('tr', {}, [el('td', {}, [m.name]), el('td', {}, [m.dose || '—']), el('td', {}, [m.reason || '—'])]))),
              ]),
            ]) : null,
          ]),
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Dental history']),
            el('div', { class: 'kv-grid' }, [
              kv('Reason', p.dental_history.reason), kv('Goals', p.dental_history.goals),
              kv('Prior dentist', p.dental_history.prior_dentist), kv('Gums bleed', p.dental_history.gum_bleeding),
              kv('Sores / lumps', p.dental_history.sores), kv('Head/neck/jaw injury', p.dental_history.jaw_injury),
              kv('Grinding / clenching', p.dental_history.grinding), kv('Bleeding after extraction', p.dental_history.post_extraction_bleeding),
              kv('Orthodontic history', p.dental_history.ortho), kv('Cosmetic interest', p.dental_history.cosmetic),
            ]),
          ]),
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Consents & signatures']),
            (p.consents || []).length ? el('div', { class: 'consent-grid' }, p.consents.map((c) => el('div', { class: 'consent-card' }, [
              el('div', { class: 'consent-card-title' }, [c.type === 'oral_surgery' ? 'Oral Surgery Consent' : 'General Consent']),
              el('div', { class: 'muted' }, [`${c.signer_name}${c.relationship ? ' (' + c.relationship + ')' : ''}`]),
              el('div', { class: 'muted small' }, [`${c.version} · ${new Date(c.signed_at).toLocaleString()}`]),
              c.signature_png ? el('img', { class: 'sig-thumb', src: c.signature_png }) : null,
            ]))) : el('span', { class: 'muted' }, ['No consents on file']),
          ]),
        ]),
        el('div', { class: 'col' }, [
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Export & deliver']),
            exportButtons(ctx, id),
            el('button', { class: 'btn btn--ghost btn--block', style: 'margin-top:8px', onClick: () => preview(id) }, [icon('eye', { size: 16 }), 'Preview PDF']),
            el('button', { class: 'btn btn--ghost btn--block', onClick: () => screenDisplay(p) }, [icon('phone', { size: 16 }), 'Screen display for photo']),
            p.email ? el('button', { class: 'btn btn--ghost btn--block', onClick: () => emailRecord(p) }, [icon('mail', { size: 16 }), 'Email to patient']) : null,
          ]),
          store.is('admin') ? el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Admin']),
            el('button', { class: 'btn btn--ghost btn--block', onClick: () => editPatient(p) }, [icon('pen', { size: 16 }), 'Edit patient details']),
            el('button', { class: 'btn btn--danger btn--block', style: 'margin-top:8px', onClick: () => deletePatient(p) }, [icon('trash', { size: 16 }), 'Delete patient record']),
          ]) : null,
        ]),
      ]),
    );
  }

  async function editPatient(p) {
    const d = p.demographics || {};
    const f = {
      first_name: el('input', { class: 'input', value: p.first_name || '' }),
      last_name: el('input', { class: 'input', value: p.last_name || '' }),
      dob: el('input', { class: 'input', type: 'date', value: p.dob || '' }),
      phone: el('input', { class: 'input', value: p.phone || '' }),
      email: el('input', { class: 'input', value: p.email || '' }),
      address: el('input', { class: 'input', value: d.address || '' }),
      emergency_name: el('input', { class: 'input', value: d.emergency_name || '' }),
      emergency_phone: el('input', { class: 'input', value: d.emergency_phone || '' }),
    };
    const fld = (label, node, span) => el('label', { class: 'field' + (span ? ' span-2' : '') }, [el('span', { class: 'field-label' }, [label]), node]);
    const form = el('div', { class: 'form-grid' }, [
      fld('First name', f.first_name), fld('Last name', f.last_name),
      fld('Date of birth', f.dob), fld('Phone', f.phone),
      fld('Email', f.email, true),
      fld('Address', f.address, true),
      fld('Emergency contact', f.emergency_name), fld('Emergency phone', f.emergency_phone),
    ]);
    const ok = await modal({ title: 'Edit patient details', body: form, confirmText: 'Save', cancelText: 'Cancel' });
    if (!ok) return;
    try {
      await api.updatePatient({
        id: p.id,
        first_name: f.first_name.value.trim(), last_name: f.last_name.value.trim(),
        dob: f.dob.value, phone: f.phone.value.trim(), email: f.email.value.trim(),
        demographics: { ...d, address: f.address.value.trim(), emergency_name: f.emergency_name.value.trim(), emergency_phone: f.emergency_phone.value.trim() },
      });
      toast('Patient details updated', 'success');
      detail(p.id);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deletePatient(p) {
    const ok = await modal({
      title: 'Delete patient record?',
      body: `This permanently deletes <b>${p.first_name} ${p.last_name}</b> and all of their intake, triage, treatment, x-rays, and consents. This cannot be undone.`,
      confirmText: 'Delete permanently', cancelText: 'Cancel', danger: true,
    });
    if (!ok) return;
    try { await api.deletePatient(p.id); toast('Patient record deleted', 'success'); ctx.navigate('records'); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function preview(id) {
    try {
      const dataUrl = await api.pdfPreview(id, 'full');
      const frame = el('iframe', { class: 'pdf-frame', src: dataUrl });
      await modal({ title: 'Record preview', body: frame, confirmText: t('common.close') });
    } catch (e) { toast(e.message, 'error'); }
  }

  function screenDisplay(p) {
    const big = el('div', { class: 'screen-display' }, [
      el('div', { class: 'sd-name' }, [`${p.first_name} ${p.last_name}`]),
      el('div', { class: 'sd-row' }, [el('span', {}, ['DOB']), el('b', {}, [p.dob || '—'])]),
      el('div', { class: 'sd-row' }, [el('span', {}, ['Event']), el('b', {}, [p.event ? p.event.name : '—'])]),
      el('div', { class: 'sd-row' }, [el('span', {}, ['Treatment']), el('b', {}, [treatmentSummary(p)])]),
      el('div', { class: 'sd-row' }, [el('span', {}, ['Emergency']), el('b', {}, ['541-556-5902'])]),
      el('div', { class: 'sd-hint' }, ['Take a photo of this screen with your phone']),
    ]);
    modal({ title: '', body: big, confirmText: t('common.close') });
  }

  async function emailRecord(p) {
    const ok = await modal({
      title: 'Email record', cancelText: 'Cancel', confirmText: 'Open email',
      body: `This will save a PDF and open your email program addressed to <b>${p.email}</b>. Attach the saved PDF before sending. (Email requires brief internet access.)`,
    });
    if (!ok) return;
    try {
      const r = await api.pdfGenerate(p.id, 'full');
      if (r.saved) {
        await api.openExternal(`mailto:${p.email}?subject=${encodeURIComponent('Your Caring Hands dental record')}&body=${encodeURIComponent('Your dental record from Caring Hands Worldwide is attached.')}`);
        toast('PDF saved — attach it in your email program.', 'success');
      }
    } catch (e) { toast(e.message, 'error'); }
  }
}

function treatmentSummary(p) {
  const tx = p.treatment || {};
  const parts = [];
  if ((tx.fillings || []).length) parts.push(`${tx.fillings.length} filling(s)`);
  if ((tx.extractions || []).length) parts.push(`${tx.extractions.length} extraction(s)`);
  if (Object.values(tx.cleaning || {}).some(Boolean)) parts.push('cleaning');
  return parts.join(', ') || 'See provider';
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
