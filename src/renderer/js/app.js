import { el, clear, toast, modal } from './dom.js';
import { t, setLang } from './i18n.js';
import { store } from './store.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { renderLogin } from './views/login.js';
import { renderKiosk } from './views/kiosk.js';
import { renderArrivals } from './views/arrivals.js';
import { renderDashboard } from './views/dashboard.js';
import { renderProvider } from './views/provider.js';
import { renderRecords } from './views/records.js';
import { renderReports } from './views/reports.js';
import { renderAdmin } from './views/admin.js';
import { renderEmt } from './views/emt.js';
import { renderCheckout } from './views/checkout.js';
import { renderHygienist } from './views/hygienist.js';
import { renderManagement } from './views/management.js';

const appRoot = document.getElementById('app');

// v1.0.9 flow: check-in -> queue -> EMT station (vitals + routing) -> Dentist
// (planning + fillings/extractions) or Hygienist (cleaning) -> Check-Out.
// The separate Triage station is gone; legacy 'triage' accounts work the EMT
// station so no existing login loses access on update.
// The sidebar is organised into two modules: CLINIC (running the clinic day to
// day) and ADMIN (accounts, data, system). Each former Admin tab is now its own
// accessible sidebar item under the right module. `module` drives the grouping;
// order within a module follows insertion order below.
const VIEWS = {
  // ---- Top-level (always visible) ----
  dashboard: { render: renderDashboard, roles: ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'], icon: 'dashboard', label: () => t('nav.dashboard'), module: 'top' },
  // ---- Clinic (collapsible) — the day-to-day stations ----
  arrivals: { render: renderArrivals, roles: ['admin', 'registration', 'emt', 'triage'], icon: 'checkCircle', label: () => 'Arrivals', module: 'clinic' },
  emt: { render: renderEmt, roles: ['admin', 'emt', 'triage'], icon: 'syringe', label: () => t('nav.emt'), module: 'clinic' },
  hygienist: { render: renderHygienist, roles: ['admin', 'hygienist'], icon: 'sparkle', label: () => t('nav.hygienist'), module: 'clinic' },
  provider: { render: renderProvider, roles: ['admin', 'doctor'], icon: 'tooth', label: () => t('nav.provider'), module: 'clinic' },
  checkout: { render: renderCheckout, roles: ['admin', 'checkout'], icon: 'checkCircle', label: () => t('nav.checkout'), module: 'clinic' },
  records: { render: renderRecords, roles: ['admin', 'doctor', 'checkout'], icon: 'records', label: () => t('nav.records'), module: 'clinic' },
  reports: { render: renderReports, roles: ['admin', 'doctor'], icon: 'reports', label: () => t('nav.reports'), module: 'clinic' },
  // ---- Admin (collapsible) — management & system ----
  management: { render: renderManagement, roles: ['admin'], icon: 'admin', label: () => 'Management', module: 'admin' },
  staff: { render: (c, p) => renderAdmin(c, { ...p, section: 'staff' }), roles: ['admin'], icon: 'users', label: () => 'Staff & roles', module: 'admin' },
  events: { render: (c, p) => renderAdmin(c, { ...p, section: 'events' }), roles: ['admin'], icon: 'calendar', label: () => 'Events', module: 'admin' },
  cloud: { render: (c, p) => renderAdmin(c, { ...p, section: 'cloud' }), roles: ['admin'], icon: 'globe', label: () => 'Cloud', module: 'admin' },
  data: { render: (c, p) => renderAdmin(c, { ...p, section: 'data' }), roles: ['admin'], icon: 'database', label: () => 'Backup & Export', module: 'admin' },
  audit: { render: (c, p) => renderAdmin(c, { ...p, section: 'audit' }), roles: ['admin'], icon: 'clipboard', label: () => 'Audit log', module: 'admin' },
};

// Collapsible sidebar groups. A group auto-expands when it holds the active view;
// otherwise its open/closed state is remembered per device.
const NAV_MODULES = [['clinic', 'Clinic'], ['admin', 'Admin']];
const NAV_STATE_KEY = 'ch.nav.groups';
function navGroupsState() { try { return JSON.parse(window.localStorage.getItem(NAV_STATE_KEY) || '{}'); } catch (_) { return {}; } }
function saveNavGroupsState(s) { try { window.localStorage.setItem(NAV_STATE_KEY, JSON.stringify(s)); } catch (_) { /* ignore */ } }

// Views call ctx.setDetail(true) when they open a patient detail and
// ctx.setDetail(false) when they return to their list, so cloud-sync
// auto-refresh never repaints over an open chart. (Internal detail() calls
// don't go through navigate(), so params.id alone can't tell us.)
let detailOpen = false;
const ctx = { navigate, toast: (m, k) => toast(m, k), store, setDetail: (v) => { detailOpen = !!v; } };

// App version + offline-update state, shown in any view.
const appInfo = { version: '', hasUpdate: false, latest: null, checked: false };

let lastNav = { name: 'dashboard', params: {} };
// Queue/list screens safe to auto-refresh when cloud sync pulls new data. Detail
// screens (params.id set) are never auto-refreshed so a clinician mid-edit is
// never interrupted.
const LIVE_VIEWS = new Set(['dashboard', 'emt', 'provider', 'hygienist', 'checkout', 'records', 'management']);

function navigate(name, params = {}) {
  if (name === 'login') return renderFullscreen(renderLogin(ctx));
  if (name === 'kiosk') return renderFullscreen(renderKiosk(ctx));

  if (!store.user) return navigate('login');
  const view = VIEWS[name];
  if (!view || !view.roles.includes(store.user.role)) {
    toast('You do not have access to that screen.', 'error');
    return navigate('dashboard');
  }
  lastNav = { name, params };
  detailOpen = !!(params && params.id); // a view entered with an id opens a detail
  renderShell(name, view.render(ctx, params));
}

// v1.1.0: when cloud sync pulls new data, refresh the current list view so the
// queue visibly "moves through" across stations without a manual refresh.
if (api.onCloudChanged) {
  api.onCloudChanged(() => {
    if (!store.user || !LIVE_VIEWS.has(lastNav.name)) return;
    // Never repaint over an open patient detail/chart (whether reached by nav or
    // an internal detail() call), or someone typing, or with a dialog open.
    if (detailOpen || (lastNav.params && lastNav.params.id)) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    if (document.querySelector('.modal-overlay, .modal')) return;
    const view = VIEWS[lastNav.name];
    if (view && view.roles.includes(store.user.role)) renderShell(lastNav.name, view.render(ctx, lastNav.params));
  });
}

function renderFullscreen(node) {
  clear(appRoot);
  appRoot.className = 'app-fullscreen';
  appRoot.append(node);
}

function initials(name) {
  return (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}

let shellActive = 'dashboard';
let shellContent = null;
function renderShell(active, contentNode) {
  clear(appRoot);
  appRoot.className = 'app-shell';
  shellActive = active; shellContent = contentNode;

  const navButton = (name, v) => el('button', {
    class: 'nav-item' + (name === active ? ' nav-item--on' : ''),
    onClick: () => navigate(name),
  }, [el('span', { class: 'nav-icon' }, [icon(v.icon, { size: 18 })]), el('span', {}, [v.label()])]);

  const navItems = [];
  // Top-level items (Dashboard) are always visible.
  Object.entries(VIEWS)
    .filter(([, v]) => v.module === 'top' && v.roles.includes(store.user.role))
    .forEach(([name, v]) => navItems.push(navButton(name, v)));

  // Collapsible modules (Clinic / Admin). A group auto-opens when it holds the
  // active view; otherwise its open/closed state is remembered per device.
  const groupState = navGroupsState();
  for (const [mod, label] of NAV_MODULES) {
    const items = Object.entries(VIEWS).filter(([, v]) => v.module === mod && v.roles.includes(store.user.role));
    if (!items.length) continue;
    const hasActive = items.some(([name]) => name === active);
    const open = hasActive || groupState[mod] === true; // default collapsed unless saved-open or holds the active view
    navItems.push(el('button', {
      class: 'nav-group' + (open ? ' nav-group--open' : ''),
      onClick: () => { const s = navGroupsState(); s[mod] = !open; saveNavGroupsState(s); renderShell(shellActive, shellContent); },
    }, [el('span', {}, [label]), icon('chevron', { size: 14 })]));
    if (open) items.forEach(([name, v]) => navItems.push(navButton(name, v)));
  }

  // Live cloud-status badge (replaces the old, now-inaccurate "No cloud" label).
  const cloudBadge = el('div', { class: 'offline-badge' }, [el('span', { class: 'offline-dot' }), 'Cloud sync']);
  if (api.cloudStatus) {
    api.cloudStatus().then((st) => {
      if (!st) return;
      clear(cloudBadge);
      if (st.online) {
        cloudBadge.append(el('span', { class: 'offline-dot', style: 'background:var(--success, #2f8f66)' }), st.lastError ? 'Cloud · reconnecting' : (st.lastOk ? 'Cloud · synced' : 'Cloud · online'));
      } else {
        cloudBadge.append(el('span', { class: 'offline-dot', style: 'background:var(--text-subtle)' }), 'Offline mode');
      }
    }).catch(() => { /* leave the neutral label */ });
  }

  const verChip = el('button', {
    id: 'ver-chip',
    class: 'ver-chip' + (appInfo.hasUpdate ? ' ver-chip--update' : ''),
    onClick: openUpdateModal,
    title: 'Version & updates',
  }, [
    el('span', { class: 'ver-label' }, [appInfo.hasUpdate ? 'Update available' : `Version ${appInfo.version || '…'}`]),
    icon('update', { size: 14 }),
  ]);

  const sidebar = el('aside', { class: 'sidebar' }, [
    el('div', { class: 'sidebar-brand' }, [
      el('img', { src: '../../assets/icon.png', class: 'brand-mark', alt: '' }),
      el('div', {}, [el('div', { class: 'brand-name' }, ['Caring Hands']), el('div', { class: 'brand-sub' }, ['WORLDWIDE'])]),
    ]),
    el('nav', { class: 'nav' }, navItems),
    el('div', { class: 'sidebar-foot' }, [
      cloudBadge,
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
        id: 'update-btn',
        class: 'btn btn--ghost btn--sm' + (appInfo.hasUpdate ? ' btn--soft' : ''),
        onClick: openUpdateModal,
        title: 'Check for updates',
      }, [icon('update', { size: 15 }), el('span', { class: 'upd-label' }, [appInfo.hasUpdate ? 'Update' : `v${appInfo.version || '1.0.1'}`])]),
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

  // Silent offline update check once per session; patches the labels in place.
  if (store.user && !appInfo.checked) refreshAppInfo(true).then(updateVersionUI);
  else updateVersionUI();
}

// Patch the version/update labels in place without re-rendering the view.
function updateVersionUI() {
  const chip = document.getElementById('ver-chip');
  if (chip) {
    chip.classList.toggle('ver-chip--update', appInfo.hasUpdate);
    const lbl = chip.querySelector('.ver-label');
    if (lbl) lbl.textContent = appInfo.hasUpdate ? 'Update available' : `Version ${appInfo.version || '1.0.1'}`;
  }
  const btn = document.getElementById('update-btn');
  if (btn) {
    btn.classList.toggle('btn--soft', appInfo.hasUpdate);
    const lbl = btn.querySelector('.upd-label');
    if (lbl) lbl.textContent = appInfo.hasUpdate ? 'Update' : `v${appInfo.version || '1.0.1'}`;
  }
}

/* ---------------- Offline updates (reachable from any view) ---------------- */

let refreshing = false;
async function refreshAppInfo(silent = true) {
  if (refreshing) return;
  refreshing = true;
  try {
    const info = await api.appVersion();
    appInfo.version = info.version;
    if (silent) {
      const res = await api.checkUpdate({}); // scan default locations + USB drives, no dialog
      appInfo.hasUpdate = res.hasUpdate;
      appInfo.latest = res.latest;
      appInfo.checked = true;
    }
  } catch (e) { /* offline / not signed in — ignore */ } finally { refreshing = false; }
}

async function openUpdateModal() {
  const isAdmin = store.user && store.user.role === 'admin';
  const body = el('div', { class: 'update-card' });

  /* ---- Online auto-update section ---- */
  const onlineStatus = el('div', { class: 'update-status' }, [icon('info', { size: 16 }), el('span', {}, ['Checking online…'])]);
  const onlineActions = el('div', { class: 'action-row' });
  const onlineSection = el('div', {}, [
    el('div', { class: 'field-label' }, ['Online (recommended)']),
    onlineStatus, onlineActions,
  ]);

  function setOnline(node, cls) { clear(onlineStatus); onlineStatus.className = 'update-status' + (cls ? ' ' + cls : ''); onlineStatus.append(node); }

  async function checkOnline() {
    setOnline(el('span', {}, [icon('info', { size: 16 }), ' Checking GitHub for updates…']));
    clear(onlineActions);
    try {
      const res = await api.checkOnline();
      if (res.supported === false) {
        setOnline(el('span', {}, [icon('info', { size: 16 }), ' ' + (res.reason || 'Online updates unavailable here.')]));
        onlineActions.append(el('span', { class: 'subtle small' }, ['Use the installed app (not portable) for auto-updates.']));
        return;
      }
      if (res.error) { setOnline(el('span', {}, [icon('alert', { size: 16 }), ' ' + res.error])); return; }
      if (res.hasUpdate) {
        appInfo.hasUpdate = true; appInfo.version = res.currentVersion; updateVersionUI();
        setOnline(el('span', {}, [icon('checkCircle', { size: 16 }), ` Update available: v${res.latestVersion}`]), 'update-found');
        onlineActions.append(el('button', { class: 'btn btn--primary', onClick: startDownload }, [icon('download', { size: 16 }), `Download v${res.latestVersion}`]));
      } else {
        setOnline(el('span', {}, [icon('checkCircle', { size: 16 }), " You're on the latest version."]));
        onlineActions.append(el('button', { class: 'btn btn--ghost', onClick: checkOnline }, [icon('refresh', { size: 16 }), 'Check again']));
      }
    } catch (e) { setOnline(el('span', {}, [icon('alert', { size: 16 }), ' ' + e.message])); }
  }

  async function startDownload() {
    clear(onlineActions);
    setOnline(el('span', {}, [icon('download', { size: 16 }), ' Downloading update… 0%']));
    try { await api.downloadOnline(); } catch (e) { setOnline(el('span', {}, [icon('alert', { size: 16 }), ' ' + e.message])); }
  }

  // Live progress / state from the main process.
  const unsub = api.onUpdateEvent((s) => {
    if (s.status === 'downloading') setOnline(el('span', {}, [icon('download', { size: 16 }), ` Downloading update… ${s.percent || 0}%`]));
    else if (s.status === 'downloaded') {
      setOnline(el('span', {}, [icon('checkCircle', { size: 16 }), ` Update v${s.version} ready to install`]), 'update-found');
      clear(onlineActions);
      if (isAdmin) onlineActions.append(el('button', { class: 'btn btn--success', onClick: async () => { try { await api.installOnline(); } catch (e) { toast(e.message, 'error'); } } }, [icon('refresh', { size: 16 }), 'Restart & install']));
      else onlineActions.append(el('span', { class: 'subtle small' }, ['Ask an administrator to install.']));
    } else if (s.status === 'available') {
      appInfo.hasUpdate = true; updateVersionUI();
    } else if (s.status === 'error' && s.error) setOnline(el('span', {}, [icon('alert', { size: 16 }), ' ' + s.error]));
  });

  /* ---- Offline USB fallback ---- */
  const usbStatus = el('div', { class: 'update-status' });
  const usbActions = el('div', { class: 'action-row' });
  function paintUsb(res) {
    clear(usbStatus); clear(usbActions);
    if (res && res.hasUpdate && res.latest) {
      usbStatus.className = 'update-status update-found';
      usbStatus.append(icon('checkCircle', { size: 16 }), el('span', {}, [`Found v${res.latest.version} on drive`]));
      if (isAdmin) usbActions.append(el('button', { class: 'btn btn--primary', onClick: async () => { try { await api.installUpdate(res.latest.path); toast('Launching installer…', 'success'); } catch (e) { toast(e.message, 'error'); } } }, [icon('download', { size: 16 }), `Install v${res.latest.version}`]));
    } else {
      usbStatus.className = 'update-status';
      usbStatus.append(icon('info', { size: 16 }), el('span', {}, ['No installer found on USB / chosen folder.']));
    }
    usbActions.append(
      el('button', { class: 'btn btn--ghost', onClick: () => checkUsb({}) }, [icon('refresh', { size: 16 }), 'Re-scan drives']),
      el('button', { class: 'btn btn--ghost', onClick: () => checkUsb({ choose: true }) }, [icon('upload', { size: 16 }), 'Choose folder…']),
    );
  }
  async function checkUsb(opts) {
    clear(usbStatus); usbStatus.className = 'update-status'; usbStatus.append(icon('info', { size: 16 }), el('span', {}, ['Scanning…']));
    try { const res = await api.checkUpdate(opts); paintUsb(res); } catch (e) { clear(usbStatus); usbStatus.append(icon('alert', { size: 16 }), el('span', {}, [e.message])); }
  }

  body.append(
    el('p', {}, [el('strong', {}, [`Caring Hands v${appInfo.version || ''}`]), el('br'), el('span', { class: 'subtle small' }, ['The app checks GitHub for new versions and installs them for you — no manual download. A USB/folder option is available when offline.'])]),
    onlineSection,
    el('div', { class: 'login-divider', style: 'margin:16px 0' }, [el('span', {}, ['offline option'])]),
    el('div', {}, [el('div', { class: 'field-label' }, ['From USB / folder']), usbStatus, usbActions]),
  );

  checkOnline();
  paintUsb(null);
  await modal({ title: 'Software updates', body, confirmText: t('common.close') });
  if (unsub) unsub();
}

async function logout() {
  await api.logout();
  store.setUser(null);
  setLang('en');
  navigate('login');
}

// Expose for the login view to trigger an update-info refresh after sign-in.
ctx.afterLogin = async () => { await refreshAppInfo(true); updateVersionUI(); };

// Boot.
setLang('en');
navigate('login');
api.appVersion().then((i) => { appInfo.version = i.version; }).catch(() => {});
