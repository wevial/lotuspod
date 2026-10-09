"""Capture fixture: a served sample site around one command.

Renders a fixed sample site with this checkout's own CLI into a fresh
temporary directory, serves it with the site's own allow-list server on
127.0.0.1 and a free port, runs the command it was given with the site's URL
in LOTUSPOD_URL, then stops the server, removes the directory and exits with
the command's code. The site trusts the test Access key
(tests/fixtures/access/), and LOTUSPOD_TEST_ASSERTION holds an assertion it
accepts, for a browser check to send as Cf-Access-Jwt-Assertion. Answers and
comments go to a database in the same temporary directory, beside the
rendered site and never in it. It never reads or writes the operator's
artifacts/ and never binds the tailnet address.

The site's agent socket listens in the same directory, as serve's does. The
database holds two machine credentials: `hermes` (pull, claim, reply and
publish as hermes), which the comments page and the owned page name as their
owner, and `claude-3f9a2c` (pull, claim and reply as itself). The owned page,
capture-owned, is published from markdown, so the site keeps its source
beside it. So is the passages page, capture-passages, owned by hermes too,
from capture-passages.md in the directory that holds the site (the parent
of LOTUSPOD_TEST_OUT), so a check can publish it again, and so is the
decision threads page, capture-decision-threads, from
capture-decision-threads.md beside it. So is the images page, capture-images, from a source with the
fixture images (tests/fixtures/media/) beside it: its images are stored in
lotuspod-media/ beside the site, as publish stores them for serve. The
published pages above carry labels (PAGE_LABELS) for the index's Labels menu;
the rendered ones, and the versions pages below, carry none.

The site is the top of its own git repository, with a local identity and no
origin, so each render and publish commits there as on the writer host, and
each page lists its versions. The fixture's own commits are dated
SAMPLE_COMMITTED. Two pages are kept for the versions: capture-versions-once,
published once, and capture-versions-many, published VERSIONS_MANY times.
For an agent command, the command's environment names:

    LOTUSPOD_TEST_SOCKET             the agent socket
    LOTUSPOD_TEST_CREDENTIAL_HERMES  hermes's credential file
    LOTUSPOD_TEST_CREDENTIAL_OTHER   claude-3f9a2c's credential file
    LOTUSPOD_TEST_OUT                the site's output directory
    LOTUSPOD_TEST_PYTHON             the Python running the fixture

Run from the repo root:

    python -m tests.capture_site COMMAND [ARG...]

The fixture always renders this checkout: the repo's src/ directory is put at
the front of sys.path, so an ambient lotuspod install (editable or not)
can never shadow the code under capture.
"""

from __future__ import annotations

import datetime
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import types
from contextlib import redirect_stdout
from functools import partial
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from lotuspod import access, cli, db, machine, routing  # noqa: E402
from tests import access_keys  # noqa: E402


HOST = "127.0.0.1"
URL_ENV = "LOTUSPOD_URL"
ASSERTION_ENV = "LOTUSPOD_TEST_ASSERTION"
SOCKET_ENV = "LOTUSPOD_TEST_SOCKET"
HERMES_ENV = "LOTUSPOD_TEST_CREDENTIAL_HERMES"
OTHER_ENV = "LOTUSPOD_TEST_CREDENTIAL_OTHER"
OUT_ENV = "LOTUSPOD_TEST_OUT"
PYTHON_ENV = "LOTUSPOD_TEST_PYTHON"
# How long the fixture's assertion stays valid: longer than any capture run.
ASSERTION_LIFETIME = 24 * 3600
# A fixed date, so every run renders the same bytes.
SAMPLE_DATE = "2026-01-01"
# The owner the comments and owned pages name, and its credential, which
# may also pull, claim and reply as it.
OWNER = "hermes"
OWNER_OPERATIONS = ("pull", "claim", "reply", "publish")
# Another agent's credential, bound to its own handle only.
OTHER = "claude-3f9a2c"
OTHER_OPERATIONS = ("pull", "claim", "reply")


# The time publish stamps a page updated: later on SAMPLE_DATE, so a published
# page's header still names one day and the index's Updated column two times.
SAMPLE_UPDATED = f"{SAMPLE_DATE}T12:00:00+00:00"
# The time of the fixture's own commits: a rendered page, which publish never
# stamps, takes its updated time from its newest commit, still before every
# published page's.
SAMPLE_COMMITTED = f"{SAMPLE_DATE}T00:00:00+00:00"


class _SampleDay(datetime.date):
    @classmethod
    def today(cls) -> datetime.date:
        return cls.fromisoformat(SAMPLE_DATE)


class _SampleTime(datetime.datetime):
    @classmethod
    def now(cls, tz: datetime.tzinfo | None = None) -> datetime.datetime:
        return cls.fromisoformat(SAMPLE_UPDATED).astimezone(tz)


def _sample_clock() -> types.ModuleType:
    """The datetime module as cli.py reads it, with today() held at SAMPLE_DATE
    and now() at SAMPLE_UPDATED.

    `index` has no --date: it stamps the page with date.today(). `publish`
    stamps the page with datetime.now().
    """
    clock = types.ModuleType("datetime")
    clock.__dict__.update(vars(datetime))
    clock.date = _SampleDay
    clock.datetime = _SampleTime
    return clock


# Only the diagram and node cards pages have mermaid blocks: each loads Mermaid from
# jsDelivr, which a browser check answers from the copy pinned in e2e/.
ARTICLE_BODY = """\
<p>A sample article for captures: two sections.</p>
<h2>First section</h2>
<p>The outline links here.</p>
<h2>Second section</h2>
<p>Rendered with the article variant.</p>
"""

REPORT_BODY = """\
<p>A sample report for captures: the denser reading surface.</p>
<h2>Findings</h2>
<p>The outline sits in the left rail.</p>
<h2>Method</h2>
<p>Rendered with the report variant.</p>
"""

HIDDEN_BODY = "<p>A hidden page: rendered, never listed, never served.</p>\n"

DIAGRAM_BODY = """\
<p>A sample diagram, drawn by the pinned Mermaid under the page policy.</p>
<pre class="mermaid">graph LR
  A[Write] --> B[Publish] --> C[Read]</pre>
"""

# Every script here is refused by the page policy: the page shows
# "Nothing written." twice, before and after its button is pressed.
SCRIPTS_BODY = """\
<p>A sample page whose body holds scripts. None of them runs.</p>
<p id="inline-output">Nothing written.</p>
<script>document.getElementById("inline-output").textContent = "The inline script ran.";</script>
<script src="https://scripts.example.com/widget.js"></script>
<p><button type="button" onclick="document.getElementById('handler-output').textContent = 'The handler ran.'">Press me</button></p>
<p id="handler-output">Nothing written.</p>
"""

# A plan page ending in a decisions table: render makes each row a form the
# page script answers. No diagram, so the page needs no network.
DECISIONS_BODY = """\
<p>A sample plan for captures: two questions for the maintainer.</p>
<h2>Plan</h2>
<p>The responder needs a model, and the archive needs a rule.</p>
<h2>Decisions for the maintainer</h2>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th><th>Why it matters</th></tr></thead>
<tbody>
<tr><td>1</td><td>Which model replies?</td><td>Sonnet / Opus</td><td>Sonnet</td><td>Replies run on every comment.</td></tr>
<tr><td>2</td><td>Keep the archive?</td><td>Yes / No</td><td>Yes</td><td>Old pages stay linkable.</td></tr>
</tbody>
</table>
"""

# A plan page asking each question in the section it is about: two sections,
# each with its own decisions table. No diagram, so the page needs no network.
SECTION_QUESTIONS_BODY = """\
<p>A sample plan for captures: each section asks its own question.</p>
<h2>Pump</h2>
<p>The pond pump stops when the water freezes.</p>
<h3>Decisions for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th><th>Why it matters</th></tr></thead>
<tbody>
<tr><td>D1</td><td>Which pump?</td><td>Floating / Submerged</td><td>Floating</td><td>A floating pump rides the ice.</td></tr>
</tbody>
</table>
<h2>Heater</h2>
<p>A heater keeps a hole in the ice for the fish.</p>
<h3>Decisions for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th><th>Why it matters</th></tr></thead>
<tbody>
<tr><td>D2</td><td>Which heater?</td><td>Electric / Solar</td><td>Electric</td><td>The pump shares its outlet.</td></tr>
</tbody>
</table>
"""

# A plan page whose one question offers an option whose label slugifies to
# far more than the answers route takes as a choice, and a short one. No
# comment boxes and no diagram, so the page needs no network.
LONG_OPTION_BODY = """\
<p>A sample plan for captures: one option is a long sentence.</p>
<h2>Reviews</h2>
<h3>Decisions for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th></tr></thead>
<tbody>
<tr><td>D1</td><td>How do reviews weigh evidence?</td><td>Evidence levels: reproduced or traced can block; a concern is answered but never blocks, at most 3 per round, high-tier ones also go to the operator / No</td></tr>
</tbody>
</table>
"""

# A plan page whose answers end it in an "Answered" table: two sections,
# Pump asking question 1 and Heater asking questions 2 and 3, each with a
# comment box naming the page. Owned by OWNER. No diagram, so the page needs
# no network.
ANSWERED_BODY = """\
<p>A sample plan for captures: its answered decisions end the page in a table.</p>
<h2>Pump</h2>
<p>The pond pump stops when the water freezes.</p>
<h3>Decisions for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th></tr></thead>
<tbody>
<tr><td>1</td><td>Which pump?</td><td>Floating / Submerged</td><td>Floating</td></tr>
</tbody>
</table>
<h2>Heater</h2>
<p>A heater keeps a hole in the ice for the fish.</p>
<h3>Decisions for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th></tr></thead>
<tbody>
<tr><td>2</td><td>Which heater?</td><td>Electric / Solar</td><td>Electric</td></tr>
<tr><td>3</td><td>Feed the fish in winter?</td><td>Yes / No</td><td>No</td></tr>
</tbody>
</table>
"""

# A plan page whose decisions table has a Context column: the first
# question's context holds a link to the sample article and is long enough to
# wrap at 360 pixels, and the second's is empty. No comment boxes and no
# diagram, so the page needs no network.
DECISION_CONTEXT_BODY = """\
<p>A sample plan for captures: each question's context sits under it.</p>
<h2>Winter</h2>
<p>The pond freezes in January, and the pump stops with it.</p>
<h3>Decisions for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Question</th><th>Context</th><th>Options</th><th>Default</th></tr></thead>
<tbody>
<tr><td>1</td><td>Which pump?</td><td>A floating pump rides the ice, and a submerged one stays clear of it. See <a href="capture-article.html">the pump notes</a> before choosing, because the outlet only takes one of them without a new fitting.</td><td>Floating / Submerged</td><td>Floating</td></tr>
<tr><td>2</td><td>Feed the fish in winter?</td><td></td><td>Yes / No</td><td>No</td></tr>
</tbody>
</table>
"""

# A page asking a checklist: Emails holds a "Checklist for the maintainer"
# table of four items, 1 and 3 on by default, which render makes one form of
# checkboxes the page script answers. No comment boxes and no diagram, so the
# page needs no network.
CHECKLIST_BODY = """\
<p>A sample plan for captures: one list of items for the maintainer.</p>
<h2>Emails</h2>
<p>Each email goes out unless it is turned off.</p>
<h3>Checklist for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Item</th><th>Default</th></tr></thead>
<tbody>
<tr><td>1</td><td>Welcome email</td><td>on</td></tr>
<tr><td>2</td><td>Weekly digest</td><td>off</td></tr>
<tr><td>3</td><td>Renewal reminder</td><td>on</td></tr>
<tr><td>4</td><td>Survey</td><td>off</td></tr>
</tbody>
</table>
"""

# A long page whose three sections each fold under their heading: the first
# holds a word no other section does and a code block, the second asks one
# question, and each ends with a comment box. Owned by OWNER. No diagram, so
# the page needs no network.
SECTIONS_BODY = """\
<p>A sample report for captures: each section folds under its heading.</p>
<h2>Findings</h2>
<p>The pond pump seized under a crust of frazil ice in January.</p>
<pre><code>lotuspod publish report.md --owner hermes --comments
lotuspod comments pull --owner hermes</code></pre>
<h2>Decisions for the maintainer</h2>
<p>One question decides what the pond gets before the next frost.</p>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th><th>Why it matters</th></tr></thead>
<tbody>
<tr><td>1</td><td>Which heater?</td><td>Electric / Solar</td><td>Electric</td><td>The pump shares its outlet.</td></tr>
</tbody>
</table>
<h2>Next steps</h2>
<p>Fit the heater, then check the pump each morning until the thaw.</p>
"""

# A plan page with a comment box ending each of its three sections, owned by
# OWNER. No diagram, so the page needs no network.
COMMENTS_BODY = """\
<p>A sample plan for captures: every section takes comments.</p>
<h2>Findings</h2>
<p>The pond freezes in January, and the pump stops with it.</p>
<h2>Risks</h2>
<p>A frozen pump may crack before anyone notices.</p>
<h2>Next steps</h2>
<p>Fit a heater before the first frost.</p>
"""

# A plan page with a comment box ending each of its five sections, owned by
# OWNER, for the panel's list of sections. No diagram, so the page needs no
# network.
PANEL_BODY = """\
<p>A sample plan for captures: five sections, each taking comments.</p>
<h2>Findings</h2>
<p>The pond freezes in January, and the pump stops with it.</p>
<h2>Risks</h2>
<p>A frozen pump may crack before anyone notices.</p>
<h2>Heater</h2>
<p>A floating heater keeps a hole open over the outlet.</p>
<h2>Costs</h2>
<p>The heater draws less than the pump does in summer.</p>
<h2>Next steps</h2>
<p>Fit a heater before the first frost.</p>
"""

# The palette page: every element the palette colours, a section each, and a
# comment box ending each section, owned by OWNER. No diagram, so the page
# needs no network.
PALETTE_BODY = """\
<p>A sample page for captures: the palette on what a reader follows or copies.</p>
<h2>Links and code</h2>
<p>Read <a href="capture-article.html">the sample article</a>, then run <code>lotuspod publish</code> to put a page on the pond.</p>
<h2>Table</h2>
<table>
<thead><tr><th>Month</th><th>Pump hours</th><th>Water</th></tr></thead>
<tbody>
<tr><td>December</td><td>310</td><td>Cold</td></tr>
<tr><td>January</td><td>0</td><td>Frozen</td></tr>
</tbody>
</table>
<h2>Quote</h2>
<blockquote>
<p>A pond in winter keeps its fish alive under a lid of ice, so long as the pump does not crack.</p>
<cite>The pond keeper's notebook</cite>
</blockquote>
<h2>Code block</h2>
<pre><code>lotuspod publish plan.md --owner hermes
lotuspod comments pull --owner hermes</code></pre>
"""

# The tables pages, one per variant: the same tables, each in a section that
# ends in a comment box, owned by OWNER. A fourteen-column ledger about 2400
# pixels wide at its natural width, with a paragraph after it and the rest of
# the page below it to scroll through, an eight-column table with long
# cells, a two-column table whose first column is a long sentence, a
# three-column table shaped like a Finding, Status and Where table under a
# paragraph in the middle of the page, a table with long code spans and
# links, a small two-column table and a table inside a list item. No diagram,
# so the page needs no network.
TABLES_BODY = """\
<p>A sample page for captures: tables of every shape, each fitting its column or scrolling inside itself.</p>
<h2>Ledger</h2>
<table>
<thead><tr><th>Week</th><th>Pond</th><th>Water</th><th>Air</th><th>Ice</th><th>Wind</th><th>Rain</th><th>Pump</th><th>Heater</th><th>Outlet</th><th>Fish</th><th>Plants</th><th>Checked by</th><th>Keeper's note</th></tr></thead>
<tbody>
<tr><td>First of December</td><td>North by the willow</td><td>Six degrees</td><td>Two degrees at dawn</td><td>None on open water</td><td>Light from the west</td><td>A shower at noon</td><td>Running all day</td><td>Off until the frost</td><td>Clear and fast</td><td>Feeding at noon</td><td>Reeds cut back</td><td>The keeper</td><td>The leaves are out of the net</td></tr>
<tr><td>Second of January</td><td>South by the reeds</td><td>Three degrees</td><td>Minus six at dawn</td><td>Nine centimetres</td><td>Still all morning</td><td>None all week</td><td>Stopped twice</td><td>Holding a hole open</td><td>Cleared by hand</td><td>Still on the bottom</td><td>Frozen in</td><td>The neighbour's boy</td><td>The cable sheath has split on the path</td></tr>
<tr><td>Last of February</td><td>Both ponds</td><td>Five degrees</td><td>Four at midday</td><td>Only in the shade</td><td>Gusts from the north</td><td>Heavy at night</td><td>Running again</td><td>Off for the spring</td><td>Fast with the melt</td><td>Rising to feed</td><td>First shoots</td><td>The keeper</td><td>A heron came twice and went away with nothing</td></tr>
</tbody>
</table>
<p>The ledger is kept by the shed door and copied here each Sunday evening.</p>
<h2>Wide</h2>
<table>
<thead><tr><th>Pond</th><th>Pump</th><th>Heater</th><th>Outlet</th><th>Fish</th><th>Ice</th><th>Checked by</th><th>Notes</th></tr></thead>
<tbody>
<tr><td>North pond by the willow</td><td>Floating pump on a float of cork and rope</td><td>Electric heater on the north wall</td><td>Cleared by hand each morning at first light</td><td>Twelve koi and a tench</td><td>Four centimetres by the end of January</td><td>The keeper and the neighbour's boy</td><td>The pump stopped twice in the hard frost and started again at noon</td></tr>
<tr><td>South pond by the reeds</td><td>Submerged pump in the deep water under the jetty</td><td>Solar heater on a pole by the shed</td><td>Left to freeze over in the coldest week</td><td>Goldfish and a frog that sits on the lilies</td><td>Nine centimetres along the reeds on the shallow side</td><td>The keeper alone</td><td>The heater kept a hole in the ice until the panel was covered in snow</td></tr>
</tbody>
</table>
<h2>Long first cell</h2>
<table>
<thead><tr><th>Finding</th><th>Answer</th></tr></thead>
<tbody>
<tr><td>The pond pump stops whenever the water around its intake freezes, and it starts again by itself once the ice has thawed in the afternoon sun</td><td>Fit a heater beside the intake</td></tr>
<tr><td>Short one</td><td>Leave it</td></tr>
</tbody>
</table>
<h2>Findings table</h2>
<p>What the winter's inspections found, and where each finding stands:</p>
<table>
<thead><tr><th>Finding</th><th>Status</th><th>Where</th></tr></thead>
<tbody>
<tr><td>The pump seized under a crust of frazil ice in January, because the float let it sink below the surface where the ice formed first, and nobody noticed until the outlet had stopped for a whole morning and the water had gone still across the pond</td><td>Fixed by a larger float in February</td><td>North pond, under the willow by the jetty</td></tr>
<tr><td>The heater's cable runs across the path to the shed, where it is trodden on each morning by whoever clears the outlet, and its sheath has split in two places along the length that lies on the gravel</td><td>Open, waiting for a buried conduit</td><td>The path from the shed to the north pond</td></tr>
</tbody>
</table>
<h2>Code and links</h2>
<table>
<thead><tr><th>Command</th><th>Page</th></tr></thead>
<tbody>
<tr><td><code>lotuspod publish artifacts/pond-pump-winter-maintenance-report-2026.md --owner hermes --comments --variant report</code></td><td><a href="capture-article.html">https://pond.example.com/pond-pump-winter-maintenance-report-2026.html</a></td></tr>
<tr><td><code>lotuspod comments pull --owner hermes --json --socket /run/lotuspod/agent.sock</code></td><td><a href="capture-report.html">https://pond.example.com/capture-report.html</a></td></tr>
</tbody>
</table>
<h2>Small</h2>
<table>
<thead><tr><th>Month</th><th>Pump hours</th></tr></thead>
<tbody>
<tr><td>December</td><td>310</td></tr>
<tr><td>January</td><td>0</td></tr>
</tbody>
</table>
<h2>Listed</h2>
<ul>
<li>
<p>The readings taken through the winter:</p>
<table>
<thead><tr><th>Morning</th><th>Ice</th><th>Water</th><th>Outlet</th></tr></thead>
<tbody>
<tr><td>The first of January, a clear frosty morning</td><td>Two centimetres along the reeds</td><td>Four degrees under the willow</td><td>Cleared by hand before breakfast</td></tr>
</tbody>
</table>
</li>
</ul>
"""

# The owned page: published from markdown by OWNER, so its source is kept
# beside it and reaches OWNER's pull. Two sections, then one question.
OWNED_PAGE = "capture-owned"
OWNED_SOURCE = """\
# Capture owned page

A sample plan for captures, owned by hermes: two sections and one question.

## Pump

The pond pump stops when the water freezes.

## Heater

Fit a heater before the first frost.

## Decisions for the maintainer

| # | Question | Options | Default | Why it matters |
|---|---|---|---|---|
| 1 | Which heater? | Floating / Submerged | Floating | The pump shares its outlet. |
"""

# The passages page: published from markdown by OWNER, for comments on
# selected words. Findings holds "pump stops" twice and a paragraph of more
# than 500 characters; Risks is a list; the page ends with one question.
PASSAGES_PAGE = "capture-passages"
PASSAGES_SOURCE = """\
# Capture passages

A sample report for captures: select words in a section to comment on them.

## Findings

The pond pump stops when the water freezes. The heater on the north wall keeps the outlet clear, and the pump stops again only in a hard frost.

Through the winter the pond was checked each morning at first light. The ice formed first along the reeds on the shallow eastern side, where the water is barely a hand deep, and spread towards the middle over three or four nights of frost. The fish gathered in the deep water under the willow, where the bottom stays at four degrees even when the surface is frozen solid. Each morning the outlet was cleared by hand, the depth of the ice was written down, and the temperature of the water was read from the probe tied to the jetty. By February the notebook held forty mornings of readings.

## Risks

- A frozen pump may crack before anyone notices.
- A cracked pump floods the bed below it.

## Decisions for the maintainer

| # | Question | Options | Default | Why it matters |
|---|---|---|---|---|
| 1 | Which heater? | Floating / Submerged | Floating | The pump shares its outlet. |
"""

# The decision threads page: published from markdown by OWNER with comments,
# so it carries a revision, for questions asked about its decisions. Two
# sections, the second asking two questions, numbered 1 and 2.
DECISION_THREADS_PAGE = "capture-decision-threads"
DECISION_THREADS_SOURCE = """\
# Capture decision threads

A sample plan for captures: ask about a decision before answering it.

## Pond

The pond freezes in January, and the pump stops with it.

## Winter

A heater keeps a hole in the ice, and the fish wait under it.

### Decisions for the maintainer

| # | Question | Options | Default | Why it matters |
|---|---|---|---|---|
| 1 | Which heater? | Floating / Submerged | Floating | The pump shares its outlet. |
| 2 | Feed the fish in winter? | Yes / No | No | They eat little in cold water. |
"""

# The images page: published from markdown, with the fixture images copied
# beside its source as IMAGES_FILES names them. A wide chart, then photos (a
# progressive JPEG and one turned by its EXIF orientation among them), then
# three kinds of WebP and a GIF.
IMAGES_PAGE = "capture-images"
MEDIA_FIXTURES = REPO_ROOT / "tests" / "fixtures" / "media"
IMAGES_FILES = {
    "chart.png": "chart-1600x600.png",
    "photos/fish.jpg": "fish-320x240.jpg",
    "photos/pond.jpg": "pond-progressive-300x200.jpg",
    "photos/turned.jpg": "turned-orientation6-160x96.jpg",
    "lilies/lossy.webp": "lily-lossy-240x160.webp",
    "lilies/lossless.webp": "lily-lossless-200x150.webp",
    "lilies/extended.webp": "lily-extended-180x120.webp",
    "frog.gif": "frog-140x100.gif",
}
IMAGES_SOURCE = """\
# Capture images

A sample page for captures: images published from markdown, each drawn at its
own size and never wider than the column.

## Chart

The pump's hours for each month of the year, drawn wider than the column.

![Pump hours per month](./chart.png)

## Photos

A fish in the pond, then the pond at dusk.

![A fish in the pond](photos/fish.jpg)
![The pond at dusk](photos/pond.jpg)

A photo its camera turned a quarter; the browser turns it back.

![A turned photo](photos/turned.jpg)

## Lilies and a frog

![A lily, lossy](lilies/lossy.webp)
![A lily, lossless](lilies/lossless.webp)
![A lily on clear water](lilies/extended.webp)

The frog that sits on them.

![A frog](frog.gif)
"""

# Three flowcharts, each followed by a Nodes table the page script makes
# cards of. The first table names every box but E; the second repeats node
# id A, holds a subgraph, and has a row Z naming no box, so it stays shown;
# the third has an arrow both ways, an arrow its linkStyle makes opaque, a
# row too long for the window, and no thead.
NODE_CARDS_BODY = """\
<p>A sample plan for captures: click a box for its card.</p>
<pre class="mermaid">flowchart LR
  A[Write the parser] --&gt; B[Draw the cards]
  E[Pin Mermaid] --&gt; B
  B --&gt; C[Light the arrows]
  A --&gt; D[Color the boxes]</pre>
<h3>Nodes</h3>
<table>
<thead><tr><th>Node</th><th>Title</th><th>Status</th><th>PR</th></tr></thead>
<tbody>
<tr><td>A</td><td>Mark the Nodes table at render</td><td>merged</td><td><a href="https://example.com/pull/11">#11</a></td></tr>
<tr><td>B</td><td>Open a card for each box</td><td>Open</td><td><a href="https://example.com/pull/12">#12</a></td></tr>
<tr><td>C</td><td>Draw a box's arrows above the boxes</td><td>ready</td><td></td></tr>
<tr><td>D</td><td>Color each box by its status</td><td>waiting</td><td></td></tr>
</tbody>
</table>
<p>A second plan repeats a node id, and its table names a box it does not draw.</p>
<pre class="mermaid">flowchart LR
  X[Read the plan] --&gt; A[Answer the questions]
  A --&gt; Y[Ship it]
  subgraph later [Later]
    P[Tidy the docs] --&gt; Q[Tag a release]
  end</pre>
<h3>Nodes</h3>
<table>
<thead><tr><th>Node</th><th>Title</th><th>Status</th></tr></thead>
<tbody>
<tr><td>A</td><td>Answer the plan's questions</td><td>open</td></tr>
<tr><td>Y</td><td>Ship what was answered</td><td>waiting</td></tr>
<tr><td>P</td><td>Tidy the docs once it ships</td><td>ready</td></tr>
<tr><td>Z</td><td>A box the diagram does not draw</td><td>waiting</td></tr>
</tbody>
</table>
<p>A third plan: an arrow both ways, an arrow styled opaque, a long row, and a table with no
thead.</p>
<pre class="mermaid">flowchart LR
  K[Keep the copy] &lt;--&gt; R[Check the copy]
  R --&gt; S[Note it]
  S --&gt; T[Write it up]
  linkStyle 2 opacity:1</pre>
<h3>Nodes</h3>
<table>
<tr><th>Node</th><th>Title</th><th>Status</th></tr>
<tr><td>K</td><td>Keep a copy of the pond's log</td><td>merged</td></tr>
<tr><td>R</td><td>Check the copy against the log</td><td>open</td></tr>
<tr><td>S</td><td>Note what the check found</td><td>ready</td></tr>
<tr><td>T</td><td>""" + "A long write-up of the check. " * 200 + """</td><td>waiting</td></tr>
</table>
"""

# The versions pages: one published once, and one published VERSIONS_MANY
# times, each edition naming its number.
VERSIONS_ONCE_PAGE = "capture-versions-once"
VERSIONS_MANY_PAGE = "capture-versions-many"
VERSIONS_MANY = 25


# A plan page for the review sheet: four sections, three asking two
# questions each, one with a default and one without (D3, with none, before
# D4), and one a three-item checklist. Answered by
# e2e/checks/review-sheet.spec.ts alone. No diagram, so the page needs no
# network.
REVIEW_SHEET_BODY = """\
<p>A sample plan for captures: who reviews a ticket, and how.</p>
<h2>Who reviews</h2>
<p>Every ticket gets a second reader before it merges.</p>
<h3>Decisions for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th></tr></thead>
<tbody>
<tr><td>D1</td><td>Which agent reviews?</td><td>Codex / Claude Opus</td><td>Codex</td></tr>
<tr><td>D2</td><td>Which tickets get a review?</td><td>Every ticket / Major UI changes only</td><td></td></tr>
</tbody>
</table>
<h2>When a review blocks</h2>
<p>A review may hold a ticket back until its findings are answered.</p>
<h3>Decisions for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th></tr></thead>
<tbody>
<tr><td>D3</td><td>What may block a merge?</td><td>Reproduced findings / Any finding</td><td></td></tr>
<tr><td>D4</td><td>How many rounds before it goes to the operator?</td><td>2 rounds / 3 rounds</td><td>3 rounds</td></tr>
</tbody>
</table>
<h2>Prompt rules</h2>
<p>What the reviewer's prompt holds it to.</p>
<h3>Checklist for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Item</th><th>Default</th></tr></thead>
<tbody>
<tr><td>1</td><td>Cite the line a finding is about</td><td>on</td></tr>
<tr><td>2</td><td>Say how the finding was reproduced</td><td>on</td></tr>
<tr><td>3</td><td>Suggest a fix</td><td>off</td></tr>
</tbody>
</table>
<h2>Rollout</h2>
<p>Reviews start on one repository first.</p>
<h3>Decisions for the maintainer</h3>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th></tr></thead>
<tbody>
<tr><td>D5</td><td>Where do reviews start?</td><td>Holophyte only / Every repository</td><td>Holophyte only</td></tr>
<tr><td>D6</td><td>Who reads a review first?</td><td>The maintainer / The ticket's agent</td><td></td></tr>
</tbody>
</table>
"""


def versions_source(title: str, edition: int) -> str:
    return f"""\
# {title}

A sample page for captures, edition {edition}: each publish is a version.

## Pond

The pond freezes in January, and the pump stops with it.
"""


SAMPLE_PAGES = (
    ("capture-article", "Capture article", ARTICLE_BODY, ()),
    ("capture-report", "Capture report", REPORT_BODY, ("--variant", "report")),
    ("capture-hidden", "Capture hidden", HIDDEN_BODY, ("--hidden",)),
    ("capture-diagram", "Capture diagram", DIAGRAM_BODY, ()),
    ("capture-scripts", "Capture body scripts", SCRIPTS_BODY, ()),
    ("capture-decisions", "Capture decisions", DECISIONS_BODY, ()),
    ("capture-section-questions", "Capture section questions", SECTION_QUESTIONS_BODY, ()),
    ("capture-checklist", "Capture checklist", CHECKLIST_BODY, ()),
    ("capture-long-option", "Capture long option", LONG_OPTION_BODY, ()),
    ("capture-sections", "Capture sections", SECTIONS_BODY,
     ("--comments", "--owner", OWNER)),
    ("capture-answered", "Capture answered", ANSWERED_BODY,
     ("--comments", "--owner", OWNER)),
    ("capture-comments", "Capture comments", COMMENTS_BODY,
     ("--comments", "--owner", OWNER)),
    ("capture-panel", "Capture panel", PANEL_BODY,
     ("--comments", "--owner", OWNER)),
    ("capture-palette", "Capture palette", PALETTE_BODY,
     ("--comments", "--owner", OWNER)),
    ("capture-tables", "Capture tables", TABLES_BODY,
     ("--comments", "--owner", OWNER)),
    ("capture-tables-report", "Capture tables report", TABLES_BODY,
     ("--variant", "report", "--comments", "--owner", OWNER)),
    ("capture-decision-context", "Capture decision context", DECISION_CONTEXT_BODY, ()),
    ("capture-node-cards", "Capture node cards", NODE_CARDS_BODY, ()),
    ("capture-review-sheet", "Capture review sheet", REVIEW_SHEET_BODY, ()),
)


# Each published page's labels, as --label options. One page carries relos
# second, so a filter on it cannot lean on the first label alone.
PAGE_LABELS = {
    OWNED_PAGE: ("relos",),
    PASSAGES_PAGE: ("croton", "relos"),
    DECISION_THREADS_PAGE: ("holophyte",),
    IMAGES_PAGE: ("croton",),
}


def label_options(name: str) -> list[str]:
    return [arg for label in PAGE_LABELS[name] for arg in ("--label", label)]


def credential_path(db_path: Path, name: str) -> Path:
    """The file the credential name's token is kept in, beside the database."""
    return db_path.with_name(f"{name}.token")


def render(out_dir: Path, db_path: Path) -> None:
    """Render the sample pages, publish the owned page and build the index
    into out_dir.

    Makes OWNER's and OTHER's credentials in the database at db_path first,
    their tokens beside the database. Calls the CLI in process, the same code
    the installed `lotuspod` command runs. Raises RuntimeError naming the
    step that failed.
    """
    database = db.Database(db_path)
    repository(out_dir)
    token = credential_path(db_path, OWNER)
    machine.create_credential(database, OWNER, [OWNER], list(OWNER_OPERATIONS), token)
    machine.create_credential(database, OTHER, [OTHER], list(OTHER_OPERATIONS),
                              credential_path(db_path, OTHER))
    source = db_path.with_name(f"{OWNED_PAGE}.md")
    source.write_text(OWNED_SOURCE, encoding="utf-8")
    passages_source = db_path.with_name(f"{PASSAGES_PAGE}.md")
    passages_source.write_text(PASSAGES_SOURCE, encoding="utf-8")
    decision_threads_source = db_path.with_name(f"{DECISION_THREADS_PAGE}.md")
    decision_threads_source.write_text(DECISION_THREADS_SOURCE, encoding="utf-8")
    images_source = db_path.with_name("images") / f"{IMAGES_PAGE}.md"
    for relative, fixture in IMAGES_FILES.items():
        (images_source.parent / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(MEDIA_FIXTURES / fixture, images_source.parent / relative)
    images_source.write_text(IMAGES_SOURCE, encoding="utf-8")
    steps = [
        (
            f"render {name}",
            [
                "render", "--name", name, "--title", title, "--body", body,
                "--date", SAMPLE_DATE, "--out-dir", str(out_dir),
                "--credential", str(token), "--db", str(db_path), *extra,
            ],
        )
        for name, title, body, extra in SAMPLE_PAGES
    ]
    steps.append((
        f"publish {OWNED_PAGE}",
        [
            "publish", str(source), "--local", "--date", SAMPLE_DATE,
            *label_options(OWNED_PAGE),
            "--out-dir", str(out_dir), "--owner", OWNER,
            "--credential", str(token), "--db", str(db_path),
        ],
    ))
    steps.append((
        f"publish {PASSAGES_PAGE}",
        [
            "publish", str(passages_source), "--local", "--date", SAMPLE_DATE,
            *label_options(PASSAGES_PAGE),
            "--out-dir", str(out_dir), "--owner", OWNER,
            "--credential", str(token), "--db", str(db_path),
        ],
    ))
    steps.append((
        f"publish {DECISION_THREADS_PAGE}",
        [
            "publish", str(decision_threads_source), "--local", "--date", SAMPLE_DATE,
            *label_options(DECISION_THREADS_PAGE),
            "--out-dir", str(out_dir), "--comments", "--owner", OWNER,
            "--credential", str(token), "--db", str(db_path),
        ],
    ))
    steps.append((
        f"publish {IMAGES_PAGE}",
        [
            "publish", str(images_source), "--local", "--date", SAMPLE_DATE,
            *label_options(IMAGES_PAGE),
            "--out-dir", str(out_dir), "--variant", "article", "--no-comments",
        ],
    ))
    versions_dir = db_path.with_name("versions")
    versions_dir.mkdir(exist_ok=True)
    for name, title, editions in ((VERSIONS_ONCE_PAGE, "Capture versions once", 1),
                                  (VERSIONS_MANY_PAGE, "Capture versions many", VERSIONS_MANY)):
        for edition in range(1, editions + 1):
            versions_file = versions_dir / f"{name}.md"
            steps.append((
                f"publish {name} edition {edition}",
                [
                    "publish", str(versions_file), "--local", "--date", SAMPLE_DATE,
                    "--out-dir", str(out_dir),
                ],
                partial(versions_file.write_text, versions_source(title, edition),
                        encoding="utf-8"),
                # A minute apart, so each version shows its own time.
                f"{SAMPLE_DATE}T00:{edition:02d}:00+00:00",
            ))
    steps.append(("index", ["index", "--out-dir", str(out_dir)]))
    for step, argv, *more in steps:
        prepare, moment = more or (None, SAMPLE_COMMITTED)
        if prepare is not None:
            prepare()
        committed = {"GIT_AUTHOR_DATE": moment, "GIT_COMMITTER_DATE": moment}
        # The CLI reports on stdout; keep that stream for COMMAND alone.
        with redirect_stdout(sys.stderr), mock.patch.object(cli, "_dt", _sample_clock()), \
                mock.patch.dict(os.environ, committed):
            try:
                rc = cli.main(argv)
            except SystemExit as exc:
                rc = exc.code if isinstance(exc.code, int) else 1
        if rc != 0:
            raise RuntimeError(f"{step} failed with exit code {rc}")


def repository(out_dir: Path) -> None:
    """Make out_dir the top of its own git repository, with a local identity
    and no origin. Raises RuntimeError when git fails."""
    for argv in (["init", "-q", "-b", "main"], ["config", "user.name", "Capture fixture"],
                 ["config", "user.email", "capture@example.com"],
                 ["config", "commit.gpgsign", "false"]):
        done = subprocess.run(["git", "-C", str(out_dir), *argv], capture_output=True,
                              text=True, check=False)
        if done.returncode != 0:
            raise RuntimeError(f"git {argv[0]} failed: {done.stderr.strip()}")


# The browser checks read the packaged stylesheet from here, as the bytes a
# restored theme serves. The theme keeps it as per-feature sources, so the
# fixture writes the joined stylesheet here while COMMAND runs and removes it
# after; it is gitignored and never packaged.
PACKAGED_CSS = REPO_ROOT / "src" / "lotuspod" / "_theme" / "lotuspod.css"


def write_packaged_css() -> bool:
    """Write the joined stylesheet to PACKAGED_CSS unless it is there already
    (a run beside this one wrote it). True when this call wrote it."""
    joined = cli.theme_file_bytes("lotuspod.css")
    if PACKAGED_CSS.is_file() and PACKAGED_CSS.read_bytes() == joined:
        return False
    cli.write_atomic(PACKAGED_CSS, joined)
    return True


def main(argv: list[str] | None = None) -> int:
    command = list(sys.argv[1:] if argv is None else argv)
    if not command:
        print("usage: python -m tests.capture_site COMMAND [ARG...]", file=sys.stderr)
        return 2

    directory = Path(tempfile.mkdtemp(prefix="lotuspod-capture-"))
    site = directory / "site"
    db_path = directory / db.DEFAULT_NAME
    socket_path = directory / machine.SOCKET_NAME
    server = None
    thread = None
    wrote_css = False
    sockets = None
    socket_thread = None
    try:
        try:
            site.mkdir()
            render(site, db_path)
        except Exception as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        verifier = access.Verifier(access.parse_config(access_keys.config_section()))
        server = cli._make_server(site, HOST, 0, verifier=verifier, db_path=db_path)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        # The agent socket as serve runs it: the same database and pages.
        sockets = machine.SocketServer(
            socket_path, db.Database(db_path), pages=partial(cli.api_page, site),
            describe=partial(cli.agent_page, site), window=routing.DEFAULT_WINDOW,
            claim_sec=routing.DEFAULT_CLAIM,
        )
        socket_thread = threading.Thread(target=sockets.serve_forever, daemon=True)
        socket_thread.start()
        env = dict(os.environ)
        env[URL_ENV] = f"http://{HOST}:{port}"
        env[ASSERTION_ENV] = access_keys.assertion(lifetime=ASSERTION_LIFETIME)
        env[SOCKET_ENV] = str(socket_path)
        env[HERMES_ENV] = str(credential_path(db_path, OWNER))
        env[OTHER_ENV] = str(credential_path(db_path, OTHER))
        env[OUT_ENV] = str(site)
        env[PYTHON_ENV] = sys.executable
        wrote_css = write_packaged_css()
        try:
            return subprocess.run(command, cwd=str(REPO_ROOT), env=env, check=False).returncode
        except OSError as exc:
            print(f"error: cannot run {command[0]}: {exc}", file=sys.stderr)
            return 1
    finally:
        if wrote_css:
            PACKAGED_CSS.unlink(missing_ok=True)
        if sockets is not None:
            if socket_thread is not None:
                sockets.shutdown()
            sockets.server_close()
        if server is not None:
            if thread is not None:
                server.shutdown()
            server.server_close()
        shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
