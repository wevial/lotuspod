import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// A decision answered elsewhere. The check publishes a page of its own as
// hermes on the capture fixture's site with a real `lotuspod publish`, asking
// decision-1 (Sonnet / Opus, default Sonnet) and decision-2 (Yes / No), and
// records decision-1's answer with a real `lotuspod comments record-answer`
// on the fixture's agent socket. The page shows it saved, as answered
// elsewhere, and the reader can still change it.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const NAME = 'recorded-answers-check';
const ANSWERS = `/api/answers?page=${NAME}`;
const SOURCE = 'Chat with the maintainer, 2026-10-09';
const MARKDOWN = ['# Pond model', '', 'Which model runs the pond.', '',
  '## Decisions for the maintainer', '',
  '| # | Question | Options | Default |', '| --- | --- | --- | --- |',
  '| 1 | Which model? | Sonnet / Opus | Sonnet |',
  '| 2 | Run it nightly? | Yes / No | |', ''].join('\n');

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-recorded-'));
  try {
    const file = path.join(dir, `${NAME}.md`);
    fs.writeFileSync(file, MARKDOWN, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', 'hermes',
      '--credential', HERMES, '--comments');
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
    option: (name: string) => form.getByRole('radio', { name }),
    save: form.getByRole('button', { name: 'Save answer' }),
    saved: form.locator('.artifact-decision-saved-line'),
    source: form.locator('.artifact-decision-saved-source'),
    by: form.locator('.artifact-decision-saved-by'),
    change: form.locator('.artifact-decision-saved').getByRole('button', { name: 'change' }),
    history: form.locator('.artifact-decision-history > summary'),
  };
}

type Stored = { id: number; choice: string; source?: string };

async function stored(request: APIRequestContext) {
  const response = await request.get(ANSWERS, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  return (await response.json()).questions as Record<string, { current: Stored; earlier: Stored[] }>;
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 800 } });

  test('a decision answered elsewhere shows saved, counts as answered, and the reader can change it', async ({ page, request }) => {
    // The site keeps every answer saved, so this runs once per site.
    test.skip(test.info().repeatEachIndex > 0, 'records on a page the first repeat answered');
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    publish();
    const said = run('comments', 'record-answer', NAME, 'decision-1', 'opus', '--source', SOURCE,
      '--socket', SOCKET, '--credential', HERMES);
    expect(said.trim()).toMatch(new RegExp(`^answer \\d+ recorded on ${NAME}: decision-1 = Opus$`));
    const recorded = (await stored(request))['decision-1'].current;
    expect([recorded.choice, recorded.source]).toEqual(['opus', SOURCE]);

    const errors = watch(page);
    await page.goto(`/${NAME}.html?standalone`);
    const model = decision(page, 'decision-1');
    await expect(model.form).toHaveClass(/\bartifact-decision--saved\b/);
    await expect(model.saved).toContainText('Saved · Opus');
    await expect(model.source).toHaveText(`Answered elsewhere: ${SOURCE}`);
    await expect(model.by).toHaveText(/^recorded by hermes/);
    const nightly = decision(page, 'decision-2');
    await expect(nightly.form).not.toHaveClass(/\bartifact-decision--saved\b/);
    await expect(nightly.save).toBeVisible();
    await expect(page.locator('button.artifact-review-count')).toHaveText('1 to answer · Respond');
    await expect(page.locator('.artifact-answered-title')).toHaveText('Answered (1)');
    const row = page.locator('.artifact-answered tbody tr[data-question="decision-1"]');
    await expect(row.locator('.artifact-answered-source')).toContainText('Answered elsewhere:');

    await model.change.click();
    await model.option('Sonnet').check();
    await model.save.click();
    await expect(model.saved).toContainText('Saved · Sonnet');
    await expect(model.source).toHaveCount(0);
    await expect(model.by).not.toContainText('recorded by');
    await expect(model.history).toHaveText('1 earlier answer');
    await expect(row.locator('.artifact-answered-source')).toHaveCount(0);

    const after = (await stored(request))['decision-1'];
    expect(after.current.choice).toBe('sonnet');
    expect(after.current).not.toHaveProperty('source');
    expect(after.earlier.map((answer) => [answer.id, answer.choice, answer.source]))
      .toEqual([[recorded.id, 'opus', SOURCE]]);

    await page.reload();
    await expect(model.saved).toContainText('Saved · Sonnet');
    await expect(model.source).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
