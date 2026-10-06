"""Claude's MCP access: reads only what AI may see, writes only proposals,
comments and maker notes; no approval or publication is possible."""

import io
import json
import unittest

from helpers import ASIN_A, OWNER, EditorialTestCase
from editorial import articles, auth, db, products, review_refs
from editorial.web.app import App
from editorial.web.views import register


class McpTest(EditorialTestCase):
    def setUp(self):
        super().setUp()
        self.configure_site()
        self.publish_about()
        self.app = App(self.ctx)
        register(self.app)
        self.token = auth.create_ai_token(self.ctx, "claude-test")
        self.aid, self.pid, _ = self.ready_article()
        articles.request_changes(self.ctx, OWNER, self.aid, "選ぶときのポイントに収納サイズの比較を足してください")

    def call(self, payload, token=None, origin=None, method="POST"):
        body = json.dumps(payload).encode("utf-8") if payload is not None else b""
        environ = {"REQUEST_METHOD": method, "PATH_INFO": "/mcp", "QUERY_STRING": "",
                   "CONTENT_TYPE": "application/json", "CONTENT_LENGTH": str(len(body)),
                   "wsgi.input": io.BytesIO(body), "wsgi.url_scheme": "http", "REMOTE_ADDR": "127.0.0.1"}
        if token is not False:
            environ["HTTP_AUTHORIZATION"] = "Bearer %s" % (token or self.token)
        if origin:
            environ["HTTP_ORIGIN"] = origin
        captured = {}

        def start_response(status, headers):
            captured["status"] = int(status.split()[0])
        out = b"".join(self.app(environ, start_response))
        return captured["status"], (json.loads(out) if out else None)

    def tool(self, name, **args):
        status, resp = self.call({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                  "params": {"name": name, "arguments": args}})
        self.assertEqual(status, 200)
        result = resp["result"]
        text = result["content"][0]["text"]
        return result.get("isError", False), (json.loads(text) if not result.get("isError") else text)

    def test_authentication_and_origin(self):
        self.assertEqual(self.call({"jsonrpc": "2.0", "id": 1, "method": "ping"}, token=False)[0], 401)
        self.assertEqual(self.call({"jsonrpc": "2.0", "id": 1, "method": "ping"}, token="ed_wrong")[0], 401)
        self.assertEqual(self.call({"jsonrpc": "2.0", "id": 1, "method": "ping"}, origin="https://evil.example")[0], 403)
        self.assertEqual(self.call({"jsonrpc": "2.0", "id": 1, "method": "ping"}, origin="http://localhost:8710")[0], 200)
        auth.revoke_ai_token(self.ctx, "claude-test")
        self.assertEqual(self.call({"jsonrpc": "2.0", "id": 1, "method": "ping"})[0], 401)

    def test_initialize_and_tool_list_has_no_owner_only_actions(self):
        status, resp = self.call({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                  "params": {"protocolVersion": "2025-06-18"}})
        self.assertEqual(resp["result"]["protocolVersion"], "2025-06-18")
        self.assertIn("提案", resp["result"]["instructions"])
        status, resp = self.call({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = {t["name"] for t in resp["result"]["tools"]}
        self.assertIn("propose_article", names)
        for forbidden in ("approve", "publish", "schedule", "takedown", "polish", "update_rights", "set_settings"):
            self.assertFalse(any(forbidden in n for n in names), forbidden)
        # notification -> 202, unknown method -> error
        self.assertEqual(self.call({"jsonrpc": "2.0", "method": "notifications/initialized"})[0], 202)
        _, resp = self.call({"jsonrpc": "2.0", "id": 3, "method": "nope"})
        self.assertEqual(resp["error"]["code"], -32601)

    def test_get_article_excludes_reviews_and_amazon_content(self):
        products.add_note(self.ctx, OWNER, self.pid, "own_research", "own", "収納棚の奥行きは30cmが多い")
        products.add_note(self.ctx, OWNER, self.pid, "other", "amazon", "AMAZON-DESCRIPTION-COPY")
        products.update(self.ctx, OWNER, self.pid, selection_note="PRIVATE-SELECTION-NOTE")
        f = self.tmp / "r.json"
        f.write_text(json.dumps([{"asin": ASIN_A, "body": "REVIEW-BODY-TEXT が届いてすぐ使えました"}],
                                ensure_ascii=False), encoding="utf-8")
        review_refs.import_file(self.ctx, OWNER, str(f))
        err, data = self.tool("get_article", article_id=self.aid)
        self.assertFalse(err)
        text = json.dumps(data, ensure_ascii=False)
        self.assertIn("収納棚の奥行きは30cmが多い", text)
        self.assertIn("収納サイズの比較", text)              # the change request
        for secret in ("AMAZON-DESCRIPTION-COPY", "PRIVATE-SELECTION-NOTE", "REVIEW-BODY-TEXT"):
            self.assertNotIn(secret, text)
        self.assertIn("gates", data)
        err, prod = self.tool("get_product", product_id=self.pid)
        self.assertNotIn("PRIVATE-SELECTION-NOTE", json.dumps(prod, ensure_ascii=False))

    def test_proposal_is_stored_without_changing_main_text_or_state(self):
        art = articles.get(self.ctx, self.aid)
        err, data = self.tool("get_article", article_id=self.aid)
        sections = data["current"]["sections"]
        for s in sections:
            if s["key"] == "choose":
                s["body"] += "\n- 収納場所の奥行きと本体サイズを比べてください"
        err, result = self.tool("propose_article", article_id=self.aid, base_version_id=data["base_version_id"],
                                content={"sections": sections}, note="選び方に比較を追加")
        self.assertFalse(err, result)
        self.assertEqual(result["flags"], [])
        after = articles.get(self.ctx, self.aid)
        self.assertEqual(after["head_version_id"], art["head_version_id"])
        self.assertEqual(after["state"], art["state"])
        prop = articles.version(self.ctx, result["proposal_id"])
        self.assertEqual(prop["track"], "proposal")
        self.assertEqual(prop["author_kind"], "claude")
        # The owner adopts it like any other proposal.
        articles.adopt_proposal(self.ctx, OWNER, prop["id"], after["head_version_id"])
        self.assertIn("奥行き", articles.version_content(articles.head(self.ctx, self.aid))["sections"][2]["body"])

    def test_proposals_are_validated(self):
        _, data = self.tool("get_article", article_id=self.aid)
        err, msg = self.tool("propose_article", article_id=self.aid, base_version_id=data["base_version_id"],
                             content={"state": "approved"})
        self.assertTrue(err)
        err, msg = self.tool("propose_article", article_id=self.aid, base_version_id=data["base_version_id"],
                             content={"images": [{"asset_id": 9999, "alt": "x"}]})
        self.assertTrue(err)
        err, result = self.tool("propose_article", article_id=self.aid, base_version_id=data["base_version_id"],
                                content={"summary": "レビューでは評判が良く、★4.5の人気商品です"})
        self.assertFalse(err)
        self.assertTrue({f["code"] for f in result["flags"]} >= {"review_use", "star_text"})
        err, msg = self.tool("propose_article", article_id=self.aid, base_version_id=data["base_version_id"],
                             content={"summary": "x"}, extra_arg=1)
        self.assertTrue(err)

    def test_comments_and_maker_notes(self):
        err, res = self.tool("add_comment", article_id=self.aid, body="型番の世代違いがあるので確認してください")
        self.assertFalse(err)
        row = db.one(self.ctx.conn, "SELECT * FROM review_comments WHERE id = ?", (res["comment_id"],))
        self.assertEqual(row["author"], "claude")
        err, res = self.tool("add_research_note", product_id=self.pid, body="幅30cm・重さ1.2kg（公式仕様表）",
                             source_url="https://maker.example.com/spec", checked_on="2026-10-06")
        self.assertFalse(err)
        note = db.one(self.ctx.conn, "SELECT * FROM product_notes WHERE id = ?", (res["note_id"],))
        self.assertEqual((note["origin"], note["created_by"], note["ai_input_ok"]), ("maker", "claude", 1))
        for bad in ("https://www.amazon.co.jp/dp/%s" % ASIN_A, "http://maker.example.com/spec", "https://amzn.asia/d/x"):
            err, msg = self.tool("add_research_note", product_id=self.pid, body="x", source_url=bad)
            self.assertTrue(err, bad)

    def test_events_feed(self):
        err, data = self.tool("list_events", since=0, limit=5)
        self.assertFalse(err)
        self.assertEqual(len(data["events"]), 5)
        err, more = self.tool("list_events", since=data["next"])
        self.assertTrue(all(e["id"] > data["next"] for e in more["events"]))


if __name__ == "__main__":
    unittest.main()
