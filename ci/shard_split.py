"""Split a list of paths into shards by their recorded seconds.

Longest first, each to the shard with the smallest total so far, ties to the
lower shard. A path the times do not record counts as the median of the
recorded times, or 1 second when nothing is recorded. `ci/run_modules.py`
splits the unit modules this way and `ci/e2e_shard.py` the browser specs.
Standard library only.
"""

from __future__ import annotations

import argparse
import re
import statistics


def weights(paths: list[str], times: dict[str, float]) -> dict[str, float]:
    fallback = statistics.median(times.values()) if times else 1.0
    # Floored so every path adds to its shard's total and none stays empty.
    return {rel: max(times.get(rel, fallback), 0.01) for rel in paths}


def run_order(paths: list[str], weight: dict[str, float]) -> list[str]:
    """Longest first, ties by path."""
    return sorted(paths, key=lambda rel: (-weight[rel], rel))


def shard(paths: list[str], weight: dict[str, float], index: int, count: int) -> list[str]:
    totals = [0.0] * count
    shards: list[list[str]] = [[] for _ in range(count)]
    for rel in run_order(paths, weight):
        # The smallest total so far; min keeps the first, the lower shard, on a tie.
        at = min(range(count), key=lambda i: totals[i])
        shards[at].append(rel)
        totals[at] += weight[rel]
    return shards[index - 1]


def parse_shard(text: str) -> tuple:
    match = re.fullmatch(r"(\d+)/(\d+)", text)
    if not match:
        raise argparse.ArgumentTypeError(f"expected I/N, got {text!r}")
    index, count = int(match.group(1)), int(match.group(2))
    if not 1 <= index <= count:
        raise argparse.ArgumentTypeError(f"shard {index} is not in 1..{count}")
    return index, count
