"""Convert the handoff markdown (headings, paragraphs, nested lists, tables,
blockquotes, code spans, fenced code blocks, bold) into the lotuspod body HTML;
everything from '## Concrete commands' on is left out of the published page."""
import re, html, sys, pathlib
def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    return re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', t)
ITEM = re.compile(r'^( *)(-|\d+\.) (.*)$')
QUOTE = re.compile(r'^ {0,3}>')
def render_list(block):
    """`block`'s lines as nested <ul>/<ol>: an item indented deeper than the
    one above it opens a list inside that item."""
    root = {'children': []}
    stack = [(-1, root)]  # (indent, node); a node's children are its items
    for line in block:
        m = ITEM.match(line)
        if not m:  # an indented continuation of the last item
            stack[-1][1]['text'] += ' ' + line.strip(); continue
        indent, marker, text = len(m.group(1)), m.group(2), m.group(3)
        while len(stack) > 1 and stack[-1][0] >= indent: stack.pop()
        item = {'text': text, 'ordered': marker[0].isdigit(), 'children': []}
        stack[-1][1]['children'].append(item)
        stack.append((indent, item))
    def emit(items):
        if not items: return ''
        tag = 'ol' if items[0]['ordered'] else 'ul'
        return (f'<{tag}>' + ''.join(f"<li>{inline(x['text'])}{emit(x['children'])}</li>"
                                    for x in items) + f'</{tag}>')
    return emit(root['children'])
def convert(lines):
    """Body HTML blocks for markdown `lines`; a blockquote's inner lines go
    through the same conversion, so code blocks, lists and tables work inside."""
    out, i = [], 0
    while i < len(lines):
        l = lines[i]
        if l.startswith('# '): i += 1; continue
        if QUOTE.match(l):
            inner = []
            while i < len(lines) and QUOTE.match(lines[i]):
                inner.append(re.sub(r'^ {0,3}> ?', '', lines[i])); i += 1
            out.append('<blockquote>' + '\n'.join(convert(inner)) + '</blockquote>'); continue
        if l.startswith('```'):
            lang = l[3:].strip()
            code, i = [], i + 1
            while i < len(lines) and not lines[i].startswith('```'):
                code.append(lines[i]); i += 1
            i += 1  # the closing fence
            if lang == 'mermaid':
                out.append('<pre class="mermaid">' + html.escape('\n'.join(code), quote=False) + '</pre>'); continue
            out.append('<pre><code>' + html.escape('\n'.join(code), quote=False) + '</code></pre>'); continue
        if l.startswith('## '): out.append(f'<h2>{inline(l[3:])}</h2>'); i += 1; continue
        if l.startswith('### '): out.append(f'<h3>{inline(l[4:])}</h3>'); i += 1; continue
        if l.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip('|').split('|')]
                if not all(re.fullmatch(r'-+', c) for c in cells): rows.append(cells)
                i += 1
            th = ''.join(f'<th>{inline(c)}</th>' for c in rows[0])
            body = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in rows[1:])
            out.append(f'<table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>'); continue
        if re.match(r'^(-|\d+\.) ', l):
            # A list runs over its items and every indented line under them:
            # an indented item nests inside the item above it, and indented
            # plain text continues that item.
            block = []
            while i < len(lines) and (ITEM.match(lines[i]) or
                                      (lines[i].startswith(' ') and lines[i].strip()
                                       and not QUOTE.match(lines[i]))):
                block.append(lines[i]); i += 1
            out.append(render_list(block)); continue
        if not l.strip(): i += 1; continue
        para = []
        while (i < len(lines) and lines[i].strip() and not QUOTE.match(lines[i])
               and not re.match(r'^(#|\||- |\d+\. |```)', lines[i])):
            para.append(lines[i]); i += 1
        out.append(f'<p>{inline(" ".join(para))}</p>')
    return out
if __name__ == '__main__':
    src = pathlib.Path(sys.argv[1]).read_text().split('\n## Concrete commands')[0]
    pathlib.Path(sys.argv[2]).write_text('\n'.join(convert(src.split('\n'))) + '\n')
