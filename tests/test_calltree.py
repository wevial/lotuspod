"""Parsed HTML witnesses for the static calltree fence."""
import io
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from tests.test_manifest_v2 import TempDirTestCase, run_cli

from lotuspod import calltree, core, refs
from lotuspod.markdown import to_body
from tests.test_markdown import parse

INFO = 'repo=wevial/lotuspod sha=43b4187318733fe6aa629aaedd462adbbb147d5d'
EXAMPLE = '''~ cmd_publish()             src/lotuspod/cli.py:1919
├─ publish_config()         src/lotuspod/cli.py:1304
├─ ~ to_body()              src/lotuspod/markdown.py:123
│  └─ _walk()               src/lotuspod/markdown.py:156
│     └─ ~ _convert()       src/lotuspod/markdown.py:266
│        ├─ + render()      src/lotuspod/calltree.py:18
│        │  ├─ + parse_line()   src/lotuspod/calltree.py:44
│        │  └─ + source_url()   src/lotuspod/calltree.py:71
│        └─ _inline()       src/lotuspod/markdown.py:229
└─ cmd_render()             src/lotuspod/cli.py:729'''
GUIDES = ['', '├─ ', '├─ ', '│  └─ ', '│     └─ ', '│        ├─ ',
          '│        │  ├─ ', '│        │  └─ ', '│        └─ ', '└─ ']


def nodes(root, cls):
    return [n for tag in ('div', 'span', 'a') for n in root.find_all(tag)
            if n.attrs.get('class') == cls]


class CalltreeTests(unittest.TestCase):
    def test_example(self):
        root = parse(to_body(f'```calltree {INFO}\n{EXAMPLE}\n```'))
        self.assertEqual(nodes(root, 'calltree-summary')[0].text(), '3 changed · 3 new · across 3 files')
        rows = nodes(root, 'calltree-row')
        self.assertEqual([int(n.attrs['data-depth']) for n in rows], [0,1,1,2,3,4,5,5,4,1])
        self.assertEqual([n.attrs['data-kind'] for n in rows],
                         ['changed','context','changed','context','changed','new','new','new','context','context'])
        self.assertEqual([n.text() for n in nodes(root, 'calltree-guide')], GUIDES)
        chip = nodes(rows[5], 'calltree-chip')[0]
        self.assertEqual(chip.tag, 'a')
        self.assertEqual(chip.attrs['href'], 'https://github.com/wevial/lotuspod/blob/43b4187318733fe6aa629aaedd462adbbb147d5d/src/lotuspod/calltree.py#L18')
        self.assertEqual(chip.text(), 'calltree.py:18')
        self.assertEqual(chip.attrs['title'], 'src/lotuspod/calltree.py:18')

    def test_options(self):
        for info in ('', 'repo=a/b', 'sha=abcdef1', 'repo=a/"b sha=abcdef1',
                     'repo=a/b sha=xyz1234', 'repo=a/b/c sha=abcdef1', 'repo=é/b sha=abcdef1'):
            with self.subTest(info=info):
                chips = nodes(parse(calltree.render(EXAMPLE.splitlines(), info.split())), 'calltree-chip')
                self.assertEqual(len(chips), 10)
                self.assertTrue(all(n.tag == 'span' and 'href' not in n.attrs for n in chips))
                self.assertEqual(chips[5].text(), 'calltree.py:18')
        root = parse(calltree.render(['+ <f>&"() dir/a&"#.py:12'], ['sha=ABCDEF1', 'repo=a/b']))
        self.assertEqual(nodes(root, 'calltree-name')[0].text(), '<f>&"()')
        chip = nodes(root, 'calltree-chip')[0]
        self.assertEqual(chip.attrs['href'], 'https://github.com/a/b/blob/ABCDEF1/dir/a%26%22%23.py#L12')
        self.assertEqual(chip.attrs['title'], 'dir/a&"#.py:12')

    def test_rebuild_and_clamp(self):
        wrong = EXAMPLE.translate(str.maketrans({'│':' ', '├':' ', '└':' ', '─':' '}))
        root = parse(calltree.render(wrong.splitlines(), []))
        self.assertEqual([n.text() for n in nodes(root, 'calltree-guide')], GUIDES)
        root = parse(calltree.render(['root() x:1', '      child() x:2'], []))
        self.assertEqual([n.attrs['data-depth'] for n in nodes(root, 'calltree-row')], ['0','1'])
        self.assertEqual(nodes(root, 'calltree-guide')[1].text(), '└─ ')

    def test_malformed(self):
        bad = '   <bad & "line"'
        source = f'```calltree\n~ root() x:1\n{bad}   \n      + child() x:2\n\n```'
        root = parse(to_body(source))
        rows = nodes(root, 'calltree-row')
        self.assertEqual(rows[1].attrs, {'class':'calltree-row', 'data-depth':'1', 'data-kind':'text'})
        self.assertEqual(rows[1].text(), bad)
        self.assertEqual(rows[1].elements[0].elements, [])
        self.assertEqual(rows[2].attrs['data-depth'], '1')
        lines = ['root() x:1', '   child() x:2', '      grandchild() x:3', 'bad line', '         leaf() x:4']
        rows = nodes(parse(calltree.render(lines, [])), 'calltree-row')
        self.assertEqual([n.attrs['data-depth'] for n in rows], ['0', '1', '2', '0', '3'])
        self.assertEqual(nodes(rows[4], 'calltree-guide')[0].text(), '      └─ ')
        self.assertEqual(nodes(root, 'calltree-summary')[0].text(), '1 changed · 1 new · across 1 file')
        with tempfile.TemporaryDirectory() as directory, mock.patch('sys.stdin', io.StringIO(source)):
            rc, _, err = run_cli('render', '--markdown', '-', '--name', 'tree', '--title', 'Tree',
                                 '--out-dir', directory)
        self.assertEqual(rc, 0, err)

    def test_refs_leave_calltree_text(self):
        body = to_body('```calltree\nworker() HOLO-175.py:12\nSee HOLO-175 for details\n```\n\nHOLO-175\n')
        marked = refs.mark_refs(body, {'HOLO-175': {'title': 'Ticket'}})[0]
        self.assertEqual(marked.count('artifact-ref"'), 1)
        self.assertIn(body.split('</div></div>')[0], marked)

    def test_long_malformed_guides_do_not_stall(self):
        bad = '─' * 100_000 + ' x'
        source = f'```calltree\n~ root() x:1\n{bad}\n+ child() x:2\n```'
        # Isolate the deadline so a regex regression cannot hang the suite.
        result = subprocess.run(
            [sys.executable, '-c',
             'import sys; from lotuspod.markdown import to_body; '
             'sys.stdout.write(to_body(sys.stdin.read()))'],
            input=source, capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        root = parse(result.stdout)
        rows = nodes(root, 'calltree-row')
        self.assertEqual([row.attrs['data-kind'] for row in rows],
                         ['changed', 'text', 'new'])
        self.assertEqual(rows[1].text(), bad)
        self.assertEqual(nodes(root, 'calltree-summary')[0].text(),
                         '1 changed · 1 new · across 1 file')

    def test_guide_character_names(self):
        for guide in '│├└─':
            for separator in (' ', '\t'):
                with self.subTest(guide=guide, separator=separator):
                    root = parse(calltree.render([
                        f'{guide}{separator}src/a.py:1',
                        f'   {guide}{separator}src/a.py:2',
                    ], []))
                    rows = nodes(root, 'calltree-row')
                    self.assertEqual([r.attrs['data-kind'] for r in rows],
                                     ['context', 'context'])
                    self.assertEqual([r.attrs['data-depth'] for r in rows], ['0', '1'])
                    self.assertEqual([n.text() for n in nodes(root, 'calltree-name')],
                                     [guide, guide])
                    self.assertEqual([n.text() for n in nodes(root, 'calltree-chip')],
                                     ['a.py:1', 'a.py:2'])
                    self.assertEqual(nodes(root, 'calltree-summary')[0].text(),
                                     '0 changed · 0 new · across 1 file')


class CalltreePageScriptTests(TempDirTestCase):
    def test_a_hidden_page_with_a_calltree_loads_the_page_script_and_one_without_does_not(self):
        """LOTUS-167: the page script folds a calltree block, so a hidden page
        whose only feature is an unlinked calltree fence loads it, and the
        same page without the fence doesn't."""
        fence = '```calltree\n~ root() src/a.py:1\n└─ + child() src/a.py:2\n```\n'
        for name, source, loads in (('tree', f'Plain text.\n\n{fence}', True),
                                    ('plain', 'Plain text.\n', False)):
            with self.subTest(name=name):
                with mock.patch('sys.stdin', io.StringIO(source)):
                    rc, _, err = run_cli('render', '--markdown', '-', '--name', name, '--title', 'T',
                                         '--out-dir', str(self.out_dir), '--date', '2026-01-02',
                                         '--hidden')
                self.assertEqual(rc, 0, err)
                page = (self.out_dir / f'{name}.html').read_text(encoding='utf-8')
                self.assertEqual(f'<script src="{core.PAGE_SCRIPT}?v=' in page, loads)
