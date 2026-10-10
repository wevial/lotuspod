"""Witness: serve answers the reader's recent activity across pages, the
versions of the last 7 days with a one-line summary each, and the comments,
replies and answers, grouped by page; and each entry of a page's versions
list carries the same summary.

Real git in temporary directories, with a local identity, each commit dated
with GIT_COMMITTER_DATE; pages published with this checkout's CLI. serve is
the real `lotuspod serve`, run on a thread of this process so its clock can
be held (the Api's, as tests.test_api holds it), with its agents' socket:
hermes replies through it with real `lotuspod comments` commands. The test
reaches the port with Access assertions it signs itself
(tests.test_answers_witness). The git processes lotuspod.versions starts are
counted while each still runs through the real subprocess.
"""

from __future__ import annotations

import datetime
import io
import json
import os
import subprocess
import sys
import threading
import time
import unittest
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from tests.test_answers_witness import AUDIENCE, ISSUER, READER, assertion, git
from tests.test_versions_witness import VersionsWitness

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from lotuspod import api, cli, decisions, machine, versions  # noqa: E402

# A second reader the site lets in.
OTHER = "other@example.com"
AGENT_OPS = ["pull", "claim", "reply", "publish"]


def moment(text: str) -> float:
    return datetime.datetime.fromisoformat(text).timestamp()


def page(title: str, *sections: tuple[str, str], decision: bool = False) -> str:
    """A page's markdown: one paragraph under each titled section, and a
    decision when asked."""
    parts = [f"# {title}", "", "A page of the pond.", ""]
    for heading, text in sections:
        parts += [f"## {heading}", "", text, ""]
    if decision:
        parts += ["## Decisions for the maintainer", "",
                  "| # | Question | Options | Default |", "|---|---|---|---|",
                  "| 1 | Which heater? | Floating / Submerged | Floating |", ""]
    return "\n".join(parts)


A_FIRST = page("Page A", ("Alpha", "The pond freezes."), ("Beta", "The pump stops."),
               decision=True)
A_SECOND = page("Page A", ("Alpha", "The pond freezes."), ("Beta", "The pump runs."),
                ("Delta", "The heater hums."), decision=True)
# A_SECOND with only whitespace changed inside Beta.
A_SPACED = A_SECOND.replace("The pump runs.", "The pump   runs.")
B_FIRST = page("Page B", ("Pond", "Notes on the pond."), ("Fish", "The fish sleep."))


class ActivityWitness(VersionsWitness):
    def setUp(self):
        super().setUp()
        config = Path(self.env["LOTUSPOD_CONFIG"])
        keys = self.tmp / "jwks.json"
        config.write_text("\n".join([
            "[access]", f"issuer = {ISSUER}", f"audience = {AUDIENCE}",
            f"certs_url = {keys.as_uri()}", f"allowed_emails = {READER} {OTHER}", ""]),
            encoding="utf-8")
        self.hermes = self.credential("hermes", ["hermes"], AGENT_OPS)

    def publish_at(self, name: str, markdown: str, at: str | None = None, *extra: str) -> None:
        """Publish markdown as name, committed at `at` (UTC) when given."""
        path = self.tmp / f"{name}.md"
        path.write_text(markdown, encoding="utf-8")
        env = dict(self.env, GIT_COMMITTER_DATE=at, GIT_AUTHOR_DATE=at) if at else None
        done = self.cli("publish", str(path), "--local", "--out-dir", str(self.out),
                        "--db", str(self.db), *extra, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

    def hide(self, name: str, at: str | None = None, draft: str = "A hidden draft.") -> None:
        """Render name hidden, saying draft, committed at `at` when given."""
        env = dict(self.env, GIT_COMMITTER_DATE=at, GIT_AUTHOR_DATE=at) if at else None
        done = self.cli("render", "--name", name, "--title", name.title(), "--hidden",
                        "--body", f"<p>{draft}</p>", "--out-dir", str(self.out), env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

    def site(self) -> None:
        """Page A published on 2026-10-01 and again on 2026-10-06, owned by
        hermes, and page B published on 2026-10-05, each at noon UTC."""
        self.repository(self.out)
        owned = ("--owner", "hermes", "--credential", str(self.hermes))
        self.publish_at("a", A_FIRST, "2026-10-01T12:00:00+00:00", *owned)
        self.publish_at("b", B_FIRST, "2026-10-05T12:00:00+00:00")
        self.publish_at("a", A_SECOND, "2026-10-06T12:00:00+00:00", *owned)

    def serve(self, now: str | None = None) -> api.Api:
        """Run `lotuspod serve` on a thread, its clock held at now when given;
        its routes."""
        made = {}
        ready = threading.Event()
        real_port, real_socket = cli._make_server, machine.SocketServer

        def make_port(*args, **kwargs):
            made["port"] = real_port(*args, **kwargs)
            return made["port"]

        def make_socket(*args, **kwargs):
            made["socket"] = real_socket(*args, **kwargs)
            ready.set()
            return made["socket"]

        argv = ["serve", "--host", "127.0.0.1", "--port", "0", "--out-dir", str(self.out),
                "--db", str(self.db), "--socket", str(self.sock)]
        thread = threading.Thread(target=cli.main, args=(argv,), daemon=True)
        patches = (mock.patch.object(cli, "_make_server", make_port),
                   mock.patch.object(machine, "SocketServer", make_socket),
                   mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": self.env["LOTUSPOD_CONFIG"]}))
        output = io.StringIO()
        for patcher in patches:
            patcher.start()
        try:
            with redirect_stdout(output), redirect_stderr(output):
                thread.start()
                started = ready.wait(15)
                deadline = time.monotonic() + 15
                while started and "ctrl-c to stop" not in output.getvalue():
                    self.assertLess(time.monotonic(), deadline, output.getvalue())
                    time.sleep(0.01)
        finally:
            for patcher in patches:
                patcher.stop()
        self.assertTrue(started, output.getvalue())
        server = made["port"]
        for handler in (cli._AllowListHandler, machine._Handler):
            patcher = mock.patch.object(handler, "log_message", lambda *a: None)
            patcher.start()
            self.addCleanup(patcher.stop)

        def stop():
            server.shutdown()
            thread.join(timeout=15)

        self.addCleanup(stop)
        self.port = server.server_address[1]
        routes = server.RequestHandlerClass.keywords["api"]
        if now is not None:
            routes.clock = lambda: moment(now)
        return routes

    def activity(self, before: str | None = None, token="valid") -> dict:
        query = "" if before is None else "?" + urllib.parse.urlencode({"before": before})
        status, _, answer = self.api("GET", f"/api/activity{query}", token=token)
        self.assertEqual(status, 200, answer)
        return answer

    def events(self, answer: dict, name: str) -> list[dict]:
        return next(entry["events"] for entry in answer["pages"] if entry["page"] == name)

    def versions_of(self, answer: dict, name: str) -> list[dict]:
        return [event for event in self.events(answer, name) if event["kind"] == "version"]


class WindowTests(ActivityWitness):
    def test_the_last_seven_days_list_each_pages_versions_newest_first(self):
        self.site()
        a_commits = self.commits(self.out, "a")
        self.serve(now="2026-10-07T12:00:00+00:00")

        answer = self.activity()
        self.assertEqual(answer["from"], "2026-09-30T12:00:00.000Z")
        self.assertEqual(answer["to"], "2026-10-07T12:00:00.000Z")
        self.assertIs(answer["older"], False)
        self.assertIs(answer["truncated"], False)
        self.assertEqual([entry["page"] for entry in answer["pages"]], ["a", "b"])
        a, b = answer["pages"]
        self.assertEqual((a["title"], a["latest"]), ("Page A", "2026-10-06T12:00:00.000Z"))
        self.assertEqual((b["title"], b["latest"]), ("Page B", "2026-10-05T12:00:00.000Z"))
        self.assertEqual(a["events"], [
            {"kind": "version", "at": "2026-10-06T12:00:00.000Z", "commit": a_commits[0],
             "revision": a["events"][0]["revision"], "current": True, "actor": "hermes",
             "first": False, "summary": "Beta changed; Delta added"},
            {"kind": "version", "at": "2026-10-01T12:00:00.000Z", "commit": a_commits[1],
             "revision": a["events"][1]["revision"], "current": False, "actor": "hermes",
             "first": True, "summary": ""},
        ])
        self.assertNotEqual(a["events"][0]["revision"], a["events"][1]["revision"])
        self.assertEqual([(event["actor"], event["first"]) for event in b["events"]],
                         [(None, True)])

    def test_only_the_version_serve_answers_now_is_current(self):
        self.site()
        self.serve(now="2026-10-07T12:00:00+00:00")

        answer = self.activity()
        self.assertEqual([event["current"] for event in self.versions_of(answer, "b")], [True])
        revision = (self.out / "a.html").read_text(encoding="utf-8")
        self.assertIn(self.versions_of(answer, "a")[0]["revision"], revision)

        # Published again, the version that was current no longer is.
        owned = ("--owner", "hermes", "--credential", str(self.hermes))
        self.publish_at("a", A_SPACED, "2026-10-07T09:00:00+00:00", *owned)
        self.assertEqual([event["current"] for event in self.versions_of(self.activity(), "a")],
                         [True, False, False])

    def test_a_later_clock_leaves_the_rest_older_and_before_reads_them(self):
        self.site()
        self.serve(now="2026-10-12T12:00:00+00:00")

        answer = self.activity()
        self.assertIs(answer["older"], True)
        self.assertEqual([entry["page"] for entry in answer["pages"]], ["a"])
        self.assertEqual([event["at"] for event in self.events(answer, "a")],
                         ["2026-10-06T12:00:00.000Z"])

        earlier = self.activity(before=answer["from"])
        self.assertEqual(earlier["to"], answer["from"])
        self.assertEqual(earlier["from"], "2026-09-28T12:00:00.000Z")
        self.assertIs(earlier["older"], False)
        self.assertEqual([(entry["page"], [event["at"] for event in entry["events"]])
                          for entry in earlier["pages"]],
                         [("b", ["2026-10-05T12:00:00.000Z"]),
                          ("a", ["2026-10-01T12:00:00.000Z"])])


class ConversationTests(ActivityWitness):
    def test_comments_replies_and_answers_say_whose_they_are_and_name_no_address(self):
        self.site()
        self.serve()
        self.assertEqual(self.pull(self.hermes, "hermes"), [])

        mine = self.comment("a", "alpha", "Is the pond deep enough?")
        code, claimed = self.agent(self.hermes, "claim", str(mine["id"]))
        self.assertEqual(code, 0, claimed)
        code, reply = self.agent(self.hermes, "reply", str(mine["id"]), "--claim",
                                 claimed["claimToken"], "--key", "hermes-op-1",
                                 "--text", "Deep enough for the fish.")
        self.assertEqual(code, 0, reply)
        status, _, theirs = self.api("POST", "/api/comments",
                                     {"page": "b", "section": "fish", "text": "Which fish?"},
                                     token=assertion(email=OTHER))
        self.assertEqual(status, 201, theirs)
        (form,) = decisions.read_forms((self.out / "a.html").read_text(encoding="utf-8")).values()
        status, _, answered = self.api("POST", "/api/answers", {
            "page": "a", "question": form.question, "version": form.version,
            "choice": form.options[0][0], "note": ""})
        self.assertEqual(status, 201, answered)

        answer = self.activity()
        self.assertNotIn("@", json.dumps(answer))
        a = [event for event in self.events(answer, "a") if event["kind"] != "version"]
        b = [event for event in self.events(answer, "b") if event["kind"] != "version"]
        self.assertEqual([event["kind"] for event in a], ["answer", "reply", "comment"])
        given, replied, opened = a
        self.assertEqual(opened, {
            "kind": "comment", "at": mine["createdAt"], "id": mine["id"], "thread": mine["id"],
            "section": "alpha", "sectionTitle": "Alpha",
            "actor": {"kind": "human", "name": "maintainer"}, "mine": True})
        self.assertEqual(replied, {
            "kind": "reply", "at": replied["at"], "id": reply["id"], "thread": mine["id"],
            "sectionTitle": "Alpha",
            "actor": {"kind": "agent", "handle": "hermes", "credential": "hermes"},
            "mine": False, "yours": True, "unread": True})
        self.assertEqual(given, {
            "kind": "answer", "at": answered["createdAt"], "question": form.question,
            "questionText": "Which heater?", "label": "Floating",
            "actor": {"kind": "human", "name": "maintainer"}, "mine": True})
        self.assertEqual(b, [{
            "kind": "comment", "at": theirs["createdAt"], "id": theirs["id"],
            "thread": theirs["id"], "section": "fish", "sectionTitle": "Fish",
            "actor": {"kind": "human", "name": "other"}, "mine": False}])

        # Once a has seen the thread, the reply is no longer unread.
        status, _, _ = self.api("POST", "/api/seen",
                                {"page": "a", "thread": mine["id"], "comment": reply["id"]})
        self.assertEqual(status, 200)
        replied = next(event for event in self.events(self.activity(), "a")
                       if event["kind"] == "reply")
        self.assertIs(replied["unread"], False)
        # And b sees the same reply as in someone else's thread.
        status, _, seen_by_b = self.api("GET", "/api/activity", token=assertion(email=OTHER))
        self.assertEqual(status, 200, seen_by_b)
        replied = next(event for event in self.events(seen_by_b, "a")
                       if event["kind"] == "reply")
        self.assertEqual((replied["mine"], replied["yours"], replied["unread"]),
                         (False, False, False))


    def test_a_thread_on_the_whole_page_is_listed_and_counted_as_any(self):
        self.site()
        self.serve()
        self.assertEqual(self.pull(self.hermes, "hermes"), [])

        mine = self.comment("a", "", "Is this plan still current?")
        self.assertEqual((mine["section"], mine["sectionTitle"], mine["owner"]),
                         ("", "", "hermes"))
        code, claimed = self.agent(self.hermes, "claim", str(mine["id"]))
        self.assertEqual(code, 0, claimed)
        code, reply = self.agent(self.hermes, "reply", str(mine["id"]), "--claim",
                                 claimed["claimToken"], "--key", "hermes-page-1",
                                 "--text", "Yes, as of today.")
        self.assertEqual(code, 0, reply)

        events = [event for event in self.events(self.activity(), "a")
                  if event["kind"] != "version"]
        self.assertEqual([event["kind"] for event in events], ["reply", "comment"])
        replied, opened = events
        self.assertEqual(opened, {
            "kind": "comment", "at": mine["createdAt"], "id": mine["id"], "thread": mine["id"],
            "section": "", "sectionTitle": "",
            "actor": {"kind": "human", "name": "maintainer"}, "mine": True})
        self.assertEqual(replied, {
            "kind": "reply", "at": replied["at"], "id": reply["id"], "thread": mine["id"],
            "sectionTitle": "",
            "actor": {"kind": "agent", "handle": "hermes", "credential": "hermes"},
            "mine": False, "yours": True, "unread": True})
        status, _, seen = self.api("GET", "/api/seen")
        self.assertEqual(status, 200, seen)
        self.assertEqual(seen["pages"]["a"]["unread"], 1)


class VersionRuleTests(ActivityWitness):
    def test_whitespace_reads_new_version_a_hidden_commit_is_none_and_a_hidden_page_leaves(self):
        self.site()
        owned = ("--owner", "hermes", "--credential", str(self.hermes))
        self.publish_at("a", A_SPACED, "2026-10-07T09:00:00+00:00", *owned)
        self.hide("c", "2026-10-07T10:00:00+00:00")
        self.hide("d", "2026-10-07T10:30:00+00:00")
        self.publish_at("d", page("Page D", ("One", "One."), ("Two", "Two.")),
                        "2026-10-07T11:00:00+00:00")
        d_commits = self.commits(self.out, "d")
        self.serve(now="2026-10-07T12:00:00+00:00")

        answer = self.activity()
        self.assertEqual([entry["page"] for entry in answer["pages"]], ["d", "a", "b"])
        newest = self.versions_of(answer, "a")[0]
        self.assertEqual((newest["at"], newest["summary"], newest["first"]),
                         ("2026-10-07T09:00:00.000Z", "new version", False))
        self.assertEqual([(event["commit"], event["first"], event["summary"])
                          for event in self.versions_of(answer, "d")],
                         [(d_commits[0], True, "")])
        self.assertNotIn(d_commits[1], json.dumps(answer))

        self.hide("a", "2026-10-07T11:30:00+00:00")
        answer = self.activity()
        self.assertEqual([entry["page"] for entry in answer["pages"]], ["d", "b"])

    def test_five_sections_changed_name_three_and_versions_carry_the_same_summary(self):
        self.site()
        titles = ("Alpha", "Beta", "Gamma", "Delta", "Epsilon")
        self.publish_at("e", page("Page E", *((title, "Before.") for title in titles)),
                        "2026-10-02T12:00:00+00:00")
        self.publish_at("e", page("Page E", *((title, "After.") for title in titles)),
                        "2026-10-03T12:00:00+00:00")
        self.serve(now="2026-10-07T12:00:00+00:00")

        answer = self.activity()
        self.assertEqual(self.versions_of(answer, "e")[0]["summary"],
                         "Alpha, Beta, Gamma and 2 more changed")
        for name in ("a", "e"):
            with self.subTest(name):
                status, _, listed = self.api("GET", f"/api/versions?page={name}")
                self.assertEqual(status, 200, listed)
                said = {event["commit"]: event["summary"]
                        for event in self.versions_of(answer, name)}
                self.assertEqual(len(listed["versions"]), 2)
                self.assertEqual({entry["commit"]: entry["summary"]
                                  for entry in listed["versions"]}, said)

    def test_summaries_join_their_parts_and_name_three_sections_at_most(self):
        def said(changed=(), added=(), removed=()):
            return versions.summary({"sections": {
                "changed": [{"id": "", "title": title} for title in changed],
                "added": [{"id": "", "title": title} for title in added],
                "removed": [{"title": title} for title in removed]}})

        self.assertEqual(said(["Alpha", "Beta"], ["Delta"], ["Gamma"]),
                         "Alpha and Beta changed; Delta added; Gamma removed")
        self.assertEqual(said(added=["A", "B", "C"]), "A, B and C added")
        self.assertEqual(said(removed=list("ABCDE")), "A, B, C and 2 more removed")
        self.assertEqual(said(), "new version")


class HistoryTests(ActivityWitness):
    """What comes before a version is the page's visible version before it,
    however many hidden ones or other files' commits come between."""

    def test_a_page_hidden_between_two_versions_keeps_its_earlier_one(self):
        self.repository(self.out)
        owned = ("--owner", "hermes", "--credential", str(self.hermes))
        self.publish_at("a", A_FIRST, "2026-10-01T12:00:00+00:00", *owned)
        self.hide("a", "2026-10-02T12:00:00+00:00")
        self.publish_at("a", A_SECOND, "2026-10-06T12:00:00+00:00", *owned)
        self.serve(now="2026-10-12T12:00:00+00:00")

        answer = self.activity()
        (newest,) = self.versions_of(answer, "a")
        self.assertEqual((newest["first"], newest["summary"]),
                         (False, "Beta changed; Delta added"))
        self.assertIs(answer["older"], True)
        status, _, listed = self.api("GET", "/api/versions?page=a")
        self.assertEqual(status, 200, listed)
        self.assertEqual([entry["summary"] for entry in listed["versions"]],
                         ["Beta changed; Delta added", ""])

    def test_a_page_reopened_at_its_earlier_revision_is_no_new_version(self):
        self.repository(self.out)
        self.publish_at("a", A_FIRST, "2026-10-01T12:00:00+00:00")
        self.hide("a", "2026-10-02T12:00:00+00:00")
        self.publish_at("a", A_FIRST, "2026-10-06T12:00:00+00:00")
        self.serve(now="2026-10-12T12:00:00+00:00")

        answer = self.activity()
        self.assertEqual(answer["pages"], [])
        self.assertIs(answer["older"], True)

    def commit_file(self, path: str, text: str, at: str) -> None:
        file = self.out / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")
        env = dict(os.environ, GIT_COMMITTER_DATE=at, GIT_AUTHOR_DATE=at)
        for argv in (["add", "-A"], ["commit", "-q", "-m", path]):
            done = subprocess.run(["git", "-C", str(self.out), *argv], capture_output=True,
                                  env=env)
            self.assertEqual(done.returncode, 0, done.stderr)

    def edits(self, path: str, text: str, count: int, first: str) -> None:
        """count commits, a minute apart from first, each adding a comment to
        path's text, written in one git fast-import; the files checked out."""
        at = int(moment(first))
        stream = []
        for n in range(count):
            data = f"{text}<!-- {n} -->\n".encode("utf-8")
            stream += [b"commit refs/heads/main\n",
                       f"committer Witness <witness@example.com> {at + 60 * n} +0000\n".encode(),
                       b"data 4\nedit\n", b"from refs/heads/main^0\n" if n == 0 else b"",
                       f"M 100644 inline {path}\ndata {len(data)}\n".encode(), data, b"\n"]
        done = subprocess.run(["git", "-C", str(self.out), "fast-import", "--quiet"],
                              input=b"".join(stream), capture_output=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(git(self.out, "reset", "-q", "--hard").returncode, 0)

    def test_other_files_and_hidden_pages_are_no_activity(self):
        self.repository(self.out)
        self.publish_at("a", A_FIRST, "2026-10-02T12:00:00+00:00")
        for n in range(4):
            self.commit_file("docs/source.html", f"<p>{n}</p>", f"2026-10-03T12:0{n}:00+00:00")
            self.hide("secret", f"2026-10-04T12:0{n}:00+00:00", f"Draft {n}.")
        self.serve(now="2026-10-07T12:00:00+00:00")

        answer = self.activity()
        self.assertEqual([entry["page"] for entry in answer["pages"]], ["a"])
        self.assertEqual((answer["older"], answer["truncated"]), (False, False))

    def test_many_edits_that_keep_a_revision_hide_no_version_and_no_older_one(self):
        # A published September 1, B October 6, then 1,002 edits of B that
        # keep its revision: B's version is the window's one event.
        self.repository(self.out)
        self.publish_at("a", A_FIRST, "2026-09-01T12:00:00+00:00")
        self.publish_at("b", B_FIRST, "2026-10-06T12:00:00+00:00")
        b_commit = self.commits(self.out, "b")[0]
        self.edits("b.html", (self.out / "b.html").read_text(encoding="utf-8"), 1002,
                   "2026-10-06T13:00:00+00:00")
        self.serve(now="2026-10-07T12:00:00+00:00")

        answer = self.activity()
        self.assertEqual([entry["page"] for entry in answer["pages"]], ["b"])
        self.assertEqual([(event["commit"], event["first"]) for event in self.events(answer, "b")],
                         [(b_commit, True)])
        self.assertEqual((answer["older"], answer["truncated"]), (True, False))

    def test_a_merge_that_resolves_a_conflict_is_a_version(self):
        self.repository(self.out)
        self.publish_at("a", A_FIRST, "2026-10-01T12:00:00+00:00")
        self.assertEqual(git(self.out, "checkout", "-q", "-b", "side").returncode, 0)
        self.publish_at("a", A_SECOND, "2026-10-02T12:00:00+00:00")
        self.assertEqual(git(self.out, "checkout", "-q", "main").returncode, 0)
        self.publish_at("a", A_FIRST.replace("The pond freezes.", "The pond thaws."),
                        "2026-10-03T12:00:00+00:00")
        self.assertNotEqual(git(self.out, "merge", "-q", "side").returncode, 0)
        merged = A_SECOND.replace("The pond freezes.", "The pond thaws.")
        self.publish_at("a", merged, "2026-10-04T12:00:00+00:00")
        self.assertEqual(git(self.out, "rev-list", "--count", "--merges", "HEAD").stdout.strip(),
                         b"1")
        merge = git(self.out, "rev-parse", "HEAD").stdout.decode().strip()
        self.serve(now="2026-10-07T12:00:00+00:00")

        events = self.versions_of(self.activity(), "a")
        self.assertEqual(events[0]["commit"], merge)
        self.assertEqual(events[0]["at"], "2026-10-04T12:00:00.000Z")
        self.assertEqual(len(events), 4)
        # The versions list and the old-version route know the merge too.
        status, _, listed = self.api("GET", "/api/versions?page=a")
        self.assertEqual(status, 200, listed)
        self.assertEqual([(entry["commit"], entry["current"]) for entry in listed["versions"]][0],
                         (merge, True))
        self.assertEqual({entry["commit"]: entry["summary"] for entry in listed["versions"]},
                         {event["commit"]: event["summary"] for event in events})
        self.assertEqual(self.get(f"/a.html?version={merge}")[0], 200)

    def test_a_version_after_a_long_hidden_stretch_compares_with_the_one_before_it(self):
        self.repository(self.out)
        self.publish_at("a", A_FIRST, "2026-10-01T12:00:00+00:00")
        for n in range(4):
            self.hide("a", f"2026-10-0{n + 2}T12:00:00+00:00", f"Draft {n}.")
        self.edits("a.html", (self.out / "a.html").read_text(encoding="utf-8"), 1002,
                   "2026-10-04T13:00:00+00:00")
        self.publish_at("a", A_SECOND, "2026-10-06T12:00:00+00:00")
        self.serve(now="2026-10-12T12:00:00+00:00")

        answer = self.activity()
        (newest,) = self.versions_of(answer, "a")
        self.assertEqual((newest["first"], newest["summary"]),
                         (False, "Beta changed; Delta added"))
        self.assertEqual((answer["older"], answer["truncated"]), (True, False))
        status, _, listed = self.api("GET", "/api/versions?page=a")
        self.assertEqual(status, 200, listed)
        self.assertEqual([(entry["commit"], entry["summary"]) for entry in listed["versions"]],
                         [(newest["commit"], newest["summary"]),
                          (self.commits(self.out, "a")[-1], "")])

    def test_the_oldest_listed_version_past_the_lists_cap_keeps_its_summary(self):
        self.repository(self.out)
        self.publish_at("a", A_FIRST, "2026-10-01T12:00:00+00:00")
        self.publish_at("a", A_SECOND, "2026-10-02T12:00:00+00:00")
        self.publish_at("a", A_SPACED, "2026-10-03T12:00:00+00:00")
        self.serve(now="2026-10-07T12:00:00+00:00")

        said = {event["commit"]: event["summary"]
                for event in self.versions_of(self.activity(), "a")}
        with mock.patch.object(versions, "MAX_VERSIONS", 2):
            status, _, listed = self.api("GET", "/api/versions?page=a")
        self.assertEqual(status, 200, listed)
        self.assertEqual([entry["summary"] for entry in listed["versions"]],
                         ["new version", "Beta changed; Delta added"])
        self.assertTrue(all(said[entry["commit"]] == entry["summary"]
                            for entry in listed["versions"]))


class ParseTests(unittest.TestCase):
    def test_a_z_time_parses_where_fromisoformat_takes_none(self):
        real = datetime.datetime

        class Strict(real):
            @classmethod
            def fromisoformat(cls, text):
                if text.endswith(("Z", "z")):
                    raise ValueError("Invalid isoformat string")
                return real.fromisoformat(text)

        # The datetime of Python 3.9 and 3.10, for api and versions alike.
        with mock.patch.object(datetime, "datetime", Strict):
            self.assertEqual(api.utc_time("2026-10-07T12:00:00.000Z").timestamp(),
                             moment("2026-10-07T12:00:00+00:00"))
            self.assertEqual(versions._moment("2026-10-07T12:00:00Z").timestamp(),
                             moment("2026-10-07T12:00:00+00:00"))


class RefusalTests(ActivityWitness):
    def test_a_bad_before_an_extra_key_and_no_assertion_are_refused(self):
        self.site()
        self.serve()
        for label, query, token, expected in (
                ("not a time", "?before=yesterday", "valid", (400, "invalid_query")),
                ("not UTC", "?before=" + urllib.parse.quote("2026-10-07T12:00:00+02:00"),
                 "valid", (400, "invalid_query")),
                ("an extra key", "?page=a", "valid", (400, "invalid_query")),
                ("two befores", "?before=2026-10-07T12:00:00Z&before=2026-10-07T12:00:00Z",
                 "valid", (400, "invalid_query")),
                ("no assertion", "", None, (401, None))):
            with self.subTest(label):
                status, _, answer = self.api("GET", f"/api/activity{query}", token=token)
                self.assertEqual(status, expected[0], answer)
                if expected[1]:
                    self.assertEqual(answer, {"error": expected[1]})
        status, headers, _ = self.api("POST", "/api/activity", {})
        self.assertEqual(status, 405)
        self.assertEqual(headers["Allow"], "GET, HEAD")

    def test_a_site_outside_a_repository_answers_comments_and_answers_without_versions(self):
        self.publish_at("a", A_FIRST)
        self.publish_at("b", B_FIRST)
        self.assertNotEqual(git(self.out, "rev-parse", "--show-toplevel").returncode, 0)
        self.serve()
        self.comment("a", "alpha", "A note on the pond.")
        (form,) = decisions.read_forms((self.out / "a.html").read_text(encoding="utf-8")).values()
        status, _, _ = self.api("POST", "/api/answers", {
            "page": "a", "question": form.question, "version": form.version,
            "choice": form.options[1][0], "note": ""})
        self.assertEqual(status, 201)

        answer = self.activity()
        self.assertEqual([entry["page"] for entry in answer["pages"]], ["a"])
        self.assertEqual([event["kind"] for event in self.events(answer, "a")],
                         ["answer", "comment"])
        self.assertEqual(self.events(answer, "a")[0]["label"], "Submerged")
        self.assertIs(answer["older"], False)


class GitProcessTests(ActivityWitness):
    def test_one_ask_starts_at_most_two(self):
        self.site()
        self.publish_at("b", B_FIRST.replace("The fish sleep.", "The fish wake."),
                        "2026-10-06T18:00:00+00:00")
        self.serve(now="2026-10-07T12:00:00+00:00")

        started = []
        real = subprocess.run

        def spy(argv, *args, **kwargs):
            if sys._getframe(1).f_globals.get("__name__") == versions.__name__:
                started.append(argv)
            return real(argv, *args, **kwargs)

        with mock.patch.object(subprocess, "run", spy):
            answer = self.activity(token=assertion())
        self.assertEqual(self.versions_of(answer, "b")[0]["summary"], "Fish changed")
        self.assertTrue(all(argv[0] == "git" for argv in started), started)
        self.assertEqual(len(started), 2, started)


if __name__ == "__main__":
    unittest.main()
