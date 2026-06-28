import { el, clear, toast } from '../dom.js';
import { conditions } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { store } from '../store.js';

const STATUS_META = {
  checked_in: ['Checked in', 'var(--info)'],
  triaged: ['Ready', 'var(--accent)'],
  in_treatment: ['In treatment', 'var(--warning)'],
  completed: ['Completed', 'var(--success)'],
};
const dayKey = (iso) => (iso ? String(iso).slice(0, 10) : 'unknown');
const fmtDay = (d) => { const dt = new Date(d + 'T00:00:00'); return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };

export function renderReports(ctx) {
  const root = el('div', { class: 'view' });
  let scope = 'all';

  async function load() {
    const [active, events] = await Promise.all([api.activeEvent(), api.listEvents()]);
    const patients = await api.listPatients({ eventId: scope });
    const full = await Promise.all(patients.map((p) => api.getPatient(p.id)));

    // Totals
    let fillings = 0, extractions = 0, cleanings = 0, xrays = 0, flagged = 0, completed = 0;
    const days = {};
    const ensure = (k) => (days[k] = days[k] || { date: k, seen: 0, completed: 0, fillings: 0, extractions: 0, cleanings: 0, treatments: 0 });
    full.forEach((p) => {
      const tx = p.treatment || {};
      const f = (tx.fillings || []).length, x = (tx.extractions || []).filter((e) => !e.other || e.tooth).length;
      const c = Object.entries(tx.cleaning || {}).some(([k, v]) => v && k !== 'quad_detail' && k !== 'teeth') ? 1 : 0;
      fillings += f; extractions += x; cleanings += c; xrays += (p.xrays || []).length;
      if (p.triage && (p.triage.flags || []).length) flagged += 1;
      if (p.status === 'completed') completed += 1;

      const sd = ensure(dayKey(p.created_at)); sd.seen += 1;
      const txDay = ensure(dayKey((tx.completed_at) || p.updated_at || p.created_at));
      txDay.fillings += f; txDay.extractions += x; txDay.cleanings += c;
      txDay.treatments += f + x + c;
      if (p.status === 'completed') txDay.completed += 1;
    });
    const dailyRows = Object.values(days).filter((d) => d.date !== 'unknown').sort((a, b) => a.date < b.date ? -1 : 1);

    const byStatus = count(patients, (p) => p.status);
    const total = patients.length;

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
        el('div', {}, [el('h1', {}, ['Event Report']), el('p', { class: 'view-sub' }, [scope === 'all' ? 'All events' : (active ? active.name : '')])]),
        el('div', { class: 'view-head-actions' }, [
          scopeSel,
          el('button', { class: 'btn btn--ghost btn--sm', onClick: load }, [icon('refresh', { size: 15 }), 'Refresh']),
          // Event JSON export is admin-only (matches the IPC permission).
          store.is('admin') ? el('button', { class: 'btn btn--primary btn--sm', onClick: async () => {
            try { const r = await api.exportEvent(); if (r.saved) toast(`Exported ${r.count} record(s)`, 'success'); } catch (e) { toast(e.message, 'error'); }
          } }, [icon('download', { size: 15 }), 'Export JSON']) : null,
        ]),
      ]),

      el('div', { class: 'stat-row' }, [
        stat('users', total, 'Patients seen'),
        stat('checkCircle', completed, 'Completed'),
        stat('tooth', extractions, 'Extractions'),
        stat('pen', fillings, 'Fillings'),
        stat('checkCircle', cleanings, 'Cleanings'),
        stat('xray', xrays, 'X-rays'),
      ]),

      el('div', { class: 'split' }, [
        el('div', { class: 'col' }, [
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('reports', { size: 15 }), 'Patients by status']),
            statusBar(byStatus, total),
          ]),
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('flag', { size: 15 }), 'Clinical awareness']),
            el('p', { class: 'awareness' }, [el('strong', {}, [String(flagged)]), ` of ${total} patient(s) flagged with medical conditions needing awareness.`]),
          ]),
        ]),
        el('div', { class: 'col col--wide' }, [
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('calendar', { size: 15 }), 'Daily breakdown']),
            dailyRows.length ? dailyTable(dailyRows) : el('p', { class: 'muted' }, ['No activity recorded yet.']),
          ]),
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Most common conditions']),
            topConds.length ? barList(Object.fromEntries(topConds.map((c) => [c.label, c.n]))) : el('p', { class: 'muted' }, ['No conditions recorded yet.']),
          ]),
        ]),
      ]),
    );
  }

  load().catch((e) => toast(e.message, 'error'));
  return root;
}

function stat(ic, value, label) {
  return el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-head' }, [icon(ic, { size: 16 })]),
    el('div', { class: 'stat-value' }, [String(value)]),
    el('div', { class: 'stat-label' }, [label]),
  ]);
}

// Segmented stacked bar + legend with counts — the redesigned status view.
function statusBar(byStatus, total) {
  const order = ['checked_in', 'triaged', 'in_treatment', 'completed'];
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
