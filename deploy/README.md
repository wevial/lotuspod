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
mkdir -p ~/.config/systemd/user && cp deploy/lotuspod.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lotuspod.service
journalctl --user -u lotuspod.service -f      # watch it
```

> The unit assumes the venv's `lotuspod` entrypoint; adjust `ExecStart=` if
> your install lives elsewhere. On macOS use launchd or run terminal A/B by hand.

## What gets published (allow-list, unchanged)

Exactly what serve v2 answers with anywhere:

- `index.html`, `lotuspod.css`
- artifact pages whose fail-closed `lotuspod:visible` flag parses to `true`

Everything else — `manifest.json`, `FINDINGS.md`, hidden pages, dotfiles,
traversal paths, other hostnames (ingress catch-all) — returns **404**
through the public hostname too.
