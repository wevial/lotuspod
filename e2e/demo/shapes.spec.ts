import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { compare, shape } from './shape';

// The shim's /api answers (demo/shim.js) hold the shapes the real `lotuspod
// serve` gives. tests/demo_shapes.py runs a fixed request script against the
// real serve and records each answer's status and shape in
// tests/fixtures/demo/api-shapes.json; this runs the same script on the
// demo's try-it page in Chromium, through fetch, which the shim answers, and
// shapes each answer by the same rule (shape.js). Every status and shape
// must be the fixture's, but for the fixture's expected_differences.

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'demo', 'api-shapes.json'), 'utf-8'));
// How long demo-agent waits before its scripted reply, as the shim says.
const REPLY_AFTER = Number(/var REPLY_AFTER = (\d+);/.exec(
  fs.readFileSync(path.join(ROOT, 'demo', 'shim.js'), 'utf-8'))?.[1]);

// What the script writes: tests/demo_shapes.py's own.
const PAGE = 'try-it';
const SECTION = 'what-goes-in';
const PASSAGE_SECTION = 'the-pond-today';
const QUOTE = { exact: 'the first algae', prefix: 'from edge to edge and ', suffix: ' are showing' };
const UNKNOWN_SECTION = 'no-such-section';
const UNKNOWN_QUESTION = 'no-such-question';
const STALE_VERSION = 'stale';

type Entry = { request: string; method: string; path: string; status: number; shape: unknown };

// One request through the page's fetch: its status and JSON.
async function api(page: Page, method: string, url: string, body?: object) {
  return page.evaluate(async ({ method, url, body }) => {
    const response = await fetch(url, body === undefined ? { method } : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }, { method, url, body });
}

test('the shim answers the script in the shapes serve gives', async ({ page }) => {
  test.setTimeout(60_000);
  expect(REPLY_AFTER, 'demo/shim.js names REPLY_AFTER').toBeGreaterThan(0);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/${PAGE}.html?standalone`);
  await expect(page.locator(`details.artifact-comment[data-section="${SECTION}"]`)).toBeAttached();
  await expect(page.locator(`details.artifact-comment[data-section="${PASSAGE_SECTION}"]`)).toBeAttached();
  const revision = await page.locator('meta[name="lotuspod:revision"]').getAttribute('content') ?? '';
  const form = await page.locator('form.artifact-decision').first().evaluate((found: HTMLFormElement) => ({
    question: found.dataset.question ?? '',
    version: found.dataset.version ?? '',
    choices: Array.from(found.querySelectorAll<HTMLInputElement>('input[name="choice"]'), (input) => input.value),
  }));
  expect(form.choices.length).toBeGreaterThanOrEqual(2);
  const [first, second] = form.choices;

  const entries: Entry[] = [];
  const ask = async (label: string, method: string, url: string, body?: object) => {
    const answered = await api(page, method, url, body);
    entries.push({ request: label, method, path: url.split('?')[0], status: answered.status,
      shape: shape(answered.json) });
    return answered.json;
  };
  const answer = (choice: string, version: string) => ({
    page: PAGE, question: form.question, version, choice, note: '',
  });
  const comments = '/api/comments';
  const answers = '/api/answers';
  const query = `?page=${PAGE}`;

  await ask('1. GET comments, none yet', 'GET', comments + query);
  const made = await ask('2. POST a section comment', 'POST', comments,
    { page: PAGE, section: SECTION, text: 'Which lilies go in first?' });
  await ask('3. POST a passage comment, with a quote', 'POST', comments,
    { page: PAGE, section: PASSAGE_SECTION, text: 'Is this algae a worry?', quote: QUOTE, revision });
  await ask('4. GET comments', 'GET', comments + query);
  expect(typeof made.id, 'the section comment was stored').toBe('number');
  // 5. demo-agent replies once its comments have waited REPLY_AFTER, at
  // the next read of the threads.
  await page.waitForTimeout(REPLY_AFTER + 500);
  await ask("6. GET comments, after the agent's reply", 'GET', comments + query);
  await ask('7. POST a reader reply', 'POST', comments,
    { page: PAGE, parent: made.id, text: 'Thanks, that helps.' });
  await ask('8a. POST a resolution, resolved', 'POST', comments,
    { page: PAGE, thread: made.id, resolved: true });
  await ask('8b. POST a resolution, reopened', 'POST', comments,
    { page: PAGE, thread: made.id, resolved: false });
  // Before the answers: the shim adds a thread of its own on an answer.
  await ask('8c. POST a question about a decision', 'POST', comments,
    { page: PAGE, question: form.question, text: 'Is it warm enough by then?' });
  await ask('8d. POST a question about a decision the page does not ask', 'POST', comments,
    { page: PAGE, question: UNKNOWN_QUESTION, text: 'What about this one?' });
  await ask('8e. GET comments, with a decision thread', 'GET', comments + query);
  await ask('9. GET answers, none yet', 'GET', answers + query);
  await ask('10. POST an answer', 'POST', answers, answer(first, form.version));
  await ask('11. POST a second answer to the same question', 'POST', answers, answer(second, form.version));
  await ask('12. POST an answer with a stale version', 'POST', answers, answer(first, STALE_VERSION));
  await ask('13. GET answers', 'GET', answers + query);
  await ask('14. GET revision', 'GET', `/api/revision${query}`);
  await ask('15. POST a comment on an unknown section', 'POST', comments,
    { page: PAGE, section: UNKNOWN_SECTION, text: 'Where does this go?' });

  const found: string[] = compare(FIXTURE, entries);
  expect(found, `the shim's answers differ from tests/fixtures/demo/api-shapes.json:\n${found.join('\n')}`)
    .toEqual([]);
  expect(errors).toEqual([]);
});
