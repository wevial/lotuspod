import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

// What e2e/checks/live-page.spec.ts and e2e/checks/live-held-reload.spec.ts
// share: publishing a page on the capture fixture's site, opening it with its
// clock stopped, and reading what the live page shows.

export const ENV = process.env;
export const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
export const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
export const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
export const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
export const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
export const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
export const SRC = path.resolve(__dirname, '..', '..', 'src');
export const OWNER = 'hermes';
export const CHECK = 60_000;
export const EVENTS = '/api/events';
export const START = Date.parse('2026-10-02T12:00:00Z');
export const FISH = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'media', 'fish-320x240.jpg');
export const MEDIA_URL = /^\/media\/[0-9a-f]{64}\.jpg$/;

export function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// A page's markdown: three sections of `paragraphs` paragraphs each, the
// edition named at the top.
export function source(title: string, edition: string, paragraphs = 2) {
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
export function sectioned(title: string, sections: [string, string[]][], intro = 'The pond, in winter.') {
  const lines = [`# ${title}`, '', intro, ''];
  for (const [heading, paragraphs] of sections) {
    lines.push(`## ${heading}`, '');
    for (const paragraph of paragraphs) lines.push(paragraph, '');
  }
  return lines.join('\n');
}

export const POND: [string, string[]][] = [
  ['Findings', ['The pond freezes in January.', 'The pump stops with it.']],
  ['Risks', ['The pump may crack in the ice.', 'The fish need air under it.']],
  ['Next steps', ['Order a heater before the frost.', 'Lift the pump out in December.']],
];

// POND with one section's paragraphs, or its heading, changed.
export function pond(change: Record<string, { heading?: string; paragraphs?: string[] }> = {}) {
  return POND.map(([heading, paragraphs]): [string, string[]] =>
    [change[heading]?.heading ?? heading, change[heading]?.paragraphs ?? paragraphs]);
}

// hermes publishes markdown as the page name, with any extra options; the
// revision it is now at.
export function publish(name: string, markdown: string, ...extra: string[]): string {
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

// Errors the page throws or logs, but for serve's stream refused (refuse).
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !REFUSED(message)) errors.push(message.text());
  });
  return errors;
}

// Chromium's console error for the stream answered 503.
export function REFUSED(message: { text(): string; location(): { url: string } }) {
  return new URL(message.location().url || 'about:blank', 'http://x').pathname === EVENTS &&
    message.text().includes('503');
}

// The page's clock, paused at START: it moves only when moved. Serve's
// stream (/api/events) is refused, so a republish or a reply reaches the
// page only through the checks the clock drives, which these checks time.
export async function stopClock(page: Page) {
  await refuse(page);
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
}

export async function refuse(page: Page) {
  await page.route((url) => url.pathname === EVENTS, (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error": "too_many_streams"}' }));
}

// Open the page and let its first read of the threads come back.
export async function open(page: Page, name: string) {
  const read = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'GET');
  await page.goto(`/${name}.html?standalone`);
  await read;
}

export function revisionOf(page: Page) {
  return page.locator('meta[name="lotuspod:revision"]').getAttribute('content');
}

export function banner(page: Page) {
  const node = page.locator('.artifact-live-page-banner');
  return { node, reload: node.getByRole('button', { name: 'Reload' }) };
}

// Have each swap of the page fall back to the banner or a reload, as it did
// before a page with comments swapped: the swap's fetch of the page answers
// it with another theme. Any other request goes on to a route set before, or
// to the site.
export async function fallBack(page: Page, name: string) {
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
export function watchLoads(page: Page) {
  const moved = { count: 0 };
  page.on('load', () => { moved.count += 1; });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) moved.count += 1;
  });
  return moved;
}

// Paste the fish JPEG into a field, its upload left to answer when it may.
export async function pasteFishOnly(field: Locator) {
  const base64 = fs.readFileSync(FISH).toString('base64');
  await field.evaluate((node, base64) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    data.items.add(new File([bytes], 'fish.jpg', { type: 'image/jpeg' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, base64);
}

// Hold the page's uploads (/api/media) until the returned release is called.
export async function holdUploads(page: Page) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/api/media', async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

// The thumbnails attached in a form: their /media/ paths, once drawn.
export async function attachedIn(form: Locator) {
  return form.locator('.artifact-attach-item img').evaluateAll((images) =>
    images.map((img) => new URL((img as HTMLImageElement).src).pathname));
}

// Select `length` characters of the paragraph holding `words`, from its
// first or from `from`, and open the passage composer on them.
export async function selectPassage(page: Page, words: string, length: number, from = 0) {
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

// A changed paragraph for Risks, and a section's comment box.
export const RISKY = 'The pump will crack unless it is lifted out first.';
export const box = (page: Page, id: string) => page.locator(`details.artifact-comment[data-section="${id}"]`);
