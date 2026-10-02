"""`lotuspod serve` keeps the reader's answers and comments: the five /api
routes over HTTP, signed in with assertions from the test key, their
refusals, the database across a restart, and where `serve` keeps it.

Run from the repo root:

    python -m unittest tests.test_api -v
"""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import access, api, cli, db, decisions, media, routing  # noqa: E402
from tests import access_keys as keys  # noqa: E402

HOST = "127.0.0.1"
ACTOR = {"kind": "human", "email": keys.EMAIL}
# The reader as the routes show them: their address's part before the @.
SHOWN = {"kind": "human", "name": "maintainer"}
CREATED_AT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

PLAN = """\
# Plan

What we will do.

## Goals

Ship it.

## Risks

The pond may freeze.

## Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| 1 | Freeze the pond? | Yes / No |
| 2 | Skate on it? | Yes / No |
"""

# A body whose decisions table asks what PLAN's does.
DECISIONS_BODY = (
    "<p>A page.</p>\n<h2>Decisions for the maintainer</h2>\n"
    "<table><thead><tr><th>Question</th><th>Options</th></tr></thead><tbody>"
    "<tr><td>Freeze the pond?</td><td>Yes / No</td></tr>"
    "<tr><td>Skate on it?</td><td>Yes / No</td></tr></tbody></table>\n"
)


def run_cli(*argv: str) -> None:
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
        rc = cli.main(list(argv))
    assert rc == 0, (argv, err.getvalue())


def quiet(testcase: unittest.TestCase) -> None:
    """Keep the servers' request log off the test output."""
    patcher = mock.patch.object(cli._AllowListHandler, "log_message", lambda *a: None)
    patcher.start()
    testcase.addCleanup(patcher.stop)


class ApiTestCase(unittest.TestCase):
    """A site with a published page `plan` (sections goals and risks, and
    questions decision-1 and decision-2), a visible page `other` asking the
    same questions, with one comment box for the page, and a hidden page
    `secret`, served with the test key trusted and a database beside the
    output directory."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        self.out_dir = self.work / "artifacts"
        self.out_dir.mkdir()
        self.db_path = self.work / "answers.sqlite3"
        config = self.work / "config.ini"
        config.write_text(keys.config_text(), encoding="utf-8")
        env = mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(config)})
        env.start()
        self.addCleanup(env.stop)
        quiet(self)

        source = self.work / "plan.md"
        source.write_text(PLAN, encoding="utf-8")
        run_cli("publish", str(source), "--name", "plan", "--out-dir", str(self.out_dir),
                "--local")
        for name, extra in (("other", ()), ("secret", ("--hidden",))):
            run_cli("render", "--name", name, "--title", name.title(), "--comments",
                    "--body", DECISIONS_BODY, "--out-dir", str(self.out_dir), *extra)
        run_cli("index", "--out-dir", str(self.out_dir))

        page = (self.out_dir / "plan.html").read_text(encoding="utf-8")
        meta = re.search(r'<meta name="lotuspod:revision" content="([0-9a-f]+)">', page)
        self.assertIsNotNone(meta)
        self.revision = meta.group(1)
        self.server = None
        self.start()

    def start(self, db_path: Path | None = None, *, allowed_emails: str = keys.EMAIL,
              max_image_bytes: int = media.DEFAULT_MAX_BYTES) -> None:
        verifier = access.Verifier(access.parse_config(
            keys.config_section(allowed_emails=allowed_emails)))
        server = cli._make_server(self.out_dir, HOST, 0, verifier=verifier,
                                  db_path=db_path or self.db_path,
                                  max_image_bytes=max_image_bytes)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.server = server
        self.port = server.server_address[1]

        def stop() -> None:
            if self.server is server:
                self.server = None
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.stop = stop
        self.addCleanup(lambda: self.server is server and stop())

    def ask(self, method: str, path: str, body: object = None, *, raw: bytes | None = None,
            headers: dict | None = None, assertion: str | None = "default"):
        """(status, JSON body) of one request; every answer must be no-store."""
        sent = {}
        if assertion == "default":
            assertion = keys.assertion()
        if assertion is not None:
            sent["Cf-Access-Jwt-Assertion"] = assertion
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
        if raw is not None:
            sent["Content-Type"] = "application/json"
        sent.update(headers or {})
        conn = http.client.HTTPConnection(HOST, self.port, timeout=15)
        try:
            conn.request(method, path, body=raw, headers=sent)
            response = conn.getresponse()
            data = response.read()
        finally:
            conn.close()
        self.assertEqual(response.getheader("Cache-Control"), "no-store",
                         f"{method} {path} -> {response.status}")
        if response.getheader("Content-Type") == "application/json":
            return response.status, json.loads(data.decode("utf-8"))
        return response.status, data

    def version(self, question: str = "decision-1", page: str = "plan") -> str:
        """The version of question as page's form asks it; "v1" when it does not."""
        path = self.out_dir / f"{page}.html"
        forms = decisions.read_forms(path.read_text(encoding="utf-8")) if path.exists() else {}
        return forms[question].version if question in forms else "v1"

    def answer_body(self, question: str = "decision-1", choice: str = "yes",
                    page: str = "plan", **extra) -> dict:
        return {"page": page, "question": question, "version": self.version(question, page),
                "choice": choice, "note": "", **extra}

    def answer(self, question: str = "decision-1", choice: str = "yes", page: str = "plan",
               **extra):
        return self.ask("POST", "/api/answers", self.answer_body(question, choice, page, **extra))

    def comment(self, **body):
        return self.ask("POST", "/api/comments", {"page": "plan", **body})

    def page_revision(self, page: str = "plan") -> str:
        return cli.page_revision(self.out_dir, page)

    def assertEmpty(self, page: str = "plan") -> None:
        self.assertEqual(self.ask("GET", f"/api/answers?page={page}"),
                         (200, {"page": page, "questions": {}}))
        self.assertEqual(self.ask("GET", f"/api/comments?page={page}"),
                         (200, {"page": page, "revision": self.page_revision(page),
                                "threads": [],
                                "maxImageBytes": media.DEFAULT_MAX_BYTES}))


class AnswerTests(ApiTestCase):
    def test_a_second_answer_supersedes_the_first(self):
        status, first = self.answer(choice="yes", note="first thoughts")
        self.assertEqual(status, 201)
        status, second = self.answer(choice="no")
        self.assertEqual(status, 201)

        self.assertEqual(
            {key: first[key] for key in first if key not in ("id", "createdAt")},
            {"page": "plan", "question": "decision-1", "version": self.version(),
             "choice": "yes", "note": "first thoughts", "revision": self.revision,
             "actor": SHOWN, "supersedes": None},
        )
        self.assertRegex(first["createdAt"], CREATED_AT)
        self.assertEqual(second["actor"], SHOWN)
        self.assertEqual(second["revision"], self.revision)
        self.assertEqual(second["supersedes"], first["id"])
        self.assertNotEqual(second["id"], first["id"])

        self.assertEqual(
            self.ask("GET", "/api/answers?page=plan"),
            (200, {"page": "plan",
                   "questions": {"decision-1": {"current": second, "earlier": [first]}}}),
        )

    def test_questions_are_kept_apart(self):
        _, one = self.answer(question="decision-1")
        _, two = self.answer(question="decision-2")
        _, other = self.answer(question="decision-1", page="other")
        self.assertIsNone(two["supersedes"])
        self.assertIsNone(other["supersedes"])
        self.assertEqual(other["revision"], "")
        _, got = self.ask("GET", "/api/answers?page=plan")
        self.assertEqual(got["questions"], {"decision-1": {"current": one, "earlier": []},
                                            "decision-2": {"current": two, "earlier": []}})

    def test_a_same_origin_browser_post_is_taken(self):
        status, _row = self.ask(
            "POST", "/api/answers", self.answer_body(),
            headers={"Origin": f"http://{HOST}:{self.port}", "Sec-Fetch-Site": "same-origin",
                     "Content-Type": "application/json; charset=utf-8"},
        )
        self.assertEqual(status, 201)

    def test_the_origin_must_match_the_scheme_too(self):
        own = f"{HOST}:{self.port}"
        for origin, forwarded, status in (
            (f"https://{own}", None, 403),
            (f"https://{own}", "http", 403),
            (f"http://{own}", "https", 403),
            (f"https://{own}", "ftp", 403),
            (f"https://{own}", "https", 201),
            (f"http://{own}", "http", 201),
        ):
            with self.subTest(origin=origin, forwarded=forwarded):
                headers = {"Origin": origin}
                if forwarded is not None:
                    headers["X-Forwarded-Proto"] = forwarded
                got = self.ask("POST", "/api/answers", self.answer_body(), headers=headers)
                self.assertEqual(got[0], status, got)
                if status == 403:
                    self.assertEqual(got[1], {"error": "cross_origin"})
        _, got = self.ask("GET", "/api/answers?page=plan")
        self.assertEqual(len(got["questions"]["decision-1"]["earlier"]), 1)

    def test_any_page_serve_answers_takes_answers(self):
        run_cli("render", "--name", "plan.v2", "--title", "Plan v2", "--comments",
                "--body", DECISIONS_BODY, "--out-dir", str(self.out_dir))
        conn = http.client.HTTPConnection(HOST, self.port, timeout=15)
        conn.request("GET", "/plan.v2.html")
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()
        self.assertEqual(self.answer(page="plan.v2")[0], 201)
        self.assertEqual(self.comment(page="plan.v2", section="page", text="Hi")[0], 201)
        _, got = self.ask("GET", "/api/answers?page=plan.v2")
        self.assertEqual(list(got["questions"]), ["decision-1"])


class AnswerCheckTests(ApiTestCase):
    """An answer is checked against the page's own decision forms."""

    def test_answers_the_page_does_not_ask_for_store_nothing(self):
        for label, body, status, error in (
            ("unknown question", self.answer_body(question="decision-3"),
             400, "unknown_question"),
            ("question of no form", self.answer_body(question="goals"), 400, "unknown_question"),
            ("stale version", self.answer_body(version="0" * 12), 409, "stale"),
            ("choice not offered", self.answer_body(choice="maybe"), 400, "invalid_choice"),
            ("label, not value", self.answer_body(choice="Yes"), 400, "invalid_choice"),
        ):
            with self.subTest(label):
                self.assertEqual(self.ask("POST", "/api/answers", body), (status, {"error": error}))
        self.assertEmpty()

    def test_a_page_without_decisions_asks_nothing(self):
        run_cli("render", "--name", "plain", "--title", "Plain", "--body", "<p>A page.</p>",
                "--out-dir", str(self.out_dir))
        self.assertEqual(self.answer(page="plain"), (400, {"error": "unknown_question"}))
        self.assertEmpty("plain")

    def test_rewording_a_question_strands_its_answers(self):
        self.assertEqual(self.answer()[0], 201)
        body = self.answer_body()
        source = self.work / "plan.md"
        source.write_text(PLAN.replace("Freeze the pond?", "Freeze the whole pond?"),
                          encoding="utf-8")
        run_cli("publish", str(source), "--name", "plan", "--out-dir", str(self.out_dir),
                "--local")
        self.assertNotEqual(self.version(), body["version"])
        self.assertEqual(self.version("decision-2"), self.answer_body("decision-2")["version"])
        self.assertEqual(self.ask("POST", "/api/answers", body), (409, {"error": "stale"}))
        _, fresh = self.answer()
        self.assertEqual(fresh["version"], self.version())


class CommentTests(ApiTestCase):
    def test_replies_join_the_thread_of_their_root(self):
        quote = {"exact": "may freeze", "prefix": "The pond ", "suffix": "."}
        status, root = self.comment(section="risks", text="What if it does?", quote=quote)
        self.assertEqual(status, 201)
        status, reply = self.comment(parent=root["id"], text="Then we skate.")
        self.assertEqual(status, 201)
        status, deeper = self.comment(parent=reply["id"], text="On what skates?")
        self.assertEqual(status, 201)

        self.assertEqual(
            {key: root[key] for key in root if key not in ("id", "createdAt")},
            {"page": "plan", "section": "risks", "sectionTitle": "Risks",
             "revision": self.revision, "parent": None, "text": "What if it does?",
             "quote": quote, "images": [], "actor": SHOWN,
             # The page has no owner and the responder has never pulled.
             "state": "unavailable", "owner": "responder"},
        )
        self.assertRegex(root["createdAt"], CREATED_AT)
        for row in (reply, deeper):
            self.assertEqual(row["parent"], root["id"])
            self.assertEqual(row["section"], "risks")
            self.assertEqual(row["sectionTitle"], "Risks")
            self.assertIsNone(row["quote"])
            self.assertEqual(row["state"], "unavailable")
            self.assertEqual(row["owner"], "responder")
            self.assertEqual(row["actor"], SHOWN)

        self.assertEqual(
            self.ask("GET", "/api/comments?page=plan"),
            (200, {"page": "plan", "revision": self.revision,
                   "threads": [{"root": root, "replies": [reply, deeper],
                                "resolution": db.UNRESOLVED}],
                   "maxImageBytes": media.DEFAULT_MAX_BYTES}),
        )

    def test_a_new_thread_names_the_revision_the_reader_read(self):
        quote = {"exact": "may freeze", "prefix": "The pond ", "suffix": "."}
        status, row = self.comment(section="risks", text="When?", quote=quote,
                                   revision=self.revision)
        self.assertEqual(status, 201)
        self.assertEqual((row["quote"], row["revision"]), (quote, self.revision))
        stored = db.Database(self.db_path).comment(row["id"])
        self.assertEqual((stored["quote"], stored["revision"]), (quote, self.revision))

        self.assertNotEqual(self.revision, "0000000000ff")
        self.assertEqual(
            self.comment(section="risks", text="Stale.", quote=quote, revision="0000000000ff"),
            (409, {"error": "stale_page"}),
        )
        _, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual([thread["root"]["id"] for thread in got["threads"]], [row["id"]])

        status, unnamed = self.comment(section="risks", text="No revision.", quote=quote)
        self.assertEqual(status, 201)
        self.assertEqual(unnamed["revision"], self.revision)

    def test_a_revision_not_a_short_string_or_on_a_reply_is_invalid(self):
        _, root = self.comment(section="risks", text="A thread.")
        new = {"page": "plan", "section": "risks", "text": "Hello"}
        for body in ({**new, "revision": 7}, {**new, "revision": None},
                     {**new, "revision": "r" * 101},
                     {"page": "plan", "parent": root["id"], "text": "Hi",
                      "revision": self.revision}):
            with self.subTest(body=body):
                self.assertEqual(self.ask("POST", "/api/comments", body),
                                 (400, {"error": "invalid_body"}))
        _, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(got["threads"],
                         [{"root": root, "replies": [], "resolution": db.UNRESOLVED}])

    def test_threads_come_oldest_first_and_gone_sections_have_no_title(self):
        _, goals = self.comment(section="goals", text="Which goal first?")
        # A thread on a section an earlier revision had: the route takes new
        # threads only on the page's own boxes.
        elsewhere = db.Database(self.db_path).add_comment(
            page="plan", section="nowhere", section_title="Nowhere", revision="0" * 12,
            text="A section not on the page.", quote=None, actor=ACTOR,
        )
        elsewhere = api.shown(routing.public(elsewhere, {}, routing.DEFAULT_WINDOW, 0))
        _, reply = self.comment(parent=elsewhere["id"], text="Still here.")
        self.assertEqual(goals["sectionTitle"], "Goals")
        self.assertEqual(reply["section"], "nowhere")
        self.assertEqual(reply["sectionTitle"], "")
        self.assertIsNone(reply["quote"])
        _, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(got["threads"],
                         [{"root": goals, "replies": [], "resolution": db.UNRESOLVED},
                          {"root": elsewhere, "replies": [reply],
                           "resolution": db.UNRESOLVED}])


class ResolutionTests(ApiTestCase):
    """{page, thread, resolved}: the reader resolves and reopens a thread."""

    def resolve(self, thread: int, resolved: bool = True, page: str = "plan"):
        return self.ask("POST", "/api/comments",
                        {"page": page, "thread": thread, "resolved": resolved})

    def stored(self) -> list[tuple]:
        """Every resolutions row: (thread, resolved, actor, at), oldest first."""
        conn = sqlite3.connect(str(self.db_path))
        try:
            return [(thread, bool(resolved), json.loads(actor), at) for thread, resolved, actor, at
                    in conn.execute("SELECT thread, resolved, actor, at FROM resolutions"
                                    " ORDER BY id")]
        finally:
            conn.close()

    def resolution(self, thread: int) -> dict:
        _, got = self.ask("GET", "/api/comments?page=plan")
        [found] = [found for found in got["threads"] if found["root"]["id"] == thread]
        return found["resolution"]

    def test_the_reader_resolves_and_reopens_a_thread(self):
        _, root = self.comment(section="risks", text="What if it does?")
        self.assertEqual(self.resolution(root["id"]), db.UNRESOLVED)

        status, got = self.resolve(root["id"])
        self.assertEqual(status, 200)
        self.assertEqual(set(got), {"thread", "resolution"})
        self.assertEqual(got["thread"], root["id"])
        resolved = got["resolution"]
        self.assertEqual((resolved["resolved"], resolved["actor"]), (True, SHOWN))
        self.assertRegex(resolved["at"], CREATED_AT)
        self.assertEqual(self.resolution(root["id"]), resolved)
        self.assertEqual(self.stored(), [(root["id"], True, ACTOR, resolved["at"])])

        # Resolving a resolved thread answers its resolution and stores nothing.
        self.assertEqual(self.resolve(root["id"]), (200, got))
        self.assertEqual(len(self.stored()), 1)

        status, got = self.resolve(root["id"], False)
        self.assertEqual(status, 200)
        reopened = got["resolution"]
        self.assertEqual((reopened["resolved"], reopened["actor"]), (False, SHOWN))
        self.assertRegex(reopened["at"], CREATED_AT)
        self.assertEqual(self.resolution(root["id"]), reopened)
        self.assertEqual([row[:3] for row in self.stored()],
                         [(root["id"], True, ACTOR), (root["id"], False, ACTOR)])
        # A comment's routing state is its own.
        _, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(got["threads"][0]["root"]["state"], root["state"])

    def test_resolutions_that_name_no_thread_or_are_not_as_described_store_nothing(self):
        _, root = self.comment(section="risks", text="A thread.")
        _, reply = self.comment(parent=root["id"], text="A reply.")
        _, elsewhere = self.comment(page="other", section="page", text="On another page.")
        for label, thread in (("a reply", reply["id"]), ("another page's thread", elsewhere["id"]),
                              ("no comment", 999999)):
            with self.subTest(label):
                self.assertEqual(self.resolve(thread), (404, {"error": "unknown_thread"}))
        body = {"page": "plan", "thread": root["id"], "resolved": True}
        for label, sent in (("resolved a string", {**body, "resolved": "yes"}),
                            ("resolved missing", {"page": "plan", "thread": root["id"]}),
                            ("an extra key", {**body, "text": "Done."})):
            with self.subTest(label):
                self.assertEqual(self.ask("POST", "/api/comments", sent),
                                 (400, {"error": "invalid_body"}))
        self.assertEqual(self.stored(), [])
        self.assertEqual(self.resolution(root["id"]), db.UNRESOLVED)

    def test_a_resolution_is_refused_as_every_post_is(self):
        _, root = self.comment(section="risks", text="A thread.")
        body = {"page": "plan", "thread": root["id"], "resolved": True}
        for headers, status, error in (
            ({"Content-Type": "text/plain"}, 415, "unsupported_media_type"),
            ({"Origin": "https://elsewhere.example"}, 403, "cross_origin"),
            ({"Sec-Fetch-Site": "cross-site"}, 403, "cross_origin"),
        ):
            with self.subTest(headers=headers):
                self.assertEqual(self.ask("POST", "/api/comments", body, headers=headers),
                                 (status, {"error": error}))
        self.assertEqual(self.resolve(root["id"], page="secret"),
                         (404, {"error": "unknown_page"}))
        self.assertEqual(self.stored(), [])

    def test_a_reply_to_a_resolved_thread_reopens_it(self):
        _, root = self.comment(section="risks", text="What if it does?")
        self.assertEqual(self.resolve(root["id"])[0], 200)
        status, reply = self.comment(parent=root["id"], text="Not yet.")
        self.assertEqual(status, 201, reply)
        reopened = self.resolution(root["id"])
        self.assertEqual((reopened["resolved"], reopened["actor"]), (False, reply["actor"]))
        self.assertGreaterEqual(reopened["at"], reply["createdAt"])
        self.assertEqual([row[1:3] for row in self.stored()], [(True, ACTOR), (False, ACTOR)])

        # A reply to an open thread stores no resolution.
        self.assertEqual(self.comment(parent=root["id"], text="Still open.")[0], 201)
        self.assertEqual(len(self.stored()), 2)


class RevisionTests(ApiTestCase):
    """An open page learns the revision its page is now published at: from
    /api/revision, and beside the threads of every read of the comments."""

    def republish(self) -> str:
        source = self.work / "plan.md"
        source.write_text(PLAN + "\nA line added since.\n", encoding="utf-8")
        run_cli("publish", str(source), "--name", "plan", "--out-dir", str(self.out_dir),
                "--local")
        return self.page_revision()

    def test_the_revision_route_and_the_comments_read_name_the_current_revision(self):
        self.assertEqual(self.ask("GET", "/api/revision?page=plan"),
                         (200, {"revision": self.revision}))
        status, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual((status, got["revision"]), (200, self.revision))

        revised = self.republish()
        self.assertNotEqual(revised, self.revision)
        self.assertEqual(self.ask("GET", "/api/revision?page=plan"),
                         (200, {"revision": revised}))
        status, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual((status, got["revision"]), (200, revised))

    def test_the_revision_route_names_one_page_serve_answers(self):
        for path, answer in (
            ("/api/revision?page=missing", (404, {"error": "unknown_page"})),
            ("/api/revision?page=secret", (404, {"error": "unknown_page"})),
            ("/api/revision?page=index", (404, {"error": "unknown_page"})),
            ("/api/revision", (400, {"error": "invalid_query"})),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.ask("GET", path), answer)

    def test_the_revision_route_needs_an_assertion(self):
        self.assertEqual(self.ask("GET", "/api/revision?page=plan", assertion=None),
                         (401, {"error": "signed_out"}))

    def test_the_revision_route_is_only_read(self):
        self.assertEqual(self.ask("POST", "/api/revision", {"page": "plan"}),
                         (405, {"error": "method_not_allowed"}))
        self.assertEmpty()


class ReaderNameTests(ApiTestCase):
    """A page is shown the reader's name, never their address."""

    def test_comments_name_the_reader_without_their_address(self):
        _, root = self.comment(section="risks", text="What if it does?")
        self.comment(parent=root["id"], text="Then we skate.")
        self.assertEqual(self.ask("POST", "/api/comments",
                                  {"page": "plan", "thread": root["id"], "resolved": True})[0], 200)
        _, got = self.ask("GET", "/api/comments?page=plan")
        [thread] = got["threads"]
        self.assertEqual(thread["root"]["actor"], {"kind": "human", "name": "maintainer"})
        self.assertEqual(thread["replies"][0]["actor"], SHOWN)
        self.assertEqual(thread["resolution"]["actor"], SHOWN)
        self.assertNotIn("@example.com", json.dumps(got))
        # The database keeps the address.
        self.assertEqual(db.Database(self.db_path).comment(root["id"])["actor"], ACTOR)

    def test_answers_name_the_reader_without_their_address(self):
        _, first = self.answer(choice="yes")
        self.assertEqual(first["actor"], SHOWN)
        self.answer(choice="no")
        _, got = self.ask("GET", "/api/answers?page=plan")
        entry = got["questions"]["decision-1"]
        self.assertEqual(entry["current"]["actor"], {"kind": "human", "name": "maintainer"})
        self.assertEqual(entry["earlier"][0]["actor"], SHOWN)
        self.assertNotIn("@example.com", json.dumps(got))

    def test_the_name_is_everything_before_the_last_at(self):
        self.assertEqual(api.named({"kind": "human", "email": "a@b@example.com"}),
                         {"kind": "human", "name": "a@b"})
        agent = {"kind": "agent", "handle": "hermes", "credential": "c1"}
        self.assertEqual(api.named(agent), agent)


class SignedOutTests(ApiTestCase):
    def test_every_route_needs_an_assertion(self):
        answer = {"page": "plan", "question": "q", "version": "v1", "choice": "yes", "note": ""}
        comment = {"page": "plan", "section": "risks", "text": "Hello"}
        for method, path, body in (
            ("POST", "/api/answers", answer),
            ("GET", "/api/answers?page=plan", None),
            ("POST", "/api/comments", comment),
            ("GET", "/api/comments?page=plan", None),
            ("GET", "/api/revision?page=plan", None),
        ):
            with self.subTest(method=method, path=path):
                self.assertEqual(self.ask(method, path, body, assertion=None),
                                 (401, {"error": "signed_out"}))
        self.assertEmpty()


class RefusalTests(ApiTestCase):
    def test_refusals_store_nothing(self):
        _, elsewhere = self.comment(page="other", section="page", text="On another page.")
        answer = {"page": "plan", "question": "q", "version": "v1", "choice": "yes", "note": ""}
        comment = {"page": "plan", "section": "risks", "text": "Hello"}
        big = {**answer, "note": "x" * (17 << 10)}
        cases = (
            ("text/plain", "/api/answers", answer, {"Content-Type": "text/plain"},
             415, "unsupported_media_type"),
            ("foreign Origin", "/api/answers", answer,
             {"Origin": "https://elsewhere.example"}, 403, "cross_origin"),
            ("cross-site fetch", "/api/comments", comment, {"Sec-Fetch-Site": "cross-site"},
             403, "cross_origin"),
            ("17 KiB body", "/api/answers", big, {}, 413, "body_too_large"),
            ("4001-character text", "/api/comments", {**comment, "text": "x" * 4001}, {},
             400, "invalid_body"),
            ("33-character prefix", "/api/comments",
             {**comment, "quote": {"exact": "freeze", "prefix": "p" * 33, "suffix": ""}}, {},
             400, "invalid_body"),
            ("hidden page", "/api/answers", {**answer, "page": "secret"}, {},
             404, "unknown_page"),
            ("parent on another page", "/api/comments",
             {"page": "plan", "parent": elsewhere["id"], "text": "Hi"}, {},
             404, "unknown_parent"),
        )
        for label, path, body, headers, status, error in cases:
            with self.subTest(label):
                self.assertEqual(self.ask("POST", path, body, headers=headers),
                                 (status, {"error": error}))
        self.assertEmpty()

    def test_bodies_not_as_described_are_invalid(self):
        answer = {"page": "plan", "question": "q", "version": "v1", "choice": "yes", "note": ""}
        comment = {"page": "plan", "section": "risks", "text": "Hello"}
        quote = {"exact": "freeze", "prefix": "", "suffix": ""}
        bodies = (
            ("/api/answers", {key: v for key, v in answer.items() if key != "note"}),
            ("/api/answers", {**answer, "choice": 3}),
            ("/api/answers", {**answer, "question": ""}),
            ("/api/answers", {**answer, "version": "v" * 101}),
            ("/api/answers", {**answer, "note": "n" * 4001}),
            ("/api/answers", {**answer, "extra": 1}),
            ("/api/answers", ["not", "an", "object"]),
            ("/api/comments", {**comment, "text": ""}),
            ("/api/comments", {**comment, "section": 7}),
            ("/api/comments", {**comment, "quote": {**quote, "exact": ""}}),
            ("/api/comments", {**comment, "quote": {**quote, "exact": "e" * 501}}),
            ("/api/comments", {**comment, "quote": {**quote, "suffix": "s" * 33}}),
            ("/api/comments", {**comment, "quote": {"exact": "freeze"}}),
            ("/api/comments", {**comment, "quote": "freeze"}),
            ("/api/comments", {"page": "plan", "parent": "1", "text": "Hi"}),
            ("/api/comments", {"page": "plan", "parent": True, "text": "Hi"}),
            ("/api/comments", {"page": "plan", "parent": 1, "section": "risks", "text": "Hi"}),
            ("/api/comments", {"page": "plan", "text": "Hi"}),
        ) + tuple(
            (path, {**body, "page": page})
            for page in (None, 123, [], {}, True)
            for path, body in (("/api/answers", answer), ("/api/comments", comment),
                               ("/api/comments", {"page": "plan", "parent": 1, "text": "Hi"}))
        )
        for path, body in bodies:
            with self.subTest(path=path, body=body):
                self.assertEqual(self.ask("POST", path, body), (400, {"error": "invalid_body"}))
        for raw in (b"{", b'{"page": "plan", "page": "plan"}', b"\xff", b"NaN",
                    b'{"page": "plan", "section": "s", "text": "\\ud800"}'):
            with self.subTest(raw=raw):
                self.assertEqual(self.ask("POST", "/api/comments", raw=raw),
                                 (400, {"error": "invalid_body"}))
        self.assertEqual(self.comment(section="risks", text="x" * 4000)[0], 201)
        self.assertEqual(self.answer(note="n" * 4000)[0], 201)

    def test_reads_name_one_page_serve_answers(self):
        for path, answer in (
            ("/api/answers?page=secret", (404, {"error": "unknown_page"})),
            ("/api/comments?page=missing", (404, {"error": "unknown_page"})),
            ("/api/answers?page=index", (404, {"error": "unknown_page"})),
            ("/api/comments?page=..%2Fplan", (404, {"error": "unknown_page"})),
            ("/api/answers", (400, {"error": "invalid_query"})),
            ("/api/comments?page=plan&page=other", (400, {"error": "invalid_query"})),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.ask("GET", path), answer)

    def test_other_methods_are_not_allowed(self):
        self.assertEqual(self.ask("PUT", "/api/answers", {}),
                         (405, {"error": "method_not_allowed"}))
        self.assertEmpty()


class NoStoreTests(ApiTestCase):
    def test_every_answer_is_no_store(self):
        # ask() fails on any answer without Cache-Control: no-store; this
        # walks each route through a success and a refusal.
        _, root = self.comment(section="risks", text="Hello")
        statuses = [
            self.answer()[0],
            self.ask("GET", "/api/answers?page=plan")[0],
            self.comment(parent=root["id"], text="Reply")[0],
            self.ask("GET", "/api/comments?page=plan")[0],
            self.answer(page="secret")[0],
            self.ask("GET", "/api/answers?page=secret")[0],
            self.comment(parent=10 ** 6, text="Reply")[0],
            self.ask("GET", "/api/comments")[0],
        ]
        self.assertEqual(statuses, [201, 200, 201, 200, 404, 404, 404, 400])


class RestartTests(ApiTestCase):
    def test_rows_outlive_the_server(self):
        _, answer = self.answer()
        _, comment = self.comment(section="risks", text="Hello")
        answers = self.ask("GET", "/api/answers?page=plan")
        threads = self.ask("GET", "/api/comments?page=plan")
        self.stop()

        self.start()
        self.assertEqual(self.ask("GET", "/api/answers?page=plan"), answers)
        self.assertEqual(self.ask("GET", "/api/comments?page=plan"), threads)
        self.assertEqual(answers[1]["questions"]["decision-1"]["current"], answer)
        self.assertEqual(threads[1]["threads"][0]["root"], comment)
        _, later = self.answer()
        self.assertEqual(later["supersedes"], answer["id"])
        self.assertGreater(later["id"], answer["id"])


MEDIA_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "media"
PNG = MEDIA_FIXTURES / "chart-1600x600.png"
JPEG = MEDIA_FIXTURES / "fish-320x240.jpg"
WEBP = MEDIA_FIXTURES / "lily-lossy-240x160.webp"
GIF = MEDIA_FIXTURES / "frog-140x100.gif"
SVG = MEDIA_FIXTURES / "logo.svg"
PADDED = MEDIA_FIXTURES / "padded-48x32-2000-bytes.png"
SIZE = re.compile(r"-(\d+)x(\d+)")
UPLOADS = ((PNG, "image/png", "png"), (JPEG, "image/jpeg", "jpg"),
           (WEBP, "image/webp", "webp"), (GIF, "image/gif", "gif"))
OTHER_READER = "heron@example.com"


class MediaTestCase(ApiTestCase):
    """POST /api/media into the media store beside the output directory."""

    def setUp(self) -> None:
        super().setUp()
        self.media_dir = media.media_dir(self.out_dir)

    def upload(self, data: bytes | Path, media_type: str, **kwargs):
        if isinstance(data, Path):
            data = data.read_bytes()
        headers = {"Content-Type": media_type, **kwargs.pop("headers", {})}
        return self.ask("POST", "/api/media", raw=data, headers=headers, **kwargs)

    def stored(self) -> list[str]:
        """The names in the media store."""
        if not self.media_dir.is_dir():
            return []
        return sorted(path.name for path in self.media_dir.iterdir())

    def api(self) -> api.Api:
        """The routes the running server answers with."""
        return self.server.RequestHandlerClass.keywords["api"]


class UploadTests(MediaTestCase):
    def test_each_type_is_stored_under_its_hash_with_its_size(self):
        for path, media_type, extension in UPLOADS:
            with self.subTest(path.name):
                status, got = self.upload(path, media_type)
                self.assertEqual(status, 201, got)
                name = f"{hashlib.sha256(path.read_bytes()).hexdigest()}.{extension}"
                width, height = (int(n) for n in SIZE.search(path.name).groups())
                self.assertEqual(got, {"name": name, "url": f"/media/{name}",
                                       "width": width, "height": height})
                self.assertEqual((self.media_dir / name).read_bytes(), path.read_bytes())
        before = self.stored()
        self.assertEqual(len(before), 4)
        status, again = self.upload(PNG, "image/png")
        self.assertEqual(status, 201, again)
        self.assertEqual(self.stored(), before)

    def test_uploads_not_a_whole_image_of_their_type_store_nothing(self):
        png = PNG.read_bytes()
        for label, data, media_type, kwargs, status, error in (
            ("SVG", SVG.read_bytes(), "image/svg+xml", {}, 415, "unsupported_media_type"),
            ("HTML", b"<!doctype html><p>Hello</p>", "text/html", {}, 415,
             "unsupported_media_type"),
            ("JPEG declared PNG", JPEG.read_bytes(), "image/png", {}, 400, "invalid_image"),
            ("PNG cut in half", png[:len(png) // 2], "image/png", {}, 400, "invalid_image"),
            ("another site", png, "image/png",
             {"headers": {"Origin": "https://elsewhere.example"}}, 403, "cross_origin"),
        ):
            with self.subTest(label):
                self.assertEqual(self.upload(data, media_type, **kwargs),
                                 (status, {"error": error}))
        status, _ = self.upload(png, "image/png", assertion=None)
        self.assertEqual(status, 401)
        self.assertEqual(self.stored(), [])

    def test_only_a_post_is_taken(self):
        status, got = self.ask("GET", "/api/media")
        self.assertEqual((status, got), (405, {"error": "method_not_allowed"}))
        self.assertEqual(self.stored(), [])

    def test_an_upload_over_the_cap_is_refused(self):
        self.stop()
        self.start(max_image_bytes=2000)
        self.assertEqual(PADDED.stat().st_size, 2000)
        self.assertEqual(self.upload(PNG, "image/png"), (413, {"error": "body_too_large"}))
        self.assertEqual(self.stored(), [])
        status, got = self.upload(PADDED, "image/png")
        self.assertEqual(status, 201, got)
        self.assertEqual(self.stored(), [got["name"]])
        _, threads = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(threads["maxImageBytes"], 2000)

    def test_a_reader_has_twenty_uploads_in_any_ten_minutes(self):
        self.stop()
        self.start(allowed_emails=f"{keys.EMAIL} {OTHER_READER}")
        now = [1_800_000_000.0]
        self.api().clock = lambda: now[0]
        for n in range(api.UPLOAD_LIMIT):
            now[0] += 1
            self.assertEqual(self.upload(GIF, "image/gif")[0], 201, n)
        self.assertEqual(api.UPLOAD_LIMIT, 20)
        self.assertEqual(self.upload(GIF, "image/gif"), (429, {"error": "too_many_uploads"}))
        other = keys.assertion(OTHER_READER)
        self.assertEqual(self.upload(JPEG, "image/jpeg", assertion=other)[0], 201)
        self.assertEqual(self.upload(PNG, "image/png"), (429, {"error": "too_many_uploads"}))
        self.assertEqual(len(self.stored()), 2)
        # Ten minutes after the first upload, it no longer counts.
        now[0] = 1_800_000_000.0 + 1 + api.UPLOAD_WINDOW
        status, got = self.upload(PNG, "image/png")
        self.assertEqual(status, 201, got)
        self.assertIn(got["name"], self.stored())
        self.assertEqual(self.upload(PNG, "image/png"), (429, {"error": "too_many_uploads"}))


class CommentImageTests(MediaTestCase):
    def test_a_reply_names_its_images_in_order(self):
        _, fish = self.upload(JPEG, "image/jpeg")
        _, chart = self.upload(PNG, "image/png")
        status, root = self.comment(section="risks", text="No images.")
        self.assertEqual(status, 201, root)
        self.assertEqual(root["images"], [])
        status, reply = self.comment(parent=root["id"], text="",
                                     images=[fish["name"], chart["name"]])
        self.assertEqual(status, 201, reply)
        self.assertEqual(reply["text"], "")
        self.assertEqual(reply["images"], [fish, chart])
        status, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(status, 200)
        [thread] = got["threads"]
        self.assertEqual(thread["root"]["images"], [])
        self.assertEqual(thread["replies"], [reply])
        self.assertEqual([(image["url"], image["width"], image["height"])
                          for image in thread["replies"][0]["images"]],
                         [(fish["url"], 320, 240), (chart["url"], 1600, 600)])

    def test_a_new_thread_names_its_images(self):
        _, frog = self.upload(GIF, "image/gif")
        status, root = self.comment(section="goals", text="", images=[frog["name"]])
        self.assertEqual(status, 201, root)
        self.assertEqual(root["images"], [frog])
        self.assertEqual(db.Database(self.db_path).comment(root["id"])["images"], [frog])

    def test_images_not_named_as_stored_are_refused(self):
        uploaded = [self.upload(path, media_type)[1]["name"] for path, media_type, _ in UPLOADS]
        uploaded.append(self.upload(PADDED, "image/png")[1]["name"])
        self.assertEqual(len(set(uploaded)), 5)
        _, root = self.comment(section="risks", text="A thread.")
        absent = "0" * 64 + ".png"
        self.assertFalse((self.media_dir / absent).exists())
        self.assertTrue((self.media_dir / ".." / self.db_path.name).is_file())
        for label, images, error in (
            ("not stored", [absent], "unknown_image"),
            ("the database", ["../" + self.db_path.name], "invalid_body"),
            ("five", uploaded, "invalid_body"),
            ("none", [], "invalid_body"),
            ("one twice", [uploaded[0], uploaded[0]], "invalid_body"),
            ("not a list", uploaded[0], "invalid_body"),
        ):
            for kind, body in (("new thread", {"section": "risks"}),
                               ("reply", {"parent": root["id"]})):
                with self.subTest(label, kind=kind):
                    self.assertEqual(self.comment(text="", images=images, **body),
                                     (400, {"error": error}))
        self.assertEqual(self.comment(section="risks", text=""), (400, {"error": "invalid_body"}))
        _, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(got["threads"],
                         [{"root": root, "replies": [], "resolution": db.UNRESOLVED}])


class SchemaTests(ApiTestCase):
    def test_a_comment_from_before_images_keeps_its_text(self):
        self.stop()
        path = self.work / "before.sqlite3"
        conn = sqlite3.connect(str(path))
        for step in range(1, db.SCHEMA_VERSION):
            for statement in db._SCHEMA[step]:
                conn.execute(statement)
        conn.execute(
            "INSERT INTO comments (page, section, section_title, revision, parent, text,"
            " quote, actor, created_at, state) VALUES ('plan', 'risks', 'Risks', ?, NULL,"
            " 'Kept from before.', NULL, ?, '2026-01-02T03:04:05.000Z', 'pending')",
            (self.revision, json.dumps(ACTOR)),
        )
        conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION - 1}")
        conn.commit()
        conn.close()
        self.start(path)
        status, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(status, 200, got)
        [thread] = got["threads"]
        self.assertEqual((thread["root"]["text"], thread["root"]["images"]),
                         ("Kept from before.", []))
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0],
                             db.SCHEMA_VERSION)
        finally:
            conn.close()


class ServeCommandTests(unittest.TestCase):
    """Where `lotuspod serve` keeps its database."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name).resolve()
        self.out_dir = self.work / "artifacts"
        self.out_dir.mkdir()
        config = self.work / "config.ini"
        config.write_text(keys.config_text(), encoding="utf-8")
        env = mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(config)})
        env.start()
        self.addCleanup(env.stop)
        quiet(self)
        run_cli("render", "--name", "plan", "--title", "Plan", "--body", DECISIONS_BODY,
                "--out-dir", str(self.out_dir))
        run_cli("index", "--out-dir", str(self.out_dir))

    def serve_argv(self, *extra: str) -> list[str]:
        return ["serve", "--host", HOST, "--port", "0", "--out-dir", str(self.out_dir), *extra]

    def test_db_inside_the_output_directory_is_refused(self):
        listing = sorted(str(p) for p in self.out_dir.rglob("*"))
        for inside in (self.out_dir / "lotuspod.sqlite3", self.out_dir / "sub" / "x.db",
                       self.out_dir):
            with self.subTest(inside=inside):
                out, err = io.StringIO(), io.StringIO()
                with mock.patch.object(cli, "_make_server") as make, \
                        redirect_stdout(out), redirect_stderr(err):
                    rc = cli.main(self.serve_argv("--db", str(inside)))
                self.assertEqual(rc, 1)
                make.assert_not_called()
                self.assertIn(str(inside), err.getvalue())
        self.assertEqual(sorted(str(p) for p in self.out_dir.rglob("*")), listing)

    def test_default_db_is_the_output_directorys_sibling(self):
        listing = sorted(str(p) for p in self.out_dir.rglob("*"))
        made = []
        ready = threading.Event()
        real = cli._make_server

        def make(*args, **kwargs):
            server = real(*args, **kwargs)
            made.append(server)
            ready.set()
            return server

        results = {}

        def serve() -> None:
            results["rc"] = cli.main(self.serve_argv())

        with mock.patch.object(cli, "_make_server", make), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            try:
                self.assertTrue(ready.wait(15))
                port = made[0].server_address[1]
                database = self.work / "lotuspod.sqlite3"
                self.assertFalse(database.exists())

                conn = http.client.HTTPConnection(HOST, port, timeout=15)
                page = (self.out_dir / "plan.html").read_text(encoding="utf-8")
                form = decisions.read_forms(page)["decision-1"]
                body = {"page": "plan", "question": "decision-1", "version": form.version,
                        "choice": "yes", "note": ""}
                conn.request("POST", "/api/answers", body=json.dumps(body),
                             headers={"Content-Type": "application/json",
                                      "Cf-Access-Jwt-Assertion": keys.assertion()})
                response = conn.getresponse()
                response.read()
                conn.close()
                self.assertEqual(response.status, 201)

                self.assertTrue(database.is_file())
                self.assertEqual(sorted(str(p) for p in self.out_dir.rglob("*")), listing)
                for path in ("/lotuspod.sqlite3", "/../lotuspod.sqlite3",
                             "/%2E%2E/lotuspod.sqlite3"):
                    conn = http.client.HTTPConnection(HOST, port, timeout=15)
                    conn.request("GET", path)
                    response = conn.getresponse()
                    response.read()
                    conn.close()
                    self.assertEqual(response.status, 404, path)
            finally:
                if made:
                    made[0].shutdown()
                thread.join(timeout=15)
        self.assertEqual(results.get("rc"), 0)


if __name__ == "__main__":
    unittest.main()
