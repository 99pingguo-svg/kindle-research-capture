// Generates the PWA icons (a simple box glyph) without any image library.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../server/zip.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
fs.mkdirSync(out, { recursive: true });

function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x / size, y / size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const TEAL = [15, 118, 110, 255];
const WHITE = [255, 255, 255, 255];
const LID = [204, 251, 241, 255];
function icon(u, v) {
  // box body
  if (u > 0.24 && u < 0.76 && v > 0.42 && v < 0.78) {
    if (u > 0.46 && u < 0.54 && v < 0.56) return TEAL; // tape
    if (u > 0.32 && u < 0.5 && v > 0.64 && v < 0.69) return TEAL; // label line
    return WHITE;
  }
  // lid
  if (u > 0.2 && u < 0.8 && v > 0.3 && v < 0.42) return u > 0.46 && u < 0.54 ? TEAL : LID;
  return TEAL;
}

for (const size of [180, 192, 512]) fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size, icon));
console.log('icons written to', out);
