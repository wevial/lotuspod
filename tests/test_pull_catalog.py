"""Socket pulls should read the page allow-list once per request."""

import shutil
from unittest import mock

from tests.test_agent_pull import PullTestCase
from tests.test_inbox import InboxTestCase
from lotuspod import cli, db


class PullCatalogTests(PullTestCase):
    def test_a_pull_reads_the_page_list_once(self):
        self.assertEqual(self.pull("hermes"), [])
        comments = []
        for n in range(20):
            page = f"plan-{n:02d}"
            shutil.copyfile(self.out_dir / "plan.html", self.out_dir / f"{page}.html")
            comments.append(self.comment("@hermes Is the heater enough?", page=page)["id"])

        with mock.patch.object(cli, "serve_allow_list", wraps=cli.serve_allow_list) as reads:
            items = self.pull("hermes")

        self.assertEqual(len(items), 20)
        self.assertCountEqual(
            [item["comment"]["id"] for item in items if item["kind"] == "comment"],
            comments)
        self.assertEqual(reads.call_count, 1)


class InboxCatalogTests(InboxTestCase):
    def test_an_inbox_pull_reads_the_page_list_once(self):
        self.assertEqual(self.pulled("one"), [])
        database = db.Database(self.db_path)
        queued = []
        for n in range(20):
            page = f"ops-{n:02d}"
            shutil.copyfile(self.out_dir / "ops.html", self.out_dir / f"{page}.html")
            comment = self.comment("Please change the risks.", page=page)
            queued.append(database.queue(owner="operator", page=page,
                                         comment=comment["id"], ask="change the risks")["id"])

        with mock.patch.object(cli, "serve_allow_list", wraps=cli.serve_allow_list) as reads:
            items = self.pulled("one")

        self.assertEqual(len(items), 20)
        self.assertCountEqual([item["id"] for item in items if item["kind"] == "ask"], queued)
        self.assertEqual(reads.call_count, 1)
