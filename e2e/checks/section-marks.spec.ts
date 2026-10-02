import { expect, test, type Locator, type Page } from '@playwright/test';

// At this width a box never opens: its chip opens the section's threads in
// a popover over the text. panel.spec.ts checks the side panel a wider
// window gets, and narrow.spec.ts the popover and a phone's bottom sheet.
const MEDIUM = { width: 1024, height: 768 };
test.use({ viewport: MEDIUM });

// The capture fixture's sections page: an intro, then three sections, each
// folding under its heading and ending in a comment box; the second asks one
// question. A folded heading's button ends in a mark of what waits in its
// section. These checks answer the threads and answers routes themselves, so
// nothing is stored, and drive the page's clock where a second read of the
// threads is wanted, as live.spec.ts does.
const PAGE = '/capture-sections.html';
const SLUG = 'capture-sections';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const FOLDED = `lotuspod:folded:${PAGE}`;
const IDS = ['findings', 'decisions-for-the-maintainer', 'next-steps'];
const TITLES = ['Findings', 'Decisions for the maintainer', 'Next steps'];
// The reader as a page names them: their address's part before the @.
const READER = 'maintainer';
const AGENT = { kind: 'agent', handle: 'hermes' };
const START = Date.parse('2026-09-30T12:00:00Z');

type Violation = { blockedURI: string; effectiveDirective: string };

// Errors, policy violations and the page's reads of the threads route.
async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    const seen: Violation[] = [];
    w.__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
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
  return {
    async clean() {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__violations as Violation[])).toEqual([]);
    },
  };
}

function section(page: Page, index: number) {
  const heading = page.locator(`h2#${IDS[index]}`);
  const wrapper = page.locator(`div.artifact-section-body[data-section="${IDS[index]}"]`);
  return {
    heading,
    wrapper,
    button: heading.locator('button.artifact-section-toggle'),
    mark: heading.locator('.artifact-section-mark'),
    // A mark that is drawn: one not hidden.
    drawn: heading.locator('.artifact-section-mark:not([hidden])'),
    summary: wrapper.locator('details.artifact-comment > summary'),
    form: wrapper.locator('form.artifact-decision'),
  };
}

let next = 1;

function comment(fields: Record<string, unknown>) {
  const id = next++;
  return {
    id,
    page: SLUG,
    section: 'next-steps',
    sectionTitle: 'Next steps',
    revision: '',
    parent: null,
    text: `Comment ${id}`,
    quote: null,
    actor: { kind: 'human', name: READER },
    createdAt: '2026-09-30T10:00:00.000Z',
    state: 'pending',
    ...fields,
  };
}

function reply(root: { id: number; section: string }, text: string) {
  return comment({ parent: root.id, section: root.section, state: 'answered', text, actor: AGENT });
}

// Answer the threads route's reads in turn: the nth read (from 1) gets
// threads(n).
async function serveThreads(page: Page, threads: (n: number) => unknown[]) {
  let reads = 0;
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: SLUG, threads: threads(++reads) } }));
}

// Answer the answers route's read with questions.
async function serveAnswers(page: Page, questions: () => object) {
  await page.route((url) => url.pathname === '/api/answers', (route) =>
    route.fulfill({ json: { page: SLUG, questions: questions() } }));
}

// The page as if the reader had folded the sections named before.
async function remember(page: Page, ids: string[]) {
  await page.addInitScript(([key, value]) => {
    if (!sessionStorage.getItem('__remembered')) {
      sessionStorage.setItem('__remembered', '1');
      localStorage.setItem(key, value);
    }
  }, [FOLDED, JSON.stringify(ids)]);
}

// The page's clock, paused at START: it moves only when moved.
async function stopClock(page: Page) {
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
}

async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__inflight as number)).toBe(0);
}

// Move the page's clock on by ms, a second at a time, letting each read come
// back before time moves on.
async function pass(page: Page, ms: number) {
  await settle(page);
  for (let done = 0; done < ms; done += 1000) {
    await page.clock.runFor(Math.min(1000, ms - done));
    await settle(page);
  }
}

async function load(page: Page) {
  await page.goto(PAGE);
  await expect(page.locator('details.artifact-comment')).toHaveCount(3);
  await settle(page);
}

async function fold(page: Page, index: number) {
  const { button, wrapper } = section(page, index);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(wrapper).toHaveAttribute('hidden', 'until-found');
}

// The question the page asks, as its form names it.
async function question(page: Page) {
  return section(page, 1).form.evaluate((form) => ({
    question: (form as HTMLElement).dataset.question!,
    version: (form as HTMLElement).dataset.version!,
    choice: (form.querySelector('input[name="choice"]') as HTMLInputElement).value,
  }));
}

// The answers route's entry for an answer to the question as the page asks it.
function answered(asked: { question: string; version: string; choice: string }) {
  return {
    [asked.question]: {
      current: {
        id: 1, page: SLUG, question: asked.question, version: asked.version, choice: asked.choice,
        note: '', revision: 'abc123abc123', actor: { kind: 'human', name: READER },
        createdAt: '2026-10-01T09:30:00Z', supersedes: null,
      },
      earlier: [],
    },
  };
}

// The contrast of a node's text colour against what is behind it: the nearest
// ancestor's opaque background, translucent backgrounds composited over it.
async function contrast(target: Locator) {
  return target.evaluate((node) => {
    const parse = (text: string) => {
      const parts = (text.match(/rgba?\(([^)]+)\)/) as RegExpMatchArray)[1]
        .split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    const over = (top: number[], base: number[]) =>
      [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3]));
    const layers: number[][] = [];
    for (let at: Element | null = node; at; at = at.parentElement) {
      const colour = parse(getComputedStyle(at).backgroundColor);
      if (colour[3] > 0) layers.push(colour);
      if (colour[3] >= 1) break;
    }
    let behind = [255, 255, 255];
    for (const layer of layers.reverse()) behind = over(layer, behind);
    const text = over(parse(getComputedStyle(node).color), behind);
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [light, dark] = [luminance(text), luminance(behind)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  });
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('a reply drawn into a folded section marks its heading 1 new until it is opened', async ({ page }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const seen = await watch(page);
    const root = comment({ state: 'pending' });
    const REPLY = 'A submerged heater, clear of the pump outlet.';
    const answer = reply(root, REPLY);
    await serveAnswers(page, () => ({}));
    await serveThreads(page, (n) => [n < 2
      ? { root, replies: [] }
      : { root: { ...root, state: 'answered' }, replies: [answer] }]);
    await stopClock(page);
    await load(page);
    const third = section(page, 2);
    await fold(page, 2);
    await expect(third.drawn).toHaveCount(0);

    await pass(page, 5000);
    await expect(third.drawn).toHaveText('1 new');
    await expect(third.button).toHaveAccessibleName(/1 new/);

    await third.button.click();
    await expect(third.button).toHaveAttribute('aria-expanded', 'true');
    await expect(third.drawn).toHaveCount(0);
    await third.summary.click();
    await expect(page.locator('.artifact-comments-popover').getByText(REPLY, { exact: true })).toBeVisible();

    await fold(page, 2);
    await expect(third.drawn).toHaveCount(0);
    await expect(third.button).toHaveAccessibleName('Next steps');
    await seen.clean();
  });

  test('after a reload the threads in a remembered folded section count as new, and opening clears them', async ({ page }) => {
    const seen = await watch(page);
    const root = comment({ state: 'answered' });
    const other = comment({ state: 'answered', section: 'findings', sectionTitle: 'Findings' });
    await serveAnswers(page, () => ({}));
    await serveThreads(page, () => [
      { root, replies: [reply(root, 'Done.')] },
      { root: other, replies: [] },
    ]);
    await remember(page, ['next-steps']);
    await load(page);
    const [first, second, third] = [0, 1, 2].map((index) => section(page, index));
    await expect(third.button).toHaveAttribute('aria-expanded', 'false');
    await expect(third.drawn).toHaveText('2 new');
    await expect(first.button).toHaveAttribute('aria-expanded', 'true');
    await expect(first.drawn).toHaveCount(0);

    const control = page.locator('nav.artifact-outline button.artifact-sections-all');
    await expect(control).toHaveText('Collapse all');
    await control.click();
    await expect(control).toHaveText('Expand all');
    // Its thread was drawn while it was open: the first section stays unmarked.
    await expect(first.drawn).toHaveCount(0);
    await expect(second.drawn).toHaveText('1 to answer');
    await expect(third.drawn).toHaveText('2 new');

    await control.click();
    await expect(control).toHaveText('Collapse all');
    await expect(page.locator('.artifact-section-mark:not([hidden])')).toHaveCount(0);
    for (let index = 0; index < IDS.length; index += 1) {
      await expect(section(page, index).button).toHaveAccessibleName(TITLES[index]);
    }
    await seen.clean();
  });

  test('a folded question with no answer marks its heading 1 to answer', async ({ page }) => {
    const seen = await watch(page);
    let reads = 0;
    await page.route((url) => url.pathname === '/api/answers', (route) => {
      reads += 1;
      return route.fulfill({ json: { page: SLUG, questions: {} } });
    });
    await serveThreads(page, () => []);
    await load(page);
    const second = section(page, 1);
    await expect.poll(() => reads).toBe(1);
    await expect(second.form).not.toHaveClass(/artifact-decision--saved/);
    // Open, the heading's text is its title alone.
    await expect(second.heading).toHaveText('Decisions for the maintainer');
    await fold(page, 1);
    await expect(second.drawn).toHaveText('1 to answer');
    await expect(second.button).toHaveAccessibleName(/1 to answer/);
    await second.button.click();
    await expect(second.drawn).toHaveCount(0);
    await expect(second.heading).toHaveText('Decisions for the maintainer');
    await seen.clean();
  });

  test('a folded question answered as the page asks it draws no mark', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const asked = await question(page);
    await serveAnswers(page, () => answered(asked));
    await serveThreads(page, () => []);
    await load(page);
    const second = section(page, 1);
    await expect(second.form).toHaveClass(/artifact-decision--saved/);
    await fold(page, 1);
    await expect(second.mark).toBeHidden();
    await expect(second.drawn).toHaveCount(0);
    await expect(second.button).toHaveAccessibleName('Decisions for the maintainer');
    await seen.clean();
  });

  test('a reply drawn into a folded section with an open question marks both', async ({ page }) => {
    const seen = await watch(page);
    const root = comment({
      state: 'pending', section: 'decisions-for-the-maintainer', sectionTitle: 'Decisions for the maintainer',
    });
    await serveAnswers(page, () => ({}));
    await serveThreads(page, (n) => [n < 2
      ? { root, replies: [] }
      : { root: { ...root, state: 'answered' }, replies: [reply(root, 'Electric, on its own outlet.')] }]);
    await stopClock(page);
    await load(page);
    const second = section(page, 1);
    await fold(page, 1);
    await expect(second.drawn).toHaveText('1 to answer');

    await pass(page, 5000);
    await expect(second.drawn).toHaveText('1 new · 1 to answer');
    await expect(second.button).toHaveAccessibleName(/1 new · 1 to answer/);
    await seen.clean();
  });

  test('at 360 pixels wide two marked headings fit and their marks are legible', async ({ page }) => {
    const seen = await watch(page);
    await page.setViewportSize({ width: 360, height: 780 });
    const root = comment({ state: 'answered' });
    await serveAnswers(page, () => ({}));
    await serveThreads(page, () => [{ root, replies: [reply(root, 'Done.')] }]);
    await remember(page, ['decisions-for-the-maintainer', 'next-steps']);
    await load(page);
    const marks = [section(page, 1).drawn, section(page, 2).drawn];
    await expect(marks[0]).toHaveText('1 to answer');
    await expect(marks[1]).toHaveText('2 new');
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
    for (const mark of marks) {
      await expect(mark).toBeVisible();
      const box = (await mark.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(widths.viewport);
      expect(await contrast(mark)).toBeGreaterThanOrEqual(4.5);
    }
    await seen.clean();
  });
});
