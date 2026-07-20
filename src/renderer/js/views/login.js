import { el } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../icons.js';

// Remembers only the last Company ID / username on this device (never the
// password) so a returning staff member doesn't have to retype it. Cleared when
// "Remember me" is unchecked at sign-in.
const REMEMBER_KEY = 'ch.login.remember';

export function renderLogin(ctx) {
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(REMEMBER_KEY) || '{}'); } catch (_) { saved = {}; }

  const username = el('input', { class: 'input', placeholder: t('login.username'), value: saved.user || '' });
  const password = el('input', { class: 'input', type: 'password', placeholder: t('login.password') });
  const remember = el('input', { type: 'checkbox', class: 'auth-check', id: 'auth-remember' });
  remember.checked = !!saved.user;
  const error = el('div', { class: 'login-error', style: 'display:none' });

  async function submit() {
    error.style.display = 'none';
    try {
      const user = await api.login(username.value, password.value);
      try {
        if (remember.checked && username.value.trim()) {
          window.localStorage.setItem(REMEMBER_KEY, JSON.stringify({ user: username.value.trim() }));
        } else {
          window.localStorage.removeItem(REMEMBER_KEY);
        }
      } catch (_) { /* storage unavailable — sign-in still succeeds */ }
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

  // Place the cursor for a returning user: password when the username is
  // remembered, otherwise the username field.
  setTimeout(() => { (saved.user ? password : username).focus(); }, 0);

  const feature = (ic, title) => el('div', { class: 'auth-feature' }, [
    el('div', { class: 'auth-feature-ic' }, [icon(ic, { size: 18 })]),
    el('strong', {}, [title]),
  ]);

  // Left: branded hero panel (Caring Hands teal — not the reference blue).
  const hero = el('div', { class: 'auth-hero' }, [
    el('div', { class: 'auth-brand' }, [
      el('div', { class: 'auth-brand-badge' }, ['CH']),
      el('div', { class: 'auth-brand-name' }, [
        el('strong', {}, ['Caring Hands']),
        el('span', {}, ['Worldwide']),
      ]),
    ]),
    el('div', { class: 'auth-hero-body' }, [
      el('div', { class: 'auth-eyebrow' }, ['Helping hands for healthy living']),
      el('h1', { class: 'auth-headline' }, ['The operations backbone for your dental clinic.']),
    ]),
    el('div', { class: 'auth-features' }, [
      feature('lock', 'Roles & permissions'),
      feature('users', 'Your whole clinic team'),
      feature('database', 'Offline-first — data stays on the device'),
    ]),
  ]);

  // Right: the sign-in form.
  const panel = el('div', { class: 'auth-panel' }, [
    el('div', { class: 'auth-form' }, [
      el('h2', { class: 'auth-title' }, ['Sign in']),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('login.username')]), username]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [t('login.password')]), password]),
      el('label', { class: 'auth-remember', for: 'auth-remember' }, [remember, el('span', {}, ['Remember me on this device'])]),
      error,
      el('button', { class: 'btn btn--primary btn--block', onClick: submit }, [icon('chevron', { size: 16 }), t('login.button')]),
      el('div', { class: 'login-divider' }, [el('span', {}, ['or'])]),
      el('button', { class: 'btn btn--kiosk btn--block', onClick: () => ctx.navigate('kiosk') }, [
        el('span', { class: 'kiosk-icon' }, [icon('clipboard', { size: 22 })]),
        el('span', {}, [
          el('strong', {}, [t('login.kiosk')]),
          el('small', {}, [t('login.kioskHint')]),
        ]),
      ]),
      el('p', { class: 'auth-foot' }, ['New here? Your administrator sets up your account.']),
    ]),
  ]);

  return el('div', { class: 'auth-split' }, [hero, panel]);
}
