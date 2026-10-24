"""Test suite for `ci/move_witness.py`'s `--rewritten MODULE`: the names a
rewritten test module declares may be added or dropped at either tree, each
listed as allowed, while every other module's names are compared as before.

Run from the repo root:

    python -m unittest tests.test_move_witness_rewritten -v
"""

from __future__ import annotations

import unittest

from ci import move_witness


class RewrittenTest(unittest.TestCase):
    BEFORE = {("tests/core/test_theme_sources.py", "JoinTests.test_old"): 1,
              ("tests/core/test_theme_sources.py", "JoinTests.test_kept"): 1,
              ("tests/test_other.py", "Other.test_it"): 1}

    def test_a_rewritten_modules_names_may_be_added_or_dropped(self):
        after = {("tests/core/test_theme_sources.py", "JoinTests.test_new"): 1,
                 ("tests/core/test_theme_sources.py", "JoinTests.test_kept"): 1,
                 ("tests/test_other.py", "Other.test_it"): 1}
        lines, allowed = move_witness.multiset_differences(
            "unittest", self.BEFORE, after, {path for path, _ in self.BEFORE},
            frozenset({move_witness.module_path("tests.core.test_theme_sources")}))
        self.assertEqual(lines, [])
        self.assertEqual(allowed, [
            "unittest: 'JoinTests.test_new' is added in tests/core/test_theme_sources.py, "
            "rewritten (0 time(s) at the merge base, 1 here)",
            "unittest: 'JoinTests.test_old' is dropped in tests/core/test_theme_sources.py, "
            "rewritten (1 time(s) at the merge base, 0 here)",
        ])

    def test_every_other_modules_names_are_compared_as_before(self):
        after = {key: count for key, count in self.BEFORE.items() if key[0] != "tests/test_other.py"}
        lines, allowed = move_witness.multiset_differences(
            "unittest", self.BEFORE, after, {path for path, _ in self.BEFORE},
            frozenset({"tests/core/test_theme_sources.py"}))
        self.assertEqual(lines, ["unittest: 'Other.test_it' is discovered 1 time(s) at the "
                                 "merge base and 0 time(s) here"])
        self.assertEqual(allowed, [])

    def test_without_the_option_a_dropped_name_is_a_difference(self):
        after = {key: count for key, count in self.BEFORE.items() if key[1] != "JoinTests.test_old"}
        lines, _ = move_witness.multiset_differences(
            "unittest", self.BEFORE, after, {path for path, _ in self.BEFORE})
        self.assertEqual(lines, ["unittest: 'JoinTests.test_old' is discovered 1 time(s) at the "
                                 "merge base and 0 time(s) here"])


if __name__ == "__main__":
    unittest.main()
