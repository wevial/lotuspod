"""A spot is stored with its target's title, as serve read the page when the
thread was posted: rows and an agent's pull carry it, and the pull names a
removed target by it; a spot stored before titles were kept has none.

serve runs on a thread as in tests.features.comments.test_spot_anchors.

Run from the repo root:

    python -m unittest tests.features.comments.test_spot_titles -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "src"))

from lotuspod.store import db  # noqa: E402
from tests.features.agents.test_agent_pull import READER  # noqa: E402
from tests.features.blocks.test_targets import SECOND, digest, pond  # noqa: E402
from tests.features.comments.test_spot_anchors import SpotCase  # noqa: E402

STROKE = {"kind": "stroke", "points": [[10, 10], [200, 120]]}
WITHOUT_IMAGE = pond().replace("![Pond at dawn](pond.png)\n\n", "")


class TitleTests(SpotCase):
    def test_each_spot_is_stored_and_served_with_its_target_s_title(self):
        image = self.spot("pond-at-dawn", shape=STROKE)
        diagram = self.spot("flow-diagram-2", hash=digest(SECOND))
        self.assertEqual(diagram["nodes"], [])
        image_row, diagram_row = self.anchored(image), self.anchored(diagram)
        self.assertEqual(image_row["spot"], {**image, "title": "Pond at dawn"})
        self.assertEqual(diagram_row["spot"], {**diagram, "title": "Flow"})

        roots = {thread["root"]["id"]: thread["root"] for thread in self.threads("pond")}
        self.assertEqual(roots[image_row["id"]]["spot"], image_row["spot"])
        self.assertEqual(roots[diagram_row["id"]]["spot"], diagram_row["spot"])

    def test_a_spot_sent_with_a_title_is_refused(self):
        before = self.stored()
        status, payload = self.post({"section": "flow", "text": "Off.", "spot": {
            **self.spot("pond-at-dawn", shape=STROKE), "title": "Elsewhere"}})
        self.assertEqual((status, payload), (400, {"error": "invalid_body"}))
        self.assertEqual(self.stored(), before)

    def test_the_pull_names_a_removed_image_by_its_stored_title(self):
        titled = self.anchored(self.spot("pond-at-dawn", shape=STROKE))
        old_spot = self.spot("pond-at-dawn")
        old = db.Database(self.db_path).add_comment(
            page="pond", section="flow", section_title="Flow", revision=titled["revision"],
            text="@hermes Older.", quote=None, actor=READER, owner="hermes", spot=old_spot)
        self.publish_pond(WITHOUT_IMAGE)

        item = self.item(titled["id"])
        self.assertEqual(item["spot"]["title"], "Pond at dawn")
        self.assertEqual(item["target"], {"kind": "", "title": "", "status": "removed"})
        older = self.item(old["id"])
        self.assertEqual(older["spot"], old_spot)
        self.assertNotIn("title", older["spot"])
        pulled = self.text_pull()
        self.assertIn('- Spot: stroke ("Pond at dawn"), removed since\n', pulled)
        self.assertIn('- Spot: box ("pond-at-dawn"), removed since\n', pulled)
