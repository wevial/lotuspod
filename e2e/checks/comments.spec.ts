import { expect, test, type Page } from '@playwright/test';

// The capture fixture's comments page: three sections, each ending in a
// comment box, owned by hermes. The fixture names an assertion its site
// accepts; sending it is being signed in.
const PAGE = '/capture-comments.html';
const THREADS = (url: URL) => url.pathname === '/api/comments';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const READER = 'maintainer@example.com';
const OWNER = 'hermes';

function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function box(page: Page, section: string) {
  const details = page.locator(`details.artifact-comment[data-section="${section}"]`);
  return {
    details,
    summary: details.locator('summary'),
    text: details.locator('form.artifact-comment-form textarea[name="text"]'),
    comment: details.getByRole('button', { name: 'Comment', exact: true }),
    threads: details.locator('.artifact-comment-thread'),
  };
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
    actor: { kind: 'human', email: READER },
    createdAt: '2026-09-30T10:00:00.000Z',
    state: 'pending',
    ...fields,
  };
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('a comment starts a thread that is there again after a reload, and takes a reply', async ({ page }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const errors = watch(page);
    await page.goto(PAGE);
    await expect(page.locator('details.artifact-comment')).toHaveCount(3);
    const risks = box(page, 'risks');
    await expect(risks.summary).toHaveText('Comment');
    await risks.summary.click();
    await expect(risks.text).toBeVisible();

    await risks.text.fill('This step is out of order.');
    await risks.comment.click();
    await expect(risks.threads).toHaveCount(1);
    const thread = risks.threads.first();
    await expect(thread.locator('.artifact-comment-author')).toHaveText(READER);
    await expect(thread.locator('.artifact-comment-text')).toHaveText('This step is out of order.');
    await expect(thread.locator('.artifact-comment-state')).toHaveText(`waiting for ${OWNER}`);
    await expect(risks.text).toHaveValue('');
    await expect(risks.summary).toHaveText('Comments (1)');

    await page.reload();
    await expect(risks.summary).toHaveText('Comments (1)');
    await expect(box(page, 'findings').summary).toHaveText('Comment');
    await risks.summary.click();
    await expect(risks.threads).toHaveCount(1);
    await expect(thread.locator('.artifact-comment-text')).toHaveText('This step is out of order.');
    await expect(thread.locator('.artifact-comment-state')).toHaveText(`waiting for ${OWNER}`);

    await thread.locator('form.artifact-comment-reply textarea[name="text"]').fill('It follows the heater.');
    await thread.getByRole('button', { name: 'Reply' }).click();
    const items = thread.locator('.artifact-comment-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(1).locator('.artifact-comment-text')).toHaveText('It follows the heater.');
    await expect(items.nth(1).locator('.artifact-comment-author')).toHaveText(READER);
    expect(errors).toEqual([]);
  });

  test('every state, an agent reply with its revision, a stray thread and markup as text', async ({ page }) => {
    const errors = watch(page);
    const revised = row({ state: 'answered', text: 'Swap steps two and three?', revision: 'a1b2c3a1b2c3' });
    const agent = { kind: 'agent', handle: OWNER };
    const threads = [
      { root: row({ state: 'pending' }), replies: [] },
      { root: row({ state: 'unavailable' }), replies: [] },
      { root: row({ state: 'claimed', section: 'risks', sectionTitle: 'Risks' }), replies: [] },
      {
        root: revised,
        replies: [
          row({ parent: revised.id, state: 'answered', text: 'Swapped them.', revision: '3f9a2c3f9a2c', actor: agent }),
          // The same revision as the thread's first comment: still a revision the reply carries.
          row({ parent: revised.id, state: 'answered', text: 'Swapped again.', revision: 'a1b2c3a1b2c3', actor: agent }),
          row({ parent: revised.id, state: 'answered', text: 'No change needed.', revision: '', actor: agent }),
        ],
      },
      {
        root: row({ state: 'failed', reason: 'the model timed out', section: 'next-steps', sectionTitle: 'Next steps' }),
        replies: [],
      },
      { root: row({ state: 'paused', section: 'next-steps', sectionTitle: 'Next steps' }), replies: [] },
      { root: row({ section: 'old-plan', sectionTitle: 'Old plan', text: 'On a section since removed.' }), replies: [] },
      { root: row({ text: '<img src="x.png" alt="injected">' }), replies: [] },
    ];
    await page.route(THREADS, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { page: 'capture-comments', threads } })
        : route.continue());
    await page.goto(PAGE);

    const findings = box(page, 'findings');
    await expect(findings.summary).toHaveText('Comments (4)');
    await expect(box(page, 'risks').summary).toHaveText('Comments (1)');
    await expect(box(page, 'next-steps').summary).toHaveText('Comments (2)');
    for (const section of ['findings', 'risks', 'next-steps']) {
      await box(page, section).summary.click();
    }
    const states = page.locator('.artifact-comment-state');
    for (const label of [
      `waiting for ${OWNER}`,
      `${OWNER} is offline; queued for it`,
      `${OWNER} is answering`,
      'answered',
      `${OWNER} could not answer: the model timed out`,
      'the responder is paused',
    ]) {
      await expect(states.filter({ hasText: new RegExp(`^${label}$`) }).first()).toBeVisible();
    }

    const reply = findings.threads.nth(2).locator('.artifact-comment-item').nth(1);
    await expect(reply.locator('.artifact-comment-agent')).toHaveText(OWNER);
    await expect(reply.locator('.artifact-comment-state')).toHaveCount(0);
    const link = reply.getByRole('link', { name: /^Revised the page/ });
    await expect(link).toHaveText('Revised the page · revision 3f9a2c3f9a2c');
    await expect(link).toHaveAttribute('href', 'capture-comments.html');
    const same = findings.threads.nth(2).locator('.artifact-comment-item').nth(2);
    await expect(same.locator('.artifact-comment-text')).toHaveText('Swapped again.');
    const sameLink = same.getByRole('link', { name: /^Revised the page/ });
    await expect(sameLink).toHaveText('Revised the page \u00b7 revision a1b2c3a1b2c3');
    await expect(sameLink).toHaveAttribute('href', 'capture-comments.html');
    const none = findings.threads.nth(2).locator('.artifact-comment-item').nth(3);
    await expect(none.locator('.artifact-comment-text')).toHaveText('No change needed.');
    await expect(none.getByRole('link')).toHaveCount(0);

    const changed = page.locator('.artifact-comments-changed');
    await expect(changed.getByRole('heading', { name: 'Comments on sections that have changed' })).toBeVisible();
    await expect(changed.locator('.artifact-comment-thread')).toHaveCount(1);
    await expect(changed).toContainText('On Old plan');
    await expect(changed.locator('.artifact-comment-text')).toHaveText('On a section since removed.');

    await expect(findings.threads.nth(3).locator('.artifact-comment-text'))
      .toHaveText('<img src="x.png" alt="injected">');
    await expect(page.locator('img')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a section id that names an object property still holds its own threads', async ({ page }) => {
    const errors = watch(page);
    // The fixture's page as served, its third section's id and box renamed
    // "__proto__", as an author's explicit id would render.
    await page.route((url) => url.pathname === PAGE, async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replaceAll('id="next-steps"', 'id="__proto__"')
        .replaceAll('data-section="next-steps"', 'data-section="__proto__"');
      await route.fulfill({ response, body });
    });
    const threads = [
      { root: row({ section: '__proto__', sectionTitle: 'Next steps', text: 'On the renamed section.' }), replies: [] },
      { root: row({ section: 'constructor', sectionTitle: 'Constructor', text: 'On no section here.' }), replies: [] },
    ];
    await page.route(THREADS, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { page: 'capture-comments', threads } })
        : route.continue());
    await page.goto(PAGE);

    const proto = box(page, '__proto__');
    await expect(proto.summary).toHaveText('Comments (1)');
    await proto.summary.click();
    await expect(proto.threads.locator('.artifact-comment-text')).toHaveText('On the renamed section.');
    const changed = page.locator('.artifact-comments-changed');
    await expect(changed.locator('.artifact-comment-thread')).toHaveCount(1);
    await expect(changed.locator('.artifact-comment-text')).toHaveText('On no section here.');
    expect(errors).toEqual([]);
  });
});
