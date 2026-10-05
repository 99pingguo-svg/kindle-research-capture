"""§8 表示と検索設定: readable HTML, disclosures, sponsored links, canonical,
sitemap, alt text and structured data consistent with the page."""

import json
import re
import unittest

from helpers import OWNER, EditorialTestCase


class DisplaySeoTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        self.configure_site("associates", "mysite-22")
        self.publish_about()
        self.aid, _, _ = self.ready_article()
        self.approve_and_publish(self.aid)
        self.out = self.config.public_out_dir
        self.html = (self.out / "items/test-item/index.html").read_text(encoding="utf-8")

    def test_article_page_is_complete_html(self):
        h = self.html
        self.assertIn('<html lang="ja">', h)
        self.assertIn('<meta name="viewport"', h)
        self.assertIn("<title>テスト商品の選び方と注意点｜テストの選び方ノート</title>", h)
        self.assertIn('<link rel="canonical" href="https://example.com/items/test-item/">', h)
        self.assertIn('<meta name="description"', h)
        self.assertNotIn("noindex", h)
        for heading in ("何に使うか", "向く人・向かない人", "選ぶときのポイント", "購入前の注意", "確認できた仕様"):
            self.assertIn("<h2>%s</h2>" % heading, h)

    def test_disclosures_are_at_the_top_and_site_wide(self):
        h = self.html
        top = h.index('class="disclosure-box"')
        self.assertLess(top, h.index("<h1"))
        self.assertIn("この記事にはアフィリエイト広告（Amazonアソシエイト）を含みます。", h[top:h.index("<h1")])
        self.assertIn("AIにより作成", h[top:h.index("<h1")])
        self.assertIn("Amazonのアソシエイトとして、テスト運営は適格販売により収入を得ています。", h)
        index = (self.out / "index.html").read_text(encoding="utf-8")
        self.assertIn("Amazonのアソシエイトとして、テスト運営は適格販売により収入を得ています。", index)

    def test_links_are_sponsored_and_images_have_alt(self):
        for tag in re.findall(r"<a [^>]*amazon\.co\.jp[^>]*>", self.html):
            self.assertIn('rel="sponsored noopener"', tag)
        for tag in re.findall(r"<img [^>]*>", self.html):
            self.assertRegex(tag, r'alt="[^"]+"')

    def test_structured_data_matches_the_page(self):
        data = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', self.html, re.S).group(1))
        self.assertEqual(data["@type"], "Article")
        self.assertIn(data["headline"], self.html)
        self.assertEqual(data["mainEntityOfPage"], "https://example.com/items/test-item/")
        self.assertNotIn("aggregateRating", json.dumps(data))
        self.assertNotIn("review", json.dumps(data).lower())

    def test_sitemap_and_robots(self):
        sitemap = (self.out / "sitemap.xml").read_text(encoding="utf-8")
        self.assertIn("<loc>https://example.com/items/test-item/</loc>", sitemap)
        self.assertIn("<loc>https://example.com/about/</loc>", sitemap)
        robots = (self.out / "robots.txt").read_text(encoding="utf-8")
        self.assertIn("Sitemap: https://example.com/sitemap.xml", robots)

    def test_dates_are_not_refreshed_by_rebuilds(self):
        from editorial import jobs, timeutil
        before = re.search(r'"dateModified": "([^"]+)"', self.html).group(1)
        timeutil.advance(hours=13)
        jobs.enqueue_refresh(self.ctx, OWNER)
        jobs.run_due(self.ctx)
        after_html = (self.out / "items/test-item/index.html").read_text(encoding="utf-8")
        self.assertEqual(re.search(r'"dateModified": "([^"]+)"', after_html).group(1), before)

    def test_no_price_or_rating_is_shown_by_default(self):
        self.assertNotIn("円", re.sub(r"<[^>]+>", "", self.html).replace("価格・在庫", ""))
        self.assertNotIn("5点中", self.html)

    def test_about_page_has_operator_information(self):
        about = (self.out / "about/index.html").read_text(encoding="utf-8")
        for text in ("運営者", "編集 花子", "https://example.com/contact"):
            self.assertIn(text, about)


if __name__ == "__main__":
    unittest.main()
