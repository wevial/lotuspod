import type { Page } from "../bridge";
import { drafts, pageBox } from "./drafts";
import { questions } from "./questions";

// The comments start as the island mounts, on a page with comment boxes:
// the boxes are read, the whole page's added, and the drafts start the
// store. A page with decision or checklist forms and no comment boxes gets
// the panel for its questions alone.
export function comments(page: Page): void {
  const boxes = page.all("details.artifact-comment");
  if (boxes.length) drafts(page, pageBox(page, boxes));
  else if (page.all("form.artifact-decision").length) questions(page);
}
