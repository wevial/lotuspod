"""Reference cards: `lotuspod publish --refs FILE` takes the details of the
tickets and pull requests a page names from a JSON file, marks each mention
in the body a button (refs.mark_refs) and writes one hidden card per key
used after the body. A refs file that breaks a rule is refused before
anything is written; the entries used are kept in NAME.refs.json beside the
page, which a republish without --refs draws again and --no-refs removes,
and which serve never answers.

Run from the repo root:

    python -m unittest tests.test_refs -v
"""

from __future__ import annotations

import http.client
import io
import json
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import cli, refs  # noqa: E402

STAMP = "2026-10-09T12:00:00Z"
ENTRIES = {
    "HOLO-175": {
        "title": "Story follow-ups become proposals", "project": "Holophyte",
        "status": "In review", "tone": "review",
        "pr": {"text": "PR #475 on GitHub", "href": "https://example.com/pr/475"},
        "board": {"text": "HOLO-175 on the board", "href": "https://example.com/board/HOLO-175"},
    },
    "HOLO-171": {"title": "a < b & c > d", "project": "Holophyte", "status": "Merged",
                 "tone": "merged"},
    "#2266": {"title": "Cards for references", "status": "Open", "tone": "progress",
              "pr": {"text": "PR #2266", "href": "https://example.com/pr/2266"}},
    "relos#2266": {"title": "Relos's own 2266", "updated": "2026-10-08T09:30:00Z"},
}
BODY = """\
<p>HOLO-175 waits on HOLO-175's review, and #2266 is not relos#2266. LOTUS-95 is elsewhere.</p>
<p>Not these: <code>HOLO-175</code>, <a href="https://example.com">HOLO-175</a>,
XHOLO-175, HOLO-1750, HOLO-175x and see/HOLO-175.</p>
<h2>HOLO-175</h2>
<p>The end.</p>
"""
_BUTTON = re.compile(r'<button type="button" class="artifact-ref" data-ref="[^"]*" '
                     r'aria-expanded="false" aria-controls="[^"]*">([^<]*)</button>')


def run_cli(*argv: str) -> tuple[int, str, str]:
    """main's exit status, an argparse refusal's included, and its output."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        try:
            rc = cli.main(list(argv))
        except SystemExit as exc:
            rc = exc.code if isinstance(exc.code, int) else 1
    return rc, out.getvalue(), err.getvalue()


class _Page(HTMLParser):
    """Each button.artifact-ref's data-ref, and each card's id, attributes
    and text by element class, with every time's datetime in order."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.buttons: list[str] = []
        self.cards: dict[str, dict] = {}
        self._card: dict | None = None
        self._depth = 0
        self._class = ""

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = {key: value or "" for key, value in attrs}
        classes = values.get("class", "").split()
        if tag == "button" and "artifact-ref" in classes:
            self.buttons.append(values.get("data-ref", ""))
        if tag == "div" and "artifact-ref-card" in classes:
            self._card = {"attrs": values, "text": {}, "times": [], "hrefs": []}
            self.cards[values["id"]] = self._card
            self._depth = 0
        if self._card is None:
            return
        if tag == "div":
            self._depth += 1
        if classes:
            self._class = classes[0]
        if tag == "time":
            self._card["times"].append(values.get("datetime", ""))
        if tag == "a":
            self._card["hrefs"].append(values.get("href", ""))

    def handle_data(self, data: str) -> None:
        if self._card is not None and self._class:
            text = self._card["text"]
            text[self._class] = text.get(self._class, "") + data

    def handle_endtag(self, tag: str) -> None:
        self._class = ""
        if self._card is not None and tag == "div":
            self._depth -= 1
            if not self._depth:
                self._card = None


def parsed(page: str) -> _Page:
    parser = _Page()
    parser.feed(page)
    parser.close()
    return parser


class MarkRefsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.entries = refs.check_refs({"refs": ENTRIES})
        self.body, self.block, self.named = refs.mark_refs(BODY, self.entries, STAMP)

    def test_each_whole_mention_in_text_is_a_button_and_nothing_else_is(self):
        self.assertEqual(parsed(self.body).buttons, ["HOLO-175", "HOLO-175", "#2266",
                                                     "relos#2266"])
        self.assertIn("LOTUS-95 is elsewhere", self.body)
        for left in ("<code>HOLO-175</code>", '<a href="https://example.com">HOLO-175</a>',
                     "XHOLO-175,", "HOLO-1750,", "HOLO-175x", "see/HOLO-175.",
                     "<h2>HOLO-175</h2>"):
            self.assertIn(left, self.body)

    def test_taking_the_buttons_out_gives_back_the_body_byte_for_byte(self):
        self.assertEqual(_BUTTON.sub(r"\1", self.body), BODY)

    def test_only_keys_the_body_names_make_a_card(self):
        self.assertEqual(self.named, ["HOLO-175", "#2266", "relos#2266"])
        cards = parsed(self.block).cards
        self.assertEqual(sorted(cards), ["ref-2266", "ref-holo-175", "ref-relos-2266"])
        self.assertNotIn("HOLO-171", self.block)
        for card in cards.values():
            self.assertEqual(card["attrs"]["role"], "dialog")
            self.assertIn("hidden", card["attrs"])

    def test_a_letter_or_digit_of_any_script_or_across_a_comment_joins_a_word(self):
        body = ("<p>\u00e9HOLO-175 HOLO-175\u00e9 \u0661HOLO-175 HOLO-175\u0661 "
                "HOLO-175<!--c-->x x<!-- c -->HOLO-175 HOLO-175<!--c-->, "
                "\u00e9 HOLO-175.</p>")
        marked, _, _ = refs.mark_refs(body, self.entries, STAMP)
        self.assertEqual(parsed(marked).buttons, ["HOLO-175", "HOLO-175"])
        self.assertIn('HOLO-175</button><!--c-->, ', marked)
        self.assertIn('\u00e9 <button type="button"', marked)
        self.assertEqual(_BUTTON.sub(r"\1", marked), body)

    def test_an_updated_time_is_taken_only_in_iso_8601_form(self):
        for good in ("2026-10-09", "2026-10-09T12:00", "2026-10-09T12:00:00Z",
                     "2026-10-09T12:00:00.5+02:00"):
            with self.subTest(updated=good):
                checked = refs.check_refs({"refs": {"HOLO-175": {"title": "t", "updated": good}}})
                self.assertEqual(checked["HOLO-175"]["updated"], good)
        for bad in ("2026-10-09X12:00:00", "2026-10-09 12:00:00", "20261009", "2026-W41",
                    "2026-13-01", "2026-10-09T25:00", "\u0662026-10-09"):
            with self.subTest(updated=bad):
                with self.assertRaises(RuntimeError) as caught:
                    refs.check_refs({"refs": {"HOLO-175": {"title": "t", "updated": bad}}})
                self.assertIn("HOLO-175 updated", str(caught.exception))

    def test_a_body_naming_none_is_left_as_written_with_no_cards(self):
        self.assertEqual(refs.mark_refs("<p>LOTUS-95 only.</p>", self.entries, STAMP),
                         ("<p>LOTUS-95 only.</p>", "", []))

    def test_a_card_holds_its_entry_in_order_escaped(self):
        body, block, _ = refs.mark_refs("<p>HOLO-171 and #2266, relos#2266.</p>",
                                        self.entries, STAMP)
        self.assertIn("a &lt; b &amp; c &gt; d", block)
        cards = parsed(block).cards
        ticket = cards["ref-holo-171"]
        self.assertEqual(ticket["text"]["artifact-ref-card-title"], "a < b & c > d")
        self.assertEqual(ticket["text"]["artifact-ref-card-key"], "Holophyte \u00b7 HOLO-171")
        self.assertEqual(ticket["attrs"]["data-tone"], "merged")
        self.assertEqual(ticket["text"]["artifact-ref-chip"], "Merged")
        self.assertEqual(ticket["text"]["artifact-ref-card-nopr"], "No PR yet")
        pull = cards["ref-2266"]
        self.assertEqual(pull["hrefs"], ["https://example.com/pr/2266"])
        self.assertNotIn("artifact-ref-card-nopr", pull["text"])
        self.assertNotIn("No PR yet", block.split('id="ref-2266"')[1].split("</div>")[0])
        relos = cards["ref-relos-2266"]
        self.assertEqual(relos["attrs"]["data-tone"], "waiting")
        self.assertEqual(relos["times"], ["2026-10-08T09:30:00Z", STAMP])
        for card in cards.values():
            self.assertEqual(card["times"][-1], STAMP)
            self.assertTrue(card["text"]["artifact-ref-card-asof"].startswith("As of publish"))
        order = [block.index(f'class="{name}"', block.index('id="ref-holo-171"'))
                 for name in ("artifact-ref-card-key", "artifact-ref-card-title",
                              "artifact-ref-chip", "artifact-ref-card-links",
                              "artifact-ref-card-asof")]
        self.assertEqual(order, sorted(order))

    def test_a_card_id_is_none_the_body_has_or_its_outline_gives(self):
        body = '<p id="ref-holo-175">HOLO-175</p>\n<h2>Ref HOLO-175 2</h2>\n<p>x</p>\n'
        _, block, _ = refs.mark_refs(body, self.entries, STAMP)
        self.assertEqual(list(parsed(block).cards), ["ref-holo-175-3"])

    def test_a_card_id_is_none_that_repeated_headings_take_in_the_outline(self):
        body = ("<h2>Ref HOLO-175</h2>\n<p>One.</p>\n<h2>Ref HOLO-175</h2>\n"
                "<p>HOLO-175 again.</p>\n")
        marked, block, _ = refs.mark_refs(body, self.entries, STAMP)
        _, outline = cli.outline_body(marked)
        headings = [entry["id"] for entry in outline]
        self.assertEqual(headings, ["ref-holo-175", "ref-holo-175-2"])
        cards = list(parsed(block).cards)
        self.assertEqual(cards, ["ref-holo-175-3"])
        self.assertIn('aria-controls="ref-holo-175-3"', marked)

    def test_empty_optional_texts_and_long_link_texts_are_taken(self):
        entry = {"title": "Kept", "project": "", "status": "", "summary": "",
                 "pr": {"text": "p" * 500, "href": "https://example.com/pr/1"}}
        checked = refs.check_refs({"refs": {"HOLO-175": entry}})
        self.assertEqual(checked["HOLO-175"]["project"], "")
        _, block, _ = refs.mark_refs("<p>HOLO-175</p>", checked, STAMP)
        card = parsed(block).cards["ref-holo-175"]
        self.assertEqual(card["text"]["artifact-ref-card-key"], "HOLO-175")
        self.assertNotIn("artifact-ref-chip", card["text"])
        self.assertNotIn("artifact-ref-card-summary", card["text"])
        self.assertEqual(card["text"]["artifact-ref-card-pr"], "p" * 500)


class PublishTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.out_dir = self.tmp / "site"
        self.out_dir.mkdir()
        for argv in (["init", "-q", "-b", "main"], ["config", "user.name", "Test"],
                     ["config", "user.email", "test@example.com"],
                     ["config", "commit.gpgsign", "false"]):
            subprocess.run(["git", "-C", str(self.out_dir), *argv], check=True,
                           capture_output=True)
        self.source = self.tmp / "plan.md"
        self.source.write_text("# Plan\n\nHOLO-175 then #2266 and relos#2266.\n",
                               encoding="utf-8")

    def refs_file(self, data: object, name: str = "refs.json") -> Path:
        path = self.tmp / name
        path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
        return path

    def publish(self, *extra: str) -> tuple[int, str, str]:
        return run_cli("publish", str(self.source), "--local", "--out-dir", str(self.out_dir),
                       *extra)

    def page(self) -> str:
        return (self.out_dir / "plan.html").read_text(encoding="utf-8")

    def committed(self) -> list[str]:
        done = subprocess.run(["git", "-C", str(self.out_dir), "ls-files"], check=True,
                              capture_output=True, text=True)
        return done.stdout.split()


class RefusedFileTests(PublishTestCase):
    def test_every_broken_file_is_refused_with_one_line_and_nothing_written(self):
        good = ENTRIES["HOLO-175"]
        cases = (
            ("not JSON", "{refs: nope", ("not JSON",)),
            ("a key in lower case", {"refs": {"holo-175": good}}, ("holo-175",)),
            ("no title", {"refs": {"HOLO-175": {"status": "Open"}}}, ("HOLO-175", "title")),
            ("an unknown tone", {"refs": {"HOLO-175": {**good, "tone": "done"}}},
             ("HOLO-175", "tone")),
            ("a script href", {"refs": {"HOLO-175": {
                **good, "board": {"text": "Board", "href": "javascript:alert(1)"}}}},
             ("HOLO-175", "board.href")),
            ("an unknown field", {"refs": {"HOLO-175": {**good, "owner": "kai"}}},
             ("HOLO-175", "owner")),
            ("an unknown top-level field", {"refs": {}, "extra": 1}, ("extra",)),
            ("a long title", {"refs": {"HOLO-175": {"title": "t" * 201}}}, ("HOLO-175", "title")),
            ("a bad time", {"refs": {"HOLO-175": {**good, "updated": "yesterday"}}},
             ("HOLO-175", "updated")),
            ("a time with another separator", {"refs": {"HOLO-175": {
                **good, "updated": "2026-10-09X12:00:00"}}}, ("HOLO-175", "updated")),
            ("an href urlsplit cannot read", {"refs": {"HOLO-175": {
                **good, "board": {"text": "Board", "href": "https://["}}}},
             ("HOLO-175", "board.href")),
            ("an empty title", {"refs": {"HOLO-175": {**good, "title": ""}}},
             ("HOLO-175", "title")),
            ("a long status", {"refs": {"HOLO-175": {**good, "status": "s" * 41}}},
             ("HOLO-175", "status")),
        )
        for case, data, named in cases:
            with self.subTest(case=case):
                rc, out, err = self.publish("--refs", str(self.refs_file(data)))
                self.assertEqual(rc, 1, err)
                (line,) = err.splitlines()
                self.assertTrue(line.startswith("error: "), line)
                for part in named:
                    self.assertIn(part, line)
                self.assertEqual(sorted(p.name for p in self.out_dir.iterdir()), [".git"])

    def test_refs_and_no_refs_together_are_a_usage_error(self):
        rc, _, err = self.publish("--refs", str(self.refs_file({"refs": ENTRIES})), "--no-refs")
        self.assertEqual(rc, 2, err)
        self.assertFalse((self.out_dir / "plan.html").exists())


class KeptRefsTests(PublishTestCase):
    def test_kept_beside_the_page_redrawn_on_republish_and_dropped_by_no_refs(self):
        rc, _, err = self.publish("--refs", str(self.refs_file({"refs": ENTRIES})))
        self.assertEqual(rc, 0, err)
        page = parsed(self.page())
        self.assertEqual(page.buttons, ["HOLO-175", "#2266", "relos#2266"])
        stamp = page.cards["ref-holo-175"]["times"][-1]
        self.assertRegex(stamp, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertIn(f'<meta name="lotuspod:updated" content="{stamp}">', self.page())
        kept = json.loads((self.out_dir / "plan.refs.json").read_text(encoding="utf-8"))
        self.assertEqual(kept["asOf"], stamp)
        self.assertEqual(sorted(kept["refs"]), ["#2266", "HOLO-175", "relos#2266"])
        self.assertIn("plan.refs.json", self.committed())
        self.assertIn('<div class="artifact-ref-cards">', self.page())
        self.assertIn('<script src="lotuspod-page.js?v=', self.page())

        # Without --refs, the cards and their as-of time stay, while the
        # page's own updated time moves on.
        self.source.write_text("# Plan\n\nNow only HOLO-175.\n", encoding="utf-8")
        with mock.patch.object(cli, "_utc_stamp", lambda _: "2027-01-01T00:00:00Z"):
            rc, _, err = self.publish()
        self.assertEqual(rc, 0, err)
        page = parsed(self.page())
        self.assertEqual(page.buttons, ["HOLO-175"])
        self.assertEqual(page.cards["ref-holo-175"]["times"][-1], stamp)
        self.assertIn('content="2027-01-01T00:00:00Z"', self.page())
        kept = json.loads((self.out_dir / "plan.refs.json").read_text(encoding="utf-8"))
        self.assertEqual((kept["asOf"], list(kept["refs"])), (stamp, ["HOLO-175"]))

        rc, _, err = self.publish("--no-refs")
        self.assertEqual(rc, 0, err)
        self.assertEqual(parsed(self.page()).buttons, [])
        self.assertNotIn("artifact-ref-card", self.page())
        self.assertFalse((self.out_dir / "plan.refs.json").exists())
        self.assertNotIn("plan.refs.json", self.committed())

    def test_serve_never_answers_the_kept_refs(self):
        rc, _, err = self.publish("--refs", str(self.refs_file({"refs": ENTRIES})))
        self.assertEqual(rc, 0, err)
        self.assertTrue((self.out_dir / "plan.refs.json").is_file())
        server = cli._make_server(self.out_dir, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for path, status in (("/plan.html", 200), ("/plan.refs.json", 404)):
                conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1],
                                                  timeout=5)
                try:
                    conn.request("GET", path)
                    self.assertEqual(conn.getresponse().status, status, path)
                finally:
                    conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_a_page_naming_no_key_of_the_file_keeps_no_file(self):
        self.source.write_text("# Plan\n\nLOTUS-95 only.\n", encoding="utf-8")
        rc, _, err = self.publish("--refs", str(self.refs_file({"refs": ENTRIES})))
        self.assertEqual(rc, 0, err)
        self.assertNotIn("artifact-ref", self.page())
        self.assertFalse((self.out_dir / "plan.refs.json").exists())

if __name__ == "__main__":
    unittest.main()
