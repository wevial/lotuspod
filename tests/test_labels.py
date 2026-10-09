"""Labels: `lotuspod publish --label NAME` files a page under NAME. The page
keeps its labels in a lotuspod:labels meta tag and shows them as tags in its
header; a republish keeps them unless given new ones or --no-labels; the
manifest lists them, and the index shows them as tags under each title and on
each row's data-labels, for the index script's Labels menu.

Run from the repo root:

    python -m unittest tests.test_labels -v
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import cli, responder  # noqa: E402

POND = "# Pond\n\nStill water.\n\n## Fish\n\nThree.\n"


def run_cli(*argv: str) -> tuple[int, str, str]:
    """main's exit status, an argparse refusal's included, and its output."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        try:
            rc = cli.main(list(argv))
        except SystemExit as exc:
            rc = exc.code if isinstance(exc.code, int) else 1
    return rc, out.getvalue(), err.getvalue()


class _Header(HTMLParser):
    """The page's lotuspod:labels meta content (None without the tag) and
    the text of each span.artifact-label in the header's date line, the only
    place they are looked for."""

    def __init__(self) -> None:
        super().__init__()
        self.meta: str | None = None
        self.tags: list[str] = []
        self._in_meta_line = False
        self._in_tag = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        attributes = dict(attrs)
        if tag == "meta" and attributes.get("name") == "lotuspod:labels":
            self.meta = attributes.get("content")
        if tag == "p" and attributes.get("class") == "artifact-meta":
            self._in_meta_line = True
        if tag == "span" and attributes.get("class") == "artifact-label" and self._in_meta_line:
            self._in_tag = True
            self.tags.append("")

    def handle_data(self, data: str) -> None:
        if self._in_tag:
            self.tags[-1] += data

    def handle_endtag(self, tag: str) -> None:
        if tag == "span":
            self._in_tag = False
        if tag == "p":
            self._in_meta_line = False


def header(page_html: str) -> _Header:
    parsed = _Header()
    parsed.feed(page_html)
    return parsed


class _IndexRows(HTMLParser):
    """The index table's tbodies, and each body row's data-labels (None
    without one), title, Updated datetime and index-tag texts."""

    def __init__(self) -> None:
        super().__init__()
        self.tbodies = 0
        self.rows: list[dict] = []
        self._in_body = False
        self._cell = -1
        self._in_link = False
        self._in_tag = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        attributes = dict(attrs)
        if tag == "tbody":
            self.tbodies += 1
            self._in_body = True
        elif tag == "tr" and self._in_body:
            self.rows.append({"data-labels": attributes.get("data-labels"), "title": "",
                              "updated": "", "tags": []})
            self._cell = -1
        elif tag == "td" and self._in_body:
            self._cell += 1
        elif tag == "a" and self._cell == 0:
            self._in_link = True
        elif tag == "span" and attributes.get("class") == "index-tag":
            self.rows[-1]["tags"].append("")
            self._in_tag = True
        elif tag == "time" and self._cell == 2:
            self.rows[-1]["updated"] = attributes.get("datetime", "")

    def handle_data(self, data: str) -> None:
        if self._in_link:
            self.rows[-1]["title"] += data
        if self._in_tag:
            self.rows[-1]["tags"][-1] += data

    def handle_endtag(self, tag: str) -> None:
        if tag == "tbody":
            self._in_body = False
        elif tag == "a":
            self._in_link = False
        elif tag == "span":
            self._in_tag = False


class LabelsCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.out_dir = self.tmp / "artifacts"
        self.out_dir.mkdir()

    def source(self, name: str, title: str = "Pond") -> Path:
        path = self.tmp / f"{name}.md"
        path.write_text(POND.replace("# Pond", f"# {title}", 1), encoding="utf-8")
        return path

    def publish(self, source: Path, *extra: str) -> tuple[int, str, str]:
        return run_cli("publish", str(source), "--local", "--out-dir", str(self.out_dir),
                       *extra)

    def published(self, source: Path, *extra: str) -> None:
        rc, _, err = self.publish(source, *extra)
        self.assertEqual(rc, 0, err)

    def page(self, name: str = "pond") -> str:
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")

    def manifest_labels(self, name: str = "pond") -> list[str]:
        data = json.loads((self.out_dir / cli.MANIFEST_FILE).read_text(encoding="utf-8"))
        [entry] = [e for e in data["artifacts"] if e["file"] == f"{name}.html"]
        return entry["labels"]

    def snapshot(self) -> dict[str, bytes]:
        return {str(path.relative_to(self.tmp)): path.read_bytes()
                for path in sorted(self.tmp.rglob("*")) if path.is_file()}


class PublishLabelsTests(LabelsCase):
    def test_labels_are_lower_cased_deduplicated_and_kept_in_order(self):
        self.published(self.source("pond"), "--label", "Holophyte", "--label", "relos",
                       "--label", "holophyte")
        parsed = header(self.page())
        self.assertEqual(parsed.meta, "holophyte,relos")
        self.assertEqual(parsed.tags, ["holophyte", "relos"])
        self.assertEqual(self.manifest_labels(), ["holophyte", "relos"])
        self.assertEqual(cli.extract_meta(self.page(), "pond")["labels"],
                         ["holophyte", "relos"])

    def test_a_label_that_is_not_one_is_refused_by_name_and_nothing_is_written(self):
        source = self.source("pond")
        before = self.snapshot()
        for bad in ("two words", "-lead", "a_b", "x" * (cli.LABEL_MAX + 1), ""):
            with self.subTest(label=bad):
                rc, _, err = self.publish(source, "--label", "fine", f"--label={bad}")
                self.assertNotEqual(rc, 0)
                self.assertIn(repr(bad), err)
                self.assertEqual(self.snapshot(), before)

    def test_a_label_of_forty_characters_is_taken(self):
        label = "a" * cli.LABEL_MAX
        self.published(self.source("pond"), "--label", label)
        self.assertEqual(self.manifest_labels(), [label])

    def test_republishes_keep_replace_and_clear_the_labels(self):
        source = self.source("pond")
        self.published(source, "--label", "relos")
        self.assertEqual(header(self.page()).meta, "relos")

        self.published(source)
        self.assertEqual(header(self.page()).meta, "relos")
        self.assertEqual(self.manifest_labels(), ["relos"])

        self.published(source, "--label", "croton")
        self.assertEqual(header(self.page()).meta, "croton")
        self.assertEqual(self.manifest_labels(), ["croton"])

        self.published(source, "--no-labels")
        parsed = header(self.page())
        self.assertIsNone(parsed.meta)
        self.assertNotIn("lotuspod:labels", self.page())
        self.assertEqual(parsed.tags, [])
        self.assertEqual(self.manifest_labels(), [])

    def test_label_and_no_labels_together_are_a_usage_error(self):
        source = self.source("pond")
        before = self.snapshot()
        rc, _, err = self.publish(source, "--label", "x", "--no-labels")
        self.assertEqual(rc, 2)
        self.assertIn("not allowed with", err)
        self.assertEqual(self.snapshot(), before)

    def test_a_page_with_no_labels_renders_as_before(self):
        self.published(self.source("pond"))
        page = self.page()
        self.assertNotIn("lotuspod:labels", page)
        self.assertNotIn("artifact-label", page)
        self.assertEqual(self.manifest_labels(), [])

    def test_the_responder_s_republish_keeps_the_labels(self):
        source = self.source("pond")
        self.published(source, "--label", "relos")
        page = self.page()
        kept = self.out_dir / "pond.md"
        revision = cli.page_revision(self.out_dir, "pond")
        agent = responder.Responder(
            socket_path=self.tmp / "unused.sock", token="", database=None,
            out_dir=self.out_dir, journal=None, command=["true"], timeout=1,
        )
        edited = kept.read_bytes() + b"\nOne more line.\n"
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code, printed = agent._publish("pond", "pond.md", edited, revision)
        self.assertEqual(code, 0, printed)
        self.assertNotEqual(self.page(), page)
        self.assertIn("One more line.", self.page())
        self.assertEqual(header(self.page()).meta, "relos")
        self.assertEqual(self.manifest_labels(), ["relos"])


class IndexLabelsTests(LabelsCase):
    def test_rows_carry_their_labels_as_tags_and_data_labels_in_one_flat_table(self):
        pages = {
            "alpha": ("Alpha", ["relos"]),
            "beta": ("Beta", ["croton", "relos"]),
            "gamma": ("Gamma", ["holophyte"]),
            "delta": ("Delta", []),
        }
        for name, (title, labels) in pages.items():
            extra = [arg for label in labels for arg in ("--label", label)]
            self.published(self.source(name, title), *extra)
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        parsed = _IndexRows()
        parsed.feed((self.out_dir / cli.INDEX_FILE).read_text(encoding="utf-8"))
        self.assertEqual(parsed.tbodies, 1)
        self.assertEqual(len(parsed.rows), len(pages))
        updated = [row["updated"] for row in parsed.rows]
        self.assertEqual(updated, sorted(updated, reverse=True))
        artifacts, _ = cli.collect_artifacts(self.out_dir)
        self.assertEqual([row["title"] for row in parsed.rows],
                         [entry["title"] for entry in artifacts])
        by_title = {row["title"]: row for row in parsed.rows}
        for title, labels in pages.values():
            with self.subTest(title=title):
                row = by_title[title]
                self.assertEqual(row["tags"], labels)
                self.assertEqual(row["data-labels"], ",".join(labels) if labels else None)


if __name__ == "__main__":
    unittest.main()
