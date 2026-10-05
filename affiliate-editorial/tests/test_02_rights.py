"""§8 素材の権利: quality approval never substitutes for rights; restricted images can't be edited."""

import unittest
from datetime import timedelta

from helpers import OWNER, EditorialTestCase, jpeg_with_exif, png_bytes
from editorial import approvals, articles, assets, checks, imagemeta, jobs, timeutil
from editorial.core import EditorialError


class RightsTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        self.configure_site()
        self.publish_about()
        self.pid = self.make_product()

    def _article_with(self, asset_id, slug="rights-item"):
        aid = articles.create(self.ctx, OWNER, "product", slug, [self.pid])
        return aid

    def test_unverified_asset_cannot_be_selected_even_with_good_quality(self):
        aid_asset = self.make_asset(self.pid, verified=False)
        assets.update_quality(self.ctx, OWNER, aid_asset, "good")
        art = self._article_with(aid_asset)
        with self.assertRaises(EditorialError) as cm:
            self.fill_content(art, image_ids=[aid_asset])
        self.assertIn("権利状態", str(cm.exception))

    def test_denied_and_expired_rights_block_publication(self):
        asset_id = self.make_asset(self.pid)
        aid, _, _ = self.ready_article(with_image=False)
        art = articles.get(self.ctx, aid)
        content = articles.version_content(articles.head(self.ctx, aid))
        content["images"] = [{"asset_id": asset_id, "alt": "写真", "caption": ""}]
        from editorial import polish
        vid = articles.save(self.ctx, OWNER, aid, art["head_version_id"], content)
        polish.polish_article(self.ctx, OWNER, aid, vid)
        self.approve(aid)
        # Rights denied after approval: approval invalidated, publish refused.
        assets.update_rights(self.ctx, OWNER, asset_id, {"rights_status": "denied"})
        art = articles.get(self.ctx, aid)
        self.assertEqual(art["state"], "changes")
        self.assertIsNone(approvals.active_for(self.ctx, aid))
        report = checks.evaluate(self.ctx, aid, art["head_version_id"], purpose="publish")
        self.assertTrue(any(p.code == "rights" for p in report.blocks))

    def test_license_expiry_hides_live_image_and_returns_to_review(self):
        asset_id = self.make_asset(self.pid, license_expires_at=timeutil.iso(timeutil.now() + timedelta(days=3)))
        aid = articles.create(self.ctx, OWNER, "product", "expiring-item", [self.pid])
        vid = self.fill_content(aid, image_ids=[asset_id])
        from editorial import polish
        polish.polish_article(self.ctx, OWNER, aid, vid)
        articles.submit_for_review(self.ctx, OWNER, aid)
        self.approve_and_publish(aid)
        html_path = self.config.public_out_dir / "items/expiring-item/index.html"
        self.assertIn("/media/", html_path.read_text(encoding="utf-8"))
        timeutil.advance(days=4)
        results = jobs.tick(self.ctx)
        self.assertTrue(any(r["status"] == "succeeded" for r in results), results)
        self.assertEqual(assets.get(self.ctx, asset_id)["rights_status"], "expired")
        html = html_path.read_text(encoding="utf-8")
        self.assertNotIn("/media/", html)  # the image is no longer shown
        self.assertEqual(articles.get(self.ctx, aid)["state"], "changes")

    def test_crop_requires_modification_permission(self):
        asset_id = self.make_asset(self.pid, modification_ok="0")
        art = self._article_with(asset_id)
        with self.assertRaises(EditorialError):
            self.fill_content(art, image_ids=[])
            hv = articles.head(self.ctx, art)
            c = articles.version_content(hv)
            c["images"] = [{"asset_id": asset_id, "alt": "写真", "caption": "", "crop": {"x": 10, "y": 10, "w": 50, "h": 50}}]
            articles.save(self.ctx, OWNER, art, hv["id"], c)

    def test_amazon_derived_assets_can_never_be_verified(self):
        asset_id = assets.create(self.ctx, OWNER, self.pid, "generated", png_bytes(color=b"\x01\x02\x03"))
        with self.assertRaises(EditorialError):
            assets.update_rights(self.ctx, OWNER, asset_id, {
                "derived_from_amazon": "1", "rights_status": "verified", "source": "x", "rights_holder": "x",
                "license_basis": "x", "commercial_ok": "1", "modification_ok": "1", "ai_input_ok": "1"})
        ref = assets.create(self.ctx, OWNER, self.pid, "amazon_derived", png_bytes(color=b"\x09\x09\x09"))
        self.assertIn("公開に使えません", "".join(assets.rights_problems(self.ctx, assets.get(self.ctx, ref))))

    def test_derived_asset_needs_parent_rights_and_modification_permission(self):
        parent = self.make_asset(self.pid, modification_ok="0")
        child = assets.create(self.ctx, OWNER, self.pid, "manga", png_bytes(color=b"\x05\x06\x07"))
        assets.update_rights(self.ctx, OWNER, child, {
            "rights_status": "verified", "source": "本人制作", "rights_holder": "本人", "license_basis": "自作",
            "commercial_ok": "1", "modification_ok": "1", "ai_input_ok": "0", "parent_asset_id": str(parent),
            "provenance_note": "元写真を元に本人が描いた", "is_fictional_scene": "1"})
        problems = assets.rights_problems(self.ctx, assets.get(self.ctx, child))
        self.assertTrue(any("加工許可" in p for p in problems))

    def test_verifying_requires_the_full_record(self):
        asset_id = assets.create(self.ctx, OWNER, self.pid, "self_photo", png_bytes(color=b"\x0a\x0b\x0c"))
        with self.assertRaises(EditorialError) as cm:
            assets.update_rights(self.ctx, OWNER, asset_id, {"rights_status": "verified"})
        self.assertIn("出典", str(cm.exception))

    def test_public_images_have_metadata_stripped(self):
        data = jpeg_with_exif()
        self.assertTrue(imagemeta.has_metadata(data))
        stripped = imagemeta.strip_metadata(data)
        self.assertNotIn(b"GPS-SECRET", stripped)
        self.assertNotIn(b"camera serial", stripped)
        self.assertFalse(imagemeta.has_metadata(stripped))
        png = png_bytes()
        self.assertIn(b"/Users/someone", png)
        self.assertNotIn(b"/Users/someone", imagemeta.strip_metadata(png))

    def test_quality_rejection_after_approval_invalidates(self):
        aid, pid, imgs = self.ready_article(asin="B0TESTCCC3", slug="quality-item")
        appr = self.approve(aid)
        assets.update_quality(self.ctx, OWNER, imgs[0], "rejected")
        self.assertEqual(approvals.get(self.ctx, appr)["status"], "invalidated")


if __name__ == "__main__":
    unittest.main()
