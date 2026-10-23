"""Labels on the index: each row carries its page's labels as tags, and on the
row for the index script's Labels filter.

Run from the repo root:

    python -m unittest tests.features.index.test_index_labels -v
"""

from __future__ import annotations

import unittest

from tests.test_labels import LabelsCase, _IndexRows, run_cli

from lotuspod import core  # after test_labels, which puts src/ on the path
from lotuspod.features.index import listing


class IndexLabelsTests(LabelsCase):
    def test_rows_carry_their_labels_as_tags_and_data_labels_in_one_flat_table(self):
        pages = {
            "alpha": ("Alpha", ["relos"]),
            "beta": ("Beta", ["croton", "relos"]),
            "gamma": ("Gamma", ["holophyte"]),
            "delta": ("Delta", []),
        }
        for name, (title, labels) in pages.items():
            extra = [arg for label in labels for arg in ("--label", label)]
            self.published(self.source(name, title), *extra)
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        parsed = _IndexRows()
        parsed.feed((self.out_dir / core.INDEX_FILE).read_text(encoding="utf-8"))
        self.assertEqual(parsed.tbodies, 1)
        self.assertEqual(len(parsed.rows), len(pages))
        updated = [row["updated"] for row in parsed.rows]
        self.assertEqual(updated, sorted(updated, reverse=True))
        artifacts, _ = listing.collect_artifacts(self.out_dir)
        self.assertEqual([row["title"] for row in parsed.rows],
                         [entry["title"] for entry in artifacts])
        by_title = {row["title"]: row for row in parsed.rows}
        for title, labels in pages.values():
            with self.subTest(title=title):
                row = by_title[title]
                self.assertEqual(row["tags"], labels)
                self.assertEqual(row["data-labels"], ",".join(labels) if labels else None)


if __name__ == "__main__":
    unittest.main()
