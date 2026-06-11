// Minimal DOM helpers — a hyperscript-style `el` builder plus toast/modal.

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required') {
      if (v) node.setAttribute(k, k);
    } else node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  children.flat().forEach((c) => c != null && c !== false && node.append(c.nodeType ? c : document.createTextNode(String(c))));
  return node;
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host', class: 'toast-host' });
    document.body.append(host);
  }
  const t = el('div', { class: `toast toast--${kind}` }, [message]);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

// Promise-based confirm/alert dialog.
export function modal({ title, body, confirmText = 'OK', cancelText = null, danger = false }) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'modal-overlay' });
    const card = el('div', { class: 'modal-card' });
    const close = (val) => { overlay.remove(); resolve(val); };

    card.append(el('h3', { class: 'modal-title' }, [title || '']));
    const bodyNode = el('div', { class: 'modal-body' });
    if (typeof body === 'string') bodyNode.innerHTML = body;
    else if (body) bodyNode.append(body);
    card.append(bodyNode);

    const actions = el('div', { class: 'modal-actions' });
    if (cancelText) {
      actions.append(el('button', { class: 'btn btn--ghost', onClick: () => close(false) }, [cancelText]));
    }
    actions.append(
      el('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, onClick: () => close(true) }, [confirmText])
    );
    card.append(actions);
    overlay.append(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay && cancelText) close(false); });
    document.body.append(overlay);
  });
}

// Spinner-wrapped async action with optional button disabling.
export async function withBusy(button, fn) {
  const prev = button ? button.textContent : null;
  if (button) { button.disabled = true; button.classList.add('is-busy'); }
  try {
    return await fn();
  } finally {
    if (button) { button.disabled = false; button.classList.remove('is-busy'); if (prev != null) button.textContent = prev; }
  }
}
