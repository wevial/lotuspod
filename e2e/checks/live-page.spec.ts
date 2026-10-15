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

// hermes pulls, so it is listening and a new comment waits for it.
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
  const base64 = fs.readFileSync(FISH).toString('base64');
  const uploaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/media');
  await field.evaluate((node, base64) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    data.items.add(new File([bytes], 'fish.jpg', { type: 'image/jpeg' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, base64);
  expect((await uploaded).status()).toBe(201);
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
    const { swaps, wrapper, toggle, bar } = await holdRisks(page, 'live-page-held');
    await bar.getByRole('button', { name: 'Update' }).click();
    await expect(wrapper('risks')).toContainText('The pump will crack unless it is lifted out first.');
    await expect(wrapper('risks')).not.toContainText('The pump may crack in the ice.');
    await expect(page.locator('div.artifact-swap-held')).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(wrapper('risks')).toHaveClass(/\bartifact-swapped\b/);
    expect((await swaps()).filter((unit) => unit.kind === 'section')).toEqual([
      { kind: 'section', id: 'findings', change: 'changed' },
      { kind: 'section', id: 'risks', change: 'changed' },
    ]);
    expect(errors).toEqual([]);
  });

  test('a held section is current again once a republish brings back its text', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-held-back';
    const { wrapper, bar } = await holdRisks(page, name);
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

  test("a waiting thread's next read brings the banner without the 60-second check", async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-poll';
    listen();
    publish(name, source('Live page poll', 'first'));
    const root = await comment(request, name, 'findings', 'Which heater?');
    expect(root.state).toBe('pending');
    const asked: string[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === '/api/revision') asked.push(sent.url());
    });
    await stopClock(page);
    await open(page, name);
    await expect(banner(page).node).toHaveCount(0);

    publish(name, source('Live page poll', 'second'));
    await page.clock.runFor(5000);
    await expect(banner(page).node).toBeVisible();
    await expect(banner(page).node).toContainText(NEWER);
    expect(asked).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Reload shows the new revision at the same place, its thread open and its text unsent', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-reload';
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
    publish(name, source('Live page slow', 'first', 8));
    const root = await comment(request, name, 'risks', 'Will the pump crack?');
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const node = page.locator(`.artifact-comments-panel .artifact-comment-thread[data-thread="${root.id}"]`);
    await node.locator('.artifact-comment-toggle').click();
    const field = node.locator('form.artifact-comment-reply textarea[name="text"]');
    await field.fill('And if the heater');

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
      await route.continue();
    });

    const second = publish(name, source('Live page slow', 'second', 8));
    await page.clock.runFor(CHECK);
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

  // Select the first `length` characters of the paragraph holding `words`
  // and open the passage composer on them.
  async function selectPassage(page: Page, words: string, length: number) {
    await page.locator('.artifact-body p', { hasText: words }).evaluate((paragraph, length) => {
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.firstChild!, length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, length);
    await page.keyboard.press('Control+Alt+m');
    const field = page.getByRole('textbox', { name: 'Comment on the selected words' });
    await expect(field).toBeFocused();
    return field;
  }

  test('Reload opens a passage composer again on its words, its text unsent', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-passage';
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
    const field = await selectPassage(page, 'Risks, paragraph 1', 18);
    const UNSENT = 'Which pump is this?';
    await field.fill(UNSENT);

    const second = publish(name, source('Live page passage gone', 'second')
      .replace('Risks, paragraph 1:', 'Risks, first point:'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('.artifact-body')).toContainText('Risks, first point:');
    await expect(page.locator('mark.artifact-passage--pending')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Risks' }) });
    await expect(form.locator('textarea')).toBeVisible();
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'The words you selected have changed since. Your comment is kept here, on the section.');
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

    const second = publish(name, source('Live page renamed', 'second').replace(/Risks/g, 'Hazards'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('details.artifact-comment[data-section="risks"]')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards' }) });
    await expect(form.locator('textarea')).toBeVisible();
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    expect(errors).toEqual([]);
  });

  test('a hidden page with nothing unsent has reloaded itself before it is seen again', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-hidden';
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
});
