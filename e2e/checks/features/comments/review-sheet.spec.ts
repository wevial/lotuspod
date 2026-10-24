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

function sheet(page: Page) {
  const panel = page.locator('.artifact-review-panel');
  return {
    count: page.locator('button.artifact-review-count'),
    next: page.locator('a.artifact-review-next'),
    panel,
    close: panel.getByRole('button', { name: 'Close' }),
    tally: panel.locator('.artifact-review-tally'),
    groups: panel.locator('.artifact-review-group'),
    states: panel.locator('.artifact-review-state'),
    save: panel.locator('button.artifact-review-save'),
    outcome: panel.locator('.artifact-review-outcome'),
    entry: (question: string) => {
      const item = panel.locator(`li.artifact-review-entry[data-question="${question}"]`);
      return {
        item,
        option: (name: string) => item.getByRole('button', { name, exact: true }),
        box: (name: string) => item.getByRole('checkbox', { name }),
        state: item.locator('.artifact-review-state'),
        was: item.locator('.artifact-review-was'),
        unsaved: item.locator('.artifact-review-unsaved'),
      };
    },
    form: (question: string) => page.locator(`form.artifact-decision[data-question="${question}"]`),
    heading: (name: string) => page.locator('section.artifact-body h2', { hasText: name }),
    outline: (name: string) => page.locator('ol.artifact-outline-list a', { hasText: name }),
  };
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

  test('the title bar counts the open questions, and the outline and headings mark them', async ({ page }) => {
    firstRepeatOnly();
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const seen = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await expect(the.count).toHaveText('7 to answer · Respond');
    await expect(the.next).toBeVisible();
    for (const [name, open] of [['Who reviews', 2], ['When a review blocks', 2], ['Prompt rules', 1], ['Rollout', 2]] as const) {
      await expect(the.outline(name).locator('.artifact-review-outline')).toBeVisible();
      await expect(the.outline(name).locator('.artifact-review-outline-number')).toHaveText(String(open));
      await expect(the.heading(name).locator('.artifact-review-open')).toHaveText(`${open} open`);
    }
    await expect(the.form('decision-d1').getByRole('radio', { name: 'Codex' })).toBeChecked();
    // The default picked is not saved until it is.
    await expect(the.form('decision-d1').locator('.artifact-decision-unsaved')).toBeVisible();

    await the.count.click();
    await expect(the.panel).toBeVisible();
    for (const target of [the.count, the.next, the.states.first(), the.states.nth(1)]) {
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
    await expect(the.count).toHaveText('7 to answer · Respond');
    const bar = await page.locator('.artifact-topbar').boundingBox();
    for (const question of [...QUESTIONS, 'decision-d1']) {
      await the.next.click();
      await expect(the.form(question).locator('input').first()).toBeFocused();
      const top = await the.form(question).evaluate((form) => form.getBoundingClientRect().top);
      expect(top).toBeGreaterThanOrEqual(bar!.y + bar!.height);
    }

    await page.reload();
    await expect(the.count).toHaveText('7 to answer · Respond');
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

  test('the panel lists every question under its section with its state', async ({ page }) => {
    firstRepeatOnly();
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await the.count.click();
    await expect(the.panel).toBeVisible();
    await expect(the.panel).toHaveAttribute('role', 'dialog');
    await expect(the.close).toBeFocused();
    await expect(the.tally).toHaveText('7 to answer · 0 changed · 7 in all');
    await expect(the.groups.locator('.artifact-review-group-title')).toHaveText(SECTIONS);
    const held = await the.groups.evaluateAll((groups) => groups.map((group) =>
      Array.from(group.querySelectorAll('li.artifact-review-entry')).map((entry) =>
        (entry as HTMLElement).dataset.question)));
    expect(held).toEqual([['decision-d1', 'decision-d2'], ['decision-d3', 'decision-d4'],
      ['checklist-1'], ['decision-d5', 'decision-d6']]);
    await expect(the.states).toHaveText(['Default', 'Open', 'Open', 'Default', 'Default', 'Default', 'Open']);
    await expect(the.entry('decision-d1').option('Codex')).toHaveAttribute('aria-pressed', 'true');
    await expect(the.entry('decision-d2').option('Every ticket')).toHaveAttribute('aria-pressed', 'false');
    await expect(the.entry('checklist-1').box('Cite the line a finding is about')).toBeChecked();

    await the.close.click();
    await expect(the.panel).toBeHidden();
    await expect(the.count).toBeFocused();
  });

  test('a pick in the panel or on the page moves both, and one Save stores every answer', async ({ page, request }) => {
    firstRepeatOnly();
    const seen = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await the.count.click();
    await expect(the.save).toHaveText('Save 4 answers');

    const first = the.entry('decision-d1');
    await first.option('Claude Opus').click();
    await expect(the.form('decision-d1').getByRole('radio', { name: 'Claude Opus' })).toBeChecked();
    await expect(first.option('Claude Opus')).toHaveAttribute('aria-pressed', 'true');
    await expect(first.state).toHaveText('Changed');
    await expect(first.was).toHaveText('was: Codex');
    await expect(first.unsaved).toBeVisible();

    await the.form('decision-d2').getByRole('radio', { name: 'Every ticket' }).check();
    const second = the.entry('decision-d2');
    await expect(second.state).toHaveText('Changed');
    await expect(second.was).toHaveText('was: open');
    await expect(second.option('Every ticket')).toHaveAttribute('aria-pressed', 'true');
    await expect(the.count).toHaveText('7 to answer · Respond');
    await expect(the.outline('Who reviews').locator('.artifact-review-outline-number')).toHaveText('2');
    await expect(the.heading('Who reviews').locator('.artifact-review-open')).toHaveText('2 open');

    const rules = the.entry('checklist-1');
    await rules.box('Cite the line a finding is about').uncheck();
    await expect(the.form('checklist-1').getByRole('checkbox', { name: 'Cite the line a finding is about' }))
      .not.toBeChecked();
    await expect(rules.state).toHaveText('Changed');
    await expect(rules.was).toHaveText('Off: Cite the line a finding is about');
    await expect(the.tally).toHaveText('7 to answer · 3 changed · 7 in all');

    await page.keyboard.press('Escape');
    await expect(the.panel).toBeHidden();
    await expect(the.count).toBeFocused();

    await the.count.click();
    await expect(the.save).toHaveText('Save 5 answers');
    await the.save.click();
    await expect(the.save).toHaveText('Nothing new to save');
    await expect(the.save).toBeDisabled();
    await expect(the.outcome).toContainText('Saved at');
    await expect(the.outcome).toContainText('2 questions stay open.');
    const answers = await stored(request);
    expect(Object.keys(answers).sort()).toEqual(
      ['checklist-1', 'decision-d1', 'decision-d2', 'decision-d4', 'decision-d5']);
    expect(answers['decision-d1'].current).toMatchObject({ choice: 'claude-opus' });
    expect(answers['decision-d2'].current).toMatchObject({ choice: 'every-ticket' });
    expect(answers['decision-d4'].current).toMatchObject({ choice: '3-rounds' });
    expect(answers['decision-d5'].current).toMatchObject({ choice: 'holophyte-only' });
    expect(answers['checklist-1'].current).toMatchObject({ checked: ['2'] });
    for (const question of ['decision-d1', 'decision-d2', 'decision-d4', 'checklist-1', 'decision-d5']) {
      await expect(the.form(question).locator('.artifact-decision-saved-line')).toContainText('✓ Saved');
      await expect(the.entry(question).unsaved).toBeHidden();
    }
    await expect(the.states).toHaveText(['Changed', 'Changed', 'Open', 'Default', 'Changed', 'Default', 'Open']);
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test('a refused answer stays not saved while the others save', async ({ page, request }) => {
    firstRepeatOnly();
    // The page reads nothing answered; the answer to D3 is refused as stale.
    await page.route((url) => url.pathname === '/api/answers', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({ json: { page: 'capture-review-sheet', questions: {} } });
      } else if (request.postDataJSON().question === 'decision-d3') {
        await route.fulfill({ status: 409, json: { error: 'stale_version' } });
      } else {
        await route.continue();
      }
    });
    const before = (await stored(request))['decision-d6'];
    expect(before).toBeUndefined();
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await the.count.click();
    await the.entry('decision-d3').option('Any finding').click();
    await the.entry('decision-d6').option('The maintainer').click();
    await the.save.click();
    await expect(the.outcome).toContainText('1 answer was not saved.');
    await expect(the.entry('decision-d3').unsaved).toBeVisible();
    await expect(the.entry('decision-d3').unsaved).toHaveText('not saved');
    await expect(the.form('decision-d3').locator('.artifact-decision-status')).toHaveText(STALE);
    await expect(the.entry('decision-d6').unsaved).toBeHidden();
    expect((await stored(request))['decision-d6'].current).toMatchObject({ choice: 'the-maintainer' });
    expect((await stored(request))['decision-d3']).toBeUndefined();
  });

  test('a form posts one answer at a time, so its form Save never lands after a panel Save', async ({ page, request }) => {
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
    await expect(the.count).toHaveText('7 to answer · Respond');
    const form = the.form('decision-d3');
    await form.getByRole('radio', { name: 'Reproduced findings' }).check();
    await form.getByRole('button', { name: 'Save answer' }).click();
    await expect(form.locator('.artifact-decision-status')).toHaveText('Saving your answer...');
    await the.count.click();
    await the.entry('decision-d3').option('Any finding').click();
    await the.save.click();
    release();
    await expect(the.outcome).toContainText('Saved at');
    expect((await stored(request))['decision-d3'].current).toMatchObject({ choice: 'any-finding' });
  });

  test('a pick in the panel stays picked when its saved form is opened with "change"', async ({ page, request }) => {
    firstRepeatOnly();
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    const form = the.form('decision-d1');
    // A note changed alone is one change, saved only by the panel.
    await expect(form.locator('.artifact-decision-saved-line')).toBeVisible();
    await form.getByRole('button', { name: 'change' }).click();
    await form.locator('details.artifact-decision-note > summary').click();
    await form.locator('textarea[name="note"]').fill('Only the note changed');
    await the.count.click();
    await expect(the.entry('decision-d1').unsaved).toBeVisible();
    await expect(the.save).toHaveText('Save 1 answer');
    await the.save.click();
    await expect(the.save).toHaveText('Nothing new to save');
    expect((await stored(request))['decision-d1'].current).toMatchObject({ note: 'Only the note changed' });

    const before = (await stored(request))['decision-d1'].current.choice;
    const other = before === 'codex' ? 'Claude Opus' : 'Codex';
    await page.reload();
    await expect(form.locator('.artifact-decision-saved-line')).toBeVisible();
    await the.count.click();
    await the.entry('decision-d1').option(other).click();
    await expect(the.entry('decision-d1').unsaved).toBeVisible();
    await the.entry('decision-d1').item.locator('.artifact-review-show').click();
    await expect(the.panel).toBeHidden();
    await form.getByRole('button', { name: 'change' }).click();
    await expect(form.getByRole('radio', { name: other })).toBeChecked();
    await expect(form.locator('.artifact-decision-unsaved')).toBeVisible();
    await the.count.click();
    await expect(the.entry('decision-d1').unsaved).toBeVisible();
    await expect(the.entry('decision-d1').option(other)).toHaveAttribute('aria-pressed', 'true');
  });

  test('a form answered only to an earlier wording gets its default picked on the form and in the panel', async ({ page }) => {
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
    await expect(the.entry('decision-d1').option('Codex')).toHaveAttribute('aria-pressed', 'true');
    await expect(the.entry('decision-d1').state).toHaveText('Default');
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
    await the.entry('decision-d1').option(other).click();
    await the.save.click();
    await expect(the.outcome).toContainText('Nothing was saved');
    await expect(form.locator('.artifact-decision-status')).toBeVisible();
    await expect(form.locator('.artifact-decision-status')).toHaveText(STALE);
    await expect(form.getByRole('radio', { name: other })).toBeVisible();
    await expect(form.getByRole('radio', { name: other })).toBeChecked();
    await expect(the.entry('decision-d1').unsaved).toBeVisible();
    expect((await stored(request))['decision-d1'].current.choice).toBe(before);
  });

  test('a failed read of the answers draws no sheet and picks no default', async ({ page, request }) => {
    firstRepeatOnly();
    const before = (await stored(request))['decision-d1'].current;
    const reads = (url: URL) => url.pathname === '/api/answers';
    await page.route(reads, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 503, body: '' }) : route.continue());
    await page.goto(`${PAGE}?standalone`);
    const the = sheet(page);
    await page.waitForFunction(() => document.readyState === 'complete');
    await expect(the.form('decision-d1').locator('input[name="choice"]:checked')).toHaveCount(0);
    await expect(page.locator('.artifact-review-bar, .artifact-review-panel')).toHaveCount(0);
    await expect(page.locator('.artifact-answered')).toHaveCount(0);
    expect((await stored(request))['decision-d1'].current.id).toBe(before.id);
  });

  test('a page with no forms has no count, Next open or panel', async ({ page }) => {
    await page.goto('/capture-article.html?standalone');
    await expect(page.locator('nav.artifact-outline')).toBeVisible();
    await expect(page.locator('.artifact-review-bar, .artifact-review-panel, .artifact-review-open'))
      .toHaveCount(0);
  });

  test.describe('at 360 by 740', () => {
    test.use({ viewport: { width: 360, height: 740 } });

    test('the count and Next open fit the title bar and the panel takes the full width', async ({ page }) => {
      const reads = (url: URL) => url.pathname === '/api/answers';
    await page.route(reads, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { page: 'capture-review-sheet', questions: {} } })
          : route.continue());
      await page.goto(`${PAGE}?standalone`);
      const the = sheet(page);
      await expect(the.count).toHaveText('7 to answer · Respond');
      for (const target of [the.count, the.next]) {
        const box = await target.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      }
      await the.count.click();
      const box = await the.panel.boundingBox();
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
      await expect(the.count).toHaveText('7 to answer · Respond');
      for (const target of [the.count, the.next]) {
        const box = await target.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
    });
  });

  test.describe('at 280 wide, then 1280', () => {
    test.use({ viewport: { width: 280, height: 640 } });

    test('Next open ends in an ellipsis when narrow and shows whole when wide', async ({ page }) => {
      const reads = (url: URL) => url.pathname === '/api/answers';
    await page.route(reads, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { page: 'capture-review-sheet', questions: {} } })
          : route.continue());
      await page.goto(`${PAGE}?standalone`);
      const the = sheet(page);
      await expect(the.count).toHaveText('7 to answer · Respond');
      // The count and Next open stay inside the window.
      for (const target of [the.count, the.next]) {
        const box = await target.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(280);
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
      await expect(the.count).toHaveText('7 to answer · Respond');
      await expect(page.locator('.artifact-topbar-title')).toBeHidden();
      // A pick on each form with no default, and every answer saved, leaves
      // no question open.
      for (const question of ['decision-d2', 'decision-d3', 'decision-d6']) {
        await the.form(question).locator('input[name="choice"]').first().check();
      }
      await the.count.click();
      await the.save.click();
      await expect(the.outcome).toContainText('Saved at');
      await the.close.click();
      await expect(the.count).toHaveText('All answered · Respond');
      await expect(the.next).toBeHidden();
      expect(await page.locator('.artifact-topbar-title').evaluate((title) => getComputedStyle(title).display))
        .not.toBe('none');
      const box = await the.count.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(280);
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

function publish(name: string, parts: Part[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-review-sheet-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown(name, parts), 'utf-8');
    const said = execFileSync(PYTHON, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', OUT,
      '--owner', 'hermes', '--credential', HERMES], {
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
async function openPublished(page: Page, name: string, parts: Part[]) {
  publish(name, parts);
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
async function republish(page: Page, name: string, parts: Part[]) {
  const revision = publish(name, parts);
  await page.clock.runFor(CHECK);
  await expect.poll(() => page.locator('meta[name="lotuspod:revision"]').getAttribute('content')).toBe(revision);
  await expect(page.locator('.artifact-live-page-banner')).toHaveCount(0);
}

test.describe('signed in, published again', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1440, height: 900 } });

  test('a section a republish adds is marked, and one whose questions went is not', async ({ page }) => {
    const seen = await watch(page);
    const name = named('sections');
    const HOLE: Row = ['H1', 'Keep a hole in the ice?', 'Yes / No', ''];
    await openPublished(page, name, [['Heater', [HOLE]], [DECISIONS, [PUMP]]]);
    const the = sheet(page);
    await expect(the.count).toHaveText('2 to answer · Respond');
    await expect(the.heading('Heater').locator('.artifact-review-open')).toHaveText('1 open');
    await expect(the.outline('Heater').locator('.artifact-review-outline')).toHaveText('1 open');
    await the.count.click();
    await the.entry('decision-h1').option('No').focus();

    // The question moves to the new section with a new option, and the focus
    // follows it, staying on its option.
    await republish(page, name, [['Heater', []], [DECISIONS, [PUMP]],
      ['Spring', [['H1', 'Keep a hole in the ice?', 'Yes / Maybe / No', '']]]]);
    await expect(the.entry('decision-h1').option('Maybe')).toHaveCount(1);
    await expect(the.panel).toBeVisible();
    await expect(the.entry('decision-h1').option('No')).toBeFocused();
    await expect(the.count).toHaveText('2 to answer · Respond');
    await expect(the.heading('Spring').locator('.artifact-review-open')).toHaveText('1 open');
    await expect(the.outline('Spring').locator('.artifact-review-outline')).toHaveText('1 open');
    await expect(the.heading(DECISIONS).locator('.artifact-review-open')).toHaveText('1 open');
    await expect(the.outline(DECISIONS).locator('.artifact-review-outline')).toHaveText('1 open');
    await expect(the.heading('Heater').locator('.artifact-review-open')).toHaveCount(0);
    await expect(the.outline('Heater').locator('.artifact-review-outline')).toHaveCount(0);
    await expect(the.groups.locator('.artifact-review-group-title')).toHaveText([DECISIONS, 'Spring']);
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
    await expect(the.count).toHaveText('5 to answer · Respond');
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
    await expect(the.count).toHaveText('3 to answer · Respond');
    // The first answered, and the third's default saved with it, so no
    // pick holds the section back.
    await the.count.click();
    await the.entry('decision-1').option('Large').click();
    await the.save.click();
    await expect(the.outcome).toContainText('Saved at');
    await expect(the.count).toHaveText('1 to answer · Respond');
    await the.close.click();
    await page.locator('h1.artifact-title').click();

    await republish(page, name, [[DECISIONS, [HEATER, PUMP, ['3', 'Net the whole pond?', 'Yes / No', 'Yes']]]]);
    await expect(the.form('decision-3').locator('.artifact-decision-text')).toHaveText('Net the whole pond?');
    await expect(the.count).toHaveText('2 to answer · Respond');
    await expect(the.form('decision-3').getByRole('radio', { name: 'Yes' })).toBeChecked();
    await expect(the.form('decision-3').locator('.artifact-decision-unsaved')).toBeVisible();
    await the.count.click();
    await expect(the.entry('decision-1').state).toHaveText('Changed');
    await expect(the.entry('decision-1').unsaved).toBeHidden();
    await expect(the.entry('decision-3').state).toHaveText('Default');
    await expect(the.entry('decision-3').unsaved).toBeVisible();
    await expect(the.save).toHaveText('Save 1 answer');
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
    await expect(the.count).toHaveText('1 to answer · Respond');
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
    await expect(the.count).toHaveText('3 to answer · Respond');
    await the.count.click();
    await expect(the.entry('decision-3').option('No')).toHaveAttribute('aria-pressed', 'true');
    await expect(the.entry('decision-3').unsaved).toBeHidden();
    const answers = await request.get(`/api/answers?page=${name}`, { headers: SIGNED_IN });
    expect((await answers.json()).questions['decision-3'].current.choice).toBe('no');
    expect(seen.errors.filter((error) => !error.includes('503'))).toEqual([]);
  });

  test('the panel stays open, its focus on Close, as a republish takes the last question away', async ({ page }) => {
    const seen = await watch(page);
    const name = named('last');
    await openPublished(page, name, [['Findings', []], [DECISIONS, [HEATER, PUMP, NET]]]);
    const the = sheet(page);
    await the.count.click();
    await expect(the.panel).toBeVisible();
    await expect(page.locator('li.artifact-review-entry')).toHaveCount(3);

    // One of the three taken away leaves the panel open on the two left.
    await republish(page, name, [['Findings', []], [DECISIONS, [HEATER, NET]]]);
    await expect(the.form('decision-2')).toHaveCount(0);
    await expect(the.panel).toBeVisible();
    await expect(page.locator('li.artifact-review-entry')).toHaveCount(2);
    expect(await page.locator('li.artifact-review-entry').evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset.question))).toEqual(['decision-1', 'decision-3']);
    await expect(the.tally).toHaveText('2 to answer · 0 changed · 2 in all');
    await expect(the.count).toHaveText('2 to answer · Respond');
    await the.entry('decision-1').option('Large').focus();

    await republish(page, name, [['Findings', []], [DECISIONS, []]]);
    await expect(the.form('decision-1')).toHaveCount(0);
    await expect(the.panel).toBeVisible();
    await expect(page.locator('li.artifact-review-entry')).toHaveCount(0);
    await expect(the.tally).toHaveText('All answered · 0 changed · 0 in all');
    await expect(the.close).toBeFocused();
    await expect(the.count).toBeHidden();
    await expect(the.heading(DECISIONS).locator('.artifact-review-open')).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });
});
