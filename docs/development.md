# Development

For people working on Lotuspod itself: the unit tests, the theme build, the
Playwright captures and browser checks, and the demo site. Back to the [README](../README.md).

## Tests

A standard-library `unittest` suite (no extra dependencies) pins the manifest
v2 schema and the fail-closed visibility rule across `render`, `manifest`,
`index`, and serve v2's allow-list:

```sh
python -m unittest discover
```

The suite always tests this checkout's `src/`, so an ambient `lotuspod`
install cannot shadow the code under test.

## Theme build

A theme script can be written in TypeScript: its source is `web/src/NAME.ts`,
and the build writes it as `src/lotuspod/_theme/js/NAME.js`, the file render
already joins in the order `THEME_SOURCES` in `cli.py` declares. `web/` is a
Bun project of its own, beside `e2e/`. The build strips each source's types
on its own with Bun's transpiler, without bundling, which also drops its
comments, and starts the file with a marker line naming the source; edit the
source, never the built file. A marked file whose source is gone is deleted,
and a JS file without the marker, written by hand, is left alone. Bun's
transpiler reads each source as a module, so the build refuses, before
writing anything, a source whose `"use strict"` it would drop or whose JS is
not a classic script (an `import` or `export`): render joins the scripts
into one classic script.

```sh
bun install --cwd web --frozen-lockfile
bun run --cwd web build
bun run --cwd web typecheck
bun run --cwd web test
bun run --cwd web check
```

`typecheck` runs the pinned TypeScript's `tsc --noEmit` on Bun's runtime, in
strict mode and with `erasableSyntaxOnly`, so a source is plain JavaScript
once its types are erased: no enums, namespaces or parameter properties.
It checks the build script and its test against Bun's types
(`web/tsconfig.json`), and the sources against the DOM's and none of Bun's
(`web/src/tsconfig.json`).
`test` runs `web/build.test.ts`. `check` builds, then fails naming each file
under `src/lotuspod/_theme/js/`, built or written by hand, that does not parse
on its own with Bun, and fails when git sees any file there modified, deleted
or new, printing what differs.

The built JS is committed, so the wheel ships it, and `pip install`, the unit
suite and the demo need neither Bun nor Node. The `theme` workflow
(`.github/workflows/theme.yml`) runs the install, `typecheck`, `test` and
`check` on every pull request and push to `main`, so a stale or hand-edited
built file fails there. Every dependency in `web/package.json` is pinned
exactly, with `web/bun.lock` committed, and `"packageManager"` pins Bun
itself. Its transpiler's output is byte-stable only within one release, so
the build refuses to run under any other Bun, naming both versions.

## Leak guard

The repository is public, and so is every pull request as it opens, so the
required `unit` check scans the lines a change adds before it runs the suite.
`ci/leak_guard.py` (standard library only) reads
`git diff --unified=0 BASE HEAD` and checks each added line of each text file;
binary files are skipped. On a pull request it scans the base commit to
`HEAD`; on a push to `main`, the commit before the push to the pushed one (or
`HEAD^` when there is no such commit in the clone).

Each rule has an id:

- `email`: an email address outside `@example.com`, `@example.org` and
  `@users.noreply.github.com`.
- `home-macos`: a path under `/Users/` that names a user.
- `home-linux`: a path under `/home/` that names a user other than the
  `writer` placeholder. A placeholder that isn't a name, such as `<user>`, or
  a path from `~/`, passes.
- `tailnet-ip`: a `100.x.y.z` address other than `100.64.0.0` and
  `100.64.0.1`.
- `tailnet-name`: a name ending in `.ts.net`.
- `private-key`: a PEM private-key header.
- `private-N`: the Nth private pattern.

The private patterns are literal values that must never be in the repository,
so they live in the repository secret `LEAK_PATTERNS`, one per line. Lines are
trimmed and blank lines ignored, and each pattern matches as a case-insensitive
substring, never a regex. Only the guard step sees the secret. Pull requests
from forks get no secrets, so only the generic rules run there.

A hit prints `PATH:LINE: RULE`, with the line's number in the new file, and
nothing from the line or the pattern: the Actions logs are public. The last
line names the range, the number of private patterns loaded and the number of
hits, and any hit fails the check.

Run it locally before pushing, with your own patterns file if you keep one:

```sh
python ci/leak_guard.py "$(git merge-base HEAD main)" HEAD
LEAK_PATTERNS="$(cat path/to/patterns)" python ci/leak_guard.py "$(git merge-base HEAD main)" HEAD
```

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
a page `hermes` owns, from markdown, and `capture-images`, from markdown with
the fixture images in `tests/fixtures/media/` beside its source, its images
stored in `lotuspod-media/` beside the site. For an agent command it names the socket
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

The smoke spec in `e2e/smoke/CAPTURE-0.capture.ts` captures the index and
the article page. `e2e/smoke/readme.capture.ts` makes the README's pictures:
it publishes the sample plan page `tests/fixtures/readme/plan.md` as
`hermes`, and at 1280 by 800 pixels comments on a section, which `hermes`
answers through real `lotuspod comments` commands, answers the page's two
decisions and comments on a passage. It writes `thread.png`, `decisions.png`
and `passage.png`, and records the three as `loop.webm`. This makes them
again in `docs/images/` (`TMPDIR=/tmp` keeps the fixture's socket path short
enough on macOS):

```sh
CAPTURE_OUT=docs/images TMPDIR=/tmp python -m tests.capture_site \
  npm --prefix e2e exec --no -- playwright test \
  --config e2e/playwright.config.ts e2e/smoke/readme.capture.ts
```

and `ffmpeg` (a capture-time tool, not a dependency) turns the recording into
the README's GIF, at 10 frames a second and 960 pixels wide, its palette made
from the recording; frames that barely differ are made exact copies, which a
GIF stores almost for free:

```sh
ffmpeg -loglevel error -y -i docs/images/loop.webm -vf "fps=10,mpdecimate=hi=64*64:lo=64*32:frac=0.5,fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" docs/images/loop.gif && rm docs/images/loop.webm
```

A ticket's own spec goes in `e2e/capture`, which stays out of git; it has
to live under `e2e/` for its `@playwright/test` import to resolve.

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
after a reload; a reader without the assertion stores nothing.
`e2e/checks/images.spec.ts` loads `capture-images` at 1280 and 360 pixels
wide with every media response held back 500 ms, and checks that each image's
natural size is its `width` and `height`, that no layout shift is recorded,
that no image is wider than its column and that a click opens the media URL.
`e2e/checks/sections.spec.ts` folds and opens the sections of
`capture-sections` by mouse, keyboard, a text fragment, a link and the
fold-all control, and checks what a reload remembers, print, and the page
without scripts.
`python -m unittest tests.test_browser_checks` runs them
and skips when `e2e/node_modules` is not installed:

```sh
python -m tests.capture_site \
  npm --prefix e2e exec --no -- playwright test --config e2e/checks.config.ts
```

## Demo

The demo site at https://lotuspod.kovial.co/ is this README and the docs
pages, plus a "Try it" page, each published with the real
`lotuspod publish --local` and turned into static files. It runs entirely in
the visitor's browser: a demo-only shim answers the page script's `/api`
requests there, so comments and answers stay in that browser, and a scripted
`demo-agent` replies from `demo/replies.json`. No server code runs.

Build it into `demo/dist/` (git ignores it), or build it into a scratch
directory and serve it on 127.0.0.1, with `/` redirected to the README's
page as the host redirects it:

```sh
python -m demo.build --out demo/dist
python -m demo.build --serve
```

The demo's browser checks are the specs in `e2e/demo/`, with
`e2e/demo.config.ts`, run in Chromium against the served site;
`python -m unittest tests.test_demo_checks` runs them, and skips when
`e2e/node_modules` is not installed:

```sh
python -m demo.build --serve -- \
  npm --prefix e2e exec --no -- playwright test --config e2e/demo.config.ts
```

`demo/wrangler.json` describes the site as a Cloudflare Workers static-assets
deploy with no script: the files in `demo/dist/`, URLs kept with their `.html`
as `serve`'s are, the custom domain lotuspod.kovial.co, and no `workers.dev`
or preview URLs. It holds no account or zone id.

The `demo` workflow (`.github/workflows/demo.yml`) deploys it on every push to
`main` that touches `README.md`, `docs/`, `src/lotuspod/` or `demo/`, and when
run by hand from the Actions tab; never on a pull request, so no branch's code
can reach the token before review. It builds with
`python -m demo.build --out demo/dist`, then runs `wrangler deploy` in
`demo/`, at the exact Wrangler version the workflow pins. Two deploys never
run at once, and a new one waits for the one in progress. Two repository
secrets reach the deploy step only:

- `CLOUDFLARE_API_TOKEN`: an account-owned API token that can edit this
  Worker, and its route on the zone if that might change.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account the Worker lives in.

The first deploy is made by hand, since creating the Worker and its custom
domain needs more than the workflow's token may do: build, then run the
workflow's pinned `npx wrangler@VERSION deploy` in `demo/`, signed in to an
account that can create Workers and write the zone's Workers routes.

## Releasing

A release takes three steps:

1. Write the version's section in `CHANGELOG.md`, headed
   `## X.Y.Z - YYYY-MM-DD`; its body becomes the release notes.
2. Set `version` in `pyproject.toml` to `X.Y.Z`.
3. Push the tag `vX.Y.Z`, made on that commit once it is on `main`:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.

The `release` workflow (`.github/workflows/release.yml`) runs on every pushed
`v*` tag, in two jobs. `build`, which may only read the repository, runs
`python ci/release_check.py "$GITHUB_REF_NAME"`, which refuses a tag that is
not `v` plus the `pyproject.toml` version or a changelog with no section for
it, and otherwise prints that section as the notes. It then runs the leak
guard from the tag's parent commit to the tag, and the unit suite, as the
`unit` check does; builds the wheel and sdist with `python -m build`; and runs
`ci/install_smoke.sh dist`, which installs the wheel into a fresh virtual
environment in a temporary directory and publishes a two-section page with
it, with `LOTUSPOD_CONFIG` naming a missing file, then checks the page and
the theme files it links are all written. A file missing from the package
data fails it there. `publish` then creates the GitHub release with the
notes and both files, and uploads them to PyPI through trusted publishing:
the job's own short-lived identity is the credential, so no PyPI token is
stored anywhere. The PyPI description is the README with every relative
image and link pointed at GitHub at the tag: before `python -m build`, the
`build` job runs `python ci/pypi_readme.py "$GITHUB_REF_NAME"`, which rewrites
`README.md` in its fresh checkout, and `ci/install_smoke.sh` refuses a wheel
whose description still has a relative target; the README itself stays
relative, so it is right on every branch and the demo, whose page policy
allows only its own images, can show it. Check a tag before pushing it, the
build in a fresh clone, since the rewrite changes `README.md`:

```sh
python ci/release_check.py v0.1.1
git clone . ../lotuspod-release && cd ../lotuspod-release
python ci/pypi_readme.py v0.1.1 && python -m build && bash ci/install_smoke.sh dist
```

Two settings are made once, by the maintainer, before the first tag:

- On PyPI, add a pending trusted publisher (a trusted publisher once the
  project exists) for the project `lotuspod`, with owner `wevial`,
  repository `lotuspod`, workflow `release.yml` and environment `pypi`.
- In the repository's settings, under Environments, create the environment
  `pypi`, which the `publish` job runs in; a required reviewer there makes
  each upload wait for approval.

A failed `publish` job can be re-run from the Actions tab without
re-tagging: it keeps a GitHub release that already exists, and skips files
PyPI already has.
