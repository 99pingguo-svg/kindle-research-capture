"""§8 失敗と復元: partial failure is never success; retry is safe; takedown and restore work."""

import unittest
from unittest import mock

from helpers import OWNER, EditorialTestCase
from editorial import approvals, articles, db, jobs, publisher
from editorial.core import EditorialError


class FailureRestoreTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        self.configure_site()
        self.publish_about()

    def live_html(self, slug="test-item"):
        p = self.config.public_out_dir / "items" / slug / "index.html"
        return p.read_text(encoding="utf-8") if p.exists() else None

    def test_verification_failure_keeps_previous_site_and_records_error(self):
        aid, _, _ = self.ready_article()
        self.approve(aid)
        before = publisher.current_build_id(self.ctx)
        jobs.enqueue_publish(self.ctx, OWNER, aid, articles.get(self.ctx, aid)["head_version_id"])
        with mock.patch.object(publisher, "verify", side_effect=publisher.VerificationError("検証失敗", ["テスト"])):
            results = jobs.run_due(self.ctx)
        self.assertEqual(results[0]["status"], "failed")
        art = articles.get(self.ctx, aid)
        self.assertEqual(art["state"], "error")
        self.assertEqual(art["publication_status"], "unpublished")
        self.assertEqual(publisher.current_build_id(self.ctx), before)
        self.assertIsNone(self.live_html())
        # Same order, retried safely once the problem is gone.
        job = db.one(self.ctx.conn, "SELECT * FROM publish_jobs WHERE article_id = ? ORDER BY id DESC", (aid,))
        jobs.retry(self.ctx, OWNER, job["id"])
        results = jobs.run_due(self.ctx)
        self.assertEqual(results[0]["status"], "succeeded")
        self.assertEqual(results[0]["job_id"], job["id"])
        self.assertIsNotNone(self.live_html())

    def test_db_failure_after_switch_rolls_back_the_switch(self):
        aid, _, _ = self.ready_article()
        self.approve(aid)
        before = publisher.current_build_id(self.ctx)
        jobs.enqueue_publish(self.ctx, OWNER, aid, articles.get(self.ctx, aid)["head_version_id"])
        real_insert = db.insert

        def failing_insert(conn, table, values):
            if table == "publication_log":
                raise RuntimeError("disk full")
            return real_insert(conn, table, values)
        with mock.patch.object(db, "insert", side_effect=failing_insert):
            results = jobs.run_due(self.ctx)
        self.assertEqual(results[0]["status"], "failed")
        self.assertEqual(publisher.current_build_id(self.ctx), before)
        self.assertEqual(articles.get(self.ctx, aid)["publication_status"], "unpublished")

    def test_gate_failure_at_publish_time_is_not_retried_automatically(self):
        aid, pid, imgs = self.ready_article()
        self.approve(aid)
        jobs.enqueue_publish(self.ctx, OWNER, aid, articles.get(self.ctx, aid)["head_version_id"])
        # File removed from private storage between approval and publication.
        from editorial import assets
        path = assets.private_path(self.ctx, assets.get(self.ctx, imgs[0])["stored_name"])
        path.unlink()
        results = jobs.run_due(self.ctx)
        self.assertEqual(results[0]["status"], "failed")
        self.assertFalse(results[0]["retryable"])
        self.assertEqual(articles.get(self.ctx, aid)["state"], "error")

    def test_takedown_and_restore_previous_approved_version(self):
        aid, _, _ = self.ready_article()
        self.approve_and_publish(aid)
        v1 = articles.get(self.ctx, aid)["live_version_id"]
        # Publish a second version.
        content = articles.version_content(articles.head(self.ctx, aid))
        content["summary"] = "第二版の概要です"
        from editorial import polish
        v2 = articles.save(self.ctx, OWNER, aid, v1, content)
        polish.polish_article(self.ctx, OWNER, aid, v2)
        articles.submit_for_review(self.ctx, OWNER, aid)
        self.approve_and_publish(aid)
        self.assertIn("第二版の概要", self.live_html())
        # Take down.
        jobs.enqueue_unpublish(self.ctx, OWNER, aid, "確認のため")
        self.assertEqual(jobs.run_due(self.ctx)[0]["status"], "succeeded")
        self.assertIsNone(self.live_html())
        self.assertEqual(articles.get(self.ctx, aid)["publication_status"], "withdrawn")
        self.assertTrue(self.config.public_out_dir.joinpath("index.html").exists())
        # Restore the first approved version.
        restorable = [v["id"] for v in approvals.restorable_versions(self.ctx, aid)]
        self.assertIn(v1, restorable)
        jobs.enqueue_restore(self.ctx, OWNER, aid, v1, acknowledge_all=True)
        self.assertEqual(jobs.run_due(self.ctx)[0]["status"], "succeeded")
        html = self.live_html()
        self.assertNotIn("第二版の概要", html)
        self.assertEqual(articles.get(self.ctx, aid)["live_version_id"], v1)
        # History is kept.
        actions = [r["action"] for r in db.all_rows(self.ctx.conn, "SELECT action FROM publication_log WHERE "
                                                     "article_id = ? ORDER BY id", (aid,))]
        self.assertEqual(actions, ["published", "published", "withdrawn", "restored"])

    def test_restore_rechecks_rights(self):
        aid, pid, imgs = self.ready_article()
        self.approve_and_publish(aid)
        v1 = articles.get(self.ctx, aid)["live_version_id"]
        jobs.enqueue_unpublish(self.ctx, OWNER, aid, "一時停止")
        jobs.run_due(self.ctx)
        from editorial import assets
        assets.update_rights(self.ctx, OWNER, imgs[0], {"rights_status": "denied"})
        with self.assertRaises(EditorialError):
            jobs.enqueue_restore(self.ctx, OWNER, aid, v1, acknowledge_all=True)

    def test_only_previously_approved_versions_can_be_restored(self):
        aid, _, _ = self.ready_article()
        with self.assertRaises(EditorialError):
            jobs.enqueue_restore(self.ctx, OWNER, aid, articles.get(self.ctx, aid)["head_version_id"],
                                 acknowledge_all=True)


if __name__ == "__main__":
    unittest.main()
