'use strict';

/**
 * Pure helpers for the DEXIS X-ray folder import — kept free of Electron/db so
 * they can be unit-tested directly in Node.
 *
 * DEXIS ".dex" files are a proprietary, vendor-locked format. Third-party code
 * cannot decode the raw sensor payload, BUT many DEXIS files wrap or embed a
 * standard image (JPEG/PNG/BMP). We extract that losslessly when present and
 * NEVER attach an undecodable/garbage image to a chart — when nothing standard
 * is embedded we tell the user to export a JPEG from DEXIS.
 */

const path = require('path');

// Browser-renderable image extensions we can attach directly.
const XRAY_RENDER_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' };
// Proprietary / non-browser formats we TRY to pull a standard image out of.
const XRAY_CONVERT_EXT = { '.dex': 1, '.dexis': 1, '.tif': 1, '.tiff': 1 };

// Scan a buffer for an EMBEDDED standard-image stream. Returns { mime, buf } or
// null. Order: JPEG, PNG, BMP (most→least common inside DEXIS wrappers).
function extractStandardImage(buf) {
  if (!buf || buf.length < 8) return null;
  // JPEG: SOI FF D8 FF ... EOI FF D9
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0xFF && buf[i + 1] === 0xD8 && buf[i + 2] === 0xFF) {
      for (let j = buf.length - 2; j > i + 2; j--) {
        if (buf[j] === 0xFF && buf[j + 1] === 0xD9) return { mime: 'image/jpeg', buf: buf.subarray(i, j + 2) };
      }
      break;
    }
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A ... IEND + CRC(4)
  const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i + 8 < buf.length; i++) {
    let sig = true;
    for (let k = 0; k < 8; k++) if (buf[i + k] !== PNG[k]) { sig = false; break; }
    if (!sig) continue;
    for (let j = i + 8; j + 7 < buf.length; j++) {
      if (buf[j] === 0x49 && buf[j + 1] === 0x45 && buf[j + 2] === 0x4E && buf[j + 3] === 0x44) {
        return { mime: 'image/png', buf: buf.subarray(i, j + 8) };
      }
    }
    break;
  }
  // BMP: 42 4D + little-endian DWORD file size at offset 2
  for (let i = 0; i + 6 < buf.length; i++) {
    if (buf[i] === 0x42 && buf[i + 1] === 0x4D) {
      const size = buf[i + 2] | (buf[i + 3] << 8) | (buf[i + 4] << 16) | (buf[i + 5] << 24);
      if (size > 54 && i + size <= buf.length) return { mime: 'image/bmp', buf: buf.subarray(i, i + size) };
    }
  }
  return null;
}

// Validate a delete target resolves to a regular basename DIRECTLY inside dir.
// Throws on any attempt to escape the folder; returns the absolute path.
function resolveFolderTarget(dir, name) {
  if (!dir || !name) throw new Error('No folder or file specified.');
  if (path.basename(name) !== name) throw new Error('Refusing to delete a nested path.');
  const base = path.resolve(dir);
  const target = path.resolve(base, name);
  if (path.dirname(target) !== base) throw new Error('Refusing to delete a file outside the X-ray folder.');
  const ext = path.extname(target).toLowerCase();
  if (!XRAY_RENDER_EXT[ext] && !XRAY_CONVERT_EXT[ext]) throw new Error('Refusing to delete a non-image file.');
  return target;
}

module.exports = { XRAY_RENDER_EXT, XRAY_CONVERT_EXT, extractStandardImage, resolveFolderTarget };
