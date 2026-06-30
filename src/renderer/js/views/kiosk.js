import { el, clear, toast } from '../dom.js';
import { icon } from '../icons.js';
import { t, getLang, setLang, languageList, conditions, allergies, referrals, speak, stopSpeaking } from '../i18n.js';
import { textField, textArea, selectField, yesNo, chipGrid } from '../forms.js';
import { SignaturePad } from '../components/signature.js';
import { api } from '../api.js';

export function renderKiosk(ctx) {
  const data = {
    language: 'en',
    demographics: {}, medical_history: {}, dental_history: {}, consents: [],
  };
  const root = el('div', { class: 'kiosk' });
  let started = false;
  let eventLangs = null; // CSV of language codes enabled for the active event

  // Step builders return { title, node, collect } — collect() validates and
  // writes into `data`, returning false to block navigation.
  let steps = [];
  let idx = 0;
  let current = null; // the step object built for the CURRENTLY displayed inputs

  function computeSteps() {
    const list = [stepDemographics, stepMedical, stepDental, stepGeneralConsent];
    if (data.dental_history.may_need_extraction === 'yes') list.push(stepSurgeryConsent);
    list.push(stepReview);
    return list;
  }

  // Pre-start language gate: the patient picks a language BEFORE any form chrome
  // renders, so the whole wizard appears in their language (no English flash).
  function renderGate() {
    stopSpeaking();
    clear(root);
    root.append(
      el('div', { class: 'kiosk-gate' }, [
        el('img', { class: 'kiosk-gate-logo', src: '../../assets/logo.svg', alt: 'Caring Hands' }),
        el('div', { class: 'kiosk-welcome' }, [t('intake.welcome')]),
        el('div', { class: 'kiosk-choose' }, [t('intake.chooseLanguage')]),
        el('div', { class: 'lang-grid' }, languageList(eventLangs).map((l) =>
          el('button', { class: 'lang-card', onClick: () => chooseLanguage(l.code) }, [
            el('span', { class: 'lang-native' }, [l.native]),
            el('span', { class: 'lang-en' }, [l.label]),
          ])
        )),
        el('button', { class: 'btn btn--ghost btn--sm kiosk-gate-exit', onClick: () => { setLang('en'); ctx.navigate('login'); } }, [icon('x', { size: 16 }), t('common.cancel')]),
      ])
    );
  }

  function chooseLanguage(code) {
    data.language = code;
    setLang(code);
    started = true;
    steps = computeSteps();
    idx = 0;
    paint();
  }

  function go(n) {
    stopSpeaking();
    if (n > idx) {
      // Collect from the inputs currently on screen (not a fresh rebuild).
      const ok = current && current.collect ? current.collect() : true;
      if (ok === false) return;
      steps = computeSteps(); // surgery step may appear/disappear
    }
    idx = Math.max(0, Math.min(steps.length - 1, n));
    paint();
  }

  function paint() {
    const step = steps[idx]();
    current = step;
    const total = steps.length;
    clear(root);

    const progress = el('div', { class: 'kiosk-progress' },
      steps.map((_, i) => el('span', { class: 'kp-dot' + (i === idx ? ' kp-dot--on' : i < idx ? ' kp-dot--done' : '') }))
    );

    const header = el('div', { class: 'kiosk-header' }, [
      el('img', { class: 'kiosk-logo', src: '../../assets/logo.svg', alt: 'Caring Hands' }),
      el('div', { class: 'kiosk-step-label' }, [`${t('intake.step')} ${idx + 1} ${t('intake.of')} ${total} · ${step.title}`]),
      el('button', { class: 'btn btn--ghost btn--sm btn--icon kiosk-exit', onClick: () => ctx.navigate('login') }, [icon('x', { size: 16 })]),
    ]);

    const body = el('div', { class: 'kiosk-body' }, [step.node]);

    const nav = el('div', { class: 'kiosk-nav' }, [
      idx > 0 ? el('button', { class: 'btn btn--ghost btn--lg', onClick: () => go(idx - 1) }, [icon('back', { size: 18 }), t('common.back')]) : el('span'),
      idx < total - 1
        ? el('button', { class: 'btn btn--primary btn--lg', onClick: () => go(idx + 1) }, [t('common.next'), icon('chevron', { size: 18 })])
        : el('button', { class: 'btn btn--primary btn--lg', onClick: submit }, [icon('check', { size: 18 }), t('common.submit')]),
    ]);

    root.append(progress, header, body, nav);
  }

  /* ---------------- Steps ---------------- */

  function stepDemographics() {
    const d = data.demographics;
    const first = textField(t('intake.firstName'), { value: data.first_name, required: true });
    const last = textField(t('intake.lastName'), { value: data.last_name, required: true });
    const dob = textField(t('intake.dob'), { value: data.dob, type: 'date' });
    const gender = selectField(t('intake.gender'), [
      { value: '', label: '—' },
      { value: 'male', label: t('intake.genderM') },
      { value: 'female', label: t('intake.genderF') },
      { value: 'other', label: t('intake.genderO') },
    ], { value: data.gender });
    const phone = textField(t('intake.phone'), { value: data.phone, type: 'tel', required: true });
    const email = textField(t('intake.email'), { value: data.email, type: 'email' });
    const address = textField(t('intake.address'), { value: d.address });
    const mailing = textField(t('intake.mailing'), { value: d.mailing_address });
    const marital = selectField(t('intake.marital'), [
      { value: '', label: '—' },
      { value: 'single', label: t('intake.single') },
      { value: 'married', label: t('intake.married') },
      { value: 'divorced', label: t('intake.divorced') },
      { value: 'widowed', label: t('intake.widowed') },
    ], { value: d.marital_status });
    const children = chipGrid(t('intake.children'), [
      { key: '0-5', label: t('intake.child0') }, { key: '6-12', label: t('intake.child6') },
      { key: '13-17', label: t('intake.child13') }, { key: '18+', label: t('intake.child18') },
    ], { selected: d.children || [] });
    const emName = textField(t('intake.emergencyName'), { value: d.emergency_name, required: true });
    const emPhone = textField(t('intake.emergencyPhone'), { value: d.emergency_phone, type: 'tel', required: true });

    // F4: referral as a dropdown of known sources; "Other" reveals a free-text field.
    const referral = selectField(t('intake.referral'), [
      { value: '', label: '—' },
      ...referrals().map((r) => ({ value: r.key, label: r.label })),
    ], { value: d.referral });
    const referralOther = textField(t('intake.referralOther'), { value: d.referral_other });
    const referralOtherWrap = el('div', { class: 'span-2' }, [referralOther.node]);
    const syncReferralOther = () => { referralOtherWrap.style.display = referral.get() === 'other' ? '' : 'none'; };
    referral.input.addEventListener('change', syncReferralOther);
    syncReferralOther();

    const node = el('div', { class: 'form-grid' }, [
      first.node, last.node, dob.node, gender.node, phone.node, email.node,
      el('div', { class: 'span-2' }, [address.node]),
      el('div', { class: 'span-2' }, [mailing.node]),
      marital.node, children.node, emName.node, emPhone.node,
      el('div', { class: 'span-2' }, [referral.node]),
      referralOtherWrap,
    ]);

    return {
      title: t('intake.s_demographics'),
      node,
      collect: () => {
        if (!first.get() || !last.get()) { toast(t('common.required') + ': ' + t('intake.firstName') + ' / ' + t('intake.lastName'), 'error'); return false; }
        if (!phone.get()) { toast(t('common.required') + ': ' + t('intake.phone'), 'error'); return false; }
        if (!emName.get()) { toast(t('common.required') + ': ' + t('intake.emergencyName'), 'error'); return false; }
        if (!emPhone.get()) { toast(t('common.required') + ': ' + t('intake.emergencyPhone'), 'error'); return false; }
        data.first_name = first.get(); data.last_name = last.get();
        data.dob = dob.get(); data.gender = gender.get(); data.phone = phone.get(); data.email = email.get();
        Object.assign(data.demographics, {
          address: address.get(), mailing_address: mailing.get(), marital_status: marital.get(),
          children: children.get(), emergency_name: emName.get(), emergency_phone: emPhone.get(),
          referral: referral.get(),
          referral_other: referral.get() === 'other' ? referralOther.get() : '',
        });
        return true;
      },
    };
  }

  function stepMedical() {
    const m = data.medical_history;

    // F5/F6: self-reported vitals at the top of the medical step (parsed to ints on collect).
    const sys = textField(t('intake.bpSys'), { value: m.bp_systolic != null ? String(m.bp_systolic) : '', type: 'number' });
    const dia = textField(t('intake.bpDia'), { value: m.bp_diastolic != null ? String(m.bp_diastolic) : '', type: 'number' });
    const hr = textField(t('intake.hr'), { value: m.heart_rate != null ? String(m.heart_rate) : '', type: 'number' });
    const vitalsBlock = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, [t('intake.vitalsTitle')]),
      el('div', { class: 'form-grid' }, [sys.node, dia.node, hr.node]),
    ]);

    const underTx = yesNo(t('intake.underTreatment'), { value: m.under_treatment, yesText: t('common.yes'), noText: t('common.no') });
    const hosp = yesNo(t('intake.hospitalized'), { value: m.hospitalized, yesText: t('common.yes'), noText: t('common.no') });
    const tobacco = yesNo(t('intake.tobacco'), { value: m.tobacco, yesText: t('common.yes'), noText: t('common.no') });
    const pregnancy = yesNo(t('intake.pregnancy'), { value: m.pregnancy, yesText: t('common.yes'), noText: t('common.no') });

    // F7: allergy chips + an "other" chip that reveals a free-text field.
    const allergyGrid = chipGrid(t('intake.allergiesTitle'),
      [...allergies().map((a) => ({ key: a.key, label: a.label, flag: true })), { key: 'other', label: t('common.other') }],
      { selected: m.allergies || [], hint: t('intake.allergiesHint') });
    const allergyOther = textField(t('intake.allergyOther'), { value: m.allergies_other });
    const allergyOtherWrap = el('div', { class: 'span-2' }, [allergyOther.node]);
    const syncAllergyOther = () => { allergyOtherWrap.style.display = allergyGrid.get().includes('other') ? '' : 'none'; };
    allergyGrid.node.addEventListener('click', syncAllergyOther);
    syncAllergyOther();

    // F8: condition chips + an "other" chip that reveals a free-text field.
    const condGrid = chipGrid(t('intake.conditionsTitle'),
      [...conditions().map((c) => ({ key: c.key, label: c.label, flag: c.flag })), { key: 'other', label: t('common.other') }],
      { selected: m.conditions || [], hint: t('intake.conditionsHint') });
    const condOther = textField(t('intake.conditionOther'), { value: m.conditions_other });
    const condOtherWrap = el('div', { class: 'span-2' }, [condOther.node]);
    const syncCondOther = () => { condOtherWrap.style.display = condGrid.get().includes('other') ? '' : 'none'; };
    condGrid.node.addEventListener('click', syncCondOther);
    syncCondOther();

    // Medication table
    const medRows = el('div', { class: 'med-rows' });
    function addMedRow(med = {}) {
      const name = el('input', { class: 'input', placeholder: t('intake.medName'), value: med.name || '' });
      const dose = el('input', { class: 'input', placeholder: t('intake.medDose'), value: med.dose || '' });
      const reason = el('input', { class: 'input', placeholder: t('intake.medReason'), value: med.reason || '' });
      const row = el('div', { class: 'med-row' }, [name, dose, reason,
        el('button', { class: 'btn btn--ghost btn--sm btn--icon', type: 'button', onClick: () => row.remove() }, [icon('x', { size: 15 })])]);
      row._get = () => ({ name: name.value.trim(), dose: dose.value.trim(), reason: reason.value.trim() });
      medRows.append(row);
    }
    (m.medications || []).forEach(addMedRow);

    const node = el('div', {}, [
      vitalsBlock,
      el('div', { class: 'form-grid' }, [underTx.node, hosp.node, tobacco.node, pregnancy.node]),
      el('div', { class: 'span-2' }, [allergyGrid.node]),
      el('div', { class: 'form-grid' }, [allergyOtherWrap]),
      el('div', { class: 'span-2' }, [condGrid.node]),
      el('div', { class: 'form-grid' }, [condOtherWrap]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, [t('intake.medsTitle')]),
        medRows,
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => addMedRow() }, ['+ ' + t('intake.addMed')]),
      ]),
    ]);

    // Parse a numeric input to an int, or undefined when blank/invalid (so we omit it).
    const intOrOmit = (s) => {
      const v = (s || '').trim();
      if (!v) return undefined;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    };

    return {
      title: t('intake.s_medical'),
      node,
      collect: () => {
        const allergySel = allergyGrid.get();
        const condSel = condGrid.get();
        Object.assign(m, {
          under_treatment: underTx.get(), hospitalized: hosp.get(), tobacco: tobacco.get(), pregnancy: pregnancy.get(),
          allergies: allergySel, conditions: condSel,
          allergies_other: allergySel.includes('other') ? allergyOther.get() : '',
          conditions_other: condSel.includes('other') ? condOther.get() : '',
          medications: Array.from(medRows.children).map((r) => r._get()).filter((x) => x.name),
        });
        // F5/F6: write intake vitals as ints; omit (delete) when blank.
        const sysN = intOrOmit(sys.get()), diaN = intOrOmit(dia.get()), hrN = intOrOmit(hr.get());
        if (sysN !== undefined) m.bp_systolic = sysN; else delete m.bp_systolic;
        if (diaN !== undefined) m.bp_diastolic = diaN; else delete m.bp_diastolic;
        if (hrN !== undefined) m.heart_rate = hrN; else delete m.heart_rate;
        return true;
      },
    };
  }

  function stepDental() {
    const dh = data.dental_history;
    const reason = textArea(t('intake.reason'), { value: dh.reason, rows: 2 });
    const goals = textArea(t('intake.goals'), { value: dh.goals, rows: 2 });
    const prior = textField(t('intake.priorDentist'), { value: dh.prior_dentist });
    const yn = (k, label) => yesNo(label, { value: dh[k], yesText: t('common.yes'), noText: t('common.no') });
    const gum = yn('gum_bleeding', t('intake.gumBleeding'));
    const sores = yn('sores', t('intake.sores'));
    const jaw = yn('jaw_injury', t('intake.jawInjury'));
    const grinding = yn('grinding', t('intake.grinding'));
    const postExt = yn('post_extraction_bleeding', t('intake.postExtraction'));
    const ortho = yn('ortho', t('intake.ortho'));
    const cosmetic = yn('cosmetic', t('intake.cosmetic'));
    const mayExtract = yesNo(getLang() === 'es'
      ? '¿Tiene dolor o cree que puede necesitar una extracción hoy?'
      : 'Are you in pain or do you think you may need a tooth removed today?',
      { value: dh.may_need_extraction, yesText: t('common.yes'), noText: t('common.no') });

    const node = el('div', {}, [
      el('div', { class: 'span-2' }, [reason.node]),
      el('div', { class: 'span-2' }, [goals.node]),
      el('div', { class: 'form-grid' }, [
        prior.node, gum.node, sores.node, jaw.node, grinding.node, postExt.node, ortho.node, cosmetic.node,
      ]),
      el('div', { class: 'highlight-field' }, [mayExtract.node]),
    ]);

    return {
      title: t('intake.s_dental'),
      node,
      collect: () => {
        Object.assign(dh, {
          reason: reason.get(), goals: goals.get(), prior_dentist: prior.get(),
          gum_bleeding: gum.get(), sores: sores.get(), jaw_injury: jaw.get(), grinding: grinding.get(),
          post_extraction_bleeding: postExt.get(), ortho: ortho.get(), cosmetic: cosmetic.get(),
          may_need_extraction: mayExtract.get(),
        });
        return true;
      },
    };
  }

  function age() {
    if (!data.dob) return null;
    const d = new Date(data.dob);
    if (isNaN(d)) return null;
    return Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
  }

  // Shared consent-section builder with per-section read-aloud.
  function consentSection({ title, intro, clauses, extra }) {
    const wrap = el('div', { class: 'consent-block' });
    const fullText = [title, intro, ...(clauses || []), ...(extra ? [extra] : [])].filter(Boolean).join('. ');
    const readLabel = el('span', {}, [t('common.readAloud')]);
    const readBtn = el('button', { class: 'btn btn--read', type: 'button' }, [icon('speaker', { size: 16 }), readLabel]);
    let reading = false;
    const setReading = (on) => { reading = on; readLabel.textContent = on ? t('common.stopReading') : t('common.readAloud'); };
    readBtn.addEventListener('click', () => {
      if (reading) { stopSpeaking(); setReading(false); return; }
      setReading(true);
      speak(fullText, () => setReading(false));
    });
    wrap.append(el('div', { class: 'consent-head' }, [el('h3', {}, [title]), readBtn]));
    if (intro) wrap.append(el('p', { class: 'consent-intro' }, [intro]));
    if (clauses) wrap.append(el('ol', { class: 'consent-list' }, clauses.map((c) => el('li', {}, [c]))));
    if (extra) wrap.append(el('p', { class: 'consent-extra' }, [extra]));
    return wrap;
  }

  function stepGeneralConsent() {
    const minor = age() != null && age() < 18;
    const sigPad = SignaturePad();
    const agree = el('input', { class: 'big-check', type: 'checkbox' });
    const signer = textField(t('intake.signerName'), { value: '', required: true });
    const rel = textField(t('intake.relationship'), { value: minor ? '' : '' });

    // F9: render the verbatim Oregon general-consent paragraph as the primary
    // consent text. It already includes the COVID acknowledgment, so we do NOT
    // append a separate COVID section. The read-aloud button reads this text.
    const sections = el('div', {}, [
      consentSection({
        title: t('consent.generalTitle'),
        intro: t('consent.oregon'),
      }),
    ]);

    const node = el('div', { class: 'consent-screen' }, [
      minor ? el('div', { class: 'minor-banner' }, [icon('alert', { size: 16 }), ' ' + t('intake.minorNotice')]) : null,
      sections,
      el('label', { class: 'agree-row' }, [agree, el('span', {}, [t('consent.agree')])]),
      el('div', { class: 'form-grid' }, [signer.node, rel.node]),
      sigPad.node,
    ]);

    return {
      title: t('intake.s_consent'),
      node,
      collect: () => {
        if (!agree.checked) { toast(t('consent.agree'), 'error'); return false; }
        if (!signer.get()) { toast(t('common.required') + ': ' + t('intake.signerName'), 'error'); return false; }
        if (sigPad.isEmpty()) { toast(t('common.signHere'), 'error'); return false; }
        upsertConsent('general', {
          signer_name: signer.get(), relationship: rel.get(),
          signature_png: sigPad.getDataUrl(),
          version: `general-oregon-${getLang()}-v1+covid`,
        });
        return true;
      },
    };
  }

  function stepSurgeryConsent() {
    const sigPad = SignaturePad();
    const agree = el('input', { class: 'big-check', type: 'checkbox' });
    const signer = textField(t('intake.signerName'), { value: signerFromGeneral() });

    // F10: tooth numbers are NOT collected from the patient — the provider
    // records them chairside. Show a read-only note instead of an input.
    const toothNote = {
      es: 'Número(s) de diente: lo completará el proveedor en el sillón dental.',
      ru: 'Номер(а) зуба: заполняется врачом у кресла.',
    }[getLang()] || 'Tooth number(s): to be completed at chairside by the provider.';

    const node = el('div', { class: 'consent-screen' }, [
      consentSection({
        title: t('consent.surgeryTitle'),
        intro: t('consent.surgeryIntro'),
        clauses: t('consent.surgeryClauses'),
      }),
      consentSection({ title: t('consent.postOpTitle'), clauses: [t('consent.postOp')], extra: t('consent.emergency') }),
      el('div', { class: 'banner banner--info' }, [icon('flag', { size: 16 }), ' ' + toothNote]),
      el('label', { class: 'agree-row' }, [agree, el('span', {}, [t('consent.agree')])]),
      signer.node,
      sigPad.node,
    ]);

    return {
      title: t('intake.s_surgery'),
      node,
      collect: () => {
        if (!agree.checked) { toast(t('consent.agree'), 'error'); return false; }
        if (sigPad.isEmpty()) { toast(t('common.signHere'), 'error'); return false; }
        upsertConsent('oral_surgery', {
          signer_name: signer.get() || signerFromGeneral(),
          signature_png: sigPad.getDataUrl(),
          version: `oral_surgery-${getLang()}-v1`,
        });
        return true;
      },
    };
  }

  function stepReview() {
    const m = data.medical_history, dh = data.dental_history;
    const condLabels = conditions().filter((c) => (m.conditions || []).includes(c.key)).map((c) => c.label);
    const allergyLabels = allergies().filter((a) => (m.allergies || []).includes(a.key)).map((a) => a.label);
    const row = (label, val) => el('div', { class: 'review-row' }, [
      el('span', { class: 'review-label' }, [label]), el('span', { class: 'review-val' }, [val || '—']),
    ]);
    const node = el('div', { class: 'review' }, [
      el('h3', {}, [t('intake.reviewTitle')]),
      el('p', { class: 'muted' }, [t('intake.reviewHint')]),
      el('div', { class: 'review-card' }, [
        row(t('intake.firstName') + ' / ' + t('intake.lastName'), `${data.first_name} ${data.last_name}`),
        row(t('intake.dob'), data.dob),
        row(t('intake.phone'), data.phone),
        row(t('intake.allergiesTitle'), allergyLabels.join(', ')),
        row(t('intake.conditionsTitle'), condLabels.join(', ')),
        row(t('intake.reason'), dh.reason),
        row(t('intake.s_consent'), data.consents.map((c) => c.type === 'general' ? 'General — signed' : 'Oral Surgery — signed').join(' · ')),
      ]),
    ]);
    return { title: t('intake.s_review'), node, collect: () => true };
  }

  /* ---------------- helpers ---------------- */

  function upsertConsent(type, fields) {
    const now = new Date().toISOString();
    const existing = data.consents.find((c) => c.type === type);
    const base = { type, language: getLang(), signed_at: now, relationship: '', ...fields };
    if (existing) Object.assign(existing, base);
    else data.consents.push(base);
  }
  function signerFromGeneral() {
    const g = data.consents.find((c) => c.type === 'general');
    return g ? g.signer_name : `${data.first_name} ${data.last_name}`.trim();
  }

  async function submit() {
    // Capture the step the patient is sitting on before submitting (the final
    // "Submit" tap bypasses forward-nav collect()).
    const ok = current && current.collect ? current.collect() : true;
    if (ok === false) return;
    try {
      const patient = await api.createPatient(data);
      showThankYou(patient);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function showThankYou(patient) {
    stopSpeaking();
    clear(root);

    // F19: optional offline transfer of this check-in to a USB drive. Does not
    // block the thank-you flow — the patient can simply tap Done.
    const usbLabel = { es: 'Guardar en unidad USB', ru: 'Сохранить на USB-накопитель' }[getLang()] || 'Save to USB drive';
    const usbBtn = el('button', { class: 'btn btn--soft btn--lg', type: 'button' }, [icon('usb', { size: 18 }), usbLabel]);
    usbBtn.addEventListener('click', async () => {
      usbBtn.disabled = true;
      try {
        const res = await api.usbWriteCheckin(patient.id);
        toast((res && res.message) || (typeof res === 'string' ? res : t('common.saved')), 'success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        usbBtn.disabled = false;
      }
    });

    root.append(el('div', { class: 'kiosk-thanks' }, [
      el('div', { class: 'thanks-check' }, [icon('check', { size: 44, stroke: 2.2 })]),
      el('h1', {}, [t('intake.thanks')]),
      el('p', {}, [t('intake.thanksSub')]),
      el('div', { class: 'thanks-name' }, [`${patient.first_name} ${patient.last_name}`]),
      el('div', { class: 'thanks-actions' }, [
        usbBtn,
        el('button', { class: 'btn btn--primary btn--lg', onClick: () => { setLang('en'); ctx.navigate('login'); } }, [t('intake.done')]),
      ]),
    ]));
  }

  // Boot: show the language gate, then refine it with the active event's
  // enabled language packs once they load.
  setLang('en');
  renderGate();
  api.activeEvent().then((ev) => {
    if (ev && ev.languages) { eventLangs = ev.languages; if (!started) renderGate(); }
  }).catch(() => {});
  return root;
}
