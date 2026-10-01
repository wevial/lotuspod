"""`lotuspod backup` and `lotuspod restore`: one backup set of serve's database,
the artifacts repository and the media directory together, and a restore that
is tested.

    lotuspod backup [--db PATH] [--out-dir DIR] [--to BACKUPS] [--keep N] [--json]
    lotuspod backup --verify SET|latest [--to BACKUPS]
    lotuspod restore SET --db PATH --out-dir DIR

A set is a directory BACKUPS/UTC-TIMESTAMP holding a copy of the database
made with SQLite's online backup, a bundle of every ref of the artifacts
repository, media/ holding every stored image under its name, and
manifest.json: each file's SHA-256, the images' names (an image's checksum is
its name), the database's schema version, the repository's HEAD and its
origin, if it has one. All three are taken under the output directory's
publish lock, so no publish lands between them while serve keeps answering.
An image the newest earlier set holds is hard-linked from it, so a set costs
only the images added since. A set is written under a dotted name and renamed
into place whole, so a set that is there is complete.

A restore checks every checksum before it writes anything, and never writes
over an existing database or output directory. Images go into the media
directory beside the restored output directory, which may already exist: a
file there under an image's name must hold that image, and nothing there is
replaced or removed. It never pushes.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path

# cli imports this module too: only names used at call time are read from it.
from lotuspod import cli, db, media

MANIFEST = "manifest.json"
DATABASE = "lotuspod.sqlite3"
BUNDLE = "artifacts.bundle"
MEDIA = "media"
# 2 added the media list; a set at 1 holds no images.
MANIFEST_VERSION = 2
DEFAULT_KEEP = 14
DEFAULT_BACKUPS = "lotuspod-backups"
LATEST = "latest"
BRANCH = "main"
# A set's name: its UTC time to the microsecond, so names sort as times do.
_SET_NAME = re.compile(r"^\d{8}T\d{6}\.\d{6}Z$")
# Files beside a database that SQLite would read as part of it.
_DATABASE_SIDES = ("-wal", "-shm", "-journal")


class Failed(Exception):
    """A backup, restore or verification that stopped; the message says why."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def set_name(now: _dt.datetime | None = None) -> str:
    return (now or _dt.datetime.now(_dt.timezone.utc)).strftime("%Y%m%dT%H%M%S.%fZ")


def sets(backups: Path) -> list[Path]:
    """The sets in backups, oldest first."""
    if not backups.is_dir():
        return []
    return sorted(p for p in backups.iterdir() if _SET_NAME.match(p.name) and p.is_dir())


def backups_dir(args: argparse.Namespace, out_dir: Path) -> Path:
    """--to, else lotuspod-backups beside the output directory; never inside it,
    where the artifacts repository would commit it."""
    backups = Path(args.to).resolve() if args.to else out_dir.parent / DEFAULT_BACKUPS
    if backups == out_dir or out_dir in backups.parents:
        raise Failed(f"--to {backups} is inside the output directory {out_dir}; "
                     "the artifacts repository would commit it")
    return backups


def output_dir(args: argparse.Namespace) -> Path:
    return (Path(args.out_dir) if args.out_dir else cli.DEFAULT_OUTPUT_DIR).resolve()


def own_repository(out_dir: Path) -> bool:
    try:
        top = cli._git(out_dir, "rev-parse", "--show-toplevel")
    except OSError:
        return False
    return (top.returncode == 0 and bool(top.stdout.strip())
            and Path(top.stdout.strip()).resolve() == out_dir)


def git(cwd: Path, *argv: str) -> str:
    try:
        return cli._git_ok(cwd, *argv).strip()
    except (cli._GitFailed, OSError) as exc:
        raise Failed(str(exc)) from None


def copy_database(source: Path, target: Path) -> int:
    """Copy the live database with SQLite's online backup; its schema version.
    The database is opened as serve opens it, so one serve has not made yet is
    made, empty, at this lotuspod's schema (take allows that only before the
    first set). The copy is one file, in
    rollback-journal mode."""
    try:
        db.Database(source).responder_paused()  # any read makes the schema
        with closing(sqlite3.connect(f"{source.as_uri()}?mode=rw", uri=True,
                                     timeout=db.BUSY_TIMEOUT)) as live, \
                closing(sqlite3.connect(str(target))) as copy:
            live.backup(copy)
            copy.execute("PRAGMA journal_mode = DELETE")
            return copy.execute("PRAGMA user_version").fetchone()[0]
    except sqlite3.Error as exc:
        raise Failed(f"cannot copy the database {source}: {exc}") from None


def image_hash(name: str) -> str:
    """The SHA-256 a stored image's name records."""
    return name.partition(".")[0]


def held_image(path: Path) -> bool:
    """Whether path is a regular file holding the bytes its name hashes."""
    try:
        return (not path.is_symlink() and path.is_file()
                and sha256(path) == image_hash(path.name))
    except OSError:
        return False


def copy_media(source: Path, target: Path, earlier: Path | None) -> list[str]:
    """Put every stored image in source into the new directory target,
    hard-linked from earlier when that set already holds it; their names.
    Temporary files, dotfiles, symbolic links and other names are left out,
    and a missing source gives an empty target."""
    target.mkdir(mode=0o700)
    if not source.is_dir():
        return []
    names = []
    for entry in os.scandir(source):
        if not media.STORED_NAME.fullmatch(entry.name) \
                or not entry.is_file(follow_symlinks=False):
            continue
        copy, linked = target / entry.name, False
        held = earlier / MEDIA / entry.name if earlier else None
        if held is not None and held_image(held):
            try:
                os.link(held, copy)
                linked = True
            except OSError:
                pass
        if not linked:
            shutil.copyfile(entry.path, copy, follow_symlinks=False)
            os.chmod(copy, 0o600)
        names.append(entry.name)
    return sorted(names)


def take(db_path: Path, out_dir: Path, backups: Path) -> Path:
    """Write one set of db_path, out_dir's repository and its media directory
    into backups."""
    if not out_dir.is_dir() or not own_repository(out_dir):
        raise Failed(f"{out_dir} is not its own git repository; nothing backed up")
    if db_path.exists() and not db_path.is_file():
        raise Failed(f"{db_path} is not a database file; nothing backed up")
    # serve makes its database on first use, so a first backup may find none
    # and make it as serve would. Once a set exists the database existed, and
    # one missing now is a wrong --db or a lost file: an empty set must not
    # take the place of the sets that hold it.
    if not os.path.lexists(db_path) and sets(backups):
        raise Failed(f"no database at {db_path}, though {backups} holds earlier sets; "
                     "nothing backed up")
    backups.mkdir(parents=True, exist_ok=True)
    with cli.publish_lock(out_dir):
        earlier = sets(backups)
        name = set_name()
        final = backups / name
        partial = backups / f".{name}.partial"
        partial.mkdir(mode=0o700)
        try:
            schema = copy_database(db_path, partial / DATABASE)
            git(out_dir, "bundle", "create", str(partial / BUNDLE), "--all")
            head = git(out_dir, "rev-parse", "--verify", "HEAD")
            remote = cli._git(out_dir, "remote", "get-url", "origin")
            images = copy_media(media.media_dir(out_dir), partial / MEDIA,
                                earlier[-1] if earlier else None)
            manifest = {
                "version": MANIFEST_VERSION,
                "created": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
                "files": {},
                "schema_version": schema,
                "head": head,
                "remote": remote.stdout.strip() if remote.returncode == 0 else None,
                "media": images,
            }
            for file in (DATABASE, BUNDLE):
                os.chmod(partial / file, 0o600)
                manifest["files"][file] = sha256(partial / file)
            cli.write_atomic(partial / MANIFEST,
                             (json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
            partial.rename(final)
        except BaseException:
            shutil.rmtree(partial, ignore_errors=True)
            raise
    return final


def prune(backups: Path, keep: int) -> list[Path]:
    """Remove all but the newest keep sets; the ones removed."""
    old = sets(backups)[:-keep]
    for path in old:
        shutil.rmtree(path)
    return old


def read_manifest(backup: Path) -> dict:
    try:
        manifest = json.loads((backup / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise Failed(f"{backup / MANIFEST} cannot be read: {exc}") from None
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, dict) or not {DATABASE, BUNDLE} <= files.keys():
        raise Failed(f"{backup / MANIFEST} does not name {DATABASE} and {BUNDLE}")
    if not isinstance(manifest.get("head"), str) or not manifest["head"]:
        raise Failed(f"{backup / MANIFEST} records no HEAD")
    version = manifest.get("version")
    if "media" not in manifest and isinstance(version, int) and version < 2:
        manifest["media"] = []
    images = manifest.get("media")
    if not isinstance(images, list) or not all(
            isinstance(name, str) and media.STORED_NAME.fullmatch(name) for name in images) \
            or len(set(images)) != len(images):
        raise Failed(f"{backup / MANIFEST} does not list its images by their stored names")
    return manifest


def check(backup: Path) -> dict:
    """The set's manifest, once every file it names matches its checksum."""
    manifest = read_manifest(backup)
    for file, digest in manifest["files"].items():
        path = backup / file
        if Path(file).name != file or not path.is_file():
            raise Failed(f"{path} is missing")
        if sha256(path) != digest:
            raise Failed(f"{path} does not match its checksum in {MANIFEST}")
    for name in manifest["media"]:
        path = backup / MEDIA / name
        if path.is_symlink() or not path.is_file():
            raise Failed(f"{path} is missing")
        if sha256(path) != image_hash(name):
            raise Failed(f"{path} does not match the hash in its name")
    return manifest


def restore_images(backup: Path, names: list[str], target: Path) -> None:
    """Copy each image the set holds into target, through a temporary name
    renamed into place, skipping one already there; never a link, since
    target may be on another file system."""
    if not names:
        return
    target.mkdir(parents=True, exist_ok=True)
    for name in names:
        final = target / name
        if os.path.lexists(final):
            continue
        tmp = target / f".{name}.{os.getpid()}.{os.urandom(4).hex()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
        try:
            with os.fdopen(fd, "wb") as dst, open(backup / MEDIA / name, "rb") as src:
                shutil.copyfileobj(src, dst)
                dst.flush()
                os.fsync(dst.fileno())
            if not os.path.lexists(final):
                os.rename(tmp, final)
        finally:
            tmp.unlink(missing_ok=True)


def restore(backup: Path, db_path: Path, out_dir: Path) -> dict:
    """Rebuild the database at db_path and the repository at out_dir from the
    set, with main checked out at its HEAD, and add its images to the media
    directory beside out_dir; its manifest. Nothing is written unless every
    checksum matches, neither path exists, and every file already in the
    media directory under one of the set's names holds that image."""
    manifest = check(backup)
    if db_path == out_dir or out_dir in db_path.parents:
        raise Failed(f"--db {db_path} is inside the output directory {out_dir}")
    for side in ("", *_DATABASE_SIDES):
        taken = Path(f"{db_path}{side}")
        if os.path.lexists(taken):
            raise Failed(f"{taken} already exists; nothing restored")
    if os.path.lexists(out_dir):
        raise Failed(f"{out_dir} already exists; nothing restored")
    store = media.media_dir(out_dir)
    if manifest["media"]:
        if os.path.lexists(store) and not store.is_dir():
            raise Failed(f"{store} is not a directory; nothing restored")
        for name in manifest["media"]:
            there = store / name
            if os.path.lexists(there) and not held_image(there):
                raise Failed(f"{there} already exists and does not hold the image "
                             "its name hashes; nothing restored")

    out_dir.parent.mkdir(parents=True, exist_ok=True)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    partial = Path(tempfile.mkdtemp(prefix=f".{out_dir.name}.", suffix=".restore",
                                    dir=out_dir.parent))
    wrote_db = False
    try:
        clone = partial / "repo"
        git(out_dir.parent, "clone", "-q", "--no-checkout", str(backup / BUNDLE), str(clone))
        git(clone, "checkout", "-q", "-B", BRANCH, manifest["head"])
        if manifest.get("remote"):
            git(clone, "remote", "set-url", "origin", manifest["remote"])
        else:
            git(clone, "remote", "remove", "origin")
        with open(backup / DATABASE, "rb") as src, open(db_path, "xb") as dst:
            wrote_db = True
            shutil.copyfileobj(src, dst)
        os.chmod(db_path, 0o600)
        restore_images(backup, manifest["media"], store)
        if os.path.lexists(out_dir):
            raise Failed(f"{out_dir} already exists; nothing restored")
        clone.rename(out_dir)
    except BaseException:
        if wrote_db:
            db_path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(partial, ignore_errors=True)
    return manifest


def resolve_set(value: str, backups: Path) -> Path:
    if value != LATEST:
        return Path(value).resolve()
    found = sets(backups)
    if not found:
        raise Failed(f"no backup sets in {backups}")
    return found[-1]


def verify(backup: Path) -> dict:
    """Restore the set into scratch space and check what came back."""
    with tempfile.TemporaryDirectory(prefix="lotuspod-verify-") as scratch:
        db_path, out_dir = Path(scratch) / DATABASE, Path(scratch) / "site"
        manifest = restore(backup, db_path, out_dir)
        try:
            conn = sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True)
            try:
                result = [row[0] for row in conn.execute("PRAGMA integrity_check")]
                schema = conn.execute("PRAGMA user_version").fetchone()[0]
            finally:
                conn.close()
        except sqlite3.Error as exc:
            raise Failed(f"{backup / DATABASE} cannot be read: {exc}") from None
        if result != ["ok"]:
            raise Failed(f"{backup / DATABASE} fails its integrity check: "
                         f"{' '.join(result[:3])}")
        if schema != manifest.get("schema_version"):
            raise Failed(f"{backup / DATABASE} is at schema {schema}, not the "
                         f"{manifest.get('schema_version')} {MANIFEST} records")
        try:
            git(out_dir, "fsck", "--full", "--no-progress")
        except Failed as exc:
            raise Failed(f"{backup / BUNDLE} fails git fsck: {exc}") from None
        head = git(out_dir, "rev-parse", "HEAD")
        if head != manifest["head"]:
            raise Failed(f"{backup / BUNDLE} restores HEAD {head}, not the "
                         f"{manifest['head']} {MANIFEST} records")
        store = media.media_dir(out_dir)
        found = sorted(p.name for p in store.iterdir()) if store.is_dir() else []
        if found != sorted(manifest["media"]):
            raise Failed(f"{backup / MEDIA} restores {len(found)} images, not the "
                         f"{len(manifest['media'])} {MANIFEST} lists")
        for name in found:
            if not held_image(store / name):
                raise Failed(f"{backup / MEDIA / name} restores bytes that do not "
                             "match the hash in its name")
    return manifest


def cmd_backup(args: argparse.Namespace) -> int:
    out_dir = output_dir(args)
    try:
        backups = backups_dir(args, out_dir)
        if args.verify is not None:
            backup = resolve_set(args.verify, backups)
            manifest = verify(backup)
            print(f"verified {backup}: database schema {manifest['schema_version']} "
                  f"intact, repository at {manifest['head']}, "
                  f"{len(manifest['media'])} images")
            return 0
        db_path = cli.serve_db_path(out_dir, args.db)
        made = take(db_path, out_dir, backups)
        removed = prune(backups, args.keep)
    except (Failed, ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"backup": str(made)}))
    else:
        print(f"backed up {db_path}, {out_dir} and its images to {made}")
        if removed:
            print(f"removed {len(removed)} older set{'s' if len(removed) != 1 else ''}")
    return 0


def cmd_restore(args: argparse.Namespace) -> int:
    # Absolute but not resolved: an existing symbolic link, even one whose
    # target is gone, is an existing path, and resolving it would hide it.
    out_dir = Path(os.path.abspath(args.out_dir))
    db_path = Path(os.path.abspath(args.db))
    try:
        manifest = restore(Path(args.set).resolve(), db_path, out_dir)
    except (Failed, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"restored {db_path} and {out_dir} at {manifest['head']}, "
          f"{len(manifest['media'])} images in {media.media_dir(out_dir)}")
    return 0


def _keep(value: str) -> int:
    if not value.isdigit() or int(value) < 1:
        raise argparse.ArgumentTypeError(f"not a whole number, 1 or more: {value!r}")
    return int(value)


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod backup` and `lotuspod restore`."""
    backup = sub.add_parser(
        "backup",
        help="back up serve's database, the artifacts repository and its images "
        "together, or verify a backup set",
        description="Write one backup set of serve's database, the artifacts "
        "repository and its media directory into BACKUPS/UTC-TIMESTAMP under the publish "
        "lock, while serve keeps serving: a copy of the database, a git bundle of every "
        "ref, media/ with every stored image (hard-linked from the newest earlier set "
        "when it holds one), and manifest.json with their SHA-256s, the images' names, "
        "the schema version and HEAD. Keeps the newest --keep sets. "
        "With --verify, restore a set into scratch space and check it instead.",
    )
    backup.add_argument("--out-dir", default="",
                        help="artifacts directory, its own git repository (default: artifacts/)")
    backup.add_argument(
        "--db", default="", metavar="PATH",
        help=f"serve's database (default: {db.DEFAULT_NAME} beside the artifacts directory)",
    )
    backup.add_argument(
        "--to", default="", metavar="BACKUPS",
        help=f"directory of backup sets (default: {DEFAULT_BACKUPS} beside the artifacts "
        "directory; never inside it)",
    )
    backup.add_argument("--keep", type=_keep, default=DEFAULT_KEEP, metavar="N",
                        help=f"sets to keep, newest first (default: {DEFAULT_KEEP})")
    backup.add_argument("--json", action="store_true", help='print {"backup": PATH}')
    backup.add_argument(
        "--verify", default=None, metavar="SET",
        help=f"restore SET ('{LATEST}': the newest in BACKUPS) into scratch space, check "
        "the database's integrity, git fsck, HEAD and every image's hash, and exit 1 "
        "naming the first failure",
    )
    backup.set_defaults(func=cmd_backup)

    restore_parser = sub.add_parser(
        "restore",
        help="rebuild the database, the artifacts repository and its images from a "
        "backup set",
        description="Check every checksum in SET, then copy its database to --db, "
        "clone its bundle into --out-dir with main checked out at the recorded HEAD, "
        f"and copy its images into {media.MEDIA_DIR_NAME} beside --out-dir, adding to "
        "it when it exists. Refuses, changing nothing, when either path exists or a "
        "file already there under an image's name holds other bytes. Never pushes.",
    )
    restore_parser.add_argument("set", metavar="SET", help="a backup set directory")
    restore_parser.add_argument("--db", required=True, metavar="PATH",
                                help="where the database goes; must not exist")
    restore_parser.add_argument("--out-dir", required=True, metavar="DIR",
                                help="where the artifacts repository goes; must not exist")
    restore_parser.set_defaults(func=cmd_restore)
