#!/usr/bin/env python3
"""相場の候補が「同じ商品 / 似た商品 / 別物」かをローカルAI（Mac 上・無料）で判定するワーカー。

入力 JSONL（1行1件）: {"key", "product_title", "product_image", "cand_title", "cand_price", "cand_image"}
出力 JSONL: {"key", "label": "same|similar|different", "reason", "ms", "model"}

使い方:
  python3 scripts/local_judge.py --backend ollama:qwen3.5:4b --in tasks.jsonl --out results.jsonl
  /Volumes/MacAI/projects/argon-inspector/.venv/bin/python scripts/local_judge.py --backend lfm3 --in … --out …
外部には何も送らない（Ollama は 127.0.0.1、LFM3 は外付けSSDの重みを読むだけ）。途中で止めても out に追記済みの分は飛ばして再開する。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

PROMPT = """You compare a TARGET product with a SOLD listing from a Japanese flea market / auction site.
Image 1 = TARGET (official product photo). Image 2 = SOLD listing photo.
TARGET title: {pt}
SOLD title: {ct}
SOLD price: {cp} yen

Answer with one label:
- "same": the identical product (same item/model/design; same set size). Colour variants of the same model also count as same.
- "similar": a different brand/model but the same kind of product for the same use, so its price is a fair reference.
- "different": another kind of product, only a part/accessory of it, a bundle with other things, or a much bigger/smaller set.
Return JSON only: {{"label": "same|similar|different", "reason": "<10 words>"}}"""

LABELS = ("same", "similar", "different")


def parse(text: str) -> tuple[str, str]:
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            d = json.loads(m.group(0))
            lab = str(d.get("label", "")).strip().lower()
            if lab in LABELS:
                return lab, str(d.get("reason", ""))[:120]
        except json.JSONDecodeError:
            pass
    for lab in LABELS:
        if re.search(rf"\b{lab}\b", text.lower()):
            return lab, text.strip()[:120]
    return "different", "unparsed: " + text.strip()[:100]


class Ollama:
    def __init__(self, model: str):
        self.model = model

    def __call__(self, prompt: str, images: list[str]) -> str:
        body = {
            "model": self.model, "prompt": prompt, "stream": False, "think": False, "format": "json",
            "images": [base64.b64encode(Path(p).read_bytes()).decode() for p in images],
            "options": {"temperature": 0, "num_ctx": 4096}, "keep_alive": "10m",
        }
        req = urllib.request.Request("http://127.0.0.1:11434/api/generate", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read())["response"]


class LFM3:
    """LiquidAI/LFM3-VL-2B from the external SSD's Hugging Face cache (no download)."""

    def __init__(self):
        os.environ.setdefault("HF_HOME", "/Volumes/MacAI/huggingface")
        os.environ["HF_HUB_OFFLINE"] = "1"
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor
        from PIL import Image

        self.torch, self.Image = torch, Image
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        mid = "LiquidAI/LFM3-VL-2B"
        cache = "/Volumes/MacAI/huggingface/hub"
        self.proc = AutoProcessor.from_pretrained(mid, trust_remote_code=True, cache_dir=cache, local_files_only=True)
        self.model = AutoModelForImageTextToText.from_pretrained(mid, dtype=torch.bfloat16 if dev == "mps" else torch.float32, trust_remote_code=True, cache_dir=cache, local_files_only=True).to(dev).eval()
        self.dev = dev

    def __call__(self, prompt: str, images: list[str]) -> str:
        content = [{"type": "image", "image": self.Image.open(p).convert("RGB")} for p in images] + [{"type": "text", "text": prompt}]
        # Answer directly (LFM3 otherwise writes its reasoning first and runs out of tokens).
        inputs = self.proc.apply_chat_template([{"role": "user", "content": content}], add_generation_prompt=True, tokenize=True, return_dict=True, return_tensors="pt", enable_thinking=False).to(self.dev)
        with self.torch.inference_mode():
            out = self.model.generate(**inputs, do_sample=False, max_new_tokens=80)
        return self.proc.batch_decode(out[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, help="ollama:<model> または lfm3")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    run = LFM3() if a.backend == "lfm3" else Ollama(a.backend.split(":", 1)[1])
    done = set()
    if Path(a.out).exists():
        done = {json.loads(l)["key"] for l in Path(a.out).read_text().splitlines() if l.strip()}
    tasks = [json.loads(l) for l in Path(a.inp).read_text().splitlines() if l.strip()]
    tasks = [t for t in tasks if t["key"] not in done]
    if a.limit:
        tasks = tasks[: a.limit]
    with open(a.out, "a") as f:
        for i, t in enumerate(tasks, 1):
            prompt = PROMPT.format(pt=t["product_title"][:160], ct=t["cand_title"][:160], cp=t.get("cand_price", "?"))
            t0 = time.time()
            try:
                text = run(prompt, [t["product_image"], t["cand_image"]])
                lab, why = parse(text)
            except Exception as e:  # keep going; the key is retried on the next run
                print(f"{t['key']} error {e}", file=sys.stderr)
                continue
            f.write(json.dumps({"key": t["key"], "label": lab, "reason": why, "ms": int((time.time() - t0) * 1000), "model": a.backend}, ensure_ascii=False) + "\n")
            f.flush()
            if i % 20 == 0:
                print(f"{i}/{len(tasks)}", file=sys.stderr)


if __name__ == "__main__":
    main()
