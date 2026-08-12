import { el, clear, toast, modal } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { statusPill } from './dashboard.js';

// v1.4.0 — Admin management console. A live, cloud-synced overview of every
// patient in the clinic where an administrator can override the flow: move a
// patient to any stage, re-open a finished record, check them out, or remove a
// bad record. Also surfaces the cloud connection so the admin can confirm the
// whole system is talking to the shared server.
const routeLabel = (r) => (r === 'dentist' ? 'Dentist' : r === 'hygienist' ? 'Hygienist' : r === 'both' ? 'Dentist + Hygienist' : '—');
const fmtTime = (ts) => { if (!ts) return ''; const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleTimeString(); };

export function renderManagement(ctx) {
  const root = el('div', { class: 'view' });
  paint();
  return root;

  async function paint() {
    let patients = [];
    try { patients = await api.listPatients({}); } catch (e) { patients = []; }
    const live = patients.filter((p) => p.status !== 'dismissed');
    const done = patients.filter((p) => p.status === 'dismissed');
    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('div', {
            style: 'font-size:var(--fs-2xs); text-transform:uppercase; letter-spacing:var(--tracking-eyebrow); color:var(--teal-deep); font-weight:var(--fw-semibold); margin-bottom:var(--space-1);',
          }, ['Helping hands for healthy living']),
          el('h1', {}, ['Management']),
          el('p', { class: 'view-sub' }, ['Oversee every patient in the clinic and override the flow when you need to.']),
        ]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: paint }, [icon('refresh', { size: 15 }), 'Refresh']),
      ]),
      cloudCard(),
      tableCard(`In the clinic (${live.length})`, live, false),
      done.length ? tableCard(`Checked out today (${done.length})`, done, true) : el('span'),
    );
  }

  /* ---------- Cloud connection card ---------- */
  function cloudCard() {
    const body = el('div', { class: 'inline-row', style: 'gap:var(--space-3); flex-wrap:wrap; align-items:center;' }, [
      el('span', { class: 'subtle small' }, ['Checking cloud…']),
    ]);
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Cloud connection']),
      body,
    ]);
    (async () => {
      let st = null;
      try { st = await api.cloudStatus(); } catch (_) { st = null; }
      clear(body);
      if (!st) { body.append(el('span', { class: 'subtle small' }, ['Cloud status unavailable.'])); return; }
      const pill = st.online
        ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), st.lastError ? 'Reconnecting' : (st.lastOk ? 'Online · synced ' + fmtTime(st.lastOk) : 'Online')])
        : el('span', { class: 'pill pill--neutral' }, ['Offline mode']);
      body.append(
        pill,
        el('span', { class: 'subtle small' }, [`pushed ${st.pushed || 0} · pulled ${st.pulled || 0} · applied ${st.applied || 0}`]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: async () => { try { await api.cloudSyncNow(); toast('Sync run', 'success'); paint(); } catch (e) { toast(e.message, 'error'); } } }, [icon('refresh', { size: 14 }), 'Sync now']),
        st.url ? el('button', { class: 'btn btn--ghost btn--sm', title: 'Open the server health page in your browser', onClick: () => api.openExternal(String(st.url).replace(/\/+$/, '') + '/health') }, [icon('globe', { size: 14 }), 'Open server page']) : el('span'),
      );
    })();
    return card;
  }

  /* ---------- Patient table ---------- */
  function tableCard(title, list, isDone) {
    const rows = list.map((p) => el('tr', {}, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]), p.on_thinner ? el('span', { class: 'pill pill--danger', style: 'margin-left:6px' }, ['Blood thinner']) : el('span')]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [el('span', { class: p.route ? 'pill pill--teal' : 'subtle small' }, [routeLabel(p.route)])]),
      el('td', {}, [actions(p, isDone)]),
    ]));
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [icon('records', { size: 15 }), title]),
      el('div', { class: 'data-table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Stage', 'Going to', 'Manage'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 5, class: 'empty' }, ['No patients.'])])]),
        ]),
      ]),
    ]);
  }

  function actions(p, isDone) {
    const move = async (target, verb) => {
      try { await api.movePatient(p.id, target); toast(`${p.first_name} ${p.last_name} — ${verb}`, 'success'); paint(); }
      catch (e) { toast(e.message, 'error'); }
    };
    const btn = (ic, label, onClick, cls) => el('button', { class: `btn ${cls || 'btn--ghost'} btn--sm`, onClick }, [icon(ic, { size: 14 }), label]);
    const wrap = el('div', { class: 'inline-row', style: 'margin:0; gap:6px; flex-wrap:wrap; justify-content:flex-end;' });
    // Open the patient in the station that matches their stage.
    wrap.append(btn('chevron', 'Open', () => ctx.navigate(stationFor(p), { id: p.id })));
    // Backward moves first (walking a patient back up the flow), then forward.
    // "Check-in" is the full rewind: not confirmed present, not signed off, not
    // assigned onward — their recorded vitals are kept.
    const backToCheckin = btn('clipboard', 'Check-in', () => move('checkin', 'sent back to check-in'), 'btn--soft');
    backToCheckin.title = 'Send all the way back to the front desk — the patient must be confirmed present again. Recorded vitals are kept.';
    if (isDone) {
      wrap.append(
        btn('refresh', 'Re-open', () => move('reopen', 're-opened for editing'), 'btn--soft'),
        backToCheckin,
      );
    } else {
      wrap.append(
        backToCheckin,
        btn('syringe', 'EMT', () => move('emt', 'sent back to vitals')),
        btn('tooth', 'Dentist', () => move('dentist', 'sent to the dentist')),
        btn('sparkle', 'Hygienist', () => move('hygienist', 'sent to the hygienist')),
        btn('checkCircle', 'Check out', () => move('dismiss', 'checked out'), 'btn--soft'),
      );
    }
    wrap.append(el('button', {
      class: 'btn btn--danger btn--sm', title: 'Delete this patient record',
      onClick: async () => {
        const ok = await modal({ title: 'Delete patient record?', body: `Permanently delete ${p.first_name} ${p.last_name}'s record? This cannot be undone.`, confirmText: 'Delete', cancelText: 'Cancel' });
        if (!ok) return;
        try { await api.deletePatient(p.id); toast('Record deleted', 'success'); paint(); } catch (e) { toast(e.message, 'error'); }
      },
    }, [icon('trash', { size: 14 })]));
    return wrap;
  }

  function stationFor(p) {
    if (p.status === 'checked_in') return store.can('admin', 'emt', 'triage') ? 'emt' : 'records';
    if (p.status === 'dismissed' || p.status === 'completed') return store.can('admin', 'checkout') ? 'checkout' : 'records';
    if (p.route === 'hygienist') return store.can('admin', 'hygienist') ? 'hygienist' : 'records';
    return store.can('admin', 'doctor') ? 'provider' : 'records';
  }
}
