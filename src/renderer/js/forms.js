import { el } from './dom.js';

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
