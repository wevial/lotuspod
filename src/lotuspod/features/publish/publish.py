"""publish: a page from its markdown or HTML source, here or over ssh."""

from __future__ import annotations

import argparse
import datetime as _dt
import html
import json
import re
import shlex
import sqlite3
import subprocess
import sys
from functools import partial
from pathlib import Path

from lotuspod import core
from lotuspod.features import agents
from lotuspod.core import (BODY_SOURCE_SUFFIX, DEFAULT_OUTPUT_DIR, DEFAULT_REMOTE_COMMAND,
                           EXIT_CONFIG, EXIT_REVISION_CONFLICT, INDEX_FILE, _KEPT_SOURCE_SUFFIX,
                           ConfigError,
                           commit_output, config_path, extract_meta, html_title, markdown_title,
                           normalized, page_revision, publish_config, publish_lock,
                           source_revision, write_atomic)
from lotuspod.features import blocks
from lotuspod.features import decisions
from lotuspod.features import index
from lotuspod.features import serve
from lotuspod.features.publish import markdown, media
from lotuspod.features.publish.manifest import cmd_manifest
from lotuspod.features.publish.publish_sources import (NO_REFS, REFS_MEMBER, decoded,
                                                       media_cap, prepare_publish,
                                                       read_source_archive, resolve_images,
                                                       source_archive, stored_image)
from lotuspod.features.publish.render import (REFS_MAX, REFS_SUFFIX, check_owner, cmd_render,
                                              page_owner, page_variant)
from lotuspod.features import widgets
from lotuspod.store import db


# A label once lower-cased: a letter or digit, then letters, digits and '-'.
_LABEL_RE = re.compile(r"[a-z0-9][a-z0-9-]*")
LABEL_MAX = 40


PUBLISH_FORMATS = ("markdown", "html")
_FORMAT_BY_SUFFIX = {".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html"}


# No dot, so a page name can never end in .body and pass for a source.
_PAGE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")
PUBLISH_VARIANT = "report"


def publish_target(args: argparse.Namespace) -> tuple[str, str, str]:
    """(label, format, page name) of the source, or a refusal."""
    if args.source == "-":
        if not args.format or not args.name:
            raise RuntimeError("publishing standard input needs --format and --name")
        label = "standard input"
        fmt = args.format
    else:
        label = args.source
        fmt = args.format or _FORMAT_BY_SUFFIX.get(Path(args.source).suffix.lower(), "")
        if not fmt:
            raise RuntimeError(
                f"cannot tell the format of {label}: name it .md or .html, or pass --format"
            )
    name = args.name or Path(args.source).name.split(".", 1)[0]
    if not _PAGE_NAME.fullmatch(name) or f"{name}.html" == INDEX_FILE:
        raise RuntimeError(
            f"not a usable page name: {name!r} (letters, digits, '-' and '_'; pass --name)"
        )
    if args.date:
        try:
            _dt.date.fromisoformat(args.date)
        except ValueError:
            raise RuntimeError(f"not an ISO date: {args.date!r}") from None
    return label, fmt, name


def publish_labels(args: argparse.Namespace) -> list[str] | None:
    """The labels --label names, lower-cased, each once in the order given;
    [] for --no-labels and None when neither is given. RuntimeError names
    the first label that is not one."""
    if args.no_labels:
        return []
    if args.labels is None:
        return None
    labels: list[str] = []
    for value in args.labels:
        label = value.lower()
        if not _LABEL_RE.fullmatch(label) or len(label) > LABEL_MAX:
            raise RuntimeError(
                f"--label {value!r} is not a label: 1 to {LABEL_MAX} letters, digits "
                "and hyphens, starting with a letter or digit; nothing written"
            )
        if label not in labels:
            labels.append(label)
    return labels


def read_source(args: argparse.Namespace, label: str) -> bytes:
    if args.source == "-":
        return sys.stdin.buffer.read()
    try:
        return Path(args.source).read_bytes()
    except FileNotFoundError:
        raise FileNotFoundError(f"source not found: {label}") from None
    except OSError as exc:
        raise RuntimeError(f"cannot read {label}: {exc.strerror}") from None


def read_refs_file(path: str) -> tuple[bytes, dict[str, dict]]:
    """A refs file's bytes as read and its checked entries; RuntimeError
    when it cannot be read or breaks a rule (lotuspod.features.blocks.refs)."""
    try:
        with open(path, "rb") as fh:
            data = fh.read(REFS_MAX + 1)
    except FileNotFoundError:
        raise RuntimeError(f"refs file not found: {path}; nothing written") from None
    except OSError as exc:
        raise RuntimeError(f"cannot read refs file {path}: {exc.strerror}; "
                           "nothing written") from None
    if len(data) > REFS_MAX:
        raise RuntimeError(f"refs file {path}: over {REFS_MAX} bytes; nothing written")
    return data, blocks.parse_refs(data, path)


def kept_refs(out_dir: Path, name: str) -> tuple[dict[str, dict], str]:
    """The entries NAME's cards were drawn from and when they were taken,
    from NAME.refs.json beside it; ({}, "") when there is none."""
    path = out_dir / f"{name}{REFS_SUFFIX}"
    if not path.is_file():
        return {}, ""
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise RuntimeError(f"cannot read the kept refs {path}: {exc}") from None
    return refs_from(data, str(path))


def refs_from(data: bytes, where: str) -> tuple[dict[str, dict], str]:
    """The entries and when they were taken from a kept refs file's bytes;
    RuntimeError, naming where, when they cannot be read."""
    try:
        kept = json.loads(data.decode("utf-8"))
        as_of = kept["asOf"]
        entries = blocks.check_refs({"refs": kept["refs"]})
        if not isinstance(as_of, str):
            raise TypeError("asOf is not text")
    except (UnicodeDecodeError, ValueError, KeyError, TypeError, RuntimeError) as exc:
        raise RuntimeError(f"cannot read the kept refs {where}: {exc}") from None
    return entries, as_of


def remote_publish_command(command: str, out_dir: str, fmt: str, name: str,
                           args: argparse.Namespace, archive: bool = False) -> str:
    """The command line ssh hands the writer host's shell.

    ssh joins its arguments into one string for the far shell, so every
    argument after COMMAND is quoted; COMMAND is the config owner's own
    shell text and is used as written. Each value rides as --option=value,
    so one beginning with '-' is never taken for an option on the far side.
    archive adds --source-archive: standard input is a source archive.
    """
    argv = ["publish", "--local", "-", f"--out-dir={out_dir}", f"--format={fmt}",
            f"--name={name}"]
    for option, value in (
        ("--title", args.title),
        ("--summary", args.summary),
        ("--variant", args.variant),
        ("--date", args.date or None),
        ("--expect-revision", args.expect_revision),
        # The credential and the database are the writer host's.
        ("--owner", args.owner or None),
        ("--credential", args.credential or None),
        ("--db", args.db or None),
    ):
        if value is not None:
            argv.append(f"{option}={value}")
    labels = publish_labels(args)
    if labels == []:
        argv.append("--no-labels")
    for label in labels or ():
        argv.append(f"--label={label}")
    if not args.comments:
        argv.append("--no-comments")
    # --refs travels in the archive, as refs.json.
    if getattr(args, "no_refs", False):
        argv.append("--no-refs")
    if archive:
        argv.append("--source-archive")
    return " ".join([command, *(shlex.quote(arg) for arg in argv)])


def publish_over_ssh(args: argparse.Namespace, config: dict[str, str]) -> int:
    """Run publish on the config's host with the source on standard input.

    The images the source names are read and checked here, and its local
    references rewritten to their media URLs; when there is at least one,
    standard input is a source archive of the rewritten source and the
    images, else the source's bytes as read. A refs file (--refs) is read
    and checked here too, and goes in the archive as refs.json, so a page
    with one is sent as an archive even with no image. The far side's
    output passes through and its exit status is returned as it is, so a
    revision conflict still exits 3.
    """
    host = config["host"]
    out_dir = config.get("out_dir", "")
    if not out_dir:
        raise ConfigError(f"config {config_path()} sets host but no out_dir in [publish]")
    if args.out_dir:
        raise ConfigError(
            f"--out-dir names a directory on this machine, but config {config_path()} "
            "publishes on its host; pass --local to publish here"
        )
    if args.source_archive:
        raise RuntimeError("--source-archive is what the writer host reads; pass --local")
    label, fmt, name = publish_target(args)
    publish_labels(args)
    refs_data = read_refs_file(args.refs)[0] if args.refs else None
    data = read_source(args, label)
    fmt, raw, images = prepare_publish(args, fmt, name, decoded(data, label), label)
    data = raw.encode("utf-8")
    archive = bool(images) or refs_data is not None
    if archive:
        data = source_archive(raw.encode("utf-8"), images, refs_data)
    command = config.get("command") or DEFAULT_REMOTE_COMMAND
    remote = remote_publish_command(command, out_dir, fmt, name, args, archive=archive)
    try:
        done = subprocess.run(["ssh", host, remote], input=data)
    except OSError as exc:
        raise RuntimeError(f"cannot run ssh: {exc.strerror}") from None
    return done.returncode


def reopened(out_dir: Path, args: argparse.Namespace, name: str, previous: str,
             published: str) -> list[str]:
    """A line for each question whose stored answer showed as its answer on
    the page before (decisions.holds) and no longer does on the page as
    published, which still asks it; none without serve's database or a page
    before."""
    if not previous:
        return []
    try:
        path = serve.serve_db_path(out_dir, getattr(args, "db", ""))
        if not path.is_file():
            return []
        questions = db.Database(path).answers(name, asked=True)
    except (ValueError, sqlite3.Error, OSError):
        return []
    before, after = decisions.read_forms(previous), decisions.read_forms(published)
    lines = []
    for question, old in before.items():
        entry, new = questions.get(question), after.get(question)
        if entry is None or new is None:
            continue
        answer = entry["current"]
        if not decisions.holds(old, answer) or decisions.holds(new, answer):
            continue
        asked = answer.get("asked") or {}
        text = asked.get("text") or old.text
        label = asked.get("label") or old.label(answer.get("choice", ""))
        lines.append(f'publish: {name}: {question} was answered "{text}" ({label}); '
                     f'this publish asks "{new.text}" there, so its card opens again')
    return lines


def cmd_publish(args: argparse.Namespace) -> int:
    """Render a page from its source, keep the source, rebuild the manifest
    and the index, and commit and push once.

    When the config names a host and --local is not given, publish runs
    there over ssh instead (see publish_over_ssh).

    Publish has two sides, run here in one process or split by ssh: the
    sending side (send_images) reads each image the source names from
    beside it, checks it and rewrites its reference to its media URL; the
    writing side (resolve_images) finds every media URL's image among those
    sent or in the store. Under the lock each sent image is stored in the
    media directory, and the rewritten source is kept, so a republish of
    the kept source needs no local files. With --source-archive, standard
    input is a source archive (see read_source_archive) whose images are
    checked again here.

    Everything that can be refused is refused before anything is written.
    From the revision check to the commit the directory's publish lock is
    held, so two publishes of one page cannot both pass the check.
    """
    if not args.local:
        try:
            config = publish_config()
            if config.get("host"):
                return publish_over_ssh(args, config)
        except ConfigError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_CONFIG

    out_dir = (Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR).resolve()
    label, fmt, name = publish_target(args)
    labels = publish_labels(args)
    if args.owner:
        check_owner(args, out_dir)
    if args.source_archive and args.source != "-":
        raise RuntimeError("--source-archive reads standard input: pass - as SOURCE")
    refs_path = getattr(args, "refs", None)
    if args.source_archive and refs_path:
        raise RuntimeError(f"--source-archive takes the refs from its {REFS_MEMBER} member, "
                           "not --refs; nothing written")
    # The refs this publish was given; None keeps the page's own.
    given_refs = read_refs_file(refs_path)[1] if refs_path else None
    store_dir = media.media_dir(out_dir)
    try:
        sent: dict[str, media.Image] = {}
        if args.source_archive:
            data, sent, archived_refs = read_source_archive(sys.stdin.buffer, media_cap())
            if archived_refs is not NO_REFS:
                given_refs = blocks.check_refs(archived_refs)
        else:
            data = read_source(args, label)
        fmt, raw, found = prepare_publish(args, fmt, name, decoded(data, label), label,
                                          partial(stored_image, store_dir=store_dir, sent=sent))
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    raw, images = resolve_images(fmt, raw, label, store_dir, {**sent, **found})
    # The kept source names each image by its media URL, as the page does.
    data = raw.encode("utf-8")
    text = normalized(raw)
    if fmt == "markdown":
        sizes = {image.url: (image.width, image.height) for image in images.values()}
        title, body = markdown_title(text), markdown.to_body(text, sizes)
    else:
        title, body = html_title(text)
    if args.title is not None:
        title = args.title.strip()
    if not title:
        raise RuntimeError(
            f"{label} has no title: give it a first '# ' line or h1, or pass --title"
        )
    widgets.render(body, name)  # validate before creating or writing the site
    revision = source_revision(data)

    out_dir.mkdir(parents=True, exist_ok=True)
    with publish_lock(out_dir):
        current = page_revision(out_dir, name)
        # A page with no revision whose source migrate kept is edited from
        # that source, which an agent's pull names by its own revision.
        extracted = out_dir / f"{name}{BODY_SOURCE_SUFFIX}"
        accepted = {current} | ({source_revision(extracted.read_bytes())}
                                if current == "" and extracted.is_file() else set())
        if args.expect_revision is not None and args.expect_revision not in accepted:
            print(
                f"error: revision conflict: {name} is at revision {current or 'unknown'}, "
                f"not {args.expect_revision}; nothing published",
                file=sys.stderr,
            )
            return EXIT_REVISION_CONFLICT

        # A republish keeps the page's cards and when their refs were taken,
        # as it keeps its labels; --no-refs drops them.
        updated = core._utc_stamp(_dt.datetime.now(_dt.timezone.utc))
        if getattr(args, "no_refs", False):
            page_refs, refs_as_of = {}, ""
        elif given_refs is not None:
            page_refs, refs_as_of = given_refs, updated
        else:
            page_refs, refs_as_of = kept_refs(out_dir, name)

        for image in images.values():
            media.store(store_dir, image)

        # A republish keeps what the page already says unless told otherwise.
        page = out_dir / f"{name}.html"
        previous = page.read_text(encoding="utf-8") if page.exists() else ""
        kept = extract_meta(previous, name) if previous else {}
        summary = args.summary if args.summary is not None else kept.get("summary", "")
        labels = labels if labels is not None else kept.get("labels", [])
        variant = args.variant or (page_variant(previous) if previous else PUBLISH_VARIANT)
        owner = args.owner or page_owner(previous)
        cmd_render(
            argparse.Namespace(
                name=name,
                title=html.escape(title, quote=False),
                episode="",
                # Created on the UTC day of its first publish, as updated is.
                date=args.date or kept.get("date") or updated[:10],
                updated=updated,
                summary=html.escape(summary, quote=False),
                labels=labels,
                body=body,
                hidden=False,
                no_outline=False,
                comments=args.comments,
                # Checked above, or kept from the page when it is a handle.
                owner=owner if agents.is_handle(owner) else "",
                owner_checked=True,
                variant=variant,
                out_dir=str(out_dir),
                revision=revision,
                refs=page_refs,
                refs_as_of=refs_as_of,
                commit=False,
            )
        )
        for kind, suffix in _KEPT_SOURCE_SUFFIX.items():
            if kind == fmt:
                write_atomic(out_dir / f"{name}{suffix}", data)
            else:
                # A page republished from the other kind keeps one source.
                (out_dir / f"{name}{suffix}").unlink(missing_ok=True)
        steps = argparse.Namespace(out_dir=str(out_dir), commit=False)
        cmd_manifest(steps)
        index.cmd_index(steps)
        commit_output(out_dir, f"publish {name}")
        published = page.read_text(encoding="utf-8")
    for line in reopened(out_dir, args, name, previous, published):
        print(line, file=sys.stderr)
    print(f"published {name} at revision {revision}")
    return 0
