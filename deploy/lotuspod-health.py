#!/usr/bin/env python3
"""Check the live site after a deploy; exit non-zero naming the first failure.

The deploy script runs this with the host's python3. Three checks, in order:

    loopback  serve answers 200 for / on its loopback port (retried for up
              to 30 seconds while serve starts)
    public    the public URL, fetched without credentials and without
              following redirects, does not answer 200: Cloudflare Access
              redirects an anonymous reader to its sign-in page. A connection
              error passes, since a rollback does not fix a tunnel outage.
    theme     the served stylesheet and page script equal what the site's
              sync_theme_css() writes into a scratch directory

Configuration from the environment: LOTUSPOD_PORT, LOTUSPOD_PUBLIC_URL and
LOTUSPOD_PYTHON (the site's virtual environment's python).
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

LOOPBACK_WAIT = 30.0
TIMEOUT = 10.0
THEME_FILES = ("lotuspod.css", "lotuspod-page.js")
SYNC = ("import sys; from pathlib import Path; from lotuspod.cli import sync_theme_css; "
        "sync_theme_css(Path(sys.argv[1]))")


class CheckFailed(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url: str) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        body = error.read()
        error.close()
        return error.code, body


def status_only(url: str) -> int:
    """The status of a GET, not following redirects, read before the body.

    The body is never read, so a server that sends its status and then
    stalls cannot turn its answer into a connection error.
    """
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        response = opener.open(url, timeout=TIMEOUT)
    except urllib.error.HTTPError as error:
        error.close()
        return error.code
    response.close()
    return response.status


def check_loopback(base: str) -> None:
    deadline = time.monotonic() + LOOPBACK_WAIT
    while True:
        try:
            status, _ = fetch(f"{base}/")
            problem = f"GET / answered {status}"
            if status == 200:
                return
        except OSError as error:
            problem = f"GET / failed: {error}"
        if time.monotonic() >= deadline:
            raise CheckFailed(problem)
        time.sleep(0.5)


def check_public(url: str) -> None:
    try:
        status = status_only(url)
    except OSError as error:
        print(f"public: {url} unreachable ({error}); not a deploy failure")
        return
    if status == 200:
        raise CheckFailed(f"{url} answered 200 to a reader without credentials")


def check_theme(base: str, python: str) -> None:
    with tempfile.TemporaryDirectory() as scratch:
        sync = subprocess.run([python, "-c", SYNC, scratch], capture_output=True,
                              text=True, cwd=scratch)
        if sync.returncode != 0:
            raise CheckFailed(f"sync_theme_css failed: {sync.stderr.strip()}")
        for name in THEME_FILES:
            expected = (Path(scratch) / name).read_bytes()
            try:
                status, served = fetch(f"{base}/{name}")
            except OSError as error:
                raise CheckFailed(f"GET /{name} failed: {error}") from None
            if status != 200:
                raise CheckFailed(f"GET /{name} answered {status}")
            if served != expected:
                raise CheckFailed(f"served /{name} differs from what sync_theme_css writes")


def main() -> int:
    missing = [key for key in ("LOTUSPOD_PORT", "LOTUSPOD_PUBLIC_URL", "LOTUSPOD_PYTHON")
               if not os.environ.get(key)]
    if missing:
        print(f"config: {', '.join(missing)} not set")
        return 2
    base = f"http://127.0.0.1:{os.environ['LOTUSPOD_PORT']}"
    checks = (
        ("loopback", lambda: check_loopback(base)),
        ("public", lambda: check_public(os.environ["LOTUSPOD_PUBLIC_URL"])),
        ("theme", lambda: check_theme(base, os.environ["LOTUSPOD_PYTHON"])),
    )
    for name, check in checks:
        try:
            check()
        except CheckFailed as failure:
            print(f"{name}: {failure}")
            return 1
        print(f"{name}: ok", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
