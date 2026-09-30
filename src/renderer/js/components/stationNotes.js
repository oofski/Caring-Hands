import { el, clear, toast } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';

// Short handover notes from the front desk and the vitals station, for whoever
// sees the patient next.
//
// Shared for the same reason vitalsStrip.js is: the stations that WRITE these
// and the clinicians who READ them are different people on different screens,
// and a note that renders one way at the desk and another at the chair is worse
// than no note at all.
//
// APPEND-ONLY. Two stations write here and neither can see the other's screen.
// A single editable box is the exact shape that let a second dentist silently
// destroy the first one's triage findings, so it is not offered.

const fmtWhen = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? String(ts) : d.toLocaleString();
};

// One note, as the clinician reads it: what was said, which station said it,
// who wrote it, and when.
function noteRow(n) {
  return el('div', { class: 'station-note' }, [
    el('div', { class: 'station-note-text' }, [n.note || '']),
    el('div', { class: 'station-note-by' }, [
      el('span', { class: 'pill pill--warning' }, [n.station || 'Clinic']),
      ' ',
      [n.by_name || 'Unknown', fmtWhen(n.at)].filter(Boolean).join(' · '),
    ]),
  ]);
}

// Read-only, for the dentist and the hygienist.
//
// Returns null when there is nothing to say. That is the opposite of the rule
// for triage findings — "not triaged" is itself something the dentist must
// know, whereas "the desk had no concerns" is the ordinary case and a card
// saying so on every chart would train people to scroll past this one.
export function stationNotes(p) {
  const list = ((p && p.triage && p.triage.station_notes) || []);
  if (!list.length) return null;
  return el('div', { class: 'card station-notes' }, [
    el('div', { class: 'card-title' }, [
      icon('alert', { size: 15 }),
      list.length > 1 ? `Notes from the front desk & vitals (${list.length})` : 'Note from the front desk & vitals',
    ]),
    el('div', { class: 'station-note-list' }, list.map(noteRow)),
  ]);
}

// The composer, for the two stations that meet the patient before a clinician
// does. Returns { node, refresh }.
//
// Takes a patient ID, NOT a patient. The front desk does not hold patients:get,
// so it cannot fetch one; it reads and writes these notes through their own two
// channels and sees nothing else about the chart. `notes` seeds the list for a
// caller that already has them (the vitals screen), and is fetched otherwise.
//
// `onSaved` is called with the new list so the caller can repaint; optional,
// since the list below the box is re-rendered here either way.
export function stationNoteComposer(patientId, { notes = null, onSaved, compact = false } = {}) {
  let items = Array.isArray(notes) ? notes.slice() : [];
  const list = el('div', { class: 'station-note-list' });
  const box = el('textarea', {
    class: 'input textarea',
    rows: compact ? 2 : 3,
    maxlength: 500,
    placeholder: 'e.g. Very anxious about the needle · Came with a translator · Hard of hearing on the left',
  });
  const btn = el('button', { class: 'btn btn--soft btn--sm' }, [icon('pen', { size: 14 }), 'Add note for the clinician']);

  function paint() {
    clear(list);
    items.forEach((n) => list.append(noteRow(n)));
  }

  // Only when the caller could not supply them. A failure here is not worth an
  // error on screen: the box still works, and the note still lands.
  if (!Array.isArray(notes)) {
    api.stationNotes(patientId)
      .then((got) => { items = Array.isArray(got) ? got : []; paint(); })
      .catch(() => {});
  }

  btn.addEventListener('click', async () => {
    const text = box.value.trim();
    if (!text) { toast('Write the note first.', 'info'); box.focus(); return; }
    btn.disabled = true;
    try {
      const res = await api.addStationNote(patientId, text);
      items = (res && Array.isArray(res.station_notes)) ? res.station_notes : items;
      box.value = '';
      paint();
      toast('Note added — the clinician will see it on the chart.', 'success');
      if (onSaved) onSaved(items);
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; }
  });

  paint();
  const node = el('div', { class: 'station-note-compose' }, [
    el('span', { class: 'field-label' }, ['Anything the dentist should know?']),
    el('span', { class: 'field-hint' }, ['A short note — it shows on the chart at the chair and prints on the clinical record. It cannot be edited afterwards, so anyone reading it knows who wrote it and when.']),
    list,
    box,
    el('div', { class: 'action-row', style: 'margin-top:var(--space-2)' }, [btn]),
  ]);
  return { node, refresh: (next) => { if (Array.isArray(next)) items = next; paint(); } };
}
