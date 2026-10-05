"""Time helpers.

All timestamps are stored as UTC ISO-8601 strings ("2026-10-05T06:00:00Z").
Everything shown to the owner is converted to Japan time and labelled
"日本時間" so that a schedule is never ambiguous.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

try:  # zoneinfo is available on Python 3.9+, but tzdata may be missing.
    from zoneinfo import ZoneInfo

    JST = ZoneInfo("Asia/Tokyo")
except Exception:  # pragma: no cover - Japan has no DST, fixed offset is exact
    JST = timezone(timedelta(hours=9), "JST")

_frozen_now: Optional[datetime] = None


def set_now(value: Optional[datetime]) -> None:
    """Freeze the clock (tests only).  Pass None to unfreeze."""
    global _frozen_now
    if value is not None and value.tzinfo is None:
        raise ValueError("frozen time must be timezone-aware")
    _frozen_now = value.astimezone(timezone.utc) if value else None


def advance(**kwargs) -> datetime:
    """Move a frozen clock forward (tests only)."""
    global _frozen_now
    if _frozen_now is None:
        raise RuntimeError("clock is not frozen")
    _frozen_now = _frozen_now + timedelta(**kwargs)
    return _frozen_now


def now() -> datetime:
    if _frozen_now is not None:
        return _frozen_now
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        raise ValueError("naive datetime")
    return dt.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso() -> str:
    return iso(now())


def parse_iso(value: str) -> datetime:
    if not value:
        raise ValueError("empty timestamp")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValueError("timestamp without timezone: %r" % value)
    return dt.astimezone(timezone.utc)


def parse_jst_local(value: str) -> datetime:
    """Parse the value of an <input type=datetime-local> as Japan time."""
    text = (value or "").strip()
    if not text:
        raise ValueError("日時が入力されていません")
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            naive = datetime.strptime(text, fmt)
            break
        except ValueError:
            continue
    else:
        raise ValueError("日時の形式が正しくありません: %s" % text)
    return naive.replace(tzinfo=JST).astimezone(timezone.utc)


def to_jst(value) -> datetime:
    dt = parse_iso(value) if isinstance(value, str) else value
    return dt.astimezone(JST)


def jst_label(value, with_suffix: bool = True) -> str:
    """'2026年10月5日 15:30（日本時間）'"""
    if not value:
        return ""
    dt = to_jst(value)
    text = "%d年%d月%d日 %02d:%02d" % (dt.year, dt.month, dt.day, dt.hour, dt.minute)
    return text + ("（日本時間）" if with_suffix else "")


def jst_date_label(value) -> str:
    if not value:
        return ""
    if isinstance(value, date) and not isinstance(value, datetime):
        d = value
    elif isinstance(value, str) and len(value) == 10:
        d = date.fromisoformat(value)
    else:
        d = to_jst(value).date()
    return "%d年%d月%d日" % (d.year, d.month, d.day)


def jst_input_value(value) -> str:
    """Format for <input type=datetime-local value=...> in Japan time."""
    if not value:
        return ""
    return to_jst(value).strftime("%Y-%m-%dT%H:%M")


def today_jst() -> date:
    return now().astimezone(JST).date()
