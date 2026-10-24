"""Live widget documents, publish transactions and serving boundaries."""
import hashlib
import json
import subprocess
import threading
import urllib.error
import urllib.request
from html.parser import HTMLParser
from unittest.mock import patch

from tests.features.publish.test_manifest_v2 import TempDirTestCase, run_cli
from tests.features.publish.test_page_policy import read_page, directives
from lotuspod import core
from lotuspod.features.serve import handler as serve_handler, pages as serve_pages
from lotuspod.features.publish import markdown, publish_sources, render
from lotuspod.features.widgets import widgets

SOURCE = '<button>Press</button>\n<style>button { color: red; }</style>\n<script>document.body.dataset.ran = "yes";</script>\n'


class Elements(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.tags = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

    def of(self, tag):
        return [attrs for kind, attrs in self.tags if kind == tag]


class WidgetTests(TempDirTestCase):
    def test_served_chrome_for_two_markdown_widgets(self):
        from xml.etree import ElementTree
        body = markdown.to_body('```html live title="Pond & clock" id=clock\n<p>One</p>\n```\n\n'
                                '```html live id=second\n<p>Two</p>\n```')
        rendered, _, _ = widgets.render(body, 'pond')
        root = ElementTree.fromstring('<main>' + rendered + '</main>')
        figures = root.findall('.//figure')
        self.assertEqual(len(figures), 2)
        for figure, ident, title in zip(figures, ['clock', 'second'], ['Pond & clock', 'second']):
            self.assertEqual(figure.attrib, {'class': 'artifact-live', 'data-widget': ident})
            chrome = figure[0]
            self.assertEqual(chrome.attrib['class'], 'artifact-live-chrome')
            self.assertEqual([(node.attrib['class'], node.text) for node in chrome[:2]],
                             [('artifact-live-title', title), ('artifact-live-badge', 'loading')])
            frame = figure.find('iframe')
            self.assertIsNotNone(frame)
            self.assertEqual(chrome.find('a').attrib, {
                'class': 'artifact-live-open', 'href': frame.attrib['src'],
                'target': '_blank', 'rel': 'noopener noreferrer'})
            self.assertEqual(chrome.find('a').text, 'Open alone')
            self.assertEqual(chrome.findall('button'), [])
        notes = root.findall('.//p[@class="artifact-live-note"]')
        self.assertEqual(len(notes), 1)
        self.assertIs(figures[0][1], notes[0])
        self.assertEqual(notes[0].text, "Sandboxed: this block can't see the page or your comments")

    def test_frame_scan_skips_pages_without_iframe_candidates(self):
        with patch.object(widgets.Frames, 'feed') as feed:
            self.assertEqual(widgets.Frames('<p>No frame</p>').sources, [])
        feed.assert_not_called()
        self.assertEqual(widgets.Frames(
            '<!-- <iframe class="artifact-widget" src="comment.html"> -->'
            '<script>"<iframe class=artifact-widget src=script.html>"</script>'
            '<iframe src="ordinary.html"></iframe>'
            '<IFRAME\nCLASS="artifact-widget" SRC="pond.w-123456abcdef.html"></IFRAME>'
        ).sources, ['pond.w-123456abcdef.html'])

    def publish(self, text, suffix='html', *extra):
        source = self.out_dir.parent / (self.out_dir.name + '.' + suffix)
        self.addCleanup(source.unlink, missing_ok=True)
        source.write_text(text)
        return run_cli('publish', str(source), '--name', 'pond', '--local',
                       '--out-dir', str(self.out_dir), *extra)

    def frame(self):
        page = (self.out_dir / 'pond.html').read_text()
        return page, Elements(page).of('iframe')[0]

    def test_markdown_document_policy_hash_and_plain_fence(self):
        body = markdown.to_body('Paragraph.\n\n```html live title="Pond clock"\n' + SOURCE + '```\n\n```html\n<button>plain</button>\n```')
        self.assertEqual(self.render('pond', '--body', body)[0], 0)
        page, frame = self.frame()
        for key, value in {'sandbox': 'allow-scripts', 'allow': '', 'referrerpolicy': 'no-referrer', 'loading': 'lazy', 'title': 'Pond clock', 'data-widget': 'pond-clock', 'height': '360'}.items():
            self.assertEqual(frame[key], value)
        data = (self.out_dir / frame['src']).read_bytes()
        self.assertEqual(frame['src'], 'pond.w-' + hashlib.sha256(data).hexdigest()[:12] + '.html')
        document = data.decode()
        self.assertIn(SOURCE, document)
        self.assertIn((widgets.THEME / 'widget-frame.js').read_text(), document)
        policy = directives(read_page(document).policies[0])
        self.assertEqual(policy, {
            'default-src': ["'none'"], 'script-src': [core.script_hash(s) for s in core.collect_scripts(document).inline],
            'style-src': ["'unsafe-inline'"], 'img-src': ['data:'], 'font-src': ['data:'],
            'connect-src': ["'none'"], 'form-action': ["'none'"], 'base-uri': ["'none'"], 'frame-src': ["'none'"],
        })
        bridge = core.collect_scripts(page).inline[0]
        self.assertIn('installWidgetBridge();', bridge)
        self.assertLess(page.index(bridge), page.index('</head>'))
        self.assertIn(core.script_hash(bridge), directives(read_page(page).policies[0])['script-src'])
        self.assertIn('&lt;button&gt;plain&lt;/button&gt;', page)
        self.assertEqual(Elements(document).tags[1][0], 'head')
        self.assertEqual(Elements(document).tags[2][0], 'meta')

    def test_frame_bridge_defines_state(self):
        body = markdown.to_body('```html live id=steps title="Steps"\n<script>lotuspod.state("at 6 workers");</script>\n```')
        self.assertEqual(self.render('pond', '--body', body)[0], 0)
        document = (self.out_dir / self.frame()[1]['src']).read_text()
        scripts = core.collect_scripts(document).inline
        bridge = scripts[0]
        self.assertEqual(bridge, (widgets.THEME / 'widget-frame.js').read_text())
        self.assertIn('post({type: "lotuspod:state", label: String(label).slice(0, 80).replace(/[\\uD800-\\uDBFF]$/, "")});', bridge)
        # Each new document opens with no state, so a reload keeps none.
        self.assertIn('window.lotuspod = {state: state, theme: theme};\n  state("");', bridge)
        self.assertEqual(scripts[1], 'lotuspod.state("at 6 workers");')
        hashes = directives(read_page(document).policies[0])['script-src']
        self.assertEqual(hashes, [core.script_hash(script) for script in scripts])
        self.assertEqual(len(set(hashes)), len(scripts))

    def test_publish_history_stability_and_cleanup(self):
        def git(*args):
            return subprocess.check_output(['git', '-C', str(self.out_dir), *args], text=True).strip()
        git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
        source = '<h1>Pond</h1><p>Before</p><template class="lotuspod-live" data-id="clock" data-title="Clock" data-height="200">' + SOURCE + '</template>'
        self.assertEqual(self.publish(source)[0], 0)
        first = git('rev-parse', 'HEAD')
        page, frame = self.frame()
        self.assertEqual(frame['height'], '200')
        self.assertEqual(frame['data-height-fixed'], 'true')
        self.assertEqual(frame['data-widget'], 'clock')
        self.assertIn(frame['src'], git('ls-tree', '--name-only', first))
        self.assertIn('pond.body.html', git('ls-tree', '--name-only', first))
        self.assertEqual(self.publish(source.replace('Before', 'After'))[0], 0)
        self.assertEqual(self.frame()[1], frame)
        self.assertEqual(self.publish(source.replace('yes', 'no'))[0], 0)
        self.assertNotEqual(self.frame()[1]['src'], frame['src'])
        self.assertFalse((self.out_dir / frame['src']).exists())
        self.assertIn(SOURCE, git('show', first + ':' + frame['src']))
        self.assertEqual(self.publish('<h1>Pond</h1><p>No widget now.</p>')[0], 0)
        self.assertEqual(list(self.out_dir.glob('pond.w-*.html')), [])

    def test_cleanup_matches_page_name_literally(self):
        body = '<template class="lotuspod-live" data-title="Clock">x</template>'
        self.assertEqual(self.render('pond', '--body', body)[0], 0)
        page, frame = self.frame()
        widget_path = self.out_dir / frame['src']
        widget_bytes = widget_path.read_bytes()
        for name in ['*', 'pon?', '[p]ond']:
            with self.subTest(name=name):
                self.assertEqual(self.render(name, '--body', body)[0], 0)
                own_page = (self.out_dir / f'{name}.html').read_text()
                own_widget = self.out_dir / Elements(own_page).of('iframe')[0]['src']
                self.assertTrue(own_widget.exists())
                self.assertEqual(self.render(name, '--body', '<p>Plain</p>')[0], 0)
                self.assertFalse(own_widget.exists())
                self.assertEqual(widget_path.read_bytes(), widget_bytes)
                self.assertEqual((self.out_dir / 'pond.html').read_text(), page)

    def test_outline_comments_and_page_policy(self):
        source = '<h1>Pond</h1><h2>One</h2><template class="lotuspod-live" data-title="Clock"><h2>Private heading</h2>' + SOURCE + '</template><h2>Two</h2>'
        self.assertEqual(self.publish(source, 'html', '--comments')[0], 0)
        page, _ = self.frame()
        self.assertEqual(len(Elements(page).of('h2')), 2)
        self.assertNotIn('Private heading', page)
        self.assertEqual(directives(read_page(page).policies[0])['frame-src'], ["'self'"])
        self.assertNotIn('frame-src', render.page_policy('<p>Plain</p>', set()))
        self.assertEqual([a['data-section'] for a in Elements(page).of('details') if 'artifact-comment' in a.get('class', '') and a.get('data-section')], ['one', 'two'])

    def test_html_source_readers_ignore_widget_headings_and_images(self):
        body = '<template class="lotuspod-live" data-title="Clock"><h1>Inside</h1><img src="data:image/gif;base64,AAAA"></template><h1>Outside</h1>'
        self.assertEqual(core.html_title(body)[0], 'Outside')
        self.assertEqual(publish_sources.html_images(body).images, [])
        self.assertEqual(self.publish(body)[0], 0)

    def test_noscript_text_preserves_widget_template_boundaries(self):
        content = '<noscript></template></noscript><h2>Private heading</h2>\n' + SOURCE
        template = '<template class="lotuspod-live" data-title="Clock">' + content + '</template>'
        sources = {
            'html': '<h1>Pond</h1><h2>One</h2>' + template + '<h2>Two</h2>',
            'md': '# Pond\n\n## One\n\n```html live title="Clock"\n' + content + '```\n\n## Two\n',
        }
        for suffix, source in sources.items():
            with self.subTest(source=suffix):
                body = markdown.to_body(source) if suffix == 'md' else source
                rendered, files, _ = widgets.render(body, 'pond')
                self.assertEqual(len(files), 1)
                self.assertIn(content, next(iter(files.values())).decode())
                self.assertNotIn('Private heading', rendered)
                self.assertNotIn('Private heading', core.without_templates(body))
                rc, _, error = self.publish(source, suffix, '--comments')
                self.assertEqual(rc, 0, error)
                page, frame = self.frame()
                self.assertIn(content, (self.out_dir / frame['src']).read_text())
                self.assertNotIn('Private heading', page)
                self.assertEqual(len(Elements(page).of('h2')), 2)
                self.assertEqual([a['data-section'] for a in Elements(page).of('details')
                                  if 'artifact-comment' in a.get('class', '') and a.get('data-section')],
                                 ['one', 'two'])

    def test_pinned_fence_library_names_are_accepted(self):
        for name in ('mermaid', 'd3', 'plot', 'chartjs'):
            with self.subTest(library=name):
                body = markdown.to_body(f'```html live {name} title="Chart"\nx\n```')
                _, files, warnings = widgets.render(body, 'pond')
                self.assertEqual(len(files), 1)
                self.assertEqual(warnings, [])

    def test_refused_fence_names_its_resolved_id_and_source_line(self):
        for options, ident in [('three', 'widget-2'), ('colour=red id=clock', 'clock'),
                               ('colour=red title="Pond clock"', 'pond-clock')]:
            with self.subTest(options=options):
                source = '```html live title="First"\nx\n```\n```html live ' + options + '\nx\n```'
                with self.assertRaisesRegex(RuntimeError, f'widget {ident} at line 4'):
                    markdown.to_body(source)

    def test_render_refuses_invalid_html_before_writing(self):
        body = '<template class="lotuspod-live" data-id="bad" colour="red">x</template>'
        rc, _, error = self.render('pond', '--body', body)
        self.assertEqual(rc, 1)
        self.assertIn('widget bad at line 1', error)
        self.assertEqual(list(self.out_dir.iterdir()), [])
        rc, _, error = self.publish('<h1>\nPond\n</h1>\n' + body)
        self.assertEqual(rc, 1)
        self.assertIn('widget bad at line 4', error)
        self.assertEqual(list(self.out_dir.iterdir()), [])

    def test_variables_are_exact_and_complete(self):
        import re
        tokens = json.loads(widgets.TOKENS.read_text())
        singular = {"colors": "color", "fonts": "font", "radii": "radius"}

        def expected(sets):
            return {f'--lotus-{singular.get(group, group)}-{key.replace("_", "-")}': value
                    for group, values in sets.items() if isinstance(values, dict) and group != 'dawn'
                    for key, value in values.items()}
        night, dawn = expected(tokens), expected(tokens['dawn'])

        def declared(block):
            declarations = re.findall(r'(--lotus-[\w-]+): ([^;]+);', block)
            self.assertEqual(len(declarations), len(dict(declarations)))
            return dict(declarations)
        _, files, _ = widgets.render('<template class="lotuspod-live" data-title="Clock">x</template>', 'pond')
        for text, attribute in [(core.theme_file_bytes('lotuspod.css').decode(), 'data-theme'),
                                (next(iter(files.values())).decode(), 'data-lotus-theme')]:
            with self.subTest(attribute=attribute):
                blocks = {
                    'night': re.findall(r'(?m)(?:^|<style>):root \{\n(.*?)^\}', text, re.DOTALL),
                    'dawn': re.findall(rf'(?m)^:root\[{attribute}="dawn"\] \{{\n(.*?)^\}}', text, re.DOTALL),
                    'system': re.findall(r'(?m)^@media \(prefers-color-scheme: light\) \{\n'
                                         rf'  :root:not\(\[{attribute}="night"\]\) \{{\n(.*?)^  \}}\n\}}',
                                         text, re.DOTALL),
                }
                # The served stylesheet's base.css declares its own --color-*
                # blocks with the same selectors: the --lotus-* ones are those
                # holding any.
                blocks = {key: [block for block in found if '--lotus-' in block] for key, found in blocks.items()}
                self.assertEqual([len(found) for found in blocks.values()], [1, 1, 1])
                self.assertEqual(declared(blocks['night'][0]), night)
                self.assertEqual(declared(blocks['dawn'][0]), dawn)
                self.assertEqual(declared(blocks['system'][0]), dawn)
                # Nowhere else.
                self.assertEqual(len(re.findall(r'--lotus-[\w-]+: ', text)), len(night) + 2 * len(dawn))

    def test_limits_refuse_without_writes(self):
        cases = [
            ('id=huge', 'x' * (256 * 1024 + 1), 1),
            ('id=total', 'x' * 1100000, 2),
            ('id=w-{i} title="Clock"', 'x', 21),
            ('id=w-{i} title="Clock"', 'x' * (240 * 1024), 9),
            ('id=bad colour=red', 'x', 1),
            ('id=bad three', 'x', 1),
            ('id=a', 'x', 2),
        ]
        for options, content, count in cases:
            with self.subTest(options=options, count=count):
                text = '# Pond\n' + ''.join('```html live ' + options.format(i=i) + '\n' + content + '\n```\n' for i in range(count))
                rc, _, err = self.publish(text, 'md')
                self.assertEqual(rc, 1, err)
                self.assertIn('widget', err)
                self.assertIn('line', err)
                self.assertEqual(list(self.out_dir.iterdir()), [])
        rc, _, err = self.publish('# Pond\n```html live id=untitled\nx\n```', 'md')
        self.assertEqual(rc, 0, err)
        self.assertEqual(err.count('warning:'), 1)
        self.assertIn('untitled', err)

    def test_serving_visible_referenced_widgets_only(self):
        body = '<template class="lotuspod-live" data-title="Clock">x</template>'
        self.assertEqual(self.render('pond', '--body', body)[0], 0)
        self.assertEqual(self.render('hidden', '--body', body, '--hidden')[0], 0)
        _, frame = self.frame()
        hidden = widgets.Frames((self.out_dir / 'hidden.html').read_text()).sources[0]
        stale = 'pond.w-000000000000.html'
        (self.out_dir / stale).write_text('stale')
        server = serve_handler._make_server(self.out_dir, '127.0.0.1', 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_address[1]}/'
        with urllib.request.urlopen(base + frame['src']) as response:
            self.assertEqual(response.status, 200)
            for key, value in widgets.HEADERS:
                self.assertEqual(response.headers[key], value)
        for name in [hidden, stale]:
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(base + name)
            self.assertEqual(raised.exception.code, 404)
        self.assertEqual(serve_pages.served_page_names(self.out_dir), ['pond'])
        for command in ['manifest', 'index']:
            self.assertEqual(run_cli(command, '--out-dir', str(self.out_dir))[0], 0)
        for name in ['manifest.json', 'index.html']:
            self.assertNotIn('.w-', (self.out_dir / name).read_text())

    def test_widget_opened_alone_is_framed_under_frame_src_self(self):
        body = '<template class="lotuspod-live" data-title="Clock">x</template>'
        self.assertEqual(self.render('pond', '--body', body)[0], 0)
        _, frame = self.frame()
        server = serve_handler._make_server(self.out_dir, '127.0.0.1', 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        request = urllib.request.Request(
            f'http://127.0.0.1:{server.server_address[1]}/' + frame['src'],
            headers={'Sec-Fetch-Dest': 'document'})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status, 200)
            policy = directives(response.headers['Content-Security-Policy'])
            self.assertEqual(policy.get('frame-src'), ["'self'"])
            self.assertEqual(policy.get('frame-ancestors'), ["'none'"])
            self.assertEqual(response.headers['Vary'], 'Sec-Fetch-Dest')
            frames = Elements(response.read().decode()).of('iframe')
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].get('sandbox'), 'allow-scripts')
        self.assertIn(frame['src'], frames[0].get('src', ''))
        url = f'http://127.0.0.1:{server.server_address[1]}/'
        with urllib.request.urlopen(url + frames[0]['src']) as response:
            self.assertEqual(response.read(), (self.out_dir / frame['src']).read_bytes())
        for headers in ({'Sec-Fetch-Dest': 'iframe'}, {}):
            request = urllib.request.Request(url + frame['src'], headers=headers)
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), (self.out_dir / frame['src']).read_bytes())
                for key, value in (*widgets.HEADERS, ('Vary', 'Sec-Fetch-Dest')):
                    self.assertEqual(response.headers[key], value)
