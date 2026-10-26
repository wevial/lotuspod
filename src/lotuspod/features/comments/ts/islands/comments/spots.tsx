import { render } from "preact";
import type { MarkView, Page, Spot, SpotNode, SpotShape, StoredImage, Thread } from "../bridge";
import type { Placement } from "./parts";
import { anchorOf, spotTargets, targetOf } from "./anchor";
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
  // Light a thread's mark as its row is lit (the passages' shine).
  shine(thread: Thread): void;
}

export interface Spots {
  // Draw each open spot thread's mark where its target now puts it.
  place(): void;
  // A drawn mark shows its thread's number.
  number(thread: Thread): void;
  // A swap has changed the page's sections.
  swapped(): void;
  // The open draft, for a reload to keep: its section, its text, its images
  // uploaded other than its crop, and whether any image is attached or on
  // its way; null with none.
  writing(): { section: string; text: string; images: StoredImage[]; held: boolean } | null;
  // Once the open draft's crop is made and known by its name, and its
  // uploads on their way are answered: whether there was one to wait for.
  settled(): Promise<boolean>;
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
// The tool mark mode draws with, where the focus goes back to.
const PRESSED = ".artifact-spot-tool[aria-pressed='true']";
// What an image spot's composer says when its crop could not be stored.
const CROP_FAILED = "The crop of the marked spot was not attached. Press Comment to try again.";
// An image's mark surface, as mark mode names it.
const KEYS = "Image: Enter drops a box, the arrow keys move it, Shift and an arrow resize it, Enter again comments";
// A box Enter drops on an image is this part of its width and height, and an
// arrow key moves or resizes it by this part.
const DROPPED = 4;
const NUDGED = 20;

// A draft: its mark and the shape it draws, in its layer's coordinates, its
// composer, the target it posts on and the spot, and on an image the crop
// being made and the name the site stores that crop under, once made.
interface Draft {
  mark: SVGGElement; shape: SpotShape; composer: Composer; box: HTMLElement; target: HTMLElement; spot: Omit<Spot, "hash">; image: boolean;
  making: Promise<void>; crop: string;
}
interface Press { id: number; x: number; y: number; layer: SVGGElement; points: Point[]; moved: boolean; node: SVGGElement | null; preview: SVGGElement | null }
// Mark mode: on the page, presses land on the holder; in the diagram view or
// the image viewer (view), on its surface, with the bar docked there and a
// placeholder (home) where the bar was. Down: the pointers down on the
// surface. Keyed: the box the keyboard is placing on an image.
interface Marking {
  holder: HTMLElement; tool: "box" | "stroke"; draft: Draft | null; press: Press | null; tabbed: SVGGElement[];
  surface: HTMLElement; view: MarkView | null; home: Comment | null; down: Set<number>;
  keyed: { mark: SVGGElement; shape: Rect } | null;
}

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
// Where comments use the bottom sheet, Comment opens the diagram view or the
// image viewer in mark mode instead, the bar and the composer in it: one
// pointer draws, two pinch the diagram view, and a post closes it.
export function spots(page: Page, bridge: SpotsBridge): Spots {
  // Weak, as a swap takes a target's holder away for good.
  const tools = new WeakMap<HTMLElement, HTMLDivElement>();
  const watched = new WeakSet<HTMLElement>();
  const listened = new WeakSet<HTMLElement>();
  const drawnAs = new WeakMap<Thread, string>();
  let marking: Marking | null = null;
  let pending = false;

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

  // The rectangle a diagram's mark on no node is a fraction of: its own
  // viewBox, kept aside while the diagram view rewrites it.
  function frameOf(drawing: SVGSVGElement): Rect {
    const [x, y, w, h] = (drawing.getAttribute(page.naturalBox) || "").split(" ").map(Number);
    if (w > 0 && h > 0) return { x, y, w, h };
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
    return figure && overlayOf(figure, target as HTMLImageElement, natural(target as HTMLImageElement));
  }

  // The layer of the svg over img in parent, in size's units, made when missing.
  function overlayOf(parent: HTMLElement, img: HTMLImageElement, size: Rect): SVGGElement {
    let over = parent.querySelector<SVGSVGElement>(":scope > svg.artifact-spot-overlay");
    if (!over) {
      over = svg("svg", "artifact-spot-overlay");
      over.setAttribute("aria-hidden", "true");
      over.setAttribute("preserveAspectRatio", "none");
      over.appendChild(svg("g", "artifact-spot-layer"));
      parent.appendChild(over);
    }
    over.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`);
    const outer = parent.getBoundingClientRect(), inner = img.getBoundingClientRect();
    over.style.left = inner.left - outer.left + "px";
    over.style.top = inner.top - outer.top + "px";
    over.style.width = inner.width + "px";
    over.style.height = inner.height + "px";
    return over.querySelector<SVGGElement>(":scope > g.artifact-spot-layer")!;
  }

  // Where mark mode draws: on an image in the viewer, the overlay over the
  // viewer's image, in the page image's natural pixels; else the target's layer.
  function markLayer(): SVGGElement | null {
    const target = marking && targetIn(marking.holder);
    if (!target) return null;
    const view = marking!.view;
    if (view?.image && target.tagName !== "PRE") return overlayOf(view.surface!, view.image, natural(target as HTMLImageElement));
    return layerOf(target);
  }

  // The layer a target's posted marks are drawn in: the viewer's overlay
  // while the image is open there in mark mode, as the modal hides the page's.
  function shownIn(target: HTMLElement): SVGGElement | null {
    return marking?.view?.image && targetIn(marking.holder) === target ? markLayer() : layerOf(target);
  }

  // An image's overlay is its mark surface in mark mode, which Tab reaches
  // after the bar; out of it, it is hidden from assistive technology.
  function surfaceOn(over: SVGSVGElement, on: boolean) {
    if (on) {
      over.setAttribute("tabindex", "0");
      over.setAttribute("role", "group");
      over.setAttribute("aria-label", KEYS);
      over.removeAttribute("aria-hidden");
    } else {
      over.removeAttribute("tabindex");
      over.removeAttribute("role");
      over.removeAttribute("aria-label");
      over.setAttribute("aria-hidden", "true");
    }
  }

  // A mark: its shape, and with badge its badge at its first corner, for number() to fill.
  function draw(layer: SVGGElement, shape: SpotShape, className: string, badge = false): SVGGElement {
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
    if (badge) {
      const group = svg("g", "artifact-spot-badge");
      const circle = svg("circle", "");
      circle.setAttribute("cx", String(first[0]));
      circle.setAttribute("cy", String(first[1]));
      circle.setAttribute("r", String(BADGE * unit));
      const text = svg("text", "");
      text.setAttribute("x", String(first[0]));
      text.setAttribute("y", String(first[1]));
      text.style.fontSize = FIGURE * unit + "px";
      group.append(circle, text);
      mark.appendChild(group);
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
      const layer = target && shownIn(target);
      const shape = layer && located(anchor, target, layer);
      if (!layer || !shape) {
        erase(thread);
        return;
      }
      const key = [thread.standing, unitOf(layer).toFixed(4), JSON.stringify(shape)].join("\n");
      if (thread.drawing && thread.drawing.parentNode === layer && drawnAs.get(thread) === key) return;
      erase(thread);
      const mark = draw(layer, shape, thread.standing === "changed" ? "artifact-spot-mark--changed" : "", true);
      mark.dataset.thread = String(thread.root.id);
      thread.drawing = mark;
      drawnAs.set(thread, key);
      number(thread);
      // A mark drawn anew, as in the other theme, is lit as the old one was.
      bridge.shine(thread);
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
    // In a view, the bar is docked there.
    if ((root && root.parentNode === holder) || (marking?.holder === holder && marking.view)) return;
    if (!root) {
      root = document.createElement("div");
      root.className = "artifact-spot-tools";
      tools.set(holder, root);
    }
    // Before the drawing, so Tab reaches the bar before a diagram's nodes.
    holder.insertBefore(root, drawing?.parentNode === holder ? drawing : null);
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
    spotTargets().forEach(target => {
      if (target.tagName === "PRE") watch(target);
      mount(target);
    });
  }

  function focusIn(holder: HTMLElement, selector: string) {
    tools.get(holder)?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
  }

  function enter(holder: HTMLElement) {
    if (marking) leave(false);
    const now: Marking = marking = {
      holder, tool: "box", draft: null, press: null, tabbed: [], surface: holder, view: null, home: null, down: new Set(), keyed: null,
    };
    holder.classList.add(page.marking);
    if (bridge.placement().mode === "sheet") viewed(now);
    now.surface.classList.add(page.marking);
    listen(now.surface);
    // An image's overlay takes the crosshair from the start, and is its mark
    // surface after the bar.
    const target = targetIn(holder);
    if (target && target.tagName !== "PRE") {
      const layer = markLayer();
      const over = layer?.ownerSVGElement;
      if (over) {
        now.surface.appendChild(over);
        surfaceOn(over, true);
      }
      // The viewer's image may still be loading.
      now.view?.image?.addEventListener("load", () => {
        if (marking === now) markLayer();
      }, { once: true });
      if (now.view) schedule();
    }
    tab();
    bar(holder);
    focusIn(holder, PRESSED);
  }

  // Open the target in the diagram view or the image viewer in mark mode,
  // with the bar docked there; on the page when neither opens it.
  function viewed(now: Marking) {
    const view: MarkView = {
      escape: () => {
        if (marking === now) escape();
      },
      closed: () => {
        if (marking === now) leave(false);
      },
    };
    const root = tools.get(now.holder);
    if (now.holder.dispatchEvent(new CustomEvent(page.events.markView, { bubbles: true, cancelable: true, detail: view })) ||
        !view.surface || !root) {
      return;
    }
    now.view = view;
    now.surface = view.surface;
    now.home = document.createComment("");
    root.replaceWith(now.home);
    view.dock!(root);
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

  // Mark mode ends; in a view, the view stays open, the bar going back to
  // the page.
  function leave(focus: boolean) {
    const was = marking;
    if (!was) return;
    // A drag still held ends here, its preview with it.
    const press = was.press;
    was.press = null;
    press?.preview?.remove();
    if (press && was.surface.hasPointerCapture(press.id)) was.surface.releasePointerCapture(press.id);
    drop();
    unkey();
    was.tabbed.forEach(group => group.removeAttribute("tabindex"));
    was.holder.classList.remove(page.marking);
    was.surface.classList.remove(page.marking);
    const over = was.surface.querySelector<SVGSVGElement>(":scope > svg.artifact-spot-overlay");
    if (was.view) {
      over?.remove();
      const root = tools.get(was.holder);
      if (root && was.home?.parentNode) was.home.replaceWith(root);
      else was.home?.remove();
    } else if (over) {
      surfaceOn(over, false);
    }
    marking = null;
    bar(was.holder);
    // The image's posted marks go back to the page with its overlay.
    if (was.view && over) schedule();
    if (was.view) was.view.done!();
    else if (focus) focusIn(was.holder, ".artifact-spot-comment");
  }

  // Escape drops a draft or a box the keyboard is placing, staying in mark
  // mode, and with neither leaves it; in a view it leaves mark mode at once,
  // so a second Escape closes the view.
  function escape() {
    if (!marking) return;
    if (marking.view) {
      leave(true);
    } else if (marking.draft) {
      drop();
      focusIn(marking.holder, PRESSED);
    } else if (marking.keyed) {
      unkey();
    } else {
      leave(true);
    }
  }

  function choose(tool: "box" | "stroke") {
    if (!marking) return;
    marking.tool = tool;
    bar(marking.holder);
  }

  function unkey() {
    marking?.keyed?.mark.remove();
    if (marking) marking.keyed = null;
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
      // A swap may have moved the target to another section, which then
      // takes the thread.
      draft.box = bridge.boxOf(target!) || draft.box;
      draft.shape = shape;
      draft.mark = draw(layer, shape, "artifact-spot-mark--draft");
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
    was.down.clear();
    was.holder.classList.remove(page.marking);
    was.holder = holder;
    holder.classList.add(page.marking);
    if (!was.view) {
      was.surface = holder;
      listen(holder);
    }
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

  // Presses and keys on a surface in mark mode: a holder on the page, or a
  // view's stage or image frame.
  function listen(surface: HTMLElement) {
    if (listened.has(surface)) return;
    listened.add(surface);
    const mine = () => marking?.surface === surface ? marking : null;
    surface.addEventListener("pointerdown", event => {
      const now = mine();
      const target = now && targetIn(now.holder);
      if (!now || !target || (event.pointerType === "mouse" && event.button !== 0) ||
          tools.get(now.holder)?.contains(event.target as Node)) {
        return;
      }
      now.down.add(event.pointerId);
      surface.setPointerCapture(event.pointerId);
      // A second pointer pinches the view: what the first drew goes.
      if (now.down.size > 1) {
        now.press?.preview?.remove();
        now.press = null;
        return;
      }
      const layer = markLayer();
      const at = layer && pointIn(layer, event.clientX, event.clientY);
      if (!layer || !at) return;
      event.preventDefault();
      const drawing = drawingOf(target);
      now.press = {
        id: event.pointerId, x: event.clientX, y: event.clientY, layer, points: [at], moved: false, preview: null,
        node: drawing ? nodeOf(event.target as Element, drawing)?.[1] || null : null,
      };
    });
    surface.addEventListener("pointermove", event => {
      const press = mine()?.press;
      if (!press || press.id !== event.pointerId) return;
      if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < NUDGE) return;
      press.moved = true;
      const at = pointIn(press.layer, event.clientX, event.clientY);
      if (!at) return;
      if (marking!.tool === "stroke") press.points.push(at);
      else press.points = [press.points[0], at];
      press.preview?.remove();
      press.preview = draw(press.layer, drawn(press), "artifact-spot-mark--draft");
    });
    surface.addEventListener("pointerup", event => finish(surface, event, true));
    surface.addEventListener("pointercancel", event => finish(surface, event, false));
    surface.addEventListener("lostpointercapture", event => finish(surface, event, false));
    // A press in mark mode ends in no click on a node, a link or the image
    // viewer, and drags no image.
    surface.addEventListener("click", event => {
      const now = mine();
      if (now && !tools.get(now.holder)?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    surface.addEventListener("dragstart", event => {
      if (mine()) event.preventDefault();
    });
    surface.addEventListener("keydown", event => {
      const now = mine();
      const target = now && targetIn(now.holder);
      if (!target) return;
      if (target.tagName !== "PRE") {
        if ((event.target as Element).matches("svg.artifact-spot-overlay")) keyed(event, target as HTMLImageElement);
        return;
      }
      const drawing = drawingOf(target);
      if (event.key !== "Enter" || !drawing) return;
      const found = nodeOf(event.target as Element, drawing);
      const layer = found && layerOf(target);
      if (!found || !layer) return;
      event.preventDefault();
      event.stopPropagation();
      drop();
      around(found[1], layer, drawing);
    }, true);
  }

  // The keyboard on an image's mark surface: Enter drops a box a DROPPED part
  // of the image at its centre, the arrows move it by a NUDGED part, with
  // Shift grow or shrink it by as much, never past the image, and Enter then
  // opens the composer under it.
  function keyed(event: KeyboardEvent, img: HTMLImageElement) {
    const layer = markLayer();
    if (!layer || !marking || marking.draft || event.altKey || event.ctrlKey || event.metaKey) return;
    const size = natural(img);
    const was = marking.keyed;
    if (event.key === "Enter") {
      if (was) {
        unkey();
        open(layer, { kind: "box", ...was.shape }, null);
      } else {
        const w = size.w / DROPPED, h = size.h / DROPPED;
        const box = { x: (size.w - w) / 2, y: (size.h - h) / 2, w, h };
        marking.keyed = { shape: box, mark: draw(layer, { kind: "box", ...box }, "artifact-spot-mark--draft") };
      }
    } else {
      const arrow = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
      if (!arrow) return;
      if (was) {
        const step = { x: size.w / NUDGED, y: size.h / NUDGED };
        const [dx, dy] = [arrow[0] * step.x, arrow[1] * step.y];
        const { x, y, w, h } = was.shape;
        const box = event.shiftKey
          ? { x, y, w: Math.max(step.x, Math.min(w + dx, size.w - x)), h: Math.max(step.y, Math.min(h + dy, size.h - y)) }
          : { x: Math.max(0, Math.min(x + dx, size.w - w)), y: Math.max(0, Math.min(y + dy, size.h - h)), w, h };
        was.mark.remove();
        marking.keyed = { shape: box, mark: draw(layer, { kind: "box", ...box }, "artifact-spot-mark--draft") };
      }
    }
    event.preventDefault();
    event.stopPropagation();
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

  function finish(surface: HTMLElement, event: PointerEvent, ended: boolean) {
    const now = marking?.surface === surface ? marking : null;
    now?.down.delete(event.pointerId);
    const press = now?.press;
    if (!now || !press || press.id !== event.pointerId) return;
    now.press = null;
    press.preview?.remove();
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    if (!ended) return;
    // Only a press that ends replaces the draft: a pinch's first finger keeps
    // it and its text.
    drop();
    unkey();
    const target = targetIn(now.holder)!;
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
    // A stroke's box is a line wide at least, so a flat stroke still covers;
    // a box covers by its own edges.
    const unit = unitOf(layer);
    const size = shapeBounds(shape);
    const mark = shape.kind === "box" ? size : { x: size.x - (size.w < unit ? unit : 0), y: size.y - (size.h < unit ? unit : 0),
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
    const mark = draw(layer, shape, "artifact-spot-mark--draft");
    // Each callback acts on its own draft only: a save that ends after the
    // reader dropped it, or started another, leaves the newer one as it is.
    const mine = () => marking?.draft === draft;
    const composer = bridge.composer.spot(() => ({
      spot: { ...spot, id: draft.target.dataset.spot || spot.id, hash: draft.target.dataset.spotHash || "" },
      stale: image ? page.staleImage : page.staleDiagram,
      first: image ? draft.crop : "",
      box: draft.box,
    }), () => {
      if (!mine()) return;
      // In a view, Cancel leaves mark mode, as Escape does.
      if (marking!.view) return leave(false);
      drop();
      // A swap may have put mark mode on another holder since.
      focusIn(marking!.holder, PRESSED);
    }, () => {
      if (!mine()) return;
      // Posted from a view, the view closes, and the thread opens in the sheet.
      const view = marking!.view;
      drop();
      leave(false);
      view?.close!();
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
    const draft: Draft = { mark, shape, composer, box, target, spot, image, making: Promise.resolve(), crop: "" };
    marking.draft = draft;
    (marking.view?.room || document.body).appendChild(composer.holder);
    seat(draft);
    composer.field.focus({ preventScroll: true });
    if (image) draft.making = attach(target as HTMLImageElement, spot.shape, draft);
  }

  // The composer just under its mark, inside the window and left of the
  // comments panel; in a view, inside the view.
  function seat(draft: Draft) {
    const mark = draft.mark.getBoundingClientRect();
    const holder = draft.composer.holder;
    const room = marking?.view?.room?.getBoundingClientRect();
    if (room) {
      const most = (size: number, own: number) => Math.max(EDGE, size - own - EDGE);
      holder.style.left = Math.round(Math.max(EDGE, Math.min(mark.left - room.left, most(room.width, holder.offsetWidth)))) + "px";
      holder.style.top = Math.round(Math.max(EDGE, Math.min(mark.bottom + GAP - room.top, most(room.height, holder.offsetHeight)))) + "px";
      return;
    }
    const panel = document.querySelector<HTMLElement>("aside.artifact-comments-panel:not([hidden])");
    const right = Math.min(document.documentElement.clientWidth, panel ? panel.getBoundingClientRect().left : Infinity);
    const left = Math.max(EDGE, Math.min(mark.left, right - holder.offsetWidth - EDGE));
    holder.style.left = Math.round(left + window.scrollX) + "px";
    holder.style.top = Math.round(mark.bottom + GAP + window.scrollY) + "px";
  }

  // An image spot's composer takes a PNG crop of the spot at natural size as
  // its first image.
  // A crop that cannot be made is not attached, which a send then says.
  async function attach(img: HTMLImageElement, shape: SpotShape, draft: Draft) {
    try {
      await crop(img, shape, draft);
    } catch {
      // Left for the send to make again.
    }
  }

  async function crop(img: HTMLImageElement, shape: SpotShape, draft: Draft) {
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

  // Each crop's making settled() has waited out.
  const made = new WeakSet<Promise<void>>();

  async function stored(blob: Blob): Promise<string> {
    if (!crypto.subtle) return "";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") + ".png";
  }

  // Uploads on their way are waited for on their promises, so a paused
  // clock (as Reload's wait may meet) does not hold them; only files still
  // waiting for the size limit are looked for again on a timer.
  async function settled(composer: Composer) {
    while (composer.images.busy() && composer.holder.isConnected) {
      if (!await composer.images.settled()) await new Promise(done => setTimeout(done, 100));
    }
  }

  // Once a draft's images have uploaded, or failed to: whether its crop, by
  // the name it is stored under, is among them.
  async function uploaded(draft: Draft): Promise<boolean> {
    await settled(draft.composer);
    return Boolean(draft.crop) && draft.composer.images.kept().some(image => image.name === draft.crop);
  }

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !marking || event.defaultPrevented) return;
    event.preventDefault();
    escape();
  });
  window.addEventListener("resize", () => {
    if (marking?.draft) seat(marking.draft);
    if (marking?.view?.image) markLayer();
    schedule();
  });
  // The diagram view moved or zoomed: the composer follows its mark.
  document.addEventListener(page.events.moved, () => {
    if (marking?.draft) seat(marking.draft);
  });
  // A wide diagram scrolls inside its pre: the composer follows its mark.
  document.addEventListener("scroll", event => {
    const draft = marking?.draft;
    if (draft && event.target instanceof Element && event.target.contains(draft.mark)) seat(draft);
  }, { capture: true, passive: true });
  document.addEventListener(page.events.diagrams, scan);
  document.addEventListener(page.events.redrawn, event => {
    schedule();
    // The diagram view puts a diagram drawn again in its place once this has
    // run: the draft and the nodes Tab reaches follow it there.
    if (marking?.view && (event as CustomEvent<{ pre?: Element }>).detail?.pre === marking.holder) {
      queueMicrotask(() => {
        if (marking?.view) redrawn();
      });
    }
  });
  // A part holding the target a draft is on stays as it is until the reader
  // updates it, so a swap never takes the draft away.
  // So does one whose target is open in a view in mark mode, which shows the
  // target as it was.
  page.holdSwap(nodes => Boolean(marking?.draft || marking?.view) && nodes.some(node => node.contains(marking!.holder)));

  scan();
  return {
    place,
    number,
    swapped() {
      scan();
      if (marking && !marking.holder.isConnected) moved();
    },
    writing() {
      const draft = marking?.draft;
      if (!draft) return null;
      return {
        section: draft.box.dataset.section || "", text: draft.composer.field.value,
        images: draft.composer.images.kept().filter(image => image.name !== draft.crop), held: draft.composer.images.held(),
      };
    },
    // The crop is told from the other images once draft.making settles,
    // so writing() leaves it out. A crop not yet waited for counts as a
    // wait, so the keeper asks every composer again after it; so does one
    // made again meanwhile.
    async settled() {
      const draft = marking?.draft;
      if (!draft) return false;
      const making = draft.making;
      const fresh = !made.has(making);
      await making;
      made.add(making);
      const waited = await draft.composer.images.settled();
      return waited || fresh || draft.making !== making;
    },
  };
}
