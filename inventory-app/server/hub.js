// AI エージェントとの共同作業の入口: 決まったことから「やること」の一覧を作る（状態は各商品が正本。ここは読むだけ）。
// 投稿・出品のように外に出る作業は、ユーザーが許可した印（レビュー「投稿OK」・出品判断「出品」）があるものだけ載せる。
import { presenceOf, placeOf } from './rules.js';
import { guessCategory } from './category.js';

const brief = (p, settings) => ({
  id: p.id, name: p.name, category: p.category || guessCategory(p.name), place: placeOf(p, settings), presence: presenceOf(p),
  asin: p.browser?.asin || p.amazon?.asin || null, vineLists: Object.keys(p.browser?.lists || {}),
  materialsZip: `/api/materials.zip?ids=${p.id}`,
});

export function agentQueue(store, settings) {
  const tasks = [];
  for (const p of store.list({ includeTrash: false })) {
    if (p.asideAt) continue;
    const rp = p.reviewPlan || {};
    const b = () => brief(p, settings);
    if (rp.status === 'todo') tasks.push({ type: 'review_draft', what: 'レビュー・発信の下書きを作る（MCP save_review_draft）', formats: rp.formats || [], note: rp.note || '', product: b() });
    if (rp.status === 'approved') tasks.push({ type: 'review_post', what: 'ユーザーが投稿OKにした下書きを投稿し、URLを報告する（MCP mark_review_posted）', formats: rp.formats || [], draft: rp.draft || '', note: rp.note || '', product: b() });
    if (p.decision === 'sell' && presenceOf(p) !== 'gone' && !['listed', 'trading', 'sold'].includes(p.stage)) {
      for (const c of p.targets || []) tasks.push({ type: 'listing', channel: c, what: `出品の準備・転記（MCP channel_package で内容を読む）`, stage: p.stage, product: b() });
    }
  }
  const count = tasks.reduce((m, t) => ((m[t.type] = (m[t.type] || 0) + 1), m), {});
  return { count, tasks };
}
