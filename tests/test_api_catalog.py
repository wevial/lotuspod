"""`lotuspod serve` reads its allow-list once per /api request: /api/seen
and /api/activity answer through cli.api_catalog as api.Api answers
without one, and their time grows linearly with the site's page count.

Run from the repo root:

    python -m unittest tests.test_api_catalog -v
"""

from __future__ import annotations

import datetime
import io
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from email.message import Message
from functools import partial
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import access, api, cli, core, serve_files  # noqa: E402
from lotuspod.features.publish import render  # noqa: E402
from lotuspod.features.history import archive, versions  # noqa: E402
from lotuspod.store import db  # noqa: E402
from tests import access_keys as keys  # noqa: E402
from tests.capture_site import repository  # noqa: E402
from tests.test_api import ACTOR, DECISIONS_BODY, HOST, ApiTestCase, quiet, run_cli  # noqa: E402

# Enough text that reading a page costs about what a real one does.
BODY = DECISIONS_BODY + "".join(
    f"<h2 id=\"part-{n}\">Part {n}</h2>\n<p>{'A line of the page. ' * 40}</p>\n"
    for n in range(4))


def page_name(n: int) -> str:
    return f"page-{n:03d}"


class CatalogTestCase(unittest.TestCase):
    """A site that is its own git repository, holding copies of one rendered
    page, served with the test key trusted and a database beside it."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        self.out_dir = self.work / "site"
        self.out_dir.mkdir()
        repository(self.out_dir)
        self.db_path = self.work / "answers.sqlite3"
        config = self.work / "config.ini"
        config.write_text(keys.config_text(), encoding="utf-8")
        env = mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(config)})
        env.start()
        self.addCleanup(env.stop)
        quiet(self)
        run_cli("render", "--name", page_name(0), "--title", "Sample", "--comments",
                "--body", BODY, "--out-dir", str(self.out_dir))
        self.pages = 1
        self.database = db.Database(self.db_path)
        self.revision = core.page_revision(self.out_dir, page_name(0))

        verifier = access.Verifier(access.parse_config(keys.config_section()))
        server = cli._make_server(self.out_dir, HOST, 0, verifier=verifier,
                                  db_path=self.db_path)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.port = server.server_address[1]

        def stop() -> None:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.addCleanup(stop)

    ask = ApiTestCase.ask

    def grow(self, pages: int) -> None:
        """Copy the rendered page until the site holds pages of them, each
        opened by the reader."""
        source = self.out_dir / f"{page_name(0)}.html"
        for n in range(self.pages, pages):
            shutil.copyfile(source, self.out_dir / f"{page_name(n)}.html")
        for n in range(pages):
            self.database.record_view(reader=keys.EMAIL, page=page_name(n),
                                      revision=self.revision)
        self.pages = pages

    def uncatalogued(self, path: str, query: str = "") -> dict:
        """The answer of api.Api built without a catalog, as serve built it
        before."""
        routes = api.Api(db.Database(self.db_path), partial(cli.api_page, self.out_dir),
                         history=versions.History(self.out_dir, render.version_stamp),
                         names=partial(cli.served_page_names, self.out_dir))
        status, payload, _ = routes.answer("GET", path, query, Message(), None, ACTOR)
        self.assertEqual(status, 200, payload)
        return payload

    def reads(self, path: str) -> int:
        """How many times one request for path reads the allow-list."""
        with mock.patch.object(serve_files, "serve_allow_list", wraps=serve_files.serve_allow_list) as read:
            status, _ = self.ask("GET", path)
        self.assertEqual(status, 200)
        return read.call_count

    def timed(self, path: str) -> float:
        start = time.perf_counter()
        status, _ = self.ask("GET", path)
        elapsed = time.perf_counter() - start
        self.assertEqual(status, 200)
        return elapsed


class SeenTests(CatalogTestCase):

    def test_seen_answers_as_without_a_catalog(self) -> None:
        self.grow(400)
        status, answer = self.ask("GET", "/api/seen")
        self.assertEqual(status, 200)
        self.assertEqual(len(answer["pages"]), 400)
        self.assertEqual(answer, self.uncatalogued("/api/seen"))

    def test_seen_reads_the_allow_list_once(self) -> None:
        self.grow(50)
        self.assertEqual(self.reads("/api/seen"), 1)

    def test_seen_of_a_reader_who_opened_nothing_reads_no_page(self) -> None:
        self.assertEqual(self.reads("/api/seen"), 0)

    def test_seen_time_grows_linearly(self) -> None:
        self.grow(50)
        small = self.timed("/api/seen")
        self.grow(400)
        large = self.timed("/api/seen")
        print(f"\n/api/seen: {small:.3f} s at 50 pages, {large:.3f} s at 400 "
              f"({large / small:.1f}x)", file=sys.stderr)
        self.assertLess(large, 20 * small)


class ActivityTests(CatalogTestCase):

    def test_activity_answers_as_without_a_catalog(self) -> None:
        self.grow(400)
        for n in range(100):
            self.database.add_comment(page=page_name(n), section="page",
                                      section_title="Page", revision=self.revision,
                                      text=f"A note on {page_name(n)}.", quote=None,
                                      actor=ACTOR)
        with redirect_stdout(io.StringIO()):
            archive.set_archived(self.out_dir, page_name(7), True)
        # A fixed window, so both answers name the same from and to.
        later = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)
        query = "before=" + later.strftime("%Y-%m-%dT%H:%M:%SZ")
        status, answer = self.ask("GET", f"/api/activity?{query}")
        self.assertEqual(status, 200)
        named = [entry["page"] for entry in answer["pages"]]
        self.assertNotIn(page_name(7), named)
        self.assertIn(page_name(8), named)
        self.assertEqual(answer, self.uncatalogued("/api/activity", query))

    def test_activity_reads_the_allow_list_once(self) -> None:
        self.grow(50)
        self.database.add_comment(page=page_name(3), section="page", section_title="Page",
                                  revision=self.revision, text="A note.", quote=None,
                                  actor=ACTOR)
        self.assertEqual(self.reads("/api/activity"), 1)


class CatalogTests(CatalogTestCase):

    def test_a_page_hidden_after_the_read_is_not_served(self) -> None:
        self.grow(2)
        lookup = cli.api_catalog(self.out_dir)
        self.assertIsNotNone(lookup(page_name(0)))
        run_cli("render", "--name", page_name(1), "--title", "Private", "--hidden",
                "--body", BODY, "--out-dir", str(self.out_dir))
        self.assertIsNone(lookup(page_name(1)))

    def test_a_page_linked_away_after_the_read_is_not_served(self) -> None:
        self.grow(2)
        lookup = cli.api_catalog(self.out_dir)
        self.assertIsNotNone(lookup(page_name(0)))
        outside = self.work / "outside.html"
        shutil.copyfile(self.out_dir / f"{page_name(0)}.html", outside)
        (self.out_dir / f"{page_name(1)}.html").unlink()
        (self.out_dir / f"{page_name(1)}.html").symlink_to(outside)
        self.assertIsNone(lookup(page_name(1)))


if __name__ == "__main__":
    unittest.main()
