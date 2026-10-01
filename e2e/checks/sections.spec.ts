import { expect, test, type Page } from '@playwright/test';

// The capture fixture's sections page: an intro, then three sections, each
// folding under its heading. The first holds a word no other does and a code
// block, the second asks one question, and each ends in a comment box. The
// fixture names an assertion its site accepts; sending it is being signed in,
// so the page's reads of answers and threads are answered.
const PAGE = '/capture-sections.html';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const IDS = ['findings', 'decisions-for-the-maintainer', 'next-steps'];
const TITLES = ['Findings', 'Decisions for the maintainer', 'Next steps'];

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
    errors,
    violations: () => page.evaluate(() => (window as any).__violations as Violation[]),
    async clean() {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__violations as Violation[])).toEqual([]);
    },
  };
}

function section(page: Page, index: number) {
  const id = IDS[index];
  const heading = page.locator(`h2#${id}`);
  const wrapper = page.locator(`div.artifact-section-body[data-section="${id}"]`);
  return {
    heading,
    wrapper,
    button: heading.getByRole('button', { name: TITLES[index], exact: true }),
    paragraph: wrapper.locator(':scope > p').first(),
    box: wrapper.locator('details.artifact-comment'),
  };
}

function all(page: Page) {
  return page.locator('nav.artifact-outline button.artifact-sections-all');
}

async function folded(page: Page) {
  return page.locator('div.artifact-section-body').evaluateAll((wrappers) =>
    wrappers.map((wrapper) => wrapper.getAttribute('hidden') === 'until-found'));
}

async function fold(page: Page, index: number) {
  const { button, wrapper } = section(page, index);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(wrapper).toHaveAttribute('hidden', 'until-found');
}

async function expectOpen(page: Page, index: number) {
  const { button, wrapper, paragraph } = section(page, index);
  await expect(wrapper).not.toHaveAttribute('hidden');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(paragraph).toBeVisible();
}

async function wide(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('a heading button folds its section and opens it again', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const second = section(page, 1);
    const form = second.wrapper.locator('form.artifact-decision');
    for (const part of [second.paragraph, form, second.box]) await expect(part).toBeVisible();
    await expect(second.button).toHaveAttribute('aria-expanded', 'true');

    await second.button.click();
    await expect(page.getByRole('heading', { level: 2, name: 'Decisions for the maintainer' })).toBeVisible();
    await expect(second.heading).toBeVisible();
    for (const part of [second.paragraph, form, second.box]) await expect(part).toBeHidden();
    await expect(second.wrapper).toHaveAttribute('hidden', 'until-found');
    expect(await second.button.evaluate((node) => node.tagName)).toBe('BUTTON');
    await expect(second.button).toHaveAttribute('type', 'button');
    await expect(second.button).toHaveAccessibleName('Decisions for the maintainer');
    await expect(second.button).toHaveAttribute('aria-expanded', 'false');
    const id = await second.wrapper.getAttribute('id');
    expect(id).toBeTruthy();
    await expect(second.button).toHaveAttribute('aria-controls', id!);
    // The other sections stay as they were.
    await expectOpen(page, 0);
    await expectOpen(page, 2);

    await second.button.click();
    for (const part of [second.paragraph, form, second.box]) await expect(part).toBeVisible();
    await expect(second.button).toHaveAttribute('aria-expanded', 'true');
    await expect(second.wrapper).not.toHaveAttribute('hidden');
    await seen.clean();
  });

  test('the keyboard reaches the first heading button and folds and opens it', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const first = section(page, 0);
    await page.locator('.artifact-outline-list a').last().focus();
    let reached = false;
    for (let presses = 0; presses < 2 && !reached; presses += 1) {
      await page.keyboard.press('Tab');
      reached = await first.button.evaluate((node) => node === document.activeElement);
    }
    expect(reached).toBe(true);
    const ring = await first.button.evaluate((node) => {
      const style = getComputedStyle(node);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(1);

    await page.keyboard.press('Enter');
    await expect(first.button).toHaveAttribute('aria-expanded', 'false');
    await expect(first.paragraph).toBeHidden();
    await page.keyboard.press('Space');
    await expect(first.button).toHaveAttribute('aria-expanded', 'true');
    await expect(first.paragraph).toBeVisible();
    await seen.clean();
  });

  test('the page remembers what the reader folded across a reload', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    await fold(page, 0);
    await fold(page, 2);
    await page.reload();
    await expect(section(page, 0).button).toHaveAttribute('aria-expanded', 'false');
    await expect(section(page, 2).button).toHaveAttribute('aria-expanded', 'false');
    expect(await folded(page)).toEqual([true, false, true]);
    await expect(section(page, 0).paragraph).toBeHidden();
    await expectOpen(page, 1);
    await seen.clean();
  });

  test('a page whose storage throws renders open and still folds', async ({ page }) => {
    const seen = await watch(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('The page may keep nothing.', 'SecurityError'); },
      });
    });
    await page.goto(PAGE);
    expect(await page.evaluate(() => {
      try { return typeof window.localStorage; } catch (error) { return 'throws'; }
    })).toBe('throws');
    for (let index = 0; index < IDS.length; index += 1) await expectOpen(page, index);
    await fold(page, 0);
    await expect(section(page, 0).paragraph).toBeHidden();
    await seen.clean();
  });

  test('a text fragment in a folded section opens it and it stays open', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    await fold(page, 0);
    await page.goto('about:blank');
    await page.goto(`${PAGE}#:~:text=frazil`);
    const first = section(page, 0);
    // Chromium may not drive a text fragment for an automated navigation:
    // then the event it would fire is dispatched on the wrapper instead.
    const opened = await expect(first.wrapper).not.toHaveAttribute('hidden', { timeout: 2000 })
      .then(() => true, () => false);
    if (!opened) {
      await first.wrapper.evaluate((node) => node.dispatchEvent(new Event('beforematch')));
    }
    await expectOpen(page, 0);
    await page.goto(PAGE);
    await expectOpen(page, 0);
    await seen.clean();
  });

  test('a beforematch event on a folded section opens it', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    await fold(page, 0);
    await section(page, 0).wrapper.evaluate((node) => node.dispatchEvent(new Event('beforematch')));
    await expectOpen(page, 0);
    await page.reload();
    await expectOpen(page, 0);
    await seen.clean();
  });

  test('an outline link or a URL fragment opens a folded section and shows its heading', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    await fold(page, 2);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.artifact-outline-list a[href="#next-steps"]').click();
    await expectOpen(page, 2);
    await expect(section(page, 2).heading).toBeInViewport();

    await fold(page, 1);
    await page.goto('about:blank');
    await page.goto(`${PAGE}#decisions-for-the-maintainer`);
    await expectOpen(page, 1);
    await expect(section(page, 1).heading).toBeInViewport();
    await seen.clean();
  });

  test('one control folds every section and opens them all again', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const control = all(page);
    await expect(control).toHaveText('Collapse all');
    // Outside the outline's disclosure.
    expect(await control.evaluate((node) => node.closest('details'))).toBeNull();
    await control.click();
    expect(await folded(page)).toEqual([true, true, true]);
    await expect(control).toHaveText('Expand all');
    await control.click();
    expect(await folded(page)).toEqual([false, false, false]);
    await expect(control).toHaveText('Collapse all');
    // One section open is enough to offer folding them all.
    await fold(page, 0);
    await fold(page, 1);
    await expect(control).toHaveText('Collapse all');
    await fold(page, 2);
    await expect(control).toHaveText('Expand all');
    await seen.clean();
  });

  test('at 360 pixels wide the page never scrolls sideways, open or folded', async ({ page }) => {
    const seen = await watch(page);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(PAGE);
    await expect(all(page)).toBeVisible();
    expect(await wide(page)).toBe(false);
    await all(page).click();
    expect(await folded(page)).toEqual([true, true, true]);
    expect(await wide(page)).toBe(false);
    await seen.clean();
  });

  test('at 1280 pixels wide the code block steps out of the reading column', async ({ page }) => {
    const seen = await watch(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(PAGE);
    const first = section(page, 0);
    const code = first.wrapper.locator(':scope > pre');
    const [codeWidth, proseWidth] = await Promise.all([
      code.evaluate((node) => node.getBoundingClientRect().width),
      first.paragraph.evaluate((node) => node.getBoundingClientRect().width),
    ]);
    expect(codeWidth).toBeGreaterThan(proseWidth);
    await seen.clean();
  });

  test('in print every section is open and nothing that folds is drawn', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    await fold(page, 0);
    await page.emulateMedia({ media: 'print' });
    await expect(section(page, 0).paragraph).toBeVisible();
    for (let index = 0; index < IDS.length; index += 1) {
      const caret = await section(page, index).button.evaluate((node) =>
        getComputedStyle(node, '::before').display);
      expect(caret).toBe('none');
    }
    await expect(all(page)).toBeHidden();
    await seen.clean();
  });
});

test.describe('without scripts', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, javaScriptEnabled: false });

  test('every section shows and no heading holds a button', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    for (let index = 0; index < IDS.length; index += 1) {
      const { heading, wrapper, paragraph } = section(page, index);
      await expect(heading).toBeVisible();
      await expect(wrapper).not.toHaveAttribute('hidden');
      await expect(paragraph).toBeVisible();
      await expect(heading.locator('button')).toHaveCount(0);
    }
    await expect(all(page)).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });
});
