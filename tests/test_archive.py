"""Witness: `lotuspod archive` and `lotuspod unarchive` mark a page archived
and back, here or on the writer host over ssh, and serve's /api/archive does
the same for an owner; an archived page leaves the index's default list and
Recent activity, and keeps its URL and its bytes.

Real git in temporary directories, with a local identity; pages published
and archived with this checkout's CLI. Over ssh, `ssh` on the PATH is the
stub of tests.test_publish_remote, which runs the remote command on this
machine. serve is the real `lotuspod serve`, run as
tests.test_activity_witness runs it, reached with Access assertions the test
signs itself.

Run from the repo root:

    python -m unittest tests.test_archive -v
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

from tests import test_activity_witness as activity_witness
from tests import test_publish_remote as publish_remote
from tests.test_answers_witness import READER, assertion

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
TIMEOUT = 120
STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
OTHER_READER = activity_witness.OTHER


def git(cwd: Path, *argv: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True,
                          check=True).stdout


def subjects(out: Path) -> list[str]:
    return git(out, "log", "--format=%s").splitlines()


def archive_record(out: Path) -> dict | None:
    """old's archive record; None when there is none."""
    path = out / "old.archived.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def page_source(title: str) -> str:
    return f"# {title}\n\nA page of the pond.\n\n## Alpha\n\nThe pond freezes.\n"


class _Rows(HTMLParser):
    """The index table's rows: their attributes by data-page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: dict[str, dict] = {}

    def handle_starttag(self, tag, attrs):
        found = dict(attrs)
        if tag == "tr" and "data-page" in found:
            self.rows[found["data-page"]] = found


def index_rows(out: Path) -> dict[str, dict]:
    parser = _Rows()
    parser.feed((out / "index.html").read_text(encoding="utf-8"))
    return parser.rows


def manifest_entries(out: Path) -> dict[str, dict]:
    data = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    return {entry["file"][:-len(".html")]: entry for entry in data["artifacts"]}


class LocalSite(unittest.TestCase):
    """An artifacts directory that is the top of its own repository, with
    old, new and other published and draft rendered hidden."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.out = self.tmp / "site"
        self.out.mkdir()
        for argv in (["init", "-q", "-b", "main"], ["config", "user.name", "Witness"],
                     ["config", "user.email", "witness@example.com"],
                     ["config", "commit.gpgsign", "false"]):
            git(self.out, *argv)
        self.env = dict(os.environ, PYTHONPATH=str(SRC), HOME=str(self.tmp),
                        LOTUSPOD_CONFIG="", XDG_CONFIG_HOME="")
        for name, title in (("old", "Old plan"), ("new", "New plan"), ("other", "Other plan")):
            self.publish(name, title)
        done = self.cli("render", "--name", "draft", "--title", "Draft", "--hidden",
                        "--body", "<p>A hidden draft.</p>", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)

    def cli(self, *argv: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "lotuspod", *argv], cwd=str(self.tmp),
                              env=self.env, capture_output=True, text=True, timeout=TIMEOUT)

    def publish(self, name: str, title: str) -> None:
        source = self.tmp / f"{name}.md"
        source.write_text(page_source(title), encoding="utf-8")
        done = self.cli("publish", str(source), "--local", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)

    def archive(self, *argv: str) -> subprocess.CompletedProcess:
        return self.cli("archive", *argv, "--local", "--out-dir", str(self.out))

    def unarchive(self, *argv: str) -> subprocess.CompletedProcess:
        return self.cli("unarchive", *argv, "--local", "--out-dir", str(self.out))


class ArchiveCommandTests(LocalSite):
    def test_archive_writes_the_record_the_manifest_and_the_index_in_one_commit(self):
        page = (self.out / "old.html").read_bytes()
        before = subjects(self.out)

        done = self.archive("old", "--superseded-by", "new")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip().splitlines()[-1], "archived old")

        record = archive_record(self.out)
        self.assertEqual(set(record), {"archivedAt", "supersededBy"})
        self.assertRegex(record["archivedAt"], STAMP)
        self.assertTrue(record["archivedAt"].endswith("Z"))
        self.assertEqual(record["supersededBy"], "new")

        entries = manifest_entries(self.out)
        self.assertEqual((entries["old"]["archived"], entries["old"]["supersededBy"]),
                         (record["archivedAt"], "new"))
        self.assertEqual((entries["new"]["archived"], entries["new"]["supersededBy"]), ("", ""))

        rows = index_rows(self.out)
        self.assertEqual(rows["old"].get("data-archived"), record["archivedAt"])
        self.assertIn("hidden", rows["old"])
        self.assertNotIn("data-archived", rows["new"])
        self.assertNotIn("hidden", rows["new"])

        self.assertEqual((self.out / "old.html").read_bytes(), page)
        self.assertEqual(subjects(self.out), ["archive old", *before])
        self.assertEqual(git(self.out, "status", "--porcelain"), "")

    def test_unarchive_removes_the_record_and_a_second_run_writes_nothing(self):
        self.assertEqual(self.archive("old", "--superseded-by", "new").returncode, 0)
        before = subjects(self.out)

        done = self.unarchive("old")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip().splitlines()[-1], "unarchived old")
        self.assertIsNone(archive_record(self.out))
        entries = manifest_entries(self.out)
        self.assertEqual((entries["old"]["archived"], entries["old"]["supersededBy"]), ("", ""))
        row = index_rows(self.out)["old"]
        self.assertNotIn("data-archived", row)
        self.assertNotIn("hidden", row)
        self.assertEqual(subjects(self.out), ["unarchive old", *before])

        again = self.unarchive("old")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(again.stdout.strip(), "old is not archived")
        self.assertEqual(subjects(self.out), ["unarchive old", *before])

    def test_names_that_are_not_visible_pages_are_refused_writing_nothing(self):
        before = subjects(self.out)
        index = (self.out / "index.html").read_bytes()
        for label, argv in (("no such page", ("missing",)),
                            ("a hidden page", ("draft",)),
                            ("no such successor", ("old", "--superseded-by", "missing")),
                            ("the page itself", ("old", "--superseded-by", "old"))):
            with self.subTest(label):
                done = self.archive(*argv)
                self.assertEqual(done.returncode, 1, done.stdout)
                self.assertIn("nothing written", done.stderr)
                self.assertEqual(sorted(p.name for p in self.out.glob("*.archived.json")), [])
                self.assertEqual(subjects(self.out), before)
                self.assertEqual((self.out / "index.html").read_bytes(), index)

    def test_a_page_render_named_with_a_dot_is_archived_and_unarchived(self):
        done = self.cli("render", "--name", "dotted.name", "--title", "Dotted",
                        "--body", "<p>Visible.</p>", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)

        done = self.archive("dotted.name", "--superseded-by", "new")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((self.out / "dotted.name.archived.json").is_file())
        self.assertIn("hidden", index_rows(self.out)["dotted.name"])
        self.assertEqual(self.unarchive("dotted.name").returncode, 0)
        self.assertFalse((self.out / "dotted.name.archived.json").exists())

    def test_a_rebuild_that_fails_puts_back_what_it_wrote(self):
        (self.out / "new.archived.json").write_text("{broken", encoding="utf-8")
        before = subjects(self.out)
        kept = {name: (self.out / name).read_bytes() for name in ("index.html", "manifest.json")}

        done = self.archive("old", "--superseded-by", "other")
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("nothing written", done.stderr)
        self.assertIsNone(archive_record(self.out))
        for name, data in kept.items():
            self.assertEqual((self.out / name).read_bytes(), data, name)
        self.assertEqual(subjects(self.out), before)

    def test_archiving_again_keeps_the_time_and_a_republish_keeps_the_record(self):
        self.assertEqual(self.archive("old", "--superseded-by", "new").returncode, 0)
        first = archive_record(self.out)

        done = self.archive("old")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(archive_record(self.out), first)

        done = self.archive("old", "--superseded-by", "other")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(archive_record(self.out), {"archivedAt": first["archivedAt"],
                                         "supersededBy": "other"})

        self.publish("old", "Old plan, again")
        self.assertEqual(archive_record(self.out), {"archivedAt": first["archivedAt"],
                                         "supersededBy": "other"})
        self.assertEqual(manifest_entries(self.out)["old"]["archived"], first["archivedAt"])
        self.assertIn("hidden", index_rows(self.out)["old"])


class RemoteArchiveTests(publish_remote.RemotePublishTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.config = self.write_config(self.tmp / "config.ini", host="writer.example.com")
        self.env["LOTUSPOD_CONFIG"] = str(self.config)
        for name in ("old", "new"):
            source = self.tmp / f"{name}.md"
            source.write_text(page_source(name.title()), encoding="utf-8")
            done = self.lotuspod("publish", str(source), "--local",
                                 "--out-dir", str(self.out_dir))
            self.assertEqual(done.returncode, 0, done.stderr)

    def lotuspod(self, *argv: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "lotuspod", *argv], cwd=str(self.tmp),
                              env=self.env, capture_output=True, text=True, timeout=TIMEOUT)

    def test_archive_runs_on_the_host_with_each_argument_quoted(self):
        done = self.lotuspod("archive", "old", "--superseded-by", "new")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("archived old", done.stdout)
        (call,) = self.calls()
        self.assertEqual(call[0], "writer.example.com")
        argv = ["archive", "--local", f"--out-dir={self.out_dir}", "--superseded-by=new", "old"]
        command = f"{sys.executable} -m lotuspod"
        self.assertEqual(call[-1], " ".join([command, *(shlex.quote(arg) for arg in argv)]))
        self.assertEqual(self.remote_argv(call), argv)
        self.assertEqual(archive_record(self.out_dir)["supersededBy"], "new")
        self.assertEqual(subjects(self.out_dir)[0], "archive old")

        done = self.lotuspod("unarchive", "old")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.remote_argv(self.calls()[-1]),
                         ["unarchive", "--local", f"--out-dir={self.out_dir}", "old"])
        self.assertFalse((self.out_dir / "old.archived.json").exists())

    def test_the_far_sides_refusal_comes_back_as_its_exit_status(self):
        done = self.lotuspod("archive", "missing")
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("nothing written", done.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(list(self.out_dir.glob("*.archived.json")), [])

    def test_out_dir_with_a_configured_host_is_refused_before_ssh(self):
        done = self.lotuspod("archive", "old", "--out-dir", str(self.out_dir))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("--out-dir", done.stderr)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.out_dir / "old.archived.json").exists())


class ServedArchive(activity_witness.ActivityWitness):
    """old and new published, served by `lotuspod serve`; READER an owner
    unless owners=False."""

    owners = True

    def setUp(self):
        super().setUp()
        if self.owners:
            config = Path(self.env["LOTUSPOD_CONFIG"])
            config.write_text(config.read_text(encoding="utf-8") + f"owners = {READER}\n",
                              encoding="utf-8")
        self.repository(self.out)
        sections = (("Alpha", "The pond freezes."), ("Beta", "The pump stops."))
        self.publish_at("old", activity_witness.page("Old plan", *sections))
        self.publish_at("new", activity_witness.page("New plan", *sections))


class ArchiveRouteTests(ServedArchive):
    def test_an_owner_archives_and_unarchives_as_the_command_does(self):
        self.serve()
        page = (self.out / "old.html").read_bytes()

        status, _, state = self.api("GET", "/api/archive?page=old")
        self.assertEqual((status, state), (200, {"page": "old", "archived": None,
                                                 "supersededBy": None, "mayArchive": True}))

        before = subjects(self.out)
        status, _, state = self.api("POST", "/api/archive",
                                    {"page": "old", "archived": True, "supersededBy": "new"})
        self.assertEqual(status, 200, state)
        self.assertRegex(state["archived"], STAMP)
        self.assertEqual((state["page"], state["supersededBy"], state["mayArchive"]),
                         ("old", "new", True))
        self.assertEqual(archive_record(self.out),
                         {"archivedAt": state["archived"], "supersededBy": "new"})
        self.assertEqual(subjects(self.out), ["archive old", *before])
        self.assertEqual((self.out / "old.html").read_bytes(), page)
        self.assertEqual(manifest_entries(self.out)["old"]["archived"], state["archived"])
        self.assertIn("hidden", index_rows(self.out)["old"])

        status, _, read = self.api("GET", "/api/archive?page=old")
        self.assertEqual((status, read), (200, state))
        # An archived page is still served.
        status, _, _ = self.get("/old.html")
        self.assertEqual(status, 200)

        status, _, state = self.api("POST", "/api/archive", {"page": "old", "archived": False})
        self.assertEqual((status, state), (200, {"page": "old", "archived": None,
                                                 "supersededBy": None, "mayArchive": True}))
        self.assertIsNone(archive_record(self.out))
        self.assertEqual(subjects(self.out), ["unarchive old", "archive old", *before])

    def test_a_reader_who_is_not_an_owner_and_bad_names_are_refused_writing_nothing(self):
        self.serve()
        before = subjects(self.out)
        other = assertion(email=OTHER_READER)

        status, _, state = self.api("GET", "/api/archive?page=old", token=other)
        self.assertEqual((status, state["mayArchive"]), (200, False))
        for label, body, token, expected in (
                ("not an owner", {"page": "old", "archived": True}, other, (403, "not_owner")),
                ("unknown page", {"page": "missing", "archived": True}, "valid",
                 (404, "unknown_page")),
                ("unknown successor", {"page": "old", "archived": True,
                                       "supersededBy": "missing"}, "valid",
                 (400, "unknown_successor")),
                ("the page itself", {"page": "old", "archived": True, "supersededBy": "old"},
                 "valid", (400, "unknown_successor")),
                ("not a boolean", {"page": "old", "archived": "yes"}, "valid",
                 (400, "invalid_body")),
                ("an extra field", {"page": "old", "archived": True, "why": "done"}, "valid",
                 (400, "invalid_body"))):
            with self.subTest(label):
                status, _, answer = self.api("POST", "/api/archive", body, token=token)
                self.assertEqual((status, answer), (expected[0], {"error": expected[1]}))
                self.assertIsNone(archive_record(self.out))
                self.assertEqual(subjects(self.out), before)

        status, _, answer = self.api("POST", "/api/archive", {"page": "old", "archived": True},
                                     headers={"Origin": "https://elsewhere.example"})
        self.assertEqual((status, answer), (403, {"error": "cross_origin"}))
        self.assertIsNone(archive_record(self.out))


class RouteBodyTests(ServedArchive):
    def test_a_null_successor_is_refused_writing_nothing(self):
        self.serve()
        status, _, state = self.api("POST", "/api/archive",
                                    {"page": "old", "archived": True, "supersededBy": "new"})
        self.assertEqual(status, 200, state)
        record, before = archive_record(self.out), subjects(self.out)
        for archived in (False, True):
            with self.subTest(archived=archived):
                status, _, answer = self.api("POST", "/api/archive", {
                    "page": "old", "archived": archived, "supersededBy": None})
                self.assertEqual((status, answer), (400, {"error": "invalid_body"}))
                self.assertEqual(archive_record(self.out), record)
                self.assertEqual(subjects(self.out), before)

    def test_a_successor_with_a_name_over_100_characters_is_taken(self):
        long = "p" * 101
        self.publish_at(long, activity_witness.page("Long", ("Alpha", "A long name.")))
        self.serve()
        status, _, state = self.api("POST", "/api/archive",
                                    {"page": "old", "archived": True, "supersededBy": long})
        self.assertEqual((status, state["supersededBy"]), (200, long), state)
        self.assertEqual(archive_record(self.out)["supersededBy"], long)

    def test_a_rebuild_that_fails_answers_503_and_writes_nothing(self):
        (self.out / "new.archived.json").write_text("{broken", encoding="utf-8")
        before = subjects(self.out)
        index = (self.out / "index.html").read_bytes()
        self.serve()
        status, _, answer = self.api("POST", "/api/archive", {"page": "old", "archived": True})
        self.assertEqual((status, answer), (503, {"error": "storage_unavailable"}))
        self.assertIsNone(archive_record(self.out))
        self.assertEqual((self.out / "index.html").read_bytes(), index)
        self.assertEqual(subjects(self.out), before)


class NoOwnersTests(ServedArchive):
    owners = False

    def test_without_owners_no_reader_may_archive(self):
        self.serve()
        status, _, state = self.api("GET", "/api/archive?page=old")
        self.assertEqual((status, state["mayArchive"]), (200, False))
        status, _, answer = self.api("POST", "/api/archive", {"page": "old", "archived": True})
        self.assertEqual((status, answer), (403, {"error": "not_owner"}))
        self.assertIsNone(archive_record(self.out))


class ActivityTests(ServedArchive):
    def test_an_archived_page_has_no_group_in_recent_activity_until_unarchived(self):
        self.serve()
        self.comment("old", "alpha", "Is the pond deep enough?")

        def groups() -> list[str]:
            return [entry["page"] for entry in self.activity()["pages"]]

        self.assertEqual(sorted(groups()), ["new", "old"])
        old = self.events(self.activity(), "old")
        self.assertEqual({event["kind"] for event in old}, {"comment", "version"})

        done = self.cli("archive", "old", "--local", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(groups(), ["new"])

        done = self.cli("unarchive", "old", "--local", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(sorted(groups()), ["new", "old"])


if __name__ == "__main__":
    unittest.main()
