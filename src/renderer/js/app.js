import { el, clear, toast, modal } from './dom.js';
import { t, setLang } from './i18n.js';
import { store } from './store.js';
import { api } from './api.js';
import { icon } from './icons.js';
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
  dashboard: { render: renderDashboard, roles: ['admin', 'doctor', 'triage'], icon: 'dashboard', label: () => t('nav.dashboard') },
  triage: { render: renderTriage, roles: ['admin', 'doctor', 'triage'], icon: 'triage', label: () => t('nav.triage') },
  provider: { render: renderProvider, roles: ['admin', 'doctor'], icon: 'tooth', label: () => t('nav.provider') },
  records: { render: renderRecords, roles: ['admin', 'doctor'], icon: 'records', label: () => t('nav.records') },
  reports: { render: renderReports, roles: ['admin', 'doctor'], icon: 'reports', label: () => t('nav.reports') },
  admin: { render: renderAdmin, roles: ['admin'], icon: 'admin', label: () => t('nav.admin') },
};

const ctx = { navigate, toast: (m, k) => toast(m, k), store };

// App version + offline-update state, shown in any view.
const appInfo = { version: '', hasUpdate: false, latest: null, checked: false };

function navigate(name, params = {}) {
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

function initials(name) {
  return (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}

function renderShell(active, contentNode) {
  clear(appRoot);
  appRoot.className = 'app-shell';

  const navItems = Object.entries(VIEWS)
    .filter(([, v]) => v.roles.includes(store.user.role))
    .map(([name, v]) => el('button', {
      class: 'nav-item' + (name === active ? ' nav-item--on' : ''),
      onClick: () => navigate(name),
    }, [el('span', { class: 'nav-icon' }, [icon(v.icon, { size: 18 })]), el('span', {}, [v.label()])]));

  const verChip = el('button', {
    class: 'ver-chip' + (appInfo.hasUpdate ? ' ver-chip--update' : ''),
    onClick: openUpdateModal,
    title: 'Version & updates',
  }, [
    el('span', {}, [appInfo.hasUpdate ? 'Update available' : `Version ${appInfo.version || '…'}`]),
    icon('update', { size: 14 }),
  ]);

  const sidebar = el('aside', { class: 'sidebar' }, [
    el('div', { class: 'sidebar-brand' }, [
      el('img', { src: '../../assets/icon.png', class: 'brand-mark', alt: '' }),
      el('div', {}, [el('div', { class: 'brand-name' }, ['Caring Hands']), el('div', { class: 'brand-sub' }, ['WORLDWIDE'])]),
    ]),
    el('nav', { class: 'nav' }, navItems),
    el('div', { class: 'sidebar-foot' }, [
      el('div', { class: 'offline-badge' }, [el('span', { class: 'offline-dot' }), 'Offline · No cloud']),
      verChip,
    ]),
  ]);

  const topbar = el('header', { class: 'topbar' }, [
    el('div', { class: 'topbar-event' }, [
      el('span', { class: 'te-label' }, ['Active event']),
      el('strong', {}, [store.event ? store.event.name : 'No event']),
    ]),
    el('div', { class: 'topbar-right' }, [
      // Always-available update control
      el('button', {
        class: 'btn btn--ghost btn--sm' + (appInfo.hasUpdate ? ' btn--soft' : ''),
        onClick: openUpdateModal,
        title: 'Check for updates',
      }, [icon('update', { size: 15 }), appInfo.hasUpdate ? 'Update' : `v${appInfo.version || '1.0.1'}`]),
      el('div', { class: 'topbar-divider' }),
      el('div', { class: 'topbar-user' }, [
        el('div', { class: 'user-meta' }, [
          el('strong', {}, [store.user.full_name]),
          el('span', { class: 'pill pill--info' }, [t(`roles.${store.user.role}`)]),
        ]),
        el('div', { class: 'avatar' }, [initials(store.user.full_name)]),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: logout, title: t('nav.logout') }, [icon('logout', { size: 15 })]),
      ]),
    ]),
  ]);

  const main = el('main', { class: 'main' }, [topbar, el('div', { class: 'main-scroll' }, [contentNode])]);
  appRoot.append(sidebar, main);
}

/* ---------------- Offline updates (reachable from any view) ---------------- */

async function refreshAppInfo(silent = true) {
  try {
    const info = await api.appVersion();
    appInfo.version = info.version;
    if (silent) {
      const res = await api.checkUpdate({}); // scan default locations + USB drives, no dialog
      appInfo.hasUpdate = res.hasUpdate;
      appInfo.latest = res.latest;
      appInfo.checked = true;
    }
  } catch (e) { /* offline / not signed in — ignore */ }
}

async function openUpdateModal() {
  const body = el('div', { class: 'update-card' });
  const status = el('div', { class: 'update-status' }, [icon('info', { size: 16 }), el('span', {}, ['Checking…'])]);
  const actions = el('div', { class: 'action-row' });
  body.append(
    el('p', {}, [el('strong', {}, [`Caring Hands v${appInfo.version || ''}`]), el('br'), el('span', { class: 'subtle small' }, ['Fully offline. Updates are read from a USB drive or folder the team provides — no internet required.'])]),
    status, actions,
  );

  function paint(res) {
    clear(status); clear(actions);
    if (res && res.hasUpdate && res.latest) {
      status.className = 'update-status update-found';
      status.append(icon('checkCircle', { size: 16 }), el('span', {}, [`Update found: v${res.latest.version}`]));
      if (store.user.role === 'admin') {
        actions.append(el('button', { class: 'btn btn--primary', onClick: async () => {
          try { await api.installUpdate(res.latest.path); toast('Launching installer — the app will close.', 'success'); }
          catch (e) { toast(e.message, 'error'); }
        } }, [icon('download', { size: 16 }), `Install v${res.latest.version}`]));
      } else {
        status.append(el('span', { class: 'subtle small' }, [' · ask an administrator to install']));
      }
    } else {
      status.className = 'update-status';
      status.append(icon('checkCircle', { size: 16 }), el('span', {}, [res ? "You're up to date." : 'No update found in the scanned locations.']));
    }
    actions.append(
      el('button', { class: 'btn btn--ghost', onClick: () => doCheck({}) }, [icon('refresh', { size: 16 }), 'Re-scan drives']),
      el('button', { class: 'btn btn--ghost', onClick: () => doCheck({ choose: true }) }, [icon('upload', { size: 16 }), 'Choose folder…']),
    );
  }
  async function doCheck(opts) {
    clear(status); status.className = 'update-status'; status.append(icon('info', { size: 16 }), el('span', {}, ['Scanning…']));
    try {
      const res = await api.checkUpdate(opts);
      appInfo.hasUpdate = res.hasUpdate; appInfo.latest = res.latest; appInfo.version = res.current;
      paint(res);
    } catch (e) { clear(status); status.append(icon('alert', { size: 16 }), el('span', {}, [e.message])); }
  }

  doCheck({});
  await modal({ title: 'Software updates', body, confirmText: t('common.close') });
}

async function logout() {
  await api.logout();
  store.setUser(null);
  setLang('en');
  navigate('login');
}

// Expose for the login view to trigger an update-info refresh after sign-in.
ctx.afterLogin = async () => { await refreshAppInfo(true); };

// Boot.
setLang('en');
navigate('login');
api.appVersion().then((i) => { appInfo.version = i.version; }).catch(() => {});
