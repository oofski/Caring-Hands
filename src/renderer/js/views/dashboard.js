import { el, clear } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { store } from '../store.js';

export function renderDashboard(ctx) {
  const root = el('div', { class: 'view' });

  async function load() {
    const [stats, event, patients] = await Promise.all([
      api.dashboard(), api.activeEvent(), api.listPatients({}),
    ]);
    store.setEvent(event);

    const statCards = [
      { key: 'total', label: t('dash.total'), value: stats.total, cls: 'stat--blue' },
      { key: 'waiting', label: t('dash.waiting'), value: stats.waiting_triage, cls: 'stat--amber' },
      { key: 'triaged', label: t('dash.triaged'), value: stats.triaged, cls: 'stat--teal' },
      { key: 'inTreatment', label: t('dash.inTreatment'), value: stats.in_treatment, cls: 'stat--purple' },
      { key: 'completed', label: t('dash.completed'), value: stats.completed, cls: 'stat--green' },
    ];

    const quick = el('div', { class: 'quick-actions' }, [
      store.can('admin', 'triage')
        ? el('button', { class: 'qa-card qa-card--primary', onClick: () => ctx.navigate('kiosk') }, [
            el('span', { class: 'qa-icon', html: '&#129303;' }),
            el('span', {}, [el('strong', {}, [t('dash.startCheckin')]), el('small', {}, ['Hand the device to a patient'])]),
          ])
        : null,
      store.can('admin', 'doctor', 'triage')
        ? el('button', { class: 'qa-card', onClick: () => ctx.navigate('triage') }, [
            el('span', { class: 'qa-icon', html: '&#128203;' }),
            el('span', {}, [el('strong', {}, [t('dash.viewQueue')]), el('small', {}, [`${stats.waiting_triage} waiting`])]),
          ])
        : null,
      store.can('admin', 'doctor')
        ? el('button', { class: 'qa-card', onClick: () => ctx.navigate('provider') }, [
            el('span', { class: 'qa-icon', html: '&#129701;' }),
            el('span', {}, [el('strong', {}, ['Provider queue']), el('small', {}, [`${stats.triaged} ready`])]),
          ])
        : null,
      store.can('admin')
        ? el('button', { class: 'qa-card', onClick: async () => {
            try { const r = await api.backup(); if (r.saved) ctx.toast(`Backed up to ${r.path}`, 'success'); }
            catch (e) { ctx.toast(e.message, 'error'); }
          } }, [
            el('span', { class: 'qa-icon', html: '&#128190;' }),
            el('span', {}, [el('strong', {}, ['Back up to USB']), el('small', {}, ['Save a full database copy'])]),
          ])
        : null,
    ]);

    const recent = el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', {}, ['Patient']), el('th', {}, ['Age']), el('th', {}, ['Complaint']),
        el('th', {}, ['Status']), el('th', {}, ['']),
      ])]),
      el('tbody', {}, patients.slice(0, 12).map((p) => el('tr', {}, [
        el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
          (p.flags && p.flags.length) ? el('span', { class: 'flag-dot', title: `${p.flags.length} medical flag(s)` }, ['⚑']) : null]),
        el('td', {}, [p.age != null ? String(p.age) : '—']),
        el('td', {}, [p.complaint || '—']),
        el('td', {}, [statusPill(p.status)]),
        el('td', {}, [el('button', { class: 'btn btn--ghost btn--sm', onClick: () => openByStatus(p) }, ['Open'])]),
      ]))),
    ]);
    if (!patients.length) recent.querySelector('tbody').append(el('tr', {}, [el('td', { colspan: 5, class: 'empty' }, ['No patients checked in yet.'])]));

    function openByStatus(p) {
      if (p.status === 'checked_in' && store.can('admin', 'doctor', 'triage')) ctx.navigate('triage', { id: p.id });
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
        el('div', { class: `stat-card ${s.cls}` }, [
          el('div', { class: 'stat-value' }, [String(s.value)]),
          el('div', { class: 'stat-label' }, [s.label]),
        ])
      )),
      el('h2', { class: 'section-title' }, [t('dash.quick')]),
      quick,
      el('div', { class: 'section-title-row' }, [
        el('h2', { class: 'section-title' }, [t('dash.recent')]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: load }, ['↻ Refresh']),
      ]),
      el('div', { class: 'card' }, [recent]),
      store.can('admin') ? el('div', { class: 'note-banner' }, ['💾 ' + t('dash.backupPrompt')]) : null,
    );
  }

  load().catch((e) => ctx.toast(e.message, 'error'));
  return root;
}

export function statusPill(status) {
  const map = {
    checked_in: ['Checked in', 'pill--blue'],
    triaged: ['Ready', 'pill--teal'],
    in_treatment: ['In treatment', 'pill--purple'],
    completed: ['Completed', 'pill--green'],
  };
  const [label, cls] = map[status] || [status, 'pill--gray'];
  return el('span', { class: `pill ${cls}` }, [label]);
}
