# Lotuspod

Podcast artifact scaffold with a shared lotus theme. Render episode artifacts
(standalone HTML pages) from a single template, styled by one theme.

## Layout

```
lotuspod/
├── src/lotuspod/          # package + minimal CLI (`lotuspod render|manifest|index`)
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

## Manifest

Generate `artifacts/manifest.json`, an index of every rendered artifact in a
directory:

```sh
lotuspod manifest            # scans artifacts/ (or pass --out-dir DIR)
```

Each entry carries the artifact's file, title, episode, date, and summary,
parsed from the rendered HTML; output is sorted by filename.

## Index

Build `artifacts/index.html`, a browsable episode index linking every rendered
artifact:

```sh
lotuspod index               # scans artifacts/ (or pass --out-dir DIR)
```

Each card links to its artifact page and shows the title, episode, date, and
summary parsed from the rendered HTML; cards are sorted by filename and styled
by the lotus theme. Re-running is safe: `index.html` never lists itself (and is
skipped by `lotuspod manifest` too).

## Template

`src/lotuspod/_templates/artifact.html` uses `{{placeholder}}` substitution with the context:
`title`, `kicker`, `date`, `summary_block`, `body`, `theme_name`, `theme_version`.

## Theme

The lotus theme lives in `src/lotuspod/_theme/`: `tokens.json` is the source of truth for the
palette (dark/white/lavender: `night`, `deep_night`, `surface`, `glow`,
`lavender`, `pale_lavender`, `muted_lavender`, `white`), typography,
and radii; `lotuspod.css` mirrors the tokens as CSS custom properties. Edit the
CSS to restyle all artifacts.
