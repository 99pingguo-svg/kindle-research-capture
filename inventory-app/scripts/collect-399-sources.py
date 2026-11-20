#!/usr/bin/env python3
"""399商品の取り込み（scripts/import-399.js）が読むファイルだけを、外付けSSDの「取り込み元」へ写す。
  python3 -I scripts/collect-399-sources.py [写し先]     （既定 /Volumes/Crucial X9/商品データ/399商品/取り込み元/Codex）
元（~/Documents/Codex、iCloud）は読むだけ。写したファイルは sha256 で照合し、写し先の MANIFEST.tsv に「相対パス・大きさ・sha256」を書く。
import-399.js は CODEX_399_ROOT=写し先 で読み、台帳類の中の ~/Documents/Codex/… の絶対パスを写し先へ読み替える。
選び方は import-399.js と同じ: 割り当て表・監査・原稿（通常・販売用）・参考画像の一覧と元画像・10/5 の台帳の採用画像・
現行の採用台帳の formally_adopted（役ごとに最新）・最新の価格データと分類。"""
import csv, glob, hashlib, json, os, shutil, sys
H = os.path.expanduser('~'); C = H + '/Documents/Codex'
DEST = sys.argv[1] if len(sys.argv) > 1 else '/Volumes/Crucial X9/商品データ/399商品/取り込み元/Codex'
R = C + '/2026-10-04/task/recovery_audit_20261004'
SRC = dict(assignment=R + '/iphone_work_handoff_20261004/399_assignment.csv', audit=R + '/audit_399_current_copy.json',
           manuscripts=R + '/iphone_work_handoff_20261004/master_manuscripts/products', ledger=C + '/2026-10-02/task/promotion_completion_ledger.json',
           resale=R + '/iphone_work_handoff_20261004/master_manuscripts/products_resale',
           adoption=C + '/399商品_Claude画像制作共有/handoff_to_dot/COORDINATOR_CLAUDE/ADOPTION_LEDGER.json')
need, outside = set(), []
def add(p):
    if not p: return
    if p.startswith(C + '/'):
        if os.path.exists(p): need.add(p)
    elif os.path.exists(p): outside.append(p)  # Codex の外: 読み替えない（そのまま元の場所を読む）
for k in ('assignment', 'audit', 'ledger', 'adoption'): add(SRC[k])
asins = [r['asin'] for r in csv.DictReader(open(SRC['assignment'], encoding='utf-8-sig'))]
truthy = lambda v: v is True or v in ('True', 'true')
ledger = {r['asin']: r for r in json.load(open(SRC['ledger']))['records']}
for a in asins:
    for f in (f"{SRC['manuscripts']}/{a}/manuscript.json", f"{SRC['manuscripts']}/{a}/reference_inventory.json", f"{SRC['resale']}/{a}/manuscript.json"): add(f)
    ri = f"{SRC['manuscripts']}/{a}/reference_inventory.json"
    if os.path.exists(ri):
        for r in json.load(open(ri)): add(r.get('original_path'))
    rec = ledger.get(a)
    if rec:
        imgs = rec.get('images') or []
        st = rec.get('completion_state')
        pick = imgs if st == 'complete' else [i for i in imgs if truthy(i.get('formal_parent_scoped_adoption'))] if st == 'partial_images_adopted_not_complete' else []
        for im in pick:
            f = im.get('file')
            if f and os.path.isdir(f): f = os.path.join(f, im['name'])
            add(f)
latest = {}
for r in json.load(open(SRC['adoption']))['records']:
    if r.get('status') != 'formally_adopted': continue
    k = (r['asin'], r['role'])
    if k not in latest or str(r['adopted_at_utc']) > str(latest[k]['adopted_at_utc']): latest[k] = r
for r in latest.values(): add(r['png'])
prices = sorted(glob.glob(C + '/*/*/outputs/399商品_価格確認データ_*.json'))
if prices:
    add(prices[-1]); add(os.path.join(os.path.dirname(prices[-1]), '..', 'work', 'classification.json'))
need = {os.path.normpath(p) for p in need}
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()
rows, total = [], 0
for p in sorted(need):
    rel = os.path.relpath(p, C); d = os.path.join(DEST, rel)
    s = sha(p)
    if not (os.path.exists(d) and os.path.getsize(d) == os.path.getsize(p) and sha(d) == s):
        os.makedirs(os.path.dirname(d), exist_ok=True); shutil.copyfile(p, d)
        if sha(d) != s: raise SystemExit(f'照合に失敗: {rel}')
    rows.append((rel, os.path.getsize(p), s)); total += os.path.getsize(p)
with open(os.path.join(DEST, 'MANIFEST.tsv'), 'w', encoding='utf-8') as f:
    f.write('# 399商品の取り込み元（SSD が正本・iCloud ~/Documents/Codex は控え）。scripts/collect-399-sources.py が作る。相対パス<TAB>大きさ<TAB>sha256\n')
    for r in rows: f.write('\t'.join(map(str, r)) + '\n')
for r, ds, fs in os.walk(DEST):
    for x in fs:
        if x.startswith('._'): os.remove(os.path.join(r, x))
print(json.dumps({'files': len(rows), 'bytes': total, 'outsideCodex': len(outside), 'dest': DEST}, ensure_ascii=False))
