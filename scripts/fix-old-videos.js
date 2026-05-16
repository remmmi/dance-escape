#!/usr/bin/env node
// One-shot : patche les anciens WebM de uploads/videos/ qui ont ete
// uploades avant l'injection EBML cote kiosk. Ces fichiers n'ont pas
// d'element Duration dans SegmentInfo, donc video.duration = Infinity
// et la seek bar des players HTML5 est cassee. On leur force une
// duree par defaut de 60s (les vidéos font ~40s, 60s est large) ;
// l'objectif est juste que la seek bar soit utilisable.
//
// Usage : node scripts/fix-old-videos.js [durationMs]
//
// Idempotent : un fichier qui a deja Duration est mis a jour en place,
// pas re-rajoute.

const fs = require('fs');
const path = require('path');

const DEFAULT_DURATION_MS = 60000;
const VIDEOS_DIR = path.join(__dirname, '..', 'uploads', 'videos');

function injectEbmlDuration(buf, durationMs) {
  const ID_SEGMENT = 0x18538067;
  const ID_SEGMENTINFO = 0x1549A966;
  const ID_TIMECODESCALE = 0x2AD7B1;
  const ID_DURATION = 0x4489;
  const vintLen = b => {
    if (b >= 0x80) return 1;
    if (b >= 0x40) return 2;
    if (b >= 0x20) return 3;
    if (b >= 0x10) return 4;
    if (b >= 0x08) return 5;
    if (b >= 0x04) return 6;
    if (b >= 0x02) return 7;
    return 8;
  };
  const readSize = off => {
    const len = vintLen(buf[off]);
    let v = buf[off] & ((1 << (8 - len)) - 1);
    for (let i = 1; i < len; i++) v = v * 256 + buf[off + i];
    return { len, val: v };
  };
  const readId = off => {
    const len = vintLen(buf[off]);
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + buf[off + i];
    return { len, id };
  };
  const findChild = (start, end, targetId) => {
    let i = start;
    while (i < end && i + 2 < buf.length) {
      const id = readId(i);
      const sz = readSize(i + id.len);
      if (id.id === targetId) {
        return { idOff: i, idLen: id.len, dataOff: i + id.len + sz.len, dataLen: sz.val };
      }
      i += id.len + sz.len + sz.val;
    }
    return null;
  };
  const encodeVint = value => {
    for (let len = 1; len <= 8; len++) {
      const maxVal = Math.pow(2, 7 * len) - 1;
      if (value < maxVal) {
        const out = new Uint8Array(len);
        out[0] = (0x80 >> (len - 1)) | (Math.floor(value / Math.pow(256, len - 1)) & 0xFF);
        for (let i = 1; i < len; i++) {
          out[i] = Math.floor(value / Math.pow(256, len - 1 - i)) & 0xFF;
        }
        return out;
      }
    }
    throw new Error('vint overflow: ' + value);
  };
  const writeF64BE = (b, o, val) => {
    const ab = new ArrayBuffer(8);
    new DataView(ab).setFloat64(0, val, false);
    const u = new Uint8Array(ab);
    for (let i = 0; i < 8; i++) b[o + i] = u[i];
  };

  let off = 0;
  const hdr = readId(off); off += hdr.len;
  const hdrSz = readSize(off); off += hdrSz.len + hdrSz.val;
  const seg = readId(off);
  if (seg.id !== ID_SEGMENT) return null;
  off += seg.len;
  const segSz = readSize(off); off += segSz.len;
  const segEnd = Math.min(off + segSz.val, buf.length);
  const info = findChild(off, segEnd, ID_SEGMENTINFO);
  if (!info) return null;
  let tsScale = 1000000;
  const ts = findChild(info.dataOff, info.dataOff + info.dataLen, ID_TIMECODESCALE);
  if (ts) {
    tsScale = 0;
    for (let k = 0; k < ts.dataLen; k++) tsScale = tsScale * 256 + buf[ts.dataOff + k];
  }
  const durValue = (durationMs * 1e6) / tsScale;
  const existing = findChild(info.dataOff, info.dataOff + info.dataLen, ID_DURATION);
  if (existing && existing.dataLen === 8) {
    writeF64BE(buf, existing.dataOff, durValue);
    return { buf, mode: 'in-place' };
  }
  const durElm = new Uint8Array(11);
  durElm[0] = 0x44; durElm[1] = 0x89; durElm[2] = 0x88;
  writeF64BE(durElm, 3, durValue);
  const newDataLen = info.dataLen + 11;
  const newSizeVint = encodeVint(newDataLen);
  const oldSizeLen = info.dataOff - info.idOff - info.idLen;
  const headerEnd = info.idOff + info.idLen;
  const out = new Uint8Array(buf.length + 11 + (newSizeVint.length - oldSizeLen));
  let pos = 0;
  out.set(buf.subarray(0, headerEnd), pos); pos += headerEnd;
  out.set(newSizeVint, pos); pos += newSizeVint.length;
  out.set(buf.subarray(info.dataOff, info.dataOff + info.dataLen), pos); pos += info.dataLen;
  out.set(durElm, pos); pos += 11;
  out.set(buf.subarray(info.dataOff + info.dataLen), pos);
  return { buf: out, mode: 'grown' };
}

function main() {
  const durationMs = +process.argv[2] || DEFAULT_DURATION_MS;
  if (!fs.existsSync(VIDEOS_DIR)) {
    console.error('No videos dir:', VIDEOS_DIR);
    process.exit(1);
  }
  const files = fs.readdirSync(VIDEOS_DIR)
    .filter(f => f.toLowerCase().endsWith('.webm'))
    .map(f => path.join(VIDEOS_DIR, f));
  console.log(`Found ${files.length} .webm file(s) in ${VIDEOS_DIR}`);
  console.log(`Target duration: ${durationMs} ms`);
  let okCount = 0, skipCount = 0, failCount = 0;
  for (const file of files) {
    try {
      const buf = new Uint8Array(fs.readFileSync(file));
      const res = injectEbmlDuration(buf, durationMs);
      if (!res) {
        console.warn('  SKIP', path.basename(file), '— no SegmentInfo found');
        skipCount++;
        continue;
      }
      fs.writeFileSync(file, Buffer.from(res.buf));
      console.log('  OK  ', path.basename(file), '—', res.mode);
      okCount++;
    } catch (e) {
      console.error('  FAIL', path.basename(file), '—', e.message);
      failCount++;
    }
  }
  console.log(`\nDone: ${okCount} patched, ${skipCount} skipped, ${failCount} failed.`);
}

main();
