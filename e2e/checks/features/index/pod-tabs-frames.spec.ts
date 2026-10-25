import { expect, test, type Page } from '@playwright/test';

// A pod's frame is the one it was opened in for as long as its tab is open: a
// move of its tab, by key or by drag, reorders the tabs alone, and an iframe
// moved in the document would load its page again.
test.use({ viewport: { width: 1280, height: 800 } });

const ARTICLE = { name: 'capture-article', title: 'Capture article' };
const CHECKLIST = { name: 'capture-checklist', title: 'Capture checklist' };
type Pod = { name: string; title: string };

const strip = (page: Page) => page.getByRole('group', { name: 'Open pods' });
const tab = (page: Page, pod: Pod) => strip(page).locator(`.pod-tab[data-page="${pod.name}"]`);
const tabTitle = (page: Page, pod: Pod) => tab(page, pod).locator('button.pod-tab-title');
const frame = (page: Page, pod: Pod) => page.locator(`iframe.pod-frame[title="${pod.title}"]`);
const framed = (page: Page, pod: Pod) => page.frameLocator(`iframe.pod-frame[title="${pod.title}"]`);

function openNames(page: Page): Promise<string[]> {
  return strip(page).locator('.pod-tab').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.page ?? ''));
}

async function expectActive(page: Page, pod: Pod) {
  await expect(tabTitle(page, pod)).toHaveAttribute('aria-current', 'page');
  await expect(frame(page, pod)).toBeVisible();
}

// What the pod's frame still holds of what was set on it.
function kept(page: Page, pod: Pod) {
  return frame(page, pod).evaluate((node) => ({
    attribute: node.hasAttribute('data-kept'),
    marker: ((node as HTMLIFrameElement).contentWindow as (Window & { kept?: string }) | null)?.kept ?? null,
  }));
}

test('a tab moved by key and back by drag, then activated, keeps its frame and the page in it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/#tabs=${ARTICLE.name},${CHECKLIST.name}&on=${CHECKLIST.name}`);
  await expectActive(page, CHECKLIST);
  for (const pod of [ARTICLE, CHECKLIST]) await expect(framed(page, pod).locator('h1')).toHaveText(pod.title);
  // Both frames marked: a reorder may move either node, whichever tab moved.
  for (const pod of [ARTICLE, CHECKLIST]) {
    await expect.poll(() => frame(page, pod).evaluate((node) =>
      (node as HTMLIFrameElement).contentDocument?.readyState)).toBe('complete');
    await frame(page, pod).evaluate((node) => {
      node.setAttribute('data-kept', '');
      ((node as HTMLIFrameElement).contentWindow as Window & { kept?: string }).kept = 'first load';
    });
  }
  // A browser with moveBefore() keeps a moved frame's page, so a frame put
  // anywhere again in the document is counted too.
  await page.evaluate(() => {
    const box = document.querySelector('.pod-tabs-frames') as HTMLElement & { placed?: number };
    box.placed = 0;
    new MutationObserver((records) => {
      for (const record of records) box.placed! += record.addedNodes.length;
    }).observe(box, { childList: true });
  });

  // One place right by key.
  await tabTitle(page, ARTICLE).focus();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect.poll(() => openNames(page)).toEqual([CHECKLIST.name, ARTICLE.name]);

  // Back by a mouse drag onto the other tab's left half.
  const from = (await tabTitle(page, ARTICLE).boundingBox())!;
  const onto = (await tab(page, CHECKLIST).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(onto.x + onto.width / 4, onto.y + onto.height / 2, { steps: 12 });
  await expect(tab(page, ARTICLE)).toHaveClass(/pod-tab--dragging/);
  await page.mouse.up();
  await expect.poll(() => openNames(page)).toEqual([ARTICLE.name, CHECKLIST.name]);

  await tabTitle(page, CHECKLIST).click();
  await expectActive(page, CHECKLIST);
  await tabTitle(page, ARTICLE).click();
  await expectActive(page, ARTICLE);
  await expect(framed(page, ARTICLE).locator('h1')).toHaveText(ARTICLE.title);
  for (const pod of [ARTICLE, CHECKLIST]) {
    expect(await kept(page, pod), pod.name).toEqual({ attribute: true, marker: 'first load' });
  }
  expect(await page.evaluate(() =>
    (document.querySelector('.pod-tabs-frames') as HTMLElement & { placed?: number }).placed)).toBe(0);
  expect(errors).toEqual([]);
});
