import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// An archived page opens with a banner under its title bar, keeps its
// threads readable and takes no new comment, reply or answer; its owner gets
// an Archive or Unarchive button at the right of the top bar. The check publishes a page
// with a decision and its successor on the capture fixture's site with a
// real `lotuspod publish`, posts a thread and a reply on it, archives it
// with a real `lotuspod archive --superseded-by`, and unarchives it when
// done, so later checks see no archived page.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SECOND = ENV.LOTUSPOD_TEST_ASSERTION_SECOND ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const NAME = 'archived-page-check';
const NEXT = 'archived-page-check-next';
const NEXT_TITLE = 'Pond plan, the second';
// A page whose body names NEXT in an authored data-page, before its own forms.
const LINKED = 'archived-page-check-linked';
// An open page with a decision, so its top bar draws the review sheet's bar too.
const BAR = 'archived-page-check-bar';
const CLOSED = 'Comments are closed: this page is archived.';
const CLOSED_NOTE = 'Answering is closed: this page is archived.';
const PARAGRAPH = 'The pond froze in January, and the pump stopped with it.';

test.use({ viewport: { width: 1440, height: 900 } });

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish(name: string, lines: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-archived-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
    expect(run('publish', file, '--local', '--out-dir', OUT)).toContain(`published ${name}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function archive() {
  expect(run('archive', NAME, '--superseded-by', NEXT, '--local', '--out-dir', OUT))
    .toContain(`archived ${NAME}`);
}

// The day the page was archived, as its record keeps it.
function archivedDay(): string {
  const record = JSON.parse(fs.readFileSync(path.join(OUT, `${NAME}.archived.json`), 'utf-8'));
  return String(record.archivedAt).slice(0, 10);
}

async function post(request: APIRequestContext, data: Record<string, unknown>) {
  const response = await request.post('/api/comments', { headers: SIGNED_IN, data });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: number };
}

// Errors the page throws, and how many of its reads are in flight.
async function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    w.__inflight = 0;
    const real = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      w.__inflight++;
      try {
        return await real(input, init);
      } finally {
        w.__inflight--;
      }
    };
  });
  return errors;
}

async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__inflight as number)).toBe(0);
}

// Open the page and let its first reads come back: the threads drawn, and
// the archive route and the answers read.
async function open(page: Page) {
  const read = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/archive' && response.request().method() === 'GET');
  await page.goto(`/${NAME}.html?standalone`);
  await read;
  await settle(page);
}

function parts(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  return {
    banner: page.locator('div.artifact-archived-banner'),
    button: page.locator('.artifact-topbar button.artifact-archive'),
    aside,
    opener: aside.locator('button.artifact-comments-opener'),
    fold: aside.getByRole('button', { name: 'Fold comments' }),
    closed: aside.locator('.artifact-comments-closed'),
    pick: aside.locator('button.artifact-comments-pick'),
    onPage: aside.locator('button.artifact-comments-on-page'),
    pill: page.locator('button.artifact-passage-pill'),
    fieldset: page.locator('form.artifact-decision fieldset'),
    ask: page.locator('form.artifact-decision button.artifact-decision-ask'),
    save: page.locator('form.artifact-decision button[type="submit"]'),
    note: page.locator('form.artifact-decision .artifact-archived-note'),
  };
}

function entry(page: Page, id: number) {
  const item = page.locator(`aside.artifact-comments-panel .artifact-comments-entry[data-thread="${id}"]`);
  return {
    item,
    head: item.locator('.artifact-comments-entry-head'),
    toggle: item.locator('button.artifact-comment-toggle'),
  };
}

// The panel open, at the thread, its replies shown.
async function openThread(page: Page, id: number) {
  const side = parts(page);
  if (await side.opener.isVisible()) await side.opener.click();
  await expect(side.fold).toBeVisible();
  const thread = entry(page, id);
  await expect(thread.item).toBeVisible();
  if (!(await thread.toggle.isVisible())) await thread.head.click();
  await expect(thread.toggle).toBeVisible();
  return thread;
}

// Select the paragraph's words with the mouse.
async function drag(page: Page, words: string) {
  const spots = await page.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.querySelector('.artifact-body')!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const at = node.data.indexOf(wanted);
      if (at < 0) continue;
      node.parentElement!.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const first = range.getBoundingClientRect();
      range.setStart(node, at + wanted.length - 1);
      range.setEnd(node, at + wanted.length);
      const last = range.getBoundingClientRect();
      return {
        from: { x: first.left + 1, y: first.top + first.height / 2 },
        to: { x: last.right - 1, y: last.top + last.height / 2 },
      };
    }
    return null;
  }, words);
  expect(spots, `the body holds ${words}`).not.toBeNull();
  await page.mouse.move(spots!.from.x, spots!.from.y);
  await page.mouse.down();
  await page.mouse.move(spots!.to.x, spots!.to.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => String(document.getSelection()))).toBe(words);
}

// Press the top bar's button and let the page load again.
async function press(page: Page, label: string) {
  const button = parts(page).button;
  await expect(button).toHaveText(label);
  const answered = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/archive' && response.request().method() === 'POST');
  const loaded = page.waitForEvent('load');
  // The reloaded page asks for its record before `load`, so the wait starts here.
  const read = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/archive' && response.request().method() === 'GET');
  await button.click();
  expect((await answered).status()).toBe(200);
  await loaded;
  await read;
  await settle(page);
}

// The top bar is --topbar-height tall, nothing in it overflows, and the
// button, Next open and the count are each one line inside the window, the
// button left of Next open.
async function fits(page: Page, when: string) {
  const sizes = await page.evaluate(() => {
    const px = (node: Element) => node.getBoundingClientRect();
    const top = document.querySelector('.artifact-topbar')!;
    const probe = document.createElement('div');
    probe.style.height = 'var(--topbar-height)';
    document.body.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    const one = (selector: string) => {
      const node = top.querySelector(selector)!;
      const box = px(node);
      const line = parseFloat(getComputedStyle(node).lineHeight) ||
        parseFloat(getComputedStyle(node).fontSize) * 1.4;
      return { left: box.left, right: box.right, lines: node.getClientRects().length, tall: box.height, line };
    };
    return {
      height, bar: px(top).height, width: window.innerWidth,
      barScroll: top.scrollWidth, barClient: top.clientWidth,
      button: one('button.artifact-archive'), next: one('a.artifact-review-next'),
      count: one('.artifact-review-count'), wrapper: one('span.artifact-archive-bar'),
      title: (() => {
        const node = top.querySelector('.artifact-topbar-title') as HTMLElement;
        const style = getComputedStyle(node);
        return { display: style.display, overflow: style.textOverflow, width: px(node).width,
          cut: node.scrollWidth > node.clientWidth };
      })(),
    };
  });
  // The archive bar is a box of its own holding the button, right beside Next open.
  expect(sizes.wrapper.left, `${when}: the archive bar holds the button`).toBeLessThanOrEqual(sizes.button.left);
  expect(sizes.wrapper.right, `${when}: the archive bar holds the button`).toBeGreaterThanOrEqual(sizes.button.right);
  expect(sizes.next.left - sizes.wrapper.right, `${when}: the two bars sit side by side`).toBeLessThan(24);
  // The title gives way to its ellipsis; it is not taken away.
  expect(sizes.title.display, `${when}: the title stays`).not.toBe('none');
  expect(sizes.title.width, `${when}: the title keeps room for its ellipsis`).toBeGreaterThan(0);
  expect(sizes.title.overflow).toBe('ellipsis');
  expect(sizes.title.cut, `${when}: the long title is cut short`).toBe(true);
  expect(sizes.bar, `${when}: .artifact-topbar is --topbar-height tall`).toBeCloseTo(sizes.height, 0);
  expect(sizes.barScroll, `${when}: nothing overflows the top bar`).toBeLessThanOrEqual(sizes.barClient);
  for (const [name, part] of Object.entries({ button: sizes.button, next: sizes.next, count: sizes.count })) {
    expect(part.left, `${when}: ${name} starts in the viewport`).toBeGreaterThanOrEqual(0);
    expect(part.right, `${when}: ${name} ends in the viewport`).toBeLessThanOrEqual(sizes.width);
    expect(part.lines, `${when}: ${name} is one box`).toBe(1);
    expect(part.tall, `${when}: ${name} is one line`).toBeLessThan(part.line * 2);
  }
  expect(sizes.button.right, `${when}: the button is left of Next open`).toBeLessThanOrEqual(sizes.next.left);
}

let thread = 0;
let reply = '';

test.describe.serial('an archived page', () => {
  test.beforeAll(async ({ playwright, baseURL }) => {
    for (const [name, value] of Object.entries({ ASSERTION, SECOND, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    publish(NEXT, [`# ${NEXT_TITLE}`, '', 'What replaced the first plan.', '',
      '## Findings', '', 'The pond has a heater now.', '']);
    publish(NAME, ['# Pond plan', '', 'A finished plan for the pond.', '',
      '## Findings', '', PARAGRAPH, '',
      '## Decisions for the maintainer', '',
      '| # | Question | Options | Default |', '|---|---|---|---|',
      '| 1 | Which heater? | Floating / Submerged | Floating |', '']);
    const request = await playwright.request.newContext({ baseURL });
    try {
      thread = (await post(request, { page: NAME, section: 'findings', text: 'Did the pump crack?' })).id;
      reply = 'It held, but only just.';
      await post(request, { page: NAME, parent: thread, text: reply });
    } finally {
      await request.dispose();
    }
    archive();
  });

  test.afterAll(() => {
    if (!OUT || !PYTHON) return;
    // LINKED is there only once its check has rendered it.
    for (const name of [NAME, LINKED]) {
      if (fs.existsSync(path.join(OUT, `${name}.html`))) run('unarchive', name, '--local', '--out-dir', OUT);
    }
  });

  test.describe('signed in as its owner', () => {
    test.use({ extraHTTPHeaders: SIGNED_IN });

    test('shows the banner, keeps its thread readable and closes its composers', async ({ page }) => {
      const errors = await watch(page);
      await open(page);
      const side = parts(page);

      await expect(side.banner).toHaveText(`Archived ${archivedDay()} · superseded by ${NEXT_TITLE}`);
      await expect(side.banner).toHaveAttribute('role', 'note');
      const link = side.banner.locator('a');
      await expect(link).toHaveText(NEXT_TITLE);
      await expect(link).toHaveAttribute('href', `${NEXT}.html`);
      expect(await side.banner.evaluate((node) =>
        node.previousElementSibling?.classList.contains('artifact-topbar'))).toBe(true);

      // Its words, selected, offer no comment.
      await drag(page, PARAGRAPH);
      await page.waitForTimeout(600);
      await expect(side.pill).toBeHidden();
      await page.mouse.click(5, 300);

      const shown = await openThread(page, thread);
      await expect(shown.item).toContainText('Did the pump crack?');
      await expect(shown.item).toContainText(reply);
      await expect(shown.toggle).toBeDisabled();
      await expect(side.closed).toHaveText(CLOSED);
      await expect(side.pick).toBeVisible();
      await expect(side.pick).toBeDisabled();
      await expect(side.onPage).toBeVisible();
      await expect(side.onPage).toBeDisabled();
      const news = await side.aside.locator('button.artifact-comments-new').evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLButtonElement).disabled));
      expect(news.length).toBeGreaterThan(0);
      expect(news.every(Boolean)).toBe(true);

      await expect(side.fieldset).toHaveJSProperty('disabled', true);
      await expect(side.ask).toBeDisabled();
      await expect(side.save).toHaveText('Save answer');
      await expect(side.save).toBeDisabled();
      await expect(side.note).toHaveText(CLOSED_NOTE);
      await expect(page.locator('.artifact-review-count')).toHaveCount(0);
      // Nor does the comments panel offer its questions.
      await expect(side.aside.getByRole('tab', { name: /^Decisions/ })).toHaveCount(0);
      await expect(side.aside.locator('.artifact-comments-to-answer, .artifact-comments-decisions:not([hidden])')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('a reply draft kept over a reload stays folded away, its toggle disabled', async ({ page }) => {
      const errors = await watch(page);
      await open(page);
      const draft = 'A reply written before the page was archived.';
      // Written as the page is left, after the page keeps its own.
      await page.evaluate(([key, root, text]) => {
        window.addEventListener('pagehide', () => sessionStorage.setItem(key as string, JSON.stringify({ x: 0, y: 0, comments: {
          open: null, passage: null,
          texts: [{ thread: root, section: 'findings', index: 0, text, images: [] }],
        } })));
      }, [`lotuspod:reload:${NAME}`, thread, draft] as const);
      await page.reload();
      await settle(page);
      const shown = await openThread(page, thread);
      await expect(shown.toggle).toBeDisabled();
      const field = shown.item.locator('form.artifact-comment-reply textarea');
      await expect(field).toBeHidden();
      // Kept, for a reload once the page takes replies again.
      await expect(field).toHaveValue(draft);
      await expect(shown.item.locator('form.artifact-comment-reply button[type="submit"]')).toBeHidden();
      expect(errors).toEqual([]);
    });

    test('the button archives the page its URL names, whatever its body names', async ({ page }) => {
      const errors = await watch(page);
      run('render', '--name', LINKED, '--title', 'Linked plan', '--out-dir', OUT, '--body',
        `<p><a data-page="${NEXT}" href="${NEXT}.html">The next plan</a></p>` +
        '<h2 id="decisions">Decisions for the maintainer</h2><table><thead><tr><th>#</th>' +
        '<th>Question</th><th>Options</th><th>Default</th></tr></thead><tbody><tr><td>1</td>' +
        '<td>Which pump?</td><td>Small / Large</td><td>Small</td></tr></tbody></table>');
      const asked = page.waitForRequest((request) =>
        new URL(request.url()).pathname === '/api/archive' && request.method() === 'GET');
      await page.goto(`/${LINKED}.html?standalone`);
      expect(new URL((await asked).url()).searchParams.get('page')).toBe(LINKED);
      const button = parts(page).button;
      await expect(button).toHaveText('Archive');
      const posted = page.waitForRequest((request) =>
        new URL(request.url()).pathname === '/api/archive' && request.method() === 'POST');
      const loaded = page.waitForEvent('load');
      await button.click();
      expect((await posted).postDataJSON()).toEqual({ page: LINKED, archived: true });
      await loaded;
      await expect(parts(page).banner).toBeVisible();
      expect(fs.existsSync(path.join(OUT, `${LINKED}.archived.json`))).toBe(true);
      expect(fs.existsSync(path.join(OUT, `${NEXT}.archived.json`))).toBe(false);
      expect(errors).toEqual([]);
    });

    test('the owner unarchives it from the top bar, and archives it again', async ({ page }) => {
      const errors = await watch(page);
      await open(page);
      const side = parts(page);
      await expect(side.banner).toBeVisible();
      await expect(side.button).toHaveText('Unarchive');
      // At the right end of the top bar, its status line beside it.
      expect(await side.button.evaluate((node) =>
        node.parentElement?.matches('.artifact-topbar > span.artifact-archive-bar:last-child') &&
        node.nextElementSibling?.matches('span.artifact-archive-status[role="status"]'))).toBe(true);

      await press(page, 'Unarchive');
      await expect(side.banner).toHaveCount(0);
      await expect(side.button).toHaveText('Archive');
      await expect(side.fieldset).toHaveJSProperty('disabled', false);
      await expect(page.locator('.artifact-review-count')).toHaveCount(1);
      await drag(page, PARAGRAPH);
      await expect(side.pill).toBeVisible();
      await page.mouse.click(5, 300);
      const shown = await openThread(page, thread);
      await expect(shown.toggle).toBeEnabled();
      await expect(side.closed).toHaveCount(0);

      await press(page, 'Archive');
      await expect(side.banner).toBeVisible();
      await expect(side.banner).toContainText(`Archived ${new Date().toISOString().slice(0, 10)}`);
      await expect(side.button).toHaveText('Unarchive');
      await expect((await openThread(page, thread)).toggle).toBeDisabled();
      expect(errors).toEqual([]);
    });
  });

  test('a reader who is no owner, and one signed out, see the banner and no button', async ({ browser, baseURL }) => {
    for (const headers of [{ 'Cf-Access-Jwt-Assertion': SECOND }, {}]) {
      const context = await browser.newContext({
        baseURL, extraHTTPHeaders: headers, viewport: { width: 1440, height: 900 },
      });
      try {
        const page = await context.newPage();
        const errors = await watch(page);
        await open(page);
        const side = parts(page);
        await expect(side.banner).toBeVisible();
        await expect(side.banner).toContainText('Archived ');
        await expect(side.button).toHaveCount(0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  // The top bar with the owner's button and the review sheet's bar both
  // drawn, at the narrow width and just above where the narrow rules start,
  // with a long open question; then with a long message beside the button
  // after a press the site refuses.
  for (const width of [360, 641]) {
    test.describe(`signed in as its owner, ${width} px wide`, () => {
      test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width, height: 780 } });

      test('the top bar keeps its height with the button and the review bar both drawn', async ({ page }) => {
        const errors = await watch(page);
        publish(BAR, ['# A plan for the pond with a long title that the bar cuts short', '',
          'Still open.', '', '## Decisions for the maintainer', '',
          '| # | Question | Options | Default |', '|---|---|---|---|',
          '| 1 | Which pump should we use during winter? | Solar / Mains | |', '']);
        const read = page.waitForResponse((response) =>
          new URL(response.url()).pathname === '/api/archive' && response.request().method() === 'GET');
        await page.goto(`/${BAR}.html?standalone`);
        await read;
        const bar = page.locator('.artifact-topbar');
        const button = parts(page).button;
        const next = bar.locator('a.artifact-review-next');
        const count = bar.locator('.artifact-review-count');
        await expect(button).toHaveText('Archive');
        await expect(next).toBeVisible();
        await expect(count).toBeVisible();
        await fits(page, 'drawn');

        await page.route((url) => url.pathname === '/api/archive', (route) =>
          route.request().method() === 'POST'
            ? route.fulfill({ status: 500, json: { error: 'stale_page' } })
            : route.continue());
        await button.click();
        const status = bar.locator('.artifact-archive-status');
        const said = 'The page was not archived (stale_page). Try again.';
        await expect(status).toHaveText(said);
        await expect(status).toHaveAttribute('title', said);
        await expect(button).toBeEnabled();
        await fits(page, 'after a refused press');
        expect(errors).toEqual([]);
      });
    });
  }

  // Last, so a failure here leaves the checks before it run.
  test.describe('signed in as its owner, as the page loads', () => {
    test.use({ extraHTTPHeaders: SIGNED_IN });

    test('the button arrives in the top bar, and the page does not move when it does', async ({ page }) => {
      const errors = await watch(page);
      // Each shift's time, and when the button arrived. The page's comment
      // chip, which the page script draws as it runs, can land just after
      // the first paint on a slow load: a shift of its own, before the button.
      await page.addInitScript(() => {
        const w = window as any;
        w.__shifts = [] as { value: number; at: number }[];
        w.__arrived = null;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__shifts.push({ value: (entry as any).value, at: entry.startTime });
        }).observe({ type: 'layout-shift', buffered: true });
        new MutationObserver((records, observer) => {
          if (document.querySelector('button.artifact-archive')) {
            w.__arrived = performance.now();
            observer.disconnect();
          }
        }).observe(document, { childList: true, subtree: true });
      });
      await open(page);
      const button = parts(page).button;
      await expect(button).toHaveText('Unarchive');
      // Two frames on, so a shift the button caused has been recorded.
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      expect(await page.evaluate(() => {
        const w = window as any;
        return (w.__shifts as { value: number; at: number }[])
          .filter((shift) => shift.at >= w.__arrived).map((shift) => shift.value);
      }), 'no layout shift once the button is drawn').toEqual([]);
      expect(errors).toEqual([]);
    });
  });
});
