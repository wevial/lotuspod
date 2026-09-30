"""Witness: `lotuspod backup` takes one backup set of the answers-and-comments
database and the artifacts repository together while the site is serving,
and `lotuspod restore` rebuilds both from it into fresh paths: the restored
site serves the pages and the comments as they stood at the backup, and
nothing written later. A restore refuses to write over an existing database
or site.

Real git with a local bare repository; the site is served by
`lotuspod serve`, and the reader's requests carry Access assertions signed
with a test key the site trusts.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
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

# A 2048-bit RSA key made for these tests only. It signs the Access
# assertions below, and the site is configured to trust its public half.
N = int(
    "ae0b28f6dfaf477ace5e4304c113092352c8d5d72ffed0918820b8497c4cb16b"
    "4a7073047e2ccf4c121fbdaa6b405260322585551c591673e61b7a26f440c09b"
    "de98beb76cfefa2fccd595be3cfff060966c15dd4fb0173466f39465283bcffe"
    "0a17586ae966ab29a68764c451c5c4874ef487f5793246b31fca391e8a883bcf"
    "a0dc731ab6920ad894494f9824266f6b23a589485b5b3db71bd07b5e7fc72be2"
    "005ba5b89acdf9e469d6c205050ee634196a62017796f5e3e048faa68d738d5f"
    "dc3e8b02d2877e865eed86578a9adace7f9d35cb441e20d116f0a19b1e24b13d"
    "51aa2f22e67343eabcb640bbce8cd9f3ce1b1a38f6bd2589aa1dfcd13b2e8237", 16)
D = int(
    "a2a1db0d95c7fc4b4d3bd7f44156c05b39a861ea4af7197e646deec6fc57ce12"
    "2be5181542b22ca330ec68172f5153a880337f7c20993ed9de541eb8f7d4ea26"
    "bcc28eb4682d7b2bdf845601068f42d77eb851561478bfb63fddacf539bb6a88"
    "4075c03167188128d26c0245510434b91b9674d57502fdfdb3df0bb0f652874f"
    "dac0e84e720a4320648a70b941656bbddcb117a81e90520fe586888127ec3894"
    "19b0e01a2df00213115a0337f9f76bf2e8738b481db8a48c475590ac8b21fbe8"
    "db3fd2e762fa01e2760415dc0451d05b7aeb4f162311361c4d895dff753575fd"
    "402f0cf5aea490edf52d588be351ec8df4d1c578a928d6921e3c9350b2a6959", 16)
E = 65537
KID = "witness-key"
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


PAGE = """\
# Kept page

## First

Something worth keeping.

## Second

More of it.
"""


class BackupWitness(Site):
    def setUp(self):
        super().setUp()
        self.bare = self.tmp / "origin.git"
        for argv in (("init", "-q", "--bare", "-b", "main", str(self.bare)),
                     ("clone", "-q", str(self.bare), str(self.out))):
            done = git(self.tmp, *argv)
            self.assertEqual(done.returncode, 0, done.stderr)
        for key, value in (("user.name", "Witness"),
                           ("user.email", "witness@lotuspod.invalid"),
                           ("commit.gpgsign", "false")):
            git(self.out, "config", key, value)
        source = self.tmp / "kept.md"
        source.write_text(PAGE, encoding="utf-8")
        done = self.cli("publish", str(source), "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.start_server()

    def texts(self, page="kept"):
        status, _, body = self.api("GET", f"/api/comments?page={page}")
        self.assertEqual(status, 200, body)
        return [thread["root"].get("text") for thread in body.get("threads", [])]

    def test_a_backup_taken_while_serving_restores_the_database_and_the_pages_together(self):
        self.comment("kept", "first", "Kept before the backup.")
        head = git(self.out, "rev-parse", "HEAD").stdout.strip()
        backups = self.tmp / "backups"
        done = self.cli("backup", "--db", str(self.db), "--out-dir", str(self.out),
                        "--to", str(backups), "--json")
        self.assertEqual(done.returncode, 0, done.stderr)
        try:
            made = Path(json.loads(done.stdout)["backup"])
        except (ValueError, KeyError, TypeError):
            self.fail(f"`lotuspod backup --json` named no backup: {done.stdout!r}")
        self.assertTrue(made.is_dir())
        self.assertTrue(made.resolve().is_relative_to(backups.resolve()))

        self.comment("kept", "second", "Written after the backup.")
        self.assertEqual(len(self.texts()), 2)

        restored_out = self.tmp / "restored-site"
        restored_db = self.tmp / "restored.sqlite3"
        done = self.cli("restore", str(made), "--db", str(restored_db),
                        "--out-dir", str(restored_out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(git(restored_out, "rev-parse", "HEAD").stdout.strip(), head)
        self.assertEqual((restored_out / "kept.md").read_text(encoding="utf-8"), PAGE)

        self.start_server(out=restored_out, db=restored_db, sock=self.tmp / "restored.sock")
        self.assertEqual(self.texts(), ["Kept before the backup."])
        status, _, html = self.api("GET", "/kept.html")
        self.assertEqual(status, 200)
        self.assertIn("Something worth keeping.", html)

    def test_a_restore_never_writes_over_an_existing_database_or_site(self):
        backups = self.tmp / "backups"
        done = self.cli("backup", "--db", str(self.db), "--out-dir", str(self.out),
                        "--to", str(backups), "--json")
        self.assertEqual(done.returncode, 0, done.stderr)
        made = json.loads(done.stdout)["backup"]
        before = self.db.read_bytes()
        done = self.cli("restore", made, "--db", str(self.db),
                        "--out-dir", str(self.tmp / "elsewhere"))
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertFalse((self.tmp / "elsewhere").exists())
        done = self.cli("restore", made, "--db", str(self.tmp / "fresh.sqlite3"),
                        "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertFalse((self.tmp / "fresh.sqlite3").exists())


if __name__ == "__main__":
    unittest.main()
