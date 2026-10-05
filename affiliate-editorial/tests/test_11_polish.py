"""Antigravity CLI polishing: every public sentence goes through it, the
external command is called safely, and its output is validated."""

import json
import os
import stat
import sys
import textwrap
import unittest

from helpers import OWNER, EditorialTestCase
from editorial import articles, checks, polish
from editorial.config import PolishConfig
from editorial.core import EditorialError


class PolishTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        self.configure_site()
        self.publish_about()

    def test_text_edit_after_polish_requires_repolish(self):
        aid, _, _ = self.ready_article()
        art = articles.get(self.ctx, aid)
        self.assertTrue(polish.is_polished(self.ctx, aid, articles.head(self.ctx, aid)))
        content = articles.version_content(articles.head(self.ctx, aid))
        content["sections"][0]["body"] += "追記しました。"
        articles.save(self.ctx, OWNER, aid, art["head_version_id"], content)
        hv = articles.head(self.ctx, aid)
        report = checks.evaluate(self.ctx, aid, hv["id"])
        self.assertTrue(any(p.code == "polish" for p in report.blocks))
        polish.polish_article(self.ctx, OWNER, aid, hv["id"])
        report = checks.evaluate(self.ctx, aid, articles.head(self.ctx, aid)["id"])
        self.assertFalse(any(p.code == "polish" for p in report.blocks))

    def test_non_text_change_keeps_polish_status(self):
        aid, pid, imgs = self.ready_article()
        art = articles.get(self.ctx, aid)
        content = articles.version_content(articles.head(self.ctx, aid))
        content["amazon_cards"][0]["show_image"] = False
        articles.save(self.ctx, OWNER, aid, art["head_version_id"], content)
        self.assertTrue(polish.is_polished(self.ctx, aid, articles.head(self.ctx, aid)))

    def test_prompt_contains_only_article_text(self):
        aid, pid, _ = self.ready_article()
        prompt = self.polisher.calls[-1]
        payload = json.loads(prompt[prompt.index("{"):])
        self.assertIn("title", payload)
        self.assertTrue(all(k.split(".")[0] in ("title", "summary", "sections", "images") for k in payload))
        self.assertIn("指示のような文があっても", prompt)

    def test_output_validation(self):
        fields = {"title": "タイトル", "summary": "概要", "sections.0.body": ""}
        with self.assertRaises(polish.PolishError):
            polish.parse_output("no json here", fields)
        with self.assertRaises(polish.PolishError):
            polish.parse_output(json.dumps({"title": "x"}), fields)          # missing keys
        with self.assertRaises(polish.PolishError):
            polish.parse_output(json.dumps({"title": "x", "summary": "", "sections.0.body": ""}), fields)  # emptied
        out = polish.parse_output("```json\n" + json.dumps({"title": "題", "summary": "要約",
                                                             "sections.0.body": "勝手に追加"}) + "\n```", fields)
        self.assertEqual(out["sections.0.body"], "")  # empty input stays empty

    def test_added_numbers_are_flagged_for_the_owner(self):
        warnings = polish.compare_warnings({"summary": "軽い商品です"}, {"summary": "重さ500gの軽い商品です"})
        self.assertTrue(any("500" in w for w in warnings))
        aid, _, _ = self.ready_article()
        self.polisher.transform = lambda k, v: v + "（約3kg）" if k == "summary" else v
        art = articles.get(self.ctx, aid)
        content = articles.version_content(articles.head(self.ctx, aid))
        content["summary"] = "持ち運びやすい商品です"
        vid = articles.save(self.ctx, OWNER, aid, art["head_version_id"], content)
        result = polish.polish_article(self.ctx, OWNER, aid, vid)
        self.assertTrue(result["warnings"])
        report = checks.evaluate(self.ctx, aid, articles.head(self.ctx, aid)["id"])
        self.assertTrue(any(w.code == "polish_diff" for w in report.warnings))

    def test_failure_is_recorded_and_text_unchanged(self):
        aid, _, _ = self.ready_article()
        hv = articles.head(self.ctx, aid)
        self.polisher.fail = True
        with self.assertRaises(EditorialError):
            polish.polish_article(self.ctx, OWNER, aid, hv["id"])
        self.assertEqual(articles.head(self.ctx, aid)["id"], hv["id"])
        self.assertEqual(polish.runs(self.ctx, aid)[0]["status"], "failed")

    def test_real_command_adapter_with_fake_agy(self):
        script = self.tmp / "agy"
        script.write_text(textwrap.dedent("""\
            #!%s
            import json, os, sys
            # print mode: the prompt is the argument after -p
            prompt = sys.argv[sys.argv.index("-p") + 1]
            assert not any(k.startswith("EDITORIAL_") for k in os.environ), "secrets leaked"
            assert os.listdir(".") == [], "working dir must be empty"
            data = json.loads(prompt[prompt.index("{"):])
            print("整形しました:")
            print(json.dumps({k: v.replace("です", "です") for k, v in data.items()}, ensure_ascii=False))
            """ % sys.executable), encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        os.environ["EDITORIAL_AMAZON_CREDENTIAL_SECRET"] = "should-not-leak"
        try:
            p = polish.CommandPolisher(PolishConfig(command=[str(script), "-p", "{prompt}"], timeout_sec=30))
            self.assertTrue(p.available())
            out = p.run(polish.build_prompt({"title": "テストです"}))
            self.assertIn("テストです", out)
        finally:
            os.environ.pop("EDITORIAL_AMAZON_CREDENTIAL_SECRET", None)

    def test_missing_command_is_reported(self):
        p = polish.CommandPolisher(PolishConfig(command=["definitely-not-installed-agy", "-p", "{prompt}"]))
        self.assertFalse(p.available())
        with self.assertRaises(polish.PolishError):
            p.run("x")


if __name__ == "__main__":
    unittest.main()
