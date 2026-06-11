import { el, clear } from '../dom.js';

// Interactive tooth chart. Adult uses Universal Numbering 1–32; primary uses
// A–T. Returns the node plus get/set for the selected tooth ids.
export function ToothChart({ selected = [], onChange } = {}) {
  let sel = new Set(selected);
  let mode = 'adult';

  const grid = el('div', { class: 'teeth-grid' });

  function adultRows() {
    // Universal: upper right→left is 1–16, lower left→right is 17–32.
    const upper = Array.from({ length: 16 }, (_, i) => i + 1);
    const lower = Array.from({ length: 16 }, (_, i) => i + 17).reverse();
    return [upper, lower];
  }
  function primaryRows() {
    const letters = 'ABCDEFGHIJ'.split('');
    const lower = 'KLMNOPQRST'.split('').reverse();
    return [letters, lower];
  }

  function render() {
    clear(grid);
    const rows = mode === 'adult' ? adultRows() : primaryRows();
    const labels = mode === 'adult' ? ['Upper (Maxillary)', 'Lower (Mandibular)'] : ['Upper primary', 'Lower primary'];
    rows.forEach((row, i) => {
      const rowWrap = el('div', { class: 'teeth-row' });
      rowWrap.append(el('div', { class: 'teeth-arch-label' }, [labels[i]]));
      const line = el('div', { class: 'teeth-line' });
      row.forEach((id) => {
        const key = String(id);
        const tooth = el('button', {
          type: 'button',
          class: 'tooth' + (sel.has(key) ? ' tooth--on' : ''),
          onClick: () => {
            if (sel.has(key)) sel.delete(key); else sel.add(key);
            tooth.classList.toggle('tooth--on');
            if (onChange) onChange(get());
          },
        }, [
          el('span', { class: 'tooth-shape' }),
          el('span', { class: 'tooth-num' }, [key]),
        ]);
        line.append(tooth);
      });
      rowWrap.append(line);
      grid.append(rowWrap);
    });
  }

  const toggle = el('div', { class: 'seg-toggle' }, [
    el('button', { type: 'button', class: 'seg-btn seg-btn--on', onClick: (e) => switchMode('adult', e) }, ['Adult 1–32']),
    el('button', { type: 'button', class: 'seg-btn', onClick: (e) => switchMode('primary', e) }, ['Primary A–T']),
  ]);
  function switchMode(m, e) {
    mode = m;
    toggle.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('seg-btn--on'));
    e.currentTarget.classList.add('seg-btn--on');
    render();
  }

  const node = el('div', { class: 'toothchart' }, [toggle, grid]);
  render();

  function get() { return Array.from(sel); }
  function set(ids) { sel = new Set((ids || []).map(String)); render(); }

  return { node, get, set };
}
