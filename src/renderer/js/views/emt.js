import { el, clear, toast, modal } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { patientHistoryPanel } from '../components/patientHistory.js';
import { bloodThinnerStatus } from '../medFlags.js';
import { statusPill } from './dashboard.js';

// EMT / Nurse view (F11): open a patient's medical history and record vitals.
export function renderEmt(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    const patients = await api.listPatients({});
    const rows = patients.map((p) => el('tr', {
      style: 'cursor:pointer',
      onClick: () => detail(p.id),
    }, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        (p.flags && p.flags.length) ? el('span', { class: 'flag-dot' }, [icon('flag', { size: 13 }), String(p.flags.length)]) : null]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [el('button', {
        class: 'btn btn--primary btn--sm',
        onClick: (e) => { e.stopPropagation(); detail(p.id); },
      }, ['Vitals', icon('chevron', { size: 15 })])]),
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
    const flag = bloodThinnerStatus(p);

    const sys = el('input', { class: 'input', type: 'number', min: '0', max: '300', placeholder: t('intake.bpSys'), value: tr.bp_systolic != null ? tr.bp_systolic : (m.bp_systolic || '') });
    const dia = el('input', { class: 'input', type: 'number', min: '0', max: '200', placeholder: t('intake.bpDia'), value: tr.bp_diastolic != null ? tr.bp_diastolic : (m.bp_diastolic || '') });
    const hr = el('input', { class: 'input', type: 'number', min: '0', max: '300', placeholder: t('intake.hr'), value: tr.heart_rate != null ? tr.heart_rate : (m.heart_rate || '') });

    // Current vitals to carry through to the blood-thinner save (avoids clobbering).
    function currentVitals() {
      return { bp_systolic: sys.value.trim(), bp_diastolic: dia.value.trim(), heart_rate: hr.value.trim() };
    }

    // After vitals save, ask the patient about blood thinners, then persist the
    // answer in a second saveVitals call (blood_thinner key only when present).
    async function askBloodThinner() {
      const yes = await modal({
        title: 'Blood thinners?',
        body: 'Is the patient currently taking any blood thinners? (e.g. Eliquis, Warfarin, Plavix, aspirin)',
        confirmText: 'Yes',
        cancelText: 'No',
      });
      try {
        if (yes) {
          const askDetail = el('input', {
            class: 'input',
            type: 'text',
            placeholder: 'e.g. Eliquis, Warfarin, Plavix, aspirin',
            value: flag.confirmed === 'yes' ? (flag.names || []).join(', ') : '',
          });
          await modal({
            title: 'Which blood thinner(s)?',
            body: el('div', {}, [
              el('p', {}, ['Enter the medication name(s) the patient is taking.']),
              el('div', { style: 'display:flex;flex-direction:column;gap:var(--space-2);margin-top:var(--space-2)' }, [
                el('span', { class: 'field-label' }, ['Medication name(s)']),
                askDetail,
              ]),
            ]),
            confirmText: 'Save',
          });
          await api.saveVitals(id, {
            ...currentVitals(),
            blood_thinner: 'yes',
            blood_thinner_detail: askDetail.value.trim(),
          });
        } else {
          await api.saveVitals(id, { ...currentVitals(), blood_thinner: 'no' });
        }
        detail(id);
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    async function save() {
      try {
        await api.saveVitals(id, currentVitals());
        toast('Vitals recorded', 'success');
        await askBloodThinner();
      } catch (e) { toast(e.message, 'error'); }
    }

    // Human-readable summary of the currently recorded blood-thinner answer.
    function bloodThinnerAnswer() {
      if (flag.confirmed === 'yes') {
        return `Blood thinners: Yes${flag.names.length ? ' — ' + flag.names.join(', ') : ''}`;
      }
      if (flag.confirmed === 'no') return 'Blood thinners: No';
      return 'Blood thinners: Not asked';
    }

    const banner = flag.onThinner
      ? el('div', { class: 'banner banner--alert' }, [
          icon('alert', { size: 16 }),
          `BLOOD THINNER${flag.names.length ? ' — ' + flag.names.join(', ') : ''} — critical before any extraction`,
        ])
      : null;

    const lastRecorded = tr.vitals_at
      ? el('p', { class: 'subtle small' }, [`Last recorded by ${p.vitals_by_name || '—'} · ${new Date(tr.vitals_at).toLocaleString()}`])
      : null;

    clear(root);
    root.append(el('div', {}, [
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => queue() }, [icon('back', { size: 15 }), t('common.back')]),
          el('h1', {}, [`${p.first_name || ''} ${p.last_name || ''}`.trim() || '—']),
          el('p', { class: 'view-sub' }, [
            [p.age != null ? `${p.age} yrs` : null, p.gender || null].filter(Boolean).join(' · ') || '—',
          ]),
        ]),
        statusPill(p.status),
      ]),

      banner,

      patientHistoryPanel(p, [], { open: false }),

      el('div', { class: 'card', style: 'margin-top:var(--space-4)' }, [
        el('div', { class: 'card-title' }, [icon('syringe', { size: 15 }), t('intake.vitalsTitle')]),
        el('div', { class: 'vitals-grid' }, [
          el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('intake.bpSys')]), sys]),
          el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('intake.bpDia')]), dia]),
          el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('intake.hr')]), hr]),
        ]),
        lastRecorded,
        el('p', { class: 'subtle small' }, [bloodThinnerAnswer()]),
        el('button', { class: 'btn btn--primary btn--block', style: 'margin-top:var(--space-3)', onClick: save }, [icon('save', { size: 16 }), 'Save vitals']),
      ]),
    ]));
  }
}
