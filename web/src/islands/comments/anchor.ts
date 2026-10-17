import { page } from "../bridge";
import type { CommentRow } from "../bridge";

export type Anchor =
  | { kind: "page" }
  | { kind: "section"; section: string }
  | { kind: "passage"; quote: NonNullable<CommentRow["quote"]> }
  | { kind: "decision"; question: string | number };

// The first comment is the stored address of a thread. Keep interpretation
// here so another kind must be handled by every presentation of an anchor.
export function anchorOf(root: CommentRow): Anchor {
  if (root.quote) return { kind: "passage", quote: root.quote };
  if (root.question !== undefined && root.question !== null) {
    return { kind: "decision", question: root.question };
  }
  if (!root.section || root.section === page.wholePage || root.section === "page") return { kind: "page" };
  return { kind: "section", section: root.section };
}
