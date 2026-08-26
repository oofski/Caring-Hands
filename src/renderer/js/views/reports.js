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
  const s = String(g == null ? '' : g).trim().toLowerCase();
  if (!s) return 'Not recorded';
  // Exact code match only — never guess by first letter (that mislabeled
  // localized values like Spanish "Mujer" as "Male").
  if (s === 'male' || s === 'm') return 'Male';
  if (s === 'female' || s === 'f') return 'Female';
  if (s === 'other') return 'Other';
  return String(g).charAt(0).toUpperCase() + String(g).slice(1);
}
function cityLabel(d) {
  if (!d) return 'Not recorded';
  const c = String(d.city || '').trim(), s = String(d.state || '').trim();
  if (!c && !s) return 'Not recorded';
  return [c, s].filter(Boolean).join(', ');
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

  function scopeSelFor(events) {
    const sel = el('select', { class: 'input select input--sm', onChange: (e) => { scope = e.target.value === 'all' ? 'all' : Number(e.target.value); load(); } });
    sel.append(el('option', { value: 'all' }, ['All events']));
    (events || []).forEach((ev) => {
      const o = el('option', { value: String(ev.id) }, [ev.name]);
      if (scope !== 'all' && Number(scope) === ev.id) o.selected = true;
      sel.append(o);
    });
    return sel;
  }

  async function load() {
    const [active, events, archived] = await Promise.all([
      api.activeEvent(), api.listEvents(),
      api.archivedReports().catch(() => []),
    ]);
    const patients = await api.listPatients({ eventId: scope });

    // A clinic whose patient records have been removed still has its kept
    // totals. Without this the page computed from an empty patient list and
    // showed zeros, which read as the reporting data having been destroyed.
    const archivedFor = (id) => (archived || []).find((r) => r.event_id === id) || null;
    const kept = (scope !== 'all' && !patients.length) ? archivedFor(Number(scope)) : null;
    if (kept) { clear(root); root.append(archivedView(kept, events, scopeSelFor(events), load)); return; }
    const full = await Promise.all(patients.map((p) => api.getPatient(p.id)));

    // ---- Totals + breakdowns (all real, computed from the records) ----
    // A visit is FINISHED when the patient has been through and gone: status
    // 'completed' (treatment done) or 'dismissed' (checked out and left). Counting
    // only 'completed' made the ring read 0% for a clinic where everyone had been
    // seen and sent home, because check-out moves them straight past 'completed'.
    let fillings = 0, extractions = 0, cleanings = 0, xrays = 0, flagged = 0, finished = 0, withXray = 0;
    let preSignups = 0, preFinished = 0, onSiteSignups = 0, onSiteFinished = 0, checkedOut = 0;
    const isFinished = (p) => p.status === 'completed' || p.status === 'dismissed';
    const days = {};
    const ensure = (k) => (days[k] = days[k] || { date: k, seen: 0, completed: 0, fillings: 0, extractions: 0, cleanings: 0, treatments: 0 });
    const gender = {}, age = {}, lang = {}, city = {};
    const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
    full.forEach((p) => {
      const tx = p.treatment || {};
      const f = (tx.fillings || []).length, x = (tx.extractions || []).filter((e) => !e.other || e.tooth).length;
      const c = Object.entries(tx.cleaning || {}).some(([k, v]) => v && k !== 'quad_detail' && k !== 'teeth') ? 1 : 0;
      const nx = (p.xrays || []).length;
      fillings += f; extractions += x; cleanings += c; xrays += nx;
      if (nx) withXray += 1;
      if (p.triage && (p.triage.flags || []).length) flagged += 1;
      if (isFinished(p)) finished += 1;
      if (p.status === 'dismissed') checkedOut += 1;
      // Where the patient came from: the online link, or the front desk.
      const pre = !!(p.demographics && p.demographics.preregistered);
      if (pre) { preSignups += 1; if (p.status === 'dismissed') preFinished += 1; }
      else { onSiteSignups += 1; if (p.status === 'dismissed') onSiteFinished += 1; }

      bump(gender, genderLabel(p.gender));
      bump(age, ageBucket(p.age));
      bump(lang, langLabel(p.language));
      bump(city, cityLabel(p.demographics));

      const sd = ensure(dayKey(p.created_at)); sd.seen += 1;
      const txDay = ensure(dayKey((tx.completed_at) || p.updated_at || p.created_at));
      txDay.fillings += f; txDay.extractions += x; txDay.cleanings += c;
      txDay.treatments += f + x + c;
      if (isFinished(p)) txDay.completed += 1;
    });
    const dailyRows = Object.values(days).filter((d) => d.date !== 'unknown').sort((a, b) => a.date < b.date ? -1 : 1);

    const byStatus = count(patients, (p) => p.status);
    const total = patients.length;
    const completePct = total ? Math.round((finished / total) * 100) : 0;
    const inProgress = Math.max(0, total - finished);
    const outPct = total ? Math.round((checkedOut / total) * 100) : 0;

    const condCounts = {};
    full.forEach((p) => (p.medical_history.conditions || []).forEach((k) => { condCounts[k] = (condCounts[k] || 0) + 1; }));
    const topConds = conditions().map((c) => ({ label: c.label, n: condCounts[c.key] || 0 })).filter((c) => c.n).sort((a, b) => b.n - a.n).slice(0, 8);

    const scopeSel = scopeSelFor(events);

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
        kpi('checkCircle', finished, 'Visits finished', { sub: total ? `${completePct}% of ${total} · ${checkedOut} checked out` : null }),
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
              legRow('var(--success)', 'Finished', finished),
              legRow('var(--text-subtle)', 'of which checked out', checkedOut),
              legRow('var(--warning)', 'Still in the clinic', inProgress),
            ]),
          ]),
          el('div', { class: 'card-sub-title' }, ['Patients by status']),
          statusBar(byStatus, total),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title' }, [icon('users', { size: 15 }), 'Patient demographics']),
          demoGroup('By gender', gender, ['Male', 'Female', 'Other', 'Not recorded'], { sort: false }),
          demoGroup('By age', age, ['Under 18', '18–34', '35–54', '55+', 'Not recorded'], { sort: false }),
          demoGroup('By language', lang, Object.keys(lang), { limit: 4 }),
          demoGroup('By city', city, Object.keys(city), { limit: 5 }),
        ]),
      ]),

      // ---- Sign-ups vs check-outs, split by where they registered ----
      signupCard({ total, checkedOut, outPct, preSignups, preFinished, onSiteSignups, onSiteFinished }),

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

      // ---- Email visit summaries (patients who left an email) ----
      emailCard(full),

      // ---- Daily breakdown ----
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('calendar', { size: 15 }), 'Clinic activity by day']),
        dailyRows.length
          ? el('div', {}, [
            dayChart(dailyRows),
            el('div', { class: 'chart-key' }, [
              el('span', { class: 'chart-key-item' }, [el('span', { class: 'chart-swatch chart-swatch--seen' }), 'Seen']),
              el('span', { class: 'chart-key-item' }, [el('span', { class: 'chart-swatch chart-swatch--done' }), 'Completed']),
            ]),
            el('details', { class: 'collapse', style: 'margin-top:14px' }, [
              el('summary', {}, [el('span', {}, ['Day-by-day numbers']), el('span', { class: 'subtle small' }, ['Show'])]),
              el('div', { class: 'collapse-body' }, [dailyTable(dailyRows)]),
            ]),
          ])
          : el('p', { class: 'muted' }, ['No activity recorded yet.']),
      ]),
    );
  }

  load().catch((e) => toast(e.message, 'error'));
  return root;
}

// How many of the people who signed up actually made it through the clinic —
// and whether the ones who booked online turn up and finish at the same rate as
// the ones registered at the desk. That comparison is the whole point of the
// pre-registration link, and nothing in the app was answering it.
function signupCard(d) {
  const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);
  const row = (label, signed, out, hint) => {
    const p = pct(out, signed);
    return el('div', { class: 'signup-row' }, [
      el('div', { class: 'signup-label' }, [
        el('strong', {}, [label]),
        hint ? el('div', { class: 'subtle small' }, [hint]) : null,
      ]),
      el('div', { class: 'signup-nums' }, [
        el('span', { class: 'mono signup-n' }, [String(signed)]),
        el('span', { class: 'subtle small' }, ['signed up']),
      ]),
      el('div', { class: 'signup-nums' }, [
        el('span', { class: 'mono signup-n' }, [String(out)]),
        el('span', { class: 'subtle small' }, ['checked out']),
      ]),
      el('div', { class: 'signup-bar' }, [
        el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.max(2, p)}%` })]),
        el('span', { class: 'mono signup-pct' }, [p + '%']),
      ]),
    ]);
  };
  const share = (n) => (d.total ? Math.round((n / d.total) * 100) : 0);
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [icon('users', { size: 15 }), 'Sign-ups vs check-outs']),
    el('p', { class: 'muted small', style: 'margin:0 0 var(--space-4)' }, [
      `${d.checkedOut} of ${d.total} patient(s) who signed up were checked out — `,
      el('strong', {}, [d.outPct + '%']),
      '. The rest are still in the clinic or did not complete their visit.',
    ]),
    el('div', { class: 'signup-table' }, [
      row('Pre-registered online', d.preSignups, d.preFinished, `${share(d.preSignups)}% of all sign-ups`),
      row('Registered on site', d.onSiteSignups, d.onSiteFinished, `${share(d.onSiteSignups)}% of all sign-ups`),
      el('div', { class: 'signup-row signup-row--total' }, [
        el('div', { class: 'signup-label' }, [el('strong', {}, ['All patients'])]),
        el('div', { class: 'signup-nums' }, [el('span', { class: 'mono signup-n' }, [String(d.total)]), el('span', { class: 'subtle small' }, ['signed up'])]),
        el('div', { class: 'signup-nums' }, [el('span', { class: 'mono signup-n' }, [String(d.checkedOut)]), el('span', { class: 'subtle small' }, ['checked out'])]),
        el('div', { class: 'signup-bar' }, [
          el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.max(2, d.outPct)}%` })]),
          el('span', { class: 'mono signup-pct' }, [d.outPct + '%']),
        ]),
      ]),
    ]),
  ]);
}

// The report for a clinic whose patient records have been removed. The people
// are gone; these de-identified totals were kept precisely so the clinic can
// still answer a grant return, so they are shown in full rather than as zeros.
function archivedView(rec, events, scopeSel, reload) {
  const sm = rec.summary || {};
  const finishedAt = rec.finished_at ? new Date(rec.finished_at).toLocaleString() : '—';
  const bars = (title, obj, opts) => (obj && Object.keys(obj).length
    ? el('div', { class: 'demo-group' }, [
      el('div', { class: 'demo-h' }, [title, el('span', { class: 'demo-n mono' }, [String(Object.values(obj).reduce((a, b) => a + b, 0))])]),
      barList(obj, opts),
    ])
    : null);
  // The summary stores raw codes so it stays language-neutral on disk; label
  // them here the same way the live report does.
  const relabel = (obj, fn) => {
    const out = {};
    Object.entries(obj || {}).forEach(([k, v]) => { const label = fn(k); out[label] = (out[label] || 0) + v; });
    return out;
  };
  const CONDITION_LABEL = Object.fromEntries(conditions().map((c) => [c.key, c.label]));
  const condObj = relabel(sm.conditions, (k) => CONDITION_LABEL[k]
    || String(k).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
  const genderObj = relabel(sm.by_gender, (k) => (k === 'Not recorded' ? k : genderLabel(k)));
  const langObj = relabel(sm.by_language, (k) => (k === 'Not recorded' ? k : langLabel(k)));
  const dayObj = relabel(sm.by_day, (k) => (/^\d{4}-\d{2}-\d{2}$/.test(k) ? fmtDay(k) : k));

  return el('div', {}, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h1', {}, ['Reports & analytics']),
        el('p', { class: 'view-sub' }, [sm.event_name || rec.event_name || 'Archived clinic', sm.event_location ? ' · ' + sm.event_location : '']),
      ]),
      el('div', { class: 'view-head-actions' }, [scopeSel, el('button', { class: 'btn btn--ghost btn--sm', onClick: reload }, [icon('refresh', { size: 15 }), 'Refresh'])]),
    ]),
    el('div', { class: 'banner banner--locked' }, [
      icon('database', { size: 16 }),
      el('span', {}, [
        'This clinic’s patient records have been removed. These are the kept reporting totals — figures only, no patient information. Finished ',
        finishedAt, rec.finished_by_name ? ' by ' + rec.finished_by_name : '', '.',
      ]),
    ]),
    el('div', { class: 'kpi-grid' }, [
      kpi('users', sm.patients_seen || 0, 'Patients seen', { accent: true }),
      kpi('checkCircle', sm.visits_completed || 0, 'Visits finished', {
        sub: sm.patients_seen ? Math.round(((sm.visits_completed || 0) / sm.patients_seen) * 100) + '% of ' + sm.patients_seen : null,
      }),
      kpi('xray', sm.xrays || 0, 'X-rays taken'),
      kpi('tooth', sm.extractions || 0, 'Extractions'),
      kpi('pen', sm.fillings || 0, 'Fillings'),
      kpi('scan', sm.cleanings || 0, 'Cleanings'),
    ]),
    el('div', { class: 'dash-grid' }, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('users', { size: 15 }), 'Patient demographics']),
        bars('By gender', genderObj, { sort: false }),
        bars('By age', sm.by_age, { sort: false }),
        bars('By language', langObj, { limit: 4 }),
        bars('By city', sm.by_city, { limit: 6 }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Most common conditions']),
        Object.keys(condObj).length ? barList(condObj, { limit: 8 }) : el('p', { class: 'muted' }, ['No conditions recorded.']),
        el('div', { class: 'card-sub-title', style: 'margin-top:var(--space-4)' }, ['Patients by day']),
        (dayObj && Object.keys(dayObj).length)
          ? barList(dayObj, { sort: false })
          : el('p', { class: 'muted' }, ['No daily breakdown kept.']),
      ]),
    ]),
  ]);
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
function demoGroup(title, counts, order, opts = {}) {
  const keys = order.filter((k) => counts[k]);
  Object.keys(counts).forEach((k) => { if (!keys.includes(k)) keys.push(k); });
  const obj = {};
  keys.forEach((k) => { obj[k] = counts[k]; });
  const n = keys.reduce((t, k) => t + counts[k], 0);
  return el('div', { class: 'demo-group' }, [
    el('div', { class: 'demo-h' }, [title, el('span', { class: 'demo-n mono' }, [String(n)])]),
    keys.length ? barList(obj, opts) : el('p', { class: 'muted small' }, ['No data yet.']),
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
// Ranked bars. Biggest first, because the question a clinic asks of any of
// these lists is "which is the most" — and each row carries its share of the
// total, which is what a grant return actually asks for.
function barList(obj, opts = {}) {
  const entries = Object.entries(obj).filter(([, v]) => v != null);
  if (opts.sort !== false) entries.sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const sum = entries.reduce((n, [, v]) => n + v, 0);
  const limit = opts.limit || entries.length;
  const shown = entries.slice(0, limit);
  const rest = entries.slice(limit);

  const rowFor = ([k, v]) => el('div', { class: 'bar-row' }, [
    el('span', { class: 'bar-label', title: k }, [k]),
    el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.max(2, Math.round((v / max) * 100))}%` })]),
    el('span', { class: 'bar-val mono' }, [String(v)]),
    el('span', { class: 'bar-pct mono' }, [sum ? Math.round((v / sum) * 100) + '%' : '—']),
  ]);

  const list = el('div', { class: 'bar-list' }, shown.map(rowFor));
  if (!rest.length) return list;
  // Long tails (cities, languages) stay out of the way until asked for.
  const more = el('div', { class: 'bar-list', style: 'display:none' }, rest.map(rowFor));
  const toggle = el('button', {
    class: 'btn btn--ghost btn--sm', style: 'margin-top:8px',
    onClick: () => {
      const open = more.style.display !== 'none';
      more.style.display = open ? 'none' : '';
      toggle.textContent = open ? `Show ${rest.length} more` : 'Show fewer';
    },
  }, [`Show ${rest.length} more`]);
  return el('div', {}, [list, more, toggle]);
}

// A compact column chart of the clinic day — the shape of the week at a glance,
// which a table of numbers does not give you.
function dayChart(rows) {
  const max = Math.max(1, ...rows.map((d) => d.seen));
  return el('div', { class: 'day-chart' }, rows.map((d) => {
    const h = Math.max(3, Math.round((d.seen / max) * 100));
    return el('div', { class: 'day-col', title: `${fmtDay(d.date)} — ${d.seen} seen, ${d.completed} completed` }, [
      el('div', { class: 'day-bar-wrap' }, [
        el('div', { class: 'day-bar', style: `height:${h}%` }, [
          d.completed ? el('div', { class: 'day-bar-done', style: `height:${Math.round((d.completed / Math.max(1, d.seen)) * 100)}%` }) : null,
        ]),
      ]),
      el('div', { class: 'day-n mono' }, [String(d.seen)]),
      el('div', { class: 'day-label' }, [fmtDay(d.date)]),
    ]);
  }));
}

// ---- Email visit summaries: checked-out patients who left an email ----
function patientEmail(p) { return p.email || (p.demographics && p.demographics.email) || ''; }
function emailCard(full) {
  const list = (full || []).filter((p) => patientEmail(p) && (p.status === 'completed' || p.status === 'dismissed'));
  const head = el('div', { class: 'card-head-row' }, [
    el('h3', { class: 'card-title' }, [icon('mail', { size: 15 }), 'Email visit summaries']),
    list.length ? el('button', { class: 'btn btn--ghost btn--sm', onClick: async () => {
      const emails = list.map(patientEmail).join(', ');
      try { if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(emails); toast('All emails copied', 'success'); }
      catch (_) { toast(emails, 'info'); }
    } }, [icon('save', { size: 14 }), 'Copy all emails']) : null,
  ]);
  const rows = list.map((p) => el('div', { class: 'lookup-row' }, [
    el('div', { style: 'min-width:0' }, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]), el('div', { class: 'subtle small' }, [patientEmail(p)])]),
    el('button', { class: 'btn btn--ghost btn--sm', onClick: () => {
      const mail = `mailto:${encodeURIComponent(patientEmail(p))}?subject=${encodeURIComponent('Your Caring Hands visit summary')}&body=${encodeURIComponent('Your visit summary from Caring Hands Worldwide is attached.')}`;
      api.openExternal(mail);
    } }, [icon('mail', { size: 14 }), 'Email']),
  ]));
  return el('div', { class: 'card' }, [
    head,
    el('p', { class: 'subtle small', style: 'margin:0 0 10px' }, [`${list.length} checked-out patient(s) left an email address — email their summary a couple of days after the clinic.`]),
    list.length ? el('div', { class: 'lookup-results', style: 'max-height:40vh' }, rows) : el('p', { class: 'muted' }, ['No checked-out patients with an email yet.']),
    el('p', { class: 'subtle', style: 'font-size:var(--fs-2xs);margin-top:10px' }, ['Emailing opens your mail app with a ready draft — attach the patient’s summary PDF (from Records, or the clinic ZIP export). Fully automatic delayed sending needs a mail service; ask your admin.']),
  ]);
}
