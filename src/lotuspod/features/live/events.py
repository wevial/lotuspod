"""Bounded change notifications for serve's open pages."""
from __future__ import annotations

import json
import queue
import threading
from pathlib import Path
from typing import Callable

from lotuspod import core
from lotuspod.features.serve import serve_files

PATH = "/api/events"
MAX_STREAMS = 32
HEARTBEAT = 30
MAX_AGE = 600
POLL = 1.0


def frame(what: str, page: str | None) -> bytes:
    return ("event: change\ndata: " + json.dumps({"what": what, "page": page}) + "\n\n").encode()


class Subscription(queue.Queue):
    def __init__(self, disconnect: Callable[[], None]) -> None:
        super().__init__(maxsize=100)
        self.ended = threading.Event()
        self.disconnect = disconnect

    def close(self) -> None:
        self.ended.set()
        self.disconnect()


class Hub:
    def __init__(self, out_dir: Path, max_streams=MAX_STREAMS, heartbeat=HEARTBEAT,
                 max_age=MAX_AGE, poll=POLL):
        self.out_dir = Path(out_dir).resolve()
        self.max_streams, self.heartbeat = max_streams, heartbeat
        self.max_age, self.poll = max_age, poll
        self._condition = threading.Condition()
        self._streams: set[Subscription] = set()
        self._closed = False
        self._watcher = None
        self._stamp = None
        self._pages = {}

    def _stat(self):
        try:
            stat = (self.out_dir / core.MANIFEST_FILE).stat()
            return stat.st_mtime_ns, stat.st_size, stat.st_ino
        except OSError:
            return None

    def _snapshot(self):
        from lotuspod.features.history import archive
        return {file[:-5]: (core.page_revision(self.out_dir, file[:-5]),
                           archive.read_record(self.out_dir, file[:-5]))
                for file in serve_files.serve_allow_list(self.out_dir) if file.endswith(".html") and core.is_page_name(file)}

    def open(self, disconnect: Callable[[], None] = lambda: None):
        with self._condition:
            if self._closed or len(self._streams) >= self.max_streams:
                return None
            if not self._streams:
                try:
                    with core.publish_lock(self.out_dir, blocking=False):
                        self._stamp = self._stat()
                        self._pages = self._snapshot()
                except (OSError, ValueError, RuntimeError):
                    # A publish in flight must be observed after its index lands.
                    self._stamp, self._pages = None, {}
            subscription = Subscription(disconnect)
            self._streams.add(subscription)
            if self._watcher is None:
                self._watcher = threading.Thread(target=self._watch, daemon=True)
                self._watcher.start()
            self._condition.notify_all()
            return subscription

    def remove(self, subscription):
        with self._condition:
            self._streams.discard(subscription)
            self._condition.notify_all()
        subscription.close()

    def changed(self, what: str, page: str | None):
        # Recheck visibility, including writes racing a page being hidden.
        if page is not None:
            if f"{page}.html" not in serve_files.serve_allow_list(self.out_dir):
                return
        data = frame(what, page)
        with self._condition:
            streams = tuple(self._streams)
        for subscription in streams:
            try:
                subscription.put_nowait(data)
            except queue.Full:
                self.remove(subscription)

    def _watch(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or self._streams)
                if self._closed:
                    return
                self._condition.wait(timeout=self.poll)
                if self._closed:
                    return
                if not self._streams:
                    continue
                stamp = self._stat()
                if stamp == self._stamp:
                    continue
                try:
                    # Manifest replacement precedes the index rebuild. Observe
                    # the completed transaction, without blocking hub shutdown.
                    with core.publish_lock(self.out_dir, blocking=False):
                        stamp = self._stat()
                        pages = self._snapshot()
                except (OSError, ValueError, RuntimeError):
                    continue  # Retry a transient read on the next poll.
                changed = [name for name in sorted(pages)
                           if self._pages.get(name) != pages[name]]
                self._stamp, self._pages = stamp, pages
            for name in changed:
                self.changed("publish", name)
            self.changed("index", None)

    def close(self):
        with self._condition:
            self._closed = True
            streams = tuple(self._streams)
            self._streams.clear()
            self._condition.notify_all()
        for subscription in streams:
            subscription.close()
        if self._watcher is not None:
            self._watcher.join()
