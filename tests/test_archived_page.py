"""Witness: serve answers an archived page marked archived - a banner under
its title bar saying when, and naming its successor, and its decision forms
disabled - while the page file stays as published; and the comments and
answers routes take nothing new on it.

Real git in temporary directories, with a local identity; pages published,
archived and unarchived with this checkout's CLI. serve is the real
`lotuspod serve`, run as tests.test_activity_witness runs it, reached with
Access assertions the test signs itself.

Run from the repo root:

    python -m unittest tests.test_archived_page -v
"""

from __future__ import annotations

import email.utils
import json
import sqlite3
import urllib.error
import urllib.request

from tests import test_activity_witness as activity_witness
from tests.test_answers_witness import assertion
from tests.test_publish_witness import Node, parse

from lotuspod import decisions  # after test_activity_witness, which puts src/ on the path

CLOSED = "Answering is closed: this page is archived."
SECTIONS = (("Alpha", "The pond freezes."), ("Beta", "The pump stops."))


def words(node: Node) -> str:
    return " ".join(node.text().split())


def next_element(node: Node) -> Node | None:
    siblings = [child for child in node.parent.children if isinstance(child, Node)]
    at = siblings.index(node)
    return siblings[at + 1] if at + 1 < len(siblings) else None


def previous_element(node: Node) -> Node | None:
    siblings = [child for child in node.parent.children if isinstance(child, Node)]
    at = siblings.index(node)
    return siblings[at - 1] if at > 0 else None


class ArchivedSite(activity_witness.ActivityWitness):
    """old, with a decision, and new published, served by `lotuspod serve`."""

    def setUp(self):
        super().setUp()
        self.repository(self.out)
        self.publish_at("old", activity_witness.page("Old plan", *SECTIONS, decision=True))
        self.publish_at("new", activity_witness.page("New plan", *SECTIONS))

    def run_cli(self, *argv: str) -> None:
        done = self.cli(*argv, "--local", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)

    def record(self) -> dict:
        return json.loads((self.out / "old.archived.json").read_text(encoding="utf-8"))

    def page(self, path: str, headers: dict | None = None):
        """A page request, signed in: status, headers and body bytes."""
        sent = {"Cf-Access-Jwt-Assertion": assertion(), **(headers or {})}
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=sent)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, error.read()

    def banner(self, data: bytes) -> Node:
        """The page's one banner, checked to sit right after its title bar."""
        root = parse(data.decode("utf-8"))
        (banner,) = root.find("div", "artifact-archived-banner")
        self.assertEqual(banner.attrs.get("role"), "note")
        before = previous_element(banner)
        self.assertEqual((before.tag, before.classes()), ("div", ["artifact-topbar"]))
        return banner


class BannerTests(ArchivedSite):
    def test_an_archived_page_is_answered_with_its_banner_meta_and_closed_forms(self):
        file = self.out / "old.html"
        self.run_cli("archive", "old", "--superseded-by", "new")
        published = file.read_bytes()
        stamp = self.record()["archivedAt"]
        self.serve()

        status, headers, data = self.page("/old.html")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertEqual(headers["Content-Security-Policy"], "frame-ancestors 'self'")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        root = parse(data.decode("utf-8"))
        metas = [meta for meta in root.find("meta")
                 if meta.attrs.get("name") == "lotuspod:archived"]
        self.assertEqual([meta.attrs.get("content") for meta in metas], [stamp])
        self.assertEqual(metas[0].parent.tag, "head")
        (main,) = root.find("main")
        self.assertIn("artifact--archived", main.classes())

        banner = self.banner(data)
        self.assertEqual(words(banner), f"Archived {stamp[:10]} · superseded by New plan")
        (time,) = banner.find("time")
        self.assertEqual((time.attrs.get("datetime"), time.text()), (stamp, stamp[:10]))
        (link,) = banner.find("a")
        self.assertEqual((link.attrs.get("href"), link.text()), ("new.html", "New plan"))

        fieldsets = [fieldset for form in root.find("form", "artifact-decision")
                     for fieldset in form.find("fieldset")]
        self.assertTrue(fieldsets)
        for fieldset in fieldsets:
            self.assertIn("disabled", fieldset.attrs)
            note = next_element(fieldset)
            self.assertEqual((note.tag, words(note)), ("p", CLOSED))

        # Served from memory: the file and its versions stay as published.
        self.assertEqual(file.read_bytes(), published)
        self.assertNotIn(b"lotuspod:archived", published)

        # The file's own time asks for a 304, which a page with no record
        # gets; the archived page is still answered whole.
        since = {"If-Modified-Since": email.utils.formatdate(file.stat().st_mtime, usegmt=True)}
        status, _, data = self.page("/old.html", since)
        self.assertEqual(status, 200)
        self.banner(data)
        new = self.out / "new.html"
        status, _, _ = self.page("/new.html", {
            "If-Modified-Since": email.utils.formatdate(new.stat().st_mtime, usegmt=True)})
        self.assertEqual(status, 304)

    def test_a_successor_not_served_markup_in_its_title_and_unarchiving(self):
        self.run_cli("archive", "old", "--superseded-by", "new")
        stamp = self.record()["archivedAt"]
        self.serve()

        self.hide("new")
        status, _, data = self.page("/old.html")
        self.assertEqual(status, 200)
        banner = self.banner(data)
        self.assertEqual(words(banner), f"Archived {stamp[:10]}")
        self.assertEqual(banner.find("a"), [])

        done = self.cli("render", "--name", "next", "--title", "Next <b>bold</b> plan",
                        "--body", "<p>The plan after.</p>", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.run_cli("archive", "old", "--superseded-by", "next")
        status, _, data = self.page("/old.html")
        self.assertEqual(status, 200)
        banner = self.banner(data)
        (link,) = banner.find("a")
        self.assertEqual((link.attrs.get("href"), link.text()), ("next.html", "Next <b>bold</b> plan"))
        self.assertEqual(banner.find("b"), [])
        self.assertEqual(words(banner),
                         f"Archived {stamp[:10]} · superseded by Next <b>bold</b> plan")

        self.run_cli("unarchive", "old")
        status, _, data = self.page("/old.html")
        self.assertEqual((status, data), (200, (self.out / "old.html").read_bytes()))
        self.assertNotIn(b"artifact-archived-banner", data)


class RefusalTests(ArchivedSite):
    def rows(self) -> dict[str, int]:
        """Each table of serve's database, and how many rows it holds."""
        with sqlite3.connect(f"file:{self.db}?mode=ro", uri=True) as connection:
            tables = [name for (name,) in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")]
            return {table: connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                    for table in tables}

    def test_an_archived_page_takes_no_new_comment_reply_or_answer(self):
        self.serve()
        root = self.comment("old", "alpha", "Is the pond deep enough?")
        status, _, reply = self.api("POST", "/api/comments",
                                    {"page": "old", "parent": root["id"], "text": "And wide?"})
        self.assertEqual(status, 201, reply)
        (form,) = decisions.read_forms((self.out / "old.html").read_text(encoding="utf-8")).values()
        self.run_cli("archive", "old", "--superseded-by", "new")
        before = self.rows()

        for label, path, body in (
                ("a new thread", "/api/comments",
                 {"page": "old", "section": "alpha", "text": "Still frozen?"}),
                ("a reply", "/api/comments",
                 {"page": "old", "parent": root["id"], "text": "One more thing."}),
                ("a thread on the decision", "/api/comments",
                 {"page": "old", "question": form.question, "text": "Why floating?"}),
                ("an answer", "/api/answers",
                 {"page": "old", "question": form.question, "version": form.version,
                  "choice": form.options[0][0], "note": ""})):
            with self.subTest(label):
                status, _, answer = self.api("POST", path, body)
                self.assertEqual((status, answer), (409, {"error": "archived"}))
                self.assertEqual(self.rows(), before)

        for resolved in (True, False):
            status, _, answer = self.api("POST", "/api/comments", {
                "page": "old", "thread": root["id"], "resolved": resolved})
            self.assertEqual(status, 200, answer)
        status, _, read = self.api("GET", "/api/comments?page=old")
        self.assertEqual(status, 200, read)
        (thread,) = read["threads"]
        self.assertEqual(thread["root"]["id"], root["id"])
        self.assertEqual([row["id"] for row in thread["replies"]], [reply["id"]])

        self.run_cli("unarchive", "old")
        status, _, row = self.api("POST", "/api/comments",
                                  {"page": "old", "section": "alpha", "text": "Thawed now."})
        self.assertEqual(status, 201, row)


if __name__ == "__main__":
    import unittest

    unittest.main()
