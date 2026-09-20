"""Test suite for `deploy/publish.sh`: export, migrate, deploy, verify, in
that order, stopping at the first failure.

The script resolves the repository root from its own location, so each test
runs a copy of it inside a throwaway repository: the real `publish` directory
is never touched. Wrangler is a fake that records its arguments, the lotuspod
command is a wrapper that records the export and then runs the real one, and
the deployed address is a local stub server answering a chosen status.

Run from the repo root:

    python -m unittest tests.test_publish_script -v
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from tests.test_manifest_v2 import SRC_DIR, make_mixed_fixture

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "deploy" / "publish.sh"

FAKE_WRANGLER = """#!/bin/sh
echo "wrangler $*" >> "$PUBLISH_TEST_LOG"
if [ "$1" = deploy ]; then
    ls "$PUBLISH_TEST_ROOT/publish" > "$PUBLISH_TEST_UPLOADED"
fi
"""

FAKE_LOTUSPOD = """#!/bin/sh
echo "lotuspod $*" >> "$PUBLISH_TEST_LOG"
exec "$PUBLISH_TEST_PYTHON" -m lotuspod "$@"
"""


class StubAddress:
    """A local server answering every anonymous GET with one status."""

    def __init__(self, status: int) -> None:
        self.requests: list[dict[str, str]] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                stub.requests.append({k.lower(): v for k, v in self.headers.items()})
                self.send_response(status)
                if status == 302:
                    self.send_header("Location", "https://signin.invalid/login")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


@unittest.skipUnless(shutil.which("curl"), "curl is needed for the anonymous check")
class PublishScriptTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name).resolve()
        self.root = base / "repo"
        (self.root / "deploy").mkdir(parents=True)
        (self.root / "worker").mkdir()
        self.script = self.root / "deploy" / "publish.sh"
        shutil.copy(SCRIPT_PATH, self.script)
        shutil.copy(REPO_ROOT / "worker" / "wrangler.toml", self.root / "worker")
        self.publish = self.root / "publish"
        self.artifacts = base / "artifacts"
        self.artifacts.mkdir()
        make_mixed_fixture(self.artifacts)

        self.log = base / "calls.log"
        self.uploaded = base / "uploaded.txt"
        self.wrangler = base / "fake-wrangler"
        self.wrangler.write_text(FAKE_WRANGLER, encoding="utf-8")
        self.wrangler.chmod(0o755)
        self.lotuspod = base / "fake-lotuspod"
        self.lotuspod.write_text(FAKE_LOTUSPOD, encoding="utf-8")
        self.lotuspod.chmod(0o755)

    def stub(self, status: int) -> StubAddress:
        address = StubAddress(status)
        self.addCleanup(address.close)
        return address

    def run_script(self, *args: str, artifacts: Path | None = None):
        env = dict(os.environ)
        env.update(
            WRANGLER=str(self.wrangler),
            LOTUSPOD=str(self.lotuspod),
            ARTIFACTS_DIR=str(artifacts or self.artifacts),
            PYTHONPATH=str(SRC_DIR),
            PUBLISH_TEST_LOG=str(self.log),
            PUBLISH_TEST_ROOT=str(self.root),
            PUBLISH_TEST_UPLOADED=str(self.uploaded),
            PUBLISH_TEST_PYTHON=sys.executable,
        )
        return subprocess.run(
            ["sh", str(self.script), *args],
            env=env, capture_output=True, text=True, timeout=60,
        )

    def calls(self) -> list[str]:
        if not self.log.exists():
            return []
        return self.log.read_text(encoding="utf-8").splitlines()


class OrderTests(PublishScriptTestCase):
    def test_staging_exports_then_migrates_then_deploys(self):
        address = self.stub(403)
        result = self.run_script("staging", address.url)
        self.assertEqual(result.returncode, 0, result.stderr)

        calls = self.calls()
        self.assertEqual(len(calls), 3, calls)
        config = str(self.root / "worker" / "wrangler.toml")
        self.assertEqual(
            calls[0],
            f"lotuspod export --out-dir {self.artifacts} --dest {self.publish}",
        )
        self.assertEqual(
            calls[1],
            f"wrangler d1 migrations apply DB --remote --env staging --config {config}",
        )
        self.assertEqual(calls[2], f"wrangler deploy --env staging --config {config}")
        self.assertTrue((self.publish / "index.html").is_file())
        self.assertTrue((self.publish / "zeta.html").is_file())
        self.assertFalse((self.publish / "alpha.html").exists())

    def test_production_passes_the_production_flag(self):
        address = self.stub(403)
        result = self.run_script("production", address.url)
        self.assertEqual(result.returncode, 0, result.stderr)
        wrangler_calls = [c for c in self.calls() if c.startswith("wrangler ")]
        self.assertEqual(len(wrangler_calls), 2)
        for call in wrangler_calls:
            self.assertIn("--env production", call)

    def test_failed_export_never_calls_wrangler(self):
        address = self.stub(403)
        missing = self.artifacts.parent / "no-such-artifacts"
        result = self.run_script("staging", address.url, artifacts=missing)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([c for c in self.calls() if c.startswith("wrangler ")], [])
        self.assertEqual(address.requests, [])

    def test_failed_migration_never_deploys(self):
        address = self.stub(403)
        self.wrangler.write_text(
            '#!/bin/sh\necho "wrangler $*" >> "$PUBLISH_TEST_LOG"\nexit 1\n',
            encoding="utf-8",
        )
        result = self.run_script("staging", address.url)
        self.assertNotEqual(result.returncode, 0)
        wrangler_calls = [c for c in self.calls() if c.startswith("wrangler ")]
        self.assertEqual(len(wrangler_calls), 1)
        self.assertIn("d1 migrations apply", wrangler_calls[0])
        self.assertEqual(address.requests, [])


class AnonymousCheckTests(PublishScriptTestCase):
    def test_200_fails_as_publicly_readable(self):
        address = self.stub(200)
        result = self.run_script("staging", address.url)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("publicly readable", result.stderr)

    def test_302_to_sign_in_passes_without_following(self):
        address = self.stub(302)
        result = self.run_script("staging", address.url)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(address.requests), 1)

    def test_403_passes(self):
        address = self.stub(403)
        result = self.run_script("staging", address.url)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_request_carries_no_credentials(self):
        address = self.stub(403)
        self.run_script("staging", address.url)
        self.assertEqual(len(address.requests), 1)
        for header in ("cookie", "authorization", "cf-access-client-id"):
            self.assertNotIn(header, address.requests[0])

    def test_unreachable_address_fails(self):
        address = self.stub(403)
        address.close()
        result = self.run_script("staging", address.url)
        self.assertNotEqual(result.returncode, 0)


class UsageTests(PublishScriptTestCase):
    def assertRefusedBeforeAnything(self, result) -> None:
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.publish.exists())

    def test_unknown_environment_exits_2(self):
        address = self.stub(403)
        self.assertRefusedBeforeAnything(self.run_script("preview", address.url))
        self.assertEqual(address.requests, [])

    def test_missing_address_exits_2(self):
        self.assertRefusedBeforeAnything(self.run_script("staging"))

    def test_empty_address_exits_2(self):
        self.assertRefusedBeforeAnything(self.run_script("staging", ""))


class PublishDirectoryTests(PublishScriptTestCase):
    def test_stale_file_is_gone_and_nothing_outside_is_removed(self):
        self.publish.mkdir()
        (self.publish / "stale.html").write_text("old run\n", encoding="utf-8")
        (self.publish / "old").mkdir()
        (self.publish / "old" / "deep.html").write_text("old run\n", encoding="utf-8")
        sentinel = self.root / "sentinel.txt"
        sentinel.write_text("keep me\n", encoding="utf-8")
        before = self.outside_snapshot()

        address = self.stub(403)
        result = self.run_script("staging", address.url)
        self.assertEqual(result.returncode, 0, result.stderr)

        uploaded = self.uploaded.read_text(encoding="utf-8").split()
        self.assertNotIn("stale.html", uploaded)
        self.assertNotIn("old", uploaded)
        self.assertIn("index.html", uploaded)
        self.assertEqual(
            sorted(uploaded), sorted(p.name for p in self.publish.iterdir())
        )
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep me\n")
        self.assertEqual(self.outside_snapshot(), before)

    def test_publish_that_is_a_symbolic_link_is_refused(self):
        elsewhere = self.root.parent / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "precious.txt").write_text("keep me\n", encoding="utf-8")
        self.publish.symlink_to(elsewhere)

        address = self.stub(403)
        result = self.run_script("staging", address.url)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])
        self.assertTrue((elsewhere / "precious.txt").is_file())

    def outside_snapshot(self) -> dict[str, bytes]:
        """Every file beside the publish directory, in the repo and around it."""
        base = self.root.parent
        return {
            str(p.relative_to(base)): p.read_bytes()
            for p in base.rglob("*")
            if p.is_file()
            and self.publish not in p.parents
            and p not in (self.log, self.uploaded)
        }


if __name__ == "__main__":
    unittest.main()
