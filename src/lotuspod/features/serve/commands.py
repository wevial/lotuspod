"""The serve slice's commands: `lotuspod serve`, which answers the artifacts
directory's allow-listed pages over HTTP (lotuspod.features.serve.handler)
and agents on its Unix socket."""

from __future__ import annotations

import argparse
import signal
import sys
import threading
from functools import partial
from pathlib import Path

from lotuspod.features.agents import machine, routing
from lotuspod.features.agents.agents import configured_socket
from lotuspod.core import (DEFAULT_OUTPUT_DIR, INDEX_FILE, ConfigError, config_path,
                           config_section, sync_theme_css)
from lotuspod.features.publish import media
from lotuspod.features.publish.publish_sources import media_cap
from lotuspod.features.serve import access
from lotuspod.features.serve.handler import _make_server
from lotuspod.features.serve.pages import agent_page, api_catalog, api_page
from lotuspod.features.serve.serve_files import serve_db_path
from lotuspod.store import db


DEFAULT_SERVE_PORT = 8000
DEFAULT_SERVE_HOST = "127.0.0.1"


def access_verifier() -> access.Verifier | None:
    """The Access verifier the config's [access] section describes; None
    when there is no such section."""
    section = config_section("access")
    if section is None:
        return None
    try:
        return access.Verifier(access.parse_config(section))
    except ValueError as exc:
        raise ConfigError(f"config {config_path()}: {exc}") from None


def resolve_serve_host(host_override: str) -> str:
    """Explicit --host wins; otherwise loopback, reachable from this machine only."""
    return host_override if host_override else DEFAULT_SERVE_HOST


def serve_socket_path(db_path: Path, socket_arg: str) -> Path:
    """The agent socket serve listens on: --socket, else the config's
    [agents] socket, else lotuspod.sock beside the database."""
    if socket_arg:
        return Path(socket_arg)
    return configured_socket() or db_path.parent / machine.SOCKET_NAME


def owner_window(arg: int | None) -> int:
    """Routing's owner window in seconds: --owner-window, else the config's
    [comments] owner_window_sec, else the default."""
    if arg is not None:
        value, label = str(arg), "--owner-window"
    else:
        value = (config_section("comments") or {}).get("owner_window_sec", "")
        label = f"config {config_path()} [comments] owner_window_sec"
        if not value:
            return routing.DEFAULT_WINDOW
    if not value.isdigit() or int(value) < 1:
        raise ConfigError(f"{label} {value!r} is not a whole number of seconds, 1 or more")
    return int(value)


def claim_seconds() -> int:
    """How long an agent's claim lasts, in seconds: the config's [comments]
    claim_sec, else the default."""
    value = (config_section("comments") or {}).get("claim_sec", "")
    if not value:
        return routing.DEFAULT_CLAIM
    if not value.isdigit() or int(value) < 1:
        raise ConfigError(f"config {config_path()} [comments] claim_sec {value!r} is not "
                          "a whole number of seconds, 1 or more")
    return int(value)


def cmd_serve(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")
    # A deploy restarts serve, so a theme change goes live without waiting
    # for the next publish; that publish commits the rewritten files.
    sync_theme_css(out_dir)

    try:
        db_path = serve_db_path(out_dir, args.db)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    socket_path = serve_socket_path(db_path, args.socket)
    window = owner_window(args.owner_window)
    claim_sec = claim_seconds()
    image_cap = media_cap()
    host = resolve_serve_host(args.host)
    verifier = access_verifier()

    try:
        server = _make_server(out_dir, host, args.port, verifier=verifier, db_path=db_path,
                              window=window, max_image_bytes=image_cap)
    except OSError as exc:
        print(f"error: cannot bind {host}:{args.port}: {exc}", file=sys.stderr)
        return 1
    try:
        sockets = machine.SocketServer(
            socket_path, db.Database(db_path), pages=partial(api_page, out_dir),
            catalog=partial(api_catalog, out_dir),
            describe=partial(agent_page, out_dir), window=window, claim_sec=claim_sec,
            media_dir=media.media_dir(out_dir), max_image_bytes=image_cap,
            changed=server.events.changed,
        )
    except (OSError, machine.SocketInUse) as exc:
        server.server_close()
        print(f"error: cannot listen on {socket_path}: {exc}", file=sys.stderr)
        return 1

    if not (out_dir / INDEX_FILE).exists():
        print(f"note: no {INDEX_FILE} yet; run `lotuspod index` to build one")
    print(f"serving {out_dir} on {host} (v2 allow-list):")
    print(f"  http://{host}:{args.port}/")
    print(f"answers and comments in {db_path}")
    print(f"agents on {socket_path}")
    if verifier is None:
        print("note: no [access] section in the config; /api answers 503")
    print("ctrl-c to stop")
    # SIGTERM (systemd's stop) ends serve as ctrl-c does, so the socket is
    # removed either way. Only the main thread may set a handler.
    on_main = threading.current_thread() is threading.main_thread()
    if on_main:
        previous = signal.signal(signal.SIGTERM, _stop_serving)
    socket_thread = threading.Thread(target=sockets.serve_forever, daemon=True)
    socket_thread.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if on_main:
            # A second SIGTERM must not cut the cleanup short.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
        server.events.close()
        sockets.shutdown()
        socket_thread.join()
        sockets.server_close()
        server.server_close()
        if on_main:
            signal.signal(signal.SIGTERM, previous)
    return 0


def _stop_serving(signum: int, frame: object) -> None:
    raise KeyboardInterrupt


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod serve`."""
    serve = sub.add_parser(
        "serve",
        help="serve the artifacts directory (v2: allow-list enforced)",
    )
    serve.add_argument("--out-dir", default="", help="artifacts directory (default: artifacts/)")
    serve.add_argument(
        "--port", type=int, default=DEFAULT_SERVE_PORT, help=f"TCP port (default: {DEFAULT_SERVE_PORT})"
    )
    serve.add_argument(
        "--host",
        default="",
        help=f"bind address (default: {DEFAULT_SERVE_HOST}); pass a tailnet or LAN "
        "address to share beyond this machine",
    )
    serve.add_argument(
        "--db",
        default="",
        metavar="PATH",
        help=f"database of answers and comments (default: {db.DEFAULT_NAME} beside "
        "the artifacts directory; never inside it)",
    )
    serve.add_argument(
        "--socket",
        default="",
        metavar="PATH",
        help="Unix socket agents reach serve on (default: the config's [agents] "
        f"socket, else {machine.SOCKET_NAME} beside the database)",
    )
    serve.add_argument(
        "--owner-window",
        type=int,
        default=None,
        metavar="SECONDS",
        help="how long a pull keeps a handle listening, and a listening page owner "
        "holds a comment before the responder gets it (default: the config's "
        f"[comments] owner_window_sec, else {routing.DEFAULT_WINDOW})",
    )
    serve.set_defaults(func=cmd_serve)


# This slice's subcommands by slot, the order `lotuspod --help` lists them in.
COMMANDS = (
    (40, add_parser),
)
