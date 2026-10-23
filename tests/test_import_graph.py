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

EDGES is a ratchet: it starts at the cross-slice edges main's code makes,
by TARGET_TREE, one (from, to) slice pair a line. An entry can only be
removed, never added: once a slice reaches the other only through its public
edge, the entry goes. TARGET_TREE names the slice each flat module moves
into, so an edge still made by flat modules counts as made; CLI_FUNCTIONS
names the slice each function cli.py still holds moves into, so an edge made
by a use inside one of them counts too.

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
    "comments": "comments",
    "decisions": "decisions",
    "events": "live",
    "machine": "agents",
    "responder": "agents",
    "routing": "agents",
    "serve_files": "serve",
}

# The slice each function and class cli.py still holds moves into. One of
# them using a name another slice owns makes an edge, as an import does; the
# parser and main stay with the entry point.
CLI_FUNCTIONS = {
    "_AllowListHandler": "serve",
    "_Catalog": "serve",
    "_make_server": "serve",
    "_stop_serving": "serve",
    "access_verifier": "serve",
    "agent_page": "agents",
    "answers_text": "decisions",
    "api_catalog": "serve",
    "api_page": "serve",
    "claim_seconds": "serve",
    "cmd_answers": "decisions",
    "cmd_audit": "serve",
    "cmd_credential_create": "serve",
    "cmd_credential_list": "serve",
    "cmd_credential_revoke": "serve",
    "cmd_serve": "serve",
    "owner_window": "serve",
    "resolve_serve_host": "serve",
    "serve_socket_path": "serve",
    "served_page_names": "serve",
}

# Each import that reaches past another slice's __init__.py into its modules
# is allowed only along one of these (from, to) edges. Only ever remove one.
# Each names the import or call site on main (f388140) that made it first.
EDGES = (
    ("agents", "comments"),  # agents.py:60 imports comments
    ("agents", "publish"),  # agents.py:60 imports media
    ("agents", "serve"),  # agents.py:60 imports api
    ("agents", "widgets"),  # machine.py:207 imports widgets
    ("backup", "publish"),  # backup.py:43 imports media
    ("backup", "serve"),  # backup.py:409 calls cli.serve_db_path
    ("decisions", "agents"),  # cli.py:3170, answers_text, uses agents
    ("decisions", "comments"),  # decisions.py:56 imports comments
    ("decisions", "serve"),  # decisions.py:56 imports api
    ("history", "index"),  # archive.py:188 calls cli.cmd_manifest
    ("history", "serve"),  # archive.py:40 imports api
    ("history", "widgets"),  # versions.py:62 imports widgets
    ("index", "history"),  # cli.py:1109, collect_artifacts, calls archive.read_record
    ("live", "history"),  # events.py:54 imports archive
    ("live", "serve"),  # events.py:57 calls cli.serve_allow_list
    ("publish", "agents"),  # cli.py:744, check_owner, calls machine.is_handle
    ("publish", "blocks"),  # markdown.py:53 imports calltree
    ("publish", "comments"),  # sections.py:23 imports comments
    ("publish", "decisions"),  # cli.py:816, cmd_render, calls decisions.render_decisions
    ("publish", "index"),  # cli.py:2342, cmd_publish, calls cmd_manifest
    ("publish", "serve"),  # cli.py:757, check_owner, calls serve_db_path
    ("publish", "widgets"),  # markdown.py:53 imports widgets
    ("serve", "agents"),  # api.py:222 imports routing
    ("serve", "comments"),  # api.py:222 imports comments
    ("serve", "decisions"),  # cli.py:2440, api_page, calls decisions.read_forms
    ("serve", "history"),  # api.py:222 imports versions
    ("serve", "live"),  # cli.py:2583, _AllowListHandler, uses events
    ("serve", "publish"),  # api.py:222 imports media
    ("serve", "widgets"),  # cli.py:2387, serve_allow_list, calls widgets.Frames
    ("widgets", "publish"),  # widgets.py:218 imports markdown
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


def bound_names(target: ast.expr) -> set[str]:
    """The names an assignment or del target binds or unbinds itself: a name,
    or the names a tuple, list or starred target holds, never those inside a
    subscript or an attribute (registry[key] binds no key)."""
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, ast.Starred):
        return bound_names(target.value)
    if isinstance(target, (ast.Tuple, ast.List)):
        return set().union(*map(bound_names, target.elts))
    return set()


def surely_bound(body: list[ast.stmt]) -> set[str]:
    """The names a run of module-level statements binds on every path through
    it: a branch of an if, a try's handler or a loop that may not run binds
    a name only when every other path binds it too."""
    bound: set[str] = set()
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
        elif isinstance(node, ast.Assign) or isinstance(node, ast.AnnAssign) and node.value:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            bound |= set().union(*map(bound_names, targets))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            bound |= {alias.asname or alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.If):
            bound |= surely_bound(node.body) & surely_bound(node.orelse)
        elif isinstance(node, (ast.Try, ast.TryStar)):
            paths = [surely_bound(node.body + node.orelse)]
            paths += [surely_bound(handler.body) for handler in node.handlers]
            bound |= set.intersection(*paths) | surely_bound(node.finalbody)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            bound |= surely_bound(node.body)
    return bound


def maybe_deleted(body: list[ast.stmt]) -> set[str]:
    """The names any module-level del, on any path, unbinds."""
    deleted: set[str] = set()
    for node in body:
        if isinstance(node, ast.Delete):
            deleted |= set().union(*map(bound_names, node.targets))
        elif not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for field in ("body", "orelse", "finalbody", "handlers", "cases"):
                for child in getattr(node, field, []):
                    deleted |= maybe_deleted(child.body if isinstance(
                        child, (ast.ExceptHandler, ast.match_case)) else [child])
    return deleted


def exports(package_dir: Path, name: str) -> set[str]:
    """The names the package's __init__.py surely binds at its top level
    itself (an annotation alone binds none) and no del there may unbind: a
    `from X import name` of one of them takes that name, not a submodule.
    A name bound on only some paths, or deleted on any, is not counted, so
    the import is held to the slice rule as the submodule it may load."""
    path = package_dir.parent.joinpath(*name.split("."), "__init__.py")
    if not path.is_file():
        return set()
    body = ast.parse(path.read_text(encoding="utf-8"), str(path)).body
    return surely_bound(body) - maybe_deleted(body)


def imports(package_dir: Path, path: Path) -> list[tuple[int, str]]:
    """(line, module) for each import the module at path makes, at any depth:
    `from X import name` imports X.name when that is a module X's __init__.py
    does not bind a name over, else X."""
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
            bound = exports(package_dir, base)
            for alias in node.names:
                target = f"{base}.{alias.name}"
                found.append((node.lineno, target if alias.name != "*" and alias.name not in bound
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
    if target == f"{FEATURES}.{other}" or (own, other) in edges:
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


def call_edges(package_dir: Path, tree: dict[str, str],
               functions: dict[str, str]) -> dict[tuple[str, str], str]:
    """Each cross-slice edge cli.py's functions make, with one use that makes
    it: a function or class in functions using a name bound to a flat module
    in tree, or to another of functions, whose slice is not its own."""
    path = package_dir / "cli.py"
    tree_ast = ast.parse(path.read_text(encoding="utf-8"), str(path))
    owner = {}
    for node in tree_ast.body:
        if isinstance(node, ast.ImportFrom) and not node.level and node.module:
            for alias in node.names:
                flat = alias.name if node.module == PACKAGE else node.module[len(PACKAGE) + 1:]
                if within(node.module, PACKAGE) and flat in tree:
                    owner[alias.asname or alias.name] = tree[flat]
    owner.update(functions)
    made: dict[tuple[str, str], str] = {}
    for node in tree_ast.body:
        own = functions.get(getattr(node, "name", ""))
        if own is None:
            continue
        for used in ast.walk(node):
            other = owner.get(used.id) if isinstance(used, ast.Name) else None
            if other and other != own:
                made.setdefault((own, other), f"lotuspod/cli.py:{used.lineno}: "
                                              f"{node.name} uses {used.id}")
    return made


class RepositoryTests(unittest.TestCase):
    def test_the_package_keeps_the_slice_rules(self):
        self.assertEqual(violations(PACKAGE_DIR, EDGES), [])

    def test_every_listed_edge_is_still_made(self):
        """A listed edge no import, and no use in cli.py, makes any more is
        dropped from EDGES."""
        made = made_edges(PACKAGE_DIR, TARGET_TREE) | call_edges(PACKAGE_DIR, TARGET_TREE,
                                                                 CLI_FUNCTIONS)
        self.assertEqual(sorted(set(EDGES) - set(made)), [])

    def test_every_mapped_cli_function_is_in_cli(self):
        """A function a move takes out of cli.py is dropped from CLI_FUNCTIONS."""
        defined = {node.name for node in ast.parse((PACKAGE_DIR / "cli.py").read_text()).body
                   if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        self.assertEqual(sorted(set(CLI_FUNCTIONS) - defined), [])

    def test_the_edges_are_listed_once_each_in_order(self):
        self.assertEqual(list(EDGES), sorted(set(EDGES)))


class CheckerTests(unittest.TestCase):
    """The checker over fixture packages written into a temporary directory."""

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
        self.assertEqual(self.found([("a", "b")]), [])
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

    def test_a_name_an_init_binds_on_every_path_is_an_export_not_a_module(self):
        self.write("features/a/user.py", "from lotuspod.features.b import inner\n")
        for init in ("from .inner import run as inner\n",
                     "from .inner import run\ninner, other = run, 0\n",
                     "try:\n    from .inner import run as inner\nexcept ImportError:\n    inner = None\n"):
            with self.subTest(init=init):
                self.write("features/b/__init__.py", init)
                self.assertEqual(self.found(), [])

    def test_a_name_an_init_may_leave_unbound_is_not_an_export(self):
        for init in ("from . import inner\ndel inner\n",
                     "inner = None\nif True:\n    del inner\n",
                     "import os\nif os.name:\n    inner = None\n",
                     "inner: object\n"):
            with self.subTest(init=init):
                self.write("features/b/__init__.py", init)
                self.assert_reported("features/a/user.py", "from lotuspod.features.b import inner\n",
                                     "lotuspod.features.b.inner")

    def test_a_name_an_init_only_indexes_or_reaches_is_not_an_export(self):
        self.write("features/b/__init__.py",
                   "registry = {}\nregistry[inner] = 1\nregistry.inner = 2\n[*rest] = [3]\n")
        self.assert_reported("features/a/user.py", "from lotuspod.features.b import inner\n",
                             "lotuspod.features.b.inner")
        self.assertEqual(exports(self.package, "lotuspod.features.b"), {"registry", "rest"})

    def test_call_edges_name_one_use_for_each(self):
        self.write("cli.py", """\
            from lotuspod import flat
            from lotuspod.flat_user import helper

            def serving():
                return flat.x, helper, owned()

            def owned():
                return flat.y

            def main():
                return serving()
            """)
        made = call_edges(self.package, {"flat": "a", "flat_user": "c"},
                          {"serving": "b", "owned": "a"})
        self.assertEqual(sorted(made), [("b", "a"), ("b", "c")])
        self.assertIn("lotuspod/cli.py:5: serving uses flat", made[("b", "a")])


if __name__ == "__main__":
    unittest.main()
