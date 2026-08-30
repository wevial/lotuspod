"""Test suite for manifest v2 and fail-closed visibility behavior.

Covers the shared visibility rule end to end: extract_visibility edges,
render's flag writing, the artifact page's back-link to the index,
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
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

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


if __name__ == "__main__":
    unittest.main()
