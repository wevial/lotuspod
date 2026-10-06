"""Test suite for the README as a short front door to the docs pages.

The README keeps what Lotuspod is, the layout and a quick start, and links
five docs pages, each written for one kind of reader. This file witnesses the
split: the README's size and links, every relative link and anchor between
the pages, every code block of the README before the split kept exactly once
(as it was, or with the placeholders the public repository uses), one
"Decisions for the maintainer" heading, and the README's pictures: three
PNG screenshots and one GIF under docs/images/, each with alt text, each a
real image of its kind and small enough to load.

Run from the repo root:

    python -m unittest tests.test_docs_links -v
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from tests import history

REPO_ROOT = Path(__file__).resolve().parents[1]

DOCS_PAGES = ("docs/publishing.md", "docs/comments.md", "docs/agents.md",
              "docs/operating.md", "docs/development.md")
PAGES = ("README.md", *DOCS_PAGES)
# main before the README was split: its code blocks must all still be there.
BASE_COMMIT = "ec57885"
# What those blocks named before the repository went public, and the
# placeholder each now names instead, applied in order. The hostname is
# matched by where it stands, so the live one is named nowhere at HEAD.
PUBLIC_PLACEHOLDERS = (
    (r"(route dns lotuspod )\S+", r"\1lotuspod.example.com"),
    (r"/home/\w+/", "/home/<user>/"),
    (r"--owner hermes --json   #", "--owner my-agent --json #"),
    (r"lotuspod credential list          #", "lotuspod credential list            #"),
    (r"hermes|claude-3f9a2c|codex-7d21e0", "my-agent"),
)

FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
LINK = re.compile(r"\[(?:[^\[\]]|\[[^\]]*\])*\]\(([^()\s]+)\)")
CODE_SPAN = re.compile(r"(`+)(.+?)\1", re.S)
IMAGE = re.compile(r"!\[([^\]]*)\]\(([^()\s]+)\)")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_LIMIT = 400 * 1024
GIF_LIMIT = 3 * 1024 * 1024


def read(name: str) -> str:
    return (REPO_ROOT / name).read_text(encoding="utf-8")


def split_fences(text: str) -> tuple[list[str], list[str]]:
    """The lines outside fenced code blocks, and each block whole, fences included."""
    prose: list[str] = []
    blocks: list[str] = []
    block: list[str] | None = None
    fence = ""
    for line in text.split("\n"):
        if block is None:
            match = FENCE.match(line)
            if match:
                fence = match.group(2)
                block = [line]
            else:
                prose.append(line)
        else:
            block.append(line)
            stripped = line.strip()
            if stripped.startswith(fence) and stripped.strip(fence[0]) == "":
                blocks.append("\n".join(block))
                block = None
    if block is not None:
        blocks.append("\n".join(block))
    return prose, blocks


def headings(text: str) -> list[str]:
    prose, _ = split_fences(text)
    return [m.group(2) for m in map(HEADING.match, prose) if m]


def slug(heading: str) -> str:
    """GitHub's anchor for a heading: lower case, punctuation dropped, spaces as dashes."""
    text = CODE_SPAN.sub(lambda m: m.group(2), heading).strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(text: str) -> set[str]:
    seen: dict[str, int] = {}
    found = set()
    for heading in headings(text):
        base = slug(heading)
        count = seen.get(base, 0)
        seen[base] = count + 1
        found.add(base if count == 0 else f"{base}-{count}")
    return found


def links(text: str) -> list[str]:
    prose, _ = split_fences(text)
    return LINK.findall(CODE_SPAN.sub("", "\n".join(prose)))


def images(text: str) -> list[tuple[str, str]]:
    """Each image's alt text and path, outside code."""
    prose, _ = split_fences(text)
    return IMAGE.findall(CODE_SPAN.sub("", "\n".join(prose)))


def skip_sub_blocks(data: bytes, at: int) -> int:
    """Where the GIF data sub-blocks starting at at end, past their terminator."""
    while data[at]:
        at += data[at] + 1
    return at + 1


def gif_frames(data: bytes) -> int:
    """How many image descriptors the GIF holds, walking its blocks."""
    flags = data[10]
    at = 13 + (3 << ((flags & 7) + 1) if flags & 0x80 else 0)
    frames = 0
    while data[at] != 0x3B:
        if data[at] == 0x21:
            at = skip_sub_blocks(data, at + 2)
        elif data[at] == 0x2C:
            frames += 1
            local = data[at + 9]
            at += 10 + (3 << ((local & 7) + 1) if local & 0x80 else 0)
            at = skip_sub_blocks(data, at + 1)
        else:
            raise ValueError(f"no GIF block at byte {at}")
    return frames


class ReadmeTests(unittest.TestCase):
    def test_the_readme_is_short(self):
        self.assertLessEqual(len(read("README.md").splitlines()), 200)

    def test_the_readme_does_not_call_lotuspod_a_podcast(self):
        self.assertNotIn("podcast", read("README.md").lower())

    def test_the_readme_links_each_docs_page(self):
        targets = {target.split("#")[0] for target in links(read("README.md"))}
        for page in DOCS_PAGES:
            with self.subTest(page=page):
                self.assertIn(page, targets)


class ReadmeImageTests(unittest.TestCase):
    def test_the_readme_shows_three_pngs_and_one_gif_from_docs_images(self):
        found = images(read("README.md"))
        kinds = sorted(Path(path).suffix for _, path in found)
        self.assertEqual(kinds, [".gif", ".png", ".png", ".png"])
        for alt, path in found:
            with self.subTest(image=path):
                self.assertTrue(path.startswith("docs/images/"), path)
                self.assertTrue((REPO_ROOT / path).is_file(), f"{path}: no such file")
                self.assertTrue(alt.strip(), f"{path} has no alt text")

    def test_each_readme_image_is_its_kind_and_small(self):
        for _, path in images(read("README.md")):
            data = (REPO_ROOT / path).read_bytes()
            with self.subTest(image=path):
                if path.endswith(".png"):
                    self.assertTrue(data.startswith(PNG_SIGNATURE))
                    self.assertLessEqual(len(data), PNG_LIMIT)
                else:
                    self.assertTrue(data.startswith(b"GIF89a"))
                    self.assertGreater(gif_frames(data), 1)
                    self.assertLessEqual(len(data), GIF_LIMIT)

    def test_gif_frames_are_counted_by_their_descriptors(self):
        screen = b"GIF89a" + b"\x01\x00\x01\x00" + b"\x80\x00\x00" + b"\x00" * 6
        control = b"\x21\xf9\x04\x00\x0a\x00\x00\x00"
        # A descriptor whose image data holds the descriptor's own byte, 0x2C.
        frame = b"\x2c" + b"\x00" * 4 + b"\x01\x00\x01\x00\x00" + b"\x02\x02\x2c\x2c\x00"
        self.assertEqual(gif_frames(screen + control + frame + b"\x3b"), 1)
        self.assertEqual(gif_frames(screen + (control + frame) * 3 + b"\x3b"), 3)


class LinkTests(unittest.TestCase):
    def test_every_relative_link_names_a_file_and_a_heading_there(self):
        checked = 0
        for page in PAGES:
            for target in links(read(page)):
                if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
                    continue
                path, _, anchor = target.partition("#")
                with self.subTest(page=page, link=target):
                    file = ((REPO_ROOT / page).parent / path).resolve() if path else REPO_ROOT / page
                    self.assertTrue(file.is_file(), f"{target} from {page}: no such file")
                    if anchor:
                        self.assertIn(anchor, anchors(file.read_text(encoding="utf-8")),
                                      f"{target} from {page}: no such heading")
                checked += 1
        self.assertGreater(checked, 0)

    def test_the_slug_follows_github(self):
        self.assertEqual(slug("Who is reading: Cloudflare Access"),
                         "who-is-reading-cloudflare-access")
        self.assertEqual(slug("Agents: the pull loop"), "agents-the-pull-loop")
        self.assertEqual(anchors("## A\n\n```\n## A\n```\n\n## A\n"), {"a", "a-1"})


class ContentTests(unittest.TestCase):
    def base_readme(self) -> str:
        return history.show(BASE_COMMIT, "README.md", repo=REPO_ROOT)

    def test_every_code_block_of_the_old_readme_is_kept_exactly_once(self):
        _, blocks = split_fences(self.base_readme())
        self.assertEqual(len(blocks), 37)
        texts = [read(page) for page in PAGES]
        for block in blocks:
            public = block
            for old, new in PUBLIC_PLACEHOLDERS:
                public = re.sub(old, new, public)
            forms = {block, public}
            with self.subTest(block=block.splitlines()[1] if "\n" in block else block):
                self.assertEqual(
                    sum(text.count(form) for text in texts for form in forms), 1)

    def test_decisions_for_the_maintainer_is_one_heading(self):
        found = [page for page in PAGES for heading in headings(read(page))
                 if heading == "Decisions for the maintainer"]
        self.assertEqual(found, ["docs/publishing.md"])


if __name__ == "__main__":
    unittest.main()
