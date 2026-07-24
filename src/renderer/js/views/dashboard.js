import { el, mount } from '../dom.js';
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

    const statCards = [
      { label: t('dash.total'), value: stats.total, ic: 'users', kind: 'all' },
      { label: t('dash.waiting'), value: stats.waiting_triage, ic: 'syringe', warn: stats.waiting_triage > 0, kind: 'vitals' },
      { label: t('dash.triaged'), value: stats.triaged, ic: 'clipboard', kind: 'ready' },
      { label: t('dash.inTreatment'), value: stats.in_treatment, ic: 'tooth', kind: 'treatment' },
      { label: t('dash.completed'), value: stats.completed, ic: 'checkCircle', kind: 'done' },
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

    // ---- Live CRM board ----
    const groups = {}; STAGES.forEach((s) => { groups[s.key] = []; });
    patients.forEach((p) => { groups[stageOf(p)].push(p); });

    const crmCard = (p) => {
      const foot = [];
      if (p.preregistered) foot.push(el('span', { class: 'crm-chip crm-chip--prereg', title: 'Pre-registered online — confirm arrival' }, ['Pre-reg']));
      const wl = waitLabel(minsSince(p.created_at));
      if (wl) foot.push(el('span', { class: 'crm-chip', title: 'Time since check-in' }, [icon('calendar', { size: 10 }), wl]));
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
