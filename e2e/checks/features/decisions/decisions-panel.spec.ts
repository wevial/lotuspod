import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The comments panel's Decisions tab. Each check publishes a page of its own
// as hermes on the capture fixture's site with a real `lotuspod publish
// --local --comments`: "Pull request rows" asks 1 (no default) and 2,
// "Screenshots on a row" asks 3 and "Backfill" asks 4, each with a default.
// Question 4 is saved and one thread posted on "Screenshots on a row" before
// the reader loads it, so three questions are to answer and one thread is
// open. The run shares one database, so each check names its own page.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const PANEL = 'lotuspod:comments-panel';
const WIDE = { width: 1280, height: 800 };
const CONTEXT_1 = 'The facts line already holds rounds and waits-on.';
const OPTIONS: Record<string, string[]> = {
  'decision-1': ['Beside the title', 'In the facts line', 'Only on hover'],
  'decision-2': ['Added and removed', 'One total', 'A small bar'],
  'decision-3': ['Overlay on the console', 'A new tab'],
};
const MARKDOWN = ['# Console PR rows plan', '',
  'How each PR row reads in the console.', '',
  '## Pull request rows', '',
  'Each PR row carries the facts the serve route sends: rounds, what it waits on, and the diff size.', '',
  '### Decisions for the maintainer', '',
  '| # | Question | Context | Options | Default |', '| --- | --- | --- | --- | --- |',
  `| 1 | Where should the diff size sit? | ${CONTEXT_1} | ${OPTIONS['decision-1'].join(' / ')} | |`,
  `| 2 | How is the diff size written? | The PR's own numbers read as +412 −88. | ${OPTIONS['decision-2'].join(' / ')} | Added and removed |`,
  '', '## Screenshots on a row', '',
  'A row may carry screenshots, shown as thumbnails.', '',
  '### Decisions for the maintainer', '',
  '| # | Question | Context | Options | Default |', '| --- | --- | --- | --- | --- |',
  `| 3 | Lightbox surface | Where a row's screenshots open when a thumbnail is clicked. | ${OPTIONS['decision-3'].join(' / ')} | Overlay on the console |`,
  '', '## Backfill', '',
  'The rows of tickets opened before the change.', '',
  '### Decisions for the maintainer', '',
  '| # | Question | Context | Options | Default |', '| --- | --- | --- | --- | --- |',
  '| 4 | Backfill which tickets? | Closed tickets are rarely opened again. | Only open tickets / Every ticket | Only open tickets |',
  ''].join('\n');
// A page with comments and no decision or checklist forms.
const PLAIN = ['# Pond notes', '', 'Notes on the pond.', '', '## Fish', '', 'Two koi.', ''].join('\n');

test.use({ extraHTTPHeaders: SIGNED_IN, viewport: WIDE });

// The page polls /api/comments; a poll still in a route handler's route.fetch
// when a check ends would otherwise fail that check with "Test ended".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function run(args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish(name: string, markdown: string) {
  for (const [key, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${key}`).toBeTruthy();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-decisions-panel-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run(['publish', file, '--local', '--out-dir', OUT, '--owner', 'hermes',
      '--credential', HERMES, '--comments']);
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The page published, question 4 saved at its default and one thread on
// "Screenshots on a row", each through the site's routes.
async function prepare(request: APIRequestContext, name: string) {
  publish(name, MARKDOWN);
  const html = await (await request.get(`/${name}.html?standalone`)).text();
  const version = html.match(/data-question="decision-4" data-version="([^"]+)"/)?.[1];
  expect(version, 'question 4 is asked').toBeTruthy();
  const section = html.match(/<details class="artifact-comment"[^>]*data-section="(screenshots[^"]*)"/)?.[1]
    ?? 'screenshots-on-a-row';
  const answered = await request.post('/api/answers', {
    headers: SIGNED_IN,
    data: { page: name, question: 'decision-4', version, choice: 'only-open-tickets', note: '' },
  });
  expect(answered.status()).toBe(201);
  const thread = await request.post('/api/comments', {
    headers: SIGNED_IN,
    data: { page: name, section, text: 'Should the lightbox close on Esc?' },
  });
  expect(thread.status()).toBe(201);
}

// Page errors, and console errors but the status lines of answers a check
// routed to fail.
function watch(page: Page, answered: string[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const expected = answered.some((status) =>
      message.text() === `Failed to load resource: the server responded with a status of ${status}`);
    if (message.type() === 'error' && !expected) errors.push(message.text());
  });
  return errors;
}

// Load the page, its panel remembered open or folded.
async function load(page: Page, name: string, panel: 'open' | 'folded' = 'open') {
  await page.addInitScript(([key, value]) => {
    if (!sessionStorage.getItem('__remembered')) {
      sessionStorage.setItem('__remembered', '1');
      localStorage.setItem(key, value);
    }
  }, [PANEL, panel]);
  await page.goto(`/${name}.html?standalone`);
  await expect(page.locator('button.artifact-review-count')).toBeVisible();
}

function card(page: Page, question: string) {
  const form = page.locator(`form.artifact-decision[data-question="${question}"]`);
  return {
    form,
    option: (name: string) => form.getByRole('radio', { name }),
    unsaved: form.locator('.artifact-decision-unsaved'),
    note: form.locator('textarea[name="note"]'),
    noteBox: form.locator('details.artifact-decision-note'),
    save: form.getByRole('button', { name: 'Save answer' }),
    saved: form.locator('.artifact-decision-saved-line'),
    status: form.locator('.artifact-decision-status'),
  };
}

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  const tabs = aside.getByRole('tablist');
  const decisions = aside.locator('.artifact-comments-decisions');
  const rail = aside.locator('.artifact-comments-rail');
  return {
    aside,
    tabs,
    tab: (name: 'Decisions' | 'Comments') => tabs.getByRole('tab', { name: new RegExp(`^${name}`) }),
    badge: (name: 'Decisions' | 'Comments') =>
      tabs.getByRole('tab', { name: new RegExp(`^${name}`) }).locator('.artifact-comments-tab-badge'),
    decisions,
    titles: decisions.locator('.artifact-decisions-group-title'),
    group: (title: string) => decisions.locator('.artifact-decisions-group')
      .filter({ has: page.locator('.artifact-decisions-group-title', { hasText: title }) }),
    entries: decisions.locator('.artifact-decisions-entry'),
    none: decisions.locator('.artifact-decisions-none'),
    groups: aside.locator('.artifact-comments-groups'),
    title: aside.locator('h2.artifact-comments-title'),
    rail,
    toAnswer: rail.locator('button.artifact-comments-to-answer'),
    opener: rail.locator('.artifact-comments-opener'),
    dots: rail.locator('ol.artifact-comments-dots'),
    fold: aside.locator('button.artifact-comments-fold'),
  };
}

function entry(page: Page, question: string) {
  const item = page.locator(`.artifact-comments-decisions .artifact-decisions-entry[data-question="${question}"]`);
  return {
    item,
    question: item.locator('button.artifact-decisions-question'),
    context: item.locator('p.artifact-decision-context'),
    radios: item.getByRole('radio'),
    option: (name: string) => item.getByRole('radio', { name }),
    labels: item.locator('.artifact-decision-label'),
    addNote: item.locator('details.artifact-decisions-note > summary'),
    note: item.locator('details.artifact-decisions-note textarea'),
    save: item.getByRole('button', { name: 'Save', exact: true }),
    unsaved: item.locator('.artifact-decisions-unsaved'),
    saved: item.locator('.artifact-decisions-saved'),
    show: item.getByRole('button', { name: 'Show on page' }),
  };
}

// The question whose form holds the focus.
function focused(page: Page) {
  return page.evaluate(() =>
    document.activeElement?.closest<HTMLElement>('form.artifact-decision')?.dataset.question ?? null);
}

// How far a form's top sits below the title bar's bottom.
function belowBar(page: Page, question: string) {
  return page.evaluate((id) => {
    const bar = document.querySelector('.artifact-topbar')!.getBoundingClientRect().bottom;
    const form = document.querySelector(`form.artifact-decision[data-question="${id}"]`)!;
    return Math.round(form.getBoundingClientRect().top - bar);
  }, question);
}

test('every question with no saved answer is to answer, in the title bar, the marks, Next open and the Decisions tab', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
  const name = 'decisions-panel-counts';
  await prepare(request, name);
  const errors = watch(page);
  await load(page, name);

  await expect(page.locator('button.artifact-review-count')).toHaveText('3 to answer · Respond');
  const mark = (id: string) => page.locator(`h2#${id} .artifact-review-open`);
  await expect(mark('pull-request-rows')).toHaveText('2 open');
  await expect(mark('screenshots-on-a-row')).toHaveText('1 open');
  await expect(mark('backfill')).toBeHidden();
  const next = page.locator('a.artifact-review-next');
  for (const question of ['decision-1', 'decision-2', 'decision-3', 'decision-1']) {
    await next.click();
    await expect.poll(() => focused(page)).toBe(question);
  }

  const side = panel(page);
  await expect(side.tabs).toBeVisible();
  await expect(side.tabs.getByRole('tab')).toHaveCount(2);
  await expect(side.badge('Decisions')).toHaveText('3');
  await expect(side.badge('Comments')).toHaveText('1');
  await expect(side.title).toHaveCount(0);
  await expect(side.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
  await expect(side.decisions).toBeVisible();
  await expect(side.titles).toHaveText(['Pull request rows', 'Screenshots on a row']);
  expect(await side.group('Pull request rows').locator('.artifact-decisions-entry')
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.question)))
    .toEqual(['decision-1', 'decision-2']);
  expect(await side.group('Screenshots on a row').locator('.artifact-decisions-entry')
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.question)))
    .toEqual(['decision-3']);
  await expect(side.group('Backfill')).toHaveCount(0);

  const first = entry(page, 'decision-1');
  await expect(first.context.first()).toHaveText(CONTEXT_1);
  const second = entry(page, 'decision-2');
  await expect(second.option('Added and removed')).toBeChecked();
  await expect(second.item.locator('label', { has: page.locator('input:checked') })
    .locator('.artifact-decision-default')).toBeVisible();
  for (const [question, labels] of Object.entries(OPTIONS)) {
    const own = entry(page, question);
    await expect(own.labels).toHaveText(labels);
    await expect(own.radios).toHaveCount(labels.length);
    await expect(card(page, question).form.locator('.artifact-decision-label')).toHaveText(labels);
  }

  await side.tab('Comments').click();
  await expect(side.tab('Comments')).toHaveAttribute('aria-selected', 'true');
  await expect(side.decisions).toBeHidden();
  await expect(side.groups.locator('.artifact-comments-group-title', { hasText: 'Screenshots on a row' }))
    .toBeVisible();
  // The tab's panel holds the threads, not only the ways to start one.
  const threads = side.aside.getByRole('tabpanel', { name: /^Comments/ });
  await expect(side.tab('Comments')).toHaveAttribute('aria-controls', (await threads.getAttribute('id'))!);
  await expect(threads.locator('.artifact-comments-groups .artifact-comments-group-title',
    { hasText: 'Screenshots on a row' })).toBeVisible();
  await expect(threads.getByRole('button', { name: 'Comment on a section' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a pick or a note in the panel is the card\'s, and Save posts it as the card would', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
  const name = 'decisions-panel-state';
  await prepare(request, name);
  const errors = watch(page, ['500 (Internal Server Error)']);
  await load(page, name);
  const side = panel(page);
  const count = page.locator('button.artifact-review-count');
  const one = entry(page, 'decision-1');
  const own = card(page, 'decision-1');

  await one.option('In the facts line').check();
  await expect(own.option('In the facts line')).toBeChecked();
  await expect(own.unsaved).toBeVisible();
  await own.option('Only on hover').check();
  await expect(one.option('Only on hover')).toBeChecked();
  await expect(one.unsaved).toHaveText('not saved');
  await expect(one.unsaved).toBeVisible();
  await expect(one.addNote).toHaveText(await own.noteBox.locator('summary').innerText());
  await one.addNote.click();
  await one.note.fill('Hover is enough.');
  await expect(own.note).toHaveValue('Hover is enough.');
  await expect(own.noteBox).toHaveAttribute('open', '');

  const posted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/answers' && response.request().method() === 'POST');
  await one.save.click();
  const body = await (await posted).json();
  expect(body).toMatchObject({ question: 'decision-1', choice: 'only-on-hover', note: 'Hover is enough.' });
  await expect(own.saved).toHaveText('✓ Saved · Only on hover · change');
  await expect(one.saved).toHaveText('✓ Saved · Only on hover');
  await expect(one.item).toHaveCount(0);
  await expect(count).toHaveText('2 to answer · Respond');
  await expect(side.badge('Decisions')).toHaveText('2');
  await expect(page.locator('h2#pull-request-rows .artifact-review-open')).toHaveText('1 open');

  // A refused save keeps the entry, and the card says why.
  await page.route((url) => url.pathname === '/api/answers', (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON()?.question === 'decision-2') {
      return route.fulfill({ status: 500, json: { error: 'storage_unavailable' } });
    }
    return route.fallback();
  });
  const two = entry(page, 'decision-2');
  await two.save.click();
  await expect(card(page, 'decision-2').status)
    .toHaveText('Your answer was not saved (storage_unavailable). Try again.');
  await expect(two.item).toBeVisible();
  await expect(two.unsaved).toBeVisible();
  await expect(count).toHaveText('2 to answer · Respond');

  // Saved from its card, question 3 leaves, and its heading with it.
  await card(page, 'decision-3').save.click();
  await expect(card(page, 'decision-3').saved).toContainText('Saved · Overlay on the console');
  await expect(side.group('Screenshots on a row')).toHaveCount(0);
  await expect(side.titles).toHaveText(['Pull request rows']);
  expect(errors).toEqual([]);
});

test('a question\'s text, and its Show on page, put its card under the title bar with the panel kept on Decisions', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
  const name = 'decisions-panel-jump';
  await prepare(request, name);
  const errors = watch(page);
  await load(page, name);
  const side = panel(page);
  const two = entry(page, 'decision-2');
  for (const press of [two.question, two.show]) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await press.click();
    await expect.poll(() => focused(page)).toBe('decision-2');
    await expect(card(page, 'decision-2').option('Added and removed')).toBeFocused();
    await expect.poll(() => belowBar(page, 'decision-2')).toBe(16);
    await expect(side.decisions).toBeVisible();
    await expect(side.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
  }
  expect(errors).toEqual([]);
});

test('the folded rail\'s orchid count opens Decisions, and the opener and a chip open Comments', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
  const name = 'decisions-panel-rail';
  await prepare(request, name);
  const errors = watch(page);
  await load(page, name, 'folded');
  const side = panel(page);
  await expect(side.toAnswer).toBeVisible();
  await expect(side.toAnswer).toHaveAttribute('aria-label', '3 to answer: open the questions');
  await expect(side.toAnswer.locator('.artifact-comments-to-answer-count')).toHaveText('3');
  await expect(side.toAnswer.locator('.artifact-comments-to-answer-label')).toHaveText('to answer');
  const above = await page.evaluate(() => {
    const button = document.querySelector('.artifact-comments-to-answer')!.getBoundingClientRect();
    const dots = document.querySelector('ol.artifact-comments-dots')!.getBoundingClientRect();
    return button.bottom <= dots.top;
  });
  expect(above).toBe(true);

  await side.toAnswer.click();
  await expect(side.decisions).toBeVisible();
  await expect(side.tab('Decisions')).toHaveAttribute('aria-selected', 'true');

  await side.fold.click();
  await expect(side.opener).toBeVisible();
  await side.opener.click();
  await expect(side.tab('Comments')).toHaveAttribute('aria-selected', 'true');
  await expect(side.decisions).toBeHidden();

  await side.tab('Decisions').click();
  await expect(side.decisions).toBeVisible();
  await page.locator('details.artifact-comment[data-section="screenshots-on-a-row"] > summary').click();
  await expect(side.tab('Comments')).toHaveAttribute('aria-selected', 'true');
  await expect(side.decisions).toBeHidden();

  // Every question saved: the rail and the tab say so.
  await side.tab('Decisions').click();
  for (const question of ['decision-1', 'decision-2', 'decision-3']) {
    const own = card(page, question);
    if (question === 'decision-1') await own.option('Beside the title').check();
    await own.save.click();
    await expect(own.saved).toBeVisible();
  }
  await expect(side.none).toHaveText('Nothing left to answer');
  await expect(side.badge('Decisions')).toHaveText('✓');
  await side.fold.click();
  await expect(side.toAnswer.locator('.artifact-comments-to-answer-count')).toHaveText('✓');
  await expect(side.toAnswer.locator('.artifact-comments-to-answer-label')).toHaveText('answered');
  expect(errors).toEqual([]);
});

test('a page with comments and no decision forms keeps its panel\'s Comments heading and no tabs', async ({ page }) => {
  test.setTimeout(60_000);
  test.skip(test.info().repeatEachIndex > 0, 'publishes a page the first repeat published');
  const name = 'decisions-panel-plain';
  publish(name, PLAIN);
  const errors = watch(page);
  await page.addInitScript(([key]) => localStorage.setItem(key, 'open'), [PANEL]);
  await page.goto(`/${name}.html?standalone`);
  const side = panel(page);
  await expect(side.title).toHaveText('Comments');
  await expect(side.aside.getByRole('tablist')).toHaveCount(0);
  await expect(side.toAnswer).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a pick made while the panel\'s Save is pending keeps the entry, not saved', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
  const name = 'decisions-panel-pending';
  await prepare(request, name);
  const errors = watch(page);
  await load(page, name);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/api/answers', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON()?.question === 'decision-1') {
      await held;
    }
    return route.fallback();
  });
  const one = entry(page, 'decision-1');
  const own = card(page, 'decision-1');
  await one.option('Beside the title').check();
  const posted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/answers' && response.request().method() === 'POST');
  await one.save.click();
  await own.option('Only on hover').check();
  release();
  expect(await (await posted).json()).toMatchObject({ question: 'decision-1', choice: 'beside-the-title' });
  await expect(own.unsaved).toBeVisible();
  // Past the moment a saved entry reads "Saved", it is still listed.
  await page.waitForTimeout(2_000);
  await expect(one.item).toBeVisible();
  await expect(one.saved).toHaveCount(0);
  await expect(one.option('Only on hover')).toBeChecked();
  await expect(one.unsaved).toBeVisible();
  // Saved again, it leaves.
  await one.save.click();
  await expect(one.item).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('at the panel\'s narrowest both tabs sit clear of the fold', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
  const name = 'decisions-panel-narrow';
  await prepare(request, name);
  const errors = watch(page);
  await load(page, name);
  const side = panel(page);
  await side.aside.evaluate((aside) => (aside as HTMLElement).style.setProperty('--comments-panel-width', '16rem'));
  const comments = (await side.tab('Comments').boundingBox())!;
  const fold = (await side.fold.boundingBox())!;
  expect(comments.x + comments.width).toBeLessThanOrEqual(fold.x);
  // A press at the Comments tab's right edge selects it, and the panel stays open.
  await side.tab('Comments').click({ position: { x: comments.width - 2, y: comments.height / 2 } });
  await expect(side.tab('Comments')).toHaveAttribute('aria-selected', 'true');
  await expect(side.groups).toBeVisible();
  expect(errors).toEqual([]);
});
