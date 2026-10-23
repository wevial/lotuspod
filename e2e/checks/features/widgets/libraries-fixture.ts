import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Page } from '@playwright/test';

const env = process.env;
export const signedIn = { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' };
const python = env.LOTUSPOD_TEST_PYTHON!;
const pythonEnv = { ...env, PYTHONPATH: path.resolve(__dirname, '../../../../src') };

export function publish(name: string, source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libraries-'));
  try {
    const file = path.join(dir, name + '.md');
    fs.writeFileSync(file, source);
    execFileSync(python, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes', '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!], { env: pythonEnv });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export async function routeLibraries(page: Page) {
  const libraries = JSON.parse(execFileSync(python, ['-c', 'import json; from lotuspod.features.widgets.libraries import LIBRARIES; print(json.dumps([dict(url=l.url, package=l.package, file=l.file) for l in LIBRARIES.values()]))'], { env: pythonEnv, encoding: 'utf8' }));
  for (const lib of libraries) {
    await page.route(lib.url, route => route.fulfill({
      contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
      body: fs.readFileSync(path.resolve(__dirname, '../../../node_modules', lib.package, lib.file)),
    }));
  }
  // The trusted page continues to use its own Mermaid module build.
  const prefix = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/';
  await page.route(prefix + '**', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
    body: fs.readFileSync(path.resolve(__dirname, '../../../node_modules/mermaid', route.request().url().slice(prefix.length))),
  }));
}

const style = '<style>body { padding: 12px; box-sizing: border-box; } svg { max-width: 100%; } h3 { margin: 0 0 8px; font-size: 15px; font-weight: 500; }</style>';
export const charts = `# A week in the reading room

Three views of the same week, each drawn inside its own live frame.

\`\`\`html live d3 title="d3 · Daily activity" height=150
${style}<h3>d3 · Daily activity</h3><svg width="640" height="100" aria-label="Seven days of activity"></svg>
<script>
d3.select('svg').selectAll('circle').data([12, 24, 18, 32, 26, 38, 30]).join('circle')
  .attr('cx', (_, i) => 45 + i * 85).attr('cy', 45).attr('r', d => d)
  .attr('fill', '#b79cf4');
d3.select('svg').selectAll('text').data(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']).join('text')
  .attr('x', (_, i) => 45 + i * 85).attr('y', 96).attr('text-anchor', 'middle').attr('fill', '#b8b3c5').text(d => d);
</script>
\`\`\`

\`\`\`html live plot title="Observable Plot · Pages read" height=210
${style}<h3>Observable Plot · Pages read</h3><div id="plot"></div>
<script>
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
document.querySelector('#plot').append(Plot.plot({width: 640, height: 160, marginBottom: 25,
  x: {label: null, domain: days}, y: {label: null, grid: true},
  marks: [Plot.barY([12, 24, 18, 32, 26, 38, 30].map((pages, i) => ({day: days[i], pages})), {x: 'day', y: 'pages', fill: '#8bcbb7'})]}));
</script>
\`\`\`

\`\`\`html live chartjs title="Chart.js · Reading rhythm" height=210
${style}<h3>Chart.js · Reading rhythm</h3><canvas width="640" height="160" aria-label="Pages read through the week"></canvas>
<script>
Chart.defaults.color = '#b8b3c5';
new Chart(document.querySelector('canvas'), {type: 'line',
  data: {labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], datasets: [{data: [12, 24, 18, 32, 26, 38, 30], borderColor: '#e6bb83', backgroundColor: '#e6bb83', tension: 0.3}]},
  options: {responsive: false, animation: false, plugins: {legend: {display: false}}}});
</script>
\`\`\`
`;
