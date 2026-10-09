"""Test suite for the Nodes table under a flowchart
(`src/lotuspod/node_tables.py`): render marks the diagram, its heading, its
table and each body row with attributes, and changes nothing else in the
body.

Run from the repo root:

    python -m unittest tests.test_node_tables -v
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path

from tests.test_manifest_v2 import TempDirTestCase

from lotuspod import cli, markdown  # after test_manifest_v2, which puts src/ on the path
from lotuspod.node_tables import mark_node_tables

DIAGRAM = """\
```mermaid
flowchart LR
  A --> B
  B --> C
  A --> D
```
"""

TABLE = """\
| Node | Title | Status | PR |
|---|---|---|---|
| A | Write the parser | merged | [#11](https://example.com/pull/11) |
| B | Draw the cards | Open | [#12](https://example.com/pull/12) |
| C | Light the arrows | ready | |
| D | Color the boxes | waiting | |
"""

SOURCE = f"Intro.\n\n{DIAGRAM}\n### Nodes\n\n{TABLE}"

# Every attribute mark_node_tables adds, as it spells it.
ADDED = re.compile(
    r' (?:data-node-table|data-node|data-status|id)="[^"]*"'
    r'| class="(?:artifact-node-heading|artifact-node-table)"'
)


def body(source: str) -> str:
    return markdown.to_body(source, {})


def unmarked(marked: str) -> str:
    return ADDED.sub("", marked)


def rows(marked: str) -> list[str]:
    return re.findall(r"<tr\b[^>]*>", marked.split("<tbody>", 1)[1])


class MarkTests(TempDirTestCase):
    def assert_marked(self, original: str, heading: str) -> None:
        marked, found = mark_node_tables(original)
        self.assertTrue(found)
        table_id = re.search(r'<table id="([^"]+)" class="artifact-node-table">', marked)
        self.assertIsNotNone(table_id, marked)
        self.assertIn(f'<pre data-node-table="{table_id.group(1)}" class="mermaid">', marked)
        self.assertIn(f'<{heading} class="artifact-node-heading">Nodes</{heading}>', marked)
        self.assertEqual(rows(marked), [
            '<tr data-node="A" data-status="merged">',
            '<tr data-node="B" data-status="open">',
            '<tr data-node="C" data-status="ready">',
            '<tr data-node="D" data-status="waiting">',
        ])
        heading_tag = re.search(rf"<{heading}\b[^>]*>", marked).group(0)
        table_tag = re.search(r"<table\b[^>]*>", marked).group(0)
        for tag in (heading_tag, table_tag):
            self.assertNotIn("hidden", tag)
            self.assertNotIn("style", tag)
        self.assertEqual(unmarked(marked), original)

    def test_a_flowchart_its_nodes_heading_and_table_are_marked(self):
        self.assert_marked(body(SOURCE), "h3")

    def test_an_h4_heading_is_marked_the_same_way(self):
        original = body(SOURCE).replace("<h3>Nodes</h3>", "<h4>Nodes</h4>")
        self.assert_marked(original, "h4")

    def test_a_graph_after_a_directive_is_a_flowchart(self):
        source = SOURCE.replace("flowchart LR", "%%{init: {}}%%\ngraph TD")
        marked, found = mark_node_tables(body(source))
        self.assertTrue(found)
        self.assertIn('data-node="A"', marked)

    def test_the_table_id_is_kept_or_made_unique(self):
        original = body(SOURCE)
        named = original.replace("<table>", '<table id="plan" class="wide">')
        marked, _ = mark_node_tables(named)
        self.assertIn('<table id="plan" class="wide artifact-node-table">', marked)
        self.assertIn('data-node-table="plan"', marked)
        taken = '<p id="nodes-table">Taken.</p>\n' + original
        marked, _ = mark_node_tables(taken)
        self.assertIn('<table id="nodes-table-2" class="artifact-node-table">', marked)

    def test_a_body_without_the_pattern_is_returned_as_written(self):
        sequence = DIAGRAM.replace("flowchart LR\n  A --> B\n  B --> C\n  A --> D",
                                   "sequenceDiagram\n  A->>B: hi")
        bodies = {
            "a sequence diagram": body(f"{sequence}\n### Nodes\n\n{TABLE}"),
            "a paragraph between": body(f"{DIAGRAM}\nBetween.\n\n### Nodes\n\n{TABLE}"),
            "another heading": body(f"{DIAGRAM}\n### Node list\n\n{TABLE}"),
            "an h2": body(f"{DIAGRAM}\n## Nodes\n\n{TABLE}"),
            "no diagram": body(f"Intro.\n\n### Nodes\n\n{TABLE}"),
            "a paragraph after the heading": body(f"{DIAGRAM}\n### Nodes\n\nNo table.\n"),
        }
        for name, original in bodies.items():
            with self.subTest(name):
                self.assertEqual(mark_node_tables(original), (original, False))

    def test_a_heading_in_the_diagram_is_diagram_source(self):
        original = ('<pre class="mermaid">flowchart LR\n  A --&gt; B\n</pre>\n'
                    '<pre class="mermaid">graph LR\n<h3>Nodes</h3><table><tr><td>A</td></tr>'
                    '</table></pre>\n')
        self.assertEqual(mark_node_tables(original), (original, False))

    def test_rows_that_name_no_node_and_statuses_not_known(self):
        table = """\
| Node | Title | Status |
|---|---|---|
|  | Empty | merged |
| two words | Spaced | open |
| A | First | In review |
| A | Again | ready |
| B | Second | done |
| C | Third |  |
"""
        marked, found = mark_node_tables(body(f"{DIAGRAM}\n### Nodes\n\n{table}"))
        self.assertTrue(found)
        self.assertEqual(rows(marked), [
            '<tr data-status="merged">',
            '<tr data-status="open">',
            '<tr data-node="A">',
            '<tr data-status="ready">',
            '<tr data-node="B">',
            '<tr data-node="C">',
        ])


class RenderTests(TempDirTestCase):
    def rendered(self, source: str) -> str:
        path = Path(self.enterContext(tempfile.TemporaryDirectory())) / "page.md"
        path.write_text(source, encoding="utf-8")
        rc, _, err = self.render("plan", "--date", "2026-01-02", "--markdown", str(path),
                                 "--no-outline")
        self.assertEqual(rc, 0, err)
        return (self.out_dir / "plan.html").read_text(encoding="utf-8")

    def test_a_diagram_alone_loads_no_page_script(self):
        sequence = "```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n"
        for diagram in (sequence, DIAGRAM):
            with self.subTest(diagram.splitlines()[1]):
                page = self.rendered(f"Intro.\n\n{diagram}")
                self.assertIn('class="mermaid"', page)
                self.assertNotIn(cli.PAGE_SCRIPT, page)

    def test_a_marked_diagram_loads_the_page_script_once(self):
        page = self.rendered(SOURCE)
        self.assertIn("data-node-table=", page)
        self.assertEqual(page.count(f'<script src="{cli.PAGE_SCRIPT}?v='), 1)


if __name__ == "__main__":
    import unittest

    unittest.main()
