import { el, clear, toast } from '../dom.js';
import { conditions } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { store } from '../store.js';

const STATUS_META = {
  checked_in: ['Checked in', 'var(--info)'],
  triaged: ['Ready for treatment', 'var(--accent)'],
  in_treatment: ['In treatment', 'var(--warning)'],
  completed: ['Completed', 'var(--success)'],
  dismissed: ['Checked out', 'var(--text-subtle)'],
};
const dayKey = (iso) => (iso ? String(iso).slice(0, 10) : 'unknown');
const fmtDay = (d) => { const dt = new Date(d + 'T00:00:00'); return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };

const LANG_LABEL = { en: 'English', es: 'Español', ru: 'Русский', fr: 'Français', pt: 'Português' };
const langLabel = (l) => LANG_LABEL[l] || (l ? String(l).toUpperCase() : 'Unknown');
function genderLabel(g) {
  const s = String(g || '').trim().toLowerCase();
  if (!s) return 'Not recorded';
  if (s[0] === 'm') return 'Male';
  if (s[0] === 'f') return 'Female';
  return g.charAt(0).toUpperCase() + g.slice(1);
}
function ageBucket(a) {
  if (a == null || isNaN(a)) return 'Not recorded';
  if (a < 18) return 'Under 18';
  if (a < 35) return '18–34';
  if (a < 55) return '35–54';
  return '55+';
}

export function renderReports(ctx) {
  const root = el('div', { class: 'view' });
  let scope = 'all';

  async function load() {
    const [active, events] = await Promise.all([api.activeEvent(), api.listEvents()]);
    const patients = await api.listPatients({ eventId: scope });
    const full = await Promise.all(patients.map((p) => api.getPatient(p.id)));

    // ---- Totals + breakdowns (all real, computed from the records) ----
    let fillings = 0, extractions = 0, cleanings = 0, xrays = 0, flagged = 0, completed = 0, withXray = 0;
    const days = {};
    const ensure = (k) => (days[k] = days[k] || { date: k, seen: 0, completed: 0, fillings: 0, extractions: 0, cleanings: 0, treatments: 0 });
    const gender = {}, age = {}, lang = {};
    const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
    full.forEach((p) => {
      const tx = p.treatment || {};
      const f = (tx.fillings || []).length, x = (tx.extractions || []).filter((e) => !e.other || e.tooth).length;
      const c = Object.entries(tx.cleaning || {}).some(([k, v]) => v && k !== 'quad_detail' && k !== 'teeth') ? 1 : 0;
      const nx = (p.xrays || []).length;
      fillings += f; extractions += x; cleanings += c; xrays += nx;
      if (nx) withXray += 1;
      if (p.triage && (p.triage.flags || []).length) flagged += 1;
      if (p.status === 'completed') completed += 1;

      bump(gender, genderLabel(p.gender));
      bump(age, ageBucket(p.age));
      bump(lang, langLabel(p.language));

      const sd = ensure(dayKey(p.created_at)); sd.seen += 1;
      const txDay = ensure(dayKey((tx.completed_at) || p.updated_at || p.created_at));
      txDay.fillings += f; txDay.extractions += x; txDay.cleanings += c;
      txDay.treatments += f + x + c;
      if (p.status === 'completed') txDay.completed += 1;
    });
    const dailyRows = Object.values(days).filter((d) => d.date !== 'unknown').sort((a, b) => a.date < b.date ? -1 : 1);

    const byStatus = count(patients, (p) => p.status);
    const total = patients.length;
    const completePct = total ? Math.round((completed / total) * 100) : 0;

    const condCounts = {};
    full.forEach((p) => (p.medical_history.conditions || []).forEach((k) => { condCounts[k] = (condCounts[k] || 0) + 1; }));
    const topConds = conditions().map((c) => ({ label: c.label, n: condCounts[c.key] || 0 })).filter((c) => c.n).sort((a, b) => b.n - a.n).slice(0, 8);

    // Scope selector
    const scopeSel = el('select', { class: 'input select input--sm', onChange: (e) => { scope = e.target.value === 'all' ? 'all' : Number(e.target.value); load(); } });
    scopeSel.append(el('option', { value: 'all' }, ['All events']));
    events.forEach((ev) => { const o = el('option', { value: String(ev.id) }, [ev.name]); if (scope !== 'all' && Number(scope) === ev.id) o.selected = true; scopeSel.append(o); });

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, ['Reports & analytics']), el('p', { class: 'view-sub' }, [scope === 'all' ? 'All clinic events' : (active ? active.name : '')])]),
        el('div', { class: 'view-head-actions' }, [
          scopeSel,
          el('button', { class: 'btn btn--ghost btn--sm', onClick: load }, [icon('refresh', { size: 15 }), 'Refresh']),
          store.is('admin') ? el('button', { class: 'btn btn--primary btn--sm', onClick: async () => {
            try { const r = await api.exportEvent(); if (r.saved) toast(`Exported ${r.count} record(s)`, 'success'); } catch (e) { toast(e.message, 'error'); }
          } }, [icon('download', { size: 15 }), 'Export JSON']) : null,
        ]),
      ]),

      // ---- KPI cards ----
      el('div', { class: 'kpi-grid' }, [
        kpi('users', total, 'Patients seen', { accent: true }),
        kpi('checkCircle', completed, 'Completed', { sub: total ? `${completePct}% of ${total}` : null }),
        kpi('xray', xrays, 'X-rays uploaded', { sub: withXray ? `${withXray} patient(s)` : null }),
        kpi('tooth', extractions, 'Extractions'),
        kpi('pen', fillings, 'Fillings'),
        kpi('scan', cleanings, 'Cleanings'),
      ]),

      // ---- Completion ring + demographics ----
      el('div', { class: 'dash-grid' }, [
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title' }, [icon('checkCircle', { size: 15 }), 'Visit completion']),
          el('div', { class: 'ring-wrap' }, [
            ring(completePct, `${completePct}%`, 'completed'),
            el('div', { class: 'ring-legend' }, [
              legRow('var(--success)', 'Completed', completed),
              legRow('var(--warning)', 'In progress', Math.max(0, total - completed - (byStatus.dismissed || 0))),
              legRow('var(--text-subtle)', 'Checked out', byStatus.dismissed || 0),
            ]),
          ]),
          el('div', { class: 'card-sub-title' }, ['Patients by status']),
          statusBar(byStatus, total),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title' }, [icon('users', { size: 15 }), 'Patient demographics']),
          demoGroup('By gender', gender, ['Male', 'Female', 'Other', 'Not recorded']),
          demoGroup('By age', age, ['Under 18', '18–34', '35–54', '55+', 'Not recorded']),
          demoGroup('By language', lang, Object.keys(lang)),
        ]),
      ]),

      // ---- Procedures + conditions ----
      el('div', { class: 'dash-grid' }, [
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title' }, [icon('tooth', { size: 15 }), 'Procedures & imaging']),
          barList({ Fillings: fillings, Extractions: extractions, Cleanings: cleanings, 'X-rays': xrays }),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Most common conditions']),
          topConds.length ? barList(Object.fromEntries(topConds.map((c) => [c.label, c.n]))) : el('p', { class: 'muted' }, ['No conditions recorded yet.']),
          el('p', { class: 'awareness', style: 'margin-top:12px' }, [el('strong', {}, [String(flagged)]), ` of ${total} patient(s) flagged with a condition needing awareness.`]),
        ]),
      ]),

      // ---- Daily breakdown ----
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('calendar', { size: 15 }), 'Daily breakdown']),
        dailyRows.length ? dailyTable(dailyRows) : el('p', { class: 'muted' }, ['No activity recorded yet.']),
      ]),
    );
  }

  load().catch((e) => toast(e.message, 'error'));
  return root;
}

// ---- KPI card ----
function kpi(ic, value, label, opts = {}) {
  return el('div', { class: 'kpi' + (opts.accent ? ' kpi--accent' : '') }, [
    el('div', { class: 'kpi-ico' }, [icon(ic, { size: 18 })]),
    el('div', { class: 'kpi-val' }, [String(value)]),
    el('div', { class: 'kpi-label' }, [label]),
    opts.sub ? el('div', { class: 'kpi-sub' }, [opts.sub]) : null,
  ]);
}

// ---- Completion donut (conic-gradient, no external chart lib) ----
function ring(pct, top, sub) {
  return el('div', { class: 'ring-track', style: `background:conic-gradient(var(--accent) ${pct}%, var(--surface-sunken) 0)` }, [
    el('div', { class: 'ring-hole' }, [
      el('div', { class: 'ring-top' }, [top]),
      el('div', { class: 'ring-sub' }, [sub]),
    ]),
  ]);
}
function legRow(color, label, val) {
  return el('div', { class: 'ring-leg' }, [
    el('span', { class: 'status-dot', style: `background:${color}` }),
    el('span', { class: 'ring-leg-label' }, [label]),
    el('span', { class: 'ring-leg-val mono' }, [String(val)]),
  ]);
}

// ---- Demographics group: a sub-heading + ordered bar list (present buckets) ----
function demoGroup(title, counts, order) {
  const keys = order.filter((k) => counts[k]);
  Object.keys(counts).forEach((k) => { if (!keys.includes(k)) keys.push(k); });
  const obj = {};
  keys.forEach((k) => { obj[k] = counts[k]; });
  return el('div', { class: 'demo-group' }, [
    el('div', { class: 'demo-h' }, [title]),
    keys.length ? barList(obj) : el('p', { class: 'muted small' }, ['No data yet.']),
  ]);
}

// Segmented stacked bar + legend with counts.
function statusBar(byStatus, total) {
  const order = ['checked_in', 'triaged', 'in_treatment', 'completed', 'dismissed'];
  const present = order.filter((k) => byStatus[k]);
  const bar = el('div', { class: 'status-bar' }, present.map((k) => {
    const pct = total ? (byStatus[k] / total) * 100 : 0;
    return el('span', { class: 'status-seg', title: `${STATUS_META[k][0]}: ${byStatus[k]}`, style: `width:${pct}%;background:${STATUS_META[k][1]}` });
  }));
  if (!total) bar.append(el('span', { class: 'status-seg', style: 'width:100%;background:var(--surface-sunken)' }));
  const legend = el('div', { class: 'status-legend' }, order.map((k) => el('div', { class: 'status-leg' }, [
    el('span', { class: 'status-dot', style: `background:${STATUS_META[k][1]}` }),
    el('span', { class: 'status-leg-label' }, [STATUS_META[k][0]]),
    el('span', { class: 'status-leg-val mono' }, [String(byStatus[k] || 0)]),
  ])));
  return el('div', {}, [bar, legend]);
}

function dailyTable(rows) {
  return el('div', { class: 'data-table-wrap' }, [
    el('table', { class: 'data-table data-table--mini' }, [
      el('thead', {}, [el('tr', {}, ['Day', 'Seen', 'Completed', 'Fillings', 'Extractions', 'Cleanings'].map((h, i) => el('th', { class: i ? 'num-col' : '' }, [h])))]),
      el('tbody', {}, rows.map((d) => el('tr', {}, [
        el('td', {}, [fmtDay(d.date)]),
        el('td', { class: 'num' }, [String(d.seen)]),
        el('td', { class: 'num' }, [String(d.completed)]),
        el('td', { class: 'num' }, [String(d.fillings)]),
        el('td', { class: 'num' }, [String(d.extractions)]),
        el('td', { class: 'num' }, [String(d.cleanings)]),
      ]))),
    ]),
  ]);
}

function count(arr, fn) {
  const out = {};
  arr.forEach((x) => { const k = fn(x) || 'Unknown'; out[k] = (out[k] || 0) + 1; });
  return out;
}
function barList(obj) {
  const max = Math.max(1, ...Object.values(obj));
  return el('div', { class: 'bar-list' }, Object.entries(obj).map(([k, v]) => el('div', { class: 'bar-row' }, [
    el('span', { class: 'bar-label' }, [k]),
    el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.round((v / max) * 100)}%` })]),
    el('span', { class: 'bar-val' }, [String(v)]),
  ])));
}
