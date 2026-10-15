import { expect, test, type Page } from '@playwright/test';

// The capture fixture's calltree page (tests/capture_site.py): its first
// section holds a fence linked to GitHub, its second an unlinked fence with
// one line that doesn't parse.
const URL = '/capture-calltree.html?standalone';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': process.env.LOTUSPOD_TEST_ASSERTION ?? '' };
test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: SIGNED_IN });

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
  return {
    async clean() {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__violations as Violation[])).toEqual([]);
    },
  };
}

test('scripts load without console errors or CSP violations', async ({ page }) => {
  const seen = await watch(page);
  await page.goto(URL);
  await expect(page.locator('.calltree').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await seen.clean();
});

const NAMES = ['cmd_publish()', 'publish_config()', 'to_body()', '_walk()', '_convert()',
  'render()', 'parse_line()', 'source_url()', '_inline()', 'cmd_render()'];
const PARENTS = ['cmd_publish()', 'to_body()', '_walk()', '_convert()', 'render()'];

function rowOf(page: Page, name: string) {
  return page.locator('.calltree').first().locator('.calltree-row')
    .filter({ has: page.locator('.calltree-name', { hasText: name }) }).first();
}

async function visibleNames(page: Page) {
  return page.locator('.calltree').first().locator('.calltree-row:visible .calltree-name').allTextContents();
}

test.describe('folding', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL);
    await expect(page.locator('.calltree').first().locator('.calltree-caret')).toHaveCount(5);
  });

  test('each parent row has a caret, open, and every row shows', async ({ page }) => {
    const tree = page.locator('.calltree').first();
    for (const name of NAMES) {
      const caret = rowOf(page, name).locator('.calltree-caret');
      if (PARENTS.includes(name)) {
        await expect(caret).toHaveAccessibleName(`Fold ${name}`);
        await expect(caret).toHaveAttribute('aria-expanded', 'true');
        await expect(caret).toHaveAttribute('type', 'button');
      } else {
        await expect(caret).toHaveCount(0);
        await expect(rowOf(page, name).locator('.calltree-leaf')).toHaveCount(1);
      }
    }
    expect(await visibleNames(page)).toEqual(NAMES);
    await expect(tree.locator('.calltree-folded:visible')).toHaveCount(0);
    // Carets and spacers are as wide, so names stay in line.
    const caret = (await rowOf(page, '_walk()').locator('.calltree-caret').boundingBox())!;
    const leaf = (await rowOf(page, 'publish_config()').locator('.calltree-leaf').boundingBox())!;
    expect(Math.abs(caret.width - leaf.width)).toBeLessThan(0.5);
    // The second block's text row is no parent and not counted.
    await expect(page.locator('.calltree').nth(1).locator('.calltree-caret')).toHaveCount(1);
    await expect(page.locator('.calltree').nth(1).locator('.calltree-fold-all')).toHaveCount(0);
  });

  test('a caret folds and opens its row, by click and by Enter', async ({ page }) => {
    const walk = page.getByRole('button', { name: 'Fold _walk()' });
    await walk.click();
    expect(await visibleNames(page)).toEqual(['cmd_publish()', 'publish_config()', 'to_body()', '_walk()', 'cmd_render()']);
    await expect(rowOf(page, '_walk()').locator('.calltree-folded')).toBeVisible();
    await expect(rowOf(page, '_walk()').locator('.calltree-folded')).toHaveText('5 inside · 1 changed · 3 new');
    const open = rowOf(page, '_walk()').locator('.calltree-caret');
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await expect(open).toHaveAccessibleName('Open _walk()');
    await open.click();
    expect(await visibleNames(page)).toEqual(NAMES);
    await expect(rowOf(page, '_walk()').locator('.calltree-folded')).toBeHidden();
    await expect(open).toHaveAccessibleName('Fold _walk()');

    const convert = rowOf(page, '_convert()').locator('.calltree-caret');
    await convert.focus();
    await page.keyboard.press('Enter');
    await expect(convert).toHaveAttribute('aria-expanded', 'false');
    await expect(convert).toHaveAccessibleName('Open _convert()');
    expect(await visibleNames(page)).toEqual(['cmd_publish()', 'publish_config()', 'to_body()', '_walk()', '_convert()', 'cmd_render()']);
    await expect(rowOf(page, '_convert()').locator('.calltree-folded')).toHaveText('4 inside · 3 new');
  });

  test('opening a row keeps a folded descendant folded', async ({ page }) => {
    await page.getByRole('button', { name: 'Fold render()' }).click();
    await page.getByRole('button', { name: 'Fold _walk()' }).click();
    await page.getByRole('button', { name: 'Open _walk()' }).click();
    for (const name of ['_convert()', 'render()', '_inline()']) await expect(rowOf(page, name)).toBeVisible();
    for (const name of ['parse_line()', 'source_url()']) await expect(rowOf(page, name)).toBeHidden();
    await expect(rowOf(page, 'render()').locator('.calltree-folded')).toHaveText('2 inside · 2 new');
  });

  test('Fold all folds every level under the roots, and Open all opens them', async ({ page }) => {
    const all = page.locator('.calltree').first().locator('.calltree-head .calltree-fold-all');
    await expect(all).toHaveText('Fold all');
    await all.click();
    expect(await visibleNames(page)).toEqual(['cmd_publish()', 'publish_config()', 'to_body()', 'cmd_render()']);
    await expect(rowOf(page, 'to_body()').locator('.calltree-folded')).toHaveText('6 inside · 1 changed · 3 new');
    await expect(rowOf(page, 'cmd_publish()').locator('.calltree-caret')).toHaveAttribute('aria-expanded', 'true');
    await expect(all).toHaveText('Open all');
    await all.click();
    expect(await visibleNames(page)).toEqual(NAMES);
    await expect(page.locator('.calltree').first().locator('.calltree-folded:visible')).toHaveCount(0);
    await expect(all).toHaveText('Fold all');
  });

  test('a focused caret and Fold all show a lavender ring', async ({ page }) => {
    for (const control of [rowOf(page, '_walk()').locator('.calltree-caret'),
      page.locator('.calltree').first().locator('.calltree-fold-all')]) {
      await control.focus();
      await expect(control).toHaveCSS('outline-style', 'solid');
      await expect(control).toHaveCSS('outline-color', 'rgb(183, 156, 244)');
    }
  });

  test('a tree a page swap brings in folds too', async ({ page }) => {
    await page.evaluate(async () => {
      const fresh = new DOMParser().parseFromString(await (await fetch(location.href)).text(), 'text/html');
      document.querySelector('.calltree')!.replaceWith(document.adoptNode(fresh.querySelector('.calltree')!));
      document.dispatchEvent(new CustomEvent('lotuspod:swapped', { detail: { revision: '', units: [] } }));
    });
    const tree = page.locator('.calltree').first();
    await expect(tree.locator('.calltree-caret')).toHaveCount(5);
    await expect(tree.locator('.calltree-fold-all')).toHaveCount(1);
    await expect(page.locator('.calltree').nth(1).locator('.calltree-caret')).toHaveCount(1);
    await page.getByRole('button', { name: 'Fold _walk()' }).click();
    await expect(rowOf(page, '_walk()').locator('.calltree-folded')).toHaveText('5 inside · 1 changed · 3 new');
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('all rows, marker colors and chips render statically', async ({ page }) => {
    await page.goto(URL);
    const tree = page.locator('.calltree').first();
    await expect(tree.locator('.calltree-row')).toHaveCount(10);
    await expect(tree.locator('.calltree-row:visible')).toHaveCount(10);
    await expect(page.locator('.calltree-caret, .calltree-fold-all')).toHaveCount(0);
    await expect(tree.locator('.calltree-summary')).toHaveText('3 changed · 3 new · across 3 files');
    await expect(tree.locator('[data-kind="new"] .calltree-mark').first()).toHaveCSS('color', 'rgb(146, 217, 181)');
    await expect(tree.locator('[data-kind="changed"] .calltree-mark').first()).toHaveCSS('color', 'rgb(235, 197, 127)');
    await expect(tree.locator('[data-kind="context"] .calltree-name').first()).toHaveCSS('color', 'rgb(148, 138, 173)');
    await expect(tree.locator('[data-kind="context"] .calltree-chip').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const backgrounds = await Promise.all(['new', 'changed'].map(kind => tree.locator(`[data-kind="${kind}"] .calltree-chip`).first().evaluate(node => getComputedStyle(node).backgroundColor)));
    expect(backgrounds[0]).not.toBe(backgrounds[1]);
    for (const color of backgrounds) expect(color).not.toBe('rgba(0, 0, 0, 0)');
    await expect(page.locator('.calltree').nth(1).locator('a')).toHaveCount(0);
    await expect(page.locator('.calltree').nth(1).locator('[data-kind="text"]')).toHaveText('   <unparsed & "text">');
  });

  test('at 390px only the tree scrolls and the summary stays visible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL);
    const tree = page.locator('.calltree').first();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const scroll = await tree.evaluate(node => {
      const overflow = node.scrollWidth > node.clientWidth;
      node.scrollLeft = 120;
      return { overflow, left: node.scrollLeft };
    });
    expect(scroll.overflow).toBe(true);
    expect(scroll.left).toBeGreaterThan(0);
    const box = (await tree.boundingBox())!;
    const summary = (await tree.locator('.calltree-summary').boundingBox())!;
    expect(summary.x).toBeGreaterThanOrEqual(box.x);
    expect(summary.x + summary.width).toBeLessThanOrEqual(box.x + box.width);
  });
});
