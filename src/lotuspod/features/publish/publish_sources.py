"""publish's sources: the images and live files a source names, read from
beside it, and the source archive publish sends over ssh."""

from __future__ import annotations

import argparse
import html
import io
import json
import re
import shlex
import tarfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable

from lotuspod.features.publish import artifact, markdown, media
from lotuspod.core import ConfigError, config_path, config_section, normalized, without_templates
from lotuspod.features.publish.render import REFS_MAX


def decoded(data: bytes, label: str) -> str:
    """A source's bytes as text; RuntimeError when they are not UTF-8."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise RuntimeError(f"{label} is not UTF-8") from None


def source_base(args: argparse.Namespace) -> Path | None:
    """The directory a source's local image references resolve against:
    --base, else the source file's directory; None for standard input."""
    if args.base:
        return Path(args.base)
    return None if args.source == "-" else Path(args.source).parent


# A source archive: an uncompressed POSIX tar of the member `source`, the
# member `refs.json` when publish was given a refs file, and one member
# `media/NAME` per image, NAME being its stored name.
SOURCE_MEMBER = "source"
REFS_MEMBER = "refs.json"
MEDIA_MEMBER = "media/"


def source_archive(data: bytes, images: dict[str, media.Image],
                   refs_data: bytes | None = None) -> bytes:
    """The source archive of source bytes data, images and a refs file's
    bytes (none when refs_data is None)."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        members = [(SOURCE_MEMBER, data)]
        if refs_data is not None:
            members.append((REFS_MEMBER, refs_data))
        members += [(MEDIA_MEMBER + name, image.data) for name, image in images.items()]
        for member, content in members:
            info = tarfile.TarInfo(member)
            info.size = len(content)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(content))
    return out.getvalue()


class _KeptTail:
    """A stream that keeps what is read from it from floor on, so the bytes a
    tarfile reads past its last member can be looked at again."""

    def __init__(self, stream) -> None:
        self._stream = stream
        self._kept = bytearray()
        self._start = 0  # where in the stream _kept begins
        self.floor = 0

    def read(self, size: int = -1) -> bytes:
        data = self._stream.read(size)
        self._kept += data
        cut = min(self.floor, self._start + len(self._kept)) - self._start
        if cut > 0:
            del self._kept[:cut]
            self._start += cut
        return data

    def kept(self, position: int, size: int) -> bytes:
        """The size bytes at position already read and kept, reading no more."""
        return bytes(self._kept[position - self._start:position + size - self._start])

    def at(self, position: int, size: int) -> bytes:
        """The size bytes at position (fewer where the stream ends first)."""
        while self._start + len(self._kept) < position + size:
            more = self._stream.read(position + size - self._start - len(self._kept))
            if not more:
                break
            self._kept += more
        return bytes(self._kept[position - self._start:position + size - self._start])


_END_OF_ARCHIVE = bytes(2 * tarfile.BLOCKSIZE)
# What read_source_archive returns for the refs of an archive with no
# refs.json: never JSON, so a member holding null is still checked.
NO_REFS = object()


def read_source_archive(stream, cap: int) -> tuple[bytes, dict[str, media.Image], object]:
    """The source, the images and the refs of the source archive on stream,
    each image checked again within cap and the refs parsed as JSON (NO_REFS
    when it has no refs.json); RuntimeError naming the first refused member.

    The archive is read as a stream and nothing is extracted by its member
    names: only regular files named `source` (once), `refs.json` (once) or
    `media/` and a stored name are taken, and an image's or the refs' size
    is checked before its bytes are read.
    A stream tarfile stops reading at a header cut short or malformed, as
    at the end, so the archive must end with its end-of-archive marker
    where tarfile stopped. It also takes PAX and GNU extension headers in
    before the member they rename or resize, which a source archive never
    has, so each member's header must start where the one before it ends.
    """
    source: bytes | None = None
    images: dict[str, media.Image] = {}
    found_refs: object = NO_REFS
    seen: set[str] = set()
    member: tarfile.TarInfo | None = None
    tail = _KeptTail(stream)
    header = 0  # where the next member's header should start

    def refused(reason: object) -> RuntimeError:
        return RuntimeError(f"archive member {member.name}: {reason}; nothing published")

    try:
        with tarfile.open(fileobj=tail, mode="r|") as archive:
            for member in archive:
                if member.offset_data != header + tarfile.BLOCKSIZE:
                    hidden = tail.kept(header, tarfile.BLOCKSIZE)
                    name = hidden[:100].split(b"\0", 1)[0].decode("utf-8", "replace")
                    flag = hidden[156:157].decode("ascii", "replace")
                    raise RuntimeError(
                        f"archive member {name}: an extension header (type {flag!r}), which "
                        "a source archive never has; nothing published"
                    )
                header = tail.floor = archive.offset  # where the next header starts
                name = member.name
                if name in seen:
                    raise refused("named twice")
                seen.add(name)
                stored = name[len(MEDIA_MEMBER):] if name.startswith(MEDIA_MEMBER) else ""
                if name not in (SOURCE_MEMBER, REFS_MEMBER) \
                        and not media.STORED_NAME.fullmatch(stored):
                    raise refused(f"neither {SOURCE_MEMBER}, {REFS_MEMBER} nor {MEDIA_MEMBER} "
                                  "and a stored image name")
                if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE):
                    raise refused("not a regular file")
                if name == SOURCE_MEMBER:
                    source = archive.extractfile(member).read()
                    continue
                if name == REFS_MEMBER:
                    if member.size > REFS_MAX:
                        raise refused(f"over {REFS_MAX} bytes")
                    try:
                        found_refs = json.loads(archive.extractfile(member).read()
                                                .decode("utf-8"))
                    except (UnicodeDecodeError, ValueError) as exc:
                        raise refused(f"not JSON ({exc})") from None
                    continue
                try:
                    media.check_size(member.size, cap)
                    image = media.check(archive.extractfile(member).read(), stored, cap)
                except media.MediaError as exc:
                    raise refused(exc) from None
                if image.name != stored:
                    raise refused("the SHA-256 of its bytes is not its name")
                images[stored] = image
            end = archive.offset
    except tarfile.TarError as exc:
        where = f"archive member {member.name}" if member else "the source archive"
        raise RuntimeError(f"{where}: cut short or malformed ({exc}); nothing published") \
            from None
    if tail.at(end, len(_END_OF_ARCHIVE)) != _END_OF_ARCHIVE:
        where = f"after archive member {member.name}" if member else "at its start"
        raise RuntimeError(f"the source archive is cut short or malformed {where}: no "
                           "end-of-archive marker follows; nothing published")
    if source is None:
        raise RuntimeError(f"the source archive has no {SOURCE_MEMBER} member; "
                           "nothing published")
    return source, images, found_refs


# A reference with a scheme (https:, data:) or a host (//host) is remote or
# inline: the page policy's img-src 'self' would block it in the browser.
_REMOTE_IMAGE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:|//")


def local_image(src: str, base: Path | None, cap: Callable[[], int]) -> media.Image | None:
    """The image a local reference names, a file inside base; None for a
    media URL, which the writing side looks up. MediaError says why it is
    refused."""
    if _REMOTE_IMAGE.match(src):
        raise media.MediaError(
            "remote and inline images are not published, only files beside the source"
        )
    if src.startswith(media.URL_PREFIX):
        return None
    if base is None:
        raise media.MediaError(
            "a file needs --base DIR to be found from a source on standard input"
        )
    root = base.resolve()
    path = (root / src).resolve()  # follows symbolic links
    if src.startswith("/") or root not in path.parents:
        raise media.MediaError("outside the source's directory")
    if not path.exists():
        raise media.MediaError("no such file")
    if not path.is_file():
        raise media.MediaError("not a regular file")
    media.check_size(path.stat().st_size, cap())
    return media.check(path.read_bytes(), src, cap())


@dataclass(frozen=True, eq=False)
class _Img:
    """An img element of an HTML source: its start tag's span and text, and
    the first value of each of its attributes."""

    start: int
    end: int
    tag: str
    attrs: dict

    @property
    def src(self) -> str:
        return self.attrs["src"]


class _ImgCollector(HTMLParser):
    """Locate the body's img elements that have a src (see _H2Collector),
    and the first srcset on an img or source element."""

    def __init__(self, body: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_starts = [0]
        for index, char in enumerate(body):
            if char == "\n":
                self._line_starts.append(index + 1)
        self.images: list[_Img] = []
        self.srcset: tuple[str, str] | None = None

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list) -> None:
        first: dict[str, str | None] = {}
        for key, value in attrs:
            first.setdefault(key, value)
        if tag in ("img", "source") and "srcset" in first and self.srcset is None:
            self.srcset = tag, first["srcset"] or ""
        if tag == "img" and first.get("src") is not None:
            start = self._offset()
            source = self.get_starttag_text() or ""
            self.images.append(_Img(start, start + len(source), source, first))


def html_images(body: str) -> _ImgCollector:
    parser = _ImgCollector(body)
    parser.feed(without_templates(body))
    parser.close()
    return parser


_TAG_NAME = re.compile(r"<[a-zA-Z][^\t\n\r\f />\x00]*")
_TAG_ATTR = re.compile(
    r"""[\s/]*(?P<name>[^\s/>][^\s/=>]*)(?:\s*=+\s*(?P<value>'[^']*'|"[^"]*"|(?!['"])[^>\s]*))?"""
)


def img_tag(img: _Img, src: str | None = None, extra: str = "") -> str:
    """img's start tag as written, with its src value replaced by src (when
    given) and extra attributes spliced in just after it."""
    at = _TAG_NAME.match(img.tag).end()
    while True:
        attr = _TAG_ATTR.match(img.tag, at)
        if attr is None or attr.end() == at:
            raise media.MediaError("its src attribute cannot be found in the tag as written")
        if attr.group("name").lower() == "src":
            break
        at = attr.end()
    value = attr.group("value") or ""
    if value[:1] in ("'", '"'):
        value = value[1:-1]
    if html.unescape(value) != img.src:
        raise media.MediaError("its src attribute cannot be found in the tag as written")
    start, end = attr.span("value")
    written = img.tag[start:end] if src is None else f'"{html.escape(src)}"'
    return img.tag[:start] + written + extra + img.tag[end:]


def _spliced(body: str, tags: list[tuple[_Img, str]]) -> str:
    """body with each img's start tag replaced by its new one."""
    pieces: list[str] = []
    cursor = 0
    for img, tag in tags:
        pieces += [body[cursor:img.start], tag]
        cursor = img.end
    pieces.append(body[cursor:])
    return "".join(pieces)


def stored_image(src: str, store_dir: Path, sent: dict[str, media.Image]) -> media.Image:
    """The image media URL src names, from sent or else the store;
    MediaError when it names neither."""
    name = src[len(media.URL_PREFIX):] if src.startswith(media.URL_PREFIX) else ""
    image = sent.get(name) or media.load_stored(store_dir, name)
    if image is None:
        raise media.MediaError(f"names no image stored in {store_dir}")
    return image


class _DocumentTitle(HTMLParser):
    def __init__(self, source: str):
        super().__init__()
        self.active = False
        self.done = False
        self.foreign = 0
        self.templates = 0
        self.title = ''
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        if tag == 'template':
            self.templates += 1
        if tag in {'svg', 'math'}:
            self.foreign += 1
        if tag == 'title' and not self.foreign and not self.templates and not self.done:
            self.active = True

    def handle_endtag(self, tag):
        if tag == 'template':
            self.templates = max(0, self.templates - 1)
        if tag in {'svg', 'math'}:
            self.foreign = max(0, self.foreign - 1)
        if tag == 'title' and self.active:
            self.active = False
            self.done = True

    def handle_data(self, data):
        if self.active:
            self.title += data


def live_file(path: str, base: Path | None, line: int) -> str:
    """Read one bounded, contained UTF-8 file safe to put inside a fence."""
    try:
        if base is None:
            raise ValueError('a file needs --base DIR from standard input')
        root = base.resolve()
        target = (root / path).resolve()
        if path.startswith('/') or root not in target.parents:
            raise ValueError("outside the source's directory")
        if not target.exists():
            raise ValueError('no such file')
        if not target.is_file():
            raise ValueError('not a regular file')
        with target.open('rb') as stream:
            data = stream.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('source exceeds 2 MB')
        try:
            source = data.decode('utf-8')
        except UnicodeDecodeError:
            raise ValueError('not UTF-8') from None
        if any(row.startswith('```') for row in normalized(source).split('\n')):
            raise ValueError('contains a line starting with three backticks')
        return source
    except (OSError, ValueError) as exc:
        raise RuntimeError(f'live block at line {line}, file {path}: {exc}; nothing written') from None


def send_live_files(raw: str, base: Path | None) -> str:
    """Inline file fences before transport, retaining other fences verbatim."""
    # Preserve original line endings outside rewritten blocks.
    lines = re.findall(r'[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$', raw)
    replacements = {}

    def scan(rows: list[str], offset: int = 0) -> None:
        i = 0
        while i < len(rows):
            row = rows[i]
            # Match _convert: quote runs recurse only outside fences.
            # Quote markers inside a fence are literal code.
            if re.match(r'^ {0,3}>', row):
                start = i
                inner = []
                while i < len(rows) and re.match(r'^ {0,3}>', rows[i]):
                    inner.append(re.sub(r'^ {0,3}> ?', '', rows[i]))
                    i += 1
                scan(inner, offset + start)
                continue
            if not row.startswith('```'):
                i += 1
                continue
            start = i
            i += 1
            while i < len(rows) and not rows[i].startswith('```'):
                i += 1
            i = min(i + 1, len(rows))
            if row[3:].split()[:2] == ['html', 'live']:
                rewrite(row, offset + start, offset + i)

    def rewrite(fence: str, start: int, end: int) -> None:
        prefix = lines[start][:len(lines[start]) - len(fence)]
        try:
            lexer = shlex.shlex(fence[3:], posix=True)
            lexer.whitespace += ''.join(char for char in set(fence) if char.isspace())
            lexer.whitespace_split = True
            lexer.commenters = ''
            words = list(lexer)
        except ValueError as exc:
            raise RuntimeError(f'live block at line {start + 1}: {exc}; nothing written') from None
        paths = [word[5:] for word in words[2:] if word.startswith('file=')]
        if not paths:
            return
        if len(paths) != 1:
            raise RuntimeError(f'live block at line {start + 1}, file {paths}: duplicate file option; nothing written')
        source = live_file(paths[0], base, start + 1)
        info = shlex.join([word for word in words if not word.startswith('file=')])
        block = [prefix + '```' + info + '\n']
        block.extend(prefix + line + '\n' for line in normalized(source).removesuffix('\n').split('\n'))
        block.append(prefix + '```\n')
        replacements[start] = (end, ''.join(block))

    scan(lines)
    result = []
    i = 0
    while i < len(lines):
        if i in replacements:
            i, block = replacements[i]
            result.append(block)
        else:
            result.append(lines[i])
            i += 1
    return ''.join(result)


def prepare_publish(args: argparse.Namespace, fmt: str, name: str, raw: str,
                    label: str, stored: Callable[[str], media.Image] | None = None,
                    ) -> tuple[str, str, dict[str, media.Image]]:
    """Prepare the same self-contained source for local and SSH publishing."""
    base = source_base(args)
    artifact_given = getattr(args, 'artifact', False)
    live = getattr(args, 'live', False) or artifact_given
    if getattr(args, 'notes', None) and not live:
        raise RuntimeError('--notes requires --live; nothing written')
    if live:
        flag = '--artifact' if artifact_given else '--live'
        if fmt != 'html' or args.source == '-':
            raise RuntimeError(f'{flag} requires an HTML file; nothing written')
        filename = Path(args.source).name
        source_base_dir = Path(args.source).parent
        source = live_file(filename, source_base_dir, 3)
        document_title = ' '.join(_DocumentTitle(source).title.split()) or name
        title = ' '.join((args.title if args.title is not None else document_title).split())
        if artifact_given:
            # The block holds the adapted document, so the kept source and
            # the writer host never fetch.
            document = normalized(artifact.adapt(source)).removesuffix('\n')
            info = shlex.join(['html', 'live', 'height=full', 'title=' + title])
            raw = '# ' + title + '\n\n```' + info + '\n' + document + '\n```\n'
        else:
            raw = '# ' + title + '\n\n```html live file=' + shlex.quote(filename) + ' height=full title=' + shlex.quote(title) + '\n```\n'
            raw = send_live_files(raw, source_base_dir)
        images = {}
        if args.notes:
            notes = Path(args.notes)
            try:
                text = decoded(notes.read_bytes(), str(notes))
            except OSError as exc:
                raise RuntimeError(f'--notes {notes}: {exc}; nothing written') from None
            text = send_live_files(text, notes.parent)
            text, images = send_images('markdown', text, str(notes), notes.parent, media_cap, stored)
            raw += '\n' + text
        return 'markdown', raw, images
    if fmt == 'markdown':
        raw = send_live_files(raw, base)
    raw, images = send_images(fmt, raw, label, base, media_cap, stored)
    return fmt, raw, images


def send_images(fmt: str, raw: str, label: str, base: Path | None,
                cap: Callable[[], int], stored: Callable[[str], media.Image] | None = None,
                ) -> tuple[str, dict[str, media.Image]]:
    """The sending side of publish: raw, the source, with each local image
    reference rewritten to its media URL, and the images those name by
    stored name, each read from inside base and checked; RuntimeError naming
    the first refused reference. Media URLs are left to the writing side,
    unless stored, the writing side's lookup, is given to check them in turn."""
    if fmt == "markdown":
        refs: list = markdown.images(normalized(raw))
    else:
        found = html_images(raw)
        if found.srcset is not None:
            tag, srcset = found.srcset
            raise RuntimeError(
                f"srcset {srcset} on a {tag} element in {label}: srcset names images "
                "publish never sees; give an img one src; nothing published"
            )
        refs = found.images
    images: dict[str, media.Image] = {}
    moved: list = []
    for ref in refs:
        try:
            image = local_image(ref.src, base, cap)
            if image is None and stored is not None:
                stored(ref.src)
            elif image is not None:
                moved.append((ref, image.url if fmt == "markdown" else img_tag(ref, image.url)))
                images[image.name] = image
        except (media.MediaError, OSError) as exc:
            reason = exc.strerror if isinstance(exc, OSError) and exc.strerror else exc
            raise RuntimeError(f"image {ref.src} in {label}: {reason}; nothing published") \
                from None
    if moved:
        raw = markdown.with_sources(raw, dict(moved)) if fmt == "markdown" else \
            _spliced(raw, moved)
    return raw, images


def resolve_images(fmt: str, raw: str, label: str, store_dir: Path,
                   sent: dict[str, media.Image]) -> tuple[str, dict[str, media.Image]]:
    """The writing side of publish: every image raw refers to, by stored
    name, from sent or else the store, and raw with each HTML img given
    loading="lazy" and its intrinsic width and height where it has none of
    its own. RuntimeError names a reference to no such image, or an image
    in sent that raw does not refer to."""
    if fmt == "markdown":
        refs: list = markdown.images(normalized(raw))
    else:
        refs = html_images(raw).images
    resolved = []
    for ref in refs:
        try:
            resolved.append((ref, stored_image(ref.src, store_dir, sent)))
        except media.MediaError as exc:
            raise RuntimeError(f"image {ref.src} in {label}: {exc}; nothing published") \
                from None
    images = {image.name: image for _, image in resolved}
    for name in sent:
        if name not in images:
            raise RuntimeError(f"archive member {MEDIA_MEMBER}{name}: {label} does not "
                               "refer to it; nothing published")
    if fmt == "html":
        filled = []
        for img, image in resolved:
            extra = ""
            if "loading" not in img.attrs:
                extra += ' loading="lazy"'
            if "width" not in img.attrs and "height" not in img.attrs:
                extra += f' width="{image.width}" height="{image.height}"'
            if extra:
                try:
                    filled.append((img, img_tag(img, extra=extra)))
                except media.MediaError as exc:
                    raise RuntimeError(f"image {img.src} in {label}: {exc}; "
                                       "nothing published") from None
        raw = _spliced(raw, filled)
    return raw, images


def media_cap() -> int:
    """The config's [media] max_image_bytes, else the default."""
    try:
        return media.max_bytes(config_section("media"))
    except ValueError as exc:
        raise ConfigError(f"config {config_path()}: {exc}") from None
