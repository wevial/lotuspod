import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Each option of a decisions table under an "Options (a / b)" header is its
// own radio, and every decision ends in "Something else", which opens the
// card's note. Each case publishes a page of its own on the capture
// fixture's site with a real `lotuspod publish --local`. An answer saved
// through "Accept the default" before the row had options of its own shows
// as the default option once it does.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const PANEL = 'lotuspod:comments-panel';
const QUESTION = 'Should "PR opened" be a Today\'s log highlight?';
const NOTE = 'Only for merges';

function markdown(header: string, row: string) {
  return ['# Today\'s log', '', 'What the log shows.', '',
    '## Decisions for the maintainer', '',
    header, header.replace(/[^|]+/g, ' --- '), row, ''].join('\n');
}

const NOTED = markdown('| # | Question | Context | Options (a / b) | Default |',
  `| H1 | ${QUESTION} | It shows on every run; merge rows already link the PR | Off / On | Off |`);
const DEFAULT_ONLY = markdown('| # | Question | Context | Default |',
  `| H1 | ${QUESTION} | It shows on every run | Off |`);
const WITH_OPTIONS = markdown('| # | Question | Context | Options (a / b) | Default |',
  `| H1 | ${QUESTION} | It shows on every run | Off / On | Off |`);

function publish(name: string, text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-option-radios-'));
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

// The page with the comments panel open, as a reader left it.
async function load(page: Page, name: string) {
  await page.addInitScript(([key, value]) => {
    if (!sessionStorage.getItem('__remembered')) {
      sessionStorage.setItem('__remembered', '1');
      localStorage.setItem(key, value);
    }
  }, [PANEL, 'open']);
  await page.goto(`/${name}.html?standalone`);
  await expect(page.locator('button.artifact-review-count')).toBeVisible();
}

function decision(page: Page) {
  const form = page.locator('form.artifact-decision[data-question="decision-h1"]');
  return {
    form,
    radios: form.locator('input[name="choice"]'),
    labels: form.locator('.artifact-decision-option .artifact-decision-label'),
    option: (name: string) => form.getByRole('radio', { name: new RegExp(`^${name}\\b`) }),
    // An option by its value, shown or folded away.
    valued: (value: string) => form.locator(`input[name="choice"][value="${value}"]`),
    tag: (name: string) => form.locator('label.artifact-decision-option', { hasText: name })
      .locator('.artifact-decision-default'),
    noteBox: form.locator('details.artifact-decision-note'),
    note: form.locator('textarea[name="note"]'),
    save: form.getByRole('button', { name: 'Save answer' }),
    saved: form.locator('.artifact-decision-saved-line'),
    savedNote: form.locator('.artifact-decision-saved-note'),
    unsaved: form.locator('.artifact-decision-unsaved'),
    earlier: form.locator('.artifact-decision-earlier'),
  };
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 800 } });

  test.beforeEach(() => {
    // The site keeps every answer saved, so this runs once per site.
    test.skip(test.info().repeatEachIndex > 0, 'answers pages the first repeat answered');
    for (const [name, value] of Object.entries({ ASSERTION, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('each option is a radio, Something else last, which opens the note', async ({ page }) => {
    const name = 'option-radios-noted';
    const errors = watch(page);
    publish(name, NOTED);
    await load(page, name);
    const card = decision(page);
    await expect(card.labels).toHaveText(['Off', 'On', 'Something else']);
    expect(await card.radios.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)))
      .toEqual(['off', 'on', 'other']);
    await expect(card.option('Off')).toBeChecked();
    await expect(card.tag('Off')).toBeVisible();
    await expect(card.form.locator('.artifact-decision-default')).toHaveCount(1);
    await expect(card.form).not.toContainText('Options (a / b)');
    await expect(card.form).not.toContainText('Default:');

    const other = card.option('Something else');
    await other.check();
    await expect(card.noteBox).toHaveJSProperty('open', true);
    await expect(card.note).toBeVisible();
    await expect(other).toBeFocused();
    await expect(card.unsaved).toHaveText('Not saved');
    await expect(card.unsaved).toBeVisible();

    await card.note.fill(NOTE);
    await card.save.click();
    await expect(card.saved).toHaveText('✓ Saved · Something else · change');
    await expect(card.savedNote).toHaveText(NOTE);
    expect(errors).toEqual([]);
  });

  test('an answer accepting the default shows as the default option once the row has options', async ({ page }) => {
    const name = 'option-radios-accepted';
    const errors = watch(page);
    publish(name, DEFAULT_ONLY);
    await load(page, name);
    const card = decision(page);
    await expect(card.option('Accept the default')).toBeChecked();
    await card.save.click();
    await expect(card.saved).toHaveText('✓ Saved · Accept the default · change');

    publish(name, WITH_OPTIONS);
    await page.reload();
    await expect(card.labels).toHaveText(['Off', 'On', 'Something else']);
    await expect(card.valued('off')).toBeChecked();
    await expect(card.form).toHaveClass(/\bartifact-decision--saved\b/);
    await expect(card.saved).toHaveText('✓ Saved · Off · change');
    await expect(card.earlier).toHaveCount(0);
    await expect(page.locator('button.artifact-review-count')).toHaveText('All answered');

    const answered = page.getByRole('table', { name: 'Answered' }).locator('tbody tr[data-question="decision-h1"]');
    await expect(answered.locator('td.artifact-answered-number')).toHaveText('H1');
    await expect(answered.locator('.artifact-answered-choice strong')).toHaveText('Off');
    await expect(answered.getByRole('button', { name: 'change' })).toBeVisible();

    const decisions = page.locator('aside.artifact-comments-panel .artifact-comments-decisions');
    await expect(decisions).toBeVisible();
    const summary = decisions.locator('details.artifact-decisions-answered > summary');
    await expect(summary).toHaveText('Answered · 1');
    await summary.click();
    const row = decisions.locator('.artifact-decisions-row[data-question="decision-h1"]');
    await expect(row.locator('.artifact-decisions-row-label')).toHaveText('Off');
    expect(errors).toEqual([]);
  });
});
