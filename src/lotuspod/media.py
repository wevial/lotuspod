"""The images a markdown page shows: which files are accepted, how big they
are drawn, and where they are kept.

A file is accepted only when its first bytes are a PNG, JPEG, WebP or GIF
signature, its extension names that same type, and its structure runs whole
to its end (PNG chunks to IEND, JPEG segments to the end-of-image marker, the
WebP RIFF chunk, GIF blocks to the trailer), so a file cut short is refused
rather than stored; and only within the size cap (the config's `[media]
max_image_bytes`). SVG, which can carry script, is never accepted. The
intrinsic width and height come from the file's header, so a page reserves
each image's box before its bytes arrive; a JPEG whose EXIF orientation turns
it a quarter has the two swapped, as browsers draw it.

Each image is stored as the lower-case hex SHA-256 of its bytes plus its
type's extension, in `lotuspod-media/` beside the artifacts directory - never
inside it, since publish commits that directory whole - and is reached at
`/media/NAME`. A name never changes its bytes, so storing one image twice is
one file and serve lets the browser keep it for a year.
"""

from __future__ import annotations

import hashlib
import re
import zlib
from dataclasses import dataclass
from pathlib import Path

MEDIA_DIR_NAME = "lotuspod-media"
URL_PREFIX = "/media/"
DEFAULT_MAX_BYTES = 10 * 1024 * 1024

# The extension a stored image takes, and the Content-Type serve answers it
# with, by type. A fixed map: mimetypes does not know .webp on every Python.
EXTENSIONS = {"png": "png", "jpeg": "jpg", "webp": "webp", "gif": "gif"}
CONTENT_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp",
                 "gif": "image/gif"}
# The type each accepted file-name extension names.
_TYPE_BY_SUFFIX = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp",
                   ".gif": "gif"}
_LABELS = {"png": "PNG", "jpeg": "JPEG", "webp": "WebP", "gif": "GIF"}
STORED_NAME = re.compile(r"[0-9a-f]{64}\.(png|jpg|webp|gif)")

_PNG = b"\x89PNG\r\n\x1a\n"
# JPEG start-of-frame markers: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
_SOF = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
# Markers that stand alone, with no length after them.
_STANDALONE = frozenset({0x01, *range(0xD0, 0xD9)})
_ORIENTATION_TAG = 0x0112


class MediaError(ValueError):
    """A file refused as an image; the message says why."""


@dataclass(frozen=True)
class Image:
    kind: str  # "png", "jpeg", "webp" or "gif"
    width: int
    height: int
    data: bytes

    @property
    def name(self) -> str:
        """The name it is stored under."""
        return f"{hashlib.sha256(self.data).hexdigest()}.{EXTENSIONS[self.kind]}"

    @property
    def url(self) -> str:
        return URL_PREFIX + self.name


def media_dir(out_dir: Path) -> Path:
    """The media directory: lotuspod-media beside the artifacts directory."""
    return Path(out_dir).resolve().parent / MEDIA_DIR_NAME


def max_bytes(section: dict[str, str] | None) -> int:
    """The size cap the config's [media] section sets; ValueError when its
    max_image_bytes is not a whole number of bytes, 1 or more."""
    value = (section or {}).get("max_image_bytes", "")
    if not value:
        return DEFAULT_MAX_BYTES
    if not value.isdigit() or int(value) < 1:
        raise ValueError(f"[media] max_image_bytes {value!r} is not a whole number of "
                         "bytes, 1 or more")
    return int(value)


def sniff(data: bytes) -> str | None:
    """The type data's signature names; None when it is none of the four."""
    if data.startswith(_PNG):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return None


def named_type(filename: str) -> str | None:
    """The type filename's extension names, as check reads it; None for
    any other extension."""
    return _TYPE_BY_SUFFIX.get(Path(filename).suffix.lower())


def check(data: bytes, filename: str, cap: int | None = DEFAULT_MAX_BYTES) -> Image:
    """data as an image named filename, or MediaError saying why it is not one.

    cap None takes any size (an image already in the store).
    """
    suffix = Path(filename).suffix.lower()
    if suffix == ".svg":
        raise MediaError("SVG images are not published, only PNG, JPEG, WebP and GIF")
    named = named_type(filename)
    if named is None:
        raise MediaError("not a .png, .jpg, .jpeg, .webp or .gif file name")
    if cap is not None:
        check_size(len(data), cap)
    kind = sniff(data)
    if kind is None:
        raise MediaError("not a PNG, JPEG, WebP or GIF image")
    if kind != named:
        raise MediaError(f"a {_LABELS[kind]} image named {suffix}")
    try:
        width, height = _size(kind, data)
    except IndexError:
        raise MediaError(f"a {_LABELS[kind]} image cut short or malformed: "
                         "it ends before its structure does") from None
    except ValueError as exc:
        raise MediaError(f"a {_LABELS[kind]} image cut short or malformed: {exc}") from None
    if width < 1 or height < 1:
        raise MediaError(f"a {_LABELS[kind]} image with no width or height")
    return Image(kind, width, height, data)


def check_size(size: int, cap: int) -> None:
    """MediaError when size bytes are over the cap."""
    if size > cap:
        raise MediaError(f"{size} bytes, over the {cap}-byte cap ([media] max_image_bytes)")


def _u16(data: bytes, at: int, order: str = "big") -> int:
    chunk = data[at:at + 2]
    if len(chunk) != 2:
        raise IndexError(at)
    return int.from_bytes(chunk, order)


def _u24(data: bytes, at: int) -> int:
    chunk = data[at:at + 3]
    if len(chunk) != 3:
        raise IndexError(at)
    return int.from_bytes(chunk, "little")


def _u32(data: bytes, at: int, order: str = "big") -> int:
    chunk = data[at:at + 4]
    if len(chunk) != 4:
        raise IndexError(at)
    return int.from_bytes(chunk, order)


def _size(kind: str, data: bytes) -> tuple[int, int]:
    """(width, height) from the header, once the structure has been walked
    to its end; IndexError or ValueError when it does not run whole."""
    if kind == "png":
        return _png_size(data)
    if kind == "gif":
        return _gif_size(data)
    if kind == "webp":
        return _webp_size(data)
    return _jpeg_size(data)


def _png_size(data: bytes) -> tuple[int, int]:
    """IHDR's size; every chunk whole with its CRC, image data, then IEND."""
    at, size, has_data = len(_PNG), None, False
    while True:
        length = _u32(data, at)
        kind = data[at + 4:at + 8]
        end = at + 12 + length
        if end > len(data):
            raise IndexError(end)
        if zlib.crc32(data[at + 4:at + 8 + length]) != _u32(data, at + 8 + length):
            raise ValueError(f"the {kind!r} chunk's CRC does not match")
        if size is None:
            if kind != b"IHDR" or length != 13:
                raise ValueError("no IHDR chunk first")
            size = _u32(data, at + 8), _u32(data, at + 12)
        elif kind == b"IDAT":
            has_data = True
        elif kind == b"IEND":
            if not has_data:
                raise ValueError("no image data")
            return size
        at = end


def _gif_size(data: bytes) -> tuple[int, int]:
    """The screen descriptor's size; every block whole, an image, then the
    trailer."""
    size = _u16(data, 6, "little"), _u16(data, 8, "little")
    at = 13 + _gif_table(data[10])
    images = 0
    while True:
        block = data[at]
        if block == 0x3B:  # the trailer
            if not images:
                raise ValueError("no image")
            return size
        if block == 0x21:  # an extension: its label, then sub-blocks
            at = _gif_sub_blocks(data, at + 2)
        elif block == 0x2C:  # an image: descriptor, colour table, LZW size, data
            at += 10 + _gif_table(data[at + 9])
            data[at]  # the LZW minimum code size
            at = _gif_sub_blocks(data, at + 1)
            images += 1
        else:
            raise ValueError(f"an unknown block 0x{block:02x}")


def _gif_table(flags: int) -> int:
    """The length of the colour table a descriptor's flags announce."""
    return 3 * (2 << (flags & 0x07)) if flags & 0x80 else 0


def _gif_sub_blocks(data: bytes, at: int) -> int:
    """Where the run of sub-blocks starting at at ends."""
    while True:
        length = data[at]
        at += 1 + length
        if length == 0:
            return at


def _webp_size(data: bytes) -> tuple[int, int]:
    """The first chunk's size; the RIFF chunk whole, every chunk inside it
    whole, and image data among them."""
    riff_end = 8 + _u32(data, 4, "little")
    if riff_end > len(data):
        raise IndexError(riff_end)
    at, size, has_data = 12, None, False
    while at < riff_end:
        fourcc = data[at:at + 4]
        length = _u32(data, at + 4, "little")
        body, end = at + 8, at + 8 + length
        if end > riff_end:
            raise IndexError(end)
        if size is None:
            size = _webp_frame_size(fourcc, data[body:end])
        has_data = has_data or fourcc in (b"VP8 ", b"VP8L", b"ANMF")
        at = end + (length & 1)  # a chunk of odd length is padded
    if size is None or not has_data:
        raise ValueError("no image data")
    return size


def _webp_frame_size(fourcc: bytes, chunk: bytes) -> tuple[int, int]:
    if fourcc == b"VP8 ":
        # A key frame: 3 bytes of frame tag, the start code, then 14-bit sizes.
        if chunk[3:6] != b"\x9d\x01\x2a":
            raise ValueError("no VP8 start code")
        return _u16(chunk, 6, "little") & 0x3FFF, _u16(chunk, 8, "little") & 0x3FFF
    if fourcc == b"VP8L":
        if chunk[0:1] != b"\x2f":
            raise ValueError("no VP8L signature")
        bits = _u32(chunk, 1, "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if fourcc == b"VP8X":
        return _u24(chunk, 4) + 1, _u24(chunk, 7) + 1
    raise ValueError("no VP8, VP8L or VP8X chunk first")


def _jpeg_size(data: bytes) -> tuple[int, int]:
    """The start-of-frame's size, turned when an EXIF orientation of 5 to 8
    comes before it; every segment whole up to the first scan, and the
    end-of-image marker after it."""
    at, orientation, size = 2, 1, None
    while True:
        if data[at] != 0xFF:
            raise ValueError("no marker where a segment should start")
        while data[at] == 0xFF:  # fill bytes before a marker
            at += 1
        marker = data[at]
        at += 1
        if marker in _STANDALONE:
            continue
        if marker == 0xD9:
            raise ValueError("the image ends before its scan")
        length = _u16(data, at)
        if length < 2 or at + length > len(data):
            raise IndexError(at + length)
        if marker in _SOF:
            size = _u16(data, at + 5), _u16(data, at + 3)
        elif marker == 0xE1 and data[at + 2:at + 8] == b"Exif\0\0":
            orientation = _exif_orientation(data[at + 8:at + length])
        elif marker == 0xDA:
            if size is None:
                raise ValueError("no start of frame before the scan")
            # Scan data stuffs every 0xFF it holds, so 0xFFD9 after the scan
            # header is the end-of-image marker.
            if data.find(b"\xff\xd9", at + length) < 0:
                raise ValueError("no end-of-image marker")
            width, height = size
            return (height, width) if 5 <= orientation <= 8 else (width, height)
        at += length


def _exif_orientation(tiff: bytes) -> int:
    """The orientation in EXIF's first directory; 1 when there is none or the
    EXIF cannot be read, which browsers take as upright too."""
    try:
        order = {b"II": "little", b"MM": "big"}[tiff[:2]]
        if _u16(tiff, 2, order) != 42:
            return 1
        ifd = _u32(tiff, 4, order)
        for entry in range(_u16(tiff, ifd, order)):
            at = ifd + 2 + 12 * entry
            if _u16(tiff, at, order) == _ORIENTATION_TAG:
                return _u16(tiff, at + 8, order)
    except (KeyError, IndexError):
        pass
    return 1


def store(directory: Path, image: Image) -> Path:
    """Keep image in directory under its name; storing it again writes nothing."""
    # Imported here: cli imports this module, so this one must not need cli
    # while it is first imported.
    from lotuspod.cli import write_atomic

    directory.mkdir(parents=True, exist_ok=True)
    path = directory / image.name
    if not path.is_file() or path.is_symlink():
        write_atomic(path, image.data)
    return path


def stored_file(directory: Path, name: str) -> Path | None:
    """The stored image NAME as a regular file in directory; None when NAME is
    no stored name or no such file is there (a symbolic link is not one)."""
    if not STORED_NAME.fullmatch(name):
        return None
    path = directory / name
    try:
        if path.is_symlink() or not path.is_file():
            return None
    except OSError:
        return None
    return path


def load_stored(directory: Path, name: str) -> Image | None:
    """The stored image NAME, checked again; None when it is not stored."""
    path = stored_file(directory, name)
    if path is None:
        return None
    try:
        data = path.read_bytes()
        image = check(data, name, cap=None)
    except (OSError, MediaError):
        return None
    return image if image.name == name else None
