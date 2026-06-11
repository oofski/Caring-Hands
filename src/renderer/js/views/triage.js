import { el, clear, toast } from '../dom.js';
import { t, conditions, allergies } from '../i18n.js';
import { api } from '../api.js';
import { ToothChart } from '../components/toothchart.js';
import { statusPill } from './dashboard.js';

export function renderTriage(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    const patients = await api.listPatients({});
    const waiting = patients.filter((p) => p.triage_status === 'waiting' || p.status === 'checked_in');
    const rows = patients.map((p) => el('tr', { class: p.status === 'checked_in' ? 'row--active' : '' }, [
      el('td', {}, [
        el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        (p.flags && p.flags.length) ? el('span', { class: 'flag-dot' }, ['⚑ ' + p.flags.length]) : null,
      ]),
      el('td', {}, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [el('button', { class: 'btn btn--primary btn--sm', onClick: () => detail(p.id) }, ['Triage →'])]),
    ]));

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, [t('nav.triage')]), el('p', { class: 'view-sub' }, [`${waiting.length} patient(s) awaiting triage`])]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: queue }, ['↻ Refresh']),
      ]),
      el('div', { class: 'card' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Status', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 5, class: 'empty' }, ['Queue is empty.'])])]),
        ]),
      ]),
    );
  }

  async function detail(id) {
    const p = await api.getPatient(id);
    const tr = p.triage || {};

    // Auto medical flags
    const flagConds = conditions().filter((c) => c.flag && (p.medical_history.conditions || []).includes(c.key)).map((c) => c.label);
    const flagAllergies = allergies().filter((a) => (p.medical_history.allergies || []).includes(a.key)).map((a) => a.label);
    if (p.medical_history.pregnancy === 'yes') flagConds.push('Pregnant');
    const flags = [...flagConds, ...flagAllergies.map((a) => `Allergy: ${a}`)];

    const consentOk = (p.consents || []).some((c) => c.type === 'general');

    // Triage checklist
    const checklistItems = [
      ['cleaning', 'Cleaning'], ['extraction', 'Extraction'], ['filling', 'Filling'],
      ['none', 'No treatment'], ['referral', 'Referral'],
    ];
    const checkState = { ...(tr.checklist || {}) };
    const checklist = el('div', { class: 'chip-row' }, checklistItems.map(([k, label]) =>
      el('button', {
        type: 'button', class: 'chip-btn' + (checkState[k] ? ' chip-btn--on' : ''),
        onClick: (e) => { checkState[k] = !checkState[k]; e.currentTarget.classList.toggle('chip-btn--on'); },
      }, [label])
    ));

    const complaint = el('input', { class: 'input', value: tr.complaint || p.dental_history.reason || '', placeholder: 'Primary complaint' });
    const notes = el('textarea', { class: 'input textarea', rows: 3, placeholder: 'Triage notes' }, [tr.notes || '']);
    const station = el('input', { class: 'input', value: tr.xray_station || '', placeholder: 'X-ray station #' });
    const assigned = el('input', { class: 'input', value: tr.assigned_to || '', placeholder: 'Assign to provider / chair' });

    const chart = ToothChart({ selected: tr.teeth || [] });

    // X-ray upload
    const xrayList = el('div', { class: 'xray-strip' });
    function refreshXrays() {
      clear(xrayList);
      (p.xrays || []).forEach((x) => xrayList.append(el('div', { class: 'xray-thumb' }, [
        el('span', { class: 'xray-icon', html: '&#127909;' }), el('small', {}, [x.station ? `St. ${x.station}` : 'X-ray']),
      ])));
      if (!(p.xrays || []).length) xrayList.append(el('span', { class: 'muted' }, ['No x-rays uploaded']));
    }
    refreshXrays();
    const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await api.addXray({ patientId: id, station: station.value.trim(), image_png: reader.result, note: '' });
          const fresh = await api.getPatient(id); p.xrays = fresh.xrays; refreshXrays();
          toast('X-ray uploaded', 'success');
        } catch (e) { toast(e.message, 'error'); }
      };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });

    async function save(markReady) {
      try {
        await api.saveTriage(id, {
          complaint: complaint.value.trim(), flags, checklist: checkState, teeth: chart.get(),
          notes: notes.value.trim(), xray_count: (p.xrays || []).length, xray_station: station.value.trim(),
          assigned_to: assigned.value.trim(), status: markReady ? 'ready' : 'in_progress',
        });
        toast(markReady ? 'Triage complete — routed to provider' : 'Triage saved', 'success');
        if (markReady) ctx.navigate('triage');
      } catch (e) { toast(e.message, 'error'); }
    }

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => ctx.navigate('triage') }, ['← ' + t('common.back')]),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [`${p.age != null ? p.age + ' yrs · ' : ''}${p.gender || ''} · ${p.language === 'es' ? 'Español' : 'English'}`]),
        ]),
        statusPill(p.status),
      ]),

      el('div', { class: 'split' }, [
        // Left: clinical context
        el('div', { class: 'col' }, [
          el('div', { class: `card ${flags.length ? 'card--alert' : ''}` }, [
            el('h3', { class: 'card-title' }, ['⚑ Medical flags']),
            flags.length
              ? el('div', { class: 'chip-row' }, flags.map((f) => el('span', { class: 'pill pill--red' }, [f])))
              : el('p', { class: 'muted' }, ['No medical flags reported.']),
          ]),
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Consent status']),
            consentOk
              ? el('span', { class: 'pill pill--green' }, ['✔ Consents signed'])
              : el('span', { class: 'pill pill--amber' }, ['⚠ Consent missing']),
            el('div', { class: 'mini-hist' }, [
              el('div', {}, [el('b', {}, ['Reason: ']), p.dental_history.reason || '—']),
              el('div', {}, [el('b', {}, ['Tobacco: ']), p.medical_history.tobacco || '—']),
              el('div', {}, [el('b', {}, ['Under care: ']), p.medical_history.under_treatment || '—']),
            ]),
          ]),
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['X-rays']),
            xrayList,
            el('div', { class: 'inline-row' }, [station,
              el('button', { class: 'btn btn--ghost btn--sm', onClick: () => fileInput.click() }, ['＋ Upload x-ray (Nomad)']), fileInput]),
          ]),
        ]),

        // Right: triage actions
        el('div', { class: 'col col--wide' }, [
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Triage assessment']),
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Primary complaint']), complaint]),
            el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Treatment needed (mirrors paper form)']), checklist]),
            el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Teeth of concern']), chart.node]),
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Triage notes']), notes]),
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Route to provider / chair']), assigned]),
            el('div', { class: 'action-row' }, [
              el('button', { class: 'btn btn--ghost', onClick: () => save(false) }, ['Save draft']),
              el('button', { class: 'btn btn--success', onClick: () => save(true) }, ['Complete triage → Provider']),
            ]),
          ]),
        ]),
      ]),
    );
  }
}
