"""Render a calltree fence as static, escaped HTML."""

import html
import re
from urllib.parse import quote

_LINE = re.compile(r"(?:([+~])\s+)?(\S+)\s+(\S+):(\d+)\s*$")
_PREFIX = re.compile(r"^[│├└─ ]*")
_REPO = re.compile(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+")
_SHA = re.compile(r"[A-Fa-f0-9]{7,40}")


def render(lines: list[str], info: list[str]) -> str:
    """Draw raw fence lines; malformed lines remain visible text, never parents."""
    options = dict(word.split("=", 1) for word in info if "=" in word)
    repo, sha = options.get("repo", ""), options.get("sha", "")
    linked = bool(_REPO.fullmatch(repo) and _SHA.fullmatch(sha))
    rows, stack, roots = [], [], []
    counts = {"new": 0, "changed": 0}
    paths = set()
    for line in lines:
        if not line.strip():
            continue
        prefix = _PREFIX.match(line).group()
        match = _LINE.fullmatch(line, len(prefix))
        if not match:
            # The greedy guide prefix may have swallowed a guide-only name.
            # Its last non-space character is the regex's first possible
            # fallback name. Earlier starts cannot change whether the remaining
            # path parses, so try just this one to avoid quadratic backtracking.
            name_start = len(prefix.rstrip(' ')) - 1
            if name_start >= 0:
                match = _LINE.fullmatch(line, name_start)
                if match:
                    prefix = prefix[:name_start]
        # Round three-column steps and cap jumps at one below the last parsed
        # row. Malformed lines never supply parents or move that cap.
        depth = min((len(prefix) + 1) // 3, len(stack))
        if not match:
            rows.append({"depth": depth, "text": line.rstrip()})
            continue
        marker, name, path, number = match.groups()
        kind = {"+": "new", "~": "changed"}.get(marker, "context")
        if kind in counts:
            counts[kind] += 1
        paths.add(path)
        stack = stack[:depth]
        siblings = stack[-1]["children"] if stack else roots
        row = dict(depth=depth, marker=marker, name=name, path=path,
                   number=number, kind=kind, children=[], ancestors=stack[:], siblings=siblings)
        siblings.append(row)
        stack.append(row)
        rows.append(row)

    files = len(paths)
    out = ['<div class="calltree"><div class="calltree-head">',
           '<span class="calltree-summary">',
           f'<span class="calltree-changed">{counts["changed"]} changed</span> · ',
           f'<span class="calltree-new">{counts["new"]} new</span> · across ',
           f'{files} {"file" if files == 1 else "files"}</span>',
           '<span class="calltree-legend"><span class="calltree-new">+ new</span> · ',
           '<span class="calltree-changed">~ changed</span> · dimmed = context</span>',
           '</div><div class="calltree-rows">']
    for row in rows:
        depth = row["depth"]
        if "text" in row:
            out.append(f'<div class="calltree-row" data-depth="{depth}" data-kind="text">'
                       f'<span class="calltree-tree">{html.escape(row["text"])}</span></div>')
            continue
        guide = ""
        if depth:
            guide = "".join("   " if a["siblings"][-1] is a else "│  "
                            for a in row["ancestors"][1:])
            guide += "└─ " if row["siblings"][-1] is row else "├─ "
        kind, path, number = row["kind"], row["path"], row["number"]
        mark = (f'<span aria-hidden="true">{row["marker"]}</span>'
                f'<span class="calltree-sr">{kind} </span>') if row["marker"] else " "
        title = html.escape(f"{path}:{number}")
        chip = f'{html.escape(path.rsplit("/", 1)[-1])}<span class="calltree-ln">:{number}</span>'
        attrs = f'class="calltree-chip" title="{title}"'
        if linked:
            url = html.escape(f"https://github.com/{repo}/blob/{sha}/{quote(path, safe='/')}#L{number}")
            chip = f'<a {attrs} href="{url}">{chip}</a>'
        else:
            chip = f'<span {attrs}>{chip}</span>'
        out.append(f'<div class="calltree-row" data-depth="{depth}" data-kind="{kind}">'
                   f'<span class="calltree-tree"><span class="calltree-guide">{guide}</span>'
                   f'<span class="calltree-mark">{mark}</span>'
                   f'<span class="calltree-name">{html.escape(row["name"])}</span></span>{chip}</div>')
    out.append('</div></div>')
    return "".join(out)
