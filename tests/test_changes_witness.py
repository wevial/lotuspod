"""Witness: a page says what changed since the revision the reader last
opened it at: the sections that changed, and a diff of its markdown source.

Real git in temporary directories, with a local identity; pages published
with this checkout's CLI and served by a real `lotuspod serve`, which the
test reaches with Access assertions it signs itself (tests.test_answers_witness).
A page with no kept source is rendered with the CLI's own render, given a
revision as publish gives it. The git processes lotuspod.versions starts are
counted in a server run in process, each still run through the real
subprocess.
"""

from __future__ import annotations

import io
import re
import subprocess
import sys
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from tests.test_answers_witness import git
from tests.test_versions_witness import VersionsWitness

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from lotuspod import access, cli, versions  # noqa: E402
from tests import access_keys  # noqa: E402

PAGE = "pond-plan"


def markdown(beta_line: str) -> str:
    return f"""\
# Pond plan

The plan for the pond this winter.

## Alpha

The pond freezes in January.

## Beta

The pump stops with it.
{beta_line}
And the fish sleep.
"""


def body(*sections: tuple[str, str]) -> str:
    return "".join(f"<h2>{title}</h2>\n<p>{text}</p>\n" for title, text in sections)


class ChangesWitness(VersionsWitness):
    def publish_markdown(self, name: str, text: str, out: Path | None = None) -> str:
        """Publish text as name; the revision publish printed."""
        path = self.tmp / f"{name}.md"
        path.write_text(text, encoding="utf-8")
        done = self.cli("publish", str(path), "--local", "--out-dir", str(out or self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        said = done.stdout.strip().splitlines()[-1]
        self.assertTrue(said.startswith(f"published {name} at revision "), said)
        return said.rsplit(" ", 1)[1]

    def render(self, name: str, page_body: str, revision: str) -> None:
        """Render page_body as name with no kept source, stamped with
        revision, and commit it as render does."""
        args = cli.build_parser().parse_args(
            ["render", "--name", name, "--title", "Pond plan", "--body", page_body,
             "--out-dir", str(self.out)])
        args.revision = revision
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cli.cmd_render(args), 0)
        self.assertFalse((self.out / f"{name}.md").exists())

    def changes(self, name: str, since: str, token="valid"):
        return self.api("GET", f"/api/changes?page={name}&since={since}", token=token)


class SourceTests(ChangesWitness):
    def test_a_republished_markdown_page_answers_its_changed_section_and_a_line_diff(self):
        self.repository(self.out)
        first = self.publish_markdown(PAGE, markdown("old line"))
        second = self.publish_markdown(PAGE, markdown("new line"))
        self.assertNotEqual(first, second)
        commits = self.commits(self.out, PAGE)
        self.start_server()

        status, _, answer = self.changes(PAGE, first)
        self.assertEqual(status, 200, answer)
        self.assertEqual(answer["page"], PAGE)
        self.assertIs(answer["changed"], True)
        self.assertEqual(answer["behind"], 1)
        self.assertEqual(answer["since"]["revision"], first)
        self.assertEqual(answer["since"]["commit"], commits[1])
        self.assertRegex(answer["since"]["date"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(answer["sections"], {"changed": [{"id": "beta", "title": "Beta"}],
                                              "added": [], "removed": []})
        self.assertIn({"op": "-", "text": "old line"}, answer["lines"])
        self.assertIn({"op": "+", "text": "new line"}, answer["lines"])
        self.assertEqual(answer["lines"][0]["op"], "@")
        self.assertTrue(all(line["op"] in "+- @" and len(line["op"]) == 1
                            for line in answer["lines"]))
        self.assertIs(answer["truncated"], False)

    def test_a_diff_past_400_lines_holds_400_and_says_it_was_cut(self):
        self.repository(self.out)
        lines = [f"Line {n} of the plan." for n in range(300)]
        first = self.publish_markdown(PAGE, "# Pond plan\n\n" + "\n\n".join(lines) + "\n")
        self.publish_markdown(PAGE, "# Pond plan\n\n" + "\n\n".join(
            line.replace("plan", "new plan") for line in lines) + "\n")
        self.start_server()

        status, _, answer = self.changes(PAGE, first)
        self.assertEqual(status, 200, answer)
        self.assertEqual(len(answer["lines"]), 400)
        self.assertIs(answer["truncated"], True)
        self.assertEqual(answer["sections"]["changed"], [{"id": "", "title": "The page text"}])


class SectionTests(ChangesWitness):
    def test_a_rendered_page_compares_by_section(self):
        self.repository(self.out)
        self.render(PAGE, body(("Alpha", "The pond freezes."), ("Beta", "The pump stops."),
                               ("Gamma", "The fish sleep.")), "r1aaaaaaaaaa")
        self.render(PAGE, body(("Alpha", "The pond freezes."), ("Beta", "The pump runs."),
                               ("Delta", "The heater hums.")), "r2bbbbbbbbbb")
        self.start_server()

        status, _, answer = self.changes(PAGE, "r1aaaaaaaaaa")
        self.assertEqual(status, 200, answer)
        self.assertIs(answer["changed"], True)
        self.assertEqual(answer["behind"], 1)
        self.assertEqual(answer["sections"], {
            "changed": [{"id": "beta", "title": "Beta"}],
            "added": [{"id": "delta", "title": "Delta"}],
            "removed": [{"title": "Gamma"}],
        })
        self.assertNotIn("lines", answer)
        self.assertNotIn("truncated", answer)

    def test_whitespace_and_a_forms_version_hash_change_no_section(self):
        self.repository(self.out)
        first = self.publish_markdown(PAGE, markdown("old line") + """
## Decisions for the maintainer

| # | Question | Options | Default |
|---|---|---|---|
| 1 | Which heater? | Floating / Submerged | Floating |
""")
        page = self.out / f"{PAGE}.html"
        before = page.read_text(encoding="utf-8")
        hashes = re.findall(r'data-version="([^"]+)"', before)
        self.assertTrue(hashes)
        after = before.replace(f'data-version="{hashes[0]}"', 'data-version="0123456789ab"')
        after = after.replace("The pump stops with it.", "The pump   stops\n  with it.")
        after = after.replace(f'content="{first}"', 'content="r2cccccccccc"')
        self.assertNotEqual(after.count("r2cccccccccc"), 0)
        self.assertNotIn(f'data-version="{hashes[0]}"', after)
        page.write_text(after, encoding="utf-8")
        self.assertEqual(git(self.out, "commit", "-q", "-am", "whitespace").returncode, 0)
        self.start_server()

        status, _, answer = self.changes(PAGE, first)
        self.assertEqual(status, 200, answer)
        self.assertEqual(answer["behind"], 1)
        self.assertEqual(answer["sections"], {"changed": [], "added": [], "removed": []})

    def test_a_line_break_between_blocks_and_a_forms_version_hash_change_no_section(self):
        self.repository(self.out)
        form = ('<form class="artifact-decision" data-question="q1" data-version="{}">'
                '<fieldset><legend>Which heater?</legend></fieldset></form>')
        self.render(PAGE, '<h2>Alpha</h2><p>The pond freezes.</p><h2>Beta</h2><p>same</p>'
                    + form.format("aaaaaaaaaaaa"), "r1dddddddddd")
        self.render(PAGE, '<h2>Alpha</h2>\n<p>The pond freezes.</p>\n<h2>Beta</h2>\n'
                    '<p>same</p>\n' + form.format("bbbbbbbbbbbb"), "r2eeeeeeeeee")
        self.start_server()

        status, _, answer = self.changes(PAGE, "r1dddddddddd")
        self.assertEqual(status, 200, answer)
        self.assertEqual(answer["behind"], 1)
        self.assertEqual(answer["sections"], {"changed": [], "added": [], "removed": []})

    def test_a_page_left_with_one_heading_keeps_that_section(self):
        # The outline gives ids only to a page with two h2s or more, so the
        # Alpha left alone has none.
        self.repository(self.out)
        self.render(PAGE, body(("Alpha", "The pond freezes."), ("Beta", "The pump stops.")),
                    "r1ffffffffff")
        self.render(PAGE, body(("Alpha", "The pond thaws.")), "r2gggggggggg")
        self.assertNotIn('id="alpha"', (self.out / f"{PAGE}.html").read_text(encoding="utf-8"))
        self.start_server()

        status, _, answer = self.changes(PAGE, "r1ffffffffff")
        self.assertEqual(status, 200, answer)
        self.assertEqual(answer["sections"], {"changed": [{"id": "", "title": "Alpha"}],
                                              "added": [], "removed": [{"title": "Beta"}]})


class CompareTests(unittest.TestCase):
    def test_compare_takes_no_sources_and_an_empty_since_reads_nothing(self):
        page = '<section class="artifact-body"><h2 id="a">A</h2><p>{}</p></section>'
        self.assertEqual(versions.compare(page.format("x"), page.format("y")),
                         {"sections": {"changed": [{"id": "a", "title": "A"}],
                                       "added": [], "removed": []}})
        history = versions.History(Path("."), lambda text: ("", True))
        with mock.patch.object(subprocess, "run") as run:
            self.assertIsNone(history.changes(PAGE, ""))
        run.assert_not_called()


class RefusalTests(ChangesWitness):
    def test_the_current_revision_an_unknown_one_and_a_hidden_page(self):
        self.repository(self.out)
        first = self.publish_markdown(PAGE, markdown("old line"))
        second = self.publish_markdown(PAGE, markdown("new line"))
        done = self.cli("render", "--name", "secret", "--title", "Secret", "--hidden",
                        "--body", "<p>Hidden.</p>", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.start_server()

        status, _, answer = self.changes(PAGE, second)
        self.assertEqual(status, 200, answer)
        self.assertIs(answer["changed"], False)
        self.assertEqual(answer["behind"], 0)
        self.assertEqual(answer["since"]["revision"], second)
        self.assertNotIn("sections", answer)
        self.assertNotIn("lines", answer)

        for label, query, token, expected in (
                ("no version carries it", f"page={PAGE}&since=0123456789ab", "valid",
                 (404, "unknown_revision")),
                ("a hidden page", f"page=secret&since={first}", "valid", (404, "unknown_page")),
                ("no since", f"page={PAGE}", "valid", (400, "invalid_query")),
                ("an empty since", f"page={PAGE}&since=", "valid", (400, "invalid_query")),
                ("no assertion", f"page={PAGE}&since={first}", None, (401, None))):
            with self.subTest(label):
                status, _, answer = self.api("GET", f"/api/changes?{query}", token=token)
                self.assertEqual(status, expected[0], answer)
                if expected[1]:
                    self.assertEqual(answer, {"error": expected[1]})

        status, headers, _ = self.api("POST", f"/api/changes?page={PAGE}&since={first}", {})
        self.assertEqual(status, 405)
        self.assertEqual(headers["Allow"], "GET, HEAD")

    def test_a_page_outside_a_repository_has_no_revision_to_compare(self):
        first = self.publish_markdown(PAGE, markdown("old line"))
        self.publish_markdown(PAGE, markdown("new line"))
        self.assertNotEqual(git(self.out, "rev-parse", "--show-toplevel").returncode, 0)
        self.start_server()

        status, _, answer = self.changes(PAGE, first)
        self.assertEqual((status, answer), (404, {"error": "unknown_revision"}))


class GitProcessTests(ChangesWitness):
    def test_one_ask_starts_at_most_three(self):
        self.repository(self.out)
        first = self.publish_markdown(PAGE, markdown("old line"))
        self.publish_markdown(PAGE, markdown("new line"))

        verifier = access.Verifier(access.parse_config(access_keys.config_section()))
        server = cli._make_server(self.out, "127.0.0.1", 0, verifier=verifier,
                                  db_path=self.db)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.port = server.server_address[1]

        started = []
        real = subprocess.run

        def spy(argv, *args, **kwargs):
            if sys._getframe(1).f_globals.get("__name__") == versions.__name__:
                started.append(argv)
            return real(argv, *args, **kwargs)

        with mock.patch.object(subprocess, "run", spy), redirect_stderr(io.StringIO()):
            status, _, answer = self.changes(PAGE, first, token=access_keys.assertion())
        self.assertEqual(status, 200, answer)
        self.assertIs(answer["changed"], True)
        self.assertIn("lines", answer)
        self.assertTrue(all(argv[0] == "git" for argv in started), started)
        self.assertGreater(len(started), 0)
        self.assertLessEqual(len(started), 3, started)


if __name__ == "__main__":
    unittest.main()
