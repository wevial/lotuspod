"""Pinned browser libraries, emitted widget documents and atomic validation."""
import base64
import hashlib
import json
from pathlib import Path

from lotuspod import libraries
from tests.test_manifest_v2 import TempDirTestCase, cli, run_cli
from tests.test_widgets import Elements
from tests.test_page_policy import directives, read_page

ROOT = Path(__file__).resolve().parents[1]


class LibraryTests(TempDirTestCase):
    def publish(self, source, suffix='md'):
        file = self.out_dir.parent / (self.out_dir.name + '.' + suffix)
        self.addCleanup(file.unlink, missing_ok=True)
        file.write_text(source)
        return run_cli('publish', str(file), '--name', 'charts', '--local',
                       '--out-dir', str(self.out_dir))

    def document(self):
        page = (self.out_dir / 'charts.html').read_text()
        return (self.out_dir / Elements(page).of('iframe')[0]['src']).read_text()

    def assert_libraries(self, document, names):
        expected = [libraries.LIBRARIES[name] for name in names]
        self.assertEqual(Elements(document.split('</head>')[0]).of('script'),
                         [dict(src=lib.url, integrity=lib.integrity,
                               crossorigin='anonymous') for lib in expected])
        for lib in expected:
            self.assertLess(document.index('Content-Security-Policy'), document.index(lib.url + '"'))
            self.assertLess(document.index(lib.url + '"'), document.index((Path(cli.__file__).parent / '_theme/widget-frame.js').read_text()))
        policy = directives(read_page(document).policies[0])
        self.assertEqual(policy['script-src'],
                         [cli.script_hash(s) for s in cli.collect_scripts(document).inline]
                         + [lib.url for lib in expected])
        self.assertEqual(policy['connect-src'], ["'none'"])

    def test_fence_dependencies_order_integrity_and_policy(self):
        rc, _, err = self.publish('# Charts\n```html live plot chartjs title="Charts"\n<script>window.chartReady = true;</script>\n```')
        self.assertEqual(rc, 0, err)
        self.assert_libraries(self.document(), ['d3', 'plot', 'chartjs'])

    def test_html_template(self):
        rc, _, err = self.publish('<h1>Charts</h1><template class="lotuspod-live" data-libs="d3" data-title="Dots"><script>d3.select("body");</script></template>', 'html')
        self.assertEqual(rc, 0, err)
        self.assert_libraries(self.document(), ['d3'])

    def test_mermaid_widget_keeps_page_policy_separate(self):
        rc, _, err = self.publish(
            '# Charts\n```mermaid\ngraph LR; A --> B\n```\n'
            '```html live mermaid title="Diagram"\n'
            '<pre class="mermaid">graph LR; C --> D</pre>\n'
            '<script>mermaid.initialize({startOnLoad: true});</script>\n```')
        self.assertEqual(rc, 0, err)
        document = self.document()
        self.assert_libraries(document, ['mermaid'])
        page = (self.out_dir / 'charts.html').read_text()
        page_sources = directives(read_page(page).policies[0])['script-src']
        self.assertIn(cli.MERMAID_DIR, page_sources)
        for library in libraries.LIBRARIES.values():
            self.assertNotIn(library.url, page_sources)
        widget_sources = directives(read_page(document).policies[0])['script-src']
        self.assertNotIn(cli.MERMAID_DIR, widget_sources)

    def test_duplicate_and_transitive_library_loads_once(self):
        rc, _, err = self.publish('# Charts\n```html live d3 plot d3 title="Dots"\nx\n```')
        self.assertEqual(rc, 0, err)
        self.assert_libraries(self.document(), ['d3', 'plot'])

    def test_unknown_library_writes_nothing(self):
        for suffix, source in [
            ('md', '# Charts\n```html live d3 title="Valid"\nx\n```\n```html live jquery title="Invalid"\nx\n```'),
            ('html', '<h1>Charts</h1><template class="lotuspod-live" data-libs="jquery">x</template>'),
        ]:
            with self.subTest(suffix=suffix):
                rc, _, err = self.publish(source, suffix)
                self.assertEqual(rc, 1)
                self.assertIn('unknown library jquery', err)
                for name in libraries.LIBRARIES:
                    self.assertIn(name, err)
                self.assertEqual(list(self.out_dir.iterdir()), [])

    def test_global_names(self):
        self.assertEqual({name: lib.global_name for name, lib in libraries.LIBRARIES.items()},
                         dict(mermaid='mermaid', d3='d3', plot='Plot', chartjs='Chart'))

    def test_unicode_fence_whitespace(self):
        for separator in ('\u00a0', '\u2003', '\t'):
            with self.subTest(separator=repr(separator)):
                rc, _, err = self.publish(
                    f'# Charts\n```html{separator}live{separator}d3{separator}title="Two\u00a0words"\nx\n```')
                self.assertEqual(rc, 0, err)
                self.assert_libraries(self.document(), ['d3'])
                page = (self.out_dir / 'charts.html').read_text()
                self.assertEqual(Elements(page).of('iframe')[0]['title'], 'Two\u00a0words')

    def test_unicode_unknown_library_writes_nothing(self):
        for separator in ('\u00a0', '\u2003', '\t'):
            with self.subTest(separator=repr(separator)):
                rc, _, err = self.publish(f'# Charts\n```html live{separator}jquery\nx\n```')
                self.assertEqual(rc, 1)
                self.assertIn('unknown library jquery', err)
                for name in libraries.LIBRARIES:
                    self.assertIn(name, err)
                self.assertEqual(list(self.out_dir.iterdir()), [])

    def test_authored_external_script_cannot_bypass_integrity(self):
        url = libraries.LIBRARIES['d3'].url
        for tag in (f'<script src="{url}"></script>',
                    f'<SCRIPT SRC="{url}" integrity="sha384-wrong"></SCRIPT>',
                    f'<script src="{url.replace("https:", "")}"></script>',
                    f'<script src="{url}"/>'):
            for suffix in ('md', 'html'):
                with self.subTest(tag=tag, suffix=suffix):
                    source = (f'# Charts\n```html live d3\n{tag}\n```' if suffix == 'md' else
                              f'<h1>Charts</h1><template class="lotuspod-live" data-libs="d3">{tag}</template>')
                    rc, _, err = self.publish(source, suffix)
                    self.assertEqual(rc, 1)
                    self.assertIn('external script tags are not allowed', err)
                    self.assertEqual(list(self.out_dir.iterdir()), [])

    def test_npm_versions(self):
        dependencies = json.loads((ROOT / 'e2e/package.json').read_text())['dependencies']
        for name, lib in libraries.LIBRARIES.items():
            with self.subTest(library=name):
                self.assertEqual(dependencies[lib.package], lib.version)
                self.assertEqual(lib.url, f'https://cdn.jsdelivr.net/npm/{lib.package}@{lib.version}/{lib.file}')

    def test_integrity_matches_installed_files(self):
        if not (ROOT / 'e2e/node_modules').exists():
            self.skipTest('e2e npm packages not installed')
        for name, lib in libraries.LIBRARIES.items():
            with self.subTest(library=name):
                data = (ROOT / 'e2e/node_modules' / lib.package / lib.file).read_bytes()
                self.assertEqual(lib.integrity, 'sha384-' + base64.b64encode(hashlib.sha384(data).digest()).decode())
