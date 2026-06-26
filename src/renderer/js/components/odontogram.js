// Visual odontogram — "the mouth". Draws upper + lower dental arches as
// anatomical tooth glyphs (Universal Adult 1–32 and Primary A–T), clickable for
// selection, with per-tooth treatment color-coding (filling / extraction /
// cleaning). Returns { node, get, set, setMarks, setMode }.

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, kids = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    e.setAttribute(k, String(v));
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => c && e.append(c));
  return e;
}

// Universal numbering, left→right as printed on the CHW form.
const ADULT_UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));            // 1..16
const ADULT_LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));           // 32..17
const PRIMARY_UPPER = 'ABCDEFGHIJ'.split('');                                       // A..J
const PRIMARY_LOWER = 'TSRQPONMLK'.split('');                                       // T..K

const VW = 760;
const VH = 340;
const CX = VW / 2;
const R = 540;

function archPositions(count, arch) {
  // Spread teeth across a circular arc so they fan like a real jaw.
  const A = (count > 12 ? 25 : 20) * (Math.PI / 180); // half-spread radians
  const pts = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const theta = -A + 2 * A * t;                 // left to right across the arch
    const x = CX + R * Math.sin(theta);
    const degr = (theta * 180) / Math.PI * 0.6;   // subtle fan
    if (arch === 'upper') {
      const cy = 78 + R;                           // arch center sits below
      const y = cy - R * Math.cos(theta);          // center highest (∩)
      pts.push({ x, y, rot: degr, arch });
    } else {
      const cy = 262 - R;                          // arch center sits above
      const y = cy + R * Math.cos(theta);          // center lowest (∪)
      pts.push({ x, y, rot: -degr, arch });
    }
  }
  return pts;
}

export function Odontogram({ mode = 'adult', selected = [], marks = {}, onChange } = {}) {
  let curMode = mode;
  let sel = new Set((selected || []).map(String));
  let markMap = { ...(marks || {}) };

  const svg = s('svg', { class: 'odo-arch', viewBox: `0 0 ${VW} ${VH}`, role: 'img' });

  function toothGlyph(id, p) {
    // Size: molars (toward the back/ends) a touch wider; incisors narrower.
    const g = s('g', { class: 'odo-tooth', transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${p.rot.toFixed(1)})` });
    g.dataset.id = id;
    const w = 21, h = 30;
    const crown = s('rect', { class: 'crown', x: -w / 2, y: -h / 2, width: w, height: h, rx: 7 });
    // occlusal groove lines for a bit of realism (concrete color — SVG
    // presentation attributes do not resolve CSS var()).
    const g1 = s('line', { class: 'groove', x1: -w / 2 + 4, y1: -3, x2: w / 2 - 4, y2: -3, stroke: '#cfd5dc', 'stroke-width': 0.8 });
    const g2 = s('line', { class: 'groove', x1: 0, y1: -h / 2 + 5, x2: 0, y2: h / 2 - 5, stroke: '#cfd5dc', 'stroke-width': 0.8 });
    // extraction X (shown when marked)
    const x1 = s('line', { class: 'xmark', x1: -w / 2 + 3, y1: -h / 2 + 3, x2: w / 2 - 3, y2: h / 2 - 3, stroke: 'transparent' });
    const x2 = s('line', { class: 'xmark', x1: w / 2 - 3, y1: -h / 2 + 3, x2: -w / 2 + 3, y2: h / 2 - 3, stroke: 'transparent' });
    g.append(crown, g1, g2, x1, x2);
    applyClass(g, id);
    g.addEventListener('click', () => {
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      applyClass(g, id);
      emit();
    });
    return g;
  }

  function applyClass(g, id) {
    g.classList.remove('sel', 'mark-filling', 'mark-extraction', 'mark-cleaning');
    const m = markMap[id];
    if (m === 'filling') g.classList.add('mark-filling');
    else if (m === 'extraction') g.classList.add('mark-extraction');
    else if (m === 'cleaning') g.classList.add('mark-cleaning');
    if (sel.has(id)) g.classList.add('sel');
  }

  function label(id, p, arch) {
    const y = arch === 'upper' ? p.y - 22 : p.y + 26;
    return s('text', { class: 'tnum', x: p.x.toFixed(1), y: y.toFixed(1) }, [document.createTextNode(id)]);
  }

  function render() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const upperIds = curMode === 'adult' ? ADULT_UPPER : PRIMARY_UPPER;
    const lowerIds = curMode === 'adult' ? ADULT_LOWER : PRIMARY_LOWER;
    const up = archPositions(upperIds.length, 'upper');
    const lo = archPositions(lowerIds.length, 'lower');

    // arch labels + quadrant midline
    svg.append(s('text', { class: 'odo-arch-label', x: 14, y: 20 }, [document.createTextNode('UPPER / MAXILLARY')]));
    svg.append(s('text', { class: 'odo-arch-label', x: 14, y: VH - 10 }, [document.createTextNode('LOWER / MANDIBULAR')]));
    svg.append(s('line', { class: 'odo-midline', x1: CX, y1: 40, x2: CX, y2: VH - 36 }));

    upperIds.forEach((id, i) => { svg.append(toothGlyph(id, up[i])); svg.append(label(id, up[i], 'upper')); });
    lowerIds.forEach((id, i) => { svg.append(toothGlyph(id, lo[i])); svg.append(label(id, lo[i], 'lower')); });
  }

  function emit() { if (onChange) onChange(get()); renderSelectedList(); }
  function get() { return { selected: Array.from(sel), marks: { ...markMap } }; }

  // Toggle adult/primary
  const seg = s('div'); // placeholder, real toggle built in DOM below
  const toggle = document.createElement('div');
  toggle.className = 'seg-toggle';
  const mkSeg = (m, txt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (curMode === m ? ' seg-btn--on' : '');
    b.textContent = txt;
    b.onclick = () => {
      curMode = m;
      toggle.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('seg-btn--on'));
      b.classList.add('seg-btn--on');
      render(); renderSelectedList();
    };
    return b;
  };
  toggle.append(mkSeg('adult', 'Adult 1–32'), mkSeg('primary', 'Primary A–T'));

  const legend = document.createElement('div');
  legend.className = 'odo-legend';
  legend.innerHTML =
    '<span><i class="odo-key odo-key--sel"></i>Selected</span>' +
    '<span><i class="odo-key odo-key--filling"></i>Filling</span>' +
    '<span><i class="odo-key odo-key--extraction"></i>Extraction</span>' +
    '<span><i class="odo-key odo-key--cleaning"></i>Cleaning</span>';

  const toolbar = document.createElement('div');
  toolbar.className = 'odo-toolbar';
  toolbar.append(toggle, legend);

  const selectedList = document.createElement('div');
  selectedList.className = 'odo-selected-list';
  function renderSelectedList() {
    selectedList.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.textContent = 'Teeth of concern:';
    selectedList.append(lbl);
    const ids = Array.from(sel);
    if (!ids.length) {
      const none = document.createElement('span'); none.className = 'subtle'; none.textContent = 'none selected — tap teeth above';
      selectedList.append(none); return;
    }
    ids.forEach((id) => {
      const tag = document.createElement('span'); tag.className = 'tooth-tag'; tag.textContent = id;
      selectedList.append(tag);
    });
  }

  const wrap = document.createElement('div');
  wrap.className = 'odo';
  wrap.append(toolbar, svg, selectedList);

  render();
  renderSelectedList();

  return {
    node: wrap,
    get,
    getSelected: () => Array.from(sel),
    set: (ids) => { sel = new Set((ids || []).map(String)); render(); renderSelectedList(); },
    setMarks: (m) => { markMap = { ...(m || {}) }; render(); },
    setMode: (m) => { curMode = m; render(); renderSelectedList(); },
  };
}
