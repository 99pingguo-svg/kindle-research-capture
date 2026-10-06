"""Local, private configuration.

The configuration file holds absolute paths of the read-only source folders
and API credentials.  It must never be committed or published: by default it
lives in ``var/config.json`` (git-ignored) or wherever ``EDITORIAL_CONFIG``
points.  Credentials may also come from environment variables.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

APP_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_ROOT = Path(__file__).resolve().parent

DEFAULT_POLISH_COMMAND = ["agy", "-p", "{prompt}"]


class ConfigError(Exception):
    pass


@dataclass
class AmazonConfig:
    enabled: bool = False
    credential_id: str = ""
    credential_secret: str = ""
    # Credential version shown in Associates Central when the credential was
    # created (2.x = Cognito, 3.x = Login with Amazon; 3.3 = amazon.co.jp).
    version: str = "3.3"
    marketplace: str = "www.amazon.co.jp"
    api_host: str = "https://creatorsapi.amazon"
    auth_endpoint: str = ""
    timeout_sec: int = 20

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.credential_id and self.credential_secret and self.version)


@dataclass
class PolishConfig:
    # Antigravity CLI print mode.  "{prompt}" is replaced by the prompt text
    # when input_mode == "arg"; with "stdin" the prompt is piped instead.
    command: List[str] = field(default_factory=lambda: list(DEFAULT_POLISH_COMMAND))
    input_mode: str = "arg"
    timeout_sec: int = 600
    require_for_publish: bool = True
    tool_name: str = "Antigravity CLI"


@dataclass
class AdminConfig:
    host: str = "127.0.0.1"
    port: int = 8710
    secure_cookies: bool = False
    session_idle_hours: int = 12
    session_max_days: int = 7
    run_scheduler: bool = False
    scheduler_interval_sec: int = 60


@dataclass
class PublishConfig:
    target: str = "local_dir"
    keep_builds: int = 5


@dataclass
class Config:
    data_dir: Path
    public_out_dir: Path
    source_roots: Dict[str, Path] = field(default_factory=dict)
    access_guide: Optional[Path] = None
    admin: AdminConfig = field(default_factory=AdminConfig)
    amazon: AmazonConfig = field(default_factory=AmazonConfig)
    polish: PolishConfig = field(default_factory=PolishConfig)
    publish: PublishConfig = field(default_factory=PublishConfig)
    config_path: Optional[Path] = None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "editorial.db"

    @property
    def private_assets_dir(self) -> Path:
        return self.data_dir / "private_assets"

    @property
    def builds_dir(self) -> Path:
        return self.data_dir / "builds"

    @property
    def exports_dir(self) -> Path:
        return self.data_dir / "exports"

    @property
    def reports_dir(self) -> Path:
        return self.data_dir / "reports"

    def secret_values(self) -> List[str]:
        """Values that must never appear in public output."""
        values = [self.amazon.credential_secret, self.amazon.credential_id]
        values += [str(p) for p in self.source_roots.values()]
        if self.access_guide:
            values.append(str(self.access_guide))
        values.append(str(self.data_dir))
        home = os.path.expanduser("~")
        if home and home not in ("/", "/root"):
            values.append(home)
        return [v for v in values if v and len(v) >= 6]

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.private_assets_dir, self.builds_dir,
                  self.exports_dir, self.reports_dir):
            p.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.data_dir, 0o700)
        except OSError:
            pass
        self.validate_isolation()

    def validate_isolation(self) -> None:
        """Source folders are read-only inputs; app data must live elsewhere."""
        data = self.data_dir.resolve()
        for alias, root in self.source_roots.items():
            r = Path(root).resolve()
            if _is_within(data, r) or _is_within(r, data):
                raise ConfigError(
                    "データ保存先と取り込み元(%s)が重なっています。取り込み元は読み取り専用です。" % alias)
        out = self.public_out_dir.resolve()
        for alias, root in self.source_roots.items():
            if _is_within(out, Path(root).resolve()):
                raise ConfigError("公開出力先が取り込み元(%s)の中にあります。" % alias)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _resolve_path(value: Optional[str], base: Path) -> Optional[Path]:
    if not value:
        return None
    p = Path(os.path.expanduser(str(value)))
    if not p.is_absolute():
        p = base / p
    return p


def load_config(path: Optional[str] = None, overrides: Optional[dict] = None) -> Config:
    env_path = path or os.environ.get("EDITORIAL_CONFIG")
    raw: dict = {}
    cfg_path: Optional[Path] = None
    if env_path:
        cfg_path = Path(os.path.expanduser(env_path)).resolve()
        if not cfg_path.exists():
            raise ConfigError("設定ファイルが見つかりません: %s" % cfg_path)
    else:
        default = APP_ROOT / "var" / "config.json"
        if default.exists():
            cfg_path = default
    if cfg_path:
        with open(cfg_path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        raw.pop("_comment", None)
    if overrides:
        raw = _deep_merge(raw, overrides)

    base = cfg_path.parent if cfg_path else APP_ROOT
    data_dir = _resolve_path(os.environ.get("EDITORIAL_DATA_DIR") or raw.get("data_dir"), base) \
        or (APP_ROOT / "var")
    public_out = _resolve_path(raw.get("public_out_dir"), base) or (data_dir / "public_site")

    roots = {}
    for alias, value in (raw.get("source_roots") or {}).items():
        if not str(alias).isalnum():
            raise ConfigError("取り込み元の別名は英数字にしてください: %r" % alias)
        p = _resolve_path(value, base)
        if p:
            roots[str(alias)] = p

    admin = AdminConfig(**_known(AdminConfig, raw.get("admin") or {}))
    amazon = AmazonConfig(**_known(AmazonConfig, raw.get("amazon") or {}))
    amazon.credential_id = os.environ.get("EDITORIAL_AMAZON_CREDENTIAL_ID", amazon.credential_id)
    amazon.credential_secret = os.environ.get("EDITORIAL_AMAZON_CREDENTIAL_SECRET", amazon.credential_secret)
    polish = PolishConfig(**_known(PolishConfig, raw.get("polish") or {}))
    if polish.input_mode not in ("arg", "stdin"):
        raise ConfigError("polish.input_mode は arg か stdin です")
    if not polish.command or not all(isinstance(c, str) for c in polish.command):
        raise ConfigError("polish.command は文字列の配列で指定してください")
    publish = PublishConfig(**_known(PublishConfig, raw.get("publish") or {}))
    if publish.target != "local_dir":
        raise ConfigError("現在の公開先は local_dir（ダミー公開先）のみです。実公開先は本人の確認後に追加します。")

    return Config(
        data_dir=data_dir,
        public_out_dir=public_out,
        source_roots=roots,
        access_guide=_resolve_path(raw.get("access_guide"), base),
        admin=admin,
        amazon=amazon,
        polish=polish,
        publish=publish,
        config_path=cfg_path,
    )


def _known(cls, data: dict) -> dict:
    names = set(cls.__dataclass_fields__.keys())
    unknown = set(data) - names
    if unknown:
        raise ConfigError("%s に不明な設定があります: %s" % (cls.__name__, ", ".join(sorted(unknown))))
    return {k: v for k, v in data.items() if k in names}


def _deep_merge(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out
