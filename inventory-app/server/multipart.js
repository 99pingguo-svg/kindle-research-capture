// Minimal multipart/form-data parser (enough for photo uploads from our own client).
import { AppError } from './util.js';

export async function readBody(req, limit = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AppError(413, 'アップロードが大きすぎます');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new AppError(400, 'multipart boundary がありません');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {};
  const files = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = buf.slice(start + 2, headerEnd).toString('utf8');
    const next = buf.indexOf(boundary, headerEnd);
    if (next === -1) break;
    const body = buf.slice(headerEnd + 4, next - 2); // strip trailing CRLF
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    if (name != null) {
      if (filename != null) files[name] = { buffer: body, mime: type || 'application/octet-stream', filename };
      else fields[name] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}
