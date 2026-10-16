"""Socket pulls should read the page allow-list once per request."""

import io
import shutil
from contextlib import redirect_stdout
from unittest import mock

from tests.test_agent_pull import PullTestCase, run_cli
from tests.test_inbox import InboxTestCase
from lotuspod import archive, cli, db


def hide(case, name):
    rc, _, err = run_cli("render", "--name", name, "--title", "Hidden", "--hidden",
                        "--out-dir", str(case.out_dir))
    case.assertEqual(rc, 0, err)


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

        hide(self, "plan-01")
        shutil.copyfile(self.out_dir / "plan.html", self.out_dir / "plan-20.html")
        comment = self.comment("@hermes A new plan.", page="plan-20")
        with mock.patch.object(cli, "serve_allow_list", wraps=cli.serve_allow_list) as reads:
            second = self.pull("hermes")
        self.assertEqual(reads.call_count, 1)
        self.assertNotIn("plan-01", [item["page"]["name"] for item in second])
        self.assertTrue(any(item["kind"] == "comment" and
                            item["comment"]["id"] == comment["id"] for item in second))

    def test_a_pull_answers_as_without_a_catalog(self):
        self.pull("hermes")
        for page in ("plan-03", "plan-07"):
            shutil.copyfile(self.out_dir / "plan.html", self.out_dir / f"{page}.html")
            self.comment("@hermes Is the heater enough?", page=page)
        self.answer(note="Before the frost.")
        with redirect_stdout(io.StringIO()):
            archive.set_archived(self.out_dir, "plan-07", True)
        hide(self, "plan-03")
        items = self.pull("hermes")
        with mock.patch.object(self.sockets.routes, "catalog", None):
            self.assertEqual(items, self.pull("hermes"))
        self.assertNotIn("plan-03", [item["page"]["name"] for item in items])
        self.assertTrue(any(item["kind"] == "comment" and
                            item["page"]["name"] == "plan-07" for item in items))
        self.assertTrue(any(item["kind"] == "answer" and "noteComment" in item
                            for item in items))

    def test_an_empty_pull_reads_no_page_list(self):
        with mock.patch.object(cli, "serve_allow_list", wraps=cli.serve_allow_list) as reads:
            self.assertEqual(self.pull("hermes"), [])
        self.assertEqual(reads.call_count, 0)


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

        hide(self, "ops-03")
        items = self.pulled("one")
        with mock.patch.object(self.sockets.routes, "catalog", None):
            self.assertEqual(items, self.pulled("one"))
        hidden = [item for item in items if item["page"]["name"] == "ops-03"]
        self.assertEqual(len(hidden), 1)
        self.assertEqual(hidden[0]["page"],
                         {"name": "ops-03", "title": "", "owner": "operator", "revision": ""})

    def test_an_empty_inbox_reads_no_page_list(self):
        with mock.patch.object(cli, "serve_allow_list", wraps=cli.serve_allow_list) as reads:
            self.assertEqual(self.pulled("one"), [])
        self.assertEqual(reads.call_count, 0)
