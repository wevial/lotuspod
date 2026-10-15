"""Render-time stamps identify changed units independently of the live DOM."""
import hashlib
import os
from html.parser import HTMLParser
from unittest import mock

from tests.test_sections import SectionsTestCase, run_cli
from tests.test_refs import PublishTestCase
from lotuspod import cli, sections

MARKDOWN = """Intro paragraph.

## First

First paragraph.

## Second

Second paragraph.

## Third

Third paragraph.
"""


class Stamps(HTMLParser):
    def __init__(self, markup):
        super().__init__()
        self.digests = {}
        self.ids = []
        self.feed(markup)
        self.close()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get("class", "").split()
        if "artifact-section-body" in classes:
            self.ids.append(attrs["data-section"])
            self.digests[f"section-{len(self.ids)}"] = attrs.get("data-digest")
        for name in ("header", "outline", "body", "ref-cards"):
            if f"artifact-{name}" in classes:
                key = "data-intro-digest" if name == "body" else "data-digest"
                self.digests[name] = attrs.get(key)


class PageDigestTests(SectionsTestCase):
    def stamps(self, markdown=MARKDOWN, *extra):
        source = self.out_dir.parent / "page.md"
        source.write_text(markdown, encoding="utf-8")
        rc, _, err = run_cli("render", "--name", "page", "--title", "Page",
                             "--date", "2026-01-02", "--markdown", str(source),
                             "--out-dir", str(self.out_dir), *extra)
        self.assertEqual(rc, 0, err)
        return Stamps((self.out_dir / "page.html").read_text())

    def changed(self, before, after):
        return {key for key in before.digests if before.digests[key] != after.digests[key]}

    def test_stamps_are_short_distinct_and_repeatable(self):
        page = self.stamps()
        self.assertEqual(page.ids, ["first", "second", "third"])
        self.assertEqual(set(page.digests),
                         {"header", "outline", "body", "section-1", "section-2", "section-3"})
        for digest in page.digests.values():
            self.assertRegex(digest, r"\A[0-9a-f]{16}\Z")
        self.assertEqual(len(set(page.digests.values())), 6)
        self.assertEqual(page.digests, self.stamps().digests)

    def test_edits_change_only_the_affected_units(self):
        original = self.stamps()
        for text, extra, changed in (
            (MARKDOWN.replace("Second paragraph.", "Revised paragraph."), (), {"section-2"}),
            (MARKDOWN.replace("## Second", "## Reworded"), (), {"section-2", "outline"}),
            (MARKDOWN, ("--summary", "A new summary"), {"header"}),
            (MARKDOWN.replace("Intro paragraph.", "New intro."), (), {"body"}),
        ):
            with self.subTest(changed=changed):
                revised = self.stamps(text, *extra)
                self.assertEqual(self.changed(original, revised), changed)
                if "outline" in changed:
                    self.assertEqual(revised.ids, ["first", "reworded", "third"])

    def test_unwrapped_body_is_one_unit(self):
        for text, extra in (("Intro.\n\n## Only\n\nParagraph.\n", ()),
                            (MARKDOWN, ("--no-outline",))):
            original = self.stamps(text, *extra)
            self.assertEqual(original.ids, [])
            self.assertRegex(original.digests["body"], r"\A[0-9a-f]{16}\Z")
            for paragraph in ("Intro", "Paragraph") if not extra else (
                    "Intro paragraph", "First paragraph", "Second paragraph", "Third paragraph"):
                revised = self.stamps(text.replace(paragraph, "Changed"), *extra)
                self.assertEqual(self.changed(original, revised), {"body"})

    def test_explicit_heading_id_still_digests_heading_markup(self):
        body = '<p>Intro</p><h2 id="a">A</h2><p>a</p><h2 id="b">B</h2><p>b</p>'
        before = Stamps(sections.wrap_sections(body)[0])
        after = Stamps(sections.wrap_sections(body.replace('>B</h2>', '>New B</h2>'))[0])
        self.assertEqual(before.ids, after.ids)
        self.assertEqual(self.changed(before, after), {"section-2"})

    def test_digest_frames_utf8_bytes_and_part_boundaries(self):
        expected = hashlib.sha256(b'\x00\x00\x00\x00\x00\x00\x00\x02\xc3\xa9').hexdigest()[:16]
        self.assertEqual(cli.unit_digest("é"), expected)
        self.assertNotEqual(cli.unit_digest("ab", "c"), cli.unit_digest("a", "bc"))


class ReferencesDigestTests(PublishTestCase):
    def test_published_reference_title_changes_cards_digest(self):
        with (mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(self.tmp / "none.ini")}),
              mock.patch.object(cli, "_utc_stamp", return_value="2026-10-09T12:00:00Z")):
            stamps = []
            for title in ("Original title", "Revised title"):
                refs = self.refs_file({"refs": {"HOLO-175": {"title": title}}})
                rc, _, err = self.publish("--refs", str(refs))
                self.assertEqual(rc, 0, err)
                stamps.append(Stamps(self.page()).digests["ref-cards"])
            for stamp in stamps:
                self.assertRegex(stamp, r"\A[0-9a-f]{16}\Z")
            self.assertNotEqual(*stamps)
