"""A deliberately tiny, safe text format for article bodies.

- blank line: new paragraph
- lines starting with "- " or "・": bullet list
- line starting with "### ": sub-heading
- **text**: strong
Everything else is escaped; raw HTML and links are never passed through.
"""

from __future__ import annotations

import re
from html import escape

from markupsafe import Markup

_STRONG = re.compile(r"\*\*(.+?)\*\*")


def _inline(text: str) -> str:
    return _STRONG.sub(lambda m: "<strong>%s</strong>" % m.group(1), escape(text, quote=True))


def to_html(text: str) -> Markup:
    blocks = re.split(r"\n\s*\n", (text or "").strip())
    out = []
    for block in blocks:
        lines = [ln.rstrip() for ln in block.split("\n") if ln.strip()]
        if not lines:
            continue
        if all(ln.lstrip().startswith(("- ", "・")) for ln in lines):
            items = []
            for ln in lines:
                s = ln.lstrip()
                s = s[2:] if s.startswith("- ") else s[1:]
                items.append("<li>%s</li>" % _inline(s.strip()))
            out.append("<ul>%s</ul>" % "".join(items))
            continue
        para = []
        for ln in lines:
            if ln.startswith("### "):
                if para:
                    out.append("<p>%s</p>" % "<br>".join(para))
                    para = []
                out.append("<h3>%s</h3>" % _inline(ln[4:].strip()))
            else:
                para.append(_inline(ln.strip()))
        if para:
            out.append("<p>%s</p>" % "<br>".join(para))
    return Markup("\n".join(out))


def plain(text: str) -> str:
    """Text without markup, for meta descriptions and JSON-LD."""
    t = _STRONG.sub(lambda m: m.group(1), text or "")
    t = re.sub(r"^(?:- |・|### )", "", t, flags=re.M)
    return re.sub(r"\s+", " ", t).strip()
