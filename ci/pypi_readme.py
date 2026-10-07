"""Point the README's relative images and links at GitHub, at a release tag.

PyPI shows the package's long description, the README, with no repository to
resolve a relative path against, so its images break and its links go
nowhere. The README stays relative in the repository: the demo publishes it
under a page policy of `img-src 'self' data:`, and relative paths are right
on every branch. The release job runs this on its fresh checkout instead,
before `python -m build`, which reads the README `pyproject.toml` names.

Rewrites, in place, each markdown image `![...](PATH)` to
`https://raw.githubusercontent.com/wevial/lotuspod/TAG/PATH`, and each other
link `[...](PATH)` to `https://github.com/wevial/lotuspod/blob/TAG/PATH`,
keeping any `#anchor`. A target with a scheme (`https:`, `mailto:`), a
`//host` target and a bare `#anchor` are left alone, as are code spans and
fenced code blocks.

Reads and writes the README beside this script's directory, so never run it
in a working tree you mean to commit from. Standard library only:

    python ci/pypi_readme.py v0.1.1
"""

from __future__ import annotations

import posixpath
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = "wevial/lotuspod"
IMAGE_BASE = f"https://raw.githubusercontent.com/{REPOSITORY}"
LINK_BASE = f"https://github.com/{REPOSITORY}/blob"
TAG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
CODE_SPAN = re.compile(r"(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)", re.S)
# `![text](target "title")` or `[text](target)`; the text may hold one level
# of brackets, as a linked image's does.
LINK = re.compile(
    r"(!?)\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(([^\s()]+)((?:\s+\"[^\"]*\")?)\)"
)
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def is_relative(target: str) -> bool:
    """Whether target is a path in the repository, not a URL or an anchor."""
    return not (SCHEME.match(target) or target.startswith(("#", "//")))


def absolute(target: str, tag: str, image: bool) -> str:
    """The GitHub URL at tag for a relative target."""
    path, hash_, anchor = target.partition("#")
    path = posixpath.normpath(path.lstrip("/"))
    if image:
        return f"{IMAGE_BASE}/{tag}/{path}{hash_}{anchor}"
    return f"{LINK_BASE}/{tag}/{path}{hash_}{anchor}"


def rewrite_links(text: str, tag: str) -> str:
    """text, outside code, with each relative image and link target made
    absolute."""
    def replace(match: re.Match) -> str:
        bang, label, target, title = match.groups()
        label = rewrite_links(label, tag)
        if is_relative(target):
            target = absolute(target, tag, image=bool(bang))
        return f"{bang}[{label}]({target}{title})"

    out: list[str] = []
    at = 0
    for span in CODE_SPAN.finditer(text):
        out.append(LINK.sub(replace, text[at:span.start()]))
        out.append(span.group(0))
        at = span.end()
    out.append(LINK.sub(replace, text[at:]))
    return "".join(out)


def rewrite(text: str, tag: str) -> str:
    """The README text with its relative targets pointed at GitHub at tag;
    fenced code blocks are kept byte for byte."""
    out: list[str] = []
    prose: list[str] = []
    fence: str | None = None
    for line in text.splitlines(keepends=True):
        match = FENCE.match(line)
        if fence is None:
            if match:
                out.append(rewrite_links("".join(prose), tag))
                prose = []
                fence = match.group(1)
                out.append(line)
            else:
                prose.append(line)
        else:
            out.append(line)
            if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= len(fence) \
                    and not line.strip().lstrip(fence[0]):
                fence = None
    out.append(rewrite_links("".join(prose), tag))
    return "".join(out)


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python ci/pypi_readme.py TAG", file=sys.stderr)
        return 2
    tag = argv[0]
    if not TAG.match(tag):
        print(f"pypi readme: {tag!r} is not a tag name", file=sys.stderr)
        return 1
    readme = ROOT / "README.md"
    try:
        text = readme.read_text(encoding="utf-8")
        readme.write_text(rewrite(text, tag), encoding="utf-8")
    except OSError as exc:
        print(f"pypi readme: {exc}", file=sys.stderr)
        return 1
    print(f"pypi readme: {readme.name} points at {REPOSITORY} at {tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
