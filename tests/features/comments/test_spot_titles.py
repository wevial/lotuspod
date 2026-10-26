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
from tests.features.blocks.test_targets import pond  # noqa: E402
from tests.features.comments.test_spot_anchors import SpotCase  # noqa: E402

STROKE = {"kind": "stroke", "points": [[10, 10], [200, 120]]}
WITHOUT_IMAGE = pond().replace("![Pond at dawn](pond.png)\n\n", "")


class TitleTests(SpotCase):
    def test_the_pull_names_a_removed_image_by_its_stored_title(self):
        titled = self.anchored(self.spot("pond-at-dawn", shape=STROKE))
        db.Database(self.db_path).add_comment(
            page="pond", section="flow", section_title="Flow", revision=titled["revision"],
            text="@hermes Older.", quote=None, actor=READER, owner="hermes",
            spot=self.spot("pond-at-dawn"))
        self.publish_pond(WITHOUT_IMAGE)

        pulled = self.text_pull()
        self.assertIn('- Spot: stroke ("Pond at dawn"), removed since\n', pulled)
        self.assertIn('- Spot: box ("pond-at-dawn"), removed since\n', pulled)
