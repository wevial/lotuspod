"""Stream resource limits and shutdown over the real HTTP handler."""
import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from lotuspod import access, cli, events
from tests import access_keys as keys


class EventsTest(unittest.TestCase):
    def start(self, configured=True, database=True, **options):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = Path(tmp.name)
        hub = events.Hub(out, **options)
        verifier = access.Verifier(access.parse_config(keys.config_section()))
        server = cli._make_server(out, "127.0.0.1", 0, verifier=verifier if configured else None,
                                  db_path=out / "db.sqlite" if database else None, events=hub)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def stop():
            hub.close()
            server.shutdown()
            server.server_close()
            thread.join()
        self.addCleanup(stop)
        self.port = server.server_port
        return hub

    def stream(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        conn.request("GET", "/api/events", headers={"Cf-Access-Jwt-Assertion": keys.assertion()})
        response = conn.getresponse()
        self.addCleanup(conn.close)
        self.addCleanup(response.close)
        if response.status == 200:
            self.assertEqual(response.readline(), b"retry: 3000\n")
            self.assertEqual(response.readline(), b"\n")
        return response

    def test_cap_and_disconnect(self):
        self.start(max_streams=2)
        first, second = self.stream(), self.stream()
        refused = self.stream()
        self.assertEqual(refused.status, 503)
        self.assertEqual(refused.getheader("Retry-After"), "60")
        self.assertEqual(json.loads(refused.read()), {"error": "too_many_streams"})
        first.close()
        deadline = time.monotonic() + 2
        while True:
            replacement = self.stream()
            if replacement.status == 200:
                break
            replacement.read()
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.05)
        self.assertEqual(second.status, 200)

    def test_heartbeat(self):
        self.start(heartbeat=.2)
        stream = self.stream()
        start = time.monotonic()
        self.assertEqual(stream.readline(), b": keepalive\n")
        self.assertLess(time.monotonic() - start, 1)

    def test_lifetime(self):
        self.start(max_age=1)
        stream = self.stream()
        start = time.monotonic()
        self.assertEqual(stream.read(), b"")
        self.assertLess(time.monotonic() - start, 3)

    def test_close(self):
        hub = self.start()
        stream = self.stream()
        hub.close()
        self.assertEqual(stream.read(), b"")
        self.assertIsNone(hub.open())

    def test_slow_subscription_is_ended(self):
        hub = self.start()
        subscription = hub.open()
        for _ in range(101):
            hub.changed("index", None)
        self.assertTrue(subscription.ended.is_set())
        self.assertEqual(subscription.qsize(), 100)

    def test_unconfigured_access(self):
        self.start(configured=False)
        response = self.stream()
        self.assertEqual(response.status, 503)
        self.assertEqual(json.loads(response.read()), {"error": "access_unconfigured"})

    def test_without_database(self):
        self.start(database=False)
        response = self.stream()
        self.assertEqual(response.status, 404)
        self.assertEqual(json.loads(response.read()), {"error": "not_found"})
