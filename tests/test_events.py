"""Stream resource limits and shutdown over the real HTTP handler."""
import http.client
import json
import queue
import socket
import tempfile
import threading
import time
import unittest
from unittest import mock
from pathlib import Path

from lotuspod import access, cli, core, events
from lotuspod.features.history import archive
from lotuspod.features.index import commands as index_commands
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

    def test_half_closed_request_keeps_reading(self):
        hub = self.start(heartbeat=.2)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        self.addCleanup(conn.close)
        conn.request("GET", "/api/events", headers={"Cf-Access-Jwt-Assertion": keys.assertion()})
        conn.sock.shutdown(socket.SHUT_WR)
        response = conn.getresponse()
        self.addCleanup(response.close)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.readline(), b"retry: 3000\n")
        self.assertEqual(response.readline(), b"\n")
        self.assertEqual(response.readline(), b": keepalive\n")
        self.assertEqual(response.readline(), b"\n")
        hub.changed("index", None)
        while True:
            line = response.readline()
            self.assertTrue(line, "half-close ended the response")
            if line == b"event: change\n":
                break
        self.assertEqual(json.loads(response.readline().decode().removeprefix("data: ")),
                         {"what": "index", "page": None})

    def render_pages(self, hub):
        for name in ("pond", "next"):
            self.assertEqual(cli.main(["render", "--name", name, "--title", name,
                                       "--body", "<p>Page</p>", "--out-dir", str(hub.out_dir)]), 0)
        self.assertEqual(cli.main(["manifest", "--out-dir", str(hub.out_dir)]), 0)
        self.assertEqual(cli.main(["index", "--out-dir", str(hub.out_dir)]), 0)

    def test_index_tick_waits_for_rebuild(self):
        hub = self.start(poll=.02)
        self.render_pages(hub)
        subscription = hub.open()
        original_index = (hub.out_dir / core.INDEX_FILE).read_bytes()
        rebuild = index_commands.cmd_index

        def paused_index(args):
            # Archive, like publish, replaces the manifest before rebuilding
            # the index while holding the publish lock.
            with self.assertRaises(queue.Empty):
                subscription.get(timeout=.2)
            self.assertEqual((hub.out_dir / core.INDEX_FILE).read_bytes(), original_index)
            return rebuild(args)

        with mock.patch.object(index_commands, "cmd_index", side_effect=paused_index):
            archive.set_archived(hub.out_dir, "pond", True)
        self.assertEqual(subscription.get(timeout=2), events.frame("publish", "pond"))
        self.assertEqual(subscription.get(timeout=2), events.frame("index", None))
        self.assertNotEqual((hub.out_dir / core.INDEX_FILE).read_bytes(), original_index)

    def test_open_during_publish_and_close_while_locked(self):
        hub = self.start(poll=.02)
        self.render_pages(hub)
        with core.publish_lock(hub.out_dir):
            subscription = hub.open()
            with self.assertRaises(queue.Empty):
                subscription.get(timeout=.1)
        self.assertEqual(subscription.get(timeout=2), events.frame("publish", "next"))
        self.assertEqual(subscription.get(timeout=2), events.frame("publish", "pond"))
        self.assertEqual(subscription.get(timeout=2), events.frame("index", None))
        with core.publish_lock(hub.out_dir):
            core.write_atomic(hub.out_dir / core.MANIFEST_FILE,
                             (hub.out_dir / core.MANIFEST_FILE).read_bytes())
            with self.assertRaises(queue.Empty):
                subscription.get(timeout=.1)
            closer = threading.Thread(target=hub.close, daemon=True)
            closer.start()
            closer.join(timeout=1)
            self.assertFalse(closer.is_alive(), "shutdown waited for the publisher")

    def test_archive_successor_notifies_page(self):
        hub = self.start(poll=.02)
        self.render_pages(hub)
        archive.set_archived(hub.out_dir, "pond", True)
        subscription = hub.open()
        archive.set_archived(hub.out_dir, "pond", True, "next")
        self.assertEqual(subscription.get(timeout=2), events.frame("publish", "pond"))
        self.assertEqual(subscription.get(timeout=2), events.frame("index", None))

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
