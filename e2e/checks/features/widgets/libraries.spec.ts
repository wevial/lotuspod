import { expect, test, type Page } from '@playwright/test';
import { charts, publish, routeLibraries, signedIn } from './libraries-fixture';

test.use({ extraHTTPHeaders: signedIn });

// A widget frame still loading through a route handler's route.fetch when a
// check ends would otherwise fail that check with "Test ended".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
type Violation = { blockedURI: string; effectiveDirective: string };

async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    (window as any).violations = [];
    document.addEventListener('securitypolicyviolation', event => {
      (window as any).violations.push({blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective});
    });
  });
  await routeLibraries(page);
  return { errors, violations: async () => (await Promise.all(page.frames().map(frame => frame.evaluate(() => (window as any).violations as Violation[])))).flat() };
}

test('three libraries draw charts in separate frames without errors', async ({ page }) => {
  publish('library-charts', charts);
  const seen = await watch(page);
  await page.goto('/library-charts.html?standalone');
  await expect(page.locator('iframe.artifact-widget')).toHaveCount(3);
  const d3 = page.frameLocator('iframe').nth(0);
  const plot = page.frameLocator('iframe').nth(1);
  const chart = page.frameLocator('iframe').nth(2);
  await expect(d3.locator('circle')).toHaveCount(7);
  await expect(d3.locator('circle').first()).toHaveAttribute('r', '12');
  await expect(plot.locator('#plot svg')).toBeVisible();
  await expect(plot.locator('#plot svg rect')).toHaveCount(7);
  await expect(chart.locator('canvas')).toBeVisible();
  expect(await chart.locator('canvas').evaluate(canvas =>
    (window as any).Chart.getChart(canvas).getDatasetMeta(0).data.length
  )).toBe(7);
  expect(await chart.locator('canvas').evaluate((canvas: HTMLCanvasElement) =>
    canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data.some(value => value !== 0)
  )).toBe(true);
  expect(await seen.violations()).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('an unlisted head script and an inline handler are the only policy violations', async ({ page }) => {
  const unlisted = 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js';
  publish('library-refusals', `# Refused scripts
\`\`\`html live d3 title="Unlisted script"
<p id="external">Nothing written.</p>
\`\`\`
\`\`\`html live title="Inline handler"
<button onclick="document.querySelector('#handler').textContent = 'Ran'">Press me</button><p id="handler">Nothing written.</p>
\`\`\`
`);
  // Inject into the actual document head to exercise the emitted policy even
  // when a script is added outside the compiler's pinned-library tags.
  await page.route('**/library-refusals.w-*.html', async route => {
    const response = await route.fetch();
    let body = await response.text();
    if (body.includes('id="external"')) {
      body = body.replace('</head>', `<script src="${unlisted}"></script></head>`);
    }
    await route.fulfill({ response, body });
  });
  let requested = false;
  await page.route(unlisted, route => {
    requested = true;
    return route.fulfill({contentType: 'text/javascript', headers: {'Access-Control-Allow-Origin': '*'}, body: "window.unlistedRan = true; document.querySelector('#external').textContent = 'Ran';"});
  });
  const seen = await watch(page);
  await page.goto('/library-refusals.html?standalone');
  const external = page.frameLocator('iframe').nth(0);
  const handler = page.frameLocator('iframe').nth(1);
  await handler.getByRole('button', { name: 'Press me' }).click();
  await expect(external.locator('head script[src="' + unlisted + '"]')).toHaveCount(1);
  await expect(external.locator('#external')).toHaveText('Nothing written.');
  expect(await external.locator('body').evaluate(() => (window as any).unlistedRan)).toBeUndefined();
  await expect(handler.locator('#handler')).toHaveText('Nothing written.');
  await expect.poll(seen.violations).toHaveLength(2);
  expect(await seen.violations()).toEqual([
    {blockedURI: unlisted, effectiveDirective: 'script-src-elem'},
    {blockedURI: 'inline', effectiveDirective: 'script-src-attr'},
  ]);
  expect(requested).toBe(false);
  expect(seen.errors).toHaveLength(2);
  for (const error of seen.errors) expect(error).toContain('Content Security Policy');
});

test('page Mermaid and widget Mermaid draw independently', async ({ page }) => {
  publish('library-mermaid', `# Two diagrams
\`\`\`mermaid
flowchart LR
  Draft --> Publish
\`\`\`
\`\`\`html live mermaid title="Widget diagram"
<pre class="mermaid">flowchart LR
  Read --> Reflect</pre>
<script>mermaid.initialize({startOnLoad: false, theme: 'dark'}); mermaid.run();</script>
\`\`\`
`);
  const seen = await watch(page);
  await page.goto('/library-mermaid.html?standalone');
  await expect(page.locator('pre.mermaid svg')).toBeVisible();
  await expect(page.locator('pre.mermaid svg')).toContainText('Publish');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('pre.mermaid svg')).toBeVisible();
  await expect(frame.locator('pre.mermaid svg')).toContainText('Reflect');
  expect(await seen.violations()).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('changed bytes at a pinned URL fail integrity and do not execute', async ({ page }) => {
  publish('library-integrity', `# Integrity
\`\`\`html live d3 title="Checked library"
<p id="ready">Loading</p>
<script>document.querySelector('#ready').textContent = 'Ready';</script>
\`\`\`
`);
  const seen = await watch(page);
  await page.route('**/d3@*/dist/d3.min.js', route => route.fulfill({
    contentType: 'text/javascript', headers: {'Access-Control-Allow-Origin': '*'},
    body: 'window.substitutedLibraryRan = true;',
  }));
  await page.goto('/library-integrity.html?standalone');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#ready')).toHaveText('Ready');
  expect(await frame.locator('body').evaluate(() => (window as any).substitutedLibraryRan)).toBeUndefined();
  expect(await seen.violations()).toEqual([]);
  expect(seen.errors).toHaveLength(1);
  expect(seen.errors[0]).toContain('integrity');
});
