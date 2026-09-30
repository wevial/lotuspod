import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The capture fixture's decisions page: two questions, each a form the page
// script answers. The fixture names an assertion its site accepts; sending it
// is being signed in, leaving it out is being signed out.
const PAGE = '/capture-decisions.html';
const ANSWERS = '/api/answers?page=capture-decisions';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const READER = 'maintainer@example.com';

function watch(page: Page) {
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
    note: form.locator('textarea[name="note"]'),
    answer: form.getByRole('button', { name: 'Answer' }),
    status: form.locator('.artifact-decision-status'),
    history: form.locator('.artifact-decision-history'),
  };
}

async function stored(request: APIRequestContext) {
  const response = await request.get(ANSWERS, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  return (await response.json()).questions;
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('an answer is shown again after a reload, and a change keeps it as history', async ({ page }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const errors = watch(page);
    await page.goto(PAGE);
    const first = decision(page, 'decision-1');
    await expect(first.option(/^Sonnet/)).not.toBeChecked();
    await expect(first.option('Opus')).not.toBeChecked();

    await first.option('Opus').check();
    await first.note.fill('Opus for page edits');
    await first.answer.click();
    await expect(first.status).toContainText(`Answered by ${READER}`);
    await expect(first.answer).toBeEnabled();

    await page.reload();
    await expect(first.option('Opus')).toBeChecked();
    await expect(first.note).toHaveValue('Opus for page edits');
    await expect(first.status).toContainText(`Answered by ${READER}`);
    await expect(first.history).toBeHidden();

    await first.option(/^Sonnet/).check();
    await first.answer.click();
    await expect(first.history.locator('summary')).toHaveText('1 earlier answer');
    await first.history.locator('summary').click();
    await expect(first.history.locator('li')).toHaveCount(1);
    await expect(first.history.locator('li')).toContainText('Opus');
    await expect(first.history.locator('li')).toContainText('Opus for page edits');
    expect(errors).toEqual([]);
  });

  test('a note is shown as the text written, never as markup', async ({ page }) => {
    const note = '<b>bold</b>';
    await page.goto(PAGE);
    const second = decision(page, 'decision-2');
    for (const [choice, text] of [['Yes', note], ['No', 'Changed my mind'], ['Yes', note]]) {
      await second.option(new RegExp(`^${choice}`)).check();
      await second.note.fill(text);
      await second.answer.click();
      await expect(second.answer).toBeEnabled();
      await expect(second.status).toContainText(`Answered by ${READER}`);
    }

    await page.reload();
    await expect(second.option(/^Yes/)).toBeChecked();
    await expect(second.note).toHaveValue(note);
    await second.history.locator('summary').click();
    await expect(second.history.locator('li')).toHaveCount(2);
    await expect(second.history.locator('.artifact-decision-history-note').last()).toHaveText(note);
    await expect(page.locator('b')).toHaveCount(0);
  });
});

test.describe('signed out', () => {
  test('an answer is refused with a way to sign in, and nothing is stored', async ({ page, request }) => {
    const before = await stored(request);
    await page.goto(PAGE);
    const second = decision(page, 'decision-2');
    await second.option('No').check();
    await second.note.fill('Not signed in');
    await second.answer.click();
    await expect(second.status).toHaveText('You are signed out. Reload the page to sign in.');
    await expect(second.answer).toBeEnabled();
    expect(await stored(request)).toEqual(before);
  });
});
