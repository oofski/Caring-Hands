import { el } from '../dom.js';
import { matchesPatient } from '../patientSort.js';

// "Find a patient" for every station's queue — the same box the front desk has
// had on Arrivals, asked for by the clinic after a large clinic where Vitals,
// the dentists and Cleanings each had dozens of people on screen at once.
//
// Two things make this harder than it looks, and both are handled here so no
// station has to rediscover them:
//
// 1. Every station REBUILDS its whole screen when it repaints, which would
//    destroy an input mid-word. The input is built ONCE and handed back to the
//    view to re-insert, so focus and caret survive (keepFocus below).
// 2. When cloud sync pulls new data, app.js may render a brand-new copy of the
//    view. What was typed is therefore remembered per screen at MODULE level,
//    so another laptop syncing does not wipe the search off this one.

const remembered = new Map();

export function patientSearch(key, { onChange, placeholder } = {}) {
  let query = remembered.get(key) || '';
  const input = el('input', {
    class: 'input',
    type: 'search',
    placeholder: placeholder || 'Search name, phone, or date of birth…',
    value: query,
  });
  const set = (v) => {
    query = String(v == null ? '' : v).trim();
    if (query) remembered.set(key, query); else remembered.delete(key);
  };
  input.addEventListener('input', () => { set(input.value); if (onChange) onChange(); });

  return {
    input,
    get query() { return query; },

    // Filter a list. `extra(p)` returns screen-specific text worth matching.
    filter: (list, extra) => (list || []).filter((p) => matchesPatient(p, query, extra ? extra(p) : [])),

    // The card: the box, and — while a search is active — how many people it
    // is hiding and a way to clear it. Hiding someone silently is how a
    // patient gets missed, so the count is always on screen.
    card({ shown, total } = {}) {
      return el('div', { class: 'card arrival-search' }, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { class: 'field-label' }, ['Find a patient']),
          input,
        ]),
        query
          ? el('p', { class: 'muted small', style: 'margin:var(--space-2) 0 0' }, [
            `Showing ${shown} of ${total}`,
            total > shown ? ` · ${total - shown} hidden by the search` : '',
            ' · ',
            el('a', {
              href: '#',
              onClick: (e) => { e.preventDefault(); set(''); input.value = ''; if (onChange) onChange(); input.focus(); },
            }, ['Clear']),
          ])
          : null,
      ]);
    },

    // What an empty table should say. "Nobody is waiting" while a search is
    // hiding six people would send a patient home.
    emptyText: (normal) => (query ? `No match for “${query}”.` : normal),

    // Rebuild the screen without losing the cursor in the box.
    keepFocus(rebuild) {
      const had = document.activeElement === input;
      const caret = had ? input.selectionStart : null;
      rebuild();
      if (had) {
        input.focus();
        if (caret != null) { try { input.setSelectionRange(caret, caret); } catch (_e) { /* not supported */ } }
      }
    },
  };
}
