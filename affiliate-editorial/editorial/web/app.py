"""A small WSGI layer for the private admin app (stdlib only).

Every route requires the owner's session unless marked public, and every
POST must carry the session's CSRF token.  Responses carry strict security
headers and are never cached.
"""

from __future__ import annotations

import email.parser
import email.policy
import hmac
import io
import mimetypes
import re
import traceback
from http import HTTPStatus
from http.cookies import SimpleCookie
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote

from .. import auth
from ..config import PACKAGE_ROOT
from ..core import Ctx

MAX_BODY = 30 * 1024 * 1024
SESSION_COOKIE = "ed_session"
PRELOGIN_COOKIE = "ed_prelogin"
STATIC_DIR = PACKAGE_ROOT / "static" / "admin"
PUBLIC_STATIC_DIR = PACKAGE_ROOT / "static" / "public"
PUBLIC_STATIC = ("site.css", "amzn-expiry.js")  # used by the article preview
_STATIC_NAME = re.compile(r"^[a-z0-9_.-]+\.(css|js|svg|png)$")

CSP = ("default-src 'self'; img-src 'self' https://m.media-amazon.com https://images-fe.ssl-images-amazon.com "
       "https://images-na.ssl-images-amazon.com data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "frame-ancestors %s; form-action 'self'; base-uri 'none'; object-src 'none'")


class Request:
    def __init__(self, environ: dict):
        self.environ = environ
        self.method = environ.get("REQUEST_METHOD", "GET").upper()
        self.path = environ.get("PATH_INFO", "/") or "/"
        self.query: Dict[str, List[str]] = parse_qs(environ.get("QUERY_STRING", ""), keep_blank_values=True)
        self.remote_addr = environ.get("REMOTE_ADDR", "")
        self.cookies = SimpleCookie()
        try:
            self.cookies.load(environ.get("HTTP_COOKIE", ""))
        except Exception:
            pass
        self.form: Dict[str, List[str]] = {}
        self.files: Dict[str, List[Tuple[str, bytes, str]]] = {}
        self.session = None
        self.user = None
        if self.method == "POST":
            self._parse_body()

    def _parse_body(self) -> None:
        try:
            length = int(self.environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            raise ValueError("送信データが大きすぎます")
        body = self.environ["wsgi.input"].read(length) if length else b""
        ctype = self.environ.get("CONTENT_TYPE", "")
        if ctype.startswith("application/x-www-form-urlencoded"):
            self.form = parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True)
        elif ctype.startswith("multipart/form-data"):
            msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
                b"Content-Type: " + ctype.encode("latin-1") + b"\r\n\r\n" + body)
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if not name:
                    continue
                filename = part.get_filename()
                payload = part.get_payload(decode=True) or b""
                if filename is not None:
                    self.files.setdefault(name, []).append((filename, payload, part.get_content_type()))
                else:
                    charset = part.get_content_charset() or "utf-8"
                    self.form.setdefault(name, []).append(payload.decode(charset, "replace"))

    def get(self, name: str, default: str = "") -> str:
        values = self.form.get(name) if self.method == "POST" else None
        if not values:
            values = self.query.get(name)
        return values[0] if values else default

    def getlist(self, name: str) -> List[str]:
        return self.form.get(name, []) if self.method == "POST" else self.query.get(name, [])

    def cookie(self, name: str) -> Optional[str]:
        c = self.cookies.get(name)
        return c.value if c else None

    @property
    def secure(self) -> bool:
        return self.environ.get("wsgi.url_scheme") == "https" or \
            self.environ.get("HTTP_X_FORWARDED_PROTO") == "https"


class Response:
    def __init__(self, body=b"", status: int = 200, content_type: str = "text/html; charset=utf-8"):
        self.status = status
        self.body = body.encode("utf-8") if isinstance(body, str) else body
        self.headers: List[Tuple[str, str]] = [("Content-Type", content_type)]
        self.frame_ancestors = "'none'"

    def set_cookie(self, name: str, value: str, max_age: Optional[int] = None, secure: bool = False) -> None:
        parts = ["%s=%s" % (name, value), "Path=/", "HttpOnly", "SameSite=Strict"]
        if max_age is not None:
            parts.append("Max-Age=%d" % max_age)
        if secure:
            parts.append("Secure")
        self.headers.append(("Set-Cookie", "; ".join(parts)))


def redirect(location: str) -> Response:
    r = Response(b"", 303)
    r.headers.append(("Location", location))
    return r


class App:
    def __init__(self, ctx: Ctx):
        self.ctx = ctx
        self.routes: List[Tuple[str, re.Pattern, Callable, bool]] = []

    def route(self, method: str, pattern: str, public: bool = False):
        regex = re.compile("^" + re.sub(r"<(\w+)>", r"(?P<\1>[0-9]+)", pattern) + "$")

        def deco(fn):
            self.routes.append((method, regex, fn, public))
            return fn
        return deco

    def __call__(self, environ, start_response):
        try:
            resp = self.dispatch(environ)
        except Exception:  # never leak tracebacks to the browser
            traceback.print_exc()
            resp = Response("<h1>エラーが発生しました</h1><p>操作は完了していない可能性があります。履歴を確認してください。</p>", 500)
        headers = list(resp.headers) + [
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("Referrer-Policy", "same-origin"),
            ("X-Frame-Options", "SAMEORIGIN" if resp.frame_ancestors == "'self'" else "DENY"),
            ("X-Robots-Tag", "noindex, nofollow"),
            ("Content-Security-Policy", CSP % resp.frame_ancestors),
            ("Content-Length", str(len(resp.body))),
        ]
        start_response("%d %s" % (resp.status, HTTPStatus(resp.status).phrase), headers)
        return [resp.body]

    def dispatch(self, environ) -> Response:
        try:
            req = Request(environ)
        except ValueError as exc:
            return Response(str(exc), 413, "text/plain; charset=utf-8")
        if req.path.startswith("/static/"):
            return self.static(req.path[len("/static/"):])
        allowed = []
        for method, regex, fn, public in self.routes:
            m = regex.match(req.path)
            if not m:
                continue
            allowed.append(method)
            if method != req.method:
                continue
            if not public:
                sess = auth.session(self.ctx, req.cookie(SESSION_COOKIE))
                if sess is None:
                    if req.method == "GET":
                        return redirect("/login?next=" + quote(req.path))
                    return Response("ログインが必要です", 401, "text/plain; charset=utf-8")
                req.session = sess
                req.user = sess["username"]
                if req.method == "POST" and not hmac.compare_digest(req.get("_csrf"), sess["csrf_token"]):
                    return Response("フォームの確認に失敗しました。画面を開き直してください。", 403,
                                    "text/plain; charset=utf-8")
            params = {k: int(v) for k, v in m.groupdict().items()}
            return fn(req, **params)
        if allowed:
            return Response("Method Not Allowed", 405, "text/plain; charset=utf-8")
        return Response("<h1>ページが見つかりません</h1>", 404)

    def static(self, name: str) -> Response:
        if not _STATIC_NAME.match(name):
            return Response("Not Found", 404, "text/plain")
        path = (PUBLIC_STATIC_DIR if name in PUBLIC_STATIC else STATIC_DIR) / name
        if not path.is_file():
            return Response("Not Found", 404, "text/plain")
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        return Response(path.read_bytes(), 200, ctype)


def serve(app: App, host: str, port: int) -> None:
    from wsgiref.simple_server import WSGIRequestHandler, make_server

    class Handler(WSGIRequestHandler):
        def log_message(self, fmt, *args):  # keep the console quiet but useful
            if args and str(args[1]).startswith(("4", "5")):
                super().log_message(fmt, *args)

    with make_server(host, port, app, handler_class=Handler) as httpd:
        print("管理画面: http://%s:%d/  （終了は Ctrl+C）" % (host, port))
        httpd.serve_forever()


def bytes_io(data: bytes) -> io.BytesIO:
    return io.BytesIO(data)
