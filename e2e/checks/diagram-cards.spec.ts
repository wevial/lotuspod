import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 800 } });

// The capture fixture's node cards page: an opening paragraph, then a
// flowchart (A --> B, E --> B, B --> C, A --> D) whose Nodes table lists A to
// D and not E, then a second flowchart that repeats node id A, holds a
// subgraph (P --> Q), and whose table has a row Z naming no box, and a third
// (K <--> R, R --> S, S --> T styled opaque) whose table has no thead and a
// row too long for the window, and a fourth (F --> G, G --> H, J --> H)
// that styles F with a style line, G with a class line and J with :::.
const PAGE = '/capture-node-cards.html';
// The pinned Mermaid (e2e/package.json) answers jsDelivr's requests for it,
// as in policy.spec.ts.
const MERMAID_DIR = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/';
const MERMAID_COPY = path.join(__dirname, '..', 'node_modules', 'mermaid');

type Violation = { blockedURI: string; effectiveDirective: string };

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

function box(page: Page, id: string, index = 0): Locator {
  return diagram(page, index).locator(`g.node[id^="flowchart-${id}-"]`);
}

function card(page: Page) {
  return page.locator('.artifact-node-card');
}

// Open the page and wait until the first diagram is drawn and bound.
async function drawn(page: Page) {
  const seen = await watch(page);
  await page.goto(`${PAGE}?standalone`);
  await expect(diagram(page).locator('svg')).toBeVisible();
  await expect(box(page, 'A')).toHaveAttribute('role', 'button');
  await expect(box(page, 'A', 1)).toHaveAttribute('role', 'button');
  return seen;
}

// The card's "Waits for" and "Unblocks", as [term, value] pairs.
async function graph(page: Page) {
  return card(page).locator('dl.artifact-node-card-graph').evaluate((list) =>
    Array.from(list.querySelectorAll('dt')).map((term) => [
      term.textContent, term.nextElementSibling?.textContent,
    ]));
}

// The path data of the arrows drawn highlighted in a diagram, sorted.
async function lit(page: Page, index = 0) {
  return diagram(page, index).locator('svg').evaluate((svg) =>
    Array.from(svg.querySelectorAll('g.artifact-node-arrows path.artifact-node-arrow'))
      .map((copy) => copy.getAttribute('d')).sort());
}

// The path data of a diagram's arrows by their ids, sorted.
async function arrows(page: Page, ids: string[], index = 0) {
  return diagram(page, index).locator('svg').evaluate((svg, wanted) =>
    wanted.map((id) => svg.querySelector(`path.flowchart-link[id="${id}"]`)!.getAttribute('d'))
      .sort(), ids);
}

const B_ARROWS = ['L_A_B_0', 'L_E_B_1', 'L_B_C_2'];

// Somewhere on the page no box is under.
async function away(page: Page) {
  await page.mouse.move(4, 796);
}

async function openB(page: Page) {
  await box(page, 'B').click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('h3')).toHaveText('Draw the cards');
}

test('the listed boxes are buttons and the table they came from is hidden', async ({ page }) => {
  const seen = await drawn(page);
  await expect(page.locator('h3.artifact-node-heading').first()).toBeHidden();
  await expect(page.locator('#nodes-table')).toBeHidden();
  for (const id of ['A', 'B', 'C', 'D']) {
    await expect(box(page, id)).toHaveAttribute('role', 'button');
    await expect(box(page, id)).toHaveAttribute('tabindex', '0');
  }
  await expect(box(page, 'E')).not.toHaveAttribute('role');
  await expect(box(page, 'E')).not.toHaveAttribute('tabindex');

  await page.locator('.artifact-body > p').first().click();
  const reached: string[] = [];
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    reached.push(await page.evaluate(() => document.activeElement?.id ?? ''));
  }
  for (const id of ['A', 'B', 'C', 'D']) {
    expect(reached.some((seenId) => seenId.startsWith(`flowchart-${id}-`)), id).toBe(true);
  }
  expect(reached.some((seenId) => seenId.startsWith('flowchart-E-'))).toBe(false);

  await box(page, 'E').click();
  await expect(page.locator('.artifact-node-card:visible')).toHaveCount(0);
  await seen.clean();
});

test("a box's card sits beside it with its row and its arrows", async ({ page }) => {
  const seen = await drawn(page);
  await openB(page);
  await expect(page.locator('.artifact-node-card:visible')).toHaveCount(1);
  const where = (await card(page).boundingBox())!;
  const b = (await box(page, 'B').boundingBox())!;
  expect(where.x).toBeGreaterThanOrEqual(0);
  expect(where.y).toBeGreaterThanOrEqual(0);
  expect(where.x + where.width).toBeLessThanOrEqual(1280);
  expect(where.y + where.height).toBeLessThanOrEqual(800);
  const overlaps = where.x < b.x + b.width && b.x < where.x + where.width
    && where.y < b.y + b.height && b.y < where.y + where.height;
  expect(overlaps).toBe(false);
  await expect(card(page)).toHaveAttribute('role', 'dialog');
  await expect(page.getByRole('dialog', { name: 'Draw the cards' })).toBeVisible();
  await expect(card(page).locator('dl.artifact-node-card-fields dt')).toHaveText(['Title', 'Status']);
  await expect(card(page).locator('dl.artifact-node-card-fields dd'))
    .toHaveText(['Open a card for each box', 'Open']);
  const link = card(page).locator('.artifact-node-card-link a');
  await expect(link).toHaveAttribute('href', 'https://example.com/pull/12');
  await expect(link).toHaveText('#12');
  expect(await graph(page)).toEqual([['Waits for', 'A (merged), E'], ['Unblocks', 'C (ready)']]);
  await expect(box(page, 'B')).toHaveAttribute('aria-expanded', 'true');

  await box(page, 'A').focus();
  await page.keyboard.press('Enter');
  await expect(card(page).locator('h3')).toHaveText('Write the parser');
  await expect(page.locator('.artifact-node-card')).toHaveCount(1);
  await expect(page.locator('.artifact-node-card:visible')).toHaveCount(1);
  expect(await graph(page)).toEqual([['Waits for', 'nothing'], ['Unblocks', 'B (open), D (waiting)']]);

  // C's row has no link: its empty PR cell is still a field, in its place.
  await box(page, 'C').focus();
  await page.keyboard.press('Enter');
  await expect(card(page).locator('h3')).toHaveText('Light the arrows');
  await expect(card(page).locator('dl.artifact-node-card-fields dt')).toHaveText(['Title', 'Status', 'PR']);
  await expect(card(page).locator('dl.artifact-node-card-fields dd'))
    .toHaveText(["Draw a box's arrows above the boxes", 'ready', '']);
  await expect(card(page).locator('.artifact-node-card-link')).toBeHidden();
  await expect(box(page, 'B')).toHaveAttribute('aria-expanded', 'false');
  await seen.clean();
});

test('an open card stays inside the window as the page scrolls', async ({ page }) => {
  const seen = await drawn(page);
  await openB(page);
  const inside = async () => {
    const where = (await card(page).boundingBox())!;
    return where.y >= 0 && where.y + where.height <= 800 && where.x >= 0 && where.x + where.width <= 1280;
  };
  // Down past B, so its box leaves the window, then back to the top.
  for (const top of [1200, 2000, 0]) {
    await page.evaluate((y) => window.scrollTo(0, y), top);
    await expect.poll(inside).toBe(true);
    await expect(card(page)).toBeVisible();
  }
  // Back at the top, the card sits beside B again, not over it.
  const where = (await card(page).boundingBox())!;
  const b = (await box(page, 'B').boundingBox())!;
  expect(where.x).toBeGreaterThanOrEqual(b.x + b.width);
  await seen.clean();
});

test('the card closes on its X, on Esc anywhere and on a click outside it', async ({ page }) => {
  const seen = await drawn(page);

  await openB(page);
  await card(page).getByRole('button', { name: 'Close' }).click();
  await expect(card(page)).toBeHidden();
  await expect(box(page, 'B')).toBeFocused();

  await openB(page);
  await box(page, 'B').focus();
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();

  await openB(page);
  await card(page).locator('.artifact-node-card-link a').focus();
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
  await expect(box(page, 'B')).toBeFocused();

  await openB(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();

  await openB(page);
  await page.locator('.artifact-body > p').first().click();
  await expect(card(page)).toBeHidden();

  await openB(page);
  await card(page).locator('h3').click();
  await expect(card(page)).toBeVisible();
  await seen.clean();
});

test('each box takes its status color', async ({ page }) => {
  const seen = await drawn(page);
  const shapes = await diagram(page).locator('svg').evaluate((svg) => {
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const color = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const tokens = {
      mint: color('--color-mint'),
      amber: color('--color-amber'),
      lavender: color('--color-lavender'),
      hairline: color('--hairline-strong'),
      surface: color('--color-surface'),
    };
    probe.remove();
    const shape = (id: string) => {
      const style = getComputedStyle(svg.querySelector(`g.node[id^="flowchart-${id}-"] > .label-container`)!);
      return { stroke: style.stroke, fill: style.fill, dash: style.strokeDasharray };
    };
    return { tokens, A: shape('A'), B: shape('B'), C: shape('C'), D: shape('D'), E: shape('E') };
  });
  const { tokens } = shapes;
  expect(shapes.A.stroke).toBe(tokens.mint);
  expect(shapes.B.stroke).toBe(tokens.amber);
  expect(shapes.C.stroke).toBe(tokens.lavender);
  expect(shapes.C.dash).not.toBe('none');
  expect(shapes.A.dash).toBe(shapes.E.dash);
  expect(shapes.D.stroke).toBe(tokens.hairline);
  expect(shapes.D.fill).toBe(tokens.surface);
  // Mermaid's own: the lotus palette's lavender border on the surface.
  expect(shapes.E).toEqual({ stroke: tokens.lavender, fill: tokens.surface, dash: shapes.E.dash });
  await expect(box(page, 'E')).not.toHaveClass(/artifact-node/);
  for (const id of ['A', 'B', 'C']) {
    expect(shapes[id as 'A'].fill).not.toBe(tokens.surface);
  }
  await seen.clean();
});

test("an open card's arrows are drawn cyan above the boxes", async ({ page }) => {
  const seen = await drawn(page);
  await openB(page);
  expect(await lit(page)).toEqual(await arrows(page, B_ARROWS));
  const drawnAbove = await diagram(page).locator('svg').evaluate((svg) => {
    const nodes = svg.querySelector('g.root > g.nodes')!;
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-cyan)';
    document.body.appendChild(probe);
    const cyan = getComputedStyle(probe).color;
    probe.remove();
    const copies = Array.from(svg.querySelectorAll('path.artifact-node-arrow'));
    return {
      cyan,
      strokes: copies.map((copy) => getComputedStyle(copy).stroke),
      after: copies.every((copy) => {
        const order = nodes.compareDocumentPosition(copy);
        return (order & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          && (order & Node.DOCUMENT_POSITION_CONTAINED_BY) === 0;
      }),
      dimmed: Number(getComputedStyle(svg.querySelector('path.flowchart-link[id="L_A_D_3"]')!).opacity),
    };
  });
  expect(drawnAbove.cyan).toBe('rgb(94, 224, 255)');
  expect(drawnAbove.strokes).toEqual([drawnAbove.cyan, drawnAbove.cyan, drawnAbove.cyan]);
  expect(drawnAbove.after).toBe(true);
  expect(drawnAbove.dimmed).toBeLessThan(1);

  await away(page);
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
  const after = await diagram(page).locator('svg').evaluate((svg) => {
    const nodes = svg.querySelector('g.root > g.nodes')!;
    return {
      opacities: Array.from(svg.querySelectorAll('path.flowchart-link'))
        .map((arrow) => Number(getComputedStyle(arrow).opacity)),
      following: Array.from(svg.querySelectorAll('path')).filter((arrow) => {
        const order = nodes.compareDocumentPosition(arrow);
        return (order & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          && (order & Node.DOCUMENT_POSITION_CONTAINED_BY) === 0;
      }).length,
    };
  });
  expect(after.opacities).toEqual([1, 1, 1, 1]);
  expect(after.following).toBe(0);
  await seen.clean();
});

test('a hovered or focused box lights its own arrows', async ({ page }) => {
  const seen = await drawn(page);
  const toD = await arrows(page, ['L_A_D_3']);
  await box(page, 'D').hover();
  await expect.poll(() => lit(page)).toEqual(toD);

  await openB(page);
  await box(page, 'D').hover();
  await expect.poll(() => lit(page)).toEqual(toD);
  await away(page);
  await expect.poll(() => lit(page)).toEqual(await arrows(page, B_ARROWS));

  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
  await expect.poll(() => lit(page)).toEqual([]);
  await box(page, 'B').focus();
  await page.keyboard.press('Tab');
  await expect(box(page, 'C')).toBeFocused();
  await expect.poll(() => lit(page)).toEqual(await arrows(page, ['L_B_C_2']));
  await seen.clean();
});

test("a table naming a box the diagram lacks stays shown, and its boxes keep their own arrows", async ({ page }) => {
  const seen = await drawn(page);
  await expect(page.locator('h3.artifact-node-heading').nth(1)).toBeVisible();
  await expect(page.locator('#nodes-table-2')).toBeVisible();

  await box(page, 'A', 1).click();
  await expect(card(page).locator('h3')).toHaveText('Answer the questions');
  expect(await graph(page)).toEqual([['Waits for', 'X'], ['Unblocks', 'Y (waiting)']]);
  await expect.poll(() => lit(page, 1)).toEqual(await arrows(page, ['L_X_A_0', 'L_A_Y_1'], 1));
  expect(await lit(page)).toEqual([]);

  // A box inside a subgraph: its arrow's copy keeps the subgraph's space.
  await box(page, 'P', 1).click();
  await expect(card(page).locator('h3')).toHaveText('Tidy the docs');
  expect(await graph(page)).toEqual([['Waits for', 'nothing'], ['Unblocks', 'Q']]);
  await away(page);
  const places = await diagram(page, 1).locator('svg').evaluate((svg) => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map(Math.round);
    };
    return {
      original: box(svg.querySelector('path.flowchart-link[id="L_P_Q_2"]')!),
      copy: box(svg.querySelector('path.artifact-node-arrow')!),
    };
  });
  expect(places.copy).toEqual(places.original);
  await seen.clean();
});

test('arrows point the way their heads do, a long card scrolls inside the window, and a table without a thead reads its header', async ({ page }) => {
  const seen = await drawn(page);
  await expect(box(page, 'K', 2)).toHaveAttribute('role', 'button');
  // Every row names a box, the header row being no body row.
  await expect(page.locator('#nodes-table-3')).toBeHidden();
  await expect(page.locator('h3.artifact-node-heading').nth(2)).toBeHidden();

  await box(page, 'K', 2).click();
  await expect(card(page).locator('dl.artifact-node-card-fields dt')).toHaveText(['Title', 'Status']);
  expect(await graph(page)).toEqual([['Waits for', 'R (open)'], ['Unblocks', 'R (open)']]);
  // The arrow its linkStyle makes opaque still dims.
  await away(page);
  const dimmed = await diagram(page, 2).locator('svg').evaluate((svg) =>
    Number(getComputedStyle(svg.querySelector('path.flowchart-link[id="L_S_T_2"]')!).opacity));
  expect(dimmed).toBeLessThan(1);

  // The card covers the boxes beside K, so these open from the keyboard.
  await box(page, 'R', 2).focus();
  await page.keyboard.press('Enter');
  expect(await graph(page)).toEqual([['Waits for', 'K (merged)'], ['Unblocks', 'K (merged), S (ready)']]);
  await box(page, 'S', 2).focus();
  await page.keyboard.press('Enter');
  expect(await graph(page)).toEqual([['Waits for', 'R (open)'], ['Unblocks', 'T (waiting)']]);

  await box(page, 'T', 2).focus();
  await page.keyboard.press('Enter');
  await expect(card(page).locator('h3')).toHaveText('Write it up');
  const where = (await card(page).boundingBox())!;
  expect(where.y).toBeGreaterThanOrEqual(0);
  expect(where.y + where.height).toBeLessThanOrEqual(800);
  expect(where.x + where.width).toBeLessThanOrEqual(1280);
  expect(await card(page).evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await seen.clean();
});

test('a box with its own Mermaid style keeps it, and only an unstyled box takes its status color', async ({ page }) => {
  const seen = await drawn(page);
  await expect(box(page, 'F', 3)).toHaveAttribute('role', 'button');
  const shapes = await diagram(page, 3).locator('svg').evaluate((svg) => {
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    probe.style.color = 'var(--color-lavender)';
    const lavender = getComputedStyle(probe).color;
    probe.remove();
    const shape = (id: string) => {
      const style = getComputedStyle(svg.querySelector(`g.node[id^="flowchart-${id}-"] > .label-container`)!);
      return { fill: style.fill, stroke: style.stroke, dash: style.strokeDasharray };
    };
    return { lavender, F: shape('F'), G: shape('G'), J: shape('J'), H: shape('H') };
  });
  expect(shapes.F).toEqual({ fill: 'rgb(255, 224, 224)', stroke: 'rgb(204, 0, 0)', dash: 'none' });
  const pink = { fill: 'rgb(224, 255, 224)', stroke: 'rgb(0, 170, 0)', dash: 'none' };
  expect(shapes.G).toEqual(pink);
  expect(shapes.J).toEqual(pink);
  expect(shapes.H.stroke).toBe(shapes.lavender);
  expect(shapes.H.dash).not.toBe('none');

  await expect(box(page, 'F', 3)).toHaveAttribute('aria-label', 'Styled, ready');
  await box(page, 'F', 3).click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('h3')).toHaveText('Styled');
  await expect(card(page).locator('dl.artifact-node-card-fields dt')).toHaveText(['Title', 'Status']);
  await expect(card(page).locator('dl.artifact-node-card-fields dd'))
    .toHaveText(['A box with its own style', 'ready']);
  await seen.clean();
});

test.describe('without scripts', () => {
  test.use({ javaScriptEnabled: false });

  test('every Nodes heading and table shows and no box is focusable', async ({ page }) => {
    await page.goto(`${PAGE}?standalone`);
    const headings = page.locator('.artifact-body > h3', { hasText: 'Nodes' });
    await expect(headings).toHaveCount(4);
    await expect(headings.nth(0)).toBeVisible();
    await expect(headings.nth(1)).toBeVisible();
    await expect(page.locator('#nodes-table')).toBeVisible();
    await expect(page.locator('#nodes-table-2')).toBeVisible();
    await expect(page.locator('[tabindex]')).toHaveCount(0);
  });
});
