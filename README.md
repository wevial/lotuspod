# Lotuspod

Podcast artifact scaffold with a shared lotus theme. Render episode artifacts
(standalone HTML pages) from a single template, styled by one theme.

## Layout

```
lotuspod/
├── src/lotuspod/          # package + minimal CLI (`lotuspod render|manifest|index|serve`)
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
`lotuspod.css`, and artifact pages whose fail-closed `lotuspod:visible` flag
parses to exactly `true` — the same rule as `lotuspod manifest`.
`manifest.json` and `FINDINGS.md` are never served (the manifest lists
private artifact ids); requests for either return 404. Everything else
returns 404: hidden pages (rendered with
`--hidden`, a malformed flag, or no flag at all) are no longer reachable by
direct URL, and stray files, dotfiles, subdirectories, traversal attempts, and
directory listings are denied too. The allow-list is recomputed per request,
so re-rendering an artifact publishes or unpublishes it live — no restart.

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

## Template

`src/lotuspod/_templates/artifact.html` uses `{{placeholder}}` substitution with the context:
`title`, `kicker`, `date`, `summary_block`, `body`, `theme_name`, `theme_version`,
plus the `mermaid` section flag and its `mermaid_theme_variables`.

## Theme

The lotus theme lives in `src/lotuspod/_theme/`: `tokens.json` is the source of truth for the
palette (dark/white/lavender: `night`, `deep_night`, `surface`, `glow`,
`lavender`, `pale_lavender`, `muted_lavender`, `white`), typography,
structural hairlines/tints (table rules, code and quote surfaces), and radii;
`lotuspod.css` mirrors the tokens as CSS custom properties. Edit the
CSS to restyle all artifacts.
