#!/usr/bin/env bash
# Install the one wheel in DIST_DIR into a fresh virtual environment and
# publish a page with it, away from the checkout.
#
# Runs `lotuspod --help`, then publishes a two-section markdown page with
# `lotuspod publish FILE --local --out-dir OUT --name smoke`, and checks that
# OUT/smoke.html exists and links a theme stylesheet and script, each of which
# exists in OUT. LOTUSPOD_CONFIG names a missing file, so only what the wheel
# ships is used: a file missing from the package data fails the publish, and
# the error names it.
#
# Everything goes in a temporary directory, removed on exit. PYTHON names the
# interpreter that makes the environment (default: python3).
#
#     bash ci/install_smoke.sh dist

set -euo pipefail

fail() {
  echo "install smoke: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || { echo "usage: ci/install_smoke.sh DIST_DIR" >&2; exit 2; }
dist="$1"
[ -d "$dist" ] || fail "no directory $dist"

shopt -s nullglob
wheels=("$dist"/*.whl)
shopt -u nullglob
[ "${#wheels[@]}" -eq 1 ] || fail "expected one wheel in $dist, found ${#wheels[@]}"
wheel="$(cd "$(dirname "${wheels[0]}")" && pwd)/$(basename "${wheels[0]}")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unset PYTHONPATH
export LOTUSPOD_CONFIG="$work/no-such-config.ini"

"${PYTHON:-python3}" -m venv "$work/venv"
cd "$work"
"$work/venv/bin/python" -m pip install --quiet --disable-pip-version-check "$wheel"
installed="$("$work/venv/bin/python" -c 'import lotuspod; print(lotuspod.__file__)')"
case "$installed" in
  "$work/venv/"*) ;;
  *) fail "lotuspod imports from $installed, not the fresh environment" ;;
esac

lotuspod="$work/venv/bin/lotuspod"
"$lotuspod" --help >/dev/null || fail "lotuspod --help failed"

printf '# Smoke\n\n## First\n\nThe first section.\n\n## Second\n\nThe second section.\n' > "$work/smoke.md"
out="$work/out"
"$lotuspod" publish "$work/smoke.md" --local --out-dir "$out" --name smoke \
  || fail "lotuspod publish failed"

page="$out/smoke.html"
[ -f "$page" ] || fail "publish wrote no smoke.html"

# Each local stylesheet and script the page links, without its ?v= query.
links="$(grep -oE '(href|src)="[^"]+\.(css|js)(\?[^"]*)?"' "$page" \
  | sed -E 's/^(href|src)="//; s/"$//; s/\?.*$//' \
  | grep -vE '^([a-zA-Z][a-zA-Z0-9+.-]*:|//)' | sort -u || true)"
echo "$links" | grep -qE '\.css$' || fail "smoke.html links no theme stylesheet"
echo "$links" | grep -qE '\.js$' || fail "smoke.html links no theme script"
while IFS= read -r link; do
  [ -f "$out/$link" ] || fail "smoke.html links $link, which is not in the output directory"
done <<< "$links"

echo "install smoke: $(basename "$wheel") installs, and its published page links" \
  "$(echo "$links" | tr '\n' ' ')which all exist"
