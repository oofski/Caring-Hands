import { el, clear, toast, modal } from '../dom.js';
import { t, conditions, allergies } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { Odontogram } from '../components/odontogram.js';
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

    const flagConds = conditions().filter((c) => c.flag && (p.medical_history.conditions || []).includes(c.key)).map((c) => c.label);
    const flagAllergies = allergies().filter((a) => (p.medical_history.allergies || []).includes(a.key)).map((a) => `Allergy: ${a.label}`);
    if (p.medical_history.pregnancy === 'yes') flagConds.push('Pregnant');
    const flags = [...flagConds, ...flagAllergies];
    const consentOk = (p.consents || []).some((c) => c.type === 'general');

    const checkState = { ...(tr.checklist || {}) };
    const checklist = el('div', { class: 'chip-row' }, CHECKLIST.map(([k, label]) =>
      el('button', { type: 'button', class: 'chip-btn' + (checkState[k] ? ' chip-btn--on' : ''),
        onClick: (e) => { checkState[k] = !checkState[k]; e.currentTarget.classList.toggle('chip-btn--on'); } }, [label])));

    const complaint = el('input', { class: 'input', value: tr.complaint || p.dental_history.reason || '', placeholder: 'Primary complaint' });
    const notes = el('textarea', { class: 'input textarea', rows: 3, placeholder: 'Triage notes' }, [tr.notes || '']);
    const station = el('input', { class: 'input', value: tr.xray_station || '', placeholder: 'X-ray station #' });
    const assigned = el('input', { class: 'input', value: tr.assigned_to || '', placeholder: 'Assign to provider / chair' });
    const odo = Odontogram({ selected: tr.teeth || [] });

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
          complaint: complaint.value.trim(), flags, checklist: checkState, teeth: odo.getSelected(),
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

      el('div', { class: 'split' }, [
        el('div', { class: 'col' }, [
          el('div', { class: `card ${flags.length ? 'card--alert' : ''}` }, [
            el('div', { class: 'card-title' }, [icon('flag', { size: 15 }), 'Medical flags']),
            flags.length
              ? el('div', { class: 'chip-row' }, flags.map((f) => el('span', { class: 'pill pill--danger' }, [el('span', { class: 'pill-dot' }), f])))
              : el('p', { class: 'muted' }, ['No medical flags reported.']),
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
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('tooth', { size: 15 }), 'Teeth of concern']),
            odo.node,
          ]),
          el('div', { class: 'action-row' }, [
            el('button', { class: 'btn btn--ghost', onClick: () => save(false) }, [icon('save', { size: 16 }), 'Save draft']),
            el('button', { class: 'btn btn--primary', onClick: () => save(true) }, ['Complete triage', icon('chevron', { size: 16 })]),
          ]),
        ]),
      ]),
    );
  }
}
