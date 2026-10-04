// Client-side image work: derivatives (work 2048px / thumb 400px), frame capture,
// and non-destructive edits rendered into a NEW image (the original is never touched).

export const WORK_EDGE = 2048;
export const THUMB_EDGE = 400;

export async function loadBitmap(blob) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* fall through (e.g. HEIC on some browsers) */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const dims = (src) => ({ w: src.videoWidth || src.naturalWidth || src.width, h: src.videoHeight || src.naturalHeight || src.height });

function canvasToBlob(canvas, quality) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('画像の変換に失敗しました'))), 'image/jpeg', quality));
}

export async function resizeTo(src, maxEdge, quality = 0.86) {
  const { w, h } = dims(src);
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return canvasToBlob(c, quality);
}

/** original Blob → { work, thumb, width, height } */
export async function makeVariants(blob) {
  const bmp = await loadBitmap(blob);
  const { w, h } = dims(bmp);
  const work = await resizeTo(bmp, WORK_EDGE, 0.88);
  const thumb = await resizeTo(bmp, THUMB_EDGE, 0.8);
  bmp.close?.();
  return { work, thumb, width: w, height: h };
}

/** Encode a camera frame (a <video> or an already-grabbed canvas) at full resolution. */
export async function captureFrame(src) {
  let c = src;
  if (!(src instanceof HTMLCanvasElement)) {
    c = document.createElement('canvas');
    c.width = src.videoWidth;
    c.height = src.videoHeight;
    c.getContext('2d').drawImage(src, 0, 0);
  }
  const original = await canvasToBlob(c, 0.92);
  const work = await resizeTo(c, WORK_EDGE, 0.88);
  const thumb = await resizeTo(c, THUMB_EDGE, 0.8);
  return { original, work, thumb, width: c.width, height: c.height };
}

// ---------- editing ----------

export const DEFAULT_EDIT = { rotate: 0, brightness: 0, contrast: 0, saturation: 0, square: false, auto: false };

/** Percentile-based auto levels computed on a small sample. */
function autoLevels(src) {
  const { w, h } = dims(src);
  const s = Math.min(1, 256 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  const total = d.length / 4;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * 0.005) { lo = i; break; }
  }
  acc = 0;
  for (let i = 255; i >= 0; i--) {
    acc += hist[i];
    if (acc >= total * 0.005) { hi = i; break; }
  }
  if (hi - lo < 40) return { lo: 0, hi: 255 };
  return { lo, hi };
}

/** Render `src` with edit params into a canvas (max edge `maxEdge`). */
export function renderEdit(src, params, maxEdge = WORK_EDGE) {
  const p = { ...DEFAULT_EDIT, ...params };
  let { w, h } = dims(src);
  let sx = 0;
  let sy = 0;
  let sw = w;
  let sh = h;
  if (p.square) {
    const side = Math.min(w, h);
    sx = (w - side) / 2;
    sy = (h - side) / 2;
    sw = sh = side;
  }
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  const rot = ((p.rotate % 360) + 360) % 360;
  const c = document.createElement('canvas');
  c.width = rot % 180 ? dh : dw;
  c.height = rot % 180 ? dw : dh;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const lv = p.auto ? autoLevels(src) : { lo: 0, hi: 255 };
  if (p.brightness || p.contrast || p.saturation || lv.lo !== 0 || lv.hi !== 255) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    const lut = new Uint8ClampedArray(256);
    const cf = (259 * (p.contrast + 255)) / (255 * (259 - p.contrast));
    for (let i = 0; i < 256; i++) {
      let v = ((i - lv.lo) * 255) / (lv.hi - lv.lo);
      v = v + p.brightness;
      v = cf * (v - 128) + 128;
      lut[i] = v;
    }
    const sat = 1 + p.saturation / 100;
    for (let i = 0; i < d.length; i += 4) {
      let r = lut[d[i]];
      let g = lut[d[i + 1]];
      let b = lut[d[i + 2]];
      if (sat !== 1) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * sat;
        g = l + (g - l) * sat;
        b = l + (b - l) * sat;
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

export async function editToVariants(src, params) {
  const c = renderEdit(src, params, WORK_EDGE);
  const original = await canvasToBlob(c, 0.92);
  const thumb = await resizeTo(c, THUMB_EDGE, 0.8);
  return { original, work: original, thumb, width: c.width, height: c.height };
}

export async function fetchBitmap(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('画像を読み込めません');
  return loadBitmap(await res.blob());
}
