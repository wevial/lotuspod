"""Witness: `lotuspod publish SOURCE` turns a markdown or HTML page into a
published page with one commit and push to the artifacts repository,
keeping the source beside the page and the page's first date, stamping the
source's revision, and changing nothing when it expects another revision.

Real git in temporary directories, with a local bare repository as the
artifacts remote. The CLI runs as a subprocess of this checkout's src/.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
TIMEOUT = 120

FIRST = """\
# Pond plan

The pond needs **clean water** and a `pump`.

## Findings

- Water is low
  - Since August
- Fish are fine

| Part | State |
| --- | --- |
| Pump | Broken |

```mermaid
flowchart LR
  pump --> pond
```

## Next steps

1. Order a pump

## Concrete commands

ssh writer-host rm -rf /tmp/secret-token-123
"""

SECOND = FIRST.replace("1. Order a pump", "1. The pump was replaced")

GARDEN = """\
<h1>Garden notes</h1>
<p>Two beds, one path.</p>
<h2>Beds</h2>
<p>North and south.</p>
<h2>Path</h2>
<p>Gravel.</p>
"""

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}


class Node:
    def __init__(self, tag, attrs, parent):
        self.tag = tag
        self.attrs = {key: value or "" for key, value in attrs}
        self.parent = parent
        self.children = []

    def classes(self):
        return self.attrs.get("class", "").split()

    def text(self):
        return "".join(c if isinstance(c, str) else c.text() for c in self.children)

    def walk(self):
        for child in self.children:
            if isinstance(child, Node):
                yield child
                yield from child.walk()

    def find(self, tag, cls=None):
        return [n for n in self.walk()
                if n.tag == tag and (cls is None or cls in n.classes())]


class _Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", [], None)
        self.current = self.root

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.current.children.append(Node(tag, attrs, self.current))

    def handle_endtag(self, tag):
        node = self.current
        while node is not self.root and node.tag != tag:
            node = node.parent
        if node is not self.root:
            self.current = node.parent

    def handle_data(self, data):
        self.current.children.append(data)


def parse(html: str) -> Node:
    tree = _Tree()
    tree.feed(html)
    tree.close()
    return tree.root


def meta(root: Node, name: str) -> str:
    for node in root.find("meta"):
        if node.attrs.get("name") == name:
            return node.attrs.get("content", "")
    return ""


def revision(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def git(cwd: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True,
                          timeout=TIMEOUT)


class PublishWitness(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.bare = self.tmp / "origin.git"
        self.out = self.tmp / "artifacts"
        for argv in (("init", "-q", "--bare", "-b", "main", str(self.bare)),
                     ("clone", "-q", str(self.bare), str(self.out))):
            done = git(self.tmp, *argv)
            self.assertEqual(done.returncode, 0, done.stderr)
        for key, value in (("user.name", "Witness"),
                           ("user.email", "witness@lotuspod.invalid"),
                           ("commit.gpgsign", "false")):
            git(self.out, "config", key, value)

    def publish(self, source: Path, *extra: str) -> subprocess.CompletedProcess:
        env = dict(os.environ, PYTHONPATH=str(SRC))
        return subprocess.run(
            [sys.executable, "-m", "lotuspod", "publish", str(source),
             "--out-dir", str(self.out), *extra],
            cwd=str(self.tmp), env=env, capture_output=True, text=True,
            timeout=TIMEOUT)

    def commits(self) -> int:
        done = git(self.bare, "rev-list", "--count", "main")
        return int(done.stdout) if done.returncode == 0 else 0

    def remote_files(self) -> set:
        done = git(self.bare, "ls-tree", "-r", "--name-only", "main")
        return set(done.stdout.decode().split()) if done.returncode == 0 else set()

    def remote_bytes(self, name: str) -> bytes:
        done = git(self.bare, "show", f"main:{name}")
        return done.stdout if done.returncode == 0 else b""

    def page(self, name: str) -> Node:
        path = self.out / f"{name}.html"
        self.assertTrue(path.is_file(), f"{path} was not written")
        return parse(path.read_text(encoding="utf-8"))

    def test_a_markdown_page_is_published_with_one_commit_and_keeps_its_date(self):
        source = self.tmp / "pond-plan.md"
        source.write_text(FIRST, encoding="utf-8")
        done = self.publish(source, "--date", "2026-09-01", "--summary", "Water plan")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.commits(), 1)
        self.assertLessEqual({"pond-plan.html", "pond-plan.md", "manifest.json",
                              "index.html"}, self.remote_files())
        self.assertEqual(self.remote_bytes("pond-plan.md"), FIRST.encode("utf-8"))
        self.assertEqual(git(self.out, "status", "--porcelain").stdout, b"")

        root = self.page("pond-plan")
        titles = root.find("h1", "artifact-title")
        self.assertEqual([t.text().strip() for t in titles], ["Pond plan"])
        bodies = root.find("section", "artifact-body")
        self.assertEqual(len(bodies), 1)
        body = bodies[0]
        self.assertEqual([h.text().strip() for h in body.find("h2")],
                         ["Findings", "Next steps"])
        self.assertIn("clean water", [n.text() for n in body.find("strong")])
        self.assertIn("pump", [n.text() for n in body.find("code")])
        self.assertTrue(any(li.find("ul") for ul in body.find("ul") for li in ul.find("li")),
                        "the indented item is not nested inside the item above it")
        tables = body.find("table")
        self.assertEqual(len(tables), 1)
        self.assertEqual(len(tables[0].find("tr")), 2)
        diagrams = body.find("pre", "mermaid")
        self.assertEqual(len(diagrams), 1)
        self.assertIn("pump --> pond", diagrams[0].text())
        html = (self.out / "pond-plan.html").read_text(encoding="utf-8")
        self.assertNotIn("Concrete commands", html)
        self.assertNotIn("secret-token-123", html)
        times = root.find("time")
        self.assertTrue(times)
        self.assertEqual(times[0].attrs.get("datetime"), "2026-09-01")
        self.assertIn("Pond plan", (self.out / "index.html").read_text(encoding="utf-8"))

        source.write_text(SECOND, encoding="utf-8")
        done = self.publish(source)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.commits(), 2)
        self.assertEqual(self.remote_bytes("pond-plan.md"), SECOND.encode("utf-8"))
        root = self.page("pond-plan")
        self.assertIn("The pump was replaced", root.text())
        self.assertEqual(root.find("time")[0].attrs.get("datetime"), "2026-09-01")
        summaries = root.find("p", "artifact-summary")
        self.assertEqual([s.text().strip() for s in summaries], ["Water plan"])

    def test_a_publish_expecting_another_revision_changes_nothing(self):
        source = self.tmp / "pond-plan.md"
        source.write_text(FIRST, encoding="utf-8")
        done = self.publish(source, "--date", "2026-09-01")
        self.assertEqual(done.returncode, 0, done.stderr)
        first = meta(self.page("pond-plan"), "lotuspod:revision")
        self.assertEqual(first, revision(FIRST.encode("utf-8")))
        before = (self.out / "pond-plan.html").read_bytes()

        source.write_text(SECOND, encoding="utf-8")
        done = self.publish(source, "--expect-revision", "000000000000")
        self.assertEqual(done.returncode, 3, done.stderr)
        self.assertEqual((self.out / "pond-plan.html").read_bytes(), before)
        self.assertEqual(self.remote_bytes("pond-plan.md"), FIRST.encode("utf-8"))
        self.assertEqual(self.commits(), 1)

        done = self.publish(source, "--expect-revision", first)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(meta(self.page("pond-plan"), "lotuspod:revision"),
                         revision(SECOND.encode("utf-8")))
        self.assertEqual(self.commits(), 2)

    def test_an_html_page_is_published_with_its_source_and_section_ids(self):
        source = self.tmp / "garden.html"
        source.write_text(GARDEN, encoding="utf-8")
        done = self.publish(source, "--date", "2026-09-02")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.commits(), 1)
        self.assertLessEqual({"garden.html", "garden.body.html", "manifest.json",
                              "index.html"}, self.remote_files())
        self.assertEqual(self.remote_bytes("garden.body.html"), GARDEN.encode("utf-8"))

        root = self.page("garden")
        self.assertEqual([t.text().strip() for t in root.find("h1")], ["Garden notes"])
        body = root.find("section", "artifact-body")[0]
        self.assertEqual([h.attrs.get("id") for h in body.find("h2")], ["beds", "path"])
        outline = root.find("nav", "artifact-outline")
        self.assertEqual(len(outline), 1)
        self.assertEqual([a.attrs.get("href") for a in outline[0].find("a")],
                         ["#beds", "#path"])
        try:
            manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self.fail(f"manifest.json is not readable JSON: {exc}")
        self.assertEqual([entry.get("file") for entry in manifest.get("artifacts", [])],
                         ["garden.html"])


if __name__ == "__main__":
    unittest.main()
