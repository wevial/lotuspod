"""`lotuspod backup` and `lotuspod restore`: a set's manifest, a restore that
checks every checksum before writing, `backup --verify` on a good set and on
a truncated bundle, keeping the newest sets, refusing an output directory
that is not a git repository, waiting for the publish lock, and the nightly
systemd units.

Real git and SQLite; the CLI runs as a subprocess from this checkout's src/.

Run from the repo root:

    python -m unittest tests.test_backup -v
"""

from __future__ import annotations

import fcntl
import json
import os
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import backup, db  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
TIMEOUT = 120


def git(cwd: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True,
                          timeout=TIMEOUT)


def tree(path: Path) -> list[str]:
    return sorted(str(p.relative_to(path)) for p in path.rglob("*")) if path.exists() else []


class Backups(unittest.TestCase):
    """An artifacts repository with one commit and a remote, and a database
    holding one answer."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.out = self.tmp / "site"
        self.db = self.tmp / "lotuspod.sqlite3"
        self.backups = self.tmp / "backups"
        self.bare = self.tmp / "origin.git"
        for argv in (("init", "-q", "--bare", "-b", "main", str(self.bare)),
                     ("clone", "-q", str(self.bare), str(self.out))):
            done = git(self.tmp, *argv)
            self.assertEqual(done.returncode, 0, done.stderr)
        for key, value in (("user.name", "Test"), ("user.email", "test@lotuspod.invalid"),
                           ("commit.gpgsign", "false")):
            git(self.out, "config", key, value)
        (self.out / "page.html").write_text("<p>a page</p>\n", encoding="utf-8")
        for argv in (("add", "-A"), ("commit", "-q", "-m", "a page"),
                     ("push", "-q", "origin", "HEAD:main")):
            done = git(self.out, *argv)
            self.assertEqual(done.returncode, 0, done.stderr)
        self.head = git(self.out, "rev-parse", "HEAD").stdout.strip()
        db.Database(self.db).add_answer(
            page="page", question="q1", version="1", choice="yes", note="",
            revision="abc", actor={"kind": "reader", "email": "reader@example.com"})
        self.env = dict(os.environ, PYTHONPATH=str(SRC), LOTUSPOD_CONFIG="")

    def cli(self, *argv: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "lotuspod", *argv], cwd=str(self.tmp),
                              env=self.env, capture_output=True, text=True, timeout=TIMEOUT)

    def take(self, *extra: str) -> Path:
        done = self.cli("backup", "--db", str(self.db), "--out-dir", str(self.out),
                        "--to", str(self.backups), "--json", *extra)
        self.assertEqual(done.returncode, 0, done.stderr)
        return Path(json.loads(done.stdout)["backup"])


class BackupTests(Backups):
    def test_a_set_holds_the_database_the_bundle_and_their_manifest(self):
        made = self.take()
        self.assertEqual(made.parent, self.backups)
        self.assertRegex(made.name, r"^\d{8}T\d{6}\.\d{6}Z$")
        self.assertEqual(sorted(p.name for p in made.iterdir()),
                         ["artifacts.bundle", "lotuspod.sqlite3", "manifest.json"])
        manifest = json.loads((made / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["head"], self.head)
        self.assertEqual(manifest["schema_version"], db.SCHEMA_VERSION)
        self.assertEqual(manifest["remote"], str(self.bare))
        for name in ("artifacts.bundle", "lotuspod.sqlite3"):
            self.assertEqual(manifest["files"][name], backup.sha256(made / name))
            self.assertEqual((made / name).stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(made / "lotuspod.sqlite3") as conn:
            self.assertEqual(conn.execute("SELECT choice FROM answers").fetchall(), [("yes",)])
        self.assertEqual([p.name for p in self.backups.iterdir()], [made.name])

    def test_a_restore_rebuilds_both_with_main_at_head_and_the_recorded_origin(self):
        made = self.take()
        restored_db, restored_out = self.tmp / "new" / "db.sqlite3", self.tmp / "new" / "site"
        done = self.cli("restore", str(made), "--db", str(restored_db),
                        "--out-dir", str(restored_out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(git(restored_out, "rev-parse", "HEAD").stdout.strip(), self.head)
        self.assertEqual(git(restored_out, "symbolic-ref", "--short", "HEAD").stdout.strip(),
                         "main")
        self.assertEqual(git(restored_out, "remote", "get-url", "origin").stdout.strip(),
                         str(self.bare))
        self.assertEqual(git(restored_out, "status", "--porcelain").stdout, "")
        answers = db.Database(restored_db).answers("page")
        self.assertEqual(answers["q1"]["current"]["choice"], "yes")
        self.assertEqual(sorted(p.name for p in (self.tmp / "new").iterdir()),
                         ["db.sqlite3", "site"])

    def test_a_restore_of_a_repository_without_a_remote_leaves_no_origin(self):
        git(self.out, "remote", "remove", "origin")
        made = self.take()
        restored_out = self.tmp / "restored"
        done = self.cli("restore", str(made), "--db", str(self.tmp / "r.sqlite3"),
                        "--out-dir", str(restored_out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(git(restored_out, "remote").stdout.strip(), "")

    def test_a_changed_byte_in_the_database_copy_refuses_the_restore_naming_it(self):
        made = self.take()
        copy = made / "lotuspod.sqlite3"
        data = bytearray(copy.read_bytes())
        data[len(data) // 2] ^= 0x01
        copy.write_bytes(bytes(data))
        before = tree(self.tmp)
        restored_db, restored_out = self.tmp / "restored.sqlite3", self.tmp / "restored"
        done = self.cli("restore", str(made), "--db", str(restored_db),
                        "--out-dir", str(restored_out))
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn("lotuspod.sqlite3", done.stderr)
        self.assertIn("checksum", done.stderr)
        self.assertFalse(restored_db.exists())
        self.assertFalse(restored_out.exists())
        self.assertEqual(tree(self.tmp), before)

    def test_a_restore_refuses_a_dangling_symbolic_link_at_either_path(self):
        made = self.take()
        for flag in ("--db", "--out-dir"):
            with self.subTest(flag=flag):
                link, target = self.tmp / f"link{flag}", self.tmp / f"gone{flag}"
                link.symlink_to(target)
                paths = {"--db": str(self.tmp / f"fresh{flag}.sqlite3"),
                         "--out-dir": str(self.tmp / f"fresh{flag}")}
                paths[flag] = str(link)
                before = tree(self.tmp)
                done = self.cli("restore", str(made), "--db", paths["--db"],
                                "--out-dir", paths["--out-dir"])
                self.assertEqual(done.returncode, 1, done.stderr)
                self.assertIn(str(link), done.stderr)
                self.assertFalse(os.path.lexists(target))
                self.assertEqual(os.readlink(link), str(target))
                self.assertEqual(tree(self.tmp), before)

    def test_verify_passes_a_good_set_and_fails_a_truncated_bundle_naming_it(self):
        good = self.take()
        done = self.cli("backup", "--verify", str(good))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(self.head, done.stdout)

        bad = self.backups / "bad"
        shutil.copytree(good, bad)
        bundle = bad / "artifacts.bundle"
        bundle.write_bytes(bundle.read_bytes()[: bundle.stat().st_size // 2])
        done = self.cli("backup", "--verify", str(bad))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("artifacts.bundle", done.stderr)

    def test_verify_latest_checks_the_newest_set_in_backups(self):
        self.take()
        newest = self.take()
        bundle = newest / "artifacts.bundle"
        bundle.write_bytes(bundle.read_bytes()[:40])
        done = self.cli("backup", "--verify", "latest", "--to", str(self.backups))
        self.assertEqual(done.returncode, 1)
        self.assertIn(str(bundle), done.stderr)
        done = self.cli("backup", "--verify", "latest", "--to", str(self.tmp / "none"))
        self.assertEqual(done.returncode, 1)
        self.assertIn("no backup sets", done.stderr)

    def test_verify_fails_a_database_that_fails_its_integrity_check(self):
        made = self.take()
        copy = made / "lotuspod.sqlite3"
        with sqlite3.connect(copy) as conn:
            page_size = conn.execute("PRAGMA page_size").fetchone()[0]
            pages = conn.execute("PRAGMA page_count").fetchone()[0]
        data = bytearray(copy.read_bytes())
        # Scribble over every page after the first, then record the new checksum,
        # so only SQLite's own check can find it.
        for page in range(1, pages):
            data[page * page_size + 8: page * page_size + 64] = b"\xff" * 56
        copy.write_bytes(bytes(data))
        manifest = json.loads((made / "manifest.json").read_text(encoding="utf-8"))
        manifest["files"]["lotuspod.sqlite3"] = backup.sha256(copy)
        (made / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        done = self.cli("backup", "--verify", str(made))
        self.assertEqual(done.returncode, 1)
        self.assertIn("lotuspod.sqlite3", done.stderr)

    def test_the_newest_keep_sets_remain_after_another_backup(self):
        self.backups.mkdir()
        old = [f"2020010{day // 10}T00000{day % 10}.000000Z" for day in range(16)]
        for name in old:
            (self.backups / name).mkdir()
            (self.backups / name / "manifest.json").write_text("{}", encoding="utf-8")
        (self.backups / "notes").mkdir()
        made = self.take("--keep", "14")
        self.assertEqual(sorted(p.name for p in self.backups.iterdir()),
                         sorted(old[-13:] + [made.name, "notes"]))

    def test_a_missing_database_is_refused_once_a_set_exists(self):
        first, second = self.take(), self.take()
        wrong = self.tmp / "wrong.sqlite3"
        done = self.cli("backup", "--db", str(wrong), "--out-dir", str(self.out),
                        "--to", str(self.backups), "--keep", "1")
        self.assertEqual(done.returncode, 1)
        self.assertIn(str(wrong), done.stderr)
        self.assertFalse(wrong.exists())
        self.assertEqual(backup.sets(self.backups), [first, second])

    def test_a_first_backup_makes_the_database_serve_has_not_made_yet(self):
        fresh = self.tmp / "fresh.sqlite3"
        made = self.take("--db", str(fresh))
        self.assertTrue(fresh.is_file())
        manifest = json.loads((made / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema_version"], db.SCHEMA_VERSION)

    def test_an_output_directory_that_is_not_a_git_repository_is_refused(self):
        plain = self.tmp / "plain"
        plain.mkdir()
        (plain / "page.html").write_text("<p>not committed</p>\n", encoding="utf-8")
        done = self.cli("backup", "--db", str(self.db), "--out-dir", str(plain),
                        "--to", str(self.backups))
        self.assertEqual(done.returncode, 1)
        self.assertIn(str(plain), done.stderr)
        self.assertFalse(self.backups.exists())

    def test_a_subdirectory_of_a_repository_is_refused(self):
        inner = self.out / "inner"
        inner.mkdir()
        done = self.cli("backup", "--db", str(self.db), "--out-dir", str(inner),
                        "--to", str(self.backups))
        self.assertEqual(done.returncode, 1)
        self.assertIn(str(inner), done.stderr)
        self.assertFalse(self.backups.exists())

    def test_backups_inside_the_output_directory_are_refused(self):
        done = self.cli("backup", "--db", str(self.db), "--out-dir", str(self.out),
                        "--to", str(self.out / "backups"))
        self.assertEqual(done.returncode, 1)
        self.assertFalse((self.out / "backups").exists())

    def test_a_backup_waits_for_the_publish_lock(self):
        lock = self.tmp / f".{self.out.name}.publish.lock"
        with open(lock, "a") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            running = subprocess.Popen(
                [sys.executable, "-m", "lotuspod", "backup", "--db", str(self.db),
                 "--out-dir", str(self.out), "--to", str(self.backups), "--json"],
                cwd=str(self.tmp), env=self.env, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True)
            self.addCleanup(running.kill)
            time.sleep(1.5)
            self.assertIsNone(running.poll())
            self.assertEqual(backup.sets(self.backups), [])
        stdout, stderr = running.communicate(timeout=TIMEOUT)
        self.assertEqual(running.returncode, 0, stderr)
        self.assertEqual(backup.sets(self.backups), [Path(json.loads(stdout)["backup"])])


class UnitFileTests(unittest.TestCase):
    def section(self, name: str, wanted: str) -> list[tuple[str, str]]:
        """The KEY=VALUE lines of a unit file's [wanted] section, repeats kept."""
        lines, current = [], None
        for raw in (REPO / "deploy" / name).read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith(("#", ";")):
                continue
            if line.startswith("["):
                current = line.strip("[]")
            elif current == wanted:
                key, _, value = line.partition("=")
                lines.append((key.strip(), value.strip()))
        return lines

    def test_the_timer_fires_daily_and_catches_up(self):
        timer = dict(self.section("lotuspod-backup.timer", "Timer"))
        self.assertEqual(timer["OnCalendar"], "daily")
        self.assertEqual(timer["Persistent"], "true")
        self.assertEqual(dict(self.section("lotuspod-backup.timer", "Install"))["WantedBy"],
                         "timers.target")

    def test_the_service_backs_up_then_verifies_the_latest_set_like_serve_s_unit(self):
        serve = dict(self.section("lotuspod.service", "Service"))
        lines = self.section("lotuspod-backup.service", "Service")
        service = dict(lines)
        self.assertEqual(service["Type"], "oneshot")
        self.assertEqual(service["WorkingDirectory"], serve["WorkingDirectory"])
        runs = [shlex.split(value) for key, value in lines if key == "ExecStart"]
        program = shlex.split(serve["ExecStart"])[0]
        self.assertEqual(len(runs), 2, runs)
        self.assertEqual(runs[0][:2], [program, "backup"])
        self.assertNotIn("--verify", runs[0])
        self.assertEqual(runs[1][:2], [program, "backup"])
        self.assertEqual(runs[1][runs[1].index("--verify") + 1], "latest")
        self.assertEqual(runs[0][2:], [arg for arg in runs[1][2:]
                                       if arg not in ("--verify", "latest")])
        for key in ("NoNewPrivileges", "PrivateTmp", "ProtectSystem", "ReadWritePaths"):
            self.assertEqual(service[key], serve[key], key)


if __name__ == "__main__":
    unittest.main()
