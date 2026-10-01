"""`lotuspod serve` keeps the reader's answers and comments: the four /api
routes over HTTP, signed in with assertions from the test key, their
refusals, the database across a restart, and where `serve` keeps it.

Run from the repo root:

    python -m unittest tests.test_api -v
"""

from __future__ import annotations

import http.client
import io
import json
import os
import re
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import access, cli, db, decisions, routing  # noqa: E402
from tests import access_keys as keys  # noqa: E402

HOST = "127.0.0.1"
ACTOR = {"kind": "human", "email": keys.EMAIL}
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

    def start(self, db_path: Path | None = None) -> None:
        verifier = access.Verifier(access.parse_config(keys.config_section()))
        server = cli._make_server(self.out_dir, HOST, 0, verifier=verifier,
                                  db_path=db_path or self.db_path)
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

    def assertEmpty(self, page: str = "plan") -> None:
        self.assertEqual(self.ask("GET", f"/api/answers?page={page}"),
                         (200, {"page": page, "questions": {}}))
        self.assertEqual(self.ask("GET", f"/api/comments?page={page}"),
                         (200, {"page": page, "threads": []}))


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
             "actor": ACTOR, "supersedes": None},
        )
        self.assertRegex(first["createdAt"], CREATED_AT)
        self.assertEqual(second["actor"], ACTOR)
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
             "quote": quote, "actor": ACTOR,
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
            self.assertEqual(row["actor"], ACTOR)

        self.assertEqual(
            self.ask("GET", "/api/comments?page=plan"),
            (200, {"page": "plan", "threads": [{"root": root, "replies": [reply, deeper]}]}),
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
        self.assertEqual(got["threads"], [{"root": root, "replies": []}])

    def test_threads_come_oldest_first_and_gone_sections_have_no_title(self):
        _, goals = self.comment(section="goals", text="Which goal first?")
        # A thread on a section an earlier revision had: the route takes new
        # threads only on the page's own boxes.
        elsewhere = db.Database(self.db_path).add_comment(
            page="plan", section="nowhere", section_title="Nowhere", revision="0" * 12,
            text="A section not on the page.", quote=None, actor=ACTOR,
        )
        elsewhere = routing.public(elsewhere, {}, routing.DEFAULT_WINDOW, 0)
        _, reply = self.comment(parent=elsewhere["id"], text="Still here.")
        self.assertEqual(goals["sectionTitle"], "Goals")
        self.assertEqual(reply["section"], "nowhere")
        self.assertEqual(reply["sectionTitle"], "")
        self.assertIsNone(reply["quote"])
        _, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(got["threads"], [{"root": goals, "replies": []},
                                          {"root": elsewhere, "replies": [reply]}])


class SignedOutTests(ApiTestCase):
    def test_every_route_needs_an_assertion(self):
        answer = {"page": "plan", "question": "q", "version": "v1", "choice": "yes", "note": ""}
        comment = {"page": "plan", "section": "risks", "text": "Hello"}
        for method, path, body in (
            ("POST", "/api/answers", answer),
            ("GET", "/api/answers?page=plan", None),
            ("POST", "/api/comments", comment),
            ("GET", "/api/comments?page=plan", None),
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
