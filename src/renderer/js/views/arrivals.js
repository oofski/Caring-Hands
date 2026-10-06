import { el, mount, clear, modal } from '../dom.js';
import { captureConsent } from '../components/consentCapture.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { stationNoteComposer } from '../components/stationNotes.js';
import { matchesPatient } from '../patientSort.js';

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
//
// The matching itself is shared with every other station (patientSort.js), which
// also fixed two things this copy got wrong: a date of birth typed as 03/04/1977
// — the format the date box asks for — and a phone typed with dashes or brackets
// both found nobody.
function matches(p, q) {
  return matchesPatient(p, q, [VISIT_LABEL[p.visit_type]]);
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
    // Signed up online and never came. Listed here, on the screen where the
    // decision was made, so it can be seen and undone where it was made.
    const allNoShows = patients.filter((p) => p.status === 'no_show').sort(byName);
    const noShows = allNoShows.filter((p) => matches(p, query));
    // Whether someone came is the front desk's call.
    const canMarkNoShow = store.is('admin') || store.is('registration');
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
      if (p.station_note_count) {
        tags.push(el('span', {
          class: 'crm-chip crm-chip--warn',
          title: 'A handover note is already on this patient for the clinician',
        }, [`${p.station_note_count} note${p.station_note_count > 1 ? 's' : ''}`]));
      }

      // THE missing step. A returning patient starts a new visit with no
      // consents — correctly, because consent is per visit — but nothing at the
      // desk could take one, and routing refuses them without it. The only
      // screen that could capture a consent sat behind that same refusal, so a
      // returning patient could not be seen at all. Now the desk can take it,
      // which is where the patient actually is.
      const consentBtns = [];
      if (!p.general_signed) {
        consentBtns.push(el('button', {
          class: 'btn btn--soft btn--sm',
          title: 'Have the patient read and sign the general consent now',
          onClick: async () => { if (await captureConsent(p, 'general')) load(); },
        }, [icon('pen', { size: 14 }), 'Sign general consent']));
      }
      if (p.needs_surgery_consent && !p.surgery_signed) {
        consentBtns.push(el('button', {
          class: 'btn btn--soft btn--sm',
          title: 'This visit is an extraction, so the oral-surgery consent is needed too',
          onClick: async () => { if (await captureConsent(p, 'oral_surgery')) load(); },
        }, [icon('pen', { size: 14 }), 'Sign surgery consent']));
      }

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
      // Confirming is refused while a consent is outstanding, so say so on the
      // button rather than letting the desk find out by pressing it.
      if (consentBtns.length) {
        confirmBtn.disabled = true;
        confirmBtn.title = 'Take the outstanding consent first — this patient cannot be sent through without it.';
      }

      return el('div', { class: 'arrival-row' }, [
        el('div', { class: 'arrival-who' }, [
          el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
          el('div', { class: 'subtle small' }, [
            [p.age != null ? `${p.age} yrs` : null, VISIT_LABEL[p.visit_type] || p.complaint || null]
              .filter(Boolean).join(' · ') || '—',
          ]),
          el('div', { class: 'arrival-tags' }, tags),
          // The desk meets the patient first and hears things the form never
          // asks about — very anxious, came with a translator, mentioned chest
          // pain last week. Until now there was nowhere to put any of it, so it
          // reached the dentist only if someone remembered to say it out loud.
          el('button', {
            class: 'btn btn--ghost btn--sm',
            style: 'margin-top:var(--space-2)',
            title: 'Leave a short note for the dentist or hygienist',
            onClick: () => noteFor(p),
          }, [icon('pen', { size: 14 }), p.station_note_count ? 'Notes for the clinician' : 'Note for the clinician']),
        ]),
        confirmed
          ? el('div', { class: 'arrival-done' }, [
            el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Here']),
            el('div', { class: 'subtle small' }, [STATION_LABEL[p.route] ? `Going to: ${STATION_LABEL[p.route]}` : 'No station set']),
          ])
          : el('div', { class: 'arrival-actions' }, [
            ...consentBtns,
            el('label', { class: 'field field--inline' }, [
              el('span', { class: 'field-label' }, ['Station']),
              stationSel,
            ]),
            confirmBtn,
            // Only someone who signed up online and has shown no sign of being
            // here. A desk registration was in front of the desk by definition.
            canMarkNoShow && p.preregistered && !p.has_vitals
              ? el('button', {
                class: 'btn btn--ghost btn--sm',
                title: 'They signed up online but did not come to the clinic',
                onClick: () => markNoShow(p),
              }, ['No-show'])
              : null,
          ]),
      ]);
    }

    async function markNoShow(p) {
      const ok = await modal({
        title: `Mark ${p.first_name} ${p.last_name} as a no-show?`,
        body: 'They signed up online but did not come to the clinic. They will be listed under <b>Did not attend</b>, kept in Records, and <b>not counted as a patient seen</b> in the reports.<br><br>If they turn up later, use <b>They came after all</b> and carry on as normal.',
        confirmText: 'Mark as no-show',
        cancelText: 'Cancel',
      });
      if (!ok) return;
      try { await api.markNoShow(p.id); ctx.toast(`${p.first_name} ${p.last_name} is marked as a no-show.`, 'success'); load(); }
      catch (e) { ctx.toast(e.message, 'error'); }
    }

    async function undoNoShow(p) {
      try { await api.undoNoShow(p.id); ctx.toast(`${p.first_name} ${p.last_name} is back in the waiting list.`, 'success'); load(); }
      catch (e) { ctx.toast(e.message, 'error'); }
    }

    // The end-of-clinic sweep. Folded away, and confirmed with the names, because
    // pressing it at ten in the morning would mark everyone still on their way.
    const sweepable = allWaiting.filter((p) => p.preregistered && !p.has_vitals);
    async function markAllNoShows() {
      const names = sweepable.slice(0, 25).map((p) => `${p.last_name}, ${p.first_name}`);
      const ok = await modal({
        title: `Mark ${sweepable.length} patient(s) as no-shows?`,
        body: 'Only do this once the clinic is over. Everyone below signed up online and has not been confirmed here or had vitals taken:<br><br>'
          + names.map((n) => n.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))).join('<br>')
          + (sweepable.length > names.length ? `<br>…and ${sweepable.length - names.length} more` : '')
          + '<br><br>Any of them can be put back with <b>They came after all</b>.',
        confirmText: `Mark ${sweepable.length} as no-shows`,
        cancelText: 'Cancel',
        danger: true,
      });
      if (!ok) return;
      try { const r = await api.markNoShows(); ctx.toast(`${r.marked} patient(s) marked as no-shows.`, 'success'); load(); }
      catch (e) { ctx.toast(e.message, 'error'); }
    }

    // Its own dialog rather than another control in an already-busy row, and
    // the same composer the vitals station uses, so a note written at the desk
    // and one written at vitals read identically at the chair.
    async function noteFor(p) {
      const composer = stationNoteComposer(p.id, {});
      await modal({
        title: `Note for the clinician — ${p.first_name} ${p.last_name}`,
        body: composer.node,
        confirmText: 'Done',
      });
      load();
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
      tab === 'prereg' && canMarkNoShow && sweepable.length
        ? el('details', { class: 'collapse' }, [
          el('summary', {}, [`End of clinic — mark everyone who never came (${sweepable.length})`]),
          el('div', { class: 'collapse-body' }, [
            el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3)' }, [
              'Once the clinic is over, anyone who signed up online and never arrived can be marked as a no-show in one go, so they are not counted as patients seen. Each can still be put back individually.',
            ]),
            el('button', { class: 'btn btn--soft btn--sm', onClick: markAllNoShows }, [`Mark ${sweepable.length} as no-shows…`]),
          ]),
        ])
        : null,
      tab === 'prereg' && allNoShows.length
        ? el('div', { class: 'card' }, [
          el('div', { class: 'section-title-row' }, [
            el('h2', { class: 'section-title' }, ['Did not attend']),
            el('span', { class: 'crm-col-count' }, [String(noShows.length)]),
          ]),
          el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3)' }, ['Signed up online but did not come. Not counted as patients seen. Kept in Records under “No-shows only”.']),
          noShows.length
            ? el('div', { class: 'arrival-list' }, noShows.map((p) => el('div', { class: 'arrival-row arrival-row--noshow' }, [
              el('div', { class: 'arrival-who' }, [
                el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
                el('div', { class: 'subtle small' }, [[p.age != null ? `${p.age} yrs` : null, p.phone || null].filter(Boolean).join(' · ') || '—']),
              ]),
              el('div', { class: 'arrival-actions' }, [
                el('span', { class: 'pill pill--neutral' }, [el('span', { class: 'pill-dot' }), 'No-show']),
                canMarkNoShow
                  ? el('button', { class: 'btn btn--soft btn--sm', onClick: () => undoNoShow(p) }, [icon('refresh', { size: 14 }), 'They came after all'])
                  : null,
              ]),
            ])))
            : el('p', { class: 'muted', style: 'margin:0' }, [emptyText(false)]),
        ])
        : null,
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
