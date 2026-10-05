"""§8 未承認と改訂: drafts/rejected cannot publish; edits invalidate approval and schedule."""

import unittest
from datetime import timedelta

from helpers import OWNER, EditorialTestCase
from editorial import approvals, articles, checks, jobs, timeutil
from editorial.core import EditorialError, GateError


class ApprovalAndRevisionTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        self.configure_site()
        self.publish_about()

    def test_draft_cannot_be_approved_or_published(self):
        aid, _, _ = self.ready_article()
        articles.request_changes(self.ctx, OWNER, aid, "見出しを直してください")
        art = articles.get(self.ctx, aid)
        self.assertEqual(art["state"], "changes")
        with self.assertRaises(EditorialError):
            approvals.approve(self.ctx, OWNER, aid, art["head_version_id"])
        with self.assertRaises(EditorialError):
            jobs.enqueue_publish(self.ctx, OWNER, aid, art["head_version_id"])

    def test_rejected_cannot_publish_and_revival_creates_new_draft(self):
        aid, _, _ = self.ready_article()
        articles.reject(self.ctx, OWNER, aid, "内容が薄い")
        art = articles.get(self.ctx, aid)
        self.assertEqual(art["state"], "rejected")
        with self.assertRaises(EditorialError):
            jobs.enqueue_publish(self.ctx, OWNER, aid, art["head_version_id"])
        report = checks.evaluate(self.ctx, aid, art["head_version_id"], purpose="publish")
        self.assertTrue(any(p.code == "state" for p in report.blocks))
        old_head = art["head_version_id"]
        articles.revive(self.ctx, OWNER, aid)
        art = articles.get(self.ctx, aid)
        self.assertEqual(art["state"], "draft")
        self.assertNotEqual(art["head_version_id"], old_head)

    def test_edit_after_approval_invalidates_approval_and_schedule(self):
        aid, _, _ = self.ready_article()
        appr_id = self.approve(aid)
        art = articles.get(self.ctx, aid)
        run_at = timeutil.iso(timeutil.now() + timedelta(days=1))
        job_id = jobs.enqueue_publish(self.ctx, OWNER, aid, art["head_version_id"], run_at=run_at)
        self.assertEqual(articles.get(self.ctx, aid)["state"], "scheduled")

        content = articles.version_content(articles.head(self.ctx, aid))
        content["sections"][0]["body"] += "（追記）"
        articles.save(self.ctx, OWNER, aid, art["head_version_id"], content)

        art = articles.get(self.ctx, aid)
        self.assertEqual(art["state"], "review")
        self.assertEqual(approvals.get(self.ctx, appr_id)["status"], "invalidated")
        self.assertEqual(jobs.get(self.ctx, job_id)["status"], "canceled")
        # Even at the scheduled time nothing is published.
        timeutil.advance(days=2)
        self.assertEqual(jobs.run_due(self.ctx), [])
        self.assertEqual(articles.get(self.ctx, aid)["publication_status"], "unpublished")

    def test_image_selection_change_also_requires_reapproval(self):
        aid, pid, imgs = self.ready_article()
        appr_id = self.approve(aid)
        art = articles.get(self.ctx, aid)
        content = articles.version_content(articles.head(self.ctx, aid))
        content["images"] = []
        articles.save(self.ctx, OWNER, aid, art["head_version_id"], content)
        self.assertEqual(approvals.get(self.ctx, appr_id)["status"], "invalidated")

    def test_published_version_stays_live_until_new_version_published(self):
        aid, _, _ = self.ready_article()
        self.approve_and_publish(aid)
        live_v = articles.get(self.ctx, aid)["live_version_id"]
        art = articles.get(self.ctx, aid)
        content = articles.version_content(articles.head(self.ctx, aid))
        content["summary"] = "改訂中の概要です"
        articles.save(self.ctx, OWNER, aid, art["head_version_id"], content)
        art = articles.get(self.ctx, aid)
        self.assertEqual(art["state"], "draft")
        self.assertEqual(art["live_version_id"], live_v)
        html = (self.config.public_out_dir / "items/test-item/index.html").read_text(encoding="utf-8")
        self.assertNotIn("改訂中の概要", html)

    def test_approval_is_bound_to_version_and_hash(self):
        aid, _, _ = self.ready_article()
        appr_id = self.approve(aid)
        appr = approvals.get(self.ctx, appr_id)
        ver = articles.version(self.ctx, appr["version_id"])
        self.assertEqual(appr["content_hash"], ver["content_hash"])
        self.assertEqual(appr["approved_by"], "owner")
        self.assertTrue(appr["context_hash"])

    def test_settings_change_requires_reapproval(self):
        aid, _, _ = self.ready_article()
        appr_id = self.approve(aid)
        from editorial import settings
        settings.set_many(self.ctx, OWNER, {"ad_label_text": "広告を含みます"})
        self.assertEqual(approvals.get(self.ctx, appr_id)["status"], "invalidated")
        self.assertEqual(articles.get(self.ctx, aid)["state"], "review")

    def test_warnings_must_be_acknowledged(self):
        aid, _, _ = self.ready_article(summary="価格は1,980円前後で手に入ります")
        art = articles.get(self.ctx, aid)
        report = checks.evaluate(self.ctx, aid, art["head_version_id"])
        self.assertTrue(any(w.code == "price" for w in report.warnings))
        with self.assertRaises(GateError):
            approvals.approve(self.ctx, OWNER, aid, art["head_version_id"], [])
        approvals.approve(self.ctx, OWNER, aid, art["head_version_id"], [w.key for w in report.warnings])

    def test_bulk_approval_shows_exact_versions_and_is_all_or_nothing(self):
        a1, _, _ = self.ready_article(slug="item-one")
        a2, _, _ = self.ready_article(asin="B0TESTBBB2", slug="item-two")
        cands = approvals.bulk_candidates(self.ctx)
        self.assertEqual({e["article_id"] for e in cands["eligible"]}, {a1, a2})
        items = [(e["article_id"], e["version_id"], e["content_hash"]) for e in cands["eligible"]]
        # One article changes after the list was shown -> nothing is approved.
        art = articles.get(self.ctx, a2)
        content = articles.version_content(articles.head(self.ctx, a2))
        content["summary"] += "（変更）"
        articles.save(self.ctx, OWNER, a2, art["head_version_id"], content)
        with self.assertRaises(EditorialError):
            approvals.bulk_approve(self.ctx, OWNER, items, True)
        self.assertEqual(articles.get(self.ctx, a1)["state"], "review")
        # Fresh list, fresh approval.
        cands = approvals.bulk_candidates(self.ctx)
        items = [(e["article_id"], e["version_id"], e["content_hash"]) for e in cands["eligible"]]
        approvals.bulk_approve(self.ctx, OWNER, items, True)
        self.assertEqual(articles.get(self.ctx, a1)["state"], "approved")

    def test_bulk_candidates_count_rights_holds(self):
        aid, pid, imgs = self.ready_article()
        from editorial import assets
        assets.update_rights(self.ctx, OWNER, imgs[0], {"rights_status": "unverified"})
        articles.submit_for_review(self.ctx, OWNER, aid) if articles.get(self.ctx, aid)["state"] in ("draft", "changes") else None
        cands = approvals.bulk_candidates(self.ctx)
        self.assertEqual(cands["excluded_rights_count"], 1)
        self.assertEqual(cands["eligible"], [])


if __name__ == "__main__":
    unittest.main()
