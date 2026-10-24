"""Agents: the machine credentials and serve's agent socket (machine.py), the
agents' pull, with `lotuspod comments` and `lotuspod inbox` (agents.py), the
default responder, with `lotuspod respond` (responder.py), and the routing of
readers' comments to one handle each (routing.py), with `lotuspod credential`
and `lotuspod audit` in commands.py."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "DEFAULT_CLAIM": "routing",
    "DEFAULT_WINDOW": "routing",
    "last_pulls": "routing",
    "public": "routing",
    "shown": "routing",
    "threads": "routing",
    "CREDENTIAL_ENV": "machine",
    "SOCKET_NAME": "machine",
    "SocketInUse": "machine",
    "SocketServer": "machine",
    "check_owner": "machine",
    "is_handle": "machine",
    "read_token": "machine",
    "configured_socket": "agents",
    "one_line": "agents",
    "printable": "agents",
})
