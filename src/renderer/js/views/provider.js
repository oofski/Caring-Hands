import { el, clear, toast, modal } from '../dom.js';
import { t, conditions, allergies } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { SignaturePad } from '../components/signature.js';
import { Odontogram } from '../components/odontogram.js';
import { patientHistoryCards, incompleteBanner } from '../components/patientHistory.js';
import { store } from '../store.js';
import { statusPill } from './dashboard.js';
import { bloodThinnerFlags } from '../medFlags.js';

const QUADRANTS = [['UR', 'UR'], ['UL', 'UL'], ['LR', 'LR'], ['LL', 'LL']];
const fmtWhen = (ts) => { if (!ts) return ''; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString(); };

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
    // F12: blood-thinner / anticoagulant detection — surfaced as a prominent danger banner.
    const thinnerFlags = bloodThinnerFlags(p.medical_history);

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
      // Doctor's odontogram offers only the doctor's services; cleaning is the
      // hygienist's job (still available in the collapsed Cleaning panel).
      txOptions: ['filling', 'extraction'],
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

    /* ---------- F10: oral-surgery consent tooth numbers ---------- */
    const surgeryConsent = (p.consents || []).find((c) => c.type === 'oral_surgery');
    function consentTeethPanel() {
      if (!surgeryConsent) return null;
      const teethInput = el('input', { class: 'input', placeholder: 'e.g. 18, 19', value: surgeryConsent.tooth_numbers || '' });
      if (locked) teethInput.disabled = true;
      const amended = el('div', { class: 'subtle small', style: 'margin-top:8px' });
      const renderAmended = () => {
        clear(amended);
        if (surgeryConsent.amended_by) {
          amended.append(icon('pen', { size: 12 }), ` Teeth set by ${surgeryConsent.amended_by}${surgeryConsent.amended_at ? ' on ' + fmtWhen(surgeryConsent.amended_at) : ''}`);
        }
      };
      renderAmended();
      const saveBtn = el('button', { class: 'btn btn--primary btn--sm', type: 'button', onClick: async () => {
        const val = teethInput.value.trim();
        try {
          // setConsentTeeth returns the full refreshed patient; read the authoritative consent back.
          const res = await api.setConsentTeeth(surgeryConsent.id, val);
          const updated = (res && res.consents || []).find((c) => c.id === surgeryConsent.id) || {};
          surgeryConsent.tooth_numbers = updated.tooth_numbers != null ? updated.tooth_numbers : val;
          surgeryConsent.amended_by = updated.amended_by || (store.user && store.user.full_name) || 'staff';
          surgeryConsent.amended_at = updated.amended_at || new Date().toISOString();
          teethInput.value = surgeryConsent.tooth_numbers;
          renderAmended();
          toast('Consent tooth number(s) saved', 'success');
        } catch (e) { toast(e.message, 'error'); }
      } }, [icon('save', { size: 15 }), 'Save teeth']);
      return panel('clipboard', 'Oral surgery consent — tooth number(s)',
        el('p', { class: 'subtle small', style: 'margin:0 0 8px' }, ['Specify the tooth/teeth covered by the signed oral-surgery consent.']),
        el('div', { class: 'field-row' }, [
          el('label', { class: 'field', style: 'flex:1;margin:0' }, [el('span', { class: 'field-label' }, ['Tooth number(s)']), teethInput]),
          locked ? null : el('div', { style: 'display:flex;align-items:flex-end' }, [saveBtn]),
        ]),
        amended,
      );
    }

    /* ---------- F15: show only relevant treatment sections per triage checklist ---------- */
    const cl = tr.checklist || {};
    const hasChecklist = ['cleaning', 'extraction', 'filling'].some((k) => cl[k]);
    // When a checklist exists, only show the indicated panels; otherwise show all.
    const relevant = { filling: !hasChecklist || !!cl.filling, extraction: !hasChecklist || !!cl.extraction, cleaning: !hasChecklist || !!cl.cleaning };
    let showAllSections = !hasChecklist;
    const visible = (k) => showAllSections || relevant[k];
    // Panels are always built (so edits are never lost); F15 only toggles display.
    const sectionPanels = {};
    const applySectionVisibility = () => {
      ['filling', 'extraction', 'cleaning'].forEach((k) => {
        if (sectionPanels[k]) sectionPanels[k].style.display = visible(k) ? '' : 'none';
      });
    };

    /* ---------- F13: quadrant zoom buttons (focus the odontogram on a quadrant) ---------- */
    function quadZoomBar() {
      const mk = (q, label) => el('button', { class: 'btn btn--soft btn--sm', type: 'button', onClick: () => odo.setQuadrant(q) }, [label]);
      return el('div', { class: 'chip-row', style: 'margin-bottom:8px;align-items:center' }, [
        el('span', { class: 'field-label', style: 'margin-right:4px' }, ['Zoom']),
        ...QUADRANTS.map(([q, l]) => mk(q, l)),
        mk('all', 'All'),
      ]);
    }

    /* ---------- F14: bulk-clean a whole quadrant (hygienist) ---------- */
    function bulkCleanControl() {
      if (locked) return null;
      let quad = 'UR';
      const quadSel = el('select', { class: 'input input--sm', style: 'max-width:120px', onChange: (e) => { quad = e.target.value; } },
        QUADRANTS.map(([q, l]) => el('option', { value: q }, [l])));
      const markQuad = el('button', { class: 'btn btn--soft btn--sm', type: 'button', onClick: () => {
        const ids = odo.quadrantIds(quad);
        if (!ids.length) { toast('No teeth in that quadrant for this dentition.', 'info'); return; }
        odo.bulkTag(ids, 'cleaning');
        toast(`${ids.length} tooth/teeth marked cleaned (${quad})`, 'success');
      } }, [icon('checkCircle', { size: 15 }), 'Mark quadrant cleaned']);
      const markAll = el('button', { class: 'btn btn--soft btn--sm', type: 'button', onClick: () => {
        const ids = ['UR', 'UL', 'LR', 'LL'].flatMap((q) => odo.quadrantIds(q));
        if (!ids.length) { toast('No teeth visible to mark.', 'info'); return; }
        odo.bulkTag(ids, 'cleaning');
        toast(`${ids.length} tooth/teeth marked cleaned (all)`, 'success');
      } }, [icon('checkCircle', { size: 15 }), 'Mark all visible cleaned']);
      return el('div', { class: 'chip-row', style: 'margin-bottom:10px;align-items:center' }, [
        el('span', { class: 'field-label', style: 'margin-right:4px' }, ['Bulk cleaning']),
        quadSel, markQuad, markAll,
      ]);
    }

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
      // F12: blood thinners get their own prominent danger banner above other flags.
      thinnerFlags.length ? el('div', { class: 'banner banner--alert' }, [
        icon('alert', { size: 16 }),
        el('div', {}, [
          el('strong', {}, ['BLOOD THINNER — confirm before extraction']),
          el('div', { class: 'chip-row', style: 'margin-top:6px' }, thinnerFlags.map((f) =>
            el('span', { class: 'pill pill--danger' }, [icon('alert', { size: 12 }), f.replace(/^Blood thinner:\s*/, '')]))),
        ]),
      ]) : null,
      flags.length ? el('div', { class: 'banner banner--alert' }, [icon('flag', { size: 16 }), 'Medical flags: ' + flags.join(' · ')]) : null,
      locked ? el('div', { class: 'banner banner--locked' }, [icon('lock', { size: 16 }), 'This record is signed off and locked. View or export below.']) : null,

      // F20: accountability — who triaged / took vitals / signed off, with timestamps.
      accountabilityCard(p, tr, tx),

      // Full patient history — collapsible reference data, CLOSED by default to
      // keep actionable treatment leading the chart.
      el('details', { class: 'history-details', style: 'margin-bottom:var(--space-4)' }, [
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

      // The mouth — with F13 quadrant zoom buttons above the chart.
      panel('tooth', 'Odontogram — tap teeth of concern', quadZoomBar(), odo.node),

      // F10: oral-surgery consent tooth numbers (only when such a consent exists).
      consentTeethPanel(),

      // F15: only relevant treatment sections are shown; a toggle reveals all.
      hasChecklist ? el('div', { class: 'chip-row', style: 'margin:4px 0 12px' }, [
        el('span', { class: 'subtle small' }, ['Showing sections indicated by triage.']),
        toggleChip('Show all sections', showAllSections, (on) => { showAllSections = on; applySectionVisibility(); }, false),
      ]) : null,

      // LEAD WITH RELEVANT WORK — the treatment the patient needs (fillings /
      // extractions) is the prominent first thing after the odontogram. F15's
      // applySectionVisibility() still hides non-indicated panels.
      (sectionPanels.filling = panel('pen', 'Fillings',
        fillingRows,
        locked ? null : softBtn('plus', 'Add filling', () => { addFilling(); refreshMarks(); }))),
      (sectionPanels.extraction = panel('tooth', 'Extractions',
        extractRows,
        locked ? null : softBtn('plus', 'Add extraction', () => { addExtraction(); refreshMarks(); }),
        el('div', { class: 'field-row', style: 'margin-top:10px' }, [
          el('label', { class: 'field', style: 'flex:1;margin:0' }, [el('span', { class: 'field-label' }, ['Other']), extOther]),
          el('label', { class: 'field', style: 'margin:0;max-width:90px' }, [el('span', { class: 'field-label' }, ['Tooth #']), extOtherTooth]),
        ]))),

      // Anesthetic supports the extractions/fillings above — kept adjacent.
      panel('syringe', 'Anesthetic administered', anesGrid),

      // DEMOTED: cleaning belongs to the hygienist. Rendered inside a lightly
      // styled <details> that is CLOSED unless triage flagged a cleaning, so it
      // never competes with the doctor's extractions/fillings. Still fully
      // functional (incl. the bulk-clean control) when opened.
      (sectionPanels.cleaning = el('details', {
        class: 'card',
        style: 'padding:0;overflow:hidden;margin-bottom:var(--space-4)',
        ...(relevant.cleaning ? { open: 'open' } : {}),
      }, [
        el('summary', {
          class: 'card-title',
          style: 'cursor:pointer;list-style:none;padding:var(--space-3) var(--space-4);margin:0',
        }, [icon('checkCircle', { size: 15 }), 'Cleaning (usually done by the hygienist)']),
        el('div', { style: 'padding:0 var(--space-4) var(--space-4)' }, [bulkCleanControl(), cleaning]),
      ])),

      // X-rays — provider can add/view (user priority)
      panel('xray', 'X-rays', gallery, fileInput),

      panel('clipboard', 'Notes',
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Other procedure']), otherProc.node]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Dental notes']), dentalNotes.node])),

      // Patient summary — reference data, DEMOTED into a closed <details> so the
      // chart leads with treatment, not reference data.
      el('details', { class: 'card', style: 'padding:0;overflow:hidden;margin-bottom:var(--space-4)' }, [
        el('summary', { class: 'card-title', style: 'cursor:pointer;list-style:none;padding:var(--space-3) var(--space-4);margin:0' }, [icon('user', { size: 15 }), 'Patient summary']),
        el('div', { class: 'mini-hist', style: 'padding:0 var(--space-4) var(--space-4)' }, [
          el('div', {}, [el('b', {}, ['Allergies: ']), (allergies().filter((a) => (p.medical_history.allergies || []).includes(a.key)).map((a) => a.label).join(', ') || 'None')]),
          el('div', {}, [el('b', {}, ['Conditions: ']), (conditions().filter((c) => (p.medical_history.conditions || []).includes(c.key)).map((c) => c.label).join(', ') || 'None')]),
          el('div', {}, [el('b', {}, ['Medications: ']), (p.medical_history.medications || []).map((m) => m.name).join(', ') || 'None']),
          el('div', {}, [el('b', {}, ['Consent: ']), (p.consents || []).some((c) => c.type === 'general') ? 'Signed' : 'Missing']),
        ]),
      ]),

      // Provider sign-off + export.
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
              // F17: patient summary PDF available before sign-off (doctor/admin only).
              store.can('admin', 'doctor')
                ? el('button', { class: 'btn btn--ghost btn--block', type: 'button', onClick: async () => {
                    try { const r = await api.pdfGenerate(id, 'summary'); if (r && r.saved) toast(`Saved: ${r.path}`, 'success'); }
                    catch (e) { toast(e.message, 'error'); }
                  } }, [icon('user', { size: 16 }), 'Patient summary PDF'])
                : null,
            ])),
    );
    applySectionVisibility();
    refreshMarks();
  }
}

/* ---------------- F20: accountability card ---------------- */
// Who took vitals / triaged / signed off, with timestamps. Also surfaces the
// authoritative vitals (staff triage columns preferred, intake self-report as fallback).
function accountabilityCard(p, tr, tx) {
  tr = tr || {};
  tx = tx || {};
  const lines = [];
  const line = (ic, label, name, when) => {
    if (!name && !when) return;
    lines.push(el('div', { class: 'kv' }, [
      el('span', { class: 'kv-k' }, [icon(ic, { size: 13 }), ' ', label]),
      el('span', { class: 'kv-v' }, [`${name || '—'}${when ? ' · ' + fmtWhen(when) : ''}`]),
    ]));
  };
  // Vitals reader: prefer authoritative triage vitals, else intake self-report.
  const mh = p.medical_history || {};
  const sys = tr.bp_systolic != null ? tr.bp_systolic : mh.bp_systolic;
  const dia = tr.bp_diastolic != null ? tr.bp_diastolic : mh.bp_diastolic;
  const hr = tr.heart_rate != null ? tr.heart_rate : mh.heart_rate;
  const fromTriage = tr.bp_systolic != null || tr.bp_diastolic != null || tr.heart_rate != null;
  const vitalsStr = [];
  if (sys != null || dia != null) vitalsStr.push(`BP ${sys != null ? sys : '—'}/${dia != null ? dia : '—'}`);
  if (hr != null) vitalsStr.push(`HR ${hr}`);

  line('user', 'Triaged by', p.triaged_by_name, tr.triaged_at);
  line('syringe', 'Vitals by', p.vitals_by_name, tr.vitals_at);
  line('pen', 'Signed off by', p.completed_by_name, tx.completed_at);
  if (p.dismissed_by_name || p.dismissed_at) line('checkCircle', 'Checked out by', p.dismissed_by_name, p.dismissed_at);

  if (!lines.length && !vitalsStr.length) return null;
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Accountability']),
    vitalsStr.length ? el('div', { class: 'chip-row', style: 'margin-bottom:10px' }, [
      el('span', { class: 'pill pill--info' }, [icon('syringe', { size: 12 }), `${t('intake.vitalsTitle')}: ${vitalsStr.join(' · ')}`]),
      el('span', { class: 'subtle small' }, [fromTriage ? '(staff-measured)' : '(patient self-report)']),
    ]) : null,
    lines.length ? el('div', { class: 'kv-grid' }, lines) : null,
  ]);
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
  // Export/print/PDF are admin+doctor only — keep the shared component safe to
  // reuse in any view (defensive; matches the IPC permission).
  if (!store.can('admin', 'doctor')) return el('span', { class: 'subtle small' }, ['Export requires a doctor or admin account.']);
  const run = async (fn) => {
    try { const r = await fn(); if (r && r.saved) ctx.toast(`Saved: ${r.path}`, 'success'); else if (r && r.printed) ctx.toast('Sent to printer', 'success'); }
    catch (e) { ctx.toast(e.message, 'error'); }
  };
  return el('div', { class: 'action-stack', style: 'margin-top:12px' }, [
    el('button', { class: 'btn btn--primary btn--block', onClick: () => run(() => api.pdfGenerate(id, 'progress')) }, [icon('save', { size: 16 }), 'Progress Note PDF']),
    el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfGenerate(id, 'full')) }, [icon('clipboard', { size: 16 }), 'Full Record PDF']),
    // F17: one-page patient summary PDF.
    el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfGenerate(id, 'summary')) }, [icon('user', { size: 16 }), 'Patient summary PDF']),
    el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfPrint(id, 'full')) }, [icon('print', { size: 16 }), 'Print']),
    el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.exportRecordUsb(id)) }, [icon('upload', { size: 16 }), 'Save to patient USB']),
  ]);
}
