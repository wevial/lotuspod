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

Pass `--hidden` to mark an artifact not visible: it carries a
`lotuspod:visible: false` flag and is excluded from `manifest.json` and
`index.html`. Re-render without `--hidden` to publish it.

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

Each card links to its artifact page and shows the title, episode, date, and
summary parsed from the rendered HTML; only fail-closed-visible artifacts are
listed (same rule as `lotuspod manifest`). Cards are sorted by filename and
styled by the lotus theme. Re-running is safe: `index.html` never lists itself
(and is skipped by `lotuspod manifest` too).

## Serve

Share rendered episodes over your tailnet:

```sh
lotuspod serve               # serves artifacts/ (or pass --out-dir DIR)
lotuspod serve --port 8080   # pick a different port (default: 8000)
```

The command detects this node's tailnet IPv4 (`tailscale ip -4`) and listens
only on that address, so your podcast pages are reachable from the other
devices in your tailnet — and nothing outside it. Open the printed
`http://100.x.y.z:8000/` URL on any tailnet device; `/` serves
`artifacts/index.html` (build it first with `lotuspod index`). Requires a
running `tailscaled`; without a tailnet address it exits with an error.

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
`title`, `kicker`, `date`, `summary_block`, `body`, `theme_name`, `theme_version`.

## Theme

The lotus theme lives in `src/lotuspod/_theme/`: `tokens.json` is the source of truth for the
palette (dark/white/lavender: `night`, `deep_night`, `surface`, `glow`,
`lavender`, `pale_lavender`, `muted_lavender`, `white`), typography,
and radii; `lotuspod.css` mirrors the tokens as CSS custom properties. Edit the
CSS to restyle all artifacts.
