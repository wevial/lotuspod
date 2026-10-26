import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

// A spot thread whose image has left the page is headed with the image's
// alt text in any browser: serve stores the target's title with the spot.
// The check publishes pages of its own as hermes on the capture fixture's
// site with a real `lotuspod publish`: a section Pictures holding the
// fixture's fish as "Pond fish at dusk". A box on it is posted through the
// page's route, then the page is published again without the image and
// opened in a new context. A thread stored as one
// was before titles were kept falls back as before. The run shares one
// database, so each repeat publishes pages of its own names.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const OWNER = 'hermes';
const FISH = path.resolve(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'media', 'fish-320x240.jpg');
const ALT = 'Pond fish at dusk';
const ID = 'pond-fish-at-dusk';
const VIEWPORT = { width: 1280, height: 800 };
// features/publish/ts/page-open.js's CHANGED_GROUP.
const CHANGED_GROUP = 'Sections that have changed';

test.use({ viewport: VIEWPORT, extraHTTPHeaders: SIGNED_IN });

// The page: a section Notes, and Pictures holding the fish as alt, none
// without it.
function doc(alt: string | null = ALT) {
  return ['# Spot titles', '', 'Where a comment on a picture lands.', '',
    '## Notes', '', 'What the pond holds.', '', '## Pictures', '', 'The pond as it is.', '', ...(alt === null ? [] : [`![${alt}](fish.jpg)`, ''])].join('\n');
}

function run(args: string[], input?: string) {
  return execFileSync(PYTHON, args, {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish(name: string, markdown: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-spot-titles-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    fs.copyFileSync(FISH, path.join(dir, 'fish.jpg'));
    const said = run(['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, '--comments']);
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A thread on the fish stored as one was before titles were kept: its spot
// has no title.
function storeOld(name: string, revision: string, hash: string) {
  const script = [
    'import json, sys',
    'from pathlib import Path',
    'from lotuspod.features.serve import serve_db_path',
    'from lotuspod.store.db import Database',
    'name, revision, spot, out = json.loads(sys.stdin.read())',
    'Database(serve_db_path(Path(out), "")).add_comment(',
    '    page=name, section="pictures", section_title="Pictures", revision=revision,',
    '    text="An older note.", quote=None, actor={"kind": "human", "email": "reader@example.com"},',
    '    owner="hermes", spot=spot)',
  ].join('\n');
  const spot = { id: ID, hash, shape: { kind: 'box', x: 20, y: 20, w: 120, h: 90 }, nodes: [] };
  run(['-c', script], JSON.stringify([name, revision, spot, OUT]));
}

function errorsOf(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

// Load a page on its own, once its threads are read.
async function load(page: Page, name: string) {
  await page.goto(`/${name}.html?standalone`);
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
}

function image(page: Page) {
  return page.locator(`figure.artifact-figure img[data-spot="${ID}"]`);
}

// The entries listed under the changed sections, and their headings.
function strays(page: Page) {
  const entries = page.locator('aside.artifact-comments-panel .artifact-comments-group')
    .filter({ has: page.locator(':scope > .artifact-comments-group-title', { hasText: CHANGED_GROUP }) })
    .locator('.artifact-comments-entry');
  return {
    entries,
    headings: () => entries.evaluateAll((found) =>
      found.map((entry) => entry.querySelector('.artifact-comments-entry-words')?.textContent)),
  };
}

// Publish name with the fish and post a box on it through the page's route.
async function boxOnFish(page: Page, name: string) {
  publish(name, doc());
  await load(page, name);
  const spot = {
    id: await image(page).getAttribute('data-spot'),
    hash: await image(page).getAttribute('data-spot-hash'),
    shape: { kind: 'box', x: 40, y: 30, w: 100, h: 80 },
    nodes: [],
  };
  expect(spot.id).toBe(ID);
  const answer = await page.request.post('/api/comments', {
    data: { page: name, section: 'pictures', text: 'Is this the biggest one?', spot },
  });
  expect(answer.status()).toBe(201);
  expect((await answer.json()).spot).toEqual({ ...spot, title: ALT });
}

async function fresh(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: VIEWPORT, extraHTTPHeaders: SIGNED_IN });
}

test('a removed or renamed image\'s thread is headed with its alt text in a new browser', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const errors = errorsOf(page);
  const repeat = test.info().repeatEachIndex;
  const removed = `spot-titles-removed-${repeat}`;
  const renamed = `spot-titles-renamed-${repeat}`;
  await boxOnFish(page, removed);
  publish(removed, doc(null));
  await boxOnFish(page, renamed);
  publish(renamed, doc('Koi at dusk'));
  expect(errors).toEqual([]);

  for (const name of [removed, renamed]) {
    const context = await fresh(browser);
    try {
      const other = await context.newPage();
      const otherErrors = errorsOf(other);
      await load(other, name);
      await expect(image(other)).toHaveCount(0);
      const listed = strays(other);
      await expect(listed.entries).toHaveCount(1);
      await expect.poll(listed.headings).toEqual([`On ${ALT}`]);
      expect(otherErrors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('a thread stored before titles were kept is headed as before', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const errors = errorsOf(page);
  const name = `spot-titles-old-${test.info().repeatEachIndex}`;
  publish(name, doc());
  await load(page, name);
  const hash = await image(page).getAttribute('data-spot-hash');
  const listed = await page.request.get(`/api/comments?page=${name}`);
  expect(listed.status()).toBe(200);
  storeOld(name, (await listed.json()).revision, hash ?? '');

  // Shown while the image is on the page, its title is remembered here.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
  await expect(image(page)).toHaveCount(1);
  publish(name, doc(null));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
  const here = strays(page);
  await expect(here.entries).toHaveCount(1);
  await expect.poll(here.headings).toEqual([`On ${ALT}`]);
  expect(errors).toEqual([]);

  const context = await fresh(browser);
  try {
    const other = await context.newPage();
    const otherErrors = errorsOf(other);
    await load(other, name);
    const there = strays(other);
    await expect(there.entries).toHaveCount(1);
    await expect.poll(there.headings).toEqual(['On Pictures']);
    expect(otherErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
