import { el, clear, toast } from '../dom.js';
import { t, getLang, setLang, languageList, conditions, allergies, speak, stopSpeaking } from '../i18n.js';
import { textField, textArea, selectField, yesNo, chipGrid } from '../forms.js';
import { SignaturePad } from '../components/signature.js';
import { api } from '../api.js';

export function renderKiosk(ctx) {
  const data = {
    language: getLang(),
    demographics: {}, medical_history: {}, dental_history: {}, consents: [],
  };
  const root = el('div', { class: 'kiosk' });

  // Step builders return { title, node, collect } — collect() validates and
  // writes into `data`, returning false to block navigation.
  let steps = [];
  let idx = 0;

  function computeSteps() {
    const list = [stepLanguage, stepDemographics, stepMedical, stepDental, stepGeneralConsent];
    if (data.dental_history.may_need_extraction === 'yes') list.push(stepSurgeryConsent);
    list.push(stepReview);
    return list;
  }

  function go(n) {
    stopSpeaking();
    if (n > idx) {
      const ok = steps[idx].collect ? steps[idx].collect() : true;
      if (ok === false) return;
      steps = computeSteps(); // surgery step may appear/disappear
    }
    idx = Math.max(0, Math.min(steps.length - 1, n));
    paint();
  }

  function paint() {
    const step = steps[idx]();
    const total = steps.length;
    clear(root);

    const progress = el('div', { class: 'kiosk-progress' },
      steps.map((_, i) => el('span', { class: 'kp-dot' + (i === idx ? ' kp-dot--on' : i < idx ? ' kp-dot--done' : '') }))
    );

    const header = el('div', { class: 'kiosk-header' }, [
      el('img', { class: 'kiosk-logo', src: '../../assets/logo.svg', alt: 'Caring Hands' }),
      el('div', { class: 'kiosk-step-label' }, [`${t('intake.step')} ${idx + 1} ${t('intake.of')} ${total} · ${step.title}`]),
      el('button', { class: 'btn btn--ghost btn--sm kiosk-exit', onClick: () => ctx.navigate('login') }, ['✕']),
    ]);

    const body = el('div', { class: 'kiosk-body' }, [step.node]);

    const nav = el('div', { class: 'kiosk-nav' }, [
      idx > 0 ? el('button', { class: 'btn btn--ghost btn--lg', onClick: () => go(idx - 1) }, ['← ' + t('common.back')]) : el('span'),
      idx < total - 1
        ? el('button', { class: 'btn btn--primary btn--lg', onClick: () => go(idx + 1) }, [t('common.next') + ' →'])
        : el('button', { class: 'btn btn--success btn--lg', onClick: submit }, [t('common.submit')]),
    ]);

    root.append(progress, header, body, nav);
  }

  /* ---------------- Steps ---------------- */

  function stepLanguage() {
    const node = el('div', { class: 'kiosk-center' }, [
      el('div', { class: 'kiosk-welcome' }, [t('intake.welcome')]),
      el('div', { class: 'kiosk-choose' }, [t('intake.chooseLanguage')]),
      el('div', { class: 'lang-grid' }, languageList().map((l) =>
        el('button', {
          class: 'lang-card' + (data.language === l.code ? ' lang-card--on' : ''),
          onClick: () => { data.language = l.code; setLang(l.code); steps = computeSteps(); paint(); },
        }, [
          el('span', { class: 'lang-native' }, [l.native]),
          el('span', { class: 'lang-en' }, [l.label]),
        ])
      )),
    ]);
    return { title: t('intake.s_language'), node, collect: () => { setLang(data.language); return true; } };
  }

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
    const phone = textField(t('intake.phone'), { value: data.phone, type: 'tel' });
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
    const emName = textField(t('intake.emergencyName'), { value: d.emergency_name });
    const emPhone = textField(t('intake.emergencyPhone'), { value: d.emergency_phone, type: 'tel' });
    const referral = textField(t('intake.referral'), { value: d.referral });

    const node = el('div', { class: 'form-grid' }, [
      first.node, last.node, dob.node, gender.node, phone.node, email.node,
      el('div', { class: 'span-2' }, [address.node]),
      el('div', { class: 'span-2' }, [mailing.node]),
      marital.node, children.node, emName.node, emPhone.node,
      el('div', { class: 'span-2' }, [referral.node]),
    ]);

    return {
      title: t('intake.s_demographics'),
      node,
      collect: () => {
        if (!first.get() || !last.get()) { toast(t('common.required') + ': ' + t('intake.firstName') + ' / ' + t('intake.lastName'), 'error'); return false; }
        data.first_name = first.get(); data.last_name = last.get();
        data.dob = dob.get(); data.gender = gender.get(); data.phone = phone.get(); data.email = email.get();
        Object.assign(data.demographics, {
          address: address.get(), mailing_address: mailing.get(), marital_status: marital.get(),
          children: children.get(), emergency_name: emName.get(), emergency_phone: emPhone.get(), referral: referral.get(),
        });
        return true;
      },
    };
  }

  function stepMedical() {
    const m = data.medical_history;
    const underTx = yesNo(t('intake.underTreatment'), { value: m.under_treatment, yesText: t('common.yes'), noText: t('common.no') });
    const hosp = yesNo(t('intake.hospitalized'), { value: m.hospitalized, yesText: t('common.yes'), noText: t('common.no') });
    const tobacco = yesNo(t('intake.tobacco'), { value: m.tobacco, yesText: t('common.yes'), noText: t('common.no') });
    const pregnancy = yesNo(t('intake.pregnancy'), { value: m.pregnancy, yesText: t('common.yes'), noText: t('common.no') });
    const allergyGrid = chipGrid(t('intake.allergiesTitle'),
      allergies().map((a) => ({ key: a.key, label: a.label, flag: true })),
      { selected: m.allergies || [], hint: t('intake.allergiesHint') });
    const condGrid = chipGrid(t('intake.conditionsTitle'),
      conditions().map((c) => ({ key: c.key, label: c.label, flag: c.flag })),
      { selected: m.conditions || [], hint: t('intake.conditionsHint') });

    // Medication table
    const medRows = el('div', { class: 'med-rows' });
    function addMedRow(med = {}) {
      const name = el('input', { class: 'input', placeholder: t('intake.medName'), value: med.name || '' });
      const dose = el('input', { class: 'input', placeholder: t('intake.medDose'), value: med.dose || '' });
      const reason = el('input', { class: 'input', placeholder: t('intake.medReason'), value: med.reason || '' });
      const row = el('div', { class: 'med-row' }, [name, dose, reason,
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => row.remove() }, ['✕'])]);
      row._get = () => ({ name: name.value.trim(), dose: dose.value.trim(), reason: reason.value.trim() });
      medRows.append(row);
    }
    (m.medications || []).forEach(addMedRow);

    const node = el('div', {}, [
      el('div', { class: 'form-grid' }, [underTx.node, hosp.node, tobacco.node, pregnancy.node]),
      el('div', { class: 'span-2' }, [allergyGrid.node]),
      el('div', { class: 'span-2' }, [condGrid.node]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, [t('intake.medsTitle')]),
        medRows,
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => addMedRow() }, ['+ ' + t('intake.addMed')]),
      ]),
    ]);

    return {
      title: t('intake.s_medical'),
      node,
      collect: () => {
        Object.assign(m, {
          under_treatment: underTx.get(), hospitalized: hosp.get(), tobacco: tobacco.get(), pregnancy: pregnancy.get(),
          allergies: allergyGrid.get(), conditions: condGrid.get(),
          medications: Array.from(medRows.children).map((r) => r._get()).filter((x) => x.name),
        });
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
    const readBtn = el('button', { class: 'btn btn--read', type: 'button' }, ['🔊 ' + t('common.readAloud')]);
    let reading = false;
    readBtn.addEventListener('click', () => {
      if (reading) { stopSpeaking(); reading = false; readBtn.textContent = '🔊 ' + t('common.readAloud'); return; }
      reading = true; readBtn.textContent = '⏹ ' + t('common.stopReading');
      speak(fullText, () => { reading = false; readBtn.textContent = '🔊 ' + t('common.readAloud'); });
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

    const sections = el('div', {}, [
      consentSection({
        title: t('consent.generalTitle'),
        intro: t('consent.generalIntro'),
        clauses: t('consent.clauses'),
      }),
    ]);
    // COVID acknowledgment ships with the English (CHW) packet.
    if (getLang() === 'en') {
      sections.append(consentSection({ title: t('consent.covidTitle'), clauses: [t('consent.covid')] }));
    }

    const node = el('div', { class: 'consent-screen' }, [
      minor ? el('div', { class: 'minor-banner' }, ['⚠ ' + t('intake.minorNotice')]) : null,
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
          version: `general-${getLang()}-v1${getLang() === 'en' ? '+covid' : ''}`,
        });
        return true;
      },
    };
  }

  function stepSurgeryConsent() {
    const sigPad = SignaturePad();
    const agree = el('input', { class: 'big-check', type: 'checkbox' });
    const signer = textField(t('intake.signerName'), { value: signerFromGeneral() });

    const node = el('div', { class: 'consent-screen' }, [
      consentSection({
        title: t('consent.surgeryTitle'),
        intro: t('consent.surgeryIntro'),
        clauses: t('consent.surgeryClauses'),
      }),
      consentSection({ title: t('consent.postOpTitle'), clauses: [t('consent.postOp')], extra: t('consent.emergency') }),
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
        row(t('intake.s_consent'), data.consents.map((c) => c.type === 'general' ? 'General ✔' : 'Oral Surgery ✔').join(' · ')),
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
    // Ensure the review step's predecessor data is captured.
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
    root.append(el('div', { class: 'kiosk-thanks' }, [
      el('div', { class: 'thanks-check' }, ['✓']),
      el('h1', {}, [t('intake.thanks')]),
      el('p', {}, [t('intake.thanksSub')]),
      el('div', { class: 'thanks-name' }, [`${patient.first_name} ${patient.last_name}`]),
      el('button', { class: 'btn btn--primary btn--lg', onClick: () => { setLang('en'); ctx.navigate('login'); } }, [t('intake.done')]),
    ]));
  }

  steps = computeSteps();
  paint();
  return root;
}
