// Tiny ZIP writer (store method, UTF-8 names). Files are read one at a time so memory
// stays bounded; photos are already compressed so "store" loses nothing.
import fs from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * entries: [{ name, data?: Buffer|string, file?: path }]. Writes to `out` (a writable
 * stream, e.g. an HTTP response) and resolves when done.
 */
export async function writeZip(out, entries) {
  const write = (b) => {
    if (out.destroyed) throw new Error('export aborted');
    return new Promise((res) => {
      if (out.write(b)) return res();
      const done = () => {
        out.off('drain', done);
        out.off('close', done);
        res();
      };
      out.once('drain', done);
      out.once('close', done);
    });
  };
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const e of entries) {
    let data;
    try {
      data = e.file ? fs.readFileSync(e.file) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    } catch {
      continue; // a missing photo file must not abort the whole export
    }
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    await write(local);
    await write(name);
    await write(data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += 30 + name.length + data.length;
    if (offset > 0xffffffff) throw new Error('ZIPが4GBを超えます。npm run backup を使ってください');
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(cdBuf);
  await write(end);
}
