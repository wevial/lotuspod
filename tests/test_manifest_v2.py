"""Test suite for manifest v2 and fail-closed visibility behavior.

Covers the shared visibility rule end to end: extract_visibility edges,
render's flag writing, manifest v2 uniform schema + fail-closed listing,
the index page's same rule, and serve v2's allow-list plus the request
path handler that enforces it.

Run from the repo root:

    python -m unittest discover

The suite always tests this checkout: the repo's src/ directory is put at
the front of sys.path, so an ambient lotuspod install (editable or not)
can never shadow the code under test.
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import cli  # noqa: E402


MANIFEST_KEYS = {"file", "title", "episode", "date", "summary", "visible"}

VISIBLE_PAGE = (
    "<!DOCTYPE html><html><head>"
    '<meta name="lotuspod:visible" content="true">'
    "</head><body>"
    '<h1 class="artifact-title">{title}</h1>'
    '<p class="artifact-kicker">Lotuspod · Episode {episode}</p>'
    '<p class="artifact-meta"><time datetime="{date}">{date}</time></p>'
    '<p class="artifact-summary">{summary}</p>'
    "</body></html>"
)


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class TempDirTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out_dir = Path(tmp.name)

    def write_page(self, name: str, html: str) -> Path:
        path = self.out_dir / f"{name}.html"
        path.write_text(html, encoding="utf-8")
        return path

    def render(self, name: str, *extra: str) -> tuple[int, str, str]:
        return run_cli(
            "render", "--name", name, "--title", name.title(),
            "--out-dir", str(self.out_dir), *extra,
        )


class ExtractVisibilityTests(TempDirTestCase):
    """The fail-closed primitive every listing and the server rely on."""

    def assertVisibility(self, page_html: str, expected: bool) -> None:
        self.assertEqual(cli.extract_visibility(page_html), expected)

    def test_exact_true_is_visible(self):
        self.assertVisibility('<meta name="lotuspod:visible" content="true">', True)

    def test_case_and_whitespace_tolerated(self):
        self.assertVisibility('<meta name="lotuspod:visible" content="TRUE">', True)
        self.assertVisibility('<meta name="lotuspod:visible" content=" true ">', True)

    def test_false_is_hidden(self):
        self.assertVisibility('<meta name="lotuspod:visible" content="false">', False)

    def test_non_true_values_hidden(self):
        for content in ("yes", "true1", "1", ""):
            with self.subTest(content=content):
                self.assertVisibility(
                    f'<meta name="lotuspod:visible" content="{content}">', False
                )

    def test_missing_flag_hidden(self):
        self.assertVisibility("<!DOCTYPE html><html><body></body></html>", False)

    def test_meta_without_content_attribute_hidden(self):
        self.assertVisibility('<meta name="lotuspod:visible">', False)

    def test_attribute_order_and_quote_style_tolerated(self):
        self.assertVisibility("<meta content='true' name='lotuspod:visible'>", True)

    def test_wrong_meta_name_hidden(self):
        self.assertVisibility(
            '<meta name="lotuspod:visibility" content="true">', False
        )


class RenderFlagTests(TempDirTestCase):
    """render writes the flag that everything downstream reads."""

    def assert_flag_marker(self, name: str, content: str) -> None:
        page = (self.out_dir / f"{name}.html").read_text(encoding="utf-8")
        self.assertIn(
            f'<meta name="lotuspod:visible" content="{content}">',
            page,
            f"{name}.html carries no {content!r} visibility marker",
        )

    def test_default_render_marks_visible(self):
        rc, _, _ = self.render("ep-001")
        self.assertEqual(rc, 0)
        self.assert_flag_marker("ep-001", "true")

    def test_hidden_render_marks_not_visible(self):
        rc, _, _ = self.render("draft", "--hidden")
        self.assertEqual(rc, 0)
        self.assert_flag_marker("draft", "false")


def make_mixed_fixture(out_dir: Path) -> None:
    """Render/hand-write one artifact of each visibility flavor."""
    rc, _, err = run_cli(
        "render", "--name", "zeta", "--title", "Zeta Pond",
        "--episode", "7", "--date", "2026-03-04",
        "--summary", "latest from the pond",
        "--out-dir", str(out_dir),
    )
    assert rc == 0, err
    rc, _, err = run_cli(
        "render", "--name", "alpha", "--title", "Alpha Draft",
        "--episode", "1", "--hidden",
        "--out-dir", str(out_dir),
    )
    assert rc == 0, err
    (out_dir / "mike.html").write_text(
        VISIBLE_PAGE.format(title="Mike", episode="3", date="", summary="")
        .replace('content="true"', 'content="yes"'),
        encoding="utf-8",
    )
    (out_dir / "tango.html").write_text(
        "<!DOCTYPE html><html><body>"
        '<h1 class="artifact-title">Tango Legacy</h1>'
        "</body></html>",
        encoding="utf-8",
    )


class ManifestV2Tests(TempDirTestCase):
    """manifest v2: versioned, uniform schema, sorted, fail-closed."""

    def write_manifest(self) -> tuple[int, dict]:
        rc, _, err = run_cli("manifest", "--out-dir", str(self.out_dir))
        assert rc == 0, err
        data = json.loads(
            (self.out_dir / "manifest.json").read_text(encoding="utf-8")
        )
        return rc, data

    def test_version_is_two(self):
        make_mixed_fixture(self.out_dir)
        rc, data = self.write_manifest()
        self.assertEqual(rc, 0)
        self.assertEqual(data["version"], 2)
        self.assertEqual(set(data.keys()), {"version", "artifacts"})

    def test_uniform_schema_no_nulls_sorted(self):
        make_mixed_fixture(self.out_dir)
        rc, data = self.write_manifest()
        self.assertEqual(rc, 0)
        artifacts = data["artifacts"]
        self.assertEqual(len(artifacts), 1)
        entry = artifacts[0]
        self.assertEqual(set(entry.keys()), MANIFEST_KEYS)
        for field in ("file", "title", "episode", "date", "summary"):
            self.assertIsInstance(entry[field], str, field)
        self.assertIsInstance(entry["visible"], bool)
        stack = [data]
        while stack:
            node = stack.pop()
            self.assertIsNotNone(node)
            if isinstance(node, dict):
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
        files = [a["file"] for a in artifacts]
        self.assertEqual(files, sorted(files))
        self.assertEqual(entry["file"], "zeta.html")
        self.assertEqual(entry["episode"], "7")
        self.assertEqual(entry["date"], "2026-03-04")
        self.assertTrue(entry["visible"])

    def test_fail_closed_exclusions(self):
        make_mixed_fixture(self.out_dir)
        rc, data = self.write_manifest()
        self.assertEqual(rc, 0)
        listed = {a["file"] for a in data["artifacts"]}
        self.assertNotIn("alpha.html", listed, "--hidden render must be excluded")
        self.assertNotIn("mike.html", listed, 'malformed flag ("yes") must be excluded')
        self.assertNotIn("tango.html", listed, "legacy no-flag page must be excluded")
        self.assertIn("zeta.html", listed)

    def test_empty_fields_are_empty_strings_not_nulls(self):
        self.write_page(
            "bare",
            '<meta name="lotuspod:visible" content="true"><html></html>',
        )
        rc, data = self.write_manifest()
        self.assertEqual(rc, 0)
        (entry,) = data["artifacts"]
        self.assertEqual(entry["file"], "bare.html")
        self.assertEqual(entry["title"], "bare")
        self.assertEqual(entry["episode"], "")
        self.assertEqual(entry["date"], "")
        self.assertEqual(entry["summary"], "")
        self.assertIs(entry["visible"], True)

    def test_index_file_never_listed(self):
        self.write_page(
            "index",
            '<meta name="lotuspod:visible" content="true">'
            '<h1 class="artifact-title">Index</h1>',
        )
        self.render("real", )
        rc, data = self.write_manifest()
        self.assertEqual(rc, 0)
        listed = [a["file"] for a in data["artifacts"]]
        self.assertNotIn("index.html", listed)
        self.assertEqual(listed, ["real.html"])

    def test_empty_dir_exit_zero(self):
        rc, data = self.write_manifest()
        self.assertEqual(rc, 0)
        self.assertEqual(data, {"version": 2, "artifacts": []})

    def test_missing_dir_error_exit_one(self):
        missing = self.out_dir / "nowhere"
        rc, out, err = run_cli("manifest", "--out-dir", str(missing))
        self.assertEqual(rc, 1)
        self.assertIn("not found", err)
        self.assertFalse(missing.exists())


class IndexVisibilityTests(TempDirTestCase):
    """index.html follows the same fail-closed rule as the manifest."""

    def build_index(self) -> str:
        rc, _, _ = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0)
        return (self.out_dir / "index.html").read_text(encoding="utf-8")

    def test_lists_only_visible_pages(self):
        make_mixed_fixture(self.out_dir)
        index_html = self.build_index()
        self.assertIn('href="zeta.html"', index_html)
        self.assertNotIn('href="alpha.html"', index_html)
        self.assertNotIn('href="mike.html"', index_html)
        self.assertNotIn('href="tango.html"', index_html)

    def test_never_lists_itself(self):
        self.write_page(
            "index",
            '<meta name="lotuspod:visible" content="true">'
            '<h1 class="artifact-title">Index</h1>',
        )
        index_html = self.build_index()
        self.assertNotIn('href="index.html"', index_html)

    def test_matches_manifest_listing(self):
        make_mixed_fixture(self.out_dir)
        run_cli("manifest", "--out-dir", str(self.out_dir))
        index_html = self.build_index()
        manifest = json.loads(
            (self.out_dir / "manifest.json").read_text(encoding="utf-8")
        )
        for entry in manifest["artifacts"]:
            self.assertIn(f'href="{entry["file"]}"', index_html)


class ServeAllowListTests(TempDirTestCase):
    """serve v2 enforces the same visibility rule over HTTP names."""

    def allow_list(self) -> frozenset[str]:
        return cli.serve_allow_list(self.out_dir)

    def test_only_visible_pages_plus_support_files(self):
        make_mixed_fixture(self.out_dir)
        allowed = self.allow_list()
        self.assertEqual(allowed, {"index.html", "lotuspod.css", "zeta.html"})
        self.assertNotIn("alpha.html", allowed)
        self.assertNotIn("mike.html", allowed)
        self.assertNotIn("tango.html", allowed)

    def test_undecodable_page_fail_closed(self):
        self.render("good", )
        (self.out_dir / "junk.html").write_bytes(b"\xff\xfe\x00<not utf-8>")
        self.assertEqual(self.allow_list(), {"index.html", "lotuspod.css", "good.html"})

    def test_allow_list_recomputed_on_rewrite(self):
        self.render("flip", "--hidden")
        self.assertNotIn("flip.html", self.allow_list())
        page = self.out_dir / "flip.html"
        page.write_text(
            page.read_text(encoding="utf-8").replace('content="false"', 'content="true"'),
            encoding="utf-8",
        )
        self.assertIn("flip.html", self.allow_list())
        page.write_text(
            page.read_text(encoding="utf-8").replace('content="true"', 'content="false"'),
            encoding="utf-8",
        )
        self.assertNotIn("flip.html", self.allow_list())


def bare_handler(root: Path) -> cli._AllowListHandler:
    """A handler instance wired for direct method calls, no sockets."""
    handler = cli._AllowListHandler.__new__(cli._AllowListHandler)
    handler.root = root
    handler.directory = str(root)
    handler.client_address = ("127.0.0.1", 0)
    handler.command = "GET"
    handler.request_version = "HTTP/1.1"
    handler.requestline = "GET / HTTP/1.1"
    handler.wfile = io.BytesIO()
    return handler


class ServeHandlerTests(TempDirTestCase):
    """_AllowListHandler decides path shape; the allow-list set is not enough."""

    def resolve(self, url_path: str, root: Path | None = None) -> Path:
        return Path(bare_handler(root or self.out_dir).translate_path(url_path))

    def assertDenied(self, url_path: str, root: Path | None = None) -> None:
        expected = (root or self.out_dir) / cli._DENY_PATH_NAME
        self.assertEqual(self.resolve(url_path, root), expected, url_path)

    def test_root_resolves_to_index(self):
        self.assertEqual(self.resolve("/"), self.out_dir / cli.INDEX_FILE)

    def test_allow_listed_visible_page_resolves_to_itself(self):
        make_mixed_fixture(self.out_dir)
        self.assertEqual(self.resolve("/zeta.html"), self.out_dir / "zeta.html")

    def test_never_files_on_disk_resolve_to_deny_sentinel(self):
        make_mixed_fixture(self.out_dir)
        (self.out_dir / cli.MANIFEST_FILE).write_text("{}", encoding="utf-8")
        (self.out_dir / "FINDINGS.md").write_text("findings", encoding="utf-8")
        self.assertDenied(f"/{cli.MANIFEST_FILE}")
        self.assertDenied("/FINDINGS.md")

    def test_stray_file_denied(self):
        make_mixed_fixture(self.out_dir)
        (self.out_dir / "notes.txt").write_text("stray", encoding="utf-8")
        self.assertDenied("/notes.txt")

    def test_hidden_page_denied_by_direct_url(self):
        make_mixed_fixture(self.out_dir)
        self.assertDenied("/alpha.html")

    def test_nested_visible_page_denied(self):
        make_mixed_fixture(self.out_dir)
        (self.out_dir / "sub").mkdir()
        (self.out_dir / "sub" / "nested.html").write_text(
            VISIBLE_PAGE.format(title="N", episode="", date="", summary=""),
            encoding="utf-8",
        )
        self.assertDenied("/sub/nested.html")

    def test_traversal_outside_root_denied(self):
        self.assertDenied("/../outside.html")

    def test_vanished_artifacts_dir_denies_without_raising(self):
        gone = self.out_dir / "gone"
        self.assertEqual(
            self.resolve("/page.html", gone), gone / cli._DENY_PATH_NAME
        )

    def test_directory_listing_suppressed_with_404(self):
        make_mixed_fixture(self.out_dir)
        handler = bare_handler(self.out_dir)
        with redirect_stderr(io.StringIO()):
            body = handler.list_directory(str(self.out_dir))
        self.assertIsNone(body)
        self.assertTrue(handler.wfile.getvalue().startswith(b"HTTP/1.0 404"))


if __name__ == "__main__":
    unittest.main()
