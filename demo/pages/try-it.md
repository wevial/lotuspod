# Planting the new pond

This page is a made-up plan, published with the real `lotuspod publish` like
every other page of this demo. Comment on a section, select a passage to quote
it in a comment, or answer the decisions at the end: what you write stays in
this browser.

## The pond today

The old pond at the bottom of the garden has been dug out, lined and filled.
The water has stood for three weeks and is clear. Nothing grows in it yet, so
the sun warms it from edge to edge and the first algae are showing on the
shallow shelf.

Two shelves run around the edge: a shallow one, a hand deep, for marginal
plants, and a deep one, an arm deep, for the water lilies. The middle is deep
enough that it will not freeze through in winter.

### The deep shelf

The block below is a live block: a small page of its own, run in a sandboxed
frame. Move the slider to try how many lilies the deep shelf takes. A lily
wants about a square metre of surface to itself, and the shelf has three.

```html live id=deep-shelf title="Lilies on the deep shelf"
<style>
  body { padding: 12px 16px; box-sizing: border-box; }
  label { display: flex; align-items: center; gap: 12px; }
  input:focus-visible { outline: 2px solid var(--lotus-color-sky); outline-offset: 2px; }
  p { margin: 10px 0 0; }
</style>
<label>Lilies <input id="lilies" type="range" min="1" max="6" step="1" value="3"></label>
<p id="verdict"></p>
<script>
  const slider = document.getElementById('lilies');
  function say() {
    const lilies = Number(slider.value);
    const each = Math.round(300 / lilies) / 100;
    document.getElementById('verdict').textContent =
      `${lilies} ${lilies === 1 ? 'lily gets' : 'lilies get'} ${each} m² each: ` +
      (lilies <= 3 ? 'room to spread.' : 'the leaves will crowd and climb.');
  }
  slider.addEventListener('input', say);
  say();
</script>
```

## What goes in

Plants go in before any fish, so they can root and shade the water first.

- Three water lilies on the deep shelf, one white and two pink, each in its
  own basket.
- Marsh marigold, water forget-me-not and a dwarf rush on the shallow shelf.
- A bunch of hornwort, dropped in loose, to keep the water clear.

> A pond is planted for the summer after next: what goes in this year is
> there to shade the water, and what flowers is a bonus.

Lilies want still water and full sun, so they go on the side away from the
overflow, where the afternoon light reaches longest.

## Planting day

Planting takes one morning. The baskets are filled with heavy garden soil,
topped with gravel so the soil stays put, and lowered onto their shelf a little
at a time, so the leaves reach the surface before the basket reaches the
bottom.

### Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| 1 | When do we plant? | This weekend / Next weekend / After the last frost | Next weekend |
| 2 | Do fish go in this year? | Yes / No | No |
