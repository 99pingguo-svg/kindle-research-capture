// 写真の撮影時刻（EXIF）と、撮影の間で組に分ける処理（画面に依存しない。テストあり）。

/** Capture time from the JPEG's EXIF (DateTimeOriginal), else the file date. */
export async function takenAt(file) {
  try {
    const t = exifTime(new DataView(await file.slice(0, 256 * 1024).arrayBuffer()));
    if (t) return t;
  } catch { /* fall back */ }
  return file.lastModified || Date.now();
}

/** DateTimeOriginal of a JPEG (DataView over its first bytes) as ms, or null. Shared with the server. */
export function exifTime(buf) {
  try {
    if (buf.getUint16(0) !== 0xffd8) return null;
    let o = 2;
    while (o + 4 < buf.byteLength) {
      const marker = buf.getUint16(o);
      const len = buf.getUint16(o + 2);
      if (marker === 0xffe1 && buf.getUint32(o + 4) === 0x45786966) { // "Exif"
        const t = o + 10;
        const le = buf.getUint16(t) === 0x4949;
        const u16 = (p) => buf.getUint16(t + p, le);
        const u32 = (p) => buf.getUint32(t + p, le);
        const tag = (ifd, want) => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (u16(e) === want) return e;
          }
          return null;
        };
        const ifd0 = u32(4);
        const exifPtr = tag(ifd0, 0x8769);
        if (exifPtr == null) break;
        const dto = tag(u32(exifPtr + 8), 0x9003);
        if (dto == null) break;
        const at = u32(dto + 8);
        let s = '';
        for (let i = 0; i < 19; i++) s += String.fromCharCode(buf.getUint8(t + at + i));
        const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(s);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        break;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      o += 2 + len;
    }
  } catch { /* unreadable */ }
  return null;
}

/** Split photos (sorted by time) where the gap is larger than `gapSec`. */
export const groupByGap = (items, gapSec) => items.reduce((groups, it) => {
  const last = groups.at(-1);
  if (last && it.at - last.at.at(-1) <= gapSec * 1000) { last.items.push(it); last.at.push(it.at); } else groups.push({ items: [it], at: [it.at], productId: null, why: '', skip: false });
  return groups;
}, []);

