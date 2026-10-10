import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// At this width a box never opens: its chip opens the section's threads in
// a popover over the text. panel.spec.ts checks the side panel a wider
// window gets, and narrow.spec.ts the popover and a phone's bottom sheet.
const MEDIUM = { width: 1024, height: 768 };
test.use({ viewport: MEDIUM });

// The capture fixture's comments page: three sections, each ending in a
// comment box, owned by hermes. The fixture names an assertion its site
// accepts; sending it is being signed in. hermes pulls on the fixture's agent
// socket first, so it is listening and a new comment waits for it.
const PAGE = '/capture-comments.html';
const THREADS = (url: URL) => url.pathname === '/api/comments';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
// The reader as a page names them: their address's part before the @.
const READER = 'maintainer';
const OWNER = 'hermes';
const AGENT = { kind: 'agent', handle: OWNER };
const LAVENDER = 'rgb(183, 156, 244)';
// Words a state may say; none of them is ever part of a comment.
const STATE_WORDS = /Waiting|Checking|writing|offline|paused|couldn't answer|answered/i;

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
  };
}

// A section's box: its chip, and the popover it opens, which holds the
// section's threads and its form for a new one.
function box(page: Page, section: string) {
  const details = page.locator(`details.artifact-comment[data-section="${section}"]`);
  const popover = page.locator('.artifact-comments-popover');
  return {
    details,
    summary: details.locator('summary'),
    popover,
    start: popover.getByRole('button', { name: 'Comment on this section' }),
    text: popover.locator('form.artifact-comment-form textarea[name="text"]'),
    comment: popover.getByRole('button', { name: 'Comment', exact: true }),
    threads: popover.locator('.artifact-comment-thread'),
  };
}

const TITLES: Record<string, string> = { findings: 'Findings', risks: 'Risks', 'next-steps': 'Next steps' };

// Open a section's threads through its chip, in a popover over the text,
// closing first the popover open over it.
async function open(page: Page, section: string) {
  const { summary, popover, details } = box(page, section);
  if (await popover.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
  }
  await summary.click();
  await expect(popover).toBeVisible();
  await expect(popover.locator('.artifact-comments-held-title')).toHaveText(`Section ${TITLES[section]}`);
  await expect(details).not.toHaveAttribute('open');
}

function thread(page: Page, root: { id: number }) {
  return page.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
}

// What a thread draws, in order: its rows, typing bubbles and system lines.
function drawn(list: Locator) {
  return list.locator('.artifact-comment-list > li').evaluateAll((items) => items.map((item) => {
    const has = (name: string) => item.classList.contains(name);
    if (has('artifact-comment-item--agent')) return 'agent';
    if (has('artifact-comment-item--reader')) return 'reader';
    if (has('artifact-comment-event')) return 'revision';
    if (has('artifact-comment-notice')) return `notice:${(item as HTMLElement).dataset.state}`;
    if (has('artifact-comment-typing--pending')) return 'typing:pending';
    if (has('artifact-comment-typing--claimed')) return 'typing:claimed';
    return item.className;
  }));
}

let next = 1;

function row(fields: Record<string, unknown>) {
  const id = next++;
  return {
    id,
    page: 'capture-comments',
    section: 'findings',
    sectionTitle: 'Findings',
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

// One thread in every state, an answered thread with replies with and without
// a revision, a writer of another kind, a stray thread and markup as text.
function everyState() {
  const roots = {
    pending: row({ state: 'pending' }),
    unavailable: row({ state: 'unavailable' }),
    answered: row({
      state: 'answered', text: 'Swap steps two and three?', revision: 'a1b2c3a1b2c3',
      actor: { kind: 'human', name: 'hermes' },
    }),
    markup: row({ state: 'answered', text: '<img src="x.png" alt="injected">' }),
    claimed: row({ state: 'claimed', section: 'risks', sectionTitle: 'Risks' }),
    other: row({
      state: 'answered', section: 'risks', sectionTitle: 'Risks', text: 'Filed by the service.',
      actor: { kind: 'service', handle: 'nightly' },
    }),
    failed: row({
      state: 'failed', reason: 'the model timed out', section: 'next-steps', sectionTitle: 'Next steps',
    }),
    paused: row({ state: 'paused', section: 'next-steps', sectionTitle: 'Next steps' }),
    silent: row({ state: 'failed', section: 'next-steps', sectionTitle: 'Next steps' }),
    stray: row({ state: 'answered', section: 'old-plan', sectionTitle: 'Old plan', text: 'On a section since removed.' }),
  };
  const answered = roots.answered.id;
  const replies = {
    revised: row({ parent: answered, state: 'answered', text: 'Swapped them.', revision: '3f9a2c3f9a2c', actor: AGENT }),
    // The same revision as the thread's first comment: still a revision the reply carries.
    same: row({ parent: answered, state: 'answered', text: 'Swapped again.', revision: 'a1b2c3a1b2c3', actor: AGENT }),
    none: row({ parent: answered, state: 'answered', text: 'No change needed.', revision: '', actor: AGENT }),
  };
  const threads = Object.values(roots).map((root) => ({
    root,
    replies: root === roots.answered ? Object.values(replies) : [],
  }));
  return { roots, replies, threads };
}

// A system line is centred in its thread.
async function centred(notice: Locator) {
  const list = (await notice.locator('xpath=..').boundingBox())!;
  const line = (await notice.boundingBox())!;
  expect(Math.abs((line.x + line.width / 2) - (list.x + list.width / 2))).toBeLessThan(2);
}

async function serve(page: Page, threads: unknown[]) {
  await page.route(THREADS, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { page: 'capture-comments', threads } })
      : route.continue());
}

// Tab through the page until the target has the focus, as a keyboard user does.
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 200; step++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((node) => node === document.activeElement)) return;
  }
  throw new Error('the target is never reached by Tab');
}

async function outline(target: Locator, pseudo: string | null = null) {
  return target.evaluate((node, pseudo) => {
    const style = getComputedStyle(node, pseudo);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor };
  }, pseudo);
}

// The contrast of the target's text colour against what is behind it: the
// nearest opaque background among it and its ancestors, with every
// translucent background in between composited over it.
async function contrast(target: Locator) {
  return target.evaluate((node) => {
    const parse = (value: string) => {
      const parts = (/rgba?\(([^)]*)\)/.exec(value)?.[1] ?? '0 0 0 0').split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    const over = (top: number[], under: number[]) =>
      [0, 1, 2].map((index) => top[index] * top[3] + under[index] * (1 - top[3]));
    const layers: number[][] = [];
    for (let at: Element | null = node; at; at = at.parentElement) {
      const background = parse(getComputedStyle(at).backgroundColor);
      if (background[3] > 0) layers.push(background);
      if (background[3] >= 1) break;
    }
    let behind = [255, 255, 255];
    for (const layer of layers.reverse()) behind = over(layer, behind);
    const text = over(parse(getComputedStyle(node).color), behind);
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [light, dark] = [luminance(text), luminance(behind)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  });
}

test.beforeAll(() => {
  const env = process.env;
  execFileSync(env.LOTUSPOD_TEST_PYTHON ?? '', [
    '-m', 'lotuspod', 'comments', 'pull', '--owner', OWNER, '--json',
    '--socket', env.LOTUSPOD_TEST_SOCKET ?? '',
    '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '',
  ], { env: { ...env, PYTHONPATH: path.resolve(__dirname, '..', '..', 'src') }, stdio: 'ignore' });
});

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('a comment starts a thread that is there again after a reload, and takes a reply', async ({ page }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const seen = await watch(page);
    await page.goto(`${PAGE}?standalone`);
    await expect(page.locator('.artifact-body details.artifact-comment')).toHaveCount(3);
    const risks = box(page, 'risks');
    await expect(risks.summary).toHaveText('No comments · Comment');
    await open(page, 'risks');
    await expect(risks.text).toBeFocused();

    await risks.text.fill('This step is out of order.');
    await risks.comment.click();
    await expect(risks.threads).toHaveCount(1);
    const thread = risks.threads.first();

    const shown = async () => {
      const mine = thread.locator('.artifact-comment-item--reader');
      await expect(mine).toHaveCount(1);
      await expect(mine.locator('.artifact-comment-author')).toHaveText(READER);
      await expect(mine.locator('.artifact-comment-text')).toHaveText('This step is out of order.');
      // The page names the reader, never by their address.
      expect(await page.locator('body').textContent()).not.toContain('@example.com');
      const typing = thread.locator('.artifact-comment-typing--pending');
      await expect(typing.locator('.artifact-comment-bubble')).toHaveText(`Checking for a reply from ${OWNER}`);
      expect(await drawn(thread)).toEqual(['reader', 'typing:pending']);
      // The reader's bubble sits on the right, the typing bubble on the left.
      const list = (await thread.locator('.artifact-comment-list').boundingBox())!;
      const bubble = (await mine.locator('.artifact-comment-text').boundingBox())!;
      const waiting = (await typing.locator('.artifact-comment-bubble').boundingBox())!;
      expect(bubble.x).toBeGreaterThan(waiting.x);
      expect(bubble.x + bubble.width).toBeGreaterThan(list.x + list.width - 60);
      expect(waiting.x).toBeLessThan(list.x + 60);
    };
    await shown();
    await expect(risks.text).toHaveValue('');
    await expect(risks.text).toBeHidden();
    await expect(risks.summary).toHaveText('1 comment · waiting');

    await page.reload();
    await expect(risks.summary).toHaveText('1 comment · waiting');
    await expect(box(page, 'findings').summary).toHaveText('No comments · Comment');
    await open(page, 'risks');
    await expect(risks.threads).toHaveCount(1);
    await shown();

    // The composer is folded until opened; before an answer it adds to the comment.
    await thread.getByRole('button', { name: 'Add to your comment' }).click();
    await thread.locator('form.artifact-comment-reply textarea[name="text"]').fill('It follows the heater.');
    await thread.getByRole('button', { name: 'Send' }).click();
    const items = thread.locator('.artifact-comment-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toHaveClass(/artifact-comment-item--reader/);
    await expect(items.nth(1).locator('.artifact-comment-text')).toHaveText('It follows the heater.');
    await expect(items.nth(1).locator('.artifact-comment-author')).toHaveText(READER);
    await expect(thread.locator('form.artifact-comment-reply textarea[name="text"]')).toHaveValue('');
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test('every state is its own mark outside what the reader wrote', async ({ page }) => {
    const seen = await watch(page);
    const { roots, threads } = everyState();
    await serve(page, threads);
    await page.goto(`${PAGE}?standalone`);

    // Each popover holds its section's threads, and only those.
    for (const [section, count] of [['risks', 2], ['next-steps', 3], ['findings', 4]] as const) {
      await open(page, section);
      await expect(box(page, section).threads).toHaveCount(count);
    }

    const pending = thread(page, roots.pending);
    expect(await drawn(pending)).toEqual(['reader', 'typing:pending']);
    const waiting = pending.locator('.artifact-comment-typing--pending');
    await expect(waiting).toHaveAttribute('aria-hidden', 'true');
    await expect(waiting.locator('.artifact-comment-bubble')).toHaveText(`Checking for a reply from ${OWNER}`);
    await expect(waiting.locator('.artifact-comment-avatar')).toHaveCSS('border-style', 'dashed');

    const unavailable = thread(page, roots.unavailable);
    expect(await drawn(unavailable)).toEqual(['reader', 'notice:unavailable']);
    const offline = unavailable.locator('.artifact-comment-notice');
    await expect(offline.locator('.artifact-comment-notice-title')).toHaveText(`${OWNER} is offline`);
    await expect(offline.locator('.artifact-comment-notice-text'))
      .toHaveText(`Your comment goes to ${OWNER} when it checks in again.`);
    await expect(offline).toHaveCSS('border-style', 'dashed');
    await centred(offline);

    await open(page, 'risks');
    const claimed = thread(page, roots.claimed);
    expect(await drawn(claimed)).toEqual(['reader', 'typing:claimed']);
    const writing = claimed.locator('.artifact-comment-typing--claimed');
    await expect(writing.locator('.artifact-comment-by')).toHaveText(`${OWNER} AGENT is writing`);
    await expect(writing.locator('.artifact-comment-bubble')).toHaveText(`${OWNER} is writing a reply`);
    await expect(writing.locator('.artifact-comment-bubble .artifact-comment-sr')).toHaveCSS('width', '1px');

    await open(page, 'next-steps');
    const paused = thread(page, roots.paused);
    expect(await drawn(paused)).toEqual(['reader', 'notice:paused']);
    await expect(paused.locator('.artifact-comment-notice-title')).toHaveText('The responder is paused');
    await expect(paused.locator('.artifact-comment-notice-text')).toHaveText('Your comment waits until it is resumed.');

    const failed = thread(page, roots.failed);
    expect(await drawn(failed)).toEqual(['reader', 'notice:failed']);
    await expect(failed.locator('.artifact-comment-notice-title')).toHaveText(`${OWNER} couldn't answer`);
    await expect(failed.locator('.artifact-comment-notice-text'))
      .toHaveText(['the model timed out', 'To send it again, write a new comment.']);
    await expect(thread(page, roots.silent).locator('.artifact-comment-notice-text'))
      .toHaveText(['No reason given', 'To send it again, write a new comment.']);

    // A system line is centred in its thread.
    for (const notice of [paused.locator('.artifact-comment-notice'), failed.locator('.artifact-comment-notice')]) {
      await centred(notice);
    }

    // Each reader bubble holds exactly what was written, and no bubble or
    // name line of a comment says a state.
    for (const root of Object.values(roots)) {
      await expect(thread(page, root).locator('.artifact-comment-item .artifact-comment-text').first())
        .toHaveText(root.text);
    }
    const said = await page.locator('.artifact-comment-item :is(.artifact-comment-text, .artifact-comment-by)')
      .allTextContents();
    expect(said.length).toBeGreaterThan(Object.keys(roots).length * 2);
    expect(said.filter((text) => STATE_WORDS.test(text))).toEqual([]);
    await expect(page.locator('.artifact-comment-item :is(.artifact-comment-notice, .artifact-comment-event, .artifact-comment-mark)'))
      .toHaveCount(0);

    // A writer neither human nor agent is drawn as a reader, with no tag.
    const other = thread(page, roots.other).locator('.artifact-comment-item');
    await expect(other).toHaveClass(/artifact-comment-item--reader/);
    await expect(other.locator('.artifact-comment-author')).toHaveText('nightly');
    await expect(other.locator('.artifact-comment-agent')).toHaveCount(0);

    const changed = page.locator('.artifact-comments-changed');
    await expect(changed.getByRole('heading', { name: 'Comments on sections that have changed' })).toBeVisible();
    await expect(changed.locator('.artifact-comment-thread')).toHaveCount(1);
    await expect(changed).toContainText('On Old plan');
    await expect(changed.locator('.artifact-comment-text')).toHaveText('On a section since removed.');

    await expect(thread(page, roots.markup).locator('.artifact-comment-text'))
      .toHaveText('<img src="x.png" alt="injected">');
    await expect(page.locator('img')).toHaveCount(0);
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test("an agent's reply is on the left behind a square avatar and its tag, and a revision is a line of its own", async ({ page }) => {
    const seen = await watch(page);
    const { roots, threads } = everyState();
    await serve(page, threads);
    await page.goto(`${PAGE}?standalone`);
    await open(page, 'findings');

    const answered = thread(page, roots.answered);
    expect(await drawn(answered)).toEqual(['reader', 'agent', 'revision', 'agent', 'revision', 'agent']);
    const items = answered.locator('.artifact-comment-item');
    const mine = items.nth(0);
    const reply = items.nth(1);
    // The reader's name is hermes; the actor's kind still says a reader wrote it.
    await expect(mine.locator('.artifact-comment-author')).toHaveText('hermes');
    await expect(mine.locator('.artifact-comment-avatar')).toHaveText('HE');
    await expect(mine.locator('.artifact-comment-agent')).toHaveCount(0);
    await expect(mine.locator('.artifact-comment-avatar')).toHaveCSS('border-radius', '50%');
    await expect(reply.locator('.artifact-comment-handle')).toHaveText(OWNER);
    await expect(reply.locator('.artifact-comment-handle')).toHaveCSS('font-family', /monospace/);
    await expect(reply.locator('.artifact-comment-agent')).toHaveText('AGENT');
    await expect(reply.locator('.artifact-comment-avatar')).toHaveText('H');
    await expect(reply.locator('.artifact-comment-avatar')).toHaveCSS('border-radius', '8px');
    await expect(reply.locator('.artifact-comment-avatar')).toHaveCSS('background-color', LAVENDER);
    await expect(reply.locator('.artifact-comment-text')).toHaveText('Swapped them.');
    const left = (await reply.locator('.artifact-comment-text').boundingBox())!;
    const right = (await mine.locator('.artifact-comment-text').boundingBox())!;
    expect(left.x).toBeLessThan(right.x);
    expect(left.x + left.width).toBeLessThan(right.x + right.width);

    const lines = answered.locator('.artifact-comment-event');
    await expect(lines.nth(0)).toHaveText(`${OWNER} revised the page → revision 3f9a2c3f9a2c`);
    await expect(lines.nth(1)).toHaveText(`${OWNER} revised the page → revision a1b2c3a1b2c3`);
    const link = lines.nth(0).getByRole('link');
    await expect(link).toHaveAttribute('href', 'capture-comments.html');
    const list = (await lines.nth(0).locator('xpath=..').boundingBox())!;
    const text = (await lines.nth(0).locator('span').first().boundingBox())!;
    expect(Math.abs((text.x + text.width / 2) - (list.x + list.width / 2))).toBeLessThan(2);
    await expect(answered.locator('.artifact-comment-item a')).toHaveCount(0);
    await expect(items.nth(3).locator('.artifact-comment-text')).toHaveText('No change needed.');

    // The page, loaded on its own at the top level, opens in the index's
    // tabs (js/open-in-tabs.js).
    await link.click();
    await expect(page).toHaveURL(/\/#tabs=capture-comments&on=capture-comments$/);
    await expect(page.frameLocator('iframe.pod-frame--active').locator('.artifact-body details.artifact-comment')).toHaveCount(3);
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test('a keyboard user sees the focus, and every line of text is legible', async ({ page }) => {
    const seen = await watch(page);
    const { roots, threads } = everyState();
    await serve(page, threads);
    await page.goto(`${PAGE}?standalone`);
    await open(page, 'findings');
    await expect(box(page, 'findings').popover).toBeFocused();
    await box(page, 'findings').start.click();
    await expect(box(page, 'findings').text).toBeFocused();

    const send = box(page, 'findings').comment;
    await tabTo(page, send);
    expect(await outline(send)).toEqual({ style: 'solid', width: 2, color: LAVENDER });
    const link = thread(page, roots.answered).locator('.artifact-comment-event a').first();
    await tabTo(page, link);
    expect(await outline(link)).toEqual({ style: 'solid', width: 2, color: LAVENDER });
    const reply = thread(page, roots.answered).getByRole('button', { name: 'Reply' });
    await tabTo(page, reply);
    expect(await outline(reply)).toEqual({ style: 'solid', width: 2, color: LAVENDER });
    await page.keyboard.press('Enter');
    const field = thread(page, roots.answered).locator('form.artifact-comment-reply');
    await expect(field.locator('textarea')).toBeFocused();
    expect(await outline(field, '::before')).toEqual({ style: 'solid', width: 2, color: LAVENDER });

    const answered = thread(page, roots.answered);
    // Each section's lines, read in its own popover.
    const texts = {
      findings: {
        'reader bubble': answered.locator('.artifact-comment-item--reader .artifact-comment-text'),
        'agent bubble': answered.locator('.artifact-comment-item--agent .artifact-comment-text').first(),
        'name line': answered.locator('.artifact-comment-item--reader .artifact-comment-by'),
        'name line time': answered.locator('.artifact-comment-item--agent .artifact-comment-time').first(),
        'name line address': answered.locator('.artifact-comment-author'),
        'name line handle': answered.locator('.artifact-comment-handle').first(),
        'name line tag': answered.locator('.artifact-comment-agent').first(),
        'revision line': answered.locator('.artifact-comment-event > span').first(),
        'offline line': thread(page, roots.unavailable).locator('.artifact-comment-notice-title span').last(),
        'offline text': thread(page, roots.unavailable).locator('.artifact-comment-notice-text'),
        'waiting bubble': thread(page, roots.pending).locator('.artifact-comment-bubble'),
      },
      'next-steps': {
        'failed line': thread(page, roots.failed).locator('.artifact-comment-notice-title span').last(),
        'failed reason': thread(page, roots.failed).locator('.artifact-comment-notice-text').first(),
        'paused line': thread(page, roots.paused).locator('.artifact-comment-notice-text'),
      },
      risks: {
        'writing line': thread(page, roots.claimed).locator('.artifact-comment-typing .artifact-comment-by'),
      },
    };
    for (const [section, lines] of Object.entries(texts)) {
      if (section !== 'findings') await open(page, section);
      for (const [name, target] of Object.entries(lines)) {
        await expect(target, name).toBeVisible();
        expect(await contrast(target), name).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test('the typing dots keep still when the reader asks for reduced motion', async ({ page }) => {
    const { roots, threads } = everyState();
    await serve(page, threads);
    const running = (target: Locator) => target.evaluateAll((dots) => dots
      .flatMap((dot) => dot.getAnimations())
      .filter((animation) => animation.playState === 'running').length);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`${PAGE}?standalone`);
    await open(page, 'risks');
    const dots = thread(page, roots.claimed).locator('.artifact-comment-mark--dots i');
    await expect(dots).toHaveCount(3);
    await expect(dots.first()).toBeVisible();
    expect(await running(dots)).toBe(3);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await open(page, 'risks');
    await expect(dots).toHaveCount(3);
    await expect(dots.first()).toBeVisible();
    expect(await running(dots)).toBe(0);
    await open(page, 'findings');
    const waiting = thread(page, roots.pending).locator('.artifact-comment-mark--dots i');
    await expect(waiting.first()).toBeVisible();
    expect(await running(waiting)).toBe(0);
  });

  test('a phone-wide page does not scroll sideways', async ({ page }) => {
    const seen = await watch(page);
    await page.setViewportSize({ width: 360, height: 780 });
    const { threads } = everyState();
    const long = row({ text: `A long word: ${'unbroken'.repeat(30)}` });
    threads.push({ root: long, replies: [] });
    await serve(page, threads);
    await page.goto(`${PAGE}?standalone`);
    // On a phone the chip opens its section's newest thread in the bottom sheet.
    await box(page, 'findings').summary.click();
    const sheet = page.locator('.artifact-comments-bottom-sheet');
    await expect(sheet.locator(`.artifact-comment-thread[data-thread="${long.id}"]`)).toBeVisible();
    const held = (await sheet.boundingBox())!;
    expect(held.x).toBeGreaterThanOrEqual(0);
    expect(held.x + held.width).toBeLessThanOrEqual(360);
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test('a section id that names an object property still holds its own threads', async ({ page }) => {
    const seen = await watch(page);
    // The fixture's page as served, its third section's id and box renamed
    // "__proto__", as an author's explicit id would render.
    await page.route((url) => url.pathname === PAGE, async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replaceAll('id="next-steps"', 'id="__proto__"')
        .replaceAll('data-section="next-steps"', 'data-section="__proto__"');
      await route.fulfill({ response, body });
    });
    await serve(page, [
      { root: row({ section: '__proto__', sectionTitle: 'Next steps', text: 'On the renamed section.' }), replies: [] },
      { root: row({ section: 'constructor', sectionTitle: 'Constructor', text: 'On no section here.' }), replies: [] },
    ]);
    await page.goto(`${PAGE}?standalone`);

    const proto = box(page, '__proto__');
    await expect(proto.summary).toHaveText('1 comment · waiting');
    await proto.summary.click();
    await expect(proto.popover.locator('.artifact-comments-held-title')).toHaveText('Section Next steps');
    await expect(proto.threads.locator('.artifact-comment-text')).toHaveText('On the renamed section.');
    const changed = page.locator('.artifact-comments-changed');
    await expect(changed.locator('.artifact-comment-thread')).toHaveCount(1);
    await expect(changed.locator('.artifact-comment-text')).toHaveText('On no section here.');
    expect(seen.errors).toEqual([]);
  });
});
