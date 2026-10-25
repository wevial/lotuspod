import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// An open page published again swaps in a changed section's diagram
// (features/live/ts/page-swap.ts): the template's start-up module draws it on the
// lotuspod:diagrams event, its Expand button
// (features/blocks/ts/diagram-view.js) and node cards
// (features/blocks/ts/diagram-cards.js) are mounted on it once drawn, and a
// section whose diagram is open in the view is held back until the reader
// updates it.
// Each check publishes a page of its own with a real `lotuspod publish`, as
// live-page.spec.ts does. The page's clock runs, so Mermaid draws as it would:
// the page's revision check is run by a visibilitychange instead of by
// waiting out its minute.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const OWNER = 'hermes';
const NEWER = 'A newer version of this page is available';
// The pinned Mermaid (e2e/package.json) answers jsDelivr's requests for it,
// as in diagram-view.spec.ts.
const MERMAID_DIR = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/';
const MERMAID_COPY = path.join(__dirname, '..', '..', '..', 'node_modules', 'mermaid');

test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: SIGNED_IN });

type Violation = { blockedURI: string; effectiveDirective: string };

// As diagram-view.spec.ts's: errors and policy violations, and Mermaid
// answered from the pinned copy.
async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as any).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  await page.route(`${MERMAID_DIR}**`, async (route) => {
    const file = path.join(MERMAID_COPY, route.request().url().slice(MERMAID_DIR.length));
    if (!file.startsWith(MERMAID_COPY + path.sep) || !fs.existsSync(file)) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: fs.readFileSync(file),
    });
  });
  return {
    async clean() {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__violations as Violation[])).toEqual([]);
    },
  };
}

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// hermes publishes markdown (or, given 'html', a page body) as the page
// name, taking no comments; the revision it is now at.
function publish(name: string, text: string, format: 'md' | 'html' = 'md'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-diagram-swap-'));
  try {
    const file = path.join(dir, `${name}.${format}`);
    fs.writeFileSync(file, text, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, '--no-comments');
    const revision = /at revision ([0-9a-f]{12})/.exec(said)?.[1] ?? '';
    expect(revision, said).not.toBe('');
    return revision;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Three sections, the second's body as given.
function plan(title: string, second: string[]) {
  return [
    `# ${title}`, '', 'The plan, as it stands.', '',
    '## Goals', '', 'Ship the page script that swaps sections in place.', '',
    '## Flow', '', ...second, '',
    '## Notes', '', 'Diagrams are drawn by the pinned Mermaid.', '',
  ].join('\n');
}

function flowchart(chain: string) {
  return ['```mermaid', 'flowchart LR', `  ${chain}`, '```'];
}

// A flowchart followed by a Nodes table, one row per box.
function noded(chain: string, rows: [string, string, string][]) {
  return [
    ...flowchart(chain), '', '### Nodes', '',
    '| Node | Title | Status |', '|---|---|---|',
    ...rows.map(([id, title, status]) => `| ${id} | ${title} | ${status} |`),
  ];
}

// Open the page once its script has run; the number of loads and
// navigations from then on.
async function openPage(page: Page, name: string) {
  await page.goto(`/${name}.html?standalone`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const moved = { count: 0 };
  page.on('load', () => { moved.count += 1; });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) moved.count += 1;
  });
  return moved;
}

// Run the page's revision check now, as the page coming back into view does.
async function check(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function revisionOf(page: Page) {
  return page.locator('meta[name="lotuspod:revision"]').getAttribute('content');
}

function wrapper(page: Page, id: string) {
  return page.locator(`.artifact-body > div.artifact-section-body[data-section="${id}"]`);
}

function diagram(page: Page) {
  return wrapper(page, 'flow').locator('pre.mermaid');
}

function expand(page: Page) {
  return diagram(page).getByRole('button', { name: 'Expand diagram' });
}

function view(page: Page) {
  const dialog = page.locator('dialog.artifact-diagram-view');
  return { dialog, svg: dialog.locator('.artifact-diagram-view-stage > svg') };
}

function box(page: Page, id: string) {
  return diagram(page).locator(`g.node[id^="flowchart-${id}-"]`);
}

const CARD = '.artifact-node-card';

test.beforeEach(() => {
  for (const [name, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
});

test('a republished diagram is drawn in place, its Expand button opening the new one', async ({ page }) => {
  const seen = await watch(page);
  const name = 'diagram-swap';
  publish(name, plan('Diagram swap', flowchart('A[Write] --> B[Publish]')));
  const moved = await openPage(page, name);
  await expect(diagram(page).locator(':scope > svg')).toContainText('Publish');
  await expect(expand(page)).toHaveCount(1);
  for (const id of ['goals', 'notes']) {
    await wrapper(page, id).evaluate((node) => { (node as any).__kept = true; });
  }

  const second = publish(name, plan('Diagram swap', flowchart('A[Write] --> B[Review] --> C[Publish]')));
  await check(page);
  await expect.poll(() => revisionOf(page)).toBe(second);
  await expect(diagram(page).locator(':scope > svg')).toContainText('Review');
  await expect(page.locator('.artifact-live-page-banner')).toHaveCount(0);
  expect(moved.count).toBe(0);
  for (const id of ['goals', 'notes']) {
    expect(await wrapper(page, id).evaluate((node) => (node as any).__kept)).toBe(true);
  }
  expect(await wrapper(page, 'flow').evaluate((node) => (node as any).__kept)).toBeUndefined();

  await expect(expand(page)).toHaveCount(1);
  await expand(page).click();
  await expect(view(page).dialog).toBeVisible();
  await expect(view(page).svg).toContainText('Review');
  await page.keyboard.press('Escape');
  await expect(view(page).dialog).toBeHidden();
  await expect(diagram(page).locator(':scope > svg')).toContainText('Review');
  await expect(expand(page)).toBeFocused();
  await seen.clean();
});

test('a diagram open full-window holds its section until the reader updates it', async ({ page }) => {
  const seen = await watch(page);
  const name = 'diagram-swap-held';
  publish(name, plan('Diagram swap held', flowchart('A[Write] --> B[Publish]')));
  await openPage(page, name);
  await expect(expand(page)).toHaveCount(1);
  await expand(page).click();
  await expect(view(page).svg).toContainText('Publish');
  await view(page).svg.evaluate((node) => { (node as any).__kept = true; });

  const second = publish(name, plan('Diagram swap held', flowchart('A[Write] --> B[Review] --> C[Publish]')));
  await check(page);
  await expect.poll(() => revisionOf(page)).toBe(second);
  const bar = wrapper(page, 'flow').locator('div.artifact-swap-held');
  await expect(bar).toHaveCount(1);
  await expect(view(page).dialog).toBeVisible();
  expect(await view(page).svg.evaluate((node) => (node as any).__kept)).toBe(true);
  await expect(view(page).svg).not.toContainText('Review');

  await page.keyboard.press('Escape');
  await expect(view(page).dialog).toBeHidden();
  await expect(bar).toContainText('This section changed');
  await expect(diagram(page).locator(':scope > svg')).not.toContainText('Review');
  await bar.getByRole('button', { name: 'Update' }).click();
  await expect(diagram(page).locator(':scope > svg')).toContainText('Review');
  await expect(page.locator('div.artifact-swap-held')).toHaveCount(0);
  await expect(expand(page)).toHaveCount(1);
  await seen.clean();
});

test("a republished flowchart's new box opens its card from the new row, the old boxes let go", async ({ page }) => {
  const seen = await watch(page);
  const name = 'diagram-swap-cards';
  publish(name, plan('Diagram swap cards', noded('A[Write] --> B[Publish]', [
    ['A', 'Write the plan', 'merged'], ['B', 'Publish it', 'open'],
  ])));
  await openPage(page, name);
  await expect(box(page, 'B')).toHaveAttribute('role', 'button');
  const old = await box(page, 'A').elementHandle();

  const second = publish(name, plan('Diagram swap cards', noded('A[Write] --> B[Review] --> C[Publish]', [
    ['A', 'Write the plan', 'merged'], ['B', 'Review the plan', 'ready'], ['C', 'Publish it', 'waiting'],
  ])));
  await check(page);
  await expect.poll(() => revisionOf(page)).toBe(second);
  await expect(page.locator('.artifact-live-page-banner')).toHaveCount(0);
  await expect(box(page, 'C')).toHaveAttribute('role', 'button');
  await box(page, 'C').click();
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Publish');
  await expect(card).toContainText('waiting');
  await expect(card).toContainText('Waits for');
  await expect(card.locator('.artifact-node-card-graph')).toContainText('Review (ready)');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();

  // The old diagram's box, taken out by the swap, opens no card.
  await old!.evaluate((node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect(card).toBeHidden();
  await seen.clean();
});

test("a republish adding the page's first diagram falls back to the banner", async ({ page }) => {
  const seen = await watch(page);
  const name = 'diagram-swap-first';
  const first = publish(name, plan('Diagram swap first', ['The flow is still to be drawn.']));
  await openPage(page, name);
  const before = await page.locator('.artifact-body').innerHTML();

  publish(name, plan('Diagram swap first', flowchart('A[Write] --> B[Publish]')));
  await check(page);
  await expect(page.locator('.artifact-live-page-banner')).toContainText(NEWER);
  expect(await page.locator('.artifact-body').innerHTML()).toBe(before);
  expect(await revisionOf(page)).toBe(first);
  await seen.clean();
});

test("a swapped diagram's cards read its own table, not a held section's of the same id", async ({ page }) => {
  const seen = await watch(page);
  const name = 'diagram-swap-cards-held';
  // Two diagram sections: the second's table is nodes-table-2 until the
  // first is taken away, when it is nodes-table, as the held first's is.
  const doc = (sections: [string, string[]][]) => [
    '# Diagram swap cards held', '', 'The plan, as it stands.', '',
    ...sections.flatMap(([heading, body]) => [`## ${heading}`, '', ...body, '']),
    '## Notes', '', 'Diagrams are drawn by the pinned Mermaid.', '',
  ].join('\n');
  const first: [string, string[]] = ['Draft', noded('A[Write] --> B[Publish]', [
    ['A', 'Write the draft', 'merged'], ['B', 'Publish the draft', 'waiting'],
  ])];
  const flow = (title: string, status: string): [string, string[]] => ['Flow', noded('A[Plan] --> B[Ship]', [
    ['A', title, status], ['B', 'Ship it', 'open'],
  ])];
  publish(name, doc([first, flow('Plan the flow', 'waiting')]));
  await openPage(page, name);
  const draft = wrapper(page, 'draft').locator('pre.mermaid');
  await expect(draft.getByRole('button', { name: 'Expand diagram' })).toHaveCount(1);
  await expect(box(page, 'A')).toHaveAttribute('role', 'button');
  await draft.getByRole('button', { name: 'Expand diagram' }).click();
  await expect(view(page).dialog).toBeVisible();

  const second = publish(name, doc([flow('Plan the new flow', 'ready')]));
  await check(page);
  await expect.poll(() => revisionOf(page)).toBe(second);
  await expect(wrapper(page, 'draft').locator('div.artifact-swap-held')).toHaveCount(1);
  await expect(page.locator('table#nodes-table')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(view(page).dialog).toBeHidden();
  await expect(box(page, 'A')).toHaveAttribute('aria-label', 'Plan, ready');
  await expect(wrapper(page, 'flow').locator('table')).toBeHidden();
  await box(page, 'A').click();
  const card = page.locator(CARD);
  await expect(card).toContainText('Plan the new flow');
  await expect(card).toContainText('ready');
  await seen.clean();
});

test("a diagram a swap brings to a page whose only one was in a comment gets its Expand button", async ({ page }) => {
  const seen = await watch(page);
  const name = 'diagram-swap-commented';
  // A page body whose diagram is only in a comment: the page still draws
  // Mermaid, so its policy stays when a real one comes.
  const body = (flow: string) => [
    '<h1>Diagram swap commented</h1>', '<p>The plan, as it stands.</p>',
    '<h2>Goals</h2>', '<p>Ship the page script that swaps sections in place.</p>',
    '<h2>Flow</h2>', '<!-- <pre class="mermaid">flowchart LR</pre> -->', flow,
    '<h2>Notes</h2>', '<p>Diagrams are drawn by the pinned Mermaid.</p>', '',
  ].join('\n');
  publish(name, body('<p>The flow is still to be drawn.</p>'), 'html');
  const moved = await openPage(page, name);
  await expect(page.locator('pre.mermaid')).toHaveCount(0);

  const second = publish(name, body('<pre class="mermaid">flowchart LR\n  A[Write] --> B[Publish]</pre>'), 'html');
  await check(page);
  await expect.poll(() => revisionOf(page)).toBe(second);
  await expect(page.locator('.artifact-live-page-banner')).toHaveCount(0);
  expect(moved.count).toBe(0);
  await expect(diagram(page).locator(':scope > svg')).toContainText('Publish');
  await expect(expand(page)).toHaveCount(1);
  await expand(page).click();
  await expect(view(page).svg).toContainText('Publish');
  await page.keyboard.press('Escape');
  await seen.clean();
});
