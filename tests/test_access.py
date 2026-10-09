"""Test suite for Cloudflare Access at serve's /api (`src/lotuspod/access.py`).

serve knows the signed-in reader only from a Cf-Access-Jwt-Assertion that
verifies against the team's key set: right issuer, exact audience, unexpired,
allowed email. The plain Cf-Access-Authenticated-User-Email header is never
read. Assertions are signed with the test key in tests/fixtures/access/
(tests/access_keys.py); each HTTP test serves a rendered site on a free
loopback port.

Run from the repo root:

    python -m unittest tests.test_access -v
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from lotuspod import access, cli  # noqa: E402
from tests import access_keys as keys  # noqa: E402

HOST = "127.0.0.1"
PAGE = "/access-page.html"
# Methods every /api path is asked with: the usual ones, and words no handler
# method is named for.
API_METHODS = ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "BREW")


def render_site(out_dir: Path) -> None:
    """One visible page and the index, rendered by the CLI in process."""
    for argv in (
        ["render", "--name", "access-page", "--title", "Access page",
         "--body", "<p>A visible page.</p>", "--date", "2026-01-01",
         "--out-dir", str(out_dir)],
        ["index", "--out-dir", str(out_dir)],
    ):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            assert cli.main(argv) == 0, argv


def serve_in_thread(testcase: unittest.TestCase, server: ThreadingHTTPServer) -> None:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def stop() -> None:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    testcase.addCleanup(stop)


# Raw answers that break the HTTP protocol partway, by name.
BROKEN_ANSWERS = {
    # A chunked body whose chunk is cut short: http.client.IncompleteRead.
    "truncated chunked body": (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n400\r\n{\"keys\": ["
    ),
    # Not a status line at all: http.client.BadStatusLine.
    "bad status line": b"NOT HTTP AT ALL\r\n\r\n",
}


class KeySetServer:
    """A key set on a local HTTP server that counts the requests it answers.

    With `broken` naming one of BROKEN_ANSWERS it answers that instead.
    """

    def __init__(self, testcase: unittest.TestCase, *kids: str) -> None:
        self.kids = list(kids or (keys.KID,))
        self.requests = 0
        self.broken: str | None = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests += 1
                if owner.broken is not None:
                    self.wfile.write(BROKEN_ANSWERS[owner.broken])
                    self.close_connection = True
                    return
                body = json.dumps(keys.key_set(*owner.kids)).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer((HOST, 0), Handler)
        self.url = f"http://{HOST}:{server.server_address[1]}/cdn-cgi/access/certs"
        serve_in_thread(testcase, server)


def closed_port_url() -> str:
    with socket.socket() as sock:
        sock.bind((HOST, 0))
        port = sock.getsockname()[1]
    return f"http://{HOST}:{port}/cdn-cgi/access/certs"


def signed_with_time(claim: str, text: str, now: float | None = None) -> str:
    """An assertion signed by the test key whose claim is the raw JSON text
    given (NaN, 1e400, ...): what json.dumps would not write."""
    body = json.dumps(keys.claims(now=now, **{claim: "TIME"}), separators=(",", ":"))
    body = body.replace('"TIME"', text)
    head = keys.segment({"alg": "RS256", "kid": keys.KID, "typ": "JWT"})
    signing_input = f"{head}.{keys.b64url(body.encode('utf-8'))}"
    return f"{signing_input}.{keys.b64url(keys.rs256(signing_input.encode('ascii')))}"


class ServedSiteTestCase(unittest.TestCase):
    """A rendered site served with the verifier its config file describes."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        self.out_dir = self.work / "artifacts"
        self.out_dir.mkdir()
        render_site(self.out_dir)
        self.config = self.work / "config.ini"

    def serve(self, config_text: str | None) -> None:
        """Serve the site; config_text None means no config file at all."""
        env = {"LOTUSPOD_CONFIG": "", "XDG_CONFIG_HOME": str(self.work / "xdg"),
               "HOME": str(self.work / "home")}
        if config_text is not None:
            self.config.write_text(config_text, encoding="utf-8")
            env["LOTUSPOD_CONFIG"] = str(self.config)
        with mock.patch.dict(os.environ, env):
            verifier = cli.access_verifier()
        server = cli._make_server(self.out_dir, HOST, 0, verifier=verifier)
        self.base = f"http://{HOST}:{server.server_address[1]}"
        serve_in_thread(self, server)

    def ask(self, path: str = "/api/whoami", assertion: str | None = None,
            headers: dict | None = None, method: str = "GET"):
        """(status, headers, body) of one request; body is JSON under /api."""
        sent = dict(headers or {})
        if assertion is not None:
            sent["Cf-Access-Jwt-Assertion"] = assertion
        request = urllib.request.Request(self.base + path, headers=sent, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            data = response.read()
            status, got = response.status, response.headers
        if got.get("Content-Type") == "application/json" and data:
            return status, got, json.loads(data.decode("utf-8"))
        return status, got, data

    def assertAnswer(self, answer, status: int, body) -> None:
        got_status, headers, got_body = answer
        self.assertEqual((got_status, got_body), (status, body))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Content-Type"], "application/json")


def quiet(testcase: unittest.TestCase) -> None:
    """Keep the servers' request log off the test output."""
    patcher = mock.patch.object(cli._AllowListHandler, "log_message", lambda *a: None)
    patcher.start()
    testcase.addCleanup(patcher.stop)


class WhoamiTests(ServedSiteTestCase):
    """serve configured to trust the test key, its key set read from a file: URL."""

    def setUp(self) -> None:
        super().setUp()
        quiet(self)
        self.serve(keys.config_text(allowed_emails="Maintainer@Example.com, other@example.org"))

    def test_valid_assertion_names_the_reader(self):
        answer = self.ask(assertion=keys.assertion("Maintainer@Example.com"))
        self.assertAnswer(
            answer, 200, {"actor": {"kind": "human", "email": "maintainer@example.com"}}
        )

    def test_eight_requests_without_a_valid_assertion_answer_401(self):
        now = int(time.time())
        tampered_head, _body, signature = keys.assertion().split(".")
        tampered = ".".join(
            (tampered_head, keys.segment(keys.claims("other@example.org")), signature)
        )
        cases = {
            "no assertion": (None, {}, "signed_out"),
            "only the email header": (
                None, {"Cf-Access-Authenticated-User-Email": keys.EMAIL}, "signed_out"),
            "another audience": (
                keys.assertion(aud=["another-application-audience"]), {}, "invalid_assertion"),
            "expired": (
                keys.assertion(iat=now - 7200, nbf=now - 7200, exp=now - 3600), {},
                "invalid_assertion"),
            "another issuer": (
                keys.assertion(iss="https://another-team.cloudflareaccess.com"), {},
                "invalid_assertion"),
            "claims changed after signing": (tampered, {}, "invalid_assertion"),
            "HS256 with the public key as secret": (
                keys.hs256_with_public_key(keys.claims()), {}, "invalid_assertion"),
            "alg none": (keys.unsigned(keys.claims()), {}, "invalid_assertion"),
        }
        self.assertEqual(len(cases), 8)
        for label, (assertion, headers, error) in cases.items():
            with self.subTest(label):
                answer = self.ask(assertion=assertion, headers=headers)
                self.assertAnswer(answer, 401, {"error": error})

    def test_non_finite_times_answer_401(self):
        for claim, text in (("exp", "NaN"), ("exp", "Infinity"), ("exp", "1e400"),
                            ("iat", "NaN"), ("iat", "-1e400"), ("nbf", "NaN")):
            with self.subTest(claim=claim, value=text):
                answer = self.ask(assertion=signed_with_time(claim, text))
                self.assertAnswer(answer, 401, {"error": "invalid_assertion"})

    def test_valid_assertion_for_an_email_not_allowed_is_forbidden(self):
        answer = self.ask(assertion=keys.assertion("stranger@example.com"))
        self.assertAnswer(answer, 403, {"error": "forbidden"})

    def test_email_header_naming_someone_else_is_not_read(self):
        answer = self.ask(
            assertion=keys.assertion(keys.EMAIL),
            headers={"Cf-Access-Authenticated-User-Email": "other@example.org"},
        )
        self.assertAnswer(answer, 200, {"actor": {"kind": "human", "email": keys.EMAIL}})

    def test_every_api_path_and_method_is_guarded(self):
        for method in API_METHODS:
            for path in ("/api", "/api/whoami", "/api/answers", "/api/whoami?x=1"):
                with self.subTest(method=method, path=path):
                    status, headers, _ = self.ask(path, method=method)
                    self.assertEqual(status, 401)
                    self.assertEqual(headers["Cache-Control"], "no-store")
                    self.assertEqual(headers["Content-Type"], "application/json")

    def test_after_the_guard_unknown_paths_and_writes_are_refused(self):
        token = keys.assertion()
        self.assertAnswer(self.ask("/api/answers", token), 404, {"error": "not_found"})
        for method in ("POST", "OPTIONS", "TRACE", "BREW"):
            with self.subTest(method=method):
                answer = self.ask("/api/whoami", token, method=method)
                self.assertAnswer(answer, 405, {"error": "method_not_allowed"})
                self.assertEqual(answer[1]["Allow"], "GET, HEAD")

    def test_other_methods_outside_api_answer_as_before(self):
        for method in ("POST", "OPTIONS", "TRACE"):
            with self.subTest(method=method):
                self.assertEqual(self.ask(PAGE, method=method)[0], 501)

    def test_two_assertions_are_refused(self):
        with socket.create_connection((HOST, int(self.base.rsplit(":", 1)[1])), 10) as sock:
            sock.sendall(
                b"GET /api/whoami HTTP/1.0\r\n"
                + f"Cf-Access-Jwt-Assertion: {keys.assertion()}\r\n".encode()
                + f"Cf-Access-Jwt-Assertion: {keys.assertion('other@example.org')}\r\n".encode()
                + b"\r\n"
            )
            reply = b""
            while chunk := sock.recv(65536):
                reply += chunk
        self.assertTrue(reply.startswith(b"HTTP/1.0 401"), reply[:40])
        self.assertIn(b'{"error": "invalid_assertion"}', reply)

    def test_pages_are_served_as_before(self):
        status, headers, body = self.ask(PAGE)
        self.assertEqual(status, 200)
        self.assertIn(b"A visible page.", body)
        self.assertEqual(self.ask("/api-page.html")[0], 404)


class KeySetFetchTests(ServedSiteTestCase):
    """The key set is fetched once, and refetched once for a new key id."""

    def test_fetched_once_then_once_more_for_a_new_key_id_only(self):
        quiet(self)
        certs = KeySetServer(self)
        self.serve(keys.config_text(certs_url=certs.url))

        for _ in range(20):
            answer = self.ask(assertion=keys.assertion())
            self.assertEqual(answer[0], 200)
        self.assertEqual(certs.requests, 1)

        certs.kids.append("lotuspod-test-key-2")
        answer = self.ask(assertion=keys.assertion(kid="lotuspod-test-key-2"))
        self.assertAnswer(answer, 200, {"actor": {"kind": "human", "email": keys.EMAIL}})
        self.assertEqual(certs.requests, 2)

        answer = self.ask(assertion=keys.assertion(kid="lotuspod-never-listed"))
        self.assertAnswer(answer, 401, {"error": "invalid_assertion"})
        self.assertEqual(certs.requests, 2)
        self.assertEqual(self.ask(assertion=keys.assertion())[0], 200)
        self.assertEqual(certs.requests, 2)


class FailClosedTests(ServedSiteTestCase):
    def setUp(self) -> None:
        super().setUp()
        quiet(self)

    def test_unreachable_key_set_answers_503_and_pages_still_answer(self):
        self.serve(keys.config_text(certs_url=closed_port_url()))
        answer = self.ask(assertion=keys.assertion())
        self.assertAnswer(answer, 503, {"error": "access_unavailable"})
        self.assertEqual(self.ask(PAGE)[0], 200)

    def test_key_set_answer_that_breaks_http_answers_503(self):
        certs = KeySetServer(self)
        self.serve(keys.config_text(certs_url=certs.url))
        for broken in BROKEN_ANSWERS:
            with self.subTest(broken):
                certs.broken = broken
                with self.assertRaises(access.Unavailable):
                    access.fetch_key_set(certs.url)
        # Over HTTP: a 503 answer, and no second fetch before the retry deadline.
        certs.requests = 0
        certs.broken = "truncated chunked body"
        for _ in range(3):
            answer = self.ask(assertion=keys.assertion())
            self.assertAnswer(answer, 503, {"error": "access_unavailable"})
        self.assertEqual(certs.requests, 1)
        self.assertEqual(self.ask(PAGE)[0], 200)

    def test_no_access_section_answers_503_and_pages_still_answer(self):
        self.serve("[publish]\nout_dir = /nowhere\n")
        answer = self.ask(assertion=keys.assertion())
        self.assertAnswer(answer, 503, {"error": "access_unconfigured"})
        self.assertEqual(self.ask(PAGE)[0], 200)

    def test_no_access_section_answers_503_for_every_method(self):
        self.serve("[publish]\nout_dir = /nowhere\n")
        for method in API_METHODS:
            with self.subTest(method=method):
                status, headers, _ = self.ask(assertion=keys.assertion(), method=method)
                self.assertEqual(status, 503)
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(headers["Content-Type"], "application/json")

    def test_no_config_file_answers_503_unconfigured(self):
        self.serve(None)
        self.assertAnswer(
            self.ask(assertion=keys.assertion()), 503, {"error": "access_unconfigured"}
        )


class ServeCommandTests(unittest.TestCase):
    """`lotuspod serve` builds its server with the config's verifier."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        self.config = self.work / "config.ini"
        patcher = mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(self.config)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_serve(self):
        server = mock.Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(cli, "_make_server", return_value=server) as make, \
                redirect_stdout(out), redirect_stderr(err):
            rc = cli.main(["serve", "--host", HOST, "--port", "0", "--out-dir", str(self.work),
                           "--socket", str(self.work / "lotuspod.sock")])
        return rc, make, out.getvalue(), err.getvalue()

    def test_serve_passes_the_configured_verifier(self):
        self.config.write_text(keys.config_text(), encoding="utf-8")
        rc, make, _out, _err = self.run_serve()
        self.assertEqual(rc, 0)
        verifier = make.call_args.kwargs["verifier"]
        self.assertIsInstance(verifier, access.Verifier)
        self.assertEqual(verifier.config.audience, keys.AUDIENCE)
        self.assertEqual(verifier.config.allowed_emails, frozenset({keys.EMAIL}))

    def test_serve_without_access_says_api_answers_503(self):
        self.config.write_text("[publish]\n", encoding="utf-8")
        rc, make, out, _err = self.run_serve()
        self.assertEqual(rc, 0)
        self.assertIsNone(make.call_args.kwargs["verifier"])
        self.assertIn("/api answers 503", out)

    def test_incomplete_access_section_is_refused(self):
        self.config.write_text("[access]\nissuer = https://x.example\n", encoding="utf-8")
        rc, make, _out, err = self.run_serve()
        self.assertEqual(rc, 1)
        make.assert_not_called()
        self.assertIn("audience, certs_url, allowed_emails", err)


class _StaticKeys:
    def __init__(self, *entries) -> None:
        self.entries = {kid: (n, e) for kid, (n, e, _d) in entries}

    def key(self, kid):
        return self.entries.get(kid)


class VerifierTests(unittest.TestCase):
    """Claim and signature rules, checked on the verifier with a fixed clock."""

    NOW = 1_900_000_000

    def verifier(self, keyset=None) -> access.Verifier:
        config = access.parse_config(keys.config_section())
        return access.Verifier(
            config, keys=keyset or _StaticKeys((keys.KID, keys.TEST_KEY)),
            clock=lambda: self.NOW,
        )

    def reader(self, token: str, keyset=None) -> str:
        return self.verifier(keyset).reader(token)

    def token(self, **overrides) -> str:
        return keys.sign(keys.claims(now=self.NOW, **overrides))

    def test_times_allow_sixty_seconds_of_leeway(self):
        self.assertEqual(self.reader(self.token(exp=self.NOW - 30)), keys.EMAIL)
        self.assertEqual(self.reader(self.token(nbf=self.NOW + 30, iat=self.NOW + 30)),
                         keys.EMAIL)
        for label, overrides in {
            "expired past leeway": {"exp": self.NOW - 61},
            "nbf in the future": {"nbf": self.NOW + 61},
            "iat in the future": {"iat": self.NOW + 61},
            "no exp": {"exp": None},
            "no iat": {"iat": None},
            "exp not a number": {"exp": str(self.NOW + 60)},
            "exp true": {"exp": True},
        }.items():
            with self.subTest(label), self.assertRaises(access.InvalidAssertion):
                self.reader(self.token(**overrides))

    def test_times_must_be_finite_numbers(self):
        for claim in ("exp", "iat", "nbf"):
            for text in ("NaN", "Infinity", "-Infinity", "1e400", "-1e400"):
                with self.subTest(claim=claim, value=text), \
                        self.assertRaises(access.InvalidAssertion):
                    self.reader(signed_with_time(claim, text, self.NOW))

    def test_audience_must_match_exactly(self):
        self.assertEqual(self.reader(self.token(aud=keys.AUDIENCE)), keys.EMAIL)
        self.assertEqual(self.reader(self.token(aud=["x", keys.AUDIENCE])), keys.EMAIL)
        for aud in (keys.AUDIENCE[:-1], keys.AUDIENCE + "0", keys.AUDIENCE.upper(),
                    [keys.AUDIENCE[:-1]], [], None, [[keys.AUDIENCE]]):
            with self.subTest(aud=aud), self.assertRaises(access.InvalidAssertion):
                self.reader(self.token(aud=aud))

    def test_issuer_must_match_exactly(self):
        for iss in (keys.ISSUER + "/", keys.ISSUER.upper(), None, [keys.ISSUER]):
            with self.subTest(iss=iss), self.assertRaises(access.InvalidAssertion):
                self.reader(self.token(iss=iss))

    def test_missing_or_disallowed_email_is_forbidden(self):
        with self.assertRaises(access.Forbidden):
            self.reader(self.token(email=None))
        with self.assertRaises(access.Forbidden):
            self.reader(self.token(email=["maintainer@example.com"]))

    def test_header_must_name_rs256_and_a_listed_key(self):
        body = keys.claims(now=self.NOW)
        for label, header in {
            "RS512": {"alg": "RS512", "kid": keys.KID},
            "lower-case alg": {"alg": "rs256", "kid": keys.KID},
            "no kid": {"alg": "RS256"},
            "unknown kid": {"alg": "RS256", "kid": "someone-else"},
            "crit": {"alg": "RS256", "kid": keys.KID, "crit": ["exp"]},
        }.items():
            with self.subTest(label), self.assertRaises(access.InvalidAssertion):
                self.reader(keys.sign(body, header=header))

    def test_malformed_tokens_are_invalid(self):
        good = self.token()
        head, body, sig = good.split(".")
        duplicate = keys.b64url(b'{"email":"a@b","email":"c@d"}')
        for label, token in {
            "two parts": f"{head}.{body}",
            "four parts": f"{good}.{sig}",
            "padded signature": f"{head}.{body}.{sig}==",
            "not base64url": f"{head}.{body}.{sig[:-1]}+",
            "body not JSON": f"{head}.{keys.b64url(b'nope')}.{sig}",
            "body an array": f"{head}.{keys.b64url(b'[]')}.{sig}",
            "duplicate claim": f"{head}.{duplicate}.{sig}",
            "signature one byte short": f"{head}.{body}.{keys.b64url(keys.rs256(b'x')[1:])}",
            "empty signature": f"{head}.{body}.",
            "too long": f"{head}.{body}.{'A' * 20000}",
        }.items():
            with self.subTest(label), self.assertRaises(access.InvalidAssertion):
                self.reader(token)
        with self.assertRaises(access.SignedOut):
            self.reader("")

    def test_signature_block_is_compared_whole(self):
        n, e, d = keys.TEST_KEY
        signing_input = self.token().rsplit(".", 1)[0]
        # A block with the right digest at its end but garbage in its padding.
        size = (n.bit_length() + 7) // 8
        t = bytes.fromhex("3031300d060960864801650304020105000420")
        t += hashlib.sha256(signing_input.encode()).digest()
        block = b"\x00\x01" + b"\xff" * (size - len(t) - 4) + b"\x42\x00" + t
        forged = pow(int.from_bytes(block, "big"), d, n).to_bytes(size, "big")
        with self.assertRaises(access.InvalidAssertion):
            self.reader(f"{signing_input}.{keys.b64url(forged)}")
        # A signature at or above the modulus is refused, not reduced.
        with self.assertRaises(access.InvalidAssertion):
            self.reader(f"{signing_input}.{keys.b64url(n.to_bytes(size, 'big'))}")

    def test_keys_under_2048_bits_are_not_listed(self):
        small = keys.generate_key(1024)
        big = keys.TEST_KEY
        fetched = {}

        def fetch(url):
            fetched.update(access.fetch_key_set(url))
            return fetched

        with tempfile.TemporaryDirectory() as tmp:
            certs = Path(tmp) / "certs.json"
            listed = {"keys": [keys.jwk("small", small), keys.jwk("big", big),
                               {**keys.jwk("hs", big), "kty": "oct"},
                               {**keys.jwk("enc", big), "use": "enc"},
                               {**keys.jwk("rs512", big), "alg": "RS512"}]}
            certs.write_text(json.dumps(listed), encoding="utf-8")
            keyset = access.KeySet(certs.as_uri(), fetch=fetch)
            self.assertIsNone(keyset.key("small"))
            self.assertEqual(sorted(fetched), ["big"])
            body = keys.claims(now=self.NOW)
            with self.assertRaises(access.InvalidAssertion):
                self.reader(keys.sign(body, kid="small", key=small), keyset)
            self.assertEqual(self.reader(keys.sign(body, kid="big"), keyset), keys.EMAIL)


class KeySetTimingTests(unittest.TestCase):
    """The key set's hour and its once-a-minute refetch, on a fake clock."""

    def setUp(self) -> None:
        self.now = 1000.0
        self.fetches = 0
        self.listed = {keys.KID: keys.TEST_KEY[:2]}
        self.down = False

        def fetch(url):
            self.fetches += 1
            if self.down:
                raise access.Unavailable("down")
            return dict(self.listed)

        self.keyset = access.KeySet("https://unused.example/certs",
                                    clock=lambda: self.now, fetch=fetch)

    def test_kept_for_an_hour(self):
        self.assertIsNotNone(self.keyset.key(keys.KID))
        self.now += 3599
        self.assertIsNotNone(self.keyset.key(keys.KID))
        self.assertEqual(self.fetches, 1)
        self.now += 1
        self.assertIsNotNone(self.keyset.key(keys.KID))
        self.assertEqual(self.fetches, 2)

    def test_unknown_key_id_refetches_at_most_once_a_minute(self):
        self.assertIsNone(self.keyset.key("new"))
        self.assertEqual(self.fetches, 1)  # the first fetch is itself fresh
        self.now += 1
        self.assertIsNone(self.keyset.key("new"))
        self.assertIsNone(self.keyset.key("other"))
        self.assertEqual(self.fetches, 2)
        self.listed["new"] = keys.TEST_KEY[:2]
        self.now += 59
        self.assertIsNone(self.keyset.key("new"))
        self.assertEqual(self.fetches, 2)
        self.now += 1
        self.assertIsNotNone(self.keyset.key("new"))
        self.assertEqual(self.fetches, 3)

    def test_failed_refetch_fails_closed(self):
        self.assertIsNotNone(self.keyset.key(keys.KID))
        self.now += 3600
        self.down = True
        with self.assertRaises(access.Unavailable):
            self.keyset.key(keys.KID)
        with self.assertRaises(access.Unavailable):
            self.keyset.key(keys.KID)
        self.assertEqual(self.fetches, 2)
        self.down = False
        self.now += 60
        self.assertIsNotNone(self.keyset.key(keys.KID))
        self.assertEqual(self.fetches, 3)

    def test_failed_unknown_key_refetch_keeps_the_minute_limit(self):
        self.assertIsNotNone(self.keyset.key(keys.KID))
        self.now += 1
        self.down = True
        with self.assertRaises(access.Unavailable):
            self.keyset.key("new")
        for kid in ("new", "other", keys.KID):
            with self.subTest(kid=kid), self.assertRaises(access.Unavailable):
                self.keyset.key(kid)
        self.assertEqual(self.fetches, 2)
        self.now += 59
        with self.assertRaises(access.Unavailable):
            self.keyset.key(keys.KID)
        self.assertEqual(self.fetches, 2)
        self.now += 1
        with self.assertRaises(access.Unavailable):
            self.keyset.key(keys.KID)
        self.assertEqual(self.fetches, 3)
        self.down = False
        self.now += 60
        self.assertIsNotNone(self.keyset.key(keys.KID))
        self.assertEqual(self.fetches, 4)

    def test_failed_first_fetch_is_retried_only_after_the_deadline(self):
        self.down = True
        for _ in range(3):
            with self.assertRaises(access.Unavailable):
                self.keyset.key(keys.KID)
        self.assertEqual(self.fetches, 1)
        self.down = False
        self.now += 60
        self.assertIsNotNone(self.keyset.key(keys.KID))
        self.assertEqual(self.fetches, 2)

    def test_key_set_that_is_not_one_is_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            for text in ("not json", "[]", '{"keys": {}}'):
                certs = Path(tmp) / "certs.json"
                certs.write_text(text, encoding="utf-8")
                with self.subTest(text), self.assertRaises(access.Unavailable):
                    access.fetch_key_set(certs.as_uri())


class ConfigTests(unittest.TestCase):
    def test_allowed_emails_are_lower_cased_and_split(self):
        config = access.parse_config(
            keys.config_section(allowed_emails="A@Example.com,  b@example.com\n c@example.com")
        )
        self.assertEqual(config.allowed_emails,
                         frozenset({"a@example.com", "b@example.com", "c@example.com"}))

    def test_owners_are_optional_lower_cased_and_split(self):
        self.assertEqual(access.parse_config(keys.config_section()).owners, frozenset())
        config = access.parse_config(
            {**keys.config_section(), "owners": "A@Example.com, b@example.com\n"})
        self.assertEqual(config.owners, frozenset({"a@example.com", "b@example.com"}))

    def test_certs_url_scheme_is_checked(self):
        for url in ("ftp://example.com/certs", "data:,{}", "/etc/certs.json"):
            with self.subTest(url), self.assertRaises(ValueError):
                access.parse_config(keys.config_section(certs_url=url))

    def test_fixture_key_set_matches_the_test_key(self):
        listed = json.loads(keys.CERTS_PATH.read_text(encoding="utf-8"))
        self.assertEqual(listed, keys.key_set())
        self.assertEqual(keys.TEST_KEY[0].bit_length(), 2048)


if __name__ == "__main__":
    unittest.main()
