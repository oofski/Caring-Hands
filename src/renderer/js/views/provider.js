import { el, clear, toast, modal } from '../dom.js';
import { t, conditions, allergies } from '../i18n.js';
import { api } from '../api.js';
import { SignaturePad } from '../components/signature.js';
import { statusPill } from './dashboard.js';

const EXTRACTION_TYPES = ['simple', 'impact soft tissue', 'impact part bony', 'surgical', 'root tip'];
const CLEANING_OPTS = [
  ['adult_prophy', 'Adult prophy'], ['fluoride', 'Fluoride'], ['gross_debridement', 'Gross debridement'],
  ['quad_deep_scaling', 'Quadrant deep scaling'], ['sealant', 'Sealant'], ['ohi', 'Oral hygiene instruction'],
];
const ANESTHETICS = ['Lidocaine 2%', 'Articaine 4%', 'Septocaine', 'Other'];

export function renderProvider(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    const patients = await api.listPatients({});
    const ready = patients.filter((p) => ['triaged', 'in_treatment'].includes(p.status));
    const rows = ready.map((p) => el('tr', {}, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        (p.flags && p.flags.length) ? el('span', { class: 'flag-dot' }, ['⚑ ' + p.flags.length]) : null]),
      el('td', {}, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [p.assigned_to || '—']),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [el('button', { class: 'btn btn--primary btn--sm', onClick: () => detail(p.id) }, ['Treat →'])]),
    ]));
    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, ['Provider Queue']), el('p', { class: 'view-sub' }, [`${ready.length} patient(s) ready for treatment`])]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: queue }, ['↻ Refresh']),
      ]),
      el('div', { class: 'card' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Chair', 'Status', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 6, class: 'empty' }, ['No patients ready. Complete triage first.'])])]),
        ]),
      ]),
    );
  }

  async function detail(id) {
    const p = await api.getPatient(id);
    const tx = p.treatment || {};
    const locked = tx.locked;

    const flagConds = conditions().filter((c) => c.flag && (p.medical_history.conditions || []).includes(c.key)).map((c) => c.label);
    const flagAllergies = allergies().filter((a) => (p.medical_history.allergies || []).includes(a.key)).map((a) => `Allergy: ${a.label}`);
    if (p.medical_history.pregnancy === 'yes') flagConds.push('Pregnant');
    const flags = [...flagConds, ...flagAllergies];

    // Fillings
    const fillingRows = el('div', { class: 'tx-rows' });
    function addFilling(f = {}) {
      const tooth = el('input', { class: 'input input--sm', placeholder: 'Tooth #', value: f.tooth || '' });
      const surf = el('input', { class: 'input input--sm', placeholder: 'Surfaces (1–4)', value: f.surfaces || '' });
      const pos = el('select', { class: 'input input--sm' });
      ['', 'anterior', 'posterior'].forEach((o) => { const op = el('option', { value: o }, [o || 'Position']); if (o === f.position) op.selected = true; pos.append(op); });
      const row = el('div', { class: 'tx-row' }, [tooth, surf, pos, rmBtn(() => row.remove())]);
      row._get = () => ({ tooth: tooth.value.trim(), surfaces: surf.value.trim(), position: pos.value });
      fillingRows.append(row);
    }
    (tx.fillings || []).forEach(addFilling);

    // Extractions
    const extractRows = el('div', { class: 'tx-rows' });
    function addExtraction(x = {}) {
      const tooth = el('input', { class: 'input input--sm', placeholder: 'Tooth #', value: x.tooth || '' });
      const type = el('select', { class: 'input input--sm' });
      ['', ...EXTRACTION_TYPES].forEach((o) => { const op = el('option', { value: o }, [o || 'Type']); if (o === x.type) op.selected = true; type.append(op); });
      const row = el('div', { class: 'tx-row' }, [tooth, type, rmBtn(() => row.remove())]);
      row._get = () => ({ tooth: tooth.value.trim(), type: type.value });
      extractRows.append(row);
    }
    (tx.extractions || []).forEach(addExtraction);

    // Cleaning checkboxes
    const cleanState = { ...(tx.cleaning || {}) };
    const cleaning = el('div', { class: 'chip-row' }, CLEANING_OPTS.map(([k, label]) =>
      el('button', { type: 'button', class: 'chip-btn' + (cleanState[k] ? ' chip-btn--on' : ''),
        onClick: (e) => { cleanState[k] = !cleanState[k]; e.currentTarget.classList.toggle('chip-btn--on'); } }, [label])));

    // Anesthetic
    const anesRows = el('div', { class: 'tx-rows' });
    function addAnes(a = {}) {
      const agent = el('select', { class: 'input input--sm' });
      ['', ...ANESTHETICS].forEach((o) => { const op = el('option', { value: o }, [o || 'Agent']); if (o === a.agent) op.selected = true; agent.append(op); });
      const carps = el('input', { class: 'input input--sm', type: 'number', min: '0', step: '0.5', placeholder: 'Carps', value: a.carps || '' });
      const loc = el('input', { class: 'input input--sm', placeholder: 'Location (optional)', value: a.location || '' });
      const row = el('div', { class: 'tx-row' }, [agent, carps, loc, rmBtn(() => row.remove())]);
      row._get = () => ({ agent: agent.value, carps: carps.value, location: loc.value.trim() });
      anesRows.append(row);
    }
    (tx.anesthetic || []).forEach(addAnes);

    const other = el('textarea', { class: 'input textarea', rows: 2, placeholder: 'Other procedures not listed above' }, [tx.other_procedures || '']);
    const notes = el('textarea', { class: 'input textarea', rows: 4, placeholder: 'Clinical notes' }, [tx.clinical_notes || '']);
    const providerName = el('input', { class: 'input', placeholder: 'Provider name', value: tx.provider_name || '' });
    const sigPad = SignaturePad();

    function collect() {
      return {
        fillings: Array.from(fillingRows.children).map((r) => r._get()).filter((x) => x.tooth),
        extractions: Array.from(extractRows.children).map((r) => r._get()).filter((x) => x.tooth),
        cleaning: cleanState,
        anesthetic: Array.from(anesRows.children).map((r) => r._get()).filter((x) => x.agent),
        other_procedures: other.value.trim(),
        clinical_notes: notes.value.trim(),
        provider_name: providerName.value.trim(),
        provider_signature: sigPad.getDataUrl() || tx.provider_signature || null,
      };
    }

    async function save(finalize) {
      const payload = collect();
      if (finalize) {
        if (!payload.provider_name) { toast('Provider name is required to sign off.', 'error'); return; }
        if (!payload.provider_signature) { toast('Provider signature is required to sign off.', 'error'); return; }
        const ok = await modal({
          title: 'Finalize & lock record?',
          body: 'Signing off locks this clinical record. It can no longer be edited. Continue?',
          confirmText: 'Sign off & lock', cancelText: 'Cancel',
        });
        if (!ok) return;
      }
      try {
        await api.saveTreatment(id, payload, finalize);
        toast(finalize ? 'Record signed off and locked' : 'Treatment saved', 'success');
        if (finalize) ctx.navigate('provider');
      } catch (e) { toast(e.message, 'error'); }
    }

    const card = (title, ...kids) => el('div', { class: 'card' }, [el('h3', { class: 'card-title' }, [title]), ...kids]);

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => ctx.navigate('provider') }, ['← ' + t('common.back')]),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [`${p.age != null ? p.age + ' yrs · ' : ''}${p.gender || ''} · Complaint: ${(p.triage && p.triage.complaint) || p.dental_history.reason || '—'}`]),
        ]),
        locked ? el('span', { class: 'pill pill--green' }, ['🔒 Locked']) : statusPill(p.status),
      ]),

      flags.length ? el('div', { class: 'banner banner--alert' }, ['⚑ Medical flags: ' + flags.join(' · ')]) : null,
      locked ? el('div', { class: 'banner banner--locked' }, ['🔒 This record is signed off and locked. View or export below.']) : null,

      el('div', { class: 'split' }, [
        el('div', { class: 'col col--wide' }, [
          card('Fillings',
            fillingRows,
            el('button', { class: 'btn btn--ghost btn--sm', onClick: () => addFilling() }, ['＋ Add filling'])),
          card('Extractions',
            extractRows,
            el('button', { class: 'btn btn--ghost btn--sm', onClick: () => addExtraction() }, ['＋ Add extraction'])),
          card('Cleaning', cleaning),
          card('Anesthetic log',
            anesRows,
            el('button', { class: 'btn btn--ghost btn--sm', onClick: () => addAnes() }, ['＋ Add anesthetic'])),
          card('Notes',
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Other procedures']), other]),
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Clinical notes']), notes])),
        ]),
        el('div', { class: 'col' }, [
          card('Patient summary',
            el('div', { class: 'mini-hist' }, [
              el('div', {}, [el('b', {}, ['Triage: ']), triageSummary(p)]),
              el('div', {}, [el('b', {}, ['Allergies: ']), (allergies().filter((a) => (p.medical_history.allergies || []).includes(a.key)).map((a) => a.label).join(', ') || 'None')]),
              el('div', {}, [el('b', {}, ['Meds: ']), (p.medical_history.medications || []).map((m) => m.name).join(', ') || 'None']),
            ])),
          card('Provider sign-off',
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Provider name']), providerName]),
            locked
              ? (tx.provider_signature ? el('img', { class: 'sig-locked', src: tx.provider_signature }) : el('span', { class: 'muted' }, ['—']))
              : sigPad.node,
          ),
          locked
            ? card('Export', exportButtons(ctx, id))
            : el('div', { class: 'action-stack' }, [
                el('button', { class: 'btn btn--ghost btn--block', onClick: () => save(false) }, ['Save progress']),
                el('button', { class: 'btn btn--success btn--block', onClick: () => save(true) }, ['Sign off & lock']),
              ]),
        ]),
      ]),
    );
  }

  function rmBtn(onClick) {
    return el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick }, ['✕']);
  }
}

function triageSummary(p) {
  const tr = p.triage || {};
  const checks = Object.entries(tr.checklist || {}).filter(([, v]) => v).map(([k]) => k);
  return checks.join(', ') || '—';
}

export function exportButtons(ctx, id) {
  const run = async (fn, label) => {
    try { const r = await fn(); if (r && r.saved) ctx.toast(`Saved: ${r.path}`, 'success'); else if (r && r.printed) ctx.toast('Sent to printer', 'success'); }
    catch (e) { ctx.toast(e.message, 'error'); }
  };
  return el('div', { class: 'action-stack' }, [
    el('button', { class: 'btn btn--primary btn--block', onClick: () => run(() => api.pdfGenerate(id, 'progress')) }, ['📄 Progress Note PDF']),
    el('button', { class: 'btn btn--primary btn--block', onClick: () => run(() => api.pdfGenerate(id, 'full')) }, ['📋 Full Record PDF']),
    el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfPrint(id, 'full')) }, ['🖨 Print']),
  ]);
}
