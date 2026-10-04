#!/usr/bin/env node
// stdio ⇄ HTTP bridge for MCP clients that only speak stdio (e.g. Claude Desktop).
// Forwards each JSON-RPC line on stdin to the running 商品台帳 server's /mcp endpoint.
//   INVENTORY_URL=http://localhost:8787 INVENTORY_TOKEN=... node bin/mcp-stdio.js
import readline from 'node:readline';

const base = (process.env.INVENTORY_URL || 'http://localhost:8787').replace(/\/$/, '');
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
if (process.env.INVENTORY_TOKEN) headers.authorization = `Bearer ${process.env.INVENTORY_TOKEN}`;
if (process.env.INVENTORY_ACTOR) headers['x-actor'] = process.env.INVENTORY_ACTOR;

const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  chain = chain.then(() => forward(line));
});

async function forward(line) {
  let id = null;
  try {
    id = JSON.parse(line).id ?? null;
  } catch {
    /* forwarded as-is; the server reports the parse error */
  }
  try {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: line });
    if (res.status === 202) return;
    const text = await res.text();
    if (text) process.stdout.write(text.replace(/\n/g, ' ') + '\n');
  } catch (e) {
    if (id !== null) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `商品台帳サーバーに接続できません (${base}): ${e.message}` } }) + '\n');
    }
  }
}
