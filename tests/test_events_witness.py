"""Real serve process, Access assertions, agent CLI and external publishes."""
import http.client
import json
import time

from tests.test_agent_pull_witness import Site, PAGE, _Page, assertion, ASSERTION


class EventsWitness(Site):
    def setUp(self):
        super().setUp()
        self.hermes = self.credential("hermes", ["hermes"], ["pull", "claim", "reply", "publish"])
        self.source = self.tmp / "pond-review.md"
        self.source.write_text(PAGE)
        self.publish()
        self.server = self.start_server()

    def publish(self):
        done = self.cli("publish", str(self.source), "--owner", "hermes", "--credential",
                        str(self.hermes), "--db", str(self.db), "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)

    def stream(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(conn.close)
        conn.request("GET", "/api/events", headers={ASSERTION: assertion()})
        response = conn.getresponse()
        self.addCleanup(response.close)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        self.assertEqual(response.readline(), b"retry: 3000\n")
        self.assertEqual(response.readline(), b"\n")
        return response

    def tick(self, stream, what, page="pond-review"):
        start = time.monotonic()
        self.assertEqual(stream.readline(), b"event: change\n")
        self.assertEqual(json.loads(stream.readline().decode().removeprefix("data: ")),
                         {"what": what, "page": page})
        self.assertEqual(stream.readline(), b"\n")
        self.assertLess(time.monotonic() - start, 5)

    def test_writes_publish_visibility_and_shutdown(self):
        stream = self.stream()
        self.pull(self.hermes, "hermes")
        root = self.comment("pond-review", "findings", "Please check.")
        self.tick(stream, "comment")
        self.pull(self.hermes, "hermes")
        code, claim = self.agent(self.hermes, "claim", str(root["id"]))
        self.assertEqual(code, 0, claim)
        self.tick(stream, "comment")
        code, reply = self.agent(self.hermes, "reply", str(root["id"]), "--claim",
                                 claim["claimToken"], "--key", "events", "--text", "Checked.")
        self.assertEqual(code, 0, reply)
        self.tick(stream, "comment")
        page = _Page()
        page.feed((self.out / "pond-review.html").read_text())
        form = page.forms[0]
        status, _, answer = self.api("POST", "/api/answers", {
            "page": "pond-review", "question": form["question"], "version": form["version"],
            "choice": form["choices"][0], "note": ""})
        self.assertEqual(status, 201, answer)
        self.tick(stream, "answer")
        self.source.write_text(PAGE + "\nNew edition.\n")
        self.publish()
        self.tick(stream, "publish")
        self.tick(stream, "index", None)
        done = self.cli("render", "--name", "secret", "--title", "Secret", "--body",
                        "<p>Hidden</p>", "--hidden", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        done = self.cli("manifest", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.tick(stream, "index", None)
        done = self.cli("archive", "pond-review", "--local", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.tick(stream, "publish")
        self.tick(stream, "index", None)
        self.server.terminate()
        self.assertEqual(self.server.wait(10), 0)
        self.assertEqual(stream.read(), b"")

    def test_access_and_method(self):
        for token, headers in [(None, {}), (assertion(expires_in=-600), {}),
                               (None, {"Cf-Access-Authenticated-User-Email": "maintainer@example.com"}),
                               (assertion(email="stranger@example.com"), {})]:
            expected = self.api("GET", "/api/revision?page=pond-review", token=token, headers=headers)
            actual = self.api("GET", "/api/events", token=token, headers=headers)
            self.assertEqual((actual[0], actual[2]), (expected[0], expected[2]))
        status, headers, _ = self.api("POST", "/api/events", {})
        self.assertEqual(status, 405)
        self.assertEqual(headers["Allow"], "GET")
