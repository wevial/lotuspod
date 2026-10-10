# Changelog

All notable changes to Lotuspod are recorded here, newest first, in the
Keep a Changelog style. Each version's section, headed
`## X.Y.Z - YYYY-MM-DD`, becomes the notes of its GitHub release.

## 0.4.0 - 2026-10-09

- The index opens pods in tabs, with dots for a new version or a new reply,
  and a pod loaded on its own opens in the index as a tab. Cmd/Ctrl+K finds a
  pod by title, label or summary, recent first, from the live index.
- The index marks pages republished since the reader last opened them, with
  an Updated filter. A Recent activity view, kept in the address as
  `#activity`, groups the last seven days by page, and each row links to its
  version, thread or decision. `/api/activity` serves the same feed.
- A page lists its earlier versions, opens each read-only, and picks one from
  a ▾ menu in its header. It says what changed since the reader last looked,
  with a changed-sections box and a source diff.
- `lotuspod archive` archives a page: off the index's default list and
  Recent activity, still readable, with a banner, and closed to new comments
  and answers. Owners get an Archive button.
- A reader can comment on the whole page from a chip under its title.
- Replies in a reader's own threads are marked unread on the page and the
  index. A resolved thread opens from its dashed line, which marks its
  replies seen.
- An agent's reply or follow-up can attach images with `--image PATH`, and
  `respond` waits for `serve`'s socket before its first pass.
- Pages with decisions get a review sheet: the open-question count, Next
  open, and one Respond panel. An agent can record an answer given
  elsewhere, an owner can dismiss a decision that no longer matters, and a
  reader's note on a saved answer opens a thread on its decision.
- A flowchart's Nodes table is a card for each box, with arrows that light up
  and status colors; boxes with their own Mermaid style keep it. An Expand
  button opens a diagram full-window to pan and zoom, with node cards, status
  colors and touch pinch. A flowchart can opt into Mermaid's ELK layout so
  subgraph lanes draw as tidy boxes.
- Ticket keys and PR numbers on a page become cards, from a refs file given
  at publish.
- Bare http(s) URLs in comments and markdown pages become links, and only
  off-site links open in a new tab. Lookalike schemes such as `httpſ://` are
  never linked.
- Smaller fixes: a pod tab rings whole, title and ✕ together, and only after
  keyboard focus; a diagram box's multi-line label keeps its spaces in its card
  title; the review bar's Next open fits at 280 px wide; and a page
  republished without comments counts no unread replies.

## 0.3.0 - 2026-10-08

- Pages carry labels from `lotuspod publish`, shown as tags on the page and
  on the index, and the index filters by label.
- Every page shows when it was created and last updated, and the index lists
  both, newest update first.
- A "Checklist for the maintainer" table becomes one card of checkboxes
  preset to their defaults, with one Save. It is stored, versioned and pulled
  like a decision, folds to what changed, and takes one row in the Answered
  table.
- A decisions table's Context column shows as unlabelled text under its
  question, and agents get it in their pull.
- The Answered table folds under its own "Answered (N)" heading and stays
  folded per page.
- Comments render a safe markdown subset, and an image dropped on a composer
  is attached.
- The comment composer is one box: thumbnails above the text, an X on each,
  and a + inside to add one.
- A decision option with a long label can be saved: its value is bounded to
  what the answers route accepts.
- The README names every command, installs from PyPI, and says why Lotuspod.

## 0.2.0 - 2026-10-07

- Readers can ask about a decision from its card: an Ask button posts a
  question thread anchored to that decision, and a chip under the card opens
  it. Agents pulling the thread see the decision's question, options and
  current answer.
- Every page with decisions ends in an Answered table, built from the saved
  answers, newest first, with a change button on each row. It keeps decisions
  the page no longer asks.
- The demo answers decision questions in the browser, and its pages sit at
  the theme's usual distance below the demo banner.

## 0.1.1 - 2026-10-07

- The PyPI page now shows the README's images and links: the release points
  each of them at GitHub, at the release's tag.

## 0.1.0 - 2026-10-07

The first public release.

- `lotuspod publish` turns a markdown or HTML page into a themed page, its
  sections foldable, and rebuilds the site's index and manifest.
- Readers comment on a section or a highlighted passage, in threads that can
  be replied to and resolved, and answer a page's decision forms.
- Agents, each with a scoped credential, pull what is meant for them, reply
  in the thread and revise the page; a default responder answers the rest.
- `lotuspod serve` serves the site, its comments and its answers from one
  SQLite database, trusting readers only through Cloudflare Access.
- A static demo of the README and docs pages runs in the visitor's browser,
  with a scripted agent replying.
