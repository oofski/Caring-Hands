import { el } from '../dom.js';
import { icon } from '../icons.js';
import { bloodThinnerText, bpStatus } from '../medFlags.js';

// The read-only summary of what the EMT station recorded before sending the
// patient on: blood pressure (red at hypertensive-crisis levels), any
// re-checks, heart rate, who took them, and the blood-thinner status.
//
// This lives in one place because BOTH clinicians need it and they must never
// show different things. The dentist had it from the start; the hygienist had
// nothing at all — which is the worse omission of the two, since a hygienist
// scaling someone on a blood thinner or in hypertensive crisis is exactly the
// case this strip exists to prevent.
export function vitalsStrip(p) {
  const tr = (p && p.triage) || {};
  const hasVitals = tr.bp_systolic != null || tr.bp_diastolic != null || tr.heart_rate != null;
  if (!hasVitals && !tr.route) return null;

  const bp = bpStatus(tr.bp_systolic, tr.bp_diastolic);
  const bpEl = (tr.bp_systolic != null || tr.bp_diastolic != null)
    ? el('span', { class: bp.high ? 'pill pill--danger' : 'small' }, [
      bp.high ? el('span', { class: 'pill-dot' }) : null,
      `BP ${tr.bp_systolic != null ? tr.bp_systolic : '—'}/${tr.bp_diastolic != null ? tr.bp_diastolic : '—'}${bp.high ? ' — HIGH' : ''}`,
    ])
    : null;

  const recheckEls = (Array.isArray(tr.bp_rechecks) ? tr.bp_rechecks : []).map((r) => {
    const st = bpStatus(r.bp_systolic, r.bp_diastolic);
    return el('span', { class: st.high ? 'pill pill--danger' : 'small' }, [
      st.high ? el('span', { class: 'pill-dot' }) : null,
      `re-check ${r.bp_systolic != null ? r.bp_systolic : '—'}/${r.bp_diastolic != null ? r.bp_diastolic : '—'}${st.high ? ' — HIGH' : ''}`,
    ]);
  });

  const rest = [];
  if (tr.heart_rate != null) rest.push(`HR ${tr.heart_rate}`);
  if (p.vitals_by_name) rest.push(`recorded by ${p.vitals_by_name}`);

  // Blood-thinner wording comes from the ONE shared helper so it always matches
  // the danger banner and every other screen (no "No" vs "Yes" mismatch).
  const bt = bloodThinnerText(p);

  return el('div', {
    class: 'card',
    style: 'display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-3);padding:var(--space-3) var(--space-4)',
  }, [
    icon('syringe', { size: 14 }),
    bpEl,
    ...recheckEls,
    rest.length ? el('span', { class: 'small' }, [rest.join(' · ')]) : null,
    el('span', { class: bt.level === 'danger' ? 'pill pill--danger' : 'subtle small' }, [bt.text]),
    tr.route ? el('span', { class: 'subtle small' }, [p.routed_by_name ? `Sent here by ${p.routed_by_name}` : 'Routed by the EMT station']) : null,
  ]);
}
