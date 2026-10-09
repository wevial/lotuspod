# Publishing pages

For people publishing pages: rendering a page from markdown or HTML,
publishing it with its images, the manifest and the index, decision tables
for the maintainer, what a page may run, and the template and theme every
page is drawn with. What readers do on a page is in
[Reading and answering pages](comments.md); the site that serves it is in
[Operating the site](operating.md). Back to the [README](../README.md).

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

A page with an outline folds each section under its heading, as on Wikipedia.
Render wraps everything from just after each section's `<h2>` to the next one
(or the end of the body) in one `<div class="artifact-section-body">` whose
`data-section` is the heading's id, after the comment boxes are placed, so a
section's box and decision forms fold with it; the intro before the first
`<h2>` is never wrapped. The page script then turns each heading's text into a
button with a caret: pressing it hides the section (`hidden="until-found"`)
and pressing it again shows it. Everything starts open; the page remembers in
the browser's `localStorage` which sections the reader folded, and a "Collapse
all" / "Expand all" control in the outline folds or opens them all. A folded
heading ends in a quiet mark of what waits in its section, part of its
button's name: "2 new" counts the comments and replies drawn into the
section's box while it was folded (after a reload, every thread already in a
folded section, since the page keeps no record of what was seen), "1 to
answer" its decision questions with no saved answer once the page has read
the answers, and both read "1 new · 1 to answer". Opening the section, however
it is opened, clears the new count; an open section has no mark. Find in
page, a text fragment, a link to a section (the outline's included) and
printing open what they need. Without the script every section shows. A body
whose section headings are not all direct children of the body (each inside
its own `<section>`, say), or with no outline, is left exactly as written;
pages published before folding stay open until republished.

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
- Images: a line that is only `![ALT](SRC)`, at the top level or in a
  blockquote, becomes a figure - a lazy `img` with the image's width and
  height, inside a link to the full image - and stops a paragraph. The
  stylesheet caps it at the column's width, its height following, so its box
  is reserved before the bytes arrive. One inside a code fence, a paragraph
  line, a list item or a table cell stays text; there are no titles and no
  `srcset`.
- Links: `[TEXT](TARGET)` becomes a link when TARGET is an `http://` or
  `https://` URL, a `#anchor`, or a relative path such as `other.md#part`
  (one that does not start with `//` and has no `:` before its first `/`,
  `?` or `#`). Any other target - `javascript:`, `data:`, `mailto:` or any
  other scheme - stays text, as does a link inside a code span or a fence.
  `.md` targets are kept as written, not rewritten to page names.
- Bare URLs: an `http://` or `https://` URL (any case) written as plain text,
  not after a letter, digit or `/`, becomes a link to itself. It runs to the
  next space, `<`, `>`, `"` or backtick; a trailing `.`, `,`, `;` or `:` is
  left out of it, and so is a trailing `)` or `]` without its partner in the
  URL, so `(see https://example.com/a).` links `https://example.com/a` while
  `https://en.wikipedia.org/wiki/Pond_(water)` keeps its `)`. Stars stay in
  it, but inside bold opened before it, it ends at its first `**`, so bold
  around a URL closes outside it. One in a code span, a fence, a link (a
  refused one included) or an image reference is not linked again.

Images, links and bare URLs are Lotuspod's own, outside the subset its
reference converter takes. Everything from a `## Concrete commands` heading
on is left out of the page, which keeps host-only commands off published
pages. Reference-style links and task lists are not converted.

With the page script, a link in the page body - from markdown or HTML alike,
and not naming a `target` of its own - opens in the same tab when it points
at the page's own site (a relative path, an `#anchor` or an absolute URL on
the same origin), and in a new tab, with `rel="noopener noreferrer"`, when
it points anywhere else. The site's address is only known in the browser,
so this is set as the page loads, not written into the HTML; a page whose
body holds any link always loads the page script for it.

`render --markdown` draws an image only from a media URL (`/media/NAME`, an
image `publish` has stored; see [Images](#images)) and refuses any other
reference, naming `publish`, which is what stores a file beside the source.

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

```sh
lotuspod publish pond-plan.md --label relos --label holophyte
```

`--label NAME` files the page under a label; repeat it for more. Each name is
lower-cased and must then be letters, digits and hyphens, starting with a
letter or digit, at most 40 characters; a name that is not is refused, naming
it, before anything is written. A name given twice is kept once, in the order
given. The page keeps its labels in a `lotuspod:labels` meta tag, the names
joined by commas (no tag when it has none), and its header's date line ends
with them as tags. A republish without `--label` keeps the page's labels, as
it keeps the summary; `--label` replaces the whole set, and `--no-labels`
clears it, so removing one label means republishing with the ones that stay.
`--label` and `--no-labels` together are a usage error (exit 2). The
responder's republish keeps the labels too.

That date is the page's created date. Every publish also stamps the page with
the time it ran, in UTC to the second (`2026-10-08T17:04:05Z`), in a
`lotuspod:updated` meta tag. The page's header reads "Created 2026-09-01 ·
Updated 2026-10-08", or "Created 2026-09-01" alone while the update falls on
the created day; both show the UTC day. A bare `render` stamps nothing.

A published page takes comments on every section (see [Comments](comments.md#comments));
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
OUT_DIR --format FORMAT --name NAME ...` with the source on standard input
(and its images with it; see [Images](#images)); the format and name are
worked out here from the file name, and every
argument after `command` is shell-quoted (`command`, default `lotuspod`, is
used as written); `--owner`, `--credential`, `--db`, each `--label` (as
`--label=NAME`, in order), `--no-labels` and `--no-comments` go
along when given, so the credential file and the database named are the writer
host's. `out_dir` is required when `host` is set. The far side's
output passes through and its exit status is `publish`'s, so a revision
conflict still exits 3. `--local` publishes on this machine regardless of the
config, and `--out-dir` without `--local` is refused while a host is set. Keep
the host's address in the local config only, never in this repository.

### Images

A markdown page shows images (see [From markdown](#from-markdown)), and an
HTML page body shows them with ordinary `img` elements:

```markdown
![Pump chart](./chart.png)
![Fish](photos/fish.jpg)
```

```html
<img src="chart.png" alt="Pump chart">
<img src="photos/fish.jpg" alt="Fish" width="40" height="30">
```

`publish` reads each image a page references relative to its source file's
directory - or to `--base DIR` when given - and checks every one before
anything is written. A source on standard input has no directory of its own:
one with a local image reference needs `--base`, and is refused naming
`--base` without it:

```sh
lotuspod publish - --format markdown --name pond --base ~/notes < ~/notes/pond.md
```

An image is accepted only when its first bytes are a PNG, JPEG, WebP
or GIF and its extension (`.png`, `.jpg` or `.jpeg`, `.webp`, `.gif`) names
that same type, and only within the size cap. Under the publish lock each is
stored in `lotuspod-media/` beside the artifacts directory, as the lower-case
hex SHA-256 of its bytes plus its type's extension (so one image stored twice
is one file), and each reference is rewritten to that media URL, in the page
and in the kept `NAME.md` or `NAME.body.html` alike - so a republish of the
kept source (an agent's pull, edit and publish) needs no local files. The media directory is
never inside the artifacts directory, which publish commits whole: no image
reaches the artifacts repository. The page draws each image at its intrinsic
width and height, read from the file's header; a JPEG whose EXIF orientation
turns it a quarter has the two swapped, as browsers draw it.

In an HTML source only the `img` elements' attributes change: `src` becomes
the media URL, and an `img` with a media URL gets `loading="lazy"` when it
has no `loading`, and its intrinsic `width` and `height` when it has neither
(an author's own are kept). Everything else stays as written, and the kept
`NAME.body.html` is the source so rewritten.

Over ssh, the images are read and checked on the sending machine, and the
references rewritten there. When at least one image is to be sent, the far
command gains `--source-archive` and standard input is one uncompressed POSIX
tar (`tar -tvf` lists it): a member `source`, the rewritten source, and one
member `media/NAME` per image, under its stored name. A page with no image to
send - none at all, or only media URLs - goes as its bytes with no
`--source-archive`, as before. `--base` is read on the sending machine and
never sent. The writer host trusts nothing in the archive: it reads it as a
stream and extracts nothing by name, takes only regular files named `source`
(once) or `media/` and a stored name, and checks each image again - its
SHA-256 must be its name, its type the one its extension names, its size
within the writer host's own `max_image_bytes` (read from its header before
its bytes), and the source must refer to it; and every media URL in the
source must be in the archive or already stored. A link, a directory, any
other name, a repeated name, a PAX or GNU extension header, or an archive
cut short is refused the same way, naming the member.

The cap is 10 MiB unless the config sets another:

```ini
[media]
max_image_bytes = 10485760
```

A reference is either a path inside the source's directory or a media URL
naming an image already stored. Anything else makes `publish` exit 1 with one
line naming the reference and why, writing nothing - no page, no kept
source, no media file, no commit:

- a missing file, or one that is not a regular file;
- SVG (it can carry script), any other type, an extension naming another
  type than the file holds, a file cut short, or one over the cap;
- a path that climbs out of the source's directory or is absolute, including
  a symbolic link that points outside it;
- a remote or inline image (`https:`, `http:`, `data:`, `//host`): the page
  policy's `img-src 'self' data:` would block it in the reader's browser, and
  readers' browsers never fetch third-party URLs from behind the Access gate;
- a local file referenced from a source on standard input without `--base`;
- a `srcset` on an `img` or `source` element, which would name images
  publish never sees;
- a media URL naming no stored image.

Over ssh, a reference refused on the sending machine is refused before ssh
runs. Media in `backup` and `restore`, CSS `url()` in an HTML source and
`picture` without `srcset` are not handled yet.

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
`date`, `created`, `updated`, `summary`, `visible` and `labels`; fields with no
value are empty strings, never `null`. Beside the keys shown above, an entry
carries `created`, the same value as `date` (the page's first date);
`updated`, for example `"2026-10-08T17:04:05Z"`: the time its last publish
stamped (see [Publish a page](#publish-a-page)); and `labels`, the page's
labels in its order, for example `["relos"]`, or `[]` when it has none. A page published before publish stamped it takes,
when the directory is the top of its own git repository, the time of the
newest commit that touched it, read from one `git log`; anywhere else, or with
no such commit, its created date. Entries are sorted by `updated`, newest
first, with the file name breaking ties.

Visibility is fail-closed: an artifact is listed only when its
`lotuspod:visible` meta flag is present and exactly `true`. Artifacts rendered
with `--hidden`, with a malformed flag value, or without any flag (pre-v2
pages) are excluded — re-render them with this version to publish. The flag
governs listings, and `lotuspod serve` v2 enforces it over HTTP too (hidden
pages 404 even by direct URL); opening the file on disk still works.

## Versions

When the output directory is the top of its own git repository, every
publish is a commit there, so every commit that changed `NAME.html` is a
version of the page. `lotuspod serve` reads them at request time, from one
`git log` over the page and one `git cat-file --batch` for the versions it
has not read before; nothing new is stored. Only versions whose own
`lotuspod:visible` was true are listed, newest first, at most 200. A
directory that is not the top of its own repository has none.

A published page's header ends its date line in a "Versions · N" link to
`#versions`, which shows the page's versions in place of its body: each with
its date and time, the current one marked "current", and every other with a
"View" link. The list shows 20, and "Show older versions" shows 20 more. A
page with one version says "This is the only version.", and one in a
directory that is not a repository shows "Versions · 0" and says "This page
has no versions yet." The page asks
`GET /api/versions?page=NAME` (see [Reading and answering
pages](comments.md#answers-and-comments)) once as it loads; when it answers
anything but 200, as on the demo, there is no link and no view.

"View" opens `NAME.html?version=COMMIT`, that version read-only, for a
reader whose Access assertion verifies as on `/api`. It answers 404 unless
the page is served now and COMMIT, its 40 hex characters, is one of the
page's listed versions, so it never reads another file. The version is
served as it was published, under a banner saying it is an earlier version,
from when, and how many versions behind the current one it is, with links
"All versions" and "Back to current". Its decision forms are disabled, its
comment boxes hidden, and a `Content-Security-Policy` header of
`script-src 'none'; form-action 'none'` keeps any of its scripts, a Mermaid
diagram's included, and its forms from running: comments and answers stay
on the current page. It is sent with `Cache-Control: private, no-store`. Any
other query on a page is served as the page.

A page the reader last opened at an older revision says what changed since.
The page's post to `/api/seen` answers the revision they opened it at before
(`previous`); when that is not the page's own, the page asks
`GET /api/changes?page=NAME&since=REV`, which compares the newest listed
version carrying that revision with the current one in at most three git
processes. Each version's body is split into sections at its `h2` headings,
known by id, or by the id the outline would give its words when it has none
(a page left with one heading), together with those words, and their text compared with whitespace
collapsed, a block's tags taken as a space and an inline element's as
nothing, so a change to markup alone, such as a line break between two
blocks, words wrapped in `<strong>` or a decision form's version hash, does
not count; text before the first heading, or a body with none, is one
section, "The page text", whose link goes to the start of the body. A renamed heading reads as one section removed and one added.

The page then opens with a "What changed since you last looked" box under
its header: "You last opened this on DATE · K versions ago", DATE being when
that version was published, then one line per section changed, new or
removed, each changed or new one a link to its section, whose heading carries
a "changed" or "new" tag. "See the full diff" opens the versions view, where
a pane beside the list, headed "DATE → current", shows a line diff of the
markdown source when both versions kept `NAME.md`, at most 400 lines and then
"More changes not shown.". A page with no kept source for that version, as
one published before sources were kept, or from HTML, compares by section
instead. The list marks that version "you last looked". "Dismiss" removes the
box until the next load; the next load is seen at the page's own revision,
so the box and the tags are gone. A first visit, a reader signed out, or any
failure shows no box and no pane.

## Index

Build `artifacts/index.html`, a browsable index linking every rendered page:

```sh
lotuspod index               # scans artifacts/ (or pass --out-dir DIR)
```

The listing is a table: one row per page, with its title (linking to the
page) and its labels as small tags under it, created and updated dates, and
summary, as `lotuspod manifest` records them. Each row names its page in
`data-page`, and a labelled row carries its labels in `data-labels`, joined by
commas. Only fail-closed-visible artifacts are listed
(same rule as `lotuspod manifest`).
Rows arrive newest update first, the file name breaking ties, and are styled
by the lotus theme. Re-running is
safe: `index.html` never lists itself (and is skipped by `lotuspod manifest`
too).

Click a column header to sort by it (a second click reverses; the Updated
column starts sorted newest first, so its first click shows the oldest first.
A date column sorts by its full time, not the day it shows, and rows with a
blank value in the sorted column sink
to the bottom either way), and type in the search box to filter rows down to
those matching the query in any column, labels included.

When at least one listed page has a label, a "Labels ▾" menu sits beside the
search: a checkbox per label, A to Z, each with the number of pages carrying
it. Checking labels keeps the pages carrying any of them, and the search
applies on top; the button reads "Labels (N) ▾" while N are checked, and
Escape or a click outside closes the menu. A line under the filter row then
reads "Showing" and one token per checked label, "relos ✕", which unchecks it.
The count reads "M pages, newest update first" in the arrival order, and "N of
M pages" while filtered; when no row is left, the table gives way to "No pages
match these filters." The table stays one flat list in its sort order.

Signed in to `lotuspod serve`, the index asks `/api/seen` (see [Answers and
comments](comments.md#answers-and-comments)) which pages this reader has
opened, and at what revision, once on load and again when the browser brings
the index back from its back-forward cache. A page republished since this
reader last opened it, on any device, gets a small "updated" mark beside its
title; a page they have never opened gets none. An "Updated · N" toggle, N
the marked pages, sits after the Labels menu: pressed (`aria-pressed`), it
keeps only the marked rows and adds the token "updated ✕" to the "Showing"
line, which releases it; the Labels menu and the search still apply on top.
When the route answers anything but 200 (signed out, or the demo site, whose
stand-in answers 404), there are no marks and no toggle.

Sorting, the search, the Labels menu and the marks are progressive enhancement from a
script inlined in `index.html` — no extra file to serve — so with scripting off
the page is still the complete listing, just unsorted and unfiltered (the search
box and the menu stay hidden rather than offering a control that cannot
filter).

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
`Question` column. A page may hold several decisions tables, each under its
own heading, so a question can sit in the section it is about. The pass
works on the body's HTML, so a markdown page and an HTML one alike get it.
`#`, `Options` and `Default` columns are optional; any other column is shown
under its question as context.

A `Context` column (any case) is for what the question needs explaining, so
the Question cell stays short:

```markdown
| # | Question | Context | Options | Default |
| --- | --- | --- | --- | --- |
| 1 | Which model replies? | Replies run on every comment; see [the costs](costs.html). | Sonnet / Opus | Sonnet |
| 2 | Keep the archive? | | Yes / No | Yes |
```

Its text shows directly under the question, with no label, and wraps to the
card's width; inline markdown in it (links, emphasis, code) is kept, so a
link stays a link. An empty cell shows nothing. Any other context column
follows it, in the table's order, as "LABEL: text" (a `Why it matters` column
reads "Why it matters: …"), and then the "Default:" line. A question's
context is not part of its version: editing it leaves the answers given to
the question as they are. Agents read the same lines with the question (see
[Agents](agents.md)).

Each row becomes a `form.artifact-decision` with one radio button per option,
a note folded behind "Add a note" and a "Save answer" button. Its question id
is `decision-` and the slug of its `#` cell, or `decision-N` by row number
without a `#` column. Options are the `Options` cell split on ` / `, each
keyed by its slug; the one matching the `Default` cell carries a quiet
"· default" mark, and none is pre-selected. With a `Default` but no `Options`
column, a row offers "Accept the default" (`accept`) and "Something else"
(`other`) and shows the default's text as "Default:", which is what "Accept
the default" accepts. A table with any row of fewer than two options is left
exactly as written, and the page then loads no script.

Each form carries `data-version`, a short hash of its question's text and its
options' labels. Rewording a question changes its version, so answers given
to the old wording are not attached to the new words: the answers route
refuses a stale version (409), and the page shows an old answer as given "to
an earlier wording" without filling the form from it.

Each question is drawn as an inline card with a quiet rule down its left
edge, its options one under another as radio rows. An unanswered card reads
"Not answered yet". While the picked option or the note differs from the
saved answer, the rule turns lavender and "Not saved" shows beside "Save
answer"; a failed save keeps both and says why. A saved answer folds the card
under its question to "✓ Saved · LABEL · change", then the note, then the
reader and the time, with "replaced an earlier answer" when it superseded
one. "change" opens the card again with the saved option picked and the note
filled. An answer to an earlier wording leaves the card open and unpicked,
with the line "Answered to an earlier wording by READER, TIME".

On a page that takes comments (one with at least one comment box), each card
also has "Ask" beside "Save answer", for a question about the decision rather
than an answer to it. It posts the note's text, trimmed, as a thread on the
decision (`{page, question, text, revision}`, see [Answers and
comments](comments.md#answers-and-comments)) and saves no answer, so the
decision stays unanswered; the note is emptied and folded once the question
is sent, so it is never saved as the answer's note later. With an empty note
it sends nothing and says "Write your question in the note, then press Ask."
A page published again since it loaded keeps the note and says to reload it,
and a reader who is signed out is told so as an answer would be. The thread
opens in the comments panel, a popover or the bottom sheet, as the window
allows, and is answered there as any thread is. While the decision has
threads, a chip under its card reads where they stand as a section's chip
does ("1 comment · waiting", "HANDLE is writing…", "1 reply · ✓ HANDLE
answered"), or "N resolved" once every one is resolved, and opens its newest
open thread (see [The comments panel](comments.md#the-comments-panel)). Ask
sits in the card's foot, so a folded card shows it again after "change"; the
chip stays under a folded card. Both are drawn by the page script, so a page
published before them gets them without publishing it again.

Once any of its decisions is answered, the page ends in a table captioned
"Answered", after its last section, drawn by the page script from the
answers serve keeps. It has one row per answered question, newest first, with
the columns `# | When | Question | Answer | By`: the current answer's label
with its note under it, the reader and the time as the card shows them. A
question the page still asks in the same words takes its number, question and
label from its card, and its row has a "change" that opens the card's section
if it is folded and opens the card as the card's own "change" does. A
question the page no longer asks, or asks in other words, keeps its row in
the words it was answered in, without "change". So a page whose decisions
table was taken out after it was answered still shows its answers, as long as
it has a decision form or a comment box to name the page. An author writes no
answers section: the table is the record. One written by hand on an older
page stays as written.

A page with such forms loads the site's page script, `lotuspod-page.js`,
which serve answers beside `lotuspod.css`. It reads the page's answers, folds
each question answered as the page now asks it, and shows a collapsed list of
earlier answers. Answering again keeps the earlier answer as history. A page
published before the cards (an "Answer" button and a note always open) still
saves and folds. The script sends no credential of its own: the reader's Access
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

## Checklist for the maintainer

When the maintainer has a list to go through, each item on or off, a
checklist asks it as one decision about the list rather than one question
per item:

```markdown
## Emails

### Checklist for the maintainer

| # | Item | Default |
| --- | --- | --- |
| w | Welcome | on |
| d | Digest | off |
| r | Reminder | on |
```

The table taken is the first one after an h2 or h3 whose text is "Checklist
for the maintainer" (any case), before the next h2 or the next decisions or
checklist heading, whose header row has an `Item` column. A page may hold
several, each under its own heading, beside its decisions tables.

Each such table becomes one `form.artifact-decision.artifact-decision--checklist`
inside `div.artifact-decisions`, with a checkbox per row, checked when its
`Default` is `on` (any case), the row's `Item` as its label, and the
decision form's foot: "Add a note", "Save answer" and where it stands. Its
question id is `checklist-N`, by the checklist's order on the page, and its
legend the text of the nearest h2 above its heading (the heading's own text
when it is an h2). Each item's id is the slug of its `#` cell, or its row
number without a `#` column, made unique within the table. Its answer is
the set of items checked, stored, kept as history and superseded as a
decision's answer is (see [Answers and
comments](comments.md#answers-and-comments)).

Its `data-version` is a short hash of the legend's text and each item's id,
label and default. Rewording an item, adding or removing one, changing a
default or renaming the h2 changes it, so earlier answers are stranded as a
reworded decision's are, and the items an answer changed are always read
against the defaults it was given against.

The table is left exactly as written, and makes no form, when it has no body
rows, a row with an empty `Item` cell, a `Default` other than `on` or `off`,
any column other than `#`, `Item` and `Default`, a column named twice, or a
row with more cells than the header.

An answer's words are kept with it: its question is the legend, and its label
the items changed from their defaults, "On: LABEL, LABEL · Off: LABEL" (either
part left out when empty) or "No change from the defaults". `lotuspod answers
PAGE` prints each answer by those words, read against the page's form while
it asks the checklist at the answer's version, else as they were kept.

The page script draws a checklist as it draws a decision's card, its items
one under another as checkbox rows, each preset to its default (or to the
saved answer), with one "Save answer" for the whole list. The reader toggles
any items and saves once; saving the list untouched is an answer too, that
nothing changes. An unanswered checklist at its defaults reads "Not answered
yet", and "Not saved" shows while the items checked differ from the saved
answer's (from the defaults while there is none) or the note differs from
its note. A saved answer folds the card to "✓ Saved · SUMMARY · change", where
SUMMARY is the answer's label above: the items changed from their defaults,
by their labels in the page's order. "change" opens the card again with the
saved items checked, the first of them focused, and the note filled. The
earlier answers list each by the same summary, and an answer to an earlier
wording leaves the card open at its defaults with the line "Answered to an
earlier wording by READER, TIME", as a decision's does.

In the "Answered" table a saved checklist is one row, with an empty `#`, the
legend as its Question and the summary as its Answer, the note under it. Its
"change" opens the card as the card's own does.

## What a page may run

Every artifact page carries a Content-Security-Policy meta tag at the top of
its head, computed from the finished page so it never allows more than the
page holds. A page runs only the site's own script files, the pinned Mermaid
(`https://cdn.jsdelivr.net/npm/mermaid@11.4.1/`, allowed only on a page with a
diagram) and the inline scripts the page template writes, each allowed by its
`sha256` hash; today that is the Mermaid start-up module alone. A page with
decision forms, comment boxes or folding sections also loads the site's page
script, `lotuspod-page.js`. Styles may be
inline, since Mermaid sets them so; images come from the site or `data:`
URLs; plugins, `<base>` and forms posting elsewhere are refused.

A script written into a page body is never hashed, so it does not run, and
neither does an inline event handler such as `onclick`. `render` and
`publish` still publish the page and print one line naming it and how many
scripts will not run. Serve adds `Content-Security-Policy: frame-ancestors
'none'` and `X-Content-Type-Options: nosniff` to every page it answers, so
no other site can frame a page.

## Template

`src/lotuspod/_templates/artifact.html` uses `{{placeholder}}` substitution with the context:
`title`, `kicker`, `date`, `summary_block`, `body`, `theme_name`, `theme_hash`,
plus the `mermaid` section flag with its `mermaid_theme_variables` and `mermaid_dir`,
the `page_script_needed` section flag (decision forms, comment boxes or folding
sections) with
the `page_script` it loads, the `owner` section and its handle,
and the page `policy`, which the renderer fills in last.

## Theme

The lotus theme lives in `src/lotuspod/_theme/`: `tokens.json` is the source of truth for the
palette (dark/white/lavender: `night`, `deep_night`, `surface`, `glow`,
`lavender`, `pale_lavender`, `muted_lavender`, `white`), typography,
structural hairlines/tints (table rules, code and quote surfaces), and radii;
`lotuspod.css` mirrors the tokens as CSS custom properties (a `colors` key
`k` as `--color-k`, a `structure` key `k` as `--k`, underscores as dashes).
Edit the CSS to restyle all artifacts.
A feature's CSS goes in its own file in `src/lotuspod/_theme/css/` and its JS in
`src/lotuspod/_theme/js/`, and each new file takes one line in the declared
order (`THEME_SOURCES` in `cli.py`), which render joins into the one
`lotuspod.css` and `lotuspod-page.js` it serves.
Pages address the stylesheet and page script by a hash of the theme files, so
there is no version to raise.

Lavender is the brand: the buttons, the focus outline and the
agents. Beside it, one colour per job:

- **Sky**, for what a reader can follow or copy: `sky` for body links,
  underlined in `link_line`; `pale_sky` for a link on hover, inline code on
  its `code_chip`, and table header text on the `header_tint` band above its
  `header_rule`. A code block's border is `code_edge`; a blockquote sits on
  `quote_band` behind a 3-pixel `quote_rule` on its left.
- **Rose**, for what is the reader's own: their bubble on `reader_tint` inside
  a `reader_line` border, their avatar on `reader_avatar` with a `rose` ring
  and `pale_rose` letters, and their name in `pale_rose`. `highlight` and
  `highlight_line` are a passage highlight and its underline.
- **Mint** for a saved answer's check, and **amber** for waiting: the dots of
  a typing bubble, and a decision card's "Not saved", its ring and its left
  rule.

`tests/test_palette.py` checks every text colour at 4.5:1 or more on `night`
and `surface`, and text on the tints.

A top-level table keeps the reading layout's width and scrolls inside itself
when it is wider. Where the window has at least 4rem of free width beside such
a table, a small Expand button under its left edge widens it to the right, to
its natural width or up to 1rem short of the comments panel, without moving
anything above or beside it; Collapse restores it. The choice is kept per
table for the tab's session (`sessionStorage`), so a new visit starts at the
reading width, and the button hides while the window leaves no room for it.
