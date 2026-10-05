"""Read-only import from the existing 399-product folders (aliases O/R/S).

Principles (from the plan):
- the source folders are never written to; files are opened read-only;
- only declared fields of documented entry points are read, and only for the
  products the owner selected (5-10 to start with);
- identifiers are never guessed: the ASIN must come from an explicit field
  and agree across files, otherwise the product goes to the hold list;
- image files are accepted only when their SHA-256 matches the ledger;
- unchanged files (size, mtime, hash) are skipped on re-import;
- text inside the files is data: nothing in it is executed or obeyed.

Because the real file formats were not visible when this was written,
``survey`` should be run first: it reports which documented files and fields
exist, without importing anything.
"""

from __future__ import annotations

import csv
import fnmatch
import hashlib
import io
import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import articles, assets as assets_mod, content as content_mod, db, imagemeta, products, timeutil
from .core import Actor, Ctx, EditorialError, record_event

ENTRY_POINTS = {
    "audit_copy": ("OP", "audit_399_current_copy.json"),
    "assignment": ("O", "399_assignment.json"),
    "assignment_csv": ("O", "399_assignment.csv"),
    "final_copy_audit": ("O", "FINAL_COPY_AUDIT_COUNTS.json"),
    "release_delivery": ("O", "RELEASE_DELIVERY.json"),
    "ledger": ("R", "promotion_completion_ledger.json"),
    "ledger_csv": ("R", "promotion_completion_ledger.csv"),
}
PRODUCTS_DIR = ("O", "master_manuscripts/products")
PARTIAL_GLOB = ("O", "operational_records", "formal_partial_image_adoptions_*.json")
PRODUCT_FILES = ("source_original.json", "manuscript.json", "generation_instructions.json",
                 "成果物ごとの必須条件.json", "reference_inventory.json")

EXPECTED_FIELDS = {
    "audit_copy": ["asin", "product", "source_url", "product_dir", "references"],
    "assignment": ["asin", "product", "final_fulltext_audit_state", "current_manuscript_revision",
                   "current_source_ready_roles", "current_source_held_roles"],
    "ledger": ["asin", "images"],
    "source_original.json": ["url", "title", "user_variant", "bullets"],
    "manuscript.json": ["description", "purchase_reason", "images", "current_revision"],
    "reference_inventory.json": ["original_path", "sha256", "bytes"],
}

MAX_SELECTION = 20


class SourceUnavailable(EditorialError):
    pass


# ---------------------------------------------------------------- file access

class Source:
    def __init__(self, ctx: Ctx):
        self.ctx = ctx
        self.roots = {k: Path(v) for k, v in ctx.config.source_roots.items()}

    def path(self, alias: str, relpath: str) -> Path:
        if alias not in self.roots:
            raise SourceUnavailable("取り込み元 %s が設定されていません" % alias)
        root = self.roots[alias]
        if not root.is_dir():
            raise SourceUnavailable("取り込み元 %s に接続できません（Macの接続やフォルダの場所を確認してください）" % alias)
        p = (root / relpath)
        resolved = p.resolve()
        if root.resolve() != resolved and root.resolve() not in resolved.parents:
            raise EditorialError("取り込み元の外を指すパスは読みません: %s/%s" % (alias, relpath))
        return p

    def exists(self, alias: str, relpath: str) -> bool:
        try:
            return self.path(alias, relpath).is_file()
        except SourceUnavailable:
            return False

    def read(self, alias: str, relpath: str) -> Tuple[bytes, os.stat_result]:
        p = self.path(alias, relpath)
        fd = os.open(str(p), os.O_RDONLY)  # read-only by construction
        try:
            st = os.fstat(fd)
            chunks = []
            while True:
                b = os.read(fd, 1 << 20)
                if not b:
                    break
                chunks.append(b)
            return b"".join(chunks), st
        finally:
            os.close(fd)

    def to_alias(self, absolute: str) -> Optional[Tuple[str, str]]:
        """Map an absolute path recorded in an inventory to (alias, relpath)."""
        if not absolute:
            return None
        p = Path(absolute)
        best = None
        for alias, root in self.roots.items():
            try:
                rel = p.relative_to(root)
            except ValueError:
                continue
            if best is None or len(str(root)) > len(str(self.roots[best[0]])):
                best = (alias, rel.as_posix())
        return best


def _load_json(data: bytes):
    return json.loads(data.decode("utf-8-sig"))


def _records(data) -> List[dict]:
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        for key in ("records", "items", "products", "rows", "data"):
            if isinstance(data.get(key), list):
                return [r for r in data[key] if isinstance(r, dict)]
        if data and all(isinstance(v, dict) for v in data.values()) and all(
                products.is_valid_asin(str(k)) for k in data.keys()):
            out = []
            for k, v in data.items():
                rec = dict(v)
                rec.setdefault("asin", k)
                out.append(rec)
            return out
    return []


def _csv_records(data: bytes) -> List[dict]:
    return list(csv.DictReader(io.StringIO(data.decode("utf-8-sig"))))


def _shape(data) -> dict:
    if isinstance(data, list):
        sample = [sorted(r.keys()) for r in data[:3] if isinstance(r, dict)]
        return {"type": "list", "count": len(data), "sample_keys": sample}
    if isinstance(data, dict):
        recs = _records(data)
        return {"type": "object", "keys": sorted(data.keys())[:40], "record_count": len(recs),
                "sample_keys": [sorted(r.keys()) for r in recs[:3]]}
    return {"type": type(data).__name__}


# ---------------------------------------------------------------- survey

def survey(ctx: Ctx, sample_products: int = 3) -> dict:
    """Read-only inventory of the documented entry points.  Imports nothing."""
    src = Source(ctx)
    report: Dict[str, object] = {"generated_at": timeutil.now_iso(), "roots": {}, "entry_points": {},
                                 "products_dir": {}, "partial_adoptions": [], "access_guide": None}
    for alias, root in src.roots.items():
        report["roots"][alias] = {"available": root.is_dir()}
    for name, (alias, rel) in ENTRY_POINTS.items():
        entry: Dict[str, object] = {"location": "%s/%s" % (alias, rel), "exists": src.exists(alias, rel)}
        if entry["exists"]:
            data, st = src.read(alias, rel)
            entry.update({"bytes": st.st_size, "sha256": hashlib.sha256(data).hexdigest()})
            try:
                parsed = _csv_records(data) if rel.endswith(".csv") else _load_json(data)
                entry["shape"] = _shape(parsed)
                recs = parsed if isinstance(parsed, list) and rel.endswith(".csv") else _records(parsed)
                key = name.replace("_csv", "")
                if key in EXPECTED_FIELDS and recs:
                    present = set().union(*[set(r.keys()) for r in recs[:50]])
                    entry["missing_fields"] = [f for f in EXPECTED_FIELDS[key] if f not in present]
                if name == "release_delivery" and isinstance(parsed, dict):
                    pointer = ((parsed.get("latest_image_quality_transfer") or {}).get("record"))
                    entry["latest_quality_record"] = pointer if isinstance(pointer, str) else None
            except (ValueError, UnicodeDecodeError) as exc:
                entry["parse_error"] = str(exc)[:200]
        report["entry_points"][name] = entry
    alias, rel = PRODUCTS_DIR
    try:
        pdir = src.path(alias, rel)
        dirs = sorted(d.name for d in pdir.iterdir() if d.is_dir()) if pdir.is_dir() else []
    except SourceUnavailable:
        dirs = []
    report["products_dir"] = {"location": "%s/%s" % PRODUCTS_DIR, "count": len(dirs),
                              "non_asin_names": [d for d in dirs if not products.is_valid_asin(d)][:20],
                              "samples": {}}
    for d in [d for d in dirs if products.is_valid_asin(d)][:sample_products]:
        files = {}
        for fname in PRODUCT_FILES:
            r = "%s/%s/%s" % (rel, d, fname)
            info: Dict[str, object] = {"exists": src.exists(alias, r)}
            if info["exists"]:
                data, st = src.read(alias, r)
                info["bytes"] = st.st_size
                try:
                    parsed = _load_json(data)
                    info["shape"] = _shape(parsed)
                    if fname in EXPECTED_FIELDS:
                        recs = _records(parsed) if not isinstance(parsed, dict) or fname == "reference_inventory.json" \
                            else [parsed]
                        present = set().union(*[set(x.keys()) for x in recs[:50]]) if recs else set()
                        info["missing_fields"] = [f for f in EXPECTED_FIELDS[fname] if f not in present]
                except (ValueError, UnicodeDecodeError) as exc:
                    info["parse_error"] = str(exc)[:200]
            files[fname] = info
        report["products_dir"]["samples"][d] = files
    a, sub, pattern = PARTIAL_GLOB
    try:
        opdir = src.path(a, sub)
        if opdir.is_dir():
            report["partial_adoptions"] = sorted(f.name for f in opdir.iterdir() if fnmatch.fnmatch(f.name, pattern))
    except SourceUnavailable:
        pass
    guide = ctx.config.access_guide
    if guide:
        report["access_guide"] = {"configured": True, "exists": guide.is_file(),
                                  "sha256": hashlib.sha256(guide.read_bytes()).hexdigest() if guide.is_file() else None}
    return report


# ---------------------------------------------------------------- import

def _track_file(ctx: Ctx, run_id: int, alias: str, rel: str, data: bytes, st, result: str,
                message: str = "") -> bool:
    """Record the file; returns True when it is unchanged since the last run."""
    sha = hashlib.sha256(data).hexdigest()
    prev = db.one(ctx.conn, "SELECT * FROM import_files WHERE root_alias = ? AND relpath = ?", (alias, rel))
    unchanged = bool(prev and prev["sha256"] == sha and prev["size"] == st.st_size)
    ctx.conn.execute(
        "INSERT INTO import_files(root_alias, relpath, size, mtime_ns, sha256, last_run_id, last_result, "
        "last_message, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(root_alias, relpath) DO UPDATE SET "
        "size=excluded.size, mtime_ns=excluded.mtime_ns, sha256=excluded.sha256, last_run_id=excluded.last_run_id, "
        "last_result=excluded.last_result, last_message=excluded.last_message, updated_at=excluded.updated_at",
        (alias, rel, st.st_size, getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)), sha, run_id,
         "unchanged" if unchanged and result == "ok" else result, message[:500], timeutil.now_iso()))
    return unchanged


def _hold(ctx: Ctx, run_id: int, entity_type: str, key: str, reason: str, detail: str = "") -> None:
    exists = db.one(ctx.conn, "SELECT id FROM holds WHERE entity_type = ? AND entity_key = ? AND reason = ? "
                    "AND resolved_at IS NULL", (entity_type, key, reason))
    if exists:
        return
    db.insert(ctx.conn, "holds", {"entity_type": entity_type, "entity_key": key, "reason": reason,
                                  "detail": detail[:1000], "run_id": run_id, "created_at": timeutil.now_iso()})


def _source_record(ctx: Ctx, product_id: int, kind: str, origin: str, alias: str, rel: str, data: bytes,
                   fields: dict) -> bool:
    sha = hashlib.sha256(data).hexdigest()
    if db.one(ctx.conn, "SELECT id FROM source_records WHERE product_id = ? AND kind = ? AND relpath = ? AND sha256 = ?",
              (product_id, kind, rel, sha)):
        return False
    ctx.conn.execute("UPDATE source_records SET current = 0 WHERE product_id = ? AND kind = ?", (product_id, kind))
    db.insert(ctx.conn, "source_records", {
        "product_id": product_id, "kind": kind, "origin": origin, "root_alias": alias, "relpath": rel,
        "sha256": sha, "data_json": db.dumps(fields), "imported_at": timeutil.now_iso(), "current": 1})
    return True


def _pick(rec: dict, keys) -> dict:
    return {k: rec.get(k) for k in keys if k in rec}


def _load_index(src: Source, ctx: Ctx, run_id: int, name: str, csv_name: Optional[str] = None) -> Optional[List[dict]]:
    alias, rel = ENTRY_POINTS[name]
    if src.exists(alias, rel):
        data, st = src.read(alias, rel)
        _track_file(ctx, run_id, alias, rel, data, st, "ok")
        return _records(_load_json(data))
    if csv_name:
        alias, rel = ENTRY_POINTS[csv_name]
        if src.exists(alias, rel):
            data, st = src.read(alias, rel)
            _track_file(ctx, run_id, alias, rel, data, st, "ok")
            return _csv_records(data)
    return None


def import_products(ctx: Ctx, actor: Actor, asins: List[str], allow_many: bool = False) -> dict:
    asins = [a.strip().upper() for a in asins if a.strip()]
    if not asins:
        raise EditorialError("取り込む商品のASINを指定してください")
    if len(asins) > MAX_SELECTION and not allow_many:
        raise EditorialError("最初は5〜10商品で一巡させる方針です（指定 %d 件）。" % len(asins))
    bad = [a for a in asins if not products.is_valid_asin(a)]
    if bad:
        raise EditorialError("ASINの形式ではない指定があります: %s" % ", ".join(bad))
    src = Source(ctx)
    for alias in ("O", "R"):
        if alias not in src.roots or not src.roots[alias].is_dir():
            raise SourceUnavailable("取り込み元 %s に接続できません。何も変更していません。" % alias)

    run_id = db.insert(ctx.conn, "import_runs", {"mode": "import", "started_at": timeutil.now_iso(),
                                                 "selection_json": db.dumps(asins)})
    summary = {"products": {}, "holds": 0, "assets_added": 0, "records_added": 0, "unchanged_files": 0}
    try:
        assignment = _load_index(src, ctx, run_id, "assignment", "assignment_csv")
        if assignment is None:
            raise SourceUnavailable("現況ファイル（399_assignment.json/.csv）が見つかりません")
        audit = _load_index(src, ctx, run_id, "audit_copy") or []
        ledger = _load_index(src, ctx, run_id, "ledger", "ledger_csv") or []
        qa_doc = None
        a_alias, a_rel = ENTRY_POINTS["final_copy_audit"]
        if src.exists(a_alias, a_rel):
            data, st = src.read(a_alias, a_rel)
            _track_file(ctx, run_id, a_alias, a_rel, data, st, "ok")
            qa_doc = _load_json(data)
        quality_rows = _quality_rows(ctx, src, run_id)
        for asin in asins:
            try:
                with db.tx(ctx.conn):
                    summary["products"][asin] = _import_one(ctx, actor, src, run_id, asin, assignment, audit,
                                                            ledger, qa_doc, quality_rows, summary)
            except (EditorialError, ValueError, KeyError, TypeError, OSError) as exc:
                # One malformed product must not stop the others; nothing of it was kept.
                _hold(ctx, run_id, "product", asin, "取り込み中に形式の問題がありました", str(exc)[:300])
                summary["products"][asin] = {"status": "held", "notes": [str(exc)[:200]]}
        summary["holds"] = db.scalar(ctx.conn, "SELECT COUNT(*) FROM holds WHERE run_id = ?", (run_id,))
        status = "succeeded"
    except Exception as exc:
        status = "failed"
        summary["error"] = str(exc)
        raise
    finally:
        db.update(ctx.conn, "import_runs", "id", run_id, {
            "finished_at": timeutil.now_iso(), "status": status, "summary_json": db.dumps(summary)})
        record_event(ctx, actor, "import", run_id, "import_" + status,
                     {"asins": asins, "holds": summary.get("holds"), "assets_added": summary["assets_added"]})
    return summary


def _quality_rows(ctx: Ctx, src: Source, run_id: int) -> List[dict]:
    alias, rel = ENTRY_POINTS["release_delivery"]
    if not src.exists(alias, rel):
        return []
    data, st = src.read(alias, rel)
    _track_file(ctx, run_id, alias, rel, data, st, "ok")
    doc = _load_json(data)
    pointer = ((doc.get("latest_image_quality_transfer") or {}).get("record")) if isinstance(doc, dict) else None
    if not isinstance(pointer, str) or not pointer:
        return []
    mapped = src.to_alias(pointer) if os.path.isabs(pointer) else ("O", pointer)
    if not mapped or not src.exists(*mapped):
        _hold(ctx, run_id, "file", pointer if not os.path.isabs(pointer) else "(品質報告)",
              "最新の品質報告が見つかりません", "RELEASE_DELIVERY.json の指す報告を読めませんでした")
        return []
    data, st = src.read(*mapped)
    _track_file(ctx, run_id, mapped[0], mapped[1], data, st, "ok")
    report = _load_json(data)
    rows = report.get("rows") if isinstance(report, dict) else None
    return [r for r in rows or [] if isinstance(r, dict)]


def _find(records: List[dict], asin: str) -> List[dict]:
    return [r for r in records if str(r.get("asin") or "").strip().upper() == asin]


def _import_one(ctx: Ctx, actor: Actor, src: Source, run_id: int, asin: str, assignment: List[dict],
                audit: List[dict], ledger: List[dict], qa_doc, quality_rows: List[dict], summary: dict) -> dict:
    result = {"status": "ok", "notes": []}
    rows = _find(assignment, asin)
    if len(rows) != 1:
        _hold(ctx, run_id, "product", asin, "現況ファイルで商品を特定できません",
              "399_assignment に該当 %d 件" % len(rows))
        result["status"] = "held"
        return result
    row = rows[0]
    name = str(row.get("product") or "").strip()
    problems: List[str] = []
    if not name:
        problems.append("商品名（product）が空です")
    audit_rows = _find(audit, asin)
    source_url = None
    if len(audit_rows) == 1:
        source_url = audit_rows[0].get("source_url")
        url_asin = products.asin_from_amazon_url(source_url)
        if source_url and url_asin and url_asin != asin:
            problems.append("source_url のASIN（%s）が一致しません" % url_asin)
        if audit_rows[0].get("product") and name and str(audit_rows[0]["product"]).strip() != name:
            result["notes"].append("商品名が監査コピーと異なります")
    elif len(audit_rows) > 1:
        problems.append("監査コピーに同じASINが複数あります")

    product = products.find_by_asin(ctx, asin)
    if product is None:
        pid = products.create(ctx, actor, name or asin, asin=asin, source_url=source_url,
                              legacy_id=str(row.get("id") or row.get("product_id") or "") or None,
                              status="held" if problems else "active",
                              hold_reason="; ".join(problems) or None)
    else:
        pid = product["id"]
    for p in problems:
        _hold(ctx, run_id, "product", asin, p)
    if problems:
        result["status"] = "held"
    result["product_id"] = pid

    if _source_record(ctx, pid, "assignment", "own", *ENTRY_POINTS["assignment"], data=db.dumps(row).encode(),
                      fields=_pick(row, EXPECTED_FIELDS["assignment"])):
        summary["records_added"] += 1

    base_rel = "%s/%s" % (PRODUCTS_DIR[1], asin)
    alias = PRODUCTS_DIR[0]
    manuscript_rev = None
    # source_original.json: copied from Amazon pages → origin "amazon" (never published, never sent to AI)
    rel = base_rel + "/source_original.json"
    if src.exists(alias, rel):
        data, st = src.read(alias, rel)
        unchanged = _track_file(ctx, run_id, alias, rel, data, st, "ok")
        summary["unchanged_files"] += int(unchanged)
        doc = _load_json(data)
        if isinstance(doc, dict):
            url_asin = products.asin_from_amazon_url(doc.get("url"))
            if url_asin and url_asin != asin:
                _hold(ctx, run_id, "product", asin, "source_original のURLのASINが一致しません", url_asin)
                result["status"] = "held"
            if _source_record(ctx, pid, "source_original", "amazon", alias, rel, data,
                              _pick(doc, EXPECTED_FIELDS["source_original.json"])):
                summary["records_added"] += 1
        else:
            _hold(ctx, run_id, "file", "%s/%s" % (alias, rel), "形式が想定と違います（オブジェクトではない）")
    else:
        result["notes"].append("source_original.json がありません")

    rel = base_rel + "/manuscript.json"
    if src.exists(alias, rel):
        data, st = src.read(alias, rel)
        summary["unchanged_files"] += int(_track_file(ctx, run_id, alias, rel, data, st, "ok"))
        doc = _load_json(data)
        if isinstance(doc, dict):
            manuscript_rev = doc.get("current_revision")
            expected_rev = row.get("current_manuscript_revision")
            if expected_rev not in (None, "") and str(manuscript_rev) != str(expected_rev):
                _hold(ctx, run_id, "product", asin, "原稿の版が現況ファイルと一致しません",
                      "manuscript=%s / assignment=%s" % (manuscript_rev, expected_rev))
                result["status"] = "held"
            # Origin is unknown until the owner confirms the text is their own.
            if _source_record(ctx, pid, "manuscript", "unknown", alias, rel, data,
                              _pick(doc, EXPECTED_FIELDS["manuscript.json"])):
                summary["records_added"] += 1
        else:
            _hold(ctx, run_id, "file", "%s/%s" % (alias, rel), "形式が想定と違います（オブジェクトではない）")
    else:
        _hold(ctx, run_id, "product", asin, "manuscript.json がありません")
        result["status"] = "held"

    for fname in ("generation_instructions.json", "成果物ごとの必須条件.json"):
        rel = "%s/%s" % (base_rel, fname)
        if src.exists(alias, rel):
            data, st = src.read(alias, rel)
            summary["unchanged_files"] += int(_track_file(ctx, run_id, alias, rel, data, st, "ok"))

    if isinstance(qa_doc, dict):
        qa = ((qa_doc.get("qualified_products") or {}).get(asin)) if isinstance(qa_doc.get("qualified_products"), dict) else None
        if isinstance(qa, dict):
            info = _pick(qa, ("QA", "QA_sha256", "revision"))
            if manuscript_rev is not None and qa.get("revision") is not None and str(qa["revision"]) != str(manuscript_rev):
                info["note"] = "監査版と現行原稿の版が一致しません（監査合格を現行原稿に適用しない）"
                result["notes"].append(info["note"])
            if _source_record(ctx, pid, "qa", "own", *ENTRY_POINTS["final_copy_audit"],
                              data=db.dumps(info).encode(), fields=info):
                summary["records_added"] += 1

    _import_references(ctx, actor, src, run_id, pid, asin, base_rel, summary, result)
    _import_ledger_images(ctx, actor, src, run_id, pid, asin, ledger, quality_rows, summary, result)

    if not products.articles_for_product(ctx, pid):
        initial = content_mod.empty("product")
        initial["title"] = name or asin
        articles.create(ctx, actor, "product", "item-%s" % asin.lower(), [pid], initial_content=initial,
                        author_kind="import", note="取り込み時に空の下書きを作成")
    return result


def _import_references(ctx, actor, src, run_id, pid, asin, base_rel, summary, result) -> None:
    alias = PRODUCTS_DIR[0]
    for rel in ("%s/reference_inventory.json" % base_rel, "reference_inventory.json"):
        if not src.exists(alias, rel):
            continue
        data, st = src.read(alias, rel)
        summary["unchanged_files"] += int(_track_file(ctx, run_id, alias, rel, data, st, "ok"))
        doc = _load_json(data)
        entries = _records(doc) if not isinstance(doc, dict) or "original_path" not in doc else [doc]
        if rel == "reference_inventory.json":
            entries = [e for e in entries if str(e.get("asin") or "").upper() == asin]
        for e in entries:
            path, sha, size = e.get("original_path"), str(e.get("sha256") or "").lower(), e.get("bytes")
            mapped = src.to_alias(str(path)) if path else None
            if not mapped:
                _hold(ctx, run_id, "asset", "%s:%s" % (asin, sha[:12]), "参照写真の場所が取り込み元の外です")
                continue
            if not src.exists(*mapped):
                _hold(ctx, run_id, "asset", "%s:%s" % (asin, sha[:12]), "参照写真が見つかりません", mapped[1])
                continue
            fdata, fst = src.read(*mapped)
            if hashlib.sha256(fdata).hexdigest() != sha or (size is not None and int(size) != fst.st_size):
                _hold(ctx, run_id, "asset", "%s:%s" % (asin, sha[:12]), "参照写真のハッシュまたはサイズが一致しません",
                      mapped[1])
                continue
            _track_file(ctx, run_id, mapped[0], mapped[1], fdata, fst, "ok")
            before = db.scalar(ctx.conn, "SELECT COUNT(*) FROM assets")
            aid = assets_mod.create(ctx, actor, pid, "reference_photo", None, root_alias=mapped[0],
                                    relpath=mapped[1], sha256=sha, title=Path(mapped[1]).name,
                                    upstream_state="reference_inventory")
            if db.scalar(ctx.conn, "SELECT COUNT(*) FROM assets") > before:
                w, h = imagemeta.dimensions(fdata)
                db.update(ctx.conn, "assets", "id", aid, {"bytes": fst.st_size, "mime": imagemeta.sniff(fdata),
                                                          "width": w, "height": h})
                summary["assets_added"] += 1
        break


def _import_ledger_images(ctx, actor, src, run_id, pid, asin, ledger, quality_rows, summary, result) -> None:
    quality_by_sha = {}
    for r in quality_rows:
        sha = str(r.get("new_output_sha256") or "").lower()
        if sha:
            quality_by_sha[sha] = r
    for rec in _find(ledger, asin):
        images = rec.get("images")
        if not isinstance(images, list):
            _hold(ctx, run_id, "product", asin, "台帳の images が配列ではありません")
            continue
        for img in images:
            if not isinstance(img, dict):
                continue
            file_ref, sha, state = img.get("file"), str(img.get("sha256") or "").lower(), img.get("state")
            if not file_ref or len(sha) != 64:
                _hold(ctx, run_id, "asset", "%s:%s" % (asin, file_ref), "台帳の画像にファイルまたはハッシュがありません")
                continue
            mapped = src.to_alias(str(file_ref)) if os.path.isabs(str(file_ref)) else ("R", str(file_ref))
            if not mapped or not src.exists(*mapped):
                _hold(ctx, run_id, "asset", "%s:%s" % (asin, sha[:12]), "台帳の画像ファイルが見つかりません",
                      str(file_ref) if not os.path.isabs(str(file_ref)) else "")
                continue
            data, st = src.read(*mapped)
            if hashlib.sha256(data).hexdigest() != sha:
                _hold(ctx, run_id, "asset", "%s:%s" % (asin, sha[:12]), "台帳のハッシュと画像ファイルが一致しません",
                      mapped[1])
                continue
            if imagemeta.sniff(data) is None:
                _hold(ctx, run_id, "asset", "%s:%s" % (asin, sha[:12]), "画像として読めません", mapped[1])
                continue
            _track_file(ctx, run_id, mapped[0], mapped[1], data, st, "ok")
            flags = {k: rec.get(k) for k in ("parent_new_complete", "current_partial_set",
                                             "formal_parent_scoped_adoption") if k in rec}
            upstream = "ledger:%s %s" % (state, json.dumps(flags, ensure_ascii=False) if flags else "")
            before = db.scalar(ctx.conn, "SELECT COUNT(*) FROM assets")
            aid = assets_mod.create(ctx, actor, pid, "generated", data, root_alias=mapped[0], relpath=mapped[1],
                                    title=Path(mapped[1]).name, upstream_state=upstream.strip())
            if db.scalar(ctx.conn, "SELECT COUNT(*) FROM assets") > before:
                summary["assets_added"] += 1
                q = quality_by_sha.get(sha)
                if q:
                    note = "上流の品質判定: %s（原稿版 %s）" % (q.get("new_local_quality_verdict"), q.get("manuscript_version"))
                    db.update(ctx.conn, "assets", "id", aid, {"quality_note": note})


def holds(ctx: Ctx, include_resolved: bool = False) -> List:
    sql = "SELECT * FROM holds"
    if not include_resolved:
        sql += " WHERE resolved_at IS NULL"
    return db.all_rows(ctx.conn, sql + " ORDER BY id DESC")


def resolve_hold(ctx: Ctx, actor: Actor, hold_id: int, note: str = "") -> None:
    row = db.one(ctx.conn, "SELECT * FROM holds WHERE id = ?", (hold_id,))
    if row is None:
        raise EditorialError("保留が見つかりません")
    with db.tx(ctx.conn):
        db.update(ctx.conn, "holds", "id", hold_id, {"resolved_at": timeutil.now_iso()})
        record_event(ctx, actor, "hold", hold_id, "resolved", {"note": note})
