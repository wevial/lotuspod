# How many workers merge at once

A worked example of an interactive page: a pod with one live block, a d3
chart drawn from data written inline, with notes around it and a decision
under it. The figures are made up. [Publishing pages](../publishing.md#interactive-pages)
says how each part is written.

## What we measured

The merge queue ran for a week at each worker count from one to eight. Every
worker takes a branch, rebases it on main and merges it; when two workers
touch the same files, the second has to rebase again, and that repeat is the
churn. Throughput rises with each worker, but churn rises faster once more
than four are running.

Move the slider to pick a worker count. The chart marks its bar, and the line
under it reads that week's numbers.

```html live d3 id=merge-churn title="Merge churn by worker count" height=340
<style>
  body { padding: 12px 16px; box-sizing: border-box; font-size: 14px; }
  label { display: flex; align-items: center; gap: 12px; }
  input:focus-visible { outline: 2px solid var(--lotus-color-sky); outline-offset: 2px; }
  svg { display: block; max-width: 100%; height: auto; margin-top: 8px; }
  .axis text { fill: var(--lotus-color-muted-lavender); font-size: 12px; }
  .axis line, .axis path { stroke: var(--lotus-structure-hairline-strong); }
  .bar { fill: var(--lotus-color-muted-lavender); }
  .bar.selected { fill: var(--lotus-color-lavender); }
  .value { fill: var(--lotus-type-ink); font-size: 12px; }
  #reading { margin: 4px 0 0; }
</style>
<script type="application/json" id="runs">
[
  {"workers": 1, "merges": 9, "churn": 1},
  {"workers": 2, "merges": 17, "churn": 2},
  {"workers": 3, "merges": 24, "churn": 4},
  {"workers": 4, "merges": 30, "churn": 7},
  {"workers": 5, "merges": 33, "churn": 12},
  {"workers": 6, "merges": 35, "churn": 18},
  {"workers": 7, "merges": 36, "churn": 25},
  {"workers": 8, "merges": 36, "churn": 33}
]
</script>
<label>Workers <input id="workers" type="range" min="1" max="8" step="1" value="4"> <output id="count">4</output></label>
<svg id="chart" viewBox="0 0 640 220" role="img" aria-label="Churn, as rebases per 100 merges, for one to eight workers"></svg>
<p id="reading"></p>
<script>
  const runs = JSON.parse(document.getElementById('runs').textContent);
  const width = 640, height = 220, margin = {top: 20, right: 12, bottom: 32, left: 40};
  const rate = run => Math.round(run.churn / run.merges * 100);
  const x = d3.scaleBand().domain(runs.map(run => run.workers))
    .range([margin.left, width - margin.right]).padding(0.25);
  const y = d3.scaleLinear().domain([0, 100]).range([height - margin.bottom, margin.top]);
  const svg = d3.select('#chart');
  svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).tickSizeOuter(0));
  svg.append('g').attr('class', 'axis').attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4));
  const slider = document.getElementById('workers');

  function draw() {
    const chosen = Number(slider.value);
    svg.selectAll('rect.bar').data(runs, run => run.workers).join('rect')
      .attr('class', run => run.workers === chosen ? 'bar selected' : 'bar')
      .attr('data-workers', run => run.workers)
      .attr('x', run => x(run.workers)).attr('width', x.bandwidth())
      .attr('y', run => y(rate(run))).attr('height', run => y(0) - y(rate(run)))
      .attr('rx', 2);
    svg.selectAll('text.value').data(runs.filter(run => run.workers === chosen), run => run.workers)
      .join('text').attr('class', 'value').attr('text-anchor', 'middle')
      .attr('x', run => x(run.workers) + x.bandwidth() / 2).attr('y', run => y(rate(run)) - 6)
      .text(run => rate(run));
    const run = runs.find(each => each.workers === chosen);
    document.getElementById('count').textContent = chosen;
    document.getElementById('reading').textContent =
      `With ${chosen} ${chosen === 1 ? 'worker' : 'workers'}: ${run.merges} merges a day, ` +
      `${rate(run)} rebases per 100 merges.`;
  }

  slider.addEventListener('input', draw);
  draw();
</script>
```

## What the numbers suggest

Four workers merge 30 branches a day with 23 rebases per 100 merges. Six merge
only five more a day, but half of what they merge needs a second rebase, and
each rebase runs the whole test suite again. Past six, a worker adds almost
nothing but churn.

The churn comes from branches that touch the same few files: the docs pages
and the theme's stylesheets. Splitting those files would let more workers run
before churn climbs, but that is a change of its own.

### Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| 1 | How many workers merge at once? | Four workers / Six workers | Four workers |
