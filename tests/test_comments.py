"""Test suite for comment boxes and page owners: `render --comments` ends
every h2 section of a page with a comment box, `publish` does so unless told
`--no-comments`, `--owner` stamps a page only for a credential that may
publish as that handle, and the comments route takes new threads only on the
sections the page has boxes for.

The markup is witnessed by parsing it, never by matching strings, except
where a page must survive byte for byte.

Run from the repo root:

    python -m unittest tests.test_comments -v
"""

from __future__ import annotations

import http.client
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import access, cli, comments, db, machine  # noqa: E402
from tests import access_keys as keys  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
HOST = "127.0.0.1"

THREE_SECTIONS = """\
<p>Before any section.</p>
<h2>Findings</h2>
<p>The pond freezes.</p>
<h2 id="kept">Risks</h2>
<pre class="mermaid">graph LR
  A["<h2>Not a heading</h2>"] --> B</pre>
<h2>Next steps</h2>
<p>Fit a heater.</p>
"""

ONE_SECTION = "<p>A short page.</p>\n<h2>Only section</h2>\n<p>Nothing more.</p>\n"

HTML_SOURCE = """\
<h1>Pond plan</h1>
<p>What we will do.</p>
<h2>Findings</h2>
<p>The pond freezes.</p>
<h2>Risks</h2>
<p>The pump may crack.</p>
"""


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class _Page(HTMLParser):
    """A page's body as its top-level elements, each section wrapper's with
    its own direct children, and each comment box's parts, plus its scripts,
    meta tags and owner line."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.elements: list[dict] = []
        self.boxes: list[dict] = []
        self.scripts: list[str] = []
        self.meta: dict[str, str] = {}
        self.owner: list[str] | None = None
        self._depth: int | None = None
        self._box: dict | None = None
        self._reading: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        attrs = {key: value or "" for key, value in attrs}
        classes = attrs.get("class", "").split()
        if tag == "script":
            self.scripts.append(attrs.get("src", ""))
        elif tag == "meta" and "name" in attrs:
            self.meta[attrs["name"]] = attrs.get("content", "")
        elif tag == "p" and "artifact-owner" in classes:
            self.owner = []
            self._reading = self.owner
        if tag == "section" and "artifact-body" in classes:
            self._depth = 0
            return
        if self._depth is None:
            return
        if self._depth == 0:
            self.elements.append({"tag": tag, "attrs": attrs, "children": []})
        elif self._depth == 1 and "artifact-section-body" in self.elements[-1]["attrs"].get(
                "class", "").split():
            self.elements[-1]["children"].append({"tag": tag, "attrs": attrs})
        if tag == "details" and "artifact-comment" in classes:
            self._box = {"attrs": attrs, "depth": self._depth, "textareas": [], "buttons": [],
                         "forms": 0, "summary": []}
            self.boxes.append(self._box)
        elif self._box is not None:
            if tag == "summary":
                self._reading = self._box["summary"]
            elif tag == "form":
                self._box["forms"] += 1
            elif tag == "textarea":
                self._box["textareas"].append(attrs)
            elif tag == "button":
                self._box["buttons"].append({"type": attrs.get("type"), "text": []})
                self._reading = self._box["buttons"][-1]["text"]
        if tag not in ("input", "br", "img", "hr", "meta", "link"):
            self._depth += 1

    def handle_data(self, data):
        if self._reading is not None:
            self._reading.append(data)

    def handle_endtag(self, tag):
        if tag in ("p", "summary", "button"):
            self._reading = None
        if self._depth is None:
            return
        if tag == "section" and self._depth == 0:
            self._depth = None
            return
        self._depth -= 1
        if tag == "details" and self._box is not None and self._depth == self._box["depth"]:
            self._box = None


def read(page_html: str) -> _Page:
    page = _Page()
    page.feed(page_html)
    page.close()
    return page


def text(parts: list[str] | None) -> str | None:
    return None if parts is None else " ".join("".join(parts).split())


class CommentsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        self.out_dir = self.work / "artifacts"
        # serve's default database: beside the artifacts directory.
        self.db_path = self.work / db.DEFAULT_NAME
        env = mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(self.work / "none.ini")})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(machine.CREDENTIAL_ENV, None)

    def render(self, name: str, body: str, *extra: str) -> tuple[int, str]:
        rc, _, err = run_cli("render", "--name", name, "--title", name.title(),
                             "--date", "2026-01-02", "--body", body,
                             "--out-dir", str(self.out_dir), *extra)
        return rc, err

    def page(self, name: str) -> str:
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")

    def publish(self, source: Path, *extra: str) -> tuple[int, str]:
        rc, _, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                             "--local", *extra)
        return rc, err

    def source(self, name: str = "pond.html", body: str = HTML_SOURCE) -> Path:
        path = self.work / name
        path.write_text(body, encoding="utf-8")
        return path

    def credential(self, name: str, handles: list[str], ops: list[str]) -> Path:
        out = self.work / f"{name}.token"
        machine.create_credential(db.Database(self.db_path), name, handles, ops, out)
        return out


class BoxTests(CommentsTestCase):
    def test_each_of_three_sections_ends_with_its_one_box(self):
        rc, err = self.render("plan", THREE_SECTIONS, "--comments")
        self.assertEqual(rc, 0, err)
        page = read(self.page("plan"))
        self.assertEqual(len(page.boxes), 3)

        # The body's top-level elements are each section's heading and its
        # wrapper: every wrapper's last element is its box, and no section
        # holds another.
        self.assertEqual(page.elements[0]["tag"], "p")
        sections = list(zip(page.elements[1::2], page.elements[2::2]))
        self.assertEqual(len(page.elements), 1 + 2 * len(sections))
        self.assertEqual([heading["attrs"]["id"] for heading, _ in sections],
                         ["findings", "kept", "next-steps"])
        for heading, wrapper in sections:
            rest = wrapper["children"]
            with self.subTest(section=heading["attrs"]["id"]):
                self.assertEqual(heading["tag"], "h2")
                self.assertEqual(wrapper["attrs"]["class"], "artifact-section-body")
                self.assertEqual(wrapper["attrs"]["data-section"], heading["attrs"]["id"])
                found = [e for e in rest if "artifact-comment" in e["attrs"].get("class", "")]
                self.assertEqual(len(found), 1)
                self.assertIs(found[0], rest[-1])
                self.assertEqual(rest[-1]["tag"], "details")
                self.assertEqual(rest[-1]["attrs"]["data-section"], heading["attrs"]["id"])
                self.assertEqual(rest[-1]["attrs"]["data-page"], "plan")

        for found in page.boxes:
            with self.subTest(box=found["attrs"]["data-section"]):
                self.assertEqual(text(found["summary"]), "Comment")
                self.assertEqual(found["forms"], 1)
                self.assertEqual([area["name"] for area in found["textareas"]], ["text"])
                self.assertEqual([(b["type"], text(b["text"])) for b in found["buttons"]],
                                 [("submit", "Comment")])
        # The diagram's start-up module is inline; the page script the one loaded.
        self.assertEqual([src.split("?")[0] for src in page.scripts if src], [cli.PAGE_SCRIPT])
        self.assertEqual(comments.read_boxes(self.page("plan")), ["findings", "kept", "next-steps"])

    def test_one_section_gets_one_box_for_the_page_at_the_end(self):
        rc, err = self.render("short", ONE_SECTION, "--comments")
        self.assertEqual(rc, 0, err)
        page = read(self.page("short"))
        self.assertEqual([found["attrs"]["data-section"] for found in page.boxes], ["page"])
        self.assertEqual(page.elements[-1]["attrs"].get("data-section"), "page")
        self.assertEqual(page.elements[-1]["tag"], "details")

    def test_comments_without_the_outline_are_refused(self):
        rc, err = self.render("plan", THREE_SECTIONS, "--comments", "--no-outline")
        self.assertEqual(rc, 1)
        self.assertIn("--no-outline", err)
        self.assertFalse((self.out_dir / "plan.html").exists())

    def test_a_box_never_lands_inside_a_form(self):
        body = ("<h2>One</h2>\n<form><h2>Inside</h2><p>x</p></form>\n<h2>Two</h2>\n<p>y</p>\n")
        rc, err = self.render("plan", body, "--comments")
        self.assertEqual(rc, 0, err)
        self.assertEqual(comments.read_boxes(self.page("plan")), ["one", "two"])
        page = read(self.page("plan"))
        self.assertEqual([e["tag"] for e in page.elements], ["h2", "div", "h2", "div"])
        self.assertEqual([[c["tag"] for c in e["children"]] for e in page.elements[1::2]],
                         [["form", "details"], ["p", "details"]])


class WithoutCommentsTests(CommentsTestCase):
    def test_render_without_comments_is_byte_identical(self):
        body = (FIXTURES / "no_task_list.body.html").read_text(encoding="utf-8")
        rc, _, err = run_cli("render", "--name", "plain", "--title", "Plain Page",
                             "--episode", "3", "--date", "2026-01-02",
                             "--summary", "no questions here", "--body", body,
                             "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        self.assertEqual((self.out_dir / "plain.html").read_bytes(),
                         (FIXTURES / "no_task_list.expected.html").read_bytes())
        rc, err = self.render("plan", THREE_SECTIONS)
        self.assertEqual(rc, 0, err)
        page = read(self.page("plan"))
        self.assertEqual(page.boxes, [])
        # Still loaded, to fold the page's sections.
        self.assertIn(cli.PAGE_SCRIPT, [src.split("?")[0] for src in page.scripts])

    def test_publish_comments_by_default_and_not_with_no_comments(self):
        rc, err = self.publish(self.source())
        self.assertEqual(rc, 0, err)
        self.assertEqual(comments.read_boxes(self.page("pond")), ["findings", "risks"])
        rc, err = self.publish(self.source(), "--no-comments")
        self.assertEqual(rc, 0, err)
        page = read(self.page("pond"))
        self.assertEqual(page.boxes, [])
        # Still loaded, to fold the page's sections.
        self.assertIn(cli.PAGE_SCRIPT, [src.split("?")[0] for src in page.scripts])


class OwnerTests(CommentsTestCase):
    def assertOwner(self, name: str, handle: str) -> None:
        page = read(self.page(name))
        self.assertEqual(page.meta.get("lotuspod:owner"), handle)
        self.assertEqual(text(page.owner), f"Published by {handle}")

    def test_a_credential_that_may_publish_as_the_handle_stamps_it(self):
        token = self.credential("hermes", ["hermes"], ["publish", "reply"])
        rc, err = self.publish(self.source(), "--owner", "hermes", "--credential", str(token))
        self.assertEqual(rc, 0, err)
        self.assertOwner("pond", "hermes")

        rc, err = self.publish(self.source(body=HTML_SOURCE + "<p>Later.</p>\n"))
        self.assertEqual(rc, 0, err)
        self.assertOwner("pond", "hermes")
        self.assertIn("Later.", self.page("pond"))

    def test_a_page_without_an_owner_names_none(self):
        rc, err = self.publish(self.source())
        self.assertEqual(rc, 0, err)
        page = read(self.page("pond"))
        self.assertNotIn("lotuspod:owner", page.meta)
        self.assertIsNone(page.owner)

    def test_owners_the_credential_does_not_allow_write_nothing(self):
        hermes = self.credential("hermes", ["hermes"], ["publish"])
        seat = self.credential("example-seat", ["example-seat"], ["publish"])
        reader = self.credential("puller", ["hermes"], ["pull", "reply"])
        revoked = self.credential("old", ["hermes"], ["publish"])
        db.Database(self.db_path).revoke_credential("old")
        for label, extra, problem in (
            ("no credential", ("--owner", "hermes"), "needs --credential"),
            ("another handle", ("--owner", "hermes", "--credential", str(seat)),
             "may not act as hermes"),
            ("no publish", ("--owner", "hermes", "--credential", str(reader)),
             "may not publish"),
            ("bad handle", ("--owner", "Bad Handle", "--credential", str(hermes)),
             "is not a handle"),
            ("revoked", ("--owner", "hermes", "--credential", str(revoked)),
             "unknown or revoked"),
        ):
            with self.subTest(label):
                rc, err = self.publish(self.source(), *extra)
                self.assertEqual(rc, 1)
                self.assertIn(problem, err)
                self.assertFalse(self.out_dir.exists())

    def test_render_checks_the_owner_too(self):
        rc, err = self.render("plan", ONE_SECTION, "--owner", "hermes")
        self.assertEqual(rc, 1)
        self.assertIn("needs --credential", err)
        self.assertFalse(self.out_dir.exists())
        token = self.credential("ops", ["operator", "hermes"], ["publish"])
        database = self.work / "elsewhere.sqlite3"
        rc, err = self.render("plan", ONE_SECTION, "--owner", "operator",
                              "--credential", str(token), "--db", str(database))
        self.assertEqual(rc, 1)
        self.assertIn("no credentials at", err)
        self.assertFalse(database.exists())
        rc, err = self.render("plan", ONE_SECTION, "--owner", "operator",
                              "--credential", str(token), "--db", str(self.db_path))
        self.assertEqual(rc, 0, err)
        self.assertOwner("plan", "operator")


class SectionCheckTests(CommentsTestCase):
    def setUp(self) -> None:
        super().setUp()
        config = self.work / "config.ini"
        config.write_text(keys.config_text(), encoding="utf-8")
        os.environ["LOTUSPOD_CONFIG"] = str(config)
        patcher = mock.patch.object(cli._AllowListHandler, "log_message", lambda *a: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        rc, err = self.publish(self.source())
        self.assertEqual(rc, 0, err)
        verifier = access.Verifier(access.parse_config(keys.config_section()))
        server = cli._make_server(self.out_dir, HOST, 0, verifier=verifier,
                                  db_path=self.db_path)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.port = server.server_address[1]

    def ask(self, method: str, path: str, body: object = None) -> tuple[int, dict]:
        headers = {"Cf-Access-Jwt-Assertion": keys.assertion()}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection(HOST, self.port, timeout=15)
        try:
            conn.request(method, path, body=data, headers=headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            conn.close()

    def test_a_new_thread_on_a_section_the_page_has_no_box_for_is_refused(self):
        for section in ("nope", "page"):
            with self.subTest(section=section):
                self.assertEqual(
                    self.ask("POST", "/api/comments",
                             {"page": "pond", "section": section, "text": "Hello"}),
                    (400, {"error": "unknown_section"}),
                )
        self.assertEqual(self.ask("GET", "/api/comments?page=pond"),
                         (200, {"page": "pond", "threads": []}))
        status, row = self.ask("POST", "/api/comments",
                               {"page": "pond", "section": "risks", "text": "Hello"})
        self.assertEqual(status, 201, row)
        self.assertEqual(row["sectionTitle"], "Risks")

    def test_every_box_takes_a_thread_however_long_its_heading_id(self):
        long_title = "A heading long enough " * 6
        explicit = "kept-" + "x" * 200
        body = (f"<h1>Long</h1>\n<h2>{long_title}</h2>\n<p>One.</p>\n"
                f'<h2 id="{explicit}">Kept</h2>\n<p>Two.</p>\n')
        rc, err = self.publish(self.source("long.html", body))
        self.assertEqual(rc, 0, err)
        sections = comments.read_boxes(self.page("long"))
        self.assertEqual(sections, [cli.slugify(long_title), explicit])
        self.assertTrue(all(len(section) > 100 for section in sections))
        for section in sections:
            with self.subTest(section=section[:20]):
                status, row = self.ask("POST", "/api/comments",
                                       {"page": "long", "section": section, "text": "Hello"})
                self.assertEqual(status, 201, row)
                self.assertEqual(row["section"], section)
        _, got = self.ask("GET", "/api/comments?page=long")
        self.assertEqual([thread["root"]["section"] for thread in got["threads"]], sections)


if __name__ == "__main__":
    unittest.main()
