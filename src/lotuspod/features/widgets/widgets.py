"""Opaque-origin, self-contained live widgets and their source validation."""
from __future__ import annotations

import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shlex

from lotuspod.core import Templates, collect_scripts, html_title, normalized, script_hash
from lotuspod.features import comments
from lotuspod.features.widgets import libraries

THEME = Path(__file__).parent / 'ts'
TOKENS = Path(__file__).parents[2] / 'core' / 'theme' / 'tokens.json'
HEADERS = (
    ('Content-Security-Policy', "sandbox allow-scripts; frame-ancestors 'self'"),
    ('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), payment=(), usb=()'),
    ('X-Content-Type-Options', 'nosniff'),
)
# Every widget file answer, the file's or the framing page's, varies on
# whether the browser asked for a frame or a tab, so a kept answer of one
# kind is never given to the other.
VARY = ('Vary', 'Sec-Fetch-Dest')
# The framing page's headers: it runs nothing and frames only the site, so a
# widget opened alone meets frame-src 'self' as it does on its page.
ALONE_HEADERS = (
    ('Content-Security-Policy', "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    ('X-Content-Type-Options', 'nosniff'),
    ('Cache-Control', 'no-store'),
    VARY,
)
# The query key the framing page's frame adds to the widget's address: a
# frame may not load its ancestor's own address, and serve ignores the key.
ALONE_QUERY = 'alone'


def alone_page(filename: str, query: str = '') -> bytes:
    """The page answering a widget file opened in a tab: one sandboxed frame
    of the same file (query: its own, without the ?) filling the window. The
    frame's address is from the site's root: a tab's address may end in a /
    that serve ignores, and a relative one would resolve beneath it."""
    src = '/' + filename + '?' + (query + '&' if query else '') + ALONE_QUERY
    return ('<!doctype html><html><head><meta charset="utf-8">'
            f'<title>{html.escape(filename)}</title>'
            '<style>:root { color-scheme: dark; } html, body { margin: 0; height: 100%; } '
            'iframe { display: block; width: 100%; height: 100%; border: 0; }</style></head>'
            f'<body><iframe src="{html.escape(src)}" sandbox="allow-scripts" allow="" '
            'referrerpolicy="no-referrer"></iframe></body></html>').encode('utf-8')


def variables(attribute: str = 'data-lotus-theme') -> str:
    """The tokens as --lotus-* declarations: Night on :root, and the dawn set
    where attribute on the root names dawn, or the system is light and it
    names no night. A widget file keys them on data-lotus-theme, which its
    bridge sets from the page's message; the stylesheet on the page's
    data-theme."""
    tokens = json.loads(TOKENS.read_text(encoding='utf-8'))
    singular = {'colors': 'color', 'fonts': 'font', 'radii': 'radius'}

    def declarations(sets: dict, indent: str) -> str:
        return ''.join(
            f'{indent}--lotus-{singular.get(group, group)}-{name.replace("_", "-")}: {value};\n'
            for group, values in sets.items() if isinstance(values, dict) and group != 'dawn'
            for name, value in values.items()
        )
    return (':root {\n' + declarations(tokens, '  ') + '}\n'
            f':root[{attribute}="dawn"] {{\n' + declarations(tokens['dawn'], '  ') + '}\n'
            '@media (prefers-color-scheme: light) {\n'
            f'  :root:not([{attribute}="night"]) {{\n' + declarations(tokens['dawn'], '    ') + '  }\n}\n')


def identifier(explicit: str, title: str, number: int) -> str:
    return explicit or re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-') or f'widget-{number}'


def fence(info: str, source: str, line: int, number: int) -> str:
    try:
        lexer = shlex.shlex(info, posix=True)
        # Match Markdown's Unicode whitespace without changing quoted titles.
        lexer.whitespace += ''.join(char for char in set(info) if char.isspace())
        lexer.whitespace_split = True
        lexer.commenters = ''
        words = list(lexer)[2:]
    except ValueError as exc:
        raise RuntimeError(f'widget widget-{number} at line {line}: {exc}') from exc
    options = {}
    refused = []
    names = []
    for word in words:
        key, sep, value = word.partition('=')
        if not sep:
            names.append(word)
        elif key not in {'id', 'title', 'height'} or key in options:
            refused.append(word)
        else:
            options[key] = value
    if refused:
        ident = identifier(options.get('id', ''), options.get('title', ''), number)
        raise RuntimeError(f'widget {ident} at line {line}: unknown option {refused[0]}; '
                           'nothing written')
    try:
        libraries.resolve(names)
    except ValueError as exc:
        ident = identifier(options.get('id', ''), options.get('title', ''), number)
        raise RuntimeError(f'widget {ident} at line {line}: {exc}; nothing written') from exc
    if names:
        options['libs'] = ' '.join(names)
    attrs = ''.join(f' data-{key}="{html.escape(value)}"' for key, value in options.items())
    return f'<template class="lotuspod-live" data-line="{line}"{attrs}>{source}</template>'


class InlineScriptsOnly(HTMLParser):
    """Library widgets load external scripts only through generated SRI tags."""
    CDATA_CONTENT_ELEMENTS = Templates.CDATA_CONTENT_ELEMENTS

    def parse_html_declaration(self, i):
        # HTMLParser hides marked sections through ]]>, but in HTML a browser
        # treats <![CDATA[ as a bogus comment ending at the first >. Reject
        # these declarations rather than hiding potentially executable tags.
        # Check at the opener so incomplete marked sections are rejected too.
        if self.rawdata.startswith('<![', i):
            raise ValueError('CDATA and marked sections are not allowed in library widgets')
        return super().parse_html_declaration(i)

    def handle_starttag(self, tag, attrs):
        # SVG scripts use href (or the legacy xlink:href), bypassing the
        # generated library tag's integrity check just like an authored src.
        if tag == 'script' and any(key in {'src', 'href', 'xlink:href'} for key, _ in attrs):
            raise ValueError('external script tags are not allowed in library widgets; '
                             'declare libraries with live fence names or data-libs instead')


class Frames(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.sources = []
        # The serve allow list scans every visible page on each request. Most
        # pages have no frames: avoid parsing their entire body in that case.
        # This is only a prefilter; the parser still validates any candidates.
        if re.search(r'<iframe\b', text, re.IGNORECASE):
            self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'iframe' and 'artifact-widget' in (attrs.get('class') or '').split():
            self.sources.append(attrs.get('src', ''))


class PageWidgets(HTMLParser):
    """A served page's live blocks: each frame's data-widget id to its
    file's hash, its title and the data-section of the section wrapper it
    sits in (lotuspod.features.publish.sections). Outside every wrapper it
    is the id of the last h2 before it that starts a section, by
    comments._SectionFinder's rule (an h2 in a pre.mermaid or a form starts
    none), and has a comment box outside every template, as the page script
    finds it; "" when no such h2 comes before it. A frame inside a template or a noscript
    is inert, and not one of them, and a div or an h2 inside a template
    opens no section."""
    CDATA_CONTENT_ELEMENTS = Templates.CDATA_CONTENT_ELEMENTS

    def __init__(self, text: str):
        super().__init__()
        self.found: dict[str, tuple[str, str, str]] = {}
        self._section = None
        self._depth = 0
        self._templates = 0
        self._headings: list[str] = []
        self._boxes: set[str] = set()
        # Each frame outside every wrapper: the number of headings before it.
        self._outside: dict[str, int] = {}
        self._mermaid = 0
        self._forms = 0
        if re.search(r'<iframe\b', text, re.IGNORECASE):
            self.feed(text)
            self.close()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get('class') or '').split()
        if tag == 'template':
            self._templates += 1
        elif self._templates:
            return
        elif tag == 'pre' and (self._mermaid or 'mermaid' in classes):
            self._mermaid += 1
        elif tag == 'form' and not self._mermaid:
            self._forms += 1
        elif tag == 'h2' and not self._mermaid and not self._forms:
            self._headings.append(attrs.get('id') or '')
        elif tag == 'details' and comments.BOX_CLASS in classes:
            self._boxes.add(attrs.get('data-section') or '')
        elif tag == 'div':
            if self._section is not None:
                self._depth += 1
            elif 'artifact-section-body' in classes:
                self._section = attrs.get('data-section') or ''
                self._depth = 1
        elif tag == 'iframe' and 'artifact-widget' in classes and not self._templates:
            ident = attrs.get('data-widget') or ''
            named = re.search(r'\.w-([0-9a-f]{12})\.html\Z', attrs.get('src') or '')
            if ident and named and ident not in self.found:
                self.found[ident] = (named.group(1), attrs.get('title') or '', self._section or '')
                if self._section is None:
                    self._outside[ident] = len(self._headings)

    def close(self):
        super().close()
        # A box ends its section, after the frames in it: place them now.
        for ident, before in self._outside.items():
            section = next((heading for heading in reversed(self._headings[:before])
                            if heading and heading in self._boxes), '')
            hash_, title, _ = self.found[ident]
            self.found[ident] = (hash_, title, section)

    def handle_endtag(self, tag):
        if tag == 'template' and self._templates:
            self._templates -= 1
        elif self._templates:
            return
        elif tag == 'pre' and self._mermaid:
            self._mermaid -= 1
        elif tag == 'form' and self._forms and not self._mermaid:
            self._forms -= 1
        elif tag == 'div' and self._section is not None:
            self._depth -= 1
            if not self._depth:
                self._section = None


def block_source(source: str, markdown_source: bool, ident: str) -> str:
    """The lines of the live block ident as written in a page's kept source,
    markdown or HTML, found as publish finds it: its line endings made
    newlines, and an HTML source's first h1 left out; "" when it has none,
    or when the source no longer reads."""
    source = normalized(source)
    lines = source.split('\n')
    try:
        if markdown_source:
            from lotuspod.features import publish
            # Only where each block is matters, not how an image is drawn.
            sizes = {image.src: (0, 0) for image in publish.images(source)}
            body = publish.to_body(source, sizes)
        else:
            # Without its h1, as render() numbers the blocks; the h1's lines
            # are kept as empty lines, so every line stays where it was.
            body = html_title(source)[1]
        blocks = Templates(body).blocks
    except (RuntimeError, ValueError):
        return ''
    for number, (start, end, attrs, content, line) in enumerate(blocks, 1):
        if identifier(attrs.get('data-id') or '', attrs.get('data-title') or '', number) != ident:
            continue
        if markdown_source:
            # A fence's template keeps the line of its opening fence and its
            # code lines, one empty line for an empty fence; the closing
            # fence follows them. Markup written as a template has no line.
            if not attrs.get('data-line'):
                return ''
            first = int(attrs['data-line'])
            code = content.count('\n')
            if code == 1 and re.sub(r'^(?: {0,3}> ?)*', '', ''.join(lines[first:first + 1])).startswith('```'):
                code = 0
            return '\n'.join(lines[first - 1:first + code + 1])
        first = body.count('\n', 0, start)
        last = body.count('\n', 0, end)
        return '\n'.join(lines[first:last + 1])
    return ''


class DocumentHead(HTMLParser):
    """Locate structural tags without matching strings inside scripts/comments."""
    CDATA_CONTENT_ELEMENTS = Templates.CDATA_CONTENT_ELEMENTS

    def __init__(self, source):
        super().__init__()
        self.offsets = [0, *(m.end() for m in re.finditer('\n', source))]
        self.head = None
        self.html = None
        self.started = False
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        line, col = self.getpos()
        end = self.offsets[line - 1] + col + len(self.get_starttag_text())
        # A late head is ignored by HTML's parser. Treat that as an implicit
        # head so even malformed documents get the policy before any scripts.
        if tag == 'head' and not self.started:
            self.head = end
        if tag == 'html' and not self.started and self.html is None:
            self.html = end
        else:
            self.started = True

    def handle_data(self, data):
        # Only a BOM at byte zero is an encoding signature. Elsewhere it
        # is body text, just like non-ASCII whitespace.
        if self.getpos() == (1, 0):
            data = data.removeprefix('\ufeff')
        if data.strip(' \t\r\n\f'):
            self.started = True

    def handle_endtag(self, tag):
        self.started = True

    def handle_decl(self, decl):
        if not decl.lower().startswith('doctype '):
            self.started = True

    def unknown_decl(self, data):
        self.started = True

    def handle_pi(self, data):
        self.started = True


def render(body: str, name: str) -> tuple[str, dict[str, bytes], list[str]]:
    # Prepare every byte before the caller writes anything.
    files, warnings, ids, replacements = {}, [], set(), []
    total = 0
    for number, (start, end, attrs, source, line) in enumerate(Templates(body).blocks, 1):
        title = attrs.get('data-title') or ''
        ident = identifier(attrs.get('data-id') or '', title, number)
        line = attrs.get('data-line', line)
        label = f'widget {ident} at line {line}'
        def fail(reason):
            raise RuntimeError(f'{label}: {reason}; nothing written')
        unknown = set(attrs) - {'class', 'data-id', 'data-title', 'data-height', 'data-line', 'data-libs'}
        if unknown:
            fail('unknown option ' + sorted(unknown)[0])
        try:
            selected = libraries.resolve((attrs.get('data-libs') or '').split())
            if selected:
                InlineScriptsOnly().feed(source)
        except ValueError as exc:
            fail(str(exc))
        if ident in ids:
            fail('duplicate id')
        ids.add(ident)
        full = bool(re.match(r'\ufeff?[ \t\r\n\f]*(?:<!doctype\b|<html\b)', source, re.IGNORECASE))
        # The closing fence needs a newline separator outside the file budget.
        size = len((source.removesuffix('\n') if full else source).encode('utf-8'))
        total += size
        if size > (2 * 1024 * 1024 if full else 256 * 1024):
            fail('source exceeds 2 MB' if full else 'source exceeds 256 KB')
        if total > 2 * 1024 * 1024:
            fail('page widgets exceed 2 MB')
        if number > 20:
            fail('more than 20 widgets')
        height = attrs.get('data-height')
        if 'data-height' in attrs and height != 'full' and (height is None or not re.fullmatch(r'[0-9]+', height)
                                       or len(height.lstrip('0')) > 5 or int(height.lstrip('0') or '0') > 10000):
            fail('height must be full or a whole number from 0 to 10000')
        if not title:
            warnings.append(f'warning: {label} has no title')
        bridge = (THEME / 'widget-frame.js').read_text(encoding='utf-8')
        content = f'<script>{bridge}</script>' + source
        tags = ''.join(
            f'<script src="{library.url}" integrity="{library.integrity}" crossorigin="anonymous"></script>'
            for library in selected
        )
        script_sources = [script_hash(s) for s in collect_scripts(content).inline]
        script_sources.extend(library.url for library in selected)
        policy = "default-src 'none'; script-src " + ' '.join(script_sources) + "; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"
        head = ('<meta http-equiv="Content-Security-Policy" content="' + html.escape(policy, quote=True) + '">'
                '<meta charset="utf-8"><style>' + variables() +
                'body { margin: 0; font-family: var(--lotus-font-body); color: var(--lotus-type-ink); background: transparent; color-scheme: dark; }\n'
                ':root[data-lotus-theme="dawn"] body { color-scheme: light; }\n'
                '@media (prefers-color-scheme: light) {\n  :root:not([data-lotus-theme="night"]) body { color-scheme: light; }\n}\n</style>' + tags)
        if full:
            head += f'<script>{bridge}</script>'
            structure = DocumentHead(source)
            point = structure.head
            if point is None:
                point = structure.html
                if point is None:
                    declaration = re.match(r'\ufeff?[ \t\r\n\f]*<!doctype[^>]*>', source, re.IGNORECASE)
                    point = declaration.end() if declaration else 0
                head = '<head>' + head + '</head>'
            document = source[:point] + head + source[point:]
        else:
            document = '<!doctype html><html><head>' + head + '</head><body>' + content + '</body></html>\n'
        document = document.encode('utf-8')
        filename = f'{name}.w-{hashlib.sha256(document).hexdigest()[:12]}.html'
        files[filename] = document
        fixed = ' data-height-fixed="true"' if height is not None and height != 'full' else (' data-height-full="true"' if height == 'full' else '')
        frame = f'<iframe class="artifact-widget" src="{html.escape(filename)}" sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" loading="lazy" title="{html.escape(title or ident)}" data-widget="{html.escape(ident)}" height="{height if height and height != "full" else "360"}"{fixed}></iframe>'
        chrome = (f'<div class="artifact-live-chrome"><span class="artifact-live-title">{html.escape(title or ident)}</span>'
                  '<span class="artifact-live-badge">loading</span>'
                  f'<a class="artifact-live-open" href="{html.escape(filename)}" target="_blank" rel="noopener noreferrer">Open alone</a></div>')
        note = ('<p class="artifact-live-note">Sandboxed: this block can&#39;t see the page or your comments</p>'
                if number == 1 else '')
        replacements.append((start, end, f'<figure class="artifact-live" data-widget="{html.escape(ident)}">{chrome}{note}{frame}</figure>'))
    for start, end, frame in reversed(replacements):
        body = body[:start] + frame + body[end:]
    return body, files, warnings


class AboutForms(HTMLParser):
    """The decision forms about a live block (lotuspod.decisions), in page
    order: each data-about id to its forms' data-question ids. A form inside
    a template or a noscript is inert, and not one of them."""
    CDATA_CONTENT_ELEMENTS = Templates.CDATA_CONTENT_ELEMENTS

    def __init__(self, text: str):
        super().__init__()
        self.found: dict[str, list[str]] = {}
        self._templates = 0
        if 'data-about=' in text:
            self.feed(text)
            self.close()

    def handle_endtag(self, tag):
        if tag == 'template' and self._templates:
            self._templates -= 1

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'template':
            self._templates += 1
        elif (not self._templates and tag == 'form' and 'artifact-decision' in (attrs.get('class') or '').split()
                and attrs.get('data-about') and attrs.get('data-question')):
            self.found.setdefault(attrs['data-about'], []).append(attrs['data-question'])


def link_decisions(body: str) -> str:
    """The body with a link in the chrome of each live block that decision
    forms are about: "N decisions", to the first of them as #question=ID.
    Run after lotuspod.decisions, on the figures render() drew."""
    for ident, questions in AboutForms(body).found.items():
        head = f'<figure class="artifact-live" data-widget="{html.escape(ident)}"><div class="artifact-live-chrome">'
        start = body.find(head)
        if start < 0:
            continue
        # The chrome holds no div: its first end tag closes it.
        end = body.index('</div>', start + len(head))
        count = len(questions)
        link = (f'<a class="artifact-live-decisions" href="#question={html.escape(questions[0])}">'
                f'{count} {"decision" if count == 1 else "decisions"}</a>')
        body = body[:end] + link + body[end:]
    return body


if __name__ == '__main__':
    # Regenerate the checked-in page declarations after editing core/theme/tokens.json:
    # PYTHONPATH=src python -m lotuspod.features.widgets.widgets
    stylesheet = Path(__file__).parent / 'theme' / 'widgets.css'
    styles = stylesheet.read_text(encoding='utf-8')
    # The generated declarations hold no blank line: the rules start after
    # the first one.
    stylesheet.write_text(variables('data-theme') + styles[styles.index('\n\n') + 1:], encoding='utf-8')
