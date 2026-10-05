// Secondary pages rendered in the detail pane: activity log, import, settings.
import { h, clear, toast, showError, choose, fmtDate, isAiActor, actorLabel, copyText } from './ui.js';
import { api } from './api.js';
import { state, loadAll } from './state.js';
import { fmtDay } from './calendar.js';

const pane = () => document.getElementById('detail-pane');

function frame(title, ...body) {
  const p = pane();
  clear(p);
  p.scrollTop = 0;
  p.append(h('div', { class: 'detail' },
    h('header', { class: 'topbar', style: { margin: '0 -12px' } },
      h('div', { class: 'detail-head' },
        h('button', { class: 'icon-btn', onclick: () => (location.hash = '#/'), 'aria-label': '戻る' }, '‹'),
        h('div', { class: 'name' }, title))),
    ...body));
}

export async function showActivity() {
  frame('共同作業の履歴', h('div', { class: 'card' }, '読み込み中…'));
  let items;
  try {
    items = await api.get('/api/activity?limit=400');
  } catch (e) {
    return showError(e);
  }
  const byDay = new Map();
  for (const a of items) {
    const d = new Date(a.at).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(a);
  }
  const undoSince = async (a) => {
    const ok = await choose(`${fmtDate(a.at)} 以降の ${actorLabel(a.actor)} の変更をすべて取り消しますか？（対象商品はそれぞれ ${actorLabel(a.actor)} が最初に変更する前の状態に戻ります。写真は消えません）`, [{ label: 'まとめて取り消す', value: true, danger: true }]);
    if (!ok) return;
    try {
      const r = await api.post('/api/revert-actor', { actor: a.actor, since: a.at });
      toast(`${r.filter((x) => x.ok).length}商品を復元しました`);
      await loadAll();
      showActivity();
    } catch (e) {
      showError(e);
    }
  };
  frame('共同作業の履歴',
    h('p', { class: 'muted small' }, 'あなたとAIが「いつ・何を」変更したかの記録です。AIの一括処理を取り消すこともできます。'),
    [...byDay.entries()].map(([day, list]) => h('div', { class: 'card' },
      h('h2', null, day),
      h('ul', { class: 'timeline' }, list.map((a) => h('li', null,
        h('div', { class: 'meta' },
          h('span', null, fmtDate(a.at)),
          h('span', { class: isAiActor(a.actor) ? 'who-ai' : 'who-user' }, isAiActor(a.actor) ? `🤖 ${actorLabel(a.actor)}` : `👤 ${actorLabel(a.actor)}`),
          h('a', { href: `#/p/${a.productId}` }, `#${a.productId}`),
          h('span', { class: 'spacer' }),
          isAiActor(a.actor) && h('button', { class: 'btn small ghost', onclick: () => undoSince(a) }, 'ここ以降を取消')),
        h('div', null, a.productName ? h('span', { class: 'muted' }, `${a.productName}: `) : null, a.summary)))))));
}

export function showImport() {
  const ta = h('textarea', { class: 'import', placeholder: '1行に1商品。商品名とURLを並べて書けます。\n例:\nAnker PowerCore 10000 https://www.amazon.co.jp/dp/B019GJLER8\nSony WH-1000XM4 https://www.sony.jp/headphone/products/WH-1000XM4/\nhttps://item.rakuten.co.jp/…（URLだけでも可。AIが特定します）' });
  const decision = h('select', null, state.meta.decisions.map((d) => h('option', { value: d.id, selected: d.id === 'undecided' }, d.label)));
  const plan = h('input', { type: 'checkbox' });
  const preview = h('div');
  let parsed = null;
  const skip = new Set();
  const doPreview = async () => {
    try {
      parsed = await api.post('/api/import', { text: ta.value, dryRun: true });
      skip.clear();
      parsed.items.forEach((it, i) => it.duplicates.length && skip.add(i));
      renderPreview();
    } catch (e) {
      showError(e);
    }
  };
  const renderPreview = () => {
    clear(preview);
    if (!parsed) return;
    preview.append(h('div', { class: 'card' },
      h('h2', null, `確認（${parsed.items.length}件）`),
      parsed.items.map((it, i) => h('label', { class: 'preview-row' },
        h('input', { type: 'checkbox', checked: !skip.has(i), onchange: (e) => (e.target.checked ? skip.delete(i) : skip.add(i)) }),
        h('div', null,
          h('div', null, it.itemDate && h('strong', null, `${fmtDay(it.itemDate)} `), it.name || h('span', { class: 'muted' }, '（名称なし・AIがURLから特定）')),
          it.links.map((l) => h('div', { class: 'small muted', style: { wordBreak: 'break-all' } }, l)),
          it.duplicates.map((d) => h('div', { class: 'small', style: { color: 'var(--warn)' } }, `⚠ #${d.id} ${d.name} と重複の可能性（${d.reasons.join('・')}）`))))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const r = await api.post('/api/import', { text: ta.value, skip: [...skip], decision: decision.value, shootPlan: plan.checked });
            toast(`${r.created.length}件を登録しました`);
            await loadAll();
            location.hash = '#/';
          } catch (e) {
            showError(e);
          }
        } }, `${parsed.items.length - skip.size}件を登録`))));
  };
  frame('商品リストを一括登録',
    h('div', { class: 'card' },
      ta,
      h('div', { class: 'grid2', style: { marginTop: '10px' } },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '出品判断'), decision),
        h('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '8px', marginTop: '18px' } }, plan, '撮影予定にする')),
      h('button', { class: 'btn primary', onclick: doPreview }, '確認する'),
      h('p', { class: 'muted small' }, 'Claude に「この商品リストを登録して」と頼むこともできます（MCP の create_products）。')),
    preview);
}

export function showSettings() {
  const s = state.meta.settings;
  const save = async (patch) => {
    try {
      state.meta.settings = await api.put('/api/settings', patch);
      toast('保存しました');
    } catch (e) {
      showError(e);
    }
  };
  const sel = (key, label, options) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
    h('select', { onchange: (e) => save({ [key]: e.target.value }) }, h('option', { value: '' }, '—'), options.map((o) => h('option', { value: o, selected: s[key] === o }, o))));
  const origin = location.origin;
  const mcpUrl = `${origin.replace(/\/\/[^/:]+/, '//localhost')}/mcp`;
  const cmd = `claude mcp add --transport http shohin-daicho ${mcpUrl}`;
  frame('設定',
    h('div', { class: 'card' },
      h('h2', null, '新規商品の配送デフォルト'),
      h('div', { class: 'grid2' },
        sel('shippingPayer', '配送料の負担', state.meta.shipping.payers),
        sel('shippingMethod', '配送の方法', state.meta.shipping.methods),
        sel('shippingFrom', '発送元の地域', state.meta.shipping.prefectures),
        sel('shippingDays', '発送までの日数', state.meta.shipping.days))),
    h('div', { class: 'card' },
      h('h2', null, '写真'),
      h('label', { class: 'field', style: { flexDirection: 'row', gap: '8px', alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: s.autoSelectListingPhotos, onchange: (e) => save({ autoSelectListingPhotos: e.target.checked }) }),
        '撮影した現物写真を自動で出品用に追加する（あとで外せます）'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '推奨する出品用写真の枚数'),
        h('input', { type: 'text', inputmode: 'numeric', value: s.recommendedPhotos, onchange: (e) => save({ recommendedPhotos: Number(e.target.value) || 3 }) }))),
    h('div', { class: 'card' },
      h('h2', null, '🤖 AI'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'QC（画像QCを含む）を実施できるモデル'),
        h('input', { type: 'text', value: (s.imageQcModels || []).join(', '), onchange: (e) => save({ imageQcModels: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }) }),
        h('span', { class: 'small muted' }, '画質・写真間の整合性・違和感のチェックはこのモデルだけが記録できます。既定: claude-opus-5-5')),
      h('h3', null, 'Claude Code（Mac）から接続'),
      h('p', { class: 'small' }, 'Mac のターミナルで一度だけ実行:'),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } }, h('code', { class: 'code', style: { flex: 1 } }, cmd), h('button', { class: 'btn small', onclick: () => copyText(cmd) }, 'コピー')),
      h('p', { class: 'small muted' }, 'その後 Claude に「今日撮った商品を全部確認して、出品準備を進めて」と頼めます。AIタスクキューの自動処理は scripts/ai-worker.sh を参照。')),
    h('div', { class: 'card' },
      h('h2', null, '📦 書き出し・バックアップ'),
      h('div', { class: 'row-actions', style: { marginTop: 0 } },
        h('a', { class: 'btn small', href: '/api/export.zip' }, '全商品 ZIP（写真込み）'),
        h('a', { class: 'btn small', href: '/api/export.zip?photos=0' }, '全商品 ZIP（情報のみ）'),
        h('a', { class: 'btn small', href: '/api/export.csv' }, 'CSV')),
      h('p', { class: 'small muted' }, `データの保存場所（Mac）: ${state.meta.dataDir}`),
      h('p', { class: 'small muted' }, '商品情報は毎日自動でバックアップされます（data/backups）。写真を含む完全バックアップは npm run backup。')),
    h('div', { class: 'card' },
      h('h2', null, 'この端末'),
      h('p', { class: 'small muted' }, 'iPhone では Safari の共有ボタン →「ホーム画面に追加」でアプリとして使えます。'),
      h('button', { class: 'btn small', onclick: () => location.reload() }, 'アプリを再読み込み')));
}

const DATE_STATUS = {
  set: { label: '日付を設定', cls: 'ok' },
  change: { label: '日付を変更', cls: 'warn' },
  same: { label: '変更なし', cls: '' },
  ambiguous: { label: '要確認（複数の商品に一致）', cls: 'danger' },
  conflict: { label: '要確認（同じ商品に別の日付）', cls: 'danger' },
  nodate: { label: '日付なし（スキップ）', cls: '' },
  nomatch: { label: '該当商品なし（無視）', cls: '' },
};

/** 日付の一括反映: paste "商品名 / URL / 日付…" lines; only existing products are updated. */
export function showDateImport() {
  const ta = h('textarea', { class: 'import', placeholder: '商品名<TAB>URL<TAB>日付 … の一覧をそのまま貼り付け\n（注文・購入・到着のどの列の日付でも OK。1行の最初の日付を使います）' });
  const preview = h('div');
  let plan = null;
  const include = new Set();
  const run = async (dryRun) => {
    try {
      const r = await api.post('/api/dates/import', { text: ta.value, dryRun, include: [...include] });
      if (dryRun) {
        plan = r;
        include.clear();
        render();
      } else {
        toast(`${r.applied.length}商品に日付を反映しました${r.errors.length ? `（失敗 ${r.errors.length}件）` : ''}`);
        await loadAll();
        location.hash = '#/';
      }
    } catch (e) {
      showError(e);
    }
  };
  const render = () => {
    clear(preview);
    if (!plan) return;
    const c = plan.counts;
    const willApply = (c.set || 0) + (c.change || 0);
    const group = (status, { open = false, pick = false } = {}) => {
      const rows = plan.rows.filter((r) => r.status === status);
      if (!rows.length) return null;
      return h('details', { class: 'card', open },
        h('summary', { style: { fontWeight: 700, cursor: 'pointer' } }, h('span', { class: `badge ${DATE_STATUS[status].cls}` }, `${rows.length}件`), ' ', DATE_STATUS[status].label),
        rows.slice(0, 400).map((r) => h('label', { class: 'preview-row' },
          pick && h('input', { type: 'checkbox', onchange: (e) => (e.target.checked ? include.add(r.line) : include.delete(r.line)) }),
          h('div', { style: { minWidth: 0 } },
            h('div', null, r.date ? h('strong', null, fmtDay(r.date), ' ') : null, r.name || h('span', { class: 'muted' }, '（名前なし）')),
            r.candidates.length > 0 && h('div', { class: 'small muted' },
              r.candidates.map((p) => `#${p.id}${p.itemDate && p.itemDate !== r.date ? `（現在 ${fmtDay(p.itemDate)}）` : ''}`).join(' / '),
              r.matchedBy && ` ・ ${r.matchedBy}で照合`),
            pick && h('div', { class: 'small', style: { color: 'var(--danger)' } }, 'チェックすると表示中の全候補に反映します')))));
    };
    preview.append(
      h('div', { class: 'card' },
        h('h2', null, `${plan.total}行を確認しました`),
        h('ul', { class: 'missing' },
          h('li', null, `日付を反映: ${willApply}商品（新規 ${c.set || 0} / 変更 ${c.change || 0}）`),
          h('li', { class: 'w' }, `変更なし: ${c.same || 0}`),
          h('li', { class: 'w' }, `該当する既存商品なし（無視）: ${c.nomatch || 0}`),
          (c.nodate || 0) > 0 && h('li', { class: 'w' }, `日付が書かれていない行: ${c.nodate}`),
          ((c.ambiguous || 0) + (c.conflict || 0)) > 0 && h('li', null, `要確認: ${(c.ambiguous || 0) + (c.conflict || 0)}（チェックしたものだけ反映）`)),
        h('p', { class: 'small muted' }, '照合は Amazon の商品コード（ASIN）→ URL → 商品名（完全一致・重複なしの場合のみ）の順。似ているだけの商品には反映しません。'),
        h('button', { class: 'btn primary', style: { width: '100%' }, onclick: () => run(false) }, `${willApply}商品に日付を反映`)),
      group('change', { open: true }),
      group('ambiguous', { open: true, pick: true }),
      group('conflict', { open: true, pick: true }),
      group('set'),
      group('nomatch'),
      group('nodate'),
      group('same'));
  };
  frame('日付を一括反映',
    h('div', { class: 'card' },
      h('p', { class: 'small', style: { marginTop: 0 } }, '既存の商品にだけ日付（注文・購入・到着のいずれか）を付けます。一覧にあっても台帳に無い商品は無視され、新しく登録されることはありません。'),
      ta,
      h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: () => run(true) }, '確認する（まだ反映しません）')),
    preview);
}
