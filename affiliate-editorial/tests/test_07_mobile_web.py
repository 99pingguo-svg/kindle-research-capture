"""§8 スマートフォン: every owner action works through plain forms (iPhone),
double submits are ignored and unsaved edits are detected."""

import re
import unittest

from helpers import ASIN_A, OWNER, EditorialTestCase, WsgiClient, png_bytes
from editorial import articles, auth, db, jobs
from editorial.web.app import App
from editorial.web.views import register


class MobileWebTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        auth.create_user(self.ctx, "owner", "correct horse battery")
        self.configure_site()
        self.publish_about()
        app = App(self.ctx)
        register(app)
        self.client = WsgiClient(app)
        self.client.login()

    def tokens(self, url):
        return self.client.form_tokens(url)

    def test_layout_is_responsive_and_guards_unsaved_changes(self):
        aid, _, _ = self.ready_article()
        page = self.client.get("/articles/%d" % aid)
        self.assertIn('name="viewport"', page.text)
        self.assertIn("data-dirty-guard", page.text)
        css = self.client.get("/static/admin.css").text
        self.assertIn("@media (max-width: 640px)", css)
        self.assertIn("--tap: 44px", css)
        js = self.client.get("/static/admin.js").text
        self.assertIn("beforeunload", js)
        self.assertIn("保存していない変更があります", js)
        # Status is shown in words, not only colour.
        self.assertIn("確認待ち", page.text)

    def test_edit_select_image_request_changes_approve_and_cancel_schedule(self):
        aid, pid, imgs = self.ready_article()
        extra = self.make_asset(pid, data=png_bytes(color=b"\x11\x22\x33"))
        # Request changes first (the owner reviewing on the phone).
        _, csrf, nonce = self.tokens("/articles/%d" % aid)
        self.client.post("/articles/%d/request-changes" % aid, {"_csrf": csrf, "_nonce": nonce, "body": "表現を柔らかく"})
        self.assertEqual(articles.get(self.ctx, aid)["state"], "changes")
        page, csrf, nonce = self.tokens("/articles/%d" % aid)
        art = articles.get(self.ctx, aid)
        content = articles.version_content(articles.head(self.ctx, aid))
        form = {"_csrf": csrf, "_nonce": nonce, "base_version_id": str(art["head_version_id"]),
                "title": content["title"] + "（スマホで修正）", "summary": content["summary"],
                "sec_key": [s["key"] for s in content["sections"]],
                "sec_heading": [s["heading"] for s in content["sections"]],
                "sec_body": [s["body"] for s in content["sections"]],
                "img_asset": [str(imgs[0])], "img_order": ["1"], "img_alt": ["外観"], "img_caption": ["本体"],
                "img_crop_x": [""], "img_crop_y": [""], "img_crop_w": [""], "img_crop_h": [""],
                "img_add": [str(extra)],
                "card_asin": [ASIN_A], "card_name": ["テスト商品"], "card_on": [ASIN_A], "card_img": [ASIN_A],
                "ev_kind": ["maker_official"], "ev_claim": ["寸法"], "ev_source": ["https://maker.example.com/spec"],
                "ev_checked": [content["info_checked_on"]], "content_basis": "research", "relationship": "none",
                "relationship_note": "", "info_checked_on": content["info_checked_on"]}
        r = self.client.post("/articles/%d/save" % aid, form)
        self.assertEqual(r.status, 303)
        head = articles.version_content(articles.head(self.ctx, aid))
        self.assertTrue(head["title"].endswith("（スマホで修正）"))
        self.assertEqual([i["asset_id"] for i in head["images"]], [imgs[0], extra])

        # Resent form (same nonce) is ignored: no extra version.
        before = len(articles.versions(self.ctx, aid))
        r = self.client.post("/articles/%d/save" % aid, form)
        self.assertEqual(r.status, 303)
        self.assertEqual(len(articles.versions(self.ctx, aid)), before)

        # The added image now has its own row; give it alt text and move it first.
        _, csrf, nonce = self.tokens("/articles/%d" % aid)
        form.update({"_csrf": csrf, "_nonce": nonce,
                     "base_version_id": str(articles.get(self.ctx, aid)["head_version_id"]),
                     "title": head["title"], "img_asset": [str(imgs[0]), str(extra)], "img_order": ["2", "1"],
                     "img_alt": ["外観", "使っている場面のイメージ"], "img_caption": ["本体", ""],
                     "img_crop_x": ["", "10"], "img_crop_y": ["", "10"], "img_crop_w": ["", "80"],
                     "img_crop_h": ["", "80"], "img_add": []})
        self.client.post("/articles/%d/save" % aid, form)
        head = articles.version_content(articles.head(self.ctx, aid))
        self.assertEqual([i["asset_id"] for i in head["images"]], [extra, imgs[0]])
        self.assertEqual(head["images"][0]["crop"], {"x": 10.0, "y": 10.0, "w": 80.0, "h": 80.0})


        # Polish, submit, approve, schedule, cancel — all via forms.
        for action in ("polish", "submit"):
            _, csrf, nonce = self.tokens("/articles/%d" % aid)
            hv = articles.get(self.ctx, aid)["head_version_id"]
            r = self.client.post("/articles/%d/%s" % (aid, action),
                                 {"_csrf": csrf, "_nonce": nonce, "base_version_id": str(hv)})
            self.assertEqual(r.status, 303, action)
        self.assertEqual(articles.get(self.ctx, aid)["state"], "review")
        page, csrf, nonce = self.tokens("/articles/%d" % aid)
        acks = re.findall(r'name="ack" value="([^"]+)"', page.text)
        hv = articles.get(self.ctx, aid)["head_version_id"]
        self.client.post("/articles/%d/approve" % aid, {"_csrf": csrf, "_nonce": nonce, "version_id": str(hv),
                                                        "ack": acks})
        self.assertEqual(articles.get(self.ctx, aid)["state"], "approved")
        _, csrf, nonce = self.tokens("/articles/%d" % aid)
        self.client.post("/articles/%d/schedule" % aid, {"_csrf": csrf, "_nonce": nonce, "version_id": str(hv),
                                                         "run_at": "2026-10-07T09:00"})
        self.assertEqual(articles.get(self.ctx, aid)["state"], "scheduled")
        job = jobs.pending_publish_job(self.ctx, aid)
        self.assertEqual(job["run_at"], "2026-10-07T00:00:00Z")
        _, csrf, nonce = self.tokens("/articles/%d" % aid)
        self.client.post("/articles/%d/cancel-schedule" % aid, {"_csrf": csrf, "_nonce": nonce})
        self.assertEqual(articles.get(self.ctx, aid)["state"], "approved")

    def test_past_schedule_is_refused_in_the_form(self):
        aid, _, _ = self.ready_article()
        self.approve(aid)
        _, csrf, nonce = self.tokens("/articles/%d" % aid)
        hv = articles.get(self.ctx, aid)["head_version_id"]
        self.client.post("/articles/%d/schedule" % aid, {"_csrf": csrf, "_nonce": nonce, "version_id": str(hv),
                                                         "run_at": "2026-10-01T09:00"})
        self.assertEqual(articles.get(self.ctx, aid)["state"], "approved")
        page = self.client.get("/articles/%d" % aid)
        self.assertIn("過去の日時", page.text)

    def test_conflicting_save_keeps_the_owners_text(self):
        aid, _, _ = self.ready_article()
        page, csrf, nonce = self.tokens("/articles/%d" % aid)
        stale = articles.get(self.ctx, aid)["head_version_id"]
        # Someone else saves first (e.g. on the Mac).
        content = articles.version_content(articles.head(self.ctx, aid))
        content["summary"] = "Macで先に保存した概要"
        articles.save(self.ctx, OWNER, aid, stale, content)
        form = {"_csrf": csrf, "_nonce": nonce, "base_version_id": str(stale), "title": "iPhoneでの入力",
                "summary": "iPhoneで書いた概要", "sec_key": ["use"], "sec_heading": ["何に使うか"],
                "sec_body": ["本文"], "content_basis": "research", "relationship": "none"}
        r = self.client.post("/articles/%d/save" % aid, form)
        self.assertEqual(r.status, 409)
        self.assertIn("iPhoneで書いた概要", r.text)       # the owner's text is not lost
        self.assertIn("Macで先に保存した概要", r.text)     # and the other change is shown

    def test_bulk_approval_via_form(self):
        a1, _, _ = self.ready_article(slug="bulk-one")
        page, csrf, nonce = self.tokens("/approve-batch")
        items = re.findall(r'name="item" value="([^"]+)"', page.text)
        acks = re.findall(r'name="ack" value="([^"]+)"', page.text)
        self.assertEqual(len(items), 1)
        r = self.client.post("/approve-batch", {"_csrf": csrf, "_nonce": nonce, "item": items, "ack": acks,
                                                "ack_all": "1", "confirm_count": "1"})
        self.assertEqual(r.status, 303)
        self.assertEqual(articles.get(self.ctx, a1)["state"], "approved")

    def test_upload_and_rights_forms(self):
        pid = self.make_product("B0TESTFFF6", "アップロード商品")
        _, csrf, nonce = self.tokens("/products/%d" % pid)
        r = self.client.post("/products/%d/assets" % pid, {"_csrf": csrf, "_nonce": nonce, "kind": "self_photo",
                                                           "title": "写真"}, files={"file": ("a.png", png_bytes())})
        self.assertEqual(r.status, 303)
        asset_id = int(r.location.rsplit("/", 1)[1])
        _, csrf, nonce = self.tokens("/assets/%d" % asset_id)
        self.client.post("/assets/%d/rights" % asset_id, {
            "_csrf": csrf, "_nonce": nonce, "kind": "self_photo", "rights_status": "verified", "source": "本人撮影",
            "rights_holder": "本人", "license_basis": "自撮り", "commercial_ok": "1", "modification_ok": "1",
            "ai_input_ok": "0", "third_party_cleared": ""})
        row = db.one(self.ctx.conn, "SELECT * FROM assets WHERE id = ?", (asset_id,))
        self.assertEqual(row["rights_status"], "verified")
        self.assertEqual(row["ai_input_ok"], 0)

    def test_unexpected_error_lets_the_owner_retry_with_the_same_form(self):
        from unittest import mock
        aid, _, _ = self.ready_article()
        articles.request_changes(self.ctx, OWNER, aid, "直してください")
        content = articles.version_content(articles.head(self.ctx, aid))
        content["summary"] += "（修正）"
        articles.save(self.ctx, OWNER, aid, articles.get(self.ctx, aid)["head_version_id"], content)
        _, csrf, nonce = self.tokens("/articles/%d" % aid)
        with mock.patch.object(articles, "submit_for_review", side_effect=RuntimeError("boom")):
            r = self.client.post("/articles/%d/submit" % aid, {"_csrf": csrf, "_nonce": nonce})
        self.assertEqual(r.status, 303)
        self.assertIn("予期しないエラー", self.client.get("/articles/%d" % aid).text)
        self.client.post("/articles/%d/submit" % aid, {"_csrf": csrf, "_nonce": nonce})
        self.assertEqual(articles.get(self.ctx, aid)["state"], "review")

    def test_each_form_gets_its_own_token(self):
        aid, _, _ = self.ready_article()
        page = self.client.get("/articles/%d" % aid)
        nonces = re.findall(r'name="_nonce" value="([^"]+)"', page.text)
        self.assertGreater(len(nonces), 3)
        self.assertEqual(len(nonces), len(set(nonces)))

    def test_csrf_is_required(self):
        aid, _, _ = self.ready_article()
        r = self.client.post("/articles/%d/submit" % aid, {"_nonce": "x"})
        self.assertEqual(r.status, 403)


if __name__ == "__main__":
    unittest.main()
