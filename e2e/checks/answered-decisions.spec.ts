import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The capture fixture's answered page: Pump asks question 1, Heater asks
// questions 2 and 3, and each section ends in a comment box naming the page.
// Once any question is answered, the page script ends the page in an
// "Answered" table built from the answers route. These checks are the only
// ones that answer on this page; what they stub is served through page.route.
const PAGE = '/capture-answered.html';
const ANSWERS = '/api/answers?page=capture-answered';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
// The reader as a page names them: their address's part before the @.
const READER = 'maintainer';

async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function decision(page: Page, question: string) {
  const form = page.locator(`form.artifact-decision[data-question="${question}"]`);
  return {
    form,
    option: (name: string | RegExp) => form.getByRole('radio', { name }),
    addNote: form.locator('details.artifact-decision-note > summary'),
    note: form.locator('textarea[name="note"]'),
    save: form.getByRole('button', { name: 'Save answer' }),
    saved: form.locator('.artifact-decision-saved-line'),
    change: form.getByRole('button', { name: 'change' }),
    earlier: form.locator('.artifact-decision-earlier'),
  };
}

function answered(page: Page) {
  const table = page.getByRole('table', { name: 'Answered' });
  const rows = table.locator('tbody tr');
  // The row whose # cell reads number.
  const row = (number: string) => {
    const tr = rows.filter({ has: page.locator('td.artifact-answered-number', { hasText: new RegExp(`^${number}$`) }) });
    return {
      tr,
      cells: tr.locator('td'),
      label: tr.locator('.artifact-answered-choice strong'),
      note: tr.locator('.artifact-answered-note'),
      change: tr.getByRole('button', { name: 'change' }),
    };
  };
  return { table, rows, row };
}

// Each body row's #, question, answer (its label) and by.
async function readRows(page: Page) {
  return answered(page).rows.evaluateAll((rows) => rows.map((tr) => {
    const cell = (name: string) => (tr.querySelector(`.artifact-answered-${name}`)?.textContent ?? '').trim();
    return [cell('number'), cell('question'), cell('choice').split(' · ')[0], cell('by')];
  }));
}

async function stored(request: APIRequestContext) {
  const response = await request.get(ANSWERS, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  return (await response.json()).questions;
}

// Answer the page's read of the answers route with the stored answers and
// what extra() adds; its posts still reach the site.
async function serve(page: Page, extra: () => object) {
  await page.route((url) => url.pathname === '/api/answers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const read = await response.json();
    await route.fulfill({ response, json: { ...read, questions: { ...read.questions, ...extra() } } });
  });
}

async function fits(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 900 } });

  test('saved answers end the page in an Answered table, newest first, that a reload keeps', async ({ page, request }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const errors = await watch(page);
    expect(await stored(request)).toEqual({});
    await page.goto(PAGE);
    await expect(decision(page, 'decision-1').save).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    await expect(page.locator('.artifact-answered')).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Answered' })).toHaveCount(0);

    const heater = decision(page, 'decision-2');
    await heater.option('Solar').check();
    await heater.addNote.click();
    await heater.note.fill('Out of the wind');
    await heater.save.click();
    await expect(heater.saved).toContainText('Saved · Solar · change');
    await expect(answered(page).rows).toHaveCount(1);

    const pump = decision(page, 'decision-1');
    await pump.option('Submerged').check();
    await pump.save.click();
    await expect(pump.saved).toContainText('Saved · Submerged · change');

    const drawn = async () => {
      const { table, rows, row } = answered(page);
      await expect(table).toBeVisible();
      await expect(table.locator('thead th')).toHaveText(['#', 'When', 'Question', 'Answer', 'By']);
      await expect(rows).toHaveCount(2);
      expect(await readRows(page)).toEqual([
        ['1', 'Which pump?', 'Submerged', READER],
        ['2', 'Which heater?', 'Solar', READER],
      ]);
      await expect(row('2').note).toHaveText('Out of the wind');
      await expect(row('1').note).toHaveCount(0);
      const [label, note] = [await row('2').label.boundingBox(), await row('2').note.boundingBox()];
      expect(note!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1);
      for (const number of ['1', '2']) await expect(row(number).change).toBeVisible();
      // The table follows the page's last section, in the body.
      const place = await page.locator('.artifact-answered').evaluate((node) => ({
        parent: node.parentElement!.matches('section.artifact-body'),
        after: node.previousElementSibling!.matches('div.artifact-section-body[data-section="heater"]'),
        last: [...node.parentElement!.querySelectorAll(':scope > .artifact-section-body')].pop()!
          .compareDocumentPosition(node) === Node.DOCUMENT_POSITION_FOLLOWING,
      }));
      expect(place).toEqual({ parent: true, after: true, last: true });
      await expect(page.locator('.artifact-answered table')).toHaveCount(1);
      await expect(heater.saved).toContainText('Saved · Solar · change');
      await expect(pump.saved).toContainText('Saved · Submerged · change');
    };
    await drawn();
    await page.reload();
    await drawn();
    expect(errors).toEqual([]);
  });

  test('a row\'s change reopens its card, opening its folded section, and a new answer moves to the top', async ({ page }) => {
    const errors = await watch(page);
    await page.goto(PAGE);
    const { rows, row } = answered(page);
    await expect(rows).toHaveCount(2);

    await row('2').change.click();
    const heater = decision(page, 'decision-2');
    await expect(heater.option('Solar')).toBeChecked();
    await expect(heater.option('Solar')).toBeFocused();
    await expect(heater.note).toHaveValue('Out of the wind');
    await heater.option(/^Electric/).check();
    await heater.save.click();
    await expect(heater.saved).toContainText('Saved · Electric · change');
    expect(await readRows(page)).toEqual([
      ['2', 'Which heater?', 'Electric', READER],
      ['1', 'Which pump?', 'Submerged', READER],
    ]);
    await expect(row('2').note).toHaveText('Out of the wind');

    const wrapper = page.locator('div.artifact-section-body[data-section="pump"]');
    const toggle = page.locator('h2#pump button.artifact-section-toggle');
    await toggle.click();
    await expect(wrapper).toHaveAttribute('hidden', 'until-found');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await row('1').change.click();
    await expect(wrapper).not.toHaveAttribute('hidden');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const pump = decision(page, 'decision-1');
    await expect(pump.option('Submerged')).toBeChecked();
    await expect(pump.option('Submerged')).toBeFocused();
    await expect(pump.option('Submerged')).toBeInViewport();
    await expect(pump.saved).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a page published again without its decisions tables still shows its answers, in the words they were given in', async ({ page }) => {
    const errors = await watch(page);
    await page.route((url) => url.pathname === PAGE, async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(/<form class="artifact-decision"[\s\S]*?<\/form>\n?/g, '');
      await route.fulfill({ response, body: html });
    });
    await page.goto(PAGE);
    await expect(page.locator('form.artifact-decision')).toHaveCount(0);
    const { rows, table } = answered(page);
    await expect(rows).toHaveCount(2);
    expect(await readRows(page)).toEqual([
      ['2', 'Which heater?', 'Electric', READER],
      ['1', 'Which pump?', 'Submerged', READER],
    ]);
    await expect(table.getByRole('button', { name: 'change' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test.describe('in en-US at UTC', () => {
    test.use({ locale: 'en-US', timezoneId: 'UTC' });

    test('an answer to an earlier wording keeps its words in its row, without change, and its card stays open', async ({ page }) => {
      const errors = await watch(page);
      await serve(page, () => ({
        'decision-3': {
          current: {
            id: 1, page: 'capture-answered', question: 'decision-3', version: '000000000000',
            choice: 'no', note: '', revision: 'abc123abc123', actor: { kind: 'human', name: READER },
            createdAt: '2026-10-01T09:30:00Z', supersedes: null,
            asked: { text: 'Feed the fish?', label: 'No' },
          },
          earlier: [],
        },
      }));
      await page.goto(PAGE);
      const { rows, row } = answered(page);
      await expect(rows).toHaveCount(3);
      await expect(row('3').cells).toHaveText(['3', 'Oct 1, 2026, 9:30 AM', 'Feed the fish?', 'No', READER]);
      await expect(row('3').change).toHaveCount(0);
      const card = decision(page, 'decision-3');
      await expect(card.earlier).toContainText('Answered to an earlier wording');
      await expect(card.saved).toHaveCount(0);
      await expect(card.save).toBeVisible();
      expect(errors).toEqual([]);
    });
  });

  test('at 360 pixels wide a note of several lines wraps in the table and the page does not scroll sideways', async ({ page }) => {
    const errors = await watch(page);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(PAGE);
    const version = await decision(page, 'decision-3').form.getAttribute('data-version');
    await serve(page, () => ({
      'decision-3': {
        current: {
          id: 999999, page: 'capture-answered', question: 'decision-3', version,
          choice: 'yes', note: 'Feed them sparingly while the ice holds, '.repeat(6) + '\nand stop below four degrees.',
          revision: 'abc123abc123', actor: { kind: 'human', name: READER },
          createdAt: '2026-10-01T09:30:00Z', supersedes: null,
          asked: { text: 'Feed the fish in winter?', label: 'Yes' },
        },
        earlier: [],
      },
    }));
    await page.reload();
    const { rows, row } = answered(page);
    await expect(rows).toHaveCount(3);
    await expect(row('3').note).toBeVisible();
    await page.locator('.artifact-answered').scrollIntoViewIfNeeded();
    await fits(page);
    const box = await page.locator('.artifact-answered').evaluate((node) => ({
      scroll: node.scrollWidth, client: node.clientWidth,
    }));
    expect(box.scroll).toBeLessThanOrEqual(box.client);
    expect(errors).toEqual([]);
  });

  test('the Answered table folds under its heading, stays folded after a reload, and counts a new answer while folded', async ({ page }) => {
    const errors = await watch(page);
    await page.goto(PAGE);
    // A folded table is out of the accessibility tree, so its rows are found
    // by class.
    const rows = page.locator('.artifact-answered tbody tr');
    const toggle = page.getByRole('heading', { level: 2, name: /^Answered/ }).getByRole('button');
    await expect(rows).toHaveCount(2);
    await expect(toggle).toHaveAccessibleName('Answered (2)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(rows.first()).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    for (const tr of await rows.all()) await expect(tr).toBeHidden();

    await page.reload();
    await expect(rows).toHaveCount(2);
    await expect(toggle).toHaveAccessibleName('Answered (2)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    for (const tr of await rows.all()) await expect(tr).toBeHidden();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const tr of await rows.all()) await expect(tr).toBeVisible();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    for (const tr of await rows.all()) await expect(tr).toBeHidden();

    const pump = decision(page, 'decision-1');
    await pump.change.click();
    await expect(pump.option('Submerged')).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    const feed = decision(page, 'decision-3');
    await feed.option(/^Yes/).check();
    await feed.save.click();
    await expect(feed.saved).toContainText('Saved · Yes · change');
    await expect(toggle).toHaveAccessibleName('Answered (3)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(rows).toHaveCount(3);
    for (const tr of await rows.all()) await expect(tr).toBeHidden();
    await expect(page.locator('.artifact-answered-body')).toHaveAttribute('hidden', 'until-found');
    expect(errors).toEqual([]);
  });
});

test.describe('signed out', () => {
  test('the answers route refuses the reader, so there is no table', async ({ page, request }) => {
    expect(Object.keys(await stored(request)).length).toBeGreaterThan(0);
    await page.goto(PAGE);
    await expect(decision(page, 'decision-1').save).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    await expect(page.locator('.artifact-answered')).toHaveCount(0);
  });
});
