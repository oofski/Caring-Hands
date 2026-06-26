import { el } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../icons.js';

export function renderLogin(ctx) {
  const username = el('input', { class: 'input', placeholder: t('login.username'), autofocus: true });
  const password = el('input', { class: 'input', type: 'password', placeholder: t('login.password') });
  const error = el('div', { class: 'login-error', style: 'display:none' });

  async function submit() {
    error.style.display = 'none';
    try {
      const user = await api.login(username.value, password.value);
      store.setUser(user);
      const ev = await api.activeEvent();
      store.setEvent(ev);
      if (ctx.afterLogin) ctx.afterLogin();
      ctx.navigate('dashboard');
    } catch (e) {
      error.textContent = e.message || t('login.error');
      error.style.display = 'block';
    }
  }

  [username, password].forEach((inp) =>
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); })
  );

  const card = el('div', { class: 'login-card' }, [
    el('img', { class: 'login-logo', src: '../../assets/logo.svg', alt: 'Caring Hands Worldwide' }),
    el('h1', { class: 'login-title' }, [t('login.title')]),
    el('p', { class: 'login-sub' }, [t('login.subtitle')]),
    el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('login.username')]), username]),
    el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('login.password')]), password]),
    error,
    el('button', { class: 'btn btn--primary btn--block', onClick: submit }, [t('login.button')]),
    el('div', { class: 'login-divider' }, [el('span', {}, ['or'])]),
    el('button', {
      class: 'btn btn--kiosk btn--block',
      onClick: () => ctx.navigate('kiosk'),
    }, [
      el('span', { class: 'kiosk-icon' }, [icon('clipboard', { size: 22 })]),
      el('span', {}, [
        el('strong', {}, [t('login.kiosk')]),
        el('small', {}, [t('login.kioskHint')]),
      ]),
    ]),
    el('p', { class: 'login-hint' }, [t('login.hint')]),
  ]);

  return el('div', { class: 'login-screen' }, [
    el('div', { class: 'login-bg' }),
    card,
    el('div', { class: 'login-footer' }, [
      'Caring Hands Worldwide · Offline-first · No cloud · Data stays on this device',
    ]),
  ]);
}
