import { el, clear, toast, modal } from '../dom.js';
import { t, languageList } from '../i18n.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../icons.js';

// Cloud-sync live-update subscription. Kept at module scope so repaints of the
// Cloud tab can drop the previous listener before adding a new one (no stacking).
let cloudUnsub = null;

// The roles a new account can be given, in the order a patient meets them.
// v1.0.9 retired the Triage station, so 'triage' is offered ONLY when editing an
// account that already has it — saving that user must never silently re-role them.
const roleOptions = () => [
  ['registration', t('roles.registration')], ['emt', t('roles.emt')],
  ['hygienist', t('roles.hygienist')], ['doctor', t('roles.doctor')],
  ['checkout', t('roles.checkout')], ['admin', t('roles.admin')],
];

// Each of these is reached from its own sidebar item (Staff & roles, Events,
// Languages, Cloud, Backup & Export, Audit log). renderAdmin(ctx, {section})
// renders JUST that section as a standalone page — no tab bar. Titles/subtitles
// for the standalone header:
const SECTION_META = {
  staff: ['Staff & roles', 'Add your team and control who can access each part of the app.'],
  events: ['Clinic events', 'Set up and switch the active clinic event.'],
  data: ['Backup & Export', 'Back up this device and export event data.'],
  languages: ['Languages', 'Choose which language packs appear at patient check-in.'],
  cloud: ['Cloud', 'Keep every station on one shared, live queue.'],
  audit: ['Audit log', 'A record of who did what, and when.'],
};

export function renderAdmin(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  // The sidebar drives navigation now, so a section is always specified. Default
  // to staff if somehow called without one.
  let tab = params.section && SECTION_META[params.section] ? params.section : 'staff';

  const sectionFns = { staff: staffTab, events: eventsTab, data: dataTab, languages: langTab, cloud: cloudTab, audit: auditTab };

  function paint() {
    clear(root);
    const [title, sub] = SECTION_META[tab] || ['Admin', ''];
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('div', {
            style: 'font-size:var(--fs-2xs); text-transform:uppercase; letter-spacing:var(--tracking-eyebrow); color:var(--teal-deep); font-weight:var(--fw-semibold); margin-bottom:var(--space-1);',
          }, ['Helping hands for healthy living']),
          el('h1', {}, [title]),
          el('p', { class: 'view-sub' }, [sub]),
        ]),
      ]),
      el('div', { class: 'tab-body', id: 'tab-body' }),
    );
    const body = root.querySelector('#tab-body');
    sectionFns[tab](body);
  }

  /* ---- Staff ---- */
  async function staffTab(body) {
    const [users, active, directory] = await Promise.all([
      api.listUsers(), api.activeEvent(),
      api.staffDirectory().catch(() => []),
    ]);
    // The two shared desk logins are stations, not people — they get their own
    // card so nobody has to work out why "checkout" is a global account.
    const isDesk = (u) => u.username === 'registration' || u.username === 'checkout';
    const desks = users.filter(isDesk);
    // Global administrators live outside any single event; everyone else is
    // scoped to the event they were created for.
    const globals = users.filter((u) => !isDesk(u) && (u.role === 'admin' || u.event_id == null));
    const eventStaff = active ? users.filter((u) => u.event_id === active.id && u.role !== 'admin') : [];

    clear(body);

    // --- Event-scoped staff card -------------------------------------------
    const staffCard = el('div', { class: 'card' });
    const headActions = el('div', { class: 'inline-row', style: 'margin:0' });
    headActions.append(
      el('button', {
        class: 'btn btn--primary btn--sm',
        disabled: !active,
        onClick: () => editUser(null, active),
      }, [icon('plus', { size: 15 }), 'Add staff']),
    );
    if (active && eventStaff.length) {
      headActions.append(
        el('button', {
          class: 'btn btn--danger btn--sm',
          onClick: () => startFresh(active, eventStaff.length),
        }, [icon('sparkle', { size: 14 }), 'Start fresh for next event']),
      );
    }

    staffCard.append(
      el('div', { class: 'card-head-row' }, [
        el('h3', { class: 'card-title' }, [icon('users', { size: 15 }), 'Clinic team']),
        headActions,
      ]),
      el('p', {
        class: 'view-sub',
        style: 'margin:0 0 var(--space-4);',
      }, active
        ? [
          'Staff for ',
          el('strong', { style: 'color:var(--text-strong);' }, [active.name]),
          '. These accounts are set up for this clinic only.',
        ]
        : ['No clinic event is active yet. Set one active under Events to add staff for it.']),
    );

    if (!active) {
      staffCard.append(
        el('div', {
          class: 'banner banner--locked',
          style: 'margin:0;',
        }, [icon('calendar', { size: 16 }), 'Activate a clinic event first, then come back to add your team.']),
      );
    } else if (!eventStaff.length) {
      staffCard.append(
        el('div', { class: 'data-table-wrap' }, [
          el('div', {
            class: 'empty',
            style: 'padding:var(--space-8) var(--space-4) !important;',
          }, ['No staff yet for this event. Use Add staff to invite your team.']),
        ]),
      );
    } else {
      staffCard.append(
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Name', 'Username', 'Role', 'Status', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, eventStaff.map((u) => staffRow(u, active))),
          ]),
        ]),
      );
    }
    body.append(staffCard);

    // --- Staff directory: everyone who has ever worked a clinic -------------
    // A staff ACCOUNT is destroyed when its clinic ends. The people are not, so
    // this is the standing list — setting up the next clinic is picking names
    // off it rather than re-typing the team and inventing passwords for
    // volunteers who already have one.
    const dirCard = el('div', { class: 'card' });
    dirCard.append(
      el('div', { class: 'card-head-row' }, [
        el('h3', { class: 'card-title' }, [icon('users', { size: 15 }), 'Staff directory']),
        el('span', { class: 'pill pill--neutral' }, [`${directory.length} ${directory.length === 1 ? 'person' : 'people'}`]),
      ]),
      el('p', { class: 'view-sub', style: 'margin:0 0 var(--space-4);' }, [
        'Everyone who has ever been given an account. Adding someone here to a clinic keeps the username and password they already had, so a returning volunteer signs in exactly as before.',
      ]),
    );
    if (!directory.length) {
      dirCard.append(el('div', { class: 'data-table-wrap' }, [
        el('div', { class: 'empty' }, ['Nobody yet — everyone you add to a clinic is listed here from then on.']),
      ]));
    } else {
      dirCard.append(el('div', { class: 'data-table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Name', 'Username', 'Role for this clinic', 'Last worked', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, directory.map((p) => dirRow(p))),
        ]),
      ]));
    }
    body.append(dirCard);

    function dirRow(p) {
      const addable = !!active && !p.account_scope;
      // The role they last worked is the default, but a volunteer who ran the
      // front desk last year may be on x-rays this year — so it is a choice.
      // Only where it IS a choice: elsewhere it is just what they are doing.
      let roleCell;
      let roleSel = null;
      if (addable) {
        roleSel = el('select', { class: 'input select input--sm' });
        roleOptions().forEach(([v, l]) => {
          const op = el('option', { value: v }, [l]);
          if (p.role === v) op.selected = true;
          roleSel.append(op);
        });
        roleCell = roleSel;
      } else {
        roleCell = el('span', { class: 'pill pill--blue' }, [t(`roles.${p.role}`)]);
      }
      let action;
      if (p.account_scope === 'this_event') {
        action = el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'On this clinic']);
      } else if (p.account_scope === 'global') {
        action = el('span', { class: 'pill pill--purple' }, [icon('globe', { size: 12 }), 'Administrator']);
      } else if (p.account_scope === 'other_event') {
        action = el('span', { class: 'pill pill--neutral', title: `${p.full_name} still has an account on another clinic. Remove it there, or edit that account.` }, ['On another clinic']);
      } else {
        action = el('button', {
          class: 'btn btn--primary btn--sm', disabled: !active,
          title: active ? `Add ${p.full_name} to ${active.name}` : 'Set a clinic active first',
          onClick: async () => {
            try {
              await api.addStaffFromDirectory({ id: p.id, role: roleSel ? roleSel.value : p.role });
              toast(`${p.full_name} added to ${active.name}.`, 'success');
              paint();
            } catch (e) { toast(e.message, 'error'); }
          },
        }, [icon('plus', { size: 14 }), 'Add to this clinic']);
      }
      return el('tr', {}, [
        el('td', {}, [el('strong', {}, [p.full_name])]),
        el('td', {}, [p.username]),
        el('td', {}, [roleCell]),
        el('td', {}, [el('span', { class: 'subtle small' }, [p.last_event_name || '—'])]),
        el('td', {}, [el('div', { class: 'inline-row', style: 'margin:0; justify-content:flex-end;' }, [
          action,
          el('button', {
            class: 'btn btn--ghost btn--sm', title: `Remove ${p.full_name} from the staff directory`,
            onClick: () => forget(p),
          }, [icon('trash', { size: 14 })]),
        ])]),
      ]);
    }

    async function forget(p) {
      const ok = await modal({
        title: 'Remove from the staff directory?',
        body: `Take <b>${p.full_name}</b> off the standing staff list? They will no longer appear when you set up a clinic. Any account they have on a clinic right now is left alone — delete that separately if you need to.`,
        confirmText: 'Remove from directory', cancelText: 'Cancel', danger: true,
      });
      if (!ok) return;
      try { await api.forgetStaff(p.id); toast(`${p.full_name} removed from the staff directory.`, 'success'); paint(); }
      catch (e) { toast(e.message, 'error'); }
    }

    // --- Shared clinic logins ----------------------------------------------
    // The front desk and the check-out table are shared stations that a rotating
    // group sits down at. Same username and password at every clinic, set up
    // automatically, so nobody has to remember to create them on the morning.
    const deskCard = el('div', { class: 'card' });
    deskCard.append(
      el('div', { class: 'card-head-row' }, [
        el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Shared clinic logins']),
      ]),
      el('p', { class: 'view-sub', style: 'margin:0 0 var(--space-4);' }, [
        'The front desk and check-out stations. These two are created automatically for every clinic and are never removed by ',
        el('strong', { style: 'color:var(--text-strong);' }, ['Start fresh for next event']),
        ' — the same login works at every clinic. Because they are shared, keep them to the desk and use a personal account for anything a name needs to sit against.',
      ]),
    );
    if (!desks.length) {
      deskCard.append(el('div', { class: 'data-table-wrap' }, [el('div', { class: 'empty' }, ['Not set up yet — create a clinic event and they appear here.'])]));
    } else {
      deskCard.append(el('div', { class: 'data-table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Station', 'Username', 'Role', 'Status', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, desks.map((u) => el('tr', {}, [
            el('td', {}, [el('strong', {}, [u.full_name])]),
            el('td', {}, [el('span', { class: 'mono' }, [u.username])]),
            el('td', {}, [el('span', { class: 'pill pill--blue' }, [t(`roles.${u.role}`)])]),
            el('td', {}, [u.active
              ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Active'])
              : el('span', { class: 'pill pill--neutral' }, ['Disabled'])]),
            el('td', {}, [el('div', { class: 'inline-row', style: 'margin:0; justify-content:flex-end;' }, [
              el('button', { class: 'btn btn--ghost btn--sm', onClick: () => editUser(u, active) }, [icon('pen', { size: 14 }), 'Change password']),
              el('button', { class: 'btn btn--ghost btn--sm', onClick: () => resetDesk(u) }, [icon('refresh', { size: 14 }), 'Reset to default']),
            ])]),
          ]))),
        ]),
      ]));
    }
    body.append(deskCard);

    async function resetDesk(u) {
      const ok = await modal({
        title: `Reset ${u.full_name}?`,
        body: `Set the password for <b>${u.username}</b> back to the shared default and make sure the account is enabled. Anyone who knows the default can then sign in at that station.`,
        confirmText: 'Reset password', cancelText: 'Cancel',
      });
      if (!ok) return;
      try {
        const r = await api.resetClinicPassword(u.username);
        toast(`${u.username} reset — password is “${r.password}”.`, 'success');
        paint();
      } catch (e) { toast(e.message, 'error'); }
    }

    // --- Global administrators card ----------------------------------------
    const adminCard = el('div', { class: 'card' });
    adminCard.append(
      el('div', { class: 'card-head-row' }, [
        el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Global administrators']),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          onClick: () => editUser({ role: 'admin' }, active, true),
        }, [icon('plus', { size: 15 }), 'Add administrator']),
      ]),
      el('p', {
        class: 'view-sub',
        style: 'margin:0 0 var(--space-4);',
      }, ['Administrators work across every event and are never removed when you start fresh.']),
    );
    if (!globals.length) {
      adminCard.append(
        el('div', { class: 'data-table-wrap' }, [
          el('div', { class: 'empty' }, ['No administrators yet.']),
        ]),
      );
    } else {
      adminCard.append(
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Name', 'Username', 'Role', 'Scope', 'Status', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, globals.map((u) => staffRow(u, active, true))),
          ]),
        ]),
      );
    }
    body.append(adminCard);

    function staffRow(u, activeEvent, showScope) {
      const cells = [
        el('td', {}, [el('strong', {}, [u.full_name])]),
        el('td', {}, [u.username]),
        el('td', {}, [el('span', { class: 'pill pill--blue' }, [t(`roles.${u.role}`)])]),
      ];
      if (showScope) {
        const scoped = u.role !== 'admin' && u.event_id != null;
        cells.push(el('td', {}, [
          scoped
            ? el('span', { class: 'pill pill--neutral' }, [activeEvent && u.event_id === activeEvent.id ? activeEvent.name : 'Event'])
            : el('span', { class: 'pill pill--purple' }, [icon('globe', { size: 12 }), 'Global']),
        ]));
      }
      cells.push(
        el('td', {}, [u.active
          ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Active'])
          : el('span', { class: 'pill pill--neutral' }, ['Disabled'])]),
        el('td', {}, [el('div', { class: 'inline-row', style: 'margin:0; justify-content:flex-end;' }, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => editUser(u, activeEvent) }, [icon('pen', { size: 14 }), 'Edit']),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            onClick: async () => {
              try { await api.updateUser({ id: u.id, active: !u.active }); paint(); } catch (e) { toast(e.message, 'error'); }
            },
          }, [u.active ? 'Disable' : 'Enable']),
          el('button', { class: 'btn btn--danger btn--sm', onClick: () => delUser(u) }, [icon('trash', { size: 14 })]),
        ])]),
      );
      return el('tr', {}, cells);
    }

    async function startFresh(activeEvent, count) {
      const ok = await modal({
        title: 'Start fresh for the next event?',
        body: `Remove all <b>${count}</b> clinical staff for <b>${activeEvent.name}</b>? Administrators are kept so you can set up the next clinic. This cannot be undone.`,
        confirmText: 'Remove staff',
        cancelText: 'Cancel',
        danger: true,
      });
      if (!ok) return;
      try {
        const r = await api.clearEventStaff(activeEvent.id);
        toast(`Removed ${r.deleted} staff member(s). Administrators are kept.`, 'success');
        paint();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function delUser(u) {
      const ok = await modal({ title: 'Delete staff account?', body: `Permanently delete <b>${u.full_name}</b> (${u.username})?`, confirmText: 'Delete', cancelText: 'Cancel', danger: true });
      if (!ok) return;
      try { await api.deleteUser(u.id); toast('Staff account deleted', 'success'); paint(); } catch (e) { toast(e.message, 'error'); }
    }
  }

  // `forceAdmin` locks the role to admin (used by "Add administrator").
  async function editUser(u, active, forceAdmin) {
    const isNew = !u || !u.id;
    const name = el('input', { class: 'input', value: u && u.full_name ? u.full_name : '', placeholder: 'Full name' });
    const uname = el('input', { class: 'input', value: u && u.username ? u.username : '', placeholder: 'Username', disabled: !isNew });
    const role = el('select', { class: 'input select' });
    const roleOpts = roleOptions();
    if (u && u.role === 'triage') roleOpts.unshift(['triage', t('roles.triage')]);
    roleOpts.forEach(([v, l]) => {
      const op = el('option', { value: v }, [l]);
      if ((u && u.role === v) || (forceAdmin && v === 'admin')) op.selected = true;
      role.append(op);
    });
    if (forceAdmin) role.disabled = true;
    const pass = el('input', { class: 'input', type: 'password', placeholder: isNew ? 'Password' : 'New password (leave blank to keep)' });

    const fields = [];

    // Pick a returning volunteer off the standing list instead of re-typing
    // them. Choosing someone fills the form in and keeps the password they
    // already have, so a name that has worked before is two clicks.
    let picked = null;
    const passHint = el('div', { class: 'subtle small', style: 'margin-top:4px' }, []);
    if (isNew && !forceAdmin) {
      const dir = (await api.staffDirectory().catch(() => []))
        .filter((p) => !p.account_scope);
      if (dir.length) {
        const pick = el('select', { class: 'input select' });
        pick.append(el('option', { value: '' }, ['— Someone new —']));
        dir.forEach((p) => pick.append(el('option', { value: String(p.id) }, [`${p.full_name} (${p.username}) · ${t(`roles.${p.role}`)}`])));
        pick.addEventListener('change', () => {
          picked = dir.find((p) => String(p.id) === pick.value) || null;
          name.value = picked ? picked.full_name : '';
          uname.value = picked ? picked.username : '';
          name.disabled = uname.disabled = !!picked;
          if (picked) {
            Array.from(role.options).forEach((o) => { o.selected = o.value === picked.role; });
            pass.placeholder = 'Leave blank to keep their current password';
            clear(passHint);
            passHint.append(`${picked.full_name} already has a password — leave this blank and they sign in exactly as before.`);
          } else {
            pass.placeholder = 'Password';
            clear(passHint);
          }
        });
        fields.push(el('label', { class: 'field span-2' }, [
          el('span', { class: 'field-label' }, ['Has this person worked a clinic before?']),
          pick,
        ]));
      }
    }

    fields.push(
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Full name']), name]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Username']), uname]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Role']), role]),
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Password']), pass, passHint]),
    );
    // On a new event-scoped staff member, make the scope obvious.
    if (isNew && !forceAdmin && active) {
      fields.push(el('div', { class: 'field span-2' }, [
        el('div', { class: 'note-banner' }, [icon('calendar', { size: 15 }), `This account will be set up for ${active.name}.`]),
      ]));
    }
    const form = el('div', { class: 'form-grid' }, fields);

    const ok = await modal({ title: isNew ? 'Add staff member' : 'Edit staff', body: form, confirmText: 'Save', cancelText: 'Cancel' });
    if (!ok) return;
    try {
      if (isNew && picked) {
        // A returning volunteer: their saved password carries over unless a new
        // one was typed here.
        await api.addStaffFromDirectory({ id: picked.id, role: role.value, password: pass.value || undefined });
      } else if (isNew) {
        // Omit event_id: the backend scopes non-admins to the active event and
        // keeps admins global automatically.
        await api.createUser({ username: uname.value.trim(), full_name: name.value.trim(), role: role.value, password: pass.value });
      } else {
        await api.updateUser({ id: u.id, full_name: name.value.trim(), role: role.value, password: pass.value || undefined });
      }
      toast('Saved', 'success'); paint();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---- Events ---- */
  async function eventsTab(body) {
    const events = await api.listEvents();
    const active = await api.activeEvent();
    const rows = events.map((e) => {
      const isActive = active && active.id === e.id;
      const actions = el('div', { class: 'inline-row', style: 'margin:0; justify-content:flex-end;' });
      if (e.active && !isActive) actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => setActive(e) }, ['Set active']));
      if (e.prereg_url) actions.append(el('button', { class: 'btn btn--ghost btn--sm', title: 'Patient pre-registration link', onClick: () => preregLink(e) }, [icon('globe', { size: 14 }), 'Pre-reg link']));
      actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => editEvent(e) }, [icon('pen', { size: 14 }), 'Edit']));
      // Close a clinic: keep the figures for reporting, remove the patients.
      actions.append(el('button', {
        class: 'btn btn--soft btn--sm',
        title: 'Keep the reporting totals, remove every patient record',
        onClick: async () => {
          const ok = await modal({
            title: `Finish “${e.name}”?`,
            body: 'The clinic’s <b>reporting totals are kept</b> — patients seen, procedures, and the breakdowns by age, gender, language and city — so this event still appears in Reports and grant returns.<br><br>Every <b>patient record is permanently removed</b> from this computer, the clinic cloud, and every other station. Export the clinic first if you want to be able to restore it.<br><br>This cannot be undone.',
            confirmText: 'Finish clinic & remove patient data',
            cancelText: 'Cancel',
            danger: true,
          });
          if (!ok) return;
          try {
            const r = await api.finishEvent(e.id);
            toast(`“${e.name}” finished — report kept, ${r.removed} patient record(s) removed.`, 'success');
            paint();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, [icon('checkCircle', { size: 14 }), 'Finish clinic']));
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
        el('p', { class: 'view-sub', style: 'margin:0 0 var(--space-4);' }, ['Each event has its own team, patients, and language packs. Set one active to make it the current clinic.']),
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
    // Share the per-event pre-registration link. Patients open it ahead of time,
    // answer the check-in questions, and appear in THIS event's queue.
    async function preregLink(e) {
      const input = el('input', { class: 'input', readonly: true, value: e.prereg_url, style: 'font-family:var(--font-mono);font-size:var(--fs-sm)' });
      const copyBtn = el('button', { class: 'btn btn--primary', type: 'button' }, [icon('save', { size: 14 }), 'Copy link']);
      copyBtn.addEventListener('click', async () => {
        try { input.select(); if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(e.prereg_url); else document.execCommand('copy'); toast('Link copied', 'success'); }
        catch (_) { input.select(); document.execCommand('copy'); toast('Link copied', 'success'); }
      });
      await modal({
        title: `Pre-registration link — ${e.name}`,
        body: el('div', {}, [
          el('p', { class: 'subtle small', style: 'margin:0 0 10px' }, ['Share this link with patients (text, email, flyer QR). Anyone who fills it out is added to this event’s check-in queue with a “Pre-reg” tag. The link is unique to this event.']),
          el('div', { class: 'inline-row', style: 'gap:8px' }, [input, copyBtn]),
          el('p', { class: 'subtle', style: 'font-size:var(--fs-2xs);margin:12px 0 0' }, ['Note: pre-registration needs the clinic to be Online (Admin → Cloud). Submissions arrive on the next sync.']),
        ]),
        confirmText: 'Done',
      });
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
        el('p', { class: 'muted', style: 'margin:0 0 var(--space-3);' }, [`${incomplete.length} patient record(s) have no intake data — these were created on an older app version (before the intake fix) and are safe to remove.`]),
        el('div', { class: 'data-table-wrap', style: 'margin-bottom:var(--space-3)' }, [
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
    // End-of-clinic: take the data with you as a spreadsheet, then take it off
    // the machines. The purge is deliberately gated behind a fresh export.
    let exported = null;
    const purgeBtn = el('button', {
      class: 'btn btn--danger', disabled: true,
      title: 'Export first — this cannot be undone',
      onClick: async () => {
        const ok = await modal({
          title: 'Remove this clinic’s patient data?',
          body: `This permanently deletes <b>every patient record for the current clinic</b> from this computer, from the clinic cloud, and from every other station when it next syncs.<br><br>You exported <b>${exported && exported.patients} patient record(s)</b> to:<br><code>${exported && exported.xlsxPath}</code><br><br>Keep that file safe — restoring later is only possible from the <b>.chbak.json</b> saved beside it. This cannot be undone.`,
          confirmText: 'Delete the patient data',
          cancelText: 'Cancel',
          danger: true,
        });
        if (!ok) return;
        purgeBtn.disabled = true;
        try {
          const r = await api.purgeEvent();
          toast(`${r.removed} patient record(s) removed from this computer and the cloud.`, 'success');
          exported = null; paint();
        } catch (e) { toast(e.message, 'error'); purgeBtn.disabled = false; }
      },
    }, [icon('trash', { size: 16 }), 'Delete this clinic’s patient data']);
    const exportHint = el('p', { class: 'muted small', style: 'margin:var(--space-2) 0 0' }, [
      'Export first — the delete button unlocks once you have saved a copy.',
    ]);

    body.append(
      el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, [icon('download', { size: 15 }), 'End of clinic — take the data with you']),
        el('p', { class: 'muted', style: 'margin:0 0 var(--space-4);' }, [
          'Saves two files side by side: an ',
          el('strong', {}, ['Excel workbook']),
          ' you can read and share, and a ',
          el('strong', {}, ['.chbak.json backup']),
          ' that can put the whole clinic back later — including signed consents and x-ray images, which a spreadsheet cannot hold.',
        ]),
        el('div', { class: 'action-row', style: 'margin-top:0;' }, [
          el('button', { class: 'btn btn--primary', onClick: async (e) => {
            const btn = e.currentTarget; const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Exporting…';
            try {
              const r = await api.exportClinic();
              if (r.saved) {
                exported = r;
                purgeBtn.disabled = false;
                purgeBtn.title = 'Permanently delete this clinic’s patient data';
                exportHint.textContent = `Saved ${r.patients} patient record(s). Workbook: ${r.xlsxPath} · Backup: ${r.backupPath}`;
                toast(`Exported ${r.patients} patient record(s).`, 'success');
              }
            } catch (err) { toast(err.message, 'error'); }
            finally { btn.disabled = false; btn.textContent = prev; }
          } }, [icon('download', { size: 16 }), 'Export clinic (Excel + backup)']),
          el('button', { class: 'btn btn--ghost', onClick: async () => {
            try {
              const r = await api.importClinic();
              if (r.imported) { toast(`Restored ${r.patients} patient record(s) (${r.updated} updated).`, 'success'); paint(); }
            } catch (e) { toast(e.message, 'error'); }
          } }, [icon('refresh', { size: 16 }), 'Restore a clinic from backup']),
          // Recovery for a clinic whose figures were lost: recount from a backup
          // WITHOUT bringing any patient records back onto this computer.
          el('button', { class: 'btn btn--ghost', title: 'Recount an old clinic’s figures from its backup file, without restoring any patient records', onClick: async () => {
            try {
              const r = await api.rebuildReport();
              if (r.rebuilt) {
                toast(`Report rebuilt for “${r.event_name}” — ${r.summary.patients_seen} patient(s) recounted. No patient records were restored.`, 'success');
                paint();
              }
            } catch (e) { toast(e.message, 'error'); }
          } }, [icon('reports', { size: 16 }), 'Rebuild a report from backup']),
          purgeBtn,
        ]),
        exportHint,
      ]),
      el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, [icon('database', { size: 15 }), 'Backup & export']),
        el('p', { class: 'muted', style: 'margin:0 0 var(--space-4);' }, ['All data lives only on this device. Back up regularly to a USB drive or encrypted external drive, especially after each event.']),
        el('div', { class: 'action-row', style: 'margin-top:0;' }, [
          // End-of-clinic offload: one .zip with the whole database + records to
          // drop onto a hard drive.
          el('button', { class: 'btn btn--primary', onClick: async (e) => {
            const btn = e.currentTarget; const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Building ZIP…';
            try { const r = await api.exportZip(); if (r.saved) toast(`Clinic exported (${r.count} patient record(s)) to ${r.path}`, 'success'); }
            catch (err) { toast(err.message, 'error'); }
            finally { btn.disabled = false; btn.textContent = prev; }
          } }, [icon('download', { size: 16 }), 'Export clinic ZIP (for a hard drive)']),
          el('button', { class: 'btn btn--ghost', onClick: async () => {
            try { const r = await api.backup(); if (r.saved) toast(`Database backed up to ${r.path}`, 'success'); } catch (e) { toast(e.message, 'error'); }
          } }, [icon('database', { size: 16 }), 'Back up database (.db)']),
          el('button', { class: 'btn btn--ghost', onClick: async () => {
            try { const r = await api.exportEvent(); if (r.saved) toast(`Exported ${r.count} record(s) to ${r.path}`, 'success'); } catch (e) { toast(e.message, 'error'); }
          } }, [icon('download', { size: 16 }), 'Export event records (.json)']),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Connectivity']),
        el('div', { class: 'conn-grid' }, [
          connItem('Fully offline', 'All core features work with zero internet.', 'green'),
          connItem('USB export', 'Post-event backup & archiving to USB / encrypted drive.', 'blue'),
          connItem('Local network print', 'Print to a wireless laser printer on the same network.', 'teal'),
          // This used to read "No cloud — data never leaves this device", which
          // stopped being true when sync became always-on. Saying it on the page
          // about handling patient data was actively misleading.
          connItem('Clinic cloud', 'Stations share one live queue. Turn it off under Admin → Cloud.', 'green'),
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
      el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Language packs']),
      el('p', { class: 'muted', style: 'margin:0 0 var(--space-4);' }, ['English, Spanish, Belizean Kriol, and Nyanja are built in. Choose which packs appear at check-in per event under Events, then Edit. Patient intake and consents are translated; Kriol and Nyanja are community-reviewable.']),
      el('div', { class: 'lang-pack-grid' }, languageList().map((l) =>
        el('div', { class: 'lang-pack' }, [
          el('div', {}, [el('strong', {}, [l.native]), el('span', { class: 'muted small' }, [` ${l.label} (${l.code})`])]),
          enabled.has(l.code)
            ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'On for active event'])
            : el('span', { class: 'pill pill--neutral' }, ['Available']),
        ]))),
    ]));
  }

  /* ---- Cloud sync (v1.2.3) ----
     Cloud is now always-on by default: the app ships with the clinic's server +
     key baked in. This tab is ONE switch — the clinic is Online (default) or, if
     there's no wifi, Run offline. Advanced users can still override the server,
     but it's tucked away in a closed drawer most clinics never open. */
  async function cloudTab(body) {
    clear(body);

    // We deliberately do NOT subscribe to onCloudChanged here: an auto-repaint
    // would wipe the Advanced URL/key the admin is typing. Status refreshes when
    // the tab is (re)opened and after "Sync now". Drop any leftover listener so
    // an earlier subscription can't leak or fire against a stale tab.
    if (cloudUnsub) { try { cloudUnsub(); } catch (_) { /* ignore */ } cloudUnsub = null; }

    let st;
    try {
      st = await api.cloudStatus();
    } catch (e) {
      body.append(el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Cloud sync']),
        el('p', { class: 'muted', style: 'margin:0;' }, [`Could not load cloud status: ${e.message}`]),
      ]));
      return;
    }

    body.append(el('p', { class: 'view-sub', style: 'margin:0 0 var(--space-4);' }, [
      'Your clinic is connected to the cloud so patients sync across every station in real time. Turn this off only if this location has no internet.',
    ]));

    /* --- Cloud status --- */
    let pill; let statusNote;
    if (!st.online) {
      pill = el('span', { class: 'pill pill--neutral' }, ['Offline — running locally']);
      statusNote = null;
    } else if (st.lastError) {
      pill = el('span', { class: 'pill pill--amber' }, [icon('alert', { size: 12 }), 'Reconnecting…']);
      statusNote = el('span', { class: 'muted small' }, [st.lastError]);
    } else {
      pill = el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Online']);
      statusNote = el('span', { class: 'muted small' }, [st.lastOk ? `Synced ${new Date(st.lastOk).toLocaleTimeString()}` : 'Connecting…']);
    }

    // "Sync now" is only meaningful while online — disable it when running local.
    const syncNowBtn = el('button', {
      class: 'btn btn--ghost',
      disabled: !st.online,
      onClick: async () => {
        try {
          const r = await api.cloudSyncNow();
          if (r && r.ok) toast(`Synced — pushed ${r.pushed}, pulled ${r.pulled}, applied ${r.applied}`, 'success');
          else toast((r && r.error) || 'Sync failed', 'error');
          paint();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, [icon('refresh', { size: 16 }), 'Sync now']);

    body.append(el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Cloud status']),
      el('div', {
        class: 'inline-row',
        style: 'margin:0; align-items:center; justify-content:space-between; gap:var(--space-4); flex-wrap:wrap;',
      }, [
        el('div', { style: 'display:flex; flex-direction:column; gap:6px;' }, [
          el('div', { class: 'inline-row', style: 'margin:0; align-items:center; gap:var(--space-2);' }, [pill, statusNote]),
          el('div', { class: 'subtle small' }, [`pushed ${st.pushed} · pulled ${st.pulled} · applied ${st.applied}`]),
        ]),
        syncNowBtn,
      ]),
    ]));

    /* --- The main switch --- */
    const onlineToggle = el('input', {
      type: 'checkbox', checked: st.online,
      style: 'width:22px; height:22px; accent-color:var(--accent); cursor:pointer; flex:0 0 auto;',
      onChange: async (ev) => {
        const on = ev.target.checked;
        try {
          await api.cloudConfig({ online: on });
          toast(on ? 'Cloud sync on — this station is online' : 'Now running offline — will re-sync when you turn it back on', 'success');
          paint();
        } catch (e) {
          ev.target.checked = !on;
          toast(e.message, 'error');
        }
      },
    });

    body.append(el('div', { class: 'card' }, [
      el('label', {
        class: 'inline-row',
        style: 'margin:0 0 var(--space-3); align-items:center; gap:var(--space-3); cursor:pointer;',
      }, [
        onlineToggle,
        el('strong', { style: 'color:var(--text-strong); font-size:var(--fs-h3);' }, ['This clinic is online']),
      ]),
      el('p', { class: 'muted small', style: 'margin:0;' }, [
        'Leave this on. Switch it off only when there’s no wifi at the clinic; the app keeps working locally and re-syncs automatically when you turn it back on.',
      ]),
    ]));

    /* --- Recovery: re-read the whole clinic from the cloud --- */
    const resyncBtn = el('button', {
      class: 'btn btn--ghost',
      onClick: async () => {
        const ok = await modal({
          title: 'Re-sync everything?',
          body: 'This station will re-read every patient and record from the clinic cloud, and re-apply any deletions made on the other computers. Nothing is duplicated, and nothing you have here that the cloud does not know about is lost — use it if this computer is out of step with the others. It can take a minute on a big clinic.',
          confirmText: 'Re-sync everything',
          cancelText: 'Cancel',
        });
        if (!ok) return;
        resyncBtn.disabled = true;
        try {
          const r = await api.cloudResync();
          // Deletions used to be counted as records "brought in", which read as
          // the opposite of what had happened.
          const brought = r.applied || 0, removed = r.deleted || 0;
          toast(`Re-synced — ${brought} record(s) brought in${removed ? `, ${removed} removed` : ''}`, 'success');
          paint();
        } catch (e) { toast(e.message, 'error'); }
        finally { resyncBtn.disabled = false; }
      },
    }, [icon('refresh', { size: 16 }), 'Re-sync everything']);

    body.append(el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, ['Missing patients on this computer?']),
      el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
        'If a patient shows on another computer but not on this one, re-sync to re-read the whole clinic from the cloud. Safe to run any time.',
      ]),
      resyncBtn,
    ]));

    /* --- Advanced (rarely needed: point at a different server) --- */
    const urlInput = el('input', {
      class: 'input', type: 'text', value: st.url || '',
      placeholder: 'https://caring-hands-sync.<subdomain>.workers.dev',
    });
    const keyInput = el('input', {
      class: 'input', type: 'password',
      placeholder: 'Leave blank to keep the current key',
    });
    const saveServerBtn = el('button', {
      class: 'btn btn--primary',
      onClick: async () => {
        try {
          // Send the key only when one was typed, so a blank field keeps the baked-in / saved key.
          await api.cloudConfig({ url: urlInput.value.trim(), key: keyInput.value ? keyInput.value : undefined });
          toast('Saved', 'success');
          paint();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, [icon('checkCircle', { size: 16 }), 'Save server']);

    body.append(el('details', { class: 'collapse' }, [
      el('summary', {}, [
        el('span', { style: 'display:flex; align-items:center; gap:9px;' }, [icon('lock', { size: 16 }), 'Advanced']),
      ]),
      el('div', { class: 'collapse-body' }, [
        el('p', { class: 'muted small', style: 'margin:0 0 var(--space-4);' }, [
          'Most clinics never need this. Only change it if you’ve been given a different sync server to point at.',
        ]),
        el('div', { class: 'form-grid' }, [
          el('label', { class: 'field span-2' }, [
            el('span', { class: 'field-label' }, ['Cloud server URL']),
            urlInput,
            el('span', { class: 'field-hint' }, [st.usingDefaultCloud ? 'Using the built-in clinic cloud.' : 'Custom server.']),
          ]),
          el('label', { class: 'field span-2' }, [
            el('span', { class: 'field-label' }, ['Clinic key']),
            keyInput,
          ]),
        ]),
        el('div', { class: 'action-row', style: 'margin-top:var(--space-2);' }, [saveServerBtn]),
        el('div', { class: 'subtle small', style: 'margin-top:var(--space-3);' }, [`Device ID: ${st.deviceId}`]),
      ]),
    ]));
  }

  /* ---- Audit ---- */
  async function auditTab(body) {
    const log = await api.audit(200);
    clear(body);
    body.append(el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Audit log']),
      el('p', { class: 'muted', style: 'margin:0 0 var(--space-4);' }, ['A record of recent activity across the clinic — who did what, and when.']),
      el('div', { class: 'data-table-wrap' }, [
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
      ]),
    ]));
  }

  paint();
  return root;
}
