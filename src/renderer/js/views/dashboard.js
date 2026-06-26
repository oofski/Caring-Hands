import { el, clear } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../icons.js';

export function renderDashboard(ctx) {
  const root = el('div', { class: 'view' });

  async function load() {
    const [stats, event, patients] = await Promise.all([
      api.dashboard(), api.activeEvent(), api.listPatients({}),
    ]);
    store.setEvent(event);

    const statCards = [
      { label: t('dash.total'), value: stats.total, ic: 'users' },
      { label: t('dash.waiting'), value: stats.waiting_triage, ic: 'triage', warn: stats.waiting_triage > 0 },
      { label: t('dash.triaged'), value: stats.triaged, ic: 'clipboard' },
      { label: t('dash.inTreatment'), value: stats.in_treatment, ic: 'tooth' },
      { label: t('dash.completed'), value: stats.completed, ic: 'checkCircle' },
    ];

    const qa = (cls, ic, title, sub, onClick) => el('button', { class: 'qa-card' + cls, onClick }, [
      el('span', { class: 'qa-icon' }, [icon(ic, { size: 18 })]),
      el('span', {}, [el('strong', {}, [title]), el('small', {}, [sub])]),
    ]);
    const quick = el('div', { class: 'quick-actions' }, [
      store.can('admin', 'triage') ? qa(' qa-card--primary', 'clipboard', t('dash.startCheckin'), 'Hand the device to a patient', () => ctx.navigate('kiosk')) : null,
      store.can('admin', 'doctor', 'triage') ? qa('', 'triage', t('dash.viewQueue'), `${stats.waiting_triage} waiting`, () => ctx.navigate('triage')) : null,
      store.can('admin', 'doctor') ? qa('', 'tooth', 'Provider queue', `${stats.triaged} ready`, () => ctx.navigate('provider')) : null,
      store.can('admin') ? qa('', 'database', 'Back up to USB', 'Save a full database copy', async () => {
        try { const r = await api.backup(); if (r.saved) ctx.toast(`Backed up to ${r.path}`, 'success'); } catch (e) { ctx.toast(e.message, 'error'); }
      }) : null,
    ]);

    const recent = el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Status', ''].map((h) => el('th', {}, [h])))]),
      el('tbody', {}, patients.slice(0, 12).map((p) => el('tr', {}, [
        el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
          (p.flags && p.flags.length) ? el('span', { class: 'flag-dot', title: `${p.flags.length} medical flag(s)` }, [icon('flag', { size: 13 }), String(p.flags.length)]) : null]),
        el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
        el('td', {}, [p.complaint || '—']),
        el('td', {}, [statusPill(p.status)]),
        el('td', {}, [el('button', { class: 'btn btn--ghost btn--sm', onClick: () => openByStatus(p) }, ['Open'])]),
      ]))),
    ]);
    if (!patients.length) recent.querySelector('tbody').append(el('tr', {}, [el('td', { colspan: 5, class: 'empty' }, ['No patients checked in yet.'])]));

    function openByStatus(p) {
      if (p.status === 'checked_in') ctx.navigate('triage', { id: p.id });
      else if (store.can('admin', 'doctor')) ctx.navigate('provider', { id: p.id });
      else ctx.navigate('triage', { id: p.id });
    }

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('h1', {}, [t('dash.title')]),
          el('p', { class: 'view-sub' }, [
            event ? `${t('dash.event')}: ` : '',
            el('strong', {}, [event ? event.name : t('dash.noEvent')]),
            event && event.location ? ` · ${event.location}` : '',
          ]),
        ]),
      ]),
      el('div', { class: 'stat-row' }, statCards.map((s) =>
        el('div', { class: 'stat-card' }, [
          el('div', { class: 'stat-head' }, [icon(s.ic, { size: 16 })]),
          el('div', { class: 'stat-value' + (s.warn ? ' stat-value--warn' : '') }, [String(s.value)]),
          el('div', { class: 'stat-label' }, [s.label]),
        ])
      )),
      el('h2', { class: 'section-title' }, [t('dash.quick')]),
      quick,
      el('div', { class: 'section-title-row' }, [
        el('h2', { class: 'section-title' }, [t('dash.recent')]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: load }, [icon('refresh', { size: 15 }), 'Refresh']),
      ]),
      el('div', { class: 'card' }, [el('div', { class: 'data-table-wrap' }, [recent])]),
      store.can('admin') ? el('div', { class: 'note-banner' }, [icon('database', { size: 16 }), t('dash.backupPrompt')]) : null,
    );
  }

  load().catch((e) => ctx.toast(e.message, 'error'));
  return root;
}

export function statusPill(status) {
  const map = {
    checked_in: ['Checked in', 'pill--info'],
    triaged: ['Ready', 'pill--info'],
    in_treatment: ['In treatment', 'pill--warning'],
    completed: ['Completed', 'pill--success'],
  };
  const [label, cls] = map[status] || [status, 'pill--neutral'];
  return el('span', { class: `pill ${cls}` }, [el('span', { class: 'pill-dot' }), label]);
}
