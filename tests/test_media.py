"""lotuspod.media: which files are accepted as images, the width and height
read from each one's header, the content-addressed store beside the artifacts
directory, and serve's answers under /media/.

The images in tests/fixtures/media/ were made with a real encoder (Pillow),
never written byte by byte here; each name states the size it was encoded at.
The browser check e2e/checks/images.spec.ts compares Chromium's own
naturalWidth and naturalHeight with the sizes read here.

Run from the repo root:

    python -m unittest tests.test_media -v
"""

from __future__ import annotations

import hashlib
import http.client
import io
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from lotuspod import cli, db, media  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures" / "media"
SIZE_IN_NAME = re.compile(r"(\d+)x(\d+)")
# Each fixture image, its type and whether its EXIF turns it a quarter.
IMAGES = (
    ("chart-1600x600.png", "png", False),
    ("fish-320x240.jpg", "jpeg", False),
    ("pond-progressive-300x200.jpg", "jpeg", False),
    ("lily-lossy-240x160.webp", "webp", False),
    ("lily-lossless-200x150.webp", "webp", False),
    ("lily-extended-180x120.webp", "webp", False),
    ("frog-140x100.gif", "gif", False),
    ("turned-orientation6-160x96.jpg", "jpeg", True),
)


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class CheckTests(unittest.TestCase):
    def test_each_fixture_has_the_type_and_size_its_name_states(self):
        for name, kind, turned in IMAGES:
            with self.subTest(image=name):
                image = media.check(fixture(name), name)
                width, height = map(int, SIZE_IN_NAME.search(name).groups())
                self.assertEqual(image.kind, kind)
                # Browsers draw an EXIF orientation of 5 to 8 turned a quarter.
                expected = (height, width) if turned else (width, height)
                self.assertEqual((image.width, image.height), expected)

    def test_the_fixtures_hold_the_encodings_they_are_named_for(self):
        self.assertIn(b"\xff\xc0", fixture("fish-320x240.jpg"))
        self.assertNotIn(b"\xff\xc2", fixture("fish-320x240.jpg"))
        self.assertIn(b"\xff\xc2", fixture("pond-progressive-300x200.jpg"))
        for name, chunk in (("lily-lossy-240x160.webp", b"VP8 "),
                            ("lily-lossless-200x150.webp", b"VP8L"),
                            ("lily-extended-180x120.webp", b"VP8X")):
            self.assertEqual(fixture(name)[12:16], chunk, name)
        self.assertIn(b"Exif\0\0", fixture("turned-orientation6-160x96.jpg"))
        for name, _, _ in IMAGES:
            if name != "chart-1600x600.png":
                self.assertLess(len(fixture(name)), 20_000, name)

    def test_refusals_name_the_reason(self):
        png = fixture("chart-1600x600.png")
        cases = (
            (fixture("logo.svg"), "logo.svg", "SVG images are not published"),
            (fixture("fish-320x240.jpg"), "chart.png", "a JPEG image named .png"),
            (b"Not an image, only text.\n", "notes.gif", "not a PNG, JPEG, WebP or GIF image"),
            (png[:8], "short.png", "a PNG image cut short"),
            (png, "chart.bmp", "not a .png, .jpg, .jpeg, .webp or .gif file name"),
        )
        for data, filename, reason in cases:
            with self.subTest(filename=filename):
                with self.assertRaises(media.MediaError) as caught:
                    media.check(data, filename)
                self.assertIn(reason, str(caught.exception))

    def test_an_image_cut_short_anywhere_is_refused(self):
        # Past every signature (WebP's, the longest, is 12 bytes), every length
        # short of the whole file: a header alone, half the data, all but a byte.
        for name, kind, _ in IMAGES:
            data = fixture(name)
            with self.subTest(image=name):
                for cut in range(12, len(data)):
                    with self.assertRaises(media.MediaError, msg=cut) as caught:
                        media.check(data[:cut], name)
                    self.assertIn("cut short or malformed", str(caught.exception))

    def test_an_image_whose_structure_is_broken_is_refused(self):
        png = bytearray(fixture("chart-1600x600.png"))
        png[40] ^= 0xFF  # a byte inside a chunk, so its CRC no longer matches
        gif = fixture("frog-140x100.gif")
        jpeg = fixture("fish-320x240.jpg")
        webp = fixture("lily-lossy-240x160.webp")
        cases = (
            (bytes(png), "chart.png", "CRC does not match"),
            (gif[:-1] + b"\x00", "frog.gif", "unknown block"),
            (jpeg[:-2] + b"\x00\x00", "fish.jpg", "no end-of-image marker"),
            (webp[:12] + b"JUNK" + webp[16:], "lily.webp", "no VP8, VP8L or VP8X chunk first"),
        )
        for data, filename, reason in cases:
            with self.subTest(filename=filename):
                with self.assertRaises(media.MediaError) as caught:
                    media.check(data, filename)
                self.assertIn(reason, str(caught.exception))

    def test_the_module_imports_on_its_own(self):
        done = subprocess.run(
            [sys.executable, "-B", "-c", "from lotuspod import media; print(media.URL_PREFIX)"],
            capture_output=True, text=True, timeout=60,
            env=dict(os.environ, PYTHONPATH=str(SRC_DIR)),
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), "/media/")

    def test_an_image_over_the_cap_is_refused(self):
        data = fixture("padded-48x32-2000-bytes.png")
        self.assertEqual(len(data), 2000)
        with self.assertRaises(media.MediaError) as caught:
            media.check(data, "padded.png", cap=1000)
        self.assertIn("2000 bytes, over the 1000-byte cap", str(caught.exception))
        self.assertEqual(media.check(data, "padded.png", cap=2000).width, 48)

    def test_the_cap_is_read_from_the_media_section(self):
        self.assertEqual(media.max_bytes(None), 10485760)
        self.assertEqual(media.max_bytes({"max_image_bytes": "1000"}), 1000)
        for value in ("0", "-1", "ten", "1.5"):
            with self.assertRaises(ValueError, msg=value):
                media.max_bytes({"max_image_bytes": value})


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()

    def test_the_media_directory_sits_beside_the_artifacts_directory(self):
        self.assertEqual(media.media_dir(self.tmp / "artifacts"), self.tmp / "lotuspod-media")

    def test_an_image_is_stored_once_under_the_hash_of_its_bytes(self):
        directory = self.tmp / "lotuspod-media"
        for name, kind, _ in IMAGES:
            with self.subTest(image=name):
                data = fixture(name)
                image = media.check(data, name)
                path = media.store(directory, image)
                self.assertEqual(path, directory / image.name)
                extension = {"png": "png", "jpeg": "jpg", "webp": "webp", "gif": "gif"}[kind]
                self.assertEqual(image.name, f"{hashlib.sha256(data).hexdigest()}.{extension}")
                self.assertEqual(image.url, f"/media/{image.name}")
                self.assertEqual(path.read_bytes(), data)
                media.store(directory, image)
                self.assertEqual(media.load_stored(directory, image.name), image)
        self.assertEqual(len(list(directory.iterdir())), len(IMAGES))

    def test_only_a_regular_file_under_a_stored_name_is_stored(self):
        directory = self.tmp / "lotuspod-media"
        image = media.check(fixture("frog-140x100.gif"), "frog.gif")
        media.store(directory, image)
        link = directory / f"{'0' * 64}.gif"
        link.symlink_to(directory / image.name)
        for name in (image.name.upper(), link.name, f"{image.name}.svg", "frog.gif"):
            self.assertIsNone(media.load_stored(directory, name), name)


class ServeMediaTests(unittest.TestCase):
    """serve answers each stored image under /media/ and nothing else there."""

    TYPES = (
        ("chart-1600x600.png", "image/png"),
        ("fish-320x240.jpg", "image/jpeg"),
        ("lily-lossy-240x160.webp", "image/webp"),
        ("frog-140x100.gif", "image/gif"),
    )

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.out_dir = self.tmp / "artifacts"
        self.out_dir.mkdir()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["index", "--out-dir", str(self.out_dir)]), 0)
        self.media = media.media_dir(self.out_dir)
        self.stored = {}
        for name, content_type in self.TYPES:
            image = media.check(fixture(name), name)
            media.store(self.media, image)
            self.stored[name] = image
        (self.tmp / db.DEFAULT_NAME).write_text("database-secret", encoding="utf-8")

        server = cli._make_server(self.out_dir, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop() -> None:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.addCleanup(stop)
        self.port = server.server_address[1]

    def request(self, method: str, path: str) -> tuple[int, dict, bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path)
            resp = conn.getresponse()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
        finally:
            conn.close()

    def test_each_stored_image_is_answered_with_its_type_and_kept_privately(self):
        for name, content_type in self.TYPES:
            image = self.stored[name]
            for method in ("GET", "HEAD"):
                with self.subTest(image=name, method=method):
                    status, headers, body = self.request(method, image.url)
                    self.assertEqual(status, 200)
                    self.assertEqual(headers["content-type"], content_type)
                    self.assertEqual(headers["x-content-type-options"], "nosniff")
                    self.assertEqual(headers["cache-control"],
                                     "private, max-age=31536000, immutable")
                    self.assertEqual(headers["content-length"], str(len(image.data)))
                    self.assertEqual(body, image.data if method == "GET" else b"")

    def test_anything_else_under_media_is_not_found(self):
        png = self.stored["chart-1600x600.png"]
        digest = png.name.split(".")[0]
        # Files that would be answered were the name not checked first.
        (self.media / png.name.upper()).write_bytes(png.data)
        (self.media / f"{digest}.svg").write_text(
            '<svg xmlns="http://www.w3.org/2000/svg"/>', encoding="utf-8")
        outside = self.tmp / "outside.png"
        outside.write_bytes(fixture("padded-48x32-2000-bytes.png"))
        linked = media.check(outside.read_bytes(), "outside.png").name
        (self.media / linked).symlink_to(outside)
        (self.media / "index.html").write_text("<p>media index</p>", encoding="utf-8")

        for path in ("/media/", "/media", f"/media/{png.name.upper()}",
                     f"/media/{digest}.svg", f"/media/{linked}",
                     f"/media/%2e%2e/{db.DEFAULT_NAME}", f"/media/..%2f{db.DEFAULT_NAME}",
                     "/media/index.html", f"/media/.{png.name}", f"/media/{png.name}/",
                     f"/{png.name}", f"/media/{png.name[:-4]}.jpg"):
            for method in ("GET", "HEAD"):
                with self.subTest(path=path, method=method):
                    status, headers, body = self.request(method, path)
                    self.assertEqual(status, 404)
                    self.assertNotIn("immutable", headers.get("cache-control", ""))
                    self.assertNotIn(b"database-secret", body)
                    self.assertNotIn(b"media index", body)

    def test_pages_keep_their_own_headers(self):
        status, headers, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "text/html")
        self.assertIn("frame-ancestors", headers["content-security-policy"])
        self.assertNotIn("cache-control", headers)


if __name__ == "__main__":
    unittest.main()
