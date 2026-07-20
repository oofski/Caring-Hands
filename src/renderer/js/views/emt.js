import { el, clear, toast, modal } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { patientHistoryPanel } from '../components/patientHistory.js';
import { bloodThinnerStatus, bloodThinnerText, bpStatus, BP_SYS_MAX, BP_DIA_MAX } from '../medFlags.js';
import { statusPill } from './dashboard.js';

// Route metadata shared by the queue pills, the next-step card and the toasts.
// 'both' is retained only so legacy records still render a sensible label — the
// EMT no longer routes to both (check-in is either/or), so it is never offered.
const ROUTES = {
  dentist: {
    label: 'Dentist',
    choice: 'Dentist (fillings / extractions)',
    pill: 'pill--info',
    ic: 'tooth',
    toast: 'Signed off — sent to the dentist queue',
  },
  hygienist: {
    label: 'Hygienist',
    choice: 'Hygienist (cleaning)',
    pill: 'pill--purple',
    ic: 'sparkle',
    toast: 'Signed off — sent to the hygienist queue',
  },
  both: {
    label: 'Dentist + Hygienist',
    choice: 'Both — dentist + hygienist',
    pill: 'pill--warning',
    ic: 'checkCircle',
    toast: 'Sent to the dentist and hygienist queues',
  },
};

// The "other" provider for a one-tap transfer. 'both' has no single opposite.
const OTHER = { dentist: 'hygienist', hygienist: 'dentist' };

// v1.2.0 (C1): the short yes/no medical review the EMT runs through with the
// patient. Keys match the emt_review object persisted on the triage row.
const REVIEW_QS = [
  ['pregnant', 'Pregnant?'],
  ['recent_surgery', 'Recent surgery/hospitalization?'],
  ['diabetic', 'Diabetic?'],
  ['allergies_meds', 'Any medication allergies?'],
];

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

// EMT / Nurse view (F11): record vitals, run a quick yes/no review, confirm
// blood thinners, then sign the patient off to the dentist or hygienist queue.
export function renderEmt(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    ctx.setDetail && ctx.setDetail(false);
    const patients = await api.listPatients({});
    const live = patients.filter((p) => p.status !== 'dismissed');
    // Work order: needs vitals first, then vitals done but not signed off, then the rest.
    const rank = (p) => {
      if (p.status === 'checked_in' && !p.has_vitals) return 0;
      if (p.has_vitals && !p.emt_signed_off) return 1;
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
      el('td', {}, [el('div', { style: 'display:flex;gap:var(--space-1);justify-content:flex-end;align-items:center' }, [
        // C3: export a summary PDF straight from the list, without opening the row.
        el('button', {
          class: 'btn btn--ghost btn--sm',
          title: 'Patient summary PDF',
          onClick: (e) => { e.stopPropagation(); exportSummary(p.id); },
        }, [icon('records', { size: 15 })]),
        el('button', {
          class: 'btn btn--primary btn--sm',
          onClick: (e) => { e.stopPropagation(); detail(p.id); },
        }, ['Open', icon('chevron', { size: 15 })]),
      ])]),
    ]));
    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('h1', {}, ['Vitals & Routing']),
          el('p', { class: 'view-sub' }, [
            `Station 2 — record vitals, then sign each patient off to the dentist or hygienist · ${live.length} patient(s)`,
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

  // C3: generate a summary PDF for a patient (used from the list rows).
  async function exportSummary(id) {
    try {
      const res = await api.pdfGenerate(id, 'summary');
      if (res && res.saved) toast(`Saved: ${res.path}`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // Sign-off: route the patient to a clinical queue, toast, then re-render.
  async function doRoute(id, route) {
    try {
      await api.routePatient(id, route);
      toast((ROUTES[route] && ROUTES[route].toast) || 'Patient routed', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    detail(id);
  }

  async function detail(id) {
    ctx.setDetail && ctx.setDetail(true);
    const p = await api.getPatient(id);
    const tr = p.triage || {};
    const m = p.medical_history || {};
    const flag = bloodThinnerStatus(p);

    const sys = el('input', { class: 'input', type: 'number', min: '0', max: '300', placeholder: t('intake.bpSys'), value: tr.bp_systolic != null ? tr.bp_systolic : (m.bp_systolic || '') });
    const dia = el('input', { class: 'input', type: 'number', min: '0', max: '200', placeholder: t('intake.bpDia'), value: tr.bp_diastolic != null ? tr.bp_diastolic : (m.bp_diastolic || '') });
    const hr = el('input', { class: 'input', type: 'number', min: '0', max: '300', placeholder: t('intake.hr'), value: tr.heart_rate != null ? tr.heart_rate : (m.heart_rate || '') });

    // Turn the blood-pressure reading RED when it hits hypertensive-crisis levels
    // (systolic over 180 or diastolic over 100). The offending field(s) go red as
    // the EMT types, and a red warning line appears below the vitals.
    const bpWarn = el('div', { class: 'banner banner--alert', style: 'margin-top:var(--space-2);display:none' }, [
      icon('alert', { size: 16 }), el('span', {}, ['']),
    ]);
    function refreshBpHighlight() {
      const st = bpStatus(sys.value, dia.value);
      const paint = (inp, hi) => {
        inp.style.borderColor = hi ? 'var(--danger, #c0392b)' : '';
        inp.style.color = hi ? 'var(--danger, #c0392b)' : '';
        inp.style.fontWeight = hi ? '700' : '';
      };
      paint(sys, st.sysHigh);
      paint(dia, st.diaHigh);
      if (st.high) {
        const parts = [];
        if (st.sysHigh) parts.push(`systolic ${st.sys} (> ${BP_SYS_MAX})`);
        if (st.diaHigh) parts.push(`diastolic ${st.dia} (> ${BP_DIA_MAX})`);
        bpWarn.querySelector('span').textContent = `High blood pressure — ${parts.join(', ')}. Recheck and flag before treatment.`;
        bpWarn.style.display = '';
      } else {
        bpWarn.style.display = 'none';
      }
    }
    sys.addEventListener('input', refreshBpHighlight);
    dia.addEventListener('input', refreshBpHighlight);

    // Current vitals to carry through to secondary saves (avoids clobbering).
    function currentVitals() {
      return { bp_systolic: sys.value.trim(), bp_diastolic: dia.value.trim(), heart_rate: hr.value.trim() };
    }

    // After vitals save, ask the patient about blood thinners and persist the
    // answer, then re-render so the sign-off action reflects the update.
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
      detail(id);
    }

    async function save() {
      try {
        await api.saveVitals(id, currentVitals());
        toast('Vitals recorded', 'success');
        await askBloodThinner();
      } catch (e) { toast(e.message, 'error'); }
    }

    // C1: persist the yes/no review (attaches to the record + PDF) then re-render.
    const reviewState = { ...(tr.emt_review || {}) };
    async function saveReview() {
      try {
        await api.saveVitals(id, { ...currentVitals(), emt_review: { ...reviewState } });
        toast('Review saved', 'success');
        detail(id);
      } catch (e) { toast(e.message, 'error'); }
    }

    // Two-button Yes/No toggle bound to reviewState[key]; restyles in place.
    function reviewToggle(key) {
      const btn = (val, label) => el('button', {
        class: `btn btn--sm ${reviewState[key] === val ? 'btn--primary' : 'btn--ghost'}`,
        dataset: { val },
        onClick: (e) => {
          reviewState[key] = val;
          const group = e.currentTarget.parentElement;
          Array.from(group.children).forEach((b) => {
            b.className = `btn btn--sm ${b.dataset.val === reviewState[key] ? 'btn--primary' : 'btn--ghost'}`;
          });
        },
      }, [label]);
      return el('div', { style: 'display:flex;gap:var(--space-1);flex:0 0 auto' }, [btn('yes', 'Yes'), btn('no', 'No')]);
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

    // Canonical blood-thinner status line (shared helper) — same wording every
    // screen shows. The dedicated Yes/No modal is the single source of truth.
    const bt = bloodThinnerText(p);
    const bloodThinnerLine = el('p', { style: 'margin-top:var(--space-2)' }, [
      bt.level === 'danger'
        ? el('span', { class: 'pill pill--danger' }, [el('span', { class: 'pill-dot' }), bt.text])
        : el('span', { class: 'subtle small' }, [bt.text]),
    ]);

    // EMT review card (C1).
    const reviewCard = el('div', { class: 'card', style: 'margin-top:var(--space-4)' }, [
      el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'EMT review']),
      el('p', { class: 'subtle small' }, ['Ask the patient and record each answer.']),
      el('div', { style: 'display:flex;flex-direction:column;gap:var(--space-2);margin-top:var(--space-2)' },
        REVIEW_QS.map(([key, label]) => el('div', {
          style: 'display:flex;align-items:center;justify-content:space-between;gap:var(--space-3)',
        }, [
          el('span', { class: 'field-label' }, [label]),
          reviewToggle(key),
        ]))),
      el('button', {
        class: 'btn btn--soft btn--block',
        style: 'margin-top:var(--space-3)',
        onClick: saveReview,
      }, [icon('save', { size: 16 }), 'Save review']),
    ]);

    // Next-step card (B2): sign-off defaults to the provider the patient picked
    // at check-in (tr.route). Routing is the sign-off — it moves them onward.
    const inlineRouteBtn = (route) => el('button', {
      class: 'btn btn--primary btn--sm',
      onClick: () => doRoute(id, route),
    }, [icon(ROUTES[route].ic, { size: 15 }), ROUTES[route].choice]);

    let nextStepBody;
    if (tr.emt_signed_off && tr.route && ROUTES[tr.route]) {
      const other = OTHER[tr.route];
      nextStepBody = el('div', {}, [
        el('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap' }, [
          icon('checkCircle', { size: 16 }),
          el('strong', {}, [`Signed off · sent to ${ROUTES[tr.route].label}`]),
        ]),
        el('p', { class: 'subtle small', style: 'margin-top:var(--space-2)' }, [
          `by ${p.routed_by_name || '—'}${tr.routed_at ? ' · ' + fmtWhen(tr.routed_at) : ''}`,
        ]),
        other ? el('button', {
          class: 'btn btn--ghost btn--sm',
          style: 'margin-top:var(--space-3)',
          onClick: () => doRoute(id, other),
        }, [icon(ROUTES[other].ic, { size: 15 }), `Transfer to ${ROUTES[other].label} instead`]) : null,
      ]);
    } else if (tr.route && ROUTES[tr.route]) {
      const other = OTHER[tr.route];
      nextStepBody = el('div', {}, [
        el('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap' }, [
          el('span', { class: 'subtle small' }, ['Patient asked to see:']),
          routePill(tr.route),
        ]),
        el('button', {
          class: 'btn btn--primary btn--block',
          style: 'margin-top:var(--space-3)',
          onClick: () => doRoute(id, tr.route),
        }, [icon(ROUTES[tr.route].ic, { size: 16 }), `Sign off & send to ${ROUTES[tr.route].label}`]),
        other ? el('button', {
          class: 'btn btn--ghost btn--sm btn--block',
          style: 'margin-top:var(--space-2)',
          onClick: () => doRoute(id, other),
        }, [`Send to the ${ROUTES[other].label} instead`]) : null,
      ]);
    } else {
      nextStepBody = el('div', {}, [
        el('p', { class: 'subtle small' }, ['No provider on record — sign off to the dentist or hygienist:']),
        el('div', { style: 'display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-2)' }, [
          inlineRouteBtn('dentist'),
          inlineRouteBtn('hygienist'),
        ]),
      ]);
    }

    const nextStep = el('div', { class: 'card', style: 'margin-top:var(--space-4)' }, [
      el('div', { class: 'card-title' }, [icon('checkCircle', { size: 15 }), 'Next step']),
      nextStepBody,
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
        bpWarn,
        lastRecorded,
        bloodThinnerLine,
        el('button', { class: 'btn btn--soft btn--block', style: 'margin-top:var(--space-3)', onClick: save }, [icon('save', { size: 16 }), 'Save vitals']),
      ]),

      reviewCard,

      nextStep,
    ]));
    refreshBpHighlight(); // paint a stored high reading red on open
  }
}
