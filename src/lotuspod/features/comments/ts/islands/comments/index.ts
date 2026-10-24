import type { Page } from "../bridge";
import { drafts, pageBox } from "./drafts";

// The comments start as the island mounts, on a page with comment boxes:
// the boxes are read, the whole page's added, and the drafts start the
// store.
export function comments(page: Page): void {
  const boxes = page.all("details.artifact-comment");
  if (boxes.length) drafts(page, pageBox(page, boxes));
}
