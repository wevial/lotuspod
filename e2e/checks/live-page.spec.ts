import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Wide enough for the side panel: a thread opens in it.
const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

// An open page notices it was published again. Each check publishes a page
// of its own on the capture fixture's site with a real `lotuspod publish`,
// opens it, publishes it again to a new revision and drives the page's
// clock: the page asks for its revision every 60 seconds, and learns it from
// each read of its threads too.
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
const NEWER = 'A newer version of this page is available';
const CHECK = 60_000;
const START = Date.parse('2026-10-02T12:00:00Z');
const FISH = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'media', 'fish-320x240.jpg');
const MEDIA_URL = /^\/media\/[0-9a-f]{64}\.jpg$/;

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// hermes pulls, so it is listening and a new comment naming it waits for it.
function listen() {
  JSON.parse(run('comments', 'pull', '--owner', OWNER, '--json', '--socket', SOCKET,
    '--credential', HERMES));
}

// A page's markdown: three sections of `paragraphs` paragraphs each, the
// edition named at the top.
function source(title: string, edition: string, paragraphs = 2) {
  const lines = [`# ${title}`, '', `Edition: ${edition}.`, ''];
  for (const section of ['Findings', 'Risks', 'Next steps']) {
    lines.push(`## ${section}`, '');
    for (let n = 1; n <= paragraphs; n += 1) {
      lines.push(`${section}, paragraph ${n}: the pond freezes in January, the pump stops ` +
        'with it, and the heater keeps a hole in the ice open for the fish until the thaw.', '');
    }
  }
  return lines.join('\n');
}

// A page's markdown with the sections named, in order, each with its
// paragraphs: what a check that swaps changes one part of at a time.
function sectioned(title: string, sections: [string, string[]][], intro = 'The pond, in winter.') {
  const lines = [`# ${title}`, '', intro, ''];
  for (const [heading, paragraphs] of sections) {
    lines.push(`## ${heading}`, '');
    for (const paragraph of paragraphs) lines.push(paragraph, '');
  }
  return lines.join('\n');
}

const POND: [string, string[]][] = [
  ['Findings', ['The pond freezes in January.', 'The pump stops with it.']],
  ['Risks', ['The pump may crack in the ice.', 'The fish need air under it.']],
  ['Next steps', ['Order a heater before the frost.', 'Lift the pump out in December.']],
];

// POND with one section's paragraphs, or its heading, changed.
function pond(change: Record<string, { heading?: string; paragraphs?: string[] }> = {}) {
  return POND.map(([heading, paragraphs]): [string, string[]] =>
    [change[heading]?.heading ?? heading, change[heading]?.paragraphs ?? paragraphs]);
}

// Open a page that takes no comments, its clock stopped, once its script has
// run; the number of loads and navigations from then on.
async function openPlain(page: Page, name: string) {
  await stopClock(page);
  await page.goto(`/${name}.html?standalone`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const moved = { count: 0 };
  page.on('load', () => { moved.count += 1; });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) moved.count += 1;
  });
  await page.evaluate(() => { (window as any).__stayed = 'this page'; });
  return moved;
}

// The swapped events the page sends, as {kind, id, change}.
async function watchSwaps(page: Page) {
  await page.addInitScript(() => {
    const seen: { kind: string; id: string; change: string }[] = [];
    (window as any).__swaps = seen;
    document.addEventListener('lotuspod:swapped', (event) => {
      for (const unit of (event as CustomEvent).detail.units) {
        seen.push({ kind: unit.kind, id: unit.id, change: unit.change });
      }
    });
  });
  return () => page.evaluate(() => (window as any).__swaps as { kind: string; id: string; change: string }[]);
}

function headings(page: Page) {
  return page.locator('.artifact-body > h2').evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector('.artifact-section-toggle')?.firstChild?.textContent?.trim()
      ?? node.textContent!.trim()));
}

// hermes publishes markdown as the page name, with any extra options; the
// revision it is now at.
function publish(name: string, markdown: string, ...extra: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-live-page-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, ...extra);
    const revision = /at revision ([0-9a-f]{12})/.exec(said)?.[1] ?? '';
    expect(revision, said).not.toBe('');
    return revision;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The reader's new thread on a section, stored through the comments route.
async function comment(request: APIRequestContext, name: string, section: string, text: string) {
  const response = await request.post('/api/comments', {
    headers: SIGNED_IN, data: { page: name, section, text },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: number; state: string };
}

// Errors the page throws or logs.
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

// The page's clock, paused at START: it moves only when moved.
async function stopClock(page: Page) {
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
}

// Open the page and let its first read of the threads come back.
async function open(page: Page, name: string) {
  const read = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'GET');
  await page.goto(`/${name}.html?standalone`);
  await read;
}

function revisionOf(page: Page) {
  return page.locator('meta[name="lotuspod:revision"]').getAttribute('content');
}

// Where the page's text starts in the window: the same, to the pixel the
// scroll position snaps to, after a reload that brings the reader back to the
// same place in it, even with the box saying what changed drawn above it.
function textTop(page: Page) {
  return page.evaluate(() => document.querySelector('.artifact-main')!.getBoundingClientRect().top);
}

function banner(page: Page) {
  const node = page.locator('.artifact-live-page-banner');
  return { node, reload: node.getByRole('button', { name: 'Reload' }) };
}

// Have each swap of the page fall back to the banner or a reload, as it did
// before a page with comments swapped: the swap's fetch of the page answers
// it with another theme. Any other request goes on to a route set before, or
// to the site.
async function fallBack(page: Page, name: string) {
  await page.route((url) => url.pathname === `/${name}.html`, async (route) => {
    if (route.request().resourceType() !== 'fetch') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const text = (await response.text()).replace(/lotuspod\.css\?v=[0-9a-f]+/, 'lotuspod.css?v=000000000000');
    await route.fulfill({ response, body: text });
  });
}

// The number of loads and navigations of the page from now on.
function watchLoads(page: Page) {
  const moved = { count: 0 };
  page.on('load', () => { moved.count += 1; });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) moved.count += 1;
  });
  return moved;
}

async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

// Paste the fish JPEG into a field, as the clipboard hands it to the page,
// and wait for its upload to be answered.
async function pasteFish(page: Page, field: Locator) {
  const uploaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/media');
  await pasteFishOnly(field);
  expect((await uploaded).status()).toBe(201);
}

// Paste the fish JPEG into a field, its upload left to answer when it may.
async function pasteFishOnly(field: Locator) {
  const base64 = fs.readFileSync(FISH).toString('base64');
  await field.evaluate((node, base64) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    data.items.add(new File([bytes], 'fish.jpg', { type: 'image/jpeg' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, base64);
}

// Hold the page's uploads (/api/media) until the returned release is called.
async function holdUploads(page: Page) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/api/media', async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

// The thumbnails attached in a form: their /media/ paths, once drawn.
async function attachedIn(form: Locator) {
  return form.locator('.artifact-attach-item img').evaluateAll((images) =>
    images.map((img) => new URL((img as HTMLImageElement).src).pathname));
}

// Where every element of the page's main column is, in the window.
function layout(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('main.artifact *')).map((node) => {
    const rect = node.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height];
  }));
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('a republish shows the banner at the next check, over the page, moving nothing', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-check';
    await fallBack(page, name);
    const first = publish(name, source('Live page check', 'first'));
    await stopClock(page);
    await open(page, name);
    expect(await revisionOf(page)).toBe(first);
    const before = await layout(page);
    expect(before.length).toBeGreaterThan(10);

    const second = publish(name, source('Live page check', 'second'));
    expect(second).not.toBe(first);
    await page.clock.runFor(CHECK - 1000);
    await expect(banner(page).node).toHaveCount(0);
    await page.clock.runFor(1000);

    const shown = banner(page);
    await expect(shown.node).toBeVisible();
    await expect(shown.node).toContainText(NEWER);
    await expect(shown.reload).toBeVisible();
    // Fixed over the top of the window, announced politely.
    await expect(shown.node.locator('xpath=ancestor::*[@role="status"]')).toHaveCount(1);
    await expect(page.locator('.artifact-live-page')).toHaveCSS('position', 'fixed');
    const box = (await shown.node.boundingBox())!;
    expect(box.y).toBeLessThan(40);
    expect(await layout(page)).toEqual(before);
    // The page is still the one it was until the reader reloads it.
    expect(await revisionOf(page)).toBe(first);
    expect(errors).toEqual([]);
  });

  test('a published page with no comments, decisions or sections swaps in its new text without a reload', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-plain';
    const NOTE = (edition: string) => `# Live page plain\n\nEdition: ${edition}. One note, no sections.\n`;
    const first = publish(name, NOTE('first'), '--no-comments');
    const moved = await openPlain(page, name);
    expect(await revisionOf(page)).toBe(first);
    await expect(page.locator('details.artifact-comment, form.artifact-decision, h2')).toHaveCount(0);

    const second = publish(name, NOTE('second'), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    await expect(page.locator('.artifact-body')).not.toContainText('Edition: first.');
    expect(await revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    expect(moved.count).toBe(0);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    expect(errors).toEqual([]);
  });

  test('a republish that changes one section swaps in only that section, its folds and nodes kept', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-swap';
    const first = publish(name, sectioned('Live page swap', pond()), '--no-comments');
    const moved = await openPlain(page, name);
    expect(await revisionOf(page)).toBe(first);
    const body = page.locator('.artifact-body');
    const wrapper = (id: string) => body.locator(`> div.artifact-section-body[data-section="${id}"]`);
    const toggle = (id: string) => body.locator(`> h2#${id} button.artifact-section-toggle`);
    // Marked, so the same nodes are known after the swap.
    for (const node of [wrapper('findings'), wrapper('next-steps'), page.locator('header.artifact-header')]) {
      await node.evaluate((element) => { (element as any).__kept = true; });
    }
    await toggle('next-steps').click();
    await expect(wrapper('next-steps')).toHaveAttribute('hidden', 'until-found');

    const CHANGED = 'The pump will crack unless it is lifted out first.';
    const second = publish(name, sectioned('Live page swap', pond({
      Risks: { paragraphs: [CHANGED, 'The fish need air under it.'] },
    })), '--no-comments');
    expect(second).not.toBe(first);
    await page.clock.runFor(CHECK);

    await expect(wrapper('risks')).toContainText(CHANGED);
    await expect(wrapper('risks')).not.toContainText('The pump may crack in the ice.');
    await expect(banner(page).node).toHaveCount(0);
    expect(await revisionOf(page)).toBe(second);
    expect(moved.count).toBe(0);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    for (const node of [wrapper('findings'), wrapper('next-steps'), page.locator('header.artifact-header')]) {
      expect(await node.evaluate((element) => (element as any).__kept)).toBe(true);
    }
    expect(await wrapper('risks').evaluate((element) => (element as any).__kept)).toBeUndefined();

    // The reader's fold is kept, and the swapped section folds as any other.
    await expect(wrapper('next-steps')).toHaveAttribute('hidden', 'until-found');
    await expect(toggle('risks')).toHaveAttribute('aria-expanded', 'true');
    await toggle('risks').click();
    await expect(wrapper('risks')).toHaveAttribute('hidden', 'until-found');
    await expect(toggle('risks')).toHaveAttribute('aria-expanded', 'false');
    await toggle('risks').click();
    await expect(wrapper('risks')).not.toHaveAttribute('hidden');
    const every = page.locator('nav.artifact-outline button.artifact-sections-all');
    await expect(every).toHaveText('Collapse all');
    await every.click();
    for (const id of ['findings', 'risks', 'next-steps']) {
      await expect(wrapper(id)).toHaveAttribute('hidden', 'until-found');
    }
    await expect(every).toHaveText('Expand all');
    expect(errors).toEqual([]);
  });

  test('a republish that renames a section and adds one swaps them in order, the header\'s text with them', async ({ page }) => {
    const errors = watchErrors(page);
    const swaps = await watchSwaps(page);
    const name = 'live-page-renamed-swap';
    publish(name, sectioned('Live page renamed swap', pond()), '--no-comments', '--summary', 'The first summary.');
    const moved = await openPlain(page, name);
    const line = page.locator('header.artifact-header .artifact-meta');
    await expect(line.locator('a.artifact-versions-link')).toHaveCount(1);

    const sections = pond({ Risks: { heading: 'Hazards' } });
    sections.push(['Costs', ['A heater costs forty pounds.']]);
    const second = publish(name, sectioned('Live page renamed and costed', sections), '--no-comments',
      '--summary', 'The second summary.');
    await page.clock.runFor(CHECK);

    await expect.poll(() => headings(page)).toEqual(['Findings', 'Hazards', 'Next steps', 'Costs']);
    expect(await revisionOf(page)).toBe(second);
    const outline = page.locator('ol.artifact-outline-list a');
    await expect(outline).toHaveText(['Findings', 'Hazards', 'Next steps', 'Costs']);
    await expect(page.locator('ol.artifact-outline-list')).not.toContainText('Risks');
    expect((await swaps()).filter((unit) => unit.kind === 'section')).toEqual([
      { kind: 'section', id: 'risks', change: 'removed' },
      { kind: 'section', id: 'hazards', change: 'added' },
      { kind: 'section', id: 'costs', change: 'added' },
    ]);

    await expect(page.locator('h1.artifact-title')).toHaveText('Live page renamed and costed');
    await expect(page.locator('.artifact-topbar-title')).toHaveText('Live page renamed and costed');
    expect(await page.title()).toBe('Live page renamed and costed · Lotuspod');
    await expect(page.locator('header.artifact-header .artifact-summary')).toHaveText('The second summary.');
    await expect(line.locator('a.artifact-versions-link')).toHaveCount(1);
    // The new sections fold as any other.
    await page.locator('h2#costs button.artifact-section-toggle').click();
    await expect(page.locator('div.artifact-section-body[data-section="costs"]')).toHaveAttribute('hidden', 'until-found');
    await expect(banner(page).node).toHaveCount(0);
    expect(moved.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a swap says what changed in the status line and tints the changed section for a moment', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-noted';
    publish(name, sectioned('Live page noted', pond()), '--no-comments');
    await openPlain(page, name);
    const body = page.locator('.artifact-body');
    const note = page.locator('.artifact-live-page[role="status"] .artifact-live-page-note');

    publish(name, sectioned('Live page noted', pond({
      Risks: { paragraphs: ['The pump will crack unless it is lifted out first.'] },
    })), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(note).toHaveText('Page updated · 1 section changed');
    await expect(note).toBeVisible();
    await expect(banner(page).node).toHaveCount(0);
    for (const node of [body.locator('> h2#risks'), body.locator('> div.artifact-section-body[data-section="risks"]')]) {
      await expect(node).toHaveClass(/\bartifact-swapped\b/);
    }
    for (const node of [body.locator('> h2#findings'), body.locator('> div.artifact-section-body[data-section="findings"]')]) {
      await expect(node).not.toHaveClass(/\bartifact-swapped\b/);
    }
    await page.clock.runFor(2000);
    await expect(body.locator('.artifact-swapped')).toHaveCount(0);
    await expect(note).toBeVisible();
    await page.clock.runFor(4000);
    await expect(note).toHaveCount(0);

    publish(name, sectioned('Live page noted', pond({
      Findings: { paragraphs: ['The pond froze early this year.'] },
      Risks: { paragraphs: ['The pump will crack unless it is lifted out first.'] },
      'Next steps': { paragraphs: ['Order two heaters.'] },
    })), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(note).toHaveText('Page updated · 2 sections changed');
    expect(errors).toEqual([]);
  });

  test('a section above the window that grows leaves the first heading in view where it was', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-place';
    const long = (heading: string, count: number) =>
      Array.from({ length: count }, (_, n) => `${heading}, paragraph ${n + 1}: the pond freezes in January, ` +
        'the pump stops with it, and the heater keeps a hole in the ice open for the fish until the thaw.');
    const sections = (findings: number): [string, string[]][] =>
      [['Findings', long('Findings', findings)], ['Risks', long('Risks', 6)], ['Next steps', long('Next steps', 16)]];
    publish(name, sectioned('Live page place', sections(6)), '--no-comments');
    await openPlain(page, name);
    const heading = page.locator('.artifact-body > h2#next-steps');
    const below = () => page.evaluate(() =>
      document.querySelector('#next-steps')!.getBoundingClientRect().top -
      document.querySelector('.artifact-topbar')!.getBoundingClientRect().bottom);
    await heading.evaluate((node) => {
      const bar = document.querySelector('.artifact-topbar')!.getBoundingClientRect().bottom;
      window.scrollBy(0, node.getBoundingClientRect().top - bar - 200);
    });
    expect(Math.abs(await below() - 200)).toBeLessThanOrEqual(1);
    const y = await page.evaluate(() => window.scrollY);
    expect(y).toBeGreaterThan(0);
    const findings = page.locator('.artifact-body > div.artifact-section-body[data-section="findings"]');
    expect((await findings.boundingBox())!.y + (await findings.boundingBox())!.height).toBeLessThan(0);

    publish(name, sectioned('Live page place', sections(10)), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(findings).toContainText('Findings, paragraph 10:');
    expect(Math.abs(await below() - 200)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(y);
    // Nothing moves it again once the browser has drawn a few frames: its
    // own scroll anchoring does not add to the swap's.
    await page.clock.runFor(100);
    await page.waitForTimeout(200);
    expect(Math.abs(await below() - 200)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('a folded section a republish changes says "changed" on its heading until it is opened', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-folded-changed';
    publish(name, sectioned('Live page folded changed', pond()), '--no-comments');
    await openPlain(page, name);
    const toggle = page.locator('.artifact-body > h2#next-steps button.artifact-section-toggle');
    const mark = toggle.locator('.artifact-section-mark');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(mark).toBeHidden();
    // Its button keeps the focus, which would hold the section back.
    await toggle.blur();

    publish(name, sectioned('Live page folded changed', pond({
      'Next steps': { paragraphs: ['Order two heaters.'] },
    })), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText('changed');
    await toggle.click();
    await expect(page.locator('div.artifact-section-body[data-section="next-steps"]')).toContainText('Order two heaters.');
    await expect(mark).toBeHidden();
    await expect(mark).toHaveText('');
    await toggle.click();
    await expect(mark).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a folded section whose button keeps the focus is held, its heading saying "changed"', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-folded-held';
    publish(name, sectioned('Live page folded held', pond()), '--no-comments');
    await openPlain(page, name);
    const toggle = page.locator('.artifact-body > h2#next-steps button.artifact-section-toggle');
    const mark = toggle.locator('.artifact-section-mark');
    const wrapper = page.locator('div.artifact-section-body[data-section="next-steps"]');
    await toggle.click();
    await expect(toggle).toBeFocused();

    publish(name, sectioned('Live page folded held', pond({
      'Next steps': { paragraphs: ['Order two heaters.'] },
    })), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText('changed');
    await toggle.click();
    await expect(mark).toBeHidden();
    await expect(wrapper.locator('div.artifact-swap-held')).toContainText('This section changed');
    await expect(wrapper).not.toContainText('Order two heaters.');
    await wrapper.getByRole('button', { name: 'Update' }).click();
    await expect(wrapper).toContainText('Order two heaters.');
    await expect(toggle).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('a held section updated while the banner shows draws no status line beside it', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-held-banner';
    const { wrapper, bar } = await holdRisks(page, name);
    await page.clock.runFor(6000);
    // A table is not swapped yet: this revision falls back to the banner.
    publish(name, sectioned(name, pond({
      Findings: { paragraphs: ['The pond froze early this year.', '| Pump | Heater |\n|---|---|\n| off | on |'] },
      Risks: { paragraphs: ['The pump will crack unless it is lifted out first.'] },
    })), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toContainText(NEWER);
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(wrapper('risks')).toContainText('lifted out first');
    await expect(page.locator('.artifact-live-page-note')).toHaveCount(0);
    await expect(banner(page).node).toBeVisible();
    expect(errors).toEqual([]);
  });

  // A page whose Risks section holds the focus as a republish changes it and
  // Findings: Risks is held back.
  async function holdRisks(page: Page, name: string) {
    const swaps = await watchSwaps(page);
    publish(name, sectioned(name, pond()), '--no-comments');
    await openPlain(page, name);
    const body = page.locator('.artifact-body');
    const wrapper = (id: string) => body.locator(`> div.artifact-section-body[data-section="${id}"]`);
    const toggle = body.locator('> h2#risks button.artifact-section-toggle');
    await toggle.focus();
    await expect(toggle).toBeFocused();

    publish(name, sectioned(name, pond({
      Findings: { paragraphs: ['The pond froze early this year.'] },
      Risks: { paragraphs: ['The pump will crack unless it is lifted out first.'] },
    })), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(wrapper('findings')).toContainText('The pond froze early this year.');
    const bar = wrapper('risks').locator('div.artifact-swap-held');
    await expect(bar).toContainText('This section changed');
    await expect(wrapper('risks')).toContainText('The pump may crack in the ice.');
    await expect(wrapper('risks')).not.toContainText('lifted out first');
    await expect(toggle).toBeFocused();
    await expect(page.locator('.artifact-live-page-note')).toHaveText('Page updated · 1 section changed');
    expect((await swaps()).filter((unit) => unit.kind === 'section'))
      .toEqual([{ kind: 'section', id: 'findings', change: 'changed' }]);
    return { swaps, wrapper, toggle, bar };
  }

  test('a changed section holding the focus is held back under a bar until Update', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-held';
    const { swaps, wrapper, toggle, bar } = await holdRisks(page, name);
    // Held until Update, wherever the focus goes and whatever else changes.
    await toggle.blur();
    await page.clock.runFor(6000);
    await expect(page.locator('.artifact-live-page-note')).toHaveCount(0);
    const third = publish(name, sectioned(name, pond({
      Findings: { paragraphs: ['The pond froze early this year.'] },
      Risks: { paragraphs: ['The pump will crack unless it is lifted out first.'] },
      'Next steps': { paragraphs: ['Order two heaters.'] },
    })), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(third);
    await expect(wrapper('next-steps')).toContainText('Order two heaters.');
    await expect(bar).toContainText('This section changed');
    await expect(wrapper('risks')).toContainText('The pump may crack in the ice.');
    await page.clock.runFor(6000);
    await expect(page.locator('.artifact-live-page-note')).toHaveCount(0);

    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(page.locator('.artifact-live-page-note')).toHaveText('Page updated · 1 section changed');
    await expect(wrapper('risks')).toContainText('The pump will crack unless it is lifted out first.');
    await expect(wrapper('risks')).not.toContainText('The pump may crack in the ice.');
    await expect(page.locator('div.artifact-swap-held')).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(wrapper('risks')).toHaveClass(/\bartifact-swapped\b/);
    expect((await swaps()).filter((unit) => unit.kind === 'section')).toEqual([
      { kind: 'section', id: 'findings', change: 'changed' },
      { kind: 'section', id: 'next-steps', change: 'changed' },
      { kind: 'section', id: 'risks', change: 'changed' },
    ]);
    expect(errors).toEqual([]);
  });

  test('a held section is current again once a republish brings back its text', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-held-back';
    const { wrapper, toggle, bar } = await holdRisks(page, name);
    // The bar's own button has the focus as it goes.
    await bar.getByRole('button', { name: 'Update' }).focus();
    const before = await wrapper('risks').evaluate((node) => {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.querySelector('.artifact-swap-held')!.remove();
      return copy.innerHTML;
    });
    const third = publish(name, sectioned(name, pond({
      Findings: { paragraphs: ['The pond froze early this year.'] },
    })), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(third);
    await expect(bar).toHaveCount(0);
    expect(await wrapper('risks').innerHTML()).toBe(before);
    await expect(toggle).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('a fetched copy with another theme falls back to the banner, the body untouched', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-theme';
    const first = publish(name, sectioned('Live page theme', pond()), '--no-comments');
    await page.route((url) => url.pathname === `/${name}.html`, async (route) => {
      if (route.request().resourceType() !== 'fetch') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const text = (await response.text()).replace(/lotuspod\.css\?v=[0-9a-f]+/, 'lotuspod.css?v=000000000000');
      await route.fulfill({ response, body: text });
    });
    await openPlain(page, name);
    const before = await page.locator('.artifact-body').innerHTML();

    publish(name, sectioned('Live page theme', pond({ Risks: { paragraphs: ['A new risk.'] } })), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toContainText(NEWER);
    expect(await page.locator('.artifact-body').innerHTML()).toBe(before);
    expect(await revisionOf(page)).toBe(first);
    expect(errors).toEqual([]);
  });

  test('a republish in another render variant falls back to the banner, the layout untouched', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-variant';
    // Publish's own default is report.
    const first = publish(name, sectioned('Live page variant', pond()), '--no-comments', '--variant', 'article');
    await openPlain(page, name);
    const before = await page.locator('.artifact-body').innerHTML();

    // The revision is the source's: the variant comes with a new intro.
    publish(name, sectioned('Live page variant', pond(), 'The pond, in a report.'), '--no-comments',
      '--variant', 'report');
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toContainText(NEWER);
    await expect(page.locator('main.artifact')).not.toHaveClass(/artifact--report/);
    expect(await page.evaluate(() => fetch(location.href, { cache: 'reload' }).then((r) => r.text())))
      .toContain('artifact--report');
    expect(await page.locator('.artifact-body').innerHTML()).toBe(before);
    expect(await revisionOf(page)).toBe(first);
    expect(errors).toEqual([]);
  });

  test('a republish that changes the outline of a page with a decision falls back to the banner', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-decision-outline';
    const plan: [string, string[]] = ['Decisions for the maintainer', ['One question for the maintainer.',
      '| # | Question | Options | Default | Why it matters |\n|---|---|---|---|---|\n' +
      '| D1 | Which heater? | Small / Large | Small | The pond is deep. |']];
    const first = publish(name, sectioned('Live page decision outline', [plan, ...pond()]), '--no-comments');
    await openPlain(page, name);
    await expect(page.locator('form.artifact-decision')).toHaveCount(1);

    publish(name, sectioned('Live page decision outline', [plan, ...pond({ Risks: { heading: 'Hazards' } })]),
      '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toContainText(NEWER);
    await expect(page.locator('ol.artifact-outline-list')).toContainText('Risks');
    expect(await revisionOf(page)).toBe(first);
    expect(errors).toEqual([]);
  });

  test('a swap that leaves no section to fold hides the outline\'s fold-all button', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-linked-headings';
    publish(name, sectioned('Live page linked headings', pond()), '--no-comments');
    await openPlain(page, name);
    const every = page.locator('nav.artifact-outline button.artifact-sections-all');
    await expect(every).toHaveText('Collapse all');

    const linked = pond().map(([heading, paragraphs]): [string, string[]] =>
      [`[${heading}](#${heading.toLowerCase().replace(/ /g, '-')})`, paragraphs]);
    const second = publish(name, sectioned('Live page linked headings', linked), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    await expect(page.locator('button.artifact-section-toggle')).toHaveCount(0);
    await expect(every).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a framed page that swaps in a tab not shown keeps its "new version" dot until its tab is opened', async ({ page }) => {
    const errors = watchErrors(page);
    const one = { name: 'live-page-tab-one', title: 'Live page tab one' };
    const two = { name: 'live-page-tab-two', title: 'Live page tab two' };
    for (const pod of [one, two]) publish(pod.name, sectioned(pod.title, pond()), '--no-comments');
    await stopClock(page);
    const recorded = (name: string) => page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/seen' && response.request().method() === 'POST' &&
      response.request().postDataJSON()?.page === name);
    const opened = Promise.all([recorded(one.name), recorded(two.name)]);
    await page.goto(`/index.html#tabs=${one.name},${two.name}&on=${two.name}`);
    await opened;
    const strip = page.getByRole('group', { name: 'Open pods' });
    const tab = (pod: { name: string }) => strip.locator(`.pod-tab[data-page="${pod.name}"]`);
    const framed = (pod: { title: string }) => page.frameLocator(`iframe.pod-frame[title="${pod.title}"]`);
    await expect(tab(two).locator('button.pod-tab-title')).toHaveAttribute('aria-current', 'page');

    const posted: string[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === '/api/seen' && sent.method() === 'POST') {
        posted.push(sent.postDataJSON()?.page);
      }
    });
    const CHANGED = 'The pump will crack unless it is lifted out first.';
    const second = publish(one.name, sectioned(one.title, pond({ Risks: { paragraphs: [CHANGED] } })), '--no-comments');
    await page.clock.runFor(CHECK);
    const risks = framed(one).locator('div.artifact-section-body[data-section="risks"]');
    await expect(risks).toContainText(CHANGED);
    await expect(framed(one).locator('meta[name="lotuspod:revision"]')).toHaveAttribute('content', second);
    expect(posted).toEqual([]);

    const read = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/seen' && response.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await read;
    const dot = tab(one).locator('.pod-tab-dot');
    await expect(dot).toHaveText('new version');

    const marked = recorded(one.name);
    await tab(one).locator('button.pod-tab-title').click();
    expect((await marked).request().postDataJSON()?.revision).toBe(second);
    await expect(dot).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a waiting thread's next read swaps the page without the 60-second check", async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-poll';
    listen();
    publish(name, source('Live page poll', 'first'));
    const root = await comment(request, name, 'findings', '@hermes Which heater?');
    expect(root.state).toBe('pending');
    const asked: string[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === '/api/revision') asked.push(sent.url());
    });
    await stopClock(page);
    await open(page, name);
    const moved = watchLoads(page);
    await expect(banner(page).node).toHaveCount(0);

    const second = publish(name, source('Live page poll', 'second'));
    await page.clock.runFor(5000);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    expect(moved.count).toBe(0);
    expect(asked).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Reload shows the new revision at the same place, its thread open and its text unsent', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-reload';
    await fallBack(page, name);
    publish(name, source('Live page reload', 'first', 8));
    const root = await comment(request, name, 'risks', 'Will the pump crack?');
    await stopClock(page);
    await open(page, name);

    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const entry = page.locator(`.artifact-comments-panel li.artifact-comments-entry[data-thread="${root.id}"]`);
    await expect(entry).toHaveClass(/artifact-comments-entry--open/);
    const node = entry.locator('.artifact-comment-thread');
    await node.locator('.artifact-comment-toggle').click();
    const field = node.locator('form.artifact-comment-reply textarea[name="text"]');
    const UNSENT = 'And if the heater fails as well?';
    await field.fill(UNSENT);
    const y = await page.evaluate(() => {
      window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2));
      return window.scrollY;
    });
    expect(y).toBeGreaterThan(300);
    const top = await textTop(page);

    const second = publish(name, source('Live page reload', 'second', 8));
    await page.clock.runFor(CHECK);
    const shown = banner(page);
    await expect(shown.reload).toBeVisible();
    const loaded = page.waitForEvent('load');
    await shown.reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    await expect(entry).toHaveClass(/artifact-comments-entry--open/);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(UNSENT);
    await expect.poll(async () => Math.abs(await textTop(page) - top)).toBeLessThanOrEqual(1);
    await expect(banner(page).node).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('what the reader writes and scrolls while Reload fetches the page is kept too', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-slow';
    await fallBack(page, name);
    publish(name, source('Live page slow', 'first', 8));
    const root = await comment(request, name, 'risks', 'Will the pump crack?');
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const node = page.locator(`.artifact-comments-panel .artifact-comment-thread[data-thread="${root.id}"]`);
    await node.locator('.artifact-comment-toggle').click();
    const field = node.locator('form.artifact-comment-reply textarea[name="text"]');
    await field.fill('And if the heater');

    const second = publish(name, source('Live page slow', 'second', 8));
    await page.clock.runFor(CHECK);
    await expect(banner(page).reload).toBeVisible();
    // The page's fetch before the reload waits until released; the reload
    // itself goes through.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let asked = false;
    await page.route((url) => url.pathname === `/${name}.html`, async (route) => {
      if (route.request().resourceType() === 'fetch') {
        asked = true;
        await held;
      }
      await route.fallback();
    });
    await banner(page).reload.click();
    await expect.poll(() => asked).toBe(true);
    await field.pressSequentially(' fails as well?');
    const y = await page.evaluate(() => {
      window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2));
      return window.scrollY;
    });
    expect(y).toBeGreaterThan(300);
    const top = await textTop(page);
    const loaded = page.waitForEvent('load');
    release();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(field).toHaveValue('And if the heater fails as well?');
    await expect.poll(async () => Math.abs(await textTop(page) - top)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('on a phone, Reload opens the thread in the sheet again at the same scroll position', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = watchErrors(page);
    const name = 'live-page-phone';
    await fallBack(page, name);
    publish(name, source('Live page phone', 'first', 8));
    const root = await comment(request, name, 'risks', 'Will the pump crack?');
    await stopClock(page);
    await open(page, name);

    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const sheet = page.locator('.artifact-comments-bottom-sheet');
    const node = sheet.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
    await expect(node).toBeVisible();
    await node.locator('.artifact-comment-toggle').click();
    const field = node.locator('form.artifact-comment-reply textarea[name="text"]');
    const UNSENT = 'And if the heater fails as well?';
    await field.fill(UNSENT);
    // Well past the thread's chip, which the sheet would scroll back to.
    const y = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight - window.innerHeight);
      return window.scrollY;
    });
    expect(y).toBeGreaterThan(1000);
    const top = await textTop(page);

    const second = publish(name, source('Live page phone', 'second', 8));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(node).toBeVisible();
    await expect(field).toHaveValue(UNSENT);
    await expect.poll(async () => Math.abs(await textTop(page) - top)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  // Select `length` characters of the paragraph holding `words`, from its
  // first or from `from`, and open the passage composer on them.
  async function selectPassage(page: Page, words: string, length: number, from = 0) {
    await page.locator('.artifact-body p', { hasText: words }).evaluate((paragraph, [length, from]) => {
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, from);
      range.setEnd(paragraph.firstChild!, from + length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, [length, from]);
    await page.keyboard.press('Control+Alt+m');
    const field = page.getByRole('textbox', { name: 'Comment on the selected words' });
    await expect(field).toBeFocused();
    return field;
  }

  test('Reload opens a passage composer again on its words, its text unsent', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-passage';
    await fallBack(page, name);
    publish(name, source('Live page passage', 'first'));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, 'Risks, paragraph 1', 18);
    const UNSENT = 'Which pump is this?';
    await field.fill(UNSENT);

    const second = publish(name, source('Live page passage', 'second'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(field).toHaveValue(UNSENT);
    await expect(page.locator('mark.artifact-passage--pending')).toHaveText('Risks, paragraph 1');
    expect(errors).toEqual([]);
  });

  test('a passage comment whose words changed is kept in its section\'s form, saying why', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-passage-gone';
    publish(name, source('Live page passage gone', 'first'));
    await stopClock(page);
    await open(page, name);
    const loads = watchLoads(page);
    const field = await selectPassage(page, 'Risks, paragraph 1', 18);
    const UNSENT = 'Which pump is this?';
    await field.fill(UNSENT);

    // Only Risks changes: the swap holds it back, the composer as it was.
    const second = publish(name, source('Live page passage gone', 'first')
      .replace('Risks, paragraph 1:', 'Risks, first point:'));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    const risks = page.locator('div.artifact-section-body[data-section="risks"]');
    const bar = risks.locator('div.artifact-swap-held');
    await expect(bar).toContainText('This section changed');
    await expect(risks).toContainText('Risks, paragraph 1:');
    await expect(field).toHaveValue(UNSENT);
    await expect(page.locator('mark.artifact-passage--pending')).toHaveText('Risks, paragraph 1');
    await expect(banner(page).node).toHaveCount(0);

    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(risks).toContainText('Risks, first point:');
    await expect(bar).toHaveCount(0);
    await expect(page.locator('mark.artifact-passage--pending')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Risks' }) });
    await expect(form.locator('textarea')).toBeVisible();
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'The words you selected have changed since. Your comment is kept here, on the section.');
    await expect(page.locator('.artifact-passage-composer')).toHaveCount(0);
    expect(loads.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a comment on a section renamed since is kept in the form where the section was, saying why', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-renamed';
    publish(name, source('Live page renamed', 'first'));
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const risks = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    await expect(risks).toBeFocused();
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await risks.fill(UNSENT);

    const loads = watchLoads(page);
    const second = publish(name, source('Live page renamed', 'first').replace(/Risks/g, 'Hazards'));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');
    await expect(risks).toHaveValue(UNSENT);
    await expect(banner(page).node).toHaveCount(0);

    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(page.locator('details.artifact-comment[data-section="risks"]')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards' }) });
    await expect(form.locator('textarea')).toBeVisible();
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    expect(loads.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a comment on a section renamed since joins the form where the section was after a post it is sending there', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-renamed-sending';
    publish(name, source('Live page renamed sending', 'first'));
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const risks = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await risks.fill(UNSENT);

    const loads = watchLoads(page);
    const second = publish(name, source('Live page renamed sending', 'first').replace(/Risks/g, 'Hazards'));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');

    // A Hazards comment is sending when Risks is updated.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === '/api/comments', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      await released;
      await route.continue();
    });
    await page.locator('details.artifact-comment[data-section="hazards"] summary').click();
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards' }) });
    const SENT = 'Is the pipe lagged?';
    await form.locator('textarea').fill(SENT);
    await form.getByRole('button', { name: 'Comment' }).click();
    await expect(form.locator('.artifact-comment-status')).toHaveText('Saving...');
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(page.locator('details.artifact-comment[data-section="risks"]')).toHaveCount(0);

    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      release(),
    ]);
    expect(posted.status()).toBe(201);
    expect(posted.request().postDataJSON().text).toBe(SENT);
    await expect(form.locator('textarea')).toBeVisible();
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    expect(loads.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('an image still uploading to a section renamed since joins the form where the section was', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-renamed-uploading';
    publish(name, source('Live page renamed uploading', 'first'));
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const risks = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await risks.fill(UNSENT);
    const release = await holdUploads(page);
    await pasteFishOnly(risks);
    await expect(page.locator('.artifact-attach-item--loading')).toHaveCount(1);

    const loads = watchLoads(page);
    const second = publish(name, source('Live page renamed uploading', 'first').replace(/Risks/g, 'Hazards'));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');
    await bar.getByRole('button', { name: 'Update' }).click();

    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards' }) });
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-attach-item--loading')).toHaveCount(1);
    const [uploaded] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/media'),
      release(),
    ]);
    expect(uploaded.status()).toBe(201);
    await expect(form.locator('.artifact-attach-item img')).toHaveCount(1);
    const attached = await attachedIn(form);
    expect(attached[0]).toMatch(MEDIA_URL);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    expect(loads.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('an image still uploading to a passage comment whose words changed joins its section\'s form', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-passage-uploading';
    publish(name, source('Live page passage uploading', 'first'));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, 'Risks, paragraph 1', 18);
    const UNSENT = 'Which pump is this?';
    await field.fill(UNSENT);
    const release = await holdUploads(page);
    await pasteFishOnly(field);
    await expect(page.locator('form.artifact-passage-form .artifact-attach-item--loading')).toHaveCount(1);

    const loads = watchLoads(page);
    const second = publish(name, source('Live page passage uploading', 'first')
      .replace('Risks, paragraph 1:', 'Risks, first point:'));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section changed');
    await bar.getByRole('button', { name: 'Update' }).click();

    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Risks' }) });
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-attach-item--loading')).toHaveCount(1);
    const [uploaded] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/media'),
      release(),
    ]);
    expect(uploaded.status()).toBe(201);
    await expect(form.locator('.artifact-attach-item img')).toHaveCount(1);
    expect((await attachedIn(form))[0]).toMatch(MEDIA_URL);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'The words you selected have changed since. Your comment is kept here, on the section.');
    expect(loads.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a comment on a section renamed along with the next is kept in the form where the section was', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-renamed-both';
    publish(name, source('Live page renamed both', 'first'));
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const risks = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    await expect(risks).toBeFocused();
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await risks.fill(UNSENT);

    const loads = watchLoads(page);
    const second = publish(name, source('Live page renamed both', 'first')
      .replace(/Risks/g, 'Hazards').replace(/Next steps/g, 'Actions'));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');

    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(page.locator('details.artifact-comment[data-section="risks"]')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards' }) });
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    await expect(page.locator('.artifact-comments-panel')
      .getByRole('textbox', { name: 'Comment on Actions', includeHidden: true })).toHaveValue('');
    expect(loads.count).toBe(0);
    expect(errors).toEqual([]);
  });

  for (const first of ['Risks', 'Next steps']) {
    test(`comments on two sections renamed together each keep to their own section, ${first} updated first`, async ({ page }) => {
      const errors = watchErrors(page);
      const name = `live-page-renamed-two-${first === 'Risks' ? 'risks' : 'next'}-first`;
      publish(name, source('Live page renamed two', 'first'));
      await stopClock(page);
      await open(page, name);
      const panel = page.locator('.artifact-comments-panel');
      const DRAFTS: Record<string, string> = {
        Risks: 'What cracks first, the pump or the pipe?',
        'Next steps': 'Who orders the heater?',
      };
      for (const [section, id] of [['Risks', 'risks'], ['Next steps', 'next-steps']]) {
        await page.locator(`details.artifact-comment[data-section="${id}"] summary`).click();
        const field = panel.getByRole('textbox', { name: `Comment on ${section}` });
        await expect(field).toBeFocused();
        await field.fill(DRAFTS[section]!);
      }

      const loads = watchLoads(page);
      const second = publish(name, source('Live page renamed two', 'first')
        .replace(/Risks/g, 'Hazards').replace(/Next steps/g, 'Actions'));
      await page.clock.runFor(CHECK);
      await expect.poll(() => revisionOf(page)).toBe(second);
      const bars = {
        Risks: page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held'),
        'Next steps': page.locator('div.artifact-section-body[data-section="next-steps"] div.artifact-swap-held'),
      };
      await expect(bars.Risks).toContainText('This section was removed');
      await expect(bars['Next steps']).toContainText('This section was removed');

      const order = first === 'Risks' ? ['Risks', 'Next steps'] as const : ['Next steps', 'Risks'] as const;
      for (const section of order) {
        await bars[section].getByRole('button', { name: 'Update' }).click();
        await expect(bars[section]).toHaveCount(0);
      }
      for (const [renamed, section] of [['Hazards', 'Risks'], ['Actions', 'Next steps']]) {
        const form = panel.locator('form.artifact-comment-form')
          .filter({ has: page.getByRole('textbox', { name: `Comment on ${renamed}`, includeHidden: true }) });
        await expect(form.locator('textarea')).toHaveValue(DRAFTS[section]!);
        await expect(form.locator('.artifact-comment-status')).toHaveText(
          'Where you were writing has changed since. Your text is kept here.');
      }
      expect(loads.count).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  for (const first of ['Risks', 'Next steps']) {
    test(`comments on the later two of three sections renamed together keep to their own sections when the first goes at once, ${first} updated first`, async ({ page }) => {
      const errors = watchErrors(page);
      const name = `live-page-renamed-three-${first === 'Risks' ? 'risks' : 'next'}-first`;
      publish(name, source('Live page renamed three', 'first'));
      await stopClock(page);
      await open(page, name);
      const panel = page.locator('.artifact-comments-panel');
      const DRAFTS: Record<string, string> = {
        Risks: 'What cracks first, the pump or the pipe?',
        'Next steps': 'Who orders the heater?',
      };
      for (const [section, id] of [['Risks', 'risks'], ['Next steps', 'next-steps']]) {
        await page.locator(`details.artifact-comment[data-section="${id}"] summary`).click();
        const field = panel.getByRole('textbox', { name: `Comment on ${section}` });
        await expect(field).toBeFocused();
        await field.fill(DRAFTS[section]!);
      }

      const loads = watchLoads(page);
      const second = publish(name, source('Live page renamed three', 'first')
        .replace(/Findings/g, 'Observations').replace(/Risks/g, 'Hazards').replace(/Next steps/g, 'Actions'));
      await page.clock.runFor(CHECK);
      await expect.poll(() => revisionOf(page)).toBe(second);
      await expect(page.locator('div.artifact-section-body[data-section="findings"]')).toHaveCount(0);
      const bars = {
        Risks: page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held'),
        'Next steps': page.locator('div.artifact-section-body[data-section="next-steps"] div.artifact-swap-held'),
      };
      await expect(bars.Risks).toContainText('This section was removed');
      await expect(bars['Next steps']).toContainText('This section was removed');

      const order = first === 'Risks' ? ['Risks', 'Next steps'] as const : ['Next steps', 'Risks'] as const;
      for (const section of order) {
        await bars[section].getByRole('button', { name: 'Update' }).click();
        await expect(bars[section]).toHaveCount(0);
      }
      const form = (renamed: string) => panel.locator('form.artifact-comment-form')
        .filter({ has: page.getByRole('textbox', { name: `Comment on ${renamed}`, includeHidden: true }) });
      for (const [renamed, section] of [['Hazards', 'Risks'], ['Actions', 'Next steps']]) {
        await expect(form(renamed).locator('textarea')).toHaveValue(DRAFTS[section]!);
        await expect(form(renamed).locator('.artifact-comment-status')).toHaveText(
          'Where you were writing has changed since. Your text is kept here.');
      }
      await expect(form('Observations').locator('textarea')).toHaveValue('');
      expect(loads.count).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test('a comment on the later of two sections renamed together keeps to its own section when the earlier goes at once', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-renamed-two-later-only';
    publish(name, source('Live page renamed two', 'first'));
    await stopClock(page);
    await open(page, name);
    const panel = page.locator('.artifact-comments-panel');
    const draft = 'Who orders the heater?';
    await page.locator('details.artifact-comment[data-section="next-steps"] summary').click();
    const field = panel.getByRole('textbox', { name: 'Comment on Next steps' });
    await expect(field).toBeFocused();
    await field.fill(draft);

    const loads = watchLoads(page);
    const second = publish(name, source('Live page renamed two', 'first')
      .replace(/Risks/g, 'Hazards').replace(/Next steps/g, 'Actions'));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(page.locator('div.artifact-section-body[data-section="risks"]')).toHaveCount(0);
    const bar = page.locator('div.artifact-section-body[data-section="next-steps"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');

    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(bar).toHaveCount(0);
    const form = (renamed: string) => panel.locator('form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: `Comment on ${renamed}`, includeHidden: true }) });
    await expect(form('Actions').locator('textarea')).toHaveValue(draft);
    await expect(form('Actions').locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    await expect(form('Hazards').locator('textarea')).toHaveValue('');
    expect(loads.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a hidden page with nothing unsent has reloaded itself before it is seen again', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-hidden';
    await fallBack(page, name);
    const first = publish(name, source('Live page hidden', 'first'));
    await stopClock(page);
    await open(page, name);
    await setVisibility(page, 'hidden');

    const second = publish(name, source('Live page hidden', 'second'));
    expect(second).not.toBe(first);
    const loaded = page.waitForEvent('load');
    await page.clock.runFor(CHECK);
    await loaded;
    await setVisibility(page, 'visible');

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    await expect(banner(page).node).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a hidden page with unsent text waits for the reader, the banner showing and the text intact', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-unsent';
    await fallBack(page, name);
    const first = publish(name, source('Live page unsent', 'first'));
    await stopClock(page);
    await open(page, name);
    // No thread yet: the chip opens the section's form for a new one.
    await page.locator('details.artifact-comment[data-section="findings"] summary').click();
    const field = page.locator('.artifact-comments-panel')
      .getByRole('textbox', { name: 'Comment on Findings' });
    await expect(field).toBeFocused();
    const UNSENT = 'Half a thought about the pump';
    await field.fill(UNSENT);
    await page.evaluate(() => { (window as any).__stayed = 'this page'; });
    await setVisibility(page, 'hidden');

    publish(name, source('Live page unsent', 'second'));
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toBeAttached();
    await setVisibility(page, 'visible');

    await expect(banner(page).node).toBeVisible();
    await expect(banner(page).node).toContainText(NEWER);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    expect(await revisionOf(page)).toBe(first);
    await expect(field).toHaveValue(UNSENT);
    expect(errors).toEqual([]);
  });

  test('a hidden page with only an image attached waits for the reader, the image intact', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-unsent-image';
    await fallBack(page, name);
    const first = publish(name, source('Live page unsent image', 'first'));
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="findings"] summary').click();
    const field = page.locator('.artifact-comments-panel')
      .getByRole('textbox', { name: 'Comment on Findings' });
    await expect(field).toBeFocused();
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Findings' }) });
    await pasteFish(page, field);
    await expect(form.locator('.artifact-attach-item img')).toHaveCount(1);
    const attached = await attachedIn(form);
    await page.evaluate(() => { (window as any).__stayed = 'this page'; });
    await setVisibility(page, 'hidden');

    publish(name, source('Live page unsent image', 'second'));
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toBeAttached();
    await setVisibility(page, 'visible');

    await expect(banner(page).node).toBeVisible();
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    expect(await revisionOf(page)).toBe(first);
    expect(await attachedIn(form)).toEqual(attached);
    expect(errors).toEqual([]);
  });

  test('Reload keeps the image attached in a reply with no text, and the reply sends it', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-reply-image';
    await fallBack(page, name);
    publish(name, source('Live page reply image', 'first'));
    const root = await comment(request, name, 'risks', 'What does the ice look like?');
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const entry = page.locator(`.artifact-comments-panel li.artifact-comments-entry[data-thread="${root.id}"]`);
    await expect(entry).toHaveClass(/artifact-comments-entry--open/);
    const node = entry.locator('.artifact-comment-thread');
    await node.locator('.artifact-comment-toggle').click();
    const form = node.locator('form.artifact-comment-reply');
    const field = form.locator('textarea[name="text"]');
    await pasteFish(page, field);
    const attached = await attachedIn(form);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatch(MEDIA_URL);

    const second = publish(name, source('Live page reply image', 'second'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('');
    await expect(form.locator('.artifact-attach-item img')).toHaveCount(1);
    expect(await attachedIn(form)).toEqual(attached);
    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      form.getByRole('button', { name: 'Send' }).click(),
    ]);
    expect(posted.status()).toBe(201);
    expect((await posted.json()).images.map((image: { url: string }) => image.url)).toEqual(attached);
    expect(errors).toEqual([]);
  });

  test('Reload opens a passage composer again with the image attached in it', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-passage-image';
    await fallBack(page, name);
    publish(name, source('Live page passage image', 'first'));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, 'Risks, paragraph 1', 18);
    const form = page.locator('form.artifact-passage-form');
    await pasteFish(page, field);
    const attached = await attachedIn(form);
    expect(attached).toHaveLength(1);

    const second = publish(name, source('Live page passage image', 'second'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('mark.artifact-passage--pending')).toHaveText('Risks, paragraph 1');
    await expect(form.locator('.artifact-attach-item img')).toHaveCount(1);
    expect(await attachedIn(form)).toEqual(attached);
    expect(errors).toEqual([]);
  });

  test('with storage that throws, the banner still shows and Reload still reloads', async ({ page }) => {
    const errors = watchErrors(page);
    await page.addInitScript(() => {
      const refuse = () => { throw new DOMException('Storage is refused', 'SecurityError'); };
      for (const method of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
        Object.defineProperty(Storage.prototype, method, { value: refuse, configurable: true });
      }
      for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, name, { get: refuse, configurable: true });
      }
    });
    const name = 'live-page-storage';
    await fallBack(page, name);
    publish(name, source('Live page storage', 'first'));
    await stopClock(page);
    await open(page, name);
    expect(await page.evaluate(() => {
      try {
        window.sessionStorage.getItem('x');
        return 'kept';
      } catch {
        return 'refused';
      }
    })).toBe('refused');

    const second = publish(name, source('Live page storage', 'second'));
    await page.clock.runFor(CHECK);
    const shown = banner(page);
    await expect(shown.node).toContainText(NEWER);
    const loaded = page.waitForEvent('load');
    await shown.reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    await expect(banner(page).node).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  // A page with comments on, its sections POND's, and a thread on Risks.
  async function commented(page: Page, request: APIRequestContext, name: string) {
    const first = publish(name, sectioned(name, pond()));
    const root = await comment(request, name, 'risks', 'Will the pump crack?');
    await stopClock(page);
    await open(page, name);
    const moved = watchLoads(page);
    await page.evaluate(() => { (window as any).__stayed = 'this page'; });
    return { first, root, moved };
  }

  const RISKY = 'The pump will crack unless it is lifted out first.';
  const box = (page: Page, id: string) => page.locator(`details.artifact-comment[data-section="${id}"]`);
  const group = (page: Page, title: string) => page.locator('.artifact-comments-panel .artifact-comments-group')
    .filter({ has: page.locator('.artifact-comments-group-title', { hasText: new RegExp(`^${title}$`) }) });

  test('a page with comments swaps a changed section in place, its thread open in the panel and its chip as it was', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-swap';
    const { first, root, moved } = await commented(page, request, name);
    await box(page, 'risks').locator('summary').click();
    const entry = page.locator(`.artifact-comments-panel li.artifact-comments-entry[data-thread="${root.id}"]`);
    await expect(entry).toHaveClass(/artifact-comments-entry--open/);
    const node = entry.locator('.artifact-comment-thread');
    await node.locator('.artifact-comment-toggle').click();
    const reply = node.locator('form.artifact-comment-reply textarea[name="text"]');
    const UNSENT = 'And if the heater fails as well?';
    await reply.fill(UNSENT);
    const chip = await box(page, 'risks').locator('summary').textContent();
    await box(page, 'risks').evaluate((element) => { (element as any).__before = true; });

    const second = publish(name, sectioned(name, pond({ Risks: { paragraphs: [RISKY, 'The fish need air under it.'] } })));
    expect(second).not.toBe(first);
    await page.clock.runFor(CHECK);
    const risks = page.locator('div.artifact-section-body[data-section="risks"]');
    await expect(risks).toContainText(RISKY);
    await expect(risks).not.toContainText('The pump may crack in the ice.');
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    expect(moved.count).toBe(0);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');

    await expect(box(page, 'risks')).toHaveCount(1);
    expect(await box(page, 'risks').evaluate((element) => (element as any).__before)).toBeUndefined();
    await expect(box(page, 'risks').locator('summary')).toHaveText(chip!);
    await expect(group(page, 'Risks').locator(`li.artifact-comments-entry[data-thread="${root.id}"]`))
      .toHaveClass(/artifact-comments-entry--open/);
    await expect(reply).toBeVisible();
    await expect(reply).toHaveValue(UNSENT);

    // A new thread from the Risks group goes to the new box's section, at
    // the new revision.
    await page.locator('.artifact-comments-panel').getByRole('button', { name: 'Comment on a section' }).click();
    await page.locator('.artifact-comments-choices').getByRole('option', { name: 'Risks' }).click();
    const field = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    await expect(field).toBeFocused();
    await field.fill('Should the pump come out now?');
    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      group(page, 'Risks').getByRole('button', { name: 'Comment', exact: true }).click(),
    ]);
    expect(posted.status()).toBe(201);
    expect(posted.request().postDataJSON()).toMatchObject({ page: name, section: 'risks', revision: second });
    const row = await posted.json();
    expect(row).toMatchObject({ section: 'risks', revision: second });
    await expect(group(page, 'Risks').locator(`li.artifact-comments-entry[data-thread="${row.id}"]`)).toHaveCount(1);
    await expect(page.locator('.artifact-comments-panel li.artifact-comments-entry')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('a section\'s form opened in the panel keeps its text when its section is swapped', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-form';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    const moved = watchLoads(page);
    await box(page, 'risks').locator('summary').click();
    const field = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    await expect(field).toBeFocused();
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await field.fill(UNSENT);

    const second = publish(name, sectioned(name, pond({ Risks: { paragraphs: [RISKY] } })));
    await page.clock.runFor(CHECK);
    await expect(page.locator('div.artifact-section-body[data-section="risks"]')).toContainText(RISKY);
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    expect(moved.count).toBe(0);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(UNSENT);
    await expect(group(page, 'Risks').locator('.artifact-comments-compose')).toBeVisible();
    // The form is the section's still, and the new box holds none of its own.
    await expect(box(page, 'risks').locator('form')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Comment on Risks' })).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('a section renamed by a republish swaps in, its threads listed with the sections that have changed', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-renamed';
    const { root, moved } = await commented(page, request, name);
    await box(page, 'risks').locator('summary').click();
    const entry = page.locator(`.artifact-comments-panel li.artifact-comments-entry[data-thread="${root.id}"]`);
    await expect(entry).toHaveClass(/artifact-comments-entry--open/);

    const second = publish(name, sectioned(name, pond({ Risks: { heading: 'Hazards' } })));
    await page.clock.runFor(CHECK);
    await expect.poll(() => headings(page)).toEqual(['Findings', 'Hazards', 'Next steps']);
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    expect(moved.count).toBe(0);
    await expect(box(page, 'risks')).toHaveCount(0);

    const strays = group(page, 'Sections that have changed');
    await expect(strays).toBeVisible();
    await expect(strays.locator(`li.artifact-comments-entry[data-thread="${root.id}"]`)).toHaveCount(1);
    await expect(entry.locator('.artifact-comment-section')).toHaveText('On Risks');
    await expect(group(page, 'Risks')).toHaveCount(0);

    await page.locator('.artifact-comments-panel').getByRole('button', { name: 'Comment on a section' }).click();
    const choices = page.locator('.artifact-comments-choices').getByRole('option');
    await expect(choices).toHaveText(['This page', 'Findings', 'Hazards', 'Next steps']);
    await page.keyboard.press('Escape');

    await box(page, 'hazards').locator('summary').click();
    const hazards = group(page, 'Hazards');
    await expect(hazards).toBeVisible();
    const field = hazards.getByRole('textbox', { name: 'Comment on Hazards' });
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('on a phone, a thread open in the sheet stays open with its reply text as its section is swapped', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = watchErrors(page);
    const name = 'live-page-comments-phone';
    const { root, moved } = await commented(page, request, name);
    await box(page, 'risks').locator('summary').click();
    const sheet = page.locator('.artifact-comments-bottom-sheet');
    const node = sheet.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
    await expect(node).toBeVisible();
    await node.locator('.artifact-comment-toggle').click();
    const field = node.locator('form.artifact-comment-reply textarea[name="text"]');
    const UNSENT = 'And if the heater fails as well?';
    await field.fill(UNSENT);

    const second = publish(name, sectioned(name, pond({ Risks: { paragraphs: [RISKY] } })));
    await page.clock.runFor(CHECK);
    await expect(page.locator('div.artifact-section-body[data-section="risks"]')).toContainText(RISKY);
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    expect(moved.count).toBe(0);
    await expect(sheet).toBeVisible();
    await expect(node).toBeVisible();
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(UNSENT);
    await expect(field).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('in a narrow window, a popover open on a swapped section\'s chip stays open under its new chip', async ({ page, request }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    const errors = watchErrors(page);
    const name = 'live-page-comments-popover';
    const { root, moved } = await commented(page, request, name);
    await box(page, 'risks').locator('summary').click();
    const popover = page.locator('.artifact-comments-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator(`li.artifact-comments-entry[data-thread="${root.id}"]`)).toHaveCount(1);

    const second = publish(name, sectioned(name, pond({ Risks: { paragraphs: [RISKY] } })));
    await page.clock.runFor(CHECK);
    await expect(page.locator('div.artifact-section-body[data-section="risks"]')).toContainText(RISKY);
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    expect(moved.count).toBe(0);
    await expect(popover).toBeVisible();
    await expect(popover.locator(`li.artifact-comments-entry[data-thread="${root.id}"]`)).toHaveCount(1);
    // Under the new chip, which closes it as the old one did.
    const chip = (await box(page, 'risks').locator('summary').boundingBox())!;
    expect(Math.abs((await popover.boundingBox())!.y - (chip.y + chip.height + 12))).toBeLessThanOrEqual(1);
    await box(page, 'risks').locator('summary').click();
    await expect(popover).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a swap that changes the title keeps it in the tab after the next read of the threads', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-title';
    listen();
    publish(name, source('Live page title', 'first'));
    const root = await comment(request, name, 'findings', '@hermes Which heater?');
    expect(root.state).toBe('pending');
    await stopClock(page);
    await open(page, name);
    expect(await page.title()).toBe('Live page title · Lotuspod');

    const second = publish(name, source('Live page title renamed', 'second'));
    await page.clock.runFor(5000);
    await expect(page.locator('h1.artifact-title')).toHaveText('Live page title renamed');
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    const read = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'GET');
    await page.clock.runFor(30_000);
    await read;
    await expect.poll(() => page.title()).toBe('Live page title renamed · Lotuspod');
    expect(errors).toEqual([]);
  });

  test('a passage highlighted in a section a republish changes is highlighted again in its new text', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-passage';
    const first = publish(name, sectioned(name, pond()));
    const response = await request.post('/api/comments', {
      headers: SIGNED_IN,
      data: {
        page: name, section: 'risks', text: 'Which pump?', revision: first,
        quote: { exact: 'The pump may crack in the ice.', prefix: '', suffix: '' },
      },
    });
    expect(response.status()).toBe(201);
    await stopClock(page);
    await open(page, name);
    await expect(page.locator('mark.artifact-passage')).toHaveText('The pump may crack in the ice.');

    const second = publish(name, sectioned(name, pond({ Risks: { paragraphs: [RISKY, 'The pump may crack in the ice.'] } })));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);
    await expect(page.locator('div.artifact-section-body[data-section="risks"]')).toContainText(RISKY);
    await expect(page.locator('mark.artifact-passage')).toHaveText('The pump may crack in the ice.');
    await expect(page.locator('.artifact-passage-number')).toHaveText(['1']);
    expect(errors).toEqual([]);
  });

  test('a removed section held back while its form holds a draft keeps the draft on Update', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-held-draft';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    const toggle = page.locator('.artifact-body > h2#risks button.artifact-section-toggle');
    await toggle.focus();

    publish(name, sectioned(name, pond({ Risks: { heading: 'Hazards' } })));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');
    await box(page, 'risks').locator('summary').click();
    const field = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    await expect(field).toBeFocused();
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await field.fill(UNSENT);

    const loads = watchLoads(page);
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(box(page, 'risks')).toHaveCount(0);
    expect(loads.count).toBe(0);
    // Kept in a section's form, saying why, as after a reload.
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form').filter({
      has: page.locator('.artifact-comment-status', { hasText: 'Where you were writing has changed since.' }),
    });
    await expect(form.locator('textarea')).toBeVisible();
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    expect(errors).toEqual([]);
  });

  test('a section removed while its form holds a draft keeps the draft where it was, in the next section, on Update', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-removed-draft';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    await box(page, 'risks').locator('summary').click();
    const field = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    await expect(field).toBeFocused();
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await field.fill(UNSENT);

    const loads = watchLoads(page);
    publish(name, sectioned(name, pond().filter(([heading]) => heading !== 'Risks')));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(box(page, 'risks')).toHaveCount(0);
    // Where a reload puts it: the box now in Risks' place.
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Next steps' }) });
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    const findings = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Findings', includeHidden: true });
    await expect(findings).toHaveValue('');
    expect(loads.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a passage comment in a section renamed with its words changed is kept in the renamed section\'s form', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-renamed-passage';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, 'The pump may crack', 8);
    const UNSENT = 'Which pump is this?';
    await field.fill(UNSENT);

    const loads = watchLoads(page);
    publish(name, sectioned(name, pond({ Risks: { heading: 'Hazards', paragraphs: [RISKY] } })));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');
    await expect(field).toHaveValue(UNSENT);
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(box(page, 'risks')).toHaveCount(0);
    await expect(page.locator('mark.artifact-passage--pending')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards' }) });
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'The words you selected have changed since. Your comment is kept here, on the section.');
    await expect(page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Next steps', includeHidden: true }))
      .toHaveValue('');
    expect(loads.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a passage comment still sending when its held section is updated is saved once, not kept as a draft', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-sending-passage';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, 'The pump may crack', 8);
    const SENT = 'Which pump is this?';
    await field.fill(SENT);

    publish(name, sectioned(name, pond({ Risks: { paragraphs: [RISKY, 'The fish need air under it.'] } })));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section changed');

    // The post waits until the section is updated.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const posts: number[] = [];
    await page.route((url) => url.pathname === '/api/comments', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      await released;
      const response = await route.fetch();
      posts.push(response.status());
      await route.fulfill({ response });
    });
    await page.locator('form.artifact-passage-form button[type="submit"]').click();
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(page.locator('div.artifact-section-body[data-section="risks"]')).toContainText(RISKY);
    release();

    await expect(page.locator('.artifact-comments-panel .artifact-comments-entry')).toHaveCount(1);
    expect(posts).toEqual([201]);
    await expect(page.locator('.artifact-passage-composer')).toHaveCount(0);
    const risks = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Risks', includeHidden: true }) });
    await expect(risks.locator('textarea')).toHaveValue('');
    await expect(risks.locator('.artifact-comment-status')).toHaveText('');
    expect(errors).toEqual([]);
  });

  test('a held section renamed by a later republish keeps its draft in the renamed section\'s form on Update', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-held-renamed';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    await box(page, 'risks').locator('summary').click();
    const field = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await field.fill(UNSENT);
    await page.locator('.artifact-body > h2#risks button.artifact-section-toggle').focus();

    publish(name, sectioned(name, pond({ Risks: { paragraphs: [RISKY] } })));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section changed');
    const renamed = publish(name, sectioned(name, pond({ Risks: { heading: 'Hazards', paragraphs: [RISKY] } })));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(renamed);
    await expect(bar).toContainText('This section was removed');

    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(box(page, 'risks')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards', includeHidden: true }) });
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    await expect(page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Next steps', includeHidden: true }))
      .toHaveValue('');
    expect(errors).toEqual([]);
  });

  test('a held section renamed and then changed again keeps its draft in the renamed section\'s form on Update', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-renamed-changed';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    await box(page, 'risks').locator('summary').click();
    const field = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await field.fill(UNSENT);

    publish(name, sectioned(name, pond({ Risks: { heading: 'Hazards' } })));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');
    // Hazards, added in its place, changes again before the reader's Update.
    const changed = publish(name, sectioned(name, pond({ Risks: { heading: 'Hazards', paragraphs: [RISKY] } })));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(changed);
    await expect(page.locator('div.artifact-section-body[data-section="hazards"]')).toContainText(RISKY);
    await expect(bar).toContainText('This section was removed');

    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(box(page, 'risks')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards', includeHidden: true }) });
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    await expect(page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Next steps', includeHidden: true }))
      .toHaveValue('');
    expect(errors).toEqual([]);
  });

  test('a passage comment that fails to send after its held section is updated leaves a composer opened since as it is', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-failed-passage';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    const first = await selectPassage(page, 'The pump may crack', 8);
    const SENT = 'Which pump is this?';
    await first.fill(SENT);

    // Its words stay; the paragraph after them changes.
    publish(name, sectioned(name, pond({ Risks: { paragraphs: ['The pump may crack in the ice.', 'The fish need air all winter.'] } })));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section changed');

    // The post waits until another composer is open, then fails.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let failed = 0;
    await page.route((url) => url.pathname === '/api/comments', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      await released;
      failed += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' });
    });
    await page.locator('form.artifact-passage-form button[type="submit"]').click();
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(page.locator('div.artifact-section-body[data-section="risks"]')).toContainText('The fish need air all winter.');

    const second = await selectPassage(page, 'The pond freezes', 8);
    const LATER = 'How thick does it get?';
    await second.fill(LATER);
    release();
    await expect.poll(() => failed).toBe(1);

    const risks = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Risks', includeHidden: true }) });
    await expect(risks.locator('textarea')).toHaveValue(SENT);
    await expect(risks.locator('.artifact-comment-status')).toHaveText(
      'The words you selected have changed since. Your comment is kept here, on the section.');
    await expect(page.locator('.artifact-passage-composer')).toHaveCount(1);
    await expect(second).toHaveValue(LATER);
    await expect(page.locator('mark.artifact-passage--pending')).toHaveText('The pond');
    // The failed post is logged by the browser; nothing else is.
    expect(errors.filter((error) => !error.includes('status of 500'))).toEqual([]);
  });

  test('a passage comment saved after its held section is updated is highlighted on its own words, not on others where they were', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-moved-passage';
    // Words far enough into their paragraph that what comes before them
    // can grow and leave their context as it is.
    const LEAD = 'Ice forms first along the edges, thick by the new year. ';
    const WORDS = `${LEAD}The pump may crack.`;
    publish(name, sectioned(name, pond({ Risks: { paragraphs: [WORDS, POND[1][1][1]] } })));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, WORDS, 'The pump'.length, LEAD.length);
    await field.fill('Which pump is this?');

    // The same words, ahead of them, where they were; theirs move on.
    const AHEAD = `${LEAD}The pump hums all winter long. `;
    publish(name, sectioned(name, pond({ Risks: { paragraphs: [AHEAD + WORDS, POND[1][1][1]] } })));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section changed');

    // The post waits until the reader has updated the section.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let posted = 0;
    await page.route((url) => url.pathname === '/api/comments', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      await released;
      posted += 1;
      await route.fallback();
    });
    await page.locator('form.artifact-passage-form button[type="submit"]').click();
    await bar.getByRole('button', { name: 'Update' }).click();
    const risks = page.locator('div.artifact-section-body[data-section="risks"]');
    await expect(risks).toContainText(AHEAD);
    release();
    await expect.poll(() => posted).toBe(1);

    const mark = risks.locator('mark.artifact-passage');
    await expect(mark).toHaveText('The pump');
    // Its own words, after the others, not the others where they were.
    expect(await mark.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node.closest('p')!);
      range.setEnd(node, 0);
      return range.toString().length;
    })).toBe(AHEAD.length + LEAD.length);
    expect(errors).toEqual([]);
  });

  test('a section comment still sending when its section is taken away is saved once, not kept as a draft', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-sending-section';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    await box(page, 'risks').locator('summary').click();
    const field = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    await field.fill('What cracks first, the pump or the pipe?');

    // The site saves it at once; its answer waits until the section is updated.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const posts: number[] = [];
    await page.route((url) => url.pathname === '/api/comments', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      posts.push(response.status());
      await released;
      await route.fulfill({ response });
    });
    await field.press('ControlOrMeta+Enter');
    await expect.poll(() => posts).toEqual([201]);

    publish(name, sectioned(name, pond({ Risks: { heading: 'Hazards' } })));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(box(page, 'risks')).toHaveCount(0);
    release();

    await expect(page.locator('.artifact-comments-panel .artifact-comments-entry')).toHaveCount(1);
    const hazards = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards', includeHidden: true }) });
    await expect(hazards.locator('textarea')).toHaveValue('');
    await expect(hazards.locator('.artifact-comment-status')).toHaveText('');
    expect(posts).toEqual([201]);
    expect(errors).toEqual([]);
  });

  test('a republish that turns comments on falls back to the banner', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-on';
    const first = publish(name, sectioned(name, pond()), '--no-comments');
    await openPlain(page, name);
    publish(name, sectioned(name, pond({ Risks: { paragraphs: [RISKY] } })));
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toContainText(NEWER);
    await expect(page.locator('details.artifact-comment')).toHaveCount(0);
    expect(await revisionOf(page)).toBe(first);
    expect(errors).toEqual([]);
  });

  test('passages number in page order after a swap moves the text before them', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-numbers';
    const first = publish(name, sectioned(name, pond()));
    const response = await request.post('/api/comments', {
      headers: SIGNED_IN,
      data: {
        page: name, section: 'next-steps', text: 'Which heater?', revision: first,
        quote: { exact: 'Order a heater before the frost.', prefix: '', suffix: '' },
      },
    });
    expect(response.status()).toBe(201);
    await stopClock(page);
    await open(page, name);
    await expect(page.locator('.artifact-passage-number')).toHaveText(['1']);

    const long = Array.from({ length: 12 }, (_, n) => `Finding ${n + 1}: the pond froze early and stayed frozen for weeks.`);
    const second = publish(name, sectioned(name, pond({ Findings: { paragraphs: long } })));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    await expect(banner(page).node).toHaveCount(0);

    const field = await selectPassage(page, 'The pump may crack', 8);
    await field.fill('Which pump?');
    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      page.locator('form.artifact-passage-form button[type="submit"]').click(),
    ]);
    expect(posted.status()).toBe(201);
    await expect(page.locator('.artifact-passage-number')).toHaveText(['1', '2']);
    await expect(page.locator('div.artifact-section-body[data-section="risks"] .artifact-passage-number')).toHaveText('1');
    expect(errors).toEqual([]);
  });

  test('Update on a held section holding a passage composer opens it again on its words', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-held-passage';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    const toggle = page.locator('.artifact-body > h2#risks button.artifact-section-toggle');
    await toggle.focus();

    // The words selected and those around them stay; a paragraph is added.
    publish(name, sectioned(name, pond({
      Risks: { paragraphs: ['The pump may crack in the ice.', 'The fish need air under it.', RISKY] },
    })));
    await page.clock.runFor(CHECK);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section changed');
    const field = await selectPassage(page, 'The pump may crack', 8);
    const UNSENT = 'Which pump is this?';
    await field.fill(UNSENT);

    const loads = watchLoads(page);
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(page.locator('div.artifact-section-body[data-section="risks"]')).toContainText(RISKY);
    expect(loads.count).toBe(0);
    await expect(field).toHaveValue(UNSENT);
    await expect(page.locator('mark.artifact-passage--pending')).toHaveText('The pump');
    expect(errors).toEqual([]);
  });

  test('a passage composer open through a swap posts on the words selected, not the same words before them', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-comments-composer-moved';
    const TWICE = 'The fish need air under the ice.';
    publish(name, sectioned(name, pond({ Risks: { paragraphs: [TWICE, TWICE] } })));
    await stopClock(page);
    await open(page, name);
    const second = page.locator('div.artifact-section-body[data-section="risks"] p').nth(1);
    await second.evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph.firstChild!);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+Alt+m');
    const field = page.getByRole('textbox', { name: 'Comment on the selected words' });
    await expect(field).toBeFocused();
    await field.fill('Which one?');

    // Findings grows by the gap between the two sentences, so the first now
    // starts where the second did.
    const grown = `The pond freezes in January. ${'a'.repeat(TWICE.length)}`;
    const revised = publish(name, sectioned(name, pond({
      Findings: { paragraphs: [grown, 'The pump stops with it.'] }, Risks: { paragraphs: [TWICE, TWICE] },
    })));
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(revised);
    await expect(banner(page).node).toHaveCount(0);

    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      page.locator('form.artifact-passage-form button[type="submit"]').click(),
    ]);
    expect(posted.status()).toBe(201);
    await expect(second.locator('mark.artifact-passage')).toHaveText(TWICE);
    await expect(page.locator('div.artifact-section-body[data-section="risks"] p').nth(0).locator('mark')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  // A "Decisions for the maintainer" section of two questions, the first
  // worded as first says.
  function decisions(first = 'Which heater?'): [string, string[]] {
    return ['Decisions for the maintainer', ['Two questions for the maintainer.',
      '| # | Question | Options | Default |\n| --- | --- | --- | --- |\n' +
      `| 1 | ${first} | Small / Large | Small |\n` +
      '| 2 | Lift the pump out? | Yes / No | No |']];
  }

  function card(page: Page, question: string) {
    const form = page.locator(`form.artifact-decision[data-question="${question}"]`);
    return {
      form,
      option: (name: string) => form.getByRole('radio', { name }),
      save: form.getByRole('button', { name: 'Save answer' }),
      ask: form.getByRole('button', { name: 'Ask', exact: true }),
      saved: form.locator('.artifact-decision-saved-line'),
      earlier: form.locator('.artifact-decision-earlier'),
      text: form.locator('.artifact-decision-text'),
      chip: page.locator(`form.artifact-decision[data-question="${question}"] + .artifact-decision-chip`),
    };
  }

  // Save an answer through a form's "Save answer".
  async function answer(page: Page, question: string, option: string) {
    const made = card(page, question);
    await made.option(option).check();
    const [saved] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/answers' && r.request().method() === 'POST'),
      made.save.click(),
    ]);
    expect(saved.status()).toBe(201);
  }

  // The body's children after its last section: the Answered table alone.
  function afterSections(page: Page) {
    return page.locator('section.artifact-body').evaluate((body) => {
      const wrappers = body.querySelectorAll(':scope > div.artifact-section-body');
      const names: string[] = [];
      for (let node = wrappers[wrappers.length - 1]!.nextElementSibling; node; node = node.nextElementSibling) {
        names.push(node.className);
      }
      return names;
    });
  }

  // A page with comments on and no decisions, open, its clock stopped.
  async function undecided(page: Page, name: string) {
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    await expect(page.locator('form.artifact-decision')).toHaveCount(0);
    const moved = watchLoads(page);
    await page.evaluate(() => { (window as any).__stayed = 'this page'; });
    return moved;
  }

  // Publish markdown and let the 60-second check swap it in.
  async function republish(page: Page, name: string, markdown: string) {
    const revision = publish(name, markdown);
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(revision);
    return revision;
  }

  test('a decisions section a republish adds is wired in place: answered, folded, listed and re-read when reworded', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-decisions-added';
    const moved = await undecided(page, name);

    await republish(page, name, sectioned(name, [...pond(), decisions()]));
    const first = card(page, 'decision-1');
    const second = card(page, 'decision-2');
    await expect(page.locator('form.artifact-decision')).toHaveCount(2);
    await expect(banner(page).node).toHaveCount(0);
    await expect(first.ask).toBeVisible();
    await expect(second.ask).toBeVisible();
    // The fixture's reader is an owner: Dismiss follows Ask on each.
    for (const each of [first, second]) {
      await expect(each.form.getByRole('button', { name: 'Dismiss' })).toBeVisible();
      expect(await each.ask.evaluate((node) => node.nextElementSibling?.textContent)).toBe('Dismiss');
    }
    // No review sheet on a page that loaded with no form.
    await expect(page.locator('div.artifact-review-bar')).toHaveCount(0);

    await answer(page, 'decision-1', 'Large');
    await expect(first.saved).toHaveText('✓ Saved · Large · change');
    const table = page.locator('div.artifact-answered');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr td.artifact-answered-question')).toHaveText('Which heater?');
    expect(await afterSections(page)).toEqual(['artifact-answered']);
    // The focus, on "change", would hold the section back.
    await page.locator('h1.artifact-title').click();
    await expect(first.form.locator(':focus')).toHaveCount(0);

    // Reworded: the answer is to an earlier wording, the form open; the
    // second is drawn as it was, and the table keeps the earlier answer.
    await republish(page, name, sectioned(name, [...pond(), decisions('Which heater, for a deep pond?')]));
    await expect(first.text).toHaveText('Which heater, for a deep pond?');
    await expect(first.earlier).toContainText('Answered to an earlier wording by');
    await expect(first.form).not.toHaveClass(/artifact-decision--saved/);
    await expect(first.option('Large')).toBeVisible();
    await expect(second.form).not.toHaveClass(/artifact-decision--saved/);
    await expect(second.earlier).toHaveCount(0);
    await expect(second.ask).toHaveCount(1);
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr td.artifact-answered-question')).toHaveText('Which heater?');
    await expect(table.locator('tbody tr .artifact-answered-choice')).toHaveText('Large');
    expect(await afterSections(page)).toEqual(['artifact-answered']);
    expect(moved.count).toBe(0);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    expect(errors).toEqual([]);
  });

  test('a decisions section with an answer picked and not saved is held until Update, its pick kept', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-decisions-held';
    const moved = await undecided(page, name);
    await republish(page, name, sectioned(name, [...pond(), decisions()]));
    await answer(page, 'decision-1', 'Large');
    const second = card(page, 'decision-2');
    await second.option('Yes').check();
    // Held for the pick alone, not the focus.
    await page.locator('h1.artifact-title').click();
    await expect(page.locator('form.artifact-decision :focus')).toHaveCount(0);

    const wrapper = page.locator('div.artifact-section-body[data-section="decisions-for-the-maintainer"]');
    const bar = wrapper.locator('div.artifact-swap-held');
    await republish(page, name, sectioned(name, [...pond(), decisions('Which heater, for a deep pond?')]));
    await expect(bar).toContainText('This section changed');
    await expect(bar.getByRole('button', { name: 'Update' })).toBeVisible();
    await expect(card(page, 'decision-1').text).toHaveText('Which heater?');
    await expect(second.option('Yes')).toBeChecked();

    // Saved, the pick no longer holds it back; Update brings the new forms.
    await second.save.click();
    await expect(second.saved).toHaveText('✓ Saved · Yes · change');
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(bar).toHaveCount(0);
    const first = card(page, 'decision-1');
    await expect(first.text).toHaveText('Which heater, for a deep pond?');
    await expect(first.earlier).toContainText('Answered to an earlier wording by');
    await expect(second.saved).toHaveText('✓ Saved · Yes · change');
    await expect(page.locator('div.artifact-answered tbody tr')).toHaveCount(2);
    expect(moved.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a dismissal undone elsewhere leaves the Answered table once its section is swapped', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-decisions-undone';
    await undecided(page, name);
    await republish(page, name, sectioned(name, [...pond(), decisions()]));
    const second = card(page, 'decision-2');
    await second.form.getByRole('button', { name: 'Dismiss' }).click();
    await expect(second.saved).toContainText('Dismissed');
    const rows = page.locator('div.artifact-answered tbody tr');
    await expect(rows).toHaveCount(1);
    await page.locator('h1.artifact-title').click();

    const undone = await request.post('/api/answers', {
      headers: SIGNED_IN, data: { page: name, question: 'decision-2', dismissed: false },
    });
    expect(undone.status()).toBe(200);
    await republish(page, name, sectioned(name, [...pond(), decisions('Which heater, for a deep pond?')]));
    await expect(card(page, 'decision-1').text).toHaveText('Which heater, for a deep pond?');
    await expect(second.form).not.toHaveClass(/artifact-decision--dismissed/);
    await expect(second.form.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    await expect(page.locator('div.artifact-answered')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a read of the answers a later swap replaces fills no form, the later read drawing the newest answer', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-decisions-reads';
    await undecided(page, name);
    await republish(page, name, sectioned(name, [...pond(), decisions()]));
    await answer(page, 'decision-2', 'No');
    await page.locator('h1.artifact-title').click();

    // Each read from here on is answered only when let go, as the site
    // answered it when asked.
    const held: (() => Promise<void>)[] = [];
    await page.route((url) => url.pathname === '/api/answers', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      held.push(() => route.fulfill({ response }));
    });
    await republish(page, name, sectioned(name, [...pond(), decisions('Which heater, for a deep pond?')]));
    await expect.poll(() => held.length).toBe(1);
    const second = card(page, 'decision-2');
    await answer(page, 'decision-2', 'Yes');
    await expect(second.saved).toHaveText('✓ Saved · Yes · change');
    await page.locator('h1.artifact-title').click();
    await republish(page, name, sectioned(name, [...pond(), decisions('Which heater, for a pond 2 m deep?')]));
    await expect.poll(() => held.length).toBe(2);

    // The older read, saying "No", comes back first.
    const finished = page.waitForEvent('requestfinished', (request) =>
      new URL(request.url()).pathname === '/api/answers' && request.method() === 'GET');
    await held[0]!();
    await finished;
    await page.evaluate(() => Promise.resolve());
    await held[1]!();
    await expect(second.saved).toHaveText('✓ Saved · Yes · change');
    const row = page.locator('div.artifact-answered tbody tr[data-question="decision-2"]');
    await expect(row.locator('.artifact-answered-choice strong')).toHaveText('Yes');
    expect(errors).toEqual([]);
  });

  test('a thread asked on a question a republish rewords is headed with the new words', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-decisions-reworded-thread';
    await undecided(page, name);
    await republish(page, name, sectioned(name, [...pond(), decisions()]));
    const first = card(page, 'decision-1');
    await first.form.locator('details.artifact-decision-note > summary').click();
    await first.form.locator('textarea[name="note"]').fill('Is the small one enough for the fish?');
    const [asked] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      first.ask.click(),
    ]);
    const id = (await asked.json()).id as number;
    const words = page.locator(`.artifact-comments-panel li.artifact-comments-entry[data-thread="${id}"] ` +
      '.artifact-comments-entry-head .artifact-comments-entry-words');
    await expect(words).toHaveText('Decision 1 · Which heater?');
    await page.locator('h1.artifact-title').click();

    await republish(page, name, sectioned(name, [...pond(), decisions('Which heater, for a deep pond?')]));
    await expect(first.text).toHaveText('Which heater, for a deep pond?');
    await first.chip.click();
    await expect(words).toHaveText('Decision 1 · Which heater, for a deep pond?');
    expect(errors).toEqual([]);
  });

  test('a section a republish adds after the decisions leaves the Answered table last, still folding', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-decisions-table';
    await undecided(page, name);
    await republish(page, name, sectioned(name, [...pond(), decisions()]));
    await answer(page, 'decision-1', 'Small');
    const table = page.locator('div.artifact-answered');
    await expect(table.locator('tbody tr')).toHaveCount(1);

    await republish(page, name, sectioned(name, [...pond(), decisions(),
      ['Spring', ['Put the pump back in April.']]]));
    await expect(page.locator('div.artifact-section-body[data-section="spring"]')).toContainText('April');
    expect(await afterSections(page)).toEqual(['artifact-answered']);
    expect(await page.locator('section.artifact-body').evaluate((body) =>
      body.lastElementChild?.classList.contains('artifact-answered'))).toBe(true);
    const fold = table.locator('button.artifact-section-toggle');
    await fold.click();
    await expect(table.locator('.artifact-answered-body')).toBeHidden();
    await fold.click();
    await expect(table.locator('.artifact-answered-body')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a question asked through Ask keeps its chip and thread when a republish rewords another question', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-decisions-asked';
    await undecided(page, name);
    await republish(page, name, sectioned(name, [...pond(), decisions()]));
    const second = card(page, 'decision-2');
    const words = 'Does the pump survive a hard frost in the pond?';
    await second.form.locator('details.artifact-decision-note > summary').click();
    await second.form.locator('textarea[name="note"]').fill(words);
    const [asked] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      second.ask.click(),
    ]);
    expect(asked.status()).toBe(201);
    const id = (await asked.json()).id as number;
    await expect(second.chip).toHaveCount(1);
    await page.locator('h1.artifact-title').click();

    await republish(page, name, sectioned(name, [...pond(), decisions('Which heater, for a deep pond?')]));
    await expect(card(page, 'decision-1').text).toHaveText('Which heater, for a deep pond?');
    await expect(page.locator('div.artifact-swap-held')).toHaveCount(0);
    await expect(second.chip).toHaveCount(1);
    await expect(page.locator('.artifact-decision-chip')).toHaveCount(1);
    await second.chip.click();
    const entry = page.locator(`.artifact-comments-panel li.artifact-comments-entry[data-thread="${id}"]`);
    await expect(entry).toHaveClass(/artifact-comments-entry--open/);
    await expect(entry.locator('.artifact-comments-entry-head .artifact-comments-entry-words')).toHaveText('Decision 2 · Lift the pump out?');
    await expect(entry.locator('.artifact-comment-text')).toHaveText(words);
    expect(errors).toEqual([]);
  });

  test('a page that loaded with decision forms, its review sheet drawn, swaps a changed form in place', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-decisions-sheet';
    publish(name, sectioned(name, [...pond(), decisions()]));
    await stopClock(page);
    await open(page, name);
    await expect(page.locator('div.artifact-review-bar')).toHaveCount(1);
    // The defaults picked on load are saved, so no pick holds the section.
    await page.locator('button.artifact-review-count').click();
    await page.locator('button.artifact-review-save').click();
    await expect(page.locator('.artifact-review-outcome')).toContainText('Saved at');
    await page.locator('.artifact-review-close').click();
    await page.locator('h1.artifact-title').click();
    const moved = watchLoads(page);

    await republish(page, name, sectioned(name, [...pond(), decisions('Which heater, for a deep pond?')]));
    await expect(banner(page).node).toHaveCount(0);
    await expect(card(page, 'decision-1').text).toHaveText('Which heater, for a deep pond?');
    await expect(page.locator('div.artifact-review-bar')).toHaveCount(1);
    await expect(page.locator('button.artifact-review-count')).toHaveText('All answered · Respond');
    expect(moved.count).toBe(0);
    expect(errors).toEqual([]);
  });
});
