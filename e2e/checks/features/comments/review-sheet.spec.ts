import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The capture fixture's review sheet page: four sections, "Who reviews"
// asking D1 (default Codex) and D2 (no default), "When a review blocks" D3
// (no default) and D4 (default 3 rounds), "Prompt rules" a three-item
// checklist, and "Rollout" D5 (default Holophyte only) and D6 (no default).
// These checks are the only ones that answer on this page, and the later
// ones build on what the earlier saved, so they run in order.
const PAGE = '/capture-review-sheet.html';
const ANSWERS = '/api/answers?page=capture-review-sheet';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const STALE = 'This question has changed since the page loaded. Reload it.';
const SECTIONS = ['Who reviews', 'When a review blocks', 'Prompt rules', 'Rollout'];
const QUESTIONS = ['decision-d1', 'decision-d2', 'decision-d3', 'decision-d4', 'checklist-1',
  'decision-d5', 'decision-d6'];

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

// The page's own route handlers, dropped as a check ends: a read still in
// one would otherwise fail the check with "Test ended".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// The title bar's count and Next open, the comments panel and its Decisions
// tab, and the page's forms, headings and outline links.
function sheet(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  const decisions = aside.locator('.artifact-comments-decisions');
  return {
    count: page.locator('button.artifact-review-count'),
    next: page.locator('a.artifact-review-next'),
    aside,
    decisions,
    tabs: aside.getByRole('tab'),
    titles: decisions.locator('.artifact-decisions-group-title'),
    groups: decisions.locator('.artifact-decisions-group'),
    entries: decisions.locator('.artifact-decisions-entry'),
    answered: decisions.locator('details.artifact-decisions-answered > summary'),
    entry: (question: string) => {
      const item = decisions.locator(`.artifact-decisions-entry[data-question="${question}"]`);
      return {
        item,
        option: (name: string) => item.getByRole('radio', { name }),
        box: (name: string) => item.getByRole('checkbox', { name }),
        save: item.getByRole('button', { name: 'Save', exact: true }),
        unsaved: item.locator('.artifact-decisions-unsaved'),
      };
    },
    row: (question: string) => {
      const item = decisions.locator(`.artifact-decisions-row[data-question="${question}"]`);
      return {
        item,
        label: item.locator('.artifact-decisions-row-label'),
        change: item.getByRole('button', { name: 'change', exact: true }),
        option: (name: string) => item.getByRole('radio', { name }),
        save: item.getByRole('button', { name: 'Save', exact: true }),
        unsaved: item.locator('.artifact-decisions-unsaved'),
      };
    },
    form: (question: string) => page.locator(`form.artifact-decision[data-question="${question}"]`),
    heading: (name: string) => page.locator('section.artifact-body h2', { hasText: name }),
    outline: (name: string) => page.locator('ol.artifact-outline-list a', { hasText: name }),
  };
}

// The questions each group of the Decisions tab holds, in order.
function held(the: ReturnType<typeof sheet>) {
  return the.groups.evaluateAll((groups) => groups.map((group) =>
    Array.from(group.querySelectorAll('.artifact-decisions-entry')).map((entry) =>
      (entry as HTMLElement).dataset.question)));
}

async function stored(request: APIRequestContext) {
  const response = await request.get(ANSWERS, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  return (await response.json()).questions;
}

// The site keeps every answer saved, so a check that saves, or counts on the
// answers the earlier ones saved, can only run once per site: with
// --repeat-each it runs in the first repeat, and the repeats rerun the rest.
function firstRepeatOnly() {
  test.skip(test.info().repeatEachIndex > 0, 'builds on the answers the first repeat saved');
}

async function quiet(target: ReturnType<Page['locator']>) {
  return target.evaluate((node) => {
    const style = getComputedStyle(node);
    return { border: style.borderTopWidth, background: style.backgroundColor };
  });
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 800 } });

  test('the title bar counts the open questions, the outline and headings mark them, and the count opens the Decisions tab alone', async ({ page }) => {
    firstRepeatOnly();
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const seen = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await expect(the.count).toHaveText('7 to answer');
    await expect(the.next).toBeVisible();
    for (const [name, open] of [['Who reviews', 2], ['When a review blocks', 2], ['Prompt rules', 1], ['Rollout', 2]] as const) {
      await expect(the.outline(name).locator('.artifact-review-outline')).toBeVisible();
      await expect(the.outline(name).locator('.artifact-review-outline-number')).toHaveText(String(open));
      await expect(the.heading(name).locator('.artifact-review-open')).toHaveText(`${open} open`);
    }
    await expect(the.form('decision-d1').getByRole('radio', { name: 'Codex' })).toBeChecked();
    // The default picked is not saved until it is.
    await expect(the.form('decision-d1').locator('.artifact-decision-unsaved')).toBeVisible();

    // The page takes no comments: the panel is its Decisions tab alone.
    await expect(the.decisions).toBeHidden();
    await the.count.click();
    await expect(the.decisions).toBeVisible();
    await expect(the.tabs).toHaveCount(1);
    await expect(the.tabs).toHaveText(/^Decisions/);
    await expect(the.tabs).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Comment on this page')).toHaveCount(0);
    await expect(page.getByText('Comment on a section')).toHaveCount(0);
    await expect(the.aside.locator('.artifact-comments-opener')).toHaveCount(0);
    await expect(the.titles).toHaveText(SECTIONS);
    expect(await held(the)).toEqual([['decision-d1', 'decision-d2'], ['decision-d3', 'decision-d4'],
      ['checklist-1'], ['decision-d5', 'decision-d6']]);
    await expect(the.entry('checklist-1').item.getByRole('checkbox')).toHaveCount(3);
    await expect(the.entry('checklist-1').box('Cite the line a finding is about')).toBeChecked();
    for (const target of [the.count, the.next]) {
      const drawn = await quiet(target);
      expect(drawn.border).toBe('0px');
      expect(drawn.background).not.toBe('rgba(0, 0, 0, 0)');
    }
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test('Next open steps through the open questions and wraps round', async ({ page }) => {
    firstRepeatOnly();
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await expect(the.count).toHaveText('7 to answer');
    const bar = await page.locator('.artifact-topbar').boundingBox();
    for (const question of [...QUESTIONS, 'decision-d1']) {
      await the.next.click();
      await expect(the.form(question).locator('input').first()).toBeFocused();
      const top = await the.form(question).evaluate((form) => form.getBoundingClientRect().top);
      expect(top).toBeGreaterThanOrEqual(bar!.y + bar!.height);
    }

    await page.reload();
    await expect(the.count).toHaveText('7 to answer');
    await the.heading('When a review blocks').locator('button.artifact-section-toggle').click();
    await expect(the.form('decision-d3')).toBeHidden();
    await the.next.click();
    await expect(the.form('decision-d1').locator('input').first()).toBeFocused();
    await the.next.click();
    await expect(the.form('decision-d2').locator('input').first()).toBeFocused();
    await the.next.click();
    await expect(the.form('decision-d3')).toBeVisible();
    await expect(the.form('decision-d3').locator('input').first()).toBeFocused();
  });

  test('a pick in the Decisions tab or on the page moves both, and each entry\'s Save stores its answer', async ({ page, request }) => {
    firstRepeatOnly();
    const seen = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await the.count.click();

    const first = the.entry('decision-d1');
    await first.option('Claude Opus').check();
    await expect(the.form('decision-d1').getByRole('radio', { name: 'Claude Opus' })).toBeChecked();
    await expect(first.unsaved).toBeVisible();

    await the.form('decision-d2').getByRole('radio', { name: 'Every ticket' }).check();
    await expect(the.entry('decision-d2').option('Every ticket')).toBeChecked();
    await expect(the.count).toHaveText('7 to answer');
    await expect(the.outline('Who reviews').locator('.artifact-review-outline-number')).toHaveText('2');
    await expect(the.heading('Who reviews').locator('.artifact-review-open')).toHaveText('2 open');

    await the.entry('checklist-1').box('Cite the line a finding is about').uncheck();
    await expect(the.form('checklist-1').getByRole('checkbox', { name: 'Cite the line a finding is about' }))
      .not.toBeChecked();

    for (const question of ['decision-d1', 'decision-d2', 'decision-d4', 'checklist-1', 'decision-d5']) {
      await the.entry(question).save.click();
      await expect(the.form(question).locator('.artifact-decision-saved-line')).toContainText('✓ Saved');
    }
    await expect(the.count).toHaveText('2 to answer');
    const answers = await stored(request);
    expect(Object.keys(answers).sort()).toEqual(
      ['checklist-1', 'decision-d1', 'decision-d2', 'decision-d4', 'decision-d5']);
    expect(answers['decision-d1'].current).toMatchObject({ choice: 'claude-opus' });
    expect(answers['decision-d2'].current).toMatchObject({ choice: 'every-ticket' });
    expect(answers['decision-d4'].current).toMatchObject({ choice: '3-rounds' });
    expect(answers['decision-d5'].current).toMatchObject({ choice: 'holophyte-only' });
    expect(answers['checklist-1'].current).toMatchObject({ checked: ['2'] });
    await expect(the.entries).toHaveCount(2);
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test('a form posts one answer at a time, so its form Save never lands after a Save in the Decisions tab', async ({ page, request }) => {
    firstRepeatOnly();
    // The page reads nothing answered; the form's own post of D3 is held.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    await page.route((url) => url.pathname === '/api/answers', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({ json: { page: 'capture-review-sheet', questions: {} } });
        return;
      }
      if (request.postDataJSON().question === 'decision-d3' && first) {
        first = false;
        await held;
      }
      await route.continue();
    });
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await expect(the.count).toHaveText('7 to answer');
    const form = the.form('decision-d3');
    await form.getByRole('radio', { name: 'Reproduced findings' }).check();
    await form.getByRole('button', { name: 'Save answer' }).click();
    await expect(form.locator('.artifact-decision-status')).toHaveText('Saving your answer...');
    await the.count.click();
    await the.entry('decision-d3').option('Any finding').check();
    await the.entry('decision-d3').save.click();
    release();
    await expect(form.locator('.artifact-decision-saved-line')).toContainText('Any finding');
    expect((await stored(request))['decision-d3'].current).toMatchObject({ choice: 'any-finding' });
  });

  test('a form answered only to an earlier wording gets its default picked on the form and in the Decisions tab', async ({ page }) => {
    firstRepeatOnly();
    const reads = (url: URL) => url.pathname === '/api/answers';
    await page.route(reads, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { page: 'capture-review-sheet', questions: {
          'decision-d1': { current: {
            id: 1, page: 'capture-review-sheet', question: 'decision-d1', version: '000000000000',
            choice: 'claude-opus', note: '', revision: 'abc123abc123',
            actor: { kind: 'human', name: 'maintainer' }, createdAt: '2026-10-01T09:30:00Z',
            supersedes: null,
          }, earlier: [] },
        } } })
        : route.continue());
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    const form = the.form('decision-d1');
    await expect(form.locator('.artifact-decision-earlier')).toContainText('Answered to an earlier wording');
    await expect(form.getByRole('radio', { name: 'Codex' })).toBeChecked();
    await expect(form.locator('.artifact-decision-unsaved')).toBeVisible();
    await the.count.click();
    await expect(the.entry('decision-d1').option('Codex')).toBeChecked();
    await expect(the.entry('decision-d1').unsaved).toBeVisible();
  });

  test('a refused change to a saved form opens it to say why', async ({ page, request }) => {
    firstRepeatOnly();
    const before = (await stored(request))['decision-d1'].current.choice;
    const other = before === 'codex' ? 'Claude Opus' : 'Codex';
    const reads = (url: URL) => url.pathname === '/api/answers';
    await page.route(reads, (route) =>
      route.request().method() === 'POST' && route.request().postDataJSON().question === 'decision-d1'
        ? route.fulfill({ status: 409, json: { error: 'stale_version' } })
        : route.continue());
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    const form = the.form('decision-d1');
    await expect(form.locator('.artifact-decision-saved-line')).toBeVisible();
    await the.count.click();
    await the.answered.click();
    const row = the.row('decision-d1');
    await row.change.click();
    await row.option(other).check();
    await row.save.click();
    await expect(form.locator('.artifact-decision-status')).toBeVisible();
    await expect(form.locator('.artifact-decision-status')).toHaveText(STALE);
    await expect(form.getByRole('radio', { name: other })).toBeVisible();
    await expect(form.getByRole('radio', { name: other })).toBeChecked();
    await expect(row.unsaved).toBeVisible();
    expect((await stored(request))['decision-d1'].current.choice).toBe(before);
  });

  test('a failed read of the answers draws no sheet, no Decisions tab and picks no default', async ({ page, request }) => {
    firstRepeatOnly();
    const before = (await stored(request))['decision-d1'].current;
    const reads = (url: URL) => url.pathname === '/api/answers';
    await page.route(reads, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 503, body: '' }) : route.continue());
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await page.waitForFunction(() => document.readyState === 'complete');
    await expect(the.form('decision-d1').locator('input[name="choice"]:checked')).toHaveCount(0);
    await expect(page.locator('.artifact-review-bar')).toHaveCount(0);
    await expect(the.aside).toBeHidden();
    await expect(page.getByRole('tab', { name: /^Decisions/ })).toHaveCount(0);
    await expect(page.locator('.artifact-answered')).toHaveCount(0);
    expect((await stored(request))['decision-d1'].current.id).toBe(before.id);
  });

  test('the questions open in the panel move to the bottom sheet as the window narrows, and back, the focus kept', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await the.count.click();
    // The earlier checks' answers saved, the first question still open.
    const option = the.entries.first().getByRole('radio').last();
    await option.focus();
    const bottom = page.locator('.artifact-comments-bottom-sheet');
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(bottom).toBeVisible();
    await expect(bottom.getByRole('tab', { name: /^Decisions/ })).toHaveAttribute('aria-selected', 'true');
    await expect(bottom.locator('.artifact-decisions-entry').first().getByRole('radio').last()).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(the.decisions).toBeVisible();
    await expect(bottom).toBeHidden();
    await expect(option).toBeFocused();
    expect(seen.errors).toEqual([]);
  });

  test('a page with no forms has no count, Next open or Decisions tab', async ({ page }) => {
    await page.goto('/capture-article.html?standalone');
    await expect(page.locator('nav.artifact-outline')).toBeVisible();
    await expect(page.locator('.artifact-review-bar, .artifact-review-open')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /^Decisions/ })).toHaveCount(0);
  });

  test.describe('at 360 by 740', () => {
    test.use({ viewport: { width: 360, height: 740 } });

    test('the count and Next open fit the title bar, and the count opens the bottom sheet on Decisions at the full width', async ({ page }) => {
      const reads = (url: URL) => url.pathname === '/api/answers';
      await page.route(reads, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { page: 'capture-review-sheet', questions: {} } })
          : route.continue());
      await page.goto(`${PAGE}?standalone`);
      const the = sheet(page);
      await expect(the.count).toHaveText('7 to answer');
      for (const target of [the.count, the.next]) {
        const box = await target.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      }
      await the.count.click();
      const bottom = page.locator('.artifact-comments-bottom-sheet');
      await expect(bottom.getByRole('tab')).toHaveCount(1);
      await expect(bottom.getByRole('tab', { name: /^Decisions/ })).toHaveAttribute('aria-selected', 'true');
      await expect(bottom.locator('.artifact-decisions-group-title').first()).toHaveText('Who reviews');
      const box = await bottom.boundingBox();
      expect(box!.x).toBe(0);
      expect(box!.width).toBe(360);
    });
  });

  test.describe('at 320 wide', () => {
    test.use({ viewport: { width: 320, height: 640 } });

    test('the count and Next open stay inside the window', async ({ page }) => {
      const reads = (url: URL) => url.pathname === '/api/answers';
      await page.route(reads, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { page: 'capture-review-sheet', questions: {} } })
          : route.continue());
      await page.goto(`${PAGE}?standalone`);
      const the = sheet(page);
      await expect(the.count).toHaveText('7 to answer');
      for (const target of [the.count, the.next]) {
        const box = await target.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
    });
  });

  test.describe('at 240 wide, then 1280', () => {
    test.use({ viewport: { width: 240, height: 640 } });

    test('Next open ends in an ellipsis when narrow and shows whole when wide', async ({ page }) => {
      const reads = (url: URL) => url.pathname === '/api/answers';
    await page.route(reads, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { page: 'capture-review-sheet', questions: {} } })
          : route.continue());
      await page.goto(`${PAGE}?standalone`);
      const the = sheet(page);
      await expect(the.count).toHaveText('7 to answer');
      // The count and Next open stay inside the window.
      for (const target of [the.count, the.next]) {
        const box = await target.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(240);
      }
      // The words truncate in their own span; the arrow after them lies
      // wholly inside the link and the window, so it shows whole.
      const fit = () => the.next.evaluate((link) => {
        const words = link.querySelector('.artifact-review-next-text') as HTMLElement;
        const arrow = (link.querySelector('.artifact-review-next-arrow') as HTMLElement).getBoundingClientRect();
        const box = link.getBoundingClientRect();
        return {
          overflow: getComputedStyle(words).textOverflow,
          scroll: words.scrollWidth,
          client: words.clientWidth,
          arrow: arrow.width > 0 && arrow.height > 0
            && arrow.left >= box.left && arrow.right <= box.right
            && arrow.top >= box.top && arrow.bottom <= box.bottom
            && arrow.left >= 0 && arrow.right <= document.documentElement.clientWidth
            && arrow.top >= 0 && arrow.bottom <= document.documentElement.clientHeight,
        };
      });
      const narrow = await fit();
      expect(narrow.overflow).toBe('ellipsis');
      expect(narrow.scroll).toBeGreaterThan(narrow.client);
      expect(narrow.client).toBeGreaterThan(0);
      expect(narrow.arrow).toBe(true);

      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(the.next).toContainText('Next open');
      const wide = await fit();
      expect(wide.scroll).toBeLessThanOrEqual(wide.client);
      expect(wide.arrow).toBe(true);
    });

    test('with no question open the title stays and the count fits', async ({ page }) => {
      const reads = (url: URL) => url.pathname === '/api/answers';
      // Each answer posted is taken as saved, so the site keeps none.
      let id = 0;
      await page.route(reads, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { page: 'capture-review-sheet', questions: {} } })
          : route.fulfill({ status: 201, json: { ...route.request().postDataJSON(), id: ++id,
            actor: { kind: 'human', name: 'maintainer' }, createdAt: '2026-10-01T09:30:00Z' } }));
      await page.goto(`${PAGE}?standalone`);
      const the = sheet(page);
      await expect(the.count).toHaveText('7 to answer');
      await expect(page.locator('.artifact-topbar-title')).toBeHidden();
      // A pick on each form with no default, and every answer saved, leaves
      // no question open.
      for (const question of ['decision-d2', 'decision-d3', 'decision-d6']) {
        await the.form(question).locator('input[name="choice"]').first().check();
      }
      for (const question of QUESTIONS) {
        await the.form(question).getByRole('button', { name: 'Save answer' }).click();
        await expect(the.form(question).locator('.artifact-decision-saved-line')).toBeAttached();
      }
      await expect(the.count).toHaveText('All answered');
      await expect(the.next).toBeHidden();
      expect(await page.locator('.artifact-topbar-title').evaluate((title) => getComputedStyle(title).display))
        .not.toBe('none');
      const box = await the.count.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(240);
    });
  });
});

// A page that is published again while its sheet is drawn: each check
// publishes a page of its own with a real `lotuspod publish`, as
// live-page.spec.ts does, and drives the page's clock, which asks for the
// page's revision every 60 seconds.
const ENV = process.env;
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const CHECK = 60_000;
const START = Date.parse('2026-10-02T12:00:00Z');

// A question's row: its #, words, options and default ('' for none).
type Row = [string, string, string, string];
// A section: its heading, and the rows of a decisions table under it, if
// any: an h2 "Decisions for the maintainer" is its own, any other h2 gets
// an h3 of that name.
type Part = [string, Row[]];

const HEATER: Row = ['1', 'Which heater?', 'Small / Large', ''];
const PUMP: Row = ['2', 'Lift the pump out?', 'Yes / No', ''];
const NET: Row = ['3', 'Net the pond?', 'Yes / No', ''];
const FISH: Row = ['4', 'Move the fish indoors?', 'Yes / No', ''];
const DECISIONS = 'Decisions for the maintainer';

function markdown(title: string, parts: Part[]) {
  const lines = [`# ${title}`, '', 'The pond, in winter.', ''];
  for (const [heading, rows] of parts) {
    lines.push(`## ${heading}`, '', `What we know about ${heading.toLowerCase()}.`, '');
    if (!rows.length) continue;
    if (heading !== DECISIONS) lines.push(`### ${DECISIONS}`, '');
    lines.push('| # | Question | Options | Default |', '| --- | --- | --- | --- |');
    for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
    lines.push('');
  }
  return lines.join('\n');
}

function publish(name: string, parts: Part[], comments = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-review-sheet-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown(name, parts), 'utf-8');
    const said = execFileSync(PYTHON, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', OUT,
      '--owner', 'hermes', '--credential', HERMES, ...(comments ? ['--comments'] : [])], {
      encoding: 'utf-8', env: { ...ENV, PYTHONPATH: SRC }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
    const revision = /at revision ([0-9a-f]{12})/.exec(said)?.[1] ?? '';
    expect(revision, said).not.toBe('');
    return revision;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A page name of the check's own, one per repeat: the site keeps answers.
function named(slug: string) {
  return `review-sheet-swap-${slug}-${test.info().repeatEachIndex}`;
}

// Publish the page, open it with its clock stopped and wait for its sheet;
// the number of loads and navigations from then on.
async function openPublished(page: Page, name: string, parts: Part[], comments = false) {
  publish(name, parts, comments);
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
  await page.goto(`/${name}.html?standalone`);
  await expect(page.locator('button.artifact-review-count')).toBeVisible();
  const moved = { count: 0 };
  page.on('load', () => { moved.count += 1; });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) moved.count += 1;
  });
  return moved;
}

// Publish the page again and let the 60-second check swap it in.
async function republish(page: Page, name: string, parts: Part[], comments = false) {
  const revision = publish(name, parts, comments);
  await page.clock.runFor(CHECK);
  await expect.poll(() => page.locator('meta[name="lotuspod:revision"]').getAttribute('content')).toBe(revision);
  await expect(page.locator('.artifact-live-page-banner')).toHaveCount(0);
}

test.describe('signed in, published again', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1440, height: 900 } });

  test('a section a republish adds is marked, one whose questions went is not, and the focus stays on an option', async ({ page }) => {
    const seen = await watch(page);
    const name = named('sections');
    const HOLE: Row = ['H1', 'Keep a hole in the ice?', 'Yes / No', ''];
    await openPublished(page, name, [['Heater', [HOLE]], [DECISIONS, [PUMP]]]);
    const the = sheet(page);
    await expect(the.count).toHaveText('2 to answer');
    await expect(the.heading('Heater').locator('.artifact-review-open')).toHaveText('1 open');
    await expect(the.outline('Heater').locator('.artifact-review-outline')).toHaveText('1 open');
    await the.count.click();
    await the.entry('decision-h1').option('No').focus();

    // The question moves to the new section with a new option, and the focus
    // follows it, staying on its option.
    await republish(page, name, [['Heater', []], [DECISIONS, [PUMP]],
      ['Spring', [['H1', 'Keep a hole in the ice?', 'Yes / Maybe / No', '']]]]);
    await expect(the.entry('decision-h1').option('Maybe')).toHaveCount(1);
    await expect(the.decisions).toBeVisible();
    await expect(the.entry('decision-h1').option('No')).toBeFocused();
    await expect(the.count).toHaveText('2 to answer');
    await expect(the.heading('Spring').locator('.artifact-review-open')).toHaveText('1 open');
    await expect(the.outline('Spring').locator('.artifact-review-outline')).toHaveText('1 open');
    await expect(the.heading(DECISIONS).locator('.artifact-review-open')).toHaveText('1 open');
    await expect(the.outline(DECISIONS).locator('.artifact-review-outline')).toHaveText('1 open');
    await expect(the.heading('Heater').locator('.artifact-review-open')).toHaveCount(0);
    await expect(the.outline('Heater').locator('.artifact-review-outline')).toHaveCount(0);
    await expect(the.titles).toHaveText([DECISIONS, 'Spring']);
    expect(seen.errors).toEqual([]);
  });

  test('Next open keeps its place by question when a republish adds one before it', async ({ page }) => {
    const seen = await watch(page);
    const name = named('next');
    const moved = await openPublished(page, name, [['Findings', []], [DECISIONS, [HEATER, PUMP, NET, FISH]]]);
    const the = sheet(page);
    await expect(the.heading(DECISIONS).locator('.artifact-review-open')).toHaveText('4 open');
    await expect(the.outline(DECISIONS).locator('.artifact-review-outline')).toHaveText('4 open');
    for (const question of ['decision-1', 'decision-2', 'decision-3']) {
      await the.next.click();
      await expect(the.form(question).locator('input').first()).toBeFocused();
    }
    // The focus in the section would hold it back.
    await page.locator('h1.artifact-title').click();

    const POND: Row = ['2b', 'Drain the pond?', 'Yes / No', ''];
    await republish(page, name, [['Findings', []], [DECISIONS, [HEATER, PUMP, POND, NET, FISH]]]);
    await expect(the.form('decision-2b')).toHaveCount(1);
    await expect(the.count).toHaveText('5 to answer');
    await expect(the.heading(DECISIONS).locator('.artifact-review-open')).toHaveText('5 open');
    await expect(the.outline(DECISIONS).locator('.artifact-review-outline')).toHaveText('5 open');
    await expect(the.next).toContainText('Move the fish indoors?');
    await the.next.click();
    await expect(the.form('decision-4').locator('input').first()).toBeFocused();
    expect(moved.count).toBe(0);
    expect(seen.errors).toEqual([]);
  });

  test('an answer saved stays counted, and a reworded question gets its default picked', async ({ page }) => {
    const seen = await watch(page);
    const name = named('reworded');
    const NETTED: Row = ['3', 'Net the pond?', 'Yes / No', 'Yes'];
    await openPublished(page, name, [[DECISIONS, [HEATER, PUMP, NETTED]]]);
    const the = sheet(page);
    await expect(the.form('decision-3').getByRole('radio', { name: 'Yes' })).toBeChecked();
    await expect(the.count).toHaveText('3 to answer');
    // The first answered, and the third's default saved, so no pick holds
    // the section back.
    await the.count.click();
    await the.entry('decision-1').option('Large').check();
    await the.entry('decision-1').save.click();
    await the.entry('decision-3').save.click();
    await expect(the.count).toHaveText('1 to answer');
    await page.locator('h1.artifact-title').click();

    await republish(page, name, [[DECISIONS, [HEATER, PUMP, ['3', 'Net the whole pond?', 'Yes / No', 'Yes']]]]);
    await expect(the.form('decision-3').locator('.artifact-decision-text')).toHaveText('Net the whole pond?');
    await expect(the.count).toHaveText('2 to answer');
    await expect(the.form('decision-3').getByRole('radio', { name: 'Yes' })).toBeChecked();
    await expect(the.form('decision-3').locator('.artifact-decision-unsaved')).toBeVisible();
    await expect(the.entry('decision-1').item).toHaveCount(0);
    await expect(the.entry('decision-3').option('Yes')).toBeChecked();
    await expect(the.entry('decision-3').unsaved).toBeVisible();
    expect(seen.errors).toEqual([]);
  });

  test('a swap whose read of the answers fails leaves its forms out, so no default is saved over an answer', async ({ page, request }) => {
    const seen = await watch(page);
    const name = named('failed-read');
    const NETTED: Row = ['3', 'Net the pond?', 'Yes / No', 'Yes'];
    await openPublished(page, name, [['Findings', []], [DECISIONS, [HEATER, NETTED]]]);
    const the = sheet(page);
    const form = the.form('decision-3');
    await form.getByRole('radio', { name: 'No' }).check();
    await form.getByRole('button', { name: 'Save answer' }).click();
    await expect(form.locator('.artifact-decision-saved-line')).toContainText('No');
    await expect(the.count).toHaveText('1 to answer');
    await page.locator('h1.artifact-title').click();

    const reads = (url: URL) => url.pathname === '/api/answers';
    await page.route(reads, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 503, body: '' }) : route.fallback());
    await republish(page, name, [['Findings', []], [DECISIONS, [HEATER, PUMP, NETTED]]]);
    await expect(the.form('decision-2')).toHaveCount(1);
    await expect(form.getByRole('radio', { name: 'Yes' })).not.toBeChecked();
    await expect(the.count).toBeHidden();
    await expect(the.next).toBeHidden();
    await expect(the.heading(DECISIONS).locator('.artifact-review-open')).toHaveCount(0);

    // The next read that succeeds draws them, the answer as saved.
    await page.unroute(reads);
    await republish(page, name, [['Findings', []], [DECISIONS, [HEATER, PUMP, NETTED, FISH]]]);
    await expect(the.count).toHaveText('3 to answer');
    await the.count.click();
    await the.answered.click();
    await expect(the.row('decision-3').label).toHaveText('No');
    await expect(the.row('decision-3').unsaved).toHaveCount(0);
    const answers = await request.get(`/api/answers?page=${name}`, { headers: SIGNED_IN });
    expect((await answers.json()).questions['decision-3'].current.choice).toBe('no');
    expect(seen.errors.filter((error) => !error.includes('503'))).toEqual([]);
  });

  test('the Decisions tab follows a republish that takes its questions away, and goes with the last', async ({ page }) => {
    const seen = await watch(page);
    const name = named('last');
    await openPublished(page, name, [['Findings', []], [DECISIONS, [HEATER, PUMP, NET]]]);
    const the = sheet(page);
    await the.count.click();
    await expect(the.decisions).toBeVisible();
    await expect(the.entries).toHaveCount(3);

    // One of the three taken away leaves the tab open on the two left.
    await republish(page, name, [['Findings', []], [DECISIONS, [HEATER, NET]]]);
    await expect(the.form('decision-2')).toHaveCount(0);
    await expect(the.decisions).toBeVisible();
    await expect(the.count).toHaveText('2 to answer');
    // The tab is drawn again once the swap's answers are read.
    await expect.poll(() => the.entries.evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset.question))).toEqual(['decision-1', 'decision-3']);

    await republish(page, name, [['Findings', []], [DECISIONS, []]]);
    await expect(the.form('decision-1')).toHaveCount(0);
    await expect(the.count).toBeHidden();
    // Published more than once, the page keeps its History tab beside Comments.
    await expect(the.tabs).toHaveText([/^Comments/, /^History/]);
    await expect(the.decisions).toBeHidden();
    await expect(the.heading(DECISIONS).locator('.artifact-review-open')).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });

  test('on a phone, the sheet open on Decisions goes to Comments as a republish takes the last question', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const seen = await watch(page);
    const name = named('phone');
    const parts: Part[] = [['Findings', []], [DECISIONS, [HEATER]]];
    publish(name, parts, true);
    expect((await page.request.post('/api/comments', {
      data: { page: name, section: 'findings', text: 'Is the ice thick yet?' },
    })).status()).toBe(201);
    await openPublished(page, name, parts, true);
    const bottom = page.locator('.artifact-comments-bottom-sheet');
    await page.locator('button.artifact-review-count').click();
    await expect(bottom.getByRole('tab', { name: /^Decisions/ })).toHaveAttribute('aria-selected', 'true');

    await republish(page, name, [['Findings', []], [DECISIONS, []]], true);
    await expect(page.locator('button.artifact-review-count')).toBeHidden();
    await expect(bottom).toBeVisible();
    await expect(bottom.getByRole('tablist')).toBeHidden();
    await expect(bottom.locator('.artifact-comment-thread', { hasText: 'Is the ice thick yet?' })).toBeVisible();
    expect(seen.errors).toEqual([]);
  });
});
