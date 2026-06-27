// Visual odontogram — "the mouth". Anatomical upper/lower arches with a
// dentition dropdown (Adult / Primary / Mixed), clean numbered pills, and a
// click-to-tag popover so a tooth can be tagged (filling / extraction /
// cleaning) + a short note with minimal typing.
//
// Per-tooth state:  toothData[id] = { tx: 'filling'|'extraction'|'cleaning'|null, note: '' }
// Programmatic set* methods are SILENT; only the user pressing Done/Clear fires
// onChange / onTag / onUntag (prevents feedback loops with the treatment lists).

import { icon } from '../icons.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, kids = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) { if (v != null) e.setAttribute(k, String(v)); }
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => c && e.append(c));
  return e;
}

const ADULT_UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));    // 1..16
const ADULT_LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));   // 32..17
const PRIMARY_UPPER = 'ABCDEFGHIJ'.split('');                               // A..J
const PRIMARY_LOWER = 'TSRQPONMLK'.split('');                               // T..K
// Mixed dentition: permanent molars + incisors, primary canine/molars in the buccal segments.
const MIXED_UPPER = ['1', '2', '3', 'A', 'B', 'C', '7', '8', '9', '10', 'H', 'I', 'J', '14', '15', '16'];
const MIXED_LOWER = ['32', '31', '30', 'K', 'L', 'M', '26', '25', '24', '23', 'P', 'Q', 'R', '19', '18', '17'];

const VW = 880, VH = 400, CX = VW / 2, SPREAD = 360, AMP = 80, TOP_U = 84, BOT_L = 316;
const A = 30 * (Math.PI / 180);
const CROWN_W = 26, CROWN_H = 38, PILL_R = 11;

function positions(count, arch) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const theta = -A + 2 * A * t;
    const nx = Math.sin(theta) / Math.sin(A);
    const ny = (1 - Math.cos(theta)) / (1 - Math.cos(A));
    const x = CX + SPREAD * nx;
    const rot = (theta * 180 / Math.PI) * 0.45;
    if (arch === 'upper') pts.push({ x, y: TOP_U + AMP * ny, rot, arch });
    else pts.push({ x, y: BOT_L - AMP * ny, rot: -rot, arch });
  }
  return pts;
}

const isPrimaryId = (id) => /^[A-T]$/.test(id);

export function Odontogram({ mode = 'adult', teeth = {}, selected = [], onChange, onTag, onUntag } = {}) {
  let curMode = mode;
  // Normalize incoming teeth (accepts {id:'filling'} or {id:{tx,note}}) + selected ids.
  const toothData = {};
  function seed(obj, sel) {
    Object.entries(obj || {}).forEach(([id, v]) => {
      toothData[id] = typeof v === 'string' ? { tx: v, note: '' } : { tx: v.tx || null, note: v.note || '' };
    });
    (sel || []).forEach((id) => { if (!toothData[id]) toothData[id] = { tx: null, note: '' }; });
  }
  seed(teeth, selected);

  const svg = s('svg', { class: 'odo-arch', viewBox: `0 0 ${VW} ${VH}`, role: 'img' });
  const wrap = document.createElement('div');
  wrap.className = 'odo';
  let openPop = null;

  function idsFor() {
    if (curMode === 'primary') return [PRIMARY_UPPER, PRIMARY_LOWER];
    if (curMode === 'mixed') return [MIXED_UPPER, MIXED_LOWER];
    return [ADULT_UPPER, ADULT_LOWER];
  }

  function toothGlyph(id, p) {
    const g = s('g', { class: 'odo-tooth' + (isPrimaryId(id) ? ' odo-tooth--primary' : ''),
      transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${p.rot.toFixed(1)})` });
    g.dataset.id = id;
    const w = CROWN_W, h = CROWN_H;
    g.append(
      s('rect', { class: 'crown', x: -w / 2, y: -h / 2, width: w, height: h, rx: 8 }),
      s('line', { class: 'groove', x1: -w / 2 + 5, y1: -4, x2: w / 2 - 5, y2: -4, stroke: '#cfd5dc', 'stroke-width': 1 }),
      s('line', { class: 'groove', x1: 0, y1: -h / 2 + 6, x2: 0, y2: h / 2 - 6, stroke: '#cfd5dc', 'stroke-width': 1 }),
      s('line', { class: 'xmark', x1: -w / 2 + 4, y1: -h / 2 + 4, x2: w / 2 - 4, y2: h / 2 - 4, stroke: 'transparent' }),
      s('line', { class: 'xmark', x1: w / 2 - 4, y1: -h / 2 + 4, x2: -w / 2 + 4, y2: h / 2 - 4, stroke: 'transparent' })
    );
    g.addEventListener('click', (e) => { e.stopPropagation(); openPopover(id, g); });
    return g;
  }

  function labelDisc(id, p, arch) {
    const ly = arch === 'upper' ? p.y - 31 : p.y + 35;
    const grp = s('g', { class: 'tnum-g', 'data-id': id });
    grp.append(
      s('circle', { class: 'tnum-bg', cx: p.x.toFixed(1), cy: ly.toFixed(1), r: PILL_R }),
      s('text', { class: 'tnum', x: p.x.toFixed(1), y: ly.toFixed(1), dy: '0.32em' }, [document.createTextNode(id)])
    );
    return grp;
  }

  function applyTooth(id) {
    const g = svg.querySelector(`.odo-tooth[data-id="${cssEsc(id)}"]`);
    const lab = svg.querySelector(`.tnum-g[data-id="${cssEsc(id)}"]`);
    const d = toothData[id];
    if (g) {
      g.classList.remove('sel', 'mark-filling', 'mark-extraction', 'mark-cleaning', 'has-note');
      if (d) {
        if (d.tx) g.classList.add('mark-' + d.tx); else g.classList.add('sel');
        if (d.note) g.classList.add('has-note');
        if (d.note) g.setAttribute('title', `#${id}: ${d.note}`); else g.removeAttribute('title');
      }
    }
    if (lab) lab.classList.toggle('tnum-g--on', !!d);
  }

  function render() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const [upper, lower] = idsFor();
    const up = positions(upper.length, 'upper');
    const lo = positions(lower.length, 'lower');
    svg.append(
      s('text', { class: 'odo-arch-label', x: 14, y: 20 }, [document.createTextNode('UPPER / MAXILLARY')]),
      s('text', { class: 'odo-arch-label', x: 14, y: VH - 10 }, [document.createTextNode('LOWER / MANDIBULAR')]),
      s('line', { class: 'odo-midline', x1: CX, y1: 42, x2: CX, y2: VH - 38 })
    );
    upper.forEach((id, i) => { svg.append(toothGlyph(id, up[i]), labelDisc(id, up[i], 'upper')); });
    lower.forEach((id, i) => { svg.append(toothGlyph(id, lo[i]), labelDisc(id, lo[i], 'lower')); });
    [...upper, ...lower].forEach(applyTooth);
  }

  /* ---------- click-to-tag popover ---------- */
  function closePopover() {
    if (openPop) { openPop.remove(); openPop = null; document.removeEventListener('mousedown', outside, true); }
  }
  function outside(e) { if (openPop && !openPop.contains(e.target)) closePopover(); }

  function openPopover(id, g) {
    closePopover();
    const cur = toothData[id] || { tx: null, note: '' };
    let chosen = cur.tx;

    const pop = document.createElement('div');
    pop.className = 'odo-pop';
    pop.addEventListener('mousedown', (e) => e.stopPropagation());

    const optBtn = (tx, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'odo-pop-opt odo-pop-opt--' + tx + (chosen === tx ? ' on' : '');
      b.textContent = label;
      b.onclick = () => {
        chosen = chosen === tx ? null : tx;
        pop.querySelectorAll('.odo-pop-opt').forEach((x) => x.classList.remove('on'));
        if (chosen) b.classList.add('on');
      };
      return b;
    };
    const note = document.createElement('input');
    note.className = 'input input--sm odo-pop-note';
    note.placeholder = 'Short note (optional)';
    note.maxLength = 80;
    note.value = cur.note || '';

    const head = document.createElement('div');
    head.className = 'odo-pop-head';
    head.append(chip(id), Object.assign(document.createElement('span'), { className: 'odo-pop-title', textContent: 'Tag tooth' }));
    const xb = document.createElement('button'); xb.className = 'odo-pop-x'; xb.type = 'button'; xb.append(icon('x', { size: 14 })); xb.onclick = closePopover;
    head.append(xb);

    const seg = document.createElement('div');
    seg.className = 'odo-pop-seg';
    seg.append(optBtn('filling', 'Filling'), optBtn('extraction', 'Extraction'), optBtn('cleaning', 'Cleaning'));

    const foot = document.createElement('div');
    foot.className = 'odo-pop-foot';
    const clearB = document.createElement('button'); clearB.className = 'btn btn--ghost btn--sm'; clearB.type = 'button'; clearB.textContent = 'Clear tooth';
    clearB.onclick = () => { const had = !!toothData[id]; delete toothData[id]; applyTooth(id); closePopover(); if (had) { emit(); if (onUntag) onUntag(id); } };
    const doneB = document.createElement('button'); doneB.className = 'btn btn--primary btn--sm'; doneB.type = 'button'; doneB.textContent = 'Done';
    doneB.onclick = () => {
      toothData[id] = { tx: chosen || null, note: note.value.trim() };
      applyTooth(id); closePopover(); emit();
      if (onTag) onTag(id, toothData[id]);
    };
    foot.append(clearB, doneB);

    pop.append(head, seg, note, foot);
    wrap.append(pop);

    // Position near the tooth, clamped within the wrap.
    const gr = g.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    let left = gr.left - wr.left + gr.width / 2 - 110;
    let top = gr.top - wr.top + gr.height + 8;
    left = Math.max(8, Math.min(left, wrap.clientWidth - 228));
    if (top + 170 > wrap.clientHeight) top = gr.top - wr.top - 170;
    pop.style.left = left + 'px';
    pop.style.top = Math.max(8, top) + 'px';
    openPop = pop;
    setTimeout(() => { note.focus(); document.addEventListener('mousedown', outside, true); }, 0);
  }

  function chip(id) { const c = document.createElement('span'); c.className = 'tooth-tag'; c.textContent = id; return c; }

  /* ---------- emit / public API ---------- */
  function emit() { renderSelectedList(); if (onChange) onChange(get()); }
  function get() {
    const marks = {}, notes = {};
    Object.entries(toothData).forEach(([id, d]) => { if (d.tx) marks[id] = d.tx; if (d.note) notes[id] = d.note; });
    return { selected: Object.keys(toothData), marks, notes, teeth: JSON.parse(JSON.stringify(toothData)) };
  }

  /* ---------- toolbar ---------- */
  const modeSel = document.createElement('select');
  modeSel.className = 'input input--sm odo-mode-sel';
  [['adult', 'Adult (1–32)'], ['primary', 'Primary (A–T)'], ['mixed', 'Mixed (hybrid)']].forEach(([v, l]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === curMode) o.selected = true; modeSel.append(o);
  });
  modeSel.onchange = () => { curMode = modeSel.value; render(); renderSelectedList(); };
  const modeWrap = document.createElement('label');
  modeWrap.className = 'odo-mode';
  modeWrap.append(Object.assign(document.createElement('span'), { className: 'field-label', textContent: 'Dentition' }), modeSel);

  const legend = document.createElement('div');
  legend.className = 'odo-legend';
  legend.innerHTML =
    '<span><i class="odo-key odo-key--sel"></i>Selected</span>' +
    '<span><i class="odo-key odo-key--filling"></i>Filling</span>' +
    '<span><i class="odo-key odo-key--extraction"></i>Extraction</span>' +
    '<span><i class="odo-key odo-key--cleaning"></i>Cleaning</span>';

  const toolbar = document.createElement('div');
  toolbar.className = 'odo-toolbar';
  toolbar.append(modeWrap, legend);

  const mixedNote = document.createElement('div');
  mixedNote.className = 'odo-mixed-note subtle small';
  mixedNote.textContent = 'Mixed dentition — letters = primary, numbers = permanent.';

  const selectedList = document.createElement('div');
  selectedList.className = 'odo-selected-list';
  function renderSelectedList() {
    selectedList.innerHTML = '';
    mixedNote.style.display = curMode === 'mixed' ? '' : 'none';
    const lbl = document.createElement('span'); lbl.textContent = 'Tagged teeth:'; selectedList.append(lbl);
    // Only show tags for teeth that exist in the current dentition view.
    const [u, l] = idsFor();
    const valid = new Set([...u, ...l]);
    const ids = Object.keys(toothData).filter((id) => valid.has(id));
    if (!ids.length) { const n = document.createElement('span'); n.className = 'subtle'; n.textContent = 'none — tap a tooth to tag it'; selectedList.append(n); return; }
    ids.forEach((id) => {
      const d = toothData[id];
      const tag = document.createElement('span');
      tag.className = 'tooth-tag' + (d.tx ? ' tooth-tag--' + d.tx : '');
      tag.textContent = id + (d.tx ? '·' + d.tx[0].toUpperCase() : '');
      if (d.note) tag.title = d.note;
      selectedList.append(tag);
    });
  }

  wrap.append(toolbar, mixedNote, svg, selectedList);
  render();
  renderSelectedList();

  return {
    node: wrap,
    get,
    getSelected: () => Object.keys(toothData),
    getNotes: () => get().notes,
    getTeeth: () => get().teeth,
    set: (ids) => { Object.keys(toothData).forEach((k) => delete toothData[k]); (ids || []).forEach((id) => { toothData[id] = { tx: null, note: '' }; }); render(); renderSelectedList(); },
    setTeeth: (obj) => { Object.keys(toothData).forEach((k) => delete toothData[k]); seed(obj, []); render(); renderSelectedList(); },
    setMarks: (map) => { // back-compat: merge tx marks, preserve existing notes
      Object.entries(map || {}).forEach(([id, tx]) => { toothData[id] = { tx, note: (toothData[id] && toothData[id].note) || '' }; });
      // drop marks no longer present that had no note
      Object.keys(toothData).forEach((id) => { if (!map[id] && !toothData[id].note && toothData[id].tx) delete toothData[id]; });
      render(); renderSelectedList();
    },
    setMode: (m) => { curMode = ['adult', 'primary', 'mixed'].includes(m) ? m : 'adult'; modeSel.value = curMode; render(); renderSelectedList(); },
  };
}

// Minimal CSS.escape fallback for attribute selectors (tooth ids are alnum).
function cssEsc(v) { return String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
