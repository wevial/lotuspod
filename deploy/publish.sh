#!/bin/sh
# Publish Lotuspod to Cloudflare: export, migrate, deploy, verify, in that
# order, stopping at the first step that fails.
#
#   deploy/publish.sh <staging|production> <address to verify>
#
# The last step requests the address with no credentials and fails unless
# the deployed site refuses. Tunnel, old server and DNS are not touched.
#
# Overridable through the environment:
#   WRANGLER       wrangler command (default: the version pinned in worker/)
#   LOTUSPOD       lotuspod command (default: .venv/bin/lotuspod, else PATH)
#   ARTIFACTS_DIR  artifacts directory (default: <repo>/artifacts)
# Wrangler's credentials come from the caller's environment; none is printed.
set -eu

usage() {
    echo "usage: $0 <staging|production> <address to verify>" >&2
    exit 2
}

[ "$#" -eq 2 ] || usage
ENVIRONMENT=$1
ADDRESS=$2
case "$ENVIRONMENT" in
    staging | production) ;;
    *) usage ;;
esac
case "$ADDRESS" in
    http://?* | https://?*) ;;
    *) usage ;;
esac

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
PUBLISH="$ROOT/publish"
CONFIG="$ROOT/worker/wrangler.toml"

if [ -z "${LOTUSPOD:-}" ]; then
    if [ -x "$ROOT/.venv/bin/lotuspod" ]; then
        LOTUSPOD="$ROOT/.venv/bin/lotuspod"
    else
        LOTUSPOD=lotuspod
    fi
fi
ARTIFACTS_DIR=${ARTIFACTS_DIR:-"$ROOT/artifacts"}
WRANGLER=${WRANGLER:-"npm --prefix worker exec wrangler --"}

# Only the repository's own publish directory is ever removed: the root must
# be this repository, and publish must be a real directory directly inside it.
if [ ! -f "$ROOT/deploy/publish.sh" ] || [ ! -f "$CONFIG" ]; then
    echo "publish: $ROOT is not the repository root; nothing removed" >&2
    exit 1
fi
if [ -L "$PUBLISH" ]; then
    echo "publish: $PUBLISH is a symbolic link; nothing removed" >&2
    exit 1
fi
if [ -e "$PUBLISH" ]; then
    if [ ! -d "$PUBLISH" ] || [ "$(CDPATH='' cd -- "$PUBLISH" && pwd -P)" != "$ROOT/publish" ]; then
        echo "publish: $PUBLISH is not the repository's publish directory; nothing removed" >&2
        exit 1
    fi
fi

cd "$ROOT"

echo "publish: exporting $ARTIFACTS_DIR to $PUBLISH"
rm -rf -- "$PUBLISH"
mkdir -- "$PUBLISH"
$LOTUSPOD export --out-dir "$ARTIFACTS_DIR" --dest "$PUBLISH"

echo "publish: applying database migrations ($ENVIRONMENT)"
$WRANGLER d1 migrations apply DB --remote --env "$ENVIRONMENT" --config "$CONFIG"

echo "publish: deploying the Worker ($ENVIRONMENT)"
$WRANGLER deploy --env "$ENVIRONMENT" --config "$CONFIG"

# Anonymous check: no cookies, no redirects followed, only the status code.
echo "publish: requesting $ADDRESS with no credentials"
STATUS=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 10 "$ADDRESS") || {
    echo "publish: FAILED: could not reach $ADDRESS to verify the deployment" >&2
    exit 1
}
case "$STATUS" in
    302 | 403)
        echo "publish: $ADDRESS refused an anonymous reader ($STATUS)"
        ;;
    2??)
        echo "publish: FAILED: the deployed site is publicly readable: $ADDRESS answered an anonymous request with $STATUS" >&2
        exit 1
        ;;
    *)
        echo "publish: FAILED: $ADDRESS answered an anonymous request with $STATUS, expected 302 or 403" >&2
        exit 1
        ;;
esac
