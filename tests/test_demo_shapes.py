"""The shapes of the real serve's /api answers to the demo's request script
(tests/demo_shapes.py) are the committed fixture's,
tests/fixtures/demo/api-shapes.json: a change to an answer's shape fails here
until the fixture is recorded again, and e2e/demo/shapes.spec.ts then holds
the demo's shim to it.

The recorder runs inside the capture fixture, both as real subprocesses: no
Node, no browser. Record the fixture again with:

    python -m tests.capture_site python -m tests.demo_shapes --write

Run from the repo root:

    python -m unittest tests.test_demo_shapes -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest

from tests import demo_shapes

TIMEOUT = 300
COMMAND = (sys.executable, "-m", "tests.capture_site", sys.executable, "-m", "tests.demo_shapes")


class DemoShapesTests(unittest.TestCase):
    def test_serve_answers_the_fixture_shapes(self):
        done = subprocess.run(
            COMMAND, cwd=str(demo_shapes.REPO_ROOT), capture_output=True, text=True,
            timeout=TIMEOUT, check=False,
        )
        self.assertEqual(done.returncode, 0, f"the recorder failed:\n{done.stderr}")
        fixture_text = demo_shapes.FIXTURE.read_text(encoding="utf-8")
        recorded = json.loads(done.stdout)
        self.assertEqual(len(recorded["requests"]), 15)
        found = demo_shapes.compare(json.loads(fixture_text), recorded)
        self.assertEqual(
            found, [],
            "serve's /api answers differ from tests/fixtures/demo/api-shapes.json; if the "
            "change is meant, record it again (python -m tests.capture_site python -m "
            "tests.demo_shapes --write) and make demo/shim.js answer the same:\n"
            + "\n".join(found),
        )
        self.assertEqual(done.stdout, fixture_text,
                         "the fixture is not as the recorder writes it: record it again")


class ShapeTests(unittest.TestCase):
    def test_a_shape_keeps_types_not_values(self):
        self.assertEqual(
            demo_shapes.shape({"id": 3, "on": True, "text": "x", "gone": None, "list": []}),
            {"id": "number", "on": "boolean", "text": "string", "gone": "null", "list": []},
        )

    def test_a_list_merges_its_elements(self):
        self.assertEqual(
            demo_shapes.shape([{"a": None, "b": 1}, {"a": 2, "c": "x"}, {"a": None, "b": 1}]),
            [{"a": "null|number", "b": "number", "c": "string"}],
        )

    def test_null_or_an_object_records_both(self):
        self.assertEqual(
            demo_shapes.shape([{"quote": None}, {"quote": {"exact": "x"}}]),
            [{"quote": {"oneOf": ["null", {"exact": "string"}]}}],
        )

    def test_a_difference_names_the_key(self):
        self.assertEqual(
            demo_shapes.differences(
                demo_shapes.shape({"threads": [{"root": {"owner": "h"}}]}),
                demo_shapes.shape({"threads": [{"root": {"routedTo": "h"}}]}),
            ),
            [("threads[].root.owner", "the fixture has it, the answer does not"),
             ("threads[].root.routedTo", "the answer has it, the fixture does not")],
        )


if __name__ == "__main__":
    unittest.main()
