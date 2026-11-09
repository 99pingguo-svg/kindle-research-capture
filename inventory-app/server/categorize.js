// 種類の自動分類（設定 autoCategory）: 種類が空の商品に、商品名・Amazon の商品名から決まりごと（server/category.js）で分類し、
// 決まらないものだけローカルAI（Ollama qwen3.5:4b、無料・外部送信なし）に種類の一覧から1つ選ばせる。
// 結果は AI（claude）の設定として入るので、ユーザーが変えた種類はそのまま（確定済みなら提案になる）。種類ごとの置き場は設定 categoryPlaces。
import { CATEGORIES, guessCategory } from './category.js';

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.CATEGORY_MODEL || 'qwen3.5:4b';
const ACTOR = 'claude';

async function askLocalAi(text) {
  const prompt = `次の商品を、一覧の中の種類から1つだけ選んでください。食べ物・飲み物・サプリは「食品・飲料」。\n商品: ${text.slice(0, 300)}\n種類の一覧: ${CATEGORIES.join(' / ')}\nJSONだけで答える: {"category": "<一覧のどれか>"}`;
  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false, format: { type: 'object', properties: { category: { type: 'string', enum: CATEGORIES } }, required: ['category'] }, options: { temperature: 0 }, keep_alive: '5m' }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return null;
    const c = JSON.parse((await res.json()).response || '{}').category;
    return CATEGORIES.includes(c) ? c : null;
  } catch {
    return null;
  }
}

export function createCategorizer(store) {
  const tried = new Set();
  let busy = false;

  async function sweep() {
    if (busy || store.settings.autoCategory === false) return 0;
    busy = true;
    let n = 0;
    try {
      for (const p of store.list({ includeTrash: false })) {
        if (p.category || tried.has(p.id)) continue;
        tried.add(p.id);
        const text = [p.name, p.amazon?.title].filter(Boolean).join(' ');
        if (!text.trim()) continue;
        let cat = guessCategory(text);
        let how = '商品名の決まりごと';
        if (cat === 'その他') { cat = (await askLocalAi(text)) || 'その他'; how = 'ローカルAI'; }
        const cur = store.get(p.id);
        if (cur.category || cur.trashedAt) continue; // set meanwhile
        try {
          store.updateFields(p.id, ACTOR, { category: cat }, { reason: `種類の自動分類（${how}）` });
          n++;
        } catch (e) {
          console.error('categorize:', p.id, e.message);
        }
      }
    } finally {
      busy = false;
    }
    if (n) console.log(`種類の自動分類: ${n}件`);
    return n;
  }

  // New products (観察ブラウザ連携・リストの取り込み) are classified shortly after they arrive.
  let timer = null;
  store.on('change', (ev) => {
    if (ev.type !== 'product' || ev.actor === ACTOR) return;
    const p = store.products.get(ev.id);
    if (p && !p.category && !tried.has(p.id)) { clearTimeout(timer); timer = setTimeout(sweep, 5000); }
  });
  setTimeout(sweep, 20_000);
  return { sweep };
}
