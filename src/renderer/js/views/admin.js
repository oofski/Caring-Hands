import { el, clear, toast, modal } from '../dom.js';
import { t, languageList } from '../i18n.js';
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
      el('td', {}, [u.active ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Active']) : el('span', { class: 'pill pill--neutral' }, ['Disabled'])]),
      el('td', {}, [el('div', { class: 'inline-row', style: 'margin:0' }, [
        el('button', { class: 'btn btn--ghost btn--sm', onClick: () => editUser(u) }, [icon('pen', { size: 14 }), 'Edit']),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: async () => {
          try { await api.updateUser({ id: u.id, active: !u.active }); paint(); } catch (e) { toast(e.message, 'error'); }
        } }, [u.active ? 'Disable' : 'Enable']),
        el('button', { class: 'btn btn--danger btn--sm', onClick: () => delUser(u) }, [icon('trash', { size: 14 })]),
      ])]),
    ])));

    clear(body);
    body.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head-row' }, [
          el('h3', { class: 'card-title' }, [icon('users', { size: 15 }), 'Staff accounts']),
          el('button', { class: 'btn btn--primary btn--sm', onClick: () => editUser(null) }, [icon('plus', { size: 15 }), 'Add staff']),
        ]),
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Name', 'Username', 'Role', 'Status', ''].map((h) => el('th', {}, [h])))]),
            tbody,
          ]),
        ]),
      ]),
    );

    async function delUser(u) {
      const ok = await modal({ title: 'Delete staff account?', body: `Permanently delete <b>${u.full_name}</b> (${u.username})?`, confirmText: 'Delete', cancelText: 'Cancel', danger: true });
      if (!ok) return;
      try { await api.deleteUser(u.id); toast('Staff account deleted', 'success'); paint(); } catch (e) { toast(e.message, 'error'); }
    }
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
    const rows = events.map((e) => {
      const isActive = active && active.id === e.id;
      const actions = el('div', { class: 'inline-row', style: 'margin:0' });
      if (e.active && !isActive) actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => setActive(e) }, ['Set active']));
      actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => editEvent(e) }, [icon('pen', { size: 14 }), 'Edit']));
      if (e.active) actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => setState(e, false) }, ['Turn off']));
      else actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => setState(e, true) }, ['Reactivate']));
      actions.append(el('button', { class: 'btn btn--danger btn--sm', onClick: () => delEvent(e) }, [icon('trash', { size: 14 })]));
      return el('tr', { class: isActive ? 'row--active' : '' }, [
        el('td', {}, [el('strong', {}, [e.name]),
          isActive ? el('span', { class: 'pill pill--success', style: 'margin-left:6px' }, [el('span', { class: 'pill-dot' }), 'Active'])
            : (!e.active ? el('span', { class: 'pill pill--neutral', style: 'margin-left:6px' }, ['Off']) : null)]),
        el('td', {}, [e.location || '—']),
        el('td', {}, [e.start_date || '—']),
        el('td', { class: 'num' }, [String(e.patient_count)]),
        el('td', {}, [actions]),
      ]);
    });
    clear(body);
    body.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head-row' }, [
          el('h3', { class: 'card-title' }, [icon('calendar', { size: 15 }), 'Clinic events']),
          el('button', { class: 'btn btn--primary btn--sm', onClick: () => newEvent() }, [icon('plus', { size: 15 }), 'New event']),
        ]),
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Event', 'Location', 'Start', 'Patients', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, rows),
          ]),
        ]),
      ]),
    );

    async function setActive(e) {
      try { const ev = await api.setActiveEvent(e.id); store.setEvent(ev); toast('Active event set', 'success'); paint(); } catch (err) { toast(err.message, 'error'); }
    }
    async function setState(e, on) {
      try { await api.setEventState(e.id, on); store.setEvent(await api.activeEvent()); toast(on ? 'Event reactivated' : 'Event turned off', 'success'); paint(); } catch (err) { toast(err.message, 'error'); }
    }
    async function delEvent(e) {
      const ok = await modal({ title: 'Delete event?', body: `Delete <b>${e.name}</b>?${e.patient_count ? ` It has <b>${e.patient_count}</b> patient record(s).` : ''}`, confirmText: 'Delete', cancelText: 'Cancel', danger: true });
      if (!ok) return;
      try {
        await api.deleteEvent(e.id, false);
        toast('Event deleted', 'success'); store.setEvent(await api.activeEvent()); paint();
      } catch (err) {
        // Has patients — offer a forced cascade delete.
        const force = await modal({ title: 'Permanently delete with patients?', body: `${err.message}<br><br>This will permanently delete the event <b>and all ${e.patient_count} patient record(s)</b>. This cannot be undone.`, confirmText: 'Delete everything', cancelText: 'Cancel', danger: true });
        if (!force) return;
        try { await api.deleteEvent(e.id, true); toast('Event and patients deleted', 'success'); store.setEvent(await api.activeEvent()); paint(); } catch (e2) { toast(e2.message, 'error'); }
      }
    }
  }

  function eventForm(e = {}) {
    const name = el('input', { class: 'input', placeholder: 'e.g. Belize Mission — March 2026', value: e.name || '' });
    const loc = el('input', { class: 'input', placeholder: 'Location', value: e.location || '' });
    const start = el('input', { class: 'input', type: 'date', value: e.start_date || '' });
    const enabled = new Set((e.languages || 'en,es').split(',').map((s) => s.trim()).filter(Boolean));
    const langChips = el('div', { class: 'chip-row' }, languageList().map((l) =>
      el('button', { type: 'button', class: 'chip-btn' + (enabled.has(l.code) ? ' chip-btn--on' : ''),
        onClick: (ev) => { if (enabled.has(l.code)) enabled.delete(l.code); else enabled.add(l.code); ev.currentTarget.classList.toggle('chip-btn--on'); } },
        [`${l.native}`])));
    const form = el('div', { class: 'form-grid' }, [
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Event name']), name]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Location']), loc]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Start date']), start]),
      el('div', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Language packs offered at check-in']), langChips]),
    ]);
    return { form, get: () => ({ name: name.value.trim(), location: loc.value.trim(), start_date: start.value, languages: Array.from(enabled).join(',') || 'en' }) };
  }

  async function newEvent() {
    const f = eventForm();
    const ok = await modal({ title: 'Create clinic event', body: f.form, confirmText: 'Create', cancelText: 'Cancel' });
    if (!ok) return;
    try {
      const data = f.get();
      if (!data.name) { toast('Event name is required.', 'error'); return; }
      await api.createEvent(data);
      toast('Event created. Use “Set active” to make it the current event.', 'success'); paint();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function editEvent(e) {
    const f = eventForm(e);
    const ok = await modal({ title: 'Edit event', body: f.form, confirmText: 'Save', cancelText: 'Cancel' });
    if (!ok) return;
    try { await api.updateEvent({ id: e.id, ...f.get() }); store.setEvent(await api.activeEvent()); toast('Event updated', 'success'); paint(); } catch (err) { toast(err.message, 'error'); }
  }

  /* ---- Data / backup ---- */
  async function dataTab(body) {
    const incomplete = await api.listIncomplete().catch(() => []);
    clear(body);
    if (incomplete.length) {
      body.append(el('div', { class: 'card card--alert' }, [
        el('div', { class: 'card-title' }, [icon('alert', { size: 15 }), 'Incomplete records']),
        el('p', { class: 'muted' }, [`${incomplete.length} patient record(s) have no intake data — these were created on an older app version (before the intake fix) and are safe to remove.`]),
        el('div', { class: 'data-table-wrap', style: 'margin-bottom:12px' }, [
          el('table', { class: 'data-table data-table--mini' }, [
            el('thead', {}, [el('tr', {}, ['Created', 'Event', 'Name'].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, incomplete.slice(0, 50).map((r) => el('tr', {}, [
              el('td', {}, [new Date(r.created_at).toLocaleDateString()]),
              el('td', {}, [r.event_name]),
              el('td', { class: 'muted' }, [`${(r.first_name || '').trim()} ${(r.last_name || '').trim()}`.trim() || '(no name)']),
            ]))),
          ]),
        ]),
        el('button', { class: 'btn btn--danger', onClick: async () => {
          const ok = await modal({ title: 'Delete incomplete records?', body: `Permanently delete all ${incomplete.length} empty record(s)? This cannot be undone.`, confirmText: 'Delete all', cancelText: 'Cancel', danger: true });
          if (!ok) return;
          try { const r = await api.cleanupIncomplete(); toast(`Deleted ${r.deleted} incomplete record(s)`, 'success'); paint(); } catch (e) { toast(e.message, 'error'); }
        } }, [icon('trash', { size: 16 }), `Delete all ${incomplete.length} empty record(s)`]),
      ]));
    }
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
  async function langTab(body) {
    const active = await api.activeEvent();
    const enabled = new Set((active && active.languages ? active.languages : 'en,es').split(',').map((s) => s.trim()));
    clear(body);
    body.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Language packs']),
      el('p', { class: 'muted' }, ['English, Spanish, Belizean Kriol, and Nyanja are built in. Choose which packs appear at check-in per event under Events, then Edit. Patient intake and consents are translated; Kriol and Nyanja are community-reviewable.']),
      el('div', { class: 'lang-pack-grid' }, languageList().map((l) =>
        el('div', { class: 'lang-pack' }, [
          el('div', {}, [el('strong', {}, [l.native]), el('span', { class: 'muted small' }, [` ${l.label} (${l.code})`])]),
          enabled.has(l.code)
            ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'On for active event'])
            : el('span', { class: 'pill pill--neutral' }, ['Available']),
        ]))),
    ]));
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
