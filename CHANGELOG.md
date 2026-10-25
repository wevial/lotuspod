# Changelog

All notable changes to Lotuspod are recorded here, newest first, in the
Keep a Changelog style. Each version's section, headed
`## X.Y.Z - YYYY-MM-DD`, becomes the notes of its GitHub release.

## 0.7.0 - 2026-10-25

- Every page now takes its look from the current release when it is read.
  `lotuspod serve` builds each page's shell (theme, scripts, layout) from
  the page's kept content at request time, with an `ETag` and 304 replies,
  so a template or theme change reaches every page without republishing.
  `NAME.html` stays on disk as the published snapshot and is left
  unchanged. Old versions opened with `?version=` render in today's shell
  from that version's own content, still marked as old versions.
- After upgrading, run `lotuspod pages migrate` once. It keeps the body of
  each page published before kept sources existed, and keeps only those a
  render gives back with the same text and anchors. `lotuspod pages diff`
  lists every page today's render draws differently from its published
  file, and what changed. It writes nothing.
- One theme choice for the whole site. Picking Night, Dawn or Auto on any
  page applies it to the index and to every open page at once.
- A page's open questions get a Decisions tab in the comments panel,
  including the phone's bottom sheet. The title bar's count opens it, and
  every unsaved question counts as "to answer". Saved answers fold into an
  Answered list, a decision card collapses to one line from its title, and
  a new question has its own field in the panel. The old Respond panel is
  gone.
- A reader's reply that mentions no one goes to the agent that last
  answered its thread, while that agent is listening.
- Comment composers turn a typed `:shortcode:` into its emoji and suggest
  emoji after `:` and two letters.
- A live block's thread is named "On TITLE" in popovers and the phone's
  bottom sheet. On a page with unwrapped sections, a block's comments go
  to its heading's section. A block opened alone runs inside a frame, so
  it cannot move its tab to another site.
- The code is split into one package per feature, with an import-graph
  test, public edges between slices and a file-size ratchet. A new
  feature is new files.
- Faster checks: the unit suite runs in two parallel shards, the e2e
  shards run in the Playwright image, and duplicate browser checks are
  folded into their neighbours or moved to Python tests.

## 0.6.0 - 2026-10-22

- Authors can add interactive charts, sliders and walkthroughs with an
  `html live` fence or an HTML live template. Each block runs in a
  sandboxed, isolated frame with the page's theme available as CSS
  variables; it can't reach external resources, the reader's session or the
  page's own content, and only resize, ready, error and Escape messages
  cross back into the page.
- Each live block gets chrome: a title, a loading/Live status badge with an
  error count, Expand to fill the window, Pause to stop its scripts, and
  Open alone. These work without page scripts and hold their place on
  narrow screens.
- A block can pin reproducible chart libraries — `mermaid`, `d3`, `plot` or
  `chartjs` — with `html live plot chartjs` or `data-libs`, loaded from an
  exact, integrity-checked URL alongside its own hashed scripts.
- An unchanged block keeps running, with its state, through a page swap,
  and Pause/Resume, Expand and sizing keep working across one. An earlier
  page version shows the widgets it had at the time, even after they've
  changed or been removed.
- `lotuspod publish --live` puts a whole interactive HTML mock-up in a pod,
  with optional `--notes` markdown and comments alongside it. The README
  and `docs/publishing.md` gain an "Interactive pages" section, and the
  demo runs a live example.
- A reader can start a comment thread from a live block's own Comment
  button; the thread is anchored to the block, follows it if it moves to
  another section, and moves to the changed list if the block is removed.
  A widget can say where the reader is with `lotuspod.state()`, and a
  comment started from the block keeps that label. A decisions table
  placed right after a block is tied to it in the form, the block's
  chrome and the review sheet.
- A comment form opened on a block survives a republish that changes or
  removes the block, and an unsent comment — including one begun from a
  block — survives a reload of the page in the same tab.
- A reader can switch a pod between Night and a new light Dawn theme with a
  Night / Dawn / Auto switch on the title bar. Auto follows the system and
  is the default. Live blocks, Mermaid diagrams and the review sheet follow
  the switch too.
- The comments panel finishes its move to Preact islands — drafts,
  placement, chips and the thread store all now live there, and
  `comments.js` is deleted — with no change for readers.
- The `e2e` check runs as four parallel shards with one retry on a flaky
  failure, skips entirely on a docs-only pull request, and records a
  timeline on failure to help diagnose rare flakes. Each spec also drops
  its route handlers after the check ends, so an in-flight poll can't fail
  it.

## 0.5.0 - 2026-10-16

- An open page updates in place when a new revision is published, where it
  used to show a "newer version" banner or reload. Only the changed header,
  outline, intro, sections and references are swapped, and the reader keeps
  their scroll, folds and focus. A status line says how many sections
  changed, and each changed section is tinted for a moment.
- The swap works on commented pages, keeping threads, chips, the panel and
  unsent text, and finds passage highlights again in the new text. Decision
  forms are wired and answered as on a reload, with unsaved answers held
  back, and the review sheet's count, marks and Respond panel follow the
  questions the page now asks. Swapped tables get their Expand buttons,
  references their cards, and Mermaid diagrams are drawn again. A section
  the reader is writing in, or whose diagram is open full-window, waits
  until they are done.
- `lotuspod serve` pushes changes over an Access-verified `/api/events`
  stream. Open pages and the index run their checks at once on each tick, so
  a reply or a republish shows within a second or two; the 60-second check
  stays as the fallback.
- The index refreshes its listing and Recent activity in place after a
  publish, keeping search, filters, view and open tabs.
- Open pod tabs can be dragged into a new order, or moved with
  Alt+Shift+arrows, and the order is kept in the address. A link to another
  pod clicked inside a framed pod, including one copied from the index's
  address bar, opens that pod as a tab.
- A `calltree` fence draws as a call tree, with a summary, a legend and
  file:line chips that link to GitHub when the fence names a repo and a sha.
  Its rows fold, saying what is hidden, and Fold all / Open all fold the
  whole tree.
- A comment that mentions no handle goes to the default responder, on an
  owner's pages too. When it asks the owner to do something, the responder answers
  what it can and queues the rest in the owner's durable inbox, saying so in
  its reply.
- The comments panel can start a whole-page comment, a form opened in it
  closes with Cancel or Escape, and Cmd/Ctrl+Enter sends.
- A comment the responder was answering when it was stopped, as on a
  deploy, is released and answered after the restart instead of failed.
- Theme scripts are built from TypeScript with Bun, with a CI check that the
  committed JS is fresh, and the pod finder is the first one converted.
  Pages carry a Preact islands entry: the review sheet, and the comments
  panel's shell, groups and entries, are now drawn by islands, with no change
  a reader sees.
- A wide diagram's Expand button stays in view as it scrolls sideways, and a
  box's "Waits for" and "Unblocks" lists name boxes by their labels.
- Pages stop shifting down on load: the owner's Archive button sits in the
  top bar, and the whole-page comment box is served under the title.
- Serve reads its page list once per request, so `/api/seen`,
  `/api/activity`, agent pulls and the owner's inbox stay fast on big sites.
- Smaller fixes: Recent activity keeps its week count steady when it
  refreshes; `comments pull`, `comments show` and `answers` print no terminal
  control characters from reader text; a page takes its name from its
  address, not from a `data-page` in its body, and an old version's banner
  sits on the page's real main; a thread on a one-section page's box shows in
  the whole-page box once the page has sections; and a reference card's
  "waiting" chip text meets WCAG AA contrast.

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
