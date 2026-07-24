import { el, clear, mount, toast, modal } from '../dom.js';
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
    ctx.setDetail && ctx.setDetail(false);
    const patients = await api.listPatients({});
    const ready = patients.filter((p) => p.status === 'completed');
    const done = patients.filter((p) => p.status === 'dismissed');
    const rowFor = (p) => el('tr', { style: 'cursor:pointer', onClick: () => detail(p.id) }, [
      el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`])]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [statusPill(p.status),
        // Green "Left" tag once the patient has actually been checked out.
        p.status === 'dismissed' ? el('span', { class: 'pill pill--success', style: 'margin-left:6px', title: 'Checked out — the patient has left' }, [el('span', { class: 'pill-dot' }), 'Left']) : null]),
      el('td', {}, [el('button', { class: 'btn btn--primary btn--sm', onClick: (e) => { e.stopPropagation(); detail(p.id); } }, ['Review', icon('chevron', { size: 15 })])]),
    ]);
    clear(root);
    mount(root,
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, ['Check-Out']), el('p', { class: 'view-sub' }, [`${ready.length} ready to check out · ${done.length} checked out`])]),
        el('div', { class: 'view-head-actions' }, [el('button', { class: 'btn btn--ghost btn--sm', onClick: queue }, [icon('refresh', { size: 15 }), 'Refresh'])]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('checkCircle', { size: 15 }), 'Ready to check out']),
        el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Status', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, ready.length ? ready.map(rowFor) : [el('tr', {}, [el('td', { colspan: 5, class: 'empty' }, ['No patients waiting for check-out.'])])]),
        ])]),
      ]),
      done.length ? el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, ['Checked out today']),
        el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table data-table--mini' }, [
          el('tbody', {}, done.map(rowFor)),
        ])]),
      ]) : null,
      // USB tools live below the queue so the dismiss list leads. Collapsed by
      // default to declutter; upload/clear stay fully available inside.
      el('details', { class: 'collapse' }, [
        el('summary', {}, [el('span', { style: 'display:flex; align-items:center; gap:9px;' }, [icon('usb', { size: 15 }), 'USB tools'])]),
        el('div', { class: 'collapse-body' }, [await usbBar()]),
      ]),
    );
  }

  async function detail(id) {
    ctx.setDetail && ctx.setDetail(true);
    const p = await api.getPatient(id);
    const tx = p.treatment || {};
    // v1.2.1: locking is optional now — a patient can be checked out once their
    // visit is complete (or even in progress), no forced sign-off/lock required.
    const locked = !!tx.locked;
    const visitComplete = p.status === 'completed' || locked;
    const canDismiss = p.status !== 'dismissed' && p.status !== 'checked_in';

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
          el('div', { class: `card ${visitComplete ? '' : 'card--alert'}` }, [
            el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Visit review']),
            locked
              ? el('div', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Provider signed off — record locked'])
              : visitComplete
                ? el('div', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Visit marked complete'])
                : el('div', { class: 'pill pill--warning' }, [el('span', { class: 'pill-dot' }), 'Visit still in progress — you can still check the patient out']),
            el('div', { class: 'kv-grid', style: 'margin-top:12px' }, [
              kv('Provider', tx.provider_name), kv('Completed', tx.completed_at ? fmtWhen(tx.completed_at) : '—'),
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
              // Optional artefacts, grouped and de-emphasised so they read as
              // secondary to the single primary action below.
              el('div', { class: 'action-stack' }, [
                el('span', { class: 'field-label' }, ['Before dismissing (optional)']),
                el('button', { class: 'btn btn--ghost btn--block', onClick: async () => { try { const r = await api.pdfGenerate(id, 'summary'); if (r && r.saved) toast('Saved: ' + r.path, 'success'); } catch (e) { toast(e.message, 'error'); } } }, [icon('save', { size: 16 }), 'Patient summary PDF']),
                p.email
                  ? el('button', { class: 'btn btn--ghost btn--block', onClick: () => emailSummary(p) }, [icon('mail', { size: 16 }), 'Email summary to patient'])
                  : el('div', {}, [
                      el('button', { class: 'btn btn--ghost btn--block', disabled: 'disabled' }, [icon('mail', { size: 16 }), 'Email summary to patient']),
                      el('p', { class: 'view-sub', style: 'margin-top:6px' }, ['No email on file.']),
                    ]),
              ]),
              // Primary action — the climax: last, prominent, on its own.
              p.status === 'dismissed'
                ? el('div', { class: 'pill pill--neutral', style: 'margin-top:8px' }, [`Dismissed by ${p.dismissed_by_name || '—'} · ${fmtWhen(p.dismissed_at)}`])
                : el('button', { class: 'btn btn--primary btn--block', style: 'margin-top:8px', disabled: canDismiss ? null : 'disabled', onClick: () => dismiss(p) }, [icon('checkCircle', { size: 16 }), 'Verify & dismiss patient']),
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

  // Email the visit summary to the patient. mailto cannot auto-attach a file
  // cross-platform, so we save the summary PDF first and the user attaches it in
  // their email program — same offline flow as records.js emailRecord.
  async function emailSummary(p) {
    if (!p.email) return;
    const ok = await modal({
      title: 'Email summary to patient', cancelText: 'Cancel', confirmText: 'Open email',
      body: `This saves the summary PDF and opens your email program addressed to <b>${p.email}</b>. Attach the saved PDF before sending.`,
    });
    if (!ok) return;
    try {
      const r = await api.pdfGenerate(p.id, 'summary');
      if (r && r.saved) {
        await api.openExternal(`mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent('Your Caring Hands visit summary')}&body=${encodeURIComponent('Your visit summary from Caring Hands Worldwide is attached.')}`);
        toast('Summary saved — attach it in your email program.', 'success');
      }
    } catch (e) { toast(e.message, 'error'); }
  }

  function kv(label, val) { return el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, [label]), el('span', { class: 'kv-val' }, [val || '—'])]); }
}
