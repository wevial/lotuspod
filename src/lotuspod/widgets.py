"""Opaque-origin, self-contained live widgets and their source validation."""
from __future__ import annotations

import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shlex

THEME = Path(__file__).parent / '_theme'
WIDGET_NAME = re.compile(r'.+\.w-[0-9a-f]{12}\.html\Z')
HEADERS = (
    ('Content-Security-Policy', "sandbox allow-scripts; frame-ancestors 'self'"),
    ('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), payment=(), usb=()'),
    ('X-Content-Type-Options', 'nosniff'),
)


def variables() -> str:
    tokens = json.loads((THEME / 'tokens.json').read_text(encoding='utf-8'))
    singular = {'colors': 'color', 'fonts': 'font', 'radii': 'radius'}
    return ':root {\n' + ''.join(
        f'  --lotus-{singular.get(group, group)}-{name.replace("_", "-")}: {value};\n'
        for group, values in tokens.items() if isinstance(values, dict)
        for name, value in values.items()
    ) + '}\n'


def identifier(explicit: str, title: str, number: int) -> str:
    return explicit or re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-') or f'widget-{number}'


def fence(info: str, source: str, line: int, number: int) -> str:
    try:
        words = shlex.split(info)[2:]
    except ValueError as exc:
        raise RuntimeError(f'widget widget-{number} at line {line}: {exc}') from exc
    options = {}
    refused = []
    for word in words:
        key, sep, value = word.partition('=')
        if not sep or key not in {'id', 'title', 'height'} or key in options:
            refused.append(word)
        else:
            options[key] = value
    if refused:
        ident = identifier(options.get('id', ''), options.get('title', ''), number)
        raise RuntimeError(f'widget {ident} at line {line}: unknown option {refused[0]}; '
                           'libraries come with the next ticket; nothing written')
    attrs = ''.join(f' data-{key}="{html.escape(value)}"' for key, value in options.items())
    return f'<template class="lotuspod-live" data-line="{line}"{attrs}>{source}</template>'


class Templates(HTMLParser):
    def __init__(self, text: str):
        super().__init__(convert_charrefs=False)
        self.text = text
        self.offsets = [0, *(match.end() for match in re.finditer('\n', text))]
        self.blocks = []
        self.active = None
        self.depth = 0
        self.feed(text)
        if self.active:
            raise RuntimeError(f'widget at line {self.active[3]}: unclosed template')

    def position(self):
        line, col = self.getpos()
        return self.offsets[line - 1] + col

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'template':
            if self.active:
                self.depth += 1
            elif 'lotuspod-live' in (attrs.get('class') or '').split():
                start = self.position()
                self.active = (start, start + len(self.get_starttag_text()), attrs, self.getpos()[0])
                self.depth = 1

    def handle_endtag(self, tag):
        if tag == 'template' and self.active:
            self.depth -= 1
            if not self.depth:
                start, content, attrs, line = self.active
                end = self.text.index('>', self.position()) + 1
                self.blocks.append((start, end, attrs, self.text[content:self.position()], line))
                self.active = None


class Frames(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.sources = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'iframe' and 'artifact-widget' in (attrs.get('class') or '').split():
            self.sources.append(attrs.get('src', ''))


def render(body: str, name: str) -> tuple[str, dict[str, bytes], list[str]]:
    # Prepare every byte before the caller writes anything.
    from .cli import collect_scripts, script_hash
    files, warnings, ids, replacements = {}, [], set(), []
    total = 0
    for number, (start, end, attrs, source, line) in enumerate(Templates(body).blocks, 1):
        title = attrs.get('data-title') or ''
        ident = identifier(attrs.get('data-id') or '', title, number)
        line = attrs.get('data-line', line)
        label = f'widget {ident} at line {line}'
        def fail(reason):
            raise RuntimeError(f'{label}: {reason}; nothing written')
        unknown = set(attrs) - {'class', 'data-id', 'data-title', 'data-height', 'data-line'}
        if unknown:
            fail('unknown option ' + sorted(unknown)[0])
        if ident in ids:
            fail('duplicate id')
        ids.add(ident)
        size = len(source.encode('utf-8'))
        total += size
        if size > 256 * 1024:
            fail('source exceeds 256 KB')
        if total > 2 * 1024 * 1024:
            fail('page widgets exceed 2 MB')
        if number > 20:
            fail('more than 20 widgets')
        height = attrs.get('data-height')
        if 'data-height' in attrs and (height is None or not re.fullmatch(r'[0-9]+', height)
                                       or len(height.lstrip('0')) > 5 or int(height.lstrip('0') or '0') > 10000):
            fail('height must be a whole number from 0 to 10000')
        if not title:
            warnings.append(f'warning: {label} has no title')
        bridge = (THEME / 'widget-frame.js').read_text(encoding='utf-8')
        content = f'<script>{bridge}</script>' + source
        policy = "default-src 'none'; script-src " + ' '.join(script_hash(s) for s in collect_scripts(content).inline) + "; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"
        document = ('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' + html.escape(policy, quote=True) + '"><meta charset="utf-8"><style>' + variables() + 'body { margin: 0; font-family: var(--lotus-font-body); color: var(--lotus-type-ink); background: transparent; color-scheme: dark; }\n</style></head><body>' + content + '</body></html>\n').encode('utf-8')
        filename = f'{name}.w-{hashlib.sha256(document).hexdigest()[:12]}.html'
        files[filename] = document
        fixed = ' data-height-fixed="true"' if height is not None else ''
        frame = f'<iframe class="artifact-widget" src="{html.escape(filename)}" sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" loading="lazy" title="{html.escape(title or ident)}" data-widget="{html.escape(ident)}" height="{height or "360"}"{fixed}></iframe>'
        replacements.append((start, end, frame))
    for start, end, frame in reversed(replacements):
        body = body[:start] + frame + body[end:]
    return body, files, warnings


def without_templates(text: str) -> str:
    """Hide widget markup from source readers, preserving offsets and lines."""
    for start, end, _, _, _ in reversed(Templates(text).blocks):
        text = text[:start] + re.sub(r'[^\n]', ' ', text[start:end]) + text[end:]
    return text


if __name__ == '__main__':
    # Regenerate the checked-in page declarations after editing tokens.json:
    # PYTHONPATH=src python -m lotuspod.widgets
    stylesheet = THEME / 'css/widgets.css'
    styles = stylesheet.read_text(encoding='utf-8')
    stylesheet.write_text(variables() + styles[styles.index('}') + 2:], encoding='utf-8')
