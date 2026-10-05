"""§8 ASINとリンク: wrong ASIN, broken URL, missing/invalid tracking ID stop publication."""

import unittest

from helpers import ASIN_A, ASIN_B, OWNER, EditorialTestCase
from editorial import articles, checks, links, products, settings
from editorial.core import EditorialError


class AsinAndLinkTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        self.configure_site()
        self.publish_about()

    def test_card_for_another_products_asin_is_refused(self):
        self.make_product(ASIN_B, "別の商品")
        aid, _, _ = self.ready_article()
        art = articles.get(self.ctx, aid)
        content = articles.version_content(articles.head(self.ctx, aid))
        content["amazon_cards"].append({"asin": ASIN_B, "show_image": True})
        with self.assertRaises(EditorialError):
            articles.save(self.ctx, OWNER, aid, art["head_version_id"], content)

    def test_unverified_asin_blocks(self):
        pid = products.create(self.ctx, OWNER, "未確認の商品", asin="B0TESTDDD4")
        aid = articles.create(self.ctx, OWNER, "product", "unverified-asin", [pid])
        self.fill_content(aid, asin="B0TESTDDD4")
        hv = articles.head(self.ctx, aid)
        report = checks.evaluate(self.ctx, aid, hv["id"], purpose="publish")
        self.assertTrue(any(p.code == "asin" for p in report.blocks))

    def test_invalid_asin_format_is_rejected(self):
        with self.assertRaises(EditorialError):
            products.create(self.ctx, OWNER, "x", asin="12345")
        self.assertIsNone(products.asin_from_amazon_url("https://example.com/dp/B0TESTAAA1"))
        self.assertEqual(products.asin_from_amazon_url("https://www.amazon.co.jp/dp/B0TESTAAA1?th=1"), "B0TESTAAA1")

    def test_link_validation_detects_problems(self):
        good = links.product_url(ASIN_A, "associates", "mysite-22")
        self.assertEqual(links.validate(good, ASIN_A, "associates", "mysite-22"), [])
        self.assertTrue(links.validate(good, ASIN_B, "associates", "mysite-22"))            # other product
        self.assertTrue(links.validate("https://evil.example/dp/%s" % ASIN_A, ASIN_A, "associates", "mysite-22"))
        self.assertTrue(links.validate("not a url", ASIN_A, "associates", "mysite-22"))    # broken
        self.assertTrue(links.validate(good, ASIN_A, "associates", ""))                    # missing tag
        self.assertTrue(links.validate(good, ASIN_A, "associates", "bad tag"))             # invalid tag
        self.assertTrue(links.validate(good, ASIN_A, "editorial_only", ""))                # tag where none allowed

    def test_associates_mode_without_tracking_id_blocks(self):
        aid, _, _ = self.ready_article()
        settings.set_many(self.ctx, OWNER, {"monetization_mode": "associates"})
        report = checks.evaluate(self.ctx, aid, articles.get(self.ctx, aid)["head_version_id"], purpose="publish")
        self.assertTrue(any("トラッキングID" in p.message for p in report.blocks))
        with self.assertRaises(EditorialError):
            settings.set_many(self.ctx, OWNER, {"tracking_id": "no spaces allowed"})

    def test_associates_links_are_tagged_and_sponsored(self):
        settings.set_many(self.ctx, OWNER, {"monetization_mode": "associates", "tracking_id": "mysite-22"})
        aid, _, _ = self.ready_article()
        self.approve_and_publish(aid)
        html = (self.config.public_out_dir / "items/test-item/index.html").read_text(encoding="utf-8")
        self.assertIn("https://www.amazon.co.jp/dp/%s?tag=mysite-22" % ASIN_A, html)
        self.assertIn('rel="sponsored noopener"', html)
        self.assertIn("Amazonのアソシエイトとして、テスト運営は適格販売により収入を得ています。", html)
        self.assertIn("アフィリエイト広告", html)

    def test_held_product_blocks(self):
        aid, pid, _ = self.ready_article()
        products.set_status(self.ctx, OWNER, pid, "held", "ASINの対応に疑い")
        report = checks.evaluate(self.ctx, aid, articles.get(self.ctx, aid)["head_version_id"])
        self.assertTrue(any(p.code == "product" for p in report.blocks))

    def test_asin_change_invalidates_approval(self):
        aid, pid, _ = self.ready_article(with_image=False)
        self.approve(aid)
        products.update(self.ctx, OWNER, pid, asin="B0TESTEEE5")
        self.assertEqual(articles.get(self.ctx, aid)["state"], "review")
        self.assertIsNone(products.get(self.ctx, pid)["asin_verified_at"])


if __name__ == "__main__":
    unittest.main()
