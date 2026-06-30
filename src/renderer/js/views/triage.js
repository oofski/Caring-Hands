import { el, clear, toast, modal } from '../dom.js';
import { t, conditions, allergies } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { Odontogram } from '../components/odontogram.js';
import { bloodThinnerFlags } from '../medFlags.js';
import { patientHistoryCards, incompleteBanner } from '../components/patientHistory.js';
import { store } from '../store.js';
import { statusPill } from './dashboard.js';

const CHECKLIST = [
  ['cleaning', 'Cleaning'], ['extraction', 'Extraction'], ['filling', 'Filling'],
  ['none', 'No treatment'], ['referral', 'Referral'],
];

export function renderTriage(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function queue() {
    const patients = await api.listPatients({});
    const waiting = patients.filter((p) => p.triage_status === 'waiting' || p.status === 'checked_in');
    const rows = patients.map((p) => el('tr', { class: p.status === 'checked_in' ? 'row--active' : '' }, [
      el('td', {}, [
        el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        (p.flags && p.flags.length) ? el('span', { class: 'flag-dot' }, [icon('flag', { size: 13 }), String(p.flags.length)]) : null,
      ]),
      el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
      el('td', {}, [p.complaint || '—']),
      el('td', {}, [statusPill(p.status)]),
      el('td', {}, [el('button', { class: 'btn btn--primary btn--sm', onClick: () => detail(p.id) }, ['Triage', icon('chevron', { size: 15 })])]),
    ]));

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, [t('nav.triage')]), el('p', { class: 'view-sub' }, [`${waiting.length} patient(s) awaiting triage`])]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: queue }, [icon('refresh', { size: 15 }), 'Refresh']),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Status', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 5, class: 'empty' }, ['Queue is empty.'])])]),
          ]),
        ]),
      ]),
    );
  }

  async function detail(id) {
    const p = await api.getPatient(id);
    const tr = p.triage || {};
    let xrays = await api.listXrays(id);
    const priorVisits = await api.patientHistory(id).catch(() => []);

    const mh = p.medical_history || {};
    const flagConds = conditions().filter((c) => c.flag && (mh.conditions || []).includes(c.key)).map((c) => c.label);
    const flagAllergies = allergies().filter((a) => (mh.allergies || []).includes(a.key)).map((a) => `Allergy: ${a.label}`);
    if (mh.pregnancy === 'yes') flagConds.push('Pregnant');
    const flags = [...flagConds, ...flagAllergies];
    const consentOk = (p.consents || []).some((c) => c.type === 'general');

    // F12 — blood-thinner / anticoagulant flags (prominent, critical before extraction).
    const thinners = bloodThinnerFlags(mh);

    // F20 — vitals reader: prefer authoritative staff (triage) vitals, else intake self-report.
    const vSys = tr.bp_systolic != null ? tr.bp_systolic : mh.bp_systolic;
    const vDia = tr.bp_diastolic != null ? tr.bp_diastolic : mh.bp_diastolic;
    const vHr = tr.heart_rate != null ? tr.heart_rate : mh.heart_rate;
    const vFromTriage = tr.bp_systolic != null || tr.bp_diastolic != null || tr.heart_rate != null;
    const vitalsStr = [];
    if (vSys != null || vDia != null) vitalsStr.push(`BP ${vSys != null ? vSys : '—'}/${vDia != null ? vDia : '—'}`);
    if (vHr != null) vitalsStr.push(`HR ${vHr}`);
    const fmtWhen = (w) => { try { return new Date(w).toLocaleString(); } catch (_) { return w; } };

    const checkState = { ...(tr.checklist || {}) };
    const checklist = el('div', { class: 'chip-row' }, CHECKLIST.map(([k, label]) =>
      el('button', { type: 'button', class: 'chip-btn' + (checkState[k] ? ' chip-btn--on' : ''),
        onClick: (e) => { checkState[k] = !checkState[k]; e.currentTarget.classList.toggle('chip-btn--on'); } }, [label])));

    const complaint = el('input', { class: 'input', value: tr.complaint || p.dental_history.reason || '', placeholder: 'Primary complaint' });
    const notes = el('textarea', { class: 'input textarea', rows: 3, placeholder: 'Triage notes' }, [tr.notes || '']);
    const station = el('input', { class: 'input', value: tr.xray_station || '', placeholder: 'X-ray station #' });
    const assigned = el('input', { class: 'input', value: tr.assigned_to || '', placeholder: 'Assign to provider / chair' });
    const odoTeeth = {};
    (tr.teeth || []).forEach((id) => { odoTeeth[id] = { tx: null, note: (tr.teeth_notes && tr.teeth_notes[id]) || '' }; });
    const odo = Odontogram({ teeth: odoTeeth });

    // X-ray gallery
    const gallery = el('div', { class: 'xray-gallery' });
    const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
    function renderGallery() {
      clear(gallery);
      xrays.forEach((x) => gallery.append(el('div', { class: 'xray-card', onClick: () => viewXray(x) }, [
        el('img', { src: x.image_png, alt: 'x-ray' }),
        el('div', { class: 'xray-card-meta' }, [el('span', {}, [x.station ? `St ${x.station}` : '—']), el('span', {}, [`#${x.id}`])]),
        el('button', { class: 'xray-del', onClick: async (e) => { e.stopPropagation(); await delXray(x.id); } }, [icon('trash', { size: 14 })]),
      ])));
      gallery.append(el('div', { class: 'xray-add', onClick: () => fileInput.click() }, [icon('upload', { size: 20 }), el('span', {}, ['Add x-ray (Nomad)'])]));
    }
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      for (const file of files) {
        await new Promise((res) => {
          const reader = new FileReader();
          reader.onload = async () => { try { await api.addXray({ patientId: id, station: station.value.trim(), image_png: reader.result, note: '' }); } catch (e) { toast(e.message, 'error'); } res(); };
          reader.readAsDataURL(file);
        });
      }
      xrays = await api.listXrays(id); renderGallery(); fileInput.value = '';
      toast(`${files.length} x-ray(s) uploaded`, 'success');
    });
    async function delXray(xid) {
      const ok = await modal({ title: 'Delete x-ray?', body: 'This permanently removes the image.', confirmText: 'Delete', cancelText: 'Cancel', danger: true });
      if (!ok) return;
      try { await api.deleteXray(xid); xrays = await api.listXrays(id); renderGallery(); } catch (e) { toast(e.message, 'error'); }
    }
    function viewXray(x) { modal({ title: `X-ray #${x.id}`, body: el('img', { class: 'xray-viewer-img', src: x.image_png }), confirmText: t('common.close') }); }
    renderGallery();

    async function save(markReady) {
      try {
        await api.saveTriage(id, {
          complaint: complaint.value.trim(), flags, checklist: checkState,
          teeth: odo.getSelected(), teeth_notes: odo.getNotes(),
          notes: notes.value.trim(), xray_count: xrays.length, xray_station: station.value.trim(),
          assigned_to: assigned.value.trim(), status: markReady ? 'ready' : 'in_progress',
          triage_signature: tr.triage_signature || null, triage_signer_name: tr.triage_signer_name || null,
        });
        toast(markReady ? 'Triage complete — routed to provider' : 'Triage saved', 'success');
        if (markReady) ctx.navigate('triage');
      } catch (e) { toast(e.message, 'error'); }
    }

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => ctx.navigate('triage') }, [icon('back', { size: 15 }), t('common.back')]),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [`${p.age != null ? p.age + ' yrs · ' : ''}${p.gender || ''} · ${p.language === 'es' ? 'Español' : 'English'}`]),
        ]),
        statusPill(p.status),
      ]),

      incompleteBanner(p, {
        isAdmin: store.is('admin'),
        onDelete: async () => { try { await api.deletePatient(id); toast('Empty record deleted', 'success'); ctx.navigate('triage'); } catch (e) { toast(e.message, 'error'); } },
        onNewCheckin: () => ctx.navigate('kiosk'),
      }),

      // F12 — prominent blood-thinner alert; critical to surface before any extraction.
      thinners.length
        ? el('div', { class: 'banner banner--alert' }, [
            icon('alert', { size: 16 }),
            `BLOOD THINNER: ${thinners.map((f) => f.replace('Blood thinner: ', '')).join(', ')} — critical before extraction`,
          ])
        : null,

      el('details', { class: 'history-details', open: 'open' }, [
        el('summary', { class: 'history-summary' }, [icon('clipboard', { size: 16 }), 'Patient history', priorVisits.length ? el('span', { class: 'pill pill--info', style: 'margin-left:8px' }, [`${priorVisits.length} prior visit(s)`]) : null]),
        el('div', { class: 'history-grid' }, patientHistoryCards(p, priorVisits)),
      ]),

      el('div', { class: 'split' }, [
        el('div', { class: 'col' }, [
          el('div', { class: `card ${(flags.length || thinners.length) ? 'card--alert' : ''}` }, [
            el('div', { class: 'card-title' }, [icon('flag', { size: 15 }), 'Medical flags']),
            // F12 — blood thinners get top billing with a louder label.
            thinners.length
              ? el('div', { class: 'chip-row', style: 'margin-bottom:8px' }, thinners.map((f) =>
                  el('span', { class: 'pill pill--danger', title: 'Critical before any extraction' }, [
                    icon('alert', { size: 12 }),
                    `${f.replace('Blood thinner: ', 'BLOOD THINNER: ')} — critical before extraction`,
                  ])))
              : null,
            flags.length
              ? el('div', { class: 'chip-row' }, flags.map((f) => el('span', { class: 'pill pill--danger' }, [el('span', { class: 'pill-dot' }), f])))
              : (thinners.length ? null : el('p', { class: 'muted' }, ['No medical flags reported.'])),
          ]),

          // F20 — vitals + accountability (display only; entry lives in the EMT view).
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('syringe', { size: 15 }), t('intake.vitalsTitle')]),
            vitalsStr.length
              ? el('div', { class: 'chip-row', style: 'margin-bottom:10px' }, [
                  el('span', { class: 'pill pill--info' }, [icon('syringe', { size: 12 }), vitalsStr.join(' · ')]),
                  el('span', { class: 'subtle small' }, [vFromTriage ? '(staff-measured)' : '(patient self-report)']),
                ])
              : el('p', { class: 'muted' }, ['No vitals recorded.']),
            el('div', { class: 'kv-grid' }, [
              (vFromTriage && (p.vitals_by_name || tr.vitals_at))
                ? el('div', { class: 'kv' }, [
                    el('span', { class: 'kv-k' }, [icon('syringe', { size: 13 }), ' ', 'Vitals by']),
                    el('span', { class: 'kv-v' }, [`${p.vitals_by_name || '—'}${tr.vitals_at ? ' · ' + fmtWhen(tr.vitals_at) : ''}`]),
                  ])
                : null,
              (p.triaged_by_name || tr.completed_at || tr.signed_at)
                ? el('div', { class: 'kv' }, [
                    el('span', { class: 'kv-k' }, [icon('user', { size: 13 }), ' ', 'Triaged by']),
                    el('span', { class: 'kv-v' }, [`${p.triaged_by_name || '—'}${(tr.completed_at || tr.signed_at) ? ' · ' + fmtWhen(tr.completed_at || tr.signed_at) : ''}`]),
                  ])
                : null,
            ]),
          ]),
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('checkCircle', { size: 15 }), 'Consent status']),
            consentOk
              ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Consents signed'])
              : el('span', { class: 'pill pill--warning' }, [el('span', { class: 'pill-dot' }), 'Consent missing']),
            el('div', { class: 'mini-hist' }, [
              el('div', {}, [el('b', {}, ['Reason: ']), p.dental_history.reason || '—']),
              el('div', {}, [el('b', {}, ['Tobacco: ']), p.medical_history.tobacco || '—']),
              el('div', {}, [el('b', {}, ['Under care: ']), p.medical_history.under_treatment || '—']),
            ]),
          ]),
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('xray', { size: 15 }), 'X-rays']),
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Station #']), station]),
            gallery, fileInput,
          ]),
        ]),

        el('div', { class: 'col col--wide' }, [
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Triage assessment']),
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Primary complaint']), complaint]),
            el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Treatment indicated (mirrors paper form)']), checklist]),
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Triage notes']), notes]),
            el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Route to provider / chair']), assigned]),
          ]),
        ]),
      ]),

      // Odontogram spans the full width so the teeth render large and legible.
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('tooth', { size: 15 }), 'Teeth of concern — tap a tooth to tag it']),
        odo.node,
      ]),
      el('div', { class: 'action-row', style: 'justify-content:flex-end' }, [
        el('button', { class: 'btn btn--ghost', onClick: () => save(false) }, [icon('save', { size: 16 }), 'Save draft']),
        el('button', { class: 'btn btn--primary', onClick: () => save(true) }, ['Complete triage', icon('chevron', { size: 16 })]),
      ]),
    );
  }
}
