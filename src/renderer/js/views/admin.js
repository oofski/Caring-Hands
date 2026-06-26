import { el, clear, toast, modal } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../icons.js';

export function renderAdmin(ctx) {
  const root = el('div', { class: 'view' });
  let tab = 'staff';

  const tabs = [
    ['staff', 'Staff', 'users'], ['events', 'Events', 'calendar'], ['data', 'Backup & Export', 'database'],
    ['languages', 'Languages', 'globe'], ['audit', 'Audit log', 'clipboard'],
  ];

  function paint() {
    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [el('div', {}, [el('h1', {}, [t('nav.admin')]), el('p', { class: 'view-sub' }, ['Staff, events, backups, and audit'])])]),
      el('div', { class: 'tab-bar' }, tabs.map(([k, label, ic]) =>
        el('button', { class: 'tab' + (tab === k ? ' tab--on' : ''), onClick: () => { tab = k; paint(); } }, [icon(ic, { size: 15 }), label]))),
      el('div', { class: 'tab-body', id: 'tab-body' }),
    );
    const body = root.querySelector('#tab-body');
    ({ staff: staffTab, events: eventsTab, data: dataTab, languages: langTab, audit: auditTab }[tab])(body);
  }

  /* ---- Staff ---- */
  async function staffTab(body) {
    const users = await api.listUsers();
    const tbody = el('tbody', {});
    users.forEach((u) => tbody.append(el('tr', {}, [
      el('td', {}, [el('strong', {}, [u.full_name])]),
      el('td', {}, [u.username]),
      el('td', {}, [el('span', { class: 'pill pill--blue' }, [t(`roles.${u.role}`)])]),
      el('td', {}, [u.active ? el('span', { class: 'pill pill--green' }, ['Active']) : el('span', { class: 'pill pill--gray' }, ['Disabled'])]),
      el('td', {}, [
        el('button', { class: 'btn btn--ghost btn--sm', onClick: () => editUser(u) }, ['Edit']),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: async () => {
          try { await api.updateUser({ id: u.id, active: !u.active }); paint(); } catch (e) { toast(e.message, 'error'); }
        } }, [u.active ? 'Disable' : 'Enable']),
      ]),
    ])));

    clear(body);
    body.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head-row' }, [
          el('h3', { class: 'card-title' }, ['Staff accounts']),
          el('button', { class: 'btn btn--primary btn--sm', onClick: () => editUser(null) }, ['＋ Add staff']),
        ]),
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Name', 'Username', 'Role', 'Status', ''].map((h) => el('th', {}, [h])))]),
          tbody,
        ]),
      ]),
    );
  }

  async function editUser(u) {
    const isNew = !u;
    const name = el('input', { class: 'input', value: u ? u.full_name : '', placeholder: 'Full name' });
    const uname = el('input', { class: 'input', value: u ? u.username : '', placeholder: 'Username', disabled: !isNew });
    const role = el('select', { class: 'input' });
    [['triage', t('roles.triage')], ['doctor', t('roles.doctor')], ['admin', t('roles.admin')]].forEach(([v, l]) => {
      const op = el('option', { value: v }, [l]); if (u && u.role === v) op.selected = true; role.append(op);
    });
    const pass = el('input', { class: 'input', type: 'password', placeholder: isNew ? 'Password' : 'New password (leave blank to keep)' });
    const form = el('div', { class: 'form-grid' }, [
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Full name']), name]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Username']), uname]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Role']), role]),
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Password']), pass]),
    ]);
    const ok = await modal({ title: isNew ? 'Add staff member' : 'Edit staff', body: form, confirmText: 'Save', cancelText: 'Cancel' });
    if (!ok) return;
    try {
      if (isNew) await api.createUser({ username: uname.value.trim(), full_name: name.value.trim(), role: role.value, password: pass.value });
      else await api.updateUser({ id: u.id, full_name: name.value.trim(), role: role.value, password: pass.value || undefined });
      toast('Saved', 'success'); paint();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---- Events ---- */
  async function eventsTab(body) {
    const events = await api.listEvents();
    const active = await api.activeEvent();
    const rows = events.map((e) => el('tr', { class: active && active.id === e.id ? 'row--active' : '' }, [
      el('td', {}, [el('strong', {}, [e.name]), active && active.id === e.id ? el('span', { class: 'pill pill--green' }, ['Active']) : null]),
      el('td', {}, [e.location || '—']),
      el('td', {}, [e.start_date || '—']),
      el('td', {}, [String(e.patient_count)]),
      el('td', {}, [active && active.id === e.id ? null : el('button', { class: 'btn btn--ghost btn--sm', onClick: async () => {
        try { const ev = await api.setActiveEvent(e.id); store.setEvent(ev); toast('Active event set', 'success'); paint(); } catch (err) { toast(err.message, 'error'); }
      } }, ['Set active'])]),
    ]));
    clear(body);
    body.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head-row' }, [
          el('h3', { class: 'card-title' }, ['Clinic events']),
          el('button', { class: 'btn btn--primary btn--sm', onClick: () => newEvent() }, ['＋ New event']),
        ]),
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Event', 'Location', 'Start', 'Patients', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, rows),
        ]),
      ]),
    );
  }

  async function newEvent() {
    const name = el('input', { class: 'input', placeholder: 'e.g. Belize Mission — March 2026' });
    const loc = el('input', { class: 'input', placeholder: 'Location' });
    const start = el('input', { class: 'input', type: 'date' });
    const langs = el('input', { class: 'input', value: 'en,es', placeholder: 'Language packs (comma separated)' });
    const form = el('div', { class: 'form-grid' }, [
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Event name']), name]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Location']), loc]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Start date']), start]),
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Active languages']), langs]),
    ]);
    const ok = await modal({ title: 'Create clinic event', body: form, confirmText: 'Create', cancelText: 'Cancel' });
    if (!ok) return;
    try {
      const ev = await api.createEvent({ name: name.value.trim(), location: loc.value.trim(), start_date: start.value, languages: langs.value.trim() });
      await api.setActiveEvent(ev.id); store.setEvent(ev);
      toast('Event created and set active', 'success'); paint();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---- Data / backup ---- */
  function dataTab(body) {
    clear(body);
    body.append(
      el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, ['Backup & export']),
        el('p', { class: 'muted' }, ['All data lives only on this device. Back up regularly to a USB drive or encrypted external drive, especially after each event.']),
        el('div', { class: 'action-row' }, [
          el('button', { class: 'btn btn--primary', onClick: async () => {
            try { const r = await api.backup(); if (r.saved) toast(`Database backed up to ${r.path}`, 'success'); } catch (e) { toast(e.message, 'error'); }
          } }, [icon('database', { size: 16 }), 'Back up database (.db)']),
          el('button', { class: 'btn btn--ghost', onClick: async () => {
            try { const r = await api.exportEvent(); if (r.saved) toast(`Exported ${r.count} record(s) to ${r.path}`, 'success'); } catch (e) { toast(e.message, 'error'); }
          } }, [icon('download', { size: 16 }), 'Export event records (.json)']),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, ['Connectivity']),
        el('div', { class: 'conn-grid' }, [
          connItem('Fully offline', 'All core features work with zero internet.', 'green'),
          connItem('USB export', 'Post-event backup & archiving to USB / encrypted drive.', 'blue'),
          connItem('Local network print', 'Print to a wireless laser printer on the same network.', 'teal'),
          connItem('No cloud', 'Zero network calls. Data never leaves this device.', 'green'),
        ]),
      ]),
    );
  }
  function connItem(title, desc, color) {
    return el('div', { class: `conn-item conn-item--${color}` }, [el('strong', {}, [title]), el('span', {}, [desc])]);
  }

  /* ---- Languages ---- */
  function langTab(body) {
    clear(body);
    body.append(el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, ['Language packs']),
      el('p', { class: 'muted' }, ['English and Spanish ship built-in. Additional packs (e.g. Belizean Creole, Nyanja) are added as translation files per deployment — no code change required.']),
      el('div', { class: 'lang-pack-grid' }, [
        langPack('English', 'en', true, true), langPack('Español (Spanish)', 'es', true, true),
        langPack('Belizean Creole', 'bzj', false, false), langPack('Nyanja', 'nya', false, false),
      ]),
    ]));
  }
  function langPack(name, code, builtin, active) {
    return el('div', { class: 'lang-pack' }, [
      el('div', {}, [el('strong', {}, [name]), el('span', { class: 'muted small' }, [` (${code})`])]),
      builtin ? el('span', { class: 'pill pill--green' }, ['Built-in']) : el('span', { class: 'pill pill--gray' }, ['Add per deployment']),
    ]);
  }

  /* ---- Audit ---- */
  async function auditTab(body) {
    const log = await api.audit(200);
    clear(body);
    body.append(el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, ['Audit log']),
      el('table', { class: 'data-table data-table--mini' }, [
        el('thead', {}, [el('tr', {}, ['When', 'User', 'Action', 'Entity', 'Detail'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, log.map((a) => el('tr', {}, [
          el('td', {}, [new Date(a.created_at).toLocaleString()]),
          el('td', {}, [a.user_name || '—']),
          el('td', {}, [a.action]),
          el('td', {}, [`${a.entity || ''}${a.entity_id ? ' #' + a.entity_id : ''}`]),
          el('td', {}, [a.detail || '—']),
        ]))),
      ]),
    ]));
  }

  paint();
  return root;
}
