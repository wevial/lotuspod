# Lotuspod

Lotuspod publishes pages for a small, signed-in circle of readers, and lets
those readers answer on them. A page is written in markdown or HTML and
published in one command, drawn in one shared lotus theme. Readers comment on
a section or on a passage they highlight, and answer the decision tables a
plan page asks the maintainer. Agents (a Claude Code or Codex session, or
the default responder) pull the comments and answers meant for them, reply in
the thread, and revise the page when asked.

The site runs on one writer host, behind Cloudflare Access, and is reached
through a Cloudflare Tunnel or over a tailnet.

## Layout

```
lotuspod/
├── src/lotuspod/          # package + minimal CLI (`lotuspod render|publish|manifest|index|serve|answers|backup|restore`)
│   ├── _templates/artifact.html   # artifact template ({{placeholder}} substitution)
│   ├── _templates/index.html      # index-page template
│   └── _theme/            # tokens.json (colors, fonts, radii) + lotuspod.css
├── artifacts/             # rendered output (gitignored)
└── lotuspod-media/        # markdown pages' images, beside artifacts/ (gitignored)
```

Beside these, `docs/` holds the reference pages listed below, `deploy/` the
tunnel config and the systemd units, `tests/` the unit tests and `e2e/` the
Playwright captures and browser checks.

## Quick start

Install the package, write a markdown page, publish it and serve it:

```sh
pip install -e .
printf '# Opening the Pond\n\n## The pond\n\nHello from the pond.\n' > pond.md
lotuspod publish pond.md --local --summary "Why we started Lotuspod."
lotuspod serve --host 127.0.0.1
```

`--local` publishes on this machine, even when the config names a
`[publish] host` to send pages to. `publish` writes `artifacts/pond.html`,
keeps the source beside it as `artifacts/pond.md`, and rebuilds
`artifacts/index.html`. `serve` prints the address it listens on; open
`http://127.0.0.1:8000/` for the index. Without `--host`, serve listens on
this machine's tailnet address only.

Comments and answers need the reader's routes, which sit behind Cloudflare
Access: until the config has an `[access]` section they answer 503, and the
page itself is served as usual.

## Where to read next

- [Publishing pages](docs/publishing.md): for people publishing pages.
  Markdown and HTML pages, images, the manifest and the index, decision
  tables, the template and the theme, and what a page may run.
- [Reading and answering pages](docs/comments.md): for readers and the people
  answering them. Answers and comments, the comments panel, the popover and
  bottom sheet, and comments on passages.
- [Agents](docs/agents.md): for agents and their operators. Agent
  credentials, the pull loop and the default responder.
- [Operating the site](docs/operating.md): for the operator of the site.
  Serve, Cloudflare Access, publishing through the tunnel, deploying from
  `main`, and backups.
- [Development](docs/development.md): for people changing Lotuspod. The
  tests and the captures.
