import { el, clear, toast } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { patientHistoryCards } from '../components/patientHistory.js';
import { bloodThinnerFlags } from '../medFlags.js';
import { statusPill } from './dashboard.js';

// EMT / Nurse view (F11): open a patient's medical history and record vitals.
export function renderEmt(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    const patients = await api.listPatients({});
    const rows = patients.map((p) => el('tr', {}, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        (p.flags && p.flags.length) ? el('span', { class: 'flag-dot' }, [icon('flag', { size: 13 }), String(p.flags.length)]) : null]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [el('button', { class: 'btn btn--primary btn--sm', onClick: () => detail(p.id) }, ['Vitals', icon('chevron', { size: 15 })])]),
    ]));
    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, ['Vitals — EMT / Nurse']), el('p', { class: 'view-sub' }, [`${patients.length} patient(s)`])]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: queue }, [icon('refresh', { size: 15 }), 'Refresh']),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Status', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 5, class: 'empty' }, ['No patients.'])])]),
          ]),
        ]),
      ]),
    );
  }

  async function detail(id) {
    const p = await api.getPatient(id);
    const tr = p.triage || {};
    const m = p.medical_history || {};
    const thinners = bloodThinnerFlags(m);

    const sys = el('input', { class: 'input', type: 'number', min: '0', max: '300', placeholder: t('intake.bpSys'), value: tr.bp_systolic != null ? tr.bp_systolic : (m.bp_systolic || '') });
    const dia = el('input', { class: 'input', type: 'number', min: '0', max: '200', placeholder: t('intake.bpDia'), value: tr.bp_diastolic != null ? tr.bp_diastolic : (m.bp_diastolic || '') });
    const hr = el('input', { class: 'input', type: 'number', min: '0', max: '300', placeholder: t('intake.hr'), value: tr.heart_rate != null ? tr.heart_rate : (m.heart_rate || '') });

    async function save() {
      try {
        await api.saveVitals(id, { bp_systolic: sys.value.trim(), bp_diastolic: dia.value.trim(), heart_rate: hr.value.trim() });
        toast('Vitals recorded', 'success');
        detail(id);
      } catch (e) { toast(e.message, 'error'); }
    }

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => queue() }, [icon('back', { size: 15 }), t('common.back')]),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [`${p.age != null ? p.age + ' yrs · ' : ''}${p.gender || ''}`]),
        ]),
        statusPill(p.status),
      ]),

      thinners.length ? el('div', { class: 'banner banner--alert' }, [icon('alert', { size: 16 }), 'BLOOD THINNER — ' + thinners.map((f) => f.replace('Blood thinner: ', '')).join(', ') + ' (critical before any extraction)']) : null,

      el('div', { class: 'split' }, [
        el('div', { class: 'col' }, [
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('syringe', { size: 15 }), t('intake.vitalsTitle')]),
            el('div', { class: 'vitals-grid' }, [
              el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('intake.bpSys')]), sys]),
              el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('intake.bpDia')]), dia]),
              el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('intake.hr')]), hr]),
            ]),
            (tr.vitals_at) ? el('p', { class: 'subtle small' }, [`Last recorded by ${p.vitals_by_name || '—'} · ${new Date(tr.vitals_at).toLocaleString()}`]) : null,
            el('button', { class: 'btn btn--primary btn--block', style: 'margin-top:10px', onClick: save }, [icon('save', { size: 16 }), 'Save vitals']),
          ]),
        ]),
        el('div', { class: 'col col--wide' }, [
          el('div', { class: 'history-grid' }, patientHistoryCards(p, [])),
        ]),
      ]),
    );
  }
}
