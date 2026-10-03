"""Agents reach `lotuspod serve` through its Unix socket, each with a machine
credential bound to the handles and operations it may use: `lotuspod
credential create|list|revoke`, the socket's /v1/ routes and their
refusals, the socket file's life, and the agents page's word on the limit.

Run from the repo root:

    python -m unittest tests.test_machine -v
"""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import os
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import cli, db, machine  # noqa: E402
from tests import access_keys as keys  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class MachineTestCase(unittest.TestCase):
    """A work directory with an artifacts directory, a config trusting the
    test Access key, and the database serve keeps beside them."""

    def setUp(self) -> None:
        # A short directory: a Unix socket's path is limited to about 100 bytes.
        tmp = tempfile.TemporaryDirectory(dir="/tmp" if Path("/tmp").is_dir() else None)
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name).resolve()
        self.out_dir = self.work / "artifacts"
        self.out_dir.mkdir()
        self.db_path = self.work / db.DEFAULT_NAME
        self.socket_path = self.work / machine.SOCKET_NAME
        self.config = self.work / "config.ini"
        self.config.write_text(keys.config_text(), encoding="utf-8")
        env = mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(self.config)})
        env.start()
        self.addCleanup(env.stop)
        for handler in (cli._AllowListHandler, machine._Handler):
            patcher = mock.patch.object(handler, "log_message", lambda *a: None)
            patcher.start()
            self.addCleanup(patcher.stop)

    def credential(self, name: str, *extra: str, out: Path | None = None) -> tuple[int, str, str]:
        out = out or self.work / f"{name}.token"
        return run_cli("credential", "create", name, *extra, "--out", str(out),
                       "--out-dir", str(self.out_dir))

    def listed(self) -> list[dict]:
        rc, out, err = run_cli("credential", "list", "--json", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        return json.loads(out)["credentials"]

    def hermes(self) -> str:
        """The token of hermes, a credential for handle hermes to pull and reply."""
        rc, _out, err = self.credential("hermes", "--handle", "hermes",
                                        "--op", "pull", "--op", "reply")
        self.assertEqual(rc, 0, err)
        return (self.work / "hermes.token").read_text(encoding="ascii").strip()


class CreateTests(MachineTestCase):
    def test_create_writes_the_token_only_to_its_file(self):
        token = self.hermes()
        token_file = self.work / "hermes.token"
        self.assertEqual(token_file.read_text(encoding="ascii"), token + "\n")
        self.assertEqual(len(token.split()), 1)
        self.assertGreaterEqual(len(token), 43)
        self.assertEqual(stat.S_IMODE(token_file.stat().st_mode), 0o600)

        stored = b"".join(path.read_bytes() for path in self.work.glob(db.DEFAULT_NAME + "*"))
        self.assertTrue(stored)
        self.assertNotIn(token.encode("ascii"), stored)
        self.assertIn(hashlib.sha256(token.encode("ascii")).hexdigest().encode("ascii"), stored)

        rc, out, err = run_cli("credential", "list", "--json", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        self.assertNotIn(token, out)
        [row] = json.loads(out)["credentials"]
        self.assertEqual(row["name"], "hermes")
        self.assertEqual(row["handles"], ["hermes"])
        self.assertEqual(row["operations"], ["pull", "reply"])
        self.assertIsNone(row["revokedAt"])
        self.assertEqual(set(row), {"name", "handles", "operations", "createdAt", "revokedAt"})

        rc, out, err = run_cli("credential", "list", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        self.assertIn("hermes", out)
        self.assertNotIn(token, out)

    def files(self) -> dict:
        """Every file under the work directory, the database included, with its bytes."""
        return {str(p): p.read_bytes() for p in sorted(self.work.rglob("*")) if p.is_file()}

    def test_refused_creates_store_nothing_and_change_no_file(self):
        # A version-1 database: opening it would migrate it, and change its bytes.
        conn = sqlite3.connect(str(self.db_path))
        for statement in db._SCHEMA[1]:
            conn.execute(statement)
        conn.execute("PRAGMA user_version = 1")
        conn.commit()
        conn.close()
        existing = self.work / "existing.token"
        existing.write_text("keep me\n", encoding="utf-8")
        cases = {
            "operation admin": (("--handle", "hermes", "--op", "admin"), None, "admin"),
            "handle Not A Handle": (("--handle", "Not A Handle", "--op", "pull"), None,
                                    "Not A Handle"),
            "existing --out": (("--handle", "hermes", "--op", "pull"), existing,
                               str(existing)),
        }
        for label, (extra, out, named) in cases.items():
            with self.subTest(label):
                before = self.files()
                rc, _out, err = self.credential("hermes", *extra, out=out)
                self.assertNotEqual(rc, 0)
                self.assertIn(named, err)
                self.assertEqual(self.files(), before)
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep me\n")
        self.assertEqual(self.listed(), [])

    def test_a_name_is_used_once(self):
        self.hermes()
        rc, _out, err = self.credential("hermes", "--handle", "hermes", "--op", "pull",
                                        out=self.work / "again.token")
        self.assertEqual(rc, 1)
        self.assertIn("already exists", err)
        self.assertFalse((self.work / "again.token").exists())
        self.assertEqual(len(self.listed()), 1)

    def test_revoke_names_a_credential(self):
        rc, _out, err = run_cli("credential", "revoke", "nobody", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 1)
        self.assertIn("nobody", err)
        self.hermes()
        rc, _out, err = run_cli("credential", "revoke", "hermes", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        self.assertIsNotNone(self.listed()[0]["revokedAt"])

    def test_a_version_one_database_gains_credentials_and_keeps_its_rows(self):
        conn = sqlite3.connect(str(self.db_path))
        for statement in db._SCHEMA[1]:
            conn.execute(statement)
        conn.execute("PRAGMA user_version = 1")
        conn.commit()
        conn.close()
        database = db.Database(self.db_path)
        database.add_comment(page="plan", section="s", section_title="", revision="r",
                             text="hi", quote=None, actor={"kind": "human"})
        self.hermes()
        self.assertEqual(len(database.threads("plan")), 1)
        self.assertEqual([row["name"] for row in self.listed()], ["hermes"])


class ServeTestCase(MachineTestCase):
    """`lotuspod serve` running on a thread, its port and its socket."""

    def setUp(self) -> None:
        super().setUp()
        made = {}
        ready = threading.Event()
        real_port, real_socket = cli._make_server, machine.SocketServer

        def make_port(*args, **kwargs):
            made["port"] = real_port(*args, **kwargs)
            return made["port"]

        def make_socket(*args, **kwargs):
            made["socket"] = real_socket(*args, **kwargs)
            ready.set()
            return made["socket"]

        results = {}

        def serve() -> None:
            results["rc"] = cli.main(["serve", "--host", HOST, "--port", "0",
                                      "--out-dir", str(self.out_dir)])

        patches = (mock.patch.object(cli, "_make_server", make_port),
                   mock.patch.object(machine, "SocketServer", make_socket))
        for patcher in patches:
            patcher.start()
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            self.thread = threading.Thread(target=serve, daemon=True)
            self.thread.start()
            started = ready.wait(15)
        for patcher in patches:
            patcher.stop()
        self.assertTrue(started, output.getvalue())
        self.port = made["port"].server_address[1]
        self.results = results

        def stop() -> None:
            if self.thread.is_alive():
                made["port"].shutdown()
                self.thread.join(timeout=15)

        self.stop = stop
        self.addCleanup(stop)

    def ask(self, token: str | None, target: str, method: str = "GET",
            body: object = None) -> tuple[int, dict]:
        """(status, JSON payload) on the socket; every answer must be no-store JSON."""
        headers = {} if token is None else {"Authorization": f"Bearer {token}"}
        data = None if body is None else json.dumps(body).encode("utf-8")
        if data is not None:
            headers["Content-Type"] = "application/json"
        conn = machine.UnixConnection(self.socket_path, timeout=15)
        try:
            conn.request(method, target, body=data, headers=headers)
            response = conn.getresponse()
            payload = response.read()
        finally:
            conn.close()
        self.assertEqual(response.getheader("Cache-Control"), "no-store", target)
        self.assertEqual(response.getheader("Content-Type"), "application/json", target)
        return response.status, json.loads(payload.decode("utf-8"))


class SocketTests(ServeTestCase):
    def test_whoami_answers_the_credential_and_only_its_token(self):
        token = self.hermes()
        status, payload = self.ask(token, "/v1/whoami")
        self.assertEqual(status, 200)
        credential = payload["credential"]
        self.assertEqual(credential["name"], "hermes")
        self.assertEqual(credential["handles"], ["hermes"])
        self.assertEqual(credential["operations"], ["pull", "reply"])
        self.assertNotIn("tokenHash", credential)
        self.assertEqual(machine.request(self.socket_path, token, "GET", "/v1/whoami"),
                         (status, payload))

        refused = (401, {"error": "invalid_credential"})
        self.assertEqual(self.ask(None, "/v1/whoami"), refused)
        self.assertEqual(self.ask(token[:-1] + ("A" if token[-1] != "A" else "B"),
                                  "/v1/whoami"), refused)
        rc, _out, err = run_cli("credential", "revoke", "hermes", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.ask(token, "/v1/whoami"), refused)

    def test_malformed_authorization_is_invalid(self):
        token = self.hermes()
        for header in (token, f"Basic {token}", "Bearer", "Bearer "):
            with self.subTest(header=header):
                conn = machine.UnixConnection(self.socket_path, timeout=15)
                conn.request("GET", "/v1/whoami", headers={"Authorization": header})
                response = conn.getresponse()
                self.assertEqual(json.loads(response.read()), {"error": "invalid_credential"})
                conn.close()
                self.assertEqual(response.status, 401)

    def test_check_holds_the_credential_to_its_handles_and_operations(self):
        token = self.hermes()
        self.assertEqual(
            self.ask(token, "/v1/check?op=pull&handle=hermes"),
            (200, {"allowed": True, "op": "pull", "handle": "hermes"}),
        )
        self.assertEqual(self.ask(token, "/v1/check?op=pull&handle=claude-3f9a2c"),
                         (403, {"error": "handle_not_allowed"}))
        self.assertEqual(self.ask(token, "/v1/check?op=publish&handle=hermes"),
                         (403, {"error": "operation_not_allowed"}))
        for query in ("", "?op=pull", "?op=pull&handle=hermes&handle=x",
                      "?op=pull&handle=hermes&extra=1"):
            with self.subTest(query=query):
                self.assertEqual(self.ask(token, "/v1/check" + query),
                                 (400, {"error": "invalid_query"}))

    def test_the_socket_answers_only_v1_and_the_port_never_does(self):
        token = self.hermes()
        answer = {"page": "plan", "question": "q", "version": "v1", "choice": "yes", "note": ""}
        self.assertEqual(self.ask(token, "/api/answers", "POST", answer)[0], 404)
        self.assertEqual(self.ask(token, "/api/whoami")[0], 404)
        self.assertEqual(self.ask(token, "/api/comments", "POST",
                                  {"page": "plan", "section": "s", "text": "hi"})[0], 404)
        database = db.Database(self.db_path)
        self.assertEqual(database.answers("plan"), {})
        self.assertEqual(database.threads("plan"), [])

        for headers in ({"Authorization": f"Bearer {token}"},
                        {"Authorization": f"Bearer {token}",
                         "Cf-Access-Jwt-Assertion": keys.assertion()}):
            conn = http.client.HTTPConnection(HOST, self.port, timeout=15)
            try:
                conn.request("GET", "/v1/whoami", headers=headers)
                response = conn.getresponse()
                response.read()
            finally:
                conn.close()
            self.assertEqual(response.status, 404)

    def test_other_methods_are_not_allowed(self):
        token = self.hermes()
        status, payload = self.ask(token, "/v1/whoami", "POST", {})
        self.assertEqual((status, payload), (405, {"error": "method_not_allowed"}))
        self.assertEqual(self.ask(None, "/v1/whoami", "DELETE")[0], 401)

    def test_the_socket_is_the_owners_alone_and_goes_when_serve_stops(self):
        self.assertTrue(stat.S_ISSOCK(os.lstat(self.socket_path).st_mode))
        self.assertEqual(stat.S_IMODE(os.lstat(self.socket_path).st_mode), 0o600)
        self.stop()
        self.assertFalse(self.thread.is_alive())
        self.assertEqual(self.results.get("rc"), 0)
        self.assertFalse(os.path.lexists(self.socket_path))

    def test_a_second_serve_will_not_take_a_socket_something_answers_on(self):
        rc, _out, err = run_cli("serve", "--host", HOST, "--port", "0",
                                "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 1)
        self.assertIn("something already answers", err)
        self.assertTrue(stat.S_ISSOCK(os.lstat(self.socket_path).st_mode))


class ServeProcessTests(MachineTestCase):
    """`lotuspod serve` as its own process, stopped by a signal."""

    def serve(self) -> subprocess.Popen:
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(REPO_ROOT / "src"), *filter(None, [env.get("PYTHONPATH")])]
        )
        proc = subprocess.Popen(
            [sys.executable, "-m", "lotuspod", "serve", "--host", HOST, "--port", "0",
             "--out-dir", str(self.out_dir), "--socket", str(self.socket_path)],
            cwd=self.work, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

        def reap() -> None:
            if proc.poll() is None:
                proc.kill()
            proc.communicate(timeout=15)

        self.addCleanup(reap)
        # Once the socket answers, serve is past setting its signal handler.
        deadline = time.monotonic() + 15
        while True:
            try:
                status, _ = machine.request(self.socket_path, None, "GET", "/v1/whoami")
                self.assertEqual(status, 401)
                return proc
            except OSError:
                if proc.poll() is not None or time.monotonic() > deadline:
                    _out, err = proc.communicate(timeout=15)
                    self.fail(f"serve never answered on its socket: {err!r}")
                time.sleep(0.05)

    def test_sigterm_and_sigint_stop_serve_and_remove_the_socket(self):
        for signum in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=signum.name):
                proc = self.serve()
                self.assertEqual(stat.S_IMODE(os.lstat(self.socket_path).st_mode), 0o600)
                proc.send_signal(signum)
                _out, err = proc.communicate(timeout=15)
                self.assertEqual(proc.returncode, 0, err)
                self.assertFalse(os.path.lexists(self.socket_path))


class StaleSocketTests(MachineTestCase):
    def test_a_stale_socket_is_removed_and_a_file_is_not(self):
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(str(self.socket_path))
        stale.close()
        server = machine.SocketServer(self.socket_path, db.Database(self.db_path))
        server.server_close()
        self.assertFalse(os.path.lexists(self.socket_path))

        self.socket_path.write_text("not a socket", encoding="utf-8")
        with self.assertRaises(machine.SocketInUse):
            machine.SocketServer(self.socket_path, db.Database(self.db_path))
        self.assertEqual(self.socket_path.read_text(encoding="utf-8"), "not a socket")


class ClientOptionTests(MachineTestCase):
    def args(self, **values):
        parser = cli.argparse.ArgumentParser()
        cli.add_agent_options(parser)
        argv = [f"--{key}={value}" for key, value in values.items()]
        return parser.parse_args(argv)

    def test_socket_comes_from_the_flag_then_the_config_then_the_default(self):
        self.assertEqual(cli.agent_socket(self.args(socket="/x.sock")), Path("/x.sock"))
        self.assertEqual(cli.agent_socket(self.args()),
                         cli.DEFAULT_OUTPUT_DIR.parent / machine.SOCKET_NAME)
        self.config.write_text("[agents]\nsocket = /run/l.sock\n", encoding="utf-8")
        self.assertEqual(cli.agent_socket(self.args()), Path("/run/l.sock"))
        self.assertEqual(cli.serve_socket_path(self.db_path, ""), Path("/run/l.sock"))

    def test_credential_comes_from_the_flag_then_the_environment(self):
        token = self.hermes()
        path = str(self.work / "hermes.token")
        self.assertEqual(cli.agent_token(self.args(credential=path)), token)
        with mock.patch.dict(os.environ, {machine.CREDENTIAL_ENV: path}):
            self.assertEqual(cli.agent_token(self.args()), token)
        with mock.patch.dict(os.environ, {machine.CREDENTIAL_ENV: ""}), \
                self.assertRaises(cli.ConfigError):
            cli.agent_token(self.args())


class ReadmeTests(unittest.TestCase):
    def test_the_agent_section_states_the_same_user_limit(self):
        readme = (REPO_ROOT / "docs" / "agents.md").read_text(encoding="utf-8")
        start = readme.index("## Agent credentials\n")
        end = readme.index("\n## ", start + 1)
        section = " ".join(readme[start:end].split())
        self.assertIn("processes running as the same user are not isolated from one another",
                      section)
        self.assertIn("lotuspod credential create", section)


if __name__ == "__main__":
    unittest.main()
