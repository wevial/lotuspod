"""`lotuspod serve` remembers the revision each reader last opened a page
at: POST and GET /api/seen over HTTP, keyed by the reader's verified
address, their refusals, the record across a restart and a republish, and a
database from the previous schema step.

Run from the repo root:

    python -m unittest tests.test_seen -v
"""

from __future__ import annotations

import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import db  # noqa: E402
from tests import access_keys as keys  # noqa: E402
from tests.test_api import ACTOR, DECISIONS_BODY, PLAN, ApiTestCase, run_cli  # noqa: E402

OTHER = "heron@example.com"
R1 = "aaaaaaaaaaaa"
R2 = "bbbbbbbbbbbb"


class SeenTestCase(ApiTestCase):
    """The ApiTestCase site with a second reader allowed, b (OTHER), beside
    a, the maintainer."""

    def setUp(self) -> None:
        super().setUp()
        self.stop()
        self.start(allowed_emails=f"{keys.EMAIL} {OTHER}")

    def seen(self, page: str = "plan", revision: str = R1, *, email: str = keys.EMAIL,
             **extra):
        body = {"page": page, "revision": revision, **extra}
        return self.ask("POST", "/api/seen", body, assertion=keys.assertion(email))

    def views(self, email: str = keys.EMAIL):
        return self.ask("GET", "/api/seen", assertion=keys.assertion(email))

    def rows(self) -> list[tuple]:
        """Every stored (reader, page, revision); opening the database makes
        its schema when no request has yet."""
        with db.Database(self.db_path)._connect() as conn:
            return [tuple(row) for row in conn.execute(
                "SELECT reader, page, revision FROM page_views ORDER BY reader, page")]

    def republish(self) -> str:
        source = self.work / "plan.md"
        source.write_text(PLAN + "\nA line added since.\n", encoding="utf-8")
        run_cli("publish", str(source), "--name", "plan", "--out-dir", str(self.out_dir),
                "--local")
        return self.page_revision()


class SeenTests(SeenTestCase):
    def test_each_reader_has_their_own_record_and_it_outlives_the_server(self):
        self.assertEqual(self.seen(revision=R1),
                         (200, {"page": "plan", "revision": R1, "previous": None}))
        self.assertEqual(self.seen(revision=R2),
                         (200, {"page": "plan", "revision": R2, "previous": R1}))
        self.assertEqual(self.views(),
                         (200, {"pages": {"plan": {"revision": self.revision, "seen": R2}}}))
        self.assertEqual(self.views(OTHER), (200, {"pages": {}}))
        # Keyed by the address, never the shown name.
        self.assertEqual(self.rows(), [(keys.EMAIL, "plan", R2)])

        self.stop()
        self.start(allowed_emails=f"{keys.EMAIL} {OTHER}")
        self.assertEqual(self.seen(revision=self.revision),
                         (200, {"page": "plan", "revision": self.revision, "previous": R2}))
        self.assertEqual(self.views(),
                         (200, {"pages": {"plan": {"revision": self.revision,
                                                   "seen": self.revision}}}))

    def test_a_republish_shows_beside_the_revision_seen_and_a_hidden_page_is_left_out(self):
        other = self.page_revision("other")
        self.assertEqual(self.seen(revision=self.revision)[0], 200)
        self.assertEqual(self.seen("other", R1)[0], 200)
        revised = self.republish()
        self.assertNotEqual(revised, self.revision)
        self.assertEqual(self.views(), (200, {"pages": {
            "plan": {"revision": revised, "seen": self.revision},
            "other": {"revision": other, "seen": R1},
        }}))

        run_cli("render", "--name", "plan", "--title", "Plan", "--comments", "--body",
                DECISIONS_BODY, "--out-dir", str(self.out_dir), "--hidden")
        self.assertEqual(self.views(), (200, {"pages": {
            "other": {"revision": other, "seen": R1},
        }}))

    def test_a_refused_post_stores_nothing(self):
        for body, headers, assertion, answer in (
            ({"page": "secret", "revision": R1}, {}, "default",
             (404, {"error": "unknown_page"})),
            ({"page": "missing", "revision": R1}, {}, "default",
             (404, {"error": "unknown_page"})),
            ({"page": "plan", "revision": 1}, {}, "default", (400, {"error": "invalid_body"})),
            ({"page": "plan", "revision": R1, "extra": "x"}, {}, "default",
             (400, {"error": "invalid_body"})),
            ({"page": "plan", "revision": R1}, {"Origin": "https://elsewhere.example"},
             "default", (403, {"error": "cross_origin"})),
            ({"page": "plan", "revision": R1}, {}, None, (401, {"error": "signed_out"})),
        ):
            with self.subTest(body=body, headers=headers, assertion=assertion):
                self.assertEqual(self.ask("POST", "/api/seen", body, headers=headers,
                                          assertion=assertion), answer)
        self.assertEqual(self.ask("GET", "/api/seen?page=plan"),
                         (400, {"error": "invalid_query"}))
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.views(), (200, {"pages": {}}))

    def test_a_post_that_is_not_two_strings_is_refused(self):
        for body in (
            {"page": "plan"},
            {"revision": R1},
            {"page": "plan", "revision": ""},
            {"page": "plan", "revision": "r" * 101},
            {"page": "plan", "revision": None},
            {"page": ["plan"], "revision": R1},
        ):
            with self.subTest(body=body):
                self.assertEqual(self.ask("POST", "/api/seen", body),
                                 (400, {"error": "invalid_body"}))
        self.assertEqual(self.ask("POST", "/api/seen", raw=b"page=plan",
                                  headers={"Content-Type": "text/plain"}),
                         (415, {"error": "unsupported_media_type"}))
        self.assertEqual(self.rows(), [])


class SeenSchemaTests(SeenTestCase):
    def test_a_database_from_the_previous_step_keeps_its_rows(self):
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
        conn.execute(
            "INSERT INTO answers (page, question, version, choice, note, revision, actor,"
            " created_at, supersedes, question_text, choice_label) VALUES ('plan',"
            " 'decision-1', ?, 'no', 'Also kept.', ?, ?, '2026-01-02T03:04:05.000Z',"
            " NULL, 'Freeze the pond?', 'No')",
            (self.version(), self.revision, json.dumps(ACTOR)),
        )
        conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION - 1}")
        conn.commit()
        conn.close()
        self.start(path, allowed_emails=f"{keys.EMAIL} {OTHER}")

        status, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(status, 200, got)
        [thread] = got["threads"]
        self.assertEqual(thread["root"]["text"], "Kept from before.")
        status, got = self.ask("GET", "/api/answers?page=plan")
        self.assertEqual(status, 200, got)
        current = got["questions"]["decision-1"]["current"]
        self.assertEqual((current["choice"], current["note"], current["revision"]),
                         ("no", "Also kept.", self.revision))

        self.assertEqual(self.seen(revision=R1),
                         (200, {"page": "plan", "revision": R1, "previous": None}))
        self.assertEqual(self.views(),
                         (200, {"pages": {"plan": {"revision": self.revision, "seen": R1}}}))
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0],
                             db.SCHEMA_VERSION)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
