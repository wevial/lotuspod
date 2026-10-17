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


del RemotePublishWitness
