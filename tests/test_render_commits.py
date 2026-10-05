"""render, manifest and index commit and push an output directory that is
the top of its own git repository, and leave every other directory alone.

Real git throughout, in temporary directories, with a local bare
repository as origin; no network.
"""

from __future__ import annotations

import io
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from lotuspod import cli  # noqa: E402


SOURCE_BYTES = "# Pond\n\nStill water, café.\r\n".encode("utf-8")


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


def git(cwd: Path, *argv: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True
    )
    return done.stdout


def identify(repo: Path) -> None:
    git(repo, "config", "user.name", "Lotuspod Test")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "commit.gpgsign", "false")


class RepoTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.bare = self.tmp / "origin.git"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        self.out_dir = self.tmp / "artifacts"
        git(self.tmp, "clone", "-q", str(self.bare), str(self.out_dir))
        identify(self.out_dir)

    def render(self, name: str, *extra: str) -> tuple[int, str, str]:
        return run_cli(
            "render", "--name", name, "--title", name.title(),
            "--body", "<p>water</p>", "--out-dir", str(self.out_dir), *extra,
        )

    def remote_files(self) -> set[str]:
        return set(git(self.bare, "ls-tree", "-r", "--name-only", "main").split())

    def remote_commits(self) -> int:
        done = subprocess.run(
            ["git", "-C", str(self.bare), "rev-list", "--count", "--all"],
            capture_output=True, text=True, check=True,
        )
        return int(done.stdout.strip())


class OwnRepositoryTests(RepoTestCase):
    def test_render_manifest_index_reach_the_remote(self):
        self.assertEqual(self.remote_commits(), 0)
        source = self.tmp / "draft.md"
        source.write_bytes(SOURCE_BYTES)

        rc, _, err = self.render("pond", "--source", str(source))
        self.assertEqual((rc, err), (0, ""))
        rc, _, err = run_cli("manifest", "--out-dir", str(self.out_dir))
        self.assertEqual((rc, err), (0, ""))
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual((rc, err), (0, ""))

        files = self.remote_files()
        for name in ("pond.html", "pond.md", cli.MANIFEST_FILE, cli.INDEX_FILE):
            self.assertIn(name, files)
        blob = subprocess.run(
            ["git", "-C", str(self.bare), "show", "main:pond.md"],
            capture_output=True, check=True,
        ).stdout
        self.assertEqual(blob, SOURCE_BYTES)
        self.assertEqual((self.out_dir / "pond.md").read_bytes(), SOURCE_BYTES)
        self.assertEqual(git(self.out_dir, "status", "--porcelain"), "")
        subjects = git(self.bare, "log", "--format=%s", "main").split("\n")
        self.assertEqual(subjects[:3], ["index", "manifest", "render pond"])

    def test_render_without_source_writes_no_markdown(self):
        rc, _, err = self.render("pond")
        self.assertEqual((rc, err), (0, ""))
        self.assertNotIn("pond.md", self.remote_files())

    def test_source_edited_in_place_beside_the_page_is_pushed(self):
        source = self.tmp / "draft.md"
        source.write_bytes(SOURCE_BYTES)
        rc, _, err = self.render("pond", "--source", str(source))
        self.assertEqual((rc, err), (0, ""))

        beside = self.out_dir / "pond.md"
        edited = SOURCE_BYTES + b"\nDeeper.\n"
        beside.write_bytes(edited)
        rc, _, err = run_cli(
            "render", "--name", "pond", "--title", "Pond",
            "--body", "<p>deeper water</p>", "--out-dir", str(self.out_dir),
            "--source", str(beside),
        )
        self.assertEqual((rc, err), (0, ""))
        self.assertEqual(beside.read_bytes(), edited)
        blob = subprocess.run(
            ["git", "-C", str(self.bare), "show", "main:pond.md"],
            capture_output=True, check=True,
        ).stdout
        self.assertEqual(blob, edited)
        self.assertIn("deeper water", git(self.bare, "show", "main:pond.html"))
        self.assertEqual(git(self.out_dir, "status", "--porcelain"), "")

    def test_push_succeeds_after_origin_moved_ahead(self):
        rc, _, err = self.render("first")
        self.assertEqual((rc, err), (0, ""))

        other = self.tmp / "other"
        git(self.tmp, "clone", "-q", str(self.bare), str(other))
        identify(other)
        (other / "unrelated.txt").write_text("elsewhere\n", encoding="utf-8")
        git(other, "add", "-A")
        git(other, "commit", "-q", "-m", "unrelated")
        git(other, "push", "-q", "origin", "HEAD:main")

        rc, _, err = self.render("second")
        self.assertEqual((rc, err), (0, ""))
        files = self.remote_files()
        self.assertIn("unrelated.txt", files)
        self.assertIn("second.html", files)
        self.assertEqual(git(self.out_dir, "status", "--porcelain"), "")
        self.assertEqual(
            git(self.out_dir, "rev-parse", "HEAD"),
            git(self.bare, "rev-parse", "main"),
        )

    def test_unreachable_origin_warns_and_commits_locally(self):
        git(self.out_dir, "remote", "set-url", "origin", str(self.tmp / "gone.git"))
        rc, _, err = self.render("pond")
        self.assertEqual(rc, 0)
        self.assertTrue((self.out_dir / "pond.html").is_file())
        self.assertEqual(len(err.splitlines()), 1, err)
        self.assertTrue(err.startswith("warning: "), err)
        self.assertEqual(git(self.out_dir, "log", "--format=%s").strip(), "render pond")
        self.assertEqual(git(self.out_dir, "status", "--porcelain"), "")
        self.assertEqual(self.remote_commits(), 0)


class NotOwnRepositoryTests(unittest.TestCase):
    def test_subdirectory_of_a_repository_gains_no_commit(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        repo = Path(tmp.name).resolve()
        git(repo, "init", "-q", "-b", "main")
        identify(repo)
        (repo / ".gitignore").write_text("artifacts/\n", encoding="utf-8")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "start")
        head = git(repo, "rev-parse", "HEAD")
        status = git(repo, "status", "--porcelain")
        out_dir = repo / "artifacts"

        rc, _, err = run_cli(
            "render", "--name", "pond", "--title", "Pond", "--out-dir", str(out_dir)
        )
        self.assertEqual((rc, err), (0, ""))
        self.assertTrue((out_dir / "pond.html").is_file())
        self.assertEqual(git(repo, "rev-parse", "HEAD"), head)
        self.assertEqual(git(repo, "rev-list", "--count", "--all").strip(), "1")
        self.assertEqual(git(repo, "status", "--porcelain"), status)


class ServedRepositoryTests(RepoTestCase):
    def setUp(self) -> None:
        super().setUp()
        source = self.tmp / "draft.md"
        source.write_bytes(SOURCE_BYTES)
        rc, _, err = self.render("pond", "--source", str(source))
        assert rc == 0, err
        self.server = cli._make_server(self.out_dir, "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)

    def _stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def status(self, path: str) -> int:
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{self.port}{path}", timeout=5
            ) as resp:
                return resp.status
        except urllib.error.HTTPError as exc:
            return exc.code

    def test_git_directory_and_markdown_source_are_not_served(self):
        self.assertTrue((self.out_dir / ".git" / "config").is_file())
        self.assertTrue((self.out_dir / "pond.md").is_file())
        self.assertEqual(self.status("/pond.html"), 200)
        self.assertEqual(self.status("/.git/config"), 404)
        self.assertEqual(self.status("/pond.md"), 404)


if __name__ == "__main__":
    unittest.main()
