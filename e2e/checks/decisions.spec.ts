import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// The capture fixture's decisions page: two questions, each a form the page
// script answers and draws as an inline card. The fixture names an assertion
// its site accepts; sending it is being signed in, leaving it out is being
// signed out.
const PAGE = '/capture-decisions.html';
const ANSWERS = '/api/answers?page=capture-decisions';
// The fixture's sections page asks one question in each of two sections.
const SECTIONS = '/capture-section-questions.html';
const SECTIONS_ANSWERS = '/api/answers?page=capture-section-questions';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const READER = 'maintainer@example.com';
const SIGNED_OUT = 'You are signed out. Reload the page to sign in.';
// An unsaved card's left rule: the theme's amber, as Chromium reports it.
const AMBER = (() => {
  const tokens = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'lotuspod', '_theme', 'tokens.json'), 'utf-8'));
  const [r, g, b] = (tokens.colors.amber as string).slice(1).match(/../g)!.map((pair) => parseInt(pair, 16));
  return `rgb(${r}, ${g}, ${b})`;
})();

// The forms lotuspod.decisions wrote for this page before decision cards A:
// "(default)" after an option, a note always open, an "Answer" button.
const PUBLISHED_BEFORE = `<div class="artifact-decisions">
<form class="artifact-decision" data-page="capture-decisions" data-question="decision-1" data-version="87f71d1b09cb">
<fieldset>
<legend class="artifact-decision-question"><span class="artifact-decision-number">1</span> <span class="artifact-decision-text">Which model replies?</span></legend>
<p class="artifact-decision-context"><span class="artifact-decision-context-label">Why it matters:</span> Replies run on every comment.</p>
<div class="artifact-decision-options">
<label class="artifact-decision-option"><input type="radio" name="choice" value="sonnet" required> <span class="artifact-decision-label">Sonnet</span> <span class="artifact-decision-mark">(default)</span></label>
<label class="artifact-decision-option"><input type="radio" name="choice" value="opus" required> <span class="artifact-decision-label">Opus</span></label>
</div>
<label class="artifact-decision-note"><span>Note</span><textarea name="note" rows="2" maxlength="4000"></textarea></label>
<div class="artifact-decision-actions"><button type="submit">Answer</button><p class="artifact-decision-status" role="status"></p></div>
</fieldset>
</form>
<form class="artifact-decision" data-page="capture-decisions" data-question="decision-2" data-version="453f315b8ce4">
<fieldset>
<legend class="artifact-decision-question"><span class="artifact-decision-number">2</span> <span class="artifact-decision-text">Keep the archive?</span></legend>
<p class="artifact-decision-context"><span class="artifact-decision-context-label">Why it matters:</span> Old pages stay linkable.</p>
<div class="artifact-decision-options">
<label class="artifact-decision-option"><input type="radio" name="choice" value="yes" required> <span class="artifact-decision-label">Yes</span> <span class="artifact-decision-mark">(default)</span></label>
<label class="artifact-decision-option"><input type="radio" name="choice" value="no" required> <span class="artifact-decision-label">No</span></label>
</div>
<label class="artifact-decision-note"><span>Note</span><textarea name="note" rows="2" maxlength="4000"></textarea></label>
<div class="artifact-decision-actions"><button type="submit">Answer</button><p class="artifact-decision-status" role="status"></p></div>
</fieldset>
</form>
</div>`;

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

function decision(page: Page, question: string) {
  const form = page.locator(`form.artifact-decision[data-question="${question}"]`);
  return {
    form,
    fieldset: form.locator('fieldset'),
    option: (name: string | RegExp) => form.getByRole('radio', { name }),
    radios: form.locator('input[name="choice"]'),
    addNote: form.locator('details.artifact-decision-note > summary'),
    noteBox: form.locator('details.artifact-decision-note'),
    note: form.locator('textarea[name="note"]'),
    save: form.getByRole('button', { name: 'Save answer' }),
    unsaved: form.locator('.artifact-decision-unsaved'),
    hint: form.locator('.artifact-decision-hint'),
    status: form.locator('.artifact-decision-status'),
    saved: form.locator('.artifact-decision-saved-line'),
    savedNote: form.locator('.artifact-decision-saved-note'),
    savedBy: form.locator('.artifact-decision-saved-by'),
    change: form.getByRole('button', { name: 'change' }),
    earlier: form.locator('.artifact-decision-earlier'),
    history: form.locator('.artifact-decision-history'),
  };
}

async function stored(request: APIRequestContext) {
  const response = await request.get(ANSWERS, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  return (await response.json()).questions;
}

// An answer as the answers route returns it.
function row(question: string, version: string, choice: string, note = '') {
  return {
    id: 1, page: 'capture-decisions', question, version, choice, note,
    revision: 'abc123abc123', actor: { kind: 'human', email: READER },
    createdAt: '2026-10-01T09:30:00Z', supersedes: null,
  };
}

// Answer the page's read of the answers route with what answers() holds;
// its posts still reach the site.
async function serve(page: Page, answers: () => object) {
  await page.route((url) => url.pathname === '/api/answers', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { page: 'capture-decisions', questions: answers() } })
      : route.continue());
}

async function versions(page: Page) {
  await page.goto(PAGE);
  return Object.fromEntries(await page.locator('form.artifact-decision').evaluateAll((forms) =>
    forms.map((form) => [(form as HTMLElement).dataset.question, (form as HTMLElement).dataset.version])));
}

// Press Tab from the first question's legend until target has the focus.
async function tabTo(page: Page, target: Locator) {
  await decision(page, 'decision-1').form.locator('legend').click();
  for (let presses = 0; presses < 20; presses += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((node) => node === document.activeElement)) return;
  }
  throw new Error('Tab never reached the target');
}

async function outline(target: Locator) {
  return target.evaluate((node) => {
    const style = getComputedStyle(node);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
}

// The contrast of a node's text colour against what is behind it: the nearest
// ancestor's opaque background, translucent backgrounds composited over it.
async function contrast(target: Locator) {
  return target.evaluate((node) => {
    const parse = (text: string) => {
      const parts = (text.match(/rgba?\(([^)]+)\)/) as RegExpMatchArray)[1]
        .split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    const over = (top: number[], base: number[]) =>
      [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3]));
    const layers: number[][] = [];
    for (let at: Element | null = node; at; at = at.parentElement) {
      const colour = parse(getComputedStyle(at).backgroundColor);
      if (colour[3] > 0) layers.push(colour);
      if (colour[3] >= 1) break;
    }
    let behind = [255, 255, 255];
    for (const layer of layers.reverse()) behind = over(layer, behind);
    const text = over(parse(getComputedStyle(node).color), behind);
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [light, dark] = [luminance(text), luminance(behind)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  });
}

async function fits(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('an unanswered question is radio rows, a quiet default mark and a folded note', async ({ page }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const seen = await watch(page);
    await page.goto(PAGE);
    for (const question of ['decision-1', 'decision-2']) {
      const card = decision(page, question);
      await expect(card.radios).toHaveCount(2);
      const [top, bottom] = [await card.radios.nth(0).boundingBox(), await card.radios.nth(1).boundingBox()];
      expect(bottom!.y).toBeGreaterThan(top!.y + top!.height);
      expect(Math.abs(bottom!.x - top!.x)).toBeLessThan(1);
      for (const radio of await card.radios.all()) await expect(radio).not.toBeChecked();
      await expect(card.addNote).toHaveText('Add a note');
      await expect(card.noteBox).not.toHaveAttribute('open');
      await expect(card.note).toBeHidden();
      await expect(card.hint).toHaveText('Not answered yet');
      await expect(card.hint).toBeVisible();
      await expect(card.unsaved).toBeHidden();
      await expect(card.saved).toHaveCount(0);
      await expect(card.save).toBeVisible();
    }
    const first = decision(page, 'decision-1');
    const mark = first.form.locator('.artifact-decision-option').first().locator('.artifact-decision-default');
    await expect(mark).toBeVisible();
    const drawn = await mark.evaluate((node) =>
      JSON.parse(getComputedStyle(node, '::before').content) + node.textContent);
    expect(drawn).toBe('· default');
    await expect(first.form.locator('.artifact-decision-option').nth(1).locator('.artifact-decision-default'))
      .toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });

  test('a picked answer is marked not saved until saved, then folds to one line', async ({ page, request }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const first = decision(page, 'decision-1');
    await first.option('Opus').check();
    await expect(first.unsaved).toBeVisible();
    await expect(first.unsaved).toHaveText('Not saved');
    await expect(first.hint).toBeHidden();
    await expect(first.fieldset).toHaveCSS('border-left-color', AMBER);

    await first.addNote.click();
    await expect(first.note).toBeVisible();
    await first.note.fill('Opus for page edits');
    await first.save.click();
    await expect(first.saved).toContainText('Saved · Opus · change');
    const answer = (await stored(request))['decision-1'].current;
    expect(answer).toMatchObject({ choice: 'opus', note: 'Opus for page edits' });

    const folded = async () => {
      await expect(first.saved).toContainText('Saved · Opus · change');
      await expect(first.savedNote).toHaveText('Opus for page edits');
      await expect(first.savedBy).toContainText(READER);
      await expect(first.savedBy).not.toContainText('replaced');
      for (const radio of await first.radios.all()) await expect(radio).toBeHidden();
      await expect(first.note).toBeHidden();
      await expect(first.save).toBeHidden();
      await expect(first.unsaved).toBeHidden();
      await expect(first.fieldset).not.toHaveCSS('border-left-color', AMBER);
    };
    await folded();
    await expect(first.change).toBeFocused();

    await page.reload();
    await folded();

    await first.change.click();
    await expect(first.option('Opus')).toBeChecked();
    await expect(first.option('Opus')).toBeFocused();
    await expect(first.noteBox).toHaveAttribute('open');
    await expect(first.note).toHaveValue('Opus for page edits');
    await expect(first.unsaved).toBeHidden();
    await expect(first.saved).toBeHidden();

    await first.option(/^Sonnet/).check();
    await expect(first.unsaved).toBeVisible();
    await first.save.click();
    await expect(first.saved).toContainText('Saved · Sonnet · change');
    await expect(first.savedBy).toContainText('replaced an earlier answer');
    await expect(first.history.locator('summary')).toHaveText('1 earlier answer');
    await first.history.locator('summary').click();
    await expect(first.history.locator('li')).toHaveCount(1);
    await expect(first.history.locator('li')).toContainText('Opus');
    await expect(first.history.locator('li')).toContainText('Opus for page edits');
    expect(seen.errors).toEqual([]);
  });

  test('a pick changed while an answer is saving stays open and not saved', async ({ page, request }) => {
    const seen = await watch(page);
    // Hold the post until the reader has picked again.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === '/api/answers', async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    });
    await page.goto(PAGE);
    const first = decision(page, 'decision-1');
    if (await first.change.isVisible()) await first.change.click();
    await first.option('Opus').check();
    await first.save.click();
    await expect(first.status).toHaveText('Saving your answer...');
    await first.option(/^Sonnet/).check();
    release();

    await expect(first.status).toHaveText('');
    expect((await stored(request))['decision-1'].current).toMatchObject({ choice: 'opus' });
    await expect(first.saved).toBeHidden();
    await expect(first.option(/^Sonnet/)).toBeChecked();
    await expect(first.unsaved).toBeVisible();
    await expect(first.fieldset).toHaveCSS('border-left-color', AMBER);

    await first.save.click();
    await expect(first.saved).toContainText('Saved \u00b7 Sonnet \u00b7 change');
    await expect(first.savedBy).toContainText('replaced an earlier answer');
    expect(seen.errors).toEqual([]);
  });

  test('a note is shown as the text written, never as markup', async ({ page }) => {
    const note = '<b>bold</b>';
    await page.goto(PAGE);
    const second = decision(page, 'decision-2');
    await second.option(/^Yes/).check();
    await second.addNote.click();
    await second.note.fill(note);
    await second.save.click();
    await expect(second.saved).toContainText('Saved · Yes · change');
    await expect(second.savedNote).toHaveText(note);
    await expect(page.locator('b')).toHaveCount(0);

    await page.reload();
    await expect(second.saved).toContainText('Saved · Yes · change');
    await expect(second.savedNote).toHaveText(note);
    await expect(page.locator('b')).toHaveCount(0);
  });

  test('an answer to an earlier wording leaves the card open and unpicked', async ({ page }) => {
    await serve(page, () => ({
      'decision-1': { current: row('decision-1', '000000000000', 'opus', 'Old words'), earlier: [] },
    }));
    await page.goto(PAGE);
    const first = decision(page, 'decision-1');
    await expect(first.earlier).toContainText(`Answered to an earlier wording by ${READER}`);
    await expect(first.saved).toHaveCount(0);
    for (const radio of await first.radios.all()) {
      await expect(radio).toBeVisible();
      await expect(radio).not.toBeChecked();
    }
    await expect(first.save).toBeVisible();
    await expect(first.unsaved).toBeHidden();
  });

  test('a form published before the cards still saves and folds', async ({ page, request }) => {
    const seen = await watch(page);
    await page.route((url) => url.pathname === PAGE, async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replace(/<div class="artifact-decisions">[\s\S]*<\/form>\n<\/div>/, PUBLISHED_BEFORE);
      await route.fulfill({ response, body });
    });
    // Nothing answered yet, as when the page was first published.
    await serve(page, () => ({}));
    await page.goto(PAGE);
    const second = decision(page, 'decision-2');
    const answer = second.form.getByRole('button', { name: 'Answer' });
    await expect(answer).toBeVisible();
    await expect(second.form.locator('.artifact-decision-mark')).toHaveText('(default)');
    await expect(second.note).toBeVisible();

    await second.option('No').check();
    await second.note.fill('From the page as first published');
    await answer.click();
    await expect(second.saved).toContainText('Saved · No · change');
    await expect(second.savedNote).toHaveText('From the page as first published');
    expect((await stored(request))['decision-2'].current)
      .toMatchObject({ choice: 'no', note: 'From the page as first published' });
    for (const radio of await second.radios.all()) await expect(radio).toBeHidden();
    await expect(second.note).toBeHidden();
    await expect(answer).toBeHidden();

    await second.change.click();
    await expect(second.option('No')).toBeChecked();
    await expect(second.note).toBeVisible();
    await expect(second.note).toHaveValue('From the page as first published');
    expect(seen.errors).toEqual([]);
  });

  test('focus is outlined and the quiet text keeps its contrast', async ({ page }) => {
    const seen = await watch(page);
    const version = await versions(page);
    await serve(page, () => ({
      'decision-1': { current: row('decision-1', version['decision-1'], 'opus', 'Opus for page edits'), earlier: [] },
    }));
    await page.reload();
    const first = decision(page, 'decision-1');
    const second = decision(page, 'decision-2');
    await expect(first.change).toBeVisible();

    for (const target of [second.radios.first(), second.addNote, first.change]) {
      await tabTo(page, target);
      const drawn = await outline(target);
      expect(drawn.style).toBe('solid');
      expect(drawn.width).toBeGreaterThanOrEqual(2);
    }

    await page.mouse.move(0, 0);
    for (const target of [
      second.form.locator('.artifact-decision-default'), second.hint, first.saved, first.savedBy,
    ]) {
      await expect(target).toBeVisible();
      expect(await contrast(target)).toBeGreaterThanOrEqual(4.5);
    }
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test('an answer saved in the second section folds there and leaves the first section open', async ({ page, request }) => {
    const seen = await watch(page);
    await page.goto(SECTIONS);
    const pump = decision(page, 'decision-d1');
    const heater = decision(page, 'decision-d2');
    // Each question sits in its own section, under the heading it is about.
    const order = await page.evaluate(() => [
      ...document.querySelectorAll('h2, form.artifact-decision'),
    ].map((node) => (node as HTMLElement).dataset.question ?? node.textContent!.trim()));
    expect(order).toEqual(['Pump', 'decision-d1', 'Heater', 'decision-d2']);

    await heater.option('Solar').check();
    await expect(heater.unsaved).toBeVisible();
    await heater.save.click();
    const folded = async () => {
      await expect(heater.saved).toContainText('Saved · Solar · change');
      for (const radio of await heater.radios.all()) await expect(radio).toBeHidden();
      await expect(heater.save).toBeHidden();
      await expect(pump.saved).toHaveCount(0);
      await expect(pump.hint).toHaveText('Not answered yet');
      await expect(pump.unsaved).toBeHidden();
      await expect(pump.save).toBeVisible();
      for (const radio of await pump.radios.all()) {
        await expect(radio).toBeVisible();
        await expect(radio).not.toBeChecked();
      }
    };
    await folded();
    const response = await request.get(SECTIONS_ANSWERS, { headers: SIGNED_IN });
    const questions = (await response.json()).questions;
    expect(Object.keys(questions)).toEqual(['decision-d2']);
    expect(questions['decision-d2'].current).toMatchObject({ choice: 'solar' });

    await page.reload();
    await folded();
    expect(seen.errors).toEqual([]);
  });

  test('at 360 pixels wide the cards fit, open, unsaved and folded', async ({ page }) => {
    const seen = await watch(page);
    await page.setViewportSize({ width: 360, height: 780 });
    const version = await versions(page);
    let questions: object = {};
    await serve(page, () => questions);
    await page.reload();
    const first = decision(page, 'decision-1');
    await expect(first.hint).toBeVisible();
    await fits(page);

    await first.option('Opus').check();
    await first.addNote.click();
    await first.note.fill('A note long enough to wrap: '.repeat(6));
    await expect(first.unsaved).toBeVisible();
    await fits(page);

    questions = {
      'decision-1': {
        current: { ...row('decision-1', version['decision-1'], 'opus', 'Opus for page edits, '.repeat(8)), supersedes: 1 },
        earlier: [row('decision-1', version['decision-1'], 'sonnet', 'First thoughts')],
      },
    };
    await page.reload();
    await expect(first.saved).toContainText('Saved · Opus · change');
    await first.history.locator('summary').click();
    await fits(page);
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });
});

test.describe('signed out', () => {
  test('an answer is refused with a way to sign in, and nothing is stored', async ({ page, request }) => {
    const before = await stored(request);
    await page.goto(PAGE);
    const second = decision(page, 'decision-2');
    await second.option('No').check();
    await second.addNote.click();
    await second.note.fill('Not signed in');
    await second.save.click();
    await expect(second.status).toHaveText(SIGNED_OUT);
    await expect(second.unsaved).toBeVisible();
    await expect(second.save).toBeVisible();
    await expect(second.saved).toHaveCount(0);
    await expect(second.save).toBeEnabled();
    expect(await stored(request)).toEqual(before);
  });
});
