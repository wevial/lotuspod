import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type ConsoleMessage, type Locator, type Page } from '@playwright/test';

// Signed in, as a reader of the site is: the page script asks the API about the
// page, which refuses a signed-out request with a 401 the console reports.
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': process.env.LOTUSPOD_TEST_ASSERTION ?? '' };

test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: SIGNED_IN });

// The capture fixture's ELK layout page: a flowchart whose first line asks for
// the ELK layout, with these subgraph lanes, arrows between them, and a Nodes
// table listing every box.
const PAGE = '/capture-elk-layout.html';
const LANES: Record<string, string[]> = {
  'Plan lane': ['P1', 'P2'],
  'Build lane': ['B1', 'B2', 'B3'],
  'Ship lane': ['S1', 'S2'],
};
// The pinned Mermaid and ELK layout (e2e/package.json) answer jsDelivr's
// requests for them, as in policy.spec.ts. The route keeps the URL, so the
// page policy applies as it does for readers.
const MERMAID_ELK_DIR = 'https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.2.3/';
const COPIES: Record<string, string> = {
  'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/': path.join(__dirname, '..', 'node_modules', 'mermaid'),
  [MERMAID_ELK_DIR]: path.join(__dirname, '..', 'node_modules', '@mermaid-js', 'layout-elk'),
};
// The ELK layout's renderer, a chunk its loader imports only when a diagram
// is laid out with it: without it, Mermaid falls back to its default layout.
const ELK_RENDERER = /^dist\/chunks\/mermaid-layout-elk\.esm\.min\/render-[A-Z0-9]+\.mjs$/;

type Violation = { blockedURI: string; effectiveDirective: string };
type Rect = { x: number; y: number; width: number; height: number };

// The page asks the archive route whether its reader may archive it; signed
// out, as here, the route answers 401, which the browser logs as the
// network's line. Only that line, for that route, is not an error.
function signedOutArchive(message: ConsoleMessage) {
  return message.text() === 'Failed to load resource: the server responded with a status of 401 (Unauthorized)' &&
    new URL(message.location().url).pathname === '/api/archive';
}

async function watch(page: Page) {
  const errors: string[] = [];
  const elkFiles: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !signedOutArchive(message)) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as any).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  for (const [dir, copy] of Object.entries(COPIES)) {
    await page.route(`${dir}**`, async (route) => {
      if (dir === MERMAID_ELK_DIR) elkFiles.push(route.request().url().slice(dir.length));
      const file = path.join(copy, route.request().url().slice(dir.length));
      if (!file.startsWith(copy + path.sep) || !fs.existsSync(file)) {
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
  }
  return {
    elkFiles,
    async clean() {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__violations as Violation[])).toEqual([]);
    },
  };
}

function diagram(page: Page) {
  return page.locator('pre.mermaid');
}

function box(page: Page, id: string): Locator {
  return diagram(page).locator(`g.node[id^="flowchart-${id}-"]`);
}

function card(page: Page) {
  return page.locator('.artifact-node-card');
}

function overlap(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function drawn(page: Page) {
  const seen = await watch(page);
  await page.goto(`${PAGE}?standalone`);
  await expect(diagram(page).locator('svg')).toBeVisible();
  await expect(box(page, 'B1')).toHaveAttribute('role', 'button');
  return seen;
}

test('a flowchart asking for ELK draws its lanes with no title over another lane\'s box', async ({ page }) => {
  const seen = await drawn(page);
  const svg = diagram(page).locator('svg');
  await expect(svg.locator('g.node')).toHaveCount(Object.values(LANES).flat().length);
  for (const id of Object.values(LANES).flat()) await expect(box(page, id)).toHaveCount(1);
  await expect(svg.locator('g.cluster')).toHaveCount(3);
  expect(seen.elkFiles.filter((file) => ELK_RENDERER.test(file))).toHaveLength(1);

  for (const lane of Object.keys(LANES)) {
    // ELK's clusters carry no id, so each is found by its title.
    const label = svg.locator('g.cluster .cluster-label', { hasText: lane });
    await expect(label).toHaveCount(1);
    const title = (await label.boundingBox())!;
    for (const [other, ids] of Object.entries(LANES)) {
      if (other === lane) continue;
      for (const id of ids) {
        const where = (await box(page, id).boundingBox())!;
        expect(overlap(title, where), `${lane}'s title over ${id}`).toBe(false);
      }
    }
  }
  await seen.clean();
});

test('a box on an ELK diagram opens its node card', async ({ page }) => {
  const seen = await drawn(page);
  await expect(page.locator('#nodes-table')).toBeHidden();
  await box(page, 'B1').click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('h3')).toHaveText('Load the layout');
  await expect(card(page).locator('dl.artifact-node-card-fields dd'))
    .toHaveText(['Register the ELK layout beside Mermaid', 'open']);
  const graph = await card(page).locator('dl.artifact-node-card-graph').evaluate((list) =>
    Array.from(list.querySelectorAll('dt')).map((term) => [
      term.textContent, term.nextElementSibling?.textContent,
    ]));
  expect(graph).toEqual([['Waits for', 'P1 (merged)'], ['Unblocks', 'B2 (open)']]);
  await seen.clean();
});

test('a diagram without the opt-in is drawn even when ELK fails to load', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const mermaid = Object.entries(COPIES).find(([dir]) => dir !== MERMAID_ELK_DIR)!;
  await page.route(`${mermaid[0]}**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: fs.readFileSync(path.join(mermaid[1], route.request().url().slice(mermaid[0].length))),
    });
  });
  await page.route(`${MERMAID_ELK_DIR}**`, (route) => route.abort());
  // The capture fixture's diagram page: one default-layout flowchart, A --> B --> C.
  await page.goto('/capture-diagram.html?standalone');
  await expect(page.locator('pre.mermaid svg')).toHaveCount(1);
  await expect(page.locator('pre.mermaid svg g.node')).toHaveCount(3);
  expect(errors).toEqual([]);
});
