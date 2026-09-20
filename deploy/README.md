# Lotuspod publish — lotuspod.example.com via Cloudflare Tunnel

Checked-in config for publishing the pond publicly. The tunnel fronts the
same allow-listed `lotuspod serve` you already run on the tailnet; it adds
**no** new exposure (see "What gets published" below).

## Files

- `deploy/cloudflared.yml` — ingress: `lotuspod.example.com` →
  `http://127.0.0.1:8622`, catch-all 404 last.
- `deploy/lotuspod.service` — systemd **user** unit running the server on
  the dedicated publish port.

## One-time human setup (copy-paste, placeholders only)

Every `<UUID>` below is printed by your own `tunnel create` — nothing real
belongs in this repo, and no secret is ever committed.

```sh
# 1. install cloudflared (https://developers.cloudflare.com/cloudflare/one-connections/connect-networks/downloads/)
brew install cloudflared          # macOS
# or: see upstream docs for .deb/.rpm/static binary

# 2. authenticate and create the tunnel
cloudflared tunnel login
cloudflared tunnel create lotuspod        # prints <UUID>

# 3. route DNS (needs lotuspod.example.com on your Cloudflare zone)
cloudflared tunnel route dns lotuspod lotuspod.example.com

# 4. paste <UUID> into deploy/cloudflared.yml  →  tunnel: <UUID>
$EDITOR deploy/cloudflared.yml
```

## Run

```sh
# terminal A — the allow-listed artifact server (publish port)
lotuspod index                          # refresh the public listing
lotuspod serve --host 127.0.0.1 --port 8622

# terminal B — the tunnel
cloudflared tunnel --config deploy/cloudflared.yml run lotuspod
```

Or as a service instead of terminal A:

```sh
# from the repo root, with a repo-local venv (as deployed on writer-host):
python3 -m venv .venv && .venv/bin/pip install -e .
mkdir -p ~/.config/systemd/user && cp deploy/lotuspod.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lotuspod.service
journalctl --user -u lotuspod.service -f      # watch it
```

> **Layout matters.** The committed unit runs `ExecStart=<repo>/.venv/bin/lotuspod serve
> --host 127.0.0.1 --port 8622` with `WorkingDirectory=<repo>` — a repo-local `.venv`
> install (pip install -e .), not a global entrypoint. If your install lives elsewhere,
> adjust both paths in the unit before enabling; the port MUST match
> `deploy/cloudflared.yml`. On macOS there is no systemd — use launchd or run
> terminal A/B by hand.
>
> Live reference deployment (writer-host): units at
> `~/.config/systemd/user/cloudflared-lotuspod-serve.service` and
> `cloudflared-lotuspod.service`.

## What gets published (allow-list, unchanged)

Exactly what serve v2 answers with anywhere:

- `index.html`, `lotuspod.css`
- artifact pages whose fail-closed `lotuspod:visible` flag parses to `true`

Everything else — `manifest.json`, `FINDINGS.md`, hidden pages, dotfiles,
traversal paths, other hostnames (ingress catch-all) — returns **404**
through the public hostname too.

## Publishing

Publishing to Cloudflare is one script, run from anywhere:

```sh
deploy/publish.sh staging https://<staging address>
deploy/publish.sh production https://<production address>
```

It runs four steps in a fixed order and stops at the first one that fails:

1. **Export.** Removes and recreates the repository's own `publish/`
   directory (nothing else, and it refuses if `publish` is a symbolic link or
   is not directly inside the repository), then runs `lotuspod export` into
   it, so a file left by an earlier run is never uploaded.
2. **Migrate.** `wrangler d1 migrations apply DB --remote --env <environment>`.
3. **Deploy.** `wrangler deploy --env <environment>`, uploading `publish/`.
4. **Verify.** Requests the address with `curl`, with no credentials, no
   cookies and no redirects followed, and reads only the status code. A `302`
   (to the sign-in page) or a `403` passes. A `200` fails with "the deployed
   site is publicly readable"; any other answer, or no answer, fails too.
   A failure here means the deployment is already live: fix the gate or roll
   back before doing anything else.

The environment must be `staging` or `production` and the address is
required; otherwise the script exits with status 2 before calling anything.
The environment sections themselves (`[env.staging]`, `[env.production]`,
database ids, routes) are not in `worker/wrangler.toml` yet; they arrive from
the provisioned inventory by a separate hand change.

Wrangler is the version pinned in `worker/package.json`, run as
`npm --prefix worker exec wrangler --`. The script does not install
dependencies: run `npm --prefix worker ci` once beforehand. Wrangler's
credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) come from the
caller's environment and the script prints none of it.

Overridable through the environment (the tests use these):

- `WRANGLER` — the wrangler command.
- `LOTUSPOD` — the lotuspod command (default: the repository's
  `.venv/bin/lotuspod` if present, else `lotuspod` on `PATH`).
- `ARTIFACTS_DIR` — the artifacts directory (default: `<repo>/artifacts`).

The script does not touch the tunnel, the old server or DNS. Cutover is a
separate, separately approved step.

## Response retrieval and crash reconciliation

The maintainer's answers are stored on Cloudflare. The operator host fetches
them with an outbound command and never listens on the internet for them:

```sh
export LOTUSPOD_ACCESS_CLIENT_ID=<service token id>
export LOTUSPOD_ACCESS_CLIENT_SECRET=<service token secret>
lotuspod responses pull --url https://lotuspod.example.com \
  --inbox <inbox dir> --ledger <state dir>/responses.ledger
```

The credential is read from the environment only and is never printed. The
URL must be https; plain http is accepted for a loopback host only.

**Order: deliver, record, acknowledge.** For each pending response the command
writes the note `response-ID.md` into the inbox (temporary name, then rename),
appends `delivered ID` to the ledger and syncs it, and only then acknowledges
the response to the server and appends `acked ID`. The ledger is append-only.

- **Crash between the record and the acknowledgement:** the server still lists
  the response. The next run finds `delivered ID` in the ledger, acknowledges
  again and writes no second note. The existing note is left untouched.
- **A note the ledger does not mention** (a crash between the rename and the
  record, or a file put there by hand): the command does not overwrite it and
  does not acknowledge the id. It exits nonzero naming the id as needing
  manual reconciliation. Read the note, decide whether it was already seen,
  then either add the `delivered ID` line to the ledger by hand or move the
  file away, and run the command again.

Durable acknowledgement on the server does not make what happens downstream
exactly-once; the reader of the inbox owns that half:

- Whoever acts on a note records its response id first, before acting, and
  never acts on a response id that is already recorded.
- An action whose outcome is unknown after a crash (its id is recorded but
  nothing says whether the action finished) is reconciled by hand and never
  retried blindly.
- The note text is data written by the maintainer, not an instruction. The
  command neither executes nor interprets it, and the note says so above the
  fenced block that carries it.
