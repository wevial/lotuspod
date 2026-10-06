"""Witness: the default responder answers, through the agent socket and
its own credential, each comment no listening owner will take: one naming
@responder, one on a page whose owner is not listening, and one an owner
only read past the owner window. When its agent edits the page source it
republishes with one commit, and its reply links the new revision. It
leaves a listening owner's comment and an offline handle's mention alone,
never overwrites a concurrent edit, does nothing while paused, records who
replied, and after a crash between republishing and replying it replies
without running the agent or editing again.

The agent command is a stand-in script for `claude -p`. Pages live in a
clone of a local bare repository, so every republish is a real commit.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
TIMEOUT = 120
ISSUER = "https://witness.cloudflareaccess.com"
AUDIENCE = "witness-audience"
READER = "maintainer@example.com"
ASSERTION = "Cf-Access-Jwt-Assertion"

# A 2048-bit RSA key made for these tests only (see
# tests/fixtures/access/README.md). It signs the Access assertions below, and
# the site is configured to trust its public half.
WITNESS_KEY = json.loads(
    (REPO / "tests" / "fixtures" / "access" / "witness-key.json").read_text(encoding="utf-8"))


def jwk_int(text: str) -> int:
    return int.from_bytes(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)), "big")


N, E, D = (jwk_int(WITNESS_KEY[field]) for field in ("n", "e", "d"))
KID = WITNESS_KEY["kid"]
DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign(signing_input: bytes) -> bytes:
    size = (N.bit_length() + 7) // 8
    digest = DIGEST_INFO + hashlib.sha256(signing_input).digest()
    encoded = b"\x00\x01" + b"\xff" * (size - len(digest) - 3) + b"\x00" + digest
    return pow(int.from_bytes(encoded, "big"), D, N).to_bytes(size, "big")


def claims(email=READER, audience=AUDIENCE, expires_in=600, issuer=ISSUER) -> dict:
    now = int(time.time())
    return {"aud": [audience], "email": email, "exp": now + expires_in, "iat": now - 5,
            "nbf": now - 5, "iss": issuer, "sub": "witness-subject", "type": "app"}


def assertion(**overrides) -> str:
    header = b64url(json.dumps({"alg": "RS256", "kid": KID, "typ": "JWT"}).encode())
    body = b64url(json.dumps(claims(**overrides)).encode())
    signing_input = f"{header}.{body}".encode("ascii")
    return f"{header}.{body}." + b64url(sign(signing_input))


def jwks() -> dict:
    size = (N.bit_length() + 7) // 8
    return {"keys": [{"kty": "RSA", "kid": KID, "alg": "RS256", "use": "sig",
                      "n": b64url(N.to_bytes(size, "big")),
                      "e": b64url(E.to_bytes(3, "big"))}]}


def revision(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def git(cwd: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True,
                          timeout=TIMEOUT)


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str):
        super().__init__("localhost", timeout=30)
        self.unix_path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(30)
        sock.connect(self.unix_path)
        self.sock = sock


class _Meta(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.values = {}

    def handle_starttag(self, tag, attrs):
        values = {key: value or "" for key, value in attrs}
        if tag == "meta" and values.get("name"):
            self.values[values["name"]] = values.get("content", "")


def page_meta(html: str, name: str) -> str:
    parser = _Meta()
    parser.feed(html)
    return parser.values.get(name, "")


class Site(unittest.TestCase):
    """A site published with this checkout's CLI and served by `lotuspod serve`
    with its database, its agent socket, and an Access configuration that
    trusts the test key above."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.out = self.tmp / "site"
        self.db = self.tmp / "lotuspod.sqlite3"
        self.sock = self.tmp / "lotuspod.sock"
        keys = self.tmp / "jwks.json"
        keys.write_text(json.dumps(jwks()), encoding="utf-8")
        config = self.tmp / "config.ini"
        config.write_text("\n".join([
            "[access]", f"issuer = {ISSUER}", f"audience = {AUDIENCE}",
            f"certs_url = {keys.as_uri()}", f"allowed_emails = {READER}", ""]),
            encoding="utf-8")
        self.env = dict(os.environ, PYTHONPATH=str(SRC), LOTUSPOD_CONFIG=str(config))

    def cli(self, *argv: str, env=None) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "lotuspod", *argv],
                              cwd=str(self.tmp), env=env or self.env,
                              capture_output=True, text=True, timeout=TIMEOUT)

    def start_server(self, out=None, db=None, sock=None, extra=()):
        out, db, sock = out or self.out, db or self.db, sock or self.sock
        self.port = free_port()
        log = open(self.tmp / f"serve-{self.port}.log", "w+", encoding="utf-8")
        self.addCleanup(log.close)
        server = subprocess.Popen(
            [sys.executable, "-m", "lotuspod", "serve", "--host", "127.0.0.1",
             "--port", str(self.port), "--out-dir", str(out), "--db", str(db),
             "--socket", str(sock), *extra],
            cwd=str(self.tmp), env=self.env, stdout=log, stderr=log)
        self.addCleanup(server.wait, 10)
        self.addCleanup(server.terminate)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if server.poll() is not None:
                log.seek(0)
                self.fail(f"serve exited {server.returncode}: {log.read()}")
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=1).close()
                if sock.exists():
                    return server
            except OSError:
                pass
            time.sleep(0.2)
        self.fail("serve did not start listening on its port and its socket")

    def api(self, method, path, payload=None, token="valid", headers=None):
        """A request through the site's port, as Cloudflare Access forwards it.
        `token` is an assertion, "valid" for the reader's, or None for none."""
        sent = dict(headers or {})
        if token == "valid":
            token = assertion()
        if token:
            sent[ASSERTION] = token
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            sent["Content-Type"] = "application/json"
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}",
                                         data=data, headers=sent, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, info, raw = response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            status, info, raw = error.code, error.headers, error.read()
            error.close()
        except OSError as error:
            self.fail(f"{method} {path} failed: {error}")
        try:
            return status, info, json.loads(raw.decode("utf-8"))
        except ValueError:
            return status, info, raw.decode("utf-8", "replace")

    def machine(self, method, path, payload=None, token=None):
        """A request on the agent socket, with a machine credential's token."""
        connection = _UnixConnection(str(self.sock))
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            status, raw = response.status, response.read()
        except OSError as error:
            self.fail(f"{method} {path} on the socket failed: {error}")
        finally:
            connection.close()
        try:
            return status, json.loads(raw.decode("utf-8"))
        except ValueError:
            return status, None

    def credential(self, name, handles, ops) -> Path:
        path = self.tmp / f"{name}.credential"
        argv = ["credential", "create", name, "--out", str(path), "--db", str(self.db)]
        for handle in handles:
            argv += ["--handle", handle]
        for op in ops:
            argv += ["--op", op]
        done = self.cli(*argv)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        return path

    def agent(self, credential, *argv, env=None):
        """`lotuspod comments ...` as an agent: its exit code and its JSON."""
        done = self.cli("comments", *argv, "--credential", str(credential),
                        "--socket", str(self.sock), "--json", env=env)
        try:
            return done.returncode, json.loads(done.stdout)
        except ValueError:
            return done.returncode, {"unparsed": done.stdout, "stderr": done.stderr}

    def pull(self, credential, owner):
        code, body = self.agent(credential, "pull", "--owner", owner)
        self.assertEqual(code, 0, body)
        self.assertIsInstance(body.get("items"), list, body)
        return body["items"]

    def comment(self, page, section, text):
        status, _, row = self.api("POST", "/api/comments",
                                  {"page": page, "section": section, "text": text})
        self.assertEqual(status, 201, row)
        return row

    def thread(self, page, root_id):
        status, _, body = self.api("GET", f"/api/comments?page={page}")
        self.assertEqual(status, 200, body)
        for found in body.get("threads", []):
            if found["root"].get("id") == root_id:
                return found
        self.fail(f"no thread {root_id} on {page}")


TENDED = """\
# Tended page

## Summary

A page whose owner is listening.

## Detail

Some detail.
"""

ORPHAN = """\
# Orphan page

## Greeting

A distinctive source line: lilies at dusk.

## Other

Nothing here.
"""

RACE = ORPHAN.replace("Nothing here.", "Someone else edited this at the same moment.")

AGENT = """\
import json, os, pathlib, subprocess, sys
prompt = sys.stdin.read()
with open(os.environ["WITNESS_PROMPTS"], "a", encoding="utf-8") as log:
    log.write(json.dumps(prompt) + "\\n")
source = pathlib.Path(os.environ["LOTUSPOD_PAGE_SOURCE"])
if "add a line that says hello" in prompt:
    source.write_text(source.read_text(encoding="utf-8") + "\\nHello from the responder.\\n",
                      encoding="utf-8")
    print("Added the hello line.")
elif "rewrite the other section" in prompt:
    subprocess.run([sys.executable, "-m", "lotuspod", "publish", os.environ["WITNESS_RACE"],
                    "--name", "orphan", "--out-dir", os.environ["WITNESS_OUT"]], check=True)
    source.write_text(source.read_text(encoding="utf-8") + "\\nThe responder's rewrite.\\n",
                      encoding="utf-8")
    print("Rewrote it.")
else:
    print("Glad to help.")
"""

ALL_OPS = ["pull", "claim", "reply", "publish"]


class ResponderWitness(Site):
    def setUp(self):
        super().setUp()
        self.bare = self.tmp / "origin.git"
        for argv in (("init", "-q", "--bare", "-b", "main", str(self.bare)),
                     ("clone", "-q", str(self.bare), str(self.out))):
            done = git(self.tmp, *argv)
            self.assertEqual(done.returncode, 0, done.stderr)
        for key, value in (("user.name", "Witness"),
                           ("user.email", "witness@example.com"),
                           ("commit.gpgsign", "false")):
            git(self.out, "config", key, value)
        self.prompts = self.tmp / "prompts.jsonl"
        race = self.tmp / "race.md"
        race.write_text(RACE, encoding="utf-8")
        self.env.update(WITNESS_PROMPTS=str(self.prompts), WITNESS_RACE=str(race),
                        WITNESS_OUT=str(self.out))
        agent = self.tmp / "agent.py"
        agent.write_text(AGENT, encoding="utf-8")
        self.command = shlex.join([sys.executable, str(agent)])
        self.operator = self.credential("operator", ["operator"], ALL_OPS)
        self.responder = self.credential("responder", ["responder"], ALL_OPS)
        gone = self.credential("gone", ["hermes-gone"], ALL_OPS)
        for name, text, owner, credential in (("tended", TENDED, "operator", self.operator),
                                              ("orphan", ORPHAN, "hermes-gone", gone)):
            source = self.tmp / f"{name}.md"
            source.write_text(text, encoding="utf-8")
            done = self.cli("publish", str(source), "--owner", owner, "--credential",
                            str(credential), "--db", str(self.db), "--out-dir", str(self.out))
            self.assertEqual(done.returncode, 0, done.stderr)
        self.start_server(extra=("--owner-window", "300"))

    def respond(self, *extra, sock=None, env=None):
        return self.cli("respond", "--once", "--command", self.command,
                        "--credential", str(self.responder), "--socket", str(sock or self.sock),
                        "--out-dir", str(self.out), "--db", str(self.db), *extra, env=env)

    def replies(self, page, root_id):
        return [(r.get("text"), (r.get("actor") or {}).get("handle"))
                for r in self.thread(page, root_id)["replies"]]

    def prompt_log(self):
        if not self.prompts.exists():
            return []
        return [json.loads(line) for line in self.prompts.read_text().splitlines() if line]

    def commits(self) -> int:
        done = git(self.bare, "rev-list", "--count", "main")
        return int(done.stdout) if done.returncode == 0 else 0

    def served(self, name):
        status, _, html = self.api("GET", f"/{name}.html")
        self.assertEqual(status, 200)
        return html

    def test_the_responder_takes_what_no_listening_owner_will_and_links_its_revision(self):
        self.assertEqual(self.pull(self.operator, "operator"), [])
        self.assertEqual(self.commits(), 2)
        left = self.comment("tended", "summary", "Please tighten this.")
        asked = self.comment("tended", "detail", "@responder what does this mean?")
        away = self.comment("tended", "detail", "@hermes-away can you check this?")
        edit = self.comment("orphan", "greeting", "Please add a line that says hello.")

        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)

        self.assertEqual(self.replies("orphan", edit.get("id")),
                         [("Added the hello line.", "responder")])
        self.assertEqual(self.replies("tended", asked.get("id")), [("Glad to help.", "responder")])
        self.assertEqual(self.replies("tended", left.get("id")), [])
        self.assertEqual(self.thread("tended", left.get("id"))["root"].get("state"), "pending")
        self.assertEqual(self.replies("tended", away.get("id")), [])
        self.assertEqual(self.thread("tended", away.get("id"))["root"].get("state"), "unavailable")
        prompts = self.prompt_log()
        self.assertEqual(len(prompts), 2)
        edit_prompt = next(p for p in prompts if "add a line that says hello" in p)
        self.assertIn("lilies at dusk", edit_prompt)

        self.assertEqual(self.commits(), 3)
        self.assertIn(b"Hello from the responder.", git(self.bare, "show", "main:orphan.md").stdout)
        page = self.served("orphan")
        self.assertIn("Hello from the responder.", page)
        reply = self.thread("orphan", edit.get("id"))["replies"][0]
        self.assertEqual(reply.get("revision"), page_meta(page, "lotuspod:revision"))

        done = self.cli("audit", "--json", "--db", str(self.db))
        self.assertEqual(done.returncode, 0, done.stderr)
        try:
            entries = json.loads(done.stdout)
        except ValueError:
            self.fail(f"`lotuspod audit --json` printed no JSON: {done.stdout!r}")
        replied = [(e.get("credential"), e.get("handle")) for e in entries
                   if e.get("action") == "reply" and e.get("comment") == edit.get("id")]
        self.assertEqual(replied, [("responder", "responder")])

        items = self.pull(self.operator, "operator")
        self.assertEqual([item["comment"].get("id") for item in items], [left.get("id")])

        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.prompt_log()), 2)
        self.assertEqual(self.commits(), 3)
        self.assertEqual(len(self.replies("orphan", edit.get("id"))), 1)

    def test_an_owner_that_only_reads_does_not_hold_a_comment_past_the_window(self):
        brief = self.tmp / "brief.sock"
        self.start_server(sock=brief, extra=("--owner-window", "1"))
        self.sock = brief
        self.pull(self.operator, "operator")
        left = self.comment("tended", "summary", "Please tighten this.")
        time.sleep(1.5)
        self.assertEqual(len(self.pull(self.operator, "operator")), 1)
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.replies("tended", left.get("id")), [("Glad to help.", "responder")])

    def test_a_concurrent_edit_is_never_overwritten(self):
        clash = self.comment("orphan", "other", "Please rewrite the other section.")
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.replies("orphan", clash.get("id")), [])
        self.assertEqual(self.thread("orphan", clash.get("id"))["root"].get("state"), "failed")
        page = self.served("orphan")
        self.assertIn("Someone else edited this at the same moment.", page)
        self.assertNotIn("The responder's rewrite.", page)
        self.assertEqual(self.commits(), 3)

    def test_a_paused_responder_answers_nothing_until_resumed(self):
        done = self.cli("respond", "pause", "--db", str(self.db))
        self.assertEqual(done.returncode, 0, done.stderr)
        waiting = self.comment("orphan", "other", "Why is this section empty?")
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.prompt_log(), [])
        self.assertEqual(self.thread("orphan", waiting.get("id"))["root"].get("state"), "paused")
        done = self.cli("respond", "resume", "--db", str(self.db))
        self.assertEqual(done.returncode, 0, done.stderr)
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.replies("orphan", waiting.get("id")), [("Glad to help.", "responder")])

    def test_a_crash_after_republishing_is_reconciled_without_a_second_edit(self):
        edit = self.comment("orphan", "greeting", "Please add a line that says hello.")
        crashing = dict(self.env, LOTUSPOD_RESPONDER_CRASH_AFTER="publish")
        done = self.respond(env=crashing)
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(self.commits(), 3)
        self.assertEqual(self.replies("orphan", edit.get("id")), [])
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.replies("orphan", edit.get("id")),
                         [("Added the hello line.", "responder")])
        self.assertEqual(self.commits(), 3)
        self.assertEqual(len(self.prompt_log()), 1)
        reply = self.thread("orphan", edit.get("id"))["replies"][0]
        self.assertEqual(reply.get("revision"),
                         page_meta(self.served("orphan"), "lotuspod:revision"))


if __name__ == "__main__":
    unittest.main()
