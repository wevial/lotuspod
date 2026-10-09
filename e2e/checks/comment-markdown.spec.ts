import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// A comment's bubble draws a small markdown subset (js/comment-markdown.js):
// paragraphs, bold, italic, code, code blocks, links and one level of lists,
// a reader's comment and an agent's reply alike. Raw HTML, entities and
// links to anything but http(s), an anchor or a relative path stay as typed.
// A bare http(s) URL is a link too. A link to the site itself opens in the
// same tab and any other in a new one, in a bubble and in the page body
// alike (js/link-tab.js).
// The checks render their own page into the capture fixture's site and find
// the threads they post by id; hermes replies through real `lotuspod`
// commands on the fixture's agent socket. At this width a chip opens its
// section's threads in a popover.
const MEDIUM = { width: 1024, height: 768 };
test.use({ viewport: MEDIUM });

const NAME = 'check-comment-markdown';
const PAGE = `/${NAME}.html`;
// The page a same-site link in a bubble goes to.
const TARGET = 'check-comment-markdown-target';
// A page with no comments and no sections, whose links still take their tab.
const PLAIN = 'check-comment-markdown-plain';
const ENV = process.env;
// The site's own origin, the checks' baseURL.
const SITE = ENV.LOTUSPOD_URL ?? '';
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWNER = 'hermes';
const BODY = `<p>A page for the comment markdown checks.</p>
<p>See <a href="https://example.com/body">elsewhere</a>, <a href="${SITE}/${TARGET}.html">this site</a>
and <a href="#top">the top</a>.</p>
<h2>Pond</h2>
<p>The pond freezes in January.</p>
<h2>Frogs</h2>
<p>The frogs sleep under the ice.</p>
`;

const RICH = [
  'The pump needs **bold** care, *italic* patience and `pump --stop` first.',
  '',
  'Then a second paragraph.',
  '',
  '```',
  'pump --stop',
  'heater <on> && **not bold**',
  '```',
  '',
  '- drain the filter',
  '- check the heater',
  '',
  '1. stop the pump',
  '2. lift it out',
].join('\n');

type Violation = { blockedURI: string; effectiveDirective: string };

test.beforeAll(() => {
  for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON, SITE })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
  const pages = [
    [NAME, 'Check comment markdown', BODY],
    [TARGET, 'Check comment markdown target', '<p>Where a same-site link goes.</p>\n'],
  ];
  for (const [name, title, body] of pages) {
    execFileSync(PYTHON, [
      '-m', 'lotuspod', 'render', '--name', name, '--title', title, '--comments',
      '--owner', OWNER, '--credential', HERMES, '--body', body, '--out-dir', OUT,
    ], { env: { ...ENV, PYTHONPATH: SRC }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  }
  execFileSync(PYTHON, [
    '-m', 'lotuspod', 'render', '--name', PLAIN, '--title', 'Check comment markdown plain',
    '--body', `<p>See <a href="https://example.com/plain">elsewhere</a>, <a href="//example.com/protocol">a
protocol-relative one</a> or <a href="#top">the top</a>.</p>\n`,
    '--out-dir', OUT,
  ], { env: { ...ENV, PYTHONPATH: SRC }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
});

// `lotuspod comments ACTION ... --json` as hermes; what it printed.
function hermes(action: string, ...args: string[]) {
  const stdout = execFileSync(PYTHON, [
    '-m', 'lotuspod', 'comments', action, ...args, '--json',
    '--socket', SOCKET, '--credential', HERMES,
  ], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}

// Console errors and policy violations.
async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    w.__violations = [] as Violation[];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__violations.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  return {
    async clean() {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__violations)).toEqual([]);
    },
  };
}

function box(page: Page, section: string) {
  const details = page.locator(`details.artifact-comment[data-section="${section}"]`);
  const popover = page.locator('.artifact-comments-popover');
  const form = popover.locator('form.artifact-comment-form');
  return {
    summary: details.locator('summary'),
    popover,
    start: popover.getByRole('button', { name: 'Comment on this section' }),
    text: form.locator('textarea[name="text"]'),
    comment: popover.getByRole('button', { name: 'Comment', exact: true }),
  };
}

async function open(page: Page, section: string) {
  const { summary, popover } = box(page, section);
  await expect(summary).toHaveText(/ · /);
  await summary.click();
  await expect(popover).toBeVisible();
}

async function post(request: APIRequestContext, section: string, text: string): Promise<{ id: number }> {
  const response = await request.post('/api/comments', {
    headers: SIGNED_IN,
    data: { page: NAME, section, text },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

// A thread's first bubble: its root comment's text.
function bubble(page: Page, root: { id: number }) {
  return page.locator(`.artifact-comment-thread[data-thread="${root.id}"] .artifact-comment-item--reader .artifact-comment-text`).first();
}

// Exactly the characters a node holds, whitespace and all.
function exact(node: Locator) {
  return node.evaluate((element) => element.textContent);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('a comment draws paragraphs, bold, italic, code, a code block and both lists', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const pond = box(page, 'pond');
    // Unfolded at once when the section has no threads, else behind its button.
    await expect(pond.summary).toHaveText(/ · /);
    const empty = (await pond.summary.textContent())!.startsWith('No comments');
    await open(page, 'pond');
    if (!empty) await pond.start.click();
    await expect(pond.text).toBeFocused();
    await pond.text.fill(RICH);
    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      pond.comment.click(),
    ]);
    expect(posted.status()).toBe(201);
    const row = await posted.json();
    const said = bubble(page, row);
    await expect(said).toBeVisible();
    expect(await said.evaluate((node) => node.tagName)).toBe('DIV');
    await expect(said).toHaveAttribute('id', `artifact-comment-text-${row.id}`);
    expect(await said.evaluate((node) => Array.from(node.children, (child) => child.tagName)))
      .toEqual(['P', 'P', 'PRE', 'UL', 'OL']);
    await expect(said.locator('strong')).toHaveText('bold');
    await expect(said.locator('em')).toHaveText('italic');
    await expect(said.locator('code')).toHaveCount(2);
    await expect(said.locator(':scope > p code')).toHaveText('pump --stop');
    expect(await exact(said.locator('pre > code'))).toBe('pump --stop\nheater <on> && **not bold**');
    await expect(said.locator('pre strong')).toHaveCount(0);
    await expect(said.locator('ul > li')).toHaveText(['drain the filter', 'check the heater']);
    await expect(said.locator('ol > li')).toHaveText(['stop the pump', 'lift it out']);
    // Blocks are spaced apart; a code block keeps its own lines.
    const tops = await said.evaluate((node) => Array.from(node.children, (child) => {
      const box = child.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }));
    for (let n = 1; n < tops.length; n++) expect(tops[n].top).toBeGreaterThan(tops[n - 1].bottom);
    await expect(said.locator('pre')).toHaveCSS('white-space', 'pre');
    await seen.clean();
  });

  test('a link is drawn only to http(s), an anchor or a relative path', async ({ page, request }) => {
    const seen = await watch(page);
    // Only a link off the site opens in a new tab.
    const drawn = [
      ['docs', 'https://example.com/a', true],
      ['page', 'other.html#x', false],
      ['top', '#top', false],
    ] as const;
    const refused = [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,hi',
      '//evil.example/',
      'mailto:a@example.com',
    ];
    const links = [];
    for (const [text, target, away] of drawn) {
      const said = `See [${text}](${target}) for more.`;
      links.push({ root: await post(request, 'frogs', said), text, target, away, said });
    }
    const literal = [];
    for (const target of refused) {
      const said = `See [here](${target}) for more.`;
      literal.push({ root: await post(request, 'frogs', said), said });
    }
    await page.goto(PAGE);
    await open(page, 'frogs');
    for (const { root, text, target, away, said } of links) {
      const link = bubble(page, root).locator('a');
      await expect(link).toHaveText(text);
      await expect(link).toHaveAttribute('href', target);
      if (away) {
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      } else {
        await expect(link).not.toHaveAttribute('target');
        await expect(link).not.toHaveAttribute('rel');
      }
      expect(await exact(bubble(page, root))).toBe(said.replace(`[${text}](${target})`, text));
    }
    for (const { root, said } of literal) {
      await expect(bubble(page, root).locator('a')).toHaveCount(0);
      expect(await exact(bubble(page, root))).toBe(said);
    }
    await seen.clean();
  });

  test('a bare URL is a link, one to the site opening in the same tab', async ({ page, request }) => {
    const seen = await watch(page);
    const here = `${SITE}/${TARGET}.html`;
    const said = `The target is ${here} and the pond is at https://example.com/pond.`;
    const root = await post(request, 'frogs', said);
    const starred = await post(request, 'frogs', 'Search https://example.com/find* now.');
    await page.goto(PAGE);
    await open(page, 'frogs');
    // A star at the end stays in the URL.
    await expect(bubble(page, starred).locator('a')).toHaveAttribute('href', 'https://example.com/find*');
    const links = bubble(page, root).locator('a');
    await expect(links).toHaveCount(2);
    const [same, away] = [links.nth(0), links.nth(1)];
    await expect(same).toHaveText(here);
    await expect(same).toHaveAttribute('href', here);
    await expect(same).not.toHaveAttribute('target');
    await expect(away).toHaveText('https://example.com/pond');
    await expect(away).toHaveAttribute('href', 'https://example.com/pond');
    await expect(away).toHaveAttribute('target', '_blank');
    await expect(away).toHaveAttribute('rel', 'noopener noreferrer');
    // The full stop is text after the link.
    expect(await away.evaluate((node) => node.nextSibling?.textContent)).toBe('.');
    expect(await exact(bubble(page, root))).toBe(said);
    await seen.clean();

    // Only the same-site link is followed, so nothing is asked of the outside.
    await same.click();
    await page.waitForURL(`**/${TARGET}.html`);
    expect(new URL(page.url()).pathname).toBe(`/${TARGET}.html`);
    expect(page.context().pages()).toHaveLength(1);
  });

  test('a bare URL in a code span, a code block, an image or a refused link draws no link', async ({ page, request }) => {
    const seen = await watch(page);
    const texts = [
      'Run `curl https://example.com/code` first.',
      '```\ncurl https://example.com/fence\n```',
      '![chart](https://example.com/chart.png)',
      '[https://example.com/refused](javascript:alert(1))',
    ];
    const roots = [];
    for (const text of texts) roots.push({ root: await post(request, 'pond', text), text });
    await page.goto(PAGE);
    await open(page, 'pond');
    for (const { root, text } of roots) {
      await expect(bubble(page, root)).toBeVisible();
      await expect(bubble(page, root).locator('a')).toHaveCount(0);
      expect(await exact(bubble(page, root))).toBe(text.replace(/`|\n/g, ''));
    }
    await seen.clean();
  });

  test("the page body's links open off the site in a new tab and on it in the same one", async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const body = page.locator('.artifact-body');
    const away = body.locator('a[href="https://example.com/body"]');
    await expect(away).toHaveAttribute('target', '_blank');
    await expect(away).toHaveAttribute('rel', 'noopener noreferrer');
    for (const href of [`${SITE}/${TARGET}.html`, '#top']) {
      const link = body.locator(`a[href="${href}"]`);
      await expect(link).toHaveCount(1);
      await expect(link).not.toHaveAttribute('target');
    }
    await seen.clean();
  });

  test('a page with no comments and no sections opens its links off the site in a new tab', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(`/${PLAIN}.html`);
    const body = page.locator('.artifact-body');
    const away = body.locator('a[href="https://example.com/plain"]');
    await expect(away).toHaveAttribute('target', '_blank');
    await expect(away).toHaveAttribute('rel', 'noopener noreferrer');
    const protocol = body.locator('a[href="//example.com/protocol"]');
    await expect(protocol).toHaveAttribute('target', '_blank');
    await expect(protocol).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(body.locator('a[href="#top"]')).not.toHaveAttribute('target');
    await page.waitForLoadState('networkidle');
    await seen.clean();
  });

  test('raw HTML and entities are text, never markup', async ({ page, request }) => {
    const seen = await watch(page);
    const script = '<script>window.__pwned = 1</script>';
    const img = '<img src=x onerror="window.__pwned = 1">';
    const entities = '&lt;b&gt;hi&lt;/b&gt; &amp; &#60;i&#62;';
    const bold = '**<b>x</b>**';
    const roots = {
      script: await post(request, 'pond', script),
      img: await post(request, 'pond', img),
      entities: await post(request, 'pond', entities),
      bold: await post(request, 'pond', bold),
    };
    await page.goto(PAGE);
    await open(page, 'pond');

    expect(await exact(bubble(page, roots.script))).toBe(script);
    await expect(bubble(page, roots.script).locator('script')).toHaveCount(0);

    expect(await exact(bubble(page, roots.img))).toBe(img);
    await expect(bubble(page, roots.img).locator('img')).toHaveCount(0);

    expect(await exact(bubble(page, roots.entities))).toBe(entities);
    await expect(bubble(page, roots.entities).locator('b, i')).toHaveCount(0);

    const strong = bubble(page, roots.bold).locator('strong');
    await expect(strong).toHaveCount(1);
    expect(await exact(strong)).toBe('<b>x</b>');
    await expect(bubble(page, roots.bold).locator('b')).toHaveCount(0);

    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    await seen.clean();
  });

  test('a code span, an underscore and a lone asterisk stay as typed', async ({ page, request }) => {
    const seen = await watch(page);
    const roots = {
      code: await post(request, 'frogs', '`**not bold**`'),
      snake: await post(request, 'frogs', 'snake_case_name'),
      times: await post(request, 'frogs', '2 * 3'),
    };
    await page.goto(PAGE);
    await open(page, 'frogs');
    const code = bubble(page, roots.code).locator('code');
    expect(await exact(code)).toBe('**not bold**');
    for (const [root, text] of [[roots.snake, 'snake_case_name'], [roots.times, '2 * 3']] as const) {
      expect(await exact(bubble(page, root))).toBe(text);
    }
    await seen.clean();
  });

  test('an image, a refused link around markup and a four-backtick line stay as typed', async ({ page, request }) => {
    const seen = await watch(page);
    const image = '![fish](https://example.com/fish.jpg)';
    const refused = '[**bad**](javascript:alert(1))';
    const fence = '````\nnot code\n````';
    const roots = {
      image: await post(request, 'pond', image),
      refused: await post(request, 'pond', refused),
      fence: await post(request, 'pond', fence),
    };
    await page.goto(PAGE);
    await open(page, 'pond');
    expect(await exact(bubble(page, roots.image))).toBe(image);
    await expect(bubble(page, roots.image).locator('a, img')).toHaveCount(0);
    expect(await exact(bubble(page, roots.refused))).toBe(refused);
    await expect(bubble(page, roots.refused).locator('a, strong')).toHaveCount(0);
    expect(await exact(bubble(page, roots.fence))).toBe(fence);
    await expect(bubble(page, roots.fence).locator('pre, code')).toHaveCount(0);
    await seen.clean();
  });

  test('a plain two-line comment is one paragraph of two lines, its text unchanged', async ({ page, request }) => {
    const seen = await watch(page);
    const text = 'first line\nsecond line';
    const root = await post(request, 'pond', text);
    await page.goto(PAGE);
    await open(page, 'pond');
    const said = bubble(page, root);
    await expect(said).toBeVisible();
    await expect(said.locator(':scope > *')).toHaveCount(1);
    await expect(said.locator(':scope > p')).toHaveCount(1);
    expect(await exact(said)).toBe(text);
    // Each line's words sit on a line of their own.
    const lines = await said.locator('p').evaluate((p) => {
      const node = p.firstChild!;
      const top = (start: number, end: number) => {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        return range.getBoundingClientRect().top;
      };
      return [top(0, 10), top(11, 22)];
    });
    expect(lines[1]).toBeGreaterThan(lines[0]);
    await seen.clean();
  });

  test("hermes's reply in markdown is drawn as markdown", async ({ page, request }) => {
    test.setTimeout(120_000);
    const seen = await watch(page);
    // hermes pulls first, so it is listening and the comment waits for it.
    hermes('pull', '--owner', OWNER);
    const root = await post(request, 'frogs', 'Is the **pond** ready for winter?');
    await page.goto(PAGE);
    await open(page, 'frogs');
    const node = page.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
    await expect(node).toBeVisible();
    await expect(bubble(page, root).locator('strong')).toHaveText('pond');

    const claim = hermes('claim', String(root.id));
    expect(claim.handle).toBe(OWNER);
    // A claim token may start with '-': give it to its option in one word.
    hermes('reply', String(root.id), `--claim=${claim.claimToken}`, '--key', `markdown-${root.id}`,
      '--text', '**Done.**\n- drained the filter\n- moved the heater');
    const theirs = node.locator('.artifact-comment-item--agent .artifact-comment-text');
    await expect(theirs).toHaveCount(1, { timeout: 15_000 });
    await expect(theirs.locator('strong')).toHaveText('Done.');
    await expect(theirs.locator('ul')).toHaveCount(1);
    await expect(theirs.locator('ul > li')).toHaveText(['drained the filter', 'moved the heater']);
    await seen.clean();
  });
});
