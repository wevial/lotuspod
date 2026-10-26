import { page } from "../bridge";
import type { CommentRow, Spot, SpotStanding, Widget } from "../bridge";
import { drawingOf, nodesOf } from "./spot-shapes";

export type Anchor =
  | { kind: "page" }
  | { kind: "section"; section: string }
  | { kind: "passage"; quote: NonNullable<CommentRow["quote"]> }
  | { kind: "decision"; question: string | number }
  | ({ kind: "block" } & Widget)
  | ({ kind: "spot" } & Spot);

// The first comment is the stored address of a thread. Keep interpretation
// here so another kind must be handled by every presentation of an anchor.
export function anchorOf(root: CommentRow): Anchor {
  if (root.quote) return { kind: "passage", quote: root.quote };
  if (root.question !== undefined && root.question !== null) {
    return { kind: "decision", question: root.question };
  }
  if (root.widget) {
    return { kind: "block", id: String(root.widget.id), hash: String(root.widget.hash), state: String(root.widget.state || "") };
  }
  if (root.spot) {
    const spot = root.spot;
    return { kind: "spot", id: String(spot.id), hash: String(spot.hash), shape: spot.shape,
      nodes: Array.isArray(spot.nodes) ? spot.nodes : [],
      ...(typeof spot.title === "string" ? { title: spot.title } : {}) };
  }
  if (!root.section || root.section === page.wholePage || root.section === "page") return { kind: "page" };
  return { kind: "section", section: root.section };
}

// The page's frame of the live block id, else null.
export function frameOf(id: string): HTMLIFrameElement | null {
  return (page.all("iframe.artifact-widget") as HTMLIFrameElement[]).find(frame => frame.dataset.widget === id) || null;
}

// The 12 hex digits of a frame's widget file (NAME.w-HASH12.html), also
// while the block is paused; "" for none.
export function hashOf(frame: HTMLIFrameElement): string {
  const source = frame.dataset.pausedSource || frame.getAttribute("src") || "";
  return /\.w-([0-9a-f]{12})\.html$/.exec(source)?.[1] || "";
}

// What the page shows of a block a thread is on: the same widget file, a
// changed one under the same id, or no block with its id.
export function blockStanding(block: Widget): "current" | "changed" | "gone" {
  const frame = frameOf(block.id);
  return !frame ? "gone" : hashOf(frame) === block.hash ? "current" : "changed";
}

// The block's title as the page names it, else its id.
export function blockTitle(block: Widget): string {
  return frameOf(block.id)?.getAttribute("title") || block.id;
}

// The page's diagrams (their pres) and images a spot may be on.
export function spotTargets(): HTMLElement[] {
  return page.all("pre.mermaid[data-spot], figure.artifact-figure img[data-spot]");
}

// The page's diagram or image whose data-spot is id, else null.
export function targetOf(id: string): HTMLElement | null {
  return spotTargets().find(node => node.dataset.spot === id) || null;
}

// What the page shows of a spot's target: the same one, a changed one with
// every node the mark covers drawn (or a mark on none), or none with its id
// or one of those nodes. A diagram not drawn yet has its nodes.
export function spotStanding(spot: Spot): SpotStanding {
  const target = targetOf(spot.id);
  // Nodes are a diagram's: a target of that id that is now an image has none.
  if (!target || (spot.nodes.length && target.tagName !== "PRE")) return "gone";
  const svg = drawingOf(target);
  if (svg && spot.nodes.length) {
    const drawn = nodesOf(svg);
    if (spot.nodes.some(node => !drawn.has(node.id))) return "gone";
  }
  return target.dataset.spotHash === spot.hash ? "current" : "changed";
}

// Whether a spot is on one of the page's images rather than a diagram.
export function onImage(spot: Spot): boolean {
  return targetOf(spot.id)?.tagName === "IMG";
}

// The titles of targets the page has shown, kept for a thread whose target a
// swap took away, and in localStorage per page for one a reload finds gone.
const TITLES = "lotuspod-spot-titles:" + location.pathname;
let titles: Map<string, string> | null = null;

function remembered(): Map<string, string> {
  if (titles) return titles;
  titles = new Map();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(TITLES) || "{}");
    if (stored && typeof stored === "object") {
      Object.entries(stored).forEach(([id, title]) => { if (typeof title === "string") titles!.set(id, title); });
    }
  } catch { /* Unremembered. */ }
  return titles;
}

function remember(id: string, title: string) {
  const known = remembered();
  if (known.get(id) === title) return;
  known.set(id, title);
  try { localStorage.setItem(TITLES, JSON.stringify(Object.fromEntries(known))); } catch { /* Unremembered. */ }
}

// What a spot is on, in words: the labels its nodes were stored with, never
// the live drawing's, so a reload still names a node gone; else its target's
// title (an image's alt text, a diagram's section heading) as the page shows
// it, else as the thread stored it when posted, else as this browser last
// saw it, else the title of the section its thread was posted in (section,
// as stored), else its id.
export function spotTitle(spot: Spot, section?: string): string {
  const labels = spot.nodes.map(node => String(node.label || node.id)).filter(Boolean);
  if (labels.length) return labels.join(", ");
  const target = targetOf(spot.id);
  const title = target && targetTitle(target);
  if (title) {
    remember(spot.id, title);
    return title;
  }
  return spot.title || remembered().get(spot.id) || section || spot.id;
}

function targetTitle(target: HTMLElement): string {
  if (target.tagName === "IMG") return target.getAttribute("alt") || "";
  const wrapper = target.closest(".artifact-section-body");
  const heading = wrapper?.previousElementSibling;
  if (!heading || heading.tagName !== "H2") return "";
  const copy = heading.cloneNode(true) as HTMLElement;
  page.all(".artifact-section-mark, .artifact-changed-tag, .artifact-review-open", copy).forEach(mark => mark.remove());
  return (copy.textContent || "").replace(/\s+/g, " ").trim();
}
