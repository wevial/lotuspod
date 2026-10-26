import { render } from "preact";
import type { Page, Spot, SpotNode, SpotShape, Thread } from "../bridge";
import type { Placement } from "./parts";
import { anchorOf, targetOf } from "./anchor";
import {
  clamp, covered, drawingOf, grow, into, labelOf, MAX_NODES, nodesOf, outOf, pointIn, rectIn, shapeBounds,
  spanOf, thin, unitOf, type Point, type Rect,
} from "./spot-shapes";

type Composers = ReturnType<typeof import("./composer").composers>;
type Composer = ReturnType<Composers["spot"]>;

export interface SpotsBridge {
  shown: Map<number, Thread>;
  resolved(thread: Thread): boolean;
  composer: Pick<Composers, "spot">;
  // Draw what the threads say outside them again (the store's refresh).
  refresh(): void;
  placement(): Placement;
  // The box of the section a target is in, which takes its new threads;
  // null when the page has none for it.
  boxOf(target: HTMLElement): HTMLElement | null;
}

export interface Spots {
  // Draw each open spot thread's mark where its target now puts it.
  place(): void;
  // A drawn mark shows its thread's number.
  number(thread: Thread): void;
  // A swap has changed the page's sections.
  swapped(): void;
}

const SVG = "http://www.w3.org/2000/svg";
// A press that moves less than this, in px, is a click.
const NUDGE = 6;
// The room round a node marked by a click or Enter, in px.
const AROUND = 8;
// A badge's radius and its number's size, and the room between a mark and
// its composer, in px.
const BADGE = 9;
const FIGURE = 11;
const GAP = 8;
const EDGE = 8;
// What an image spot's composer says when its crop could not be stored.
const CROP_FAILED = "The crop of the marked spot was not attached. Press Comment to try again.";

// A draft: its mark and the shape it draws, in its layer's coordinates, its
// composer, the target it posts on and the spot, and on an image the crop
// being made and the name the site stores that crop under, once made.
interface Draft {
  mark: SVGGElement; shape: SpotShape; composer: Composer; target: HTMLElement; spot: Omit<Spot, "hash">; image: boolean;
  making: Promise<void>; crop: string;
}
interface Press { id: number; x: number; y: number; layer: SVGGElement; points: Point[]; moved: boolean; node: SVGGElement | null; preview: SVGGElement | null }
interface Marking { holder: HTMLElement; tool: "box" | "stroke"; draft: Draft | null; press: Press | null; tabbed: SVGGElement[] }

// Comments on a spot of a Mermaid diagram (pre.mermaid[data-spot]) or a
// figure's image (img[data-spot]). Each target in a section that takes new
// threads has a Comment, beside a diagram's Expand or at a figure's top right
// corner, once drawn; it opens mark mode: Box, Stroke and Cancel in its place,
// and a crosshair. A drag draws a box or a stroke, a click or Enter on a
// flowchart node marks it, and the composer opens under the mark. Each open
// spot thread's mark is drawn in a layer of the drawing's own coordinates
// (inside the diagram's svg, or an svg over the image), solid on the target
// as it was and dashed on a changed one; one whose target or nodes are gone
// draws nothing.
export function spots(page: Page, bridge: SpotsBridge): Spots {
  const tools = new Map<HTMLElement, HTMLDivElement>();
  const watched = new WeakSet<HTMLElement>();
  const drawnAs = new WeakMap<Thread, string>();
  let marking: Marking | null = null;
  let pending = false;

  function targets() {
    return page.all("pre.mermaid[data-spot], figure.artifact-figure img[data-spot]");
  }

  // The element that holds a target's chrome: a diagram's pre, an image's figure.
  function holderOf(target: HTMLElement): HTMLElement | null {
    return target.tagName === "PRE" ? target : target.closest<HTMLElement>("figure.artifact-figure");
  }

  function targetIn(holder: HTMLElement): HTMLElement | null {
    return holder.tagName === "PRE" ? holder : holder.querySelector<HTMLElement>("img[data-spot]");
  }

  function svg<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
    const made = document.createElementNS(SVG, tag);
    if (className) made.setAttribute("class", className);
    return made;
  }

  // An image's natural size, else the size its tag gives.
  function natural(img: HTMLImageElement): Rect {
    return { x: 0, y: 0, w: img.naturalWidth || Number(img.getAttribute("width")) || 1,
      h: img.naturalHeight || Number(img.getAttribute("height")) || 1 };
  }

  // The rectangle a diagram's mark on no node is a fraction of: its own viewBox.
  function frameOf(drawing: SVGSVGElement): Rect {
    const box = drawing.viewBox.baseVal;
    if (box && box.width && box.height) return { x: box.x, y: box.y, w: box.width, h: box.height };
    const shown = drawing.getBoundingClientRect();
    return { x: 0, y: 0, w: shown.width || 1, h: shown.height || 1 };
  }

  // The layer a target's marks are drawn in, made when missing: inside a
  // diagram's svg, or in an svg laid over an image in its natural pixels.
  // Null for a diagram not drawn yet.
  function layerOf(target: HTMLElement): SVGGElement | null {
    if (target.tagName === "PRE") {
      const drawing = drawingOf(target);
      if (!drawing) return null;
      let layer = drawing.querySelector<SVGGElement>(":scope > g.artifact-spot-layer");
      if (!layer) {
        layer = svg("g", "artifact-spot-layer");
        drawing.appendChild(layer);
      }
      return layer;
    }
    const figure = holderOf(target);
    if (!figure) return null;
    let over = figure.querySelector<SVGSVGElement>(":scope > svg.artifact-spot-overlay");
    if (!over) {
      over = svg("svg", "artifact-spot-overlay");
      over.setAttribute("aria-hidden", "true");
      over.setAttribute("preserveAspectRatio", "none");
      over.appendChild(svg("g", "artifact-spot-layer"));
      figure.appendChild(over);
    }
    const size = natural(target as HTMLImageElement);
    over.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`);
    const outer = figure.getBoundingClientRect(), inner = target.getBoundingClientRect();
    over.style.left = inner.left - outer.left + "px";
    over.style.top = inner.top - outer.top + "px";
    over.style.width = inner.width + "px";
    over.style.height = inner.height + "px";
    return over.querySelector<SVGGElement>(":scope > g.artifact-spot-layer");
  }

  // A mark: its shape, and its badge at its first corner when numbered.
  function draw(layer: SVGGElement, shape: SpotShape, className: string, number: string | null): SVGGElement {
    const unit = unitOf(layer);
    const mark = svg("g", "artifact-spot-mark" + (className ? " " + className : ""));
    let first: Point;
    if (shape.kind === "box") {
      const rect = svg("rect", "artifact-spot-shape");
      rect.setAttribute("x", String(shape.x));
      rect.setAttribute("y", String(shape.y));
      rect.setAttribute("width", String(shape.w));
      rect.setAttribute("height", String(shape.h));
      rect.setAttribute("rx", String(4 * unit));
      mark.appendChild(rect);
      first = [shape.x, shape.y];
    } else {
      const d = "M" + shape.points.map(point => point.join(" ")).join(" L");
      const line = svg("path", "artifact-spot-shape");
      line.setAttribute("d", d);
      // A wider, unseen line the pointer can find.
      const hit = svg("path", "artifact-spot-hit");
      hit.setAttribute("d", d);
      mark.append(hit, line);
      first = shape.points[0];
    }
    if (number !== null) {
      const badge = svg("g", "artifact-spot-badge");
      const circle = svg("circle", "");
      circle.setAttribute("cx", String(first[0]));
      circle.setAttribute("cy", String(first[1]));
      circle.setAttribute("r", String(BADGE * unit));
      const text = svg("text", "");
      text.setAttribute("x", String(first[0]));
      text.setAttribute("y", String(first[1]));
      text.style.fontSize = FIGURE * unit + "px";
      text.textContent = number;
      badge.append(circle, text);
      mark.appendChild(badge);
    }
    layer.appendChild(mark);
    return mark;
  }

  // Where a spot's shape falls on its target as now drawn, in its layer's
  // coordinates; null when a node it covers is not drawn.
  function located(spot: Spot, target: HTMLElement, layer: SVGGElement): SpotShape | null {
    if (target.tagName !== "PRE") return spot.shape;
    const drawing = drawingOf(target)!;
    if (!spot.nodes.length) return outOf(spot.shape, frameOf(drawing));
    const boxes = nodesOf(drawing);
    const rects = spot.nodes.map(node => {
      const group = boxes.get(node.id);
      return group ? rectIn(layer, group) : null;
    });
    return rects.every(Boolean) ? outOf(spot.shape, spanOf(rects as Rect[])) : null;
  }

  function erase(thread: Thread) {
    thread.drawing?.remove();
    thread.drawing = null;
    drawnAs.delete(thread);
  }

  function place() {
    bridge.shown.forEach(thread => {
      const anchor = anchorOf(thread.root);
      if (anchor.kind !== "spot") return;
      const target = !bridge.resolved(thread) && thread.standing && thread.standing !== "gone" ? targetOf(anchor.id) : null;
      const layer = target && layerOf(target);
      const shape = layer && located(anchor, target, layer);
      if (!layer || !shape) {
        erase(thread);
        return;
      }
      const key = [thread.standing, unitOf(layer).toFixed(4), JSON.stringify(shape)].join("\n");
      if (thread.drawing && thread.drawing.parentNode === layer && drawnAs.get(thread) === key) return;
      erase(thread);
      const mark = draw(layer, shape, thread.standing === "changed" ? "artifact-spot-mark--changed" : "", "");
      mark.dataset.thread = String(thread.root.id);
      thread.drawing = mark;
      drawnAs.set(thread, key);
      number(thread);
    });
  }

  function number(thread: Thread) {
    const text = thread.drawing?.querySelector(".artifact-spot-badge text");
    if (text && text.textContent !== String(thread.n || "")) text.textContent = thread.n ? String(thread.n) : "";
  }

  // Draw again once, after what changed the page has run.
  function schedule() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      bridge.refresh();
    });
  }

  // The bar in a target's corner: Comment, or in mark mode its tools.
  function bar(holder: HTMLElement) {
    const root = tools.get(holder);
    if (!root) return;
    const mine = marking?.holder === holder ? marking : null;
    render(mine
      ? <div class="artifact-spot-bar" role="group" aria-label="Mark a spot">
        <button type="button" class="artifact-spot-tool" aria-pressed={mine.tool === "box"} onClick={() => choose("box")}>Box</button>
        <button type="button" class="artifact-spot-tool" aria-pressed={mine.tool === "stroke"} onClick={() => choose("stroke")}>Stroke</button>
        <button type="button" class="artifact-spot-leave" onClick={() => leave(true)}>Cancel</button>
      </div>
      : <button type="button" class="artifact-spot-comment" onClick={() => enter(holder)}>Comment</button>, root);
  }

  // A target's Comment, once a diagram is drawn, on a page that takes new
  // threads in its section.
  function mount(target: HTMLElement) {
    const holder = holderOf(target);
    if (!holder || page.archived || !holder.isConnected || !bridge.boxOf(target)) return;
    const drawing = drawingOf(target);
    if (target.tagName === "PRE" && !drawing) return;
    let root = tools.get(holder);
    if (root && root.parentNode === holder) return;
    if (!root) {
      root = document.createElement("div");
      root.className = "artifact-spot-tools";
      tools.set(holder, root);
      listen(holder);
    }
    // Before the drawing, so Tab reaches the bar before a diagram's nodes.
    holder.insertBefore(root, drawing || null);
    bar(holder);
  }

  // A diagram's pre: its Comment once Mermaid draws it, and its marks again
  // each time it is drawn (a swap's, the other theme's).
  function watch(pre: HTMLElement) {
    if (watched.has(pre)) return;
    watched.add(pre);
    new MutationObserver(() => {
      mount(pre);
      if (marking?.holder === pre) redrawn();
      schedule();
    }).observe(pre, { childList: true });
  }

  function scan() {
    targets().forEach(target => {
      if (target.tagName === "PRE") watch(target);
      mount(target);
    });
  }

  function focusIn(holder: HTMLElement, selector: string) {
    tools.get(holder)?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
  }

  function enter(holder: HTMLElement) {
    if (marking) leave(false);
    marking = { holder, tool: "box", draft: null, press: null, tabbed: [] };
    holder.classList.add(page.marking);
    // An image's overlay takes the crosshair from the start.
    const target = targetIn(holder);
    if (target && target.tagName !== "PRE") layerOf(target);
    tab();
    bar(holder);
    focusIn(holder, ".artifact-spot-tool[aria-pressed='true']");
  }

  // In mark mode Tab goes through the diagram's nodes, and Enter marks one.
  function tab() {
    const drawing = marking && drawingOf(marking.holder);
    if (!marking || !drawing) return;
    nodesOf(drawing).forEach(group => {
      if (!group.hasAttribute("tabindex")) {
        group.setAttribute("tabindex", "0");
        marking!.tabbed.push(group);
      }
    });
  }

  function leave(focus: boolean) {
    const was = marking;
    if (!was) return;
    // A drag still held ends here, its preview with it.
    const press = was.press;
    was.press = null;
    press?.preview?.remove();
    if (press && was.holder.hasPointerCapture(press.id)) was.holder.releasePointerCapture(press.id);
    drop();
    was.tabbed.forEach(group => group.removeAttribute("tabindex"));
    was.holder.classList.remove(page.marking);
    marking = null;
    bar(was.holder);
    if (focus) focusIn(was.holder, ".artifact-spot-comment");
  }

  function choose(tool: "box" | "stroke") {
    if (!marking) return;
    marking.tool = tool;
    bar(marking.holder);
  }

  // The draft and its composer go, posting nothing.
  function drop() {
    const draft = marking?.draft;
    if (!draft) return;
    marking!.draft = null;
    draft.mark.remove();
    draft.composer.holder.remove();
  }

  // The target in mark mode was drawn again, in the other theme or swapped
  // in by Update: a draft's mark is drawn where its spot now falls, and its
  // spot is then on the new target. With a node it covers gone, nothing is
  // drawn and the composer stays, its text kept, on the target it was on.
  function redrawn() {
    const draft = marking?.draft;
    const target = marking && targetIn(marking.holder);
    const layer = draft && target && !draft.mark.isConnected ? layerOf(target) : null;
    // A crop shows the image it was made from: a draft stays on that image
    // when the swap brings in other pixels.
    const other = draft?.image && target !== draft.target && target!.dataset.spotHash !== draft.target.dataset.spotHash;
    const shape = layer && !other && located({ ...draft!.spot, hash: "" }, target!, layer);
    if (draft && layer && shape) {
      draft.target = target!;
      draft.shape = shape;
      draft.mark = draw(layer, shape, "artifact-spot-mark--draft", null);
      seat(draft);
    }
    tab();
  }

  // A swap took the target in mark mode away: mark mode moves to the target
  // the swap brought in with its id, and a draft goes with it. With none, a
  // draft stays as it is, and mark mode without one ends.
  function moved() {
    const was = marking!;
    const now = targetOf(was.draft?.target.dataset.spot || targetIn(was.holder)?.dataset.spot || "");
    const holder = now && holderOf(now);
    if (!holder || !bridge.boxOf(now)) {
      if (!was.draft) leave(false);
      return;
    }
    was.press = null;
    was.tabbed = [];
    was.holder.classList.remove(page.marking);
    was.holder = holder;
    holder.classList.add(page.marking);
    mount(now);
    bar(holder);
    redrawn();
  }

  function nodeOf(group: Element | null, drawing: SVGSVGElement): [string, SVGGElement] | null {
    const node = group?.closest<SVGGElement>("g.node");
    if (!node) return null;
    for (const [id, each] of nodesOf(drawing)) {
      if (each === node) return [id, each];
    }
    return null;
  }

  function listen(holder: HTMLElement) {
    holder.addEventListener("pointerdown", event => {
      const target = targetIn(holder);
      if (marking?.holder !== holder || !target || (event.pointerType === "mouse" && event.button !== 0) ||
          tools.get(holder)?.contains(event.target as Node)) {
        return;
      }
      const layer = layerOf(target);
      const at = layer && pointIn(layer, event.clientX, event.clientY);
      if (!layer || !at) return;
      event.preventDefault();
      drop();
      const drawing = drawingOf(target);
      marking.press = {
        id: event.pointerId, x: event.clientX, y: event.clientY, layer, points: [at], moved: false, preview: null,
        node: drawing ? nodeOf(event.target as Element, drawing)?.[1] || null : null,
      };
      holder.setPointerCapture(event.pointerId);
    });
    holder.addEventListener("pointermove", event => {
      const press = marking?.holder === holder ? marking.press : null;
      if (!press || press.id !== event.pointerId) return;
      if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < NUDGE) return;
      press.moved = true;
      const at = pointIn(press.layer, event.clientX, event.clientY);
      if (!at) return;
      if (marking!.tool === "stroke") press.points.push(at);
      else press.points = [press.points[0], at];
      press.preview?.remove();
      press.preview = draw(press.layer, drawn(press), "artifact-spot-mark--draft", null);
    });
    holder.addEventListener("pointerup", event => finish(holder, event, true));
    holder.addEventListener("pointercancel", event => finish(holder, event, false));
    holder.addEventListener("lostpointercapture", event => finish(holder, event, false));
    // A press in mark mode ends in no click on a node, a link or the image
    // viewer, and drags no image.
    holder.addEventListener("click", event => {
      if (marking?.holder === holder && !tools.get(holder)?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    holder.addEventListener("dragstart", event => {
      if (marking?.holder === holder) event.preventDefault();
    });
    holder.addEventListener("keydown", event => {
      const drawing = drawingOf(holder);
      if (marking?.holder !== holder || event.key !== "Enter" || !drawing) return;
      const found = nodeOf(event.target as Element, drawing);
      const layer = found && layerOf(holder);
      if (!found || !layer) return;
      event.preventDefault();
      event.stopPropagation();
      drop();
      around(found[1], layer, drawing);
    }, true);
  }

  // The shape a press has drawn so far, in its layer's coordinates.
  function drawn(press: Press): SpotShape {
    if (marking!.tool === "stroke") return { kind: "stroke", points: thin(press.points) };
    const [[x1, y1], [x2, y2]] = [press.points[0], press.points[press.points.length - 1]];
    return { kind: "box", x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  // A box AROUND px larger than a node, on each side.
  function around(group: SVGGElement, layer: SVGGElement, drawing: SVGSVGElement) {
    const rect = rectIn(layer, group);
    if (!rect) return;
    const box = clamp({ kind: "box", ...grow(rect, AROUND * unitOf(layer)) }, frameOf(drawing));
    open(layer, box, group);
  }

  function finish(holder: HTMLElement, event: PointerEvent, ended: boolean) {
    const press = marking?.holder === holder ? marking.press : null;
    if (!press || press.id !== event.pointerId) return;
    marking!.press = null;
    press.preview?.remove();
    if (holder.hasPointerCapture(event.pointerId)) holder.releasePointerCapture(event.pointerId);
    if (!ended) return;
    const target = targetIn(holder)!;
    const drawing = drawingOf(target);
    if (!press.moved) {
      if (press.node && drawing) around(press.node, press.layer, drawing);
      return;
    }
    const frame = drawing ? frameOf(drawing) : natural(target as HTMLImageElement);
    const shape = clamp(drawn(press), frame);
    const size = shapeBounds(shape);
    if (shape.kind === "box" ? size.w <= 0 || size.h <= 0 : shape.points.length < 2) return;
    open(press.layer, shape, null);
  }

  // The flowchart boxes a shape covers, as the spot names them, and the
  // rectangle they span; the node marked by a click or Enter first.
  function coveredBy(shape: SpotShape, layer: SVGGElement, drawing: SVGSVGElement, marked: SVGGElement | null) {
    const groups = nodesOf(drawing);
    const rects = new Map<string, Rect>();
    groups.forEach((group, id) => {
      const rect = rectIn(layer, group);
      if (rect) rects.set(id, rect);
    });
    // A stroke's box is a line wide at least, so a flat stroke still covers.
    const unit = unitOf(layer);
    const size = shapeBounds(shape);
    const mark = { x: size.x - (size.w < unit ? unit : 0), y: size.y - (size.h < unit ? unit : 0),
      w: Math.max(size.w, 2 * unit), h: Math.max(size.h, 2 * unit) };
    let ids = covered(mark, rects);
    const first = marked && [...groups].find(([, group]) => group === marked)?.[0];
    if (first) ids = [first, ...ids.filter(id => id !== first)].slice(0, MAX_NODES);
    const nodes: SpotNode[] = ids.map(id => ({ id, label: labelOf(groups.get(id)!) }));
    return { nodes, span: ids.length ? spanOf(ids.map(id => rects.get(id)!)) : null };
  }

  // A draft mark, and the composer under it.
  function open(layer: SVGGElement, shape: SpotShape, marked: SVGGElement | null) {
    if (!marking) return;
    const holder = marking.holder;
    const target = targetIn(holder)!;
    const box = bridge.boxOf(target);
    if (!box) return;
    const drawing = drawingOf(target);
    let spot: Omit<Spot, "hash">;
    if (drawing) {
      const { nodes, span } = coveredBy(shape, layer, drawing, marked);
      spot = { id: target.dataset.spot!, shape: into(shape, span || frameOf(drawing)), nodes };
    } else {
      spot = { id: target.dataset.spot!, shape: into(shape, { x: 0, y: 0, w: 1, h: 1 }, 2), nodes: [] };
    }
    const image = !drawing;
    const mark = draw(layer, shape, "artifact-spot-mark--draft", null);
    // Each callback acts on its own draft only: a save that ends after the
    // reader dropped it, or started another, leaves the newer one as it is.
    const mine = () => marking?.draft === draft;
    const composer = bridge.composer.spot(box, () => ({
      spot: { ...spot, id: draft.target.dataset.spot || spot.id, hash: draft.target.dataset.spotHash || "" },
      stale: image ? page.staleImage : page.staleDiagram,
      first: image ? draft.crop : "",
    }), () => {
      if (!mine()) return;
      drop();
      focusIn(holder, ".artifact-spot-tool[aria-pressed='true']");
    }, () => {
      if (!mine()) return;
      drop();
      leave(false);
    }, async () => {
      // An image spot is sent only with its crop stored, read from the
      // composer's images as they are at this send: a crop refused, failed
      // or removed by the reader is made and attached again, and if that
      // fails too, nothing is sent.
      if (!image) return "";
      await draft.making;
      if (await uploaded(draft)) return "";
      draft.making = attach(draft.target as HTMLImageElement, spot.shape, draft);
      await draft.making;
      return await uploaded(draft) ? "" : CROP_FAILED;
    }, CROP_FAILED);
    const draft: Draft = { mark, shape, composer, target, spot, image, making: Promise.resolve(), crop: "" };
    marking.draft = draft;
    document.body.appendChild(composer.holder);
    seat(draft);
    composer.field.focus({ preventScroll: true });
    if (image) draft.making = attach(target as HTMLImageElement, spot.shape, draft);
  }

  // The composer just under its mark, inside the window and left of the
  // comments panel.
  function seat(draft: Draft) {
    const mark = draft.mark.getBoundingClientRect();
    const holder = draft.composer.holder;
    const panel = document.querySelector<HTMLElement>("aside.artifact-comments-panel:not([hidden])");
    const right = Math.min(document.documentElement.clientWidth, panel ? panel.getBoundingClientRect().left : Infinity);
    const left = Math.max(EDGE, Math.min(mark.left, right - holder.offsetWidth - EDGE));
    holder.style.left = Math.round(left + window.scrollX) + "px";
    holder.style.top = Math.round(mark.bottom + GAP + window.scrollY) + "px";
  }

  // An image spot's composer takes a PNG crop of the spot at natural size as
  // its first image.
  async function attach(img: HTMLImageElement, shape: SpotShape, draft: Draft) {
    const part = shapeBounds(shape);
    const width = Math.max(1, Math.round(part.w));
    const height = Math.max(1, Math.round(part.h));
    try {
      await img.decode();
    } catch {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(img, part.x, part.y, Math.max(part.w, 1), Math.max(part.h, 1), 0, 0, width, height);
    const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, "image/png"));
    if (!blob || marking?.draft !== draft) return;
    const images = draft.composer.images;
    const before = new Set(images.kept().map(image => image.name));
    images.take([new File([blob], "spot.png", { type: "image/png" })]);
    // The site stores an image under the SHA-256 of its bytes; where the page
    // cannot hash (no secure context), the crop is the PNG this upload added.
    const name = await stored(blob);
    if (name) {
      draft.crop = name;
      return;
    }
    await settled(draft.composer);
    draft.crop = images.kept().find(image => /\.png$/.test(image.name) && image.width === width && image.height === height &&
      !before.has(image.name))?.name || "";
  }

  async function stored(blob: Blob): Promise<string> {
    if (!crypto.subtle) return "";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") + ".png";
  }

  async function settled(composer: Composer) {
    while (composer.images.busy() && composer.holder.isConnected) {
      await new Promise(done => setTimeout(done, 100));
    }
  }

  // Once a draft's images have uploaded, or failed to: whether its crop, by
  // the name it is stored under, is among them.
  async function uploaded(draft: Draft): Promise<boolean> {
    await settled(draft.composer);
    return Boolean(draft.crop) && draft.composer.images.kept().some(image => image.name === draft.crop);
  }

  // Escape drops a draft, staying in mark mode, and with none leaves it.
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !marking || event.defaultPrevented) return;
    event.preventDefault();
    if (marking.draft) {
      drop();
      focusIn(marking.holder, ".artifact-spot-tool[aria-pressed='true']");
    } else {
      leave(true);
    }
  });
  window.addEventListener("resize", () => {
    if (marking?.draft) seat(marking.draft);
    schedule();
  });
  document.addEventListener(page.events.diagrams, scan);
  document.addEventListener(page.events.redrawn, schedule);
  // A part holding the target a draft is on stays as it is until the reader
  // updates it, so a swap never takes the draft away.
  page.holdSwap(nodes => Boolean(marking?.draft) && nodes.some(node => node.contains(marking!.holder)));

  scan();
  return {
    place,
    number,
    swapped() {
      scan();
      if (marking && !marking.holder.isConnected) moved();
    },
  };
}
