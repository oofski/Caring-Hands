import { el, mount, modal, clear } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../icons.js';

// The clinic pipeline as visual columns — where every patient physically is,
// live. Computed from each patient's status + route + whether vitals are in.
const STAGES = [
  { key: 'checkin', label: 'Checked in', color: 'var(--info)' },
  { key: 'vitals', label: 'Vitals', color: 'var(--accent)' },
  { key: 'ready', label: 'Ready for treatment', color: 'var(--accent)' },
  { key: 'hygienist', label: 'Hygienist', color: 'var(--warning)' },
  { key: 'dentist', label: 'Dentist', color: 'var(--warning)' },
  { key: 'done', label: 'Checked out', color: 'var(--success)' },
];
function stageOf(p) {
  if (p.status === 'completed' || p.status === 'dismissed') return 'done';
  if (p.status === 'in_treatment') return p.route === 'hygienist' ? 'hygienist' : 'dentist';
  if (p.status === 'triaged') return 'ready';
  return p.has_vitals ? 'vitals' : 'checkin'; // checked_in
}
function minsSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 60000));
}
const waitLabel = (m) => (m == null ? '' : (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`));
// Minutes between two timestamps (to defaults to now) — for the board's time tags.
function elapsedMins(fromIso, toIso) {
  if (!fromIso) return null;
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  const ms = to - new Date(fromIso).getTime();
  if (isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 60000));
}
// When does a patient's clinic clock start? A pre-registered patient filled the
// form online — often days ahead — but hasn't physically arrived until they're
// taken to Vitals. So their total time only starts at Vitals, not at pre-reg.
// Walk-ins start at check-in (created_at). Returns null while a pre-reg patient
// is still waiting to arrive, which suppresses the time chips entirely.
function clockStart(p) {
  if (p.preregistered && !p.has_vitals) return null; // pre-reg, not yet arrived
  if (p.preregistered) return p.vitals_at || p.created_at; // clock starts at Vitals
  return p.created_at;
}
// Best-available timestamp for when the patient entered their CURRENT stage.
function stageEnteredAt(p) {
  if (p.status === 'dismissed') return p.dismissed_at || p.routed_at || p.vitals_at || p.created_at;
  if (p.status === 'completed' || p.status === 'in_treatment' || p.status === 'triaged') return p.routed_at || p.vitals_at || p.created_at;
  if (p.preregistered && !p.has_vitals) return null; // pre-reg not arrived — clock not started
  return p.has_vitals ? (p.vitals_at || p.created_at) : p.created_at; // checked_in
}

export function renderDashboard(ctx) {
  const root = el('div', { class: 'view' });

  async function load() {
    const [stats, event, patients] = await Promise.all([
      api.dashboard(), api.activeEvent(), api.listPatients({}),
    ]);
    store.setEvent(event);

    // Which view each KPI card opens, for the current role (null = not clickable).
    const can = (...r) => store.can(...r);
    function navFor(kind) {
      if (kind === 'vitals') return can('admin', 'emt', 'triage') ? 'emt' : null;
      if (kind === 'ready' || kind === 'treatment') {
        if (can('admin', 'doctor')) return 'provider';
        if (can('hygienist')) return 'hygienist';
        if (can('emt', 'triage')) return 'emt';
        return null;
      }
      if (kind === 'done') return can('admin', 'checkout') ? 'checkout' : (can('doctor') ? 'records' : null);
      // 'all' → the role's live patient list
      if (store.is('admin')) return 'management';
      if (can('emt', 'triage')) return 'emt';
      if (can('doctor')) return 'provider';
      if (can('hygienist')) return 'hygienist';
      if (can('checkout')) return 'checkout';
      return null;
    }

    // "Checked out" = the board's final column (completed + dismissed), so the
    // KPI tile and the board column always agree.
    const checkedOut = patients.filter((p) => p.status === 'completed' || p.status === 'dismissed').length;
    const statCards = [
      { label: t('dash.total'), value: stats.total, ic: 'users', kind: 'all' },
      { label: t('dash.waiting'), value: stats.waiting_triage, ic: 'syringe', warn: stats.waiting_triage > 0, kind: 'vitals' },
      { label: t('dash.triaged'), value: stats.triaged, ic: 'clipboard', kind: 'ready' },
      { label: t('dash.inTreatment'), value: stats.in_treatment, ic: 'tooth', kind: 'treatment' },
      { label: 'Checked out', value: checkedOut, ic: 'checkCircle', kind: 'done' },
    ];

    // Route "open" to a view the current role may actually see.
    function openByStatus(p) {
      const go = (view) => ctx.navigate(view, { id: p.id });
      const canEmt = store.can('admin', 'emt', 'triage');
      const canRecords = store.can('admin', 'doctor', 'checkout');
      if (p.status === 'checked_in') {
        if (canEmt) go('emt');
        else if (canRecords) go('records');
        else ctx.toast('This patient is waiting for vitals at the EMT station.', 'info');
      } else if (p.status === 'triaged' || p.status === 'in_treatment') {
        if (store.can('admin', 'doctor')) go('provider');
        else if (store.can('admin', 'hygienist')) go('hygienist');
        else if (canEmt) go('emt');
        else if (canRecords) go('records');
        else ctx.toast('This patient is with a treatment provider.', 'info');
      } else {
        if (store.can('admin', 'checkout')) go('checkout');
        else if (canRecords) go('records');
        else if (store.can('admin', 'doctor')) go('provider');
        else ctx.toast('This visit is finished — check-out has the record.', 'info');
      }
    }

    // Returning patient: search anyone seen before and start a fresh visit that
    // carries over their details (no re-typing a whole new patient).
    function returningPatient() {
      return new Promise((resolve) => {
        const overlay = el('div', { class: 'modal-overlay' });
        const card = el('div', { class: 'modal-card' });
        const done = (v) => { overlay.remove(); resolve(v); };
        const input = el('input', { class: 'input', placeholder: 'Search name, phone, or date of birth…' });
        const results = el('div', { class: 'lookup-results' });
        let timer = null;
        async function search() {
          const term = input.value.trim();
          clear(results);
          if (term.length < 2) { results.append(el('p', { class: 'subtle small', style: 'margin:8px 0 0' }, ['Type at least 2 characters to search.'])); return; }
          let list = [];
          try { list = await api.searchAll(term); } catch (err) { results.append(el('p', { class: 'subtle small' }, [err.message])); return; }
          if (!list.length) { results.append(el('p', { class: 'subtle small', style: 'margin:8px 0 0' }, ['No match. Use “Start patient check-in” for a brand-new patient.'])); return; }
          list.slice(0, 12).forEach((p) => {
            results.append(el('div', { class: 'lookup-row' }, [
              el('div', { style: 'min-width:0' }, [
                el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
                el('div', { class: 'subtle small' }, [`${p.dob ? 'DOB ' + p.dob + ' · ' : ''}${p.event_name || ''}`]),
              ]),
              el('button', { class: 'btn btn--primary btn--sm', onClick: async (ev) => {
                ev.currentTarget.disabled = true;
                try { const np = await api.newVisit(p.id); ctx.toast(`New visit started for ${np.first_name} ${np.last_name}`, 'success'); done(true); load(); }
                catch (err) { ctx.toast(err.message, 'error'); ev.currentTarget.disabled = false; }
              } }, ['Start new visit']),
            ]));
          });
        }
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
        card.append(
          el('h3', { class: 'modal-title' }, ['Returning patient — look up']),
          el('div', { class: 'modal-body' }, [
            el('p', { class: 'subtle small', style: 'margin:0 0 8px' }, ['Find someone seen before and start a fresh visit — their details carry over so you don’t re-type everything.']),
            input, results,
          ]),
          el('div', { class: 'modal-actions' }, [el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => done(false) }, ['Close'])]),
        );
        overlay.append(card);
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) done(false); });
        document.body.append(overlay);
        setTimeout(() => input.focus(), 0);
      });
    }

    // ---- Live CRM board ----
    const groups = {}; STAGES.forEach((s) => { groups[s.key] = []; });
    patients.forEach((p) => { groups[stageOf(p)].push(p); });

    const crmCard = (p) => {
      const foot = [];
      if (p.preregistered) foot.push(el('span', { class: 'crm-chip crm-chip--prereg', title: 'Pre-registered online — confirm arrival' }, ['Pre-reg']));
      // Confirmed present by the front desk (Arrivals), so the floor can tell a
      // patient who is actually here from one who has only checked in on paper.
      if (p.status === 'checked_in' && p.arrived_at) foot.push(el('span', { class: 'crm-chip crm-chip--ok', title: 'Front desk confirmed this patient is here' }, [icon('check', { size: 10 }), 'Here']));
      if (p.status === 'dismissed') foot.push(el('span', { class: 'crm-chip crm-chip--left', title: 'Checked out — the patient has left' }, [icon('check', { size: 10 }), 'Left']));
      // Two time tags: total time and time at the current stage. Pre-registered
      // patients don't start the clock until they arrive at Vitals, so both are
      // suppressed (clockStart/stageEnteredAt return null) until then.
      const endIso = p.status === 'dismissed' ? p.dismissed_at : null;
      const total = elapsedMins(clockStart(p), endIso);
      const stage = elapsedMins(stageEnteredAt(p), endIso);
      if (total != null) foot.push(el('span', { class: 'crm-chip', title: 'Total time since arrival at Vitals' }, [icon('calendar', { size: 10 }), waitLabel(total) + ' total']));
      if (stage != null) foot.push(el('span', { class: 'crm-chip crm-chip--stage', title: 'Time at this stage' }, [waitLabel(stage) + ' here']));
      if (p.on_thinner) foot.push(el('span', { class: 'crm-chip crm-chip--warn', title: 'On blood thinner — verify before extraction' }, ['Thinner']));
      return el('button', { class: 'crm-card', onClick: () => openByStatus(p) }, [
        el('div', { class: 'crm-card-top' }, [
          el('strong', { class: 'crm-card-name' }, [`${p.last_name}, ${p.first_name}`]),
          (p.flags && p.flags.length) ? el('span', { class: 'flag-dot', title: `${p.flags.length} medical flag(s)` }, [icon('flag', { size: 11 }), String(p.flags.length)]) : null,
        ]),
        el('div', { class: 'crm-card-meta' }, [`${p.age != null ? p.age + ' yrs' : ''}${p.complaint ? (p.age != null ? ' · ' : '') + p.complaint : ''}` || '—']),
        foot.length ? el('div', { class: 'crm-card-foot' }, foot) : null,
      ]);
    };
    const board = el('div', { class: 'crm-board' }, STAGES.map((s) => el('div', { class: 'crm-col' }, [
      el('div', { class: 'crm-col-head' }, [
        el('span', { class: 'crm-col-dot', style: `background:${s.color}` }),
        el('span', { class: 'crm-col-label' }, [s.label]),
        el('span', { class: 'crm-col-count' }, [String(groups[s.key].length)]),
      ]),
      el('div', { class: 'crm-col-body' }, groups[s.key].length ? groups[s.key].map(crmCard) : [el('div', { class: 'crm-empty' }, ['No patients here.'])]),
    ])));

    // mount() clears + skips null children.
    mount(root,
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('div', {
            style: 'font-size:var(--fs-2xs); letter-spacing:var(--tracking-eyebrow); text-transform:uppercase; font-weight:var(--fw-semibold); color:var(--accent-text); margin-bottom:var(--space-1);',
          }, ['Helping hands for healthy living']),
          el('h1', {}, [t('dash.title')]),
          el('p', { class: 'view-sub' }, [
            event ? `${t('dash.event')}: ` : '',
            el('strong', {}, [event ? event.name : t('dash.noEvent')]),
            event && event.location ? ` · ${event.location}` : '',
          ]),
        ]),
        el('div', { class: 'view-head-actions' }, [
          el('button', { class: 'btn btn--primary', onClick: () => ctx.navigate('kiosk') }, [icon('clipboard', { size: 16 }), t('dash.startCheckin')]),
          can('admin', 'registration', 'triage', 'emt', 'doctor')
            ? el('button', { class: 'btn btn--ghost', title: 'Look up a patient who has been seen before and start a new visit', onClick: () => returningPatient() }, [icon('search', { size: 15 }), 'Returning patient']) : null,
          el('button', { class: 'btn btn--ghost btn--sm', onClick: load }, [icon('refresh', { size: 15 }), 'Refresh']),
        ]),
      ]),

      // Clickable KPI cards — each opens its stage's station.
      el('div', { class: 'stat-row' }, statCards.map((s) => {
        const target = navFor(s.kind);
        const kids = [
          el('div', { class: 'stat-head' }, [icon(s.ic, { size: 16 })]),
          el('div', { class: 'stat-value' + (s.warn ? ' stat-value--warn' : '') }, [String(s.value)]),
          el('div', { class: 'stat-label' }, [s.label]),
        ];
        return target
          ? el('button', { class: 'stat-card stat-card--link', title: `Open ${s.label}`, onClick: () => ctx.navigate(target) }, kids)
          : el('div', { class: 'stat-card' }, kids);
      })),

      el('div', { class: 'section-title-row' }, [
        el('h2', { class: 'section-title' }, ['Patient flow']),
        el('span', { class: 'live-badge' }, [el('span', { class: 'dot' }), 'Live']),
      ]),
      el('div', { class: 'card crm-card-wrap' }, [board]),
      !patients.length ? el('p', { class: 'muted', style: 'margin-top:10px' }, ['No patients checked in yet — tap “Start patient check-in” to begin.']) : null,
    );
  }

  load().catch((e) => ctx.toast(e.message, 'error'));
  // Live refresh so the board reflects where patients are without a manual reload.
  // unref() keeps this from holding the process open in the test harness.
  const timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); return; }
    load().catch(() => {});
  }, 15000);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return root;
}

export function statusPill(status) {
  const map = {
    checked_in: ['Checked in', 'pill--info'],
    triaged: ['Ready for treatment', 'pill--info'],
    in_treatment: ['In treatment', 'pill--warning'],
    completed: ['Completed', 'pill--success'],
    dismissed: ['Checked out', 'pill--neutral'],
  };
  const [label, cls] = map[status] || [status, 'pill--neutral'];
  return el('span', { class: `pill ${cls}` }, [el('span', { class: 'pill-dot' }), label]);
}
