# Lotuspod

Lotuspod publishes pages for a small, signed-in circle of readers, and lets
those readers answer on them. A page is written in markdown or HTML and
published in one command, drawn in one shared lotus theme. Readers comment on
a section or on a passage they highlight, and answer the decision tables a
plan page asks the maintainer. They tick a checklist as one form, ask about a
decision in a thread from its card's Ask, and see every answer in the
Answered table that ends the page. A comment can carry images. Agents (a
Claude Code or Codex session, or the default responder) pull the comments and
answers meant for them, reply in the thread, and revise the page when asked.

Try the demo: [https://lotuspod.kovial.co/](https://lotuspod.kovial.co/) (your comments stay in your browser; replies are scripted)

The site runs on one writer host, behind Cloudflare Access, and is reached
through a Cloudflare Tunnel or over a tailnet.

Lotuspod is a personal project, and issues are off.

## Why Lotuspod

- **Yours.** Pages, comments, answers and every published version live in
  your own artifacts directory (committed on each publish when it is a git
  repository) and SQLite database, which you can back up, diff and move. No
  hosted service holds them.
- **Any agent.** Comments route to an owner handle. A Claude Code or Codex
  session, another agent or a script claims a thread and replies through
  `lotuspod comments` or the local socket API; the default responder is one
  of them.
- **Structured answers.** Decision tables, checklists and their context
  columns come back as data. Agents read them with `lotuspod answers` and in
  their pull, not as free text in a thread.
- **Self-hosted and open source.** It runs on your own writer host behind
  your own access control, under the [MIT license](LICENSE).
- **Built for a factory.** It is the review surface
  [Holophyte](https://github.com/wevial/holophyte) publishes its reports and
  plans to.

## See it

A reader comments on a section of a plan page, the thread waits for the
page's agent, `hermes`, and its reply appears; then the reader answers the
page's decisions and comments on a passage:

![A reader comments on the Rollout section of a sample plan page; the comments panel shows the thread checking for a reply from hermes, then hermes writing, then hermes's reply; the reader then answers both decisions and comments on a highlighted passage](docs/images/loop.gif)

![The comments panel open beside a sample plan page at 1280 pixels wide: the reader's comment on the Rollout section and the agent hermes's reply below it](docs/images/thread.png)

![The decisions table of a sample plan page with both questions answered and saved, one with a note, each naming the reader who answered](docs/images/decisions.png)

![A passage of a sample plan page highlighted with its number 1, and its thread open in the comments panel waiting for a reply from hermes](docs/images/passage.png)

The pictures come from a sample page served on loopback by the test fixture;
[Development](docs/development.md#captures) makes them again.

## Layout

```
lotuspod/
├── src/lotuspod/          # package + CLI (`lotuspod render|publish|manifest|index|serve|credential|answers|audit|comments|inbox|respond|backup|restore|archive|unarchive`)
│   ├── cli/               # the entry point: the root parser and each slice's commands
│   ├── core/              # what every part shares (imports nothing else in Lotuspod)
│   │   ├── templates/artifact.html  # artifact template ({{placeholder}} substitution)
│   │   ├── theme/         # tokens.json (colors, fonts, radii), base.css, favicon.svg, theme-switch.css
│   │   └── ts/            # the scripts every page script shares: shared.js, link-tab.js; theme-head.js
│   ├── store/db.py        # serve's database
│   ├── features/          # the feature slices: Python at a slice's root, ts/, theme/, templates/; the served lotuspod.css is core/theme/ and the slices' theme/ joined in order
│   │   ├── publish/       # render, the manifest and publish (`render`, `manifest`, `publish`); markdown, images and sections
│   │   ├── blocks/        # body blocks: reference cards, node tables, calltrees, diagrams, tables, the image viewer
│   │   ├── widgets/       # live blocks and the browser libraries they load
│   │   ├── history/       # page versions and the archive (`archive`, `unarchive`)
│   │   ├── index/         # the site's listing (`index`); templates/index.html, the index-page template
│   │   ├── comments/      # comment boxes, the comments panel's islands, the review sheet, attachments, narrow windows, the panel's resize
│   │   ├── decisions/     # a page's decision tables, answered on the page (`answers`)
│   │   ├── live/          # serve's change stream and the page's live scripts: revision checks, the swap, the index's refresh
│   │   ├── serve/         # `serve`: its allow-list and handler, the /api routes and the Cloudflare Access check
│   │   ├── backup/        # `backup` and `restore`
│   │   └── agents/        # machine credentials, the agents' pull, the default responder, routing (`credential`, `audit`, `comments`, `inbox`, `respond`)
├── artifacts/             # rendered output (gitignored)
└── lotuspod-media/        # markdown pages' images and the images readers attach to comments, beside artifacts/ (gitignored)
```

Beside these, `docs/` holds the reference pages listed below, `deploy/` the
tunnel config and the systemd units, `tests/` the unit tests and `e2e/` the
Playwright captures and browser checks.

## Quick start

Install the package from PyPI, write a markdown page, publish it and serve it:

```sh
pip install lotuspod   # or, in a checkout of this repository: pip install -e .
printf '# Opening the Pond\n\n## The pond\n\nHello from the pond.\n' > pond.md
lotuspod publish pond.md --local --summary "Why we started Lotuspod."
lotuspod serve
```

`--local` publishes on this machine, even when the config names a
`[publish] host` to send pages to. `publish` writes `artifacts/pond.html`,
keeps the source beside it as `artifacts/pond.md`, and rebuilds
`artifacts/index.html`. `serve` prints the address it listens on; open
`http://127.0.0.1:8000/` for the index. Serve listens on `127.0.0.1`, this
machine only, unless `--host` names another address, such as
`--host "$(tailscale ip -4)"` to serve on a tailnet.

Comments and answers need the reader's routes, which sit behind Cloudflare
Access: until the config has an `[access]` section they answer 503, and the
page itself is served as usual.

## Interactive pages

A live block is a small HTML page of its own inside a page: a chart, a
slider, a mock-up, with its scripts running. Write it as a fenced block whose
first line is three backticks and `html live`, with a `title=`; here are its
three lines, without the backticks that open and close it. It is safe to put
on a page because it runs in a sandboxed frame: it cannot fetch or load
anything from elsewhere, read the page around it, or see the reader's session
or comments. It can still move its own frame to another address, carrying
what the reader typed into it, so it is for showing things, not for asking
for secrets.

```text
html live title="A counter"
<button id="count" type="button">Pressed 0 times</button>
<script>let n = 0; const button = document.getElementById('count'); button.addEventListener('click', () => { button.textContent = `Pressed ${++n} times`; });</script>
```

[Interactive pages](docs/publishing.md#interactive-pages) has the options,
the pinned chart libraries, whole HTML pages with `publish --live`, and the
limits; [the worked example](docs/examples/interactive.md) is a pod with a
live d3 chart, notes and a decision.

## Where to read next

- [Publishing pages](docs/publishing.md): for people publishing pages.
  Markdown and HTML pages, images, the manifest and the index, decision
  tables and checklists, interactive pages, the template and the theme, and
  what a page may run.
- [An interactive pod](docs/examples/interactive.md): a worked example. A
  live d3 chart with its data inline, the notes around it and a decision.
- [Reading and answering pages](docs/comments.md): for readers and the people
  answering them. Answers and comments, the comments panel, the popover and
  bottom sheet, and comments on passages.
- [Agents](docs/agents.md): for agents and their operators. Agent
  credentials, the pull loop and the default responder.
- [Operating the site](docs/operating.md): for the operator of the site.
  Serve, Cloudflare Access, publishing through the tunnel, deploying from
  `main`, and backups.
- [Development](docs/development.md): for people changing Lotuspod. The
  tests, the leak guard, the captures, the demo and releasing.
- [Architecture](docs/architecture.md): for reviewers and new contributors.
  One diagram of how the parts fit together.

## How it was built

Lotuspod is built by [Holophyte](https://github.com/wevial/holophyte), an
agent factory. Each change starts as a ticket with acceptance criteria and
verify commands. An agent implements it in an isolated worktree, the verify
commands run, and a different agent reviews it. A pull request then runs the
required `unit` check and merges. The
[merged pull requests](https://github.com/wevial/lotuspod/pulls?q=is%3Apr+is%3Amerged)
are the record.

## Security

Report a vulnerability privately ([SECURITY.md](SECURITY.md)). `src/lotuspod/features/serve/access.py` checks Cloudflare
Access's RS256 assertions with the standard library: the package has no runtime dependencies, the check only
verifies (never signs or makes keys), and RS256 is one modular exponentiation plus a comparison of the whole
re-encoded PKCS#1 v1.5 block, leaving no parser to trick. It refuses any `alg` but RS256, a key id not in
the team's key set, keys under 2048 bits, and a wrong issuer, audience, time or email; it never reads the
plain email header. Pinned by `tests.features.serve.test_access.VerifierTests.test_header_must_name_rs256_and_a_listed_key`,
`tests.features.serve.test_access.VerifierTests.test_signature_block_is_compared_whole`,
`tests.features.serve.test_access.VerifierTests.test_keys_under_2048_bits_are_not_listed`,
`tests.features.serve.test_access.VerifierTests.test_malformed_tokens_are_invalid` and
`tests.features.serve.test_access.WhoamiTests.test_email_header_naming_someone_else_is_not_read`.
