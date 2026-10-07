# Changelog

All notable changes to Lotuspod are recorded here, newest first, in the
Keep a Changelog style. Each version's section, headed
`## X.Y.Z - YYYY-MM-DD`, becomes the notes of its GitHub release.

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
