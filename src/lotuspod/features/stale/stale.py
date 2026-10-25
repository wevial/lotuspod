"""Pages a pull request has overtaken: the GitHub pull requests each page
links, their states as last looked up, kept in lotuspod-pulls.json beside
serve's database, and the verdict made from those states and each page's
updated stamp.

Nothing here reaches the network but look_up() and check(), which only
`lotuspod pages stale --check` calls; the verdict reads the stored states
alone, so serve can draw it while answering a page.
"""

from __future__ import annotations

import datetime as _dt
import http.client
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

from lotuspod.core import MANIFEST_FILE, _utc_stamp, is_page_name, write_atomic
from lotuspod.features import history, serve

STATES_FILE = "lotuspod-pulls.json"
API_ENV = "LOTUSPOD_GITHUB_API"
DEFAULT_API = "https://api.github.com"
TOKEN_ENV = "GITHUB_TOKEN"
TIMEOUT = 10
DEFAULT_EVERY = 15

# A pull request number longer than this is no link, and never reaches int().
NUMBER_DIGITS = 18

OPEN, MERGED, CLOSED, UNKNOWN = "open", "merged", "closed", "unknown"
STATES = (OPEN, MERGED, CLOSED, UNKNOWN)

PULL_URL = re.compile(
    r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([0-9]{1,%d})(?:[/?#].*)?"
    % NUMBER_DIGITS,
    re.DOTALL,
)
PULL_KEY = re.compile(r"([a-z0-9_.-]+)/([a-z0-9_.-]+)#([0-9]{1,%d})" % NUMBER_DIGITS)


class _Hrefs(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.hrefs += [value for name, value in attrs if name == "href" and value]


def page_pulls(page_html: str) -> list[str]:
    """The pull requests a page's hrefs link, each keyed owner/repo#N, owner
    and repo lower-cased, once however often it is linked, in pull_order."""
    parser = _Hrefs()
    parser.feed(page_html)
    parser.close()
    found = set()
    for href in parser.hrefs:
        match = PULL_URL.fullmatch(href.strip())
        if match:
            owner, repo, number = match.groups()
            found.add(f"{owner.lower()}/{repo.lower()}#{int(number)}")
    return sorted(found, key=pull_order)


def pull_order(key: str) -> tuple[str, int]:
    repo, _, number = key.partition("#")
    return repo, int(number)


def pull_url(key: str) -> str:
    repo, _, number = key.partition("#")
    return f"https://github.com/{repo}/pull/{number}"


def states_path(db_path: Path) -> Path:
    """The states file beside serve's database, never in the output directory."""
    return db_path.parent / STATES_FILE


def parse_time(stamp: object) -> _dt.datetime | None:
    """An ISO 8601 stamp as an aware UTC time (a bare date is its midnight);
    None when it is not one."""
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        moment = _dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_dt.timezone.utc)
    return moment.astimezone(_dt.timezone.utc)


def read_states(path: Path) -> dict[str, dict]:
    """The stored states by pull request, {state, at, checked}; a missing or
    unreadable file, or an entry that is not one, reads as no state."""
    try:
        pulls = json.loads(path.read_text(encoding="utf-8"))["pulls"]
    except (OSError, UnicodeDecodeError, ValueError, KeyError, TypeError):
        return {}
    if not isinstance(pulls, dict):
        return {}
    states = {}
    for key, entry in pulls.items():
        if (isinstance(key, str) and PULL_KEY.fullmatch(key) and isinstance(entry, dict)
                and entry.get("state") in STATES):
            at = entry.get("at")
            states[key] = {"state": entry["state"],
                           "at": at if parse_time(at) else None,
                           "checked": entry.get("checked") if parse_time(entry.get("checked"))
                           else None}
    return states


def write_states(path: Path, states: dict[str, dict]) -> None:
    """The whole file, renamed over the old one, so no reader sees half."""
    pulls = {key: states[key] for key in sorted(states, key=pull_order)}
    write_atomic(path, (json.dumps({"pulls": pulls}, indent=2) + "\n").encode("utf-8"))


def overtaken(updated: str, pulls: list[str],
              states: dict[str, dict]) -> tuple[list[str], list[str]]:
    """The pull requests, of those a page links, stored merged and closed at a
    time later than the page's updated stamp; two empty lists when the page
    is current or its stamp cannot be read."""
    since = parse_time(updated)
    merged: list[str] = []
    closed: list[str] = []
    if since is None:
        return merged, closed
    for key in pulls:
        entry = states.get(key)
        at = parse_time(entry["at"]) if entry else None
        if at is not None and at > since:
            if entry["state"] == MERGED:
                merged.append(key)
            elif entry["state"] == CLOSED:
                closed.append(key)
    return merged, closed


def listed_pages(out_dir: Path) -> list[dict]:
    """Each page serve answers that the manifest lists and that is not
    archived: {page, title, updated, pulls}."""
    try:
        artifacts = json.loads((out_dir / MANIFEST_FILE).read_text(encoding="utf-8"))["artifacts"]
    except (OSError, UnicodeDecodeError, ValueError, KeyError, TypeError):
        return []
    if not isinstance(artifacts, list):
        return []
    allowed = serve.serve_allow_list(out_dir)
    pages = []
    for meta in artifacts:
        if not isinstance(meta, dict):
            continue
        file = meta.get("file")
        if not isinstance(file, str) or file not in allowed or not is_page_name(file):
            continue
        name = file[:-len(".html")]
        if history.is_archived(out_dir, name):
            continue
        try:
            text = (out_dir / file).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        pages.append({"page": name, "title": str(meta.get("title") or ""),
                      "updated": str(meta.get("updated") or ""), "pulls": page_pulls(text)})
    return pages


class LookupStopped(Exception):
    """A lookup that tells nothing about its pull request: the check stops."""


def look_up(api: str, key: str, token: str) -> tuple[str, str | None]:
    """The pull request's state and its merge or close time, from the API."""
    repo, _, number = key.partition("#")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "lotuspod"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{api}/repos/{repo}/pulls/{number}", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            found = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return UNKNOWN, None
        raise LookupStopped(f"{key}: HTTP {error.code} {error.reason}") from None
    except (TimeoutError, socket.timeout):
        raise LookupStopped(f"{key}: timed out") from None
    except urllib.error.URLError as error:
        raise LookupStopped(f"{key}: {error.reason}") from None
    except (OSError, http.client.HTTPException, UnicodeDecodeError, ValueError) as error:
        raise LookupStopped(f"{key}: {error}") from None
    if not isinstance(found, dict):
        raise LookupStopped(f"{key}: the answer is not a pull request")
    if parse_time(found.get("merged_at")):
        return MERGED, _utc_stamp(parse_time(found["merged_at"]))
    if found.get("state") == "closed":
        closed_at = parse_time(found.get("closed_at"))
        return CLOSED, _utc_stamp(closed_at) if closed_at else None
    if found.get("state") == "open":
        return OPEN, None
    raise LookupStopped(f"{key}: the answer names no state")


def due(pulls: list[str], states: dict[str, dict], every: int,
        now: _dt.datetime) -> list[str]:
    """The pull requests to look up: never one stored merged, and any other
    only when it was never checked or was checked every minutes ago or more."""
    found = []
    for key in sorted(set(pulls), key=pull_order):
        entry = states.get(key)
        if entry is None:
            found.append(key)
            continue
        if entry["state"] == MERGED:
            continue
        checked = parse_time(entry["checked"])
        if checked is None or now - checked >= _dt.timedelta(minutes=every):
            found.append(key)
    return found


def check(pulls: list[str], states: dict[str, dict], every: int, path: Path) -> dict[str, dict]:
    """Look up each pull request due, keep every state learned in the file at
    path, and on the first failed lookup stop, saying so on standard error."""
    api = (os.environ.get(API_ENV) or DEFAULT_API).rstrip("/")
    token = os.environ.get(TOKEN_ENV, "")
    todo = due(pulls, states, every, _dt.datetime.now(_dt.timezone.utc))
    states = dict(states)
    learned = 0
    for key in todo:
        try:
            state, at = look_up(api, key, token)
        except LookupStopped as stop:
            print(f"pages stale: stopped looking up: {stop}; "
                  f"{len(todo) - learned} of {len(todo)} pull requests not checked",
                  file=sys.stderr)
            break
        states[key] = {"state": state, "at": at,
                       "checked": _utc_stamp(_dt.datetime.now(_dt.timezone.utc))}
        learned += 1
    if learned:
        # Another check may have written the file since it was read: keep
        # its states and lay only the ones learned here over them.
        write_states(path, {**read_states(path), **{key: states[key] for key in todo[:learned]}})
    return states


def report(pages: list[dict], states: dict[str, dict]) -> dict:
    """The pages out of date, oldest updated first, and how many linked pull
    requests have no stored state."""
    found = []
    for page in sorted(pages, key=lambda page: (page["updated"], page["page"])):
        merged, closed = overtaken(page["updated"], page["pulls"], states)
        if merged or closed:
            found.append({
                "page": page["page"], "title": page["title"], "updated": page["updated"],
                "merged": [{"pull": key, "url": pull_url(key), "at": states[key]["at"]}
                           for key in merged],
                "closed": [{"pull": key, "url": pull_url(key), "at": states[key]["at"]}
                           for key in closed],
            })
    linked = {key for page in pages for key in page["pulls"]}
    return {"pages": found, "unchecked": sum(1 for key in linked if key not in states)}


def text_lines(found: dict) -> list[str]:
    if not found["pages"]:
        return ["no page is out of date"]
    lines = []
    for page in found["pages"]:
        counts = [f"{len(page[kind])} {kind}" for kind in ("merged", "closed") if page[kind]]
        pulls = [entry["pull"] for kind in ("merged", "closed") for entry in page[kind]]
        lines.append(f"{page['page']}  updated {page['updated']}  {', '.join(counts)} since: "
                     + ", ".join(pulls))
    return lines


def stale(out_dir: Path, db_path: Path, run_check: bool, every: int, as_json: bool) -> int:
    path = states_path(db_path)
    pages = listed_pages(out_dir)
    states = read_states(path)
    if run_check:
        states = check([key for page in pages for key in page["pulls"]], states, every, path)
    found = report(pages, states)
    if as_json:
        print(json.dumps(found, indent=2))
    else:
        print("\n".join(text_lines(found)))
    return 0
