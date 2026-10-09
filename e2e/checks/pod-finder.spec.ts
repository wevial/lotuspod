import { expect, test, type Page } from '@playwright/test';

// The index's pod finder (lotuspod-index.js): Cmd+K on a Mac, Ctrl+K
// elsewhere, the strip's "+" or its "Find a pod" button opens a dialog
// listing every listed pod, filtered by the words typed, the pods this
// reader opened most recently first under "Recent". Enter opens the chosen
// pod in a tab, and Cmd/Ctrl+Enter or a Cmd/Ctrl-click a browser tab.
// Signed in, the checks read as the fixture's second reader, who opens no
// page in any check before these, so "Recent" holds only what they open.
// The fixture's rendered pages, the article and the checklist among them,
// carry no revision stamp, so no script records their opening: the checks
// record it through the seen route, as a stamped page's own script does.
const WIDE = { width: 1280, height: 800 };
test.use({ viewport: WIDE });

const SECOND = process.env.LOTUSPOD_TEST_ASSERTION_SECOND ?? '';
const SEEN = '/api/seen';
const MAC_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const LINUX_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const ARTICLE = { name: 'capture-article', title: 'Capture article' };
const CHECKLIST = { name: 'capture-checklist', title: 'Capture checklist' };
type Pod = { name: string; title: string };

type Violation = { blockedURI: string; effectiveDirective: string };

// Console errors and thrown errors, in the index and in every frame, and
// each document's policy violations, kept on its own window.
async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const seen: { blockedURI: string; effectiveDirective: string }[] = [];
    (window as any).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  return errors;
}

function violations(page: Page, name?: string): Promise<Violation[]> {
  const frame = name === undefined ? page.mainFrame()
    : page.frames().find((each) => new URL(each.url()).pathname === `/${name}.html`);
  if (!frame) throw new Error(`no frame shows ${name}`);
  return frame.evaluate(() => (window as any).__violations as Violation[]);
}

const strip = (page: Page) => page.getByRole('group', { name: 'Open pods' });
const tabs = (page: Page) => strip(page).locator('.pod-tab');
const tabTitle = (page: Page, pod: Pod) => strip(page).locator(`.pod-tab[data-page="${pod.name}"] button.pod-tab-title`);
const frame = (page: Page, pod: Pod) => page.locator(`iframe.pod-frame[title="${pod.title}"]`);
const framed = (page: Page, pod: Pod) => page.frameLocator(`iframe.pod-frame[title="${pod.title}"]`);
const listingLink = (page: Page, pod: Pod) =>
  page.locator(`.index-table tbody tr[data-page="${pod.name}"] td.episode-title > a`);
const home = (page: Page) => page.locator('.pod-tabs-bar').getByRole('button', { name: 'Lotuspod', exact: true });

const finder = (page: Page) => page.getByRole('dialog', { name: 'Find a pod' });
const input = (page: Page) => finder(page).getByRole('combobox');
const listbox = (page: Page) => finder(page).getByRole('listbox');
const options = (page: Page) => finder(page).getByRole('option');
const optionFor = (page: Page, pod: Pod) => finder(page).locator(`[role="option"][data-page="${pod.name}"]`);
const headings = (page: Page) => finder(page).locator('.pod-finder-heading');
const backdrop = (page: Page) => page.locator('.pod-finder-backdrop');

function openNames(page: Page): Promise<string[]> {
  return tabs(page).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.page ?? ''));
}

function optionTitles(page: Page): Promise<string[]> {
  return options(page).locator('.pod-finder-title').allTextContents();
}

function optionNames(page: Page): Promise<string[]> {
  return options(page).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.page ?? ''));
}

// The listing's pods in its order, newest update first, as {name, title}.
function listed(page: Page): Promise<Pod[]> {
  return page.locator('.index-table tbody tr[data-page]').evaluateAll((rows) => rows.map((row) => ({
    name: (row as HTMLElement).dataset.page ?? '',
    title: (row as HTMLTableRowElement).cells[0].querySelector('a')?.textContent?.trim() ?? '',
  })));
}

// The Pages view of the index, its finder answered once.
async function openIndex(page: Page, address = '/#pages') {
  await page.goto(address);
  await expect(strip(page)).toHaveCount(1);
}

// Open a pod from its listing row with a plain click, its page loaded in its
// frame.
async function openFromListing(page: Page, pod: Pod) {
  if (await page.locator('main.index').isHidden()) await home(page).click();
  await listingLink(page, pod).click();
  await expect(tabTitle(page, pod)).toHaveAttribute('aria-current', 'page');
  await expect(framed(page, pod).locator('h1')).toHaveText(pod.title);
}

// Record that the reader opened an unstamped pod, as a stamped page's
// script records itself on load.
async function recordOpened(page: Page, pod: Pod) {
  const response = await page.request.post(SEEN, { data: { page: pod.name, revision: 'unstamped' } });
  expect(response.status(), await response.text()).toBe(200);
}

// Open the finder with the key, from wherever focus is, once it has drawn
// its options.
async function find(page: Page) {
  await page.keyboard.press('ControlOrMeta+K');
  await expect(finder(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expect(options(page).first()).toBeVisible();
}

// The option selected, by aria-selected and by the input's active descendant.
async function selectedName(page: Page) {
  const selected = finder(page).locator('[role="option"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  const id = await selected.getAttribute('id');
  await expect(input(page)).toHaveAttribute('aria-activedescendant', id ?? '');
  return (await selected.getAttribute('data-page')) ?? '';
}

// Whether the browser kept the key: each keydown's defaultPrevented once it
// has reached the window, in the index and in each framed page.
async function recordKeys(page: Page) {
  await page.addInitScript(() => {
    const kept: boolean[] = [];
    (window as any).__keys = kept;
    window.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'k') kept.push(event.defaultPrevented);
    });
  });
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': SECOND } });

  test.beforeEach(() => {
    expect(SECOND, 'the capture fixture names LOTUSPOD_TEST_ASSERTION_SECOND').toBeTruthy();
  });

  test('the key opens the finder on the pods opened most recently, then the rest in the listing\'s order', async ({ page }) => {
    const errors = await watch(page);
    await recordKeys(page);
    await openIndex(page);
    await openFromListing(page, CHECKLIST);
    await recordOpened(page, CHECKLIST);
    await openFromListing(page, ARTICLE);
    await recordOpened(page, ARTICLE);
    const pods = await listed(page);
    const others = pods.filter((pod) => pod.name !== ARTICLE.name && pod.name !== CHECKLIST.name);
    expect(others.length).toBeGreaterThan(2);

    await find(page);
    expect(await page.evaluate(() => (window as any).__keys)).toEqual([true]);
    await expect(finder(page)).toHaveAttribute('aria-modal', 'true');
    await expect(headings(page)).toHaveText(['Recent', 'Other pods']);
    const groups = finder(page).getByRole('group');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).locator('.pod-finder-title')).toHaveText([ARTICLE.title, CHECKLIST.title]);
    await expect(groups.nth(1).locator('.pod-finder-title')).toHaveText(others.map((pod) => pod.title));
    // The headings come before their options.
    const order = await listbox(page).locator('.pod-finder-heading, .pod-finder-title').allTextContents();
    expect(order).toEqual(['Recent', ARTICLE.title, CHECKLIST.title, 'Other pods',
      ...others.map((pod) => pod.title)]);
    await expect(input(page)).toHaveAttribute('aria-controls', (await listbox(page).getAttribute('id')) ?? '');
    expect(await selectedName(page)).toBe(ARTICLE.name);
    await expect(optionFor(page, ARTICLE).locator('.pod-finder-open')).toHaveText('in a tab');
    await expect(optionFor(page, CHECKLIST).locator('.pod-finder-open')).toHaveText('in a tab');
    await expect(optionFor(page, others[0]).locator('.pod-finder-open')).toHaveCount(0);
    await expect(optionFor(page, ARTICLE).locator('.pod-finder-updated')).toHaveText(/^updated \d{4}-\d{2}-\d{2}$/);

    // Tab stays in the input; the key again closes the finder.
    await page.keyboard.press('Tab');
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('ControlOrMeta+K');
    await expect(finder(page)).toBeHidden();

    expect(await violations(page)).toEqual([]);
    expect(await violations(page, ARTICLE.name)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('↓ twice and Enter opens the third option in a tab, its button focused; ↑ on the first wraps to the last', async ({ page }) => {
    const errors = await watch(page);
    await openIndex(page);
    await find(page);
    const names = await optionNames(page);
    expect(names.length).toBeGreaterThan(3);
    expect(await selectedName(page)).toBe(names[0]);

    await page.keyboard.press('ArrowUp');
    expect(await selectedName(page)).toBe(names[names.length - 1]);
    await page.keyboard.press('ArrowDown');
    expect(await selectedName(page)).toBe(names[0]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await selectedName(page)).toBe(names[2]);
    const third = (await listed(page)).find((pod) => pod.name === names[2]) as Pod;

    await page.keyboard.press('Enter');
    await expect(finder(page)).toBeHidden();
    await expect(tabTitle(page, third)).toHaveAttribute('aria-current', 'page');
    await expect(frame(page, third)).toBeVisible();
    await expect(framed(page, third).locator('h1')).toHaveText(third.title);
    await expect(tabTitle(page, third)).toBeFocused();

    // The first of the other pods, newest update first, is a published one,
    // stamped: it records its own opening, and next time it comes first.
    await expect(framed(page, third).locator('meta[name="lotuspod:revision"]')).toHaveCount(1);
    await expect.poll(async () => {
      const answer = await page.request.get(SEEN);
      return typeof (await answer.json()).pages?.[third.name]?.seenAt;
    }).toBe('string');
    await find(page);
    await expect(headings(page).first()).toHaveText('Recent');
    expect((await optionNames(page))[0]).toBe(third.name);
    await expect(optionFor(page, third).locator('.pod-finder-open')).toHaveText('in a tab');
    expect(errors).toEqual([]);
  });

  test('typing keeps the pods whose title, labels and summary hold every word', async ({ page }) => {
    const errors = await watch(page);
    await openIndex(page);
    await find(page);

    await input(page).fill('capture tables');
    expect((await optionTitles(page)).sort()).toEqual(['Capture tables', 'Capture tables report']);
    expect(await selectedName(page)).toBe((await optionNames(page))[0]);

    // By label alone: neither title says relos.
    await input(page).fill('');
    await input(page).pressSequentially('relos');
    expect((await optionTitles(page)).sort()).toEqual(['Capture owned page', 'Capture passages']);
    await expect(optionFor(page, { name: 'capture-passages', title: '' }).locator('.index-tag'))
      .toHaveText(['croton', 'relos']);

    await input(page).fill('zzz');
    await expect(options(page)).toHaveCount(0);
    await expect(finder(page).locator('.pod-finder-empty')).toHaveText('No pod matches “zzz”.');
    await expect(finder(page).locator('.pod-finder-empty')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(finder(page)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Cmd/Ctrl+Enter and a Cmd/Ctrl-click open a browser tab, the strip unchanged', async ({ page, context }) => {
    const errors = await watch(page);
    await openIndex(page);
    await openFromListing(page, ARTICLE);
    const before = await openNames(page);

    await find(page);
    await input(page).fill('capture checklist');
    await expect(options(page)).toHaveCount(1);
    let opened = context.waitForEvent('page');
    await page.keyboard.press('ControlOrMeta+Enter');
    let other = await opened;
    await other.waitForLoadState();
    expect(new URL(other.url()).pathname).toBe(`/${CHECKLIST.name}.html`);
    await other.close();
    await expect(finder(page)).toBeHidden();
    expect(await openNames(page)).toEqual(before);
    await expect(tabTitle(page, ARTICLE)).toHaveAttribute('aria-current', 'page');

    const pod = (await listed(page)).find((each) => !before.includes(each.name)) as Pod;
    await find(page);
    opened = context.waitForEvent('page');
    await optionFor(page, pod).click({ modifiers: ['ControlOrMeta'] });
    other = await opened;
    await other.waitForLoadState();
    expect(new URL(other.url()).pathname).toBe(`/${pod.name}.html`);
    await other.close();
    expect(await openNames(page)).toEqual(before);

    // A plain click opens it in a tab.
    await find(page);
    await optionFor(page, pod).click();
    await expect(finder(page)).toBeHidden();
    await expect(tabTitle(page, pod)).toHaveAttribute('aria-current', 'page');
    await expect(tabTitle(page, pod)).toBeFocused();
    expect(await openNames(page)).toEqual([...before, pod.name]);
    expect(errors).toEqual([]);
  });

  test('the key in a framed pod opens the finder, the pod "in a tab", and Esc gives focus back to the frame', async ({ page }) => {
    const errors = await watch(page);
    await recordKeys(page);
    await openIndex(page);
    await openFromListing(page, ARTICLE);
    await expect.poll(() => frame(page, ARTICLE).evaluate((node) =>
      (node as HTMLIFrameElement).contentDocument?.readyState)).toBe('complete');
    const inside = framed(page, ARTICLE).locator('a.artifact-topbar-brand');
    await inside.focus();
    await expect(inside).toBeFocused();

    await find(page);
    const kept = await frame(page, ARTICLE).evaluate((node) =>
      ((node as HTMLIFrameElement).contentWindow as any).__keys);
    expect(kept).toEqual([true]);
    await expect(optionFor(page, ARTICLE).locator('.pod-finder-open')).toHaveText('in a tab');

    await page.keyboard.press('Escape');
    await expect(finder(page)).toBeHidden();
    await expect(inside).toBeFocused();
    expect(await frame(page, ARTICLE).evaluate((node) => document.activeElement === node)).toBe(true);
    expect(await violations(page, ARTICLE.name)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('"+" and "Find a pod" open the finder and a click on the backdrop closes it', async ({ page }) => {
    const errors = await watch(page);
    await openIndex(page);
    await openFromListing(page, ARTICLE);
    const plus = strip(page).getByRole('button', { name: 'Open a pod in a new tab' });
    await expect(plus).toHaveText('+');
    // The "+" follows the last tab.
    expect(await strip(page).locator('> *').last().getAttribute('class')).toBe('pod-tabs-new');

    await plus.click();
    await expect(finder(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await backdrop(page).click({ position: { x: 10, y: 10 } });
    await expect(finder(page)).toBeHidden();
    await expect(plus).toBeFocused();

    const button = page.locator('.pod-tabs-bar').getByRole('button', { name: 'Find a pod' });
    await expect(button.locator('kbd')).toHaveText('Ctrl K');
    await button.click();
    await expect(finder(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    // A click within the dialog leaves it open.
    await finder(page).locator('.pod-finder-hint').click();
    await expect(finder(page)).toBeVisible();
    await backdrop(page).click({ position: { x: 10, y: 790 } });
    await expect(finder(page)).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test.describe('the key the button shows', () => {
  test.describe('on a Mac', () => {
    test.use({ userAgent: MAC_AGENT });

    test('reads ⌘K, and Cmd+K opens the finder', async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
      });
      await openIndex(page, '/');
      const button = page.locator('.pod-tabs-bar').getByRole('button', { name: 'Find a pod' });
      await expect(button.locator('kbd')).toHaveText('⌘K');
      await page.keyboard.press('Meta+K');
      await expect(finder(page)).toBeVisible();
      await page.keyboard.press('Meta+K');
      await expect(finder(page)).toBeHidden();
    });
  });

  test.describe('on Linux', () => {
    test.use({ userAgent: LINUX_AGENT });

    test('reads Ctrl K', async ({ page }) => {
      await openIndex(page, '/');
      const button = page.locator('.pod-tabs-bar').getByRole('button', { name: 'Find a pod' });
      await expect(button.locator('kbd')).toHaveText('Ctrl K');
    });
  });
});

test.describe('signed out', () => {
  test('the finder lists every listed pod in the listing\'s order, under no heading', async ({ page }) => {
    const errors = await watch(page);
    await openIndex(page, '/');
    await openFromListing(page, ARTICLE);
    const pods = await listed(page);
    await find(page);
    await expect(options(page).locator('.pod-finder-title')).toHaveText(pods.map((pod) => pod.title));
    await expect(headings(page)).toHaveCount(0);
    await expect(finder(page).getByRole('group')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(finder(page)).toBeHidden();
    // The signed-out answers are the seen route's 401s, which the console
    // reports as failed loads.
    expect(errors.filter((error) => !/401/.test(error))).toEqual([]);
  });
});
