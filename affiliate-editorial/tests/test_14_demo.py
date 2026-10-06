"""The demo command builds a separate, working sample site."""

import shutil
import tempfile
import unittest
from pathlib import Path

from helpers import ROOT  # also puts the app on sys.path
from editorial import articles, core, demo, timeutil
from editorial.config import load_config
from editorial.core import EditorialError


class DemoTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / "editorial" / "demo_polisher.py").exists())
        self.tmp = Path(tempfile.mkdtemp(prefix="editorial-demo-"))
        timeutil.set_now(None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_demo_creates_published_and_pending_articles(self):
        info = demo.create(self.tmp / "demo")
        ctx = core.open_ctx(load_config(info["config"]))
        try:
            states = sorted(a["state"] for a in articles.list_articles(ctx))
            self.assertEqual(states, ["changes", "published", "published", "published", "review"])
            out = ctx.config.public_out_dir
            self.assertTrue((out / "items/demo-storage-box/index.html").exists())
            self.assertIn("デモ用（整形なし）", ctx.config.polish.tool_name)
        finally:
            ctx.conn.close()
        with self.assertRaises(EditorialError):
            demo.create(self.tmp / "demo")  # never overwrites an existing directory


if __name__ == "__main__":
    unittest.main()
