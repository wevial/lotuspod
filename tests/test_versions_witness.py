"""Witness: a page lists its earlier versions from the artifacts repository,
and opens each one read-only, marked as old.

Real git in temporary directories, with a local identity; pages published
with this checkout's CLI and served by a real `lotuspod serve`, which the
test reaches with Access assertions it signs itself (tests.test_answers_witness).
The git processes lotuspod.versions starts are counted in a server run in
process, each still run through the real subprocess.
"""

from __future__ import annotations

import io
import re
import subprocess
import sys
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from tests.test_answers_witness import Site, assertion, git
from tests.test_publish_witness import parse

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from lotuspod import access, cli, versions  # noqa: E402
from tests import access_keys  # noqa: E402

PAGE = "pond-plan"
OTHER = "pond-notes"
DATES = ("2026-09-01", "2026-09-10", "2026-09-20")
TEXTS = ("The first plan: order a pump.", "The second plan: fit a heater.",
         "The third plan: feed the fish.")
SECOND_ONLY = "The second plan"


def source(text: str) -> str:
    return f"""\
# Pond plan

{text}

## Decisions for the maintainer

| # | Question | Options | Default |
|---|---|---|---|
| 1 | Which heater? | Floating / Submerged | Floating |
"""


class VersionsWitness(Site):
    def repository(self, out: Path) -> Path:
        done = git(self.tmp, "init", "-q", "-b", "main", str(out))
        self.assertEqual(done.returncode, 0, done.stderr)
        for key, value in (("user.name", "Witness"), ("user.email", "witness@example.com"),
                           ("commit.gpgsign", "false")):
            git(out, "config", key, value)
        return out

    def publish(self, name: str, text: str, day: str, out: Path | None = None,
                *extra: str) -> str:
        """Publish name with text, committed on day at noon UTC; the revision
        publish printed."""
        path = self.tmp / f"{name}.md"
        path.write_text(source(text), encoding="utf-8")
        moment = f"{day}T12:00:00+00:00"
        env = dict(self.env, GIT_COMMITTER_DATE=moment, GIT_AUTHOR_DATE=moment)
        done = self.cli("publish", str(path), "--local", "--out-dir", str(out or self.out),
                        *extra, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        said = done.stdout.strip().splitlines()[-1]
        self.assertTrue(said.startswith(f"published {name} at revision "), said)
        return said.rsplit(" ", 1)[1]

    def three_publishes(self) -> list[str]:
        self.repository(self.out)
        return [self.publish(PAGE, text, day) for text, day in zip(TEXTS, DATES)]

    def commits(self, out: Path, name: str) -> list[str]:
        done = git(out, "log", "--format=%H", "--", f"{name}.html")
        return done.stdout.decode().split()

    def get(self, path: str, token="valid"):
        """A page request: status, headers and body bytes."""
        headers = {}
        if token == "valid":
            token = assertion()
        if token:
            headers["Cf-Access-Jwt-Assertion"] = token
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, error.read()


class ListTests(VersionsWitness):
    def test_three_publishes_list_newest_first_with_their_revisions(self):
        revisions = self.three_publishes()
        self.start_server()

        status, _, body = self.api("GET", f"/api/versions?page={PAGE}")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["page"], PAGE)
        listed = body["versions"]
        self.assertEqual([entry["date"][:10] for entry in listed], list(reversed(DATES)))
        self.assertEqual([entry["revision"] for entry in listed], list(reversed(revisions)))
        self.assertEqual([entry["current"] for entry in listed], [True, False, False])
        self.assertEqual([entry["commit"] for entry in listed], self.commits(self.out, PAGE))
        self.assertEqual(listed[0]["date"], f"{DATES[2]}T12:00:00Z")

    def test_a_directory_that_is_not_a_repository_lists_none(self):
        self.publish(PAGE, TEXTS[0], DATES[0])
        self.assertNotEqual(git(self.out, "rev-parse", "--show-toplevel").returncode, 0)
        self.start_server()

        status, _, body = self.api("GET", f"/api/versions?page={PAGE}")
        self.assertEqual((status, body), (200, {"page": PAGE, "versions": []}))

    def test_a_hidden_page_an_unknown_name_and_no_assertion_are_refused(self):
        self.three_publishes()
        done = self.cli("render", "--name", "secret", "--title", "Secret", "--hidden",
                        "--body", "<p>Hidden.</p>", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.start_server()

        for query, token, expected in (("secret", "valid", (404, "unknown_page")),
                                       ("nowhere", "valid", (404, "unknown_page")),
                                       (PAGE, None, (401, None))):
            with self.subTest(query=query):
                status, _, body = self.api("GET", f"/api/versions?page={query}", token=token)
                self.assertEqual(status, expected[0], body)
                if expected[1]:
                    self.assertEqual(body, {"error": expected[1]})


class ViewTests(VersionsWitness):
    def test_the_second_version_is_served_read_only_and_marked_as_old(self):
        self.three_publishes()
        second = self.commits(self.out, PAGE)[1]
        self.start_server()

        status, headers, data = self.get(f"/{PAGE}.html?version={second}")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        text = data.decode("utf-8")
        self.assertIn(TEXTS[1], text)
        self.assertNotIn(TEXTS[2], text)
        root = parse(text)
        (main,) = root.find("main")
        self.assertIn("artifact--old-version", main.classes())
        (banner,) = root.find("div", "artifact-version-banner")
        self.assertIs(banner.parent, main)
        self.assertIn("1 version behind", " ".join(banner.text().split()))
        hrefs = {link.text(): link.attrs.get("href") for link in banner.find("a")}
        self.assertEqual(hrefs, {"All versions": f"{PAGE}.html#versions",
                                 "Back to current": f"{PAGE}.html"})
        fieldsets = root.find("fieldset")
        self.assertTrue(fieldsets)
        self.assertTrue(all("disabled" in fieldset.attrs for fieldset in fieldsets))
        # Each followed by its note, which says where to answer.
        for fieldset in fieldsets:
            siblings = [node for node in fieldset.parent.children if not isinstance(node, str)]
            note = siblings[siblings.index(fieldset) + 1]
            self.assertIn("artifact-version-note", note.classes())
            self.assertEqual(" ".join(note.text().split()),
                             "Answering is off on old versions. Answer on the current page.")
        self.assert_one_nonce_allowed_script(headers, root)
        self.assertIn("no-store", headers["Cache-Control"])

    def assert_one_nonce_allowed_script(self, headers, root) -> str:
        """The answer's policy allows scripts by one nonce only, and the body
        holds exactly one script carrying it, the old-version script; the
        nonce."""
        policy = "; ".join(headers.get_all("Content-Security-Policy"))
        self.assertIn("form-action 'none'", policy)
        self.assertIn("frame-ancestors 'none'", policy)
        self.assertIn("base-uri 'none'", policy)
        directives = [part.split() for part in policy.split(";") if part.strip()]
        (script_src,) = [part[1:] for part in directives if part[0] == "script-src"]
        self.assertEqual(len(script_src), 1, policy)
        found = re.fullmatch(r"'nonce-([A-Za-z0-9+/_=-]+)'", script_src[0])
        self.assertIsNotNone(found, policy)
        nonce = found.group(1)
        carrying = [node for node in root.find("script") if "nonce" in node.attrs]
        self.assertEqual(len(carrying), 1)
        self.assertEqual(carrying[0].attrs["nonce"], nonce)
        self.assertEqual(carrying[0].attrs["src"],
                         f"{cli.OLD_VERSION_SCRIPT}?v={cli.theme_hash()}")
        return nonce

    def test_each_answer_allows_the_old_version_script_by_a_nonce_of_its_own(self):
        self.repository(self.out)
        for text, day in zip(TEXTS[:2], DATES[:2]):
            self.publish(PAGE, text, day)
        older = self.commits(self.out, PAGE)[1]
        self.start_server()

        nonces = []
        for _ in range(2):
            status, headers, data = self.get(f"/{PAGE}.html?version={older}")
            self.assertEqual(status, 200)
            root = parse(data.decode("utf-8"))
            nonces.append(self.assert_one_nonce_allowed_script(headers, root))
        self.assertNotEqual(nonces[0], nonces[1])

        status, _, data = self.get(f"/{cli.OLD_VERSION_SCRIPT}?v={cli.theme_hash()}")
        self.assertEqual(status, 200)
        self.assertEqual(data, cli.theme_file_bytes(cli.OLD_VERSION_SCRIPT))

    def test_no_version_but_one_of_the_pages_listed_ones_is_served(self):
        self.repository(self.out)
        done = self.cli("render", "--name", PAGE, "--title", "Pond plan", "--hidden",
                        "--body", "<p>A hidden draft of the plan.</p>",
                        "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        hidden = self.commits(self.out, PAGE)[0]
        self.publish(PAGE, TEXTS[0], DATES[0])
        self.publish(OTHER, "Notes on the pond, another page.", DATES[1])
        self.publish(PAGE, TEXTS[1], DATES[2])
        other_only = self.commits(self.out, OTHER)[0]
        self.assertNotIn(other_only, self.commits(self.out, PAGE))
        self.start_server()

        for label, query, token, expected in (
                ("another page's commit", f"version={other_only}", "valid", 404),
                ("no such commit", "version=" + "0123456789abcdef" * 2 + "01234567", "valid", 404),
                ("not a commit", "version=abc", "valid", 404),
                ("a hidden version", f"version={hidden}", "valid", 404),
                ("no assertion", f"version={self.commits(self.out, PAGE)[1]}", None, 401)):
            with self.subTest(label):
                status, _, data = self.get(f"/{PAGE}.html?{query}", token=token)
                self.assertEqual(status, expected, data[:200])
                text = data.decode("utf-8", "replace")
                for never in ("Notes on the pond", "hidden draft", *TEXTS):
                    self.assertNotIn(never, text)

    def test_a_page_without_a_version_is_served_as_before(self):
        self.three_publishes()
        self.start_server()
        current = (self.out / f"{PAGE}.html").read_bytes()

        for path in (f"/{PAGE}.html", f"/{PAGE}.html?x=1"):
            for token in ("valid", None):
                with self.subTest(path=path, signed_in=bool(token)):
                    status, _, data = self.get(path, token=token)
                    self.assertEqual((status, data), (200, current))


class GitProcessTests(VersionsWitness):
    """The git processes one list, its repeat and one view start, counted in
    a server run in this process."""

    def test_a_list_starts_two_a_repeat_one_and_a_view_two(self):
        self.three_publishes()
        commits = self.commits(self.out, PAGE)

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

        counts = []
        with mock.patch.object(subprocess, "run", spy), redirect_stderr(io.StringIO()):
            for path in (f"/api/versions?page={PAGE}", f"/api/versions?page={PAGE}",
                         f"/{PAGE}.html?version={commits[1]}"):
                before = len(started)
                self.assertEqual(self.get(path, token=access_keys.assertion())[0], 200)
                counts.append(len(started) - before)
        self.assertTrue(all(argv[0] == "git" for argv in started), started)
        self.assertLessEqual(counts[0], 2, started)
        self.assertLessEqual(counts[1], 1, started)
        self.assertLessEqual(counts[2], 2, started)
        self.assertGreater(counts[0], 0)


if __name__ == "__main__":
    unittest.main()
