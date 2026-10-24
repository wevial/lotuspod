import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const env = process.env;
test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' } });

function publish(name: string, content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-swap-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, content);
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes', '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!, '--no-comments'], {
      env: { ...env, PYTHONPATH: path.resolve(__dirname, '../../../../src') }, stdio: 'pipe', timeout: 60_000,
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function widget(version = 1) {
  return ['```html live title="Running clock"', `<button>Keep my place</button><output id="ticks">0</output><script>
const started = performance.now();
document.querySelector('output').dataset.started = String(performance.timeOrigin);
document.querySelector('output').dataset.version = '${version}';
setInterval(() => { document.querySelector('output').textContent = String(Math.floor((performance.now() - started) / 100)); }, 50);
</script>`, '```'].join('\n');
}
function doc(a = 'Original paragraph.', b = 'Original notes.', version = 1, intro = false) {
  return `# Widget continuity\n\n${intro ? a + '\n\n' + widget(version) : 'A running experiment.'}\n\n## A\n\n${intro ? 'Section A.' : a + '\n\n' + (version ? widget(version) : '')}\n\n## B\n\n${b}\n`;
}
const figure = (page: Page) => page.locator('figure.artifact-live');
const output = (page: Page) => page.frameLocator('iframe.artifact-widget').locator('#ticks');
const ticks = async (page: Page) => Number(await output(page).textContent());
async function arm(page: Page) {
  await page.evaluate(() => {
    (window as any).swapped = new Promise(resolve => document.addEventListener('lotuspod:swapped', (event) => {
      const fig = document.querySelector('figure.artifact-live');
      resolve({ badge: fig?.querySelector('.artifact-live-badge')?.textContent,
        tinted: fig?.querySelector('.artifact-live-chrome')?.classList.contains('artifact-swapped'),
        connected: (event as CustomEvent).detail.units.every((unit: any) => unit.after.every((node: Node) => node.isConnected)),
        removed: (event as CustomEvent).detail.units.every((unit: any) => unit.before.every((node: Node) => !node.isConnected)) });
    }, { once: true }));
  });
}
async function swap(page: Page, name: string, content: string) {
  await arm(page);
  publish(name, content);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  return page.evaluate(() => (window as any).swapped);
}
async function open(page: Page, name: string, content = doc()) {
  publish(name, content);
  await page.goto(`/${name}.html?standalone`);
  await expect(figure(page).locator('.artifact-live-badge')).toHaveText('Live');
  await expect.poll(() => ticks(page)).toBeGreaterThan(3);
  await figure(page).evaluate(node => { (node as any).kept = true; });
}
async function kept(page: Page, start: string | null, count: number) {
  expect(await figure(page).evaluate(node => (node as any).kept)).toBe(true);
  await expect(output(page)).toHaveAttribute('data-started', start!);
  await expect.poll(() => ticks(page)).toBeGreaterThan(count);
  await expect(figure(page).locator('.artifact-live-badge')).toHaveText('Live');
}

test('unchanged widgets keep their frame, runtime and chrome through section and intro swaps', async ({ page }) => {
  await open(page, 'widget-swap-carry');
  const frame = await page.locator('iframe.artifact-widget').elementHandle();
  const start = await output(page).getAttribute('data-started');
  const count = await ticks(page);
  await swap(page, 'widget-swap-carry', doc(undefined, 'New notes.'));
  expect(await frame!.evaluate(node => node === document.querySelector('iframe.artifact-widget'))).toBe(true);
  await kept(page, start, count);
  const result = await swap(page, 'widget-swap-carry', doc('Corrected paragraph.', 'New notes.'));
  expect(result.connected).toBe(true);
  await expect(page.locator('[data-section="a"]')).toContainText('Corrected paragraph.');
  await kept(page, start, count);
  expect(await frame!.evaluate(node => node === document.querySelector('iframe.artifact-widget'))).toBe(true);
  await expect(figure(page).locator('.artifact-live-chrome')).not.toHaveClass(/artifact-swapped/);

  await figure(page).getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('.artifact-title').click();
  await swap(page, 'widget-swap-carry', doc('Updated while paused.', 'New notes.'));
  expect(await figure(page).evaluate(node => (node as any).kept)).toBe(true);
  await expect(figure(page).locator('.artifact-live-paused')).toBeVisible();
  await expect(figure(page).getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(page.locator('iframe.artifact-widget')).toHaveAttribute('src', 'about:blank');

  await open(page, 'widget-swap-intro', doc('Intro paragraph.', undefined, 1, true));
  const introStart = await output(page).getAttribute('data-started');
  const introCount = await ticks(page);
  const introSwap = await swap(page, 'widget-swap-intro', doc('Corrected intro.', undefined, 1, true));
  expect(introSwap.connected).toBe(true);
  expect(introSwap.removed).toBe(true);
  await kept(page, introStart, introCount);
});

test('carried widgets reconcile the sandbox explanation in the section', async ({ page }) => {
  const name = 'widget-swap-note-section';
  const survivor = widget().replace('live title=', 'live id=survivor title=');
  const first = widget().replace('live title=', 'live id=first title=');
  const content = (both: boolean) => doc()
    .replace(widget(), both ? `${first}\n\n${survivor}` : survivor);
  await open(page, name, content(false));
  const original = await page.locator('iframe.artifact-widget').elementHandle();
  const start = await output(page).getAttribute('data-started');
  const count = await ticks(page);

  await swap(page, name, content(true));
  await expect(page.locator('.artifact-live-note')).toHaveCount(1);
  await expect(page.locator('figure[data-widget="first"] .artifact-live-note')).toContainText('Sandboxed:');
  await expect(page.locator('figure[data-widget="survivor"] .artifact-live-note')).toHaveCount(0);

  await swap(page, name, content(false));
  await expect(page.locator('.artifact-live-note')).toHaveCount(1);
  await expect(figure(page).locator('.artifact-live-note')).toHaveText("Sandboxed: this block can't see the page or your comments");
  expect(await original!.evaluate(node => node === document.querySelector('iframe.artifact-widget'))).toBe(true);
  await kept(page, start, count);
});

test('running widgets restore automatic height in the section', async ({ page }) => {
  const name = 'widget-swap-auto-height-section';
  const content = (fixed: boolean) => doc()
    .replace('live title="Running clock"', `live id=clock title="Running clock"${fixed ? ' height=800' : ''}`)
    .replace('<button>Keep my place', '<style>html, body { margin: 0; height: 700px; }</style><button>Keep my place');
  await open(page, name, content(true));
  const frame = page.locator('iframe.artifact-widget');
  const original = await frame.elementHandle();
  const start = await output(page).getAttribute('data-started');
  const count = await ticks(page);
  await expect(frame).toHaveAttribute('height', '800');
  await swap(page, name, content(false));
  await expect(frame).not.toHaveAttribute('data-height-fixed');
  await expect(frame).toHaveAttribute('height', '700');
  expect(await original!.evaluate(node => node === document.querySelector('iframe.artifact-widget'))).toBe(true);
  await kept(page, start, count);
});

test('carried widgets apply published title and height changes in the section', async ({ page }) => {
  const name = 'widget-swap-metadata-section';
  const content = (title: string, height?: number) => doc()
    .replace('live title="Running clock"', `live id=clock title="${title}"${height === undefined ? '' : ` height=${height}`}`);
  await open(page, name, content('Old title', 200));
  const frame = page.locator('iframe.artifact-widget');
  const original = await frame.elementHandle();
  const source = await frame.getAttribute('src');
  const start = await output(page).getAttribute('data-started');
  const count = await ticks(page);
  await swap(page, name, content('New title', 800));
  await expect(figure(page).locator('.artifact-live-title')).toHaveText('New title');
  await expect(frame).toHaveAttribute('title', 'New title');
  await expect(frame).toHaveAttribute('height', '800');
  await expect(frame).toHaveAttribute('data-height-fixed');
  await expect(frame).toHaveAttribute('src', source!);
  expect(await original!.evaluate(node => node === document.querySelector('iframe.artifact-widget'))).toBe(true);
  await kept(page, start, count);

  await figure(page).getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('.artifact-title').click();
  await swap(page, name, content('Automatic height'));
  await expect(frame).toHaveAttribute('title', 'Automatic height');
  await expect(frame).not.toHaveAttribute('data-height-fixed');
  await expect(frame).toHaveAttribute('height', '360');
  await expect(frame).toHaveAttribute('src', 'about:blank');
  await expect(figure(page).locator('.artifact-live-paused')).toBeVisible();
  expect(await figure(page).evaluate(node => (node as any).kept)).toBe(true);
  await figure(page).getByRole('button', { name: 'Resume' }).click();
  await expect(figure(page).locator('.artifact-live-badge')).toHaveText('Live');
  await expect(frame).toHaveAttribute('src', source!);
  await page.locator('.artifact-title').click();
  await swap(page, name, content('Fixed again', 450));
  await expect(frame).toHaveAttribute('height', '450');
  await expect(frame).toHaveAttribute('data-height-fixed');
  expect(await original!.evaluate(node => node === document.querySelector('iframe.artifact-widget'))).toBe(true);
});

test('changed widgets load a new file, receive chrome and briefly tint their strip', async ({ page }) => {
  await open(page, 'widget-swap-reload');
  const src = await page.locator('iframe.artifact-widget').getAttribute('src');
  // Hold the new response so loading and the first count are observable.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/*widget*', async route => {
    if (route.request().resourceType() === 'document' && route.request().url().includes('.w-')) await gate;
    await route.continue();
  });
  const result = await swap(page, 'widget-swap-reload', doc(undefined, undefined, 2));
  expect(result.badge).toBe('loading');
  expect(result.tinted).toBe(true);
  expect(await page.locator('iframe.artifact-widget').getAttribute('src')).not.toBe(src);
  await expect(figure(page).getByRole('button', { name: 'Expand' })).toHaveCount(1);
  release();
  await expect(output(page)).toHaveAttribute('data-version', '2');
  expect(await ticks(page)).toBeLessThan(4);
  await expect(figure(page).locator('.artifact-live-badge')).toHaveText('Live');
  await expect(figure(page).locator('.artifact-live-chrome')).not.toHaveClass(/artifact-swapped/, { timeout: 3000 });
});

for (const mode of ['focus', 'expanded']) {
  test(`a widget with ${mode} holds its section until Update`, async ({ page }) => {
    const name = `widget-swap-${mode}`;
    await open(page, name);
    const start = await output(page).getAttribute('data-started');
    const count = await ticks(page);
    if (mode === 'focus') {
      await page.frameLocator('iframe.artifact-widget').getByRole('button').click();
      expect(await page.evaluate(() => document.activeElement?.matches('iframe.artifact-widget'))).toBe(true);
    } else {
      await figure(page).getByRole('button', { name: 'Expand' }).click();
      // Prove the expanded hold independently of the focus hold.
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    }
    await swap(page, name, doc('Revised while reading.'));
    const bar = page.locator('.artifact-swap-held');
    await expect(bar).toContainText('This section changed');
    await expect(page.locator('[data-section="a"]')).toContainText('Original paragraph.');
    await kept(page, start, count);
    if (mode === 'expanded') {
      await expect(figure(page)).toHaveClass(/artifact-live--expanded/);
      await page.keyboard.press('Escape');
    }
    await arm(page);
    await bar.getByRole('button', { name: 'Update' }).click();
    await page.evaluate(() => (window as any).swapped);
    await expect(page.locator('[data-section="a"]')).toContainText('Revised while reading.');
    await kept(page, start, count);
  });
}

test('adding the first widget keeps the policy reload fallback', async ({ page }) => {
  const name = 'widget-swap-policy';
  publish(name, doc(undefined, undefined, 0));
  await page.goto(`/${name}.html?standalone`);
  await page.evaluate(() => { (window as any).originalDocument = true; });
  publish(name, doc());
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('.artifact-live-page-reload').click();
  await expect(figure(page).locator('.artifact-live-badge')).toHaveText('Live');
  expect(await page.evaluate(() => (window as any).originalDocument)).toBeUndefined();
  await expect.poll(() => ticks(page)).toBeGreaterThan(0);
});

test('without moveBefore a prose swap reloads the widget and wires fresh chrome', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Element.prototype, 'moveBefore', { value: undefined, configurable: true }));
  await open(page, 'widget-swap-fallback');
  const start = await output(page).getAttribute('data-started');
  const result = await swap(page, 'widget-swap-fallback', doc('Corrected paragraph.'));
  expect(result.tinted).toBe(true);
  expect(await figure(page).evaluate(node => (node as any).kept)).toBeUndefined();
  await expect(output(page)).not.toHaveAttribute('data-started', start!);
  await expect(figure(page).locator('.artifact-live-badge')).toHaveText('Live');
  await expect(figure(page).getByRole('button', { name: 'Expand' })).toHaveCount(1);
  await expect(figure(page).getByRole('button', { name: 'Pause', exact: true })).toHaveCount(1);
});
