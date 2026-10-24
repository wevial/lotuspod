"""Run the unit suite module by module, several at a time, optionally one shard.

Each `test_*.py` under the tests directory, at any depth, runs as
`python -m unittest DOTTED` in its own process and session: the repository
root as its working directory, the tests directory first on `PYTHONPATH`,
stdin closed, stdout and stderr to a temporary file. That loads the same test
ids as `python -m unittest discover -s tests`, one module per process.

`--shard I/N` splits the selected modules by the seconds `module_times.json`
in the tests directory records: longest first, each to the shard with the
smallest total so far, ties to the lower shard. A module the file does not
record counts as the median of the recorded times, or 1 second when nothing
is recorded.

A module fails when it exits non-zero, runs past `--module-timeout` (its
process group is killed), runs zero tests, or finishes past
`--max-module-sec`. The run exits non-zero when any module fails, and also
when no module is found, a shard holds none, or a pattern matches none.

Run from the repo root:

    python ci/run_modules.py --jobs 4 --shard 1/2
    python ci/run_modules.py --list --shard 2/2
    python ci/run_modules.py tests/test_ci_workflow.py 'features/serve/*'
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import IO

REPO_ROOT = Path(__file__).resolve().parent.parent
TESTS = REPO_ROOT / "tests"
TIMES_FILE = "module_times.json"
RAN = re.compile(r"^Ran (\d+) tests?\b", re.MULTILINE)
TAIL_LINES = 40
SLOWEST = 10
POLL_SEC = 0.05


class Module:
    def __init__(self, rel: str) -> None:
        self.rel = rel
        self.dotted = rel[: -len(".py")].replace("/", ".")
        self.proc: subprocess.Popen | None = None
        self.out: IO[bytes] | None = None
        self.started = 0.0
        self.wall = 0.0
        self.cpu = 0.0
        self.code: int | None = None
        self.timed_out = False
        self.tests = 0
        self.output = ""
        self.verdict = ""


def find_modules(tests: Path) -> list[str]:
    return sorted(
        path.relative_to(tests).as_posix()
        for path in tests.rglob("test_*.py")
        if path.is_file() and "__pycache__" not in path.parts
    )


def select(modules: list[str], patterns: list[str]) -> list[str]:
    """The modules any pattern matches, each matched against its path under
    the tests directory after a leading `tests/` is dropped."""
    if not patterns:
        return modules
    chosen = set()
    for pattern in patterns:
        pattern = pattern.removeprefix("tests/")
        hits = [rel for rel in modules if fnmatch.fnmatchcase(rel, pattern)]
        if not hits:
            raise SystemExit(f"run_modules: no module matches {pattern!r}")
        chosen.update(hits)
    return [rel for rel in modules if rel in chosen]


def load_times(tests: Path) -> dict[str, float]:
    path = tests / TIMES_FILE
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {str(key): float(value) for key, value in data.items()}


def weights(modules: list[str], times: dict[str, float]) -> dict[str, float]:
    fallback = statistics.median(times.values()) if times else 1.0
    # Floored so every module adds to its shard's total and none stays empty.
    return {rel: max(times.get(rel, fallback), 0.01) for rel in modules}


def run_order(modules: list[str], weight: dict[str, float]) -> list[str]:
    """Longest first, ties by path."""
    return sorted(modules, key=lambda rel: (-weight[rel], rel))


def shard(modules: list[str], weight: dict[str, float], index: int, count: int) -> list[str]:
    totals = [0.0] * count
    shards: list[list[str]] = [[] for _ in range(count)]
    for rel in run_order(modules, weight):
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


def start(module: Module, tests: Path) -> None:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(tests), env.get("PYTHONPATH", "")) if part
    )
    # Closed in finish(), once the module's process is reaped.
    module.out = tempfile.TemporaryFile()  # noqa: SIM115
    module.started = time.monotonic()
    module.proc = subprocess.Popen(
        [sys.executable, "-m", "unittest", module.dotted],
        cwd=REPO_ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=module.out,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def finish(module: Module, status: int, usage, ceiling: float | None) -> None:
    assert module.proc is not None and module.out is not None
    module.wall = time.monotonic() - module.started
    module.cpu = usage.ru_utime + usage.ru_stime
    module.code = os.waitstatus_to_exitcode(status)
    module.proc.returncode = module.code
    # A straggler the module left behind still holds its group.
    kill_group(module.proc.pid)
    module.out.seek(0)
    module.output = module.out.read().decode("utf-8", "replace")
    module.out.close()
    ran = RAN.findall(module.output)
    module.tests = int(ran[-1]) if ran else 0
    if module.timed_out:
        module.verdict = "timed out"
    elif module.tests == 0 and module.code in (0, 5):
        module.verdict = "ran zero tests"
    elif module.code != 0:
        module.verdict = "failed"
    elif module.tests == 0:
        module.verdict = "ran zero tests"
    elif ceiling is not None and module.wall > ceiling:
        module.verdict = f"over the {ceiling:g}s ceiling"
    else:
        module.verdict = "ok"


def report(module: Module) -> None:
    print(
        f"{module.wall:7.1f}s wall {module.cpu:7.1f}s cpu {module.tests:5d} tests"
        f"  {module.verdict}  {module.rel}",
        flush=True,
    )


def run(modules: list[Module], tests: Path, jobs: int, timeout: float,
        ceiling: float | None) -> None:
    waiting = list(modules)
    running: dict[int, Module] = {}
    try:
        while waiting or running:
            while waiting and len(running) < jobs:
                module = waiting.pop(0)
                start(module, tests)
                assert module.proc is not None
                running[module.proc.pid] = module
            pid, status, usage = os.wait4(-1, os.WNOHANG)
            if pid in running:
                module = running.pop(pid)
                finish(module, status, usage, ceiling)
                report(module)
                continue
            now = time.monotonic()
            for module in running.values():
                if not module.timed_out and now - module.started > timeout:
                    module.timed_out = True
                    assert module.proc is not None
                    kill_group(module.proc.pid)
            time.sleep(POLL_SEC)
    finally:
        for module in running.values():
            assert module.proc is not None
            kill_group(module.proc.pid)


def summarize(modules: list[Module], elapsed: float) -> int:
    failed = [module for module in modules if module.verdict != "ok"]
    for module in failed:
        lines = module.output.splitlines()
        if module.timed_out:
            lines = lines[-TAIL_LINES:]
        print(f"\n===== {module.rel}: {module.verdict} (exit {module.code}) =====")
        print("\n".join(lines))
    print(f"\nslowest {min(SLOWEST, len(modules))}:")
    for module in sorted(modules, key=lambda m: -m.wall)[:SLOWEST]:
        print(f"{module.wall:7.1f}s  {module.rel}")
    tests = sum(module.tests for module in modules)
    names = ", ".join(f"{module.rel} ({module.verdict})" for module in failed)
    print(
        f"\nrun_modules: {len(modules)} modules, {tests} tests, {elapsed:.1f}s; "
        + (f"{len(failed)} failed: {names}" if failed else "no module failed"),
        flush=True,
    )
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("patterns", nargs="*", metavar="MODULE",
                        help="module paths or globs, relative to the tests directory")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    parser.add_argument("--shard", type=parse_shard, metavar="I/N")
    parser.add_argument("--list", action="store_true",
                        help="print the selected modules in run order and run none")
    parser.add_argument("--record", type=Path, metavar="PATH",
                        help="write each module's wall seconds as JSON")
    parser.add_argument("--module-timeout", type=float, default=300.0, metavar="SECONDS")
    parser.add_argument("--max-module-sec", type=float, metavar="SECONDS")
    parser.add_argument("--dir", type=Path, default=TESTS, metavar="TESTS")
    args = parser.parse_args(argv)
    if args.jobs < 1:
        parser.error("--jobs must be at least 1")

    tests = args.dir.resolve()
    found = find_modules(tests)
    if not found:
        print(f"run_modules: no test_*.py module under {tests}", file=sys.stderr)
        return 2
    selected = select(found, args.patterns)
    weight = weights(selected, load_times(tests))
    if args.shard:
        index, count = args.shard
        selected = shard(selected, weight, index, count)
        if not selected:
            print(f"run_modules: shard {index}/{count} holds no module", file=sys.stderr)
            return 2
    ordered = run_order(selected, weight)

    if args.list:
        print("\n".join(ordered))
        return 0

    began = time.monotonic()
    modules = [Module(rel) for rel in ordered]
    run(modules, tests, args.jobs, args.module_timeout, args.max_module_sec)
    if args.record:
        args.record.write_text(
            json.dumps({m.rel: round(m.wall, 1) for m in sorted(modules, key=lambda m: m.rel)},
                       indent=2) + "\n",
            encoding="utf-8",
        )
    return summarize(modules, time.monotonic() - began)


if __name__ == "__main__":
    sys.exit(main())
