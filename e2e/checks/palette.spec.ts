import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// At this width a box never opens: its chip opens the section's threads in
// a popover over the text. panel.spec.ts checks the side panel a wider
// window gets, and narrow.spec.ts the popover and a phone's bottom sheet.
const MEDIUM = { width: 1024, height: 768 };
test.use({ viewport: MEDIUM });

// The capture fixture's palette page: a link and inline code, a table, a
// blockquote with a cite and a code block, a comment box ending each section,
// owned by hermes. Then the decisions page's saved and unsaved marks. Every
// expected colour is read from the theme's tokens, never from the stylesheet.
const PAGE = '/capture-palette.html';
const DECISIONS = '/capture-decisions.html';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
// The reader as a page names them: their address's part before the @.
const READER = 'maintainer';
const OWNER = 'hermes';
const TOKENS = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'lotuspod', '_theme', 'tokens.json'), 'utf-8'));
const COLORS: Record<string, string> = TOKENS.colors;
const STRUCTURE: Record<string, string> = TOKENS.structure;

// A token as Chromium reports a computed colour: hex becomes rgb(r, g, b);
// an rgba(r, g, b, a) token is already in that form.
function rgb(token: string) {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(token);
  if (!hex) return token;
  const [r, g, b] = hex.slice(1).map((pair) => parseInt(pair, 16));
  return `rgb(${r}, ${g}, ${b})`;
}

type Violation = { blockedURI: string; effectiveDirective: string };

async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as any).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  return {
    errors,
    violations: () => page.evaluate(() => (window as any).__violations as Violation[]),
  };
}

async function clean(seen: Awaited<ReturnType<typeof watch>>) {
  expect(seen.errors).toEqual([]);
  expect(await seen.violations()).toEqual([]);
}

let next = 1;

// A comment as the threads route returns it.
function row(fields: Record<string, unknown>) {
  const id = next++;
  return {
    id,
    page: 'capture-palette',
    section: 'links-and-code',
    sectionTitle: 'Links and code',
    revision: '',
    parent: null,
    text: `Comment ${id}`,
    quote: null,
    actor: { kind: 'human', name: READER },
    createdAt: '2026-09-30T10:00:00.000Z',
    state: 'pending',
    ...fields,
  };
}

async function serveThreads(page: Page, threads: unknown[]) {
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { page: 'capture-palette', threads } })
      : route.continue());
}

function box(page: Page, section: string) {
  return page.locator(`details.artifact-comment[data-section="${section}"]`);
}

function thread(page: Page, root: { id: number }) {
  return page.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
}

async function css(target: Locator, property: string, pseudo: string | null = null) {
  return target.evaluate((node, [property, pseudo]) =>
    getComputedStyle(node, pseudo).getPropertyValue(property as string), [property, pseudo] as const);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('the root element names the new colours and the highlight tints as the tokens do', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const root = page.locator('html');
    for (const name of ['sky', 'pale_sky', 'rose', 'pale_rose', 'mint', 'amber']) {
      const property = `--color-${name.replace(/_/g, '-')}`;
      expect((await css(root, property)).trim().toLowerCase(), property).toBe(COLORS[name].toLowerCase());
    }
    for (const name of ['highlight', 'highlight_line']) {
      const property = `--${name.replace(/_/g, '-')}`;
      expect((await css(root, property)).trim(), property).toBe(STRUCTURE[name]);
    }
    await clean(seen);
  });

  test('a link, inline code, a table header, a quote and a code block take the sky colours', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const body = page.locator('.artifact-body');

    const link = body.locator('p a').first();
    await expect(link).toHaveText('the sample article');
    await expect(link).toHaveCSS('color', rgb(COLORS.sky));
    await expect(link).toHaveCSS('text-decoration-color', rgb(STRUCTURE.link_line));

    const code = body.locator('p code').first();
    await expect(code).toHaveText('lotuspod publish');
    await expect(code).toHaveCSS('color', rgb(COLORS.pale_sky));
    await expect(code).toHaveCSS('background-color', rgb(STRUCTURE.code_chip));

    const header = body.locator('th').first();
    await expect(header).toHaveText('Month');
    await expect(header).toHaveCSS('color', rgb(COLORS.pale_sky));
    await expect(header).toHaveCSS('background-color', rgb(STRUCTURE.header_tint));
    await expect(header).toHaveCSS('border-bottom-color', rgb(STRUCTURE.header_rule));

    const quote = body.locator('blockquote');
    await expect(quote).toHaveCSS('border-left-width', '3px');
    await expect(quote).toHaveCSS('border-left-style', 'solid');
    await expect(quote).toHaveCSS('border-left-color', rgb(STRUCTURE.quote_rule));
    await expect(quote).toHaveCSS('background-color', rgb(STRUCTURE.quote_band));
    await expect(quote).toHaveCSS('border-top-left-radius', '0px');
    await expect(quote).toHaveCSS('border-bottom-left-radius', '0px');
    await expect(quote).toHaveCSS('color', rgb(COLORS.pale_lavender));
    await expect(quote.locator('cite')).toHaveCSS('color', rgb(COLORS.muted_lavender));

    const block = body.locator('pre');
    await expect(block).toHaveCSS('border-top-color', rgb(STRUCTURE.code_edge));
    await expect(block).toHaveCSS('border-left-color', rgb(STRUCTURE.code_edge));
    await expect(block).toHaveCSS('background-color', rgb(COLORS.deep_night));
    await clean(seen);
  });

  test('the reader is drawn in rose beside a lavender agent', async ({ page }) => {
    const seen = await watch(page);
    const root = row({ state: 'answered', text: 'Should the link go to the guide?' });
    const reply = row({
      parent: root.id, state: 'answered', text: 'It goes to the article.',
      actor: { kind: 'agent', handle: OWNER },
    });
    await serveThreads(page, [{ root, replies: [reply] }]);
    await page.goto(PAGE);
    await box(page, 'links-and-code').locator('summary').click();

    const answered = thread(page, root);
    await expect(answered).toBeVisible();
    const mine = answered.locator('.artifact-comment-item--reader');
    const theirs = answered.locator('.artifact-comment-item--agent');
    await expect(mine).toHaveCount(1);
    await expect(theirs).toHaveCount(1);
    await expect(mine.locator('.artifact-comment-text')).toHaveCSS('background-color', rgb(STRUCTURE.reader_tint));
    await expect(mine.locator('.artifact-comment-text')).toHaveCSS('border-top-color', rgb(STRUCTURE.reader_line));
    const agentBubble = await css(theirs.locator('.artifact-comment-text'), 'background-color');
    expect(agentBubble).not.toBe(rgb(STRUCTURE.reader_tint));

    const avatar = mine.locator('.artifact-comment-avatar');
    await expect(avatar).toHaveText('MA');
    await expect(avatar).toHaveCSS('background-color', rgb(STRUCTURE.reader_avatar));
    await expect(avatar).toHaveCSS('border-top-color', rgb(COLORS.rose));
    await expect(avatar).toHaveCSS('color', rgb(COLORS.pale_rose));
    await expect(mine.locator('.artifact-comment-author')).toHaveText(READER);
    await expect(mine.locator('.artifact-comment-author')).toHaveCSS('color', rgb(COLORS.pale_rose));

    await expect(theirs.locator('.artifact-comment-avatar')).toHaveCSS('background-color', rgb(COLORS.lavender));
    await expect(theirs.locator('.artifact-comment-agent')).toHaveCSS('color', rgb(COLORS.lavender));
    await clean(seen);
  });

  test('a waiting thread and a thread being written both draw amber dots', async ({ page }) => {
    const seen = await watch(page);
    const pending = row({ state: 'pending', text: 'Is the table right?', section: 'table', sectionTitle: 'Table' });
    const claimed = row({ state: 'claimed', text: 'Who wrote the quote?', section: 'quote', sectionTitle: 'Quote' });
    await serveThreads(page, [{ root: pending, replies: [] }, { root: claimed, replies: [] }]);
    await page.goto(PAGE);

    const waiting = thread(page, pending).locator('.artifact-comment-typing--pending .artifact-comment-mark--dots i');
    const writing = thread(page, claimed).locator('.artifact-comment-typing--claimed .artifact-comment-mark--dots i');
    // Each in its section's popover, opened from its chip.
    for (const [section, dots] of [['table', waiting], ['quote', writing]] as const) {
      await page.keyboard.press('Escape');
      await box(page, section).locator('summary').click();
      await expect(dots).toHaveCount(3);
      for (const dot of await dots.all()) {
        await expect(dot).toBeVisible();
        await expect(dot).toHaveCSS('background-color', rgb(COLORS.amber));
      }
    }
    await clean(seen);
  });

  test('a saved answer is checked in mint and a picked one is not saved in amber', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(DECISIONS);
    const version = await page.locator('form.artifact-decision[data-question="decision-1"]')
      .getAttribute('data-version');
    // The spec answers the page's read; nothing is ever posted.
    await page.route((url) => url.pathname === '/api/answers', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { page: 'capture-decisions', questions: {
          'decision-1': {
            current: {
              id: 1, page: 'capture-decisions', question: 'decision-1', version, choice: 'opus', note: '',
              revision: 'abc123abc123', actor: { kind: 'human', name: READER },
              createdAt: '2026-10-01T09:30:00Z', supersedes: null,
            },
            earlier: [],
          },
        } } })
        : route.abort());
    await page.reload();

    const first = page.locator('form.artifact-decision[data-question="decision-1"]');
    const second = page.locator('form.artifact-decision[data-question="decision-2"]');
    await expect(first.locator('.artifact-decision-saved-line')).toContainText('Saved');
    await expect(first.locator('.artifact-decision-check')).toHaveCSS('color', rgb(COLORS.mint));

    await second.getByRole('radio', { name: 'No' }).check();
    const unsaved = second.locator('.artifact-decision-unsaved');
    await expect(unsaved).toBeVisible();
    await expect(unsaved).toHaveText('Not saved');
    await expect(unsaved).toHaveCSS('color', rgb(COLORS.amber));
    expect(await css(unsaved, 'border-top-color', '::before')).toBe(rgb(COLORS.amber));
    await expect(second.locator('fieldset')).toHaveCSS('border-left-color', rgb(COLORS.amber));
    await clean(seen);
  });
});
