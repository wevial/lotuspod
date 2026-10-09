"""Test suite for the README as a short front door to the docs pages.

The README keeps what Lotuspod is, the layout and a quick start, and links
six docs pages, five each written for one kind of reader and one showing how
the parts fit together. This file witnesses the split: the README's size and
links, every relative link and anchor between
the pages and SECURITY.md, every code block of the README before the split kept exactly once
(as it was, or with the placeholders the public repository uses) but the
Layout, revised on purpose and naming every command `lotuspod --help` lists, one
"Decisions for the maintainer" heading, and the README's pictures: three
PNG screenshots and one GIF under docs/images/, each with alt text, each a
real image of its kind and small enough to load. It also witnesses what the
README tells a first-time visitor: why Lotuspod, in five bullets before
"See it" whose commands `lotuspod --help` lists, how Lotuspod was built, that it is a
personal project with issues off, and a Security section whose cited
tests.test_access ids each load. The architecture page holds one Mermaid
diagram, whose nodes name the closed list of parts it shows.

Run from the repo root:

    python -m unittest tests.test_docs_links -v
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from tests import history
from tests.test_cli_surface import run_lotuspod

REPO_ROOT = Path(__file__).resolve().parents[1]

DOCS_PAGES = ("docs/publishing.md", "docs/comments.md", "docs/agents.md",
              "docs/operating.md", "docs/development.md", "docs/architecture.md")
PAGES = ("README.md", *DOCS_PAGES, "SECURITY.md")
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
# The blocks of that README revised on purpose, by their first content line:
# only the Layout, which names what main has. Every other block is kept.
REVISED_BLOCKS = ("lotuspod/",)

FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
LINK = re.compile(r"\[(?:[^\[\]]|\[[^\]]*\])*\]\(([^()\s]+)\)")
CODE_SPAN = re.compile(r"(`+)(.+?)\1", re.S)
IMAGE = re.compile(r"!\[([^\]]*)\]\(([^()\s]+)\)")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_LIMIT = 400 * 1024
GIF_LIMIT = 3 * 1024 * 1024
HOLOPHYTE = "https://github.com/wevial/holophyte"
MERGED_PRS = "https://github.com/wevial/lotuspod/pulls?q=is%3Apr+is%3Amerged"
# The parts the architecture diagram's node labels must each name.
ARCHITECTURE_NODES = ("lotuspod serve", "Agent socket", "SQLite", "Cloudflare Access",
                      "Cloudflare Tunnel", "the default responder", "lotuspod publish")
NODE_LABEL = re.compile(r"\b\w+\[([^\]]*)\]")
# Mermaid statements that would style the diagram or make it clickable.
STYLING = re.compile(r"^\s*(click|style|classDef|class|linkStyle)\b", re.M)
ACCESS_TEST_ID = re.compile(r"`(tests\.test_access\.\w+\.\w+)`")
# The Access tests the Security section must cite at least.
PINNING_TESTS = (
    "tests.test_access.VerifierTests.test_header_must_name_rs256_and_a_listed_key",
    "tests.test_access.VerifierTests.test_signature_block_is_compared_whole",
    "tests.test_access.VerifierTests.test_keys_under_2048_bits_are_not_listed",
    "tests.test_access.VerifierTests.test_malformed_tokens_are_invalid",
    "tests.test_access.WhoamiTests.test_email_header_naming_someone_else_is_not_read",
)


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


def first_line(block: str) -> str:
    """A block's first line inside its fences, or the block if it has one line."""
    return block.splitlines()[1] if "\n" in block else block


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


def section(text: str, title: str) -> str:
    """The lines under the level-two heading title, up to the next one."""
    prose, _ = split_fences(text)
    lines: list[str] | None = None
    for line in prose:
        match = HEADING.match(line)
        if match and len(match.group(1)) <= 2:
            if lines is not None:
                break
            if match.group(1) == "##" and match.group(2) == title:
                lines = []
        elif lines is not None:
            lines.append(line)
    if lines is None:
        raise AssertionError(f"no '## {title}' heading")
    return "\n".join(lines)


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

    def help_commands(self) -> list[str]:
        """The commands `lotuspod --help` lists."""
        proc = run_lotuspod("--help")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        choices = re.search(r"\{([a-z,]+)\}", proc.stdout)
        self.assertIsNotNone(choices, proc.stdout)
        return choices.group(1).split(",")

    def test_the_layout_names_each_command_help_lists(self):
        commands = self.help_commands()
        readme = read("README.md")
        _, blocks = split_fences(readme[readme.index("\n## Layout\n"):])
        named = re.search(r"`lotuspod ([a-z|]+)`", blocks[0])
        self.assertIsNotNone(named, blocks[0])
        for command in commands:
            with self.subTest(command=command):
                self.assertIn(command, named.group(1).split("|"))

    def test_why_lotuspod_is_five_bullets_before_see_it_naming_real_commands(self):
        readme = read("README.md")
        found = headings(readme)
        self.assertEqual(found[:3], ["Lotuspod", "Why Lotuspod", "See it"])
        why = section(readme, "Why Lotuspod")
        self.assertEqual(len(re.findall(r"^- ", why, re.M)), 5, why)
        named = re.findall(r"`lotuspod ([a-z]+)", why)
        self.assertLessEqual({"comments", "answers"}, set(named))
        commands = self.help_commands()
        for command in named:
            with self.subTest(command=command):
                self.assertIn(command, commands)


class ReadmeStoryTests(unittest.TestCase):
    def test_how_it_was_built_links_holophyte_and_the_merged_pull_requests(self):
        found = links(section(read("README.md"), "How it was built"))
        self.assertIn(HOLOPHYTE, found)
        self.assertIn(MERGED_PRS, found)

    def test_one_line_says_a_personal_project_with_issues_off(self):
        lines = [line for line in read("README.md").splitlines()
                 if "personal project" in line and "issues are off" in line]
        self.assertEqual(len(lines), 1, lines)

    def test_security_links_the_security_policy(self):
        self.assertIn("SECURITY.md", links(section(read("README.md"), "Security")))

    def test_each_access_test_the_security_section_cites_loads(self):
        cited = ACCESS_TEST_ID.findall(section(read("README.md"), "Security"))
        self.assertLessEqual(set(PINNING_TESTS), set(cited))
        for name in cited:
            with self.subTest(test=name):
                loader = unittest.TestLoader()
                suite = loader.loadTestsFromName(name)
                self.assertEqual(loader.errors, [])
                self.assertEqual([test.id() for test in suite], [name])

    def test_a_missing_test_id_does_not_load_as_itself(self):
        name = "tests.test_access.VerifierTests.test_no_such_check"
        suite = unittest.TestLoader().loadTestsFromName(name)
        self.assertNotEqual([test.id() for test in suite], [name])


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


class ArchitectureDiagramTests(unittest.TestCase):
    def diagrams(self) -> list[str]:
        _, blocks = split_fences(read("docs/architecture.md"))
        return [block for block in blocks
                if FENCE.sub("", block.split("\n")[0]).strip() == "mermaid"]

    def test_the_page_holds_one_mermaid_block(self):
        self.assertEqual(len(self.diagrams()), 1)

    def test_the_node_labels_name_each_part(self):
        labels = NODE_LABEL.findall(self.diagrams()[0])
        for part in ARCHITECTURE_NODES:
            with self.subTest(part=part):
                self.assertTrue(any(part in label for label in labels), labels)

    def test_the_diagram_has_no_click_handlers_or_styling(self):
        self.assertEqual(STYLING.findall(self.diagrams()[0]), [])

    def test_node_labels_need_no_escaping(self):
        for label in NODE_LABEL.findall(self.diagrams()[0]):
            with self.subTest(label=label):
                self.assertNotRegex(label, r"[()\"'`]")


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
        self.assertEqual(REVISED_BLOCKS, ("lotuspod/",))
        revised = [block for block in blocks if first_line(block) in REVISED_BLOCKS]
        self.assertEqual([first_line(block) for block in revised], list(REVISED_BLOCKS))
        texts = [read(page) for page in PAGES]
        for block in blocks:
            if block in revised:
                continue
            public = block
            for old, new in PUBLIC_PLACEHOLDERS:
                public = re.sub(old, new, public)
            forms = {block, public}
            with self.subTest(block=first_line(block)):
                self.assertEqual(
                    sum(text.count(form) for text in texts for form in forms), 1)

    def test_decisions_for_the_maintainer_is_one_heading(self):
        found = [page for page in PAGES for heading in headings(read(page))
                 if heading == "Decisions for the maintainer"]
        self.assertEqual(found, ["docs/publishing.md"])


if __name__ == "__main__":
    unittest.main()
