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

`ci/run_modules.py` (standard library only) runs the same tests module by
module, each `tests/**/test_*.py` as `python -m unittest DOTTED` in its own
process, several at a time, and can run one shard of them:

```sh
python ci/run_modules.py --jobs 4
python ci/run_modules.py --jobs 4 --shard 1/2 --max-module-sec 150
python ci/run_modules.py tests/test_ci_workflow.py 'features/serve/*'
```

The required `unit` check runs it in two shards of four, one runner each,
beside the leak guard; a gate job named `unit` passes only when the guard and
both shards pass. A module fails the run when it fails, runs zero tests, is
killed at `--module-timeout` (default 300 seconds) or finishes past
`--max-module-sec`, and the last line names each failed module. Shards are
balanced by the seconds `tests/module_times.json` records, longest first; a
module it does not record counts as the median. `--list` prints a shard's
modules without running them, and `--record PATH` writes each module's
seconds in that file's shape, to refresh it by hand.

## Theme build

A theme script can be written in TypeScript: its source is a slice's
`src/lotuspod/features/SLICE/ts/NAME.ts`, and the build writes it beside
itself as `NAME.js`.
That is the file render
already joins at the slot its slice's `theme_parts.json` declares. `web/` is a
Bun project of its own, beside `e2e/`. The build strips each source's types
on its own with Bun's transpiler, without bundling, which also drops its
comments, and starts the file with a marker line naming the source; edit the
source, never the built file. A marked file whose source is gone is deleted,
and a JS file without the marker, written by hand, is left alone. Bun's
transpiler reads each source as a module, so the build refuses, before
writing anything, a source whose `"use strict"` it would drop or whose JS is
not a classic script (an `import` or `export`): render joins the scripts
into one classic script.

A page source written in TypeScript (`features/live/ts/page-swap.ts`) runs inside the
page script's shared closure, so it calls the closure's names (`live`,
`element()`, `all()`, `json()`, `linkTab()`, `foldSection`, `SWAPPED`)
directly. Their types are declared once, in `core/ts/page-closure.d.ts`, with
the source that defines each, and so is the detail of a page event such a
source sends. Its own top-level names join the closure's too, so each must be
one no other source uses: a duplicate `const` or `let` breaks the whole page
script.

The page's islands, widgets written in Preact, are the one bundle: the build
bundles the comments slice's `src/lotuspod/features/comments/ts/islands/main.tsx`
with its imports and Preact (pinned in `web/package.json` as a dependency,
and resolved from `web/node_modules`) with `Bun.build` into
`src/lotuspod/features/comments/ts/islands.js`, after its marker line, as one minified
IIFE for the browser with no source map, JSX through Preact's automatic
runtime. The comments slice's `theme_parts.json` slots it directly after comment-markdown.js inside
the shared closure: comments start before later sources find the panel and register
their listeners, and never on a pod that goes to the index
(`features/publish/ts/open-in-tabs.js`). Neither the index script nor the old-version script
has it. The islands reach the legacy page only through
`features/comments/ts/islands/bridge.ts`, the one module that names the closure's
variables: it declares the types of `live` (`js/live-page.js`), `forms` and
`answering`, the decision forms and what reads and saves them
(`js/decisions.js`), `linkedTo()`, `ARCHIVED` and the page events
`ANSWERED`, `SAVED` and `DRAWN` (`features/publish/ts/page-open.js`), and exports one object,
`page`, built from them as the bundle loads, so a name that does not exist
throws on every page at once. A minifier never renames a free name, so the
bridge's reads stay the closure's own. An island imports `page`, never the
names. `main.tsx` mounts each island it lists, handing it `page`.

The first island is the review sheet (`features/comments/ts/islands/review-sheet.tsx`):
the title bar's open-question count and Next open, the "N open" marks on
headings and outline links, and the Respond panel. Once `ANSWERED` is first
sent, and only when `answering.read` is true and the page is not archived, it
renders into a `div.artifact-review-bar` it adds to the title bar, with the
panel and each mark as a portal: the panel into the body, each mark into an
empty span it adds to the heading or outline link, so the heading the fold
code owns is never drawn again. Once drawn, it is drawn again, into the same
container, on each `ANSWERED` a swap's read of the answers sends
(`features/live/ts/page-swap.ts`): it reads the questions from the forms again, gives
a heading that now asks one its span and takes them off one that no longer
does, and picks a default only on a form the swap brought in. A form a
swap brings in whose read fails stays out of the sheet until a later read. The forms and their stored answers stay the
truth: the sheet draws from them on each form's `input`, `change` and
`SAVED`, a pick in the panel sets the form's own input, and it saves through
`answering.save()`, one question at a time in page order. Preact holds only
the sheet's own state: the panel open, a Save under way, what it did, and
the question Next open last jumped to, which a swap keeps. The bundle, Preact with it, stays at most
47,000 bytes gzipped; it uses Preact and its hooks, with `createPortal` from
`preact/compat` for independently owned DOM targets.

The comments island (`features/comments/ts/islands/comments/index.ts`) mounts after the
review sheet and starts the page itself as it mounts, on a page with comment
boxes: it reads the boxes, adds the whole page's box (`pageBox`) and starts
the drafts part (`comments/drafts.ts`), which creates the store
(`comments/store.ts`). The store holds the thread state: the sections,
boxes' forms, threads and attachments by form, all Maps, and the revision the
page shows, which a swap moves on. It adds a thread or merges what a read
brings (true when anything was drawn), keeps the list at the end of the body
for sections the page no longer has, and reads `/api/comments` while a thread
waits or one is in view, each gap half again as long as the last, from 3 up to
30 seconds; at once on a tick from serve's stream or when the page is seen
again, never once signed out. Each read settles the image cap, tells
`live.seen` its revision, draws the parts, then gives back what was kept over
a reload, then, the first time, opens a `#thread=ID` link. Once the first
read has ended (answered or failed) and drawn the chips, the store sets
`data-lotuspod-comments-read` on the root element, which the composer checks
wait for; the draw after `SLOW_MS` does not set it. The store creates
the thread, composer, passages and placement parts and hands them its state
directly; its start draws the passages and the panel, arranges them and makes
the first read. The store also creates the replies part
(`comments/unread.ts`), which keeps the replies to the reader: the ids each
read names `unread`, each thread's seen mark and the comments unread as it
opened. It counts them for the shell, rows and chips, draws the tab title's
"(N)" and the header's "N new replies to you", and, when the list opens a
thread (`looked`), posts `/api/seen` with `page`, `thread` and `comment`; a
route that names no `unread` (signed out, the demo) marks nothing and posts
nothing. It gives each decision form its Ask, which posts the note to
`/api/comments` as a question thread with `page`, `question`, `text` and
`revision`, empties and folds the note unless it changed while sending, adds
the thread and opens it (`asked`), and on `SAVED` with a comment reads the
threads at once. The drafts part keeps what is unsent over a reload
(`live.keep`, `live.kept`, `live.place`): each composer's text and images,
what was open and a passage composer's words, and the live block a
section's form is on (the composer's `on`), which opens the form on it again
(the store's `holdOn`); text whose place a new
revision dropped goes to a section's form with `PLACE_GONE`,
`PASSAGE_GONE` or `BLOCK_GONE` beside it. It handles `SWAPPED`, remounting the boxes a swap
replaced, took away or added with their threads, forms and decision forms,
and registers the `holdSwap` test that holds back a section whose form holds
unsent text or whose words the open passage composer quotes. One map,
`takenAt`, keeps the index a section had when a swap first took it away, for
both paths. It reaches the threads through the store (`refresh`, `retitle`,
`askAbout` for a swap's decision forms, the composer handles, the Maps); the
store reaches its `restore` and `boxWith` through its bridge. The bridge
supplies `holdSwap`, `PLACE_GONE`, `PASSAGE_GONE`, `BLOCK_GONE`, `BLOCK_CHANGED`,
`STALE_BLOCK`, `settleImageCap`,
`NO_CAP`, `CHANGED`, `NO_QUESTION`, `STALE_QUESTION`, `imageWords` and
`all`, and types `SWAPPED`'s and `SAVED`'s detail.
Placement creates the shell, thread-list and chips parts.
The shell draws the panel frame, rail, tally and start controls. The thread-list
part draws section groups, changed-section threads, entry heads and resolution
controls. Its typed bridge reads the page's thread objects and passage helpers;
the store owns thread containers and the drafts part owns drafts. The thread part
(`comments/thread.tsx`) owns each list’s rows, notices, typing bubble and unread
marks. Its typed bridge reads unread state and checking, and supplies the shared
markdown, image and time helpers. Stable keyed comments keep their first row
snapshot; ref callbacks attach markdown and images once. Status keys replace
only changed marks, and synchronous renders preserve live-region row identity.
The placement part owns panel, popover and sheet selection, resize focus preservation, and the
reload and swap hooks. Its bridge reads the live boxes and thread stores and hands
`narrow.js` a typed object; narrow.js still draws the popover and sheet. Movable
entries, group toggles and form holders are independent render roots, so narrow.js
can move them without Preact moving them back. Synchronous renders preserve
immediate layout reads. Entry leads and status words retain separate redraw keys.
On resize, placement takes the open view before changing modes, suppresses
thread opening and closing while moving it, then restores the focused field.
Across swaps, it reads the page-owned boxes and sections map to find replacement
anchors; the drafts part owns drafts and `features/live/ts/page-swap.ts` the swap itself.
The chips part (`comments/chips.tsx`) draws section, whole-page and decision
chips synchronously. Served summaries are emptied once before rendering; decision
buttons are independent roots after their forms. A keyed line replaces changed
status text together, preserving the chip’s layout-shift behavior. It wires served summaries and
box toggles with listeners and delegates opening to placement. Its bridge reads
thread and unread state, list status helpers and thread author helpers. A typed
anchor switch selects each thread's chip, with passages counted on their section.
Swaps mount new boxes and forget removed decision forms through the part.
The composer part (`comments/composer.tsx`) draws reply controls and passage
composers and wires the served section forms without redrawing them. All three
use one send path for attachments, Cmd/Ctrl+Enter, posting and refusal status.
Its bridge supplies attachments and status words, the current revision and box,
and the page's thread and placement callbacks. Reply siblings use a portal;
passage holders are movable render roots. Textareas remain uncontrolled so drafts
can read and restore their values directly. Section and passage posts expose
their pending promises to swaps.
The passages part (`comments/passages.tsx`) owns selection validation, the Comment
pill and its shortcut, passage highlights and numbering, hover lighting, and
finding words again after a swap. It reads passage quotes through the typed anchor.
The bridge supplies the text-model helpers and passage constants; highlights wrap
and unwrap author text imperatively, while the pill alone renders through a portal
into the body. The composer part draws the movable passage composer. The drafts
part calls the part's writing, reopen, swept, moved and writes handles for drafts
and swaps; moved still runs before swaps replace the boxes.
`comments/anchor.ts` interprets each first comment as a page, section, passage or
decision anchor. Mark, words and rank each exhaustively handle that union, so a
future kind must be handled in all three places and in placement's exhaustive
anchor-to-element switch. The bridge also supplies `CLOSED`,
`PANEL`, `RESOLVED_SHOWN` and `WHOLE_PAGE`; the shell keeps storage and listbox
state and calls page hooks to compose or refresh threads.

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
(`web/tsconfig.json`), the sources against the DOM's and none of Bun's
(`src/lotuspod/core/ts/tsconfig.json`, which takes in the slices' `ts/` sources), and the islands, modules with imports and JSX
whose `jsxImportSource` is `preact`, under their own config
(`src/lotuspod/features/comments/ts/islands/tsconfig.json`, which finds
Preact in `web/node_modules`).
`test` runs `web/build.test.ts`. `check` builds, then fails naming each file
under a slice's `ts/`, built or written by hand, that does not parse
on its own with Bun, and fails when git sees any JS file there modified, deleted
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
required `unit` check scans the lines a change adds, in a `leak-guard` job of
its own beside the suite's two shards.
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

`e2e/smoke/socket-pull.capture.ts` captures a reader's comment after verifying
that Hermes receives it through a real socket pull. It writes
`01-reader-comment-pulled.png`; the catalog unit tests separately verify
the page-list read counts. Run it from the repository root:

```sh
CAPTURE_OUT="$(mktemp -d)" .venv/bin/python -m tests.capture_site \
  e2e/node_modules/.bin/playwright test \
  --config e2e/playwright.config.ts socket-pull.capture.ts
```

Browser checks run the same way, with `e2e/checks.config.ts` and the specs in
`e2e/checks/` (among them `comments.spec.ts`, which posts and reads back
comments on the fixture's comments page); `e2e/checks/features/publish/policy.spec.ts` checks
the page policy in Chromium,
answering jsDelivr's Mermaid requests from the copy pinned in `e2e/`, so no
network is needed. `e2e/checks/chain.spec.ts` is the acceptance run of the
reader-to-agent story: the signed-in reader answers and comments on
`capture-owned` in Chromium, and `hermes`, through real `lotuspod comments`
and `lotuspod publish` commands, alone receives both, claims the comment,
revises the page expecting its revision and replies, which the reader sees
after a reload; a reader without the assertion stores nothing.
`e2e/checks/features/publish/images.spec.ts` loads `capture-images` at 1280 and 360 pixels
wide with every media response held back 500 ms, and checks that each image's
natural size is its `width` and `height`, that no layout shift is recorded,
that no image is wider than its column and that a click opens the media URL.
`e2e/checks/features/publish/sections.spec.ts` folds and opens the sections of
`capture-sections` by mouse, keyboard, a text fragment, a link and the
fold-all control, and checks what a reload remembers, print, and the page
without scripts.
`python -m unittest tests.test_browser_checks` runs them
and skips when `e2e/node_modules` is not installed:

```sh
python -m tests.capture_site \
  npm --prefix e2e exec --no -- playwright test --config e2e/checks.config.ts
```

To repeat a check that republishes a fixture page, start a fresh capture site
for each attempt. Playwright's `--repeat-each` shares the site's database and
published files across repetitions. In the decision Ask stale-page check,
the first attempt publishes replacement text; later attempts publish the
same bytes, so the revision stays the same and Ask succeeds with HTTP 201
instead of exercising HTTP 409 `stale_page`. Repeat that check with:

```sh
for attempt in $(seq 1 10); do
  python -m tests.capture_site \
    npm --prefix e2e exec --no -- playwright test --config e2e/checks.config.ts \
    e2e/checks/features/decisions/decision-threads.spec.ts \
    --grep 'a page published again since it loaded keeps the question and says to reload' \
    --reporter=line || exit 1
done
```

The `e2e` workflow (`.github/workflows/e2e.yml`) runs the full checks on every
pull request to main and every push to main, with `--reporter=github,list`
so each failed check is annotated with its spec, line and title, and with
`--forbid-only`, so a committed `test.only` fails the run instead of skipping
the rest of the suite. It splits the checks across four shards with
Playwright's `--shard=N/4`, one `e2e-shard (N/4)` job each, and each shard
serves its own copy of the sample site; one job named `e2e` reports their
combined result. Each shard runs in Microsoft's Playwright image
(`mcr.microsoft.com/playwright:v<version>-noble`) at the exact
`@playwright/test` version `e2e/package.json` pins, which ships Chromium and
the libraries it needs, so no shard downloads a browser;
`tests/test_e2e_image.py` fails when the image tag and the pinned version
differ, so bump both together. Each shard runs with one worker, and `e2e/checks.config.ts` retries
a failed check once when `CI` is set (never locally). A check that passes
only on its retry is reported as flaky: the list output prints `N flaky`
with each such check, and the `Playwright Run Summary` notice on the run's
summary page names them. A pull request whose changes are all docs (under
`docs/`, a `.md` file at the root or under `deploy/`, or `LICENSE`, as
`ci/e2e_scope.py` decides) skips the shards, and `e2e` passes; a push to
main always runs them. When a check fails, each failing shard uploads its
traces as the `e2e-test-results-N` artifact, kept 7 days; open one with
`npx playwright show-trace`.

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
