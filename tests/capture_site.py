"""Capture fixture: a served sample site around one command.

Renders a fixed sample site with this checkout's own CLI into a fresh
temporary directory, serves it with the site's own allow-list server on
127.0.0.1 and a free port, runs the command it was given with the site's URL
in LOTUSPOD_URL, then stops the server, removes the directory and exits with
the command's code. The site trusts the test Access key
(tests/fixtures/access/), and LOTUSPOD_TEST_ASSERTION holds an assertion it
accepts, for a browser check to send as Cf-Access-Jwt-Assertion. Answers and
comments go to a database in the same temporary directory, beside the
rendered site and never in it. It never reads or writes the operator's
artifacts/ and never binds the tailnet address.

The site's agent socket listens in the same directory, as serve's does. The
database holds two machine credentials: `hermes` (pull, claim, reply and
publish as hermes), which the comments page and the owned page name as their
owner, and `claude-3f9a2c` (pull, claim and reply as itself). The owned page,
capture-owned, is published from markdown, so the site keeps its source
beside it. So is the images page, capture-images, from a source with the
fixture images (tests/fixtures/media/) beside it: its images are stored in
lotuspod-media/ beside the site, as publish stores them for serve. For an
agent command, the command's environment names:

    LOTUSPOD_TEST_SOCKET             the agent socket
    LOTUSPOD_TEST_CREDENTIAL_HERMES  hermes's credential file
    LOTUSPOD_TEST_CREDENTIAL_OTHER   claude-3f9a2c's credential file
    LOTUSPOD_TEST_OUT                the site's output directory
    LOTUSPOD_TEST_PYTHON             the Python running the fixture

Run from the repo root:

    python -m tests.capture_site COMMAND [ARG...]

The fixture always renders this checkout: the repo's src/ directory is put at
the front of sys.path, so an ambient lotuspod install (editable or not)
can never shadow the code under capture.
"""

from __future__ import annotations

import datetime
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import types
from contextlib import redirect_stdout
from functools import partial
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from lotuspod import access, cli, db, machine, routing  # noqa: E402
from tests import access_keys  # noqa: E402


HOST = "127.0.0.1"
URL_ENV = "LOTUSPOD_URL"
ASSERTION_ENV = "LOTUSPOD_TEST_ASSERTION"
SOCKET_ENV = "LOTUSPOD_TEST_SOCKET"
HERMES_ENV = "LOTUSPOD_TEST_CREDENTIAL_HERMES"
OTHER_ENV = "LOTUSPOD_TEST_CREDENTIAL_OTHER"
OUT_ENV = "LOTUSPOD_TEST_OUT"
PYTHON_ENV = "LOTUSPOD_TEST_PYTHON"
# How long the fixture's assertion stays valid: longer than any capture run.
ASSERTION_LIFETIME = 24 * 3600
# A fixed date, so every run renders the same bytes.
SAMPLE_DATE = "2026-01-01"
# The owner the comments and owned pages name, and its credential, which
# may also pull, claim and reply as it.
OWNER = "hermes"
OWNER_OPERATIONS = ("pull", "claim", "reply", "publish")
# Another agent's credential, bound to its own handle only.
OTHER = "claude-3f9a2c"
OTHER_OPERATIONS = ("pull", "claim", "reply")


class _SampleDay(datetime.date):
    @classmethod
    def today(cls) -> datetime.date:
        return cls.fromisoformat(SAMPLE_DATE)


def _sample_clock() -> types.ModuleType:
    """The datetime module as cli.py reads it, with today() held at SAMPLE_DATE.

    `index` has no --date: it stamps the page with date.today().
    """
    clock = types.ModuleType("datetime")
    clock.__dict__.update(vars(datetime))
    clock.date = _SampleDay
    return clock


# Only the diagram page has a mermaid block: its page loads Mermaid from
# jsDelivr, which a browser check answers from the copy pinned in e2e/.
ARTICLE_BODY = """\
<p>A sample article for captures: two sections.</p>
<h2>First section</h2>
<p>The outline links here.</p>
<h2>Second section</h2>
<p>Rendered with the article variant.</p>
"""

REPORT_BODY = """\
<p>A sample report for captures: the denser reading surface.</p>
<h2>Findings</h2>
<p>The outline sits in the left rail.</p>
<h2>Method</h2>
<p>Rendered with the report variant.</p>
"""

HIDDEN_BODY = "<p>A hidden page: rendered, never listed, never served.</p>\n"

DIAGRAM_BODY = """\
<p>A sample diagram, drawn by the pinned Mermaid under the page policy.</p>
<pre class="mermaid">graph LR
  A[Write] --> B[Publish] --> C[Read]</pre>
"""

# Every script here is refused by the page policy: the page shows
# "Nothing written." twice, before and after its button is pressed.
SCRIPTS_BODY = """\
<p>A sample page whose body holds scripts. None of them runs.</p>
<p id="inline-output">Nothing written.</p>
<script>document.getElementById("inline-output").textContent = "The inline script ran.";</script>
<script src="https://scripts.example.com/widget.js"></script>
<p><button type="button" onclick="document.getElementById('handler-output').textContent = 'The handler ran.'">Press me</button></p>
<p id="handler-output">Nothing written.</p>
"""

# A plan page ending in a decisions table: render makes each row a form the
# page script answers. No diagram, so the page needs no network.
DECISIONS_BODY = """\
<p>A sample plan for captures: two questions for the maintainer.</p>
<h2>Plan</h2>
<p>The responder needs a model, and the archive needs a rule.</p>
<h2>Decisions for the maintainer</h2>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th><th>Why it matters</th></tr></thead>
<tbody>
<tr><td>1</td><td>Which model replies?</td><td>Sonnet / Opus</td><td>Sonnet</td><td>Replies run on every comment.</td></tr>
<tr><td>2</td><td>Keep the archive?</td><td>Yes / No</td><td>Yes</td><td>Old pages stay linkable.</td></tr>
</tbody>
</table>
"""

# A plan page with a comment box ending each of its three sections, owned by
# OWNER. No diagram, so the page needs no network.
COMMENTS_BODY = """\
<p>A sample plan for captures: every section takes comments.</p>
<h2>Findings</h2>
<p>The pond freezes in January, and the pump stops with it.</p>
<h2>Risks</h2>
<p>A frozen pump may crack before anyone notices.</p>
<h2>Next steps</h2>
<p>Fit a heater before the first frost.</p>
"""

# The palette page: every element the palette colours, a section each, and a
# comment box ending each section, owned by OWNER. No diagram, so the page
# needs no network.
PALETTE_BODY = """\
<p>A sample page for captures: the palette on what a reader follows or copies.</p>
<h2>Links and code</h2>
<p>Read <a href="capture-article.html">the sample article</a>, then run <code>lotuspod publish</code> to put a page on the pond.</p>
<h2>Table</h2>
<table>
<thead><tr><th>Month</th><th>Pump hours</th><th>Water</th></tr></thead>
<tbody>
<tr><td>December</td><td>310</td><td>Cold</td></tr>
<tr><td>January</td><td>0</td><td>Frozen</td></tr>
</tbody>
</table>
<h2>Quote</h2>
<blockquote>
<p>A pond in winter keeps its fish alive under a lid of ice, so long as the pump does not crack.</p>
<cite>The pond keeper's notebook</cite>
</blockquote>
<h2>Code block</h2>
<pre><code>lotuspod publish plan.md --owner hermes
lotuspod comments pull --owner hermes</code></pre>
"""

# The owned page: published from markdown by OWNER, so its source is kept
# beside it and reaches OWNER's pull. Two sections, then one question.
OWNED_PAGE = "capture-owned"
OWNED_SOURCE = """\
# Capture owned page

A sample plan for captures, owned by hermes: two sections and one question.

## Pump

The pond pump stops when the water freezes.

## Heater

Fit a heater before the first frost.

## Decisions for the maintainer

| # | Question | Options | Default | Why it matters |
|---|---|---|---|---|
| 1 | Which heater? | Floating / Submerged | Floating | The pump shares its outlet. |
"""

# The images page: published from markdown, with the fixture images copied
# beside its source as IMAGES_FILES names them. A wide chart, then photos (a
# progressive JPEG and one turned by its EXIF orientation among them), then
# three kinds of WebP and a GIF.
IMAGES_PAGE = "capture-images"
MEDIA_FIXTURES = REPO_ROOT / "tests" / "fixtures" / "media"
IMAGES_FILES = {
    "chart.png": "chart-1600x600.png",
    "photos/fish.jpg": "fish-320x240.jpg",
    "photos/pond.jpg": "pond-progressive-300x200.jpg",
    "photos/turned.jpg": "turned-orientation6-160x96.jpg",
    "lilies/lossy.webp": "lily-lossy-240x160.webp",
    "lilies/lossless.webp": "lily-lossless-200x150.webp",
    "lilies/extended.webp": "lily-extended-180x120.webp",
    "frog.gif": "frog-140x100.gif",
}
IMAGES_SOURCE = """\
# Capture images

A sample page for captures: images published from markdown, each drawn at its
own size and never wider than the column.

## Chart

The pump's hours for each month of the year, drawn wider than the column.

![Pump hours per month](./chart.png)

## Photos

A fish in the pond, then the pond at dusk.

![A fish in the pond](photos/fish.jpg)
![The pond at dusk](photos/pond.jpg)

A photo its camera turned a quarter; the browser turns it back.

![A turned photo](photos/turned.jpg)

## Lilies and a frog

![A lily, lossy](lilies/lossy.webp)
![A lily, lossless](lilies/lossless.webp)
![A lily on clear water](lilies/extended.webp)

The frog that sits on them.

![A frog](frog.gif)
"""

SAMPLE_PAGES = (
    ("capture-article", "Capture article", ARTICLE_BODY, ()),
    ("capture-report", "Capture report", REPORT_BODY, ("--variant", "report")),
    ("capture-hidden", "Capture hidden", HIDDEN_BODY, ("--hidden",)),
    ("capture-diagram", "Capture diagram", DIAGRAM_BODY, ()),
    ("capture-scripts", "Capture body scripts", SCRIPTS_BODY, ()),
    ("capture-decisions", "Capture decisions", DECISIONS_BODY, ()),
    ("capture-comments", "Capture comments", COMMENTS_BODY,
     ("--comments", "--owner", OWNER)),
    ("capture-palette", "Capture palette", PALETTE_BODY,
     ("--comments", "--owner", OWNER)),
)


def credential_path(db_path: Path, name: str) -> Path:
    """The file the credential name's token is kept in, beside the database."""
    return db_path.with_name(f"{name}.token")


def render(out_dir: Path, db_path: Path) -> None:
    """Render the sample pages, publish the owned page and build the index
    into out_dir.

    Makes OWNER's and OTHER's credentials in the database at db_path first,
    their tokens beside the database. Calls the CLI in process, the same code
    the installed `lotuspod` command runs. Raises RuntimeError naming the
    step that failed.
    """
    database = db.Database(db_path)
    token = credential_path(db_path, OWNER)
    machine.create_credential(database, OWNER, [OWNER], list(OWNER_OPERATIONS), token)
    machine.create_credential(database, OTHER, [OTHER], list(OTHER_OPERATIONS),
                              credential_path(db_path, OTHER))
    source = db_path.with_name(f"{OWNED_PAGE}.md")
    source.write_text(OWNED_SOURCE, encoding="utf-8")
    images_source = db_path.with_name("images") / f"{IMAGES_PAGE}.md"
    for relative, fixture in IMAGES_FILES.items():
        (images_source.parent / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(MEDIA_FIXTURES / fixture, images_source.parent / relative)
    images_source.write_text(IMAGES_SOURCE, encoding="utf-8")
    steps = [
        (
            f"render {name}",
            [
                "render", "--name", name, "--title", title, "--body", body,
                "--date", SAMPLE_DATE, "--out-dir", str(out_dir),
                "--credential", str(token), "--db", str(db_path), *extra,
            ],
        )
        for name, title, body, extra in SAMPLE_PAGES
    ]
    steps.append((
        f"publish {OWNED_PAGE}",
        [
            "publish", str(source), "--local", "--date", SAMPLE_DATE,
            "--out-dir", str(out_dir), "--owner", OWNER,
            "--credential", str(token), "--db", str(db_path),
        ],
    ))
    steps.append((
        f"publish {IMAGES_PAGE}",
        [
            "publish", str(images_source), "--local", "--date", SAMPLE_DATE,
            "--out-dir", str(out_dir), "--variant", "article", "--no-comments",
        ],
    ))
    steps.append(("index", ["index", "--out-dir", str(out_dir)]))
    for step, argv in steps:
        # The CLI reports on stdout; keep that stream for COMMAND alone.
        with redirect_stdout(sys.stderr), mock.patch.object(cli, "_dt", _sample_clock()):
            try:
                rc = cli.main(argv)
            except SystemExit as exc:
                rc = exc.code if isinstance(exc.code, int) else 1
        if rc != 0:
            raise RuntimeError(f"{step} failed with exit code {rc}")


def main(argv: list[str] | None = None) -> int:
    command = list(sys.argv[1:] if argv is None else argv)
    if not command:
        print("usage: python -m tests.capture_site COMMAND [ARG...]", file=sys.stderr)
        return 2

    directory = Path(tempfile.mkdtemp(prefix="lotuspod-capture-"))
    site = directory / "site"
    db_path = directory / db.DEFAULT_NAME
    socket_path = directory / machine.SOCKET_NAME
    server = None
    thread = None
    sockets = None
    socket_thread = None
    try:
        try:
            site.mkdir()
            render(site, db_path)
        except Exception as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        verifier = access.Verifier(access.parse_config(access_keys.config_section()))
        server = cli._make_server(site, HOST, 0, verifier=verifier, db_path=db_path)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        # The agent socket as serve runs it: the same database and pages.
        sockets = machine.SocketServer(
            socket_path, db.Database(db_path), pages=partial(cli.api_page, site),
            describe=partial(cli.agent_page, site), window=routing.DEFAULT_WINDOW,
            claim_sec=routing.DEFAULT_CLAIM,
        )
        socket_thread = threading.Thread(target=sockets.serve_forever, daemon=True)
        socket_thread.start()
        env = dict(os.environ)
        env[URL_ENV] = f"http://{HOST}:{port}"
        env[ASSERTION_ENV] = access_keys.assertion(lifetime=ASSERTION_LIFETIME)
        env[SOCKET_ENV] = str(socket_path)
        env[HERMES_ENV] = str(credential_path(db_path, OWNER))
        env[OTHER_ENV] = str(credential_path(db_path, OTHER))
        env[OUT_ENV] = str(site)
        env[PYTHON_ENV] = sys.executable
        try:
            return subprocess.run(command, cwd=str(REPO_ROOT), env=env, check=False).returncode
        except OSError as exc:
            print(f"error: cannot run {command[0]}: {exc}", file=sys.stderr)
            return 1
    finally:
        if sockets is not None:
            if socket_thread is not None:
                sockets.shutdown()
            sockets.server_close()
        if server is not None:
            if thread is not None:
                server.shutdown()
            server.server_close()
        shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
