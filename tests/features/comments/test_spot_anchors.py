"""A comment thread anchored to a spot on a diagram or an image: the comments
route checks `spot`, {id, hash, shape, nodes}, and stores it with its
target's title, threads answer it,
an earlier hash of the target is taken from the kept hashes or the site's
git history, and an agent's pull carries the spot with the target it is on.

serve runs on a thread with the test Access key trusted, as in
tests.features.agents.test_agent_pull; the reader posts over its port and
agents use the commands through its socket.

Run from the repo root:

    python -m unittest tests.features.comments.test_spot_anchors -v
"""

from __future__ import annotations

import hashlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "src"))

from lotuspod import core  # noqa: E402
from lotuspod.features.history import versions  # noqa: E402
from lotuspod.features.publish import render  # noqa: E402
from lotuspod.features.serve import pages as serve_pages, serve_files  # noqa: E402
from lotuspod.store import db  # noqa: E402
from tests.features.agents.test_agent_pull import PullTestCase, run_cli  # noqa: E402
from tests.features.blocks.test_targets import FLOW, IMAGE, digest, pond  # noqa: E402

# The schema main's database is written at.
MAIN_SCHEMA = 17
EDITED = FLOW.replace("Lake-->Sea", "Lake-->Ocean")
POD = [{"id": "Pod", "label": "Pod"}]
# pond's targets' titles, as serve stores them with a spot.
TITLES = {"flow": "Flow", "flow-diagram-2": "Flow", "pond-at-dawn": "Pond at dawn",
          "diagram-1": "", "later-diagram-1": "Later"}
WIDTH, HEIGHT = 1600, 600


def box(**changes) -> dict:
    return {"kind": "box", "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.25, **changes}


def titled(spot: dict) -> dict:
    return {**spot, "title": TITLES[spot["id"]]}


def git(cwd: Path, *argv: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *argv], check=True, capture_output=True)


class SpotCase(PullTestCase):
    """plan and loose as PullTestCase has them, and a page `pond` owned by
    hermes, published with --comments: diagrams `flow` and `flow-diagram-2`
    and image `pond-at-dawn` in section flow, `later-diagram-1` in section
    later and `diagram-1` before the first heading."""

    def prepare(self) -> None:
        (self.work / "pond.png").write_bytes(IMAGE.read_bytes())
        self.publish_pond(pond())

    def publish_pond(self, text: str) -> None:
        source = self.work / "pond.md"
        source.write_text(text, encoding="utf-8")
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                "--local", "--comments", "--owner", "hermes",
                                "--credential", str(self.desk))
        self.assertEqual(rc, 0, err)

    def spot(self, ident: str = "flow", **changes) -> dict:
        hashes = {"flow": digest(FLOW), "pond-at-dawn": self.image_hash()}
        return {"id": ident, "hash": hashes.get(ident, "0" * 12), "shape": box(),
                "nodes": POD if ident == "flow" else [], **changes}

    def image_hash(self) -> str:
        return hashlib.sha256(IMAGE.read_bytes()).hexdigest()[:12]

    def post(self, body: dict) -> tuple[int, dict]:
        return self.reader("POST", "/api/comments", {"page": "pond", **body})

    def stored(self) -> int:
        with sqlite3.connect(self.db_path) as conn:
            return conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0]

    def anchored(self, spot: dict | None = None) -> dict:
        spot = spot or self.spot()
        status, row = self.post({"section": "flow", "text": "@hermes This box is off.",
                                 "spot": spot})
        self.assertEqual(status, 201, row)
        self.assertEqual(row["spot"], titled(spot))
        return row

    def item(self, comment_id: int) -> dict:
        [found] = [item for item in self.pull("hermes")
                   if item["kind"] == "comment" and item["comment"]["id"] == comment_id]
        return found

    def text_pull(self) -> str:
        rc, out, err = self.agent("pull", "--owner", "hermes")
        self.assertEqual(rc, 0, out + err)
        return out


class RouteTests(SpotCase):
    def test_each_bad_spot_is_refused_and_stores_nothing(self):
        root = self.anchored()
        before = self.stored()
        text = {"section": "flow", "text": "Off."}
        quote = {"exact": "How it flows.", "prefix": "", "suffix": ""}
        widget = {"id": "flow", "hash": "0" * 12, "state": ""}
        points = [[0.5, 0.5]] * 257
        nodes = [{"id": f"N{at}", "label": f"N{at}"} for at in range(13)]
        cases = [
            ("an extra key", {**text, "spot": {**self.spot(), "colour": "red"}},
             400, "invalid_body"),
            ("a title", {**text, "spot": {**self.spot(), "title": "Elsewhere"}},
             400, "invalid_body"),
            ("a box with w 0", {**text, "spot": self.spot(shape=box(w=0))},
             400, "invalid_body"),
            ("a box outside a diagram, on no nodes",
             {**text, "spot": self.spot("flow-diagram-2", shape=box(x=1.5))},
             400, "invalid_body"),
            ("a box beyond the image's width",
             {**text, "spot": self.spot("pond-at-dawn",
                                        shape=box(x=WIDTH - 100, y=10, w=200, h=10))},
             400, "invalid_body"),
            ("a stroke of 257 points",
             {**text, "spot": self.spot(shape={"kind": "stroke", "points": points})},
             400, "invalid_body"),
            ("13 nodes", {**text, "spot": self.spot(nodes=nodes)}, 400, "invalid_body"),
            ("a node twice", {**text, "spot": self.spot(nodes=POD + POD)},
             400, "invalid_body"),
            ("nodes on the image", {**text, "spot": self.spot("pond-at-dawn", nodes=POD)},
             400, "invalid_body"),
            ("beside a quote", {**text, "quote": quote, "spot": self.spot()},
             400, "invalid_body"),
            ("beside a widget", {**text, "widget": widget, "spot": self.spot()},
             400, "invalid_body"),
            ("a boolean coordinate", {**text, "spot": self.spot(shape=box(x=True))},
             400, "invalid_body"),
            ("a coordinate too large for a float",
             {**text, "spot": self.spot("flow-diagram-2", shape=box(x=10 ** 400, w=0.1))},
             400, "invalid_body"),
            ("a hash not of 12 hex digits", {**text, "spot": self.spot(hash="F" * 12)},
             400, "invalid_body"),
            ("on a reply", {"parent": root["id"], "text": "Off.", "spot": self.spot()},
             400, "invalid_body"),
            ("an unknown id", {**text, "spot": self.spot("nope")}, 400, "unknown_spot"),
            ("a target in another section",
             {**text, "spot": self.spot("later-diagram-1",
                                        hash=digest("graph TD\n  Late-->Later"))},
             400, "unknown_spot"),
            ("a hash flow never had", {**text, "spot": self.spot(hash="0" * 12)},
             409, "stale_spot"),
        ]
        for name, body, code, error in cases:
            with self.subTest(name):
                status, payload = self.post(body)
                self.assertEqual((status, payload), (code, {"error": error}))
                self.assertEqual(self.stored(), before)
        status, payload = self.reader("POST", "/api/comments", {
            "page": "plan", "question": "decision-1", "text": "Off.", "spot": self.spot()})
        self.assertEqual((status, payload), (400, {"error": "invalid_body"}))
        self.assertEqual(self.stored(), before)

    def test_well_formed_spots_are_stored_as_sent(self):
        self.anchored()
        stroke = {"kind": "stroke", "points": [[0, 0], [WIDTH, HEIGHT], [12.5, 3]]}
        self.anchored(self.spot("pond-at-dawn", shape=stroke))
        # A mark on nodes is checked only for finite numbers.
        self.anchored(self.spot(shape=box(x=-3, w=40)))
        whole = self.spot("diagram-1", hash=digest("graph TD\n  Start-->Pond"),
                          shape=box(x=0, y=0, w=1, h=1))
        status, row = self.post({"section": "", "text": "Whole.", "spot": whole})
        self.assertEqual((status, row.get("spot")), (201, titled(whole)), row)

    def test_a_spot_thread_carries_its_spot_and_every_other_comment_null(self):
        spot = self.spot()
        root = self.anchored()
        status, reply = self.post({"parent": root["id"], "text": "Which box?"})
        self.assertEqual(status, 201, reply)
        self.assertIsNone(reply["spot"])
        status, plain = self.post({"section": "flow", "text": "Plain."})
        self.assertEqual(status, 201, plain)
        self.assertIsNone(plain["spot"])

        threads = {thread["root"]["id"]: thread for thread in self.threads("pond")}
        self.assertEqual(threads[root["id"]]["root"]["spot"], titled(spot))
        self.assertEqual([row["spot"] for row in threads[root["id"]]["replies"]], [None])
        self.assertIsNone(threads[plain["id"]]["root"]["spot"])

    def test_the_page_names_its_targets_with_their_sections(self):
        page = serve_pages.api_page(self.out_dir, "pond")
        self.assertEqual({ident: (target.kind, target.title, target.section)
                          for ident, target in page.targets.items()},
                         {"diagram-1": ("diagram", "", ""),
                          "flow": ("diagram", "Flow", "flow"),
                          "flow-diagram-2": ("diagram", "Flow", "flow"),
                          "pond-at-dawn": ("image", "Pond at dawn", "flow"),
                          "later-diagram-1": ("diagram", "Later", "later")})
        self.assertEqual(serve_pages.api_page(self.out_dir, "plan").targets, {})

    def test_an_image_shown_at_another_size_is_checked_against_its_natural_size(self):
        source = self.work / "pics.html"
        source.write_text('<h1>Pics</h1>\n<figure class="artifact-figure"><img src="pond.png" '
                          'alt="Shown small" width="40" height="30"></figure>\n', encoding="utf-8")
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                "--local", "--comments")
        self.assertEqual(rc, 0, err)
        image = serve_pages.api_page(self.out_dir, "pics").targets["shown-small"]
        self.assertEqual((image.width, image.height), (WIDTH, HEIGHT))
        spot = {"id": "shown-small", "hash": self.image_hash(), "nodes": [],
                "shape": box(x=100, y=10, w=20, h=20)}
        status, row = self.reader("POST", "/api/comments", {
            "page": "pics", "section": "page", "text": "Here.", "spot": spot})
        self.assertEqual((status, row.get("spot")), (201, {**spot, "title": "Shown small"}), row)


class SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / db.DEFAULT_NAME

    def test_main_s_database_migrates_and_its_comments_answer_spot_null(self):
        database = db.Database(self.path)
        actor = {"kind": "human", "email": "a@example.com"}
        root = database.add_comment(page="pond", section="flow", section_title="Flow",
                                    revision="r1", text="First.", quote=None, actor=actor)
        database.add_reply(page="pond", parent=root["id"], revision="r1",
                           sections={"flow": "Flow"}, text="Second.", actor=actor)
        with sqlite3.connect(self.path) as conn:
            conn.execute("DROP TABLE reactions")
            conn.execute("ALTER TABLE comments DROP COLUMN spot")
            conn.execute(f"PRAGMA user_version = {MAIN_SCHEMA}")

        [thread] = db.Database(self.path).threads("pond")
        self.assertIsNone(thread["root"]["spot"])
        self.assertEqual([row["spot"] for row in thread["replies"]], [None])
        with sqlite3.connect(self.path) as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0],
                             db.SCHEMA_VERSION)
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM comments WHERE spot IS NULL").fetchone()[0], 2)


class EarlierHashCase(SpotCase):
    def check_first_hash_stored(self) -> None:
        page = serve_pages.api_page(self.out_dir, "pond")
        self.assertEqual(page.targets["flow"].hash, digest(EDITED))
        row = self.anchored(self.spot(hash=digest(FLOW)))
        self.assertEqual(row["spot"]["hash"], digest(FLOW))
        self.assertEqual(self.item(row["id"])["target"]["status"], "changed")


class GitHistoryTests(EarlierHashCase):
    """The site is a clone of a local bare repository: pond published, then
    republished with flow's source edited, its kept hashes then removed so
    that only the history knows the first."""

    def prepare(self) -> None:
        bare = self.work / "origin.git"
        clone = self.work / "clone"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True,
                       capture_output=True)
        subprocess.run(["git", "clone", "-q", str(bare), str(clone)], check=True,
                       capture_output=True)
        shutil.move(str(clone / ".git"), str(self.out_dir / ".git"))
        for key, value in (("user.name", "Spot tests"), ("user.email", "spots@example.com"),
                           ("commit.gpgsign", "false")):
            git(self.out_dir, "config", key, value)
        super().prepare()
        self.publish_pond(pond(EDITED))
        (self.out_dir / f"pond{render.TARGETS_SUFFIX}").unlink()

    def test_the_history_holds_both_hashes_and_a_thread_at_the_first_is_stored(self):
        self.assertTrue(core.is_repository_top(self.out_dir))
        history = versions.History(self.out_dir, render.version_stamp)
        self.assertEqual(history.target_hashes("pond", "flow"), {digest(FLOW), digest(EDITED)})
        self.check_first_hash_stored()


class KeptHashTests(EarlierHashCase):
    """The site is no repository: pond published, then republished with
    flow's source edited, its target hashes kept beside it."""

    def prepare(self) -> None:
        super().prepare()
        self.publish_pond(pond(EDITED))

    def test_a_thread_at_the_first_hash_is_stored_from_the_kept_hashes(self):
        self.assertFalse(core.is_repository_top(self.out_dir))
        self.assertEqual(render.kept_target_hashes(self.out_dir, "pond")["flow"],
                         [digest(FLOW), digest(EDITED)])
        self.check_first_hash_stored()

    def test_the_kept_hashes_are_never_served(self):
        self.assertTrue((self.out_dir / f"pond{render.TARGETS_SUFFIX}").is_file())
        self.assertNotIn(f"pond{render.TARGETS_SUFFIX}",
                         serve_files.serve_allow_list(self.out_dir))


class PullTests(SpotCase):
    def test_the_pull_carries_the_spot_and_its_diagram(self):
        spot = self.spot()
        row = self.anchored()
        item = self.item(row["id"])
        self.assertEqual(item["spot"], titled(spot))
        self.assertEqual(item["target"], {"kind": "diagram", "title": "Flow", "status": "current",
                                          "source": FLOW, "nodes": POD})
        self.assertIn('- Spot: box on Pod (diagram "Flow")\n', self.text_pull())

        self.publish_pond(pond(EDITED))
        item = self.item(row["id"])
        self.assertEqual(item["target"], {"kind": "diagram", "title": "Flow", "status": "changed",
                                          "source": EDITED, "nodes": POD})
        self.assertIn('- Spot: box on Pod (diagram "Flow"), changed since\n', self.text_pull())

        self.publish_pond(pond(flow_fence=False))
        item = self.item(row["id"])
        self.assertEqual(item["target"], {"kind": "", "title": "", "status": "removed"})
        self.assertIn('- Spot: box on Pod ("Flow"), removed since\n', self.text_pull())

    def test_the_pull_carries_an_image_spot_s_url_and_size(self):
        stroke = {"kind": "stroke", "points": [[10, 10], [200, 120]]}
        row = self.anchored(self.spot("pond-at-dawn", shape=stroke))
        stored = hashlib.sha256(IMAGE.read_bytes()).hexdigest()
        self.assertEqual(self.item(row["id"])["target"],
                         {"kind": "image", "title": "Pond at dawn", "status": "current",
                          "url": f"/media/{stored}.png", "width": WIDTH, "height": HEIGHT})
        self.assertIn('- Spot: stroke (image "Pond at dawn")\n', self.text_pull())

    def test_a_thread_without_a_spot_has_neither(self):
        status, row = self.post({"section": "flow", "text": "@hermes Plain."})
        self.assertEqual(status, 201, row)
        item = self.item(row["id"])
        self.assertNotIn("spot", item)
        self.assertNotIn("target", item)
        self.assertNotIn("- Spot:", self.text_pull())


if __name__ == "__main__":
    unittest.main()
