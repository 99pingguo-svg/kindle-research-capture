"""Owner authentication: PBKDF2 passwords, server-side sessions, CSRF,
login rate limiting and one-time form tokens (idempotent POSTs)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import timedelta
from typing import Optional, Tuple

from . import db, timeutil
from .core import Actor, Ctx, EditorialError, record_event

PBKDF2_ITERATIONS = 600_000
MAX_FAILURES = 5
LOCKOUT_MINUTES = 15


class AuthError(EditorialError):
    pass


def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    if len(password or "") < 12:
        raise AuthError("パスワードは12文字以上にしてください")
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256$%d$%s$%s" % (iterations, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"), base64.b64decode(salt_b64),
                                 int(iterations))
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except (ValueError, TypeError):
        return False


def create_user(ctx: Ctx, username: str, password: str) -> int:
    username = (username or "").strip()
    if not username or len(username) > 64:
        raise AuthError("ユーザー名が不正です")
    if db.scalar(ctx.conn, "SELECT COUNT(*) FROM users"):
        raise AuthError("管理者は本人1名だけです（既に作成済み）。パスワード変更は set-password を使ってください。")
    with db.tx(ctx.conn):
        uid = db.insert(ctx.conn, "users", {"username": username, "password_hash": hash_password(password),
                                            "role": "owner", "created_at": timeutil.now_iso()})
        record_event(ctx, Actor("system", "cli"), "user", uid, "created", {"username": username})
    return uid


def set_password(ctx: Ctx, username: str, password: str) -> None:
    row = db.one(ctx.conn, "SELECT * FROM users WHERE username = ?", (username,))
    if row is None:
        raise AuthError("ユーザーが見つかりません")
    with db.tx(ctx.conn):
        db.update(ctx.conn, "users", "id", row["id"], {"password_hash": hash_password(password)})
        ctx.conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", (row["id"],))
        record_event(ctx, Actor("system", "cli"), "user", row["id"], "password_changed", {})


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _recent_failures(ctx: Ctx, key: str) -> int:
    since = timeutil.iso(timeutil.now() - timedelta(minutes=LOCKOUT_MINUTES))
    return int(db.scalar(ctx.conn, "SELECT COUNT(*) FROM login_attempts WHERE key = ? AND ts > ? AND success = 0",
                         (key, since)) or 0)


def login(ctx: Ctx, username: str, password: str, remote: str) -> Tuple[str, str]:
    username = (username or "").strip()
    keys = ["user:" + username.lower(), "ip:" + (remote or "?")]
    if any(_recent_failures(ctx, k) >= MAX_FAILURES * (3 if k.startswith("ip:") else 1) for k in keys):
        raise AuthError("ログインの失敗が続いたため、しばらく時間をおいてください")
    row = db.one(ctx.conn, "SELECT * FROM users WHERE username = ? AND disabled = 0", (username,))
    ok = row is not None and verify_password(password, row["password_hash"])
    now = timeutil.now_iso()
    for k in keys:
        db.insert(ctx.conn, "login_attempts", {"key": k, "ts": now, "success": 1 if ok else 0})
    if not ok:
        raise AuthError("ユーザー名またはパスワードが違います")
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    hours = ctx.config.admin.session_idle_hours
    with db.tx(ctx.conn):
        db.insert(ctx.conn, "auth_sessions", {
            "token_hash": _token_hash(token), "user_id": row["id"], "csrf_token": csrf, "created_at": now,
            "last_seen_at": now, "expires_at": timeutil.iso(timeutil.now() + timedelta(hours=hours))})
        record_event(ctx, Actor("user", row["username"]), "user", row["id"], "login", {})
    return token, csrf


def session(ctx: Ctx, token: Optional[str]):
    """Return (session_row, user_row) or None; extends the idle timeout."""
    if not token:
        return None
    row = db.one(ctx.conn, "SELECT s.*, u.username, u.disabled FROM auth_sessions s JOIN users u ON u.id = s.user_id "
                 "WHERE s.token_hash = ?", (_token_hash(token),))
    if row is None or row["disabled"]:
        return None
    now = timeutil.now()
    max_age = timedelta(days=ctx.config.admin.session_max_days)
    if row["expires_at"] <= timeutil.iso(now) or now - timeutil.parse_iso(row["created_at"]) > max_age:
        ctx.conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (row["token_hash"],))
        return None
    if now - timeutil.parse_iso(row["last_seen_at"]) > timedelta(minutes=5):
        ctx.conn.execute("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?", (
            timeutil.iso(now), timeutil.iso(now + timedelta(hours=ctx.config.admin.session_idle_hours)),
            row["token_hash"]))
    return row


def logout(ctx: Ctx, token: Optional[str]) -> None:
    if token:
        ctx.conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (_token_hash(token),))


def set_flash(ctx: Ctx, token: str, message: str) -> None:
    ctx.conn.execute("UPDATE auth_sessions SET flash = ? WHERE token_hash = ?", (message[:2000], _token_hash(token)))


def pop_flash(ctx: Ctx, token: str) -> Optional[str]:
    row = db.one(ctx.conn, "SELECT flash FROM auth_sessions WHERE token_hash = ?", (_token_hash(token),))
    if row and row["flash"]:
        ctx.conn.execute("UPDATE auth_sessions SET flash = NULL WHERE token_hash = ?", (_token_hash(token),))
        return row["flash"]
    return None


def new_nonce() -> str:
    return secrets.token_urlsafe(18)


def claim_nonce(ctx: Ctx, user_id: int, nonce: str, action: str):
    """First use of a form token returns None; a repeat returns the stored result."""
    if not nonce or len(nonce) > 64:
        raise EditorialError("フォームの有効期限が切れています。画面を開き直してください。")
    row = db.one(ctx.conn, "SELECT * FROM action_nonces WHERE nonce = ?", (nonce,))
    if row:
        return db.loads(row["result_json"], {}) or {"redirect": None}
    db.insert(ctx.conn, "action_nonces", {"nonce": nonce, "user_id": user_id, "action": action,
                                          "created_at": timeutil.now_iso()})
    return None


def store_nonce_result(ctx: Ctx, nonce: str, result: dict) -> None:
    ctx.conn.execute("UPDATE action_nonces SET result_json = ? WHERE nonce = ?", (db.dumps(result), nonce))


def release_nonce(ctx: Ctx, nonce: str) -> None:
    """Let the owner resubmit after a validation error."""
    ctx.conn.execute("DELETE FROM action_nonces WHERE nonce = ? AND result_json IS NULL", (nonce,))


# ---------------------------------------------------------------- AI tokens

def create_ai_token(ctx: Ctx, name: str) -> str:
    """Create a bearer token for Claude's MCP access; returns it once."""
    name = (name or "").strip()
    if not name or len(name) > 40:
        raise AuthError("トークン名が不正です")
    token = "ed_" + secrets.token_urlsafe(32)
    with db.tx(ctx.conn):
        if db.one(ctx.conn, "SELECT 1 FROM api_tokens WHERE name = ?", (name,)):
            raise AuthError("同じ名前のトークンがあります。先に取り消してください。")
        db.insert(ctx.conn, "api_tokens", {"name": name, "token_hash": _token_hash(token),
                                           "created_at": timeutil.now_iso()})
        record_event(ctx, Actor("system", "cli"), "api_token", name, "created", {})
    return token


def revoke_ai_token(ctx: Ctx, name: str) -> None:
    row = db.one(ctx.conn, "SELECT * FROM api_tokens WHERE name = ? AND revoked_at IS NULL", (name,))
    if row is None:
        raise AuthError("有効なトークンが見つかりません")
    with db.tx(ctx.conn):
        # Renaming keeps the name free for a replacement token.
        db.update(ctx.conn, "api_tokens", "id", row["id"], {
            "revoked_at": timeutil.now_iso(), "name": "%s (取消 %s)" % (name, row["id"])})
        record_event(ctx, Actor("system", "cli"), "api_token", name, "revoked", {})


def check_ai_token(ctx: Ctx, token: Optional[str]):
    if not token or not token.startswith("ed_"):
        return None
    row = db.one(ctx.conn, "SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
                 (_token_hash(token),))
    if row is not None:
        ctx.conn.execute("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", (timeutil.now_iso(), row["id"]))
    return row


def list_ai_tokens(ctx: Ctx):
    return db.all_rows(ctx.conn, "SELECT id, name, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY id DESC")

