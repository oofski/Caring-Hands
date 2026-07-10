import { el, clear, mount, toast, modal } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { SignaturePad } from '../components/signature.js';
import { Odontogram } from '../components/odontogram.js';
import { patientHistoryPanel } from '../components/patientHistory.js';
import { store } from '../store.js';
import { statusPill } from './dashboard.js';

// Cleaning options a hygienist performs (mirrors the provider's cleaning set).
const CLEANING_OPTS = [
  ['adult_prophy', 'Adult prophy'], ['adult_fluoride', 'Adult fluoride'], ['gross_debridement', 'Gross debridement'],
  ['quad_deep_scaling', 'Quadrant deep scaling'], ['sealant', 'Sealant'], ['ohi', 'Oral hygiene instruction'],
];
const QUADRANTS = [['UR', 'UR'], ['UL', 'UL'], ['LR', 'LR'], ['LL', 'LL']];
const fmtWhen = (ts) => { if (!ts) return ''; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString(); };
const routedToHygienist = (p) => p.route === 'hygienist' || p.route === 'both';
const needsDoctor = (cl = {}) => !!(cl.extraction || cl.filling);

// Hygienist view: a focused cleaning station. Patients the EMT station routes
// to the hygienist land here; the doctor's extraction/filling work stays on
// the Provider screen. Saving only ever touches the cleaning fields, so the two
// roles can work the same chart without overwriting each other.
export function renderHygienist(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    const patients = await api.listPatients({});
    const live = patients.filter((p) => p.status !== 'dismissed');
    // B1/B2 QUEUE GATE: a patient only belongs in the cleaning queue once the EMT
    // has signed them off into a clinical queue (status 'triaged'/'in_treatment')
    // AND they were routed to the hygienist. Checked-in patients stay with the EMT.
    const forCleaning = live.filter((p) => routedToHygienist(p) && ['triaged', 'in_treatment'].includes(p.status));
    const rows = forCleaning.map((p) => el('tr', { style: 'cursor:pointer', onClick: () => detail(p.id) }, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`])]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [routedToHygienist(p) ? el('span', { class: 'pill pill--teal' }, [icon('sparkle', { size: 12 }), 'Cleaning']) : el('span', { class: 'subtle small' }, ['—'])]),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [el('button', { class: 'btn btn--primary btn--sm', onClick: (e) => { e.stopPropagation(); detail(p.id); } }, ['Open', icon('chevron', { size: 15 })])]),
    ]));
    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, ['Cleanings']), el('p', { class: 'view-sub' }, [`${forCleaning.length} routed for cleaning · ${live.length} patient(s) in clinic`])]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: queue }, [icon('refresh', { size: 15 }), 'Refresh']),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('sparkle', { size: 15 }), 'Routed for cleaning']),
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Cleaning', 'Status', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 6, class: 'empty' }, ["No patients sent to the hygienist yet — they'll appear here once the EMT signs them off."])])]),
          ]),
        ]),
      ]),
    );
  }

  async function detail(id) {
    const p = await api.getPatient(id);
    const tx = p.treatment || {};
    const tr = p.triage || {};
    const cl = tr.checklist || {};
    const locked = !!tx.locked;
    const alsoDoctor = (p.triage && p.triage.route === 'both') || needsDoctor(cl);
    const me = store.user || null;

    // Cleaning state — preserved from any prior save; teeth tracked as a Set.
    const cleanState = { ...(tx.cleaning || {}) };
    const teeth = new Set(cleanState.teeth || []);

    const odo = Odontogram({
      mode: 'adult',
      txOptions: ['cleaning'],
      teeth: Object.fromEntries([...teeth].map((tid) => [tid, { tx: 'cleaning', note: '' }])),
      onTag: (tid) => { if (!locked) teeth.add(tid); },
      onUntag: (tid) => { if (!locked) teeth.delete(tid); },
    });

    // Bulk-clean a whole quadrant at once (F14) — the odontogram already renders
    // its own quadrant-zoom control and tagged-teeth list, so we only add this.
    const quadDetail = el('input', { class: 'input input--sm', placeholder: 'Quadrant(s) e.g. UR, LL', value: cleanState.quad_detail || '', style: cleanState.quad_deep_scaling ? '' : 'display:none' });
    const bulkSel = el('select', { class: 'input input--sm', style: 'max-width:120px' },
      QUADRANTS.map(([q, l]) => el('option', { value: q }, [l])));
    const bulkClean = el('div', { class: 'inline-row', style: 'margin-top:8px;align-items:center;gap:8px' }, [
      el('span', { class: 'field-label' }, ['Bulk clean quadrant']),
      bulkSel,
      el('button', { class: 'btn btn--soft btn--sm', type: 'button', disabled: locked ? 'disabled' : null, onClick: () => {
        const ids = odo.quadrantIds(bulkSel.value);
        if (!ids.length) { toast('No teeth in that quadrant.', 'info'); return; }
        odo.bulkTag(ids, 'cleaning'); ids.forEach((tid) => teeth.add(tid));
      } }, [icon('checkCircle', { size: 14 }), 'Mark all cleaned']),
    ]);

    // Cleaning option chips.
    const chipRow = el('div', { class: 'chip-row' }, CLEANING_OPTS.map(([k, label]) => {
      const b = el('button', { type: 'button', class: 'chip-btn' + (cleanState[k] ? ' chip-btn--on' : '') }, [label]);
      b.addEventListener('click', () => {
        if (locked) return;
        cleanState[k] = !cleanState[k]; b.classList.toggle('chip-btn--on');
        if (k === 'quad_deep_scaling') quadDetail.style.display = cleanState[k] ? '' : 'none';
      });
      return b;
    }));

    const notes = el('textarea', { class: 'input textarea', rows: 2, placeholder: 'Cleaning notes (optional)', disabled: locked ? 'disabled' : null }, [tx.clinical_notes || '']);
    const hygName = el('input', { class: 'input', placeholder: 'Printed name', value: tx.provider_name || (me ? me.full_name : ''), disabled: locked ? 'disabled' : null });
    const sigPad = SignaturePad();

    // Build a full treatment payload that PRESERVES the doctor's fillings/
    // extractions/anesthetic and only rewrites the cleaning + sign-off fields.
    function buildPayload() {
      return {
        fillings: tx.fillings || [],
        extractions: tx.extractions || [],
        anesthetic: tx.anesthetic || [],
        other_procedures: tx.other_procedures || null,
        cleaning: { ...cleanState, teeth: [...teeth], quad_detail: quadDetail.value.trim() },
        clinical_notes: notes.value.trim() || tx.clinical_notes || null,
        provider_name: hygName.value.trim() || tx.provider_name || null,
        provider_signature: sigPad.getDataUrl() || tx.provider_signature || null,
      };
    }

    async function save(finalize) {
      const payload = buildPayload();
      if (finalize) {
        if (!payload.provider_name) { toast('Printed name is required to complete a cleaning.', 'error'); return; }
        if (!payload.provider_signature) { toast('Signature is required to complete a cleaning.', 'error'); return; }
        const ok = await modal({ title: 'Complete cleaning & sign off?', body: 'This locks the record. Only do this when no fillings or extractions are needed. Continue?', confirmText: 'Complete & lock', cancelText: 'Cancel' });
        if (!ok) return;
      }
      try {
        await api.saveTreatment(id, payload, !!finalize);
        toast(finalize ? 'Cleaning completed' : 'Cleaning saved', 'success');
        detail(id);
      } catch (e) { toast(e.message, 'error'); }
    }

    // B3: hand a patient off to the dentist when they actually need restorative
    // work (extraction/filling). Confirms, routes, then refreshes back to the queue
    // (the patient leaves the cleaning list once routed to the dentist).
    async function transferToDentist() {
      const ok = await modal({
        title: 'Transfer to dentist?',
        body: 'Send this patient to the dentist for restorative work (extraction/filling). They will leave the cleaning queue. Continue?',
        confirmText: 'Transfer to dentist', cancelText: 'Cancel',
      });
      if (!ok) return;
      try {
        await api.routePatient(id, 'dentist');
        toast('Patient transferred to the dentist', 'success');
        queue();
      } catch (e) { toast(e.message, 'error'); }
    }

    // mount() clears and skips null children — the conditional banners below
    // would otherwise render as literal "null" text via native append().
    // LAYOUT (D7): the odontogram gets its OWN full-width card (like provider.js)
    // so the .odo-arch SVG (min-width 680px) has room to render at full size —
    // it is NOT boxed into a narrow .split column. Reads top-to-bottom:
    // header/banners → full-width Odontogram → cleaning options → split for the
    // secondary sign-off + collapsed patient history.
    mount(root,
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => queue() }, [icon('back', { size: 15 }), t('common.back')]),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [`${p.age != null ? p.age + ' yrs · ' : ''}${p.gender || ''}`]),
        ]),
        el('div', { class: 'inline-row', style: 'align-items:center;gap:8px' }, [
          locked ? null : el('button', { class: 'btn btn--soft btn--sm', onClick: transferToDentist, title: 'Send to the dentist for restorative work' }, [icon('tooth', { size: 15 }), 'Transfer to dentist']),
          statusPill(p.status),
        ]),
      ]),

      locked ? el('div', { class: 'banner banner--locked' }, [icon('lock', { size: 16 }), 'This record is signed off and locked.']) : null,
      alsoDoctor && !locked ? el('div', { class: 'banner banner--info' }, [icon('tooth', { size: 16 }), 'This patient is also flagged for the doctor (extraction/filling). Save your cleaning and leave sign-off to the provider.']) : null,

      // FULL-WIDTH odontogram card — spans the whole view, outside any .split.
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('tooth', { size: 15 }), 'Odontogram — tap teeth cleaned']),
        odo.node, bulkClean,
      ]),

      // Cleaning options — full width, directly under the odontogram.
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('sparkle', { size: 15 }), 'Cleaning performed']),
        chipRow,
        el('div', { style: 'margin-top:8px;max-width:280px' }, [quadDetail]),
        el('label', { class: 'field', style: 'margin-top:10px' }, [el('span', { class: 'field-label' }, ['Notes']), notes]),
      ]),

      // Secondary content — sign-off + collapsed patient history in a .split.
      el('div', { class: 'split' }, [
        el('div', { class: 'col col--wide' }, [
          patientHistoryPanel(p, [], { open: false }),
        ]),
        el('div', { class: 'col' }, [
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('pen', { size: 15 }), 'Sign off']),
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Hygienist (printed name)']), hygName]),
            el('div', { style: 'margin-top:8px' }, [sigPad.node]),
            tx.completed_at ? el('p', { class: 'subtle small', style: 'margin-top:6px' }, [`Completed by ${p.completed_by_name || tx.provider_name || '—'} · ${fmtWhen(tx.completed_at)}`]) : null,
            locked ? null : el('div', { class: 'action-stack', style: 'margin-top:10px' }, [
              el('button', { class: 'btn btn--ghost btn--block', onClick: () => save(false) }, [icon('save', { size: 16 }), 'Save cleaning']),
              el('button', { class: 'btn btn--primary btn--block', title: alsoDoctor ? 'Doctor work is pending — normally the provider signs off' : '', onClick: () => save(true) }, [icon('checkCircle', { size: 16 }), 'Complete cleaning & sign off']),
            ]),
          ]),
        ]),
      ]),
    );
  }
}
