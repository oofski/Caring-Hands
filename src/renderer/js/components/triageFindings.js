import { el, toast } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';

// What the TRIAGE dentist found, shown to whoever picks the patient up next.
//
// The clinic now runs a triage dentist who sees each patient first and a
// separate treatment dentist who does the work. Before this, the triage fields
// sat two-thirds down the dentist screen as plain editable inputs,
// indistinguishable from fields the treating dentist was expected to fill in
// himself — and the per-tooth notes were reachable only by hovering an SVG
// tooltip, which on a clinic touchscreen means they were unreadable.
//
// Shared with the hygienist for the same reason components/vitalsStrip.js is:
// both clinicians work from these findings and must never be shown different
// things.
//
//   triageFindings(p, { editable, odo, onSaved }) -> { node, editable, collect }
//
// `collect()` returns the findings when this screen may record them and `{}`
// when it may not, so the caller's save path needs no conditionals — spreading
// `{}` contributes no keys, and saveTriage only writes the keys it is given.
export function triageFindings(p, { editable = false, odo = null, onSaved = null } = {}) {
  const tr = (p && p.triage) || {};
  const recorded = !!tr.triaged_at;

  if (!editable && !recorded) {
    // Saying nothing would read as "nothing to worry about". A treating dentist
    // needs to know the difference between "triage found nothing" and "nobody
    // has triaged this patient".
    return {
      editable: false,
      collect: () => ({}),
      node: el('div', { class: 'card triage-findings triage-findings--none' }, [
        el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Triage findings']),
        el('p', { class: 'subtle small', style: 'margin:0' }, [
          'No triage findings recorded — this patient has not been seen by a triage dentist.',
        ]),
      ]),
    };
  }

  /* ---------------- read-only: what the triage dentist found ---------------- */
  if (!editable) {
    const teeth = Array.isArray(tr.teeth) ? tr.teeth : [];
    const notes = tr.teeth_notes || {};
    const perTooth = teeth.filter((id) => notes[id]);

    return {
      editable: false,
      collect: () => ({}),
      node: el('div', { class: 'card triage-findings' }, [
        el('div', { class: 'card-head-row' }, [
          el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Triage findings']),
          el('span', { class: 'pill pill--success' }, [
            el('span', { class: 'pill-dot' }),
            `Triaged by ${p.triaged_by_name || 'a dentist'}${tr.triaged_at ? ' · ' + fmtWhen(tr.triaged_at) : ''}`,
          ]),
        ]),
        tr.complaint
          ? el('div', { class: 'kv', style: 'margin-bottom:var(--space-2)' }, [
            el('span', { class: 'kv-label' }, ['Chief complaint']),
            el('strong', {}, [tr.complaint]),
          ])
          : null,
        teeth.length
          ? el('div', { style: 'margin-bottom:var(--space-2)' }, [
            el('span', { class: 'kv-label' }, ['Teeth of concern']),
            el('div', { class: 'chip-row', style: 'margin-top:4px' },
              teeth.map((id) => el('span', { class: 'tooth-tag tooth-tag--concern' }, [`#${id}`]))),
          ])
          : null,
        // The per-tooth notes, as text. This is the point of the whole card:
        // they exist, they sync, and until now they appeared on no screen and
        // in no PDF — only in a tooltip.
        perTooth.length
          ? el('div', { class: 'triage-tooth-notes' }, perTooth.map((id) => el('div', { class: 'kv' }, [
            el('span', { class: 'kv-label' }, [`Tooth #${id}`]),
            el('span', {}, [notes[id]]),
          ])))
          : null,
        tr.notes
          ? el('div', { style: 'margin-top:var(--space-2)' }, [
            el('span', { class: 'kv-label' }, ['Triage notes']),
            el('p', { style: 'margin:2px 0 0; white-space:pre-wrap' }, [tr.notes]),
          ])
          : null,
        tr.xray_station
          ? el('p', { class: 'subtle small', style: 'margin:var(--space-2) 0 0' }, [`X-ray station #${tr.xray_station}`])
          : null,
      ]),
    };
  }

  /* ---------------- editable: the triage dentist recording ---------------- */
  const complaint = el('input', { class: 'input', placeholder: 'What brought them in', value: tr.complaint || (p.dental_history && p.dental_history.reason) || '' });
  const notesBox = el('textarea', { class: 'input textarea', rows: 3, placeholder: 'What you found, and what the treating dentist should know' }, [tr.notes || '']);
  const teethLine = el('span', { class: 'subtle small' }, ['none yet']);

  const readTeeth = () => (odo && odo.getConcern ? odo.getConcern() : (tr.teeth || []));
  const refreshTeeth = () => {
    const t = readTeeth();
    teethLine.textContent = t.length ? t.map((id) => '#' + id).join(', ') : 'none yet';
  };
  refreshTeeth();

  const collect = () => ({
    complaint: complaint.value.trim(),
    notes: notesBox.value.trim(),
    teeth: readTeeth(),
    teeth_notes: (odo && odo.getConcernNotes) ? odo.getConcernNotes() : (tr.teeth_notes || {}),
  });

  const saveBtn = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, [icon('checkCircle', { size: 15 }), recorded ? 'Update triage findings' : 'Save triage findings']);
  saveBtn.addEventListener('click', async () => {
    try {
      // `attribute` only on the FIRST record, so correcting your own findings
      // later does not restamp the time they were made.
      await api.saveTriage(p.id, collect(), { attribute: !recorded });
      toast(recorded ? 'Triage findings updated' : 'Triage findings saved', 'success');
      if (onSaved) onSaved();
    } catch (e) { toast(e.message, 'error'); }
  });

  return {
    editable: true,
    collect,
    refreshTeeth,
    node: el('div', { class: 'card triage-findings triage-findings--edit' }, [
      el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), recorded ? 'Your triage findings' : 'Triage findings']),
      el('p', { class: 'subtle small', style: 'margin:0 0 var(--space-3)' }, [
        'Record what you found. The treating dentist will see this and cannot overwrite it.',
      ]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Chief complaint']), complaint]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, ['Teeth of concern']),
        el('div', { class: 'inline-row', style: 'margin:0;gap:8px;align-items:baseline' }, [
          teethLine,
          el('span', { class: 'subtle small' }, ['— tag them on the chart below as “Triage concern”']),
        ]),
      ]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Triage notes']), notesBox]),
      el('div', { class: 'inline-row' }, [saveBtn]),
    ]),
  };
}

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}
