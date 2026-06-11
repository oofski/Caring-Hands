import { el, clear, toast } from './dom.js';
import { t, setLang } from './i18n.js';
import { store } from './store.js';
import { api } from './api.js';
import { renderLogin } from './views/login.js';
import { renderKiosk } from './views/kiosk.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTriage } from './views/triage.js';
import { renderProvider } from './views/provider.js';
import { renderRecords } from './views/records.js';
import { renderReports } from './views/reports.js';
import { renderAdmin } from './views/admin.js';

const appRoot = document.getElementById('app');

const VIEWS = {
  dashboard: { render: renderDashboard, roles: ['admin', 'doctor', 'triage'], icon: '🏠', label: () => t('nav.dashboard') },
  triage: { render: renderTriage, roles: ['admin', 'doctor', 'triage'], icon: '📋', label: () => t('nav.triage') },
  provider: { render: renderProvider, roles: ['admin', 'doctor'], icon: '🦷', label: () => t('nav.provider') },
  records: { render: renderRecords, roles: ['admin', 'doctor'], icon: '🗂', label: () => t('nav.records') },
  reports: { render: renderReports, roles: ['admin', 'doctor'], icon: '📊', label: () => t('nav.reports') },
  admin: { render: renderAdmin, roles: ['admin'], icon: '⚙', label: () => t('nav.admin') },
};

const ctx = { navigate, toast: (m, k) => toast(m, k), store };

function navigate(name, params = {}) {
  // Full-screen routes (no app chrome).
  if (name === 'login') return renderFullscreen(renderLogin(ctx));
  if (name === 'kiosk') return renderFullscreen(renderKiosk(ctx));

  if (!store.user) return navigate('login');
  const view = VIEWS[name];
  if (!view || !view.roles.includes(store.user.role)) {
    toast('You do not have access to that screen.', 'error');
    return navigate('dashboard');
  }
  renderShell(name, view.render(ctx, params));
}

function renderFullscreen(node) {
  clear(appRoot);
  appRoot.className = 'app-fullscreen';
  appRoot.append(node);
}

function renderShell(active, contentNode) {
  clear(appRoot);
  appRoot.className = 'app-shell';

  const navItems = Object.entries(VIEWS)
    .filter(([, v]) => v.roles.includes(store.user.role))
    .map(([name, v]) => el('button', {
      class: 'nav-item' + (name === active ? ' nav-item--on' : ''),
      onClick: () => navigate(name),
    }, [el('span', { class: 'nav-icon' }, [v.icon]), el('span', {}, [v.label()])]));

  const sidebar = el('aside', { class: 'sidebar' }, [
    el('div', { class: 'sidebar-brand' }, [
      el('img', { src: '../../assets/icon.png', class: 'brand-mark', alt: '' }),
      el('div', {}, [el('div', { class: 'brand-name' }, ['Caring Hands']), el('div', { class: 'brand-sub' }, ['WORLDWIDE'])]),
    ]),
    el('nav', { class: 'nav' }, navItems),
    el('div', { class: 'sidebar-foot' }, [
      el('div', { class: 'offline-badge' }, ['● Offline · No cloud']),
    ]),
  ]);

  const topbar = el('header', { class: 'topbar' }, [
    el('div', { class: 'topbar-event' }, [
      el('span', { class: 'te-label' }, ['Active event']),
      el('strong', {}, [store.event ? store.event.name : 'No event']),
    ]),
    el('div', { class: 'topbar-user' }, [
      el('div', { class: 'user-meta' }, [
        el('strong', {}, [store.user.full_name]),
        el('span', { class: 'pill pill--blue' }, [t(`roles.${store.user.role}`)]),
      ]),
      el('button', { class: 'btn btn--ghost btn--sm', onClick: logout }, [t('nav.logout')]),
    ]),
  ]);

  const main = el('main', { class: 'main' }, [topbar, el('div', { class: 'main-scroll' }, [contentNode])]);
  appRoot.append(sidebar, main);
}

async function logout() {
  await api.logout();
  store.setUser(null);
  setLang('en');
  navigate('login');
}

// Boot.
setLang('en');
navigate('login');
