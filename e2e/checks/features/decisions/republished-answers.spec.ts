import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// A decision answered on the page, then republished. Each case publishes a
// page of its own on the capture fixture's site with a real `lotuspod
// publish --local`, asking decision-1 (Which heater? Solar / Electric,
// default Solar), answers it Electric with a note through the page, and
// publishes it again. Asked in the same words with Electric still offered
// under its label, the card keeps its answer; reworded, or with Electric
// renamed, it opens again as answered to an earlier wording.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const NOTE = 'Out of the wind';

function markdown(row: string) {
  return ['# Shed heater', '', 'Which heater warms the shed.', '',
    '## Decisions for the maintainer', '',
    '| # | Question | Options | Default |', '| --- | --- | --- | --- |', row, ''].join('\n');
}

const FIRST = markdown('| 1 | Which heater? | Solar / Electric | Solar |');

function publish(name: string, text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-republished-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, text, 'utf-8');
    const said = execFileSync(PYTHON, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', OUT], {
      encoding: 'utf-8',
      env: { ...ENV, PYTHONPATH: SRC },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function decision(page: Page) {
  const form = page.locator('form.artifact-decision[data-question="decision-1"]');
  return {
    form,
    option: (name: string) => form.getByRole('radio', { name: new RegExp(`^${name}\\b`) }),
    // An option by its value, shown or folded away.
    valued: (value: string) => form.locator(`input[name="choice"][value="${value}"]`),
    addNote: form.locator('details.artifact-decision-note > summary'),
    note: form.locator('textarea[name="note"]'),
    save: form.getByRole('button', { name: 'Save answer' }),
    saved: form.locator('.artifact-decision-saved-line'),
    savedNote: form.locator('.artifact-decision-saved-note'),
    unsaved: form.locator('.artifact-decision-unsaved'),
    earlier: form.locator('.artifact-decision-earlier'),
    change: form.locator('.artifact-decision-saved').getByRole('button', { name: 'change' }),
  };
}

function row(page: Page) {
  const tr = page.getByRole('table', { name: 'Answered' }).locator('tbody tr[data-question="decision-1"]');
  return {
    number: tr.locator('td.artifact-answered-number'),
    question: tr.locator('td.artifact-answered-question'),
    label: tr.locator('.artifact-answered-choice strong'),
    note: tr.locator('.artifact-answered-note'),
    change: tr.getByRole('button', { name: 'change' }),
  };
}

type Stored = { choice: string; version: string };

async function current(request: APIRequestContext, name: string) {
  const response = await request.get(`/api/answers?page=${name}`, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  return (await response.json()).questions['decision-1'].current as Stored;
}

// Publish name asking FIRST and answer it Electric with NOTE on the page.
async function answered(page: Page, name: string) {
  publish(name, FIRST);
  await page.goto(`/${name}.html?standalone`);
  const card = decision(page);
  await card.option('Electric').check();
  await card.addNote.click();
  await card.note.fill(NOTE);
  await card.save.click();
  await expect(card.saved).toContainText('Saved · Electric · change');
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 800 } });

  test.beforeEach(() => {
    // The site keeps every answer saved, so this runs once per site.
    test.skip(test.info().repeatEachIndex > 0, 'republishes pages the first repeat answered');
    for (const [name, value] of Object.entries({ ASSERTION, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('an option added keeps the answer shown, and change saves at the new version', async ({ page, request }) => {
    const name = 'republished-answers-widened';
    const errors = watch(page);
    await answered(page, name);
    publish(name, markdown('| 1 | Which heater? | Solar / Electric / Gas | Solar |'));

    await page.reload();
    const card = decision(page);
    await expect(card.valued('gas')).toHaveCount(1);
    await expect(card.form).toHaveClass(/\bartifact-decision--saved\b/);
    await expect(card.saved).toHaveText('✓ Saved · Electric · change');
    await expect(card.savedNote).toHaveText(NOTE);
    await expect(card.valued('electric')).toBeChecked();
    await expect(card.earlier).toHaveCount(0);
    await expect(page.locator('button.artifact-review-count')).toHaveText('All answered');
    const answer = row(page);
    await expect(answer.number).toHaveText('1');
    await expect(answer.question).toHaveText('Which heater?');
    await expect(answer.label).toHaveText('Electric');
    await expect(answer.note).toHaveText(NOTE);
    await expect(answer.change).toBeVisible();

    const version = await card.form.getAttribute('data-version');
    expect((await current(request, name)).version).not.toBe(version);
    await card.change.click();
    await card.option('Gas').check();
    await card.save.click();
    await expect(card.saved).toContainText('Saved · Gas · change');
    expect(await current(request, name)).toMatchObject({ choice: 'gas', version });
    expect(errors).toEqual([]);
  });

  for (const [what, row1] of [
    ['reworded', '| 1 | Which heater for the shed? | Solar / Electric | Solar |'],
    ['with its answer renamed', '| 1 | Which heater? | Solar / Electric coil | Solar |'],
  ]) {
    test(`a question ${what} opens again as answered to an earlier wording`, async ({ page }) => {
      const name = `republished-answers-${what.split(' ').pop()}`;
      const errors = watch(page);
      await answered(page, name);
      publish(name, markdown(row1));

      await page.reload();
      const card = decision(page);
      await expect(card.form).not.toHaveClass(/\bartifact-decision--saved\b/);
      await expect(card.save).toBeVisible();
      await expect(card.valued('solar')).toBeChecked();
      await expect(card.unsaved).toHaveText('Not saved');
      await expect(card.earlier).toContainText('Answered to an earlier wording');
      await expect(page.locator('button.artifact-review-count')).toHaveText('1 to answer');
      const answer = row(page);
      await expect(answer.number).toHaveText('1');
      await expect(answer.question).toHaveText('Which heater?');
      await expect(answer.label).toHaveText('Electric');
      await expect(answer.change).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
});
