"""Test suite for manifest v2 and fail-closed visibility behavior.

Covers the shared visibility rule end to end: extract_visibility edges,
render's flag writing, the artifact page's back-link to the index,
render's deterministic h2 ids and the outline data they feed,
manifest v2 uniform schema + fail-closed listing,
the index page's same rule, serve v2's allow-list plus the request
path handler that enforces it, serve's --host override used when a local
Cloudflare Tunnel fronts the server, and the checked-in publish config
(deploy/cloudflared.yml) that publishes lotuspod.example.com.

Run from the repo root:

    python -m unittest discover

The suite always tests this checkout: the repo's src/ directory is put at
the front of sys.path, so an ambient lotuspod install (editable or not)
can never shadow the code under test.
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

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


class ArtifactNavTests(TempDirTestCase):
    """Every rendered artifact offers a way back to the index."""

    def rendered(self, name: str = "ep-001", *extra: str) -> str:
        rc, _, err = self.render(name, *extra)
        self.assertEqual(rc, 0, err)
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")

    def test_render_links_back_to_the_index(self):
        page = self.rendered()
        self.assertIn('<nav class="artifact-nav">', page)
        self.assertIn('href="index.html"', page)

    def test_back_link_sits_above_the_header(self):
        page = self.rendered()
        self.assertLess(
            page.index('class="artifact-nav"'),
            page.index('class="artifact-header"'),
        )

    def test_hidden_render_links_back_too(self):
        self.assertIn('href="index.html"', self.rendered("draft", "--hidden"))

    def test_theme_styles_the_back_link(self):
        css = (cli.THEME_DIR / "lotuspod.css").read_text(encoding="utf-8")
        self.assertIn(".artifact-nav", css)

    def test_back_link_does_not_disturb_listing_metadata(self):
        """The nav's <a> must not be mistaken for artifact metadata."""
        self.render(
            "ep-002", "--episode", "2", "--date", "2026-03-04",
            "--summary", "back from the pond",
        )
        page = (self.out_dir / "ep-002.html").read_text(encoding="utf-8")
        self.assertEqual(
            cli.extract_meta(page, "ep-002"),
            {
                "file": "ep-002.html",
                "title": "Ep-002",
                "episode": "2",
                "date": "2026-03-04",
                "summary": "back from the pond",
                "visible": True,
            },
        )


class ThemeCssSyncTests(TempDirTestCase):
    """A theme upgrade must reach directories rendered by an older version."""

    def packaged_css(self) -> bytes:
        return (cli.THEME_DIR / "lotuspod.css").read_bytes()

    def css_copy(self) -> Path:
        return self.out_dir / "lotuspod.css"

    def test_render_writes_the_stylesheet(self):
        self.render("ep-001")
        self.assertEqual(self.css_copy().read_bytes(), self.packaged_css())

    def test_render_refreshes_a_stale_stylesheet(self):
        self.css_copy().write_bytes(b"/* theme v0.2.0 */\n")
        self.render("ep-001")
        self.assertEqual(self.css_copy().read_bytes(), self.packaged_css())

    def test_index_refreshes_a_stale_stylesheet(self):
        self.render("ep-001")
        self.css_copy().write_bytes(b"/* theme v0.2.0 */\n")
        rc, _, _ = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0)
        self.assertEqual(self.css_copy().read_bytes(), self.packaged_css())

    def test_current_stylesheet_left_untouched(self):
        self.render("ep-001")
        stamp = 1_000_000_000
        os.utime(self.css_copy(), (stamp, stamp))
        self.render("ep-002")
        self.assertEqual(int(self.css_copy().stat().st_mtime), stamp)


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


class IndexHeaderTests(TempDirTestCase):
    """The index wears its own name plainly: no eyebrow, no card."""

    def build_index(self) -> str:
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        return (self.out_dir / "index.html").read_text(encoding="utf-8")

    def test_title_is_plain_lotuspod(self):
        index_html = self.build_index()
        self.assertIn('<h1 class="index-title">Lotuspod <span class="index-updated">', index_html)
        self.assertIn("<title>Lotuspod</title>", index_html)
        self.assertNotIn("Episodes", index_html)

    def test_no_eyebrow_above_the_title(self):
        self.assertNotIn("artifact-kicker", self.build_index())

    def test_theme_gives_the_header_no_card(self):
        css = (cli.THEME_DIR / "lotuspod.css").read_text(encoding="utf-8")
        self.assertNotIn(".index-header", css)


class IndexTableTests(TempDirTestCase):
    """The listing is a sortable, filterable table of artifact records."""

    def build_index(self) -> str:
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        return (self.out_dir / "index.html").read_text(encoding="utf-8")

    def theme_css(self) -> str:
        return (cli.THEME_DIR / "lotuspod.css").read_text(encoding="utf-8")

    def test_artifacts_are_listed_as_table_rows(self):
        make_mixed_fixture(self.out_dir)
        index_html = self.build_index()
        self.assertIn('<table class="index-table">', index_html)
        self.assertIn('<td class="episode-number">7</td>', index_html)
        self.assertIn(
            '<td class="episode-title"><a href="zeta.html">Zeta Pond</a></td>',
            index_html,
        )
        self.assertIn(
            '<td class="episode-date">'
            '<time datetime="2026-03-04">2026-03-04</time></td>',
            index_html,
        )
        self.assertIn(
            '<td class="episode-summary">latest from the pond</td>', index_html
        )
        self.assertNotIn("episode-card", index_html)

    def test_columns_are_labelled_and_the_episode_column_sorts_numerically(self):
        make_mixed_fixture(self.out_dir)
        index_html = self.build_index()
        self.assertIn(
            '<th scope="col" data-sort-type="number">Episode</th>', index_html
        )
        for label in ("Title", "Date", "Summary"):
            with self.subTest(label=label):
                self.assertIn(f'<th scope="col">{label}</th>', index_html)

    def test_missing_fields_leave_empty_cells(self):
        self.render("note")  # no --episode, no --summary
        index_html = self.build_index()
        self.assertIn('<td class="episode-number"></td>', index_html)
        self.assertIn('<td class="episode-summary"></td>', index_html)

    def test_row_values_are_escaped(self):
        self.render("amp", "--title", "Pond & Lotus", "--summary", "<b>bold</b>")
        index_html = self.build_index()
        self.assertIn("Pond &amp; Lotus", index_html)
        self.assertIn("&lt;b&gt;bold&lt;/b&gt;", index_html)

    def test_search_filter_ships_hidden_for_the_script_to_reveal(self):
        make_mixed_fixture(self.out_dir)
        index_html = self.build_index()
        self.assertIn('<div class="index-controls" hidden>', index_html)
        self.assertIn('class="index-search" type="search"', index_html)
        self.assertIn('for="index-search"', index_html)
        self.assertIn('id="index-search"', index_html)
        self.assertIn('<p class="index-count"', index_html)
        self.assertIn('class="index-empty index-no-match" hidden', index_html)

    def test_script_wires_sorting_and_filtering(self):
        make_mixed_fixture(self.out_dir)
        index_html = self.build_index()
        script = index_html[index_html.index("<script>"): index_html.index("</script>")]
        self.assertIn(".index-table", script)
        self.assertIn("sort-button", script)
        self.assertIn("aria-sort", script)
        self.assertIn('addEventListener("input"', script)
        self.assertIn(".index-search", script)

    def test_empty_pond_has_no_table(self):
        index_html = self.build_index()
        self.assertIn("Nothing in the pond yet", index_html)
        self.assertNotIn("<table", index_html)

    def test_theme_styles_the_table_and_its_controls(self):
        css = self.theme_css()
        for rule in (".index-table", ".sort-button", ".index-search", ".index-count"):
            with self.subTest(rule=rule):
                self.assertIn(rule, css)

    def test_theme_hides_filtered_rows_and_the_hidden_controls(self):
        """[hidden] loses to table/flex display roles unless restated."""
        css = self.theme_css()
        self.assertIn(".index-table tbody tr[hidden]", css)
        self.assertIn(".index-controls[hidden]", css)

    def test_theme_no_longer_styles_the_dropped_cards(self):
        css = self.theme_css()
        self.assertNotIn(".episode-card", css)
        self.assertNotIn(".episode-list", css)


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


REPO_ROOT = Path(__file__).resolve().parents[1]
PUBLISH_CONFIG_PATH = REPO_ROOT / "deploy" / "cloudflared.yml"
PUBLISH_HOSTNAME = "lotuspod.example.com"


def parse_ingress(config_text: str) -> tuple[dict, list[dict]]:
    """Minimal YAML-subset parse: (top-level scalars, ingress rule list).

    Understands exactly the shape deploy/cloudflared.yml uses — top-level
    `key: value` lines and an `ingress:` block of `- key: value` rules with
    continuation keys on following lines. Comments are stripped.
    """
    top: dict[str, str] = {}
    rules: list[dict] = []
    in_ingress = False
    for raw in config_text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if not line[0].isspace():
            in_ingress = line.strip() == "ingress:"
            if not in_ingress:
                key, _, value = line.partition(":")
                top[key.strip()] = value.strip()
            continue
        if not in_ingress:
            continue
        stripped = line.strip()
        if stripped.startswith("- "):
            rules.append({})
            stripped = stripped[2:]
        key, _, value = stripped.partition(":")
        if key.strip() in ("hostname", "service") and rules:
            rules[-1][key.strip()] = value.strip()
    return top, rules


class PublishConfigTests(unittest.TestCase):
    """deploy/cloudflared.yml publishes lotuspod.example.com, and only that."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.config_text = PUBLISH_CONFIG_PATH.read_text(encoding="utf-8")
        cls.top, cls.rules = parse_ingress(cls.config_text)

    def test_config_file_exists_in_repo(self):
        self.assertTrue(PUBLISH_CONFIG_PATH.is_file(), PUBLISH_CONFIG_PATH)

    def test_single_hostname_rule_targets_publish_name_on_local_server(self):
        # NOTE: ingress targets the dedicated publish port 8622, not serve's default 8000
        self.assertEqual(len(self.rules), 2, "one hostname rule + catch-all")
        self.assertEqual(
            self.rules[0],
            {
                "hostname": PUBLISH_HOSTNAME,
                "service": "http://127.0.0.1:8622",
            },
        )

    def test_ingress_port_is_dedicated_publish_port_not_serve_default(self):
        # The committed ingress intentionally targets 8622 (dedicated publish
        # port), NOT cli.DEFAULT_SERVE_PORT (8000). Operators run
        # `serve --host 127.0.0.1 --port 8622` per README.
        self.assertEqual(self.rules[0]["service"], "http://127.0.0.1:8622")
        self.assertNotEqual(
            self.rules[0]["service"],
            f"http://127.0.0.1:{cli.DEFAULT_SERVE_PORT}",
            "ingress must not silently track serve's default port",
        )

    def test_catch_all_404_is_last_rule(self):
        self.assertEqual(self.rules[-1], {"service": "http_status:404"})
        self.assertNotIn("hostname", self.rules[-1])

    def test_no_tunnel_secret_committed(self):
        self.assertEqual(
            self.top.get("tunnel"),
            "REPLACE_WITH_TUNNEL_UUID",
            "config must carry the placeholder, never a real tunnel UUID",
        )
        self.assertNotIn("credentials-file", self.top, "credentials stay outside the repo")
        real_uuid = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
        self.assertNotSearch(real_uuid, self.config_text)
        self.assertNotIn("PRIVATE KEY", self.config_text)

    def assertNotSearch(self, pattern: re.Pattern, text: str) -> None:
        self.assertIsNone(pattern.search(text), f"matched {pattern.pattern!r}")


class ServeHostOverrideTests(TempDirTestCase):
    """--host lets a local Cloudflare Tunnel front the allow-listed server."""

    def test_parser_defaults_to_tailnet_autodetect(self):
        args = cli.build_parser().parse_args(["serve"])
        self.assertEqual(args.host, "")
        self.assertEqual(args.port, cli.DEFAULT_SERVE_PORT)

    def test_parser_accepts_host_override(self):
        args = cli.build_parser().parse_args(["serve", "--host", "127.0.0.1"])
        self.assertEqual(args.host, "127.0.0.1")

    def test_explicit_host_wins_without_tailnet_lookup(self):
        with mock.patch.object(
            cli, "tailnet_ipv4", side_effect=AssertionError("must not be called")
        ):
            self.assertEqual(cli.resolve_serve_host("127.0.0.1"), "127.0.0.1")

    def test_empty_override_falls_back_to_tailnet_detection(self):
        detector = mock.Mock(return_value="100.64.0.1")
        with mock.patch.object(cli, "tailnet_ipv4", detector):
            self.assertEqual(cli.resolve_serve_host(""), "100.64.0.1")
        detector.assert_called_once_with()

    def test_make_server_binds_requested_host(self):
        server = cli._make_server(self.out_dir, "127.0.0.1", 0)
        self.addCleanup(server.server_close)
        host, port = server.server_address[:2]
        self.assertEqual(host, "127.0.0.1")
        self.assertGreater(port, 0)


class PublishHttpRoundTripTests(TempDirTestCase):
    """The exact wiring cloudflared proxies to: loopback HTTP end to end."""

    def setUp(self) -> None:
        super().setUp()
        make_mixed_fixture(self.out_dir)
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        assert rc == 0, err
        rc, _, err = run_cli("manifest", "--out-dir", str(self.out_dir))
        assert rc == 0, err
        (self.out_dir / "FINDINGS.md").write_text("private findings", encoding="utf-8")
        self.server = cli._make_server(self.out_dir, "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)

    def _stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def fetch(self, path: str) -> tuple[int, bytes]:
        url = f"http://127.0.0.1:{self.port}{path}"
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def test_public_surface_through_loopback_matches_allow_list(self):
        index_bytes = (self.out_dir / "index.html").read_bytes()
        status, body = self.fetch("/")
        self.assertEqual(status, 200)
        self.assertEqual(body, index_bytes)
        status, body = self.fetch("/zeta.html")
        self.assertEqual(status, 200)
        self.assertIn(b"Zeta Pond", body)
        self.assertEqual(self.fetch("/lotuspod.css")[0], 200)
        for denied in ("/manifest.json", "/FINDINGS.md", "/alpha.html"):
            status, _ = self.fetch(denied)
            self.assertEqual(status, 404, denied)

    def test_republish_flips_live_while_published(self):
        self.assertEqual(self.fetch("/zeta.html")[0], 200)
        page = self.out_dir / "zeta.html"
        page.write_text(
            page.read_text(encoding="utf-8").replace('content="true"', 'content="false"'),
            encoding="utf-8",
        )
        self.assertEqual(self.fetch("/zeta.html")[0], 404)
        page.write_text(
            page.read_text(encoding="utf-8").replace('content="false"', 'content="true"'),
            encoding="utf-8",
        )
        self.assertEqual(self.fetch("/zeta.html")[0], 200)


class OutlineTests(TempDirTestCase):
    """render assigns h2 anchors that never move between renders."""

    TWO_H2 = "<h2>A</h2><p>x</p><h2>B</h2><p>y</p>"

    def rendered(self, body: str, *extra: str, name: str = "ep-001") -> str:
        rc, _, err = self.render(
            name, "--date", "2026-03-04", "--body", body, *extra
        )
        self.assertEqual(rc, 0, err)
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")

    def test_ids_are_slugs_of_the_heading_text(self):
        page = self.rendered(self.TWO_H2)
        self.assertIn('<h2 id="a">A</h2>', page)
        self.assertIn('<h2 id="b">B</h2>', page)

    def test_two_renders_are_byte_identical(self):
        first = self.rendered(self.TWO_H2)
        self.assertEqual(first, self.rendered(self.TWO_H2))
        self.assertIn('id="a"', first)
        self.assertIn('id="b"', first)

    def test_repeated_heading_text_dedupes_with_numeric_suffixes(self):
        page = self.rendered("<h2>Same</h2><h2>Same</h2><h2>Same</h2>")
        self.assertIn('<h2 id="same">Same</h2>', page)
        self.assertIn('<h2 id="same-2">Same</h2>', page)
        self.assertIn('<h2 id="same-3">Same</h2>', page)

    def test_explicit_id_is_kept_and_reserved(self):
        """An id someone may already have linked to is never rewritten."""
        page = self.rendered('<h2 id="intro">Intro</h2><h2>Intro</h2>')
        self.assertIn('<h2 id="intro">Intro</h2>', page)
        self.assertIn('<h2 id="intro-2">Intro</h2>', page)

    def test_single_h2_body_gets_no_ids(self):
        page = self.rendered("<h2>Only</h2><p>x</p>")
        self.assertIn("<h2>Only</h2>", page)
        self.assertNotIn("id=", page.split('class="artifact-body"')[1])

    def test_no_outline_leaves_the_body_verbatim(self):
        page = self.rendered(self.TWO_H2, "--no-outline")
        self.assertIn(self.TWO_H2, page)
        self.assertNotIn('id="a"', page)

    def test_no_outline_matches_the_page_without_an_outline(self):
        """Opting out drops both halves at once - the ids and the section list
        built from them - leaving the page a body with no outline at all."""
        with_ids = self.rendered(self.TWO_H2)
        opted_out = self.rendered(self.TWO_H2, "--no-outline")
        without_nav = re.sub(
            r'<nav class="artifact-outline".*?</nav>', "", with_ids, flags=re.DOTALL
        )
        self.assertEqual(
            opted_out,
            without_nav.replace('<h2 id="a">', "<h2>").replace('<h2 id="b">', "<h2>"),
        )

    def test_outline_reaches_the_template_context(self):
        with mock.patch.object(
            cli, "render_template", wraps=cli.render_template
        ) as render_template:
            self.rendered(self.TWO_H2)
        context = render_template.call_args.args[0]
        self.assertEqual(
            context["outline"],
            [{"id": "a", "text": "A"}, {"id": "b", "text": "B"}],
        )

    def test_no_outline_passes_an_empty_outline(self):
        with mock.patch.object(
            cli, "render_template", wraps=cli.render_template
        ) as render_template:
            self.rendered(self.TWO_H2, "--no-outline")
        self.assertEqual(render_template.call_args.args[0]["outline"], [])

    def test_hidden_render_still_gets_ids(self):
        self.assertIn('id="a"', self.rendered(self.TWO_H2, "--hidden"))


class OutlineMarkupTests(TempDirTestCase):
    """The outline the reader sees: one list of links, two layouts, no script."""

    OUTLINE_NAV = re.compile(
        r'<nav class="artifact-outline".*?</nav>', re.DOTALL
    )

    def rendered(self, body: str, *extra: str) -> str:
        rc, _, err = self.render("ep-001", "--body", body, *extra)
        self.assertEqual(rc, 0, err)
        return (self.out_dir / "ep-001.html").read_text(encoding="utf-8")

    def nav(self, page: str) -> str:
        found = self.OUTLINE_NAV.search(page)
        self.assertIsNotNone(found, "no outline nav in the page")
        return found.group(0)

    def test_every_section_is_listed_in_document_order(self):
        nav = self.nav(self.rendered("<h2>Alpha</h2><h2>Beta</h2><h2>Gamma</h2>"))
        self.assertEqual(
            re.findall(r'<a href="#([^"]*)">([^<]*)</a>', nav),
            [("alpha", "Alpha"), ("beta", "Beta"), ("gamma", "Gamma")],
        )

    def test_links_point_at_the_ids_the_body_carries(self):
        """Anchors and headings come from one pass, so they cannot disagree."""
        page = self.rendered('<h2>Same</h2><h2 id="kept">Same</h2><h2>Same</h2>')
        for heading_id in ("same", "kept", "same-2"):
            with self.subTest(id=heading_id):
                self.assertIn(f'<h2 id="{heading_id}">', page)
                self.assertIn(f'href="#{heading_id}"', self.nav(page))

    def test_link_text_is_the_flattened_heading_text(self):
        nav = self.nav(
            self.rendered("<h2><em>Deep</em> Dive</h2><h2>Salt &amp; Pepper</h2>")
        )
        self.assertIn('<a href="#deep-dive">Deep Dive</a>', nav)
        self.assertIn('<a href="#salt-pepper">Salt &amp; Pepper</a>', nav)

    def test_outline_sits_above_the_body_in_one_wrapper(self):
        """Source order is the narrow layout; the wide one is the grid's job."""
        page = self.rendered(OutlineTests.TWO_H2)
        self.assertLess(
            page.index('class="artifact-main"'), page.index('class="artifact-outline"')
        )
        self.assertLess(
            page.index('class="artifact-outline"'), page.index('class="artifact-body"')
        )

    def test_disclosure_ships_open_and_labelled(self):
        """The fold is a real control at either width, and starts undone."""
        nav = self.nav(self.rendered(OutlineTests.TWO_H2))
        self.assertIn('<details class="artifact-outline-disclosure" open>', nav)
        self.assertIn(
            '<summary class="artifact-outline-summary">On this page</summary>', nav
        )
        self.assertIn('aria-label="On this page"', nav)

    def test_pages_with_nothing_to_navigate_get_no_outline(self):
        for body, extra in (
            ("<h2>Only</h2><p>x</p>", ()),
            ("<p>no headings</p>", ()),
            (OutlineTests.TWO_H2, ("--no-outline",)),
        ):
            with self.subTest(body=body, extra=extra):
                page = self.rendered(body, *extra)
                self.assertIsNone(self.OUTLINE_NAV.search(page))
                self.assertNotIn("artifact-outline", page)

    def test_ids_and_text_are_escaped(self):
        markup = cli.outline_html([{"id": 'a"b', "text": "Tom & <Jerry>"}])
        self.assertIn(
            '<a href="#a&quot;b">Tom &amp; &lt;Jerry&gt;</a>', markup
        )

    def test_empty_outline_renders_nothing(self):
        self.assertEqual(cli.outline_html([]), "")


class TemplateSectionTests(unittest.TestCase):
    """`{{#key}}...{{/key}}` is what keeps optional markup in the template."""

    def render(self, template: str, context: dict) -> str:
        path = Path(self.enterContext(tempfile.TemporaryDirectory())) / "t.html"
        path.write_text(template, encoding="utf-8")
        return cli.render_template(context, path)

    def test_section_is_kept_and_filled_when_the_value_is_present(self):
        self.assertEqual(
            self.render("a{{#xs}}[{{x}}]{{/xs}}b", {"xs": [1], "x": "hi"}), "a[hi]b"
        )

    def test_section_is_dropped_whole_when_the_value_is_empty(self):
        """An empty outline must leave no nav, no disclosure, no empty shell."""
        self.assertEqual(
            self.render("a{{#xs}}[{{x}}]{{/xs}}b", {"xs": [], "x": "hi"}), "ab"
        )

    def test_a_placeholder_only_inside_a_dropped_section_is_not_required(self):
        """The items placeholder may hold nothing when the section goes away."""
        self.assertEqual(self.render("a{{#xs}}{{x}}{{/xs}}b", {"xs": [], "x": ""}), "ab")

    def test_a_section_key_missing_from_the_context_is_an_error(self):
        with self.assertRaises(KeyError):
            self.render("{{#xs}}x{{/xs}}", {})

    def test_a_mismatched_closing_tag_is_an_error(self):
        with self.assertRaises(KeyError):
            self.render("{{#xs}}x{{/ys}}", {"xs": [1], "ys": [1]})

    def test_the_artifact_template_carries_the_outline_markup(self):
        """The nav lives in the theme's template, not in a Python string."""
        template = cli.TEMPLATE_PATH.read_text(encoding="utf-8")
        self.assertIn('<nav class="artifact-outline"', template)
        self.assertIn("{{#outline}}", template)
        self.assertIn("{{/outline}}", template)


class OutlineThemeTests(unittest.TestCase):
    """The two layouts are CSS alone - the markup ships one list either way."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.css = (cli.THEME_DIR / "lotuspod.css").read_text(encoding="utf-8")
        cls.wide = cls.css.split("@container (min-width: 58rem) {")[1].split("\n}\n")[0]

    def test_narrow_disclosure_is_styled(self):
        for hook in (
            ".artifact-outline-disclosure",
            ".artifact-outline-summary",
            ".artifact-outline-list",
        ):
            with self.subTest(hook=hook):
                self.assertIn(hook, self.css.split("@container")[0])

    def test_wide_layout_puts_the_outline_in_a_sticky_rail(self):
        self.assertIn("position: sticky", self.wide)
        self.assertIn("grid-area: 1 / 2", self.wide)
        self.assertIn("grid-area: 1 / 1", self.wide)

    def test_the_two_column_grid_forms_only_when_there_is_an_outline(self):
        """A body with no outline keeps the plain column - no empty rail."""
        for rule in self.wide.split("}"):
            if "display: grid" in rule:
                self.assertIn(":has(.artifact-outline)", rule)
                break
        else:
            self.fail("no grid rule in the wide layout")

    def test_the_rail_takes_its_room_out_of_the_breakout_measure(self):
        """Otherwise a full-width table would run under the rail."""
        self.assertIn("--measure-full", self.wide)
        self.assertIn("var(--outline-rail)", self.wide)

    def test_anchored_headings_keep_air_above_them(self):
        self.assertIn("scroll-margin-top", self.css)


class OutlineBodyTests(unittest.TestCase):
    """The id/outline primitive on its own, away from the render plumbing."""

    def test_markup_is_spliced_not_reserialized(self):
        body = '<h2 class="x"\n  data-y=\'1\'>Multi\n  Head!</h2><h2>Next</h2>'
        out, outline = cli.outline_body(body)
        self.assertIn('<h2 id="multi-head" class="x"\n  data-y=\'1\'>', out)
        self.assertEqual(outline[0], {"id": "multi-head", "text": "Multi Head!"})

    def test_nested_markup_and_entities_flatten_into_the_text(self):
        out, outline = cli.outline_body(
            "<h2><em>Deep</em> Dive</h2><h2>Salt &amp; Pepper</h2>"
        )
        self.assertEqual(
            outline,
            [
                {"id": "deep-dive", "text": "Deep Dive"},
                {"id": "salt-pepper", "text": "Salt & Pepper"},
            ],
        )
        self.assertIn('<h2 id="deep-dive"><em>Deep</em> Dive</h2>', out)

    def test_other_headings_are_untouched(self):
        body = "<h1>Title</h1><h2>A</h2><h3>a1</h3><h2>B</h2>"
        out, _ = cli.outline_body(body)
        self.assertIn("<h1>Title</h1>", out)
        self.assertIn("<h3>a1</h3>", out)

    def test_bodies_below_the_threshold_come_back_unchanged(self):
        for body in ("", "<p>x</p>", "<h2>Only</h2>"):
            with self.subTest(body=body):
                self.assertEqual(cli.outline_body(body), (body, []))

    def test_ids_on_other_elements_are_reserved_too(self):
        """An anchor that lands on a non-heading element is a broken anchor."""
        body = '<div id="notes">n</div><h2>Notes</h2><h2>Other</h2>'
        out, outline = cli.outline_body(body)
        self.assertIn('<h2 id="notes-2">Notes</h2>', out)
        self.assertEqual(outline[0], {"id": "notes-2", "text": "Notes"})
        self.assertEqual(cli.outline_body(out), (out, outline))

    def test_running_twice_is_a_fixed_point(self):
        once, outline = cli.outline_body("<h2>A</h2><h2>B</h2>")
        self.assertEqual(cli.outline_body(once), (once, outline))

    def test_unsluggable_headings_fall_back_to_section(self):
        _, outline = cli.outline_body("<h2>!!!</h2><h2>???</h2>")
        self.assertEqual([entry["id"] for entry in outline], ["section", "section-2"])

    def test_slugify_rule(self):
        self.assertEqual(cli.slugify("  Hello, World!  "), "hello-world")
        self.assertEqual(cli.slugify("Episode 2 — Recap"), "episode-2-recap")
        self.assertEqual(cli.slugify("***"), "section")


class ModuleEntryPointTests(unittest.TestCase):
    """`python -m lotuspod` must reach the same CLI as the console script.

    pyproject declares the `lotuspod` console script, but that shim only
    exists once the package is installed; `python -m lotuspod` is what works
    from a bare checkout, so the package needs a __main__ module.
    """

    def run_module(self, *argv: str) -> subprocess.CompletedProcess:
        env = dict(os.environ, PYTHONPATH=str(SRC_DIR))
        return subprocess.run(
            [sys.executable, "-m", "lotuspod", *argv],
            capture_output=True, text=True, env=env, cwd=str(SRC_DIR.parent),
        )

    def test_module_invocation_runs_the_cli(self):
        proc = self.run_module("--help")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("usage: lotuspod", proc.stdout)
        for command in ("render", "manifest", "index", "serve"):
            self.assertIn(command, proc.stdout)

    def test_module_invocation_renders(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = self.run_module(
                "render", "--name", "ep-mod", "--title", "Mod",
                "--body", "<h2>Alpha</h2><h2>Beta</h2>", "--out-dir", tmp,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            page = (Path(tmp) / "ep-mod.html").read_text(encoding="utf-8")
        self.assertIn('<h2 id="alpha">Alpha</h2>', page)
        self.assertIn('<h2 id="beta">Beta</h2>', page)


if __name__ == "__main__":
    unittest.main()
