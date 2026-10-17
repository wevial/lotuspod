import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';

// A live block that names where the reader is. The check publishes a page of
// its own as hermes on the capture fixture's site with a real `lotuspod
// publish`: its first section holds the block "churn", whose slider calls
// lotuspod.state() as it moves. The chrome shows the label, refuses what the
// bridge's rules refuse, and forgets it across Pause and Resume and a reload; a comment
// started from the block keeps the label it had then, and hermes's real
// `lotuspod comments pull` says it. The run shares one database, so each
// repeat publishes a page of its own name.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWNER = 'hermes';
const WIDE = { width: 1440, height: 900 };
const TITLE = 'Merge churn by worker count';
// Named to hermes, so its pull has the thread.
const QUESTION = '@hermes Why does churn jump here?';

// The slider names its worker count only as it moves, never as it loads.
const DOC = ['# Merge study', '', 'How merges go as workers are added.', '',
  '## Churn', '', 'Reruns grow with the number of workers.', '',
  '```html live id=churn title="' + TITLE + '" height=120',
  '<label>Workers <input type="range" min="1" max="8" value="1"></label> <output>1</output>',
  '<script>',
  'const slider = document.querySelector("input");',
  'slider.addEventListener("input", () => {',
  '  const n = slider.value;',
  '  document.querySelector("output").textContent = n;',
  '  lotuspod.state("at " + n + " workers");',
  '});',
  '</script>',
  '```', '',
  '## Notes', '', 'Nothing else yet.', ''].join('\n');

test.use({ viewport: WIDE, extraHTTPHeaders: SIGNED_IN });

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish(name: string, markdown: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-widget-state-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, '--comments');
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The comment the page posts next, as the route receives it.
function posting(page: Page): Promise<Request> {
  return page.waitForRequest((request) => new URL(request.url()).pathname === '/api/comments' &&
    request.method() === 'POST' && 'text' in (request.postDataJSON() ?? {}));
}

test('a widget names where the reader is, the chrome shows it, and a comment from the block keeps it', async ({ page }) => {
  test.setTimeout(120_000);
  for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
  const name = `widget-state-check-${test.info().repeatEachIndex}`;
  publish(name, DOC);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/${name}.html?standalone`);
  const figure = page.locator('figure[data-widget="churn"]');
  const chrome = figure.locator('.artifact-live-chrome');
  const where = chrome.locator('.artifact-live-state');
  const inner = page.frameLocator('figure[data-widget="churn"] iframe');
  const slider = inner.locator('input[type="range"]');
  await expect(chrome.locator('.artifact-live-badge')).toHaveText('Live');

  // Before the widget names a state, the chrome shows none.
  await expect(where).toHaveCount(1);
  await expect(where).toBeHidden();
  expect(await chrome.locator('> *').evaluateAll((nodes) => nodes.map((node) => node.className)))
    .toEqual(['artifact-live-title', 'artifact-live-badge', 'artifact-live-state',
      'artifact-live-comment', 'artifact-live-expand', 'artifact-live-open', 'artifact-live-pause']);

  await slider.fill('6');
  await expect(where).toHaveText('at 6 workers');
  await expect(where).toBeVisible();

  // Five states the bridge refuses: four from the frame, one from the page.
  // The frame's last message comes after its four, so once the page has it,
  // the bridge has had theirs.
  await page.evaluate(() => {
    window.postMessage({ type: 'lotuspod:state', label: 'from the page' }, '*');
    (window as any).flushed = new Promise<void>((resolve) => window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'check:flushed') resolve();
    }));
  });
  await inner.locator('body').evaluate(() => {
    parent.postMessage({ type: 'lotuspod:state', label: 'at 7 workers', extra: 1 }, '*');
    parent.postMessage({ type: 'lotuspod:state', label: 'x'.repeat(81) }, '*');
    parent.postMessage({ type: 'lotuspod:state', label: 'at 7\nworkers' }, '*');
    parent.postMessage({ type: 'lotuspod:state', label: 7 }, '*');
    parent.postMessage({ type: 'check:flushed' }, '*');
  });
  await page.evaluate(() => (window as any).flushed);
  await expect(where).toHaveText('at 6 workers');

  // The reader comments at 6 workers, then moves the slider before sending.
  const churn = page.locator('aside.artifact-comments-panel .artifact-comments-group')
    .filter({ has: page.locator(':scope > .artifact-comments-group-title', { hasText: 'Churn' }) });
  const form = churn.locator('form.artifact-comment-form');
  const on = churn.locator('.artifact-comment-on');
  await chrome.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(on).toHaveText(`On ${TITLE} · at 6 workers`);
  await slider.fill('3');
  await expect(where).toHaveText('at 3 workers');
  await expect(on).toHaveText(`On ${TITLE} · at 6 workers`);
  await form.locator('textarea[name="text"]').fill(QUESTION);
  const sent = posting(page);
  await form.getByRole('button', { name: 'Comment', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.widget.state).toBe('at 6 workers');
  expect(body.widget.id).toBe('churn');
  const entry = churn.locator('.artifact-comments-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('.artifact-comments-entry-head .artifact-comments-entry-words'))
    .toHaveText(`On ${TITLE} · at 6 workers`);
  await expect(where).toHaveText('at 3 workers');

  // hermes's pull names the block at the state the comment kept.
  const pulled = run('comments', 'pull', '--owner', OWNER, '--socket', SOCKET, '--credential', HERMES);
  expect(pulled).toContain(`On the block ${TITLE} (\`churn\`), at 6 workers`);

  // Paused and resumed, the block shows no state until the widget names one.
  await chrome.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(where).toBeHidden();
  await chrome.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(chrome.locator('.artifact-live-badge')).toHaveText('Live');
  await expect(where).toBeHidden();
  await expect(where).toHaveText('');
  await slider.fill('4');
  await expect(where).toHaveText('at 4 workers');
  await expect(where).toBeVisible();

  // A label cut to 80 characters keeps a surrogate pair whole, and the page
  // drops a label holding half of one, which the route would refuse.
  await inner.locator('body').evaluate(() => (window as any).lotuspod.state('x'.repeat(79) + '\u{1F408}'));
  await expect(where).toHaveText('x'.repeat(79));
  await page.evaluate(() => {
    (window as any).flushed = new Promise<void>((resolve) => window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'check:flushed') resolve();
    }));
  });
  await inner.locator('body').evaluate(() => {
    parent.postMessage({ type: 'lotuspod:state', label: 'at \uD83D' }, '*');
    parent.postMessage({ type: 'check:flushed' }, '*');
  });
  await page.evaluate(() => (window as any).flushed);
  await expect(where).toHaveText('x'.repeat(79));

  // The frame reloads: the new document names no state until its widget does.
  await slider.fill('6');
  await expect(where).toHaveText('at 6 workers');
  await inner.locator('body').evaluate(() => location.reload());
  await expect(where).toBeHidden();
  await expect(slider).toHaveValue('1');
  await slider.fill('5');
  await expect(where).toHaveText('at 5 workers');

  // The old document spends the frame's 60 messages a second: a "" is held
  // to the quota like any state, yet the reload still clears the label.
  await slider.fill('7');
  await expect(where).toHaveText('at 7 workers');
  await page.evaluate(() => {
    (window as any).spent = new Promise<void>((resolve) => window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'check:spent') resolve();
    }));
  });
  await inner.locator('body').evaluate(() => {
    for (let i = 0; i < 70; i++) parent.postMessage({ type: 'lotuspod:resize', height: 120 }, '*');
    parent.postMessage({ type: 'lotuspod:state', label: '' }, '*');
    parent.postMessage({ type: 'check:spent' }, '*');
  });
  await page.evaluate(() => (window as any).spent);
  await expect(where).toHaveText('at 7 workers');
  await inner.locator('body').evaluate(() => location.reload());
  await expect(where).toBeHidden({ timeout: 900 });
  await expect(slider).toHaveValue('1');
  await expect(where).toBeHidden();

  // Nor does a document without the bridge keep the one before's label.
  await page.waitForTimeout(1100);
  await slider.fill('2');
  await expect(where).toHaveText('at 2 workers');
  await inner.locator('body').evaluate(() => { location.href = 'about:blank'; });
  await expect(inner.locator('input')).toHaveCount(0);
  await expect(where).toBeHidden();
  expect(errors).toEqual([]);
});
