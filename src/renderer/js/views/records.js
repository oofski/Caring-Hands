import { el, clear, toast, modal } from '../dom.js';
import { t, conditions, allergies } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { statusPill } from './dashboard.js';
import { exportButtons } from './provider.js';

export function renderRecords(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else list();
  return root;

  async function list() {
    const searchInput = el('input', { class: 'input search-input', placeholder: 'Search current event by name, DOB, phone…' });
    const allInput = el('input', { class: 'input search-input', placeholder: 'Returning patient lookup (all events)…' });
    const tbody = el('tbody', {});

    async function refresh() {
      const patients = await api.listPatients({ search: searchInput.value.trim() });
      clear(tbody);
      if (!patients.length) tbody.append(el('tr', {}, [el('td', { colspan: 6, class: 'empty' }, ['No matching records.'])]));
      patients.forEach((p) => tbody.append(el('tr', {}, [
        el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`])]),
        el('td', {}, [p.dob || '—']),
        el('td', {}, [p.age != null ? String(p.age) : '—']),
        el('td', {}, [p.complaint || '—']),
        el('td', {}, [statusPill(p.status)]),
        el('td', {}, [el('button', { class: 'btn btn--ghost btn--sm', onClick: () => detail(p.id) }, ['Open'])]),
      ])));
    }
    searchInput.addEventListener('input', debounce(refresh, 200));

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
      el('div', { class: 'view-head' }, [el('div', {}, [el('h1', {}, [t('nav.records')]), el('p', { class: 'view-sub' }, ['Patient records for the active event'])])]),
      el('div', { class: 'card' }, [
        el('div', { class: 'lookup-row' }, [
          el('div', {}, [el('span', { class: 'field-label' }, ['Search this event']), searchInput]),
          el('div', {}, [el('span', { class: 'field-label' }, ['Returning patient (all events)']), allInput, allResults]),
        ]),
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Patient', 'DOB', 'Age', 'Complaint', 'Status', ''].map((h) => el('th', {}, [h])))]),
          tbody,
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
      el('div', { class: 'split' }, [
        el('div', { class: 'col col--wide' }, [
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Patient information']),
            el('div', { class: 'kv-grid' }, [
              kv('Date of birth', p.dob), kv('Age', p.age != null ? String(p.age) : '—'),
              kv('Gender', p.gender), kv('Phone', p.phone), kv('Email', p.email),
              kv('Address', p.demographics.address), kv('Emergency', p.demographics.emergency_name),
              kv('Emergency phone', p.demographics.emergency_phone), kv('Referral', p.demographics.referral),
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
              kv('Grinding', p.dental_history.grinding), kv('Ortho', p.dental_history.ortho),
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
        ]),
      ]),
    );
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
