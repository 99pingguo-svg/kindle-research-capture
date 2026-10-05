"""§8 予約と二重実行: JST scheduling, exactly-once execution, past times refused."""

import threading
import unittest
from datetime import timedelta

from helpers import OWNER, EditorialTestCase
from editorial import articles, core, db, jobs, timeutil
from editorial.core import EditorialError


class ScheduleTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        self.configure_site()
        self.publish_about()
        self.aid, _, _ = self.ready_article()
        self.approve(self.aid)
        self.vid = articles.get(self.ctx, self.aid)["head_version_id"]

    def test_jst_input_is_stored_as_utc(self):
        when = timeutil.parse_jst_local("2026-10-06T09:00")
        self.assertEqual(timeutil.iso(when), "2026-10-06T00:00:00Z")
        self.assertEqual(timeutil.jst_label("2026-10-06T00:00:00Z"), "2026年10月6日 09:00（日本時間）")

    def test_scheduled_version_is_published_once_at_time(self):
        run_at = timeutil.iso(timeutil.parse_jst_local("2026-10-06T09:00"))
        job_id = jobs.enqueue_publish(self.ctx, OWNER, self.aid, self.vid, run_at=run_at)
        self.assertEqual(jobs.run_due(self.ctx), [])  # not yet
        timeutil.set_now(timeutil.parse_iso("2026-10-06T00:00:30Z"))
        results = jobs.run_due(self.ctx)
        self.assertEqual([r["job_id"] for r in results], [job_id])
        self.assertEqual(results[0]["status"], "succeeded")
        art = articles.get(self.ctx, self.aid)
        self.assertEqual(art["live_version_id"], self.vid)
        self.assertEqual(jobs.run_due(self.ctx), [])  # never twice
        logs = db.scalar(self.ctx.conn, "SELECT COUNT(*) FROM publication_log WHERE article_id = ?", (self.aid,))
        self.assertEqual(logs, 1)

    def test_double_submit_creates_one_job(self):
        j1 = jobs.enqueue_publish(self.ctx, OWNER, self.aid, self.vid)
        j2 = jobs.enqueue_publish(self.ctx, OWNER, self.aid, self.vid)
        self.assertEqual(j1, j2)
        self.assertEqual(db.scalar(self.ctx.conn, "SELECT COUNT(*) FROM publish_jobs WHERE action='publish' "
                                   "AND article_id = ?", (self.aid,)), 1)

    def test_past_time_is_refused(self):
        with self.assertRaises(EditorialError):
            jobs.enqueue_publish(self.ctx, OWNER, self.aid, self.vid,
                                 run_at=timeutil.iso(timeutil.now() - timedelta(minutes=5)))

    def test_two_workers_cannot_run_the_same_job(self):
        jobs.enqueue_publish(self.ctx, OWNER, self.aid, self.vid)
        ctx2 = core.open_ctx(self.config)
        ctx2.polisher = self.polisher
        ctx2.amazon = self.amazon
        claims = []
        barrier = threading.Barrier(2)

        def worker(c, name):
            barrier.wait()
            claims.append((name, jobs.claim_next(c, name)))
        t1 = threading.Thread(target=worker, args=(self.ctx, "w1"))
        t2 = threading.Thread(target=worker, args=(ctx2, "w2"))
        t1.start(); t2.start(); t1.join(); t2.join()
        got = [c for c in claims if c[1] is not None]
        self.assertEqual(len(got), 1)
        ctx2.conn.close()

    def test_lease_lock_blocks_concurrent_build(self):
        self.assertTrue(jobs.acquire_lock(self.ctx, jobs.SITE_LOCK, "w1"))
        self.assertFalse(jobs.acquire_lock(self.ctx, jobs.SITE_LOCK, "w2"))
        jobs.release_lock(self.ctx, jobs.SITE_LOCK, "w1")
        self.assertTrue(jobs.acquire_lock(self.ctx, jobs.SITE_LOCK, "w2"))

    def test_cancel_schedule_and_reschedule(self):
        run_at = timeutil.iso(timeutil.now() + timedelta(hours=2))
        jobs.enqueue_publish(self.ctx, OWNER, self.aid, self.vid, run_at=run_at)
        jobs.cancel_schedule(self.ctx, OWNER, self.aid)
        self.assertEqual(articles.get(self.ctx, self.aid)["state"], "approved")
        jobs.enqueue_publish(self.ctx, OWNER, self.aid, self.vid, run_at=run_at)
        self.assertEqual(articles.get(self.ctx, self.aid)["state"], "scheduled")

    def test_crashed_worker_lease_is_recovered(self):
        job_id = jobs.enqueue_publish(self.ctx, OWNER, self.aid, self.vid)
        claimed = jobs.claim_next(self.ctx, "dead-worker")
        self.assertEqual(claimed["id"], job_id)
        timeutil.advance(minutes=jobs.LEASE_MINUTES + 1)
        results = jobs.run_due(self.ctx)
        self.assertEqual([r["status"] for r in results], ["succeeded"])
        self.assertEqual(articles.get(self.ctx, self.aid)["publication_status"], "live")


if __name__ == "__main__":
    unittest.main()
