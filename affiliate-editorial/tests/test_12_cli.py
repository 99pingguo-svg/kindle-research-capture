"""The command line works end to end on a fresh data directory."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parent.parent


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="editorial-cli-"))
        self.cfg = self.tmp / "config.json"
        self.cfg.write_text(json.dumps({"data_dir": str(self.tmp / "var"),
                                        "source_roots": {"O": str(self.tmp / "missing")}}), encoding="utf-8")
        self.env = dict(os.environ, EDITORIAL_CONFIG=str(self.cfg), EDITORIAL_PASSWORD="a long enough password")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *args, ok=True):
        p = subprocess.run([sys.executable, "-m", "editorial", *args], cwd=str(APP), env=self.env,
                           capture_output=True, text=True, timeout=120)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        return p

    def test_init_user_status_survey(self):
        out = self.run_cli("init").stdout
        self.assertIn("/about/", out)
        self.run_cli("create-user", "owner")
        status = json.loads(self.run_cli("status").stdout)
        self.assertEqual(status["articles"].get("draft"), 2)   # about + privacy drafts
        self.assertIn("operator_name", status["settings_missing"])
        survey = self.run_cli("survey").stdout
        self.assertIn("未接続", survey)
        err = self.run_cli("import", "--asins", "B0TESTAAA1", ok=False)
        self.assertNotEqual(err.returncode, 0)
        self.assertIn("接続できません", err.stderr)
        check = json.loads(self.run_cli("check", "1").stdout)
        self.assertTrue(check["blocks"])
        self.run_cli("policy-review", "--all")


if __name__ == "__main__":
    unittest.main()
