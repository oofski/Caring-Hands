'use strict';

/**
 * Minimal, dependency-free ZIP writer (DEFLATE, no encryption) used for the
 * admin "Export clinic ZIP" offload. Pure Node (zlib + Buffers) so it needs no
 * npm packages and is unit-testable without Electron.
 *
 * zip(files) -> Buffer, where files = [{ name: string, data: Buffer }].
 */

const zlib = require('zlib');

// Standard CRC-32 (IEEE 802.3), table built once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zip(files) {
  const list = (files || []).filter((f) => f && typeof f.name === 'string' && f.data);
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const f of list) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : data;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header signature
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0x0800, 6);       // flags: bit 11 = UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);           // mod time
    lh.writeUInt16LE(0x21, 12);        // mod date (1980-01-01)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // extra len
    localChunks.push(lh, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);   // central dir header signature
    cd.writeUInt16LE(20, 4);           // version made by
    cd.writeUInt16LE(20, 6);           // version needed
    cd.writeUInt16LE(0x0800, 8);       // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);           // mod time
    cd.writeUInt16LE(0x21, 14);        // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);           // extra len
    cd.writeUInt16LE(0, 32);           // comment len
    cd.writeUInt16LE(0, 34);           // disk number
    cd.writeUInt16LE(0, 36);           // internal attrs
    cd.writeUInt32LE(0, 38);           // external attrs
    cd.writeUInt32LE(offset, 42);      // local header offset
    centralChunks.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const central = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);   // end of central dir signature
  eocd.writeUInt16LE(0, 4);            // disk number
  eocd.writeUInt16LE(0, 6);            // central dir start disk
  eocd.writeUInt16LE(list.length, 8);  // entries on this disk
  eocd.writeUInt16LE(list.length, 10); // total entries
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);      // central dir offset
  eocd.writeUInt16LE(0, 20);           // comment len

  return Buffer.concat([...localChunks, central, eocd]);
}

module.exports = { zip, crc32 };
