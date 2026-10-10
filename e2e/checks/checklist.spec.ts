import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The capture fixture's checklist page: Emails asks one checklist of four
// items, 1 "Welcome email" and 3 "Renewal reminder" on by default, as one
// form of checkboxes the page script answers and draws as a decision card.
// The page has no comment boxes. These checks are the only ones that answer
// on this page, and each builds on the answers the one before it saved, so
// they run in order; what they stub is served through page.route.
const PAGE = '/capture-checklist.html';
const ANSWERS = '/api/answers?page=capture-checklist';
const QUESTION = 'checklist-1';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
// The reader as a page names them: their address's part before the @.
const READER = 'maintainer';
const ITEMS = { '1': 'Welcome email', '2': 'Weekly digest', '3': 'Renewal reminder', '4': 'Survey' };
const CHANGED = 'On: Weekly digest · Off: Welcome email';

async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function checklist(page: Page) {
  const form = page.locator(`form.artifact-decision[data-question="${QUESTION}"]`);
  return {
    form,
    legend: form.locator('legend'),
    boxes: form.locator('input[type="checkbox"][name="item"]'),
    item: (id: keyof typeof ITEMS) => form.getByRole('checkbox', { name: ITEMS[id] }),
    addNote: form.locator('details.artifact-decision-note > summary'),
    note: form.locator('textarea[name="note"]'),
    save: form.getByRole('button', { name: 'Save answer' }),
    unsaved: form.locator('.artifact-decision-unsaved'),
    hint: form.locator('.artifact-decision-hint'),
    status: form.locator('.artifact-decision-status'),
    saved: form.locator('.artifact-decision-saved-line'),
    savedNote: form.locator('.artifact-decision-saved-note'),
    savedBy: form.locator('.artifact-decision-saved-by'),
    change: form.getByRole('button', { name: 'change' }),
    earlier: form.locator('.artifact-decision-earlier'),
    history: form.locator('.artifact-decision-history'),
  };
}

// The ids of the items checked, in page order.
async function checked(page: Page) {
  return checklist(page).boxes.evaluateAll((boxes) =>
    boxes.filter((box) => (box as HTMLInputElement).checked).map((box) => (box as HTMLInputElement).value));
}

async function stored(request: APIRequestContext) {
  const response = await request.get(ANSWERS, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  return (await response.json()).questions;
}

async function fits(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
}

test.describe.serial('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 900 } });

  test('an unanswered checklist is one card at its defaults, not saved only while it differs from them', async ({ page, request }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const errors = await watch(page);
    expect(await stored(request)).toEqual({});
    await page.goto(`${PAGE}?standalone`);
    const card = checklist(page);
    await expect(page.locator('form.artifact-decision')).toHaveCount(1);
    await expect(card.legend).toHaveText('Emails');
    await expect(card.boxes).toHaveCount(4);
    await expect(card.save).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(await checked(page)).toEqual(['1', '3']);
    await expect(card.hint).toBeVisible();
    await expect(card.hint).toHaveText('Not answered yet');
    await expect(card.unsaved).toBeHidden();
    await expect(page.locator('.artifact-answered')).toHaveCount(0);

    await card.item('2').check();
    await expect(card.unsaved).toBeVisible();
    await expect(card.hint).toBeHidden();
    await card.item('2').uncheck();
    await expect(card.unsaved).toBeHidden();
    await expect(card.hint).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('saving folds the card to the items changed from their defaults, which a reload keeps', async ({ page, request }) => {
    const errors = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    const card = checklist(page);
    await card.item('1').uncheck();
    await card.item('2').check();
    await card.addNote.click();
    await card.note.fill('Skip the welcome');
    await card.save.click();

    const folded = async () => {
      await expect(card.saved).toHaveText(`✓ Saved · ${CHANGED} · change`);
      await expect(card.savedNote).toHaveText('Skip the welcome');
      await expect(card.savedBy).toContainText(READER);
      await expect(card.boxes.first()).toBeHidden();
      await expect(card.status).toHaveText('');
    };
    await folded();
    await expect(card.change).toBeFocused();
    const questions = await stored(request);
    expect(questions[QUESTION].current.checked).toEqual(['2', '3']);
    expect(questions[QUESTION].current.note).toBe('Skip the welcome');
    await page.reload();
    await folded();
    expect(errors).toEqual([]);
  });

  test('the Answered table holds the checklist as one row, whose change opens the card at its saved items', async ({ page }) => {
    const errors = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    const table = page.getByRole('table', { name: 'Answered' });
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row).toHaveAttribute('data-question', QUESTION);
    await expect(row.locator('td.artifact-answered-number')).toHaveText('');
    await expect(row.locator('td.artifact-answered-question')).toHaveText('Emails');
    await expect(row.locator('.artifact-answered-choice strong')).toHaveText(CHANGED);
    await expect(row.locator('.artifact-answered-note')).toHaveText('Skip the welcome');
    await expect(row.locator('td.artifact-answered-by')).toHaveText(READER);
    const [label, note] = [await row.locator('.artifact-answered-choice strong').boundingBox(),
      await row.locator('.artifact-answered-note').boundingBox()];
    expect(note!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1);

    await row.getByRole('button', { name: 'change' }).click();
    const card = checklist(page);
    await expect(card.saved).toBeHidden();
    expect(await checked(page)).toEqual(['2', '3']);
    await expect(card.item('2')).toBeFocused();
    await expect(card.unsaved).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('change reopens the card at its answer, and saving it back at the defaults keeps the first in its history', async ({ page, request }) => {
    const errors = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    const card = checklist(page);
    await card.change.click();
    expect(await checked(page)).toEqual(['2', '3']);
    await expect(card.item('2')).toBeFocused();
    await expect(card.note).toHaveValue('Skip the welcome');
    await expect(card.unsaved).toBeHidden();

    await card.item('1').check();
    await card.item('2').uncheck();
    await expect(card.unsaved).toBeVisible();
    await card.save.click();
    await expect(card.saved).toHaveText('✓ Saved · No change from the defaults · change');
    await expect(card.history.locator('summary')).toHaveText('1 earlier answer');
    await card.history.locator('summary').click();
    await expect(card.history.locator('li')).toHaveCount(1);
    await expect(card.history.locator('.artifact-decision-history-choice')).toHaveText([CHANGED]);
    await expect(page.locator('.artifact-answered-choice strong')).toHaveText(['No change from the defaults']);
    expect((await stored(request))[QUESTION].current.checked).toEqual(['1', '3']);
    expect(errors).toEqual([]);
  });

  test('an answer to an earlier wording leaves the card open at its defaults and its history as it was', async ({ page }) => {
    const errors = await watch(page);
    await page.route((url) => url.pathname === '/api/answers', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const read = await response.json();
      await route.fulfill({ response, json: { ...read, questions: { ...read.questions, [QUESTION]: {
        current: {
          id: 999999, page: 'capture-checklist', question: QUESTION, version: '000000000000',
          choice: '', checked: ['4'], note: '', revision: 'abc123abc123',
          actor: { kind: 'human', name: READER }, createdAt: '2026-10-01T09:30:00Z', supersedes: null,
          asked: { text: 'Emails', label: 'On: Survey' },
        },
        earlier: read.questions[QUESTION].earlier,
      } } } });
    });
    await page.goto(`${PAGE}?standalone`);
    const card = checklist(page);
    await expect(card.earlier).toContainText(`Answered to an earlier wording by ${READER}`);
    await expect(card.saved).toHaveCount(0);
    await expect(card.save).toBeVisible();
    expect(await checked(page)).toEqual(['1', '3']);
    await expect(card.unsaved).toBeHidden();
    await expect(card.history.locator('summary')).toHaveText('1 earlier answer');
    await expect(card.history.locator('.artifact-decision-history-choice')).toHaveText([CHANGED]);
    expect(errors).toEqual([]);
  });

  test('at 360 pixels wide the card, open and folded, does not scroll the page sideways', async ({ page }) => {
    const errors = await watch(page);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`${PAGE}?standalone`);
    const card = checklist(page);
    await expect(card.saved).toBeVisible();
    await card.form.scrollIntoViewIfNeeded();
    await fits(page);
    await card.change.click();
    await expect(card.boxes.first()).toBeVisible();
    await expect(card.note).toBeVisible();
    await fits(page);
    expect(errors).toEqual([]);
  });
});
