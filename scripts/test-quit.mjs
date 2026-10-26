// Quitting the app (src/main/main.js), with Electron and the sync engine stood in for.
//
//   node scripts/test-quit.mjs
//   MAIN_JS=path/to/main.js node scripts/test-quit.mjs   (an older copy, which must fail)
//
// v1.14.0 holds the quit for a few seconds while the laptop signs off with the
// clinic cloud. The window must leave the screen at once, and the app opened
// again during those seconds must open, not be swallowed by the copy closing.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Module = require('module');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = process.env.MAIN_JS ? path.resolve(process.env.MAIN_JS) : path.join(REPO, 'src/main/main.js');

let passed = 0, failed = 0;
function check(ok, name, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// One fresh load of main.js. Returns the stand-ins, to drive and to inspect.
function load() {
  const handlers = {};
  const win = { hidden: 0, focused: 0, hide() { this.hidden++; }, focus() { this.focused++; }, isMinimized: () => false, isDestroyed: () => false, restore() {} };
  const s = { handlers, win, quits: 0, exited: false, relaunches: 0, signOffs: [], release: null };
  const app = {
    on: (name, fn) => { handlers[name] = fn; },
    whenReady: () => new Promise(() => {}), // no window is created; the quit path is what is tested
    requestSingleInstanceLock: () => true,
    getPath: () => '/tmp', getVersion: () => '1.14.0', isPackaged: false,
    relaunch: () => { s.relaunches++; },
    // As Electron does: before-quit first, and the quit goes ahead unless it was held.
    quit: () => {
      s.quits++;
      const e = { prevented: false, preventDefault() { this.prevented = true; } };
      if (handlers['before-quit']) handlers['before-quit'](e);
      if (!e.prevented) s.exited = true;
    },
  };
  const electron = { app, BrowserWindow: { getAllWindows: () => [win] }, Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) }, shell: {} };
  const cloud = {
    signOff: (o) => { s.signOffs.push(o); return new Promise((r) => { s.release = () => r({ ok: true }); }); },
    start() {},
  };
  // (Left in place: main.js loads the sync engine only when it quits.)
  stubs = { electron, './db': { init() {}, close() {} }, './ipc': { register() {} }, './autoupdate': { init() {}, checkSilently() {} }, './cloud': cloud };
  delete require.cache[require.resolve(MAIN)];
  require(MAIN);
  return s;
}
let stubs = {};
const origLoad = Module._load;
Module._load = function (req) { return Object.prototype.hasOwnProperty.call(stubs, req) ? stubs[req] : origLoad.apply(this, arguments); };

console.log(`main.js under test: ${path.relative(REPO, MAIN) || MAIN}`);

// 1. An ordinary quit: off the screen at once, closed once the sign-off is done.
{
  global.__chQuittingForUpdate = false;
  const s = load();
  s.handlers['window-all-closed'](); // the last window closed (on Windows, that quits)
  await tick();
  check(s.signOffs.length === 1 && s.signOffs[0].reason === 'closed' && !s.exited, 'quit: the laptop signs off with the clinic cloud before it closes', JSON.stringify({ signOffs: s.signOffs, exited: s.exited }));
  check(s.win.hidden > 0, 'quit: the window leaves the screen at once, not after the sign-off');
  s.release(); await tick(); await tick();
  check(s.exited && s.relaunches === 0, 'quit: ...and the app closes once it is done, and does not open again by itself', JSON.stringify({ exited: s.exited, relaunches: s.relaunches }));
}

// 2. Opened again while it signs off: the new copy finds this one still
//    holding the single-instance lock and gives up, so this one must start
//    the app again once it has closed.
{
  const s = load();
  s.handlers['window-all-closed']();
  await tick();
  s.handlers['second-instance']();
  check(s.win.focused === 0, 'reopen while closing: the closing window is not brought back');
  s.release(); await tick(); await tick();
  check(s.exited && s.relaunches === 1, 'reopen while closing: ...the app starts again once this copy has closed (it used to do nothing)', JSON.stringify({ exited: s.exited, relaunches: s.relaunches }));
}

// 3. A quit to install an update is not held up.
{
  const s = load();
  global.__chQuittingForUpdate = true;
  s.handlers['window-all-closed']();
  await tick();
  check(s.exited && s.signOffs.length === 0, 'update: a quit to install an update closes at once, without signing off', JSON.stringify({ exited: s.exited, signOffs: s.signOffs.length }));
  global.__chQuittingForUpdate = false;
}

console.log(`\n=== ${passed + failed} checks: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
