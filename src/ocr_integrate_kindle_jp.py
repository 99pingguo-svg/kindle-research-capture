#!/usr/bin/env python3
"""OCR and integrate image-only Japanese Kindle pages.

Input folder must contain:
- pages.jsonl          AX text pages with "step"
- images/page_XXXXX.png image-only pages

Outputs:
- ocr_pages.jsonl      OCR results with method/confidence proxy
- ALL_TEXT_MERGED.txt  ordered AX/OCR text with source markers
- merged_pages.jsonl   ordered research blocks
"""
import argparse, json, re, subprocess
from pathlib import Path

JP_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")

def load_jsonl(path):
    rows=[]
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip(): continue
            try: rows.append(json.loads(line))
            except Exception: pass
    return rows

def score_text(s):
    s=s.strip()
    if not s: return -999
    jp=len(JP_RE.findall(s))
    bad=s.count("�")+s.count("|")+s.count("_")
    # Prefer substantial Japanese; penalize obvious UI/OCR garbage.
    return jp*4 + min(len(s),5000)*0.08 - bad*4

def run_ocr(img, lang, psm):
    cp=subprocess.run(
        ["tesseract",str(img),"stdout","-l",lang,"--psm",str(psm)],
        capture_output=True,text=True)
    return cp.stdout.strip(), cp.returncode

def clean_ocr(s):
    lines=[]
    for line in s.splitlines():
        t=line.strip()
        if not t: continue
        # Remove recurring obvious Kindle/window UI only if isolated.
        if t in {"Kindle","Aa","目次","検索"}: continue
        lines.append(t)
    return "\n".join(lines).strip()
def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--folder",required=True)
    args=ap.parse_args()
    root=Path(args.folder)
    pages=load_jsonl(root/"pages.jsonl")
    events=load_jsonl(root/"events.jsonl")
    final_steps=[]
    for e in events:
        loc=e.get("location")
        step=e.get("step")
        if isinstance(loc,str) and step is not None:
            m=re.search(r"(\d+)ページ中の(\d+)ページ目",loc)
            if m and int(m.group(1))==int(m.group(2)):
                final_steps.append(int(step))
    cutoff=min(final_steps) if final_steps else None
    ax_by_step={int(r["step"]):r for r in pages
                if "step" in r and (cutoff is None or int(r["step"])<=cutoff)}
    imgs=sorted((root/"images").glob("page_*.png"))

    old=load_jsonl(root/"ocr_pages.jsonl")
    done={int(r["step"]):r for r in old if "step" in r}
    out=list(old)

    for img in imgs:
        m=re.search(r"page_(\d+)\.png$",img.name)
        if not m: continue
        step=int(m.group(1))
        if cutoff is not None and step > cutoff:
            continue
        if step in ax_by_step or step in done:
            continue
        candidates=[]
        for lang,psm in [("jpn_vert",5),("jpn",6),("jpn",3)]:
            text,rc=run_ocr(img,lang,psm)
            text=clean_ocr(text)
            candidates.append({
                "lang":lang,"psm":psm,"returncode":rc,
                "score":score_text(text),"text":text
            })
        best=max(candidates,key=lambda x:x["score"])
        row={
            "step":step,"image":img.name,"source_type":"OCR画像本文",
            "method":f'{best["lang"]}/psm{best["psm"]}',
            "score":best["score"],"characters":len(best["text"]),
            "text":best["text"],
            "alternatives":[
                {"method":f'{c["lang"]}/psm{c["psm"]}',
                 "score":c["score"],"characters":len(c["text"])}
                for c in candidates
            ]
        }
        out.append(row)
        done[step]=row

    out=sorted({int(r["step"]):r for r in out}.values(),key=lambda r:int(r["step"]))
    with (root/"ocr_pages.jsonl").open("w",encoding="utf-8") as f:
        for r in out:
            f.write(json.dumps(r,ensure_ascii=False)+"\n")
    all_steps=set(ax_by_step)|{int(r["step"]) for r in out}
    merged=[]
    for step in sorted(all_steps):
        if step in ax_by_step:
            r=dict(ax_by_step[step])
            r["source_type"]="AX本文"
            merged.append(r)
        else:
            r=done.get(step)
            if r and r.get("text"):
                merged.append({
                    "step":step,"source_type":"OCR画像本文",
                    "image":r.get("image"),"ocr_method":r.get("method"),
                    "characters":len(r.get("text","")),"text":r.get("text","")
                })

    with (root/"merged_pages.jsonl").open("w",encoding="utf-8") as f:
        for r in merged:
            f.write(json.dumps(r,ensure_ascii=False)+"\n")

    parts=[]
    for r in merged:
        parts.append(f'\n## PAGE_STEP {r["step"]} [{r["source_type"]}]\n')
        parts.append(r.get("text",""))
    (root/"ALL_TEXT_MERGED.txt").write_text("\n".join(parts).strip()+"\n",encoding="utf-8")

    summary={
        "ax_pages":len(ax_by_step),
        "ocr_pages":sum(1 for r in merged if r["source_type"]=="OCR画像本文"),
        "merged_pages":len(merged),
        "ocr_candidates":len(out),
        "final_step_cutoff":cutoff
    }
    (root/"ocr_summary.json").write_text(
        json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False))

if __name__=="__main__":
    main()
