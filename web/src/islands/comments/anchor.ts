import { page } from "../bridge";
import type { CommentRow, Widget } from "../bridge";

export type Anchor =
  | { kind: "page" }
  | { kind: "section"; section: string }
  | { kind: "passage"; quote: NonNullable<CommentRow["quote"]> }
  | { kind: "decision"; question: string | number }
  | ({ kind: "block" } & Widget);

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

// The label a frame's block shows in its chrome now, as its Comment reads
// it (web/src/widgets.ts); "" for none.
export function stateOf(frame: HTMLIFrameElement): string {
  return frame.closest("figure")?.querySelector(".artifact-live-chrome > .artifact-live-state")?.textContent ?? "";
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
