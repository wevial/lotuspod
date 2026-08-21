# Lotuspod

Podcast artifact scaffold with a shared lotus theme. Render episode artifacts
(standalone HTML pages) from a single template, styled by one theme.

## Layout

```
lotuspod/
├── src/lotuspod/          # package + minimal CLI (`lotuspod render`)
│   ├── _templates/artifact.html   # artifact template ({{placeholder}} substitution)
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

## Template

`templates/artifact.html` uses `{{placeholder}}` substitution with the context:
`title`, `kicker`, `date`, `summary_block`, `body`, `theme_name`, `theme_version`.

## Theme

The lotus theme lives in `theme/`: `tokens.json` is the source of truth for the
palette (`pond`, `leaf`, `pad`, `petal`, `blossom`, `mist`, `ink`), typography,
and radii; `lotuspod.css` mirrors the tokens as CSS custom properties. Edit the
CSS to restyle all artifacts.
