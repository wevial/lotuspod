import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Emoji shortcodes in a comment composer: a typed `:shortcode:` becomes its
// emoji, and a partial one opens a list of matching emoji under the field.
// The check renders its own page into the capture fixture's site, so the
// threads it posts are the only ones on it. At 1440 pixels a section's
// threads open in the panel, at 1024 in a popover and at 360 in a bottom
// sheet.
const WIDE = { width: 1440, height: 900 };
const MEDIUM = { width: 1024, height: 768 };
const PHONE = { width: 360, height: 740 };
test.use({ viewport: WIDE });

const NAME = 'check-emoji-shortcodes';
const PAGE = `/${NAME}.html`;
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const BODY = `<p>A page for the emoji shortcode checks.</p>
<h2>Pond</h2>
<p>The pond freezes in January, and the pump stops with it.</p>
<h2>Frogs</h2>
<p>The frogs sleep under the ice until the thaw.</p>
`;

test.beforeAll(() => {
  for (const [name, value] of Object.entries({ ASSERTION, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
  execFileSync(PYTHON, [
    '-m', 'lotuspod', 'render', '--name', NAME, '--title', 'Check emoji shortcodes', '--comments',
    '--body', BODY, '--out-dir', OUT,
  ], { env: { ...ENV, PYTHONPATH: SRC }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
});

type Violation = { blockedURI: string; effectiveDirective: string };

// Console errors, page errors and policy violations.
async function watch(page: Page) {
  const errors: string[] = [];
  const violations: Violation[] = [];
  await page.exposeFunction('__violated', (violation: Violation) => { violations.push(violation); });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as any).__violated({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  return {
    clean() {
      expect(errors).toEqual([]);
      expect(violations).toEqual([]);
    },
  };
}

// The root element's mark that the comments store's first read has ended.
async function loaded(page: Page) {
  await expect(page.locator(':root')).toHaveAttribute('data-lotuspod-comments-read', '');
}

async function thread(request: APIRequestContext, name: string, text: string) {
  const response = await request.post('/api/comments', {
    headers: SIGNED_IN,
    data: { page: NAME, section: name, text },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

// Every comment on the page, by id, as the site holds it.
async function stored(request: APIRequestContext) {
  const response = await request.get(`/api/comments?page=${NAME}`, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  const rows = new Map<number, { text: string }>();
  for (const each of (await response.json()).threads) {
    for (const row of [each.root, ...each.replies]) rows.set(row.id, row);
  }
  return rows;
}

// A thread's reply composer, unfolded.
async function reply(node: Locator) {
  await expect(node).toBeVisible();
  await node.getByRole('button', { name: 'Add to your comment' }).click();
  const form = node.locator('form.artifact-comment-reply');
  const field = form.locator('textarea[name="text"]');
  await expect(field).toBeFocused();
  return { field, send: form.locator('button[type="submit"]') };
}

function posted(page: Page) {
  return page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST');
}

// The emoji lists on the page that show.
function shown(page: Page) {
  return page.locator('ul[role="listbox"].artifact-shortcodes:visible');
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('typing :tad in the panel\'s new thread composer lists 🎉 :tada: then 🏟️ :stadium:, and a click on 🎉 posts it', async ({ page, request }) => {
    const seen = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    await loaded(page);
    const aside = page.locator('aside.artifact-comments-panel');
    await aside.getByRole('button', { name: 'Comments', exact: true }).click();
    await aside.getByRole('button', { name: 'Comment on a section' }).click();
    await aside.getByRole('listbox', { name: 'Sections' }).getByRole('option', { name: 'Pond' }).click();
    const field = aside.getByLabel('Comment on Pond');
    await expect(field).toBeFocused();
    await field.pressSequentially('Looks great :tad');
    await expect(field).toHaveValue('Looks great :tad');

    const list = page.locator('ul[role="listbox"]').filter({ has: page.getByRole('option', { name: '🎉 :tada:' }) });
    await expect(list).toBeVisible();
    const options = list.getByRole('option');
    await expect(options.nth(0)).toHaveText('🎉 :tada:');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(1)).toHaveText('🏟️ :stadium:');
    const id = (await list.getAttribute('id'))!;
    await expect(field).toHaveAttribute('aria-controls', id);
    await expect(field).toHaveAttribute('aria-activedescendant', (await options.nth(0).getAttribute('id'))!);
    await expect(field).toHaveAttribute('aria-autocomplete', 'list');
    const under = await list.boundingBox(), above = await field.boundingBox();
    expect(under!.y).toBeGreaterThanOrEqual(above!.y + above!.height);

    await options.nth(0).click();
    await expect(page.locator(`[id="${id}"]`)).toBeHidden();
    await expect(field).toHaveValue('Looks great 🎉');
    await expect(field).toBeFocused();
    await expect(field).not.toHaveAttribute('aria-activedescendant');
    await expect(field).not.toHaveAttribute('aria-controls');

    const [sent] = await Promise.all([posted(page), field.locator('xpath=ancestor::form').locator('button[type="submit"]').click()]);
    expect(sent.status()).toBe(201);
    const row = await sent.json();
    const bubble = page.locator(`.artifact-comment-thread[data-thread="${row.id}"] .artifact-comment-item--reader .artifact-comment-text`).first();
    await expect(bubble).toHaveText('Looks great 🎉');
    expect((await stored(request)).get(row.id)?.text).toBe('Looks great 🎉');
    seen.clean();
  });

  test('at 1024 a reply in the popover turns :+1: into 👍, leaves :nope: and lists nothing for 10:30:45 or http://x', async ({ page, request }) => {
    const seen = await watch(page);
    const root = await thread(request, 'pond', 'Should the pump run all winter?');
    await page.setViewportSize(MEDIUM);
    await page.goto(`${PAGE}?standalone`);
    await loaded(page);
    await page.locator('details.artifact-comment[data-section="pond"] summary').click();
    const popover = page.locator('.artifact-comments-popover');
    await expect(popover).toBeVisible();
    const { field, send } = await reply(popover.locator(`.artifact-comment-thread[data-thread="${root.id}"]`));
    await field.pressSequentially('Agreed :+1: and :nope: and ');
    await expect(field).toHaveValue('Agreed 👍 and :nope: and ');
    for (const key of '10:30:45 at http://x') {
      await field.press(key === ' ' ? 'Space' : key);
      await expect(shown(page)).toHaveCount(0);
    }
    const text = 'Agreed 👍 and :nope: and 10:30:45 at http://x';
    await expect(field).toHaveValue(text);

    const [sent] = await Promise.all([posted(page), send.click()]);
    expect(sent.status()).toBe(201);
    const row = await sent.json();
    expect((await stored(request)).get(row.id)?.text).toBe(text);
    seen.clean();
  });

  test('at 360 the keys move, insert and close the list in the bottom sheet\'s reply composer', async ({ page, request }) => {
    const seen = await watch(page);
    const root = await thread(request, 'pond', 'Is the pump on a timer?');
    await page.setViewportSize(PHONE);
    await page.goto(`${PAGE}?standalone`);
    await loaded(page);
    let sends = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/comments' && r.method() === 'POST') sends += 1;
    });
    await page.locator('details.artifact-comment[data-section="pond"] summary').click();
    const sheet = page.locator('.artifact-comments-bottom-sheet');
    await expect(sheet).toBeVisible();
    const { field } = await reply(sheet.locator(`.artifact-comment-thread[data-thread="${root.id}"]`));
    await field.pressSequentially(':tad');
    const list = shown(page);
    await expect(list).toHaveCount(1);
    const options = list.getByRole('option');
    await expect(options).toHaveText(['🎉 :tada:', '🏟️ :stadium:']);
    for (let i = 0; i < 2; i += 1) await expect(options.nth(i)).toBeInViewport({ ratio: 1 });
    await expect(list).toBeInViewport({ ratio: 1 });

    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
    await expect(field).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id'))!);
    await page.keyboard.press('ArrowUp');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(field).toHaveAttribute('aria-activedescendant', (await options.nth(0).getAttribute('id'))!);
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue('🎉');
    await expect(list).toHaveCount(0);

    await field.pressSequentially(' :stad');
    await expect(list.getByRole('option')).toHaveText(['🏟️ :stadium:']);
    await page.keyboard.press('Tab');
    await expect(field).toHaveValue('🎉 🏟️');
    await expect(field).toBeFocused();

    await field.pressSequentially(' :ta');
    await expect(list).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(field).toHaveValue('🎉 🏟️ :ta');
    await expect(field).toBeFocused();
    expect(sends).toBe(0);
    seen.clean();
  });

  test('the table is fetched once, on the first colon typed, at the theme address', async ({ page, request }) => {
    const seen = await watch(page);
    const root = await thread(request, 'frogs', 'Where do the frogs go in winter?');
    const asked: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.endsWith('lotuspod-emoji.json')) asked.push(r.url());
    });
    await page.goto(`${PAGE}?standalone`);
    await loaded(page);
    const theme = /[?&]v=([^&#]*)/.exec((await page.locator('link[rel="stylesheet"][href*="?v="]').getAttribute('href'))!)![1];
    expect(theme).toMatch(/^[0-9a-f]{12}$/);
    const aside = page.locator('aside.artifact-comments-panel');
    await aside.getByRole('button', { name: 'Comments', exact: true }).click();
    await aside.getByRole('button', { name: 'Comment on a section' }).click();
    await aside.getByRole('listbox', { name: 'Sections' }).getByRole('option', { name: 'Pond' }).click();
    const field = aside.getByLabel('Comment on Pond');
    await expect(field).toBeFocused();
    await field.pressSequentially('Pond');
    await page.waitForTimeout(300);
    expect(asked).toEqual([]);

    const [answer] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/lotuspod-emoji.json'),
      field.press(':'),
    ]);
    expect(answer.status()).toBe(200);
    expect(answer.headers()['content-type']).toBe('application/json');
    expect(new URL(answer.url()).search).toBe(`?v=${theme}`);

    await page.locator('details.artifact-comment[data-section="frogs"] summary').click();
    const second = await reply(aside.locator(`.artifact-comment-thread[data-thread="${root.id}"]`));
    await second.field.pressSequentially(':ta');
    await expect(shown(page)).toHaveCount(1);
    expect(asked).toEqual([answer.url()]);
    seen.clean();
  });
});
