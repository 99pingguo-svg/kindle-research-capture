// 税理士・税務署への説明資料（印刷・PDF保存用の HTML）。
// 方針: 活動の理念（利用者の主張）と、商品ごとの客観的な事実を分けて見せる。税務上の扱いは記録の状態（要確認／承認済み）と
// 5つのメモ（主張・実際・一般的な取扱い・専門家の確認・申告で採用）をそのまま載せ、こちらで判断を足さない。
import { BOOK_KINDS, BOOK_STATUSES } from './books.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const yen = (v) => (v == null ? '—' : `${Number(v).toLocaleString('ja-JP')}円`);
const kind = (id) => BOOK_KINDS.find((k) => k.id === id)?.label || id;
const TAX = [['claim', '利用者の主張'], ['actual', '実際の使用状況・証拠'], ['general', '現行税法上の一般的な処理'], ['expert', '税理士・税務署等の確認結果'], ['filed', '申告で採用した処理']];
const PLATFORM = { youtube: 'YouTube', blog: 'ブログ', x: 'X', instagram: 'Instagram', other: 'その他' };
const WORK_STATUS = { planned: '企画', filming: '撮影中', published: '公開済み', dropped: '中止' };
const link = (u) => (/^https?:\/\//.test(u || '') ? `<a href="${esc(u)}">${esc(u)}</a>` : esc(u));

function page(title, body) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:14px/1.7 -apple-system,"Hiragino Sans",sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:20px;border-bottom:2px solid #333;padding-bottom:4px}h2{font-size:16px;margin-top:28px;border-left:4px solid #555;padding-left:8px}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #bbb;padding:4px 6px;vertical-align:top;text-align:left}th{background:#f2f2f2;white-space:nowrap}
.muted{color:#666;font-size:12px}.box{border:1px solid #ccc;border-radius:6px;padding:8px 12px;margin:8px 0;background:#fafafa}
@media print{a{color:inherit;text-decoration:none}.noprint{display:none}}</style>
<p class="muted noprint">ブラウザの「印刷」から PDF に保存できます。</p>${body}
<p class="muted">作成 ${esc(new Date().toLocaleString('ja-JP'))}（商品台帳の帳簿から自動作成）。税務上の扱いは各記録の状態と注記のとおりで、この資料は判断を加えていません。</p></html>`;
}

const taxTable = (e) => {
  const rows = TAX.filter(([k]) => e.tax?.[k]).map(([k, l]) => `<tr><th>${l}</th><td>${esc(e.tax[k])}</td></tr>`).join('');
  return rows ? `<table>${rows}</table>` : '<p class="muted">税務上の扱いのメモはまだありません。</p>';
};
const journal = (e) => (e.journal.length ? e.journal.map((l) => `${l.side === 'debit' ? '借方' : '貸方'} ${esc(l.account)} ${yen(l.amount)}`).join('<br>') : '—');

/** 商品別の証拠資料。 */
export function productReport({ p, entries, works, statement }) {
  const lists = Object.keys(p.browser?.lists || {});
  const receipt = entries.find((e) => e.kind === 'vine_receipt');
  const life = entries.filter((e) => ['use', 'kept', 'consumed', 'disposed', 'sold', 'review_published'].includes(e.kind));
  const photos = (p.photos || []).filter((x) => !x.deletedAt);
  const body = `<h1>商品別の記録 ${esc(p.id)}　${esc(p.name)}</h1>
<h2>1. 商品の基本情報と、提供・取得の記録</h2>
<table><tr><th>管理ID</th><td>${esc(p.id)}</td></tr><tr><th>商品名</th><td>${esc(p.name)}</td></tr>
<tr><th>ASIN</th><td>${esc(p.browser?.asin || '')}</td></tr><tr><th>種類</th><td>${esc(p.category || '')}</td></tr><tr><th>数量</th><td>${esc(p.quantity ?? '')}</td></tr>
<tr><th>商品ページ</th><td>${(p.links || []).map((l) => link(l.url)).join('<br>')}</td></tr>
<tr><th>注文日・到着日</th><td>${esc(p.orderDate || '—')} ／ ${esc(p.arrivalDate || '—')}</td></tr>
<tr><th>入手の経路</th><td>${lists.some((l) => l !== 'orders') ? 'Amazon Vine の提供品（観察ブラウザの Vine の一覧に記録）' : lists.includes('orders') ? 'Amazon の注文履歴に記録（購入または Vine）' : '記録なし'}</td></tr></table>
<h2>2. 受領時の価格と評価の根拠</h2>
${receipt ? `<table><tr><th>受領日（記録）</th><td>${esc(receipt.date)}</td></tr><tr><th>Amazon表示価格</th><td>${yen(receipt.facts.listPrice)}（${esc(receipt.facts.listPriceAt || '確認日なし')}・${esc(receipt.facts.listPriceSource || '出どころなし')}）</td></tr>
<tr><th>税務上の評価額</th><td>${yen(receipt.valuation.value)}</td></tr><tr><th>評価の根拠</th><td>${esc(receipt.valuation.basis || '未定')}</td></tr>
<tr><th>注記</th><td>${esc(receipt.facts.note)}</td></tr><tr><th>帳簿の状態</th><td>${BOOK_STATUSES[receipt.status]}</td></tr></table>` : '<p class="muted">Vine 受領の記録はありません。</p>'}
<h2>3. 制作企画と公開した作品</h2>
${works.length ? `<table><tr><th>作品</th><th>媒体</th><th>状態</th><th>企画・撮影・公開</th><th>URL</th></tr>${works.map((w) => `<tr><td>${esc(w.id)} ${esc(w.title)}<div class="muted">${esc(w.note)}</div></td><td>${PLATFORM[w.platform]}</td><td>${WORK_STATUS[w.status]}</td><td>${esc(w.plannedAt || '—')} ／ ${esc(w.filmedAt || '—')} ／ ${esc(w.publishedAt || '—')}</td><td>${link(w.url)}</td></tr>`).join('')}</table>` : '<p class="muted">紐付いた作品はまだありません。</p>'}
<h2>4. 使用・検証の期間と、最終的な状況</h2>
${life.length ? `<table><tr><th>日付</th><th>種類</th><th>内容</th></tr>${life.map((e) => `<tr><td>${esc(e.date)}</td><td>${kind(e.kind)}</td><td>${esc(e.facts.note || e.title)}</td></tr>`).join('')}</table>` : '<p class="muted">使用・処分の記録はまだありません。</p>'}
<h2>5. 会計処理と税務上の根拠</h2>
${entries.length ? entries.map((e) => `<div class="box"><b>${esc(e.id)}</b>　${esc(e.date)}　${kind(e.kind)}　<b>${BOOK_STATUSES[e.status]}</b>${e.excludedReason ? `（載せない理由: ${esc(e.excludedReason)}）` : ''}
<div>仕訳: ${journal(e)}</div>${taxTable(e)}</div>`).join('') : '<p class="muted">帳簿の記録はありません。</p>'}
<h2>6. 証拠</h2>
<p>現物写真 ${photos.filter((x) => x.kind === 'actual').length}枚・参考画像 ${photos.filter((x) => x.kind === 'reference').length}枚（商品台帳に保存）。${entries.flatMap((e) => e.evidence || []).filter((x) => /^https?:/.test(x.ref)).map((x) => `${esc(x.label)}: ${link(x.ref)}`).join('　')}</p>
${statement ? `<h2>参考: 活動の理念（利用者の主張）</h2><div class="box">${esc(statement).replace(/\n/g, '<br>')}</div><p class="muted">上の理念は利用者の主張であり、税務当局に認められた取扱いではありません。</p>` : ''}`;
  return page(`商品別の記録 ${p.id}`, body);
}

/** 年間の説明資料: 第1部 理念（主張）、第2部 客観的な事実（集計と一覧）。 */
export function yearReport({ year, entries, works, summary, products, statement }) {
  const name = (id) => products.get(id)?.name || '';
  const rows = (list) => list.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.productId)} ${esc(e.title || name(e.productId))}</td><td>${yen(e.facts.listPrice ?? e.facts.amount)}</td><td>${yen(e.valuation.value)}</td><td>${BOOK_STATUSES[e.status]}</td></tr>`).join('');
  const by = (k) => entries.filter((e) => e.kind === k);
  const accounts = Object.entries(summary.approvedAccounts);
  const body = `<h1>${esc(year)}年 活動と帳簿の説明資料</h1>
<h2>第1部　活動の理念（利用者の主張）</h2>
${statement ? `<div class="box">${esc(statement).replace(/\n/g, '<br>')}</div>` : '<p class="muted">まだ書かれていません（帳簿の画面の「説明資料」から書けます）。</p>'}
<p class="muted">第1部は利用者の考え方の説明です。第2部の事実とは分けて示します。</p>
<h2>第2部　客観的な事実</h2>
<table><tr><th>記録の件数</th><td>${summary.total}件（要確認 ${summary.review}件）</td></tr>
<tr><th>Vine受領の表示価格の合計</th><td>${yen(summary.vine.shownPriceTotal)}（表示価格なし ${summary.vine.withoutPrice}件。税務上の評価額ではない）</td></tr>
<tr><th>種類ごとの件数</th><td>${summary.byKind.map((k) => `${esc(k.label)} ${k.count}`).join('・') || '—'}</td></tr>
<tr><th>作品（公開済み）</th><td>${works.filter((w) => w.status === 'published').length}本（全 ${works.length}本）</td></tr>
<tr><th>承認済みの仕訳の集計</th><td>${accounts.map(([a, v]) => `${esc(a)}: 借方 ${yen(v.debit)}・貸方 ${yen(v.credit)}`).join('<br>') || '—'}</td></tr></table>
<h3>Vine受領（${by('vine_receipt').length}件）</h3><table><tr><th>受領日</th><th>商品</th><th>表示価格</th><th>評価額</th><th>状態</th></tr>${rows(by('vine_receipt'))}</table>
<h3>消費・廃棄・保管・売却</h3><table><tr><th>日付</th><th>商品</th><th>金額</th><th>評価額</th><th>状態</th></tr>${rows(entries.filter((e) => ['consumed', 'disposed', 'kept', 'sold'].includes(e.kind)))}</table>
<h3>経費・購入・収入</h3><table><tr><th>日付</th><th>内容</th><th>金額</th><th>評価額</th><th>状態</th></tr>${rows(entries.filter((e) => ['expense', 'purchase', 'income'].includes(e.kind)))}</table>
<h3>作品</h3><table><tr><th>公開日</th><th>作品</th><th>媒体</th><th>登場する商品</th><th>URL</th></tr>${works.map((w) => `<tr><td>${esc(w.publishedAt || '—')}</td><td>${esc(w.title)}</td><td>${PLATFORM[w.platform]}</td><td>${w.productIds.map((id) => `${esc(id)} ${esc(name(id))}`).join('<br>')}</td><td>${link(w.url)}</td></tr>`).join('')}</table>`;
  return page(`${year}年 説明資料`, body);
}
