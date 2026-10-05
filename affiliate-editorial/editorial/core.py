"""Application context shared by the CLI, the admin web app and tests."""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass, field
from typing import Any, Optional

from . import db, timeutil
from .config import Config


class EditorialError(Exception):
    """An expected, user-facing failure (shown in Japanese)."""


class ConflictError(EditorialError):
    """Optimistic-concurrency conflict: someone saved a newer version."""


class GateError(EditorialError):
    """A publish/approval gate failed; ``problems`` lists the reasons."""

    def __init__(self, message: str, problems: Optional[list] = None):
        super().__init__(message)
        self.problems = problems or []


@dataclass
class Actor:
    kind: str  # user | claude | system | import | polish
    name: str

    @classmethod
    def system(cls) -> "Actor":
        return cls("system", "system")


@dataclass
class Ctx:
    config: Config
    conn: db.Connection
    _amazon: Any = field(default=None, repr=False)
    _polisher: Any = field(default=None, repr=False)

    @property
    def amazon(self):
        if self._amazon is None:
            from .amazon_api import CreatorsApiClient
            self._amazon = CreatorsApiClient(self.config.amazon)
        return self._amazon

    @amazon.setter
    def amazon(self, client) -> None:
        self._amazon = client

    @property
    def polisher(self):
        if self._polisher is None:
            from .polish import CommandPolisher
            self._polisher = CommandPolisher(self.config.polish)
        return self._polisher

    @polisher.setter
    def polisher(self, value) -> None:
        self._polisher = value


def open_ctx(config: Config) -> Ctx:
    config.ensure_dirs()
    conn = db.connect(config.db_path)
    db.init_schema(conn)
    ctx = Ctx(config=config, conn=conn)
    from . import settings as settings_mod
    settings_mod.ensure_defaults(ctx)
    return ctx


def record_event(ctx: Ctx, actor: Actor, entity_type: str, entity_id: Any,
                 action: str, data: Optional[dict] = None) -> int:
    """Append to the change history (誰が何を変えたか)."""
    return db.insert(ctx.conn, "events", {
        "ts": timeutil.now_iso(),
        "actor_kind": actor.kind,
        "actor": actor.name,
        "entity_type": entity_type,
        "entity_id": None if entity_id is None else str(entity_id),
        "action": action,
        "data_json": db.dumps(data or {}),
    })


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_hash(value: Any) -> str:
    return sha256_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)
