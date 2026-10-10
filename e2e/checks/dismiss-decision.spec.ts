import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// An owner dismisses a decision that no longer matters. The check publishes a
// page of its own as hermes on the capture fixture's site with a real
// `lotuspod publish`, asking decision-1 (Sonnet / Opus) and decision-2
// (Yes / No), no defaults. The fixture's reader is one of its [access]
// owners: Dismiss folds decision-1 to "Dismissed: REASON · Undo", it stops
// counting as open and is listed in the Answered table, and Undo puts it back
// open. The fixture's second reader, no owner, has no Dismiss and no Undo.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SECOND = ENV.LOTUSPOD_TEST_ASSERTION_SECOND ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const NAME = 'dismiss-decision-check';
const REASON = 'Superseded by the pump plan';
const MARKDOWN = ['# Pond model', '', 'Which model runs the pond.', '',
  '## Decisions for the maintainer', '',
  '| # | Question | Options |', '| --- | --- | --- |',
  '| 1 | Which model? | Sonnet / Opus |',
  '| 2 | Run it nightly? | Yes / No |', ''].join('\n');

function publish() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-dismiss-'));
  try {
    const file = path.join(dir, `${NAME}.md`);
    fs.writeFileSync(file, MARKDOWN, 'utf-8');
    const said = execFileSync(PYTHON, ['-m', 'lotuspod', 'publish', file, '--local',
      '--out-dir', OUT, '--owner', 'hermes', '--credential', HERMES, '--comments'], {
      encoding: 'utf-8',
      env: { ...ENV, PYTHONPATH: SRC },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    expect(said).toContain(`published ${NAME} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function decision(page: Page, question: string) {
  const form = page.locator(`form.artifact-decision[data-question="${question}"]`);
  return {
    form,
    note: form.locator('textarea[name="note"]'),
    noteToggle: form.locator('details.artifact-decision-note > summary'),
    dismiss: form.locator('button.artifact-decision-dismiss'),
    saved: form.locator('.artifact-decision-saved-line'),
    undo: form.locator('.artifact-decision-saved button.artifact-decision-undo'),
  };
}

function parts(page: Page) {
  return {
    count: page.locator('button.artifact-review-count'),
    table: page.locator('.artifact-answered'),
    title: page.locator('.artifact-answered-title'),
    row: (question: string) =>
      page.locator(`.artifact-answered tbody tr[data-question="${question}"]`),
    state: (question: string) =>
      page.locator(`.artifact-review-entry[data-question="${question}"] .artifact-review-state`),
  };
}

// decision-1 dismissed, as the page shows it to its owner.
async function dismissed(page: Page) {
  const model = decision(page, 'decision-1');
  const side = parts(page);
  await expect(model.form).toHaveClass(/\bartifact-decision--saved\b/);
  await expect(model.form).toHaveClass(/\bartifact-decision--dismissed\b/);
  await expect(model.saved).toHaveText(`Dismissed: ${REASON} · Undo`);
  await expect(model.undo).toBeVisible();
  await expect(side.count).toHaveText('1 to answer · Respond');
  await expect(side.title).toHaveText('Answered (1)');
  await expect(side.row('decision-1')).toContainText('Dismissed');
  await expect(side.row('decision-1')).toContainText(REASON);
  await expect(side.row('decision-1').locator('.artifact-decision-change')).toHaveCount(0);
  await side.count.click();
  await expect(side.state('decision-1')).toHaveText('Dismissed');
  await expect(side.state('decision-2')).toHaveText('Open');
  await page.keyboard.press('Escape');
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 800 } });

  test('an owner dismisses a decision, it stops counting as open, and Undo brings it back', async ({ page, request, browser, baseURL }) => {
    // The site keeps every answer saved, so this runs once per site.
    test.skip(test.info().repeatEachIndex > 0, 'dismisses on a page the first repeat answered');
    for (const [name, value] of Object.entries({ ASSERTION, SECOND, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    publish();

    const errors = watch(page);
    await page.goto(`/${NAME}.html`);
    const model = decision(page, 'decision-1');
    const side = parts(page);
    await expect(side.count).toHaveText('2 to answer · Respond');
    await expect(model.dismiss).toHaveText('Dismiss');
    await expect(decision(page, 'decision-2').dismiss).toBeVisible();

    await model.noteToggle.click();
    await model.note.fill(REASON);
    await model.dismiss.click();
    await dismissed(page);
    await expect(model.note).toHaveValue('');

    await page.reload();
    await dismissed(page);

    await model.undo.click();
    await expect(model.form).not.toHaveClass(/\bartifact-decision--saved\b/);
    await expect(model.form).not.toHaveClass(/\bartifact-decision--dismissed\b/);
    await expect(side.count).toHaveText('2 to answer · Respond');
    await expect(side.table).toHaveCount(0);
    await page.reload();
    await expect(side.count).toHaveText('2 to answer · Respond');
    await expect(model.form).not.toHaveClass(/\bartifact-decision--saved\b/);
    await expect(model.dismiss).toBeVisible();
    expect(errors).toEqual([]);

    // The owner dismisses decision-2 with no reason; the second reader, no
    // owner, sees it dismissed with no Undo, and no Dismiss anywhere.
    const version = await decision(page, 'decision-2').form.getAttribute('data-version');
    const response = await request.post('/api/answers', {
      headers: SIGNED_IN,
      data: { page: NAME, question: 'decision-2', version, dismissed: true, reason: '' },
    });
    expect(response.status()).toBe(201);

    const context = await browser.newContext({
      baseURL, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': SECOND },
      viewport: { width: 1280, height: 800 },
    });
    try {
      const other = await context.newPage();
      const otherErrors = watch(other);
      await other.goto(`/${NAME}.html`);
      const nightly = decision(other, 'decision-2');
      await expect(nightly.form).toHaveClass(/\bartifact-decision--dismissed\b/);
      await expect(nightly.saved).toHaveText('Dismissed');
      await expect(nightly.undo).toHaveCount(0);
      await expect(parts(other).count).toHaveText('1 to answer · Respond');
      // The archive route has answered by the time the page is idle.
      await other.waitForLoadState('networkidle');
      await expect(other.locator('button.artifact-decision-dismiss')).toHaveCount(0);
      expect(otherErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
