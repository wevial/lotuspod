"""A comment thread anchored to a live block: the comments route checks and
stores `widget`, {id, hash, state}, threads answer it, and an agent's pull
and the default responder's prompt name the block by its title and state
with its source, saying when it has changed or left the page.

serve runs on a thread with the test Access key trusted, as in
tests.test_agent_pull; the reader posts over its port and agents use the
commands through its socket.

Run from the repo root:

    python -m unittest tests.test_widget_anchors -v
"""

from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import agents, cli, comments, core, render, responder, serve_files  # noqa: E402
from lotuspod.features.history import versions  # noqa: E402
from lotuspod.store import db  # noqa: E402
from tests.test_agent_pull import PullTestCase, run_cli  # noqa: E402

TITLE = "Merge churn by worker count"
STATE = "at 6 workers"
# The block's line: "On the block TITLE (`ID`), STATE", the state as sent.
LINE = "On the block Merge churn by worker count (`churn`), at 6 workers"
BLOCK = """\
```html live id=churn title="Merge churn by worker count"
<p id="out">at 1 worker</p>
<script>document.getElementById("out").textContent = "at 6 workers";</script>
```"""
CHANGED = BLOCK.replace('"at 6 workers"', '"at " + 6 + " workers"')
LAG = """\
```html live id=lag title=Lag
<p>Lag</p>
```"""


def churn(block: str) -> str:
    return (f"# Merge throughput\n\nHow merges go.\n\n## Throughput\n\nMerges an hour.\n\n"
            f"{block}\n\n## Latency\n\nSlow enough.\n\n{LAG}\n")


class AnchorCase(PullTestCase):
    """plan and loose as PullTestCase has them, and a page `churn` owned by
    hermes, published with --comments: block `churn` in section
    throughput, block `lag` in section latency."""

    def prepare(self) -> None:
        self.publish_churn(churn(BLOCK))

    def publish_churn(self, text: str, suffix: str = ".md") -> None:
        source = self.work / f"churn{suffix}"
        source.write_bytes(text.encode("utf-8"))
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                "--local", "--comments", "--owner", "hermes",
                                "--credential", str(self.desk))
        self.assertEqual(rc, 0, err)

    def block_hash(self, ident: str = "churn") -> str:
        page = (self.out_dir / "churn.html").read_text(encoding="utf-8")
        frame = re.search(r'<iframe class="artifact-widget" src="churn\.w-([0-9a-f]{12})\.html"'
                          rf'[^>]*data-widget="{ident}"', page)
        return frame.group(1)

    def anchor(self, **changes) -> dict:
        return {"id": "churn", "hash": self.block_hash(), "state": STATE, **changes}

    def post(self, body: dict) -> tuple[int, dict]:
        return self.reader("POST", "/api/comments", {"page": "churn", **body})

    def stored(self) -> int:
        with sqlite3.connect(self.db_path) as conn:
            return conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0]

    def anchored(self) -> dict:
        status, row = self.post({"section": "throughput", "text": "@hermes This number is off.",
                                 "widget": self.anchor()})
        self.assertEqual(status, 201, row)
        return row

    def markdown_pull(self) -> str:
        rc, out, err = self.agent("pull", "--owner", "hermes")
        self.assertEqual(rc, 0, out + err)
        return out

    def item(self, comment_id: int) -> dict:
        [found] = [item for item in self.pull("hermes")
                   if item["kind"] == "comment" and item["comment"]["id"] == comment_id]
        return found

    def check_stored_as_sent(self, first: str) -> None:
        """A thread on first, a hash the block had before its current one."""
        self.assertNotEqual(self.block_hash(), first)
        status, row = self.post({"section": "throughput", "text": "@hermes This number is off.",
                                 "widget": self.anchor(hash=first)})
        self.assertEqual(status, 201, row)
        self.assertEqual(row["widget"], self.anchor(hash=first))
        [thread] = self.threads("churn")
        self.assertEqual(thread["root"]["widget"]["hash"], first)
        # The pull says the block has changed since, as for a thread stored
        # before the change.
        self.assertEqual(self.item(row["id"])["block"]["status"], "changed")
        self.assertIn("The block has changed since this comment", self.markdown_pull())

    def check_never_had_refused(self) -> None:
        before = self.stored()
        lag = self.block_hash("lag")
        for name, hash_ in (("no file", "0" * 12), ("another block's", lag)):
            with self.subTest(name):
                status, payload = self.post({"section": "throughput", "text": "Off.",
                                             "widget": self.anchor(hash=hash_)})
                self.assertEqual((status, payload), (409, {"error": "stale_widget"}))
        self.assertEqual(self.stored(), before)


class RouteTests(AnchorCase):
    def test_a_thread_on_a_block_carries_its_anchor_and_its_replies_none(self):
        anchor = self.anchor()
        row = self.anchored()
        self.assertEqual(row["widget"], anchor)
        status, reply = self.post({"parent": row["id"], "text": "Which step?"})
        self.assertEqual(status, 201, reply)
        self.assertIsNone(reply["widget"])

        [thread] = self.threads("churn")
        self.assertEqual(thread["root"]["id"], row["id"])
        self.assertEqual(thread["root"]["widget"], anchor)
        self.assertEqual([r["widget"] for r in thread["replies"]], [None])

    def test_a_thread_without_a_block_answers_widget_null(self):
        status, row = self.post({"section": "throughput", "text": "Plain."})
        self.assertEqual(status, 201, row)
        self.assertIsNone(row["widget"])
        self.assertIsNone(self.threads("churn")[0]["root"]["widget"])

    def test_an_empty_state_is_kept(self):
        status, row = self.post({"section": "throughput", "text": "Hm.",
                                 "widget": self.anchor(state="")})
        self.assertEqual(status, 201, row)
        self.assertEqual(row["widget"]["state"], "")

    def test_each_bad_anchor_is_refused_and_stores_nothing(self):
        root = self.anchored()
        before = self.stored()
        text = {"section": "throughput", "text": "Off."}
        quote = {"exact": "Merges an hour.", "prefix": "", "suffix": ""}
        cases = [
            ("extra key", {**text, "widget": {**self.anchor(), "step": 6}},
             400, "invalid_body"),
            ("11 digits", {**text, "widget": self.anchor(hash=self.block_hash()[:11])},
             400, "invalid_body"),
            ("81 characters", {**text, "widget": self.anchor(state="x" * 81)},
             400, "invalid_body"),
            ("newline", {**text, "widget": self.anchor(state="at 6\nworkers")},
             400, "invalid_body"),
            ("beside a quote", {**text, "quote": quote, "widget": self.anchor()},
             400, "invalid_body"),
            ("on a reply", {"parent": root["id"], "text": "Off.", "widget": self.anchor()},
             400, "invalid_body"),
            ("unknown id", {**text, "widget": self.anchor(id="nope")},
             400, "unknown_widget"),
            ("another section", {"section": "latency", "text": "Off.",
                                 "widget": self.anchor()},
             400, "unknown_widget"),
            ("another hash", {**text, "widget": self.anchor(hash="0" * 12)},
             409, "stale_widget"),
        ]
        for name, body, code, error in cases:
            with self.subTest(name):
                status, payload = self.post(body)
                self.assertEqual((status, payload), (code, {"error": error}))
                self.assertEqual(self.stored(), before)
        [thread] = self.threads("churn")
        self.assertEqual(thread["replies"], [])

    def test_a_block_s_section_is_its_wrapper_s_or_the_page_s(self):
        page = cli.api_page(self.out_dir, "churn")
        self.assertEqual({ident: (block.title, block.section)
                          for ident, block in page.widgets.items()},
                         {"churn": (TITLE, "throughput"), "lag": ("Lag", "latency")})
        self.assertEqual(page.widgets["churn"].hash, self.block_hash())
        # Before the first heading: the whole page.
        self.publish_churn(churn(BLOCK).replace("How merges go.\n", "How merges go.\n\n" + LAG
                                                 .replace("lag", "intro") + "\n"))
        page = cli.api_page(self.out_dir, "churn")
        self.assertEqual(page.widgets["intro"].section, comments.WHOLE_PAGE)
        # A page whose only box is `page`.
        self.publish_churn(f"# Merge throughput\n\n{BLOCK}\n")
        page = cli.api_page(self.out_dir, "churn")
        self.assertEqual(page.widgets["churn"].section, comments.PAGE_SECTION)
        status, row = self.post({"section": comments.PAGE_SECTION, "text": "Off.",
                                 "widget": self.anchor()})
        self.assertEqual(status, 201, row)
        # A page with no blocks has none.
        self.assertEqual(cli.api_page(self.out_dir, "plan").widgets, {})


class EarlierVersionTests(AnchorCase):
    """The page's site is the top of its own git repository, so each publish
    is a version of it: churn published with BLOCK, then with CHANGED."""

    def prepare(self) -> None:
        for argv in (["init", "-q", "-b", "main"], ["config", "user.name", "Anchor tests"],
                     ["config", "user.email", "anchors@example.com"]):
            subprocess.run(["git", "-C", str(self.out_dir), *argv], check=True,
                           capture_output=True)
        self.publish_churn(churn(BLOCK))
        self.first = self.block_hash()
        self.publish_churn(churn(CHANGED))
        # As a page published before its blocks' hashes were kept beside it:
        # only the history knows the first one.
        (self.out_dir / f"churn{render.BLOCKS_SUFFIX}").unlink()

    def test_a_hash_the_block_had_in_an_earlier_version_is_stored_as_sent(self):
        self.check_stored_as_sent(self.first)

    def test_a_hash_older_than_the_versions_a_list_holds_is_taken_too(self):
        # A list holding only the newest version leaves the first one out.
        with mock.patch.object(versions, "MAX_VERSIONS", 1):
            status, payload = self.reader("GET", "/api/versions?page=churn")
            self.assertEqual(status, 200, payload)
            self.assertEqual(len(payload["versions"]), 1)
            status, row = self.post({"section": "throughput", "text": "Off.",
                                     "widget": self.anchor(hash=self.first)})
        self.assertEqual(status, 201, row)
        self.assertEqual(row["widget"]["hash"], self.first)

    def test_a_hash_the_block_never_had_is_still_refused(self):
        self.check_never_had_refused()


class WithoutGitTests(AnchorCase):
    """The page's site is no git repository, so it has no versions: churn
    published with BLOCK, then with CHANGED, its hashes kept beside it."""

    def prepare(self) -> None:
        self.publish_churn(churn(BLOCK))
        self.first = self.block_hash()
        self.publish_churn(churn(CHANGED))

    def test_the_site_has_no_versions(self):
        self.assertFalse(core.is_repository_top(self.out_dir))
        status, payload = self.reader("GET", "/api/versions?page=churn")
        self.assertEqual((status, payload.get("versions")), (200, []))

    def test_a_hash_the_block_had_in_an_earlier_publish_is_stored_as_sent(self):
        self.assertEqual(cli.api_page(self.out_dir, "churn").widgets["churn"].earlier,
                         {self.first, self.block_hash()})
        self.check_stored_as_sent(self.first)

    def test_a_hash_the_block_never_had_is_still_refused(self):
        self.check_never_had_refused()

    def test_the_kept_hashes_are_never_served(self):
        self.assertTrue((self.out_dir / f"churn{render.BLOCKS_SUFFIX}").is_file())
        self.assertNotIn(f"churn{render.BLOCKS_SUFFIX}", serve_files.serve_allow_list(self.out_dir))


class UpgradeWithoutGitTests(AnchorCase):
    """churn published with BLOCK as before its blocks' hashes were kept
    beside it, on a site without git, then republished with CHANGED."""

    def prepare(self) -> None:
        self.publish_churn(churn(BLOCK))
        self.first = self.block_hash()
        (self.out_dir / f"churn{render.BLOCKS_SUFFIX}").unlink()
        self.publish_churn(churn(CHANGED))

    def test_the_outgoing_page_s_hash_is_kept_at_the_republish(self):
        self.assertFalse(core.is_repository_top(self.out_dir))
        self.assertEqual(render.kept_block_hashes(self.out_dir, "churn")["churn"],
                         [self.first, self.block_hash()])
        self.check_stored_as_sent(self.first)

    def test_a_hash_the_block_never_had_is_still_refused(self):
        self.check_never_had_refused()

class PullAndPromptTests(AnchorCase):
    def test_the_pull_names_the_block_its_state_and_its_source(self):
        anchor = self.anchor()
        row = self.anchored()
        kept = (self.out_dir / "churn.md").read_text(encoding="utf-8")
        self.assertIn(BLOCK, kept)

        item = self.item(row["id"])
        self.assertEqual(item["widget"], anchor)
        self.assertEqual(item["block"], {"title": TITLE, "source": BLOCK, "status": "current"})

        text = self.markdown_pull()
        self.assertIn(LINE, text)
        self.assertIn(agents.fence(BLOCK), text)
        self.assertNotIn("The block has changed", text)
        self.assertNotIn("no longer on the page", text)

    def test_a_changed_block_and_a_removed_one_are_said_so(self):
        row = self.anchored()
        self.publish_churn(churn(CHANGED))
        item = self.item(row["id"])
        self.assertEqual(item["block"], {"title": TITLE, "source": CHANGED, "status": "changed"})
        text = self.markdown_pull()
        self.assertIn(LINE, text)
        self.assertIn("The block has changed since this comment", text)
        self.assertIn(agents.fence(CHANGED), text)

        self.publish_churn(churn("No block here."))
        item = self.item(row["id"])
        self.assertEqual(item["block"], {"title": "", "source": "", "status": "removed"})
        text = self.markdown_pull()
        self.assertIn("The block is no longer on the page", text)
        self.assertNotIn("The block has changed", text)
        self.assertNotIn(agents.fence(CHANGED), text.split("## Source of")[0])

    def test_an_empty_state_leaves_out_its_words(self):
        status, row = self.post({"section": "throughput", "text": "@hermes Odd.",
                                 "widget": self.anchor(state="")})
        self.assertEqual(status, 201, row)
        text = self.markdown_pull()
        self.assertIn(f"On the block {TITLE} (`churn`)\n", text)

    def test_the_responder_s_prompt_names_the_block_as_the_pull_does(self):
        row = self.anchored()
        item = self.item(row["id"])
        prompt = responder.prompt(item)
        self.assertIn(LINE, prompt)
        self.assertIn(agents.fence(BLOCK), prompt)
        section = prompt.split("### The thread it belongs to")[0]
        self.assertIn(agents.fence(BLOCK), section)

        self.publish_churn(churn(CHANGED))
        prompt = responder.prompt(self.item(row["id"]))
        self.assertIn("The block has changed since this comment", prompt)
        self.assertIn(agents.fence(CHANGED), prompt)

    def test_the_state_is_shown_exactly_as_sent(self):
        state = "  at\u00a06  workers  "
        status, row = self.post({"section": "throughput", "text": "@hermes Odd.",
                                 "widget": self.anchor(state=state)})
        self.assertEqual(status, 201, row)
        line = f"On the block {TITLE} (`churn`), {state}\n"
        self.assertIn(line, self.markdown_pull())
        self.assertIn(line, responder.prompt(self.item(row["id"])))

    def test_a_thread_without_a_block_has_no_block_lines(self):
        status, row = self.post({"section": "throughput", "text": "@hermes Plain."})
        self.assertEqual(status, 201, row)
        item = self.item(row["id"])
        self.assertNotIn("widget", item)
        self.assertNotIn("block", item)
        self.assertNotIn("On the block", self.markdown_pull())
        self.assertNotIn("On the block", responder.prompt(item))


class SourceTests(AnchorCase):
    """The block is found in the kept source as publish found it."""

    def test_a_source_with_other_line_endings_still_pulls(self):
        self.publish_churn("# Churn\n\n## Throughput\n\n"
                           "```html live id=churn title=Churn\r<p>x</p>\r```\n\n"
                           "## Latency\n\nMore.\n")
        status, row = self.post({"section": "throughput", "text": "@hermes Off.",
                                 "widget": self.anchor(state="")})
        self.assertEqual(status, 201, row)
        self.assertEqual(self.item(row["id"])["block"],
                         {"title": "Churn", "source": "```html live id=churn title=Churn\n"
                                                      "<p>x</p>\n```",
                          "status": "current"})
        self.assertIn("On the block Churn (`churn`)\n", self.markdown_pull())

    def test_an_html_source_numbers_its_blocks_without_its_h1(self):
        visible = '<template class="lotuspod-live"><p>visible widget</p></template>'
        self.publish_churn('<h1>Churn<template class="lotuspod-live"><p>heading widget</p>'
                           f'</template></h1>\n<p>Intro.</p>\n{visible}\n', ".html")
        [ident] = cli.api_page(self.out_dir, "churn").widgets
        status, row = self.post({"section": comments.PAGE_SECTION, "text": "@hermes Off.",
                                 "widget": {"id": ident, "hash": self.block_hash(ident),
                                            "state": ""}})
        self.assertEqual(status, 201, row)
        self.assertEqual(self.item(row["id"])["block"]["source"], visible)

    def test_a_frame_in_a_template_is_not_a_block(self):
        decoy = ('<template><iframe class="artifact-widget" data-widget="churn" '
                 'src="churn.w-aaaaaaaaaaaa.html" title="Decoy"></iframe></template>')
        page = self.out_dir / "churn.html"
        served = page.read_text(encoding="utf-8")
        page.write_text(served.replace("<p>How merges go.</p>", decoy + "<p>How merges go.</p>"),
                        encoding="utf-8")
        self.assertIn(decoy, page.read_text(encoding="utf-8"))
        block = cli.api_page(self.out_dir, "churn").widgets["churn"]
        self.assertEqual((block.title, block.section), (TITLE, "throughput"))
        self.assertNotEqual(block.hash, "a" * 12)


    def test_a_frame_in_a_noscript_is_not_a_block(self):
        decoy = ('<noscript><iframe class="artifact-widget" data-widget="churn" '
                 'src="churn.w-aaaaaaaaaaaa.html" title="Decoy"></iframe></noscript>')
        page = self.out_dir / "churn.html"
        served = page.read_text(encoding="utf-8")
        page.write_text(served.replace("<p>How merges go.</p>", decoy + "<p>How merges go.</p>"),
                        encoding="utf-8")
        self.assertIn(decoy, page.read_text(encoding="utf-8"))
        block = cli.api_page(self.out_dir, "churn").widgets["churn"]
        self.assertEqual((block.title, block.section, block.hash),
                         (TITLE, "throughput", self.block_hash()))

    def test_a_div_in_a_template_opens_no_section(self):
        inert = "<template><div>inert</template>"
        page = self.out_dir / "churn.html"
        served = page.read_text(encoding="utf-8")
        page.write_text(served.replace("<p>Merges an hour.</p>", "<p>Merges an hour.</p>" + inert),
                        encoding="utf-8")
        self.assertIn(inert, page.read_text(encoding="utf-8"))
        widgets = cli.api_page(self.out_dir, "churn").widgets
        self.assertEqual((widgets["churn"].section, widgets["lag"].section),
                         ("throughput", "latency"))


class SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / db.DEFAULT_NAME

    def main_database(self) -> None:
        """A database at main's schema, one below this one's, with comments."""
        database = db.Database(self.path)
        root = database.add_comment(page="plan", section="risks", section_title="Risks",
                                    revision="r1", text="First.", quote=None,
                                    actor={"kind": "human", "email": "a@example.com"})
        database.add_reply(page="plan", parent=root["id"], revision="r1",
                           sections={"risks": "Risks"}, text="Second.",
                           actor={"kind": "human", "email": "a@example.com"})
        with sqlite3.connect(self.path) as conn:
            conn.execute("ALTER TABLE comments DROP COLUMN widget")
            conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION - 1}")

    def test_main_s_database_migrates_and_its_comments_answer_widget_null(self):
        self.main_database()
        with sqlite3.connect(self.path) as conn:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(comments)")]
        self.assertNotIn("widget", columns)
        [thread] = db.Database(self.path).threads("plan")
        self.assertIsNone(thread["root"]["widget"])
        self.assertEqual([row["widget"] for row in thread["replies"]], [None])
        with sqlite3.connect(self.path) as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0],
                             db.SCHEMA_VERSION)
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM comments WHERE widget IS NOT NULL").fetchone()[0], 0)

    def test_a_newer_database_is_refused(self):
        self.main_database()
        with sqlite3.connect(self.path) as conn:
            conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION + 1}")
        with self.assertRaises(sqlite3.DatabaseError):
            db.Database(self.path).threads("plan")


if __name__ == "__main__":
    unittest.main()
