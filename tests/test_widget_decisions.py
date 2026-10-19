"""A decisions table written right after a live block is about it: each of
its forms carries `data-about`, the block's id, and an "About: TITLE" line
under its question, and the block's chrome counts and links them.

The markup is witnessed by parsing it, never by matching strings.

Run from the repo root:

    python -m unittest tests.test_widget_decisions -v
"""

from __future__ import annotations

import sys
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tests.test_decisions import LIVE_BLOCK as BLOCK, DecisionsTestCase  # noqa: E402

TABLE = """\
| # | Question | Options | Default |
| --- | --- | --- | --- |
| workers | How many workers next week? | Two / Four | Two |
| cadence | Merge daily? | Yes / No | Yes |
"""

CHECKLIST = """\
| # | Item | Default |
| --- | --- | --- |
| a | Read the chart | on |
"""


def page_text(between: str = "\n", table: str = TABLE,
              heading: str = "Decisions for the maintainer", block: str = BLOCK) -> str:
    return f"# Churn\n\n## {heading}\n\n{block}{between}{table}"


class _Parts(HTMLParser):
    """Each decision form's attributes and About lines, and each live
    block's chrome links."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms: list[dict] = []
        self.blocks: dict[str, list[dict]] = {}
        self._form: dict | None = None
        self._about: list[str] | None = None
        self._block: str | None = None
        self._chrome = 0
        self._link: dict | None = None

    def handle_starttag(self, tag, attrs):
        attrs = {key: value or "" for key, value in attrs}
        classes = attrs.get("class", "").split()
        if tag == "form" and "artifact-decision" in classes:
            self._form = {"attrs": attrs, "about": []}
            self.forms.append(self._form)
        elif tag == "p" and self._form is not None and "artifact-decision-about" in classes:
            self._about = []
        elif tag == "figure" and "artifact-live" in classes:
            self._block = attrs.get("data-widget", "")
            self.blocks[self._block] = []
        elif tag == "div" and self._block is not None:
            if self._chrome or "artifact-live-chrome" in classes:
                self._chrome += 1
        elif tag == "a" and self._chrome:
            self._link = {"attrs": attrs, "text": []}
            self.blocks[self._block].append(self._link)

    def handle_data(self, data):
        if self._about is not None:
            self._about.append(data)
        if self._link is not None:
            self._link["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "p" and self._about is not None:
            self._form["about"].append(" ".join("".join(self._about).split()))
            self._about = None
        elif tag == "form":
            self._form = None
        elif tag == "a" and self._link is not None:
            self._link["text"] = "".join(self._link["text"])
            self._link = None
        elif tag == "div" and self._chrome:
            self._chrome -= 1
        elif tag == "figure":
            self._block = None


def parts(page_html: str) -> _Parts:
    found = _Parts()
    found.feed(page_html)
    found.close()
    return found


def decision_links(found: _Parts, block: str) -> list[dict]:
    return [link for link in found.blocks[block]
            if "artifact-live-decisions" in link["attrs"].get("class", "").split()]


class AboutTests(DecisionsTestCase):
    def test_a_table_right_after_a_block_is_about_it(self):
        found = parts(self.render_markdown("churn", page_text()))
        self.assertEqual(list(found.blocks), ["merge-churn-by-worker-count"])
        self.assertEqual(len(found.forms), 2)
        for form in found.forms:
            with self.subTest(form=form["attrs"]["data-question"]):
                self.assertEqual(form["attrs"]["data-about"], "merge-churn-by-worker-count")
                self.assertEqual(form["about"], ["About: Merge churn by worker count"])
        links = decision_links(found, "merge-churn-by-worker-count")
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["text"], "2 decisions")
        self.assertEqual(links[0]["attrs"]["href"],
                         "#question=" + found.forms[0]["attrs"]["data-question"])
        self.assertEqual(found.forms[0]["attrs"]["data-question"], "decision-workers")

    def test_one_form_is_one_decision(self):
        one = TABLE.rsplit("\n", 2)[0] + "\n"
        found = parts(self.render_markdown("churn", page_text(table=one)))
        self.assertEqual(len(found.forms), 1)
        links = decision_links(found, "merge-churn-by-worker-count")
        self.assertEqual([link["text"] for link in links], ["1 decision"])

    def test_without_a_title_the_line_names_the_block_s_id(self):
        block = BLOCK.replace('title="Merge churn by worker count"', "id=churn")
        found = parts(self.render_markdown("churn", page_text(block=block)))
        self.assertEqual([form["attrs"]["data-about"] for form in found.forms], ["churn", "churn"])
        self.assertEqual([form["about"] for form in found.forms],
                         [["About: churn"], ["About: churn"]])

    def assertAboutNothing(self, text: str) -> None:
        found = parts(self.render_markdown("churn", text))
        self.assertTrue(found.forms)
        for form in found.forms:
            self.assertNotIn("data-about", form["attrs"])
            self.assertEqual(form["about"], [])
        self.assertEqual(decision_links(found, "merge-churn-by-worker-count"), [])

    def test_a_table_after_a_paragraph_or_heading_that_follows_the_block_is_not_about_it(self):
        for between in ("\nThe chart above.\n\n", "\n### Decisions for the maintainer\n\n"):
            with self.subTest(between=between):
                self.assertAboutNothing(page_text(between=between))

    def test_a_checklist_table_is_never_about_the_block(self):
        self.assertAboutNothing(page_text(table=CHECKLIST, heading="Checklist for the maintainer"))

    def test_an_inert_form_in_a_template_is_not_counted(self):
        from lotuspod import decisions, markdown, widgets
        body, _, _ = widgets.render(markdown.to_body(page_text()), "churn")
        body, _ = decisions.render_decisions(body, "churn")
        ghost = ('<template><form class="artifact-decision" data-about="merge-churn-by-worker-count"'
                 ' data-question="ghost"></form></template>')
        found = parts(widgets.link_decisions(ghost + body))
        links = decision_links(found, "merge-churn-by-worker-count")
        self.assertEqual([(link["text"], link["attrs"]["href"]) for link in links],
                         [("2 decisions", "#question=decision-workers")])
