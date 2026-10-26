import { expect, test, type Page } from '@playwright/test';
import {
  ASSERTION, CHECK, HERMES, MEDIA_URL, OUT, PYTHON, RISKY, SIGNED_IN, SOCKET, attachedIn, banner, box, fallBack,
  holdUploads, open, pasteFishOnly, pond, publish, revisionOf, sectioned, selectPassage, source, stopClock,
  watchErrors, watchLoads,
} from './live-page-helpers';

// Wide enough for the side panel: a thread opens in it.
test.use({ viewport: { width: 1440, height: 900 } });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// A republish takes away the section a reader is writing in, holding it back
// under "This section was removed"; a later one shows the banner, and the
// reader presses Reload rather than Update. What they were writing goes where
// Update would have put it: Hazards, added just before the held Risks.
test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  const form = (page: Page, section: string) => page.locator('.artifact-comments-panel form.artifact-comment-form')
    .filter({ has: page.getByRole('textbox', { name: `Comment on ${section}`, includeHidden: true }) });

  // Republish markdown with Risks renamed to Hazards, held back as removed;
  // then republish later, its swap falling back to the banner. The third
  // revision.
  async function holdThenBanner(page: Page, name: string, renamed: string, later: string) {
    const second = publish(name, renamed);
    await page.clock.runFor(CHECK);
    await expect.poll(() => revisionOf(page)).toBe(second);
    const bar = page.locator('div.artifact-section-body[data-section="risks"] div.artifact-swap-held');
    await expect(bar).toContainText('This section was removed');
    await fallBack(page, name);
    const third = publish(name, later);
    await page.clock.runFor(CHECK);
    await expect(banner(page).reload).toBeVisible();
    return { second, third };
  }

  test('a draft in a held removed section is kept over Reload in the form of the section added in its place', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-held-reload-form';
    const title = 'Live held reload form';
    publish(name, source(title, 'first'));
    await stopClock(page);
    await open(page, name);
    await box(page, 'risks').locator('summary').click();
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await form(page, 'Risks').locator('textarea').fill(UNSENT);

    const { third } = await holdThenBanner(page, name,
      source(title, 'first').replace(/Risks/g, 'Hazards'),
      source(title, 'second').replace(/Risks/g, 'Hazards'));
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(third);
    const hazards = form(page, 'Hazards');
    await expect(hazards.locator('textarea')).toHaveValue(UNSENT);
    await expect(hazards.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    await expect(page.locator('.artifact-comments-panel')
      .getByRole('textbox', { name: 'Comment on Next steps', includeHidden: true })).toHaveValue('');
    expect(errors).toEqual([]);
  });

  test('a passage comment in a held removed section is kept over Reload in the form of the section added in its place', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-held-reload-passage';
    publish(name, sectioned(name, pond()));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, 'The pump may crack', 8);
    const UNSENT = 'Which pump is this?';
    await field.fill(UNSENT);

    const { third } = await holdThenBanner(page, name,
      sectioned(name, pond({ Risks: { heading: 'Hazards', paragraphs: [RISKY] } })),
      sectioned(name, pond({ Risks: { heading: 'Hazards', paragraphs: [RISKY] } }), 'The pond, in spring.'));
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(third);
    await expect(page.getByRole('textbox', { name: 'Comment on the selected words' })).toHaveCount(0);
    const hazards = form(page, 'Hazards');
    await expect(hazards.locator('textarea')).toHaveValue(UNSENT);
    await expect(hazards.locator('.artifact-comment-status')).toHaveText(
      'The words you selected have changed since. Your comment is kept here, on the section.');
    await expect(page.locator('.artifact-comments-panel')
      .getByRole('textbox', { name: 'Comment on Next steps', includeHidden: true })).toHaveValue('');
    expect(errors).toEqual([]);
  });

  test('an image still uploading in a held removed section\'s form is waited for by Reload and kept with its text', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-held-reload-image';
    const title = 'Live held reload image';
    publish(name, source(title, 'first'));
    await stopClock(page);
    await open(page, name);
    await box(page, 'risks').locator('summary').click();
    const risks = form(page, 'Risks').locator('textarea');
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await risks.fill(UNSENT);
    const release = await holdUploads(page);
    await pasteFishOnly(risks);
    await expect(page.locator('.artifact-attach-item--loading')).toHaveCount(1);

    const { second, third } = await holdThenBanner(page, name,
      source(title, 'first').replace(/Risks/g, 'Hazards'),
      source(title, 'second').replace(/Risks/g, 'Hazards'));
    const loads = watchLoads(page);
    const fetched = page.waitForResponse((response) => new URL(response.url()).pathname === `/${name}.html` &&
      response.request().resourceType() === 'fetch');
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await fetched;
    // Reload waits for the upload: no load until it is answered.
    await expect(banner(page).reload).toBeDisabled();
    expect(loads.count).toBe(0);
    expect(await revisionOf(page)).toBe(second);

    release();
    await loaded;
    expect(await revisionOf(page)).toBe(third);
    const hazards = form(page, 'Hazards');
    await expect(hazards.locator('textarea')).toHaveValue(UNSENT);
    await expect(hazards.locator('.artifact-attach-item img')).toHaveCount(1);
    expect((await attachedIn(hazards))[0]).toMatch(MEDIA_URL);
    await expect(hazards.locator('.artifact-attach-item--loading')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('an image pasted in another form while Reload waits is waited for too', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-held-reload-another';
    const title = 'Live held reload another';
    publish(name, source(title, 'first'));
    await stopClock(page);
    await open(page, name);
    await box(page, 'risks').locator('summary').click();
    const risks = form(page, 'Risks').locator('textarea');
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await risks.fill(UNSENT);
    const releaseRisks = await holdUploads(page);
    await pasteFishOnly(risks);
    await expect(page.locator('.artifact-attach-item--loading')).toHaveCount(1);

    const { second, third } = await holdThenBanner(page, name,
      source(title, 'first').replace(/Risks/g, 'Hazards'),
      source(title, 'second').replace(/Risks/g, 'Hazards'));
    await box(page, 'findings').locator('summary').click();
    const loads = watchLoads(page);
    const fetched = page.waitForResponse((response) => new URL(response.url()).pathname === `/${name}.html` &&
      response.request().resourceType() === 'fetch');
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await fetched;
    // Begun once Reload's fetch is answered and its first wait begun.
    const releaseFindings = await holdUploads(page);
    const findings = form(page, 'Findings');
    await findings.locator('textarea').fill('Is the heater on a timer?');
    await pasteFishOnly(findings.locator('textarea'));
    await expect(findings.locator('.artifact-attach-item--loading')).toHaveCount(1);

    releaseRisks();
    await expect(form(page, 'Risks').locator('.artifact-attach-item img')).toHaveCount(1);
    // Real time, the page's clock paused: long enough for a reload to begin.
    await page.waitForTimeout(500);
    expect(loads.count).toBe(0);
    expect(await revisionOf(page)).toBe(second);

    releaseFindings();
    await loaded;
    expect(await revisionOf(page)).toBe(third);
    for (const section of ['Hazards', 'Findings']) {
      const kept = form(page, section);
      await expect(kept.locator('.artifact-attach-item img')).toHaveCount(1);
      expect((await attachedIn(kept))[0]).toMatch(MEDIA_URL);
    }
    expect(errors).toEqual([]);
  });
});
