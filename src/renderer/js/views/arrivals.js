import { el, mount, clear } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { store } from '../store.js';

// The front desk's arrival check. Everyone who has checked in — at the desk or
// online, sometimes days earlier — waits here until someone confirms they are
// physically present. Confirming is also the last checkpoint before clinical
// care: it refuses to pass a patient whose consents aren't signed, and it makes
// sure they leave with a station assigned.
const VISIT_LABEL = {
  extraction_pain: 'Extraction — in pain',
  extraction_no_pain: 'Extraction — no pain',
  filling: 'Filling',
  cleaning: 'Dental cleaning',
};
const STATION_LABEL = { dentist: 'Dentist', hygienist: 'Hygienist' };

// Find someone by what the desk actually has in front of them: a name said out
// loud, a phone number, or a date of birth off an ID.
function matches(p, q) {
  if (!q) return true;
  const hay = [p.first_name, p.last_name, p.dob, p.phone, VISIT_LABEL[p.visit_type], p.complaint]
    .filter(Boolean).join(' ').toLowerCase();
  // Every word must appear somewhere, so "ruiz car" finds Carmen Ruiz.
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// Surname first, the way a desk list is read down.
const byName = (a, b) =>
  String(a.last_name || '').localeCompare(String(b.last_name || ''), undefined, { sensitivity: 'base' }) ||
  String(a.first_name || '').localeCompare(String(b.first_name || ''), undefined, { sensitivity: 'base' });

export function renderArrivals(ctx) {
  const root = el('div', { class: 'view' });
  let latest = { event: null, patients: [] };
  let query = '';
  // 'prereg' = registered online | 'walkin' = registered at the desk. Null until
  // the first paint picks whichever queue actually has people waiting, so the
  // desk never opens onto an empty tab; after that the user's choice sticks.
  let tab = null;

  // Built once and re-used across repaints, so a queue refresh mid-typing can't
  // wipe what the desk has entered.
  const search = el('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search name, phone, or date of birth…',
    onInput: (e) => { query = e.target.value.trim(); paint(); },
  });

  async function load() {
    const [event, patients] = await Promise.all([api.activeEvent(), api.listPatients({})]);
    store.setEvent(event);
    latest = { event, patients };
    paint();
  }

  function paint() {
    const { event, patients } = latest;

    // Anyone past check-in has obviously arrived, so this screen only concerns
    // the checked-in stage.
    const checkedIn = patients.filter((p) => p.status === 'checked_in');
    // Two very different queues: people who filled the form online and are being
    // met for the first time, and people registered at the desk just now.
    const tabCounts = {
      prereg: checkedIn.filter((p) => p.preregistered).length,
      walkin: checkedIn.filter((p) => !p.preregistered).length,
    };
    if (tab === null) {
      const waitingIn = (pre) => checkedIn.filter((p) => !!p.preregistered === pre && !p.arrived_at).length;
      tab = waitingIn(true) ? 'prereg' : (waitingIn(false) ? 'walkin' : 'prereg');
    }
    const inTab = checkedIn.filter((p) => (tab === 'prereg' ? p.preregistered : !p.preregistered));
    const allWaiting = inTab.filter((p) => !p.arrived_at).sort(byName);
    const allHere = inTab.filter((p) => p.arrived_at).sort(byName);
    const waiting = allWaiting.filter((p) => matches(p, query));
    const here = allHere.filter((p) => matches(p, query));
    const hiddenBySearch = (allWaiting.length - waiting.length) + (allHere.length - here.length);

    function row(p, confirmed) {
      // Station comes from what the patient said they need; the desk can override.
      const stationSel = el('select', { class: 'input input--sm' }, [
        el('option', { value: '' }, ['— choose —']),
        el('option', { value: 'dentist', selected: p.route === 'dentist' }, ['Dentist']),
        el('option', { value: 'hygienist', selected: p.route === 'hygienist' }, ['Hygienist']),
      ]);
      if (p.route) stationSel.value = p.route;

      const tags = [];
      if (p.preregistered) tags.push(el('span', { class: 'crm-chip crm-chip--prereg', title: 'Pre-registered online' }, ['Pre-reg']));
      tags.push(p.consents_ok
        ? el('span', { class: 'crm-chip crm-chip--ok', title: 'Every consent this visit needs is signed' }, [icon('check', { size: 10 }), 'Consents signed'])
        : el('span', { class: 'crm-chip crm-chip--warn', title: 'A required consent is not signed yet' }, ['Consent missing']));
      if (p.on_thinner) tags.push(el('span', { class: 'crm-chip crm-chip--warn', title: 'On a blood thinner' }, ['Thinner']));

      const confirmBtn = el('button', {
        class: 'btn btn--primary btn--sm',
        onClick: async () => {
          confirmBtn.disabled = true;
          try {
            await api.confirmArrival(p.id, stationSel.value || undefined);
            ctx.toast(`${p.first_name} ${p.last_name} is checked in and ready — sent to ${STATION_LABEL[stationSel.value || p.route] || 'their station'}.`, 'success');
            load();
          } catch (e) {
            ctx.toast(e.message, 'error');
            confirmBtn.disabled = false;
          }
        },
      }, [icon('checkCircle', { size: 15 }), 'They’re here — ready to go']);

      return el('div', { class: 'arrival-row' }, [
        el('div', { class: 'arrival-who' }, [
          el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
          el('div', { class: 'subtle small' }, [
            [p.age != null ? `${p.age} yrs` : null, VISIT_LABEL[p.visit_type] || p.complaint || null]
              .filter(Boolean).join(' · ') || '—',
          ]),
          el('div', { class: 'arrival-tags' }, tags),
        ]),
        confirmed
          ? el('div', { class: 'arrival-done' }, [
            el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Here']),
            el('div', { class: 'subtle small' }, [STATION_LABEL[p.route] ? `Going to: ${STATION_LABEL[p.route]}` : 'No station set']),
          ])
          : el('div', { class: 'arrival-actions' }, [
            el('label', { class: 'field field--inline' }, [
              el('span', { class: 'field-label' }, ['Station']),
              stationSel,
            ]),
            confirmBtn,
          ]),
      ]);
    }

    const who = tab === 'prereg' ? 'pre-registered' : 'desk-registered';
    const emptyText = (confirmed) => (query
      ? 'No match here for “' + query + '”.'
      : (confirmed
        ? `No ${who} patients confirmed yet.`
        : `No ${who} patients waiting — everyone here has been confirmed.`));
    const section = (title, note, list, confirmed) => el('div', { class: 'card' }, [
      el('div', { class: 'section-title-row' }, [
        el('h2', { class: 'section-title' }, [title]),
        el('span', { class: 'crm-col-count' }, [String(list.length)]),
      ]),
      el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3)' }, [note]),
      list.length
        ? el('div', { class: 'arrival-list' }, list.map((p) => row(p, confirmed)))
        : el('p', { class: 'muted', style: 'margin:0' }, [emptyText(confirmed)]),
    ]);

    // Keep the caret where the user left it — paint() runs on every keystroke.
    const hadFocus = document.activeElement === search;
    const caret = hadFocus ? search.selectionStart : null;

    mount(root,
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('h1', {}, ['Arrivals']),
          el('p', { class: 'view-sub' }, [
            'Confirm each patient is here before they go through. ',
            el('strong', {}, [event ? event.name : 'No active event']),
            ' · listed A–Z by surname',
          ]),
        ]),
        el('div', { class: 'view-head-actions' }, [
          el('button', { class: 'btn btn--primary', onClick: () => ctx.navigate('kiosk') }, [icon('clipboard', { size: 16 }), 'Start patient check-in']),
          el('button', { class: 'btn btn--ghost btn--sm', onClick: load }, [icon('refresh', { size: 15 }), 'Refresh']),
        ]),
      ]),
      el('div', { class: 'arrival-tabs' }, [
        ['prereg', 'Pre-registered online', 'People who filled the form in before they came'],
        ['walkin', 'Registered at the desk', 'People checked in here at the clinic'],
      ].map(([key, label, hint]) => el('button', {
        class: 'arrival-tab' + (tab === key ? ' is-active' : ''),
        title: hint,
        onClick: () => { tab = key; paint(); },
      }, [
        el('span', { class: 'arrival-tab-label' }, [label]),
        el('span', { class: 'crm-col-count' }, [String(tabCounts[key])]),
      ]))),

      el('div', { class: 'card arrival-search' }, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { class: 'field-label' }, ['Find a patient']),
          search,
        ]),
        query
          ? el('p', { class: 'muted small', style: 'margin:var(--space-2) 0 0' }, [
            `Showing ${waiting.length + here.length} of ${allWaiting.length + allHere.length}`,
            hiddenBySearch ? ` · ${hiddenBySearch} hidden by the search` : '',
            ' · ',
            el('a', { href: '#', onClick: (e) => { e.preventDefault(); query = ''; search.value = ''; paint(); search.focus(); } }, ['Clear']),
          ])
          : null,
      ]),
      section('Waiting to be confirmed', 'Tap “They’re here” when the patient is in front of you. We check their consents and their station at the same time.', waiting, false),
      section('Confirmed here', 'These patients are present and waiting for vitals.', here, true),
    );

    if (hadFocus) { search.focus(); if (caret != null) try { search.setSelectionRange(caret, caret); } catch { /* not supported */ } }
  }

  load().catch((e) => ctx.toast(e.message, 'error'));
  const timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); return; }
    load().catch(() => {});
  }, 15000);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return root;
}
