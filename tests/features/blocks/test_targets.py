"""The spots a comment may be anchored to: render marks each Mermaid diagram
and each stored image of a page with `data-spot` and `data-spot-hash`, and
PageTargets reads the same ids, kinds, hashes, titles and sections from the
page's HTML, with or without those attributes. A `mermaid id=` fence names
its diagram, and publish refuses one that is malformed or named twice.

Run from the repo root:

    python -m unittest tests.features.blocks.test_targets -v
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
SRC = REPO / "src"
sys.path.insert(0, str(SRC))

from lotuspod import cli  # noqa: E402
from lotuspod.features.blocks import targets  # noqa: E402
from lotuspod.features.publish import render  # noqa: E402

IMAGE = REPO / "tests" / "fixtures" / "media" / "chart-1600x600.png"
INTRO = "graph TD\n  Start-->Pond"
FLOW = "flowchart LR\n  Pod-->Lake\n  Lake-->Sea"
SECOND = "flowchart LR\n  A[\"Fish & frogs\"]-->B"
LATER = "graph TD\n  Late-->Later"


def pond(flow: str = FLOW, *, flow_fence: bool = True, image: str = "pond.png") -> str:
    """A page with one diagram before its first heading, a section Flow
    holding the `mermaid id=flow` fence (flow its source; left out without
    flow_fence), a plain one and an image, and a section Later holding one
    plain diagram."""
    named = f"```mermaid id=flow\n{flow}\n```\n\n" if flow_fence else ""
    return (f"# Pond\n\nAn intro.\n\n```mermaid\n{INTRO}\n```\n\n## Flow\n\nHow it flows.\n\n"
            f"{named}```mermaid\n{SECOND}\n```\n\n![Pond at dawn]({image})\n\n"
            f"## Later\n\nLater on.\n\n```mermaid\n{LATER}\n```\n")


def digest(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:12]


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


ADDED = re.compile(r' data-spot(?:-hash)?="[^"]*"')


def unmarked(text: str) -> str:
    """text with every data-spot-hash, and every data-spot but the one the
    `mermaid id=flow` fence writes, taken out."""
    return ADDED.sub(lambda m: m.group(0) if m.group(0) == ' data-spot="flow"' else "", text)


class MarkingTests(unittest.TestCase):
    """The page published with --comments, render's marking pass watched."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        self.out_dir = self.work / "site"
        (self.work / "pond.png").write_bytes(IMAGE.read_bytes())
        source = self.work / "pond.md"
        source.write_text(pond(), encoding="utf-8")
        self.handed: list[tuple[str, str]] = []
        real = render.mark_targets

        def spy(body: str) -> str:
            marked = real(body)
            self.handed.append((body, marked))
            return marked

        with mock.patch.object(render, "mark_targets", spy):
            rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                    "--local", "--comments")
        self.assertEqual(rc, 0, err)
        self.page = (self.out_dir / "pond.html").read_text(encoding="utf-8")
        self.stored = hashlib.sha256(IMAGE.read_bytes()).hexdigest()

    def marks(self, text: str) -> dict[str, str]:
        """Each data-spot in text to its data-spot-hash, in page order."""
        found = {}
        for tag in re.findall(r"<(?:pre|img)\b[^>]*>", text):
            ident = re.search(r' data-spot="([^"]*)"', tag)
            hash_ = re.search(r' data-spot-hash="([^"]*)"', tag)
            if ident or hash_:
                found[ident.group(1)] = hash_.group(1)
        return found

    def test_each_target_is_marked_with_its_id_and_hash(self):
        marks = self.marks(self.page)
        self.assertEqual(list(marks), ["diagram-1", "flow", "flow-diagram-2", "pond-at-dawn",
                                       "later-diagram-1"])
        self.assertEqual(marks, {"diagram-1": digest(INTRO), "flow": digest(FLOW),
                                 "flow-diagram-2": digest(SECOND),
                                 "pond-at-dawn": self.stored[:12],
                                 "later-diagram-1": digest(LATER)})

    def test_removing_the_added_attributes_gives_back_the_body_handed_to_the_pass(self):
        self.assertEqual(len(self.handed), 1)
        body, marked = self.handed[0]
        self.assertNotEqual(marked, body)
        self.assertEqual(unmarked(marked), body)
        # The fence's own id was there before the pass.
        self.assertIn('data-spot="flow"', body)
        self.assertNotIn("data-spot-hash", body)

    def test_page_targets_reads_the_same_with_or_without_the_attributes(self):
        expected = {
            "diagram-1": ("diagram", digest(INTRO), "", ""),
            "flow": ("diagram", digest(FLOW), "Flow", "flow"),
            "flow-diagram-2": ("diagram", digest(SECOND), "Flow", "flow"),
            "pond-at-dawn": ("image", self.stored[:12], "Pond at dawn", "flow"),
            "later-diagram-1": ("diagram", digest(LATER), "Later", "later"),
        }
        bare = unmarked(self.page)
        self.assertNotIn("data-spot-hash", bare)
        for name, text in (("marked", self.page), ("unmarked", bare)):
            with self.subTest(name):
                found = targets.PageTargets(text).found
                self.assertEqual({ident: (target.kind, target.hash, target.title, target.section)
                                  for ident, target in found.items()}, expected)
                self.assertEqual(list(found), list(expected))
                image = found["pond-at-dawn"]
                self.assertEqual((image.src, image.width, image.height),
                                 (f"/media/{self.stored}.png", 1600, 600))
                self.assertEqual(found["flow-diagram-2"].source, SECOND)


class IdTests(unittest.TestCase):
    def test_a_slug_or_counted_id_another_target_has_takes_a_suffix(self):
        image = f"/media/{'a' * 64}.png"
        body = ('<pre class="mermaid" data-spot="figure-1">graph TD\n  A</pre>\n'
                f'<figure class="artifact-figure"><img src="{image}" alt=""></figure>\n'
                f'<figure class="artifact-figure"><img src="{image}" alt="Pond!"></figure>\n'
                f'<figure class="artifact-figure"><img src="{image}" alt="pond"></figure>\n')
        self.assertEqual(list(targets.PageTargets(body).found),
                         ["figure-1", "figure-1-2", "pond", "pond-2"])
        self.assertEqual(targets.PageTargets(targets.mark_targets(body)).found,
                         targets.PageTargets(body).found)

    def test_a_marked_body_marked_again_is_unchanged(self):
        image = f"/media/{'b' * 64}.webp"
        body = ('<h2 id="a">A</h2><pre class="mermaid">graph TD\n  A</pre>'
                f'<figure class="artifact-figure"><a href="{image}"><img src="{image}" alt=""'
                ' width="4" height="3"></a></figure>')
        marked = targets.mark_targets(body)
        self.assertIn('data-spot="a-diagram-1"', marked)
        self.assertIn('data-spot="a-figure-1"', marked)
        self.assertEqual(targets.mark_targets(marked), marked)

    def test_a_hash_the_source_no_longer_has_is_replaced(self):
        body = '<pre data-spot-hash="000000000000" class="mermaid" data-spot="flow">graph TD\n  A-->C</pre>'
        marked = targets.mark_targets(body)
        found = targets.PageTargets(marked).found["flow"]
        self.assertEqual(found.hash, digest("graph TD\n  A-->C"))
        self.assertEqual(marked, body.replace("000000000000", found.hash))
        self.assertEqual(targets.mark_targets(marked), marked)

    def test_what_is_no_target(self):
        body = ('<pre class="mermaid" data-spot="">graph TD</pre>'
                '<template><pre class="mermaid">graph TD</pre></template>'
                '<figure class="artifact-figure"><img src="/media/nope.png" alt="x"></figure>'
                f'<p><img src="/media/{"c" * 64}.png" alt="loose"></p>')
        self.assertEqual(targets.PageTargets(body).found, {})
        self.assertEqual(targets.mark_targets(body), body)


class HeadingIdTests(unittest.TestCase):
    def test_a_counted_id_keeps_its_heading_s_id_as_written(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        work = Path(tmp.name)
        source = work / "flow.html"
        source.write_text('<h1>Pond</h1>\n<h2 id="flow.v2">Flow</h2>\n'
                          '<pre class="mermaid">graph TD\n  A</pre>\n<h2>Later</h2>\n<p>x</p>\n',
                          encoding="utf-8")
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(work / "site"), "--local")
        self.assertEqual(rc, 0, err)
        page = (work / "site" / "flow.html").read_text(encoding="utf-8")
        self.assertIn('data-spot="flow.v2-diagram-1"', page)
        [(ident, target)] = targets.PageTargets(page).found.items()
        self.assertEqual((ident, target.section), ("flow.v2-diagram-1", "flow.v2"))


class FenceIdTests(unittest.TestCase):
    """A real `lotuspod publish --local` of a page whose fence id is refused."""

    def publish(self, text: str) -> tuple[subprocess.CompletedProcess, Path]:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        work = Path(tmp.name)
        (work / "pond.png").write_bytes(IMAGE.read_bytes())
        source = work / "pond.md"
        source.write_text(text, encoding="utf-8")
        out_dir = work / "site"
        done = subprocess.run([sys.executable, "-m", "lotuspod", "publish", str(source),
                               "--local", "--out-dir", str(out_dir)],
                              cwd=str(work), env=dict(os.environ, PYTHONPATH=str(SRC)),
                              capture_output=True, text=True, timeout=60)
        return done, out_dir

    def check_refused(self, text: str, line: int) -> None:
        done, out_dir = self.publish(text)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertIn(f"at line {line}", done.stderr)
        self.assertIn("nothing written", done.stderr)
        self.assertEqual(sorted(out_dir.rglob("*")) if out_dir.exists() else [], [])

    def test_an_id_not_of_letters_digits_hyphens_and_underscores_is_refused(self):
        text = pond().replace("```mermaid id=flow", "```mermaid id=bad.id")
        line = text.split("\n").index("```mermaid id=bad.id") + 1
        self.check_refused(text, line)

    def test_an_id_two_fences_name_is_refused_at_the_second(self):
        text = pond().replace(f"```mermaid\n{LATER}", f"```mermaid id=flow\n{LATER}")
        lines = text.split("\n")
        second = [at for at, line in enumerate(lines, 1) if line == "```mermaid id=flow"][1]
        self.check_refused(text, second)

    def test_a_good_id_publishes(self):
        done, out_dir = self.publish(pond())
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('data-spot="flow"', (out_dir / "pond.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
