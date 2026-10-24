import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The comments panel's Decisions tab. Each check publishes a page of its own
// as hermes on the capture fixture's site with a real `lotuspod publish
// --local --comments`: "Pull request rows" asks 1 (no default) and 2,
// "Screenshots on a row" asks 3 and "Backfill" asks 4, each with a default.
// Question 4 is saved as "Only open tickets" with a note, which opens a
// thread on it, and one thread posted on "Screenshots on a row" before the
// reader loads it, so three questions are to answer and two threads are
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
const PHONE = { width: 360, height: 740 };
const CONTEXT_1 = 'The facts line already holds rounds and waits-on.';
const OPTIONS: Record<string, string[]> = {
  'decision-1': ['Beside the title', 'In the facts line', 'Only on hover'],
  'decision-2': ['Added and removed', 'One total', 'A small bar'],
  'decision-3': ['Overlay on the console', 'A new tab'],
};
const BACKFILL = ['Only open tickets', 'Everything since September', 'None'];
const NOTE_4 = 'Merged ones can keep the blank cell.';
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
  `| 4 | Backfill which tickets? | Closed tickets are rarely opened again. | ${BACKFILL.join(' / ')} | Only open tickets |`,
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

// The page published, question 4 saved at its default with a note and one
// thread on "Screenshots on a row", each through the site's routes.
async function prepare(request: APIRequestContext, name: string) {
  publish(name, MARKDOWN);
  const html = await (await request.get(`/${name}.html?standalone`)).text();
  const version = html.match(/data-question="decision-4" data-version="([^"]+)"/)?.[1];
  expect(version, 'question 4 is asked').toBeTruthy();
  const section = html.match(/<details class="artifact-comment"[^>]*data-section="(screenshots[^"]*)"/)?.[1]
    ?? 'screenshots-on-a-row';
  const answered = await request.post('/api/answers', {
    headers: SIGNED_IN,
    data: { page: name, question: 'decision-4', version, choice: 'only-open-tickets', note: NOTE_4 },
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
    answered: decisions.locator('details.artifact-decisions-answered'),
    answeredSummary: decisions.locator('details.artifact-decisions-answered > summary'),
    answeredTitles: decisions.locator('.artifact-decisions-answered-title'),
    rows: decisions.locator('.artifact-decisions-row'),
  };
}

// A saved question's row in the Decisions tab's Answered list.
function row(page: Page, question: string) {
  const item = page.locator(`.artifact-comments-decisions .artifact-decisions-row[data-question="${question}"]`);
  return {
    item,
    title: item.locator('button.artifact-decisions-row-title'),
    label: item.locator('.artifact-decisions-row-label'),
    by: item.locator('.artifact-decisions-row-by'),
    change: item.getByRole('button', { name: 'change', exact: true }),
    radios: item.getByRole('radio'),
    option: (name: string) => item.getByRole('radio', { name }),
    noteSummary: item.locator('details.artifact-decisions-note > summary'),
    note: item.locator('details.artifact-decisions-note textarea'),
    save: item.getByRole('button', { name: 'Save', exact: true }),
    cancel: item.getByRole('button', { name: 'Cancel', exact: true }),
    unsaved: item.locator('.artifact-decisions-unsaved'),
    show: item.getByRole('button', { name: 'Show on page' }),
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
    ask: item.locator('.artifact-decisions-foot button.artifact-decisions-ask'),
    askField: item.locator('.artifact-decisions-asking textarea'),
    askSend: item.locator('.artifact-decisions-asking button.artifact-decisions-ask-send'),
    askStatus: item.locator('.artifact-decisions-asking .artifact-decisions-ask-status'),
    threads: item.locator('button.artifact-decisions-threads'),
  };
}

// What the site keeps for a page: its answers by question and its threads.
async function stored(request: APIRequestContext, name: string) {
  const answers = await request.get(`/api/answers?page=${name}`, { headers: SIGNED_IN });
  const comments = await request.get(`/api/comments?page=${name}`, { headers: SIGNED_IN });
  expect(answers.status()).toBe(200);
  expect(comments.status()).toBe(200);
  return {
    answers: (await answers.json()).questions as Record<string, { current: { choice?: string; note?: string } | null }>,
    threads: (await comments.json()).threads as { root: { question?: string; text: string } }[],
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

  await expect(page.locator('button.artifact-review-count')).toHaveText('3 to answer');
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
  await expect(side.badge('Comments')).toHaveText('2');
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
  // The tab's badge counts the open threads; the count line is read, not
  // shown, so the ways to start a thread sit right under the tabs.
  const tally = threads.locator('.artifact-comments-tally');
  await expect(tally.locator('.artifact-comments-count')).toHaveText('2 open · 0 resolved');
  expect(await tally.evaluate((node) => node.getBoundingClientRect().height)).toBe(0);
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
  await expect(count).toHaveText('2 to answer');
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
  await expect(count).toHaveText('2 to answer');

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

test('the title bar\'s count and the folded rail\'s orchid count open Decisions, and the opener and a chip open Comments', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
  const name = 'decisions-panel-rail';
  await prepare(request, name);
  const errors = watch(page);
  await load(page, name, 'folded');
  const side = panel(page);
  // The title bar's count unfolds the panel on Decisions, the focus on the
  // first question to answer; nothing of the review sheet's is drawn into
  // the body, where its panel was.
  const count = page.locator('button.artifact-review-count');
  await expect(count).toHaveText('3 to answer');
  await expect(side.decisions).toBeHidden();
  await expect(count).toHaveAttribute('aria-controls', 'artifact-comments-decisions');
  await count.click();
  await expect(side.decisions).toBeVisible();
  await expect(side.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
  await expect(entry(page, 'decision-1').question).toBeFocused();
  await expect(page.locator('body > [class*="artifact-review"]')).toHaveCount(0);
  await side.fold.click();

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

test('a folded heading counts a saved question reopened by its change as answered, as every count does', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
  const name = 'decisions-panel-folded';
  await prepare(request, name);
  const errors = watch(page);
  await load(page, name);
  const side = panel(page);
  const own = card(page, 'decision-1');
  await own.option('Beside the title').check();
  await own.save.click();
  await expect(own.saved).toHaveText('✓ Saved · Beside the title · change');
  await own.form.locator('.artifact-decision-change').click();
  await expect(own.option('Beside the title')).toBeVisible();
  await page.locator('h2#pull-request-rows button.artifact-section-toggle').click();
  await expect(page.locator('h2#pull-request-rows .artifact-section-mark:not([hidden])')).toHaveText('1 to answer');
  await expect(page.locator('button.artifact-review-count')).toHaveText('2 to answer');
  await expect(side.badge('Decisions')).toHaveText('2');
  expect(errors).toEqual([]);
});

test('a saved question moves to the folded Answered list, and its row changes the answer in place', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
  const name = 'decisions-panel-answered';
  await prepare(request, name);
  const errors = watch(page);
  await load(page, name);
  const side = panel(page);
  const four = row(page, 'decision-4');
  const fourth = card(page, 'decision-4');

  await expect(side.answered).toHaveJSProperty('open', false);
  await expect(side.answeredSummary).toHaveText('Answered · 1');
  await side.answeredSummary.click();
  await expect(side.answered).toHaveJSProperty('open', true);
  await expect(side.answeredTitles).toHaveText(['Backfill']);
  await expect(side.rows).toHaveCount(1);
  await expect(four.title).toHaveText('4 · Backfill which tickets?');
  await expect(four.label).toHaveText('Only open tickets');
  const by = (await fourth.form.locator('.artifact-decision-saved-by').innerText()).trim();
  expect(by).not.toBe('');
  await expect(four.by).toHaveText(by);
  await expect(four.change).toBeVisible();
  await expect(four.radios).toHaveCount(0);

  // Saved from its entry, its Ask field left open and empty, question 1
  // reads "Saved", then joins the list, which stays open.
  const one = entry(page, 'decision-1');
  await one.item.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Ask about decision 1' })).toBeVisible();
  await one.option('Beside the title').check();
  await one.save.click();
  await expect(one.saved).toHaveText('✓ Saved · Beside the title');
  await expect(one.item).toHaveCount(0);
  await expect(side.answeredSummary).toHaveText('Answered · 2');
  await expect(side.answered).toHaveJSProperty('open', true);
  await expect(side.answeredTitles).toHaveText(['Pull request rows', 'Backfill']);
  expect(await side.rows.evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.question)))
    .toEqual(['decision-1', 'decision-4']);
  await expect(row(page, 'decision-1').title).toHaveText('1 · Where should the diff size sit?');
  await expect(row(page, 'decision-1').label).toHaveText('Beside the title');
  // A row saved with no note still edits it under "Edit note", and an Ask
  // field left empty does not follow it: an Answered row has no Ask.
  await row(page, 'decision-1').change.click();
  await expect(row(page, 'decision-1').noteSummary).toHaveText('Edit note');
  await expect(row(page, 'decision-1').item.locator('.artifact-decisions-asking')).toHaveCount(0);
  await expect(row(page, 'decision-1').item.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
  await row(page, 'decision-1').title.click();
  await expect(row(page, 'decision-1').radios).toHaveCount(0);

  // "change" opens the row in place, as saved.
  await four.change.click();
  await expect(four.option('Only open tickets')).toBeChecked();
  await expect(four.radios).toHaveCount(BACKFILL.length);
  await expect(four.noteSummary).toHaveText('Edit note');
  await expect(four.note).toHaveValue(NOTE_4);
  for (const button of [four.save, four.cancel, four.show]) await expect(button).toBeVisible();
  await expect(four.unsaved).toBeHidden();
  await expect(fourth.saved).toBeVisible();

  // A pick opens the card, not saved.
  await four.option('Everything since September').check();
  await expect(four.unsaved).toHaveText('not saved');
  await expect(four.unsaved).toBeVisible();
  await expect(fourth.form).not.toHaveClass(/artifact-decision--saved/);
  await expect(fourth.option('Everything since September')).toBeChecked();
  await expect(fourth.unsaved).toBeVisible();

  // Cancel puts the saved pick back in both, folds the card and collapses
  // the row.
  await four.cancel.click();
  // The folded card's radios are hidden, so they are found by value.
  await expect(fourth.form.locator('input[name="choice"][value="only-open-tickets"]')).toBeChecked();
  await expect(fourth.saved).toHaveText('✓ Saved · Only open tickets · change');
  await expect(fourth.unsaved).toBeHidden();
  await expect(four.radios).toHaveCount(0);
  await expect(four.label).toHaveText('Only open tickets');
  await four.title.click();
  await expect(four.option('Only open tickets')).toBeChecked();
  await expect(four.note).toHaveValue(NOTE_4);

  // Saved, the row collapses to its new answer, still in the list.
  await four.option('None').check();
  await four.note.fill('None after all.');
  await expect(fourth.note).toHaveValue('None after all.');
  // Cancel waits while the Save is under way.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/api/answers', async (route) => {
    if (route.request().method() === 'POST') await held;
    return route.fallback();
  });
  const posted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/answers' && response.request().method() === 'POST');
  await four.save.click();
  await expect(four.cancel).toBeDisabled();
  release();
  expect((await posted).status()).toBe(201);
  await expect(four.radios).toHaveCount(0);
  await expect(four.label).toHaveText('None');
  await expect(fourth.saved).toHaveText('✓ Saved · None · change');
  await expect(side.answeredSummary).toHaveText('Answered · 2');
  const { answers } = await stored(request, name);
  expect(answers['decision-4'].current).toMatchObject({ choice: 'none', note: 'None after all.' });
  expect(errors).toEqual([]);
});

test('a question asked from the panel posts its own field, not the note, and its entry links to the thread', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'asks on a page the first repeat asked on');
  const name = 'decisions-panel-ask';
  await prepare(request, name);
  const errors = watch(page);
  await load(page, name);
  const side = panel(page);
  const two = entry(page, 'decision-2');
  const second = card(page, 'decision-2');
  const asked = 'Does the total count generated files?';

  await two.addNote.click();
  await two.note.fill('Keep it short.');
  await expect(second.note).toHaveValue('Keep it short.');
  await expect(two.threads).toHaveCount(0);
  await two.ask.click();
  const field = side.decisions.getByRole('textbox', { name: 'Ask about decision 2' });
  await expect(field).toBeFocused();
  await field.fill(asked);
  const posted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'POST');
  await two.askSend.click();
  const sent = await posted;
  expect(sent.status()).toBe(201);
  expect(sent.request().postDataJSON()).toMatchObject({ page: name, question: 'decision-2', text: asked });
  await expect(two.askField).toHaveCount(0);
  await expect(second.note).toHaveValue('Keep it short.');
  await expect(two.note).toHaveValue('Keep it short.');
  await expect(side.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
  const { threads } = await stored(request, name);
  expect(threads.filter((thread) => thread.root.question === 'decision-2').map((thread) => thread.root.text))
    .toEqual([asked]);
  await expect(second.form.locator('xpath=following-sibling::*[1]')).toHaveClass(/artifact-decision-chip/);
  await expect(second.form.locator('xpath=following-sibling::*[1]')).toContainText('1 comment');

  // The entry's link opens the thread in the Comments tab.
  await expect(two.threads.locator('.artifact-decisions-threads-count')).toHaveText('1 thread');
  await expect(two.threads.locator('.artifact-decisions-threads-standing')).toHaveText('waiting');
  await two.threads.click();
  await expect(side.tab('Comments')).toHaveAttribute('aria-selected', 'true');
  const group = side.groups.locator('.artifact-comments-group')
    .filter({ has: page.locator('.artifact-comments-group-title', { hasText: 'Pull request rows' }) });
  const opened = group.locator('.artifact-comments-entry--open');
  await expect(opened).toHaveCount(1);
  await expect(opened).toContainText(asked);
  await expect(opened).toBeInViewport();

  // Opened again, the field is empty.
  await side.tab('Decisions').click();
  await two.ask.click();
  await expect(two.askField).toHaveValue('');

  // Dismissed with an unsent question in its Ask, it is in neither list.
  await two.askField.fill('Unsent question');
  await second.form.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(second.saved).toContainText('Dismissed');
  await expect(two.item).toHaveCount(0);
  await expect(row(page, 'decision-2').item).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an empty panel Ask posts nothing, and the card\'s Ask still sends and empties the note', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(test.info().repeatEachIndex > 0, 'asks on a page the first repeat asked on');
  const name = 'decisions-panel-ask-empty';
  await prepare(request, name);
  const errors = watch(page, ['500 (Internal Server Error)']);
  await load(page, name);
  const posts: string[] = [];
  page.on('request', (sent) => {
    if (new URL(sent.url()).pathname === '/api/comments' && sent.method() === 'POST') posts.push(sent.postData() ?? '');
  });
  const before = (await stored(request, name)).threads.length;
  const three = entry(page, 'decision-3');
  await three.ask.click();
  await expect(page.getByRole('textbox', { name: 'Ask about decision 3' })).toBeVisible();
  await three.askSend.click();
  await expect(three.askStatus).toHaveText('Write your question first.');
  expect(posts).toEqual([]);
  expect((await stored(request, name)).threads.length).toBe(before);

  const second = card(page, 'decision-2');
  const two = entry(page, 'decision-2');
  const question = 'Is the minus sign a true minus?';
  await second.noteBox.locator('summary').click();
  await second.note.fill(question);
  await expect(two.note).toHaveValue(question);
  const posted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'POST');
  await second.form.getByRole('button', { name: 'Ask', exact: true }).click();
  const sent = await posted;
  expect(sent.status()).toBe(201);
  expect(sent.request().postDataJSON()).toMatchObject({ question: 'decision-2', text: question });
  await expect(second.note).toHaveValue('');
  await panel(page).tab('Decisions').click();
  await expect(two.note).toHaveValue('');

  // Text added while a question is sending stays in the field, unsent.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/api/comments', async (route) => {
    if (route.request().method() === 'POST') await held;
    return route.fallback();
  });
  await three.askField.fill('Does Esc close it?');
  const asked = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'POST');
  await three.askSend.click();
  await three.askField.fill('Does Esc close it? And a click outside?');
  release();
  expect((await asked).request().postDataJSON()).toMatchObject({ question: 'decision-3', text: 'Does Esc close it?' });
  await expect(three.askStatus).toHaveText('');
  await expect(three.askField).toHaveValue('Does Esc close it? And a click outside?');

  // The question's section, held back by its unsaved pick and then updated
  // to a new revision, keeps its field open with the unsent question.
  await page.evaluate(() => {
    (window as any).swapped = new Promise<void>((resolve) =>
      document.addEventListener('lotuspod:swapped', () => setTimeout(resolve), { once: true }));
  });
  publish(name, MARKDOWN.replace('shown as thumbnails', 'each shown as a thumbnail'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.evaluate(() => (window as any).swapped);
  await page.locator('button.artifact-swap-update').click();
  await expect(page.getByText('each shown as a thumbnail')).toBeVisible();
  await expect(three.askField).toHaveValue('Does Esc close it? And a click outside?');

  // Saved while its Ask holds an unsent question with a send still pending,
  // the question still moves to Answered. Its row has no Ask, collapsed or
  // open: opened, it shows the unsent question read only, with how the
  // pending send went.
  const side = panel(page);
  const third = row(page, 'decision-3');
  const carried = third.item.locator('.artifact-decisions-row-unsent');
  let refuse = () => {};
  const holding = new Promise<void>((resolve) => { refuse = resolve; });
  const comments = (url: URL) => url.pathname === '/api/comments';
  await page.route(comments, async (route) => {
    if (route.request().method() === 'POST') {
      await holding;
      return route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal server error while storing the question thread on this page' }) });
    }
    return route.fallback();
  });
  const refused = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'POST');
  await three.askSend.click();
  await expect(three.askSend).toBeDisabled();
  await three.save.click();
  await expect(card(page, 'decision-3').saved).toBeVisible();
  await expect(three.item).toHaveCount(0);
  await expect(side.answeredSummary).toHaveText('Answered · 2');
  await side.answeredSummary.click();
  await expect(third.label).toHaveText('Overlay on the console');
  await expect(third.item.locator('textarea')).toHaveCount(0);
  await expect(third.item.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
  await third.change.click();
  await expect(carried.locator('q')).toHaveText('Does Esc close it? And a click outside?');
  await expect(carried).toContainText('Your question, not sent:');
  await expect(carried).toContainText('Sending your question...');
  await expect(third.item.locator('.artifact-decisions-asking')).toHaveCount(0);
  await expect(third.item.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
  refuse();
  expect((await refused).status()).toBe(500);
  const status = carried.locator('.artifact-decisions-ask-status');
  await expect(status).not.toHaveText('Sending your question...');
  await expect(status).not.toHaveText('');
  await expect(carried.locator('q')).toHaveText('Does Esc close it? And a click outside?');
  await expect(third.item.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
  // A long refusal wraps inside the panel.
  const [inside, right] = await Promise.all([
    status.evaluate((node) => node.getBoundingClientRect().right),
    side.aside.evaluate((node) => node.getBoundingClientRect().right),
  ]);
  expect(inside).toBeLessThanOrEqual(right);
  expect(await side.decisions.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.unroute(comments);
  const texts = (await stored(request, name)).threads.map((thread) => thread.root.text);
  expect(texts.filter((text) => text === 'Does Esc close it?')).toHaveLength(1);
  expect(texts).not.toContain('Does Esc close it? And a click outside?');
  await third.cancel.click();
  await expect(carried).toHaveCount(0);
  await expect(row(page, 'decision-3').label).toHaveText('Overlay on the console');
  expect(errors).toEqual([]);
});

// The bottom sheet, in place of the panel on a phone.
function bottom(page: Page) {
  const node = page.locator('.artifact-comments-bottom-sheet');
  const tabs = node.getByRole('tablist');
  return {
    node,
    tab: (name: 'Decisions' | 'Comments') => tabs.getByRole('tab', { name: new RegExp(`^${name}`) }),
    decisions: node.locator('.artifact-comments-bottom-sheet-decisions'),
    at: node.locator('.artifact-comments-bottom-sheet-at'),
    close: node.getByRole('button', { name: 'Close', exact: true }),
    entry: (question: string) => node.locator(`.artifact-decisions-entry[data-question="${question}"]`),
  };
}

test.describe('on a phone', () => {
  test.use({ viewport: PHONE });

  test('the count opens the bottom sheet on Decisions, and a chip on Comments, each tab a press away', async ({ page, request }) => {
    test.setTimeout(90_000);
    // A page of each repeat's own, as the site keeps its answers.
    const name = `decisions-panel-phone-${test.info().repeatEachIndex}`;
    await prepare(request, name);
    const errors = watch(page);
    await load(page, name);
    const count = page.locator('button.artifact-review-count');
    await expect(count).toHaveText('3 to answer');
    for (const target of [count, page.locator('a.artifact-review-next')]) {
      const box = (await target.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    }
    await expect(count).toHaveAttribute('aria-controls', 'artifact-comments-bottom-sheet-decisions');

    const sheet = bottom(page);
    await count.click();
    await expect(sheet.node).toBeVisible();
    expect(await sheet.node.boundingBox()).toMatchObject({ x: 0, width: PHONE.width });
    await expect(sheet.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.decisions.locator('.artifact-decisions-group-title').first()).toHaveText('Pull request rows');
    expect(await sheet.decisions.locator('.artifact-decisions-group').first().locator('.artifact-decisions-entry')
      .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.question)))
      .toEqual(['decision-1', 'decision-2']);
    await expect(sheet.entry('decision-1').locator('button.artifact-decisions-question')).toBeFocused();

    // A pick and its Save in the sheet are the card's.
    await sheet.entry('decision-1').getByRole('radio', { name: 'In the facts line' }).check();
    const posted = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/answers' && response.request().method() === 'POST');
    await sheet.entry('decision-1').getByRole('button', { name: 'Save', exact: true }).click();
    expect((await posted).status()).toBe(201);
    expect((await stored(request, name)).answers['decision-1'].current).toMatchObject({ choice: 'in-the-facts-line' });
    await expect(count).toHaveText('2 to answer');

    // Closed, the sheet gives the questions back to the panel's tab.
    await sheet.close.click();
    await expect(sheet.node).toBeHidden();
    await expect(sheet.node.locator('[data-question]')).toHaveCount(0);
    await expect(panel(page).decisions.locator('[data-question="decision-1"]')).toHaveCount(1);

    // A chip opens the sheet on Comments at its thread; the tabs swap the
    // questions and the thread.
    const chip = page.locator('details.artifact-comment[data-section="screenshots-on-a-row"] > summary');
    const thread = sheet.node.locator('.artifact-comment-thread', { hasText: 'Should the lightbox close on Esc?' });
    await chip.click();
    await expect(sheet.tab('Comments')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.at).toHaveText('1 of 2');
    await expect(thread).toBeVisible();
    await sheet.tab('Decisions').click();
    await expect(sheet.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.entry('decision-2')).toBeVisible();
    await expect(thread).toBeHidden();
    await sheet.tab('Comments').click();
    await expect(thread).toBeVisible();
    await expect(sheet.entry('decision-2')).toBeHidden();
    await sheet.close.click();

    // From 700 pixels a chip opens a popover, and the count still the sheet.
    await page.setViewportSize({ width: 800, height: 900 });
    await chip.click();
    await expect(page.locator('.artifact-comments-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await count.click();
    await expect(sheet.node).toBeVisible();
    await expect(sheet.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.entry('decision-2')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
