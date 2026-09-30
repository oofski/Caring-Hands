import { el } from './dom.js';

// Constrain an input to digits only, at most `max` (e.g. a 10-digit phone number).
// Strips anything non-numeric on input and caps the length.
export function limitDigits(inputEl, max = 10) {
  if (!inputEl) return;
  inputEl.setAttribute('inputmode', 'numeric');
  // Deliberately NO maxlength: the browser applies it to the RAW text, so
  // pasting "(503) 555-0199" would be cut to "(503) 555-" and end up as the
  // six digits 503555. Stripping first and slicing after keeps all ten.
  const clean = () => { const d = (inputEl.value || '').replace(/\D/g, '').slice(0, max); if (d !== inputEl.value) inputEl.value = d; };
  inputEl.addEventListener('input', clean);
  clean();
}

/* ------------------------------------------------------------------ */
/*  Date of birth                                                      */
/* ------------------------------------------------------------------ */

// Convert a typed MM/DD/YYYY (or an already-ISO date) to YYYY-MM-DD.
// Returns '' for anything that is not a real calendar date, or is in the
// future — nobody was born tomorrow, and a typo like 2206 for 2026 is far
// easier to make on a keypad than with a picker.
export function isoFromTyped(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  let y, m, d;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const us = /^(\d{1,2})\D(\d{1,2})\D(\d{4})$/.exec(t);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (us) { m = +us[1]; d = +us[2]; y = +us[3]; }
  else return '';
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900) return '';
  // Round-trip through Date to reject 31 February and friends. Built from
  // parts (not parsed from a string) so there is no timezone ambiguity.
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
  if (dt.getTime() > Date.now()) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Display an ISO date as MM/DD/YYYY for the typed field.
export function typedFromIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || '');
}

// A date of birth people can TYPE.
//
// This was an <input type="date">, which on a phone is a calendar picker with
// no keyboard path — patients could fill the form on a computer and not on
// their phone, which is how most of them arrive at a public link.
//
// Typed as MM/DD/YYYY, always STORED as YYYY-MM-DD. That split matters: age is
// re-derived from this string by `new Date(dob)` in a dozen places, and
// new Date() reads "1990-01-02" as UTC midnight but "01/02/1990" as LOCAL
// midnight. Storing the slashed form would shift every age by up to a day —
// enough to flip 17 to 18 and change whether a guardian has to sign.
//
// Returns the same { node, get, set, input } contract as textField, so it is a
// drop-in at every call site. get() returns ISO, or '' when what is typed is
// not a real date.
export function dateField(label, { value = '', required = false, hint = 'MM/DD/YYYY' } = {}) {
  const input = el('input', {
    class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'bday',
    placeholder: 'MM/DD/YYYY', value: typedFromIso(value),
  });
  // Slashes are inserted as you type, so nobody has to find them on a numeric
  // keypad. Digits are stripped first and sliced after, for the same reason
  // limitDigits above refuses to set maxlength: a pasted "01/02/1990" must not
  // be cut before the non-digits are removed.
  const clean = () => {
    const d = (input.value || '').replace(/\D/g, '').slice(0, 8);
    const out = d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`
      : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}`
        : d;
    if (out !== input.value) input.value = out;
  };
  input.addEventListener('input', clean);
  clean();
  const node = el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label, required ? el('em', { class: 'req' }, [' *']) : null]),
    input,
    hint ? el('span', { class: 'field-hint' }, [hint]) : null,
  ]);
  return {
    node,
    input,
    get: () => isoFromTyped(input.value),
    // What was actually typed, for telling "not filled in" apart from
    // "filled in wrongly" when reporting an error.
    raw: () => input.value.trim(),
    set: (v) => { input.value = typedFromIso(v); },
  };
}

// Reusable labelled form controls. Each returns { node, get, set }.

export function textField(label, { value = '', type = 'text', placeholder = '', required = false, hint = '' } = {}) {
  const input = el('input', { class: 'input', type, value, placeholder });
  const node = el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label, required ? el('em', { class: 'req' }, [' *']) : null]),
    input,
    hint ? el('span', { class: 'field-hint' }, [hint]) : null,
  ]);
  return { node, get: () => input.value.trim(), set: (v) => { input.value = v || ''; }, input };
}

export function textArea(label, { value = '', rows = 3, placeholder = '' } = {}) {
  const ta = el('textarea', { class: 'input textarea', rows, placeholder }, [value || '']);
  const node = el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label]),
    ta,
  ]);
  return { node, get: () => ta.value.trim(), set: (v) => { ta.value = v || ''; }, input: ta };
}

export function selectField(label, options, { value = '', required = false } = {}) {
  const sel = el('select', { class: 'input select' });
  options.forEach((o) => {
    const opt = el('option', { value: o.value }, [o.label]);
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  });
  const node = el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label, required ? el('em', { class: 'req' }, [' *']) : null]),
    sel,
  ]);
  return { node, get: () => sel.value, set: (v) => { sel.value = v; }, input: sel };
}

// Yes/No toggle (returns 'yes' | 'no' | '').
export function yesNo(label, { value = '', yesText = 'Yes', noText = 'No' } = {}) {
  let val = value;
  const mkBtn = (v, txt) => el('button', {
    type: 'button',
    class: 'chip-btn' + (val === v ? ' chip-btn--on' : ''),
    onClick: () => { val = val === v ? '' : v; sync(); },
  }, [txt]);
  const yes = mkBtn('yes', yesText);
  const no = mkBtn('no', noText);
  function sync() {
    yes.classList.toggle('chip-btn--on', val === 'yes');
    no.classList.toggle('chip-btn--on', val === 'no');
  }
  const node = el('div', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label]),
    el('div', { class: 'chip-row' }, [yes, no]),
  ]);
  return { node, get: () => val, set: (v) => { val = v; sync(); } };
}

// Multi-select chip grid from [{key,label,flag?}].
export function chipGrid(label, items, { selected = [], hint = '' } = {}) {
  const sel = new Set(selected);
  const grid = el('div', { class: 'chip-grid' });
  items.forEach((it) => {
    const btn = el('button', {
      type: 'button',
      class: 'chip-select' + (sel.has(it.key) ? ' chip-select--on' : '') + (it.flag ? ' chip-select--flag' : ''),
      onClick: () => { if (sel.has(it.key)) sel.delete(it.key); else sel.add(it.key); btn.classList.toggle('chip-select--on'); },
    }, [it.label]);
    grid.append(btn);
  });
  const node = el('div', { class: 'field' }, [
    label ? el('span', { class: 'field-label' }, [label]) : null,
    hint ? el('span', { class: 'field-hint' }, [hint]) : null,
    grid,
  ]);
  return { node, get: () => Array.from(sel), set: (arr) => { sel.clear(); (arr || []).forEach((k) => sel.add(k)); } };
}
