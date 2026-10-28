"""Print the browser spec files one `e2e` shard runs, one per line.

Every `*.spec.ts` under `e2e/checks`, at any depth, is split by the seconds
`e2e/spec_times.json` records for its path under `e2e/checks`, by the rule in
`ci/shard_split.py`: longest first, each to the shard with the smallest total
so far, ties to the lower shard; a spec the file does not record counts as
the median of the recorded times. Each line is the spec's path from the
repository root, which `playwright test` takes as a file filter. A shard
that holds no spec prints nothing and exits 0. Standard library only.

Run from the repo root:

    python ci/e2e_shard.py --shard 3/4
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# A script's own directory is on sys.path; `python -m ci.NAME` imports it as a package.
if __package__:
    from .shard_split import parse_shard, run_order, shard, weights
else:
    from shard_split import parse_shard, run_order, shard, weights

REPO_ROOT = Path(__file__).resolve().parent.parent
CHECKS = REPO_ROOT / "e2e" / "checks"
TIMES = REPO_ROOT / "e2e" / "spec_times.json"


def find_specs(checks: Path) -> list[str]:
    return sorted(
        path.relative_to(checks).as_posix()
        for path in checks.rglob("*.spec.ts")
        if path.is_file() and "node_modules" not in path.parts
    )


def load_times(path: Path) -> dict[str, float]:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {str(key): float(value) for key, value in data.items()}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--shard", type=parse_shard, required=True, metavar="I/N")
    parser.add_argument("--checks", type=Path, default=CHECKS, metavar="DIR")
    parser.add_argument("--times", type=Path, default=TIMES, metavar="PATH")
    args = parser.parse_args(argv)

    checks = args.checks.resolve()
    specs = find_specs(checks)
    if not specs:
        print(f"e2e_shard: no *.spec.ts under {checks}", file=sys.stderr)
        return 2
    weight = weights(specs, load_times(args.times))
    index, count = args.shard
    held = run_order(shard(specs, weight, index, count), weight)
    # A directory outside the repository, a scratch copy, prints absolute paths.
    prefix = checks.relative_to(REPO_ROOT) if checks.is_relative_to(REPO_ROOT) else checks
    for rel in held:
        print((prefix / rel).as_posix())
    return 0


if __name__ == "__main__":
    sys.exit(main())
