// Bundled with Preact into src/lotuspod/_theme/js/islands.js (web/build.ts),
// after comment-markdown.js so comments start before later sources, and never
// on a pod that goes to the index (js/open-in-tabs.js).

import { page, type Page } from "./bridge";
import { comments } from "./comments";
import { reviewSheet } from "./review-sheet";

type Island = (page: Page) => void;

const islands: Island[] = [reviewSheet, comments];

for (const mount of islands) {
  mount(page);
}
