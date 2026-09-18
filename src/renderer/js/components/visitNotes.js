import { el, modal, toast } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';

// What a clinician can still do once a visit is finished.
//
// Before this, finishing a visit was a one-way door. A completed record was
// technically still editable but the patient had dropped out of the clinician's
// queue, so there was no way back to it; a LOCKED record refused every change
// outright. Either way, a dentist who remembered something on the way back from
// the waiting room had nowhere to put it.
//
// Two different needs, two different answers:
//   · Add a note  — append-only, works even on a locked record. The signed note
//                   stands and the new thought sits beside it, stamped.
//   · Re-open     — unlock and pull the patient back into the queue, for when
//                   the record is wrong rather than merely incomplete.
export function visitNotesPanel(p, { onChange } = {}) {
  const tx = p.treatment || {};
  const addenda = Array.isArray(tx.addenda) ? tx.addenda : [];
  const finished = !!tx.completed_at || !!tx.locked || p.status === 'completed' || p.status === 'dismissed';

  // Nothing to show on a visit that has not been finished yet — the notes box
  // on the chart is the right place to write while the patient is in the chair.
  if (!finished && !addenda.length) return null;

  const body = el('div', {});

  if (addenda.length) {
    body.append(el('div', { class: 'addendum-list' }, addenda.map((a) => el('div', { class: 'addendum' }, [
      el('div', { class: 'addendum-meta' }, [
        a.by_name || 'Unknown',
        el('span', { class: 'subtle' }, [' · ' + fmt(a.at)]),
      ]),
      el('div', { class: 'addendum-body' }, [a.note || '']),
    ]))));
  } else {
    body.append(el('p', { class: 'subtle small', style: 'margin:0 0 var(--space-3)' }, ['No notes have been added since this visit was completed.']));
  }

  if (finished) {
    const box = el('textarea', {
      class: 'input textarea', rows: 3,
      placeholder: 'Add a note to this finished visit — it is added beside the original, not over it.',
    });
    const addBtn = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, [icon('pen', { size: 14 }), 'Add note']);
    addBtn.addEventListener('click', async () => {
      const text = box.value.trim();
      if (!text) { toast('Write the note before adding it.', 'error'); box.focus(); return; }
      try {
        await api.addTreatmentNote(p.id, text);
        toast('Note added', 'success');
        box.value = '';
        if (onChange) onChange();
      } catch (e) { toast(e.message, 'error'); }
    });

    const reopenBtn = el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      title: 'Unlock this record and put the patient back in your queue so it can be corrected',
    }, [icon('refresh', { size: 14 }), 'Re-open to correct']);
    reopenBtn.addEventListener('click', async () => {
      const ok = await modal({
        title: 'Re-open this visit?',
        body: 'This unlocks the record and puts the patient back in your queue so you can change what was written.'
          + '<br><br>Use this when the record is <b>wrong</b>. To add something that was simply left out, add a note instead — '
          + 'that keeps the original note intact, which is what a clinical record is for.'
          + '<br><br>Re-opening is recorded in the audit log.',
        confirmText: 'Re-open for editing', cancelText: 'Cancel',
      });
      if (!ok) return;
      try {
        await api.reopenTreatment(p.id);
        toast('Visit re-opened — the patient is back in your queue', 'success');
        if (onChange) onChange();
      } catch (e) { toast(e.message, 'error'); }
    });

    body.append(
      el('div', { class: 'field', style: 'margin-top:var(--space-3)' }, [box]),
      el('div', { class: 'inline-row', style: 'margin-top:0' }, [addBtn, reopenBtn]),
    );
  }

  return el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Notes after this visit was completed']),
    body,
  ]);
}

function fmt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}
