import { el, clear, toast, modal } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { statusPill } from './dashboard.js';

const fmtWhen = (ts) => { if (!ts) return '—'; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString(); };

// Check-Out view (F16): verify the provider finished their notes before
// dismissing the patient; upload/clear the USB drive at checkout (F19).
export function renderCheckout(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function usbBar() {
    return el('div', { class: 'inline-row' }, [
      el('button', { class: 'btn btn--ghost btn--sm', onClick: async () => {
        try { const r = await api.usbUploadCheckout(); if (r.uploaded != null) toast(`Uploaded ${r.uploaded} patient file(s) from USB`, 'success'); queue(); } catch (e) { toast(e.message, 'error'); }
      } }, [icon('usb', { size: 15 }), 'Upload USB to database']),
      el('button', { class: 'btn btn--ghost btn--sm', onClick: async () => {
        const ok = await modal({ title: 'Clear USB drive?', body: 'This deletes the Caring Hands patient folder(s) on the chosen drive so it can be reused.', confirmText: 'Clear drive', cancelText: 'Cancel', danger: true });
        if (!ok) return;
        try { const r = await api.usbClear(); toast(`Cleared ${r.cleared} folder(s)`, 'success'); } catch (e) { toast(e.message, 'error'); }
      } }, [icon('trash', { size: 15 }), 'Clear USB']),
    ]);
  }

  async function queue() {
    const patients = await api.listPatients({});
    const ready = patients.filter((p) => p.status === 'completed');
    const done = patients.filter((p) => p.status === 'dismissed');
    const rowFor = (p) => el('tr', { style: 'cursor:pointer', onClick: () => detail(p.id) }, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`])]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [el('button', { class: 'btn btn--primary btn--sm', onClick: (e) => { e.stopPropagation(); detail(p.id); } }, ['Review', icon('chevron', { size: 15 })])]),
    ]);
    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, ['Check-Out']), el('p', { class: 'view-sub' }, [`${ready.length} ready to dismiss · ${done.length} dismissed`])]),
        el('div', { class: 'view-head-actions' }, [el('button', { class: 'btn btn--ghost btn--sm', onClick: queue }, [icon('refresh', { size: 15 }), 'Refresh'])]),
      ]),
      el('div', { class: 'card' }, [el('div', { class: 'card-title' }, [icon('usb', { size: 15 }), 'USB at checkout']), await usbBar()]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('checkCircle', { size: 15 }), 'Ready to dismiss']),
        el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Status', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, ready.length ? ready.map(rowFor) : [el('tr', {}, [el('td', { colspan: 5, class: 'empty' }, ['No patients waiting for check-out.'])])]),
        ])]),
      ]),
      done.length ? el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, ['Dismissed today']),
        el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table data-table--mini' }, [
          el('tbody', {}, done.map(rowFor)),
        ])]),
      ]) : null,
    );
  }

  async function detail(id) {
    const p = await api.getPatient(id);
    const tx = p.treatment || {};
    const notesComplete = !!tx.locked;

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => queue() }, [icon('back', { size: 15 }), t('common.back')]),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [p.event ? p.event.name : '']),
        ]),
        statusPill(p.status),
      ]),
      el('div', { class: 'split' }, [
        el('div', { class: 'col col--wide' }, [
          el('div', { class: `card ${notesComplete ? '' : 'card--alert'}` }, [
            el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Provider sign-off verification']),
            notesComplete
              ? el('div', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Provider has signed off — record locked'])
              : el('div', { class: 'pill pill--warning' }, [el('span', { class: 'pill-dot' }), 'NOT signed off — provider must complete & lock the record first']),
            el('div', { class: 'kv-grid', style: 'margin-top:12px' }, [
              kv('Provider', tx.provider_name), kv('Signed off', notesComplete ? fmtWhen(tx.completed_at) : '—'),
              kv('Completed by', p.completed_by_name), kv('Dental notes', tx.clinical_notes ? 'Present' : '—'),
            ]),
            tx.clinical_notes ? el('div', { class: 'box', style: 'margin-top:8px' }, [el('span', { class: 'field-label' }, ['Dental notes']), el('p', {}, [tx.clinical_notes])]) : null,
            tx.provider_signature ? el('img', { class: 'sig-locked', src: tx.provider_signature }) : null,
          ]),
        ]),
        el('div', { class: 'col' }, [
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('checkCircle', { size: 15 }), 'Actions']),
            el('div', { class: 'action-stack' }, [
              el('button', { class: 'btn btn--ghost btn--block', onClick: async () => { try { const r = await api.pdfGenerate(id, 'summary'); if (r && r.saved) toast('Saved: ' + r.path, 'success'); } catch (e) { toast(e.message, 'error'); } } }, [icon('save', { size: 16 }), 'Patient summary PDF']),
              p.status === 'dismissed'
                ? el('div', { class: 'pill pill--neutral' }, [`Dismissed by ${p.dismissed_by_name || '—'} · ${fmtWhen(p.dismissed_at)}`])
                : el('button', { class: 'btn btn--primary btn--block', disabled: notesComplete ? null : 'disabled', onClick: () => dismiss(p) }, [icon('checkCircle', { size: 16 }), 'Verify & dismiss patient']),
            ]),
          ]),
        ]),
      ]),
    );
  }

  async function dismiss(p) {
    const ok = await modal({ title: 'Dismiss patient?', body: `Confirm that ${p.first_name} ${p.last_name}'s treatment and notes are complete, and dismiss them.`, confirmText: 'Verify & dismiss', cancelText: 'Cancel' });
    if (!ok) return;
    try { await api.dismissPatient(p.id); toast('Patient dismissed', 'success'); queue(); } catch (e) { toast(e.message, 'error'); }
  }

  function kv(label, val) { return el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, [label]), el('span', { class: 'kv-val' }, [val || '—'])]); }
}
