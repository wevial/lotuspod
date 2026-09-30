"""Witness: the agent that owns a page reads the reader's new comment and
answer on it through the agent socket, each with the page's source and
revision; reading does not claim. The owner claims the comment, and a
competing consumer gets no second claim; the owner's reply, retried with the
same idempotency key, is stored once and shows in the thread with the
agent's verified identity. A credential cannot read another handle's queue,
a mention of an offline handle waits as unavailable, and a reader's
follow-up reaches the owner with its thread.

The site is served by `lotuspod serve` on loopback with its agent socket;
the reader's requests carry Access assertions signed with a test key the
site trusts, and the agents run the `lotuspod comments` commands.
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
# Pond review

A short review.

## Findings

Water is low.

## Risks

Risk two is overstated.

## Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| 1 | Order a pump now? | Yes / No | Yes |
"""

AGENT_OPS = ["pull", "claim", "reply"]


class _Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.sections = []
        self.forms = []
        self.owner_text = []
        self._owner_depth = 0
        self._form = None

    def handle_starttag(self, tag, attrs):
        values = {key: value or "" for key, value in attrs}
        classes = values.get("class", "").split()
        if self._owner_depth:
            self._owner_depth += 1
        elif "artifact-owner" in classes:
            self._owner_depth = 1
        if tag == "details" and "artifact-comment" in classes:
            self.sections.append(values.get("data-section", ""))
        if tag == "form" and "artifact-decision" in classes:
            self._form = {"question": values.get("data-question", ""),
                          "version": values.get("data-version", ""), "choices": []}
            self.forms.append(self._form)
        elif tag == "input" and self._form is not None and values.get("type") == "radio":
            self._form["choices"].append(values.get("value", ""))

    def handle_endtag(self, tag):
        if self._owner_depth:
            self._owner_depth -= 1
        if tag == "form":
            self._form = None

    def handle_data(self, data):
        if self._owner_depth:
            self.owner_text.append(data)


class AgentPullWitness(Site):
    def setUp(self):
        super().setUp()
        self.hermes = self.credential("hermes", ["hermes"], AGENT_OPS + ["publish"])
        self.other = self.credential("claude-3f9a2c", ["claude-3f9a2c"], AGENT_OPS)
        source = self.tmp / "pond-review.md"
        source.write_text(PAGE, encoding="utf-8")
        done = self.cli("publish", str(source), "--owner", "hermes", "--credential",
                        str(self.hermes), "--db", str(self.db), "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.start_server()
        self.html = (self.out / "pond-review.html").read_text(encoding="utf-8")
        page = _Page()
        page.feed(self.html)
        self.page = page

    def claim(self, credential, comment_id):
        return self.agent(credential, "claim", str(comment_id))

    def test_the_owner_reads_claims_and_replies_and_the_reader_sees_the_reply(self):
        self.assertIn("hermes", "".join(self.page.owner_text))
        self.assertEqual(self.page.sections,
                         ["findings", "risks", "decisions-for-the-maintainer"])
        self.assertEqual(len(self.page.forms), 1)
        self.assertEqual(self.pull(self.hermes, "hermes"), [])

        root = self.comment("pond-review", "risks", "Is risk two real?")
        self.assertEqual(root.get("actor"), {"kind": "human", "email": READER})
        self.assertEqual(root.get("state"), "pending")
        form = self.page.forms[0]
        status, _, answer = self.api("POST", "/api/answers", {
            "page": "pond-review", "question": form["question"],
            "version": form["version"], "choice": form["choices"][0], "note": ""})
        self.assertEqual(status, 201, answer)

        items = self.pull(self.hermes, "hermes")
        self.assertEqual(sorted(item.get("kind") for item in items), ["answer", "comment"])
        for item in items:
            self.assertEqual(item["page"].get("name"), "pond-review")
            self.assertEqual(item["page"].get("source"), PAGE)
            self.assertEqual(item["page"].get("revision"), revision(PAGE.encode("utf-8")))
            self.assertEqual(item["page"].get("revision"),
                             page_meta(self.html, "lotuspod:revision"))
        pulled = next(item for item in items if item["kind"] == "comment")
        self.assertEqual((pulled["comment"].get("id"), pulled["comment"].get("section"),
                          pulled["comment"].get("text"), pulled["comment"].get("actor")),
                         (root.get("id"), "risks", "Is risk two real?",
                          {"kind": "human", "email": READER}))
        answered = next(item for item in items if item["kind"] == "answer")
        self.assertEqual(answered["answer"].get("choice"), form["choices"][0])

        again = self.pull(self.hermes, "hermes")
        self.assertEqual([item["comment"].get("id") for item in again if item["kind"] == "comment"],
                         [root.get("id")], "reading the queue must not take a comment off it")

        code, refused = self.agent(self.other, "pull", "--owner", "hermes")
        self.assertNotEqual(code, 0)
        self.assertEqual(refused.get("error"), "handle_not_allowed")
        self.assertEqual(self.pull(self.other, "claude-3f9a2c"), [])
        code, refused = self.claim(self.other, root.get("id"))
        self.assertNotEqual(code, 0)
        self.assertEqual(refused.get("error"), "not_routed")

        code, claimed = self.claim(self.hermes, root.get("id"))
        self.assertEqual(code, 0, claimed)
        self.assertTrue(claimed.get("claimToken"))
        self.assertTrue(claimed.get("expiresAt"))
        self.assertEqual(self.thread("pond-review", root.get("id"))["root"].get("state"), "claimed")
        reply_args = ("reply", str(root.get("id")), "--claim", claimed["claimToken"],
                      "--key", "hermes-op-1", "--text", "Agreed; cut it.")
        code, reply = self.agent(self.hermes, *reply_args)
        self.assertEqual(code, 0, reply)
        code, retried = self.agent(self.hermes, *reply_args)
        self.assertEqual(code, 0, retried)
        self.assertEqual(retried.get("id"), reply.get("id"))

        thread = self.thread("pond-review", root.get("id"))
        self.assertEqual(thread["root"].get("state"), "answered")
        self.assertEqual([(r.get("id"), r.get("text"), r.get("actor"), r.get("parent"))
                          for r in thread["replies"]],
                         [(reply.get("id"), "Agreed; cut it.",
                           {"kind": "agent", "handle": "hermes", "credential": "hermes"},
                           root.get("id"))])

        code, acked = self.agent(self.hermes, "ack-answer", str(answered["answer"].get("id")))
        self.assertEqual(code, 0, acked)
        self.assertEqual(self.pull(self.hermes, "hermes"), [])

    def test_two_consumers_racing_for_one_comment_get_exactly_one_claim(self):
        second = self.credential("hermes-two", ["hermes"], AGENT_OPS)
        self.pull(self.hermes, "hermes")
        root = self.comment("pond-review", "findings", "Which gauge was this?")
        racers = [subprocess.Popen(
            [sys.executable, "-m", "lotuspod", "comments", "claim", str(root.get("id")),
             "--credential", str(path), "--socket", str(self.sock), "--json"],
            cwd=str(self.tmp), env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True) for path in (self.hermes, second)]
        outcomes = []
        for racer in racers:
            out, _ = racer.communicate(timeout=TIMEOUT)
            try:
                outcomes.append((racer.returncode, json.loads(out)))
            except ValueError:
                outcomes.append((racer.returncode, {"unparsed": out}))
        winners = [body for code, body in outcomes if code == 0 and body.get("claimToken")]
        losers = [body for code, body in outcomes if code != 0]
        self.assertEqual(len(winners), 1, outcomes)
        self.assertEqual([body.get("error") for body in losers], ["claimed"], outcomes)

    def test_a_reply_without_the_current_claim_is_refused(self):
        self.pull(self.hermes, "hermes")
        root = self.comment("pond-review", "findings", "Which gauge was this?")
        code, claimed = self.claim(self.hermes, root.get("id"))
        self.assertEqual(code, 0, claimed)
        code, refused = self.agent(self.hermes, "reply", str(root.get("id")), "--claim",
                                   "not-the-token", "--key", "k-1", "--text", "Hello")
        self.assertNotEqual(code, 0)
        self.assertEqual(refused.get("error"), "not_claimed")
        self.assertEqual(self.thread("pond-review", root.get("id"))["replies"], [])

    def test_a_mention_of_an_offline_handle_waits_as_unavailable(self):
        self.pull(self.hermes, "hermes")
        named = self.comment("pond-review", "findings", "@hermes-desk please check these numbers")
        self.assertEqual(self.thread("pond-review", named.get("id"))["root"].get("state"),
                         "unavailable")
        self.assertEqual(self.pull(self.hermes, "hermes"), [])
        desk = self.credential("desk", ["hermes-desk"], AGENT_OPS)
        items = self.pull(desk, "hermes-desk")
        self.assertEqual([item["comment"].get("id") for item in items], [named.get("id")])
        self.assertEqual(self.thread("pond-review", named.get("id"))["root"].get("state"),
                         "pending")

    def test_a_reader_follow_up_reaches_the_owner_with_the_thread(self):
        self.pull(self.hermes, "hermes")
        root = self.comment("pond-review", "risks", "Is risk two real?")
        code, claimed = self.claim(self.hermes, root.get("id"))
        self.assertEqual(code, 0, claimed)
        code, _ = self.agent(self.hermes, "reply", str(root.get("id")), "--claim",
                             claimed["claimToken"], "--key", "k-2", "--text", "Yes.")
        self.assertEqual(code, 0)
        status, _, follow = self.api("POST", "/api/comments", {
            "page": "pond-review", "parent": root.get("id"), "text": "Why?"})
        self.assertEqual(status, 201, follow)
        self.assertEqual(follow.get("section"), "risks")
        items = self.pull(self.hermes, "hermes")
        self.assertEqual([item["comment"].get("id") for item in items], [follow.get("id")])
        self.assertEqual([c.get("text") for c in items[0]["thread"]], ["Is risk two real?", "Yes.", "Why?"])


if __name__ == "__main__":
    unittest.main()
