# Operating the site

For the operator of the site: serving the pages, Cloudflare Access in front
of the reader's routes, publishing through the tunnel, deploying from
`main`, and backups. The copy-paste tunnel setup is in
[`deploy/README.md`](../deploy/README.md). Back to the
[README](../README.md).

## Serve

Serve rendered pages from this machine:

```sh
lotuspod serve               # serves artifacts/ (or pass --out-dir DIR)
lotuspod serve --port 8080   # pick a different port (default: 8000)
lotuspod serve --host 127.0.0.1  # bind address override for tunnel fronting
```

The command listens on `127.0.0.1` unless `--host` names another address,
so by default your pages are reachable from this machine only. Open the
printed `http://127.0.0.1:8000/` URL; `/` serves `artifacts/index.html`
(build it first with `lotuspod index`). `--host 127.0.0.1`, the default
spelled out, stays right when a local Cloudflare Tunnel fronts the server
(see Publish below). To serve the other devices in your tailnet, and nothing
outside it, bind this node's tailnet IPv4:

```sh
lotuspod serve --host "$(tailscale ip -4)"
```

Everything else behaves identically whatever address serve binds.

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

Images a page shows are answered from `lotuspod-media/` beside the artifacts
directory (see [Images](publishing.md#images)): a GET or HEAD of `/media/NAME`, where NAME
is 64 lower-case hex digits, a dot and `png`, `jpg`, `webp` or `gif`, answers
that file with its `Content-Type` (`image/png`, `image/jpeg`, `image/webp`,
`image/gif`), `X-Content-Type-Options: nosniff` and `Cache-Control: private,
max-age=31536000, immutable`. A name never changes its bytes, so the browser
keeps it for a year; `private` keeps shared caches, Cloudflare's included,
from holding it outside the Access gate. Anything else under `/media/` - the
bare directory, any other name, a dotfile, a climb, a symbolic link - is a
404. The URLs are same-origin, which the page policy's `img-src 'self'`
allows.

A reader adds images to the store too, to attach to a comment (see
[Comments](comments.md#comments)). `POST /api/media`, behind the Access check and the
cross-origin refusal of the other POSTs (see [Answers and
comments](comments.md#answers-and-comments)), takes one image as its body with
`Content-Type` `image/png`, `image/jpeg`, `image/webp` or `image/gif`. The
bytes are checked as a page's images are, under that declared type, within the
config's `[media] max_image_bytes` (which serve reads at start), and stored
once under their name; it answers 201 `{name, url, width, height}`. Any other
type, SVG included, is 415 `unsupported_media_type`; a body over the cap 413
`body_too_large`; bytes that are not a whole image of the declared type 400
`invalid_image`. A reader has 20 accepted uploads in any 10 minutes, counted
in serve's memory; the next is 429 `too_many_uploads`. Nothing refused is
stored. Images no comment names are kept.

## Who is reading: Cloudflare Access

The site sits behind Cloudflare Access, and serve's `/api` routes know the
signed-in reader only from the `Cf-Access-Jwt-Assertion` token Access signs.
The plain `Cf-Access-Authenticated-User-Email` header is never read: serve
listens on loopback, where any process on the host could send it. The
settings go in an `[access]` section of the same config file `publish` reads
(`$LOTUSPOD_CONFIG`, then the XDG location; see [Publish a
page](publishing.md#publish-a-page)); keep the real team, audience and
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
lower-cased, is in `allowed_emails`. `owners`, optional and in the same list
form (`owners = reader@example.com`), names the readers who may archive and unarchive a page from the browser
(`/api/archive`; see [Archive a page](publishing.md#archive-a-page)); without
it no reader may. `certs_url` may be `https:`, `http:` or
(for tests) `file:`. The key set is fetched on first need and kept for an
hour; an unknown key id refetches it at most once a minute, and after a fetch
fails every `/api` request answers 503 until it is tried again a minute later.

Answers are JSON with `Cache-Control: no-store`: no assertion is 401
`signed_out`, one that does not verify 401 `invalid_assertion`, a verified one
for an email not allowed 403 `forbidden`, a key set that cannot be fetched 503
`access_unavailable`, and a config with no `[access]` section 503
`access_unconfigured` (pages are served as before). `GET /api/whoami` answers
`{"actor": {"kind": "human", "email": EMAIL}}`.

## Publish

Publish the pond publicly at `https://lotuspod.example.com` through a
Cloudflare Tunnel. The checked-in ingress config lives in
`deploy/cloudflared.yml`; it routes the public hostname to the same
allow-listed server on the dedicated publish port `127.0.0.1:8622` (see
[`deploy/README.md`](../deploy/README.md) for the full copy-paste setup, including the
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

## Deploying from main

The live site runs from its own checkout and follows `main` by itself. A
systemd user timer runs `deploy/lotuspod-deploy.py` every minute, with the
host's `python3` and never the site's virtual environment, so a broken
install cannot stop a rollback. Each run:

1. refuses, with a note, a site checkout with uncommitted changes to tracked
   files, and discards nothing;
2. runs `git fetch origin`, and stops without a note if origin cannot be
   reached; does nothing if `origin/main` is the checkout's commit; refuses,
   with a note, an `origin/main` the checkout's commit is not an ancestor of
   (a force-push); and otherwise fast-forwards to it;
3. reinstalls (`pip install -e`) only when `pyproject.toml` changed;
4. restarts serve and the responder, then runs `deploy/lotuspod-health.py`;
5. if the reinstall, the restart or the check fails, resets the checkout to
   the previous commit, reinstalls again if `pyproject.toml` changed,
   restarts, and writes a note.

Serve brings the theme files in its output directory up to date when it
starts (it does not commit them; the next publish does), so a deploy makes a
theme change live at once.

The health check stops at the first failure and prints its name:
`loopback` (serve answers 200 for `/` on its loopback port, waiting up to 30
seconds while it starts), `public` (the public URL, fetched without
credentials and without following redirects, answers 200, so Access is not
guarding it; a connection error passes) and `theme` (the served stylesheet
and page script differ from what the site's `sync_theme_css()` writes).

Set up on the writer host, as the user the serve and responder units run as:

1. **The site checkout.** Clone the repository into a directory of its own,
   kept on `main` and never edited by hand, and give it its own venv:

   ```sh
   git clone --branch main <repository URL> <site checkout>
   cd <site checkout>
   python3 -m venv .venv && .venv/bin/pip install -e .
   ```

2. **Point serve and the responder at it.** In the installed
   `lotuspod.service` and `lotuspod-respond.service`, set
   `WorkingDirectory=` to the site checkout and start `ExecStart=` with
   `<site checkout>/.venv/bin/lotuspod`, keeping their options (the
   artifacts directory, the database and the socket default to the working
   directory, so pass `--out-dir`, `--db` and `--socket` if the site's data
   lives elsewhere). Then `systemctl --user daemon-reload` and restart both.

3. **The env file.** Copy `deploy/systemd/deploy.env.example` to
   `~/.config/lotuspod/deploy.env` and fill it in:
   - `LOTUSPOD_SITE`: the site checkout;
   - `LOTUSPOD_PYTHON`: its venv's `python`;
   - `LOTUSPOD_UNITS`: the serve and responder unit names;
   - `LOTUSPOD_PORT`: serve's loopback port;
   - `LOTUSPOD_PUBLIC_URL`: the public URL behind Cloudflare Access;
   - `LOTUSPOD_NOTES`: the directory a failed deploy writes its note to;
   - optionally `LOTUSPOD_DEPLOY_REINSTALL`, `LOTUSPOD_DEPLOY_RESTART` and
     `LOTUSPOD_DEPLOY_CHECK`, shell commands run in the site checkout in
     place of `$LOTUSPOD_PYTHON -m pip install -e $LOTUSPOD_SITE`,
     `systemctl --user restart $LOTUSPOD_UNITS` and the health check.

4. **The units.** Copy and enable the timer:

   ```sh
   mkdir -p ~/.config/systemd/user
   cp <site checkout>/deploy/systemd/lotuspod-deploy.service \
      <site checkout>/deploy/systemd/lotuspod-deploy.timer ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now lotuspod-deploy.timer
   journalctl --user -u lotuspod-deploy.service -f      # watch the runs
   ```

   The timer starts the oneshot service every minute; systemd does not start
   it again while a run is still going, so runs never overlap. To stop
   deploying, `systemctl --user disable --now lotuspod-deploy.timer`.

**Reading a note.** A note is a new file in the notes directory. Its first
lines are `Status: open` and `To: claude`; then come what failed (the step,
the check's name and the step's output) and both commits, the checkout's
and `origin/main`'s.

**Resuming after one.** The deploy remembers the `origin/main` commit it
refused or rolled back (in the site checkout's git directory) and leaves it
alone while `origin/main` is still that commit, so a broken commit yields one
note, not one a minute. Push a fix to `main`: the next run tries the new
commit afresh. After a refusal for uncommitted changes, commit or restore the
changed files in the site checkout and the next run carries on.

## Backups

The writer host holds three things that belong together: serve's database of
the reader's answers and comments and the agents' replies, the artifacts
repository of the pages they refer to, and the media directory of the images
those pages show. `lotuspod backup` takes one backup set of all three while
serve keeps serving:

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
lock, so no publish lands between them, it copies the database with
SQLite's online backup, bundles every ref of the repository with `git
bundle create --all`, and takes every stored image in `lotuspod-media`, into
a new directory `BACKUPS/UTC-TIMESTAMP` (mode 0700, its files 0600):
`lotuspod.sqlite3`, `artifacts.bundle`, `media/` with each image under its
name, and `manifest.json` with each file's SHA-256, the images' names (an
image's name is its SHA-256, so it is its checksum), the database's schema
version, the repository's `HEAD` and its `origin`, if it has one. Only regular
files under a stored name are taken: temporary files, dotfiles and symbolic
links are left out, and no media directory yet gives an empty `media/`. An
image the newest earlier set already holds is hard-linked from it rather than
copied, so a nightly set costs only the images published since; each set
holds its own link, so removing an older set leaves the newer sets' images.
A set appears whole or not at all. `BACKUPS` is `--to`, else `lotuspod-backups` beside the artifacts
directory, never inside it. The newest `--keep` sets (default 14) are kept
and older ones removed; nothing else in `BACKUPS` is touched. `--json` prints
`{"backup": PATH}`.

`restore SET --db PATH --out-dir DIR` checks every file of the set against
its checksum, and every image against the hash in its name, first, then
copies the database to `--db`, clones the bundle into `--out-dir`, with
`main` checked out at the recorded `HEAD` and `origin` set to the recorded
remote (no `origin` when none was recorded), and copies the images into
`lotuspod-media` beside `--out-dir`, making it when missing. It never pushes.
It exits 1 naming the file, and writes nothing, when a checksum does not
match, and it refuses, changing nothing, when the database (or a `-wal`,
`-shm` or `-journal` file beside it) or the output directory already exists:
restore into fresh paths, check them with `lotuspod serve --out-dir DIR --db
PATH`, then stop serve and move them into place. An existing media directory
is added to, not refused, so a restore beside the live site shares its media
directory: a name is its image's hash, so a file already there under one of
the set's names is that image and is left as it is. One whose bytes do not
match its name refuses the restore, naming it, before anything is written.
Nothing in the media directory is replaced or removed, and images copied by a
restore that then fails are left there, harmless since each name fixes its
bytes. A set from before images were backed up lists none, and restores with
no media directory.

`backup --verify SET` (or `latest`, the newest set in `--to`) restores the
set into a temporary directory, runs `PRAGMA integrity_check` and `git fsck`,
compares `HEAD` with the manifest's, checks that every image the manifest
lists came back with the hash its name records, and exits 1 naming the first
failure.

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
