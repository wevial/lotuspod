import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// The capture fixture's diagram view page: an h2 "Release plan", a
// paragraph, a flowchart LR of fourteen boxes in one chain (S1 --> ... -->
// S14), paragraphs enough that the page scrolls, then an h3 "Small loop" and
// a sequence diagram. Each drawn diagram has an Expand button that opens it
// in a window-filling view (js/diagram-view.js).
const PAGE = '/capture-diagram-view.html';
const CARDS_PAGE = '/capture-node-cards.html';
// The pinned Mermaid (e2e/package.json) answers jsDelivr's requests for it,
// as in policy.spec.ts.
const MERMAID_DIR = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/';
const MERMAID_COPY = path.join(__dirname, '..', 'node_modules', 'mermaid');
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWNER = 'hermes';

// Signed in, as a reader of the site is: the page script asks the API about the
// page, which refuses a signed-out request.
test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: SIGNED_IN });

// The view's margin round the diagram at Fit, in px, and Fit's largest zoom.
const MARGIN = 24;
const FIT_MOST = 2;

type Violation = { blockedURI: string; effectiveDirective: string };
type Box = { x: number; y: number; width: number; height: number };

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

function diagram(page: Page, index = 0) {
  return page.locator('pre.mermaid').nth(index);
}

// The diagram's own svg, while it is on the page.
function drawing(page: Page, index = 0) {
  return diagram(page, index).locator(':scope > svg');
}

function expand(page: Page, index = 0) {
  return diagram(page, index).getByRole('button', { name: 'Expand diagram' });
}

function view(page: Page) {
  const dialog = page.locator('dialog.artifact-diagram-view');
  return {
    dialog,
    title: dialog.locator('.artifact-diagram-view-title'),
    readout: dialog.locator('.artifact-diagram-view-readout'),
    stage: dialog.getByRole('group', {
      name: 'Diagram: drag or use the arrow keys to move, plus and minus to zoom',
    }),
    svg: dialog.locator('.artifact-diagram-view-stage > svg'),
    zoomIn: dialog.getByRole('button', { name: 'Zoom in' }),
    zoomOut: dialog.getByRole('button', { name: 'Zoom out' }),
    fit: dialog.getByRole('button', { name: 'Fit', exact: true }),
    close: dialog.getByRole('button', { name: 'Close' }),
  };
}

function step(page: Page, id: string) {
  return view(page).dialog.locator(`g.node[id^="flowchart-${id}-"]`);
}

async function where(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

function centre(box: Box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function zoom(page: Page) {
  const text = (await view(page).readout.textContent()) ?? '';
  expect(text).toMatch(/^\d+%$/);
  return parseInt(text, 10);
}

async function opacity(locator: Locator) {
  return locator.evaluate((node) => getComputedStyle(node).opacity);
}

// Open the page and wait until both diagrams are drawn and have their button.
async function drawn(page: Page) {
  const seen = await watch(page);
  await page.goto(`${PAGE}?standalone`);
  for (const index of [0, 1]) {
    await expect(drawing(page, index)).toBeVisible();
    await expect(expand(page, index)).toHaveCount(1);
  }
  return seen;
}

// The svg's attributes the view changes, as they are on the page.
async function attributes(page: Page, index = 0) {
  return drawing(page, index).evaluate((svg) => ({
    id: svg.id,
    viewBox: svg.getAttribute('viewBox'),
    width: svg.getAttribute('width'),
    height: svg.getAttribute('height'),
    style: svg.getAttribute('style'),
  }));
}

// Scroll so the first diagram's top sits 100 px below the window's top.
async function scrollToDiagram(page: Page) {
  await diagram(page).evaluate((pre) => {
    window.scrollTo(0, pre.getBoundingClientRect().top + window.scrollY - 100);
  });
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  return scrolled;
}

async function open(page: Page, index = 0) {
  await diagram(page, index).hover();
  await expand(page, index).click();
  await expect(view(page).dialog).toBeVisible();
  await expect(view(page).svg).toHaveCount(1);
}

// The drawn diagram's box on the screen: everything in its svg but its
// style and definitions.
async function drawnBox(page: Page): Promise<Box> {
  return view(page).svg.evaluate((svg) => {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const child of Array.from(svg.children)) {
      if (['style', 'defs', 'marker'].includes(child.tagName.toLowerCase())) continue;
      const rect = child.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
}

// The whole diagram inside the stage, centred within 2 px.
async function whole(page: Page) {
  const stage = await where(view(page).stage);
  const box = await drawnBox(page);
  expect(box.x).toBeGreaterThanOrEqual(stage.x);
  expect(box.y).toBeGreaterThanOrEqual(stage.y);
  expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width);
  expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height);
  const middle = centre(box);
  const stageMiddle = centre(stage);
  expect(Math.abs(middle.x - stageMiddle.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(middle.y - stageMiddle.y)).toBeLessThanOrEqual(2);
}

// The zoom Fit gives the diagram whose viewBox on the page was natural.
async function fitZoom(page: Page, natural: string) {
  const [, , width, height] = natural.split(/[\s,]+/).map(Number);
  const stage = await where(view(page).stage);
  const fit = Math.min((stage.width - 2 * MARGIN) / width, (stage.height - 2 * MARGIN) / height, FIT_MOST);
  return Math.round(Math.max(0.25, Math.min(fit, 4)) * 100);
}

async function dragStage(page: Page, x: number, y: number) {
  const from = centre(await where(view(page).stage));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + x, from.y + y, { steps: 6 });
  await page.mouse.up();
}

function near(actual: number, expected: number, within: number) {
  expect(Math.abs(actual - expected), `${actual} within ${within} of ${expected}`).toBeLessThanOrEqual(within);
}

test('each drawn diagram has an Expand button in its corner, shown on hover or focus', async ({ page }) => {
  const seen = await drawn(page);
  await page.mouse.move(4, 4);
  for (const index of [0, 1]) {
    const pre = await where(diagram(page, index));
    const button = await where(expand(page, index));
    expect(button.x).toBeGreaterThanOrEqual(pre.x);
    expect(button.y).toBeGreaterThanOrEqual(pre.y);
    near(pre.x + pre.width - (button.x + button.width), 0, 16);
    near(button.y - pre.y, 0, 16);
    await expect.poll(() => opacity(expand(page, index))).toBe('0');
  }

  for (const index of [0, 1]) {
    await diagram(page, index).hover();
    await expect.poll(() => opacity(expand(page, index))).toBe('1');
    await page.mouse.move(4, 4);
    await expect.poll(() => opacity(expand(page, index))).toBe('0');
  }

  // Tab from the paragraph before the first diagram reaches its button.
  await page.locator('.artifact-body p').first().click();
  await page.mouse.move(4, 4);
  for (let tab = 0; tab < 20; tab += 1) {
    await page.keyboard.press('Tab');
    if (await expand(page).evaluate((node) => node === document.activeElement)) break;
  }
  await expect(expand(page)).toBeFocused();
  await expect.poll(() => opacity(expand(page))).toBe('1');
  await seen.clean();
});

test('Expand opens the diagram whole in a view that fills the window', async ({ page }) => {
  const seen = await drawn(page);
  const before = await attributes(page);
  await scrollToDiagram(page);
  await open(page);
  const { dialog, title, readout, stage, svg } = view(page);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
  const box = await where(dialog);
  const size = page.viewportSize()!;
  near(box.x, 0, 1);
  near(box.y, 0, 1);
  near(box.width, size.width, 1);
  near(box.height, size.height, 1);
  await expect(title).toHaveText('Release plan');
  await expect(dialog).toHaveAccessibleName('Release plan');
  await expect(svg).toHaveAttribute('id', before.id!);
  await expect(drawing(page)).toHaveCount(0);
  await whole(page);
  await expect(readout).toHaveText(`${await fitZoom(page, before.viewBox!)}%`);
  await expect(stage).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const second = await attributes(page, 1);
  await open(page, 1);
  await expect(title).toHaveText('Small loop');
  await expect(svg).toHaveAttribute('id', second.id!);
  await expect(drawing(page, 1)).toHaveCount(0);
  await expect(readout).toHaveText(`${await fitZoom(page, second.viewBox!)}%`);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await seen.clean();
});

test('a drag and the arrow keys move the diagram', async ({ page }) => {
  const seen = await drawn(page);
  await open(page);
  const first = await where(step(page, 'S1'));
  await dragStage(page, 150, 90);
  const dragged = await where(step(page, 'S1'));
  near(dragged.x - first.x, 150, 1);
  near(dragged.y - first.y, 90, 1);

  await view(page).stage.focus();
  await page.keyboard.press('ArrowRight');
  const moved = await where(step(page, 'S1'));
  near(moved.x - dragged.x, 60, 1);
  near(moved.y - dragged.y, 0, 1);
  await seen.clean();
});

test('ctrl+wheel zooms about the pointer and a plain wheel moves the diagram', async ({ page }) => {
  const seen = await drawn(page);
  await open(page);
  const fitted = await zoom(page);
  const at = centre(await where(step(page, 'S5')));
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect.poll(() => zoom(page)).toBeGreaterThan(fitted);
  const zoomed = await zoom(page);
  const still = centre(await where(step(page, 'S5')));
  near(still.x, at.x, 2);
  near(still.y, at.y, 2);

  await page.mouse.wheel(0, 100);
  await expect.poll(async () => centre(await where(step(page, 'S5'))).y).not.toBe(still.y);
  const down = centre(await where(step(page, 'S5')));
  expect(await zoom(page)).toBe(zoomed);
  near(down.x, still.x, 2);
  near(down.y, still.y + 100, 2);

  await page.mouse.wheel(100, 0);
  await expect.poll(async () => centre(await where(step(page, 'S5'))).x).not.toBe(down.x);
  const right = centre(await where(step(page, 'S5')));
  expect(await zoom(page)).toBe(zoomed);
  near(right.x, down.x + 100, 2);
  near(right.y, down.y, 2);
  await seen.clean();
});

test('the buttons and keys zoom between 25% and 400%', async ({ page }) => {
  const seen = await drawn(page);
  await open(page);
  const { zoomIn, zoomOut, stage } = view(page);
  const fitted = await zoom(page);
  await zoomIn.click();
  near(await zoom(page), Math.round(fitted * 1.25), 1);

  await stage.focus();
  for (let press = 0; press < 20; press += 1) await page.keyboard.press('+');
  await expect(view(page).readout).toHaveText('400%');
  for (let press = 0; press < 40; press += 1) await page.keyboard.press('-');
  await expect(view(page).readout).toHaveText('25%');

  // The zoom-out button steps as the − key does.
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('+');
  const up = await zoom(page);
  await zoomOut.click();
  const byButton = await zoom(page);
  expect(byButton).toBeLessThan(up);
  await stage.focus();
  await page.keyboard.press('+');
  await expect(view(page).readout).toHaveText(`${up}%`);
  await page.keyboard.press('-');
  await expect(view(page).readout).toHaveText(`${byButton}%`);
  await seen.clean();
});

test('Fit, 0 and F show the whole diagram again', async ({ page }) => {
  const seen = await drawn(page);
  await open(page);
  const fitted = await zoom(page);
  const atOpen = await where(step(page, 'S1'));
  const { fit, stage } = view(page);

  async function same() {
    expect(await zoom(page)).toBe(fitted);
    const now = await where(step(page, 'S1'));
    near(now.x, atOpen.x, 1);
    near(now.y, atOpen.y, 1);
    near(now.width, atOpen.width, 1);
    await whole(page);
  }

  await dragStage(page, -200, 70);
  await view(page).zoomIn.click();
  expect(await zoom(page)).not.toBe(fitted);
  await fit.click();
  await same();

  for (const key of ['0', 'F']) {
    await dragStage(page, 120, -40);
    await stage.focus();
    await page.keyboard.press('+');
    expect(await zoom(page)).not.toBe(fitted);
    await page.keyboard.press(key);
    await same();
  }
  await seen.clean();
});

test('the page holds still behind the view, and Esc or ✕ puts the diagram back', async ({ page }) => {
  const seen = await drawn(page);
  const before = await attributes(page);
  const scrolled = await scrollToDiagram(page);
  const preBox = await where(diagram(page));

  for (const how of ['Escape', 'Close']) {
    await open(page);
    const { dialog, stage, close } = view(page);
    const middle = centre(await where(stage));
    await page.mouse.move(middle.x, middle.y);
    await page.mouse.wheel(0, 400);
    await page.mouse.wheel(0, -200);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 120);
    await page.keyboard.up('Control');
    await stage.focus();
    for (const key of ['Space', 'PageDown', 'End']) {
      await page.keyboard.press(key);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    near((await where(diagram(page))).height, preBox.height, 1);

    if (how === 'Escape') {
      await page.keyboard.press('Escape');
    } else {
      await close.click();
    }
    await expect(dialog).toBeHidden();
    await expect(expand(page)).toBeFocused();
    await expect(drawing(page)).toHaveCount(1);
    expect(await attributes(page)).toEqual(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    const after = await where(diagram(page));
    near(after.x, preBox.x, 1);
    near(after.y, preBox.y, 1);
    near(after.width, preBox.width, 1);
    near(after.height, preBox.height, 1);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden');
  }
  await seen.clean();
});

test('the title skips an invisible heading before the diagram', async ({ page }) => {
  const seen = await drawn(page);
  await diagram(page).evaluate((pre) => {
    const hidden = document.createElement('h2');
    hidden.textContent = 'Invisible heading';
    hidden.style.visibility = 'hidden';
    pre.before(hidden);
  });
  await open(page);
  await expect(view(page).title).toHaveText('Release plan');
  await page.keyboard.press('Escape');
  await seen.clean();
});

test('a diagram scrolled sideways in its block comes back scrolled as it was', async ({ page }) => {
  const seen = await drawn(page);
  // Wider than its block, as a diagram drawn without useMaxWidth would be.
  await drawing(page).evaluate((svg) => {
    svg.setAttribute('width', '3000');
    svg.setAttribute('style', 'max-width: none;');
  });
  await diagram(page).evaluate((pre) => { pre.scrollLeft = 350; });
  expect(await diagram(page).evaluate((pre) => pre.scrollLeft)).toBe(350);
  await diagram(page).hover();
  await expand(page).click();
  await expect(view(page).dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(view(page).dialog).toBeHidden();
  // The dialog's close event, a task after it hides, puts the diagram back
  // and the focus on its button last.
  await expect(expand(page)).toBeFocused();
  await expect(drawing(page)).toHaveCount(1);
  await expect.poll(() => diagram(page).evaluate((pre) => pre.scrollLeft)).toBe(350);
  await seen.clean();
});

test("a node card closes when its diagram's view opens and opens again after", async ({ page }) => {
  const seen = await watch(page);
  await page.goto(`${CARDS_PAGE}?standalone`);
  const box = diagram(page).locator('g.node[id^="flowchart-B-"]');
  const card = page.locator('.artifact-node-card');
  await expect(box).toHaveAttribute('role', 'button');
  await expect(expand(page)).toHaveCount(1);
  await box.click();
  await expect(card).toBeVisible();

  await diagram(page).hover({ position: { x: 4, y: 4 } });
  await expand(page).click();
  await expect(card).toBeHidden();
  await expect(view(page).dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(view(page).dialog).toBeHidden();
  await box.click();
  await expect(card).toBeVisible();
  await expect(card.locator('h3')).toHaveText('Draw the cards');
  await seen.clean();
});

test('the view colors each box by its status as the page does, and Esc leaves them so', async ({ page }) => {
  const seen = await watch(page);
  await page.goto(`${CARDS_PAGE}?standalone`);
  await expect(expand(page)).toHaveCount(1);
  // The first plan's Nodes table gives A merged, C ready and D waiting.
  const looks = (svg: Locator) => svg.evaluate((node) => {
    const look = (id: string) => {
      const style = getComputedStyle(node.querySelector(`g.node[id^="flowchart-${id}-"] > .label-container`)!);
      return { stroke: style.stroke, fill: style.fill, dash: style.strokeDasharray, opacity: style.opacity };
    };
    return { merged: look('A'), ready: look('C'), waiting: look('D') };
  });
  const before = await looks(drawing(page));
  expect(new Set(Object.values(before).map((look) => JSON.stringify(look))).size).toBe(3);

  await diagram(page).hover({ position: { x: 4, y: 4 } });
  await expand(page).click();
  await expect(view(page).dialog).toBeVisible();
  await expect(view(page).svg).toHaveCount(1);
  expect(await looks(view(page).svg)).toEqual(before);

  await page.keyboard.press('Escape');
  await expect(view(page).dialog).toBeHidden();
  await expect(drawing(page)).toHaveCount(1);
  expect(await looks(drawing(page))).toEqual(before);
  await seen.clean();
});

test.describe('without scripts', () => {
  test.use({ javaScriptEnabled: false });

  test('each diagram shows its source and no Expand button', async ({ page }) => {
    await page.goto(PAGE);
    await expect(page.locator('pre.mermaid')).toHaveCount(2);
    await expect(diagram(page)).toBeVisible();
    await expect(diagram(page)).toContainText('S1[Step 1] --> S2[Step 2]');
    await expect(diagram(page, 1)).toContainText('sequenceDiagram');
    await expect(page.getByRole('button', { name: 'Expand diagram' })).toHaveCount(0);
    await expect(page.locator('pre.mermaid svg')).toHaveCount(0);
  });
});

test.describe('an old version', () => {
  function run(...args: string[]) {
    return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
      encoding: 'utf-8',
      env: { ...ENV, PYTHONPATH: SRC },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  }

  function publish(name: string, markdown: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-diagram-view-'));
    try {
      const file = path.join(dir, `${name}.md`);
      fs.writeFileSync(file, markdown, 'utf-8');
      const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
        '--credential', HERMES);
      expect(said).toContain(`published ${name} at revision`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function source(edition: string) {
    return [
      '# Diagram view versions', '', `Edition: ${edition}.`, '',
      '## Plan', '', '```mermaid', 'flowchart LR', '  A[Write] --> B[Publish] --> C[Read]', '```', '',
    ].join('\n');
  }

  test('opens with no Expand button and no dialog', async ({ page }) => {
    for (const [name, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    await watch(page);
    const name = 'diagram-view-versions';
    publish(name, source('first'));
    publish(name, source('second'));
    const answered = await page.request.get(`/api/versions?page=${name}`);
    expect(answered.status()).toBe(200);
    const listed = (await answered.json()).versions;
    expect(listed).toHaveLength(2);
    await page.goto(`/${name}.html?version=${listed[1].commit}`);
    await expect(page.locator('main.artifact--old-version')).toBeVisible();
    await expect(page.locator('pre.mermaid')).toContainText('A[Write] --> B[Publish]');
    await expect(page.getByRole('button', { name: 'Expand diagram' })).toHaveCount(0);
    await expect(page.locator('dialog')).toHaveCount(0);
  });
});
