"""Live HTML pages: real git and the publishing witness's SSH transport."""
import re
import unittest
from pathlib import Path

from tests.test_publish_remote_witness import (
    LIVE_DOCUMENT as DOCUMENT, LIVE_NOTES as NOTES, RemotePublishWitness, git,
)


class LivePages(unittest.TestCase):
    setUp = RemotePublishWitness.setUp
    write_config = RemotePublishWitness.write_config
    publish = RemotePublishWitness.publish
    remote_bytes = RemotePublishWitness.remote_bytes
    calls = RemotePublishWitness.calls
    commits = RemotePublishWitness.commits
    # Reuse the real git/SSH fixture, without inheriting its test cases.
    def source(self):
        path = self.tmp / 'mock.html'
        path.write_text(DOCUMENT)
        return path

    def test_live_document_and_kept_source_in_one_commit(self):
        done = self.publish(self.source(), '--live', '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        page = (self.out / 'mock.html').read_text()
        self.assertIn('Pump panel', page)
        self.assertRegex(page, r'<section class="artifact-body"[^>]*>\s*<figure class="artifact-live"')
        self.assertIn('data-height-full="true"', page)
        widget = next(self.out.glob('mock.w-*.html'))
        text = widget.read_text()
        self.assertTrue(text.startswith('<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy"'))
        self.assertIn('<style>body { padding: 24px;', text)
        script = re.search(r'<script>(.*?)</script>', DOCUMENT).group(1)
        from lotuspod.cli import script_hash
        self.assertEqual(text.count(script_hash(script).strip("'")), 1)
        kept = (self.out / 'mock.md').read_text()
        self.assertIn(DOCUMENT, kept)
        self.assertNotIn('file=', kept)
        names = git(self.out, 'show', '--pretty=', '--name-only', 'HEAD').stdout.decode()
        for name in ['mock.html', 'mock.md', widget.name]:
            self.assertIn(name, names)
        self.assertEqual(self.commits(), 1)
        done = self.publish(self.out / 'mock.md', '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_file_block_and_refusals_write_nothing(self):
        parts = self.tmp / 'parts'
        parts.mkdir()
        panel = parts / 'panel.html'
        panel.write_text('<button>Panel</button>')
        source = self.tmp / 'page.md'
        source.write_text('# Page\n\nParagraph.\n\n```html live file=parts/panel.html title="Panel"\nignored\n```\n')
        done = self.publish(source, '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('<button>Panel</button>', (self.out / 'page.md').read_text())
        cases = [('missing.html', None, 'no such file'), ('../outside.html', None, 'outside'),
                 ('large.html', b'x' * (2 * 1024 * 1024 + 1), '2 MB'),
                 ('binary.html', b'\xff', 'UTF-8'), ('fence.html', b'hello\n```bad', 'backticks')]
        for name, data, reason in cases:
            with self.subTest(name=name):
                if data is not None:
                    (self.tmp / name).write_bytes(data)
                source.write_text(f'# Page\n\n```html live file={name}\n```\n')
                out = self.tmp / 'refused'
                done = self.publish(source, '--local', '--out-dir', str(out))
                self.assertEqual(done.returncode, 1, done.stderr)
                for text in ['line 3', name, reason]:
                    self.assertIn(text, done.stderr)
                self.assertFalse(out.exists())

    def test_notes_files_resolve_from_notes_directory(self):
        folder = self.tmp / 'notes'
        folder.mkdir()
        (folder / 'panel.html').write_text('<p>Notes widget</p>')
        (folder / 'dot.png').write_bytes((Path(__file__).parent / 'fixtures/media/padded-48x32-2000-bytes.png').read_bytes())
        notes = folder / 'notes.md'
        notes.write_text(NOTES + '\n![Dot](dot.png)\n\n```html live file=panel.html title=Notes\n```\n')
        done = self.publish(self.source(), '--live', '--notes', str(notes), '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        kept = (self.out / 'mock.md').read_text()
        self.assertIn('<p>Notes widget</p>', kept)
        self.assertIn('/media/', kept)
        self.assertNotIn('file=', kept)

    def test_full_document_limit_head_insertion_and_title_override(self):
        source = self.source()
        source.write_text('<html><body>' + 'x' * (300 * 1024) + '</body></html>')
        done = self.publish(source, '--live', '--title', 'Override', '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        widget = next(self.out.glob('mock.w-*.html')).read_text()
        self.assertTrue(widget.startswith('<html><head><meta http-equiv="Content-Security-Policy"'))
        self.assertIn('title=Override', (self.out / 'mock.md').read_text())

    def test_quote_closer_preserves_following_notes(self):
        (self.tmp / 'panel.html').write_text('<button>Panel</button>')
        source = self.tmp / 'quoted.md'
        source.write_text('# Quoted\n\n> ```html live file=panel.html title=Panel\n> ignored\n>```\n\n## Notes\n\nKeep this prose.\n')
        done = self.publish(source, '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        for suffix in ['md', 'html']:
            text = (self.out / ('quoted.' + suffix)).read_text()
            self.assertIn('Notes', text)
            self.assertIn('Keep this prose.', text)

    def test_explicit_source_wins_over_base_and_svg_title(self):
        source = self.source()
        source.write_text(DOCUMENT.replace('</body>', '<svg><title>Pump icon</title></svg></body>'))
        base = self.tmp / 'assets'
        base.mkdir()
        (base / 'mock.html').write_text('<html><title>Decoy</title></html>')
        done = self.publish(source, '--live', '--base', str(base), '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        kept = (self.out / 'mock.md').read_text()
        self.assertTrue(kept.startswith('# Pump panel\n'))
        self.assertNotIn('Decoy', kept)
        self.assertIn('<svg><title>Pump icon</title></svg>', kept)

    def test_unicode_script_and_multiline_title(self):
        source = self.source()
        script = '<script>window.value = "left\u2028middle\u2029right";</script>'
        source.write_text('<html><head><title>Original</title></head><body>' + script + '</body></html>')
        done = self.publish(source, '--live', '--title', 'A\nB', '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((self.out / 'mock.md').read_text().startswith('# A B\n'))
        self.assertIn(script, next(self.out.glob('mock.w-*.html')).read_text())

    def test_exact_document_limit_with_bom_and_no_final_newline(self):
        source = self.source()
        prefix, suffix = '\ufeff<!doctype html><html><body>', '</body></html>'
        document = prefix + 'x' * (2 * 1024 * 1024 - len((prefix + suffix).encode())) + suffix
        source.write_bytes(document.encode())
        done = self.publish(source, '--live', '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        widget = next(self.out.glob('mock.w-*.html')).read_text()
        self.assertTrue(widget.startswith('\ufeff<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'))
        source.write_bytes((document + 'x').encode())
        done = self.publish(source, '--live', '--local', '--out-dir', str(self.tmp / 'refused'))
        self.assertEqual(done.returncode, 1)
        self.assertFalse((self.tmp / 'refused').exists())

    def test_policy_precedes_text_before_late_head(self):
        source = self.source()
        source.write_text('<!doctype html><html>text<head><title>Pump panel</title></head><body>Panel</body></html>')
        done = self.publish(source, '--live', '--local', '--out-dir', str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        widget = next(self.out.glob('mock.w-*.html')).read_text()
        self.assertTrue(widget.startswith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'))
        self.assertLess(widget.index('Content-Security-Policy'), widget.index('text<head>'))

    def test_symlink_outside_is_refused(self):
        folder = self.tmp / 'source'
        folder.mkdir()
        (folder / 'link.html').symlink_to(self.source())
        source = folder / 'page.md'
        source.write_text('# Page\n```html live file=link.html\n```\n')
        out = self.tmp / 'refused'
        done = self.publish(source, '--local', '--out-dir', str(out))
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn('line 2, file link.html', done.stderr)
        self.assertIn('outside', done.stderr)
        self.assertFalse(out.exists())

    def test_live_page_and_notes_travel_over_ssh_and_match_local(self):
        notes = self.tmp / 'notes.md'
        notes.write_text(NOTES)
        source = self.tmp / 'mock.html'
        source.write_text(DOCUMENT, encoding='utf-8')
        # The SSH stub removes the sender's source files before invoking the writer.
        stub = self.tmp / 'bin' / 'ssh'
        original = stub.read_text()
        stub.write_text(original.replace('sys.exit(subprocess.run',
            f'os.unlink({str(source)!r})\nos.unlink({str(notes)!r})\nsys.exit(subprocess.run'))
        done = self.publish(source, '--live', '--notes', str(notes), '--comments', '--date', '2026-10-17')
        self.assertFalse(source.exists())
        self.assertFalse(notes.exists())
        stub.write_text(original)
        source.write_text(DOCUMENT)
        notes.write_text(NOTES)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.calls()[0][-2], 'writer')
        self.assertEqual(self.commits(), 1)
        self.assertNotIn('--live', self.calls()[0][-1])
        self.assertNotIn(str(source), self.calls()[0][-1])
        page = (self.out / 'mock.html').read_text()
        self.assertLess(page.index('<figure class="artifact-live"'), page.index('<h2 id="operation"'))
        for marker in ['data-section="operation"', 'data-section="review"', 'data-section=""', 'artifact-decision', 'href="#operation"', 'href="#review"']:
            self.assertIn(marker, page)
        local = self.tmp / 'local'
        done = self.publish(source, '--live', '--notes', str(notes), '--local', '--out-dir', str(local), '--date', '2026-10-17')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((local / 'mock.md').read_bytes(), (self.out / 'mock.md').read_bytes())
        widget = next(self.out.glob('mock.w-*.html'))
        self.assertEqual(widget.read_bytes(), (local / widget.name).read_bytes())
        for artifact in ['mock.html', 'mock.md', widget.name]:
            self.assertEqual(self.remote_bytes(artifact), (self.out / artifact).read_bytes())
        self.assertIn(DOCUMENT, (self.out / 'mock.md').read_text())
        self.assertNotIn('file=', (self.out / 'mock.md').read_text())
        # Publication timestamp is the only nondeterministic page field.
        clean = lambda text: re.sub(r'2026-\d\d-\d\dT[^"< ]+', 'STAMP', text)
        self.assertEqual(clean(page), clean((local / 'mock.html').read_text()))

    def test_invalid_live_options_write_nothing_and_never_call_ssh(self):
        source = self.tmp / 'page.md'
        source.write_text('# Page\n', encoding='utf-8')
        for local in [False, True]:
            for options, option in [(('--notes', 'notes.md'), '--notes'),
                                    (('--live',), '--live')]:
                with self.subTest(local=local, option=option):
                    out = self.tmp / 'refused'
                    destination = ['--local', '--out-dir', str(out)] if local else []
                    done = self.publish(source, *options, *destination)
                    self.assertEqual(done.returncode, 1, done.stderr)
                    self.assertIn(option, done.stderr)
                    self.assertFalse(out.exists())
                    self.assertEqual(self.calls(), [])
                    self.assertEqual(self.commits(), 0)
                    self.assertEqual(list(self.out.iterdir()), [self.out / '.git'])


del RemotePublishWitness
