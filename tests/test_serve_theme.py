"""Serve brings its output directory's theme files up to date when it starts.

A deploy restarts serve, so a theme change reaches readers at once instead of
waiting for the next publish. "Up to date" means equal to what
sync_theme_css() writes into a fresh directory, never to the theme sources.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from lotuspod.cli import sync_theme_css  # noqa: E402

TIMEOUT = 30
STYLESHEET = "lotuspod.css"
PAGE_SCRIPT = "lotuspod-page.js"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def synced_theme() -> dict[str, bytes]:
    """What sync_theme_css() writes for the stylesheet and the page script."""
    with tempfile.TemporaryDirectory() as fresh:
        sync_theme_css(Path(fresh))
        return {name: (Path(fresh) / name).read_bytes() for name in (STYLESHEET, PAGE_SCRIPT)}


def fetch(url: str) -> tuple[int, bytes]:
    with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
        return response.status, response.read()


class ServedSite:
    """An output directory with an index, served by a real `lotuspod serve`
    on a free loopback port, with no operator config read."""

    def __init__(self, case: unittest.TestCase) -> None:
        self.case = case
        tmp = tempfile.TemporaryDirectory()
        case.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        # A Unix socket path is limited to about 100 bytes on macOS.
        short = tempfile.TemporaryDirectory(dir="/tmp", prefix="lp")
        case.addCleanup(short.cleanup)
        self.sock = Path(short.name) / "s.sock"
        self.out = self.tmp / "site"
        self.out.mkdir()
        config = self.tmp / "config.ini"
        config.write_text("", encoding="utf-8")
        self.env = dict(os.environ, PYTHONPATH=str(SRC), LOTUSPOD_CONFIG=str(config))
        index = self.cli("index", "--out-dir", str(self.out))
        case.assertEqual(index.returncode, 0, index.stderr)
        self.port = 0

    def cli(self, *argv: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "lotuspod", *argv], cwd=str(self.tmp),
                              env=self.env, capture_output=True, text=True, timeout=TIMEOUT)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> subprocess.Popen:
        self.port = free_port()
        log = open(self.tmp / "serve.log", "w+", encoding="utf-8")
        self.case.addCleanup(log.close)
        server = subprocess.Popen(
            [sys.executable, "-m", "lotuspod", "serve", "--out-dir", str(self.out),
             "--host", "127.0.0.1", "--port", str(self.port),
             "--db", str(self.tmp / "lotuspod.sqlite3"), "--socket", str(self.sock)],
            cwd=str(self.tmp), env=self.env, stdout=log, stderr=log)
        self.case.addCleanup(server.wait, 10)
        self.case.addCleanup(server.terminate)  # SIGTERM
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if server.poll() is not None:
                log.seek(0)
                self.case.fail(f"serve exited {server.returncode}: {log.read()}")
            try:
                if fetch(f"{self.url}/")[0] == 200:
                    return server
            except OSError:
                pass
            time.sleep(0.2)
        self.case.fail("serve did not answer / on its port")


class ServeSyncsTheme(unittest.TestCase):
    def test_serve_rewrites_a_stale_stylesheet_and_a_missing_page_script(self):
        site = ServedSite(self)
        expected = synced_theme()
        (site.out / STYLESHEET).write_text("/* an old theme */\n", encoding="utf-8")
        (site.out / PAGE_SCRIPT).unlink()
        self.assertNotEqual((site.out / STYLESHEET).read_bytes(), expected[STYLESHEET])

        site.start()

        for name, data in expected.items():
            self.assertEqual((site.out / name).read_bytes(), data, name)
            status, served = fetch(f"{site.url}/{name}")
            self.assertEqual(status, 200, name)
            self.assertEqual(served, data, name)


if __name__ == "__main__":
    unittest.main()
