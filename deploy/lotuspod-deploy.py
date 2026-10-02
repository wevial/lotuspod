#!/usr/bin/env python3
"""Bring the site checkout up to origin/main, or step back and leave a note.

Run by lotuspod-deploy.service every minute with the host's python3, never
the site's virtual environment, so a broken install cannot stop a rollback.
It is Python rather than sh because the fast-forward may rewrite this very
file while it runs, and a shell reads its script as it goes.

Each run refuses a checkout with uncommitted changes to tracked files,
fetches origin, fast-forwards to origin/main, reinstalls when pyproject.toml
changed, restarts serve and the responder, and checks the site. A failed
reinstall, restart or check resets the checkout to the previous commit,
reinstalls if needed, restarts, and writes a note to the notes directory.
The origin/main commit refused or rolled back is remembered in the
checkout's git directory and left alone until main moves again.

Configuration, all from the environment (see systemd/deploy.env.example):

    LOTUSPOD_SITE      the site checkout
    LOTUSPOD_PYTHON    its virtual environment's python
    LOTUSPOD_UNITS     the serve and responder unit names
    LOTUSPOD_NOTES     the notes directory
    LOTUSPOD_DEPLOY_REINSTALL, LOTUSPOD_DEPLOY_RESTART, LOTUSPOD_DEPLOY_CHECK
                       optional shell commands for the three steps

The default check, lotuspod-health.py, reads LOTUSPOD_PORT and
LOTUSPOD_PUBLIC_URL too.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BRANCH = "main"
UPSTREAM = f"origin/{BRANCH}"
STATE_FILE = "lotuspod-deploy-skip"
# Remembered in place of a commit while the checkout has uncommitted changes.
DIRTY = "uncommitted"


class Config:
    def __init__(self, environ: dict[str, str]) -> None:
        missing = [key for key in ("LOTUSPOD_SITE", "LOTUSPOD_NOTES") if not environ.get(key)]
        if missing:
            raise SystemExit(f"error: {', '.join(missing)} not set")
        self.site = Path(environ["LOTUSPOD_SITE"])
        self.notes = Path(environ["LOTUSPOD_NOTES"])
        python = environ.get("LOTUSPOD_PYTHON", "")
        units = environ.get("LOTUSPOD_UNITS", "")
        here = Path(__file__).resolve().parent
        self.commands = {
            "reinstall": environ.get("LOTUSPOD_DEPLOY_REINSTALL")
            or shlex.join([python, "-m", "pip", "install", "-e", str(self.site)]),
            "restart": environ.get("LOTUSPOD_DEPLOY_RESTART")
            or " ".join(["systemctl --user restart", units]),
            "check": environ.get("LOTUSPOD_DEPLOY_CHECK")
            or shlex.join([sys.executable, str(here / "lotuspod-health.py")]),
        }


def git(site: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(site), *argv], capture_output=True, text=True)


def git_out(site: Path, *argv: str) -> str:
    result = git(site, *argv)
    if result.returncode != 0:
        raise SystemExit(f"error: git {' '.join(argv)}: {result.stderr.strip()}")
    return result.stdout.strip()


def run_step(config: Config, step: str) -> tuple[bool, str]:
    """Run one configured command in the checkout; its success and output."""
    print(f"{step}: {config.commands[step]}", flush=True)
    result = subprocess.run(config.commands[step], shell=True, cwd=str(config.site),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    output = result.stdout.rstrip()
    if output:
        print(output, flush=True)
    if result.returncode != 0:
        output = f"{output}\n(exit {result.returncode})".lstrip()
    return result.returncode == 0, output


class State:
    """The origin/main commit refused or rolled back, kept in the git dir."""

    def __init__(self, site: Path) -> None:
        self.path = Path(git_out(site, "rev-parse", "--absolute-git-dir")) / STATE_FILE

    def read(self) -> str:
        try:
            return self.path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return ""

    def write(self, value: str) -> None:
        self.path.write_text(value + "\n", encoding="utf-8")

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)


def write_note(config: Config, title: str, lines: list[str], sections: list[tuple[str, str]]) -> Path:
    now = datetime.now(timezone.utc)
    config.notes.mkdir(parents=True, exist_ok=True)
    body = ["Status: open", "To: claude", "", f"# {title}", "",
            f"When: {now.strftime('%Y-%m-%dT%H:%M:%SZ')}",
            f"Site checkout: {config.site}", *lines]
    for heading, text in sections:
        body += ["", f"## {heading}", "", "```", text or "(no output)", "```"]
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    for attempt in range(100):
        suffix = f"-{attempt}" if attempt else ""
        path = config.notes / f"lotuspod-deploy-{stamp}{suffix}.md"
        try:
            with open(path, "x", encoding="utf-8") as note:
                note.write("\n".join(body) + "\n")
            print(f"note: {path}", flush=True)
            return path
        except FileExistsError:
            continue
    raise SystemExit(f"error: cannot name a note in {config.notes}")


def check_name(output: str) -> str:
    """The failing check's name: the first word of the check's last line."""
    lines = [line for line in output.splitlines() if line.strip() and not line.startswith("(exit ")]
    if not lines:
        return "unknown"
    return lines[-1].split(":", 1)[0].split()[0]


def deploy(config: Config) -> int:
    site = config.site
    state = State(site)
    remembered = state.read()

    changes = git_out(site, "status", "--porcelain", "--untracked-files=no")
    if changes:
        if remembered == DIRTY:
            print("checkout still has uncommitted changes; a note is open")
            return 0
        head = git_out(site, "rev-parse", "HEAD")
        known = git(site, "rev-parse", "--verify", "--quiet", UPSTREAM).stdout.strip()
        write_note(config, "Deploy refused: the site checkout has uncommitted changes", [
            "Step: uncommitted changes",
            f"Current commit: {head}",
            f"{UPSTREAM} (last fetched): {known or 'unknown'}",
            "",
            "The deploy discards nothing. Commit or restore these files in the",
            "site checkout and the next run carries on.",
        ], [("Uncommitted changes", changes)])
        state.write(DIRTY)
        return 1
    if remembered == DIRTY:
        state.clear()
        remembered = ""

    fetch = git(site, "fetch", "--quiet", "origin")
    if fetch.returncode != 0:
        print(f"error: git fetch origin: {fetch.stderr.strip()}", file=sys.stderr)
        return 1
    old = git_out(site, "rev-parse", "HEAD")
    new = git_out(site, "rev-parse", UPSTREAM)
    if new == old:
        return 0
    if new == remembered:
        print(f"{UPSTREAM} is still {new}, refused or rolled back before; waiting for a new push")
        return 0

    commits = [f"Current commit: {old}", f"{UPSTREAM}: {new}"]
    ancestor = git(site, "merge-base", "--is-ancestor", old, new)
    if ancestor.returncode != 0:
        if ancestor.returncode != 1:
            raise SystemExit(f"error: git merge-base: {ancestor.stderr.strip()}")
        write_note(config, f"Deploy refused: {UPSTREAM} does not descend from the site's commit", [
            "Step: fast-forward refused, not a descendant",
            *commits,
            "",
            f"{UPSTREAM} was rewritten (a force-push?), so the checkout cannot",
            "fast-forward to it. The checkout is unchanged; this commit is skipped",
            "and the next push to main is tried afresh.",
        ], [])
        state.write(new)
        return 1

    pyproject = git(site, "diff", "--quiet", old, new, "--", "pyproject.toml").returncode != 0
    merge = git(site, "merge", "--ff-only", "--quiet", new)
    if merge.returncode != 0:
        if git_out(site, "rev-parse", "HEAD") != old:
            git(site, "reset", "--hard", "--quiet", old)
        write_note(config, f"Deploy failed: cannot fast-forward to {UPSTREAM}", [
            "Step: fast-forward", *commits,
            "", "The checkout is unchanged; this commit is skipped.",
        ], [("git merge --ff-only", (merge.stdout + merge.stderr).strip())])
        state.write(new)
        return 1
    print(f"fast-forwarded {old} -> {new}", flush=True)

    steps = (["reinstall"] if pyproject else []) + ["restart", "check"]
    for step in steps:
        ok, output = run_step(config, step)
        if not ok:
            return roll_back(config, state, old, new, pyproject, step, output)
    state.clear()
    print(f"deployed {new}")
    return 0


def roll_back(config: Config, state: State, old: str, new: str, pyproject: bool,
              step: str, output: str) -> int:
    site = config.site
    print(f"{step} failed; rolling back to {old}", flush=True)
    reset = git(site, "reset", "--hard", "--quiet", old)
    sections = [(f"{step} output", output)]
    recovered = reset.returncode == 0
    if not recovered:
        sections.append(("git reset --hard", reset.stderr.strip()))
    else:
        for again in (["reinstall"] if pyproject else []) + ["restart"]:
            ok, again_output = run_step(config, again)
            if not ok:
                recovered = False
                sections.append((f"{again} after the rollback", again_output))
    lines = [f"Step: {step}"]
    if step == "check":
        lines.append(f"Check: {check_name(output)}")
    lines += [
        f"Previous commit (restored): {old}",
        f"Rolled-back commit ({UPSTREAM}): {new}",
        "",
        "The checkout is back at the previous commit"
        + (" and serve was restarted." if recovered else ", but the rollback itself failed; see below."),
        "This commit is skipped; push a fix to main and the next run tries it.",
    ]
    write_note(config, f"Deploy rolled back: {step} failed", lines, sections)
    state.write(new)
    return 1


def main() -> int:
    return deploy(Config(dict(os.environ)))


if __name__ == "__main__":
    sys.exit(main())
