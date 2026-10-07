import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// On a demo page the title sits the theme's own distance below the demo
// banner, as on a plain page it sits that distance below the topbar. The
// oracle is the theme: README.md is published here by plain `lotuspod
// publish --local`, with no banner, served from a scratch directory on
// 127.0.0.1, and its topbar-to-title gap measured beside the demo's
// banner-to-title gap on readme.html.

const ROOT = path.resolve(__dirname, '..', '..');
const VENV_PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
const PYTHON = process.env.PYTHON
  ?? (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
const PAGE = 'readme';
const TOLERANCE = 2;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

let scratch = '';
let server: http.Server;
let reference = '';

test.beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-title-gap-'));
  const site = path.join(scratch, 'site');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  execFileSync(PYTHON, [
    '-m', 'lotuspod', 'publish', path.join(ROOT, 'README.md'), '--local',
    '--out-dir', site, '--name', PAGE, '--base', ROOT,
  ], {
    cwd: scratch,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, 'src'),
      LOTUSPOD_CONFIG: path.join(scratch, 'no-such-config.ini'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      HOME: home,
    },
    stdio: 'pipe',
  });
  server = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    const file = path.join(site, path.normalize(name));
    if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  reference = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${PAGE}.html`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

// The distance from the bottom of the element above the page (the banner,
// or else the topbar) to the top of the title, and the page's variant.
async function gap(page: Page, above: string) {
  await expect(page.locator('.artifact-header h1')).toBeVisible();
  return page.evaluate((above) => {
    const edge = document.querySelector(above)!.getBoundingClientRect().bottom;
    const title = document.querySelector('.artifact-header h1')!.getBoundingClientRect().top;
    return { gap: title - edge, main: document.querySelector('main')!.className };
  }, above);
}

// Both measured at one width: the demo's banner-to-title gap is within
// TOLERANCE of the plain page's topbar-to-title gap, and the demo page
// doesn't scroll horizontally.
async function checkGap(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });

  await page.goto(reference);
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  const plain = await gap(page, '.artifact-topbar');

  await page.goto(`/${PAGE}.html`);
  await expect(page.locator('body > .demo-banner')).toBeVisible();
  const demo = await gap(page, 'body > .demo-banner');

  expect(demo.main, 'the same variant on both pages').toBe(plain.main);
  expect(plain.gap, 'the theme leaves a gap above the title').toBeGreaterThan(0);
  expect(Math.abs(demo.gap - plain.gap),
    `banner-to-title ${demo.gap}px, topbar-to-title ${plain.gap}px`).toBeLessThanOrEqual(TOLERANCE);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the document does not scroll horizontally').toBeLessThanOrEqual(0);
}

test("at 1280 px the title sits the theme's distance below the banner", async ({ page }) => {
  await checkGap(page, 1280);
});

test("at 400 px the title sits the theme's distance below the banner", async ({ page }) => {
  await checkGap(page, 400);
});
