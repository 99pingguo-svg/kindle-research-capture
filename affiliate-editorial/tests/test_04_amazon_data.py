"""§8 Amazonデータ期限: expired data and API failures leave no stale image/info;
no image bytes are stored anywhere."""

import json
import unittest

from helpers import ASIN_A, OWNER, EditorialTestCase
from editorial import amazon_api, articles, checks, jobs, settings, timeutil
from editorial.config import AmazonConfig


class AmazonDataTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        self.configure_site("associates", "mysite-22")
        self.amazon.configured = True
        self.amazon.set_item(ASIN_A, image_id="41FIRSTimg")
        self.publish_about()

    def _publish_with_api_data(self):
        aid, _, _ = self.ready_article(with_image=False)
        amazon_api.refresh(self.ctx, OWNER, [ASIN_A])
        self.approve_and_publish(aid)
        return aid

    def html(self):
        return (self.config.public_out_dir / "items/test-item/index.html").read_text(encoding="utf-8")

    def test_fresh_api_image_is_shown_unmodified_with_expiry(self):
        self._publish_with_api_data()
        html = self.html()
        self.assertIn("https://m.media-amazon.com/images/I/41FIRSTimg._SL500_.jpg", html)
        self.assertIn("data-amzn-expires=", html)
        # Image bytes are never stored: no file other than our own media exists.
        out = self.config.public_out_dir
        for f in out.rglob("*"):
            if f.suffix in (".jpg", ".png", ".webp"):
                self.assertTrue(f.relative_to(out).as_posix().startswith("media/"))
        self.assertIsNone(self.ctx.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE sql LIKE '%BLOB%'").fetchone())

    def test_expired_data_is_hidden_on_next_build(self):
        self._publish_with_api_data()
        self.amazon.fail = True   # API down for more than 24 hours
        timeutil.advance(hours=25)
        results = jobs.tick(self.ctx)
        self.assertTrue(any(r["status"] == "succeeded" for r in results), results)
        html = self.html()
        self.assertNotIn("m.media-amazon.com", html)
        self.assertIn("Amazonで詳細を見る", html)  # plain text link remains

    def test_item_not_found_hides_immediately(self):
        self._publish_with_api_data()
        timeutil.advance(hours=13)
        del self.amazon.items[ASIN_A]
        jobs.tick(self.ctx)
        self.assertNotIn("m.media-amazon.com", self.html())
        self.assertEqual(amazon_api.get_item(self.ctx, ASIN_A)["status"], "not_found")

    def test_changed_image_after_approval_is_not_swapped_in(self):
        self._publish_with_api_data()
        self.amazon.set_item(ASIN_A, image_id="41SECONDimg")
        timeutil.advance(hours=13)
        jobs.tick(self.ctx)
        html = self.html()
        self.assertNotIn("41SECONDimg", html)
        self.assertNotIn("41FIRSTimg", html)
        log = self.ctx.conn.execute("SELECT image_changed FROM amazon_refresh_log ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(log["image_changed"], 1)

    def test_refresh_keeps_data_within_24_hours(self):
        self._publish_with_api_data()
        for _ in range(4):
            timeutil.advance(hours=12)
            jobs.tick(self.ctx)
            item = amazon_api.get_item(self.ctx, ASIN_A)
            self.assertTrue(amazon_api.is_fresh(item))
        self.assertIn("41FIRSTimg", self.html())

    def test_no_service_worker_or_proxy_in_output(self):
        self._publish_with_api_data()
        out = self.config.public_out_dir
        names = {f.name for f in out.rglob("*")}
        self.assertNotIn("sw.js", names)
        for f in out.rglob("*.html"):
            self.assertNotIn("serviceWorker", f.read_text(encoding="utf-8"))

    def test_rating_policy_uses_only_fresh_api_values_and_withdraws_below_threshold(self):
        settings.set_many(self.ctx, OWNER, {"rating_policy": "require_api_min", "rating_min": "4.1"})
        self.amazon.set_item(ASIN_A, image_id="41FIRSTimg", rating=4.3)
        aid = self._publish_with_api_data()
        self.assertIn("5点中 4.3", self.html())
        self.amazon.set_item(ASIN_A, image_id="41FIRSTimg", rating=3.9)
        timeutil.advance(hours=13)
        jobs.tick(self.ctx)
        art = articles.get(self.ctx, aid)
        self.assertEqual(art["publication_status"], "withdrawn")
        self.assertFalse((self.config.public_out_dir / "items/test-item/index.html").exists())

    def test_rating_policy_blocks_without_api_data(self):
        settings.set_many(self.ctx, OWNER, {"rating_policy": "require_api_min"})
        aid, _, _ = self.ready_article(with_image=False)
        report = checks.evaluate(self.ctx, aid, articles.get(self.ctx, aid)["head_version_id"])
        self.assertTrue(any(p.code == "rating" for p in report.blocks))

    def test_client_request_shape(self):
        sent = {}

        class Resp:
            def __init__(self, body):
                self.body = body

            def read(self):
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def opener(req, timeout):
            sent.setdefault("urls", []).append(req.full_url)
            sent.setdefault("headers", []).append(dict(req.header_items()))
            sent.setdefault("bodies", []).append(req.data)
            if req.full_url.endswith("/auth/o2/token"):
                return Resp(json.dumps({"access_token": "tok", "expires_in": 3600}).encode())
            return Resp(json.dumps({"itemsResult": {"items": [{
                "asin": ASIN_A, "detailPageURL": "https://www.amazon.co.jp/dp/%s" % ASIN_A,
                "images": {"primary": {"large": {"url": "https://m.media-amazon.com/images/I/41X._SL500_.jpg",
                                                 "width": 500, "height": 400}}},
                "itemInfo": {"title": {"displayValue": "公式名"}},
                "customerReviews": {"starRating": {"value": 4.2}, "count": 88}}]}}).encode())

        client = amazon_api.CreatorsApiClient(AmazonConfig(enabled=True, credential_id="id", credential_secret="sec",
                                                           version="3.3"), opener=opener)
        out = client.get_items([ASIN_A], "mysite-22")
        self.assertEqual(sent["urls"][0], "https://api.amazon.co.jp/auth/o2/token")
        self.assertEqual(sent["urls"][1], "https://creatorsapi.amazon/catalog/v1/getItems")
        headers = {k.lower(): v for k, v in sent["headers"][1].items()}
        self.assertEqual(headers["authorization"], "Bearer tok")
        self.assertEqual(headers["x-marketplace"], "www.amazon.co.jp")
        body = json.loads(sent["bodies"][1])
        self.assertEqual(body["partnerTag"], "mysite-22")
        self.assertIn("customerReviews.starRating", body["resources"])
        self.assertEqual(out[ASIN_A]["star_rating"], 4.2)
        self.assertEqual(out[ASIN_A]["review_count"], 88)


if __name__ == "__main__":
    unittest.main()
