import { el, clear, toast } from '../dom.js';
import { conditions } from '../i18n.js';
import { api } from '../api.js';

export function renderReports(ctx) {
  const root = el('div', { class: 'view' });

  async function load() {
    const [event, patients] = await Promise.all([api.activeEvent(), api.listPatients({})]);

    // Aggregate simple event statistics.
    const total = patients.length;
    const byStatus = count(patients, (p) => p.status);
    const langs = count(patients, (p) => (p.language === 'es' ? 'Spanish' : 'English'));

    // Pull treatment counts by fetching full records (offline + local; fine for event volume).
    const full = await Promise.all(patients.map((p) => api.getPatient(p.id)));
    let fillings = 0, extractions = 0, cleanings = 0, xrays = 0, flagged = 0, completed = 0;
    full.forEach((p) => {
      const tx = p.treatment || {};
      fillings += (tx.fillings || []).length;
      extractions += (tx.extractions || []).length;
      if (Object.values(tx.cleaning || {}).some(Boolean)) cleanings += 1;
      xrays += (p.xrays || []).length;
      if (p.triage && (p.triage.flags || []).length) flagged += 1;
      if (p.status === 'completed') completed += 1;
    });

    const condCounts = {};
    full.forEach((p) => (p.medical_history.conditions || []).forEach((k) => { condCounts[k] = (condCounts[k] || 0) + 1; }));
    const topConds = conditions().map((c) => ({ label: c.label, n: condCounts[c.key] || 0 })).filter((c) => c.n).sort((a, b) => b.n - a.n).slice(0, 8);

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, ['Event Report']), el('p', { class: 'view-sub' }, [event ? event.name : 'No active event'])]),
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: load }, ['↻ Refresh']),
          el('button', { class: 'btn btn--primary btn--sm', onClick: async () => {
            try { const r = await api.exportEvent(); if (r.saved) toast(`Exported ${r.count} record(s)`, 'success'); } catch (e) { toast(e.message, 'error'); }
          } }, ['⬇ Export JSON']),
        ]),
      ]),
      el('div', { class: 'stat-row' }, [
        bigStat(total, 'Patients seen', 'stat--blue'),
        bigStat(completed, 'Completed', 'stat--green'),
        bigStat(extractions, 'Extractions', 'stat--purple'),
        bigStat(fillings, 'Fillings', 'stat--teal'),
        bigStat(cleanings, 'Cleanings', 'stat--amber'),
        bigStat(xrays, 'X-rays', 'stat--blue'),
      ]),
      el('div', { class: 'split' }, [
        el('div', { class: 'col' }, [
          el('div', { class: 'card' }, [el('h3', { class: 'card-title' }, ['Patients by status']), barList(byStatus, total)]),
          el('div', { class: 'card' }, [el('h3', { class: 'card-title' }, ['Language']), barList(langs, total)]),
        ]),
        el('div', { class: 'col col--wide' }, [
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Most common medical conditions']),
            topConds.length ? barList(Object.fromEntries(topConds.map((c) => [c.label, c.n])), total) : el('p', { class: 'muted' }, ['No conditions recorded yet.']),
          ]),
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Clinical awareness']),
            el('p', {}, [el('strong', {}, [String(flagged)]), ' patient(s) flagged with medical conditions requiring awareness.']),
          ]),
        ]),
      ]),
    );
  }

  load().catch((e) => toast(e.message, 'error'));
  return root;
}

function count(arr, fn) {
  const out = {};
  arr.forEach((x) => { const k = fn(x) || 'Unknown'; out[k] = (out[k] || 0) + 1; });
  return out;
}
function bigStat(value, label, cls) {
  return el('div', { class: `stat-card ${cls}` }, [el('div', { class: 'stat-value' }, [String(value)]), el('div', { class: 'stat-label' }, [label])]);
}
function barList(obj, total) {
  const max = Math.max(1, ...Object.values(obj));
  return el('div', { class: 'bar-list' }, Object.entries(obj).map(([k, v]) => el('div', { class: 'bar-row' }, [
    el('span', { class: 'bar-label' }, [k]),
    el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.round((v / max) * 100)}%` })]),
    el('span', { class: 'bar-val' }, [String(v)]),
  ])));
}
