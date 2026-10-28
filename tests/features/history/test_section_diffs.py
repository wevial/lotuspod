"""Witness: the changes answer carries each changed section's own source
diff, cut from that section's part of each version's markdown source.

Pages are published with this checkout's CLI into a real git repository and
asked of a real `lotuspod serve`, as tests.test_changes_witness does.
"""

from __future__ import annotations

import unittest

from tests.test_changes_witness import ChangesWitness, body
from lotuspod.features.history import versions

PAGE = "pond-plan"


def page(alpha: str, beta: str, gamma: str = "The ducks leave.") -> str:
    return f"""\
# Pond plan

The plan for the pond this winter.

## Alpha

{alpha}

## Beta

The pump stops with it.
{beta}
And the fish sleep.

## Gamma

{gamma}
"""


FENCED = "The pond freezes in January.\n\n```\n## not a heading\n```"
QUOTED = "The pond freezes in January.\n\n> ## Aside\n> The ice is thin."


def texts(lines: list[dict]) -> list[str]:
    return [line["text"] for line in lines]


class SectionDiffTests(ChangesWitness):
    def ask(self, first: str) -> dict:
        self.start_server()
        status, _, answer = self.changes(PAGE, first)
        self.assertEqual(status, 200, answer)
        return answer

    def test_each_changed_section_carries_its_own_lines(self):
        self.repository(self.out)
        first = self.publish_markdown(PAGE, page("The pond freezes in January.", "old line"))
        self.publish_markdown(PAGE, page("The pond thaws in March.", "new line"))
        answer = self.ask(first)

        changed = answer["sections"]["changed"]
        self.assertEqual([(entry["id"], entry["title"]) for entry in changed],
                         [("alpha", "Alpha"), ("beta", "Beta")])
        for entry in changed:
            self.assertEqual(set(entry), {"id", "title", "lines", "truncated"})
            self.assertEqual(entry["lines"][0]["op"], "@")
            self.assertIs(entry["truncated"], False)
        alpha, beta = changed
        self.assertIn({"op": "-", "text": "The pond freezes in January."}, alpha["lines"])
        self.assertIn({"op": "+", "text": "The pond thaws in March."}, alpha["lines"])
        self.assertNotIn("old line", texts(alpha["lines"]))
        self.assertNotIn("new line", texts(alpha["lines"]))
        self.assertIn({"op": "-", "text": "old line"}, beta["lines"])
        self.assertIn({"op": "+", "text": "new line"}, beta["lines"])
        self.assertNotIn("The pond freezes in January.", texts(beta["lines"]))
        self.assertNotIn("The pond thaws in March.", texts(beta["lines"]))
        for line in ({"op": "-", "text": "The pond freezes in January."},
                     {"op": "+", "text": "The pond thaws in March."},
                     {"op": "-", "text": "old line"}, {"op": "+", "text": "new line"}):
            self.assertIn(line, answer["lines"])

    def test_a_heading_line_inside_a_fence_does_not_split_its_section(self):
        self.repository(self.out)
        first = self.publish_markdown(PAGE, page(FENCED, "old line"))
        self.publish_markdown(PAGE, page(FENCED, "new line"))
        answer = self.ask(first)

        changed = answer["sections"]["changed"]
        self.assertEqual([entry["title"] for entry in changed], ["Beta"])
        lines = changed[0]["lines"]
        self.assertIn({"op": "-", "text": "old line"}, lines)
        self.assertIn({"op": "+", "text": "new line"}, lines)
        for text in ("The pond freezes in January.", "## not a heading", "```", "## Alpha"):
            self.assertNotIn(text, texts(lines))

    def test_a_heading_in_a_blockquote_gives_no_section_its_own_lines(self):
        self.repository(self.out)
        first = self.publish_markdown(PAGE, page(QUOTED, "old line"))
        self.publish_markdown(PAGE, page(QUOTED, "new line"))
        answer = self.ask(first)

        changed = answer["sections"]["changed"]
        self.assertTrue(changed)
        for entry in changed:
            self.assertNotIn("lines", entry)
            self.assertNotIn("truncated", entry)
        self.assertIn({"op": "-", "text": "old line"}, answer["lines"])
        self.assertIn({"op": "+", "text": "new line"}, answer["lines"])

    def test_a_page_with_no_kept_source_gives_no_section_lines(self):
        self.repository(self.out)
        self.render(PAGE, body(("Alpha", "The pond freezes."), ("Beta", "old line")), "rev-one")
        self.render(PAGE, body(("Alpha", "The pond freezes."), ("Beta", "new line")), "rev-two")
        answer = self.ask("rev-one")

        changed = answer["sections"]["changed"]
        self.assertEqual([entry["title"] for entry in changed], ["Beta"])
        self.assertNotIn("lines", changed[0])
        self.assertNotIn("truncated", changed[0])
        self.assertNotIn("lines", answer)

    def test_a_section_diff_past_the_cap_is_cut(self):
        self.repository(self.out)
        lines = [f"Line {n} of the plan." for n in range(versions.MAX_DIFF_LINES)]
        first = self.publish_markdown(PAGE, page("\n\n".join(lines), "old line"))
        self.publish_markdown(PAGE, page("\n\n".join(
            line.replace("plan", "new plan") for line in lines), "old line"))
        answer = self.ask(first)

        changed = answer["sections"]["changed"]
        self.assertEqual([entry["title"] for entry in changed], ["Alpha"])
        self.assertEqual(len(changed[0]["lines"]), versions.MAX_DIFF_LINES)
        self.assertIs(changed[0]["truncated"], True)


if __name__ == "__main__":
    unittest.main()
