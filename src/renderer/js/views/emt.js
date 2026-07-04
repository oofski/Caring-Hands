import { el, clear, toast, modal } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { patientHistoryPanel } from '../components/patientHistory.js';
import { bloodThinnerStatus } from '../medFlags.js';
import { statusPill } from './dashboard.js';

// Route metadata shared by the queue pills, the next-step card and the toasts.
const ROUTES = {
  dentist: {
    label: 'Dentist',
    choice: 'Dentist (fillings / extractions)',
    pill: 'pill--info',
    ic: 'tooth',
    toast: 'Sent to the dentist queue',
  },
  hygienist: {
    label: 'Hygienist',
    choice: 'Hygienist (cleaning)',
    pill: 'pill--purple',
    ic: 'sparkle',
    toast: 'Sent to the hygienist queue',
  },
  both: {
    label: 'Dentist + Hygienist',
    choice: 'Both — dentist + hygienist',
    pill: 'pill--warning',
    ic: 'checkCircle',
    toast: 'Sent to the dentist and hygienist queues',
  },
};

function routePill(route, prefix = '') {
  const r = ROUTES[route];
  if (!r) return el('span', { class: 'subtle small' }, ['—']);
  return el('span', { class: `pill ${r.pill}` }, [el('span', { class: 'pill-dot' }), `${prefix}${r.label}`]);
}

function fmtWhen(w) {
  if (!w) return '';
  const d = new Date(w);
  return isNaN(d.getTime()) ? String(w) : d.toLocaleString();
}

// EMT / Nurse view (F11): record vitals, confirm blood thinners, then route
// each patient to the dentist and/or hygienist queue (replaces triage routing).
export function renderEmt(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    const patients = await api.listPatients({});
    const live = patients.filter((p) => p.status !== 'dismissed');
    // Work order: needs vitals first, then vitals done but un-routed, then the rest.
    const rank = (p) => {
      if (p.status === 'checked_in' && !p.has_vitals) return 0;
      if (p.has_vitals && !p.route) return 1;
      return 2;
    };
    live.sort((a, b) => rank(a) - rank(b));
    const rows = live.map((p) => el('tr', {
      style: 'cursor:pointer',
      onClick: () => detail(p.id),
    }, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        (p.flags && p.flags.length) ? el('span', { class: 'flag-dot' }, [icon('flag', { size: 13 }), String(p.flags.length)]) : null]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [p.has_vitals
        ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Vitals done'])
        : el('span', { class: 'subtle small' }, ['Needs vitals'])]),
      el('td', {}, [routePill(p.route)]),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [el('button', {
        class: 'btn btn--primary btn--sm',
        onClick: (e) => { e.stopPropagation(); detail(p.id); },
      }, ['Open', icon('chevron', { size: 15 })])]),
    ]));
    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('h1', {}, ['Vitals & Routing']),
          el('p', { class: 'view-sub' }, [
            `Station 2 — record vitals, then send each patient to the dentist or hygienist · ${live.length} patient(s)`,
          ]),
        ]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: queue }, [icon('refresh', { size: 15 }), 'Refresh']),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Vitals', 'Next', 'Status', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 7, class: 'empty' }, ['No patients.'])])]),
          ]),
        ]),
      ]),
    );
  }

  // Persist a routing choice, toast the destination, then re-render the detail.
  async function doRoute(id, route) {
    try {
      await api.routePatient(id, route);
      toast(ROUTES[route].toast, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    detail(id);
  }

  // Routing prompt — a modal whose body buttons pick the destination; the
  // modal's own confirm button doubles as "Decide later" (just re-renders).
  async function chooseRoute(id) {
    let picked = null;
    const pickBtn = (route) => el('button', {
      class: 'btn btn--primary btn--block',
      onClick: (e) => {
        picked = route;
        // Resolve the modal promise via its own confirm button.
        const overlay = e.currentTarget.closest('.modal-overlay');
        const closeBtn = overlay ? overlay.querySelector('.modal-actions button:last-child') : null;
        if (closeBtn) closeBtn.click();
      },
    }, [icon(ROUTES[route].ic, { size: 16 }), ROUTES[route].choice]);
    await modal({
      title: 'Where does this patient go next?',
      body: el('div', { style: 'display:flex;flex-direction:column;gap:var(--space-2)' }, [
        pickBtn('dentist'),
        pickBtn('hygienist'),
        pickBtn('both'),
      ]),
      confirmText: 'Decide later',
    });
    if (picked) await doRoute(id, picked);
    else detail(id);
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

    // After vitals save, ask the patient about blood thinners, persist the
    // answer, then proceed to the routing prompt (which re-renders).
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
      } catch (e) {
        toast(e.message, 'error');
        return;
      }
      await chooseRoute(id);
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

    // Next-step card — always visible; routing works without re-entering vitals.
    const inlineRouteBtn = (route) => el('button', {
      class: 'btn btn--primary btn--sm',
      onClick: () => doRoute(id, route),
    }, [icon(ROUTES[route].ic, { size: 15 }), ROUTES[route].choice]);

    const nextStep = el('div', { class: 'card', style: 'margin-top:var(--space-4)' }, [
      el('div', { class: 'card-title' }, [icon('checkCircle', { size: 15 }), 'Next step']),
      tr.route && ROUTES[tr.route]
        ? el('div', {}, [
            el('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap' }, [
              routePill(tr.route, 'Routed to: '),
              el('button', { class: 'btn btn--ghost btn--sm', onClick: () => chooseRoute(id) }, ['Change']),
            ]),
            el('p', { class: 'subtle small', style: 'margin-top:var(--space-2)' }, [
              `by ${p.routed_by_name || '—'}${tr.routed_at ? ' · ' + fmtWhen(tr.routed_at) : ''}`,
            ]),
          ])
        : el('div', {}, [
            el('p', { class: 'subtle small' }, ['Not routed yet — where does this patient go next?']),
            el('div', { style: 'display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-2)' }, [
              inlineRouteBtn('dentist'),
              inlineRouteBtn('hygienist'),
              inlineRouteBtn('both'),
            ]),
          ]),
    ]);

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

      nextStep,
    ]));
  }
}
