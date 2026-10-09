import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, request as requests, test, type Page, type Response } from '@playwright/test';

// The index opens pods in tabs (lotuspod-index.js): a plain click on a link
// to a pod, in the listing or in a pod already open, opens it in a tab of the
// strip above the listing, each tab the pod's own page in an iframe. A tab
// not active shows an amber dot once its pod is published again, else an
// orchid one once someone else comments on it, read from the seen route. The
// dot checks publish pages of their own with a real `lotuspod publish`, as
// seen.spec.ts does, and comment on them as the fixture's second reader.
const WIDE = { width: 1280, height: 800 };
test.use({ viewport: WIDE });

const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SECOND = ENV.LOTUSPOD_TEST_ASSERTION_SECOND ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const SEEN = '/api/seen';
const TOKENS = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'lotuspod', '_theme', 'tokens.json'), 'utf-8'));
const COLORS: Record<string, string> = TOKENS.colors;

const ARTICLE = { name: 'capture-article', title: 'Capture article' };
const CONTEXT = { name: 'capture-decision-context', title: 'Capture decision context' };
const CHECKLIST = { name: 'capture-checklist', title: 'Capture checklist' };
type Pod = { name: string; title: string };

// A token as Chromium reports a computed colour.
function rgb(token: string) {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(token);
  if (!hex) return token;
  const [r, g, b] = hex.slice(1).map((pair) => parseInt(pair, 16));
  return `rgb(${r}, ${g}, ${b})`;
}

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

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// A page's markdown, the edition named in its text: two sections, so each
// ends in a comment box.
function source(title: string, edition: string) {
  return [`# ${title}`, '', `Edition: ${edition}.`, '', '## Findings', '',
    'The pond freezes in January, and the pump stops with it.', '', '## Next steps', '',
    'Order a heater before the frost.', ''].join('\n');
}

// hermes publishes markdown as the page name; the revision it is now at.
function publish(name: string, markdown: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-pod-tabs-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', 'hermes',
      '--credential', HERMES);
    const revision = /at revision ([0-9a-f]{12})/.exec(said)?.[1] ?? '';
    expect(revision, said).not.toBe('');
    return revision;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The Pages view of the index, which signed in is not the one it opens on.
async function openIndex(page: Page, address = '/#pages') {
  await page.goto(address);
  await expect(strip(page)).toHaveCount(1);
}

const strip = (page: Page) => page.getByRole('group', { name: 'Open pods' });
const tabs = (page: Page) => strip(page).locator('.pod-tab');
const tab = (page: Page, pod: Pod) => strip(page).locator(`.pod-tab[data-page="${pod.name}"]`);
const tabTitle = (page: Page, pod: Pod) => tab(page, pod).locator('button.pod-tab-title');
const close = (page: Page, pod: Pod) => strip(page).getByRole('button', { name: `Close ${pod.title}` });
const frame = (page: Page, pod: Pod) => page.locator(`iframe.pod-frame[title="${pod.title}"]`);
const framed = (page: Page, pod: Pod) => page.frameLocator(`iframe.pod-frame[title="${pod.title}"]`);
const listingLink = (page: Page, pod: Pod) =>
  page.locator(`.index-table tbody tr[data-page="${pod.name}"] td.episode-title > a`);
const home = (page: Page) => page.locator('.pod-tabs-bar').getByRole('button', { name: 'Lotuspod', exact: true });

function openNames(page: Page): Promise<string[]> {
  return tabs(page).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.page ?? ''));
}

// The pod's tab is the active one, its frame shown over the hidden listing.
async function expectActive(page: Page, pod: Pod) {
  await expect(strip(page).locator('[aria-current="page"]')).toHaveCount(1);
  await expect(tabTitle(page, pod)).toHaveAttribute('aria-current', 'page');
  await expect(frame(page, pod)).toBeVisible();
  await expect(page.locator('main.index')).toBeHidden();
}

async function expectListing(page: Page) {
  await expect(page.locator('main.index')).toBeVisible();
  await expect(strip(page).locator('[aria-current]')).toHaveCount(0);
  await expect(page.locator('iframe.pod-frame:visible')).toHaveCount(0);
}

// Open a pod from its listing row with a plain click.
async function openFromListing(page: Page, pod: Pod) {
  if (await page.locator('main.index').isHidden()) await home(page).click();
  await listingLink(page, pod).click();
  await expectActive(page, pod);
  await expect(framed(page, pod).locator('h1')).toHaveText(pod.title);
}

function seenPost(page: Page, name: string) {
  return page.waitForResponse((response: Response) =>
    new URL(response.url()).pathname === SEEN && response.request().method() === 'POST' &&
    response.request().postDataJSON()?.page === name);
}

async function focusWindow(page: Page) {
  const read = page.waitForResponse((response) =>
    new URL(response.url()).pathname === SEEN && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await read;
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, SECOND, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('a plain click on a title link opens the pod in a tab, with no error or violation', async ({ page }) => {
    const errors = await watch(page);
    await openIndex(page);
    await expect(tabs(page)).toHaveCount(0);
    await listingLink(page, ARTICLE).click();

    await expect(tabs(page)).toHaveCount(1);
    await expect(tabTitle(page, ARTICLE)).toHaveText(ARTICLE.title);
    await expectActive(page, ARTICLE);
    await expect(framed(page, ARTICLE).locator('h1')).toHaveText(ARTICLE.title);
    await expect(page).toHaveURL(/#tabs=capture-article&on=capture-article$/);
    await expect(close(page, ARTICLE)).toHaveText('✕');
    // The index is the page it was: the frame holds the pod.
    expect(new URL(page.url()).pathname).toBe('/');

    expect(await violations(page)).toEqual([]);
    expect(await violations(page, ARTICLE.name)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a link in a framed pod opens a tab after it, Ctrl-click a browser tab, and the pod\'s Lotuspod link the listing', async ({ page, context }) => {
    const errors = await watch(page);
    // A framed page's links are handled before it has loaded: its page
    // script, which holds back its load, is slow to come.
    let held = 0;
    await page.route((url) => url.pathname === '/lotuspod-page.js', async (route) => {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await openIndex(page);
    await openFromListing(page, CONTEXT);
    expect(await frame(page, CONTEXT).evaluate((node) =>
      (node as HTMLIFrameElement).contentDocument?.readyState)).not.toBe('complete');
    expect(held).toBe(1);
    const link = framed(page, CONTEXT).getByRole('link', { name: 'the pump notes' }).first();
    await link.click();
    await expect.poll(() => openNames(page)).toEqual([CONTEXT.name, ARTICLE.name]);
    await expectActive(page, ARTICLE);
    await expect(framed(page, ARTICLE).locator('h1')).toHaveText(ARTICLE.title);
    await expect(page).toHaveURL(/#tabs=capture-decision-context,capture-article&on=capture-article$/);

    // Cmd-click or Ctrl-click is the browser's.
    await tabTitle(page, CONTEXT).click();
    await expectActive(page, CONTEXT);
    const opened = context.waitForEvent('page');
    await link.click({ modifiers: ['ControlOrMeta'] });
    const other = await opened;
    await other.waitForLoadState();
    expect(new URL(other.url()).pathname).toBe('/capture-article.html');
    await other.close();
    await expect(tabs(page)).toHaveCount(2);
    await expectActive(page, CONTEXT);

    // The framed page's own way back to the index shows the listing.
    await framed(page, CONTEXT).locator('a.artifact-topbar-brand').click();
    await expectListing(page);
    await expect(tabs(page)).toHaveCount(2);
    await expect(home(page)).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveURL(/#tabs=capture-decision-context,capture-article$/);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(errors).toEqual([]);
  });

  test('a framed pod reloaded still opens its links in tabs, before and after it has loaded again', async ({ page }) => {
    const errors = await watch(page);
    const readyState = () => frame(page, CONTEXT).evaluate((node) =>
      (node as HTMLIFrameElement).contentDocument?.readyState);
    await openIndex(page);
    await openFromListing(page, CONTEXT);
    await expect.poll(readyState).toBe('complete');

    // A reload, as the reload banner's: the old page is marked, so the
    // reloaded one is told apart from it.
    await frame(page, CONTEXT).evaluate((node) => {
      const framed = (node as HTMLIFrameElement).contentWindow as Window;
      framed.document.body.dataset.before = 'reload';
      framed.location.reload();
    });
    await expect(framed(page, CONTEXT).locator('body:not([data-before])')).toHaveCount(1);
    await expect(framed(page, CONTEXT).locator('h1')).toHaveText(CONTEXT.title);
    // Straight away, loaded or not.
    const link = framed(page, CONTEXT).getByRole('link', { name: 'the pump notes' }).first();
    await link.click();
    await expect.poll(() => openNames(page)).toEqual([CONTEXT.name, ARTICLE.name]);
    await expectActive(page, ARTICLE);
    await expect(page).toHaveURL(/#tabs=capture-decision-context,capture-article&on=capture-article$/);

    // Once it has loaded, too.
    await close(page, ARTICLE).click();
    await expectActive(page, CONTEXT);
    await expect.poll(readyState).toBe('complete');
    await link.click();
    await expect.poll(() => openNames(page)).toEqual([CONTEXT.name, ARTICLE.name]);
    await expectActive(page, ARTICLE);
    await expect(framed(page, CONTEXT).locator('h1')).toHaveText(CONTEXT.title);
    expect(errors).toEqual([]);
  });

  test('closing a tab activates its right neighbour, else its left, else the listing; the address reopens tabs', async ({ page }) => {
    const errors = await watch(page);
    // The activity route answers once a tab is open: the tabs' fragment then
    // in the address leaves the index on the Pages view it was opened on.
    let release = () => {};
    const opened = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === '/api/activity', async (route) => {
      await opened;
      await route.continue();
    });
    const activity = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/activity');
    await openIndex(page);
    await openFromListing(page, ARTICLE);
    release();
    await activity;
    await expect(page.locator('.index-views')).toHaveCount(1);
    await openFromListing(page, CONTEXT);
    await openFromListing(page, CHECKLIST);
    // From the listing, a new tab goes last.
    expect(await openNames(page)).toEqual([ARTICLE.name, CONTEXT.name, CHECKLIST.name]);
    await tabTitle(page, CONTEXT).click();
    await expectActive(page, CONTEXT);

    await close(page, CONTEXT).click();
    expect(await openNames(page)).toEqual([ARTICLE.name, CHECKLIST.name]);
    await expectActive(page, CHECKLIST);
    await expect(tabTitle(page, CHECKLIST)).toBeFocused();

    await close(page, CHECKLIST).click();
    await expectActive(page, ARTICLE);
    await expect(tabTitle(page, ARTICLE)).toBeFocused();

    await close(page, ARTICLE).click();
    await expect(tabs(page)).toHaveCount(0);
    await expectListing(page);
    await expect(page.getByLabel('Search')).toBeFocused();
    // The fragment is the one the index had before any tab, its view too.
    await expect(page).toHaveURL(/\/#pages$/);
    await expect(page.getByRole('button', { name: 'Pages', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.index-table')).toBeVisible();

    // A pod opened from the active tab's page goes just after that tab.
    await openFromListing(page, CONTEXT);
    await openFromListing(page, CHECKLIST);
    await tabTitle(page, CONTEXT).click();
    await framed(page, CONTEXT).getByRole('link', { name: 'the pump notes' }).first().click();
    await expectActive(page, ARTICLE);
    expect(await openNames(page)).toEqual([CONTEXT.name, ARTICLE.name, CHECKLIST.name]);

    await page.goto('about:blank');
    await openIndex(page, '/#tabs=capture-article,no-such-page,capture-checklist&on=capture-checklist');
    expect(await openNames(page)).toEqual([ARTICLE.name, CHECKLIST.name]);
    await expectActive(page, CHECKLIST);
    await expect(framed(page, CHECKLIST).locator('h1')).toHaveText(CHECKLIST.title);
    await expect(framed(page, ARTICLE).locator('h1')).toHaveText(ARTICLE.title);
    await expect(frame(page, ARTICLE)).toBeHidden();
    await expect(page).toHaveURL(/#tabs=capture-article,capture-checklist&on=capture-checklist$/);
    expect(errors).toEqual([]);
  });

  test('the pointer on a tab not active lifts the whole tab, its ✕ white as its title', async ({ page }) => {
    await openIndex(page);
    await openFromListing(page, ARTICLE);
    await openFromListing(page, CHECKLIST);
    const resting = tab(page, ARTICLE);
    const background = (await resting.evaluate((node) => getComputedStyle(node).backgroundColor));
    await tabTitle(page, ARTICLE).hover();
    await expect.poll(() => resting.evaluate((node) => getComputedStyle(node).backgroundColor))
      .not.toBe(background);
    const white = rgb(COLORS.white);
    expect(await close(page, ARTICLE).evaluate((node) => getComputedStyle(node).color)).toBe(white);
    expect(await tabTitle(page, ARTICLE).evaluate((node) => getComputedStyle(node).color)).toBe(white);
    // The active tab: the glow, white semibold text and a lavender rule under it.
    const active = await tab(page, CHECKLIST).evaluate((node) => {
      const style = getComputedStyle(node);
      const title = getComputedStyle(node.querySelector('.pod-tab-title') as Element);
      return { background: style.backgroundColor, rule: style.boxShadow, color: title.color, weight: title.fontWeight };
    });
    expect(active.background).toBe(rgb(COLORS.glow));
    expect(active.rule).toContain(rgb(COLORS.lavender));
    expect(active.rule).toContain('-2px');
    expect(active.color).toBe(white);
    expect(active.weight).toBe('600');
  });

  test('a pod published again shows an amber "new version" dot until its tab is activated', async ({ page }) => {
    const errors = await watch(page);
    const pod = { name: 'pod-tabs-version', title: 'Pod tabs version' };
    publish(pod.name, source(pod.title, 'first'));
    await openIndex(page);
    const loaded = seenPost(page, pod.name);
    await listingLink(page, pod).click();
    await loaded;
    await expectActive(page, pod);
    await openFromListing(page, ARTICLE);
    expect(await openNames(page)).toEqual([pod.name, ARTICLE.name]);
    await expect(tab(page, pod).locator('.pod-tab-dot')).toHaveCount(0);

    // serve dates a page to the second: a publish in the second the page was
    // served would leave the browser's cached copy current.
    await page.waitForTimeout(1100);
    publish(pod.name, source(pod.title, 'second'));
    await focusWindow(page);
    const dot = tab(page, pod).locator('.pod-tab-dot');
    await expect(dot).toHaveText('new version');
    expect(await dot.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(rgb(COLORS.amber));
    // Its words are for a screen reader alone.
    expect(await dot.locator('.pod-tab-dot-text').evaluate((node) => node.getBoundingClientRect().width))
      .toBeLessThanOrEqual(1);
    await expect(tab(page, ARTICLE).locator('.pod-tab-dot')).toHaveCount(0);

    await tabTitle(page, pod).click();
    await expectActive(page, pod);
    await expect(tab(page, pod).locator('.pod-tab-dot')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a pod someone else comments on shows an orchid "new replies" dot until its tab is activated', async ({ page, baseURL }) => {
    const errors = await watch(page);
    const pod = { name: 'pod-tabs-replies', title: 'Pod tabs replies' };
    publish(pod.name, source(pod.title, 'first'));
    await openIndex(page);
    const loaded = seenPost(page, pod.name);
    await listingLink(page, pod).click();
    await loaded;
    await openFromListing(page, ARTICLE);
    await expect(tab(page, pod).locator('.pod-tab-dot')).toHaveCount(0);

    const second = await requests.newContext({ baseURL, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': SECOND } });
    try {
      const comment = await second.post('/api/comments', {
        data: { page: pod.name, section: 'findings', text: 'The heater by the steps is enough.' },
      });
      expect(comment.status(), await comment.text()).toBe(201);
    } finally {
      await second.dispose();
    }
    await focusWindow(page);
    const dot = tab(page, pod).locator('.pod-tab-dot');
    await expect(dot).toHaveText('new replies');
    expect(await dot.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(rgb(COLORS.orchid));

    const marked = seenPost(page, pod.name);
    await tabTitle(page, pod).click();
    expect((await marked).status()).toBe(200);
    await expectActive(page, pod);
    await expect(tab(page, pod).locator('.pod-tab-dot')).toHaveCount(0);
    const answer = await page.request.get(SEEN);
    expect(answer.status()).toBe(200);
    const { pages } = await answer.json();
    expect(pages[pod.name].replies).toBe(0);
    expect(errors).toEqual([]);
  });
});

test.describe('signed out', () => {
  test('tabs open and close, and no tab shows a dot', async ({ page }) => {
    await openIndex(page, '/');
    await openFromListing(page, ARTICLE);
    await openFromListing(page, CHECKLIST);
    await focusWindow(page);
    await expect(strip(page).locator('.pod-tab-dot')).toHaveCount(0);
    await close(page, CHECKLIST).click();
    await expectActive(page, ARTICLE);
    await expect(strip(page).locator('.pod-tab-dot')).toHaveCount(0);
    await close(page, ARTICLE).click();
    await expectListing(page);
    await expect(tabs(page)).toHaveCount(0);
  });

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });

    test('the index has no strip and a title link loads its page in the window', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('.index-table')).toBeVisible();
      await expect(page.locator('.pod-tabs-bar')).toHaveCount(0);
      await listingLink(page, ARTICLE).click();
      await expect(page).toHaveURL(/\/capture-article\.html$/);
      await expect(page.locator('h1')).toHaveText(ARTICLE.title);
    });
  });
});
