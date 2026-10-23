"""Test suite for the import graph: the slice rules hold over every module
under src/lotuspod/.

Each module is read with ast, and every import it makes, at the top or inside
a function, is checked against the rules:

- nothing imports lotuspod.cli but lotuspod.__main__;
- lotuspod.core imports nothing else in Lotuspod;
- lotuspod.store imports only lotuspod.core;
- a slice, each folder under src/lotuspod/features/, imports core, store, its
  own modules, and another slice through that slice's public edge (the names
  its __init__.py exports); an import that reaches past another slice's
  __init__.py into its modules is allowed only along an edge in EDGES.

A module still flat in src/lotuspod/ is checked only for the cli rule, and a
slice may still import one.

EDGES is a ratchet: it starts at the cross-slice edges main's imports make,
by TARGET_TREE, one (from, to) slice pair a line. An entry can only be
removed, never added: once a slice reaches the other only through its public
edge, the entry goes. TARGET_TREE names the slice each flat module moves
into, so an edge still made by flat modules counts as made.

Run from the repo root:

    python -m unittest tests.test_import_graph -v
"""

from __future__ import annotations

import ast
import secrets
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_DIR = REPO_ROOT / "src" / "lotuspod"

PACKAGE = "lotuspod"
CLI = "lotuspod.cli"
ENTRY = "lotuspod.__main__"
CORE = "lotuspod.core"
STORE = "lotuspod.store"
FEATURES = "lotuspod.features"

# The slice each module still flat in src/lotuspod/ moves into. cli.py, the
# entry point, is split across them by the moves themselves.
TARGET_TREE = {
    "access": "serve",
    "agents": "agents",
    "api": "serve",
    "archive": "history",
    "backup": "backup",
    "calltree": "publish",
    "comments": "comments",
    "decisions": "decisions",
    "events": "serve",
    "libraries": "widgets",
    "machine": "agents",
    "markdown": "publish",
    "media": "media",
    "node_tables": "publish",
    "publish": "publish",
    "publish_sources": "publish",
    "refs": "publish",
    "render": "publish",
    "responder": "agents",
    "routing": "comments",
    "sections": "comments",
    "serve_files": "serve",
    "site_index": "index",
    "versions": "history",
    "widgets": "widgets",
}

# Each import that reaches past another slice's __init__.py into its modules
# is allowed only along one of these (from, to) edges. Only ever remove one.
EDGES = (
    ("agents", "comments"),
    ("agents", "media"),
    ("agents", "publish"),
    ("agents", "serve"),
    ("agents", "widgets"),
    ("backup", "media"),
    ("backup", "serve"),
    ("decisions", "comments"),
    ("decisions", "serve"),
    ("history", "index"),
    ("history", "serve"),
    ("history", "widgets"),
    ("index", "history"),
    ("publish", "agents"),
    ("publish", "comments"),
    ("publish", "decisions"),
    ("publish", "index"),
    ("publish", "media"),
    ("publish", "serve"),
    ("publish", "widgets"),
    ("serve", "comments"),
    ("serve", "history"),
    ("serve", "media"),
    ("serve", "widgets"),
    ("widgets", "publish"),
)


def module_name(package_dir: Path, path: Path) -> str:
    """The dotted name of the module at path, under package_dir's package."""
    parts = list(path.relative_to(package_dir.parent).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def is_module(package_dir: Path, name: str) -> bool:
    """Whether the dotted name, under package_dir's package, is a module or a
    package rather than a name some module defines."""
    path = package_dir.parent.joinpath(*name.split("."))
    return path.with_suffix(".py").is_file() or path.is_dir()


def imports(package_dir: Path, path: Path) -> list[tuple[int, str]]:
    """(line, module) for each import the module at path makes, at any depth:
    `from X import name` imports X.name when that is a module, else X."""
    tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
    name = module_name(package_dir, path)
    package = name if path.name == "__init__.py" else name.rpartition(".")[0]
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += [(node.lineno, alias.name) for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                parts = package.split(".")
                base = ".".join(parts[:len(parts) - node.level + 1]
                                + ([node.module] if node.module else []))
            else:
                base = node.module or ""
            for alias in node.names:
                target = f"{base}.{alias.name}"
                found.append((node.lineno, target if alias.name != "*"
                              and is_module(package_dir, target) else base))
    return found


def within(name: str, package: str) -> bool:
    return name == package or name.startswith(package + ".")


def slice_of(name: str) -> str | None:
    """The slice a module under features/ belongs to; None for any other."""
    if within(name, FEATURES) and name != FEATURES:
        return name[len(FEATURES) + 1:].split(".", 1)[0]
    return None


def problem(importer: str, target: str, edges: set[tuple[str, str]]) -> str | None:
    """Why the slice rules refuse importer importing target; None when they
    allow it."""
    if not within(target, PACKAGE):
        return None
    if within(target, CLI) and importer != ENTRY:
        return f"only {ENTRY} imports {CLI}"
    if within(importer, CORE):
        return None if within(target, CORE) else "core imports nothing else in Lotuspod"
    if within(importer, STORE):
        return None if within(target, CORE) or within(target, STORE) else \
            "store imports only core"
    own, other = slice_of(importer), slice_of(target)
    if own is None or other is None or other == own:
        return None
    if target == f"{FEATURES}.{other}":
        return None
    if (own, other) in edges:
        return None
    return (f"slice {own} reaches past slice {other}'s __init__.py along no listed edge; "
            f"import it from {FEATURES}.{other}")


def modules(package_dir: Path) -> list[Path]:
    return sorted(path for path in package_dir.rglob("*.py") if "__pycache__" not in path.parts)


def violations(package_dir: Path, edges) -> list[str]:
    """One line per import the slice rules refuse, naming the file and line."""
    edges = set(edges)
    found = []
    for path in modules(package_dir):
        importer = module_name(package_dir, path)
        for line, target in imports(package_dir, path):
            why = problem(importer, target, edges)
            if why:
                found.append(f"{path.relative_to(package_dir.parent)}:{line}: "
                             f"{importer} imports {target}: {why}")
    return found


def made_edges(package_dir: Path, tree: dict[str, str]) -> dict[tuple[str, str], str]:
    """Each cross-slice edge the package's imports make, with one import that
    makes it: a slice's module (under features/, or flat and in tree)
    importing another slice's module other than its __init__.py."""
    def slice_name(name: str) -> str | None:
        flat = name[len(PACKAGE) + 1:] if within(name, PACKAGE) and name != PACKAGE else ""
        return slice_of(name) or (tree.get(flat) if "." not in flat else None)

    made: dict[tuple[str, str], str] = {}
    for path in modules(package_dir):
        importer = module_name(package_dir, path)
        own = slice_name(importer)
        for line, target in imports(package_dir, path):
            other = slice_name(target)
            if own and other and other != own and target != f"{FEATURES}.{other}":
                made.setdefault((own, other), f"{path.relative_to(package_dir.parent)}:{line}: "
                                              f"{importer} imports {target}")
    return made


class RepositoryTests(unittest.TestCase):
    def test_the_package_keeps_the_slice_rules(self):
        self.assertEqual(violations(PACKAGE_DIR, EDGES), [])

    def test_nothing_but_the_entry_point_imports_cli(self):
        """At the top of a module or inside a function alike."""
        importers = sorted({module_name(PACKAGE_DIR, path) for path in modules(PACKAGE_DIR)
                            for _, target in imports(PACKAGE_DIR, path)
                            if within(target, CLI)})
        self.assertEqual(importers, [ENTRY])

    def test_every_listed_edge_is_still_made(self):
        """A listed edge no import makes any more is dropped from EDGES."""
        made = made_edges(PACKAGE_DIR, TARGET_TREE)
        self.assertEqual(sorted(set(EDGES) - set(made)), [])

    def test_the_edges_are_listed_once_each_in_order(self):
        self.assertEqual(list(EDGES), sorted(set(EDGES)))


class CheckerTests(unittest.TestCase):
    """The checker over fixture packages written into a temporary directory."""

    EDGE = ("a", "b")

    def setUp(self) -> None:
        self.package = Path(self.enterContext(tempfile.TemporaryDirectory())) / PACKAGE
        self.write("__init__.py", "")
        self.write("__main__.py", "from lotuspod.cli import main\n")
        self.write("cli.py", "from lotuspod.features import a\n")
        self.write("flat.py", "")
        self.write("core/__init__.py", "import os\n")
        self.write("store/__init__.py", "")
        self.write("store/db.py", "from lotuspod import core\n")
        self.write("features/__init__.py", "")
        for name in ("a", "b"):
            self.write(f"features/{name}/__init__.py", "from .inner import run\n")
            self.write(f"features/{name}/inner.py", "def run():\n    pass\n")

    def write(self, name: str, text: str) -> None:
        path = self.package / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(text), encoding="utf-8")

    def found(self, edges=()) -> list[str]:
        return violations(self.package, edges)

    def assert_reported(self, name: str, text: str, target: str, edges=()) -> None:
        self.write(name, text)
        found = self.found(edges)
        self.assertEqual(len(found), 1, found)
        self.assertIn(f"lotuspod/{name}:", found[0])
        self.assertIn(f"imports {target}:", found[0])

    def test_the_fixture_keeps_the_rules(self):
        self.assertEqual(self.found(), [])

    def test_core_importing_a_slice_is_reported(self):
        self.assert_reported("core/__init__.py", "from lotuspod.features.a import run\n",
                             "lotuspod.features.a")

    def test_store_importing_a_slice_is_reported(self):
        self.assert_reported("store/db.py", "from lotuspod.features.b import inner\n",
                             "lotuspod.features.b.inner")

    def test_a_reach_into_another_slice_along_no_listed_edge_is_reported(self):
        self.assert_reported("features/a/user.py", "from lotuspod.features.b import inner\n",
                             "lotuspod.features.b.inner")

    def test_the_same_reach_inside_a_function_is_reported(self):
        self.assert_reported("features/a/user.py", """\
            def use():
                from lotuspod.features.b.inner import run
                return run()
            """, "lotuspod.features.b.inner")

    def test_a_relative_reach_into_another_slice_is_reported(self):
        self.assert_reported("features/a/user.py", "from ..b import inner\n",
                             "lotuspod.features.b.inner")

    def test_a_module_importing_cli_is_reported(self):
        for name in ("flat.py", "features/a/user.py", "core/__init__.py"):
            with self.subTest(name=name):
                self.setUp()
                self.assert_reported(name, "def go():\n    from lotuspod import cli\n",
                                     "lotuspod.cli")

    def test_the_same_reach_along_a_listed_edge_passes(self):
        self.write("features/a/user.py", """\
            from lotuspod.features.b import inner

            def use():
                from lotuspod.features.b.inner import run
                return run()
            """)
        self.assertEqual(self.found([self.EDGE]), [])
        self.assertEqual(len(self.found([("b", "a")])), 2)

    def test_a_slice_importing_another_slices_exports_passes(self):
        self.write("features/a/user.py", """\
            from lotuspod.features import b
            from lotuspod.features.b import run
            from ..b import run as again
            import lotuspod.features.b
            """)
        self.assertEqual(self.found(), [])

    def test_a_slice_importing_core_store_and_its_own_modules_passes(self):
        self.write("features/a/user.py", """\
            from lotuspod import core, flat
            from lotuspod.store import db
            from lotuspod.features.a import inner
            from . import inner as again
            """)
        self.assertEqual(self.found(), [])

    def test_a_slice_named_nowhere_in_this_test_is_checked_as_a_slice(self):
        name = "s" + secrets.token_hex(4)
        self.write(f"features/{name}/__init__.py", "")
        self.write(f"features/{name}/work.py", """\
            from lotuspod.core import os
            from lotuspod.features.a import run
            """)
        self.assertEqual(self.found(), [])
        self.assert_reported(f"features/{name}/more.py", "from lotuspod.features.a import inner\n",
                             "lotuspod.features.a.inner")

    def test_made_edges_name_one_import_for_each(self):
        self.write("features/a/user.py", "from lotuspod.features.b import inner, run\n")
        self.write("flat_user.py", "from lotuspod import flat\n")
        made = made_edges(self.package, {"flat_user": "b", "flat": "a"})
        self.assertEqual(sorted(made), [("a", "b"), ("b", "a")])
        self.assertIn("lotuspod.features.a.user imports lotuspod.features.b.inner", made[("a", "b")])


if __name__ == "__main__":
    unittest.main()
