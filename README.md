# Lotuspod

Podcast artifact scaffold with a shared lotus theme. Render episode artifacts
(standalone HTML pages) from a single template, styled by one theme.

## Layout

```
lotuspod/
├── src/lotuspod/          # package + minimal CLI (`lotuspod render|publish|manifest|index|serve|answers|backup|restore`)
│   ├── _templates/artifact.html   # artifact template ({{placeholder}} substitution)
│   ├── _templates/index.html      # index-page template
│   └── _theme/            # tokens.json (colors, fonts, radii) + lotuspod.css
└── artifacts/             # rendered output (gitignored)
```

## Usage

```sh
pip install -e .
lotuspod render \
  --name ep-001 \
  --title "Opening the Pond" \
  --episode 1 \
  --summary "Why we started Lotuspod." \
  --body "<p>Hello from the pond.</p>"
```

This writes `artifacts/ep-001.html` (and copies `lotuspod.css` beside it), using
today's date unless `--date` is given. Open the file in a browser to view it.

The `lotuspod` command is the installed console script. From a bare checkout —
no install — the same CLI runs as a module: `PYTHONPATH=src python3 -m lotuspod
render ...`.

Pass `--hidden` to mark an artifact not visible: it carries a
`lotuspod:visible: false` flag and is excluded from `manifest.json` and
`index.html`. Re-render without `--hidden` to publish it.

When the body has two or more `<h2>` sections, render gives each one a slug id
taken from its heading text (`<h2>Deep Dive</h2>` -> `id="deep-dive"`, repeats deduped
as `deep-dive-2`), so section links stay the same every time a page is
re-rendered. A heading that already carries an `id` keeps it.

Those sections also become the page's own outline: one
`<nav class="artifact-outline">` list of section links, placed above the body
in the markup. The theme gives it two roles from that single list — on a wide
page it sits in the empty gutter beside the reading column as a sticky rail
(the prose keeps its measure; a full-width table stops at the rail rather than
running under it), and on a narrow one it is a disclosure card above the
prose. The markup ships collapsed, so a phone gets the article first and the
outline on request; the wide rail is held open by the stylesheet, since the
gutter it sits in costs the prose nothing. No script and no second copy of the
links: the layout is a container query away.

Pass `--no-outline` to skip the ids and the outline list entirely.

A body may carry diagrams as Mermaid source in a `<pre class="mermaid">` block:

```html
<pre class="mermaid">
flowchart LR
  a --> b
</pre>
```

When the body holds such a block, the page ends with one module script that
imports a pinned Mermaid 11 from jsDelivr and draws every block in the lotus
palette, built from `tokens.json` (surface fills, lavender lines and borders,
pale lavender labels in the mono font on the night background). The text inside
the block is left exactly as written, since Mermaid reads it verbatim; before
the script runs, or without scripting, it reads as a code block. A body with no
diagram block ships no script and no CDN reference at all.

Pass `--variant report` for a long technical report. The page keeps the same
markup with one class more, `artifact--report` on the `main` element, and the
theme switches on a denser reading surface behind it: 14px body on a wider
measure, the header flattened to a hairline, inline code that wraps anywhere,
tables laid out as tables at the reading column's width instead of scrolling,
and the outline rail on the left of the prose on a wide page. The default,
`--variant article`, stamps nothing, so a page rendered without the flag is
byte-identical to one rendered before the variant existed.

### From markdown

`--markdown PATH` renders the page straight from a markdown file instead of an
HTML `--body` (the two cannot be combined); `--markdown -` reads standard
input. The file is read inside the process, so a body of any size gets through
without meeting the command-line length limit.

```sh
lotuspod render --name ep-002 --title "Under the Leaves" --markdown ep-002.md
```

The converter (`lotuspod.markdown.to_body`) takes a small subset of markdown:

- `##` and `###` headings, and paragraphs; every `# ` line is dropped, since
  the title is passed with `--title`.
- `-` and `1.` lists, nested by indentation; indented plain text under an item
  continues it.
- `>` blockquotes, converted like the page itself, so fences, lists and tables
  work inside them.
- Pipe tables: the first row is the header, and the dashed separator row is
  dropped.
- `` `code spans` `` and `**bold**`.
- Fenced code: a `mermaid` fence becomes a `<pre class="mermaid">` diagram
  block, any other fence a `<pre><code>` block.

Everything from a `## Concrete commands` heading on is left out of the page,
which keeps host-only commands off published pages. Links, images and task
lists are not converted.

## Publish a page

`lotuspod publish SOURCE` puts a page on the site in one step: it renders the
page, keeps its source beside it, rebuilds `manifest.json` and `index.html`,
and, when the output directory is the top of its own git repository, makes
one commit, `publish NAME`, and pushes it - where `render`, `manifest` and
`index` run one by one commit once each.

```sh
lotuspod publish pond-plan.md --date 2026-09-01 --summary "Water plan"
lotuspod publish garden.html
lotuspod publish - --format markdown --name pond < pond.md
```

`SOURCE` is a `.md` or `.markdown` page (converted as above), an `.html` or
`.htm` page body (used as given), or `-` for standard input with `--format
markdown|html` and `--name`. The page name defaults to the file name up to its
first dot. The title is the first `# ` line of a markdown page, or the text of
the first `<h1>` of an HTML one (which is taken out of the body, so the page
does not show it twice); `--title` overrides both, and a page with no title is
refused. An HTML body gets the same section ids and outline as a markdown one.

The source is kept byte for byte as `NAME.md`, or `NAME.body.html` for an HTML
body. Both are sources, not pages: the manifest and the index leave them out,
and serve never answers for them.

Republishing a page keeps its date, summary and treatment unless `--date`,
`--summary` or `--variant` is given; a new page gets today's date and the
`report` treatment.

A published page takes comments on every section (see [Comments](#comments));
`--no-comments` leaves the boxes out. `--owner HANDLE --credential FILE`
names the agent or seat that published it, and a republish without `--owner`
keeps the page's owner.

Every published page carries its source's revision - the first 12 hex
characters of the SHA-256 of the kept source - in a `lotuspod:revision` meta
tag, and `publish` prints it. `--expect-revision REV` publishes only when the
page is at `REV` (`none`: only when there is no page yet); otherwise publish
exits 3 with "revision conflict" and writes nothing. Publishes to one
directory take turns under a lock file kept beside the directory (never inside
it), and every file is written under a temporary name and renamed into place,
so a reader never sees half a page.

On a machine other than the writer host, `publish` publishes on the writer
host when a local config file names it. The config is the first of
`$LOTUSPOD_CONFIG`, `$XDG_CONFIG_HOME/lotuspod/config.ini` and
`~/.config/lotuspod/config.ini` that exists; with none, `publish` publishes
here:

```ini
[publish]
host = writer.example
command = lotuspod
out_dir = /srv/lotuspod/artifacts
```

With `host` set, `publish` runs `ssh HOST COMMAND publish --local - --out-dir
OUT_DIR --format FORMAT --name NAME ...` with the source on standard input;
the format and name are worked out here from the file name, and every
argument after `command` is shell-quoted (`command`, default `lotuspod`, is
used as written); `--owner`, `--credential`, `--db` and `--no-comments` go
along when given, so the credential file and the database named are the writer
host's. `out_dir` is required when `host` is set. The far side's
output passes through and its exit status is `publish`'s, so a revision
conflict still exits 3. `--local` publishes on this machine regardless of the
config, and `--out-dir` without `--local` is refused while a host is set. Keep
the host's address in the local config only, never in this repository.

## Manifest

Generate `artifacts/manifest.json`, an index of every rendered artifact in a
directory:

```sh
lotuspod manifest            # scans artifacts/ (or pass --out-dir DIR)
```

The manifest is a versioned document:

```json
{
  "version": 2,
  "artifacts": [
    {
      "file": "ep-001.html",
      "title": "Opening the Pond",
      "episode": "1",
      "date": "2026-08-22",
      "summary": "Why we started Lotuspod.",
      "visible": true
    }
  ]
}
```

The schema is uniform: every entry carries exactly `file`, `title`, `episode`,
`date`, `summary`, and `visible`; fields with no value are empty strings, never
`null`. Entries are sorted by filename.

Visibility is fail-closed: an artifact is listed only when its
`lotuspod:visible` meta flag is present and exactly `true`. Artifacts rendered
with `--hidden`, with a malformed flag value, or without any flag (pre-v2
pages) are excluded — re-render them with this version to publish. The flag
governs listings, and `lotuspod serve` v2 enforces it over HTTP too (hidden
pages 404 even by direct URL); opening the file on disk still works.

## Index

Build `artifacts/index.html`, a browsable episode index linking every rendered
artifact:

```sh
lotuspod index               # scans artifacts/ (or pass --out-dir DIR)
```

The listing is a table: one row per artifact, with the episode, title (linking
to its page), date, and summary parsed from the rendered HTML. Only
fail-closed-visible artifacts are listed (same rule as `lotuspod manifest`).
Rows arrive in filename order and are styled by the lotus theme. Re-running is
safe: `index.html` never lists itself (and is skipped by `lotuspod manifest`
too).

Click a column header to sort by it (a second click reverses; the episode
column sorts numerically, and rows with a blank value in the sorted column sink
to the bottom either way), and type in the search box to filter rows down to
those matching the query in any column. Both are progressive enhancement from a
script inlined in `index.html` — no extra file to serve — so with scripting off
the page is still the complete listing, just unsorted and unfiltered (the search
box stays hidden rather than offering a control that cannot filter).

## Serve

Share rendered episodes over your tailnet:

```sh
lotuspod serve               # serves artifacts/ (or pass --out-dir DIR)
lotuspod serve --port 8080   # pick a different port (default: 8000)
lotuspod serve --host 127.0.0.1  # bind address override for tunnel fronting
```

The command detects this node's tailnet IPv4 (`tailscale ip -4`) and listens
only on that address, so your podcast pages are reachable from the other
devices in your tailnet — and nothing outside it. Open the printed
`http://100.x.y.z:8000/` URL on any tailnet device; `/` serves
`artifacts/index.html` (build it first with `lotuspod index`). Requires a
running `tailscaled`; without a tailnet address it exits with an error.
Pass `--host` to bind an explicit address instead — e.g. `127.0.0.1` when a
local Cloudflare Tunnel fronts the server (see Publish below); everything
else behaves identically.

Serve v2 enforces an allow-list: the server answers only for `index.html`,
`lotuspod.css`, `favicon.svg`, the page script `lotuspod-page.js`, and artifact pages whose fail-closed `lotuspod:visible` flag
parses to exactly `true` — the same rule as `lotuspod manifest`.
`manifest.json` and `FINDINGS.md` are never served (the manifest lists
private artifact ids); requests for either return 404. Everything else
returns 404: hidden pages (rendered with
`--hidden`, a malformed flag, or no flag at all) are no longer reachable by
direct URL, and page sources (`NAME.md`, `NAME.body.html`), stray files,
dotfiles (`.git` included), a page or theme file that is a symbolic link,
subdirectories, traversal attempts (encoded or not), and directory listings
are denied too. The allow-list is recomputed per request,
so re-rendering an artifact publishes or unpublishes it live — no restart.

## Who is reading: Cloudflare Access

The site sits behind Cloudflare Access, and serve's `/api` routes know the
signed-in reader only from the `Cf-Access-Jwt-Assertion` token Access signs.
The plain `Cf-Access-Authenticated-User-Email` header is never read: serve
listens on loopback, where any process on the host could send it. The
settings go in an `[access]` section of the same config file `publish` reads
(`$LOTUSPOD_CONFIG`, then the XDG location); keep the real team, audience and
emails there only, never in this repository:

```ini
[access]
issuer = https://TEAM.cloudflareaccess.com
audience = APPLICATION_AUDIENCE_TAG
certs_url = https://TEAM.cloudflareaccess.com/cdn-cgi/access/certs
allowed_emails = reader@example.com, other.reader@example.com
```

Every `/api` request must carry an assertion whose RS256 signature verifies
against a key in the team's key set (keys under 2048 bits are ignored), whose
`iss` is `issuer`, whose `aud` holds `audience` exactly, which is unexpired and
not issued in the future (60 seconds of leeway), and whose `email`, compared
lower-cased, is in `allowed_emails`. `certs_url` may be `https:`, `http:` or
(for tests) `file:`. The key set is fetched on first need and kept for an
hour; an unknown key id refetches it at most once a minute, and after a fetch
fails every `/api` request answers 503 until it is tried again a minute later.

Answers are JSON with `Cache-Control: no-store`: no assertion is 401
`signed_out`, one that does not verify 401 `invalid_assertion`, a verified one
for an email not allowed 403 `forbidden`, a key set that cannot be fetched 503
`access_unavailable`, and a config with no `[access]` section 503
`access_unconfigured` (pages are served as before). `GET /api/whoami` answers
`{"actor": {"kind": "human", "email": EMAIL}}`.

## Answers and comments

serve keeps the reader's answers and comments in one SQLite file,
`lotuspod.sqlite3` beside the artifacts directory (`artifacts/../`), or the
file `serve --db PATH` names. It is made on first write, its schema versioned
with `PRAGMA user_version`, and it runs in WAL mode, so SQLite keeps
`lotuspod.sqlite3-wal` and `-shm` files beside it; `.gitignore` covers all
three. A `--db` inside the artifacts directory is refused at start (exit 1):
the artifacts repository commits everything there. serve never answers the
file either way.

Four routes sit behind the Access check above; each row records the verified
reader as `actor`, the page's `lotuspod:revision` when it was written as
`revision`, and `createdAt` (UTC, ISO 8601). Ids are integers never given out
twice.

- `POST /api/answers` with `{page, question, version, choice, note}` stores an
  answer and answers 201 with it, its `supersedes` the id of the answer to the
  same page and question it replaces, or null.
- `GET /api/answers?page=NAME` answers `{page, questions}`: each answered
  question as `{current, earlier}`, the newest answer and the older ones newest
  first.
- `POST /api/comments` with `{page, section, text}` (and optionally a `quote`,
  `{exact, prefix, suffix}`) opens a thread on a section; with
  `{page, parent, text}` it replies. It answers 201 with the row: `section`,
  `sectionTitle` (the text of the page's h2 with that id, or empty), `parent`,
  `quote`, and its routing state (`state` and `owner`, below). A reply takes its thread's section, and a
  reply to a reply joins the same thread: `parent` is always the thread's first
  comment.
- `GET /api/comments?page=NAME` answers `{page, threads}`: each as
  `{root, replies}`, threads and replies oldest first.

Every answer is JSON with `Cache-Control: no-store`, and a refused request
stores nothing. A POST sent from a page of another origin (its `Origin`, or
`Sec-Fetch-Site: cross-site`) is 403 `cross_origin`: the request's own origin
is its `Host` over the scheme `X-Forwarded-Proto` names (the tunnel ends the
TLS), else `http`; one that is not
`application/json` 415; one with no length 411; a body over 16 KiB 413. A
missing, extra or mistyped field is 400 `invalid_body`, as are `question`,
`version` or `choice` outside 1 to 100 characters, an empty `section` (any
heading id's length is taken, since it must name one of the page's boxes),
`text` outside 1 to 4000, `note` over 4000, and a quote whose `exact` is outside 1 to 500 or
whose `prefix` or `suffix` is over 32. A page serve would not answer (hidden,
missing, not a page) is 404 `unknown_page`, and a reply to no comment on its
page 404 `unknown_parent`. A read without exactly one `page` is 400
`invalid_query`. An answer is checked against the page's own decision forms
(below): a question the page does not ask is 400 `unknown_question`, a
`version` other than the form's 409 `stale`, and a `choice` the form does not
offer 400 `invalid_choice`. A new thread is checked against the page's comment
boxes (below): a `section` the page has no box for is 400 `unknown_section`.

## Decisions for the maintainer

A plan page often ends with a table of questions for the maintainer. `render`
and `publish` turn it into forms the maintainer answers on the page:

```markdown
## Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| 1 | Which model replies? | Sonnet / Opus | Sonnet |
| 2 | Keep the archive? | Yes / No | Yes |
```

The table taken is the first one after an h2 or h3 whose text is "Decisions
for the maintainer" (any case), before the next h2, whose header row has a
`Question` column. The pass works on the body's HTML, so a markdown page and
an HTML one alike get it. `#`, `Options` and `Default` columns are optional;
any other column is shown under its question as context.

Each row becomes a `form.artifact-decision` with one radio button per option
and a note. Its question id is `decision-` and the slug of its `#` cell, or
`decision-N` by row number without a `#` column. Options are the `Options`
cell split on ` / `, each keyed by its slug; the one matching the `Default`
cell is labelled "(default)", and none is pre-selected. With a `Default` but
no `Options` column, a row offers "Accept the default" (`accept`) and
"Something else" (`other`) and shows the default's text. A table with any row
of fewer than two options is left exactly as written, and the page then loads
no script.

Each form carries `data-version`, a short hash of its question's text and its
options' labels. Rewording a question changes its version, so answers given
to the old wording are not attached to the new words: the answers route
refuses a stale version (409), and the page shows an old answer as given "to
an earlier wording" without filling the form from it.

A page with such forms loads the site's page script, `lotuspod-page.js`,
which serve answers beside `lotuspod.css`. It reads the page's answers, marks
each current choice, fills its note, and shows "Answered by READER, TIME" and
a collapsed list of earlier answers. Answering again keeps the earlier answer
as history. The script sends no credential of its own: the reader's Access
session is the only identity, so a reader who is signed out is told to reload
the page to sign in. Reader text is set as text, never as markup.

An answer is the reader's choice on that one question, recorded with the page
revision it was given against. It is evidence for that question's scope only
and authorizes nothing beyond what the question describes.

`lotuspod answers PAGE` prints the same on the writer host, from the database
serve keeps (`--db` and `--out-dir` as serve takes them): each answered
question, its current choice's label with its note, reader and time, the
answer it replaces, and the earlier answers under it. `--json` prints what
`GET /api/answers?page=PAGE` answers.

```sh
lotuspod answers pond-plan
lotuspod answers pond-plan --json
```

## Comments

A remark about one part of a page belongs next to it. `publish` ends every h2
section of a page with a comment box, and `render --comments` does the same
(off by default for `render`; `publish --no-comments` turns it off). A section
runs from its heading to the next h2 or the end of the body; a body with fewer
than two h2 sections gets one box, for the whole page, at its end. The pass
runs on the body's HTML after the outline pass, so markdown and HTML pages
alike get it, and each box names its heading's id: `--comments` with
`--no-outline` is refused (exit 1, nothing written). A heading inside a
diagram or a form starts no section, so a box never lands inside either.

Each box is a `details.artifact-comment` with `data-page` and `data-section`
(the heading's id, or `page`), holding the section's threads and a form to
start a new one. The page script, `lotuspod-page.js`, reads the page's threads
and shows each in its section's box: every comment's author, time and text, an
agent's reply marked with its handle, and a reply box per thread. Posting
adds the comment without a reload, and the box's summary reads "Comment", or
"Comments (N)" once it holds threads. A thread whose section the page no
longer has is listed at the end of the body under "Comments on sections that
have changed". Every author and text is set as text, never as markup.

Each reader's comment shows its `state`, with the handle it is routed to (its
`owner`, else the page's):

| `state` | shown |
| --- | --- |
| `pending` | waiting for HANDLE |
| `unavailable` | HANDLE is offline; queued for it |
| `claimed` | HANDLE is answering |
| `answered` | answered |
| `failed` | HANDLE could not answer: REASON (its `reason`) |
| `paused` | the responder is paused |

An agent's reply that carries a `revision` shows "Revised the page · revision
R", linking to the page. Routing (below) sets `pending` and `unavailable`, and
`paused` for a comment routed to `responder` while the default responder is
paused (see below); an agent's claim, reply, release and failure (see the
pull loop) set `claimed`, `answered` and `failed`, with the handle that took
it up as its `owner`; only a failed comment carries a `reason`. A comment
grants no authority: an agent answers it and may revise its page, nothing
else.

Every reader's comment no agent has taken up is routed to exactly one handle,
by one rule that the threads routes and the agents' pull share:

- A comment whose text starts with `@HANDLE` (`@`, a handle in any case, then
  whitespace, punctuation or the end) is routed to HANDLE and only ever to
  HANDLE: `@Claude-3f9a2c, see` and `@claude-3f9a2c: see` go to
  `claude-3f9a2c`, while `email@claude-3f9a2c` names nobody. `@responder`
  names the default responder. To re-route, write a new comment naming
  someone else.
- A comment with no mention, on a page whose owner was listening when it
  arrived, is routed to the owner until the owner window has passed since it
  arrived. After that, or when the owner was not listening, or when the page
  has no owner, it is routed to `responder`.
- A handle is listening when its last pull (below) is within the owner
  window: 300 seconds, or what `serve --owner-window SECONDS` or the config's
  `[comments] owner_window_sec` sets.

A routed comment is `pending` while its handle is listening and `unavailable`
while it is not; its `owner` is that handle (null on an agent's reply). A
claim lasts 900 seconds, or what the config's `[comments] claim_sec` sets;
a claim that expires lapses, and the comment is routed again by the same rule.

```ini
[comments]
owner_window_sec = 300
claim_sec = 900
```

A page's owner is the handle of the agent or seat that published it: 1 to 63
lower-case letters, digits and hyphens, starting with a letter or digit (a
seat such as `operator`, `hermes` or `example-seat`, or a session's handle
such as `claude-3f9a2c`). `--owner HANDLE` on `publish` or `render` needs
`--credential FILE` (or `$LOTUSPOD_CREDENTIAL`) for a credential that holds
both `publish` and HANDLE, checked in serve's database (`--db`, with serve's
default); otherwise the command exits 1 naming the problem and writes nothing.
The page carries the handle in a `lotuspod:owner` meta tag and shows
"Published by HANDLE" in its header.

```sh
lotuspod publish pond-plan.md --owner hermes --credential ~/.config/lotuspod/hermes.token
```

As with every credential, this keeps well-behaved agents honest: a process
running as the same user can still edit the files (see below).

## Agent credentials

Agents on the writer host (the operator seat, Hermes profiles, one-off Claude
Code or Codex sessions, the default responder) never use the `/api` routes,
which are the reader's. serve also listens on a Unix socket, `lotuspod.sock`
beside the database, or the path `serve --socket PATH` or an `[agents]`
section's `socket` key in the config names:

```ini
[agents]
socket = /home/writer/lotuspod/lotuspod.sock
```

The socket is made with mode 0600 and removed when serve stops; a socket file
left by a serve that died is removed at start, but serve refuses to start when
something still answers on it. Being on the same machine is not an identity:
every request on the socket carries a machine credential the operator makes on
the host.

```sh
lotuspod credential create hermes --handle hermes --op pull --op reply \
  --out ~/.config/lotuspod/hermes.token
lotuspod credential list          # --json for JSON; tokens are never shown
lotuspod credential revoke hermes # ends it at once
```

`create` binds the credential to the owner handles it may act as (`--handle`,
repeatable: 1 to 63 lower-case letters, digits and hyphens, starting with a
letter or digit; a credential's name follows the same rule) and the operations
it may do (`--op`, repeatable: `pull`, `claim`, `reply`, `publish`). It writes
a new random token to the `--out` file with mode 0600, refusing a file that
already exists, and the database keeps only the token's SHA-256. The commands
take `--out-dir` and `--db` as serve does, and write the database directly.

An agent sends `Authorization: Bearer TOKEN`; agent commands take `--socket`
and `--credential FILE` (or `$LOTUSPOD_CREDENTIAL`), the socket defaulting to
the config's `[agents] socket`, then `lotuspod.sock` beside the default
database. A missing, unknown or revoked token is 401 `invalid_credential`. The
socket answers only `/v1/` paths (the `/api` routes are not on it, and serve's
port never answers `/v1/`), as JSON with `Cache-Control: no-store`:

- `GET /v1/whoami` answers `{"credential": {name, handles, operations,
  createdAt, revokedAt}}`.
- `GET /v1/check?op=OP&handle=HANDLE` answers 200 when the credential may do OP
  as HANDLE; an operation on behalf of a handle is allowed only when the
  credential holds both, otherwise 403 `handle_not_allowed` or
  `operation_not_allowed`.

- `GET /v1/pull?owner=HANDLE`, `POST /v1/answers/ID/ack`,
  `GET /v1/threads?page=NAME`, and `POST /v1/comments/ID/claim`, `/reply`,
  `/release` and `/fail`: the pull loop, below.

No socket route writes a reader's answer or comment, whatever the credential.

Know the limit: processes running as the same user are not isolated from one
another. Any process running as the same user can read the token files and the
database. Credentials keep well-behaved agents to their own handles and record
who acted; they do not isolate a hostile process running as the same user.

## Agents: the pull loop

Every kind of agent (a Claude Code or Codex session, a Hermes profile, a
script) reads what is meant for it with one command, through the socket, with
a credential that may `pull` as its handle:

```sh
lotuspod comments pull --owner hermes --json   # GET /v1/pull?owner=hermes
lotuspod comments ack-answer 12                # POST /v1/answers/12/ack
lotuspod comments show pond-plan --json        # GET /v1/threads?page=pond-plan
```

`pull` records that the handle is listening and returns its items. It claims
nothing and settles nothing, so the same items come back on every pull until
they are claimed or acknowledged: an agent that only reads never blocks the
fallback to the responder. A page's owner goes on reading a comment that was
routed to it as it arrived after the owner window passes it to `responder`,
until an agent takes it up; its `owner` is then `responder`, and only the
responder may claim it. Items are, comments first, oldest first:

- `{"kind": "comment", "comment", "thread", "omitted", "page"}` for each
  reader's comment routed to the handle (above) that no agent holds a current
  claim on. `comment` carries its verified `actor`, its section, the revision
  it was written against and its routing state; `thread` is a list, the
  thread's first comment and at most its last 20 replies, oldest first, and
  `omitted` counts the replies left out.
- `{"kind": "answer", "answer", "question", "page"}` for each answer on a page
  the handle owns that it has not acknowledged, superseded ones included (each
  names the answer it `supersedes`). `question` is `{id, text, label,
  reworded}`: the question and the chosen option's label in the words the
  reader answered, kept with the answer, and whether the page now asks it in
  other words, or not at all. An answer is
  evidence of the reader's choice on that one question only.
- `page` is `{name, title, owner, revision, sourceFile, source}`: `source`
  is the page's kept `NAME.md` or `NAME.body.html`, exactly as kept, and
  `revision` the revision of those very bytes, which is the page's
  `lotuspod:revision` once any publish has finished. Read beside a publish,
  it is the older revision the source still has, so an edit expecting it is
  refused rather than overwriting the newer one. A page published before sources were kept
  has an empty `source` and `sourceFile`, and the revision of the page as
  rendered. The pull is the only way a page's source leaves the host's files.

`ack-answer ID` needs `pull` for the page's owner; the owner's pulls leave an
acknowledged answer out from then on. `show PAGE` needs `pull` for any handle
and prints what the reader's `GET /api/comments?page=PAGE` answers, so an
owner coming back later can catch up.

To answer a comment, an agent claims it, then replies under the claim, so two
agents sharing a handle never both answer and a retry after a crash never
answers twice:

```sh
lotuspod comments claim 7 --json
# {"comment": 7, "handle": "hermes", "claimToken": "…", "expiresAt": "…"}
lotuspod comments reply 7 --claim TOKEN --key hermes-7-1 --text "Cut it." --json
lotuspod comments reply 7 --claim TOKEN --key hermes-7-2 --text-file reply.md \
  --revision 3f2a9c01d4be                        # having revised the page
lotuspod comments release 7 --claim TOKEN      # back to routing, unanswered
lotuspod comments fail 7 --claim TOKEN --reason "source missing"
```

- `claim ID` (`POST /v1/comments/ID/claim`) needs `claim` and the handle the
  comment is routed to (else 403 `not_routed`). It is atomic: while another
  credential's claim is current it is 409 `claimed`, and an answered or failed
  comment is 409 `settled`. It answers `{comment, handle, claimToken,
  expiresAt}` and the comment is `claimed`, leaving every pull, until the
  claim expires (`[comments] claim_sec`), when it lapses and is routed again.
- `reply ID --claim TOKEN --key KEY (--text TEXT | --text-file PATH)
  [--revision R]` (`POST /v1/comments/ID/reply` with `{claimToken,
  idempotencyKey, text[, revision]}`) needs `reply`. A KEY this credential
  has sent before answers the reply stored with it, whatever has happened to
  the claim since. Otherwise the claim must be this credential's, current,
  and the one TOKEN names, else 409 `not_claimed`; a `revision` must be the
  page's current one, or one the default responder's credential republished
  the page at for this KEY (below), else 409 `revision_mismatch`, and the
  reply then shows as having revised the page. The reply joins the thread with the actor
  `{"kind": "agent", "handle", "credential"}`, the comment is `answered`, and
  the claim ends.
- `release ID --claim TOKEN` ends the claim unanswered: the comment is
  `pending` again and in its route's next pull. `fail ID --claim TOKEN
  --reason TEXT` (up to 200 characters) leaves it `failed`, the reason on the
  page; nothing retries it, and the reader routes it again by writing a new
  comment. Both need `claim` and the current claim, else 409 `not_claimed`.

The key is the retry mechanism. Choose one key per intended reply before
acting (the handle, the comment and a counter will do), keep it with the
work, and after a crash send the reply again with the same key: it lands
once, whatever happened in between. A new key is a new reply, and needs a
current claim.

Every claim, reply, release and failure is written, in the same
transaction, to an audit trail naming the credential and handle that acted,
and so is every page the default responder republishes (action `publish`).
On the host, `lotuspod audit [--page NAME] [--json]` (with `--out-dir` and
`--db` as serve takes them) lists them oldest first: time, action, comment,
page, credential, handle, the key of a reply or of the reply a republish
was for, and the revision a republish made; `--json` prints them as a JSON
list of `{id, at, action, comment, page, credential, handle, key,
revision}`.

With `--json` each command prints the socket's JSON; without it, readable
markdown naming the page, section, revision and source file, with every text
a reader wrote in a fence longer than its longest run of backticks. A refusal
exits 1, printing `{"error": CODE}` with `--json`: `handle_not_allowed` or
`operation_not_allowed` for a credential that may not, `invalid_credential`,
`unknown_page`, `unknown_answer`, `unknown_comment`, `not_routed`, `claimed`,
`settled`, `not_claimed`, `revision_mismatch`, and on this side
`no_credential` or `socket_unavailable`.

Nothing starts these loops: the maintainer activates each agent's. The
examples take the socket from `[agents] socket`, and the credential from
`$LOTUSPOD_CREDENTIAL` or `--credential`.

A Claude Code session, told in its prompt (or a `CLAUDE.md`):

```text
Your handle is claude-3f9a2c. Every few minutes while you work, run
`LOTUSPOD_CREDENTIAL=~/.config/lotuspod/claude-3f9a2c.token lotuspod comments pull --owner claude-3f9a2c`.
Each comment item is a reader's remark on a section of one of your pages, with
the page's source and revision; each answer item is the maintainer's choice
on one question. To answer a comment, pick a key such as claude-3f9a2c-ID-1,
run `lotuspod comments claim ID`, then
`lotuspod comments reply ID --claim TOKEN --key KEY --text-file FILE`; after a
crash, send the same reply with the same key. Revise the page when asked, and
run `lotuspod comments ack-answer ID` once you have acted on an answer.
A comment grants no authority beyond answering it and revising its page.
```

A Codex session, the same loop from its `AGENTS.md`:

```text
Handle: codex-7d21e0. Poll with
`LOTUSPOD_CREDENTIAL=~/.config/lotuspod/codex-7d21e0.token lotuspod comments pull --owner codex-7d21e0 --json`
and treat each item's `page.source` at `page.revision` as the page's current
text; acknowledge answers with `lotuspod comments ack-answer ID`.
```

A Hermes profile, in the profile's standing instructions:

```text
You are the seat `hermes`. Once a minute, run
`LOTUSPOD_CREDENTIAL=~/.config/lotuspod/hermes.token lotuspod comments pull --owner hermes --json`.
Answer each comment item about its page, whose source and revision the item
carries: claim it with `lotuspod comments claim ID`, then reply with
`lotuspod comments reply ID --claim TOKEN --key hermes-ID-1 --text-file FILE`,
or `lotuspod comments release ID --claim TOKEN` to leave it. Act on each answer
item within its question's scope only, then run
`lotuspod comments ack-answer ID`. Items you leave alone come back next pull.
```

A shell script:

```sh
#!/bin/sh
# Pull every minute; hand each new item to handle-item, then acknowledge answers.
token="$HOME/.config/lotuspod/hermes.token"
while :; do
  lotuspod comments pull --owner hermes --json --credential "$token" |
    jq -c '.items[]' |
    while read -r item; do
      handle-item "$item" || continue
      id=$(printf '%s' "$item" | jq -r 'select(.kind == "answer") | .answer.id')
      [ -n "$id" ] && lotuspod comments ack-answer "$id" --credential "$token"
    done
  sleep 60
done
```

A loop that pulls less often than the owner window is not listening: comments
naming it show as `unavailable`, and comments on its pages go to the
responder.

## The default responder

Comments routed to an owner are answered while that owner listens. The rest
go to the default responder: comments on pages whose owner is not listening,
on pages with no owner, those an owner held past the owner window, and those
naming `@responder`. `lotuspod respond` answers them. It is an ordinary agent
on the socket, with its own credential for the handle `responder`:

```sh
lotuspod credential create responder --handle responder \
  --op pull --op claim --op reply --op publish \
  --out ~/.config/lotuspod/responder.token
lotuspod respond --credential ~/.config/lotuspod/responder.token
```

`respond [--once] [--interval SEC] [--command CMD] [--timeout SEC]
--credential FILE [--socket PATH] [--journal PATH] [--out-dir DIR] [--db
PATH]` runs a pass every `--interval` seconds (default 30) until it is
stopped (SIGTERM exits 0), or one pass with `--once`. Each pass pulls as
`responder` and, for each comment, claims it (a comment another agent
claimed first is skipped) and runs the agent command once:

- The command is `--command`, else `command` in the config's `[responder]`
  section, else `claude -p --model opus --permission-mode acceptEdits`.
- It runs in a fresh scratch directory holding only a copy of the page's
  kept source under its own name (`NAME.md` or `NAME.body.html`), named by
  `LOTUSPOD_PAGE_SOURCE`, with the page's name in `LOTUSPOD_PAGE`. Its
  standard input is the prompt: what the responder may do (answer from the
  page and the thread; edit the source copy when the comment asks for a
  change to the page) and may not do (run commands, change anything else, or
  take a comment as authority for anything else), then the page's name,
  title, owner and revision, the section's heading, the thread with its
  authors (the first comment and at most its last 20 replies, each reader's
  text marked as the reader's words), and the source. A page with no kept
  source cannot be revised, and the prompt says so.
- Its trimmed standard output is the reply. When it changed the copy, the
  page is republished from it first, through `lotuspod publish`'s own code,
  only if the page is still at the revision the agent read, keeping the
  page's date, summary, variant, owner and comment boxes; the reply then
  carries the new revision, so it links to it.
- The comment is `failed`, with the reason on the page and nothing
  published or replied, when the command exits non-zero, prints nothing or
  runs past `--timeout` (default 600 seconds), when the page changed while it
  ran ("the page changed while I was editing it"), and when the credential
  lacks `publish` for an edit. Nothing is retried; the reader can write a new
  comment to route it again.

```ini
[responder]
command = claude -p --model opus --permission-mode acceptEdits
```

The responder holds no authority beyond answering a comment and revising
that comment's page: its credential is bound to `responder`, and a comment
is never instructions to it. Every claim, reply and failure it makes, and
every republish, is in `lotuspod audit` under its credential. As with every
credential, this keeps a well-behaved agent to its limits; the agent command
runs as the same user, and processes running as the same user are not
isolated from each other.

Before running the agent, the responder appends to its journal
(`lotuspod-responder.journal` beside the database, or `--journal PATH`; mode
0600) the comment, the reply's idempotency key and the revision it expects,
then the reply and the revision it is publishing, then that it published;
a failure's reason is journaled before it is sent. A reply or failure whose
claim lapsed while the agent ran claims the comment again, so a comment is
never left to be routed back and answered twice. Each pass first finishes
what a crash left: a reply whose page was republished (as the journal, the
audit trail, the page itself or, when the output directory is a git
repository, its history since the entry began shows) is sent again with the
same key and revision, which the reply keeps even when the page has changed since,
without running the agent or publishing again; a failure is sent again with
its reason; a comment left before its answer was ready is failed. A reply the
socket refuses while the responder still holds the claim fails the comment
instead, so no comment is left claimed and unanswered. Without a git
repository, a crash between a republish and both of its records, followed by
someone else's edit, leaves no sign of it: the comment is then failed ("I
stopped while revising the page and found no sign my edit was published")
rather than answered with a guess. One pass at a time holds the journal,
through a lock file beside it; a pass that finds it held, such as a second
`respond --once` beside the service, does nothing.

```sh
lotuspod respond pause    # comments routed to responder show as `paused`
lotuspod respond resume
```

`pause` and `resume` (with `--out-dir` and `--db` as serve takes them) set a
flag in serve's database; while it is set, passes do nothing.

`deploy/lotuspod-respond.service` runs `lotuspod respond` as a systemd user
service from the same working directory and virtual environment as
`deploy/lotuspod.service`, restarting on failure. Nothing enables it: make
its credential on the writer host, sign `claude` in for that user, adjust
the paths, copy it to `~/.config/systemd/user/`, then run
`systemctl --user enable --now lotuspod-respond.service`.

## Backups

The writer host holds two things that belong together: serve's database of
the reader's answers and comments and the agents' replies, and the artifacts
repository of the pages they refer to. `lotuspod backup` takes one backup set
of both while serve keeps serving:

```sh
lotuspod backup                       # --db PATH --out-dir DIR --to BACKUPS as needed
lotuspod backup --verify latest       # restore the newest set into scratch space and check it
lotuspod restore BACKUPS/20260930T031500.123456Z --db PATH --out-dir DIR
```

`backup [--db PATH] [--out-dir DIR] [--to BACKUPS] [--keep N] [--json]`
takes `--out-dir` and `--db` as serve does and refuses, writing no set, an
output directory that is not its own git repository. serve makes its
database on first use, so a first backup that finds none makes it as serve
would; once `BACKUPS` holds a set, a missing database is refused, writing
no set and removing none, since it means a wrong `--db` or a lost file. Holding the publish
lock, so no publish lands between the two, it copies the database with
SQLite's online backup and bundles every ref of the repository with `git
bundle create --all`, into a new directory `BACKUPS/UTC-TIMESTAMP` (mode
0700, its files 0600): `lotuspod.sqlite3`, `artifacts.bundle`, and
`manifest.json` with each file's SHA-256, the database's schema version, the
repository's `HEAD` and its `origin`, if it has one. A set appears whole or
not at all. `BACKUPS` is `--to`, else `lotuspod-backups` beside the artifacts
directory, never inside it. The newest `--keep` sets (default 14) are kept
and older ones removed; nothing else in `BACKUPS` is touched. `--json` prints
`{"backup": PATH}`.

`restore SET --db PATH --out-dir DIR` checks every file of the set against
its checksum first, then copies the database to `--db` and clones the bundle
into `--out-dir`, with `main` checked out at the recorded `HEAD` and `origin`
set to the recorded remote (no `origin` when none was recorded). It never
pushes. It exits 1 naming the file, and writes nothing, when a checksum does
not match, and it refuses, changing nothing, when the database (or a `-wal`,
`-shm` or `-journal` file beside it) or the output directory already exists:
restore into fresh paths, check them with `lotuspod serve --out-dir DIR --db
PATH`, then stop serve and move them into place.

`backup --verify SET` (or `latest`, the newest set in `--to`) restores the
set into a temporary directory, runs `PRAGMA integrity_check` and `git fsck`,
compares `HEAD` with the manifest's, and exits 1 naming the first failure.

`deploy/lotuspod-backup.service` runs `lotuspod backup` and then `lotuspod
backup --verify latest` from the same working directory and virtual
environment as `deploy/lotuspod.service`, and `deploy/lotuspod-backup.timer`
runs it every night, catching up after the host was down (`Persistent=true`).
Nothing enables them: adjust the paths, copy both to
`~/.config/systemd/user/`, then run `systemctl --user enable --now
lotuspod-backup.timer`; `journalctl --user -u lotuspod-backup.service` shows
each night's result.

Where the backups live: a set on the writer host guards against a bad
publish, a bad migration or a deleted file, not against losing the host. A
set holds every reader's comments and the hashes of the machine credentials,
so copy `BACKUPS` to storage only the maintainer can read, on another
machine; which one is the maintainer's to decide, and nothing here copies
backups off the host. Between nightly sets there is no point-in-time
recovery: a restore returns the site to the moment of its set.

## What a page may run

Every artifact page carries a Content-Security-Policy meta tag at the top of
its head, computed from the finished page so it never allows more than the
page holds. A page runs only the site's own script files, the pinned Mermaid
(`https://cdn.jsdelivr.net/npm/mermaid@11.4.1/`, allowed only on a page with a
diagram) and the inline scripts the page template writes, each allowed by its
`sha256` hash; today that is the Mermaid start-up module alone. A page with
decision forms also loads the site's page script, `lotuspod-page.js`. Styles may be
inline, since Mermaid sets them so; images come from the site or `data:`
URLs; plugins, `<base>` and forms posting elsewhere are refused.

A script written into a page body is never hashed, so it does not run, and
neither does an inline event handler such as `onclick`. `render` and
`publish` still publish the page and print one line naming it and how many
scripts will not run. Serve adds `Content-Security-Policy: frame-ancestors
'none'` and `X-Content-Type-Options: nosniff` to every page it answers, so
no other site can frame a page.

## Publish

Publish the pond publicly at `https://lotuspod.example.com` through a
Cloudflare Tunnel. The checked-in ingress config lives in
`deploy/cloudflared.yml`; it routes the public hostname to the same
allow-listed server on the dedicated publish port `127.0.0.1:8622` (see
`deploy/README.md` for the full copy-paste setup, including the
`lotuspod.service` unit):

```sh
cloudflared tunnel login
cloudflared tunnel create lotuspod                    # prints the tunnel UUID
cloudflared tunnel route dns lotuspod lotuspod.example.com
# paste the UUID into deploy/cloudflared.yml (no secret belongs there —
# credentials stay in ~/.cloudflared/<uuid>.json)

lotuspod index                                        # refresh the listing
lotuspod serve --host 127.0.0.1 &                     # v2 allow-listed server
cloudflared tunnel --config deploy/cloudflared.yml run lotuspod
```

What is published is exactly what `lotuspod serve` answers with anywhere:
`index.html`, `lotuspod.css`, and artifact pages whose fail-closed
`lotuspod:visible` flag parses to exactly `true`. The tunnel adds no
exposure beyond that allow-list: `manifest.json`, `FINDINGS.md`, hidden
pages, and everything else 404 through the public hostname too, and the
ingress catch-all sends any other hostname to a bare 404.

## Tests

A standard-library `unittest` suite (no extra dependencies) pins the manifest
v2 schema and the fail-closed visibility rule across `render`, `manifest`,
`index`, and serve v2's allow-list:

```sh
python -m unittest discover
```

The suite always tests this checkout's `src/`, so an ambient `lotuspod`
install cannot shadow the code under test.

## Captures

Screenshots of the rendered pages are taken with Playwright, pinned in
`e2e/` (`@playwright/test` 1.62.1, Chromium only). The fixture
`tests.capture_site` renders a sample site into a scratch directory, serves
it on a free loopback port around one command and names its URL in
`LOTUSPOD_URL`; `e2e/playwright.config.ts` reads that as its base URL, so the
config starts no server of its own. The site trusts the test Access key in
`tests/fixtures/access/` (made for the tests only), and the fixture names an
assertion it accepts in `LOTUSPOD_TEST_ASSERTION`, for a check to send as
`Cf-Access-Jwt-Assertion`. Its answers and comments go to a database in the
scratch directory, beside the rendered site and never in it. It serves the
site's agent socket there too, with a credential for `hermes` (pull, claim,
reply, publish) and one for `claude-3f9a2c`, and publishes `capture-owned`,
a page `hermes` owns, from markdown. For an agent command it names the socket
in `LOTUSPOD_TEST_SOCKET`, the credentials' files in
`LOTUSPOD_TEST_CREDENTIAL_HERMES` and `LOTUSPOD_TEST_CREDENTIAL_OTHER`, the
site's output directory in `LOTUSPOD_TEST_OUT` and its own Python in
`LOTUSPOD_TEST_PYTHON`. The screenshots go to the directory named by
`CAPTURE_OUT`:

```sh
npm --prefix e2e ci --no-audit --no-fund
CAPTURE_OUT="$(mktemp -d)" python -m tests.capture_site \
  npm --prefix e2e exec --no -- playwright test \
  --config e2e/playwright.config.ts e2e/smoke/CAPTURE-0.capture.ts
```

The smoke spec in `e2e/smoke/` captures the index and the article page. A
ticket's own spec goes in `e2e/capture`, which stays out of git; it has to
live under `e2e/` for its `@playwright/test` import to resolve.

Browser checks run the same way, with `e2e/checks.config.ts` and the specs in
`e2e/checks/` (among them `comments.spec.ts`, which posts and reads back
comments on the fixture's comments page); `e2e/checks/policy.spec.ts` checks
the page policy in Chromium,
answering jsDelivr's Mermaid requests from the copy pinned in `e2e/`, so no
network is needed. `e2e/checks/chain.spec.ts` is the acceptance run of the
reader-to-agent story: the signed-in reader answers and comments on
`capture-owned` in Chromium, and `hermes`, through real `lotuspod comments`
and `lotuspod publish` commands, alone receives both, claims the comment,
revises the page expecting its revision and replies, which the reader sees
after a reload; a reader without the assertion stores nothing. `python -m unittest tests.test_browser_checks` runs them
and skips when `e2e/node_modules` is not installed:

```sh
python -m tests.capture_site \
  npm --prefix e2e exec --no -- playwright test --config e2e/checks.config.ts
```

## Template

`src/lotuspod/_templates/artifact.html` uses `{{placeholder}}` substitution with the context:
`title`, `kicker`, `date`, `summary_block`, `body`, `theme_name`, `theme_version`,
plus the `mermaid` section flag with its `mermaid_theme_variables` and `mermaid_dir`,
the `page_script_needed` section flag (decision forms or comment boxes) with
the `page_script` it loads, the `owner` section and its handle,
and the page `policy`, which the renderer fills in last.

## Theme

The lotus theme lives in `src/lotuspod/_theme/`: `tokens.json` is the source of truth for the
palette (dark/white/lavender: `night`, `deep_night`, `surface`, `glow`,
`lavender`, `pale_lavender`, `muted_lavender`, `white`), typography,
structural hairlines/tints (table rules, code and quote surfaces), and radii;
`lotuspod.css` mirrors the tokens as CSS custom properties. Edit the
CSS to restyle all artifacts.
