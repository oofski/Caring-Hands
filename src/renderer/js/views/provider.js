import { el, clear, mount, toast, modal } from '../dom.js';
import { t, conditions, allergies } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { SignaturePad } from '../components/signature.js';
import { Odontogram } from '../components/odontogram.js';
import { patientHistoryCards, incompleteBanner } from '../components/patientHistory.js';
import { sortedByName } from '../patientSort.js';
import { store } from '../store.js';
import { statusPill } from './dashboard.js';
import { bloodThinnerStatus, bloodThinnerText, bpStatus } from '../medFlags.js';

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

export function renderProvider(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    ctx.setDetail && ctx.setDetail(false);
    const patients = await api.listPatients({});
    const ready = patients.filter((p) => ['triaged', 'in_treatment'].includes(p.status));
    // EMT routing: 'dentist' and 'both' belong here; route null = legacy rows
    // (pre-routing data) which default to the dentist. Patients routed only to
    // the hygienist wait in a collapsed list below — they may come back later.
    const dentistQueue = sortedByName(ready.filter((p) => p.route === 'dentist' || p.route === 'both' || p.route == null));
    const atHygienist = sortedByName(ready.filter((p) => p.route === 'hygienist'));
    const row = (p) => el('tr', {}, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        p.on_thinner ? el('span', { class: 'pill pill--danger', style: 'margin-left:8px' }, ['Blood thinner']) : null,
        (p.flags && p.flags.length) ? flagDot(p.flags.length) : null]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [p.assigned_to || '—']),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [chevronBtn('Treat', () => detail(p.id))]),
    ]);
    const table = (list, emptyMsg) => el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Chair', 'Status', ''].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, list.length ? list.map(row) : [el('tr', {}, [el('td', { colspan: 6, class: 'empty' }, [emptyMsg])])]),
      ]),
    ]);
    mount(root,
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, [t('nav.provider')]), el('p', { class: 'view-sub' }, [`${dentistQueue.length} patient(s) in the dentist queue — patients arrive here once the EMT station records vitals and routes them`])]),
        ghostBtn('refresh', 'Refresh', queue),
      ]),
      el('div', { class: 'card' }, [table(dentistQueue, 'No patients in the dentist queue yet — the EMT station sends patients here after vitals.')]),
      atHygienist.length ? el('details', { class: 'collapse' }, [
        el('summary', {}, [`At the hygienist (${atHygienist.length})`]),
        el('div', { class: 'collapse-body' }, [table(atHygienist, '')]),
      ]) : null,
    );
  }

  async function detail(id) {
    ctx.setDetail && ctx.setDetail(true);
    const p = await api.getPatient(id);
    const tr = p.triage || {};
    const tx = p.treatment || {};
    const locked = tx.locked;
    // D2: shared tooth-number datalist so providers can quick-pick a tooth
    // (permanent 1–32 + primary A–T) instead of typing it.
    const TEETH_LIST_ID = 'tooth-quickpick-list';
    const teethDatalist = el('datalist', { id: TEETH_LIST_ID },
      [...Array.from({ length: 32 }, (_, i) => String(i + 1)), ...'ABCDEFGHIJKLMNOPQRST'.split('')]
        .map((n) => el('option', { value: n })));
    let xrays = await api.listXrays(id);
    const priorVisits = await api.patientHistory(id).catch(() => []);

    // medical flags
    // Blood thinners get their own dedicated danger banner + vitals-strip line, so
    // exclude that condition here to avoid saying it three different ways.
    const flagConds = conditions().filter((c) => c.flag && c.key !== 'blood_thinners' && (p.medical_history.conditions || []).includes(c.key)).map((c) => c.label);
    const flagAllergies = allergies().filter((a) => (p.medical_history.allergies || []).includes(a.key)).map((a) => `Allergy: ${a.label}`);
    if (p.medical_history.pregnancy === 'yes') flagConds.push('Pregnant');
    const flags = [...flagConds, ...flagAllergies];
    // F12: blood-thinner detection — combine the EMT-confirmed triage answer
    // (triage.blood_thinner) with medication auto-detection so the danger banner
    // reflects both, not just the medication list (v1.2 bugfix).
    const thinnerStatus = bloodThinnerStatus(p);

    /* ---------- EMT vitals + routing strip (read-only) ---------- */
    // Compact one-line summary of what the EMT station recorded before sending
    // the patient here. Rendered only when vitals or a route exist.
    function vitalsStrip() {
      const hasVitals = tr.bp_systolic != null || tr.bp_diastolic != null || tr.heart_rate != null;
      if (!hasVitals && !tr.route) return null;
      // BP renders as its own element so a hypertensive-crisis reading (systolic
      // over 180 or diastolic over 100) shows RED here, same as the EMT screen.
      const bp = bpStatus(tr.bp_systolic, tr.bp_diastolic);
      const bpEl = (tr.bp_systolic != null || tr.bp_diastolic != null)
        ? el('span', { class: bp.high ? 'pill pill--danger' : 'small' }, [
            bp.high ? el('span', { class: 'pill-dot' }) : null,
            `BP ${tr.bp_systolic != null ? tr.bp_systolic : '—'}/${tr.bp_diastolic != null ? tr.bp_diastolic : '—'}${bp.high ? ' — HIGH' : ''}`,
          ])
        : null;
      // Any BP re-checks the EMT recorded (shown red if still high).
      const recheckEls = (Array.isArray(tr.bp_rechecks) ? tr.bp_rechecks : []).map((r) => {
        const st = bpStatus(r.bp_systolic, r.bp_diastolic);
        return el('span', { class: st.high ? 'pill pill--danger' : 'small' }, [
          st.high ? el('span', { class: 'pill-dot' }) : null,
          `re-check ${r.bp_systolic != null ? r.bp_systolic : '—'}/${r.bp_diastolic != null ? r.bp_diastolic : '—'}${st.high ? ' — HIGH' : ''}`,
        ]);
      });
      const rest = [];
      if (tr.heart_rate != null) rest.push(`HR ${tr.heart_rate}`);
      if (p.vitals_by_name) rest.push(`recorded by ${p.vitals_by_name}`);
      // Blood-thinner wording comes from the ONE shared helper so it always
      // matches the danger banner and every other screen (no "No" vs "Yes" mismatch).
      const bt = bloodThinnerText(p);
      return el('div', { class: 'card', style: 'display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-3);padding:var(--space-3) var(--space-4)' }, [
        icon('syringe', { size: 14 }),
        bpEl,
        ...recheckEls,
        rest.length ? el('span', { class: 'small' }, [rest.join(' · ')]) : null,
        el('span', { class: bt.level === 'danger' ? 'pill pill--danger' : 'subtle small' }, [bt.text]),
        tr.route ? el('span', { class: 'subtle small' }, [p.routed_by_name ? `Sent here by ${p.routed_by_name}` : 'Routed by the EMT station']) : null,
      ]);
    }

    /* ---------- Visit row (paper: top of sheet) ---------- */
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

    // D2: a compact tooth field — datalist autocomplete + tap-friendly +/- steppers,
    // with manual typing preserved. onChange fires on every value change.
    function toothField(value, onChange) {
      const cb = typeof onChange === 'function' ? onChange : () => {};
      const inp = el('input', { class: 'input input--sm num', list: TEETH_LIST_ID, inputmode: 'numeric', placeholder: 'Tooth #', value: value || '', onInput: () => cb() });
      if (locked) { inp.disabled = true; return { node: inp, input: inp }; }
      const step = (delta) => {
        const cur = parseInt(inp.value, 10);
        let next = isNaN(cur) ? (delta > 0 ? 1 : 32) : cur + delta;
        next = Math.max(1, Math.min(32, next));
        inp.value = String(next);
        cb();
      };
      const stepBtn = (label, delta, title) => el('button', { type: 'button', class: 'btn btn--soft btn--sm', style: 'min-width:28px;padding:0', title, onClick: () => step(delta) }, [label]);
      const node = el('div', { style: 'display:flex;gap:4px;align-items:center' }, [inp, stepBtn('−', -1, 'Previous tooth'), stepBtn('+', 1, 'Next tooth')]);
      return { node, input: inp };
    }

    /* ---------- Fillings ---------- */
    const fillingRows = el('div', { class: 'tx-rows' });
    function addFilling(f = {}, auto = false) {
      const toothF = toothField(f.tooth, () => refreshMarks());
      const tooth = toothF.input;
      const surf = new Set((f.surfaces || []).map(String));
      const surfWrap = el('div', { class: 'surface-pills' }, ['1', '2', '3', '4'].map((n) =>
        el('button', { type: 'button', class: 'surf-chip' + (surf.has(n) ? ' surf-chip--on' : ''), onClick: (e) => { if (locked) return; if (surf.has(n)) surf.delete(n); else surf.add(n); e.currentTarget.classList.toggle('surf-chip--on'); } }, [n])));
      let ant = !!f.ant, post = !!f.post;
      const antBtn = toggleChip('Ant', ant, (on) => { ant = on; }, locked);
      const postBtn = toggleChip('Post', post, (on) => { post = on; }, locked);
      const noteChip = el('span', { class: 'tx-note' + (f.note ? '' : ' hidden') }, [f.note || '']);
      const row = el('div', { class: 'filling-row', style: 'grid-template-columns:160px auto auto auto' }, [
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Tooth #']), toothF.node]),
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
      const toothF = toothField(x.tooth, () => refreshMarks());
      const tooth = toothF.input;
      const types = new Set(x.types || []);
      const typeChips = EXTRACTION_TYPES.map(([k, label]) =>
        toggleChip(label, types.has(k), (on) => { if (on) types.add(k); else types.delete(k); }, locked));
      const noteChip = el('span', { class: 'tx-note' + (x.note ? '' : ' hidden') }, [x.note || '']);
      const row = el('div', { class: 'ext-row' }, [
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { class: 'field-label' }, ['Tooth #']), toothF.node]),
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
    const extOtherTooth = el('input', { class: 'input input--sm num', list: TEETH_LIST_ID, inputmode: 'numeric', placeholder: 'Tooth #', value: otherExisting.tooth || '' });

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

    /* ---------- Anesthetic (D4): discrete per-tooth administrations ---------- */
    // Each administration records agent, carpules, location and a TOOTH NUMBER, so
    // multiple entries are captured (e.g. #14 1.5 carps buccal; #30 1 carp lingual).
    // Saved as an ARRAY (see collectTreatment); legacy object-keyed data is parsed
    // on load so prior records pre-fill correctly.
    const ANES_AGENTS = [
      ['lidocaine', 'Lidocaine 2%'],
      ['articaine', 'Articaine 4%'],
      ['other', 'Other'],
    ];
    const anesRows = el('div', { class: 'tx-rows' });
    function anesFromStored(stored) {
      const known = (k) => ['lidocaine', 'articaine', 'other'].includes(k);
      if (Array.isArray(stored)) {
        return stored.map((a) => ({
          agent: known(a.agent) ? a.agent : 'other',
          carps: a.carps != null ? String(a.carps) : '',
          location: a.location || '',
          tooth: a.tooth != null ? String(a.tooth) : '',
          name: a.name || (known(a.agent) ? '' : (a.agent || '')),
        }));
      }
      // Legacy object shape keyed by agent: { lidocaine:{carps,location,tooth?}, other:{name,...} }.
      return Object.entries(stored || {}).map(([k, v]) => {
        v = v || {};
        return {
          agent: known(k) ? k : 'other',
          carps: v.carps != null ? String(v.carps) : '',
          location: v.location || '',
          tooth: v.tooth != null ? String(v.tooth) : '',
          name: v.name || (known(k) ? '' : k),
        };
      });
    }
    function addAnes(a = {}) {
      const agent = ['lidocaine', 'articaine', 'other'].includes(a.agent) ? a.agent : 'lidocaine';
      const agentSel = el('select', { class: 'input input--sm' }, ANES_AGENTS.map(([k, l]) =>
        el('option', { value: k, selected: k === agent }, [l])));
      const nameInput = el('input', { class: 'input input--sm', placeholder: 'Agent name', value: a.name || '', style: agent === 'other' ? '' : 'display:none' });
      agentSel.addEventListener('change', () => { nameInput.style.display = agentSel.value === 'other' ? '' : 'none'; });
      const carps = el('input', { class: 'input input--sm num', type: 'number', min: '0', step: '0.5', placeholder: 'Carps', value: a.carps || '' });
      const toothF = toothField(a.tooth, null);
      const loc = el('input', { class: 'input input--sm', placeholder: 'e.g. buccal', value: a.location || '' });
      if (locked) { agentSel.disabled = true; nameInput.disabled = true; carps.disabled = true; loc.disabled = true; }
      const fieldCol = (label, node) => el('label', { class: 'field', style: 'margin:0' }, [el('span', { class: 'field-label' }, [label]), node]);
      const row = el('div', { class: 'anes-admin-row', style: 'display:grid;grid-template-columns:1.3fr 76px 168px 1.1fr auto;gap:8px;align-items:end;padding:8px;border:var(--border-line);border-radius:var(--radius-sm);background:var(--surface);margin-bottom:7px' }, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { class: 'field-label' }, ['Agent']),
          el('div', { style: 'display:flex;flex-direction:column;gap:4px' }, [agentSel, nameInput]),
        ]),
        fieldCol('Carps', carps),
        fieldCol('Tooth #', toothF.node),
        fieldCol('Location', loc),
        locked ? el('span') : iconBtn('x', () => { row.remove(); }),
      ]);
      row._get = () => {
        const ag = agentSel.value;
        return { agent: ag, carps: carps.value.trim(), location: loc.value.trim(), tooth: toothF.input.value.trim(), name: ag === 'other' ? nameInput.value.trim() : '' };
      };
      anesRows.append(row);
    }
    anesFromStored(tx.anesthetic).forEach((a) => addAnes(a));
    if (!anesRows.children.length && !locked) addAnes({ agent: 'lidocaine' });

    /* ---------- Notes ---------- */
    const otherProc = textarea(tx.other_procedures || '', 'Other procedure', 2, locked);
    const dentalNotes = textarea(tx.clinical_notes || '', 'Dental notes', 4, locked);

    /* ---------- X-ray panel ---------- */
    const gallery = el('div', { class: 'xray-gallery' });
    const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
    // Auto-name imported/attached x-rays after the patient: Lastname_Firstname,
    // with the quadrant/tooth appended when chosen (e.g. Smith_John_UR_14).
    const xrayBase = [(p.last_name || '').trim(), (p.first_name || '').trim()].filter(Boolean).join('_').replace(/\s+/g, '') || 'patient';

    // Re-encode any renderable image to a JPEG data URL (canvas). Already-JPEG
    // images pass through untouched; PNG/BMP and images extracted from a .dex are
    // converted so the chart always stores a .jpg, as requested.
    function toJpegDataUrl(dataUrl) {
      if (/^data:image\/jpe?g/i.test(dataUrl || '')) return Promise.resolve(dataUrl);
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
            if (!c.width || !c.height) { resolve(dataUrl); return; }
            const cx = c.getContext('2d');
            cx.fillStyle = '#000'; cx.fillRect(0, 0, c.width, c.height);
            cx.drawImage(img, 0, 0);
            resolve(c.toDataURL('image/jpeg', 0.92));
          } catch (_) { resolve(dataUrl); }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      });
    }

    function renderGallery() {
      clear(gallery);
      xrays.forEach((x) => {
        const toothLabel = x.tooth ? `Tooth ${x.tooth}` : (locked ? (x.station ? `St ${x.station}` : '—') : 'Set tooth');
        const toothEl = locked
          ? el('span', {}, [toothLabel])
          : el('span', { class: 'xray-tooth-set' + (x.tooth ? '' : ' subtle'), style: 'cursor:pointer;text-decoration:underline', title: 'Assign this x-ray to a tooth', onClick: (e) => { e.stopPropagation(); setToothFor(x); } }, [toothLabel]);
        const card = el('div', { class: 'xray-card' }, [
          el('img', { src: x.image_png, alt: 'x-ray', title: x.note || 'View x-ray', onClick: () => viewXray(x) }),
          el('div', { class: 'xray-card-meta' }, [toothEl, el('span', {}, [`#${x.id}`])]),
          locked ? null : el('button', { class: 'xray-del', title: 'Delete x-ray', onClick: async (e) => { e.stopPropagation(); await delXray(x.id); } }, [icon('trash', { size: 14 })]),
        ]);
        gallery.append(card);
      });
      if (!locked) {
        gallery.append(el('div', { class: 'xray-add xray-add--primary', title: 'Upload an x-ray image (JPG) and label it', onClick: () => fileInput.click() }, [
          icon('upload', { size: 22 }),
          el('span', {}, ['Add X-ray']),
          el('span', { class: 'subtle', style: 'font-size:var(--fs-2xs);font-weight:var(--fw-medium)' }, ['upload a JPG — or drag it here']),
        ]));
      }
      if (!xrays.length && locked) gallery.append(el('span', { class: 'subtle' }, ['No x-rays on file.']));
      xrayCountEl.lastChild.textContent = String(xrays.length);
    }

    // Assign / change the tooth an x-ray belongs to.
    async function setToothFor(x) {
      const inp = el('input', { class: 'input', list: TEETH_LIST_ID, inputmode: 'numeric', placeholder: 'Tooth # (1–32 or A–T)', value: x.tooth || '' });
      const ok = await modal({ title: `Assign tooth — x-ray #${x.id}`, body: el('div', {}, [el('p', { class: 'subtle small', style: 'margin:0 0 8px' }, ['Enter the tooth this x-ray shows (leave blank to clear).']), inp]), confirmText: 'Save', cancelText: 'Cancel' });
      if (!ok) return;
      try { await api.setXrayTooth(x.id, inp.value.trim()); xrays = await api.listXrays(id); renderGallery(); toast('Tooth assigned', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    }

    // Upload an X-ray image (a JPG the doctor exported from DEXIS), then show a
    // clean centered form: is it a specific TOOTH (type the number), a QUADRANT,
    // or a GENERAL film? Save files it to the chart named
    // Lastname_Firstname_<answer>.jpg, then deletes the source file from the
    // computer's drive so the folder stays clean.
    const XRAY_AREAS = [['UR', 'Upper right (UR)'], ['UL', 'Upper left (UL)'], ['LR', 'Lower right (LR)'], ['LL', 'Lower left (LL)'], ['FM', 'Full mouth']];
    function presentXrayForm(dataUrl, srcPath, displayName) {
      return new Promise((resolve) => {
        const overlay = el('div', { class: 'modal-overlay' });
        const card = el('div', { class: 'modal-card xray-form-card' });
        const done = (v) => { overlay.remove(); resolve(v); };

        let mode = 'tooth';
        const toothInput = el('input', { class: 'input', list: TEETH_LIST_ID, inputmode: 'numeric', placeholder: 'Tooth # (1-32 or A-T)' });
        const areaSel = el('select', { class: 'input' }, XRAY_AREAS.map(([v, l]) => el('option', { value: v }, [l])));
        const extra = el('div', { class: 'xray-form-extra' });
        const nameEl = el('span', { class: 'xray-form-name' }, []);

        const label = () => {
          if (mode === 'tooth') { const tstr = toothInput.value.trim(); return xrayBase + '_T' + (tstr || '?'); }
          if (mode === 'quadrant') return xrayBase + '_' + areaSel.value;
          return xrayBase + '_General';
        };
        const refreshName = () => { nameEl.textContent = label() + '.jpg'; };

        const OPTS = [['tooth', 'Tooth', 'A specific tooth'], ['quadrant', 'Quadrant', 'An area of the mouth'], ['general', 'General', 'Full / other film']];
        const optBtns = {};
        const optRow = el('div', { class: 'xray-form-opts' });
        OPTS.forEach(([v, title, sub]) => {
          const b = el('button', { type: 'button', class: 'xray-opt' + (v === mode ? ' is-on' : ''), onClick: () => { mode = v; sync(); } }, [
            el('span', { class: 'xray-opt-title' }, [title]),
            el('span', { class: 'xray-opt-sub' }, [sub]),
          ]);
          optBtns[v] = b; optRow.append(b);
        });
        function sync() {
          Object.keys(optBtns).forEach((v) => optBtns[v].classList.toggle('is-on', v === mode));
          clear(extra);
          if (mode === 'tooth') extra.append(el('label', { class: 'field', style: 'margin:0' }, [el('span', { class: 'field-label' }, ['Tooth number']), toothInput]));
          else if (mode === 'quadrant') extra.append(el('label', { class: 'field', style: 'margin:0' }, [el('span', { class: 'field-label' }, ['Which quadrant?']), areaSel]));
          refreshName();
        }
        toothInput.addEventListener('input', refreshName);
        areaSel.addEventListener('change', refreshName);

        const saveBtn = el('button', { class: 'btn btn--primary', type: 'button' }, [icon('check', { size: 16 }), 'Save X-ray']);
        saveBtn.addEventListener('click', async () => {
          if (mode === 'tooth' && !toothInput.value.trim()) { toast('Enter the tooth number, or pick Quadrant / General.', 'error'); toothInput.focus(); return; }
          saveBtn.disabled = true;
          try {
            const jpeg = await toJpegDataUrl(dataUrl);
            const tooth = mode === 'tooth' ? toothInput.value.trim() : '';
            await api.addXray({ patientId: id, image_png: jpeg, note: label() + '.jpg', tooth, station: station.input ? station.input.value.trim() : '' });
            xrays = await api.listXrays(id); renderGallery();
            let removed = false;
            if (srcPath) { try { await api.deleteDiskFile(srcPath); removed = true; } catch (_) { /* best-effort */ } }
            toast(removed ? 'X-ray saved - removed from the drive' : 'X-ray saved', 'success');
            done(true);
          } catch (e) { saveBtn.disabled = false; toast(e.message, 'error'); }
        });
        const cancelBtn = el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => done(false) }, ['Cancel']);

        card.append(
          el('h3', { class: 'modal-title' }, ['Add X-ray']),
          el('div', { class: 'modal-body' }, [
            el('img', { class: 'xray-form-preview', src: dataUrl, alt: displayName || 'x-ray' }),
            el('p', { class: 'xray-form-q' }, ['What does this X-ray show?']),
            optRow,
            extra,
            el('div', { class: 'xray-form-nameline' }, ['Saves as ', nameEl]),
          ]),
          el('div', { class: 'modal-actions' }, [cancelBtn, saveBtn]),
        );
        overlay.append(card);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
        document.body.append(overlay);
        sync();
      });
    }

    // File picker / drag-drop -> for each image, show the labelling form (which
    // files it to the chart and clears the source from the drive). Multiple
    // files are handled one at a time.
    async function addXrayFiles(fileList) {
      const files = Array.from(fileList || []).filter((f) => f && (!f.type || f.type.startsWith('image/')));
      if (!files.length) { toast('Please choose an image file (JPG / PNG).', 'info'); return; }
      for (const file of files) {
        const dataUrl = await new Promise((res) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.onerror = () => res(null);
          reader.readAsDataURL(file);
        });
        if (!dataUrl) { toast('Could not read that file.', 'error'); continue; }
        // Electron exposes the real on-disk path on File objects; we use it to
        // delete the source after it is filed to the chart.
        await presentXrayForm(dataUrl, file.path || '', file.name);
      }
    }
    fileInput.addEventListener('change', async () => { await addXrayFiles(fileInput.files); fileInput.value = ''; });
    // Drag-and-drop an image file straight onto the gallery.
    if (!locked) {
      const setDrag = (on) => { gallery.style.outline = on ? '2px dashed var(--accent)' : ''; gallery.style.outlineOffset = on ? '4px' : ''; };
      gallery.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; setDrag(true); });
      gallery.addEventListener('dragleave', (e) => { if (e.target === gallery) setDrag(false); });
      gallery.addEventListener('drop', async (e) => {
        e.preventDefault(); setDrag(false);
        const dropped = e.dataTransfer ? e.dataTransfer.files : null;
        if (dropped && dropped.length) await addXrayFiles(dropped);
      });
    }
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
    // Pre-filled from whoever is signed in, so requiring it costs a glance
    // rather than a re-type.
    const providerName = el('input', { class: 'input', placeholder: 'Printed name', value: tx.provider_name || (store.user && store.user.full_name) || '' });
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

    /* ---------- Chairside consent capture ---------- */
    // Sometimes a patient wanted a filling but the dentist recommends an extraction,
    // so the oral-surgery consent wasn't signed at check-in. The dentist can have the
    // patient complete it here — with the tooth number(s) — before treating. Also
    // used to capture a general consent the intake missed (gates treatment below).
    async function captureConsent(type) {
      const isSurgery = type === 'oral_surgery';
      const paras = isSurgery ? t('consent.oralSurgeryFull') : t('consent.generalFull');
      const list = Array.isArray(paras) ? paras : [paras];
      const textBox = el('div', { style: 'max-height:40vh;overflow:auto;border:var(--border-line);border-radius:var(--radius-sm);padding:var(--space-3);background:var(--surface);margin-bottom:var(--space-3)' },
        list.map((para, i) => el('p', { style: 'margin:0 0 var(--space-2);font-size:var(--fs-sm)' }, [isSurgery ? para : `${i + 1}. ${para}`])));
      const agree = el('input', { type: 'checkbox', class: 'big-check' });
      const signer = el('input', { class: 'input', placeholder: 'Patient / guardian name', value: `${p.first_name || ''} ${p.last_name || ''}`.trim() });
      const teeth = isSurgery ? el('input', { class: 'input', placeholder: 'e.g. 18, 19', value: '' }) : null;
      const sig = SignaturePad();
      const body = el('div', {}, [
        textBox,
        isSurgery ? el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Tooth number(s) for this consent']), teeth]) : null,
        el('label', { class: 'agree-row' }, [agree, el('span', {}, [t('consent.agree')])]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Patient / guardian name']), signer]),
        el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Signature']), sig.node]),
        el('p', { class: 'field-hint' }, ['Signature optional — the patient may sign on the screen or leave it blank.']),
      ]);
      const ok = await modal({ title: isSurgery ? t('consent.surgeryTitle') : t('consent.generalTitle'), body, confirmText: 'Save consent', cancelText: 'Cancel' });
      if (!ok) return;
      if (!agree.checked) { toast('Please check the agreement box to record consent.', 'error'); return; }
      if (!signer.value.trim()) { toast('Enter the patient / guardian name.', 'error'); return; }
      try {
        await api.addConsent(id, {
          type, language: 'en',
          signer_name: signer.value.trim(),
          signature_png: sig.isEmpty() ? null : sig.getDataUrl(),
          tooth_numbers: isSurgery ? teeth.value.trim() : undefined,
        });
        toast('Consent recorded', 'success');
        detail(id);
      } catch (e) { toast(e.message, 'error'); }
    }

    // Consent status + "complete it here" actions, shown right under patient history.
    function consentsPanel() {
      const general = (p.consents || []).find((c) => c.type === 'general');
      const surgery = (p.consents || []).find((c) => c.type === 'oral_surgery');
      const row = (label, c, type) => el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap;padding:var(--space-2) 0' }, [
        el('div', {}, [
          el('strong', {}, [label]),
          c
            ? el('div', { class: 'subtle small' }, [`Signed${c.signer_name ? ' by ' + c.signer_name : ''}${type === 'oral_surgery' && c.tooth_numbers ? ' · teeth ' + c.tooth_numbers : ''}`])
            : el('div', { class: 'subtle small' }, ['Not on file']),
        ]),
        c
          ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Signed'])
          : (locked ? el('span', { class: 'pill pill--neutral' }, ['—'])
            : el('button', { class: 'btn btn--primary btn--sm', type: 'button', onClick: () => captureConsent(type) }, [icon('pen', { size: 14 }), 'Complete now'])),
      ]);
      return el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('pen', { size: 15 }), 'Consents']),
        el('p', { class: 'subtle small', style: 'margin:0' }, ['Have the patient complete any missing consent at the chair. Oral surgery captures the tooth number(s) and signature.']),
        row('General consent', general, 'general'),
        row('Oral surgery consent', surgery, 'oral_surgery'),
      ]);
    }

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
      // D4: anesthetic saved as an ARRAY of per-administration entries.
      const anesthetic = Array.from(anesRows.children)
        .map((r) => r._get())
        .filter((a) => a.carps || a.location || a.tooth || a.name)
        .map((a) => ({ agent: a.agent, carps: a.carps, location: a.location, tooth: a.tooth, ...(a.name ? { name: a.name } : {}) }));
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
        // Checklist chips are gone from the UI (planning now happens here at the
        // dentist), but legacy stored checklists must round-trip untouched.
        checklist: tr.checklist || {},
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

    // v1.2.1: mode is false (save progress), 'complete' (mark the visit done and
    // send the patient onward — record STAYS editable), or 'lock' (optional
    // finalize that locks the record read-only). Nobody has to lock to move a
    // patient through to check-out.
    async function save(mode) {
      // Gate: the dentist can't document treatment until the general consent is on
      // file. Every kiosk check-in already captures it; if it's somehow missing,
      // the Consents panel above lets the patient complete it right here first.
      if (!(p.consents || []).some((c) => c.type === 'general')) {
        toast('The general consent must be completed before documenting treatment — use the Consents panel above.', 'error');
        return;
      }
      const payload = collectTreatment();
      // Every treatment note has to say who performed it — a record that leaves
      // this station unattributed is not a clinical record. Required whenever the
      // visit is finished or locked; a mid-treatment progress save is not blocked.
      if ((mode === 'complete' || mode === 'lock') && !payload.provider_name) {
        toast('Enter the dentist’s printed name — a treatment note has to say who provided the care.', 'error');
        providerName.focus();
        return;
      }
      if (mode === 'lock') {
        if (!payload.provider_signature) { toast('Provider signature is required to lock the record.', 'error'); return; }
        const ok = await modal({ title: 'Lock this record?', body: 'Locking finalizes this record so it can no longer be edited. This is optional — the patient moves to check-out without it. Continue?', confirmText: 'Sign off & lock', cancelText: 'Cancel' });
        if (!ok) return;
      }
      try {
        await api.saveTriage(id, collectTriage());
        await api.saveTreatment(id, payload, mode);
        toast(mode === 'lock' ? 'Record signed off and locked' : mode === 'complete' ? 'Visit complete — sent to check-out' : 'Progress saved', 'success');
        if (mode) ctx.navigate('provider'); else detail(id);
      } catch (e) { toast(e.message, 'error'); }
    }

    // B3: a patient sent to the dentist who only needs a cleaning can be handed
    // to the hygienist queue without leaving this screen.
    async function transferToHygienist() {
      const ok = await modal({ title: 'Transfer to hygienist?', body: 'This moves the patient to the hygienist queue for cleaning. Continue?', confirmText: 'Transfer', cancelText: 'Cancel' });
      if (!ok) return;
      try {
        await api.routePatient(id, 'hygienist');
        toast('Sent to the hygienist queue', 'success');
        ctx.navigate('provider');
      } catch (e) { toast(e.message, 'error'); }
    }

    /* ---------- render ---------- */
    const panel = (ic, title, ...kids) => el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [icon(ic, { size: 15 }), title]), ...kids,
    ]);

    // mount() clears and appends while skipping nulls from the conditional
    // sections below (banners, consent panel, vitals strip).
    mount(root,
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          backBtn(() => ctx.navigate('provider')),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [`${p.age != null ? p.age + ' yrs · ' : ''}${p.gender || ''} · ${p.language === 'es' ? 'Español' : 'English'} · Complaint: ${(tr.complaint) || p.dental_history.reason || '—'}`]),
        ]),
        el('div', { style: 'display:flex;align-items:center;gap:var(--space-3)' }, [
          locked ? el('span', { class: 'pill pill--neutral' }, [icon('lock', { size: 12 }), 'Locked']) : statusPill(p.status),
        ]),
      ]),

      incompleteBanner(p, {
        isAdmin: store.is('admin'),
        // Deleting reaches every station and the cloud, so it asks first — the
        // same confirmation the Records screen has always used.
        onDelete: async () => {
          const ok = await modal({
            title: 'Delete this empty record?',
            body: 'This record has no name and no intake data. Deleting it removes it from this computer, the clinic cloud and every other station. This cannot be undone.',
            confirmText: 'Delete record', cancelText: 'Cancel', danger: true,
          });
          if (!ok) return;
          try { await api.deletePatient(id); toast('Empty record deleted', 'success'); ctx.navigate('provider'); } catch (e) { toast(e.message, 'error'); }
        },
        onNewCheckin: () => ctx.navigate('kiosk'),
      }),
      // F12: blood thinners get their own prominent danger banner above other
      // flags. Driven by the EMT-confirmed answer combined with medication
      // detection (bloodThinnerStatus), not the medication list alone.
      thinnerStatus.onThinner ? el('div', { class: 'banner banner--alert' }, [
        icon('alert', { size: 16 }),
        el('div', {}, [
          el('strong', {}, ['BLOOD THINNER — confirm before extraction']),
          thinnerStatus.names.length ? el('div', { class: 'chip-row', style: 'margin-top:6px' }, thinnerStatus.names.map((n) =>
            el('span', { class: 'pill pill--danger' }, [icon('alert', { size: 12 }), n]))) : null,
        ]),
      ]) : null,
      // EMT station handoff — vitals, blood-thinner answer, who routed the patient.
      vitalsStrip(),
      flags.length ? el('div', { class: 'banner banner--alert' }, [icon('flag', { size: 16 }), 'Medical flags: ' + flags.join(' · ')]) : null,
      locked ? el('div', { class: 'banner banner--locked' }, [icon('lock', { size: 16 }), 'This record is signed off and locked. View or export below.']) : null,

      // F20: accountability — who triaged / took vitals / signed off, with timestamps.
      accountabilityCard(p, tr, tx),

      // D2: shared tooth-number quick-pick source (invisible; referenced by inputs).
      teethDatalist,

      // Full patient history — collapsible reference data, CLOSED by default to
      // keep actionable treatment leading the chart.
      el('details', { class: 'history-details', style: 'margin-bottom:var(--space-4)' }, [
        el('summary', { class: 'history-summary' }, [icon('clipboard', { size: 16 }), 'Patient history', priorVisits.length ? el('span', { class: 'pill pill--info', style: 'margin-left:8px' }, [`${priorVisits.length} prior visit(s)`]) : null]),
        el('div', { class: 'history-grid' }, patientHistoryCards(p, priorVisits)),
      ]),

      // Consents — right under patient history so the dentist can have a missing
      // consent (esp. oral surgery, with tooth numbers) completed at the chair.
      consentsPanel(),

      // Visit bar (paper top row) — the dentist is the planning hub now.
      panel('clipboard', 'Visit & treatment plan',
        el('div', { class: 'field-row', style: 'margin-bottom:10px' }, [
          el('div', {}, [el('span', { class: 'field-label' }, ['Total x-rays']), el('div', { style: 'padding-top:6px' }, [xrayCountEl])]),
          el('label', { class: 'field', style: 'margin:0;max-width:130px' }, [el('span', { class: 'field-label' }, ['X-ray station #']), station.node]),
        ]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Chief complaint']), complaint.node]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Triage notes']), triageNotes.node]),
      ),

      // The mouth — with F13 quadrant zoom buttons above the chart.
      panel('tooth', 'Odontogram — tap teeth of concern', quadZoomBar(), odo.node),

      // F10: oral-surgery consent tooth numbers (only when such a consent exists).
      consentTeethPanel(),

      // LEAD WITH THE DENTIST'S WORK — fillings and extractions are always the
      // prominent first thing after the odontogram (planning + execution both
      // happen here now that the triage station is gone).
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

      // Anesthetic supports the extractions/fillings above — kept adjacent.
      panel('syringe', 'Anesthetic administered',
        el('p', { class: 'subtle small', style: 'margin:0 0 8px' }, ['Record each administration — agent, carpules, tooth and location. Add a row per site (e.g. #14 buccal, #30 lingual).']),
        anesRows,
        locked ? null : softBtn('plus', 'Add anesthetic', () => addAnes({ agent: 'lidocaine' }))),

      // DEMOTED: cleaning belongs to the hygienist. Rendered inside a lightly
      // styled <details> that is CLOSED by default, so it never competes with
      // the dentist's extractions/fillings. Still fully functional (incl. the
      // bulk-clean control) when opened.
      el('details', {
        class: 'card',
        style: 'padding:0;overflow:hidden;margin-bottom:var(--space-4)',
      }, [
        el('summary', {
          class: 'card-title',
          style: 'cursor:pointer;list-style:none;padding:var(--space-3) var(--space-4);margin:0',
        }, [icon('checkCircle', { size: 15 }), 'Cleaning (usually done by the hygienist)']),
        el('div', { style: 'padding:0 var(--space-4) var(--space-4)' }, [bulkCleanControl(), cleaning]),
      ]),

      // X-rays — provider can add/view (user priority). E1/E2: prominent capture
      // target with click OR drag-and-drop; attachments show immediately below and
      // are included in the summary PDF.
      panel('xray', 'X-rays',
        el('p', { class: 'subtle small', style: 'margin:0 0 8px' }, ['Export the x-ray from DEXIS as a JPG, then tap Add X-ray to upload it — a quick form asks whether it’s a tooth, a quadrant, or general, names it, and files it to the chart. You can also drag an image straight onto the gallery. X-rays print on the summary PDF and sync to every laptop.']),
        gallery, fileInput),

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
              // ONE clear primary action for the station; everything else is secondary.
              primaryBtn('checkCircle', 'Mark visit complete', () => save('complete')),
              el('button', { class: 'btn btn--ghost btn--block', type: 'button', onClick: () => save(false) }, [icon('save', { size: 16 }), 'Save progress']),
              // Less-common actions tucked away so the screen isn't a wall of buttons.
              el('details', { class: 'collapse', style: 'margin-top:8px' }, [
                el('summary', { style: 'font-size:var(--fs-base)' }, ['More options']),
                el('div', { class: 'collapse-body action-stack' }, [
                  el('button', { class: 'btn btn--ghost btn--block', type: 'button', onClick: transferToHygienist }, [icon('sparkle', { size: 16 }), 'Transfer to hygienist']),
                  el('button', { class: 'btn btn--ghost btn--block', type: 'button', onClick: () => save('lock') }, [icon('lock', { size: 16 }), 'Sign off & lock (make record read-only)']),
                  store.can('admin', 'doctor')
                    ? el('button', { class: 'btn btn--ghost btn--block', type: 'button', onClick: async () => {
                        try { const r = await api.pdfGenerate(id, 'summary'); if (r && r.saved) toast(`Saved: ${r.path}`, 'success'); }
                        catch (e) { toast(e.message, 'error'); }
                      } }, [icon('user', { size: 16 }), 'Patient summary PDF'])
                    : null,
                ]),
              ]),
            ])),
    );
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
  const bp = bpStatus(sys, dia); // red when systolic > 180 or diastolic > 100
  const vitalsStr = [];
  if (sys != null || dia != null) vitalsStr.push(`BP ${sys != null ? sys : '—'}/${dia != null ? dia : '—'}${bp.high ? ' — HIGH' : ''}`);
  if (hr != null) vitalsStr.push(`HR ${hr}`);

  line('user', 'Triaged by', p.triaged_by_name, tr.triaged_at);
  line('syringe', 'Vitals by', p.vitals_by_name, tr.vitals_at);
  line('pen', 'Signed off by', p.completed_by_name, tx.completed_at);
  if (p.dismissed_by_name || p.dismissed_at) line('checkCircle', 'Checked out by', p.dismissed_by_name, p.dismissed_at);

  if (!lines.length && !vitalsStr.length) return null;
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Accountability']),
    vitalsStr.length ? el('div', { class: 'chip-row', style: 'margin-bottom:10px' }, [
      el('span', { class: bp.high ? 'pill pill--danger' : 'pill pill--info' }, [icon('syringe', { size: 12 }), `${t('intake.vitalsTitle')}: ${vitalsStr.join(' · ')}`]),
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
  // Streamlined: ONE clear primary (the full record) with the other formats
  // tucked under "More formats" so the screen isn't a wall of buttons.
  return el('div', { class: 'action-stack', style: 'margin-top:12px' }, [
    el('button', { class: 'btn btn--primary btn--block', onClick: () => run(() => api.pdfGenerate(id, 'full')) }, [icon('save', { size: 16 }), 'Save record PDF']),
    el('details', { class: 'collapse', style: 'margin-top:4px' }, [
      el('summary', { style: 'font-size:var(--fs-base)' }, ['More formats']),
      el('div', { class: 'collapse-body action-stack' }, [
        el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfGenerate(id, 'progress')) }, [icon('clipboard', { size: 16 }), 'Progress note PDF']),
        el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfGenerate(id, 'summary')) }, [icon('user', { size: 16 }), 'Patient summary PDF']),
        el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfPrint(id, 'full')) }, [icon('print', { size: 16 }), 'Print']),
        el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.exportRecordUsb(id)) }, [icon('upload', { size: 16 }), 'Save to patient USB']),
      ]),
    ]),
  ]);
}
