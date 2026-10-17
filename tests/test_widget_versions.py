"""Historical widget bytes and chrome through real publish, git and serve."""
from unittest import mock

from lotuspod import cli, versions, widgets
from tests.test_publish_witness import parse
from tests.test_versions_witness import VersionsWitness, PAGE, OTHER, DATES


def live(text):
    return ('```html live title="Pond forecast" height=240\n'
            '<output></output><script>document.querySelector("output").textContent = "'
            + text + '";</script>\n```')


class WidgetVersionsTests(VersionsWitness):
    def prepare(self):
        self.repository(self.out)
        saved = []
        for text, day in zip(('First forecast', 'Changed forecast'), DATES):
            self.publish(PAGE, live(text), day)
            page = (self.out / f'{PAGE}.html').read_text()
            (filename,) = widgets.Frames(page).sources
            saved.append((self.commits(self.out, PAGE)[0], filename,
                          (self.out / filename).read_bytes()))
        self.publish(PAGE, 'The forecast was removed.', DATES[2])
        self.publish(OTHER, live('Current forecast'), DATES[2])
        return saved

    def test_old_chrome_and_historical_bytes_with_access_and_sandbox(self):
        first, second = self.prepare()
        self.start_server()
        status, _, data = self.get(f'/{PAGE}.html?version={first[0]}')
        self.assertEqual(status, 200)
        root = parse(data.decode())
        expected = f'{first[1]}?version={first[0]}'
        self.assertEqual(root.find('iframe', 'artifact-widget')[0].attrs['src'], expected)
        self.assertEqual(root.find('a', 'artifact-live-open')[0].attrs['href'], expected)
        self.assertEqual(root.find('span', 'artifact-live-badge')[0].text(), 'Old version')
        self.assertEqual(root.find('iframe', 'artifact-widget')[0].attrs['height'], '240')
        self.assertEqual(len(root.find('script')), 1)
        for commit, filename, original in (first, second):
            status, headers, data = self.get(f'/{filename}?version={commit}')
            self.assertEqual((status, data), (200, original))
            for header, value in (*widgets.HEADERS, ('Cache-Control', 'private, no-store')):
                self.assertEqual(headers[header], value)
            self.assertFalse((self.out / filename).exists())

        unlisted = self.commits(self.out, OTHER)[0]
        for commit, token, expected in ((second[0], 'valid', 404),
                                        (unlisted, 'valid', 404), (first[0], None, 401)):
            self.assertEqual(self.get(f'/{first[1]}?version={commit}', token=token)[0], expected)
        for _, filename, _ in (first, second):
            self.assertEqual(self.get(f'/{filename}')[0], 404)
        (current,) = widgets.Frames((self.out / f'{OTHER}.html').read_text()).sources
        status, headers, data = self.get(f'/{current}')
        self.assertEqual((status, data), (200, (self.out / current).read_bytes()))
        for header, value in widgets.HEADERS:
            self.assertEqual(headers[header], value)

    def test_history_budget_and_visible_listing(self):
        first, _ = self.prepare()
        history = versions.History(self.out, cli.version_stamp)
        with mock.patch.object(history, '_git', wraps=history._git) as calls:
            self.assertEqual(history.widget_version(PAGE, first[0], first[1]), first[2])
        self.assertLessEqual(calls.call_count, 3)
        self.assertEqual(sum(call.args[:2] == ('cat-file', '--batch')
                             for call in calls.call_args_list), 2)
        with mock.patch.object(versions, 'MAX_VERSIONS', 1):
            self.assertIsNone(history.widget_version(PAGE, first[0], first[1]))
