import { el, clear, toast, modal } from '../dom.js';
import { t, conditions, allergies } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { SignaturePad } from '../components/signature.js';
import { Odontogram } from '../components/odontogram.js';
import { patientHistoryCards, incompleteBanner } from '../components/patientHistory.js';
import { store } from '../store.js';
import { statusPill } from './dashboard.js';

const EXTRACTION_TYPES = [
  ['simple', 'Simple'], ['impact_soft', 'Impact soft tissue'], ['impact_bony', 'Impact part bony'],
  ['surgical', 'Surgical'], ['root_tip', 'Root tip'],
];
const CLEANING_OPTS = [
  ['adult_prophy', 'Adult prophy'], ['adult_fluoride', 'Adult fluoride'], ['gross_debridement', 'Gross debridement'],
  ['quad_deep_scaling', 'Quadrant deep scaling'], ['sealant', 'Sealant'], ['ohi', 'Oral hygiene instruction'],
];
const TRIAGE_OPTS = [
  ['cleaning', 'Cleaning'], ['extraction', 'Extraction'], ['filling', 'Filling'],
  ['none', 'No treatment'], ['referral', 'Referral'],
];

export function renderProvider(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    const patients = await api.listPatients({});
    const ready = patients.filter((p) => ['triaged', 'in_treatment'].includes(p.status));
    const rows = ready.map((p) => el('tr', {}, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        (p.flags && p.flags.length) ? flagDot(p.flags.length) : null]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [p.assigned_to || '—']),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [chevronBtn('Treat', () => detail(p.id))]),
    ]));
    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, ['Provider Queue']), el('p', { class: 'view-sub' }, [`${ready.length} patient(s) ready for treatment`])]),
        ghostBtn('refresh', 'Refresh', queue),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Chair', 'Status', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 6, class: 'empty' }, ['No patients ready. Complete triage first.'])])]),
          ]),
        ]),
      ]),
    );
  }

  async function detail(id) {
    const p = await api.getPatient(id);
    const tr = p.triage || {};
    const tx = p.treatment || {};
    const locked = tx.locked;
    let xrays = await api.listXrays(id);
    const priorVisits = await api.patientHistory(id).catch(() => []);

    // medical flags
    const flagConds = conditions().filter((c) => c.flag && (p.medical_history.conditions || []).includes(c.key)).map((c) => c.label);
    const flagAllergies = allergies().filter((a) => (p.medical_history.allergies || []).includes(a.key)).map((a) => `Allergy: ${a.label}`);
    if (p.medical_history.pregnancy === 'yes') flagConds.push('Pregnant');
    const flags = [...flagConds, ...flagAllergies];

    /* ---------- Triage row (paper: top of sheet) ---------- */
    const checkState = { ...(tr.checklist || {}) };
    const triageChips = el('div', { class: 'chip-row' }, TRIAGE_OPTS.map(([k, label]) =>
      toggleChip(label, !!checkState[k], (on) => { checkState[k] = on; refreshMarks(); }, locked)));
    const complaint = input(tr.complaint || p.dental_history.reason || '', 'Chief complaint', locked);
    const triageNotes = textarea(tr.notes || '', 'Triage notes', 2, locked);
    const station = input(tr.xray_station || '', 'Station #', locked, 'input--sm');
    const xrayCountEl = el('span', { class: 'xray-count-badge' }, [icon('xray', { size: 16 }), el('span', {}, [String(xrays.length)])]);

    /* ---------- Odontogram (the mouth) — click a tooth to tag + note ---------- */
    const odo = Odontogram({
      mode: 'adult',
      teeth: initialTeeth(tx, tr),
      onTag: (id, d) => { if (!locked) syncToothToRows(id, d); },
      onUntag: (id) => { if (!locked) removeAutoRows(id); },
    });

    // When a tooth is tagged in the odontogram, fill the matching list row.
    function syncToothToRows(id, d) {
      removeAutoRows(id, d.tx);
      if (d.tx === 'filling') {
        const existing = findRow(fillingRows, id);
        if (existing) { setRowNote(existing, d.note); } else { addFilling({ tooth: id, note: d.note }, true); }
      } else if (d.tx === 'extraction') {
        const existing = findRow(extractRows, id);
        if (existing) { setRowNote(existing, d.note); } else { addExtraction({ tooth: id, note: d.note }, true); }
      } else if (d.tx === 'cleaning') {
        if (!cleanState.teeth) cleanState.teeth = [];
        if (!cleanState.teeth.includes(id)) { cleanState.teeth.push(id); renderCleanTeeth(); }
      }
    }
    function removeAutoRows(id, keepTx) {
      [['filling', fillingRows], ['extraction', extractRows]].forEach(([tx, rows]) => {
        if (keepTx === tx) return;
        const r = findRow(rows, id);
        if (r && r.dataset.auto === '1') r.remove();
      });
      if (keepTx !== 'cleaning' && cleanState.teeth) {
        const i = cleanState.teeth.indexOf(id);
        if (i >= 0) { cleanState.teeth.splice(i, 1); renderCleanTeeth(); }
      }
    }
    function findRow(rowsEl, tooth) {
      return Array.from(rowsEl.children).find((r) => r._get && r._get().tooth === tooth);
    }
    function setRowNote(row, note) { if (row._setNote) row._setNote(note); }

    /* ---------- Fillings ---------- */
    const fillingRows = el('div', { class: 'tx-rows' });
    function addFilling(f = {}, auto = false) {
      const tooth = el('input', { class: 'input input--sm num', placeholder: 'Tooth #', value: f.tooth || '', onInput: () => refreshMarks() });
      const surf = new Set((f.surfaces || []).map(String));
      const surfWrap = el('div', { class: 'surface-pills' }, ['1', '2', '3', '4'].map((n) =>
        el('button', { type: 'button', class: 'surf-chip' + (surf.has(n) ? ' surf-chip--on' : ''), onClick: (e) => { if (locked) return; if (surf.has(n)) surf.delete(n); else surf.add(n); e.currentTarget.classList.toggle('surf-chip--on'); } }, [n])));
      let ant = !!f.ant, post = !!f.post;
      const antBtn = toggleChip('Ant', ant, (on) => { ant = on; }, locked);
      const postBtn = toggleChip('Post', post, (on) => { post = on; }, locked);
      const noteChip = el('span', { class: 'tx-note' + (f.note ? '' : ' hidden') }, [f.note || '']);
      const row = el('div', { class: 'filling-row' }, [
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Tooth #']), tooth]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Surfaces']), surfWrap]),
        el('div', { class: 'antpost' }, [antBtn, postBtn]),
        noteChip,
        locked ? el('span') : iconBtn('x', () => { row.remove(); refreshMarks(); }),
      ]);
      row.dataset.tooth = f.tooth || '';
      if (auto) row.dataset.auto = '1';
      row._get = () => ({ tooth: tooth.value.trim(), surfaces: Array.from(surf), ant, post, note: noteChip.textContent.trim() });
      row._setNote = (n) => { noteChip.textContent = n || ''; noteChip.classList.toggle('hidden', !n); };
      fillingRows.append(row);
    }
    (tx.fillings || []).forEach((f) => addFilling(f));
    if (!(tx.fillings || []).length && !locked) addFilling();

    /* ---------- Extractions ---------- */
    const extractRows = el('div', { class: 'tx-rows' });
    function addExtraction(x = {}, auto = false) {
      const tooth = el('input', { class: 'input input--sm num', placeholder: 'Tooth #', value: x.tooth || '', onInput: () => refreshMarks() });
      const types = new Set(x.types || []);
      const typeChips = EXTRACTION_TYPES.map(([k, label]) =>
        toggleChip(label, types.has(k), (on) => { if (on) types.add(k); else types.delete(k); }, locked));
      const noteChip = el('span', { class: 'tx-note' + (x.note ? '' : ' hidden') }, [x.note || '']);
      const row = el('div', { class: 'ext-row' }, [
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { class: 'field-label' }, ['Tooth #']), tooth]),
        ...typeChips,
        noteChip,
        locked ? el('span') : iconBtn('x', () => { row.remove(); refreshMarks(); }),
      ]);
      row.dataset.tooth = x.tooth || '';
      if (auto) row.dataset.auto = '1';
      row._get = () => ({ tooth: tooth.value.trim(), types: Array.from(types), note: noteChip.textContent.trim() });
      row._setNote = (n) => { noteChip.textContent = n || ''; noteChip.classList.toggle('hidden', !n); };
      extractRows.append(row);
    }
    (tx.extractions || []).filter((x) => !x.other).forEach((x) => addExtraction(x));
    const otherExisting = (tx.extractions || []).find((x) => x.other) || {};
    const extOther = el('input', { class: 'input', placeholder: 'Other extraction (describe)', value: otherExisting.other || '' });
    const extOtherTooth = el('input', { class: 'input input--sm num', placeholder: 'Tooth #', value: otherExisting.tooth || '' });

    /* ---------- Cleaning ---------- */
    const cleanState = { ...(tx.cleaning || {}) };
    if (!cleanState.teeth) cleanState.teeth = [];
    const quadDetail = el('input', { class: 'input input--sm', placeholder: 'Quadrant(s) e.g. UR, LL', value: cleanState.quad_detail || '', style: cleanState.quad_deep_scaling ? '' : 'display:none' });
    const cleanTeeth = el('div', { class: 'odo-selected-list', style: 'margin-top:8px' });
    function renderCleanTeeth() {
      clear(cleanTeeth);
      if (!cleanState.teeth.length) { cleanTeeth.style.display = 'none'; return; }
      cleanTeeth.style.display = '';
      cleanTeeth.append(el('span', {}, ['Teeth cleaned:']));
      cleanState.teeth.forEach((id) => cleanTeeth.append(el('span', { class: 'tooth-tag' }, [id])));
    }
    const cleaning = el('div', {}, [
      el('div', { class: 'chip-row' }, CLEANING_OPTS.map(([k, label]) =>
        toggleChip(label, !!cleanState[k], (on) => {
          cleanState[k] = on;
          if (k === 'quad_deep_scaling') quadDetail.style.display = on ? '' : 'none';
        }, locked))),
      el('div', { style: 'margin-top:8px;max-width:260px' }, [quadDetail]),
      cleanTeeth,
    ]);
    renderCleanTeeth();

    /* ---------- Anesthetic ---------- */
    const an = tx.anesthetic && !Array.isArray(tx.anesthetic) ? tx.anesthetic : legacyAnesthetic(tx.anesthetic);
    const anesAgents = [
      { key: 'lidocaine', label: 'Lidocaine 2%' },
      { key: 'articaine', label: 'Articaine 4%' },
      { key: 'other', label: 'Other agent' },
      { key: 'supplemental', label: 'Supplemental' },
    ];
    const anesInputs = {};
    const anesGrid = el('div', {}, anesAgents.map((a) => {
      const cur = an[a.key] || {};
      const carps = el('input', { class: 'input input--sm num', type: 'number', min: '0', step: '0.5', placeholder: 'Carps', value: cur.carps || '' });
      const loc = el('input', { class: 'input input--sm', placeholder: 'Location', value: cur.location || '' });
      let nameInput = null;
      let agentCell;
      if (a.key === 'other') {
        nameInput = el('input', { class: 'input input--sm', placeholder: 'Name agent', value: cur.name || '' });
        agentCell = el('div', { class: 'anes-agent', style: 'display:flex;gap:6px;align-items:center' }, ['Other:', nameInput]);
      } else {
        agentCell = el('span', { class: 'anes-agent' }, [a.label]);
      }
      if (locked) { carps.disabled = true; loc.disabled = true; if (nameInput) nameInput.disabled = true; }
      anesInputs[a.key] = { carps, loc, nameInput };
      return el('div', { class: 'anes-grid' }, [agentCell, carps, loc]);
    }));

    /* ---------- Notes ---------- */
    const otherProc = textarea(tx.other_procedures || '', 'Other procedure', 2, locked);
    const dentalNotes = textarea(tx.clinical_notes || '', 'Dental notes', 4, locked);

    /* ---------- X-ray panel ---------- */
    const gallery = el('div', { class: 'xray-gallery' });
    const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
    function renderGallery() {
      clear(gallery);
      xrays.forEach((x) => {
        const card = el('div', { class: 'xray-card', onClick: () => viewXray(x) }, [
          el('img', { src: x.image_png, alt: 'x-ray' }),
          el('div', { class: 'xray-card-meta' }, [el('span', {}, [x.station ? `St ${x.station}` : '—']), el('span', {}, [`#${x.id}`])]),
          locked ? null : el('button', { class: 'xray-del', title: 'Delete x-ray', onClick: async (e) => { e.stopPropagation(); await delXray(x.id); } }, [icon('trash', { size: 14 })]),
        ]);
        gallery.append(card);
      });
      if (!locked) {
        gallery.append(el('div', { class: 'xray-add', onClick: () => fileInput.click() }, [icon('upload', { size: 20 }), el('span', {}, ['Add x-ray'])]));
      }
      if (!xrays.length && locked) gallery.append(el('span', { class: 'subtle' }, ['No x-rays on file.']));
      xrayCountEl.lastChild.textContent = String(xrays.length);
    }
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      for (const file of files) {
        await new Promise((res) => {
          const reader = new FileReader();
          reader.onload = async () => {
            try { await api.addXray({ patientId: id, station: station.input ? station.input.value.trim() : '', image_png: reader.result, note: '' }); }
            catch (e) { toast(e.message, 'error'); }
            res();
          };
          reader.readAsDataURL(file);
        });
      }
      xrays = await api.listXrays(id);
      renderGallery();
      toast(`${files.length} x-ray(s) added`, 'success');
      fileInput.value = '';
    });
    async function delXray(xid) {
      const ok = await modal({ title: 'Delete x-ray?', body: 'This permanently removes the image from the record.', confirmText: 'Delete', cancelText: 'Cancel', danger: true });
      if (!ok) return;
      try { await api.deleteXray(xid); xrays = await api.listXrays(id); renderGallery(); toast('X-ray deleted', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    }
    function viewXray(x) {
      const img = el('img', { class: 'xray-viewer-img', src: x.image_png });
      modal({ title: `X-ray #${x.id}${x.station ? ' · Station ' + x.station : ''}`, body: img, confirmText: t('common.close') });
    }
    renderGallery();

    /* ---------- Sign-off ---------- */
    const providerName = el('input', { class: 'input', placeholder: 'Printed name', value: tx.provider_name || '' });
    if (locked) providerName.disabled = true;
    const sigPad = SignaturePad();

    /* ---------- helpers to collect + mark ---------- */
    function computeMarksLive() {
      const m = {};
      Array.from(fillingRows.children).forEach((r) => { const f = r._get(); if (f.tooth) m[f.tooth] = 'filling'; });
      Array.from(extractRows.children).forEach((r) => { const x = r._get(); if (x.tooth) m[x.tooth] = 'extraction'; });
      (cleanState.teeth || []).forEach((id) => { if (!m[id]) m[id] = 'cleaning'; });
      return m;
    }
    // Manual row edits reflect back onto the mouth (silent — no onTag loop).
    function refreshMarks() { odo.setMarks(computeMarksLive()); }

    function collectTreatment() {
      const extractions = Array.from(extractRows.children).map((r) => r._get()).filter((x) => x.tooth);
      if (extOther.value.trim() || extOtherTooth.value.trim()) extractions.push({ tooth: extOtherTooth.value.trim(), types: [], other: extOther.value.trim() });
      const anesthetic = {};
      Object.entries(anesInputs).forEach(([k, v]) => {
        const carps = v.carps.value.trim(), location = v.loc.value.trim();
        const name = v.nameInput ? v.nameInput.value.trim() : '';
        if (carps || location || name) anesthetic[k] = { carps, location, ...(name ? { name } : {}) };
      });
      return {
        fillings: Array.from(fillingRows.children).map((r) => r._get()).filter((x) => x.tooth),
        extractions,
        cleaning: { ...cleanState, quad_detail: quadDetail.value.trim() },
        anesthetic,
        other_procedures: otherProc.get(),
        clinical_notes: dentalNotes.get(),
        provider_name: providerName.value.trim(),
        provider_signature: sigPad.getDataUrl() || tx.provider_signature || null,
      };
    }
    function collectTriage() {
      return {
        complaint: complaint.get(),
        flags,
        checklist: checkState,
        teeth: odo.getSelected(),
        teeth_notes: odo.getNotes(),
        notes: triageNotes.get(),
        xray_count: xrays.length,
        xray_station: station.get(),
        assigned_to: tr.assigned_to || null,
        status: (p.triage && p.triage.status) || 'ready',
        triage_signature: tr.triage_signature || null,
        triage_signer_name: tr.triage_signer_name || null,
      };
    }

    async function save(finalize) {
      const payload = collectTreatment();
      if (finalize) {
        if (!payload.provider_name) { toast('Printed provider name is required to sign off.', 'error'); return; }
        if (!payload.provider_signature) { toast('Provider signature is required to sign off.', 'error'); return; }
        const ok = await modal({ title: 'Finalize & lock record?', body: 'Signing off locks this clinical record so it can no longer be edited. Continue?', confirmText: 'Sign off & lock', cancelText: 'Cancel' });
        if (!ok) return;
      }
      try {
        await api.saveTriage(id, collectTriage());
        await api.saveTreatment(id, payload, finalize);
        toast(finalize ? 'Record signed off and locked' : 'Progress saved', 'success');
        if (finalize) ctx.navigate('provider'); else detail(id);
      } catch (e) { toast(e.message, 'error'); }
    }

    /* ---------- render ---------- */
    const panel = (ic, title, ...kids) => el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [icon(ic, { size: 15 }), title]), ...kids,
    ]);

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          backBtn(() => ctx.navigate('provider')),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [`${p.age != null ? p.age + ' yrs · ' : ''}${p.gender || ''} · ${p.language === 'es' ? 'Español' : 'English'} · Complaint: ${(tr.complaint) || p.dental_history.reason || '—'}`]),
        ]),
        locked ? el('span', { class: 'pill pill--neutral' }, [icon('lock', { size: 12 }), 'Locked']) : statusPill(p.status),
      ]),

      incompleteBanner(p, {
        isAdmin: store.is('admin'),
        onDelete: async () => { try { await api.deletePatient(id); toast('Empty record deleted', 'success'); ctx.navigate('provider'); } catch (e) { toast(e.message, 'error'); } },
        onNewCheckin: () => ctx.navigate('kiosk'),
      }),
      flags.length ? el('div', { class: 'banner banner--alert' }, [icon('flag', { size: 16 }), 'Medical flags: ' + flags.join(' · ')]) : null,
      locked ? el('div', { class: 'banner banner--locked' }, [icon('lock', { size: 16 }), 'This record is signed off and locked. View or export below.']) : null,

      // Full patient history — collapsible, open by default.
      el('details', { class: 'history-details', open: 'open' }, [
        el('summary', { class: 'history-summary' }, [icon('clipboard', { size: 16 }), 'Patient history', priorVisits.length ? el('span', { class: 'pill pill--info', style: 'margin-left:8px' }, [`${priorVisits.length} prior visit(s)`]) : null]),
        el('div', { class: 'history-grid' }, patientHistoryCards(p, priorVisits)),
      ]),

      // Triage / visit bar (paper top row)
      panel('clipboard', 'Triage & Visit',
        el('div', { class: 'field-row', style: 'margin-bottom:10px' }, [
          el('div', {}, [el('span', { class: 'field-label' }, ['Total x-rays']), el('div', { style: 'padding-top:6px' }, [xrayCountEl])]),
          el('label', { class: 'field', style: 'margin:0;max-width:130px' }, [el('span', { class: 'field-label' }, ['X-ray station #']), station.node]),
        ]),
        el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Triage — treatment indicated']), triageChips]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Chief complaint']), complaint.node]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Triage notes']), triageNotes.node]),
      ),

      // The mouth
      panel('tooth', 'Odontogram — tap teeth of concern', odo.node),

      el('div', { class: 'panel-grid-2' }, [
        panel('pen', 'Fillings',
          fillingRows,
          locked ? null : softBtn('plus', 'Add filling', () => { addFilling(); refreshMarks(); })),
        panel('tooth', 'Extractions',
          extractRows,
          locked ? null : softBtn('plus', 'Add extraction', () => { addExtraction(); refreshMarks(); }),
          el('div', { class: 'field-row', style: 'margin-top:10px' }, [
            el('label', { class: 'field', style: 'flex:1;margin:0' }, [el('span', { class: 'field-label' }, ['Other']), extOther]),
            el('label', { class: 'field', style: 'margin:0;max-width:90px' }, [el('span', { class: 'field-label' }, ['Tooth #']), extOtherTooth]),
          ])),
      ]),

      el('div', { class: 'panel-grid-2' }, [
        panel('checkCircle', 'Cleaning (hygiene)', cleaning),
        panel('syringe', 'Anesthetic administered', anesGrid),
      ]),

      // X-rays — provider can add/view (user priority)
      panel('xray', 'X-rays', gallery, fileInput),

      panel('clipboard', 'Notes',
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Other procedure']), otherProc.node]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Dental notes']), dentalNotes.node])),

      // Patient summary + sign-off + export
      el('div', { class: 'panel-grid-2' }, [
        panel('user', 'Patient summary',
          el('div', { class: 'mini-hist' }, [
            el('div', {}, [el('b', {}, ['Allergies: ']), (allergies().filter((a) => (p.medical_history.allergies || []).includes(a.key)).map((a) => a.label).join(', ') || 'None')]),
            el('div', {}, [el('b', {}, ['Conditions: ']), (conditions().filter((c) => (p.medical_history.conditions || []).includes(c.key)).map((c) => c.label).join(', ') || 'None')]),
            el('div', {}, [el('b', {}, ['Medications: ']), (p.medical_history.medications || []).map((m) => m.name).join(', ') || 'None']),
            el('div', {}, [el('b', {}, ['Consent: ']), (p.consents || []).some((c) => c.type === 'general') ? 'Signed' : 'Missing']),
          ])),
        panel('pen', 'Provider sign-off',
          el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Printed name']), providerName]),
          locked
            ? (tx.provider_signature ? el('img', { class: 'sig-locked', src: tx.provider_signature }) : el('span', { class: 'subtle' }, ['—']))
            : sigPad.node,
          locked
            ? exportButtons(ctx, id)
            : el('div', { class: 'action-stack', style: 'margin-top:12px' }, [
                ghostBtn('save', 'Save progress', () => save(false)),
                primaryBtn('checkCircle', 'Sign off & lock', () => save(true)),
              ])),
      ]),
    );
    refreshMarks();
  }
}

/* ---------------- small UI helpers ---------------- */
function input(value, placeholder, disabled, cls = '') {
  const i = el('input', { class: 'input ' + cls, value, placeholder });
  if (disabled) i.disabled = true;
  return { node: i, input: i, get: () => i.value.trim() };
}
function textarea(value, placeholder, rows, disabled) {
  const ta = el('textarea', { class: 'input textarea', rows: rows || 3, placeholder }, [value || '']);
  if (disabled) ta.disabled = true;
  return { node: ta, get: () => ta.value.trim() };
}
function toggleChip(label, on, cb, disabled) {
  const b = el('button', { type: 'button', class: 'chip-btn' + (on ? ' chip-btn--on' : '') }, [label]);
  if (disabled) b.disabled = true;
  else b.addEventListener('click', () => { const now = !b.classList.contains('chip-btn--on'); b.classList.toggle('chip-btn--on', now); cb(now); });
  return b;
}
function iconBtn(name, onClick) { return el('button', { class: 'btn btn--ghost btn--sm btn--icon', type: 'button', onClick }, [icon(name, { size: 15 })]); }
function ghostBtn(name, label, onClick) { return el('button', { class: 'btn btn--ghost btn--sm', onClick }, [icon(name, { size: 15 }), label]); }
function softBtn(name, label, onClick) { return el('button', { class: 'btn btn--soft btn--sm', type: 'button', onClick }, [icon(name, { size: 15 }), label]); }
function primaryBtn(name, label, onClick) { return el('button', { class: 'btn btn--primary btn--block', onClick }, [icon(name, { size: 16 }), label]); }
function backBtn(onClick) { return el('button', { class: 'btn btn--ghost btn--sm', onClick }, [icon('back', { size: 15 }), t('common.back')]); }
function chevronBtn(label, onClick) { return el('button', { class: 'btn btn--primary btn--sm', onClick }, [label, icon('chevron', { size: 15 })]); }
function flagDot(n) { return el('span', { class: 'flag-dot' }, [icon('flag', { size: 13 }), String(n)]); }

function legacyAnesthetic(arr) {
  // Convert old array-of-rows shape into the keyed shape.
  const out = {};
  (arr || []).forEach((a) => {
    const key = /lido/i.test(a.agent) ? 'lidocaine' : /artic/i.test(a.agent) ? 'articaine' : 'other';
    out[key] = { carps: a.carps, location: a.location };
  });
  return out;
}

// Seed the odontogram from existing treatment + triage so the mouth reflects
// prior work and per-tooth notes round-trip.
function initialTeeth(tx, tr) {
  const data = {};
  (tx.fillings || []).forEach((f) => { if (f.tooth) data[f.tooth] = { tx: 'filling', note: f.note || '' }; });
  (tx.extractions || []).forEach((x) => { if (x.tooth && !x.other) data[x.tooth] = { tx: 'extraction', note: x.note || '' }; });
  ((tx.cleaning && tx.cleaning.teeth) || []).forEach((id) => { if (!data[id]) data[id] = { tx: 'cleaning', note: '' }; });
  (tr.teeth || []).forEach((id) => { if (!data[id]) data[id] = { tx: null, note: (tr.teeth_notes && tr.teeth_notes[id]) || '' }; });
  Object.entries(tr.teeth_notes || {}).forEach(([id, note]) => { if (data[id] && !data[id].note) data[id].note = note; });
  return data;
}

export function exportButtons(ctx, id) {
  const run = async (fn) => {
    try { const r = await fn(); if (r && r.saved) ctx.toast(`Saved: ${r.path}`, 'success'); else if (r && r.printed) ctx.toast('Sent to printer', 'success'); }
    catch (e) { ctx.toast(e.message, 'error'); }
  };
  return el('div', { class: 'action-stack', style: 'margin-top:12px' }, [
    el('button', { class: 'btn btn--primary btn--block', onClick: () => run(() => api.pdfGenerate(id, 'progress')) }, [icon('save', { size: 16 }), 'Progress Note PDF']),
    el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfGenerate(id, 'full')) }, [icon('clipboard', { size: 16 }), 'Full Record PDF']),
    el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfPrint(id, 'full')) }, [icon('print', { size: 16 }), 'Print']),
    el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.exportRecordUsb(id)) }, [icon('upload', { size: 16 }), 'Save to patient USB']),
  ]);
}
