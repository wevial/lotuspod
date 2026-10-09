# Changelog

All notable changes to Lotuspod are recorded here, newest first, in the
Keep a Changelog style. Each version's section, headed
`## X.Y.Z - YYYY-MM-DD`, becomes the notes of its GitHub release.

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
