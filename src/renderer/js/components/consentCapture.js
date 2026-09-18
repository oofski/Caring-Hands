import { el, modal, toast } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { SignaturePad } from './signature.js';

// Capture a consent on this device, with the patient in front of you.
//
// Shared by the dentist's chair AND the front desk. The front desk needs it
// because a RETURNING patient starts a new visit with no consents — correctly,
// since consent is per visit — but until this existed nothing anywhere could
// take that signature. Routing refused them for want of a consent and the only
// screen that could capture one sat behind that same refusal, so a returning
// patient could not be seen at all.
//
// The signature is REQUIRED. It used to say "signature optional" here while the
// gate that decides whether a consent counts requires a real one, so a consent
// saved at the chair could read as "Signed" on this dialog and still leave the
// patient blocked — and print as NOT SIGNED on the record. The kiosk and the
// online form have both required a real signature since v1.7.0; this is now the
// same rule on all three.
export async function captureConsent(patient, type) {
  const isSurgery = type === 'oral_surgery';
  const paras = isSurgery ? t('consent.oralSurgeryFull') : t('consent.generalFull');
  const list = Array.isArray(paras) ? paras : [paras];

  const textBox = el('div', {
    style: 'max-height:40vh;overflow:auto;border:var(--border-line);border-radius:var(--radius-sm);padding:var(--space-3);background:var(--surface);margin-bottom:var(--space-3)',
  }, list.map((para, i) => el('p', { style: 'margin:0 0 var(--space-2);font-size:var(--fs-sm)' }, [isSurgery ? para : `${i + 1}. ${para}`])));

  const agree = el('input', { type: 'checkbox', class: 'big-check' });
  const signer = el('input', { class: 'input', placeholder: 'Patient / guardian name', value: `${patient.first_name || ''} ${patient.last_name || ''}`.trim() });
  const teeth = isSurgery ? el('input', { class: 'input', placeholder: 'e.g. 18, 19', value: '' }) : null;
  const sig = SignaturePad();

  // A minor cannot consent for themselves — the same rule the kiosk and the
  // online form apply, so who signed is identifiable on every path.
  const age = ageOf(patient.dob);
  const isMinor = age != null && age < 18;
  const relationship = el('input', { class: 'input', placeholder: 'e.g. mother, father, guardian' });

  const body = el('div', {}, [
    isMinor ? el('div', { class: 'minor-banner' }, [`This patient is ${age} — a parent or guardian must sign.`]) : null,
    textBox,
    isSurgery ? el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Tooth number(s) for this consent']), teeth]) : null,
    el('label', { class: 'agree-row' }, [agree, el('span', {}, [t('consent.agree')])]),
    el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Patient / guardian name']), signer]),
    isMinor ? el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Relationship to the patient']), relationship]) : null,
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Signature']), sig.node]),
    el('p', { class: 'field-hint' }, ['The patient signs on the screen. A consent without a signature does not count, so this cannot be left blank.']),
  ]);

  const ok = await modal({
    title: isSurgery ? t('consent.surgeryTitle') : t('consent.generalTitle'),
    body,
    confirmText: 'Save consent',
    cancelText: 'Cancel',
  });
  if (!ok) return false;
  if (!agree.checked) { toast('Please check the agreement box to record consent.', 'error'); return false; }
  if (!signer.value.trim()) { toast('Enter the patient / guardian name.', 'error'); return false; }
  if (isMinor && !relationship.value.trim()) { toast('This patient is under 18 — say who is signing.', 'error'); return false; }
  if (sig.isEmpty()) { toast('Please have the patient sign before saving.', 'error'); return false; }

  try {
    await api.addConsent(patient.id, {
      type,
      language: 'en',
      signer_name: signer.value.trim(),
      relationship: isMinor ? relationship.value.trim() : undefined,
      signature_png: sig.getDataUrl(),
      tooth_numbers: isSurgery ? teeth.value.trim() : undefined,
    });
    toast('Consent recorded', 'success');
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

function ageOf(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
}
