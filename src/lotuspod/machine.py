"""Agents on the writer host: machine credentials and serve's local socket.

An agent is never a reader, and being on the same machine is not an
identity. The operator makes each agent a credential with `lotuspod
credential create`, bound to the owner handles it may act as and the
operations it may do; its token goes to a file only its owner can read, and
the database keeps only the token's SHA-256.

serve listens on a Unix socket (mode 0600, removed when serve stops) beside
its port, and answers only /v1/ paths there, each for a bearer token of a
credential that exists and is not revoked:

    GET /v1/whoami                     the credential's name, handles, operations
    GET /v1/check?op=OP&handle=HANDLE  whether it may do OP as HANDLE

No socket route writes a reader's answer or comment, whatever the credential.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import http.server
import json
import os
import re
import secrets
import socket
import socketserver
import sqlite3
import stat
import urllib.parse
from email.message import Message
from http import HTTPStatus
from pathlib import Path
from typing import Mapping

from lotuspod import api, db

OPERATIONS = ("pull", "claim", "reply", "publish")
# An owner handle, and a credential's name: 1 to 63 lower-case letters,
# digits and hyphens, starting with a letter or digit.
_HANDLE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
SOCKET_NAME = "lotuspod.sock"
CREDENTIAL_ENV = "LOTUSPOD_CREDENTIAL"
TOKEN_BYTES = 32

WHOAMI = "/v1/whoami"
CHECK = "/v1/check"
ROUTES = (WHOAMI, CHECK)
METHODS = ("GET", "HEAD")
# Seconds a socket connection may sit idle.
REQUEST_TIMEOUT = 30

# Headers on every socket answer.
_HEADERS = (
    ("Content-Type", "application/json"),
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
)


class CredentialError(ValueError):
    """A credential that cannot be made, or a token file that cannot be read."""


class SocketInUse(RuntimeError):
    """Something already answers on the socket path, or it is not a socket."""


def is_handle(value: str) -> bool:
    return _HANDLE.fullmatch(value) is not None


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def create_credential(database: db.Database, name: str, handles: list[str],
                      operations: list[str], out: Path) -> dict:
    """Make the credential name, write its token to out (mode 0600, never
    over an existing file) and store it; CredentialError, with nothing
    stored and no file changed, when any part is not allowed."""
    if not is_handle(name):
        raise CredentialError(
            f"credential name {name!r} is not 1 to 63 lower-case letters, digits and "
            "hyphens starting with a letter or digit"
        )
    if not handles:
        raise CredentialError("a credential needs at least one --handle")
    if not operations:
        raise CredentialError("a credential needs at least one --op")
    for handle in handles:
        if not is_handle(handle):
            raise CredentialError(
                f"handle {handle!r} is not 1 to 63 lower-case letters, digits and "
                "hyphens starting with a letter or digit"
            )
    for operation in operations:
        if operation not in OPERATIONS:
            raise CredentialError(
                f"operation {operation!r} is not one of {', '.join(OPERATIONS)}"
            )
    token = secrets.token_urlsafe(TOKEN_BYTES)
    # The file is claimed before the database is opened: opening it may
    # migrate its schema, and a refused create changes nothing.
    try:
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise CredentialError(f"{out} already exists; not overwriting it") from None
    except OSError as exc:
        raise CredentialError(f"cannot write {out}: {exc.strerror}") from None
    try:
        with os.fdopen(fd, "w", encoding="ascii") as fh:
            os.fchmod(fh.fileno(), 0o600)
            fh.write(token + "\n")
        row = database.add_credential(
            name=name, handles=_unique(handles), operations=_unique(operations),
            token_hash=token_hash(token),
        )
    except BaseException as exc:
        os.unlink(out)
        if isinstance(exc, db.DuplicateCredential):
            raise CredentialError(f"a credential named {name!r} already exists") from None
        raise
    return public(row)


def public(credential: Mapping) -> dict:
    """What may be shown of a credential: everything but its token's hash."""
    return {key: value for key, value in credential.items() if key != "tokenHash"}


def find(database: db.Database, token: str) -> dict | None:
    """The unrevoked credential whose token this is; None when there is none."""
    digest = token_hash(token)
    found = None
    for credential in database.credentials():
        if hmac.compare_digest(credential["tokenHash"], digest):
            found = credential
    if found is None or found["revokedAt"] is not None:
        return None
    return found


def authorize(credential: Mapping, operation: str, handle: str) -> str | None:
    """The rule for every agent route: None when the credential may do
    operation on behalf of handle, else the refusal's error."""
    if handle not in credential["handles"]:
        return "handle_not_allowed"
    if operation not in credential["operations"]:
        return "operation_not_allowed"
    return None


def check_owner(database: db.Database, token: str, handle: str) -> dict:
    """The credential of token when it may publish as handle;
    CredentialError naming the problem when it may not."""
    credential = find(database, token)
    if credential is None:
        raise CredentialError("the credential is unknown or revoked")
    error = authorize(credential, "publish", handle)
    if error == "handle_not_allowed":
        raise CredentialError(
            f"credential {credential['name']} may not act as {handle} "
            f"(its handles: {', '.join(credential['handles'])})"
        )
    if error is not None:
        raise CredentialError(f"credential {credential['name']} may not publish")
    return credential


def bearer(headers: Message) -> str | None:
    """The token of the request's one Authorization: Bearer header."""
    values = headers.get_all("Authorization") or []
    if len(values) != 1:
        return None
    scheme, _, token = values[0].strip().partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        return None
    return token


class Routes:
    """The socket's routes over one database."""

    def __init__(self, database: db.Database) -> None:
        self.database = database

    def answer(self, method: str, target: str, headers: Message) -> api.Answer:
        """The answer to one request for target, a path and query."""
        token = bearer(headers)
        try:
            credential = None if token is None else find(self.database, token)
        except (sqlite3.Error, OSError):
            return HTTPStatus.SERVICE_UNAVAILABLE, {"error": "storage_unavailable"}, ()
        if credential is None:
            return HTTPStatus.UNAUTHORIZED, {"error": "invalid_credential"}, ()
        path, _, query = target.split("#", 1)[0].partition("?")
        if path not in ROUTES:
            return HTTPStatus.NOT_FOUND, {"error": "not_found"}, ()
        if method not in METHODS:
            return (HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"},
                    (("Allow", ", ".join(METHODS)),))
        if path == WHOAMI:
            return HTTPStatus.OK, {"credential": public(credential)}, ()
        fields = _query(query)
        if fields is None:
            return HTTPStatus.BAD_REQUEST, {"error": "invalid_query"}, ()
        error = authorize(credential, fields["op"], fields["handle"])
        if error is not None:
            return HTTPStatus.FORBIDDEN, {"error": error}, ()
        return HTTPStatus.OK, {"allowed": True, **fields}, ()


def _query(query: str) -> dict | None:
    """{op, handle} from a query naming each exactly once; None otherwise."""
    try:
        fields = urllib.parse.parse_qs(query, keep_blank_values=True,
                                       strict_parsing=bool(query), errors="strict")
    except (ValueError, UnicodeDecodeError):
        return None
    if sorted(fields) != ["handle", "op"] or any(len(v) != 1 for v in fields.values()):
        return None
    return {"op": fields["op"][0], "handle": fields["handle"][0]}


class _Handler(http.server.BaseHTTPRequestHandler):
    """Every request is answered in parse_request, before method dispatch,
    so every method meets the credential check."""

    server: SocketServer
    server_version = "lotuspod"
    timeout = REQUEST_TIMEOUT

    def address_string(self) -> str:
        # A Unix socket's peer has no address.
        return "socket"

    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        body = api.Body(self.rfile, self.connection, self.headers)
        status, payload, headers = self.server.routes.answer(
            self.command, self.path, self.headers
        )
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        for header, value in (*_HEADERS, *headers):
            self.send_header(header, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.wfile.flush()
        # Only once the answer is out: a body left unread would reset it.
        body.discard()
        return False


def clear_stale(path: Path) -> None:
    """Remove a socket file at path that nothing answers on; SocketInUse
    when something does, or when path is not a socket."""
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(mode):
        raise SocketInUse(f"{path} exists and is not a socket")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.connect(str(path))
    except ConnectionRefusedError:
        os.unlink(path)
        return
    except FileNotFoundError:
        return
    finally:
        probe.close()
    raise SocketInUse(f"something already answers on {path}")


class SocketServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """The socket's server: made with mode 0600, removed when closed."""

    daemon_threads = True

    def __init__(self, path: Path | str, database: db.Database) -> None:
        self.path = Path(path)
        self.routes = Routes(database)
        self._inode: int | None = None
        clear_stale(self.path)
        # Never, even briefly, readable or writable by anyone else.
        mask = os.umask(0o177)
        try:
            super().__init__(str(self.path), _Handler)
        finally:
            os.umask(mask)
        self._inode = os.lstat(self.path).st_ino

    def server_close(self) -> None:
        super().server_close()
        inode, self._inode = self._inode, None
        if inode is None:
            return
        try:
            found = os.lstat(self.path)
        except FileNotFoundError:
            return
        # Only the socket this server made, never one another serve made since.
        if found.st_ino == inode and stat.S_ISSOCK(found.st_mode):
            os.unlink(self.path)


def read_token(path: Path | str) -> str:
    """The token in a credential file; CredentialError when there is none."""
    try:
        text = Path(path).read_text(encoding="ascii")
    except (OSError, UnicodeDecodeError) as exc:
        raise CredentialError(f"cannot read credential {path}: {exc}") from None
    token = text.strip()
    if not token or len(token.split()) != 1:
        raise CredentialError(f"credential {path} does not hold one token")
    return token


class UnixConnection(http.client.HTTPConnection):
    """HTTP to serve's socket."""

    def __init__(self, path: Path | str, timeout: float = REQUEST_TIMEOUT) -> None:
        super().__init__("localhost", timeout=timeout)
        self.socket_path = str(path)

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self.socket_path)
        except OSError:
            sock.close()
            raise
        self.sock = sock


def request(path: Path | str, token: str | None, method: str, target: str,
            body: object = None) -> tuple[int, dict]:
    """(status, JSON payload) of one request on the socket at path."""
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    conn = UnixConnection(path)
    try:
        conn.request(method, target, body=data, headers=headers)
        response = conn.getresponse()
        payload = response.read()
    finally:
        conn.close()
    return response.status, json.loads(payload.decode("utf-8")) if payload else {}
