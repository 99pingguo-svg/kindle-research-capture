"""SQLite storage.

The connection runs in autocommit mode; multi-statement changes use
``tx(conn)`` which issues ``BEGIN IMMEDIATE`` so that two workers can never
claim the same job or interleave a version write.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

SCHEMA_VERSION = 1

SCHEMA = r"""
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  flash TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  ts TEXT NOT NULL,
  success INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts(key, ts);

-- One-time form tokens: a resent/double-clicked form is answered from here
-- instead of being executed twice.
CREATE TABLE IF NOT EXISTS action_nonces (
  nonce TEXT PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  legacy_id TEXT,
  asin TEXT,
  marketplace TEXT NOT NULL DEFAULT 'www.amazon.co.jp',
  name TEXT NOT NULL,
  source_url TEXT,
  asin_verified_at TEXT,
  asin_evidence TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','held','archived')),
  hold_reason TEXT,
  manuscript_cleared_for_ai INTEGER NOT NULL DEFAULT 0,
  selection_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (marketplace, asin)
);

-- 調査メモ: information gathered for drafting, with origin and AI permission.
CREATE TABLE IF NOT EXISTS product_notes (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL CHECK (kind IN ('own_test','own_research','maker_info','manuscript','other')),
  origin TEXT NOT NULL CHECK (origin IN ('own','maker','amazon','unknown')),
  body TEXT NOT NULL,
  source_url TEXT,
  checked_on TEXT,
  ai_input_ok INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

-- 元データ: declared fields of imported files, kept apart from edits.
CREATE TABLE IF NOT EXISTS source_records (
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  kind TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('own','maker','amazon','unknown')),
  root_alias TEXT NOT NULL,
  relpath TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  data_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1,
  UNIQUE (product_id, kind, relpath, sha256)
);

CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  selection_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS import_files (
  root_alias TEXT NOT NULL,
  relpath TEXT NOT NULL,
  size INTEGER,
  mtime_ns INTEGER,
  sha256 TEXT,
  last_run_id INTEGER,
  last_result TEXT,
  last_message TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_alias, relpath)
);

CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  run_id INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  kind TEXT NOT NULL CHECK (kind IN ('self_photo','original_work','maker_licensed','generated',
                                     'manga','reference_photo','amazon_derived','unknown')),
  title TEXT,
  source TEXT,
  rights_holder TEXT,
  license_basis TEXT,
  license_url TEXT,
  license_expires_at TEXT,
  rights_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (rights_status IN ('unverified','verified','denied','expired')),
  commercial_ok INTEGER,
  modification_ok INTEGER,
  ai_input_ok INTEGER,
  has_people INTEGER NOT NULL DEFAULT 0,
  has_third_party_work INTEGER NOT NULL DEFAULT 0,
  third_party_cleared INTEGER,
  derived_from_amazon INTEGER NOT NULL DEFAULT 0,
  is_fictional_scene INTEGER NOT NULL DEFAULT 0,
  provenance_note TEXT,
  parent_asset_id INTEGER REFERENCES assets(id),
  processing_history TEXT NOT NULL DEFAULT '[]',
  storage TEXT NOT NULL CHECK (storage IN ('private','source_link')),
  root_alias TEXT,
  relpath TEXT,
  stored_name TEXT,
  sha256 TEXT NOT NULL,
  bytes INTEGER,
  mime TEXT,
  width INTEGER,
  height INTEGER,
  quality_verdict TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (quality_verdict IN ('unreviewed','good','acceptable','rejected')),
  quality_note TEXT,
  upstream_state TEXT,
  rights_checked_by TEXT,
  rights_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (product_id, sha256)
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product','comparison','page')),
  slug TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','review','changes','rejected','approved','scheduled',
                     'published','error','archived')),
  head_version_id INTEGER,
  live_version_id INTEGER,
  live_approval_id INTEGER,
  publication_status TEXT NOT NULL DEFAULT 'unpublished'
    CHECK (publication_status IN ('unpublished','live','withdrawn')),
  first_published_at TEXT,
  last_published_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article_products (
  article_id INTEGER NOT NULL REFERENCES articles(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (article_id, product_id)
);

-- Versions are immutable.  track='main' is the editing line; 'proposal' holds
-- Claude drafts and import updates that never replace the owner's text.
CREATE TABLE IF NOT EXISTS article_versions (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  track TEXT NOT NULL DEFAULT 'main' CHECK (track IN ('main','proposal')),
  version_no INTEGER NOT NULL,
  base_version_id INTEGER,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('import','human','claude','polish','system')),
  author TEXT,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text_fingerprint TEXT NOT NULL,
  polish_run_id INTEGER,
  adopted_from_id INTEGER,
  note TEXT,
  proposal_status TEXT CHECK (proposal_status IN ('open','adopted','dismissed')),
  created_at TEXT NOT NULL,
  UNIQUE (article_id, track, version_no)
);

CREATE TABLE IF NOT EXISTS review_comments (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  version_id INTEGER,
  author TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('comment','change_request','reject_reason','system')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_version_id INTEGER
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  version_id INTEGER NOT NULL REFERENCES article_versions(id),
  content_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  context_json TEXT NOT NULL,
  amazon_snapshot_json TEXT NOT NULL DEFAULT '{}',
  acknowledged_warnings_json TEXT NOT NULL DEFAULT '[]',
  purpose TEXT NOT NULL DEFAULT 'publish' CHECK (purpose IN ('publish','restore')),
  batch_id TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','invalidated','revoked')),
  status_reason TEXT,
  status_changed_at TEXT
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id INTEGER PRIMARY KEY,
  article_id INTEGER,
  version_id INTEGER,
  approval_id INTEGER,
  content_hash TEXT,
  action TEXT NOT NULL CHECK (action IN ('publish','unpublish','refresh')),
  run_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('scheduled','queued','running','succeeded','failed','canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  retryable INTEGER,
  last_error TEXT,
  locked_by TEXT,
  lease_until TEXT,
  result_url TEXT,
  verification_json TEXT,
  build_id TEXT,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON publish_jobs(status, run_at);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  job_id INTEGER,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged','live','failed','superseded','rolled_back')),
  live_map_json TEXT NOT NULL,
  verification_json TEXT
);

CREATE TABLE IF NOT EXISTS publication_log (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL,
  version_id INTEGER,
  action TEXT NOT NULL,
  url TEXT,
  build_id TEXT,
  job_id INTEGER,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  lease_until TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);

-- Amazon product data: URLs and facts only, never image bytes.
CREATE TABLE IF NOT EXISTS amazon_items (
  asin TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error','not_found','not_configured')),
  fetched_at TEXT,
  expires_at TEXT,
  title TEXT,
  detail_page_url TEXT,
  image_url TEXT,
  image_width INTEGER,
  image_height INTEGER,
  image_id TEXT,
  star_rating REAL,
  review_count INTEGER,
  parent_asin TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS amazon_refresh_log (
  id INTEGER PRIMARY KEY,
  asin TEXT NOT NULL,
  ts TEXT NOT NULL,
  status TEXT NOT NULL,
  image_id TEXT,
  image_changed INTEGER NOT NULL DEFAULT 0,
  title_changed INTEGER NOT NULL DEFAULT 0,
  star_rating REAL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS polish_runs (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL,
  input_version_id INTEGER NOT NULL,
  output_version_id INTEGER,
  tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  input_fingerprint TEXT NOT NULL,
  output_fingerprint TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  stderr_tail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  requested_by TEXT
);

-- Customer reviews collected elsewhere: private reference for the owner's
-- own reading only.  Never rendered, never exported, never sent to AI.
CREATE TABLE IF NOT EXISTS review_refs (
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  asin TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  rating REAL,
  review_date TEXT,
  source_label TEXT,
  imported_from TEXT,
  sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_refs_asin ON review_refs(asin);

CREATE TABLE IF NOT EXISTS policy_reviews (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL,
  url TEXT NOT NULL,
  checked_on TEXT NOT NULL,
  checked_by TEXT NOT NULL,
  summary TEXT,
  changes TEXT,
  next_due TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


class Connection(sqlite3.Connection):
    """sqlite3 connection with a re-entrant IMMEDIATE transaction helper."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._tx_depth = 0


def connect(path: Path) -> Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), factory=Connection, isolation_level=None,
                           check_same_thread=False, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.DatabaseError:
        pass
    return conn


def init_schema(conn: Connection) -> None:
    conn.executescript(SCHEMA)
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row is None:
        conn.execute("INSERT INTO meta(key, value) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),))
    elif int(row["value"]) > SCHEMA_VERSION:
        raise RuntimeError("データベースがこのプログラムより新しい版です")


@contextmanager
def tx(conn: Connection) -> Iterator[Connection]:
    """BEGIN IMMEDIATE ... COMMIT; nested calls join the outer transaction."""
    if conn._tx_depth:
        conn._tx_depth += 1
        try:
            yield conn
        finally:
            conn._tx_depth -= 1
        return
    conn.execute("BEGIN IMMEDIATE")
    conn._tx_depth = 1
    try:
        yield conn
    except BaseException:
        conn._tx_depth = 0
        conn.execute("ROLLBACK")
        raise
    else:
        conn._tx_depth = 0
        conn.execute("COMMIT")


def one(conn: Connection, sql: str, params: Iterable[Any] = ()) -> Optional[sqlite3.Row]:
    return conn.execute(sql, tuple(params)).fetchone()


def all_rows(conn: Connection, sql: str, params: Iterable[Any] = ()) -> list:
    return conn.execute(sql, tuple(params)).fetchall()


def scalar(conn: Connection, sql: str, params: Iterable[Any] = ()):
    row = conn.execute(sql, tuple(params)).fetchone()
    return None if row is None else row[0]


def insert(conn: Connection, table: str, values: dict) -> int:
    cols = list(values.keys())
    sql = "INSERT INTO %s (%s) VALUES (%s)" % (
        table, ", ".join(cols), ", ".join("?" for _ in cols))
    cur = conn.execute(sql, [values[c] for c in cols])
    return int(cur.lastrowid)


def update(conn: Connection, table: str, key_col: str, key, values: dict) -> int:
    if not values:
        return 0
    sets = ", ".join("%s = ?" % c for c in values)
    cur = conn.execute("UPDATE %s SET %s WHERE %s = ?" % (table, sets, key_col),
                       list(values.values()) + [key])
    return cur.rowcount


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def loads(text: Optional[str], default: Any = None) -> Any:
    if text is None or text == "":
        return default
    return json.loads(text)
