#!/usr/bin/env python3
"""Kindle Japanese vertical book capture via Accessibility.

- No DRM removal; reads only text exposed by the Kindle UI.
- RTL Japanese books: left arrow advances.
- Stores one logical page per JSONL row.
- If AX text disappears with hidden toolbar, clicks center once and retries.
- Image-only pages are saved as screenshots.
"""
import argparse, hashlib, json, os, subprocess, time, tempfile, shutil, re
from pathlib import Path
from datetime import datetime, timezone

import ApplicationServices as AS
import AppKit
import Quartz

def now():
    return datetime.now(timezone.utc).isoformat()

def attr(el, name):
    try:
        err, val = AS.AXUIElementCopyAttributeValue(el, name, None)
        return val if err == 0 else None
    except Exception:
        return None

def kindle_pid():
    for a in AppKit.NSWorkspace.sharedWorkspace().runningApplications():
        if (a.bundleIdentifier() or "") == "com.amazon.Lassen":
            return a.processIdentifier()
    return None

def window_info(pid):
    best = None
    for w in Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID) or []:
        if w.get("kCGWindowOwnerPID") != pid or w.get("kCGWindowLayer") != 0:
            continue
        b = w.get("kCGWindowBounds") or {}
        area = float(b.get("Width",0))*float(b.get("Height",0))
        if best is None or area > best[2]:
            best = (int(w.get("kCGWindowNumber")), b, area)
    return (best[0], best[1]) if best else (None, None)
def walk(el, out, depth=0):
    if el is None or depth > 25:
        return
    role = attr(el, "AXRole")
    ident = attr(el, "AXIdentifier")
    desc = attr(el, "AXDescription")
    val = attr(el, "AXValue")
    title = attr(el, "AXTitle")
    out.append((el, role, ident, desc, val, title))
    for c in attr(el, "AXChildren") or []:
        walk(c, out, depth+1)

def snapshot(pid):
    root = AS.AXUIElementCreateApplication(pid)
    nodes = []
    walk(root, nodes)
    reader = [n for n in nodes if n[2] == "ReaderView"]
    scope = []
    if reader:
        walk(reader[0][0], scope)
    else:
        scope = nodes

    texts = []
    for _el, role, ident, desc, val, title in scope:
        for s in (val, title, desc):
            if isinstance(s, str) and s.strip():
                texts.append((role, ident, s.strip()))
                break

    # Kindle exposes normal Japanese pages as one large AXGenericElement.
    candidates = [t for role, ident, t in texts if role == "AXGenericElement" and len(t) >= 80]
    if not candidates:
        # Some pages expose the main text as StaticText; take long non-UI elements only.
        candidates = [t for role, ident, t in texts
                      if role in ("AXStaticText","AXTextArea") and len(t) >= 120]
    main = max(candidates, key=len, default="")
    heading = next(
        (desc or val or title for _el, role, ident, desc, val, title in nodes
         if role == "AXHeading" and isinstance(desc or val or title, str)),
        None)
    toolbar = any((desc == "本を閉じる" or ident == "本を閉じる")
                  for _el, role, ident, desc, val, title in nodes)
    loc = next(
        (desc or val or title for _el, role, ident, desc, val, title in nodes
         if ident == "PageLocationText" and isinstance(desc or val or title, str)),
        None)
    return main, heading, toolbar, loc, texts

def click_point(pid, bounds, rx=.5, ry=.5):
    x = float(bounds["X"]) + float(bounds["Width"]) * rx
    y = float(bounds["Y"]) + float(bounds["Height"]) * ry
    for kind in (Quartz.kCGEventMouseMoved,
                 Quartz.kCGEventLeftMouseDown,
                 Quartz.kCGEventLeftMouseUp):
        ev = Quartz.CGEventCreateMouseEvent(None, kind, Quartz.CGPointMake(x,y),
                                            Quartz.kCGMouseButtonLeft)
        Quartz.CGEventSetFlags(ev, 0)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
        time.sleep(.05)

def click_center(pid, bounds):
    click_point(pid, bounds, .5, .5)

def click_next_rtl(pid, bounds):
    # Japanese vertical Kindle: left side advances to next page.
    click_point(pid, bounds, .12, .5)

def send_left(pid):
    # Empirically reliable on Japanese vertical Kindle Mac: PageDown posted to Kindle PID.
    # The displayed print-page number may jump by >1 because one viewport spans
    # multiple print-reference pages; this is still the next reading viewport.
    for down in (True, False):
        ev = Quartz.CGEventCreateKeyboardEvent(None, 121, down)  # PageDown
        Quartz.CGEventSetFlags(ev, 0)
        Quartz.CGEventPostToPid(pid, ev)

def shot(wid, path):
    r = subprocess.run(["/usr/sbin/screencapture","-x","-o",f"-l{wid}",str(path)],
                       capture_output=True)
    return r.returncode == 0 and path.exists() and path.stat().st_size > 1000


def page_fingerprint(wid, grid=32):
    """Central-page visual fingerprint, ignoring toolbar/borders as much as possible."""
    if wid is None:
        return None
    tmpdir=Path(tempfile.mkdtemp())
    p=tmpdir/"fp.png"
    try:
        if not shot(wid,p):
            return None
        try:
            import pymupdf
            pm=pymupdf.Pixmap(str(p))
            if pm.alpha:
                pm=pymupdf.Pixmap(pm,0)
            g=pymupdf.Pixmap(pymupdf.csGRAY,pm)
            data=g.samples; w,h=g.width,g.height
            if not data or w<20 or h<20:
                return None
            # Sample central page region: drop toolbar/top chrome and outer margins.
            x0,x1=int(w*.12),int(w*.88)
            y0,y1=int(h*.16),int(h*.88)
            cells=[]
            for gy in range(grid):
                for gx in range(grid):
                    x=x0+int(gx*max(1,x1-x0-1)/grid)
                    y=y0+int(gy*max(1,y1-y0-1)/grid)
                    cells.append(data[y*w+x])
            avg=sum(cells)/len(cells)
            bits=bytes(1 if c>avg else 0 for c in cells)
            return hashlib.sha256(bits).hexdigest()
        except Exception:
            return hashlib.sha256(p.read_bytes()).hexdigest()
    finally:
        shutil.rmtree(tmpdir,ignore_errors=True)
def ensure_text(pid, bounds):
    main, heading, toolbar, loc, texts = snapshot(pid)
    if main:
        return main, heading, toolbar, loc
    # Hidden toolbar can also hide ReaderView text in Kindle.
    if not toolbar and bounds:
        click_center(pid, bounds)
        time.sleep(.65)
        main, heading, toolbar, loc, texts = snapshot(pid)
    return main, heading, toolbar, loc

def page_number(location):
    if not isinstance(location, str):
        return None
    m = re.search(r"(\d+)ページ中の(\d+)ページ目", location)
    return int(m.group(2)) if m else None

def exact_final_page(location):
    if not isinstance(location, str):
        return False
    m=re.search(r"(\d+)ページ中の(\d+)ページ目", location)
    return bool(m and int(m.group(1)) == int(m.group(2)))

def acquire_output_lock(out):
    lock=out/".capture.lock"
    try:
        lock.mkdir()
    except FileExistsError:
        pidfile=lock/"pid"
        old=None
        try: old=int(pidfile.read_text().strip())
        except Exception: pass
        if old:
            try:
                os.kill(old,0)
                raise SystemExit(f"capture already running for {out} (pid {old})")
            except ProcessLookupError:
                pass
        shutil.rmtree(lock,ignore_errors=True)
        lock.mkdir()
    (lock/"pid").write_text(str(os.getpid()))
    return lock

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--max-pages", type=int, default=800)
    ap.add_argument("--timeout", type=float, default=7.0)
    ap.add_argument("--settle", type=float, default=.45)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out/"images").mkdir(exist_ok=True)
    lock = acquire_output_lock(out)
    pages_path = out/"pages.jsonl"
    events_path = out/"events.jsonl"

    pid = kindle_pid()
    if not pid:
        raise SystemExit("Kindle not running")
    # HID events require the reader to be the active target. Activate only for this task.
    for app in AppKit.NSWorkspace.sharedWorkspace().runningApplications():
        if app.processIdentifier() == pid:
            app.activateWithOptions_(AppKit.NSApplicationActivateIgnoringOtherApps)
            time.sleep(.35)
            break
    wid, bounds = window_info(pid)
    if wid is None:
        raise SystemExit("Kindle window not found")

    seen_text = set()
    if pages_path.exists():
        for line in pages_path.read_text(encoding="utf-8").splitlines():
            try:
                row=json.loads(line)
                if row.get("sha256"): seen_text.add(row["sha256"])
            except Exception: pass

    def log(kind, **data):
        row={"ts":now(),"kind":kind,**data}
        with events_path.open("a",encoding="utf-8") as f:
            f.write(json.dumps(row,ensure_ascii=False)+"\n")

    main_text, heading, toolbar, loc = ensure_text(pid, bounds)
    log("start", title=args.title, pid=pid, window=wid,
        heading=heading, location=loc, initial_chars=len(main_text))

    previous = None
    previous_loc = None
    previous_hash = None
    stable_end = 0
    last_page_number = None
    for step in range(args.max_pages):
        main_text, heading, toolbar, loc = ensure_text(pid, bounds)
        current_hash = hashlib.sha256(main_text.encode()).hexdigest() if main_text else None
        stale_ax = bool(main_text and previous_hash == current_hash and previous_loc and loc and previous_loc != loc)
        if stale_ax:
            # Kindle moved but Accessibility text did not refresh: preserve rendered page for OCR.
            p=out/"images"/f"page_{step:05d}.png"
            if shot(wid,p):
                log("stale_ax_image_page", step=step, file=p.name, location=loc)
        elif main_text:
            h=hashlib.sha256(main_text.encode()).hexdigest()
            if h not in seen_text:
                row={"seq":len(seen_text)+1,"step":step,"ts":now(),"title":args.title,
                     "heading":heading,"location":loc,"characters":len(main_text),
                     "sha256":h,"source_type":"AX本文","text":main_text}
                with pages_path.open("a",encoding="utf-8") as f:
                    f.write(json.dumps(row,ensure_ascii=False)+"\n")
                seen_text.add(h)
                log("text_page", step=step, chars=len(main_text), location=loc)
        else:
            p=out/"images"/f"page_{step:05d}.png"
            if shot(wid,p):
                log("image_page", step=step, file=p.name, location=loc)

        previous_hash = current_hash
        previous_loc = loc

        pn = page_number(loc)
        if pn is not None and last_page_number is not None and pn + 10 < last_page_number:
            log("end", reason="page_number_reversed", step=step,
                previous_page=last_page_number, current_page=pn, location=loc,
                pages=len(seen_text))
            break
        if pn is not None:
            last_page_number = pn

        if exact_final_page(loc):
            log("end", reason="exact_final_page", step=step, location=loc, pages=len(seen_text))
            break

        before = current_hash
        before_img = page_fingerprint(wid) if not main_text else None
        send_left(pid)
        deadline=time.time()+args.timeout
        changed=False
        last=None; stable_since=None
        while time.time()<deadline:
            time.sleep(.12)
            cur, h2, tb2, loc2 = ensure_text(pid,bounds)
            curh=hashlib.sha256(cur.encode()).hexdigest() if cur else None
            key=(curh,loc2)
            if key != (before,loc):
                if key == last:
                    if stable_since and time.time()-stable_since >= args.settle:
                        changed=True; break
                else:
                    last=key; stable_since=time.time()
        if not changed and before_img is not None:
            after_img=page_fingerprint(wid)
            if after_img is not None and after_img != before_img:
                changed=True
                log("image_changed", step=step, location=loc)

        if not changed:
            # Fallback 1: click the left page edge (RTL next page).
            click_next_rtl(pid,bounds); time.sleep(.8)
            cur,h2,tb2,loc2=ensure_text(pid,bounds)
            curh=hashlib.sha256(cur.encode()).hexdigest() if cur else None
            after_img=page_fingerprint(wid) if before_img is not None else None
            if (curh,loc2)!=(before,loc) or (
                    before_img is not None and after_img is not None and after_img != before_img):
                changed=True
                log("fallback_click_next", step=step)
            else:
                # Fallback 2: focus center, then try left arrow one more time.
                click_center(pid,bounds); time.sleep(.3); send_left(pid); time.sleep(.8)
                cur,h2,tb2,loc2=ensure_text(pid,bounds)
                curh=hashlib.sha256(cur.encode()).hexdigest() if cur else None
                if (curh,loc2)==(before,loc):
                    stable_end += 1
                    log("no_change", step=step, location=loc, count=stable_end)
                    if stable_end >= 2:
                        log("end", reason="no_change_twice", pages=len(seen_text))
                        break
                else:
                    stable_end=0
        else:
            stable_end=0
    else:
        log("end", reason="max_pages", pages=len(seen_text))

    print(json.dumps({"title":args.title,"pages":len(seen_text),
                      "out":str(out)},ensure_ascii=False))

if __name__ == "__main__":
    main()
