'use strict';

/**
 * Offline update support.
 *
 * The clinic runs fully offline, so updates arrive on the same USB drives the
 * team already carries. This module scans removable drives (and an optional
 * folder) for a newer Caring Hands installer and can launch it. No network.
 */

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

const INSTALLER_RE = /^Caring-Hands-(?:Setup|Portable)-(\d+\.\d+\.\d+)\.exe$/i;

function currentVersion() {
  return app.getVersion();
}

// "1.2.3" -> [1,2,3]; returns 1/-1/0 comparing a vs b.
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Candidate roots to scan: Windows removable drive letters + common folders.
function candidateRoots(extraDir) {
  const roots = [];
  if (extraDir) roots.push(extraDir);
  if (process.platform === 'win32') {
    for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      roots.push(`${String.fromCharCode(c)}:\\`);
    }
  }
  try { roots.push(app.getPath('downloads')); } catch (e) { /* ignore */ }
  try { roots.push(path.dirname(app.getPath('exe'))); } catch (e) { /* ignore */ }
  return roots;
}

function scanDir(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = INSTALLER_RE.exec(e.name);
    if (m) {
      const full = path.join(dir, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (err) { /* ignore */ }
      out.push({ path: full, version: m[1], file: e.name, mtime });
    }
  }
}

function checkForUpdates(extraDir) {
  const found = [];
  for (const root of candidateRoots(extraDir)) {
    scanDir(root, found);
    // Also look one level down in a CaringHands/ updates folder on the drive.
    scanDir(path.join(root, 'CaringHands'), found);
    scanDir(path.join(root, 'Caring Hands'), found);
  }
  // Dedupe by path
  const seen = new Set();
  const unique = found.filter((f) => (seen.has(f.path) ? false : seen.add(f.path)));
  const current = currentVersion();
  const newer = unique
    .filter((f) => cmpVersion(f.version, current) > 0)
    .sort((a, b) => cmpVersion(b.version, a.version) || b.mtime - a.mtime);
  return {
    current,
    platform: process.platform,
    candidates: unique.sort((a, b) => cmpVersion(b.version, a.version)),
    latest: newer[0] || null,
    hasUpdate: newer.length > 0,
    checkedAt: new Date().toISOString(),
  };
}

async function openInstaller(installerPath) {
  if (!installerPath || !fs.existsSync(installerPath)) throw new Error('Installer not found.');
  const m = INSTALLER_RE.exec(path.basename(installerPath));
  if (!m) throw new Error('Not a recognized Caring Hands installer.');
  const err = await shell.openPath(installerPath);
  if (err) throw new Error(err);
  // Give the installer a moment to spawn, then quit so it can replace files.
  setTimeout(() => app.quit(), 1500);
  return { launched: true };
}

module.exports = { currentVersion, checkForUpdates, openInstaller };
